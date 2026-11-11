# Spec MM-1: My mesh: every machine logged in as me and what each session does (read-only)

## Status
Draft (revision 3: review r2 blockers B1, B2 fixed. Revision 2: review r1 blockers B1, B2 fixed; suggestions S2-S9, S11-S13 taken; S1, S10 recorded in Open questions)

Source: `docs/analysis/2026-11-11-my-mesh-and-assign.md`, section "MM-1: My mesh (read-only)". Release v0.1.9.

## Problem

One person often runs mesh on several machines. The hub knows each machine (a mesh installation,
v0.1.5), but it shows a session without a step only when its machine shares it with the whole team
(`shareSessions: all`, v0.1.7). A person cannot see, in one place, every machine logged in as them and
what each session on it is doing, unless they also show those sessions to the whole team. Machines
have no short name, and nobody can tell which repos a machine has checked out.

## Scope

In:
- A third share level `me`: sessions without a step are synced as metadata and shown only to their
  owner. `mesh setup` writes `me` for new setups; existing configs keep their value.
- The daemon reports its share level and a repo inventory (ids and names only) to the hub with sync.
- The hub stores per machine: share level, nickname, repo inventory (one schema migration, SQLite and
  Postgres), and applies one session-visibility rule wherever it lists sessions (`/v1/live`, `/v1/fleet`).
- `GET /v1/fleet`, `POST /v1/machines/:id/name`.
- `POST /v1/sync` confirms the stored share level, so a daemon sends no-step sessions under `me` only to a hub that applies the rule; `POST /v1/messages` does not reach a session the caller cannot see.
- CLI `mesh machines` (alias `mesh fleet`, `--json`), `mesh machine name`; TUI panel **My machines**
  (key `m`); web **Mine** tab; MCP tool `mesh_fleet`.
- Docs: install guide, concepts, how-to, the mesh skill, the plan API table, the events list.

Out:
- Session and machine labels (MM-2), offers, accept policy and `assignments` (MM-3), suggest (MM-4).
  The machine record must take further fields later without another rename (see note below), but no
  label or accept field is added, accepted or shown in this row.
- Renaming a machine from the web. Attaching to a remote session. Any write to another machine's sessions.
- Admins seeing other people's `me` sessions (see Open questions).

Implementer note (not a contract): keep the new per-machine data extensible, e.g. a `share` and a
`nickname` column plus one JSON column for the rest (repos now; labels and accept later), so MM-2 and
MM-3 add fields without a column rename.

## Interface contracts

### Types (src/protocol)

| Interface | Type | Change |
|---|---|---|
| `ShareLevel` (src/protocol/config.ts, exported from `src/protocol/index.ts`) | zod enum + type | New: `z.enum(["steps", "me", "all"])`. |
| `DaemonConfig.shareSessions` (src/protocol/config.ts) | zod field | Now `ShareLevel.default("steps")`. A `daemon.json` without the field still parses as `steps` (existing configs keep their meaning). |
| `newConfig()` (src/cli/context.ts) | function | Returns `shareSessions: "me"`. |
| `NICKNAME_RE` (src/protocol/hub.ts) | `RegExp` | New: `/^[a-z0-9][a-z0-9-]{0,31}$/`. |
| `SyncRequest.machine` (src/protocol/hub.ts) | zod field | New, optional: `{ share: ShareLevel; repos?: Repo[] (max 500) }`. Absent (an older daemon): the hub keeps what it has. `repos` absent: inventory unchanged; present: replaces it. |
| `SyncResponse` (src/protocol/hub.ts) | interface | New: `{ accepted: number; share?: ShareLevel }`. `share` is the level the hub has stored for the token's machine after this sync (absent when none was ever reported). Its presence is how a daemon knows the hub applies the visibility rule; a hub older than v0.1.9 answers `{ accepted }` only. |
| `MachineName` (src/protocol/hub.ts) | zod schema | New: `{ nickname: string matching NICKNAME_RE, or null }`. A nickname of the form `m-` + 8 lowercase hex digits (a machine id) is refused. |
| `LiveMachine` (src/protocol/hub.ts) | interface | Gains `nickname?: string`. |
| `FleetSession` (src/protocol/hub.ts) | interface | New: `LiveSession & { lastEventAt: number }`. |
| `FleetMachine` (src/protocol/hub.ts) | interface | New: `{ id; hostname; nickname?; online: boolean; lastSeen: number; counts: Record<string, number>; share?: ShareLevel; repos: Repo[]; reposAt?: number; current: boolean; sessions: FleetSession[] }`. `share` absent: the machine's daemon never reported one. `repos` is `[]` when none reported. `current`: this is the machine of the calling token. |
| `FleetView` (src/protocol/hub.ts) | interface | New: `{ now: number; user: UserView; machines: FleetMachine[] }`. |
| `TOOLS.mesh_fleet` (src/protocol/tools.ts) | MCP tool | New, no input. Description: "Every machine logged in as your user and what each session on it is doing (read-only)." |

