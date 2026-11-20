Verdict: CHANGES REQUESTED | Round: diff-1 | Blocking-open: 2

# Review of the RL-12 diff, round 1

This is a cold review of `git diff main...spec/RL-12 -- src test schemas package.json docs/guide docs/plan`
(head 66f5c5d) against `docs/specs/RL-12.md`, revision 5 (approved). This is the first diff round, so
every finding is **NEW**.

Read: `src/core/stage-times.ts`, `src/hub/service.ts` (`pulseRuns`, `previousComplete`, `runCard`,
`health`, `blockedBy`, `slotCursor`, `CardCtx`, `stageCard`, `cardDelta`, `perAccepted`, and for
comparison `fireSlot`, `advanceSlot`, `slotStarted`, `runStepOf`, `listRuns`, `filedItems`,
`findingStepsOf`, `cleanAuditGoals`, `pulseOr404`, `pulseView`), `src/store/hub-store.ts`
(`listSlots`, `lineageHistory`, `listArtifacts`, `listSteps`, the `pulse_slot` and `item_history`
DDL), `src/store/dialect.ts` `binary`, `src/protocol/hub.ts`, `src/protocol/hub-api.ts`,
`src/hub/app.ts`, the docs (concepts `## Pulse health`, scheduled reviews, operations, API table),
and the tests `test/pulse-runs-hub.test.ts`, `test/health-hub.test.ts`, `test/helpers/health-kit.ts`,
`test/docs-rl12.test.ts`, and the RL-12 changes to `test/docs-rl11.test.ts`, `test/m46-ops.test.ts`
and `test/schemas.test.ts`.

No CLAUDE.md. The public-boundary rule holds: the names in code, docs and tests are generic (`ann`,
`alpha`, `beta`, `p-1`, `tracker.example`).

**Working tree.** During this review the working tree gained uncommitted changes that are not mine
(by mtime they predate my first test run): a `test_RL12_listSlots_before_since` case in
`src/store/hub-store.contract.test.ts` and an unused-import fix in `test/pulse-runs-hub.test.ts`. I
reviewed the committed head; the contract test, once committed, closes part of S4.

## Process checks

| Check | Result |
|---|---|
| Tests written from the spec | Tests came in the same commit as the code (66f5c5d); I could not run "failed first". I checked which tests can fail on the FAIL state of their AC (B2, S5 list the gaps). |
| No assertion on source text | **Yes.** The tests read docs, `HUB_API`, generated files and `package.json` only. |
| Older test files | Only version pins, the `features` list and the renamed upgrade section change, as AC-11/AC-12 need. |
| Generated files | `node scripts/schemas.ts` leaves `schemas/` and `skills/` clean. |

## What holds

- **Stage times.** `firstEnd` takes the first `done` round, else `updatedAt` of a `skipped`/`dropped`
  dep. `readyAt` needs a first end for every dep; without deps it is the `decidedAt` of the lowest
  approved plan version that lists the local id. `startedAt` falls back to `claimedAt` only for
  `claimed`/`paused`. `waitMs` is clamped at 0. `cycleReadyAt` is computed only for
  `ready`/`claimed`/`paused` from the own newest round, every round of any step of the goal (moved-away
  included, the map comes from `listSteps({goal})`) whose `reopen` names the step case-insensitively,
  and each dep's newest `done` round; it is kept only when later than `readyAt` (or `readyAt` is
  absent). `waitingMs` only for `ready`. The debrief `oldestMs` reuses the same function.
- **StageCard / RunCard fields.** `mode` defaults to `interactive`; `holder` only while
  claimed/paused; `agent` from the newest telemetry round, else `policy.agent`; sums over telemetry
  rounds, `costUsd` only when one has it, `exit` from the newest. Stages follow `listSteps({goal})`,
  the order `GET /v1/goals/:id` uses, moved-away steps left out. `startWaitMs` uses `firedAt` for a
  manual or catch-up slot. `fold` sums the newest folded round per step. `items.raised` counts
  distinct `(lineage, fp)` over all raising records of the goal's steps, states now. `dispositions`
  read each lineage's history once (indexed `lineage`, never a `goal` filter), count every
  disposition row of the goal (reverted ones included), `byPeople` by `decider.kind`, and `reverted`
  by revert entries. `reports` come from `listArtifacts` in `created_at` order, pruned rows included.
  `sinks` use `filedItems(lineage, goal)` (latest `accepted` row in this goal, linked, accepted now)
  and `findingStepsOf` (clean-audit goals not dropped, moved-away steps left out), ordered by goal
  number.
- **delta.** Only for a `done` goal; the previous run is the first slot among the next 50 (card
  order) of the same trial class whose goal exists and is `done`, whatever the page's `trial`.
  `costUsd` only when both totals have it; absent `items`/`fold` count 0.
