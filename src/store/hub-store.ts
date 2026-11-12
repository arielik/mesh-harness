// Hub persistence (plan §3.2, §8). Rows keep a few indexed columns plus the JSON value.

import { randomUUID } from "node:crypto";
import {
  DispositionRow,
  Goal,
  ItemHistoryEntry,
  ItemRow,
  Plan,
  Pulse,
  PulseSlot,
  Question,
  ServiceScope,
  Session,
  Step,
  StoredArtifact,
  StoredReview,
  Topic,
  type AgentFront, AgentReport, type CatalogDefView, type CatalogSourceView, type Note, type ProfileBase, type SlotState, type ProfileSettings, type Repo, type ShareLevel } from "../protocol/index.ts";
import { openDb, SOLE_LEADER, type Channel, type Db, type Leader, type SqlValue } from "./db.ts";
import { isPostgresUrl, type LockKey } from "./dialect.ts";
import { openPgDb } from "./pg.ts";

/** SQLite schema. Queries quote "user" because Postgres reserves the word. */
export const HUB_MIGRATIONS: readonly string[] = [
  `CREATE TABLE user (
     id TEXT PRIMARY KEY, name TEXT NOT NULL, email TEXT,
     roles TEXT NOT NULL DEFAULT '["member"]', roles_extra TEXT NOT NULL DEFAULT '[]', created_at INTEGER NOT NULL);
   CREATE TABLE identity (
     provider TEXT NOT NULL, subject TEXT NOT NULL, user_id TEXT NOT NULL REFERENCES user(id),
     groups TEXT NOT NULL, last_login INTEGER NOT NULL, PRIMARY KEY (provider, subject));
   CREATE TABLE token (
     hash TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES user(id), kind TEXT NOT NULL, machine_id TEXT, label TEXT,
     created_at INTEGER NOT NULL, last_used INTEGER NOT NULL, expires_at INTEGER NOT NULL, revoked INTEGER NOT NULL DEFAULT 0);
   CREATE INDEX token_user ON token (user_id);
   CREATE TABLE login_attempt (id TEXT PRIMARY KEY, value TEXT NOT NULL, created_at INTEGER NOT NULL);
   CREATE TABLE machine (
     id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES user(id), hostname TEXT NOT NULL,
     last_seen INTEGER NOT NULL, counts TEXT NOT NULL DEFAULT '{}');
   CREATE TABLE hsession (sid TEXT PRIMARY KEY, user_id TEXT NOT NULL, machine_id TEXT NOT NULL, value TEXT NOT NULL, updated_at INTEGER NOT NULL);
   CREATE TABLE goal (id TEXT PRIMARY KEY, num INTEGER NOT NULL UNIQUE, state TEXT NOT NULL, value TEXT NOT NULL, updated_at INTEGER NOT NULL);
   CREATE TABLE plan (goal TEXT NOT NULL, version INTEGER NOT NULL, decision TEXT NOT NULL, value TEXT NOT NULL, PRIMARY KEY (goal, version));
   CREATE TABLE step (
     id TEXT PRIMARY KEY, goal TEXT NOT NULL, state TEXT NOT NULL, repo TEXT NOT NULL, holder_user TEXT,
     value TEXT NOT NULL, updated_at INTEGER NOT NULL);
   CREATE INDEX step_goal ON step (goal);
   CREATE INDEX step_state ON step (state);
   CREATE TABLE note (id INTEGER PRIMARY KEY AUTOINCREMENT, step TEXT NOT NULL, user_id TEXT NOT NULL, sid TEXT, text TEXT NOT NULL, at INTEGER NOT NULL);
   CREATE TABLE question (id INTEGER PRIMARY KEY AUTOINCREMENT, value TEXT NOT NULL, answered INTEGER NOT NULL DEFAULT 0, at INTEGER NOT NULL);
   CREATE TABLE message (
     id INTEGER PRIMARY KEY AUTOINCREMENT, to_machine TEXT NOT NULL, to_sid TEXT NOT NULL, from_user TEXT NOT NULL,
     kind TEXT NOT NULL, text TEXT NOT NULL, state TEXT NOT NULL, method TEXT, created_at INTEGER NOT NULL, acked_at INTEGER);
   CREATE INDEX message_inbox ON message (to_machine, state);
   CREATE TABLE event (
     seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE, at INTEGER NOT NULL, type TEXT NOT NULL,
     user_id TEXT, sid TEXT, goal TEXT, step TEXT, payload TEXT NOT NULL);
   CREATE TABLE idem (key TEXT NOT NULL, user_id TEXT NOT NULL, response TEXT NOT NULL, at INTEGER NOT NULL, PRIMARY KEY (key, user_id));`,
  `ALTER TABLE message ADD COLUMN data TEXT;
   CREATE INDEX event_step ON event (step);
   CREATE INDEX event_goal ON event (goal);`,
  // v0.1.5: a machine is a mesh installation, not person + hostname (NULL: an older CLI's machine).
  `ALTER TABLE machine ADD COLUMN install_id TEXT;`,
  // v0.1.6: a service token's scopes, comma-separated (NULL: the event feed only).
  `ALTER TABLE token ADD COLUMN scopes TEXT;`,
  // v0.1.8: topics, the labels people define for goals (a goal's own topics live in its value).
  `CREATE TABLE topic (name TEXT PRIMARY KEY, value TEXT NOT NULL, created_at INTEGER NOT NULL);`,
  // v0.1.9: 0 once the machine's sync stops listing the session (kept to route messages, not shown).
  `ALTER TABLE hsession ADD COLUMN listed INTEGER NOT NULL DEFAULT 1;`,
  // v0.1.10 (MM-1): a machine's share level, nickname (unique per person; NULL on many rows) and one
  // JSON object for the rest (now the repo inventory; later labels and accept policy).
  `ALTER TABLE machine ADD COLUMN share TEXT;
   ALTER TABLE machine ADD COLUMN nickname TEXT;
   ALTER TABLE machine ADD COLUMN extra TEXT;
   CREATE UNIQUE INDEX machine_nickname ON machine (user_id, nickname);`,
  // v0.1.15 (RL-1): hub-stored artifacts of step rounds (content NULL once pruned) and registered
  // permission profiles.
  `CREATE TABLE artifact (id TEXT PRIMARY KEY, goal TEXT NOT NULL, step TEXT NOT NULL, round INTEGER NOT NULL,
     value TEXT NOT NULL, content BLOB, created_at INTEGER NOT NULL);
   CREATE INDEX artifact_goal ON artifact (goal);
   CREATE INDEX artifact_step_round ON artifact (step, round);
   CREATE TABLE profile (name TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at INTEGER NOT NULL);`,
  // v0.1.16 (RL-2): review records, item rows and their history (never pruned).
  `CREATE TABLE review_record (step TEXT NOT NULL, round INTEGER NOT NULL, goal TEXT NOT NULL, lineage TEXT NOT NULL,
     raising INTEGER NOT NULL, complete INTEGER NOT NULL, value TEXT NOT NULL, created_at INTEGER NOT NULL, PRIMARY KEY (step, round));
   CREATE INDEX review_record_lineage ON review_record (lineage, raising, complete);
   CREATE TABLE review_item (lineage TEXT NOT NULL, fp TEXT NOT NULL, value TEXT NOT NULL, updated_at INTEGER NOT NULL, PRIMARY KEY (lineage, fp));
   CREATE TABLE item_history (seq INTEGER PRIMARY KEY AUTOINCREMENT, lineage TEXT NOT NULL, fp TEXT NOT NULL, step TEXT NOT NULL, value TEXT NOT NULL);
   CREATE INDEX item_history_fp ON item_history (lineage, fp, seq);`,
  // v0.1.17 (RL-3): pulses and their slots.
  `CREATE TABLE IF NOT EXISTS pulse (id TEXT PRIMARY KEY, num INTEGER NOT NULL UNIQUE, owner TEXT NOT NULL, enabled INTEGER NOT NULL,
     next_at INTEGER, value TEXT NOT NULL, updated_at INTEGER NOT NULL);
   CREATE INDEX IF NOT EXISTS pulse_due ON pulse (enabled, next_at);
   CREATE TABLE IF NOT EXISTS pulse_slot (pulse TEXT NOT NULL, slot TEXT NOT NULL, at INTEGER NOT NULL, state TEXT NOT NULL, goal TEXT,
     started_at INTEGER, value TEXT NOT NULL, updated_at INTEGER NOT NULL, PRIMARY KEY (pulse, slot));
   CREATE INDEX IF NOT EXISTS pulse_slot_pending ON pulse_slot (state, started_at);
   CREATE INDEX IF NOT EXISTS pulse_slot_goal ON pulse_slot (goal);`,
  // v0.1.19 (RL-5): the roster.
  `CREATE TABLE IF NOT EXISTS agent_def (id TEXT PRIMARY KEY, origin TEXT NOT NULL, machine TEXT, repo TEXT NOT NULL,
     name TEXT NOT NULL, hash TEXT NOT NULL, current INTEGER NOT NULL, value TEXT NOT NULL, body TEXT, updated_at INTEGER NOT NULL);
   CREATE INDEX IF NOT EXISTS agent_def_machine ON agent_def (origin, machine);
   CREATE INDEX IF NOT EXISTS agent_def_name ON agent_def (name);
   CREATE TABLE IF NOT EXISTS catalog_source (repo TEXT PRIMARY KEY, value TEXT NOT NULL, created_at INTEGER NOT NULL);`,
];

