# Source analysis: mesh-ai, deepseek-harness, dsh-superagent-prototype

Date: 2026-11-03. This document supports [2026-11-03-mesh-harness-proposal.md](2026-11-03-mesh-harness-proposal.md). It records what each source repository is, what it does well, where it falls short for our goal, and the lessons the proposal draws from it.

Paths are relative to each repo root:

- `ai-tooling/mesh-ai` (pulled to `develop` `a6b4f4c`)
- `ai-tooling/deepseek-harness`
- `ai-tooling/dsh-superagent-prototype`
- `ai-tooling/cordis`

---

## 1. mesh-ai

### 1.1 What it is

A TypeScript monorepo (pnpm + Turborepo) with about 150k lines of TS/TSX, of which about 84k are tests. On top of that it holds about 56k lines of specs, 411 review files and 73 progress files. It has about 1,940 commits, about 1,600 of them in the last 10 days and mostly from unattended agent "programmes".

| Part | What it does | Size |
|---|---|---|
| `apps/gateway` | Event-sourced gateway with a MeshLog port (JetStream, Kafka as a rollback option); reducers for story FSM, programmes, ops, rework, ledger, work, trunk and catalog; HTTP and WebSocket; CronJob entries (`jira-sync`, `gitlab-ingest`, `ci-prom-ingest`) | ~16.5k src / 37k tests |
| `apps/dashboard` | Next.js 14 single-page app switched by `?view=`. Views: Home, Work, Shared backlog (programme DAG), Trunk, Activity, Metrics, Routines, Ops, Mesh View, Users, Task. Also SSO and a served-reports route. | ~30k (14k tests) |
| `packages/event-schema` | zod `mesh.event.v1`, about 82 event types, and `PROGRAMME_ENDPOINTS` (42 operations) | ~4k / 6k tests |
| `packages/meshctl` | CLI plus the MCP server (`src/programme/mcp.ts`, about 35 tools), routine `install`/`cron`, `work`, `finding`, `login` | ~32k (20k tests) |
| `packages/agent-kit` | `mesh-ai-init` installs agents, commands, programme prompts, ops prompts and templates into product repos | ~7.5k |
| `packages/{source,jira,auth,provider-contract}` | GitLab/GitHub/Bitbucket, Jira/GitHub Issues, auth strategies, conformance tests | ~3.2k total |

### 1.2 How agents participate today

- **Launch.** People start Claude Code or Copilot sessions by hand. Programmes run unattended through Claude Code saved workflows (`.claude/workflows/*.js`), and `meshctl worker spawn` starts a worker. **The dashboard cannot start, steer or stop anything** (MESH-OQ-PWG-11).
- **Reporting.** After three generations (instruction-driven emits → hooks plus heartbeat daemon plus reapers plus token parsing → self-report), the current mechanism is:
  - each role brief ends with `meshctl work start …` / `meshctl work done …`;
  - a Stop hook scans for the `⟦needs-human⟧` marker;
  - lease-safety hooks run for programmes;
  - git, CI and Sonar facts come from CronJob ingests.
- **MCP.** `meshctl mcp` over stdio, calling the gateway with a bearer token. It exposes about 35 tools covering programme bookkeeping (`mesh_claim`, `mesh_renew`, `mesh_yield`, `mesh_checkpoint`, `mesh_gate` …), `work_*`, `routine_*` and `ops_status`.
- **Routines.** `/routine-new` writes `.claude/agents/<name>.md` and `.claude/routines/cron/<name>.json`. `meshctl routine install` then adds a line to the **user's crontab** that runs `claude -p` headless. The agent prompt carries a "routine contract": call `start`, check that the checkout is clean, work in a `.routine-wt/` worktree, raise findings and poll for duplicates, push a `routine/<name>/<date>` branch, open an MR, call `finish` with the report URL.

### 1.3 Strengths worth keeping

1. **The log is canonical, with one zod contract and one fold.** This made replay, verify-rebuild and warm snapshots possible.
2. **A schema table drives HTTP, CLI and MCP** (`packages/event-schema/src/programme-api.ts`).
3. **Deterministic ingests:** CI from Prometheus and Sonar (`apps/gateway/src/ci-prom/*`), and commits from GitLab.
4. **The Ops view** (CI tiles, Sonar, detail page), which the owner explicitly praised on 2026-11-03.
5. **Served HTML reports** behind sign-in (B-132).
6. **SSO design:** Keycloak OIDC for the UI, device flow for the CLI, local JWT check, ws-tickets, break-glass tokens (ADR-0023).
7. **Small, clean provider seams** with a shared conformance suite.
8. **Finding fingerprints and deduplication.** Routines open MRs; humans merge.
9. **The `/routine-new` skill and its templates.**

