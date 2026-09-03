/**
 * Everything hanging off a card: members, labels, comments and tasks.
 *
 * Add/remove pairs are single tools with an `action`, rather than eight
 * near-identical tools — the argument list is the same either way and the
 * agent picks a direction, not a different endpoint.
 *
 * Tasks are the part of Planka 2.x that differs most from 1.x: a card owns
 * task *lists*, and tasks live inside those. A card created through the API has
 * none, so adding the first task means creating a task list first.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { PlankaError, quoteList } from "../errors.js";
import { boardField, cardField, projectField } from "../schemas/common.js";
import { invalidateBoard } from "../services/board-cache.js";
import { locateCard } from "../services/card.js";
import { apiRequest } from "../services/client.js";
import { toolFailure, toolSuccess } from "../services/format.js";
import { appendPosition } from "../services/position.js";
import { projectTasks } from "../services/project.js";
import { resolveLabel, resolveMember } from "../services/resolve.js";
import type { ItemResponse, PlankaComment, PlankaIncluded, PlankaTask, PlankaTaskList } from "../types.js";

/** Name given to the task list created for a card that has none yet. */
const DEFAULT_TASK_LIST_NAME = "Tasks";

const cardLocatorShape = {
  card: cardField,
  board: boardField.optional().describe("Board the card is on. Recommended, and required for duplicate titles."),
  project: projectField,
};

/* -------------------------------------------------------------------------- */
/* planka_assign_card_member                                                   */
/* -------------------------------------------------------------------------- */

const assignMemberShape = {
  ...cardLocatorShape,
  member: z
    .string()
    .min(1)
    .describe('Board member, by display name, username or id. Example: "Jane Doe" or "jdoe".'),
  action: z
    .enum(["assign", "unassign"])
    .default("assign")
    .describe("`assign` (default) adds the member to the card, `unassign` removes them."),
};
type AssignMemberArgs = z.infer<z.ZodObject<typeof assignMemberShape>>;

/* -------------------------------------------------------------------------- */
/* planka_set_card_label                                                       */
/* -------------------------------------------------------------------------- */

const setLabelShape = {
  ...cardLocatorShape,
  label: z.string().min(1).describe('Label defined on this board, by name or id. Example: "bug".'),
  action: z
    .enum(["add", "remove"])
    .default("add")
    .describe("`add` (default) puts the label on the card, `remove` takes it off."),
};
type SetLabelArgs = z.infer<z.ZodObject<typeof setLabelShape>>;

/* -------------------------------------------------------------------------- */
/* planka_add_comment                                                          */
/* -------------------------------------------------------------------------- */

const addCommentShape = {
  ...cardLocatorShape,
  text: z.string().min(1).describe("Comment body, in Markdown."),
};
type AddCommentArgs = z.infer<z.ZodObject<typeof addCommentShape>>;

/* -------------------------------------------------------------------------- */
/* planka_manage_card_tasks                                                    */
/* -------------------------------------------------------------------------- */

const manageTasksShape = {
  ...cardLocatorShape,
  action: z
    .enum(["add", "complete", "uncomplete", "remove"])
    .describe("`add` a new task, `complete` / `uncomplete` an existing one, or `remove` it."),
  task: z
    .string()
    .min(1)
    .describe(
      'The task: its text when adding, or the text/id of an existing task otherwise. ' +
        'Example: "Write the migration".',
    ),
  task_list: z
    .string()
    .optional()
    .describe(
      `Which task list to add to, by name. Defaults to the card's first one, or creates ` +
        `"${DEFAULT_TASK_LIST_NAME}" if the card has none.`,
    ),
};
type ManageTasksArgs = z.infer<z.ZodObject<typeof manageTasksShape>>;

/** Read a card's task lists and tasks straight from the card route. */
async function readTaskState(cardId: string): Promise<{
  taskLists: PlankaTaskList[];
  tasks: ReturnType<typeof projectTasks>;
  included: PlankaIncluded | undefined;
}> {
  const response = await apiRequest<ItemResponse<unknown, PlankaIncluded>>(`/cards/${cardId}`);
  return {
    taskLists: response.included?.taskLists ?? [],
    tasks: projectTasks(response.included),
    included: response.included,
  };
}

