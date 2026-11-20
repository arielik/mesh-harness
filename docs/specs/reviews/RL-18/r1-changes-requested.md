Verdict: CHANGES REQUESTED | Round: 1 | Blocking-open: 1

# Review of the RL-18 spec, round 1

This is a cold review of `docs/specs/RL-18.md` (commit 1173985 on `spec/RL-18`). I read the source item
(`docs/analysis/2026-11-19-harness-efficiency-and-insights.md`: I-9 at line 225, §5 decision 4 at line 355,
§6) and checked each contract against the code it touches:
- `src/hub/service.ts`: `deciderOf` and `submitReview` (1196-1425: the disposition loop, the RL-6
  person-precedence branch at 1262-1266, `applyDisposition` at 1440, the `item.disposed` emits and
  `calibrationAfterDismissal` at 1407-1421); `disposeStep` (1693); `debriefData`, `debriefView`,
  `debriefs` (1534-1690); context inputs (1066-1090); `doneStep` (2663-2760); `createWithPlan` (3616);
  `calibrationScan`, `catalogDefOf`, `calibratorFor`, `calibrationTrigger`, `markGoalDone` (3677-3820);
  `health` (4099-4295); `calibrationInput` (4334); the activity texts (6000-6016); `CardCtx` (6058).
- `src/core/calibration.ts` (`countedDismissals`, `calibrationStatus`, `uncalibrated`,
  `openCalibration`), `src/core/policy.ts` (`policyOf`, `INPUT_KEYWORDS`, `validatePolicies`),
  `src/core/review.ts` (`isRaising`, `runOf`), `src/core/presets.ts` (`CALIBRATE_PRESET`,
  `BUILTIN_PRESETS`).
- `src/protocol/review.ts` (`DispositionVia`, history entries, `DispositionRow`), `goal.ts`
  (`DismissalRef`, `GoalCalibration`, `Goal`), `hub.ts` (`HUB_FEATURES`); `src/hub/config.ts`;
  `src/daemon/tools.ts` (`brief()` at 155, `mesh_dispose` at 508); `src/cli/review-commands.ts`
  (`debriefPrompt`, `mesh debrief`).
- `test/helpers/calib-kit.ts`, `world.ts` (settable `clock`, `hubYaml`), and the preset loops in
  `src/core/policy.test.ts:153` and `src/core/presets.test.ts:93`.

Names in the spec are generic (`alpha`, `V`, `<key>@<hash12>`), so the public-boundary rule holds.
Every finding is **NEW**.

## What holds

- **Every agent decision goes through `submitReview`.** The only other writers of disposition entries
  are `disposeStep` (person decider, `service.ts:1726`) and the UI revert (`kind: "revert"`,
  `service.ts:1775`), so "applied by `POST /v1/steps/:id/review`, `via: "stage"`" catches validators and
  filers and nothing else. `deciderOf` (`service.ts:1196`) gives `agent` only to headless steps, with
  `hash` only when the upload names one, so `hash ?? ""` is the right test.
- **The RL-6 rule 2 exclusion is implementable.** Rule-2 dispositions are pushed to `toApply` from a
  distinct branch (`service.ts:1262-1266`); the implementer tags them there. Ignored ones go to `ignored`
  and never reach `applyDisposition`, so "not decisions" is already true.
- **The sampling rule is deterministic and well-defined.** `(lineage, fp, step, round)` is unique per
  decision (one record per step and round, `listed twice` refused at 1252); `JSON.stringify` of three
  strings and an integer is canonical; 8 hex digits / 2^32 is in `[0, 1)`. The minimum is a rolling
  7-day count over samples (in any goal state) and is fixed by history order; "earlier in the same
  record count" removes the only ordering ambiguity.
- **A debrief without a run works.** `debriefData` returns `{items: []}` when `runRecordOf` finds no run
  (`service.ts:1541`), `debriefs` lists it with `items: 0`, `submitReview` accepts a non-raising record
  with `items: []` and `dispositions: []` (no problem is pushed for an empty list), and consuming steps
  are skipped only through `when` (`service.ts:1172-1184`), which the preset does not set.
- **Never offered, assignee only.** `isDebrief` stops offers (`service.ts:665`) and
  `refuseNonAssignee` stops other claimers (`service.ts:1520`); `@owner` resolves at check time.
- **Calibration stays separable.** A validator's dismissal entry is at the same time a counted
  dismissal of the raising auditor (`countedDismissals`, `calibration.ts:112`) and, when sampled and
  disagreed with, a counted disagreement of the validator; the spec keeps the two on separate lists
  with separate status, so `calibrationStatus` (`calibration.ts:153`) needs no change for RL-6 and
  `GoalCalibration.dismissals` may be `[]` (`goal.ts:97`, no `.min`). `calibratorFor` (3733) reads
  only `list.at(-1).ref`, so "newest dismissal, else newest disagreement" is a small change.
- **Health reads.** Per-pulse decisions come from `ctx.history(lineage)` that health already reads for
  `accepted` (`service.ts:4204-4207`); `goals` is already filtered by `counted` (4133), so trial
  follows `accepted`. Spot-check goals come from `allGoals` (4118), as `calibrations` does (4285).
- **Owner rules.** No composite score (counts plus the one named ratio the item asks for); no CI data;
  config is hub-wide with reasons given; the default is off with a reason (upgrade must not add person
  steps). Every requirement of I-9 is present: config location and defaults, sampling rule, per-week
  minimum, goal and step shape with assignee, how verdicts are recorded, trial exclusion,
  `humanDecisionShare` with numerator and denominator per pulse and in total, open spot checks with
  the oldest wait, both events, and the `/healthz` feature.
