Verdict: CHANGES REQUESTED | Round: 2 | Blocking-open: 2

# Review of the RL-9 spec, round 2

This is a cold review of `docs/specs/RL-9.md` at commit d8a3168 (revision 1). I read round 1
(`r1-changes-requested.md`) first. I checked the spec against the code it touches:
- `src/hub/service.ts`: `submitReview` (fold, `resolved`, dispositions), `applyDisposition`,
  `disposeStep`, `revertDisposition`, `debriefOr409`, `isRevertable`, `settleSteps`, `goalComplete`,
  `proposePlan`, `listSteps`, `createWithPlan`, `dropGoal`, `deleteTopic`, `knownTopics`, `topicName`,
  `presetChecks` and the pulse fire;
- `src/core/dag.ts` (`settle`, `SATISFIED`), `src/core/review.ts` (`lineageOf`, `consumedNow`,
  `whenHolds`), `src/core/policy.ts` (`policyOf`, `validatePolicies`, `DEBRIEF_CONSUMES`) and
  `src/core/presets.ts` (`instantiate`);
- `src/protocol/goal.ts` (`Step`, `Plan`, `normalizeTopics`), `review.ts` (`RecordDisposition`),
  `hub.ts` (`DisposeRequest`) and `tools.ts` (`mesh_review`, `mesh_dispose` take their input from those
  schemas);
- `src/hub/app.ts` (routes, the `ZodError` → 400 handler), `src/protocol/hub-api.ts`,
  `src/cli/hub-commands.ts` (`next`, `show`), `src/cli/review-commands.ts` (`debrief`),
  `src/cli/client.ts` (`revert`), `src/cli/tui/tui.ts` and `src/daemon/daemon.ts` (`/local/revert`);
- `test/helpers/world.ts`, `relay-kit.ts`, `review-kit.ts` and `debrief-kit.ts` for fixture feasibility;
- `docs/events.md`.

There is no CLAUDE.md. The hard rules I applied are the task's: keep mesh-harness generic, and stage
and commit by name. No hard rule is broken.

## Round 1 findings

