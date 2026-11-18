Verdict: CHANGES REQUESTED | Round: 1 | Blocking-open: 5

# Review of the RL-10 spec, round 1

This is a cold review of `docs/specs/RL-10.md` (commit e62ffad on `spec/RL-10`). I read RL-9 (shipped
in v0.1.27) and its reviews first, then checked RL-10 against the code it touches:
- `src/hub/service.ts`: the "clean-audit goals (RL-9)" section (`cleanAuditGoal`, `filedItems`,
  `filedAfterClose`, `decideSink`, `writeSink`, `runSink`, `sinkAfter`, `sinkGoalsOf`,
  `findingStepsOf`, `closeFinding`, `reopenFinding`, `syncDisposition`, `syncFold`, `syncRevert`,
  `sinkItems`); `submitReview` and its fold (~1110-1215); `applyDisposition`, `disposeStep`,
  `revertDisposition`, `isRevertable`; `goalTx`; `settle` via `closeFinding`;
- `src/core/review.ts` (`fingerprint`, `uniqueFps`, `foldItems`, `consumedNow`, `repoName`),
  `src/core/repo-id.ts` (`repoFromRemote`, `repoMatches`), `src/core/calibration.ts` (`flagEntries`);
- `src/protocol/review.ts` (`ReviewItem`, `ItemRow`, `ItemHistoryEntry`), `src/protocol/hub.ts`
  (`SyncRequest.machine.repos`, `SinkRequest`, `SinkResult`), `src/protocol/tools.ts` (`mesh_review`
  input), `src/protocol/hub-api.ts`, `src/hub/app.ts`;
- `src/store/hub-store.ts` (`review_item` and `item_history` as JSON; `item_history.step NOT NULL`);
- `src/daemon/tools.ts` (record normalisation), `src/daemon/repos.ts` (inventory);
- `src/cli/review-commands.ts` (`mesh items`, `mesh items sink`);
- `test/helpers/world.ts`, `sink-kit.ts`, `review-kit.ts`, and the RL-9 tests `test/sink-cli.test.ts`,
  `sink-hub.test.ts`, `sink-goals.test.ts`.

