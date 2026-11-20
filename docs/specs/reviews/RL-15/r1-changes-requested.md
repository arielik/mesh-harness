Verdict: CHANGES REQUESTED | Round: 1 | Blocking-open: 4

# Review of the RL-15 spec, round 1

This is a cold review of `docs/specs/RL-15.md` (draft r1, commit f4b48f2 on `spec/RL-15`). I read the
source item (`docs/analysis/2026-11-19-harness-efficiency-and-insights.md` I-5, with §6 C-1 taking
precedence) and RL-3, RL-4, RL-9, RL-12, plus the RL-12 r1 review for format. Then I checked each
contract against the code it touches:
- `src/protocol/pulse.ts` (`Overlap` :62, `PulseFields`/`PulseCreate`/`PulseUpdate` :66-120, `SlotState`
  :122, `PulseSlot` :138-163), `goal.ts` (`Round` :302, `Step` :346, `StepPolicy` :397-465, `PlanStep`),
  `review.ts` (`Decider` :115, `DispositionVia` :144, history entries :147-178, `DispositionRow`,
  `ItemRow.last` :220), `hub.ts` (`Attention` :658, `HUB_FEATURES` :716, `RunCard`, `HealthSlots`,
  `PulseHealth`, `HealthTotal` :810-895);
- `src/core/pulse.ts` (`overlapBusy` :122), `review.ts` (`foldItems` :198-233, `whenHolds` :241,
  `lineageOf` :103), `presets.ts` (`parsePreset` :158, `presetText` :178, `instantiate` :193),
  `policy.ts` (`policyOf` :12, `DEBRIEF_CONSUMES` :27, `validatePolicies` :43), `stage-times.ts`,
  `calibration.ts` (decider and via uses);
- `src/hub/service.ts`: `foldBase` :1099, `runRecordOf`/`recordItems` :1111-1126, `holdsFor` :1160,
  `submitReview` :1202-1430, `applyDisposition` :1440, `debriefData` :1534, `sessionDecision` :1575,
  `isRevertable` :1583, `decidedViews` :1599, `debriefView`/`debriefs` :1630-1690, `disposeStep` :1693,
  `revertDisposition` :1746, `attentionFor` :3082, `firePulse` :3555, `timings` :3334, `runCard` :3998,
  `health` :4099-4290, `blockedBy` :4295, `runStepOf` :4370, `slotStarted` :4412, `dropGoal` :4426,
  `filedItems` :4460, `runSink`/`sinkAfter` :4937-4964, `syncRevert` :5070, `dropGoalByPerson` :5118,
  `advanceSlot` :5240, `fireSlot` :5314-5404, `firePulseTx` :5424, `fireDue` :5463, `advancePending`
  :5478, `tick` :5791-5831;
- `src/store/hub-store.ts` (`pulse_slot` :93, `saveSteps` :750, `listSteps` :795, `listSlots` :1149);
- `src/cli/pulse-commands.ts` (:16, :126, `fire` :250-276); `skills/mesh-debrief/SKILL.md`.

The spec's names are generic (`p`, `G1`, `ci`), so the public-boundary rule holds.

## What holds

- **Today's behaviour is described correctly.** `fireSlot` only checks overlap under `skip`
  (service.ts:5341), skips trial goals (:5347) and uses `overlapBusy`, which ignores debriefs and
  non-headless steps other than the run step (core/pulse.ts:122-130). The 0.1.25 and 0.1.30 dates
  match docs/guide/operations.md:99.
- **The fold analysis is correct.** `carried` holds only dismissed repeats (core/review.ts:220); an
  open or confirmed repeat keeps its state (:221); `resolved` needs a complete record **and** the fp in
  the fold base (:224-229), which is the lineage's last complete raising record (service.ts:1099-1100);
  `debriefData` lists only the run's latest record's fps (:1545-1547). So the debrief does need a carry
  to "cover both runs".
- **Cycles and rounds.** `Round.outcome` is only `done|fail` (goal.ts:308): a claim and release adds no
  round, so `cycleReadyAt` does not move on a release (stage-times.ts:56-71) and the SLA cannot be reset
  by claiming and releasing. `cycleReadyAt` is computed for `ready|claimed|paused` only, which are the
  states the SLA checks. "Current round = rounds + 1" matches `disposeStep` and `submitReview` (:1702,
  :1212).
