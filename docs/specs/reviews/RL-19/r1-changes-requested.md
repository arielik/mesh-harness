Verdict: CHANGES REQUESTED | Round: 1 | Blocking-open: 2

# Review of the RL-19 spec, round 1

This is a cold review of `docs/specs/RL-19.md`, revision 1 (commit 4f6d138 on `spec/RL-19`). I used
RL-12 (its closest model) and RL-11 as the format and rigor bar, then checked each claim against
the code:
- `src/hub/service.ts`: `health` (4479-4620: `days` parse, `trial`, `listReviews({raising: true})`,
  per-lineage `findings`), `actingFor` (2120-2145), `presetChecks` (3475-3517) and its callers (3574,
  3689, 3798), `createWithPlan` (3831-3868, which re-parses the stored preset text), calibration and
  spot-check goal creation (3995-4010, 5103-5118), `runReportOf` (1731-1739), `retargetItems`
  (6035-6075), the artifact prune entry (6871);
- `src/hub/app.ts`: `forPerson` (128), `/healthz` liveness (119, 134), `GET /v1/health` (278-284),
  `GET /v1/artifacts/:id` (327), `GET /v1/items` (483-493), `POST /v1/items/retarget` (496);
- `src/store/hub-store.ts`: `artifact` and `review_record`/`review_item` schemas and indexes (78-89,
  169-172), `listArtifacts` (916-933), `pruneArtifacts` (939-953), `listReviews` (1000-1021),
  `listItems` (1029-1033), `listPulses` (1168-1174), `SCHEMA_VERSION` (1555); `src/store/dialect.ts`
  (`stepOrder`: `rowid` / `ord`);
- `src/protocol/review.ts` (`ItemState`, `TargetRepo`, `StoredReview`, `ItemRow`), `goal.ts`
  (`Goal.calibration/spotCheck/trial/refs/preset`, `ArtifactKind`, `StoredArtifact`), `hub.ts`
  (`HUB_FEATURES` 760, `BySeverity` 896, `HealthFindings` 930), `hub-api.ts` (tag `analysis`, 80, 173);
- `src/core/presets.ts` (`Preset`, `parsePreset` 186-192, `presetText` 207-211, `CALIBRATE_PRESET`,
  `SPOT_CHECK_PRESET`), `src/core/finding-step.ts` (`lineageRepo`, `targetRepo` 39-48),
  `src/core/review.ts` (`lineageOf` 103, `isRaising` 153);
- `src/cli/hub-commands.ts` (`findPresetSource` 120-128, `goal new --preset` 230, relay start 282)
  and `src/cli/pulse-commands.ts` (`presetSnapshot` 42-57);
- `web/src` (routes `#/`, `#/goals`, `#/goal`, `#/mine`, `#/roster`; no artifact page);
- `test/helpers/*` (`review-kit`, `pulse-kit`, `calib-kit` incl. its `spotChecks` option,
  `health-kit`), `test/health-hub.test.ts`, `test/m46-ops.test.ts:108` (pinned feature array).

The constraints hold: no cost field anywhere in `RollupRow`/`RollupReport` (and AC-11 pins that), no
composite score (Out, line 33), names are generic (`alpha`, `beta`, `relay-a`, `p1`), the release is
written `0.1.38`, schema 12 with no migration (the reads use existing columns and indexes).

## What holds

- **Auth and on-behalf.** `member` + `goals:read`, not `forPerson`, matches `GET /v1/health`
  (app.ts:278-284); a service token with the header gets exactly `on-behalf-of is not accepted on
  this route` from `actingFor` (service.ts:2138).
- **No person-openable artifact page.** `web/src` has only the five hash routes the spec lists, and
  `GET /v1/artifacts/:id` is a `member`/`goals:read` JSON route (app.ts:327). Leaving `url` out is right.
- **Lineage and target repo.** `lineageRepo`/`targetRepo` (finding-step.ts:39-48) are exactly the
  spec's definitions; goals without a preset give `-` (`lineageOf`, review.ts:103-104); RL-10 compares
  repos as exact strings, so `(preset, target repo)` keys are well defined.
- **Calibration and spot-check exclusion is necessary.** `CALIBRATE_PRESET.calibrate` and
  `SPOT_CHECK_PRESET.check` have `output: review-record` without `consumes` (presets.ts:148-176), so
  `isRaising` is true and they submit raising records (with no items). Without the exclusion they
  would create zero rows `(calibrate, <repo>)` / `(spot-check, <repo>)`. See finding 4 for the wording.
