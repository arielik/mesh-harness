# RL-6 implementation plan: Calibration, stats and end-to-end acceptance

Spec: `docs/specs/RL-6.md` (after review round 3). Branch: `feat/relay-design`. Release v0.1.20.
Design: `docs/analysis/2026-11-12-pulse-relay-roster.md` §5.8, §5.9, §5.10, REQ-9, R-3, slice S6 of §9,
§10 (whole-programme acceptance, OQ-2/OQ-4 defaults). `docs/analysis/2026-11-12-claude-cli-spike.md`
does not touch this row.

This plan covers the implementation only. It plans no new tests: the test side writes them from the
spec's contracts and never reads this plan. Section 2 lists the existing tests and generated files
whose asserted behaviour the spec changes, and nothing else. Section 3 records the choices this plan
makes where the spec leaves room; the spec is not changed by this plan. Section 4 has one section per
acceptance criterion (AC-01 .. AC-17): files, changes (functions), migrations, order, blast radius
and risks.

No migration anywhere: `SCHEMA_VERSION` stays 11, no `HUB_MIGRATIONS`/`HUB_MIGRATIONS_PG` entry, no
new `HubStore` method. New goal data lives in the goal's JSON value (`Goal.calibration`).

## 0. Overview and build order

Layering as `.dependency-cruiser.cjs` (`protocol` ← nothing; `core` ← `protocol`; `store` ←
`protocol`; `hub` ← `protocol`, `core`, `store`; `web` imports protocol types only).

| Stage | Module | Work | Criteria |
|---|---|---|---|
| 1 | `src/store/hub-copy.ts` | `TABLES` gains `topic` (own commit, see AC-04) | AC-04 |
| 2 | `src/protocol` | `goal.ts` (`DismissalRef`, `GoalCalibration`, `Goal.calibration`, `StepPolicy.inputs` keyword); `roster.ts` (`AgentHashStats`, `AgentStats`); `hub-api.ts` (stats row); `skill.ts` (`MESH_SKILL`) | AC-01, AC-07, AC-15 |
| 3 | `src/hub/config.ts` | `calibration.threshold` | AC-01 |
| 4 | `src/core` | `policy.ts` (`INPUT_KEYWORDS`), `review.ts` (`whenHolds`, new `consumedNow`), `presets.ts` (`calibrate`), new `calibration.ts` (counting and stats, pure), `index.ts` export | AC-01, AC-02, AC-03, AC-08, AC-09 |
| 5 | `src/hub/service.ts` | fix 1, fix 2, `agentStats`, calibration scan, trigger, done hook, `calibration` input, `describe()` texts | AC-05 .. AC-13, AC-17 |
| 6 | `src/hub/app.ts` | `GET /v1/agents/:key/stats` | AC-07 |
| 7 | `web/src` | `api.ts` (`agentStats`), `roster.tsx` (stats toggle and table), `styles.css` | AC-14 |
| 8 | repo | docs, `pnpm schemas` (`schemas/*.json`, `skills/mesh/SKILL.md`), `package.json` 0.1.20, section 2 tests, full check | AC-15, AC-16 |
| 9 | whole programme | run the AC-17 World test once the test side has it; fix any further RL-1..RL-5 gap where it lives | AC-17 |

Order constraints (global):
- Stage 1 is committed alone first (its own commit and changelog line, see AC-04), before anything
  else is staged, so it can be cherry-picked or reverted alone.
- Stage 2 before 3..7: `PresetStep`/`PlanStep` must accept `inputs: ["calibration"]` before the
  `calibrate` preset parses (`parsePreset` on `presetText(CALIBRATE)` inside `createWithPlan`);
  `Goal.calibration` must be in the zod schema before the hub stores it (`Goal` is a non-strict
  `z.object`: an unknown key is stripped silently on read, so a missing schema field loses the data
  without an error).
- Stage 4 (`core/calibration.ts`) before stage 5 (the service only reads and delegates).
- Stage 5 fix 1/fix 2 before the AC-17 run (stage 9): the whole programme depends on both.
- `pnpm schemas` after the last change to `src/protocol` (`HUB_API`, `Goal`, `StepPolicy`,
  `MESH_SKILL`); docs and the version bump last.

## 1. Shared building blocks

**B1. Protocol (`src/protocol/goal.ts`, `src/protocol/roster.ts`).**
- `goal.ts`, before `Goal`: `DismissalRef = z.object({ lineage: z.string(), fp: z.string(), goal:
  z.string(), step: z.string(), round: z.number().int(), at: z.number() })`;
  `GoalCalibration = z.object({ key: z.string(), hash: z.string(), threshold: z.number().int().min(1),
  dismissals: z.array(DismissalRef) })`; both exported with their `z.infer` types.
  `Goal` gains `calibration: GoalCalibration.optional()` (comment: RL-6, set only by the trigger).
