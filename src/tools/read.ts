/**
 * Reading one card in full.
 *
 * Planka spreads a card over three places: `GET /cards/{id}` for the card and
 * its task lists, `GET /cards/{id}/comments` for the discussion, and the board
 * for the names behind the label and member ids. The `detail` argument decides
 * how many of those are worth fetching.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { CHARACTER_LIMIT, MAX_COMMENTS } from "../constants.js";
import { cardLocatorShape, responseFormatField } from "../schemas/common.js";
import { locateCard } from "../services/card.js";
import { apiRequest } from "../services/client.js";
import { excerpt, formatDate, line, lines, respond, toolFailure } from "../services/format.js";
import { projectCardDetail, projectComments } from "../services/project.js";
import { pageOfText, type TextPage } from "../services/text.js";
import type {
  CommentSummary,
  ItemResponse,
  ItemsResponse,
  PlankaCard,
  PlankaComment,
  PlankaIncluded,
} from "../types.js";

/**
 * Room left for the description once everything else is rendered. The rest of
 * a long description is offered as further pages rather than cut off, and the
 * floor keeps a page useful even under a long comment thread.
 */
const DESCRIPTION_MARGIN = 1_000;
const MIN_DESCRIPTION_PAGE = 4_000;

const getCardShape = {
  ...cardLocatorShape,
  detail: z
    .enum(["summary", "full"])
    .default("full")
    .describe(
      "`full` (default) adds the description, every task and the recent comments. " +
        "`summary` keeps one screen: title, list, labels, assignees, due date, task counts.",
    ),
  description_offset: z
    .number()
    .int()
    .min(0)
    .default(0)
    .describe(
      "Where to start reading a long description, in characters. A description too long for " +
        "one reply ends with the offset of the next page; pass it here to read on. Later pages " +
        "carry the description only.",
    ),
  response_format: responseFormatField,
};
type GetCardArgs = z.infer<z.ZodObject<typeof getCardShape>>;

