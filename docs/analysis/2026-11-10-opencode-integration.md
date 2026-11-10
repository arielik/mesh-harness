# OpenCode integration: OpenCode sessions in mesh

Status: **built** (2026-11-10), not yet released. Phase 1 (verify) ran on a machine with
OpenCode 2.2.4. Phases 2, 4 and 5 are built and tested. Phase 3 (the hub) needed no migration. The
version is still 0.1.5; release this as v0.2.0, because it changes the session model.

The verification changed the design. The installed OpenCode is **v2**, not the V1 herdr built for.
v2 has a new plugin API, and by default it runs one **shared background server** for all
terminals. "Verified facts" lists what was checked; "Design as built" lists where the build differs
from the proposal.

## Why

People run some of their agent sessions in OpenCode, not Claude Code. Before this change, mesh saw
only Claude Code sessions:
- OpenCode sessions didn't appear in the list, the dashboard or the hub;
- they couldn't hold a goal step.

The goal: an OpenCode session behaves like a Claude Code session in mesh. It shows its state
(working, needs you, idle, ended), and it can claim and finish a step.

## Goals and non-goals

Goals (all met):
- OpenCode sessions in `mesh`, `mesh ls`, the hub and the dashboard, labelled by agent;
- the same states, including **needs you** for permission and question prompts;
- `mesh run --agent opencode … --step G1.x`, with the step tools over MCP;
- `mesh setup --agent opencode` that installs, checks (`mesh doctor`) and uninstalls cleanly,
  leaving OpenCode's config exactly as it was.

Non-goals (for now):
- workflow capture (subagent programmes) for OpenCode;
- other agents (Codex, Cursor, …). The `agent` field added here should make them easier later.

The proposal also listed shared OpenCode servers (`serve`, `attach`) as a non-goal. In v2 the shared
server is the default, so the build supports it (see "Shared and private servers").

## Verified facts (OpenCode 2.2.4, macOS, Homebrew `opencode-v2`)

| Question | Answer |
|---|---|
| Version | `opencode v2.2.4`. This is the v2 line, not beta. The V1 hook names (`tool.execute.before`, `chat.message`) don't exist in it. |
| Process model | By default the TUI connects to a **shared background service** (`opencode service status`; the desktop app runs it as `opencode-cli serve --service`). `opencode --standalone` starts a **private server** instead: `opencode serve --stdio --port 0`, a child of the TUI process, which inherits the terminal's environment (`TMUX_PANE`, `MESH_STEP`). |
| Config folder | `~/.config/opencode` (`opencode debug paths`). `OPENCODE_CONFIG_DIR` **replaces** it. `opencode.json` is JSONC: comments parse. |
| Plugins | Every `.js`/`.ts` file in `<config>/plugins/` loads at server start, with no config entry needed. A plugin is `export default { id, setup(ctx) }`. `@opencode/plugin`'s `Plugin.define` only adds types. |
| Plugin context | `ctx.app`, `location`, `event`, `session`, `mcp`, `skill`, `tool`, `command`, `permission`, `rpc` and more. `ctx.event.subscribe()` returns an **async iterable** of every server event. `ctx.mcp.transform(d => d.set(name, config))` **adds an MCP server from code**. `ctx.session.prompt({ sessionID, text, delivery: "queue" })` queues a prompt. |
| Event envelope | `{ id, created, type, location: { directory }, data }`. Session events carry `data.sessionID`. A subagent's `session.created` carries `data.parentID`. |
| MCP server process | One per OpenCode **server**, shared by all its sessions. Its parent pid is the server (`serve --stdio` or the service), never the TUI. Each `tools/call` carries **`params._meta["ai.opencode/sessionID"]`**, so no pid mapping is needed. |
| Initial prompt | `opencode --prompt "<text>"` submits it at start. The TUI has no `--model` and no session-name flag (`opencode run` has `--model`). |
| Resume | `opencode --session <id>`, `opencode -c`. |
| Skills | Read from `<config>/skills/<name>/SKILL.md` **and from `~/.claude/skills`**. Skills are keyed by name, so two copies don't duplicate. |
| Storage | One SQLite database, `~/.local/share/opencode/opencode.db` (no JSON files). There is also an HTTP API (`opencode api GET /openapi.json`, event stream at `/api/event`). |
| Shared-server auth | `opencode serve` prints a generated password, and clients need it (`OPENCODE_SERVER_PASSWORD`). |

### Events (recorded, `test/fixtures/opencode/events/session.jsonl`)

One recorded session covers a turn, an MCP tool call, a file write, a question form, a subagent,
two permission prompts (the subagent's and the root's), the end of the turn and the exit. Streaming
deltas are dropped. The mapping:

