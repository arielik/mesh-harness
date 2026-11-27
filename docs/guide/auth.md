# Auth

The hub authenticates people through **providers**. A login gives the CLI or the browser an opaque hub token, so mesh is not tied to any identity provider.

| Kind | Use | Notes |
|---|---|---|
| `none` | Solo, or a hub on loopback for one person | Refused off loopback. `user:` names the person. |
| `token` | small teams | `mesh hub init --users alice,bob` writes the config and prints one token per person (only their sha256 is stored). |
| `oidc` | Kanidm, Keycloak, Authentik, GitLab, Google… | Auth code + PKCE in the browser, or device flow. `kanidm` is a preset; any OIDC issuer works. |

```yaml
# mesh-hub.yaml
listen: 0.0.0.0:7700
url: https://mesh.example
db: mesh-hub.db          # or postgres://user:pass@db.example.com/mesh for several replicas; MESH_HUB_DB overrides
events_retention_days: 180
auth:
  providers:
    - id: team
      kind: token
      users:
        - { name: alice, token_sha256: <sha256 of alice's token> }
    - id: kanidm
      kind: oidc
      preset: kanidm
      issuer: https://idm.example/oauth2/openid/mesh
      client_id: mesh
      groups_claim: groups
  bootstrap_admins: [team:alice]
  session: { device_max_age: 90d, web_max_age: 12h }
```

**Roles.**
- **member:** use goals and steps.
- **approver:** approve any plan.
- **admin:** everything, plus user and token administration.
- **service:** read the event feed, plus what the token's scopes allow.

Roles come from provider groups (`roles:` mappings) and `bootstrap_admins`.

**Tokens.**
- Device tokens (CLI and daemon) and web sessions expire as configured.
- `mesh hub revoke --user alice` or `--machine m-…` revokes them.
- `mesh hub token --service analytics` mints a token for `GET /v1/events` and `mesh ledger export --events`.
- `--scope` adds member routes to a service token, comma-separated. `goals:read` reads goals and steps (`GET /v1/goals`, `/v1/goals/:id` with its files and timeline, `GET /v1/steps`, `/v1/steps/:id`) and checks presets (`POST /v1/presets/check`, a read that writes nothing); `goals:write` creates goals (`POST /v1/goals`, owned by the service account); `live:read` reads `GET /v1/live`, `GET /v1/fleet` and `GET /v1/stream`; `pulses:write` creates and changes pulses (`POST /v1/pulses`, `/v1/pulses/:id/{update,pause,resume,fire,delete}`); `profiles:write` saves permission profiles (`POST /v1/profiles`); `steps:assign` offers a ready step for a person and ranks that person's machines for it (`POST /v1/steps/:id/assign`, `GET /v1/steps/:id/suggest`, only with `X-Mesh-On-Behalf-Of`); `fleet:pause` pauses and resumes the fleet for an admin (`POST /v1/fleet/pause`, `POST /v1/fleet/resume`, only with `X-Mesh-On-Behalf-Of`); `alerts:notify` posts Alertmanager alerts that notify people on their machines (`POST /v1/alerts/webhook`, see below); `goals:decide` approves, revises and replans plans, passes and rejects gates, resumes and parks steps for a person, and stops the headless run holding a step (`POST /v1/steps/:id/stop-run`, RL-26) (`POST /v1/goals/:id/{approve,revise,replan}`, `POST /v1/steps/:id/{approve,reject,resume,park}`); `questions:answer` answers a question for a person (`POST /v1/questions/:id/answer`); `sessions:message` writes into a person's session (`POST /v1/messages`); `sessions:stop` interrupts or ends a session for a person (`POST /v1/sessions/:sid/stop`, RL-26). The last three work only with `X-Mesh-On-Behalf-Of` (0.1.42, below). `goals:join` joins and leaves a goal for a person (`POST /v1/goals/:id/join` and `/leave`, RL-28), also only with `X-Mesh-On-Behalf-Of` (without it `400 on-behalf-of-required`): the person's own membership, never another's. `goals:read` also reads the team form of attention (`GET /v1/attention?team=1`) and the open questions (`GET /v1/questions?state=open`). No scope claims a step. Example, for a dashboard that shows and adds goals: `mesh hub token --service dash --scope goals:read,goals:write,live:read`. A scope is fixed when the token is minted; to change it, revoke the token (`mesh hub revoke --user <service user>`) and mint another.

