# Concepts

**Session.** A Claude Code session the daemon knows about: interactive in tmux, background, or `claude -p`. Its state is one of *working*, *needs you* (permission, question, dialog, input), *idle*, *stalled* or *ended*. `claude agents --json` is the authority for its status; hooks make it fast.

**Goal.** A piece of work for the team, with an owner. It starts with a *design* step. Optional `refs` hold the team's own ids (`--refs spec=771,backlog=NA-1054`).

**Plan.** A versioned list of steps with dependencies (a DAG), proposed by the design session with `mesh_plan` and approved by the owner, an approver or an admin. Each version is decided once:
- *approved*;
- *revised* (a person asked for changes);
- *superseded* (replaced by a newer proposal before anyone decided; not counted as a design round).

**Step.** One unit of work in one repo, of a kind: design, spec, plan, implement, test, verify, review, merge, gate or docs. One holder at a time. Its state is *blocked*, *ready*, *claimed*, *paused*, *done*, *failed*, *parked* (stopped by a rule; a person resumes it) or *dropped*.
- A test or review step that finds a problem finishes with outcome `fail` and reopens earlier steps (a fix cycle).
- A paused step can be taken over (`mesh take`).

**Rules (optional, per plan step).** A plan step may carry rules; a plan without them works as before:
- `role` (free text);
- `acs`, the acceptance criteria it covers, from the plan's `acs` list (id, text, surface, fails_when);
- `blind`: steps this one must not see. Their summary, notes and branch are hidden from its agent. Whoever worked on them can't take it: `blind_guard: person` on a team hub, `session` in Solo;
- `reads`: the only dependencies it sees;
- `forbid`: paths its session may not read, as Claude Code deny rules via `mesh run`;
- `contract`;
- `max_rounds`, plus `park_on: [churn, stall]`;
- `route`: per failure bucket (spec-gap, impl-bug, test-bug, infra, unclear), a step to reopen or `park`;
- `target`: for a review, the step its verdict reopens;
- `must_cover`: reconcile, i.e. the step's `acs_addressed` must cover the plan's criteria; a miss is sent back once, then parked;
- `worktree`: `mesh run --step` makes one worktree and branch per step;
- `reworks`;
- `gate`.

**Gate.** A step of kind `gate` (R1/R2/R3) is decided by the goal owner, an approver or an admin:
- `mesh step approve <step> [--rule GATE-1]`, or the web dashboard;
- or `mesh step reject <step> --reopen a,b`.

The decision, rule and inputs are recorded.

**Reopen.** A failing step reopens the steps it names, or its `route`/`target` picks them. Done steps downstream of a reopened step wait again (a review after a spec fix, a combine after a code fix, a gate after either), so nothing passes on an old result.

**Template.** A plan shape such as `sdd-split` (built in) or `.mesh/presets/<name>.yaml`. `mesh goal new --preset` gives it to the design session; `mesh goal plan --preset` fills it in directly. Checking a plan against its template only gives warnings.

**Round.** One `mesh_done` on a step. A reopened step has several rounds. Each keeps its start and finish time, outcome, summary, the model the agent reported, and its artefacts. With M4.5 it can also keep:
- the verdict (approved, changes_requested, blocked, pass, fail);
- finding counts (new, repeat, regression) and blockers;
- failures with bucket, criterion and assertion;
- per-criterion results (met, not_met, unrun), and the criteria the round addressed;
- a reconcile miss, a gate decision, and the rule that parked the step.

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
