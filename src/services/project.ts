/**
 * Projections: Planka's flat `included` blocks turned into the shapes this
 * server actually exposes.
 *
 * The upstream envelope is a small relational dump — `cardLabels` holds
 * (cardId, labelId) pairs, `labels` holds the names, `cardMemberships` holds
 * (cardId, userId), `users` holds the people, and a card carries none of it.
 * Relaying that would spend thousands of tokens on rows the agent has to join
 * itself. Everything below does the join once and emits names.
 */

import type {
  BoardSnapshot,
  CardDetail,
  CardSummary,
  CardType,
  CommentSummary,
  LabelSummary,
  ListSummary,
  MemberSummary,
  PlankaBoard,
  PlankaCard,
  PlankaComment,
  PlankaIncluded,
  PlankaProject,
  PlankaUser,
  ProjectSummary,
  TaskSummary,
} from "../types.js";
import { sortByPosition } from "./position.js";

/** Index a collection by id for repeated lookups. */
function byId<T extends { id: string }>(items: readonly T[] | undefined): Map<string, T> {
  return new Map((items ?? []).map((item) => [item.id, item]));
}

/** A label with no name is legal in Planka; fall back to its colour. */
function labelName(label: { name?: string | null; color?: string | null }): string {
  return label.name?.trim() || label.color || "(unnamed label)";
}

function userName(user: PlankaUser | undefined): string | undefined {
  if (!user) return undefined;
  return user.name?.trim() || user.username?.trim() || undefined;
}

/* -------------------------------------------------------------------------- */
/* Projects                                                                    */
/* -------------------------------------------------------------------------- */

export function projectProjects(
  items: readonly PlankaProject[],
  included: PlankaIncluded | undefined,
): ProjectSummary[] {
  const boards = included?.boards ?? [];
  return items.map((project) => ({
    id: project.id,
    name: project.name,
    ...(project.description ? { description: project.description } : {}),
    boards: sortByPosition(boards.filter((board) => board.projectId === project.id)).map((board) => ({
      id: board.id,
      name: board.name,
    })),
  }));
}

/* -------------------------------------------------------------------------- */
/* Board snapshot                                                              */
/* -------------------------------------------------------------------------- */

/**
 * Fold one `GET /boards/{id}` response into the snapshot every other module
 * reads from. Built once per board per TTL, then reused for name resolution,
 * search, and position arithmetic.
 */
export function projectBoard(board: PlankaBoard, included: PlankaIncluded | undefined): BoardSnapshot {
  const rawLists = included?.lists ?? [];
  const rawCards = included?.cards ?? [];
  const users = byId(included?.users);
  const labels = byId(included?.labels);

  // Planka already omits archived and trashed cards from this response
  // (verified against 2.2.1), so this filter is belt-and-braces — but it costs
  // one map lookup and it pins the behaviour if a future version starts
  // including them.
  const listById = byId(rawLists);
  const visibleCards = rawCards.filter((card) => {
    const type = listById.get(card.listId)?.type;
    return type === "active" || type === "closed";
  });

  const cardCount = new Map<string, number>();
  for (const card of visibleCards) {
    cardCount.set(card.listId, (cardCount.get(card.listId) ?? 0) + 1);
  }

  const labelsByCard = new Map<string, string[]>();
  for (const link of included?.cardLabels ?? []) {
    const label = labels.get(link.labelId);
    if (!label) continue;
    const bucket = labelsByCard.get(link.cardId) ?? [];
    bucket.push(labelName(label));
    labelsByCard.set(link.cardId, bucket);
  }

  const assigneesByCard = new Map<string, string[]>();
  for (const link of included?.cardMemberships ?? []) {
    const name = userName(users.get(link.userId)) ?? link.userId;
    const bucket = assigneesByCard.get(link.cardId) ?? [];
    bucket.push(name);
    assigneesByCard.set(link.cardId, bucket);
  }

  // Task progress needs the two-level walk that is new in Planka 2.x:
  // card → task lists → tasks.
  const taskListToCard = new Map<string, string>(
    (included?.taskLists ?? []).map((taskList) => [taskList.id, taskList.cardId]),
  );
  const progressByCard = new Map<string, { done: number; total: number }>();
  for (const task of included?.tasks ?? []) {
    const cardId = taskListToCard.get(task.taskListId);
    if (!cardId) continue;
    const bucket = progressByCard.get(cardId) ?? { done: 0, total: 0 };
    bucket.total += 1;
    if (task.isCompleted) bucket.done += 1;
    progressByCard.set(cardId, bucket);
  }

  const listSummaries: ListSummary[] = sortByPosition(rawLists).map((list) => ({
    id: list.id,
    // Archive and trash lists carry no name upstream; name them by their role.
    name: list.name?.trim() || `(${list.type})`,
    type: list.type,
    position: list.position ?? 0,
    cardCount: cardCount.get(list.id) ?? 0,
  }));
  const listNames = new Map(listSummaries.map((list) => [list.id, list.name]));

  // Ordered by list first, then by position within it. A single global sort by
  // position would interleave the columns, since positions restart per list —
  // and a search result that jumps between lists is unreadable.
  const listOrder = new Map(listSummaries.map((list, index) => [list.id, index]));
  const orderedCards = sortByPosition(visibleCards).sort(
    (a, b) =>
      (listOrder.get(a.listId) ?? Number.MAX_SAFE_INTEGER) -
      (listOrder.get(b.listId) ?? Number.MAX_SAFE_INTEGER),
  );

  const cardSummaries = orderedCards.map((card) =>
    projectCardSummary(card, {
      boardName: board.name,
      listName: listNames.get(card.listId) ?? "(unknown list)",
      labels: labelsByCard.get(card.id) ?? [],
      assignees: assigneesByCard.get(card.id) ?? [],
      ...(progressByCard.has(card.id) ? { progress: progressByCard.get(card.id) } : {}),
    }),
  );

  return {
    id: board.id,
    name: board.name,
    projectId: board.projectId,
    defaultCardType: board.defaultCardType ?? "project",
    lists: listSummaries,
    labels: sortByPosition(included?.labels ?? []).map(
      (label): LabelSummary => ({
        id: label.id,
        name: labelName(label),
        ...(label.color ? { color: label.color } : {}),
      }),
    ),
    members: (included?.boardMemberships ?? []).map((membership): MemberSummary => {
      const user = users.get(membership.userId);
      return {
        id: membership.userId,
        name: userName(user) ?? membership.userId,
        ...(user?.username ? { username: user.username } : {}),
        ...(membership.role ? { role: membership.role } : {}),
      };
    }),
    cards: cardSummaries,
    rawCards: visibleCards,
    fetchedAt: Date.now(),
  };
}

