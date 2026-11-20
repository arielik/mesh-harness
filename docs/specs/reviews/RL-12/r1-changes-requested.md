Verdict: CHANGES REQUESTED | Round: 1 | Blocking-open: 5

# Review of the RL-12 spec, round 1

This is a cold review of `docs/specs/RL-12.md` (commit 38beff3 on `spec/RL-12`). I read the source item
(`docs/analysis/2026-11-19-harness-efficiency-and-insights.md`, I-2) and RL-11 with its reviews for
format. Then I checked each contract against the code it touches:
- `src/protocol/pulse.ts` (`PulseSlot`, `Pulse`, `PulseView`), `goal.ts` (`Goal`, `Step`, `Round`,
  `StoredArtifact`, `RunTelemetry`, `StepPolicy`), `review.ts` (`StoredReview`, `ItemRow`,
  `DispositionRow`, `ItemHistoryEntry`), `hub.ts` (`HUB_FEATURES`, `RunRow`, `RunsPage`);
- `src/hub/service.ts`: `pulseView`, `pulseOr404`, `pulseDetail`, `firePulse`, `fireSlot`
  (retire, abandon, overlap: 4921-4970), `advanceSlot`, `attempt`, `runStepOf`, `listRuns`, `runRow`
  (3809-3925), `doneStep` (round `startedAt`/`finishedAt`, reject and park rounds: 2652-2770),
  `settleSteps`, `goalComplete`, `runSink`, `sinkAfter`, `cleanAuditGoals`, `findingStepsOf`,
  `filedItems` (4067-4084), `goalDetail`;
- `src/core/dag.ts` (`SATISFIED`, `recomputeReady`, `settle`, `materialize`, `reopen`),
  `src/core/pulse.ts` (`overlapBusy`), `src/core/finding-step.ts`, `src/core/review.ts` (`lineageOf`);
- `src/store/hub-store.ts`: `listSlots`, `listSteps`, `listArtifacts`, `listReviews`, `getItem`,
  `listItems`, `listDispositions` (997-1040), the indexes (46-131); `src/store/dialect.ts`
  (`stepOrder`);
- `src/hub/app.ts` (the `GET /v1/pulses/:id` and `/v1/runs` route rules and scopes);
- `docs/guide/concepts.md` (Runs, Review records, Pulses, Debriefs, Calibration, Clean-audit goals);
- `test/helpers/pulse-kit.ts`, `calib-kit.ts`, `world.ts`, and `test/trial-hub.test.ts` (which already
  combines `Pk` and `Ck` around a three-stage relay).

The spec's names (`p-1`, `alpha`, `beta`, `audit`, `validate`) are generic, so the public-boundary
rule holds. Every finding is **NEW**.

## What holds

- **Route, rule and scope.** `GET /v1/pulses/:id` is `member` with `goals:read` (`app.ts:268`); the new
  routes copy it, and `pulseOr404` already gives `404 no pulse <id>` for unknown and deleted pulses.
- **Card order and cursor.** `listSlots` orders `at DESC, binary(slot) DESC` (`hub-store.ts:1158`),
  which is the order the spec names; `(at, slot)` is a unique key per pulse, so a keyset cursor over it
  has no duplicates or gaps whatever `trial` filters.
- **Trial fires are manual slots** (`firePulse` passes `manual: true`; RL-11 "a trial fire's slot is a
  manual slot"), so `slots` (scheduled only) is unaffected by `trial` and only `manual` changes, as
  AC-05 expects.
- **`started` and `abandoned` can overlap.** `fireSlot` abandons only slots with `startedAt`
  (`service.ts:4941`), so "3 started, one later abandoned" in AC-05 is reachable and `started` counts
  it.
- **`skipped` slots carry `running` and no `goal`; missed slots from window expiry carry the dropped
  goal and `firedAt`; `hub_down`/`error` missed slots carry neither.** The card's "absent when the
  slot has none" handles all three.
- **Waste parts reuse `runRow`.** `failed`, `overBudget`, `denials`, `allDismissed` are computed there
  (`service.ts:3912-3917`), so "computed as `GET /v1/runs` does" is one shared helper.
- **`HUB_FEATURES`** stays sorted and the AC pins the list.
- **The kits suffice for AC-01..AC-10.** `Pk` fires, ticks, starts runs (`/run` `state: started`) and
  reads slots; `Ck.raise`, `Ck.agentDispose`, `Ck.personDispose`, `Ck.revert` and `Ck.run` (with
  `tel()`) build records, dispositions, reverts and telemetry; `trial-hub.test.ts` already mixes them.
  AC-05 needs a long tick script (7 daily slots with capacity and no-machine outcomes), but nothing
  the kits lack.

## Blockers

### B1 (NEW): `readyAt` / `waitMs` are wrong for steps with more than one round, failed deps and dropped deps

Where: RL-12.md:71-84 (`readyAt`, `startedAt`, `waitMs`, `waiting`), used again by `debriefs.oldestMs`
(:167).

Why:
1. **Mixed rounds.** `startedAt` is the step's **first** round's start, but `readyAt` is built from each
   dep's **newest** round. In a fix cycle (verify fails → implement reopened → implement done again →
   verify again) the dep's newest `finishedAt` is after the step's first `startedAt`, so the difference
   is negative and is clamped to 0. Every step downstream of a reopen reports `waitMs: 0`, and the real
   first wait is lost. Two implementers who "fix" this (first round vs newest round on both sides)
   get different numbers.
