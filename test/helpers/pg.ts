// Throwaway Postgres databases for tests. Enabled by MESH_TEST_PG_URL (a server where the user may
// create databases), e.g. postgres://postgres:mesh@127.0.0.1:55432/postgres. Each call to
// `fresh()` makes a new database; `cleanup()` drops them. Advisory locks and NOTIFY channels are
// per database, so tests running in parallel do not see each other.

import { randomUUID } from "node:crypto";
import pg from "pg";

export const PG_URL = process.env.MESH_TEST_PG_URL;

export class PgFixture {
  private admin: pg.Pool | undefined;
  private names: string[] = [];

  private pool(): pg.Pool {
    if (!PG_URL) throw new Error("MESH_TEST_PG_URL is not set");
    this.admin ??= new pg.Pool({ connectionString: PG_URL, max: 2 });
    return this.admin;
  }

  /** A new, empty database; returns its URL. */
  async fresh(): Promise<string> {
    const name = `mesh_t_${randomUUID().replace(/-/g, "").slice(0, 16)}`;
    await this.pool().query(`CREATE DATABASE ${name}`);
    this.names.push(name);
    const u = new URL(PG_URL as string);
    u.pathname = `/${name}`;
    return u.toString();
  }

  /** Kill the server-side sessions of `url`'s database whose application_name starts with `prefix`. */
  async terminate(url: string, prefix: string): Promise<number> {
    const db = new URL(url).pathname.slice(1);
    const r = await this.pool().query("SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND application_name LIKE $2", [db, `${prefix}%`]);
    return r.rowCount ?? 0;
  }

  /** Kill the session holding the advisory lock `key` on `url`'s database. */
  async terminateLockHolder(url: string, key: number): Promise<number> {
    const db = new URL(url).pathname.slice(1);
    const r = await this.pool().query(
      `SELECT pg_terminate_backend(l.pid) FROM pg_locks l JOIN pg_database d ON d.oid = l.database
        WHERE l.locktype = 'advisory' AND l.granted AND d.datname = $1 AND l.classid = $2 AND l.objid = $3`,
      [db, Math.floor(key / 2 ** 32), key % 2 ** 32],
    );
    return r.rowCount ?? 0;
  }

  async cleanup(): Promise<void> {
    for (const name of this.names.splice(0)) await this.admin?.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
  }

  async end(): Promise<void> {
    await this.cleanup();
    await this.admin?.end();
    this.admin = undefined;
  }
}

/** Poll `cond` until it holds or `ms` passes. */
export async function until(cond: () => boolean | Promise<boolean>, ms = 5_000, what = "condition"): Promise<void> {
  const end = Date.now() + ms;
  while (!(await cond())) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((ok) => setTimeout(ok, 20));
  }
}
