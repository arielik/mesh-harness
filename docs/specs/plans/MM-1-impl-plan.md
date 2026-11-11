# MM-1 implementation plan: My mesh (read-only)

Spec: `docs/specs/MM-1.md` (revision 3). Branch: `feat/my-mesh-assign`. Release v0.1.9.

This plan covers the implementation only. It plans no new tests. The test side writes them from
the spec's contracts and owns `test/helpers/world.ts`. The section "Existing tests and generated
files the developer adjusts" lists every existing test, snapshot and generated file whose asserted
behaviour the spec changes, and nothing else.

## 0. Overview and build order

The work goes bottom-up along the module boundaries in `.dependency-cruiser.cjs`. Each stage
typechecks on its own.

| Stage | Module | Work | Criteria |
|---|---|---|---|
| 1 | `src/protocol` | `ShareLevel`, `DaemonConfig.shareSessions`, `NICKNAME_RE`, `nicknameOk`, `SyncRequest.machine`, `SyncResponse`, `MachineName`, `LiveMachine.nickname`, `FleetSession`, `FleetMachine`, `FleetView`, `TOOLS.mesh_fleet`, `HUB_API` rows, `MESH_SKILL` text | AC-01, AC-24, AC-25 |
| 2 | `src/core` | `visibility.ts` (`sessionVisible`), `fleet.ts` (`age`, `renderFleet`), exported from `index.ts` | AC-08, AC-17 |
| 3 | `src/store` | migration 6 (both dialects), `MachineRow`, `machineFrom`, `touchMachine(…, facts?)`, `setMachineNickname` | AC-05, AC-06, AC-07 |
| 4 | `src/hub` | `sync` (store facts, reply `share`), `live` (visibility, nickname, activity text), `fleet`, `renameMachine`, `say` visibility, routes in `app.ts` | AC-04, AC-09 to AC-13, AC-28, AC-29 |
| 5 | `src/daemon` | `repos.ts` (`scanRepos`, `REPO_SCAN_MS`, `repoInventory`), `hub-link.ts` (`syncedSessions(all, share)`, `share`/`machineRepos` deps, confirmation, per-credentials memory), `daemon.ts` (inventory with rescan interval, `/local/fleet`), `tools.ts` (`mesh_fleet`) | AC-03, AC-14 to AC-16, AC-20, AC-21, AC-27, AC-30 |
| 6 | `src/cli` | `newConfig()` → `me`, `mesh setup` share flags and lines, `mesh machines` / `mesh fleet`, `mesh machine name`, `DaemonClient.fleet()`, TUI `renderMachines` and key `m` | AC-01, AC-02, AC-18, AC-19, AC-22 |
| 7 | `web/src` | `api.fleet()`, nav **Mine**, `#/mine` page, refetch on hint and every 15 s | AC-23 |
| 8 | repo | `pnpm schemas` (OpenAPI, skill), docs, `package.json` 0.1.9, adjust the listed existing tests and snapshot, `pnpm check` | AC-24, AC-25, AC-26 |

Order constraints that hold across sections:
- The protocol types (stage 1) come before everything else. Store, hub, daemon, CLI and web import them.
- Store migration 6 (stage 3) comes before the hub's `sync`, `fleet` and `renameMachine` (stage 4). Those read and write the new columns.
- `core/fleet.ts` (stage 2) comes before the daemon tool, the CLI commands and the TUI panel. All three render with `renderFleet`.
- `pnpm schemas` runs after the last change to `src/protocol` (HUB_API, SyncRequest, MachineName, MESH_SKILL). It runs again whenever one of them changes later.
- `package.json` version and docs can go last. They do not affect compilation.

Blast radius summary: one schema migration on the hub (additive columns plus a unique index). The
sync wire format changes additively in both directions (an optional `machine` field, an optional
`share` in the reply). `/v1/live` changes behaviour: no-step sessions of machines that report
`steps`/`me` or report nothing are no longer listed for other people. `syncedSessions` changes its
signature. `HubLinkDeps.shareAll` is removed. New config files default to `me`.

---

## AC-01 `DaemonConfig.shareSessions` accepts `steps|me|all`; `newConfig()` returns `me`

Files:
- `src/protocol/config.ts`
  - Add `export const ShareLevel = z.enum(["steps", "me", "all"]); export type ShareLevel = z.infer<typeof ShareLevel>;` above `DaemonConfig`.
  - `shareSessions: ShareLevel.default("steps")`. Rewrite the doc comment: `steps` (default for a file without the field), `me` (no-step sessions as metadata, only their owner sees them), `all` (the team sees them).
  - `src/protocol/index.ts` already re-exports `config.ts`, so `ShareLevel` is exported with no further change.
- `src/cli/context.ts` `newConfig()`: `shareSessions: "me"`.

Order: first change of the whole row. `hub.ts` (AC-04) imports `ShareLevel` from `./config.ts`.

Blast radius: `DaemonConfig["shareSessions"]` widens. Test literals that set `"steps"` (`test/opencode.test.ts`, `src/daemon/daemon.test.ts`, `test/m2-flow.test.ts`, `test/helpers/world.ts`) still typecheck. `src/daemon/daemon.ts:229` (`shareAll: … === "all"`) is replaced in AC-27.

Risks: none beyond the default flip for new setups. Existing files keep their level because the zod default stays `steps`.

## AC-02 `mesh setup` share flags and output lines

Files: `src/cli/mesh-commands.ts` `setupCommand`.

Changes:
- `parseArgs(args, ["port", "notify", "agent", "share-sessions", "share"])`. Use `const shareArg = a.str("share-sessions") ?? a.str("share");`.
- Validate with `ShareLevel.safeParse(shareArg)`. Otherwise print `c.io.err("--share-sessions must be steps, me or all")` and return 2.
- Record `const fresh = !existsSync(c.paths.daemonConfig)` before the existing/new branch. The existing-config branch is unchanged: the level is kept unless `shareArg` is given. The new-config branch uses `newConfig(port)`, which is now `me`.
- `if (shareArg) config = { ...config, shareSessions: shareArg as ShareLevel };` (unchanged position).
- Compute `shareLine` from the level now in effect, `config.shareSessions`, when `shareArg !== undefined || fresh`, else `""`. The lines are:
  - `steps`: `Only sessions holding a step will be reported to the hub. Restart the daemon to apply.`
  - `me`: `Sessions without a step will be reported to the hub as metadata that only you can see (state, repo, name, times; no paths or text). Restart the daemon to apply.`
  - `all`: the current v0.1.7 text, unchanged.
  - Put these three strings in one small `const SHARE_LINES: Record<ShareLevel, string>` near `setupCommand`.
