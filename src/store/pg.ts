// The Postgres driver for the hub's `Db` (M4.6), for several hub replicas on one database.
// The `pg` package is imported only when a hub is opened on a postgres:// URL, so Solo and every
// SQLite hub never load it.

import { AsyncLocalStorage } from "node:async_hooks";
import type { Pool, PoolClient, PoolConfig, QueryResult } from "pg";
import type { Db, RunResult, SqlValue } from "./db.ts";
import { LOCKS, POSTGRES, toPgPlaceholders } from "./dialect.ts";

interface PgTx {
  client: PoolClient;
  after: (() => void)[];
}

/** int8 (BIGINT: ids, sequence numbers, millisecond times) and NUMERIC come back as JS numbers. */
const INT8 = 20;
const NUMERIC = 1700;

/**
 * `Db` over a `pg` pool. A transaction checks out one connection and holds it from BEGIN to
 * COMMIT; calls made from inside its callback (tracked with AsyncLocalStorage) run on that
 * connection, and every other call runs on any free one. Postgres runs transactions concurrently,
 * so writes that must not race say so in SQL (a conditional UPDATE, or `Dialect.lock`).
 */
export class PgDb implements Db {
  readonly dialect = POSTGRES;
  private readonly pool: Pool;
  private readonly scope = new AsyncLocalStorage<PgTx>();

  constructor(pool: Pool) {
    this.pool = pool;
  }

  private query(sql: string, params: SqlValue[]): Promise<QueryResult> {
    const on = this.scope.getStore()?.client ?? this.pool;
    return params.length ? on.query(toPgPlaceholders(sql), params) : on.query(toPgPlaceholders(sql));
  }

  async exec(sql: string): Promise<void> {
    // No parameters: the simple protocol, which allows several statements.
    await (this.scope.getStore()?.client ?? this.pool).query(sql);
  }

  /** `lastId` is the first column of the first returned row (`… RETURNING id`), else 0. */
  async run(sql: string, ...params: SqlValue[]): Promise<RunResult> {
    const r = await this.query(sql, params);
    const first = r.rows[0] as Record<string, unknown> | undefined;
    const id = first ? Object.values(first)[0] : undefined;
    return { changes: r.rowCount ?? 0, lastId: typeof id === "number" ? id : 0 };
  }

  async get<T>(sql: string, ...params: SqlValue[]): Promise<T | undefined> {
    return (await this.query(sql, params)).rows[0] as T | undefined;
  }

  async all<T>(sql: string, ...params: SqlValue[]): Promise<T[]> {
    return (await this.query(sql, params)).rows as T[];
  }

  async transaction<T>(fn: () => Promise<T>): Promise<T> {
    if (this.scope.getStore()) return fn();
    const client = await this.pool.connect();
    const tx: PgTx = { client, after: [] };
    let broken: Error | undefined;
    try {
      await client.query(POSTGRES.begin);
      let out: T;
      try {
        out = await this.scope.run(tx, fn);
        await client.query("COMMIT");
      } catch (e) {
        await client.query("ROLLBACK").catch((err: Error) => (broken = err));
        throw e;
      }
      for (const f of tx.after) queueMicrotask(f);
      return out;
    } finally {
      // A connection that could not roll back is closed rather than handed to the next caller.
      client.release(broken);
    }
  }

  afterCommit(fn: () => void): void {
    const tx = this.scope.getStore();
    if (tx) tx.after.push(fn);
    else queueMicrotask(fn);
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}

/**
 * Connect to Postgres and apply pending migrations, like `openSyncDb` does for SQLite. Replicas
 * starting together take `pg_advisory_lock(migrate)`: the first one migrates, the others wait and
 * then find nothing to do.
 */
export async function openPgDb(url: string, migrations: readonly string[], opts: { max?: number } = {}): Promise<PgDb> {
  const pg = (await import("pg")).default;
  const config: PoolConfig = {
    connectionString: url,
    max: opts.max ?? 10,
    types: {
      getTypeParser: ((oid: number, format?: "text" | "binary") =>
        oid === INT8 || oid === NUMERIC ? (v: string) => Number(v) : pg.types.getTypeParser(oid, format as "text")) as never,
    },
  };
  const pool = new pg.Pool(config);
  // An idle connection dropped by the server: the pool replaces it on next use. Without a listener
  // the error would take the process down.
  pool.on("error", (e) => process.emitWarning(`mesh hub: postgres connection lost: ${e.message}`));
  try {
    await migrate(pool, migrations);
  } catch (e) {
    await pool.end().catch(() => undefined);
    throw e;
  }
  return new PgDb(pool);
}

async function migrate(pool: Pool, migrations: readonly string[]): Promise<void> {
  const c = await pool.connect();
  let broken: Error | undefined;
  try {
    await c.query("SELECT pg_advisory_lock($1)", [LOCKS.migrate]);
    try {
      await c.query("CREATE TABLE IF NOT EXISTS schema_version (version INTEGER NOT NULL)");
      const row = (await c.query<{ version: number }>("SELECT version FROM schema_version")).rows[0];
      let version = row?.version ?? 0;
      if (!row) await c.query("INSERT INTO schema_version (version) VALUES (0)");
      if (version > migrations.length) throw new Error(`database has schema version ${version}, newer than this mesh (${migrations.length})`);
      while (version < migrations.length) {
        await c.query("BEGIN");
        try {
          await c.query(migrations[version] as string);
          await c.query("UPDATE schema_version SET version = $1", [version + 1]);
          await c.query("COMMIT");
        } catch (e) {
          await c.query("ROLLBACK");
          throw e;
        }
        version++;
      }
    } finally {
      // If the unlock fails, closing the connection releases the session-level lock instead.
      await c.query("SELECT pg_advisory_unlock($1)", [LOCKS.migrate]).catch((err: Error) => (broken = err));
    }
  } finally {
    c.release(broken);
  }
}