- **Testability.** `calib-kit.ts` already has a validator `CHECK@V` as a headless consuming stage
  (`agentDispose`, line 118), `world.ts` has a settable `clock` (103) and `hubYaml` (117), so the
  3-day/8-day minimum test and the config switch are writable.

## Blocking

**B1. The `spot-check` preset fails `validatePolicies`, so AC-09 cannot pass as written, and the spec
does not say which rule changes.** Spec lines 145-156 give the one step `mode: debrief`,
`may_set: [confirmed]`, no `consumes`, no `deps`; AC-09 (spec line 323) requires "`validatePolicies`
reports nothing for it". `validatePolicies` first gives a debrief without `consumes` the default
`[open, confirmed]` (`policy.ts:45`; `policyOf` does the same at runtime, `policy.ts:19-22`), and then
checks `if (s.consumes && !runOf(s, steps, (x) => x)) errors.push("…consumes needs an earlier step with
output: review-record that raises items (through deps)")` (`policy.ts:97`). A single step with no deps
has no run, so the preset gets that error. Leaving `may_set` out is not an option either: RL-4 requires
it of a debrief (`policy.ts:86`). One implementer will add an exception to `validatePolicies`, another
will drop the clause from the test; both readings fit the spec. The spec must name the change, e.g.
"`validatePolicies`: the run check (`consumes needs an earlier step …`) does not apply to a debrief
step whose `inputs` include `spot-check`", and say whether a team plan may use `inputs: [spot-check]`
(with `INPUT_KEYWORDS` it is accepted, and gives no input outside a goal with `spotCheck`). Related
and part of the same fix: the existing "all built-ins" loops exclude presets by name
(`policy.test.ts:153`, `presets.test.ts:93`); `spot-check` needs params (`agent`, `hash`) like
`calibrate`, so the spec should say it joins those exclusions and gets its own test (as RL-6 AC-03 does
for `calibrate`, `presets.test.ts:150-170`), including the `BUILTIN_PRESETS` order assertion at
`presets.test.ts:163`.

## Suggestions

**S1. AC-04's rate case collides with the default minimum.** `{rate: 0.5}` gets `min_per_week: 1`
(spec line 81), so the first decision with `u ≥ 0.5` is sampled `minimum`. "Exactly the decisions whose
`u < 0.5` are sampled with `why: "rate"`" still holds, but a test that counts samples will not. Say
`rate: 0.5, min_per_week: 0` in AC-04 (spec line 318).

**S2. The order of writes and events in the review transaction.** Sampling runs "after … `item.disposed`
events emitted" (spec line 96), but `calibrationAfterDismissal` also runs there (`service.ts:1421`) and
may create a calibration goal. Which runs first decides goal ids and event order, which World tests may
assert. Also, for a new spot-check goal, say whether `spot-check.opened` follows `goal.created` and the
plan events (it should: the step must exist for `step` in the event).

**S3. `mesh debrief <step>` starts a spot check with the RL-4 prompt.** `debriefPrompt`
(`src/cli/review-commands.ts:36-38`) tells the session to "go through the items … Record each decision
with mesh_dispose". The brief line changes (spec line 213) and the skill section covers it, but the first
user message contradicts both. Either give a spot-check prompt when the step's `inputs` include
`spot-check` (the CLI has the step view), or state that the prompt is unchanged on purpose.

**S4. AC-05 skips check 5.** The route lists nine checks (spec lines 176-184); AC-05 (line 319) lists
eight and omits "`sid` of another user's session → 403". Add it, as RL-4's dispose tests do.

**S5. `HealthTotal.spotChecks` when spot checks are off.** The table (spec line 270) and Compatibility
(line 302) imply it is always present, `{open: 0, decided: 0, disagreed: 0}`. Say so explicitly, so
clients need no feature check for it and AC-08 can pin the off case.

**S6. YAML `spot_checks:` with no value.** It parses as `null`, not `{}`. Say whether that means the
defaults (as AC-01's `{}`) or a config error, and add it to AC-01.

**S7. Sampling cost per record.** The minimum rule needs every spot-check goal of the agent on every
eligible decision not picked by the rate (a `listGoals()` per record when on), and a decision whose
checker cannot be found stays unsampled, so the minimum retries (and, on a new goal, `calibratorFor`
rule 2 scans all steps) on every later decision of that agent. Acceptable at today's volumes, as
`calibrationAfterDismissal` already scans per dismissal, but say once that the reads are per record,
not per decision, so an implementer does not read the goal list inside the per-decision loop.

**S8. A check step that ends `failed`.** With no record, `mesh_done` with outcome `fail` goes through
`judgeDone` (`service.ts:2745`); the goal then stays open with samples without a verdict, `open` in
health keeps counting them, and new samples go to a new goal. That is defensible, but say it (or that
the owner drops the goal), so the behavior is not a surprise.

**S9. Wording at spec line 155.** "`INPUT_KEYWORDS` gains `spot-check`. So the check step is never
offered, only its assignee can claim it …" reads as if the keyword caused those. The keyword only
stops `validatePolicies` from treating `spot-check` as a step id (`policy.ts:79`); never offered and
assignee-only come from `mode: debrief` (`service.ts:665`, `1520`). Split the sentence.

**S10. The `spot-check` input and paging.** In the context builder the `calibration` input sits after
`if (paging || full || served >= MAX_ALL) continue;` (`service.ts:1074`), so a call with `items_from`
or past the cap omits it. Say the `spot-check` input sits in the same place (or not), since 50 samples
with evidence can be large and `truncated` is the only signal the spec gives.

**S11. `mesh_spot_check` offline text.** AC-06 tests the reply texts and redaction but not the
never-queued offline error (spec line 207). Add it; `mesh_dispose` has the same path
(`src/daemon/tools.ts:519`).
