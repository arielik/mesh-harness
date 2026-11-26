// Local daemon persistence: sessions, hook events (never prompt text) and the message queue.
// It stays on the synchronous SQLite wrapper: the store is per machine (never shared between hub
// replicas, never on Postgres) and the hook hot path reads and writes it inline.

import { AgentRun, Message, Session, type HookEvent, type StepContext } from "../protocol/index.ts";
import { openSyncDb, type SyncDb } from "./db.ts";

export const DAEMON_MIGRATIONS: readonly string[] = [
  `CREATE TABLE session (
     sid TEXT PRIMARY KEY,
     value TEXT NOT NULL,
     updated_at INTEGER NOT NULL
   );
   CREATE TABLE hook_event (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     at INTEGER NOT NULL,
     sid TEXT NOT NULL,
     kind TEXT NOT NULL,
     claude_session_id TEXT NOT NULL,
     value TEXT NOT NULL
   );
   CREATE INDEX hook_event_at ON hook_event (at);
   CREATE TABLE message (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     sid TEXT NOT NULL,
     text TEXT NOT NULL,
     state TEXT NOT NULL,
     method TEXT,
     error TEXT,
     created_at INTEGER NOT NULL,
     delivered_at INTEGER
   );
   CREATE INDEX message_pending ON message (state, sid);`,
  `ALTER TABLE message ADD COLUMN hub_id INTEGER;
   CREATE UNIQUE INDEX message_hub ON message (hub_id) WHERE hub_id IS NOT NULL;
   CREATE TABLE outbox (id TEXT PRIMARY KEY, at INTEGER NOT NULL, value TEXT NOT NULL);`,
  // M4 local-first: every event the daemon produced (facts for offline records), the last known
  // context of held steps, hub calls queued while offline, and captured subagent runs.
  `CREATE TABLE event_log (id TEXT PRIMARY KEY, at INTEGER NOT NULL, step TEXT, value TEXT NOT NULL);
   CREATE INDEX event_log_step ON event_log (step);
   CREATE INDEX event_log_at ON event_log (at);
   CREATE TABLE step_cache (step TEXT PRIMARY KEY, value TEXT NOT NULL, at INTEGER NOT NULL);
   CREATE TABLE pending_call (key TEXT PRIMARY KEY, at INTEGER NOT NULL, method TEXT NOT NULL, path TEXT NOT NULL, body TEXT NOT NULL, label TEXT NOT NULL, cwd TEXT);
   CREATE TABLE agent_run (agent_id TEXT PRIMARY KEY, record_key TEXT, cwd TEXT NOT NULL, value TEXT NOT NULL, at INTEGER NOT NULL);
   CREATE INDEX agent_run_key ON agent_run (record_key);
   CREATE TABLE kv (k TEXT PRIMARY KEY, v TEXT NOT NULL);`,
  // Hub message ids are per hub: a seen id is namespaced by the hub it came from (its URL). Rows
  // from before keep a NULL hub; `hubMessageSeen` attributes one to the hub that lists the same
  // message again (same id, session and text) and never lets it hide another hub's message.
  `ALTER TABLE message ADD COLUMN hub TEXT;
   DROP INDEX message_hub;
   CREATE UNIQUE INDEX message_hub ON message (hub, hub_id) WHERE hub_id IS NOT NULL;`,
];

/** Where a hub inbox message came from: the hub (its URL) and its id there. */
export interface HubMessageRef {
  hub: string;
  id: number;
}

/**
 * What the store knows of a hub inbox message: `seen` (already queued: skip it), `new`, or
 * `replaced` (this hub once sent another message with this id, e.g. the hub was reset: the old
 * row lets go of the id and the message is new).
 */
export type HubMessageSeen = "seen" | "new" | "replaced";

