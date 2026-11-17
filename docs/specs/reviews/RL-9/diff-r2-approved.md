Verdict: APPROVED | Round: 2 | Blocking-open: 0

# Review of the RL-9 diff, round 2

This is a cold review of `git diff 85eb31f..impl/RL-9` (head 4254db7) against `docs/specs/RL-9.md`. I
read the spec rounds first, oldest first (`r1-changes-requested.md`, `r2-changes-requested.md`,
`r3-approved.md`), then `diff-r1-approved.md`. The range holds the spec amendment (bd89b17 on the
test branch, 2c71741 on this one, the same text), the developer's fix 69b944a, the test-writer's
19230f1 and 7f35f76, and two clean merges (2f1edc0, 4254db7; `git show --cc` has no combined diff).

There is no CLAUDE.md. The hard rules I applied are the task's: keep mesh-harness generic, the
developer changes no test, the test-writer changes no product code, no assertion on source text.
No hard rule is broken.

## Process checks

| Check | Result |
|---|---|
| The developer changed no test | **Holds.** 69b944a touches only `src/hub/service.ts`, `docs/guide/concepts.md` and `docs/guide/scheduled-reviews.md`. `git diff 7f35f76 impl/RL-9 -- test '*.test.ts'` is empty. |
| The test-writer changed no product code | **Holds.** 19230f1 and 7f35f76 touch only `test/*.test.ts` and `test/helpers/sink-kit.ts` (new `GATE`, `debriefAccept`, `tick`). |
| New tests failed first | **Holds.** On a throwaway worktree of `test/RL-9` at 7f35f76 (base product code, removed after), all new and changed tests fail: AC-20 (2), AC-21 (2), `test_AC15_usage_errors`, `test_AC15_apply_and_idempotent`, `test_AC18_concepts`, and the AC-04/AC-06 tests that gained `tick()`. Against the pre-fix product code (85eb31f with this branch's `test/`), exactly the three tests of the amendment fail: both AC-20 tests and the re-pinned `test_AC15_apply_and_idempotent`; the other 58 pass. AC-21, T2 and T3 cover behaviour that already worked, so passing on 85eb31f is expected. |
| No assertion on source text | **Holds.** The only new file read is `docs/guide/concepts.md` (AC-18). |
| Generic | **Holds.** Users `ann`, repo `r`, links `tracker.example`. |
| On `impl/RL-9` | `vitest run` of `sink-hub`, `sink-goals`, `sink-cli`, `docs-rl9` → 61 passed. |

## Earlier findings

| r1 | Status |
|---|---|
| I1 `mesh show` repo | Fixed by the spec and concepts: `<repo name>`. |
| I2 backfill reopens finished steps | Fixed: spec rule 3 + AC-20; `filedAfterClose` in `decideSink`. |
| I3 old brief kept | Fixed: rule 3 and rule 4 rebuild the brief (`briefOf`). |
| I4 `goal.sunk` names another goal's step | Not changed (a documented design choice; see I4 below). |
| I5 goal scan per item | Fixed: `sinkGoalsOf` once per record or fold, passed to `findingStepsOf`/`syncDisposition`. |
| I6 guide hub version | Fixed: the guide names 0.1.27 and links "Upgrading to 0.1.27". |
| T1 gate/resume triggers | Fixed: AC-21 (see T7). |
| T2 AC-18 concepts loose | Fixed: scoped to `## Clean-audit goals`. |
| T3 usage errors | Fixed: `test_AC15_usage_errors` (exit 2, stderr, no `/items/sink` request, positive control). |

## The seq tie-break in `filedAfterClose`

`filedAfterClose(cur, row, accepted)` compares the item's latest `accepted` disposition time with the
closed step's `updatedAt`; on an equal millisecond it compares the `seq` of the step's last
`step.done`/`step.dropped` with the `seq` of the last `item.disposed` (`accepted`, same lineage and
fp) of the disposing step. I find it sound:

- **Ordering.** `seq` is the store's insertion order, and every writer that closes a finding step or
  records a disposition runs in `goalTx` (global `events` lock), so `seq` order is commit order across
  transactions and call order within one. Both disposition sources (`submitReview`, the debrief
  `POST /v1/steps/:id/dispositions`) emit `item.disposed` with `step` = the disposition row's `step`,
  so the lookup finds it. Within one transaction, a step is never closed and its item re-accepted:
  `syncFold` closes only fps the record no longer has, and a disposition must name an fp in the
  record.
- **Which close.** `updatedAt` of a done or dropped finding step is the time of its last close:
  `noteFinding` (raised again, revert notes) and `noteStep` do not touch it, and every close path
  (`doneStep`, `closeFinding`, plan design approval, pulse drop) emits the event at that `now`.
  `.at(-1)` picks the last close, which is the one `updatedAt` names.
- **Pruning.** `pruneEvents` deletes by `at`; in the tie case both events share the `at`, so both go
  or both stay. With both gone the function returns `false` (no reopen), which is the safe answer:
  a refile in the same millisecond as the close would have reopened the step in its own sink.
- **Offline replay.** `doneStep` may record a past `at`; then `seq` order is arrival order, not time
  order. That needs an equal millisecond as well and only decides between "reopen" and "keep", both
  defensible. No change asked.
- Checked by mutation: with the committed tests, replacing the tie-break with a strict `>` passes all
  46 `sink-hub`/`sink-goals` tests; with every `tick()` removed from those files, the real code passes
  all 46 and the strict variant fails 4 (AC-04 cycle, AC-06 ×2, AC-20 refile). So the tie-break works
  on a frozen clock, but no committed test exercises it (T5).

## Blockers

None.

## Impl findings (suggestions)

### I4 (REPEAT, suggestion): `goal.sunk` names a step of another goal
Unchanged from round 1. It is documented in `events.md`; leave it or drop the top-level `step`.

### I7 (NEW): the tie-break is not in the spec or the guide
Spec rule 3 says "newer than the step's last change to `done`/`dropped` (its `updatedAt`)" and
`concepts.md` says "newer than the step's last change". The code also reopens on an equal
millisecond when the filing's event comes after the close's event. That follows the intent, but the
text and the code differ. Add one clause to rule 3 (and the concepts sentence): "in the same
millisecond, the event order decides".

### I8 (NEW): a reverted `accepted` still counts as the latest filing
`filedItems` takes the latest `accepted` entry of `listDispositions`, which keeps disposition entries
that a later `revert` entry undid. A debrief that consumes `accepted` items can re-accept a filed item
whose step is done, then revert it (`to` = `accepted`); the next sink or backfill then sees a filing
newer than the close and reopens the step (and the revert keeps the new `link`, so the rebuilt brief
shows it). Rare, since a debrief normally consumes `open` items. Skip dispositions followed by a
`revert` of the same step and round when picking `accepted`.

## Test findings (suggestions)

### T4 (REPEAT, note only): `test_AC19_schema_version` cannot fail first
Unchanged; guards an invariant.

### T5 (NEW): the same-millisecond tie-break has no test
The `k.tick()` calls added to AC-04, AC-06, AC-15 and AC-20 move every refile strictly after the
close, so the `seq` branch of `filedAfterClose` never runs: a strict `>` survives the suite. Add one
World test without `tick()`: a person finishes A's step and the next run refiles A in the same
millisecond → reopened; and a backfill in the same millisecond as the close, with no new filing →
stays done.

### T6 (NEW): the rule-4 brief rebuild is untested
Rule 4 now rebuilds the brief of a `ready`/`blocked` step. Removing `brief` from that update passes
all 56 tests of `sink-hub`, `sink-goals` and `sink-cli`. `test_AC06_rule4_ready_and_held` refiles with
`<link>-2`; assert that the ready step's brief then holds `<link>-2` and not the first link.

### T7 (NEW): the AC-21 resume test builds a state the hub does not produce
`test_AC21_resume_skips_and_sinks` patches `debrief` to `done` in the store without a settle and parks
an unrelated step `p` (not upstream of `file`, as AC-21 says). It does catch a missing `sinkAfter` in
`resumeStep` (checked by mutation: removing it fails the test), so it is a valid test. But AC-21's
wording cannot happen as written: resuming a parked step upstream of `file` makes it `ready`, so
`file` cannot be decided by that resume. A natural world exists: `file` itself parked (`when:
{open: true}`, no open item left), then resumed → `settle` skips it → its sink runs. Reword AC-21
to that case and test it without store patches.

### T8 (NEW, note): the test plan has no AC-20/AC-21 entries
`docs/specs/plans/RL-9-test-plan.md` does not list AC-20 or AC-21; the test file header does. Add
them so the plan stays the index.

## Checks

- Worktrees under the scratchpad (removed after): `test/RL-9` at 7f35f76; 85eb31f with this branch's
  `test/`; `impl/RL-9` for the mutations (strict `>`, ticks removed, no rule-4 brief, no `sinkAfter`
  in `decideGate`/`resumeStep`).
- `git log 85eb31f..impl/RL-9 --no-merges --stat`, `git show --cc` of both merges.
- Not rerun by me: `pnpm check` (reported green, 2614 passed) and `pnpm schemas` (reported no diff).
