/**
 * One error class for the whole server.
 *
 * Planka's own messages are not actionable — most 404s come back as a bare
 * "Not Found", and a 403 says nothing about which permission is missing. The
 * `hint` field carries the sentence that tells the agent what to do next, and
 * `formatError` is the single place that decides how the two are rendered.
 */
export class PlankaError extends Error {
  readonly status: number | undefined;
  readonly hint: string | undefined;

  constructor(message: string, status?: number, hint?: string) {
    super(message);
    this.name = "PlankaError";
    this.status = status;
    this.hint = hint;
  }
}

/** Render any thrown value as one actionable line for the agent. */
export function formatError(error: unknown): string {
  if (error instanceof PlankaError) {
    return error.hint ? `Error: ${error.message} ${error.hint}` : `Error: ${error.message}`;
  }
  if (error instanceof Error) return `Error: ${error.message}`;
  return `Error: ${String(error)}`;
}

/**
 * Quote a list of candidate names inside an error message.
 *
 * Resolution failures are the most common error an agent will hit, and the
 * only useful reply is the list of what does exist — so this is shared rather
 * than re-inlined at every call site.
 */
export function quoteList(values: readonly string[], limit = 25): string {
  if (values.length === 0) return "(none)";
  const shown = values.slice(0, limit).map((value) => `"${value}"`);
  const rest = values.length - shown.length;
  return rest > 0 ? `${shown.join(", ")} (+${rest} more)` : shown.join(", ");
}
