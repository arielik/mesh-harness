Verdict: APPROVED | Round: 1 | Blocking-open: 0

# Review of the RL-9 diff, round 1

This is a cold review of `git diff main...impl/RL-9` (head 253b0fc) against `docs/specs/RL-9.md`. I read
the spec rounds first, oldest first (`r1-changes-requested.md`, `r2-changes-requested.md`,
`r3-approved.md`). This is the first diff round, so every finding is **NEW**. None is a REPEAT or a
REGRESSION-OF-OWN-REPAIR.

There is no CLAUDE.md. The hard rules I applied are the task's: keep mesh-harness generic, the
developer changes no test, the test-writer changes no product code, no assertion on source text.
No hard rule is broken.

## Process checks

| Check | Result |
|---|---|
| Every criterion has a test that failed first | **Holds.** I added a throwaway worktree at `test/RL-9` (4705820: the tests on the base product code) and ran the six RL-9 test files there: 62 of the 63 RL-9 tests failed (`finding-step.test.ts`, `docs-rl9.test.ts`, `sink-hub`, `sink-goals`, `sink-cli` and the RL-9 block of `schemas.test.ts`), and so did the re-pinned `test_AC16_version`. The one that passed, `test_AC19_schema_version`, guards an invariant (`SCHEMA_VERSION` stays 11) and cannot fail first by design. On `impl/RL-9` all 127 tests in those files pass. AC-01 … AC-19 each have at least one test. |
| No assertion on source text | **Holds.** The only file reads are of docs (`docs-rl9.test.ts`, the docs part of `schemas.test.ts`) and `package.json`; AC-18 makes the docs the deliverable. `finding-step.test.ts` imports the module; no test reads `src/`. |
| The developer changed no test | **Holds.** `git diff test/RL-9 impl/RL-9 -- test '*.test.ts'` is empty. The one developer commit that touches a test, 154cc15, is the version pin in `test/schemas.test.ts` (`0.1.26` → `0.1.27`), which the plan allowed; the merge 27b404a kept the test-writer's text. |
| The test-writer changed no product code | **Holds.** The test commits (d693980, dff365b, 334dd99, d656bdd, 4705820) touch only `*.test.ts`, `test/helpers/*` and the test plan. `test/helpers/review-kit.ts` only exports its existing `base32`. |
| Generic | **Holds.** No team, company or person name in the added code, docs or tests (users are `ann`, `bob`, `carol`, `root`; repos `r`, `group/r`, `demo`). |

## What holds

- **Sink failure never fails the caller.** `runSink` checks the topic (`all`, syntax, defined) before
  any write. On failure it writes only the note `sink failed: <reason>` and `goal.sink_failed { from, reason }`;
  the stage's done commits. `decideSink` decides rules 1–5 in memory and `writeSink` writes after, so
  no rule fails half-way. AC-10 proves nothing is written (snapshot, no step, no `goal.sunk`).
- **Transactions.** Every path that sinks or syncs runs inside `goalTx` (`doneStep`, `decideGate`,
  `resumeStep`, `approvePlan`/`applyApproved`, pulse fire and ingest, `submitReview`,
  `disposeStep`, `revertDisposition`, `dropGoalByPerson`, `sinkItems`). `goalTx` takes the global
  `events` lock (`serialize()`), so two relays that open the same clean-audit goal at once cannot
  both create it.
- **Trigger.** `sinkAfter` runs after every `settleSteps`, with the post-settle step array:
  `doneStep` (the stage itself plus newly skipped steps), `decideGate`, `resumeStep` and
  `applyApproved` (newly skipped steps). A clean-audit goal never sinks into itself.
- **Sync paths.** The fold (`syncFold`, only on `f.resolved`, which a partial record leaves empty,
  plus `raised again` on done steps for `repeat`/`regression`); `applyDisposition` (`syncDisposition`;
  reached by consuming records and by `disposeStep`, which passes `requires` through);
  `revertDisposition` (`syncRevert`: a reverted dismissal or deferral that leaves the item filed
  reopens a `dropped` step with its deps; a reverted `accepted` that leaves it unfiled drops a
  ready/blocked step or notes a held one). Events carry `by` as the spec says (person decider, else
  the clean-audit goal's owner). Closed and dropped steps settle their dependants.
- **Rules 1–5.** Ids `f-<base32(sha256(lineage|fp))[0..16]>`; title cut at 200 with `…`; brief cut at
  8000 keeping the last line; reopen clears holder, outcome, summary and `roundStartedAt`, keeps
  rounds, adds a fix cycle and does not reopen dependants; deps resolve own lineage first, then the
  only step with that fp, else a note (`not in this goal`, `ambiguous`, `cycle`); a hash clash never
  overwrites another finding's step.
- **Standing goal.** `goalComplete(goal, …)` is false for a goal with `sink` on every caller;
  `proposePlan` answers 409 before validation.
- **Ready order.** `refillBySeverity` runs on each part (offered-here, rest) separately and within
  each goal; non-finding steps keep their positions.
- **Goal drop.** 404, then 403 (`canApprove`: owner, approver, admin), then 409 for `done`/`dropped`
  and for claimed or paused steps; reuses the pulse `dropGoal`, so ready, blocked and parked steps
  drop and offers are withdrawn; `goal.dropped { reason: "person", by, comment? }`. Pulse and
  calibration goals are covered by AC-14 tests.
- **Backfill auth.** Admin, the owner of the lineage's newest goal (from the lineage's records; ties
  by goal number since c89f4c2), or the owner of the existing clean-audit goal; no deps; dry run
  writes nothing and returns `goal: null` for a new goal.
