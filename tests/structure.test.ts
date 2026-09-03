/**
 * Structural creation: the duplicate guard, and the multipart path it needs.
 *
 * The guard is the only thing standing between an agent that retries and a
 * board whose name no longer resolves, so its edge cases are pinned here.
 */

import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it, mock } from "node:test";
import { resetConfigForTesting } from "../src/config.js";
import { PlankaError } from "../src/errors.js";
import { resetAuthForTesting } from "../src/services/auth.js";
import { apiRequest } from "../src/services/client.js";
import { refuseDuplicate } from "../src/tools/structure.js";

describe("refuseDuplicate", () => {
  const boards = [
    { id: "b1", name: "Roadmap" },
    { id: "b2", name: "Runbook" },
  ];

  it("lets a genuinely new name through", () => {
    assert.doesNotThrow(() => refuseDuplicate(boards, "Discovery", "board", "in project X"));
  });

  it("refuses an exact clash and names the existing one, with its id", () => {
    try {
      refuseDuplicate(boards, "Roadmap", "board", 'in project "Infra"');
      assert.fail("expected a throw");
    } catch (error) {
      assert.ok(error instanceof PlankaError);
      assert.match(error.message, /already exists in project "Infra"/);
      assert.match(error.message, /id b1/);
    }
  });

  it("refuses a clash that differs only by case", () => {
    // resolve.ts matches case-insensitively, so "roadmap" would shadow
    // "Roadmap" just as effectively as an identical name.
    assert.throws(() => refuseDuplicate(boards, "roadmap", "board", "here"), PlankaError);
  });

  it("refuses a clash that differs only by surrounding whitespace", () => {
    assert.throws(() => refuseDuplicate(boards, "  Roadmap  ", "board", "here"), PlankaError);
  });

  it("allows a name that merely contains an existing one", () => {
    // Only exact clashes are refused: "Roadmap 2026" resolves fine on its own,
    // because resolution tries equality before any looser pass.
    assert.doesNotThrow(() => refuseDuplicate(boards, "Roadmap 2026", "board", "here"));
  });

  it("accepts anything when there are no siblings yet", () => {
    assert.doesNotThrow(() => refuseDuplicate([], "First", "list", "here"));
  });
});

describe("client: multipart form bodies", () => {
  const originalEnv = { ...process.env };
  let calls: { url: string; body: unknown; headers: Record<string, string> }[] = [];

  beforeEach(() => {
    calls = [];
    process.env["PLANKA_BASE_URL"] = "https://planka.example.com";
    process.env["PLANKA_TOKEN"] = "abcdef_api_key";
    delete process.env["PLANKA_EMAIL"];
    delete process.env["PLANKA_PASSWORD"];
    resetConfigForTesting();
    resetAuthForTesting();

    mock.method(globalThis, "fetch", async (input: unknown, init: RequestInit = {}) => {
      calls.push({
        url: String(input),
        body: init.body,
        headers: (init.headers ?? {}) as Record<string, string>,
      });
      return new Response(JSON.stringify({ item: { id: "1", name: "Roadmap" } }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    });
  });

  afterEach(() => {
    mock.restoreAll();
    process.env = { ...originalEnv };
    resetConfigForTesting();
    resetAuthForTesting();
  });

  it("sends a FormData body and lets fetch set the Content-Type", async () => {
    await apiRequest("/projects/42/boards", {
      method: "POST",
      form: { name: "Roadmap", position: 65536 },
    });

    const call = calls[0];
    assert.ok(call?.body instanceof FormData, "the body must be FormData, not a JSON string");
    // Setting Content-Type by hand would omit the multipart boundary and the
    // server could not parse the body — so it must be absent here.
    assert.equal(call?.headers["Content-Type"], undefined);
    assert.equal((call?.body as FormData).get("name"), "Roadmap");
    assert.equal((call?.body as FormData).get("position"), "65536");
  });

  it("still sends JSON with its Content-Type when `form` is not used", async () => {
    await apiRequest("/boards/42/lists", {
      method: "POST",
      body: { type: "active", name: "Backlog", position: 65536 },
    });

    const call = calls[0];
    assert.equal(call?.headers["Content-Type"], "application/json");
    assert.equal(typeof call?.body, "string");
    assert.deepEqual(JSON.parse(String(call?.body)), {
      type: "active",
      name: "Backlog",
      position: 65536,
    });
  });

  it("carries the auth header on a multipart request too", async () => {
    await apiRequest("/projects/42/boards", { method: "POST", form: { name: "X", position: 1 } });
    assert.equal(calls[0]?.headers["X-Api-Key"], "abcdef_api_key");
  });
});
