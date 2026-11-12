# Test plan RL-7: Fixes from the real-CLI smoke test

Spec: `docs/specs/RL-7.md` (Draft, approved in review round 2).

Inputs read: `docs/specs/RL-7.md` (problem, scope, interface contracts, acceptance criteria, open
questions); `docs/analysis/2026-11-12-claude-cli-spike.md` (the `--session-id` note, the stream
`result` event shape); the role file `assets/sdd/.claude/agents/test-planner.md`; the format of
`docs/specs/plans/RL-6-test-plan.md`; the file names under `test/`, `test/helpers/`, `test/e2e-web/`,
`test/fixtures/claude/` and `src/*/*.test.ts`; the header comment and the recorded `call` object of the
fake `claude` (`test/fixtures/claude/fake-claude/claude`); the public methods of the test kits
`test/helpers/world.ts` (`World`: `start`, `stopHub`, `startHubAgain`, `person`, `restart`, `hook`,
`tool`, `session`, `tick` (hub), `flush`, `api`, `call`, `clock`; `Person.requests`, `offline`,
`daemon`, `runsDir`, `agents`; `HeadlessOptions`; `FAKE_CLAUDE`) and `test/helpers/relay-kit.ts`
(`Relay`: `start`, `stop`, `headlessPerson` with `agents`, `goal`, `stepOf`, `events`, `artifactsOf`,
`local`, `pull`, `reconcile`, `runs`, `runOf`, `runDir`, `exitFile`, `script`, `calls`, `go`, `endRun`,
`started`, `runSession`, `liveSleep`, `autoOffer`, `cli`); the existing test patterns of
`test/m2-flow.test.ts` (daemon `tick` after moving the clock, `GET /v1/attention`),
`test/relay-daemon.test.ts` AC-24 (the `maxSessions: 1` queue), `src/claude/headless.test.ts`
(`processRunner` with the fake), `test/pulse-cli.test.ts` AC-19 (`mesh preset ls`),
`src/cli/show.test.ts` (`renderGoal` fixture, the RL-2 skipped mark), the `describe`/`it` names of
`src/core/redact.test.ts`, `src/claude/skill.test.ts` and `test/schemas.test.ts`, the store contract
header of `src/store/hub-store.contract.test.ts` (Postgres leg skip), and the header and user list of
`test/e2e-web/roster.spec.ts` and `test/e2e-web/hub.yaml`.

Not read: `docs/specs/plans/RL-7-impl-plan.md` (the implementation plan); any implementation source
of this row or of the code it changes (`src/core/headless.ts`, `src/core/redact.ts`,
`src/core/presets.ts`, `src/core/roster.ts`, `src/protocol/roster.ts`, `src/claude/headless.ts`,
`src/daemon/*`, `src/store/*`, `src/hub/*`, `src/cli/*`, `web/src/*`), not even to check a name.
Interface names below come from the spec only.

Planned black-box from the contracts. Every negative assertion has a positive control in the same
test or a named sibling, so a test cannot pass because nothing happened. Each criterion names at
least one mutation of the implementation that must turn one of its tests red; the implementer or
reviewer applies it once by hand, confirms red, and reverts.

Rules every test follows:
- No test runs the real `claude` binary. World tests with headless runs use `FAKE_CLAUDE`.
- **"No hook is sent"** (AC-01, AC-02, AC-05, AC-19, AC-20) means the test never calls `w.hook`,
  `w.turn` or `r.runSession` for the run, and the fake sends none (the fake has no hook action).
- Sessions are found by `claudeSessionIds ∋ run.sessionId` or by `sid`, through
  `r.local(p, "GET", "/local/sessions")`, never by position. Steps by id, artifacts by `kind`, hub
  requests by `(method, path, key)` in `p.requests`.
- Tool replies are read as text the way the existing relay-daemon tests read `w.tool` results.
- The stream `result` line a scripted fake prints is the spike §2 shape:
  `{"type":"result","subtype":"success","is_error":false,"num_turns":2,"duration_ms":900,"total_cost_usd":0.001,"usage":{"input_tokens":5,"output_tokens":7,"cache_read_input_tokens":0,"cache_creation_input_tokens":0},"permission_denials":[],"session_id":"$SESSION"}`
  (constant `RESULT_LINE` in the new test file).
- Time comes from `w.clock`, set by the test before every action whose time matters.
- The Postgres leg of the store contract (AC-18) is skipped locally (`MESH_TEST_PG_URL` unset); it is
  named "not run", never a failure. Every other criterion is judged on SQLite.

## Fixture changes (test side only)

| File | Change |
|---|---|
| `test/fixtures/claude/fake-claude/claude` | The calls file gains `probe`: for each of `A`, `B`, `C`, `TMUX`, `TMUX_PANE`, `MESH_AUTOPILOT`, `CLAUDE_PID`, `FAKE_PARENT_VAR`, `MESH_STEP`, `MESH_RUN`: `Object.hasOwn(process.env, n) ? process.env[n] : null`. `null` = absent (JSON keeps it; `undefined` would be dropped, so absent and empty could not be told apart). `env` stays as it is, so older tests keep passing. Header comment updated. |
| `test/helpers/world.ts` | `restart(p, change, opts, whileStopped?: () => Promise<void>)`: awaited between `daemon.stop()` and the new daemon's `start` (AC-19: the fake exits while the daemon is down). Default unchanged. |
| `test/helpers/relay-kit.ts` | `sessionsOf(p, claudeSid)`: the `/local/sessions` entries whose `claudeSessionIds` contains `claudeSid`. `worktreeOf(p, run)`: `join(runDir(p, run), "worktree")`. |
| `test/e2e-web/hub.yaml` | User `grace` (test-only token, comment: "the RL-7 spec only; no other spec asserts on her machines, goals or agents"). |

