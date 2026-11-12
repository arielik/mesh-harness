Verdict: CHANGES REQUESTED | Round: 1 | Blocking-open: 1

# Review of the RL-6 diff, round 1

This is a cold review of `git diff feat/relay-design...comb/RL-6` (head 4c6f187) against
`docs/specs/RL-6.md`. Before it I read the spec reviews `r1-changes-requested.md`,
`r2-changes-requested.md` and `r3-changes-requested.md`. They review the spec, not code, so this is the
first diff round. Every finding below is NEW: none repeats an earlier finding, and none is a regression
of an earlier repair.

## Checks

I ran the checks in a scratch worktree, detached at comb/RL-6. I checked nothing out in the integration
worktree.

| Check | Result |
|---|---|
| `pnpm check` (lint, typecheck, boundaries, test, build) at 4c6f187 | passed: 96 test files, 2111 tests passed, 101 skipped |
| `pnpm test:web` after `pnpm build` at 4c6f187 | passed: 47 tests, including the 4 tests in `calibration.spec.ts` (AC-14) |
| `schemas/hub-api.openapi.json` against `hubOpenApi()` | equal (`test_AC16_openapi_route` passes) |
| Fail-first: every new or changed unit and World test at the test-only commit 63c382d, without the implementation | all 55 RL-6 tests failed. Each failure I checked was on the criterion itself, not on setup. For example: AC-05 `expected 'ready' to be 'skipped'`, AC-06 `expected +0 to be 1`, AC-04 `topic` missing from `TABLES`. |
| Experiment for B1: remove the replan change of 7d309d9 and have `test_AC13_replan_path` call the plan route directly (`POST /v1/goals/:id/plan`, 201) | the test passes |

Not run:
- The Postgres legs of the store contract and hub copy, including the Postgres leg of AC-04.
  `MESH_TEST_PG_URL` is unset here, and CI runs them. I judged those criteria on their SQLite leg.
- Fail-first of the Playwright tests (AC-14) at 63c382d, because that would need a web build of the
  test-only commit. The table and its selectors do not exist before 4f48ceb, so these tests cannot
  pass there.
- `pnpm schemas` as a separate command. The equality test above covers it.

## Criteria

| Id | Test (fails first) | Verdict |
|---|---|---|
| AC-01 | `calibration.test.ts`, `policy.test.ts` `test_AC01_input_keywords`, `config.test.ts` `test_AC01_config_threshold` | ok |
| AC-02 | `review.test.ts` `test_AC02_*` | ok |
| AC-03 | `presets.test.ts` `test_AC03_*`, `pulse-cli.test.ts` `test_AC03_cli_preset_ls` | ok |
| AC-04 | `m46-ops.test.ts` `test_AC04_tables_equal_migrated` (SQLite; Postgres leg not run) | ok |
| AC-05, AC-06 | `calibration-hub.test.ts` | ok |
| AC-07 to AC-12 | `calibration-hub.test.ts` | ok |
| AC-13 | `calibration-hub.test.ts` `test_AC13_*` | see B1 |
| AC-14 | `test/e2e-web/calibration.spec.ts` | ok |
| AC-15, AC-16 | `schemas.test.ts` `test_AC15_*`, `test_AC16_*`, `test_AC07_route_table` | ok |
| AC-17 | `programme.test.ts` `test_AC17_whole_programme` | ok |

Other checks:
- **Source text.** No test asserts on source text. The tests read `package.json`, the OpenAPI file,
  `skills/mesh/SKILL.md` and the docs, and AC-15 and AC-16 name those files as the surface.
- **Who changed what.** The test-writer's commit 63c382d changes only tests, `test/helpers` and
  `test/e2e-web/hub.yaml`.
- **Names.** I found no team-, company- or person-specific names. The fixture users (`ann`, `bob`,
  `carol`, `frank`) and the repo `alpha` are generic.

Code I checked and found correct:
- Precedence for agreeing dispositions: the hub compares with the latest person entry and checks
  `consumes` on the current state. A disagreeing disposition is ignored and never refused.
- `consumedNow` is used both in `when` and in the `dispositions` input.
- Every path that sets a goal done (approve/replan, step done, gate decide, resume) goes through
  `markGoalDone`, after the goal is saved as done.
- The trigger runs inside `goalTx` (`store.serialize()`, a global lock on Postgres and
  `BEGIN IMMEDIATE` on SQLite), so two replicas cannot open two goals.
