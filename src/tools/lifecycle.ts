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
  cardLocatorShape,
  dueDateField,
  positionField,
  projectField,
  responseFormatField,
} from "../schemas/common.js";
import { forgetCard, invalidateBoard, storeCard } from "../services/board-cache.js";
import { locateCard } from "../services/card.js";
import { apiRequest } from "../services/client.js";
import { lines, respond, toolFailure, toolSuccess } from "../services/format.js";
import { resolvePosition, sortByPosition, type PositionRequest } from "../services/position.js";
import { projectCardSummary } from "../services/project.js";
import { resolveBoard, resolveList, resolveNamed, resolveOnBoard } from "../services/resolve.js";
import { appendParagraph, applyEdits, checkDescriptionLength } from "../services/text.js";
import type { BoardSnapshot, CardSummary, ItemResponse, ListSummary, PlankaCard } from "../types.js";
import { renderCardLine } from "./discovery.js";

/** The shape `positionField` validates into. */
type PositionInput = "top" | "bottom" | { before: string } | { after: string } | { index: number };

/**
 * Turn a placement intent into a resolved request.
 *
 * `before`/`after` name a neighbour card the same way every other argument
 * names things, resolved among the cards of the target list — so a typo, or a
 * card that sits in another list, fails with the candidate list rather than
 * silently appending.
 */
function toPositionRequest(
  input: PositionInput,
  snapshot: BoardSnapshot,
  list: ListSummary,
  movingId?: string,
): PositionRequest {
  if (input === "top") return { kind: "top" };
  if (input === "bottom") return { kind: "bottom" };
  if ("index" in input) return { kind: "index", index: input.index };

  const neighbours = snapshot.cards.filter((card) => card.listId === list.id && card.id !== movingId);
  const neighbour = resolveNamed(
    neighbours,
    "before" in input ? input.before : input.after,
    "Card",
    `in list "${list.name}"`,
    `\`before\` and \`after\` name a card of the target list, other than the one being placed. ` +
      `Use "top", "bottom" or {"index": n} otherwise.`,
    10,
  );
  return "before" in input
    ? { kind: "before", siblingId: neighbour.id }
    : { kind: "after", siblingId: neighbour.id };
}

/** The cards currently in a list, in board order. */
function cardsInList(snapshot: BoardSnapshot, listId: string): PlankaCard[] {
  return sortByPosition(snapshot.rawCards.filter((card) => card.listId === listId));
}

/**
 * Fold the card a write returned into the board cache, and project it as
 * Planka stored it.
 *
 * This replaces re-reading the whole board after every write — which carries
 * every card's description, and so cost as much as the board's whole text to
 * confirm a one-line change.
 */
function settle(snapshot: BoardSnapshot, stored: PlankaCard | undefined, before?: CardSummary): CardSummary | undefined {
  if (!stored) {
    invalidateBoard(snapshot.id);
    return before;
  }
  const updated = storeCard(snapshot.id, stored);
  return (
    updated?.cards.find((card) => card.id === stored.id) ??
    projectCardSummary(stored, {
      boardName: snapshot.name,
      listName: snapshot.lists.find((list) => list.id === stored.listId)?.name ?? "(unknown list)",
      labels: before?.labels ?? [],
      assignees: before?.assignees ?? [],
    })
  );
}

/** A card's description as Planka holds it right now, not as the board cache last saw it. */
async function readDescription(cardId: string): Promise<string> {
  const response = await apiRequest<ItemResponse<PlankaCard>>(`/cards/${cardId}`);
  return response.item?.description ?? "";
}

/* -------------------------------------------------------------------------- */
/* Shapes                                                                      */
/* -------------------------------------------------------------------------- */

/** Planka's own cap on a card title. */
const cardNameField = z.string().min(1).max(1024);

const createCardShape = {
  board: boardField,
  project: projectField,
  list: z.string().min(1).describe('List to create the card in, by name or id. Example: "Backlog".'),
  name: cardNameField.describe('Card title. Example: "Fix the login redirect".'),
  description: z
    .string()
    .optional()
    .describe(
      "Card body, in Markdown. For a very long text, create the card with its first part and " +
        "add the rest with planka_update_card's append_description.",
    ),
  due_date: dueDateField.optional(),
  position: positionField,
  response_format: responseFormatField,
};
type CreateCardArgs = z.infer<z.ZodObject<typeof createCardShape>>;

