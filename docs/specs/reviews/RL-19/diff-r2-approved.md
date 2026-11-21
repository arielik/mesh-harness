Verdict: APPROVED | Round: 2 | Blocking-open: 0

# Diff review of RL-19, round 2

Cold review of commit `0fe0e2a` (the answer to `diff-r1-changes-requested.md`, which reviewed
`fd79cdc`). The commit changes tests, the spec's Status and `presetKindProblem` wording, and the test
plan; no production code.

What I ran on a scratch worktree of `0fe0e2a` (detached, `node_modules` symlinked, removed
afterwards with `git worktree remove --force`; nothing was run in this worktree):

- Baseline: `vitest run src/store/hub-store.contract.test.ts -t listArtifacts_steps` with
  `MESH_TEST_PG_URL` set: 2 passed (SQLite and Postgres), 170 skipped by the filter.
  `vitest run test/rollup-hub.test.ts`: 12 of 12 pass.
- Mutations (each applied alone, file restored after):

| # | Mutation | Tests run | Result |
|---|---|---|---|
| M9 | `listArtifacts({steps})` returns the chunks concatenated (no merge sort, `hub-store.ts:928`) | contract, SQLite + Postgres | **caught on both**: `expected ['a-late','a-far','a-A','a-B'] to strictly equal ['a-far','a-A','a-B','a-late']` |
| M11 | `pulse` ignores `livePulses` (`if (p !== undefined)`) | rollup-hub | caught: `test_AC04_target_repo_and_retarget` at `:323` (deleted pulse) |
| M11b | `listPulses({ deleted: true })` with no `deletedAt` filter (deleted pulses kept) | rollup-hub | caught: `test_AC04` at `:323` |
| M28b | lineages filtered by lineage repo `=== q.repo` before rows are built | rollup-hub | caught: `test_AC04` at `:317` (`?repo=gamma`) |
| M28c | items filtered by their lineage repo `=== q.repo` before rows are built | rollup-hub | caught: `test_AC04` at `:317` |

## Round-1 findings

### 1. BLOCKING (round 1): AC-10 `listArtifacts({steps})` never checked order across chunks: RESOLVED

`hub-store.contract.test.ts:1650-1653` adds `a-late` on `G0.s` (first chunk, `T0 + 100`) next to
`a-far` on `G1099.s` (third chunk, `T0 - 1`), so concatenation puts `a-late` first and the expected
order `["a-far", "a-A", "a-B", "a-late"]` needs the merge sort. M9 now fails on SQLite and Postgres.
(A sort without the `id` tiebreak stays an equivalent mutant: the only `createdAt` tie, `a-A`/`a-B`,
is inside one chunk, already ordered by SQL, and `Array.prototype.sort` is stable. Not a defect.)

### 2. non-blocking: filter by row repo vs lineage repo: RESOLVED

`rollup-hub.test.ts:316-318` asserts `?repo=gamma` and `?repo=alpha` return exactly the unfiltered
retargeted rows. M28b (and the item-level variant M28c) are now caught. The assertion uses `gamma`
(fed only by the alpha lineage) rather than the beta row suggested in round 1; that is the stronger
choice, since the gamma row has no lineage whose lineage repo is gamma.

### 3. non-blocking: spec rules without a test: PARTIAL

- Deleted pulse not named: RESOLVED (`:319-324`; M11 and M11b caught). The test deletes `p-2`, the
  only pulse among the beta row's home sources, and checks the row keeps its counts and has no
  `pulse` key.
- Newest-record tie on `at` (M15), `latestReport` tie on `createdAt` by larger `id` (M29) and `kind`
  from the newest source record's goal (M24): still untested. The code is correct by reading and no
  AC names them; remains a suggestion.

### 4. non-blocking: the implementation edited the approved spec: RESOLVED

`## Status` now records revision 4 (with the implementation): the `mesh preset ls` wording and
`presetKindProblem` taking the preset text.

### 5. non-blocking: smaller deviations and test-plan drift: PARTIAL

- `presetKindProblem(text)`: RESOLVED, the spec's *Preset kind* bullet now matches the signature
  ("none when the YAML does not parse").
- Test plan names: RESOLVED, AC-08 and AC-09 rows now name the tests that exist
  (`test_AC08_no_preset_goal` and `test_AC09_features` dropped, with where each check lives), and
  AC-04 lists the new assertions.
- Still open, as suggestions: no `test_AC12_*` for the hub `kind` after a CLI-added pulse runs or
  for the params-only update (covered under AC-08 names); exit 1 for `mesh goal new --preset` and
  the relay start with a bad kind untested; `test_AC06_calibration_and_spot_check_goals` seeds
  records with `store.addReview`.

## New issues in `0fe0e2a`

None. The new AC-04 assertions run after the retarget, so they reuse its fixed rows; the deletion
is the last action in the test, so it cannot affect earlier assertions. `del.status` is checked with
the response body in the message.

## To approve

Nothing blocking. Findings 3 and 5's leftovers are optional follow-ups.
