Verdict: APPROVED | Round: 2 | Blocking-open: 0

# Review of the MM-1 diff, round 2

Reviewed cold: `git diff feat/my-mesh-assign...comb/MM-1` (head 22b26bf, "combine MM-1 (5)": developer
head e7ad523, test head 08822dd) against `docs/specs/MM-1.md` (revision 3). Read first: the spec
rounds `r1-changes-requested.md`, `r2-changes-requested.md`, `r3-approved.md`, then the diff round
`diff-r1-changes-requested.md`. New since round 1: developer commits 8e31af0 (`src/store/db.ts`) and
e7ad523 (`src/hub/service.ts`, `src/store/dialect.ts`, `src/store/hub-store.ts`); test-writer commit
08822dd (`test/my-mesh.test.ts`, `test/share-sessions.test.ts`).

## Checks run

All in a detached review worktree of `comb/MM-1` in a scratch folder, never in the integration
worktree.

| Check | Result |
|---|---|
| `pnpm check` (lint, typecheck, boundaries, test, build) | pass as one run: 51 files, 636 passed, 46 skipped; build complete. |
| Whole suite with `MESH_TEST_PG_URL` at a local Postgres 17 (`pnpm vitest run`) | 51 files, 682/682 pass, nothing skipped. This includes `test_AC13_concurrent_200_and_409_postgres`, the contract test on both engines and `m46-ops` replicas. |
| Mutation: the new Postgres leg of AC-13 can fail | With `serialize()` removed from `HubService.renameMachine` and `HubStore.setMachineNickname`, `test_AC13_concurrent_200_and_409_postgres` fails: `expected [ 200, 500 ] to deeply equal [ 200, 409 ]` (`{"status":500,"json":{"error":"internal error"}}`). Restored afterwards (worktree clean). |

Not run: `pnpm schemas` (round 2 changes no route, protocol type or `HUB_API`; `test/schemas.test.ts`
in `pnpm check` compares the committed document and passed); `pnpm test:web` (Playwright; no web or
API-shape change since round 1, where 12/12 passed); fail-first of the commits at their base again
(done in round 1 for every criterion; the one new test is a further leg of AC-13, proven able to fail
by the mutation above).

## Rules

- Developer changed no test in this round: 8e31af0 and e7ad523 touch only `src/store/*` and
  `src/hub/service.ts`.
- Test-writer changed no product code: 08822dd touches only `test/*.test.ts`.
- No assertion on source text in the new tests.
- Docs: round 2 changes no documented interface; the docs checked in round 1 stand.
- Generic names: the new AC-09/AC-10 tests use `example.org/team/alpha|beta`. The two older repo
  names left in `test/share-sessions.test.ts` belong to the v0.1.7 test, which was only moved into a
  `describe` block (shown as added lines by the diff).

## Round 1 findings

| Id | Status | Evidence |
|---|---|---|
| B1 (test) AC-13 concurrent case not proven on Postgres | Fixed | `test/my-mesh.test.ts` `test_AC13_concurrent_200_and_409_postgres`: own hub on a fresh Postgres database, two machines of one user, 10 rounds of two simultaneous renames, sorted statuses `[200, 409]`, exactly one machine holds the nickname; skipped with a stderr note when the URL is unset. Fails without the lock (see Checks). |
| S1 (process) developer edited tests | No recurrence this round | Info only. |
| S2 (impl) SQLite turn queue never pruned, deadlock undocumented | Fixed | `queueFor` documents the cross-handle constraint; `refs` counted per handle, `releaseQueue` deletes the entry on the last `close()`; `close()` is idempotent and releases in `finally`. |
| S3 (impl) unlocked read-modify-write of `extra` | Fixed | `SELECT extra … FOR UPDATE` on Postgres via `dialect.forUpdate`. Lock order checked: a sync with events takes the `events` lock (appendEvent) before the row lock, as `renameMachine` does; a sync without events takes no advisory lock after the row lock. No inversion. |
| S4 (impl) `fleet` loads every machine and session | Fixed | `listMachines({ userId })`, `listSessions({ userId, live })` filter in SQL; `machineFor` uses the user filter too. |
| S5 (test) project-specific repo names | Fixed | New share tests use generic names. |
| S6 (test) some AC tests pass on the base by construction | Info only | Unchanged; other tests of the same criteria failed first. |

## Correctness (round 2 code, no defect found)

- `listSessions({ live: true })`: `json_extract(value, '$.state')` (SQLite) and
  `(value::jsonb ->> 'state')` (Postgres, `value` is `TEXT` holding JSON) with `IS NULL OR <> 'ended'`;
  same result on both engines. Exercised on Postgres by the new AC-13 leg (`GET /v1/fleet`), though
  with no session rows (N1).
- `listMachines({ userId })`: ordering by `hostname` within one user equals the old filtered order.
- `SqliteDb.close()`: a private `:memory:` queue starts at `refs: 1` and has no key, so release is a
  no-op; a file queue is removed only when it is still the mapped one.

## Blockers

None.

## Suggestions (not blocking)

### N1 (NEW, test) The new store filters have no contract test with data on both engines

`HubStore.listMachines({ userId })` and `listSessions({ userId, live })` (e7ad523) are covered only
indirectly: AC-11 on SQLite through the World hub, and on Postgres only by the AC-13 leg, which syncs
`sessions: []`, so the Postgres `->>` filter never sees a row. Expected: a case in
`src/store/hub-store.contract.test.ts` (both engines) with two users, one ended and one non-ended
session each, asserting `listSessions({ userId, live: true })` returns only that user's non-ended
session and `listMachines({ userId })` only that user's machines.

### N2 (NEW, impl) `HubService.fleet` filters ended sessions twice

`src/hub/service.ts` `fleet()` keeps `.filter((hs) => hs.session.state !== "ended")` after
`listSessions({ userId, live: true })` already drops them in SQL. Harmless. Expected: drop the JS
filter, or keep it with a comment saying it is a guard.

## Criteria map

Unchanged from round 1, with AC-13 now proven on both engines:

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
| 13 | `test/my-mesh.test.ts` (World; Postgres leg) | B1 fixed |
| 14 | `src/daemon/repos.test.ts` | |
| 16, 27 | `src/daemon/hub-link.test.ts`, `src/daemon/inventory.test.ts` | |
| 17 | `src/core/fleet.test.ts` | |
| 22 | `src/cli/tui/render.test.ts` | |
| 23 | `test/e2e-web/mine.spec.ts` (Playwright, round 1) | |
| 24, 25, 26 | `test/schemas.test.ts`, `pnpm check` | |
