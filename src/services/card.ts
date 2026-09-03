/**
 * Card lookup shared by the read and lifecycle tools.
 *
 * Resolving "the card called X" needs a board to search, and a board reference
 * is not always given — so this centralises the two ways in: an explicit board,
 * or a scan of the accessible boards when only a card name is known.
 */

import { SEARCH_BOARD_LIMIT } from "../constants.js";
import { PlankaError, quoteList } from "../errors.js";
import type { BoardSnapshot, CardSummary } from "../types.js";
import { getBoardSnapshot, getProjects } from "./board-cache.js";
import { looksLikeId, resolveBoard, resolveCard, resolveProject } from "./resolve.js";

export interface LocatedCard {
  card: CardSummary;
  snapshot: BoardSnapshot;
}

/**
 * Find a card, with or without a board hint.
 *
 * With a board it is a straight snapshot lookup. Without one, the accessible
 * boards are scanned; a title matching on two boards is an ambiguity and is
 * reported as one rather than resolved by whichever board loaded first.
 */
export async function locateCard(
  cardReference: string,
  boardReference?: string,
  projectReference?: string,
): Promise<LocatedCard> {
  if (boardReference) {
    const board = await resolveBoard(boardReference, projectReference);
    const snapshot = await getBoardSnapshot(board.id);
    return { card: resolveCard(snapshot, cardReference), snapshot };
  }

  const projects = projectReference ? [await resolveProject(projectReference)] : await getProjects();
  const boards = projects.flatMap((project) => project.boards).slice(0, SEARCH_BOARD_LIMIT);

  const needle = cardReference.trim().toLowerCase();
  const hits: LocatedCard[] = [];
  for (const board of boards) {
    const snapshot = await getBoardSnapshot(board.id);
    for (const card of snapshot.cards) {
      if (card.id === cardReference.trim() || card.name.trim().toLowerCase() === needle) {
        hits.push({ card, snapshot });
      }
    }
    // An id is unique across the instance, so the first hit is the only hit.
    if (hits.length > 0 && looksLikeId(cardReference)) break;
  }

  if (hits.length === 1) return hits[0] as LocatedCard;
  if (hits.length > 1) {
    throw new PlankaError(
      `Card "${cardReference}" exists on several boards: ` +
        `${quoteList(hits.map((hit) => hit.snapshot.name))}.`,
      undefined,
      `Pass \`board\` to say which one, or use the card id.`,
    );
  }

  throw new PlankaError(
    `Card "${cardReference}" not found on any of the ${boards.length} board(s) searched.`,
    undefined,
    `Pass \`board\` to search a specific board, or call planka_search_cards to find the card ` +
      `— an exact title is required when no board is given.`,
  );
}
