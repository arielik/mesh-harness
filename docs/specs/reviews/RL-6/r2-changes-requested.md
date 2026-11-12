Verdict: CHANGES REQUESTED | Round: 2 | Blocking-open: 2

# Review of the RL-6 spec, round 2

This is a cold review of `docs/specs/RL-6.md` as revised in 402123c on feat/relay-design. I checked it
against `docs/analysis/2026-11-12-pulse-relay-roster.md` (§5.3, §5.6, §5.8-§5.10, §9 S6, §10), the round 1
review (`r1-changes-requested.md`) and the code on feat/relay-design.

## Checks

This was a spec review, so no product code changed. I read the code and ran no build or test command.

Not run: `pnpm lint`, `pnpm typecheck`, `pnpm boundaries`, `pnpm test`, `pnpm build`, `pnpm check`,
`pnpm schemas`, `pnpm test:web`. The Postgres legs of the store contract were also not run
(`MESH_TEST_PG_URL` is unset; CI runs them).

What I checked in the code:
- `submitReview` (`src/hub/service.ts` around 990-1050): the check order is `may_set`, `until`, listed
  twice, not in the run's record, then precedence (latest disposition of the fp in the goal), then the
  state check. Revised fix 2 changes only the precedence step and keeps the state check, as the spec says.
- `disposeStep` and `revertDisposition` (around 1444-1530). A revert applies only to a
  `debrief-session` (person) disposition, and only while it is the item's latest change. Inside one
  debrief round, a person may change their mind with a new disposition entry; that is not a revert.
- `applyApproved` and `goalComplete` (around 979, 2216-2240), and `validateDag` in `src/core/dag.ts`.
  A plan needs at least one step (`a plan needs at least one step`). `goalComplete` needs a non-design
  step, and every step `done`, `skipped` or `dropped`.
- `goalTx` calls `HubStore.serialize()` before its first read, so it serialises every goal
  transaction, not one goal's. The "Several replicas" open question holds, and two replicas cannot
  open two calibration goals for one agent hash.
- `HubStore.listReviews`, `listDispositions`, `itemHistory`, `listSteps`, `listGoals`,
  `listCatalogSources`, `listCatalogDefs` exist with the filters the "Reads" paragraph uses.
  `INPUT_KEYWORDS` is in `src/core/policy.ts`. `CatalogSource.calibrator` is in `src/protocol/roster.ts`.
  The web Roster renders `section.roster-group` with `versions[].copies[]`.
- AC-17 again, step by step under the revised rules. Counted dismissals of `alpha/auditor`: B in G1
  (checker) and C in G2 (checker) → 2 = threshold → one goal at `G2.validate`. B carried in G2 adds no
  entry. Fix 1 skips `G2.file` (A filed). `G2.debrief` has no `open`/`confirmed` item → skipped. Rule 2
  gives `ann`. The stats numbers hold.

## Status of round 1 findings

| R1 | Status |
|---|---|
| B1 (agreeing disposition vs state check) | Fixed. The state check is kept, and AC-06 has the `consumes: [open]` case. |
| S1 (AC-06 `may_set`) | Fixed. |
| S2 (one finding counted twice) | Fixed. Counting is once per `(goal, lineage, fp)`, pinned in AC-09. |
| S3 (reverts across fields) | Fixed for `accepted` and `reinstated`. See S2 below for a gap. |
| S4 (`lastAt`, web order) | Fixed. |
| S5 (no calibrator) | Fixed: no goal, no event, retried at the next trigger. |
| S6 (hash `""` / revert untested) | The hash-less case is fixed. The revert case regressed, see B1. |
| S7 (store reads) | Fixed. The reads are named, and the no-new-methods decision is recorded. |
| S8 (all done paths) | The hook is fixed. The AC-13 replan case regressed, see B2. |
| S9 (AC-12 surface) | Fixed (the `mesh_context` clause was dropped). |
| S10 (activity texts) | Fixed. |
| S11 (`topic` fix as its own commit) | Fixed. |

## Findings

### B1 (blocker, REGRESSION-OF-OWN-REPAIR): AC-10's revert case contradicts the trigger, and a reverted listed dismissal is undefined

**Where:** AC-10 ("three dismissals with the 3rd reverted → no goal, no `calibration.opened`");
Calibration trigger, **When**.

The trigger runs "in the same transaction, after the hub records a dismissal", and that includes
`mesh_dispose`. Only a person's `debrief-session` disposition can be reverted (`revertDisposition`), so
the 3rd dismissal in this case must be a `mesh_dispose`. When it is recorded, `uncalibrated` is 3 ≥ 3,
and a correct implementation opens the goal and emits `calibration.opened` at that moment. The later
revert cannot undo that. The case as written therefore fails against the spec's own contract. Round 1's
version ("two dismissals + one reverted") could be ordered so it worked (revert first, then two more).
The repair fixed the order on the one that cannot work.

