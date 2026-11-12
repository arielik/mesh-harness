# Test plan RL-8: Run start race and never-started runs

Spec: `docs/specs/RL-8.md` (Draft, approved in review round 3).

Inputs read: `docs/specs/RL-8.md` (problem, scope, interface contracts, acceptance criteria, open
questions); the section list of `docs/analysis/2026-11-12-pulse-relay-roster.md` and of
`docs/analysis/2026-11-12-claude-cli-spike.md` (the `claude agents --json` entry shape); the role file
`assets/sdd/.claude/agents/test-planner.md`; the format of `docs/specs/plans/RL-7-test-plan.md`; the file
names under `test/`, `test/helpers/` and `src/core/*.test.ts`; the header comment and the recorded
`call` object of the fake `claude` (`test/fixtures/claude/fake-claude/claude`); the public members of
the test kits `test/helpers/world.ts` (`Person.store`, `agents`, `requests`, `logs`, `runsDir`,
`headless`, `failOnce`; `World.restart(p, change, opts, whileStopped)`; `HeadlessOptions.runner`) and
`test/helpers/relay-kit.ts` (`Relay`: `headlessPerson`, `goal`, `stepOf`, `artifactsOf`, `local`,
`pull`, `reconcile`, `runs`, `runOf`, `runDir`, `exitFile`, `script`, `calls`, `go`, `endRun`,
`started`, `sessionsOf`, `worktreeOf`, `runSession`, `liveSleep`, `autoOffer`, `cli`, `until`,
`sleep`); the existing tests that end runs as not started (`test/relay-daemon.test.ts`
`test_AC22_missing_agent`, `test_AC24_*`, `test_AC37_started_once`; `test/relay-run-session.test.ts`
AC-10 and AC-19; `test/roster-daemon.test.ts` AC-21 and `test_AC10_roster_agent_invalid`), the
`RL-7 invalid agents (hub)` and `AC-25 R-6 for pulses` blocks of `test/roster-hub.test.ts`, the
`describe` names of `test/pulse-hub.test.ts`, `test/pulse-cli.test.ts` and
`src/core/session-state.test.ts`, `test/docs-rl7.test.ts`, and the version line of
`test/schemas.test.ts`.

Not read: `docs/specs/plans/RL-8-impl-plan.md` (the implementation plan); any implementation source
of this row or of the code it changes (`src/daemon/runs.ts`, `src/daemon/daemon.ts`,
`src/core/session-state.ts`, `src/hub/service.ts`, `src/protocol/pulse.ts`,
`src/cli/pulse-commands.ts`, `src/protocol/skill.ts`, `src/claude/headless.ts`, `src/store/*`), not
even to check a name. Interface names below come from the spec only; where a test needs a type the
spec does not spell out (the `HeadlessRunner` method signatures, `AgentEntry`), the test-writer takes
it from the exported type, not from this plan.

Planned black-box from the contracts. Every negative assertion has a positive control in the same test
or a named sibling, so a test cannot pass because nothing happened. Each criterion names at least one
mutation of the implementation that must turn one of its tests red; the implementer or reviewer applies
it once by hand, confirms red, and reverts.

Rules every test follows:
- No test runs the real `claude` binary. World tests with headless runs use `FAKE_CLAUDE`.
- Runs are found by `step` (`r.runOf(p, step)`, `r.runs(p).find(x => x.step === step)`), never by
  `runId` or position. Sessions by `claudeSessionIds ∋ run.sessionId` (`r.sessionsOf`) or by `sid`.
  Artifacts by `kind`. Hub requests by `(method, path, key)` in `p.requests`.
- A "negative after the fact" (no transcript, no session, no bind claim, no second start) is asserted
  only after the run file is `finished`, one more `r.reconcile(p)`, `r.w.flush()` and a 200 ms settle,
  so a late call has had time to happen.
- The holding runner (below) never hangs a test: only the **first** `worktree add` is held; every later
  call passes through at once and is recorded. Every test that holds releases in a `finally`.
- The test waits until the held call is recorded (`until(() => h.adds().length === 1)`) before it calls
  `reconcile()`, pulls again or sends more offers.
- The Postgres legs of the store contract are not touched by this row; they are skipped locally
  (`MESH_TEST_PG_URL` unset) and named "not run", never a failure.

## Fixture changes (test side only)

