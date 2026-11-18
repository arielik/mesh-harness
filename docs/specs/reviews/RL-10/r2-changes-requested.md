Verdict: CHANGES REQUESTED | Round: 2 | Blocking-open: 3

# Review of the RL-10 spec, round 2

This is a cold review of `docs/specs/RL-10.md` at commit 624a641 (round-1 review applied). I read
RL-9 (shipped in v0.1.27) and round 1 (`r1-changes-requested.md`) first. I checked the spec against
the code it touches:
- `src/hub/service.ts`: `submitReview` (the `first` map, the problems list, the fold, `syncFold`, the
  dispositions and `sinkGoals`), `applyDisposition`, `revertDisposition`, `isRevertable`, and the
  "clean-audit goals (RL-9)" section: `cleanAuditGoal`, `filedItems`, `filedAfterClose`, `decideSink`
  (rules 2-5, the hash-clash guard, `settle`), `writeSink`, `runSink`, `sinkAfter`, `sinkGoalsOf`,
  `findingStepsOf`, `closeFinding`, `reopenFinding`, `syncDisposition`, `syncFold`, `syncRevert`,
  `sinkTopic`, `dropGoalByPerson`, `sinkItems`; `deleteTopic`;
- `src/core/review.ts` (`isRaising`, `fingerprint`, `uniqueFps`), `src/core/finding-step.ts`
  (`reopenedFinding`, `findingStepId`), `src/core/dag.ts` (`settle`);
- `src/protocol/goal.ts` (`Step`), `review.ts`, `hub.ts` (`SinkRequest`, `SinkResult`), `hub-api.ts`;
  `src/hub/app.ts` (`POST /v1/steps/:id/review` returns 201, `POST /v1/items/sink`);
- `src/store/hub-store.ts` (steps and items are JSON values; `topic` has no foreign key from goals);
- `src/cli/review-commands.ts` (`itemsSink`), `src/cli/show.ts`;
- `test/helpers/world.ts`, `sink-kit.ts`, `review-kit.ts`; `test/sink-cli.test.ts`,
  `sink-hub.test.ts`, `sink-goals.test.ts` (the RL-9 assertions RL-10 must keep).

There is no CLAUDE.md. The hard rules I applied are the task's: keep mesh-harness generic (the spec's
names `r`, `x`, `y`, `a.ts`, `src/a.rs` are generic) and stage and commit by name. No hard rule is
broken.

## Round 1 findings

| R1 | Status |
|---|---|
| B1 same fp, two repos | Fixed. RL-2's first-wins is stated correctly; two items with one fp and different repos are a 422 with a named text, raised in the problems list before any write (the record is refused whole). AC-03 asserts both the 422 and the 201 for two items with one repo. Text details in S6. |
| B2 moved-away steps look live | Partly fixed. `Step.movedTo` marks the left-behind step, "live finding step" excludes it from every lookup, the move back into a goal holding the moved-away step revives it, rule 2a now says what a `done`/`skipped` step elsewhere means, and AC-06 covers revert-after-move and `r` → `x` → `r` by retarget. Not fixed: a move into a goal that holds a **live closed** step with the same id (B1 below, REPEAT). The repair itself opened a new clash on rule 2 (B2 below). The invariant the repair rests on does not hold (B3 below). |
| B3 history entry | Fixed: no item history entry; an `item.retargeted` event instead; history and RL-4 revert unchanged; AC-07 asserts "no item history entry added". |
| B4 inventory note | Fixed: removed; "Out" says no inventory check. |
| B5 backfill output | Fixed for the one-entry case: exactly RL-9's lines, so `test/sink-cli.test.ts` lines 285/294/297/299 hold; an entry is "a target repo with at least one selected item", so a no-op call still prints a line. The zero-entry case is open (S3). |
| S1 fold never moves | Fixed: the fold move. |
| S2 dependants in `A` | Fixed: note `dep <S id> moved to <new id>`, asserted in AC-05. |
| S3 which requires | Fixed: "Requires of an item" = union over all `accepted` dispositions. |
| S4 `--from-key-path` | Fixed: a path containing `/` or ending in an extension is left out with a note; AC-08 covers both. Side effect in S5. |
| S5 compatibility | Fixed: hub, then daemons, then auditors. |
| S6 AC-03 unit half | Fixed: dropped. |
| S7 surfaces | Fixed: `POST /v1/steps/:id/review` 400, AC-05's dependant, AC-09's CLI exit 2 and `fps: []`, the `→` format. |
| S8 permission into other goals | Fixed: stated; events carry the caller (retarget) or `A`'s owner. |

