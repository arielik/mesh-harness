Verdict: CHANGES REQUESTED | Round: 1 | Blocking-open: 2

# Review of the RL-11 spec, round 1

This is a cold review of `docs/specs/RL-11.md` (commit cfbbb99 on `spec/RL-11`). I read the source
analysis (`docs/analysis/2026-11-19-harness-efficiency-and-insights.md`, I-1, I-2, I-10 and the
critique table) and the RL-10 reviews for format. Then I checked each contract against the code it
touches:
- `src/core/telemetry.ts` (`telemetryFromStream`, the `no_result` rule at line 86) and
  `test/fixtures/claude/stream/spike-sample.jsonl`;
- `src/daemon/runs.ts` (the run end: `decided`, `closeAsFail`, the `finished` report at 840-910);
- `src/protocol/goal.ts` (`Goal`, `RunTelemetry`, `Round`, `Step`), `src/protocol/pulse.ts`
  (`PulseSlot`, `SlotState`), `src/protocol/review.ts` (`ItemState`, `StoredReview`, `ItemRow`,
  `DispositionRow`), `src/protocol/hub.ts` (`RunReport`), `src/protocol/hub-api.ts`;
- `src/hub/service.ts`: `runReport` (918-960), `firePulse` (3509-3530), `fireSlot` (4760-4840) with
  `overlapBusy`, `advanceSlot`, `attempt`, `firePulseTx`, `calibrationScan`, `calibratorFor`,
  `calibrationTrigger`, `agentStats`, `ready` (5203), `listGoals`, `createWithPlan`;
- `src/core/pulse.ts` (`overlapBusy`), `src/core/calibration.ts` (`flagEntries`, `raisingAgents`,
  `countedDismissals`, `calibrationStatus`, `agentStats`);
- `src/hub/app.ts` (the probes, `body()`, `forPerson`, the fire and stats routes, the ZodError
  mapping); `src/store/hub-store.ts` (`addReview` one record per `(step, round)`, `listReviews`,
  `getItem`, `listSteps({updatedSince})`, `SCHEMA_VERSION`);
- `src/cli/pulse-commands.ts` (`fire`, `showText`, `stateText`), `src/cli/hub-commands.ts` (`goal
  ls`), `src/cli/show.ts` (`goal show`); `web/src/api.ts`, `web/src/roster.tsx`;
- `src/main.ts` (how the version reaches the CLI and daemon), `tsdown.config.ts`, `Dockerfile`;
- `test/helpers/world.ts`, `calib-kit.ts`, `pulse-kit.ts`; `test/m46-ops.test.ts`,
  `test/schemas.test.ts`, `test/docs-rl10.test.ts`.

There is no CLAUDE.md in the repo. The hard rule I applied is the one from memory: keep mesh-harness
generic. The spec's names (`p-1`, `m-1`, `FOO`, `cargo`, `git`) are generic, so no hard rule is
broken. `docs/specs/reviews/RL-11/` did not exist, so every finding is **NEW**.

## What holds

- **AC-02's numbers are right.** The five denials group as Bash/git ×2, Bash/(none) ×1, Bash/cargo
  ×1, Write ×1. Sorted by `count` descending, then `tool`, then `command` with absent first, that gives
  `[git 2, Bash 1, cargo 1, Write 1]`, which is the order the spec states. `permissionDenials.count`
  is `denials.length` = 5 (`telemetry.ts:53,67`), and it stays 60 when `denied` is cut to 50.
  `FOO=1 /usr/bin/git` → skip `FOO=1`, then take the part after the last `/` → `git`. That is correct.
- **The `items` counts cover `ItemState` exactly.** `ItemState` is `open, confirmed, dismissed,
  deferred, accepted, resolved` (`review.ts:10`), the six counts besides `raised`, so the counts always
  sum to `raised`. Items are keyed by `(lineage, fp)` and the record carries its `lineage`, so
  "the state now" is one `getItem(record.lineage, fp)` per fingerprint. `addReview` allows one record
  per `(step, round)` (`hub-store.ts:907`), so "the raising record of this round" is unique.
- **Rounds can carry telemetry without a raising record**, and the spec handles that: `items` is
  absent and `allDismissed` is false. Non-review steps, consuming steps and runs that never called
  `mesh_review` are such rounds. A record's round lines up with the telemetry's round: the daemon
  reports the round its own `done` or `closeAsFail` created (`runs.ts:885-905`).
