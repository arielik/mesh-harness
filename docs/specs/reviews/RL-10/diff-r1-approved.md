Verdict: APPROVED | Round: 1 | Blocking-open: 0

# Review of the RL-10 diff, round 1

Cold review of `git diff main...impl/RL-10` (head 94c7b2b) against `docs/specs/RL-10.md`, which
builds on `docs/specs/RL-9.md`. I read the spec review rounds r1, r2 and r3 first, oldest first.
This is the first diff round, so every finding is **NEW**.

Read: `src/hub/service.ts` (the 422 check and the fold in `submitReview`; the new placing section:
`newWork`, `loadTopic`, `workGoal`, `findings`, `placeHome`, `filedAfterEveryClose`, `moveStep`,
`retargetSteps`, `finishWork`, `renderDry`, `writeWork`; `runSink`, `cleanAuditGoals`,
`findingStepsOf`, `foldMove`, `syncFold`, `syncRevert`, `sinkItems`, `retargetItems`, `describe`),
`src/core/finding-step.ts`, `src/protocol/{review,goal,hub,hub-api,skill,tools}.ts`, `src/hub/app.ts`,
`src/cli/review-commands.ts`, `src/daemon/tools.ts` (the record keeps `repo` through `...it`), the
docs (concepts, scheduled-reviews guide, events, API table, operations 0.1.28, skill), and the tests
`test/retarget-hub.test.ts`, `test/retarget-cli.test.ts`, `test/docs-rl10.test.ts`, the RL-10 part of
`test/schemas.test.ts` and the additions to `test/helpers/sink-kit.ts`.

No CLAUDE.md. The hard rules applied are the task's: mesh-harness stays generic (no team-, company-
or person-specific name in the diff; the names used are `r`, `x`, `y`, `demo`, `api`, `web`), and
staging and committing by name.

## Process checks

| Check | Result |
|---|---|
| Every criterion has a test that failed first | **Yes.** On a temporary worktree of `test/RL-10` (12c5fc0, no product code) the RL-10 tests ran: 49 failed, among them every test of `retarget-hub`, `retarget-cli` and `docs-rl10`, and `test_AC12_route_table`, `test_AC12_openapi`, `test_AC13_version`, `test_AC16_version`, `test_AC19_version`. AC-01..AC-13 (with AC-06b..AC-06e) each have at least one. The only RL-10 test that passed there is `test_AC13_schema_version` (an invariant: "`SCHEMA_VERSION` still 11"; see T1). |
| No assertion on source text | **Yes.** The tests read docs and generated files only (`docs/…`, `skills/mesh/SKILL.md`, `schemas/hub-api.openapi.json`, `package.json`); none reads `src/`. |
| The developer changed no test | **Yes.** `git log impl/RL-10 --no-merges -- test '*.test.ts'` lists only the five `test(RL-10)` commits of `test/RL-10`, and `git diff test/RL-10 impl/RL-10 -- test` is empty. The two version pins in `test/schemas.test.ts` (RL-6 `test_AC16_version`, RL-9 `test_AC19_version`, 0.1.27 → 0.1.28) were changed by the test-writer in c11d509, as AC-13 implies. |
| The test-writer changed no product code | **Yes.** `git log test/RL-10 --no-merges -- src` is empty for the RL-10 commits. |
| RL-9 test files byte-identical to main | **Yes.** `test/sink-hub.test.ts`, `sink-cli.test.ts`, `sink-goals.test.ts` have no diff. `test/helpers/sink-kit.ts` only gains lines (RL-10 helpers; no line removed or changed). |
| Run here | The RL-10 and RL-9 sink files with `schemas.test.ts` on impl/RL-10: 7 files, 172 tests passed. I relied on the stated `pnpm check` (2662 passed), Postgres store suite (176) and `pnpm schemas` (no diff) for the rest. |

## What holds

- **One placing routine.** `placeHome` is the only path of sink, backfill and revert that opens a
  finding step, and `moveStep` the only path of a move. Order is the spec's: foreign step first
  (held → `filed for repo …` note once per call and stop; open → moved, and the move opens the
  home step), then the home step by id: none → created (`repo` the target), moved-away → revived
  (`movedTo`, `summary`, `outcome`, holder fields, `roundStartedAt` cleared; `repo`, title,
  severity, brief rebuilt; notes, rounds and `fixCycles` kept; reason `refiled`), live closed →
  reopened (`refiled`, deps added as RL-9), live open or held → RL-9 rule 4. A hash clash never
  overwrites.
