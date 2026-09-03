/**
 * Structural creation: projects, boards and lists.
 *
 * These sit apart from the card lifecycle on purpose. Creating a container is a
 * rarer and more consequential act than moving a ticket, and Planka offers no
 * undo for it — this server exposes no way to delete any of them, so a mistake
 * here has to be cleaned up in the Planka UI.
 *
 * Hence the duplicate guard on all three. Planka happily accepts two boards
 * called "Roadmap" in one project; an agent that retries after a timeout would
 * create the second one, and every name-based lookup on that board would be
 * ambiguous from then on. Refusing, and naming what already exists, keeps the
 * resolution layer usable.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { POSITION_STEP } from "../constants.js";
import { PlankaError } from "../errors.js";
import { projectField, responseFormatField } from "../schemas/common.js";
import {
  getBoardSnapshot,
  getProjects,
  invalidateBoard,
  invalidateProjects,
} from "../services/board-cache.js";
import { apiRequest } from "../services/client.js";
import { lines, respond, toolFailure } from "../services/format.js";
import { appendPosition } from "../services/position.js";
import { resolveBoard, resolveProject } from "../services/resolve.js";
import type { ItemResponse, PlankaBoard, PlankaList, PlankaProject } from "../types.js";

/**
 * Refuse a name that a sibling already carries.
 *
 * Comparison is case-insensitive and trimmed, matching how `resolve.ts` looks
 * names up — a board called "roadmap" would shadow "Roadmap" just as badly.
 *
 * Exported for the unit tests: it is the whole guard, and it is worth pinning
 * independently of the three tools that call it.
 */
export function refuseDuplicate(
  existing: readonly { id: string; name: string }[],
  name: string,
  kind: string,
  scope: string,
): void {
  const needle = name.trim().toLowerCase();
  const clash = existing.find((item) => item.name.trim().toLowerCase() === needle);
  if (clash) {
    throw new PlankaError(
      `A ${kind} named "${clash.name}" already exists ${scope} (id ${clash.id}).`,
      undefined,
      `Names are how every other tool addresses things here, so a duplicate would make ` +
        `both unreachable by name. Pick a different name, or use the existing one.`,
    );
  }
}

/* -------------------------------------------------------------------------- */
/* planka_create_project                                                       */
/* -------------------------------------------------------------------------- */

const createProjectShape = {
  name: z.string().min(1).describe('Project name. Example: "Infrastructure".'),
  description: z.string().optional().describe("Optional short description of the project."),
  visibility: z
    .enum(["private", "shared"])
    .default("private")
    .describe(
      "`private` (default) — a personal project: this account is its only manager, for life. " +
        "`shared` — a team project, visible to the instance's admins and open to further " +
        "managers. Only `shared` can later be handed to somebody else with planka_share_project; " +
        "either way, individual boards can be shared.",
    ),
  response_format: responseFormatField,
};
type CreateProjectArgs = z.infer<z.ZodObject<typeof createProjectShape>>;

/* -------------------------------------------------------------------------- */
/* planka_create_board                                                         */
/* -------------------------------------------------------------------------- */

const createBoardShape = {
  project: z.string().min(1).describe('Project to create the board in, by name or id. Example: "Infrastructure".'),
  name: z.string().min(1).describe('Board name. Example: "Roadmap".'),
  lists: z
    .array(z.string().min(1))
    .optional()
    .describe(
      'Columns to create straight away, in order. Example: ["Backlog", "En cours", "Terminé"]. ' +
        "A board with no list cannot hold a card, so pass this unless you intend to add lists yourself.",
    ),
  response_format: responseFormatField,
};
type CreateBoardArgs = z.infer<z.ZodObject<typeof createBoardShape>>;

/* -------------------------------------------------------------------------- */
/* planka_create_list                                                          */
/* -------------------------------------------------------------------------- */

const createListShape = {
  board: z.string().min(1).describe('Board to add the list to, by name or id. Example: "Roadmap".'),
  project: projectField,
  name: z.string().min(1).describe('List name. Example: "En revue".'),
  kind: z
    .enum(["active", "closed"])
    .default("active")
    .describe(
      "`active` (default) — an ordinary column. `closed` — an end-of-flow column; moving a " +
        "card into it marks the card closed in Planka.",
    ),
  response_format: responseFormatField,
};
type CreateListArgs = z.infer<z.ZodObject<typeof createListShape>>;

/* -------------------------------------------------------------------------- */

/** Create one list on a board, at the end of the current ones. */
async function createList(
  boardId: string,
  name: string,
  kind: "active" | "closed",
  siblings: readonly { id: string; position?: number | null }[],
): Promise<PlankaList> {
  const response = await apiRequest<ItemResponse<PlankaList>>(`/boards/${boardId}/lists`, {
    method: "POST",
    body: { type: kind, name, position: appendPosition(siblings) },
  });
  return response.item;
}