| OpenCode event | mesh event | State |
|---|---|---|
| `session.created` (root) | SessionStart | idle |
| `session.execution.started` (root) | UserPromptSubmit, with the prompt's length from the preceding `session.inbox.enqueued` | working |
| `permission.asked` (root or child) | Notification `permission_prompt` | needs you: permission |
| `form.created` (root or child; the question tool) | Notification `question`, with `fields[0].title` | needs you: question |
| `permission.replied`, `form.replied`, `form.cancelled` | **Resume** (new) | working |
| `session.execution.succeeded` (root) | Stop, with the last `session.text.ended` text | idle (the "done: …" line) |
| `session.execution.interrupted` (root) | Stop | idle |
| `session.execution.failed` (root) | Notification `agent_error`, "error: …" | needs you: input |
| `session.deleted` (root) | SessionEnd `deleted` | ended |
| `location.shutdown` | SessionEnd for every session of that server (and folder) | ended |

Not seen, and not used: `session.idle` and `session.status`. v2 reports turns as `execution.*`.
Subagent sessions: the plugin maps each child to its root. It forwards only a child's
permission and question events, against the root. This matches how mesh folds Claude subagents.

## Design as built

### 1. Session model

- `Session.agent?: "claude" | "opencode"`. Absent means Claude Code, so older records need no
  migration.
- `claudeSessionIds` keeps its name and now holds OpenCode `ses_…` ids too. The rename to
  `agentSessionIds` touched the hub stores, Postgres JSON and many tests for no behaviour, so it
  was dropped. The field's doc comment says what it holds.
- `Session.pluginVersion`: the OpenCode plugin version that reported the session (like
  `hooksVersion`).
- `LaunchRequest.agent`, so a `mesh run` placeholder knows it waits for OpenCode.
- Hub: sessions are stored as JSON (`hsession.value`), so `agent` reaches the hub without
  **migration 4**. The goal view's `holders` carry `agent`, and the dashboard shows "(opencode)"
  next to the holder.
- `mesh ls` marks OpenCode rows `[oc]`; the TUI marks them `·oc`.

### 2. Event intake: one plugin

`mesh setup --agent opencode` writes `<config>/plugins/mesh-harness.js` (`src/opencode/plugin.ts`).
The file is managed and overwritten on update. It starts with a marker line and carries
`MESH_OPENCODE_PLUGIN_VERSION=1` (`OPENCODE_PLUGIN_VERSION`). The plugin:
- subscribes to `ctx.event.subscribe()` and POSTs the events above to
  **`/mesh/agent-event/opencode`** (`OpenCodeEvent` in `src/protocol/opencode.ts`);
- reads the daemon's port and key from the daemon config on each request, so a new key needs no
  reinstall;
- sends the prompt's **length**, never its text. It sends the turn's last assistant text (capped at
  2000 characters), the first question of a form, and the model as `provider/model`;
- keeps requests in order, with a 2 s timeout each, and never throws into OpenCode;
- **registers the mesh MCP server itself** (`ctx.mcp.transform`). `opencode.json` is never edited;
- **delivers mesh messages**: from the reply to an event, and from a poll of
  `/mesh/agent-poll/opencode` every 5 s for its root sessions. Each message goes in as
  `ctx.session.prompt({ …, delivery: "queue" })`. The next `execution.started` is flagged
  `delivered`, so it isn't counted as a human prompt.

The daemon maps the plugin's events to the same internal `HookEvent`, so `session-state.ts` stays
shared. It adds:
- `Resume` (an `EventKind`, not a hook kind, so the Claude installer never installs it);
- the `question` and `agent_error` notification types.

### 3. Shared and private servers

The state is per OpenCode session id, not per terminal, so a shared server reports correct state.
What a shared server can't know is the terminal:
- **Private server** (`argv` has `--stdio`): the plugin sends `$TMUX_PANE`, `$TMUX`, `$MESH_STEP`
  and `$MESH_AUTOPILOT`. These are that terminal's, so jump, the launch placeholder and step binding
  work.
- **Shared server** (the service, the desktop app, `opencode serve`): no pane and no mesh variables.
  The service may have been started from any shell, so its environment says nothing about a
  session.
- **Never bind by pid.** Claude sessions are bound by their Claude pid (/clear). An OpenCode server
  hosts many sessions, so OpenCode events skip that rule, and a Claude pid never matches an
  OpenCode session.
- **End of a server**: `location.shutdown` ends that server's sessions, and for a shared server
  only those in that folder. A server killed without it is caught by the tick: an OpenCode session
  whose server pid is gone ends with "process exited" (`deps.alive`).

`mesh run --agent opencode` therefore starts `opencode --standalone [--prompt P]`: one private
server per window.

