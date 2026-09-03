/**
 * Sharing: the two upstream answers that must not reach the agent raw.
 *
 * A 409 means the person already has the access asked for — the desired end
 * state, so it is absorbed. A 403 on `project-managers` does not mean the
 * account lacks rights in general; it means Planka refuses a second manager on
 * a personal project, and the reply has to say so or the agent will retry with
 * the same arguments forever.
 *
 * `resolveUser` is pinned here too: it is the only resolver that reaches
 * outside a board, and its id path exists so that an account without the
 * user-listing permission can still share.
 */

import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it, mock } from "node:test";
import { resetConfigForTesting } from "../src/config.js";
import { PlankaError } from "../src/errors.js";
import { resetAuthForTesting } from "../src/services/auth.js";
import { invalidateUsers, resolveUser } from "../src/services/users.js";
import { addBoardMember, addManager } from "../src/tools/sharing.js";

const originalEnv = { ...process.env };

/** Queue one canned answer per upstream call, in order. */
type Reply = { status: number; body: unknown };
let replies: Reply[] = [];
let calls: { url: string; method: string; body: unknown }[] = [];

function json(body: unknown, status = 200): Reply {
  return { status, body };
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
  invalidateUsers();

  mock.method(globalThis, "fetch", async (input: unknown, init: RequestInit = {}) => {
    calls.push({
      url: String(input),
      method: init.method ?? "GET",
      body: typeof init.body === "string" ? JSON.parse(init.body) : init.body,
    });
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
  invalidateUsers();
});

describe("addManager", () => {
  it("posts the user id and reports the share", async () => {
    replies.push(json({ item: { id: "pm1", projectId: "p1", userId: "u1" } }));
    assert.equal(await addManager("p1", "u1", "Infra"), "shared");
    assert.equal(calls[0]?.method, "POST");
    assert.match(String(calls[0]?.url), /\/projects\/p1\/project-managers$/);
    assert.deepEqual(calls[0]?.body, { userId: "u1" });
  });

  it("absorbs a 409 as an existing manager rather than failing", async () => {
    replies.push(json({ code: "E_CONFLICT", message: "User already project manager" }, 409));
    assert.equal(await addManager("p1", "u1", "Infra"), "already");
  });

  it("turns the personal-project 403 into the reason and the way out", async () => {
    replies.push(json({ code: "E_FORBIDDEN", message: "Not enough rights" }, 403));
    try {
      await addManager("p1", "u1", "Infra");
      assert.fail("expected a throw");
    } catch (error) {
      assert.ok(error instanceof PlankaError);
      assert.equal(error.status, 403);
      assert.match(error.message, /"Infra"/);
      // The two escapes have to be named, or the agent retries identically.
      assert.match(String(error.hint), /role="editor"/);
      assert.match(String(error.hint), /visibility="shared"/);
    }
  });

  it("lets an unrelated failure through untouched", async () => {
    replies.push(json({ code: "E_NOT_FOUND" }, 404));
    await assert.rejects(addManager("p1", "u1", "Infra"), (error: unknown) => {
      assert.ok(error instanceof PlankaError);
      assert.equal(error.status, 404);
      return true;
    });
  });
});

describe("addBoardMember", () => {
  it("sends the role, and no canComment for an editor", async () => {
    replies.push(json({ item: { id: "bm1" } }));
    assert.equal(await addBoardMember("b1", "u1", "editor", true), "shared");
    assert.match(String(calls[0]?.url), /\/boards\/b1\/board-memberships$/);
    // Planka only reads canComment for viewers; sending it for an editor would
    // suggest it does something.
    assert.deepEqual(calls[0]?.body, { userId: "u1", role: "editor" });
  });

  it("sends canComment for a viewer that asked for it", async () => {
    replies.push(json({ item: { id: "bm1" } }));
    await addBoardMember("b1", "u1", "viewer", true);
    assert.deepEqual(calls[0]?.body, { userId: "u1", role: "viewer", canComment: true });
  });

  it("omits canComment when it was not set", async () => {
    replies.push(json({ item: { id: "bm1" } }));
    await addBoardMember("b1", "u1", "viewer", undefined);
    assert.deepEqual(calls[0]?.body, { userId: "u1", role: "viewer" });
  });

  it("absorbs a 409 as an existing member", async () => {
    replies.push(json({ code: "E_CONFLICT", message: "User already board member" }, 409));
    assert.equal(await addBoardMember("b1", "u1", "editor", undefined), "already");
  });
});

describe("resolveUser", () => {
  const listing = {
    items: [
      { id: "1856064038916588545", name: "Jérôme", username: "jerome", email: "j@example.com" },
      { id: "1856090887587628037", name: "Claude", username: "claude", email: "c@example.com" },
      { id: "1856090887587628099", name: "Ghost", username: "ghost", isDeactivated: true },
    ],
  };

  it("fetches an id directly, without the listing route", async () => {
    replies.push(json({ item: { id: "1856064038916588545", name: "Jérôme", username: "jerome" } }));
    const user = await resolveUser("1856064038916588545");
    assert.equal(user.username, "jerome");
    // The point of this path: it works on an account that may not list users.
    assert.equal(calls.length, 1);
    assert.match(String(calls[0]?.url), /\/users\/1856064038916588545$/);
  });

  it("falls back to the listing when an id-shaped reference is a 404", async () => {
    replies.push(json({ code: "E_NOT_FOUND" }, 404), json(listing));
    const user = await resolveUser("1856064038916588545");
    assert.equal(user.name, "Jérôme");
    assert.equal(calls.length, 2);
  });

  it("matches a username", async () => {
    replies.push(json(listing));
    assert.equal((await resolveUser("jerome")).id, "1856064038916588545");
  });

  it("matches an email, case-insensitively", async () => {
    replies.push(json(listing));
    assert.equal((await resolveUser("C@Example.com")).username, "claude");
  });

  it("matches a display name with its accents", async () => {
    replies.push(json(listing));
    assert.equal((await resolveUser("Jérôme")).username, "jerome");
  });

  it("hides deactivated accounts, and says what does exist", async () => {
    replies.push(json(listing));
    try {
      await resolveUser("ghost");
      assert.fail("expected a throw");
    } catch (error) {
      assert.ok(error instanceof PlankaError);
      assert.match(error.message, /"Jérôme"/);
      assert.doesNotMatch(error.message, /Ghost/);
    }
  });

  it("explains the missing role when the instance refuses the listing", async () => {
    replies.push(json({ code: "E_FORBIDDEN" }, 403));
    try {
      await resolveUser("jerome");
      assert.fail("expected a throw");
    } catch (error) {
      assert.ok(error instanceof PlankaError);
      assert.equal(error.status, 403);
      assert.match(String(error.hint), /admin or project owner/);
      // Passing an id is the way out for an account that cannot list.
      assert.match(String(error.hint), /id/);
    }
  });
});
