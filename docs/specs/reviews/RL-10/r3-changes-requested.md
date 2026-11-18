Verdict: CHANGES REQUESTED | Round: 3 | Blocking-open: 1

# Review of the RL-10 spec, round 3

This is a cold review of `docs/specs/RL-10.md` at commit 04d8246 (round-2 review applied). I read
RL-9 (shipped in v0.1.27), then round 1 (`r1-changes-requested.md`) and round 2
(`r2-changes-requested.md`), oldest first. The revision adds the names "Closed", "Home goal", "Home
step" and "Foreign step", a new section "Placing the home step", the filed-after-every-close gate,
the topic-deleted skip of a move, the fold's `item.retargeted`, the revert row through placing, the
zero-entry backfill and its permission, and AC-06, AC-06b, AC-06c and AC-06d. It removes rule 2a
and the "updated last" fallback. I checked it against:
- `src/hub/service.ts`: `submitReview` (the `first` map, the problems list and its 422 text, the
  fold, `syncFold`, the dispositions), `applyDisposition`, `revertDisposition`, `isRevertable`, and
  the "clean-audit goals (RL-9)" section: `cleanAuditGoal`, `filedItems`, `filedAfterClose`,
  `decideSink` (the `NEW_GOAL` placeholder, the hash-clash guard, rule 5, `settle`), `writeSink`,
  `runSink`, `sinkAfter`, `sinkGoalsOf`, `findingStepsOf`, `closeFinding`, `reopenFinding`,
  `syncDisposition`, `syncFold`, `syncRevert`, `dropGoalByPerson`, `sinkItems`; `reopenedFinding`;
- `src/core/dag.ts` (`settle`, `reopen`), `src/hub/app.ts` (no step reopen route outside gates);
- `src/cli/review-commands.ts` (`mesh items sink` output);
- `test/helpers/sink-kit.ts` (`raise` defaults to `coverage: "complete"`), `test/sink-hub.test.ts`
  (the revert test asserts `step.reopened` reason `reverted`, line 614), `test/sink-cli.test.ts`,
  `test/sink-goals.test.ts`.

There is no CLAUDE.md. The hard rules I applied are the task's: keep mesh-harness generic (the
spec's names `r`, `x`, `y`, `a.ts`, `src/a.rs`, `group/x` are generic) and stage and commit by name.
No hard rule is broken.

## Earlier findings

| Finding | Status |
|---|---|
| r1 B1, B3, B4, B5; r1 S1–S8 | Fixed in revision 1 (see round 2). |
| r1 B2 / r2 B1 move into a goal holding a live closed step | **Fixed.** Placing: a live closed home step is "for a move always" reopened (`fixCycles` + 1, reason `moved`); move step 2 opens the home step "as above" instead of upserting a new one. AC-06b's second half (retarget D to `x` while `x.f-h` is live and `done`) fails on an implementation that overwrites the step or leaves it `done`. |
| r2 B2 rule 2 over a moved-away step | **Fixed.** The home step is defined by id "whatever its state, moved-away or not", and a moved-away home step is revived, never created over; the backfill goes through the same placing. The revive's fields and event are stated (r2 S4). AC-06b's first half (revive by sink, "no other step id created in `r`", event `step.reopened` reason `moved`) fails on the overwrite. |
| r2 B3 one live open step | **Fixed in the contract.** Path 1 (rule 3 vs a held foreign step): the foreign check runs first, a held foreign step stops the item with the note; AC-06c guards it. Path 2 (revert reopens dropped steps in several goals): the reopening row now acts only on the home step, through placing. The "updated last" fallback is gone. I walked every path that can open a finding step (sink rules 2–3, revive, move, revert, backfill; `dag.reopen` only runs from a gate, and clean-audit goals have no plan steps or gates; release and resume turn a held step open, which is the same step): each opens only the home step, and only after the one open foreign step, if any, was closed by the move. The invariant holds. Path 2 still has no criterion (S2). |
| r2 S1 where the fold move runs | Fixed: after the item rows are saved, before the resolved sync. |
| r2 S2 move into a deleted topic | Fixed: the move is skipped with the note. |
| r2 S3 backfill with zero entries | Fixed: `goal` and the CLI line keep RL-9's; permission includes the lineage repo's goal. |
| r2 S4 revive fields and event | Fixed. |
| r2 S5 `--from-key-path` and `group/x` | Fixed: the contract says `group/x` is reached only with `--repo`. |
| r2 S6 the 422 text | Fixed in the contract; **not in AC-03** (B1 below). |
| r2 S7 sink move criterion | Fixed: AC-06d. |
| r2 S8 wording | Fixed: AC-06 names the debrief shape; the fold emits `item.retargeted`. |

