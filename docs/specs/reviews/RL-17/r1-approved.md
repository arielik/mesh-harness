Verdict: APPROVED | Round: 1 | Blocking-open: 0

# Review of the RL-17 spec, round 1

This is a cold review of `docs/specs/RL-17.md`, revision 1 (commit 08d24fb on `spec/RL-17`). I read the
source item (`docs/analysis/2026-11-19-harness-efficiency-and-insights.md`, I-8, lines 216-223) and
RL-11 and RL-12 with their reviews for format. Then I checked each contract against the code at HEAD:
- `src/hub/service.ts`: `saveProfile` (830-857), `runReport` (954-1004), `createGoal`'s `goal.created`
  (2200), `deleteTopic`'s `pulse.updated` (2261), `presetChecks` (3272-3273), `createPulse`
  (3366-3404), `updatePulse` (3477-3510), `goalFromPreset` (3583-3608), `createWithPlan` (3616-3668),
  `calibrationScan` (3677-3720), the calibration goal (3779-3784), `listRuns` (3822-3891), `runRow`
  (3894-3950), the health `runs` aggregate (4170-4189), `agentStats` (4317-4330), `fireSlot`
  (5314-5380), `pushCatalog` (5548-5585), `pinAgents` (5630-5649), `actingFor` (1970);
- `src/core/calibration.ts` (`flagEntries`, `raisingAgents`, `countedDismissals`, `agentStats`
  183-362);
- `src/store/hub-store.ts`: the `event` DDL and indexes (54-60, 141-147), `EventRow` (283-330),
  `listGoals` (710), `listSteps` (795-818), `putCatalogDefs` (1260-1299), `listCatalogDefs`
  (1302-1336), `events`, `eventsFor`, `pruneEvents` (1442-1459);
- `src/protocol/goal.ts` (`Goal.preset` 113, `RunTelemetry` 180-218), `pulse.ts` (`PresetSnapshot`
  39-47, `Pulse.agents` 175), `hub.ts` (`HUB_FEATURES` 716, `RunRow`, `HealthRuns` 850-859);
- `src/daemon/runs.ts` (how a run gets `agentKey`, `agentHash`, `profileHash`: 604-647, 833-834);
- `src/hub/app.ts` (the stats and runs routes 325-363), `docs/events.md` (48-70),
  `docs/guide/auth.md` (45), `docs/guide/operations.md` (42, 97), `docs/guide/concepts.md` (headings),
  `docs/plan/implementation-plan.md` (409-412), `test/helpers/calib-kit.ts`.

**Working tree.** The worktree has uncommitted changes that are not mine: `pinsOf` and the new payload
fields in `createPulse`/`updatePulse` (`src/hub/service.ts`), and `eventsOfTypes`/`eventsOf` in
`src/store/hub-store.ts`. I reviewed the spec against the committed HEAD. Those changes match the spec's
event contract (the condition `body.preset !== undefined || body.params !== undefined`, sorted and
distinct `{key, hash}`, absent when empty).

The names are generic (`ann`, `alpha`, `beta`, `p`, `w`, `K`, `D`), so the public-boundary rule holds.
The spec adds no composite score: `costRuns` is a count and the hub divides nothing. It adds no
migration: the event table already has `type`, `goal` and `step` columns (`hub-store.ts:54-60`).
Every finding is **NEW**.

## What holds

- **The three hash spaces agree across sources.**
  - Preset: `presetChecks` refuses a `sha256` that is not the SHA-256 of `text` in UTF-8
    (`service.ts:3273`). `createPulse`, `updatePulse` and `goalFromPreset` all call it. The goal keeps
    `{name, text}` (`createWithPlan`, 3640). So `sha256(goal.preset.text)` equals the pulse event's
    `sha256` for the same text.
  - Agent: a roster run carries `def.key`/`def.hash` (`runs.ts:624`). A repo-agent run carries
    `<repo name>/<name>` and `agentFileHash(text)` (`runs.ts:647`). `pushCatalog` hashes with
    `agentFileHash` (`service.ts:5568`). `listCatalogDefs` gives `key` as `<last segment>/<name>`
    (`hub-store.ts:1325`). Pins copy `r.def.key`/`r.def.hash` (`service.ts:5645`). One key space, one
    hash function.
  - Profile: `telemetry.profileHash` is `run.profile.sha256` (`runs.ts:833`), the snapshot of the
    stored `sha256` that `profile.saved` carries (`service.ts:854`).
- **Old events already sight presets and profiles.** `pulse.created` has carried `preset` and `sha256`
  since RL-3 (`service.ts:3401`), and `profile.saved` has carried `name` and `sha256` since RL-1. Only
  pins and `pulse.updated` need the new fields, and the Compatibility section says so.