**A service acts for a person.** On `GET /v1/fleet`, `POST /v1/profiles`, `POST /v1/pulses` and `POST /v1/pulses/:id/{update,pause,resume,fire,delete}`, a service token with the route's scope may send `X-Mesh-On-Behalf-Of: <user id>`. The request then runs as that person, with the member role only (never their admin role; the one exception is the fleet pause, `POST /v1/fleet/pause` and `POST /v1/fleet/resume`, which keep the admin role, see below): the pulse or profile is theirs, the fleet is theirs, and the events name them in `user` and the service in `payload.via`. A pulse made or changed this way must name the person's own machines in `target.machines` (by id, `<user>/<nickname>` or nickname); labels may narrow it. Refusals, each with its own `error`:

| Status | `error` | When |
|---|---|---|
| 400 | `on-behalf-of required: …` | a service writes on these routes without the header |
| 400 | `on-behalf-of is not accepted on this route` | the header on any other route |
| 400 | `target.machines required: …` | a pulse for a person with an empty or labels-only target |
| 403 | `on-behalf-of is for service tokens only` | a person's token sends the header |
| 403 | `unknown user "<id>"` | no such user, or a service account |
| 403 | `machine not yours: <name>` | a target machine the person does not own |
| 403 | `only @<owner> or an admin can change pulse <id>` | a pulse of another person |

Since 0.1.40 these refusals carry a stable `code` beside `error` (`on-behalf-of-required`, `on-behalf-of-not-accepted`, `on-behalf-of-not-service`, `user-unknown`), and the route rule's refusals carry `forbidden` and `login-required`. The `error` texts are unchanged; a client may match on `code` instead.

**A service assigns a step for a person** (0.1.40, feature `step-assign-for`). With the scope `steps:assign`, a service sends `POST /v1/steps/:id/assign` and `GET /v1/steps/:id/suggest` with `X-Mesh-On-Behalf-Of: <user id>`; the header is required on both, also on the read. The scope is separate from `goals:write` on purpose: `goals:write` creates goals the service owns, while an assign starts work on a person's machine under that person's name, so an existing token does not gain it; mint a new token to grant it. The rights:

- The person is looked up exactly (no case folding, no nickname); a service account or an unknown id is `user-unknown`. The request runs with the member role only, never the person's admin role.
- The target (`<machine>`, `<machine>/<session>`, `<user>/<nickname>`, `<user>/<nickname>/<session>`) is resolved as for the person, then the resolved machine must be the person's own (checked before any session part is looked up), and a named session must be a live session the person owns. Anything else is refused; no name form reaches another person's machine.
- `sid` and `stick` are refused for a person (`on-behalf-of-option`); `note` is allowed. Suggest refuses `team=1` and ranks only the person's machines and sessions.
- The offer's `by` is the person and its `via` the service: the target's `self` and `user:<person>` accept rules apply as if the person assigned it (so a `self` rule also auto-accepts offers a service makes for you), a `machine:<x>` rule never does. `step.offered` carries `user` = the person and `payload.via`; the offer message ends with `(via <service>)`; `GET /v1/offers` shows `via`.
- Retries with the same `Idempotency-Key` replay the first answer per service and person, never across persons.

Any caller may also send `mode: "headless"` and `profile` in the assign body to run a step headless that does not declare it (a fresh `claude -p` run under that profile): only on the caller's own machine (`machine-not-yours`), never into a session (`headless-session-target`) or with a stick (`headless-stick`), a profile is required (`profile-required`, `profile-needs-headless`), a step that declares a profile admits only that one (`profile-mismatch`), and the headless guard applies (`headless-unsupported`, `headless-profile-unknown`, `headless-profile-not-pinned` for a goal that pins its profiles). A service acting for a person may name a built-in profile or one registered for that person (`profile-not-yours` otherwise); note that this includes `propose-via-branch` (which edits, commits and pushes) and profiles a `profiles:write` service registered for the person, so with the person's `self` rule such an offer runs unattended. That is the reach an admin grants by minting both scopes, as for pulses. No budget is chosen here: the run gets the default turns and minutes.

