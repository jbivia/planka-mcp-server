/**
 * Tool result shapes and rendering helpers.
 *
 * Two rules are enforced here rather than in each tool: a tool failure is
 * reported in-band (`isError: true`) so the agent can read the hint and try
 * something else, and no result is ever allowed past CHARACTER_LIMIT.
 */

import { CHARACTER_LIMIT, DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE } from "../constants.js";
import { formatError } from "../errors.js";

/**
 * A type alias, not an interface: the SDK's `CallToolResult` is a passthrough
 * Zod schema and carries an index signature, which an interface cannot satisfy.
 */
export type ToolResult = {
  content: { type: "text"; text: string }[];
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
};

export function toolSuccess(text: string, structured?: object): ToolResult {
  return {
    content: [{ type: "text", text: capText(text) }],
    ...(structured ? { structuredContent: structured as Record<string, unknown> } : {}),
  };
}

export function toolFailure(error: unknown): ToolResult {
  return { isError: true, content: [{ type: "text", text: formatError(error) }] };
}

/** Render either the markdown view or the projected JSON, per the caller's choice. */
export function respond(
  format: "markdown" | "json",
  markdown: string,
  payload: object,
): ToolResult {
  return format === "json"
    ? toolSuccess(JSON.stringify(payload, null, 2), payload)
    : toolSuccess(markdown, payload);
}

/** Last-resort guard so an unexpectedly large board cannot blow the context. */
export function capText(text: string, limit = CHARACTER_LIMIT): string {
  if (text.length <= limit) return text;
  return (
    `${text.slice(0, limit - 200).trimEnd()}\n\n` +
    `[truncated at ${limit} characters — narrow the query, or use a smaller limit]`
  );
}

/* -------------------------------------------------------------------------- */
/* Markdown helpers                                                            */
/* -------------------------------------------------------------------------- */

/** Join defined lines, dropping the ones a caller left undefined. */
export function lines(...values: (string | undefined | false)[]): string {
  return values.filter((value): value is string => Boolean(value)).join("\n");
}

export function line(label: string, value: string | number | undefined | null): string | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  return `**${label}:** ${value}`;
}

/** Collapse a long body to a single readable excerpt. */
export function excerpt(text: string | undefined, max = 280): string | undefined {
  if (!text) return undefined;
  const flat = text.replace(/\s+/g, " ").trim();
  if (flat === "") return undefined;
  return flat.length <= max ? flat : `${flat.slice(0, max - 1).trimEnd()}…`;
}

/** `2026-01-31T17:00:00.000Z` → `2026-01-31 17:00 UTC`, unparseable input kept as-is. */
export function formatDate(value: string | null | undefined): string | undefined {
  if (!value) return undefined;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return `${date.toISOString().slice(0, 16).replace("T", " ")} UTC`;
}

/* -------------------------------------------------------------------------- */
/* Pagination                                                                  */
/* -------------------------------------------------------------------------- */

export interface Page<T> {
  total: number;
  count: number;
  offset: number;
  has_more: boolean;
  next_offset?: number;
  items: T[];
}

export function paginate<T>(all: T[], offset = 0, limit = DEFAULT_PAGE_SIZE): Page<T> {
  const size = Math.min(Math.max(limit, 1), MAX_PAGE_SIZE);
  const start = Math.max(offset, 0);
  const items = all.slice(start, start + size);
  const nextOffset = start + items.length;
  const hasMore = nextOffset < all.length;
  return {
    total: all.length,
    count: items.length,
    offset: start,
    has_more: hasMore,
    ...(hasMore ? { next_offset: nextOffset } : {}),
    items,
  };
}

export function paginationFooter(page: Page<unknown>): string {
  if (page.total === 0) return "";
  const shown = `Showing ${page.offset + 1}–${page.offset + page.count} of ${page.total}.`;
  return page.has_more ? `${shown} Pass offset=${page.next_offset} for the next page.` : shown;
}
