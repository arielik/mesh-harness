// Turn a provider identity into a hub user with roles (plan §4.4, §4.5).

import { rolesFor, type Role, type RoleMapping } from "../core/index.ts";
import type { HubStore, UserRow } from "../store/index.ts";
import type { Identity } from "./types.ts";

export interface IdentityPolicy {
  /** Per provider id: groups → roles. */
  roleMappings: Record<string, RoleMapping>;
  /** `provider:subject` entries that are always admins (first-admin bootstrap). */
  bootstrapAdmins: string[];
}

export interface LoggedIn {
  user: UserRow;
  roles: Role[];
}

/** Upsert identity + user at login and compute roles (re-evaluated at every login). */
export async function loginIdentity(store: HubStore, id: Identity, policy: IdentityPolicy, now: number): Promise<LoggedIn> {
  const user = await store.upsertIdentity(id, now);
  const bootstrap = policy.bootstrapAdmins.includes(`${id.provider}:${id.subject}`);
  const roles = rolesFor(id.groups, policy.roleMappings[id.provider] ?? {}, user.rolesExtra as Role[], bootstrap);
  await store.setUserRoles(user.id, roles);
  return { user: { ...user, roles }, roles };
}
