# Spec RL-7: Fixes from the real-CLI smoke test

## Status
Draft

Source: a smoke test of v0.1.20 with the real Claude Code CLI (8 headless runs, model haiku), which
found the eight defects below. Design: `docs/analysis/2026-11-12-pulse-relay-roster.md` §5.1 (Headless
step), §5.2 (Artifacts, redaction), §5.6 (built-in `audit-relay`), §5.10 (Roster);
`docs/analysis/2026-11-12-claude-cli-spike.md` wins where it differs (its "Other flags" note on
`--session-id`: "the daemon can choose the session id before start ... and match hook events ... to
the run"). Builds on RL-1..RL-6 (v0.1.15..v0.1.20). Release v0.1.21.

## Problem

1. **HIGH: a headless run binds to its step only through the user's hooks.** The daemon learns
   about the run's Claude session only from the user-level `SessionStart` hook (`installer.ts`). When
   the user's `~/.claude/settings.json` hooks are missing, or point at another daemon (another port or
   key), this daemon never registers the session. Every mesh tool call from the run then fails
   (`mesh doesn't know this Claude session yet …` or `this session holds no step`), tokens are spent,
   and the step fails only at the end with `headless run ended without mesh_done`.
2. **MEDIUM: terminal variables leak into headless runs.** The run's process inherits the
   daemon's `TMUX` and `TMUX_PANE`. The hooks send them as `X-Tmux`/`X-Tmux-Pane`, so a daemon records a
   real tmux pane for a headless session and could type into it.
3. **MEDIUM: invalid agent front matter is silently dropped.** `splitFrontMatter`
   (`src/core/headless.ts`) turns a YAML error (e.g. an unquoted `: ` in `description`) into `{}`. The
   run then uses the default model, all tools and no declared rules, and the roster shows the agent as
   if it had no front matter.
4. **LOW: redaction rewrites prose.** The assignment pattern of `redactSecrets` turns
   `### 1. secret: hardcoded API token` into `### 1. secret: [REDACTED] API token`.
5. **LOW: `mesh preset ls` does not list repo templates** (`.mesh/presets/*.yaml`), although
   `docs/guide/howto.md` and `docs/guide/cycle.md` say it does.
6. **LOW: `mesh show` progress ignores skipped steps.** A `done` goal with two skipped steps prints
   `done · … · 1/3 steps done`.
7. **LOW: `mesh_done` tells headless runs to commit trail files** (`Commit it with your work: git
   add …`). The run's worktree is discarded, so the hint wastes turns.
8. **The built-in `audit-relay` budget is fixed** at 80 turns / 60 minutes. A pulse cannot lower it.

## Scope

In:
- The daemon registers and binds a headless run's session itself, using the `--session-id` it passed
  and the pid it started. Hooks become optional for runs and stay idempotent. A tool call from a
  run's pid that finds no bound session binds it. The run's session ends when the run ends.
- Removing terminal-binding variables from the environment of headless runs.
- Agent front matter that is not valid YAML: flagged on the roster (daemon reports, catalog, `GET
  /v1/agents`, `mesh agents`, web Roster) with the parse error; a headless step that names such an
  agent fails at start and is never run.
- A tighter `redactSecrets` colon form. This replaces the RL-1 contract text.
- `mesh preset ls` lists repo templates.
- `mesh show` and the web goal header count skipped steps as done in the "steps done" text.
- `mesh_done` replies to headless runs without commit hints.
- Preset parameter defaults (`params:`). Budget `turns`/`minutes` may be `{param}` placeholders.
  The built-in `audit-relay` uses `{turns}` (default 80) and `{minutes}` (default 60).
- Docs: concepts, how-to, the mesh skill, the plan API table, and the RL-1 spec's `redactSecrets`
  section.

Out:
- Matching a tool call to a run by process ancestry (a non-`exec` wrapper around `claude`; Open
  questions).
- Stopping another daemon that receives a run's hooks from claiming the step (Open questions).
  `MESH_STEP` stays in the run's environment.
- Refusing invalid roster agents when a pulse is created or a pin is resolved at the hub. The daemon
  check at start is the guard.