- **Filed after every close.** `filedAfterEveryClose` runs RL-9's `filedAfterClose` on every closed
  finding step of `(lineage, fp)` in the topic's live goals (moved-away steps included, since they
  are `dropped`), and it gates create, revive and reopen. A move is not gated. With one step per fp
  this is RL-9 rule 3 unchanged.
- **Moved-away steps are out of every lookup:** `findingStepsOf` (item → step sync), the foreign
  filter, `retargetSteps`, rule 5 in `finishWork` (`own` and the candidates), the retarget
  permission, the dependants note, and `sinkCounts` (`mesh show`). `test_AC11_moved_away_not_matched`
  and `test_AC05_show_counts_live` cover the last two.
- **Moves.** Fields match the contract: create in a move carries `S.fixCycles`; a live closed home
  step is reopened with `fixCycles + 1` and reason `moved`; a revive keeps `fixCycles` and gets
  `moved back from …`; `S` becomes `dropped` with `movedTo` and `moved to <id>`, offers are ended by
  `endOffersLeavingReady`, `step.dropped {reason: moved, to, by}`; dependants in `A` get the note and
  are settled; the home step's deps are the item's requires (all `accepted` dispositions) resolved in
  `B`; a deleted topic skips the move with the note. `goal.sunk` per goal that got steps, with the
  right `from`.
- **Fold move order** in `submitReview`: item rows saved (raised, then resolved), then `foldMove`
  (`item.retargeted` per item, then retarget step 3), then `syncFold`. The 422 check runs with the
  other record problems, before anything is stored, with the repos distinct in record order and an
  absent repo equal to the lineage repo.
- **Decide, then write; no placeholder leaks.** Goals still to be opened get a private-use
  placeholder id; `writeWork` opens them (by repo, then topic) and renders every stored id and text
  through the real ids: step `id`, `goal`, `deps`, `movedTo`, `summary`, notes, and every event
  payload. A placeholder goal that ends with nothing added or reopened is never opened, and no text
  names it (texts that name a home id only arise when that step exists). The dry runs render the
  same work as `<new>` (sink, as RL-9) or `new:<repo>/<local>` (retarget).
- **Revert.** `syncRevert` keeps RL-9's guard (dismissal or deferral reverted to a filed item) and
  goes through `placeHome` with kind `revert`: a held foreign step stops it with the note, and only a
  live `dropped` home step reopens (reason `reverted`, `reverted by <debrief>`, deps unchanged).
  With no home step, or a moved-away one, nothing reopens, and no goal is opened. A dropped step in
  another goal stays dropped (`test_AC06e_revert_and_backfill` guards r3 S2).
- **Retarget.** Shape errors are 400 before the transaction; 404s, then 403, then the work. The
  dry run reads only (topic, dispositions, evidence) and returns the same decided work. Rows are
  saved and `item.retargeted` emitted only on a real call; no item history entry. Step 3 also runs
  for an unchanged target, so a second call after a release moves the held step.
- **Sink never fails the caller.** `runSink` keeps RL-9's topic check up front; the new code paths
  (move, revive, goal creation) have no refusal: a deleted topic or a hash clash becomes a note.
- **Backfill output.** With zero or one `goals` entry the CLI prints RL-9's exact line from
  `goal`/`added`/`reopened`; with two or more, one line per entry with ` (<repo name>)`. The RL-9
  CLI tests pass unchanged. The permission adds owners of the topic's goals of the target repos.
- **Generic.** No team-, company- or person-specific name in code, docs or tests.
- **Docs.** Concepts (target repo, moves, retarget, backfill), the guide section "Auditors that
  check other repos" (repo in the key, fold moves, retarget dry run first; its sample output matches
  `renderDry`), the skill and tool text, `docs/events.md` (`item.retargeted`, `step.dropped` and
  `step.reopened` reason `moved`, `goal.sunk` `from`), the API table row, and operations
  "Upgrading to 0.1.28" with the order hub → auditor daemons → auditors add `repo`.