- **`updatedAt` unchanged is implementable.** `saveSteps` writes `updated_at` from the value
  (hub-store.ts:750-764) and the tick's writes run in a serialized `goalTx` (service.ts:454-459).
- **No migration.** Slot `state` is a text column (hub-store.ts:93); `listSlots({state:"queued"})` uses
  the existing `pulse_slot_pending (state, started_at)` index; every new field lives in JSON values.
  `parsePreset` ignores unknown top-level keys (presets.ts:159-162), so "an older hub ignores
  `debrief:`" is true.
- **Supersede and clean-audit goals.** Clean-audit goals have `sink` and no `refs.slot`, so they are
  never named by a slot and never superseded. `runSink` notes a failure and never throws for a sink
  reason (service.ts:4930-4946); `filedItems(lineage, G)` picks only items whose latest `accepted` is in
  `G` (:4460-4475), so sinking at supersede places exactly what `G`'s debrief filed.
- **The waiting-goal rule matches `dropGoalByPerson`** (no claimed or paused step, service.ts:5123),
  so supersede never drops a session's held work.
- **Auto-accept and calibration.** Calibration only reads dismissals and person/debrief-session pairs
  (calibration.ts:66-79, :292, :308-310); an agent-kind `accepted` with a new `via` does not change any
  count. Run cards count `byPeople` by `decider.kind` (service.ts:4073), so auto-accepts are not
  person decisions. `syncDisposition` acts on dismissals/deferrals only.
- **`HUB_FEATURES`** stays sorted; `RunCard.state` and `HealthSlots` widen with the enum.

## Findings

### F1 BLOCKING: AC-05's "complete G2 record → A is resolved" contradicts the fold