- `LiveView.goals[].done` (TUI and web live progress bars) and the trail/ledger `done` counts stay
  "done only".
- JSON-style assignments (`"token": "…"`), which are not matched today and still are not.
- New hub routes. No migration: `SCHEMA_VERSION` is unchanged.

## Interface contracts

### Headless run session binding (src/daemon/runs.ts, src/daemon/daemon.ts)

Terms. **Run** = a run file with `state: "running"` and no `endedAt`. Its **pid** = `RunFile.pid`, the
pid of the started `claude` process. Its **session id** = `RunFile.sessionId`, passed as
`--session-id`. Its **worktree** = `<run dir>/worktree`. **The run's session** = the daemon session
(`Session`, as listed by `GET /local/sessions`) whose `claudeSessionIds` contains the run's session id.

1. **Registration at start.** Right after the runner reports the run started (`pid` known), and
   before `POST /v1/steps/<step>/run {state: "started"}`, the daemon makes the run's session exist.
   It needs no hook. The session is not `ended`, and has `claudeSessionIds` ∋ run session id,
   `pid` = run pid, `cwd` = worktree, `step` = run step, and no `pane`/`tmuxSocket`. If a session for
   that Claude session id already exists, the daemon reuses it (same `sid`, revived when ended) and
   does not create a second one. The daemon then binds the step at the hub once per `(sid, step)`:
   `POST /v1/steps/<step>/claim {sid}` with `Idempotency-Key: bind:<sid>:<step>`, the call a
   `SessionStart` hook with `X-Mesh-Step` makes today. The session holds the step locally whatever
   the hub answers (offline included).
2. **Hooks stay idempotent.** A later hook (`SessionStart`, `UserPromptSubmit`, `Stop`, `SessionEnd`)
   with `session_id` = the run's session id and/or `X-Claude-Pid` = run pid and `cwd` = worktree
   updates that session. No second session is created. After a `SessionStart` with `X-Mesh-Step` =
   run step, the hub's `holderSid` of the step is still the same `sid` and the daemon sends no second
   bind claim for `(sid, step)`. A `Stop` hook of a run's session still gets `{}` (RL-1: no messages to
   run sessions).
3. **Binding on the first tool call.** `POST /local/mcp/:tool` with `{pid}` (no `agentSessionId`),
   in this order:
   - a live session with that pid exists and holds a step → unchanged (RL-1);
   - a live session with that pid exists, holds **no** step, and `pid` = the pid of a run → the
     daemon binds that session to the run's step (as rule 1: local step, adds the run's session id to
     its `claudeSessionIds`, one hub bind claim), then runs the tool;
   - no live session has that pid, and `pid` = the pid of a run → the daemon registers the run's
     session as in rule 1 (reusing and reviving the session of the run's session id when there is
     one, so the `sid` stays the same), then runs the tool;
   - otherwise → unchanged: `mesh doesn't know this Claude session yet (are the hooks installed? run
     \`mesh doctor\`).`, or for a session with no step the RL-1/MM texts (`This session holds no mesh
     step…`, `this session holds no step`).
4. **End.** When the daemon sees a run's process has ended (the reconcile pass that sets `endedAt`),
   it ends the run's session (`state: "ended"`) unless a `SessionEnd` hook already did. This happens
   in that same pass, before the end-of-run hub calls. A finished run's session is no longer counted
   by `liveCount()` for `maxSessions`.
5. `GET /local/runs`, `RunFile` and the hub API are unchanged.

### Environment of a headless run (src/claude/headless.ts, src/core/headless.ts)

| Interface | Type | Change |
|---|---|---|
| `HEADLESS_ENV_UNSET` (src/core/headless.ts, exported from src/core/index.ts) | const | New: `["TMUX", "TMUX_PANE", "MESH_AUTOPILOT", "CLAUDE_PID"] as const`. These are the terminal- and session-binding variables mesh's hooks and plugins read. |
| `HeadlessSpec.unsetEnv` (src/claude/headless.ts) | field | New, optional `readonly string[]`. `processRunner.start` removes each named variable from the child's environment. The child's environment is the waiter's environment, plus `spec.env`, minus `unsetEnv`, so `spec.env` cannot re-add a name in `unsetEnv`. Every other variable is passed as before. |
| `HeadlessRuns.start` | behaviour | Passes `unsetEnv: HEADLESS_ENV_UNSET` and `env: {MESH_STEP, MESH_RUN}` as before. |

