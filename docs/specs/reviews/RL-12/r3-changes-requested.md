Verdict: CHANGES REQUESTED | Round: 3 | Blocking-open: 1

# Review of the RL-12 spec, round 3

This is a cold review of `docs/specs/RL-12.md`, revision 3 (commit 1b3d4ae on `spec/RL-12`). I read the
round-1 and round-2 reviews first, then the spec. Then I checked the changed rules against the code
**as committed at 1b3d4ae** (extracted with `git show`, because the working tree has uncommitted RL-12
work in `src/`):
- `src/hub/service.ts`: `actingFor` (1959-1966), `revertDisposition` (1735), `isRevertable` (1572),
  `debriefOr409` (1513), `doneStep` (the reopen ids at 2682, the reject and park rounds at 2749/2760,
  `round.reopen` at 2767), `listRuns` (3809-3870), `runStepOf`, `pendingSlotOf`, `markSlotStarted`,
  `slotStarted` (3977-4028), `dropGoal` (4033), `filedItems` (4067), `syncRevert` (4677),
  `dropGoalByPerson`, `advanceSlot` (4847), `fireSlot` (4921-4965), `timings` (3322);
- `src/core/claims.ts` (`finish`), `src/core/dag.ts` (`settle`, `materialize`, `reopen`,
  `recomputeReady`), `src/core/pulse.ts` (`overlapBusy`);
- `src/store/hub-store.ts` (`itemHistory`, `listDispositions`, `listSlots`, `listSteps` `updatedSince`);
- `src/hub/app.ts` (`forPerson`, the `actingFor` call at 493, `GET /v1/pulses/:id` at 268);
  `src/protocol/pulse.ts` (the `maxGoalAge` and `window` ranges); `docs/guide/auth.md`.

I glanced at the uncommitted `src/core/stage-times.ts` and the `blockedBy` draft in `src/hub/service.ts`
only to see how the text was read; the findings below are about the spec.

Names stay generic (`p-1`, `alpha`, `beta`, `a`, `b`, `c`, `D`, `E`): the public-boundary rule holds.

## Round-2 findings

| Id | Status | Reason |
|---|---|---|
| B6 | RESOLVED | Option (a): neither route is wrapped in `forPerson`, so `actingFor` is called with `allowed: false` (`app.ts:493`) and a service's header gets 400 `on-behalf-of is not accepted on this route` (`service.ts:1966`), as `auth.md` documents for "the header on any other route". AC-11 tests it. `auth.md` needs no change. |
| B7 | RESOLVED | Option (a): `findings.accepted` counts state `accepted` "with or without a link". "filed" now appears only in the RL-9 sense (`sinks`). The total and AC-08 follow. |
| S7 | RESOLVED | AC-01 says the file run reports no telemetry and that its `agent` is `policy.agent`. AC-08 adds `trial=include` for `accepted`. |
| S9 | PARTIAL | `cycleReadyAt` now covers the three cases named in round 2 (direct reopen, the failing step itself, a `done` dependant put back to `blocked`). It still needs `s` to have rounds, which misses a dependant that was `ready` or `skipped` without rounds when its dep was reopened (S15). |
| S10 | PARTIAL | The retire condition now names `advanceSlot`'s test, but the gloss in brackets does not match `slotStarted`, and the abandon case misses the same lag. See B8. |
| S11 | RESOLVED | AC-02 says "a pulse goal whose preset has steps a → b → c". The dropped case is now a goal drop that leaves b `dropped` without `waitMs`, which `dropGoal` (4039) and `dropGoalByPerson` (no held steps) make. The optional point about `readyAt` of a step that was dropped without ever being ready was not taken. That is acceptable, because AC-02 does not assert it. |
| S12 | RESOLVED | D is open, then accepted with a link in a sinking debrief (filed and sunk), then reverted. `revertDisposition` restores `from` = open, and `syncRevert` drops the finding step (4694-4699). A sink writes no item history, so `isRevertable` (1572) still holds after the sink. |
| S13 | RESOLVED | `lastSlot` reads slots from the newest one until the first that passes `trial`. Dispositions and reverts come from `itemHistory(lineage)` (indexed, `hub-store.ts:982`). `runs.count` says "over all its pages". |
| S14 | RESOLVED | `goals.created` is "their number". AC-01 states the file run's telemetry. AC-08 has `trial=include` on `accepted`. |

