/**
 * Types mirroring the Planka 2.2.1 REST payloads, plus the projected shapes
 * this server exposes.
 *
 * The upstream types are deliberately permissive: every field the OpenAPI spec
 * marks nullable is optional here, and a few that it marks required are too.
 * A Planka upgrade that drops or renames a field should degrade a rendered
 * line, not throw halfway through a card listing.
 */

/* -------------------------------------------------------------------------- */
/* Upstream envelopes                                                          */
/* -------------------------------------------------------------------------- */

/** Every Planka route answers with `item` or `items`, plus a flat `included`. */
export interface ItemResponse<T, I = PlankaIncluded> {
  item: T;
  included?: I;
}

export interface ItemsResponse<T, I = PlankaIncluded> {
  items: T[];
  included?: I;
}

/**
 * `included` is a flattened relational store: arrays of related rows to be
 * re-joined by id. Only the collections this server actually reads are typed.
 */
export interface PlankaIncluded {
  projects?: PlankaProject[];
  boards?: PlankaBoard[];
  boardMemberships?: PlankaBoardMembership[];
  lists?: PlankaList[];
  labels?: PlankaLabel[];
  cards?: PlankaCard[];
  cardLabels?: PlankaCardLabel[];
  cardMemberships?: PlankaCardMembership[];
  taskLists?: PlankaTaskList[];
  tasks?: PlankaTask[];
  users?: PlankaUser[];
}

/* -------------------------------------------------------------------------- */
/* Upstream entities                                                           */
/* -------------------------------------------------------------------------- */

export interface PlankaProject {
  id: string;
  name: string;
  description?: string | null;
  isHidden?: boolean;
  isFavorite?: boolean;
  createdAt?: string | null;
  updatedAt?: string | null;
}

export interface PlankaBoard {
  id: string;
  projectId: string;
  name: string;
  position?: number | null;
  defaultView?: "kanban" | "grid" | "list";
  /** The type to give a new card when the caller does not pick one. */
  defaultCardType?: CardType;
  createdAt?: string | null;
  updatedAt?: string | null;
}

/**
 * `archive` and `trash` are system lists: they carry no name and cannot be
 * created through the API, which only accepts `active` and `closed`.
 */
export type ListType = "active" | "closed" | "archive" | "trash";

export interface PlankaList {
  id: string;
  boardId: string;
  type: ListType;
  name?: string | null;
  position?: number | null;
  color?: string | null;
  createdAt?: string | null;
  updatedAt?: string | null;
}

export type CardType = "project" | "story";

export interface PlankaCard {
  id: string;
  boardId: string;
  listId: string;
  name: string;
  type?: CardType;
  description?: string | null;
  position?: number | null;
  dueDate?: string | null;
  isDueCompleted?: boolean | null;
  isClosed?: boolean;
  commentsTotal?: number;
  creatorUserId?: string | null;
  /** Set while the card sits in an archive or trash list; where it came from. */
  prevListId?: string | null;
  listChangedAt?: string | null;
  createdAt?: string | null;
  updatedAt?: string | null;
}

export interface PlankaLabel {
  id: string;
  boardId: string;
  /** Nullable upstream: a label may be a bare colour with no name. */
  name?: string | null;
  color?: string | null;
  position?: number | null;
}

export interface PlankaTaskList {
  id: string;
  cardId: string;
  name: string;
  position?: number | null;
}

export interface PlankaTask {
  id: string;
  taskListId: string;
  /** Nullable when the task is a link to another card rather than free text. */
  name?: string | null;
  isCompleted?: boolean;
  position?: number | null;
  assigneeUserId?: string | null;
  linkedCardId?: string | null;
}

export interface PlankaComment {
  id: string;
  cardId: string;
  userId?: string | null;
  text: string;
  createdAt?: string | null;
  updatedAt?: string | null;
}

export interface PlankaCardLabel {
  id: string;
  cardId: string;
  labelId: string;
}

export interface PlankaCardMembership {
  id: string;
  cardId: string;
  userId: string;
}

export interface PlankaBoardMembership {
  id: string;
  boardId: string;
  userId: string;
  role?: "editor" | "viewer";
  canComment?: boolean | null;
}

export interface PlankaUser {
  id: string;
  name: string;
  username?: string | null;
  email?: string;
  isDeactivated?: boolean;
}

/* -------------------------------------------------------------------------- */
/* Projected shapes — what this server hands back to the agent                  */
/* -------------------------------------------------------------------------- */

export interface BoardRef {
  id: string;
  name: string;
}

export interface ProjectSummary {
  id: string;
  name: string;
  description?: string;
  boards: BoardRef[];
}

export interface ListSummary {
  id: string;
  name: string;
  type: ListType;
  position: number;
  cardCount: number;
}

export interface LabelSummary {
  id: string;
  name: string;
  color?: string;
}

export interface MemberSummary {
  id: string;
  name: string;
  username?: string;
  role?: "editor" | "viewer";
}

export interface CardSummary {
  id: string;
  name: string;
  boardId: string;
  boardName: string;
  listId: string;
  listName: string;
  position: number;
  labels: string[];
  assignees: string[];
  dueDate?: string;
  isDueCompleted?: boolean;
  /** `"3/7"`, or absent when the card has no tasks at all. */
  taskProgress?: string;
  commentsTotal: number;
}

export interface TaskSummary {
  id: string;
  name: string;
  isCompleted: boolean;
  taskListId: string;
  taskListName: string;
}

export interface CommentSummary {
  id: string;
  author: string;
  text: string;
  createdAt?: string;
}

export interface CardDetail extends CardSummary {
  type?: CardType;
  description?: string;
  createdAt?: string;
  updatedAt?: string;
  tasks?: TaskSummary[];
  comments?: CommentSummary[];
  /** Present only while archived: the list the card should be restored to. */
  previousListName?: string;
}

/**
 * One board, fully denormalized from a single `GET /boards/{id}`. This is what
 * name resolution, board description, card search and position arithmetic all
 * read from, so that moving a card costs one GET (often zero, cached) and one
 * PATCH instead of the three round trips the raw API would need.
 */
export interface BoardSnapshot {
  id: string;
  name: string;
  projectId: string;
  defaultCardType: CardType;
  lists: ListSummary[];
  labels: LabelSummary[];
  members: MemberSummary[];
  cards: CardSummary[];
  /** Raw cards kept alongside the projections, for position arithmetic. */
  rawCards: PlankaCard[];
  fetchedAt: number;
}
