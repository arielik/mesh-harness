# Local-first mesh and capturing workflow programmes

Date: 2026-11-04. Status: **design, for approval before M4 starts**. Follows [the mesh development cycle](2026-11-04-mesh-development-cycle.md).

## Owner decisions (2026-11-04, second round)

| # | Decision |
|---|---|
| 11 | **Workflow capture by hooks and Claude Code's own files.** mesh adds `SubagentStart` and `SubagentStop`. Both are fire-and-forget like the other four, which makes 7 hooks. On `SubagentStop` the daemon reads that agent's entries from Claude Code's workflow files. Subagents report nothing themselves. For subagents this replaces "the agent reports its model in `mesh_done`". Top-level sessions keep `SessionStart` (model) and `Stop` (effort, permission mode). |
| 12 | **`programme.js` changes in the canonical assets** (`architecture-and-standards/claude-assets/workflows/`). The change is limited to labels mesh can map, a `schema:` on every `agent()` call, and richer schemas. **No call to mesh in any workflow.** |
| 13 | **Two modes: Team and Solo. Bare is dropped.** |
| 15 | **Goal identity and the goal model are deferred.** A backlog, capabilities and use cases in git (owner or dedicated repos) is the likely model. No renaming now. |
| 16 | **Offline conflict rule:** the first claim to reach the hub wins; the other person is told; both records are kept. |
| 17 | **One optional `mesh ledger stage <id>` line** in the canonical Close step is accepted. |
| 14 | **Everything keeps working locally without the hub.** The team's process must run whether or not mesh is installed. mesh adds visibility and enforcement; it is never needed to get work done. |

## 1. The principle

> **The process lives in the repo's agents, skills and workflows. mesh only watches and helps.**
> Nothing in `claude-assets` calls mesh. The daemon is the writer of record for its own machine. The hub is a shared index that can be away for days.

Starting "programme X" therefore runs the same with or without mesh. If mesh is there, you also get the live view, the claims, the enforcement and the ledger.

## 2. What was verified today (Claude Code 2.1.318, haiku)

| Check | Result |
|---|---|
| `SubagentStart` / `SubagentStop` fire for Task subagents **and** for workflow `agent()` calls | Yes. Each carries `agent_type` (role), `agent_id` and the last message; mesh stamps the time. |
| Claude Code's own record of a workflow run | `~/.claude/projects/<repo>/<session>/`. `subagents/workflows/<run>/journal.jsonl` holds label, phase and **the typed result**, e.g. `{"verdict":"APPROVED","blockers":0}`. `agent-<id>.meta.json` holds role, phase and **the model actually used**. `workflows/<run>.json` holds, per agent, start time, duration, attempt, state and tool calls, plus run totals. |
| A programme run with mesh's 7 hooks pointing at a **daemon that is not running** | Completed. 10 s vs 9 s with no hooks (run-to-run noise). |
| Same, hooks pointing at an **address that never answers** | Completed. 13 s: the `Stop` HTTP hook waits out its 3 s timeout. Hooks only ever call the local daemon, never the hub, so this can't happen from a hub outage. |
| mesh MCP server with **no daemon** | Each tool returns "the mesh daemon is not reachable (run: mesh up)" after 3 short retries, and Claude carries on (`src/mcp/shim.ts`). |
| mesh tools with the **hub unreachable** | Each hub call fails with "the hub … is unreachable", but only after up to **15 s** (`src/daemon/hub-link.ts`). Tools that need the hub (`mesh_next`, `mesh_claim`, `mesh_context`, `mesh_done`, `mesh_plan`) then **fail**. Gap 1 below. |

## 3. What works without the hub: today vs target

| Capability | No mesh installed | mesh, hub unreachable: **today** | mesh, hub unreachable: **target** |
|---|---|---|---|
| Run "programme X" (workflow, agents, worktrees) | ✅ | ✅ (nothing in the workflow calls mesh) | ✅ |
| Interactive Claude sessions | ✅ | ✅ | ✅ |
| TUI, jump, say, nudges, "needs you", notifications | — | ✅ (all local) | ✅ |
| Session and subagent events | — | ✅ queued in the outbox, sent on reconnect | ✅ plus subagent segments |
| Ledger records for a programme run | — (data stays in `~/.claude` only) | ❌ not built yet | ✅ written locally, published later |
| `mesh_context` / `mesh_done` on a step you already hold | — | ❌ fails after 15 s | ✅ from the local copy; done queued |
| Step records on `mesh_done` | — | ❌ rendered by the hub | ✅ rendered by the daemon |
| Picking a new shared step, take-over, approval by someone else | — | ❌ | ⚠️ "offline" within 2 s; your own goals still work (Solo rules) |
| Web dashboard, others' sessions | — | ❌ | ❌ (it's the hub) |
| Mode when no hub is configured at all (Solo) | — | partial: local only, no goals | ✅ full process on a local hub |

## 4. Design

### 4.1 The daemon always runs a local hub

The daemon embeds the same `HubService` on its own SQLite file: the **local hub**. Every tool call goes to the local hub first:

- **Solo** (no hub configured): the local hub is the whole system. You create goals, approve your own plans and run steps; records are written as usual.
- **Team** (hub configured): the daemon keeps local copies of the goals and steps it works on and **replicates** with the team hub:
  - events and done-results go up through the existing outbox;
  - goals, steps and messages come down by pull + ack (as today).
