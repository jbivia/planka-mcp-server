/**
 * Name resolution.
 *
 * Planka addresses everything by opaque numeric id. Requiring those ids would
 * make every write a three-call errand, so every reference in this server's
 * tools accepts either an id or a name.
 *
 * Two rules make that safe:
 *   - an ambiguous name is never guessed at — it fails with the candidates
 *     listed, so the agent can pick;
 *   - a name that matches nothing fails with what does exist, so the next call
 *     succeeds instead of probing.
 */

import { PlankaError, quoteList } from "../errors.js";
import type {
  BoardRef,
  BoardSnapshot,
  CardSummary,
  LabelSummary,
  ListSummary,
  MemberSummary,
  ProjectSummary,
} from "../types.js";
import { getBoardSnapshot, getProjects } from "./board-cache.js";

/**
 * Planka ids are strings of digits (snowflake-shaped, e.g. 1357158568008091264),
 * and no board, list or label is realistically named that way. An all-digit
 * reference is therefore treated as an id — and if it turns out not to exist,
 * the caller falls back to matching it as a name before giving up.
 */
export function looksLikeId(reference: string): boolean {
  return /^\d{6,}$/.test(reference.trim());
}

interface Named {
  id: string;
  name: string;
}

/**
 * Match a reference against candidates, from strictest to loosest.
 *
 * The passes are tried in order and the first one yielding exactly one hit
 * wins. Going strict-first means an exact name is never shadowed by another
 * entry that merely contains it: with lists "Done" and "Not Done", "Done"
 * resolves cleanly instead of reporting an ambiguity.
 */
function matchByName<T extends Named>(candidates: readonly T[], reference: string): T[] {
  const needle = reference.trim().toLowerCase();
  const passes: ((candidate: T) => boolean)[] = [
    (candidate) => candidate.name.trim().toLowerCase() === needle,
    (candidate) => candidate.name.trim().toLowerCase().startsWith(needle),
    (candidate) => candidate.name.trim().toLowerCase().includes(needle),
  ];

  for (const pass of passes) {
    const hits = candidates.filter(pass);
    if (hits.length === 1) return hits;
    // Several hits on an exact-name pass is a real ambiguity in the board, and
    // a looser pass can only make it worse — stop and report these.
    if (hits.length > 1) return hits;
  }
  return [];
}

/**
 * Resolve one reference against a list of candidates.
 *
 * `kind` and `scope` only shape the error message, but that message is the
 * whole point: "list not found, here are the lists" is recoverable, "404" is not.
 */
export function resolveNamed<T extends Named>(
  candidates: readonly T[],
  reference: string,
  kind: string,
  scope: string,
  recovery: string,
  /** How many candidates to name when nothing matched. Cards need a lower cap. */
  candidateLimit = 25,
): T {
  const trimmed = reference.trim();
  if (trimmed === "") {
    throw new PlankaError(`Empty ${kind} reference.`, undefined, `Pass a ${kind} name or id.`);
  }

  const byId = candidates.find((candidate) => candidate.id === trimmed);
  if (byId) return byId;

  const hits = matchByName(candidates, trimmed);
  if (hits.length === 1) return hits[0] as T;

  if (hits.length > 1) {
    throw new PlankaError(
      `${kind} "${trimmed}" is ambiguous ${scope}: it matches ${quoteList(hits.map((hit) => hit.name))}.`,
      undefined,
      `Use the exact name, or the id of the one you mean.`,
    );
  }

  // An all-digit reference that matched no id is almost certainly a stale id
  // rather than a name, and saying so points at the right fix.
  const nothingMatched = looksLikeId(trimmed)
    ? `No ${kind} with id ${trimmed} ${scope}.`
    : `${kind} "${trimmed}" not found ${scope}.`;

  throw new PlankaError(
    `${nothingMatched} Available: ${quoteList(
      candidates.map((candidate) => candidate.name),
      candidateLimit,
    )}.`,
    undefined,
    recovery,
  );
}

