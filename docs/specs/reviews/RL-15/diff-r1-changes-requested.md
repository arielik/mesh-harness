Verdict: CHANGES REQUESTED | Round: 1 | Blocking-open: 1

# Diff review RL-15, round 1 (commit f36d2ce)

Reviewed `git show f36d2ce` against docs/specs/RL-15.md (revision 3, approved) and
docs/specs/plans/RL-15-impl-plan.md / RL-15-test-plan.md. Full suite: 126 files, 2790 passed,
103 skipped; `tsc --noEmit` clean; test/schemas.test.ts green (generated files current).

Most of the work is right. The fire order (insert, retire, abandon with the supersede exemption,
then overlap) matches the table. The trial-fire downgrade to `skip`, queue/replace/release, supersede
(carry, then sink, then drop, then event), the debrief set used by `debriefData`, `holdsFor`,
`disposeStep` and `submitReview`, the SLA tick (with `updatedAt` kept through `saveStepIf`),
auto-accept eligibility, the revert vias and permission, attention, health and run cards all follow
the contracts. Backward compatibility holds: the default is `skip`, `blockedBy` is unchanged for
`skip`, and a preset without `debrief:` renders without the key. The owner rules hold too: the hub
has no composite score (the only "score" hits are "scorecard"), and the docs name no company or team.

## Findings