There is no CLAUDE.md in the repo. The hard rules I applied are the task's: keep mesh-harness generic
(the spec's names `r`, `x`, `y`, `nowhere` are generic) and stage and commit by name. No hard rule is
broken. `docs/specs/reviews/RL-10/` did not exist, so every finding is **NEW**.

## What holds

- The problem is real. `decideSink` creates each step with `repo: lineageRepo(row.lineage)` and
  `runSink` picks the goal by `lineageRepo(lineage)`, so a cross-repo auditor's findings all land in
  its own repo's goal. `ItemRow` has no repo field.
- The finding-step id is `f-` + hash of `<lineage>|<fp>` (`findingStepId`), so it does not depend on
  the repo, as the spec says. A moved step keeping its local id is valid syntax.
- No migration: `review_item.value` and `item_history.value` are JSON (`ItemRow.parse`,
  `ItemHistoryEntry.parse`), so `ItemRow.repo` needs no column. `SCHEMA_VERSION` can stay 11.
- No races: every path involved (sink inside `doneStep`/`settleSteps`, `submitReview` fold,
  `disposeStep`, `revertDisposition`, claims, `sinkItems`) runs in `goalTx`, which is `store.tx` plus
  the global `serialize()` lock. A retarget in `goalTx` is serialized against a claim of the step it
  moves; a session that read the old id gets a 409 on claim.
- Dropped deps are satisfied in `settle`, and `closeFinding` settles the goal and ends offers
  (`endOffersLeavingReady`), so "dependants in A are settled" and "offers withdrawn" are what the
  existing helper already does.
- The `ReviewItem` addition flows through: `src/daemon/tools.ts` spreads `...it` into the uploaded
  item, and the hub schema (`ReviewUpload.items`) extends `ReviewItem`.
- A consuming record can re-accept a filed item: `submitReview` checks `consumes.includes(row.state)`,
  not `consumedNow`, so AC-05's "a later run … files it" is buildable with the RL-9 `FILE` fixture
  (`consumes: [open, confirmed, accepted]`). See S1 for why this rarely happens in practice.

## Blockers

### B1 (NEW): RL-2 does not refuse two items with the same fingerprint; the second is silently dropped

The spec says: "Two items of one record with the same fingerprint are refused as today (RL-2),
whatever their `repo`." That is false. RL-2 (`docs/specs/RL-2.md:252`): "Duplicate fps in one record:
the first item counts, all are stored with their `fp`." The code agrees: `submitReview` builds
`first` (first item per fp wins), folds `[...first.values()]`, and writes the row from `first`. The
only "listed twice" refusal is for **dispositions** (`given.has(fp)`). RL-2 AC-19 even asserts that a
duplicated fp is counted once.

Consequences:
- An auditor that raises the same key for repo `x` and repo `y` gets one row, with `x`'s repo, and
  `y`'s finding is lost without a word. That is exactly the "silently loses a finding" case.
- AC-03's second half ("refused as RL-2 refuses a fp listed twice") cannot pass against today's
  behaviour. Making it pass changes RL-2 (and its tests), which contradicts AC-14 and is not in Scope.

This is a wrong decision built on a wrong fact (blocker rule 2), and AC-03 is not buildable as written.

**Fix:** pick one and state it:
- (a) refuse, in a raising record, two items with the same fp **and different `repo`** (422 with a
  named problem text, the whole record as other RL-2 problems), leaving RL-2's same-repo duplicates as
  they are; add it to Scope and to Checks; or
- (b) keep first-wins and say so, with a warning in the `mesh_review` reply (the daemon reply already
  reports counts) and a guide sentence.

Either way, rewrite AC-03's second half with the exact status and text, or the exact stored outcome.

### B2 (NEW): a step left behind by a move still looks like a live finding step, which yields duplicates

A move leaves `S` in `A` as `dropped`, with its `finding` and the same local id. RL-10 then widens the
lookup to every clean-audit goal and keeps RL-9's rules. Three paths produce two open steps for one
finding, or an id clash:
1. **Revert reopens the moved-away step.** `syncRevert` reopens **every** `dropped` match of
   `findingStepsOf` (`if (step.state === "dropped") reopenFinding`). With the lookup over all goals, a
   revert of a debrief dismissal reopens both the step the dismissal dropped and the old `S` dropped
   by the move. The spec's sentence ("a `done` step left behind … is in a state the table does nothing
   for") does not consider the `dropped` one. RL-9's table row ("revert … of the debrief disposition
   that dropped the step") is not what the code checks.
2. **Move back by sink.** D moves `r` → `x` (`r` keeps `dropped` `A.f-h`). A later run raises D with
   `repo: r` and files it. `r`'s goal **has** a finding step for `(lineage, fp)` (the dropped one), so
   rule 2a does not run; rule 3 sees `dropped` with a newer `accepted` (`filedAfterClose`) and
   **reopens** it. `x`'s step stays open. The same happens after rule 2a's "done → new step in target"
   case if the item flips back.
3. **Move back by retarget.** Retarget step 3 moves `x`'s step into `r`'s goal "a step with the same
   local id", but `A.f-h` already exists there (`dropped`). `saveSteps` upserts by id, so the "new"
   step overwrites the old one and inherits its notes and rounds (keyed by step id), contradicting
   "Notes, rounds and history of `S` stay on `S`".

Also undefined: rule 2a when **more than one** other goal of the topic has a step for `(lineage, fp)`
(for example a `done` one left in `y` and a `ready` one in `r`). "has one" is singular.

This is a wrong decision (blocker rule 2): the move rule, together with the widened lookup, does not
keep one open step per finding.

**Fix:** mark the left-behind step so no lookup treats it as live (for example `Step.movedTo: <id>`,
or clear `finding` on it and keep the origin in the summary), and exclude it in `findingStepsOf` and
in rules 2a/3. Define the move into a goal that already holds a closed step with the same id (reuse
that step: reopen it with the moved step's fields, keeping its history; or refuse with a note). Define
rule 2a's choice when several goals match (an open step first; held → note; otherwise rule 2). Add
ACs: revert after a move reopens one step only; a move `r` → `x` → `r` (by sink and by retarget)
ends with exactly one open step.

### B3 (NEW): the `retarget` item-history entry does not fit `ItemHistoryEntry`, and it blocks revert

The spec adds `{ kind: "retarget", from, to, by }` with `from`/`to` = repos. Today:
- `HistoryBase` requires `at`, `goal`, `step`, `round`, and `from: ItemState | null`,
  `to: ItemState`. A repo in `from`/`to` does not parse, and a retarget from the CLI has no goal,
  step or round. `item_history.step` is `NOT NULL` (`hub-store.ts:87`, `:166`).
- `isRevertable` needs the **last** history entry of the item to be the debrief disposition. A
  retarget after a debrief decision makes that decision silently non-revertable from the UI.

AC-07 asserts "item history entry `retarget`", so the test-writer must guess its shape.
This is a wrong decision as written (blocker rule 2).

**Fix:** give the entry its own fields, for example `{ kind: "retarget", at, goal: "", step:
"mesh items retarget", round: 0, from: <state>, to: <state>, repoFrom, repoTo, by }`, or put the
repos under other names and say what `goal`/`step`/`round` hold. Say whether `isRevertable` skips
`retarget` entries (I suggest it does), and pin the entry in AC-07.

### B4 (NEW): "no machine has repo" names the wrong source and no comparison, so AC-12 is not decidable

- The inventory is MM-1 (`SyncRequest.machine.repos`, `src/daemon/repos.ts`), not "RL-5 `repos`".
  RL-5 added `agents`.
- Inventory entries are `{ id, name }`, with `id` a lower-case `host/path` from the remote
  (`repoFromRemote`), for example `git.example.com/rl9/r`. Step and lineage repos are whatever the
  plan wrote (`r`, `group/r`). The spec says "has the target repo" without a rule. RL-9 compares repos
  as exact strings. With exact match, `x` never equals any inventory id, so the note is on every step,
  including every RL-9-shaped step (`r` vs `git.example.com/rl9/r` in `Sk.start`), and AC-12's
  "with `repo: x` … no such note" can never hold. With `repoMatches` (id, path suffix or name), it can.
- "machine inventory as the World helpers set it" does not tell a blind test-writer to give some
  machine a remote-backed checkout of `x` (as `Sk.start` does for `r`).

This is an undefined decision on which AC-12 depends (blocker rules 2 and 3).

**Fix:** name MM-1, name the comparison (I suggest `repoMatches(inventoryRepo, target)`, the rule
`suggest` already uses), and pin AC-12's fixture: a daemon with a checkout whose `origin` is
`https://git.example.com/<any>/x.git`, inventory flushed (`w.flush()`), then the filing.

### B5 (NEW): the new backfill output contradicts "RL-9 tests pass unchanged"

RL-10 changes `mesh items sink` output to one line per `goals` entry, with dry-run lines
`would add <n> to <G or a new goal> (<repo name>)`. `test/sink-cli.test.ts` asserts exactly
`"would add 2 to a new goal"` (line 285) and `` `would add 0 to ${CG}` `` (line 299). AC-14 requires
those tests to pass unchanged. Both criteria cannot pass at once.

The same section leaves "one entry per target repo **touched**" undefined. On a second call that
adds nothing, is a repo touched? If touched means "added or reopened", `goals` is empty, no line is
printed, and AC-10's "`added 0` on both lines" fails. RL-9's line 297 (`<CG>: added 0, reopened 0`)
shows that today a zero line is printed.

This is a contradiction between two criteria (blocker rule 2).

**Fix:** either keep RL-9's exact text when there is one entry (and add ` (<repo name>)` only when
there are several), or list the RL-9 assertions that change and drop "unchanged" from AC-14 for
them. Define an entry as "a target repo with at least one filed item considered (after
`min_severity`)", so a no-op call still prints one line per repo.

