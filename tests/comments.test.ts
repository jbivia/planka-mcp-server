/**
 * Deleting a comment: the lookup that has to come before the DELETE, and the
 * 403 that must not reach the agent with the generic "you are a viewer" hint.
 *
 * Comments are paged by cursor with no total, so the walk over `beforeId` is
 * pinned too — a comment on page two is as deletable as one on page one.
 */

import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it, mock } from "node:test";
import { resetConfigForTesting } from "../src/config.js";
import { PlankaError } from "../src/errors.js";
import { resetAuthForTesting } from "../src/services/auth.js";
import { deleteComment } from "../src/tools/attributes.js";

const originalEnv = { ...process.env };

/** Queue one canned answer per upstream call, in order. */
type Reply = { status: number; body: unknown };
let replies: Reply[] = [];
let calls: { url: string; method: string }[] = [];

function json(body: unknown, status = 200): Reply {
  return { status, body };
}

function page(...comments: { id: string; text: string; userId?: string }[]): Reply {
  return json({
    items: comments.map((comment) => ({ cardId: "c1", userId: "u1", ...comment })),
    included: { users: [{ id: "u1", name: "Jane Doe" }] },
  });
}

beforeEach(() => {
  replies = [];
  calls = [];
  process.env["PLANKA_BASE_URL"] = "https://planka.example.com";
  process.env["PLANKA_TOKEN"] = "abcdef_api_key";
  delete process.env["PLANKA_EMAIL"];
  delete process.env["PLANKA_PASSWORD"];
  resetConfigForTesting();
  resetAuthForTesting();

  mock.method(globalThis, "fetch", async (input: unknown, init: RequestInit = {}) => {
    calls.push({ url: String(input), method: init.method ?? "GET" });
    const reply = replies.shift() ?? json({});
    return new Response(JSON.stringify(reply.body), {
      status: reply.status,
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

describe("deleteComment", () => {
  it("deletes a comment designated by its id", async () => {
    replies.push(page({ id: "101", text: "Deployed in 2.4.1." }), page(), json({ item: { id: "101" } }));

    const deleted = await deleteComment("c1", "Fix the login redirect", "101");

    assert.equal(deleted.id, "101");
    assert.equal(deleted.author, "Jane Doe");
    assert.equal(calls.at(-1)?.method, "DELETE");
    assert.match(String(calls.at(-1)?.url), /\/comments\/101$/);
  });

  it("matches the full text regardless of case and line breaks", async () => {
    // planka_get_card prints a comment on one line; copying it back must still match.
    replies.push(page({ id: "101", text: "Deployed\n\nin 2.4.1." }), page(), json({ item: { id: "101" } }));

    const deleted = await deleteComment("c1", "Fix the login redirect", "deployed in 2.4.1.");
    assert.equal(deleted.id, "101");
  });

  it("walks the pages with beforeId to reach an older comment", async () => {
    replies.push(
      page({ id: "103", text: "Newest" }, { id: "102", text: "Middle" }),
      page({ id: "101", text: "Oldest" }),
      page(),
      json({ item: { id: "101" } }),
    );

    await deleteComment("c1", "Fix the login redirect", "101");

    assert.doesNotMatch(calls[0]?.url ?? "", /beforeId/);
    assert.match(calls[1]?.url ?? "", /beforeId=102$/);
    assert.match(calls[2]?.url ?? "", /beforeId=101$/);
    assert.match(String(calls[3]?.url), /\/comments\/101$/);
  });

  it("stops walking when the server ignores beforeId", async () => {
    // Every request gets page one back; the walk must end, and the id still resolves.
    replies.push(page({ id: "102", text: "A" }, { id: "101", text: "B" }));
    replies.push(page({ id: "102", text: "A" }, { id: "101", text: "B" }));
    replies.push(json({ item: { id: "102" } }));

    const deleted = await deleteComment("c1", "Fix the login redirect", "102");
    assert.equal(deleted.id, "102");
    assert.equal(calls.length, 3);
  });

  it("refuses an unknown comment without deleting, listing the card's comments", async () => {
    replies.push(page({ id: "101", text: "Deployed in 2.4.1." }), page());

    await assert.rejects(deleteComment("c1", "Fix the login redirect", "999999999"), (error: unknown) => {
      assert.ok(error instanceof PlankaError);
      assert.match(error.message, /not found on "Fix the login redirect"/);
      assert.match(String(error.hint), /Jane Doe: "Deployed in 2\.4\.1\." \(id 101\)/);
      return true;
    });
    assert.ok(calls.every((call) => call.method === "GET"));
  });

  it("says so when the card has no comments at all", async () => {
    replies.push(page());

    await assert.rejects(deleteComment("c1", "Fix the login redirect", "101"), (error: unknown) => {
      assert.ok(error instanceof PlankaError);
      assert.match(String(error.hint), /no comments/);
      return true;
    });
  });

  it("refuses a text shared by two comments and names both ids", async () => {
    replies.push(page({ id: "102", text: "+1" }, { id: "101", text: "+1" }), page());

    await assert.rejects(deleteComment("c1", "Fix the login redirect", "+1"), (error: unknown) => {
      assert.ok(error instanceof PlankaError);
      assert.match(error.message, /matches 2 comments/);
      assert.match(String(error.hint), /id 102/);
      assert.match(String(error.hint), /id 101/);
      return true;
    });
    assert.ok(calls.every((call) => call.method === "GET"));
  });

  it("turns the 403 into who may delete, not the viewer hint", async () => {
    replies.push(
      page({ id: "101", text: "Deployed in 2.4.1." }),
      page(),
      json({ code: "E_FORBIDDEN", message: "Not enough rights" }, 403),
    );

    await assert.rejects(deleteComment("c1", "Fix the login redirect", "101"), (error: unknown) => {
      assert.ok(error instanceof PlankaError);
      assert.equal(error.status, 403);
      assert.match(error.message, /Jane Doe's comment/);
      assert.match(String(error.hint), /author/);
      assert.match(String(error.hint), /manager of the project/);
      assert.doesNotMatch(String(error.hint), /viewer/);
      return true;
    });
  });
});