export interface PendingCall {
  key: string;
  at: number;
  method: "POST";
  path: string;
  body: Record<string, unknown>;
  /** What it was, for messages to the person (e.g. "mesh_done G3.api"). */
  label: string;
  /** Where the session worked: the hub's fuller record is written there once the call goes through. */
  cwd?: string | undefined;
}

interface MessageRow {
  id: number;
  sid: string;
  text: string;
  state: string;
  method: string | null;
  error: string | null;
  created_at: number;
  delivered_at: number | null;
  hub_id: number | null;
  hub: string | null;
}

function toMessage(r: MessageRow): Message {
  return Message.parse({
    id: r.id,
    sid: r.sid,
    text: r.text,
    state: r.state,
    createdAt: r.created_at,
    ...(r.method !== null ? { method: r.method } : {}),
    ...(r.error !== null ? { error: r.error } : {}),
    ...(r.delivered_at !== null ? { deliveredAt: r.delivered_at } : {}),
    ...(r.hub_id !== null ? { hubId: r.hub_id } : {}),
    ...(r.hub_id !== null && r.hub !== null ? { hub: r.hub } : {}),
  });
}

export class DaemonStore {
  readonly db: SyncDb;

  constructor(db: SyncDb) {
    this.db = db;
  }

  static async open(path: string): Promise<DaemonStore> {
    return new DaemonStore(await openSyncDb(path, DAEMON_MIGRATIONS));
  }

  loadSessions(): Session[] {
    return this.db
      .all<{ value: string }>("SELECT value FROM session ORDER BY rowid")
      .map((r) => Session.safeParse(JSON.parse(r.value)))
      .flatMap((p) => (p.success ? [p.data] : []));
  }

  saveSessions(sessions: readonly Session[], now: number): void {
    if (sessions.length === 0) return;
    this.db.transaction(() => {
      for (const s of sessions) {
        this.db.run(
          "INSERT INTO session (sid, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(sid) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at",
          s.sid,
          JSON.stringify(s),
          now,
        );
      }
    });
  }

  /** Delete ended sessions not updated since `before`. */
  pruneSessions(before: number): number {
    return this.db.run(
      "DELETE FROM session WHERE updated_at < ? AND json_extract(value, '$.state') = 'ended'",
      before,
    ).changes;
  }

  appendHookEvent(sid: string, ev: HookEvent): void {
    this.db.run(
      "INSERT INTO hook_event (at, sid, kind, claude_session_id, value) VALUES (?, ?, ?, ?, ?)",
      ev.at,
      sid,
      ev.kind,
      ev.claudeSessionId,
      JSON.stringify(ev),
    );
  }

  pruneHookEvents(before: number): number {
    return this.db.run("DELETE FROM hook_event WHERE at < ?", before).changes;
  }

  hookEvents(sid: string): HookEvent[] {
    return this.db
      .all<{ value: string }>("SELECT value FROM hook_event WHERE sid = ? ORDER BY id", sid)
      .map((r) => JSON.parse(r.value) as HookEvent);
  }

  queueMessage(sid: string, text: string, now: number, from?: HubMessageRef): Message {
    const { lastId } = this.db.run(
      "INSERT INTO message (sid, text, state, created_at, hub_id, hub) VALUES (?, ?, 'pending', ?, ?, ?)",
      sid,
      text,
      now,
      from?.id ?? null,
      from?.hub ?? null,
    );
    return this.message(lastId) as Message;
  }

  /**
   * Whether hub message `m` (id, session, text) from `hub` was already queued. Ids are per hub, so
   * only the same hub's same message counts. A row from before ids were namespaced (no hub) counts
   * only when it is the same message (same id, session and text); it is then attributed to `hub`.
   */
  hubMessageSeen(hub: string, m: { id: number; toSid: string; text: string }): HubMessageSeen {
    return this.db.transaction(() => {
      const own = this.db.get<{ id: number; sid: string; text: string }>("SELECT id, sid, text FROM message WHERE hub = ? AND hub_id = ?", hub, m.id);
      if (own) {
        if (own.sid === m.toSid && own.text === m.text) return "seen";
        this.db.run("UPDATE message SET hub_id = NULL, hub = NULL WHERE id = ?", own.id);
        return "replaced";
      }
      const legacy = this.db.get<{ id: number }>("SELECT id FROM message WHERE hub IS NULL AND hub_id = ? AND sid = ? AND text = ? ORDER BY id LIMIT 1", m.id, m.toSid, m.text);
      if (!legacy) return "new";
      this.db.run("UPDATE message SET hub = ? WHERE id = ?", hub, legacy.id);
      return "seen";
    });
  }

