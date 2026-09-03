/**
 * The single HTTP client. Every upstream call in this server goes through
 * `apiRequest`, which is what makes error mapping, timeouts and token refresh
 * exist in exactly one place.
 *
 * Planka's own error bodies are `{code, message}` and say nothing about what to
 * do next; the mapping below replaces them with a sentence naming the likely
 * cause and the tool that fixes it.
 */

import { loadConfig } from "../config.js";
import { REQUEST_TIMEOUT_MS } from "../constants.js";
import { PlankaError } from "../errors.js";
import { authHeaders, canRefreshToken, invalidateToken } from "./auth.js";

export interface RequestOptions {
  method?: "GET" | "POST" | "PATCH" | "DELETE";
  query?: Record<string, string | number | undefined>;
  body?: unknown;
}

interface PlankaErrorBody {
  code?: string;
  message?: string;
  problems?: string[];
}

function buildUrl(path: string, query: RequestOptions["query"]): URL {
  const config = loadConfig();
  // `path` may carry a literal ":" separator (…/card-labels/labelId:123), which
  // is legal in a path segment and must not be encoded, so it is concatenated
  // rather than passed through URL's second argument.
  const url = new URL(`${config.apiUrl}${path}`);
  for (const [key, value] of Object.entries(query ?? {})) {
    if (value !== undefined && value !== "") url.searchParams.set(key, String(value));
  }
  return url;
}

function translateNetworkError(error: unknown, url: URL): PlankaError {
  const codes = [
    error instanceof Error ? error.name : "",
    (error as { code?: string }).code ?? "",
    ((error as { cause?: { code?: string } }).cause?.code ?? ""),
  ]
    .join(" ")
    .toUpperCase();

  if (codes.includes("TIMEOUT") || codes.includes("ABORT")) {
    return new PlankaError(
      `Planka did not answer within ${REQUEST_TIMEOUT_MS / 1000}s.`,
      undefined,
      `Check that ${url.origin} is up and reachable from this machine.`,
    );
  }
  if (codes.includes("ENOTFOUND") || codes.includes("EAI_AGAIN")) {
    return new PlankaError(
      `Cannot resolve ${url.hostname}.`,
      undefined,
      `Check PLANKA_BASE_URL and this machine's DNS.`,
    );
  }
  if (codes.includes("ECONNREFUSED") || codes.includes("EHOSTUNREACH")) {
    return new PlankaError(
      `Connection to ${url.origin} refused.`,
      undefined,
      `Check that Planka is running and that PLANKA_BASE_URL has the right scheme and port.`,
    );
  }
  if (codes.includes("CERT") || codes.includes("SELF_SIGNED")) {
    return new PlankaError(
      `TLS certificate for ${url.hostname} was rejected.`,
      undefined,
      `If the instance uses a private CA, point NODE_EXTRA_CA_CERTS at its root certificate.`,
    );
  }
  return new PlankaError(
    `Request to ${url.pathname} failed: ${error instanceof Error ? error.message : String(error)}`,
  );
}

async function translateHttpError(response: Response, url: URL): Promise<PlankaError> {
  let body: PlankaErrorBody = {};
  try {
    body = (await response.json()) as PlankaErrorBody;
  } catch {
    // Planka answered with something that is not JSON; the status is all we have.
  }
  const detail = body.message ? ` ${body.message}` : "";

  switch (response.status) {
    case 400:
      return new PlankaError(
        `Planka rejected the request (400).${detail}`,
        400,
        body.problems?.length
          ? `Planka reported: ${body.problems.join(" | ")}`
          : `Check the argument values, in particular date formats (ISO 8601, e.g. 2026-01-31T17:00:00.000Z).`,
      );
    case 401:
      return new PlankaError(
        `Planka rejected the credentials (401).${detail}`,
        401,
        `Check PLANKA_TOKEN, or PLANKA_EMAIL and PLANKA_PASSWORD. An API key is created in ` +
          `Planka under the user menu > Settings > API key, and is shown only once.`,
      );
    case 403:
      return new PlankaError(
        `Not allowed (403).${detail}`,
        403,
        `The account is a viewer on this board, not an editor. Every write in Planka needs ` +
          `board editor rights; ask a project manager to change the membership role.`,
      );
    case 404:
      return new PlankaError(
        `Planka has no such resource (404): ${url.pathname}.`,
        404,
        `The id may be stale — the item can have been deleted or moved since it was read. ` +
          `Call planka_describe_board or planka_search_cards to get a current id.`,
      );
    case 422:
      return new PlankaError(
        `Planka refused the change (422).${detail}`,
        422,
        `The values are well-formed but not acceptable here — for example a list that belongs ` +
          `to another board, or a label already on the card.`,
      );
    case 429:
      return new PlankaError(`Planka is rate limiting (429).${detail}`, 429, `Retry in a few seconds.`);
    default:
      return new PlankaError(
        `Planka returned HTTP ${response.status}.${detail}`,
        response.status,
        `This is an upstream failure; check the Planka server logs.`,
      );
  }
}

async function performRequest(path: string, options: RequestOptions): Promise<Response> {
  const url = buildUrl(path, options.query);
  const { method = "GET", body } = options;

  const send = async (): Promise<Response> => {
    const headers: Record<string, string> = {
      ...(await authHeaders()),
      Accept: "application/json",
    };
    if (body !== undefined) headers["Content-Type"] = "application/json";

    try {
      return await fetch(url, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (error) {
      throw translateNetworkError(error, url);
    }
  };

  let response = await send();

  // An exchanged JWT expires while the server keeps running. Sign in again and
  // replay once — but only when there are credentials to sign in with, so a
  // plainly wrong API key fails with one clear error instead of two.
  if (response.status === 401 && canRefreshToken()) {
    invalidateToken();
    response = await send();
  }

  if (!response.ok) throw await translateHttpError(response, url);
  return response;
}

/** Issue a request and parse the JSON envelope. */
export async function apiRequest<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const response = await performRequest(path, options);

  if (response.status === 204) return {} as T;
  const text = await response.text();
  if (text === "") return {} as T;

  try {
    return JSON.parse(text) as T;
  } catch {
    throw new PlankaError(
      `Planka returned a non-JSON body for ${path}.`,
      response.status,
      `PLANKA_BASE_URL may point at something other than a Planka API — a reverse proxy ` +
        `error page, or the web UI instead of the /api endpoint.`,
    );
  }
}