- `shareLine` already appears in both output branches (OpenCode-only, line ~151, and Claude, line ~169), so the output blocks need no change.

Order: after AC-01.

Blast radius: the output of a fresh `mesh setup` gains one line. The existing `test/cli.test.ts` setup tests use `toContain` and exit codes only, so they are unaffected.

Risks: `parseArgs` might treat `--share` as a boolean when no value follows. In that case `a.str("share")` is undefined, the flag is ignored, and the command does not fail. This is acceptable.

## AC-03 `syncedSessions(all, share)`

Files: `src/daemon/hub-link.ts`.

Changes:
- Change the signature to `export function syncedSessions(all: readonly Session[], share: ShareLevel): Session[]`. `steps` returns step holders only. `me` and `all` return step holders first, then `sessionMetadata` of the rest, newest first. The cap is `SYNC_SESSIONS_MAX` (200). The body is today's with `!shareAll` replaced by `share === "steps"`.
- Import `type ShareLevel` from `../protocol/index.ts`.
- Update the doc comment.

Order: together with AC-27, which changes the only production caller (`doFlush`).

Blast radius: the existing unit tests in `src/daemon/hub-link.test.ts` call it with booleans. They are adjusted mechanically (see the list at the end).

Risks: none. `sessionMetadata` is unchanged.

## AC-04 Every sync carries `machine.share`; the hub stores it

Files:
- `src/protocol/hub.ts`
  - Import `ShareLevel` from `./config.ts` and `Repo` from `./session.ts` (it already imports `Session` from there).
  - `SyncRequest` gains `machine: z.object({ share: ShareLevel, repos: z.array(Repo).max(500).optional() }).optional()`. Update its doc comment: under `me`/`all`, metadata-only records of the other sessions.
  - Add `export interface SyncResponse { accepted: number; share?: ShareLevel | undefined }`.
- `src/daemon/hub-link.ts` `doFlush`: the body becomes `{ events, sessions, counts, machine: { share: configured, ...(repos ? { repos } : {}) } }`. See AC-16 and AC-27 for `repos` and `sessions`.
- `src/hub/service.ts` `sync`: pass `req.machine` to `touchMachine` as `facts` (AC-06). The reply is in AC-28.

Order: protocol, then store (AC-06), then hub, then daemon.

Blast radius: older hubs ignore the unknown `machine` key, because zod `object` strips unknown keys by default. `SyncRequest` with `.strict()` would break that. Check that `SyncRequest` is not strict (it is not today). Older daemons do not send `machine`, so the hub keeps what it has.

Risks: `schemas/hub-api.openapi.json` changes because the `SyncRequest` body schema changes. Regenerate it (AC-24).

## AC-05 Schema version 6; equal-length migrations; plain machine row unchanged

Files: `src/store/hub-store.ts`.

Migrations (append one entry to each list, with a `// v0.1.9: …` comment on the SQLite one):
- SQLite `HUB_MIGRATIONS[5]`:
  ```sql
  ALTER TABLE machine ADD COLUMN share TEXT;
  ALTER TABLE machine ADD COLUMN nickname TEXT;
  ALTER TABLE machine ADD COLUMN extra TEXT;
  CREATE UNIQUE INDEX machine_nickname ON machine (user_id, nickname);
  ```
- Postgres `HUB_MIGRATIONS_PG[5]`: the same four statements (`TEXT` on both engines; `machine` is not a reserved word).
- `extra` is one nullable JSON object for "the rest" (now `{ repos, reposAt }`; MM-2/MM-3 add labels and accept there). This follows the spec's implementer note and needs no rename later.
- Both engines allow many NULL nicknames under a plain unique index (Postgres default `NULLS DISTINCT`).
- `HubStore.SCHEMA_VERSION` stays `HUB_MIGRATIONS.length` and so becomes 6 automatically. `/readyz` reports it with no change (`src/hub/service.ts` `ready()` already uses `HubStore.SCHEMA_VERSION`).

Types and mapping:
- `MachineRow` gains `share?: ShareLevel; nickname?: string; repos?: Repo[]; reposAt?: number;`. Import `ShareLevel` and `Repo` types from `../protocol/index.ts`. The store may import protocol.
- `MachineDbRow` gains `share?: string | null; nickname?: string | null; extra?: string | null`.
- `machineFrom` adds each key only when it is set:
  `...(r.share ? { share: r.share as ShareLevel } : {})`, `...(r.nickname ? { nickname: r.nickname } : {})`, and from `const x = r.extra ? JSON.parse(r.extra) : {}`: `...(Array.isArray(x.repos) ? { repos: x.repos } : {})`, `...(typeof x.reposAt === "number" ? { reposAt: x.reposAt } : {})`.
  So a row with all of these NULL maps to exactly `{ id, userId, hostname, lastSeen, counts }` (plus `installId` only when set, as today).

Other files: `src/store/hub-copy.ts` copies columns via `PRAGMA table_info` into the migrated Postgres schema. It needs no change, because both schemas gain the same columns. `HUB_MIGRATIONS.length !== HUB_MIGRATIONS_PG.length` is already guarded there.

Order: the first store change. AC-06 and AC-07 build on the columns.

Blast radius: every hub (SQLite and Postgres) migrates on start. Older hub binaries refuse a v6 database the way `ready()` handles a newer schema today (reports the higher version). That is the documented upgrade order (all replicas first).

Risks:
- Upgrading a SQLite file with existing machines: the `ALTER TABLE … ADD COLUMN` statements are cheap.
- The unique index cannot fail on existing data, because every nickname is NULL.

## AC-06 `touchMachine(id, now, counts, facts?)`

Files: `src/store/hub-store.ts`.

Change `touchMachine(id: string, now: number, counts: Record<string, number>, facts?: { share?: ShareLevel; repos?: Repo[] })`:
- Without `facts`, or with `facts` but neither key set: today's single `UPDATE machine SET last_seen = ?, counts = ? WHERE id = ?`.
- Otherwise run in `this.tx(async () => { … })`:
  1. `const r = await this.db.get<{ extra: string | null }>("SELECT extra FROM machine WHERE id = ?", id)`. If there is no row, return (an unknown id stays a no-op, as today).
  2. When `facts.repos` is given, set `extra = json({ ...parsed(r.extra), repos: facts.repos, reposAt: now })`. Otherwise keep `r.extra`.
  3. `UPDATE machine SET last_seen = ?, counts = ?, share = COALESCE(?, share), extra = ? WHERE id = ?` with `facts.share ?? null`.

Order: after AC-05. Then `HubService.sync` passes the facts (AC-04).

Blast radius: the only callers are `HubService.sync` and possibly tests. `grep touchMachine` shows only `service.ts:1092`.

