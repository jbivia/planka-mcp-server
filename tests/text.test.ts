/**
 * Long descriptions: appending, search-and-replace edits, and paged reading.
 *
 * These are what let an agent grow or fix a long text without sending it back
 * whole, and read one without losing its end — so the refusals matter as much
 * as the happy paths: an edit that cannot be placed exactly must change nothing.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { DESCRIPTION_MAX_LENGTH } from "../src/constants.js";
import { PlankaError } from "../src/errors.js";
import { appendParagraph, applyEdits, checkDescriptionLength, pageOfText } from "../src/services/text.js";

describe("appendParagraph", () => {
  it("adds the text as a new paragraph", () => {
    assert.equal(appendParagraph("Chapter one.", "Chapter two."), "Chapter one.\n\nChapter two.");
  });

  it("does not stack blank lines when the text already ends with some", () => {
    assert.equal(appendParagraph("Chapter one.\n\n\n", "Chapter two."), "Chapter one.\n\nChapter two.");
  });

  it("starts an empty description with the text alone", () => {
    assert.equal(appendParagraph("", "First words."), "First words.");
    assert.equal(appendParagraph("  \n", "First words."), "First words.");
  });
});

describe("applyEdits", () => {
  const text = "Marie regardait le port. La nuit tombait.\n\nLes bateaux rentraient.";

  it("replaces a passage found exactly once", () => {
    assert.equal(
      applyEdits(text, [{ find: "Marie regardait", replace: "Jeanne observait" }]),
      "Jeanne observait le port. La nuit tombait.\n\nLes bateaux rentraient.",
    );
  });

  it("deletes a passage when the replacement is empty", () => {
    assert.equal(applyEdits(text, [{ find: " La nuit tombait.", replace: "" }]), text.replace(" La nuit tombait.", ""));
  });

  it("matches across line breaks, verbatim", () => {
    assert.equal(
      applyEdits(text, [{ find: "tombait.\n\nLes", replace: "tombait. Les" }]),
      "Marie regardait le port. La nuit tombait. Les bateaux rentraient.",
    );
  });

  it("applies edits in order, each on the result of the previous one", () => {
    assert.equal(
      applyEdits("a b c", [
        { find: "a", replace: "x" },
        { find: "x b", replace: "y" },
      ]),
      "y c",
    );
  });

  it("treats replacement text literally, with no $-patterns", () => {
    assert.equal(applyEdits("price: X", [{ find: "X", replace: "$& $1 $$" }]), "price: $& $1 $$");
  });

  it("refuses a passage that does not occur", () => {
    assert.throws(
      () => applyEdits(text, [{ find: "Pierre", replace: "Paul" }]),
      (error: unknown) => error instanceof PlankaError && /does not occur/.test(error.message),
    );
  });

  it("refuses a passage that occurs twice, rather than guessing", () => {
    assert.throws(
      () => applyEdits("le port, le port", [{ find: "le port", replace: "la mer" }]),
      (error: unknown) => error instanceof PlankaError && /more than once/.test(error.message),
    );
  });

  it("counts overlapping occurrences as ambiguous too", () => {
    assert.throws(() => applyEdits("aaa", [{ find: "aa", replace: "b" }]), /more than once/);
  });

  it("is all or nothing, and says which edit failed", () => {
    assert.throws(
      () =>
        applyEdits(text, [
          { find: "Marie", replace: "Jeanne" },
          { find: "absent", replace: "x" },
        ]),
      (error: unknown) => error instanceof PlankaError && /Edit 2 of 2/.test(error.message),
    );
  });
});

describe("checkDescriptionLength", () => {
  it("accepts Planka's maximum and refuses one character more", () => {
    assert.doesNotThrow(() => checkDescriptionLength("x".repeat(DESCRIPTION_MAX_LENGTH)));
    assert.throws(() => checkDescriptionLength("x".repeat(DESCRIPTION_MAX_LENGTH + 1)), PlankaError);
  });
});

describe("pageOfText", () => {
  it("returns a short text whole", () => {
    assert.deepEqual(pageOfText("short", 0, 100), { text: "short", start: 0, end: 5, total: 5 });
  });

  it("ends a page on a line break near the limit", () => {
    const text = `${"a".repeat(90)}\n${"b".repeat(50)}`;
    const page = pageOfText(text, 0, 100);
    assert.equal(page.end, 91);
    assert.ok(page.text.endsWith("\n"));
  });

  it("falls back to a space, never cutting a word", () => {
    const text = `${"word ".repeat(30)}`;
    const page = pageOfText(text, 0, 23);
    assert.ok(page.text.endsWith(" "));
    assert.ok(page.text.length <= 23);
  });

  it("cuts hard when there is no break in the last fifth of the page", () => {
    const page = pageOfText("x".repeat(500), 0, 100);
    assert.equal(page.end, 100);
  });

  it("covers the whole text, page after page, with nothing lost or repeated", () => {
    const text = Array.from({ length: 400 }, (_, index) => `Line ${index} of the chapter.`).join("\n");
    let offset = 0;
    let rebuilt = "";
    while (offset < text.length) {
      const page = pageOfText(text, offset, 1_000);
      assert.equal(page.start, offset);
      rebuilt += page.text;
      offset = page.end;
    }
    assert.equal(rebuilt, text);
  });

  it("never splits a surrogate pair", () => {
    const text = `${"x".repeat(99)}😀${"y".repeat(50)}`;
    const page = pageOfText(text, 0, 100);
    assert.equal(page.end, 99);
    assert.equal(pageOfText(text, page.end, 100).text.startsWith("😀"), true);
  });

  it("refuses an offset past the end", () => {
    assert.throws(() => pageOfText("abc", 3, 10), /past the end/);
    assert.throws(() => pageOfText("abc", 10, 10), /past the end/);
  });
});
