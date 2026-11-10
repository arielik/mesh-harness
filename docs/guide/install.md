# Install

Requirements: Claude Code (2.1.314 or later) or OpenCode (2.2.4 or later, see [OpenCode](#opencode)), Node 22.13+ or 24, `curl`, and tmux for `mesh run`, jump and paste delivery.

```bash
curl -fsSL https://github.com/arielik/mesh-harness/releases/latest/download/install.sh | sh

mesh setup      # writes ~/.config/mesh/daemon.json, adds 7 hooks to ~/.claude/settings.json,
                # registers the mesh MCP server and installs the mesh skill (~/.claude/skills/mesh)
mesh up         # the daemon; or `mesh up --install` and run the printed command to keep it running
mesh doctor     # checks claude, curl, tmux, hooks, MCP, daemon and hub
mesh status     # Solo, team hub, or "hub offline, working locally"
```

You are now in **Solo** mode: goals, plans, steps and records work on a local hub inside the daemon. The CLI uses it automatically. Its web dashboard is at the URL `mesh status` prints.

The installer puts the package under `~/.local` with npm (the command is `~/.local/bin/mesh`; no sudo). Options, as environment variables: `MESH_VERSION=0.2.0` for a given release, `MESH_PREFIX` for another location, `MESH_PACKAGE=<file or URL>` to install a package you already have, `MESH_REPO` for a fork. Other ways in:

- `npm install -g mesh-harness`, once the package is published to npm (the release workflow does it when the repository has an `NPM_TOKEN` secret);
- from a clone: `pnpm install && pnpm build`, then `alias mesh="node $PWD/dist/main.mjs"`.

**Updating.** Run the installer again. When you already ran `mesh setup`, it refreshes the hooks, the skill and the MCP server, and restarts the daemon if it runs as a user service. Sessions that were open keep their old hooks until you restart them; `mesh doctor` lists how many.

To join a team hub:

```bash
mesh login --hub https://mesh.example --token <token>   # or --provider kanidm (OIDC in the browser; over SSH, paste the code it shows)
mesh logout                                             # back to Solo
```

## Installing a team hub

The hub is the same `mesh` binary (`mesh hub`). Pick how to run it:

- **One replica on SQLite** (the default). `mesh hub init` and `mesh hub --config mesh-hub.yaml` on any machine or VM, or the container image with the file in a volume. Back up with `mesh hub backup`.
- **Several replicas on Postgres**. Set `db:` (or `MESH_HUB_DB`) to a `postgres://` URL and run as many replicas as you like behind a load balancer. Use the container image built from the `Dockerfile`, and `deploy/kubernetes/` as a starting point. Back up with the database's own tools (`pg_dump`, snapshots).

A hub that started on SQLite moves to Postgres once with `mesh hub migrate`. Details in [operations](operations.md#running-the-hub).

Uninstall: `mesh setup --uninstall` restores your settings file byte for byte and removes the MCP server, the skill and, if you installed it, the OpenCode plugin. Then `npm uninstall -g --prefix ~/.local mesh-harness` removes the command.

## OpenCode

mesh tracks OpenCode sessions too (OpenCode v2, 2.2.4 or later):

```bash
mesh setup --agent opencode   # OpenCode only; --agent all for Claude Code and OpenCode
opencode service restart      # OpenCode loads plugins at start: restart open sessions and the desktop app too
mesh doctor                   # checks opencode, the plugin and the skill
```

This writes two files and edits none:
- the plugin `~/.config/opencode/plugins/mesh-harness.js`. It reports session state to the daemon, gives OpenCode the mesh MCP tools and hands sessions mesh's messages;
- the skill `~/.config/opencode/skills/mesh/SKILL.md`.

`OPENCODE_CONFIG_DIR` moves both. `mesh setup --agent opencode --uninstall` removes them; `opencode.json` is never touched. Like the hooks, the plugin never sends prompt text, only its length.

OpenCode sessions show in the list with `[oc]` (`mesh ls`) or `·oc` (the TUI). Sessions on the shared background server (the default `opencode`, and the desktop app) report their state but not their terminal, so `mesh jump` can't reach them. `mesh run --agent opencode` starts `opencode --standalone`: a private server per window, so mesh knows the pane, the step and the autopilot level.

## The mesh skill

`mesh setup` installs a Claude Code skill at `~/.claude/skills/mesh/SKILL.md`: how to work on a mesh step, which tools to call, how to ask your person. Claude loads it only when a session needs it, so sessions that don't use mesh carry nothing extra. The MCP server adds one always-on sentence pointing at it. `mesh skill` (or `mesh --skill`) prints the copy that matches your mesh; the same text is in [`skills/mesh/SKILL.md`](../../skills/mesh/SKILL.md). Older versions of mesh added a block to `~/.claude/CLAUDE.md` instead; `mesh setup` removes it. A skill named `mesh` that mesh did not write is left alone.

## Notifications

When a session needs you, mesh tells you. Choose how with `mesh setup --notify <mode>`:

| Mode | What you get |
|---|---|
| `desktop` (default) | the OS notification service (`notify-send` on Linux, Notification Center on macOS) |
| `terminal` | an OSC 9 notification written to the session's own terminal. Terminals that support OSC 9 (iTerm2, WezTerm, Ghostty, kitty, Windows Terminal and others) show it, also when the session runs on another machine over SSH. Inside tmux it needs `set -g allow-passthrough on` (tmux 3.3+). |
| `both` | both of the above |
| `off` | none |

## What the hub sees

On a team hub, the daemon reports a session in full only while it holds a mesh step. Other sessions stay on your machine; the hub sees how many of them are in each state. To let your team see those sessions too (on the Live page and in `GET /v1/live`), opt in on that machine:

```sh
mesh setup --share-sessions all     # and restart the daemon
mesh setup --share-sessions steps   # back to the default
```

With `all`, a session without a step is reported as metadata only: its state and what it is waiting for, repo name, session name, agent, autopilot level, turn counts and timestamps. Its folder, tmux pane, process, transcript and message text stay local. If you switch back to `steps`, the hub keeps the records it already has for those sessions but gets no further updates for them.

## Hooks

| Hook | Kind | Why |
|---|---|---|
| `SessionStart`, `UserPromptSubmit`, `Notification`, `SessionEnd` | async `curl` | session state, model, human prompts (never their text) |
| `Stop` | HTTP, 3 s timeout | turn end, effort and permission mode, and the moment mesh can hand the agent a queued message |

Each hook sends the version of the hook commands (`X-Mesh-Hooks`) and, for the async ones, the time it ran (`X-Mesh-At`, from `date +%s%N`; seconds only where `date` has no `%N`). Async hooks can arrive out of order; a hook that certainly ran before the one that set the session's current state updates counters but not the state. `mesh doctor` reports hooks written by an older mesh, and open sessions still sending them.
| `SubagentStart`, `SubagentStop` | async `curl` | workflow programmes: role, timing, Claude Code's own record of each subagent |

All hooks call `127.0.0.1` only. A daemon that is not running costs nothing; the `Stop` hook gets "connection refused" at once.

## After upgrading Claude Code

```bash
pnpm test:claude   # re-checks every Claude Code behaviour mesh relies on (haiku, about a minute)
```

## A hub behind a company or lab CA

Node.js checks TLS against its own bundled list and ignores the operating system's certificate store.
mesh adds the system store at start (Node 22.19+ or 24.5+), so a hub whose certificate chains to a CA
installed on the machine (for example in `/usr/local/share/ca-certificates/` and `update-ca-certificates`)
works for `mesh login`, the daemon and the MCP server, as it does for curl. On an older Node, point
`NODE_EXTRA_CA_CERTS` at the CA file instead. `MESH_SYSTEM_CA=off` turns the system store off.
