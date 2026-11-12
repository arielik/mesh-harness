# Spec RL-8: Run start race and never-started runs

## Status
Draft

Source: a smoke test of v0.1.21 with the real Claude Code CLI found the defects below. Design:
`docs/analysis/2026-11-12-pulse-relay-roster.md` §5.1 (Headless step: offer and start, end of run),
§5.5 (Pulse), §5.10 (Roster); `docs/analysis/2026-11-12-claude-cli-spike.md` wins where it differs.
Builds on RL-1..RL-7 (v0.1.15..v0.1.21); the RL-7 run-session rules (registration, rule 4 "End") stay
and are extended here. Release v0.1.22.

## Problem

1. **HIGH: a run can be started twice.** `HeadlessRuns.handleOffer` (`src/daemon/runs.ts`) saves the
   run file with `state: "queued"` and then awaits `start(run)`. While `start` awaits
   `git worktree add`, a reconcile pass runs `queuePass()`, finds the same run still `queued` and
   calls `start(run)` again. The second `git worktree add` fails (the path exists), so the run is
   ended as not started, the step is failed and the worktree is removed, while the first `start`
   then spawns `claude` in the removed folder (`Can't access working directory`). Observed log:
   `did not start: could not make a worktree: Preparing worktree (detached HEAD …)`, then
   `started … (pid …)` 10 ms later, then `refused by the hub: … is failed`, `finished (crashed)`.
   The same window lets two offers handled at once both start at `maxSessions: 1` (a run being
   started is not counted).
2. **The git error is hidden.** The daemon reports the **first** line of git's stderr
   (`Preparing worktree (detached HEAD …)`, a progress line) instead of the error.
3. **A never-started run leaves traces.** It stores a `transcript` artifact holding only
   `Run ended: crashed`, and (after the race) a session (`kind: "print"`, dead pid) that stays
   `working · <step>` in `mesh machines` long after the goal is done.
4. **An invalid roster agent is only found at run time.** `mesh pulse add`/`update` accept a preset
   whose steps name an agent that the roster already flags `invalid` (RL-7); the problem shows only
   when a slot fires and the run fails at start.
5. **Run sessions change kind.** RL-7 registers a run's session with `kind: "print"`; the reconciler
   (`claude agents --json`, which lists a `-p` process as `interactive`) then overwrites it, so a
   finished run's session shows `interactive` on the runner.

## Scope

In:
- A run is started at most once per daemon process: a run being started is never started again by a
  queue pass or another offer, and counts toward `maxSessions` from the moment its start begins.
- Git failure texts use the last non-blank stderr line (or the exit code).
- Never-started runs: no transcript artifact, no session. Every live `print` session of the run's
  process ends when the run is finished, including such sessions left by v0.1.21.
- `POST /v1/pulses` and `POST /v1/pulses/:id/update` return `warnings` for agents flagged invalid;
  `mesh pulse add`/`update` print them and still succeed.
- The reconciler keeps `kind: "print"` for the process of a run's session.
- Docs: concepts, how-to, the mesh skill, the plan API table.

Out:
- A durable `starting` state. `RunFile` and `GET /local/runs` are unchanged; a daemon that dies in the
  middle of a start leaves the run `queued` as today (Open questions).
- Transcripts of runs that **did** start: unchanged (stored even when short).
- Refusing a pulse because of an invalid agent (it is a warning only), and warnings on `mesh goal
  plan`, presets used by ingest, or the web.
- Hub routes, migrations, `SCHEMA_VERSION`: unchanged. The OpenAPI document is unchanged (pulse
  responses are typed `object` there).

## Interface contracts

