# mesh-harness implementation plan

Status: **v2.8, reviewed; M0–M4.7 done** ([analysis](../analysis/2026-11-04-team-value-metrics-and-ledger.md#owner-decisions-2026-11-04)). Date: 2026-11-04. v2.1 applies the M0 spike results ([docs/spikes](../spikes/README.md)).

Sources:

- [proposal rev 3.1](../analysis/2026-11-03-mesh-harness-proposal.md)
- [journeys, dashboard and analysis](../analysis/2026-11-03-journeys-dashboard-and-analysis.md)

Review: v1 was critiqued by an independent reviewer (Claude Opus 5.5, medium effort). Every recommendation and what was done with it is in [§14](#14-review-log). Claude Code facts were checked against code.claude.com/docs (hooks, CLI reference, agent view, MCP) on 2026-11-03.

This plan leads development. Each milestone ends with something a developer can use. Each task has acceptance checks that become tests.

---

## 1. Principles

1. **One package, one binary.** `mesh` runs as CLI, local daemon (`mesh up`), MCP shim (`mesh mcp`) and hub (`mesh hub`). Internal modules have enforced boundaries; there is no internal publishing.
2. **Pure core.** Domain rules have no I/O and use an injected clock:
   - session state;
   - DAG validation and readiness;
   - claims;
   - autopilot decisions;
   - step records;
   - roles.
3. **Ports at the edges, one implementation each** until a second is actually needed: auth providers (three from day one), store, Claude adapter, multiplexer.
4. **Auth is pluggable at login only.** Identity providers prove who you are once. The hub then issues its own opaque tokens, so nothing downstream knows which provider was used.
5. **Hooks never hurt sessions.**
   - Four hooks are **async command hooks** (fire-and-forget `curl`).
   - Only `Stop` is synchronous: an HTTP hook with `timeout: 3` that returns nothing or `additionalContext`.
6. **Claude Code is the source of truth for session status where it offers one.** That means `claude agents --json`, pending spike S7. Hooks give low-latency transitions.
7. **Few dependencies,** each justified in `docs/dependencies.md`: `zod`, `hono`, `@hono/node-server`, `openid-client`, `@modelcontextprotocol/sdk`, `yaml`. SQLite comes from Node's built-in `node:sqlite` (Node ≥ 22.13). The web app adds `react`, `react-dom`, `@tanstack/react-query` and `@xyflow/react`.
8. **Light process.** Each change ships as a PR with tests and CI green. ADRs are written only for the decisions in §12. Anything not in §10 goes to `docs/later.md`.

---

## 2. Repository layout

```
mesh-harness/
  package.json              # mesh-harness, bin: mesh
  src/
    protocol/               # zod: hook inputs, events, API DTOs, MCP tool I/O, plan, step record
    core/                   # pure: session-state, dag, claims, autopilot, roles, step-record, repo-id
    auth/                   # AuthProvider port, providers (none, token, oidc), token store, login orchestration
    store/                  # sqlite wrapper (node:sqlite), migrations (daemon + hub schemas)
    claude/                 # settings/MCP installer, agents --json reader, resume --bg, version check
    mux/                    # tmux adapter (+ none)
    daemon/                 # hook receiver, reconciler, autopilot runner, delivery, hub client + spool + inbox
    mcp/                    # stdio MCP shim (mesh mcp) → daemon
    hub/                    # Hono app: auth routes, /v1 API, SSE wake channel, events feed, static web
    cli/                    # commands, login, ANSI TUI
    gitlab/                 # optional (M6)
    main.ts
  web/                      # React + Vite: Live, Goals, Goal
  test/fixtures/            # fake claude (hook + agents --json scripts), mock OIDC issuer, tmux helpers, captured payloads per Claude version
  docs/ plan/ adr/ spikes/ dependencies.md later.md
  .dependency-cruiser.cjs
```

### 2.1 Module boundaries (enforced in CI)

| Module | May import |
|---|---|
| `protocol` | `zod` |
| `core` | `protocol` |
| `auth` | `protocol`, `core`, `store` |
| `store` | `protocol` |
| `claude`, `mux` | `protocol` |
| `opencode` | `protocol`, `claude` (the process runner) |
| `daemon` | `protocol`, `core`, `store`, `claude`, `mux` |
| `mcp` | `protocol` (talks to the daemon over its local socket) |
| `hub` | `protocol`, `core`, `store`, `auth`, `gitlab` |
| `cli` | `protocol`, `core`, `claude`, `opencode`, `mux`, `auth` (login orchestration only); talks to the daemon and hub over HTTP |
| `web` | `protocol` types via a build alias |

Only `store` touches SQLite. Only `claude`, `mux` and `cli` spawn processes.

---

## 3. Domain model

### 3.1 Identity of repos and sessions

- **Repo id** = the normalized git remote: `host/path` in lower case, without `.git` or credentials, for example `gitlab.lab/vpc/frr-dplane-ovs`. Its display name is the last segment. The same function in `core/repo-id.ts` is used by sessions, steps, `mesh run` and the hub.
- **Local checkouts** are auto-discovered under `workspace_roots` (default: the parent of the current directory and `~/src`), plus explicit `repos:` overrides in `~/.config/mesh/config.yaml`.
- **Session** (daemon-owned) has a stable mesh id `sid` and a **list** of Claude `session_id`s.
  - `/clear` gives a new Claude session id on the same pid, and startup can switch ids with no SessionEnd in between (S9). **Rebind rule:** any `SessionStart` whose Claude pid already maps to a live `sid` rebinds the new session id to that `sid`. `--resume` gives the same session id on a new pid, which rebinds to the `sid` that already knows the id. The pid comes from every hook (`X-Claude-Pid: ${CLAUDE_PID:-$PPID}`, S6) and from `agents --json` (S7).
  - Step binding and autopilot settings live on the `sid`, so they survive.

### 3.2 Entities

| Entity | Key fields | Notes |
|---|---|---|
| `user` | `id`, `name`, `email`, `roles_extra[]` | One person may have several `identity` rows |
| `identity` | `provider`, `subject`, `user_id`, `groups[]`, `last_login` | Unique on (`provider`, `subject`). Logging in with a different provider creates a separate user unless an admin links them (`mesh hub link-identity`). |
| `token` | `hash`, `user_id`, `kind` (`device`, `web`, `service`), `machine_id?`, `created_at`, `last_used`, `expires_at`, `revoked` | Opaque bearer tokens, stored as SHA-256 hashes (§4.3) |
| `machine` | `id`, `user_id`, `hostname`, `last_seen`, `online` | `online` = hub sync within 2 minutes |
| `session` (hub copy) | `sid`, `machine_id`, `user_id`, `repo`, `state`, `step_id?`, `autopilot`, `last_turn_at` | Only sessions holding a step are sent in full. Others are reported as **per-machine aggregate counts** (Q5), unless the machine opts in with `shareSessions: "all"` (`mesh setup --share-sessions all`): then they are sent as metadata only (no cwd, pane, pid, transcript or message text). |
| `goal` | `id` (`G<n>`), `title`, `owner_id`, `state`, `primary_repo`, `issue_url?`, `priority` | |
| `plan` | `goal_id`, `version`, `design_ref`, `steps_json`, `proposed_by`, `decision`, `decided_by`, `decided_at`, `comment` | Immutable once decided |
| `step` | `id` (`G17.dplane`), `goal_id`, `plan_version`, `kind`, `repo`, `title`, `brief` (required), `deps[]`, `state`, `holder_user?`, `holder_sid?`, `branch?`, `mr?`, `summary?`, `fix_cycles`, `outcome?` | `G<n>.design` exists from goal creation |
| `note` | `step_id`, `user_id`, `sid`, `text`, `at` | Handoff trail |
| `message` | `id`, `to_sid` or `to_step`, `from_user`, `text`, `state` (`pending`, `delivered`, `failed`), `method?`, `created_at`, `acked_at?` | **Hub outbox.** Daemons pull it and acknowledge (§5.4). |
| `event` | `id` (UUID), `seq`, `at`, `type`, `user_id?`, `sid?`, `goal_id?`, `step_id?`, `payload` | Append-only. Written in the same transaction as each state change. |
| `idempotency` | `key`, `user_id`, `response`, `at` | For mutating RPCs (§5.3) |

**Attention is computed per viewer, not stored.** It is a query over:

- designs awaiting approval that the viewer can approve;
- questions addressed to the viewer;
- stalled or failed steps on goals the viewer owns or holds;
- the viewer's own needs-you sessions.

### 3.3 Session state (`core/session-state.ts`)

There are two inputs:

- **observations** from the reconciler: `agents --json` entries with `status` (`busy`, `waiting`, `idle`), `waitingFor` and `pid`;
- **hook events.**

The reconciler wins whenever it has data for the session. Hook-only rules are the fallback when S7 fails, or for sessions it doesn't list.

| State | Reconciler rule (preferred) | Hook-only fallback |
|---|---|---|
| `needs_you(permission)` | `status=waiting`, `waitingFor=permission prompt` | `Notification(permission_prompt)`. Cleared by the next `Stop`/`UserPromptSubmit`, or by a transcript mtime change |
| `needs_you(dialog)` | `status=waiting`, `waitingFor=dialog open` (for example the workspace-trust dialog at startup, before any SessionStart) | — |
| `needs_you(question)` | `status=waiting`, `waitingFor=input needed`, **or** `idle` and the last turn asked the user (last `Stop.last_assistant_message` ends with a question, or `mesh_ask` was called this turn) | Same `last_assistant_message` rule |
| `working` | `status=busy` | `UserPromptSubmit` after the last `Stop` |
| `idle` | `status=idle` (this also covers interrupted turns, which fire no Stop hook, S1) | After `Stop`. `idle_prompt` **also means idle**, not needs-you. |
| `stalled` | `idle`, not a question, holding an unfinished step, for longer than `stall_after` (5 minutes) | Same |
| `quiet` (flag) | `working` and the transcript mtime is older than `quiet_after` (20 minutes) | Same |
| `ended` | The pid disappeared from `agents --json` | `SessionEnd` with reason ≠ `clear`; or no hooks and an unchanged transcript for 6 hours |

### 3.4 Steps, goals and the DAG (`core/dag.ts`)

**Step states:**

```
blocked → ready → claimed → done
                    │  ↘ paused → claimed (same user re-binds, or take-over)
                    ↘ failed
done → ready (reopened by a failing dependent; fix_cycles += 1)
any (not done) → dropped (replan)
```

- **`paused`:**
  - the holder session ended with reason `logout`, `prompt_input_exit` or `other`, after a 2-minute grace period; **or**
  - the holder's machine has been offline for longer than 15 minutes.
- **The hub derives a step's `stalled` flag** from the holder session's synced state.
- **Goal states:** `backlog → design → awaiting_approval → in_progress → done`. A revise sends the goal back to `design`. Any state can move to `dropped`.
- **Validation on `mesh_plan`:**
  - unique ids;
  - dependencies exist;
  - no cycles;
  - 1–50 steps;
  - every step has `repo`, `kind`, `title` and `brief`.

  Errors are returned in a form the agent can fix ("step `e2e`: dep `agnt` not found; did you mean `agent`?").
- **Ready:** every dependency is `done` or `dropped`.
- **Replan (v(n+1)):**
  - done steps stay;
  - steps with the same id keep their state;
  - steps whose brief changed and that are claimed get a note for the holder, and a message;
  - removed steps become `dropped`.

  (Matching by brief hash is cut.)

### 3.5 Claims (`core/claims.ts`)

- A claim is a single conditional `UPDATE … WHERE state IN ('ready') OR (state IN ('claimed','paused') AND holder_user = :me)` inside the writer transaction. The last clause lets the same user re-bind the claim to a new session.
- **Take-over** of a `paused` step, or one flagged `stalled`, is allowed:
  - after `takeover_after` (4 hours) for any member;
  - at any time for the goal owner or an admin.

  It records `step.taken_over`, and the previous holder gets a message.

### 3.6 Autopilot (`core/autopilot.ts`)

`decide(session, step, policy, now) → Action | null`:

| Action | When |
|---|---|
| `nudge` | `stalled` (never `needs_you`), level ≥ `nudge`, fewer than 2 nudges for this step |
| `escalate` | 2 nudges and still stalled. The step is flagged, so it appears in Attention. |
| `assign_next` | Level `chain`, step `done`. The next step is the first ready **direct dependent in the same repo**, else any ready step of the same goal in the same repo, else nothing. |

**Autopilot ships in M2**, when real steps exist. M1 has no local "task" concept.

### 3.7 Step record (`core/step-record.ts`)

`render(step, facts) → markdown` with YAML front matter (format in the journeys document §3.1).

`human_prompts` counts `UserPromptSubmit` events **minus** turns started by mesh deliveries. The daemon tags each delivery and matches it to the next prompt by timestamp and text prefix.

---

## 4. Authentication and authorization (decoupled)

### 4.1 Shape

```
             login only (hub-mediated)                              every request
CLI / web ─► hub /auth ─► AuthProvider (none | token | oidc: Kanidm, Keycloak, Authentik, GitLab, …) ─► Principal
                                   │
                                   ▼
                   hub upserts user + identity, maps groups → roles, issues an opaque hub token
                   (device token for CLI/daemon, cookie session for web, service token for mesh-ai)
```

The **hub is the only OIDC client.** It holds one redirect URI and the client secret, if the IdP needs one. Laptops never hold IdP secrets or IdP tokens.

### 4.2 Provider port (`src/auth/types.ts`)

```ts
export interface Principal {
  provider: string;            // provider instance id from config, e.g. "kanidm"
  subject: string;             // stable id at that provider
  name?: string; email?: string;
  groups: string[];            // normalized per provider config
}

export type FlowKind = "none" | "token" | "redirect" | "device";

export type StartResult =
  | { kind: "redirect"; url: string }                        // hub stores state/nonce/PKCE itself
  | { kind: "device"; userCode: string; verifyUrl: string; pollId: string; interval: number }
  | { kind: "immediate" };                                   // none/token

export interface AuthProvider {
  readonly id: string;
  readonly kind: "none" | "token" | "oidc";
  flows(): FlowKind[];
  start(flow: FlowKind, ctx: { state: string; nonce: string; pkceChallenge: string; redirectUri: string }): Promise<StartResult>;
  complete(flow: "redirect", p: { code: string; pkceVerifier: string; redirectUri: string; nonce: string }): Promise<Principal>;
  complete(flow: "device", p: { pollId: string }): Promise<Principal | "pending">;
  complete(flow: "token", p: { token: string }): Promise<Principal>;
  complete(flow: "none", p: Record<string, never>): Promise<Principal>;
}
```

The hub owns all login state: `state`, `nonce` and PKCE verifiers, kept in a `login_attempt` table with a 10-minute TTL. Providers are stateless.

**Providers in v1:**

| Provider | Use | Notes |
|---|---|---|
| `none` | Solo or local use | The hub refuses to listen on a non-loopback address. Every request is user `local` with role `admin`. |
| `token` | CI, small teams, break-glass | Config `users: [{name, token_sha256, groups}]`. Constant-time compare. |
| `oidc` | Kanidm, Keycloak, Authentik, GitLab, Google… | Discovery through `openid-client`. Auth code + PKCE (the hub as a confidential or public client). Device flow when discovery advertises it. `groups_claim` (default `groups`) and `group_normalize` (`strip_domain`, `lowercase`) are configurable. |

**Kanidm is a preset**, not code (`presets/kanidm.yaml`):

- issuer `https://<idm>/oauth2/openid/<client_id>`;
- `groups_claim: groups`;
- `group_normalize: [strip_domain]`, so `mesh-approvers@idm.lab` becomes `mesh-approvers`.

A non-OIDC provider (GitHub OAuth, LDAP, mTLS) is one new file implementing the port.

**Config sketch** (`mesh-hub.yaml`):

```yaml
auth:
  providers:
    - id: kanidm
      kind: oidc
      preset: kanidm
      issuer: https://idm.lab/oauth2/openid/mesh
      client_id: mesh
      client_secret_env: MESH_KANIDM_SECRET
      roles: { approver: [mesh-approvers], admin: [mesh-admins] }   # per-provider mapping
    - id: ci
      kind: token
      users: [{ name: mesh-ai, token_sha256: "…", groups: [service] }]
  bootstrap_admins: ["kanidm:3c0f…"]      # provider:subject, first-admin bootstrap
  session: { device_max_age: 14d, device_idle: 7d, web_idle: 12h }
```

### 4.3 Hub tokens: opaque and boring (`src/auth/tokens.ts`)

- **Device token** (CLI and daemon on one machine): 32 random bytes, sent as `Authorization: Bearer`. Stored hashed. Limited by an idle timeout (7 days) and an absolute lifetime (14 days). **There is no refresh flow,** so nothing can race on refresh. When it expires, `mesh login` again; the daemon raises one Attention ("log in again") and keeps spooling meanwhile.
- **Roles are re-evaluated at every login** from the provider's groups. With the 14-day absolute lifetime, stale roles last at most 14 days. Admins can revoke at once (`mesh hub revoke --user | --machine | --token`).
- **Web session:** an `HttpOnly`, `Secure`, `SameSite=Lax` cookie holding a `web` token. Every non-GET request must carry an `Origin` matching the hub URL. `EventSource` uses the cookie, which fixes SSE auth for browsers.
- **Service token** (`kind: service`, created with `mesh hub token create --service mesh-ai`): read-only access to `/v1/events`.

### 4.4 CLI login (`src/auth/login.ts`, hub-mediated)

1. `GET /auth/providers` returns the list of `{id, kind, flows}`. The CLI asks only if there are several.
2. **redirect:**
   1. The CLI starts a localhost listener on a random port and creates its own PKCE pair (`cv`, `cc`).
   2. It opens `HUB/auth/<id>/start?cli_port=P&cli_challenge=cc`.
   3. The hub runs OIDC with the IdP, then redirects to `127.0.0.1:P/callback?code=<one-time>`.
   4. The CLI posts `POST /auth/cli/exchange {code, cv}`. The hub checks `cv` against `cc`, which defeats interception of the one-time code by other local processes, and returns the device token.
3. **device:** `POST /auth/<id>/device` returns a user code and URL. The CLI polls `POST /auth/<id>/device/poll` and receives a device token.
4. **token:** the CLI prompts for the token and posts `POST /auth/<id>/token`, receiving a device token.
5. The token is stored in `~/.config/mesh/credentials.json` (mode 0600), which the daemon and CLI share.

### 4.5 Authorization (`src/core/roles.ts`)

**Roles:** `member` (any authenticated user), `approver`, `admin`, `service`. Source: provider group mapping, plus `roles_extra`, plus `bootstrap_admins`.

| Action | Rule |
|---|---|
| Read `/v1` | `member` |
| Create goal, claim, note, done, plan proposal, message | `member` |
| Approve or revise a plan | Goal owner, `approver` or `admin` |
| Take over before `takeover_after` | Goal owner or `admin` |
| Revoke tokens, link identities, delete goals, manage roles | `admin` |
| Session/machine sync | Only for the token's own user and machine |
| `/v1/events` | `service` or `admin` |

**Every route declares its rule in the route table.** A test asserts that no route is missing one.

**Solo mode** is the hub running **in-process** inside `mesh up --solo`, with the `none` provider and a local database. It is the same code, with no second backlog implementation.

---

## 5. Protocol

### 5.1 Hooks installed by `mesh setup` (user settings `~/.claude/settings.json`)

| Event | Type | Command / URL | Blocking |
|---|---|---|---|
| `SessionStart` | `command`, `async: true` | `curl -s -m 2 -o /dev/null --data-binary @- -H "X-Mesh-Key: <secret>" -H "X-Mesh-Hooks: 2" -H "X-Mesh-At: $(date +%s%N)" -H "X-Claude-Pid: ${CLAUDE_PID:-$PPID}" -H "X-Tmux-Pane: ${TMUX_PANE:-}" -H "X-Tmux: ${TMUX:-}" http://127.0.0.1:<port>/mesh/hook/session-start` | no |
| `UserPromptSubmit` | same, `/hook/prompt` | | no |
| `Notification` | same, `/hook/notification` | | no |
| `SessionEnd` | same, `/hook/session-end` | | no |
| `Stop` | `http`, `timeout: 3`, headers `X-Mesh-Key`, `X-Mesh-Hooks` | `http://127.0.0.1:<port>/hook/stop` | yes, briefly. The reply is `{}`, or `{"hookSpecificOutput":{"hookEventName":"Stop","additionalContext":"<message>"}}` when a message is queued and `stop_hook_active` is false. |

- **`UserPromptSubmit` carries the full prompt text. The daemon never stores it;** it keeps only `prompt_id` and the length (S2).
- `<port>` and `<secret>` are per user, generated by `mesh setup` and stored in `~/.config/mesh/daemon.json` (mode 0600).
- `mesh doctor` checks for `curl` and that the Claude Code version is at least the minimum confirmed in M0.
- A dead daemon means the curl calls fail silently and the Stop hook errors quickly. Neither blocks the session.

### 5.2 MCP

- Installed with `claude mcp add -s user mesh -- mesh mcp` (stdio).
- `mesh mcp` reads its parent pid (the Claude process, confirmed in S6), connects to the daemon's local API with the secret, and sends that pid with every call. The daemon maps pid → `sid`. The MCP process's `CLAUDE_CODE_SESSION_ID` environment variable is **not** used, because it goes stale after `/clear` (the MCP server isn't restarted).
- **Tools:** `mesh_context`, `mesh_next`, `mesh_claim`, `mesh_release`, `mesh_note`, `mesh_done(summary, branch?, mr?, outcome?, reopen?)`, `mesh_ask`, `mesh_plan(goal, design_ref, steps[])`.
- Each mutating tool call carries an idempotency key, generated by the daemon per tool-call id.

### 5.3 Online RPC vs spooled observations

| Class | Examples | Offline behaviour |
|---|---|---|
| **Observations** (daemon → hub, spooled) | Session state changes, turn starts and stops, deliveries | Spooled locally with event UUIDs. Replayed in order. The hub deduplicates on UUID. |
| **Commands** (online RPC with an idempotency key) | `claim`, `release`, `note`, `done`, `plan`, `approve`, `take`, `message` | Fail fast with a clear error to the agent or user ("hub unreachable; retry later"). Never spooled, because a stale claim or done is worse than a retry. |

### 5.4 Hub ↔ daemon messages

- Messages and assignments for a machine go into the hub `message` table.
- The daemon pulls with `GET /v1/inbox`, then delivers, then calls `POST /v1/inbox/:id/ack {method}`.
- `GET /v1/stream` (SSE) only sends `wake` hints and dashboard updates, so losing an SSE connection loses nothing.

### 5.5 Events

`session.started`, `session.rebound`, `session.turn_started`, `session.turn_stopped`, `session.waiting`, `session.ended`, `session.nudged`, `goal.created`, `goal.state_changed`, `plan.proposed`, `plan.approved`, `plan.revised`, `step.ready`, `step.claimed`, `step.noted`, `step.released`, `step.paused`, `step.taken_over`, `step.done`, `step.failed`, `step.reopened`, `step.dropped`, `message.delivered`.

The envelope is `{schema: "mesh.harness.v1", id, seq, at, type, user, sid?, goal?, step?, payload}`. **mesh-ai pulls** with `GET /v1/events?after=<seq>&limit=` using a service token. There is no push export.

### 5.6 Hub HTTP API (summary)

| Method and path | Purpose |
|---|---|
| `GET /auth/providers`, `GET /auth/:id/start`, `GET /auth/:id/callback`, `POST /auth/cli/exchange`, `POST /auth/:id/device`, `POST /auth/:id/device/poll`, `POST /auth/:id/token`, `POST /auth/logout` | Auth |
| `POST /v1/machines`, `POST /v1/sync`, `GET /v1/inbox`, `POST /v1/inbox/:id/ack` | Daemon |
| `GET /v1/me`, `GET /v1/live`, `GET /v1/attention`, `GET /v1/stream` | Dashboard |
| `GET/POST /v1/goals`, `GET /v1/goals/:id`, `POST /v1/goals/:id/{plan,approve,revise,replan}` | Goals |
| `GET/POST /v1/topics`, `POST /v1/topics/:name/delete`, `POST /v1/goals/:id/topics`, `GET /v1/goals?topic=a,b` | Topics: labels for goals (v0.1.8). Every goal is in `all`; a filter with several topics means all of them |
| `GET /v1/steps?ready=1&repo=`, `GET /v1/steps/:id/context`, `POST /v1/steps/:id/{claim,release,note,done,take}` | Steps |
| `POST /v1/messages` | Messages |
| `GET /v1/fleet`, `POST /v1/machines/:id/name` | My mesh (v0.1.9): the caller's machines and their sessions; name a machine |
| `GET /v1/events?after=` | Analysis feed |

---

## 6. Daemon (`mesh up`)

1. **Listener.** `127.0.0.1:<per-user port>`.
   - Every route requires `X-Mesh-Key`.
   - Requests with a non-local `Host` are rejected.
   - Any request with an `Origin` header is rejected, which blocks browser CSRF and DNS rebinding.
   - Routes: `/hook/*`, `/mcp/*` (from the shim), `/local/*` (TUI and CLI).
   - **There is no local web UI.**
2. **Hook receiver.** It appends to the local SQLite (`~/.local/state/mesh/daemon.db`), updates the reducer and replies within 50 ms. Stop replies with queued `additionalContext`.
3. **Reconciler.**
   - Polls `claude agents --json` every 5 seconds (spike S7).
   - Maps `pid ↔ sid ↔ session_id`.
   - Takes the tmux pane and server from the hooks' `X-Tmux-Pane`/`X-Tmux` headers (`$TMUX_PANE`, `$TMUX`), so no process-tree walk is needed. Sessions without hooks still appear through `agents --json`, but without a pane (no jump or paste).
   - Checks transcript modification times every 30 seconds.
4. **Delivery** (`deliver(sid, text)`), first match wins:
   1. The session is `working`: queue the message for the next `Stop` (as `additionalContext`, only when `stop_hook_active` is false).
   2. The session is `idle` or `stalled`, the reconciler confirms `status=idle` with **no `waitingFor`**, and it has a tmux pane: `tmux load-buffer -` then `paste-buffer -p -t <pane>` (bracketed paste), then a separate `send-keys -t <pane> Enter`.
   3. The session is a background session in `state: done` with no `waitingFor`: `claude stop <id>`, then `claude --resume <session_id> --bg <text>`. This wakes it in place with its saved options. A plain `--resume --bg` on a live process starts a copy without our hooks, so it is never used (S4).
   4. Otherwise: a TUI badge plus a desktop notification (`osascript` or `notify-send` when available).

   Each delivery is recorded with its method, and is tagged so it isn't counted as a human prompt.
5. **Hub client.**
   - registers the machine;
   - sends spooled observations through `POST /v1/sync` (batched, with UUIDs);
   - pulls the inbox (on SSE `wake`, and every 30 seconds);
   - proxies RPCs from the MCP shim and CLI.
6. **Autopilot runner** (M2). Every 15 seconds and on each event, it calls `core/autopilot.decide` and runs the result through delivery.
7. **Service install.** `mesh up --install` writes a systemd user unit or a launchd agent.

**Background sessions.** mesh lists them and delivers to them through `claude --resume --bg`. To look inside one, it hands off to Claude Code itself: jump runs `claude attach <id>`. mesh does not re-implement agent view.

---

## 7. `mesh run`

`mesh run <repo…> [--step S | --design G] [--auto off|nudge|chain] [--bg] [--model M]`:

1. Resolves repos through repo-id and discovered checkouts. It refuses unknown repos.
2. Claims the step on the hub when one is given. This is an online RPC.
3. Opens a tmux window per repo in the `mesh` tmux session (created if missing) running `claude -n "<label>" [--model M]`.
   - For a step: the first prompt is "You hold step S. Start with mesh_context."
   - For `--design`: it adds `--add-dir` for the related repos named in the goal.
   - With `--bg`, it uses `claude --bg` instead.
4. **Workspace trust.** The trust dialog in a new folder defaults to "No, exit" ([spikes README](../spikes/README.md)). `mesh run` never sends keys at startup. The session shows as `needs_you(dialog)` until the person accepts trust in that window.
5. With `--lane`: deferred (`docs/later.md`). Claiming several ready steps works by running `mesh run` once per step.

---

## 8. Hub (`mesh hub`)

- A Hono app on `@hono/node-server`, with SQLite (`node:sqlite`, WAL) and numbered SQL migrations.
- **Single writer:** every mutation goes through `hub/service.ts`. Each one is a single transaction that writes the state change, an event and the idempotency record.
- **SSE** from an in-process bus. Clients resume with `Last-Event-ID`. Losing events is acceptable because SSE is only a hint channel.
- Serves `web/dist` statically.
- **Config:** `mesh-hub.yaml` plus `MESH_HUB_*` environment overrides.
- **Backup:** `mesh hub backup <file>` uses SQLite's online backup.

---

## 9. User interfaces

- **TUI** (`mesh`): a plain ANSI renderer with raw-mode keypresses, about 300 lines, no React.
  - **Groups:** NEEDS YOU / WORKING / STALLED·QUIET / DONE / IDLE.
  - **Keys:** `⏎` jump, `s` say, `a` autopilot (M2), `n` next step (M2), `g` goals (M3), `q` quit.
  - **Jump:** `tmux switch-client -t <pane>` (or `select-window` inside the same tmux server); `claude attach <id>` for background sessions.
- **Web dashboard**, three pages:
  1. **Live:** online people and machines, sessions (step-holding ones in detail, other sessions as counts), Attention for the viewer, and an activity strip.
  2. **Goals board:** Backlog, Design, Awaiting approval, In progress, Done.
  3. **Goal:** DAG (React Flow, laid out by depth, no critical-path rendering yet), step panel (holder, state, notes, summary, MR, facts), Design tab (rendered design link, plan versions, approve/revise), and a timeline.

  People and Activity are sections of Live. The local "My sessions" page is cut, because the TUI covers it.

---

## 10. Milestones and tasks

Sizes: **S** ≤ 1 day, **M** 2–3 days. Total estimate: **about 14–16 weeks for one developer**, about 9 weeks for two working in parallel after M1a.

### M0. Spikes and skeleton (week 1)

| # | Task | Size | Acceptance |
|---|---|---|---|
| 0.1 | Skeleton: pnpm, TS strict, tsdown, vitest, eslint, dependency-cruiser, CI (lint, typecheck, test, build) on Linux and macOS (tmux installed) | S | CI green; a boundary violation fails CI |
| 0.2 | **S1** Stop HTTP hook returning `additionalContext` continues the turn, `stop_hook_active` behaviour, a 3-second timeout with the daemon down | S | `docs/spikes/s1.md` + payload fixtures |
| 0.3 | **S2/S3** Payloads of the 5 hooks (`session_id`, `cwd`, `transcript_path`, `source`/`reason`, `last_assistant_message`); `Notification` types seen in terminal sessions; async command hooks | S | Fixtures tagged with the Claude Code version |
| 0.4 | **S6** `$PPID` in an async command hook equals the Claude pid; the `mesh mcp` stdio shim's ppid equals the same pid | S | Notes; decides the pid binding |
| 0.5 | **S7** `claude agents --json` lists **interactive** sessions with `pid`, `status`, `waitingFor`; polling cost | S | Notes. If it does not, state rules switch to the hook-only fallback (§3.3). |
| 0.6 | **S8** Bracketed paste into a pane with a permission dialog open (must not approve), and into an idle prompt | S | Notes + a guard rule |
| 0.7 | **S9** Session id behaviour across `/clear`, `--resume`, compaction and `--resume --bg` (S4) | S | Notes + rebind rule fixtures |

**Exit:** each spike is green, or the fallback has been written into §3, §5 or §6.

**Status: done.** All spikes green; S4 changed delivery path 3 (§6.4). Results are in [docs/spikes](../spikes/README.md), and fixtures for Claude Code 2.1.314 and 2.1.317 are in `test/fixtures/claude/`.

### M1a. Local visibility (weeks 2–3)

| # | Task | Size | Acceptance |
|---|---|---|---|
| 1.1 | `protocol` hook schemas (loose: unknown fields kept); `core/repo-id` | S | M0 fixtures parse; repo-id table tests |
| 1.2 | `store` wrapper + daemon migrations | S | Migrate from empty and with data |
| 1.3 | `core/session-state` (reconciler + hook rules, injected clock) | M | Table tests per transition, including `/clear` rebind, an agent ending with a question, `idle_prompt` meaning idle, and a crash without SessionEnd |
| 1.4 | `claude/installer`: hooks + MCP + CLAUDE.md block; `mesh setup`, `--uninstall`, `mesh doctor` | M | Golden files; uninstall restores the original byte for byte; doctor detects each failure |
| 1.5 | Daemon listener (key, Host and Origin checks), hook receiver, reconciler, tmux pane mapping | M | Fake-claude scenarios; security tests (no key → 401, Origin → 403) |
| 1.6 | ANSI TUI with jump; desktop notification on needs-you | M | Snapshot tests; jump calls tmux in a `tmux -L test` server |
| 1.7 | `mesh up --install` | S | Golden unit files |

**Exit:** a developer sees all their Claude sessions, sorted by needs-you, and jumps to them. Worth a week of daily use before going further.

**Status: done.** Notes:

- `mesh setup` installs the five hooks only. The MCP server and the `CLAUDE.md` block move to task 2.6, when the MCP tools exist.
- The daemon uses plain `node:http`; `hono` arrives with the hub.
- Desktop notifications live in `mux` (`mux/notify.ts`).
- `mesh up --install` writes the launchd/systemd file and prints the enable command; it does not load it.

### M1b. Talking to sessions (week 4)

| # | Task | Size | Acceptance |
|---|---|---|---|
| 1.8 | `mux/tmux`: paste-buffer delivery with the S8 guard | S | A dialog-open case never receives keys |
| 1.9 | Delivery chain (Stop `additionalContext`, paste, `--resume --bg`, notify) + `mesh say` + TUI `s` | M | Each path covered by fakes; method recorded |
| 1.10 | `mesh run` (tmux windows, labels, `--bg`) | S | e2e with fake claude |

**Status: done.** `mesh run` creates a `mesh` tmux session whose window 0 runs the TUI, plus one window per repo, and binds `prefix + m` back to the TUI (`--no-bind` to skip). Verified end to end against Claude Code 2.1.317 with `pnpm spike e2e`: tracking, paste delivery, the dialog guard, Stop-hook delivery, question detection, `/clear` rebind, the TUI and `/exit` all pass.

### M2a. Hub core with simple auth (weeks 5–6)

| # | Task | Size | Acceptance |
|---|---|---|---|
| 2.1 | Auth port + `none` + `token` providers + provider contract suite | S | Suite green for both |
| 2.2 | `auth/tokens` (opaque device/web/service tokens, idle and absolute expiry, revoke) + `core/roles` + route-table authorization test | M | Every route has a rule; expiry and revoke tests |
| 2.3 | Hub skeleton: config, migrations, `/auth/*` for none and token, `/v1/me`, `mesh login` / `logout` / `whoami` | M | Integration tests |
| 2.4 | Daemon ↔ hub: machine register, `/v1/sync` (UUID deduplication), inbox pull and ack, SSE wake, offline spool | M | Offline then replay with no duplicates; a daemon DB reset doesn't drop events; SSE drop loses no messages |
| 2.5 | Goals, steps (manual DAG via `mesh goal plan G --file plan.yaml`), claims (conditional update, re-bind), notes, done with `outcome`/`reopen`, take-over, paused rules, idempotency keys | M | Parallel claim test (exactly one winner); retried done is applied once; fix-cycle counting |
| 2.6 | `mesh mcp` shim + the 8 tools via the daemon | M | MCP client test per tool; pid binding |
| 2.7 | Autopilot `nudge` + `chain` (runner in the daemon) | M | Stalled → nudge, nudge, escalate; questions never nudged; chain picks per §3.6 |

**Exit:** two developers using token auth share a goal with a manual DAG, claim steps in different repos, autopilot chains steps, and one take-over has been done.

**Status: done.** Covered by `test/hub.test.ts` (auth, claims, fix cycles, idempotency, pause and take-over, SSE wake, inbox), `test/m2-flow.test.ts` (two daemons, MCP tools, chain, messages, questions, nudge/escalate, `mesh run --step` binding) and `pnpm spike e2e-m2` against real Claude Code (the agent completed `G1.alpha`, autopilot handed it `G1.beta`, the goal finished). Notes:

- The hook commands also send `X-Mesh-Autopilot` and `X-Mesh-Step` (from `$MESH_AUTOPILOT`/`$MESH_STEP` set by `mesh run`), so a session started for a step binds itself. `mesh doctor` reports older hooks as out of date; re-run `mesh setup`.
- `mesh setup` now also registers the `mesh` MCP server (`claude mcp add -s user`) and adds the `CLAUDE.md` block (task 2.6); `--no-mcp` skips both; `--uninstall` removes everything exactly.
- `mesh_ask` marks the session so the end of its turn reads as needs-you even if the last message isn't a question.
- Solo mode is `mesh hub` on loopback with the default `none` provider, plus `mesh login --hub http://127.0.0.1:7700`; an in-process hub inside `mesh up` is in `docs/later.md`.

### M2b. Web + OIDC (weeks 7–8)

| # | Task | Size | Acceptance |
|---|---|---|---|
| 2.8 | `oidc` provider: discovery, redirect + PKCE (hub-mediated), CLI exchange with a CLI-side PKCE, device flow if advertised, group normalization, Kanidm preset, `bootstrap_admins` | M | Contract suite against the mock issuer; a manual check against Kanidm |
| 2.9 | Web sessions (cookie, Origin check), web login | S | Integration tests |
| 2.10 | Web: Live page (people, machines, sessions, attention, activity) | M | Playwright smoke test |

**Status: done.** OIDC is generic with a Kanidm preset; the contract suite runs against a mock issuer (code + PKCE, userinfo fallback, device flow) and the hub-mediated CLI and web flows are tested end to end (`test/hub.test.ts`, `test/cli-login.test.ts`). Not yet checked against a real Kanidm instance. The web app is React + Vite without TanStack Query (a small fetch + SSE hook was enough); `pnpm test:web` runs the Playwright smoke test against the built hub.

### M3. SDD (weeks 9–11)

| # | Task | Size | Acceptance |
|---|---|---|---|
| 3.1 | Goal lifecycle with an implicit design step; `mesh run --design` with `--add-dir` | S | State tests |
| 3.2 | `mesh_plan` validation with fixable errors → plan vN pending | S | Error message tests |
| 3.3 | Approve/revise (CLI, API, web); revise delivered to the design session; replan rules | M | Replan table tests |
| 3.4 | Step records + plan files returned for commit (`.mesh/goals/<G>/…`) | M | Golden files; facts from events (human prompts exclude deliveries) |
| 3.5 | Web: Goals board + Goal page (DAG, step panel, design tab, timeline, approve) | M | Playwright: design → approve → steps visible |
| 3.6 | `mesh show G`, `mesh next`, `mesh take`; TUI `g` and `n` | S | Snapshot tests |

**Exit:** a real goal goes design → revise → approve → steps in two repos by two people → done, with step records committed in MRs.

**Status: done.** `pnpm spike e2e-m3` runs this against real Claude Code (two people, two daemons, two repos): the design session wrote the design and proposed plan v1 with `mesh_plan`, re-proposed v2 after `mesh goal revise`, the approved plan file was written into the design repo, alice and bob each finished a step in their repo with the step record committed, a review step followed, and the goal finished. In-process coverage: `test/m3-flow.test.ts`, `src/core/trail.test.ts`, `src/cli/show.test.ts`, `test/e2e-web/goals.spec.ts`. Notes:

- The daemon writes trail files into the session's repo (`.mesh/goals/<G>/goal.yaml`, `plan.vN.yaml` on `mesh_plan` and again on approval, `steps/<id>.md` on `mesh_done`), and the tool result asks the agent to commit them. Hub messages carry structured `data` (migration 2) so the daemon knows which plan to write on approval.
- Step facts (turns, human prompts, nudges, waits, holders, models, fix cycles) are computed on the hub from the events daemons sync; delivered prompts are excluded from human prompts.
- `POST /v1/goals/:id/replan` (`mesh goal replan`) opens the design step again; the next proposal follows the replan rules.
- Web: Goals board, Goal page with an SVG DAG laid out by depth (no React Flow), step panel with facts, Design tab with plan versions and step-level diffs, approve/revise, Timeline. Hash routing, no router library.
- Design contributors and critical-path highlighting stay in `docs/later.md`.

### M4. Local-first, workflow capture, ledger, analysis feed + hardening (weeks 12–16)

**First, local-first and workflow capture** ([design](../analysis/2026-11-04-local-first-and-workflow-capture.md), owner decisions 11–14). The process lives in the repo's agents and workflows and never calls mesh. mesh runs in two modes, Team and Solo, and everything keeps working without the hub.

| # | Task | Size | Acceptance |
|---|---|---|---|
| 4.0.1 | **Local hub in the daemon**: the same `HubService` on the daemon's SQLite; Solo when no hub is configured; tools go to the local hub first | M | T3: a full Solo goal with records |
| 4.0.2 | **Replication with the team hub**: local copies of held goals and steps, outbox up, pull down, idempotent; conflict rule: first claim at the hub wins (decision 16). Publishing locally created goals waits for the goal model (decision 15). | M | T2, T4 |
| 4.0.3 | **Circuit breaker** on the hub link: fail fast after the first failure, background probe, status in TUI and `mesh status` | S | T1 |
| 4.0.4 | **Records rendered by the daemon** (same `core/trail.ts`) | S | Offline `mesh_done` writes the record |
| 4.0.5 | **Workflow capture**: `SubagentStart`/`SubagentStop` hooks (7 in total); read `journal.jsonl`, `agent-*.meta.json` and `workflows/<run>.json`; label → record key (the team's id as written) and round, no mesh goal needed; typed result → round data; pending records in `<git-common-dir>/mesh/pending/`; `mesh ledger stage <id>`; backfill on daemon start | M | T5 with captured fixtures |
| 4.0.6 | **Canonical workflows** in `architecture-and-standards/claude-assets/workflows/`: labels already `<role>:<row>[:<round>]` and schemas on every `agent()`; add criteria and finding-count fields and one optional `mesh ledger stage` line. **Done on branch `chore/mesh-ledger-capture` (`b581ae9`), not pushed.** | S | Runs unchanged without mesh |
| 4.0.7 | **`pnpm spike e2e-offline`**: no daemon / hub blackholed / hub restored mid-run / Solo, real Claude | M | T7 |

The ledger rule: durable, generated summaries are committed in git (the ledger); precise and live-only data stays in hub events, kept N days. No hand-written ledger fields: everything comes from hooks, events and tool arguments.

| # | Task | Size | Acceptance |
|---|---|---|---|
| 4.1 | `GET /v1/events?after=` + service tokens; JSON Schema generated from `protocol` (`schemas/`, `docs/events.md`), checked for drift in CI | S | mesh-ai can page the full log |
| 4.2 | `mesh hub backup`; event retention option (R6); the ledger rule documented | S | Old events pruned; a backup restores |
| 4.3 | `pnpm test:claude`: M0 spikes as a contract suite against the installed Claude Code, including the subagent hooks and the workflow file formats (T6) | S | Runs on demand or nightly |
| 4.4 | Docs: overview, concepts, install, auth (providers + Kanidm preset), operations, ledger format | S | |
| 4.5 | **`mesh.ledger.v1` schema** (R1): `schema` and `record: goal\|plan\|step` on every trail file; zod in `protocol/`; unknown fields allowed | S | Golden files validate; old records still parse |
| 4.6 | **Provenance per segment** (R2): `segments[]` with sid, user, from/to, model + `model_source` (`hook` from `SessionStart`, `agent` from the optional `model` argument of `mesh_done`), effort and permission_mode (from `Stop`, kept instead of dropped), Claude Code version, harness hash, repo commit, mesh version, turns, human prompts, nudges, waits. Plans carry `{version, approved_by, approved_at}`. No token usage. | M | A step taken over by a second person shows two segments with their own models |
| 4.7 | **Harness hash**: repo `CLAUDE.md` + `.claude/**`, the user's `~/.claude` `CLAUDE.md`/agents/skills, plugin names and versions, mesh version; one combined hash plus one per part | S | Editing a user skill changes only that part's hash |
| 4.8 | **Round history** (R3): `rounds[]` in step records, so a later `mesh_done` adds a round instead of overwriting | S | A reopened step keeps both rounds |
| 4.9 | **A record for every stage**: the design step gets a record when its plan is approved (today it closes without one); review and test steps keep their rounds; plan files carry the approval | S | e2e-m3 leaves a design record |
| 4.10 | **`superseded` plan decision** (R4): a pending plan replaced by a new proposal is `superseded`, not `revised` | S | Design rounds count only human `revised` |
| 4.11 | **`mesh ledger export`** (R5): reads `.mesh/goals/**` from configured checkouts at a ref (default `origin/HEAD`), validates `mesh.ledger.v1`, writes JSONL, one line per record; optional join with `/v1/events` | M | mesh-ai imports the JSONL |
| 4.12 | **Artefact links** (C7): optional `artifacts: [{path, sha}]` and `refs` (spec id, backlog row) on `mesh_done` and goals | S | Records point at the team's spec, review and evidence files |
| 4.13 | **Goal roll-up** (C8): at goal done, `goal.yaml` gets totals per stage (rounds, cycles, buckets, parks, people, models, harness hashes, lead time) | S | A finished goal has a retro record with no agent involved |
| 4.14 | mesh-ai side (its own backlog): JSONL import, Flow/Quality/Models/People views | — | Tracked in mesh-ai |

**Status: done (2026-11-04).** All M4 tasks are built and tested. The checks:
- `pnpm check`: 298 tests, plus the Playwright web tests;
- `pnpm test:claude` (the new contract suite, green on Claude Code 2.1.318);
- `pnpm spike e2e-offline`: a five-agent programme run four ways against real Claude Code. It finished every time in 11–12 s, the same as with no mesh, and left records of the same shape;
- `e2e-m2` and `e2e-m3` re-run green.

Notes and deviations:

- **Local-first.**
  - *Solo:* `mesh up` starts a local hub inside the daemon: the same hub code, on loopback, with its own `solo-hub.db`, the `none` provider and `$USER` as the user, and the web dashboard. The daemon and the CLI use it whenever no team credentials exist (`--no-solo` skips it).
  - *Team, offline:* the daemon keeps the context of held steps, renders records from its own event log, and queues notes, releases, questions and results. Goals are not replicated in full; publishing goals created offline waits for the goal model (decision 15).
  - *Fail fast:* the first call to a dead hub costs up to 10 s; after that, calls fail at once until a background probe (5 s, backing off to 60 s) gets through. Then the outbox and queued calls are sent once. A refused result becomes a note on the step plus the local record (decision 16).
- **Workflow capture.**
  - It uses the two subagent hooks. Claude Code's files are read at SubagentStop and again at +2 s and +15 s (the journal's result line can land late).
  - Missed runs are backfilled on start (the first time, the last 7 days) and every 10 minutes after that. `MESH_BACKFILL=off` disables backfill; test daemons use it.
  - Records go to `<git common dir>/mesh/pending/<key>/`. Each subagent produces one `agent.finished` hub event with a stable id.
- **Provenance:**
  - a `session.provenance` event when a session takes a step (Claude Code version, harness hash, repo commit, mesh version);
  - `turn_stopped` carries effort and permission mode;
  - `model_source` is hook, agent or workflow.
  - Print-mode sessions send no model on SessionStart (known since M0); their subagents' models come from Claude Code's workflow files.
- **Hub.**
  - Every step keeps `rounds` and `roundStartedAt`; records carry `plan_approved`.
  - The design step gets a round and a record on approval; it is served with the goal files and written by the design session's daemon.
  - When the goal is done, `goal.yaml` carries a `rollup`.
  - `superseded` plan decision; `events_retention_days` (default 180) with pruning; `mesh hub backup` (VACUUM INTO).
- **Feed.** The events endpoint and service tokens existed since M2. M4 adds:
  - `schemas/*.json`, generated by `pnpm schemas` and checked for drift by a test;
  - `docs/events.md`;
  - `mesh ledger export` (validated JSONL, `--events`).
- **Docs.** `docs/guide/` has overview, concepts, install, auth, operations and the ledger.
- **Not in this repo.** 4.0.6, the canonical workflow change, is on branch `chore/mesh-ledger-capture` in `architecture-and-standards` (commit `7523301`, author and committer Ghost <ghost@writer.com>), pushed for review; merging it is the owner's call.
- **Found on the way.**
  - `e2e-m2`'s goal-done check still matched the pre-M3 `goal show` format; fixed.
  - A device token that expires during a long offline stretch puts the link in `auth-failed`; `mesh login` fixes it.

### M4.5. Lifecycle data, all optional (weeks 17–18)

Optional plan fields and guards only: no roles engine and no workflow engine. A plan without them works as today. The target process these serve is described in [the mesh development cycle](../analysis/2026-11-04-mesh-development-cycle.md).

| # | Task | Size | Acceptance |
|---|---|---|---|
| 4.5.1 | **Verdicts** (R7): optional `verdict`, `findings` (`new`/`repeat`/`regression` counts, `blockers`) and `failures: [{test, ac, bucket}]` on `mesh_done`; buckets use the team's taxonomy `spec-gap\|impl-bug\|test-bug\|infra\|unclear` | S–M | Review rounds, finding classes and failure buckets appear in records |
| 4.5.2 | **Acceptance criteria** (R9): plan-level `acs`, `acs: [ids]` on steps; only test/review steps record `met`/`not_met`; implementing steps list the ACs they addressed | M | Per-AC outcome per round in the record |
| 4.5.3 | **`reworks:`** on goals and plan steps (R10) | S | Export links the rework to the original step |
| 4.5.4 | **Optional `role`** (free string) on plan steps (R11) | S | Grouped in the export |
| 4.5.5 | **Blind steps** (R12, with R16 folded in): `blind: [ids]` and `produces.contract`; `mesh_context` hides the blinded steps' summary, notes and branch; claim and chain guards refuse a session or person who held a blinded step; `blind.separated` in the record | M | A tester session cannot see or inherit the implementer's work |
| 4.5.6 | **Worktree per step** (R15): `mesh run --step S --worktree` | M | Two steps in one repo run on separate branches |
| 4.5.7 | **Step stage table** (R13), including failed deliveries, as the single source for the TUI and web panels; categories don't overlap and every count equals its list's length (tested) | S | Property test over random states |
| 4.5.8 | **More step kinds** (C1): `spec`, `plan`, `verify`, `merge`, `gate` | S | Old plans still validate |
| 4.5.9 | **Caps and park rules** (C2, C3): `max_rounds` per step; park on churn (regressions over half) or stall (no new AC met in N cycles); `reopen` routing by bucket (spec-gap goes back through review, never an unreviewed amendment) | M | The hub parks at the cap; routing tested per bucket |
| 4.5.10 | **Gate steps** (C4): done by a person in web/CLI or by a recorded rule; the record holds the rule inputs and the verdict reference | M | No free-text gate line needed |
| 4.5.11 | **Reconcile check** (C5): every plan AC appears in the covering steps' `acs_addressed`, else reopen once, then park | S | A test plan missing an AC is sent back |
| 4.5.12 | **`reads` / `forbid`** (C6): `mesh_context` shows only `reads` artefacts; `mesh run --step` passes `permissions.deny` for `forbid` paths; plan files committed on their own branch; reopen messages carry AC, bucket and assertion only | M | A test-side step never gets the impl plan, by context or on disk |
| 4.5.13 | **Plan presets** (R14, C9, moved from M5) including `sdd-split` and its collapse variant | S–M | A design session proposes from the preset |

Dropped: agent-reported test counts (R8; CI only) and token usage (R19).

**Status: done (2026-11-04).** All M4.5 tasks are built. The checks:
- `pnpm check`: 317 tests, including the stage-table property test and `test/m45-cycle.test.ts`, the full `sdd-split` goal with three people;
- the Playwright web tests (a gate decided on the Goal page, a parked step resumed);
- `pnpm spike e2e-m45` against real Claude Code. Two people, criteria, blind sides refused at claim, a verify round that failed with an impl-bug routed back to the developer (who saw only the bucket and assertion), round 2 passing, R3 approved with `mesh step approve`, and records with verdicts, criteria, buckets, separation and the goal roll-up. All green on the first run.

Notes and deviations:

- **Rules.** Steps carry the plan's optional rules as `policy`; one pure module (`src/core/policy.ts`) decides what finishing means. `parked` is a new step state; `mesh step resume` (or the web) lets it go on, and caps count again from there.
- **Reopen re-runs downstream work.** Done steps downstream of a reopened step wait again: a review after a spec fix, a combine after a code fix, a gate after either. Without this a verify would pass on the old combine.
- **Reconcile** rejects the `mesh_done`, so the holder keeps the step and fixes it. The second miss parks.
- **Blind guard scope.** `blind_guard: person` (team hub default) or `session` (the Solo hub). In Solo one person may play both sides, never from the same session. The template's spec review is blind to the spec, so the writer can't review their own spec.
- **Gates** are decided only by the goal owner, approvers or admins, through `mesh step approve|reject`, the web, or the API with a `rule` and `inputs`. A recorded rule closing a gate unattended is possible through the API, but nothing evaluates GATE-1 by itself (owner question 2 in the cycle doc). Gate and design records are served with the goal's files; `mesh step approve` writes them, and `goal.yaml` when the goal finished, into the current checkout.
- **Plans on their own branch** come from the template's briefs plus worktrees per step (`mesh run --step --worktree`, or the plan's `worktree`). The worktree lives in `<repo>/.claude/worktrees/<step>` on branch `mesh/<step>`; add `.claude/worktrees` to the repo's `.gitignore`.
- **Stage table** (`src/core/stages.ts`): sessions, steps and messages. Users:
  - the TUI groups sessions by it and lists failed deliveries;
  - `mesh show` prints step counts from it;
  - the Goal page shows the stage counts.
  
  The web Live page still lists sessions by state; it has no grouped panel to convert.
- **Found by the real-Claude re-runs.** In `e2e-m3`, whose plan has no criteria, a haiku agent read the new `mesh_done` fields and passed made-up criterion ids. The hub refused every call with an obscure error. Now criteria are kept only when the plan defines them, unknown ids are dropped (never an error), and the tool describes the fields as "only if your brief lists acceptance criteria". `e2e-m2`, `e2e-m3`, `e2e-offline` and `e2e-m45` were re-run green after the fix.
- **Templates.** `sdd-split` and `sdd-collapse` are built in; repos add `.mesh/presets/<name>.yaml`. `mesh goal new --preset` puts the template in the design brief; `mesh goal plan --preset --repo --acs` fills it in. Differences from the template are warnings in `mesh_plan`'s answer.

### Self-contained (2026-11-04)

mesh-harness is meant to be handed to other teams that may have no access to the repositories it was first designed with. Everything they need now ships here:

- **The SDD kit, `assets/sdd`.** It has:
  - agents for spec-writer, reviewer, impl-planner, test-planner, developer, test-writer, merger and test-executor;
  - `.claude/workflows/sdd-programme.js`, the whole cycle unattended with labelled, typed agents and the optional `mesh ledger stage` step;
  - `templates/spec.md`.

  `mesh assets ls|install [--target DIR] [--force]` copies it into a repo without overwriting the team's own files. The package publishes `assets/` next to `dist/`.
- **Plan templates** `sdd-split` / `sdd-collapse` are built in, as before.
- **The user-facing docs** (README, guide, explainer, events) use neutral names, and present analysis tools as optional (mesh-ai is one example). `docs/analysis/README.md` marks those documents as design history, which mentions the first team's repos as input, not as dependencies.
- **Tested.** `test/assets.test.ts` checks four things: every role has an agent, every `agent()` call has a label mesh can parse, the workflow runs in the Workflow runtime's shape, and installing keeps the team's files. `pnpm spike e2e-kit` ran it for real: a toy Node repo, `mesh assets install`, one Claude Code session (haiku) running `sdd-programme.js`, and a Solo daemon recording it. The row ended "ready to land" in 3 minutes, with nine roles recorded (models and typed results) and the records committed by the workflow's ledger step.

### M4.6. Hub scale-out

Several hub replicas on Postgres behind a load balancer; SQLite stays the default. Async `Db` interface with SQLite and Postgres drivers, OIDC device state in the database, `HintBus` over `LISTEN/NOTIFY`, tick leadership and event-sequence ordering by advisory locks, `/healthz` and `/readyz`, a hub OCI image, a generic `deploy/kubernetes/` example, `mesh hub migrate`. Acceptance: `pnpm spike e2e-scale` (claim race, cross-replica hints and login, tick failover, gap-free event cursor) and the store contract suite on both drivers. Design: [hub scale-out](../analysis/2026-11-06-hub-scale-out.md).

**Status: done (2026-11-06).** All M4.6 tasks are built. The checks:
- `pnpm check`: 383 tests with `MESH_TEST_PG_URL` set; without it the Postgres legs are skipped with a notice. This includes the store contract suite on both drivers (`src/store/hub-store.contract.test.ts`), two replicas in process (`test/m46-replicas.test.ts`) and the probes and `mesh hub migrate` (`test/m46-ops.test.ts`). CI runs the Postgres legs in a `postgres` job and smoke-tests the image in an `image` job.
- `pnpm spike e2e-scale` (no Claude Code, needs `pnpm build` and `MESH_TEST_PG_URL`): two `mesh hub` processes on one Postgres behind a round-robin proxy. A claim race gave exactly one winner in each of 10 races, with the two claims on different replicas. An SSE subscriber on one replica got the hint for a write on the other. A device login started on one replica finished on the other. A reader polling `/v1/events?after=` during 120 concurrent writes on both replicas missed none of the 240 events. After the tick leader was killed with SIGKILL, the other replica took the lock and paused an abandoned claim within one 30 s interval. All green.

Notes and deviations:

- **Lost updates.** Claims and tick pauses are conditional updates, so exactly one wins. Other read-modify-write paths (done, release, take-over, plan approve) still save whole values; two replicas racing on the same step can lose one update.
- **Event writes are serialised on Postgres.** Appending an event holds an advisory lock until commit, so writes that add events run one at a time across replicas. This follows the design's low-volume assumption.
- **Retried transactions.** A deadlock or serialization failure retries the transaction up to 3 times, so transaction callbacks must be safe to run twice (database work only; hints go out after commit).
- **Not done:** a test running release N−1's queries against release N's schema (the docs state the rule); a retry loop when Postgres is down at startup (the hub exits and the orchestrator restarts it).

### M4.7. Adoption: install, skill, versioned hooks

Make mesh easy to install and safe to upgrade, after a review of comparable tools. Done (2026-11-08):

- **Install.** The package is publishable (`mesh-harness`, 0.1.0). `scripts/install.sh` installs a release from GitHub with npm under `~/.local` (no sudo) and, on an update, refreshes an existing setup and restarts the daemon service. A `release` workflow on `v*` tags publishes the GitHub release (package and installer), the hub image on GHCR, and the npm package when an `NPM_TOKEN` secret exists.
- **Skill.** `mesh setup` installs `~/.claude/skills/mesh/SKILL.md` instead of the `~/.claude/CLAUDE.md` block, and removes that block. `mesh skill` prints it. The MCP server gives one always-on sentence pointing at it.
- **Versioned hooks (v2).** Hooks send `X-Mesh-Hooks` and `X-Mesh-At`. The core ignores a state change from a hook that certainly ran before the one that set the current state (a late `UserPromptSubmit` after `Stop`, a late hook after `SessionEnd`). `mesh doctor` reports hooks from an older mesh and open sessions still sending them.
- **Smaller.** Atomic writes for every user file (`src/protocol/fs.ts`), `daemon.json.prev`; terminal notifications (OSC 9, also over SSH; `mesh setup --notify desktop|terminal|both|off`); the hub API as OpenAPI 3.1 (`schemas/hub-api.openapi.json`, checked against the served routes).

Not done: a single-file binary (Node SEA, still in M5); backups of the Solo hub database beyond `mesh hub backup`.

### M5. Optional (later)

GitLab issue import and comments (`gitlab/`), plus **CI ingest** (pipeline and test results per MR/step, joined into the ledger export; or joined from mesh-ai's Prometheus CI data). Export adapters for existing machine ledgers such as `evidence/lane/verdicts.json` (C10). Node SEA binaries. Design contributors, critical-path rendering, `--lane`. Claude Code channels as a delivery path once out of research preview. Everything else in `docs/later.md`.

---

## 11. Testing strategy

| Layer | How |
|---|---|
| `core` | Table-driven tests with an injected clock; 100% branch coverage on session state, DAG, claims, autopilot and roles |
| `auth` | Provider contract suite (none, token, oidc against the mock issuer); token expiry and revoke; CLI exchange PKCE check |
| `store` | Migration tests from empty **and** from the previous version with data |
| Daemon | Fake-claude scenarios:<br>• normal turn<br>• `/clear` rebind<br>• resume fork<br>• crash with no SessionEnd<br>• permission dialog open during delivery<br>• agent ending with a question<br>• `idle_prompt`<br>• daemon down (Stop hook times out quickly) |
| Hub | Concurrency (parallel claims, retried done/plan with the same key), sync replay after a daemon DB reset, inbox at-least-once with ack, route-table authorization, cross-user sync rejected |
| Security | Daemon: key, Host and Origin checks. Hub: Origin check on cookie mutations; service token is read-only. |
| Web | Playwright smoke test per page against a seeded hub |
| Real Claude | `pnpm test:claude` with fixtures tagged by Claude Code version |

---

## 12. ADRs (only these)

1. One package and one binary; module boundaries enforced.
2. `node:sqlite` behind a thin wrapper (fallback `better-sqlite3`); from M4.6 an async `Db` interface with a second driver, Postgres, for several hub replicas.
3. Auth: hub-mediated provider login; opaque hub tokens; no JWT or refresh.
4. Hooks: four async command hooks plus a synchronous Stop HTTP hook replying with `additionalContext`. `agents --json` as the status authority.
5. Session identity: a stable `sid` with rebinding by Claude pid.
6. Events envelope `mesh.harness.v1`; mesh-ai pulls `/v1/events`.
7. Step records and plan files committed under `.mesh/goals/`.

---

## 13. Risks

| Risk | Mitigation |
|---|---|
| `agents --json` changes shape or stops listing interactive sessions (works in 2.1.314–2.1.317, S7) | Hook-only rules (§3.3) as the fallback; `test:claude` catches the change |
| Pid binding (works in S6) | Fallback binding by `(machine, cwd)` plus the most recent `SessionStart` |
| tmux delivery hits a dialog | Guarded by reconciler state (S8); otherwise falls back to notify |
| `node:sqlite` stability | Thin wrapper; switch to `better-sqlite3` in one file |
| Claude Code behaviour changes | `test:claude` contract suite; versioned fixtures; minimum version in `mesh doctor` |
| Scope creep | Milestone exits are user-visible; `docs/later.md` for everything else |

---

## 14. Review log

Reviewer: Claude Opus 5.5 (medium effort) critic. ✅ = applied, ➖ = deferred to `docs/later.md`.

| # | Recommendation | Priority | Disposition |
|---|---|---|---|
| 1 | HTTP hooks can't be async: use async command + curl for 4 hooks, synchronous HTTP Stop with a short timeout | MUST | ✅ §1.5, §5.1, ADR 4. Verified in the hooks docs (`async` is listed only for command hooks). |
| 2 | `agents --json` reconciler as the status authority; `idle_prompt` means idle; tell a question apart from a stall | MUST | ✅ §3.3, §6.3, spike S7. Verified the `idle_prompt` and `permission_prompt` timing semantics in the docs. |
| 3 | Guard send-keys against open dialogs; use bracketed paste | MUST | ✅ §6.4, spike S8 |
| 4 | Rebind sessions across `/clear` and resume; pause claims only on real exit, with a grace period; same-user re-claim | MUST | ✅ §3.1, §3.4, §3.5, spike S9 |
| 5 | stdio `mesh mcp` shim bound by ppid; install with `claude mcp add -s user` | MUST | ✅ §5.2, spike S6 |
| 6 | Secure the daemon: per-user port, secret header, Host and Origin checks; drop the local web API | MUST | ✅ §6.1, §9 |
| 7 | Hub message outbox with pull and ack; SSE only as a wake hint | MUST | ✅ §5.4, §8 |
| 8 | Avoid refresh races; web via session cookie | MUST | ✅ §4.3 (opaque tokens with no refresh at all; cookie sessions) |
| 9 | Re-estimate; split M1; autopilot to M2; add spikes S7–S9 | MUST | ✅ §10 |
| 10 | Provider port as `start`/`complete` with typed input and hub-held state; admin bootstrap; session lifetime | SHOULD | ✅ §4.2, §4.3 |
| 11 | Opaque hashed tokens instead of JWT/JWKS | SHOULD | ✅ §4.3; `jose` removed from dependencies |
| 12 | Replace export sinks with `GET /v1/events?after=` and a service token | SHOULD | ✅ §5.5, M4 |
| 13 | Repo identity as the normalized remote; auto-discover checkouts | SHOULD | ✅ §3.1 |
| 14 | Separate online RPC from spooled observations; UUID deduplication; idempotency keys | SHOULD | ✅ §5.3, §3.2 |
| 15 | Three web pages; plain ANSI TUI instead of Ink | SHOULD | ✅ §9 |
| 16 | Simple `chain` rule; no lanes in the core | SHOULD | ✅ §3.6 |
| 17 | Solo mode = hub in-process with the `none` provider; remove local tasks and upload | SHOULD | ✅ §4.5, M1 |
| 18 | Stop delivery through `additionalContext` | SHOULD | ✅ §5.1. Verified in the docs: non-error feedback, and Claude Code's own 8-continuation cap. |
| 19 | Track channels for future delivery | COULD | ➖ M5 |
| 20 | Defer background sessions to `claude attach` and agent view | COULD | ✅ §6 |
| 21 | Defer SEA packaging, design contributors and critical path | COULD | ➖ M5 |
| B | Per-viewer attention; `mesh_plan` requires `brief`; `--design` adds `--add-dir`; human prompts exclude deliveries; aggregate counts for sessions without a step | — | ✅ §3.2, §3.4, §7, §3.7 |
| E | Holder machine offline → paused; hub derives step stalled from the session | — | ✅ §3.4 |
| F | Testing gaps (concurrency, security, versioned fixtures, injected clock, migrations with data, macOS CI) | — | ✅ §11, task 0.1 |
