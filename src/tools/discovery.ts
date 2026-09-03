/**
 * Discovery tools: what exists, and which cards match.
 *
 * All three read from the board snapshot cache rather than the API directly,
 * so a session that describes a board and then searches it costs one upstream
 * request, not two.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { SEARCH_BOARD_LIMIT } from "../constants.js";
import { PlankaError } from "../errors.js";
import { boardField, paginationShape, projectField, responseFormatField } from "../schemas/common.js";
import { getBoardSnapshot, getProjects } from "../services/board-cache.js";
import { formatDate, lines, paginate, paginationFooter, respond, toolFailure } from "../services/format.js";
import { resolveBoard, resolveLabel, resolveList, resolveMember, resolveProject } from "../services/resolve.js";
import type { BoardSnapshot, CardSummary } from "../types.js";

/** One card as a single scannable line. */
export function renderCardLine(card: CardSummary): string {
  const parts = [`**${card.name}**`, `(${card.listName})`];
  if (card.labels.length > 0) parts.push(`[${card.labels.join(", ")}]`);
  if (card.assignees.length > 0) parts.push(`@${card.assignees.join(" @")}`);
  if (card.dueDate) parts.push(`due ${formatDate(card.dueDate)}${card.isDueCompleted ? " ✓" : ""}`);
  if (card.taskProgress) parts.push(`tasks ${card.taskProgress}`);
  if (card.commentsTotal > 0) parts.push(`${card.commentsTotal} comment${card.commentsTotal > 1 ? "s" : ""}`);
  return `- ${parts.join(" · ")} — id \`${card.id}\``;
}

/* -------------------------------------------------------------------------- */
/* planka_list_projects                                                        */
/* -------------------------------------------------------------------------- */

const listProjectsShape = {
  response_format: responseFormatField,
};
type ListProjectsArgs = z.infer<z.ZodObject<typeof listProjectsShape>>;

/* -------------------------------------------------------------------------- */
/* planka_describe_board                                                       */
/* -------------------------------------------------------------------------- */

const describeBoardShape = {
  board: boardField,
  project: projectField,
  response_format: responseFormatField,
};
type DescribeBoardArgs = z.infer<z.ZodObject<typeof describeBoardShape>>;

/* -------------------------------------------------------------------------- */
/* planka_search_cards                                                         */
/* -------------------------------------------------------------------------- */

const searchCardsShape = {
  board: boardField.optional().describe(
    "Board to search. Omit to search every board of `project`, or every accessible board.",
  ),
  project: projectField,
  list: z.string().optional().describe('Only cards in this list, by name or id. Example: "En cours".'),
  label: z.string().optional().describe('Only cards carrying this label, by name or id. Example: "bug".'),
  assignee: z
    .string()
    .optional()
    .describe('Only cards assigned to this member (name, username or id). Example: "jdoe".'),
  text: z.string().optional().describe("Case-insensitive substring of the title or description."),
  due_before: z.string().optional().describe('Only cards due before this ISO date. Example: "2026-02-01".'),
  due_after: z.string().optional().describe('Only cards due after this ISO date. Example: "2026-01-01".'),
  overdue: z.boolean().optional().describe("Only cards whose due date has passed and is not marked done."),
  ...paginationShape,
  response_format: responseFormatField,
};
type SearchCardsArgs = z.infer<z.ZodObject<typeof searchCardsShape>>;

/** Parse a user-supplied date filter, refusing junk rather than ignoring it. */
function parseDateFilter(value: string, field: string): number {
  const parsed = Date.parse(value);
  if (Number.isNaN(parsed)) {
    throw new PlankaError(
      `${field} is not a date: "${value}".`,
      undefined,
      `Use ISO 8601, for example "2026-02-01" or "2026-02-01T09:00:00.000Z".`,
    );
  }
  return parsed;
}

/**
 * Decide which boards a search covers.
 *
 * Planka has no cross-board search route, so an unscoped search is N board
 * reads. The cap keeps that bounded and the skipped names are reported, so a
 * partial answer never passes for a complete one.
 */