### Visibility rule (src/core/visibility.ts, exported from `src/core/index.ts`)

```ts
export function sessionVisible(viewerId: string, s: { userId: string; step?: string | undefined }, share: ShareLevel | undefined): boolean
```
True when `s.userId === viewerId`, or `s.step` is set, or `share === "all"`. Otherwise false
(`share` `steps`, `me`, or absent). `share` is the stored share level of the session's machine.
The hub uses only this function to decide which sessions `/v1/live` and `/v1/fleet` list.

### Hub store (src/store/hub-store.ts)

| Interface | Type | Change |
|---|---|---|
| `HUB_MIGRATIONS`, `HUB_MIGRATIONS_PG` | migrations | Exactly one new entry each (same length on both). `HubStore.SCHEMA_VERSION` = 6. |
| `MachineRow` | interface | Gains optional `share?: ShareLevel`, `nickname?: string`, `repos?: Repo[]`, `reposAt?: number`; each is absent (not `undefined`-valued, not null) when unset, so a machine row from before this row compares equal to `{ id, userId, hostname, lastSeen, counts }`. |
| `touchMachine(id, now, counts, facts?)` | method | New optional `facts: { share?: ShareLevel; repos?: Repo[] }`; a given `share` is stored; given `repos` replace the inventory and set `reposAt = now`. Without `facts` it behaves as today. |
| `setMachineNickname(id: string, nickname: string \| undefined): Promise<boolean>` | method | New. Sets or clears the nickname. Returns `false` (and changes nothing) when another machine of the same user already has that nickname. Two users may use the same nickname. It runs in the caller's transaction (its own when none) and never relies on a constraint error (on Postgres a failed statement aborts the whole transaction): it first takes the store's write lock (`serialize()`, the `events` lock; a no-op on SQLite, where `BEGIN IMMEDIATE` already serialises), then looks for another machine of the same user with that nickname and returns `false` without writing when there is one, else sets it. A unique index on `(user_id, nickname)` in the new migration (NULL allowed on many rows on both engines) stays as a backstop only. An unknown id changes nothing and returns `true` (the service answers 404 before calling it). |

### Hub HTTP API (src/hub/app.ts, listed in `HUB_API` in src/protocol/hub-api.ts)

| Route | Rule | Behaviour |
|---|---|---|
| `POST /v1/sync` | member (device token) | Body may carry `machine` (above). Stores `share` and, when given, `repos` for the token's machine. Session upsert unchanged. 200 `SyncResponse` with `share` = the stored level (key absent when none stored). |
| `POST /v1/messages` | unchanged rule | A `toSid` naming a session that `sessionVisible(caller, session, machine.share)` hides answers the same 404 as an unknown sid (`session <sid> is not live on any machine`); nothing is queued. |
| `GET /v1/live` | member, scope `live:read` | `people[].sessions` lists only sessions for which `sessionVisible(viewer, session, machine.share)` is true. `people[].machines[]` carry `nickname` when set. Counts unchanged. A `live:read` service token is a viewer that owns no sessions. |
| `GET /v1/fleet` | member, scope `live:read`, tag `daemon` | 200 `FleetView` for the caller: all the caller's machines (none of another user's), each with all the caller's non-ended sessions on it whatever the share level (ended sessions are left out). Machines: online first (last seen less than 2 minutes ago, as in `/v1/live`), then by `lastSeen` descending, then by `id` ascending. Sessions in a machine: by `lastEventAt` descending, then by `sid` ascending. A session is listed with its last synced state even if its daemon has stopped reporting it (see Open questions). A caller without machines gets `machines: []`. |
| `POST /v1/machines/:id/name` | member (no service scope), tag `daemon` | Body `MachineName`. 200 `{ id, hostname, nickname? }` (no `nickname` key after clearing). 400 `{error}` for a nickname not matching `NICKNAME_RE` or shaped like a machine id. 404 `{error: "no machine <id>"}` for an unknown id. 403 `{error: "not your machine"}` for another user's machine (admins too). 409 `{error: "nickname <n> is already used by your machine <hostname> (<id>)"}`. On a change it records event `machine.named` (user = caller, payload `{ machine: <id>, nickname: <n> or null }`), which sends the SSE `changed` hint. Its `/v1/live` activity text (`describe()`): `named machine <hostname> <nickname>`, or `cleared the name of machine <hostname>`. |

