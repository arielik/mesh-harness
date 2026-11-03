# S9: Session ids across /clear, /compact, resume and startup

Claude Code 2.1.314. Spike: `spikes/interactive.ts`.

## Results

| Action | Hooks | Session id | Pid |
|---|---|---|---|
| `/clear` | `SessionEnd(reason: clear)`, then `SessionStart(source: clear)` | **New** | Same |
| `/compact` | `SessionStart(source: compact)` | Same | Same |
| `/exit` | `SessionEnd(reason: prompt_input_exit)` | — | Process exits |
| `claude --resume <id>` | `SessionStart(source: resume)` | Same as resumed | **New** |
| Startup (first run, after a startup notice) | Two `SessionStart(source: startup)` events **with different ids and no SessionEnd between them** | New | Same |
| End of a `-p` run | `SessionEnd(reason: other)` | — | — |

## Decisions (plan §3.1, §3.4)

- **Rebind rule:** any `SessionStart` whose Claude pid already maps to a live `sid` rebinds the new session id to that `sid`, whatever the `source` and whether or not a SessionEnd preceded it.
- **Resume:** a new pid with `source: resume` and a session id already known to the daemon rebinds to that id's `sid`, even across a restart of the daemon, because session ids are stored.
- Claims pause only on `SessionEnd` with reason `prompt_input_exit`/`logout`/`other` after the grace period, or when the pid leaves `agents --json`. They never pause on `clear`.
