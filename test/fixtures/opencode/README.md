# OpenCode fixtures

`events/session.jsonl`: every server event of one OpenCode 2.2.4 session (`opencode --standalone`),
as `ctx.event.subscribe()` yields it to a plugin, one JSON envelope per line. Streaming deltas
(`*.delta`, `session.step.streamed`, `session.tool.progress`) are dropped. Folder paths, user
names and session titles are scrubbed.

The session: an MCP tool call, a file write, a question form (answered), a general subagent whose
shell command asked for permission (allowed), a shell command in the root that asked for
permission (allowed), the final answer "done: fixture recorded", and the TUI exiting
(`location.shutdown`). How it was recorded: docs/analysis/2026-11-10-opencode-integration.md.
