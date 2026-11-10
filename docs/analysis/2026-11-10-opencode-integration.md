# OpenCode integration: OpenCode sessions in mesh

Status: proposed (2026-11-10). Nothing is built yet. Resume from a machine where OpenCode is
installed, because the first task is to check the OpenCode facts below against a real install.

## Why

People run some of their agent sessions in OpenCode, not Claude Code. Today mesh sees only Claude
Code sessions:
- OpenCode sessions don't appear in the list, the dashboard or the hub;
- they can't hold a goal step.

The goal: an OpenCode session behaves like a Claude Code session in mesh. It shows its state
(working, needs you, idle, ended), and it can claim and finish a step.

## Goals and non-goals

Goals:
- OpenCode sessions in `mesh`, `mesh status`, the hub and the dashboard, labelled by agent;
- the same states, including **needs you** for permission and question prompts;
- `mesh run --agent opencode … --step G1.x`, with the step tools over MCP;
- `mesh setup --agent opencode` that installs, checks (`mesh doctor`) and uninstalls cleanly,
  leaving OpenCode's config exactly as it was.

Non-goals (for now):
- workflow capture (subagent programmes) for OpenCode;
- OpenCode servers shared by several terminals (`opencode serve` / `attach`), beyond not reporting
  wrong state for them;
- other agents (Codex, Cursor, …). The `agent` field added here should make them easier later.

## How mesh is tied to Claude Code today

| Part | Claude Code mechanism | Code |
|---|---|---|
| State events | Hooks in `settings.json` POST to the daemon at `/mesh/hook/<slug>` | `src/claude/installer.ts`, `src/protocol/hooks.ts` (`HookInput`, `toHookEvent`), `src/daemon/daemon.ts` (~l.600, ~l.807) |
| State machine | Hook kinds become session states | `src/core/session-state.ts` |
| Step tools | The `mesh mcp` stdio shim sends its **parent pid**. The daemon maps that pid to the session | `src/mcp/shim.ts`, `src/daemon/tools.ts` |
| Instructions | The `mesh` skill | `src/claude/skill.ts` |
| Discovery and reconcile | `claude agents --json`, transcripts, `transcriptGuess` | `src/claude/agents.ts`, `src/protocol/agents.ts` |
| Launch | `mesh run` starts `claude <prompt> -n <name>` in tmux | `src/cli/mesh-commands.ts` (~l.364–380), `src/mux/` |
| Session model | `Session.claudeSessionIds`, `pid`, `pane`, `tmuxSocket` | `src/protocol/session.ts` |

The rest doesn't depend on Claude Code: goals, plans, steps, claims, the hub, hub-link and the
dashboard. They need only an agent label.

## OpenCode equivalents (verify each first)

Most of these come from herdr's OpenCode integration (`../herdr`,
`src/integration/assets/opencode/herdr-agent-state.js`, integration version 13, and
`docs/next/website/src/content/docs/integrations.mdx`). Check each on the real install before
building on it.

| Part | OpenCode mechanism |
|---|---|
| State events | A JS plugin in `~/.config/opencode/plugins/<name>.js`. It exports `{ id, server }` (V1), where `server` returns handlers `{ "chat.message", event }` |
| Step tools | A local MCP server in `opencode.json`: `"mcp": { "mesh": { "type": "local", "command": ["mesh", "mcp"] } }` |
| Instructions | `AGENTS.md`, or `instructions` in `opencode.json`. Check whether OpenCode also reads skills |
| Session id | Each event carries `properties.sessionID`. Child (subagent) sessions have `info.parentID` |
| Resume | `opencode --session <id>`, `opencode -c` |
| Launch with a prompt | **unknown**: find the flag that starts the TUI with an initial prompt (`--prompt`?) |
| Discovery without the plugin | **unknown**: OpenCode's local session storage (JSON files under `~/.local/share/opencode/storage/`, or a SQLite db in newer versions) |

### Event mapping (from herdr)

| OpenCode event | mesh hook kind or state |
|---|---|
| `session.created`, or the first event for a new root session | SessionStart |
| `chat.message` (root session) | UserPromptSubmit → working |
| `session.status` busy, retry, running | working |
| `tool.execute.before/after`, `permission.replied`, `question.replied`, `question.rejected`, `session.compacted` | working |
| `permission.asked` | Notification, needs = permission |
| `question.asked` | Notification, needs = question |
| `session.error` | needs you (check whether mesh wants a distinct state) |
| `session.idle`, or `session.status` idle | Stop. Fetch the last assistant message through the plugin's client for "done: …" |
| `session.deleted`, process exit | SessionEnd |

Child sessions: record `childID → parentID`. Report a child's permission or question events
against the root, and ignore its other events. This matches mesh's subagent folding.

### What herdr learned (avoid repeating it)

- **V1 vs V2.** herdr supports V1 ≥ 1.18.29 and V2 beta. In V2, state is reported by a **TUI
  plugin** (registered in `tui.jsonc` for V1, `cli.json` for V2) that runs once per terminal,
  because the server can't tell which terminal a session is in.
