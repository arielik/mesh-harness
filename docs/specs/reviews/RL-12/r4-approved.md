Verdict: APPROVED | Round: 4 | Blocking-open: 0

# Review of the RL-12 spec, round 4

This is a cold review of `docs/specs/RL-12.md`, revision 4 (commit fbb3537 on `spec/RL-12`). I read the
round-1 to round-3 reviews first, then the spec, and the diff from revision 3 (`git diff 1b3d4ae
fbb3537`). Then I checked the changed rules against the code:
- `src/hub/service.ts`: `fireSlot` (the retire, abandon and overlap passes), `advanceSlot`,
  `slotStarted`, `runStepOf`, `pendingSlotOf`, `markSlotStarted`, `advancePending`, `filedItems`,
  `revertDisposition`;
- `src/core/pulse.ts` `overlapBusy`; `src/store/hub-store.ts` `listSlots` (order and `pending`);
  `src/protocol/pulse.ts` (`SlotReason`, `until`).

I also read the uncommitted implementation (`src/core/stage-times.ts`, `health`, `blockedBy` in
`src/hub/service.ts`) and ran `test/pulse-runs-hub.test.ts` and `test/rl12-smoke.test.ts`.

Names stay generic (`p-1`, `alpha`, `beta`, `a`–`d`, `D`, `E`, `F`, `G`): the public-boundary rule holds.

## Round-3 findings

| Id | Status | Reason |
|---|---|---|
| B8 | RESOLVED | "Started" is now defined once (RL-12.md:200-205) as `startedAt` or `slotStarted(goal, run step)`, and both the retire test (not started, `now ≥ until`) and the abandon test (started, too old) use it. This is what `fireSlot` does: pass 1 calls `advanceSlot`, which marks a pending slot started when `slotStarted` holds and retires it only otherwise. Pass 2 then abandons every `fired` slot with `startedAt`, including the ones pass 1 just marked. The gloss now lists the four `slotStarted` cases correctly. AC-09 adds the case "interactive run step claimed, not yet marked, goal past `maxGoalAge` → absent". That case can be built, because `overlapBusy` counts the run step whatever its mode (`pulse.ts:127`), so without the fix the goal would be reported. The round-3 request to say that AC-09's "window is over" case has a run step that has not started was not taken (S19). |
| S15 | RESOLVED | "`s` has rounds" is gone. `t` takes the own newest round only "when it has rounds", and `cycleReadyAt` is present only when `t` is later than `readyAt`. A `ready` or `skipped` dependant without rounds now gets the dep's newest `done` time once that dep is done again. In a first cycle, `t` equals `readyAt` (each dep's newest `done` is its first), so the field stays absent. |
| S16 | RESOLVED | AC-07 says `until=<until + 1>`, as the `runs` row does. |
| S17 | RESOLVED | AC-07 says that the test's `now` is not a slot time of the pulse, so the window holds exactly 7 daily slots. The wording is awkward (S21). |
| S18 | RESOLVED | The spec takes the "say so" option: for a step held through a rejected or parked round, `t` is that round's end, and the guide says so. `waitingMs` is not affected, because it is computed only for `ready` steps. `debriefs.oldestMs` uses that time for a held debrief, which is reasonable. |

## What holds (recomputed)

- **`blockedBy` against `fireSlot`, case by case**, at the same `now`:

  | Slot (state `fired`) | `fireSlot` | Spec r4 |
  |---|---|---|
  | goal missing | `advanceSlot` returns it unchanged; abandon and overlap skip it | passed over |
  | goal `done`, `dropped` or trial | may retire or abandon it; overlap skips it | passed over |
  | not started, `now ≥ until` | pass 1 retires it (`missed`, goal dropped) | passed over |
  | not started, `now < until` | stays; overlap checks it | checked |
  | `slotStarted` holds, no `startedAt`, young | pass 1 marks it; overlap checks it | started, young: checked |
  | started (either way), `now − createdAt ≥ maxGoalAgeMs` | pass 2 abandons it | passed over |
  | started, young | overlap checks it | checked |

  The order is the same: `listSlots` orders by `at` descending, then `slot` descending (as binary), for
  `state: "fired"` and `pending` alike, which is card order. A fired slot that has a goal always has
  `until` (`fireSlot` sets it with the goal), so "`now ≥ until`" never meets an absent `until`.