  // ---------- outbox (observations spooled for the hub, plan §5.3) ----------

  outboxAdd(id: string, at: number, value: unknown): void {
    this.db.run("INSERT OR IGNORE INTO outbox (id, at, value) VALUES (?, ?, ?)", id, at, JSON.stringify(value));
  }

  outboxPeek(limit: number): { id: string; value: unknown }[] {
    return this.db.all<{ id: string; value: string }>("SELECT id, value FROM outbox ORDER BY at, rowid LIMIT ?", limit).map((r) => ({ id: r.id, value: JSON.parse(r.value) }));
  }

  outboxRemove(ids: readonly string[]): void {
    this.db.transaction(() => {
      for (const id of ids) this.db.run("DELETE FROM outbox WHERE id = ?", id);
    });
  }

  outboxSize(): number {
    return this.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM outbox")?.n ?? 0;
  }

  // ---------- local-first (M4) ----------

  /** Keep a copy of every event the daemon produces; offline step records are computed from it. */
  eventLogAdd(e: { id: string; at: number; step?: string | undefined; value: unknown }): void {
    this.db.run("INSERT OR IGNORE INTO event_log (id, at, step, value) VALUES (?, ?, ?, ?)", e.id, e.at, e.step ?? null, JSON.stringify(e.value));
  }

  eventLogFor(step: string): unknown[] {
    return this.db.all<{ value: string }>("SELECT value FROM event_log WHERE step = ? ORDER BY at, rowid", step).map((r) => JSON.parse(r.value));
  }

  pruneEventLog(before: number): number {
    return this.db.run("DELETE FROM event_log WHERE at < ?", before).changes;
  }

  cacheStep(ctx: StepContext, now: number): void {
    this.db.run("INSERT INTO step_cache (step, value, at) VALUES (?, ?, ?) ON CONFLICT(step) DO UPDATE SET value = excluded.value, at = excluded.at", ctx.step.id, JSON.stringify(ctx), now);
  }

  cachedStep(step: string): { ctx: StepContext; at: number } | undefined {
    const r = this.db.get<{ value: string; at: number }>("SELECT value, at FROM step_cache WHERE step = ?", step);
    if (!r) return undefined;
    const ctx = JSON.parse(r.value) as StepContext;
    return typeof ctx?.step?.id === "string" ? { ctx, at: r.at } : undefined;
  }

  pruneStepCache(before: number): number {
    return this.db.run("DELETE FROM step_cache WHERE at < ?", before).changes;
  }

  queueCall(c: PendingCall): void {
    this.db.run("INSERT OR IGNORE INTO pending_call (key, at, method, path, body, label, cwd) VALUES (?, ?, ?, ?, ?, ?, ?)", c.key, c.at, c.method, c.path, JSON.stringify(c.body), c.label, c.cwd ?? null);
  }

  pendingCalls(): PendingCall[] {
    return this.db
      .all<{ key: string; at: number; method: string; path: string; body: string; label: string; cwd: string | null }>("SELECT * FROM pending_call ORDER BY at, rowid")
      .map((r) => ({ key: r.key, at: r.at, method: "POST" as const, path: r.path, body: JSON.parse(r.body), label: r.label, ...(r.cwd ? { cwd: r.cwd } : {}) }));
  }

  pendingCallCount(): number {
    return this.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM pending_call")?.n ?? 0;
  }

