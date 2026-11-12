# RL-8 implementation plan

Spec: `docs/specs/RL-8.md` (approved, review round 3). Release v0.1.22. One section per acceptance
criterion; each lists files, changes, order, blast radius and risks. Tests are not planned here (the
test side plans from the spec alone). The developer changes no test except the existing ones listed
under "Existing tests and snapshots" at the end, and only where the spec changes the asserted
behaviour.

## Build order (all criteria)

1. **Core, pure** (`src/core/session-state.ts`): the `print` kind rule in `applyEntry` (AC-07).
2. **Protocol** (`src/protocol/pulse.ts`): `PulseView.warnings?: string[]` (AC-08..AC-10).
3. **Daemon runs** (`src/daemon/runs.ts`): `gitError`, the start guard and capacity reservation,
   no transcript for never-started runs, the leftover sweep (AC-01..AC-06).
4. **Daemon** (`src/daemon/daemon.ts`): `liveCount` uses the new count, sweep at start-up and on
   reconcile (AC-02, AC-06).
5. **Hub** (`src/hub/service.ts`): `pulseWarnings` and the `warnings` field on create/update
   (AC-08, AC-09).
6. **CLI** (`src/cli/pulse-commands.ts`): print warnings on stderr (AC-10).
7. **Docs, skill, version, schemas** last (AC-11, AC-12): `pnpm schemas` regenerates
   `skills/mesh/SKILL.md` from `MESH_SKILL` and must leave `schemas/hub-api.openapi.json` unchanged.

No migration, `SCHEMA_VERSION` unchanged, no new hub or `/local` route, `RunFile` unchanged (no
`starting` state). `src/daemon` keeps importing no `child_process`.

---

## AC-01 Start race (a run is started at most once)

**Files.** `src/daemon/runs.ts`.

**Changes.**
- New private field `private starting = new Set<string>()` (runIds whose start is in progress,
  per daemon process; never persisted).
- New private synchronous `beginStart(run: RunFile): RunFile | undefined`:
  re-reads `cur = this.runs.get(run.runId)`; returns `undefined` when `cur` is missing,
  `cur.state !== "queued"`, `cur.endedAt !== undefined` or `this.starting.has(run.runId)`;
  otherwise `this.starting.add(run.runId)` and returns `cur`. Capacity (AC-02) is checked in the
  same synchronous block by the callers, before `beginStart`, with no `await` in between.
- `start(run)` is split: the public entry points call `beginStart` first, then
  `await this.startInner(cur)` inside `try { … } finally { this.starting.delete(runId) }`.
  `startInner` is today's `start` body unchanged except for the git text (AC-03) and the
  hardening below. The `finally` runs after `registerRunSession` and `reportStarted` (the start
  "ends" when the run is `running` with a pid, or ended as not started).
- `queuePass()`:
  - Iterates the queued snapshot as today, but at the top of each iteration re-reads
    `const cur = this.runs.get(run.runId)` and `continue`s when `cur?.state !== "queued"` or
    `this.starting.has(run.runId)` (spec rule 2: a starting run is neither started nor
    **released**; the deadline/release branch must come after this skip).
  - Replaces `await this.start(run)` by: capacity check, then `beginStart(cur)`, then the awaited
    inner start (same synchronous block up to the first `await`).
- `handleOffer()`: replaces the tail `if (max === undefined || liveCount() < max) await this.start(run)`
  with the same check-then-`beginStart` (no `await` between `this.save(run)`, the capacity check and
  `beginStart`). The early `existing` return (same offer id) is unchanged (rule 3).
- Hardening for rule 5 (a never-started run never gets a `pid`/`startedAt`/session, a `finished`
  file never goes back to `running`): in `startInner`, right before saving `state: "running"` after
  `runner.start` returns `ok`, re-read `this.runs.get(runId)`; if it is no longer `queued` (should not
  happen with the guard), log, `runner.kill(pid, startId)` and return without saving. The existing
  `this.save(next)` calls inside `startInner` build on `run`; keep them, the guard makes them the only
  writer of that run during the start.
