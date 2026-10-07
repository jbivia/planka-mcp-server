/**
 * Long card descriptions.
 *
 * A description can run to Planka's 1 MiB cap — a chapter, a spec, a runbook.
 * Making an agent re-send the whole text to change a paragraph is what makes
 * writing slow: every character goes back through the model's output, and
 * output is the slow part of a tool call. So a description can also be grown
 * at the end, or edited by search and replace, with the server applying the
 * change to the stored text.
 *
 * Reading has the mirror problem: a tool result is capped at CHARACTER_LIMIT,
 * so a long description is served in pages rather than cut off.
 */

import { DESCRIPTION_MAX_LENGTH } from "../constants.js";
import { PlankaError } from "../errors.js";
import { excerpt } from "./format.js";

export interface TextEdit {
  find: string;
  replace: string;
}

/** Add `addition` after `current`, as a new paragraph. */
export function appendParagraph(current: string, addition: string): string {
  const head = current.trimEnd();
  return head === "" ? addition : `${head}\n\n${addition}`;
}

/**
 * Apply search-and-replace edits, in order, all or nothing.
 *
 * Each `find` must occur exactly once in the text as the previous edits left
 * it. A text that is absent means the agent is working from a stale or
 * misremembered copy; a text found twice means the edit would land on a guess.
 * Both refuse the whole batch, so a half-applied edit never reaches Planka.
 */
export function applyEdits(text: string, edits: readonly TextEdit[]): string {
  let result = text;
  edits.forEach((edit, index) => {
    const label = edits.length > 1 ? `Edit ${index + 1} of ${edits.length}` : "The edit";
    const at = edit.find === "" ? -1 : result.indexOf(edit.find);
    if (at === -1) {
      throw new PlankaError(
        `${label} was not applied: "${excerpt(edit.find, 80) ?? ""}" does not occur in the description.`,
        undefined,
        `Nothing was changed. \`find\` must be copied exactly from the current text, line breaks ` +
          `included — read it again with planka_get_card.`,
      );
    }
    if (result.indexOf(edit.find, at + 1) !== -1) {
      throw new PlankaError(
        `${label} was not applied: "${excerpt(edit.find, 80) ?? ""}" occurs more than once in the description.`,
        undefined,
        `Nothing was changed. Extend \`find\` with some of the surrounding text so that it ` +
          `designates a single passage.`,
      );
    }
    result = result.slice(0, at) + edit.replace + result.slice(at + edit.find.length);
  });
  return result;
}

/** Refuse a description Planka would reject, before sending it. */
export function checkDescriptionLength(text: string): void {
  if (text.length > DESCRIPTION_MAX_LENGTH) {
    throw new PlankaError(
      `The description would be ${text.length} characters long; Planka accepts at most ` +
        `${DESCRIPTION_MAX_LENGTH}.`,
      undefined,
      `Nothing was changed. Split the text across several cards.`,
    );
  }
}

export interface TextPage {
  text: string;
  /** Offset of the first character of `text`. */
  start: number;
  /** Offset just past the last character of `text`; where the next page starts. */
  end: number;
  total: number;
}

/**
 * Cut one page out of a long text, ending on a line break where one is close
 * enough to the limit, else on a space — so a page never ends mid-word, and a
 * passage copied from it into `find` is a passage of the real text.
 */
export function pageOfText(text: string, offset: number, size: number): TextPage {
  const total = text.length;
  if (offset > total || (offset > 0 && offset === total)) {
    throw new PlankaError(
      `description_offset ${offset} is past the end of the description (${total} characters).`,
      undefined,
      `Pass 0 to read from the start.`,
    );
  }

  let end = Math.min(total, offset + Math.max(size, 1));
  if (end < total) {
    // Only look back over the last fifth of the page, so a page is never short.
    const floor = offset + Math.floor((end - offset) * 0.8);
    const newline = text.lastIndexOf("\n", end - 1);
    const space = text.lastIndexOf(" ", end - 1);
    if (newline >= floor) end = newline + 1;
    else if (space >= floor) end = space + 1;
    // Never split a surrogate pair.
    const last = text.charCodeAt(end - 1);
    if (last >= 0xd800 && last <= 0xdbff) end -= 1;
  }
  return { text: text.slice(offset, end), start: offset, end, total };
}