/**
 * The same schema on Postgres, one entry per SQLite migration above (so both report the same
 * version). Differences: millisecond times and ids are BIGINT, AUTOINCREMENT is an identity column,
 * "user" is quoted, and `step.ord` stands in for SQLite's rowid (insertion order).
 */
export const HUB_MIGRATIONS_PG: readonly string[] = [
  `CREATE TABLE "user" (
     id TEXT PRIMARY KEY, name TEXT NOT NULL, email TEXT,
     roles TEXT NOT NULL DEFAULT '["member"]', roles_extra TEXT NOT NULL DEFAULT '[]', created_at BIGINT NOT NULL);
   CREATE TABLE identity (
     provider TEXT NOT NULL, subject TEXT NOT NULL, user_id TEXT NOT NULL REFERENCES "user"(id),
     groups TEXT NOT NULL, last_login BIGINT NOT NULL, PRIMARY KEY (provider, subject));
   CREATE TABLE token (
     hash TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES "user"(id), kind TEXT NOT NULL, machine_id TEXT, label TEXT,
     created_at BIGINT NOT NULL, last_used BIGINT NOT NULL, expires_at BIGINT NOT NULL, revoked INTEGER NOT NULL DEFAULT 0);
   CREATE INDEX token_user ON token (user_id);
   CREATE TABLE login_attempt (id TEXT PRIMARY KEY, value TEXT NOT NULL, created_at BIGINT NOT NULL);
   CREATE TABLE machine (
     id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES "user"(id), hostname TEXT NOT NULL,
     last_seen BIGINT NOT NULL, counts TEXT NOT NULL DEFAULT '{}');
   CREATE TABLE hsession (sid TEXT PRIMARY KEY, user_id TEXT NOT NULL, machine_id TEXT NOT NULL, value TEXT NOT NULL, updated_at BIGINT NOT NULL);
   CREATE TABLE goal (id TEXT PRIMARY KEY, num INTEGER NOT NULL UNIQUE, state TEXT NOT NULL, value TEXT NOT NULL, updated_at BIGINT NOT NULL);
   CREATE TABLE plan (goal TEXT NOT NULL, version INTEGER NOT NULL, decision TEXT NOT NULL, value TEXT NOT NULL, PRIMARY KEY (goal, version));
   CREATE TABLE step (
     id TEXT PRIMARY KEY, goal TEXT NOT NULL, state TEXT NOT NULL, repo TEXT NOT NULL, holder_user TEXT,
     value TEXT NOT NULL, updated_at BIGINT NOT NULL, ord BIGINT GENERATED ALWAYS AS IDENTITY);
   CREATE INDEX step_goal ON step (lower(goal));
   CREATE INDEX step_state ON step (state);
   CREATE INDEX step_id_ci ON step (lower(id));
   CREATE INDEX goal_id_ci ON goal (lower(id));
   CREATE TABLE note (id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY, step TEXT NOT NULL, user_id TEXT NOT NULL, sid TEXT, text TEXT NOT NULL, at BIGINT NOT NULL);
   CREATE TABLE question (id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY, value TEXT NOT NULL, answered INTEGER NOT NULL DEFAULT 0, at BIGINT NOT NULL);
   CREATE TABLE message (
     id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY, to_machine TEXT NOT NULL, to_sid TEXT NOT NULL, from_user TEXT NOT NULL,
     kind TEXT NOT NULL, text TEXT NOT NULL, state TEXT NOT NULL, method TEXT, created_at BIGINT NOT NULL, acked_at BIGINT);
   CREATE INDEX message_inbox ON message (to_machine, state);
   CREATE TABLE event (
     seq BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY, id TEXT NOT NULL UNIQUE, at BIGINT NOT NULL, type TEXT NOT NULL,
     user_id TEXT, sid TEXT, goal TEXT, step TEXT, payload TEXT NOT NULL);
   CREATE TABLE idem (key TEXT NOT NULL, user_id TEXT NOT NULL, response TEXT NOT NULL, at BIGINT NOT NULL, PRIMARY KEY (key, user_id));`,
  `ALTER TABLE message ADD COLUMN data TEXT;
   CREATE INDEX event_step ON event (step);
   CREATE INDEX event_goal ON event (goal);`,
  `ALTER TABLE machine ADD COLUMN install_id TEXT;`,
  `ALTER TABLE token ADD COLUMN scopes TEXT;`,
  `CREATE TABLE topic (name TEXT PRIMARY KEY, value TEXT NOT NULL, created_at BIGINT NOT NULL);`,
  `ALTER TABLE hsession ADD COLUMN listed INTEGER NOT NULL DEFAULT 1;`,
  `ALTER TABLE machine ADD COLUMN share TEXT;
   ALTER TABLE machine ADD COLUMN nickname TEXT;
   ALTER TABLE machine ADD COLUMN extra TEXT;
   CREATE UNIQUE INDEX machine_nickname ON machine (user_id, nickname);`,
  `CREATE TABLE artifact (id TEXT PRIMARY KEY, goal TEXT NOT NULL, step TEXT NOT NULL, round INTEGER NOT NULL,
     value TEXT NOT NULL, content BYTEA, created_at BIGINT NOT NULL);
   CREATE INDEX artifact_goal ON artifact (goal);
   CREATE INDEX artifact_step_round ON artifact (step, round);
   CREATE TABLE profile (name TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at BIGINT NOT NULL);`,
  `CREATE TABLE review_record (step TEXT NOT NULL, round INTEGER NOT NULL, goal TEXT NOT NULL, lineage TEXT NOT NULL,
     raising INTEGER NOT NULL, complete INTEGER NOT NULL, value TEXT NOT NULL, created_at BIGINT NOT NULL,
     ord BIGINT GENERATED ALWAYS AS IDENTITY, PRIMARY KEY (step, round));
   CREATE INDEX review_record_lineage ON review_record (lineage, raising, complete);
   CREATE TABLE review_item (lineage TEXT NOT NULL, fp TEXT NOT NULL, value TEXT NOT NULL, updated_at BIGINT NOT NULL, PRIMARY KEY (lineage, fp));
   CREATE TABLE item_history (seq BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY, lineage TEXT NOT NULL, fp TEXT NOT NULL, step TEXT NOT NULL, value TEXT NOT NULL);
   CREATE INDEX item_history_fp ON item_history (lineage, fp, seq);`,
  `CREATE TABLE IF NOT EXISTS pulse (id TEXT PRIMARY KEY, num INTEGER NOT NULL UNIQUE, owner TEXT NOT NULL, enabled INTEGER NOT NULL,
     next_at BIGINT, value TEXT NOT NULL, updated_at BIGINT NOT NULL);
   CREATE INDEX IF NOT EXISTS pulse_due ON pulse (enabled, next_at);
   CREATE TABLE IF NOT EXISTS pulse_slot (pulse TEXT NOT NULL, slot TEXT NOT NULL, at BIGINT NOT NULL, state TEXT NOT NULL, goal TEXT,
     started_at BIGINT, value TEXT NOT NULL, updated_at BIGINT NOT NULL, PRIMARY KEY (pulse, slot));
   CREATE INDEX IF NOT EXISTS pulse_slot_pending ON pulse_slot (state, started_at);
   CREATE INDEX IF NOT EXISTS pulse_slot_goal ON pulse_slot (goal);`,
  `CREATE TABLE IF NOT EXISTS agent_def (id TEXT PRIMARY KEY, origin TEXT NOT NULL, machine TEXT, repo TEXT NOT NULL,
     name TEXT NOT NULL, hash TEXT NOT NULL, current INTEGER NOT NULL, value TEXT NOT NULL, body TEXT, updated_at BIGINT NOT NULL);
   CREATE INDEX IF NOT EXISTS agent_def_machine ON agent_def (origin, machine);
   CREATE INDEX IF NOT EXISTS agent_def_name ON agent_def (name);
   CREATE TABLE IF NOT EXISTS catalog_source (repo TEXT PRIMARY KEY, value TEXT NOT NULL, created_at BIGINT NOT NULL);`,
];

/** RL-1: a registered permission profile as the hub stores it. */
/** RL-5: a catalog source as stored (the view as is). */
export type StoredCatalogSource = CatalogSourceView;

/** RL-5: the JSON value of a catalog definition row (the text is in `body`). */
interface CatalogDefValue {
  path: string;
  commits: string[];
  pushedAt: number;
  front: AgentFront;
}

export interface StoredProfile {
  name: string;
  /** The YAML text it was registered with. */
  text: string;
  createdBy: string;
  updatedAt: number;
  base: ProfileBase;
  sha256: string;
  settings: ProfileSettings;
  description: string;
}

export type TokenKind = "device" | "web" | "service";

export interface TokenRow {
  hash: string;
  userId: string;
  kind: TokenKind;
  machineId?: string | undefined;
  label?: string | undefined;
  /** Service tokens only: the member routes this token may also call. */
  scopes?: ServiceScope[] | undefined;
  createdAt: number;
  lastUsed: number;
  expiresAt: number;
  revoked: boolean;
}