- **Shared servers.** In `serve`, `web` and `attach`, the server-side plugin must stay silent
  (herdr's `ownsLocalLifecycle()`). Otherwise a stale server overwrites the pane's real state.
- **The plugin only loads at startup.** Running sessions join only after they exit and are
  resumed.
- **Upkeep.** herdr's plugin is at version 13. Version our plugin like `HOOKS_VERSION`, so
  `mesh doctor` flags old plugins.

## Design

### 1. Session model: an agent field

- `Session.agent: "claude" | "opencode"`, defaulting to `"claude"` when parsing older state.
- Rename `claudeSessionIds` to a generic `agentSessionIds`. Keep the old name readable, and
  migrate the daemon state file and hub rows where they store it.
- The hub sync (`src/daemon/hub-link.ts`), the hub tables and the dashboard carry `agent`. Hub
  migration 4 adds the column.
- List and dashboard: a small agent marker per row.

### 2. Event intake: the plugin

- `mesh setup --agent opencode` writes `~/.config/opencode/plugins/mesh.js`, managed and
  overwritten on update, with a header like herdr's (`MESH_INTEGRATION_VERSION=N`).
- The plugin reads the daemon's port and key from the daemon config (the same file
  `src/mcp/shim.ts` reads). It POSTs to a **new** endpoint `/mesh/agent-event/opencode`, carrying
  `{ event, sessionID, parentID?, cwd, pid: process.pid, pane: $TMUX_PANE, tmux: $TMUX, step:
  $MESH_STEP, autopilot: $MESH_AUTOPILOT, at, pluginVersion }`.
  - Use a separate endpoint rather than faking Claude `HookInput`. The daemon maps it to the same
    internal `HookEvent`, so `session-state.ts` stays shared.
  - Never send prompt text. Send only its length, as the hooks do.
- Keep requests in order, give each a short timeout, and never throw into OpenCode. A daemon
  that is down must not slow the agent.
- The plugin is silent unless it owns the terminal (herdr's rule above).
- Build V1 first if the installed version is V1. V2 needs the TUI plugin variant.

### 3. Step tools: MCP

- `mesh setup --agent opencode` adds the `mesh` MCP entry to `~/.config/opencode/opencode.json`,
  merging and keeping comments. Check whether the file is JSONC.
- The pid lookup carries over: the MCP shim's parent pid is the OpenCode process. One OpenCode
  process can **switch** between sessions in the TUI, so the daemon resolves pid → the session
  that process reported most recently. Verify the parent pid really is the OpenCode process (and
  not a bun or worker child).
- Instructions: the skill text goes into a managed instructions file, referenced from
  `opencode.json`. Don't edit the user's `AGENTS.md`.

### 4. Launch: `mesh run --agent opencode`

- The argv builder in `mesh-commands.ts` gets an OpenCode variant: `opencode [prompt flag] …`,
  with `MESH_STEP` and `MESH_AUTOPILOT` in the environment and the window in the same tmux
  session.
- The `launching` placeholder and adoption (v0.1.1) work unchanged once the first plugin event
  arrives from that pane. Check whether OpenCode has a first-run or trust prompt that the
  placeholder should read.
- The default agent comes from `--agent`, else a config value, else `claude`.

### 5. Doctor and uninstall

- `mesh doctor`: is the OpenCode version supported? Is the plugin present at the current version?
  Is the MCP entry there? Are there live OpenCode sessions whose plugin version is old?
- `mesh setup --agent opencode --uninstall`: remove the plugin file and the MCP and instructions
  entries, and leave everything else byte-identical. Test this like `installer.test.ts`.

## Phases

1. **Verify** on the OpenCode machine (half a day). Record the answers here:
   - the version, V1 or V2;
   - the config directory and whether `opencode.json` is JSONC;
   - the plugin API shape (do herdr's handlers fire?);
   - the MCP shim's parent pid;
   - the initial-prompt flag;
   - the storage layout.

   Capture a fixture set: install a throwaway logging plugin that appends every event to a file,
   and run a short session that uses a tool, a permission, a question, a subagent and an idle
   (`test/fixtures/opencode/events/`). The Claude hook fixtures came from spikes S2/S3 the same
   way.
2. **Watch**: the agent field, the plugin, `/mesh/agent-event/opencode`, the mapping, the list and
   status labels. Tests replay the recorded fixtures through the daemon. Release as v0.2.0 (it
   changes the session model).
3. **Hub**: migration 4 (`agent` column), hub-link, the dashboard marker.
4. **Steps**: MCP setup, instructions, `mesh run --agent opencode`, and an end-to-end step in a
   scratch repo (guide step F with OpenCode).
5. **Doctor and uninstall**, plus guide pages (`docs/guide/install.md`, `howto.md`, and an
   OpenCode note in `first-run.md`).

## Open questions

- V2's TUI-plugin API: is it stable enough to support now, or should we use V1 only until V2
  leaves beta?
- Should `session.error` be **needs you** (herdr's "blocked"), or should it get its own state?
- Discovery without the plugin: is it worth listing OpenCode sessions that started before mesh
  (like "started before mesh setup" for Claude), or should sessions be required to restart?
- Model and cost fields: OpenCode can run non-Anthropic models. Do the ledger and metrics need the
  provider as well as the model?

## Resuming

On the OpenCode machine:

```bash
opencode --version
ls ~/.config/opencode ~/.local/share/opencode
git -C ~/vpc-devel/herdr pull   # reference plugin; re-read its OpenCode docs for changes
```

Then start phase 1. Keep this repo generic: no host, team or company names in fixtures. Scrub
the cwd paths and session titles in recorded events.
