/**
 * What the card tools send to Planka, end to end through an MCP client.
 *
 * The board read carries every card with its full description, so on a board
 * holding long texts it weighs as much as all of them together. These tests pin
 * that a write never pays for it, that the cache still reflects the write, and
 * that a long description can be grown, edited and read without being sent or
 * received whole.
 */

import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import { CHARACTER_LIMIT } from "../src/constants.js";
import { startFakePlanka, type FakePlanka } from "./fixtures/planka.js";

let planka: FakePlanka;

beforeEach(async () => {
  planka = await startFakePlanka();
});

afterEach(async () => {
  await planka.close();
});

/** The requests made since the last call to this, as "METHOD /path". */
function requests(): string[] {
  const made = planka.calls.map((call) => `${call.method} ${call.path}`);
  planka.calls.length = 0;
  return made;
}

async function warmCache(): Promise<void> {
  await planka.call("planka_describe_board", { board: "Roadmap" });
  requests();
}

describe("card writes and the board cache", () => {
  it("updates a card with one PATCH when the board is cached", async () => {
    await warmCache();
    const result = await planka.call("planka_update_card", {
      card: "Fix the login redirect",
      board: "Roadmap",
      name: "Fix the SSO redirect",
    });

    assert.equal(result.isError, false, result.text);
    assert.deepEqual(requests(), ["PATCH /cards/card-login"]);
    assert.match(result.text, /Fix the SSO redirect/);
  });

  it("folds the write into the cache, so the next read sees it without re-reading the board", async () => {
    await warmCache();
    await planka.call("planka_update_card", { card: "Fix the login redirect", board: "Roadmap", name: "Renamed" });
    requests();

    const search = await planka.call("planka_search_cards", { board: "Roadmap", text: "renamed" });
    assert.match(search.text, /\*\*Renamed\*\*/);
    assert.deepEqual(requests(), []);
  });

  it("keeps list counts right after a move, from the cache alone", async () => {
    await warmCache();
    const moved = await planka.call("planka_move_card", {
      card: "Rotate the TLS cert",
      board: "Roadmap",
      list: "En cours",
      position: "top",
    });
    assert.equal(moved.isError, false, moved.text);
    assert.match(moved.text, /Now at rank 1 of 2/);
    assert.deepEqual(requests(), ["PATCH /cards/card-cert"]);

    const board = await planka.call("planka_describe_board", { board: "Roadmap" });
    assert.match(board.text, /\*\*Backlog\*\* — 1 card /);
    assert.match(board.text, /\*\*En cours\*\* — 2 cards/);
    assert.deepEqual(requests(), []);
  });

  it("drops an archived card from the cached board", async () => {
    await warmCache();
    await planka.call("planka_archive_card", { card: "Rotate the TLS cert", board: "Roadmap" });
    requests();

    const search = await planka.call("planka_search_cards", { board: "Roadmap" });
    assert.doesNotMatch(search.text, /Rotate the TLS cert/);
    assert.deepEqual(requests(), []);
  });

  it("drops a deleted card from the cached board", async () => {
    await warmCache();
    await planka.call("planka_delete_card", {
      card: "Rotate the TLS cert",
      board: "Roadmap",
      confirm_name: "Rotate the TLS cert",
    });
    assert.deepEqual(requests(), ["DELETE /cards/card-cert"]);

    const search = await planka.call("planka_search_cards", { board: "Roadmap" });
    assert.doesNotMatch(search.text, /Rotate the TLS cert/);
  });

  it("adds a created card to the cached board", async () => {
    await warmCache();
    const created = await planka.call("planka_create_card", { board: "Roadmap", list: "Done", name: "Write the docs" });
    assert.equal(created.isError, false, created.text);
    assert.equal(requests().length, 1);

    const search = await planka.call("planka_search_cards", { board: "Roadmap", list: "Done" });
    assert.match(search.text, /Write the docs/);
    assert.deepEqual(requests(), []);
  });
});

