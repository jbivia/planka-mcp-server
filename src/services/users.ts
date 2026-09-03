/**
 * Instance users.
 *
 * Every other resolver in this server works inside a board, where `included`
 * already carries the people involved. Sharing is the one operation that has to
 * name somebody who is *not* a member yet, so it needs the instance-wide list —
 * a different route, with a different permission, and worth isolating here.
 *
 * `GET /users` requires the `admin` or `projectOwner` role. An account that has
 * neither can still share, but only by passing a raw user id: hence the id path
 * below, which never touches the listing.
 */

import { loadConfig } from "../config.js";
import { PlankaError } from "../errors.js";
import type { ItemResponse, ItemsResponse, PlankaUser, UserSummary } from "../types.js";
import { apiRequest } from "./client.js";
import { looksLikeId, resolveNamed } from "./resolve.js";

interface UserCache {
  users: UserSummary[];
  fetchedAt: number;
}

let userCache: UserCache | undefined;

function project(user: PlankaUser): UserSummary {
  return {
    id: user.id,
    name: user.name?.trim() || user.username?.trim() || user.id,
    ...(user.username ? { username: user.username } : {}),
    ...(user.email ? { email: user.email } : {}),
  };
}

/**
 * Everyone on the instance, minus the deactivated accounts.
 *
 * A deactivated user cannot open a board, so offering one as a share target
 * would only produce a membership nobody can use.
 */
export async function getUsers(force = false): Promise<UserSummary[]> {
  if (!force && userCache && Date.now() - userCache.fetchedAt < loadConfig().cacheTtlMs) {
    return userCache.users;
  }

  let response: ItemsResponse<PlankaUser>;
  try {
    response = await apiRequest<ItemsResponse<PlankaUser>>("/users");
  } catch (error) {
    if (error instanceof PlankaError && error.status === 403) {
      throw new PlankaError(
        `This Planka account may not list the instance's users (403).`,
        403,
        `Listing users needs the admin or project owner role. Either give the account that ` +
          `role in Planka > Administration > Users, or pass the target user's Planka id ` +
          `instead of a name — an id is looked up directly and needs no extra rights.`,
      );
    }
    throw error;
  }

  const users = (response.items ?? []).filter((user) => !user.isDeactivated).map(project);
  userCache = { users, fetchedAt: Date.now() };
  return users;
}

/** Test seam, and a way out if an account is created while the server runs. */
export function invalidateUsers(): void {
  userCache = undefined;
}

/**
 * Resolve a person by id, username, email or display name.
 *
 * An id is fetched from `/users/{id}` rather than searched in the listing, so
 * that an account without the listing permission can still share by id.
 */
export async function resolveUser(reference: string): Promise<UserSummary> {
  const trimmed = reference.trim();
  if (trimmed === "") {
    throw new PlankaError(`Empty user reference.`, undefined, `Pass a name, username, email or id.`);
  }

  if (looksLikeId(trimmed)) {
    try {
      const response = await apiRequest<ItemResponse<PlankaUser>>(`/users/${trimmed}`);
      if (response.item) return project(response.item);
    } catch (error) {
      // A 404 means it was a name that merely looks like an id; anything else
      // (403, network) is a real failure and must not be swallowed.
      if (!(error instanceof PlankaError && error.status === 404)) throw error;
    }
  }

  const users = await getUsers();
  const needle = trimmed.toLowerCase();
  const direct = users.find(
    (user) =>
      user.username?.trim().toLowerCase() === needle || user.email?.trim().toLowerCase() === needle,
  );
  if (direct) return direct;

  return resolveNamed(
    users,
    trimmed,
    "User",
    "on this Planka instance",
    "Pass the person's Planka username, email or id. Deactivated accounts are not listed.",
  );
}