export interface UserRow {
  id: string;
  name: string;
  email?: string | undefined;
  roles: string[];
  rolesExtra: string[];
  createdAt: number;
}

export interface MachineRow {
  id: string;
  userId: string;
  hostname: string;
  lastSeen: number;
  counts: Record<string, number>;
  /** The mesh installation this machine is (v0.1.5+ CLIs); absent for an older CLI's machine. */
  installId?: string;
  /** MM-1: the share level its daemon last reported; absent when none was ever reported. */
  share?: ShareLevel;
  /** MM-1: the short name its owner gave it (unique among that person's machines). */
  nickname?: string;
  /** MM-1: the repo inventory (ids and names only) its daemon last reported, and when. */
  repos?: Repo[];
  reposAt?: number;
  /** MM-2: what the machine has or is for, sorted; absent when none. */
  labels?: string[];
  /** MM-3: the accept policy its daemon last reported; absent when never reported. */
  accept?: string[];
  /** RL-1: its daemon can run headless steps; absent when never reported. */
  headless?: boolean;
}

/** Facts a sync reports about its machine (MM-1; `accept`: MM-3; `headless`: RL-1). */
export interface MachineFacts {
  share?: ShareLevel | undefined;
  repos?: Repo[] | undefined;
  accept?: string[] | undefined;
  headless?: boolean | undefined;
}

export interface HubSession {
  session: Session;
  userId: string;
  machineId: string;
  updatedAt: number;
}

export interface MessageRow {
  id: number;
  toMachine: string;
  toSid: string;
  fromUser: string;
  kind: string;
  text: string;
  state: "pending" | "delivered" | "failed";
  method?: string | undefined;
  createdAt: number;
  ackedAt?: number | undefined;
  data?: Record<string, unknown> | undefined;
}

export interface EventRow {
  seq: number;
  id: string;
  at: number;
  type: string;
  user?: string | undefined;
  sid?: string | undefined;
  goal?: string | undefined;
  step?: string | undefined;
  payload: Record<string, unknown>;
}

export interface NewEvent {
  id?: string | undefined;
  at: number;
  type: string;
  user?: string | undefined;
  sid?: string | undefined;
  goal?: string | undefined;
  step?: string | undefined;
  payload?: Record<string, unknown> | undefined;
}

const opt = <T>(v: T | null): T | undefined => (v === null ? undefined : v);
// A scope this version does not know (written by a newer hub) grants nothing.
const scopesOf = (v: string): ServiceScope[] => v.split(",").flatMap((x) => (ServiceScope.safeParse(x).success ? [x as ServiceScope] : []));
const json = (v: unknown) => JSON.stringify(v);
/** Code-unit order (the same on both dialects). */
const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

function slug(name: string): string {
  const s = name.toLowerCase().replace(/@.*$/, "").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  return s || "user";
}

type EventDbRow = { seq: number; id: string; at: number; type: string; user_id: string | null; sid: string | null; goal: string | null; step: string | null; payload: string };
const eventFrom = (r: EventDbRow): EventRow => ({
  seq: r.seq,
  id: r.id,
  at: r.at,
  type: r.type,
  user: opt(r.user_id),
  sid: opt(r.sid),
  goal: opt(r.goal),
  step: opt(r.step),
  payload: JSON.parse(r.payload),
});

type MessageDbRow = { id: number; to_machine: string; to_sid: string; from_user: string; kind: string; text: string; state: MessageRow["state"]; method: string | null; created_at: number; acked_at: number | null; data: string | null };
const messageFrom = (r: MessageDbRow): MessageRow => ({
  id: r.id,
  toMachine: r.to_machine,
  toSid: r.to_sid,
  fromUser: r.from_user,
  kind: r.kind,
  text: r.text,
  state: r.state,
  method: opt(r.method),
  createdAt: r.created_at,
  ackedAt: opt(r.acked_at),
  data: r.data ? JSON.parse(r.data) : undefined,
});

type UserDbRow = { id: string; name: string; email: string | null; roles: string; roles_extra: string; created_at: number };
const userFrom = (r: UserDbRow): UserRow => ({ id: r.id, name: r.name, email: opt(r.email), roles: JSON.parse(r.roles), rolesExtra: JSON.parse(r.roles_extra), createdAt: r.created_at });

type MachineDbRow = {
  id: string;
  user_id: string;
  hostname: string;
  last_seen: number;
  counts: string;
  install_id?: string | null;
  share?: string | null;
  nickname?: string | null;
  extra?: string | null;
};
/** The JSON column `machine.extra`: per-machine facts beyond the indexed columns. */
type MachineExtra = { repos?: Repo[]; reposAt?: number; labels?: string[]; accept?: string[]; headless?: boolean };
const machineExtra = (raw: string | null | undefined): MachineExtra => (raw ? (JSON.parse(raw) as MachineExtra) : {});
const machineFrom = (r: MachineDbRow): MachineRow => {
  const x = machineExtra(r.extra);
  return {
    id: r.id,
    userId: r.user_id,
    hostname: r.hostname,
    lastSeen: r.last_seen,
    counts: JSON.parse(r.counts),
    ...(r.install_id ? { installId: r.install_id } : {}),
    ...(r.share ? { share: r.share as ShareLevel } : {}),
    ...(r.nickname ? { nickname: r.nickname } : {}),
    ...(Array.isArray(x.repos) ? { repos: x.repos } : {}),
    ...(typeof x.reposAt === "number" ? { reposAt: x.reposAt } : {}),
    ...(Array.isArray(x.labels) && x.labels.length ? { labels: x.labels } : {}),
    ...(Array.isArray(x.accept) ? { accept: x.accept } : {}),
    ...(typeof x.headless === "boolean" ? { headless: x.headless } : {}),
  };
};

/**
 * Every method is async (the `Db` may be SQLite or, from M4.6, Postgres). Methods that issue more
 * than one statement run them in one transaction, so callers never see a half-written row.
 */
export class HubStore {
  readonly db: Db;

  constructor(db: Db) {
    this.db = db;
  }

  /** Open the hub database: a SQLite file (or ":memory:"), or a postgres:// URL. */
  static async open(target: string): Promise<HubStore> {
    return new HubStore(isPostgresUrl(target) ? await openPgDb(target, HUB_MIGRATIONS_PG) : await openDb(target, HUB_MIGRATIONS));
  }

  /** Run `fn` atomically; store calls awaited inside it join the transaction. */
  tx<T>(fn: () => Promise<T>): Promise<T> {
    return this.db.transaction(fn);
  }

  /** Run `fn` once the current transaction commits (hints to SSE subscribers). */
  afterCommit(fn: () => void): void {
    this.db.afterCommit(fn);
  }

  close(): Promise<void> {
    return this.db.close();
  }

  /** Cross-replica notifications (Postgres); undefined on SQLite, where in-process fan-out is enough. */
  channel(name: string): Channel | undefined {
    return this.db.channel?.(name);
  }

  /** Leadership among replicas for periodic work; on SQLite this process always leads. */
  leader(key: "tick"): Leader {
    return this.db.leader?.(key) ?? SOLE_LEADER;
  }

  /**
   * Serialise the rest of the current transaction with others taking `key` (no-op on SQLite).
   * Lock order is fixed: `events` first, so a transaction that appends events and also takes
   * `goals` or `users` cannot deadlock with one taking them the other way round.
   */
  /**
   * Serialise the rest of the current transaction with every other one that changes goals, plans
   * or steps (Postgres: the `events` lock, taken before the first read; no-op on SQLite, where
   * `BEGIN IMMEDIATE` already does this). A transaction that reads a goal's steps or plans and
   * then writes from what it read calls this first: under READ COMMITTED, two replicas would
   * otherwise both decide from the same stale read (two siblings finishing at once and neither
   * marking their dependant ready, a retried call applied twice). Those transactions append
   * events anyway, so they would hold this lock until commit regardless.
   */
  async serialize(): Promise<void> {
    await this.lock("events");
  }

  private async lock(key: Exclude<LockKey, "migrate" | "tick">): Promise<void> {
    if (key !== "events") await this.lock("events");
    const sql = this.db.dialect.lock(key);
    if (sql) await this.db.exec(sql);
  }

  // ---------- users ----------

  async getUser(id: string): Promise<UserRow | undefined> {
    const r = await this.db.get<UserDbRow>('SELECT * FROM "user" WHERE id = ?', id);
    return r ? userFrom(r) : undefined;
  }

  async listUsers(): Promise<UserRow[]> {
    return (await this.db.all<UserDbRow>('SELECT * FROM "user" ORDER BY id')).map(userFrom);
  }

  upsertIdentity(id: { provider: string; subject: string; name?: string | undefined; email?: string | undefined; groups: string[] }, now: number): Promise<UserRow> {
    return this.tx(async () => {
      await this.lock("users");
      const existing = await this.db.get<{ user_id: string }>("SELECT user_id FROM identity WHERE provider = ? AND subject = ?", id.provider, id.subject);
      let userId = existing?.user_id;
      if (!userId) {
        const base = slug(id.name ?? id.email ?? id.subject);
        userId = base;
        for (let n = 2; await this.getUser(userId); n++) userId = `${base}-${n}`;
        await this.db.run('INSERT INTO "user" (id, name, email, created_at) VALUES (?, ?, ?, ?)', userId, id.name ?? id.subject, id.email ?? null, now);
        await this.db.run("INSERT INTO identity (provider, subject, user_id, groups, last_login) VALUES (?, ?, ?, ?, ?)", id.provider, id.subject, userId, json(id.groups), now);
      } else {
        await this.db.run("UPDATE identity SET groups = ?, last_login = ? WHERE provider = ? AND subject = ?", json(id.groups), now, id.provider, id.subject);
        if (id.name) await this.db.run('UPDATE "user" SET name = ?, email = COALESCE(?, email) WHERE id = ?', id.name, id.email ?? null, userId);
      }
      return (await this.getUser(userId)) as UserRow;
    });
  }