Terms as in RL-7 (run, run pid, run session id, the run's sessions). **Start of a run** = the
daemon's work from deciding to start a `queued` run until the run file is `running` with a `pid`, or
the run is ended as not started. **Never-started run** = a run that RL-1/RL-5/RL-7 end as "did not
start" (worktree failure, missing or invalid agent, roster resolve failure, missing profile, or the
runner's `start` returning `{ok: false}`); its run file has no `startedAt`.

### Start at most once (src/daemon/runs.ts, src/daemon/daemon.ts)

1. For one run, the daemon begins a start at most once. Concretely, for one `runId`: at most one
   `HeadlessRunner.git(<checkout>, ["worktree", "add", "--detach", <runDir>/worktree, "HEAD"])` call,
   and at most one `HeadlessRunner.start` call, per daemon process.
2. A queue pass (part of `reconcile()`) that runs while a run's start is in progress skips that run:
   it neither starts nor releases it. A later pass after that start has ended sees the run's new state
   (`running`, or ended as not started) and handles it as RL-1 does.
3. `handleOffer` for an offer whose run already exists (same offer id) answers as today and starts
   nothing.
4. **Capacity.** A run whose start is in progress counts as one live session for `maxSessions`
   (in the daemon's live count) until its start ends; after that it counts as RL-1/RL-7 say (a running
   run without a seen session, or its session). The decision to start and this reservation happen with
   no `await` between them, so offers handled concurrently and queue passes together never begin more
   starts than `maxSessions` allows. The run that loses waits `queued` and starts on a later queue
   pass (RL-1).
5. A never-started run never gets a `pid`, `startedAt` or a session afterwards, and a run file that
   reached `state: "finished"` is never changed back to `running`.

Logs (`deps.log`, read by tests as `p.logs`): unchanged texts. A started run logs exactly one
`run <runId>: started <step> (pid <pid>)` line; a run that started logs no `did not start` line.

### Git failure text (src/daemon/runs.ts)

**Git error** of a failed git call (`RunResult` with `code !== 0`) = the last line of `stderr` that is
not blank after trimming (lines split on `\n`, a trailing `\r` removed), trimmed; when every line is
blank: `git exited with code <code>`. It replaces the first-line text in every git failure message of
`runs.ts`:

| Where | Text |
|---|---|
| `git worktree add` fails | not-started reason `could not make a worktree: <git error>`, so the step summary is `headless run of <step> did not start: could not make a worktree: <git error>` |
| push of `propose-via-branch` fails | step note `headless run: could not push mesh/<slug>: <git error>` |
| `git worktree remove` fails | log `run <runId>: could not remove its worktree: <git error>` |

Example: stderr `Preparing worktree (detached HEAD 1a2b3c4)\nfatal: '/x/worktree' already exists\n`,
code 128 → `fatal: '/x/worktree' already exists`.

### Never-started runs (src/daemon/runs.ts)

- **No transcript.** The end of a never-started run makes no `POST /v1/steps/<step>/artifacts` call.
  Everything else of its end stays as RL-1/RL-7: when the machine still holds the step, `POST
  /v1/steps/<step>/done {outcome: "fail", summary: "headless run of <step> did not start: <reason>"}`;
  `POST /v1/steps/<step>/run {state: "finished", …}` with `telemetry.exit: "crashed"`; no
  `{state: "started"}` report; the worktree (if made) is removed; the run file ends `finished`. The
  closing round therefore has no `artifactIds` (or an empty list).
- **No session.** No daemon session is created or revived for a never-started run: `GET
  /local/sessions` holds no session whose `claudeSessionIds` contains the run session id, and no
  hub claim with key `bind:<sid>:<step>` is sent for it.
- Runs that started are unchanged: a run that started and ends without an accepted `mesh_done` still
  stores its transcript (RL-1 AC-25), however short.

### Run sessions end with the run (src/daemon/runs.ts, src/daemon/daemon.ts)

Extends RL-7 rule 4. **Leftover run session** of a finished run file F (`state: "finished"`) = a
session with all of: `state` other than `ended`; `kind: "print"`; `pid` equal to F's `pid`;
`claudeSessionIds` containing F's `sessionId`; and not a session of a run whose file is `running`
(RL-7 "the run's sessions" of any running run). The pid alone never makes a session leftover: pids
are reused, and a new run's process may get the pid of an old finished run.

- When the daemon sets a run file `finished`, every live session of the run (RL-7 "the run's
  sessions") whose `kind` is `print` is ended in the same step, if rule 4 has not ended it already.
- At daemon start (after the run files are loaded) and on every reconcile pass, every leftover run
  session is ended (`state: "ended"`). This also ends sessions left by v0.1.21.
- A session of another `kind`, with another pid (a person who resumed a finished run's Claude
  session with `claude --resume` gets a new process), or without F's run session id, is not touched
  by these rules. A running run's sessions are never touched by the sweep, even when their pid equals
  the pid of an older finished run file.
- The ended reason text is not part of the contract.

### Session kind (src/core/session-state.ts `applyObservation`)

`applyObservation(sessions, entries, ctx)`: when an entry's `pid` equals the `pid` of the session it
is applied to and that session's `kind` is `print`, the session keeps `kind: "print"`. Everything else
the entry sets (name, observed status, state rules, `seenByReconciler`, …) is unchanged. An entry
matched to a `print` session by Claude session id with a **different** pid sets `kind` from the entry,
as today. `applyRunSession` keeps setting `kind: "print"` (RL-7). Hooks do not change `kind` (as
today). So a run's session shows `print` in `GET /local/sessions`, in the machine report and in
`mesh machines`, while it runs and after it ended.

### Pulse warnings (src/hub/service.ts, src/protocol/pulse.ts, src/cli/pulse-commands.ts)

| Interface | Type | Change |
|---|---|---|
| `PulseView.warnings` | field | New, optional `string[]`. Present (possibly empty) in the replies of `POST /v1/pulses` and `POST /v1/pulses/:id/update`; absent from `GET /v1/pulses` and from `GET /v1/pulses/:id`. Not stored on the pulse. A request replayed under the same `Idempotency-Key` gets the stored first reply, so its `warnings` are those computed at the first call (not recomputed). |
| `POST /v1/pulses`, `POST /v1/pulses/:id/update` | route | Status codes and checks unchanged: an invalid agent never makes them fail. They compute `warnings` from the plan the pulse's current preset snapshot and params instantiate (after the update is applied; on every update, whatever fields it changes). |

Warnings, one per step of the instantiated plan whose `agent` is set, in plan step order, at most one
per step:
- **Roster key** (`agent` contains `/`): take the pulse's pin for that key (its `agents` entry:
  `source`, `name`, `hash`) and the stored catalog definition with repo = the pin's `source`, name =
  the pin's `name` and hash = the pin's `hash` (the catalog defs listed for that repo and name, filtered
  by hash). When that definition has `invalid` →
  `step "<id>": roster agent <def key> has invalid front matter: <invalid>`.
- **Repo agent** (a plain name): take the roster as the caller sees it (`GET /v1/agents?name=<agent>`
  for that caller), its versions in that order; the first version that has `invalid` and a copy with
  `origin: "repo"`, `kind: "claude"` and a repo that the step's `repo` names (`repoMatches`: full id,
  path suffix or name) →
  `step "<id>": agent <agent> in <copy repo name> has invalid front matter: <invalid>`.
