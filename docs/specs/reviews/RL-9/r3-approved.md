Verdict: APPROVED | Round: 3 | Blocking-open: 0

# Review of the RL-9 spec, round 3

This is a cold review of `docs/specs/RL-9.md` at commit d505357 (revision 2). I read round 1
(`r1-changes-requested.md`) and round 2 (`r2-changes-requested.md`) first. The revision changes the
`requires` row, the topic checks, "never fails the caller", rules 3 and 5, the revert row, `mesh goal
drop`, the ready order and AC-07, AC-08, AC-09, AC-11, AC-13 and AC-14. I checked it against:
- `src/hub/service.ts`: `settleSteps`, `holdsFor`, `goalComplete`, `submitReview`, `disposeStep`,
  `revertDisposition`, `debriefOr409`, `isRevertable`, `listSteps`, `deleteTopic`;
- `src/core/dag.ts` (`settle`), `src/core/review.ts` (`lineageOf`, `consumedNow`, `whenHolds`),
  `src/core/policy.ts` (`isDebrief`, `validatePolicies`);
- `src/protocol/hub.ts` (`DisposeRequest`).

There is no CLAUDE.md. The hard rules I applied are the task's: keep mesh-harness generic, and stage
and commit by name. No hard rule is broken.

## Earlier findings

| Finding | Status |
|---|---|
| r1 B1–B4, r1 S1–S13 | Fixed in revision 1 (see round 2). |
| r2 B1 AC-07 revert half | **Fixed.** (b) uses `mesh_dispose` on a debrief stage (`via: "debrief-session"`), then `POST /v1/steps/<debrief step>/dispositions/revert` before any other change. `revertDisposition` accepts it (`debriefOr409`, `isRevertable`: the dismissal is the item's latest history entry; the step sync writes no item history). The revert restores `d.from` = `accepted` and keeps `link`, so D is filed again. The deps of the reopened step are stated (unchanged). An implementation without the revert row leaves D's step `dropped`, so (b) can fail. Fixture gaps in S1. |
| r2 B2 AC-09 skip never happens | **Fixed.** `file` now has `when: {open: true}`, and the audit raises only F. After the debrief accepts F with a link, `consumedNow` is false for F (`accepted` with `link`), so `whenHolds` is false and `settle` sets `file` to `skipped` (`dag.ts:126`). "`file` not skipped" is in the FAIL column. A sink that only hooks `done` leaves F without a step, so the AC fails on that bug. Fixture gap in S2. |
| r2 S1 topic check text | Fixed: `bad topic "{topic}"` pinned, `all` refused by name, lowercasing stated, AC-11 updated. |
| r2 S2 bound "never fails" | Fixed in the text: checks before the first write, decided in memory, store errors propagate, `deleteTopic` leaves `Goal.sink`. AC-10 still does not assert "nothing written": S3. |
| r2 S3 refill and offered-first | Fixed: the refill runs within each part; AC-13 names the offered S4 finding step. |
| r2 S4 deps of a reopened step, order | Fixed: a reopened step keeps its deps and adds; deps are resolved after all steps of the event exist. |
| r2 S5 `step.reopened` payload | Fixed (`by`, `reason`, `fixCycles`, plus `from`). The `user` of sync events is still not named: S4. |
| r2 S6 drop and parked, pulses, calibration | Fixed: parked steps are dropped, pulse and calibration goals named, AC-14 covers parked and a pulse goal. |
| r2 S7 `requires` refusal | Fixed: schema 400 for a malformed list, service 422 for the whole record, wording changed. |
| r2 S8 409 before validation | Fixed: stated, and AC-08 sends a valid and an invalid plan. |
| r2 S9 parts without an AC | Partly fixed: the held-step note on `dismissed` and the `deferred` row are now in AC-07 (a). The rest is S4. |

## What holds

- Every AC has a Surface and a FAIL state. The two round-2 blockers can now fail on the bug they
  guard.
- The skip trigger is reached by today's paths: the debrief's `mesh_done` calls `settleSteps`
  (`service.ts:2550`), whose `holdsFor` reads the run record of `file` (the audit's).
- F is "filed in the goal": its latest `accepted` disposition is the debrief's, in the sink stage's
  goal.
- `DisposeRequest` already has `link`, so a debrief can file an item with `mesh_dispose`.
- AC-13 is sharp. `listSteps` puts offered-here steps first (`service.ts:2341`), and the S4 step must
  stay first even though the severity refill would move S1 ahead of it if the parts were ignored.
- `deleteTopic` does not refuse a topic that goals or pulses use, so AC-10's setup is possible.

## Blockers

None.

## Suggestions

### S1 (NEW): pin the AC-07 (b) fixture
`disposeStep` refuses an fp that is not in the record of the debrief's run (422
`no item <fp> in the record of <run>`). `validatePolicies` refuses a debrief without
`output: review-record` (`policy.ts:81`). AC-07 (b) gives neither. Write it as "a later run whose
audit raises D again (`repeat`) and whose `debrief` step has `mode: debrief`, deps `[audit]`,
`consumes: [accepted]`, `may_set: [dismissed]`, `output: review-record`; the person claims it and
dismisses D with `mesh_dispose`". A test-writer would find both gaps from the hub's own errors, so
this is not a blocker.

### S2 (NEW): pin the AC-09 debrief
The same gap applies to AC-09's `debrief`: it needs `mode: debrief`, deps `[audit]` and
`output: review-record`. Also name the call: `mesh_dispose` with `disposition: accepted` and `link`,
then `mesh_done` on the debrief. As written, "debrief" could also be read as a plain consuming stage
named `debrief` that uses `mesh_review`. Both readings make `file` skip, but one sentence removes the
doubt.

### S3 (REPEAT of r2 S2, AC part): AC-10 should assert that nothing was written
The text now says that a failed check writes nothing of the sink. AC-10 checks only the note and the
event. Add "no finding step added or reopened, and no `goal.sunk`" to the criterion and the FAIL
column, so a sink that writes first and notes after cannot pass.

### S4 (REPEAT of r2 S5/S9, rest): still no criterion or name for
- `goal.created` carrying `{ title, sink }` (AC-01 checks the goal, not the event payload);
- `goal.sink_failed`'s payload `{ from, reason }`;
- the `failed` state in the `resolved` and dismiss rows;
- the `user` of the `step.done` and `step.dropped` events that the sync emits (the decider? the
  auditor's holder?).

Add the ones you want guarded.

### S5 (NEW): reverting a debrief's `accepted` after the sink
The revert row covers only a reverted dismissal. A debrief that filed an item (AC-09's shape) can
have that `accepted` reverted while it is still the item's latest change. The item then goes back
to `open` or `confirmed`, but its finding step stays open. The table's last row ("a state not
listed → nothing") does not cover this item event. Say whether that is intended (for example, a
note `unfiled by <debrief step>`), or drop the step as the dismissal row does.

## Checks

I ran none of the repo's checks. This round reviews a spec, and nothing is implemented. I read the
code named above.

Not run: `pnpm lint`, `pnpm typecheck`, `pnpm boundaries`, `pnpm test`, `pnpm build`, `pnpm check`,
`pnpm schemas`, `pnpm test:web`. The Postgres legs of the store contract were not run
(`MESH_TEST_PG_URL` is unset).
