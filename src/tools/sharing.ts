/**
 * Sharing: giving somebody else access to what this account created.
 *
 * The problem this solves is specific to running the server under its own
 * Planka account. Everything it creates belongs to that account and to nobody
 * else: `POST /projects` makes the caller the only project manager, and
 * `POST /projects/{id}/boards` makes it the only board member. A human looking
 * at the same instance sees none of it.
 *
 * Planka offers two unrelated levers, and the difference is not cosmetic:
 *
 *   - a **project manager** (`POST /projects/{id}/project-managers`) administers
 *     the project and sees all of its boards — but is refused outright on a
 *     project created with `visibility: private`, which Planka treats as a
 *     personal project owned by one account (403 "Not enough rights", verified
 *     against 2.2.1). Such a project can never gain a second manager.
 *   - a **board member** (`POST /boards/{id}/board-memberships`) gets one board,
 *     as editor or viewer — and this works even on a personal project's board.
 *
 * That asymmetry is why board membership is the default here: it is the only
 * lever that always works, including on the personal projects this server
 * created before it could share them.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { PlankaError } from "../errors.js";
import { reference, responseFormatField } from "../schemas/common.js";
import { invalidateBoard, invalidateProjects } from "../services/board-cache.js";
import { apiRequest } from "../services/client.js";
import { lines, respond, toolFailure } from "../services/format.js";
import { resolveNamed, resolveProject } from "../services/resolve.js";
import { resolveUser } from "../services/users.js";
import type {
  BoardRef,
  ItemResponse,
  PlankaBoardMembership,
  PlankaProjectManager,
  UserSummary,
} from "../types.js";

const shareShape = {
  project: reference("Project", "Infrastructure"),
  user: z
    .string()
    .min(1)
    .describe(
      'Person to share with — their Planka display name, username, email or id. Example: "jerome".',
    ),
  role: z
    .enum(["editor", "viewer", "manager"])
    .default("editor")
    .describe(
      "`editor` (default) — member of the project's boards, may change cards. `viewer` — " +
        "same boards, read-only. `manager` — project manager: administers the project and " +
        "sees every board, but is refused on a project created with visibility=private.",
    ),
  boards: z
    .array(z.string().min(1))
    .optional()
    .describe(
      'Restrict an `editor`/`viewer` share to these boards, by name or id. Example: ["Roadmap"]. ' +
        "Default: every board of the project. Not accepted with `manager`, which is project-wide.",
    ),
  can_comment: z
    .boolean()
    .optional()
    .describe("Viewers only: let them comment on cards. Ignored for the other roles."),
  response_format: responseFormatField,
};
type ShareArgs = z.infer<z.ZodObject<typeof shareShape>>;

/** What one share attempt did, so an existing membership is not an error. */
type Outcome = "shared" | "already";

/**
 * Planka answers 409 when the person is already a manager or a member.
 *
 * That is the desired end state, not a failure: sharing twice — an agent
 * retrying, or a second board added later — must be a no-op rather than an
 * error the agent has to interpret.
 */
function isAlreadyShared(error: unknown): boolean {
  return error instanceof PlankaError && error.status === 409;
}

/** Exported for the tests: the 409/403 translation is the whole point of this tool. */
export async function addManager(projectId: string, userId: string, projectName: string): Promise<Outcome> {
  try {
    await apiRequest<ItemResponse<PlankaProjectManager>>(`/projects/${projectId}/project-managers`, {
      method: "POST",
      body: { userId },
    });
    return "shared";
  } catch (error) {
    if (isAlreadyShared(error)) return "already";
    // The 403 here is almost never a rights problem on the account: it is
    // Planka refusing a second manager on a personal project. Saying so, and
    // naming the way out, is the whole value of this tool over a raw call.
    if (error instanceof PlankaError && error.status === 403) {
      throw new PlankaError(
        `Planka refuses a second manager on "${projectName}" (403).`,
        403,
        `This is a personal project — it was created with visibility=private, and Planka ` +
          `allows exactly one manager on those, for the lifetime of the project. Share its ` +
          `boards instead (role="editor"), which works on a personal project, or recreate the ` +
          `project with visibility="shared" if you need shared administration.`,
      );
    }
    throw error;
  }
}

/** Exported for the tests, alongside `addManager`. */
export async function addBoardMember(
  boardId: string,
  userId: string,
  role: "editor" | "viewer",
  canComment: boolean | undefined,
): Promise<Outcome> {
  try {
    await apiRequest<ItemResponse<PlankaBoardMembership>>(`/boards/${boardId}/board-memberships`, {
      method: "POST",
      body: {
        userId,
        role,
        // Planka only reads this for viewers; sending it for an editor is
        // meaningless, and an editor may comment regardless.
        ...(role === "viewer" && canComment !== undefined ? { canComment } : {}),
      },
    });
    return "shared";
  } catch (error) {
    if (isAlreadyShared(error)) return "already";
    throw error;
  }
}