2. **Reopened steps that wait again.** A step reopened to `ready` has rounds, so `startedAt` is
   present, `waiting` is never set, and `waitMs` is the old first wait. A step waiting right now shows as
   not waiting. Its real ready moment is the `finishedAt` of the round that reopened it (that round's
   `reopen` lists it), not the end of its deps.
3. **Failed deps.** A dep whose newest round is `outcome: fail` (`failed`, `parked`, a rejected round)
   gives an "end" although the dependant never became ready (`dag.ts:76` counts only `done`, `dropped`,
   `skipped` as satisfied). A `blocked` step then shows a `readyAt`; with `waitMs` absent it is
   harmless, but the field says "when the step could start", which is false.
4. **Dropped deps.** `dropped` satisfies a dep (`dag.ts:76`), yet the spec gives a dropped dep without
   rounds no end. When it is the last dep to close, `readyAt` is too early (wait overstated); when it is
   the only dep, `readyAt` is absent for a step that is ready.
5. **Skipped deps with rounds.** A step that was `done` (rounds), then went back to `blocked` by a
   reopen upstream (`dag.ts:236`) and was then `skipped`, has rounds: the spec takes its old round's
   `finishedAt`, not the skip. And a skipped step's `updatedAt` is not stable: `materialize` rewrites
   `updatedAt` on every kept non-done step on a replan, skipped ones included (`dag.ts:189`).
6. **Steps without deps after a replan** get `goal.createdAt`, although a step added by plan v2 could
   not start before that plan was approved.

Fix: define one cycle explicitly. A workable set:
- `readyAt` (first cycle) = the latest, over the deps, of the dep's **first `done` round's**
  `finishedAt`; a dep that is `skipped` or `dropped` without a `done` round counts with its
  `updatedAt` (and say that a replan can move it); a step without deps uses the approval time of the
  plan version that introduced it (`goal.createdAt` for plan v1 of a pulse goal). Absent when the step
  is `blocked`.
- `startedAt` = first round's `startedAt` (when the first round has none: absent; do not fall back to
  `claimedAt`, which belongs to a later cycle).
- For a step in `ready`, `claimed` or `paused` with `fixCycles > 0`, add `cycleReadyAt` = the
  `finishedAt` of the newest round of the goal whose `reopen` lists the step; `waiting`/`waitMs` of a
  `ready` step then use it, and `debriefs.oldestMs` uses `cycleReadyAt ?? readyAt`.
Add an AC with a reopened step (fix cycle), a skipped dep, and a dropped dep.

### B2 (NEW): "filed in this goal" contradicts the existing definition and the sink code

Where: RL-12.md:102-108 (`sinks`).

