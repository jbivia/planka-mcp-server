/**
 * Position arithmetic.
 *
 * These are the numbers that decide where a moved card lands, and Planka
 * documents none of the rules — so every case that the move tool can produce is
 * pinned here.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { POSITION_STEP } from "../src/constants.js";
import { appendPosition, resolvePosition, sortByPosition } from "../src/services/position.js";

const siblings = [
  { id: "a", position: 100 },
  { id: "b", position: 200 },
  { id: "c", position: 300 },
];

describe("sortByPosition", () => {
  it("orders by position", () => {
    const shuffled = [siblings[2], siblings[0], siblings[1]] as typeof siblings;
    assert.deepEqual(sortByPosition(shuffled).map((item) => item.id), ["a", "b", "c"]);
  });

  it("puts a null position last and breaks ties by id, so the order is stable", () => {
    const items = [
      { id: "z", position: null },
      { id: "m", position: 100 },
      { id: "d", position: 100 },
    ];
    assert.deepEqual(sortByPosition(items).map((item) => item.id), ["d", "m", "z"]);
  });
});

describe("resolvePosition", () => {
  it("places at the top by halving the current head", () => {
    const result = resolvePosition(siblings, { kind: "top" });
    assert.equal(result.position, 50);
    assert.equal(result.index, 0);
    assert.ok(result.position < 100, "must sort strictly before the first card");
  });

  it("places at the bottom one step past the tail", () => {
    const result = resolvePosition(siblings, { kind: "bottom" });
    assert.equal(result.position, 300 + POSITION_STEP);
    assert.equal(result.index, 3);
  });

  it("averages the neighbours for an index in the middle", () => {
    const result = resolvePosition(siblings, { kind: "index", index: 1 });
    assert.equal(result.position, 150);
    assert.ok(result.position > 100 && result.position < 200);
  });

  it("places before a named sibling", () => {
    const result = resolvePosition(siblings, { kind: "before", siblingId: "b" });
    assert.equal(result.index, 1);
    assert.equal(result.position, 150);
  });

  it("places after a named sibling", () => {
    const result = resolvePosition(siblings, { kind: "after", siblingId: "b" });
    assert.equal(result.index, 2);
    assert.equal(result.position, 250);
  });

  it("seeds an empty list with the documented step", () => {
    const result = resolvePosition([], { kind: "bottom" });
    assert.equal(result.position, POSITION_STEP);
    assert.equal(result.index, 0);
  });

  it("handles a single-card list at both ends", () => {
    const one = [{ id: "only", position: 500 }];
    assert.equal(resolvePosition(one, { kind: "top" }).position, 250);
    assert.equal(resolvePosition(one, { kind: "bottom" }).position, 500 + POSITION_STEP);
  });

  it("excludes the moving card, so a reorder measures against the others", () => {
    // Without the exclusion, moving "b" to the top would compare against itself
    // and land at 100/2 instead of in front of "a".
    const result = resolvePosition(siblings, { kind: "index", index: 1 }, "b");
    assert.equal(result.position, 200);
    assert.equal(result.index, 1);
  });

  it("clamps an index past the end instead of failing", () => {
    const result = resolvePosition(siblings, { kind: "index", index: 99 });
    assert.equal(result.index, 3);
    assert.equal(result.position, 300 + POSITION_STEP);
  });

  it("falls back to the end when the named sibling is gone", () => {
    // The neighbour may have been moved by someone else between the read and
    // the write; appending is better than throwing away the whole move.
    const result = resolvePosition(siblings, { kind: "after", siblingId: "ghost" });
    assert.equal(result.index, 3);
  });

  it("appendPosition matches an explicit bottom placement", () => {
    assert.equal(appendPosition(siblings), resolvePosition(siblings, { kind: "bottom" }).position);
  });
});
