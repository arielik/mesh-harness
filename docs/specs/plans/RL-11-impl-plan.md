# Impl plan: docs/specs/RL-11.md

Spec: RL-11 revision 4 (approved after review round 3). Release v0.1.30. No migration (schema 11).

## 0. Build order

1. Protocol (types only): `RunTelemetry.toolsUsed`, `RunTelemetry.denied` with the hub's checks;
   `Round.machine`; `Goal.trial`; `PulseSlot.trial`, `PulseSlot.running`; `PulseFire`; `RunItems`,
   `RunWaste`, `RunRow`, `RunsPage` (zod, so the OpenAPI document has the response); `HUB_FEATURES`.
2. Core: `telemetryFromStream` gains `toolsUsedOf`, `commandWord`, `deniedOf` (AC-01, AC-02).
   `agentStats` takes `trialGoals` and `includeTrial` (AC-10, AC-10b).
3. Hub service: `runReport` stores `machine`; `firePulse(actor, id, body)` and `fireSlot` carry
   `trial` (fired, skipped, and the error path); overlap ignores trial goals and records `running`;
   `createWithPlan` marks the goal; `calibrationScan` returns `counted` (no trial goals) and
   `countedAll` with `trialGoals`; `calibratorFor` rule 2 skips trial goals; `agentStats(key, days,
   trial)`; `listRuns` and `runRow` (AC-03 to AC-12).
4. Hub app: the probes (`/health`, `/healthz` liveness body; `/readyz` + `version`, version imported
   from `package.json`); the fire body; the stats `trial` query; `GET /v1/runs` (`goals:read`).
5. CLI: `mesh pulse fire --trial` and its three lines (the skipped line names `slot.running`, with
   the old guess kept for older hubs); `(trial)` in `pulse show` state text, `goal ls`, `goal show`.
6. API document (`src/protocol/hub-api.ts`), skill (`src/protocol/skill.ts`), `pnpm schemas`; docs.

## 1. Choices where the spec leaves room

- **`listRuns` reads** only steps with `updatedAt ≥ since` (the spec's implementation note), then
  filters rounds in memory, and reads each goal once. Item states come from `getItem` per distinct
  fingerprint of the round's raising record; only the rows of the returned page are joined.
- **Cursor:** base64url of `[finishedAt, goal, step, round]`; a cursor that does not decode to that
  shape is the 400. Rows after the cursor are those that sort strictly after its key, so a row that
  arrives later with an older `finishedAt` is not on later pages of the same walk (the guide's
  "poll with an overlap" covers it).
- **Sorting** uses JavaScript string `<` (UTF-16 code units) on both sides: the daemon's
  `toolsUsed`/`denied` order and the hub's check of `toolsUsed`.
- **`denied` distinctness** at the hub: the key `tool + "\n" + ("-" | "+" + command)`, so an entry
  without `command` and one with an empty-looking command can never collide.
- **Liveness** builds its body per request from constants; it never touches the store.
- **Agent statistics:** the windowed loops skip trial goals unless `includeTrial`; the counted
  dismissals loop always keeps trial dismissals out of `uncalibrated`/`calibrating`/`calibrated` and
  `anyDismissalAt` (the `lastAt` fallback), and counts them in `dismissedBy*` only with
  `includeTrial`. `reinstated` filters on the dismissal entry's goal.

## 2. Files

`src/protocol/{goal,pulse,hub,hub-api,skill}.ts`, `src/core/{telemetry,calibration}.ts`,
`src/hub/{service,app}.ts`, `src/cli/{pulse-commands,hub-commands,show}.ts`, `schemas/hub-api.openapi.json`,
`skills/mesh/SKILL.md`, `docs/events.md`, `docs/guide/{concepts,scheduled-reviews,operations}.md`,
`docs/plan/implementation-plan.md`, `package.json` (0.1.30).