- **No migration is needed.** `Goal`, `PulseSlot`, `Round` and `RunTelemetry` live in JSON values.
  `RunReport`/`RunTelemetry` are not `.strict()` (`hub.ts:416`), so a 0.1.30 daemon talking to a
  0.1.29 hub has its new fields stripped, not refused. "Upgrade the hub first" is a preference, not a
  requirement, and the Compatibility section is correct.
- **The fire body works through `body()`.** An empty body parses to `{}` (`app.ts:74-82`), and a
  strict schema's ZodError maps to 400 (`app.ts:416`). The CLI already posts `{}` (`hub-client.ts:99`).
  The `forPerson` path reads the header in the middleware and the body in the handler, so a service
  acting for a person can send `{trial: true}` with no change. `slot.by` and the event's `user` are the
  person, as today.
- **Overlap is decided in one place only**: the `fireSlot` loop over `fired` slots
  (`service.ts:4786-4800`). `advanceSlot` and `attempt` never re-check overlap, so the trial rule
  needs one condition there (skip goals with `trial`), and the `pending` slots need nothing new.
- **Calibrator rule 2** is one loop over pulse goals (`service.ts:3689-3699`), so "skips trial goals"
  is a one-line filter.

## Blockers

### B1 (NEW): `waste.failed` marks successful runs as failed

