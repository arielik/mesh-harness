# RL-19 implementation plan: findings roll-up per preset and repo

Spec: `docs/specs/RL-19.md` (approved in round 2, revision 3).

| AC | Change | Files |
|---|---|---|
| AC-08, AC-12 | `PRESET_KIND_RE`, `presetKindProblem(doc)`, `presetKind(text)`; `Preset.kind`; `parsePreset` reads a valid kind and leaves an invalid one out; `presetText` writes it after `description` | `src/core/presets.ts` |
| AC-08 | `presetChecks(preset, params, {kind})`: the kind problem only for a preset sent in the request (create, update with `preset`, ingest) | `src/hub/service.ts` |
| AC-12 | `findPresetSource` throws the kind problem for a repo file; `mesh preset ls` lists it as `invalid:` | `src/cli/hub-commands.ts` |
| AC-10 | `listReviews({since})`; `listItemsIn(lineages)` chunked at 500, sorted by lineage then fp; `listArtifacts({steps})` chunked at 500, sorted by createdAt then id | `src/store/hub-store.ts` |
| AC-01..AC-07 | `findingsRollup(q)`: validation, one transaction, reads of the spec's *Reads*, rows, home/source lineages, kind, pulse, lastRaisedAt, latestReport, filters, order | `src/hub/service.ts` |
| AC-09 | `GET /v1/findings/rollup` (member, `goals:read`, not `forPerson`); `findings-rollup` in `HUB_FEATURES`; pinned feature arrays in tests | `src/hub/app.ts`, `src/protocol/hub.ts`, tests |
| AC-01 | `BySeverity` exported; `RollupReport`, `RollupRow`, `FindingsRollup` | `src/protocol/hub.ts` |
| AC-11 | route in the API registry; guide sections; operations sentence and feature list; API table; `node scripts/schemas.ts` | `src/protocol/hub-api.ts`, `docs/**`, `schemas/*` |
