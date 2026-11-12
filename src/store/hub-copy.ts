// `mesh hub migrate` (M4.6): a one-off, offline copy of a SQLite hub into an empty Postgres
// database, so a team that started on one file can move to several replicas. Rows are copied as
// they are (ids, event sequence numbers and times included), identity sequences are moved past the
// copied ids, and the row count of every table is checked before the copy commits.

import { existsSync } from "node:fs";
import { openSyncDb, type SqlValue } from "./db.ts";
import { isPostgresUrl, LOCKS } from "./dialect.ts";
import { HUB_MIGRATIONS, HUB_MIGRATIONS_PG } from "./hub-store.ts";
import { openPgDb } from "./pg.ts";

/** Hub tables in foreign-key order, with the identity column Postgres generates (if any). */
export const TABLES: readonly { name: string; identity?: string }[] = [
  { name: "user" },
  { name: "identity" },
  { name: "token" },
  { name: "login_attempt" },
  { name: "machine" },
  { name: "hsession" },
  { name: "goal" },
  { name: "plan" },
  // `ord` (insertion order on Postgres) is left to Postgres: rows go in in SQLite's rowid order.
  { name: "step" },
  { name: "note", identity: "id" },
  { name: "question", identity: "id" },
  { name: "message", identity: "id" },
  { name: "event", identity: "seq" },
  { name: "idem" },
  // v0.1.8: topics (missed until v0.1.20)
  { name: "topic" },
  // RL-1
  { name: "artifact" },
  { name: "profile" },
  // RL-2: `review_record.ord` is left to Postgres (rows go in in rowid order), as for `step`.
  { name: "review_record" },
  { name: "review_item" },
  { name: "item_history", identity: "seq" },
  // RL-3: `pulse.num` is copied, so new pulses continue after the largest copied number.
  { name: "pulse" },
  { name: "pulse_slot" },
  // RL-5: the roster.
  { name: "agent_def" },
  { name: "catalog_source" },
];

/** BLOB columns (RL-1 artifact content) go to Postgres bytea as Buffers. */
const bytes = (v: SqlValue): SqlValue => (v instanceof Uint8Array && !Buffer.isBuffer(v) ? Buffer.from(v) : v);

/** Rows per INSERT; well under Postgres's 65535 parameters for the widest table. */
const BATCH = 500;

const q = (ident: string) => `"${ident.replace(/"/g, '""')}"`;

export interface HubCopyReport {
  tables: { name: string; rows: number }[];
  /** True when --force replaced a hub that was already in the target database. */
  replaced: boolean;
}

/**
 * Copy the SQLite hub at `from` into the Postgres database at `to`. The target is migrated first,
 * and must hold no hub rows unless `force` (which empties it). Run it with every hub stopped: the
 * source is read under SQLite's write lock and the copy is one Postgres transaction, so a failure
 * leaves the target as it was.
 */
export async function copyHubToPostgres(from: string, to: string, opts: { force?: boolean } = {}): Promise<HubCopyReport> {
  if (from === ":memory:" || isPostgresUrl(from)) throw new Error("--from must be a SQLite hub file");
  if (!isPostgresUrl(to)) throw new Error("--to must be a postgres:// URL");
  if (!existsSync(from)) throw new Error(`${from} not found`);
  if (HUB_MIGRATIONS.length !== HUB_MIGRATIONS_PG.length) throw new Error("internal: the SQLite and Postgres schemas have different versions");

  // Opening the file brings an older hub's schema up to date, as starting the hub would.
  const src = await openSyncDb(from, HUB_MIGRATIONS);
  try {
    // One read snapshot of the whole file, and no hub writing to it meanwhile.
    src.exec("BEGIN IMMEDIATE");
    const dst = await openPgDb(to, HUB_MIGRATIONS_PG, { max: 2 });
    try {
      return await dst.transaction(async () => {
        // A hub starting meanwhile waits on its migration lock until the copy has committed.
        await dst.exec(`SELECT pg_advisory_xact_lock(${LOCKS.migrate})`);
        const used: string[] = [];
        for (const t of TABLES) if (await dst.get(`SELECT 1 AS x FROM ${q(t.name)} LIMIT 1`)) used.push(t.name);
        if (used.length > 0 && !opts.force) {
          throw new Error(`the target database already holds a hub (rows in ${used.join(", ")}); pass --force to replace it`);
        }
        if (used.length > 0) await dst.exec(`TRUNCATE ${TABLES.map((t) => q(t.name)).join(", ")} RESTART IDENTITY CASCADE`);

        const tables: HubCopyReport["tables"] = [];
        for (const t of TABLES) {
          const cols = src.all<{ name: string }>(`PRAGMA table_info(${q(t.name)})`).map((c) => c.name);
          const insert = (n: number) =>
            `INSERT INTO ${q(t.name)} (${cols.map(q).join(", ")})${t.identity ? " OVERRIDING SYSTEM VALUE" : ""} VALUES ` +
            Array.from({ length: n }, () => `(${cols.map(() => "?").join(", ")})`).join(", ");
          let last = 0;
          let rows = 0;
          for (;;) {
            const batch = src.all<Record<string, SqlValue>>(`SELECT rowid AS mesh_rowid, * FROM ${q(t.name)} WHERE rowid > ? ORDER BY rowid LIMIT ?`, last, BATCH);
            if (batch.length === 0) break;
            await dst.run(insert(batch.length), ...batch.flatMap((r) => cols.map((c) => bytes(r[c] ?? null))));
            last = Number(batch[batch.length - 1]?.mesh_rowid);
            rows += batch.length;
          }
          if (t.identity) {
            await dst.exec(`SELECT setval(pg_get_serial_sequence('${t.name}', '${t.identity}'), (SELECT COALESCE(MAX(${q(t.identity)}), 0) FROM ${q(t.name)}) + 1, false)`);
          }
          const want = src.get<{ n: number }>(`SELECT COUNT(*) AS n FROM ${q(t.name)}`)?.n ?? 0;
          const got = (await dst.get<{ n: number }>(`SELECT COUNT(*) AS n FROM ${q(t.name)}`))?.n ?? 0;
          if (rows !== want || got !== want) throw new Error(`row counts differ for ${t.name}: SQLite ${want}, copied ${rows}, Postgres ${got}; nothing was committed`);
          tables.push({ name: t.name, rows: got });
        }
        return { tables, replaced: used.length > 0 };
      });
    } finally {
      await dst.close();
    }
  } finally {
    try {
      src.exec("ROLLBACK");
    } catch {
      // never began (the lock was refused)
    }
    src.close();
  }
}