| File | Change |
|---|---|
| `test/helpers/relay-kit.ts` | `holdingRunner(o?: {answerAdd?: RunResult[]; answerPush?: RunResult; answerRemove?: RunResult; hold?: boolean})` → `{runner, gits, starts, adds(), pushes(), release()}`. Wraps `processRunner` (from `src/claude`): `git(cwd, args)` records `{cwd, args, at}` in `gits`; when `args` start with `["worktree","add"]`: if `answerAdd` has an entry, shift it and return it (never runs git); else if `hold` (default true) and it is the first `worktree add`, await `release()` before calling through; later ones pass through. `["push", …]` with `answerPush` → that result. `["worktree","remove", …]` with `answerRemove` → that result. `start(…)` records its arguments in `starts` and calls through. `adds()` = the recorded `worktree add` calls; `addsFor(p, run)` = those whose args contain `r.worktreeOf(p, run)`. |
| `test/helpers/relay-kit.ts` | `logCount(p, re)`: the number of `p.logs` lines matching `re`. `noBindClaim(p, step)`: `p.requests` has no entry whose `key` matches `/bind:[^:]+:<step>$/` (any prefix such as `claim `). |
| `test/fixtures/claude/fake-claude/claude` | The calls file gains `cwdOk`: `true` when `process.cwd()` does not throw and `existsSync(process.cwd())`, else `false` (recorded before any action). Header comment updated. Older tests keep passing. |
| `test/schemas.test.ts` | The release line becomes `0.1.22` (comment `RL-8 AC-12`). |

Existing tests that end a run as not started (`test_AC22_missing_agent`, RL-5 AC-21 in
`test/roster-daemon.test.ts`, RL-7 `test_AC10_repo_agent_invalid` and `test_AC10_roster_agent_invalid`)
were checked: none asserts a transcript, so none needs a change for "no transcript". If the
test-writer finds one that does, it changes it to "no transcript, same summary" (spec Compatibility).

## Surfaces and files

| Surface | File | New or extended |
|---|---|---|
| World + fake claude + holding runner: start race, capacity, git error text, never-started runs, started transcript, sweep, kind in World | `test/relay-start-race.test.ts` | new |
| unit, `applyObservation` kind rule | `src/core/session-state.test.ts` (`describe("RL-8 AC-07 print kind")`) | extended |
| World (hub API), pulse warnings | `test/roster-hub.test.ts` (`describe("RL-8 AC-08 pulse warnings, repo agent")`, `describe("RL-8 AC-09 pulse warnings, roster key")`) | extended |
| CLI, `mesh pulse add`/`update` | `test/pulse-cli.test.ts` (`describe("RL-8 AC-10 pulse warnings")`) | extended |
| docs / skill | `test/docs-rl8.test.ts`, `src/claude/skill.test.ts` (unchanged: `MESH_SKILL` = `skills/mesh/SKILL.md`) | new / unchanged |
| CI | `test/schemas.test.ts` (version, OpenAPI unchanged), `test/boundaries.test.ts` (unchanged) | extended / unchanged |

Shared setup in `test/relay-start-race.test.ts` (`cast(o)`): `Relay.start(["ann"])`; `ann` =
`r.headlessPerson("ann", {nick: "hl", person: {shareSessions: "me"}, headless: {runner: h.runner},
agents: {good: GOOD, bad: BAD}})` with `h = r.holdingRunner(o.hold)` (remote-backed repo as in RL-7);
`o.maxSessions` → `r.w.restart(ann, {maxSessions})`; `self = r.otherLogin("ann")`; `ann.agents = null`
unless the test sets it. `headlessStep(k, step, script)` makes a goal with one `mode: "headless"` step,
scripts the fake and returns the step id. `DONE_SCRIPT(id)` = the fake waits for nothing, calls
`mesh_done {outcome: "done", summary: "ok"}` through the World's `w.tool` (driven by the test once
`r.started(id)` returned, as RL-7 tests do), then prints the spike's `result` line and exits 0.
`BAD`/`GOOD` = the RL-7 agent texts (line 2 of `BAD` is not valid YAML).

---

## AC-01 Start race

`describe("RL-8 AC-01 start race")`, file `test/relay-start-race.test.ts`.

### test_AC01_one_start_while_reconcile_runs
- Setup: `cast()` (holding on). Headless step `race` with `DONE_SCRIPT`, waiting on `go-race` before it
  exits.
- Stimulus: `r.autoOffer(ann, id, self)`; `r.pull(ann)`; wait until `h.adds().length === 1`; while held:
  `await r.reconcile(ann)` twice (each to completion); assert (in-window control) the run is `queued`
  in `GET /local/runs` (found by step), `r.calls(id)` is `[]` and `logCount(ann, /started/)` is 0 —
  this proves the window was real. Then `h.release()`; `r.started(id)`; `mesh_done` via `w.tool`;
  `r.go("go-race")`; `r.endRun(ann, id)`.
