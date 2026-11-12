Verdict: APPROVED | Round: 1 | Blocking-open: 0

# RL-8 diff review, round 1

Diff: `git diff feat/relay-design...comb/RL-8` (merge 65423ac of impl commits db7025b..c2a0918 and
test commit 6018f87), against `docs/specs/RL-8.md`.

Earlier rounds: `r1`..`r3` reviewed the spec. No earlier diff round exists, so every finding below
is NEW. None is a REPEAT or a REGRESSION-OF-OWN-REPAIR.

## Summary

The implementation follows the spec:

- **Start at most once.** `beginStart` checks for room and reserves the run synchronously, with no
  `await` between the check and the reservation. The `starting` set is cleared in a `finally`.
- **Queue pass.** It re-reads each run and skips one whose start is in progress. It neither
  starts nor releases such a run.
- **Capacity.** `heldWithoutSession` counts a run being started once. After registration the run
  is counted through its session.
- **Git error text.** `gitError` takes the last non-blank line and strips a trailing `\r`. It is
  used at all three git failure sites.
- **Never-started runs.** They skip the transcript through `meta.notStarted`. `onSessionStart`
  refuses a run without `startedAt`.
- **Leftover sessions.** `finish` ends the run's live `print` sessions. The sweep matches on pid
  and Claude session id together, protects the sessions of running runs, and runs at start-up and
  on every `HeadlessRuns.reconcile`.
- **Session kind.** `applyEntry` keeps `print` only when the pid is the same.
- **Pulse warnings.**
  - The hub computes them after the write.
  - They are part of the reply that the idempotency layer stores, so a replay returns the
    first warnings.
  - Repo copies are filtered through `agentsView(actor, …)`, so the caller's visibility applies.
  - Roster keys go through the pulse's pin.
  - The CLI prints `warning: …` on stderr after the unchanged success line.

No store, route or migration changes, so SQLite and Postgres parity is not affected. The OpenAPI
document is unchanged.

## Criteria: tests that failed first

I ran the RL-8 tests from `test/RL-8` (6018f87) against the pre-implementation product code
(feat/relay-design), using an exported copy of the tree:

| AC | Result on the old code | Reason it fails |
|---|---|---|
| AC-01 | 3/3 fail | Run `running` while the add is held; it should be `queued` |
| AC-02 | 2 fail; `control_two_slots` passes (control) | Two `worktree add` calls during the hold |
| AC-03 | 5/5 fail | First-line texts |
| AC-04 | 3/3 fail | Transcript and session left behind |
| AC-05 | passes | Regression guard; the spec states it is unchanged (RL-1 AC-25) |
| AC-06 | `sweep_at_startup` and `sweep_phantom` fail; `no_live_print_after_finish` and `pid_reuse_running_run_untouched` pass | The passing tests are the spec's (a) regression guard and (d) control |
| AC-07 | unit `same_pid_keeps_print` and World `run_session_stays_print` fail; other-pid and non-print units pass | The passing units are controls |
| AC-08 | 10/10 fail | — |
| AC-09 | 4/4 fail | — |
| AC-10 | `add` and `update` fail; `no_invalid_empty_stderr` passes | The passing test is a control |
| AC-11 | 4/4 fail | — |
| AC-12 | `test_AC16_version` fails | — |

- **Source text.** No test asserts on source text. `docs-rl8.test.ts` reads docs and the
  generated skill, which is AC-11's stated surface.
- **Role separation.** The test-writer commit touches only tests and fixtures. One developer
  commit touched a test; see S3.
- **Stability.** I ran `test/relay-start-race.test.ts` three more times on the combined tree. All
  20 tests passed each time.

## Findings

All findings are suggestions (NEW). None is a blocker.

### S1 (NEW, impl): a failure while computing the warnings fails a pulse that was already saved

`src/hub/service.ts` `createPulse` and `updatePulse` call `pulseWarnings(actor, pulse)` after
`goalTx` has committed.

- **Problem.** If `agentsView` or `store.listCatalogDefs` throws (for example a store error), the
  route answers 5xx even though the pulse was saved. The idempotency layer stores only replies
  below 300. A client that retries with the same `Idempotency-Key` would therefore create a second
  pulse.
- **Spec.** It says an invalid agent never makes these routes fail. The function's own doc comment
  says "Never fails".
- **Expected.** Wrap the warnings computation in `try/catch`. On an error, log it and reply with
  `warnings: []`, or leave `warnings` out.

### S2 (NEW, docs): API table row claims warnings for pause, resume and delete

In `docs/plan/implementation-plan.md`, the row `POST /v1/pulses/:id/{update,pause,resume,delete}`
now says "the reply carries `warnings` for agents flagged invalid".

- **Problem.** Only `update` carries them. The spec's Docs table asked for this wording, so the
  text is per spec, but it is inaccurate for three of the four routes.
- **Expected.** Write `(v0.1.22: the update reply carries \`warnings\` …)`. `test/docs-rl8.test.ts`
  `test_AC11_api_table` still matches, because it checks for the NOTE substring. If the wording
  changes, update the NOTE string in the test to match.

### S3 (NEW, process): the developer edited a test

Developer commit `c2a0918` (release v0.1.22) changed `test/schemas.test.ts` `test_AC16_version`
from `0.1.21` to `0.1.22`.

- **Problem.** The developer role says "Never create or edit a test".
- **Effect.** The test-writer made the same change in 6018f87, and the merge kept the
  test-writer's version. The combined tree is therefore unaffected.
- **Expected.** In later steps the developer leaves version-pin tests to the test-writer. They
  are expected to fail on the impl branch until the merge.

### S4 (NEW, test): AC-07 World fleet check can never fail

In `test/relay-start-race.test.ts` `test_AC07_run_session_stays_print`, the check
`if (listed && listed.kind !== undefined) expect(listed.kind).toBe("print")` can never fail.

- **Why.** `FleetSession`/`LiveSession` (`src/protocol/hub.ts`) has no session `kind` field, so
  the branch never runs. The `GET /local/sessions` assertions carry the criterion.
- **Expected.** Drop the dead conditional, or replace it with a comment saying that the fleet
  view carries no session kind. Optionally note this in the spec's Open questions, since the spec
  says `mesh machines` shows `print`.

## Checks

I ran these on an exported copy of `comb/RL-8`, with dependencies installed using
`pnpm install --frozen-lockfile --prefer-offline`:

- `pnpm check` (lint, typecheck, boundaries, test, build): exit 0. Test files 101 passed; tests
  2223 passed and 102 skipped.
- `pnpm schemas`: `schemas/hub-api.openapi.json` is byte-identical before and after.
- `src/daemon`: no `child_process` import (only a `vi.mock` in a test file).
- The RL-8 test files on the exported copy of `test/RL-8` (old product code), to confirm the
  failing-first results in the table above.
- `test/relay-start-race.test.ts` on `comb/RL-8`, three more times.

Not run:

- The Postgres legs of the store contract (`MESH_TEST_PG_URL` is unset; CI runs them). RL-8 adds
  no store code, and I judged parity on the SQLite leg.
- The real `claude` binary (the tests use the fake fixture).