## impl_findings

No blockers.

### S1 (NEW, suggestion): cross-goal lookups grow with the hub inside record transactions
RL-9 looked in the lineage repo's clean-audit goal(s), usually one. The diff now looks in every live
clean-audit goal, inside the record's or the stage's transaction:
- `syncFold` → `findingStepsOf` does one `getStep` per (resolved fp × clean-audit goal of any
  repo and topic). An audit that resolves 300 items on a hub with 100 clean-audit goals does 30 000
  point reads in one transaction (Postgres: one round trip each).
- `syncRevert` and the dispositions path (`cleanAuditGoals` + `findingStepsOf` per disposition) do
  the same per fp.
- `runSink` → `loadTopic` lists every goal and the steps of every clean-audit goal of the topic.
- `foldMove` and `retargetItems` → `loadAllTopics` load the steps of every clean-audit goal.

The spec asks for "every clean-audit goal", so this is correct, but its cost now scales with the
hub, not the lineage. Consider building one `(lineage, fp) → steps` index per call (one
`listSteps` per clean-audit goal, filtered on `finding.lineage`), or a store query by
`finding.lineage`, and reusing it across `syncFold`, the dispositions and the revert.

### S2 (NEW, suggestion): API table row of `POST /v1/items/sink` keeps RL-9's permission
`docs/plan/implementation-plan.md` still says "an admin, the owner of the lineage's newest goal or
of the clean-audit goal". RL-10 also admits the owner of a clean-audit goal of the topic for a
target repo of the lineage's filed items (concepts says so). Small nit in the same vein: concepts
says retarget is allowed to "the owner of a clean-audit goal that holds a finding step of the
lineage"; the code (and spec) means a live one (moved-away steps do not count).

### S3 (NEW, suggestion): the revert reopens the home step of every topic the item has a step in
The spec's row says "the home step of the topic of the goal whose step that disposition dropped".
`syncRevert` collects every topic in which the item has any finding step (moved-away included) and
runs `placeHome` for each. Since the dismissal's sync drops the item's steps in every goal, the two
readings agree whenever the reverted disposition is what dropped the steps; they differ only for an
item whose home step in a second topic was dropped by something else earlier. Either restrict to the
topics of the goals whose step the disposition dropped (`step.dropped` with `from` = that debrief),
or record the reading in the spec.

### S4 (NEW, nit): `render` also rewrites user text
The placeholder pattern `\d+` is replaced in every note text. A target repo is caller
text (1–300 characters, no character class), so a repo string containing that pattern would have it
rewritten to a goal id in the `filed for repo …` / `retarget to …` notes. Harmless, but refusing
control and private-use characters in `ReviewItem.repo` and `RetargetRequest.repo` (or rendering ids
before composing texts) closes it.

## test_findings

No blockers.

### T1 (NEW, observation): `test_AC13_schema_version` cannot fail first
It passed on `test/RL-10`. It guards an invariant ("`SCHEMA_VERSION` still 11"), so it can only
fail on a regression; the rest of AC-13 (version 0.1.28) failed first. No change needed.

### T2 (NEW, observation): most World tests failed first at setup
On `test/RL-10` most RL-10 tests failed at their first `mesh_review` with `repo` (schema 400) or at
the missing route (404), before the assertion they guard. That meets "failed first" formally. The
tests carry controls (`control: …` assertions, snapshots before and after, `allFor`/`liveOpen`
counts) and their FAIL states match the spec's (e.g. `test_AC06e_revert_and_backfill` fails on
RL-9's "reopen every dropped match"; `test_AC06b_*` on an overwrite; `test_AC07_*` on a dry run that
writes), so I accept them as written.

## Checks

Run: the RL-10 tests on a temporary worktree of `test/RL-10` (49 failed, as listed above);
`vitest run` of `retarget-hub`, `retarget-cli`, `docs-rl10`, `schemas`, `sink-hub`, `sink-cli`,
`sink-goals` on impl/RL-10 (172 passed); the git checks in the table.

Not run here (stated green by the caller): `pnpm check`, the Postgres store suite, `pnpm schemas`.