- **Paging.** The 400 texts and the 404 (`pulseOr404`, deleted pulses included) are the table's.
  The page loop reads `limit + 1` slots at a time after the position, skips slots the `trial` filter
  rejects, sets `next` only when a further passing slot exists, and the cursor is the `(at, slot)` of
  the last card, so it stays valid with another `trial`.
- **listSlots.** `before` is `(at < ? OR (at = ? AND slot < ?))` with `dialect.binary("slot")`, the
  same expression as the `ORDER BY`, so the cut and the order agree on both dialects (SQLite `BINARY`,
  Postgres `COLLATE "C"`, both byte order). `since` is `at >= ?`. Both are in SQL.
- **Health.** `days` 1–90, `trial` exclude/include, texts as specified. The window is
  `[now − days·86 400 000, now]`, inclusive. Pulses: not deleted, `params.repo`, `topic` trimmed and
  lowercased with `all`, by number. `slots` counts scheduled slots in the window by state now,
  `missed` by reason, `started` by `startedAt`; `manual` counts manual slots passing `trial`.
  `runs` takes steps with `updatedSince: since`, the pulse's (trial-filtered) goals, telemetry rounds
  with `finishedAt` in the window, and the waste parts from `runRow`; this is the same set
  `listRuns` returns for `pulse`, `since`, `until + 1` and `trial`. `goals` are those of the window's
  slots passing `trial`. `accepted` takes the latest `accepted` history row per fp (reverted or not)
  and counts items `accepted` now whose row is in a pulse goal with `at` in the window.
  `costPerAcceptedUsd` is rounded to 4 decimals and absent at 0 or without cost. `debriefs`,
  `findings` (lineage-level, `open` = open + confirmed), `total` (sums, `missed` merged, lineages
  deduped, `calibrations` over all calibration goals whatever the filters) match the spec.
- **blockedBy.** Mirrors `fireSlot`: `overlap: skip` only; over `fired` slots in card order, passes
  over missing, done, dropped and trial goals; "started" is `startedAt` or `slotStarted(goal, run
  step)`; a not-started slot with `now ≥ until` (retired) and a started goal with
  `now − createdAt ≥ maxGoalAgeMs` (abandoned) are passed over; the first `overlapBusy` hit gives
  `{goal, step, ageMs}`.
- **Scope, writes, features.** Both routes are `r(…, "goals:read")` without `forPerson`, so
  `x-mesh-on-behalf-of` gets the generic 400 text. Both run in one `store.tx` and call no write.
  `HUB_FEATURES` is `["health", "pulse-runs", "runs", "trial"]`.
- **Docs.** Every item of the Docs list is present; the concepts section says what the spec asks
  (stage times incl. the rejected/parked-round caveat, `delta`, window, trial vs lineage-level, read
  cost, no composite score). I found no statement the code contradicts.

## impl_findings

### B1 (NEW, blocking): a crafted `cursor` reaches SQL unchecked; on Postgres it gives 500, not 400
`slotCursor.decode` (`src/hub/service.ts`, end of file) accepts any finite number for `at` and any
string for `slot`. Unlike the RL-11 run cursor (compared in JavaScript), this one is bound into SQL
(`listSlots` `before`). On Postgres `at` is `BIGINT`: a cursor with `at` 1.5 or 1e300 makes the
statement fail with "invalid input syntax for type bigint", and a `slot` containing `\u0000` fails
the UTF-8 text parameter. Neither is a `HubError`, so `app.onError` answers 500, while the table says
an invalid cursor is 400 `cursor is not valid`. SQLite accepts both, so the World tests (SQLite only)
do not see it. (By reading; the Postgres legs could not be run here.)
Fix: in `decode`, require `Number.isSafeInteger(at)` and a slot that matches the `PulseSlot.slot`
rule (ISO time or `manual:<ULID>`); add `?cursor=<base64url of [1.5,"x"]>` to `test_AC06_errors`.

### S1 (NEW, suggestion): N+1 reads inside one serialized transaction
- A card computes `sinks` with `findingStepsOf` per filed item, and each call runs
  `cleanAuditGoals()`, which is `listGoals()` (every goal of the hub). A page of 20 cards plus up to 20
  previous-run cards with 30 filed items each is about 1200 full goal reads. `filedItems` also
  re-reads `listItems` and `listDispositions` per lineage per card, bypassing `CardCtx`.
- `previousComplete` builds a full card (dispositions, reports, sinks) when `delta` needs only
  `totals`, `items.raised` and `fold`.
- Health calls `runRow` per run only for `waste`; `runRow` reads the step's raising records and one
  item per fp (RL-11 S7).