- **The catalog rule can be derived.** `putCatalogDefs` appends a push's commit only to the definitions
  in that push (`hub-store.ts:1288`), and `payload.repo` equals the stored `source`. Both are `src.repo`
  (`service.ts:5574`, `5582`). So "earliest `catalog.pushed` of the source whose commit is in
  `D.commits`" finds D's first push until the 50-commit cap drops it, as the spec says.
- **The `pulse.updated` condition is the one under which the code re-snapshots.** `updatePulse` re-pins
  and bumps `version` exactly when `body.preset` or `body.params` is given (`service.ts:3483-3488`).
  The `pulse.updated` from `deleteTopic` (2261) never carries `sha256`, so it is never a sighting.
- **Compare runs equal `/v1/runs`.** The filter (`agentKey`, `finishedAt ∈ [since, until)`, `step.repo`,
  `goal.trial`) is `listRuns`' filter (3866-3880). The waste parts are `runRow`'s (3943-3948). The
  "since given" caveat is right: `listRuns` defaults `since` to 30 days (3857).
- **Compare items reduce to the stats route.** With `since = now − days·86 400 000`, no `until` and no
  `repo`, each listed item field is computed by the same loops of `calibration.ts:248-305` with the same
  `counted: countedAll`, `trialGoals` and `includeTrial` (`service.ts:4326-4329`). "0 when the stats
  route leaves the hash out" is right, because a hash is left out only when every count is 0 and it
  has no open calibration (`calibration.ts:352`). The note on `headless`-only runs in stats
  (`calibration.ts:238`) is accurate.
- **Validation texts** reuse existing ones verbatim: the time and `since must be before until` texts
  (3842-3849), `trial must be exclude or include` (4318), `an agent key is <repo>/<name>` (4324), and
  `on-behalf-of is not accepted on this route` (1970). A route without `forPerson` gets the last one.
- **Features list.** Adding `agent-compare` and `changes` to `["commits", "health", "pulse-runs",
  "runs", "trial"]` (`hub.ts:716`) gives the sorted list in RL-17.md:213.
- **Doc anchors exist:** `## Agent statistics` (concepts.md:851), `## Upgrading to 0.1.32`
  (operations.md:97), the `pulse.created`/`pulse.updated` rows (events.md:59-60), and the API table
  (implementation-plan.md:409-412).
- **The ACs can be built.** `calib-kit` reports runs through `POST /v1/steps/:id/run` (`calib-kit.ts:152`),
  so `run.finished` events exist for AC-02 and AC-05. It wraps `Rk` (`calib-kit.ts:81`), so AC-03 can push
  catalogs. It has a settable clock (96-100). I recomputed the numbers of AC-01, AC-02, AC-04 and AC-07
  against the rules, and they hold.

## Blockers

None.

## Suggestions

**S1. Name the tests and the doc sentence that pin the features list.** `test/m46-ops.test.ts:70` and
`:108`, and `test/health-hub.test.ts:437`, assert the exact list `["commits", "health", "pulse-runs",
"runs", "trial"]`. `docs/guide/operations.md:42` lists the names "in 0.1.32". The *Docs, schemas*
section (RL-17.md:229-238) and AC-10/AC-11 do not mention them. The implementer will find the failing
tests, but the operations sentence would go stale without a failing test. Add it to the docs list and
to AC-11.

**S2. `HashSide.runs` is not exactly the RL-12 aggregate. Give it a schema.** `HealthRuns`
(`hub.ts:850-859`) has no `costRuns`, and the health loop does not round `costUsd`
(`service.ts:4197`). The spec adds both (RL-17.md:176-178) but still calls the result "the RL-12 run
aggregate". The *Types* list (RL-17.md:212) names only `ChangeEntry`, `ChangesPage`, `HashSide` and
`AgentCompare`. Two fixes:
- Name the shape, for example `HashRuns = HealthRuns + costRuns`, so `hub-api.ts` does not reuse
  `HealthRuns` and drop `costRuns`.
- Say that AC-07's "equal those of `GET /v1/runs`" compares `costUsd` after rounding the summed row
  costs to 6 decimals.

**S3. `previous` on a tie in `firstSeen`.** RL-17.md:130 says "the greatest `firstSeen` smaller than
this one's, ties broken as entries are ordered below". There are two readings when two hashes of one
`(kind, key)` share a `firstSeen`:
- (a) Neither is the other's `previous`, because "smaller" is strict.
- (b) The tie is ordered by `hash`, so the entry with the greater hash has the smaller one as
  `previous`.

