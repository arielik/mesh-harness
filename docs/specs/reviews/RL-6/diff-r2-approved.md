Verdict: APPROVED | Round: 2 | Blocking-open: 0

# Review of the RL-6 diff, round 2

This is a cold review of `git diff feat/relay-design...comb/RL-6` (head 9053cc5) against
`docs/specs/RL-6.md`. Before it I read the spec reviews `r1`, `r2` and `r3` and the first diff round
`diff-r1-changes-requested.md`. This round adds the developer commits b587cc2, 9404da6 and 3b43248, the
test-writer commit 859462e, and the merges 1fb1829 and 9053cc5.

## Checks

I ran the checks in a scratch worktree, detached at comb/RL-6 (9053cc5), and removed it afterwards. I
checked nothing out in the integration worktree.

| Check | Result |
|---|---|
| `pnpm check` (lint, typecheck, boundaries, test, build) | passed: 96 test files, 2112 tests passed, 101 skipped |
| `pnpm test:web` after the build | passed: 47 tests, including the 4 in `calibration.spec.ts` (AC-14) |
| Fail-first of the new `test_AC09_own_accepted_replaced_same_round`, with `src/core/calibration.ts` from 4c6f187 (the round-1 rule) | fails on the criterion: `expected { … } to match object { accepted: 2, … }` |
| Mutation: drop `n.decider.user === e.decider.user` from `flagEntries` | `calibration-hub`, `programme` and `src/core` tests: 447 passed (see S2) |
| Mutation: drop all three decider checks (`kind === "person"` twice and the user check) | 447 passed (see S2) |

Not run:
- The Postgres legs of the store contract and hub copy, including the Postgres leg of AC-04.
  `MESH_TEST_PG_URL` is unset here, and CI runs them. I judged those criteria on their SQLite leg.
- `pnpm schemas` as a separate command. `test_AC16_openapi_route`, part of `pnpm test`, compares the
  file with `hubOpenApi()` and passes. Round 2 changes no route.
- Fail-first of the Playwright tests again. Round 2 changes nothing under `web/` or `test/e2e-web/`, and
  round 1 covered them.

## Round-1 findings

| Id | Class now | Status |
|---|---|---|
| B1 replan 200 no-op for calibration goals | fixed | b587cc2 removes the branch, so calibration goals get the RL-3 404 again. It also reverts the `docs/events.md` and `concepts.md` lines and the spec Open questions entry. 859462e moves `test_AC13_replan_path` to `POST /v1/goals/:id/plan` and expects 201. |
| S1 change-of-mind rule too broad | fixed | 9404da6 limits the flag to a person's `dismissed` entry that the same person replaces in the same debrief step and round, as the spec says (Open questions, "Change of mind inside one round"). The new test pins the dismissal-only part and fails on the old rule. |
| S2 developer edited tests | not repeated | b587cc2, 9404da6 and 3b43248 change no test file. 859462e changes only `test/calibration-hub.test.ts`. |
| S3 one history read per item inside the lock | fixed | 3b43248 reads `item_history` once, ordered by `seq`, and groups it per item. See S1 below. |

## Criteria

The criteria table of round 1 still holds. AC-01 to AC-17 each have a test that failed first at 63c382d.
The only changes since then:
- **AC-13 (replan path).** The test now goes through the plan route. It is still the path the spec
  names: the calibrator proposes and approves plan v2 → `calibrate` dropped, `recheck` ready → done →
  `calibration.done` `outcome: "none"`.
- **AC-09.** It gains `test_AC09_own_accepted_replaced_same_round`, which failed first as shown above.

No test asserts on source text. I found no team-, company- or person-specific names in the round-2
changes.

Code I checked and found correct in this round:
- `listItemHistory` uses `SELECT lineage, fp, value FROM item_history ORDER BY seq`. `seq` is the
  primary key on both backends (SQLite `INTEGER PRIMARY KEY AUTOINCREMENT`, Postgres
  `BIGINT GENERATED ALWAYS AS IDENTITY`), and `listDispositions` already uses the same query shape. The
  per-item grouping keeps insertion order, so `flagEntries` gets the same history per item as the old
  per-item `itemHistory(lineage, fp)` calls did.
- The `flagEntries` narrowing on `decider.kind === "person"` typechecks. A `revert` entry still flags
  only the disposition right before it.

## Findings

None of these blocks the diff.

### S1 (suggestion, REGRESSION-OF-OWN-REPAIR): a new `HubStore` method contradicts the spec's "no new store methods" decision

The fix for round-1 S3 (3b43248) adds `HubStore.listItemHistory()` (`src/store/hub-store.ts:990-994`).
The spec's Open questions entry "Reads for stats and the trigger" still says: "No new `HubStore` methods
(so no new store contract criterion): both scan with the existing reads". The method has no leg in
`src/store/hub-store.contract.test.ts`. Right now only the SQLite World tests reach it, and only
indirectly. The SQL is the same shape as `listDispositions`, so I see no parity bug. The spec is stale,
though, and the Postgres leg never runs this method.

- Expected, either of these:
  - Implementation: update the spec entry to name `listItemHistory` (one ordered read of
    `item_history`), and have the test-writer add a store contract case on both backends: insertion order
    across two lineages, with `lineage` and `fp` returned.
  - Or: go back to the existing reads with one `itemHistory(lineage)` per distinct lineage, which round 1
    offered first, and keep the spec as it is.

### S2 (suggestion, NEW): no test checks the "same person" part of the change-of-mind rule

9404da6 requires both entries to be a person's and to come from the same `decider.user`. Removing either
check leaves every RL-6 test green (see the mutation rows above). The new test only pins the
dismissal-only part. If RL-4 lets a different person write a `debrief-session` entry in the same step
and round, the code is untested there. If RL-4 does not allow that, the checks are defensive and the
spec should say the case cannot happen.

- Expected (test-writer): add a case where person X dismisses an item in a debrief round and person Y
  then replaces it in the same step and round. X's dismissal still counts: `dismissedByPeople` includes it
  and it stays `uncalibrated`. If RL-4 cannot produce this, record in the spec's Open questions that the
  case cannot happen.

### S3 (suggestion, NEW): nothing pins the RL-3 404 for `/replan` on a calibration goal

After the B1 revert, no test anywhere calls `POST /v1/goals/:id/replan` on a goal without a design step
(pulse, ingest or calibration). A later change could bring back the round-1 B1 behaviour without any test
failing.

- Expected (test-writer, later row is fine): a World test where `POST /v1/goals/<C>/replan` on an open
  calibration goal returns 404 `<C> has no design step` and emits no `goal.replan`.
