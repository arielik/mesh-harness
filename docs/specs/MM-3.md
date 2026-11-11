# Spec MM-3: Assign: offers, accept policy, auto-accept delivery, Assigned to you, report back

## Status
Draft (revision 2: fixes review round 1 blockers B1–B3 and suggestions S1–S9)

Source: `docs/analysis/2026-11-11-my-mesh-and-assign.md`, section "MM-3: Assign (offers and accept)".
Builds on MM-1 (`docs/specs/MM-1.md`, v0.1.9) and MM-2 (`docs/specs/MM-2.md`, v0.1.10). Release v0.1.11.

## Problem

Work reaches a session only when its holder claims a ready step. A person with several machines (MM-1)
and labelled sessions (MM-2) cannot hand a step or a goal to another machine or session: they have to
go there and claim it. A coordinating session cannot hand out work either, and nobody hears back
when the receiver takes it, refuses it, finishes it or gets stuck.

## Scope

In:
- `Step.offer` (an overlay on a `ready` step) with the states `offered → accepted | declined | expired | withdrawn`;
  `Goal.stick` (`--stick`): later ready steps of the goal are offered to the same target.
- Hub routes: `POST /v1/steps/:id/assign|accept|decline|withdraw`, `POST /v1/goals/:id/assign|withdraw`,
  `GET /v1/offers`. The claim guard while a step is offered. Expiry by the hub tick (`offerExpiryMs`).
  Ready-step lists hide steps offered to someone else.
- Accept policy: daemon config `accept` (synced with the machine facts), per-session override
  `mesh session accept` (synced with the session record), evaluated by the hub when the offer is made.
- Machine-wide inbox messages (`toSid: ""`) of kind `offer`; the daemon handles them itself:
  auto-accept (pick a session, claim for it, send the brief), launch (`assignments: "launch"`), decline
  (`assignments: "off"`), or list for the person.
- Assigned to you: `mesh offers`, `mesh accept`, `mesh decline`, `mesh withdraw`, `mesh assign`,
  `mesh session accept`, `mesh setup --accept/--assignments`; TUI badge and panel (`o`); web Mine tab
  section; `/v1/attention` kinds `offer` and `offer_expired`; MCP `mesh_assign`, `mesh_offers`,
  `mesh_accept`; offered steps first in `mesh_next`.
- Report back to the offering session: accepted, declined, expired, and then done, failed, question.
- Offer state on the goal page and in `mesh show`. Events `step.offered`, `step.accepted`,
  `step.declined`, `step.offer_expired`, `step.offer_withdrawn`.
- Docs: concepts, how-to, install guide, the mesh skill, the plan API table, the events list.

Out:
- Suggest / ranking (`--suggest`, MM-4), the web Assign button (MM-4), `mesh say <machine>/<session>` (MM-4),
  `maxSessions` (MM-4).
- Accepting from the web (it has no session to claim for); the web only declines.
- Offers in the ledger (`mesh.ledger.v1` records are unchanged); offers across hubs.
- Rendering the accept policy in `renderFleet` / `mesh machines` text (it is in the JSON only).
- A hub schema migration: offers, sticks and policies live in existing JSON columns.

## Interface contracts

Names used below: **machine name** of a machine = its nickname, else its hostname. **Session name**
of a session = its `name`, else its repo name, else the first 8 characters of its sid. **Target text**
of an offer = `<machine name>` or `<machine name>/<session name>` when the offer names a session.
**Open offer** = `step.offer.state === "offered"`.

### Types (src/protocol)

| Interface | Type | Change |
|---|---|---|
| `ACCEPT_RULE_TEXT` (src/protocol/config.ts) | const | New: `"an accept rule is self, off, user:<id> or machine:<nickname or id>"`. |
| `AcceptRule` (src/protocol/config.ts) | zod | New: `z.string().regex(/^(self\|off\|user:[^\s,]{1,100}\|machine:[^\s,]{1,100})$/, ACCEPT_RULE_TEXT)`. |
| `AcceptPolicy` (src/protocol/config.ts) | zod | New: `z.array(AcceptRule).min(1).max(20)` refined: `off` only alone (message `off cannot be combined with other rules`). |
| `parseAccept(input: string \| readonly string[]): { accept: string[] } \| { error: string }` (src/protocol/config.ts) | function | New. A string is split on `,`; items trimmed, empty items dropped, repeats removed, order kept. Errors: no items → `give at least one rule, or off`; first item not an `AcceptRule` → `not an accept rule: <item> (<ACCEPT_RULE_TEXT>)`; `off` with others → `off cannot be combined with other rules`; more than 20 → `at most 20 accept rules`. |
| `DaemonConfig.accept` | zod field | New: `AcceptPolicy.default(["self"])`. |
| `DaemonConfig.assignments` | zod field | New: `z.enum(["deliver", "launch", "off"]).default("deliver")`. A `daemon.json` without the fields parses as before (defaults). |
| `Session.accept` (src/protocol/session.ts) | zod field | New: `AcceptPolicy.optional()`: the per-session override; absent = the machine policy applies. |
| `OfferState` (src/protocol/goal.ts) | zod | New: `z.enum(["offered", "accepted", "declined", "expired", "withdrawn"])`. |
| `StepOffer` (src/protocol/goal.ts) | zod | New: `{ to: { machine: string; sid?: string }; by: string; bySid?: string; byMachine?: string; at: number; state: OfferState; auto: boolean; stick?: boolean; note?: string; decidedAt?: number }`. `by` = offering user id; `byMachine` = the machine the offer was made from; `auto` = the hub's policy verdict; `stick` = made by a goal's stick. |
| `Step.offer` | zod field | New: `StepOffer.optional()`. Kept after the offer ends (the last offer of the step); a new offer replaces it. |
| `Goal.stick` (src/protocol/goal.ts) | zod field | New: `z.object({ to: z.object({ machine: z.string(), sid: z.string().optional() }), by: z.string(), bySid: z.string().optional(), byMachine: z.string().optional(), at: z.number() }).optional()`. |
| `SyncRequest.machine` (src/protocol/hub.ts) | zod | Gains `accept: AcceptPolicy.optional()`. Absent: the hub keeps the stored policy. |
| `AssignRequest` (src/protocol/hub.ts) | zod | New body of both assign routes: `{ to: z.string().min(1).max(200), sid: z.string().optional(), stick: z.boolean().default(false), note: z.string().max(2000).optional() }`. `sid` = the **offering** session (as `sid` in `ClaimRequest`). |
| `DeclineRequest` (src/protocol/hub.ts) | zod | New: `{ note: z.string().max(2000).optional() }`. |
| `AssignResult` | interface | New: `{ step: Step; auto: boolean }`. |
| `GoalAssignResult` | interface | New: `{ goal: Goal; steps: Step[]; auto: boolean }` (`steps`: the steps offered now, by id; `auto`: the policy verdict for the target at assign time, also when `steps` is `[]`). |
| `GoalWithdrawResult` | interface | New: `{ goal: Goal; withdrawn: string[] }` (step ids, sorted). |
| `OfferView` | interface | New, one open offer: `{ step: string; goal: string; title: string; repo: string; kind: StepKind; machine: string; sid?: string; to: string; by: string; bySid?: string; byMachine?: string; at: number; expiresAt: number; auto: boolean; note?: string }`. `to` = target text; `expiresAt = at + offerExpiryMs`. |
| `OfferLine` | interface | New: `{ to: string; state: OfferState; by: string; at: number; accepted?: string; note?: string }`. `accepted` = `<machine name of the holder machine>/<session name of the holder session>` (only the machine name when the hub has no session record) once accepted. |
| `GoalDetail` | interface | Gains `offers?: Record<string, OfferLine>` (step id → its last offer; key absent when no step has one) and `stick?: string` (target text of `Goal.stick`; absent when none). |
| `Attention.kind` | union | Gains `"offer"` and `"offer_expired"`. |
| `FleetMachine` | interface | Gains `accept?: string[]`: the policy its daemon last reported; absent when never reported. |
| `FleetSession` | interface | Gains `accept?: string[]`: the session override; absent when none. `LiveSession` is unchanged. |
| `HubConfig.thresholds` (src/hub/config.ts) | config | Gains `offerExpiryMs`, from hub YAML `thresholds.offer_expiry` (duration, default `30m`). |
| `TOOLS` (src/protocol/tools.ts) | const | Gains `mesh_assign {target: string, to: string, stick?: boolean, note?: string}`, `mesh_offers {}`, `mesh_accept {step: string}`. |