- `StepPolicy.inputs`: the enum becomes `z.enum(["previous", "dispositions", "artifacts", "calibration"])`.
- `roster.ts`: interfaces `AgentHashStats` and `AgentStats` exactly as the spec's table (types only,
  no zod; `calibration?: string | undefined`). `index.ts` already re-exports both files.

**B2. Core `src/core/calibration.ts`** (new; `export * from "./calibration.ts"` in `src/core/index.ts`).
Pure; imports types only from `../protocol/index.ts`.
- `type AgentRef = { key: string; hash: string }` (`hash` `""` for none); `agentRefKey(a)`;
  `refKey(r: DismissalRef)` = `JSON.stringify([r.lineage, r.fp, r.goal, r.step, r.round, r.at])`
  (full-ref match, spec S1).
- `interface Entry extends DispositionRow { ord: number; reverted: boolean }`.
  `flagEntries(rows: readonly DispositionRow[], historyOf: (lineage, fp) => readonly ItemHistoryEntry[]): Entry[]`:
  `rows` come from `listDispositions({})` in seq order; `ord` = the row's index there. For each
  `(lineage, fp)`, the k-th `kind: "disposition"` entry of its history corresponds to the k-th row of
  that pair (both are seq order). An entry is `reverted` when (a) the next history entry of the pair is
  a `revert`, or (b) spec S3 (change of mind): the entry has `via: "debrief-session"` and the next
  `disposition` entry of the pair has `via: "debrief-session"` and the same `goal`, `step` and `round`.
- `raisingAgents(reviews: readonly StoredReview[]): Map<string, AgentRef | null>` keyed
  `${goal}\n${lineage}`: the last (insertion order = newest) raising record per key; value = the
  decider when `kind: "agent"` (`{ key, hash: hash ?? "" }`), else `null`.
- `interface Counted { ref: DismissalRef; raising: AgentRef; decider: Decider; via; reason; answer?; ord }`.
  `countedDismissals(entries, raising): Counted[]`: per `(goal, lineage, fp)` the earliest (by `ord`)
  entry with `disposition: "dismissed"`, not reverted, whose `raising` (by `goal`+`lineage`) is an
  agent. Ordered by `at`, then `ord` (oldest first).
- `calibrationGoals(goals, agent)`: goals with `calibration.key/hash` equal; `openCalibration(goals,
  agent)`: the one whose `state` is not `done`/`dropped` (first by `createdAt` should there ever be two).
- `statusOf(counted, goals): Map<refKey, "calibrating" | "calibrated">`: refs listed by a `done`
  calibration goal → `calibrated` (wins), by an open one → `calibrating`; absent → `uncalibrated`;
  refs listed by `dropped` goals count for nothing.
- `uncalibrated(counted, status, agent): Counted[]`.
- `agentStats(o: { key, days, since, threshold, steps: readonly Step[], reviews, entries, counted,
  status, goals }): AgentStats`, field by field as the spec's table (details under AC-08/AC-09).