export function registerStructureTools(server: McpServer): void {
  server.registerTool(
    "planka_create_project",
    {
      title: "Create a Planka project",
      description: `Create a project — the top-level container that holds boards.

Refuses if a project of that name already exists, naming it, because every other tool
addresses things by name and a duplicate would make both unreachable.

This server cannot delete a project, and Planka refuses to delete one that still has
boards, so treat this as a deliberate act rather than a scratch space.

Returns: the new project's name and id.

Examples:
  - Use when: "create a project called Infrastructure" -> name="Infrastructure"
  - Don't use when: the project exists (call planka_list_projects to check)`,
      inputSchema: createProjectShape,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        // A second call fails on the duplicate guard rather than being a no-op.
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async (args: CreateProjectArgs) => {
      try {
        refuseDuplicate(await getProjects(), args.name, "project", "on this Planka instance");

        const response = await apiRequest<ItemResponse<PlankaProject>>("/projects", {
          method: "POST",
          body: {
            type: args.visibility,
            name: args.name,
            ...(args.description !== undefined ? { description: args.description } : {}),
          },
        });
        invalidateProjects();

        const created = response.item;
        return respond(
          args.response_format,
          lines(
            `Created project **${created.name}** (${args.visibility}) — id \`${created.id}\`.`,
            "It has no board yet. Use planka_create_board to add one.",
          ),
          { id: created.id, name: created.name, visibility: args.visibility },
        );
      } catch (error) {
        return toolFailure(error);
      }
    },
  );

  server.registerTool(
    "planka_create_board",
    {
      title: "Create a Planka board",
      description: `Create a board inside a project, optionally with its columns.

Pass \`lists\` to get a usable board in one call: a board created without any list has only
Planka's hidden archive and trash lists, so planka_create_card would fail on it.

Refuses if the project already has a board of that name.

Returns: the new board's id, and the lists created with it.

Examples:
  - Use when: "new board Roadmap on Infrastructure with Backlog, Doing, Done"
      -> project="Infrastructure", name="Roadmap", lists=["Backlog","Doing","Done"]
  - Use when: you will add the columns yourself -> omit \`lists\`
  - Don't use when: you only need one more column on an existing board (use planka_create_list)`,
      inputSchema: createBoardShape,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async (args: CreateBoardArgs) => {
      try {
        const project = await resolveProject(args.project);
        refuseDuplicate(project.boards, args.name, "board", `in project "${project.name}"`);

        // The one multipart endpoint in the API: it doubles as the Trello
        // import route, and rejects a JSON body.
        const response = await apiRequest<ItemResponse<PlankaBoard>>(
          `/projects/${project.id}/boards`,
          {
            method: "POST",
            form: { name: args.name, position: appendPosition(project.boards) },
          },
        );
        const board = response.item;

        // Lists are created one by one, each placed after the previous: Planka
        // has no bulk endpoint, and the order the caller gave is the order the
        // columns should appear in.
        const created: string[] = [];
        const siblings: { id: string; position: number }[] = [];
        for (const listName of args.lists ?? []) {
          const list = await createList(board.id, listName, "active", siblings);
          created.push(list.name ?? listName);
          siblings.push({ id: list.id, position: list.position ?? (siblings.length + 1) * POSITION_STEP });
        }

        invalidateProjects();
        invalidateBoard(board.id);

        return respond(
          args.response_format,
          lines(
            `Created board **${board.name}** in ${project.name} — id \`${board.id}\`.`,
            created.length > 0
              ? `Lists: ${created.join(" · ")}`
              : "It has no list yet, so it cannot hold a card. Use planka_create_list.",
          ),
          { id: board.id, name: board.name, project: project.name, lists: created },
        );
      } catch (error) {
        return toolFailure(error);
      }
    },
  );

  server.registerTool(
    "planka_create_list",
    {
      title: "Create a Planka list",
      description: `Add a column to a board, at the end of the existing ones.

Refuses if the board already has a list of that name.

Planka's own archive and trash lists are created with the board and cannot be added or
renamed here; \`kind\` only chooses between an ordinary column and an end-of-flow one.

Returns: the new list's name, kind and id.

Examples:
  - Use when: "add an 'En revue' column to Roadmap" -> board="Roadmap", name="En revue"
  - Use when: adding a done column -> name="Terminé", kind="closed"
  - Don't use when: creating a whole board (use planka_create_board with \`lists\`)`,
      inputSchema: createListShape,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async (args: CreateListArgs) => {
      try {
        const board = await resolveBoard(args.board, args.project);
        const snapshot = await getBoardSnapshot(board.id);

        // Only user lists are compared: archive and trash carry a null name
        // upstream and are rendered "(archive)"/"(trash)", so they cannot clash.
        const userLists = snapshot.lists.filter(
          (list) => list.type === "active" || list.type === "closed",
        );
        refuseDuplicate(userLists, args.name, "list", `on board "${snapshot.name}"`);

        const list = await createList(board.id, args.name, args.kind, userLists);
        invalidateBoard(board.id);

        return respond(
          args.response_format,
          `Created list **${list.name ?? args.name}** (${args.kind}) on ${snapshot.name} — id \`${list.id}\`.`,
          { id: list.id, name: list.name ?? args.name, kind: args.kind, board: snapshot.name },
        );
      } catch (error) {
        return toolFailure(error);
      }
    },
  );
}
