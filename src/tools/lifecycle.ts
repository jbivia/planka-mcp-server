/**
 * Card lifecycle: create, update, move, archive, delete.
 *
 * `planka_move_card` is the one that carries the design. Planka's PATCH wants a
 * raw numeric `position` that only means anything relative to the cards already
 * in the target list, and it is required whenever the list changes. An agent
 * cannot invent that number, so this module accepts an intent — top, bottom,
 * before that card, at rank 2 — reads the real neighbours from the cached board
 * and does the arithmetic.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { PlankaError } from "../errors.js";
import {
  boardField,
  cardField,
  dueDateField,
  positionField,
  projectField,
  responseFormatField,
} from "../schemas/common.js";
import { getBoardSnapshot, invalidateBoard } from "../services/board-cache.js";
import { locateCard } from "../services/card.js";
import { apiRequest } from "../services/client.js";
import { lines, respond, toolFailure, toolSuccess } from "../services/format.js";
import { resolvePosition, sortByPosition, type PositionRequest } from "../services/position.js";
import { projectCardSummary } from "../services/project.js";
import { resolveBoard, resolveCard, resolveList } from "../services/resolve.js";
import type { BoardSnapshot, ItemResponse, PlankaCard } from "../types.js";
import { renderCardLine } from "./discovery.js";

/** The shape `positionField` validates into. */
type PositionInput = "top" | "bottom" | { before: string } | { after: string } | { index: number };

/**
 * Turn a placement intent into a resolved request.
 *
 * `before`/`after` name a neighbour card the same way every other argument
 * names things — so the neighbour is resolved against the board, and a typo in
 * it fails with the candidate list rather than silently appending.
 */
function toPositionRequest(input: PositionInput, snapshot: BoardSnapshot): PositionRequest {
  if (input === "top") return { kind: "top" };
  if (input === "bottom") return { kind: "bottom" };
  if ("index" in input) return { kind: "index", index: input.index };
  if ("before" in input) return { kind: "before", siblingId: resolveCard(snapshot, input.before).id };
  return { kind: "after", siblingId: resolveCard(snapshot, input.after).id };
}

/** The cards currently in a list, in board order. */
function cardsInList(snapshot: BoardSnapshot, listId: string): PlankaCard[] {
  return sortByPosition(snapshot.rawCards.filter((card) => card.listId === listId));
}

/** Re-read the card after a write, so the reply describes what Planka stored. */
async function summarize(cardId: string, boardId: string): Promise<string> {
  const snapshot = await getBoardSnapshot(boardId, true);
  const card = snapshot.cards.find((candidate) => candidate.id === cardId);
  return card ? renderCardLine(card) : `- card id \`${cardId}\``;
}

/* -------------------------------------------------------------------------- */
/* Shapes                                                                      */
/* -------------------------------------------------------------------------- */

const createCardShape = {
  board: boardField,
  project: projectField,
  list: z.string().min(1).describe('List to create the card in, by name or id. Example: "Backlog".'),
  name: z.string().min(1).describe('Card title. Example: "Fix the login redirect".'),
  description: z.string().optional().describe("Card body, in Markdown."),
  due_date: dueDateField.optional(),
  position: positionField,
  response_format: responseFormatField,
};
type CreateCardArgs = z.infer<z.ZodObject<typeof createCardShape>>;

const updateCardShape = {
  card: cardField,
  board: boardField.optional().describe("Board the card is on. Recommended, and required for duplicate titles."),
  project: projectField,
  name: z.string().min(1).optional().describe("New title. Omit to leave it unchanged."),
  description: z.string().optional().describe("New body, in Markdown. Pass an empty string to clear it."),
  due_date: dueDateField.optional().describe(
    'New due date, ISO 8601 UTC. Example: "2026-01-31T17:00:00.000Z". Pass null to clear it.',
  ),
  clear_due_date: z.boolean().optional().describe("Set true to remove the due date entirely."),
  due_completed: z.boolean().optional().describe("Mark the due date as met (true) or not (false)."),
  response_format: responseFormatField,
};
type UpdateCardArgs = z.infer<z.ZodObject<typeof updateCardShape>>;

const moveCardShape = {
  card: cardField,
  list: z.string().min(1).describe('Destination list, by name or id. Example: "En cours".'),
  board: boardField.optional().describe("Board the card is on. Recommended, and required for duplicate titles."),
  project: projectField,
  position: positionField,
  response_format: responseFormatField,
};
type MoveCardArgs = z.infer<z.ZodObject<typeof moveCardShape>>;

const archiveCardShape = {
  card: cardField,
  board: boardField.optional().describe("Board the card is on. Recommended, and required for duplicate titles."),
  project: projectField,
};
type ArchiveCardArgs = z.infer<z.ZodObject<typeof archiveCardShape>>;

const deleteCardShape = {
  card: cardField,
  confirm_name: z
    .string()
    .min(1)
    .describe(
      "The card's exact current title, repeated back as confirmation. The card is read first " +
        'and the deletion is refused if this does not match. Example: "Fix the login redirect".',
    ),
  board: boardField.optional().describe("Board the card is on. Recommended, and required for duplicate titles."),
  project: projectField,
};
type DeleteCardArgs = z.infer<z.ZodObject<typeof deleteCardShape>>;