### Agent front matter (src/core/headless.ts, src/core/roster.ts, src/protocol/roster.ts)

**Invalid front matter.** The file starts with a front matter block (`---` line, YAML, `---` line;
CRLF taken as LF, as today) and either:
- the YAML does not parse → `invalid` = `front matter is not valid YAML: <m>`, where `<m>` is the
  first line of the parser's error message with one trailing `:` removed. Line numbers in it count
  from the first line after the opening `---`. Example with the `yaml` package in use: front matter
  line 2 `description: Validates: findings` gives `front matter is not valid YAML: Nested mappings are
  not allowed in compact mappings at line 2, column 14`;
- or the YAML parses to something other than a mapping (a list, a scalar, `null` from an empty block
  is **not** invalid: an empty block stays `{}`) → `invalid` = `front matter is not a YAML mapping`.

`invalid` is cut to 300 characters. A file without a front matter block is valid, as today.

| Interface | Type | Change |
|---|---|---|
| `AgentFile.invalid` | field | New, optional string, as above. When set, `name`, `description`, `tools`, `model` and `rules` are absent. `body` is the text after the block, as today. |
| `parseAgentFile(text)` | function | Sets `invalid`. Otherwise unchanged. |
| `frontMatter(text)` | function | Unchanged (`{}` for invalid). |
| `AgentFront` (zod) | schema | Gains `invalid: z.string().max(300).optional()`. It therefore appears in `AgentReport` (machine report body), `CatalogDefView`, `AgentVersion` and the OpenAPI document. |
| `agentFront(text)` | function | Returns `{ invalid }` alone for an invalid file. Otherwise unchanged. |
| `AgentGroup.invalid` | field | New `boolean`: some version of the group has `invalid`. |
| `scanAgents` (daemon) | behaviour | Reports an invalid file, with `invalid` set and its hash. It is never skipped. |
| Hub catalog push | behaviour | A catalog definition stores `agentFront(text)`, so it carries `invalid` too. `GET /v1/agents` and `GET /v1/agents/resolve` return it. |
| `mesh agents` (src/cli/roster-commands.ts `rosterText`) | CLI | The group line's flags gain `  invalid`, after `diverged`, `pinned`, `behind` and `modified`. The version line of an invalid version is `  <hash12>  invalid: <invalid>` in place of the description. |
| Web Roster (web/src/roster.tsx) | UI | An invalid version shows `<span class="roster-invalid">invalid: <invalid></span>` in place of the description. The group header shows a `.roster-flag` with text `invalid`. |

