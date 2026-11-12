Verdict: CHANGES REQUESTED | Round: 3 | Blocking-open: 2

# Review of the RL-6 spec, round 3

This is a cold review of `docs/specs/RL-6.md` as revised in b88b3e0 on feat/relay-design. I checked it
against `docs/analysis/2026-11-12-pulse-relay-roster.md` (§5.3, §5.8-§5.10, §9 S6, §10), the round 1 and
round 2 reviews (`r1-changes-requested.md`, `r2-changes-requested.md`, read in that order), and the code
on feat/relay-design. The revision changed only the "listed dismissal reverted later" rule, AC-10,
AC-13 and one Open questions entry (`git diff 15d8b4f b88b3e0`).

## Checks

This was a spec review, so no product code changed. I read the code and ran no build or test command.

Not run: `pnpm lint`, `pnpm typecheck`, `pnpm boundaries`, `pnpm test`, `pnpm build`, `pnpm check`,
`pnpm schemas`, `pnpm test:web`. The Postgres legs of the store contract were also not run
(`MESH_TEST_PG_URL` is unset; CI runs them).

What I checked in the code:
- `validatePolicies` (`src/core/policy.ts:41-93`) and `runOf`/`isRaising` (`src/core/review.ts:124`).
  A step with `consumes` needs a raising step (`output: review-record`, no `consumes`) among its deps,
  and `when` needs `consumes`.
- `proposePlan`, `approvePlan` and `applyApproved` (`src/hub/service.ts` around 2120-2245), and
  `goalComplete` (around 979). `materialize` (`src/core/dag.ts` around 175-205) drops a step that is
  missing from the new plan unless it is `done` or `dropped`.
- `disposeStep` and `revertDisposition` (around 1444-1540). A revert applies only to a
  `debrief-session` disposition while it is the item's latest change, and it emits `item.reverted`
  (around 1529-1536). A person may replace their own decision in the same step and round (`own`,
  around 1471).

## Status of round 2 findings

| R2 | Status |
|---|---|
| B1 (AC-10 revert case, reverted listed dismissal) | Fixed in substance. AC-10 is reordered so it can pass, the rule for a listed dismissal reverted later is stated, and AC-13 pins it. The wording "emits nothing" / "no event" is new and contradicts RL-4, see B2. |
| B2 (AC-13 replan plan) | Not fixed. The named plan is refused by the hub, see B1. |
| S1 (match key of a listed ref) | Open (REPEAT). |
| S2 (`reinstated` after a reverted reinstatement) | Open (REPEAT). |
| S3 (change of mind inside one debrief round) | Open (REPEAT). |

## Findings

### B1 (blocker, REGRESSION-OF-OWN-REPAIR): the AC-13 replan plan fails `validatePolicies`, and no approved plan can finish a calibration goal

**Where:** AC-13, "Replan path"; Calibration trigger, **Done** ("plan approve/replan").

AC-13 now names the plan: its only step is `recheck` (`kind: review`, `consumes: [open]`,
`when: {open: true}`). `proposePlan` runs `validatePolicies` on it. `src/core/policy.ts:91` then adds
`step "recheck": consumes needs an earlier step with output: review-record that raises items (through deps)`,
because `recheck` has no deps. So the proposal gets **422**, and the case cannot pass. The writer took
this plan from my round 2 "Required" example, so the error started in that review. The repair still
regressed, though, and it has to be fixed here.

The approve path cannot be rescued with another plan either:
- Only a step with `when` can be `skipped` at settle.
- `when` needs `consumes`, and `consumes` needs a raising dep.
- A raising step has no `consumes`, so it has no `when`. After approval it is `ready` or `blocked`,
  never `done` or `skipped`.
- The one raising step that could already be `done` is `calibrate`. But once `calibrate` is done the
  goal is already `done`, and `proposePlan` then answers 409.

