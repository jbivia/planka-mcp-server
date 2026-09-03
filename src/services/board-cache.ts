/**
 * In-memory structure cache.
 *
 * Planka spreads a board across a dozen `included` arrays but hands the whole
 * thing over in a single `GET /boards/{id}`. Caching that response is what lets
 * every tool take names instead of ids: resolving "move Fix login to En cours"
 * costs one board read (usually zero, from cache) plus one PATCH, where the raw
 * API would need a project list, a board read and a list lookup first.
 *
 * The TTL is short and every successful write invalidates its board, so a stale
 * snapshot can only ever be as old as another client's concurrent edit.
 */

import { loadConfig } from "../config.js";
import { PlankaError } from "../errors.js";
import type {
  BoardSnapshot,
  ItemResponse,
  ItemsResponse,
  PlankaBoard,
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

let projectCache: ProjectCache | undefined;
const boardCache = new Map<string, BoardSnapshot>();

function isFresh(fetchedAt: number): boolean {
  return Date.now() - fetchedAt < loadConfig().cacheTtlMs;
}

/** Every project the token can see, each with its boards. */
export async function getProjects(force = false): Promise<ProjectSummary[]> {
  if (!force && projectCache && isFresh(projectCache.fetchedAt)) return projectCache.projects;

  const response = await apiRequest<ItemsResponse<PlankaProject>>("/projects");
  const projects = projectProjects(response.items ?? [], response.included);
  projectCache = { projects, fetchedAt: Date.now() };
  return projects;
}

/** One board, fully denormalized. */
export async function getBoardSnapshot(boardId: string, force = false): Promise<BoardSnapshot> {
  const cached = boardCache.get(boardId);
  if (!force && cached && isFresh(cached.fetchedAt)) return cached;

  const response = await apiRequest<ItemResponse<PlankaBoard, PlankaIncluded>>(`/boards/${boardId}`);
  if (!response.item) {
    throw new PlankaError(
      `Board ${boardId} returned no data.`,
      undefined,
      `Call planka_list_projects to get a current board id.`,
    );
  }
  const snapshot = projectBoard(response.item, response.included);
  boardCache.set(boardId, snapshot);
  return snapshot;
}

/**
 * Drop a board after a write.
 *
 * Called on success only: if the PATCH failed, the cached snapshot is still an
 * accurate picture of the board and throwing it away would just cost a refetch.
 */
export function invalidateBoard(boardId: string): void {
  boardCache.delete(boardId);
}

/** Drop the project/board listing, after something structural changed. */
export function invalidateProjects(): void {
  projectCache = undefined;
}

/** Test seam. */
export function resetCacheForTesting(): void {
  projectCache = undefined;
  boardCache.clear();
}
