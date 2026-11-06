// The Postgres driver for the hub's `Db` (M4.6), for several hub replicas on one database.
// The `pg` package is imported only when a hub is opened on a postgres:// URL, so Solo and every
// SQLite hub never load it.

import { AsyncLocalStorage } from "node:async_hooks";
import type { Client, ClientConfig, Pool, PoolClient, PoolConfig, QueryResult } from "pg";
import type { Channel, Db, Leader, RunResult, SqlValue } from "./db.ts";
import { LOCKS, POSTGRES, toPgPlaceholders, type LockKey } from "./dialect.ts";

interface PgTx {
  client: PoolClient;
  after: (() => void)[];
}

/** int8 (BIGINT: ids, sequence numbers, millisecond times) and NUMERIC come back as JS numbers. */
const INT8 = 20;
const NUMERIC = 1700;

/** A dedicated connection outside the pool (LISTEN, session-level advisory locks). */
export type ClientFactory = (applicationName: string) => Client;

/** deadlock_detected and serialization_failure: Postgres aborted the transaction; running it again is safe. */
const RETRYABLE = new Set(["40P01", "40001"]);
const TX_ATTEMPTS = 3;
const sleep = (ms: number) => new Promise<void>((ok) => setTimeout(ok, ms));

/**
 * `Db` over a `pg` pool. A transaction checks out one connection and holds it from BEGIN to
 * COMMIT; calls made from inside its callback (tracked with AsyncLocalStorage) run on that
 * connection, and every other call runs on any free one. Postgres runs transactions concurrently,
 * so writes that must not race say so in SQL (a conditional UPDATE, or `Dialect.lock`).
 *
 * A transaction that Postgres aborts as a deadlock victim (two transactions taking row and
 * advisory locks in opposite orders) or a serialization failure is run again, up to three times,
 * so a transaction callback must be safe to repeat: database work and pure computation only, with
 * side effects deferred to `afterCommit`.
 */
export class PgDb implements Db {
  readonly dialect = POSTGRES;
  private readonly pool: Pool;
  private readonly newClient: ClientFactory | undefined;
  private readonly scope = new AsyncLocalStorage<PgTx>();
  /** Dedicated connections handed out (channels, leaders), ended by `close`. */
  private readonly dedicated = new Set<() => Promise<void>>();

  constructor(pool: Pool, newClient?: ClientFactory) {
    this.pool = pool;
    this.newClient = newClient;
  }

  private client(applicationName: string): Client {
    if (!this.newClient) throw new Error("this PgDb was opened without dedicated connections");
    return this.newClient(applicationName);
  }

  channel(name: string): Channel {
    const c = new PgChannel(this.pool, () => this.client(`mesh-hub listen ${name}`), name);
    this.dedicated.add(() => c.close());
    return c;
  }

  leader(key: LockKey): Leader {
    const l = new PgLeader(() => this.client(`mesh-hub leader ${key}`), LOCKS[key]);
    this.dedicated.add(() => l.release());
    return l;
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
    for (let attempt = 1; ; attempt++) {
      try {
        return await this.once(fn);
      } catch (e) {
        if (attempt >= TX_ATTEMPTS || !RETRYABLE.has((e as { code?: unknown }).code as string)) throw e;
        await sleep(attempt * (5 + Math.random() * 20));
      }
    }
  }