`schemas/hub-api.openapi.json` (generated by `pnpm schemas`) lists both new routes.

### Daemon (src/daemon)

| Interface | Type | Change |
|---|---|---|
| `syncedSessions(all: readonly Session[], share: ShareLevel): Session[]` (hub-link.ts) | function | Replaces the boolean parameter. `steps`: step holders only. `me` and `all`: step holders first (full records), then the other sessions as `sessionMetadata` (unchanged), newest first; at most 200. |
| `HubLinkDeps` (hub-link.ts) | interface | `shareAll` is replaced by `share?: () => ShareLevel` (default `steps`) and `machineRepos?: () => Repo[]`. |
| Sync body | wire | Every `POST /v1/sync` carries `machine.share` = the configured level. `machine.repos` is carried on the first successful sync for the current credentials and afterwards only when the inventory differs from the last one the hub accepted for them. |
| Hub confirmation | behaviour | The sessions a sync sends are `syncedSessions(all, effective)`. `effective` is the configured level, except that a configured `me` counts as `steps` until the hub has confirmed it: the last `POST /v1/sync` reply for the current credentials carried `share`. A reply without `share` (a hub older than v0.1.9) makes the level unconfirmed again, and the daemon logs once per credentials `the hub does not support share level me; sending step holders only`. So a hub that does not apply the visibility rule never receives a no-step session from a `me` daemon. `all` and `steps` need no confirmation (`all` keeps the v0.1.7 behaviour on any hub). |
| Per-credentials memory | behaviour | The confirmed level and the last accepted inventory are remembered per credentials, keyed by hub URL + machine id. When `HubLink.credentials()` returns another hub URL or machine id (`mesh logout` / `mesh login` while the daemon runs), both are forgotten: the next successful sync carries `repos`, and `me` is unconfirmed until that hub's reply carries `share`. |
| `scanRepos(roots: readonly string[]): Repo[]` (src/daemon/repos.ts) | function | New. For each root (a leading `~` means the home folder): the root, its child folders and their child folders (depth 2) that are git checkouts (`.git` folder or file). Folders whose name starts with `.` and `node_modules` are skipped; it does not descend into a checkout. The repo is `repoForCwd(dir)` (origin, else first remote). Checkouts without a remote and ids starting with `local/` (a file path) are left out. Missing or unreadable roots are ignored. Deduplicated by id, sorted by `name` then `id`, at most 500. |
| `REPO_SCAN_MS` (src/daemon/repos.ts) | const | New: `300_000`. The daemon rescans at most once per this interval. |
| Inventory | behaviour | Configured level `me` or `all`: `scanRepos(config.workspaceRoots)` united with the repos of the daemon's non-ended sessions (same `local/` exclusion), deduplicated, sorted, at most 500. Configured level `steps`: always empty (no scan, no session repos), so `steps` sends nothing beyond today's step holders and counts; the empty list is sent under the same rule as any inventory (first sync for the credentials, then on change), which clears an inventory stored under an earlier level. Never contains a path. |
| `GET /local/fleet` (daemon local API) | route | New: the hub's `GET /v1/fleet` as is. 409 `{error: "not logged in to a hub; run: mesh login"}` without credentials (same as `/local/goals`). |
| `DaemonClient.fleet(): Promise<FleetView>` (src/cli/client.ts) | method | New. |
| `mesh_fleet` tool (src/daemon/tools.ts) | MCP | Returns `renderFleet(view)` for `GET /v1/fleet`. Offline hub: an error result with the existing offline text. |

### Rendering (src/core/fleet.ts, exported from `src/core/index.ts`)

```ts
export function renderFleet(view: FleetView, opts?: { skipCurrent?: boolean }): string
```
Uses `view.now` for ages; age format as the TUI's (`45s`, `3m`, `2h`, `3d`: seconds under 60 s,
minutes under 60 m, hours under 48 h, else days). One block per machine, blocks separated by one empty line:

