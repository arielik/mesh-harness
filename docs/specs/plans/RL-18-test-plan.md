# RL-18 test plan

| AC | File | Tests |
|---|---|---|
| AC-01 | `src/hub/config.test.ts` | `test_AC01_spot_checks_config` |
| AC-02 | `src/core/spot-check.test.ts` | `test_AC02_u_is_the_hash`, `test_AC02_rate_and_minimum` |
| AC-03 | `test/spot-check-hub.test.ts` | `test_AC03_off_no_sampling`, `test_AC03_rate_one_goal_shape`, `test_AC03_not_sampled` |
| AC-04 | `test/spot-check-hub.test.ts` | `test_AC04_append_then_new_goal`, `test_AC04_cap_50`, `test_AC04_minimum_per_week`, `test_AC04_rate_half`, `test_AC04_catalog_checker` |
| AC-05 | `test/spot-check-hub.test.ts` | `test_AC05_route_checks`, `test_AC05_verdict_and_context` |
| AC-06 | `test/spot-check-hub.test.ts`, `test/spot-check-daemon.test.ts` | `test_AC06_done_gate`, `test_AC06_mcp_tool` |
| AC-07 | `test/spot-check-hub.test.ts` | `test_AC07_disagreements_open_calibration`, `test_AC07_mixed`, `test_AC07_done_counts_again` |
| AC-08 | `test/spot-check-hub.test.ts` | `test_AC08_decisions_and_share`, `test_AC08_spot_checks_total` |
| AC-09 | `src/core/spot-check.test.ts`, `test/health-hub.test.ts`, `test/m46-ops.test.ts`, `src/protocol/debrief.test.ts` | `test_AC09_preset_policy_tools`, `test_AC09_debrief_prompt`, the pinned feature arrays |
| AC-10 | `test/docs-rl18.test.ts` | `test_AC10_docs`; `test/schemas.test.ts` (generated files current) |