  async setUserRoles(userId: string, roles: string[]): Promise<void> {
    await this.db.run('UPDATE "user" SET roles = ? WHERE id = ?', json(roles), userId);
  }

  async setRolesExtra(userId: string, roles: string[]): Promise<void> {
    await this.db.run('UPDATE "user" SET roles_extra = ? WHERE id = ?', json(roles), userId);
  }

  /** Move an identity to another user (admin `link-identity`). */
  async linkIdentity(provider: string, subject: string, userId: string): Promise<boolean> {
    return (await this.db.run("UPDATE identity SET user_id = ? WHERE provider = ? AND subject = ?", userId, provider, subject)).changes > 0;
  }

  // ---------- tokens ----------

  async insertToken(t: TokenRow): Promise<void> {
    await this.db.run(
      "INSERT INTO token (hash, user_id, kind, machine_id, label, scopes, created_at, last_used, expires_at, revoked) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0)",
      t.hash,
      t.userId,
      t.kind,
      t.machineId ?? null,
      t.label ?? null,
      t.scopes?.length ? t.scopes.join(",") : null,
      t.createdAt,
      t.lastUsed,
      t.expiresAt,
    );
  }

  async getToken(hash: string): Promise<TokenRow | undefined> {
    const r = await this.db.get<{ hash: string; user_id: string; kind: TokenKind; machine_id: string | null; label: string | null; scopes: string | null; created_at: number; last_used: number; expires_at: number; revoked: number }>(
      "SELECT * FROM token WHERE hash = ?",
      hash,
    );
    if (!r) return undefined;
    return { hash: r.hash, userId: r.user_id, kind: r.kind, machineId: opt(r.machine_id), label: opt(r.label), scopes: r.scopes ? scopesOf(r.scopes) : undefined, createdAt: r.created_at, lastUsed: r.last_used, expiresAt: r.expires_at, revoked: r.revoked === 1 };
  }

  async touchToken(hash: string, now: number): Promise<void> {
    await this.db.run("UPDATE token SET last_used = ? WHERE hash = ?", now, hash);
  }

  async revokeToken(hash: string): Promise<void> {
    await this.db.run("UPDATE token SET revoked = 1 WHERE hash = ?", hash);
  }

  async revokeTokens(filter: { userId?: string | undefined; machineId?: string | undefined }): Promise<number> {
    if (filter.userId) return (await this.db.run("UPDATE token SET revoked = 1 WHERE user_id = ? AND revoked = 0", filter.userId)).changes;
    if (filter.machineId) return (await this.db.run("UPDATE token SET revoked = 1 WHERE machine_id = ? AND revoked = 0", filter.machineId)).changes;
    return 0;
  }

  // ---------- login attempts ----------

  async putLoginAttempt(id: string, value: Record<string, unknown>, now: number): Promise<void> {
    await this.db.run("INSERT INTO login_attempt (id, value, created_at) VALUES (?, ?, ?) ON CONFLICT(id) DO UPDATE SET value = excluded.value, created_at = excluded.created_at", id, json(value), now);
  }

  getLoginAttempt<T>(id: string, now: number, ttlMs: number): Promise<T | undefined> {
    return this.tx(async () => {
      await this.db.run("DELETE FROM login_attempt WHERE created_at < ?", now - ttlMs);
      const r = await this.db.get<{ value: string }>("SELECT value FROM login_attempt WHERE id = ?", id);
      return r ? (JSON.parse(r.value) as T) : undefined;
    });
  }

  /** Replace an attempt's value, keeping its age; false when it is gone (expired or consumed). */
  async updateLoginAttempt(id: string, value: Record<string, unknown>): Promise<boolean> {
    return (await this.db.run("UPDATE login_attempt SET value = ? WHERE id = ?", json(value), id)).changes > 0;
  }

  /** True when this call removed it (a concurrent caller finds it gone). */
  async deleteLoginAttempt(id: string): Promise<boolean> {
    return (await this.db.run("DELETE FROM login_attempt WHERE id = ?", id)).changes > 0;
  }

  // ---------- machines and sessions ----------

  /** An installation id, once set, is kept: a later login without one (an older CLI) doesn't clear it. */
  async upsertMachine(m: { id: string; userId: string; hostname: string; installId?: string | undefined }, now: number): Promise<void> {
    await this.db.run(
      "INSERT INTO machine (id, user_id, hostname, last_seen, install_id) VALUES (?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET hostname = excluded.hostname, last_seen = excluded.last_seen, install_id = COALESCE(excluded.install_id, machine.install_id)",
      m.id,
      m.userId,
      m.hostname,
      now,
      m.installId ?? null,
    );
  }

  async getMachine(id: string): Promise<MachineRow | undefined> {
    const r = await this.db.get<MachineDbRow>("SELECT * FROM machine WHERE id = ?", id);
    return r ? machineFrom(r) : undefined;
  }

  /** Every machine, or with `userId` only that user's. */
  async listMachines(filter: { userId?: string } = {}): Promise<MachineRow[]> {
    const rows =
      filter.userId === undefined
        ? await this.db.all<MachineDbRow>("SELECT * FROM machine ORDER BY user_id, hostname")
        : await this.db.all<MachineDbRow>("SELECT * FROM machine WHERE user_id = ? ORDER BY hostname", filter.userId);
    return rows.map(machineFrom);
  }

  /**
   * A sync from this machine: last seen and counts, plus (MM-1) the facts it reported. A given
   * `share` is stored; given `repos` replace the inventory and set `reposAt = now`.
   * `extra` is read and rewritten under a row lock (Postgres `FOR UPDATE`; SQLite's write lock),
   * so two syncs of one machine never lose each other's keys. A sync never changes the labels (MM-2).
   */
  async touchMachine(id: string, now: number, counts: Record<string, number>, facts?: MachineFacts): Promise<void> {
    if (facts?.share === undefined && facts?.repos === undefined && facts?.accept === undefined && facts?.headless === undefined) {
      await this.db.run("UPDATE machine SET last_seen = ?, counts = ? WHERE id = ?", now, json(counts), id);
      return;
    }
    await this.tx(async () => {
      const r = await this.db.get<{ extra: string | null }>(`SELECT extra FROM machine WHERE id = ?${this.db.dialect.forUpdate}`, id);
      if (!r) return;
      let x = machineExtra(r.extra);
      if (facts.repos !== undefined) x = { ...x, repos: facts.repos, reposAt: now };
      if (facts.accept !== undefined) x = { ...x, accept: [...facts.accept] };
      if (facts.headless !== undefined) x = { ...x, headless: facts.headless };
      const extra = facts.repos !== undefined || facts.accept !== undefined || facts.headless !== undefined ? json(x) : r.extra;
      await this.db.run("UPDATE machine SET last_seen = ?, counts = ?, share = COALESCE(?, share), extra = ? WHERE id = ?", now, json(counts), facts.share ?? null, extra, id);
    });
  }

  /**
   * Set (or, with undefined, clear) a machine's nickname. False, and nothing changes, when another
   * machine of the same user already has it. Checked under the store's write lock, never through
   * the unique index (on Postgres a failed statement would abort the caller's transaction).
   * An unknown id changes nothing and returns true.
   */
  setMachineNickname(id: string, nickname: string | undefined): Promise<boolean> {
    return this.tx(async () => {
      await this.serialize();
      const m = await this.db.get<{ user_id: string }>("SELECT user_id FROM machine WHERE id = ?", id);
      if (!m) return true;
      if (nickname !== undefined) {
        const clash = await this.db.get<{ id: string }>("SELECT id FROM machine WHERE user_id = ? AND nickname = ? AND id <> ?", m.user_id, nickname, id);
        if (clash) return false;
      }
      await this.db.run("UPDATE machine SET nickname = ? WHERE id = ?", nickname ?? null, id);
      return true;
    });
  }

  /**
   * MM-2: replace a machine's labels; `[]` removes them. Keeps every other fact (repos, share,
   * nickname). An unknown id changes nothing.
   */
  async setMachineLabels(id: string, labels: readonly string[]): Promise<void> {
    await this.tx(async () => {
      const r = await this.db.get<{ extra: string | null }>(`SELECT extra FROM machine WHERE id = ?${this.db.dialect.forUpdate}`, id);
      if (!r) return;
      const rest = machineExtra(r.extra);
      delete rest.labels;
      await this.db.run("UPDATE machine SET extra = ? WHERE id = ?", json(labels.length ? { ...rest, labels: [...labels] } : rest), id);
    });
  }

  /** The user's machine with this nickname, if any. */
  async machineByNickname(userId: string, nickname: string): Promise<MachineRow | undefined> {
    const r = await this.db.get<MachineDbRow>("SELECT * FROM machine WHERE user_id = ? AND nickname = ?", userId, nickname);
    return r ? machineFrom(r) : undefined;
  }

