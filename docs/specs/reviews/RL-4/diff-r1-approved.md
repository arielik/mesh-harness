Verdict: APPROVED | Round: 1 | Blocking-open: 0

# Diff review of RL-4, round 1

Reviewed: `git diff feat/relay-design...comb/RL-4` (head 055e355, 53 files) against `docs/specs/RL-4.md`
as it stands on `comb/RL-4`. Earlier rounds read first: `r1-changes-requested.md` and `r2-approved.md`.
Both are spec reviews. No earlier diff round exists, so every finding below is NEW. None is a REPEAT or a
REGRESSION-OF-OWN-REPAIR.

## Checks run

All checks ran on an exported copy of `comb/RL-4` (`git archive`, then `pnpm install --frozen-lockfile
--prefer-offline`). Nothing was checked out in the integration worktree.

| Check | Result |
|---|---|
| `pnpm lint` | pass |
| `pnpm typecheck` | pass |
| `pnpm boundaries` | pass |
| `pnpm build` | pass |
| `pnpm test` | pass: 86 files, 1954 passed, 92 skipped (the Postgres legs and the existing skips) |
| `pnpm schemas`, then compare | `schemas/hub-api.openapi.json` and `skills/` are byte-identical after regeneration |
| `pnpm test:web` (Playwright, after build) | 38 passed, including the RL-4 AC-19 and AC-20 tests |
| Fail-first | The test branch head 7eb0557 (its parent chain sits directly on the base 82295b8; it changes only test files) was exported and its 15 new or changed vitest files were run against the base product code: 122 failed, 323 passed, 75 skipped. Every vitest-surface criterion has failing tests on the base: AC-01, 02, 03, 04, 05, 06, 07, 08, 09, 10, 11, 12, 13, 14, 15, 16, 17, 18, 21, 22, 23, 24, 25. AC-19 and AC-20 (Playwright) were not re-run on the base; they need the routes `GET /v1/debriefs` and `GET /v1/steps/:id/debrief`, which the base does not have. |

Not run:
- **Postgres legs.** `MESH_TEST_PG_URL` is not set on this host. The Postgres part of AC-25
  (`hub-store.contract.test.ts`) and the existing Postgres legs were skipped. They are judged on the SQLite
  leg. From the code: `listSteps({updatedSince})` compares the existing `step.updated_at` column (BIGINT on
  Postgres) and `listDispositions({steps})` uses `step IN (…)` with bound parameters, so the same SQL runs
  on both backends; `since` is filtered on the parsed entry, the same for both.
- **The real `claude` binary.** It is never run. AC-15 uses a fake runner.

## Separation of roles

- **Test-writer:** 1501f99, 9f03d9a and 7eb0557 change only test files, `test/helpers/debrief-kit.ts` and
  `test/e2e-web/*` (including the fixture `hub.yaml`). No product code. ✔
- **Developer:** see F1. Developer commits edited existing test files. The final tree keeps none of those
  edits: `git diff 1501f99 comb/RL-4` over those paths shows only the test-writer's own later fix in
  `src/protocol/headless.test.ts`. The developer added no new tests.
- **Assertions on source text:** none. Tests read `package.json`, the docs, `skills/*/SKILL.md`, the
  generated OpenAPI file and installed skill files (AC-16, AC-23, AC-24 surfaces). `test_AC24_boundaries`
  imports `src/core/policy.ts` as a module; it does not read its text.

## Spec conformance (summary)

Checked against the contracts:
- never offered: `assignStep` 409 after the gate and state checks; `offerableSteps`, `emitReady` (stick)
  and the pulse `attempt` skip debriefs; `listSteps({ready})` drops them, so `mesh_next`, `mesh next`,
  the TUI `n` key and autopilot never pick one;
- assignee-only hold: `refuseNonAssignee` sits first in `claimInTx` (claim, accept) and in `takeStep`;
  `@owner` is resolved from `goal.ownerId` at each check;
- `read`, `dispositions` and `dispositions/revert` each run in `goalTx` (`store.serialize()` first);
  the error order and texts match the route table;