| R1 | Status |
|---|---|
| B1 `f-<fp>` not unique across lineages | Fixed: the id is a hash of `<lineage>\|<fp>`, `requires` resolves in the item's lineage first, then a unique match, else a note. AC-03 and AC-17 guard it. |
| B2 append by plan version | Fixed: finding steps are saved directly, plan v1 stays empty, `validatePlan`/`MAX_STEPS` do not apply, title and brief truncation are pinned (AC-12, AC-17), reopen is a named path. |
| B3 no `mesh goal drop` | Fixed: route, rule, scope, refusals, events and CLI are specified, AC-14 covers them. Small gaps in S6. |
| B4 no surfaces | Fixed: table form with Surface and FAIL columns, a Surfaces paragraph and a pinned "relay" fixture. Two of the new ACs cannot be built as written (B1, B2 below). |
| S1 ready list | Fixed (route, position rule, no goal priority, "previous order"). Interaction with the offered-first rule in S3. |
| S2 `mesh` as actor | Fixed: the owner. |
| S3 `goalComplete` | Fixed, and AC-08 reaches "all done" through the resolved sync too. |
| S4 trigger | Fixed (done or skipped, any path, never fails the caller). The "never fails" part needs bounds (S2). The skip AC is B2. |
| S5 checks | Fixed in place and text, but the reused error does not produce the stated text for `{topic}` (S1). |
| S6 sync table | Fixed (revert row, `failed`, held steps only noted). The revert AC is B1. |
| S7 reopen | Fixed (no `dag.reopen`, observables named). |
| S8 `requires` | Mostly fixed (union, cycle at sink time, never refused). Deps of a reopened step and the order inside one trigger remain (S4). |
| S9 migration | Fixed in Out. |
| S10 dismissing a filed item | Fixed for a stage (AC-07 first half). |
| S11 person's plan | Fixed (409). Order against validation in S8. |
| S12 repo identity | Fixed (exact strings; the lineage's middle segment). |
| S13 backfill | Fixed (route, idempotency, authorization, AC-15). |
| S14 parts without an AC | Mostly fixed. What is left is S9. |

## What holds

- Persons can run the relay as the Surfaces paragraph says. `submitReview` takes a record from any held
  step with `output: review-record`. For a step that is not headless, `deciderOf` makes the decider the
  person. A raising record folds, and a consuming record applies dispositions with `link`.
  `review-kit.ts` (`claim`, `review`, `closeOk`) and `debrief-kit.ts` already drive such relays
  through the hub routes. `Rk.goal(..., { preset })` makes a preset goal, so the lineage
  `<preset>|<repo>|<step id>` (`lineageOf`) is shared by a "later run" of the same preset.
- The fixture's `file` stage can accept a filed item again. `submitReview` and `disposeStep` check
  `consumes.includes(row.state)` and not `consumedNow`. So AC-07's `consumes: [accepted]` stage can
  dismiss a `repeat` item. `applyDisposition` keeps `link` on a dismissal, so a revert to `accepted`
  restores a filed item, as the sync row assumes.
- "Filed in the goal" picks exactly C in AC-02. A and B stay `accepted` with their run-1 link
  (`repeat`). Their latest `accepted` disposition is in goal 1.
- An empty approved plan parses. `Plan.steps` is `z.array(PlanStep)` with no minimum. `Step` already
  has `planVersion`, `fixCycles`, `outcome`, `summary`, the holder fields and `roundStartedAt`. The
  `value` JSON columns need no migration.
- `step.reopened`, `step.done` and `step.dropped` exist. The `goal.dropped` shape of the pulse
  `dropGoal` (drop all but `done`/`skipped`/`dropped`/`failed`, withdraw offers) is real, and the
  `approver` role exists (`replan` uses it).
- `presetChecks` aggregates into 422 `the preset has n problem(s): …`. The sink text is one of those
  problems, so AC-11's 422 with the sink text is observable. A pulse fire does not re-run
  `presetChecks`, so a topic deleted after `pulse add` reaches the sink only at done time, as the
  spec handles.
- `mesh next` prints the hub's order (`/v1/steps?ready=1`, filtered by `--repo` only), so AC-13's CLI
  half proves the hub sort.
- `mesh_review` and `mesh_dispose` take `ReviewRecord.shape` and `DisposeRequest.shape`
  (`protocol/tools.ts`). Adding `requires` to the schemas reaches the tools without new tool code.

## Blockers

### B1 (REGRESSION-OF-OWN-REPAIR): AC-07's revert half names a surface that does not exist and a revert the hub refuses

The repair of r1 S6 and S10 added: "`mesh debrief` revert of that dismissal (RL-4, a debrief stage with
the same consumes and may_set) → the step is reopened with reason `reverted`". Two problems.

1. **No such command.** `mesh debrief` has one form, `mesh debrief <step> [--session NAME] [--no-tui]`
   (`review-commands.ts:45`). A revert exists only as:
   - the TUI's `u` key (`tui.ts:300`), which goes to `client.revert` and the daemon's `/local/revert`;
   - the hub route `POST /v1/steps/:id/dispositions/revert` (`app.ts:361`).
2. **"That dismissal" cannot be reverted.** The first half has the dismissal recorded by a **stage**
   (`submitReview`, `via: "stage"`). `revertDisposition` requires a debrief step (`debriefOr409`)
   and a disposition with `via === "debrief-session"`. `isRevertable` also requires that disposition
   to be the item's latest history entry. The parenthesis suggests a separate debrief scenario, but
   the AC does not say:
   - who dismisses;
   - through which call;
   - that nothing may change the item between the dismissal and the revert.