- Calibrator rules 1-3: sources are read in repo-id order, and a catalog `calibrator` that names no
  user falls through to the next rule.
- The stats window, `lastAt` fallback, ordering and null means.
- `describe()` texts.
- The web toggle: it does not reload while hidden, and it shows `p.empty` and `p.error`.

## Findings

### B1 (blocker, NEW): `POST /v1/goals/:id/replan` became a 200 no-op for calibration goals, only to satisfy a test helper

Commit 7d309d9 adds a branch to `HubService.replan` (`src/hub/service.ts`, the
`if (!design && goal.calibration)` block in `replan`). For an open calibration goal the route now
returns 200 and emits `goal.replan`, but it reopens nothing, changes no state and writes no note. Pulse
and ingest goals, which also have no design step, still get the RL-3 404. The commit also updates
`docs/events.md` (`goal.replan` "the replan request only"), `docs/guide/concepts.md` and a new Open
questions entry to match.

The spec's contract does not ask for this. AC-13 only says that the calibrator "proposes and approves
plan v2". The 404 came from the test: `test_AC13_replan_path` (`test/calibration-hub.test.ts:954`)
calls the RL-2 helper `review-kit.replan`, and that helper asserts that `/replan` returns 200 before it
posts the plan. The experiment above shows that the plan route alone passes the test once the branch
is removed.

So the product gained an inconsistent API: one goal kind without a design step answers 200 and the
others answer 404. It also gained a `goal.replan` event whose documented meaning ("the design is
reopened") is false here. Both exist only to fit a test helper. That is the wrong decision, and the
conservative reading (no change to the RL-3 replan contract) was available. Spec fix 3 allows
unlisted fixes only for gaps that AC-17 exposes in RL-1..RL-5. This gap is in a test helper.

- Implementation: revert the `replan` branch of 7d309d9 so calibration goals keep the RL-3 404, as
  pulse and ingest goals do. Revert the matching lines in `docs/events.md` and
  `docs/guide/concepts.md`, and the spec Open questions entry "(fix, AC-13) Replan of a calibration
  goal".
- Test: `test_AC13_replan_path` should propose plan v2 through `POST /v1/goals/:id/plan`, expect 201,
  and approve it. It should not use `review-kit.replan`.

### S1 (suggestion, NEW): the change-of-mind rule also drops non-dismissal entries and does not check the person

`flagEntries` (`src/core/calibration.ts:67`) marks an entry as reverted when the next disposition entry
of the item has `via: debrief-session` and the same goal, step and round. Spec S3 limits this to "a
person's dismissal that the **same person** replaces". The code does not check the disposition (an
`accepted` entry replaced in the same round also leaves `accepted` and `reinstated`) or the decider's
user.

Consequence: a person accepts an item that a validator dismissed, then changes it to `deferred` in the
same round. Under the spec's definition, the acceptance stays in `accepted` and `reinstated` uses its
`at`. The code drops it.

- Expected: either limit the flag to `e.disposition === "dismissed"` with the same
  `decider.user`, or record in the spec that every own replacement counts as reverted, and add a test
  for the case.

### S2 (suggestion, NEW): the developer's commits edited existing tests

Commit ac23184 narrowed `test_AC03_builtins_unchanged` in `src/core/presets.test.ts` (it leaves out
`calibrate`), and 8f83d7e changed `test_AC24_version` in `test/schemas.test.ts`. The spec says that
"existing tests that list ... are updated by the test-writer". The merge 05916e2 resolved both files to
the test-writer's version, so the final diff contains no developer test edit. The rule was still
broken on the branch.

- Expected: the developer leaves test files alone and reports a needed test change to the
  test-writer.

### S3 (suggestion, NEW): `calibrationScan` reads item history one item at a time inside the global lock

`calibrationScan` (`src/hub/service.ts:3347-3362`) first reads all of `item_history` through
`listDispositions({})`. It then calls `itemHistory(lineage, fp)` once for each item that has a
disposition, and the trigger runs this on every recorded dismissal while holding `serialize()`. The spec
accepts a scan that is linear in the history, but this one makes one query per item, which on Postgres
is a round trip each.

- Expected (later row is fine): one `itemHistory(lineage)` per lineage, or derive the revert flags from
  a single ordered history read.
