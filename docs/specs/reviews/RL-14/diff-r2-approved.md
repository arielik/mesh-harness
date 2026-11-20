Verdict: APPROVED | Round: 2 | Blocking-open: 0

# RL-14 implementation review, round 2 (commit d75ee24)

Reviewed `git show d75ee24`, which answers docs/specs/reviews/RL-14/diff-r1-changes-requested.md
(round 1 reviewed ec9153c), against docs/specs/RL-14.md. Baseline on a scratch copy of HEAD:
src/core/state-time.test.ts and test/efficiency-hub.test.ts pass, 33 tests.

## Round-1 findings

**B1 (AC-04, three clauses with no effective test): RESOLVED.**
- Hub-side strip: `test_AC04_hub_strips_state_time` posts a `/v1/sync` whose session record carries
  `stateTime` directly, then checks `hubStore.getSession`. Mutation M6 is now caught.
- Hub switch: `test_AC04_marks_cleared_on_hub_switch` drives `HubLink.factsFor` with the same key
  twice (no clear) and then another hub (the marked sessions are cleared once, and `stateTimeSent`
  is emptied). M9 and M9b (dropping `stateTimeSent.clear()`) are caught. The test reaches a private
  method through `as any`. That is acceptable for a unit test: if the method is renamed, the test
  fails at run time instead of passing.
- Retention: `test_AC04_ended_kept_until_accepted` is the World test asked for. It ends the session
  while offline, moves the clock 25 h, ticks, reconnects, checks that the final 15 s arrive, and
  checks that the next tick then drops the session. M10 is caught.

**S1 (AC-14 clauses covered indirectly): PARTIAL.**
- Release while held: `test_AC14_drop_and_unknown` covers it (admin `release`, then
  `notHeld == [S]`, then A's row stops at the release time after 1 h and a tick). The AC text was
  changed from "a step a person drops" to "a step an admin releases", because `dropGoalByPerson`
  refuses a goal with held steps (service.ts:5320). That matches the code. It is still a change to an
  approved AC inside an implementation commit, so the spec owner should acknowledge it. The design
  paragraph at RL-14.md:108-111 still says "dropped" and is still accurate for the other paths.
- B's row grows: `test_AC14_holder_row_grows` asserts that it grows by exactly one sync interval.
  It binds B's step with `root.daemon.update` instead of a real claim, which is fine for this purpose.
- Unknown step: asserted (`G999.x` is listed). M23 is now caught.
- Still open: no test asserts that a headless run's row grows. `test_AC14_headless_held` checks only
  `heldBy` and `notHeld: []`. Not blocking: `notHeld: []` is the precondition, and the AC's FAIL
  column ("a held step is reported `notHeld`") is covered.

**S2 (`notHeld` presence rule): RESOLVED.** A body with no step holder has no `notHeld` key. M20
is caught.

**S3 (`markWorking` accrual untested): OPEN.** It was not addressed. M16 still survives all
RL-14 tests. Not blocking.

**S4 (window `done` not pinned to the window): RESOLVED.** The window test now adds a step that is
in the window only through a turn event, and expects `done: 0`. M18 is caught by
`test_AC08_window_counts_filters`.

**S5 (`stuck` reads turn events by exact step id, N+1): OPEN.** It was not addressed.
service.ts:4277 still calls `eventsFor({ step: s.id })` once per claimed step. Not blocking.

**S6 (misplaced doc comments): RESOLVED.** The `/v1/health` comment is back on `health`, and the
`eventsFor` comment is back on `eventsFor`.

**S7 (test plan name drift): RESOLVED.** The plan now names `test_AC04_tables_equal_migrated` for
the `step_time` copy, and lists the new AC-04 and AC-14 tests.
`test_AC14_holder_row_grows` is not listed in the plan's AC-14 row (minor).

## New findings

None blocking.
- **N1 (minor).** The commit message lists B1, S1, S2, S4, S6 and S7 but does not say that S3 and
  S5 were deferred. Record them as follow-ups so they are not lost.

## Mutation check

Scratch copy of the worktree HEAD (d75ee24) at
/tmp/claude-1015/-home-ghost2-vpc-devel-mesh-harness/1309aed3-426f-4a87-8d98-c622fcf70a9b/scratchpad/mut,
with node_modules symlinked. Mutations were applied one at a time and reverted after each run, with
`vitest run test/efficiency-hub.test.ts src/core/state-time.test.ts`.

| # | Mutation | Caught? | By |
|---|---|---|---|
| M6 | hub `sync` upserts `s` (with `stateTime`) instead of `rest` | yes | test_AC04_hub_strips_state_time |
| M9 | `factsFor`: no mark clear on a switch (`if (false && switched)`) | yes | test_AC04_marks_cleared_on_hub_switch |
| M9b | `factsFor`: no `stateTimeSent.clear()` | yes | test_AC04_marks_cleared_on_hub_switch |
| M10 | daemon tick: `finalPending` term → `false` | yes | test_AC04_ended_kept_until_accepted |
| M20 | `notHeld` always in the sync reply | yes | test_AC14_drop_and_unknown |
| M18 | window `done` without `inW(newest.finishedAt)` | yes | test_AC08_window_counts_filters |
| M23 | unknown step treated as held (`st && !heldBy`) | yes | test_AC14_drop_and_unknown |
| M16 | `markWorking` without `accrue` | **no** | (S3, open, not blocking) |
