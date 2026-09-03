/**
 * Environment reading and validation.
 *
 * Validation is lazy and cached: a missing variable must surface as a readable
 * message on the first tool call (or on `--check`), not as a module-load crash
 * that an MCP client reports as "server exited".
 */

import {
  DEFAULT_CACHE_TTL_MS,
  DEFAULT_HTTP_HOST,
  DEFAULT_HTTP_PATH,
  DEFAULT_HTTP_PORT,
  ENV_BASE_URL,
  ENV_CACHE_TTL,
  ENV_EMAIL,
  ENV_HTTP_HOST,
  ENV_HTTP_PATH,
  ENV_HTTP_PORT,
  ENV_HTTP_TOKEN,
  ENV_PASSWORD,
  ENV_TOKEN,
  ENV_TRANSPORT,
} from "./constants.js";
import { PlankaError } from "./errors.js";

export type TransportMode = "stdio" | "http";

export interface PlankaConfig {
  /** Base URL including the `/api` suffix, no trailing slash. */
  apiUrl: string;
  /** Same instance without `/api`, for building human-facing links. */
  webUrl: string;
  token?: string;
  email?: string;
  password?: string;
  cacheTtlMs: number;
  transport: TransportMode;
  httpHost: string;
  httpPort: number;
  httpPath: string;
  httpToken?: string;
}

let cachedConfig: PlankaConfig | undefined;

function readEnv(name: string): string | undefined {
  const value = process.env[name]?.trim();
  return value === "" ? undefined : value;
}

function readPositiveInt(name: string, fallback: number): number {
  const raw = readEnv(name);
  if (raw === undefined) return fallback;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new PlankaError(
      `${name} must be a positive integer, got "${raw}".`,
      undefined,
      `Remove it to use the default (${fallback}).`,
    );
  }
  return parsed;
}

export function loadConfig(): PlankaConfig {
  if (cachedConfig) return cachedConfig;

  const rawUrl = readEnv(ENV_BASE_URL);
  const token = readEnv(ENV_TOKEN);
  const email = readEnv(ENV_EMAIL);
  const password = readEnv(ENV_PASSWORD);

  if (!rawUrl) {
    throw new PlankaError(
      `Missing required environment variable ${ENV_BASE_URL}.`,
      undefined,
      `Set it in the MCP client configuration, for example ` +
        `${ENV_BASE_URL}=https://planka.example.com (the trailing /api is optional).`,
    );
  }

  // Either a token or a full credential pair; a lone email or a lone password
  // is a half-finished configuration and is worth saying so explicitly.
  if (!token && !(email && password)) {
    throw new PlankaError(
      `No Planka credentials configured.`,
      undefined,
      `Set ${ENV_TOKEN} to a Planka API key or JWT, or set both ${ENV_EMAIL} and ` +
        `${ENV_PASSWORD} to have the server exchange them for a token at startup.`,
    );
  }

  const withoutTrailingSlash = rawUrl.replace(/\/+$/, "");
  const webUrl = withoutTrailingSlash.replace(/\/api$/, "");
  const apiUrl = `${webUrl}/api`;
  try {
    void new URL(apiUrl);
  } catch {
    throw new PlankaError(
      `${ENV_BASE_URL} is not a valid URL: "${rawUrl}".`,
      undefined,
      `Use a full origin such as https://planka.example.com.`,
    );
  }

  const rawTransport = readEnv(ENV_TRANSPORT)?.toLowerCase() ?? "stdio";
  if (rawTransport !== "stdio" && rawTransport !== "http") {
    throw new PlankaError(
      `${ENV_TRANSPORT} must be "stdio" or "http", got "${rawTransport}".`,
      undefined,
      `Leave it unset for stdio, the default for a local MCP client.`,
    );
  }

  const httpPath = readEnv(ENV_HTTP_PATH) ?? DEFAULT_HTTP_PATH;

  cachedConfig = {
    apiUrl,
    webUrl,
    ...(token ? { token } : {}),
    ...(email ? { email } : {}),
    ...(password ? { password } : {}),
    cacheTtlMs: readPositiveInt(ENV_CACHE_TTL, DEFAULT_CACHE_TTL_MS),
    transport: rawTransport,
    httpHost: readEnv(ENV_HTTP_HOST) ?? DEFAULT_HTTP_HOST,
    httpPort: readPositiveInt(ENV_HTTP_PORT, DEFAULT_HTTP_PORT),
    httpPath: httpPath.startsWith("/") ? httpPath : `/${httpPath}`,
    ...(readEnv(ENV_HTTP_TOKEN) ? { httpToken: readEnv(ENV_HTTP_TOKEN) as string } : {}),
  };
  return cachedConfig;
}

/** Test seam: drop the memoized config so a new environment takes effect. */
export function resetConfigForTesting(): void {
  cachedConfig = undefined;
}