## What holds

- The fold move fits `submitReview`'s transaction. A raising record cannot carry dispositions (it is
  a problem), and `isRaising` = output without `consumes`, so in one request either the fold (with
  `syncFold` and the move) runs, or dispositions (with `syncDisposition`) run, never both. A sink
  never runs in `submitReview`; it runs on `doneStep`/`settleSteps` of the sink stage, a later
  request. Inside the fold, an item that moves is in the record, so it is never in `f.resolved`; and
  the `again` note goes to `done` steps, which a move never touches. So the move and `syncFold` touch
  disjoint steps, and `closeFinding`/the move each read `listSteps` fresh. The order between them
  does not change the outcome (S1 still asks to state it).
- The B1 refusal is cheap to build: `items` already carries each item's fields before `first` is
  built; the check is one more entry in `problems`, which is thrown before any `saveItem`.
- `Row` semantics are buildable: `next = { ...row, … }` already carries unknown fields, so a
  `retarget`-set `repo` survives a record without `repo` (AC-02), and an explicit lineage repo in a
  record is the only way to reset it, which is consistent with "target before and after differ".
- `findingStepsOf` looks up `${goal}.${findingStepId(lineage, fp)}` per goal; widening the goal list
  to every non-dropped clean-audit goal and skipping steps with `movedTo` is a local change.
- `Step` is a JSON value; `movedTo` and `ItemRow.repo` need no column; `SCHEMA_VERSION` stays 11.
- RL-9 tests: for a lineage whose items carry no `repo`, every target is the lineage repo, so the
  widened lookup finds the same steps as `sinkGoalsOf(lineage)`, grouping yields one entry, and the
  CLI prints RL-9's lines. I found no RL-9 assertion that changes (except possibly S3's zero case,
  which no RL-9 test exercises).
- No races: retarget, the fold move and the sink all run in `goalTx` (`store.tx` + `serialize()`).

## Blockers

### B1 (REPEAT of R1 B2.3): a move into a goal that holds a live closed step with the same id

Move step 2 has two branches: `B` holds "a step with the same id (a moved-away step …)", or "otherwise
a new step in `B`: same local id". The parenthetical assumes the only step `B` can hold with that id
is a moved-away one. It is not. A live `done` or `dropped` step of `(lineage, fp)` in `B` has the same
id and is not moved-away. One path (all steps in the RL-9 rules as written):
1. D filed for `x`: step `x.f-h` (ready). A person finishes it (`done`).
2. `mesh items retarget L fpD --repo r`: step 3 leaves the `done` step alone; row target `r`.
3. A later run refiles D (target `r`): `r` has no live step, the `x` step is `done` → ignored by
   rule 2a, so rule 2 creates `r.f-h` (ready).
4. A later raising record sends D with `repo: x`: the fold moves `r.f-h` to `x`. `B` = `x` holds
   `x.f-h`, `done`, live. Neither branch of step 2 fits; "otherwise a new step" upserts over the done
   step (`saveSteps` is by id), which mixes two lives' notes and rounds under one id with
   `fixCycles` from `S`.

The same holds with `x.f-h` `dropped` by a dismissal instead of `done`. Round 1 asked for exactly this
("Define the move into a goal that already holds a closed step with the same id"). Blocker rule 2.

**Fix:** state one rule for "the target goal already holds a step with this id", whatever its state:
moved-away → revive (as now); live `done`/`dropped`/`skipped` → reopen it as RL-9 rule 3 with the
moved step's fields (`fixCycles + 1`, event `step.reopened { reason: "moved", from: <S id> }`, note
`moved from <S id>`), and `S` becomes moved-away as step 3. Add the path above to AC-06 or a new AC.

