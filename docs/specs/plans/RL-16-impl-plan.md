# RL-16 implementation plan: profile fitting

Spec: [RL-16](../RL-16.md), approved in round 2.

1. **Protocol** (`src/protocol/hub.ts`): `PROFILE_FIT`, `FitHeld`, `ProfileFitHash`, `FitDenied`,
   `FitUnused`, `ProfileFit` (zod, for the OpenAPI document); `HUB_FEATURES` gains `profile-fit`.
2. **Core** (`src/core/profile-fit.ts`, exported from `src/core/index.ts`): `fitProfile(input)`,
   pure. Hash split, sample and tool runs; denied groups with the reasons in spec order; unused tools
   with theirs; `refused` through `parseProfile` of the profile file plus the diff so far plus the
   candidate (serialized with `yaml`); `RUNS_ANYTHING`, `denyCovers` (glob first words,
   server-wide MCP rules), `NEVER_DROP` (`Skill`); cap 200 with `truncated`.
3. **Hub** (`src/hub/service.ts` `profileFit`, `src/hub/app.ts`): parse `days` (as health) and
   `trial` first, then in one transaction read the profile view (404), `listSteps({updatedSince})`,
   the rounds with telemetry of that profile in `[since, until]`, their goals (trial filter), and call
   `fitProfile`. Route `GET /v1/profiles/:name/fit`, member, `goals:read`, not `forPerson`.
4. **API description** (`src/protocol/hub-api.ts`): the route, query, `ProfileFit` response.
5. **CLI** (`src/cli/artifact-commands.ts`): `mesh profile fit <name> [--days N] [--include-trial]
   [--json]`, `formatProfileFit` (lines 1-8 of the spec), usage and summary.
6. **Docs**: concepts `## Profile fitting` after `## Runs`; operations sentence; API table row;
   skill row (`src/protocol/skill.ts`); `node scripts/schemas.ts`.
7. **Tests**: pinned feature lists in `test/m46-ops.test.ts` and `test/health-hub.test.ts`; new tests
   per the test plan.

No migration, no event, no stored field.
