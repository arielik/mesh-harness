Verdict: CHANGES REQUESTED | Round: 1 | Blocking-open: 4

# Review of the RL-9 spec, round 1

This is a cold review of `docs/specs/RL-9.md` (commit d4a1c62 on `spec/RL-9`). I checked it against
the code it touches and against RL-1..RL-8:
- `src/hub/service.ts`: `submitReview`, the fold and `resolved` handling, `applyDisposition`,
  `disposeStep`, `revertDisposition`, `settleSteps`, `goalComplete`, `proposePlan`, `approvePlan`,
  `applyApproved`, `replan`, `doneStep`, `decideGate`, `resumeStep`, `listSteps`, `createWithPlan`,
  `calibrationTrigger`, `markGoalDone`, `dropGoal`, `deleteTopic`, `knownTopics`, `presetChecks` and
  `updatePulse`;
- `src/core/dag.ts` (`validatePlan`, `MAX_STEPS`, `settle`, `materialize`, `reopen`), `src/core/review.ts`
  (`fingerprint`, `lineageOf`, `foldItems`, `consumedNow`), `src/core/policy.ts` (`policyOf`,
  `DEBRIEF_CONSUMES`) and `src/core/presets.ts` (`audit-relay`, `instantiate`);
- `src/protocol/goal.ts`, `review.ts` and `hub.ts` (`DisposeRequest`), and `src/store/hub-store.ts`
  (the tables);
- `src/hub/app.ts` (the routes), `src/protocol/hub-api.ts`, and `src/cli/hub-commands.ts` (`goal`,
  `next`, `show`), `pulse-commands.ts` and `review-commands.ts`;
- `docs/guide/concepts.md`, `docs/guide/scheduled-reviews.md` and `docs/events.md`.

There is no CLAUDE.md in the repo. The hard rules I applied are the task's: keep mesh-harness
generic, and stage and commit by name. The example names in the spec (`vpc-node-agent`,
`dataplane-ci`, …) already appear in earlier docs and snapshots, so I do not raise them.
`docs/specs/reviews/RL-9/` did not exist, so every finding is **NEW**. None is a REPEAT or a
REGRESSION-OF-OWN-REPAIR.

## What holds

- The problem is real. A filed item is `accepted` with a `link`. `consumedNow` never consumes it
  again (RL-6), and nothing in the hub turns it into work. The only view of it is
  `mesh items <lineage>` (`review-commands.ts:99`).
- `f-<fp>` is a valid local id. Fingerprints are `[a-z2-7]{16}` (`RecordDisposition`,
  `fingerprint()`), and `localId` is `^[a-z0-9][a-z0-9-]{0,39}$`, so `f-` plus 16 characters is 18.
  (B1 is about uniqueness, not syntax.)
- `mesh show <goal>` and `mesh next` exist. `mesh items` exists; `sink` would be a new subcommand.
- A step can be `skipped` (`StepState`, RL-2 `when`). `parked` and `paused` are held or person
  states as the table assumes. A dropped or skipped dep counts as satisfied (`dag.ts` `SATISFIED`),
  so "a step closed or dropped this way unblocks its dependants" is true of today's `settle`.
