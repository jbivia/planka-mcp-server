/**
 * In-memory structure cache.
 *
 * Planka spreads a board across a dozen `included` arrays but hands the whole
 * thing over in a single `GET /boards/{id}`. Caching that response is what lets
 * every tool take names instead of ids: resolving "move Fix login to En cours"
 * costs one board read (usually zero, from cache) plus one PATCH, where the raw
 * API would need a project list, a board read and a list lookup first.
 *
 * That read is also the heaviest request this server makes: it carries every
 * card of the board with its full description, so a board used to write a book
 * weighs as much as the book. Hence two rules.
 *
 *   - A card write never re-reads the board. Planka answers every card write
 *     with the stored card, and `storeCard` / `forgetCard` fold that answer into
 *     the cached response. Writes to anything else (labels, members, tasks,
 *     comments) drop the board instead, and the next call that needs it pays
 *     for one read.
 *   - Concurrent reads of the same board share one request, so a scan of
 *     several boards never fetches one of them twice.
 *
 * The TTL is short, so a stale snapshot can only ever be as old as another
 * client's concurrent edit.
 */

import { loadConfig } from "../config.js";
import { BOARD_FETCH_CONCURRENCY } from "../constants.js";
import { PlankaError } from "../errors.js";
import type {
  BoardSnapshot,
  ItemResponse,
  ItemsResponse,
  PlankaBoard,
  PlankaCard,
  PlankaIncluded,
  PlankaProject,
  ProjectSummary,
} from "../types.js";
import { apiRequest } from "./client.js";
import { projectBoard, projectProjects } from "./project.js";

interface ProjectCache {
  projects: ProjectSummary[];
  fetchedAt: number;
}

/** The raw response is kept next to its projection, so a write can be folded into it. */
interface BoardEntry {
  board: PlankaBoard;
  included: PlankaIncluded;
  snapshot: BoardSnapshot;
}

let projectCache: ProjectCache | undefined;
let pendingProjects: Promise<ProjectSummary[]> | undefined;
const boardCache = new Map<string, BoardEntry>();
const pendingBoards = new Map<string, Promise<BoardSnapshot>>();

/**
 * Bumped by every write to a board. A read that started before a write may
 * answer with the board as it was before it, so it is only cached if no write
 * happened while it was in flight.
 */
const boardVersions = new Map<string, number>();

function boardVersion(boardId: string): number {
  return boardVersions.get(boardId) ?? 0;
}

function bumpBoardVersion(boardId: string): void {
  boardVersions.set(boardId, boardVersion(boardId) + 1);
  // A read already in flight may predate the write; later callers must not join it.
  pendingBoards.delete(boardId);
}

/**
 * The clock the cache dates its entries with: monotonic, and finer than a
 * millisecond, so "read before this call" and "read during it" never tie.
 */
export function cacheClock(): number {
  return performance.now();
}

function isFresh(fetchedAt: number): boolean {
  return cacheClock() - fetchedAt < loadConfig().cacheTtlMs;
}

/** Same guard as `boardVersions`, for the project listing. */
let projectsVersion = 0;

/** Every project the token can see, each with its boards. */
export async function getProjects(force = false): Promise<ProjectSummary[]> {
  if (!force && projectCache && isFresh(projectCache.fetchedAt)) return projectCache.projects;
  if (!force && pendingProjects) return pendingProjects;

  const version = projectsVersion;
  const request: Promise<ProjectSummary[]> = (async () => {
    const response = await apiRequest<ItemsResponse<PlankaProject>>("/projects");
    const projects = projectProjects(response.items ?? [], response.included);
    if (projectsVersion === version) projectCache = { projects, fetchedAt: cacheClock() };
    return projects;
  })().finally(() => {
    if (pendingProjects === request) pendingProjects = undefined;
  });
  pendingProjects = request;
  return request;
}