const updateCardShape = {
  ...cardLocatorShape,
  name: cardNameField.optional().describe("New title. Omit to leave it unchanged."),
  description: z
    .string()
    .optional()
    .describe(
      "New body, in Markdown, replacing the whole current one. Pass an empty string to clear " +
        "it. To change part of a long text, use append_description or description_edits " +
        "instead: they do not need the whole text sent again.",
    ),
  append_description: z
    .string()
    .min(1)
    .optional()
    .describe(
      "Text to add at the end of the current description, as a new paragraph. Only the new " +
        "text is sent, however long the description already is — the way to write a long text " +
        "over several calls.",
    ),
  description_edits: z
    .array(
      z.object({
        find: z
          .string()
          .min(1)
          .describe("Passage to replace, copied exactly from the current description. Must occur once."),
        replace: z.string().describe("Text to put in its place. Empty to delete the passage."),
      }),
    )
    .min(1)
    .optional()
    .describe(
      "Search-and-replace edits on the current description, applied in order and all or " +
        'nothing. Example: [{"find": "Marie regardait", "replace": "Marie observait"}].',
    ),
  due_date: dueDateField
    .optional()
    .describe(
      'New due date, ISO 8601 UTC. Example: "2026-01-31T17:00:00.000Z". Use clear_due_date to remove it.',
    ),
  clear_due_date: z.boolean().optional().describe("Set true to remove the due date entirely."),
  due_completed: z.boolean().optional().describe("Mark the due date as met (true) or not (false)."),
  response_format: responseFormatField,
};
type UpdateCardArgs = z.infer<z.ZodObject<typeof updateCardShape>>;

const moveCardShape = {
  ...cardLocatorShape,
  list: z.string().min(1).describe('Destination list, by name or id. Example: "En cours".'),
  position: positionField,
  response_format: responseFormatField,
};
type MoveCardArgs = z.infer<z.ZodObject<typeof moveCardShape>>;

const archiveCardShape = cardLocatorShape;
type ArchiveCardArgs = z.infer<z.ZodObject<typeof archiveCardShape>>;

const deleteCardShape = {
  ...cardLocatorShape,
  confirm_name: z
    .string()
    .min(1)
    .describe(
      "The card's exact current title, repeated back as confirmation. The card is read first " +
        'and the deletion is refused if this does not match. Example: "Fix the login redirect".',
    ),
};
type DeleteCardArgs = z.infer<z.ZodObject<typeof deleteCardShape>>;

/** Refuse two ways of changing the description at once, before anything is read. */
function checkOneDescriptionChange(args: UpdateCardArgs): void {
  const given = [args.description, args.append_description, args.description_edits].filter(
    (value) => value !== undefined,
  );
  if (given.length > 1) {
    throw new PlankaError(
      "description, append_description and description_edits cannot be combined.",
      undefined,
      "Pass one of them: description replaces the whole text, append_description adds to its " +
        "end, description_edits changes passages of it.",
    );
  }
}

/**
 * The description a PATCH should carry, or `undefined` to leave it alone.
 *
 * Appending and editing start from the text Planka holds now, read fresh: the
 * board cache can be up to a TTL old, and an edit applied to an old copy would
 * silently undo whatever was changed meanwhile in the Planka UI. That read is
 * one card, not the board, and it saves sending the whole text back.
 */
