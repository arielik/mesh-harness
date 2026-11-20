Verdict: APPROVED | Round: diff-1 | Blocking-open: 0

# RL-18 diff review, round 1 (commit 34555e3)

Cold review of `git show 34555e3` against `docs/specs/RL-18.md` (r3) and
`docs/specs/plans/RL-18-test-plan.md`.

The source matches every contract I checked:

- config (`src/hub/config.ts:106-112`: null gives the defaults, both values 0 are refused with the spec's text)
- the sampling rule and eligibility (`service.ts:1446-1450`: agent decider with a hash, not trial, applied, not RL-6 rule 2; runs after `calibrationAfterDismissal`)
- `u` (`core/spot-check.ts:14`) and the minimum over goals in any state, counting samples taken earlier in the same record
- appending to the oldest open goal whose check step is `ready` and has fewer than 50 samples. When no checker resolves, the decision is skipped and the minimum stays unmet.
- goal fields and the plan comment
- the order of the event after goal creation
- the nine verdict route checks, in order, with their texts
- the effect of a verdict, and the trigger after `disagree`
- the done gate (`service.ts:2742`), which skips close-as-fail
- the MCP tool and the daemon brief line
- the CLI prompt
- calibration:
  - the trigger counts dismissals plus disagreements
  - the disagreement status list is kept separate from dismissals
  - calibrator selection uses the newest listed dismissal, else the newest listed disagreement
  - the comment, payload and input gain `disagreements` only when there are any, so RL-6 output is unchanged
- health:
  - decisions are counted per pulse goal in the window, with trial filtering
  - `humanDecisionShare` is absent when there are 0 decisions
  - `total.spotChecks` is taken over all goals, whatever the filters say
- events and activity texts
- `HUB_FEATURES`
- docs and the generated files

All RL-18 tests pass, along with the related existing suites (183 passed). The hub and daemon tests also pass with `MESH_TEST_PG_URL` set.

## Mutation table

Each mutation was applied on a scratch copy outside the worktree
(`/tmp/claude-1015/-home-ghost2-vpc-devel-mesh-harness/1309aed3-426f-4a87-8d98-c622fcf70a9b/scratchpad/mut`, using `scratchpad/mutate.py` in the same directory). I then ran the RL-18 test files and reverted the change.

| # | Mutation | Caught by |
|---|---|---|
| M1 | drop the RL-6 rule-2 exclusion (`agreeing`) in submitReview | `test_AC03_not_sampled` |
| M2 | drop the trial check for sampling | `test_AC03_not_sampled` |
| M3 | minimum rule ignores `recent` | `test_AC04_minimum_per_week`, `test_AC02_rate_and_minimum` |
| M4 | drop the done gate | `test_AC06_done_gate` |
| M5 | calibration trigger ignores disagreements | `test_AC07_disagreements_open_calibration`, `test_AC07_mixed`, `test_AC07_done_counts_again` |
| M6 | health drops `byPeople` counting | `test_AC08_decisions_and_share` |
| M7 | drop the `expected === sample.disposition` check | `test_AC05_route_checks` |
| M8 | daemon `mesh_spot_check` without redaction | `test_AC06_mcp_tool` |
| M9 | append to a claimed goal (no `ready` check in spotCheckTarget) | `test_AC04_append_then_new_goal`, `test_AC07_done_counts_again` |
| X1 | drop the empty-hash exclusion | `test_AC03_not_sampled` |
| X2 | ignore the 50-sample cap | `test_AC04_cap_50` |
| X3 | `spotChecks.decided` ignores the window | `test_AC08_spot_checks_total` |
| X4 | done gate also applies to close-as-fail | **survived** (S2) |
| X5 | disagreement status ignores done calibration goals | `test_AC07_done_counts_again` |
| X6 | no calibration trigger after `disagree` | the three AC-07 tests |
| X8 | health counts decisions of goals outside the pulse | `test_AC08_decisions_and_share` |
| X9 | spot-check goal created from the wrong preset | 10 hub tests |
| X10 | newest open goal chosen instead of oldest | **survived** (S1) |
| X11 | daemon brief without the spot-check line | `test_AC06_mcp_tool` |
| X12 | drop the `validatePolicies` exemption | `test_AC09_preset_policy_tools` |
| X13 | `mesh debrief` never passes the spot-check flag | **survived** (S3) |

All nine requested mutations are caught. The three survivors are edge paths that the ACs do not name, so they are suggestions, not blockers.

## Findings

No blocking findings.

S1. **The "oldest" goal choice is untested** (`src/hub/service.ts:4545`). Two open goals of the same agent can both have a `ready` check step. This happens when a person releases a claimed check step after a second goal was opened. A test could claim goal A, sample into a new goal B, release A, then sample again; the sample must go to A. Reversing the sort survives the current tests.

S2. **The done gate's close-as-fail exemption is untested** (`src/hub/service.ts:2742`). The spec says the gate is "not for close-as-fail", and a failed check step is the spec's way to leave the goal open. A test could close a check step that has an undecided sample with `closeAsFail: true` and expect `failed`, not 409.

S3. **`mesh debrief` reading `policy.inputs` is untested** (`src/cli/review-commands.ts:80`). AC-09 asks only for the `debriefPrompt` unit test, which passes. Nothing checks that the command passes the flag for a check step. A CLI-level test, as for the RL-4 prompt, would close this gap.

S4. `spotCheckSample` works out the decision goal from the step id (`step.slice(0, step.indexOf("."))`, `src/hub/service.ts:4492`). The caller already has `goal.id`, so pass it in and avoid depending on the shape of step ids.

S5. Cosmetic: in the `spot-check` input, `state` comes after `evidence` (`src/hub/service.ts:4624`, after `...d.item`). The spec lists it before `evidence`. JSON consumers are not affected.
