Verdict: APPROVED | Round: 1 | Blocking-open: 0

# RL-17 diff review, round 1 (commit d56e66b)

Reviewed against `docs/specs/RL-17.md` (revision 2) and `docs/specs/plans/RL-17-test-plan.md`.
Checks run: `tsc --noEmit` clean; `test/changes-hub.test.ts` (14 tests),
`test/calibration-hub.test.ts`, `test/runs-hub.test.ts`, `test/health-hub.test.ts`,
`test/m46-ops.test.ts`, `test/pulse-hub.test.ts`, `test/docs-rl17.test.ts`, `test/schemas.test.ts`
and `src/store/hub-store.contract.test.ts` all pass (SQLite; the Postgres legs were skipped because
`MESH_TEST_PG_URL` is not set).

## Contract check

- Routes, rule `member`, scope `goals:read`, not wrapped with `forPerson` (so on-behalf-of → 400):
  `src/hub/app.ts:342-388`. AC-10 test asserts 200/403/401/400 for both routes.
- 400 texts: `kind`, `limit` (1-500), `trial` (exclude|include), `since`/`until` (shared
  `queryTime`, `src/hub/service.ts:282`; `since ≥ until`), `cursor`, `from`/`to` required and
  ≤ 200, key without `/`: all match the spec tables (`service.ts:4392-4404`, `4520-4531`).
  Empty values (`?kind=`, `?trial=`, `?since=`, `?cursor=`, `?limit=`, `?from=`) all give 400.
- Sightings (`service.ts:4410-4467`): goals (preset sha256 of `goal.preset.text`, repo
  `primaryRepo`), every round with telemetry of `listSteps({})` (agent only with both key and hash;
  profile always), and the four event types via one `eventsOfTypes` query. Event sightings are
  skipped entirely under `repo`; trial applies to run and goal sightings only. `catalog.pushed`:
  for each stored definition of the pushed source whose `commits` contain the commit, only the first
  such event in seq order (`firstPush`), so an unchanged re-push is not a sighting and a
  definition with several commits is sighted once. Pulse events count only with `sha256`; `pulse`
  ref taken from the payload of `pulse.*` events.
- Timeline (`src/core/changes.ts`): first sighting by time, then source rank event < goal < run,
  then seq / goal / (step, round); `sightings` counts all counted sightings; `previous` computed over
  all entries before `since`/`until`/cursor/limit; entry order `firstSeen` desc then kind, key, hash.
  The key filters are applied per sighting before the timeline, which is safe because `previous` is
  per `(kind, key)`.
- Introducing event: event sighting → itself; goal → first `goal.created` with that goal (indexed
  `goal` column); run → first `run.finished` of the step whose `payload.runId` matches (indexed
  `step` column, seq order). Absent when pruned. `user` omitted when null.
- Paging: `next` encodes `[firstSeen, kind, key, hash]`; the cursor filter uses the same order as
  `entryCmp`; `next` only when more entries remain.
- Compare runs (`service.ts:4555-4590`): same selection as `GET /v1/runs` (repo, `[since, until)`,
  agent key, trial exclude/include, goal must exist), summed in `/v1/runs` order via
  `runCursor.cmp`; `costRuns`, waste parts from `runRow`; `firstAt`/`lastAt` only with runs.
- Compare items: `computeAgentStats` with `since ?? 0`, optional `until` and `keepStep` (step →
  repo). Raising agent still decided over all records (`o.raising` unfiltered). Dispositions are
  filtered by the recording step (`e.step`, `c.ref.step`, `n.step`), as the spec requires.
- Stats route unchanged: `beyond()` (`src/core/calibration.ts:205`) is `false` when neither
  `until` nor `keepStep` is passed, and it is only OR-ed into existing `continue` conditions; the
  stats route (`service.ts:4375`) passes neither. `calibration-hub.test.ts` passes.
- Event payloads: `pinsOf` (`service.ts:314`) sorted by key then hash, de-duplicated, absent when
  empty; on `pulse.created` and on `pulse.updated` only when the body has `preset` or `params`. The
  topics-removal `pulse.updated` (`service.ts:2308`) is untouched, as the spec says.
- `HUB_FEATURES` = `["agent-compare","changes","commits","health","pulse-runs","runs","trial"]`.
- Store reads (`src/store/hub-store.ts:1458-1470`): plain parametrised `SELECT * FROM event ...`
  with `IN (?, …)` / `= ?`, the same shape as the existing `eventsFor`, so portable to Postgres;
  covered by the store contract suite (both drivers when PG is configured).
- Docs, OpenAPI, test-plan names: present; docs and schemas tests pass.

## Findings

No blocking findings.

S1. Run introducing-event lookup by `runId` is not exercised. `service.ts:4493` picks the
`run.finished` whose `payload.runId` equals the run's; every test step has one round, so replacing
`.find(runId)` with "the last event of the step" survives (mutation M18). Add a two-round step (or a
re-reported run) to AC-02 and assert the first round's entry links its own event.

