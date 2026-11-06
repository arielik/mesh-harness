// Database wrappers and migrations (plan §8). Only this module touches SQLite.
export { openDb, openSyncDb, SqliteDb, SyncDb, type Db, type RunResult, type SqlValue } from "./db.ts";
export { DAEMON_MIGRATIONS, DaemonStore, type PendingCall } from "./daemon-store.ts";
export {
  HUB_MIGRATIONS,
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