Why: `docs/guide/concepts.md` (Clean-audit goals, "Sink") already defines **filed in the goal** as
"`accepted` with a `link`, its latest `accepted` disposition recorded in this goal", and `filedItems`
(`service.ts:4067-4084`) implements exactly that: the item row is `accepted` with a `link` **now** and
the newest `accepted` row of the item is in this goal. The spec reuses the bold term for "the goal has
an `accepted` row with a `link`", which also counts items whose acceptance was reverted (the finding
step was then dropped: concepts table "a debrief's `accepted` reverted") and items filed again later
in another goal (the step belongs to that goal's filing). It also takes clean-audit goals "any state",
while `cleanAuditGoals` leaves out dropped ones (`service.ts:4575`). A card built from the spec and the
sink's own view disagree, and the guide would carry two meanings for one term.

Fix: use the existing definition and code path: the items are `filedItems(lineage, goal.id)` over the
lineages of the goal's raising records (same row, same "latest accepted in this goal" rule), the
clean-audit goals are those that are not dropped, and the step is the live finding step
(`findingStepsOf`: `step.finding` matches and no `movedTo`). If the card really wants "ever filed here",
give it another name (for example `filedEver`) and say why. Extend AC-01 or add an AC: an item filed and
then reverted, and an item filed again in a later goal, are not in the first goal's `sinks`.

### B3 (NEW): `blockedBy` does not say whether the retire and abandon passes of `fireSlot` apply

Where: RL-12.md:161 (`blockedBy`), AC-07.

Why: `fireSlot` does three things before the overlap check (`service.ts:4934-4947`): it retires pending
slots whose window is over (their goals are dropped), and it abandons started goals older than
`maxGoalAge`. Only then does it look for a busy goal. "The first goal … that would make a slot fired now
be skipped" therefore excludes a goal that the same fire would abandon or retire; "the RL-3 overlap
rule, as `fireSlot` applies it" can equally be read as just the loop at 4949-4960. The two readings
differ exactly in the case a health page most needs: a stuck goal past `maxGoalAge` (reported as
blocking, although the next fire abandons it and runs).

Fix: say it in so many words, for example: "computed as `fireSlot` would at `now`, read-only: goals of
`fired` slots that are pending with `now ≥ until`, and started goals with `now − createdAt ≥
maxGoalAgeMs`, do not block; the others are tested with `overlapBusy(steps, runStepOf(goal))`, trial
goals never blocking". Optionally add `wouldAbandon: true` rather than hiding such a goal. Extend AC-07
with a busy goal older than `maxGoalAge` (absent) and a pending goal whose window is over (absent).

### B4 (NEW): `accepted` counts disposition rows, so both ratios double count

Where: RL-12.md:164-166 (`accepted`, `acceptedPerGoal`, `costPerAcceptedUsd`), the total (:172-177),
AC-06.

Why: one accepted finding routinely produces several `accepted` rows:
- a filer stage records its `link` after a person's debrief accepted the item ("Agreeing agent
  dispositions", concepts.md): two `accepted` rows, same goal, same item;
- a person changes a decision in the same debrief round with another `mesh_dispose`;
- a reverted acceptance stays a row (`listDispositions` drops `revert` entries, not the row they undo).
The scorecard is meant to say "what was accepted"; counting rows inflates `acceptedPerGoal` and
deflates `costPerAcceptedUsd` by the number of stages that touched the item, and a revert does not
lower them. Two implementers will also differ on whether `accepted` must match the card's
`dispositions.accepted` (rows) or the item count.

Fix: define `accepted` as the number of distinct `(lineage, fp)` with an `accepted` row in a counted
goal with `at` in the window, whose latest disposition-or-revert entry in that goal is not a revert of
it (or: whose row is `accepted` now). Keep a separate `acceptedRows` if the raw count is wanted. State
in the guide section that the two populations of `acceptedPerGoal` differ (accepted in the window by
any of the pulse's goals, over goals of slots in the window) or align them (S5). Add the filer-after-
debrief case and a revert to AC-06.

### B5 (NEW): `trial: exclude` promises an exclusion that lineage-level fields cannot give

Where: RL-12.md:48-52 (Common rules), `findings` (:168), the card's `items` (:99) and `sinks`.

Why: trial goals share the lineage `<preset>|<repo>|<agent>` (`lineageOf` ignores `trial`), and RL-11
says a trial run's record folds, files and sinks like any other. So:
- health `findings` counts every item of the lineage, also items raised only by trial runs, and the
  states of items set by trial dispositions;
- a non-trial card's `items` shows states that a later trial run changed (resolved, dismissed);
- a trial goal's filing appears in non-trial items' sinks.
The rule "everything that belongs to a trial goal … is left out" cannot hold for these, and an
implementer must guess whether to drop items whose only raising record is in a trial goal (possible,
costly) or ignore the rule. `blockedBy` already carries "Not affected by `trial`"; these fields need
the same sentence or a rule.

Fix: list the fields `trial` filters (slots, `manual`, goals, `runs`, `accepted`, `debriefs`, the
lineage discovery of `findings`) and say that item states, `findings` counts and `sinks` are
lineage-level and include what trial runs did (as RL-11 states for folds and sinks). Or define
`findings` under `exclude` as items whose `first.goal` is not a trial goal, and say so.

## Suggestions

### S1 (NEW): performance: name the reads, because several obvious ones are full scans

Where: Common rules; `dispositions`, `items`, `delta`, all of `PulseHealth`.
- `listDispositions({goal})` filters `goal` in JS after reading the whole `item_history` table
  (`hub-store.ts:1007-1016`); `item_history` is indexed only on `(lineage, fp, seq)` (:88). Twenty cards
  per page means twenty full scans. Read each lineage's history once per request
  (`listDispositions({lineage})`, indexed) and group by goal.
- `listReviews` has no `goal` filter; per step (`{step}`, primary key) is fine for a card, but health
  `findings` "every lineage that a raising record of the pulse's goals names (all time)" over every
  goal ever is a scan of all records with their 500-item JSON. Lineages can be derived from the goal's
  preset and the raising steps (`lineageOf`) without reading records.
- `listSlots` has no keyset or time range; the routes will load all slots of a pulse (a 5-minute
  pulse has ~100k per year) for every page and every health call. Add `listSlots({pulse, before?,
  since?, limit?})`.
- health `runs`: use `listSteps({updatedSince: since})` as `listRuns` does (`service.ts:3846`), not the
  steps of every pulse goal.
- `delta` may walk back over many non-done slots, each a `getGoal`; bound it or say it is unbounded.
State these in the spec (as RL-11 did for `listRuns`), and add a budget sentence to the guide.

### S2 (NEW): `fold` sums double count when a raising step has more than one round with a fold

Where: RL-12.md:98, `delta.new`/`delta.regression`.
A raising run closed as fail after storing its record keeps its `fold` on the round (`doneStep` copies
`rec.fold` for any outcome, `service.ts:2738`); a retried round folds again against the same base, so
`new` is counted twice. Use the newest round with a fold per raising step, or say that the sum is
intended.

### S3 (NEW): say that `dispositions` and `items` describe different item sets

`items` is about items raised by this goal's records; `dispositions` about rows recorded by this goal's
steps, which can concern items raised by earlier goals (a carried item decided in this debrief). Both
are defined, but a reader will compare them. One sentence in the spec and the guide; consider
`reverted` alongside `byPeople`.

### S4 (NEW): `RunCard` drops stored slot fields

`until` (the window end) and the raw `goal` id (when the goal no longer exists, `goal` is absent and the
id is lost) are not listed among the "as stored" fields. Add both.

### S5 (NEW): `acceptedPerGoal` mixes populations

Numerator: accepted in the window by any of the pulse's goals (any age); denominator: goals of slots in
the window. A debrief closed this week for last month's goal raises this week's ratio. Either count
acceptances of the window's goals only, or name the ratio for what it is.

### S6 (NEW): put `## Pulse health` after `## Pulses`, not after `## Runs`

In `concepts.md`, `## Runs` (line 290) comes before `## Pulses` (412), `## Debriefs` (577) and
`## Clean-audit goals` (667). The new section explains slots, debriefs and sinks; placed after Runs it
precedes all three. Place it after `## Clean-audit goals` (or after `## Pulses`), and update AC-11.

### S7 (NEW): acceptance gaps

No criterion covers: a fix cycle and a skipped/dropped dep in `readyAt` (B1); `byPeople > 0` and a
reverted row in `dispositions`; a moved-away finding step and a dropped clean-audit goal in `sinks`;
`trial=include` for health `runs`, `accepted`, `debriefs`; `cursor` reuse with a different `trial`;
`agent` falling back to `policy.agent` when no round has telemetry. AC-05's "4 fired (3 started, one
of them later abandoned)" reads both ways; say that the abandoned slot is one of the three started
ones and the fourth is pending in its window. Consider cross-checking health `runs.count` against
`GET /v1/runs?pulse=&since=&until=&trial=` in AC-05.

### S8 (NEW): small wording points

- `StageCard.outcome` of a `claimed` step with a rejected round (`doneStep` reject keeps the step
  claimed and adds a `fail` round) is `fail` while the step is still being worked; say so or skip
  rejected rounds (`reconcile` set).
- `items.raised` counts repeats too (every fingerprint of the goal's records), unlike `fold.new`; the
  guide should say it, since `delta.raised` will be read as "more findings".
- `repo` matches only pulses whose params name the repo `repo`; say it in the guide.
