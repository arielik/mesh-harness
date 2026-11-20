Verdict: CHANGES REQUESTED | Round: 1 | Blocking-open: 1

# RL-14 implementation review, round 1 (commit ec9153c)

Reviewed `git show ec9153c` against docs/specs/RL-14.md (revision 4) and the plans in
docs/specs/plans/. I read src/core/state-time.ts, src/core/efficiency.ts, the daemon and hub-link
changes, `sync`/`goalEfficiency`/`efficiencyWindow`/`stuck`/`heldBy` in src/hub/service.ts, migration 12
and `putStepTime`/`listStepTimes`/`eventsBetween` in src/store/hub-store.ts, and the protocol types.
Baseline: state-time, efficiency-hub, store contract (SQLite and Postgres), docs-rl14, schemas and
m46-ops all pass (282 tests).

## Correctness summary

The sync path is sound. I found no double counting or lost time beyond what the spec allows:
- Entries are absolute totals. `putStepTime` replaces a row only when the stored `as_of` is not newer
  and the row has the same owner, in one SQL statement on both dialects (hub-store.ts:683-697).
  Retries, duplicates, older bodies and restarts can only replace a total, never add to one.
- Marks go into `stateTimeSent` only after `rpc` returns 2xx (`rpc` throws on non-2xx and on network
  failure, hub-link.ts:248-275). Only the first body of a flush carries entries and supplies the
  `notHeld` marks (hub-link.ts:351-377).
- `notHeld` marks go through `commit`, so `accrue` runs on them. Adding a mark closes the interval
  as held, and removing one adds nothing and restarts accrual at `now`. A mark for any other step is
  dropped (state-time.ts:63). The marks are saved with the record, so they survive a restart.
- `heldBy` matches the held rule, including the branch where `holderSid` is absent
  (service.ts:6223-6227). The hub strips `stateTime` before `upsertSession`. `notHeld` is present
  exactly when the body has a session that holds a step.
- Apportioning, the midnight split, the per-day clamp, absent-vs-zero (`sumFigures` /
  `stepCard`) and the window bounds and parameter texts all match the spec.
- Scopes: the routes are `member` / `goals:read`, are not wrapped with `forPerson` and use
  read-only transactions. AC-11 covers this.

## Findings

**B1. AC-04 has three clauses with no effective test.** Three mutations survive every RL-14 test:
- *Marks reset when the credentials name another hub.* Disabling the clear in `factsFor`
  (hub-link.ts:332, `if (switched) this.deps.onNotHeld?.(…, [])`) leaves all tests green. Nothing
  switches hub or machine with a marked session. (`stateTimeSent.clear()` at :329 is also
  unexercised by a switch.)
- *An ended session with an unaccepted final entry stays in memory past 24 h until accepted.*
  Removing the `finalPending` term from the tick filter (daemon.ts:1469) leaves all tests green.
  `test_AC04_final_pending` checks only the pure helper, not the daemon wiring. Needed: a World test
  that ends a session while its hub is unreachable, moves the clock past 24 h, ticks, reconnects and
  checks that the final totals arrive.
- *`stateTime` never in the hub's stored session.* Removing the hub-side strip (service.ts:3045,
  passing `s` instead of `rest` to `upsertSession`) leaves all tests green. `test_AC04_no_leak_in_records`
  only syncs through a daemon that already strips. Needed: a direct `POST /v1/sync` whose session
  record carries `stateTime`, then a check of `GET /v1/live` and `hubStore.getSession`.
The spec names all three clauses in AC-04's criterion and FAIL column, so each needs a test that
fails when its code is removed.

**S1. AC-14: some clauses are covered only indirectly.**
- "A step a person drops while A holds it marks A": no World test. The `heldBy` unit check with
  `state: "done"` catches removal of the state check (M29), which is close but not the drop route.
- "B's row grows" and "a headless run … its row grows": not asserted. `test_AC14_headless_held`
  checks `heldBy` and `notHeld: []`, not that a row grows.
- "Unknown step → notHeld" (service.ts:3049): changing `!st ||` to `st &&` survives (M23).
Consider adding these to `test_AC14_*`.

**S2. `notHeld` presence rule is half-tested.** Always returning `notHeld`, even for a body with no
step-holding session, survives (M20). One assertion that the field is absent on a body without a
step holder would pin the "exactly when" in the spec (service.ts:3088).

**S3. `markWorking` accrual is untested.** Reverting `markWorking` to the old non-accruing record
(daemon.ts:1575) survives (M16). Without it, the idle or needs-you time before an autopilot prompt
would count as `working`. An autopilot or chain test with a clock move would cover it.