describe("names the cached board does not know yet", () => {
  it("re-reads the board once to find a card created meanwhile in the Planka UI", async () => {
    await warmCache();
    planka.included.cards.push({
      id: "card-new",
      boardId: "1357158568008091000",
      listId: "list-backlog",
      name: "Created in the UI",
      position: 1_000_000,
      commentsTotal: 0,
    });

    const result = await planka.call("planka_update_card", {
      card: "Created in the UI",
      board: "Roadmap",
      name: "Found it",
    });
    assert.equal(result.isError, false, result.text);
    assert.deepEqual(requests(), ["GET /boards/1357158568008091000", "PATCH /cards/card-new"]);
  });

  it("does not re-read a board it has just read to report a typo", async () => {
    const result = await planka.call("planka_update_card", { card: "No such card", board: "Roadmap", name: "x" });
    assert.equal(result.isError, true);
    assert.equal(requests().filter((request) => request.startsWith("GET /boards/")).length, 1);
  });
});

describe("planka_create_card", () => {
  it("leaves out an empty description, which Planka would refuse", async () => {
    await planka.call("planka_create_card", { board: "Roadmap", list: "Backlog", name: "Blank", description: "" });
    const post = planka.calls.find((call) => call.method === "POST");
    assert.ok(post);
    assert.equal("description" in (post.body ?? {}), false);
  });
});

describe("planka_update_card: long descriptions", () => {
  it("appends to the text Planka holds, reading the card rather than the board", async () => {
    await warmCache();
    const result = await planka.call("planka_update_card", {
      card: "Fix the login redirect",
      board: "Roadmap",
      append_description: "Second paragraph.",
    });

    assert.equal(result.isError, false, result.text);
    assert.deepEqual(requests(), ["GET /cards/card-login", "PATCH /cards/card-login"]);
    assert.equal(
      planka.card("card-login").description,
      "SSO bounces back to /login after a successful assertion.\n\nSecond paragraph.",
    );
    assert.match(result.text, /Description: 75 characters \(was 56\)/);
  });

  it("starts from Planka's current text, not the cached copy", async () => {
    await warmCache();
    // Someone edits the card in the Planka UI after the board was cached.
    planka.card("card-login").description = "Edited in the UI.";

    await planka.call("planka_update_card", { card: "Fix the login redirect", board: "Roadmap", append_description: "More." });
    assert.equal(planka.card("card-login").description, "Edited in the UI.\n\nMore.");
  });

  it("applies search-and-replace edits to the stored text", async () => {
    const result = await planka.call("planka_update_card", {
      card: "Fix the login redirect",
      board: "Roadmap",
      description_edits: [
        { find: "SSO", replace: "The SAML flow" },
        { find: " after a successful assertion", replace: "" },
      ],
    });

    assert.equal(result.isError, false, result.text);
    assert.equal(planka.card("card-login").description, "The SAML flow bounces back to /login.");
  });

  it("sends nothing when an edit cannot be placed", async () => {
    const result = await planka.call("planka_update_card", {
      card: "Fix the login redirect",
      board: "Roadmap",
      description_edits: [{ find: "SSO", replace: "x" }, { find: "no such passage", replace: "y" }],
    });

    assert.equal(result.isError, true);
    assert.match(result.text, /Edit 2 of 2 was not applied/);
    assert.ok(planka.calls.every((call) => call.method === "GET"));
    assert.equal(planka.card("card-login").description, "SSO bounces back to /login after a successful assertion.");
  });

  it("clears the description when the edits leave nothing", async () => {
    await planka.call("planka_update_card", {
      card: "Fix the login redirect",
      board: "Roadmap",
      description_edits: [{ find: "SSO bounces back to /login after a successful assertion.", replace: "" }],
    });
    assert.equal(planka.card("card-login").description, null);
  });

  it("refuses to combine two ways of changing the description", async () => {
    const result = await planka.call("planka_update_card", {
      card: "Fix the login redirect",
      board: "Roadmap",
      description: "New text.",
      append_description: "More.",
    });
    assert.equal(result.isError, true);
    assert.match(result.text, /cannot be combined/);
    assert.deepEqual(planka.calls, []);
  });
});

