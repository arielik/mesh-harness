# M0 spikes

Spikes run real Claude Code on a subscription login (`claude auth status`: `claude.ai`, Max) with model `haiku`. They never modify `~/.claude/settings.json`: hooks and MCP are passed per session with `--settings` and `--mcp-config`, and tmux uses a private server (`tmux -L meshspike`).

Run them with `pnpm spike print|interactive|background` (set `MESH_SPIKE_TMP` to choose the scratch folder). Raw output goes to `spikes/out/` (gitignored). `node spikes/fixtures.ts <ver> <ver-bg>` refreshes `test/fixtures/claude/`.

| Spike | Question | Outcome | Doc |
|---|---|---|---|
| S1 | Stop HTTP hook delivers via `additionalContext`; dead or hung daemon cost | ✅ works; at most 3 s cost when hung, 0 when down | [s1](s1-stop-delivery.md) |
| S2/S3 | Payloads of the 5 hooks; Notification timing; async command hooks | ✅ fields confirmed; `idle_prompt` after about 60 s = idle | [s2-s3](s2-s3-hook-payloads.md) |
| S4 | `--bg` from a script; delivery to an idle background session | ✅ with change: `claude stop` then `--resume --bg` (in place); a plain `--resume --bg` forks | [s4](s4-background.md) |
| S6 | Bind hooks and MCP to a session by Claude pid | ✅ `$PPID` = `CLAUDE_PID` = MCP `ppid`; MCP's session-id env goes stale after `/clear` | [s6](s6-pid-binding.md) |
| S7 | `agents --json` lists interactive sessions with status | ✅ yes (`busy`/`waiting`/`idle`, `waitingFor`), about 0.12 s per call | [s7](s7-agents-json.md) |
| S8 | Bracketed paste vs an open dialog and an idle prompt | ✅ guard kept; paste + Enter submits at idle | [s8](s8-paste.md) |
| S9 | Session ids across `/clear`, `/compact`, resume and startup | ✅ rebind by pid; ids can change at startup without SessionEnd | [s9](s9-session-ids.md) |

The Kanidm/OIDC spike (old S5) is no longer in M0. It is part of task 2.8 (plan v2).

## Other findings

- **Trust.** For a new folder, Claude Code shows a trust dialog whose **default option is "No, exit"**, so pressing Enter quits. No hook fires before trust is accepted. `agents --json` shows `waiting / dialog open`. Consequences:
  - `mesh run` never sends keys at startup.
  - The TUI shows the window as **needs you: accept workspace trust** (see S7).
  - Background dispatch (`--bg`) requires a trusted folder.
- **Auto mode notice.** With no `--permission-mode`, this Claude Code version started in auto mode and showed a notice. Tests that need permission dialogs pass `--permission-mode default`.
- **Claude Code updated itself during the spikes** (2.1.314 → 2.1.317). Fixtures record their version. `pnpm test:claude` (task 4.3) reruns these spikes against new versions.
- `node:sqlite`, Node and toolchain: the repo pins Node 24 through `devEngines` (pnpm downloads it). dependency-cruiser does not support Node 23.

## Plan amendments

Applied to [the implementation plan](../plan/implementation-plan.md) as v2.1: §3.1, §3.3, §5.1, §5.2, §6.4, §7 and the risks table.

## M4 additions

- **`pnpm test:claude`** (`spikes/contract.ts`) re-checks every Claude Code behaviour mesh relies on. It covers the hooks (including `SubagentStart`/`SubagentStop`), `claude agents --json`, and the workflow files mesh reads (`journal.jsonl`, `agent-<id>.meta.json`, `workflows/<run>.json`). Green on 2.1.318.
  - Finding: print-mode `SessionStart` has no `model` field, as in M0. Subagent models come from the workflow files.
- **`pnpm spike e2e-offline`** runs a five-agent workflow programme four ways: no daemon, hub blackholed, hub restored mid-run, and Solo. Every run finished in 11–12 s with records of the same shape, and every agent reached the hub exactly once.