async function fetchBoard(boardId: string): Promise<BoardSnapshot> {
  const version = boardVersion(boardId);
  const response = await apiRequest<ItemResponse<PlankaBoard, PlankaIncluded>>(`/boards/${boardId}`);
  if (!response.item) {
    throw new PlankaError(
      `Board ${boardId} returned no data.`,
      undefined,
      `Call planka_list_projects to get a current board id.`,
    );
  }
  const included = response.included ?? {};
  const snapshot = projectBoard(response.item, included);
  if (boardVersion(boardId) === version) {
    boardCache.set(boardId, { board: response.item, included, snapshot });
  }
  return snapshot;
}

/** One board, fully denormalized. */
export async function getBoardSnapshot(boardId: string, force = false): Promise<BoardSnapshot> {
  const cached = boardCache.get(boardId);
  if (!force && cached && isFresh(cached.snapshot.fetchedAt)) return cached.snapshot;

  const pending = pendingBoards.get(boardId);
  if (!force && pending) return pending;

  const request = fetchBoard(boardId).finally(() => {
    if (pendingBoards.get(boardId) === request) pendingBoards.delete(boardId);
  });
  pendingBoards.set(boardId, request);
  return request;
}

/**
 * Several boards, in the order given, read a few at a time.
 *
 * Used by the scans that have no board to go on. Reading them one after the
 * other made a ten-board search cost ten round trips back to back.
 */
export async function getBoardSnapshots(boardIds: readonly string[]): Promise<BoardSnapshot[]> {
  const snapshots: BoardSnapshot[] = new Array(boardIds.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < boardIds.length) {
      const index = next++;
      snapshots[index] = await getBoardSnapshot(boardIds[index] as string);
    }
  };
  await Promise.all(Array.from({ length: Math.min(BOARD_FETCH_CONCURRENCY, boardIds.length) }, worker));
  return snapshots;
}

/** A cached snapshot holding this card, without any request. Used to short-cut an id lookup. */
export function findCachedCard(cardId: string): BoardSnapshot | undefined {
  for (const entry of boardCache.values()) {
    if (isFresh(entry.snapshot.fetchedAt) && entry.snapshot.cards.some((card) => card.id === cardId)) {
      return entry.snapshot;
    }
  }
  return undefined;
}

/**
 * Re-project a cached board after changing its raw cards.
 *
 * The board keeps the age of its last real read: only the card that was
 * written is known to be current, the rest of the board is as old as before.
 * An expired entry is updated too, because the caller renders its reply from
 * it; it still counts as expired for the next read.
 */
function rewriteCards(
  boardId: string,
  update: (cards: readonly PlankaCard[]) => PlankaCard[],
): BoardSnapshot | undefined {
  bumpBoardVersion(boardId);
  const entry = boardCache.get(boardId);
  if (!entry) return undefined;

  const included = { ...entry.included, cards: update(entry.included.cards ?? []) };
  const snapshot = { ...projectBoard(entry.board, included), fetchedAt: entry.snapshot.fetchedAt };
  boardCache.set(boardId, { board: entry.board, included, snapshot });
  return snapshot;
}

/**
 * Fold the card a write returned (create, update, move, archive) into its
 * cached board, and return the updated snapshot — or `undefined` when the
 * board is not cached, in which case the next read fetches it anyway.
 */
export function storeCard(boardId: string, card: PlankaCard): BoardSnapshot | undefined {
  return rewriteCards(boardId, (cards) => [...cards.filter((existing) => existing.id !== card.id), card]);
}

/** Remove a deleted card from its cached board. */
export function forgetCard(boardId: string, cardId: string): void {
  rewriteCards(boardId, (cards) => cards.filter((existing) => existing.id !== cardId));
}

/**
 * Drop a board after a write the cache cannot replay.
 *
 * Called on success only: if the write failed, the cached snapshot is still an
 * accurate picture of the board and throwing it away would just cost a refetch.
 */
export function invalidateBoard(boardId: string): void {
  bumpBoardVersion(boardId);
  boardCache.delete(boardId);
}

/** Drop the project/board listing, after something structural changed. */
export function invalidateProjects(): void {
  projectsVersion += 1;
  projectCache = undefined;
  pendingProjects = undefined;
}

/** Test seam. */
export function resetCacheForTesting(): void {
  projectCache = undefined;
  pendingProjects = undefined;
  projectsVersion = 0;
  boardCache.clear();
  pendingBoards.clear();
  boardVersions.clear();
}