export function registerReadTools(server: McpServer): void {
  server.registerTool(
    "planka_get_card",
    {
      title: "Read a Planka card",
      description: `Read one card: description, labels, assignees, due date, tasks and comments.

Use \`detail="summary"\` when you only need to know the state of the card, and \`full\`
when you are about to act on its contents. Labels and members come back as names, not ids.

A description too long for one reply is never cut off: the reply ends with the
\`description_offset\` of the next page, and calling again with it reads on.

Returns: the card's fields, its tasks grouped by task list with their checked state, and
the ${MAX_COMMENTS} most recent comments (full detail only).

Examples:
  - Use when: "what's left on Fix the login redirect?" -> card="Fix the login redirect", board="Roadmap"
  - Use when: checking a write landed -> detail="summary"
  - Use when: the reply said "Pass description_offset=24000 to read on" -> description_offset=24000
  - Don't use when: you want several cards at once (use planka_search_cards)`,
      inputSchema: getCardShape,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async (args: GetCardArgs) => {
      try {
        const located = await locateCard(args.card, args.board, args.project);
        const full = args.detail === "full";
        const continuation = args.description_offset > 0;

        // The card route does not carry comments; only pay for them on demand,
        // and fetch them alongside the card rather than after it.
        const [response, rawComments] = await Promise.all([
          apiRequest<ItemResponse<PlankaCard, PlankaIncluded>>(`/cards/${located.card.id}`),
          full && !continuation
            ? apiRequest<ItemsResponse<PlankaComment, PlankaIncluded>>(`/cards/${located.card.id}/comments`)
            : undefined,
        ]);
        const comments: CommentSummary[] | undefined = rawComments
          ? projectComments((rawComments.items ?? []).slice(0, MAX_COMMENTS), rawComments.included)
          : undefined;

        const detail = projectCardDetail(response.item, response.included, located.snapshot, comments);
        const description = detail.description ?? "";
        const location = `${detail.boardName} › ${detail.listName} · card id \`${detail.id}\``;

        if (continuation) {
          const page = fitDescription(
            description,
            args.description_offset,
            detail.name.length + location.length,
            args.response_format === "json",
          );
          return respond(
            args.response_format,
            lines(`# ${detail.name}`, location, "", "## Description (continued)", page.text, "", pageFooter(page)),
            { id: detail.id, name: detail.name, description: page.text, ...pageFields(page) },
          );
        }

        const header = lines(
          `# ${detail.name}`,
          location,
          "",
          line("Labels", detail.labels.length > 0 ? detail.labels.join(", ") : undefined),
          line("Assignees", detail.assignees.length > 0 ? detail.assignees.join(", ") : undefined),
          line(
            "Due",
            detail.dueDate
              ? `${formatDate(detail.dueDate)}${detail.isDueCompleted ? " (marked done)" : ""}`
              : undefined,
          ),
          line("Tasks", detail.taskProgress),
          line("Comments", detail.commentsTotal > 0 ? detail.commentsTotal : undefined),
          line("Archived from", detail.previousListName),
        );

        if (!full) {
          const summaryPayload = {
            ...detail,
            // Keep the counts, drop the bodies: that is what summary buys.
            description: excerpt(detail.description, 200),
            ...(description ? { description_length: description.length } : {}),
            tasks: undefined,
            comments: undefined,
          };
          return respond(
            args.response_format,
            lines(
              header,
              "",
              line(
                description.length > 200 ? `Description (${description.length} characters)` : "Description",
                excerpt(detail.description, 200),
              ) ?? "",
            ),
            summaryPayload,
          );
        }

        const tasksBlock =
          detail.tasks && detail.tasks.length > 0
            ? lines(
                "## Tasks",
                detail.tasks
                  .map(
                    (task) =>
                      `- [${task.isCompleted ? "x" : " "}] ${task.name} ` +
                      `_(${task.taskListName})_ — id \`${task.id}\``,
                  )
                  .join("\n"),
              )
            : undefined;

        const commentsBlock =
          comments && comments.length > 0
            ? lines(
                "## Comments",
                comments
                  .map(
                    (comment) =>
                      `- **${comment.author}**${comment.createdAt ? ` · ${formatDate(comment.createdAt)}` : ""}: ` +
                      `${comment.text.replace(/\s+/g, " ").trim()} — id \`${comment.id}\``,
                  )
                  .join("\n"),
              )
            : undefined;

        const rest = lines(tasksBlock, tasksBlock ? "" : undefined, commentsBlock);
        const page = description
          ? fitDescription(
              description,
              0,
              args.response_format === "json"
                ? JSON.stringify({ ...detail, description: "" }, null, 2).length
                : header.length + rest.length,
              args.response_format === "json",
            )
          : undefined;

        const markdown = lines(
          header,
          "",
          page ? lines("## Description", page.text, pageFooter(page)) : undefined,
          page ? "" : undefined,
          rest,
        );

        return respond(args.response_format, markdown, {
          ...detail,
          ...(page ? { description: page.text, ...pageFields(page) } : {}),
        });
      } catch (error) {
        return toolFailure(error);
      }
    },
  );
}

/**
 * The page of a description starting at `offset`, given how much room the rest
 * of the reply takes. In JSON the text is escaped, so a page that would
 * overflow once escaped is shrunk in proportion.
 */
function fitDescription(description: string, offset: number, otherLength: number, escaped: boolean): TextPage {
  const budget = Math.max(MIN_DESCRIPTION_PAGE, CHARACTER_LIMIT - otherLength - DESCRIPTION_MARGIN);
  const page = pageOfText(description, offset, budget);
  if (!escaped) return page;
  const escapedLength = JSON.stringify(page.text).length;
  return escapedLength <= budget
    ? page
    : pageOfText(description, offset, Math.max(1, Math.floor((budget * page.text.length) / escapedLength)));
}

/** Whether a description had to be split, and where the reader is in it. */
function isPaged(page: TextPage): boolean {
  return page.start > 0 || page.end < page.total;
}

function pageFooter(page: TextPage): string | undefined {
  if (!isPaged(page)) return undefined;
  const range = `characters ${page.start + 1}–${page.end} of ${page.total}`;
  return page.end < page.total
    ? `_Description: ${range}. Pass description_offset=${page.end} to read on._`
    : `_Description: ${range} — end of the description._`;
}

function pageFields(page: TextPage): Record<string, number> {
  if (!isPaged(page)) return {};
  return {
    description_length: page.total,
    description_offset: page.start,
    ...(page.end < page.total ? { description_next_offset: page.end } : {}),
  };
}