### Core (src/core, exported from `src/core/index.ts`)

```ts
export function acceptMatches(
  policy: readonly string[] | undefined,
  offer: { byUser: string; byMachine?: { id: string; userId: string; nickname?: string } | undefined },
  target: { userId: string },
): boolean
```
`undefined` policy (never reported) → `false`. `["off"]` → `false`. Otherwise true when any rule
matches: `self` ↔ `offer.byUser === target.userId`; `user:<id>` ↔ `offer.byUser === <id>`;
`machine:<x>` ↔ `offer.byMachine.id === x`, or `offer.byMachine.userId === target.userId` and
`offer.byMachine.nickname === x`.

```ts
export function pickSession(sessions: readonly Session[], want: { repo: string; topics: readonly string[]; sid?: string }): Session | undefined
```
With `want.sid`: that session if it is not `ended`, holds no step and is not `launching`; else
`undefined` (no other session is chosen). Without: among sessions with `state === "idle"`, no step,
not `launching`, and a `repo` with `repoMatches(repo, want.repo)`, the one with the most labels in
`want.topics`; ties: larger `lastEventAt`, then smaller sid (code-point order). None → `undefined`.

```ts
export function offerText(l: OfferLine): string
export function offerLine(o: OfferView, now: number): string
```
`offerText`: `offered to <to> by @<by>` (offered); `offered to <to> → accepted by <accepted ?? to>`;
`offered to <to> → declined` plus `: <note>` when a note was given; `offered to <to> → expired`;
`offered to <to> → withdrawn`.
`offerLine`: `` `${o.step} "${o.title}" · ${o.repo || "-"} · from @${o.by} · to ${o.to} · ${o.auto ? "auto" : "manual"} · expires in ${age(o.expiresAt - now)}` `` followed by `` ` · ${o.note}` `` when a note was given (`age` from `src/core/fleet.ts`).

### Offer target resolution (hub, both assign routes)

`to` is split on `/`:
- `a` → machine `a`, no session.
- `a/b` → if `a` resolves as a machine (below), machine `a` and session `b`; otherwise machine `a/b`
  read as `<user id>/<nickname>`, no session.
- `a/b/c` → machine `a/b` (`<user id>/<nickname>`), session `c`.

A machine reference resolves to: the machine with that exact id; else the caller's machine with that
nickname; else, for `<user>/<nickname>`, that user's machine with that nickname. None:
404 `no machine <reference>`. A session reference resolves among the hub's non-ended session records
on that machine that the caller may see (`sessionVisible`, MM-1): exact sid, else exact `name`, else a
unique sid prefix of at least 4 characters. None: 404 `no session <reference> on <machine name>`;
several: 409 `"<reference>" matches several sessions on <machine name>`.

### Hub HTTP API (src/hub/app.ts, listed in `HUB_API` in src/protocol/hub-api.ts)

All new routes: rule `member`, no service scope, tag `steps` (goal routes: tag `goals`).

**Caller machine.** Every offer decision (the assign's `byMachine`, the accept check, the claim
guard, the decline policy check) uses the **caller machine**, never a machine looked up from a
`sid` alone:
- the token has a machine (`actor.machineId`): that machine. A `sid` in the body is used only when
  the hub has that session, its user is the caller and its machine is the token's machine;
- the token has no machine: the machine of `sid` when the hub has that session and its user is the
  caller; no usable `sid` → no caller machine (`byMachine` absent; it is never the target machine).

A `sid` that fails these checks on assign, accept, decline, or a claim of a step with an open offer →
403 `session <sid> is not yours on this machine`. Claims of steps without an open offer are unchanged.

**Concurrency.** Assign (step and goal), accept, decline, both withdraws, expiry, the stick offer,
the end of an offer when its step leaves `ready`, and `POST /v1/steps/:id/claim` all run in the
hub's serialised goal transaction (`goalTx`, `HubStore.serialize()`), so with several hubs on one
Postgres store each decides from current state: of two concurrent assigns one gets 200 and the other
409 `already offered`; a claim never erases an offer committed before it (it sees the offer and is
guarded); an accept never overwrites an offer that expired or was withdrawn first (it answers
409 `<id> has no open offer`). No store interface changes for this.

**Privacy.** The target of an offer (`step.offer.to`, `OfferLine.to`, `OfferView.to`, the
`step.offered` payload `sid`) is visible to every member who may see the step, including a session
that is not otherwise visible to the team (e.g. under `shareSessions: me`). The offerer chose to name
it; this is an accepted exposure and the concepts guide states it.

