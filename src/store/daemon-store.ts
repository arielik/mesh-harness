// Local daemon persistence: sessions, hook events (never prompt text) and the message queue.

import { AgentRun, Message, Session, type HookEvent, type StepContext } from "../protocol/index.ts";
import { openDb, type Db } from "./db.ts";

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
];

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
  });
}

export class DaemonStore {
  readonly db: Db;

  constructor(db: Db) {
    this.db = db;
  }

  static async open(path: string): Promise<DaemonStore> {
    return new DaemonStore(await openDb(path, DAEMON_MIGRATIONS));
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

  queueMessage(sid: string, text: string, now: number, hubId?: number): Message {
    const { lastId } = this.db.run(
      "INSERT INTO message (sid, text, state, created_at, hub_id) VALUES (?, ?, 'pending', ?, ?)",
      sid,
      text,
      now,
      hubId ?? null,
    );
    return this.message(lastId) as Message;
  }

  hasHubMessage(hubId: number): boolean {
    return this.db.get("SELECT 1 FROM message WHERE hub_id = ?", hubId) !== undefined;
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

  setKv(k: string, v: string): void {
    this.db.run("INSERT INTO kv (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v", k, v);
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
