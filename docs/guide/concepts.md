# Concepts

**Session.** A Claude Code session the daemon knows about: interactive in tmux, background, or `claude -p`. Its state is one of *working*, *needs you* (permission, question, dialog, input), *idle*, *stalled* or *ended*. `claude agents --json` is the authority for its status; hooks make it fast.

**Goal.** A piece of work for the team, with an owner. It starts with a *design* step. Optional `refs` hold the team's own ids (`--refs spec=771,backlog=NA-1054`).

**Plan.** A versioned list of steps with dependencies (a DAG), proposed by the design session with `mesh_plan` and approved by the owner, an approver or an admin. Each version is decided once:
- *approved*;
- *revised* (a person asked for changes);
- *superseded* (replaced by a newer proposal before anyone decided; not counted as a design round).

**Step.** One unit of work in one repo, of a kind: design, implement, test, review or docs. One holder at a time. Its state is *blocked*, *ready*, *claimed*, *paused*, *done*, *failed* or *dropped*.
- A test or review step that finds a problem finishes with outcome `fail` and reopens earlier steps (a fix cycle).
- A paused step can be taken over (`mesh take`).

**Round.** One `mesh_done` on a step. A reopened step has several rounds. Each keeps its start and finish time, outcome, summary, the model the agent reported, and its artefacts.

**Segment.** One session's stretch of work on a step, with its provenance:
- model and effort, permission mode, Claude Code version;
- the **harness hash** (repo `CLAUDE.md` + `.claude/**`, your `~/.claude` `CLAUDE.md`/agents/skills, plugins, mesh version; hashes only);
- repo commit;
- turns, human prompts, nudges, waits and active minutes.

**Programme.** One Claude session whose workflow script runs many subagents (`agent()` calls), as in the canonical `define-rows.js` / `build-rows.js`.
- Labels follow `<role>:<key>[:<round>]`, e.g. `reviewer:NA-1054:r2`.
- mesh records each role under the key, with one round per run, the model actually used, timing and the agent's typed result.
- Nothing in the workflow calls mesh.

**Autopilot.**
- `off`.
- `nudge` (default): a session that stops mid-step gets "continue" twice, then mesh notifies you.
- `chain`: finishing a step claims the next ready one in the same repo.

**Ledger.** The generated records under `.mesh/goals/**`, committed in git: the durable summary. **Events** are the hub's live, precise log, kept for `events_retention_days`. See [the ledger](ledger.md) and [events](../events.md).

**Local-first.** The daemon is the writer of record for its own machine.
- Without a team hub it runs a local hub (Solo).
- With a team hub that is unreachable:
  - the steps you hold keep working, and records are written locally;
  - notes, releases, questions and results are queued;
  - actions that need other people say "offline" at once.
- Everything is sent once when the hub is back. If the hub refuses a result made offline (for example, someone took the step over meanwhile), the result is kept as a note on the step and in the local record.
