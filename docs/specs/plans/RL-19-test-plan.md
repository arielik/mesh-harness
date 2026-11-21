# RL-19 test plan

| AC | File | Tests |
|---|---|---|
| AC-01 | `test/rollup-hub.test.ts` | `test_AC01_rows_counts_kind_pulse`: three pulses (relay-a alpha and beta, relay-b alpha), S1–S4, open/confirmed vs accepted (with and without link), a dismissed item not counted; exact rows and order |
| AC-02 | `test/rollup-hub.test.ts` | `test_AC02_latest_report`: two reports on the audit step, a later one on the validate step → the audit's second; a pair without a report; `pruned` after `pruneArtifacts` |
| AC-03 | `test/rollup-hub.test.ts` | `test_AC03_two_agents_one_row` |
| AC-04 | `test/rollup-hub.test.ts` | `test_AC04_target_repo_and_retarget` (own World, fixed t1 < t2, retarget to gamma; row-repo filters; a deleted pulse not named) |
| AC-05 | `test/rollup-hub.test.ts` | `test_AC05_window` (audit from a goal with no schedule, so no catch-up fires; boundary at exactly `since` and 1 ms before) |
| AC-06 | `test/rollup-hub.test.ts` | `test_AC06_trial`, `test_AC06_calibration_and_spot_check_goals` |
| AC-07 | `test/rollup-hub.test.ts` | `test_AC07_filters`, `test_AC07_400s` |
| AC-08 | `src/core/presets.test.ts`, `test/rollup-hub.test.ts` | `test_AC08_parse_and_text`, `test_AC08_presetKind`; `test_AC08_pulse_create_kind` (also ingest), `test_AC08_stored_invalid_kind_fires_and_updates` (also the AC-12 params-only update); the goal without a preset in `test_AC05_window` |
| AC-09 | `test/rollup-hub.test.ts` + pinned feature arrays | `test_AC09_scopes_on_behalf_no_writes` (also the `/healthz` features) |
| AC-10 | `src/store/hub-store.contract.test.ts` | `test_AC10_listReviews_since`, `test_AC10_listItemsIn`, `test_AC10_listArtifacts_steps` (SQLite and Postgres) |
| AC-11 | `test/docs-rl19.test.ts`, `test/schemas.test.ts` | `test_AC11_docs`, no cost field in the response schema |
| AC-12 | `test/rollup-cli.test.ts` | `test_AC12_pulse_add_bad_kind`, `test_AC12_pulse_add_kind_sent`, `test_AC12_preset_ls` |
