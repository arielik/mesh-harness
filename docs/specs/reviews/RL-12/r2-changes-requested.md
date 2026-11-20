Verdict: CHANGES REQUESTED | Round: 2 | Blocking-open: 2

# Review of the RL-12 spec, round 2

This is a cold review of `docs/specs/RL-12.md`, revision 2 (commit 9d29c63 on `spec/RL-12`). I read the
round-1 review first, then the spec. Then I checked the revised contracts against the code **as committed
at 9d29c63** (the working tree has uncommitted RL-12 implementation work in `src/`, which I did not
review):
- `src/protocol/pulse.ts` (`PulseSlot`, `Pulse`, `PulseView`, `PulseDetail`), `goal.ts` (`Round`,
  `Plan`, `PlanDecision`, `StoredArtifact`), `review.ts` (`ItemState`, `DispositionRow`, the history
  entries), `hub.ts` (`HUB_FEATURES`);
- `src/hub/service.ts`: `pulseView`, `pulseOr404`, `pulseDetail` (3330-3460), `listRuns`, `runRow`
  (3809-3925), `runStepOf` (3977), `markSlotStarted`, `slotStarted` (3994-4027), `dropGoal` (4033),
  `filedItems` (4067), `runSink`, `sinkAfter`, `cleanAuditGoals`, `findingStepsOf` (4544-4588),
  `syncRevert` (4677), `advanceSlot` (4847), `fireSlot` (4921-4990), `doneStep` (2655-2800: round
  `startedAt`, `reopen`, reject and park rounds, fold copy), `revertDisposition` (1735),
  `createWithPlan` (plan v1 `decidedAt` = goal `createdAt`), `actingFor` (1952);
- `src/core/dag.ts` (`SATISFIED`, `settle`, `materialize`, `reopen`), `src/core/claims.ts` (`finish`),
  `src/core/pulse.ts` (`overlapBusy`);
- `src/store/hub-store.ts`: `listPlans`, `listSteps`, `listArtifacts`, `listReviews`, `listItems`,
  `itemHistory`, `listDispositions`, `listSlots`, the indexes;
- `src/hub/app.ts` (route rules, `forPerson`, the probe routes); `docs/guide/auth.md` (on-behalf-of);
  `docs/guide/concepts.md` (section order, Clean-audit goals);
- `test/helpers/pulse-kit.ts`, `calib-kit.ts`, `world.ts`, `review-kit.ts`, `sink-kit.ts`, and
  `test/trial-hub.test.ts`, `test/review-hub.test.ts` (close-as-fail with a record).

Names stay generic (`p-1`, `alpha`, `beta`, `audit`, `validate`, `file`): the public-boundary rule holds.

## Round-1 findings