Where: RL-15.md:336 (AC-05: "G1's record (partial coverage) raises A, B, C … With a complete G2 record
not raising A → A is `resolved` and not listed"), against RL-15.md:38-41 and core/review.ts:224-229,
service.ts:1099-1100.

`foldItems` resolves an fp only when it is in `previous`, the fps of the lineage's **last complete**
raising record. G1's record is partial, so it is never a fold base; unless an earlier complete record
of the lineage raised A, G2's complete record leaves A `confirmed`, the carry keeps it in G2's debrief
set, and it **is** listed. A correct implementation fails this clause. The spec's own Problem text says
the same thing ("its fold base is the earlier goal's complete record"), so the AC is the part that is
wrong.

Fix: in AC-05 either give the "complete" variant its own setup (G1's record complete, or a G0 complete
record that raised A), or change the expectation to "A stays `confirmed` and is listed (carried)". Say
in the carry contract that a carried fp is listed whenever its row is in `consumes`, whatever the new
record's coverage.

### F2 BLOCKING: a trial fire replaces (and loses) a queued production slot

Where: RL-15.md:142 (`queue` / no busy goal: "replace the queued slot if any, then create the goal"),
:145 ("A trial fire never queues and never supersedes"), :152-153 ("A fire that creates a goal also
replaces a queued slot").

A trial fire is not exempted from the replace. A queued slot exists with no busy goal in two reachable
cases: between the running goal ending and the next tick's release, and while the pulse is paused
(RL-15.md:160 keeps it queued; `firePulse` fires manual slots "also while paused", service.ts:3555).
In both, `mesh pulse fire --trial` would save the production slot `skipped` with `replacedBy` = the
trial slot, and only a trial goal (left out of statistics and runs) is created: the scheduled run is
gone, which is exactly the trial-hygiene failure §6 C-1 warns about.

Fix: "A trial fire never queues, never replaces a queued slot and never supersedes." Add it to AC-03
(a trial fire with a queued slot and no busy goal leaves the slot `queued`).

### F3 BLOCKING: `maxGoalAge` abandon runs before supersede and drops waiting goals with no carry and no sink

Where: RL-15.md:135-136 (order kept: retire, abandon, then overlap), :170-186 (carry and sink only for
superseded goals); service.ts:5331-5339 (abandon), :3334-3339 (default `maxGoalAgeMs` = 2 × period).

Under `supersede` a fire that finds a busy goal is `skipped`. If that goal then stops at its debrief,
the next fire is two periods after it was created, so with the default `maxGoalAge` it is
**abandoned** first (`dropGoal(…, "abandoned")`, slot `abandoned`) and never reaches the supersede
step: its undecided debrief items are not carried and its filed items are not sunk. The same happens
after a pause longer than `maxGoalAge`, and to trial goals (trial slots get `startedAt` like any
other). This is the very sequence of Problem 1 (a goal busy at the due time), and it silently breaks
the "nothing is lost" promise of I-5 that the carry exists for.

Fix (one of): under `supersede`, a goal that abandon would drop and that is a waiting goal is
superseded instead (carry, sink, drop with `superseded`; its slot still `abandoned` or kept, say
which); or abandon under `supersede` runs the carry and sink steps too. Add the case to AC-05 or AC-04.

### F4 BLOCKING: AC-03 cannot reach "slot 3 `queued`" with the default `maxGoalAge`

Where: RL-15.md:334 (AC-03: "at slot 3 (G1 still busy) slot 2 → `skipped` … slot 3 `queued`").

G1 is created at slot 1. At slot 3, `now − createdAt` = 2 × period = the default `maxGoalAgeMs`
(service.ts:3339), so the fire's abandon step drops a started G1 (service.ts:5335: not `<`), or the
retire step drops an unstarted one whose window ended (:5328-5330, `until` = slot 1 + min(4h,
period)). Either way no goal is busy at slot 3, which fires a goal and replaces slot 2. A test written
from the AC with default pulse settings fails against a correct implementation (or passes only on
clock jitter).

Fix: AC-03 sets `maxGoalAge` (e.g. `30d`) and a run step that has started (`run.started`), and says so.

### F5 non-blocking: "not busy" in the waiting-goal definition is ambiguous for trial goals

Where: RL-15.md:84-90. "Busy goal" is defined to exclude trial goals; "waiting goal … trial goals
included, that is not busy" can be read with that definition, which makes a trial goal whose headless
step is `ready` and offered (overlapBusy names it) a waiting goal: supersede would withdraw the offer
and drop it mid-dispatch. Say "for which `overlapBusy(steps, runStepOf(goal))` names no step and no
step is `claimed` or `paused`".

### F6 non-blocking: release details

Where: RL-15.md:155-165.
- Position in `tick`: say before or after `advancePending` (service.ts:5829). After it, a goal whose
  window ended is dropped first and the queued slot can fire in the same tick; before it, it waits a
  tick. Pick one so AC-03's "next tick" is exact.
- Release does not run retire/abandon and does not check the owner's membership the way
  `firePulseTx` does (service.ts:5426-5433, it pauses the pulse). A queued slot of a pulse whose owner
  left would create a goal owned by a non-member. Add "owner not a member → nothing" (the next due
  fire pauses the pulse).
- `blockedBy` (health) skips goals the next fire would retire or abandon (service.ts:4307-4309), while
  release uses the raw busy test, so health can show "not blocked" while a slot stays queued. Either
  align them or say so.
- A deleted pulse's queued slot stays `queued` forever and is re-read every tick. Prefer: pulse
  deleted → replaced (`skipped`/`overlap`, no `replacedBy`), or skip it at `deletePulse`.
- The `pulse.fired` payload of a released **manual** slot: say whether it carries `manual: true`
  (it has no `user` per the spec).

### F7 non-blocking: auto-accept versus the debrief's own record and the change-of-mind rule

Where: RL-15.md:223-248; service.ts:1255-1276 (`submitReview` debrief checks), :1575-1577
(`sessionDecision` filters `via === "debrief-session"`), :1719-1721 (`disposeStep` `own`).

After an auto-accept, `GET /v1/steps/:id/debrief` `decided` lists the item (the spec adds it). If the
session's closing record lists that fp, `sessionDecision` does not see the auto-accept row, the row is
`accepted` (not consumed), and the whole record is refused 422 (`item … is accepted; … acts on open,
confirmed`) instead of counting it under `already`. In `disposeStep`, a person who wants to dismiss an
auto-accepted item gets 422 too (not `own`) and must revert first. The skill says "the latest decision
you recorded" (skills/mesh-debrief/SKILL.md:39-41), so it may work by accident. State the rule:
either `sessionDecision` and `own` also take `via: "auto-accept"` rows of this step and round (same
disposition → `already`; different → the existing 422 text), or the record must leave them out and the
skill says so. One line in AC-08 then pins it.

### F8 non-blocking: SLA and auto-accept on trial goals

Where: RL-15.md:199-239, :265. Health counts a trial goal's debrief only with `trial=include`, but the
tick and `attentionFor` have no trial rule, so every trial goal left open (the C-1 case: "trial goals
nobody meant to debrief") raises `debrief.overdue` events and attention items, and with `auto_accept`
sets `accepted` on items of the **production lineage** (lineage = `<preset>|<repo>|<agent>`,
review.ts:125-126) from a trial debrief. Say explicitly whether trial goals are left out of the SLA
(suggested: no events, no attention, no auto-accept for `goal.trial`).

### F9 non-blocking: revert 403 text

Where: RL-15.md:241-246; service.ts:1753-1754. With an auto-accept, `decider` is `""`, so the current
text reads `only , the goal owner or an admin can revert this`, and it omits the new assignee
permission. Give the exact 403 text for both vias (e.g. `only <decider>, the assignee <a>, the goal
owner or an admin …` / without the decider for auto-accept).

### F10 non-blocking: CLI skipped text names the wrong policy

Where: RL-15.md:278-280; pulse-commands.ts:273. "A `skipped` reply prints as today" keeps the hard-coded
`(overlap: skip)`, which is wrong for a busy fire under `supersede` and for a trial fire under `queue`.
The fire reply does not carry the policy; either drop the parenthesis or read the pulse. A fire that
superseded goals could also print them (`superseded G1, T`); optional.

### F11 non-blocking: sink step selection

Where: RL-15.md:176-178. "Each step `S` of `G` with `policy.sink` that is not `done` or `skipped`"
includes `failed` and `dropped` steps, which RL-9 never sinks (`sinkAfter` runs for `done`/`skipped`
only, service.ts:4963). Use "every step the drop below will drop" (not `done`, `skipped`, `dropped` or
`failed`).

### F12 non-blocking: AC precision

- AC-04 (RL-15.md:335): `superseded = [G1, T] (slot order)` holds only if T was fired **before**
  slot 1; slot order is `at` desc, then `slot` desc (hub-store.ts:1181), so a trial fire after slot 1
  gives `[T, G1]`. Pin T's fire time or the expected list.
- AC-09 (RL-15.md:340): to test the new assignee permission, the assignee must differ from the goal
  owner (an `assignee: <user>` debrief); otherwise the owner rule already allows it.
- AC-07 does not cover `GET /v1/live` `attention` or the assignee change of an `@owner` debrief; fine
  to leave, but say the attention text is pinned (it is given exactly at RL-15.md:251-253).
- No AC covers carry with `consumes` filter of a carried `dismissed`/`accepted` item (it must drop
  out). A one-line addition to AC-05 would pin it.

### F13 non-blocking: implementation notes

- `DurationSpec` lives in src/protocol/pulse.ts, which imports from goal.ts (pulse.ts:3). Using it in
  `StepPolicy` makes an import cycle with a module-level `const`; move `DURATION_RE`/`DurationSpec`/
  `durationMs` to a leaf module (re-exported from pulse.ts).
- `debriefData` returns early when the run has no record (service.ts:1544); with carry it must still
  list carried items. Say "the run's latest record (none = no fps)".
- `Overlap` is a non-exported `const` (pulse.ts:62); the hub-api/schemas change follows from the
  enum, nothing else.
- Health `accepted` and `costPerAcceptedUsd` count auto-accepted items like a person's acceptance
  (service.ts:4199-4210). If that is intended, say so in the `## Debrief SLA` guide section; otherwise
  count only items with a person or stage decider.
- Carried items that were `open` in G1 reach N's debrief without N's validator seeing them (carry is
  debrief-only). That is a fair choice; one sentence in the guide's Overlap paragraph avoids surprise.