A blind test-writer cannot build this half. It names a surface that does not exist (blocker rule 4).

**Fix:** split AC-07.
- (a) The stage dismissal, as now.
- (b) A later run with a debrief step (`mode: debrief`, `consumes: [accepted]`,
  `may_set: [dismissed]`, `output: review-record`, deps `[audit]`). The person dismisses filed item B
  with `mesh_dispose` (`POST /v1/steps/:id/dispositions`), and B's step is `dropped`. Then the person
  reverts it with `POST /v1/steps/:id/dispositions/revert` (World, hub route), before any other change
  to B. B is `accepted` with its link, and B's step is reopened with `step.reopened` reason `reverted`.
- Name the surface "World (hub route)". If a CLI is wanted, add `mesh debrief revert` to Scope.
- Say what deps a step reopened by a revert gets. There is no sink stage, so rule 5 does not apply.
  Probably its deps are unchanged.

### B2 (REGRESSION-OF-OWN-REPAIR): AC-09 never makes `file` skip, so it cannot catch a missing skip hook

The repair of r1 S4 added AC-09: "a relay with a debrief before `file` where the person accepts item F
with a link in the debrief → `file` is `skipped` and F still gets a finding step". Two gaps:
- `settle` sets `skipped` only for a step with `policy.when`
  (`dag.ts:126`: `want = !s.policy?.when || held(s) ? "ready" : "skipped"`). The pinned fixture `file`
  has no `when`. Built from the spec, `file` becomes `ready`, not `skipped`.
- Even with `when: {open: true}`, `whenHolds` stays true while any other item of the run is still
  consumed (an `open` A). Then `file` is not skipped either.

A test-writer who finishes `file` by hand to get past this makes the AC pass through the `done` hook.
An implementation that never sinks on `skipped` then passes. The criterion that guards the skip
trigger cannot fail (blocker rule 3).

**Fix:** pin the AC-09 fixture.
- Steps: `audit` (raises only F); `debrief` (`mode: debrief`, deps `[audit]`, `may_set: [accepted]`,
  `output: review-record`); `file` (deps `[debrief]`, as the relay plus `when: {open: true}`).
- Actions: the person accepts F with a link through `mesh_dispose`, then `mesh_review` and `mesh_done`
  on the debrief.
- Then: `file` is `skipped` (assert it) and F has a finding step.
- Add "`file` not skipped" to the FAIL column.

## Suggestions

### S1 (REGRESSION-OF-OWN-REPAIR): the reused topic check does not give the stated text
The repair of r1 S5 reuses the hub's 400 `unknown topic <t> …`. But `knownTopics` first maps each
name through `topicName`, which parses `TopicName`. An unfilled `"{topic}"` therefore throws 400
`bad topic "{topic}": …` (`service.ts:4462`), not `unknown topic`. An implementation that calls
`knownTopics([sink.topic])` fails AC-11's third case.

Two related gaps:
- `normalizeTopics` drops `all`, so `knownTopics(["all"])` returns `[]` with no error, and
  `sink: {topic: all}` would pass and key a goal on `all`. Refuse `all` by name.
- Topic names are lowercased (`CI` → `ci`). Say that `sink.topic` is normalised the same way before
  it becomes part of the goal key.

Either pin `bad topic` for the placeholder case in the spec and AC-11, or say the check
special-cases it.

### S2 (NEW): bound "Never fails the caller"
"Any problem … is caught: the caller's change commits" cannot hold for every problem:
- The store has no savepoints (`hub-store.ts` `tx`). On Postgres, a failed statement aborts the
  transaction, so a caught store error still makes the caller's commit fail.
- A problem found after the sink wrote the goal or some steps leaves those partial writes in the
  committed transaction.

Say that the named checks run before the first write (topic defined, …), that only they are caught,
and that store errors propagate. AC-10 should also assert that no step was added on failure.