| Id | Status | Reason |
|---|---|---|
| B1 | RESOLVED | *Stage times* (RL-12.md:64-81) defines one cycle: a dep's first `done` round, `skipped`/`dropped` deps by `updatedAt` with the replan caveat (`materialize` rewrites it, `dag.ts:189`), no-dep steps by the oldest approved plan listing them (only pending plans become `superseded`, `service.ts:2433`, so v1 stays approved), `startedAt` from the first round, and `cycleReadyAt` from the newest round whose `reopen` lists the step (`round.reopen` is set at `service.ts:2767`; case-insensitive compare is right, ids come as typed). A failed dep has no first end, so its dependant has no `readyAt`. AC-02 covers them. One later-cycle case remains; see S9. |
| B2 | RESOLVED | `sinks` now uses `filedItems(lineage, goal)` (`service.ts:4067`), `findingStepsOf` and the not-dropped clean-audit goals (`:4575-4588`), which is the guide's definition. AC-04 adds re-filing, a move and a dropped clean-audit goal. See S12 for the revert case. |
| B3 | RESOLVED | `blockedBy` (RL-12.md:191-197) names the retire and abandon passes and the trial rule, in `fireSlot` order (`service.ts:4934-4960`). AC-09 adds the two "absent" cases. A between-ticks difference remains; see S10. |
| B4 | RESOLVED | `accepted` counts distinct `(lineage, fp)` that are accepted now, using the latest `accepted` row in a counted goal within the window. `acceptedPerGoal` is gone. AC-08 has the filer-after-debrief case and a revert. |
| B5 | RESOLVED | The *Trial* rule (RL-12.md:51-62) lists what `trial` filters and says that item states, `items`, `sinks` and `findings` counts are lineage-level. |
| S1 | RESOLVED | *Reads* (RL-12.md:207-219) gives keyset `listSlots`, `updatedSince` for runs, dispositions per lineage, and a single raising-record read with a guide sentence on its cost. See S13 for three wording slips. |
| S2 | RESOLVED | `fold` uses only the newest round with a fold for each step. AC-05 has the retried round, which is reachable through close-as-fail with a record (`review-hub.test.ts:456`). |
| S3 | RESOLVED | The `dispositions` row says why it need not match `items`, and adds `reverted`. |
| S4 | RESOLVED | `until`, plus `goal` even when the goal no longer exists. |
| S5 | RESOLVED | `acceptedPerGoal` is dropped. `costPerAcceptedUsd` says both of its parts are counted by time in the window. |
| S6 | RESOLVED | `## Pulse health` comes after `## Clean-audit goals` (concepts.md:667), and AC-12 follows. |
| S7 | PARTIAL | Covered: fix cycle and skipped/dropped deps (AC-02), `byPeople` and `reverted` (AC-04), moves and a dropped clean-audit goal (AC-04), cursor reuse across `trial` (AC-06), the started/abandoned wording and the `GET /v1/runs` cross-check (AC-07), and `trial=include` for `runs` and `debriefs`. Still uncovered: `agent` falling back to `policy.agent` (AC-01 does not say whether the file run has telemetry), and `trial=include` on `accepted`. |
| S8 | RESOLVED | `outcome` mentions the rejected round. `raised` says "new and repeated items alike". `repo` says it is the repo the pulse runs in. |

## What holds (recomputed)

- **AC-01 counts.** Items: A, B, C are raised. A ends `accepted` (validate, then the filer), B `dismissed`,
  C `open`, so `{raised:3, open:1, accepted:1, dismissed:1}`. Rows in the goal: A by validate, A by the
  filer, B by validate, so `{accepted:2, dismissed:1, byPeople:0, reverted:0}`. `sinks`: A is accepted
  with a link now, and its latest `accepted` row is the filer's in this goal, so `filedItems` returns it.
  `runSink` runs when the file stage is `done` (`sinkAfter`, `service.ts:2808`) and needs a defined topic.
  Any member can make one with `POST /v1/topics`, as `sink-kit.ts:116` does. A headless filer stage in a
  pulse goal can therefore sink. `readyAt` of the audit equals the goal's `createdAt`, because
  `createWithPlan` approves v1 at `now`. The debrief's `waitingMs` is `now − file finishedAt`. All of this
  can be built.
- **AC-07 slots.** 3 fired-now (2 started, 1 pending) + 1 abandoned + 1 skipped + 2 missed = 7 due.
  `started` = 2 + 1 abandoned = 3. Only started slots are abandoned (`service.ts:4941`). Trial fires are
  manual (`firePulse`), so `due` does not depend on `trial`, and only `manual` changes (1, then 2).
- **AC-07 runs.** `listRuns` filters by `goal.refs.pulse` and by `[since, until)` on `finishedAt`
  (`service.ts:3857-3864`). The health window `[now − days·DAY, now)` therefore gives the same set.
- **AC-02 skipped dep.** A `when: {open: true}` stage is skipped when nothing is consumed (`dag.ts:126`,
  concepts "Review records"). A preset can make it, for example an audit that raises nothing.
- **AC-09.** `overlapBusy` skips debriefs and returns headless or run steps in `ready`, `claimed` or
  `paused` (`pulse.ts:122-129`). Trial goals never block (`service.ts:4954`). These match the listed cases.
- **AC-06 cursor.** `(at, slot)` is unique per pulse and ordered as `listSlots` orders it, so a cursor
  taken under one `trial` value can be used under another.