Risks: two concurrent syncs of one machine on Postgres can each read `extra` and both write. The last writer wins, and both writes come from the same daemon, so this is harmless. No lock is added.

## AC-07 `setMachineNickname(id, nickname | undefined): Promise<boolean>`

Files: `src/store/hub-store.ts`.

New method, as the spec states it:
```ts
setMachineNickname(id: string, nickname: string | undefined): Promise<boolean> {
  return this.tx(async () => {
    await this.serialize();                           // PG: events lock; SQLite: no-op (BEGIN IMMEDIATE + Db queue)
    const m = await this.db.get<{ user_id: string }>("SELECT user_id FROM machine WHERE id = ?", id);
    if (!m) return true;                              // unknown id: nothing changes
    if (nickname !== undefined) {
      const clash = await this.db.get("SELECT id FROM machine WHERE user_id = ? AND nickname = ? AND id <> ?", m.user_id, nickname, id);
      if (clash) return false;                        // never rely on the unique index error
    }
    await this.db.run("UPDATE machine SET nickname = ? WHERE id = ?", nickname ?? null, id);
    return true;
  });
}
```
- Add a small `machineByNickname(userId, nickname): Promise<MachineRow | undefined>` so the hub can build the 409 message (AC-13). Alternatively the hub filters `listMachines()`. Prefer the dedicated query.

Order: after AC-05.

Blast radius: new method only.

Risks:
- The concurrency guarantee rests on `serialize()` on Postgres and on the SQLite `Db` transaction queue (`src/store/db.ts`, one transaction at a time). `this.tx` joins a caller's transaction, so the hub's `renameMachine` transaction holds the lock until commit.
- Postgres advisory xact locks are re-entrant within a transaction, so a later `emit` (`appendEvent` → `lock("events")`) in the same transaction does not deadlock.

## AC-08 `sessionVisible`

Files:
- New `src/core/visibility.ts`:
  ```ts
  import type { ShareLevel } from "../protocol/index.ts";
  /** MM-1: who may see a session in hub listings (/v1/live, /v1/fleet) and message it. */
  export function sessionVisible(viewerId: string, s: { userId: string; step?: string | undefined }, share: ShareLevel | undefined): boolean {
    return s.userId === viewerId || s.step !== undefined || share === "all";
  }
  ```
  Treat an empty-string step as set or not? The `Session.step` schema is `string | undefined`, so use `!== undefined` exactly as the spec says.
- `src/core/index.ts`: `export * from "./visibility.ts";`.

Order: stage 2. Used by AC-09 and AC-29.

Blast radius: none (new).

## AC-09 `/v1/live` hides other people's no-step sessions under `me`

Files: `src/hub/service.ts` `live()`.

Changes:
- After `const machines = await this.store.listMachines();`, build `const shareOf = new Map(machines.map((m) => [m.id, m.share]))`.
- Add a filter to the sessions of each person: `.filter((hs) => hs.userId === u.id && sessionVisible(viewer.userId, { userId: hs.userId, step: hs.session.step }, shareOf.get(hs.machineId)))`.
- `counts` is still `m.counts` from the row, unchanged.
- Extract the existing `LiveSession` mapping into a private helper `liveSession(hs: HubSession, userId: string): LiveSession`. `fleet()` reuses it (AC-11).
- Import `sessionVisible` from `../core/index.ts`.

A `live:read` service token's `viewer.userId` is the service user, who owns no sessions, so the rule needs no special case.

Order: after AC-05 (`MachineRow.share`) and AC-08.

Blast radius: changes what every member and service token sees on Live. `test/share-sessions.test.ts` (alice `all`, bob `steps`) must still pass unchanged: alice's daemon reports `share: "all"` in the same sync that carries her sessions (AC-04, AC-27). Bob's no-step session is not synced at all under `steps`.

Risks: sessions synced by a v0.1.7/0.1.8 `all` daemon (share absent) disappear for others. This is intended and recorded in Open questions.

## AC-10 `/v1/live` regressions

Same code as AC-09. Nothing extra: step holders are visible through `s.step !== undefined`, `all` through `share === "all"`, and a machine with no share reported only to its owner. Verify by running `test/share-sessions.test.ts` and the Live World tests (`test/m4-hub.test.ts`, `test/m2-flow.test.ts`) unchanged.

Risks: a hub session row whose stored `session.step` was cleared after release is now hidden from others on a non-`all` machine. Before this change it was listed. This matches the rule (it holds no step).

## AC-11 `GET /v1/fleet`

Files:
- `src/protocol/hub.ts`:
  - `LiveMachine` gains `nickname?: string | undefined`.
  - `export interface FleetSession extends LiveSession { lastEventAt: number }`.
  - `export interface FleetMachine { id: string; hostname: string; nickname?: string | undefined; online: boolean; lastSeen: number; counts: Record<string, number>; share?: ShareLevel | undefined; repos: Repo[]; reposAt?: number | undefined; current: boolean; sessions: FleetSession[] }`.
  - `export interface FleetView { now: number; user: UserView; machines: FleetMachine[] }`.
- `src/hub/service.ts`, a new method `fleet(viewer: Actor): Promise<FleetView>` in `this.store.tx`:
  - `now = this.now()`; `mine = (await listMachines()).filter((m) => m.userId === viewer.userId)`.
  - `sessions = (await listSessions()).filter((hs) => hs.userId === viewer.userId && hs.session.state !== "ended")`.
  - For each machine: `{ id, hostname, ...(nickname), online: now - lastSeen < ONLINE_MS, lastSeen, counts, ...(share), repos: m.repos ?? [], ...(reposAt), current: m.id === viewer.machineId, sessions }`. The sessions are `sessions.filter((hs) => hs.machineId === m.id).map((hs) => ({ ...this.liveSession(hs, viewer.userId), lastEventAt: hs.session.lastEventAt }))`, sorted by `lastEventAt` desc, then `sid` asc.
  - Sort the machines: online first, then `lastSeen` desc, then `id` asc.
  - `user: this.userView(await this.store.getUser(viewer.userId) as UserRow)`, as `live()` does.
  - Optional keys must be absent, not `undefined`, so `--json` and `toEqual` comparisons are stable. Use conditional spreads.
- `live()` machine mapping adds `...(m.nickname ? { nickname: m.nickname } : {})`.
- `src/hub/app.ts`: `r("GET", "/v1/fleet", "member", async (c, a) => c.json(await svc.fleet(a)), "live:read")`, in the dashboard group next to `/v1/live`.
- `src/protocol/hub-api.ts`: `{ method: "GET", path: "/v1/fleet", rule: "member", scope: "live:read", tag: "daemon", summary: "Every machine logged in as the caller and what each session on it is doing (read-only)." }`.