| Status | `code` | When |
|---|---|---|
| 400 | `on-behalf-of-option` | `sid` or `stick` on assign, `team=1` on suggest, for a person |
| 403 | `user-unknown` | no such user, or a service account |
| 403 | `machine-not-yours` | the target machine is not the person's (or, with `mode`/`profile`, not the caller's) |
| 403 | `session-not-yours` | the target session is not the person's |
| 403 | `profile-not-yours` | a registered profile of someone else, for a person |
| 404 | `step-unknown` / `machine-unknown` / `session-unknown` | no such step, machine, or live session on it |
| 409 | `step-gate` / `step-not-ready` / `step-debrief` / `step-offered` | the step is a gate, not ready, a debrief, or already offered |
| 409 | `session-ambiguous` | the session name matches several |
| 400 | `profile-required` / `profile-needs-headless` / `headless-session-target` / `headless-stick` | a headless request that does not fit |
| 409 | `profile-mismatch` / `headless-unsupported` / `headless-profile-unknown` / `headless-profile-not-pinned` | the headless guard |
| 409 | `offer-headless` | accept with a `sid`, or claim, of a headless offer: the machine's daemon starts it |

The assign answers `{step, auto, message}`; `message` is the id of the offer message to the machine. The hub does not know the outcome when it answers; read it from state and events:

| Outcome | Where |
|---|---|
| listed (waits for the owner) | `message.delivered` with `payload.id` = `message` and `method: "listed"`; the offer stays `offered`. A listed headless offer runs when the machine's owner accepts it (`mesh accept <step>`, RL-26), or waits until it is declined, withdrawn or expires |
| accepted into a session | `step.accepted`; `offer.state` `accepted`; method `accepted` |
| launched (a new interactive session) | method `launched` |
| headless run started or queued | method `headless` or `queued`; `run.started` when it starts |
| declined | `step.declined`; `offer.state` `declined`; method `declined` |
| failed | `message.delivered` with `state: "failed"` and the reason as `method`; the offer stays `offered` until it expires |
| expired or withdrawn | `step.offer_expired` or `step.offer_withdrawn`; `offer.state` |

`GET /v1/steps/:id` gives `offer.state` (it needs `goals:read`); `GET /v1/events` gives the events (a service reads them). `message.delivered` names no step: the `message` of the reply is the join key.

Example, for a dashboard that also starts steps for people: `mesh hub token --service dash --scope goals:read,goals:write,live:read,pulses:write,profiles:write,steps:assign`.

**A service decides for a person** (0.1.42, feature `decide-for`). A dashboard that holds a service token relays a person's decisions instead of showing a command to copy. Each route needs its scope and `X-Mesh-On-Behalf-Of: <user id>`; without the header the hub answers `400 on-behalf-of-required` and changes nothing:

| Route | Scope | Header for a service | Check, against the person as a member |
|---|---|---|---|
| `POST /v1/goals/:id/{approve,revise}` | `goals:decide` | required | goal owner; a pending plan |
| `POST /v1/goals/:id/replan` | `goals:decide` | required | goal owner; goal not done or dropped |
| `POST /v1/steps/:id/{approve,reject}` | `goals:decide` | required | goal owner; a ready gate |
| `POST /v1/steps/:id/{resume,park}` | `goals:decide` | required | goal owner; parked or failed (resume), claimed or paused (park) |
| `POST /v1/questions/:id/answer` | `questions:answer` | required | the person is an addressee |
| `POST /v1/messages` | `sessions:message` | required | the target session is visible to the person |
| `POST /v1/goals/:id/drop` | `goals:write` | optional | goal owner; no held step |
| `POST /v1/goals`, `POST /v1/goals/from-preset` | `goals:write` | optional | the person owns the new goal |

The request runs with the person's member role only, as every act-for route: through a service only the goal owner passes the approve check, and an approver or admin who does not own the goal gets `403 not-approver` and decides with their own login (`mesh goal approve`, `mesh step approve`, …). The admin override of answers does not apply either. The header is optional on goal create and drop: without it the service acts as itself, as before (the goal is owned by the service account; a drop is checked against it). Events name the person in `user` and the service in `payload.via`; the stored decision (`plan.decidedBy`, the gate round's `gate.by`, `answeredBy`, the resume note, `ownerId`) names the person; a relayed answer, plan revision or park message ends with ` (via <service>)`, a message's text is left as written. Mint a new token to grant the scopes: `mesh hub token --service dash --scope goals:read,goals:write,goals:decide,questions:answer,sessions:message`.