/* -------------------------------------------------------------------------- */
/* Entity-specific resolvers                                                   */
/* -------------------------------------------------------------------------- */

export async function resolveProject(reference: string): Promise<ProjectSummary> {
  const projects = await getProjects();
  return resolveNamed(
    projects,
    reference,
    "Project",
    "on this Planka instance",
    "Call planka_list_projects to see the projects this account can access.",
  );
}

/**
 * Resolve a board, optionally scoped to a project.
 *
 * Without a project, the search spans every accessible board — which is what
 * makes `planka_move_card` usable with nothing but two names, and why the
 * ambiguity error matters more here than anywhere else.
 */
export async function resolveBoard(
  reference: string,
  projectReference?: string,
): Promise<BoardRef & { projectName: string }> {
  const projects = await getProjects();
  const scoped = projectReference ? [await resolveProject(projectReference)] : projects;

  const candidates = scoped.flatMap((project) =>
    project.boards.map((board) => ({ ...board, projectName: project.name })),
  );

  const scope = projectReference
    ? `in project "${scoped[0]?.name ?? projectReference}"`
    : "on this Planka instance";

  return resolveNamed(
    candidates,
    reference,
    "Board",
    scope,
    projectReference
      ? "Call planka_list_projects to see the boards of this project."
      : "Call planka_list_projects, or pass `project` to disambiguate boards with the same name.",
  );
}

/** Resolve a board reference all the way to its loaded snapshot. */
export async function resolveBoardSnapshot(
  reference: string,
  projectReference?: string,
): Promise<BoardSnapshot> {
  const board = await resolveBoard(reference, projectReference);
  return getBoardSnapshot(board.id);
}

/**
 * Resolve a list within a board.
 *
 * `archive` and `trash` are hidden by default: they are system lists, they
 * carry no name of their own, and offering them as move targets would let an
 * agent archive a card while believing it filed it.
 */
export function resolveList(
  snapshot: BoardSnapshot,
  reference: string,
  options: { includeSystem?: boolean } = {},
): ListSummary {
  const candidates = options.includeSystem
    ? snapshot.lists
    : snapshot.lists.filter((list) => list.type === "active" || list.type === "closed");

  return resolveNamed(
    candidates,
    reference,
    "List",
    `on board "${snapshot.name}"`,
    "Call planka_describe_board to see the lists of this board.",
  );
}

export function resolveLabel(snapshot: BoardSnapshot, reference: string): LabelSummary {
  return resolveNamed(
    snapshot.labels,
    reference,
    "Label",
    `on board "${snapshot.name}"`,
    "Call planka_describe_board to see the labels of this board. Labels belong to a board; " +
      "one that exists on another board cannot be used here.",
  );
}

/**
 * Resolve a board member.
 *
 * Matching also covers username and email, because an agent is as likely to be
 * handed "jdoe" or an address as a display name. They are folded into the
 * `name` field of throwaway candidates so a single matcher handles all three.
 */
export function resolveMember(snapshot: BoardSnapshot, reference: string): MemberSummary {
  const trimmed = reference.trim().toLowerCase();

  const direct = snapshot.members.find(
    (member) =>
      member.id === reference.trim() ||
      member.name.trim().toLowerCase() === trimmed ||
      member.username?.trim().toLowerCase() === trimmed,
  );
  if (direct) return direct;

  return resolveNamed(
    snapshot.members,
    reference,
    "Member",
    `on board "${snapshot.name}"`,
    "Call planka_describe_board to see who is a member of this board. Only board members " +
      "can be assigned to its cards.",
  );
}

export function resolveCard(snapshot: BoardSnapshot, reference: string): CardSummary {
  return resolveNamed(
    snapshot.cards,
    reference,
    "Card",
    `on board "${snapshot.name}"`,
    "Call planka_search_cards to find the card. If several cards share a title, use the id.",
    // A board can hold hundreds of cards; naming them all would be the reply.
    10,
  );
}