| Route | Behaviour |
|---|---|
| `POST /v1/steps/:id/assign` (`AssignRequest`) | Checks, in order: 404 `no step <id>`; gate → 409 `<id> is a gate: a person decides it`; not `ready` → 409 `<id> is <state>, not ready`; open offer → 409 `<id> is already offered to <target text>; withdraw it first (mesh withdraw <id>)`; target resolution errors (above). Then sets `offer = {to, by: caller, bySid: sid, byMachine: the caller machine (absent when none), at: now, state: "offered", auto, note?}` where `auto = acceptMatches(session override ?? machine policy, …)` (the named session's `accept` when the offer names a session that has one, else the target machine's stored `accept`). The step stays `ready`. Queues one machine-wide inbox message to the target machine (below) and wakes its daemon. Event `step.offered`. With `stick: true` also sets the goal's `stick` to the same target and offerer. 200 `AssignResult`. |
| `POST /v1/goals/:id/assign` (`AssignRequest`) | 404 `no goal <id>`; goal `done`/`dropped` → 409 `<id> is <state>`; target resolution errors. Offers every step of the goal that is `ready`, not a gate and has no open offer (in a new goal that is its design step), each as above (one message and one event per step). None and `stick` false → 409 `<id> has no ready step to offer`. With `stick` sets `Goal.stick`. 200 `GoalAssignResult`. |
| `POST /v1/steps/:id/accept` (`ClaimRequest`, `sid` = the accepting session) | 404 `no step <id>`; no open offer → 409 `<id> has no open offer`; a `sid` that is not the caller's on this machine → 403 `session <sid> is not yours on this machine`; the caller machine is not `offer.to.machine` (or there is none) → 403 `<id> is offered to <machine name>, not to this machine`. Then claims as `POST /v1/steps/:id/claim` would (same errors) and sets `offer.state = "accepted"`, `decidedAt`. Events `step.claimed` then `step.accepted`. Report back `offer_accepted`. 200 the claimed `Step`. A session or token on the target machine may also accept a different session than the one the offer names. |
| `POST /v1/steps/:id/decline` (`DeclineRequest`) | 404; no open offer → 409 `<id> has no open offer`; caller is neither the target machine's owner nor matched by the target's policy (`acceptMatches` with the caller as `byUser` and the caller machine as `byMachine`; the policy is the named session's override when the offer names a session that has one, else the target machine's stored `accept`, as on assign) → 403 `only the owner of <machine name> can decline <id>`. Sets `state = "declined"`, `note`, `decidedAt`; the step stays `ready`; the goal's stick is kept. Event `step.declined`. Report back `offer_declined`. 200 `Step`. |
| `POST /v1/steps/:id/withdraw` (`{}`) | 404; no open offer → 409 `<id> has no open offer`; caller not `offer.by` and not admin → 403 `only @<by> or an admin can withdraw the offer of <id>`. Sets `state = "withdrawn"`, `decidedAt`. Event `step.offer_withdrawn`. 200 `Step`. |
| `POST /v1/goals/:id/withdraw` (`{}`) | 404 `no goal <id>`. Clears `Goal.stick` if the caller is its `by` or an admin, and withdraws every open offer on the goal's steps whose `by` is the caller (admin: every one), each with event `step.offer_withdrawn`. Nothing to do → 409 `<id> has no stick and no open offer of yours`. 200 `GoalWithdrawResult`. |
| `GET /v1/offers` | `{offers: OfferView[]}`: open offers on `ready` steps whose target machine belongs to the caller (all their machines), ordered by `at`, then step id. |
| `POST /v1/steps/:id/claim` | Runs in `goalTx` (see Concurrency). While the step has an open offer: a `sid` that is not the caller's on this machine → 403 `session <sid> is not yours on this machine`; a claim whose caller machine is the target machine succeeds and is an accept (as above: `step.accepted`, report back); a claim by `offer.by` from another machine succeeds and ends the offer as `withdrawn` (event `step.offer_withdrawn`, payload `reason: "claimed by the offerer"`); any other claim → 409 `<id> is offered to <machine name>`. Without an open offer: unchanged. |
| `GET /v1/steps?ready=1` | Omits steps with an open offer whose target machine is not the token's machine, unless the caller is `offer.by`. Steps offered to the token's machine come first (then the previous order). Without `ready=1`: unchanged (steps carry `offer`). |
| `GET /v1/goals/:id` | `GoalDetail` gains `offers` and `stick` as defined above. |
| `POST /v1/questions` | Unchanged, except `toUsers` gains `offer.by` on a step whose offer is `accepted` (see Questions on an offered step). |
| `GET /v1/attention` (and `/v1/live` `attention`) | Kind `offer` for every open offer to one of the viewer's machines: text `@<by> offers <step> "<title>" to <machine name>`, `goal`, `step`, `at` = offer time. Kind `offer_expired` for a `ready` step whose last offer is `expired` and was made by the viewer: text `the offer of <step> to <machine name> expired; it is ready again`, `goal`, `step`, `at` = `decidedAt`. |
| `GET /v1/fleet` | Machines carry `accept` once reported; sessions carry `accept` when they have an override. |
| `POST /v1/sync` | Stores `machine.accept` when given (in the machine's JSON, with repos and labels kept). A sync without it keeps the stored policy. |

**Stick.** Every `step.ready` event the hub emits for a step of a goal with a `stick`, for a step
that is not a gate and has no open offer, is followed by an offer of that step to the stick's target
by the stick's offerer (`stick: true` in the offer and the event payload), evaluated and messaged as
above. Releasing a step (no `step.ready` event) does not re-offer it. A stick target that no longer
resolves (machine or session gone) offers nothing and keeps the stick.

**Expiry.** `HubService.tick()` sets every open offer on a `ready` step with `now - at >= offerExpiryMs`
to `expired` (`decidedAt = now`), emits `step.offer_expired` and reports back `offer_expired`.
Running the tick twice expires once.

**Offer ends with its step.** A change that moves a step with an open offer out of `ready` other than
a claim or accept (a new plan drops it, a replan blocks it, it is parked) ends the offer in the same
transaction: `state = "withdrawn"`, `decidedAt`, event `step.offer_withdrawn` with payload
`reason: "step <new state>"`. No report-back message is sent for it.

**Release.** Releasing a step whose offer is `accepted` removes `step.offer` (the step then has no
offer; the goal page shows none), so `offer_done`, `offer_failed` and `offer_question` never reach the
offerer for work a later holder does.

**Questions on an offered step.** `POST /v1/questions` with a `step` whose offer is `accepted` adds
`offer.by` to the question's `toUsers` (after the asker and the goal owner, without repeats), so the
offerer may answer it with `mesh answer` and sees it in `/v1/attention` as a `question`.

**Machine-wide message.** Inbox row with `toMachine` = target machine, `toSid: ""`, `kind: "offer"`,
`fromUser` = offerer, text `MESH: @<by> offers step <id> "<title>" (repo <repo>) to this machine` plus
`: <note>` when a note was given, `data: {step, goal, repo, topics: <goal topics>, auto, by, sid?, note?}`
(`sid` = the target session when the offer names one). `GET /v1/inbox` returns it with `toSid: ""`.

**Report back.** Messages to the offering session (`offer.bySid`; none when it is absent, unknown or
ended), queued like other inbox messages:

| kind | when | text |
|---|---|---|
| `offer_accepted` | accept | `MESH: <accepted> accepted <step> "<title>".` |
| `offer_declined` | decline | `MESH: <machine name> declined <step> "<title>"` + `: <note>` when given + `. It is ready again.` |
| `offer_expired` | expiry | `MESH: the offer of <step> "<title>" to <machine name> expired (not accepted within <n> min). It is ready again.` (`n` = `offerExpiryMs` in whole minutes) |
| `offer_done` | `step.done` of a step whose offer is `accepted` (see Release) | `MESH: <step> "<title>" (offered to <machine name>) is done: <summary>` |
| `offer_failed` | `step.failed` of such a step | `MESH: <step> "<title>" (offered to <machine name>) failed: <summary>` |
| `offer_question` | `POST /v1/questions` with that `step` | `MESH: question on <step> (offered to <machine name>) from @<user>: <text>. Answer with: mesh answer <question id> <text>` |

**Events** (`docs/events.md`): `step.offered` (user = offerer, sid = `bySid`; payload `machine`, `sid?`, `auto`, `note?`, `stick?`),
`step.accepted` (user, sid = accepting session; payload `machine`, `sid?`), `step.declined` (user; payload `machine`, `note?`),
`step.offer_expired` (no user; payload `machine`), `step.offer_withdrawn` (user; payload `machine`, `reason?`).
`machine` is the target machine id. `/v1/live` activity texts, `<host>` = the target's hostname:
`offered <step> to <host>`, `accepted <step> on <host>`, `declined <step> on <host>`,
`the offer of <step> to <host> expired`, `withdrew the offer of <step> to <host>`.

### Hub store (src/store/hub-store.ts)

| Interface | Change |
|---|---|
| `HubStore.SCHEMA_VERSION` | Stays 6. |
| `MachineRow` | Gains `accept?: string[]` (absent when never reported; a row without it is `toStrictEqual` to the MM-2 shape). |
| `MachineFacts` / `touchMachine` | `facts.accept` given: stored; absent: kept. Repos, labels, share, nickname are kept by an accept-only change and vice versa. |
| `addMessage({toSid: ""…})`, `inbox(machine)` | Machine-wide rows are stored and listed like others (no change in signature). |

### Daemon (src/daemon)

| Interface | Behaviour |
|---|---|
| Sync body | `machine` is `{share, accept: config.accept, repos?}` on every sync. `sessionMetadata(s)` copies `accept` when present. |
| Machine-wide message, `kind: "offer"` | Handled by the daemon at most once at a time per hub message id (a message being handled is skipped by a later pull in the same process). The `accept` and `decline` calls carry the header `Idempotency-Key: offer-<message id>`, so a retry after a lost reply replays the hub's first 2xx answer. The message is acked only after the hub answered (for (3): after the person was notified); the ack is the handled mark, and no daemon store table is added. In order: (1) `assignments: "off"` → `POST /v1/steps/<step>/decline {note: "this machine does not take assignments"}`, ack `delivered` method `declined`. (2) `auto: true` → `pickSession(live sessions, {repo, topics, sid})`; found → `POST /v1/steps/<step>/accept {sid}`, the session is bound to the step, `stepMessage(step)` is queued for it (the existing pending queue delivers it when the session is idle), ack `delivered` method `accepted`; the accept refused (409/403, e.g. expired or withdrawn) → ack `failed`, nothing bound. Not found and `assignments: "launch"` → `deps.launchStep(<repo name>, step)`, ack `delivered` method `launched` (`{ok: false}` → logged, ack `delivered` method `listed`, and the person is notified as in (3)). (3) Otherwise (`auto: false`, or nothing to pick under `deliver`) → nothing is claimed; when notifications are on, `deps.notify("mesh", "@<by> offers <step> \"<title>\": mesh offers")`; ack `delivered` method `listed`. Hub unreachable during (1)/(2): the message stays unacked and is handled again on a later pull (also after a daemon restart), with the same `Idempotency-Key`. |
| Machine-wide message of another kind | Ack `failed`. Session messages (non-empty `toSid`) are unchanged. |
| `DaemonDeps.launchStep?(repo: string, step: string): Promise<{ ok: boolean; error?: string }>` | New. Default: starts `<this mesh> run <repo> --step <step> --no-tui` detached (it claims from this machine, which is the accept). Tests inject a fake. Never called for an offer with `auto: false`. |
| `POST /local/accept {step: string, target?: string}` | Not logged in → 409 `not logged in to a hub; run: mesh login`. Reads the step (`GET /v1/steps/:id`, field `context.step` of its `StepView`); `target` given → `findSession`, none → 404 `no live session matches "<target>"`, that session is used (any state); else `pickSession` with the offer's named `sid` if any; none → 409 `no idle session for <repo> on this machine; use --session <s> or --launch`. Then as auto accept (accept, bind, queue brief). 200 `{step, sid, message: "<session name> now holds <step>"}`. Hub errors: their status and `error` text. |
| `GET /local/offers` | `{offers: OfferView[]}` from `GET /v1/offers`, only those whose `machine` is this installation's machine. 409 when not logged in (as `/local/fleet`). |
| `POST /local/decline {step: string, note?: string}` | Proxies `POST /v1/steps/:id/decline`; 200 `{step: Step}`; hub errors pass through. |
| `POST /local/session-accept {target: string, accept: string[] \| null}` | `findSession`; none → 404 `no live session matches "<target>"`. `null` removes the override; otherwise `parseAccept` (error → 400 with its text). 200 `{session}`. The next sync carries it. |
| `DaemonClient` (src/cli/client.ts) | New: `accept(step, target?)`, `offers()`, `decline(step, note?)`, `sessionAccept(target, accept \| null)`. |
| MCP `mesh_assign {target, to, stick?, note?}` | `target` with a `.` → step route, else goal route; `sid` = the calling session. Text as `mesh assign` stdout. Hub errors → tool error with the hub's text. |
| MCP `mesh_offers {}` | `GET /v1/offers`: one `offerLine` per offer, or `No offers for your machines.` |
| MCP `mesh_accept {step}` | `POST /v1/steps/<step>/accept {sid: calling session}`; binds the session; returns the brief (as `mesh_claim`). Errors → tool error with the hub's text. |
| MCP `mesh_next` | Steps offered to this machine first, each line suffixed ` · offered to you by @<by>`. |

### CLI

| Command | Behaviour |
|---|---|
| `mesh assign <goal\|step> --to <machine>[/<session>] [--stick] [--note "…"]` | Missing target or `--to` → stderr starting `usage: mesh assign <goal|step> --to <machine>[/<session>] [--stick] [--note "…"]`, exit 2. Target with `.` → `POST /v1/steps/:id/assign`, else `POST /v1/goals/:id/assign` (no `sid`). Step: stdout `Offered <id> to <to> (auto-accept).` or `Offered <id> to <to> (waits for them to accept).` Goal: `Offered <ids, comma-separated> to <to> (…).` (same suffixes) or, with `--stick` and nothing ready, `No step of <G> is ready now.`; with `--stick` a second line `Later steps of <G> go to <to> too (until: mesh withdraw <G>).` Exit 0. Hub error: its text on stderr, exit 1. |
| `mesh offers [--json]` | `GET /v1/offers`; one `offerLine` per offer, or `No offers for your machines.`; `--json` prints `{offers}`. |
| `mesh accept <step> [--session <s> \| --launch]` | No step, or both flags → usage on stderr (`usage: mesh accept <step> [--session <s> | --launch]`), exit 2. `--launch` → same as `mesh run <step repo> --step <step>`. Otherwise `POST /local/accept` (with `target` = `--session`); stdout its `message`, exit 0; error: its text on stderr, exit 1. |
| `mesh decline <step> [--note "…"]` | stdout `Declined <step>.`; usage/exit 2 without a step; hub error exit 1. |
| `mesh withdraw <goal\|step>` | Step: `Withdrew the offer of <step>.`; goal: `Withdrew the offers of <G>: <ids or none>; later steps are no longer offered.`; hub error exit 1. |
| `mesh session accept <session> --from <rule,…> \| --off \| --clear` | Rules parsed with `parseAccept` before the daemon call (error: its text, exit 2). `--off` = `["off"]`; `--clear` = `null`. Exactly one of the three, else stderr starting `usage: mesh session accept <session> --from <rule,…> | --off | --clear`, exit 2. stdout `<session name>: accepts offers from <rules joined ", ">` / `<session name>: accepts no offer automatically` / `<session name>: uses the machine policy`. Daemon error: text, exit 1. |
| `mesh setup --accept <rule,…>\|off` | `parseAccept` (error: its text, exit 2); stores `accept`; prints `Offers from <rules joined ", "> are accepted automatically. Restart the daemon to apply.` (for `off`: `No offer is accepted automatically. Restart the daemon to apply.`). |
| `mesh setup --assignments deliver\|launch\|off` | Other values: `--assignments must be deliver, launch or off`, exit 2. Stores `assignments`. |
| `mesh show <goal>` (`renderGoal`) | A step with an offer gets `offerText(detail.offers[id])` among its extras (after the holder); a goal with `stick` gets the line `sticks to <stick>: its next ready steps are offered there (mesh withdraw <G>)` after the topics line. Goals without offers or stick render exactly as before. |
| `mesh help` | Lists `assign`, `offers`, `accept`, `decline`, `withdraw`, `session`. |

### TUI (src/cli/tui)

| Interface | Change |
|---|---|
| `View.offers?: number` (render.ts) | Header gains `  ·  <n> offered to you` (after the needs count) when `n > 0`. |
| Session list footer | `⏎ jump · s say · a autopilot · L labels · n next step · o offers · g goals · m machines · r refresh · ↑↓ move · q quit`. |
| `renderOffers(offers: OfferView[], v: {width, height, header, now, selected?: string, status?: string})` (render.ts) | New; exactly `height` lines: header, empty line, `ASSIGNED TO YOU`, then per offer `› ` (selected, by step id) or `  ` + `offerLine(o, now)`, or `  No offers for this machine.`; last line `OFFERS_FOOTER` = `⏎ accept · d decline · o back to sessions · details: mesh offers` (status above it when given). Lines clipped to `width`. |
| Key `o` (tui.ts) | Toggles the panel (data: `DaemonClient.offers()`, refreshed every 5 s; the badge count comes from the same call). In the panel: ↑↓ select, ⏎ `DaemonClient.accept(step)` (status: its message or error), `d` `DaemonClient.decline(step)` (status `Declined <step>.`). |

### Web (web/src)

| Interface | Change |
|---|---|
| Mine tab (mine.tsx) | A `section.offers` with heading `Assigned to you` above the machines: one `li.offer` per `GET /v1/offers` entry containing the step id, title, `from @<by>`, `to <to>`, a `Decline` button (`POST /v1/steps/:id/decline`, then refetch) and `code` text `mesh accept <step>`; empty: `p` text `Nothing is assigned to you.` Refetched like the machines (SSE hint, 15 s). |
| Goal page, step panel (goals.tsx, `aria-label="step details"`) | `p.offer` with `offerText(detail.offers[step])` when the step has an offer. |
| Live attention list | Kind `offer` shows `code` `mesh accept <step>`. |

### Docs

| File | Change |
|---|---|
| `docs/guide/concepts.md` | "Offers and accept policy": offer states, that a named target session is visible to the team (Privacy), who may assign/accept/decline/withdraw, claim guard, expiry (`thresholds.offer_expiry`, default 30 min), `--stick`, accept rules and where they live (machine `accept`, session override), `assignments` (deliver, launch, off), report back. |
| `docs/guide/howto.md` | Subsection "Hand work to another machine": `mesh assign`, `mesh offers`, `mesh accept`/`decline`/`withdraw`, `mesh session accept`, `mesh setup --accept/--assignments`, TUI `o`, the web Mine tab; that under `shareSessions: steps` the hub does not know an idle session, so `<machine>/<session>` answers 404 until the session holds a step. |
| `docs/guide/install.md` | `daemon.json` fields `accept` and `assignments`; what the hub sees now includes the accept policy. |
| `src/protocol/skill.ts` `MESH_SKILL` and generated `skills/mesh/SKILL.md` | `mesh_assign`, `mesh_offers`, `mesh_accept`, and that an offered step arrives as a message to call `mesh_context`. |
| `docs/plan/implementation-plan.md` §5.6 | Rows for the seven new routes (v0.1.11). |
| `docs/events.md` | Rows for the five new events. |

### Compatibility

- `daemon.json` without `accept`/`assignments` and hub YAML without `offer_expiry` keep working (defaults).
- A v0.1.10 hub ignores `machine.accept` (zod strips it). A machine whose daemon never reported a
  policy gets only manual offers (`auto: false`); a v0.1.10 daemon acks a machine-wide message as
  `failed` and the offer stays listed in `mesh offers` until it expires.
- The daemon sync body's `machine` object now always has `accept`; the MM-1 test that compares it
  exactly (`src/daemon/inventory.test.ts`) is updated by the test-writer (not the developer) to
  include `accept: ["self"]`.
- `POST /v1/steps/:id/claim` now runs in `goalTx`: a claim waits for a concurrent goal transaction
  instead of racing it. The answers of a claim on a step without an open offer are unchanged.

## Acceptance criteria

Surfaces: unit tests; daemon tests (`src/daemon/daemon.test.ts` style); `HubStore` contract test
(SQLite always, Postgres when its URL is set); World tests (`test/helpers/world.ts`; a new
`test/assign.test.ts`; the test side may extend `World`, e.g. `restart` with `accept`/`assignments`
and a `launchStep` fake); CLI tests (`test/cli.test.ts` style); Playwright (`pnpm test:web`, not in
`pnpm check`). Tests find steps by step id, messages by `kind` + step id in `data` or text, events by
`type` + `step`, machines by id; never by list position, hostname or ordering not stated here. No test
asserts `package.json`'s version except AC-34.

| Id | Criterion | Surface | What exact state makes it FAIL? |
|---|---|---|---|
| AC-01 | `parseAccept("self, user:bob,self")` → `["self","user:bob"]`; `"off"` → `["off"]`; `"off,self"` → `off cannot be combined with other rules`; `""` → `give at least one rule, or off`; `"bob"` → `not an accept rule: bob (…)`; 21 rules → `at most 20 accept rules`. `DaemonConfig.parse` of an MM-2 `daemon.json` gives `accept: ["self"]`, `assignments: "deliver"`; `Session` accepts `accept: ["user:x"]`, rejects `["off","self"]`. | unit | Any result or default differs. |
| AC-02 | `acceptMatches`: undefined → false; `["off"]` → false; `self` matches only when offerer = target owner; `user:bob` matches bob only; `machine:m-0a1b2c3d` matches that `byMachine.id`; `machine:m1` matches a `byMachine` of the target owner with nickname `m1` and not another user's machine named `m1`. | unit (`src/core`) | Any verdict differs. |
| AC-03 | `pickSession`: with `sid` returns that session even when `working`, `undefined` when it is ended or holds a step (and never another session); without `sid` picks only `idle`, step-less, non-launching sessions in the repo, prefers more labels in `topics`, then newer `lastEventAt`, then smaller sid; none → `undefined`. | unit (`src/core`) | Wrong session or a fallback. |
| AC-04 | `offerText` and `offerLine` give exactly the documented strings for each state, with and without note. | unit | Any character differs. |
| AC-05 | Daemon sync body `machine.accept` equals the config (`["self"]` by default); `sessionMetadata` copies `accept` and adds no key when absent. The hub stores it: `/v1/fleet` machine `accept` after a flush; a sync body without `accept` keeps it; `accept` absent for a machine that never reported. | unit (hub-link) + World | Missing, stale, or overwritten by a sync without it. |
| AC-06 | Contract: `SCHEMA_VERSION` is 6; `touchMachine` with `{accept}` stores it and keeps `repos`, `reposAt`, `labels`, `share`, `nickname`; a later `touchMachine` with `repos` only keeps `accept`; `setMachineLabels` keeps `accept`; a row never given `accept` has no key. | contract (SQLite, Postgres) | Version changed or any field lost. |
| AC-07 | `POST /v1/steps/:id/assign` by alice to bob's machine nickname `b/<nick>` and to her own machine nickname returns 200 `{step, auto}` with `step.offer` fields as specified (`by`, `bySid`, `byMachine`, `at`, `state: "offered"`, `to.machine`), step still `ready`; one event `step.offered` with payload `machine`, `auto`. Errors exactly as documented: unknown step 404, gate 409, non-ready 409, already offered 409, `no machine x` 404, `no session s on <name>` 404 (also for another user's `me` session), ambiguous prefix 409; a service token 403. | World | Any status, body, field or message differs, or no event. |
| AC-08 | Target resolution: `m2` (caller's nickname), a machine id, `bob/m2`, `m2/perf` (session by name), `m2/<sid prefix ≥4>`, `bob/m2/perf` resolve to the right machine/session; `m2/x` where `m2` is the caller's machine and `x` is no session → 404 `no session x on m2`. | World | Wrong target or error. |
| AC-09 | Policy at offer time: alice→alice's machine with default policy → `auto: true`; bob→alice's machine with `["self"]` → false; with `["user:bob"]` → true; with machine rule `machine:<bob's machine id>` → true from that machine only; with `["off"]` → false; a session override `["user:bob"]` on the named session makes `auto: true` though the machine says `self`; a machine that never reported → false. | World | Any `auto` differs. |
| AC-10 | Machine-wide message: after an assign, the target machine's `GET /v1/inbox` has a row with `toSid: ""`, `kind: "offer"`, the documented text and `data` (`step`, `goal`, `repo`, `topics`, `auto`, `by`, `sid` when named); no other machine's inbox has it. | World (hub API) | Row missing, on another machine, or fields differ. |
| AC-11 | Claim guard: while offered, a claim by a third user → 409 `<id> is offered to <machine name>`; a claim from a session on the target machine succeeds and records `step.accepted` and `offer.state: "accepted"`; a claim by the offerer from another machine succeeds and the offer is `withdrawn` with `step.offer_withdrawn` payload `reason: "claimed by the offerer"`. | World | Wrong status, offer state or event. |
| AC-12 | `POST /v1/steps/:id/accept`: from the target machine with `sid` → 200 claimed step held by that sid, `offer.state "accepted"`, `decidedAt` set, events `step.claimed` and `step.accepted` (payload `machine`, `sid`); from another machine of the same owner → 403 `<id> is offered to <name>, not to this machine`; on a step without an open offer → 409 `<id> has no open offer`; a second accept → 409. | World | Any status, state or event differs. |
| AC-13 | Decline: the target owner → 200, step `ready`, `offer.state "declined"` with `note`, event `step.declined`; a user matched by the target's `user:` rule may decline; anyone else → 403 `only the owner of <name> can decline <id>`. Withdraw: the offerer or an admin → 200 `withdrawn`, event `step.offer_withdrawn`; another user → 403 `only @<by> or an admin can withdraw the offer of <id>`; no open offer → 409. After either, the step can be offered again and claimed by anyone. | World | Any status, state, event or follow-up differs. |
| AC-14 | Expiry: with `offerExpiryMs` = 30 min, `tick()` at 29 min changes nothing; at 30 min the offer is `expired`, `decidedAt` set, one `step.offer_expired`; a second `tick()` adds no event; the step is claimable by anyone; the offerer's `/v1/attention` has kind `offer_expired` with the documented text until the step is claimed. Hub YAML `thresholds.offer_expiry: 5m` gives `offerExpiryMs` 300000. | World (clock) + unit (config) | Early/late expiry, double event, guard still active, attention missing. |
| AC-15 | `GET /v1/offers`: bob sees open offers to any of his machines (by step id), with `to`, `expiresAt = at + offerExpiryMs`, `auto`, `note`; not offers to alice's machines, nor accepted/declined/expired/withdrawn ones. `GET /v1/steps?ready=1`: a step offered to bob's machine A is listed for A's token (first), omitted for bob's machine B's token and for carol, listed for the offerer. | World | Wrong membership or order. |
| AC-16 | `/v1/attention` for the target owner has kind `offer` (`@<by> offers <step> "<title>" to <name>`, `goal`, `step`) while open, and none after it ends. | World | Missing, wrong text, or stale. |
| AC-17 | Goal assign: on a new goal offers its design step (`steps` = `[<G>.design]`); a goal with two ready steps and one already offered offers the other only; nothing ready without stick → 409 `<G> has no ready step to offer`; with `stick` and nothing ready → 200 `steps: []` and `Goal.stick` set. Done goal → 409. | World | Wrong steps or status. |
| AC-18 | Stick: after `assign <G> --stick` to machine A and approving the plan, every step that becomes ready (`step.ready`) gets an offer to A with `stick: true` (payload too), one message each; a gate step gets none; a released step is not re-offered; after `POST /v1/goals/:id/withdraw` no further step is offered and open offers of the caller are `withdrawn`; withdraw with nothing to do → 409 documented text. | World | An offer missing, extra, or after withdraw. |
| AC-19 | Report back to the offering session (assign with `sid`): messages of kind `offer_accepted`, `offer_declined` (with note), `offer_expired` (`within 30 min`), and after acceptance `offer_done` / `offer_failed` (with the summary) and `offer_question` (with the question id) reach the offering session's machine inbox for that sid with the documented texts; without `sid`, or when that session ended, none is queued. | World | Message missing, extra, or text differs. |
| AC-20 | Daemon auto-accept: an `auto` offer to machine B with an idle step-less session in the repo binds that session (`GET /local/sessions` shows `step`), claims it at the hub with that sid, queues `stepMessage(step)` and pastes it (World `pastes`); with two idle sessions the one with more goal-topic labels is chosen; a named working session is claimed for and the brief is pasted only after its `Stop`; the message is acked `delivered`/`accepted`; pulling the inbox again does nothing more. | World | Wrong session, no paste, early paste, double handling. |
| AC-21 | Daemon no idle session: with `assignments: "deliver"` nothing is claimed, the offer stays open, the person gets one notification `mesh: @<by> offers <step> "<title>": mesh offers`, ack method `listed`; with `"launch"` the `launchStep` fake is called once with the repo name and the step id; a manual (`auto: false`) offer never calls `launchStep` and never claims. | World | A claim, a launch for a manual offer, or no notification. |
| AC-22 | `assignments: "off"`: every offer (auto or manual) is declined with note `this machine does not take assignments`, the offerer's session receives `offer_declined`. An accept refused by the hub (offer withdrawn before the daemon pulled) → ack `failed`, no session bound. A machine-wide message of an unknown kind → ack `failed`. | World | Not declined, wrong note, a bound session. |
| AC-23 | `POST /local/accept`: with `target` binds that session and replies `{step, sid, message: "<name> now holds <step>"}`; without target picks as `pickSession`; no candidate → 409 `no idle session for <repo> on this machine; use --session <s> or --launch`; unknown target → 404. `GET /local/offers` returns only this machine's offers. `POST /local/decline` declines. `POST /local/session-accept` sets/clears `Session.accept` (400 with the `parseAccept` text on a bad rule) and the next sync carries it. | daemon test / World | Any reply, status or binding differs. |
| AC-24 | MCP: `mesh_assign` from a session offers with `bySid` = that session and returns the `mesh assign` text; `mesh_offers` lists `offerLine`s or `No offers for your machines.`; `mesh_accept` on a step offered to this machine binds the calling session and returns the brief, and on another machine's offer returns an error with the 403 text; `mesh_next` lists the offered step first with ` · offered to you by @<by>`. | World (`w.tool`) | Wrong text, binding, or order. |
| AC-25 | CLI `mesh assign`: step and goal forms print the documented lines (auto and manual, `--stick` second line, nothing-ready line) and exit 0; missing `--to` exits 2 with the usage; a hub 404 exits 1 with `no machine x`. | CLI (World hub) | Other text or exit code. |
| AC-26 | CLI `mesh offers` (text and `--json`), `mesh accept <step> --session <s>` (stdout `<name> now holds <step>`), `mesh accept <step> --session a --launch` (exit 2), `mesh decline <step> --note x` (`Declined <step>.`), `mesh withdraw <step>` and `mesh withdraw <G>` (documented lines), `mesh session accept <s> --from self,user:bob` / `--off` / `--clear` (documented lines), bad rule exits 2 without a daemon call; `mesh help` lists the six commands. | CLI | Other text, exit code or effect. |
| AC-27 | `mesh accept <step> --launch` claims from this machine (the offer becomes `accepted`) and starts the session as `mesh run <repo> --step <step>` would (fake runner sees the tmux call). | CLI with fake runner | No accept, or no start. |
| AC-28 | `mesh setup --accept user:bob` writes `accept: ["user:bob"]` and prints the documented line; `--accept off` prints `No offer is accepted automatically. Restart the daemon to apply.`; `--accept bad` exits 2; `--assignments launch` writes it; `--assignments x` exits 2 with `--assignments must be deliver, launch or off`; a setup without these flags leaves both fields unchanged. | CLI | Wrong file content, text or exit. |
| AC-29 | `GET /v1/goals/:id` has `offers[<step>]` with the documented `OfferLine` (accepted: `accepted` = `<machine name>/<session name>`) and `stick` text; `renderGoal` shows `offered to m2 → accepted by m2/perf-bench` for that step and the stick line; a goal without offers renders byte-for-byte as before (existing `src/cli/show.test.ts` snapshots unchanged). | World + unit | Missing/wrong text or a changed old snapshot. |
| AC-30 | `/v1/live` activity texts for the five events are exactly as documented. | World | Any text differs. |
| AC-31 | TUI `render` with `offers: 2` has `  ·  2 offered to you` in the header and the documented footer; without offers the header is unchanged; `renderOffers` gives exactly `height` lines with the documented heading, `› ` on the selected offer, the empty text, and `OFFERS_FOOTER` last. Key `o`, ⏎ and `d` call `offers`/`accept`/`decline` (review: tui.ts has no harness). | unit (`render.test.ts`) + review | Text or line count differs; keys missing. |
| AC-32 | Web: Mine tab shows `Assigned to you` with an `li.offer` for an offer to the user's machine (step id, `mesh accept <step>`), `Decline` removes it within 20 s and the hub has it `declined`; with none, `Nothing is assigned to you.`; the goal page step panel shows `p.offer` with the `offerText`. | Playwright (`test/e2e-web`) | Section, row, text or decline missing. |
| AC-33 | `schemas/hub-api.openapi.json` matches `pnpm schemas` and lists the seven new routes; `HUB_API` matches `src/hub/app.ts` (rule, no scope). Docs: concepts, how-to and install guide cover the Docs table; plan §5.6 lists the seven routes; `docs/events.md` lists the five events; `MESH_SKILL` mentions `mesh_assign`, `mesh_offers`, `mesh_accept` and equals `skills/mesh/SKILL.md`. | `test/schemas.test.ts` + review | Stale schema, missing route/row, or skill mismatch. |
| AC-34 | `package.json` version is `0.1.11`; `pnpm check` passes (lint, typecheck, boundaries, test, build); `acceptMatches`, `pickSession`, `offerText`, `offerLine` live in `src/core`; `parseAccept` and the offer types in `src/protocol`. | `pnpm check` | Any check fails or the version is not 0.1.11. |
| AC-35 | Borrowed sid (B1): carol, with her token on her machine C and the sid of bob's session on machine B, gets 403 `session <sid> is not yours on this machine` on `POST /v1/steps/:id/claim` and `/accept` of a step offered to B, and the offer stays `offered`; bob's token on B with the sid of carol's session on B also gets 403 on accept. Alice's machine policy `["machine:m1"]` (m1 = her other machine): carol's assign with the sid of a session on m1 gets 403, and carol's assign without a sid has `auto: false` and `offer.byMachine` = carol's token machine. A token without a machine and without a sid gets 403 `<id> is offered to <name>, not to this machine` on accept. | World | A 200, an `accepted` offer, `auto: true`, or `byMachine` = m1. |
| AC-36 | Concurrency (B2), two hubs on one store (SQLite file always; Postgres leg required when its URL is set), 20 rounds each: (a) concurrent assign + assign of one ready step → exactly one 200 and one 409 `already offered`, one `step.offered`, one machine-wide message; (b) concurrent assign (to B) + claim by carol → either assign 200 and claim 409 `<id> is offered to <name>`, or claim 200 and assign 409; never a held step whose last `step.offered` has no `step.accepted` or end event, and never a missing `offer` after a 200 assign; (c) concurrent expiry tick + accept with the clock past the deadline → exactly one of `step.offer_expired` / `step.accepted`, and the final `offer.state` matches it. | World (two hubs) | A double offer, a lost offer, both events, or a state that contradicts the event. |
| AC-37 | Question on an accepted offer (B3): dave (a member, neither goal owner nor admin) assigns a step of alice's goal to bob's machine with his `sid`; bob accepts; bob's session asks a question on the step → its `toUsers` contains dave; dave's `/v1/attention` has it as `question`; `offer_question` reaches dave's session; dave's answer → 200. A question on a step without an accepted offer keeps `toUsers` as before. | World | `toUsers` lacks the offerer, or dave's answer gets 403. |
| AC-38 | Offer ends (S2, S3): a replan that drops or blocks a step with an open offer ends it as `withdrawn` with `step.offer_withdrawn` payload `reason: "step <state>"`; `GET /v1/offers` and `/v1/attention` no longer list it. Releasing a step with an `accepted` offer removes `step.offer`; when carol then claims and finishes it, the offerer's session gets no `offer_done`. | World | Offer still open, missing event, or a report-back after release. |
| AC-39 | Daemon retry (S1): the hub's reply to the daemon's accept is lost once (test fault injection); on a later pull the daemon calls again with the same `Idempotency-Key: offer-<message id>`, gets the replayed 200, binds the session once and acks `delivered`/`accepted`; the brief is pasted once. | World | A `failed` ack, no binding, or two pastes. |

## Open questions
- (2026-11-11) Assumed `sid` in `POST /v1/steps/:id/assign` is the **offering** session (as in claim);
  the target session goes in `to` (`m2/perf`). The CLI sends no `sid`, so `mesh assign` from a shell
  gets no report-back messages (only the attention item on expiry); MCP `mesh_assign` does.
- (2026-11-11) The design names no way to end a `--stick`. Added `POST /v1/goals/:id/withdraw` and
  `mesh withdraw <goal>`. `stick` on a step assign sets the stick of the step's goal.
- (2026-11-11) "A goal is offered through its design step": assumed a goal assign offers every ready,
  non-gate, un-offered step of the goal (in a new goal: only the design step), so it also works on a
  goal in progress.
- (2026-11-11) A claim by the offering user from another machine is allowed (the design lets the
  offerer claim) and ends the offer as `withdrawn`.
- (2026-11-11) "decline by the target machine's owner or an accept-policy match": the policy is
  evaluated with the caller as the sender (so `self` = the owner, `user:<id>` = that user).
- (2026-11-11) A machine that never reported a policy (older daemon) gets manual offers only, since
  it cannot handle a machine-wide message.
- (2026-11-11) A named target session that is gone or holds another step is not replaced by another
  session: the offer stays manual. An idle session is required only when the offer names none.
- (2026-11-11) Expiry runs only in the hub tick (no lazy check at claim time); an offer past its
  deadline but before the next tick can still be accepted.
- (2026-11-11) `offer_expired` attention is for the offerer; the design asks for "an attention item"
  only on expiry, so declines are reported by message only.
- (2026-11-11) The web cannot accept (no session to claim for); it declines and shows `mesh accept`.
- (2026-11-11) The accept policy is not shown in `mesh machines` text (MM-1/MM-2 output stays
  byte-for-byte); it is in `/v1/fleet` JSON. `assignments` stays on the daemon (not synced).
- (2026-11-11, round 1 B1) The caller machine comes from the token; a `sid` counts only when it is
  the caller's session on that machine (for a token without a machine: the caller's session).
  Assumed a bad `sid` is refused with 403 rather than silently ignored, so the caller sees it.
- (2026-11-11, round 1 B2) Chose "claim runs in `goalTx`" over extending `saveStepIf` with the
  offer: no store contract change. It serialises claims against other goal transactions, which may
  cost latency on a busy Postgres hub; the existing conditional claim save stays.
- (2026-11-11, round 1 B3) Chose adding `offer.by` to `toUsers` over dropping the `Answer with:`
  hint, so the offerer can answer.
- (2026-11-11, round 1 S2/S3) An offer on a step that leaves `ready` without a claim ends as
  `withdrawn` with a reason; releasing an accepted step removes the offer rather than adding a state.
- (2026-11-11, round 1 S6) Under `shareSessions: steps` the hub has no record of an idle session, so
  a `<machine>/<session>` target answers 404; the offer can still go to the machine alone.
- (2026-11-11) The default `launchStep` passes the step repo's name to `mesh run`, which resolves it
  under `workspaceRoots`; a repo that is not there makes the launch fail and the offer stays listed.
