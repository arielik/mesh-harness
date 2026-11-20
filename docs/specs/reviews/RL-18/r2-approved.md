Verdict: APPROVED | Round: 2 | Blocking-open: 0

# Review of the RL-18 spec, round 2

Cold review of `git diff 1173985 HEAD -- docs/specs/RL-18.md` (revision 2, commit f203e9f), with the
touched sections re-checked against `src/core/policy.ts` (`policyOf`, `INPUT_KEYWORDS`,
`validatePolicies`), `src/core/policy.test.ts:149-160`, `src/core/presets.test.ts:91-93`,
`src/cli/review-commands.ts` (`debriefPrompt`, `mesh debrief`), `src/hub/service.ts` (review tail
1395-1421, context inputs 1065-1090, health 4280-4290) and `src/hub/config.ts` (95-125, 180-193).

## Round-1 findings

| Id | Status | Reason |
|---|---|---|
| B1 | RESOLVED | Spec 162-167 names the change: the `consumes needs an earlier step …` check (`policy.ts:97`) is skipped for a debrief whose `inputs` include `spot-check`; the default `consumes` that `validatePolicies` adds (`policy.ts:46`) still satisfies `may_set needs consumes` (`policy.ts:92`), and the RL-4 `may_set`/`output` checks (`policy.ts:85-86`) pass with the preset's fields, so "reports nothing" (AC-09) is now true. The loop exclusions (`policy.test.ts:153`, `presets.test.ts:93`) and a negative case (ordinary debrief still errors) are in AC-09. The team-plan question is not answered explicitly; see N1 (non-blocking). |
| S1 | RESOLVED | AC-04 now says `rate: 0.5, min_per_week: 0` (spec 342). |
| S2 | RESOLVED | Sampling runs after `calibrationAfterDismissal` (spec 98-99), matching its place at `service.ts:1421`; `spot-check.opened` follows the goal-creation events (spec 130-131). |
| S3 | RESOLVED | `mesh debrief` uses a spot-check prompt, read from `policy.inputs` of the `GET /v1/steps/<step>` call it already makes (`review-commands.ts:73`); `debriefPrompt(step, spotCheck?)` signature and a unit test in AC-09. |
| S4 | RESOLVED | AC-05 lists `403 another user's sid` in route order. |
| S5 | RESOLVED | `spotChecks` "always present (zeros when spot checks are off or none exist)" (spec 294). |
| S6 | RESOLVED | YAML `null` means the defaults (spec 84-85); AC-01 covers "an empty value". Implementable next to `calibration` (`config.ts:103`) with a nullish/preprocess schema. |
| S7 | RESOLVED | Reads once per record, kept up to date as samples are taken; an unresolved checker leaves the minimum unmet (spec 110-112). |
| S8 | RESOLVED | Failed check step: goal stays open, samples stay open, next sample opens a new goal, owner may drop it (spec 217-219). Consistent with "open" = not done/dropped (spec 70, 72). |
| S9 | RESOLVED | The keyword and the debrief behaviour are now separate sentences (spec 169-171). |
| S10 | RESOLVED | The input sits in the `inputs` loop like `calibration`, i.e. after `if (paging || full || served >= MAX_ALL) continue;` (`service.ts:1074`), stated at spec 181-182. |
| S11 | RESOLVED | AC-06 adds "with the hub offline → the offline tool error text". |

## New findings (non-blocking)

**N1. The B1 exemption is keyed on `inputs`, so any plan may use it.** Spec 162-164 exempts every
debrief whose `inputs` include `spot-check`, not only the built-in preset. A team plan may therefore
declare such a step with no run; at runtime its goal has no `spotCheck`, so it gets no `spot-check`
input (spec 178-179), the verdict route answers 409 `not a spot-check step` (spec 197) and the done gate
does not apply, i.e. an empty person debrief. Harmless, but say it in one sentence (or restrict the
exemption to plans instantiated from the `spot-check` preset) so the implementer does not add a
plan-time refusal and AC-09 does not get an untested branch.

**N2. The spot-check prompt is wrapped across source lines (spec 172-175).** In Markdown a code span's
line breaks render as spaces; the `debriefPrompt` unit test of AC-09 should compare against the
single-line text (one space at each wrap). Worth a note, since an implementer copying from the raw file
may keep the newlines.
