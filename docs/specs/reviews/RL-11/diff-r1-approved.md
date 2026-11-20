Verdict: APPROVED | Round: 1 | Blocking-open: 0

# Review of the RL-11 diff, round 1

This is a cold review of `git diff main...impl/RL-11` (head 5bae40f) against `docs/specs/RL-11.md`,
revision 4 (approved). I read the spec reviews r1, r2 and r3 first, then the impl plan and the test
plan. This is the first diff round, so every finding is **NEW**.

Read: `src/core/telemetry.ts` (`toolsUsedOf`, `commandWord`, `deniedOf`, `telemetryFromStream`),
`src/core/calibration.ts` `agentStats`, `src/hub/service.ts` (`runReport`, `firePulse`, `fireSlot`,
`createWithPlan`, `calibrationScan`, `calibratorFor`, `calibrationTrigger`, `listRuns`, `runRow`,
`agentStats`, the `runCursor` helpers), `src/hub/app.ts` (probes, fire body, stats `trial`,
`GET /v1/runs`), `src/protocol/{goal,pulse,hub,hub-api,skill}.ts`, `src/cli/{pulse-commands,
hub-commands,show}.ts`, `src/daemon/runs.ts` `telemetry` (it spreads the stream telemetry, so both
new fields reach the hub), `src/store/hub-store.ts` `listSteps`, the docs (events, concepts, scheduled
reviews, operations, API table, skill), and the tests `src/core/telemetry.test.ts` (RL-11 part),
`test/runs-hub.test.ts`, `test/trial-hub.test.ts`, `test/trial-cli.test.ts`, `test/docs-rl11.test.ts`,
the RL-11 changes to `test/m46-ops.test.ts` and `test/schemas.test.ts`.

No CLAUDE.md. The public-boundary rule holds: the names in code, docs and tests are generic (`ann`,
`bob`, `carol`, `alpha`, `beta`, `p-1`, `box-a`).

## Process checks

| Check | Result |
|---|---|
| Tests written from the spec | The tests came in the same branch as the code (c416318, 5bae40f); there is no separate `test/RL-11` branch, so I could not run "failed first". I checked by reading which tests can fail on the FAIL state of their AC (S1–S4 below list the gaps). |
| No assertion on source text | **Yes.** The tests read docs, generated files and `package.json` only. |
| Older test files | Only the version pins in `test/schemas.test.ts` (0.1.29 → 0.1.30, as AC-16 needs) and the probe bodies in `test/m46-ops.test.ts` (as AC-14 needs) change. |
| Generated files | `node scripts/schemas.ts` (what `pnpm schemas` runs) leaves the tree clean. |

## What holds

- **Telemetry.** `toolsUsedOf` reads every `tool_use` block of every `assistant` event (subagent
  events included, with or without a `result`), skips non-string or empty names, cuts to 200, then
  de-duplicates, sorts with JavaScript `<` and keeps 200. `deniedOf` skips entries without a
  non-empty string `tool_name` (they still count in `permissionDenials.count`, which stays
  `denials.length`), cuts the tool to 200, and sets `command` only for `Bash` with a string
  `tool_input.command`. `commandWord` skips `NAME=value` words with the spec's pattern, keeps the
  part after the last `/` and cuts to 64. The grouping key cannot collide (`0` vs `1<cmd>`). The sort
  is count desc, tool, command (absent first), and the list is cut to 50. Both keys are absent when
  empty. The hub's zod checks match: `toolsUsed` 1–200 entries of 1–200 characters, strictly
  ascending; `denied` 1–50 strict entries, `command` 1–64, `count` ≥ 1, distinct by `(tool, command)`.
  The daemon cannot produce a `command` of `""` (`git/` gives none), so its output always passes.
  A probe (below) confirmed this for odd inputs: assistant events without `message`, non-array
  `content` or `permission_denials`, non-object denials, `tool_input` as a string, `￿` against an
  astral name. Lone surrogates from a cut survive storage, because `JSON.stringify` escapes them.
- **Machine.** `runReport` adds `machine: actor.machineId` only when the `finished` report carries
  a round and telemetry.
- **`GET /v1/runs`.** Parameter checks and messages are exactly the table's. The `since` default is
  `now − 30 d`, and `until` alone is not a 400. The window is `[since, until)` on `round.finishedAt`.
  Every round with telemetry of any step (dropped and moved-away included) is listed. Rows are
  ordered by `finishedAt` desc, then goal, step and round. The cursor is base64url of the full sort
  key, the next page holds the rows strictly after it, and `next` appears only when more rows match.
  So pages have no duplicates or gaps across ties. `runRow` fills every RunRow field as the table
  states. `items` is present only with a raising record of that round, counts distinct fps and reads
  the item states now. `waste.failed` is `outcome === "fail"`, and `allDismissed` needs `raised > 0`.
  The `updatedSince` read is safe: every path that closes a round or stores telemetry saves the step
  with the hub's `now`.