- **404 and scope.** `pulseOr404` gives `no pulse <id>` for unknown and deleted pulses. `member` +
  `goals:read` is the `GET /v1/pulses/:id` rule (`app.ts:268`).

## Blockers

### B6 (NEW): "a service acting for a person gets the same reply" contradicts the code and `auth.md`

Where: RL-12.md:45-46 (Common rules); AC-11.

Why: the header `x-mesh-on-behalf-of` is accepted only on routes wrapped in `forPerson` (`app.ts:127,
493`). On every other route `actingFor` answers 400 `on-behalf-of is not accepted on this route`
(`service.ts:1959`). `GET /v1/pulses/:id`, the route the rule is copied from, is not wrapped
(`app.ts:268`). `docs/guide/auth.md:46-52` lists the routes that take the header and documents the 400
for "the header on any other route". So "as `GET /v1/pulses/:id`" and "gets the same reply" lead to
different builds. One implementer copies the route and returns 400. Another wraps it in `forPerson` and
returns 200, which leaves `auth.md` out of date. AC-11 tests neither. (The sentence was already in
revision 1, but round 1 did not catch it.)

Fix: pick one.
- (a) Drop the sentence. The header then gets the documented 400, as on every other read route.
- (b) Wrap both routes in `forPerson`, add them to the `auth.md` list (the Docs section), and add an
  AC-11 case: a `goals:read` service with the header gets 200 with the same body as without it.

### B7 (NEW): `findings.filed` gives "filed" a second meaning

Where: RL-12.md:189 (`findings`), the total (:203-204), AC-08 ("`filed` (accepted)").

Why: the guide already defines **filed**: an item is filed when it is `accepted` with a `link`
(concepts.md "Clean-audit goals", "Sink"; "Backfill … a lineage's filed items"). `filedItems`
(`service.ts:4067`) implements the same rule, and this spec uses it for `sinks`. `findings.filed`
instead counts items in state `accepted`, link or not. An item that a debrief accepted and that no
filer has linked yet would show as filed although no tracker entry exists. The new `## Pulse health`
section would then define the word differently from `## Clean-audit goals` a few lines above it. This is
the same kind of conflict as round-1 B2.

Fix: pick one.
- (a) Rename the field to `accepted`, counting items in state `accepted`.
- (b) Keep `filed` and define it as `accepted` with a `link`. Optionally add `accepted` for the ones
  without a link.

In both cases, update the total and AC-08 to match.

## Suggestions

### S9 (NEW): `cycleReadyAt` misses later cycles of steps that were not reopened directly

Where: RL-12.md:77-81; `debriefs.oldestMs` (:188).

`fixCycles` goes up only for the steps listed in `reopen` (`dag.ts:224`), and `round.reopen` lists only
those steps (`service.ts:2767`). Two kinds of step get a later cycle without either:
- The failing step itself. `finish` with a reopen puts it in `blocked` (`claims.ts:99-104`). When the
  reopened dep is done again, it becomes `ready` with `fixCycles` unchanged.
- Cascaded dependants. A dependant that was `done` and was put back in `blocked` by `reopen`
  (`dag.ts:236`) later becomes `ready` again with `fixCycles` 0.

For both, `cycleReadyAt` is absent, so `waitingMs = now − readyAt` (the first cycle) and overstates the
wait by the whole first cycle. The line "It is how long the step has been waiting now" then does not
hold. In AC-02's shape, c's `waitingMs` after b is done again is measured from a's first done round. Relay
presets cannot reopen (a record step reopens nothing, `service.ts:2680`), so pulse cards rarely hit
this. Pulse presets without records can.

Possible rule: for a step with rounds in `ready`, `claimed` or `paused`, take `cycleReadyAt` as the
latest of three times:
- its own newest round's `finishedAt`;
- the newest round that lists it in `reopen`;
- each dep's newest `done` round.

The fallback to `readyAt` stays when none exists. Add c's `waitingMs` to AC-02.