### B2 (REGRESSION-OF-OWN-REPAIR): rule 2 over a moved-away step

The B2 repair makes moved-away steps invisible to "every lookup … (rules 2-5 …)". Rule 2 runs when
the target goal "has no live finding step for `(lineage, fp)`". When that goal holds a **moved-away**
step with the same id, rule 2 creates a "new step" with that id, which overwrites it (in
`decideSink`, `cur = all.get(id)` finds the moved-away step; if the implementer treats it as absent,
as the spec says, `put` replaces it). Only the move (step 2) revives; rule 2 does not. Paths:
- D moved `r` → `x` (fold); the `x` step is finished (`done`); a later run raises D with `repo: r`
  (fold: target `x` → `r`, the `x` step is done, nothing moves) and files it → sink group `r`: no live
  step in `r`, the `x` one is `done` → rule 2 creates `r.f-h` over the moved-away `r.f-h`.
- The same after the `x` goal is dropped with `mesh goal drop` while the moved step is open, and the
  item is filed for `r` again.
- The same in the backfill (`mesh items sink`, which applies rules 2a/2 grouped by target).

The result is a "new" step that carries the old step's notes and rounds and has `movedTo` either
silently dropped or still set (then the new step is itself invisible to every lookup). Blocker rule 2.

**Fix:** make rule 2 (and the backfill) use the same "id already held" rule as B1: a moved-away step
with the id is revived (`movedTo` cleared, fields rebuilt, deps by rule 5, note
`refiled by <from>`, event `step.reopened { reason: "refiled" }`), never overwritten. Add a criterion:
move `r` → `x` by the fold, finish the `x` step, raise D with `repo: r` and file it → `r.f-h` is the
revived step (its earlier notes kept, `movedTo` cleared), exactly one live non-closed step for D.

### B3 (NEW): "one live open step" does not hold with the rules as written

The spec says: "With the rules below, a `(lineage, fp)` has at most one live step that is not `done`,
`skipped` or `dropped` per topic." Two paths break it:
1. **Rule 3 in the target goal ignores a held step elsewhere.** Rule 2a only runs when the target goal
   has **no** live step. When it has a live `done` (or `dropped`) one, rule 3 reopens it, whatever
   other goals hold. Path: D's step `x.f-h` `done`; D retargeted to `r` and refiled → `r.f-h` (rule
   2); a person claims `r.f-h`; a record raises D with `repo: x` → fold: held, note; the filer refiles
   D → sink group `x`: `x.f-h` is live and `done`, filed after close → **reopened** (`ready`), while
   `r.f-h` is still `claimed`. Two live non-closed steps for one finding in one topic.
2. **Revert reopens dropped steps in several goals.** The sync table now applies to live steps in
   every clean-audit goal, and the code `syncRevert` reopens **every** `dropped` match. Path: D's
   step `r.f-h` dropped by a stage dismissal; D raised again with `repo: x` (fold: nothing open to
   move) and refiled → `x.f-h` (rule 2a ignores a `dropped` step); a debrief dismisses D → `x.f-h`
   dropped; revert of that debrief dismissal → both `r.f-h` (dropped by the older dismissal, still
   live) and `x.f-h` reopen. RL-9's row says "the debrief disposition that dropped the step", but the
   only rule RL-10 adds is "moved-away steps are never matched", and AC-06 tests only the moved-away
   case.

The fallback "the one updated last is used and the others are left as they are" also contradicts the
sync section ("applies to the live finding steps … in **every** clean-audit goal"): with two live
steps, is the sync applied to both, or to the one updated last? The reason given for the fallback
("data from before RL-10") cannot occur: before RL-10 a lineage's steps live only in its own repo's
goal, one id per goal. Blocker rule 2 (the decision does not do what it says), and AC-06's "a
duplicate" FAIL state does not cover these paths.