## What holds (recomputed)

- **AC-02 with the new `cycleReadyAt`.** c closes `fail` with `reopen: [b]`. The ids are stored in full
  (`service.ts:2682`), so the comparison with `s.id` works. `finish` puts c in `blocked` (`claims.ts:99`),
  and `reopen` makes b `ready` with a new cycle. When b is claimed again, the three times are b's own
  newest round (its first `done`), c's failing round (which lists b), and a's newest `done`. The latest
  is c's failing round, as the AC says. After b is `done` again, `settle` makes c `ready`. c's times are
  its own failing round and b's newest `done`, so the latest is b's newest `done`, as the AC says.
  b's `waitMs` keeps the first cycle (first round's `startedAt` against a's first `done`).
- **AC-04.** E's dismissal row and D's acceptance row are both `via: debrief-session` rows by a person,
  so `byPeople` is 2. The revert entry has `kind: "revert"` and `goal` = the debrief's goal
  (`service.ts:1754`), so `reverted` is 1. `listDispositions` leaves the revert entry out, so
  `accepted` stays 1. After the revert, D is `open`, so `filedItems` leaves it out of `sinks`.
- **Window and the runs cross-check.** `listRuns` keeps `since ≤ finishedAt < until` (3857-3859) and
  refuses `since ≥ until`. With `until = now + 1`, the route returns `[since, now]`, which is the health
  window. `since = now − days·DAY < now + 1` always holds. `listSteps({updatedSince})` keeps
  `updatedAt ≥ since`, so health reads the same steps the route reads.
- **On-behalf 400.** The order in `app.ts:493` is: role, then scope, then `actingFor`. So a service with
  `goals:read` and the header gets 400, and a person who sends the header gets 403
  `on-behalf-of is for service tokens only`. AC-11's case reads as a service token, which is right.
- **`findings.accepted`** needs nothing beyond `listItems`. It is lineage-level, as the *Trial* rule
  says, and the union in `total` counts an item once.

## Blockers

### B8 (NEW): the `blockedBy` retire and abandon tests do not match `fireSlot`

Where: RL-12.md:195-201 (`blockedBy`); AC-09.

Why: `fireSlot` runs two passes over the pulse's slots, in this order (`service.ts:4934-4945`):
1. **Retire.** For each pending slot (`fired`, no `startedAt`), `advanceSlot` first checks
   `slotStarted(goal, runStep)`. When that holds, it **saves `startedAt = now`** and stops. Only
   otherwise does it retire the slot at `now ≥ until`.
2. **Abandon.** Then it re-reads the `fired` slots. The ones started in pass 1 now have `startedAt`, so
   they are abandoned when the goal is at least `maxGoalAge` old.

The spec has two mismatches with this:
- **The bracket text contradicts `slotStarted`.** The spec glosses the test as "the goal is not done and
  its run step is not under way". But `slotStarted` (4019-4027) is true in four cases: the goal is
  `done`; a headless run step is `done` or `failed`; a headless run step has a `run.started` event; an
  interactive run step is `claimed`, `paused`, `done` or `failed`. A run step that is `done` or `failed`
  is not "under way", so the gloss would retire that slot, while `fireSlot` marks it started. This
  state happens between two ticks. An interactive claim does not call `markSlotStarted` (only a
  `run.started` report does, at :966). A headless step closed without a `run.started` event is also
  marked only on the next tick. So one implementer codes `slotStarted` (the draft does), and another
  codes the gloss. The two differ in AC-09's "a pending slot whose window is over" case if the test
  closes the run step first.