  removeCall(key: string): void {
    this.db.run("DELETE FROM pending_call WHERE key = ?", key);
  }

  saveAgentRun(r: AgentRun, recordKey: string | undefined, now: number): void {
    this.db.run(
      "INSERT INTO agent_run (agent_id, record_key, cwd, value, at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(agent_id) DO UPDATE SET record_key = excluded.record_key, cwd = excluded.cwd, value = excluded.value, at = excluded.at",
      r.agentId,
      recordKey ?? null,
      r.cwd,
      JSON.stringify(r),
      now,
    );
  }

  agentRun(agentId: string): AgentRun | undefined {
    const r = this.db.get<{ value: string }>("SELECT value FROM agent_run WHERE agent_id = ?", agentId);
    if (!r) return undefined;
    const p = AgentRun.safeParse(JSON.parse(r.value));
    return p.success ? p.data : undefined;
  }

  agentRunsFor(recordKey: string): AgentRun[] {
    return this.db
      .all<{ value: string }>("SELECT value FROM agent_run WHERE record_key = ? ORDER BY at, rowid", recordKey)
      .flatMap((r) => {
        const p = AgentRun.safeParse(JSON.parse(r.value));
        return p.success ? [p.data] : [];
      });
  }

  pruneAgentRuns(before: number): number {
    return this.db.run("DELETE FROM agent_run WHERE at < ?", before).changes;
  }

  getKv(k: string): string | undefined {
    return this.db.get<{ v: string }>("SELECT v FROM kv WHERE k = ?", k)?.v;
  }

  deleteKv(k: string): void {
    this.db.run("DELETE FROM kv WHERE k = ?", k);
  }

  /** RL-26: the keys that start with `prefix`. */
  kvKeys(prefix: string): string[] {
    return this.db.all<{ k: string }>("SELECT k FROM kv WHERE k >= ? AND k < ? ORDER BY k", prefix, `${prefix}\uffff`).map((r) => r.k);
  }

  setKv(k: string, v: string): void {
    this.db.run("INSERT INTO kv (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v", k, v);
  }

  /**
   * MM-2: the labels remembered for a checkout key (`mesh run --label`, `mesh label`); undefined
   * when none was ever remembered, `[]` when an empty list was.
   */
  checkoutLabels(key: string): string[] | undefined {
    const v = this.getKv(`checkout-labels:${key}`);
    return v === undefined ? undefined : (JSON.parse(v) as string[]);
  }

  /** MM-2: remember (replace) the labels of a checkout key. */
  setCheckoutLabels(key: string, labels: readonly string[]): void {
    this.setKv(`checkout-labels:${key}`, JSON.stringify([...labels]));
  }

  message(id: number): Message | undefined {
    const r = this.db.get<MessageRow>("SELECT * FROM message WHERE id = ?", id);
    return r ? toMessage(r) : undefined;
  }

  pendingMessages(sid?: string): Message[] {
    const rows = sid
      ? this.db.all<MessageRow>("SELECT * FROM message WHERE state = 'pending' AND sid = ? ORDER BY id", sid)
      : this.db.all<MessageRow>("SELECT * FROM message WHERE state = 'pending' ORDER BY id");
    return rows.map(toMessage);
  }

  recentMessages(since: number): Message[] {
    return this.db
      .all<MessageRow>("SELECT * FROM message WHERE created_at >= ? OR state = 'pending' ORDER BY id", since)
      .map(toMessage);
  }

  markDelivered(id: number, method: string, now: number): void {
    this.db.run("UPDATE message SET state = 'delivered', method = ?, delivered_at = ? WHERE id = ? AND state = 'pending'", method, now, id);
  }

  markFailed(id: number, error: string): void {
    this.db.run("UPDATE message SET state = 'failed', error = ? WHERE id = ? AND state = 'pending'", error, id);
  }

  close(): void {
    this.db.close();
  }
}
