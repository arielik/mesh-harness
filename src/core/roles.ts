// Roles and authorization (plan §4.5). Provider-agnostic: groups come normalized from the provider.

export const ROLES = ["member", "approver", "admin", "service"] as const;
export type Role = (typeof ROLES)[number];

export interface RoleMapping {
  approver?: string[] | undefined;
  admin?: string[] | undefined;
  service?: string[] | undefined;
}

/** Normalize group names as configured per provider (e.g. Kanidm SPNs `name@domain`). */
export function normalizeGroups(groups: readonly string[], rules: readonly ("strip_domain" | "lowercase")[]): string[] {
  return [
    ...new Set(
      groups.map((g) => {
        let v = g;
        if (rules.includes("strip_domain")) v = v.replace(/@.*$/, "");
        if (rules.includes("lowercase")) v = v.toLowerCase();
        return v;
      }),
    ),
  ];
}

/** Roles for a login: every authenticated user is a member, plus mapped groups, extras and bootstrap. */
export function rolesFor(groups: readonly string[], mapping: RoleMapping, extra: readonly Role[] = [], bootstrapAdmin = false): Role[] {
  const roles = new Set<Role>(["member"]);
  for (const role of ["approver", "admin", "service"] as const) {
    if ((mapping[role] ?? []).some((g) => groups.includes(g))) roles.add(role);
  }
  for (const r of extra) roles.add(r);
  if (bootstrapAdmin) roles.add("admin");
  if (roles.has("service") && !roles.has("admin")) {
    // Service accounts read the analysis feed; they are not people.
    roles.delete("member");
  }
  return ROLES.filter((r) => roles.has(r));
}

export interface Principal {
  userId: string;
  roles: readonly Role[];
}

/** Route-level rules; every hub route declares one (checked by a test). */
export type RouteRule = "public" | "member" | "admin" | "events";

export function allowed(rule: RouteRule, p: Principal | undefined): boolean {
  if (rule === "public") return true;
  if (!p) return false;
  if (rule === "member") return p.roles.includes("member") || p.roles.includes("admin");
  if (rule === "admin") return p.roles.includes("admin");
  return p.roles.includes("service") || p.roles.includes("admin");
}

/** Approve or revise a plan: the goal owner, approvers and admins. */
export function canApprove(p: Principal, goalOwner: string): boolean {
  return p.userId === goalOwner || p.roles.includes("approver") || p.roles.includes("admin");
}

/** Take over before the threshold, release others' claims, drop goals: owner or admin. */
export function isOwnerOrAdmin(p: Principal, goalOwner: string): boolean {
  return p.userId === goalOwner || p.roles.includes("admin");
}
