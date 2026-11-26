Verdict: APPROVED | Round: 1 | Blocking-open: 0

# RL-24 implementation review, round 1 (ad8a0dc..9841dad, row B-250)

- Reviewer: cold code reviewer, Claude Opus 5.5 (claude-opus-5-5). I did not write this code.
- Date: 2026-11-26
- Spec: docs/specs/RL-24.md, revision 3 (spec review r3 APPROVED, mesh-ai `reviews/B-250/r3-spec.md`).
- Diff: 10 commits, 33 files, +1832/-83. Test commits come before the feature commit for each area.

## What I ran

- `tsc --noEmit && tsc --noEmit -p web`: clean.
- `eslint .`: clean. `depcruise src`: no violations (220 modules).
- `tsdown` + `vite build`: clean.
- `vitest run` (full suite): 150 of 152 files pass, 2996 tests pass, 109 skipped, 4 fail. The 4 failures
  are `test_AC16_version`, `test_AC19_version` and `test_AC13_version` in test/schemas.test.ts, and
  `test_AC10_skill_and_version` in test/docs-rl13.test.ts. Each one pins `package.json` at `0.1.40`.
  The base commit ad8a0dc already has `0.1.41`, and the diff touches neither these assertions nor
  package.json, so the failures were there before this diff. The row says not to bump the version.
- The RL-24 files (fleet-pause, -replicas, -daemon, -cli, docs-rl24) and the changed suites
  (health-hub, m46-ops, my-mesh, schemas, docs-rl19, src/store) pass. `MESH_TEST_PG_URL` is unset
  here, so I did not run the Postgres parts of AC-11 and AC-17. The CI `postgres` job lists both
  files as AC-11 and AC-17 require.
- The nested `pnpm check` cannot run in this environment because the pnpm shim is broken. I ran
  each step separately instead.

## AC coverage

Each AC has a test that fails without the change: the routes, scope, migration, `paused` fields and
`fleet_paused` reason did not exist before. Hub: AC-01 to AC-12, AC-17, AC-19 and AC-20 are in
test/fleet-pause.test.ts and test/fleet-pause-replicas.test.ts. Daemon: AC-13 to AC-15 are in
test/fleet-pause-daemon.test.ts and use the real daemon against the World with fake claude. CLI:
AC-16 is in test/fleet-pause-cli.test.ts. AC-18: test/docs-rl24.test.ts covers the unit part. For
the integration part, test/hub.test.ts and test/pulse*.test.ts are unchanged and still pass. The
only edits to existing assertions add `paused: null`, `fleet-pause` or schema 13 (my-mesh, m46-ops,
health-hub, store contract, schemas). That is the additive change REQ-COMPAT-1 allows.

## Correctness and rules checked (no defect found)

- Offer paths. `offerStepMessage` is the only place that sets `state: "offered"` (service.ts:745).
  Each of its callers is gated:
  - `stickOffer`, which `emitReady` and the resume share, holds a headless step.
  - Step assign refuses when the step is declared headless or has a run.
  - Goal assign leaves the step out, holds it under `stick`, and refuses only when the pause alone
    emptied the list.
  - `attempt` is reached only through `advanceSlot` (`!paused`) and `slotGoal`, and `slotGoal` only
    through `fireSlot` (manual fire and `fireDue` are gated) or `releaseQueued` (gated).
- Every `emitReady` caller runs inside `goalTx`, so the read-modify-write of `held` is serialised as
  §Stored state requires.
- Pause:
  - The admin check and the "already paused" check run before any write.
  - Every open headless offer goes through `withdrawOffer` (`fleet paused`, `user` = the person,
    no message; AC-07a checks the inbox).
  - For the pulse run step, the undecided last try for the same machine is removed. `pendingSlotOf`
    is read before the withdrawal.
  - The row, the event and the cache (through `afterCommit`) are all handled in one transaction.
- Resume:
  - Only `held` ids are re-offered. Done or dropped goals, goals without a stick, and the pulse run
    step are skipped. The row is cleared first, so `stickOffer` offers instead of holding again.
  - Counters come from the stored row. Nothing is fired.
- Tick:
  - `fireDue` replaces exactly the `fireSlot` call. `catchUp` follows the same `inWindow` test, and
    `hub_down` and `nextAt` are unchanged.
  - `advanceSlot` makes no attempt while paused. At the end of the window it records
    `missed`/`fleet_paused` and counts it.
  - `releaseQueued` skips the slot where `slotGoal` would have run (without `running`) and counts it.
