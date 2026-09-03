/**
 * Sibling ordering.
 *
 * Planka orders cards, tasks and lists with a sparse numeric `position`, and
 * documents nothing about it beyond an example value of 65536. So rather than
 * assuming an increment, we always compute relative to the real neighbours:
 * halve to get in front, add a step to get behind, average to land between.
 * That stays correct even if Planka reindexes rows behind our back, because
 * every placement is derived from positions read moments earlier.
 *
 * Callers never pass a raw number. They say "top", "bottom", "before that
 * card" or "index 3", and this module turns that into the one number the
 * PATCH needs.
 */

import { POSITION_STEP } from "../constants.js";

/** An already-ordered sibling: only its position matters here. */
export interface Positioned {
  position?: number | null;
}

export type PositionRequest =
  | { kind: "top" }
  | { kind: "bottom" }
  | { kind: "index"; index: number }
  | { kind: "before"; siblingId: string }
  | { kind: "after"; siblingId: string };

/**
 * Sort siblings by position, ties broken by id.
 *
 * Planka allows a null position, and two rows can briefly share one after a
 * concurrent move; without the id tiebreak the resulting order would differ
 * between two reads of the same board and placements would jitter.
 */
export function sortByPosition<T extends Positioned & { id: string }>(items: readonly T[]): T[] {
  return [...items].sort((a, b) => {
    const left = a.position ?? Number.MAX_SAFE_INTEGER;
    const right = b.position ?? Number.MAX_SAFE_INTEGER;
    if (left !== right) return left - right;
    return a.id.localeCompare(b.id);
  });
}

/**
 * The position value that lands an item at `index` among `ordered`.
 *
 * `index` is the rank the item will occupy once placed, so it ranges from 0
 * (first) to `ordered.length` (last). The item being moved must already have
 * been removed from `ordered`, otherwise it counts as its own neighbour.
 */
function positionAtIndex(ordered: readonly Positioned[], index: number): number {
  const clamped = Math.min(Math.max(index, 0), ordered.length);

  const before = clamped > 0 ? ordered[clamped - 1]?.position : undefined;
  const after = clamped < ordered.length ? ordered[clamped]?.position : undefined;

  // Empty list: any value works, use the step Planka's own examples use.
  if (before === undefined && after === undefined) return POSITION_STEP;
  // Landing first: halve the current head so we stay strictly in front of it.
  if (before === undefined || before === null) return (after as number) / 2;
  // Landing last: one step past the current tail.
  if (after === undefined || after === null) return before + POSITION_STEP;
  return (before + after) / 2;
}

/**
 * Resolve a placement request against the target siblings.
 *
 * `movingId` is excluded from the neighbour list so that re-ordering a card
 * within its own list measures against the others, not against itself.
 */
export function resolvePosition<T extends Positioned & { id: string }>(
  siblings: readonly T[],
  request: PositionRequest,
  movingId?: string,
): { position: number; index: number } {
  const ordered = sortByPosition(siblings).filter((item) => item.id !== movingId);

  const index = ((): number => {
    switch (request.kind) {
      case "top":
        return 0;
      case "bottom":
        return ordered.length;
      case "index":
        return request.index;
      case "before": {
        const at = ordered.findIndex((item) => item.id === request.siblingId);
        return at === -1 ? ordered.length : at;
      }
      case "after": {
        const at = ordered.findIndex((item) => item.id === request.siblingId);
        return at === -1 ? ordered.length : at + 1;
      }
    }
  })();

  const clamped = Math.min(Math.max(index, 0), ordered.length);
  return { position: positionAtIndex(ordered, clamped), index: clamped };
}

/** Position for appending to a list, the common case for a brand-new item. */
export function appendPosition<T extends Positioned & { id: string }>(siblings: readonly T[]): number {
  return resolvePosition(siblings, { kind: "bottom" }).position;
}
