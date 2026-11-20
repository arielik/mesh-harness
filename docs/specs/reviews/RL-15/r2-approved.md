Verdict: APPROVED | Round: 2 | Blocking-open: 0

# Review of the RL-15 spec, round 2

Cold review of `docs/specs/RL-15.md` revision 2 (commit e4c43c9 on `spec/RL-15`), against round 1
(`r1-changes-requested.md`, commit f4b48f2). I read `git diff f4b48f2 e4c43c9 -- docs/specs/RL-15.md`
and the whole spec, then checked the changed contracts against the code again:
`src/hub/service.ts` `fireSlot` :5314-5404 (retire :5328-5330, abandon :5331-5339, overlap :5341-5359),
`advanceSlot` :5240, `firePulseTx` :5424-5458, `fireDue` :5463, `advancePending` :5478, `tick`
:5791-5831, `blockedBy` :4295-4313, `slotStarted` :4412, `dropGoal` :4426-4447, `runSink`/`sinkAfter`
:4937-4964, `assigneeOf` :1513, `debriefData` :1534-1566, `sessionDecision` :1575-1577,
`isRevertable` :1583-1596, `submitReview` debrief checks :1242-1276, `disposeStep` :1693-1743,
`revertDisposition` :1746-1790, `attentionFor` :3082; `src/core/pulse.ts` `overlapBusy` :122-130;
`src/core/policy.ts` :13-92; `src/protocol/pulse.ts` :8-21, :62, :98-107; `src/store/hub-store.ts`
`listSlots` :1148-1181.

## Round-1 findings

| Finding | Status | Reason |
|---|---|---|
| F1 (BLOCKING) AC-05 "complete G2 → A resolved" | RESOLVED | AC-05 (RL-15.md:367) now says A stays `confirmed` and is listed when G1's record is partial, and gives the `resolved` case its own setup (G1 complete, G2 complete without A). The carry contract states the rule (RL-15.md:212-213). Both match `foldItems` and `foldBase` (core/review.ts:224-229, service.ts:1099-1100). |
| F2 (BLOCKING) trial fire replaces a queued slot | RESOLVED | RL-15.md:155-156 and :163 ("A non-trial fire that creates a goal also replaces a queued slot"); AC-03 pins it (a trial fire with a queued slot and no busy goal leaves the slot `queued`). |
| F3 (BLOCKING) abandon before supersede | RESOLVED | RL-15.md:142-146: under `supersede` a non-trial fire does not abandon a waiting goal; it is superseded (carry, sink) when the fire creates a goal, else kept. This slots cleanly into the abandon loop (service.ts:5331-5339) as an extra `continue`. AC-04 covers both sides. See F17 for one wording point. |
| F4 (BLOCKING) AC-03 unreachable with default `maxGoalAge` | RESOLVED | AC-03 sets `every 1d`, `maxGoalAge: 30d` (within 1h-366d, pulse.ts:101) and `run.started`, so `slotStarted` holds (service.ts:4415-4417), retire does not drop G1 and abandon does not either. G1's claimed headless run step is busy (core/pulse.ts:126-128). |
| F5 waiting-goal ambiguity | RESOLVED | RL-15.md:88-91 uses `overlapBusy(...)` names no step plus no `claimed`/`paused`, as `dropGoalByPerson`. |
| F6 release details | RESOLVED | Position (after `advancePending`, before `fireDue`, RL-15.md:166), owner membership (:171-172), the `blockedBy` difference stated (:174-175), deleted pulse → replaced (:169-170, AC-03), `manual: true` on a released manual slot (:178). |
| F7 auto-accept vs session decisions | RESOLVED | RL-15.md:272-276 extends `sessionDecision` (service.ts:1575-1577) and `own` (:1721) to `auto-accept` rows of this step and round; AC-08 pins both (`already`, 201 dismiss). |
| F8 SLA on trial goals | RESOLVED | "SLA debrief" excludes trial goals (RL-15.md:95-97); AC-08 tests it. See F15 for the health wording. |
| F9 revert 403 text | RESOLVED | RL-15.md:264-267; AC-09 pins `only bob, the goal owner or an admin can revert this`. |
| F10 CLI skipped text | RESOLVED | RL-15.md:306-307 reads the pulse's policy. |
| F11 sink step selection | RESOLVED | RL-15.md:191-192 uses the `dropGoal` set (service.ts:4432). |
| F12 AC precision | RESOLVED | AC-04 pins T before slot 1 (slot order `at` desc gives `[G1, T]`, hub-store.ts:1181); AC-09 has a distinct assignee; AC-05 covers a carried item dismissed meanwhile. AC-07 still does not assert the attention `text`; acceptable, the text is exact at RL-15.md:279-280. |
| F13 implementation notes | RESOLVED | Duration leaf module (RL-15.md:118-119), `debriefData` with no record (:205), guide notes on auto-accept counting (:334-335) and on carried items skipping the validator (:214-215). The `Overlap` const needs nothing more. |

## New findings

### F14 non-blocking: AC-09's 409 case depends on where F's later disposition comes from

Where: RL-15.md:371 ("after a later disposition of F, reverting F → 409"), against RL-15.md:260-262
("the latest disposition of the fp by that step with either via is the one reverted").

If the "later disposition" is a `mesh_dispose` in the same debrief (allowed now by RL-15.md:272-276),
the revert selects that newer `debrief-session` row, which is the item's latest entry, so a correct
implementation returns 200, not 409. The 409 needs a later disposition by another step (e.g. a stage of
a later goal, or a person in another debrief). Name it in AC-09.

### F15 non-blocking: health breaches of trial goals versus the "SLA debrief" definition

Where: RL-15.md:95-97 (an SLA debrief is not a trial goal; breached is defined for SLA debriefs at
:220-222), against :289-293 and AC-10 (RL-15.md:372: "a trial goal's only with `trial=include`").

Read literally, a trial debrief is never "breached", so `trial=include` would add nothing and AC-10's
trial clause could not pass. Say that health computes due/breached/escalated for every debrief with
`sla` (trial goals included under `trial=include`) and that only the tick (events, `overdue`,
auto-accept) and attention are limited to SLA debriefs.

### F16 non-blocking: a carry silently matches nothing when the plan or lineage changed

Where: RL-15.md:185-190, :204-206. A carry entry is keyed by the debrief's local step id and the
lineage of its run (`<preset>|<repo>|<agent>`, core/review.ts:103). A `PulseUpdate` that changes the
preset (renamed debrief step) or the agent between the superseded goal and the new one makes the carry
match no debrief, and the superseded goal's undecided items reach no debrief. That is a rare, fair
outcome, but one sentence in the guide's Overlap paragraph ("a carry follows the same debrief step and
lineage; changing the preset's debrief id or agent drops it") avoids surprise.

### F17 non-blocking: "Busy goals past `maxGoalAge` are abandoned … as today" undersells the rule

Where: RL-15.md:145-146. Under `supersede` the only exception is a waiting goal at a non-trial fire;
every other started goal past `maxGoalAge` (busy, or held: a `claimed`/`paused` debrief, which is
neither busy nor waiting) is abandoned as today (service.ts:5331-5339). Say "every other goal past
`maxGoalAge` is abandoned as today" so an implementer does not narrow the abandon to busy goals.

## Summary

All four round-1 blocking findings and the nine non-blocking ones are resolved. The four new findings
are wording and AC-precision points; none makes a correct implementation fail an AC that is set up as
its text intends. Approved; F14 and F15 are worth folding into the spec before implementation.