- No match → no warning for that step. An agent no machine reports is not a warning. A catalog
  definition with no `invalid` value (also one stored before RL-7, which keeps its first front matter
  on re-push) gives no warning.

`mesh pulse add` / `mesh pulse update` (`src/cli/pulse-commands.ts`): after the success line
(`Created pulse …` / `Updated pulse …` on stdout, unchanged), one line per warning on **stderr**:
`warning: <warning>`. Exit code 0. A reply without `warnings` (an older hub) prints none.

Example: `mesh pulse add --preset audit-relay --repo alpha --params agent=bad,validator=checker,filer=filer --every 7d`
with `alpha/.claude/agents/bad.md` reported invalid → stdout `Created pulse p-1 "audit-relay on alpha": …`,
stderr `warning: step "audit": agent bad in alpha has invalid front matter: front matter is not valid
YAML: Nested mappings are not allowed in compact mappings at line 2, column 14`, exit 0.

### Docs

| File | Change |
|---|---|
| `docs/guide/concepts.md` | "Headless step": a run is started once; a run being started counts toward `maxSessions`; a run that did not start stores no transcript and has no session; failure texts carry git's last error line; a daemon stopped in the middle of a start may leave a partial worktree, so the run's next start fails with `could not make a worktree: fatal: … already exists`; a run's session keeps kind `print`. "Close-as-fail": the transcript is for runs that started. "Pulse" (or the roster section): `mesh pulse add`/`update` warn about agents flagged invalid. |
| `docs/guide/howto.md` | The `audit-relay` pulse section: a sample of the `warning: step "<id>": agent … has invalid front matter: …` line, saying the pulse is still created and the run would fail at start. |
| `src/protocol/skill.ts` `MESH_SKILL` + generated `skills/mesh/SKILL.md` | The `mesh pulse add` row: it warns when a named agent is flagged invalid in the roster. |
| `docs/plan/implementation-plan.md` API table | Rows `POST /v1/pulses` and `POST /v1/pulses/:id/{update,…}`: `(v0.1.22: the reply carries \`warnings\` for agents flagged invalid)`. |

