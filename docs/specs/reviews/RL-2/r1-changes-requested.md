Verdict: CHANGES REQUESTED | Round: 1 | Blocking-open: 5

# Review of spec RL-2, round 1

I reviewed `docs/specs/RL-2.md` (revision 1, commit 0b8470c) cold. I checked it against
`docs/analysis/2026-11-12-pulse-relay-roster.md` (§2 REQ-5..REQ-9, §5.3, §5.4, §5.6, §5.9, §6, §7, §9 S2)
and against the code on `feat/relay-design`:
- `src/protocol/{goal,hub-api,tools}.ts`
- `src/core/{dag,policy,redact}.ts`
- `src/hub/{app,service}.ts`: `approvePlan`, `doneStep`, `decideGate`, `resumeStep`, `uploadArtifact`,
  `stepInputs`, the idempotency middleware
- `src/store/{hub-store,hub-copy}.ts`
- `src/daemon/{tools,runs}.ts`, `src/cli/show.ts`
- `test/helpers/world.ts`, `playwright.config.ts`, `package.json` scripts
- `docs/specs/RL-1.md` (the `<repo name>` definition)

There is no earlier RL-2 round, so every finding is NEW. None is a REPEAT or a
REGRESSION-OF-OWN-REPAIR.

## Checks

This is a spec review, so there is no code to build. I did not run any of these: `pnpm lint`,
`pnpm typecheck`, `pnpm boundaries`, `pnpm test`, `pnpm build` (together `pnpm check`), `pnpm schemas`,
or `pnpm test:web`. I used only `git`, `grep`, `sed`, `cat` and file reads. I did not run the `claude`
binary.

## What already matches the code

- **Policy and plan types.** `StepPolicy` is a plain `z.object` and `PlanStep` spreads
  `StepPolicy.shape`, so the four new optional fields reach plans as the spec says. An older hub strips
  them. `policyOf` has an explicit key list, and the spec extends it.
- **`skipped` in the code.** The only `Record<StepState, …>` is `MARK` in `src/cli/show.ts`, and the spec
  names it. The goal-done checks in `doneStep` and `decideGate` are where the spec puts the new rule.
- **Tools and profiles.** `MESH_TOOL_RULES` already lists `mcp__mesh__mesh_review`, so keeping it
  unchanged leaves the profile hashes stable, as AC-25 says.
- **Artifacts and inputs.** `doneStep` reads `artifactIds` from `listArtifacts({step, round: n})`, so the
  record's `review` artifact lands on the round as AC-12 expects. `stepInputs` skips the keywords
  today, so serving `previous` and `dispositions` from `StoredReview`, not from artifact content, keeps
  AC-29 consistent.
- **Authorization and idempotency.** The holder/admin checks on the POSTs follow `uploadArtifact`. The
  route table rule `member` with `goals:read` on the GETs follows the artifact reads. The generic
  `Idempotency-Key` middleware in `app.ts` replays a stored 2xx body, which makes AC-26 reachable.
- **Daemon redaction.** It uses `redactSecrets(text, host.secrets())`, as `mesh_artifact` does.
- **Close-as-fail.** In `runs.ts` the daemon closes a run "without an accepted mesh_done" with
  `outcome: "fail"`. With a record present, the spec turns that into `done`, and AC-21's 409 path stays
  consistent.

## Findings

### F1 (blocker, NEW): consuming records can become the fold base and the `previous` input

