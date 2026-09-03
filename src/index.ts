#!/usr/bin/env node
/**
 * planka-mcp-server — MCP access to a self-hosted Planka 2.x instance.
 *
 * Transport is stdio by default; setting PLANKA_TRANSPORT=http serves the
 * streamable HTTP transport instead, for use as a remote connector.
 *
 * On stdio nothing may be written to stdout except protocol traffic, so every
 * log line in this server goes to stderr. The two exceptions below (--help and
 * --check) never start the protocol loop.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { loadConfig } from "./config.js";
import {
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
  SERVER_NAME,
  SERVER_VERSION,
} from "./constants.js";
import { formatError } from "./errors.js";
import { getProjects } from "./services/board-cache.js";
import { registerAttributeTools } from "./tools/attributes.js";
import { registerDiscoveryTools } from "./tools/discovery.js";
import { registerLifecycleTools } from "./tools/lifecycle.js";
import { registerReadTools } from "./tools/read.js";
import { runHttp } from "./transport/http.js";

function buildServer(): McpServer {
  const server = new McpServer({ name: SERVER_NAME, version: SERVER_VERSION });
  registerDiscoveryTools(server);
  registerReadTools(server);
  registerLifecycleTools(server);
  registerAttributeTools(server);
  return server;
}

const HELP = `${SERVER_NAME} v${SERVER_VERSION}

MCP server for a self-hosted Planka 2.x kanban instance.

Usage:
  ${SERVER_NAME}            start the server (stdio, or HTTP if ${ENV_TRANSPORT}=http)
  ${SERVER_NAME} --check    verify the configuration against the instance, then exit
  ${SERVER_NAME} --help     show this text

Environment:
  ${ENV_BASE_URL}      required — instance root, the trailing /api is optional
  ${ENV_TOKEN}          Planka API key or JWT
  ${ENV_EMAIL}          fallback: account email or username
  ${ENV_PASSWORD}       fallback: account password
  ${ENV_TRANSPORT}      "stdio" (default) or "http"
  ${ENV_HTTP_HOST}      HTTP bind address (default 127.0.0.1)
  ${ENV_HTTP_PORT}      HTTP port (default 3000)
  ${ENV_HTTP_PATH}      HTTP endpoint path (default /mcp)
  ${ENV_HTTP_TOKEN}     if set, HTTP callers must send it as a bearer token
  ${ENV_CACHE_TTL}  board cache lifetime in ms (default 60000)
`;

/** Verify the configuration against the live instance, for `npm run check`. */
async function runCheck(): Promise<never> {
  try {
    const config = loadConfig();
    process.stdout.write(`Planka: ${config.apiUrl}\n`);
    const projects = await getProjects();
    process.stdout.write(
      `OK — ${projects.length} project(s), ` +
        `${projects.reduce((total, project) => total + project.boards.length, 0)} board(s) visible.\n`,
    );
    for (const project of projects) {
      process.stdout.write(`  ${project.name}: ${project.boards.map((b) => b.name).join(", ") || "(no board)"}\n`);
    }
    process.exit(0);
  } catch (error) {
    process.stderr.write(`${formatError(error)}\n`);
    process.exit(1);
  }
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.includes("--help") || args.includes("-h")) {
    process.stdout.write(HELP);
    return;
  }
  if (args.includes("--check")) {
    await runCheck();
    return;
  }

  // Fail on configuration before connecting: an MCP client shows a startup
  // error far more usefully than it shows a tool call failing every time.
  let config;
  try {
    config = loadConfig();
  } catch (error) {
    console.error(formatError(error));
    process.exit(1);
  }

  if (config.transport === "http") {
    // One McpServer per session, so sessions cannot observe each other.
    await runHttp(config, buildServer);
    return;
  }

  await buildServer().connect(new StdioServerTransport());
  console.error(`${SERVER_NAME} v${SERVER_VERSION} running on stdio`);
}

main().catch((error: unknown) => {
  console.error(formatError(error));
  process.exit(1);
});
