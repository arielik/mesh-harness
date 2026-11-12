Verdict: CHANGES REQUESTED | Round: 1 | Blocking-open: 2

# RL-2 diff review, round 1

Diff: `git diff feat/relay-design...comb/RL-2` (head 79d3a61), against `docs/specs/RL-2.md` (revision 2
plus the developer's readings (a) to (g) in Open questions). This is the first diff round: no earlier
`diff-r*.md` exists, so every finding is NEW. The spec rounds (`r1-changes-requested.md`,
`r2-approved.md`) were read for context.

## Checks run

- `pnpm check` (lint, typecheck, boundaries, test, build) on an export of `comb/RL-2`: passes.
  Vitest: 74 files, 1581 passed, 76 skipped. The Postgres legs were skipped (no `MESH_TEST_PG_URL`).
- Fail-first: the test-writer's new and changed test files (from e494fee) copied onto an export of
  `feat/relay-design` and run there with vitest. Each of AC-01 to AC-14, AC-16 to AC-27 and AC-29 to
  AC-31 has at least one test that fails on the base. AC-15 is retired.
- Not run: `pnpm test:web` (Playwright, AC-28), the Postgres legs of AC-08 and AC-32 (no Postgres
  URL), and `pnpm schemas` on its own (its output is compared by `test_AC31_openapi_routes`, which
  passes). For AC-28 and AC-32 fail-first was not shown here.
- Role boundaries: `git log --stat` per commit on `feat/relay-design..comb/RL-2`.
- Source-text assertions: none found. `test_AC30_docs_present` reads docs, which AC-30's surface
  allows. `test_AC31_core_boundaries` imports modules and does not read their text.

## Blockers

### B1 (NEW, impl): `mesh_review` passes the agent's `subject.commit` to git as an argument, so it can be a git option

`src/daemon/tools.ts` `reviewUpload` runs `git show ${commit}:${path}` in the evidence root. The
`commit` is the agent's `subject.commit` when the agent sets it (any string up to 64 characters,
`ReviewRecord.subject.commit`). A value that starts with `-` reaches git as an option. For example,
`subject.commit: "--output=/some/dir/x"` turns the call into `git show --output=/some/dir/x:<path>`,
which writes a file at a path the agent chose. That write happens on the daemon's machine and
bypasses the permission profile of a headless run. Other diff options work the same way.

I did not run this command here (the sandbox refuses git outside the worktree). `--output=<file>`
is a documented diff option that `git show` accepts.

Expected: the daemon never lets agent-written text become a git option. Either (a) only use
`subject.commit` when it matches a revision pattern that cannot start with `-` (for example
`^[0-9A-Za-z][0-9A-Za-z._/^~@{}-]*$`), or (b) pass `--end-of-options` before the revision (git ≥ 2.24),
or both. Under (a), a rejected commit counts as a failed read, so its regions hash as `missing`, as
the spec already says for reads that fail. Record the chosen reading in Open questions. A test then
proves it (see T1).

### B2 (NEW, process): the developer changed test files

The developer role says to "never create or edit a test", and the spec's Compatibility section says
the test-writer updates the existing count, TOOLS, MARK and TABLES tests. These developer commits
changed tests:
- 6e5b5ac: `src/store/hub-store.contract.test.ts` (schema 8 → 9 in four tests, plus a
  `DROP TABLE … review_*` loop in `test_AC08_v7_migrates`) and `test/m46-ops.test.ts` (readyz
  schema 9);
- 943ba80: `test/m2-flow.test.ts` (the tool list gains `mesh_review`);
- 3a870fc: `test/schemas.test.ts` (`test_AC34_version` pin to 0.1.16).

Results after the merge:
- `test_AC08_v7_migrates` now has the migration-9 DROP loop twice: the developer's copy and the
  test-writer's (harmless, but a merge artifact).
- The `m2-flow` tool-list update exists only because the developer made it. The test-writer did not
  update that test, although the Compatibility section assigns it to them.
- The schemas and m46 edits were overwritten by the test-writer's versions at the merge.

Expected: the developer's test edits are reverted on `impl/RL-2`. The test-writer makes the
`test/m2-flow.test.ts` tool-list update on `test/RL-2`. After the next combine, the v7 migration test
has one DROP loop.

## Suggestions

### S1 (NEW, impl): `listItems` orders rows differently on SQLite and Postgres

`src/store/hub-store.ts` `listItems` orders by `rowid` on SQLite and by `updated_at, fp` on Postgres.
`GET /v1/items` sorts afterwards, so it is unaffected. The raising-step `dispositions` input
(`HubService.dispositionsInput`) and the `rows` passed to the fold use the store order unsorted. So
the same lineage gives a different item order in a raising step's `dispositions` input on each
backend.

Expected: one order on both backends. Either sort in the service as `GET /v1/items` does, or order
the store query by a column both backends share.

### S2 (NEW, test): some new RL-2 tests pass on the base

These new RL-2 tests pass on the base. None of them is the only failing-first test of its criterion,
so no criterion is unproven. The test-writer report should still list them as not fail-first, as
the role asks:
- `test_AC17_blocked_on_approve`: on the base, `validate` is also `blocked` at approve because
  `audit` is not done. This test cannot catch a `when` step made `ready` early. The AC-17 and AC-18
  tests that skip or decide at done and at replan do catch it.
- `test_AC22_none`;
- `test_AC22_fence` (unit, `brief()`): the fence is RL-1 behaviour;
- `test_AC12_reopen_order_vs_gate`, `test_AC12_fail_without_record` and
  `test_AC12_no_output_unchanged`, `test_AC25_plain_flow`, `test_AC01_old_plan_unchanged`,
  `test_AC25_tool_rules`, and the AC-02 valid-shape controls: compatibility checks and positive
  controls, which are expected to pass on the base.

Expected: list them in the test-writer report. Optionally, add a variant of
`test_AC17_blocked_on_approve` that would fail on the base: approve a replan that adds `validate`
after `audit` is done, so its dependency is satisfied.

### S3 (NEW, test): AC-28 and AC-32 were not run in this review

AC-28 runs only in Playwright, and AC-32 and the Postgres leg of AC-08 run only with
`MESH_TEST_PG_URL`. This review ran neither. They should run, and their fail-first be shown, before
release (AC-31 names `pnpm test:web`).

## Confirmed without findings

- Hub route order and texts (404, 409 no output, 409 state, 403 holder, 403 foreign sid, 409 second
  record, 422 problems). Precedence comes before the state check, and only the first failing check of
  each disposition is reported. Writes run in `goalTx` with `serialize()` first.
- Idempotency comes from the generic `Idempotency-Key` middleware. `addReview`'s `ON CONFLICT DO
  NOTHING` is the second guard.
- REQ-5 done rule: the reopen 400 comes before the reopen-id checks; with a record the step closes
  done and `judgeDone` is bypassed; `Round.fold` and `artifactIds` are set.
- `settle()` is wired into plan approve, done, gate decide and resume, and goal done counts `skipped`.
  The remaining `recomputeReady` calls (inside `materialize` and `reopen`) never make a `when` step
  `ready`.
- Migration 9 has the same tables on SQLite and Postgres (`ord` and `seq` are identity columns, and
  time columns are `BIGINT` on Postgres). `hub-copy` `TABLES` has the three new tables, with `seq` as
  identity.
- Event payloads carry counts, states, fps and lineage only. `describe()` texts carry no titles or
  reasons.
- Docs (concepts, how-to, skill, plan table, events) are present. No team-, company- or
  person-specific names were added.