/* -------------------------------------------------------------------------- */
/* Registration                                                                */
/* -------------------------------------------------------------------------- */

export function registerLifecycleTools(server: McpServer): void {
  server.registerTool(
    "planka_create_card",
    {
      title: "Create a Planka card",
      description: `Create a card in a list.

Only a board, a list and a title are required. The card type is taken from the board's
own default, and the card is appended to the bottom of the list unless \`position\` says
otherwise.

Returns: the created card as one summary line, including its new id.

Examples:
  - Use when: "add 'Rotate the TLS cert' to Backlog on Infra" -> board="Infra", list="Backlog", name="Rotate the TLS cert"
  - Use when: filing at the top of a triage column -> position="top"
  - Don't use when: the card already exists (use planka_update_card)`,
      inputSchema: createCardShape,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        // Calling twice creates two cards; nothing dedupes on title.
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async (args: CreateCardArgs) => {
      try {
        const board = await resolveBoard(args.board, args.project);
        const snapshot = await getBoardSnapshot(board.id);
        const list = resolveList(snapshot, args.list);

        const { position } = resolvePosition(
          cardsInList(snapshot, list.id),
          toPositionRequest(args.position as PositionInput, snapshot),
        );

        const response = await apiRequest<ItemResponse<PlankaCard>>(`/lists/${list.id}/cards`, {
          method: "POST",
          body: {
            type: snapshot.defaultCardType,
            name: args.name,
            position,
            ...(args.description !== undefined ? { description: args.description } : {}),
            ...(args.due_date !== undefined ? { dueDate: args.due_date } : {}),
          },
        });
        invalidateBoard(board.id);

        const created = response.item;
        const summary = projectCardSummary(created, {
          boardName: snapshot.name,
          listName: list.name,
          labels: [],
          assignees: [],
        });

        return respond(
          args.response_format,
          lines(`Created in ${snapshot.name} › ${list.name}:`, renderCardLine(summary)),
          summary,
        );
      } catch (error) {
        return toolFailure(error);
      }
    },
  );

  server.registerTool(
    "planka_update_card",
    {
      title: "Update a Planka card",
      description: `Change a card's title, description or due date.

Only the fields you pass are touched. This tool never moves a card between lists — that is
planka_move_card — and never changes labels, assignees or tasks.

To clear the due date pass \`clear_due_date: true\`; to clear the description pass an empty
string.

Returns: the updated card as one summary line.

Examples:
  - Use when: "rename it to 'Fix the SSO redirect'" -> card="Fix the login redirect", name="Fix the SSO redirect"
  - Use when: "it's due end of month" -> due_date="2026-01-31T17:00:00.000Z"
  - Don't use when: the card should change column (use planka_move_card)`,
      inputSchema: updateCardShape,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        // Sending the same field values again lands the card in the same state.
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async (args: UpdateCardArgs) => {
      try {
        const located = await locateCard(args.card, args.board, args.project);

        const body: Record<string, unknown> = {};
        if (args.name !== undefined) body["name"] = args.name;
        if (args.description !== undefined) body["description"] = args.description === "" ? null : args.description;
        if (args.clear_due_date) body["dueDate"] = null;
        else if (args.due_date !== undefined) body["dueDate"] = args.due_date;
        if (args.due_completed !== undefined) body["isDueCompleted"] = args.due_completed;

        if (Object.keys(body).length === 0) {
          throw new PlankaError(
            "Nothing to update.",
            undefined,
            "Pass at least one of name, description, due_date, clear_due_date or due_completed.",
          );
        }

        await apiRequest<ItemResponse<PlankaCard>>(`/cards/${located.card.id}`, {
          method: "PATCH",
          body,
        });
        invalidateBoard(located.snapshot.id);

        return respond(
          args.response_format,
          lines(
            `Updated ${Object.keys(body).join(", ")}:`,
            await summarize(located.card.id, located.snapshot.id),
          ),
          { id: located.card.id, updated: Object.keys(body) },
        );
      } catch (error) {
        return toolFailure(error);
      }
    },
  );

  server.registerTool(
    "planka_move_card",
    {
      title: "Move a Planka card to another list",
      description: `Move a card to another list, at a chosen position.

This is the main lifecycle operation: advancing a ticket through the board. Give the card
and the destination list by name; the rank is computed against the cards already in that
list, so you never supply a raw position number.

\`position\` accepts:
  - "bottom" (default) — after the last card
  - "top" — before the first card
  - {"before": "<card>"} / {"after": "<card>"} — next to a named neighbour
  - {"index": 2} — at that 0-based rank

Both lists must be on the same board. Moving a card to the archive is planka_archive_card.

Returns: the origin list, the destination list, the card's final rank and how many cards
the destination now holds — enough to confirm the move without re-reading the board.

Examples:
  - Use when: "move Fix the login redirect to En cours" -> card="Fix the login redirect", list="En cours"
  - Use when: "put it at the top of the review column" -> list="In review", position="top"
  - Use when: "file it just under the auth ticket" -> list="Backlog", position={"after": "Rework auth"}`,
      inputSchema: moveCardShape,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        // The computed position depends on the list's current contents, so a
        // replay can land the card at a different rank.
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async (args: MoveCardArgs) => {
      try {
        const located = await locateCard(args.card, args.board, args.project);
        const snapshot = located.snapshot;
        const target = resolveList(snapshot, args.list);
        const origin = located.card.listName;

        const siblings = cardsInList(snapshot, target.id);
        const { position, index } = resolvePosition(
          siblings,
          toPositionRequest(args.position as PositionInput, snapshot),
          located.card.id,
        );

        // `position` is mandatory on a list change, not optional: Planka rejects
        // the PATCH without it. It is always sent, even for a same-list reorder.
        await apiRequest<ItemResponse<PlankaCard>>(`/cards/${located.card.id}`, {
          method: "PATCH",
          body: { listId: target.id, position },
        });
        invalidateBoard(snapshot.id);

        const movedWithinList = located.card.listId === target.id;
        const finalCount = movedWithinList ? siblings.length : siblings.length + 1;

        return respond(
          args.response_format,
          lines(
            movedWithinList
              ? `Reordered within **${target.name}** on ${snapshot.name}.`
              : `Moved **${located.card.name}** from **${origin}** to **${target.name}** on ${snapshot.name}.`,
            `Now at rank ${index + 1} of ${finalCount}.`,
            "",
            await summarize(located.card.id, snapshot.id),
          ),
          {
            id: located.card.id,
            from_list: origin,
            to_list: target.name,
            rank: index + 1,
            list_size: finalCount,
          },
        );
      } catch (error) {
        return toolFailure(error);
      }
    },
  );

  server.registerTool(
    "planka_archive_card",
    {
      title: "Archive a Planka card",
      description: `Move a card to its board's archive.

Planka has no archive endpoint: archiving is a move into the board's archive list, and the
card remembers where it came from, so this is reversible from the Planka UI. The card stops
appearing in planka_search_cards results.

Returns: the list the card left and a note that it is archived.

Examples:
  - Use when: "archive Fix the login redirect" -> card="Fix the login redirect", board="Roadmap"
  - Don't use when: the card should be gone for good (use planka_delete_card)`,
      inputSchema: archiveCardShape,
      annotations: {
        readOnlyHint: false,
        // Reversible: Planka keeps prevListId so the card can be restored.
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async (args: ArchiveCardArgs) => {
      try {
        const located = await locateCard(args.card, args.board, args.project);
        const snapshot = located.snapshot;

        const archive = snapshot.lists.find((list) => list.type === "archive");
        if (!archive) {
          throw new PlankaError(
            `Board "${snapshot.name}" has no archive list.`,
            undefined,
            `Archive the card from the Planka UI, or use planka_move_card to file it in a ` +
              `regular list instead.`,
          );
        }

        const siblings = cardsInList(snapshot, archive.id);
        const { position } = resolvePosition(siblings, { kind: "bottom" }, located.card.id);

        await apiRequest<ItemResponse<PlankaCard>>(`/cards/${located.card.id}`, {
          method: "PATCH",
          body: { listId: archive.id, position },
        });
        invalidateBoard(snapshot.id);

        return toolSuccess(
          `Archived **${located.card.name}** (was in ${located.card.listName} on ${snapshot.name}). ` +
            `It can be restored from the Planka UI.`,
          { id: located.card.id, archived_from: located.card.listName },
        );
      } catch (error) {
        return toolFailure(error);
      }
    },
  );

  server.registerTool(
    "planka_delete_card",
    {
      title: "Delete a Planka card permanently",
      description: `Delete a card and everything on it — tasks, comments and attachments.

This cannot be undone. Prefer planka_archive_card, which is reversible.

The card is read first and \`confirm_name\` must match its current title exactly, so a
stale or mistaken id fails before anything is destroyed.

Returns: confirmation naming the deleted card.

Examples:
  - Use when: the user explicitly asked to delete, and you have read the card's title back
  - Don't use when: the card is merely finished (use planka_archive_card)`,
      inputSchema: deleteCardShape,
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        // A second call 404s rather than being a no-op, so this is not idempotent.
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async (args: DeleteCardArgs) => {
      try {
        const located = await locateCard(args.card, args.board, args.project);

        if (located.card.name.trim() !== args.confirm_name.trim()) {
          throw new PlankaError(
            `confirm_name does not match: the card is titled "${located.card.name}", ` +
              `not "${args.confirm_name}".`,
            undefined,
            `Deletion is permanent, so it only proceeds on an exact title match. Read the card ` +
              `with planka_get_card and pass its title verbatim.`,
          );
        }

        await apiRequest<ItemResponse<PlankaCard>>(`/cards/${located.card.id}`, { method: "DELETE" });
        invalidateBoard(located.snapshot.id);

        return toolSuccess(
          `Deleted **${located.card.name}** from ${located.snapshot.name} › ${located.card.listName}. ` +
            `This is permanent.`,
          { id: located.card.id, deleted: true },
        );
      } catch (error) {
        return toolFailure(error);
      }
    },
  );
}
