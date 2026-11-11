Verdict: CHANGES REQUESTED | Round: 1 | Blocking-open: 1

# Review of the MM-1 diff, round 1

Reviewed cold: `git diff feat/my-mesh-assign...comb/MM-1` (merge 7d00f14 of the developer branch,
head 00abb21, and the test branch, head 72eb1ea) against `docs/specs/MM-1.md` (revision 3). Read
first: the spec rounds `r1-changes-requested.md`, `r2-changes-requested.md`, `r3-approved.md`. This
is the first diff round, so every finding is NEW.

## Checks run

All in a detached review worktree of `comb/MM-1` (scratch folder, removed afterwards), never in the
integration worktree.

| Check | Result |
|---|---|
| `pnpm check` | lint, typecheck, boundaries pass. test: 635 passed, 45 skipped, 1 failed: `test/cli.test.ts > mesh doctor > passes with hooks installed and the daemon running`, `EADDRINUSE 127.0.0.1:38899` (a fixed port held by another process on this host, not MM-1 code). `pnpm vitest run test/cli.test.ts` again: 27/27 pass. |
| `pnpm build` | pass (run on its own, since `pnpm check` stopped at the flaky test). |
| `pnpm schemas` | no change to `schemas/hub-api.openapi.json` (the committed file is current). |
| Postgres legs | `src/store/hub-store.contract.test.ts`, `test/my-mesh.test.ts`, `test/m46-ops.test.ts` with `MESH_TEST_PG_URL` at a local Postgres: 129/129 pass (AC-05, AC-06, AC-07 on both engines). |
| `pnpm test:web` (Playwright) | 12/12 pass, including the five `test_AC23_*`. |
| Fail-first | The changed test files run at the test-branch head 72eb1ea (base 0d81c78 + tests only): 127 tests fail, 3 files fail to import (`fleet.ts`, `visibility.ts`, `repos.ts` missing). Every criterion AC-01 … AC-30 has at least one test that failed first. `mine.spec.ts` on that base fails (its setup gets no route for `POST /v1/machines/:id/name`). |

Not run: the Postgres legs of the whole suite (`m46 replicas` and the rest with `MESH_TEST_PG_URL`);
only the three files above. `pnpm check` as one green run (blocked by the port clash; its parts were
run one by one).

## Rules

- Developer added no new test. It edited four existing ones (S1).
- Test-writer changed no product code: its commits touch only `*.test.ts`, `test/helpers/*`,
  `test/e2e-web/*`.
- No assertion on source text. `test/schemas.test.ts` reads docs, the skill file and the committed
  OpenAPI document, which AC-24/AC-25 name as their surface; the route table is compared through
  `createApp(...).routes`, not through source.
- Docs updated: install guide (three levels, upgrade order, inventory), concepts, how-to, the skill
  (both copies equal), plan §5.6, `docs/events.md`.
- Generic names in new product code and docs. New tests reuse two older repo names (S5).

## Correctness (checked, no defect found)

- Visibility: `sessionVisible` is the only rule. `/v1/live` filters by the stored share of each
  session's machine, `/v1/fleet` lists only the caller's machines and sessions, and `POST /v1/messages`
  with `toSid` answers the unknown-session 404 before anything is queued. A `toStep` target is always
  a step holder and so visible. A service token owns no sessions and gets `machines: []`.
- Hub confirmation: `HubLink.doFlush` sends `syncedSessions(all, "steps")` while `me` is unconfirmed.
  `confirmed` follows the latest reply, the log line is once per credentials, and `factsFor` resets
  `confirmed`, `sentRepos` and the warning on a hub URL or machine change. `sentRepos` is set only
  after a successful reply, so a failed sync re-sends the inventory.
- Inventory: under `steps`, `machineRepos()` returns `[]` with no scan. The scan reads `.git` through
  `repoForCwd` (no process spawned), skips hidden folders, `node_modules` and `local/` ids, and drops
  any field but `id` and `name`.
- Store: one migration on each engine (multi-statement strings work on both runners). A `NULL`
  nickname is allowed on many rows on both engines. `machineFrom` omits unset keys.
  `setMachineNickname` takes `serialize()` in the caller's transaction and never relies on the index.
  `renameMachine` takes the same lock before it reads, so the 409 lookup and the write are consistent.
- Idempotency: a sync is idempotent per event id (unchanged). Renaming to the current nickname returns
  200 with no event.

## Blockers

### B1 (NEW, test) AC-13's concurrent case is not proven on Postgres, and on SQLite it cannot fail

AC-13 names its surface "World / hub test (the concurrent case also on Postgres when its URL is set)".
`test_AC13_concurrent_200_and_409` (`test/my-mesh.test.ts:373`) runs only on the World hub, which is
always `db: ":memory:"` (`test/helpers/world.ts:71`). One in-memory SQLite connection runs every
request on one queue, so the two `POST /v1/machines/:id/name` calls never overlap. The test would
pass even if `renameMachine` took no lock. The engine where the race (and a 500 from a unique-index
violation that aborts the transaction) is real, Postgres, has no HTTP-level leg. AC-07 covers the
store method on Postgres, but not the service's lookup, the 409 mapping or the "never 500" part of
AC-13.