These refusals carry a stable `code` beside the unchanged `error` (other refusals of these routes, such as body-schema `400`s and goal-create problems, have no `code`). A `409` means the state moved: refetch.

| Status | `code` | When |
|---|---|---|
| 404 | `goal-unknown` / `step-unknown` / `question-unknown` | no such goal, step or question |
| 403 | `not-approver` | the rights check (goal owner, approvers, admins; the owner only through a service) |
| 403 | `not-addressed` | the question is not addressed to the person |
| 404 | `plan-none` | no pending plan (or the asked version) |
| 409 | `plan-decided` | the plan was already decided |
| 404 | `design-unknown` | replan of a goal with no design step |
| 409 | `goal-closed` | the goal is done or dropped (replan, drop, park) |
| 409 | `goal-held` | drop of a goal with held steps |
| 409 | `not-gate` / `gate-not-ready` | gate approve or reject of a step that is not a gate, or not ready |
| 400 | `reopen-required` | reject without `reopen` |
| 409 | `reopen-unknown` | a `reopen` id is not a done step of the goal |
| 409 | `step-not-resumable` | resume of a step that is not parked or failed |
| 409 | `step-gate` / `step-debrief` / `step-parked` / `step-not-parkable` | park of a gate, a debrief, a parked step, or a step that is not claimed or paused |
| 409 | `question-answered` | the question was already answered |
| 404 | `session-unknown` | the target session is not live or not visible |
| 409 | `step-unheld` | `toStep` names a step no session holds |
| 400 | `team-required` / `bad-query` | a service reads `GET /v1/attention` without `team=1`; a query value out of range |
| 403 | `team-forbidden` | a member without admin asks for `team=1` |

**Team reads** (0.1.42, features `team-attention`, `questions-list`). `GET /v1/attention?team=1` answers every open item of the team in one read, for a service with `goals:read` (which must send `team=1`) or an admin: plans, gates, debriefs, overdue debriefs, open questions, parked, failed, paused and stalled steps, stuck steps and sessions (the `GET /v1/stuck` rules at `needsYouMs` and `turns`); those two values are the only stuck thresholds (an item exactly at a floor is returned), a stuck session's `at` is the instant it entered needs_you and its `forMs` the time since, and a stuck step's `turns` is its full count since its last commit (RL-27), sessions in needs_you, missed and blocked pulses, ready steps nobody claimed and open offers, each with `who` (the one person it waits on), `at` and a stable `key`, and `users` (every hub user that is not a service account). `trial` and `limit` (1-5000, default 2000; `truncated` says more were left out) narrow it. A member without admin gets `403 team-forbidden`: the team form shows every machine's sessions. `GET /v1/questions?state=open` lists unanswered questions oldest first: all of them for a service or an admin, those addressed to the caller for a member.

**A service pauses the fleet for an admin** (RL-24, feature `fleet-pause`). With the scope `fleet:pause`, a service sends `POST /v1/fleet/pause` (`{"reason": "…"}`, 1 to 500 characters) and `POST /v1/fleet/resume` (`{}` or `{"reason": "…"}`) with `X-Mesh-On-Behalf-Of: <user id>`; the header is required. **These two routes are the only ones where act-for keeps the person's admin role** (owner decision MESH-OQ-AIOPS-12); every other act-for route runs with the member role only. The person must hold `admin` at the time of the request (roles are read from the store each time). An admin with their own token calls the same routes without the header (`mesh fleet pause`). Every `fleet.paused` and `fleet.resumed` event names the person as `user` and the service as `via`. A token minted before this release lacks the scope and gets `403 forbidden`: mint a new one (`mesh hub token --service <name> --scope …,fleet:pause`).

| Status | `code` | When |
|---|---|---|
| 401 / 403 | `login-required` / `forbidden` | no login; a service without `fleet:pause` |
| 400 / 403 | `on-behalf-of-required` / `on-behalf-of-not-service` / `user-unknown` | a service without the header; a person's own token with it; no such user, or a service account |
| 400 | (none: `invalid request` with `details`) | the body |
| 403 | `not-admin` | the person (or the caller) lacks `admin`: `fleet pause and resume are for admins` |
| 409 | `fleet-already-paused` | pause while paused |
| 409 | `fleet-not-paused` | resume while not paused |
| 409 | `fleet-paused` | while paused: pulse fire, headless step assign, goal assign with only headless steps left, accept of a headless offer |

