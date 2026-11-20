# RL-17 implementation plan

Spec: [RL-17](../RL-17.md). No migration.

1. **Store** (`src/store/hub-store.ts`): `eventsOfTypes(types)` (one `type IN (…)` query, log order)
   and `eventsOf({type, goal|step})` (through the indexed `goal` / `step` columns).
2. **Pure timeline** (`src/core/changes.ts`, exported from `src/core/index.ts`): `Sighting`,
   `sightingCmp` (time, source event < goal < run, seq, goal, step, round), `entryCmp` (`firstSeen`
   descending, kind, key, hash) and `timeline(sightings)` (first sighting, count, `previous` = the
   next entry of the same kind and key in entry order).
3. **Statistics** (`src/core/calibration.ts` `agentStats`): optional `until` (exclusive) and
   `keepStep`, applied to every windowed count; the stats route passes neither.
4. **Service** (`src/hub/service.ts`):
   - `queryTime` lifted out of `listRuns` (same texts) and reused;
   - `changeCursor` (base64url JSON of `[firstSeen, kind, key, hash]`);
   - `changes(q)`: validate; in one transaction collect goal sightings (preset hash from the goal's
     text), run sightings (every round with telemetry), and, without `repo`, registration events
     (`profile.saved`, `pulse.created`, `pulse.updated` with `sha256`, `catalog.pushed` mapped to
     catalog definitions by the first push whose commit the definition lists); filter by kind/key,
     repo and trial; `timeline`; window by `firstSeen`; page; resolve the introducing event of the
     page's goal and run sightings only;
   - `agentCompare(key, q)`: validate; `calibrationScan`; `computeAgentStats` with `since ?? 0`,
     `until`, `keepStep` (repo) for `items`; for `runs`, the key's rounds with that hash, in
     `GET /v1/runs` order, through `runRow` for the waste parts;
   - `pinsOf(pulse)`: `agents` payload on `pulse.created`, and `preset`, `sha256`, `agents` on a
     `pulse.updated` whose body has `preset` or `params`.
5. **Routes** (`src/hub/app.ts`): `GET /v1/agents/:key/compare` (key decoded as the stats route)
   and `GET /v1/changes`, rule `member`, scope `goals:read`, not `forPerson`.
6. **Protocol** (`src/protocol/hub.ts`): `ChangeEvent`, `ChangeEntry`, `ChangesPage`, `CompareRuns`,
   `HashSide`, `AgentCompare`; `HUB_FEATURES` gains `agent-compare`, `changes`.
   `src/protocol/hub-api.ts`: both routes; `node scripts/schemas.ts`.
7. **Docs**: concepts `## Changes and before/after`, events (pulse payloads), operations (upgrade
   sentence, probes feature list), implementation plan API table.