So for a calibration goal, `applyApproved` never completes the goal. The hook text may still name that
path, because the code is shared. AC-13 must not claim to prove it.

**Required:** change the AC-13 replan case to a plan that can pass. For example:
1. Plan v2 has one step `recheck` (`kind: review`, the goal's repo, no `consumes`/`when`).
2. On approval, `calibrate` is `dropped` and `recheck` is `ready`, and the goal stays `in_progress`.
3. The calibrator claims `recheck` and marks it done. The goal becomes `done` (`goal.done`), and
   `calibration.done` has `dismissals: 3` and `outcome: "none"`, because `calibrate` has no review
   record. Its 3 dismissals are `calibrated`.

Also drop "approves … → on approval settle marks `recheck` `skipped` and the goal `done`". Add a line to
Open questions saying that no approved plan completes a calibration goal, so the approve path is not
proven for it.

### B2 (blocker, REGRESSION-OF-OWN-REPAIR): "the revert emits nothing" contradicts RL-4's `item.reverted`

**Where:** Calibration trigger, "A listed dismissal reverted later" ("The revert emits nothing");
AC-10 ("one `mesh_dispose` dismissal reverted (no event)"); AC-13 ("that one reverted → no event").

`revertDisposition` emits `item.reverted` (`src/hub/service.ts` around 1529). Read literally, the new
contract sentence removes that RL-4 event, and that would be a wrong decision. A blind test-writer who
reads "(no event)" will assert that the event list does not grow after the revert. That test fails
against a correct implementation, which still emits `item.reverted`. The intended meaning is clearly
"no `calibration.*` event and no goal change". The text has to say that, because the two criteria are
the only place the rule is tested.

**Required:** in all three places, say "emits no `calibration.opened`/`calibration.done` event (the
RL-4 `item.reverted` is still emitted)". In AC-10 and AC-13, also assert that `item.reverted` is
emitted, so that a criterion would fail if the event were dropped.

### Suggestions

**S1 (REPEAT of R2 S1). Match key of a listed ref.** This matters more now that the reverted-listed
rule exists. Suppose the reverted entry was the counted dismissal of its `(goal, lineage, fp)`, and a
later non-reverted dismissal of the same fp in that goal exists. That later entry becomes the counted
dismissal, with another `step`/`round`/`at`. Matching on the full ref puts it in `uncalibrated`.
Matching on `(goal, lineage, fp)` puts it in `calibrating`. Name the key. The conservative choice is the
full `DismissalRef`.

**S2 (REPEAT of R2 S2). `reinstated` after a reverted reinstatement.** Line 141 still says "whose next
disposition entry … is non-reverted". When a person re-accepts after the revert, the reinstatement is
lost. Say "the next non-reverted disposition entry", or record in Open questions that this is intended.

**S3 (REPEAT of R2 S3). A change of mind inside one debrief round.** `disposeStep` writes a new entry
when a person replaces their own decision in the same round (`own`, around line 1471). It is not a
revert. A dismissal followed by an acceptance in the same round therefore stays a counted dismissal.
Say whether that is intended. The conservative reading counts it no more than a revert.

## Not raised

- Fix 2, the stats route (`member`/`goals:read`/`goals`), its validation texts, the OpenAPI
  regeneration (AC-07, AC-16) and the route table test in `test/schemas.test.ts` are unchanged since
  round 2 and still fit the code.
- Stores: no new `HubStore` method and no migration (`SCHEMA_VERSION` 11). The SQLite leg covers the
  reads. The Postgres legs are CI-only and were not run here. The `topic` copy fix stays a separate
  commit.
- Idempotency and authorization: the trigger runs inside the transaction of the recording request, and
  the revert is limited to the decider, the goal owner or an admin as in RL-4. Privacy: the event
  payloads carry no content, and stats aggregate team-visible goal data.
- Scope: the revision adds no surface beyond the S6 row. No team-, company- or person-specific name
  appears.