## Suggestions

### S1 (NEW): a target set by the fold on a filed item never moves its step
An auditor that starts sending `repo` raises its existing filed items again as `repeat`. The fold sets
`row.repo`, but the item stays `accepted` with its link. `consumedNow` excludes it, so the stock filer
(and its `when`) never files it again. Rule 2a then never runs, and the open step stays in the old
goal with nothing on it. `mesh items` shows `→ x`, while the step is in `r`. This is the main upgrade
path of the Problem section. Either move (or note) open finding steps when the fold changes an item's
target, or state plainly in the guide and concepts that a retarget (`--all --from-key-path`, or one
`--repo` per item) is needed after an auditor starts sending `repo`, and make the fold add a note
`target is now <repo>; run: mesh items retarget …` on the open step.

### S2 (NEW): a move silently lifts an ordering constraint in `A`
"its dependants in `A` are settled" turns a step that "cannot land before" `S`'s fix into `ready`,
although the fix has not landed. That may be the right trade (deps cannot cross goals), but add a note
on each such dependant (`dep <S> moved to <new id>`), and assert it in AC-05.

### S3 (NEW): which `requires` does a retarget move use?
The move takes "the item's resolved requires in `B` (rule 5)". In a sink, rule 5's requires are the
union over the sink stage's goal. A retarget has no sink stage. Say which dispositions count (for
example the union over all of the item's `accepted` dispositions, or none, as the backfill).