async function selectBoards(
  args: SearchCardsArgs,
): Promise<{ ids: string[]; skipped: string[] }> {
  if (args.board) {
    const board = await resolveBoard(args.board, args.project);
    return { ids: [board.id], skipped: [] };
  }

  const projects = args.project ? [await resolveProject(args.project)] : await getProjects();
  const all = projects.flatMap((project) => project.boards);
  return {
    ids: all.slice(0, SEARCH_BOARD_LIMIT).map((board) => board.id),
    skipped: all.slice(SEARCH_BOARD_LIMIT).map((board) => board.name),
  };
}

function filterCards(snapshot: BoardSnapshot, args: SearchCardsArgs): CardSummary[] {
  let cards = snapshot.cards;

  // Filters are resolved against this board, so a list or label name that only
  // exists elsewhere fails here with that board's candidates listed.
  if (args.list) {
    const list = resolveList(snapshot, args.list);
    cards = cards.filter((card) => card.listId === list.id);
  }
  if (args.label) {
    const label = resolveLabel(snapshot, args.label);
    cards = cards.filter((card) => card.labels.includes(label.name));
  }
  if (args.assignee) {
    const member = resolveMember(snapshot, args.assignee);
    cards = cards.filter((card) => card.assignees.includes(member.name));
  }
  if (args.text) {
    const needle = args.text.trim().toLowerCase();
    // Descriptions live on the raw cards, not the projections, so they are
    // looked up here rather than carried on every summary line.
    const descriptions = new Map(
      snapshot.rawCards.map((card) => [card.id, (card.description ?? "").toLowerCase()]),
    );
    cards = cards.filter(
      (card) =>
        card.name.toLowerCase().includes(needle) ||
        (descriptions.get(card.id) ?? "").includes(needle),
    );
  }
  if (args.due_before !== undefined) {
    const limit = parseDateFilter(args.due_before, "due_before");
    cards = cards.filter((card) => card.dueDate !== undefined && Date.parse(card.dueDate) < limit);
  }
  if (args.due_after !== undefined) {
    const limit = parseDateFilter(args.due_after, "due_after");
    cards = cards.filter((card) => card.dueDate !== undefined && Date.parse(card.dueDate) > limit);
  }
  if (args.overdue) {
    const now = Date.now();
    cards = cards.filter(
      (card) => card.dueDate !== undefined && Date.parse(card.dueDate) < now && !card.isDueCompleted,
    );
  }
  return cards;
}