- **Store reads.** `review_record.created_at` is the record's `at` (hub-store.ts:981-990);
  `listReviews` orders by `rowid`/`ord` = insertion order (1019, dialect.ts:56/68), so the tie rule
  "later insertion order of `listReviews`" is implementable on both stores. `review_item`'s primary
  key `(lineage, fp)` serves `lineage IN (…)`; `artifact_step_round (step, round)` serves `step IN (…)`;
  `kind` is only in the JSON value, so filtering reports in code is right. `pruneArtifacts` sets
  `prunedAt` in the value (939-953), so `pruned` needs no content read.
- **Preset `kind` on the hub side.** `parsePreset` ignores unknown top-level keys
  (presets.ts:186-191), so an older hub accepts a preset with `kind`. Leaving an invalid `kind` out
  in `parsePreset` rather than throwing is the right choice, because firing and goal creation
  re-parse stored snapshots (service.ts:3620, 3868); a throw would stop old snapshots from firing.
- **Testability.** `calib-kit` combines with `pulse-kit` as in `health-hub.test.ts`, has a settable
  clock (AC-05) and a `spotChecks` option (calib-kit.ts:78-82, AC-06's spot-check goals); pruning is
  driven through `hubStore.pruneArtifacts` in existing tests (relay-hub.test.ts:857), so AC-02's
  `pruned` is testable.

## Findings

### 1. BLOCKING: the CLI does not send the preset text as it is; `kind` only reaches the hub through a new CLI, and an invalid `kind` is silently dropped there

Spec line 195: "No daemon change: the CLI sends the preset text as it is." This is false. Every CLI
path that sends a preset parses it and re-serializes it:
- `mesh pulse add`: `presetSnapshot` sends `presetText(found.preset)` where `found` comes from
  `parsePreset` (src/cli/pulse-commands.ts:49, src/cli/hub-commands.ts:123);
- `mesh goal new --preset`: `presetText(findPreset(...))` (src/cli/hub-commands.ts:230);
- relay start with a preset: `presetText(found)` (src/cli/hub-commands.ts:282).

`presetText` today writes only `preset`, `description`, `params`, `debrief`, `steps`
(src/core/presets.ts:207-211). So:
- a CLI of 0.1.37 or older **drops `kind`** before it reaches any hub, new or old. A person who adds
  `kind:` to `.mesh/presets/x.yaml` and runs an older `mesh pulse add` gets no kind in the roll-up and
  no error. The Compatibility section (lines 192-195) and the operations sentence must say that
  `kind` needs a 0.1.38 CLI (or an API client that sends the text itself).
- with the spec's own rule ("`parsePreset` ... leaves it out otherwise", line 150) a **new** CLI also
  drops an invalid `kind: Code Audit` silently, because it re-serializes through `parsePreset` →
  `presetText`. The `presetChecks` 422 (lines 152-155) is then reachable only from API clients that
  post raw text, never from `mesh pulse add`, which is the documented way to write a preset
  (`docs/guide/scheduled-reviews.md` `### Your own relay in .mesh/presets`). AC-08's "pulse create with
  `kind: "Bad Kind"` → 422" passes through the API while the CLI user never sees the error.

Fix: state the CLI behaviour explicitly. Recommended: the CLI's preset loading (`findPresetSource`,
which only the CLI uses) rejects a top-level `kind` that does not match, with the same text
`kind must match ^[a-z][a-z0-9-]{0,39}$` (exit 2, nothing sent), while core `parsePreset` keeps
leaving it out so stored snapshots still fire. Add a CLI criterion (e.g. in `test/pulse-cli.test.ts`:
`mesh pulse add` of a repo preset with `kind: code-audit` sends a snapshot whose text contains
`kind: code-audit`; with `kind: Bad Kind` it exits 2 and sends nothing) and change line 195 and the
operations sentence to "upgrade the CLI to set `kind`; an older CLI drops it".

### 2. BLOCKING: AC-04 is not exact enough to test

AC-04 (line 209): "the (beta, relay-a) row lists the alpha lineage among its `lineages` and its
`latestReport` **may be** the alpha audit's".
- `lineages` is a number (line 102: "the number of contributing lineages"); a row cannot "list" a
  lineage. Either the field is a count (then AC-04 must give the number, e.g. `lineages: 2` = the
  beta lineage of p2 plus the alpha lineage of p1) or it is a list of lineage keys (then the type
  table must say so, and AC-01/AC-03 must assert lists, not `1`/`2`).