**S4. Window `done` is not pinned to the window.** Dropping `inW(newest.finishedAt)` from
efficiency.ts:176 survives (M18). Add a step that was done before the window but is in the window
through a turn event, and expect `done: 0`.

**S5. `stuck` reads turn events by exact step id.** service.ts:4278 uses
`eventsFor({ step: s.id })`, which is `WHERE step = ?`, while the card and the window compare event
steps without case. A turn event spelled differently from the step id is counted on the card but not
in `/v1/stuck`. This is also one query per claimed step (N+1). Consider one `eventsBetween`-style query
over the claimed steps, compared in lowercase.

**S6. Misplaced doc comments.** service.ts:4122 leaves `/** GET /v1/health … */` above the RL-14
section banner, so it now sits on `goalEfficiency`'s neighbourhood instead of `health`.
hub-store.ts:1520 leaves "Events about a step, or about any step of a goal" on `eventsBetween`
instead of `eventsFor`.

**S7. Test plan name drift.** The plan lists `test_AC12_copy_table`, but no test has that name. The
copy of `step_time` is covered by `test_AC04_tables_equal_migrated` in test/m46-ops.test.ts, because
`TABLES` must equal the migrated table set. Update the plan or add the named test.

## Mutation check

Each mutation was made on a scratch copy (not the worktree), one at a time. Tests run:
src/core/state-time.test.ts and test/efficiency-hub.test.ts, plus the store contract for M1 with
`MESH_TEST_PG_URL` set.

| # | Mutation | Caught? | By |
|---|---|---|---|
| M1 | drop `step_time.as_of <= excluded.as_of` in `putStepTime` | yes | test_AC12_step_time_upsert (sqlite + postgres), test_AC03_same_body_twice_and_older |
| M2 | drop the `notHeld` check in `accruingStep` | yes | test_AC04_not_held_mark, test_AC14_take_over, test_AC14_cli_take_restart_reclaim |
| M3 | no midnight split in `addInterval` (`end = to`) | yes | test_AC01_midnight_split |
| M4 | apportion fraction → 1 on any overlap | yes | test_AC01_apportion, test_AC08_window_apportion |
| M5 | `syncedSessions` keeps `stateTime` | yes | test_AC04_no_leak_in_records |
| M6 | hub `sync` stores the record with `stateTime` | **no** | (B1) |
| M7 | `heldBy`: holderSid-absent branch → false | yes | test_AC14_headless_held |
| M8 | `heldBy`: ignore `holderMachine` | yes | test_AC14_headless_held |
| M8b | `heldBy`: ignore `holderUser` | yes | test_AC14_headless_held |
| M9 | `factsFor` does not clear marks on a hub switch | **no** | (B1) |
| M10 | tick drops ended sessions at 24 h regardless of `finalPending` | **no** | (B1) |
| M11 | daemon never applies the reply's `notHeld` | yes | test_AC14_take_over, test_AC14_cli_take_restart_reclaim |
| M12 | open entries resent every sync (no 60 s rule) | yes | test_AC04_select_rules |
| M13 | no per-day clamp | yes | test_AC01_clock_back_and_clamp |
| M14 | `stuck` lists sessions without the held rule | yes | test_AC10_stuck_sessions |
| M15 | `accrue` keeps marks for another step | yes | test_AC04_not_held_mark |
| M16 | `markWorking` without `accrue` | **no** | (S3) |
| M17 | hub stores entries for a sid owned by another user | yes | test_AC05_bad_entries_skipped |
| M18 | window `done` without the in-window test | **no** | (S4) |
| M20 | `notHeld` always present in the sync reply | **no** | (S2) |
| M21 | `commit` without `accrue` | yes | 6 tests (AC-02, AC-03 x2, AC-04, AC-14 x2) |
| M22 | marks remembered before the sync call returns | yes | test_AC03_lost_reply_offline_restart |
| M23 | unknown step treated as held in `notHeld` | **no** | (S1) |
| M24 | `stateSince = now` on every change | yes | test_AC01_state_since |
| M25 | hub stores entries for an unknown step | yes | test_AC05_bad_entries_skipped |
| M26 | window ignores `trial=exclude` | yes | test_AC08_window_counts_filters |
| M27 | `turnsSinceCommit` counts turns before the commit | yes | test_AC10_stuck_steps |
| M29 | `heldBy` ignores step state | yes | test_AC14_headless_held |
| M30 | `selectStateTime` order ignores open-first | yes | test_AC04_cap_and_order |
