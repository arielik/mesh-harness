Verdict: CHANGES REQUESTED | Round: 1 | Blocking-open: 1

# Review of the RL-6 spec, round 1

This is a cold review of `docs/specs/RL-6.md` (as committed in 061ee22 on feat/relay-design). I checked it
against `docs/analysis/2026-11-12-pulse-relay-roster.md` (§5.3, §5.8, §5.9, §5.10, §9 S6, §10) and the
code on feat/relay-design. `docs/specs/reviews/RL-6/` did not exist before this round, so every finding
below is NEW. None is a REPEAT or a REGRESSION-OF-OWN-REPAIR.

## Checks

This was a spec review, so no product code changed. I read the code and ran no build or test command.

Not run: `pnpm lint`, `pnpm typecheck`, `pnpm boundaries`, `pnpm test`, `pnpm build`, `pnpm check`,
`pnpm schemas`, `pnpm test:web`. The Postgres legs of the store contract were also not run
(`MESH_TEST_PG_URL` is unset; CI runs them).

What I checked in the code:
- `src/store/hub-copy.ts` `TABLES` against every `CREATE TABLE` in `HUB_MIGRATIONS`. `topic` is the
  only missing table, which confirms the claim in the Problem section.
- `src/core/review.ts` `whenHolds`, `isRaising`, `lineageOf`, `repoName`, and `src/core/roster.ts`
  `canonicalKey`. The repo copy key in `agentsView` and the telemetry `agentKey` from
  `src/daemon/runs.ts` agree (`<repo last segment>/<name>`). A repo agent's run reports its file hash,
  so the AC-17 auditor has a non-empty hash and the "hash `""` never triggers" rule does not stop
  AC-17.
- `src/protocol/review.ts`: `StoredReview` (`raising`, `fold`, `undeclaredRules`, `decider`), the
  history entry kinds (`fold`, `disposition`, `revert`), and `ItemRow.raisedBy`/`link`. A revert is
  only possible while the disposition is the item's latest entry (`isRevertable`), so "the next
  history entry is a revert" is the right test.
- `src/hub/service.ts`:
  - `submitReview`: the order of the disposition checks, and person precedence at
    `service.ts:1036-1045`.
  - `createWithPlan`, which pulse and ingest goals share. Its owner is the pulse owner.
  - goal listing, which hides only goals with `refs.pulse`.
  - `offerableSteps`/`emitReady`. A calibration goal has no stick, so its step is never offered,
    and a debrief is never offered.
  - the paths that set a goal `done`.
- `src/hub/config.ts` (zod defaults pattern), `src/protocol/hub-api.ts` and `test/schemas.test.ts`
  (route table, rule, scope and tag checks), and `src/hub/app.ts`. The new `:key` route does not clash
  with `/v1/agents/resolve`.
- `test/e2e-web/hub.yaml` and `roster.spec.ts`: one user per spec, the seeding style. `test/helpers/world.ts`
  takes `hubYaml`, so a World test can set `calibration.threshold`.
- `test/review-hub.test.ts` (RL-2 AC-14) and `test/debrief-hub.test.ts` (RL-4 AC-12): their precedence
  tests use disagreeing values, so fix 2 as written does not break them.

Overall, AC-17 checks out step by step against the code: the slot 1 and slot 2 states, the fold
counts, the stats numbers (`raised: 5`, `new: 3`, `carried: 1`, `accepted: 1`, `dismissedByAgents: 2`)
and the calibration goal opening at the second dismissal.

## Findings

### B1 (blocker, NEW): fix 2 sends an agreeing disposition into the state check, so it can now refuse records RL-2 accepted

**Where:** Fixes, item 2; AC-06.

Today `submitReview` checks in this order:
1. `may_set`
2. `until`
3. listed twice
4. not in the run's record
5. **person precedence** (ignored)
6. state check against `consumes` (422)

Precedence comes before the state check on purpose. RL-2 AC-14 says: "precedence before the state
check: no 409/422 for A although A is `dismissed`". Fix 2 now applies an agreeing disposition instead
of ignoring it. That sends it to the `else` branch, which runs the state check. A person moves the
item to the state named by the disposition, so the agreeing agent passes the check only when its
`consumes` includes that state.

Example: a person dismisses A in the debrief. A later agent stage with `consumes: [open]` restates A
`dismissed`. RL-2 recorded `ignored`; under fix 2 the same record gets **422**
`item A is dismissed; … acts on open`, and the step cannot close.

The same thing happens for `confirmed` restated by a validator-like stage. The spec does not state
this change, Compatibility does not list it, and AC-06 only tests the filer case, where the check
happens to pass (`consumes: [accepted]`). This is a wrong decision as written, because it reverses an
RL-2 contract without saying so.

**Required:** state what happens to an agreeing disposition whose item state is not in the stage's
`consumes`. The conservative reading keeps RL-2: apply it only when the row's state is in `consumes`,
else put it in `ignored` with the RL-2 reason. Add that case to AC-06: an agent stage with
`consumes: [open]` restating a person's `dismissed` gives `ignored`, no 422, and A is unchanged.

### Suggestions (all NEW)