  async upsertSession(s: Session, userId: string, machineId: string, now: number): Promise<void> {
    await this.db.run(
      "INSERT INTO hsession (sid, user_id, machine_id, value, updated_at, listed) VALUES (?, ?, ?, ?, ?, 1) ON CONFLICT(sid) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at, machine_id = excluded.machine_id, listed = 1",
      s.sid,
      userId,
      machineId,
      json(s),
      now,
    );
  }

  async getSession(sid: string): Promise<HubSession | undefined> {
    const r = await this.db.get<{ value: string; user_id: string; machine_id: string; updated_at: number }>("SELECT * FROM hsession WHERE sid = ?", sid);
    return r ? { session: Session.parse(JSON.parse(r.value)), userId: r.user_id, machineId: r.machine_id, updatedAt: r.updated_at } : undefined;
  }

  /** Hide a machine's sessions its latest sync didn't list; their rows stay for `getSession`. */
  async unlistSessions(machineId: string, listed: readonly string[]): Promise<void> {
    const keep = new Set(listed);
    const rows = await this.db.all<{ sid: string }>("SELECT sid FROM hsession WHERE machine_id = ? AND listed = 1", machineId);
    for (const r of rows) if (!keep.has(r.sid)) await this.db.run("UPDATE hsession SET listed = 0 WHERE sid = ?", r.sid);
  }

  /**
   * Sessions as their machines last listed them (hidden ones excluded), newest first. `userId` keeps one user's; `live` drops ended ones in SQL, so
   * a caller that polls does not parse every session the hub has ever stored.
   */
  async listSessions(filter: { userId?: string; live?: boolean } = {}): Promise<HubSession[]> {
    const where: string[] = ["listed = 1"];
    const params: string[] = [];
    if (filter.userId !== undefined) {
      where.push("user_id = ?");
      params.push(filter.userId);
    }
    if (filter.live) {
      const state = this.db.dialect.jsonText("value", "state");
      where.push(`(${state} IS NULL OR ${state} <> 'ended')`);
    }
    const sql = `SELECT * FROM hsession WHERE ${where.join(" AND ")} ORDER BY updated_at DESC`;
    return (await this.db.all<{ value: string; user_id: string; machine_id: string; updated_at: number }>(sql, ...params)).flatMap((r) => {
      const p = Session.safeParse(JSON.parse(r.value));
      return p.success ? [{ session: p.data, userId: r.user_id, machineId: r.machine_id, updatedAt: r.updated_at }] : [];
    });
  }

  // ---------- goals, plans, steps ----------

  createGoal(g: Omit<Goal, "id">): Promise<Goal> {
    return this.tx(async () => {
      await this.lock("goals");
      const num = ((await this.db.get<{ n: number | null }>("SELECT MAX(num) AS n FROM goal"))?.n ?? 0) + 1;
      const goal = Goal.parse({ ...g, id: `G${num}` });
      await this.db.run("INSERT INTO goal (id, num, state, value, updated_at) VALUES (?, ?, ?, ?, ?)", goal.id, num, goal.state, json(goal), goal.updatedAt);
      return goal;
    });
  }

  async saveGoal(g: Goal): Promise<void> {
    await this.db.run("UPDATE goal SET state = ?, value = ?, updated_at = ? WHERE id = ?", g.state, json(g), g.updatedAt, g.id);
  }

  async getGoal(id: string): Promise<Goal | undefined> {
    const r = await this.db.get<{ value: string }>(`SELECT value FROM goal WHERE ${this.db.dialect.eqNoCase("id")}`, id);
    return r ? Goal.parse(JSON.parse(r.value)) : undefined;
  }

  async listGoals(): Promise<Goal[]> {
    return (await this.db.all<{ value: string }>("SELECT value FROM goal ORDER BY num")).map((r) => Goal.parse(JSON.parse(r.value)));
  }

  // ---------- topics ----------

  /** Define a topic; false when one with that name exists. */
  async createTopic(t: Topic): Promise<boolean> {
    const topic = Topic.parse(t);
    return (await this.db.run("INSERT INTO topic (name, value, created_at) VALUES (?, ?, ?) ON CONFLICT(name) DO NOTHING", topic.name, json(topic), topic.createdAt)).changes > 0;
  }

  async getTopic(name: string): Promise<Topic | undefined> {
    const r = await this.db.get<{ value: string }>("SELECT value FROM topic WHERE name = ?", name);
    return r ? Topic.parse(JSON.parse(r.value)) : undefined;
  }

  async listTopics(): Promise<Topic[]> {
    return (await this.db.all<{ value: string }>("SELECT value FROM topic ORDER BY name")).map((r) => Topic.parse(JSON.parse(r.value)));
  }

  async deleteTopic(name: string): Promise<boolean> {
    return (await this.db.run("DELETE FROM topic WHERE name = ?", name)).changes > 0;
  }

  async savePlan(p: Plan): Promise<void> {
    await this.db.run(
      "INSERT INTO plan (goal, version, decision, value) VALUES (?, ?, ?, ?) ON CONFLICT(goal, version) DO UPDATE SET decision = excluded.decision, value = excluded.value",
      p.goal,
      p.version,
      p.decision,
      json(p),
    );
  }

  async listPlans(goal: string): Promise<Plan[]> {
    return (await this.db.all<{ value: string }>("SELECT value FROM plan WHERE goal = ? ORDER BY version", goal)).map((r) => Plan.parse(JSON.parse(r.value)));
  }

  saveSteps(steps: readonly Step[]): Promise<void> {
    return this.tx(async () => {
      for (const s of steps) {
        await this.db.run(
          "INSERT INTO step (id, goal, state, repo, holder_user, value, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET state = excluded.state, repo = excluded.repo, holder_user = excluded.holder_user, value = excluded.value, updated_at = excluded.updated_at",
          s.id,
          s.goal,
          s.state,
          s.repo,
          s.holderUser ?? null,
          json(s),
          s.updatedAt,
        );
      }
    });
  }

  /**
   * Save a claim of `next` only if the step is still in the state the claimer read (`prev`): a
   * conditional UPDATE, so of several replicas claiming the same step exactly one wins. False when
   * someone else changed it first.
   */
  claimStep(next: Step, prev: Pick<Step, "state" | "holderUser">): Promise<boolean> {
    return this.saveStepIf(next, prev);
  }

  /** Save `next` only if the step still has `prev`'s state and holder (see `claimStep`). */
  async saveStepIf(next: Step, prev: Pick<Step, "state" | "holderUser">): Promise<boolean> {
    const r = await this.db.run(
      "UPDATE step SET state = ?, holder_user = ?, value = ?, updated_at = ? WHERE id = ? AND state = ? AND holder_user IS NOT DISTINCT FROM ?",
      next.state,
      next.holderUser ?? null,
      json(next),
      next.updatedAt,
      next.id,
      prev.state,
      prev.holderUser ?? null,
    );
    return r.changes === 1;
  }

  async getStep(id: string): Promise<Step | undefined> {
    const r = await this.db.get<{ value: string }>(`SELECT value FROM step WHERE ${this.db.dialect.eqNoCase("id")}`, id);
    return r ? Step.parse(JSON.parse(r.value)) : undefined;
  }

  async listSteps(
    filter: { goal?: string | undefined; state?: string | undefined; holderUser?: string | undefined; /** RL-4 */ updatedSince?: number | undefined } = {},
  ): Promise<Step[]> {
    const where: string[] = [];
    const args: SqlValue[] = [];
    if (filter.updatedSince !== undefined) {
      where.push("updated_at >= ?");
      args.push(filter.updatedSince);
    }
    if (filter.goal) {
      where.push(this.db.dialect.eqNoCase("goal"));
      args.push(filter.goal);
    }
    if (filter.state) {
      where.push("state = ?");
      args.push(filter.state);
    }
    if (filter.holderUser) {
      where.push("holder_user = ?");
      args.push(filter.holderUser);
    }
    const sql = `SELECT value FROM step ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY ${this.db.dialect.stepOrder}`;
    return (await this.db.all<{ value: string }>(sql, ...args)).map((r) => Step.parse(JSON.parse(r.value)));
  }

  // ---------- artifacts and profiles (RL-1) ----------

  async addArtifact(a: StoredArtifact, content: Buffer): Promise<void> {
    const v = StoredArtifact.parse(a);
    await this.db.run(
      "INSERT INTO artifact (id, goal, step, round, value, content, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
      v.id,
      v.goal,
      v.step,
      v.round,
      json(v),
      Buffer.from(content),
      v.createdAt,
    );
  }

  /** One artifact; `content` is absent once pruned. */
  async getArtifact(id: string): Promise<{ artifact: StoredArtifact; content?: Buffer } | undefined> {
    const r = await this.db.get<{ value: string; content: Uint8Array | null }>("SELECT value, content FROM artifact WHERE id = ?", id);
    if (!r) return undefined;
    const artifact = StoredArtifact.parse(JSON.parse(r.value));
    return r.content === null || r.content === undefined ? { artifact } : { artifact, content: Buffer.from(r.content) };
  }

