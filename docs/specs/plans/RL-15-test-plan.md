# Test plan: docs/specs/RL-15.md

World tests use `calib-kit.ts` with its `pulses()` bridge (fires, ticks with `w.tick()`) and
`health-kit.ts` `stage()`; shared RL-15 helpers live in `test/helpers/overlap-kit.ts`.

| AC | File | Test(s) |
|---|---|---|
| AC-01 | src/core/sla.test.ts | `test_AC01_schemas` |
| AC-02 | src/core/sla.test.ts | `test_AC02_debrief_block`, `test_AC02_policy_errors` |
| AC-03 | test/overlap-hub.test.ts | `test_AC03_queue_replace_release`, `test_AC03_manual_trial`, `test_AC03_policy_change_pause_delete` |
| AC-04 | test/overlap-hub.test.ts | `test_AC04_supersede`, `test_AC04_held_busy_trial`, `test_AC04_max_goal_age` |
| AC-05 | test/overlap-hub.test.ts | `test_AC05_carry_partial`, `test_AC05_carry_complete_resolved`, `test_AC05_chain_and_when` |
| AC-06 | test/overlap-hub.test.ts | `test_AC06_sink_on_supersede` |
| AC-07 | test/sla-hub.test.ts, src/core/sla.test.ts | `test_AC07_events_attention`, `test_AC07_same_owner_no_escalation`, `test_AC07_sla_state_and_new_cycle` (unit) |
| AC-08 | test/sla-hub.test.ts | `test_AC08_auto_accept`, `test_AC08_session_decisions`, `test_AC08_claimed_none_trial` |
| AC-09 | test/sla-hub.test.ts | `test_AC09_revert` |
| AC-10 | test/sla-hub.test.ts | `test_AC10_health_breaches`, `test_AC10_trial_breach_only_with_include`, `test_AC10_queue_supersede_cards` |
| AC-11 | test/overlap-hub.test.ts | `test_AC11_default_and_features`; the pinned feature lists (test/health-hub.test.ts, test/m46-ops.test.ts) |
| AC-12 | test/pulse-cli.test.ts | `test_AC12_overlap_flag_and_queued_fire` |
| AC-13 | test/docs-rl15.test.ts, test/schemas.test.ts | docs mentions, generated files |

Fail-first: each World test is checked red with its guarding code removed (queue branch, abandon
exemption, carry union, auto-accept eligibility, trial exclusion, revert permission).
