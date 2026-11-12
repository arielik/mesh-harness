Verdict: APPROVED | Round: 3 | Blocking-open: 0

# RL-2 diff review, round 3

Diff: `git diff feat/relay-design...comb/RL-2` (head baaa69f), against `docs/specs/RL-2.md` (revision 2
plus the developer's readings (a) to (i) in Open questions). Rounds 1 and 2 (`diff-r1-changes-requested.md`,
`diff-r2-changes-requested.md`) were read first. The only new commit since round 2 is the combine
baaa69f. It restores the test-writer's schema-9 values in `src/store/hub-store.contract.test.ts` and
`test/m46-ops.test.ts`, and fixes the `listItems` doc comment in `src/store/hub-store.ts`.

## Checks run

- `pnpm check` (lint, typecheck, boundaries, test, build) on an export of `comb/RL-2`: **passes**.
  Vitest: 74 files passed, 1583 tests passed, 76 skipped. The Postgres legs were skipped (no
  `MESH_TEST_PG_URL`).
- `pnpm test:web` (Playwright) on the same export: **passes**, 30 of 30, including `AC-28 skipped step`.
  The test cannot pass on the base, because it posts to `POST /v1/steps/:id/review` and plans with
  `output`/`when`/`consumes`, and RL-2 adds all of these. I did not run it on the base.
- Test files: `git diff test/RL-2 comb/RL-2` over every test file and `test/` is empty. Every test
  file on `comb/RL-2` matches the test-writer's branch.
- Product files: `git diff impl/RL-2 comb/RL-2` outside tests shows only the `listItems` comment line
  (see S5).
- Role boundaries: no new developer or test-writer commits since round 2. Round 2 checked 439a0a3
  (tests only), f86a1d5 and f17186c (product code and Open questions only).
- Source-text assertions: none in baaa69f.
- Not run: the Postgres legs of AC-08 and AC-32 (no Postgres available here), `pnpm schemas` on its
  own (`test_AC31_openapi_routes` compares its output and passes), and fail-first again for tests that
  rounds 1 and 2 already showed fail first (no test changed since round 2, apart from the restored
  schema-9 values).

## Earlier findings

- R1 (round 2, the combine took the developer's revert over the schema-9 test edits): **fixed**.
  The six contract tests and `test_AC05_readyz_schema_8` expect 9 again and pass. `test_AC08_v7_migrates`
  has one DROP loop.
- S4 (round 2, stale `listItems` comment): **fixed on `comb/RL-2`**, but not on `impl/RL-2` (S5).
- S3 (rounds 1 and 2, AC-28 and the Postgres legs not run): AC-28 is now run and passes. The
  Postgres legs are still not run (REPEAT, suggestion).
- B1, B2, S1 (round 1): still fixed. `SAFE_REV` and `--end-of-options` are unchanged in `reviewUpload`,
  and `listItems` orders by `fp` on both backends.

## Blockers

None.

## Suggestions

### S3 (REPEAT, test): the Postgres legs of AC-08 and AC-32 have still not run

Expected: before release, run the store contract suite and the hub-migrate tests with
`MESH_TEST_PG_URL` and show that they fail first on the base.

### S5 (NEW, process): the S4 comment fix exists only in the combine commit

`impl/RL-2` (f17186c) still says "The item rows of a lineage, in insertion order" in
`src/store/hub-store.ts` `listItems`. Only the combine baaa69f has the fixed text. A later combine
from `impl/RL-2` could conflict on this line or bring the stale text back. Expected: the developer
makes the same one-line comment change on `impl/RL-2`, or the combine process records that comb-only
product edits are allowed.

### S6 (NEW, impl): the web bundle now pulls in `node:crypto` through `core/policy.ts`

`src/core/policy.ts` now imports `runOf` from `src/core/review.ts`, and `review.ts` imports
`createHash` from `node:crypto`. `web/src/goals.tsx` imports `core/dag.ts`, which imports `policy.ts`,
so `vite build` warns that `node:crypto` was externalized for `review.ts`. Nothing calls `createHash`
at module load, and Playwright shows no page errors, so this is not a bug today. A future top-level
call would break the web page. (`core/headless.ts` already had the same warning on the base.)
Expected: optionally, move `runOf` and `isRaising` into a module with no Node imports, or have
`policy.ts` import them from one, so the web bundle stays free of Node built-ins.

## Confirmed without findings

- The restored test values match the test-writer's branch byte for byte.
- `GET /v1/steps/:id/reviews` and `GET /v1/items` need the member role and the `goals:read` scope,
  like `GET /v1/goals/:id` and `GET /v1/artifacts/:id`. Review data is no more visible than the goal
  it belongs to.
- No team-, company- or person-specific names in baaa69f.
