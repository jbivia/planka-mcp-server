/**
 * Credential handling.
 *
 * Planka accepts two unrelated credentials on two different headers, and the
 * spec gives no way to tell them apart other than their shape. A JWT is three
 * base64url segments separated by dots; an API key is a single opaque string.
 * Guessing wrong costs a 401 on every call, so the discrimination lives here,
 * in one place, with the rule written down.
 *
 * The login call is issued with a bare `fetch` rather than through `client.ts`,
 * because the client asks this module for its headers and the cycle would be
 * unresolvable.
 */

import { loadConfig } from "../config.js";
import { REQUEST_TIMEOUT_MS } from "../constants.js";
import { PlankaError } from "../errors.js";

const JWT_PATTERN = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;

/** A token obtained by exchanging email + password, cached for the process. */
let exchangedToken: string | undefined;
/** In-flight exchange, so concurrent tool calls trigger a single login. */
let pendingExchange: Promise<string> | undefined;

function isJwt(token: string): boolean {
  return JWT_PATTERN.test(token);
}

async function exchangeCredentials(): Promise<string> {
  const config = loadConfig();
  if (!config.email || !config.password) {
    throw new PlankaError(
      "Planka rejected the configured token and no email/password fallback is available.",
      401,
      "Set PLANKA_EMAIL and PLANKA_PASSWORD so the server can obtain a fresh token, " +
        "or replace PLANKA_TOKEN with a valid API key.",
    );
  }

  let response: Response;
  try {
    response = await fetch(`${config.apiUrl}/access-tokens`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({
        emailOrUsername: config.email,
        password: config.password,
      }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (error) {
    throw new PlankaError(
      `Could not reach Planka to sign in: ${error instanceof Error ? error.message : String(error)}`,
      undefined,
      `Check PLANKA_BASE_URL (${config.apiUrl}) and that the instance is reachable.`,
    );
  }

  if (!response.ok) {
    // 2FA is the one failure worth naming: it is not a typo in the password,
    // and no amount of retrying will fix it.
    const hint =
      response.status === 401 || response.status === 403
        ? "Check PLANKA_EMAIL and PLANKA_PASSWORD. If the account has two-factor " +
          "authentication enabled, this server cannot sign in with it — use PLANKA_TOKEN " +
          "with an API key instead (Planka > user menu > Settings > API key)."
        : "Verify that PLANKA_BASE_URL points at a Planka 2.x instance.";
    throw new PlankaError(`Planka sign-in failed (HTTP ${response.status}).`, response.status, hint);
  }

  const payload = (await response.json()) as { item?: unknown };
  if (typeof payload.item !== "string" || payload.item === "") {
    throw new PlankaError(
      "Planka sign-in returned no access token.",
      undefined,
      "Verify that PLANKA_BASE_URL points at a Planka 2.x instance.",
    );
  }

  exchangedToken = payload.item;
  return payload.item;
}

async function currentToken(): Promise<string> {
  const config = loadConfig();
  if (config.token) return config.token;
  if (exchangedToken) return exchangedToken;
  // Collapse concurrent first calls into a single sign-in.
  pendingExchange ??= exchangeCredentials().finally(() => {
    pendingExchange = undefined;
  });
  return pendingExchange;
}

/** Authentication headers for one upstream request. */
export async function authHeaders(): Promise<Record<string, string>> {
  const token = await currentToken();
  return isJwt(token) ? { Authorization: `Bearer ${token}` } : { "X-Api-Key": token };
}

/**
 * Whether a 401 is worth retrying once.
 *
 * Only an exchanged JWT expires. A configured API key that comes back 401 is
 * simply wrong, and retrying it would turn one clear error into two.
 */
export function canRefreshToken(): boolean {
  const config = loadConfig();
  if (config.token) return false;
  return Boolean(config.email && config.password);
}

/** Drop the cached JWT so the next request signs in again. */
export function invalidateToken(): void {
  exchangedToken = undefined;
}

/** Test seam. */
export function resetAuthForTesting(): void {
  exchangedToken = undefined;
  pendingExchange = undefined;
}
