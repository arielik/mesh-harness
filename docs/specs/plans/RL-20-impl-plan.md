# RL-20 implementation plan

1. Protocol (`src/protocol/pulse.ts`): `PresetCheck` (strict body), `PresetCheckResult`, `PulseDetail.steps?`.
   `src/protocol/hub.ts`: `preset-check` in `HUB_FEATURES` (sorted). `src/protocol/hub-api.ts`:
   `HubApiRoute.read?: true`, the route (tag `analysis`, scope `goals:read`, `read: true`), no
   idempotency-key parameter for `read` routes, the document description "POST routes that write".
2. Service (`src/hub/service.ts`):
   - split `presetChecks` into `presetProblems` (collects the 422 problems, returns the plan when it
     instantiated; 400 on sha256 first) and the unchanged throwing wrapper (422, then `checkSinkTopics`);
   - `checkPreset(actor, body)`: one `store.tx`; `presetProblems` with `kind: true`; each sink topic
     through `sinkTopic` on a copy of the steps, every 400 text appended once; `pinAgents` for the
     pins; `pulseWarnings` (now taking `{preset, params, agents}`) for warnings; `steps`/`agents` only
     when `ok`;
   - `pulseDetail`: `steps` from the stored snapshot, absent when it does not instantiate.
3. App (`src/hub/app.ts`): `Route.read`, the route with `read: true`, the idempotency key ignored on
   `read` routes.
4. Docs: concepts (Pulses: Check a preset), auth (`goals:read`), operations (feature list, upgrade
   sentence), implementation plan (API table). `node scripts/schemas.ts`.
5. Pinned feature arrays: `test/m46-ops.test.ts`, `test/health-hub.test.ts`.