S2. The source tie-break (event before goal before run at the same millisecond,
`src/core/changes.ts:40`) is not tested (M26 survives). A pulse fire at the same clock tick as the
pulse save would pin it; not an AC, so a suggestion.

S3. `next` on an exact multiple is not tested: `rest.length >= limit` instead of `>` survives (M21)
because 5 entries with `limit=2` never end on a full page. Add one more page check, e.g. `limit=5`
(or 4 entries with `limit=2`) and assert no `next` on the last page.

S4. The catalog source match (`d.source !== repo`, `service.ts:4455`) is not tested (M33): the
AC-03 world has one source. Two sources that push the same commit id (or one source with
definitions another source also lists) would catch it.

S5. `?repo=` (empty) matches goals without a `primaryRepo` because of `g.primaryRepo ?? ""`
(`service.ts:4419`); such a goal has no repo and should not be counted under any `repo`. Harmless in
practice (clients do not send an empty repo); either skip goals without `primaryRepo` when `repo`
is given or leave as is.

S6. The AC-08 `repo` check cannot tell "recording step" from "raising step": the debrief and the
audit are in the same repo. The code is right (`c.ref.step`, `e.step`), but a person dismissal
recorded in a step of another repo would pin the spec's wording.

S7. "binary strings" ordering uses JS `<` (UTF-16 code units, `changes.ts:35`, `textCmp`), which
differs from UTF-8 byte order only for characters above U+FFFF vs U+E000-U+FFFF. Same convention as
the RL-11 run cursor; noted only.

S8. The Postgres legs of the store contract suite were not run here (no `MESH_TEST_PG_URL`); run
them once before release for `eventsOfTypes` / `eventsOf`.

## Mutation check

Scratch copy at `/tmp/claude-1015/-home-ghost2-vpc-devel-mesh-harness/1309aed3-426f-4a87-8d98-c622fcf70a9b/scratchpad/rl17-mut`
(node_modules symlinked), one mutation at a time, `vitest run test/changes-hub.test.ts`.

| # | Mutation | Result | Failing tests |
|---|---|---|---|
| M1 | `previous` not computed (changes.ts) | caught | AC01, AC02, AC03, AC04, AC05_previous_under_since |
| M2 | catalog first-push rule dropped (`firstPush.has`) | caught | AC03 |
| M3 | event sightings counted under `repo` | caught | AC04 |
| M4 | changes trial filter dropped | caught | AC05_trial |
| M5 | compare runs trial filter dropped | caught | AC07 |
| M6 | `beyond()` always false | caught | AC08 |
| M7 | `beyond()` ignores `until` | caught | AC08 |
| M8 | `beyond()` ignores `keepStep` | caught | AC08 |
| M9 | `pinsOf` returns nothing | caught | AC03 |
| M10 | `pinsOf` dropped from `pulse.created` | caught | AC03 |
| M11 | `pulse.updated` re-snapshot fields on every update | caught | AC03, AC04 |
| M12 | `costRuns` not counted | caught | AC07 |
| M13 | compare runs ignore `repo` | caught | AC07 |
| M14 | compare runs ignore `until` | caught | AC07 |
| M15 | `sightings` not incremented | caught | AC01-AC06 |
| M16 | first sighting never replaced by an earlier one | caught | AC01, AC04 |
| M17 | `since` applied to sightings before `previous` | caught | AC05_previous_under_since |
| M18 | `run.finished` lookup ignores `runId` (last event of step) | **survived** | — (S1) |
| M19 | goal sighting's `goal.created` event dropped | caught | AC04 |
| M20 | `pulse` ref dropped | caught | AC04 |
| M21 | `next` emitted when `rest.length >= limit` | **survived** | — (S3) |
| M22 | cursor ignored | caught | AC06_paging |
| M23 | changes `until` inclusive | caught | AC05_previous_under_since |
| M24 | key filters: only `agent` honoured | caught | AC01, AC04, AC06 |
| M25 | profile sighting from runs dropped | caught | AC01, AC06 |
| M26 | source rank removed from sighting tie-break | **survived** | — (S2) |
| M27 | compare `denials` not summed | caught | AC07 |
| M28 | compare `allDismissed` not counted | caught | AC07 |
| M29 | `limit` max 1000 | caught | AC06_400s |
| M30 | `from` length limit 2000 | caught | AC09 |
| M31 | `kind` filter ignored | caught | AC06_paging |
| M32 | entry tie order by key reversed | caught | AC06_paging |
| M33 | catalog source match (`d.source !== repo`) dropped | **survived** | — (S4) |
| M34 | goal sighting repo ignored | caught | AC04 |
| M35 | run sighting repo ignored | caught | AC05_repo |
| M36 | `firstAt` uses max | caught | AC07 |
| M37 | compare items taken from the `from` hash for both sides | caught | AC07, AC08 |

33 of 37 caught. The four survivors cover behaviour the ACs do not name (multi-round steps, source
ties, a page boundary on an exact multiple, several catalog sources); each is a suggestion above,
not a blocker.