  private async once<T>(fn: () => Promise<T>): Promise<T> {
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
    await Promise.all([...this.dedicated].map((end) => end()));
    this.dedicated.clear();
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
  const types: ClientConfig["types"] = {
    getTypeParser: ((oid: number, format?: "text" | "binary") =>
      oid === INT8 || oid === NUMERIC ? (v: string) => Number(v) : pg.types.getTypeParser(oid, format as "text")) as never,
  };
  const config: PoolConfig = { connectionString: url, max: opts.max ?? 10, types };
  const pool = new pg.Pool(config);
  // Long-lived connections: TCP keepalive notices a dead peer, and a query that hangs is cut off,
  // so a leader whose database went away stops believing it leads.
  const newClient: ClientFactory = (applicationName) =>
    new pg.Client({ connectionString: url, types, application_name: applicationName, keepAlive: true, connectionTimeoutMillis: 10_000, query_timeout: 10_000 });
  // An idle connection dropped by the server: the pool replaces it on next use. Without a listener
  // the error would take the process down.
  pool.on("error", (e) => process.emitWarning(`mesh hub: postgres connection lost: ${e.message}`));
  try {
    await migrate(pool, migrations);
  } catch (e) {
    await pool.end().catch(() => undefined);
    throw e;
  }
  return new PgDb(pool, newClient);
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

/**
 * LISTEN/NOTIFY on one channel. `publish` uses the pool (one NOTIFY, autocommit); listening holds
 * a dedicated connection, reopened with backoff when it drops.
 */
class PgChannel implements Channel {
  private readonly pool: Pool;
  private readonly newClient: () => Client;
  private readonly name: string;
  private handlers: { message(payload: string): void; resync?(): void } | undefined;
  private client: Client | undefined;
  private timer: NodeJS.Timeout | undefined;
  private closed = false;

  constructor(pool: Pool, newClient: () => Client, name: string) {
    if (!/^[a-z_][a-z0-9_]{0,62}$/.test(name)) throw new Error(`bad channel name "${name}"`);
    this.pool = pool;
    this.newClient = newClient;
    this.name = name;
  }

  async publish(payload: string): Promise<void> {
    await this.pool.query("SELECT pg_notify($1, $2)", [this.name, payload]);
  }

  async listen(handlers: { message(payload: string): void; resync?(): void }): Promise<void> {
    if (this.handlers) throw new Error(`already listening on ${this.name}`);
    this.handlers = handlers;
    await this.connect();
  }

  private async connect(): Promise<void> {
    const c = this.newClient();
    c.on("notification", (m) => {
      if (m.channel !== this.name || m.payload === undefined) return;
      try {
        this.handlers?.message(m.payload);
      } catch {
        // a broken handler must not take the listener down
      }
    });
    c.on("error", () => this.lost(c));
    c.on("end", () => this.lost(c));
    try {
      await c.connect();
      await c.query(`LISTEN ${this.name}`);
    } catch (e) {
      await c.end().catch(() => undefined);
      throw e;
    }
    if (this.closed) {
      await c.end().catch(() => undefined);
      return;
    }
    this.client = c;
  }

  private lost(c: Client): void {
    if (this.client !== c) return;
    this.client = undefined;
    void c.end().catch(() => undefined);
    if (!this.closed) this.reconnect(1_000);
  }

  private reconnect(delayMs: number): void {
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.connect().then(
        () => {
          if (!this.closed) this.handlers?.resync?.();
        },
        (e: unknown) => {
          process.emitWarning(`mesh hub: cannot LISTEN on ${this.name}: ${e instanceof Error ? e.message : String(e)}`);
          if (!this.closed) this.reconnect(Math.min(delayMs * 2, 30_000));
        },
      );
    }, delayMs);
  }

  async close(): Promise<void> {
    this.closed = true;
    if (this.timer) clearTimeout(this.timer);
    const c = this.client;
    this.client = undefined;
    await c?.end().catch(() => undefined);
  }
}

/**
 * Leadership by a session-level `pg_try_advisory_lock` on a dedicated connection. The lock lasts
 * as long as that connection, so when the leader dies (or its connection does) the server drops
 * the lock and the next `acquire` elsewhere takes it.
 */
class PgLeader implements Leader {
  private readonly newClient: () => Client;
  private readonly key: number;
  private client: Client | undefined;
  private held = false;

  constructor(newClient: () => Client, key: number) {
    this.newClient = newClient;
    this.key = key;
  }

  async acquire(): Promise<boolean> {
    try {
      if (this.client && this.held) {
        // Still leading only while the connection holding the lock is alive.
        await this.client.query("SELECT 1");
        return true;
      }
      this.client ??= await this.open();
      const r = await this.client.query<{ ok: boolean }>("SELECT pg_try_advisory_lock($1) AS ok", [this.key]);
      this.held = r.rows[0]?.ok === true;
      return this.held;
    } catch {
      this.drop(this.client);
      return false;
    }
  }

  private async open(): Promise<Client> {
    const c = this.newClient();
    c.on("error", () => this.drop(c));
    c.on("end", () => this.drop(c));
    try {
      await c.connect();
    } catch (e) {
      await c.end().catch(() => undefined);
      throw e;
    }
    return c;
  }

  private drop(c: Client | undefined): void {
    if (!c || c !== this.client) return;
    this.client = undefined;
    this.held = false;
    void c.end().catch(() => undefined);
  }

  async release(): Promise<void> {
    const c = this.client;
    this.client = undefined;
    this.held = false;
    // Ending the session releases the lock; unlocking first just makes it immediate.
    await c?.query("SELECT pg_advisory_unlock($1)", [this.key]).catch(() => undefined);
    await c?.end().catch(() => undefined);
  }
}