interface CardContext {
  boardName: string;
  listName: string;
  labels: string[];
  assignees: string[];
  progress?: { done: number; total: number };
}

export function projectCardSummary(card: PlankaCard, context: CardContext): CardSummary {
  return {
    id: card.id,
    name: card.name,
    boardId: card.boardId,
    boardName: context.boardName,
    listId: card.listId,
    listName: context.listName,
    position: card.position ?? 0,
    labels: context.labels,
    assignees: context.assignees,
    ...(card.dueDate ? { dueDate: card.dueDate } : {}),
    ...(card.isDueCompleted !== undefined && card.isDueCompleted !== null
      ? { isDueCompleted: card.isDueCompleted }
      : {}),
    ...(context.progress ? { taskProgress: `${context.progress.done}/${context.progress.total}` } : {}),
    commentsTotal: card.commentsTotal ?? 0,
  };
}

/* -------------------------------------------------------------------------- */
/* Card detail                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * Flatten the tasks of a card. In 2.x they hang off task lists, and a task may
 * be a link to another card rather than free text, in which case it has no name.
 */
export function projectTasks(included: PlankaIncluded | undefined): TaskSummary[] {
  const taskLists = sortByPosition(included?.taskLists ?? []);
  const tasks = sortByPosition(included?.tasks ?? []);
  const result: TaskSummary[] = [];
  for (const taskList of taskLists) {
    for (const task of tasks.filter((candidate) => candidate.taskListId === taskList.id)) {
      result.push({
        id: task.id,
        name: task.name?.trim() || (task.linkedCardId ? `(linked card ${task.linkedCardId})` : "(unnamed)"),
        isCompleted: Boolean(task.isCompleted),
        taskListId: taskList.id,
        taskListName: taskList.name,
      });
    }
  }
  return result;
}

export function projectComments(
  comments: readonly PlankaComment[],
  included: PlankaIncluded | undefined,
): CommentSummary[] {
  const users = byId(included?.users);
  return comments.map((comment) => ({
    id: comment.id,
    author: (comment.userId ? userName(users.get(comment.userId)) : undefined) ?? "(unknown)",
    text: comment.text,
    ...(comment.createdAt ? { createdAt: comment.createdAt } : {}),
  }));
}

/**
 * Build a full card view from `GET /cards/{id}` plus the board snapshot.
 *
 * The card route returns label *links* without label names and membership
 * links without user names, so the snapshot supplies the vocabulary. This is
 * the one place both sources are joined.
 */
export function projectCardDetail(
  card: PlankaCard,
  included: PlankaIncluded | undefined,
  snapshot: BoardSnapshot,
  comments: CommentSummary[] | undefined,
): CardDetail {
  const labelsById = new Map(snapshot.labels.map((label) => [label.id, label.name]));
  const membersById = new Map(snapshot.members.map((member) => [member.id, member.name]));
  const listsById = new Map(snapshot.lists.map((list) => [list.id, list.name]));

  const users = byId(included?.users);
  const labels = (included?.cardLabels ?? [])
    .filter((link) => link.cardId === card.id)
    .map((link) => labelsById.get(link.labelId) ?? link.labelId);
  const assignees = (included?.cardMemberships ?? [])
    .filter((link) => link.cardId === card.id)
    .map((link) => membersById.get(link.userId) ?? userName(users.get(link.userId)) ?? link.userId);

  const tasks = projectTasks(included);
  const done = tasks.filter((task) => task.isCompleted).length;

  const summary = projectCardSummary(card, {
    boardName: snapshot.name,
    listName: listsById.get(card.listId) ?? "(unknown list)",
    labels,
    assignees,
    ...(tasks.length > 0 ? { progress: { done, total: tasks.length } } : {}),
  });

  return {
    ...summary,
    ...(card.type ? { type: card.type as CardType } : {}),
    ...(card.description ? { description: card.description } : {}),
    ...(card.createdAt ? { createdAt: card.createdAt } : {}),
    ...(card.updatedAt ? { updatedAt: card.updatedAt } : {}),
    tasks,
    ...(comments ? { comments } : {}),
    ...(card.prevListId && listsById.has(card.prevListId)
      ? { previousListName: listsById.get(card.prevListId) as string }
      : {}),
  };
}
