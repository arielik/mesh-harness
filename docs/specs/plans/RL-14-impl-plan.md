# RL-14 implementation plan

Spec: [RL-14](../RL-14.md) (approved round 3, revision 4).

| Part | File | What |
|---|---|---|
| Protocol | src/protocol/session.ts | `DAY_MS`, `StateDay`, `SessionStateTime` (`since`, `steps`, `notHeld`), `Session.stateSince`, `Session.stateTime` |
| Protocol | src/protocol/hub.ts | `StateTimeReport`; `SyncRequest.stateTime` (array of unknown, max 500, each parsed alone); `SyncResponse.notHeld`; zod schemas `StateTime`, `SessionTime`, `StepFigures`, `StepEfficiency`, `GoalEfficiency`, `StepWindowRow`, `Rollup`, `EfficiencyWindow`, `Stuck`; `HUB_FEATURES` + `efficiency` |
| Protocol | src/protocol/hub-api.ts | the three routes (tag `analysis`, scope `goals:read`) |
| Core | src/core/state-time.ts | `accrue`, `addInterval` (midnight split, clamp), `liveDays`, `isOpen`, `withHeld`, `selectStateTime` (sending rules), `finalPending`, `apportion`, `totals` |
| Core | src/core/efficiency.ts | `stepCard`, `goalCard`, `stepWindow`, `rollup`, `turnsSinceCommit`, `FIGURE_EVENTS` |
| Daemon | src/daemon/daemon.ts | `accrue` in `commit` and `markWorking`; `applyNotHeld` (through `commit`); tick keeps ended sessions with a pending final entry up to 7 days |
| Daemon | src/daemon/hub-link.ts | `syncedSessions` strips `stateTime`; the first body of a flush carries `selectStateTime` entries; marks remembered on 2xx (`stateTimeSent`); the first reply's `notHeld` goes to `onNotHeld`; `factsFor` clears the memo and, on a real switch of hub or machine, the marks |
| Store | src/store/hub-store.ts | migration 12 (`step_time`, `event_at`) on both dialects; `putStepTime` (guarded upsert), `listStepTimes`, `eventsBetween` |
| Store | src/store/hub-copy.ts | `step_time` in `TABLES` |
| Hub | src/hub/service.ts | `sync`: strip `stateTime` from session records, `notHeld` by `heldBy` (present when the body has a step holder), store entries; `goalEfficiency`, `efficiencyWindow`, `stuck` |
| Hub | src/hub/app.ts | the three routes, not wrapped for a person |
| Docs | docs/guide/concepts.md, operations.md, docs/plan/implementation-plan.md | `## Efficiency`; the 0.1.36 sentence; Probes; API table |
| Tests | pinned feature lists and schema version 12 | m46-ops, health-hub, schemas, store contract |
