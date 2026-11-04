# Local-first mesh and capturing workflow programmes

Date: 2026-11-04. Status: **implemented in M4** (see the M4 status in the [plan](../plan/implementation-plan.md) for how it was built and where it differs). Follows [the mesh development cycle](2026-11-04-mesh-development-cycle.md).

## Owner decisions (2026-11-04, second round)

| # | Decision |
|---|---|
| 11 | **Workflow capture by hooks and Claude Code's own files.** mesh adds `SubagentStart` and `SubagentStop`. Both are fire-and-forget like the other four, which makes 7 hooks. On `SubagentStop` the daemon reads that agent's entries from Claude Code's workflow files. Subagents report nothing themselves. For subagents this replaces "the agent reports its model in `mesh_done`". Top-level sessions keep `SessionStart` (model) and `Stop` (effort, permission mode). |
| 12 | **`programme.js` changes in the canonical assets** (`architecture-and-standards/claude-assets/workflows/`). The change is limited to labels mesh can map, a `schema:` on every `agent()` call, and richer schemas. **No call to mesh in any workflow.** |
| 13 | **Two modes: Team and Solo. Bare is dropped.** |
| 15 | **Goal identity and the goal model are deferred.** A backlog, capabilities and use cases in git (owner or dedicated repos) is the likely model. No renaming now. |
| 16 | **Offline conflict rule:** the first claim to reach the hub wins; the other person is told; both records are kept. |
| 17 | **One optional `mesh ledger stage <row>` line** in the canonical workflows' final ledger commit is accepted. |
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

- **Programme capture needs no mesh goal.** Records are keyed by the id in the agent's label (e.g. `NA-1054` in `reviewer:NA-1054:r2`), exactly as the team's process names it. mesh does not allocate or rename it.
- **Solo goals** keep the current scheme from the local hub (`G<n>`), and stay local.
- **Publishing locally created goals to the team hub is out of scope** until the goal model is decided. Replication covers held steps, events and done-results only.

### 4.5 Capturing a workflow programme

1. `SubagentStart` → the daemon opens a **segment**: role = `agent_type`, start = daemon clock.
2. `SubagentStop` → it closes the segment, then reads that agent's lines from `journal.jsonl`, `agent-<id>.meta.json` and `workflows/<run>.json`. That gives the label, phase, model, attempt, duration and typed result. Token counts in those files are ignored (decision 9).
3. **The label says which step and round it is.** The canonical workflows already use one format: `<role>:<row>[:<round>]`, e.g. `reviewer:NA-1054:r2`, `test-executor:NA-1054:c3`, `developer:NA-1054:fix1`, `reviewer:NA-1054:diff1`. Labels without a row (`ledger`, `clean`, `gate-run`) are programme-level. The daemon records `reviewer:NA-1054:r2` under key `NA-1054`, role `reviewer`, round 2. The key is the team's id as written; no mesh goal is created (decision 15). A label that doesn't parse becomes an unattached segment of the session; it is not lost.
4. **The typed result becomes the round's data:** verdict, blockers, finding classes, per-AC results, failures with bucket, fail-first. These come from the richer schemas in decision 12.
5. **Where the records go:** into `<git-common-dir>/mesh/pending/<row>/`. That folder is shared by all worktrees of the repo, sits outside the working tree and is never committed by accident. The workflow's final ledger commit (in the main tree, on the programme branch) then runs `mesh ledger stage <row>`, which copies the pending records into that tree so they are committed with the ledger. **If mesh isn't installed, the command is skipped (`command -v mesh || true`).** This is the only mention of mesh in the workflows: one optional line. Without mesh the programme behaves exactly as today.
6. **Backfill.** Claude Code keeps these files for its cleanup period, 30 days by default. When the daemon starts it can import programme runs it missed while it was down.

### 4.6 The canonical workflow change (done on a branch, 2026-11-04)

The canonical `define-rows.js` and `build-rows.js` in `architecture-and-standards/claude-assets/workflows/` are newer than the per-programme `programme.js` copies in vpc-node-agent. **Every `agent()` call already has a `schema:`, and labels already follow `<role>:<row>[:<round>]`**, so neither needed changing. The change (branch `chore/mesh-ledger-capture`, commit `b581ae9`, not pushed) only adds optional result fields and one optional line:

- **Spec and diff reviews:** `findings_new` and `findings_repeat` next to the existing `findings` and `regression_of_own_repair`.
- **Plans** (`PLAN`) and **builders** (`BRANCH`): `criteria`, the acceptance criteria covered. This is the input for the reconcile check. The test-writer's existing `not_fail_first` stays.
- **Test executor** (`TEST`): `criteria: [{criterion, state: pass|fail|unrun, surface}]`, one entry per criterion, next to the existing `acs_passing`, `failing[{criterion, bucket}]` and `not_run`.
- **Final ledger commit:** "if `mesh` exists, run `mesh ledger stage <row>` for each row and stage the files it prints; otherwise skip silently".
- Nothing else. No mesh tools, no network, labels unchanged. The vpc-node-agent `programme.js` copies are one-off scripts; new programmes should start from the canonical workflows.

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

**Result (M4):** all seven are green. T1 is in `src/daemon/hub-link.test.ts`; T2–T4 and workflow capture are in `test/m4-local-first.test.ts`; T5 is in `src/core/agent-ledger.test.ts` and `src/claude/workflow.test.ts`; T6 is `pnpm test:claude`; T7 is `pnpm spike e2e-offline`. In T7 a five-agent programme finished in 11–12 s every way, the same as with no daemon.

How the design was built:
- **§4.1 Solo:** a local hub process inside `mesh up`.
- **§4.1 Team offline:** a cache of held steps plus queued calls, not full replication of goals.
- **§4.2 fail fast:** a 10 s first-call timeout, then a 5–60 s probe.

## 6. Open points

Resolved by the owner on 2026-11-04:

1. **Goal ids and the goal model:** deferred (decision 15, §4.4).
2. **Conflict rule:** first claim to reach the hub wins, the other person gets a message, and both records are kept (decision 16).
3. **Ledger-commit line:** one optional `mesh ledger stage <row>` line in the canonical workflows is accepted (decision 17).
