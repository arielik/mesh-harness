// Hub persistence (plan §3.2, §8). Rows keep a few indexed columns plus the JSON value.

import { randomUUID } from "node:crypto";
import { Goal, Plan, Question, Session, Step, type Note } from "../protocol/index.ts";
import { openDb, type Db } from "./db.ts";

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
];

export type TokenKind = "device" | "web" | "service";

export interface TokenRow {
  hash: string;
  userId: string;
  kind: TokenKind;
  machineId?: string | undefined;
  label?: string | undefined;
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

type MachineDbRow = { id: string; user_id: string; hostname: string; last_seen: number; counts: string };
const machineFrom = (r: MachineDbRow): MachineRow => ({ id: r.id, userId: r.user_id, hostname: r.hostname, lastSeen: r.last_seen, counts: JSON.parse(r.counts) });

/**
 * Every method is async (the `Db` may be SQLite or, from M4.6, Postgres). Methods that issue more
 * than one statement run them in one transaction, so callers never see a half-written row.
 */
export class HubStore {
  readonly db: Db;

  constructor(db: Db) {
    this.db = db;
  }

  static async open(path: string): Promise<HubStore> {
    return new HubStore(await openDb(path, HUB_MIGRATIONS));
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

  // ---------- users ----------

  async getUser(id: string): Promise<UserRow | undefined> {
    const r = await this.db.get<UserDbRow>("SELECT * FROM user WHERE id = ?", id);
    return r ? userFrom(r) : undefined;
  }

  async listUsers(): Promise<UserRow[]> {
    return (await this.db.all<UserDbRow>("SELECT * FROM user ORDER BY id")).map(userFrom);
  }

  upsertIdentity(id: { provider: string; subject: string; name?: string | undefined; email?: string | undefined; groups: string[] }, now: number): Promise<UserRow> {
    return this.tx(async () => {
      const existing = await this.db.get<{ user_id: string }>("SELECT user_id FROM identity WHERE provider = ? AND subject = ?", id.provider, id.subject);
      let userId = existing?.user_id;
      if (!userId) {
        const base = slug(id.name ?? id.email ?? id.subject);
        userId = base;
        for (let n = 2; await this.getUser(userId); n++) userId = `${base}-${n}`;
        await this.db.run("INSERT INTO user (id, name, email, created_at) VALUES (?, ?, ?, ?)", userId, id.name ?? id.subject, id.email ?? null, now);
        await this.db.run("INSERT INTO identity (provider, subject, user_id, groups, last_login) VALUES (?, ?, ?, ?, ?)", id.provider, id.subject, userId, json(id.groups), now);
      } else {
        await this.db.run("UPDATE identity SET groups = ?, last_login = ? WHERE provider = ? AND subject = ?", json(id.groups), now, id.provider, id.subject);
        if (id.name) await this.db.run("UPDATE user SET name = ?, email = COALESCE(?, email) WHERE id = ?", id.name, id.email ?? null, userId);
      }
      return (await this.getUser(userId)) as UserRow;
    });
  }

  async setUserRoles(userId: string, roles: string[]): Promise<void> {
    await this.db.run("UPDATE user SET roles = ? WHERE id = ?", json(roles), userId);
  }

  async setRolesExtra(userId: string, roles: string[]): Promise<void> {
    await this.db.run("UPDATE user SET roles_extra = ? WHERE id = ?", json(roles), userId);
  }

  /** Move an identity to another user (admin `link-identity`). */
  async linkIdentity(provider: string, subject: string, userId: string): Promise<boolean> {
    return (await this.db.run("UPDATE identity SET user_id = ? WHERE provider = ? AND subject = ?", userId, provider, subject)).changes > 0;
  }

  // ---------- tokens ----------

  async insertToken(t: TokenRow): Promise<void> {
    await this.db.run(
      "INSERT INTO token (hash, user_id, kind, machine_id, label, created_at, last_used, expires_at, revoked) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0)",
      t.hash,
      t.userId,
      t.kind,
      t.machineId ?? null,
      t.label ?? null,
      t.createdAt,
      t.lastUsed,
      t.expiresAt,
    );
  }

  async getToken(hash: string): Promise<TokenRow | undefined> {
    const r = await this.db.get<{ hash: string; user_id: string; kind: TokenKind; machine_id: string | null; label: string | null; created_at: number; last_used: number; expires_at: number; revoked: number }>(
      "SELECT * FROM token WHERE hash = ?",
      hash,
    );
    if (!r) return undefined;
    return { hash: r.hash, userId: r.user_id, kind: r.kind, machineId: opt(r.machine_id), label: opt(r.label), createdAt: r.created_at, lastUsed: r.last_used, expiresAt: r.expires_at, revoked: r.revoked === 1 };
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
    await this.db.run("INSERT OR REPLACE INTO login_attempt (id, value, created_at) VALUES (?, ?, ?)", id, json(value), now);
  }

  getLoginAttempt<T>(id: string, now: number, ttlMs: number): Promise<T | undefined> {
    return this.tx(async () => {
      await this.db.run("DELETE FROM login_attempt WHERE created_at < ?", now - ttlMs);
      const r = await this.db.get<{ value: string }>("SELECT value FROM login_attempt WHERE id = ?", id);
      return r ? (JSON.parse(r.value) as T) : undefined;
    });
  }

  async deleteLoginAttempt(id: string): Promise<void> {
    await this.db.run("DELETE FROM login_attempt WHERE id = ?", id);
  }

  // ---------- machines and sessions ----------

  async upsertMachine(m: { id: string; userId: string; hostname: string }, now: number): Promise<void> {
    await this.db.run(
      "INSERT INTO machine (id, user_id, hostname, last_seen) VALUES (?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET hostname = excluded.hostname, last_seen = excluded.last_seen",
      m.id,
      m.userId,
      m.hostname,
      now,
    );
  }

  async getMachine(id: string): Promise<MachineRow | undefined> {
    const r = await this.db.get<MachineDbRow>("SELECT * FROM machine WHERE id = ?", id);
    return r ? machineFrom(r) : undefined;
  }

  async listMachines(): Promise<MachineRow[]> {
    return (await this.db.all<MachineDbRow>("SELECT * FROM machine ORDER BY user_id, hostname")).map(machineFrom);
  }

  async touchMachine(id: string, now: number, counts: Record<string, number>): Promise<void> {
    await this.db.run("UPDATE machine SET last_seen = ?, counts = ? WHERE id = ?", now, json(counts), id);
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

  async listSessions(): Promise<HubSession[]> {
    return (await this.db.all<{ value: string; user_id: string; machine_id: string; updated_at: number }>("SELECT * FROM hsession ORDER BY updated_at DESC")).flatMap((r) => {
      const p = Session.safeParse(JSON.parse(r.value));
      return p.success ? [{ session: p.data, userId: r.user_id, machineId: r.machine_id, updatedAt: r.updated_at }] : [];
    });
  }

  // ---------- goals, plans, steps ----------

  createGoal(g: Omit<Goal, "id">): Promise<Goal> {
    return this.tx(async () => {
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
    const r = await this.db.get<{ value: string }>("SELECT value FROM goal WHERE id = ? COLLATE NOCASE", id);
    return r ? Goal.parse(JSON.parse(r.value)) : undefined;
  }

  async listGoals(): Promise<Goal[]> {
    return (await this.db.all<{ value: string }>("SELECT value FROM goal ORDER BY num")).map((r) => Goal.parse(JSON.parse(r.value)));
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

  async getStep(id: string): Promise<Step | undefined> {
    const r = await this.db.get<{ value: string }>("SELECT value FROM step WHERE id = ? COLLATE NOCASE", id);
    return r ? Step.parse(JSON.parse(r.value)) : undefined;
  }

  async listSteps(filter: { goal?: string | undefined; state?: string | undefined; holderUser?: string | undefined } = {}): Promise<Step[]> {
    const where: string[] = [];
    const args: string[] = [];
    if (filter.goal) {
      where.push("goal = ? COLLATE NOCASE");
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
    const sql = `SELECT value FROM step ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY rowid`;
    return (await this.db.all<{ value: string }>(sql, ...args)).map((r) => Step.parse(JSON.parse(r.value)));
  }

  // ---------- notes and questions ----------

  async addNote(n: Omit<Note, "id">): Promise<Note> {
    const { lastId } = await this.db.run("INSERT INTO note (step, user_id, sid, text, at) VALUES (?, ?, ?, ?, ?)", n.step, n.user, n.sid ?? null, n.text, n.at);
    return { ...n, id: lastId };
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
      const { lastId } = await this.db.run("INSERT INTO question (value, at) VALUES (?, ?)", json(q), q.at);
      const full = { ...q, id: lastId };
      await this.db.run("UPDATE question SET value = ? WHERE id = ?", json(full), lastId);
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
      const { lastId } = await this.db.run(
        "INSERT INTO message (to_machine, to_sid, from_user, kind, text, state, created_at, data) VALUES (?, ?, ?, ?, ?, 'pending', ?, ?)",
        m.toMachine,
        m.toSid,
        m.fromUser,
        m.kind,
        m.text,
        now,
        m.data ? json(m.data) : null,
      );
      return (await this.getMessage(lastId)) as MessageRow;
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

  /** Append an event; returns its seq, or undefined when an event with the same id exists (dedupe). */
  async appendEvent(e: NewEvent): Promise<number | undefined> {
    const r = await this.db.run(
      "INSERT OR IGNORE INTO event (id, at, type, user_id, sid, goal, step, payload) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      e.id ?? randomUUID(),
      e.at,
      e.type,
      e.user ?? null,
      e.sid ?? null,
      e.goal ?? null,
      e.step ?? null,
      json(e.payload ?? {}),
    );
    return r.changes > 0 ? r.lastId : undefined;
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
      : await this.db.all<EventDbRow>("SELECT * FROM event WHERE goal = ? OR step LIKE ? ORDER BY seq", filter.goal ?? "", `${filter.goal ?? ""}.%`);
    return rows.map(eventFrom);
  }

  async pruneEvents(before: number): Promise<number> {
    return (await this.db.run("DELETE FROM event WHERE at < ?", before)).changes;
  }

  /** A consistent copy of the whole database (VACUUM INTO), safe while the hub runs. */
  async backup(path: string): Promise<void> {
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
      await this.db.run("INSERT OR IGNORE INTO idem (key, user_id, response, at) VALUES (?, ?, ?, ?)", key, userId, json(response), now);
      await this.db.run("DELETE FROM idem WHERE at < ?", now - 24 * 60 * 60_000);
    });
  }
}