### 4. Step tools

- The plugin registers `mesh` as a local MCP server running `mesh mcp` (the same shim as Claude).
- The shim reads `_meta["ai.opencode/sessionID"]` from each call and forwards it as
  `ToolCall.agentSessionId`. The daemon finds the session by that id. A pid lookup never returns an
  OpenCode session.
- Instructions: the mesh skill is written to `<config>/skills/mesh/SKILL.md`. OpenCode reads
  `~/.claude/skills` too, and keys skills by name, so a Claude setup's copy is harmless.
- Pre-existing bug fixed on the way: `mesh run --step` windows (Claude and OpenCode) never bound
  their step to the session at the hub. The placeholder already carried the step, and the first
  SessionStart only bound a *different* step. So the hub showed the step as "no session", and
  approve, revise and replan messages never reached the session. The daemon now binds once per
  session and step.

### 5. Doctor and uninstall

- `mesh doctor` checks the OpenCode version (≥ 2.2.4), whether the plugin is present and current,
  and the skill. It also reports live OpenCode sessions whose plugin is older (`oldPlugin` in
  `/local/status`). With only OpenCode set up, it skips the Claude checks instead of failing them.
- `mesh setup --agent opencode --uninstall` removes the plugin and the skill, and the folders mesh
  created for them. `mesh setup --uninstall` with no `--agent` removes both agents' setups. OpenCode's
  own files are never touched. A `mesh-harness.js` or `SKILL.md` that mesh didn't write is left
  alone.
- `src/opencode` is a new adapter module (it may import `protocol` and `claude`, for the process
  runner), enforced by `.dependency-cruiser.cjs`.

## Tests

- `src/protocol/opencode.test.ts`: the mapping.
- `src/core/session-state.test.ts`: no pid binding, `Resume`, question and error, launch adoption.
- `src/opencode/installer.test.ts`: install, refresh, foreign file, byte-identical uninstall.
- `test/opencode.test.ts`: the recorded fixture replayed through **the real generated plugin**
  into a real daemon over HTTP. It also covers a shared server, delivery through the plugin, a dead
  server, the MCP shim with `_meta`, and step binding against a real hub.
- `test/cli.test.ts`: `setup --agent opencode|all`, uninstall, doctor, and `run --agent opencode`
  with real tmux and a fake `opencode`.

Checked by hand with OpenCode 2.2.4, with isolated config folders and a Solo hub:
- guide step F with OpenCode: the design session ran `mesh_context` and `mesh_plan`; after approval,
  an `impl` step session did the work, called `mesh_done` and committed its step record;
- `mesh say` into an idle OpenCode session;
- exit, and a shared server (`opencode serve` + `opencode --server`) with no pane, ending on
  shutdown.

## Limits and open questions

- **Plugins load at server start.** A running OpenCode, or the desktop app's service, joins mesh
  only after a restart (`opencode service restart`). `mesh setup` says so.
- **One TUI, several sessions.** A private server's TUI can switch sessions (`/new`, the session
  list). Each OpenCode session is its own mesh session on the same pane. Claude's /clear keeps one
  mesh session instead.
- **Shared servers have no pane**: no `mesh jump`, and no step from `$MESH_STEP`. `mesh run` avoids
  this with `--standalone`.
- **Step policy `forbid`** becomes Claude Code deny rules. For OpenCode, `mesh run` only warns.
  Possible later: a `permission` rule through the plugin (`ctx.permission`).
- **`--model` and `--add-dir`** have no OpenCode TUI equivalent; `mesh run` warns.
- **Discovery without the plugin** (sessions started before setup, from `opencode.db`): not built.
  Sessions must start after setup.
- **`session.execution.failed` → needs you (input)** with "error: …". A distinct state remains an
  option if people want to tell errors from questions.
- **Model and cost**: the model is recorded as `provider/model`. The ledger doesn't yet separate
  providers.
- **The MCP command** is `[node, mesh's main.mjs, "mcp"]`, as for Claude. Moving mesh or node makes
  the plugin outdated, and `mesh doctor` says to re-run setup.

## Reproducing the verification

```bash
opencode --version
opencode debug paths
OPENCODE_CONFIG_DIR=/tmp/oc-probe opencode --standalone   # with a logging plugin in /tmp/oc-probe/plugins
```

To re-record the fixture, use a plugin that appends every `ctx.event.subscribe()` event to a
file, run one session with a tool, an MCP call, a question, a subagent and a permission prompt
(`"permission": { "shell": "ask" }`), then exit. Drop `*.delta`, `step.streamed` and
`tool.progress` events. Scrub the folder paths, user names and session titles. Keep this repo
generic: no host, team or company names in fixtures.