- `onSessionStart()`: also skip runs with `startedAt === undefined` (a hook can never bind a
  never-started run's session id).

**Order.** Before AC-02 (same field) and AC-04.

**Blast radius.** Every headless start path (offers, queue pass after restart, queue pass after an
end). Log texts unchanged; exactly one `started` line per run.

**Risks.**
- An exception escaping `startInner` must still clear `starting` (hence `finally`); otherwise the
  run stays `queued` forever in this process. A start that throws today leaves the run `queued`; keep
  that behaviour (no new not-started reason).
- `reconcile()`'s `busy` flag stays; the guard is what protects against `handleOffer` overlapping a
  queue pass, not `busy`.

## AC-02 Capacity during a start

**Files.** `src/daemon/runs.ts`, `src/daemon/daemon.ts`.

**Changes.**
- `runs.ts`: rename `runningWithoutSession()` to `heldWithoutSession()` (or keep the name and update
  its doc; it has a single caller in `daemon.ts`). New semantics, each run counted at most once:
  - a run in `this.starting` with no live session (`state !== "ended"`) whose `claudeSessionIds`
    contains `run.sessionId` → 1 (covers the window before `registerRunSession`; afterwards the
    registered session is counted by `liveCount`'s `live.length`, so no double count);
  - else today's rule: `state === "running"`, no `endedAt`, `startedAt` set, no live session seen → 1.
  The `starting` branch is checked first so a run is never counted by both branches.
- `daemon.ts` `liveCount()`: call the renamed method (no other change).
- The capacity check in `handleOffer`/`queuePass` (AC-01) is `max === undefined || this.deps.liveCount() < max`
  immediately followed by `beginStart`, with no `await` in between, so two offers of one pull (the
  daemon's `receive` runs `handleOffer` concurrently) and a queue pass never begin more starts than
  `maxSessions`. The loser stays `queued` and logs today's `run <id>: queued (maxSessions N)` line.

**Order.** After AC-01.

**Blast radius.** `liveCount()` is also used by MM-4 launch-for-offer decisions: a run being started
now blocks a launch as well (intended; it is a live session).

**Risks.** A run that finished `startInner` but whose session never registered (registration threw)
falls back to the existing `startedAt` branch; correct.

## AC-03 Git error text

**Files.** `src/daemon/runs.ts`.

**Changes.**
- Replace `firstLine` with an exported-for-module helper
  `gitError(r: { code: number; stderr: string }): string`: split `r.stderr` on `\n`, strip a trailing
  `\r` from each line, trim, take the **last** non-blank line; if none, `git exited with code ${r.code}`.
- Use it at the three call sites: `could not make a worktree: ${gitError(add)}` (in `startInner`),
  `could not push ${branch}: ${gitError(p)}` (in `push`), `could not remove its worktree: ${gitError(rm)}`
  (in `finish`). Remove `firstLine` (no other user; `src/claude/workflow.ts` has its own unrelated
  `firstLineCwd`).

**Order.** Independent; do with AC-01 since it touches the same lines.

**Blast radius.** Only these three texts.

**Risks.** None beyond the existing `notStarted` summary prefix (unchanged).

## AC-04 Never-started run: no transcript, no session

**Files.** `src/daemon/runs.ts` (and the AC-01 guard, which removes the race that registered a session
after `notStarted`).

**Changes.**
- `finish()`: in the `decided === "closed"` branch, when `meta.notStarted` is set skip the transcript
  upload: `if (!e.transcriptDone && meta.notStarted === undefined) { …upload… }`, and when
  `meta.notStarted` is set write `transcriptDone: true` without a call (so a retry never uploads it).
  The `done` call (summary `headless run of <step> did not start: <reason>`), the `finished` report
  (`telemetry.exit` stays `crashed` from `telemetryFromStream` with no stream), the worktree removal
  and the final `state: "finished"` stay as today. `artifacts.jsonl` is empty, so no `artifactIds`.
- No session: with the guard, `registerRunSession` is reached only by the one start that got `ok`
  from `runner.start`, which never coexists with a `notStarted` of the same run. `notStarted()` keeps
  calling `endRunSessions(runSids(run))` (a no-op for a run that never had a session).
  `runForPid` already requires a `pid` (a never-started run has none), so the tool-call bind path
  (`daemon.ts` ~line 1105) cannot bind it; `onSessionStart` gets the `startedAt` check (AC-01).
- No `bind:<sid>:<step>` claim: follows from no registration.

**Order.** After AC-01.

**Blast radius.** Never-started runs only (worktree failure, missing/invalid agent, roster resolve
failure, missing profile, `runner.start` `{ok:false}`). Started runs are untouched (AC-05).

**Risks.** A run that was `notStarted` on v0.1.21 and is still unfinished at upgrade (`end.json`
without `transcriptDone`) now skips the transcript; acceptable and matches the spec.

## AC-05 Started runs keep their transcript

**Files.** `src/daemon/runs.ts` (`finish`).

**Changes.** None beyond the AC-04 condition: the skip keys on `meta.notStarted` only, never on the
transcript's length or on `startedAt`, so a run that started and produced nothing still uploads
`run transcript (no_result)` and closes with `headless run ended without mesh_done (exit no_result)`.

**Order.** With AC-04.

**Blast radius / risks.** Do not key the skip on `run.startedAt === undefined` alone: a run reaped
after a restart always has `startedAt`, but keying on `notStarted` is the spec's definition.

## AC-06 Leftover run sessions end

**Files.** `src/daemon/runs.ts`, `src/daemon/daemon.ts`.

**Changes.**
- `runs.ts`:
  - New public `leftoverSids(): Set<string>`: `protect` = union of `runSids(r)` for every run with
    `state === "running"` (with or without `endedAt`). For every run `F` with `state === "finished"`,
    `F.pid !== undefined`: add `s.sid` for each session `s` of `this.deps.sessions()` with
    `s.state !== "ended"`, `s.kind === "print"`, `s.pid === F.pid`,
    `s.claudeSessionIds.includes(F.sessionId)` and `!protect.has(s.sid)`. Pid alone never matches.
  - New public `sweepLeftovers(): void`: `const sids = this.leftoverSids(); if (sids.size) this.deps.endRunSessions(sids, "headless run finished")`.
  - `finish()`: right before `this.save({ ...final, state: "finished", exit })`, end every live
    `print` session of the run: `runSids(run)` filtered by `deps.sessions()` entries with
    `kind === "print"` and `state !== "ended"`, then `endRunSessions` (a no-op when `markEnded` already
    ended them; covers a session revived between the end and the finish).
  - `reconcile()`: call `this.sweepLeftovers()` at the end of the `try` block (every pass, after
    `finish` may have set files `finished`).
- `daemon.ts` `start()`: after `this.runs?.load()`, call `this.runs?.sweepLeftovers()` (sessions are
  already loaded from the store at that point). `endRunSessions` commits and flushes, so the machine
  report (`GET /v1/fleet`, `mesh machines`) no longer lists the session as working after the next flush.

**Order.** After AC-07 (the sweep matches on `kind: "print"`, which the reconciler must stop
overwriting) and after AC-01.

**Blast radius.** Only `print` sessions that carry a finished run's session id and pid. Interactive
or `unknown` sessions (a person's `claude --resume`, new pid) and any running run's sessions are
never touched.

**Risks.**
- `test/relay-daemon.test.ts` `test_AC39_held_message_delivered_after_the_run` revives a finished
  run's session with a `SessionStart` hook (pid 7) after the run ended. If that revived session ends
  up `kind: "print"` with the run file's pid, the sweep would end it again. Check what pid the hook and
  the run file carry there (the fake's real pid vs 7); the spec says pid reuse alone never matches, and
  a resumed session normally has another pid. If they collide, do not change the test: record it in
  the spec's Open questions and report it.
- Pid reuse (AC-06d): the `protect` set is computed from `runSids` of running runs, which includes
  sessions found by `claudeSessionIds`, so the running run's session is protected even when its pid
  equals an older finished file's pid (and it also lacks the old file's session id).

## AC-07 Kind stays `print`

**Files.** `src/core/session-state.ts`.

**Changes.**
- `applyEntry(s, e, now)`: before `s.pid = e.pid`, compute
  `const keepPrint = s.kind === "print" && e.pid !== undefined && e.pid === s.pid;` and set
  `s.kind = keepPrint ? "print" : kindOf(e)`. Every other field the entry sets is unchanged.
- `applyObservation` matching is unchanged: an ended `print` session matched by Claude session id
  from an entry with another pid takes the entry's kind (and the new pid) as today.
- `applyRunSession` keeps `kind: "print"` (RL-7). Hooks do not set `kind` (unchanged).

**Order.** First (pure, no deps).

**Blast radius.** Only sessions already `print` (RL-7 run sessions). The reconciler still marks
them `seenByReconciler`, so `applyObservation`'s "process exited" rule applies to them as before.

**Risks.** None known; non-print sessions follow `kindOf` exactly as before.

## AC-08 Pulse warnings, repo agent

**Files.** `src/protocol/pulse.ts`, `src/hub/service.ts`.

**Changes.**
- `src/protocol/pulse.ts`: `PulseView` gains `warnings?: string[] | undefined` (doc: present only in
  the replies of `POST /v1/pulses` and `POST /v1/pulses/:id/update`; not stored). `pulseView()` never
  sets it, so `GET /v1/pulses`, `GET /v1/pulses/:id`, pause/resume/delete replies have none.
- `src/hub/service.ts`: new private `async pulseWarnings(actor: Actor, p: Pulse): Promise<string[]>`:
  1. Instantiate the plan from the stored snapshot:
     `instantiate(parsePreset(p.preset.name, p.preset.text), { repo: p.params.repo ?? "repo", goal: "this goal", params: p.params })`
     inside try/catch (a failure gives `[]`; never fails the route).
  2. For each step in plan order with `a = s.agent ?? s.policy?.agent` set (same expression as
     `pinAgents`), at most one warning:
     - **Roster key** (`a.includes("/")`): AC-09.
     - **Repo agent**: `const view = await this.agentsView(actor, a)`; `g = view.agents.find((x) => x.name === a)`;
       iterate `g.versions` in order; the first version with `invalid !== undefined` that has a copy
       `c` with `c.origin === "repo"`, `c.kind === "claude"` and
       `repoMatches({ id: c.repo.id, name: c.repo.name }, s.repo)` (the instantiated step's repo; fall
       back to `p.params.repo`) → `step "${s.id}": agent ${a} in ${c.repo.name} has invalid front matter: ${version.invalid}`.
     - No match → nothing (an agent no machine reports gives no warning).
  3. Cache `agentsView` results per agent name within one call.
- `createPulse`: after the pulse is created, `return { ...(await this.pulseView(p)), warnings: await this.pulseWarnings(actor, p) }`.
- `updatePulse`: same with `next` (computed after every update, whatever fields changed, from the
  resulting preset/params and the pulse's current pins).
- Status codes and checks unchanged; idempotent replays already return the stored first reply via the
  generic `Idempotency-Key` handling in `src/hub/app.ts` (no change).
- `agentsView` applies the caller's roster visibility (`agentCopyVisible`), so a caller who cannot
  see the reporting machine gets `[]`.

**Order.** Protocol first, then service. Before AC-10.

**Blast radius.** Only the two route replies gain a field. `GET` shapes unchanged (strict-equality
tests of GET replies keep passing).

**Risks.**
- `agentsView` opens `store.tx` while `createPulse`/`updatePulse` are inside `goalTx`; transactions
  nest through `AsyncLocalStorage` in `src/store/db.ts` (SQLite). Confirm the same for
  `src/store/pg.ts`; if pg does not nest, compute the warnings after `goalTx` returns (wrap: run
  `goalTx` to get the pulse, then compute warnings outside). Computing outside the tx is the safer
  default and does not change the contract.
- Existing tests that compare the whole create/update reply with `toStrictEqual` would see the new
  field; see "Existing tests and snapshots".

## AC-09 Pulse warnings, roster key

**Files.** `src/hub/service.ts` (inside `pulseWarnings`).

**Changes.** For a step whose agent `a` contains `/`: `pin = p.agents?.[a]`; without a pin → no
warning. Otherwise `def = (await this.store.listCatalogDefs({ repo: pin.source, name: pin.name })).find((d) => d.hash === pin.hash)`;
when `def?.invalid !== undefined` → `step "${s.id}": roster agent ${def.key} has invalid front matter: ${def.invalid}`.
A definition without `invalid` (also one stored before RL-7) gives none.

**Order.** With AC-08.

**Blast radius / risks.** The pin is the pulse's own (an update of other fields does not re-pin;
`updatePulse` re-pins only when preset/params change, as today). Confirm the stored catalog def row
exposes `invalid` (RL-7 `putCatalogDefs`); `agentsView`'s `frontOf(d)` already reads it.

## AC-10 CLI prints warnings

**Files.** `src/cli/pulse-commands.ts`.

**Changes.** In `add` and `update`, after the unchanged `c.io.out("Created pulse …")` /
`c.io.out("Updated pulse …")` line: `for (const w of p.warnings ?? []) c.io.err(\`warning: ${w}\`);`
and `return 0`. A reply without `warnings` (older hub) prints nothing.

**Order.** After AC-08.

**Blast radius.** stderr of these two subcommands only.

**Risks.** None.

## AC-11 Docs and skill

**Files.** `docs/guide/concepts.md`, `docs/guide/howto.md`, `src/protocol/skill.ts` (`MESH_SKILL`),
`skills/mesh/SKILL.md` (generated), `docs/plan/implementation-plan.md`.

**Changes.**
- `concepts.md`:
  - *Headless steps* (section at ~line 95): a run is started once; a run being started counts toward
    `maxSessions`; a run that did not start stores no transcript and has no session; failure texts
    carry git's last error line; a daemon stopped in the middle of a start may leave a partial
    worktree, so the next start fails with `could not make a worktree: fatal: … already exists`; a
    run's session keeps kind `print`.
  - *Close-as-fail* (~line 184): the transcript is for runs that started.
  - *Pulses* (~line 320) or *Roster* (~line 395): `mesh pulse add`/`update` warn about agents
    flagged invalid (still created/updated).
- `howto.md` `audit-relay` pulse section (~line 462): a sample
  `warning: step "audit": agent bad in alpha has invalid front matter: …` line, saying the pulse is
  still created and the run would fail at start.
- `src/protocol/skill.ts`: the `mesh pulse add` row (~line 172) adds that it warns when a named
  agent is flagged invalid in the roster; regenerate `skills/mesh/SKILL.md` with `pnpm schemas`.
- `docs/plan/implementation-plan.md` API table: rows `POST /v1/pulses` and
  `POST /v1/pulses/:id/{update,pause,resume,delete}` gain
  ``(v0.1.22: the reply carries `warnings` for agents flagged invalid)``. Keep the existing RL-7 text
  that `test/docs-rl7.test.ts` asserts.
- No team-, company- or person-specific names; sample repos stay `alpha` and agents `bad`/`good`.

**Order.** After code (texts follow the implemented behaviour).

**Blast radius / risks.** `test/docs-rl7.test.ts` asserts RL-7 strings in `concepts.md` and the plan
table; edit around them, do not remove them.

## AC-12 Version and checks

**Files.** `package.json`, `schemas/hub-api.openapi.json` (must stay unchanged).

**Changes.** `"version": "0.1.22"`. Run `pnpm schemas` and confirm no diff in
`schemas/hub-api.openapi.json` (pulse responses are typed `object` there; `PulseView` is a TS type,
not a zod schema). Run `pnpm check` (lint, typecheck, boundaries, test, build). `src/daemon` gets no
`child_process` import (all git calls stay behind `HeadlessRunner.git`).

**Order.** Last.

**Risks.** If `pnpm schemas` changes the OpenAPI document, find what changed the route list or a
schema (nothing in this plan should) instead of committing the diff.

---

## Existing tests and snapshots the developer may adjust

Only where the spec changes the asserted behaviour:

- `test/schemas.test.ts` ~line 685-686: the release version assertion `0.1.21` becomes `0.1.22`
  (the comment names RL-7 AC-17; keep the assertion style).
- Tests of never-started runs (`test/relay-daemon.test.ts` `test_AC22_missing_agent`,
  `test/roster-daemon.test.ts` AC-21 cases, `test/relay-run-session.test.ts` AC-10): the reviewed
  lines assert summary, `crashed` and the run file only, not a transcript, so no change is expected;
  adjust only an assertion that expects a `transcript` artifact or a non-empty `artifactIds` for a
  never-started run.
- Pulse create/update reply assertions in `test/pulse-hub.test.ts`, `test/pulse-cli.test.ts`,
  `test/pulse-replicas.test.ts`, `test/relay-hub.test.ts`: only where a whole `POST /v1/pulses` or
  `/update` reply is compared with `toStrictEqual` (the new `warnings` field); GET comparisons are
  unaffected. CLI tests that assert stderr is empty after `mesh pulse add`/`update` are unaffected
  unless the fixture reports an invalid agent.
- Any test asserting `kind: "interactive"` on a headless run's session after a reconcile (none found
  in a search of `test/`; `relay-run-session.test.ts` line 107 already expects `print`).

No OpenAPI route-list snapshot changes (no route is added).