## Surfaces and files

| Surface | File | New or extended |
|---|---|---|
| World + fake claude: session binding, end, no rebind, env, fail fast, `mesh_done` reply | `test/relay-run-session.test.ts` | new |
| unit, `processRunner.start` `unsetEnv` | `src/claude/headless.test.ts` (`describe("RL-7 unsetEnv")`) | extended |
| unit, `HEADLESS_ENV_UNSET`, `parseAgentFile`, `agentFront` | `src/core/agent-file.test.ts` | new |
| unit, `AgentFront`/`AgentReport` schema | `src/protocol/roster.test.ts` (`describe("RL-7 invalid")`) | extended |
| World + CLI, roster | `test/roster-daemon.test.ts` (`describe("RL-7 AC-08 invalid agents")`), `test/roster-cli.test.ts` (`mesh agents`) | extended |
| store contract (SQLite leg; Postgres leg in CI) | `src/store/hub-store.contract.test.ts` (`describe("RL-7 catalog re-push")`) | extended |
| World, catalog re-push | `test/roster-hub.test.ts` (`describe("RL-7 AC-18")`) | extended |
| unit, redaction | `src/core/redact.test.ts` (`describe("RL-7 AC-11 colon rule")`; RL-1 `test_AC13_short_value` updated) | extended |
| CLI, `mesh preset ls` | `test/pulse-cli.test.ts` (`describe("RL-7 AC-12 mesh preset ls")`) | extended |
| unit (snapshot), progress | `src/cli/show.test.ts` (`describe("RL-7 AC-13 progress")`) | extended |
| unit, presets | `src/core/presets.test.ts` (`describe("RL-7 params")`) | extended |
| World, pulses with params | `test/pulse-hub.test.ts` (`describe("RL-7 AC-15")`) | extended |
| skill / docs | `src/claude/skill.test.ts`, `test/docs-rl7.test.ts` | extended / new |
| Playwright | `test/e2e-web/rl7.spec.ts` (user `grace`) | new |
| CI | `test/schemas.test.ts`, the RL-1 AC-34 version test, `test/boundaries.test.ts` | extended / unchanged |

Shared World setup for `test/relay-run-session.test.ts` (`cast(o)`): `Relay.start(["ann"])`;
`ann = r.headlessPerson("ann", {person: {shareSessions: "me"}, agents: {good: GOOD, bad: BAD}})`
(the default checkout is remote-backed, as in the RL-1 relay tests); optional `maxSessions` via
`r.w.restart`. `headlessStep(k, {id, mode: "headless", agent?, brief}, script)`: a goal with that step,
`r.script(stepId, script)`. `startRun(k, id)`: `r.autoOffer`, `r.pull`, `call = await r.started(id)`,
`run = await r.runOf(ann, id)`. Default script: `[{waitFor: "go-<id>"}, {stdout: [RESULT_LINE]}, {exit: 0}]`.

`GOOD = "---\ndescription: Good agent\n---\nYou review.\n"`.
`BAD = "---\nname: bad\ndescription: Validates: findings\n---\nYou validate.\n"` (line 2 of the front
matter is the bad line).

---

## AC-01 Registration without hooks

File `test/relay-run-session.test.ts`, `describe("AC-01 registration without hooks")`.

**test_AC01_registered_at_start**
- Setup: `cast()`, `headlessStep(k, {id: "reg"})`, `startRun`. No hook.
- Expected: `r.sessionsOf(ann, run.sessionId)` has length 1 (ended included) and that entry has
  `state: "working"`, `kind: "print"`, `pid: call.pid`, `cwd: r.worktreeOf(ann, run)`,
  `repo.name: ann.repo`, `step: <step id>`, and neither `pane` nor `tmuxSocket` (`Object.hasOwn` false,
  or `undefined`). After `r.w.flush()`, `(await r.stepOf(id)).holderSid === session.sid`.
- Order (rule 1): in `ann.requests`, the first `POST /v1/steps/<id>/claim` with key
  `bind:<sid>:<id>` comes before the first `POST /v1/steps/<id>/run`.
- FAILS when: no session, two sessions, any wrong field, a pane set, another `holderSid`, or the
  claim after the first `run` request.
- Positive control: `run.state === "running"` and `call.pid` is a live pid, so the run did start and
  the empty-pane check is on a real session.

**test_AC01_not_stalled_by_tick**
- Stimulus: from the state above, `r.w.clock += stallAfterMs + 1` (the daemon's configured stall
  threshold; the test sets it explicitly with `r.w.restart(ann, …)` if the config has no field), then
  `ann.daemon.tick()`; then `r.w.flush()`.
- Expected: the session is still `working`; `GET /v1/attention` (as ann) has no item with
  `kind === "stalled"` (or the stall kind the m2 tests read) for the step.
- Extension (rule 1, "never presumed ended"): `r.w.clock += 25 * 3_600_000`, `ann.agents = []`,
  `ann.daemon.tick()`, `r.reconcile(ann)` → still `working`, not `ended`, while the run is running.
