Verdict: CHANGES REQUESTED | Round: 1 | Blocking-open: 1

# Diff review of RL-19, round 1

Cold review of commit `fd79cdc` (branch `spec/RL-19`) against `docs/specs/RL-19.md` (approved in
round 2, revision 3), `reviews/RL-19/r1-changes-requested.md`, `reviews/RL-19/r2-approved.md` and
`plans/RL-19-impl-plan.md` / `plans/RL-19-test-plan.md`.

What I ran on a scratch worktree of `fd79cdc` (detached, removed afterwards; nothing was run in this
worktree):

- `vitest run test/rollup-hub.test.ts test/rollup-cli.test.ts test/docs-rl19.test.ts
  src/core/presets.test.ts src/store/hub-store.contract.test.ts test/schemas.test.ts
  test/health-hub.test.ts test/m46-ops.test.ts` with `MESH_TEST_PG_URL` set: 8 files, 312 tests
  pass. The AC-10 contract tests ran on both SQLite and Postgres (6 of 6 pass, none skipped).
- `tsc --noEmit -p .`: clean.
- `node scripts/schemas.ts`: `schemas/*` and `skills/mesh/SKILL.md` unchanged (sha256 before and after).
- 31 mutations of the code under review (table at the end): 25 caught, 6 survived. One survivor is
  a gap in an acceptance criterion's own failing state (finding 1); the others are behaviours the
  spec states but no criterion names (findings 2 to 4) or an equivalent mutant.

## Contracts checked and found correct

- **Row key and rows** (`src/hub/service.ts:4535-4552`): one row per selected lineage at
  `(preset, lineageRepo)`, plus one per `(preset, targetRepo(item))` for items in `open`,
  `confirmed` or `accepted`; `contributing` takes the lineage in both cases; dismissed, deferred and
  resolved items are skipped. The preset is the text before the first `|`.
- **Counted records** (`service.ts:4505-4512`): one `listReviews({raising: true, since})`; a record
  whose goal is missing, a calibration goal or a spot-check goal is skipped; a trial goal is skipped
  unless `trial=include`; complete and partial records alike; `r.at > now` is dropped (the window's
  upper end).
- **Home/source lineages** (`service.ts:4558-4565`): home = contributing lineages whose lineage repo
  is the row repo, else all contributing; newest = largest `at`, then later insertion
  (`order` is the index in `listReviews` order).
- **kind** from `presetKind(goal.preset.text)` of the newest source record's goal (`:4578`);
  **pulse** from the first source record (newest first) whose goal's `refs.pulse` is in
  `listPulses({})`, which already leaves out deleted pulses (`hub-store.ts:1208`) (`:4581-4587`);
  **latestReport** the newest `report` by `createdAt`, then `id`, over every step of the source
  records, pruned included, with `pruned: true` only when `prunedAt` is set (`:4589-4616`).
- **Window** `since = now − days·86 400 000`, `until = now`; `days` validated by `^\d{1,3}$` and
  1-365; `trial` exclude/include; the 400 texts match the spec's table exactly.
- **Filters** apply to built rows (`:4553`); **order** `repo`, then `preset`, binary (`cmp`).
- **One transaction**, fixed reads: `listGoals`, `listPulses({})`, `listReviews`, `listItemsIn`,
  `listArtifacts({steps})`; no write.
- **Store** (`src/store/hub-store.ts`): `listReviews` `since` → `created_at >= ?` (`created_at` is
  `v.at`, `:1007`); `listItemsIn` chunks of 500 on the primary key, merged and sorted by lineage then
  fp; `listArtifacts({steps})` chunks of 500, other filters kept, merged and sorted by `createdAt`,
  then `id` (the `extra` placeholders are first in both `where` and `args`, `:945`).
- **Route** (`src/hub/app.ts:285-292`): `member`, scope `goals:read`, not wrapped in `forPerson`, so
  `actingFor(..., {allowed: false})` gives the 400 for `x-mesh-on-behalf-of`. `HUB_FEATURES` gains
  `findings-rollup` in sorted place; `BySeverity` exported (type and schema).
- **Preset kind** (`src/core/presets.ts`): `PRESET_KIND_RE`; `parsePreset` keeps a valid kind and
  drops an invalid one without throwing; `presetText` writes it after `description`; `presetKind`
  never throws. Hub 422 only for a preset sent in the request (create, update with `preset`, ingest);
  a params-only update does not re-check the kind (`service.ts:3698`).
- **CLI**: `findPresetSource` refuses a bad kind before parsing; `mesh pulse add`/`update` wrap it in
  `Usage` (exit 2, `pulse-commands.ts:44-48`); `mesh preset ls` lists the file as `invalid: …`.
