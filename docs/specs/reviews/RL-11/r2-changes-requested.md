Verdict: CHANGES REQUESTED | Round: 2 | Blocking-open: 1

# Review of the RL-11 spec, round 2

This is a cold review of `docs/specs/RL-11.md`, revision 2 (commit 40a3da7 on `spec/RL-11`). I read the
round-1 review first, then the spec. Then I checked the revised contracts against the code they touch:
- `src/core/telemetry.ts` (`telemetryFromStream`, both the `result` path and the no-result path);
- `src/core/calibration.ts` (`flagEntries`, `raisingAgents`, `countedDismissals`, `calibrationStatus`,
  `agentStats`, including the `accepted`, `raised` and `reinstated` loops);
- `src/hub/service.ts`: `runReport`, `firePulse` (and its error path), `fireSlot` (overlap,
  `createWithPlan`, `pulse.fired`), `calibrationScan`, `calibratorFor`, `calibrationTrigger`,
  `agentStats`, `ready`, `disposeStep`;
- `src/hub/app.ts` (the probes, the fire and stats routes); `src/protocol/goal.ts` (`Round`,
  `RunTelemetry`), `src/protocol/pulse.ts` (`PulseSlot`), `src/protocol/hub-api.ts` (probes, fire,
  stats);
- `src/cli/pulse-commands.ts` (`fire`, `showText`, `stateText`), `src/cli/hub-commands.ts` (`goal
  ls`), `src/cli/show.ts` (first line of `goal show`);
- `test/helpers/calib-kit.ts`, `test/calibration-hub.test.ts` (RL-6 AC-09), `test/m46-ops.test.ts`,
  `test/docs-rl10.test.ts`, `test/pulse-cli.test.ts` (the injected-error fire); the section headings of
  `docs/guide/concepts.md` and `docs/guide/operations.md`.

No hard rule is broken: the names stay generic (`p-1`, `ann`, `bob`, `K`, `FOO`, `cargo`).

## Round-1 findings

| Id | Status | Reason |
|---|---|---|
| B1 | RESOLVED | `waste.failed` = `round.outcome === "fail"` (RL-11.md:91), with `exit` kept as the raw cause and the `no_result` case explained. AC-04 adds a `no_result`/`done` run with `failed` false. This matches `agentStats`' `failures` (`calibration.ts:238`). |
| B2 | PARTIAL (rules resolved; the remainder is non-blocking, see S13) | "Trial goals in counting" (RL-11.md:191-221) gives the attribution of runs, records, entries (by `entry.goal`) and reinstatements (by `e`), keeps the no-window counts and the `lastAt` fallback on the calibration list under both values, says hashes with only trial activity disappear, and has `calibrationScan` return both lists. AC-10 includes the cross-goal X case and one reinstated pair. It asserts 7 of the `AgentHashStats` fields, not every field, and its reinstated number does not follow from its setup (B3). |
| S1 | RESOLVED | "Telemetry arrives after the round" (RL-11.md:147-151) and the `updatedAt` pre-filter note (153-155). The pre-filter claim holds: `runReport` saves the step with `updatedAt: now` (`service.ts:946`). |
| S2 | RESOLVED | Scope says "that closed a round", and Out lists the runs without a round. |
| S3 | RESOLVED | A strict ms/ISO pattern. `until` alone gives `[]`. The `since ≥ until` check runs only when both are given. AC-06 puts the tie across a page boundary (rows 2 and 3 with `limit=2`). |
| S4 | RESOLVED | Per-field limits for `denied`. The hub checks order and distinctness. The daemon skips bad names and cuts before de-duplicating. AC-03 tests the shape errors. See S15 for the one comparison it leaves open. |
| S5 | RESOLVED | The version comes from `package.json` imported in `src/hub/app.ts`, as in `src/main.ts:2`. `HUB_FEATURES` is in `src/protocol/hub.ts`. `/health` answers the same body. The `m46-ops` probe tests are named as updated, at lines 68-69, 75, 87 and 106. |
| S6 | RESOLVED | `PulseSlot.running`, and the CLI reads it, with today's guess kept as a fallback for older hubs. AC-09 makes the old guess fail: the newer trial goal is listed first. |
| S7 | RESOLVED | The capacity paragraph (RL-11.md:177-180) and the guide advice. |
| S8 | RESOLVED | The `firePulse` error path is named (RL-11.md:170-171), and AC-08 checks it. The CLI line matches `pulse-commands.ts:262`, on stderr with exit 1, plus ` (trial)`. |
| S9 | RESOLVED | The `goal ls` line is exact. I rebuilt it from `hub-commands.ts:241` (`padEnd(5)`, `padEnd(18)`, `padEnd(12)`, two spaces before `[ci]`), and it matches character for character. `pulse show` gives `skipped (overlap) (trial)`, which follows `stateText` and `showText` (`pulse-commands.ts:28,159`). |
| S10 | RESOLVED | AC-11 uses two pulses with owners ann and bob and no catalog calibrator. AC-03 uses `World.machineOf`. See S16 for a small gap in rule 3. |
| S11 | RESOLVED | RL-11.md:182-185 and the scheduled-reviews guide item. |
| S12 | RESOLVED | The implementation-plan API table, the stats `trial` query and a `RunRow` response in `hub-api.ts`, `skill.ts` plus `pnpm schemas`, "every file under `schemas/`", and the section names. The named sections exist today: `## Telemetry`, `## Pulses` and `## Agent statistics` in concepts, `### Probes` in operations. |

