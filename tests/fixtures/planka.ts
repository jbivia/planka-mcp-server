/**
 * A stateful fake of the Planka routes the card tools use, and an MCP client
 * wired to the real tool registrations through an in-memory transport.
 *
 * It exists for the tests that are about *which requests* a tool makes — the
 * board read is the expensive one, and a write must not trigger it — so every
 * call is recorded, and writes change the state that later reads return.
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { mock } from "node:test";
import { resetConfigForTesting } from "../../src/config.js";
import { resetAuthForTesting } from "../../src/services/auth.js";
import { resetCacheForTesting } from "../../src/services/board-cache.js";
import { registerAttributeTools } from "../../src/tools/attributes.js";
import { registerDiscoveryTools } from "../../src/tools/discovery.js";
import { registerLifecycleTools } from "../../src/tools/lifecycle.js";
import { registerReadTools } from "../../src/tools/read.js";
import type { PlankaCard, PlankaIncluded } from "../../src/types.js";
import { BOARD_ID, boardResponse } from "./board.js";

export interface RecordedCall {
  method: string;
  /** Path below /api, ids left as they are. */
  path: string;
  body: Record<string, unknown> | undefined;
}

export interface FakePlanka {
  calls: RecordedCall[];
  /** The board as Planka currently holds it; tests may edit it to simulate another client. */
  included: Required<Pick<PlankaIncluded, "cards" | "lists">> & PlankaIncluded;
  card(id: string): PlankaCard;
  call(name: string, args: Record<string, unknown>): Promise<{ text: string; isError: boolean; structured: unknown }>;
  close(): Promise<void>;
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

export async function startFakePlanka(): Promise<FakePlanka> {
  process.env["PLANKA_BASE_URL"] = "https://planka.example.com";
  process.env["PLANKA_TOKEN"] = "abcdef_api_key";
  delete process.env["PLANKA_EMAIL"];
  delete process.env["PLANKA_PASSWORD"];
  delete process.env["PLANKA_CACHE_TTL_MS"];
  resetConfigForTesting();
  resetAuthForTesting();
  resetCacheForTesting();

  const board = structuredClone(boardResponse.item);
  const included = structuredClone(boardResponse.included) as FakePlanka["included"];
  const calls: RecordedCall[] = [];
  let nextId = 4_000_000_000_000_000_000n;

  const find = (id: string): PlankaCard | undefined => included.cards.find((card) => card.id === id);
  const isVisible = (card: PlankaCard): boolean => {
    const type = included.lists.find((list) => list.id === card.listId)?.type;
    return type === "active" || type === "closed";
  };

  mock.method(globalThis, "fetch", async (input: unknown, init: RequestInit = {}) => {
    const method = init.method ?? "GET";
    const path = new URL(String(input)).pathname.replace(/^\/api/, "");
    const body = typeof init.body === "string" ? (JSON.parse(init.body) as Record<string, unknown>) : undefined;
    calls.push({ method, path, body });

    let match: RegExpMatchArray | null;
    if (method === "GET" && path === "/projects") {
      return json({ items: [{ id: board.projectId, name: "Infrastructure" }], included: { boards: [board] } });
    }
    if (method === "GET" && path === `/boards/${BOARD_ID}`) {
      // Like Planka 2.2.1: archived and trashed cards are left out.
      return json({ item: board, included: { ...structuredClone(included), cards: included.cards.filter(isVisible) } });
    }
    if ((match = path.match(/^\/cards\/([^/]+)$/))) {
      const card = find(match[1] as string);
      if (!card) return json({ code: "E_NOT_FOUND", message: "Card not found" }, 404);
      if (method === "PATCH") Object.assign(card, body);
      if (method === "DELETE") included.cards = included.cards.filter((candidate) => candidate !== card);
      const taskLists = (included.taskLists ?? []).filter((taskList) => taskList.cardId === card.id);
      return json({
        item: card,
        included: {
          taskLists,
          tasks: (included.tasks ?? []).filter((task) => taskLists.some((taskList) => taskList.id === task.taskListId)),
          cardLabels: (included.cardLabels ?? []).filter((link) => link.cardId === card.id),
          cardMemberships: (included.cardMemberships ?? []).filter((link) => link.cardId === card.id),
          users: [],
        },
      });
    }
    if (method === "GET" && path.match(/^\/cards\/[^/]+\/comments$/)) {
      return json({ items: [], included: { users: [] } });
    }
    if (method === "POST" && (match = path.match(/^\/lists\/([^/]+)\/cards$/))) {
      const card: PlankaCard = {
        id: String(nextId++),
        boardId: BOARD_ID,
        listId: match[1] as string,
        commentsTotal: 0,
        ...(body as { name: string }),
      };
      included.cards.push(card);
      return json({ item: card });
    }
    return json({ code: "E_NOT_FOUND", message: `No route ${method} ${path}` }, 404);
  });

  const server = new McpServer({ name: "test", version: "0" });
  registerDiscoveryTools(server);
  registerReadTools(server);
  registerLifecycleTools(server);
  registerAttributeTools(server);
  const [serverSide, clientSide] = InMemoryTransport.createLinkedPair();
  await server.connect(serverSide);
  const client = new Client({ name: "test", version: "0" });
  await client.connect(clientSide);

  return {
    calls,
    included,
    card(id) {
      const card = find(id);
      if (!card) throw new Error(`no card ${id}`);
      return card;
    },
    async call(name, args) {
      const result = (await client.callTool({ name, arguments: args })) as {
        content?: { text?: string }[];
        isError?: boolean;
        structuredContent?: unknown;
      };
      return {
        text: result.content?.map((part) => part.text ?? "").join("\n") ?? "",
        isError: result.isError === true,
        structured: result.structuredContent,
      };
    },
    async close() {
      await client.close();
      mock.restoreAll();
      resetConfigForTesting();
      resetAuthForTesting();
      resetCacheForTesting();
    },
  };
}