async function nextDescription(
  cardId: string,
  args: UpdateCardArgs,
): Promise<{ value: string | null; previousLength?: number } | undefined> {
  if (args.description !== undefined) {
    // Planka refuses an empty string; null is how a description is cleared.
    checkDescriptionLength(args.description);
    return { value: args.description === "" ? null : args.description };
  }

  if (args.append_description === undefined && args.description_edits === undefined) return undefined;

  const current = await readDescription(cardId);
  const next =
    args.append_description !== undefined
      ? appendParagraph(current, args.append_description)
      : applyEdits(current, args.description_edits ?? []);
  checkDescriptionLength(next);
  return { value: next === "" ? null : next, previousLength: current.length };
}

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
        const { value: list, snapshot } = await resolveOnBoard(board.id, (current) =>
          resolveList(current, args.list),
        );

        const { position } = resolvePosition(
          cardsInList(snapshot, list.id),
          toPositionRequest(args.position as PositionInput, snapshot, list),
        );
        if (args.description) checkDescriptionLength(args.description);

        const response = await apiRequest<ItemResponse<PlankaCard>>(`/lists/${list.id}/cards`, {
          method: "POST",
          body: {
            type: snapshot.defaultCardType,
            name: args.name,
            position,
            // Planka refuses an empty description rather than storing none.
            ...(args.description ? { description: args.description } : {}),
            ...(args.due_date !== undefined ? { dueDate: args.due_date } : {}),
          },
        });
        const summary = settle(snapshot, response.item);

        return respond(
          args.response_format,
          lines(
            `Created in ${snapshot.name} › ${list.name}:`,
            summary ? renderCardLine(summary) : `- **${args.name}**`,
          ),
          summary ?? { name: args.name, listName: list.name },
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

The description can be changed three ways, one per call:
  - \`description\` replaces the whole text (an empty string clears it);
  - \`append_description\` adds a new paragraph at the end;
  - \`description_edits\` replaces passages, each found exactly once in the current text.
The last two send only what changes, so they are much faster on a long text: write a long
document by appending to it section by section, and fix a passage without re-sending the rest.

To clear the due date pass \`clear_due_date: true\`.

Returns: the updated card as one summary line, and the description's new length.

Examples:
  - Use when: "rename it to 'Fix the SSO redirect'" -> card="Fix the login redirect", name="Fix the SSO redirect"
  - Use when: "it's due end of month" -> due_date="2026-01-31T17:00:00.000Z"
  - Use when: writing the next section of a chapter -> append_description="## Part 2\n\n..."
  - Use when: "replace 'Marie' by 'Jeanne' in that sentence" -> description_edits=[{"find": "Marie regardait", "replace": "Jeanne regardait"}]
  - Don't use when: the card should change column (use planka_move_card)`,
      inputSchema: updateCardShape,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        // Replacing fields converges, but append_description adds its text again on a replay.
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async (args: UpdateCardArgs) => {
      try {
        checkOneDescriptionChange(args);
        const located = await locateCard(args.card, args.board, args.project);

        const body: Record<string, unknown> = {};
        if (args.name !== undefined) body["name"] = args.name;
        const description = await nextDescription(located.card.id, args);
        if (description) body["description"] = description.value;
        if (args.clear_due_date) body["dueDate"] = null;
        else if (args.due_date !== undefined) body["dueDate"] = args.due_date;
        if (args.due_completed !== undefined) body["isDueCompleted"] = args.due_completed;

        if (Object.keys(body).length === 0) {
          throw new PlankaError(
            "Nothing to update.",
            undefined,
            "Pass at least one of name, description, append_description, description_edits, " +
              "due_date, clear_due_date or due_completed.",
          );
        }

        const response = await apiRequest<ItemResponse<PlankaCard>>(`/cards/${located.card.id}`, {
          method: "PATCH",
          body,
        });
        const summary = settle(located.snapshot, response.item, located.card);

        const length = description ? (description.value ?? "").length : undefined;
        const lengthNote =
          length === undefined
            ? undefined
            : `Description: ${length} characters` +
              `${description?.previousLength !== undefined ? ` (was ${description.previousLength})` : ""}.`;

        return respond(
          args.response_format,
          lines(`Updated ${Object.keys(body).join(", ")}:`, summary ? renderCardLine(summary) : undefined, lengthNote),
          {
            id: located.card.id,
            updated: Object.keys(body),
            ...(length !== undefined ? { description_length: length } : {}),
          },
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
        const { value: target, snapshot } = await resolveOnBoard(located.snapshot.id, (current) =>
          resolveList(current, args.list),
        );
        const origin = located.card.listName;

        const siblings = cardsInList(snapshot, target.id);
        const { position, index } = resolvePosition(
          siblings,
          toPositionRequest(args.position as PositionInput, snapshot, target, located.card.id),
          located.card.id,
        );

        // `position` is mandatory on a list change, not optional: Planka rejects
        // the PATCH without it. It is always sent, even for a same-list reorder.
        const response = await apiRequest<ItemResponse<PlankaCard>>(`/cards/${located.card.id}`, {
          method: "PATCH",
          body: { listId: target.id, position },
        });
        const summary = settle(snapshot, response.item, located.card);

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
            summary ? renderCardLine(summary) : undefined,
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

        const response = await apiRequest<ItemResponse<PlankaCard>>(`/cards/${located.card.id}`, {
          method: "PATCH",
          body: { listId: archive.id, position },
        });
        settle(snapshot, response.item);

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
        forgetCard(located.snapshot.id, located.card.id);

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