### Compatibility

- No migration, no route change, `RunFile` unchanged. Run sessions stored by v0.1.21 with
  `kind: "interactive"` keep that kind; a v0.1.21 phantom `print` session is ended by the sweep.
- Tests that assert a transcript for a never-started run (RL-1 AC-22's missing-agent case, RL-5
  AC-21, RL-7 AC-10, if they do) are updated by the test-writer: no transcript, same summary.
- `package.json` version `0.1.22`.

## Acceptance criteria

Surfaces: unit tests (`src/core`), CLI tests, World tests (`test/helpers/world.ts`,
`test/helpers/relay-kit.ts`) with the fake `claude` (`test/fixtures/claude/fake-claude`; never the
real binary) and, where a slow or failing git step is needed, a `HeadlessOptions.runner` that wraps
`processRunner` and holds or answers `git` calls whose args start with `["worktree", "add"]` (or
`["push"]`). A holding wrapper records every call, holds only the **first** `worktree add` (so a
second one, as on today's code, passes through at once and is counted, never hangs), and the test
waits until that first call is recorded before it calls `reconcile()` or sends more offers. Runs are found by `step`, never by `runId`. Fixture rules as in RL-7 (remote-backed
repos, `shareSessions` `me`/`all`).

| Id | Criterion | Surface | What exact state makes it FAIL? |
|---|---|---|---|
| AC-01 | Start race: a headless step is auto-offered; the wrapped runner holds the run's `worktree add` call until the test releases it. While it is held, the test runs `p.daemon.reconcile()` to completion (twice). Then it releases the call. The fake starts and calls `mesh_done` (outcome done) and exits with a `result`. Result: exactly one `worktree add` and one `start` call for the run; one calls file of the fake for the step; the fake's recorded `cwd` existed at start; `p.logs` has exactly one `started <step>` line and no `did not start` line; the step is `done` (not failed); the run file is `finished` with `exit: "success"`; no transcript artifact. | World + fake claude + wrapped runner | A second `worktree add` or `start`, a `did not start` line, the step `failed`, the fake started in a missing folder, or a transcript. |
| AC-02 | Capacity during a start: `maxSessions: 1`, no other session; two headless offers (two goals) reach the daemon in one pull while the first `worktree add` is held. Before the release: one `worktree add` call in total, the other run is `queued` in `GET /local/runs`, and a `reconcile()` begins no second start. After the release, the first run runs; when it ends (fake exits), the second run starts on a later reconcile. Never two runs `running` without `endedAt` at once. | World + fake claude + wrapped runner | Two starts while one is in progress, two runs running at once, or the second never starts. |
| AC-03 | Git error text: the wrapped runner answers the run's `worktree add` with `{code: 128, stdout: "", stderr: "Preparing worktree (detached HEAD 1a2b3c4)\nfatal: 'x' already exists\n"}` → the step is `failed` with summary `headless run of <step> did not start: could not make a worktree: fatal: 'x' already exists`; with `stderr: "\n  \n"` → `… could not make a worktree: git exited with code 128`. A `propose-via-branch` run whose push the wrapped runner fails with stderr `remote: x\nerror: failed to push some refs\n` → the step's note is `headless run: could not push mesh/<slug>: error: failed to push some refs`. | World + fake claude + wrapped runner | The first line (`Preparing worktree …`, `remote: x`), an empty reason, or another text. |
| AC-04 | Never-started run, no transcript and no session: (a) worktree failure as AC-03; (b) a repo agent with invalid front matter (RL-7 AC-10); (c) a missing repo agent. In each case after the run ends: the step is `failed` with the documented summary; `GET /v1/goals/<goal>/artifacts` has no `transcript` for the step and the closing round has no artifact id; `run.finished` telemetry has `exit: "crashed"`; the run file is `finished` and has no `startedAt`/`pid`; `GET /local/sessions` has no session whose `claudeSessionIds` contains the run's `sessionId`; `p.requests` has no request with key `bind:<…>:<step>`. | World + fake claude | A transcript artifact, a session, a bind claim, or another summary. |
| AC-05 | Started runs keep their transcript: a run that starts and exits 0 with no output and no `mesh_done` still stores a `transcript` artifact (title `run transcript (no_result)`) and the step is `failed` with `headless run ended without mesh_done (exit no_result)` (RL-1 AC-25 unchanged). | World + fake claude | No transcript for a started run. |
| AC-06 | Leftover sessions end. (a) Regression guard (passes today too; (b) carries the AC): after any finished run (AC-01, AC-05), no session with `kind: "print"` and `pid` = the run's pid is live. (b) Sweep: a daemon whose store holds (written before a restart) a live session `{kind: "print", state: "working", step: <step>, pid: <P>, claudeSessionIds: [<S>]}` with `seenByReconciler` absent, where `runsDir` holds a `finished` run file with `pid` P and `sessionId` S, and the World's `p.agents` is `null` or a list without P → after start-up and one `reconcile()`, that session is `ended`, and after a flush `GET /v1/fleet` (what `mesh machines` shows) no longer lists it as working. (c) Control: a live `interactive` session with the run's Claude session id and another pid (a resumed session) stays live. (d) Control, pid reuse: a run that is `running` (fake still alive) whose session's pid P equals the `pid` of an older `finished` run file written by the test into `runsDir` (another `runId` and `sessionId`) → after `reconcile()` the running run's session is still live and holds its step. | World | The phantom stays live, the resumed session is ended, or the running run's session is ended. |
| AC-07 | Kind stays `print` (unit): a session `{kind: "print", pid: 500}` and `applyObservation` with entry `{kind: "interactive", pid: 500, sessionId: <its id>, status: "busy"}` → `kind: "print"`, other fields as for any session (`seenByReconciler: true`, observed status); an ended `print` session matched by Claude session id from an entry with pid 600 and `kind: "interactive"` → `kind: "interactive"`; a non-print session takes the entry's kind as before. (World) a running run whose fake pid the World's agents listing (`p.agents`) reports as `interactive`: after `reconcile()` its session is `kind: "print"`, and still `print` after the run finished. | unit + World + fake claude | `interactive` on the run's session, or the resume case kept `print`. |
| AC-08 | Pulse warnings, repo agent: a runner (share `me`) reports repo `alpha` with invalid `.claude/agents/bad.md` and valid `good.md`. `POST /v1/pulses` of `audit-relay` with `agent=bad,validator=good,filer=good` → 201, `warnings` = exactly `[ 'step "audit": agent bad in alpha has invalid front matter: <invalid>' ]`; with all `good` → `warnings: []`; `GET /v1/pulses` and `GET /v1/pulses/:id` have no `warnings`. `POST /v1/pulses/:id/update` with only `{window}` on the first pulse → 200 with the same warning; with params `agent=good` → `[]`. A caller who cannot see the reporting machine (share `me`, another user) gets `[]`. | World | A refusal, a missing/extra/different warning, or `warnings` on GET replies. |
| AC-09 | Pulse warnings, roster key: a catalog source pushes an invalid `bad` definition; a pulse whose preset step has `agent: <source>/bad` → 201 with `step "<id>": roster agent <def key> has invalid front matter: <invalid>`; a valid key → none. | World | A refusal or another text. |
| AC-10 | CLI: `mesh pulse add …` with the AC-08 invalid agent → exit 0, stdout the unchanged `Created pulse …` line, stderr exactly `warning: step "audit": agent bad in alpha has invalid front matter: <invalid>`; `mesh pulse update <id> --window 2h` → exit 0, `Updated pulse …` and the same stderr line; without invalid agents stderr is empty. | CLI | A non-zero exit, a missing line, a line on stdout, or extra stderr. |
| AC-11 | Docs: concepts, how-to, mesh skill and plan API table cover the Docs table; `MESH_SKILL` equals `skills/mesh/SKILL.md`; no team-, company- or person-specific name is added to code or docs. | review + skill test | A missing mention, a mismatch or a specific name. |
| AC-12 | `package.json` version `0.1.22`; `pnpm check` passes (lint, typecheck, boundaries, test, build); `schemas/hub-api.openapi.json` matches `pnpm schemas` (unchanged); `src/daemon` still imports no `child_process`. | CI | Any check fails or the document differs. |

## Open questions

- 2026-11-12 **In-memory guard, no `starting` state.** The fix is a per-process guard plus the
  capacity reservation; `RunFile.state` keeps its four values so `GET /local/runs` and run files stay
  compatible. A daemon killed during `git worktree add` leaves the run `queued` with a partial
  worktree; after a restart the queue pass starts it again and it may fail as "could not make a
  worktree" (now with the real git error). Cleaning a stale worktree before the add
  (`git worktree remove --force` or `prune`) is left out; concepts documents the failure text.
- 2026-11-12 **Transcripts of short started runs.** Only never-started runs skip the transcript. A run
  that started and produced nothing keeps its `Run ended: <exit>` transcript (it tells the reader the
  process ran), as RL-1 AC-25 requires.
- 2026-11-12 **Sweep scope.** The sweep ends only live `print` sessions whose pid is a finished run's
  pid **and** whose Claude session ids hold that run's session id, and never a running run's session
  (review r1 B1: the pid alone would end a live run whose process reused an old pid). A person's resumed session (new pid; kind from the reconciler or `unknown` from hooks) is never
  ended by it. `released` runs never had a process and are not matched.
- 2026-11-12 **Kind rule keyed on the pid.** `print` is kept only for the same process. If the
  reconciler is not available (`claude agents` missing), kind stays whatever registration set.
  RL-7 already fixes `kind: "print"` for registered run sessions; this row follows it.
- 2026-11-12 **Warnings, not refusals; hub-side.** The brief asks for a warning. The hub computes it
  (it has the roster and the pins), so the CLI needs no extra request and the warning reaches any
  client of the routes. Repo copies follow the caller's roster visibility (RL-5), so a warning never
  reveals a machine the caller cannot see. Opencode copies (`kind: "opencode"`) are ignored, since a
  headless run reads `.claude/agents/<name>.md`.
- 2026-11-12 **Warnings on every update.** `POST /v1/pulses/:id/update` warns whatever field changed,
  from the pulse's resulting preset and params, so `mesh pulse update` keeps reminding while the agent
  stays invalid. The pinned roster definition is the pulse's pin (an update of other fields does not
  re-pin).
- 2026-11-12 **Logs.** No new log texts are part of the contract; tests count the existing `started`
  and `did not start` lines.
