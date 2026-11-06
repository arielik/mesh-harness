// Database access (plan ADR 2). Two layers:
// - `SyncDb`: a thin synchronous wrapper over Node's built-in SQLite, used by the per-machine
//   daemon store, which never needs another database.
// - `Db`: the async interface the hub store is written against, so the hub can run on SQLite (the
//   default, `SqliteDb` below) or, from M4.6, on Postgres.
// node:sqlite is loaded lazily so the CLI can filter its ExperimentalWarning before the module is
// evaluated.

import { AsyncLocalStorage } from "node:async_hooks";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

export type SqlValue = string | number | bigint | null | Uint8Array;

export interface RunResult {
  changes: number;
  lastId: number;
}

/**
 * The hub's database. Every call is async; `transaction` runs its callback atomically, and calls
 * made from inside the callback (however deeply awaited) join that transaction. Calls from outside
 * it never observe or join its uncommitted work.
 */
export interface Db {
  exec(sql: string): Promise<void>;
  run(sql: string, ...params: SqlValue[]): Promise<RunResult>;
  get<T>(sql: string, ...params: SqlValue[]): Promise<T | undefined>;
  all<T>(sql: string, ...params: SqlValue[]): Promise<T[]>;
  /** Run `fn` in a transaction (nested calls join the outer one). Rolls back when `fn` throws. */
  transaction<T>(fn: () => Promise<T>): Promise<T>;
  /** Run `fn` once the current transaction commits (dropped on rollback); outside one, soon. */
  afterCommit(fn: () => void): void;
  close(): Promise<void>;
}

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

export class SyncDb {
  private db: DatabaseSync;
  private depth = 0;

  constructor(db: DatabaseSync) {
    this.db = db;
  }

  exec(sql: string): void {
    this.db.exec(sql);
  }

  run(sql: string, ...params: SqlValue[]): RunResult {
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

interface Tx {
  after: (() => void)[];
}

/**
 * `Db` over one SQLite connection. A connection has one transaction at a time, and with async
 * callbacks two requests could otherwise interleave inside it. So every call takes a turn on a
 * queue: a transaction holds the turn from BEGIN to COMMIT, and only calls made from inside its
 * callback (tracked with AsyncLocalStorage) run while it is open.
 */
export class SqliteDb implements Db {
  readonly sync: SyncDb;
  private readonly scope = new AsyncLocalStorage<Tx>();
  private current: Tx | undefined;
  private tail: Promise<void> = Promise.resolve();

  constructor(sync: SyncDb) {
    this.sync = sync;
  }

  private inTx(): boolean {
    const tx = this.scope.getStore();
    return tx !== undefined && tx === this.current;
  }

  /** Run `fn` on its turn: after every call queued before it has finished. */
  private turn<T>(fn: () => T | Promise<T>): Promise<T> {
    const prev = this.tail;
    let done!: () => void;
    this.tail = new Promise<void>((ok) => (done = ok));
    return prev.then(fn).finally(done);
  }

  private call<T>(fn: () => T): Promise<T> {
    return this.inTx() ? Promise.resolve().then(fn) : this.turn(fn);
  }

  exec(sql: string): Promise<void> {
    return this.call(() => this.sync.exec(sql));
  }

  run(sql: string, ...params: SqlValue[]): Promise<RunResult> {
    return this.call(() => this.sync.run(sql, ...params));
  }

  get<T>(sql: string, ...params: SqlValue[]): Promise<T | undefined> {
    return this.call(() => this.sync.get<T>(sql, ...params));
  }

  all<T>(sql: string, ...params: SqlValue[]): Promise<T[]> {
    return this.call(() => this.sync.all<T>(sql, ...params));
  }

  async transaction<T>(fn: () => Promise<T>): Promise<T> {
    if (this.inTx()) return fn();
    const tx: Tx = { after: [] };
    const out = await this.turn(async () => {
      this.current = tx;
      this.sync.exec("BEGIN IMMEDIATE");
      try {
        const r = await this.scope.run(tx, fn);
        this.sync.exec("COMMIT");
        return r;
      } catch (e) {
        this.sync.exec("ROLLBACK");
        tx.after.length = 0;
        throw e;
      } finally {
        this.current = undefined;
      }
    });
    for (const f of tx.after) queueMicrotask(f);
    return out;
  }

  afterCommit(fn: () => void): void {
    const tx = this.inTx() ? this.scope.getStore() : undefined;
    if (tx) tx.after.push(fn);
    else queueMicrotask(fn);
  }

  async close(): Promise<void> {
    await this.turn(() => this.sync.close());
  }
}

/**
 * Open (creating if needed) a SQLite database and apply pending migrations in order.
 * `migrations[i]` brings the schema from version i to i+1. Use ":memory:" for tests.
 */
export async function openSyncDb(path: string, migrations: readonly string[]): Promise<SyncDb> {
  const { DatabaseSync } = (await import("node:sqlite")) as unknown as { DatabaseSync: new (path: string) => DatabaseSync };
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const db = new SyncDb(new DatabaseSync(path));
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

/** The async `Db` over SQLite, migrated (see `openSyncDb`). */
export async function openDb(path: string, migrations: readonly string[]): Promise<Db> {
  return new SqliteDb(await openSyncDb(path, migrations));
}
