Verdict: APPROVED | Round: 1 | Blocking-open: 0

# RL-7 diff review, round 1

Diff: `git diff feat/relay-design...comb/RL-7` (tip dd619f5) against `docs/specs/RL-7.md`.
Earlier rounds: none for the diff (`r1-changes-requested.md` and `r2-approved.md` are spec reviews),
so every finding below is NEW. No REPEAT, no REGRESSION-OF-OWN-REPAIR.

## Checks run

On an export of `comb/RL-7` (node_modules linked from the integration worktree):

| Check | Result |
|---|---|
| `pnpm lint` | pass |
| `pnpm typecheck` | pass |
| `pnpm boundaries` | pass |
| `pnpm test` | 2177 passed, 102 skipped, 1 failed: `test/m45-cli.test.ts` `test_AC15_daemon_failure_warns_and_starts` with `EADDRINUSE 127.0.0.1:40023` (a port taken by another process on this host); the file passes on rerun (13/13). Not RL-7. |
| `pnpm build` | pass |
| `pnpm schemas` | regenerated document equals the committed `schemas/hub-api.openapi.json` |
| `pnpm exec playwright test test/e2e-web/rl7.spec.ts` (after build) | 2 passed (AC-09, AC-13 web) |
| `src/daemon` imports `child_process` | only a `vi.mock` in a test file, as before |

Fail first: the test-writer's tree (`test/RL-7`, product code = `feat/relay-design`) was run with
the 17 RL-7 vitest files: 57 tests fail, covering AC-01..AC-08, AC-10..AC-20 (AC-17's version and
OpenAPI tests included). After `pnpm build` of that tree, both RL-7 Playwright tests (AC-09, AC-13
web) fail. Every criterion has a test that failed first.

Not run: the Postgres legs of the store contract (`MESH_TEST_PG_URL` unset here; CI runs them;
AC-18 judged on its SQLite leg, which passes). The full `pnpm test:web` suite (only `rl7.spec.ts`
was run). The real `claude` binary (never; the fake fixture is used).

## Rules

- Developer and tests: the impl branch edited three test files (`1aacdee` redact.test.ts, `cd3d1e5`
  relay-daemon.test.ts, `729b29a` schemas.test.ts). The combine (`ce5a490`) took the test-writer's
  files, and `git diff test/RL-7 comb/RL-7` on those files is empty, so the reviewed diff holds only
  the test-writer's versions. Not a blocker; noted as process (S3).
- Test-writer and product code: `81771ef`, `a9827fb`, `9e9afd6` touch only tests, `test/helpers`,
  the fake `claude` fixture and the e2e hub config.
- No assertion on source text: tests read only docs, `skills/mesh/SKILL.md` and `package.json`
  (AC-16, AC-17 surfaces).
- Generic: no team-, company- or person-specific names; the e2e user `grace` follows the existing
  placeholder users (alice..frank).
- Docs: concepts, how-to, mesh skill (+ generated SKILL.md), plan API table and the RL-1
  `redactSecrets` paragraph are updated per the Docs table.

## Contract check (highlights)

- Rule 1: `applyRunSession` creates/revives the session of the run's Claude session id (`working`,
  `print`, pid, worktree, repo, no pane) right after start and before `reportStarted`; the bind claim
  uses `bind:<sid>:<step>` and shares `boundSteps` with the `SessionStart` path, so rule 2 sends no
  second claim.
- Rule 3: `callTool` binds only when no live session of the pid holds a step and `runForPid` finds a
  running, not ended run whose `doneAccepted` is unset; `doneAccepted` is set on online accept and on
  the offline queue.
- Rule 4: `markEnded` (reconcile and the reap in `load()`, which runs after sessions are loaded) and
  `notStarted` end the run's sessions before the end-of-run hub calls; `applyTick` skips stall and
  presumed-end for `liveRunSids()`.
- Env: the waiter removes `unsetEnv` after merging `env`, so `env` cannot re-add a name.
- Store parity: `putCatalogDefs` change is one shared SQL path (no dialect branch).
- Presets: `instantiate` mutates only the filled copy (`fill` builds new objects).

## Findings

All are suggestions; none blocks.

### Implementation

- **S1 (NEW, suggestion)** `src/daemon/daemon.ts` `bindRunSession`: the key `<sid>:<step>` is added
  to `boundSteps` before the claim, and `HubLink.rpc` throws at once while offline without queueing.
  A run registered while the link is offline therefore never sends its bind claim, and the hub's
  `holderSid` stays unset until something else binds it. The spec allows this ("holds the step
  locally whatever the hub answers") and the `SessionStart` path behaves the same, so it is not a
  contract break. Expected: on an offline error, drop the key from `boundSteps` (or queue the claim
  with the same idempotency key) so a later bind or flush sends it.
- **S2 (NEW, suggestion)** `src/core/session-state.ts` `applyRunSession`, `own` branch (AC-04 b): the
  run's Claude session id is added to the hook-registered session while the ended run session still
  lists it, so two sessions (one ended) carry that id. Harmless today (lookups prefer live
  sessions), but a reader of `/local/sessions` sees the id twice. Expected: either accept and note
  it, or remove the id from the ended session when it moves.

### Process

- **S3 (NEW, suggestion)** impl branch commits `1aacdee`, `cd3d1e5`, `729b29a` edit test files. The
  combine discarded those edits, so the result is clean, but the developer should leave test
  updates (named in the spec's Compatibility section) to the test-writer.

### Tests

- **S4 (NEW, suggestion)** `test/e2e-web/rl7.spec.ts` `test_AC13_web_goal_header`: the goal has steps
  done, done, skipped, skipped (4/4) and no dropped step. AC-13 says "such a goal" (with a dropped
  step). The unit test covers the dropped case for `renderGoal`, but not the web header. Expected:
  add a dropped step to the web fixture and keep the `4/4` expectation, so a web header that counted
  dropped steps fails.
