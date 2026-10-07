/**
 * Card lookup shared by the read and lifecycle tools.
 *
 * Resolving "the card called X" needs a board to search, and a board reference
 * is not always given — so this centralises the three ways in: an explicit
 * board, a card id (which the card route maps to its board), or a scan of the
 * accessible boards when only a title is known.
 */

import { SEARCH_BOARD_LIMIT } from "../constants.js";
import { PlankaError, quoteList } from "../errors.js";
import type { BoardSnapshot, CardSummary, ItemResponse, PlankaCard } from "../types.js";
import { cacheClock, findCachedCard, getBoardSnapshot, getBoardSnapshots, getProjects } from "./board-cache.js";
import { apiRequest } from "./client.js";
import { looksLikeId, resolveBoard, resolveCard, resolveOnBoard, resolveProject } from "./resolve.js";

export interface LocatedCard {
  card: CardSummary;
  snapshot: BoardSnapshot;
}

/**
 * Find a card by id without being told its board.
 *
 * A fresh cached board that holds it answers for free. Otherwise the card
 * route says which board the card is on, so one small read replaces a scan of
 * every board. `undefined` means Planka has no such card: the reference may be
 * an all-digit title, and the caller falls back to matching it as one.
 */
async function locateById(cardId: string): Promise<LocatedCard | undefined> {
  const cached = findCachedCard(cardId);
  const cachedCard = cached?.cards.find((card) => card.id === cardId);
  if (cached && cachedCard) return { card: cachedCard, snapshot: cached };

  let card: PlankaCard | undefined;
  try {
    card = (await apiRequest<ItemResponse<PlankaCard>>(`/cards/${cardId}`)).item;
  } catch (error) {
    if (error instanceof PlankaError && error.status === 404) return undefined;
    throw error;
  }
  if (!card?.boardId) return undefined;

  const askedAt = cacheClock();
  let snapshot = await getBoardSnapshot(card.boardId);
  let summary = snapshot.cards.find((candidate) => candidate.id === cardId);
  if (!summary && snapshot.fetchedAt < askedAt) {
    // A snapshot cached before the card was created does not hold it yet.
    snapshot = await getBoardSnapshot(card.boardId, true);
    summary = snapshot.cards.find((candidate) => candidate.id === cardId);
  }
  if (!summary) {
    const place = snapshot.lists.find((list) => list.id === card.listId)?.type ?? "archive";
    throw new PlankaError(
      `Card "${card.name}" (id ${cardId}) is in the ${place} of board "${snapshot.name}".`,
      undefined,
      `Archived and trashed cards are out of reach of these tools. Restore it from the Planka UI first.`,
    );
  }
  return { card: summary, snapshot };
}

/**
 * Find a card, with or without a board hint.
 *
 * With a board it is a straight snapshot lookup. Without one, an id goes
 * through the card route, and a title is looked for on the accessible boards;
 * a title matching on two boards is an ambiguity and is reported as one rather
 * than resolved by whichever board loaded first.
 */
export async function locateCard(
  cardReference: string,
  boardReference?: string,
  projectReference?: string,
): Promise<LocatedCard> {
  if (boardReference) {
    const board = await resolveBoard(boardReference, projectReference);
    const { value: card, snapshot } = await resolveOnBoard(board.id, (current) =>
      resolveCard(current, cardReference),
    );
    return { card, snapshot };
  }

  const trimmed = cardReference.trim();
  if (looksLikeId(trimmed)) {
    const located = await locateById(trimmed);
    if (located) return located;
  }

  const projects = projectReference ? [await resolveProject(projectReference)] : await getProjects();
  const allBoards = projects.flatMap((project) => project.boards);
  const boards = allBoards.slice(0, SEARCH_BOARD_LIMIT);
  const snapshots = await getBoardSnapshots(boards.map((board) => board.id));

  const needle = trimmed.toLowerCase();
  const hits: LocatedCard[] = snapshots.flatMap((snapshot) =>
    snapshot.cards
      .filter((card) => card.id === trimmed || card.name.trim().toLowerCase() === needle)
      .map((card) => ({ card, snapshot })),
  );

  if (hits.length === 1) return hits[0] as LocatedCard;
  if (hits.length > 1) {
    throw new PlankaError(
      `Card "${cardReference}" exists on several boards: ` +
        `${quoteList(hits.map((hit) => hit.snapshot.name))}.`,
      undefined,
      `Pass \`board\` to say which one, or use the card id.`,
    );
  }

  const unsearched = allBoards.length - boards.length;
  throw new PlankaError(
    `Card "${cardReference}" not found on any of the ${boards.length} board(s) searched` +
      `${unsearched > 0 ? ` (${unsearched} more not searched)` : ""}.`,
    undefined,
    `Pass \`board\` to search a specific board, or call planka_search_cards to find the card ` +
      `— an exact title is required when no board is given.`,
  );
}