- **Trial fires.** `PulseFire` is strict, and an empty body parses to `{}`. `trial` is set on the
  fired slot, the skipped slot and the error-path `missed` slot, and on the goal. It appears in the
  `pulse.fired` and `goal.created` (via `extra`) payloads, and not in `pulse.skipped` or
  `pulse.missed`. Overlap ignores trial goals. A trial fire is still skipped by a running non-trial
  goal, and every overlap skip records `running`. Retiring and abandoning do not change.
- **Counting.** `calibrationScan` computes `countedAll` once and filters out trial goals by the
  dismissal's own goal (`c.ref.goal`, the entry's goal). Because `countedDismissals` dedupes per
  `(goal, lineage, fp)`, filtering afterwards gives the same result as computing without trial
  entries. `calibrationTrigger` and the calibration goal's list use `counted`. `calibratorFor` rule 2
  skips trial goals. `agentStats` applies `out(goal)` to runs (the step's goal), records
  (`record.goal`), acceptances (`entry.goal`) and reinstatements (the dismissal `e`'s goal). Counted
  dismissals count in `dismissedBy*` and `lastAt` only with `include`, and never in
  `uncalibrated/calibrating/calibrated` or the `anyDismissalAt` fallback. A hash used only in trial
  goals has all counts at 0 and drops out by default. Hand-checking AC-10 and AC-10b against this
  code gives the spec's numbers, and the tests assert them.
- **Probes.** `/health` and `/healthz` build `{ok, version, schema, features}` from constants, with
  no store call. `/readyz` adds `version` to both replies. `package.json` is imported with
  `with { type: "json" }`, and a tsdown build inlines it once (`"0.1.30"` appears once in
  `main.mjs`).
- **CLI.** The three fire lines, ` (trial)` after the slot id, `slot.running` with the old guess kept
  for older hubs, `--help`, and the markers in `goal ls --pulses`, `goal show` and `pulse show` all
  match the contract.
- **Compatibility.** No migration. Every new field is optional JSON. An older daemon sends neither
  field. A newer daemon's fields are stripped by an older hub's non-strict `RunTelemetry`. An older
  CLI's bodyless `POST …/fire` still fires.
- **Docs.** Every item of the Docs list is present and agrees with the code (see S8 for small gaps).

## impl_findings

No blockers.

### S5 (NEW, suggestion): `?goal=` (empty) lists every goal's rows
`listRuns` passes `goal: ""` to the store (`src/hub/service.ts:3845`), and `listSteps` drops a
falsy filter (`src/store/hub-store.ts:804` `if (filter.goal)`). So `GET /v1/runs?goal=` returns the
rows of all goals, while `?pulse=`, `?repo=`, `?agent=` and `?user=` with an empty value return none.
The spec says "an unknown goal gives no rows". Fix: in `listRuns`, also check `step.goal` against
`q.goal` (case-insensitively, as the store does), or return `{runs: []}` early when `q.goal === ""`.

### S6 (NEW, suggestion): `mesh pulse fire --trial` against a pre-0.1.30 hub fires a production goal without a warning
The CLI sends `{trial: true}` (`src/cli/pulse-commands.ts:253`). An older hub ignores the body and
fires a normal manual slot, which then blocks the schedule and counts in statistics and calibration,
which is what `--trial` is meant to avoid. The only sign is that ` (trial)` is missing from the
output line. The spec puts the hub upgrade first, but a person's CLI is often newer than the team
hub. Fix: when `--trial` was given and the reply's slot has no `trial`, print to stderr "this hub
does not know trial fires (mesh < 0.1.30); the slot was fired as a normal one" and exit non-zero.
Alternatively, check `features` from `/healthz` before firing. Also say this in
`docs/guide/operations.md` "Upgrading to 0.1.30".

### S7 (NEW, suggestion): `GET /v1/runs` does N+1 reads inside the serialized transaction
For each row of the page, `runRow` makes one `listReviews({step, raising})` call, which reads and
parses every raising record of the step (`src/hub/service.ts:3881`), plus one `getItem` per distinct
fp (`:3887`). A page of 1000 audit rows with 30 items each is about 31 000 store calls in one
`store.tx`. On SQLite that holds the process's single transaction turn (`BEGIN IMMEDIATE` plus the
in-process queue) and blocks every write meanwhile. On Postgres it is one round trip per call. Each
page also re-reads and re-parses every step updated in the window. This is the same shape as
`agentStats`, so it is acceptable for 0.1.30, but it grows with the page size. Fix: cache
`listReviews` per step within a call, and read item rows per lineage once (`listItems({lineage})` or
a bulk `getItems`). Consider whether the route needs a write-serializing transaction at all.

### S8 (NEW, nit): small mismatches
- `src/core/telemetry.ts:46-47`: the comment says "Code-point order" and the helper is named
  `byCodePoint`, but `<` is UTF-16 code-unit order, which the spec deliberately names (r3 S15/S19).
  Rename it to `byCodeUnit` and fix the comment.
- `src/protocol/hub-api.ts:51`: `const Liveness` sits between two `import` statements. Move it below
  the imports.
- The spec puts "the probe bodies" in `hub-api.ts`. `/readyz` has no `response` schema there
  (`:92`); add `{ok, schema?, error?, version}`.
- `commandWord("git/")` (and `"/"`) gives no `command`, while the spec only defines "no word left".
  The behaviour is right because the hub refuses `""`. Mention it in concepts `## Telemetry` ("a word
  that ends in `/` gives no command").
- `stateText` also adds ` (trial)` to the `last …` column of `mesh pulse ls`
  (`src/cli/pulse-commands.ts:141`). The spec does not mention it. It is harmless and arguably
  useful, but no test pins it.

## test_findings

No blockers. The implementation of each point below is correct by reading, but the test would
pass for a wrong one.

### S1 (NEW, suggestion): AC-09 CLI test cannot tell `slot.running` from the old guess
`test_AC09_skipped_names_the_running_goal` (`test/trial-cli.test.ts:71-83`) has a single fired slot.
The pre-0.1.30 guess (`d.slots.find(fired && not done)`) therefore also gives `normal.goal`, and the
test passes with the old CLI code. The AC's own words are "taken from the slot's running (not guessed
from the slot list)". Fix: assert that the CLI made no `GET /v1/pulses/p-1` call when `running` is
present (the relay's request log), or build a slot list whose newest unfinished fired goal is not the
running one (a newer goal parked on its owner, as in RL-3's debrief overlap tests).

### S2 (NEW, suggestion): the 30-day default window is only bounded to (3 d, 31 d)
`test_AC05_filters` (`test/runs-hub.test.ts:194, 208`) shows rows 1–3 days old and leaves out a row
31 days old. A 7-day default passes. The AC's FAIL column includes "a default window other than 30
days". Fix: add a row 29 days old and assert that the default list contains it.

### S3 (NEW, suggestion): "no body → fires as today" is not tested
`Pk.act` defaults the body to `{}` (`test/helpers/pulse-kit.ts:170`), the World `call` sends a body
whenever one is given, and the CLI now always sends `{}`. No RL-11 test posts `…/fire` without a body,
so nothing pins what an older CLI does (an empty body must parse to `{}`). Fix: one call with
`body === undefined` and an assertion that the slot fires without `trial`.

### S4 (NEW, suggestion): AC-02 asserts less than it states
- `test_AC02_cap` (`src/core/telemetry.test.ts:272`) checks only `length 50` and `count 60`, not
  which 50 are kept or their order (count desc, then tool, then command in code-unit order: `cmd0`,
  `cmd1`, `cmd10`, …). Assert the exact list.
- "The output of every case passes the hub's validation": `test_AC02_passes_hub_validation` checks
  two synthetic streams, not the outputs of `grouping`, `no_word` and `cap`. Run `RunTelemetry`
  over each case's output, or loop over all of them.

### S9 (NEW, observation): fixtures differ slightly from the AC text
- AC-10: goal T's 3000 ms run is reported in a second trial goal TR (`test/trial-hub.test.ts:182-184`),
  not in T. The counts do not depend on it, because runs belong to their own step's goal.
- AC-04: the audit row carries 2 denials (`waste.denials: 2`), where the AC says 0. The assertion is
  consistent with its fixture.
No change needed. Note it in the test plan if the AC text should match.

## Checks

Run on impl/RL-11 (Node 24.22.2):
- `node_modules/.bin/tsc --noEmit` and `tsc --noEmit -p web`: clean.
- `node_modules/.bin/eslint .`: clean.
- `node_modules/.bin/depcruise src --config .dependency-cruiser.cjs`: no violations.
- `node_modules/.bin/vitest run` on the RL-11 files with `schemas.test.ts` and `m46-ops.test.ts`:
  7 files, 137 passed, 9 skipped (Postgres legs).
- `node_modules/.bin/vitest run` on the full suite: 116 files, 2709 passed, 102 skipped.
- `node scripts/schemas.ts` (what `pnpm schemas` runs): no diff.
- `tsdown -d <scratchpad>`: the build succeeds, and `package.json`'s version is inlined.
- A scratch probe of `commandWord`, `deniedOf` and `telemetryFromStream`: edge inputs, plus the
  output parsed by the hub's `RunTelemetry`.

Not run: the Postgres legs (`MESH_TEST_PG_URL` unset), `pnpm test:web`, and `pnpm check` as one
command (pnpm is not runnable here; its parts above were run one by one, except the web build).