```
<title> · <presence> · share <share> · <n> repo|repos[ · this machine]
  <repo> · <name> · <state> · <step> · <age>
```
- `<title>`: `<nickname> (<hostname>)` when the machine has a nickname, else `<hostname>`.
- `<presence>`: `online`, or `last seen <age> ago` (age of `now - lastSeen`).
- `<share>`: the level, or `?` when absent. `repo` when n = 1, else `repos`. ` · this machine` when `current`.
- Session line: `<repo>` = repo name or `-`; `<name>` = session name, else the first 8 characters of the sid;
  `<state>` = state, followed by ` (<needs>)` when `needs` is set; `<step>` = step id or `no step`;
  `<age>` = age of `now - lastEventAt`.
- A machine without sessions has the line `  no sessions`.
- `skipCurrent`: leave out the `current` machine.
- No machines (after `skipCurrent`): the single line `No machines logged in as you yet. Run mesh login on each machine.`

### CLI

| Command | Behaviour |
|---|---|
| `mesh setup [--share-sessions steps\|me\|all]` (`--share` is an alias) | Other value: stderr `--share-sessions must be steps, me or all`, exit 2. A new config gets `me` unless a level is given; an existing config keeps its level unless one is given. The output line for the level now in effect is printed when a level is given or a new config is written: `steps`: "Only sessions holding a step will be reported to the hub. Restart the daemon to apply."; `me`: "Sessions without a step will be reported to the hub as metadata that only you can see (state, repo, name, times; no paths or text). Restart the daemon to apply."; `all`: unchanged v0.1.7 text. |
| `mesh machines [--json]`, `mesh fleet [--json]` | Calls `GET /v1/fleet`; prints `renderFleet(view)`; exit 0. `--json`: prints the `FleetView` as `JSON.stringify(view, null, 2)`. Both commands appear in `mesh help`. Not logged in: stderr `not logged in to a hub; run: mesh login`, exit 1. |
| `mesh machine name <nickname> [--machine <id\|nickname\|hostname>]` | A nickname not matching `NICKNAME_RE`, or shaped like a machine id, is refused before any hub call: stderr `nickname must match [a-z0-9][a-z0-9-]{0,31} and not look like a machine id`, exit 2. Without `--machine`: the machine in this installation's credentials (`machine`); none: stderr `this installation has no machine on the hub; run: mesh login`, exit 1. `--machine` is resolved among the caller's machines from `GET /v1/fleet`: exact id, else nickname, else hostname; none: stderr `no machine of yours matches "<x>"`, exit 1; several by hostname: stderr `"<x>" matches several of your machines: <id>, <id>; use the id`, exit 1. Success: stdout `Named <hostname> (<id>) <nickname>.`, exit 0. Hub error (400/409): its `error` text on stderr, exit 1. |
| `mesh machine name --clear [--machine …]` | Clears; stdout `Cleared the nickname of <hostname> (<id>).`, exit 0. |
| `mesh machine` (no or wrong subcommand / no nickname and no `--clear`) | Usage on stderr starting with `usage:` and containing `mesh machine name <nickname>`, exit 2. |

### TUI (src/cli/tui)

| Interface | Change |
|---|---|
| `renderMachines(fleet: FleetView, v: { width: number; height: number; header: string; status?: string }): string[]` (render.ts) | New. Lines: header, empty line, `MY MACHINES`, then the lines of `renderFleet(fleet, { skipCurrent: true })` each indented by two spaces (or `  No other machines. Run mesh login on your other machines.` when none), padded to `height`; last line the footer `m back to sessions · g goals · details: mesh machines`; the status, when given, is the line just above the footer (on purpose unlike `renderGoals`: the footer stays the last line). Every line at most `width` visible characters (ANSI codes not counted). |
| Session list footer (`render`) | Contains `m machines`. |
| Key `m` (tui.ts) | Toggles the My machines panel (data from `DaemonClient.fleet()`, refreshed every 5 s while open); from the goals view it switches to the panel. Key `g` in the panel switches to the goals view. In the panel the session keys (⏎, s, a, n) do nothing. A fetch error shows as the status line. |

### Web (web/src)