## What holds

- The placing rule is one rule, applied from one place, and its order is right: foreign first (move
  or stop), then the home step by what exists. Rule 2a, its "done elsewhere is ignored" branch and
  the singular "has one" ambiguity of round 1 are gone with it.
- The filed-after-every-close gate is buildable from today's `filedAfterClose`: it compares one
  step's `updatedAt` (and the event order on a tie) with the latest `accepted`; RL-10 calls it once
  per finding step of `(lineage, fp)` for the topic. For a lineage with one step per fp (every RL-9
  case), it is RL-9 rule 3 unchanged. A move is not gated, which is what AC-06d needs (the sink
  moves an open foreign step after a refile).
- The move cannot meet a held or open home step: by the invariant, if the foreign step `S` is not
  closed, the home step is closed or moved-away or absent. The "live and open or held → unchanged"
  branch is therefore only reached by a sink on its own home step (RL-9 rule 4), as intended.
- AC-06, AC-06b, AC-06c and AC-06d each have a Surface and a FAIL state that the bug they guard
  produces: an implementation that keeps rule 2a's "done elsewhere → create", RL-9's upsert, RL-9's
  rule 3 without the foreign check, or a sink that does not move, fails at least one of them.
- AC-06's revert half is reachable: the later run's audit adds a `fold` history entry before the
  debrief, so the debrief dismissal is the item's last history entry and `isRevertable` passes; the
  sync writes no item history.
- The fold move and the resolved sync stay disjoint (round 2), and the fold move is placed.
- No migration: `movedTo` and `ItemRow.repo` are JSON fields; `SCHEMA_VERSION` stays 11.

## Blockers

### B1 (REGRESSION-OF-OWN-REPAIR of r2 S6): AC-03 asserts a 422 text the contract no longer produces

The repair of r2 S6 changed the contract's text to
`item <fp> is listed for more than one repo (<r1>, <r2>, …); put the repo in its key`, "as one entry
of RL-2's record problems message". AC-03 still expects
`item <fp> is listed for repos x and y; put the repo in its key`. A test written from AC-03 fails on
an implementation that follows the contract, and the developer cannot make it pass without breaking
the contract (or editing the test, which the diff review forbids). The spec holds two decisions for
one response text, so one of them is wrong (blocker rule 2, as round 1 treated B5's contradiction
between two criteria).

**Fix:** in AC-03 write: 422 whose message (RL-2's `the review record has <n> problem(s): …`)
contains `item <fp> is listed for more than one repo (x, y); put the repo in its key`. Consider a
third item with `repo: z` in the same record, to pin "all repos, distinct, in record order".

## Suggestions

### S1 (NEW): AC-05 as written closes E through the resolved sync
The kit's `raise` submits `coverage: "complete"` (`sink-kit.ts:205`). If the later run's audit
raises only D (as AC-05 says), E is resolved in the same fold. The fold move runs first (E is
settled to `ready` and gets the note), then the resolved sync closes E to `done`. A test that checks
"E is `ready`" then fails on a correct implementation. Say "raises D with `repo: x` and E again (no
repo)", or "with `coverage: partial`". The same care applies to AC-06b and AC-06c, which do not
assert other items.