## What holds (recomputed)

- **AC-02.** Five entries have a `tool_name`: `(Bash, git)` ×2, `(Bash, cargo)` ×1, `(Write)` ×1 and
  `(Bash, –)` ×1 (input `{}`). The entry without `tool_name` is skipped but counted, so
  `permissionDenials.count` = `denials.length` = 6 (`telemetry.ts:51,64`). Sorted by `count`
  descending, then `tool`, then `command` with absent first, that gives `[git 2, Bash 1, cargo 1, Write
  1]`, the stated order.
- **AC-10 `raised`.** `raised` adds the distinct fingerprints of every raising record of key K in the
  window (`calibration.ts:246-249`). Default: N {N1, N2} + M {X} = 3. With `include`, T {T1, X} is added,
  so 5. That is correct.
- **AC-10 `accepted`.** `accepted` counts distinct `(goal, lineage, fp)` acceptances, credited to the
  raising agent of `(e.goal, lineage)` (`:257-269`). Only N1 is accepted, in N, so it is 1 under both
  values. That is correct, but the trial filter on `accepted` is never exercised (S13).
- **AC-10 `dismissedByAgents` / `uncalibrated`.** Counted dismissals are keyed by
  `(e.goal, lineage, fp)`, and their raising agent is that of `(e.goal, lineage)` (`:112-133`). N2 stays
  counted after the person's `confirmed`, because a confirm is not a revert (`flagEntries`). Default: N2
  plus X-in-M = 2. With `include`, T1 is added, so 3. `uncalibrated` = 2 under both values. The default
  threshold is 5 (`config.ts:104`), so no calibration goal opens. That is correct.
- **AC-10 `runs` / `meanDurationMs`.** 1 / 1000 by default and 2 / 2000 with `include`, if M has no
  run (implied by "a raising record of item X only"). That is correct.
- **AC-11.** With threshold 2 and trial-free counted dismissals, the two trial dismissals give an empty
  list, one normal dismissal is below the threshold, and two reach it. Rule 2 of `calibratorFor`
  (`service.ts:3689-3699`) reads `round.finishedAt` of pulse goals' rounds with telemetry. Skipping
  trial goals there makes ann's older normal goal win. That is correct.
- **CLI lines.** Fired, skipped and missed with ` (trial)` follow `pulse-commands.ts:252-262`. The
  `goal show` mark follows `show.ts:25`.
- **Probes.** `ready()` returns `{ok, schema?, error?}`, and adding `version` to both replies is local
  to the route. `/healthz` takes `schema` from `HubStore.SCHEMA_VERSION`, with no database read, so
  AC-14's "database does not answer" case can pass.

## Blockers

### B3 (NEW): AC-10's `reinstated` 1 does not follow from its setup

