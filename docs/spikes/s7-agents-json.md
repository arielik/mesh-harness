# S7: `claude agents --json` as the status authority

Claude Code 2.1.314 and 2.1.317. Fixtures: `test/fixtures/claude/agents/*.json`.

## Results

- **Interactive sessions are listed** ✓, with `pid`, `cwd`, `kind: "interactive"`, `startedAt`, `sessionId`, `name` and `status`. A session leaves the list when its process exits.
- **`status` tracks the session:**

  | Situation | `status` / `waitingFor` |
  |---|---|
  | Turn running | `busy` |
  | Turn ended | `idle` |
  | Permission dialog | `waiting` / `permission prompt` (from the first sample, before the Notification hook) |
  | Startup notice dialog | `waiting` / `dialog open` |
  | After Esc interrupted a turn (no Stop hook) | `idle` |

- **A question asked in plain text** ("Is your favourite colour blue?") gives `status: idle` with no `waitingFor`. Only `Stop.last_assistant_message` tells it apart from a finished turn.
- **`sessionId` follows `/clear`:** it shows the new id on the same pid.
- **Background entries** add `id` (short id) and `state` (`working`, `done`, …). After `claude stop` they stay listed without `pid`/`status`.
- **Cost:** `claude agents --json --all` takes about 0.12 s wall time. Polling every 5 s is fine.

## Decisions (plan §3.3)

- The reconciler is the authority for `busy`/`waiting`/`idle` and `waitingFor`. Hook-only rules remain as a fallback.
- `needs_you(question)`: `idle` and the last `Stop.last_assistant_message` ends with a question (trimmed text ends in `?`), or `mesh_ask` was called during the turn.
- `waitingFor: "dialog open"` during startup with no SessionStart seen counts as **needs_you(dialog)**. This covers the workspace-trust dialog (see README, "Trust").
