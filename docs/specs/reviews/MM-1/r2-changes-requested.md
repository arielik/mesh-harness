Verdict: CHANGES REQUESTED | Round: 2 | Blocking-open: 2

# Review of spec MM-1, round 2

Reviewed cold: `docs/specs/MM-1.md` (commit 69638e2, revision 2), against
`docs/analysis/2026-11-11-my-mesh-and-assign.md` (MM-1, Safety) and the code on `feat/my-mesh-assign`:
`src/protocol/{config,hub,hub-api,session}.ts`, `src/hub/{app,service}.ts` (`say`, `sync`, `live`,
`describe`, `machineFor`), `src/store/{hub-store,pg,db}.ts`, `src/daemon/{hub-link,daemon,git}.ts`,
`src/core/{roles,repo-id}.ts`, `src/cli/tui/render.ts`, `test/schemas.test.ts`,
`src/store/hub-store.contract.test.ts`, `test/helpers/world.ts`, `docs/guide/install.md`,
`docs/plan/implementation-plan.md` (Q5 row). Read first: `r1-changes-requested.md`.

## Round 1 follow-up

| r1 | State |
|---|---|
| B1 old hub sees `me` sessions | Fixed: `SyncResponse.share`, daemon confirmation per credentials, AC-27, AC-28, install-guide line. The rolling-upgrade residue is recorded in Open questions; acceptable. |
| B2 inventory not re-sent after a credentials switch | Fixed: per-credentials memory keyed by hub URL + machine id, AC-16 and AC-27 extended. |
| S1 stale sessions | Recorded in Open questions, stated in the `/v1/fleet` row. Fine. |
| S2 `/v1/messages` | Taken (route row, AC-29). The `toStep` path reaches only a step holder, so it stays reachable. |
| S3–S9, S11–S13 | Taken. S5 and S9 introduced the two regressions below. |
| S10 | Recorded as an alternative in Open questions. Fine. |

Scope: still no creep. `SyncResponse.share` and the `/v1/messages` 404 are the r1 fixes and trace to
the design's Safety section. Names are generic.

## Blockers

### B1 (NEW) Under `steps` the inventory sends the repos of private sessions to the hub

Decision wrong; breaks the existing privacy rule. The `Inventory` row is `scanRepos(workspaceRoots)`
united with "the repos of the daemon's non-ended sessions", and the `Sync body` row sends
`machine.repos` whatever the level. Today's rule for `steps` (`docs/plan/implementation-plan.md`, hub `session` row, Q5;
`docs/guide/install.md` "What the hub sees") is: "Other sessions stay on your machine; the hub sees
how many of them are in each state." Every existing config keeps `steps` on upgrade, so after
v0.1.9 a person who chose `steps` starts reporting the repo id and name of each session without a
step (and the repo list under any `workspaceRoots` they set for `mesh run`), without being told.
Owner-only visibility on `/v1/fleet` does not change what leaves the machine.

Fix in the contract, writer's choice, stated and tested:
- under `steps`, no `machine.repos` at all (fleet shows `repos: []`; the owner turns on `me` to get
  an inventory), or
- under `steps`, the inventory is the `workspaceRoots` scan plus the repos of step holders only (those
  are on the hub already), and the install guide says that `steps` now reports the repos under
  `workspaceRoots`.

Add an acceptance criterion on the daemon (unit, fake fetch): with `steps` and a no-step session in
repo `beta` (not under `workspaceRoots`), no sync body contains `beta`. Update the install-guide row
to say what each level sends, inventory included.

### B2 (REGRESSION-OF-OWN-REPAIR, from r1 S5) "A constraint error becomes `false`" aborts the transaction on Postgres

Decision wrong on one of the two engines. The `setMachineNickname` row relies on the unique index on
`(user_id, nickname)` raising and the store turning the error into `false`. The service will call it
inside `store.tx` (it answers 404 first and records `machine.named` in the same transaction). On
Postgres a failed statement inside `BEGIN` puts the transaction in the aborted state: the following
statements (the lookup for the 409 text, `appendEvent`) fail with "current transaction is aborted",
so the concurrent case answers 500, not 409. The store has no savepoint support (`src/store/pg.ts`)
and avoids raising constraint errors elsewhere (`ON CONFLICT … DO NOTHING`). AC-07 runs the store
outside a transaction, so it would pass while the HTTP path fails.

Fix: the service takes the store's write lock first (`serialize()`, the `events` lock every
goal/step writer takes; a no-op on SQLite where `BEGIN IMMEDIATE` already serialises), then looks for
a clash among the user's machines (it needs that machine's hostname and id for the 409 text anyway),
then sets. The unique index stays as a backstop. Say this in the row and drop "a constraint error
becomes `false`", or require a savepoint around the update. Add to AC-13: two concurrent
`POST /v1/machines/:id/name` with the same nickname on two machines of one user answer one 200 and
one 409 (World, and on Postgres when its URL is set).

## Suggestions (not blocking)

### S1 (REGRESSION-OF-OWN-REPAIR, from r1 S9) The activity text needs a hostname the event does not carry

`describe(type, subject, payload)` in `src/hub/service.ts` sees only the event's payload, and the
payload is `{ machine, nickname }`; `named machine <hostname> m2` needs the hostname. Either put
`hostname` in the payload (and in the `docs/events.md` row and AC-13's payload), or say that `live()`
looks the hostname up. As written, a blind test asserting the payload with `toEqual` and one
asserting the text can force contradictory implementations.

### S2 (NEW) Say which unit owns the rescan interval

`HubLinkDeps.machineRepos?: () => Repo[]` is a plain function, and `REPO_SCAN_MS` lives in
`repos.ts`. AC-16 asks a `hub-link.test.ts` / daemon test to prove "within `REPO_SCAN_MS` the folders
are not rescanned", but no interface says where the throttle sits or how a test injects the clock
and the scan. Name it, e.g. `repoInventory(deps: { roots, sessions, now, scan? })` in
`src/daemon/repos.ts` returning a cached list, and split AC-16 into the throttle (unit on that
function) and the "send on change / after a switch" part (hub-link with a fake `machineRepos`).

### S3 (NEW) AC-05 and machines with an install id

`MachineRow.installId` is set for every v0.1.5+ login. "A machine row without the new data compares
equal to `{ id, userId, hostname, lastSeen, counts }`" holds only for a row upserted without an
install id; say "(plus `installId` when one was given)" so the strict comparison is not misread.

### S4 (NEW) Offline hub for `/local/fleet`, `mesh machines` and the TUI panel

Only the no-credentials case is specified. State the offline answer (`/local/fleet`: 503 with the
existing offline text, as `rpc()` throws; `mesh machines`: that text on stderr, exit 1; TUI: the
status line), so AC-19/AC-21 can cover it.

### S5 (NEW) Age rounding

"Seconds under 60 s, minutes under 60 m, hours under 48 h" reads as truncation; the TUI's `age()`
rounds (`Math.round` at each unit, so 59.6 min prints `1h`). Say "rounded, same results as `age()` in
`src/cli/tui/render.ts`" so AC-17 fixtures at unit boundaries agree with the implementation.

## Checks

Spec review, no code changed. Not run: `pnpm lint`, `pnpm typecheck`, `pnpm boundaries`,
`pnpm test`, `pnpm build`, `pnpm check`, `pnpm schemas` (not needed for a document-only review). Every
claim above was checked by reading the code named at the top.
