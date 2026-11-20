# Impl plan: docs/specs/RL-12.md

Spec: RL-12 revision 5 (approved after review round 4). Release v0.1.31. No migration (schema 11).

## 0. Build order

1. Protocol: `StageCard`, `RunCard`, `RunCardsPage`, `PulseHealth`, `HealthTotal`, `Health` (zod,
   so the OpenAPI document has the responses); `HUB_FEATURES` gains `health` and `pulse-runs`.
2. Store: `listSlots` gains `before` (a keyset position in card order) and `since`, both in SQL;
   `lineageHistory(lineage)` returns the item history of one lineage with each entry's fingerprint
   (indexed on `lineage`).
3. Core: `stageTimes` (pure): `readyAt`, `startedAt`, `waitMs`, `cycleReadyAt`, `waitingMs`.
4. Hub service: `pulseRuns` (batches of `limit + 1` slots until the page is full; `previousComplete`
   looks at most 50 slots further); `runCard`; `health`; `blockedBy` (the `fireSlot` passes, read
   only, with `slotStarted`).
5. Hub app: `GET /v1/pulses/:id/runs`, `GET /v1/health` (rule `member`, scope `goals:read`, not
   wrapped for a person).
6. API document, `pnpm schemas`, docs, version 0.1.31.

## 1. Choices where the spec leaves room

- **One cache per request** (`CardCtx`): goals, item rows and history per lineage, and built cards,
  so a card used as a `delta` base is built once.
- **`runCard` reads** the goal's steps, plans, raising records per step (`listReviews({step})`,
  primary key), artifacts by goal, and `filedItems`/`findingStepsOf` per lineage for `sinks`.
- **`health` reads** every pulse, every goal, steps updated since the window opened (runs), every
  raising record once (lineages), the slots in the window per pulse, the `fired` slots for
  `blockedBy`, and the steps of each open pulse goal for debriefs. Waste parts reuse `runRow`.
- **Cursor:** base64url of `[at, slot]`; a value that does not decode to that shape is the 400.