This can happen. A `pulse.created` that pins two definitions with the same `def.key` from two sources
(see S4) gives both hashes one event time. Suggested wording: "`previous` is the `hash` of the entry
that follows this one in response order among the entries of the same `(kind, key)`". That is
reading (b), and it gives a chain without gaps.

**S4. Two catalog sources can share an agent key.** `CatalogDefView.key` is the last path segment of the
source plus the name (`hub-store.ts:1325`), so `org1/alpha` and `org2/alpha` both give `alpha/x`. Runs
already merge them (`runs.ts:624`), so `/v1/changes` and compare would mix the two sources' hashes in
one timeline, with `previous` crossing sources. This is no worse than the stats route, but the guide
section should say it in one sentence.

**S5. Repo attribution of dispositions in compare `items`.** RL-17.md:185-186 filters records by their
step's repo and dispositions by the repo of the step that recorded them. A debrief or validator step
can live in another repo than the auditing step. In `calib-kit`, the `debrief` step is fixed to
`ALPHA` (`calib-kit.ts:57`). Then `repo=beta` counts an item under `raised` but not under
`accepted`/`dismissed*`. If that is intended, say so in the guide. Otherwise filter dispositions by the
repo of the raising record's step. Either way, state two things:
- The raising attribution (`raisingAgents`, `calibration.ts:88`) and the counted-dismissal choice
  (`countedDismissals`, `calibration.ts:112`, the earliest dismissal per `(goal, lineage, fp)`) are
  computed over all rows, as today. `until` and `repo` only filter what is counted. That is what
  "`computeAgentStats` gains optional `until` and a step filter" (RL-17.md:225) implies, but an
  implementer who filters `calibrationScan`'s inputs would get different counts.
- AC-08's `repo=beta` case should say which repo its debrief step is in.

**S6. Empty `from`/`to`.** "Each 1–200 characters" (RL-17.md:154) has texts only for "absent" and "over
200". Say that `from=` (empty) → `from is required`. Runs without `agentHash` are counted under hash
`""` by stats (`calibration.ts:242`) and cannot be compared. One sentence would say so.

**S7. `sightings` ignores the window.** RL-17.md:105-106 lists what "counts" (repo, trial), and
`since`/`until` select entries by `firstSeen` (RL-17.md:115). Together they mean that `sightings` covers
all time. Say it in the `sightings` row (RL-17.md:135) so nobody windows it.

**S8. Sightings per source are counted differently. Test the catalog rule.** A catalog definition
counts one sighting however often it is pushed (RL-17.md:95-96). An unchanged profile re-save, or a
params-only `pulse.updated`, counts one sighting each time. That is fine, but say it in the guide so
`sightings` is not read as "number of pushes or saves". AC-03 never asserts the "earliest push only"
rule. Add "H1 `sightings` 1" after the unchanged push at t2.

**S9. AC-03's preset update must pin D.** `pulse.updated` carries `agents` only when the re-snapshot
pins a roster key (`updatePulse` → `pinAgents`, `service.ts:3487`). As written, "a pulse updated with
a new preset text → `preset`, `sha256`, `agents`" fails if the new text names no roster agent. Say the
new preset's step uses D's key. Optionally add a `params`-only update, which carries the unchanged
`sha256`.

**S10. A revert is invisible.** There is one entry per hash, so H1 → H2 → H1 shows H2 as the newest
entry, and `putCatalogDefs` just appends the commit of the returning hash (`hub-store.ts:1288`). The
guide should say that the timeline lists first appearances, not the current hash. For "what runs now",
a client reads the newest run.

**S11. Calibration goals add `preset` entries.** Calibration goals carry the built-in calibrate preset
(`service.ts:3779-3784`), so they appear as goal sightings. A hub upgrade that changes that text makes
a new entry attributed to the first calibration goal after the upgrade. Either accept this and say it
in the guide, or leave out goals with `calibration`.

**S12. Goal pins are not a sighting source.** `goal.agents` is pinned at plan approval
(`service.ts:2470`), and the pin then shows only through its first run. That is consistent with "no
stored field", but list it under *Out* next to `agents.reported`, so a reader does not expect it.

**S13. The AC surface line.** AC-01/AC-03 need catalog pushes and profile saves. Say that `calib-kit`
(through `Rk`, `test/helpers/roster-kit.ts`) supplies them, as RL-12 named its kits.

**S14. Cost of compare without `since`.** With no default window, compare runs `runRow` for every run of
the key in all history. Each `runRow` does a `listReviews` and one `getItem` per raised item
(`service.ts:3895-3904`). The guide line "a page load, not a poll" (RL-17.md:227) covers it. Consider
also saying in the guide that a client should pass `since`.
