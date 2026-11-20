# RL-16 test plan

| AC | File | Tests |
|---|---|---|
| AC-01 | `test/profile-fit.test.ts` | `test_AC01_order_reasons_rules` |
| AC-02 | `test/profile-fit.test.ts` | `test_AC02_small_and_share` |
| AC-03 | `test/profile-fit.test.ts` | `test_AC03_refused_mesh_tool`, `test_AC03_refused_rule_limit`, `test_AC03_already_allowed_and_not_a_word`, `test_AC03_glob_deny_and_server_allow` |
| AC-04 | `test/profile-fit.test.ts` | `test_AC04_drops_and_holds`, `test_AC04_few_tool_runs_and_runs_without_toolsUsed` |
| AC-05 | `test/profile-fit-hub.test.ts` (+ unit `test_AC05_hashes_unit`) | `test_AC05_hashes_window_trial` |
| AC-06 | `test/profile-fit-hub.test.ts` (+ unit `test_AC06_cap_unit`) | `test_AC06_reply_equals_fitProfile_and_cap` |
| AC-07 | `test/profile-fit-hub.test.ts`; feature pins in `test/m46-ops.test.ts`, `test/health-hub.test.ts` | `test_AC07_errors_access_no_writes_feature` |
| AC-08 | `test/profile-fit-cli.test.ts` | `test_AC08_text_lines`, `test_AC08_query_json_and_no_write`, `test_AC08_small_empty_builtin`, `test_AC08_builtin_hint`, `test_AC08_refused_and_usage` |
| AC-09 | `test/docs-rl16.test.ts`, `test/schemas.test.ts` | `test_AC09_concepts`, `test_AC09_guides_api_skill` |

Fixtures: the unit tests build telemetry literals; the World tests use the RL-6 `calib-kit.ts`
(`Ck.goal`, `Ck.run` with telemetry carrying `profile` and `profileHash`, profiles saved through
`POST /v1/profiles`, a trial goal through a pulse's trial fire).