### 1.4 Weaknesses and lessons

| Observation | Evidence | Lesson for mesh-harness |
|---|---|---|
| Observing agents it does not own leads to churn | Hooks added in spec 0024, removed in spec 0050. Daemon added in ADR-0011, retired in ADR-0020. "Steps of dead agents stay forever" (SPEC0048-3). Live session cards removed (REQ-ORM-43). | Keep hooks to the minimum (start, turn start, stop, waiting, end), asynchronous and never blocking, and installed once per user. Take "is it still working" from transcript modification time and `claude agents --json`, not from a heartbeat daemon. |
| The server never sees the schedule | Routines live in crontabs. Missed runs are invisible (SPEC0034-3). Stale checkouts (B-127). Permission-rule breakage (B-120/121). | Out of the revision 3 core. When routines are ported (add-on), the hub should hold the schedule so missed runs are visible. |
| No intake model | No path from a request to an agent | Goals in a shared backlog; `mesh run` / `mesh next` / `mesh take` turn a goal's steps into sessions. |
| Over-broad coordination API | 42 programme operations; `commands.ts` is 1,061 lines; leases and epochs without a heartbeat (PWG-5) | Goal → design → step DAG, with per-step claims. Eight MCP tools. |
| Telemetry generations kept for replay | `run.*`, `stage.*` and `session.*` types still exist, plus the legacy daemon code | Start a fresh contract. Do not migrate mesh-ai history. |
| A projection nobody reads | Postgres programme projection unused (SPEC0020-6). Cold rebuild takes more than 300 s and about 1.45 GB (B-108). | Current-state tables updated in the same transaction as the log. No cold rebuild on boot. |
| Infrastructure churn | Kafka → JetStream for a workload of 1 topic, 1 partition, tens of events per second | One SQLite hub. No broker. |
| Process mass | GATE-1, gate-advisor rounds, `Gate:` records, specs of 600–1,300 lines with impl and test plans, doc-text tests, `reserve-id` pushes to `develop` | A light process. |
| Hard-coded org data | Team→repo map in `apps/dashboard/app/lib/teamScope.ts` | Scopes become settings. |
| Security gaps | Report fetch with TLS off (SPEC0055-3), ingest token reused (SPEC0055-5), session impersonation within a scope (SPEC0017-10), GitLab token expired silently (B-047) | Kanidm identity on every session and claim; tokens validated against JWKS; no shared ingest tokens. |
| Stale docs | `docs/status.md`, `.context/architecture.md`, `docs/event-catalog.md` describe removed views and Kafka | Doc-to-code index tests, as superagent does. |

---

## 2. deepseek-harness (DSH) and cordis

### 2.1 What it is

DeepSeek's open-source agent harness (MIT, developer preview). The tagline is "everything is a plugin": every part, including the agent loop itself, is a **Cordis** plugin. It is a pnpm monorepo with about 381 packages. Surfaces: Web UI (`dsh web`), Electron desktop, headless, a JSON-RPC SDK (TS and Python) and an ACP server. There is no built-in TUI.

### 2.2 Core model

- **Glossary.** A *step* is one model request plus its tool calls. A *turn* is one drain of admitted input. A *round* is an outer policy loop (goal, Ralph). Per-agent *scope* has two flat levels, and lineage (parent session, depth) is carried as data.
- **One Agent per Session.** It has an inbox (queue / steer / inject), cancel and wait-idle.
- **Turn flow.** A turn runs through waterfall interception points: `agent/pre-step`, `llm/stream`, `agent/request-error`, `tools/pre-execute`, `tools/execute`, `tools/post-execute`. The core invariant is **"model-visible means logged"**: every request can be rebuilt from the session log.
- **Tool pipeline.** Steps: log `tool/call`, then pre-execute (hooks, permission, sandbox; *ask* goes to a fail-closed approval), then guards, then execute with timeouts, then post-execute, then normalise, then durable `tool/result`.

### 2.3 Events and persistence

- **Three event domains.**
  - Durable *session events* (`session/event`, about 35 listeners).
  - Transient *agent events*: status, inbox changes, `assistant-stream` chunks.
  - *Capability events*: fs, tools, approval, schedule, subagent, workflow …