- **`cycleReadyAt` with the "later than `readyAt`" rule.** First cycle with deps: `t` = `readyAt` →
  absent. No deps, first cycle, no rounds: no `t` → absent. Reopened directly: the reopening round is
  later → present. The failing step that waits for its reopened dep: the dep's newest `done` is later
  than its own failing round → present, as AC-02 asserts. A dependant without rounds whose dep was done
  again: present (S15). Two deps where one was reopened and done again before the other's first end:
  `t` = `readyAt` → absent, which is right, because the step was ready only once.
- **The implementation of these two rules** (`stageTimes` in `src/core/stage-times.ts`, `blockedBy` at
  `service.ts:4286`) follows revision 4. `blockedBy` calls `slotStarted` itself, so it cannot drift from
  `advanceSlot`.

## Blockers

None.

## Suggestions

### S19: AC-09's "window is over" case should name a run step that has not started

Where: AC-09.

Round 3 asked for this, and revision 4 did not add it. With the r4 rule, a pending slot whose window is
over but whose run step is claimed (not yet marked) in a goal younger than `maxGoalAge` is **started**,
so it is checked and reported. A test that builds "window is over" with a claimed run step and expects
`absent` fails on a correct build. Write it as: "a pending slot whose window is over and whose headless
run step is still `ready` (offered, not accepted) → absent".

### S20: say "not headless" in the `started` gloss, and rewrap line 205

Where: RL-12.md:201-205.

`slotStarted` tests `policy.mode === "headless"`, and treats every other step (no mode, `interactive`,
`debrief`) as the "interactive" branch. The gloss says "it is interactive". A step with no mode is
interactive by the `StageCard.mode` rule, so this reads the same in practice. Still, "otherwise
(not headless)" matches the code exactly. Line 205 is also not wrapped like the rest of the file.

### S21: AC-07's new clause is in the middle of the `runs` sentence

Where: AC-07.

"…(and with `trial=include`); the test's `now` is not a slot time of the pulse, with sums and waste
counts as defined; …" now reads as if "with sums and waste counts as defined" were about `now`. Move
the clock condition to the start ("At a `now` that is not a slot time of the pulse, a daily pulse, a
7-day window…").

### S22: does a reverted `accepted` row count as the "latest accepted disposition"?

Where: RL-12.md:193 (`accepted`); also the `sinks` text at 132-134.

Example: item X is accepted in goal A of pulse P inside the window, accepted again in goal B of pulse Q,
and B's acceptance is reverted. `revertDisposition` restores `from` = `accepted`, so X is `accepted`
now. If the reverted row of B is the latest `accepted` row, X counts for neither pulse. If reverted rows
are skipped, X counts for P. `filedItems` (`service.ts:4451`) takes the last row from
`listDispositions`, which keeps reverted rows, and the draft `health` does the same, so this is
consistent with the code. Saying "reverted rows included, as `filedItems` reads them" closes the
question for a second implementer. The case is rare, so this is a suggestion.

### S23: "any step of G" for a reopening round, after a move

Where: RL-12.md:80-81.

A step that reopened `s` and was later moved to another goal no longer is "a step of G". The draft
leaves it out (`x.goal !== s.goal`). That is a defensible reading. One clause ("moved-away steps left
out, as in `stages`") would make it explicit.

### S24 (implementation, not the spec)

- The working tree's `blockedBy`, `stageTimes` and `health` match revision 4 on every point I checked.
  `test/pulse-runs-hub.test.ts` (11 tests, AC-01 to AC-06) and `test/rl12-smoke.test.ts` pass.
- There are no tests yet for AC-07 to AC-12. The AC-09 case added in this revision needs one.
- `GET /health` (public liveness) and `GET /v1/health` (the scorecard) now both exist. The guide
  section should say which is which, so nobody points a liveness probe at the scorecard, which reads
  every raising record.

## Checks

Run: `npx vitest run test/pulse-runs-hub.test.ts test/rl12-smoke.test.ts` → 2 files, 12 tests passed.

Not run: `pnpm lint`, `pnpm typecheck`, the full `pnpm test`, `pnpm build`, `pnpm check`,
`pnpm schemas`, `pnpm test:web`. This round reviews a spec. I traced `blockedBy` and `cycleReadyAt`
by hand against `src/hub/service.ts`, `src/core/pulse.ts` and `src/store/hub-store.ts` in the working
tree.