**Headless start (src/daemon/runs.ts).** The daemon has the agent text (repo agent from the run
worktree, or roster agent fetched and hash-checked). If `parseAgentFile(text).invalid` is set, the
run does not start and the `claude` executable is never spawned. The step is closed as an RL-1
not-started run: `POST /v1/steps/<step>/done {outcome: "fail", summary}` with summary
- repo agent: `headless run of <step> did not start: agent <name> has invalid front matter: <invalid>`;
- roster agent: `headless run of <step> did not start: roster agent <key> has invalid front matter: <invalid>`
  (`<key>` = the pinned def's `key`).

No `agents.json` is written for it. The worktree is removed and the run file ends `finished`, as
for every not-started run.

### `redactSecrets` (src/core/redact.ts): replaces the RL-1 "assignments" rule

The signature, the order (PEM blocks, literals, tokens, assignments), the token list and the
counting rules stay as in RL-1. Only the assignment pass changes. Keys are as before:
`\b(password|passwd|secret|token|api[_-]?key)`, any case. Take `V` = the value as RL-1 captures it
(optional quote `q`, then `[^\s"']{6,}`, then the same `q`). Then:

| Form | Rule |
|---|---|
| `=` separator (`key=V`, `key = "V"`, …) | As RL-1: `V` → `[REDACTED]`. |
| `:` separator, quoted (`key: "V"`, `key:'V'`) | As RL-1: `V` → `[REDACTED]`. |
| `:` separator, unquoted | `V` exactly a mark → unchanged, not counted (RL-1). `V` contains a mark among other text → whole `V` → `[REDACTED]`, not counted again (RL-1). Otherwise strip trailing characters from `.,;:!?)]}` to get `V'`. `V'` is **token-like** when it matches `^[A-Za-z0-9_+/=.~-]{6,}$` **and** (contains a digit **or** is at least 20 characters long). Only then is `V'` replaced by `[REDACTED]` (the stripped characters are kept) and counted once. A value that is not token-like is left unchanged and not counted. |

Examples (`R` = `[REDACTED]`):

| Input | Output | count |
|---|---|---|
| `### 1. secret: hardcoded API token` | unchanged | 0 |
| `password: correcthorse` | unchanged | 0 |
| `token: abcdef` | unchanged | 0 |
| `api_key: abcdef123` | `api_key: R` | 1 |
| `secret: s3cr3tvalue` | `secret: R` | 1 |
| `password: hunter2.` | `password: R.` | 1 |
| `token: abcdefghijklmnopqrstuv` (22 letters) | `token: R` | 1 |
| `Token: 'abcdefgh'` | `Token: 'R'` | 1 |
| `token=abcdef` | `token=R` | 1 |
| `token: ` + a `ghp_` token | `token: R` | 1 (the token pass) |
| `token: https://example.invalid/x1` | unchanged | 0 |

`docs/specs/RL-1.md` (Core, the `redactSecrets` paragraph) is changed to this rule, with a line
`(changed in RL-7)`.

### `mesh preset ls` (src/cli/hub-commands.ts `presetCommand`)

**Repo templates.** `*.yaml` files directly in `<dir>/.mesh/presets/`, for every `<dir>` from the
current directory up to and including the first directory that holds `.git`. If no directory up to
the filesystem root holds `.git`, the walk goes to the root. This is the walk `findPresetSource` makes.
The template name is the file name without `.yaml`. When two directories have the same name, the
one nearer the current directory wins and the farther one is not listed.

Output (exit 0):
1. The built-in lines, unchanged: `${name.padEnd(14)} ${description}` for each of
   `BUILTIN_PRESETS`, in order.
2. When there is no repo template: the current line `Repo templates: .mesh/presets/<name>.yaml (a
   description and steps, repo "{repo}").`
3. Otherwise one line per repo template, sorted by name (code-unit order):
   `${name.padEnd(14)} ${description || "-"}  [<file>]`, where `<file>` is the file path relative to
   the current directory with `/` separators. A name that is also a built-in name gets
   `  (replaces the built-in)` at the end. A file that `parsePreset` rejects gets
   `${name.padEnd(14)} invalid: <first line of the error message>  [<file>]`.

`mesh preset show <name>` is unchanged (repo first, then built in).

### Progress text (src/cli/show.ts `renderGoal`, web/src/goals.tsx goal page)

In `<state> · owner @<owner> · <n>/<total> steps done…`, `<n>` counts the non-dropped steps in state
`done` **or** `skipped`. `<total>` is unchanged (non-dropped steps). Nothing else in the output
changes.

### `mesh_done` reply (src/daemon/tools.ts, src/daemon/trail.ts)

A **headless call** is a call whose session belongs to a run (rule 3 above), or whose step has
`policy.mode: "headless"` in the hub's reply (or, when offline, in the cached context). For a
headless call:
- online, record written: the line is `mesh wrote the step record <paths>.` or `mesh wrote the step
  record and goal file <paths>.`, with no `commitHint` text;
- online, record not written (no repo root): the `Step record (save as … and commit it):` block is
  left out;
- offline: `The hub is offline: mesh recorded <id> as <state> locally and wrote the step record
  <path>. The hub gets it when it is back (facts from other people's sessions are added then).`
  (no commit hint).

In short, the reply to a headless call never contains `git add` or `commit`. Trail files are still
written into the worktree. Replies to all other sessions are unchanged.

### Preset parameter defaults and budget placeholders (src/core/presets.ts)

| Interface | Type | Change |
|---|---|---|
| `Preset.params` | field | New, optional `Record<string, string>`: default values of parameters. Names match `^[a-z][a-z0-9_]{0,39}$`. |
| `PresetStep.budget` | schema | `turns` and `minutes` each accept an integer (as `StepBudget`) **or** a string that is exactly one placeholder, `^\{[a-z][a-z0-9_]*\}$`. `usd` is unchanged. |
| `parsePreset(name, text)` | function | Reads an optional top-level `params:` mapping. Values may be strings or numbers, and numbers become their decimal string. A key that does not match the name pattern, or a value that is not a string or number, throws `preset <name>: params must map names (a-z, 0-9, _) to values`. |
| `presetText(p)` | function | Emits `params:` after `description` and before `steps`, but only when `p.params` has keys. `parsePreset(p.name, presetText(p))` deep-equals `p` for every built-in. |
| `instantiate(p, opts)` | function | The variables are `{...p.params, ...opts.params, repo, goal}`, so an explicit param beats a default. Budget placeholders are filled from them. The filled value must be a whole number (`^\d+$`) from 1 to 500 (`turns`) or 1 to 1440 (`minutes`); it becomes a number. Errors (thrown, so the hub reports them as preset problems, RL-3): unknown placeholder → `preset <name>: unknown parameter {<x>} in step <id>`; bad value → `preset <name>: budget.<turns\|minutes> in step <id> must be a whole number from 1 to <500\|1440>, got "<value>"`. |
| Built-in `audit-relay` | data | `params: {turns: "80", minutes: "60"}`. Step `audit` has `budget: {turns: "{turns}", minutes: "{minutes}"}`. Everything else is unchanged, so `instantiate` with only `agent`, `validator` and `filer` gives the same plan as v0.1.20 (`budget: {turns: 80, minutes: 60}`). |

`mesh pulse add --preset audit-relay … --params agent=a,validator=v,filer=f,turns=40,minutes=20`
creates a pulse whose fired goals' `audit` step has `budget: {turns: 40, minutes: 20}`. `turns=abc`
gives 422 `the preset has 1 problem(s): preset audit-relay: budget.turns in step audit must be a whole
number from 1 to 500, got "abc"` (RL-3 problem format).

### Docs

| File | Change |
|---|---|
| `docs/guide/concepts.md` | "Headless step": the daemon registers the run's session itself (by the `--session-id` it passes and the pid it starts), so runs need no hooks; hooks that arrive change nothing; a first tool call from the run binds it; the session ends with the run; `TMUX`, `TMUX_PANE`, `MESH_AUTOPILOT` and `CLAUDE_PID` are removed from the run's environment; an agent whose front matter is not valid YAML fails the step at start (the summary text). "Redaction on the machine": the `:` rule (quoted or token-like values only). "Built-in `audit-relay`": params `turns` (default 80) and `minutes` (default 60). "Roster": the `invalid` flag. Presets: `params:` defaults and budget placeholders. |
| `docs/guide/howto.md` | `mesh preset ls` sample with a repo template line; the `audit-relay` pulse example with `turns=…,minutes=…`; the shown preset sha updated to the new `audit-relay` text. |
| `src/protocol/skill.ts` `MESH_SKILL` + generated `skills/mesh/SKILL.md` | "Headless runs": the step record mesh writes is not committed in a headless run (the worktree is discarded). |
| `docs/plan/implementation-plan.md` API table | Row `GET /v1/agents?name=`: `(v0.1.21: versions carry \`invalid\` when the front matter is not valid YAML)`. |
| `docs/specs/RL-1.md` | The `redactSecrets` paragraph per this spec. |

### Compatibility

- No migration. Stored agent reports and catalog definitions without `invalid` stay valid. A machine
  scan or catalog push sets `invalid` from then on.
- The `audit-relay` text and sha256 change. Pulses snapshotted earlier keep their snapshot (numeric
  budget) and fire as before.
- Existing tests that assert the old behaviour are updated by the test-writer: `token: abcdef` is now
  unchanged; `mesh preset ls` output in a checkout with `.mesh/presets`; `presetText(audit-relay)`;
  `package.json` version. Tests that register a run's session with a hook keep passing (rule 2).

## Acceptance criteria

Surfaces: unit tests (`src/core`, `src/protocol`, `src/claude`), CLI tests, World tests
(`test/helpers/world.ts`, `test/helpers/relay-kit.ts`) with the fake `claude` of RL-1
(`test/fixtures/claude/fake-claude`, extendable; never the real binary), and Playwright
(`test/e2e-web`, `pnpm test:web`). Fixture rules: a daemon reports only remote-backed repos and only
under `shareSessions` `me`/`all`; web e2e specs share one hub, so the RL-7 web spec uses data no other
spec asserts on. The `HubStore` contract's Postgres legs run only when `MESH_TEST_PG_URL` is set; there
is no store change here.

| Id | Criterion | Surface | What exact state makes it FAIL? |
|---|---|---|---|
| AC-01 | Registration without hooks: a headless step is auto-offered and started (fake waits on a `go` file); **no hook is sent**. Right after start, the person's daemon has exactly one session (ended or not) whose `claudeSessionIds` contains the run's `sessionId`, with `pid` = the fake's pid, `cwd` = `<run dir>/worktree`, `step` = the step, no `pane`/`tmuxSocket`, state not `ended`. After a flush, the hub's step `holderSid` = that session's `sid`. | World + fake claude | No session, two sessions, a wrong pid/cwd/step, a pane set, or another `holderSid`. |
| AC-02 | Tools work without hooks: in the AC-01 state, `w.tool(p, <fake pid>, "mesh_context")` returns the step's context (contains the step id and its brief, not `holds no` and not `doesn't know this Claude session`); `mesh_artifact` stores an artifact on the step; `mesh_done` (outcome done) → the step is `done`; after the fake exits with a `result` event, the run is `finished`, no transcript artifact is stored, and the round's telemetry is complete (`turnsApprox: false`). | World + fake claude | Any tool refused, the step failed or closed twice, or a transcript stored. |
| AC-03 | Hooks stay idempotent: after AC-01, `SessionStart` (session id = run `sessionId`, pid = fake pid, cwd = worktree, header `step` = the step), then `UserPromptSubmit` and `Stop`. Still exactly one session with that Claude session id and the same `sid`; hub `holderSid` unchanged; the `Stop` reply is `{}`; the daemon made no second `POST /v1/steps/<step>/claim` for that `(sid, step)` (count the hub requests or the bind log). The same without the step header gives the same result. | World + fake claude | A second session, a changed `sid`/`holderSid`, a non-empty Stop reply, or a second bind claim. |
| AC-04 | Bind on first tool call: (a) after AC-01, a `SessionEnd` hook for the run's session id ends it; then `w.tool(p, <fake pid>, "mesh_context")` answers with the step's context, and the run's session is live again with the **same** `sid` and `step`. (b) After (a)'s `SessionEnd`, a `SessionStart` with another session id, pid = fake pid, cwd = another folder and no step header creates a live session with no step; then `w.tool(p, <fake pid>, "mesh_context")` answers with the step's context and that session now holds the step. (c) Control: `w.tool` from a pid that is no run's and no session's → `mesh doesn't know this Claude session yet (are the hooks installed? run \`mesh doctor\`).`; a hook-registered session of a non-run pid with no step → `mesh_done` error `this session holds no step`. | World + fake claude | A refusal in (a)/(b), a new `sid` in (a), or a changed text in (c). |
| AC-05 | Session ends with the run: the fake exits (exit 0, no hooks at all); after one reconcile, the run's session is `ended` and the run is closed as RL-1 (`headless run ended without mesh_done (exit no_result)`). With `maxSessions: 1` and a second headless offer queued behind the first run, the second run starts on the reconcile after the first one ends. | World + fake claude | The session stays live, or the queued run never starts. |
| AC-06 | Environment: (unit) `processRunner.start` with `env: {A: "1", TMUX: "x"}`, `unsetEnv: ["TMUX", "B"]` and the waiter's environment holding `B=2` and `C=3` → the child sees `A=1`, `C=3`, no `TMUX`, no `B`. (World) with `TMUX=/tmp/tmux-1/default,1,0`, `TMUX_PANE=%3`, `MESH_AUTOPILOT=chain`, `CLAUDE_PID=4242` and `FAKE_PARENT_VAR=kept` in the daemon process environment, the fake records none of the first four, `FAKE_PARENT_VAR=kept`, and `MESH_STEP`/`MESH_RUN` of the run. `HEADLESS_ENV_UNSET` equals the documented list. | unit (src/claude) + World + fake claude | Any listed variable reaches the fake, `FAKE_PARENT_VAR` is lost, or the constant differs. |
| AC-07 | Front matter parsing: `parseAgentFile` of a file whose front matter line 2 is `description: Validates: findings` → `invalid` starts with `front matter is not valid YAML: ` and contains `line 2`, no `description`/`tools`/`model`/`rules`, `body` = the text after the block; front matter `- a` → `invalid: "front matter is not a YAML mapping"`; an empty block and a file with no block → no `invalid`; a valid file → as v0.1.20 with no `invalid`. `agentFront` of the invalid file = `{invalid}` only; a 400-character parser message is cut to 300. `AgentReport` accepts `invalid` ≤ 300 and rejects 301. | unit | Any field present or absent the other way, or another text. |
| AC-08 | Roster: a runner (share `me`) with remote-backed repo `alpha` holding `.claude/agents/bad.md` (invalid) and `good.md`: its report has `bad` with `invalid` and a hash; `GET /v1/agents` has group `bad` with `invalid: true` and its version's `invalid` set; `good` has `invalid: false` and no version `invalid`. A catalog source whose push includes an invalid definition → `GET /v1/agents/resolve?key=<source>/bad` returns `invalid`. `mesh agents` prints the group line with `  invalid` and the version line `  <hash12>  invalid: <invalid>`. | World + CLI | The file is not reported, the flag is missing or set on `good`, or the lines differ. |
| AC-09 | Web Roster: a group whose version is invalid (seeded through the hub API) shows a `.roster-flag` with text `invalid` and `.roster-invalid` with text `invalid: <invalid>`; a valid group shows neither. | Playwright | Missing or extra flag or text. |
| AC-10 | Fail fast: a headless step with `agent: bad` (invalid front matter in the repo) is offered and accepted. The fake is never started (no calls file), and the step is `failed` with summary `headless run of <step> did not start: agent bad has invalid front matter: <invalid>`; no `agents.json` in the run dir. The same with a roster key whose pinned catalog text is invalid → summary `headless run of <step> did not start: roster agent <key> has invalid front matter: <invalid>`. Control: `agent: good` starts the fake. | World + fake claude | The fake starts, the run uses default settings, or another summary. |
| AC-11 | `redactSecrets`: every row of the examples table gives exactly that output and count; the RL-1 AC-13 cases other than `token: abcdef` (PEM, tokens, literals, order and count, marks) still pass unchanged. | unit | Any example's text or count differs, or prose is redacted. |
| AC-12 | `mesh preset ls`: in a git checkout with `.mesh/presets/hotfix.yaml` (`description: Quick fix`), `.mesh/presets/sdd-split.yaml` and an invalid `.mesh/presets/broken.yaml`, run from a subdirectory `sub/` → the built-in lines as before, then, sorted, `broken         invalid: <first line>  [../.mesh/presets/broken.yaml]`, `hotfix         Quick fix  [../.mesh/presets/hotfix.yaml]`, `sdd-split      <its description or ->  [../.mesh/presets/sdd-split.yaml]  (replaces the built-in)`; a nearer `sub/.mesh/presets/hotfix.yaml` replaces the root one in the list; exit 0. Without repo templates the output is exactly v0.1.20's. | CLI | A template missing, unsorted, a wrong path or suffix, the hint line shown with templates, or a non-zero exit. |
| AC-13 | Progress: `renderGoal` of a `done` goal with steps `done`, `skipped`, `skipped` and one `dropped` → `done · owner @<o> · 3/3 steps done`; a goal with `done`, `ready`, `skipped` → `2/3`; the existing snapshot (no skipped steps) is unchanged. The web goal page header of such a goal shows `3/3 steps done`. | unit (snapshot) + Playwright | Skipped not counted, dropped counted, or another text. |
| AC-14 | `mesh_done` reply: the session of a running headless run calls `mesh_done` (outcome done) in a remote-backed checkout worktree → the reply contains `mesh wrote the step record` and contains neither `git add` nor `commit`; offline (hub stopped) → the documented offline text without a commit hint. An interactive session's `mesh_done` reply still contains `Commit it with your work: git add`. | World (+ fake claude) | A commit hint in a headless reply, or the hint lost for interactive sessions. |
| AC-15 | Preset params: `instantiate(audit-relay, {repo, params: {agent, validator, filer}})` → audit `budget: {turns: 80, minutes: 60}` (numbers); with `turns: "40", minutes: "20"` → `{turns: 40, minutes: 20}`; `turns: "abc"`, `"0"`, `"501"`, `minutes: "1441"` → the documented error text; a repo preset with `budget: {turns: "{t}"}` and no `t` → `preset <name>: unknown parameter {t} in step <id>`; `parsePreset` reads `params: {t: 5}` as `{t: "5"}` and rejects `params: {T: 1}` and `params: [1]` with the documented text; `parsePreset(p.name, presetText(p))` deep-equals `p` for every built-in, and `presetText(audit-relay)` contains `params:`. `POST /v1/pulses` of `audit-relay` with `turns=abc` → 422 with the documented problem; with `turns=40,minutes=20`, `pulse fire` → the goal's `audit` step policy `budget` `{turns: 40, minutes: 20}`. | unit + World | Another default, a string budget in the plan, another text, or a broken round trip. |
| AC-16 | Docs: concepts, how-to, mesh skill, plan API table and RL-1's `redactSecrets` paragraph cover the Docs table; `MESH_SKILL` equals `skills/mesh/SKILL.md` and its "Headless runs" section says the step record is not committed; no team-, company- or person-specific name is added to code or docs. | review + skill test | A missing mention, a mismatch, or a specific name. |
| AC-17 | `package.json` version `0.1.21`; `pnpm check` passes (lint, typecheck, boundaries, test, build); `pnpm test:web` passes after `pnpm build`; `schemas/hub-api.openapi.json` matches `pnpm schemas` (the agent report schema has `invalid`); `src/daemon` still imports no `child_process`. | CI | Any check fails or the document differs. |

## Open questions

- 2026-11-12 **Pid matching is exact.** A tool call binds to a run only when the shim's parent pid
  equals the started pid. The native `claude` binary and the npm `#!/usr/bin/env node` launcher keep
  the pid (exec). A wrapper script that forks without `exec` would not match, and binding then falls
  back to the hooks. Matching descendants through `/proc` is left out (conservative, Linux-only).
- 2026-11-12 **Another daemon may still act on a run's hooks.** With user hooks pointing at another
  daemon, that daemon receives `X-Mesh-Step` and may try `POST /v1/steps/<step>/claim` with its own
  session. `MESH_STEP` stays in the run's environment because the RL-1 contract and the fake fixture
  use it. This row does not change hub claim rules. The run binds correctly on its own daemon, which
  was the reported failure.
- 2026-11-12 **Which variables are stripped.** Only the variables mesh code reads for terminal or
  session binding (`TMUX`, `TMUX_PANE`, `MESH_AUTOPILOT`, `CLAUDE_PID`). Others (`STY`, `ZELLIJ`, …)
  are not read by mesh and are passed through.
- 2026-11-12 **Redaction trade-off.** An unquoted colon value of letters only and under 20 characters
  (`password: correcthorse`) is no longer redacted. Quoted values, `=` assignments, values with a
  digit and long values still are. JSON-style `"token": "…"` stays unmatched, as before.
- 2026-11-12 **Progress counts.** Only the "steps done" text of `mesh show` and the web goal header
  changes. `LiveView` `done/total` (live bars) and the trail statistics keep counting `done` only.
- 2026-11-12 **Invalid roster agents at the hub.** The hub does not refuse a pulse or pin that
  resolves to an invalid catalog definition. The daemon refuses at start (AC-10). The roster shows
  the flag beforehand.
- 2026-11-12 **Trail files in headless runs** are still written into the run worktree (harmless,
  discarded). Only the hint is dropped. A `propose-via-branch` run pushes only what the agent
  committed, as before.