It also exposes a gap. The spec does not say what happens to an open calibration goal when one of its
listed dismissals is reverted afterwards. Should the goal stay open? Is the ref still `calibrating`
(it is no longer a counted dismissal)? Does `calibration.done` report `dismissals: n` with the old `n`?

**Required:**
- Reorder the AC-10 case so it can pass. For example: one `mesh_dispose` dismissal, reverted; then two
  more dismissals → no goal (`uncalibrated: 2`); a 4th → goal with 3 refs, none of them the reverted
  one; and the revert itself emits nothing.
- State the rule for a listed dismissal that is reverted later. The conservative reading: the goal
  stays open, the reverted ref counts in no bucket, the goal's `calibration.dismissals` is unchanged,
  and `calibration.done` reports `n` = the listed refs. Pin it with one case, for example in AC-13.
- Alternatively, decide that a `debrief-session` dismissal triggers only when its debrief step is done.
  Then state that and test it instead.

### B2 (blocker, REGRESSION-OF-OWN-REPAIR): AC-13's replan case asks for a plan the hub refuses

**Where:** AC-13 ("the calibrator proposes and approves a plan for an open calibration goal that drops
the `calibrate` step → goal `done`").

`validateDag` refuses a plan with no steps (`a plan needs at least one step`, `src/core/dag.ts:29`).
A calibration goal has exactly one step, so a plan that drops `calibrate` must hold another step. That
step is `ready` after approval, so the goal is not `done` on approval, and the case cannot pass as
written. A blind test-writer has to invent the plan, and the invented plan decides which done path the
test proves (approve vs step done). The point of the case (round 1 S8) is the approve/replan path.

**Required:** name the plan. For example: the new plan replaces `calibrate` with one `review` step with
`consumes: [open]` and `when: {open: true}` in a lineage without items. Settle marks it `skipped`, so
`applyApproved` sets the goal `done` and emits `goal.done`. Then `calibration.done` has
`outcome: "none"` and the 3 dismissals are `calibrated`. Alternatively, say the replan case goes
through the replacement step's done, and drop "approve" from the paths this case proves.

### Suggestions (all NEW)

**S1. Which refs a calibration goal "lists".** A counted dismissal is calibrating or calibrated "when a
calibration goal lists it", but the spec does not say how a counted dismissal is matched against
`GoalCalibration.dismissals`. If the earliest dismissal of a `(goal, lineage, fp)` is reverted, a later
one becomes the counted dismissal, with another `step`/`round`/`at`. Matching on all `DismissalRef`
fields and matching on `(goal, lineage, fp)` give different buckets. Name the match key. The
conservative choice is the full ref, because the ref then names exactly the entry the calibrator saw.

**S2. `reinstated` after a reverted reinstatement.** "Whose next disposition entry … is non-reverted"
means that if a person's acceptance is reverted and the person accepts again, the reinstatement is lost
(the next entry is the reverted one). That reads as unintended. Say "the next non-reverted disposition
entry". Then add the re-accept to the AC-09 revert case (`reinstated` back to 1).

**S3. A change of mind inside one debrief round.** `disposeStep` lets a person replace their own
decision in the same round with a new entry, not a revert. A person who dismisses A with `mesh_dispose`
and then accepts it in the same round leaves a non-reverted dismissal entry. That entry is counted
against the raiser and may already have opened a goal. Say whether a `debrief-session` dismissal
superseded by the same step and round counts. The conservative reading: it does not count, the same as
a revert. Whatever the rule is, the B1 rule for listed refs covers the goal that may already be open.

## Not raised

- Fix 2 as revised keeps every RL-2 check and only widens precedence. The Compatibility line is
  accurate, and AC-06 now covers applied, ignored-different, ignored-state and person-not-overridden.
- Scope: fixes 1 and 2 come from §10's whole-programme acceptance. The `topic` fix is now a separate
  commit. No new CLI, TUI, migration or store method is added. Nothing goes beyond the S6 row.
- Authorization and privacy: the stats route is `member`/`goals:read`/`goals`, aggregates only data the
  goal APIs show to members, and its event payloads carry no content. Idempotency: the route is GET, and
  the trigger runs inside the recording request's transaction.
- OpenAPI: the route table entry and the regeneration are named in AC-07 and AC-16, and fit
  `test/schemas.test.ts`.
- Store legs: the Reads paragraph uses only existing methods, so the SQLite leg covers them. The
  Postgres leg is CI-only and was not run here.
