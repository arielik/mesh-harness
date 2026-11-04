// Thin wrapper over Node's built-in SQLite (plan ADR 2). Loaded lazily so the CLI can filter
// node:sqlite's ExperimentalWarning before the module is evaluated.

import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

type SqlValue = string | number | bigint | null | Uint8Array;

interface Statement {
  run(...params: SqlValue[]): { changes: number | bigint; lastInsertRowid: number | bigint };
  get(...params: SqlValue[]): unknown;
  all(...params: SqlValue[]): unknown[];
}

interface DatabaseSync {
  exec(sql: string): void;
  prepare(sql: string): Statement;
  close(): void;
}

export class Db {
  private db: DatabaseSync;
  private depth = 0;

  constructor(db: DatabaseSync) {
    this.db = db;
  }

  exec(sql: string): void {
    this.db.exec(sql);
  }

  run(sql: string, ...params: SqlValue[]): { changes: number; lastId: number } {
    const r = this.db.prepare(sql).run(...params);
    return { changes: Number(r.changes), lastId: Number(r.lastInsertRowid) };
  }

  get<T>(sql: string, ...params: SqlValue[]): T | undefined {
    return this.db.prepare(sql).get(...params) as T | undefined;
  }

  all<T>(sql: string, ...params: SqlValue[]): T[] {
    return this.db.prepare(sql).all(...params) as T[];
  }

  /** Run `fn` in a transaction (nested calls join the outer one). */
  transaction<T>(fn: () => T): T {
    if (this.depth > 0) return fn();
    this.depth++;
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const out = fn();
      this.db.exec("COMMIT");
      return out;
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    } finally {
      this.depth--;
    }
  }

  close(): void {
    this.db.close();
  }
}

/**
 * Open (creating if needed) a database and apply pending migrations in order.
 * `migrations[i]` brings the schema from version i to i+1. Use ":memory:" for tests.
 */
export async function openDb(path: string, migrations: readonly string[]): Promise<Db> {
  const { DatabaseSync } = (await import("node:sqlite")) as unknown as { DatabaseSync: new (path: string) => DatabaseSync };
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const db = new Db(new DatabaseSync(path));
  if (path !== ":memory:") db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA foreign_keys = ON");
  db.exec("PRAGMA busy_timeout = 5000");
  db.exec("CREATE TABLE IF NOT EXISTS schema_version (version INTEGER NOT NULL)");
  const row = db.get<{ version: number }>("SELECT version FROM schema_version");
  let version = row?.version ?? 0;
  if (!row) db.run("INSERT INTO schema_version (version) VALUES (0)");
  if (version > migrations.length) {
    db.close();
    throw new Error(`database ${path} has schema version ${version}, newer than this mesh (${migrations.length})`);
  }
  while (version < migrations.length) {
    const sql = migrations[version] as string;
    db.transaction(() => {
      db.exec(sql);
      db.run("UPDATE schema_version SET version = ?", version + 1);
    });
    version++;
  }
  return db;
}
