# RL-17 test plan

Spec: [RL-17](../RL-17.md). World tests use `calib-kit.ts` (with its pulse and roster kits) and a
controlled clock.

| AC | File | Tests |
|---|---|---|
| AC-01 | `test/changes-hub.test.ts` | `test_AC01_profile_timeline` |
| AC-02 | `test/changes-hub.test.ts` | `test_AC02_agent_timeline_from_runs` |
| AC-03 | `test/changes-hub.test.ts` | `test_AC03_catalog_and_pins` (first push per definition, unchanged re-push not a sighting, pin sighting, `pulse.created` / `pulse.updated` payloads) |
| AC-04 | `test/changes-hub.test.ts` | `test_AC04_preset_timeline` (event sightings, then goal sightings under `repo`) |
| AC-05 | `test/changes-hub.test.ts` | `test_AC05_trial`, `test_AC05_repo`, `test_AC05_previous_under_since`, `test_AC05_pruned_event` |
| AC-06 | `test/changes-hub.test.ts` | `test_AC06_paging`, `test_AC06_400s` |
| AC-07 | `test/changes-hub.test.ts` | `test_AC07_compare_runs` (exact sides; agreement with `GET /v1/runs` under `since`, `until`, `repo`, `trial=include`; unknown hash) |
| AC-08 | `test/changes-hub.test.ts` | `test_AC08_compare_items_agree_with_stats` (both trial values; `until`; `repo`); `test/calibration-hub.test.ts` unchanged and passing |
| AC-09 | `test/changes-hub.test.ts` | `test_AC09_compare_400s` |
| AC-10 | `test/changes-hub.test.ts` | `test_AC10_scopes_no_writes_features`; feature pins in `test/m46-ops.test.ts`, `test/health-hub.test.ts` |
| AC-11 | `test/docs-rl17.test.ts`, `test/schemas.test.ts` | `test_AC11_concepts`, `test_AC11_events_operations_plan_api`; generated files up to date |