- Expected: `h.addsFor(ann, run)` has exactly 1 entry; `h.starts` exactly 1; `r.calls(id)` exactly 1
  and its `cwdOk === true` and `cwd === r.worktreeOf(ann, run)`; `logCount(ann, new
  RegExp(\`run ${run.runId}: started ${id} \\(pid \\d+\\)\`))` === 1; `logCount(ann, /did not start/)` ===
  0; `(await r.stepOf(id)).state === "done"`; run file `finished` with `exit: "success"`
  (as `GET /local/runs` shows it); no artifact of kind `transcript` for the step.
- Positive controls: the started line count is 1 (not 0); the step is `done` (the run really ran);
  the run's session exists (`r.sessionsOf(ann, run.sessionId)` has one entry, `kind: "print"`) and
  `p.requests` holds a `bind:<sid>:<id>` claim — the siblings for AC-04's "no session/no bind".
- FAIL state: a second `worktree add` or `start` call for the run, a `did not start` line, the step
  `failed`, `cwdOk: false` / no calls file (the fake started in a removed folder), or a transcript.
- Mutation: remove the "start in progress" guard so the queue pass picks the still-`queued` run → a
  second `worktree add` (passes through) → red on the add count and on `did not start`. Second
  mutation: set the guard only after `await git(worktree add)` → red the same way.

### test_AC01_pull_again_while_held
- Setup/stimulus: as above, but while held call `r.pull(ann)` again (the offer may be delivered again)
  and one `reconcile()`; then release and finish.
- Expected: exactly one `worktree add` and one `start` for the run; one `started` line.
- Control: the in-window checks above. FAIL: a second add/start. Mutation: drop the "run already
  exists → start nothing" branch of `handleOffer` (contract 3) → red.

### test_AC01_finished_never_running_again
- After `test_AC01_one_start_while_reconcile_runs`'s end state (own setup), run `reconcile()` twice and
  `r.pull(ann)`.
- Expected: the run file stays `finished` (same `endedAt`), still exactly one `started` line, one calls
  file. Control: before the extra passes the file is `finished` (asserted first). FAIL: state back to
  `running`, a new pid/calls file. Mutation: let the queue pass treat a `finished` run like `queued` →
  red.

## AC-02 Capacity during a start

`describe("RL-8 AC-02 capacity")`.

### test_AC02_two_offers_one_slot
- Setup: `cast({maxSessions: 1})`; no other session (`ann.agents = null`, no hooks). Two goals, each one
  headless step (`c1`, `c2`), each scripted `[{waitFor: "go-<id>"}, result line, {exit: 0}]`.
- Stimulus: `r.autoOffer` for both, **then one** `r.pull(ann)` (both offers in one pull). Wait until
  `h.adds().length === 1`. Name the held run `A` = the run whose worktree path is in that add; `B` = the
  other step's run.
- Expected before release: `h.adds().length === 1` after a 200 ms settle; `B` is `queued` in `GET
  /local/runs`; `await r.reconcile(ann)` → still 1 add, `h.starts.length === 0`.
- Stimulus 2: `h.release()`; `r.started(A.step)`; `r.reconcile(ann)` → `B` still `queued`, 1 start.
- Stimulus 3: `r.go("go-"+A.step)`; `r.endRun(ann, A.step)`; `r.reconcile(ann)` (more passes as
  needed, `until`) → `r.started(B.step)`.
- Invariant, sampled after every stimulus and every reconcile: the number of runs in `GET /local/runs`
  with `state: "running"` and no `endedAt` is ≤ 1; and the fake of `B` started after `A`'s exit file
  existed.
- Positive control: sibling `test_AC02_control_two_slots` — same setup with `maxSessions: 2`: before
  release `h.adds().length === 2` (the second add passes through) and both runs end up running. Shows
  the test can see a second start when capacity allows it.
- FAIL state: two `worktree add` calls (or two starts) while `A`'s start is held, two runs running at
  once, or `B` never starts.
- Mutation: do not count runs whose start is in progress in the live count → two adds before release →
  red. Second mutation: reserve the slot after an `await` (e.g. after reading the checkout) → the two
  offers of one pull both pass the check → red.

### test_AC02_offer_in_later_pull_while_held
- `maxSessions: 1`; first offer pulled and held; then the second offer pulled in a separate pull, then
  `reconcile()`. Expected: 1 add, second run `queued`; after release and the first run's end, the second
  starts. FAIL/mutation as above.

## AC-03 Git error text