**S1. AC-06 does not name the filer's `may_set`.** "The same record with A `dismissed` → `ignored`"
holds only when the filer's `may_set` includes `dismissed`. The `may_set` check runs first. With the
AC-17 filer (`may_set: [accepted]`), the outcome is a 422 `may not set dismissed`, not `ignored`. A
blind test-writer could pick either policy. Name the step policy in AC-06, for example
`consumes: [accepted]`, `may_set: [accepted, dismissed]`.

**S2. One finding can count twice.** "Counted dismissal" is defined per history entry. Two cases
would add two counted dismissals for the same `(goal, lineage, fp)` against the raiser, bringing
calibration forward:
- an agent dismissal followed by a person's dismissal in the same goal (a debrief with
  `consumes` including `dismissed`). AC-09 already builds this case, but only for `reinstated`;
- an agreeing agent dismissal after a person's dismissal under fix 2.

State the rule explicitly. Counting once per `(goal, lineage, fp)` looks closer to "dismissals per
raising agent". Then pin it in AC-09 (`dismissedByAgents`/`dismissedByPeople`/`uncalibrated` in that
case) and in AC-10.

**S3. Reverts are handled differently across fields.** Counted dismissals exclude a reverted entry.
`accepted` and `reinstated` count any `accepted`/person disposition entry, even one later reverted
from the UI. The RL-4 revert targets exactly these person debrief decisions. Say whether a reverted
entry counts toward `accepted` and `reinstated` (conservative reading: it does not), and add one case
to AC-08 or AC-09.

**S4. Blind-test precision of stats ordering and web order.**
- `lastAt` is "the newest time among the entries counted above". It does not say whether that
  includes counted dismissals outside the window (they feed `uncalibrated`, `calibrating` and
  `calibrated`). For `reinstated`, it does not say whether the time is the dismissal's or the
  person's entry's. AC-08 asserts the order by `lastAt` with `days=1`, so the two readings give
  different orders.
- In the web, "copy order" across a group's `versions[].copies[]` should say "versions in reply
  order, then copies in order".

**S5. Calibrator when nothing resolves.** The calibrator rules need "an existing user". Rule 3 (the
owner of the goal of the newest dismissal) may also not resolve, the same way a pulse owner can leave
(pulses pause then). Say what the trigger does in that case: for example, no goal and an event, with
a retry at the next trigger.

**S6. Two trigger rules have no criterion.** "Hash `""` never triggers" and "a revert never
triggers" are not tested. AC-10 covers a reverted dismissal not being counted, but not that the
revert itself opens nothing. Add a case to AC-10: a hash-less agent (decider without `hash`) gets 3
dismissals → no goal, and stats show `hash: ""` with `uncalibrated: 3`.

**S7. Store queries are not named.** The stats route and the trigger read across all lineages:
- review records by decider,
- disposition and revert entries by their raising record,
- headless rounds by `telemetry.agentKey`.

`HubStore` has no such queries today: `listReviews` and `listDispositions` filter by
step/lineage/fp, and `listSteps` by goal. That leaves two options:
- The trigger scans every goal's steps, every review and all item history inside each dismissal's
  `goalTx`.
- The developer adds store methods, but the spec gives them no contract criterion on the SQLite leg
  (Postgres leg in CI).

Name the reads. If new `HubStore` methods are intended, add them to the contracts and give them a
store-contract criterion, which the "HubStore/hub-copy checks" surface already names.

**S8. All goal-done paths.** A goal becomes `done` in several places in `service.ts`:
- step done (around line 2518),
- gate decide (around line 2574),
- resume (around line 2610),
- `applyApproved`/replan (around line 2238).

"When a calibration goal becomes done" should name a single hook that covers every path. AC-13 only
covers the step-done path. Add one case where a replan drops the `calibrate` step. That also tests
`outcome: "none"`.

**S9. AC-12 surface.** "and mesh_context in the step's session" is listed under surface "World (hub
API)" only. Either drop the clause or name the daemon/MCP surface it is shown on.

**S10. Activity text for the new events.** `describe()` in `service.ts` falls back to
`calibration opened <subject>`. Consider adding explicit texts for `calibration.opened` and
`calibration.done` next to the `docs/events.md` rows, or say the fallback is intended.

**S11. Scope: the `topic` copy fix.** It is a real data-loss bug and the fix is small, but it is not
part of the S6 row. Keep it, but ship it as a separate commit with its own changelog line, so it can
be picked or reverted on its own.

## Not raised

- Fixes 1 and 2 are beyond §5.8–5.10, but they follow from the §10 whole-programme acceptance that S6
  owns, and the spec records them in Open questions. I do not count them as scope creep.
- Using a repo relay instead of the built-in `audit-relay` in AC-17 deviates from §10. RL-4 kept
  the built-in agent-only, and the spec records the deviation in Open questions.
- Privacy: the event payloads carry no content, and the stats route only aggregates data that the
  goal APIs already show to members. This matches the "goals are team-visible" rule and REQ-4. The
  route is GET, so idempotency does not apply. The trigger runs inside the transaction of the request
  that recorded the dismissal, so an idempotent replay re-applies nothing.
- The `days` and key validation texts, the route entry (`member`, `goals:read`, `goals`) and the
  OpenAPI regeneration fit the existing route table tests in `test/schemas.test.ts`.