- **Session log.** The log is JSONL with an envelope `{type, seq, time, data, ignorable?}`.
  - *Surface* events build model history. Compaction uses `surfaceOp: replace`, which rewrites history without deleting entries.
  - Unknown *required* events make a reader refuse to reconstruct the session.
  - Formats are versioned (currently v4) with one-step migrations. Generation files are immutable. A cross-process write lease guarantees a single writer.
- **Projections.** Pure folds produce snapshots with an `asOfSeq` cut, and a projection cache lets session lists avoid opening logs.
- **Integrity.** A SHA-256 fingerprint per persisted type sits in `docs/persistence-schema.json` and is checked in CI.

### 2.4 API and UI streaming

- **API (Typert).** Typert is a build-time RPC generator. It reads `@Remote` methods from the host `ts.Program` and emits zod codecs plus client types. Unary calls are `POST /api/<ns>/<method>`; streams are multiplexed over `/api/remote.mux`. `ctx.remoteAccess` holds the access policy for non-owner peers.
- **UI streams.**
  - `SessionEventStream` is a journal stream: follow, then page, with gap repair, turn-aligned history paging, and live chunks replaced by the durable `assistant/message`.
  - `SessionControlStream` sends a full baseline per connection generation, then frames.
- **Web client.** The browser is also a Cordis app, with typed UI Slots. Views include chat, tool cards, the trajectory ledger, subagent navigation, jobs, schedules, approvals, plan/goal, a dock with files/terminal/browser, and settings and plugins. Experimental: agent-team roster and task board, session inspector, liveshare.

### 2.5 Bundles

A bundle is an npm package with `dsh.bundle.patch` (a Cordis YAML patch that inserts plugins and agent presets) and an optional client module that fills UI Slots. dsh-superagent is the worked example (§3).

### 2.6 Multi-agent support

- **Sessions and subagents.** One host holds many live agents, and cold sessions resume on demand. Subagents are a seam (`ctx.subagents`). Providers:
  - in-process spawn or fork;
  - a nested `dsh` process;
  - ACP;
  - Claude Code;
  - Codex.

  Capability flags: `agentOptions`, `agentPreset`, `outputSchema`, `depthLimit`.
- **Other mechanisms:**
  - agent teams (experimental: a durable task DAG and an inbox per teammate);
  - JS workflows (`agent()`, `parallel()`, `pipeline()`);
  - background jobs and schedules;
  - goals and the Ralph loop;
  - webhook-to-session;
  - workspace-level ownership sweeps (`session-activity`, `session-stop`).
- **Safety.** Sandboxing (read-only / workspace-write / danger-full-access) covers files only. Approvals are one-shot and fail closed. Permission presets exist. `SAFETY.md` says plainly that it is not a security boundary.

### 2.7 External agents (the key limitation for us)

DSH's own loop uses `llm-deepseek` and `llm-pi-ai`, the latter multi-provider including Anthropic. Claude Code and Codex appear only as **one-shot subagent providers**:

- `subagent-claude-code` runs a fresh, unattended Claude Code session and returns only the final answer;
- reasoning, tool traffic, usage and diffs stay hidden from the parent;
- the child cannot be continued or prompt a person.

`hooks-claude-code` only runs Claude Code-style hook scripts inside DSH's *own* loop. **DSH cannot give us visibility into Claude Code sessions.** `subagent-claude-code` also runs through the SDK runtime, which our subscription-only constraint rules out (proposal §2, C1). These are the main reasons the proposal uses DSH's patterns but not its runtime.

### 2.8 Cordis

Cordis is a "meta-framework of spatiotemporal composability", with a core of about 2k lines. Its main ideas:

- plugins that declare `inject` dependencies;
- a Context that works as a service registry;
- typed events (emit / waterfall / serial / parallel / bail);
- reversible effects for clean unload and hot reload;
- fibers;
- `isolate()` realms;
- a YAML loader with patch layering.

It is elegant, but young and API-unstable, and adopting it means adopting it everywhere.

### 2.9 Lessons

Adopt as patterns:

- two-channel events;
- projections with `asOfSeq`;
- the journal-stream protocol;
- fail-closed approvals;
- the Executor seam with capability flags;
- ownership sweeps;
- generated catalogs checked in CI.

Do not adopt:

- Cordis;
- Typert;
- the DSH loop;
- DeepSeek-specific packages.

---

## 3. dsh-superagent-prototype

### 3.1 What it is