Order: after AC-05 and AC-09 (the `liveSession` helper).

Blast radius: new route only, plus an optional `nickname` on `/v1/live` machines.

Risks: the `LiveSession` mapping keeps `undefined`-valued keys (`repo`, `name`, `step`, …), as `/v1/live` does today. JSON drops them, so HTTP clients see absent keys. This is fine for `--json` (AC-18), which round-trips through JSON.

## AC-12 `/v1/fleet` with a service token, no scope, no token

Covered by the route declaration in AC-11. `allowed("member", p, "live:read")` gives a `live:read` service token 200 (its user has no machines, so `machines: []`). A service token without the scope gets 403, and no token gets 401 (both from the generic guard in `createApp`).

Risks: `fleet()` calls `getUser(viewer.userId)` for a service user. Service users exist as `user` rows (as `live()` already relies on), so this is safe.

## AC-13 `POST /v1/machines/:id/name`

Files:
- `src/protocol/hub.ts`:
  - `export const NICKNAME_RE = /^[a-z0-9][a-z0-9-]{0,31}$/;`
  - `export const MACHINE_ID_RE = /^m-[0-9a-f]{8}$/;`
  - `export function nicknameOk(n: string): boolean { return NICKNAME_RE.test(n) && !MACHINE_ID_RE.test(n); }`
  - `export const MachineName = z.object({ nickname: z.string().refine(nicknameOk, "nickname must match [a-z0-9][a-z0-9-]{0,31} and not look like a machine id").nullable() });`
  - Note that `nickname` is required, with `null` to clear.
- `src/hub/service.ts`, a new `renameMachine(actor: Actor, id: string, nickname: string | null): Promise<{ id: string; hostname: string; nickname?: string }>` in `this.store.tx`:
  1. `const m = await this.store.getMachine(id)`. If it is missing, throw `HubError(404, \`no machine ${id}\`)`.
  2. If `m.userId !== actor.userId`, throw `HubError(403, "not your machine")`. This applies to admins too, so there is no role check.
  3. `const next = nickname ?? undefined`. If `next === m.nickname`, return the current view (no event, no write).
  4. If `!(await this.store.setMachineNickname(id, next))`, find the other machine (`machineByNickname(actor.userId, next)`) and throw `HubError(409, \`nickname ${next} is already used by your machine ${other.hostname} (${other.id})\`)`.
  5. `await this.emit({ type: "machine.named", user: actor.userId, payload: { machine: id, nickname: next ?? null } })`. `emit` publishes the SSE `changed` hint after commit.
  6. Return `{ id, hostname: m.hostname, ...(next ? { nickname: next } : {}) }`.
- `describe()` in `service.ts`: add a context argument so it can name the machine. Change the signature to `describe(type, subject, payload, hostnames?: ReadonlyMap<string, string>)` and add:
  ```ts
  case "machine.named": {
    const host = hostnames?.get(String(payload.machine)) ?? String(payload.machine);
    return payload.nickname ? `named machine ${host} ${String(payload.nickname)}` : `cleared the name of machine ${host}`;
  }
  ```
  In `live()`, pass `new Map(machines.map((m) => [m.id, m.hostname]))`. `timeline()` leaves it out (goal-scoped, with no machine events).
- `src/hub/app.ts`: `r("POST", "/v1/machines/:id/name", "member", async (c, a) => c.json(await svc.renameMachine(a, param(c, "id"), (await body(c, MachineName)).nickname)))`. It has no scope, so service tokens get 403. Import `MachineName`.
- `src/protocol/hub-api.ts`: `{ method: "POST", path: "/v1/machines/:id/name", rule: "member", tag: "daemon", body: MachineName, summary: "Name one of your machines (or clear its name with null)." }`. Import `MachineName`.

The 400 comes from the zod parse in `body()` (`{ error: "invalid request", details }`) before any store access. It covers `M2`, `-x`, a 33-character name, `m-0a1b2c3d`, and a missing `nickname`.

Order: after AC-07 and AC-11 (route group).

Blast radius: new route and a new event type. The `activity` texts on `/v1/live` gain one case. `describe` is module-private.

Risks:
- Concurrent rename requests must answer one 200 and one 409, never 500. This relies on `setMachineNickname` checking under the lock, not on the unique index.
- The request goes through `createApp`'s idempotency layer like every POST. Only 2xx responses are cached, so a 409 is not.

## AC-14 `scanRepos`

Files: new `src/daemon/repos.ts`.

```ts
import { readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Repo } from "../protocol/index.ts";
import { repoForCwd } from "./git.ts";

export const REPO_SCAN_MS = 300_000;
export const REPO_INVENTORY_MAX = 500;

/** Repos ids and names (no paths) of git checkouts at depth 0..2 under each root. */
export function scanRepos(roots: readonly string[]): Repo[]
/** Dedupe by id, drop `local/` ids, sort by name then id, cap at 500. */
export function repoInventory(repos: Iterable<Repo | undefined>): Repo[]
```
- Expand a root: `r === "~" ? homedir() : r.startsWith("~/") ? join(homedir(), r.slice(2)) : r`.
- Walk with `visit(dir, depth)`:
  - If `exists(join(dir, ".git"))` (folder or file; use `statSync` in try/catch), push `repoForCwd(dir)` and do not descend.
  - Else, if `depth < 2`, read `readdirSync(dir, { withFileTypes: true })` in try/catch (an unreadable folder is skipped). For each entry that is a directory (follow symlinked directories through `statSync`; skip on error) whose name does not start with `.` and is not `node_modules`, call `visit(join(dir, name), depth + 1)`.
  - A missing root fails the `.git` check and the readdir silently.