- FAILS when: the session is `stalled` or `ended` after a tick, or an attention item for the step.
- Positive control (sibling **test_AC01_control_interactive_stalls**): a hook-registered interactive
  session (pid `r.liveSleep()`) that `mesh_claim`s a non-headless step and ends a turn with `Stop`,
  given the same clock move and tick, **is** `stalled`/nudged as in m2-flow. So the clock move is long
  enough and the absence above is the exemption, not a short clock.

Mutations: (1) remove the registration at start → no session; (2) register with `kind: "interactive"`
or with the daemon's `TMUX_PANE` → kind/pane assertion red; (3) drop the run exemption in the tick →
`stalled`; (4) send the bind claim after `POST …/run started` → order red.

## AC-02 Tools work without hooks

**test_AC02_tools_without_hooks**
- Setup: AC-01 state; step brief `"Review module X (RL7-BRIEF)"`.
- Stimulus: `w.tool(ann, call.pid, "mesh_context")`; `w.tool(…, "mesh_artifact", {…})` with the
  argument shape of the RL-1 relay tests (a small `report`); `w.tool(…, "mesh_done", {outcome: "done",
  summary: "ok"})`; then `r.go("go-<id>")`, `r.endRun(ann, id)`.
- Expected: context text contains the step id and `RL7-BRIEF`, contains neither `holds no` nor
  `doesn't know this Claude session`; `r.artifactsOf(G)` has the stored artifact on the step; step
  state `done`; `r.events("step.done", id)` has length 1 and no `step.failed`/fail event; run state
  `finished`; no artifact with `kind: "transcript"` for the step; the last round's
  `telemetry.turnsApprox === false` (telemetry from the `result` line).
- FAILS when: any tool refused, the step failed or closed twice, a transcript stored, or
  `turnsApprox` true.
- Positive control: the `mesh_artifact` artifact is in the same listing that has no transcript (the
  listing works); `telemetry.turns === 2` from `RESULT_LINE` (the telemetry was read).

Mutation: disable both rule 1 and rule 3 (hook-only binding as v0.1.20) → `mesh_context` returns
`doesn't know this Claude session`.

## AC-03 Hooks stay idempotent

**test_AC03_hooks_idempotent_with_step** and **test_AC03_hooks_idempotent_without_step**
- Setup: AC-01 state; record `sid`, `holderSid`.
- Stimulus: `w.hook(ann, "SessionStart", call.pid, {session_id: run.sessionId, cwd: worktree},
  {step: id, tmuxPane: undefined})` (a run has no `TMUX_PANE`, so no pane header); then
  `"UserPromptSubmit"` and `"Stop"` with the same `session_id`/cwd; `r.w.flush()`. The second test
  omits `step`.
- Expected: `r.sessionsOf(ann, run.sessionId)` length 1 with the same `sid`; hub `holderSid`
  unchanged; the `Stop` reply `toStrictEqual({})`; `ann.requests.filter(r => r.key ===
  \`bind:${sid}:${id}\`)` has length exactly 1.
- FAILS when: a second session, a changed `sid` or `holderSid`, a non-empty `Stop` reply, or 0 or 2
  bind claims.
- Positive controls: the count is 1, not 0 (the request log sees the rule-1 claim); a `SessionStart`
  for an unrelated pid (`r.liveSleep()`, own session id, `ann.repoDir`) **does** add one more entry to
  `/local/sessions` (the listing would show a second session if one were created).

Mutations: (1) `SessionStart` creates a session per pid/session id without reusing the run's →
second session; (2) `SessionStart` with `X-Mesh-Step` always sends a bind claim → 2 claims.

## AC-04 Bind on first tool call

**test_AC04a_rebind_after_session_end**
- Stimulus: AC-01 state; `w.hook(ann, "SessionEnd", call.pid, {session_id: run.sessionId, cwd:
  worktree}, {tmuxPane: undefined})`; then `w.tool(ann, call.pid, "mesh_context")`.
- Expected: after the hook the session is `ended` (control: the end took effect); after the tool the
  context text has the step id; the session is live again (state ≠ `ended`) with the **same** `sid`
  and `step === id`; `r.sessionsOf` still length 1.
- FAILS when: a refusal, a new `sid`, two sessions, or the step not held.

**test_AC04b_bind_hook_session_without_step** (fresh `cast()`)
- Stimulus: AC-01 state; `SessionEnd` for the run's session id (no tool call before it); then
  `SessionStart` with `session_id: "other-<uuid>"`, pid `call.pid`, cwd = a fresh `mkdtemp` folder, no
  step header; assert a live session with that session id and **no** step (control for the bind);
  then `w.tool(ann, call.pid, "mesh_context")`.
- Expected: the context text has the step id; the `other-…` session now has `step === id` and its
  `claudeSessionIds` contains `run.sessionId`; after a flush `ann.requests` has one claim with key
  `bind:<other sid>:<id>`.
- FAILS when: a refusal, the step not held by that session, or no / two bind claims for it.

**test_AC04c_controls_unchanged**
- `w.tool(ann, r.liveSleep(), "mesh_context")` → exactly ``mesh doesn't know this Claude session yet
  (are the hooks installed? run `mesh doctor`).``.
- `w.hook(ann, "SessionStart", pid2)` (pid2 = another `liveSleep`, default cwd, no step), then
  `w.tool(ann, pid2, "mesh_done", {outcome: "done"})` → error `this session holds no step`.
- FAILS when: either text changes, or the non-run pid gets bound to the running run's step (run
  started in the same World so a binding bug has a step to grab).