**Alerts from Alertmanager** (RL-25, feature `alert-notify`). `POST /v1/alerts/webhook` takes the Alertmanager webhook body (version `"4"`) from a service token with the scope `alerts:notify`, minted for the receiver alone: `mesh hub token --service alertmanager --scope alerts:notify`. Each alert's `person` label names the user whose machines get a notice ([operations](operations.md#alerts-from-alertmanager)). The route takes no `X-Mesh-On-Behalf-Of`. Refusals:

| Status | `code` | `error` | When |
|---|---|---|---|
| 401 | `login-required` | `login required` | no or bad token |
| 403 | `forbidden` | `forbidden` | a service token without `alerts:notify` |
| 403 | `service-only` | `only a service token posts alerts` | a member's or an admin's own token |
| 400 | `on-behalf-of-not-accepted` | `on-behalf-of is not accepted on this route` | the act-for header is sent |
| 400 | `alert-version` | `webhook version <v> is not supported; expected 4` | `version` is not `"4"` |
| 400 | `alert-body` | `invalid alert webhook body` (the problems in `details`) | the body does not fit, more than 1000 alerts, a `startsAt` that is not an RFC 3339 time |

Alertmanager does not retry a 4xx: these show in its log as configuration errors.

**A service stops a run or a session for a person, and routes to a teammate's machine** (RL-26, features `run-stop`, `session-stop`, `team-offers`). Each route takes `X-Mesh-On-Behalf-Of`, required for a service, and runs with the person's **member role only**: never their approver or admin role. An approver who does not own the goal stops a run or a session with their own login.

- `POST /v1/steps/:id/stop-run` (scope `goals:decide`, body `{reason}`): parks a step held by a headless run (`parkedReason: "stopped: <reason>"`, `step.stoppedRun`) and sends its machine one `run_stop` message; reply `{step, message, online}`. Rights: the goal's owner, an approver or an admin with their own token, under act-for the goal's owner only; the holder machine's owner may also stop a run on their own machine, with their own token only (never relayed). Codes in order: `404 step-unknown`, `409 goal-closed`, `403 not-approver`, `409 not-a-run` (not held by a headless run: park it instead), `409 run-stop-unsupported` (the machine runs an older mesh). While the step stays parked its machine may upload one `transcript` of the stopped run.
- `POST /v1/sessions/:sid/stop` (scope `sessions:stop`, body `{mode: "interrupt" | "end", reason}`): only on a machine whose owner allowed it (`remoteStop`); reply `{message, online}`. Rights: the session's owner, the goal's owner, an approver or an admin with their own token (under act-for: the session's or the goal's owner). Codes in order: `404 session-unknown` (exact sid), `409 session-ended`, `409 session-is-run` (stop a run with `mesh stop`), `403 not-allowed`, `409 stop-refused` (the owner has not allowed remote stops), `409 stop-unsupported` (an OpenCode session). The step the session holds is not changed.
- `GET /v1/machines?offers=team` (scope `live:read`, header required): the teammates' machines whose owner accepts team offers (`teamOffers`), never the person's own or a service's; `{machines: [{id, name, nickname, owner, labels, online, lastSeen, headless, repos}]}`, online first. Without `offers=team`: `400 bad-query`.
- **Team offers.** An act-for `POST /v1/steps/:id/assign` may name a teammate's machine that reported `teamOffers: true` (otherwise `403 machine-not-yours`, as before), never one of its sessions (`403 team-offer-session`) and never with `mode` or `profile` (`403 team-offer-override`, with the `error` text of `machine-not-yours`). The offer is stored and sent with `auto: false` and `team: true` whatever the target's accept rules say; its message ends `(via <service>, team offer)`. The machine's owner accepts or declines it with their own login; an unanswered team offer expires after the hub's offer expiry (30 minutes by default). An own-token assign to a teammate's machine is unchanged.

A daemon whose token expired keeps working locally and shows "hub login expired"; `mesh login` again.
