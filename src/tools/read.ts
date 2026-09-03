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
import { MAX_COMMENTS } from "../constants.js";
import { boardField, cardField, projectField, responseFormatField } from "../schemas/common.js";
import { locateCard } from "../services/card.js";
import { apiRequest } from "../services/client.js";
import { excerpt, formatDate, line, lines, respond, toolFailure } from "../services/format.js";
import { projectCardDetail, projectComments } from "../services/project.js";
import type {
  CommentSummary,
  ItemResponse,
  ItemsResponse,
  PlankaCard,
  PlankaComment,
  PlankaIncluded,
} from "../types.js";

const getCardShape = {
  card: cardField,
  board: boardField.optional().describe(
    "Board the card is on. Recommended: without it the accessible boards are scanned and " +
      "the card title must match exactly.",
  ),
  project: projectField,
  detail: z
    .enum(["summary", "full"])
    .default("full")
    .describe(
      "`full` (default) adds the description, every task and the recent comments. " +
        "`summary` keeps one screen: title, list, labels, assignees, due date, task counts.",
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

Returns: the card's fields, its tasks grouped by task list with their checked state, and
the ${MAX_COMMENTS} most recent comments (full detail only).

Examples:
  - Use when: "what's left on Fix the login redirect?" -> card="Fix the login redirect", board="Roadmap"
  - Use when: checking a write landed -> detail="summary"
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

        const response = await apiRequest<ItemResponse<PlankaCard, PlankaIncluded>>(
          `/cards/${located.card.id}`,
        );

        // The card route does not carry comments; only pay for them on demand.
        let comments: CommentSummary[] | undefined;
        if (full) {
          const raw = await apiRequest<ItemsResponse<PlankaComment, PlankaIncluded>>(
            `/cards/${located.card.id}/comments`,
          );
          comments = projectComments((raw.items ?? []).slice(0, MAX_COMMENTS), raw.included);
        }

        const detail = projectCardDetail(response.item, response.included, located.snapshot, comments);

        const header = lines(
          `# ${detail.name}`,
          `${detail.boardName} › ${detail.listName} · card id \`${detail.id}\``,
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
            tasks: undefined,
            comments: undefined,
          };
          return respond(
            args.response_format,
            lines(header, "", line("Description", excerpt(detail.description, 200)) ?? ""),
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
                      `${comment.text.replace(/\s+/g, " ").trim()}`,
                  )
                  .join("\n"),
              )
            : undefined;

        const markdown = lines(
          header,
          "",
          detail.description ? lines("## Description", detail.description) : undefined,
          detail.description ? "" : undefined,
          tasksBlock,
          tasksBlock ? "" : undefined,
          commentsBlock,
        );

        return respond(args.response_format, markdown, detail);
      } catch (error) {
        return toolFailure(error);
      }
    },
  );
}