A research prototype (MIT, v0.1.0, about 15.6k lines of source and 15k of tests): a **proactive coding agent for one GitHub repository**, packaged as a DSH bundle. It listens to GitHub (polling notifications and repository streams) and optionally Feishu. For each authorized request it opens a Ticket that runs in its own DSH session and directory, and it answers in the original conversation, usually with a PR. A sidebar panel shows what needs a person. Its guiding principle (`docs/000-philosophy.md`) is **"take as little human attention as possible, and give as much value as possible."**

### 3.2 Domain model

`docs/001-domain.md`, `src/core/model.ts`.

- **Flow.** Source → Trigger (immutable, deterministic id) → Thread (time-ordered, one Eval at a time) → either Subscription fan-out to Tickets, or Eval → Decision (accept / stop / ignore / unavailable) → Ticket with an immutable **Mandate** (strength, basis, actor, scope, policy version) → Assignment (pending → running → ended) → Executor. Results return through a Channel.
- **Reports and Inputs.** Reports (`progress / waiting / ready / blocked / failed / dropped`) drive the Ticket **stage**. That is an ordered table: `person/delivery`, `person/answer`, `person/review`, `person/blocked|failed`, `working/queued`, `idle`, `working`. Inputs track delivered and read times.
- **Rejected concepts are listed.** No Principal entity, no "one Ticket per Thread", no "append" Decision, no self-scheduling Evals, no mirrored session state.

### 3.3 Authorization

`docs/002-authorization.md`.

- **Gate.** A deterministic gate computes strength (explicit / inferred / not admitted) from the allowed list, whether the agent was addressed, a per-scope admission table, and the bot list.
- **Assessment.** An LLM assessment runs only for inferred candidates. Its output is validated in code: one judgement per enabled rule, plus "direction settled" booleans.
- **Accept modes.** `off`, `observe` (the default; records "would accept") and `auto`.
- **Follow-ups.** A follow-up on a Ticket's own Thread belongs to that Ticket's executor, which can acknowledge it or hand it back.
- **Revalidation.** Mandates are revalidated before a reopened Ticket resumes. A policy change sends `policy-changed` only to the affected Tickets.

### 3.4 Execution

`docs/003-execution.md`, `src/executor/dsh.ts`.

- **Two roles.**
  - A router "main session": read-only, no waiting, 5-second shell cap, forwards the original Trigger plus a note of at most 30 words.
  - Worker sessions: one per Ticket, foreground commands moved to the background after 5 s, so new messages are read at the next step.
- **Directories.** One directory per Ticket, made by a user-written **prepare** command (`git worktree add …`). Execution environment variables are provided; credentials are not.
- **Credential shims.** `gh` and `lark-cli` wrappers and a dedicated gitconfig go first on PATH. The docs say this is not a security boundary.
- **Slots.** `maxWorkers` slots, plus **one reserved for a person's wake**. Wakes take priority over launches.
- **Retries and restarts.** Transient errors are retried with backoff; a failed turn gets "continue" messages; Retry creates a new Assignment in the same directory and branch. After a restart there is recovery with exactly-once Input redelivery.

### 3.5 Architecture and persistence

`docs/007-architecture.md`.

- **Engine.** `src/core/engine.ts` is the **only writer**. Its commands are synchronous and transactional. It is built from five parts (Intake, Evals, Tickets, Assignments, Replies), and callers get role-narrowed views.
- **Ports:** Repositories, Policy, SourceScope, Assessor, Executor, Outbox.
- **Effects.** `src/app/effects.ts` is a durable job queue written inside the transaction (assessment, launch, delivery, relay, notice, reply), with backoff and health tracking.
- **Passes.** A 2-second single-flight loop.
- **Storage.** One SQLite file (WAL). Values are JSON with generated, indexed columns. Nothing is ever deleted.
- **Management API.** Loopback only, header-protected. `SETUP.md` drives it as an agent-run interview.

### 3.6 Panel

`docs/005-panel.md`.

- **Three questions, in order:**
  1. Does anything need me now?
  2. Is the system healthy?
  3. What is the history of one piece of work?
- **Overview.** Tickets in a `person/*` stage, plus actionable problems (a problem means three consecutive failures). Each row has its action inline.
- **Rules.** Counts equal the length of the list they link to. Labels say whom a row waits for and what it needs. Healthy states take no space. Each concept has one home page.
- **Tabs:** Overview, Source, Trigger, Eval, Execution, Settings.
- **Prompts.** Overrides are versioned and flagged "default updated" with a diff when an upgrade changes the default.