### S2 (REPEAT of r2 B3, the criterion part): no criterion for the revert over a live dropped step elsewhere
AC-06's revert half only has a **moved-away** step in the other goal, which "moved-away steps are
never matched" already excludes. An implementation that keeps RL-9's `syncRevert` (reopen every
`dropped` match) and only skips `movedTo` passes AC-06, yet reopens two steps on round 2's path:
D's `r` step dropped by a stage dismissal; D raised with `repo: x` and refiled (`x.f-h` created); a
debrief dismisses D (`x.f-h` dropped); revert → only `x.f-h` reopens, `r.f-h` stays `dropped`. Add
it to AC-06 or a new AC-06e, with "exactly one live non-closed step for D" in the FAIL column.

### S3 (NEW): the revert row through placing, three details
- **Event reason and deps.** Placing says a live closed home step is "reopened as RL-9 rule 3 (event
  reason `refiled`)". RL-9's revert row says reason `reverted`, deps unchanged, and the RL-9 test
  asserts `reverted` (`sink-hub.test.ts:614`). AC-13 would catch a builder who reads placing
  literally, but say it in the sync section: the revert reopen keeps reason `reverted`, `from` the
  debrief step, deps unchanged.
- **Which home states.** RL-9 reopens only a `dropped` step. Placing's "live and closed" includes
  `done`. Say that the revert reopens the home step only when it is `dropped` (or say otherwise).
- **No home step, or a moved-away one.** D's `r` step dropped by a debrief dismissal, then
  `mesh items retarget … --repo x` (nothing to move), then the revert: the home is the `x` goal,
  which may not exist. Placing says "none → created" (and rule 1 would open the goal); RL-9's row has
  no such case. Say whether the revert creates (and opens a goal), revives a moved-away home step,
  or does nothing.

### S4 (NEW): a sink or backfill can still create work a person finished elsewhere
The gate covers revive and reopen, not creation. D's step `x.f-h` is finished (`done`); D is
retargeted to `r` (D never had a step in `r`); `mesh items sink <lineage> --topic ci` (or a resumed
second round of the same `file` stage) → home `r` has no step, so rule 2 creates `r.f-h` without
any new filing. That contradicts the spirit of the spec's own sentence ("a backfill never revives
work a person finished elsewhere") and of RL-9 AC-20. The next complete audit resolves it, so this
is not a blocker. Consider applying the gate to creation too when any finding step of
`(lineage, fp)` for the topic exists.

### S5 (NEW): `--dry-run` "same result" when the target goal is new
AC-07 asks the dry run for "the same result as the first real call". `moved` lists step ids. When the
`x` goal does not exist yet, a dry run cannot know its id (RL-9's sink dry run returns `goal: null`
and ids under the `<new>` placeholder). Say what a dry run puts in `moved[].to` for a goal still to
be opened (for example `<new>.f-…`, as `decideSink`), and in AC-07 either pin that the `x` goal
already exists or compare all fields except that id.

### S6 (NEW): small wording
- A sink revive emits `step.reopened` reason `moved` (AC-06b), though nothing moved in that call.
  If that is intended, say so in `docs/events.md`; otherwise use `refiled` and add the RL-9 note
  `refiled by <from>` (the revive's note is only stated for a move).
- `docs/events.md` list: add `step.reopened` reason `moved` next to `step.dropped` reason `moved`.
- Move step 2 creates the home step "with `S`'s `severity`, `title`", while placing's "none →
  created (RL-9 rule 2)" rebuilds them from the item. They agree today; name one source.
- AC-06d's first sentence is hard to parse; order it as the steps happen (claim, retarget, release,
  later run raises D without `repo`, `file` refiles).

## Checks

Run: none of the repo's checks. This round reviews a spec, and nothing is implemented. I read the
code and tests named above.

Not run: `pnpm lint`, `pnpm typecheck`, `pnpm boundaries`, `pnpm test`, `pnpm build`, `pnpm check`,
`pnpm schemas`, `pnpm test:web`. The Postgres legs of the store contract were not run
(`MESH_TEST_PG_URL` is unset).
