/**
 * A board response shaped exactly like `GET /api/boards/{id}` in Planka 2.2.1,
 * including the flat `included` blocks and the two system lists.
 *
 * Field names and nesting are taken from the OpenAPI spec rather than invented,
 * so a test that passes here says something about the real payload.
 */

import type { ItemResponse, PlankaBoard, PlankaIncluded } from "../../src/types.js";

export const BOARD_ID = "1357158568008091000";

export const boardResponse: ItemResponse<PlankaBoard, PlankaIncluded> = {
  item: {
    id: BOARD_ID,
    projectId: "1357158568008090000",
    name: "Roadmap",
    position: 65536,
    defaultView: "kanban",
    defaultCardType: "project",
  },
  included: {
    lists: [
      { id: "list-backlog", boardId: BOARD_ID, type: "active", name: "Backlog", position: 65536 },
      { id: "list-doing", boardId: BOARD_ID, type: "active", name: "En cours", position: 131072 },
      { id: "list-done", boardId: BOARD_ID, type: "closed", name: "Done", position: 196608 },
      // System lists: no name, no position — exactly as Planka returns them.
      { id: "list-archive", boardId: BOARD_ID, type: "archive", name: null, position: null },
      { id: "list-trash", boardId: BOARD_ID, type: "trash", name: null, position: null },
    ],
    labels: [
      { id: "label-bug", boardId: BOARD_ID, name: "bug", color: "berry-red", position: 65536 },
      { id: "label-urgent", boardId: BOARD_ID, name: "urgent", color: "pumpkin-orange", position: 131072 },
      // A label with no name is legal; it must fall back to its colour.
      { id: "label-nameless", boardId: BOARD_ID, name: null, color: "lagoon-blue", position: 196608 },
    ],
    boardMemberships: [
      { id: "bm-1", boardId: BOARD_ID, userId: "user-jane", role: "editor" },
      { id: "bm-2", boardId: BOARD_ID, userId: "user-john", role: "viewer" },
    ],
    users: [
      { id: "user-jane", name: "Jane Doe", username: "jdoe", email: "jane@example.com" },
      { id: "user-john", name: "John Roe", username: "jroe", email: "john@example.com" },
    ],
    cards: [
      {
        id: "card-login",
        boardId: BOARD_ID,
        listId: "list-backlog",
        name: "Fix the login redirect",
        description: "SSO bounces back to /login after a successful assertion.",
        position: 65536,
        dueDate: "2026-01-31T17:00:00.000Z",
        isDueCompleted: false,
        commentsTotal: 2,
      },
      {
        id: "card-cert",
        boardId: BOARD_ID,
        listId: "list-backlog",
        name: "Rotate the TLS cert",
        position: 131072,
        commentsTotal: 0,
      },
      {
        id: "card-metrics",
        boardId: BOARD_ID,
        listId: "list-doing",
        name: "Ship the metrics endpoint",
        position: 65536,
        commentsTotal: 0,
      },
      // Lives in the archive list: must not appear in cards or list counts.
      {
        id: "card-archived",
        boardId: BOARD_ID,
        listId: "list-archive",
        name: "Old thing",
        prevListId: "list-done",
        position: 65536,
        commentsTotal: 0,
      },
    ],
    cardLabels: [
      { id: "cl-1", cardId: "card-login", labelId: "label-bug" },
      { id: "cl-2", cardId: "card-login", labelId: "label-urgent" },
    ],
    cardMemberships: [{ id: "cm-1", cardId: "card-login", userId: "user-jane" }],
    taskLists: [{ id: "tl-1", cardId: "card-login", name: "Tasks", position: 65536 }],
    tasks: [
      { id: "task-1", taskListId: "tl-1", name: "Reproduce", isCompleted: true, position: 65536 },
      { id: "task-2", taskListId: "tl-1", name: "Write the migration", isCompleted: false, position: 131072 },
      { id: "task-3", taskListId: "tl-1", name: "Deploy", isCompleted: false, position: 196608 },
    ],
  },
};