1. **BLOCKING: AC-07 "a reopened debrief is overdue again from its new `since`" is untested in
   the tick.** The tick resets its bookkeeping at src/hub/service.ts:5622
   (`let next = prev?.since === sla.since ? { ...prev } : { since: sla.since };`, spec "Debrief SLA
   (tick)" step 1). Mutation M10 replaces it with `prev ? { ...prev } : …`, so a reopened debrief
   never emits `debrief.overdue` again. It survives every test. The only new-cycle test is the pure
   unit `test_AC07_sla_state_and_new_cycle` (src/core/sla.test.ts:99). That test checks that
   `slaState` moves `since`, not that the hub re-emits. This commit also edited the approved AC-07
   text to "(unit: `slaState`)" (docs/specs/RL-15.md:373), which narrows the agreed World surface
   without a review round. Fix: add a World test to test/sla-hub.test.ts. Reopen a breached
   debrief (for example by re-running validate so `cycleReadyAt` moves), tick past the new
   `since + sla`, and assert a second `debrief.overdue {to: assignee, since: <new>}` and the new
   `overdue.since`. Then revert the AC-07 wording or have it re-approved.

2. non-blocking: **The commit edits the approved spec.** docs/specs/RL-15.md lines 370 (AC-04:
   T is now fired after slot 1 and `superseded` = `[T, G1]`), 373 (AC-07, see 1) and 375 (AC-09:
   the 409 case is now "a later goal's complete audit resolves it" instead of "a stage record of a
   later goal"). The AC-04 change fixes a real contradiction: a trial goal fired before slot 1 would
   already be superseded by slot 1. The AC-09 change still exercises the 409 path. Even so, changes
   to an approved spec belong in a spec revision that is reviewed, not inside the implementation
   commit. Record them in the spec's Status line, or as revision 4.

3. non-blocking: **A non-trial fire that creates a goal and replaces a queued slot is untested.**
   src/hub/service.ts:5444 (spec "Queue", last sentence). Mutation M15 removes the line and survives.
   Without it, a manual fire made after the running goal ends but before the next tick creates a
   goal, and the old queued slot then waits behind that new goal and runs it twice. Suggest
   extending `test_AC03_manual_trial` with a non-trial manual fire at the point where it makes the
   trial fire: assert the queued slot becomes `skipped` with `replacedBy` set to the fired slot.

4. non-blocking: **The "never auto-accepted again by D" guard is not discriminated.**
   src/hub/service.ts:5667. Mutation M8 removes it and survives. A revert writes a `kind: "revert"`
   history entry, so the latest `disposition` entry is still the auto-accept (`accepted`), and the
   agent-`confirmed` check already refuses E. AC-09 "the next ticks do not accept E again" therefore
   passes either way. The guard only matters once an agent confirms E again after the revert. A test
   for that case would pin it (optional, since the AC as written is met).

5. non-blocking: **The carry cap order differs from the spec.** The spec says "the most severe
   first, then `fp`". src/hub/service.ts:5572 uses `byItemOrder`, which breaks ties by first-seen
   time and only then by fp. The cap is also untested (M31: removing `.slice(0, 1000)` survives).
   Either sort by severity then fp, or align the spec text.

6. non-blocking: **`Carry.fps` is looser than the contract.** The contract is "1..1000, unique,
   sorted". The schema at src/protocol/pulse.ts:134 has `.max(1000)` only. The hub always writes
   non-empty, unique, sorted lists, so stored data is fine, but the schema does not enforce it. Add
   `.min(1)` and a uniqueness refine, as `AutoAccept` does.

7. non-blocking: **The enum-widening note is missing from the guide.** Compatibility says "Enum
   widenings (`overlap`, slot `state`, `via`, attention `kind`, `goal.dropped.reason`) are visible to
   clients that list them exhaustively; the guide says so." No guide file has that sentence
   (`grep -i widen docs/guide` finds only an unrelated `--window` hint). Add one line to the
   operations upgrade sentence or to concepts.

8. non-blocking: **AC-12 uses `pulse update` instead of `pulse add`.** `test_AC12_overlap_flag_and_queued_fire`
   (test/pulse-cli.test.ts:250) checks `--overlap` through `pulse update`. AC-12 names
   `mesh pulse add … --overlap queue`. Both commands share the parser (src/cli/pulse-commands.ts:127),
   so the risk is low. One `pulse add … --overlap queue` assertion would match the AC literally.

9. non-blocking (performance): `debriefSlaTick` opens a `goalTx` every tick for every open SLA
   debrief, even when nothing changes. `attentionFor`/`overdueDebriefs` lists all ready, claimed and
   paused steps, and then each goal's steps and plans, on every attention read. This is acceptable
   at current scale. Consider filtering in the read pass (compute `slaState` before opening the
   transaction) if the hub grows.

## Fail-first mutations (scratch copy, never the worktree)

Each mutation was applied alone to a `cp -a` copy and then restored. The listed files were run with
`node_modules/.bin/vitest run`.

| # | Mutation | Result | Failing tests |
|---|---|---|---|
| M1 | queue branch in `fireSlot` disabled | CAUGHT | test_AC03_queue_replace_release, test_AC03_manual_trial, test_AC03_policy_change_pause_delete |
| M2 | supersede abandon exemption removed | CAUGHT | test_AC04_max_goal_age |
| M3 | carry union in `debriefSet` removed | CAUGHT | test_AC05_carry_partial, _carry_complete_resolved, _chain_and_when |
| M4 | auto-accept agent-decider check removed | CAUGHT | test_AC08_auto_accept, test_AC10_health_breaches |
| M5 | auto-accept severity check removed | CAUGHT | test_AC08_auto_accept, test_AC10_health_breaches |
| M6 | trial exclusion in `debriefSlaTick` removed | CAUGHT | test_AC08_claimed_none_trial |
| M7 | assignee permission in `revertDisposition` removed | CAUGHT | test_AC09_revert |
| M8 | "never auto-accepted again by D" guard removed | **SURVIVED** | (finding 4) |
| M9 | auto-accept also on claimed debriefs | CAUGHT | test_AC08_claimed_none_trial |
| M10 | new-cycle reset of `overdue` removed | **SURVIVED** | (finding 1, BLOCKING) |
| M11 | owner ≠ assignee escalation guard removed | CAUGHT | test_AC07_same_owner_no_escalation |
| M12 | held-step check in `waitingGoal` removed | CAUGHT | test_AC04_held_busy_trial |
| M13 | trial fire not downgraded to skip | CAUGHT | test_AC03_manual_trial |
| M14 | trial fire supersedes | CAUGHT | test_AC04_supersede, test_AC04_held_busy_trial |
| M15 | goal-creating fire does not replace the queued slot | **SURVIVED** | (finding 3) |
| M16 | release ignores a paused pulse | CAUGHT | test_AC03_policy_change_pause_delete |
| M17 | release ignores a busy goal | CAUGHT | test_AC03_queue_replace_release |
| M18 | sink on supersede removed | CAUGHT | test_AC06_sink_on_supersede |
| M19 | carry `consumes` filter removed | CAUGHT | test_AC05_carry_partial |
| M20b/c | `holdsFor` ignores the carry / debrief branch removed | CAUGHT | test_AC05_chain_and_when |
| M21 | `disposeStep` checks the run record only | CAUGHT | test_AC05_carry_partial, _carry_complete_resolved |
| M22 | carried evidence from the `last` record removed | CAUGHT | test_AC05_carry_partial |
| M23 | `sessionDecision` ignores auto-accept | CAUGHT | test_AC08_session_decisions |
| M24 | `disposeStep` `own` ignores auto-accept | CAUGHT | test_AC08_session_decisions |
| M25 | `blockedBy` back to `skip` only | CAUGHT | test_AC10_queue_supersede_cards |
| M26 | run-card `startWaitMs` ignores `queued` | CAUGHT | test_AC10_queue_supersede_cards |
| M27 | attention trial exclusion removed | CAUGHT | test_AC08_claimed_none_trial |
| M28 | preset `debrief.sla` copy removed | CAUGHT | test_AC02_debrief_block plus 5 World tests |
| M29 | `auto_accept needs sla` check removed | CAUGHT | test_AC02_policy_errors |
| M30 | CLI queued text removed | CAUGHT | test_AC12_overlap_flag_and_queued_fire |
| M31 | carry 1000 cap removed | **SURVIVED** | (finding 5) |
| M32 | release keeps a slot whose pulse left `queue` | CAUGHT | test_AC03_policy_change_pause_delete |
| M33 | owner event `dueAt` = SLA due instead of 2×SLA | CAUGHT | test_AC07_events_attention |

29 of 33 mutations were caught. The six guards the test plan names for fail-first (queue branch,
abandon exemption, carry union, auto-accept eligibility, trial exclusion, revert permission) are all
caught.
