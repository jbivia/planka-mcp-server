/**
 * Structural creation: projects, boards, lists and labels.
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
import { LABEL_COLORS, POSITION_STEP } from "../constants.js";
import type { LabelColor } from "../constants.js";
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
import type {
  ItemResponse,
  PlankaBoard,
  PlankaLabel,
  PlankaList,
  PlankaProject,
} from "../types.js";

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
  labels: z
    .array(z.string().min(1))
    .optional()
    .describe(
      'Labels to create with the board. Example: ["bug", "urgent"]. A board created through ' +
        "the API starts with none at all — unlike one created in the Planka UI — so pass this " +
        "if cards on it are meant to be tagged. Each gets a distinct colour.",
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
/* planka_create_label                                                         */
/* -------------------------------------------------------------------------- */

const createLabelShape = {
  board: z.string().min(1).describe('Board to create the label on, by name or id. Example: "Roadmap".'),
  project: projectField,
  name: z.string().min(1).describe('Label name. Example: "bug".'),
  color: z
    .enum(LABEL_COLORS)
    .optional()
    .describe(
      "One of Planka's colour names. Omit it — the default picks the first colour the board " +
        "is not already using, which is what keeps labels telling apart at a glance.",
    ),
  response_format: responseFormatField,
};
type CreateLabelArgs = z.infer<z.ZodObject<typeof createLabelShape>>;

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

/**
 * Choose a colour for a new label.
 *
 * Planka requires one, and two labels sharing a colour are indistinguishable in
 * the card view — the one place labels are actually read. So the default is the
 * first palette entry the board has not spent yet, and only a board that has
 * burned all 42 falls back to rotating.
 *
 * Exported for the tests: the exhaustion case is easy to get wrong and
 * impossible to notice until a board is very large.
 */
export function pickLabelColor(used: readonly (string | null | undefined)[]): LabelColor {
  const taken = new Set(used.filter((color): color is string => Boolean(color)));
  const unused = LABEL_COLORS.find((color) => !taken.has(color));
  return unused ?? (LABEL_COLORS[taken.size % LABEL_COLORS.length] as LabelColor);
}

/** Create one label on a board, after the existing ones. */
async function createLabel(
  boardId: string,
  name: string,
  color: LabelColor,
  siblings: readonly { id: string; position?: number | null }[],
): Promise<PlankaLabel> {
  const response = await apiRequest<ItemResponse<PlankaLabel>>(`/boards/${boardId}/labels`, {
    method: "POST",
    body: { name, color, position: appendPosition(siblings) },
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

Pass \`labels\` to get the tags too: a board created through the API has none, where one
created in the Planka UI comes with a starter set.

Refuses if the project already has a board of that name.

Returns: the new board's id, and the lists and labels created with it.

Examples:
  - Use when: "new board Roadmap on Infrastructure with Backlog, Doing, Done"
      -> project="Infrastructure", name="Roadmap", lists=["Backlog","Doing","Done"]
  - Use when: cards on it will be tagged -> labels=["bug","urgent"]
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

        // Same one-by-one walk as the lists, for the same reason: no bulk
        // endpoint, and each label needs a colour none of its siblings took.
        const labels: string[] = [];
        const labelSiblings: { id: string; position: number }[] = [];
        const colors: string[] = [];
        for (const labelName of args.labels ?? []) {
          const color = pickLabelColor(colors);
          const label = await createLabel(board.id, labelName, color, labelSiblings);
          labels.push(label.name ?? labelName);
          colors.push(color);
          labelSiblings.push({
            id: label.id,
            position: label.position ?? labelSiblings.length * POSITION_STEP + POSITION_STEP,
          });
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
            labels.length > 0 ? `Labels: ${labels.join(" · ")}` : undefined,
          ),
          {
            id: board.id,
            name: board.name,
            project: project.name,
            lists: created,
            ...(labels.length > 0 ? { labels } : {}),
          },
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

  server.registerTool(
    "planka_create_label",
    {
      title: "Create a Planka label",
      description: `Define a new label on a board, so planka_set_card_label can put it on cards.

Labels belong to a board and a board created through the API has none, so this is what makes
tagging possible there at all. Creating the board with \`labels\` does the same in one call.

Refuses if the board already has a label of that name. Colour is optional: the default takes
the first one the board is not using, which is what keeps two labels apart on a card.

A label is a taxonomy, not a note — a handful per board stays readable, thirty does not.
Prefer reusing what planka_describe_board lists over minting a near-duplicate.

Returns: the new label's name, colour and id.

Examples:
  - Use when: "tag it as a bug" and the board has no "bug" label -> board="Roadmap", name="bug"
  - Use when: a colour is asked for -> name="urgent", color="berry-red"
  - Don't use when: the label already exists (call planka_describe_board first)
  - Don't use when: putting an existing label on a card (use planka_set_card_label)`,
      inputSchema: createLabelShape,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async (args: CreateLabelArgs) => {
      try {
        const board = await resolveBoard(args.board, args.project);
        const snapshot = await getBoardSnapshot(board.id);
        refuseDuplicate(snapshot.labels, args.name, "label", `on board "${snapshot.name}"`);

        const color = args.color ?? pickLabelColor(snapshot.rawLabels.map((label) => label.color));
        const label = await createLabel(board.id, args.name, color, snapshot.rawLabels);
        invalidateBoard(board.id);

        return respond(
          args.response_format,
          `Created label **${label.name ?? args.name}** (${color}) on ${snapshot.name} — id \`${label.id}\`.`,
          { id: label.id, name: label.name ?? args.name, color, board: snapshot.name },
        );
      } catch (error) {
        return toolFailure(error);
      }
    },
  );
}