- change of mind (check 6 passes on the step's own latest disposition of the round), the `left` count,
  the note texts, `step.noted`, `item.disposed` with `via: "debrief-session"`, and the step saved with
  `updatedAt` = the disposition's `at`;
- revert: latest-history-entry rule, who may revert, restored `state`, `dismissedEh`, `until` and `link`,
  the `kind: "revert"` entry, note and `item.reverted`; works in any step state;
- the debrief's own record: no admin exception, person decider, the session-decision rule (`already`, or
  the exact problem text) between checks 4 and 5, other dispositions applied with `via: "debrief-session"`
  and a note, `review.recorded.already`;
- `GET /v1/debriefs` store access (`listSteps` by state; `listDispositions({steps, since})` over debrief
  steps updated in the last 7 days; no full scan of `item_history`);
- context inputs (`debrief` then `report`, under RL-1's caps), the brief line, `mesh_dispose` (redaction,
  never queued, reply texts), the `mesh_review` `already` sentence, the local routes;
- events carry no titles, reasons, answers or report text; `mesh debrief`, setup, uninstall, doctor,
  `mesh skill --debrief`; TUI `o` panel and `u`; web Mine and step panel; the docs table.

I found no correctness defect against the spec (auth, visibility, store parity, races, idempotency). The
two implementation readings the spec did not pin are in its Open questions, dated 2026-11-12
(implementation). They are reasonable.

## Findings

None of these is a blocker.

### F1 (NEW, suggestion, process): the developer edited test files, the merge resolved test conflicts, and one combine commit lacks the trailer

- Developer commits ec16daa (`test/review-hub.test.ts`), 51c453b (`test/m2-flow.test.ts`), 8a53b37
  (`src/cli/tui/render.test.ts`), c20098c (`test/schemas.test.ts`) and 4257f33
  (`src/protocol/headless.test.ts`, `src/protocol/review.test.ts`) changed existing tests. This breaks
  `developer.md` ("Never create or edit a test"). The spec's Compatibility section gives these updates to
  the test-writer, who made them too.
- Combine commit 014a1de lists conflicts in five test files and resolved them; `merger.md` says to abort
  and report the paths. Its message also lacks the `Co-Authored-By` line the other commits carry.
- The final tree keeps the test-writer's version of every test file, so the shipped code is not affected,
  and the repo has no CLAUDE.md that makes this a hard rule. RL-3's diff review raised the same pattern
  (its F1). Expected: the developer leaves failing existing tests to the test-writer; the merger aborts on
  a conflict.

### F2 (NEW, suggestion, efficiency): `GET /v1/debriefs` reads every ready, claimed and paused step and every step updated in 7 days, on each 5 s TUI poll

`src/hub/service.ts` `HubService.debriefs` calls `listSteps({state})` for three states hub-wide and
parses each step to find debriefs, then for each of the caller's debriefs re-lists the goal's steps and
rebuilds `debriefData` (item rows with full history). `listSteps({updatedSince})` has no index on
`step.updated_at`, so it is a full scan of `step`. This follows the spec (which only forbids a full scan of
`item_history`), but every open TUI polls it every 5 s. Expected (later row): count items without loading
history for the summary, and narrow the step scans (for example a `mode` column or an index on
`updated_at`, with a migration).

### F3 (NEW, suggestion, robustness): the `debrief items` input stops being JSON when it is truncated

`src/hub/service.ts` `stepInputs` pushes `JSON.stringify({lineage, items})` under RL-1's 50 000-character
cap. Each `DebriefItem` carries the item's whole `history` (all earlier reasons and answers), so a debrief
with many or long-lived items is cut mid-JSON (`truncated: true`), and the skill's first step reads a
broken list. This is what the spec says ("under RL-1's caps"). Expected (later row): keep the input
parseable when it is cut, for example by dropping whole items from the tail, or by sending only the
disposition entries of the history.

## Verdict

**APPROVED.** There are no blockers. Every criterion has a test that failed before the implementation and
passes now (AC-19 and AC-20 by the routes they need; the Postgres legs were not run on this host). F1 to F3
are suggestions for a later row.
