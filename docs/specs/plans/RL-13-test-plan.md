# Test plan: docs/specs/RL-13.md

| AC | File | Test(s) |
|---|---|---|
| AC-01 | test/commits-hub.test.ts | `test_AC01_head`, `test_AC01_no_cached_context` |
| AC-02 | test/commits-hub.test.ts | `test_AC02_branch_local_then_origin`, `test_AC02_unknown_or_revision_branch`, `test_AC02_no_commits_and_no_checkout`, `test_AC02_other_repo`, `test_AC02_cwd_moved_to_other_repo` |
| AC-03 | test/commits-hub.test.ts | `test_AC03_explicit_wins_and_lowercased`, `test_AC03_malformed_fails_tool`, `test_AC03_hub_refuses_malformed` |
| AC-04 | test/commits-hub.test.ts | `test_AC04_offline_done_keeps_commit` |
| AC-05 | test/commits-headless.test.ts | five `test_AC05_*` cases (Relay + fake claude; push failure via `holdingRunner`) |
| AC-06 | test/commits-hub.test.ts | `test_AC06_run_report` |
| AC-07 | test/commits-headless.test.ts | `test_AC07_rows_and_stages` |
| AC-08 | test/commits-hub.test.ts | `test_AC08_record_and_schema` |
| AC-09 | test/commits-hub.test.ts | `test_AC09_show` |
| AC-10 | test/commits-hub.test.ts, test/docs-rl13.test.ts, test/m46-ops.test.ts, test/schemas.test.ts | features, docs, skill, version |