`describe("RL-8 AC-03 git error text")`.

### test_AC03_last_nonblank_line
- `cast({hold: {answerAdd: [{code: 128, stdout: "", stderr: "Preparing worktree (detached HEAD
  1a2b3c4)\nfatal: 'x' already exists\n"}]}})`; headless step; auto-offer, pull, reconcile.
- Expected: step `failed`, last round `summary === \`headless run of ${id} did not start: could not make
  a worktree: fatal: 'x' already exists\``; `r.calls(id)` `[]`.
- FAIL: `… Preparing worktree (detached HEAD 1a2b3c4)`, an empty reason, any other text.
- Mutation: take `stderr.split("\n")[0]` (today's code) → red.

### test_AC03_blank_stderr_exit_code
- `answerAdd` `{code: 128, stdout: "", stderr: "\n  \n"}` → summary `headless run of <id> did not
  start: could not make a worktree: git exited with code 128`. FAIL: `… worktree: ` (empty) or
  whitespace. Mutation: return the last line without the blank filter → red.

### test_AC03_crlf_and_trailing_blank
- `answerAdd` `{code: 128, stderr: "Preparing worktree\r\nfatal: y\r\n\r\n  \r\n"}` → reason
  `could not make a worktree: fatal: y`. Mutation: keep the `\r` → red (exact match).

### test_AC03_push_failure_note
- A `propose-via-branch` step (policy as in `test/relay-daemon.test.ts` line 158 pattern), fake script
  `[{commit: true}, result line, {exit: 0}]` after a `mesh_done`; holding runner with `hold: false` and
  `answerPush: {code: 1, stdout: "", stderr: "remote: x\nerror: failed to push some refs\n"}`.
- Expected: the step's note `headless run: could not push mesh/<slug>: error: failed to push some
  refs`, where `<slug>` is read from the push call's args recorded by the runner (the
  `mesh/<slug>` ref) — the test matches `/^headless run: could not push (mesh\/\S+): error: failed to
  push some refs$/` and checks group 1 appears in `h.pushes()[0].args`.
- Positive control: `h.pushes().length === 1` (the push happened). FAIL: `… remote: x`, other text,
  no note. Mutation: first-line rule on the push path → red.

### test_AC03_remove_failure_log
- A run that starts and ends (`DONE_SCRIPT`), `hold: false`, `answerRemove: {code: 128, stderr:
  "warning: x\nfatal: busy\n"}` → `p.logs` holds `run <runId>: could not remove its worktree: fatal:
  busy`. Control: one `worktree remove` call recorded. Mutation: first-line rule → red.

## AC-04 Never-started run: no transcript, no session

`describe("RL-8 AC-04 never-started run")`. Helper `neverStarted(k, id, summary)` asserts, after the
settle rule:
1. step `failed`; last round `{outcome: "fail", summary}`; last round's `telemetry.exit === "crashed"`;
   last round's `artifactIds` is absent or `[]`;
2. `r.artifactsOf(G)` has no `kind: "transcript"` with `step === id` (control: the call returns 200 and
   is an array);
3. `p.requests` has no `POST /v1/steps/<id>/artifacts` and no `POST /v1/steps/<id>/run` whose key ends
   `-started`; it **has** one `POST /v1/steps/<id>/run` (the finished report) and one
   `POST /v1/steps/<id>/done` (positive controls that the end did happen);
4. run file (by step) `state: "finished"`, no `startedAt`, no `pid`;
5. `r.sessionsOf(ann, run.sessionId)` is `[]` (it includes tracked ended sessions);
   `noBindClaim(ann, id)`;
6. `r.calls(id)` `[]`; the worktree folder does not exist.
Positive controls for 2 and 5: `test_AC01_one_start_while_reconcile_runs` (session and bind claim
exist for a started run) and `test_AC05_started_keeps_transcript`.

### test_AC04_worktree_failure
- `answerAdd` as `test_AC03_last_nonblank_line`; `neverStarted(k, id, "headless run of <id> did not
  start: could not make a worktree: fatal: 'x' already exists")`.
### test_AC04_invalid_repo_agent
- Step `agent: "bad"` (RL-7 AC-10 setup, `hold: false`); summary `headless run of <id> did not start:
  agent bad has invalid front matter: <inv>` with `<inv> = parseAgentFile(BAD).invalid` (as RL-7's test
  computes it).
### test_AC04_missing_repo_agent
- Step `agent: "ghost"` (not in the repo); summary `headless run of <id> did not start: no agent ghost
  in <repo>/.claude/agents` (the RL-1 text as `test_AC22_missing_agent` builds it).

- FAIL state: a transcript artifact, an artifacts request, a session holding the run's session id, a
  `bind:…:<id>` claim, a `started` report, `startedAt`/`pid` on the file, or another summary.
- Mutations: (1) upload the `Run ended: crashed` transcript in the end path for every run → red on 2/3;
  (2) create/revive the run session (`applyRunSession`) before the worktree/agent checks → red on 5;
  (3) set `startedAt` before the worktree add → red on 4.

## AC-05 Started runs keep their transcript

### test_AC05_started_keeps_transcript (`describe("RL-8 AC-05 started transcript")`)
- Step with fake script `[]` (exit 0, no output, no `mesh_done`), `hold: false`; offer, pull,
  reconcile, `r.started(id)`, `r.endRun(ann, id)`.
- Expected: exactly one artifact `kind: "transcript"`, `title: "run transcript (no_result)"` for the
  step; last round `{outcome: "fail", summary: "headless run ended without mesh_done (exit
  no_result)"}`; one `started` line; the run file has `startedAt` and `pid`.
- Negative control: AC-04 tests (no transcript for never-started runs).
- FAIL: no transcript for this started run. Mutation: skip the transcript whenever the run produced no
  output (instead of only when it never started) → red.

## AC-06 Leftover sessions end

`describe("RL-8 AC-06 leftover sessions")`.

### test_AC06_no_live_print_after_finish (regression guard; passes today)
- Inside the end of `test_AC01_one_start_while_reconcile_runs` and `test_AC05_started_keeps_transcript`
  (shared assertion `noLivePrint(p, run)`), and as a named test of its own that runs the AC-05 flow:
  after the run is `finished`, no session in `GET /local/sessions` with `kind: "print"`, `pid ===
  run.pid` and `state !== "ended"`. Control: before the end the session is live with that pid. FAIL:
  one stays live. Mutation: drop the "end print sessions when setting finished" step (and RL-7 rule 4)
  → red.

### test_AC06_sweep_phantom (carries the AC)
- Seed the v0.1.21 phantom black-box: `cast({hold: false})`, `ann.agents = null`; a step `ph` scripted
  `[{waitFor: "go-ph"}, {exit: 0}]`; offer, pull, reconcile, `r.started(id)`. Read `run` (pid `P`,
  sessionId `S`). Pre-check (positive control): `r.sessionsOf(ann, S)` has one live session,
  `kind: "print"`, `pid: P`, `step: id`, no `seenByReconciler`; after `r.w.flush()`, `GET /v1/fleet`
  lists it as working on `id`.
- Stimulus: `r.w.restart(ann, {}, {}, whileStopped)` where `whileStopped`: `r.go("go-ph")`, wait for
  the exit file, then rewrite the run file (`<runDir>/run.json` as `r.runDir` locates it, JSON) to
  `state: "finished"` with an `endedAt` and `exit: "success"`, keeping `pid` and `sessionId` (the state
  a v0.1.21 daemon left: run finished, session still live). Fallback if the run-file location is not
  reachable from the test: write the session row directly through `ann.store` while stopped (the
  test-writer picks the store's session write method from its exported type).
- Also seed (c) before the restart: a resumed session — a live process `Q = r.liveSleep()`; `w.hook(ann,
  "SessionStart", Q, {session_id: S, cwd: ann.repoDir})`; after restart `ann.agents = [{pid: Q, kind:
  "interactive", sessionId: S, status: "idle", …}]` (no entry for `P`).
- Expected after start-up and one `r.reconcile(ann)`: the phantom (`pid P`) is `ended`; after
  `r.w.flush()`, `GET /v1/fleet` no longer lists it as working; the `Q` session is live, its kind
  `interactive`, not ended.
- Sub-assertion `test_AC06_sweep_at_startup`: right after `restart` and before any reconcile, the
  phantom is already `ended` (contract: "at daemon start"). If the test-writer finds start-up and the
  first pass indistinguishable through the World, it keeps only the after-reconcile assertion and says
  so.
- FAIL: the phantom stays live or still shows working in the fleet; the `Q` session is ended.
- Mutations: (1) remove the sweep from start-up and reconcile → phantom stays live → red; (2) sweep by
  session id only (ignore pid/kind) → `Q` ended → red.

### test_AC06_pid_reuse_running_run_untouched (control (d))
- `cast({hold: false})`; a step `live` scripted `[{waitFor: "go-live"}, {exit: 0}]`, running (pid `P`,
  sessionId `S1`); `ann.agents = [{pid: P, kind: "interactive", sessionId: S1, status: "busy", …}]`.
- Stimulus: `r.w.restart(ann, {}, {}, whileStopped)`; `whileStopped` writes into `runsDir` an older
  finished run file: a copy of the running file with a new `runId` (its own run folder), a new
  `sessionId` `S0`, `state: "finished"`, `endedAt`, same `pid: P`.
- Expected after start-up and after one `reconcile()`: `GET /local/runs` lists both (positive control
  that the old file was loaded and is a sweep candidate) and the running one is still `running`; the
  `S1` session is live and holds step `live` (`step === id`); the fleet still shows it working.
- FAIL: the running run's session is ended or loses its step. Mutation: leftover rule keyed on pid alone
  (ignore session id and running runs) → red. Teardown: `r.go("go-live")`.

## AC-07 Kind stays `print`

### Unit, `src/core/session-state.test.ts` (`describe("RL-8 AC-07 print kind")`)
- `test_AC07_same_pid_keeps_print`: session `{kind: "print", pid: 500, claudeSessionIds: [S], …}`;
  `applyObservation([s], [{kind: "interactive", pid: 500, sessionId: S, status: "busy", …}], ctx)` →
  `kind: "print"`, `seenByReconciler: true`, observed status from `busy` (the same value a non-print
  session gets from the same entry — computed by applying the entry to an `unknown`-kind twin, so the
  test does not hard-code the mapping). FAIL: `interactive`. Mutation: delete the keep rule → red.
- `test_AC07_other_pid_takes_entry_kind`: ended `print` session `{pid: 500, claudeSessionIds: [S]}`,
  entry `{kind: "interactive", pid: 600, sessionId: S}` → `kind: "interactive"`. FAIL: `print`.
  Mutation: keep `print` for any `print` session regardless of pid → red.
- `test_AC07_non_print_takes_entry_kind` (control): `{kind: "unknown", pid: 500}` + same-pid
  `interactive` entry → `interactive`. Proves the entry is applied at all.

### World, `test/relay-start-race.test.ts` (`describe("RL-8 AC-07 print kind world")`)
- `test_AC07_run_session_stays_print`: `hold: false`; running step (fake waits `go-k`); set
  `ann.agents = [{pid: <fake pid>, kind: "interactive", sessionId: run.sessionId, status: "busy", …}]`;
  `r.reconcile(ann)` → the run's session (by `r.sessionsOf`) has `kind: "print"` and
  `seenByReconciler: true` (positive control that the entry was applied); `r.go("go-k")`,
  `r.endRun(...)` → the session still `kind: "print"` (ended). After `r.w.flush()` the fleet entry for
  the session (if listed) has kind `print`. FAIL: `interactive`. Mutation: as the unit keep rule.

## AC-08 Pulse warnings, repo agent

`test/roster-hub.test.ts`, `describe("RL-8 AC-08 pulse warnings, repo agent")`. Setup: `start()`; a
machine of `ann` (`k.k.bare("ann", "ann-box", {repos: [ALPHA]})`, share `me`) reports
`k.report(m, [rep(ALPHA, "bad", BAD, {invalid: INV}), rep(ALPHA, "good", GOOD, …)])` (repo name
`alpha`). Pulse body: the built-in `audit-relay` preset with `params {repo: "alpha", agent, validator,
filer}`, `--every 7d` equivalent. `W(agent) = \`step "audit": agent ${agent} in alpha has invalid front
matter: ${INV}\``.

- `test_AC08_create_warns`: `agent=bad,validator=good,filer=good` → status 201, `json.warnings`
  `toStrictEqual([W("bad")])`. FAIL: refusal, `[]`, extra or different text.
- `test_AC08_all_good_empty`: all `good` → 201, `warnings` `toStrictEqual([])` (the key is present).
  Positive control for "no warning" = `test_AC08_create_warns`.
- `test_AC08_get_has_no_warnings`: after the warning create, `GET /v1/pulses` items and `GET
  /v1/pulses/:id` have no `warnings` key (`"warnings" in x === false`); control: the POST reply had it.
  Mutation: store warnings on the pulse → red.
- `test_AC08_update_window_warns`: `POST /v1/pulses/:id/update {window: "2h"}` → 200, same
  `[W("bad")]`. Mutation: compute warnings on create only → red.
- `test_AC08_update_params_clears`: update `params {repo: "alpha", agent: "good", validator: "good",
  filer: "good"}` → 200, `[]`.
- `test_AC08_two_steps_in_plan_order`: `agent=bad,validator=bad,filer=good` → two warnings, the
  `audit` step first, then the validator's step (ids as the instantiated plan gives them, compared to
  the plan's step order read from the created goal plan or preset), one per step.
- `test_AC08_invisible_machine`: user `bob` (share `me`, cannot see ann's machine) creates the same
  `agent=bad` pulse → 201 `[]`; control: ann's identical call warns. Mutation: read the roster without
  caller visibility → red.
- `test_AC08_other_repo_no_warning`: `bad` reported invalid only in repo `beta`; step repo `alpha` →
  `[]`; control: same with `alpha` warns. Mutation: ignore `repoMatches` → red.
- `test_AC08_unknown_agent_no_warning`: `agent=nobody` → 201, no warning for `audit`.
- `test_AC08_replay_keeps_first`: create with `Idempotency-Key: K` → `[W("bad")]`; the machine then
  reports `bad` valid; replay with `K` → the stored first reply, still `[W("bad")]`; a fresh update
  → `[]` (control that the report took effect).
- If the report helper can send `kind: "opencode"`: `test_AC08_opencode_copy_ignored` → `[]`
  (spec open question); otherwise listed under Not planned.
- FAIL (criterion): a refusal, a missing/extra/different warning, or `warnings` on GET replies.

## AC-09 Pulse warnings, roster key

`describe("RL-8 AC-09 pulse warnings, roster key")` in `test/roster-hub.test.ts`. Setup: `start()`;
`k.catalog({bad: BAD, good: GOOD})`; `INVK = (await k.resolve("ann", "agents/bad")).json.invalid`
(a string starting `front matter is not valid YAML: `). Pulse with the `roster` preset snapshot
(`body({overlap: "allow", params: {repo: REPO, agent: "agents/bad"}}, "roster", ROSTER_HL)`), whose
step id is `run`; the def key = the pulse view's pin key (`agents/bad`).

- `test_AC09_invalid_key_warns`: 201, `warnings` `toStrictEqual([\`step "run": roster agent agents/bad
  has invalid front matter: ${INVK}\`])`.
- `test_AC09_valid_key_none` (control): `agent: "agents/good"` → 201 `[]`.
- `test_AC09_update_uses_pin`: after create, push a valid `bad` (new commit, new hash); `update
  {window: "2h"}` → still the warning (the pin is the invalid hash; an update of other fields does not
  re-pin). Control: `update {params: {…, agent: "agents/bad"}}` re-pins (RL-5 AC-25) → `[]`.
  Mutation: look up the newest catalog version instead of the pin → red.
- `test_AC09_pre_rl7_def_no_warning`: def stored as v0.1.20 did (`putCatalogDefs(…, front: {})`, no
  `invalid`, as `test_AC18_world_repush`) → `[]`.
- FAIL: a refusal or another text. Mutation: build the text with the agent's plain name instead of the
  def key → red.

## AC-10 CLI

`test/pulse-cli.test.ts`, `describe("RL-8 AC-10 pulse warnings")`. Setup: the AC-20 CLI cast plus a
machine of `ann` whose roster report holds repo `alpha` with invalid `bad.md` and valid `good.md` (a
headless person with `agents: {bad: BAD, good: GOOD}` on repo `alpha`, or a direct report as AC-08);
`INV` read back from `GET /v1/agents?name=bad` (the version's `invalid`).

- `test_AC10_add_warns_on_stderr`: `mesh pulse add --preset audit-relay --repo alpha --params
  agent=bad,validator=good,filer=good --every 7d` → exit 0; stdout's first line starts `Created pulse `
  and equals what the same command gives without a warning (format unchanged, ids differ); stdout has no
  `warning:`; stderr `=== \`warning: step "audit": agent bad in alpha has invalid front matter:
  ${INV}\n\`` (exactly one line).
- `test_AC10_update_warns`: `mesh pulse update <id> --window 2h` → exit 0, stdout starts `Updated
  pulse `, stderr the same single line.
- `test_AC10_no_invalid_empty_stderr` (control): all `good` → exit 0, stderr `""`, `Created pulse`
  line present.
- FAIL: non-zero exit, a missing line, the warning on stdout, or extra stderr. Mutation: print warnings
  with `console.log` (stdout) → red; drop the update path's printing → red.

## AC-11 Docs

`test/docs-rl8.test.ts`, `describe("RL-8 AC-11 docs")`:
- `test_AC11_concepts`: `docs/guide/concepts.md` contains `could not make a worktree: fatal:`,
  `already exists`, `maxSessions`, `print`, and (Close-as-fail / Pulse) `transcript` and `invalid`
  next to `mesh pulse add` (same paragraph: a regex over a paragraph split on blank lines).
- `test_AC11_howto`: `docs/guide/howto.md` matches `/warning: step "[^"]+": agent \S+ in \S+ has invalid
  front matter: /`.
- `test_AC11_skill`: `MESH_SKILL` row for `mesh pulse add` mentions `invalid` (the line containing
  `mesh pulse add` matches `/invalid/`); `skills/mesh/SKILL.md` equals `MESH_SKILL` (existing
  `src/claude/skill.test.ts` keeps covering it).
- `test_AC11_api_table`: `docs/plan/implementation-plan.md` contains `(v0.1.22: the reply carries
  \`warnings\` for agents flagged invalid)` on the `POST /v1/pulses` row and on the
  `POST /v1/pulses/:id/{update,…}` row (two occurrences, each on a line containing the route).
- Specific names: review step (not automated), as in RL-7.
- FAIL: a missing mention or mismatch. Mutation: remove the howto sample → red.

## AC-12 CI

- `test/schemas.test.ts`: version `0.1.22` (`test_AC12_version`); the existing OpenAPI comparison stays
  green with no change to `schemas/hub-api.openapi.json` (run `pnpm schemas` and `git diff
  --exit-code schemas/`).
- `test/boundaries.test.ts` (unchanged): `src/daemon` imports no `child_process`.
- `pnpm check` (lint, typecheck, boundaries, test, build) passes. The Postgres legs of the store contract
  are skipped locally (not run), never a failure.
- FAIL: any check red or the document differs. Mutation: import `node:child_process` in a
  `src/daemon` file → boundaries red.

## Coverage

| Criterion | Tests |
|---|---|
| AC-01 | `test_AC01_one_start_while_reconcile_runs`, `test_AC01_pull_again_while_held`, `test_AC01_finished_never_running_again` |
| AC-02 | `test_AC02_two_offers_one_slot`, `test_AC02_control_two_slots`, `test_AC02_offer_in_later_pull_while_held` |
| AC-03 | `test_AC03_last_nonblank_line`, `test_AC03_blank_stderr_exit_code`, `test_AC03_crlf_and_trailing_blank`, `test_AC03_push_failure_note`, `test_AC03_remove_failure_log` |
| AC-04 | `test_AC04_worktree_failure`, `test_AC04_invalid_repo_agent`, `test_AC04_missing_repo_agent` |
| AC-05 | `test_AC05_started_keeps_transcript` |
| AC-06 | `test_AC06_no_live_print_after_finish`, `test_AC06_sweep_phantom` (+ `test_AC06_sweep_at_startup`), `test_AC06_pid_reuse_running_run_untouched` |
| AC-07 | `test_AC07_same_pid_keeps_print`, `test_AC07_other_pid_takes_entry_kind`, `test_AC07_non_print_takes_entry_kind`, `test_AC07_run_session_stays_print` |
| AC-08 | `test_AC08_create_warns`, `test_AC08_all_good_empty`, `test_AC08_get_has_no_warnings`, `test_AC08_update_window_warns`, `test_AC08_update_params_clears`, `test_AC08_two_steps_in_plan_order`, `test_AC08_invisible_machine`, `test_AC08_other_repo_no_warning`, `test_AC08_unknown_agent_no_warning`, `test_AC08_replay_keeps_first` |
| AC-09 | `test_AC09_invalid_key_warns`, `test_AC09_valid_key_none`, `test_AC09_update_uses_pin`, `test_AC09_pre_rl7_def_no_warning` |
| AC-10 | `test_AC10_add_warns_on_stderr`, `test_AC10_update_warns`, `test_AC10_no_invalid_empty_stderr` |
| AC-11 | `test_AC11_concepts`, `test_AC11_howto`, `test_AC11_skill`, `test_AC11_api_table` (+ review for names) |
| AC-12 | `test_AC12_version`, schemas and boundaries tests, `pnpm check` |

## Not planned (contract parts no AC drives)

- A daemon killed during `git worktree add` (stale worktree on restart): out of scope (spec Open
  questions); only the documented failure text is checked (AC-11).
- `mesh pulse add` against an older hub whose reply has no `warnings`: no World hook for an older hub;
  covered by review of the CLI (prints nothing when the field is absent).
- `test_AC08_opencode_copy_ignored` if the roster report helper cannot send `kind: "opencode"`.
- The runner's `start` returning `{ok: false}` as a never-started cause: no fake for it beyond the
  holding runner; the test-writer may add it to AC-04 by answering `start` with `{ok: false, error}` in
  the wrapper if the type allows it.
