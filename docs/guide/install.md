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

On a team hub, the daemon always reports a session in full while it holds a mesh step, and how many sessions the machine has in each state. What else it reports depends on the machine's share level (`shareSessions` in `daemon.json`):

| Level | What the daemon sends | Who sees a session without a step |
|---|---|---|
| `steps` | step holders, counts and the level; no repo inventory | nobody (it stays on your machine) |
| `me` (default for new setups) | also the sessions without a step, as metadata, and the repo inventory | only you (Mine page, `mesh machines`) |
| `all` | the same as `me` | the whole team (Live page, `GET /v1/live`) |

A session holding a step is visible to everyone whatever the level. Admins see other people's `me` sessions only as counts.

```sh
mesh setup --share-sessions me      # the default for new setups; restart the daemon
mesh setup --share-sessions all     # show them to the team
mesh setup --share-sessions steps   # report step holders only
```

`--share` is an alias of `--share-sessions`. An existing `daemon.json` keeps its level (one without the field means `steps`) until you give one.

A session without a step is reported as metadata only: its state and what it is waiting for, repo name, session name, its labels, its accept override (if any), agent, autopilot level, turn counts and timestamps. Its folder, tmux pane, process, transcript and message text stay local. If you switch back to `steps`, those sessions leave the Live page, the Mine page and `GET /v1/live` at the daemon's next sync. The same happens when a session finishes or releases its step. The hub keeps its last record of the session, without showing it, so it can still deliver messages to it (hub v0.1.9 and later; older hubs keep showing the last record).

The repo inventory (`me` and `all`) is the ids and names of the git checkouts under `workspaceRoots` (two folder levels deep) and of the current sessions' repos, never a path. The daemon rescans at most every 5 minutes and sends the list only when it changes. Under `steps` it sends an empty inventory, which clears one stored earlier.

Every sync also carries the machine's **accept policy** (`accept` in `daemon.json`, below), so the hub can decide when an offer is made whether it is taken automatically. `assignments` stays on the machine.

Upgrading: upgrade every hub replica to v0.1.10 before the daemons. A `me` daemon sends its sessions without a step only after its hub confirmed (in the sync reply) that it applies the visibility rule; until then it sends step holders only and logs `the hub does not support share level me; sending step holders only`. A v0.1.7 to v0.1.9 daemon set to `all` reports no share level, so its sessions without a step are shown to their owner only until it is updated.

## Offers: `accept`, `assignments` and `maxSessions`

These fields of `daemon.json` say what happens when someone offers this machine work (`mesh assign`, see [Offers and accept policy](concepts.md#offers-and-accept-policy)):

| Field | Values | Default |
|---|---|---|
| `accept` | whose offers are accepted automatically: a list of rules `self` (your own offers), `user:<id>`, `machine:<nickname or id>`, or `["off"]` alone | `["self"]` |
| `assignments` | what the daemon does with an offer: `deliver` (accept an automatic offer for an idle session in the repo, else list it for you), `launch` (as `deliver`, but start a session with `mesh run <repo> --step <step> --no-tui` when none is idle), `off` (decline every offer) | `deliver` |
| `maxSessions` | under `assignments: launch`: an offer starts a session only while fewer than this many sessions are live on the machine (non-ended sessions, plus sessions launched for an offer in the last two minutes that have not shown up yet); otherwise the offer is listed for you. A whole number from 1 to 1000. It does not limit `mesh run`, `mesh accept --launch` or sessions you start yourself | absent (no limit) |

```sh
mesh setup --accept self,user:bob    # or: --accept off; restart the daemon
mesh setup --assignments launch      # deliver, launch or off
mesh setup --max-sessions 4          # or: --max-sessions off (no limit); restart the daemon
```

A `daemon.json` without these fields works as before (the defaults). The hub sees `accept` (synced with the machine facts), not `assignments` or `maxSessions`.

## Headless runs

A daemon (mesh 0.1.15 or later) with at least one `workspaceRoots` entry runs headless steps
offered to it (see [Headless steps](concepts.md#headless-steps)); it tells the hub so on every
sync.

- **`MESH_CLAUDE_BIN`**: the Claude Code executable headless runs start (default `claude` on the
  daemon's `PATH`). Set it in the daemon's environment (the service unit) when `claude` lives
  elsewhere.
- **Runs directory**: `<stateDir>/runs/` (Linux: `~/.local/state/mesh/runs/`), one folder per run
  with its run file and logs. mesh never deletes them; remove old ones by hand.
- A run counts toward `maxSessions`; at the cap it is queued.

On the hub, `artifacts` in `mesh-hub.yaml` sets the limits of hub-stored artifacts:

```yaml
artifacts:
  max_bytes: 1048576     # per artifact (default 1 MiB)
  per_round: 10          # per step round (default 10)
  retention_days: 365    # content of done/dropped goals' artifacts is pruned after this; 0 keeps it
```

The daemon accepts local request bodies up to 4 MiB, so a `max_bytes` above about 4 MiB is limited
by the daemon, not the hub.

`calibration` sets when the hub opens a calibration goal for an agent (v0.1.20):

```yaml
calibration:
  threshold: 5           # uncalibrated dismissals of one agent hash that open a calibration goal (whole number ≥ 1)
```

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