export function registerAttributeTools(server: McpServer): void {
  server.registerTool(
    "planka_assign_card_member",
    {
      title: "Assign or unassign a Planka card member",
      description: `Add a board member to a card, or take them off it.

Only members of the card's board can be assigned; a name that is not one fails with the
board's member list, so you can pick the right person without a second lookup.

Returns: confirmation naming the member and the card.

Examples:
  - Use when: "give the login bug to Jane" -> card="Fix the login redirect", member="Jane Doe"
  - Use when: "take me off it" -> member="jdoe", action="unassign"`,
      inputSchema: assignMemberShape,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async (args: AssignMemberArgs) => {
      try {
        const located = await locateCard(args.card, args.board, args.project);
        const member = resolveMember(located.snapshot, args.member);

        if (args.action === "assign") {
          await apiRequest(`/cards/${located.card.id}/card-memberships`, {
            method: "POST",
            body: { userId: member.id },
          });
        } else {
          // The membership row is addressed by a literal `userId:<id>` path
          // segment, so no separate lookup of the join row's own id is needed.
          await apiRequest(`/cards/${located.card.id}/card-memberships/userId:${member.id}`, {
            method: "DELETE",
          });
        }
        invalidateBoard(located.snapshot.id);

        return toolSuccess(
          args.action === "assign"
            ? `Assigned **${member.name}** to "${located.card.name}".`
            : `Unassigned **${member.name}** from "${located.card.name}".`,
          { card_id: located.card.id, member: member.name, action: args.action },
        );
      } catch (error) {
        return toolFailure(error);
      }
    },
  );

  server.registerTool(
    "planka_set_card_label",
    {
      title: "Add or remove a Planka card label",
      description: `Put a label on a card, or take it off.

Labels belong to a board — one that exists on another board cannot be used here, and this
tool only applies labels that already exist. Call planka_describe_board to see what a board
offers, and planka_create_label if it offers nothing (a board created through the API starts
with no label at all).

Returns: confirmation naming the label and the card.

Examples:
  - Use when: "tag it as a bug" -> card="Fix the login redirect", label="bug"
  - Use when: "it's not urgent any more" -> label="urgent", action="remove"`,
      inputSchema: setLabelShape,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async (args: SetLabelArgs) => {
      try {
        const located = await locateCard(args.card, args.board, args.project);
        const label = resolveLabel(located.snapshot, args.label);

        if (args.action === "add") {
          await apiRequest(`/cards/${located.card.id}/card-labels`, {
            method: "POST",
            body: { labelId: label.id },
          });
        } else {
          await apiRequest(`/cards/${located.card.id}/card-labels/labelId:${label.id}`, {
            method: "DELETE",
          });
        }
        invalidateBoard(located.snapshot.id);

        return toolSuccess(
          args.action === "add"
            ? `Added label **${label.name}** to "${located.card.name}".`
            : `Removed label **${label.name}** from "${located.card.name}".`,
          { card_id: located.card.id, label: label.name, action: args.action },
        );
      } catch (error) {
        return toolFailure(error);
      }
    },
  );

  server.registerTool(
    "planka_add_comment",
    {
      title: "Comment on a Planka card",
      description: `Post a comment on a card.

The comment is attributed to the account behind PLANKA_TOKEN, so say who or what is
writing when it matters.

Returns: confirmation with the new comment's id.

Examples:
  - Use when: "note on the card that the fix is deployed" -> card="Fix the login redirect", text="Deployed in 2.4.1."
  - Don't use when: the information belongs in the card body (use planka_update_card)`,
      inputSchema: addCommentShape,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        // Posting the same text twice leaves two comments.
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async (args: AddCommentArgs) => {
      try {
        const located = await locateCard(args.card, args.board, args.project);
        const response = await apiRequest<ItemResponse<PlankaComment>>(
          `/cards/${located.card.id}/comments`,
          { method: "POST", body: { text: args.text } },
        );
        invalidateBoard(located.snapshot.id);

        return toolSuccess(`Commented on "${located.card.name}".`, {
          card_id: located.card.id,
          comment_id: response.item?.id,
        });
      } catch (error) {
        return toolFailure(error);
      }
    },
  );

  server.registerTool(
    "planka_manage_card_tasks",
    {
      title: "Manage a Planka card's tasks",
      description: `Add a task to a card, tick it off, untick it, or delete it.

In Planka 2.x tasks live inside task lists, not directly on the card. A card created
through the API has no task list, so the first \`add\` creates one called
"${DEFAULT_TASK_LIST_NAME}" — pass \`task_list\` to use or create a different one.

For \`complete\`, \`uncomplete\` and \`remove\`, \`task\` matches an existing task by its
text (or its id); an ambiguous match fails with the candidates rather than guessing.

Returns: confirmation and the card's new task progress, e.g. "3/7 done".

Examples:
  - Use when: "add 'write the migration' to the checklist" -> action="add", task="Write the migration"
  - Use when: "tick off the migration task" -> action="complete", task="Write the migration"
  - Don't use when: you want the whole checklist (use planka_get_card)`,
      inputSchema: manageTasksShape,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        // `add` appends every time; the other three converge on one state.
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async (args: ManageTasksArgs) => {
      try {
        const located = await locateCard(args.card, args.board, args.project);
        const state = await readTaskState(located.card.id);

        if (args.action === "add") {
          let taskListId = args.task_list
            ? state.taskLists.find(
                (list) => list.name.trim().toLowerCase() === args.task_list?.trim().toLowerCase(),
              )?.id
            : state.taskLists[0]?.id;

          if (!taskListId) {
            const created = await apiRequest<ItemResponse<PlankaTaskList>>(
              `/cards/${located.card.id}/task-lists`,
              {
                method: "POST",
                body: {
                  name: args.task_list ?? DEFAULT_TASK_LIST_NAME,
                  position: appendPosition(state.taskLists),
                },
              },
            );
            taskListId = created.item.id;
          }

          const siblings = (state.included?.tasks ?? []).filter(
            (task) => task.taskListId === taskListId,
          );
          await apiRequest<ItemResponse<PlankaTask>>(`/task-lists/${taskListId}/tasks`, {
            method: "POST",
            body: { name: args.task, position: appendPosition(siblings) },
          });
          invalidateBoard(located.snapshot.id);

          const after = await readTaskState(located.card.id);
          const done = after.tasks.filter((task) => task.isCompleted).length;
          return toolSuccess(
            `Added task "${args.task}" to "${located.card.name}". Now ${done}/${after.tasks.length} done.`,
            { card_id: located.card.id, progress: `${done}/${after.tasks.length}` },
          );
        }

        /* The three actions below all operate on an existing task. */
        const needle = args.task.trim().toLowerCase();
        const hits = state.tasks.filter(
          (task) => task.id === args.task.trim() || task.name.trim().toLowerCase() === needle,
        );

        if (hits.length === 0) {
          throw new PlankaError(
            `Task "${args.task}" not found on "${located.card.name}".`,
            undefined,
            state.tasks.length === 0
              ? `This card has no tasks. Use action="add" to create one.`
              : `Its tasks are: ${quoteList(state.tasks.map((task) => task.name))}.`,
          );
        }
        if (hits.length > 1) {
          throw new PlankaError(
            `Task "${args.task}" matches ${hits.length} tasks on "${located.card.name}".`,
            undefined,
            `Use the task id, which planka_get_card reports next to each task.`,
          );
        }

        const task = hits[0] as (typeof hits)[number];
        if (args.action === "remove") {
          await apiRequest(`/tasks/${task.id}`, { method: "DELETE" });
        } else {
          await apiRequest(`/tasks/${task.id}`, {
            method: "PATCH",
            body: { isCompleted: args.action === "complete" },
          });
        }
        invalidateBoard(located.snapshot.id);

        const after = await readTaskState(located.card.id);
        const done = after.tasks.filter((entry) => entry.isCompleted).length;
        const verb =
          args.action === "remove" ? "Removed" : args.action === "complete" ? "Completed" : "Reopened";

        return toolSuccess(
          `${verb} task "${task.name}" on "${located.card.name}". Now ${done}/${after.tasks.length} done.`,
          { card_id: located.card.id, task_id: task.id, progress: `${done}/${after.tasks.length}` },
        );
      } catch (error) {
        return toolFailure(error);
      }
    },
  );
}
