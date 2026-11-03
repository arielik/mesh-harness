# S2/S3: Hook payloads and Notification timing

Claude Code 2.1.314 (print, interactive) and 2.1.317 (background). Fixtures: `test/fixtures/claude/hooks/*.json`, sanitized. The contract test is `test/claude-fixtures.test.ts`.

## Fields observed

| Hook | Fields mesh uses |
|---|---|
| All | `session_id`, `transcript_path`, `cwd`, `hook_event_name`. Interactive sessions also send `scratchpad_dir`. |
| `SessionStart` | `source` (`startup`, `resume`, `clear`, `compact`), sometimes `model` (for example `claude-haiku-5-5`) |
| `UserPromptSubmit` | `prompt` (**full text**), `prompt_id`, `permission_mode` |
| `Notification` | `notification_type`, `message` (for example "Claude needs your permission", "Claude is waiting for your input"), `prompt_id` |
| `Stop` | `stop_hook_active`, `last_assistant_message`, `background_tasks`, `session_crons`, `effort`, `prompt_id`, `permission_mode` |
| `SessionEnd` | `reason`: `clear`, `prompt_input_exit` (`/exit`), `other` (end of a `-p` run) |

## Notification timing (interactive, detached tmux)

- `permission_prompt` fired **about 5.5 s** after the dialog appeared.
- `idle_prompt` fired **about 60 s** after the turn ended, even with nobody attached. It also fired for a background session. It means idle, not needs-you, as the critic said.

## Async command hooks

`type: "command"` with `async: true` running `curl … -H "X-Claude-Pid: $PPID"` works for SessionStart, UserPromptSubmit, Notification and SessionEnd. The pid header was present on every one (fixture field `claudePidHeaderPresent`).

## Decisions

- The hook schemas (task 1.1) are loose and require only the four common fields plus the per-event fields above. Unknown fields are kept.
- **The daemon must never store `prompt`.** It counts characters and uses `prompt_id` only.
- `idle_prompt` maps to idle. `permission_prompt` is only a low-latency hint; the reconciler confirms it.