- **Docs and constraints**: concepts `### Findings roll-up` inside `## Pulse health`;
  scheduled-reviews paragraph in `## Read the results` and `kind:` in `### Your own relay in
  .mesh/presets`; the operations sentence verbatim before `0.1.23 has no release package.`, the
  feature list in order with 0.1.38; the API table row; the OpenAPI route under tag `analysis`.
  No cost field in `RollupRow`, `RollupReport` or the generated schema; no composite score; no
  company or team name in the docs; release written 0.1.38; no migration, `SCHEMA_VERSION` and
  `package.json` untouched.

## Findings

### 1. BLOCKING: AC-10's `listArtifacts({steps})` test never checks the order across chunks

`src/store/hub-store.contract.test.ts:1649-1651`. The "more than 500 steps" case passes 1100
`G<i>.s` steps plus `G2.audit`, but the only artifacts that match are `a-far` (`G1099.s`) and the two
of `G2.audit`, and both steps fall in the **third** chunk (indexes 1000-1100). So every hit comes from
one SQL query that is already `ORDER BY created_at, id`, and the merge sort in `listArtifacts`
(`src/store/hub-store.ts:928`) is never exercised. Mutation M9 (return the chunks concatenated, no
sort) passes all 172 contract tests on both stores.

AC-10's failing state is "a missing or extra row, **another order**, or an error past 500", with
"ordered by `createdAt`, then `id` (also with more than 500 steps)". The `listItemsIn` test next to
it does this right (reversed input so hits land in three chunks, `:1622-1625`, and M6 is caught).

Fix (test only): put matches in two different chunks in an order the concatenation gets wrong, e.g.
an artifact on `G0.s` (first chunk) with `createdAt` `T0 + 5`, and keep `a-far` on `G1099.s` (third
chunk) at `T0 - 1`; expect `["a-far", "a-A", "a-B", "a-G0"]`. The code itself is correct.

### 2. non-blocking: the AC-07 "a filter never changes a row's counts" check cannot see the classic bug

`test/rollup-hub.test.ts:225-227` compares filtered rows to unfiltered ones in the main World, where
no item is retargeted, so every item's target repo equals its lineage repo. Mutation M28b (drop the
lineages whose lineage repo is not `repo=` before building rows: the `params.repo`-style filter that
the spec explicitly rules out) passes. The AC's own fixture (as approved) has no retargeted item, so
this is not a gap against the criterion's text, but one assertion in `test_AC04_target_repo_and_retarget`
would close it: `rowsOf(k, "?repo=beta")` equals the unfiltered beta row (`lineages` 2, `open`
{S2:1, S3:1}).

### 3. non-blocking: three spec rules have no test (no criterion names them)

Each mutation below passes all tests; the code is correct by reading, the spec states the rule, and
no AC asks for it. Worth one assertion each if cheap:

- **Pulse that exists and is not deleted** (`service.ts:4583`): M11 (`livePulses.has(p)` dropped)
  survives. A deleted pulse whose run is the newest source record would show it.
- **Newest source record tie on `at`** broken by later insertion (`service.ts:4563`): M15 (reversed)
  survives.
- **`latestReport` tie on `createdAt`** broken by larger `id` (`service.ts:4591`): M29 (smaller id)
  survives.
- **`kind` from the newest source record's goal** (`service.ts:4578`): M24 (oldest record's goal)
  survives, because every goal of a preset in the tests has the same text. A pulse update that
  changes `kind` between two runs would test it.

### 4. non-blocking: the implementation commit edits the approved spec

`docs/specs/RL-19.md:177-179` and AC-12 change `mesh preset ls` from "prints `  ! kind must match …`
after a preset's line" to "lists such a file as `invalid: kind must match …`". The new behaviour is
the better one (it reuses the existing `invalid:` path, and round 2's suggestion 3 only asked that the
file not be shown as valid), and the code and test (`test_AC12_preset_ls`) match the edited text. But
the `## Status` section still says revision 3; note the change there (revision 4, implementation
amendment) so the record of what was approved stays honest.

### 5. non-blocking: smaller deviations and test-plan drift

- `presetKindProblem` takes the preset **text** (`src/core/presets.ts:192`), not a parsed document
  as the spec's *Preset kind* bullet says (`presetKindProblem(doc)`). Behaviour is the same and the
  text form is what every caller has; align the spec wording or the signature.
- `plans/RL-19-test-plan.md` lists `test_AC08_no_preset_goal` and `test_AC09_features`; neither
  exists. The preset `-` / no-kind check is in `test_AC05_window` (`rollup-hub.test.ts:354`) and the
  feature check is inside `test_AC09_scopes_on_behalf_no_writes` (`:262-264`). Update the plan or
  split the tests so each AC has its named test.
