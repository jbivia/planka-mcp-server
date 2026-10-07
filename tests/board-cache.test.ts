/**
 * The board cache under concurrency.
 *
 * A scan now reads several boards at once, so two calls can ask for the same
 * board in the same instant, and a write can land while a read is in flight.
 * The first must cost one request; the second must not leave the pre-write
 * board cached as if it were current.
 */

import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it, mock } from "node:test";
import { resetConfigForTesting } from "../src/config.js";
import { resetAuthForTesting } from "../src/services/auth.js";
import {
  getBoardSnapshot,
  getBoardSnapshots,
  invalidateBoard,
  resetCacheForTesting,
  storeCard,
} from "../src/services/board-cache.js";
import { BOARD_ID, boardResponse } from "./fixtures/board.js";

let boardReads = 0;
/** Lets a test hold a board read in flight until it says so. */
let gate: Promise<void> | undefined;

beforeEach(() => {
  boardReads = 0;
  gate = undefined;
  process.env["PLANKA_BASE_URL"] = "https://planka.example.com";
  process.env["PLANKA_TOKEN"] = "abcdef_api_key";
  resetConfigForTesting();
  resetAuthForTesting();
  resetCacheForTesting();

  mock.method(globalThis, "fetch", async (input: unknown) => {
    const path = new URL(String(input)).pathname;
    boardReads += 1;
    const id = path.split("/").at(-1);
    const payload = structuredClone(boardResponse);
    payload.item.id = id as string;
    if (gate) await gate;
    return new Response(JSON.stringify(payload), { status: 200, headers: { "Content-Type": "application/json" } });
  });
});

afterEach(() => {
  mock.restoreAll();
  resetConfigForTesting();
  resetAuthForTesting();
  resetCacheForTesting();
});

describe("board cache", () => {
  it("serves concurrent reads of one board with a single request", async () => {
    const [a, b] = await Promise.all([getBoardSnapshot(BOARD_ID), getBoardSnapshot(BOARD_ID)]);
    assert.equal(boardReads, 1);
    assert.equal(a, b);
  });

  it("reads several boards in the order asked, each once", async () => {
    const snapshots = await getBoardSnapshots(["b1", "b2", "b3", "b1", "b4", "b5"]);
    assert.deepEqual(
      snapshots.map((snapshot) => snapshot.id),
      ["b1", "b2", "b3", "b1", "b4", "b5"],
    );
    assert.equal(boardReads, 5);
  });

  it("folds a written card into the cached board without a request", async () => {
    await getBoardSnapshot(BOARD_ID);
    const card = boardResponse.included?.cards?.[0];
    assert.ok(card);

    const updated = storeCard(BOARD_ID, { ...card, name: "Renamed" });
    assert.equal(updated?.cards.find((candidate) => candidate.id === card.id)?.name, "Renamed");
    assert.equal((await getBoardSnapshot(BOARD_ID)).cards.find((c) => c.id === card.id)?.name, "Renamed");
    assert.equal(boardReads, 1);
  });

  it("keeps the board's age when a card is folded in", async () => {
    const before = await getBoardSnapshot(BOARD_ID);
    const card = boardResponse.included?.cards?.[0];
    assert.ok(card);
    assert.equal(storeCard(BOARD_ID, card)?.fetchedAt, before.fetchedAt);
  });

  it("does not cache a read that was in flight when a write landed", async () => {
    await getBoardSnapshot(BOARD_ID);
    invalidateBoard(BOARD_ID);

    let open: () => void = () => undefined;
    gate = new Promise<void>((resolve) => {
      open = resolve;
    });
    const inFlight = getBoardSnapshot(BOARD_ID);
    // A write lands while the read is still waiting on Planka.
    const card = boardResponse.included?.cards?.[0];
    assert.ok(card);
    storeCard(BOARD_ID, { ...card, name: "Written meanwhile" });
    open();
    await inFlight;
    gate = undefined;

    await getBoardSnapshot(BOARD_ID);
    assert.equal(boardReads, 3, "the board must be read again rather than served from the stale read");
  });
});
