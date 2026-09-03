/**
 * Zod shapes shared by several tools.
 *
 * These are raw shapes (plain objects of Zod types), not `z.object(...)`,
 * because that is what `registerTool` expects for `inputSchema`.
 *
 * Every `.describe()` here ends up in the tool schema the agent reads, so the
 * wording matters: each one says what the field accepts and, where the format
 * is not self-evident, shows a value.
 */

import { z } from "zod";
import { DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE } from "../constants.js";

/** A reference to something addressable by id or by name. */
export function reference(entity: string, example: string) {
  return z
    .string()
    .min(1)
    .describe(`${entity} — either its name or its Planka id. Example: "${example}".`);
}

export const responseFormatField = z
  .enum(["markdown", "json"])
  .default("markdown")
  .describe("`markdown` (default, compact and readable) or `json` (the projected fields).");

export const boardField = reference("Board", "Roadmap");

export const projectField = reference("Project", "Infrastructure").optional()
  .describe(
    "Project the board belongs to. Only needed when two projects have a board with the same name.",
  );

export const cardField = reference("Card", "Fix the login redirect");

export const paginationShape = {
  limit: z
    .number()
    .int()
    .min(1)
    .max(MAX_PAGE_SIZE)
    .default(DEFAULT_PAGE_SIZE)
    .describe(`How many cards to return, 1-${MAX_PAGE_SIZE} (default ${DEFAULT_PAGE_SIZE}).`),
  offset: z
    .number()
    .int()
    .min(0)
    .default(0)
    .describe("Index of the first card to return, for paging. Use `next_offset` from a prior call."),
};

/**
 * Where an item should land among its siblings.
 *
 * Planka wants a raw numeric position that only makes sense relative to the
 * cards already in the list, which an agent has no way to guess. These four
 * forms are what an agent actually means, and the server does the arithmetic.
 */
export const positionField = z
  .union([
    z.literal("top"),
    z.literal("bottom"),
    z.object({ before: z.string().min(1) }).describe("Place it just above this card (name or id)."),
    z.object({ after: z.string().min(1) }).describe("Place it just below this card (name or id)."),
    z.object({ index: z.number().int().min(0) }).describe("Place it at this 0-based rank."),
  ])
  .default("bottom")
  .describe(
    'Where in the target list: "top", "bottom" (default), {"before": "<card>"}, ' +
      '{"after": "<card>"} or {"index": 2}.',
  );

export const dueDateField = z
  .string()
  .describe("Due date in ISO 8601 UTC. Example: \"2026-01-31T17:00:00.000Z\".");

/** Shared output shape for the paginated listings. */
export const paginationOutputShape = {
  total: z.number(),
  count: z.number(),
  offset: z.number(),
  has_more: z.boolean(),
  next_offset: z.number().optional(),
};