`reinstated` counts **the dismissing agent's** own dismissals, under the dismissing agent's key and
hash, not the raising agent's: `e.decider.kind === "agent" && e.decider.key === key`, and then
`of(e.decider.hash)` (`calibration.ts:296-301`). AC-10 says only "N2 `dismissed` by an agent", then
expects `reinstated` 1 in **K@H**'s row. The RL-6 kit dismisses by default as the checker
(`agentDispose(..., agent = { key: CHECK, hash: V })`, `calib-kit.ts:118`). With that default, the
reinstatement lands in `alpha/checker`'s stats, and K@H's `reinstated` is 0. RL-6 AC-09 asserts exactly
this split (`calibration-hub.test.ts:494-498`: the checker's `reinstated: 1`, the auditor's
`reinstated: 0`). A correct implementation would then fail AC-10's "any other count" clause, and a test
author might "fix" the counting code to match the AC.

**Fix:** in AC-10, say "N2 `dismissed` by K@H itself (`agentDispose(..., {key: K, hash: H})`), then
`confirmed` by a person". Alternatively, keep a checker as the dismisser and assert `reinstated` 1 on
the checker's row and 0 on K@H's. In either case, state which agent records each dismissal and
acceptance in N, T and M. The "what makes it FAIL" column depends on it.

## Suggestions

### S13 (NEW): AC-10 does not exercise the trial filter on most fields
In AC-10, `accepted` is 1 and `reinstated` is 1 under both values. `dismissedByPeople`, `failures`,
`meanCostUsd`, `new`/`regressions`/`carried`/`undeclaredRules`, `calibrating`/`calibrated` and `lastAt`
are not asserted. So an implementation that forgets the trial filter on acceptances, reinstatements or
person dismissals still passes, and so does one that breaks the `lastAt` fallback rule (RL-11.md:215-216).
Add these to T:
- an acceptance;
- a person's dismissal;
- a cross-goal reinstatement: an item raised and dismissed by K@H in T, raised again in N and confirmed
  by a person there. It is left out by default and counted with `include`, by the rule "belongs to `e`".
  The reverse pair (`e` in N, `n` in T) is counted under both values.

Then assert every `AgentHashStats` field under both values, including `lastAt` and the costs, as B2
asked in round 1.

### S14 (NEW): "K@H2 used only in T" can change T's raising agent
`raisingAgents` keeps one agent per `(goal, lineage)`: the decider of the **newest** raising record
(`calibration.ts:88-95`). If the H2 usage in T is a raising record on the same lineage, T1's dismissal is
credited to K@H2, and `include` then gives K@H `dismissedByAgents` 2, not 3. Say that the H2 usage is a
run with telemetry only (a `P.run` step with no review record), or put it in its own trial goal.

### S15 (NEW): name one string order for `toolsUsed`, on both sides
The daemon sorts in "code-point order" (RL-11.md:98). The hub checks "strictly ascending" (RL-11.md:58,
111) without naming a comparison. JS `<` and `Array.prototype.sort()` compare UTF-16 code units, and
the two orders differ for names that mix characters above U+FFFF with characters in U+E000–U+FFFF. A
400 is not retried, so a mismatch loses the run's telemetry. Name the same order in both places. The
simplest is UTF-16 code-unit order, which is what `sort()` and `<` give. Then fix AC-01's wording to
match.

### S16 (NEW): small gaps in docs and in AC-11
- `docs/guide/concepts.md` has a `## Calibration` section (line 578), separate from `## Agent
  statistics`. Two things change calibration: trial dismissals never count, and the calibrator skips
  trial goals. Say that in `## Calibration` too, and add it to the Docs list and to AC-15.
- AC-11: say that the two normal dismissals are in a goal **not** owned by ann, for example a non-pulse
  goal of carol. Otherwise rule 3 (the owner of the newest dismissal's goal, `service.ts:3702`) also
  returns ann, and an implementation that drops rule 2 altogether still passes.
- Scope (RL-11.md:35-36): "left out of agent statistics, calibration and `GET /v1/runs` unless asked
  for". Calibration can never be asked to include trial goals. Reword this as "left out of
  calibration, and of agent statistics and `GET /v1/runs` unless asked for".

## Checks

Run: none of the repo's checks. This round reviews a spec, and nothing is implemented. I recomputed AC-02,
AC-10 and AC-11 by hand against `src/core/calibration.ts` and `src/hub/service.ts`. I rebuilt the `goal ls`
example line from the padding in `hub-commands.ts:241` with a one-line script, and it matches.

Not run: `pnpm lint`, `pnpm typecheck`, `pnpm test`, `pnpm build`, `pnpm check`, `pnpm schemas`,
`pnpm test:web`.