- **Docs.** Concepts, the scheduled-reviews section (after "Debrief", linked from the contents),
  the skill (and `MESH_SKILL` equal to the file), `events.md` (`goal.created` sink, `goal.dropped`
  person, `goal.sunk`, `goal.sink_failed`, `step.done`, `step.reopened`, `step.dropped`), the API
  table and `operations.md` "Upgrading to 0.1.27" (the one anchor to it is updated) match the code.

## Blockers

None.

## Impl findings (suggestions)

### I1 (NEW): the `mesh show` header prints the repo name, the spec says the repo
`src/cli/show.ts` prints `clean audits: <topic> on ${repoName(g.sink.repo)}`. The spec
("`mesh show`") and `docs/guide/concepts.md` give `<repo>`. Repos compare as exact strings, so the
goals of `group/r` and `r` (AC-03) both show `ci on r`, and their titles are already the same. Print
`g.sink.repo` in the header (it is the one place that tells the two apart), or change the spec and
the concepts line to `<repo name>`.

### I2 (NEW): a repeated backfill or sink reopens steps a person finished
`mesh items sink` (and a sink stage that runs again: a second round of `file`, or a resumed failed
`file`) applies rule 3 to every item still filed. A finding step a person finished with `mesh_done`
keeps its item `accepted` with a `link` until the next audit, so the next backfill reopens it as
`refiled` although nothing was filed again (`test_AC15_apply_and_idempotent` pins this). This
follows the spec's "rules 1–4" literally, so it is not a defect of the diff. Ask the owner whether
rule 3 should apply only to items whose latest `accepted` is newer than the step's last close, and
leave it as is until then.

### I3 (NEW): a reopened or updated finding step keeps its old brief
Rule 3 (reopen) and rule 4 (ready or blocked) update the title and severity only. A refile with a
new tracking link (`test_AC06_rule4_ready_and_held` uses `<link>-2`) leaves the old link and old
evidence in the brief that `mesh_context` shows. In `decideSink`, rebuild `brief` with
`findingBrief(...)` when a step is reopened or updated (the spec does not forbid it).

### I4 (NEW): `goal.sunk` names a step of another goal
`writeSink` emits `goal.sunk` with `goal` = the clean-audit goal and `step` = the relay's sink stage.
Event readers that scope by `step` (`eventsFor({ step })` for step facts) or assume a step belongs to
the event's goal will see a cross-goal pair. It is documented in `events.md`, so it is a design
choice; consider dropping the top-level `step` and keeping only `payload.from`.

### I5 (NEW): the sync scans every goal per item
`findingStepsOf` calls `store.listGoals()` once per resolved fp and per dismissal or deferral, inside
the transaction that holds the global `events` lock. The spec accepts scans, but a complete record
that resolves many items reads the goal list many times. Read the clean-audit goals of the lineage's
repo once per fold or record and pass them down.

### I6 (NEW): the guide does not say the sink needs a 0.1.27 hub
`docs/guide/scheduled-reviews.md` still lists "mesh 0.1.22 on the hub" as the prerequisite. The new
"Clean-audit goals" section should say that `sink` needs a 0.1.27 hub (an older hub refuses the
preset with 422), as `operations.md` does.

## Test findings (suggestions)

### T1 (NEW): the gate, resume and approve triggers are untested
The spec's trigger lists `doneStep` and `settleSteps` after a gate decision, a resume and a plan
approval. The tests cover the stage's own done (AC-01) and a skip after a debrief's done (AC-09)
only. Add one World test in which the sink stage is skipped by a settle after a gate approval (for
example `audit` → `debrief` → `gate` → `file` with `when: {open: true}`, the debrief files F, the
gate is approved, then `file` is `skipped` and F has a finding step), and one after
`POST /v1/steps/:id/resume` of a parked step upstream of the sink stage.

### T2 (NEW): the AC-18 concepts check is loose
`test_AC18_concepts` passes when any paragraph anywhere in `concepts.md` contains the word
`requires`, or `S1` + `severity` + `order`. Scope the four checks to the text between
`## Clean-audit goals` and the next `## ` heading, so an unrelated paragraph cannot satisfy them.

### T3 (NEW): no test for `mesh items sink` usage errors
Nothing checks that `mesh items sink <lineage>` without `--topic`, or with
`--min-severity S9`, prints the usage or the error on stderr and exits 2 without calling the hub.

### T4 (NEW, note only): `test_AC19_schema_version` cannot fail first
It guards an invariant and passed on the base. That is expected; no change needed.

## Checks

- On `test/RL-9` (a throwaway worktree, removed after): `vitest run` of the six RL-9 test files →
  63 failed, 64 passed (62 RL-9 tests plus the re-pinned `test_AC16_version` failed; the passes are
  `test_AC19_schema_version` and pre-existing tests in `schemas.test.ts`).
- On `impl/RL-9`: the same files → 127 passed.
- `git diff test/RL-9 impl/RL-9 -- test '*.test.ts'` → empty; `git show --stat` per commit for
  the developer/test-writer split.
- Not rerun by me: `pnpm check` (reported green: 2609 passed, 102 skipped), `pnpm schemas`
  (reported no diff; `test_AC18_openapi` passes), the Postgres store suite (reported passed against
  Postgres 17).