- One transaction: `doneStep`, `submitReview`, `disposeStep` and `approvePlan` all run in `goalTx`.
  `goalTx` is `store.tx` plus `store.serialize()` on both stores. A goal created inside it (as
  `calibrationTrigger` does inside the dismissal's transaction) commits or rolls back with the step.
  "Postgres … or the hub lock (SQLite)" is the same mechanism on both.
- An older hub refuses `sink` in a preset with 422, as Compatibility says: `PresetStep` is `.strict()`
  and `presetChecks` turns the parse error into 422.
- The `regression` and `repeat` rows match `foldItems`. A `resolved` item raised again becomes `open`
  (`regression`). A filed item raised again stays `accepted` with its link (`repeat`) and is never
  re-consumed, so it is not sunk again.

## Blockers

### B1 (NEW): `f-<fp>` and `requires: [fp]` are not unique in a goal that holds several lineages

The goal key is `(repo, topic)`. A step's key is `(lineage, fp)`, with lineage
`<preset>|<repo>|<agent>`. The fingerprint, however, is `sha256(rule, path, symbol)`
(`core/review.ts:51`) and does not contain the lineage. Two cases put the same fp under two lineages
in the same goal:
- the same agent run by two presets (for example a repo moving from `routine-audit` to
  `routine-ci`, or one agent in two pulses);
- two agents with the same rule slug on the same path and symbol (AC-2's case: "two pulses of
  different agents with the same topic").

Rule 5 then sees no finding step for `(lineage₂, fp)` and appends a new step whose id `f-<fp>`
already exists. `materialize` would merge it into the other lineage's step, or the plan would carry
the id twice (`validatePlan`: "step id is used more than once"). In the same way,
`requires: [fp]` cannot name which step it means. The sync table ("item event, any goal") would
also close or drop the other lineage's step.

This is a wrong decision (blocker rule 2), and AC-2 builds the conditions for it without testing it.

**Fix:** make the step identity carry the lineage. Either:
- a local id from a short hash of `lineage|fp` (still ≤ 40 characters), with `requires` resolved
  within the requiring item's lineage first; or
- dedupe on `fp` alone and define one step per fp across lineages. In that case `Step.finding`
  becomes a list, and the sync rules must say which lineage's events win.

Add an AC: two lineages raise and file the same key into one goal, and the expected step count and
sync behaviour are checked.

### B2 (NEW): "append by a new plan version" breaks plan invariants of a goal that only grows

The spec appends each sink event as a new approved plan version holding "the previous approved
steps plus the new ones". Today's plan rules do not allow that:
- `validatePlan` refuses more than `MAX_STEPS = 50` steps (`dag.ts:6`, `:30`). A standing goal that
  collects every filed finding of a repo and topic passes 50 within weeks. Open question 3 even
  expects "hundreds". If the sink skips validation, the goal holds a plan that no person can
  re-propose or re-approve. If it validates, the 51st filed finding fails the filer's
  `mesh_done` (all in one transaction).
- `PlanStep.title` is at most 200 characters and `brief` at most 8000. A title of `[S1] ` plus a
  200-character item title is 205. The brief is built from up to 20 evidence notes of 1000
  characters, a 4000-character proposal and 2000-character reasons. Such a plan does not parse as
  `Plan`.
- `materialize` brings back a `dropped` step that is listed again as `blocked`
  (`dag.ts:182`, `old.state === "dropped" ? "blocked"`). If "the previous approved steps" includes
  dropped finding steps, every append revives every dismissed finding. That is the opposite of
  "append never reopens anything". If they are left out, then reopening a dropped step under rule 5
  goes through the plan, and the spec has to say so.
- Each version copies every step, so storage and the `plan.vN.yaml` trail files grow with the
  square of the number of findings.

This is a wrong decision as written (blocker rule 2).

**Fix:** say how appends relate to plans. Either:
- the hub saves finding steps directly (no plan version per sink; the goal's plan v1 stays empty and
  `validatePlan`/`MAX_STEPS` do not apply to finding steps), with `step.added` or `goal.sunk` as
  the record; or
- a plan version holds only the delta, with an explicit exemption from `MAX_STEPS`, dropped steps
  excluded, and the reopen path named.

In both cases, state the truncation rule for `title` (≤ 200) and `brief` (≤ 8000). Adjust AC-1's
"plan v3" to match.

### B3 (NEW): `mesh goal drop` does not exist, so the standing goal has no exit

"People may drop it (`mesh goal drop`); a later sink then opens a new one." There is no such
command (`goalCommand` has `new, ls, tag, untag, show, plan, approve, revise, replan, files`) and no
route (`app.ts` has no `/v1/goals/:id/drop`). A goal becomes `dropped` today only through the
pulse's `dropGoal` (`missed`/`abandoned`, service.ts:3671). `replan` on a clean-audit goal answers
404 (`has no design step`). The spec makes the goal standing, so it never finishes, and the one exit
it names does not exist. The concepts guide (calibration: "a dropped calibration goal releases its
dismissals") already assumes a drop that only pulses can do.

This is a wrong decision, or a factual error the design depends on (blocker rule 2).

**Fix:** either add `mesh goal drop <G>` to Scope with its route, rule (owner, approver or admin),
event (`goal.dropped {reason: "person"}`), what happens to held steps, and an AC (drop, then a later
sink opens a new goal), or remove the sentence and say that a clean-audit goal cannot be ended in
this release.

### B4 (NEW): no acceptance criterion names the surface it is proven on, or the state that makes it fail

RL-6, RL-7 and RL-8 give each AC a `Surface` and a "What exact state makes it FAIL?" column, after a
"Surfaces:" paragraph that names the fixtures. RL-9's ten criteria are a bare numbered list. None of
them says whether it is proven by a unit test, a World test (`test/helpers/world.ts`,
`relay-kit.ts` with the fake `claude`), a CLI test, the `HubStore` contract or Playwright. AC-7
("`mesh next` lists S1 before S2") could be a CLI test or a hub `listSteps` test, and those prove
different things: the sort can live in either place. This breaks blocker rule 4 for every AC.

**Fix:** use the RL-8 table form (Id, Criterion, Surface, FAIL state) and add the Surfaces paragraph.
Pin the fixtures that a blind test-writer cannot guess:
- AC-6: the stage policy that can dismiss a filed item (see S10);
- AC-4: "complete" coverage and the fold base;
- AC-1: which step is `claimed` and by whom.

## Suggestions

### S1 (NEW): the ready list and its order
- The route is `GET /v1/steps?ready=1` (`app.ts:302`, `listSteps`). `GET /v1/steps/ready` does not
  exist.
- `listSteps` already orders ready steps for a viewer: steps offered to the viewer's machine come
  first (MM-3). Say where severity sorting sits relative to that rule.
- Nothing orders by goal priority today. `priority` is 0–9 with a default of 3, and no doc says
  whether 0 or 9 is first. Say the direction. With it, say what a clean-audit goal's `priority 5`
  means relative to ordinary goals at 3.
- "Age" is undefined: `Step` has no `createdAt`. Name the field (for example the plan version that
  added it, or `ord` on Postgres and the rowid on SQLite, which is today's `stepOrder`).

### S2 (NEW): `mesh` as proposer and decider
No plan today is proposed or decided by `mesh`. Pulse and calibration goals use the owner
(`createWithPlan`: `proposedBy`/`decidedBy: o.owner`). `mesh` is not reserved as a user id, so a
user named `mesh` would be indistinguishable from the hub. Use the goal owner as RL-3 and RL-6 do,
or reserve the name.

### S3 (NEW): "settle never moves it to done" names the wrong place
`settle` never changes a goal. A goal becomes `done` in four places that call
`HubService.goalComplete`:
- `applyApproved` (service.ts ~2291),
- `doneStep` (~2581),
- `decideGate` (~2637),
- `resumeStep` (~2675).

Put the exception in `goalComplete` (false when `goal.sink` is set), so every path is covered. AC-8
should reach "all steps done" through a path other than `doneStep` too, for example a step closed by
the sync.

### S4 (NEW): the sink trigger: skipped stages, other done paths, and never failing the filer
- "(also when `skipped`: nothing to sink)" contradicts the "sunk item" definition. In the
  audit-debrief shape (guide, `consumes: [accepted]` filer), a person who files with a `link` in
  the debrief makes the item filed. `consumedNow` then excludes it, so the filer is **skipped**,
  and there is something to sink. State that a skip sinks the person-filed items.
- A skip happens inside `settleSteps`, which is called from `doneStep` of another step and from
  `applyApproved`. Name the hook (for example "whenever a sink step enters `done` or `skipped`").
- The sink runs inside the filer's `doneStep` transaction. Say that it never fails that call. Today,
  a topic deleted after `mesh pulse add` (`deleteTopic` strips pulse `topics` but not `params`), a
  cycle that only appears at done time, or a size limit would throw and leave the filer unable to
  finish. Name the outcome instead: an event and a note on the sink step.

### S5 (NEW): where the checks run, and their text
- The filer-shape check is placed "at approve". Pulse goals never pass `approvePlan`
  (`createWithPlan`), and `proposePlan` validates at propose. Put both checks (filer shape, topic
  exists) where `validatePolicies` runs, which is shared by `proposePlan` and `presetChecks`
  (`createPulse`, `updatePulse`, `goalFromPreset`).
- `policyOf` (`core/policy.ts:13`) copies a hard-coded list of keys. `sink` must be added there, or it
  is silently dropped from the step's policy.
- The hub already has an unknown-topic error: 400
  `unknown topic X (define with: mesh topic add <name>)` (`knownTopics`). Reuse it, or give the new
  text a status code and say why it differs.
- A pulse that has no `topic` param leaves `{topic}` as literal text (`instantiate` keeps unknown
  placeholders outside `agent`/`profile`). Say that this is refused as "not a topic".

### S6 (NEW): the sync table misses revert and two step states
- RL-4's `revertDisposition` can undo a debrief's `dismissed` or `deferred`, which puts the item
  back to `accepted` with its link (filed). The step stays `dropped`. Add a row (revert → reopen a
  step dropped by that disposition, or note only).
- `failed` (an interactive `mesh_done` with outcome fail, `claims.ts:105`) and `skipped` are not in
  the table. Say what `resolved`, `dismissed` and rule 5 do to a `failed` finding step.
- Rule 5 updates the title of an existing step "otherwise unchanged", including a `claimed` one.
  That contradicts "a step someone holds is never changed under them". Say whether held steps keep
  their title and only get a note.

### S7 (NEW): what "reopened (new round)" does
- `dag.reopen` moves done dependants back to `blocked`, and ready ones to `blocked` too ("work built
  on the old result is redone"). For findings, reopening A would re-block B's done step. Say whether
  rule 5 uses `reopen` or only sets A `ready`.
- A round is appended at `done`, not at reopen. "New round" is not observable at reopen time. Name
  the observable for AC-5:
  - `state: ready`;
  - `fixCycles + 1`;
  - a `step.reopened` event;
  - the note `refiled by <run goal>`.
- Reopening a `dropped` step has no helper today (`reopen` only handles `done`). Name its fields as
  well.

### S8 (NEW): `requires` on `mesh_dispose`, and on updated steps
- The cycle check is "when the record is submitted". `requires` is also accepted on `mesh_dispose`.
  Say where its cycle is checked.
- A person's `accepted` disposition with `requires`, followed by the filer's agreeing `accepted`
  that carries its own `requires`: say whether the lists are combined or replaced.
- Rule 4 applies to "the new step". Say whether a step updated or reopened by rule 5 gets new deps
  from a later record. If it does, a cycle can appear at done time (see S4).

### S9 (NEW): migration: answer it instead of leaving it to the impl plan
`goal`, `step` and `plan` keep the whole object in a JSON `value` column (`hub-store.ts:41-45`, PG
`:126-130`). The new fields need no column. Finding the goal by `(repo, topic)` can scan
`listGoals`, as `calibrationScan` does, and finding a step by `(lineage, fp)` can scan
`listSteps({goal})`. So there is no migration and no `SCHEMA_VERSION` change unless an index is
wanted. Say this, and note that `schemas/ledger-*.json` and `hub-api.openapi.json` are regenerated
(`pnpm schemas`).

### S10 (NEW): AC-6 needs a stage that can dismiss a filed item
The default debrief `consumes: [open, confirmed]` (`DEBRIEF_CONSUMES`). The built-in filer has
`may_set: [accepted]`. `disposeStep` refuses an item whose state is not in `consumes`. In every stock
shape, therefore, a filed item can never be dismissed later. AC-6 must name the policy, for example
a debrief in a later goal with `consumes: [accepted]` and `may_set: [dismissed]`, on an item its run
raised again (`repeat`). The same applies to the `deferred` row.

### S11 (NEW): a person's plan on a clean-audit goal
`proposePlan` accepts a plan for any goal that is not done or dropped. On a clean-audit goal
(`in_progress`), `mesh goal plan G --file x.yaml` followed by approve would drop every finding step
that is not in the file (`materialize`). Refuse plans on goals with `sink` (409), or say what they
mean.

### S12 (NEW): repo identity in the goal key
Lineages and the goal key use the raw repo string. Two pulses on `group/vpc-node-agent` and
`vpc-node-agent` open two goals. Say how the repo is normalised for `(repo, topic)` (for example
`repoName`, or exact match on purpose). Also, "the item's repo" in rule 3: `ItemRow` has no repo.
It is the lineage's repo segment, so say that.

### S13 (NEW): backfill route and authorization
- `POST /v1/items/sink` needs a route-table entry (`hub-api.ts`: rule, scope, tag; the schemas
  test checks it) and an idempotency note.
- "Owner or admin of the lineage's last goal" may differ from the clean-audit goal's owner. Say
  whether either is enough.
- `--min-severity` and `--dry-run` have no AC.

### S14 (NEW): parts of the contract without an AC
These have no criterion:
- `mesh show` header counts;
- the web view;
- the `goal.sunk` payload;
- the `requires <fp>: not in this goal` note;
- the filer-shape refusal;
- a held step getting a note on `dismissed`;
- the brief's last line.

Add the ones you want guarded. For `goal.created`, keep `title` in the payload next to `sink`.
Add `describe()` activity text for `goal.sunk` next to the `docs/events.md` row.

## Checks

Run: none of the repo's checks. This round reviews a spec, and nothing is implemented. I read the
code named above.

Not run: `pnpm lint`, `pnpm typecheck`, `pnpm boundaries`, `pnpm test`, `pnpm build`, `pnpm check`,
`pnpm schemas`, `pnpm test:web`. The Postgres legs of the store contract were not run
(`MESH_TEST_PG_URL` is unset). I judged the transaction point from `goalTx` and `store.tx` on both
dialects.
