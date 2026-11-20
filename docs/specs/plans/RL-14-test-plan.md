# RL-14 test plan

| AC | File | Tests |
|---|---|---|
| AC-01 | src/core/state-time.test.ts | `test_AC01_buckets`, `test_AC01_midnight_split`, `test_AC01_no_step_ended_placeholder`, `test_AC01_step_change`, `test_AC01_clock_back_and_clamp`, `test_AC01_state_since`, `test_AC01_apportion` |
| AC-02 | test/efficiency-hub.test.ts | `test_AC02_state_time_end_to_end` |
| AC-03 | test/efficiency-hub.test.ts | `test_AC03_same_body_twice_and_older`, `test_AC03_lost_reply_offline_restart` |
| AC-04 | src/core/state-time.test.ts, test/efficiency-hub.test.ts | `test_AC04_select_rules`, `test_AC04_cap_and_order`, `test_AC04_final_pending`, `test_AC04_no_leak_in_records`, `test_AC04_hub_strips_state_time`, `test_AC04_ended_kept_until_accepted`, `test_AC04_marks_cleared_on_hub_switch` |
| AC-05 | test/efficiency-hub.test.ts | `test_AC05_bad_entries_skipped`, `test_AC05_too_many_400` |
| AC-06 | test/efficiency-hub.test.ts | `test_AC06_card_figures` |
| AC-07 | test/efficiency-hub.test.ts | `test_AC07_absent_not_zero` |
| AC-08 | test/efficiency-hub.test.ts | `test_AC08_window_apportion`, `test_AC08_window_counts_filters` |
| AC-09 | test/efficiency-hub.test.ts | `test_AC09_window_params` |
| AC-10 | test/efficiency-hub.test.ts | `test_AC10_stuck_sessions`, `test_AC10_stuck_steps` |
| AC-11 | test/efficiency-hub.test.ts | `test_AC11_auth_no_writes_features` |
| AC-12 | src/store/hub-store.contract.test.ts | `test_AC12_step_time_upsert` (SQLite and Postgres legs); the copy of `step_time` by `test_AC04_tables_equal_migrated` (test/m46-ops.test.ts) |
| AC-13 | test/docs-rl14.test.ts | `test_AC13_docs` (and `test/schemas.test.ts` for the generated files) |
| AC-14 | test/efficiency-hub.test.ts | `test_AC14_take_over`, `test_AC14_cli_take_restart_reclaim`, `test_AC14_headless_held`, `test_AC14_drop_and_unknown` |