Related: `deleteTopic` strips the topic from `Goal.topics` but would leave `Goal.sink.topic`. Say:
- whether a sink into an **existing** clean-audit goal re-checks the topic (AC-10 assumes it does);
- what `deleteTopic` does to `sink`;
- whether redefining the topic resumes the same goal.

### S3 (NEW): the severity refill and the offered-first rule
"Positions held by its finding steps are refilled … sorted by severity" runs after the offered-first
reordering. If the step offered to the viewer's machine is an S3 finding and an S1 finding of the same
goal is ready, the refill moves the S1 step into position 1. That contradicts AC-13's "a step offered
to the viewer's machine is still first". Say that the refill applies within each part: the
offered-here part and the rest. In AC-13, name which step is offered: a finding step of the sorted
goal makes the AC sharp.

### S4 (NEW): deps of a reopened step, and order inside one trigger
- Rule 5 sets the deps of a reopened step to "the union of `requires` … in the sink stage's goal".
  Say whether this **replaces** its earlier deps or **adds** to them. AC-04's cycle case depends on
  the answer.
- Within one trigger, D (`requires: [fpE]`) and E are both new. If D is processed before E's step
  exists, a literal reading gives D the note `requires <fpE>: not in this goal`. Say that every step
  of the trigger is created or reopened first and deps are resolved after that. AC-04 assumes it.

### S5 (NEW): `step.reopened` payload
Today's payload is `{ by, reason, fixCycles }` (`service.ts:2574`, `:2632`; `docs/events.md:32`). The
spec uses `{ reason, from }`. Use `by` for the sink step (or the reverting debrief) and keep
`fixCycles`, so consumers and the activity text stay uniform. Name the `user` and payload of the
`step.done`/`step.dropped` events emitted by the sync, and update the events.md row.

### S6 (NEW): `mesh goal drop` and `parked` steps, pulses and calibration
- The 409 lists `claimed` and `paused` as held. `dropGoal` drops `parked` steps, while the sync table
  treats `parked` as held. Say that parked steps are dropped, or add them to the 409.
- "Any goal": add one line each for a pulse goal whose slot is still pending (the slot later becomes
  `missed`? `advanceSlot` returns early on a dropped goal) and for a calibration goal (its dismissals
  are released, as the concepts guide says).

### S7 (NEW): where the `requires` refusal lives, and its wording
- A `.refine` in the schema becomes 400 `invalid request` (`app.ts:395`), not 422. Say that the
  "only for accepted" check is in the service, like `deferred needs until`.
- In `submitReview` it is one of the record's problems, which fails the whole record with 422
  `the review record has n problem(s): …`. Say so for AC-04.
- "Requires are never refused at record or dispose time" reads as contradicting this 422. Write
  "an fp in `requires` is never refused".

### S8 (NEW): AC-08's 409 against plan validation
`proposePlan` validates the plan first (`service.ts:2184`). An `x.yaml` with a problem would answer
422 before any goal check. Say that the clean-audit 409 comes first, or state in AC-08 that `x.yaml`
is a valid plan.

### S9 (REPEAT, rest of r1 S14): still no criterion for
- the note on a held step from a `dismissed`/`deferred` disposition (AC-05 covers only `resolved`);
- the `deferred` row;
- `goal.created` carrying `{ title, sink }`;
- `goal.sink_failed`'s payload (AC-10 checks only that the event exists);
- the dismiss rows' `failed` state.

Add the ones you want guarded.

## Checks

I ran none of the repo's checks. This round reviews a spec, and nothing is implemented. I read the
code named above.

Not run: `pnpm lint`, `pnpm typecheck`, `pnpm boundaries`, `pnpm test`, `pnpm build`, `pnpm check`,
`pnpm schemas`, `pnpm test:web`. The Postgres legs of the store contract were not run
(`MESH_TEST_PG_URL` is unset). I judged the savepoint point (S2) from `hub-store.ts` `tx`.