- "may be" cannot fail. The definition (line 106) is deterministic: the newest report over the steps
  of the counted records of both contributing lineages. AC-04 should fix the order of the p1 and p2
  runs and state the exact `latestReport`, `pulse` and `lastRaisedAt` of the (beta, relay-a) row
  (e.g. p2 runs first, p1 later → `pulse` p1, `latestReport` the alpha audit's report, `lastRaisedAt`
  p1's record). The FAIL column should then name "a wrong `lineages`, `pulse` or `latestReport` on a
  target-repo row".

### 3. non-blocking: a target-repo row takes `pulse`, `latestReport`, `lastRaisedAt` and `kind` from another repo's audit

By lines 70-72 and 100-108, the (beta, relay-a) row of AC-04 counts the alpha lineage as
contributing, so when p1 (alpha) ran after p2 (beta) the beta row names pulse **p1** and the **alpha**
audit's report. A dashboard cell "beta: latest report, pulse" then links to an audit that ran in
another repo. Consider: `pulse`, `lastRaisedAt`, `latestReport` and `kind` come from the contributing
lineages whose lineage repo equals the row repo when there is one, else from all contributing
lineages. If you keep the current rule, say it in the guide subsection (it will surprise readers),
and resolve finding 2 with the exact values.

### 4. non-blocking: the calibration/spot-check justification is inaccurate

Line 62: "those are opened by the hub and raise no findings". They do submit **raising** records
(`CALIBRATE_PRESET` and `SPOT_CHECK_PRESET` steps have `output: review-record` and no `consumes`,
presets.ts:148-176; `isRaising`, review.ts:153), only with no items. Reword to "their steps submit
raising records with no items; counting them would add zero rows `(calibrate, <repo>)`", and make
AC-06's case concrete: a calibration goal whose record is in the window → no row with preset
`calibrate` (and the same for `spot-check` with `Ck.start({spotChecks: …})`).

### 5. non-blocking: `latestReport` differs from the existing run-report rule

`runReportOf` (service.ts:1731-1739, used by debriefs) picks the report of the **highest round**, then
the last uploaded in it. RL-19 picks the newest by `createdAt` over any round (line 106). Both are
defensible and normally agree; state that the difference is intended (or reuse the round rule), so the
implementer does not "fix" one to match the other.

### 6. non-blocking: `listItemsIn` has no specified order

`listItems` orders by `fp` (hub-store.ts:1029-1033). AC-10 (line 215) checks only membership for
`listItemsIn`. Specify `ORDER BY lineage, fp` so both stores and the chunked result agree, and add the
order to AC-10, as it does for `listArtifacts({steps})`.

### 7. non-blocking: `listReviews({since})` scans `review_record`

There is no index on `review_record.created_at` (only `review_record_lineage (lineage, raising,
complete)`, hub-store.ts:86/172), and none can be added without a migration. That matches RL-12's
health read (which reads every raising record), but line 174 should say the route scans the review
records (not only "reads the raising records of the window"), so the read-cost note in the guide is
accurate.

### 8. non-blocking: `BySeverity` is not exported

`BySeverity` is a module-private `const` in `src/protocol/hub.ts:896`. "`BySeverity` is the existing
`{S1, S2, S3, S4}`" (line 82) should say whether it becomes exported or `RollupRow` reuses it in the
same file, since `RollupRow` is exported from `src/protocol/index.ts`.

### 9. non-blocking: operations wording

`docs/guide/operations.md:42` lists the features "… `trial` in 0.1.37". Say how the new name is added
(e.g. "`findings-rollup` from 0.1.38"), so AC-11's docs test checks a fixed sentence. The
`0.1.38 (RL-19)` sentence should name the scope, no migration (schema 12), and the CLI note of
finding 1. (Pre-existing and outside this spec: the 0.1.37 sentence at operations.md:99 says
"schema 11" although 0.1.36 moved the hub to schema 12; the RL-19 sentence should not copy it.)

### 10. non-blocking: small precision gaps

- AC-05 (line 210): the "item accepted yesterday ... is counted" case is visible only with `days=45`
  (the lineage is absent at the default); say so.
- Lines 59-63: records of `dropped` goals and partial-coverage records (`complete: false`) count;
  state it, since a reader will ask.
- `days` validation: `health` uses `^\d{1,2}$` (service.ts:4483); the roll-up needs up to three
  digits, and `days=` (empty) belongs in AC-07's 400 list.
- `kind` is already a step field (`kind: review`), an artifact field (`kind: report`) and a run-card
  stage field; `RollupRow.kind` next to `latestReport` (an artifact) may confuse. Optional: name it
  `presetKind` in the row, or say in the guide that it is the preset's top-level `kind`.
- Test surface (line 199): `test/helpers/health-kit.ts` (`stage`) is the kit `health-hub.test.ts`
  uses to drive stages; list it with the others.
