// The SQL differences between the hub's two drivers, kept in this one place (M4.6).
// Store queries are written in the SQL both accept (`INSERT … ON CONFLICT`, `RETURNING`, `?`
// placeholders, `IS NOT DISTINCT FROM`); what is left over is below. The schema itself differs
// only in its migrations, one plain-SQL list per dialect (`AUTOINCREMENT` there becomes
// `GENERATED ALWAYS AS IDENTITY`, millisecond times become `BIGINT`).

export type DialectName = "sqlite" | "postgres";

export interface Dialect {
  readonly name: DialectName;
  /** Opens a write transaction. SQLite takes the write lock up front; Postgres row-locks as it goes. */
  readonly begin: string;
  /** `col = ?`, ignoring ASCII case (step and goal ids are typed by people). */
  eqNoCase(col: string): string;
  /** Case-insensitive LIKE. */
  readonly like: string;
  /** The `step` column that orders rows by first insert. */
  readonly stepOrder: string;
  /**
   * A statement that serialises the rest of the transaction against every other transaction taking
   * the same lock (Postgres: a transaction-scoped advisory lock), or undefined where every write
   * transaction is serialised anyway (SQLite: `BEGIN IMMEDIATE`).
   */
  lock(key: LockKey): string | undefined;
  /**
   * Suffix for a SELECT whose rows the transaction will rewrite from what it read: Postgres
   * row-locks them until commit (`FOR UPDATE`); empty on SQLite, where `BEGIN IMMEDIATE` already
   * holds the write lock.
   */
  readonly forUpdate: string;
  /** The text of top-level `key` in the JSON stored in text column `col` (null when absent). */
  jsonText(col: string, key: string): string;
}

/** Advisory-lock keys (Postgres). One number per purpose; "mesh" in the high bytes. */
export const LOCKS = {
  migrate: 0x6d657368_0001,
  goals: 0x6d657368_0002,
  users: 0x6d657368_0003,
  /** Held by every transaction that appends events, from the append to its commit (gap-free seq). */
  events: 0x6d657368_0004,
  /** Session lock held by the one replica that runs the periodic `tick` (see `Leader`). */
  tick: 0x6d657368_0005,
} as const;
export type LockKey = keyof typeof LOCKS;

export const SQLITE: Dialect = {
  name: "sqlite",
  begin: "BEGIN IMMEDIATE",
  eqNoCase: (col) => `${col} = ? COLLATE NOCASE`,
  like: "LIKE",
  stepOrder: "rowid",
  lock: () => undefined,
  forUpdate: "",
  jsonText: (col, key) => `json_extract(${col}, '$.${key}')`,
};

export const POSTGRES: Dialect = {
  name: "postgres",
  begin: "BEGIN",
  eqNoCase: (col) => `lower(${col}) = lower(?)`,
  like: "ILIKE",
  stepOrder: "ord",
  lock: (key) => `SELECT pg_advisory_xact_lock(${LOCKS[key]})`,
  forUpdate: " FOR UPDATE",
  jsonText: (col, key) => `(${col}::jsonb ->> '${key}')`,
};

/** True when `db:` names a Postgres server rather than a SQLite file. */
export function isPostgresUrl(target: string): boolean {
  return /^postgres(ql)?:\/\//i.test(target);
}

/** `db:` fit for a log line: a Postgres URL loses its password. */
export function describeDbTarget(target: string): string {
  if (!isPostgresUrl(target)) return target;
  try {
    const u = new URL(target);
    if (u.password) u.password = "***";
    return u.toString();
  } catch {
    return "postgres://(unparseable url)";
  }
}

/**
 * Rewrite `?` placeholders as `$1, $2, …` for Postgres. Skips quoted strings, quoted identifiers
 * and comments, so a literal question mark stays as it is.
 */
export function toPgPlaceholders(sql: string): string {
  let out = "";
  let n = 0;
  for (let i = 0; i < sql.length; i++) {
    const c = sql[i] as string;
    if (c === "'" || c === '"') {
      const end = closing(sql, i, c);
      out += sql.slice(i, end);
      i = end - 1;
    } else if (c === "-" && sql[i + 1] === "-") {
      const nl = sql.indexOf("\n", i);
      const end = nl < 0 ? sql.length : nl;
      out += sql.slice(i, end);
      i = end - 1;
    } else if (c === "?") {
      out += `$${++n}`;
    } else {
      out += c;
    }
  }
  return out;
}

/** Index just past the quote closing the one at `start` (a doubled quote is an escaped one). */
function closing(sql: string, start: number, q: string): number {
  for (let i = start + 1; i < sql.length; i++) {
    if (sql[i] !== q) continue;
    if (sql[i + 1] === q) i++;
    else return i + 1;
  }
  return sql.length;
}