**Fix:** pick one rule and state it, for example:
- per topic, only the live step in the **target repo's** goal is ever **created or reopened** (rule 2,
  rule 3, revive, the revert row); a live step in any other goal is only closed, dropped or noted by
  the sync, and never reopened; and
- before rule 3 (or a revive) reopens a step in the target goal, rule 2a's check runs: another goal's
  open step → moved onto it (B1's rule); a held one → note, and the target step stays closed;
- the revert row reopens only the step in the clean-audit goal of the item's current target repo.

Then drop or rewrite the "updated last" sentence, and add criteria for both paths above (one live
non-closed step for D at the end of each).

## Suggestions

### S1 (NEW): state where the fold move runs in `submitReview`
The order is harmless (see "What holds"), but a builder must place it. Say: after every row of the
record is saved, before `syncFold`, so the move sees the new target and `syncFold` sees the moved
steps.

### S2 (NEW): a move whose topic was deleted
RL-9 refuses to sink into a deleted topic (`sink failed: topic … is not defined`). A move (fold or
retarget) creates `B` "by RL-9 rule 1" from `A`'s `sink.topic`, which `deleteTopic` leaves in place.
Nothing in the store refuses that (no foreign key), so the fold silently opens a goal tagged with a
topic that no longer exists. Say what happens: no move and the note `topic <t> is not defined` on
`S`, or the move anyway.

### S3 (NEW): the backfill with zero entries
RL-9 returns `goal` = the existing clean-audit goal when nothing is selected (`decideSink` returns
it), and the CLI prints `<CG>: added 0, reopened 0`. RL-10's `goal` is "the entry's goal when there is
exactly one entry, else `null`", so zero entries give `null` and `no goal: added 0, reopened 0`. No
RL-9 test covers it, but "items without `repo` behave exactly as in RL-9" does. Say zero entries keep
RL-9's result (the lineage repo's goal). The permission "the owner of any existing clean-audit goal
the call would add to" also changes RL-9: on a no-op call it adds to nothing, so the owner of the
lineage repo's clean-audit goal would get 403 where RL-9 gave 200. Say "of any target repo of the
selected items, or of the lineage repo".

### S4 (NEW): the revive's remaining fields and event
Say that a revive also clears `summary` (`moved to …`) and `outcome`, and which event it emits
(`step.reopened { reason: "moved", from }` fits RL-9's pattern). AC-06 asserts only notes and
`movedTo`.

### S5 (NEW): `--from-key-path` cannot name a `group/x` repo
The Problem's convention ("the repo in `key.path`") most often looks like `group/x`, and RL-9
compares repos as exact strings, so `group/x` and `x` are different goals. A path containing `/` is
always left out, so those auditors need one `--repo` call per target. Either allow `/` when the last
segment has no extension, or say in the guide that `--from-key-path` works only for bare repo names.

### S6 (NEW): the 422 text
The 422 is one entry of RL-2's message `the review record has <n> problem(s): …`; say AC-03 checks
that the message contains the text. Say the order of `<a>` and `<b>` (record order) and what three or
more repos give (the first two, or all).

### S7 (NEW): no criterion for rule 2a's "open → moved"
AC-05 covers the fold move, AC-07 the retarget, AC-06 the held note of rule 2a. Nothing covers a sink
that moves an open step (fold left a note because the step was held; the person releases; the filer
refiles → moved). Add it to AC-06.

### S8 (NEW): small wording
- AC-06's debrief: name its shape (RL-9 AC-07b: `mode: debrief`, deps `[audit]`, `consumes:
  [accepted]`, `may_set: [dismissed]`).
- The fold changes `row.repo` without any trace except the step move; consider `item.retargeted`
  with `by: <audit step id>` there too, so `docs/events.md` has one event for every target change.

## Checks

Run: none of the repo's checks. This round reviews a spec, and nothing is implemented. I read the
code and tests named above.

Not run: `pnpm lint`, `pnpm typecheck`, `pnpm boundaries`, `pnpm test`, `pnpm build`, `pnpm check`,
`pnpm schemas`, `pnpm test:web`. The Postgres legs of the store contract were not run
(`MESH_TEST_PG_URL` is unset).