- AC-12's "the hub's roll-up row of that preset has `kind` `code-audit` once it runs" and "a pulse
  update with only `params` on a seeded snapshot with an invalid `kind` → 200" are tested under AC-08
  names (`test_AC08_stored_invalid_kind_fires_and_updates`, and the hub kind in `test_AC01`), not
  from the CLI path. Acceptable, but no `test_AC12_*` covers them.
- The spec's exit 1 for `mesh goal new --preset` and the relay start with a bad kind is not tested
  (only `mesh pulse add` exit 2 is).
- `test_AC06_calibration_and_spot_check_goals` seeds the calibration and spot-check records with
  `store.addReview` instead of submitting them through the steps; it still catches M4.

## Mutations run (scratch worktree of `fd79cdc`)

| # | Mutation | Tests run | Caught by |
|---|---|---|---|
| M1 | count items under the lineage repo instead of the target repo | rollup-hub | test_AC04 |
| M2 | drop the home-lineage preference (source = all contributing) | rollup-hub | test_AC04 |
| M3 | trial records' steps feed `latestReport` with `trial=exclude` | rollup-hub | AC01, AC02, AC03, AC04, AC07 |
| M4 | drop the calibration/spot-check exclusion | rollup-hub | test_AC06_calibration_and_spot_check_goals |
| M5 | `open` excludes `confirmed` | rollup-hub | test_AC01 |
| M6 | `listItemsIn` without the merge sort | contract (SQLite, Postgres) | test_AC10_listItemsIn (both) |
| M7 | `parsePreset` throws on an invalid kind | presets, rollup-hub | test_AC08_parse_and_text, test_AC08_stored_invalid_kind_fires_and_updates |
| M8 | remove the kind check in `findPresetSource` | rollup-cli | test_AC12_pulse_add_bad_kind |
| M9 | `listArtifacts({steps})` without the merge sort | contract (SQLite, Postgres) | **not caught** (finding 1) |
| M10 | `listReviews` `since` exclusive (`>`) | contract, rollup-hub | test_AC10_listReviews_since (both), test_AC05 |
| M11 | `pulse` ignores whether the pulse exists / is deleted | rollup-hub | not caught (finding 3; no AC) |
| M12 | no kind check on pulse create | rollup-hub | test_AC08_pulse_create_kind |
| M13 | kind re-checked on a params-only update | rollup-hub | test_AC08_stored_invalid_kind_fires_and_updates |
| M14 | `latestReport` picks the oldest | rollup-hub | AC02, AC03, AC06_trial |
| M15 | newest-record tie on `at` reversed | rollup-hub | not caught (finding 3; no AC) |
| M16 | `days` regex dropped (`Number(days)`) | rollup-hub | test_AC07_400s |
| M17 | route wrapped in `forPerson` | rollup-hub | test_AC09_scopes_on_behalf_no_writes |
| M18 | `mesh preset ls` kind check removed | rollup-cli | test_AC12_preset_ls |
| M19 | `presetText` drops `kind` | presets, rollup-cli | test_AC08_parse_and_text, test_AC12_pulse_add_kind_sent |
| M20 | `lineages` counts only lineage-repo contributions | rollup-hub | test_AC04 |
| M21 | dismissed (and other) states counted as accepted | rollup-hub | test_AC01 |
| M22 | `pruned` flag dropped | rollup-hub | test_AC02 |
| M23 | trial records counted with `trial=exclude` | rollup-hub | AC01, AC03, AC06_trial, AC07 |
| M24 | `kind` from the oldest source record's goal | rollup-hub | not caught (finding 3; no AC) |
| M25 | no kind check on ingest | rollup-hub | test_AC08_pulse_create_kind |
| M26 | window `since` off by one (+1 ms) | rollup-hub | test_AC05, test_AC01, test_AC07_400s |
| M27 | rows ordered by preset, then repo | rollup-hub | test_AC01 |
| M28 | `repo=` filter applied to items by target repo before rows | rollup-hub | not caught: equivalent mutant (a row's items already have that target repo) |
| M28b | `repo=` filter applied to lineages by lineage repo before rows | rollup-hub | not caught (finding 2) |
| M29 | `latestReport` tie on `createdAt` picks the smaller id | rollup-hub | not caught (finding 3; no AC) |
| M30 | window ignores `days` (always 30) | rollup-hub | test_AC05, test_AC07_400s |
| M31 | `presetKind` returns an invalid kind | presets, rollup-hub | test_AC08_presetKind, test_AC08_stored_invalid_kind_fires_and_updates |

## To approve

Fix finding 1 (one test change in `test_AC10_listArtifacts_steps`, so its >500-steps case has
matches in two chunks in an order plain concatenation gets wrong). Findings 2-5 are suggestions.