All of this runs in `store.tx`, which on SQLite holds the single write turn. Fix: cache
`cleanAuditGoals` (or a `findingIndex` per lineage) and `filedItems` in `CardCtx`; compute the
previous run's delta inputs without sinks/dispositions; derive `allDismissed` from the cached item
rows.

### S2 (NEW, suggestion): the trial-filtered page loop reads `limit + 1` slots per round trip
With `trial=only` (or `exclude` over a run of trial slots) and `limit=1`, the loop reads 2 slots per
query until it finds a passing one, so a pulse with 1000 non-trial slots costs 500 queries for
`?trial=only&limit=1`. Fix: read batches of `max(limit + 1, 100)`.

### S3 (NEW, nit): small mismatches
- `health` sorts pulses with `goalSeq`, which parses `G<n>`; pulse ids are `p-<n>`, so every key is 0
  and the order only holds because `listPulses` already orders by `num` and the sort is stable. Drop
  the sort or parse `p-<n>`.
- `lastSlot` gives up after 100 batches of 20 (2000 slots) and then reports none, although the spec
  has no bound. Harmless in practice; a comment would do.
- `days` accepts at most two digits, so `days=090` is 400 while `limit=020` is accepted. Use the
  same `^\d{1,3}$` shape for both.

## test_findings

### B2 (NEW, blocking): AC-10 `calibrations` is asserted as 0 = 0
`test_AC10_filters_and_total` (`test/health-hub.test.ts`, AC-10 block) says "An open calibration goal
(threshold 1)", but `Ck.start({ clock })` passes no `threshold`, so the hub's default of 5
(`src/hub/config.ts` `calibration`) applies and the single dismissal opens no calibration goal.
`calOpen` is therefore 0, and both `total.calibrations.open` assertions pass with code that always
returns `{open: 0}`. AC-10 requires "`calibrations` counts an open calibration goal under every
filter". Fix: start with `Ck.start({ clock, threshold: 1 })`, assert `calOpen >= 1`, and assert
`oldestMs` (= `now − createdAt`).

### S4 (NEW, suggestion): listSlots `before`/`since` are not exercised on Postgres or with ties
The World tests run on SQLite, and every slot there has a distinct `at`. The uncommitted contract
test in the working tree (two slots sharing `at`, ISO vs `manual:`) covers this on both drivers;
commit it.

### S5 (NEW, suggestion): assertions weaker than the AC
- AC-07 `lastSlot`: only `{state: "fired"}` is checked. The oldest slot is also `fired`, and the
  trial slot is never the newest, so neither the order nor the `trial` filter of `lastSlot` is
  tested. Assert the `slot` and `at`, and add a case where the newest slot is a trial fire.
- AC-08 `debriefs.oldestMs`: `toBeGreaterThan(NOW − debriefReady)`; assert the exact value (`NOW −`
  goal 1's validate `finishedAt`).
- AC-08 `costPerAcceptedUsd`: 1 / 1 = 1 does not exercise the 4-decimal rounding; use a cost that
  divides to more decimals (e.g. 1 / 3 → 0.3333).
- AC-10 `total`: only `pulses` and `manual` are checked, and only without filters; check the summed
  `slots`, `runs`, `goals` and `findings` under `repo=alpha`.
- AC-02 "a goal dropped while a → b is waiting": the test drops the goal after `a` failed, so `b` is
  `blocked` with no `readyAt`, and `waitMs` is absent for any implementation. Drop while `a` is done
  and `b` is `ready`, then assert `readyAt` present and `waitMs`/`waitingMs` absent.
- AC-05: the 50-slot bound of `delta` is not tested (a done run 51 slots back must not be named).
- AC-11: the on-behalf case checks only the status, not the text `on-behalf-of is not accepted on
  this route`; "no writes" compares `/v1/goals?pulses=1` and the events, not the steps' `updatedAt`
  the AC names.

## Checks

Run on spec/RL-12 at 66f5c5d (Node 24.22.2):
- `node_modules/.bin/tsc --noEmit -p .`: clean.
- `node_modules/.bin/eslint` on the changed source and test files: clean.
- `node_modules/.bin/vitest run test/pulse-runs-hub.test.ts test/health-hub.test.ts
  test/docs-rl12.test.ts test/schemas.test.ts test/m46-ops.test.ts test/docs-rl11.test.ts`: 6 files,
  109 passed, 9 skipped (Postgres legs).
- `node scripts/schemas.ts` (what `pnpm schemas` runs): no diff.

Not run: the Postgres legs (`MESH_TEST_PG_URL` unset; B1 is by reading), the full suite, and
`pnpm check` as one command (pnpm is not runnable here).