- **Team, offline**: work on held steps and on goals created on this machine continues locally. Actions that need other people (claiming a shared ready step, take-over, approval by another person) return **"offline, try again or work locally"** within 2 s. They never hang.

### 4.2 Fail fast: a circuit breaker on the hub link

- After one failed call the link is marked `offline`. Later calls fail at once.
- A background probe (`GET /healthz`, every 15 s with backoff) re-opens the link, then the outbox drains.
- The TUI and `mesh status` show `hub: offline since 14:02 (3 events queued)`.

### 4.3 The daemon renders the records

`src/core/trail.ts` is pure, so the daemon renders goal, plan and step records from its local state and events. The hub keeps rendering for steps it closes itself, such as a design step closed at approval. Same code, same output.

### 4.4 Goal identity: deferred (owner decision 15)

How goals are named and where they live will be decided separately. The likely direction is a backlog, capabilities and use cases kept **in git**, in the owner repos or in dedicated repos, following the model in `architecture-and-standards`. Until then:

- **Programme capture needs no mesh goal.** Records are keyed by the id in the agent's label (e.g. `771` in `spec-review 771 r2`), exactly as the team's process names it. mesh does not allocate or rename it.
- **Solo goals** keep the current scheme from the local hub (`G<n>`), and stay local.
- **Publishing locally created goals to the team hub is out of scope** until the goal model is decided. Replication covers held steps, events and done-results only.

### 4.5 Capturing a workflow programme

1. `SubagentStart` → the daemon opens a **segment**: role = `agent_type`, start = daemon clock.
2. `SubagentStop` → it closes the segment, then reads that agent's lines from `journal.jsonl`, `agent-<id>.meta.json` and `workflows/<run>.json`. That gives the label, phase, model, attempt, duration and typed result. Token counts in those files are ignored (decision 9).
3. **The label says which step and round it is.** Canonical convention: `"<stage> <id> r<N>"` / `"<stage> <id> c<N>"`, e.g. `spec-review 771 r2`, `verify 771 c3`. The daemon records it under key `771`, stage `spec-review`, round 2. The key is the team's id as written; no mesh goal is created (decision 15). A label that doesn't parse becomes an unattached segment of the session; it is not lost.
4. **The typed result becomes the round's data:** verdict, blockers, finding classes, per-AC results, failures with bucket, fail-first. These come from the richer schemas in decision 12.
5. **Where the records go:** into `<git-common-dir>/mesh/pending/<goal>/`. That folder is shared by all worktrees of the repo, sits outside the working tree and is never committed by accident. The workflow's existing Close step then runs `mesh ledger stage <id>`, which copies the pending records into the row's worktree so they are committed with the closing commit. **If mesh isn't installed, the command is skipped (`command -v mesh || true`).** This is the only mention of mesh in the workflows: one optional line. Without mesh the programme behaves exactly as today.
6. **Backfill.** Claude Code keeps these files for its cleanup period, 30 days by default. When the daemon starts it can import programme runs it missed while it was down.

### 4.6 What the canonical `programme.js` change looks like

- Labels follow `"<stage> <id> r<N>"`.
- A `schema:` on every `agent()` call, including the mechanical ones.
- Richer schemas:
  - `REVIEW` adds `findings: {new, repeat, regression}`;
  - `EXEC` adds `acs: {AC-01: met|not_met|unrun}` and keeps `surfaces_not_run`;
  - test-writer `WORK` adds `fail_first: {red: [], not_red: []}`;
  - mutation results become `{killed, survived: []}`.
- Close step: `command -v mesh >/dev/null && mesh ledger stage <id> || true`.
- Nothing else. No mesh tools, no network.

## 5. How we become confident before relying on it

| # | Test | Proves |
|---|---|---|
| T1 | Unit: the hub link against a blackholed address (a TCP server that accepts and never answers) | First failure within the timeout; later calls fail in under 50 ms; the probe recovers |
| T2 | Flow (in process): hub stopped while a step is held → `mesh_context` and `mesh_done` succeed locally, record written → hub restarted → events and done synced **once** (idempotent), hub state equals local state | Offline continuity, no duplicates |
| T3 | Flow: Solo with no credentials → goal → plan → self-approval → two steps → done → records | Solo is a complete mode |
| T4 | Flow: two people claim the same step while one is offline → the hub keeps the first claim; the other gets a clear message; both records are kept | Conflict rule |
| T5 | Unit: label parser and journal / meta / run readers against **fixtures captured from Claude Code 2.1.318** | Workflow capture |
| T6 | Contract suite (`pnpm test:claude`, M4 task 4.3): run a 2-agent workflow, check the hook payloads and the file formats are still as expected | A Claude Code upgrade can't silently break capture |
| T7 | Real Claude e2e `pnpm spike e2e-offline`. Run the canonical-style programme (spec, review, plans, build, verify, haiku) 4 times: (a) no daemon; (b) daemon, hub blackholed; (c) hub restored mid-run; (d) Solo. | (a)–(d) all finish; (b)–(d) leave identical records apart from timestamps; (c) syncs everything once; run time with mesh is within a few seconds of (a) |

Only when T1–T7 are green is "mesh is optional, the process never falls apart" claimed as done.

## 6. Open points

Resolved by the owner on 2026-11-04:

1. **Goal ids and the goal model:** deferred (decision 15, §4.4).
2. **Conflict rule:** first claim to reach the hub wins, the other person gets a message, and both records are kept (decision 16).
3. **Close-step line:** one optional `mesh ledger stage <id>` line in the canonical workflows is accepted (decision 17).