| Interface | Change |
|---|---|
| `api.fleet(): Promise<FleetView>` (api.ts) | New: `GET /v1/fleet`. |
| Nav link **Mine** → `#/mine` (main.tsx) | New page: one `section.machine` per machine with the title (nickname and hostname), online / last seen, share level, repo count and a table of its sessions (repo, name, state, step, age); an empty machine says "no sessions"; no machines: "No machines logged in as you yet. Run mesh login on each machine." Refetches `/v1/fleet` after an SSE `changed` hint (same debounce as Live) and every 15 s. |

### Docs

| File | Change |
|---|---|
| `docs/guide/install.md` "What the hub sees" | Three levels `steps`, `me` (default for new setups), `all`; who sees what; `mesh setup --share-sessions me`. Upgrade every hub replica to v0.1.9 before the daemons; until its hub confirms `me`, a `me` daemon sends step holders only. A v0.1.7/v0.1.8 daemon set to `all` shows its no-step sessions to its owner only until it is updated. What each level sends: `steps` the step holders, counts and the level, no repo inventory; `me` and `all` also the no-step sessions as metadata and the repo inventory (ids and names of the repos under `workspaceRoots` and of current sessions). |
| `docs/guide/concepts.md` | Machine nickname, share levels, repo inventory (ids and names only, from `workspaceRoots` and current sessions; none under `steps`), "My mesh". |
| `docs/guide/howto.md` | A subsection "See all your machines": `mesh machines`, `mesh machine name`, TUI `m`, web Mine, `workspaceRoots` for the inventory. |
| `src/protocol/skill.ts` `MESH_SKILL` and generated `skills/mesh/SKILL.md` | Mention `mesh_fleet` and `mesh machines`. |
| `docs/plan/implementation-plan.md` §5.6 | A row: `GET /v1/fleet`, `POST /v1/machines/:id/name` — My mesh (v0.1.9). |
| `docs/events.md` | Row `machine.named` (a machine was named or its name cleared; payload `machine`, `nickname`). |
## Acceptance criteria

Surfaces: `HubStore` contract test (`src/store/hub-store.contract.test.ts`, SQLite always, Postgres when its URL is set); World tests (`test/helpers/world.ts`: real hub + daemons over HTTP); unit tests; Playwright (`pnpm test:web`, not part of `pnpm check`).

World helper changes the test side owns: `World.person(name, repo, opts)` gains options `hostname`, `install` (install id) and `workspaceRoots`, and may be called more than once for one user (each call a separate machine with its own install id). AC-11, AC-15 and AC-19 need them.

