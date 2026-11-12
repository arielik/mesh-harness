Verdict: APPROVED | Round: 2 | Blocking-open: 0

# Review of spec RL-2, round 2

I reviewed `docs/specs/RL-2.md` (revision 2, commit 45a8efa) cold. I read round 1
(`r1-changes-requested.md`) first. I checked the spec against the design
`docs/analysis/2026-11-12-pulse-relay-roster.md` (§2 REQ-5..REQ-9, §5.3, §5.4, §5.6, §5.9, §6, §7,
§9 S2) and against the code on `feat/relay-design`:
- `src/core/dag.ts`: `recomputeReady`, `materialize`, `reopen`
- `src/core/stages.ts`: `stepStage`, `STEP_STAGES`
- `src/hub/service.ts`: `goalTx`, `callerMachine`/`refuseForeign`, `uploadArtifact`, `stepInputs`,
  `approvePlan`, `doneStep`, `decideGate`, `resumeStep`
- `src/store/hub-store.ts` (migrations, `ord`, `stepOrder`), `src/store/hub-copy.ts` (`TABLES`, the
  identity handling), `src/store/dialect.ts`, `src/store/hub-store.contract.test.ts` (the version 8
  checks)
- `src/protocol/{goal,hub,hub-api,tools}.ts`, `src/cli/show.ts`, `web/src/goals.tsx` (the AC-28
  selectors)

## Checks

This is a spec review, so there is no code to build. I did not run any of these: `pnpm lint`,
`pnpm typecheck`, `pnpm boundaries`, `pnpm test`, `pnpm build` (together `pnpm check`), `pnpm schemas`
or `pnpm test:web`. I used only `git`, `grep`, `sed`, `cat` and file reads. I did not run the `claude`
binary.

## Round 1 findings: status

| R1 | Status | Where it is fixed |
|---|---|---|
| F1 (blocker) | Fixed | The fold base and `previous` are `raising && complete`. `listReviews` has a `raising` filter. AC-10 puts a validate record between goals and checks the base and the `previous` input. |
| F2 (blocker) | Fixed, with one wording gap (G2) | `materialize` and `recomputeReady` never make a `when` step `ready`. `approvePlan` settles after the upserts. AC-07 and AC-18 cover it. |
| F3 (blocker) | Fixed | The three tables are in `TABLES`, `item_history` uses `identity: "seq"`, and `seq` uses the repo's identity form. `review_record.ord` follows the `step.ord` pattern, which the copy already handles. AC-32 is on the ops surface. |
| F4 (blocker) | Fixed | The check order is explicit and puts precedence before state. AC-14 gives `recheck` `consumes: [open]` and has a case for each conflicting pair. |
| F5 (blocker) | Fixed | `mesh_dispose` and the disposition routes are in Out. The open question is dated. AC-15 is retired, and AC-25 checks that there is no `mesh_dispose`. |
| F6 | Fixed | `sid` goes through `refuseForeign` (text matches `service.ts`). AC-09 covers it. |
| F7 | Fixed | `repoName` is defined. AC-03 has vectors for it, and an open question is recorded. |
| F8 | Fixed | The 400 now comes before the existing reopen-id checks (`doneStep` checks the ids before the state today, so this order matters). Routing is excluded. |
| F9 | Fixed | The payload value types are given. The record artifact emits no `step.artifact`. |
| F10 | Fixed | Ordering uses insertion order. AC-08 has the `G10`/`G9` same-`at` case. |
| F11 | Fixed | "Items of the run's record" is defined on item rows, with the row's severity. |
| F12 | Fixed | `goalTx` is named for every write. |
| F13 | Fixed | A goal that settles to all done/skipped/dropped on `approvePlan` becomes `done`. AC-18 covers it. |
| F14 | Fixed | One problem per disposition, in record order. AC-13 covers it. |
| F15 | Accepted | Recorded as a dated open question. |
| F16 | Fixed | AC-28 is on Playwright. The selectors (`g.node[data-step]`, class `st-<state>`, the panel's `· {state}`) exist in `web/src/goals.tsx`. |
| F17 | Fixed | `<k>` counts unique fps. The open question names the unredacted fields. The reviews GET has a stated reason. |

No round 1 finding is a REPEAT.

## Findings (round 2)

All of these are suggestions. None breaks a hard rule, none is a wrong decision, and every criterion
can fail and names its surface.

### G1 (suggestion, NEW): `stepStage` and `STEP_STAGES` have no place for `skipped`

`src/core/stages.ts` `stepStage` is an exhaustive `switch` over `StepState`, with no default. The
TUI, `mesh goal show` (`stageSummary`) and the web goal page (`partition(detail.steps, stepStage,
STEP_STAGES)` in `web/src/goals.tsx`) are all built from it. When `skipped` is added:
- typecheck forces a new case;
- if the case does not return a stage that is in `STEP_STAGES`, `partition` throws
  `stage … is not in the table`, and AC-28's page breaks.

The spec's Compatibility section names only `MARK` and does not say which stage `skipped` belongs to.
This changes counts that every view shows. Round 1 also missed it. **Fix:** decide the stage. Either
`skipped` → `"done"`, or a new `"skipped"` entry in `STEP_STAGES` (say where in the order). Add the
decision to the CLI/Compatibility rows, and assert it in AC-23 (the `steps:` summary line of
`mesh goal show`) or in a unit case.

### G2 (suggestion, REGRESSION-OF-OWN-REPAIR of F2): "changed → blocked" in `materialize` is not limited by state

The F2 fix says: "`materialize` returns every step with `policy.when` (new, changed, or reset from
`skipped`) as `blocked`". Read literally, a **claimed** or **paused** step with `when` whose brief
changes would be sent to `blocked`. Today `materialize` keeps that state and puts the step in
`changedForHolder`, so the holder is told. Parked and failed steps could also be affected. AC-07 tests
only a skipped step, so it cannot catch this. **Fix:** say that the rule applies only to steps in
`blocked`, `ready` or `skipped` (or "new or reset from `skipped`/`dropped`"). Say that claimed, paused,
parked and failed steps keep their state as today. Also say whether an unchanged `ready` step with
`when` stays `ready` (current behaviour).

