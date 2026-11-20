# Test plan: docs/specs/RL-11.md

Spec: RL-11 revision 4. Tests are written from the spec's contracts and run with `pnpm check`.

| AC | Test | File |
|---|---|---|
| AC-01 | `test_AC01_with_result`, `test_AC01_partial`, `test_AC01_none`, `test_AC01_cut_and_cap` | `src/core/telemetry.test.ts` |
| AC-02 | `test_AC02_grouping`, `test_AC02_no_word`, `test_AC02_none`, `test_AC02_cap`, `test_AC02_passes_hub_validation` | `src/core/telemetry.test.ts` |
| AC-03 | `test_AC03_machine_and_fields`, `test_AC03_invalid_lists` | `test/runs-hub.test.ts` |
| AC-04 | `test_AC04_rows` (every `RunRow` field of the audit row with `toStrictEqual`; the `killed_budget`/`fail` and `no_result`/`done` rows; no row for a round without telemetry), `test_AC04_all_dismissed_now` | `test/runs-hub.test.ts` |
| AC-05 | `test_AC05_filters` (every filter, ISO `Z` and `+02:00`, the 30-day default, `until` alone), `test_AC05_400` (every message of the table) | `test/runs-hub.test.ts` |
| AC-06 | `test_AC06_paging` (5 rows, rows 2 and 3 tie and are split by the page boundary) | `test/runs-hub.test.ts` |
| AC-07 | `test_AC07_scope` | `test/runs-hub.test.ts` |
| AC-08 | `test_AC08_marks_and_events`, `test_AC08_for_person`, `test_AC08_error_path_keeps_trial`; CLI `test_AC08_fired_and_plain`, `test_AC08_missed`, `test_AC08_help` | `test/trial-hub.test.ts`, `test/trial-cli.test.ts` |
| AC-09 | `test_AC09_trial_goal_does_not_block`, `test_AC09_trial_fire_skipped_by_normal_goal`; CLI `test_AC09_skipped_names_the_running_goal` | `test/trial-hub.test.ts`, `test/trial-cli.test.ts` |
| AC-10 | `test_AC10_default` (every field with `toStrictEqual`), `test_AC10_include`, `test_AC10_400` | `test/trial-hub.test.ts` |
| AC-10b | `test_AC10b_reinstated_by_the_dismissal_goal` | `test/trial-hub.test.ts` |
| AC-11 | `test_AC11_trial_dismissals_never_count`, `test_AC11_calibrator_skips_trial_goals` | `test/trial-hub.test.ts` |
| AC-12 | `test_AC12_trial_rows` | `test/runs-hub.test.ts` |
| AC-13 | `test_AC13_markers` | `test/trial-cli.test.ts` |
| AC-14 | the probe tests, updated to the new bodies (`/health`, `/healthz`, `/readyz` ready, not ready, database gone, Postgres) | `test/m46-ops.test.ts` |
| AC-15 | `test_AC15_concepts`, `test_AC15_guide`, `test_AC15_operations`, `test_AC15_events_api_skill`; the generated files | `test/docs-rl11.test.ts`, `test/schemas.test.ts` |
| AC-16 | `package.json` 0.1.30; `pnpm check` | CI |

Fixtures: the RL-6 `calib-kit` (goals, records, checker dispositions, a person's debrief), the RL-3
`pulse-kit` (pulses, fires, bare machines with `headless: true`, `storeWrap` for the error path), a
three-stage preset (`audit` → `validate` → `debrief`) fired as a trial so trial goals carry records.
