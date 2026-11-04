# Install

Requirements: Claude Code (2.1.314 or later), Node 22.13+ or 24, `curl`, and tmux for `mesh run`, jump and paste delivery.

```bash
pnpm install && pnpm build
alias mesh="node $PWD/dist/main.mjs"

mesh setup      # writes ~/.config/mesh/daemon.json, adds 7 hooks to ~/.claude/settings.json,
                # registers the mesh MCP server and a short block in ~/.claude/CLAUDE.md
mesh up         # the daemon; or `mesh up --install` and run the printed command to keep it running
mesh doctor     # checks claude, curl, tmux, hooks, MCP, daemon and hub
mesh status     # Solo, team hub, or "hub offline, working locally"
```

You are now in **Solo** mode: goals, plans, steps and records work on a local hub inside the daemon. The CLI uses it automatically. Its web dashboard is at the URL `mesh status` prints.

To join a team hub:

```bash
mesh login --hub https://mesh.example --token <token>   # or --provider kanidm (OIDC in the browser)
mesh logout                                             # back to Solo
```

Uninstall: `mesh setup --uninstall` restores your settings file byte for byte and removes the MCP server and the CLAUDE.md block.

## Hooks

| Hook | Kind | Why |
|---|---|---|
| `SessionStart`, `UserPromptSubmit`, `Notification`, `SessionEnd` | async `curl` | session state, model, human prompts (never their text) |
| `Stop` | HTTP, 3 s timeout | turn end, effort and permission mode, and the moment mesh can hand the agent a queued message |
| `SubagentStart`, `SubagentStop` | async `curl` | workflow programmes: role, timing, Claude Code's own record of each subagent |

All hooks call `127.0.0.1` only. A daemon that is not running costs nothing; the `Stop` hook gets "connection refused" at once.

## After upgrading Claude Code

```bash
pnpm test:claude   # re-checks every Claude Code behaviour mesh relies on (haiku, about a minute)
```
