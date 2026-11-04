// Local daemon persistence: sessions, hook events (never prompt text) and the message queue.

import { Message, Session, type HookEvent } from "../protocol/index.ts";
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
];

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