/** How to name the person in the reply: the display name, disambiguated if it is not unique-ish. */
function describeUser(user: UserSummary): string {
  return user.username && user.username !== user.name ? `${user.name} (${user.username})` : user.name;
}

export function registerSharingTools(server: McpServer): void {
  server.registerTool(
    "planka_share_project",
    {
      title: "Share a Planka project",
      description: `Give another Planka user access to a project this account created.

Anything created through this server belongs to the account behind the API key and to nobody
else, so a human on the same instance cannot see it until it is shared.

\`editor\` (default) and \`viewer\` add the person to the project's boards — one membership per
board, all of them unless \`boards\` narrows it. This works on every project, including a
personal one.

\`manager\` makes them a project manager instead: full administration, every board, current
and future. Planka refuses it on a project created with visibility=private — a personal
project keeps exactly one manager for life — in which case share the boards instead.

Being a project manager does not make somebody assignable on cards: only board members can
be assigned, so add them as \`editor\` too if they should take cards.

Calling it twice is safe: an existing membership is reported, not re-created.

Returns: the boards shared, and the ones the person already had.

Examples:
  - Use when: "give jerome access to Infrastructure" -> project="Infrastructure", user="jerome"
  - Use when: read-only access to one board -> role="viewer", boards=["Roadmap"]
  - Use when: they should administer the project -> role="manager"
  - Don't use when: assigning somebody to a card (use planka_assign_card_member)`,
      inputSchema: shareShape,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        // Repeating the call converges on the same state: 409s are absorbed.
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async (args: ShareArgs) => {
      try {
        const project = await resolveProject(args.project);
        const user = await resolveUser(args.user);
        const who = describeUser(user);

        if (args.role === "manager") {
          if (args.boards) {
            throw new PlankaError(
              `\`boards\` cannot be combined with role="manager".`,
              undefined,
              `A project manager holds the whole project, not a subset of its boards. Drop ` +
                `\`boards\`, or use role="editor" to share only some of them.`,
            );
          }

          const outcome = await addManager(project.id, user.id, project.name);
          invalidateProjects();

          return respond(
            args.response_format,
            lines(
              outcome === "shared"
                ? `**${who}** is now a manager of **${project.name}** — every board of the project, current and future.`
                : `**${who}** was already a manager of **${project.name}**. Nothing to do.`,
              `A manager is not assignable on cards; share as "editor" too if they should take cards.`,
            ),
            {
              project: project.name,
              user: { id: user.id, name: user.name },
              role: "manager",
              status: outcome,
            },
          );
        }

        const targets: BoardRef[] = args.boards
          ? args.boards.map((board) =>
              resolveNamed(
                project.boards,
                board,
                "Board",
                `in project "${project.name}"`,
                "Call planka_list_projects to see the boards of this project.",
              ),
            )
          : project.boards;

        if (targets.length === 0) {
          throw new PlankaError(
            `Project "${project.name}" has no board to share.`,
            undefined,
            `A board membership is the only thing a role of "${args.role}" can grant. Create a ` +
              `board first with planka_create_board, or use role="manager" to share the project itself.`,
          );
        }

        const shared: string[] = [];
        const already: string[] = [];
        for (const board of targets) {
          const outcome = await addBoardMember(board.id, user.id, args.role, args.can_comment);
          if (outcome === "shared") {
            shared.push(board.name);
            // The snapshot's member list is now stale, and it is what
            // planka_assign_card_member resolves names against.
            invalidateBoard(board.id);
          } else {
            already.push(board.name);
          }
        }

        return respond(
          args.response_format,
          lines(
            shared.length > 0
              ? `Shared **${project.name}** with **${who}** as ${args.role} on ${shared.length} board(s): ${shared.join(" · ")}.`
              : `**${who}** already had every board asked for on **${project.name}**. Nothing to do.`,
            already.length > 0 && shared.length > 0
              ? `Already a member of: ${already.join(" · ")}.`
              : undefined,
            shared.length > 0 && args.role === "viewer" && args.can_comment !== true
              ? `As a viewer they cannot comment; pass can_comment=true if they should.`
              : undefined,
          ),
          {
            project: project.name,
            user: { id: user.id, name: user.name },
            role: args.role,
            shared,
            already_member: already,
          },
        );
      } catch (error) {
        return toolFailure(error);
      }
    },
  );
}