Expected: a Postgres leg of `test_AC13_concurrent_200_and_409`, run when `MESH_TEST_PG_URL` is set and
reported as skipped otherwise (as `m46-ops` does). It should start a hub on a fresh Postgres database,
register two machines of one user, and in each of 10 rounds send the two rename requests at once. The
sorted statuses must be `[200, 409]` every round, never 500, and exactly one machine may hold the
nickname afterwards.

## Suggestions (not blocking)

### S1 (NEW, process) The developer edited existing tests

The developer role says "never create or edit a test". Developer commits changed:
`src/daemon/hub-link.test.ts` (d5a493f, `syncedSessions(…, true/false)` → `"all"/"steps"`),
`test/hub.test.ts` (e2e298a, the message-routing test now syncs with `machine: { share: "all" }`),
`test/m2-flow.test.ts` (d3467ef, nine tools) and `src/cli/tui/__snapshots__/render.test.ts.snap`
(204ffa9, footer gains `m machines`). Each one follows from a spec contract (the `syncedSessions`
signature, AC-29, AC-20, AC-22). Each is explained in its commit message and checked correct here.
The `m2-flow` edit clashed with the test-writer's own edit in the merge. Expected: the implementation
plan lists existing tests that a contract change breaks, and the test-writer updates them.

### S2 (NEW, impl) `src/store/db.ts`: the process-wide SQLite turn queue

`queues` (keyed by resolved path) is never pruned. If a handle's transaction awaits a call on another
handle to the same file, the call waits behind that transaction on the shared queue and deadlocks.
Product code opens one handle per file today, so only tests are exposed. Expected: a comment on
`queueFor` that states the constraint, and a reference count that deletes the entry on `close()`.

### S3 (NEW, impl) `src/store/hub-store.ts` `touchMachine`: unlocked read-modify-write of `extra`

On Postgres two transactions can read the same `extra` and the later write wins. This is harmless
today because `repos` is replaced whole. It will lose updates once MM-2/MM-3 store labels or the
accept policy in `extra`. Expected (by MM-2): `SELECT … FOR UPDATE`, or a JSON merge in SQL.

### S4 (NEW, impl) `HubService.fleet` reads every machine and every session ever stored

`fleet()` (`src/hub/service.ts`) filters `listMachines()` and `listSessions()` in JS. Sessions are
never deleted, and the endpoint is polled every 15 s by each Mine page and every 5 s by an open TUI
panel. Expected: store queries by `user_id` (and `state <> 'ended'`).

### S5 (NEW, test) New tests reuse project-specific repo names

`test/share-sessions.test.ts` (AC-09, AC-10) and other new tests use `frr-dplane-ovs` and
`vpc-node-agent`, which were already in older tests. Expected: generic names such as
`example.org/team/alpha` in new tests, as `my-mesh.test.ts` does.

### S6 (NEW, test) Some AC tests pass on the base by construction

On the base, `test_AC03_me_step_holders_first_then_metadata`, `test_AC03_cap_keeps_step_holders` and
`test_AC03_metadata_matches_sessionMetadata` pass, because the old boolean parameter treats `"me"` as
true. The AC-01, AC-02 and AC-10 regression tests pass too, by design. Each of these criteria still has
other tests that failed first (`test_AC03_steps_only_step_holders`, `test_AC10_unreported_share_owner_only`,
…). This is information only: the test-writer's `not_fail_first` list should name them.

## Criteria map

| AC | Test (failed first) | Note |
|---|---|---|
| 01 | `src/protocol/config.test.ts` | |
| 02 | `test/cli.test.ts` | |
| 03 | `src/daemon/hub-link.test.ts` | S6 |
| 04, 11, 12, 15, 18–21, 28–30 | `test/my-mesh.test.ts`, `src/daemon/inventory.test.ts` | |
| 05 | contract test (both engines), `test/m46-ops.test.ts` | |
| 06, 07 | contract test (both engines) | |
| 08 | `src/core/visibility.test.ts` | |
| 09, 10 | `test/share-sessions.test.ts` | |
| 13 | `test/my-mesh.test.ts` | B1: no Postgres leg |
| 14 | `src/daemon/repos.test.ts` | |
| 16, 27 | `src/daemon/hub-link.test.ts`, `src/daemon/inventory.test.ts` | |
| 17 | `src/core/fleet.test.ts` | |
| 22 | `src/cli/tui/render.test.ts` | |
| 23 | `test/e2e-web/mine.spec.ts` (Playwright) | |
| 24, 25, 26 | `test/schemas.test.ts`, `pnpm check` | |