The spec says a consuming step's lineage is its run's lineage, and `StoredReview` stores the
`complete` flag from `coverage`. **Fold** (Hub HTTP API section) takes `previous` from "the last
`complete` record of the same lineage other than (step, current round), by `at`". `mesh_context
previous` uses the same rule. Neither one excludes consuming records, and `listReviews` has no `raising`
filter.

A validator record is consuming, `coverage: "complete"` and `items: []`. In the design §5.6 relay it
is stored after the audit record, so it is the last complete record of the lineage. Here is what goes
wrong in the next goal:
- `previous` is `[]`, so the audit fold never resolves anything;
- a raising step with `inputs: [previous]` gets the validator's empty record, not the previous audit;
- `foldItems` still marks items `repeat` from the rows, so the bug is easy to miss.

AC-10 has no consuming step, so it cannot catch this (design §5.3: the fold is "on a `run` stage
record"). **Fix:** base the fold and `previous` on **raising** records only. Add `raising?: boolean` to
the `listReviews` filter, or say `complete && raising`. Extend AC-10 (or AC-17) with a validator record
between two goals, and check that the base is the earlier audit and that A becomes `resolved`.

### F2 (blocker, NEW): `materialize` makes new or changed `when` steps `ready` before `settle` sees them

`materialize` (`src/core/dag.ts:139`) calls `recomputeReady` on every step it returns, and
`approvePlan` saves those upserts. The spec keeps that call: it only says that `recomputeReady`
treats `skipped` as satisfied. It also says `settle` never re-evaluates a `ready` step. Two cases go
wrong:
- the spec's own rule "changed → `blocked`" for a skipped step becomes `ready` inside `materialize`;
- a step with `when` that a replan adds after its run is done does the same.

Either step then gets `step.ready` and an offer without `when` being checked. That contradicts AC-18
("changing its brief → `blocked`, then re-evaluated"), and the contract as written cannot pass it.
**Fix:** state that `materialize` leaves readiness to the caller for steps with `policy.when` (or calls
`settle` with a `holds` argument), and that `approvePlan` runs `settle` over the materialized steps.
Add a unit case to AC-07: a `materialize` step with `when` and satisfied deps is not `ready` and does
not emit `step.ready` before `holds` is consulted.

### F3 (blocker, NEW): `mesh hub migrate` loses review data on the move to Postgres

`copyHubToPostgres` (`src/store/hub-copy.ts`) copies only the tables in its `TABLES` list, which RL-1
extended with `artifact` and `profile`. Migration 9 adds `review_record`, `review_item` and
`item_history`. The spec does not add them to the list, and AC-08 does not cover the copy, so a
SQLite → Postgres move would silently drop every record, item and disposition. **Fix:**
- add the three tables to `TABLES`, with `item_history` as `identity: "seq"`;
- use the repo's Postgres form for `seq`, which is `BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY`
  (as `event.seq` and `note.id`, and the header comment of `HUB_MIGRATIONS_PG`), not `BIGSERIAL`;
- add a criterion on the `test/m46-ops.test.ts` surface (Postgres when its URL is set): a hub with a
  record, items and history copies with equal row counts, and `itemHistory` keeps its order.

### F4 (blocker, NEW): disposition checks vs person precedence: the order is unspecified, and AC-14 depends on it

In AC-14 a person dismisses A, and then a headless consuming step's record confirms A. The spec gives
two outcomes for that record:
- **State check:** "the item's state is not in `consumes` … → 409/problem". A is `dismissed`, and
  AC-14 does not say the headless step consumes `dismissed`. A validator normally consumes `[open]`,
  so the record would be refused with 422 `disposition of A: item A is dismissed; … acts on open`.
- **Precedence:** "not applied … listed in `ignored` … (the record is still accepted)".

The spec does not say which comes first, so a blind test and an implementation can disagree. The same
holds on `POST …/dispositions`, where two different 409 texts compete. **Fix:**
- state the order explicitly, for example: `may_set`, `until`, no item, person precedence (→ ignored /
  409), then state;
- give AC-14's headless step a `consumes` that makes the scenario unambiguous;
- add one case per conflicting pair.

### F5 (blocker, NEW): `mesh_dispose` and `POST /v1/steps/:id/dispositions` belong to S4, not this row

Design §9 lists `mesh_dispose` in **S4 Debrief**. The spec's S2 row content is "dispositions", and this
spec already records dispositions through `mesh_review` records: `RecordDisposition`, the consuming
record path, and AC-13. The spec adds MCP `mesh_dispose`, a POST route, `DisposeRequest`, AC-15 and part
of AC-26 to this row. It does not record the deviation in Open questions, while its own Out list moves
the other S4 items. No S2 consumer needs it: interactive consuming steps can dispose in their record,
and `MESH_TOOL_RULES` deliberately leaves `mesh_dispose` out of headless runs. This is scope creep
beyond the row. **Fix:** move `mesh_dispose`, `POST /v1/steps/:id/dispositions`, `DisposeRequest`,
`answer` and AC-15 to S4. Keep `GET /v1/steps/:id/dispositions` only if a criterion needs it. Otherwise,
record the reason in Open questions (dated) and show which S2 criterion fails without it.

### F6 (suggestion, NEW): `sid` in the new POST bodies is not checked against the caller

`uploadArtifact` refuses a `sid` from another user or machine (`refuseForeign`): "the event names the
uploading session: never another user's". The spec stores `ReviewUpload.sid` and `DisposeRequest.sid`
on `StoredReview` and in `review.recorded`, but it has no such check. Add it to both POSTs, in the same
place in the error order as `uploadArtifact`, and add a case to AC-09.

### F7 (suggestion, NEW): `<repo name>` has no definition on the hub

The `raisedBy` fallback and the agent decider key use `"<repo name>/<local id>"`. RL-1 defines
`<repo name>` on the **daemon** (`repoForCwd(checkout).name`, else the basename). The hub only has
`step.repo`. Say how the hub derives it (for example, the last path segment of `step.repo`), or use
`step.repo` itself. Also, "for `POST …/dispositions` the key form without hash" only makes sense if
that route stays (F5).

### F8 (suggestion, NEW): the order of errors on `POST …/done` is not given

Existing `doneStep` validates `reopen` ids first: `404 cannot reopen G1.x: no such step` and `409 … not
done`. It then checks state and holder. AC-12 sends `reopen: ["x"]` and expects the new 400. As
written, the existing 404 wins. State where the new 400 and the "needs a review record" 409 sit
relative to the existing checks. Also state that `route`, `target` and `failures` routing do not apply
when a record exists, not only `max_rounds`, `park_on` and `must_cover`.

### F9 (suggestion, NEW): the event payload value types are ambiguous

The `review.recorded` keys `items` ("unique fps"), `dispositions` ("applied") and `ignored` can be read
as counts or as lists. AC-24 allows fps in payloads, so either reading fits. Give the types. Also say
whether storing the record's `review` artifact emits RL-1's `step.artifact` event. AC-26's "one event
each" depends on it.

### F10 (suggestion, NEW): "last record by `at`" ties under the World clock

`w.clock` stays fixed until a test moves it. Two records with the same `at` then fall back to `step`,
and that comparison is lexicographic (`G10.audit` sorts before `G9.audit`), so the fold base can be the
wrong record. Order by insertion instead: a sequence column in `review_record`, or `created_at` then
rowid/identity. Say so in the store row and in AC-08.

### F11 (suggestion, NEW): the inputs of `whenHolds` and the items of the run's record are loosely named

A `StoredReviewItem` has no `state`. Say that `holds` and "items a step may act on now" use the **item
rows** `(lineage, fp)` for the unique fps of the run's record. Also say whether `severity` comes from
the row (the last record) or from the run's record. The two differ when another goal of the lineage
has folded since.

### F12 (suggestion, NEW): the transaction for cross-goal item rows is not named

Item rows are per lineage, so they are shared across goals. "In one transaction" on Postgres READ
COMMITTED does not stop two goals of one lineage from folding over each other. Name `goalTx`
(`store.serialize()`), as `uploadArtifact` and `doneStep` use.

### F13 (suggestion, NEW): goal done after a replan's `settle`

`approvePlan` sets the goal to `in_progress` unconditionally. If a replan settles every remaining step
to `skipped`, the spec does not say whether the goal becomes `done` there. Say whether it does.

### F14 (suggestion, NEW): problems listed for a single disposition

Say whether one disposition yields only its first failing check or all of them, and give the order of
problems across the record (record order is the obvious choice).

### F15 (suggestion, NEW): an item raised only in a partial record never resolves

If an fp first appears in a partial record and is absent from the next complete record, it was never
in `previous`, so it stays `open` for good. It then appears in a raising step's `dispositions` input.
Either accept this in Open questions or resolve such fps when the next complete record omits them.

### F16 (suggestion, NEW): AC-28's surface

The repo has no component-test setup (vitest runs `*.test.ts` in `node`), and `test/e2e-web` runs
through `pnpm test:web`, not `pnpm check`. Name Playwright (`test/e2e-web`) as earlier specs do (MM-2
AC-19, MM-4 AC-15), say how the shared e2e hub gets a skipped step (through the API), and give the
selector of the state text.

### F17 (suggestion, NEW): small precision gaps

- In the `mesh_review` reply, say whether `<k> item(s)` counts unique fps or every item.
- `key.symbol`, `scope`, `subject.repo` and `evidence[].path` are never redacted, and they reach
  `ItemView` and the CLI. That is fine for identity, but say so in the "Redaction of records" open
  question.
- `GET /v1/steps/:id/reviews` is not in design §6, which is fine. Note it with F5's decision.

## Summary

| Class | Count |
|---|---|
| Blockers | 5 (F1-F5) |
| Suggestions | 12 (F6-F17) |
| NEW | 17 |
| REPEAT | 0 |
| REGRESSION-OF-OWN-REPAIR | 0 |