The spec defines `failed` = `telemetry.exit !== "success"` (RL-11.md:84). That is wrong for a run the
daemon stops after an accepted `mesh_done`. Such a run has no `result` event, and `telemetryFromStream`
gives it `exit: "no_result"` (`telemetry.ts:84-86`, with the comment "a run ended by the daemon
after its accepted mesh_done did not crash"; `telemetry.test.ts:114-115`). The round is `outcome:
"done"` and the step's work is accepted, yet its row reports `failed: true`. A run with `exitCode 0`
and no `result` event also gets `no_result`. The reverse case is also lost: a run with `exit:
"success"` whose agent closed the step `fail` reports `failed: false`.

The source analysis does not define it this way either. Its "Failed-run turns" row
(`analysis…:115`) counts a run whose `exit` is not `success` **and** whose round was retried or the
step failed. The spec says the hub "reports the parts only", so every part must be right. A consumer
that sums `failed` will count lingering-but-successful runs as waste.

**Fix:** define `failed` = `round.outcome === "fail"`, and keep `exit` as the raw cause in
`telemetry`. Alternatively, define `failed` = `exit !== "success" && !(exit === "no_result" &&
round.outcome === "done")`, and say why. Extend AC-04 with a row whose telemetry is `exit:
"no_result"` and whose round is `done`, and fix the expected `failed` for it.

### B2 (NEW): excluding trial goals from agent statistics is not fully specified

"leaves out runs, review records, dispositions and dismissals that belong to trial goals"
(RL-11.md:149) leaves several counts open, and AC-10 only pins `runs` and one dismissal. Two correct
implementations would show different numbers in the Roster:

1. **Which goal does a disposition belong to?** A `DispositionRow.goal` is the goal of the step that
   recorded it, not the goal that raised the item. Items are per lineage (`<preset>|<repo>|<agent>`),
   so they live across goals. An item first raised in a trial goal can be raised again and dismissed
   in a later scheduled goal, or the other way round. Today, counting attributes a dismissal to
   `raisingAgentOf(raising, e.goal, e.lineage)` (`calibration.ts:117`, `:261`), which is the
   disposition's own goal. State the rule: an entry belongs to a trial goal when `entry.goal` is a
   trial goal, whatever goal first raised the item. Add a criterion for that case: the item is raised
   in a trial goal, raised again in a normal goal and dismissed there, and the dismissal counts by
   default.
2. **`reinstated`** pairs an agent's dismissal `e` with the next person decision `n`
   (`calibration.ts:286-298`). The two can be in different goals: for example, an item dismissed in a
   trial goal and reinstated by a person in a normal goal. Say which entry decides (`e` is the natural
   choice, because the count is about the agent's dismissal).
3. **`uncalibrated` / `calibrating` / `calibrated` have no window** (`calibration.ts:271-279`). With
   `?trial=include`, a trial dismissal is counted, but the Calibration rule says it is "never listed in
   a calibration goal". So it is `uncalibrated` forever, and `include` shows an `uncalibrated` count
   that calibration can never clear. It can also exceed the threshold while no goal opens. Say whether
   `include` adds trial dismissals to these three counts, and if it does, how the Roster explains them.
   One option: they are left out of the calibration counts even with `include`.
4. **`lastAt` and rows that disappear.** `lastAt` falls back to `anyDismissalAt`, which has no window
   (`:336`), and a hash whose counts are all 0 is dropped (`:331`). By default, a hash used only in
   trial goals disappears from the stats. Say that it does, and that `lastAt` ignores trial activity
   by default.
5. **Where it is filtered.** `calibrationScan` feeds both calibration and the stats
   (`service.ts:3626-3651`). Say that calibration always uses the trial-free `counted`, and that the
   stats choose between the two lists by `trial`.

**Fix:** add a "Trial goals in counting" paragraph that gives the attribution rule (entry goal, run
goal, record goal), the `reinstated` rule, the no-window counts under both values of `trial`, and
`lastAt`. Extend AC-10 to assert every field of `AgentHashStats` under both values. Include the
cross-goal case from point 1 and one reinstated pair.

## Suggestions

### S1 (NEW): `finishedAt` is the `done` time, but telemetry arrives later
`round.finishedAt` is set when the step closes. The telemetry comes in a later `finished` report,
after the push and the transcript, possibly hours later if the daemon was offline
(`runs.ts:840-910`). A client that polls `since=<last poll>` misses every row whose telemetry
arrived after its poll. Say this in the contract and in the concepts "Runs" section ("poll with an
overlap, or page by `finishedAt` and de-duplicate by `runId`"), or order and window by the time the
telemetry was stored. Also: `step.updatedAt ≥ round.finishedAt` always holds, because the `done` and
the run report both save the step. So `listSteps({updatedSince: since})` (`hub-store.ts:795`) is a
valid pre-filter. Say so, so that the route does not parse every step of the hub on each call.

### S2 (NEW): runs without a round are not rows, contrary to "one row per headless run"
When the daemon's `done` is refused (the step was released or taken), it sends `finished` without
`round` (`runs.ts:888-905`). `runReport` then stores nothing and only emits `run.finished`
(`service.ts:940-957`). Those runs cost tokens and are waste by definition, but `GET /v1/runs` cannot
list them. Either say "one row per headless run that closed a round" in Problem and Scope, or list
them (from the event) in a later release, and note it under Out.

### S3 (NEW): `since`/`until` details
- `Date.parse` accepts many non-ISO strings (`"Nov 20 2026"`, `"2026-11-20 10:00"`). Either name a
  strict ISO pattern, or say "anything `Date.parse` accepts". AC-05's "bad `since`" must then use a
  value both readings refuse.
- `until` alone, older than now − 30 days: the default `since` is then ≥ `until`. Is that a 400 whose
  message names a `since` the caller never sent, or an empty list? Say that the default `since`
  applies only when neither `since` nor `cursor` is given, or that the check only runs when both are
  given.
- AC-06: put the two rows that tie on `finishedAt` across a page boundary (rows 2 and 3 with
  `limit=2`). Otherwise the cursor's tie handling is never exercised.

### S4 (NEW): hub validation of the new telemetry fields is under-specified
"The hub validates both fields with the limits above" (RL-11.md:102), but the table also says "sorted,
distinct". Say whether the hub refuses an unsorted or duplicated `toolsUsed` (400) or accepts it.
`denied` has no per-field limits: give `tool` 1–200, `command` 1–64, `count` an integer ≥ 1, and
entries distinct by `(tool, command)`. Say on the daemon side that a `tool_use` or denial whose name
is not a non-empty string is skipped. Distinctness must hold after the 200-character cut. A 400 is not
retried (`runs.ts:906`), so one bad name loses all of the run's telemetry. AC-03 tests only the size
limits.

### S5 (NEW): `/healthz` version: name its source, and update the existing probe tests
`HubService` and `createApp` have no version today. Only `src/main.ts:2` imports `package.json`, and it
passes `pkg.version` to the CLI and the daemon. Say where the hub reads it, for example `import pkg
from "../../package.json"` in `src/hub/app.ts`, which tsdown inlines into `dist/main.mjs` as it does
for `main.ts`. Or pass it in through `HubConfig`/`startHub`, and then say how `World` passes it, so that
AC-14's `version:<package.json version>` does not come out `undefined` in tests. Put `features` in a
`src/protocol` constant (`HUB_FEATURES`), so that clients and the docs test can import it. Also:
- `GET /health` is documented as "same as /healthz" (`hub-api.ts:86`). Say whether it gains the
  fields, or change its summary.
- `test/m46-ops.test.ts:68-69` and `:87` assert the probe bodies with `toEqual` (`{ok: true}` and `{ok,
  schema}`). They must change. Name them as updated earlier criteria, the way the schema-version test
  names its history (`m46-ops.test.ts:71`).

### S6 (NEW): the CLI's "skipped" message can name a trial goal
`mesh pulse fire` on a skip prints the first `fired` slot whose goal is live (`pulse-commands.ts:255-
258`). Under RL-11, that goal can be a trial goal, which by definition does not block. The CLI cannot
tell, because `PulseDetail.goals` maps id → state only. Fix: put the blocking goal on the skipped slot
(it is already in the `pulse.skipped` payload as `running`), or add `trial` to `PulseDetail.goals`. Give
the exact output of a skipped trial fire (`Pulse p-1 skipped slot manual:… (trial): G7 is still
running (overlap: skip).`).

### S7 (NEW): a trial goal can still starve a scheduled slot through capacity
"does not block the pulse's slots" holds for overlap only. A trial run that occupies a machine's
headless capacity makes the scheduled slot's offer come back `capacity`, and the slot is `missed
(capacity)` when its window ends (`service.ts:4699`). Say it, in the contract or in the guide's "firing
a trial while tuning" paragraph ("fire trials on a machine the pulse does not target").

### S8 (NEW): the `missed (error)` trial slot is built outside `base`
"a slot recorded `missed` … keeps `trial: true`": the `firePulse` error path builds its slot literally
(`service.ts:3523`), not from `fireSlot`'s `base`, so it would lose `trial`. Name both paths, and add a
line to AC-08 (an injected error on a trial fire → a `missed (error)` slot with `trial: true`).

### S9 (NEW): markers: `[trial]` collides with the topic brackets
`mesh goal ls` already prints `  [topic, …]` after the title (`hub-commands.ts:241`), so a goal tagged
with a topic `trial` prints `[trial]` today. Give the exact line, for example `G7 … title [trial]
[a, b]`, or use another mark (`(trial)`, as the pulse commands do). For `mesh pulse show`, `stateText`
gives `skipped (overlap)`. Say whether the line is `skipped (overlap) (trial)` or `skipped (trial)
(overlap)`, and make AC-13 exact.

### S10 (NEW): AC-11's calibrator half needs two owners
A trial goal's owner is the **pulse owner** (`createWithPlan({owner: p.owner})`, `service.ts:4806`),
not the person who fired it. Trial and normal goals of one pulse therefore have the same owner, and
"the calibrator is the normal goal's owner" cannot fail. State the setup: two pulses with different
owners running the same key, or the trial pulse newer, and no catalog `calibrator` (rule 1). Likewise,
AC-03's `machine "m-1"` is not a value a test controls (machine ids come from login). Write "the
caller's machine id (`World.machineOf`)".

### S11 (NEW): a trial dismissal silences an item without ever counting
Trial records fold and dispositions apply as usual (Out, RL-11.md:44-45), and items are shared by
lineage. A false positive dismissed in a trial goal therefore stays dismissed in production (a repeat
keeps the state), and it never counts toward calibration. A complete-coverage trial record of a broken
agent also resolves the lineage's open items. Both follow from the stated decision, but the guide
should say so in the trial paragraph: "dismissals you make while tuning are real and never reach
calibration; prefer a separate preset/lineage for experiments".

### S12 (NEW): docs and schema conventions
- `test/docs-rl10.test.ts` also checks the API table in `docs/plan/implementation-plan.md`
  (`test_AC12_api_table`). Add `GET /v1/runs`, the fire body and the stats `trial` query to that table,
  and list it in the Docs section.
- The OpenAPI list (RL-11.md:176) omits the `trial` query of `GET /v1/agents/:key/stats`
  (`hub-api.ts:180-184` documents `days`). Give `GET /v1/runs` a `response` schema (`RunRow`), as
  `/v1/events` has one (`hub-api.ts:290`).
- `skills/mesh/SKILL.md` is generated: `test/schemas.test.ts` requires it to equal `MESH_SKILL`. The
  edit belongs in `src/protocol/skill.ts`, followed by `pnpm schemas`. Say that.
- AC-15: "the schema file unchanged" should read "every file under `schemas/`", because
  `test/schemas.test.ts` checks all of them. Name the `## ` sections the docs test will look for
  (concepts: Telemetry, Runs, Pulses, Agent statistics; operations: Probes and "Upgrading to 0.1.30").

## Checks

Run: none of the repo's checks. This round reviews a spec, and nothing is implemented. I read the code
and tests named above and recomputed AC-02's order and counts by hand.

Not run: `pnpm lint`, `pnpm typecheck`, `pnpm test`, `pnpm build`, `pnpm check`, `pnpm schemas`,
`pnpm test:web`.
