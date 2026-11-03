# S4: Background sessions (`--bg`) from a non-TTY process

Claude Code 2.1.317. Spike: `spikes/background.ts`.

## Results

| Case | Result |
|---|---|
| `claude --bg --name … --settings F "<prompt>"` from a script (no TTY) | Works. It prints `backgrounded · <short id> · <name>` on stdout and `Starting background service…` on stderr. `agents --json` state goes `working/busy` → `done/idle`. |
| Hooks from `--settings` in a background session | Fire normally (SessionStart, UserPromptSubmit, Stop). |
| `claude --resume <sessionId> --bg "<msg>"` while the idle session's process is still alive | **Starts a copy** with a new id ("already running in the background, so this started a copy"). The copy did **not** carry our `--settings`, so no hooks fired. ✗ |
| `claude stop <id>`, then `claude --resume <sessionId> --bg "<msg>"` | **Wakes the same session in place** with the same short id and session id, "with its saved options (--name, --permission-mode, --settings, --model)". The hooks fired and the message was answered. ✓ |
| `claude logs <id>` | Raw terminal output with ANSI escapes. Not a usable interface. |
| `agents --json` after `claude stop` | The entry stays, with `state: done` and no `pid`/`status`. |

## Decisions (plan §6.4)

- Delivery path 3 changes. For an idle background session (`state: done`, `status: idle`, no `waitingFor`), run `claude stop <id>` and then `claude --resume <sessionId> --bg "<text>"`. Never `--resume --bg` a session whose process is alive.
- Do not use `claude logs`.
- Cleanup in tests: `claude stop` and then `claude rm`.
