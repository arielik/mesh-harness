# RL-21 test plan

All in `test/step-assign-for.test.ts` unless noted; World through `test/helpers/pulse-kit.ts`
(bare machines and syncs) and `relay-kit.ts` (a real daemon and fake claude for AC-14).

| AC | Tests |
|---|---|
| AC-01 | `test_AC01_scope_required` |
| AC-02 | `test_AC02_header_required` |
| AC-03 | `test_AC03_unknown_person` |
| AC-04 | `test_AC04_own_machine_attributed` |
| AC-05 | `test_AC05_other_machine_every_form` |
| AC-06 | `test_AC06_own_session`, `test_AC06_session_not_yours` |
| AC-07 | `test_AC07_admin_grants_nothing` |
| AC-08 | `test_AC08_step_refusal_codes`, `test_AC08_debrief_code`; existing pins in assign, suggest, debrief-hub and relay-hub tests gain `code` |
| AC-09 | `test_AC09_act_for_options` |
| AC-10 | `test_AC10_suggest_only_persons` |
| AC-11 | `test_AC11_headless_override_offer` |
| AC-12 | `test_AC12_override_refusals`, `test_AC12_pinned_profiles` |
| AC-13 | `test_AC13_override_own_machine_only` |
| AC-14 | `test_AC14_override_runs_headless` in `test/step-assign-for-run.test.ts` (relay-kit) |
| AC-15 | `test_AC15_no_act_for_elsewhere` |
| AC-16 | `test_AC16_idempotency_per_person` |
| AC-17 | `test_AC17_codes_additive_feature_docs` (+ the feature pins in other tests) |
| AC-18 | `test_AC18_headless_offer_not_accepted_into_session` |
| AC-19 | `test_AC19_run_held_narrow` |
| AC-20 | `test_AC20_profile_choice` |
| AC-21 | `test_AC21_suggest_round_trip` |
| AC-22 | `test_AC22_offer_text_via` |
