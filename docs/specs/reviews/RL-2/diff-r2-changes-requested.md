Verdict: CHANGES REQUESTED | Round: 2 | Blocking-open: 1

# RL-2 diff review, round 2

Diff: `git diff feat/relay-design...comb/RL-2` (head 630fd2b), against `docs/specs/RL-2.md` (revision 2
plus the developer's readings (a) to (i) in Open questions). Round 1 (`diff-r1-changes-requested.md`)
was read first. New commits since round 1: 858f2f6 (developer: revert of its test edits), f86a1d5
(developer: B1 fix), f17186c (developer: S1 fix), 439a0a3 (test-writer: tool list, AC-20 and AC-17
tests), and the combines 684f47e (impl) and 630fd2b (tests).

## Checks run

- `pnpm check` on an export of `comb/RL-2`: **fails**. lint, typecheck and boundaries pass; `pnpm
  test` fails with 7 failed, 1576 passed, 76 skipped (74 files, 2 failing); `pnpm check` stops there.
  `pnpm build` run on its own: passes. The Postgres legs were skipped (no `MESH_TEST_PG_URL`).
- Fail-first of the new tests:
  - `test_AC20_commit_never_an_option` on the round-1 head 79d3a61 (pre-fix product code): fails
    (`expected [ 'a.ts' ] to strictly equal []`: git wrote the file the agent chose). Passes on
    `comb/RL-2`.
  - `test_AC17_not_ready_on_replan_approve` and the `m2-flow` tool list on `feat/relay-design`: both
    fail. The AC-17 test passes on 79d3a61 too, as expected, because the product code was already
    right there.
- Role boundaries: `git show --stat` per new commit. The test-writer commit 439a0a3 touches tests
  only. The developer's 858f2f6 touches tests only to revert its own round-1 edits, which round 1
  asked for. f86a1d5 and f17186c touch product code and the spec's Open questions only.
- Source-text assertions: none in the new tests.
- Not run: `pnpm test:web` (Playwright, AC-28), the Postgres legs (AC-08, AC-32), `pnpm schemas` on
  its own (its output is compared by `test_AC31_openapi_routes`, which passes).

## Round-1 findings

- B1 (agent commit as a git option): **fixed**. `SAFE_REV` plus `--end-of-options` in `reviewUpload`.
  A rejected commit reads as missing. Reading (h) records this in Open questions. The test fails first.
- B2 (developer changed tests): **fixed on `impl/RL-2`**, but the combine undid the test-writer's
  edits. See R1.
- S1 (`listItems` order differs by backend): **fixed**. The store orders by `fp` on both backends,
  and `dispositionsInput` sorts with the same `byItemOrder` as `GET /v1/items`. The fold takes its rows
  as a `Map` keyed by `fp`, so their order does not matter there.
- S2 (tests that pass on the base): the requested variant `test_AC17_not_ready_on_replan_approve`
  was added and fails on the base. Whether the test-writer report lists the rest is not visible here.
- S3 (AC-28 and AC-32 not run): still open (REPEAT, suggestion). This round did not run them either.

## Blockers

### R1 (REGRESSION-OF-OWN-REPAIR, process/combine): the combine took the developer's revert over the test-writer's schema-9 edits, so 7 tests fail on `comb/RL-2`

Round 1 B2 asked the developer to revert its test edits on `impl/RL-2`. In round 1, those edits had
the same values as the test-writer's: schema 9, migration 9 and readyz 9. The developer's revert
858f2f6 set them back to 8. The combine 684f47e merged that revert into `comb/RL-2`. The merge base
already had 9 and so did the comb side, so git took the impl side's 8. That overwrote the
test-writer's values from e494fee. The result on `comb/RL-2`:

- `src/store/hub-store.contract.test.ts`: `test_AC05_schema_version_8`,
  `test_AC05_migration_lengths_equal`, `test_AC08_schema_version_8` (MM-2), `test_AC06_schema_version_8`,
  `test_AC08_version` and `test_AC08_v7_migrates` all expect 8 again and fail (lines 435, 440,
  576-578, 668-670, 769-771, 805).
- `test/m46-ops.test.ts` `test_AC05_readyz_schema_8`: expects `schema: 8` (line 74) and fails.

`test_AC08_v7_migrates` now has one DROP loop, as round 1 asked. It is the test-writer's loop, but it
sits in a test that fails. `pnpm check` is red, so the AC-08 schema version is not proven on the
combined branch.

Expected: on `comb/RL-2`, every test file has the test-writer's version from `test/RL-2`. In
practice, these two files have e494fee's content again: schema, migration and readyz 9, and one DROP
loop. The combine step resolves test files from the test branch, not the impl branch. No product code
changes. Re-run `pnpm check` on the combined branch and get it green.

## Suggestions

### S4 (REGRESSION-OF-OWN-REPAIR, impl): `listItems` doc comment is stale

`src/store/hub-store.ts` `listItems` still says "The item rows of a lineage, in insertion order".
Since f17186c, the query orders by `fp`. Expected: the comment says "ordered by fp".

### S3 (REPEAT, test): AC-28 (Playwright) and the Postgres legs of AC-08 and AC-32 still not run

Expected: run `pnpm test:web` and the contract suite with `MESH_TEST_PG_URL` before release, and show
that they fail first.

## Confirmed without findings

- `SAFE_REV` (`^[A-Za-z0-9_][A-Za-z0-9_./^~@{}+-]{0,255}$`) cannot start with `-` and excludes `:`
  and whitespace. `--end-of-options` is also passed. The record is still uploaded with the agent's
  `subject.commit` unchanged (reading (h)).
- `fp` is lowercase base32 (`[a-z2-7]`), so `ORDER BY fp` gives the same order under SQLite's binary
  collation and Postgres's default collation.
- No team-, company- or person-specific names in the new commits. Docs: only the spec's Open questions
  changed, which fits two internal fixes.