### 3.7 Limitations for our goal

- **Scope.** One repository, github.com only, polling only. One agent identity, one executor type (DSH).
- **No cross-repo view.** Several repos means several processes and panels.
- **Coordination.** No Ticket DAG. Executor coordination is only router notes and subscriptions.
- **No security sandbox.** Sessions run with `danger-full-access` as the operator's OS user.
- **Storage.** SQLite on a single machine, with no retention.
- **Scheduling.** No time-based triggers; a schedule would have to be a polling Source.
- **No metrics view.**
- **DSH lock-in.**

### 3.8 Lessons

This is the best-designed of the three for *coordination and human attention*. Revision 1 of the proposal adopted most of its machinery. Revision 3 keeps only the parts that stay light: the "take as little human attention as possible" rules, an ordered state classification (now per session), and handoff through recorded notes. The Trigger/Eval/Mandate and effects/outbox machinery is not needed in the local-first, claim-based model.

---

## 4. The design essay (*Exploring Super-agent Design*)

The essay is summarised from secondary write-ups of the DeepSeek Harness article. The public prototype implements only part of it. Its main ideas:

- **Four goals:** continuous (context crosses channels), productive (several tasks at once, interruptible), proactive (policy-gated, quiet by default), persistent (survives restarts).
- **Observation:** a person can follow only about 3–5 sessions. *Human attention, not model capability, is the bottleneck.* This is the strongest argument for a pane of glass built around an inbox.
- **Router and Workers:** a long-lived router with a lighter model and no execution, and isolated workers with stronger models.
- **Fast path, then semantic path:** code filters first, an LLM assesses the rest. **Pass-through** sends subscribed events straight to workers. In the essay's experiment, removing pass-through raised router decisions by about 30% and cache reads by about 37%.
- **Context as a cache:** inline what is likely needed and spill the rest. **Chain of recall** follows ids from an event to its Thread, from there to the Session, and onward to related threads. This is the source of `mesh_context` and the handoff notes in the proposal.
- **Full-duplex:** long commands run in the background and new input is processed at the next step.
- **Storage and compute separated, and Bring Your Own Machine:** endpoint daemons run commands on existing machines while state lives centrally. In revision 3 this becomes each developer's local `mesh up` daemon plus a shared hub.
- **Watchdog:** a separate supervisor that triggers on a schedule, detects "alive but stuck" and repairs. Revision 3 has a deterministic version: stall and quiet detection plus autopilot nudges.
- **Open problems:**
  - router scaling;
  - making hidden multi-session work legible to people (exactly our pane-of-glass goal);
  - context boundaries between personal and team agents;
  - prompt injection and credentials in context.

---

## 5. Side-by-side (against proposal revision 3)

| Capability | mesh-ai | DSH | superagent | mesh-harness (rev 3) |
|---|---|---|---|---|
| Runs Claude Code | No (people do) | Black-box subagent only (SDK or API key) | No (DSH loop) | People's own `claude` CLI sessions on their subscriptions; `mesh run` opens them in tmux or with `--bg` |
| Live view of sessions | Removed (self-report only) | Yes, own loop | Via DSH session UI | **5 async hooks** (start, turn start, stop, waiting, end) + transcript mtime + `claude agents --json` |
| Removes babysitting | No | n/a | Router relays | **Autopilot: nudge stalled sessions, chain the next step, notify only when needed** |
| SDD | Drawn, not enforced | n/a | n/a | **Design → approval → step DAG.** Implementation steps don't exist before approval. |
| Multi-user | Programme membership and leases | Liveshare (experimental) | Single operator | **Kanidm identity, shared goals, per-step claims, take-over with handoff notes** |
| Backlog | `BACKLOG.md` + programmes | n/a | GitHub issues as triggers | Hub goals; GitLab issues can be imported and linked |
| Human-attention view | Needs-you (partial) | Per-session approvals | **Stage-based inbox** | Per-user TUI sorted by "needs you", plus a hub attention list |
| Evals | Spec 0036 cases, never folded | Benchmarks for its own loop | None | Later add-on, built on step outcome data |
| CI / Sonar / routines | **Yes** | No | CI events as context | Later add-on (port of mesh-ai Ops) |
| Storage | JetStream + memory + unused PG | JSONL sessions + sqlite | SQLite | **SQLite hub + local SQLite** |
| Process weight | Very heavy | Heavy (generated docs, i18n) | Moderate | Light |