**B3. Service plumbing (`src/hub/service.ts`).**
- `private async calibrationScan()` (inside the caller's transaction): `listSteps({})`,
  `listReviews({ raising: true })`, `listDispositions({})`, then `itemHistory(lineage, fp)` once per
  distinct `(lineage, fp)` of those rows (the per-lineage form returns entries without `fp`, so the
  per-item form of the same existing method is used), `listGoals()` (store method, not the service's
  filtered one). Returns `{ steps, reviews, entries, raising, counted, status, goals }` built with B2.
- `private async catalogDefOf(agent: AgentRef)`: `listCatalogSources()` sorted by `repo` (`cmp`),
  for each `listCatalogDefs({ repo })` and the first def with `canonicalKey(source.repo, def.name) ===
  agent.key && def.hash === agent.hash` → `{ source, def }`. Used by the calibrator rule 1, the goal's
  repo and the input's `text`.
- `private async markGoalDone(goal: Goal, at?: number)`: emits `goal.done` (with `at` when given)
  and, when `goal.calibration` is set, runs the done handling (AC-13). Replaces the four
  `emit({ type: "goal.done" ... })` sites: `applyApproved` (l. ~2238), `doneStep` (~2520),
  `decideGate` (~2576), `resumeStep` (~2611). Each site already saves the goal `done` before the
  emit, so the scan inside the hook sees it as not open.
- `private async calibrationTrigger(agent: AgentRef, now: number)` (AC-10/AC-11).
- `private async raisingAgentOf(lineage, goalId)`: last of `listReviews({ lineage, raising: true })`
  with `goal === goalId`, agent decider → `AgentRef`, else undefined.

## 2. Existing tests and generated files the spec changes

The spec (Compatibility) gives these to the test-writer. The developer touches one only when it fails
on the combined branch and the test side has not updated it, and changes only the asserted value the
spec changes:
- `test/schemas.test.ts` `test_AC24_version`: `0.1.19` → `0.1.20`.
- `src/core/presets.test.ts` `test_AC03_builtins_unchanged`: the loop filters out `audit-relay`; it
  must also leave out `calibrate` (it has `inputs`, which that loop asserts absent).
- `src/core/policy.test.ts` "templates" loop: expected to pass unchanged with `calibrate`
  (no params needed: `{agent}`/`{hash}` stay text in `title`/`brief`; `validatePolicies` is clean);
  if it fails, filter `calibrate` as `audit-relay` is.
- `src/core/policy.test.ts` `test_AC02_keywords`: unchanged (lists three keywords; still valid).
- `test/pulse-cli.test.ts` `test_AC19_preset_ls`: `toContain` only; unchanged.
- `test/m46-ops.test.ts` and `src/store/hub-store.contract.test.ts` `test_AC03_tables`: still valid
  (`topic` goes after `idem`, not between `pulse_slot` and `agent_def`).
- Route lists (`test/schemas.test.ts` "served = documented"): pass once `HUB_API` and `app.ts` both
  have the stats row; no edit.
- Generated: `schemas/hub-api.openapi.json` (stats route), `schemas/*.json` that embed `Goal` or
  `StepPolicy` (`calibration`), `skills/mesh/SKILL.md` — all via `pnpm schemas`, never by hand.
- Any existing World test that now gets an unplanned calibration goal (default threshold 5, an agent
  with a hash whose raised items are dismissed 5+ times in one hub) and asserts a goal list, an event
  list or `goal.created` count: that is the spec's new behaviour; adjust the expected list only.

## 3. Choices where the spec leaves room

1. **Reverted entries (S3).** "Reverted" in counting = next history entry is a `revert`, or the RL-4
   change of mind (same debrief step and round replaces it). Applied to every disposition kind
   (`accepted` too), so a replaced acceptance is not `accepted` either.
2. **Fix 2 and reverted person entries.** "Latest person disposition in the goal" is read literally
   from `listDispositions({ lineage, fp, goal })` (reverted entries included), as RL-2 precedence did.
3. **Calibration goal priority**: 3 (the `GoalCreate` default). Not in the spec.
4. **`calibration.opened`/`calibration.done` payload `hash`**: the full hash (as `Goal.calibration.hash`);
   texts use `hash12`.
5. **`goal.created` of a calibration goal**: `extra` `{}` (payload `{title, preset: "calibrate"}`),
   no `calibration` in it.
6. **Repo when rule 1 finds no definition**: the middle part of the newest uncalibrated dismissal's
   lineage: `lineage.slice(lineage.indexOf("|") + 1, lineage.lastIndexOf("|"))` (= the raising
   step's repo, as `lineageKey` builds it).
7. **Web stats reload**: every show (click from hidden) reloads; nothing loads while hidden.
8. **Debrief items and filed items**: fix 1 changes only `when` and the `dispositions` input; the
   debrief pre-read (`debriefData`) is unchanged (the spec does not list it).
9. **Changelog line for the `topic` fix**: the repo has no CHANGELOG file (releases use generated
   notes), so the commit subject is the changelog line: `fix(hub): mesh hub migrate copies the topic table`.
10. **Key decode in the stats route**: the shared `param()` double-decodes; a key with a stray `%`
    would throw `URIError` (500). The route catches that and answers the spec's 400 key error.

## 4. Per acceptance criterion

### AC-01 Schemas and config

Files: `src/protocol/goal.ts`, `src/core/policy.ts`, `src/hub/config.ts`.
Changes:
- B1 (`DismissalRef`, `GoalCalibration`, `Goal.calibration`, `StepPolicy.inputs` enum).
- `INPUT_KEYWORDS` = `new Set(["previous", "dispositions", "artifacts", "calibration"])`; the RL-1
  comment unchanged ("the keyword wins over a step of that id").
- `HubConfigFile` gains `calibration: z.object({ threshold: z.number().int().min(1).default(5) })
  .default({ threshold: 5 })`; `HubConfig` gains `calibration: { threshold: number }`;
  `buildHubConfig` returns `calibration: { threshold: file.calibration.threshold }`. `0`, `-1`, `1.5`
  fail zod parsing (thrown by `HubConfigFile.parse`, as the other fields).
Order: goal.ts before presets (stage 2 → 4).
Blast radius: every reader of `Goal` (store parse, web, CLI) gets an optional field; `HubConfig` is
only built through `buildHubConfig` (tests included), so no literal needs the new field.
Risks: forgetting the `PlanStep`/`PresetStep` side: both derive from the `StepPolicy` field, so one
enum edit covers them; verify with `pnpm typecheck`.

### AC-02 `whenHolds` and filed items

Files: `src/core/review.ts`.
Changes:
- New `consumedNow(item: { state: ItemState; link?: string | undefined }, consumes: readonly ItemState[]): boolean`
  = `consumes.includes(item.state) && !(item.state === "accepted" && item.link !== undefined)`.
- `whenHolds(when, consumes, items: readonly { state; severity; link?: string | undefined }[])`: the
  `some` uses `consumedNow(i, consumes)`; `when: {}` still returns `true` first.
Blast radius: `whenHolds` callers: `HubService.holdsFor` only (it passes `link`, AC-05).
Risks: an empty-string link — `ItemRow.link` is `min(1)` through `RecordDisposition.link`, so
`!== undefined` is enough.

### AC-03 Built-in `calibrate` preset

Files: `src/core/presets.ts`.
Changes: `const CALIBRATE: Preset` with the spec's name, description and one step
`s({ id: "calibrate", kind: "review", output: "review-record", inputs: ["calibration"], title:
"Calibrate {agent}@{hash}", brief: <spec text verbatim> })` (`s()` adds `repo: "{repo}"`, `deps: []`;
no `mode`, `agent`, `profile`). `BUILTIN_PRESETS = [SDD_SPLIT, SDD_COLLAPSE, AUDIT_RELAY, CALIBRATE]`.
Export `CALIBRATE_PRESET = CALIBRATE` (or look it up by name) for the hub.
`mesh preset ls` lists `BUILTIN_PRESETS` in order, so no CLI change.
Order: after AC-01 (the step's `inputs` must parse).
Blast radius: preset list, `mesh preset show calibrate`, `mesh goal new --preset calibrate` (works
as any built-in; params missing leave `{agent}`/`{hash}` as text).
Risks: the brief has double quotes and colons; `presetText` → `parsePreset` must round-trip it
(YAML stringify quotes as needed) — the hub relies on it in `createWithPlan`.

### AC-04 Hub copy: `topic` in `TABLES`

Files: `src/store/hub-copy.ts`.
Changes: `{ name: "topic" }` after `{ name: "idem" }` with a comment `// v0.1.8: topics (missed until v0.1.20)`.
Afterwards the names equal the tables of a fresh SQLite hub. `topic` has no foreign key
and no identity column, so its position after `idem` is safe for inserts and `TRUNCATE ... CASCADE`.
Order: first, in its own commit (message `fix(hub): mesh hub migrate copies the topic table`, with
the trailer), containing only `src/store/hub-copy.ts`. Nothing else of RL-6 in that commit.
Blast radius: `mesh hub migrate` (copy and the "target already holds a hub" check now also look at
`topic`). Postgres leg not run locally.
Risks: none beyond a hub with topics now refusing a non-empty target that only had topics (correct).

### AC-05 Filed items are not consumed (fix 1)

Files: `src/hub/service.ts`.
Changes:
- `holdsFor`: pass `{ state: r.state, severity: r.severity, link: r.link }` to `whenHolds`.
- `dispositionsInput` (consuming branch): filter rows with `consumedNow(r, consumes)` instead of
  `consumes.includes(r.state)`.
- `submitReview`'s and `disposeStep`'s state checks stay `consumes.includes(row.state)` (spec: the
  disposition checks are unchanged).
Order: after AC-02.
Blast radius: every settle (`applyApproved`, `doneStep`, `decideGate`, reopen) and the
`dispositions` input. Only steps consuming `accepted` see a difference.
Risks: RL-3/RL-4 tests where a filer consumes `accepted` items that already carry a link would now
skip; none known (the RL-3 filer consumes `confirmed`).

### AC-06 Agreeing agent dispositions (fix 2)

Files: `src/hub/service.ts` (`submitReview`, the per-disposition checks).
Changes: replace the `last` lookup with the latest person entry:
```ts
const person = !session && decider.kind === "agent"
  ? (await this.store.listDispositions({ lineage, fp, goal: step.goal })).filter((x) => x.decider.kind === "person").at(-1)
  : undefined;
...
} else if (person?.decider.kind === "person") {
  const row = await this.store.getItem(lineage, fp);
  if (person.disposition === d.disposition && row && consumes.includes(row.state)) toApply.push(d);
  else ignored.push({ fingerprint: fp, reason: `decided by ${person.decider.user} in this goal` });
} else { /* RL-2 state check, unchanged */ }
```
The check order before it (`may_set`, `until`, listed twice, not in the run's record, debrief session)
is unchanged. An applied agreeing disposition goes through `applyDisposition` (history entry with the
agent decider, `link`/`until` on the row) and emits `item.disposed` like any applied one.
Order: independent of fix 1, both before AC-17.
Blast radius: only dispositions of fps with a person entry in the goal; RL-2/RL-4 precedence tests
(`test/review-hub.test.ts` AC-14, `test/debrief-hub.test.ts` AC-12) use disagreeing values and stay green.
Risks: a later agent stage's own entry must never become "the" precedence entry: the filter on
`decider.kind === "person"` guarantees it.

### AC-07 Stats route

Files: `src/protocol/hub-api.ts`, `src/hub/app.ts`, `src/hub/service.ts`.
Changes:
- `HUB_API` row after `/v1/agents/resolve`: `{ method: "GET", path: "/v1/agents/:key/stats", rule:
  "member", scope: "goals:read", tag: "goals", query: { days: "1-365, default 30" }, summary: "Statistics
  of an agent key per hash: runs, cost, findings, dispositions and calibration (key with / encoded)." }`.
- `app.ts`, in the roster block: `r("GET", "/v1/agents/:key/stats", "member", async (c) => {
  let key = ""; try { key = param(c, "key"); } catch { /* malformed: 400 below */ }
  return c.json(await svc.agentStats(key, c.req.query("days"))); }, "goals:read")`.
  Hono 4.13 decodes the path with `decodeURI` (keeps `%2F`) and the param with
  `decodeURIComponent`, so `/v1/agents/alpha%2Fauditor/stats` matches with key `alpha/auditor`.
- `HubService.agentStats(key: string, daysRaw: string | undefined): Promise<AgentStats>`:
  `days` = 30 when absent; else `/^\d+$/` and 1..365, otherwise `HubError(400, "days must be a whole
  number from 1 to 365")`. Then key: empty, `> 330` chars or no `/` → `HubError(400, "an agent key is
  <repo>/<name>")`. Then `store.tx`: `calibrationScan()`, `since = now - days * 86_400_000`, B2
  `agentStats({... threshold: this.config.calibration.threshold })`. Unknown key → `hashes: []`.
Order: days check before key check (`days=0` with a valid key, and a bad key with a valid days, each
give their own error; with both bad the spec lists no order — days first).
Blast radius: route list (`test/schemas.test.ts` served = documented); OpenAPI regenerated.
Risks: `/v1/agents/resolve` and `/v1/agents/:key/stats` differ in segment count; no shadowing.

### AC-08 Stats values

Files: `src/core/calibration.ts` (`agentStats`), `src/hub/service.ts` (scan).
Changes, per hash `h` of key `k` (B2 `agentStats`):
- runs: over `steps` with `policy?.mode === "headless"`, every round with `telemetry?.agentKey === k`,
  `(telemetry.agentHash ?? "") === h`, `finishedAt >= since`. `failures`: those with `outcome === "fail"`.
  `meanCostUsd`: mean of defined `costUsdEstimate` (unrounded), `null` if none. `meanDurationMs`:
  `Math.round(mean durationMs)`, `null` without runs.
- raising records (`reviews` are already `raising: true`): decider `agent`, `key === k`,
  `(hash ?? "") === h`, `at >= since`: `raised += uniqueFps(record.items).length`; `new`,
  `regressions`, `carried` from `fold.new|regression|carried` (0 without `fold`); `undeclaredRules`.
- accepted: distinct `${goal}\n${lineage}\n${fp}` over entries `disposition === "accepted"`, not
  reverted, `at >= since`, `raising(goal, lineage)` = `(k, h)`.
- dismissedByAgents/People: counted dismissals with raising `(k, h)` and `at >= since`, by
  `decider.kind`.
- uncalibrated/calibrating/calibrated: every counted dismissal with raising `(k, h)` by `statusOf`.
- calibration: `openCalibration(goals, {k, h})?.id`.
- lastAt: max over in-window run `finishedAt`, record `at`, accepted entry `at`, in-window counted
  dismissal `at`, reinstating person entry `at`; none → newest counted dismissal `at` of `(k, h)` (any
  time) → else the open calibration goal's `createdAt`.
- Hash set: union of the hashes seen in all of the above for `k` plus open calibration goals of `k`;
  keep a hash when any count is non-zero or it has `calibration`; sort `lastAt` desc, then `cmp(hash)`.
Order: B2 before the route.
Blast radius: read-only.
Risks: `listReviews` order is insertion order (`ord`), not `at`; "newest raising record" therefore
means the last inserted, as the spec defines. Rounds without `finishedAt` (open rounds) never count.

### AC-09 Reinstated, once per goal

Files: `src/core/calibration.ts`.
Changes:
- Once per goal: `countedDismissals` groups by `(goal, lineage, fp)` and takes the earliest
  non-reverted dismissal (B2); a person's dismissal after an agent's in the same goal adds nothing.
- `reinstated` for `(k, h)`: for each non-reverted entry with `disposition === "dismissed"` and
  decider `{agent, key: k, hash ?? "" === h}`, take the next non-reverted disposition entry of the same
  `(lineage, fp)` (any goal, by `ord`); count it when its decider is a person, its disposition is not
  `dismissed` and its `at >= since`. Its `at` feeds `lastAt`. A reverted person entry is skipped, so
  the revert brings `reinstated` back to 0 (AC-09's last step).
Blast radius: read-only.
Risks: `reinstated` keys on the dismissing agent's own decider hash, never on the raising agent.

### AC-10 Trigger

Files: `src/hub/service.ts`, `src/core/presets.ts` (preset lookup).
Changes:
- `submitReview`: after the `item.disposed` events, collect distinct raising agents of applied
  `dismissed` dispositions (`raisingAgentOf(lineage, goal.id)`, hash `""` dropped) and call
  `calibrationTrigger(agent, now)` for each, inside the same `goalTx`.
- `disposeStep`: after its `item.disposed` event, when `b.disposition === "dismissed"`, the same for
  `raisingAgentOf(lineage, goal.id)`.
- `revertDisposition`: no trigger (unchanged).
- `calibrationTrigger(agent, now)`: `hash === ""` → return. `scan = calibrationScan()`; an open
  calibration goal of `agent` → return; `list = uncalibrated(scan.counted, scan.status, agent)`;
  `list.length < threshold` → return. Resolve calibrator and repo (AC-11); none → return (no event).
  Create the goal with `createWithPlan` (extended with `calibration?: GoalCalibration`, spread into
  `store.createGoal`): owner = calibrator, title `Calibrate ${key}@${hash.slice(0, 12)}`, preset
  `{ name: "calibrate", text: presetText(CALIBRATE), sha256 }`, params `{ repo, agent: key, hash:
  hash12 }`, `profiles: {}`, `agents: {}`, `topics: []`, `priority: 3`, no refs, comment
  `calibration of ${key}@${hash12} (${n} dismissals, threshold ${t})`, `extra: {}`, and
  `calibration = { key, hash, threshold: t, dismissals: list.map(c => c.ref) }` (oldest first). Then
  `emit({ type: "calibration.opened", user: calibrator, goal: id, payload: { key, hash, dismissals: n,
  threshold: t, calibrator } })`.
- `describe()`: `case "calibration.opened": return \`opened calibration of ${key}@${hash12} (${n} dismissals)\``.
- `GET /v1/goals` shows it already (no `refs.pulse`).
Order: after B2/B3 and AC-03.
Blast radius: every request that records a dismissal now scans the hub's review history (spec open
question "Reads"); a new goal can appear in any hub where a hashed agent's items get ≥ 5 dismissals.
Risks: `createWithPlan` signature change touches `goalFromPreset` and `fireSlot` callers (add nothing,
the field is optional). The scan inside `goalTx` is serialized (`store.serialize()`), so two replicas
cannot open two goals. Person-raised items have `raising = null` and never reach the trigger.

### AC-11 Calibrator order

Files: `src/hub/service.ts`.
Changes: `private async calibratorFor(agent, list, scan): Promise<{ user: string; repo: string } | undefined>`:
1. `found = catalogDefOf(agent)`; if `found?.source.calibrator` and `store.getUser(it)` exists → that
   user. `repo` = `found.source.repo` whenever `found` (also without a calibrator).
2. Else among `scan.goals` with `refs?.pulse`, the goal whose steps (from `scan.steps`, `goal` field)
   hold a round with `telemetry?.agentKey === agent.key` (any hash) with the largest `finishedAt` →
   its `ownerId` when the user exists.
3. Else the owner of the goal of `list.at(-1)` (newest uncalibrated) when the user exists.
`repo` without `found`: choice 6 on `list.at(-1).ref.lineage`.
Blast radius: read-only lookups.
Risks: catalog defs are many; `listCatalogDefs({ repo })` per source is bounded by sources (few).

### AC-12 The `calibration` input

Files: `src/hub/service.ts` (`stepInputs`).
Changes: in the inputs loop, a branch `else if (x === "calibration")` before the `!INPUT_KEYWORDS` one:
when `goal.calibration`, build `content = JSON.stringify({ agent: { key, hash, ...(text ? { text } : {}) },
dismissals })`, `push({ from: goal.id, artifact: "calibration", kind: "review", title:
\`dismissals of ${key}@${hash12} (${n})\` }, content)` (RL-1 caps via `push`; the daemon/MCP fencing
applies as to every input). For each ref in order:
- entry: `listDispositions({ lineage, fp, goal })` matched by `step`, `round`, `at` → `reason`,
  `decider`, `via`, `answer?` (a later-reverted entry is still in history, so it is found);
- item: `getItem(lineage, fp)` → `title`, `severity`, `category`, `rule`, `path?`, `symbol?`;
- evidence: `raisingAgentOf`'s record (last raising record of `lineage` in `ref.goal`) →
  `record.items.find(i => i.fp === fp)?.evidence ?? []` (path, lines, note as stored);
- `text` = `catalogDefOf({ key, hash })?.def.text`.
A goal without `calibration` → no entry.
Blast radius: `GET /v1/steps/:id/context` and `mesh_context` for steps with that keyword only.
Risks: `context()` runs in `store.tx` (read-only); the input reads only.

### AC-13 Done handling

Files: `src/hub/service.ts` (`markGoalDone`, `describe()`).
Changes: `markGoalDone(goal, at)`: emit `goal.done`; if `goal.calibration`:
- `outcome`: `latestReview(\`${goal.id}.calibrate\`)?.record.assessment` → `issues` → `change`,
  `clean` → `no-change`, else (`blocked`, no record, step dropped by replan) `none`;
- emit `calibration.done` (`goal`, no user) with `{ key, hash, dismissals: calibration.dismissals.length, outcome }`;
- `calibrationTrigger({ key, hash }, at ?? now)` (the goal is already stored `done`, so its refs are
  calibrated and it is not open).
Call sites: the four `goal.done` emits (B3). The replan path (`proposePlan` + `approvePlan` without a
design step, then `doneStep` of `recheck`) ends in `doneStep` → covered. Dropping a calibration goal
(`dropGoal` is pulse-only today) does nothing.
`describe()`: `case "calibration.done": return \`calibration of ${key}@${hash12} done: ${outcome}\``.
A listed dismissal reverted later: nothing to do (no hook on revert); the reverted entry stops being
counted, so `statusOf` never sees it.
Order: after AC-10 (the hook calls the trigger).
Blast radius: every goal completion pays one `goal.calibration` check (no read for other goals).
Risks: `doneStep` passes `now` (possibly an offline `input.at`); use it for the events too.

### AC-14 Web Roster metrics

Files: `web/src/api.ts`, `web/src/roster.tsx`, `web/src/styles.css`.
Changes:
- `api.agentStats(key, days = 30)` = `call<AgentStats>("GET", \`/v1/agents/${encodeURIComponent(key)}/stats?days=${days}\`)`;
  type import from `../../src/protocol/roster.ts`.
- `Group`: state `open: boolean`, `stats?: { key: string; s: AgentStats }[]`, `error?: string`.
  `button.roster-stats-toggle` (text `Stats`, `type="button"`) placed after the `h3` (not inside it:
  the RL-5 e2e checks the `h3` text and flags). Click while hidden: keys = distinct `copy.key` in
  `g.versions` order then `copies` order (first occurrence); `Promise.all` of `api.agentStats`; on
  success set rows, on `ApiError` set `p.error` with its message; second click hides (choice 7).
- Rows: one `tr[data-key][data-hash]` per key (copy order) and hash (reply order) in
  `table.roster-stats` with `td[data-col]`: `hash` (`h ? h.slice(0, 12) : "-"`), `runs`, `failures`,
  `cost` (`meanCostUsd === null ? "-" : "$" + toFixed(2)`), `duration` (`null ? "-" :
  (ms / 1000).toFixed(1) + "s"`), `raised`, `accepted`, `dismissed-agents`, `dismissed-people`,
  `reinstated`, `carried`, `regressions`, `undeclared`, `uncalibrated` (`String(n)`), `calibration`
  (`<a href={"#/goal/" + id}>{id}</a>` or `-`); a header row (`th`) with column names.
  No row in any reply → `p.empty` `No runs or findings in the last 30 days.` inside the group.
- `styles.css`: `.roster .roster-stats` (compact table, numeric cells right-aligned, horizontal
  scroll inside the card at phone width).
Order: after AC-07.
Blast radius: the Roster page only; the hint refetch re-renders groups keyed by `name`, so the
toggle state survives.
Risks: page-level `p.empty` of the Roster ("No agents...") vs the group one: the group's is scoped
inside `section.roster-group`.

### AC-15 Docs and skill

Files: `docs/guide/concepts.md`, `docs/guide/howto.md`, `docs/guide/install.md`,
`src/protocol/skill.ts` (+ `skills/mesh/SKILL.md` via `pnpm schemas`), `docs/plan/implementation-plan.md`,
`docs/events.md`.
Changes:
- concepts: "## Calibration" (counted dismissal, both deciders, once per goal and item, reverts and
  in-round changes of mind excluded, person-raised items not counted, reinstatements against the
  dismissing agent, `calibration.threshold` default 5, one open goal per agent hash, calibrator order,
  the `calibrate` preset and its record, calibrated when the goal is done, dropped goals release) and
  "## Agent statistics" (route, window, every field); under "## Review records" the two RL-6 rules
  (filed = `accepted` with a link, no longer consumed; an agent disposition agreeing with the
  person's latest decision is applied while the item's state is consumed).
- howto: "Calibrate an agent" (Roster `Stats`, what the calibrator gets, `mesh run <repo> --step
  <goal>.calibrate`, the `calibration` input, change on the branch or `no change:`, the threshold).
- install (hub config): `calibration: { threshold: 5 }` next to `artifacts:`.
- skill: a "## Calibration steps" paragraph after "## Debriefs" and a command-table row for
  `mesh run <repo> --step <goal>.calibrate` (read input `calibration`, change the agent on the branch
  or decide no change, `mesh_review` with no items, `assessment` `issues`/`clean`, then `mesh_done`).
- plan §5.6: row `GET /v1/agents/:key/stats?days=` "Calibration (v0.1.20): ... (scope `goals:read`)".
- events.md: `calibration.opened` (user = calibrator; `key`, `hash`, `dismissals`, `threshold`,
  `calibrator`; text) and `calibration.done` (`key`, `hash`, `dismissals`, `outcome`; text).
Order: last, then `pnpm schemas`.
Risks: generic names only (no team, company or person names; examples use `alpha/auditor`).

### AC-16 Version, checks, OpenAPI

Files: `package.json` (`"version": "0.1.20"`), `schemas/hub-api.openapi.json` (generated), section 2.
Order: after everything else: `pnpm schemas`, then `pnpm check` (lint, typecheck, boundaries, test,
build), then `pnpm build` + `pnpm test:web`.
Risks: Postgres contract legs are skipped locally (`MESH_TEST_PG_URL` unset); report them as not run.

### AC-17 Whole programme

Files: whatever module owns a gap the test exposes (`src/hub/service.ts`, `src/daemon/*`,
`src/core/*`); listed in the implementation notes of the change, no contract change.
Expected path through the code (to check when the test runs):
- slot 1: pulse fires G1 (no design); `audit` offered and run headless with telemetry; validate
  confirms A, dismisses B (1 counted dismissal, below threshold 2); `debrief` ready for `ann` only;
  `ann` accepts A via `mesh_dispose`; `file` (consumes `[accepted]`) ready because A has no link
  (fix 1), its record A `accepted` + link is applied (fix 2); G1 done (`markGoalDone`, no calibration).
- slot 2: fold carries B (`carried: 1`, same `eh`), A stays `accepted` with link; validate dismisses C
  → trigger: B (G1) + C (G2) = 2 ≥ 2 → one goal owned by `ann` (rule 2: newest pulse goal that ran
  `alpha/auditor`); `debrief` skipped (no open/confirmed), `file` skipped (A filed, fix 1); G2 done.
- stats: `alpha/auditor` `runs: 2`, `raised: 5`, `new: 3`, `carried: 1`, `accepted: 1` (distinct per
  goal: person + filer entries in G1 count once), `dismissedByAgents: 2`, `calibrating: 2`.
Gaps to watch: telemetry missing on a non-audit run (RL-1 report path); the fake started for a
skipped step (daemon offer for a step settled `skipped` in the same transaction); the filer's
`propose-via-branch` profile on a pulse goal (profile snapshot); `debrief` being offered.
Risks: the test needs device tokens past 14 days (test fixture, not code).

## 5. Checks for the developer to run

`pnpm lint`, `pnpm typecheck`, `pnpm boundaries`, `pnpm test`, `pnpm build` (= `pnpm check`),
`pnpm schemas` (then `git diff --exit-code schemas skills`), `pnpm test:web` after `pnpm build`.
The Postgres legs of the store contract and the AC-04 Postgres `mesh hub migrate` leg are not run
locally (`MESH_TEST_PG_URL` unset; CI runs them); judge them on the SQLite leg.