### S10 (NEW): `blockedBy`'s retire test skips `advanceSlot`'s "started" check

Where: RL-12.md:192-195.

`fireSlot` retires each pending slot through `advanceSlot` (`service.ts:4934-4936`). That function first
marks the slot started when `slotStarted` holds (`:4853`): an interactive run step claimed, a headless
run step `done` or `failed`, or the goal `done`. Only otherwise does it retire the slot at `now ≥ until`.
Between two ticks, a pending slot whose run step has just finished is marked started by a fire. If the
goal has machine work left (the next headless stage is `ready`), that fire is skipped. The spec instead
passes over that goal. This is narrow because ticks set `startedAt` soon after. Either add "and its run
step has not started (`slotStarted`)" to the retire condition, or state the tick lag in the guide.

### S11 (NEW): AC-02 wording and the dropped-dep case

Where: AC-02 (RL-12.md:245).

- "A goal (not a pulse) … Checked through a pulse card of a preset with the same shape" can be read two
  ways. Cards exist only for pulse slots, so say "a pulse goal whose preset has steps a → b → c".
- A dependant behind a `dropped` dep exists only after a goal drop, because a replan rewrites deps from
  the plan and `validatePlan` refuses deps that are not in it. `dropGoal` drops a `blocked` dependant
  together with its dep (`service.ts:4039`), so the "step whose dep was dropped" is itself `dropped`.
  Its `readyAt` is the drop time, although it was never ready. Say this in AC-02, so the test drops a
  goal (a missed or abandoned slot, or `mesh goal drop`) and does not look for a ready step behind a
  dropped dep. Also consider whether `readyAt` should be absent for a step that was dropped without
  rounds.

### S12 (NEW): AC-04's D should be filed before it is reverted

Where: AC-04 (RL-12.md:247).

"A person accepts D in the debrief, then reverts it … D is not in `sinks`" is true trivially when D never
had a link. To exercise `filedItems` and `syncRevert` (`service.ts:4694-4699`, finding step dropped),
D must be filed and sunk first. That needs a debrief stage with `sink` and a `link` on the
disposition, closed before the revert. D must also not have been `accepted` before the debrief:
`revertDisposition` restores the row's `from` (`service.ts:1747`). If a filer had already accepted D,
the revert leaves D accepted with a link. The latest `accepted` row is then still in this goal, so D
stays in `sinks`, which is correct but is not what the AC expects. Pin D's prior state (open or
confirmed).

### S13 (NEW): three slips in *Reads* and `runs.count`

- "plus one slot for `lastSlot`" is wrong under `trial=exclude` when the newest slots are trial slots.
  Read until the first slot that passes, or derive `lastSlot` from the window read when that read is not
  empty.
- `dispositions.reverted` needs the revert entries, which `listDispositions` drops
  (`hub-store.ts:1026`). Name `itemHistory(lineage)` (indexed) as the per-lineage read and group it by
  goal.
- "`count` equals the number of rows `GET /v1/runs?…` returns": that route defaults to 200 rows a page.
  Say "over all its pages".

### S14 (NEW): small wording points

- `goals.created`: say "their number" (the other three are states, but `created` is not).
- AC-01: say whether the file run reports telemetry. Without it, `agent` comes from `policy.agent`,
  which also closes the S7 gap.
- AC-08: add `trial=include` for `accepted` (a trial goal's acceptance counts only then).

## Checks

Run: none of the repo's checks. This round reviews a spec, and nothing in it is implemented in the
reviewed commit. I recomputed AC-01, AC-07 and AC-09 by hand against `src/hub/service.ts`,
`src/core/dag.ts` and `src/core/pulse.ts` at 9d29c63. I extracted the committed files with `git show`,
because the working tree has uncommitted changes in `src/hub/service.ts`, `src/store/hub-store.ts`,
`src/protocol/hub.ts`, `src/core/index.ts` and a new `src/core/stage-times.ts`.

Not run: `pnpm lint`, `pnpm typecheck`, `pnpm test`, `pnpm build`, `pnpm check`, `pnpm schemas`,
`pnpm test:web`.