Mutations: (1) rule 3 binds any step-less session regardless of run pid → (c) second case gets the
run's step; (2) revive creates a new session → (a) new `sid`; (3) rule 3 missing → (a)/(b) refused.

## AC-05 Session ends with the run

**test_AC05_session_ends_with_run**
- Setup: `cast({maxSessions: 1})`; step `e1` with script `[{waitFor: "go-e1"}, {exit: 0}]` (no
  `result` line, no hooks); `startRun`. Then a second headless step `e2`, offered and pulled.
- Control before the end: after `r.reconcile(ann)` and 200 ms, `r.calls(e2)` is `[]` and
  `(await r.runOf(ann, e2)).state === "queued"`; the e1 session is `working`.
- Stimulus: `r.go("go-e1")`, `r.endRun(ann, e1)` (exit file + one reconcile).
- Expected: e1's session is `ended`; step e1 `failed` with summary containing
  `headless run ended without mesh_done (exit no_result)`; on the next `r.reconcile(ann)` (at most
  one), `await r.started(e2)` succeeds and e2's run is `running`.
- FAILS when: the session stays live, or e2 never starts.

Mutation: drop rule 4 in the reconcile pass → session stays `working`, `liveCount()` = 1, e2 stays
queued.

## AC-19 Session ends when a run is reaped at restart

**test_AC19_session_ended_on_reap**
- Setup as AC-05 (e1 running, e2 queued, `maxSessions: 1`).
- Stimulus: `r.w.restart(ann, {}, {}, async () => { r.go("go-e1"); await until(() =>
  r.exitFile(ann, run1) !== undefined) })`; then one `r.reconcile(ann)`.
- Expected: e1's session `ended`; e1 `failed` with the AC-05 summary; `r.started(e2)` succeeds.
- FAILS when: the session stays live after the restart, or e2 never starts.
- Positive control: right before the restart the e1 session is `working` (the end comes from the
  reap, not earlier).

Mutation: end sessions only in the live reconcile path, not in the start-up reap → session stays live
→ e2 stays queued.

## AC-20 No rebind after done

**test_AC20_no_rebind_after_done**
- Stimulus: AC-01 state; `w.tool(ann, call.pid, "mesh_done", {outcome: "done", summary: "ok"})`;
  `r.w.flush()`; record the index `d` of `POST /v1/steps/<id>/done` in `ann.requests`; then
  `w.tool(…, "mesh_context")`, `r.w.flush()`, `w.tool(…, "mesh_done", {outcome: "done"})`.
- Expected: step `done`; context text starts with `This session holds no mesh step`; the run's
  session has no `step`; `ann.requests.slice(d + 1)` holds no `POST /v1/steps/<id>/claim`; the second
  `mesh_done` → `this session holds no step`.
- Positive control: `ann.requests.slice(0, d)` holds the rule-1 claim (the log would show a claim).
- FAILS when: the step is bound again, a claim after the done, or another text.

**test_AC20_no_rebind_after_offline_done** (contract: "or it was queued offline")
- As above with `ann.offline = true` before the first `mesh_done` (the reply is the offline text);
  then `mesh_context` → starts `This session holds no mesh step`; after `ann.offline = false` and a
  flush, no claim for the step after the done.

Mutation: drop the "no done accepted" condition in rule 3 → `mesh_context` returns the step context
and a claim follows the done.

## AC-06 Environment

**test_AC06_unit_unset_env** (`src/claude/headless.test.ts`)
- Setup: `process.env.B = "2"`, `process.env.C = "3"` (restored in `afterEach`); `FAKE_CLAUDE_DIR` a
  temp dir; `processRunner.start` with the fake, `env: {A: "1", TMUX: "x", MESH_STEP: "u6"}`,
  `unsetEnv: ["TMUX", "B"]`.
- Expected: calls file `probe`: `A === "1"`, `C === "3"`, `TMUX === null`, `B === null`.
- FAILS when: `TMUX` or `B` present, or `A`/`C` lost.
- Positive controls: `C` (inherited) and `A` (from `spec.env`) arrive; a second start with no
  `unsetEnv` sees `B === "2"` and `TMUX === "x"` (the probe sees variables when they are there).