  /** Artifacts (metadata only), ordered by `createdAt`, then `id`. */
  async listArtifacts(f: { goal?: string | undefined; step?: string | undefined; round?: number | undefined }): Promise<StoredArtifact[]> {
    const where: string[] = [];
    const args: SqlValue[] = [];
    if (f.goal !== undefined) {
      where.push("goal = ?");
      args.push(f.goal);
    }
    if (f.step !== undefined) {
      where.push("step = ?");
      args.push(f.step);
    }
    if (f.round !== undefined) {
      where.push("round = ?");
      args.push(f.round);
    }
    const sql = `SELECT value FROM artifact ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY created_at, id`;
    return (await this.db.all<{ value: string }>(sql, ...args)).map((r) => StoredArtifact.parse(JSON.parse(r.value)));
  }

  /**
   * Drop the content of artifacts of these goals created before `before` (metadata and sha256 are
   * kept; `prunedAt = now`). Returns how many were pruned.
   */
  async pruneArtifacts(goals: readonly string[], before: number, now: number): Promise<number> {
    if (!goals.length) return 0;
    return this.tx(async () => {
      const rows = await this.db.all<{ id: string; value: string }>(
        `SELECT id, value FROM artifact WHERE goal IN (${goals.map(() => "?").join(", ")}) AND created_at < ? AND content IS NOT NULL`,
        ...goals,
        before,
      );
      for (const r of rows) {
        const v = { ...(JSON.parse(r.value) as StoredArtifact), prunedAt: now };
        await this.db.run("UPDATE artifact SET content = NULL, value = ? WHERE id = ?", json(v), r.id);
      }
      return rows.length;
    });
  }

  /** Register or replace a profile. */
  async saveProfile(p: StoredProfile): Promise<void> {
    await this.db.run(
      "INSERT INTO profile (name, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(name) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at",
      p.name,
      json(p),
      p.updatedAt,
    );
  }

  async getProfile(name: string): Promise<StoredProfile | undefined> {
    const r = await this.db.get<{ value: string }>("SELECT value FROM profile WHERE name = ?", name);
    return r ? (JSON.parse(r.value) as StoredProfile) : undefined;
  }

  /** Registered profiles by name. */
  async listProfiles(): Promise<StoredProfile[]> {
    return (await this.db.all<{ value: string }>("SELECT value FROM profile ORDER BY name")).map((r) => JSON.parse(r.value) as StoredProfile);
  }

  // ---------- review records and items (RL-2) ----------

  /** Store a review record; false (nothing written) when (step, round) already has one. */
  async addReview(r: StoredReview): Promise<boolean> {
    const v = StoredReview.parse(r);
    const res = await this.db.run(
      "INSERT INTO review_record (step, round, goal, lineage, raising, complete, value, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT (step, round) DO NOTHING",
      v.step,
      v.round,
      v.goal,
      v.lineage,
      v.raising ? 1 : 0,
      v.complete ? 1 : 0,
      json(v),
      v.at,
    );
    return res.changes === 1;
  }

  async getReview(step: string, round: number): Promise<StoredReview | undefined> {
    const r = await this.db.get<{ value: string }>("SELECT value FROM review_record WHERE step = ? AND round = ?", step, round);
    return r ? StoredReview.parse(JSON.parse(r.value)) : undefined;
  }

  /** Review records in insertion order (never by `at`). */
  async listReviews(f: { step?: string | undefined; lineage?: string | undefined; raising?: boolean | undefined; complete?: boolean | undefined }): Promise<StoredReview[]> {
    const where: string[] = [];
    const args: SqlValue[] = [];
    if (f.step !== undefined) {
      where.push("step = ?");
      args.push(f.step);
    }
    if (f.lineage !== undefined) {
      where.push("lineage = ?");
      args.push(f.lineage);
    }
    if (f.raising !== undefined) {
      where.push("raising = ?");
      args.push(f.raising ? 1 : 0);
    }
    if (f.complete !== undefined) {
      where.push("complete = ?");
      args.push(f.complete ? 1 : 0);
    }
    const sql = `SELECT value FROM review_record ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY ${this.db.dialect.stepOrder}`;
    return (await this.db.all<{ value: string }>(sql, ...args)).map((r) => StoredReview.parse(JSON.parse(r.value)));
  }

  async getItem(lineage: string, fp: string): Promise<ItemRow | undefined> {
    const r = await this.db.get<{ value: string }>("SELECT value FROM review_item WHERE lineage = ? AND fp = ?", lineage, fp);
    return r ? ItemRow.parse(JSON.parse(r.value)) : undefined;
  }

  /** The item rows of a lineage, ordered by fingerprint. */
  async listItems(lineage: string): Promise<ItemRow[]> {
    return (await this.db.all<{ value: string }>(`SELECT value FROM review_item WHERE lineage = ? ORDER BY fp`, lineage)).map((r) =>
      ItemRow.parse(JSON.parse(r.value)),
    );
  }

  /** Insert or replace an item row. */
  async saveItem(row: ItemRow): Promise<void> {
    const v = ItemRow.parse(row);
    await this.db.run(
      "INSERT INTO review_item (lineage, fp, value, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT (lineage, fp) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at",
      v.lineage,
      v.fp,
      json(v),
      v.last.at,
    );
  }

  async addItemHistory(lineage: string, fp: string, e: ItemHistoryEntry): Promise<void> {
    const v = ItemHistoryEntry.parse(e);
    await this.db.run("INSERT INTO item_history (lineage, fp, step, value) VALUES (?, ?, ?, ?)", lineage, fp, v.step, json(v));
  }

  /** History entries of a lineage (or one item of it), in insertion order. */
  async itemHistory(lineage: string, fp?: string): Promise<ItemHistoryEntry[]> {
    const rows =
      fp === undefined
        ? await this.db.all<{ value: string }>("SELECT value FROM item_history WHERE lineage = ? ORDER BY seq", lineage)
        : await this.db.all<{ value: string }>("SELECT value FROM item_history WHERE lineage = ? AND fp = ? ORDER BY seq", lineage, fp);
    return rows.map((r) => ItemHistoryEntry.parse(JSON.parse(r.value)));
  }

  /** RL-6: the whole item history (every lineage and item) in one ordered read, insertion order. */
  async listItemHistory(): Promise<{ lineage: string; fp: string; entry: ItemHistoryEntry }[]> {
    const rows = await this.db.all<{ lineage: string; fp: string; value: string }>("SELECT lineage, fp, value FROM item_history ORDER BY seq");
    return rows.map((r) => ({ lineage: r.lineage, fp: r.fp, entry: ItemHistoryEntry.parse(JSON.parse(r.value)) }));
  }

  /** The disposition entries of the item history, in insertion order. */
  async listDispositions(f: {
    step?: string | undefined;
    lineage?: string | undefined;
    fp?: string | undefined;
    goal?: string | undefined;
    /** RL-4: only entries of these steps (`[]` → none). */
    steps?: readonly string[] | undefined;
    /** RL-4: only entries with `at ≥ since`. */
    since?: number | undefined;
  }): Promise<DispositionRow[]> {
    if (f.steps && !f.steps.length) return [];
    const where: string[] = [];
    const args: SqlValue[] = [];
    for (const k of ["step", "lineage", "fp"] as const) {
      const v = f[k];
      if (v !== undefined) {
        where.push(`${k} = ?`);
        args.push(v);
      }
    }
    if (f.steps) {
      where.push(`step IN (${f.steps.map(() => "?").join(", ")})`);
      args.push(...f.steps);
    }
    const sql = `SELECT lineage, fp, value FROM item_history ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY seq`;
    const out: DispositionRow[] = [];
    for (const r of await this.db.all<{ lineage: string; fp: string; value: string }>(sql, ...args)) {
      const e = ItemHistoryEntry.parse(JSON.parse(r.value));
      if (e.kind !== "disposition" || (f.goal !== undefined && e.goal !== f.goal)) continue;
      if (f.since !== undefined && e.at < f.since) continue;
      out.push(
        DispositionRow.parse({
          lineage: r.lineage,
          fp: r.fp,
          goal: e.goal,
          step: e.step,
          round: e.round,
          disposition: e.disposition,
          from: e.from,
          reason: e.reason,
          decider: e.decider,
          via: e.via,
          ...(e.answer !== undefined ? { answer: e.answer } : {}),
          ...(e.link !== undefined ? { link: e.link } : {}),
          ...(e.until !== undefined ? { until: e.until } : {}),
          at: e.at,
        }),
      );
    }
    return out;
  }

  // ---------- pulses (RL-3) ----------

  /** A new pulse, id `p-<num>`; numbers are never reused (deleted pulses keep their row). */
  createPulse(p: Omit<Pulse, "id">): Promise<Pulse> {
    return this.tx(async () => {
      await this.lock("pulses");
      const num = ((await this.db.get<{ n: number | null }>("SELECT MAX(num) AS n FROM pulse"))?.n ?? 0) + 1;
      const pulse = Pulse.parse({ ...p, id: `p-${num}` });
      await this.db.run(
        "INSERT INTO pulse (id, num, owner, enabled, next_at, value, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
        pulse.id,
        num,
        pulse.owner,
        pulse.enabled ? 1 : 0,
        pulse.nextAt ?? null,
        json(pulse),
        pulse.updatedAt,
      );
      return pulse;
    });
  }

