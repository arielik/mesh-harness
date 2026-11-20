# Test plan: docs/specs/RL-12.md

World tests through the hub API with `calib-kit.ts` (records, dispositions, reverts, telemetry) and
its `pulses()` bridge to `pulse-kit.ts` (pulses, fires, ticks). `test/helpers/health-kit.ts` runs a
stage end to end (claim, optional `run.started`, report artifact, record, close, telemetry).

| AC | File | Test(s) |
|---|---|---|
| AC-01 | test/pulse-runs-hub.test.ts | `test_AC01_card` (4-stage relay with a sink and a ready debrief) |
| AC-02 | test/pulse-runs-hub.test.ts | `test_AC02_fix_cycle`, `test_AC02_failed_and_dropped_deps`, `test_AC02_skipped_dep` |
| AC-03 | test/pulse-runs-hub.test.ts | `test_AC03_skipped_missed_manual` |
| AC-04 | test/pulse-runs-hub.test.ts | `test_AC04_dispositions`, `test_AC04_sinks` (revert, retarget, re-file, dropped clean-audit goal) |
| AC-05 | test/pulse-runs-hub.test.ts | `test_AC05_delta`, `test_AC05_retried_round_fold` |
| AC-06 | test/pulse-runs-hub.test.ts | `test_AC06_paging`, `test_AC06_errors` |
| AC-07 | test/health-hub.test.ts | `test_AC07_slots_runs_goals` (scheduled slots seeded in the store; goals and runs real), `test_AC07_trial_include` |
| AC-08 | test/health-hub.test.ts | `test_AC08_accepted_and_ratio`, `test_AC08_debriefs`, `test_AC08_findings` |
| AC-09 | test/health-hub.test.ts | six `test_AC09_*` cases |
| AC-10 | test/health-hub.test.ts | `test_AC10_filters_and_total` |
| AC-11 | test/health-hub.test.ts | `test_AC11_scopes_no_writes_features`; `test/m46-ops.test.ts` probe bodies |
| AC-12 | test/docs-rl12.test.ts, test/schemas.test.ts | docs, API table, version, generated files |

AC-07 seeds scheduled slots directly (`store.addSlot`) because producing `capacity` and
`no_machine` outcomes and an abandoned slot by ticks needs machines and a daemon; the counting under
test reads only the stored slots.
