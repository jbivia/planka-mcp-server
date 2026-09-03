/**
 * Every tunable value and every environment variable name lives here, so that
 * error messages can name them consistently and a limit is never redefined in
 * two places with two different numbers.
 */

export const SERVER_NAME = "planka-mcp-server";
export const SERVER_VERSION = "1.0.0";

/* Environment variables. */
export const ENV_BASE_URL = "PLANKA_BASE_URL";
export const ENV_TOKEN = "PLANKA_TOKEN";
export const ENV_EMAIL = "PLANKA_EMAIL";
export const ENV_PASSWORD = "PLANKA_PASSWORD";
export const ENV_TRANSPORT = "PLANKA_TRANSPORT";
export const ENV_HTTP_HOST = "PLANKA_HTTP_HOST";
export const ENV_HTTP_PORT = "PLANKA_HTTP_PORT";
export const ENV_HTTP_TOKEN = "PLANKA_HTTP_TOKEN";
export const ENV_HTTP_PATH = "PLANKA_HTTP_PATH";
export const ENV_CACHE_TTL = "PLANKA_CACHE_TTL_MS";

/* Defaults for the optional ones. */
export const DEFAULT_HTTP_HOST = "127.0.0.1";
export const DEFAULT_HTTP_PORT = 3000;
export const DEFAULT_HTTP_PATH = "/mcp";
export const DEFAULT_CACHE_TTL_MS = 60_000;

/** Upstream request timeout. Planka is self-hosted, so this is generous. */
export const REQUEST_TIMEOUT_MS = 30_000;

/**
 * Planka orders siblings with a sparse numeric key; every example in the
 * OpenAPI spec is 65536 (2^16). Nothing documents the increment, so we place
 * items relative to their real neighbours and only use this as the step for an
 * append and as the seed for an empty list.
 */
export const POSITION_STEP = 65_536;

/* Context budgets. A tool result larger than this is truncated with a note. */
export const CHARACTER_LIMIT = 25_000;

/* Card listing pagination. */
export const DEFAULT_PAGE_SIZE = 25;
export const MAX_PAGE_SIZE = 100;

/**
 * Planka has no cross-board search route, so an unscoped search walks boards
 * one by one. Past this many boards we stop and say which ones were skipped,
 * rather than firing dozens of requests behind the agent's back.
 */
export const SEARCH_BOARD_LIMIT = 10;

/** Comments are paginated by cursor upstream; this is how many we surface. */
export const MAX_COMMENTS = 20;
