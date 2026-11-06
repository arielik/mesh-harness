// Database wrappers and migrations (plan §8). Only this module touches SQLite or Postgres.
export { openDb, openSyncDb, SOLE_LEADER, SqliteDb, SyncDb, type Channel, type Db, type Leader, type RunResult, type SqlValue } from "./db.ts";
export { describeDbTarget, isPostgresUrl, LOCKS, POSTGRES, SQLITE, toPgPlaceholders, type Dialect, type DialectName, type LockKey } from "./dialect.ts";
export { openPgDb, PgDb } from "./pg.ts";
export { DAEMON_MIGRATIONS, DaemonStore, type PendingCall } from "./daemon-store.ts";
export {
  HUB_MIGRATIONS,
  HUB_MIGRATIONS_PG,
  HubStore,
  type EventRow,
  type HubSession,
  type MachineRow,
  type MessageRow,
  type NewEvent,
  type TokenKind,
  type TokenRow,
  type UserRow,
} from "./hub-store.ts";