  async getPulse(id: string): Promise<Pulse | undefined> {
    const r = await this.db.get<{ value: string }>("SELECT value FROM pulse WHERE id = ?", id);
    return r ? Pulse.parse(JSON.parse(r.value)) : undefined;
  }

  async savePulse(p: Pulse): Promise<void> {
    const pulse = Pulse.parse(p);
    await this.db.run(
      "UPDATE pulse SET owner = ?, enabled = ?, next_at = ?, value = ?, updated_at = ? WHERE id = ?",
      pulse.owner,
      pulse.enabled ? 1 : 0,
      pulse.nextAt ?? null,
      json(pulse),
      pulse.updatedAt,
      pulse.id,
    );
  }

  /** Pulses by number; deleted ones only with `deleted: true`. */
  async listPulses(f: { owner?: string | undefined; deleted?: boolean | undefined } = {}): Promise<Pulse[]> {
    const rows =
      f.owner === undefined
        ? await this.db.all<{ value: string }>("SELECT value FROM pulse ORDER BY num")
        : await this.db.all<{ value: string }>("SELECT value FROM pulse WHERE owner = ? ORDER BY num", f.owner);
    return rows.map((r) => Pulse.parse(JSON.parse(r.value))).filter((p) => f.deleted === true || p.deletedAt === undefined);
  }

  /** Enabled, not deleted pulses whose next slot is due at `now`, by number. */
  async duePulses(now: number): Promise<Pulse[]> {
    const rows = await this.db.all<{ value: string }>("SELECT value FROM pulse WHERE enabled = 1 AND next_at IS NOT NULL AND next_at <= ? ORDER BY num", now);
    return rows.map((r) => Pulse.parse(JSON.parse(r.value))).filter((p) => p.deletedAt === undefined);
  }

  /** Insert a slot row; false (nothing written) when `(pulse, slot)` exists. */
  async addSlot(s: PulseSlot): Promise<boolean> {
    const slot = PulseSlot.parse(s);
    const r = await this.db.run(
      "INSERT INTO pulse_slot (pulse, slot, at, state, goal, started_at, value, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT (pulse, slot) DO NOTHING",
      slot.pulse,
      slot.slot,
      slot.at,
      slot.state,
      slot.goal ?? null,
      slot.startedAt ?? null,
      json(slot),
      slot.decidedAt,
    );
    return r.changes === 1;
  }

  async getSlot(pulse: string, slot: string): Promise<PulseSlot | undefined> {
    const r = await this.db.get<{ value: string }>("SELECT value FROM pulse_slot WHERE pulse = ? AND slot = ?", pulse, slot);
    return r ? PulseSlot.parse(JSON.parse(r.value)) : undefined;
  }

  async saveSlot(s: PulseSlot): Promise<void> {
    const slot = PulseSlot.parse(s);
    await this.db.run(
      "UPDATE pulse_slot SET at = ?, state = ?, goal = ?, started_at = ?, value = ?, updated_at = ? WHERE pulse = ? AND slot = ?",
      slot.at,
      slot.state,
      slot.goal ?? null,
      slot.startedAt ?? null,
      json(slot),
      slot.decidedAt,
      slot.pulse,
      slot.slot,
    );
  }

  /** Slots, newest first (`at`, then `slot`, descending). `pending` = fired and not started. */
  async listSlots(f: { pulse?: string | undefined; state?: SlotState | undefined; pending?: true | undefined; limit?: number | undefined } = {}): Promise<PulseSlot[]> {
    const where: string[] = [];
    const args: SqlValue[] = [];
    if (f.pulse !== undefined) {
      where.push("pulse = ?");
      args.push(f.pulse);
    }
    if (f.pending) where.push("state = 'fired' AND started_at IS NULL");
    if (f.state !== undefined) {
      where.push("state = ?");
      args.push(f.state);
    }
    let sql = `SELECT value FROM pulse_slot ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY at DESC, ${this.db.dialect.binary("slot")} DESC`;
    if (f.limit !== undefined) {
      sql += " LIMIT ?";
      args.push(f.limit);
    }
    return (await this.db.all<{ value: string }>(sql, ...args)).map((r) => PulseSlot.parse(JSON.parse(r.value)));
  }

  // ---------- roster (RL-5) ----------

  /** Replace every repo-origin agent row of a machine; `false` (nothing written) when the set is unchanged. */
  async replaceMachineAgents(machine: string, agents: AgentReport[], now: number): Promise<boolean> {
    const seen = new Set<string>();
    const next = agents
      .map((a) => AgentReport.parse(a))
      .filter((a) => {
        const k = `${a.repo}\n${a.path}`;
        if (seen.has(k)) return false;
        seen.add(k);
        return true;
      })
      .sort((a, b) => cmp(a.repo, b.repo) || cmp(a.path, b.path));
    const stored = (await this.db.all<{ value: string }>("SELECT value FROM agent_def WHERE origin = 'repo' AND machine = ?", machine))
      .map((r) => AgentReport.parse(JSON.parse(r.value)))
      .sort((a, b) => cmp(a.repo, b.repo) || cmp(a.path, b.path));
    if (JSON.stringify(stored) === JSON.stringify(next)) return false;
    await this.db.run("DELETE FROM agent_def WHERE origin = 'repo' AND machine = ?", machine);
    for (const a of next) {
      await this.db.run(
        "INSERT INTO agent_def (id, origin, machine, repo, name, hash, current, value, body, updated_at) VALUES (?, 'repo', ?, ?, ?, ?, 1, ?, NULL, ?)",
        `r\n${machine}\n${a.repo}\n${a.path}`,
        machine,
        a.repo,
        a.name,
        a.hash,
        json(a),
        now,
      );
    }
    return true;
  }

  /** Repo copies machines reported, optionally of one agent name. */
  async listRepoAgents(f: { name?: string | undefined } = {}): Promise<(AgentReport & { machine: string; at: number })[]> {
    const order = `ORDER BY ${this.db.dialect.binary("id")}`;
    const rows =
      f.name === undefined
        ? await this.db.all<{ machine: string; value: string; updated_at: number }>(`SELECT machine, value, updated_at FROM agent_def WHERE origin = 'repo' ${order}`)
        : await this.db.all<{ machine: string; value: string; updated_at: number }>(`SELECT machine, value, updated_at FROM agent_def WHERE origin = 'repo' AND name = ? ${order}`, f.name);
    return rows.map((r) => ({ ...AgentReport.parse(JSON.parse(r.value)), machine: r.machine, at: Number(r.updated_at) }));
  }

  /** Register or replace a catalog source (`created_at` is kept). */
  async saveCatalogSource(s: StoredCatalogSource): Promise<void> {
    await this.db.run(
      "INSERT INTO catalog_source (repo, value, created_at) VALUES (?, ?, ?) ON CONFLICT (repo) DO UPDATE SET value = excluded.value",
      s.repo,
      json(s),
      s.createdAt,
    );
  }

  async getCatalogSource(repo: string): Promise<StoredCatalogSource | undefined> {
    const r = await this.db.get<{ value: string }>("SELECT value FROM catalog_source WHERE repo = ?", repo);
    return r ? (JSON.parse(r.value) as StoredCatalogSource) : undefined;
  }

  /** Catalog sources by repo id. */
  async listCatalogSources(): Promise<StoredCatalogSource[]> {
    return (await this.db.all<{ value: string }>(`SELECT value FROM catalog_source ORDER BY ${this.db.dialect.binary("repo")}`)).map(
      (r) => JSON.parse(r.value) as StoredCatalogSource,
    );
  }

  /**
   * Store the definitions of one push: a new `(repo, name, hash)` is added, a known one gets `commit`
   * appended (at most 50 kept) and (RL-7) its stored `front` replaced by the pushed one; afterwards
   * exactly the pushed pairs are current. Texts are never deleted.
   */
  async putCatalogDefs(
    repo: string,
    commit: string,
    defs: { path: string; name: string; hash: string; text: string; front: AgentFront }[],
    _by: string,
    now: number,
  ): Promise<{ added: number }> {
    let added = 0;
    const ids: string[] = [];
    for (const d of defs) {
      const id = `c\n${repo}\n${d.name}\n${d.hash}`;
      ids.push(id);
      const r = await this.db.get<{ value: string }>(`SELECT value FROM agent_def WHERE id = ?${this.db.dialect.forUpdate}`, id);
      if (!r) {
        const value: CatalogDefValue = { path: d.path, commits: [commit], pushedAt: now, front: d.front };
        await this.db.run(
          "INSERT INTO agent_def (id, origin, machine, repo, name, hash, current, value, body, updated_at) VALUES (?, 'catalog', NULL, ?, ?, ?, 0, ?, ?, ?)",
          id,
          repo,
          d.name,
          d.hash,
          json(value),
          d.text,
          now,
        );
        added++;
      } else {
        const v = JSON.parse(r.value) as CatalogDefValue;
        const commits = v.commits.includes(commit) ? v.commits : [...v.commits, commit].slice(-50);
        const value: CatalogDefValue = { ...v, path: d.path, commits, pushedAt: now, front: d.front };
        await this.db.run("UPDATE agent_def SET value = ?, updated_at = ? WHERE id = ?", json(value), now, id);
      }
    }
    await this.db.run("UPDATE agent_def SET current = 0 WHERE origin = 'catalog' AND repo = ?", repo);
    for (let i = 0; i < ids.length; i += 500) {
      const chunk = ids.slice(i, i + 500);
      await this.db.run(`UPDATE agent_def SET current = 1 WHERE id IN (${chunk.map(() => "?").join(", ")})`, ...chunk);
    }
    return { added };
  }

