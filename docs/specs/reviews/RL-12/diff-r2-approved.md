Verdict: APPROVED | Round: diff-2 | Blocking-open: 0

# Review of the RL-12 diff, round 2

This is a cold review of the fix commit a5b7b42 (on top of 66f5c5d, reviewed in round 1) against
`docs/specs/RL-12.md` and `docs/specs/reviews/RL-12/diff-r1-changes-requested.md`.

Read: `git show a5b7b42 -- src test`, and for comparison `findingStepsOf`, `cleanAuditGoals`,
`findingIndex`, `CardCtx`, the `runCard` sinks loop, the `health` pulse list and `lastSlot` loop,
`slotCursor`, `PulseSlot.slot` (`src/protocol/pulse.ts`, `ISO_RE`, `MANUAL_SLOT_RE`),
`HubStore.addPulse` (id `p-<num>`), `Ck.start` / `Ck.dismissOne` (`test/helpers/calib-kit.ts`), and
the AC-07 seed in `test/health-hub.test.ts`.

The working tree is clean; the contract test that was uncommitted in round 1 is now in a5b7b42.

## Round-1 findings

| Finding | Status | Reason |
|---|---|---|
| B1 cursor reaches SQL unchecked | **RESOLVED** | `decode` now requires `Number.isSafeInteger(at)`, `at >= 0` and a `slot` passing `PulseSlot.shape.slot` (ISO `YYYY-MM-DDTHH:MM:SS.sssZ` or `manual:<ULID>`), so only values a stored slot can hold are bound to the `BIGINT`/text parameters; `\u0000` and non-integer `at` cannot pass. `test_AC06_errors` adds `[1.5, iso]`, `[1e300, iso]` and `[1, "x\u0000"]`; all three would have returned 200 on SQLite with the old `decode`, so the cases can fail. |
| B2 calibration asserted as 0 = 0 | **RESOLVED** | The block starts with `threshold: 1` and opens the goal via `dismissOne`; the test asserts `calOpen >= 1` before comparing, and checks `oldestMs = NOW − min(createdAt)`. A `{open: 0}` implementation now fails. |
| S1 N+1 reads | **PARTIAL** | `cleanAuditGoals` is read once per request through `CardCtx.cleanGoals`. `filedItems` still re-reads items/dispositions per lineage per card, `previousComplete` still builds a full card, and health still calls `runRow` per run for `waste`. Not blocking. |
| S2 page loop batch size | **OPEN** | Still `limit + 1` per query. Not blocking. |
| S3 nits | **PARTIAL** | Pulse sort fixed (see below). `lastSlot` 100×20 bound has no comment; `days` still `^\d{1,2}$` vs `limit` `^\d{1,3}$`. |
| S4 listSlots before/since on Postgres and ties | **RESOLVED** | `test_RL12_listSlots_before_since` (shared `at`, ISO vs `manual:`, `limit`, `since`) is committed and passes on both drivers (run with `MESH_TEST_PG_URL`). |
| S5 weak assertions | **PARTIAL** | Done: `lastSlot` exact `{slot, at, state}` (now distinguishes it from the older fired slots); `debriefs.oldestMs` exact (`NOW − g1Ready`); AC-11 on-behalf text. Open: no case where the newest slot is a trial fire (the trial fire is at `due(2)+10min`, older than `due(1)`, so the comment "the trial fire is left out" describes nothing the test exercises); `costPerAcceptedUsd` rounding (1/1); `total` under `repo=alpha` checks only `pulses`/`manual`; AC-02 drop-while-ready case; AC-05 50-slot bound; AC-11 steps' `updatedAt`. |

## Checks of the fix commit

- **Sinks loop equivalence.** The old loop called `findingStepsOf(lineage, fp)`, which iterates
  `cleanAuditGoals()` (`listGoals()` filtered to `sink !== undefined && state !== "dropped"`) and
  keeps a goal when `getStep(\`${goal.id}.${findingStepId(lineage, fp)}\`)` has
  `finding.lineage === lineage`, `finding.fp === fp` and is not moved away; the caller then skipped
  goals without `sink`. The new loop iterates `ctx.cleanGoals(store)` (the same filter over the same
  `listGoals()`, so the same goals in the same order), reads the same step id, and applies the same
  predicate plus the (now redundant) `!c.sink`. A `CardCtx` is created per request (pulse-runs and
  health each make one) and both routes run in one `store.tx` with no writes, so the cached goal list
  cannot go stale within its lifetime. Equivalent; `sinks` tests (AC-04) still pass.
- **Pulse order in health.** `Number(a.id.slice(2))` parses `p-<num>`, the only id form
  `addPulse` produces, so the order is numeric (p-2 before p-10), no longer reliant on a stable sort
  of all-zero keys.
- **Cursor vs slot id rule.** The cursor check uses the schema's own `slot` refinement, so every
  cursor the route emits (the `(at, slot)` of a stored slot) is accepted and nothing else is; `at`
  of a stored slot is a non-negative integer ms time, so the integer/≥0 check rejects no valid
  cursor.
- No new problems found.

## Checks

Run on spec/RL-12 at a5b7b42 (Node 24.22.2):
- `node_modules/.bin/tsc --noEmit -p .`: clean.
- `node_modules/.bin/eslint src/hub/service.ts src/store/hub-store.contract.test.ts test/health-hub.test.ts test/pulse-runs-hub.test.ts`: clean.
- `MESH_TEST_PG_URL=postgres://…@127.0.0.1:55432/postgres node_modules/.bin/vitest run
  test/pulse-runs-hub.test.ts test/health-hub.test.ts test/docs-rl12.test.ts
  src/store/hub-store.contract.test.ts`: 4 files, 191 passed (Postgres contract leg included).

Not run: the full suite; the World route tests on Postgres (they are SQLite-only, so B1's Postgres
500 is confirmed fixed by reading, not by a Postgres route call).
