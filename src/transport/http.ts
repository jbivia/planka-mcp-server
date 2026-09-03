/**
 * Streamable HTTP transport, for use as a remote connector behind a reverse
 * proxy.
 *
 * Stateful: each client gets its own MCP session keyed by `Mcp-Session-Id`, and
 * its own `McpServer` instance. Sessions are held in a map and dropped when the
 * transport closes.
 *
 * Built on `node:http` rather than Express — the transport only needs three
 * methods routed at one path, which is not worth a framework dependency.
 */

import { randomUUID, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { PlankaConfig } from "../config.js";
import { SERVER_NAME, SERVER_VERSION } from "../constants.js";

/** Largest JSON-RPC body accepted, so a stray upload cannot exhaust memory. */
const MAX_BODY_BYTES = 4 * 1024 * 1024;

function writeJsonRpcError(res: ServerResponse, status: number, code: number, message: string): void {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ jsonrpc: "2.0", error: { code, message }, id: null }));
}

/**
 * Constant-time bearer check.
 *
 * `timingSafeEqual` throws on length mismatch, so lengths are compared first
 * and the result is folded in rather than returned early — otherwise the
 * length of the expected token would leak through response timing.
 */
function bearerMatches(header: string | undefined, expected: string): boolean {
  const prefix = "Bearer ";
  if (!header || !header.startsWith(prefix)) return false;
  const provided = Buffer.from(header.slice(prefix.length));
  const wanted = Buffer.from(expected);
  if (provided.length !== wanted.length) return false;
  return timingSafeEqual(provided, wanted);
}

function readBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error(`Request body exceeds ${MAX_BODY_BYTES} bytes`));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      if (raw === "") {
        resolve(undefined);
        return;
      }
      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(new Error("Request body is not valid JSON"));
      }
    });
    req.on("error", reject);
  });
}

export async function runHttp(config: PlankaConfig, buildServer: () => McpServer): Promise<void> {
  const sessions = new Map<string, StreamableHTTPServerTransport>();

  const httpServer = createServer((req, res) => {
    void (async () => {
      try {
        const url = new URL(req.url ?? "/", `http://${req.headers.host ?? config.httpHost}`);
        if (url.pathname !== config.httpPath) {
          writeJsonRpcError(res, 404, -32601, `No MCP endpoint at ${url.pathname}`);
          return;
        }

        // Defence in depth: the reverse proxy is expected to authenticate, but
        // if the port is ever reachable directly this is the only thing between
        // the internet and a Planka token.
        if (config.httpToken && !bearerMatches(req.headers.authorization, config.httpToken)) {
          res.writeHead(401, {
            "Content-Type": "application/json",
            "WWW-Authenticate": 'Bearer realm="planka-mcp-server"',
          });
          res.end(JSON.stringify({ error: "unauthorized" }));
          return;
        }

        // The transport needs the parsed body, and node:http does not parse it.
        const body = req.method === "POST" ? await readBody(req) : undefined;
        const sessionId = req.headers["mcp-session-id"];
        const existing = typeof sessionId === "string" ? sessions.get(sessionId) : undefined;

        if (existing) {
          await existing.handleRequest(req, res, body);
          return;
        }

        if (req.method === "POST" && isInitializeRequest(body)) {
          const transport: StreamableHTTPServerTransport = new StreamableHTTPServerTransport({
            sessionIdGenerator: () => randomUUID(),
            onsessioninitialized: (id: string): void => {
              sessions.set(id, transport);
            },
            onsessionclosed: (id: string): void => {
              sessions.delete(id);
            },
            // Refuse requests whose Host or Origin was not configured, so a
            // browser page cannot reach a server bound to localhost.
            enableDnsRebindingProtection: true,
            allowedHosts: [config.httpHost, `${config.httpHost}:${config.httpPort}`, "localhost", `localhost:${config.httpPort}`],
          });
          transport.onclose = (): void => {
            if (transport.sessionId) sessions.delete(transport.sessionId);
          };
          await buildServer().connect(transport);
          await transport.handleRequest(req, res, body);
          return;
        }

        if (typeof sessionId === "string") {
          writeJsonRpcError(res, 404, -32001, "Session not found; start a new one with initialize");
          return;
        }
        writeJsonRpcError(res, 400, -32000, "Bad Request: Mcp-Session-Id required");
      } catch (error) {
        console.error(`[${SERVER_NAME}] request failed:`, error);
        if (!res.headersSent) writeJsonRpcError(res, 400, -32700, "Malformed request");
        else res.end();
      }
    })();
  });

  await new Promise<void>((resolve) => {
    httpServer.listen(config.httpPort, config.httpHost, resolve);
  });

  console.error(
    `${SERVER_NAME} v${SERVER_VERSION} listening on ` +
      `http://${config.httpHost}:${config.httpPort}${config.httpPath}` +
      `${config.httpToken ? " (bearer required)" : " (no bearer configured)"}`,
  );
}