- Rights:
  - `actingFor` keeps only `person.roles ∩ route.keep`.
  - Only the two fleet routes set `onBehalfOfRoles: ["admin"]`, in both `HUB_API` and the served
    routes. AC-02 asserts this for both lists.
  - Both routes set `onBehalfOf` and `onBehalfOfRequired`, so a service without the header gets
    `400 on-behalf-of-required`. A service without the scope gets `403 forbidden`.
  - Roles are read at request time: carol, demoted, is refused.
  - The idempotency key is `via>user`.
- Input validation: strict zod, reason trimmed to 1 to 500 characters, resume body optional.
- `/healthz` makes no store call. A store spy over every method checks this.
- Replicas:
  - The pause is loaded before the server listens. A load failure closes the bus and the store.
  - The refresh timer is cleared in `stop()`, and AC-11 checks `getTimerCount() === 0`.
  - A failed refresh logs once per failure streak.
- Daemon:
  - `onPaused` fires only when the reply has the field.
  - No notification for the first reply or a reply that changes nothing, and none when `notify` is
    off.
  - The queue pass skips starting runs but still releases runs past their deadline.
  - A refused accept goes down the existing 4xx `failed` ack path with no decline.
- Scope: changes stay within the fleet routes, `/healthz`, the sync reply, pulse slot handling and the
  daemon pause handling. Nothing touches the decision routes (B-249) or stop and teammate offers
  (B-252). package.json is unchanged and no cost field is added (test_AC18_no_cost_field).
- Docs and OpenAPI: auth.md, operations.md (including the public-reason warning, the 5 s lag, older
  daemons, and the upgrade paragraph with migration and re-mint), scheduled-reviews.md, howto.md,
  events.md and the regenerated hub-api.openapi.json are in sync with the code.

## Findings

1. **MINOR: the pause reply has a field the spec does not define.** `FleetState` (src/protocol/hub.ts)
   adds `withdrawn?: number`, and `pauseFleet` returns `{ paused, withdrawn }` (service.ts:7342).
   The spec fixes `FleetState = { paused }` and AC-03 says the reply is `{ paused: {...} }`. The
   field is additive and §CLI needs it: `mesh fleet pause` prints the count, and the spec gave no
   other source for it. The OpenAPI document lists the field. Record it in the spec (a revision note
   on §Interface contracts and AC-03) so the client part of B-250 can rely on it.
2. **MINOR: `/healthz` on the replica that served a change can briefly show the old value.** The
   timer's re-read (server.ts:96-106, service.ts:7270) is not ordered against the `afterCommit`
   assignment (service.ts:7339, 7368). A re-read that starts before the commit and finishes after it
   writes the old value back over the new one until the next tick. The gap is bounded by
   `pauseRefreshMs`, so REQ-FLEETPAUSE-8 (5 s) still holds. §/healthz, however, says the serving
   replica sets the value after the commit. Enforcement never reads the cache. A generation counter
   in `refreshPause` (drop a read that started before the latest local set) would close the gap.
3. **MINOR (spec gap, behaviour as specified): a restarted daemon can start a queued run while the
   fleet is paused.** `fleetPaused` is kept in memory and starts as `undefined`, which means "not
   paused". Queued runs are kept on disk (runs.ts:198). The daemon reconciles once at start
   (daemon.ts:539), so a queued run can start before the first sync reply. This matches §Daemon
   ("undefined: treated as not paused") but leaves a narrow hole in the kill switch. Suggested
   follow-up, not for this row: persist the last value, or skip `queuePass` starts until the first
   sync reply.
4. **MINOR: refusal order on step assign.** The `fleet-paused` check (service.ts:883) runs before
   `callerMachine` and `refuseForeign`, so a caller whose `sid` is foreign gets `409 fleet-paused`
   instead of today's `403`. The spec fixes the order only for pulse fire and goal assign. Moving
   the check after `refuseForeign` would match the "today's refusals first" rule used for pulse
   fire and accept.
5. **MINOR (tests):**
   - test_AC01_rights_table checks "no call answers `on-behalf-of-not-accepted`" against the event
     feed, which never contains refusal codes. That assertion cannot fail. The per-call `code`
     assertions in the same test already cover the requirement, so the line is redundant.
   - AC-17's Postgres part tests the SQLite-to-Postgres copy of a paused state but not a schema-12
     Postgres database migrating to 13. The store contract's PG version checks cover the migration
     list only indirectly.

No BLOCKING or MAJOR findings. All five are MINOR and none blocks the R3 gate.
