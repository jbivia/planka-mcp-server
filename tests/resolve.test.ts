/**
 * Name resolution.
 *
 * This is the layer that lets an agent say "En cours" instead of
 * "1357158568008091266", so the cases that matter are the failures: an
 * ambiguous name must not be guessed, and a miss must name what does exist.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { PlankaError } from "../src/errors.js";
import { projectBoard } from "../src/services/project.js";
import {
  looksLikeId,
  resolveCard,
  resolveLabel,
  resolveList,
  resolveMember,
  resolveNamed,
} from "../src/services/resolve.js";
import { boardResponse } from "./fixtures/board.js";

const snapshot = projectBoard(boardResponse.item, boardResponse.included);

/** Assert that a call throws a PlankaError whose text contains each fragment. */
function assertErrorContains(call: () => unknown, ...fragments: string[]): void {
  try {
    call();
    assert.fail("expected the call to throw");
  } catch (error) {
    assert.ok(error instanceof PlankaError, `expected a PlankaError, got ${String(error)}`);
    const text = `${error.message} ${error.hint ?? ""}`;
    for (const fragment of fragments) {
      assert.ok(text.includes(fragment), `expected "${text}" to contain "${fragment}"`);
    }
  }
}

describe("looksLikeId", () => {
  it("recognises a Planka snowflake id", () => {
    assert.equal(looksLikeId("1357158568008091264"), true);
  });

  it("does not mistake a short number or a name for an id", () => {
    assert.equal(looksLikeId("42"), false);
    assert.equal(looksLikeId("Sprint 42"), false);
  });
});

describe("resolveNamed", () => {
  const candidates = [
    { id: "1", name: "Done" },
    { id: "2", name: "Not Done" },
    { id: "3", name: "Backlog" },
  ];

  it("matches an id exactly", () => {
    assert.equal(resolveNamed(candidates, "2", "List", "here", "recover").name, "Not Done");
  });

  it("matches a name case-insensitively", () => {
    assert.equal(resolveNamed(candidates, "bAcKlOg", "List", "here", "recover").id, "3");
  });

  it("prefers an exact name over a substring match", () => {
    // "Done" is contained in "Not Done"; strict-first ordering is what keeps
    // this from being reported as an ambiguity.
    assert.equal(resolveNamed(candidates, "Done", "List", "here", "recover").id, "1");
  });

  it("matches a unique prefix", () => {
    assert.equal(resolveNamed(candidates, "Back", "List", "here", "recover").id, "3");
  });

  it("refuses to guess between two matches and names them", () => {
    const ambiguous = [
      { id: "1", name: "Review — backend" },
      { id: "2", name: "Review — frontend" },
    ];
    assertErrorContains(
      () => resolveNamed(ambiguous, "Review", "List", "on board X", "recover"),
      "ambiguous",
      "Review — backend",
      "Review — frontend",
    );
  });

  it("lists the candidates when nothing matches", () => {
    assertErrorContains(
      () => resolveNamed(candidates, "Doing", "List", "on board X", "call planka_describe_board"),
      'List "Doing" not found on board X',
      '"Done", "Not Done", "Backlog"',
      "call planka_describe_board",
    );
  });

  it("reports an unmatched id as a stale id, not a missing name", () => {
    assertErrorContains(
      () => resolveNamed(candidates, "1357158568008091264", "List", "on board X", "recover"),
      "No List with id 1357158568008091264",
    );
  });

  it("rejects an empty reference", () => {
    assertErrorContains(() => resolveNamed(candidates, "   ", "List", "on board X", "recover"), "Empty");
  });
});

describe("resolveList", () => {
  it("resolves an active list by name", () => {
    assert.equal(resolveList(snapshot, "En cours").id, "list-doing");
  });

  it("resolves a closed list, which is still a legitimate move target", () => {
    assert.equal(resolveList(snapshot, "Done").type, "closed");
  });

  it("hides the archive and trash lists by default", () => {
    // Offering them would let an agent archive a card while believing it filed it.
    assertErrorContains(() => resolveList(snapshot, "(archive)"), "not found");
  });

  it("exposes the system lists when explicitly asked", () => {
    assert.equal(resolveList(snapshot, "(archive)", { includeSystem: true }).type, "archive");
  });

  it("absorbs a truncated name through the prefix pass", () => {
    assert.equal(resolveList(snapshot, "En cour").id, "list-doing");
  });

  it("names the board's lists when the name matches nothing", () => {
    assertErrorContains(
      () => resolveList(snapshot, "Terminé"),
      'on board "Roadmap"',
      '"Backlog", "En cours", "Done"',
      "planka_describe_board",
    );
  });
});

describe("resolveLabel", () => {
  it("resolves by name", () => {
    assert.equal(resolveLabel(snapshot, "bug").id, "label-bug");
  });

  it("resolves a nameless label by its colour", () => {
    assert.equal(resolveLabel(snapshot, "lagoon-blue").id, "label-nameless");
  });

  it("explains that labels belong to a board", () => {
    assertErrorContains(() => resolveLabel(snapshot, "blocked"), "Labels belong to a board");
  });
});

describe("resolveMember", () => {
  it("resolves by display name", () => {
    assert.equal(resolveMember(snapshot, "Jane Doe").id, "user-jane");
  });

  it("resolves by username", () => {
    assert.equal(resolveMember(snapshot, "jdoe").id, "user-jane");
  });

  it("resolves by id", () => {
    assert.equal(resolveMember(snapshot, "user-john").name, "John Roe");
  });

  it("names the board's members when the person is not one", () => {
    assertErrorContains(
      () => resolveMember(snapshot, "Somebody Else"),
      '"Jane Doe", "John Roe"',
      "Only board members",
    );
  });
});

describe("resolveCard", () => {
  it("resolves by title", () => {
    assert.equal(resolveCard(snapshot, "Fix the login redirect").id, "card-login");
  });

  it("does not resolve an archived card", () => {
    assertErrorContains(() => resolveCard(snapshot, "Old thing"), "not found");
  });

  it("points at the search tool when the title is wrong", () => {
    assertErrorContains(() => resolveCard(snapshot, "Nope"), "planka_search_cards");
  });
});