- **Pass 1 can start a slot that pass 2 then abandons.** Take a slot without `startedAt` whose run has
  started (`slotStarted` holds) and whose goal is at least `maxGoalAge` old. `fireSlot` marks it started
  and then abandons it, so the slot does not block. The spec's abandon test asks for "the slot has
  `startedAt`", so the goal is not passed over and is reported in `blockedBy`. This case can happen:
  `maxGoalAge` may be as short as 1 h, and `window` is set separately (`pulse.ts:98-101`). The
  uncommitted draft has this gap too, because it tests `s.startedAt !== undefined`.

Fix: define "started" once, as `fireSlot` does, and use it in both tests. For example:

> A slot counts as **started** when it has `startedAt` or `slotStarted(goal, runStepOf(goal))` holds
> (a fire would mark it started first). A slot's goal is passed over when the goal does not exist, is
> `done` or `dropped`, or is a trial goal; when the slot is not started and `now ≥ until` (the fire
> would retire it); or when the slot is started and `now − goal.createdAt ≥ maxGoalAgeMs` (the fire
> would abandon it).

Then, in AC-09, add "a pending slot whose run step a person has claimed (no tick since), past
`maxGoalAge` → absent", and say that the "window is over" case has a run step that has not started.

## Suggestions

### S15 (NEW): `cycleReadyAt` still misses dependants without rounds

Where: RL-12.md:79-85.

`reopen` (`dag.ts:230-260`) blocks again the `done` and `skipped` dependants of a reopened step, and,
through `recomputeReady`, its `ready` dependants. A dependant that was `ready` but never claimed, or
was `skipped`, has no rounds. So when it becomes `ready` again, `cycleReadyAt` is absent. Its
`waitingMs` is then counted from `readyAt`, which is the dep's **first** `done` round. That overstates
the wait by the whole fix cycle.

Example: `a → b`, `a → d`, `b → c`. While d is still `ready`, c fails with `reopen: [a]`. d is blocked
again, and becomes `ready` once a is done again.

Possible fix: drop "`s` has rounds". Instead, make `cycleReadyAt` present when the latest of the three
times is later than `readyAt`. Without rounds, the first time ("its own newest round") falls away.
The rule then also stays absent in a first cycle. This rarely happens in relay presets, so it can be
a suggestion.

### S16 (NEW): AC-07's runs cross-check should say `until + 1`

Where: AC-07 (RL-12.md:257).

The `runs` row says `until=<until + 1>`, but AC-07 says `until=…`. A World test runs on a fixed clock,
and the last round's `finishedAt` can equal `now`. If the test passes `until` itself, it misses that
row and fails although the build is correct. Write `until=<window.until + 1>` in the AC.

### S17 (NEW): the inclusive window can hold 8 daily slots in AC-07

Where: AC-07; RL-12.md:167.

The window `[now − 7·DAY, now]` is 7 days plus 1 ms long. When the test's `now` falls on a slot time
of the daily pulse, the slots at `now` and at `now − 7·DAY` are both in the window, so there are 8 due
slots, not 7. Either say in AC-07 that `now` is not on a slot time, or that the slot at
`now − 7·DAY` counts. The concepts section can mention the boundary as well.

### S18 (NEW): `cycleReadyAt` of a step held through a rejected or parked round

Where: RL-12.md:79-83.

A rejected round leaves the step `claimed`, and a parked round leaves it `paused`. Neither carries a
`reopen` (`service.ts:2749`, `:2760`). The "own newest round" time then makes `cycleReadyAt` equal to
the rejection or park time, although the step never waited. `waitingMs` is not affected, because it
is computed only for `ready` steps. Still, a card reader sees a "ready" time on a step that did not
wait. Either compute `cycleReadyAt` only for `ready` steps, or say in the guide that for a held step
it is the start of the current attempt.

## Checks

Run: none of the repo's checks. This round reviews a spec, and nothing in it is implemented in the
reviewed commit. I traced AC-02, AC-04, AC-09 and the runs cross-check by hand against the committed
`src/hub/service.ts`, `src/core/dag.ts` and `src/core/claims.ts`, extracted with `git show 1b3d4ae:…`.

Not run: `pnpm lint`, `pnpm typecheck`, `pnpm test`, `pnpm build`, `pnpm check`, `pnpm schemas`,
`pnpm test:web`.
