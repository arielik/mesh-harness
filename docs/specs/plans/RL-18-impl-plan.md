# RL-18 implementation plan

Spec: `docs/specs/RL-18.md` (approved, round 2).

| Area | File | Change |
|---|---|---|
| Types | `src/protocol/goal.ts` | `SpotVerdict`, `SpotSample`, `GoalSpotCheck`; `Goal.spotCheck`; `GoalCalibration.disagreements` |
| Types | `src/protocol/hub.ts` | `SpotCheckRequest`, `SpotCheckResult`; `PulseHealth.decisions`, `humanDecisionShare`; `HealthTotal.decisions`, `humanDecisionShare`, `spotChecks`; `HUB_FEATURES` + `spot-checks` |
| Config | `src/hub/config.ts` | `spot_checks` (nullable → defaults, refine both 0); `HubConfig.spotChecks` |
| Pure | `src/core/spot-check.ts` (new) | `spotU`, `spotWhy`, `recentSamples`, `spotCheckGoals`, `countedDisagreements`, `disagreementStatus`, `uncalibratedDisagreements`, `openSpotChecks` |
| Presets, policy | `src/core/presets.ts`, `src/core/policy.ts` | `SPOT_CHECK_PRESET` after `calibrate`; `INPUT_KEYWORDS` + `spot-check`; consumes-run exemption for a spot-check debrief |
| Hub | `src/hub/service.ts` | `submitReview`: rule-2 set, `spotCheckSample` after `calibrationAfterDismissal`; `spotCheckTarget`, `spotCheckVerdict`, `spotCheckInput`, `decisionDetail`; `createWithPlan` gains `spotCheck`; done gate in `doneStep`; calibration trigger counts disagreements, goal/comment/payloads, `calibratorFor` takes the newest ref, `calibrationInput` lists disagreements; health `decisions`, `humanDecisionShare`, `spotChecks`; `describe()` texts |
| Routes | `src/hub/app.ts`, `src/protocol/hub-api.ts` | `POST /v1/steps/:id/spot-checks` |
| MCP | `src/protocol/tools.ts`, `src/daemon/tools.ts` | `mesh_spot_check` (redaction, never queued); spot-check brief line |
| CLI | `src/cli/review-commands.ts` | `debriefPrompt(step, spotCheck)` |
| Skill | `src/protocol/skill.ts` | `## Spot checks` in `MESH_DEBRIEF_SKILL` |
| Docs | `docs/guide/concepts.md`, `install.md`, `operations.md`, `docs/events.md`, `docs/plan/implementation-plan.md` | as the spec |

No migration: everything new lives in goal JSON values and YAML config.