**test_AC06_world_env_stripped** (`test/relay-run-session.test.ts`)
- Setup: before the run starts, the test process (the daemon's environment) gets
  `TMUX=/tmp/tmux-1/default,1,0`, `TMUX_PANE=%3`, `MESH_AUTOPILOT=chain`, `CLAUDE_PID=4242`,
  `FAKE_PARENT_VAR=kept` (all restored in `afterEach`); `startRun`.
- Expected: probe `TMUX`, `TMUX_PANE`, `MESH_AUTOPILOT`, `CLAUDE_PID` all `null`;
  `FAKE_PARENT_VAR === "kept"`; `MESH_STEP === id`; `MESH_RUN === run.runId`.
- FAILS when: any of the four reaches the fake, or `FAKE_PARENT_VAR`/`MESH_*` is lost.

**test_AC06_constant** (`src/core/agent-file.test.ts`): `HEADLESS_ENV_UNSET` imported from
`src/core/index.ts` `toStrictEqual(["TMUX", "TMUX_PANE", "MESH_AUTOPILOT", "CLAUDE_PID"])`.

Mutations: (1) `HeadlessRuns.start` omits `unsetEnv` → World test red; (2) `processRunner` removes
`unsetEnv` before merging `spec.env` → unit `TMUX === "x"` red; (3) drop a name from the constant →
constant and World tests red.

## AC-07 Front matter parsing

File `src/core/agent-file.test.ts`, `describe("RL-7 AC-07")`.

- **test_AC07_invalid_yaml**: `parseAgentFile(BAD)` → `invalid` starts with
  `front matter is not valid YAML: `, contains `line 2`, does not end with `:`; `name`,
  `description`, `tools`, `model`, `rules` absent (`Object.hasOwn` false or `undefined`); `body ===
  "You validate.\n"`. Same result for the CRLF form of `BAD` (CRLF taken as LF).
- **test_AC07_not_a_mapping**: front matter `- a` → `invalid === "front matter is not a YAML mapping"`;
  a scalar block (`just text`) → the same.
- **test_AC07_valid_and_empty**: `"---\n---\nbody\n"` and `"no block\n"` → no `invalid`; `GOOD` →
  `description: "Good agent"` and no `invalid` (as v0.1.20; the existing roster tests stay green).
- **test_AC07_agent_front**: `agentFront(BAD)` `toStrictEqual({invalid: parseAgentFile(BAD).invalid})`;
  `agentFront(GOOD)` has no `invalid`. `frontMatter(BAD)` `toStrictEqual({})` (unchanged).
- **test_AC07_schema_limit** (`src/protocol/roster.test.ts`): an `AgentReport` row with `invalid` of
  300 characters parses; 301 is rejected. Positive control: the same row without `invalid` parses.
- FAILS when: any field present or absent the other way, another text, or the 301 row accepted.

Mutations: (1) keep the v0.1.20 `catch → {}` → `invalid` absent; (2) treat `null` (empty block) as
not a mapping → empty-block case red; (3) report the parser's line count from the file's line 1
(`line 3`) → `line 2` red; (4) drop `.max(300)` → 301 accepted.

## AC-08 Roster

`test/roster-daemon.test.ts`, `describe("RL-7 AC-08 invalid agents")`, and `test/roster-cli.test.ts`.

**test_AC08_report_and_groups**
- Setup: a runner (share `me`) with remote-backed repo `alpha`, committed `.claude/agents/bad.md` =
  `BAD` and `good.md` = `GOOD`; daemon scan and sync (`r.w.flush()`).
- Expected: the machine report (the sync body's agent rows, `w.syncBodies(p)`) has `bad` with
  `invalid` = `parseAgentFile(BAD).invalid` and `hash` = sha256 of the LF text; `GET /v1/agents`:
  group `bad` `invalid: true`, its version has that `invalid`; group `good` `invalid: false`, no
  version with `invalid`.
- FAILS when: `bad` not reported, the flag missing, or set on `good`.
- Positive control: `good` is present with its description (the listing has both groups).

**test_AC08_catalog_resolve**: a catalog source (roster-kit `sourceOk` / `pushOk`) whose push holds
`bad.md` = `BAD` and `good.md` = `GOOD` → `GET /v1/agents/resolve?key=<source>/bad` has `invalid`;
`…/good` has none (control).

**test_AC08_cli_agents** (`roster-cli`): `mesh agents` output: the group line of `bad` ends with
`  invalid` (no other flag applies in this fixture); a line equal to
`  ${hash.slice(0, 12)}  invalid: ${invalid}`; the `good` group line and its version line contain no
`invalid` and the version line has `Good agent` (control).

Mutations: (1) `scanAgents` skips files with `invalid` → not reported; (2) `AgentGroup.invalid`
computed from the first version only, or always false → flag red; (3) version line prints the
description → CLI red.

## AC-09 Web Roster

`test/e2e-web/rl7.spec.ts` (Playwright, user `grace`, repo `git.example.com/e2e/rl7-roster`, agents
`rl7-bad` and `rl7-good`; no other spec uses them).

**test_AC09_web_roster_invalid**
- Setup: `cliLogin` as grace, `POST /v1/sync` with a machine report holding `rl7-bad` (with
  `invalid: "front matter is not valid YAML: RL7 sample at line 2, column 14"`) and `rl7-good`
  (description `Good agent`), as `roster.spec.ts` seeds; sign in; open `#/roster`.
- Expected: the `rl7-bad` group (`data-name`) has a `.roster-flag` with exact text `invalid`, and
  `.roster-invalid` with exact text `invalid: <that invalid>`; the `rl7-good` group has no
  `.roster-flag` with text `invalid` and zero `.roster-invalid`.
- Positive control: the `rl7-good` group shows `Good agent` (rendered, so absence is meaningful).
- FAILS when: a flag or text missing on `rl7-bad`, or present on `rl7-good`.

Mutation: render the description for invalid versions → `.roster-invalid` missing.

## AC-10 Fail fast

`test/relay-run-session.test.ts`, `describe("AC-10 fail fast")`.

**test_AC10_repo_agent_invalid**
- Setup: `cast()`; step `ff1` with `agent: "bad"`; `r.autoOffer`, `r.pull`, `r.reconcile`; `until`
  step state is `failed` (5 s).
- Expected: `r.calls(ff1)` is `[]` after a further reconcile and 200 ms; summary exactly
  `headless run of ${ff1} did not start: agent bad has invalid front matter: ${inv}` where
  `inv = parseAgentFile(BAD).invalid` (also checked to start with `front matter is not valid YAML: `,
  so the oracle is not just the function under test); the run file is `finished`; no `agents.json`
  in the run dir; the run's `worktree` folder does not exist.
- FAILS when: the fake starts, the run uses default settings, or another summary.

**test_AC10_roster_agent_invalid**: a catalog source pushes `BAD` as `bad`; step `ff2` with the roster
agent key `<source>/bad` (pinned as in the RL-5 roster tests) → summary exactly `headless run of
${ff2} did not start: roster agent <pinned key> has invalid front matter: ${inv}`; `r.calls(ff2)`
`[]`; no `agents.json`.

**test_AC10_control_good_starts**: step `ff3` with `agent: "good"` → `r.started(ff3)` succeeds and the
fake's argv holds `--agents` and `--agent good`.

Mutation: skip the `invalid` check at start → the fake starts with an `agents.json` built from `{}`.

## AC-11 `redactSecrets`

`src/core/redact.test.ts`, `describe("RL-7 AC-11 colon rule")`.

**test_AC11_examples**: table-driven over every row of the spec's examples table (13 rows; the
`ghp_` row builds a 36-character `ghp_` token in the test, the same way the RL-1 token tests do):
exact output text and exact count.

**test_AC11_boundaries** (derived from the rule, positive and negative pairs):
`token: abcdefghijklmnopqrs` (19 letters) unchanged/0 vs `token: abcdefghijklmnopqrst` (20) →
`token: [REDACTED]`/1; `secret: abcde1` (6 incl. a digit) → redacted/1; `password: hunter2),` →
`password: [REDACTED]),`/1; `token: http://a.b/c1` unchanged/0 vs `token: http-a.b/c1` redacted/1.

**test_AC11_prose**: `### 1. secret: hardcoded API token` and `Token: see below` unchanged, count 0,
in a multi-line text that also holds `api_key=abcdef123` (control: that line **is** redacted, count 1).

**test_AC11_rl1_cases**: the existing RL-1 AC-13 tests (PEM, tokens, literals, order and count,
assignment of a literal, marks, identity) run unchanged; `test_AC13_short_value` is updated to
`token: abcdef` → unchanged, count 0 (Compatibility section).

FAILS when: any example's text or count differs, or prose is redacted.

Mutations: (1) drop the "digit or ≥ 20" condition → `password: correcthorse` redacted; (2) drop the
`://` exclusion → URL row red; (3) don't strip trailing punctuation → `password: R` (dot eaten) red;
(4) restrict the value character set to letters/digits → `P@ssw0rd1` row red.

## AC-12 `mesh preset ls`

`test/pulse-cli.test.ts`, `describe("RL-7 AC-12 mesh preset ls")`. Each test runs the CLI with
`r.cli(p, ["preset", "ls"], {cwd})` in a temp folder `t` with `git init` and a subdirectory `sub/`.
Expected built-in lines are computed from `BUILTIN_PRESETS` (`name.padEnd(14) + " " + description`).

**test_AC12_repo_templates**
- Setup: `t/.mesh/presets/hotfix.yaml` (a valid preset, `description: Quick fix`),
  `t/.mesh/presets/sdd-split.yaml` (valid, description `Split RL7`), `t/.mesh/presets/broken.yaml`
  (`steps: [`); cwd `t/sub`.
- Expected: exit 0; output lines = the built-in lines in order, then exactly:
  `broken         invalid: <first line of parsePreset's error for broken.yaml>  [../.mesh/presets/broken.yaml]`,
  `hotfix         Quick fix  [../.mesh/presets/hotfix.yaml]`,
  `sdd-split      Split RL7  [../.mesh/presets/sdd-split.yaml]  (replaces the built-in)`;
  the hint line `Repo templates: .mesh/presets/<name>.yaml …` is absent.
- FAILS when: a template missing, unsorted, a wrong path or suffix, the hint shown, non-zero exit.

**test_AC12_nearer_wins**: add `t/sub/.mesh/presets/hotfix.yaml` (description `Near fix`) → one
`hotfix` line, `hotfix         Near fix  [.mesh/presets/hotfix.yaml]`; the root one is not listed.

**test_AC12_stops_at_git_root**: a `.mesh/presets/outer.yaml` in the parent of `t` (outside the git
root) is not listed (control: it is listed when `t` has no `.git`, by the "walk to the root" rule —
run in a temp tree whose ancestors hold no `.git`, so this leg is skipped with a note if `$TMPDIR` lies
inside a git checkout).

**test_AC12_no_templates**: in a git folder without `.mesh/presets` → output exactly the built-in
lines plus the v0.1.20 hint line `Repo templates: .mesh/presets/<name>.yaml (a description and steps,
repo "{repo}").`, exit 0. The existing AC-19/RL-6 AC-03 tests stay green.

Mutations: (1) no walk (cwd only) → `sub/` sees nothing; (2) sort by file path → order unchanged
here, so also (2') list in readdir order with a file created out of order (`sdd-split` written first) →
order red; (3) path relative to the git root → `[.mesh/presets/…]` red.

## AC-13 Progress

**test_AC13_render_counts** (`src/cli/show.test.ts`): from the existing `detail` fixture, a `done`
goal with steps `done`, `skipped`, `skipped`, `dropped` → its header line contains
`done · owner @<owner> · 3/3 steps done`; a goal with `done`, `ready`, `skipped` → `2/3 steps done`.
The existing `renderGoal(detail)` snapshot passes without `-u`.
FAILS when: skipped not counted (`1/3`), dropped counted (`3/4`), or another text.
Positive control: the RL-2 skipped mark `↷` still shows for skipped steps (the fixture has them).

**test_AC13_web_goal_header** (`test/e2e-web/rl7.spec.ts`): grace creates a goal with steps closed
`done`, `skipped`, `skipped` and one dropped (through the hub API the existing `goals.spec.ts` uses
for those states) → the goal page header shows `3/3 steps done`.

Mutation: count only `done` → `1/3`.

## AC-14 `mesh_done` reply

`test/relay-run-session.test.ts`, `describe("AC-14 mesh_done reply")`.

**test_AC14_headless_online**: AC-01 state (worktree of the remote-backed checkout);
`w.tool(ann, call.pid, "mesh_done", {outcome: "done", summary: "ok"})` → reply contains
`mesh wrote the step record`; does not match `/git add/` nor `/commit/i`. Control: the file path(s)
named in the reply exist under the worktree (the trail is still written).

**test_AC14_headless_offline**: hub stopped (`r.w.stopHub()`, restarted in `finally`) before the
`mesh_done` → reply starts with `The hub is offline: mesh recorded ${id} as done locally and wrote
the step record ` and ends with `. The hub gets it when it is back (facts from other people's
sessions are added then).`; no `/commit/i`.

**test_AC14_interactive_control**: a hook-registered session in `ann.repoDir` claims an ordinary step
(`mesh_claim`) and calls `mesh_done` → reply contains `Commit it with your work: git add`.

FAILS when: a commit hint in a headless reply, or the hint lost for interactive sessions.

Mutation: the headless predicate always false → online test red; always true → control red.

Note: the `policy.mode: "headless"` branch of the predicate for a session that is not a run's
session is not driven by any AC; not planned (see the end).

## AC-15 Preset params

Unit, `src/core/presets.test.ts`, `describe("RL-7 params")`:
- **test_AC15_defaults**: `instantiate(audit-relay, {repo, params: {agent: "a", validator: "v",
  filer: "f"}})` → the `audit` step policy `budget` `toStrictEqual({turns: 80, minutes: 60})`
  (numbers; `typeof` checked).
- **test_AC15_explicit**: with `turns: "40", minutes: "20"` → `{turns: 40, minutes: 20}`.
- **test_AC15_bad_values**: `turns: "abc"`, `"0"`, `"501"` and `minutes: "1441"` → thrown text exactly
  `preset audit-relay: budget.<turns|minutes> in step audit must be a whole number from 1 to <500|1440>, got "<value>"`.
  Controls: `turns: "500"`, `minutes: "1440"`, `turns: "1"` succeed.
- **test_AC15_unknown_placeholder**: a repo preset `p1` with step `s` `budget: {turns: "{t}"}` and no
  `t` → `preset p1: unknown parameter {t} in step s`. Control: with `params: {t: 7}` → `turns: 7`.
- **test_AC15_parse_params**: `parsePreset` reads `params: {t: 5}` as `{t: "5"}`; `params: {T: 1}` and
  `params: [1]` throw exactly `params must map names (a-z, 0-9, _) to values` (no prefix).
- **test_AC15_round_trip**: for every `BUILTIN_PRESETS` entry `parsePreset(p.name, presetText(p))`
  `toStrictEqual(p)`; `presetText(audit-relay)` contains `params:`, between `description` and `steps`;
  a built-in without params has no `params:` line (control).

World, `test/pulse-hub.test.ts`, `describe("RL-7 AC-15")`:
- **test_AC15_hub_prefix_once**: `POST /v1/pulses` with a preset text holding `params: {T: 1}` → 422
  whose problem is exactly `preset <name>: params must map names (a-z, 0-9, _) to values` (one prefix).
- **test_AC15_hub_bad_turns**: `POST /v1/pulses` of `audit-relay` with params `agent, validator,
  filer, turns=abc` → 422 `the preset has 1 problem(s): preset audit-relay: budget.turns in step audit
  must be a whole number from 1 to 500, got "abc"`.
- **test_AC15_fire_budget**: with `turns=40,minutes=20` → 201; `pulse fire` (pulse-kit `fireOk`) → the
  goal's `audit` step policy `budget` `toStrictEqual({turns: 40, minutes: 20})`. Control: a pulse
  without them fires with `{turns: 80, minutes: 60}`.

FAILS when: another default, a string budget in the plan, another text, or a broken round trip.

Mutations: (1) `instantiate` uses `{...opts.params, ...p.params}` → explicit `40` loses; (2) keep the
filled value a string → `typeof` red; (3) the hub adds the prefix twice → prefix-once red; (4)
`presetText` omits `params` → round trip red.

## AC-16 Docs

**test_AC16_skill_headless_record** (`src/claude/skill.test.ts`): `MESH_SKILL` equals
`skills/mesh/SKILL.md` (existing check); the section from the line with `Headless runs` to the next
heading contains `step record` and matches `/not (be )?committed|never commit/i` and `/discarded/i`.
Control: the same regex finds nothing in a section that does not mention it (the regex is not vacuous).

**test_AC16_docs_mentions** (`test/docs-rl7.test.ts`): `docs/guide/concepts.md` contains
`--session-id`, `TMUX_PANE`, `MESH_AUTOPILOT`, `CLAUDE_PID`, `did not start`, `invalid`, `params`,
`{turns}`; `docs/guide/howto.md` contains `turns=` and a `mesh preset ls` sample line with `[`…`.yaml]`;
`docs/plan/implementation-plan.md` contains ``(v0.1.21: versions carry `invalid` when the front matter
is not valid YAML)``; `docs/specs/RL-1.md` contains `(changed in RL-7)` and `token-like`.

**Review step** (not automated): the reviewer reads the diff (`git diff main...HEAD -- src docs web
skills test`) for the Docs table items and for any team-, company- or person-specific name. The list of
names to look for is not written into the repo (that would add them).

FAILS when: a missing mention, a skill mismatch, or a specific name.

Mutation: revert the skill text → skill test red.

## AC-18 Catalog re-push refreshes front matter

**test_AC18_store_repush** (`src/store/hub-store.contract.test.ts`, `describe("RL-7 catalog
re-push")`, both legs): `putCatalogDefs` stores `(repo, name, hash)` with `front: {}` and commit `C1`
(argument shape as the RL-5 contract tests); `listCatalogDefs` shows `front: {}` and `[C1]`
(control); `putCatalogDefs` again with the same key, commit `C2`, `front: {invalid: "front matter is
not valid YAML: x"}` → `listCatalogDefs` has that `invalid` and both `C1` and `C2`.
SQLite leg runs here; **Postgres leg not run** (`MESH_TEST_PG_URL` unset; CI runs it).

**test_AC18_world_repush** (`test/roster-hub.test.ts`): seed the hub store directly (`w.hubStore`)
with the `bad` definition of the source at `front: {}` (as v0.1.20 stored it); control: resolve shows
no `invalid`; the catalog source then pushes the same `BAD` text (same hash) → `GET
/v1/agents/resolve?key=<source>/bad` returns `invalid`. Also the spec's plain form: push `BAD` twice →
`invalid` after the second push.

FAILS when: `invalid` missing after the re-push, or a commit lost.

Mutation: `putCatalogDefs` on a known key updates only `path`/`commits`/`pushedAt` → both tests red.

## AC-17 CI

- `package.json` version `0.1.21`: the RL-1 AC-34 version test (the only one that pins it) updated.
- `test/schemas.test.ts`: `schemas/hub-api.openapi.json` equals the generated document; plus
  **test_AC17_agent_report_invalid**: the agent report schema in that document has property `invalid`
  of type string with `maxLength: 300`.
- `test/boundaries.test.ts` / `pnpm boundaries`: `src/daemon` imports no `child_process` (unchanged).
- `pnpm check` (lint, typecheck, boundaries, test, build), then `pnpm build` + `pnpm test:web`.

FAILS when: any check fails or the document differs. Mutation: forget `pnpm schemas` → schemas test
red.

## Coverage

| AC | Tests |
|---|---|
| AC-01 | test_AC01_registered_at_start, test_AC01_not_stalled_by_tick, test_AC01_control_interactive_stalls |
| AC-02 | test_AC02_tools_without_hooks |
| AC-03 | test_AC03_hooks_idempotent_with_step, test_AC03_hooks_idempotent_without_step |
| AC-04 | test_AC04a_rebind_after_session_end, test_AC04b_bind_hook_session_without_step, test_AC04c_controls_unchanged |
| AC-05 | test_AC05_session_ends_with_run |
| AC-06 | test_AC06_unit_unset_env, test_AC06_world_env_stripped, test_AC06_constant |
| AC-07 | test_AC07_invalid_yaml, test_AC07_not_a_mapping, test_AC07_valid_and_empty, test_AC07_agent_front, test_AC07_schema_limit |
| AC-08 | test_AC08_report_and_groups, test_AC08_catalog_resolve, test_AC08_cli_agents |
| AC-09 | test_AC09_web_roster_invalid |
| AC-10 | test_AC10_repo_agent_invalid, test_AC10_roster_agent_invalid, test_AC10_control_good_starts |
| AC-11 | test_AC11_examples, test_AC11_boundaries, test_AC11_prose, test_AC11_rl1_cases |
| AC-12 | test_AC12_repo_templates, test_AC12_nearer_wins, test_AC12_stops_at_git_root, test_AC12_no_templates |
| AC-13 | test_AC13_render_counts, test_AC13_web_goal_header |
| AC-14 | test_AC14_headless_online, test_AC14_headless_offline, test_AC14_interactive_control |
| AC-15 | test_AC15_defaults, test_AC15_explicit, test_AC15_bad_values, test_AC15_unknown_placeholder, test_AC15_parse_params, test_AC15_round_trip, test_AC15_hub_prefix_once, test_AC15_hub_bad_turns, test_AC15_fire_budget |
| AC-16 | test_AC16_skill_headless_record, test_AC16_docs_mentions, review step |
| AC-17 | version test, schemas tests incl. test_AC17_agent_report_invalid, boundaries, `pnpm check`, `pnpm test:web` |
| AC-18 | test_AC18_store_repush (SQLite run; Postgres not run here), test_AC18_world_repush |
| AC-19 | test_AC19_session_ended_on_reap |
| AC-20 | test_AC20_no_rebind_after_done, test_AC20_no_rebind_after_offline_done |

## Not planned (contract parts no AC drives)

- The 300-character cut of a long parser message (spec Open questions: no natural input); the
  schema limit is tested (AC-07).
- The `policy.mode: "headless"` branch of the `mesh_done` predicate for a session that is not a
  run's session (AC-14 tests the run-session branch and the offline text).
- Tool-call binding from a forking (non-`exec`) wrapper pid (Out of scope; Open questions).