### G3 (suggestion, NEW): a step with `consumes`/`may_set` but no `output` can never record anything

`POST …/review` answers 409 `<id> has no output: review-record` for such a step. `validatePolicies`
does not require `output` with `may_set`. Several criteria leave `output` off their consuming steps
even though those steps submit records:
- AC-13's validator;
- AC-14's `review` and `recheck`;
- AC-17's `validate`;
- AC-10's `validate`.

A blind test written from the text would get 409. **Fix:**
- add the error `step "<id>": may_set needs output: review-record` (a `file` step with `consumes` and
  no `may_set`, as in design §5.6, stays valid);
- or at least state `output: review-record` on those steps in the criteria.

### G4 (suggestion, NEW): does the record's artifact count against later `mesh_artifact` uploads?

The route table says the `review` artifact "is not subject to `artifacts.per_round`/`max_bytes`", which
is about its own creation. The open question says it "is not counted against `artifacts.per_round`",
which is also about later uploads. `uploadArtifact` counts `listArtifacts({step, round}).length`, and
that count would include it. A user can also upload `kind: "review"` through `mesh_artifact`, so the
kind alone does not identify the record's artifact. **Fix:** state which reading applies. If it is not
counted, say how `uploadArtifact` tells the record's artifact apart (for example, the
`StoredReview.artifact` id of that round), and add a case to AC-12 or AC-09.

### G5 (suggestion, NEW): `reopen()` of a done `when` step makes it `ready` without `holds`

`reopen` sets a reopened step straight to `ready`, and `settle` never re-evaluates a `ready` step. A
non-output step (for example AC-18's `check`) that fails with `reopen: ["validate"]` therefore reruns
`validate` even when nothing it consumes is left. That may be intended: the request is explicit. State
it, or send a reopened step that has `when` to `blocked` so that `settle` decides it.

### G6 (suggestion, NEW): the `HUB_API` entry for `/v1/items` has no `query`

`HubApiRoute` has a `query` map, which the OpenAPI document and the route-table test use (as for
`/v1/goals` and `/v1/steps`). Name `query: { lineage: "…" }` for `GET /v1/items`, so AC-31's "lists the
three new routes" also covers the parameter.

### G7 (suggestion, NEW): AC-14's "fresh `recheck` round" is harder than it needs to be

On `POST …/review`, the 409 `round <n> already has a review record` comes before the 422 problems. So
after the accepted `recheck` record, a conflicting record in the same round answers 409, not 422.
Getting a fresh round needs a downstream step to fail and reopen `recheck`. Because a 422 stores
nothing, the simpler and deterministic setup is to send the three conflicting records **before** the
accepted one, in the same round. Say that, or say how the fresh round is made.

### G8 (suggestion, NEW): `holds` is synchronous while the data is in the store

`settle(steps, now, holds)` takes a synchronous `holds`, but on the hub the run's record and the item
rows come from async store reads. Say that the hub loads, before calling `settle`, the run's record and
item rows for every step of the goal that has `when` (a cascade can reach any of them). Otherwise an
implementation may fetch only the steps whose deps are already satisfied.

## Scope

Nothing beyond the S2 row. `GET /v1/steps/:id/reviews`, `mesh items --all`, `listDispositions` and the
`undeclaredRules` telemetry each serve a stated S2 criterion. The S4 items (`mesh_dispose`, the
disposition routes, `answer`, debrief) are out and recorded. No team-, company- or person-specific
name appears.

## Summary

| Class | Count |
|---|---|
| Blockers | 0 |
| Suggestions | 8 (G1-G8) |
| NEW | 7 |
| REPEAT | 0 |
| REGRESSION-OF-OWN-REPAIR | 1 (G2) |

G1 and G3 are the ones most worth fixing before implementation: G1 decides what every view counts,
and G3 makes several criteria fail as written.