| Id | Criterion | Surface | What exact state makes it FAIL? |
|---|---|---|---|
| AC-01 | `DaemonConfig` accepts `shareSessions` `steps`, `me`, `all`; a config without the field parses as `steps`; `newConfig()` returns `me`. | unit (`src/protocol/config.test.ts`) | `"me"` rejected, a field-less config parses to anything but `steps`, or `newConfig().shareSessions !== "me"`. |
| AC-02 | `mesh setup` on a fresh config dir writes `shareSessions: "me"` and prints the `me` line; on an existing config with `steps` (or no field) it leaves the level alone; `--share-sessions all` / `--share all` set `all`; `--share-sessions nope` exits 2 with `--share-sessions must be steps, me or all`. | CLI (`test/cli.test.ts`) | Any of: a fresh daemon.json without `me`, an existing level changed without a flag, the alias ignored, or another exit code/message. |
| AC-03 | `syncedSessions(all, "steps")` returns only step holders; with `"me"` and `"all"` it returns step holders first then metadata-only records of the rest (no `cwd` text, `pane`, `pid`, `transcriptPath`, `lastMessage`), at most 200. | unit (`src/daemon/hub-link.test.ts`) | A no-step session sent with `steps`, missing with `me`, a full record of a no-step session, or a step holder dropped by the cap. |
| AC-04 | Every sync carries `machine.share` equal to the daemon's config; after a sync the hub's `MachineRow.share` equals it. | World | `machine` missing from the sync body, or `GET /v1/fleet` shows another `share` for that machine after `w.flush()`. |
| AC-05 | `HubStore.SCHEMA_VERSION` is 6; `HUB_MIGRATIONS.length === HUB_MIGRATIONS_PG.length`; `/readyz` reports schema 6; a machine row without the new data compares equal to `{ id, userId, hostname, lastSeen, counts }`. | contract test (compared with `toStrictEqual`), `test/m46-ops.test.ts` | Version not 6, lengths differ, or a fresh machine row has extra keys (`share: undefined`, `nickname: null`, `repos: []`, …). |
| AC-06 | `touchMachine(id, now, counts, { share, repos })` stores both and `reposAt = now`; a later `touchMachine` without `repos` keeps the inventory; with `repos` replaces it. | contract test (SQLite and Postgres) | Inventory lost on a plain touch, not replaced, or `reposAt` wrong. |
| AC-07 | `setMachineNickname` sets and clears; a second machine of the same user with the same nickname gets `false` and keeps its nickname; another user's machine may use it; two concurrent calls giving two machines of one user the same nickname leave exactly one with it (one `true`, one `false`); an unknown id returns `true` and no row changes. | contract test (SQLite and Postgres) | Duplicate allowed within a user (also when concurrent), refused across users, the clash changed a row, or an unknown id created or changed a row. |
| AC-08 | `sessionVisible`: owner always true; a session with a step true for anyone; without a step true only when share is `all`; false for `steps`, `me` and absent share. | unit (`src/core/visibility.test.ts`) | Any of these six cases gives the other answer. |
| AC-09 | `/v1/live`: bob on a machine with `me` has an idle session without a step; alice's `/v1/live` lists no session of bob (bob's machine counts still show it); bob's `/v1/live` lists it; a `live:read` service token does not list it. | World (`test/share-sessions.test.ts` or a new file) | The session appears for alice or the service token, is missing for bob, or bob's counts lack it. |
| AC-10 | `/v1/live` regressions: a session holding a step is listed for every member whatever the share level; with `all` (v0.1.7 test) a no-step session is listed for others and for a `live:read` service token; a machine that never reported a share shows its no-step sessions to its owner only. | World | Any of the three listings differs. |
| AC-11 | `GET /v1/fleet` for a user with two machines returns both (and no other user's), each with that user's non-ended sessions on it (including no-step sessions synced with `me`), `current: true` only for the token's machine, online machine before offline, sessions by `lastEventAt` descending, `repos: []` before any inventory. | World | A missing or foreign machine, a missing own session, an ended session listed, wrong `current`, or wrong order (ties: machine `id`, session `sid` ascending). |
| AC-12 | `GET /v1/fleet` with a `live:read` service token returns 200 `machines: []`; without the scope 403; without a token 401. | World / hub test | Other status codes or a non-empty list. |
| AC-13 | `POST /v1/machines/:id/name`: owner sets `m2` → 200 `{id, hostname, nickname: "m2"}` and `/v1/fleet` and `/v1/live` show it, and `/v1/live` activity shows `named machine <hostname> m2` (after clearing: `cleared the name of machine <hostname>`); `null` clears (no `nickname` key); `M2`, `-x`, a 33-char name and `m-0a1b2c3d` → 400; unknown id → 404 `no machine <id>`; another user's machine (also as admin) → 403 `not your machine`; same nickname on the owner's other machine → 409 with `nickname m2 is already used by your machine <hostname> (<id>)`; two concurrent requests giving the same nickname to two machines of one user answer one 200 and one 409 (never 500); a `machine.named` event with payload `{machine, nickname}` is recorded on each change. | World / hub test (the concurrent case also on Postgres when its URL is set) | Any status, body or message differs, the concurrent pair answers anything but one 200 and one 409, or no event. |
| AC-14 | `scanRepos` over a temp tree finds checkouts at depth 0, 1 and 2 (a `.git` folder or a worktree's `.git` file), not at depth 3, not inside `.hidden` or `node_modules`, not nested inside a found checkout; skips checkouts without a remote and `file://` / absolute-path remotes; dedupes two clones of one remote (HTTPS and SSH); sorts by name; ignores a missing root; expands `~`. | unit (`src/daemon/repos.test.ts`) | Any listed case differs, or any returned value contains a `/`-rooted path or the temp dir name outside a remote id. |
| AC-15 | The daemon's inventory reaches the hub: with `shareSessions: "me"`, `workspaceRoots` pointing at a temp tree with a checkout of `example.org/team/alpha`, and a session in repo `beta`, `GET /v1/fleet` shows `repos` containing both ids (and names), `reposAt` set, and no path anywhere in the machine record. | World | A repo missing, a path present, or `reposAt` absent. |
| AC-16 | Repos are re-sent only on change: the first sync of a daemon process carries `machine.repos`; a second sync with the same inventory does not; after a new checkout appears and `REPO_SCAN_MS` has passed (injected clock) the next sync carries the new list; within `REPO_SCAN_MS` the folders are not rescanned; after the credentials switch to another hub URL or machine id (same inventory), the next sync carries `repos` again. | unit (`src/daemon/hub-link.test.ts` / daemon test with a fake fetch) | `repos` sent on every sync, never re-sent after a change, not sent after a credentials switch, or a rescan before the interval. |
| AC-17 | `renderFleet` produces exactly the documented lines for: a machine with nickname, online, `share me`, 1 repo, `current`; an offline machine without nickname, share absent (`share ?`), 3 repos, last seen 2 h ago, no sessions (`  no sessions`); sessions with and without repo/name/step/needs; `skipCurrent`; an empty fleet. | unit (`src/core/fleet.test.ts`) | Any character of the output differs. |
| AC-18 | `mesh machines` and `mesh fleet` print `renderFleet` of the hub's view, exit 0; `--json` prints the `FleetView` JSON that parses to the same object as `GET /v1/fleet`; both are listed by `mesh help`. | World / CLI | Output differs between the two commands, JSON not parseable or different, or missing from help. |
| AC-19 | `mesh machine name m2` names the machine of this installation (stdout `Named <hostname> (<id>) m2.`); `mesh machine name M2` exits 2 with `nickname must match [a-z0-9][a-z0-9-]{0,31} and not look like a machine id` and makes no hub call; `mesh machines` without a login exits 1 with `not logged in to a hub; run: mesh login`; `--machine <hostname of my other machine>` names that one; `--machine nope` → exit 1 `no machine of yours matches "nope"`; a hostname shared by two of my machines → exit 1 with `matches several of your machines`; `--clear` → `Cleared the nickname of …`; a clash → exit 1 with the hub's 409 text; no args → exit 2 usage. | World / CLI | Wrong machine named, other messages or exit codes. |
| AC-20 | MCP `mesh_fleet` (no args) returns the same text `mesh machines` prints for the same hub state; with the hub offline it returns an error result containing the existing offline text. | World (`test/m2-flow.test.ts` style) / daemon test | Text differs, tool not listed by the shim, or offline gives success. |
| AC-21 | `GET /local/fleet` returns the hub's fleet; without credentials 409 `not logged in to a hub; run: mesh login`. | daemon test | Other status or body. |
| AC-22 | `renderMachines` shows `MY MACHINES`, leaves out the current machine, shows the empty text when only the current machine exists, ends with the footer `m back to sessions · g goals · details: mesh machines`, puts a given status on the line just above it, returns exactly `height` lines none longer than `width` visible characters; the session list footer contains `m machines`. | unit (`src/cli/tui/render.test.ts`) | Current machine shown, wrong footer or status position, wrong line count or width. |
| AC-23 | The web Mine tab (`#/mine`) shows the signed-in user's machines with nickname/hostname and their sessions, and another user's `me` session is not shown on Live; a new session synced while the page is open appears within 20 s without reload (a metadata-only sync sends no SSE hint, so the 15 s poll is the bound). | Playwright (`test/e2e-web`) | Tab missing, a machine or session missing, the other user's `me` session visible on Live, or the new session not shown within 20 s without reload. |
| AC-24 | `schemas/hub-api.openapi.json` matches `pnpm schemas` output and lists `GET /v1/fleet` (with the `live:read` scope note) and `POST /v1/machines/{id}/name`; `HUB_API` matches the routes `src/hub/app.ts` serves. | `test/schemas.test.ts` (the route-table comparison extended to `method path rule scope`), hub route test | Generated file stale, routes missing, or rule/scope mismatch. |
| AC-25 | Docs: install guide lists `steps`, `me`, `all` with `me` the default for new setups; concepts and how-to describe `mesh machines`, `mesh machine name`, TUI `m`, web Mine and the inventory; plan §5.6 lists both routes; `docs/events.md` lists `machine.named`; `MESH_SKILL` and `skills/mesh/SKILL.md` mention `mesh_fleet` and are equal. | `test/schemas.test.ts` (skill), review | Any of these missing, or the skill file differs from `MESH_SKILL`. |
| AC-26 | `package.json` version is `0.1.9`; `pnpm check` passes (lint, typecheck, boundaries, test, build); new code respects the module boundaries (`renderFleet` and `sessionVisible` in `src/core`, the scan in `src/daemon` without spawning processes). | `pnpm check` | Any check fails, or the version is not 0.1.9. |
| AC-27 | A `me` daemon never sends a no-step session to a hub that has not confirmed `me`: with a fake fetch answering `POST /v1/sync` `{accepted: 0}` (no `share`), no sync body over several syncs contains a session without a step, every body carries `machine.share: "me"`, and `the hub does not support share level me; sending step holders only` is logged exactly once; once a reply carries `share: "me"`, the next sync includes the no-step sessions; after a credentials switch the first sync again sends step holders only. With `all` a no-step session is sent even when no reply carries `share`. | unit (`src/daemon/hub-link.test.ts` with a fake fetch) | A no-step session in any body before confirmation or right after a switch, the log missing or repeated, no-step sessions still missing after confirmation, or `all` withheld. |
| AC-28 | `POST /v1/sync` replies `{accepted, share}` with the stored level after a body with `machine.share`, and without a `share` key for a machine that never reported one. | World / hub test | `share` missing, different from the stored level, or present (e.g. `null`) for a machine without one. |
| AC-29 | `POST /v1/messages` from alice with `toSid` = bob's no-step session on a `me` machine answers 404 `session <sid> is not live on any machine` and queues nothing; bob may message it (existing behaviour); a step holder's session stays reachable by alice. | World | Alice gets 201 or another error text, a message reaches bob's inbox, or bob/step-holder messaging breaks. |
| AC-30 | Under `steps` the daemon sends no repo inventory: with `shareSessions: "steps"`, `workspaceRoots` pointing at a temp tree with a checkout of `example.org/team/alpha`, and a no-step session in repo `beta` (not under `workspaceRoots`), no sync body contains `alpha` or `beta`, and every `machine.repos` sent is `[]`. | unit (daemon / `src/daemon/hub-link.test.ts` with a fake fetch) | Any sync body contains `alpha` or `beta`, or a non-empty `machine.repos`. |

## Open questions
- (2026-11-11) The design's MM-1 rule shows a no-step session to "its owner" only; its Safety section says "owner and admins". Assumed: owner only (the stricter reading); admins see `me` sessions only as counts. Revisit with MM-3 if admins need it.
- (2026-11-11) A machine whose daemon never reported a share level (older than v0.1.9) is treated like `steps`: its no-step sessions are shown to the owner only. A v0.1.7/v0.1.8 daemon set to `all` therefore stops showing no-step sessions to the team until it is updated. Assumed acceptable (privacy first); noted in the install guide. Lossless alternative (review r1 S10, not taken): an older daemon sends no-step sessions only under `all`, so "share absent" could be treated as `all` for such rows.
- (2026-11-11, review r1 B1) Rolling hub upgrade: a `me` daemon sends no-step sessions only after a sync reply carried `share`; during a rolling upgrade a later sync can still land on an old replica that stores them without the rule. Assumed: the install guide requires upgrading every hub replica before daemons; no further protection.
- (2026-11-11, review r1 S1) The hub never deletes session rows, so `/v1/fleet` can list a session the daemon stopped reporting (past the 200 cap, after a reinstall, or a released step on a `steps` machine) with its last state. Kept as is in this row (it shows its `lastEventAt` age); hiding sessions absent from the latest sync is a follow-up.
- (2026-11-11) The design says sync carries the nickname. Assumed: the hub is the only source of the nickname (`POST /v1/machines/:id/name`), sync does not carry it; a re-login of the same installation keeps its machine row and so its nickname.
- (2026-11-11) The design names `mesh setup --share steps|me|all`; the v0.1.7 flag is `--share-sessions`. Assumed: both are accepted, `--share-sessions` stays the documented one.
- (2026-11-11) Repo inventory roots: assumed `workspaceRoots` from daemon.json plus the repos of the daemon's current sessions, not the `mesh run` fallbacks (`~/src`, `~/code`, `~/work`, cwd), so a daemon scans only folders its person named. Depth 2 as `mesh run` resolution, at most 500 repos, rescan at most every 5 minutes.
- (2026-11-11) Fleet lists non-ended sessions only (the live view keeps ended ones for 10 minutes); session labels and the machine label/accept columns of the design's `mesh machines` layout arrive with MM-2 and MM-3.
- (2026-11-11) `POST /v1/machines/:id/name` takes a machine id only; the CLI resolves nicknames and hostnames. Only the owner may name a machine, admins included in the refusal.