  /** Catalog definitions with their texts: by name, newest push first, then hash. */
  async listCatalogDefs(f: { repo?: string | undefined; name?: string | undefined; current?: boolean | undefined } = {}): Promise<CatalogDefView[]> {
    const where = ["origin = 'catalog'"];
    const args: SqlValue[] = [];
    if (f.repo !== undefined) {
      where.push("repo = ?");
      args.push(f.repo);
    }
    if (f.name !== undefined) {
      where.push("name = ?");
      args.push(f.name);
    }
    if (f.current !== undefined) {
      where.push("current = ?");
      args.push(f.current ? 1 : 0);
    }
    const rows = await this.db.all<{ repo: string; name: string; hash: string; current: number; value: string; body: string | null }>(
      `SELECT repo, name, hash, current, value, body FROM agent_def WHERE ${where.join(" AND ")}`,
      ...args,
    );
    const defs = rows.map((r): CatalogDefView => {
      const v = JSON.parse(r.value) as CatalogDefValue;
      return {
        ...v.front,
        key: `${r.repo.slice(r.repo.lastIndexOf("/") + 1)}/${r.name}`,
        source: r.repo,
        name: r.name,
        path: v.path,
        hash: r.hash,
        commits: v.commits,
        commit: v.commits.at(-1) ?? "",
        current: Number(r.current) === 1,
        pushedAt: v.pushedAt,
        text: r.body ?? "",
      };
    });
    return defs.sort((a, b) => cmp(a.name, b.name) || b.pushedAt - a.pushedAt || cmp(a.hash, b.hash) || cmp(a.source, b.source));
  }

  // ---------- notes and questions ----------

  async addNote(n: Omit<Note, "id">): Promise<Note> {
    const { id } = (await this.db.get<{ id: number }>("INSERT INTO note (step, user_id, sid, text, at) VALUES (?, ?, ?, ?, ?) RETURNING id", n.step, n.user, n.sid ?? null, n.text, n.at)) as { id: number };
    return { ...n, id };
  }

  async listNotes(step: string): Promise<Note[]> {
    return (await this.db.all<{ id: number; step: string; user_id: string; sid: string | null; text: string; at: number }>("SELECT * FROM note WHERE step = ? ORDER BY id", step)).map((r) => ({
      id: r.id,
      step: r.step,
      user: r.user_id,
      ...(r.sid ? { sid: r.sid } : {}),
      text: r.text,
      at: r.at,
    }));
  }

  addQuestion(q: Omit<Question, "id">): Promise<Question> {
    return this.tx(async () => {
      const { id } = (await this.db.get<{ id: number }>("INSERT INTO question (value, at) VALUES (?, ?) RETURNING id", json(q), q.at)) as { id: number };
      const full = { ...q, id };
      await this.db.run("UPDATE question SET value = ? WHERE id = ?", json(full), id);
      return full;
    });
  }

  async getQuestion(id: number): Promise<Question | undefined> {
    const r = await this.db.get<{ value: string }>("SELECT value FROM question WHERE id = ?", id);
    return r ? Question.parse(JSON.parse(r.value)) : undefined;
  }

  async saveQuestion(q: Question): Promise<void> {
    await this.db.run("UPDATE question SET value = ?, answered = ? WHERE id = ?", json(q), q.answer !== undefined ? 1 : 0, q.id);
  }

  async openQuestions(): Promise<Question[]> {
    return (await this.db.all<{ value: string }>("SELECT value FROM question WHERE answered = 0 ORDER BY id")).map((r) => Question.parse(JSON.parse(r.value)));
  }

  // ---------- messages ----------

  addMessage(m: { toMachine: string; toSid: string; fromUser: string; kind: string; text: string; data?: Record<string, unknown> | undefined }, now: number): Promise<MessageRow> {
    return this.tx(async () => {
      const { id } = (await this.db.get<{ id: number }>(
        "INSERT INTO message (to_machine, to_sid, from_user, kind, text, state, created_at, data) VALUES (?, ?, ?, ?, ?, 'pending', ?, ?) RETURNING id",
        m.toMachine,
        m.toSid,
        m.fromUser,
        m.kind,
        m.text,
        now,
        m.data ? json(m.data) : null,
      )) as { id: number };
      return (await this.getMessage(id)) as MessageRow;
    });
  }

  async getMessage(id: number): Promise<MessageRow | undefined> {
    const r = await this.db.get<MessageDbRow>("SELECT * FROM message WHERE id = ?", id);
    return r ? messageFrom(r) : undefined;
  }

  async inbox(machineId: string): Promise<MessageRow[]> {
    return (await this.db.all<MessageDbRow>("SELECT * FROM message WHERE to_machine = ? AND state = 'pending' ORDER BY id", machineId)).map(messageFrom);
  }

  async ackMessage(id: number, machineId: string, state: "delivered" | "failed", method: string | undefined, now: number): Promise<boolean> {
    const r = await this.db.run("UPDATE message SET state = ?, method = ?, acked_at = ? WHERE id = ? AND to_machine = ? AND state = 'pending'", state, method ?? null, now, id, machineId);
    return r.changes > 0;
  }

  // ---------- events and idempotency ----------

  /**
   * Append an event; returns its seq, or undefined when an event with the same id exists (dedupe).
   * On Postgres the transaction holds the `events` lock from here to its commit, so seqs become
   * visible in order and a reader's `after=` cursor never skips an event committed later with a
   * smaller seq. (SQLite serialises every write transaction already.)
   */
  appendEvent(e: NewEvent): Promise<number | undefined> {
    return this.tx(async () => {
      await this.lock("events");
      return this.insertEvent(e);
    });
  }

  private async insertEvent(e: NewEvent): Promise<number | undefined> {
    const r = await this.db.get<{ seq: number }>(
      "INSERT INTO event (id, at, type, user_id, sid, goal, step, payload) VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO NOTHING RETURNING seq",
      e.id ?? randomUUID(),
      e.at,
      e.type,
      e.user ?? null,
      e.sid ?? null,
      e.goal ?? null,
      e.step ?? null,
      json(e.payload ?? {}),
    );
    return r?.seq;
  }

  async events(after: number, limit: number, filter: { goal?: string | undefined } = {}): Promise<EventRow[]> {
    const rows = filter.goal
      ? await this.db.all<EventDbRow>("SELECT * FROM event WHERE seq > ? AND goal = ? ORDER BY seq LIMIT ?", after, filter.goal, limit)
      : await this.db.all<EventDbRow>("SELECT * FROM event WHERE seq > ? ORDER BY seq LIMIT ?", after, limit);
    return rows.map(eventFrom);
  }

  /** Events about a step, or about any step of a goal (session events carry the step). */
  async eventsFor(filter: { step?: string; goal?: string }): Promise<EventRow[]> {
    const rows = filter.step
      ? await this.db.all<EventDbRow>("SELECT * FROM event WHERE step = ? ORDER BY seq", filter.step)
      : await this.db.all<EventDbRow>(`SELECT * FROM event WHERE goal = ? OR step ${this.db.dialect.like} ? ORDER BY seq`, filter.goal ?? "", `${filter.goal ?? ""}.%`);
    return rows.map(eventFrom);
  }

  async pruneEvents(before: number): Promise<number> {
    return (await this.db.run("DELETE FROM event WHERE at < ?", before)).changes;
  }

  /** The schema version this mesh migrates to (the same on both dialects). */
  static readonly SCHEMA_VERSION = HUB_MIGRATIONS.length;

  /** The database's schema version; a query that fails means the database is unreachable. */
  async schemaVersion(): Promise<number> {
    return (await this.db.get<{ version: number }>("SELECT version FROM schema_version"))?.version ?? 0;
  }

  /** A consistent copy of the whole database (VACUUM INTO), safe while the hub runs. SQLite only. */
  async backup(path: string): Promise<void> {
    if (this.db.dialect.name !== "sqlite") throw new Error("mesh hub backup copies a SQLite hub; on Postgres use the database's own tools (pg_dump, snapshots)");
    await this.db.run("VACUUM INTO ?", path);
  }

  recentEvents(limit: number): Promise<EventRow[]> {
    return this.tx(async () => {
      const max = (await this.db.get<{ m: number | null }>("SELECT MAX(seq) AS m FROM event"))?.m ?? 0;
      return this.events(Math.max(0, max - limit), limit);
    });
  }

  async getIdem(key: string, userId: string): Promise<unknown> {
    const r = await this.db.get<{ response: string }>("SELECT response FROM idem WHERE key = ? AND user_id = ?", key, userId);
    return r ? JSON.parse(r.response) : undefined;
  }

  putIdem(key: string, userId: string, response: unknown, now: number): Promise<void> {
    return this.tx(async () => {
      await this.db.run("INSERT INTO idem (key, user_id, response, at) VALUES (?, ?, ?, ?) ON CONFLICT(key, user_id) DO NOTHING", key, userId, json(response), now);
      await this.db.run("DELETE FROM idem WHERE at < ?", now - 24 * 60 * 60_000);
    });
  }
}