### S4 (NEW): `--from-key-path` on file paths
For most auditors `key.path` is a file path (the Problem says so). `--all --from-key-path` on such a
lineage retargets every item to repos like `src/a.ts` and opens goals `Clean audits: ci on a.ts`, with
no check. Consider refusing a path that contains a `.` in its last segment, or that matches no repo of
any inventory, or at least say in the guide to run `--dry-run` first. AC-08 could cover one refused
path.

### S5 (NEW): Compatibility must name the daemon too
The `mesh_review` tool input is `ReviewRecord.shape` from the daemon's own protocol
(`src/protocol/tools.ts:70`). A v0.1.27 daemon's strict `ReviewItem` refuses `repo` before the hub
sees it. So the order is hub, then daemons, then auditors. Say so.

### S6 (NEW): AC-03's unit half cannot fail
`fingerprint(key)` takes the key only, so "the same key with `repo: x` and with no repo → the same
fp" holds by the signature. Keep the World half (the later run marks it `repeat`), which can fail, and
drop or reword the unit half (for example a unit on the hub's item-to-fp mapping, if one is
extracted).

### S7 (NEW): name the surfaces of single assertions
- AC-02's "a raising record with `repo` of 301 characters → 400": say `POST /v1/steps/:id/review`
  (the `mesh_review` tool returns an error text, not a status).
- AC-05's dependant: say how it is made (run 1 files E without repo with `requires: [fpD]`, so E is
  `blocked` on D in `r`).
- AC-09: name one CLI usage error that exits 2 (for example `retarget` with no fp and no `--all`),
  and say whether `fps: []` is "neither" (the text) or the schema's 400.
- AC-02's `→ x`: give the exact row format (where the arrow sits relative to the path column).

### S8 (NEW): retarget permission reaches into other owners' goals
The owner of the lineage's newest goal may move steps into the clean-audit goal of `(x, ci)`, which
another person may own. That is consistent with the sink (which already adds there), but say it, and
say which `user` the `step.dropped`/`goal.sunk` events of a retarget carry.

## Checks

Run: none of the repo's checks. This round reviews a spec, and nothing is implemented. I read the
code and tests named above.

Not run: `pnpm lint`, `pnpm typecheck`, `pnpm boundaries`, `pnpm test`, `pnpm build`, `pnpm check`,
`pnpm schemas`, `pnpm test:web`. The Postgres legs of the store contract were not run
(`MESH_TEST_PG_URL` is unset).
