// mesh-hub.yaml (plan §4.2, §8). Environment overrides (containers set these; see Dockerfile):
//   MESH_HUB_CONFIG  where mesh-hub.yaml is (read by `mesh hub` in main.ts, instead of --config)
//   MESH_HUB_LISTEN  listen:  host:port
//   MESH_HUB_URL     url:     the public address
//   MESH_HUB_DB      db:      a SQLite file, or a postgres:// URL for several replicas
//   (an OIDC provider's client secret comes from the variable its client_secret_env names)

import { existsSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import { parse } from "yaml";
import { z } from "zod";
import { DEFAULT_POLICIES, NoneProvider, OidcProvider, PRESETS, TokenProvider, type AuthProvider, type SessionPolicies } from "../auth/index.ts";
import type { RoleMapping } from "../core/index.ts";
import { isPostgresUrl } from "../store/index.ts";

export function parseDuration(text: string | number): number {
  if (typeof text === "number") return text;
  const m = /^(\d+(?:\.\d+)?)\s*(ms|s|m|h|d)$/.exec(text.trim());
  if (!m) throw new Error(`invalid duration "${text}" (use e.g. 30s, 15m, 4h, 14d)`);
  const n = Number(m[1]);
  const unit = { ms: 1, s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 }[m[2] as "ms" | "s" | "m" | "h" | "d"];
  return n * unit;
}

const duration = z.union([z.string(), z.number()]).transform((v, ctx) => {
  try {
    return parseDuration(v);
  } catch (e) {
    ctx.addIssue({ code: "custom", message: (e as Error).message });
    return z.NEVER;
  }
});

const roles = z.object({ approver: z.array(z.string()).optional(), admin: z.array(z.string()).optional(), service: z.array(z.string()).optional() }).default({});

const ProviderConfig = z.discriminatedUnion("kind", [
  z.object({ id: z.string().default("local"), kind: z.literal("none"), roles, user: z.string().regex(/^[A-Za-z0-9._-]{1,64}$/).optional() }),
  z.object({
    id: z.string(),
    kind: z.literal("token"),
    label: z.string().optional(),
    users: z.array(z.object({ name: z.string(), token_sha256: z.string().regex(/^[0-9a-f]{64}$/), groups: z.array(z.string()).optional(), email: z.string().optional() })),
    roles,
  }),
  z.object({
    id: z.string(),
    kind: z.literal("oidc"),
    preset: z.enum(["kanidm", "keycloak", "gitlab"]).optional(),
    label: z.string().optional(),
    issuer: z.string().url(),
    client_id: z.string(),
    client_secret_env: z.string().optional(),
    scopes: z.array(z.string()).optional(),
    groups_claim: z.string().optional(),
    group_normalize: z.array(z.enum(["strip_domain", "lowercase"])).optional(),
    allow_insecure: z.boolean().optional(),
    roles,
  }),
]);
export type ProviderConfig = z.infer<typeof ProviderConfig>;

export const HubConfigFile = z.object({
  listen: z.string().default("127.0.0.1:7700"),
  url: z.string().optional(),
  /** A SQLite file (relative to this file), or a postgres:// URL for several hub replicas on one database. */
  db: z.string().default("mesh-hub.db"),
  /** Hub events older than this are deleted (the durable summaries are in git). 0 keeps them forever. */
  events_retention_days: z.number().int().min(0).default(180),
  /** Blind steps (M4.5): refuse anyone who worked on the other side ("person"), or only the same session ("session", for one person on their own). */
  blind_guard: z.enum(["person", "session"]).default("person"),
  auth: z
    .object({
      providers: z.array(ProviderConfig).min(1),
      bootstrap_admins: z.array(z.string()).default([]),
      session: z
        .object({
          device_max_age: duration.optional(),
          device_idle: duration.optional(),
          web_max_age: duration.optional(),
          web_idle: duration.optional(),
        })
        .default({}),
    })
    .default({ providers: [{ id: "local", kind: "none", roles: {} }], bootstrap_admins: [], session: {} }),
  thresholds: z
    .object({
      takeover_after: duration.default(4 * 3_600_000),
      pause_grace: duration.default(2 * 60_000),
      machine_offline: duration.default(15 * 60_000),
    })
    .default({ takeover_after: 4 * 3_600_000, pause_grace: 2 * 60_000, machine_offline: 15 * 60_000 }),
});

export interface HubConfig {
  host: string;
  port: number;
  url: string;
  db: string;
  providers: AuthProvider[];
  roleMappings: Record<string, RoleMapping>;
  bootstrapAdmins: string[];
  policies: SessionPolicies;
  thresholds: { takeoverAfterMs: number; pauseGraceMs: number; machineOfflineMs: number };
  eventsRetentionDays: number;
  blindGuard: "person" | "session";
}

export function isLoopback(host: string): boolean {
  return host === "127.0.0.1" || host === "localhost" || host === "::1";
}

export function buildHubConfig(raw: unknown, opts: { baseDir: string; env: Record<string, string | undefined> }): HubConfig {
  const file = HubConfigFile.parse(raw ?? {});
  const listen = opts.env.MESH_HUB_LISTEN ?? file.listen;
  const m = /^(.*):(\d+)$/.exec(listen);
  if (!m) throw new Error(`listen must be host:port (got "${listen}")`);
  const host = m[1] as string;
  const port = Number(m[2]);
  const providers: AuthProvider[] = [];
  const roleMappings: Record<string, RoleMapping> = {};
  for (const p of file.auth.providers) {
    roleMappings[p.id] = p.roles;
    if (p.kind === "none") {
      if (!isLoopback(host)) throw new Error(`the "none" provider only works on a loopback address, not ${host}`);
      providers.push(new NoneProvider(p.id, p.user));
    } else if (p.kind === "token") {
      providers.push(new TokenProvider(p.id, p.users, p.label));
    } else {
      const preset = p.preset ? PRESETS[p.preset] : {};
      const secret = p.client_secret_env ? opts.env[p.client_secret_env] : undefined;
      if (p.client_secret_env && !secret) throw new Error(`environment variable ${p.client_secret_env} (client secret for ${p.id}) is not set`);
      providers.push(
        new OidcProvider({
          id: p.id,
          label: p.label ?? preset?.label,
          issuer: p.issuer,
          clientId: p.client_id,
          clientSecret: secret,
          scopes: p.scopes ?? preset?.scopes ?? ["openid", "profile", "email"],
          groupsClaim: p.groups_claim ?? preset?.groupsClaim ?? "groups",
          groupNormalize: p.group_normalize ?? preset?.groupNormalize ?? [],
          allowInsecure: p.allow_insecure,
        }),
      );
    }
  }
  const ids = providers.map((p) => p.id);
  if (new Set(ids).size !== ids.length) throw new Error("auth provider ids must be unique");
  const s = file.auth.session;
  const policies: SessionPolicies = {
    device: { maxAgeMs: s.device_max_age ?? DEFAULT_POLICIES.device.maxAgeMs, idleMs: s.device_idle ?? DEFAULT_POLICIES.device.idleMs },
    web: { maxAgeMs: s.web_max_age ?? DEFAULT_POLICIES.web.maxAgeMs, idleMs: s.web_idle ?? DEFAULT_POLICIES.web.idleMs },
    service: DEFAULT_POLICIES.service,
  };
  const db = opts.env.MESH_HUB_DB ?? file.db;
  return {
    host,
    port,
    url: (opts.env.MESH_HUB_URL ?? file.url ?? `http://${host}:${port}`).replace(/\/+$/, ""),
    db: db === ":memory:" || isPostgresUrl(db) || isAbsolute(db) ? db : resolve(opts.baseDir, db),
    providers,
    roleMappings,
    bootstrapAdmins: file.auth.bootstrap_admins,
    policies,
    thresholds: { takeoverAfterMs: file.thresholds.takeover_after, pauseGraceMs: file.thresholds.pause_grace, machineOfflineMs: file.thresholds.machine_offline },
    eventsRetentionDays: file.events_retention_days,
    blindGuard: file.blind_guard,
  };
}

export function loadHubConfig(path: string | undefined, env: Record<string, string | undefined>, cwd: string): HubConfig {
  if (!path) return buildHubConfig({}, { baseDir: cwd, env });
  if (!existsSync(path)) throw new Error(`hub config ${path} not found (create one with: mesh hub init)`);
  return buildHubConfig(parse(readFileSync(path, "utf8")), { baseDir: dirname(resolve(path)), env });
}
