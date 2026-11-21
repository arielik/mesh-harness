# RL-20 test plan

| AC | File | Tests |
|---|---|---|
| AC-01 | `test/preset-check-hub.test.ts` | `test_AC01_valid_chain_steps_and_pins`: roster key + repo agent relay with a sink; exact keys, steps, pins; create 201 with the same pin |
| AC-02 | `test/preset-check-hub.test.ts` | `test_AC02_each_problem_class`: parse error, unknown dep, cycle, two first steps, gate first, unknown profile, unresolved key (no source; bad key syntax), missing `params.repo`, bad `kind`, policy, unknown `{param}`, 51 steps → `problems` equal create's 422 `details`; unknown sink, `ci/nightly`, `all` → create's 400 `error`; no pulse created |
| AC-03 | `test/preset-check-hub.test.ts` | `test_AC03_several_problems_in_create_order` |
| AC-04 | `test/preset-check-hub.test.ts` | `test_AC04_roster_and_repo_agent_warnings` (also `checkedAgents`, warnings with `ok: false`, same as create) |
| AC-05 | `test/preset-check-hub.test.ts` | `test_AC05_sha256` (check and create, non-ASCII text) |
| AC-06 | `test/preset-check-hub.test.ts` | `test_AC06_malformed_bodies` (not JSON, schema failures, 20 000 characters accepted) |
| AC-07 | `test/preset-check-hub.test.ts` | `test_AC07_scopes_on_behalf` |
| AC-08 | `test/preset-check-hub.test.ts` | `test_AC08_no_writes_no_events_no_replay` (every `hub-copy` table, events, no `idem` row, same key answers from state now) |
| AC-09 | `test/preset-check-hub.test.ts` | `test_AC09_pulse_detail_steps` |
| AC-10 | `test/docs-rl20.test.ts`, `test/schemas.test.ts`, pinned feature arrays | `test_AC10_route_and_read_flag`, `test_AC10_feature_sorted`, `test_AC10_no_cost_field`, `test_AC10_docs`; the OpenAPI file in `test_AC16_openapi_route` |
