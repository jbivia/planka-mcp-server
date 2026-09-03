/**
 * Response mapping.
 *
 * Planka's `included` blocks are a flat relational dump; these tests pin the
 * joins that turn them into names, and the exclusions that keep archived cards
 * out of ordinary results.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { projectBoard, projectComments, projectProjects, projectTasks } from "../src/services/project.js";
import { BOARD_ID, boardResponse } from "./fixtures/board.js";

const snapshot = projectBoard(boardResponse.item, boardResponse.included);

describe("projectBoard", () => {
  it("keeps lists in board order and names the system ones by their type", () => {
    assert.deepEqual(
      snapshot.lists.map((list) => list.name),
      ["Backlog", "En cours", "Done", "(archive)", "(trash)"],
    );
  });

  it("excludes cards sitting in archive or trash lists", () => {
    const ids = snapshot.cards.map((card) => card.id);
    assert.deepEqual(ids, ["card-login", "card-cert", "card-metrics"]);
    assert.ok(!ids.includes("card-archived"));
  });

  it("counts only visible cards per list", () => {
    const counts = Object.fromEntries(snapshot.lists.map((list) => [list.name, list.cardCount]));
    assert.equal(counts["Backlog"], 2);
    assert.equal(counts["En cours"], 1);
    assert.equal(counts["Done"], 0);
    assert.equal(counts["(archive)"], 0);
  });

  it("joins cardLabels and cardMemberships into names", () => {
    const card = snapshot.cards.find((candidate) => candidate.id === "card-login");
    assert.deepEqual(card?.labels, ["bug", "urgent"]);
    assert.deepEqual(card?.assignees, ["Jane Doe"]);
  });

  it("walks card -> taskLists -> tasks for progress, the 2.x shape", () => {
    const card = snapshot.cards.find((candidate) => candidate.id === "card-login");
    assert.equal(card?.taskProgress, "1/3");
  });

  it("omits task progress for a card with no tasks", () => {
    const card = snapshot.cards.find((candidate) => candidate.id === "card-cert");
    assert.equal(card?.taskProgress, undefined);
  });

  it("falls back to the colour for a label with no name", () => {
    assert.deepEqual(snapshot.labels.map((label) => label.name), ["bug", "urgent", "lagoon-blue"]);
  });

  it("resolves members through boardMemberships, keeping their role", () => {
    assert.deepEqual(snapshot.members, [
      { id: "user-jane", name: "Jane Doe", username: "jdoe", role: "editor" },
      { id: "user-john", name: "John Roe", username: "jroe", role: "viewer" },
    ]);
  });

  it("takes the card type default from the board", () => {
    assert.equal(snapshot.defaultCardType, "project");
    assert.equal(snapshot.id, BOARD_ID);
  });

  it("keeps raw cards for position arithmetic, archived ones excluded", () => {
    assert.equal(snapshot.rawCards.length, 3);
    assert.ok(snapshot.rawCards.every((card) => card.listId !== "list-archive"));
  });
});

describe("projectTasks", () => {
  it("flattens task lists into ordered tasks carrying their list name", () => {
    const tasks = projectTasks(boardResponse.included);
    assert.deepEqual(tasks.map((task) => task.name), ["Reproduce", "Write the migration", "Deploy"]);
    assert.equal(tasks[0]?.taskListName, "Tasks");
    assert.equal(tasks[0]?.isCompleted, true);
  });

  it("labels a task that is a link to another card rather than free text", () => {
    const tasks = projectTasks({
      taskLists: [{ id: "tl", cardId: "c", name: "Tasks", position: 1 }],
      tasks: [{ id: "t", taskListId: "tl", name: null, linkedCardId: "card-42", position: 1 }],
    });
    assert.equal(tasks[0]?.name, "(linked card card-42)");
  });
});

describe("projectProjects", () => {
  it("attaches each project's boards, in position order", () => {
    const projects = projectProjects(
      [
        { id: "p1", name: "Infrastructure" },
        { id: "p2", name: "Product" },
      ],
      {
        boards: [
          { id: "b2", projectId: "p1", name: "Runbook", position: 131072 },
          { id: "b1", projectId: "p1", name: "Roadmap", position: 65536 },
          { id: "b3", projectId: "p2", name: "Discovery", position: 65536 },
        ],
      },
    );
    assert.deepEqual(projects[0]?.boards.map((board) => board.name), ["Roadmap", "Runbook"]);
    assert.deepEqual(projects[1]?.boards.map((board) => board.name), ["Discovery"]);
  });
});

describe("projectComments", () => {
  it("resolves the author, and says so when the user is unknown", () => {
    const comments = projectComments(
      [
        { id: "c1", cardId: "card-login", userId: "user-jane", text: "Looking at it." },
        { id: "c2", cardId: "card-login", userId: "ghost", text: "Orphaned." },
      ],
      { users: [{ id: "user-jane", name: "Jane Doe" }] },
    );
    assert.equal(comments[0]?.author, "Jane Doe");
    assert.equal(comments[1]?.author, "(unknown)");
  });
});
