# mesh-harness: overview

mesh gives a person and a team **one place to see and steer every Claude Code session**, and leaves a **ledger** in git of how the work went.

- **For you:** one list of all your sessions, ordered by what needs you. Jump to one, send it a message, or let autopilot nudge a stalled one.
- **For the team:** a shared backlog of goals. A design session proposes a plan of steps, a person approves it, and people (or their agents) take steps in parallel or continue each other's work.
- **For analysis:** every step, plan and goal leaves a generated record in the repo (`mesh.ledger.v1`). Workflow programmes are captured per subagent. `mesh ledger export` turns all of it into JSONL for any analysis tool (for example mesh-ai, or `jq`), to answer questions like "does this model need more fix cycles since the last harness change?".

## The pieces

| Piece | Where | What it does |
|---|---|---|
| Hooks (7) | `~/.claude/settings.json`, added by `mesh setup` | Tell the daemon when a session starts, gets a prompt, needs you, stops, ends, and when a subagent starts or stops. Fire-and-forget, to localhost only. |
| Daemon `mesh up` | your machine | Tracks your sessions, delivers messages, runs autopilot, writes records into repos, captures programmes. Runs its own local hub (Solo). |
| MCP tools (8) | the daemon, through `mesh mcp` | `mesh_context`, `mesh_next`, `mesh_claim`, `mesh_release`, `mesh_note`, `mesh_done`, `mesh_ask`, `mesh_plan`. |
| Hub `mesh hub` | one per team | Goals, plans, steps, claims, messages, the event log, the web dashboard. |
| Ledger | each repo, `.mesh/goals/**` | Generated records, committed with the work. |

## What mesh does not do

- It is not a workflow engine. Your process lives in your agents, skills and workflows; mesh records it and enforces only what a plan asks for.
- It needs no API keys and no Agent SDK: it works with Claude Code on subscription logins.
- It never stores prompt text, agent output or transcripts, and collects no token counts.

## Modes

- **Solo:** `mesh up` with no team hub. Everything runs on a local hub on your machine.
- **Team:** `mesh login --hub <url>`. Shared goals, claims across people, the web dashboard. If the hub is unreachable, the steps you hold keep working and everything syncs once when it is back.
- **Without mesh:** your process runs as before. mesh is never needed to get work done.

Next: [how-to with examples](howto.md) · [concepts](concepts.md) · [install](install.md) · [auth](auth.md) · [operations](operations.md) · [the ledger](ledger.md) · [events](../events.md)