describe("planka_get_card: long descriptions", () => {
  it("serves a description too long for one reply in pages, losing nothing", async () => {
    const chapter = Array.from({ length: 2_500 }, (_, index) => `Sentence ${index} of the chapter.`).join(" ");
    planka.card("card-login").description = `${chapter} THE-END`;
    assert.ok(chapter.length > 2 * CHARACTER_LIMIT);

    const first = await planka.call("planka_get_card", { card: "Fix the login redirect", board: "Roadmap" });
    assert.ok(first.text.length <= CHARACTER_LIMIT);
    assert.doesNotMatch(first.text, /THE-END/);
    assert.doesNotMatch(first.text, /truncated/);
    // The rest of the card is still there, after the first page of text.
    assert.match(first.text, /## Tasks/);

    let rebuilt = (first.structured as { description: string }).description;
    let next = (first.structured as { description_next_offset?: number }).description_next_offset;
    let pages = 1;
    while (next !== undefined) {
      const page = await planka.call("planka_get_card", {
        card: "Fix the login redirect",
        board: "Roadmap",
        description_offset: next,
      });
      assert.equal(page.isError, false, page.text);
      assert.ok(page.text.length <= CHARACTER_LIMIT);
      assert.doesNotMatch(page.text, /## Tasks/);
      const payload = page.structured as { description: string; description_next_offset?: number };
      rebuilt += payload.description;
      next = payload.description_next_offset;
      pages += 1;
    }

    assert.ok(pages >= 3);
    assert.equal(rebuilt, planka.card("card-login").description);
  });

  it("keeps JSON replies within the limit too, first page and later ones", async () => {
    planka.card("card-login").description = '"quoted"\n'.repeat(10_000);
    let offset = 0;
    let pages = 0;
    do {
      const result = await planka.call("planka_get_card", {
        card: "Fix the login redirect",
        board: "Roadmap",
        response_format: "json",
        description_offset: offset,
      });
      assert.ok(result.text.length <= CHARACTER_LIMIT, `page ${pages + 1} is ${result.text.length} long`);
      offset = (JSON.parse(result.text) as { description_next_offset?: number }).description_next_offset ?? 0;
      pages += 1;
    } while (offset > 0);
    assert.ok(pages >= 3);
  });

  it("returns a short description whole, with no paging fields", async () => {
    const result = await planka.call("planka_get_card", { card: "Fix the login redirect", board: "Roadmap" });
    assert.match(result.text, /SSO bounces back/);
    assert.equal((result.structured as { description_next_offset?: number }).description_next_offset, undefined);
    assert.doesNotMatch(result.text, /description_offset/);
  });
});

describe("planka_move_card: neighbours", () => {
  it("refuses a neighbour that sits in another list instead of silently appending", async () => {
    const result = await planka.call("planka_move_card", {
      card: "Fix the login redirect",
      board: "Roadmap",
      list: "En cours",
      position: { after: "Rotate the TLS cert" },
    });
    assert.equal(result.isError, true);
    assert.match(result.text, /in list "En cours"/);
    assert.ok(planka.calls.every((call) => call.method === "GET"));
  });

  it("places the card after a neighbour of the target list", async () => {
    const result = await planka.call("planka_move_card", {
      card: "Fix the login redirect",
      board: "Roadmap",
      list: "En cours",
      position: { after: "Ship the metrics endpoint" },
    });
    assert.equal(result.isError, false, result.text);
    assert.match(result.text, /Now at rank 2 of 2/);
    assert.ok((planka.card("card-login").position ?? 0) > 65_536);
  });
});

describe("locating a card by id without a board", () => {
  const CARD_ID = "1357158568008099999";

  beforeEach(() => {
    planka.included.cards.push({
      id: CARD_ID,
      boardId: "1357158568008091000",
      listId: "list-doing",
      name: "Card known by id",
      position: 131072,
      commentsTotal: 0,
    });
  });

  it("asks the card route for its board instead of scanning every board", async () => {
    const result = await planka.call("planka_update_card", { card: CARD_ID, name: "Renamed by id" });
    assert.equal(result.isError, false, result.text);
    assert.deepEqual(requests(), [
      `GET /cards/${CARD_ID}`,
      "GET /boards/1357158568008091000",
      `PATCH /cards/${CARD_ID}`,
    ]);
  });

  it("needs no request at all to find it once its board is cached", async () => {
    await warmCache();
    await planka.call("planka_update_card", { card: CARD_ID, name: "Renamed by id" });
    assert.deepEqual(requests(), [`PATCH /cards/${CARD_ID}`]);
  });

  it("says plainly that an archived card is out of reach", async () => {
    planka.card(CARD_ID).listId = "list-archive";
    const result = await planka.call("planka_get_card", { card: CARD_ID });
    assert.equal(result.isError, true);
    assert.match(result.text, /is in the archive of board "Roadmap"/);
  });
});