- Return `repoInventory(found)`.
- `repoForCwd` from `./git.ts` reads `.git/config` (or a worktree's commondir config) without spawning git. The `processes-only-in-adapters` boundary is respected.
- `repoForCwd` returns `local/…` ids for `file://` and absolute-path remotes. `repoInventory` drops ids starting with `local/`, and also undefined values (checkouts without a remote).

Order: stage 5, before AC-15/16.

Blast radius: new file.

Risks:
- Large home directories: the depth is capped at 2, hidden folders and `node_modules` are skipped, and there is no descent into checkouts.
- Symlink loops are bounded by the depth cap.

## AC-15 Inventory reaches the hub (no paths)

Files:
- `src/daemon/daemon.ts`:
  - `DaemonDeps` gains an optional `scanRepos?(roots: readonly string[]): Repo[]`, defaulting to the real `scanRepos` in `defaultDeps`. Do not use `deps.repoForCwd` for the scan: the World injects a fixed `repoForCwd`, and the scan must read real checkouts.
  - New private state `private repoScan: { at: number; repos: Repo[] } | undefined`.
  - New private `machineRepos(): Repo[]`:
    ```ts
    if (this.config.shareSessions === "steps") return [];
    const now = this.deps.now();
    if (!this.repoScan || now - this.repoScan.at >= REPO_SCAN_MS)
      this.repoScan = { at: now, repos: (this.deps.scanRepos ?? scanRepos)(this.config.workspaceRoots) };
    return repoInventory([...this.repoScan.repos, ...this.sessions.filter((s) => s.state !== "ended" && !isHidden(s)).map((s) => s.repo)]);
    ```
    `Session.repo` is `{ id, name }` only, so there is no path.
  - The `HubLink` construction (line ~226) replaces `shareAll` with `share: () => this.config.shareSessions` and `machineRepos: () => this.machineRepos()`.
- `src/protocol/hub.ts`: `SyncRequest.machine.repos` is `Repo[]` (`id`, `name`) only, so the hub never stores a path.
- The hub side is AC-06 (stored in `extra.repos`, `reposAt = now`) and AC-11 (`repos`, `reposAt` in `FleetMachine`).

Order: after AC-14, AC-06, AC-11; together with AC-16.

Blast radius: the daemon now reads the file system under `workspaceRoots` at most every 5 minutes (only under `me`/`all`).

Risks: `workspaceRoots` are as configured by `mesh run` today. An empty list means only session repos.

## AC-16 Repos re-sent only on change; rescan interval; credentials switch

Files: `src/daemon/hub-link.ts` (send-on-change, per-credentials memory) and `src/daemon/daemon.ts` (rescan interval, AC-15).

Changes in `HubLink`:
- `HubLinkDeps`: remove `shareAll`. Add `share?: () => ShareLevel` (default `"steps"`) and `machineRepos?: () => Repo[]`.
- New private state, keyed per credentials:
  ```ts
  private factsKey: string | undefined;          // `${c.hub}\n${c.machine ?? ""}`
  private confirmed = false;                     // last sync reply for factsKey carried `share`
  private sentRepos: string | undefined;         // JSON of the last inventory the hub accepted for factsKey
  private warnedUnconfirmed = false;             // the "does not support me" line was logged for factsKey
  ```
- A helper `private factsFor(c: Credentials)`: when the key differs from `factsKey`, reset all three state fields and set the new key.
- In `doFlush(c)`, after the probe:
  - Call `this.factsFor(c)`.
  - `const share = this.deps.share?.() ?? "steps"`.
  - `const repos = this.deps.machineRepos?.() ?? []`. Compute it once per flush; the daemon caches the scan.
  - `const reposJson = JSON.stringify(repos)`.
  - In the batch loop:
    ```ts
    const effective: ShareLevel = share === "me" && !this.confirmed ? "steps" : share;
    const sendRepos = this.sentRepos !== reposJson;
    const body = { events, sessions: syncedSessions(all, effective), counts, machine: { share, ...(sendRepos ? { repos } : {}) } };
    const reply = await this.rpc<SyncResponse>("POST", "/v1/sync", body, undefined, { probe: true });
    if (sendRepos) this.sentRepos = reposJson;
    this.confirmed = reply.share !== undefined;
    if (share === "me" && !this.confirmed && !this.warnedUnconfirmed) { this.deps.log("the hub does not support share level me; sending step holders only"); this.warnedUnconfirmed = true; }
    ```
    `sentRepos` changes only after a 2xx reply, so a failed or offline sync re-sends next time.
  - `repos` under `steps` is `[]` from the daemon. The empty list goes on the first sync for the credentials and then only on change, which clears an inventory stored under an earlier level (AC-30).
- `credentials()` already detects a credentials file change (mtime), and `mode` switches between team and solo. The key comparison in `factsFor` covers both a hub URL change and a machine id change, even when the file changes with the same mtime handling.

Order: with AC-03, AC-27 and AC-15.

Blast radius: `HubLinkDeps.shareAll` removal. `grep shareAll` shows only `daemon.ts:229`, which is replaced. The sync body always carries `machine`.

Risks:
- The daemon's `REPO_SCAN_MS` uses `deps.now()` (the injected clock in tests). `HubLink` does not rescan, it only compares.
- "First sync of a daemon process carries repos" holds because `sentRepos` starts undefined.

## AC-17 `renderFleet`

Files:
- New `src/core/fleet.ts`:
  - Move `age(ms)` here from `src/cli/tui/render.ts`, with the same body. `render.ts` keeps exporting it as `export { age } from "../../core/index.ts";` (re-export), so `render.test.ts` and `mesh-commands.ts` imports keep working.
  - `export function renderFleet(view: FleetView, opts: { skipCurrent?: boolean } = {}): string`:
    - `ms = opts.skipCurrent ? view.machines.filter((m) => !m.current) : view.machines`. If it is empty, return `No machines logged in as you yet. Run mesh login on each machine.`.
    - Per machine, the title is `m.nickname ? \`${m.nickname} (${m.hostname})\` : m.hostname`. Presence is `online` or `last seen ${age(view.now - m.lastSeen)} ago`. Share is `m.share ?? "?"`. The repo count is `${n} ${n === 1 ? "repo" : "repos"}`, plus ` · this machine` when current.
    - Session line: `  ${s.repo ?? "-"} · ${s.name ?? s.sid.slice(0, 8)} · ${s.state}${s.needs ? \` (${s.needs})\` : ""} · ${s.step ?? "no step"} · ${age(view.now - s.lastEventAt)}`.
    - No sessions: `  no sessions`.
    - Join the blocks with `"\n\n"`. Return without a trailing newline (callers add one through `io.out`).
  - Treat an empty `name` string as absent? The spec says "session name, else the first 8 characters of the sid". Use `s.name || s.sid.slice(0, 8)` so an empty name also falls back. Use `s.repo || "-"` for the same reason.
- `src/core/index.ts`: `export * from "./fleet.ts";`.

Order: stage 2 (needs the `FleetView` type from stage 1).

Blast radius: `age` moves module. Its callers are `src/cli/tui/render.ts` (internal) and `src/cli/mesh-commands.ts` (imports from `./tui/render.ts`), which keep working through the re-export.

Risks: `export *` collisions in `core/index.ts`. Make sure no other core module exports `age` (none does today).

## AC-18 `mesh machines` / `mesh fleet` (`--json`)

Files: `src/cli/hub-commands.ts` (or a new `src/cli/machine-commands.ts` imported by `hubCommands`; prefer the new file to keep `hub-commands.ts` from growing).

Changes:
- `function machinesCommand(c: CliEnv, name: "machines" | "fleet"): Command`, with summary `every machine logged in as you and what each session does (--json)`:
  - `const creds = loadCredentialsOrSolo(c.paths)`. If none, `c.io.err("not logged in to a hub; run: mesh login"); return 1`.
  - `const view = await new HubClient(creds).get<FleetView>("/v1/fleet")`.
  - `--json`: `c.io.out(JSON.stringify(view, null, 2))`. Otherwise `c.io.out(renderFleet(view))`. Return 0.
- Register both in `hubCommands(c)`: `machinesCommand(c, "machines"), machinesCommand(c, "fleet")`. `usage()` lists each command, so both appear in `mesh help`.

Order: after AC-17 and AC-11.

Blast radius: `mesh help` output gains three lines (with AC-19). Snapshot check: the `test/__snapshots__/cli.test.ts.snap` entries are service files only, so there is no help snapshot to update.

Risks: hub errors propagate as `HubCallError` and `main.ts` prints `mesh: <message>` and exits 1. This is acceptable for this command.

## AC-19 `mesh machine name`

Files: the same CLI file as AC-18.

`function machineCommand(c: CliEnv): Command`, name `machine`, summary `name one of your machines: mesh machine name <nickname> [--machine <id|nickname|hostname>] | --clear`:
- `const a = parseArgs(args, ["machine"])`, `const [sub, nickname] = a.positional`, `const clear = a.has("clear")`.
- If `sub !== "name" || (!nickname && !clear)`, print to stderr the usage, which starts with `usage:` and contains `mesh machine name <nickname>`, and return 2.
- If `nickname && !nicknameOk(nickname)`, print `nickname must match [a-z0-9][a-z0-9-]{0,31} and not look like a machine id` and return 2. This happens before any credentials or hub access.
- `const creds = loadCredentialsOrSolo(c.paths)`.
- Target:
  - Without `--machine`, the target is `creds?.machine`. If there is none, print `this installation has no machine on the hub; run: mesh login` and return 1.
  - With `--machine x`: if there are no creds, print `not logged in to a hub; run: mesh login` and return 1. Otherwise fetch `GET /v1/fleet` and resolve, in order: exact `id`, then `nickname === x`, then hostname matches.
    - No match: print `no machine of yours matches "${x}"` and return 1.
    - Several hostname matches: print `"${x}" matches several of your machines: ${ids.join(", ")}; use the id` and return 1.
- Call `POST /v1/machines/${encodeURIComponent(id)}/name` with `{ nickname: clear ? null : nickname }`. Wrap it in try/catch: on `HubCallError`, print `e.message` to stderr and return 1. A 409 carries the hub's text.
- Success prints `Named ${r.hostname} (${r.id}) ${r.nickname}.` or `Cleared the nickname of ${r.hostname} (${r.id}).` and returns 0.
- Register `machineCommand(c)` in `hubCommands`.
- Import `nicknameOk`, `FleetView` from `../protocol/index.ts`; `HubClient`, `HubCallError`, `loadCredentialsOrSolo` from `./hub-client.ts`.

Order: after AC-13 and AC-18.

Blast radius: new commands only.

Risks:
- `HubClient.post` sends an idempotency key, which is harmless.
- `parseArgs` (`context.ts`) returns `{ flags, positional, has, str }`. `--clear` goes into `flags`, so `has("clear")` reads it, and `positional` holds `name` and the nickname.

## AC-20 MCP `mesh_fleet`

Files:
- `src/protocol/tools.ts`: add
  `mesh_fleet: { description: "Every machine logged in as your user and what each session on it is doing (read-only).", input: {} }`.
  Update the header comment ("The eight" → "The nine"). `TOOL_NAMES` picks it up, and so does the shim (`src/mcp/shim.ts` iterates `TOOL_NAMES`).
- `src/daemon/tools.ts` `dispatch`: `case "mesh_fleet": return ok(renderFleet(await host.link.rpc<FleetView>("GET", "/v1/fleet")));`. Import `renderFleet` from `../core/index.ts`.
  With the hub offline, `rpc` throws an offline `HubRpcError` and `runTool` returns `fail(\`${e.message}. ${OFFLINE_TAIL}\`)`, the existing offline text.
- The OpenCode plugin (`src/opencode/plugin.ts`) does not list tool names; OpenCode gets the tools through the same `mesh mcp` shim, so it needs no change.

Order: after AC-17 and AC-11.

Blast radius: every MCP client sees a ninth tool. The existing test `test/m2-flow.test.ts` "exposes the eight tools" is adjusted (see the list).

Risks: the daemon's `callTool` needs a known session (the Claude pid) even for this session-free tool. That is acceptable; the spec does not require otherwise.

## AC-21 `GET /local/fleet`

Files:
- `src/daemon/daemon.ts` request handler, next to `/local/goals`:
  ```ts
  if (req.method === "GET" && path === "/local/fleet") {
    if (!this.link?.credentials()) throw new HttpError(409, "not logged in to a hub; run: mesh login");
    return send(res, 200, await this.link.rpc<FleetView>("GET", "/v1/fleet"));
  }
  ```
- `src/cli/client.ts`: `async fleet(): Promise<FleetView> { return (await this.call("GET", "/local/fleet")) as FleetView; }`. Import the `FleetView` type.

Order: after AC-11.

Blast radius: new local route.

Risks: a hub error while logged in surfaces as a 500 with the message, the same behaviour as `/local/goals`.

## AC-22 TUI `renderMachines`, key `m`, footer

Files:
- `src/cli/tui/render.ts`:
  - Session list footer: `⏎ jump · s say · a autopilot · n next step · g goals · m machines · r refresh · ↑↓ move · q quit`.
  - New export:
    ```ts
    export function renderMachines(fleet: FleetView, v: { width: number; height: number; header: string; status?: string | undefined }): string[] {
      const lines = [v.header, "", "MY MACHINES"];
      const others = fleet.machines.filter((m) => !m.current);
      if (others.length === 0) lines.push("  No other machines. Run mesh login on your other machines.");
      else for (const l of renderFleet(fleet, { skipCurrent: true }).split("\n")) lines.push(`  ${l}`.trimEnd() === "" ? "" : `  ${l}`);
      const footer = [...(v.status ? [fit(v.status, v.width)] : []), "m back to sessions · g goals · details: mesh machines"];
      const room = v.height - footer.length;
      const body = lines.slice(0, room).map((l) => fit(l, v.width));
      while (body.length < room) body.push("");
      return [...body, ...footer.map((l) => fit(l, v.width))];
    }
    ```
    - Empty lines between machine blocks stay empty, with no trailing indent.
    - The status line is just above the footer, and the footer is the last line.
    - Exactly `height` lines (for `height` ≥ the footer size).
    - Check `fit` against the visible-width rule. `renderFleet` emits no ANSI, and `fit` must not add any that breaks the width check. The footer is plain text, not `paint`ed, to keep widths exact.
  - Import `renderFleet` and `type FleetView`.
- `src/cli/tui/tui.ts`:
  - Replace `let goals: GoalRow[] | undefined` with a view state: `let view: "sessions" | "goals" | "machines" = "sessions"` plus `goals` and `fleet: FleetView | undefined`.
  - `draw()`: in `machines` with `fleet`, call `renderMachines(fleet, …)`. With no fleet yet, render the header and the status.
  - `const loadFleet = async () => { try { fleet = await client.fleet(); status = undefined; } catch (e) { status = msg(e); } draw(); }`.
  - Key `m`: from `machines`, go back to `sessions` and clear the fleet timer. From `sessions` or `goals`, switch to `machines`, `await loadFleet()`, and start `fleetTimer = setInterval(() => void loadFleet(), 5_000)`.
  - Key `g`: from `machines`, stop the fleet timer, then do today's goals load. From `goals`, go back to `sessions` (as today).
  - Any view other than `sessions` returns before the session keys (⏎, s, a, n, r, j/k), like today's `if (goals) return;`.
  - `quit()` also clears the fleet timer.

Order: after AC-17 and AC-21.

Blast radius: the session-list snapshot (`src/cli/tui/__snapshots__/render.test.ts.snap`) changes because of the footer. It is regenerated (see the list).

Risks:
- The longer footer line may exceed narrow widths. Today's footer is not `fit`ted either, so the behaviour is unchanged.
- The spec only asserts that the session list footer contains `m machines`.

## AC-23 Web Mine tab

Files:
- `web/src/api.ts`: `fleet: () => call<FleetView>("GET", "/v1/fleet")`. Import the `FleetView` type from `../../src/protocol/hub.ts`.
- New `web/src/mine.tsx` exporting `MinePage({ hint }: { hint: number })`:
  - A `load()` that calls `api.fleet()` and sets state or an error. It runs on mount, on every change of `hint`, and every 15 s through `setInterval`.
  - Render:
    - No machines: the text `No machines logged in as you yet. Run mesh login on each machine.`.
    - Otherwise, for each machine, a `<section className="machine">` with:
      - a heading: nickname and hostname as `<nickname> (<hostname>)`, or the hostname;
      - online or `last seen <age> ago`;
      - `share <level|?>`;
      - `<n> repo(s)`;
      - `this machine` when current;
      - a `<table>` of sessions (repo, name, state (+needs), step or `no step`, age), or `no sessions`.
  - Move the `ago()` helper from `main.tsx` into a tiny shared module (`web/src/time.ts`) or export it from `main.tsx`. Prefer `time.ts` to avoid a circular import.
- `web/src/main.tsx`:
  - Nav: add `<a href="#/mine" className={route === "#/mine" ? "active" : ""}>Mine</a>` after Goals.
  - In `App`, add `const [hint, setHint] = useState(0)`. The existing `changed` handler's debounce (300 ms) also calls `setHint((n) => n + 1)`.
  - Routing: `route === "#/mine" ? <MinePage hint={hint} /> : …`.
  - Optional: show `nickname` next to the hostname wherever Live lists machines. This is not required.
- `web/src/styles.css`: minimal `.machine` section styles, reusing the existing card and table styles.

Order: after AC-11.

Blast radius: web bundle only. `pnpm build` runs `vite build` and typechecks through `tsconfig` if web is included.

Risks:
- A metadata-only sync emits no event, so no SSE hint. The 15 s poll is the bound, and the spec accepts it.
- The Playwright fixture (`test/e2e-web/hub.yaml`) is test-side.

## AC-24 OpenAPI and `HUB_API`

Files:
- `src/protocol/hub-api.ts`:
  - The two rows from AC-11 and AC-13.
  - Import `MachineName`.
  - `/v1/fleet` with `scope: "live:read"`. The generator writes "Also service tokens with the scope `live:read`."
  - `/v1/machines/:id/name` → path `/v1/machines/{id}/name`, generated from `:id`.
- `src/hub/app.ts`: the two routes with the same `rule` and `scope`.
- Run `pnpm schemas` to regenerate `schemas/hub-api.openapi.json`. `SyncRequest` changed too, and `skills/mesh/SKILL.md` changes (AC-25).

Order: last protocol change, then `pnpm schemas`.

Blast radius: the generated files. The route-table test extension (`method path rule scope`) is the test side's (AC-24 surface). The routes must match on scope too: `/v1/fleet` has `"live:read"` in both places, and `/v1/machines/:id/name` has no scope in both.

## AC-25 Docs and skill

Files:
- `docs/guide/install.md` "What the hub sees": rewrite it for the three levels.
  - `steps`: step holders, counts and the level; no inventory.
  - `me`: the default for new setups. No-step sessions go as metadata, only you see them, and the repo inventory is sent.
  - `all`: the team sees them; the inventory is sent.
  - Who sees what; owner only, admins included in the refusal.
  - `mesh setup --share-sessions me` (and the `--share` alias).
  - Upgrade every hub replica to v0.1.9 before the daemons. A `me` daemon sends step holders only until its hub confirms.
  - A v0.1.7/v0.1.8 daemon set to `all` shows its no-step sessions to its owner only until it is updated.
  - The inventory is the ids and names of repos under `workspaceRoots` and of current sessions, never paths.
- `docs/guide/concepts.md`: entries for the machine nickname, share levels, repo inventory (none under `steps`), and "My mesh".
- `docs/guide/howto.md`: a subsection "See all your machines" with `mesh machines` (`mesh fleet`, `--json`), `mesh machine name <nickname> [--machine …]`, `--clear`, TUI `m`, web **Mine**, and `workspaceRoots` in `daemon.json` for the inventory.
- `src/protocol/skill.ts` `MESH_SKILL`:
  - Change "gives you eight tools" to "nine tools".
  - Add a short section or bullet: `mesh_fleet` lists every machine logged in as your user and what each session does (read-only). The person's CLI is `mesh machines`.
  - Then run `pnpm schemas` to regenerate `skills/mesh/SKILL.md`.
- `docs/plan/implementation-plan.md` §5.6: add a row `GET /v1/fleet`, `POST /v1/machines/:id/name` — My mesh (v0.1.9).
- `docs/events.md` "Written by the hub": add a row `machine.named` | a machine was named or its name cleared | `machine`, `nickname`.
- The text must stay generic: no team, company or person names, and example repos only as `example.org/team/...`.

Order: after the behaviour is final. The skill comes before `pnpm schemas`.

Blast radius: docs only, plus the generated skill file (checked by `test/schemas.test.ts`).

## AC-26 Version 0.1.9 and `pnpm check`

Files:
- `package.json`: `"version": "0.1.9"`.
- The boundaries already hold:
  - `sessionVisible` and `renderFleet` are in `src/core`, which imports only protocol.
  - `scanRepos` is in `src/daemon` and uses `node:fs` only, with no `child_process`.
  - The CLI imports core and protocol only.
  - The hub imports core, protocol and store.

Run, with `/home/ghost2/.cache/node/corepack/v1/pnpm/12.16.1/pnpm`: `install --frozen-lockfile --prefer-offline` (fresh worktree), `schemas`, `lint`, `typecheck`, `boundaries`, `test`, `build` (or `check` for all five). `pnpm test:web` (Playwright) is not part of `check`. Run it if browsers are available, and otherwise state that it was not run.

Order: last.

Risks:
- Lint rules on the new files (unused imports, `any`).
- Postgres legs run only with `MESH_TEST_PG_URL` set. State whether they ran.

## AC-27 A `me` daemon sends no-step sessions only after hub confirmation

Files: `src/daemon/hub-link.ts` (the confirmation logic is spelled out in AC-16).

The rule is restated here so the criterion has its own section:
- `effective = share === "me" && !confirmed ? "steps" : share`, computed before each `POST /v1/sync` in the batch loop.
- `confirmed = reply.share !== undefined` after every successful sync, so a reply without `share` makes the level unconfirmed again.
- The log line `the hub does not support share level me; sending step holders only` appears once per credentials key (`warnedUnconfirmed`, reset in `factsFor`).
- `all` and `steps` ignore `confirmed`, so `all` keeps sending no-step sessions to old hubs (v0.1.7 behaviour).
- After a credentials switch, `factsFor` resets `confirmed`. The first sync for the new key sends step holders only, because `effective` is computed before that sync's reply.

Order: with AC-03 and AC-16.

Blast radius: daemon sync behaviour for `me` only.

Risks:
- The first sync of a fresh `me` daemon never carries no-step sessions, even to a v0.1.9 hub. They follow on the next flush, which runs often.
- During a rolling hub upgrade, a confirmed `me` daemon can reach an old replica. This is accepted in Open questions.

## AC-28 `POST /v1/sync` replies with `share`

Files: `src/hub/service.ts` `sync`.

Changes:
- The return type becomes `Promise<SyncResponse>`.
- After `touchMachine(machine, now, req.counts, req.machine ? { share: req.machine.share, ...(req.machine.repos ? { repos: req.machine.repos } : {}) } : undefined)`, read `const m = await this.store.getMachine(machine)`.
- Return `{ accepted, ...(m?.share ? { share: m.share } : {}) }`. When nothing is stored, the key is absent, never `null`.
- `src/hub/app.ts` route unchanged: it returns `c.json(...)` of the result.

Order: after AC-05 and AC-06.

Blast radius: the sync reply shape gains an optional key, which older daemons ignore.

Risks: none.

## AC-29 `POST /v1/messages` does not reach a hidden session

Files: `src/hub/service.ts` `say`.

Changes:
- Inside the transaction, when `input.toSid` is given, before `this.message(...)`:
  ```ts
  const hs = await this.store.getSession(input.toSid);
  if (hs) {
    const share = (await this.store.getMachine(hs.machineId))?.share;
    if (!sessionVisible(actor.userId, { userId: hs.userId, step: hs.session.step }, share)) throw new HubError(404, `session ${input.toSid} is not live on any machine`);
  }
  ```
  Nothing is queued, and no `message.sent` event is emitted.
- The `toStep` path resolves to the step's holder session, which holds a step and is visible. Leave it unchanged.
- Other internal `message()` callers (plan approvals, answers, takes) are hub-originated, not person-to-session, and are out of scope. Leave them unchanged.

Order: after AC-08 and AC-05.

Blast radius: `mesh say` / web / TUI messaging to other people's no-step sessions on non-`all` machines now answers 404. The owner and step-holder paths are unchanged.

Risks: none beyond the intended refusal.

## AC-30 Under `steps` no repo inventory is sent

Files: `src/daemon/daemon.ts` `machineRepos()` (AC-15) returns `[]` for `steps` without scanning and without session repos. `src/daemon/hub-link.ts` (AC-16) sends `machine.repos: []` on the first sync for the credentials and afterwards only on change. Every `repos` sent under `steps` is therefore `[]`.

`syncedSessions(all, "steps")` sends step holders only. A no-step session in repo `beta` is never in a body, and `counts` carries no repo names.

Order: with AC-15 and AC-16.

Blast radius: none beyond AC-15.

Risks:
- A step holder's own full record carries its `repo`. If such a session's repo were `beta`, the body would contain `beta`, and that is correct behaviour: the criterion's session is a no-step one.
- The daemon's `sessions()` excludes hidden sessions as today.

---

## Existing tests and generated files the developer adjusts

Only these. Each one asserts behaviour the spec changes:

| File | Change | Why |
|---|---|---|
| `src/daemon/hub-link.test.ts` (`syncedSessions (Q5)` block, 3 calls) | `syncedSessions(x, false)` becomes `syncedSessions(x, "steps")`, and `syncedSessions(x, true)` becomes `syncedSessions(x, "all")`. Assertions unchanged. | The signature changes from boolean to `ShareLevel` (AC-03). |
| `test/m2-flow.test.ts` ("exposes the eight tools …") | Add `"mesh_fleet"` to the sorted expected tool list. Rename the title to "nine tools". | A new MCP tool (AC-20). |
| `src/cli/tui/__snapshots__/render.test.ts.snap` (`render > renders the list (snapshot) 1`) | Regenerate with `vitest -u src/cli/tui/render.test.ts`. The only diff is the footer gaining ` · m machines`. | Footer contract (AC-22). |
| `schemas/hub-api.openapi.json` | Regenerate with `pnpm schemas`. | New routes, new `SyncRequest.machine` (AC-24). |
| `skills/mesh/SKILL.md` | Regenerate with `pnpm schemas`. | `MESH_SKILL` text (AC-25). |

The developer does not change these files:
- `test/schemas.test.ts`: the route comparison extension to `method path rule scope` belongs to the test side.
- `test/helpers/world.ts`: the `hostname`, `install` and `workspaceRoots` options belong to the test side.
- `test/share-sessions.test.ts`: it must pass unchanged, and a failure there is an implementation regression.
- `test/m46-ops.test.ts`: it uses `HubStore.SCHEMA_VERSION` symbolically, so it needs no change.
- DaemonConfig literals in `test/opencode.test.ts`, `src/daemon/daemon.test.ts` and `test/m2-flow.test.ts`: `"steps"` is still valid.
