// Hub persistence (plan §3.2, §8). Rows keep a few indexed columns plus the JSON value.

import { randomUUID } from "node:crypto";
import { Goal, Plan, Question, ServiceScope, Session, Step, Topic, type Note, type Repo, type ShareLevel } from "../protocol/index.ts";
import { openDb, SOLE_LEADER, type Channel, type Db, type Leader } from "./db.ts";
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
  // v0.1.9 (MM-1): a machine's share level, nickname (unique per person; NULL on many rows) and one
  // JSON object for the rest (now the repo inventory; later labels and accept policy).
  `ALTER TABLE machine ADD COLUMN share TEXT;
   ALTER TABLE machine ADD COLUMN nickname TEXT;
   ALTER TABLE machine ADD COLUMN extra TEXT;
   CREATE UNIQUE INDEX machine_nickname ON machine (user_id, nickname);`,
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
  `ALTER TABLE machine ADD COLUMN share TEXT;
   ALTER TABLE machine ADD COLUMN nickname TEXT;
   ALTER TABLE machine ADD COLUMN extra TEXT;
   CREATE UNIQUE INDEX machine_nickname ON machine (user_id, nickname);`,
];

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
}

/** Facts a sync reports about its machine (MM-1). */
export interface MachineFacts {
  share?: ShareLevel | undefined;
  repos?: Repo[] | undefined;
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
type MachineExtra = { repos?: Repo[]; reposAt?: number };
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
   * so two syncs of one machine never lose each other's keys.
   */
  async touchMachine(id: string, now: number, counts: Record<string, number>, facts?: MachineFacts): Promise<void> {
    if (facts?.share === undefined && facts?.repos === undefined) {
      await this.db.run("UPDATE machine SET last_seen = ?, counts = ? WHERE id = ?", now, json(counts), id);
      return;
    }
    await this.tx(async () => {
      const r = await this.db.get<{ extra: string | null }>(`SELECT extra FROM machine WHERE id = ?${this.db.dialect.forUpdate}`, id);
      if (!r) return;
      const extra = facts.repos !== undefined ? json({ ...machineExtra(r.extra), repos: facts.repos, reposAt: now }) : r.extra;
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

  /** The user's machine with this nickname, if any. */
  async machineByNickname(userId: string, nickname: string): Promise<MachineRow | undefined> {
    const r = await this.db.get<MachineDbRow>("SELECT * FROM machine WHERE user_id = ? AND nickname = ?", userId, nickname);
    return r ? machineFrom(r) : undefined;
  }

  async upsertSession(s: Session, userId: string, machineId: string, now: number): Promise<void> {
    await this.db.run(
      "INSERT INTO hsession (sid, user_id, machine_id, value, updated_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(sid) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at, machine_id = excluded.machine_id",
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

  /**
   * Stored sessions, newest first. `userId` keeps one user's; `live` drops ended ones in SQL, so
   * a caller that polls does not parse every session the hub has ever stored.
   */
  async listSessions(filter: { userId?: string; live?: boolean } = {}): Promise<HubSession[]> {
    const where: string[] = [];
    const params: string[] = [];
    if (filter.userId !== undefined) {
      where.push("user_id = ?");
      params.push(filter.userId);
    }
    if (filter.live) {
      const state = this.db.dialect.jsonText("value", "state");
      where.push(`(${state} IS NULL OR ${state} <> 'ended')`);
    }
    const sql = `SELECT * FROM hsession ${where.length ? `WHERE ${where.join(" AND ")} ` : ""}ORDER BY updated_at DESC`;
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

  async listSteps(filter: { goal?: string | undefined; state?: string | undefined; holderUser?: string | undefined } = {}): Promise<Step[]> {
    const where: string[] = [];
    const args: string[] = [];
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