export function registerDiscoveryTools(server: McpServer): void {
  server.registerTool(
    "planka_list_projects",
    {
      title: "List Planka projects and boards",
      description: `List every Planka project this account can see, with the boards inside each one.

Start here when you do not know which board to work on. The names it returns are accepted
directly by every other tool, so you never need to carry ids around.

Returns: for each project, its name, description and the ordered list of its boards.

Examples:
  - Use when: "what boards do I have?" -> no arguments
  - Don't use when: you already know the board name (call planka_describe_board directly)`,
      inputSchema: listProjectsShape,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async (args: ListProjectsArgs) => {
      try {
        const projects = await getProjects();
        if (projects.length === 0) {
          return respond(
            args.response_format,
            "No projects visible to this account. Check that the Planka user is a member of at least one project.",
            { projects: [] },
          );
        }

        const markdown = projects
          .map((project) =>
            lines(
              `## ${project.name}`,
              project.description ?? undefined,
              project.boards.length === 0
                ? "_No boards._"
                : project.boards.map((board) => `- ${board.name} — id \`${board.id}\``).join("\n"),
            ),
          )
          .join("\n\n");

        return respond(args.response_format, markdown, { projects });
      } catch (error) {
        return toolFailure(error);
      }
    },
  );

  server.registerTool(
    "planka_describe_board",
    {
      title: "Describe a Planka board",
      description: `Describe one board: its lists in order, its labels, and its members.

This is the vocabulary of a board — the list, label and member names that the lifecycle
tools accept. Call it once before a series of edits; the result is cached briefly.

Returns: lists (name, type, card count) in board order, labels (name and colour),
and members (name, username, role).

Examples:
  - Use when: "what columns does Roadmap have?" -> board="Roadmap"
  - Use when: before moving a card, to learn the exact list name
  - Don't use when: you want the cards themselves (use planka_search_cards)`,
      inputSchema: describeBoardShape,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async (args: DescribeBoardArgs) => {
      try {
        const board = await resolveBoard(args.board, args.project);
        const snapshot = await getBoardSnapshot(board.id);

        const visibleLists = snapshot.lists.filter(
          (list) => list.type === "active" || list.type === "closed",
        );
        const markdown = lines(
          `# ${snapshot.name}`,
          `Project: ${board.projectName} · board id \`${snapshot.id}\``,
          "",
          "## Lists",
          visibleLists.length === 0
            ? "_No lists._"
            : visibleLists
                .map(
                  (list) =>
                    `${list.type === "closed" ? "- (closed) " : "- "}**${list.name}** — ` +
                    `${list.cardCount} card${list.cardCount === 1 ? "" : "s"} — id \`${list.id}\``,
                )
                .join("\n"),
          "",
          "## Labels",
          snapshot.labels.length === 0
            ? "_No labels._"
            : snapshot.labels
                .map((label) => `- ${label.name}${label.color ? ` (${label.color})` : ""}`)
                .join("\n"),
          "",
          "## Members",
          snapshot.members.length === 0
            ? "_No members._"
            : snapshot.members
                .map(
                  (member) =>
                    `- ${member.name}${member.username ? ` (@${member.username})` : ""}` +
                    `${member.role ? ` — ${member.role}` : ""}`,
                )
                .join("\n"),
        );

        return respond(args.response_format, markdown, {
          id: snapshot.id,
          name: snapshot.name,
          project: board.projectName,
          lists: visibleLists,
          labels: snapshot.labels,
          members: snapshot.members,
        });
      } catch (error) {
        return toolFailure(error);
      }
    },
  );

  server.registerTool(
    "planka_search_cards",
    {
      title: "Search Planka cards",
      description: `Find cards by board, list, label, assignee, due date or title text.

Filters combine with AND. Every filter accepts names, not ids. Results are paginated and
projected down to one line per card, so a wide search stays cheap to read.

Planka has no cross-board search, so omitting \`board\` means reading boards one by one;
at most ${SEARCH_BOARD_LIMIT} are covered and any skipped board is named in the result.

Returns: total/count/offset/has_more/next_offset plus one line per card
(title, list, labels, assignees, due date, task progress, comment count, id).

Examples:
  - Use when: "what's in review on Roadmap?" -> board="Roadmap", list="In review"
  - Use when: "my overdue bugs" -> assignee="jdoe", label="bug", overdue=true
  - Don't use when: you need a card's description, tasks or comments (use planka_get_card)`,
      inputSchema: searchCardsShape,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async (args: SearchCardsArgs) => {
      try {
        const { ids, skipped } = await selectBoards(args);
        if (ids.length === 0) {
          return respond(args.response_format, "No boards to search.", { total: 0, items: [] });
        }

        const matches: CardSummary[] = [];
        for (const boardId of ids) {
          const snapshot = await getBoardSnapshot(boardId);
          matches.push(...filterCards(snapshot, args));
        }

        const page = paginate(matches, args.offset, args.limit);
        const warning =
          skipped.length > 0
            ? `_Only the first ${SEARCH_BOARD_LIMIT} boards were searched. Not searched: ` +
              `${skipped.join(", ")}. Pass \`board\` or \`project\` to scope the search._`
            : undefined;

        const markdown = lines(
          page.total === 0 ? "No card matches these filters." : page.items.map(renderCardLine).join("\n"),
          "",
          paginationFooter(page),
          warning,
        );

        return respond(args.response_format, markdown, {
          ...page,
          ...(skipped.length > 0 ? { boards_not_searched: skipped } : {}),
        });
      } catch (error) {
        return toolFailure(error);
      }
    },
  );
}
