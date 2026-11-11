# MM-3 implementation plan: Assign (offers, accept policy, auto-accept, Assigned to you, report back)

Spec: `docs/specs/MM-3.md` (revision 3, approved in review round 3). Branch: `feat/my-mesh-assign`. Release v0.1.11.

This plan covers the implementation only. It plans no new tests: the test side writes them from the
spec's contracts and never reads this plan. The section "Existing tests and generated files the
developer adjusts" lists every existing test, snapshot, fixture and generated file whose asserted
behaviour (or type) the spec changes, and nothing else.

## 0. Overview, build order, shared building blocks

The work goes bottom-up along the module boundaries in `.dependency-cruiser.cjs`
(`protocol` ← `core` ← `store` ← `hub` / `daemon` ← `cli`; `web` imports `src/protocol` types and
single `src/core` files directly). Each stage typechecks on its own.

| Stage | Module | Work | Criteria |
|---|---|---|---|
| 1 | `src/protocol` | `ACCEPT_RULE_TEXT`, `AcceptRule`, `AcceptPolicy`, `parseAccept`, `DaemonConfig.accept/assignments` (config.ts); `Session.accept` (session.ts); `OfferState`, `StepOffer`, `Step.offer`, `Goal.stick` (goal.ts); `SyncRequest.machine.accept`, `AssignRequest`, `DeclineRequest`, `AssignResult`, `GoalAssignResult`, `GoalWithdrawResult`, `OfferView`, `OfferLine`, `GoalDetail.offers/stick`, `Attention.kind`, `FleetMachine.accept`, `FleetSession.accept` (hub.ts); 7 `HUB_API` rows (hub-api.ts); 3 `TOOLS` (tools.ts); `MESH_SKILL` (skill.ts) | AC-01, AC-33 |
| 2 | `src/core` | new `src/core/offers.ts`: `acceptMatches`, `pickSession`, `offerText`, `offerLine`, plus helpers `machineName`, `sessionName`, `endOffersLeavingReady`, `assignText`; export from `src/core/index.ts` | AC-02, AC-03, AC-04 |
| 3 | `src/store` | `MachineRow.accept`, `MachineFacts.accept`, `MachineExtra.accept`, `machineFrom`, `touchMachine` | AC-06 |
| 4 | `src/hub` | `HubConfig.thresholds.offerExpiryMs`; `HubService`: caller machine, target resolution, assign/accept/decline/withdraw (step and goal), offers view, claim guard (claim moves into `goalTx`), ready-list filter, stick, expiry in `tick`, offer end on leaving `ready`, release drops accepted offer, questions add the offerer, report back, attention kinds, fleet `accept`, sync stores `accept`, `goalDetail.offers/stick`, live activity texts; 7 routes in `app.ts` | AC-05, AC-07 – AC-19, AC-29, AC-30, AC-35 – AC-38 |
| 5 | `src/mux` | `spawnDetached(cmd, args)` in `exec.ts` (the only place besides `claude`/`cli` that may spawn) | AC-21 (default `launchStep`) |
| 6 | `src/daemon` | sync body `accept`; `sessionMetadata` copies `accept`; machine-wide `offer` handling (`handleOffer`); `DaemonDeps.launchStep`; `/local/accept`, `/local/offers`, `/local/decline`, `/local/session-accept`; MCP `mesh_assign`, `mesh_offers`, `mesh_accept`, `mesh_next` order/suffix | AC-05, AC-20 – AC-24, AC-39, AC-40 |
| 7 | `src/main.ts` | wire `launchStep` default (via `spawnDetached`) | AC-21 |
| 8 | `src/cli` | `DaemonClient.accept/offers/decline/sessionAccept`; new `src/cli/offer-commands.ts` (`assign`, `offers`, `accept`, `decline`, `withdraw`, `session`); `mesh setup --accept/--assignments`; `newConfig`; `renderGoal` offer extras and stick line; TUI `View.offers`, footer, `renderOffers`, `OFFERS_FOOTER`, key `o` | AC-25 – AC-29, AC-31 |
| 9 | `web/src` | `api.offers`, `api.decline`; Mine tab "Assigned to you"; goal step panel `p.offer`; live attention `offer` hint | AC-32 |
| 10 | repo | `pnpm schemas`; docs (concepts, how-to, install, plan §5.6, events); `package.json` 0.1.11; adjust the listed existing tests/fixtures/snapshot; `pnpm check` | AC-33, AC-34 |

Order constraints that hold across sections:
- Stage 1 first: every later stage imports the new schemas and types.
- Stage 2 before stages 4, 6, 8, 9 (all of them use `acceptMatches`/`pickSession`/`offerText`/`offerLine`/`machineName`/`sessionName`).
- Stage 3 before the hub's sync/fleet/assign work (stage 4).
- The hub routes (stage 4) before the daemon's offer handling and local routes (stage 6), and those before the CLI/TUI (stage 8), which call them.
- Stage 5 before stage 7.
- `pnpm schemas` after the last change to `src/protocol` (`HUB_API`, `SyncRequest`, `Session`, `Step`, `MESH_SKILL`). `Session` and `Step` are not in the OpenAPI bodies except via `SyncRequest.sessions`; `SyncRequest.machine.accept` and the 7 new rows change `schemas/hub-api.openapi.json`. The `mesh.ledger.v1` schemas do not change (they are built from `src/protocol/ledger.ts`, not from `Step`/`Goal`).
- The `DaemonConfig` output type gains two required keys in stage 1, so the four code fixtures in the last section get the two keys in the same stage, or `pnpm typecheck` fails (`tsconfig.json` includes `test/` and `spikes/`).
- Docs and the version bump go last.

Blast radius summary: no hub schema migration (`SCHEMA_VERSION` stays 6). `Step.offer` and `Goal.stick`
live in the existing `value` JSON of the `step`/`goal` rows; the machine policy in `machine.extra`;
the session override in the session JSON. No `DaemonStore` change (no new table). Wire changes are
additive: `Step.offer`, `Goal.stick`, `Session.accept`, `SyncRequest.machine.accept`,
`FleetMachine.accept`, `FleetSession.accept`, `GoalDetail.offers/stick` are optional; `Attention.kind`
gains two values. Seven new hub routes, five new event types, four new local routes, three new MCP
tools, six new CLI commands. The behaviour change for existing callers: `POST /v1/steps/:id/claim`
runs in `goalTx` (serialised), and is guarded only while a step has an open offer; `GET /v1/steps?ready=1`
hides steps offered to other machines. Output without offers is byte-for-byte unchanged everywhere
except the TUI session-list footer (gains `o offers`) and `mesh help` (six more commands).

### Shared building blocks (referenced from the sections below)

**B1. `src/core/offers.ts` (new; pure; imports only `type`s from `../protocol/index.ts`, `age` from `./fleet.ts`, `repoMatches` from `./repo-id.ts`).** It must stay browser-safe: `web/src/goals.tsx` imports it directly (as it imports `../../src/core/dag.ts`).
- `machineName(m: { hostname: string; nickname?: string | undefined }): string` → `m.nickname ?? m.hostname`.
- `sessionName(s: { sid: string; name?: string | undefined; repo?: { name: string } | undefined }): string` → `s.name ?? s.repo?.name ?? s.sid.slice(0, 8)`. This is the spec's "session name" (it differs from `sessionLabel`, which falls back to the cwd folder; do not use `sessionLabel` for any MM-3 text).
- `acceptMatches`, `pickSession`, `offerText`, `offerLine` exactly as the spec's Core section (see AC-02 – AC-04).
- `endOffersLeavingReady(prev: readonly Step[], next: readonly Step[], now: number): { steps: Step[]; ended: Step[] }`: for each `n` in `next` whose `prev` (by id) had `state === "ready"` and `offer?.state === "offered"`, and `n.state !== "ready"`, return `n` with `offer = { ...n.offer, state: "withdrawn", decidedAt: now }` (in `steps`, same order) and also list it in `ended`. Others pass unchanged. Not used for claims/accepts (those set the offer themselves).
- `assignText(kind: "step" | "goal", target: string, to: string, r: AssignResult | GoalAssignResult, stick: boolean): string[]`: the stdout lines of `mesh assign` (AC-25), shared by the CLI and MCP `mesh_assign` (AC-24). Suffix `(auto-accept).` / `(waits for them to accept).` from `r.auto`. Step: `Offered <id> to <to> <suffix>`. Goal: `steps.length ? "Offered <ids joined ", "> to <to> <suffix>" : "No step of <G> is ready now."` (the latter only reachable with `stick`); with `stick` push `Later steps of <G> go to <to> too (until: mesh withdraw <G>).`. `<id>`/`<G>` come from the hub's result (`r.step.id`, `r.goal.id`), `<to>` is the text the caller typed.
- Export everything from `src/core/index.ts` (`export * from "./offers.ts";`).

**B2. Caller machine (`HubService.callerMachine(actor, sid)`, private, in `src/hub/service.ts`).** Returns `{ machine?: MachineRow; foreign: boolean; known?: HubSession }`:
- `hs = sid ? await store.getSession(sid) : undefined`.
- `actor.machineId` set: `foreign = hs !== undefined && (hs.userId !== actor.userId || hs.machineId !== actor.machineId)`; `machine = await store.getMachine(actor.machineId)`.
- no `actor.machineId`: `foreign = hs !== undefined && hs.userId !== actor.userId`; `machine = hs && !foreign ? await store.getMachine(hs.machineId) : undefined`.
- Helper `refuseForeign(r, sid)`: `if (r.foreign) throw new HubError(403, \`session ${sid} is not yours on this machine\`)`.
- Never use `machineOf(actor, sid)` for offer decisions. `machineOf` keeps setting `holderMachine` for claims without an open offer (unchanged behaviour).

**B3. Target resolution (`HubService.resolveTarget(actor, to)`, private).** Returns `{ machine: MachineRow; session?: HubSession }`, as the spec's "Offer target resolution":
- `findMachine(ref)`: `store.getMachine(ref)` ?? `store.machineByNickname(actor.userId, ref)` ?? (when `ref` has exactly one `/`: `store.machineByNickname(user, nick)` with `[user, nick] = ref.split("/")`) ?? `undefined`. `machineOr404(ref)` throws 404 `no machine ${ref}`.
- `parts = to.split("/")`: 1 part → `machineOr404(a)`; 2 parts → `findMachine(a)` → if found, machine `a` and session `b`, else `machineOr404(\`${a}/${b}\`)` without session; 3 parts → `machineOr404(\`${a}/${b}\`)`, session `c`; more than 3 → 404 `no machine ${to}` (planner decision D3).
- Session reference `ref` on machine `m`: candidates = `store.listSessions({ live: true })` filtered to `machineId === m.id`, `session.state !== "ended"`, and `sessionVisible(actor.userId, { userId, step }, m.share)`. Exact `sid`, else exact `name`, else sids starting with `ref` when `ref.length >= 4`: none → 404 `no session ${ref} on ${machineName(m)}`; more than one → 409 `"${ref}" matches several sessions on ${machineName(m)}`. Exact sid / exact name win before the prefix rule (two sessions with the same `name` → the first by `listSessions` order; planner decision D4: treat several exact name matches as the ambiguous 409 too, for safety).

**B4. Target text and names on the hub (`HubService.targetText(to)`, private).** `m = getMachine(to.machine)`; `name = m ? machineName(m) : to.machine`; with `to.sid`: `hs = getSession(to.sid)`, `sess = hs ? sessionName(hs.session) : to.sid.slice(0, 8)` → `${name}/${sess}`. Used for `OfferView.to`, `OfferLine.to`, `Goal stick` text, and the 409 "already offered" text.

**B5. Machine-wide message (`HubService.machineMessage(machineId, fromUser, kind, text, data)`, private).** `store.addMessage({ toMachine, toSid: "", fromUser, kind, text, data }, now)` then `store.afterCommit(() => bus.publish({ type: "wake", machine: machineId }))`. `addMessage`/`inbox` need no change (`to_sid` takes `""`).

**B6. Offer an eligible step (`HubService.offerStep(step, target, by, opts)`, private; inside a `goalTx`).** `target = { machine: MachineRow; session?: HubSession }`, `by = { userId; sid?; machine?: MachineRow }`, `opts = { note?; stick: boolean; goal: Goal }`:
1. `policy = target.session?.session.accept ?? target.machine.accept` (the named session's override wins only when it has one).
2. `auto = acceptMatches(policy, { byUser: by.userId, byMachine: by.machine ? { id, userId, nickname } : undefined }, { userId: target.machine.userId })`.
3. `offer: StepOffer = { to: { machine: target.machine.id, ...(sid ? { sid } : {}) }, by: by.userId, ...(by.sid ? { bySid } : {}), ...(by.machine ? { byMachine: by.machine.id } : {}), at: now, state: "offered", auto, ...(opts.stick ? { stick: true } : {}), ...(note ? { note } : {}) }`.
4. `next = { ...step, offer, updatedAt: now }`; `saveStepFrom(next, step)` (state and holder unchanged, so the conditional save passes inside `goalTx`).
5. B5 with kind `offer`, text `MESH: @${by} offers step ${id} "${title}" (repo ${repo})` + (`: ${note}` when given), `data: { step: id, goal, repo, topics: goal.topics ?? [], auto, by, ...(to.sid ? { sid: to.sid } : {}), ...(note ? { note } : {}) }`. Repo text: `step.repo` as stored (planner decision D5: `-` is not substituted; the spec's text uses `<repo>`).
6. `emit({ type: "step.offered", user: by.userId, sid: by.sid, goal, step: id, payload: { machine: target.machine.id, ...(to.sid ? { sid } : {}), auto, ...(note ? { note } : {}), ...(opts.stick ? { stick: true } : {}) } })`.
7. Return `next`.

**B7. Report back (`HubService.reportBack(offer, kind, text, data)`, private).** `this.message(offer.bySid, offer.by, kind, text, { step, goal })`. The existing `message()` already does nothing for an absent, unknown or ended sid. `fromUser` = the offerer is acceptable for the session message (planner decision D6; the spec does not name `fromUser` for report-back messages; the accepter/decliner would also be defensible).

**B8. `emitReady(goalId, stepId)` (private, replaces every `emit({ type: "step.ready", … })` in `service.ts`).** `emit(step.ready)`; then `goal = getGoal(goalId)`; if `goal?.stick`: `s = getStep(stepId)`; when `s.state === "ready"`, `s.kind !== "gate"`, and `s.offer?.state !== "offered"`: re-resolve the stick target by id (`getMachine(stick.to.machine)`; with `stick.to.sid`: `getSession(sid)` must exist, not be `ended`, and be on that machine), and when it resolves call B6 with `by = { userId: stick.by, sid: stick.bySid, machine: stick.byMachine ? getMachine(stick.byMachine) : undefined }`, `stick: true`, no note. A target that does not resolve: offer nothing, keep the stick. Call sites: `createGoal` (no stick yet; harmless), `replan`, `approvePlan` (loop), `doneStep` (loop), `decideGate` (loop), `resumeStep`. All already run inside `goalTx`, except `createGoal` (plain `store.tx`; leave it, no stick can exist on a new goal).

**B9. Offer ends when its step leaves `ready` (spec "Offer ends with its step").** In `approvePlan`, `doneStep` and `decideGate`, before the `saveSteps` calls that write `materialize`/`reopen`/`recomputeReady` results, pass the changed steps through `endOffersLeavingReady(existing, changes, now)` and save `steps` instead; after the saves, for each `ended` emit `step.offer_withdrawn` (`goal`, `step`, no `user`; planner decision D7: the actor of the transaction is not the withdrawer, so `user` is the actor when there is one — use `actor.userId`), payload `{ machine: offer.to.machine, reason: \`step ${state}\` }`. No report-back message. Two saves in `approvePlan` (`changes`, then `ready` recomputed from the store): apply B9 to both, the second against the steps read back from the store.

**B10. Claim core (`HubService.claimInTx(actor, step, sid, holderMachine)`, private).** The current body of `claimStep` after `stepOr404`, unchanged: gate 409, parked 409, `blindConflict`, `claim(...)`, `roundStartedAt`, `store.claimStep(claimed, step)` (conditional), design → goal `design`, `emit(step.claimed)`. Returns the claimed `Step`. `holderMachine` = `await this.machineOf(actor, sid)` for plain claims (unchanged), the caller machine id for accepts.

**B11. Accept effects (`HubService.markAccepted(actor, claimed, sid)`, private).** `next = { ...claimed, offer: { ...claimed.offer, state: "accepted", decidedAt: now } }`; `saveStepFrom(next, claimed)` (same state/holder, so it passes); `emit({ type: "step.accepted", user: actor.userId, sid, goal, step, payload: { machine: offer.to.machine, ...(sid ? { sid } : {}) } })`; B7 kind `offer_accepted`, text `MESH: ${accepted} accepted ${step} "${title}".` where `accepted` = `${machineName(holder machine)}/${sessionName(holder session)}` (holder session = `getSession(sid)`; none → machine name only). Return `next`.

---

## AC-01 `parseAccept`, `AcceptPolicy`, `DaemonConfig` defaults, `Session.accept`

Files: `src/protocol/config.ts`, `src/protocol/session.ts` (both already re-exported by `src/protocol/index.ts`; check and add `export * from "./config.ts"` only if missing).

Changes in `config.ts` (above `DaemonConfig`):
- `export const ACCEPT_RULE_TEXT = "an accept rule is self, off, user:<id> or machine:<nickname or id>";`
- `export const AcceptRule = z.string().regex(/^(self|off|user:[^\s,]{1,100}|machine:[^\s,]{1,100})$/, ACCEPT_RULE_TEXT);`
- `export const AcceptPolicy = z.array(AcceptRule).min(1).max(20).refine((a) => !a.includes("off") || a.length === 1, "off cannot be combined with other rules");`
- `export function parseAccept(input: string | readonly string[]): { accept: string[] } | { error: string }`:
  1. `items = typeof input === "string" ? input.split(",") : [...input]`; `seen = new Set`, `out: string[]`.
  2. For each item: `t = item.trim()`; skip `""`; if `!AcceptRule.safeParse(t).success` return `{ error: \`not an accept rule: ${t} (${ACCEPT_RULE_TEXT})\` }` (first bad item, in input order, checked before the count/off rules); if not seen, push (order kept).
  3. `out.length === 0` → `give at least one rule, or off`; `out.includes("off") && out.length > 1` → `off cannot be combined with other rules`; `out.length > 20` → `at most 20 accept rules`. Return `{ accept: out }`.
  - No lowercasing (user ids and nicknames are compared as given).
- `DaemonConfig`: add `accept: AcceptPolicy.default(["self"])` and `assignments: z.enum(["deliver", "launch", "off"]).default("deliver")` with doc comments (what each means; "the hub sees `accept`, not `assignments`").

Changes in `session.ts`: `import { AcceptPolicy } from "./config.ts";` and `Session.accept: AcceptPolicy.optional()` (after `labels`), doc comment "MM-3: per-session accept override; absent = the machine policy". No cycle: `config.ts` imports nothing from `session.ts`.

Also `src/cli/context.ts` `newConfig`: add `accept: ["self"], assignments: "deliver"` so `DaemonConfig.parse(newConfig(p))` still equals the input (existing test `test_AC01_newConfig_is_me` keeps passing).

Order: first change. Fixtures in the last section in the same stage.

Blast radius: every `DaemonConfig.parse` (CLI `loadConfig`, shim) now adds the two keys; `mesh setup` rewrites `daemon.json` with them on its next run (values unchanged). `Session` parsing in sync, `SessionsResponse` and the daemon store load: optional, additive.

Risks: zod 4 `.default()` on a refined array: put `.default` on the outer `AcceptPolicy` (it is a `ZodPipe`/refinement; `.default` exists on every schema in zod 4). Confirm `DaemonConfig.parse({ ...mm2 })` yields `accept: ["self"]` (the default is not run through the refine on output; it is a literal that passes anyway).

## AC-02 `acceptMatches`

File: `src/core/offers.ts` (B1).

```ts
export function acceptMatches(policy, offer, target): boolean {
  if (!policy || policy.includes("off")) return false;
  return policy.some((r) =>
    r === "self" ? offer.byUser === target.userId
    : r.startsWith("user:") ? offer.byUser === r.slice(5)
    : r.startsWith("machine:") ? (() => { const x = r.slice(8); const m = offer.byMachine; return !!m && (m.id === x || (m.userId === target.userId && m.nickname === x)); })()
    : false);
}
```
Signature exactly as the spec (`policy: readonly string[] | undefined`, `offer: { byUser; byMachine?: {id,userId,nickname?} | undefined }`, `target: { userId }`).

Order: stage 2. Blast radius: none outside MM-3. Risks: a nickname rule must not match another user's machine of that nickname; the `userId === target.userId` guard does that. A rule `machine:m-0a1b2c3d` matches by id for any user.

## AC-03 `pickSession`

File: `src/core/offers.ts`.

- With `want.sid`: `s = sessions.find(x => x.sid === want.sid)`; return `s` when `s && s.state !== "ended" && !s.step && !s.launching`, else `undefined` (never another session; `working` is fine).
- Without: candidates `state === "idle" && !step && !launching && repo && repoMatches(repo, want.repo)`; score = `labels.filter(l => want.topics.includes(l)).length`; sort by score desc, `lastEventAt` desc, `sid` code-point asc (use `<`/`>` comparison, not `localeCompare`); first or `undefined`.
- `want.repo === ""` (a step without repo): `repoMatches(repo, "")` is false for every repo → `undefined` (planner decision D18: no repo, no auto pick; the offer becomes `listed`).

Order: stage 2. Blast radius: daemon only. Risks: call it as `repoMatches(session.repo, want.repo)` (session repo object first, step repo string as the query): `repo.id === q || repo.name === q || repo.id.endsWith("/" + q)`, which matches both a step repo id (`example.org/team/beta`) and a bare name (`beta`).

## AC-04 `offerText` and `offerLine`

File: `src/core/offers.ts`.
- `offerText(l: OfferLine)`: switch on `l.state`: `offered` → `offered to ${l.to} by @${l.by}`; `accepted` → `offered to ${l.to} → accepted by ${l.accepted ?? l.to}`; `declined` → `offered to ${l.to} → declined${l.note ? \`: ${l.note}\` : ""}`; `expired` → `offered to ${l.to} → expired`; `withdrawn` → `offered to ${l.to} → withdrawn`.
- `offerLine(o, now)`: the spec's template literal verbatim, then `${o.note ? \` · ${o.note}\` : ""}`. `age` from `./fleet.ts`.

Order: stage 2 (needs `OfferLine`/`OfferView` from stage 1). Risks: the arrow is U+2192 `→`; the separator is ` · ` (U+00B7). Copy from the spec, do not retype.

## AC-05 Sync carries the machine policy; `sessionMetadata` copies `accept`; the hub stores it

Files:
- `src/protocol/hub.ts` `SyncRequest.machine`: `z.object({ share: ShareLevel, accept: AcceptPolicy.optional(), repos: … })` (import `AcceptPolicy` from `./config.ts`).
- `src/daemon/hub-link.ts`:
  - `HubLinkDeps.accept?: () => string[]`.
  - `doFlush`: `machine: { share, accept: this.deps.accept?.() ?? ["self"], ...(sendRepos ? { repos } : {}) }` (always sent).
  - `sessionMetadata`: add `...(s.accept ? { accept: s.accept } : {})` (after `labels`). Full records of step holders already carry it.
- `src/daemon/daemon.ts` `new HubLink({ …, accept: () => this.config.accept })`.
- `src/hub/service.ts` `sync`: `facts = req.machine ? { share, ...(req.machine.repos ? { repos } : {}), ...(req.machine.accept ? { accept: req.machine.accept } : {}) } : undefined`.
- `fleet()`: machine `...(m.accept ? { accept: m.accept } : {})`; sessions: `...(hs.session.accept ? { accept: hs.session.accept } : {})` added to the `FleetSession` object (not in `liveSession`, which feeds `/v1/live` and must stay unchanged).
- `src/protocol/hub.ts`: `FleetMachine.accept?: string[] | undefined`; `FleetSession.accept?: string[] | undefined` (declared on `FleetSession`, not on `LiveSession`).

Order: after AC-01 (types) and AC-06 (store).

Blast radius: every sync body (one more key); `/v1/fleet` JSON gains optional keys. `renderFleet`/`mesh machines` text unchanged (spec Out).

Risks: a v0.1.10 hub strips `accept` (zod `object` strips unknown keys) — fine. The exact-shape assertion in `src/daemon/inventory.test.ts:225` changes (the spec gives it to the test-writer; see the last section).

## AC-06 `HubStore` machine policy (no migration)

File: `src/store/hub-store.ts`.
- `MachineRow.accept?: string[]` (doc: "MM-3: the accept policy its daemon last reported; absent when never reported").
- `MachineFacts.accept?: string[] | undefined`.
- `type MachineExtra` gains `accept?: string[]`; `machineFrom`: `...(Array.isArray(x.accept) ? { accept: x.accept } : {})` (an empty array never gets stored; `AcceptPolicy` has `min(1)`).
- `touchMachine`: the fast path condition becomes `facts?.share === undefined && facts?.repos === undefined && facts?.accept === undefined`. In the locked path: `let x = machineExtra(r.extra); if (facts.repos !== undefined) x = { ...x, repos, reposAt: now }; if (facts.accept !== undefined) x = { ...x, accept: [...facts.accept] }; extra = (facts.repos !== undefined || facts.accept !== undefined) ? json(x) : r.extra`. `share` keeps its `COALESCE`.
- `setMachineLabels` already keeps the rest of `extra` (it deletes only `labels`). `setMachineNickname` touches only the column. `upsertMachine` (a re-login) does not write `extra` (checked), so a re-login keeps the policy.
- `SCHEMA_VERSION` unchanged (6). `addMessage`/`inbox` unchanged.

Order: stage 3, before AC-05's hub part.

Blast radius: `machine.extra` JSON gains a key; `hub-copy.ts` copies the column as is. A row never given `accept` has no key, so MM-2 `toStrictEqual` shapes hold.

Risks: Postgres and SQLite share this code (`this.db` abstraction); no dialect work. Keep `forUpdate` row lock.

## AC-07 `POST /v1/steps/:id/assign`

Files: `src/protocol/hub.ts` (`AssignRequest`, `AssignResult`), `src/protocol/hub-api.ts` (row), `src/hub/app.ts` (route), `src/hub/service.ts` (`assignStep`).

- `export const AssignRequest = z.object({ to: z.string().min(1).max(200), sid: z.string().optional(), stick: z.boolean().default(false), note: z.string().max(2000).optional() });`
- `export interface AssignResult { step: Step; auto: boolean }`.
- Route: `r("POST", "/v1/steps/:id/assign", "member", async (c, a) => c.json(await svc.assignStep(a, param(c, "id"), await body(c, AssignRequest))))` — no scope, so a service token gets 403 from `allowed` (AC-07 "a service token 403").
- `HubService.assignStep(actor, id, req)` in `goalTx`, checks in the spec's order:
  1. `step = stepOr404(id)`.
  2. `step.kind === "gate"` → 409 `${id} is a gate: a person decides it`.
  3. `step.state !== "ready"` → 409 `${id} is ${state}, not ready`.
  4. `step.offer?.state === "offered"` → 409 `${id} is already offered to ${targetText(step.offer.to)}; withdraw it first (mesh withdraw ${id})`.
  5. `target = resolveTarget(actor, req.to)` (B3).
  6. `caller = callerMachine(actor, req.sid)`; `refuseForeign` (B2). The spec lists the foreign-sid 403 under "Caller machine"; place it after target resolution (planner decision D9; the route table does not order it).
  7. `goal = goalOr404(step.goal)`; `next = offerStep(step, target, { userId, sid: req.sid, machine: caller.machine }, { note, stick: req.stick, goal })` (B6).
  8. With `req.stick`: `saveGoal({ ...goal, stick: { to: next.offer.to, by, ...(bySid), ...(byMachine), at: now }, updatedAt: now })`.
  9. Return `{ step: next, auto: next.offer.auto }`.
- Use `step.id` as stored (ids are case-insensitive in `getStep`); messages use `step.id`.

Order: after B1–B6 and AC-06.

Blast radius: new route only.

Risks: `bySid` is the given sid even when unknown to the hub (spec: "used as given"); `byMachine` absent when there is no caller machine. Keep the step `ready` and `holder*` untouched.

## AC-08 Target resolution

File: `src/hub/service.ts` (B3). Nothing else.

Risks: `m2/perf` where `m2` is the caller's nickname must resolve as machine + session even if a user called `m2` exists (machine first, as the spec says). `bob/m2` resolves via the `user/nickname` fallback only when no machine `bob` resolves for the caller. `m2/x` with `m2` the caller's machine and no session `x` → 404 `no session x on m2` (not the `user/nickname` fallback). `machineByNickname` is case-sensitive; nicknames are lowercase by rule.

## AC-09 Policy at offer time

Files: `src/hub/service.ts` (B6 step 1–2), `src/core/offers.ts` (`acceptMatches`).

The policy is read from the store at assign time: `target.session?.session.accept` (from the synced session JSON) else `target.machine.accept` (from `machine.extra`). A machine that never reported → `undefined` → `false`.

Risks: the named session's override applies only when the offer names that session; an offer to the machine alone uses the machine policy even if one session has an override.

## AC-10 Machine-wide message

Files: `src/hub/service.ts` (B5, B6 step 5). `inbox()` already maps `toSid` as stored (`""`), so `GET /v1/inbox` returns it.

Risks: `this.message()` cannot be used (it requires a session); B5 writes the row directly. `data.topics` is `goal.topics ?? []` (always an array).

## AC-11 Claim guard

File: `src/hub/service.ts` `claimStep`.

New body, wrapped in `goalTx` (was `store.tx`):
1. `step = stepOr404(id)`.
2. If `step.offer?.state !== "offered"`: `return claimInTx(actor, step, sid, await machineOf(actor, sid))` (B10; answers unchanged).
3. Open offer: `caller = callerMachine(actor, sid)`; `refuseForeign`.
4. `caller.machine?.id === step.offer.to.machine` → `claimed = claimInTx(actor, step, sid, caller.machine.id)`; `return markAccepted(actor, claimed, sid)` (B11).
5. `actor.userId === step.offer.by` → `claimed = claimInTx(...)` with `holderMachine = machineOf(actor, sid)`; then `next = { ...claimed, offer: { ...offer, state: "withdrawn", decidedAt: now } }`, `saveStepFrom(next, claimed)`, emit `step.offer_withdrawn` (user = actor, payload `{ machine: offer.to.machine, reason: "claimed by the offerer" }`); return `next`.
6. Else 409 `${id} is offered to ${machineName(target machine)}` (target machine = `getMachine(offer.to.machine)`; missing → the id).
- The gate/parked/blind checks inside `claimInTx` still run in steps 4/5 (an offered step is `ready`, so gate/parked never apply in practice).

Order: after B2, B10, B11.

Blast radius: every claim (`mesh_claim`, `mesh run --step`, the daemon's SessionStart bind, TUI `n`) now waits for the goal lock (`HubStore.serialize`). The conditional `store.claimStep` stays, so a racing replica still gets 409 `was claimed by someone else just now`.

Risks: `serialize()` on Postgres takes the global advisory lock that `goalTx` uses; claims are short, but a long `approvePlan` now delays claims (spec accepts this, open question round 1 B2). The SessionStart bind uses idempotency key `bind:<sid>:<step>`, so a replay of an accepted claim returns the stored first answer.

## AC-12 `POST /v1/steps/:id/accept`

Files: `src/hub/app.ts` (route, body `ClaimRequest`), `src/protocol/hub-api.ts` (row, body `ClaimRequest`), `src/hub/service.ts` `acceptStep(actor, id, sid)` in `goalTx`:
1. `step = stepOr404`; `step.offer?.state !== "offered"` → 409 `${id} has no open offer`.
2. `caller = callerMachine(actor, sid)`; `refuseForeign`.
3. `!caller.machine || caller.machine.id !== offer.to.machine` → 403 `${id} is offered to ${machineName(target)}, not to this machine`.
4. `claimed = claimInTx(actor, step, sid, caller.machine.id)`; `return markAccepted(actor, claimed, sid)`.
- Events in order: `step.claimed` (inside B10), then `step.accepted` (B11). Reply: the claimed `Step` with `offer.state "accepted"`.

Risks: a second accept → step no longer has an open offer → 409 `has no open offer` (the check precedes the claim). Accept of a session other than the named one is allowed (spec).

## AC-13 Decline and withdraw (step)

Files: `src/protocol/hub.ts` (`DeclineRequest = z.object({ note: z.string().max(2000).optional() })`), `hub-api.ts` (rows), `app.ts` (routes), `service.ts`:
- `declineStep(actor, id, note)` in `goalTx`: `stepOr404`; no open offer → 409; `target = getMachine(offer.to.machine)`; `caller = callerMachine(actor, undefined)` (no sid in the body → token machine); `policy = (offer.to.sid ? (await getSession(offer.to.sid))?.session.accept : undefined) ?? target?.accept`; allowed when `target?.userId === actor.userId || acceptMatches(policy, { byUser: actor.userId, byMachine: caller.machine && {id,userId,nickname} }, { userId: target.userId })`; else 403 `only the owner of ${machineName(target)} can decline ${id}`. Then `offer = { ...offerWithoutNote, state: "declined", ...(note ? { note } : {}), decidedAt: now }` (planner decision D10: `OfferLine.note` of a declined offer is the decline note, so the assign note is dropped and replaced by the decline note when one is given), `saveStepFrom`; emit `step.declined` (user, payload `{ machine, ...(note) }`); B7 `offer_declined` text `MESH: ${machineName(target)} declined ${id} "${title}"${note ? \`: ${note}\` : ""}. It is ready again.`. Goal stick untouched. Return the step.
- `withdrawStep(actor, id)` in `goalTx`: `stepOr404`; no open offer → 409 `${id} has no open offer`; `actor.userId !== offer.by && !actor.roles.includes("admin")` → 403 `only @${offer.by} or an admin can withdraw the offer of ${id}`; set `withdrawn`, `decidedAt`; emit `step.offer_withdrawn` (user, payload `{ machine }`). No report-back (the spec lists none). Return the step.
- Routes: `POST /v1/steps/:id/decline` (`DeclineRequest`), `POST /v1/steps/:id/withdraw` (no body schema; read `{}`).

Risks: "the step can be offered again and claimed by anyone" holds because only `state === "offered"` guards; the old offer stays on the step until replaced (spec: "kept after the offer ends").

## AC-14 Expiry

Files: `src/hub/config.ts`, `src/hub/service.ts` `tick`.
- config: `thresholds` zod gains `offer_expiry: duration.default(30 * 60_000)` and the `.default({...})` object gains `offer_expiry: 30 * 60_000`; `HubConfig.thresholds` type gains `offerExpiryMs: number`; `buildHubConfig` maps `offerExpiryMs: file.thresholds.offer_expiry`.
- `tick`: inside the existing `goalTx`, after the pause loop: `for (const s of await store.listSteps({ state: "ready" }))` with `s.offer?.state === "offered" && now - s.offer.at >= offerExpiryMs`: `next = { ...s, offer: { ...s.offer, state: "expired", decidedAt: now } }`; `if (await store.saveStepIf(next, s))` → emit `step.offer_expired` (no user, payload `{ machine }`) and B7 `offer_expired` text `MESH: the offer of ${id} "${title}" to ${machineName(target)} expired (not accepted within ${Math.round(offerExpiryMs / 60_000)} min). It is ready again.`.
- Attention `offer_expired`: see AC-16.
- `mesh hub init` template (`hubInit` in hub-commands.ts) may add `offer_expiry: "30m"` to `thresholds` (optional; planner decision D11: add it, the file is a starter config).

Risks: `saveStepIf` compares state/holder only, so "twice expires once" relies on the `offer.state` check of the second tick reading the committed value (same `goalTx`; the second tick reads `expired`). The `>=` boundary matters (30 min exactly expires).

## AC-15 `GET /v1/offers` and the ready-step list

Files: `src/protocol/hub.ts` (`OfferView`), `hub-api.ts` (row, tag `steps`), `app.ts`, `service.ts`:
- `offers(viewer)` in `store.tx`: `mine = listMachines({ userId: viewer.userId })` → map by id; for each `s` of `listSteps({ state: "ready" })` with open offer and `mine.has(offer.to.machine)`: build `OfferView { step: s.id, goal, title, repo, kind, machine: to.machine, ...(to.sid ? { sid } : {}), to: targetText(to), by, ...(bySid), ...(byMachine), at, expiresAt: at + offerExpiryMs, auto, ...(note) }`; sort by `at`, then `step` code-point.
- `listSteps(filter, viewer?)`: new optional second argument `{ userId; machineId? }`. When `filter.ready && viewer`: drop steps with an open offer whose `to.machine !== viewer.machineId` unless `offer.by === viewer.userId`; then stable-partition steps offered to `viewer.machineId` first (`[...offeredHere, ...rest]`, each keeping the existing order). The `/v1/steps` route passes `a`. Without `ready=1`: unchanged.
- `mesh next` (CLI) uses this route and inherits the order; no change there.

Risks: the CLI token is the machine token, so `mesh next` lists offered-to-me steps first; a web/service token has no machine, so only the offerer sees the offered step there.

## AC-16 Attention kinds `offer` and `offer_expired`

Files: `src/protocol/hub.ts` (`Attention.kind` union gains `"offer" | "offer_expired"`), `src/hub/service.ts` `attentionFor`:
- Read `myMachines = listMachines({ userId: viewer.userId })` and all machines (for names). In the existing `listSteps({ state: "ready" })` loop: open offer to one of `myMachines` → `{ kind: "offer", text: \`@${by} offers ${id} "${title}" to ${machineName(m)}\`, goal, step, at: offer.at }`; `offer.state === "expired" && offer.by === viewer.userId` → `{ kind: "offer_expired", text: \`the offer of ${id} to ${machineName(m)} expired; it is ready again\`, goal, step, at: offer.decidedAt ?? s.updatedAt }`.
- `/v1/live` uses `attentionFor`, so it gets them too.

Risks: an expired offer stays on the step until the step leaves `ready` or is re-offered, so the attention item lasts "until the step is claimed" (claim moves it out of `ready`). Gate steps never carry offers.

## AC-17 `POST /v1/goals/:id/assign`

Files: `src/protocol/hub.ts` (`GoalAssignResult`), `hub-api.ts` (row, tag `goals`), `app.ts`, `service.ts` `assignGoal(actor, id, req)` in `goalTx`:
1. `goal = goalOr404`; `done`/`dropped` → 409 `${id} is ${state}`.
2. `target = resolveTarget`; `caller = callerMachine(actor, req.sid)`; `refuseForeign`.
3. `steps = listSteps({ goal })` filtered `state === "ready" && kind !== "gate" && offer?.state !== "offered"`, sorted by id (planner decision D12: id order, so `steps` in the reply is deterministic).
4. None and `!req.stick` → 409 `${id} has no ready step to offer`.
5. Each: `offerStep(...)` (one message and one event per step).
6. `stick` → `saveGoal` with `stick` (as AC-07 step 8; re-read the goal first if `offerStep` does not change it — it does not).
7. `auto` = the policy verdict for the target computed once (same B6 formula; with no steps still computed). Return `{ goal: <saved goal>, steps: offered, auto }`.

Risks: on a new goal only the design step is ready, so `steps = [<G>.design]`.

## AC-18 Stick, and `POST /v1/goals/:id/withdraw`

Files: `src/protocol/goal.ts` (`Goal.stick`), `src/protocol/hub.ts` (`GoalWithdrawResult`), `hub-api.ts` (row), `app.ts`, `service.ts` (B8 in every `step.ready` site; `withdrawGoal`).
- `withdrawGoal(actor, id)` in `goalTx`: `goal = goalOr404`; `admin = actor.roles.includes("admin")`; `clear = goal.stick && (goal.stick.by === actor.userId || admin)`; `open = listSteps({ goal: id })` with open offer and `(admin || offer.by === actor.userId)`; neither → 409 `${id} has no stick and no open offer of yours`. Withdraw each (as `withdrawStep`, event each), clear the stick (`const { stick: _s, ...rest } = goal; saveGoal({ ...rest, updatedAt: now })`). Return `{ goal: saved, withdrawn: ids sorted }`.
- B8 makes every later `step.ready` offer to the stick target with `stick: true`. Release does not emit `step.ready` (unchanged), so released steps are not re-offered.

Order: B8 needs B6 and the `Goal.stick` type.

Risks: `approvePlan` emits `step.ready` also for steps that were already ready (materialize upserts): B8's "no open offer" check prevents double offers; a step whose previous offer was declined/expired gets a new stick offer on that re-emit (acceptable; planner decision D13 — the spec's rule is literally "every `step.ready` event ... for a step that ... has no open offer").

## AC-19 Report back

Files: `src/hub/service.ts`.
- `offer_accepted` (B11), `offer_declined` (AC-13), `offer_expired` (AC-14).
- `offer_done` / `offer_failed`: in `doneStep` after the `step.done`/`step.failed` emit, when `step.offer?.state === "accepted"`: B7 with `MESH: ${id} "${title}" (offered to ${machineName(target)}) is done: ${summary}` / `... failed: ${summary}`. Also in `approvePlan` where the design step's `step.done` is emitted (design accepted from a goal assign): same `offer_done` with `d.summary` (planner decision D14).
- `offer_question`: in `ask()` (AC-37).
- No report back for withdraw, or for offer ends from B9.

Risks: the offering session must still be live (`message()` checks `ended`). Parked/rejected outcomes of `doneStep` send nothing.

## AC-20 Daemon auto-accept

Files: `src/daemon/daemon.ts`, `src/daemon/hub-link.ts`.
- `HubLinkDeps.onMessage` return type becomes `"queued" | "unknown" | "handling"`; `pullInbox` acks `failed` only for `"unknown"` (unchanged), does nothing for `"handling"`.
- `Daemon.receive(m)`: first `if (m.toSid === "") { if (m.kind !== "offer") return "unknown"; void this.handleOffer(m); return "handling"; }`.
- Daemon fields: `private offersInFlight = new Set<number>()`, `private offersHandled = new Map<number, { state: "delivered" | "failed"; method?: string }>()`.
- `private async handleOffer(m)`:
  1. `done = offersHandled.get(m.id)` → re-send that ack (`link.ack`) and return (an ack lost earlier; the hub still lists it). `offersInFlight.has(m.id)` → return. Add to in-flight; `finally` remove.
  2. Parse `data` (`step`, `goal`, `repo`, `topics`, `auto`, `by`, `sid?`, `note?`); missing `step` → ack `failed`.
  3. `key = \`offer-${m.id}\``.
  4. `config.assignments === "off"` → `link.rpc("POST", \`/v1/steps/${step}/decline\`, { note: "this machine does not take assignments" }, key)`; success → ack `delivered` method `declined`; `HubRpcError` with status 409/403/404 → ack `failed`; offline (503) or other errors → leave unacked, return.
  5. `auto` → `s = pickSession(this.sessions, { repo, topics, ...(sid ? { sid } : {}) })`. Found → `link.rpc("POST", \`/v1/steps/${step}/accept\`, { sid: s.sid }, key)`; success → `this.update(s.sid, { step, nudges: 0, escalated: false })`, `this.store.queueMessage(s.sid, stepMessage(step), now)`, `void this.deliverPending(s.sid)`, ack `delivered` `accepted`; refused (4xx) → ack `failed`; offline → unacked. Not found and `assignments === "launch"` → step (5b) below.
  5b. `r = await (deps.launchStep?.(repoName, step) ?? { ok: false, error: "no launcher" })` with `repoName = repo.slice(repo.lastIndexOf("/") + 1)`; ok → ack `delivered` `launched`; not ok → `deps.log`, notify (step 6), ack `delivered` `listed`.
  6. Otherwise → `if (notifyChannels(this.config).any) await deps.notify("mesh", \`@${by} offers ${step} "${title}": mesh offers\`)` then ack `delivered` `listed`. `title`: parse from `m.text` with `/^MESH: @\S+ offers step \S+ "(.*)" \(repo /` (greedy, so quotes in titles survive); no match → the step id (planner decision D15: the spec's `data` has no title and adding one could break a strict `data` assertion).
  7. Each ack goes through a helper that records `offersHandled.set(m.id, …)` before `link.ack(...)`.
- The brief is delivered by the existing pending queue (paste on idle / Stop hook), so a `working` named session gets it only after its `Stop`.
- Imports: `pickSession` from `../core/index.ts`, `HubRpcError` from `./hub-link.ts`.

Order: after AC-12 (hub accept), AC-10.

Blast radius: only machine-wide messages; session messages unchanged.

Risks: `pickSession` gets the daemon's own session list (full records, not metadata). `hasHubMessage` in `pullInbox` never sees offers (they are not stored locally), so re-pulls reach `handleOffer`; the in-flight set and the handled map stop double handling in one process; after a restart the `Idempotency-Key` makes the hub replay its first answer.

## AC-21 Daemon with no idle session; `launchStep`

Files: `src/daemon/daemon.ts` (`DaemonDeps.launchStep?(repo: string, step: string): Promise<{ ok: boolean; error?: string }>`, used in AC-20 step 5b), `src/mux/exec.ts` + `src/mux/index.ts` (new `spawnDetached(cmd: string, args: readonly string[]): Promise<{ ok: boolean; error?: string }>`: `spawn(cmd, args, { detached: true, stdio: "ignore" })`, resolve `{ ok: true }` on `spawn` event, `{ ok: false, error }` on `error`; `child.unref()`), `src/main.ts` (`launchStep: (repo, step) => spawnDetached(self[0], [self[1], "run", repo, "--step", step, "--no-tui"])` in the `defaultDeps({...})` call of `mesh up`).
- `defaultDeps` gets no `launchStep` (World and other test daemons never spawn; with none, the launch counts as failed → `listed` + notification).
- Never call `launchStep` when `auto` is false (AC-20 step 5 only).

Risks: `.dependency-cruiser.cjs` rule `processes-only-in-adapters` forbids `child_process` in `src/main.ts` and `src/daemon`; that is why the spawn lives in `src/mux`. `mesh run --no-tui` must exist as a flag (it is listed in its usage).

## AC-22 `assignments: "off"`, refused accept, unknown machine-wide kind

Files: `src/daemon/daemon.ts` (AC-20 steps 4, 5 and `receive`).

Risks: under `off`, decline even manual offers (step 4 runs before the `auto` check). The hub's decline check passes because the daemon's token belongs to the target machine's owner. The refused accept must not call `update` (nothing bound).

## AC-23 Local routes `/local/accept`, `/local/offers`, `/local/decline`, `/local/session-accept`

File: `src/daemon/daemon.ts` (`handle` routing plus methods), `src/cli/client.ts` (`DaemonClient`).
- `POST /local/accept {step, target?}` → `acceptLocal(b)`:
  - `!this.link?.credentials()` → 409 `not logged in to a hub; run: mesh login`.
  - `view = link.rpc<StepView>("GET", \`/v1/steps/${step}\`)`; `st = view.context.step`, `goal = view.context.goal`.
  - `target` → `s = findSession(this.sessions, target)` (any non-ended state); none → 404 `no live session matches "${target}"`. Else `s = pickSession(this.sessions, { repo: st.repo, topics: goal.topics ?? [], ...(st.offer?.state === "offered" && st.offer.to.sid ? { sid: st.offer.to.sid } : {}) })`; none → 409 `no idle session for ${st.repo} on this machine; use --session <s> or --launch`.
  - `link.rpc("POST", \`/v1/steps/${st.id}/accept\`, { sid: s.sid }, randomUUID())`; hub errors → `HttpError(e.status, e.message)` (map `HubRpcError`).
  - bind + queue brief as AC-20; reply `{ step: st.id, sid: s.sid, message: \`${sessionName(s)} now holds ${st.id}\` }`.
- `GET /local/offers` → not logged in 409; `{ offers: (await rpc("GET", "/v1/offers")).offers.filter(o => o.machine === link.credentials()?.machine) }`.
- `POST /local/decline {step, note?}` → `{ step: await rpc("POST", \`/v1/steps/${step}/decline\`, note ? { note } : {}, randomUUID()) }`; hub errors pass through with their status.
- `POST /local/session-accept {target, accept}` → `findSession`; none → 404; `accept === null` → `update(sid, { accept: undefined })`; else `r = parseAccept(accept)`, error → 400 `r.error`, else `update(sid, { accept: r.accept })`. Reply `{ session }`. `update` already triggers `link.flush()`.
- Generic: wrap hub errors in the handler so a `HubRpcError` keeps its status (today an unmapped error is a 500); add `if (e instanceof HubRpcError) status = e.status` in the `catch` of `handle`, or convert in each method.
- `DaemonClient`: `accept(step, target?)` → `POST /local/accept`, returns `{ step, sid, message }`; `offers()` → `OfferView[]`; `decline(step, note?)` → `{ step: Step }`; `sessionAccept(target, accept: string[] | null)` → `Session` (parse with `Session`).

Risks: `update` with `accept: undefined` must delete the key (it deletes undefined keys already). `Session.accept` must survive the daemon store round trip (it stores the full JSON).

## AC-24 MCP `mesh_assign`, `mesh_offers`, `mesh_accept`, `mesh_next`

Files: `src/protocol/tools.ts` (three entries), `src/daemon/tools.ts` (`dispatch` cases), `src/protocol/skill.ts` (AC-33).
- `TOOLS.mesh_assign = { description: "Offer a mesh goal or step to another machine or session (…/<session>); it is accepted automatically if their accept policy allows, else it waits for them.", input: { target: z.string().describe("goal id (G17) or step id (G17.dplane)"), to: z.string().describe("machine nickname, id, or <machine>/<session>"), stick: z.boolean().optional(), note: z.string().optional() } }`; `mesh_offers: { description: "Steps offered to your machines, waiting for an accept.", input: {} }`; `mesh_accept: { description: "Accept a step offered to this machine: this session takes it.", input: { step: z.string() } }`.
- `mesh_assign`: `path = target.includes(".") ? \`/v1/steps/${t}/assign\` : \`/v1/goals/${t}/assign\``; `r = link.rpc("POST", path, { to, sid: s.sid, stick: !!stick, ...(note ? { note } : {}) }, key)`; `ok(assignText(kind, target, to, r, !!stick).join("\n"))`.
- `mesh_offers`: `GET /v1/offers` → `offers.length ? offers.map(o => offerLine(o, host.local.now())).join("\n") : "No offers for your machines."`.
- `mesh_accept`: `step = rpc("POST", \`/v1/steps/${id}/accept\`, { sid: s.sid }, key)`; `host.update(s.sid, { step: step.id, nudges: 0, escalated: false })`; `ok(brief((await contextOf(host, step.id)).ctx))` (as `mesh_claim`).
- `mesh_next`: `me = host.link.credentials()?.machine`; lines `fmtStep(s) + (s.offer?.state === "offered" && s.offer.to.machine === me ? \` · offered to you by @${s.offer.by}\` : "")`. The hub already orders them first (AC-15).
- Update the header comments that count the tools ("nine", "eight") — cosmetic.

Risks: hub errors already become tool errors with the hub's text (`runTool` catch). `HubLink.credentials()` must be public (it is used in daemon.ts already).

## AC-25 CLI `mesh assign`

File: new `src/cli/offer-commands.ts`, registered in `hubCommands` (hub-commands.ts) or `meshCommands`.
- `assignCommand(c)`: `a = parseArgs(args, ["to", "note"])`; `[target] = a.positional`; `!target || !a.str("to")` → stderr `usage: mesh assign <goal|step> --to <machine>[/<session>] [--stick] [--note "…"]`, exit 2. `HubClient.from(c.paths).post(path, { to, stick: a.has("stick"), ...(note) })` (no `sid`); print `assignText(...)` lines; `HubCallError` → stderr message, exit 1 (as `machineCommand`).
- Summary line for `mesh help`: `offer a goal or step to another machine or session: mesh assign <goal|step> --to <machine>[/<session>] [--stick] [--note "…"]`.

Risks: `HubClient.post` already sends an idempotency key; `parseArgs` treats `--stick` as a boolean flag (not in `valueFlags`).

## AC-26 CLI `offers`, `accept`, `decline`, `withdraw`, `session accept`, `help`

File: `src/cli/offer-commands.ts`.
- `offers [--json]`: `HubClient` `GET /v1/offers`; `--json` → `c.io.out(JSON.stringify({ offers }, null, 2))`; else each `offerLine(o, Date.now())` or `No offers for your machines.`.
- `accept <step> [--session <s> | --launch]`: no step, or both flags → stderr `usage: mesh accept <step> [--session <s> | --launch]`, exit 2. `--launch` → AC-27. Else `DaemonClient(loadConfig(c.paths)).accept(step, a.str("session"))` → stdout `message`; error → stderr text, exit 1.
- `decline <step> [--note "…"]`: no step → usage `usage: mesh decline <step> [--note "…"]`, exit 2; `HubClient.post(\`/v1/steps/${step}/decline\`, note ? { note } : {})` → `Declined ${step}.`; hub error exit 1. (CLI goes to the hub directly; the TUI goes through the daemon.)
- `withdraw <goal|step>`: no target → usage, exit 2. Step (`.`) → `POST /v1/steps/:id/withdraw` → `Withdrew the offer of ${id}.`; goal → `POST /v1/goals/:id/withdraw` → `Withdrew the offers of ${G}: ${withdrawn.length ? withdrawn.join(", ") : "none"}; later steps are no longer offered.`; hub error exit 1.
- `session accept <session> --from <rule,…> | --off | --clear`: `a = parseArgs(args, ["from"])`; `[sub, target] = a.positional`; `sub !== "accept"` or no target or not exactly one of the three → stderr starting `usage: mesh session accept <session> --from <rule,…> | --off | --clear`, exit 2. `--from` → `parseAccept` (error → its text, exit 2, before any daemon call). `DaemonClient.sessionAccept(target, rules | ["off"] | null)` → stdout `${sessionName(s)}: accepts offers from ${rules.join(", ")}` / `${name}: accepts no offer automatically` (for `["off"]`) / `${name}: uses the machine policy`; daemon error → text, exit 1.
- Command names `assign`, `offers`, `accept`, `decline`, `withdraw`, `session` with one-line summaries.

Risks: `mesh session` is a new top-level command; its only subcommand is `accept`. The `--from` value with a comma is one argument.

## AC-27 `mesh accept <step> --launch`

File: `src/cli/offer-commands.ts`.
- `view = HubClient.get<StepView>(\`/v1/steps/${step}\`)`; `repo = view.context.step.repo`; `repo` empty → stderr `${step} has no repo; start it with: mesh run <repo> --step ${step}`, exit 2 (planner decision D16). Else `return runCommand(c).run([repo.slice(repo.lastIndexOf("/") + 1), "--step", step])` (import from `./mesh-commands.ts`). `mesh run --step` claims with the CLI's machine token and no sid → caller machine = target → the claim is the accept (AC-11 step 4).

Risks: circular import `offer-commands.ts` ↔ `mesh-commands.ts` if `mesh-commands.ts` imports the offer commands; register the offer commands in `hubCommands` (hub-commands.ts), which `mesh-commands.ts` already imports, and import `runCommand` lazily (`await import("./mesh-commands.ts")`) or move registration so no cycle forms (`pnpm boundaries` has `no-circular`).

## AC-28 `mesh setup --accept`, `--assignments`

File: `src/cli/mesh-commands.ts` `setupCommand`.
- `parseArgs(args, [..., "accept", "assignments"])`.
- Validate at the top with the other flags: `accept` → `parseAccept(raw)`; error → stderr text, exit 2. `assignments` not in `deliver|launch|off` → stderr `--assignments must be deliver, launch or off`, exit 2.
- After `shareArg` is applied: `if (acceptArg) config = { ...config, accept }`, `if (assignArg) config = { ...config, assignments }`.
- Output: add `acceptLine` (`Offers from ${accept.join(", ")} are accepted automatically. Restart the daemon to apply.` or, for `["off"]`, `No offer is accepted automatically. Restart the daemon to apply.`) after `shareLine` in both output branches (Claude and OpenCode-only), only when `--accept` was given. `--assignments` prints nothing (spec gives no line).
- Without these flags the stored values stay (loaded and rewritten as is; defaults written into an MM-2 file are the same values).

Risks: `--accept` must not trigger the `--uninstall` path; validation must happen before any file write.

## AC-29 Goal page offers and stick; `renderGoal`

Files: `src/protocol/hub.ts` (`OfferLine`, `GoalDetail.offers?`, `GoalDetail.stick?`), `src/hub/service.ts` `goalDetail`, `src/cli/show.ts` `renderGoal`.
- `goalDetail`: for each step with `offer`: `OfferLine { to: targetText(offer.to), state, by, at, ...(note) , ...(state === "accepted" ? { accepted } : {}) }`, `accepted` = `machineName(getMachine(step.holderMachine ?? offer.to.machine))` + (`holderSid` session record → `/${sessionName}`). Add `offers` only when non-empty; `stick: targetText(goal.stick.to)` only when `goal.stick`.
- `renderGoal`: in `extras`, right after `who(s, d)`: `d.offers?.[s.id] ? offerText(d.offers[s.id]) : ""`. After the `topics:` line (or where it would be): `if (d.stick) lines.push(\`sticks to ${d.stick}: its next ready steps are offered there (mesh withdraw ${g.id})\`)`.
- Import `offerText` from `../core/index.ts`.

Risks: goals without offers/stick must render byte-for-byte as before (existing `show.test.ts` snapshots stay unchanged); the two new outputs are conditional. `holderMachine` is set by claims; fall back to `offer.to.machine`.

## AC-30 `/v1/live` activity texts

File: `src/hub/service.ts` `describe`. New cases using `hostnames` (`host = hostnames?.get(String(payload.machine)) ?? String(payload.machine)`): `step.offered` → `offered ${s} to ${host}`; `step.accepted` → `accepted ${s} on ${host}`; `step.declined` → `declined ${s} on ${host}`; `step.offer_expired` → `the offer of ${s} to ${host} expired`; `step.offer_withdrawn` → `withdrew the offer of ${s} to ${host}`.

Risks: the timeline calls `describe` without `hostnames`; it falls back to the machine id there (not specified; acceptable).

## AC-31 TUI badge, footer, `renderOffers`, key `o`

Files: `src/cli/tui/render.ts`, `src/cli/tui/tui.ts`.
- `View.offers?: number`; header: `${v.header}${needs ? …need you : ""}${v.offers ? \`  ·  ${v.offers} offered to you\` : ""}`.
- Footer text: `⏎ jump · s say · a autopilot · L labels · n next step · o offers · g goals · m machines · r refresh · ↑↓ move · q quit`.
- `export const OFFERS_FOOTER = "⏎ accept · d decline · o back to sessions · details: mesh offers";`
- `export function renderOffers(offers: OfferView[], v: { width; height; header; now; selected?: string; status?: string }): string[]`: lines `[v.header, "", "ASSIGNED TO YOU"]`, then per offer `(o.step === v.selected ? "› " : "  ") + offerLine(o, v.now)`, or `  No offers for this machine.`; footer `[...(status ? [status] : []), OFFERS_FOOTER]`; same padding/clip/`slice(-height)` as `renderMachines` (exactly `height` lines).
- `tui.ts`: state `offersOpen`, `offers: OfferView[]`, `selectedOffer`; a 5 s timer `client.offers().then(o => offers = o).catch(() => offers = [])` started with the TUI (badge = `offers.length`); `o` toggles the panel (closes machines/goals panels like `m`/`g` do); in the panel: ↑/↓ move `selectedOffer`, ⏎ → `client.accept(step)` → status `message` or error text, `d` → `client.decline(step)` → status `Declined ${step}.`; render with `renderOffers` while open. Pass `offers: offers.length` into `render`.

Risks: the panel must not swallow `q`. The 5 s poll must stop on quit (clear the interval). `tui.ts` has no harness (review only).

## AC-32 Web: Mine tab, goal panel, live attention

Files: `web/src/api.ts`, `web/src/mine.tsx`, `web/src/goals.tsx`, `web/src/main.tsx`, `web/src/styles.css` (minimal).
- `api.offers = async () => (await call<{ offers: OfferView[] }>("GET", "/v1/offers")).offers`; `api.decline = (step: string, note?: string) => call<Step>("POST", \`/v1/steps/${encodeURIComponent(step)}/decline\`, note ? { note } : {})`.
- `MinePage`: `offers` state loaded in the same `load()` as the fleet (same 15 s poll and SSE `hint`); above the machines: `<section className="offers"><h2>Assigned to you</h2>{offers.length ? <ul>{offers.map(o => <li className="offer" key={o.step}>{o.step} "{o.title}" · from @{o.by} · to {o.to} <button onClick={() => void api.decline(o.step).then(load)}>Decline</button> <code>mesh accept {o.step}</code></li>)}</ul> : <p>Nothing is assigned to you.</p>}</section>`. The cookie-authenticated POST passes the existing same-origin check.
- `goals.tsx` step panel (`aria-label="step details"`): `{detail.offers?.[step.id] && <p className="offer">{offerText(detail.offers[step.id])}</p>}` with `import { offerText } from "../../src/core/offers.ts";` (find where the panel gets `GoalDetail`; pass it down if it only has the `Step`).
- `main.tsx` `AttentionList`: `{a.kind === "offer" && a.step && <code className="hint">mesh accept {a.step}</code>}`.

Risks: `src/core/offers.ts` must not import Node modules (B1). The web build (`vite`) bundles it; `pnpm build` checks it.

## AC-33 OpenAPI, `HUB_API`, docs, skill

Files:
- `src/protocol/hub-api.ts`: import `AssignRequest`, `DeclineRequest`, `ClaimRequest`; rows (rule `member`, no `scope`):
  - `POST /v1/steps/:id/assign` (tag `steps`, body `AssignRequest`, "Offer a ready step to a machine or session.")
  - `POST /v1/steps/:id/accept` (tag `steps`, body `ClaimRequest`, "Accept a step offered to this machine: claim it for a session.")
  - `POST /v1/steps/:id/decline` (tag `steps`, body `DeclineRequest`, "Decline an offer (the target machine's owner or a policy match).")
  - `POST /v1/steps/:id/withdraw` (tag `steps`, "Withdraw an open offer (the offerer or an admin).")
  - `POST /v1/goals/:id/assign` (tag `goals`, body `AssignRequest`, "Offer every ready step of a goal; --stick: later ready steps too.")
  - `POST /v1/goals/:id/withdraw` (tag `goals`, "End a goal's stick and withdraw your open offers on it.")
  - `GET /v1/offers` (tag `steps`, "Open offers to the caller's machines.")
- `src/hub/app.ts`: the matching seven `r(...)` entries (same paths/rules; no scope argument).
- `pnpm schemas` → `schemas/hub-api.openapi.json`, `skills/mesh/SKILL.md`.
- `src/protocol/skill.ts` `MESH_SKILL`: add `mesh_assign`, `mesh_offers`, `mesh_accept` bullets, and the line that an offered step arrives as a message telling the session to call `mesh_context`.
- Docs (generic wording, no team/person names):
  - `docs/guide/concepts.md`: new section "Offers and accept policy" covering the spec's Docs row (states, Privacy note that a named target session is visible to everyone who can see the step, who may assign/accept/decline/withdraw, claim guard, expiry `thresholds.offer_expiry` default 30 min, `--stick`, accept rules and where they live, `assignments` deliver/launch/off, report back).
  - `docs/guide/howto.md`: subsection "Hand work to another machine" under section 3 (after "Label sessions and machines"): commands, TUI `o`, web Mine tab, the `shareSessions: steps` 404 note.
  - `docs/guide/install.md`: `daemon.json` fields `accept`, `assignments`; "What the hub sees" mentions the accept policy.
  - `docs/plan/implementation-plan.md` §5.6: rows for the seven routes "(v0.1.11)".
  - `docs/events.md`: rows for `step.offered`, `step.accepted`, `step.declined`, `step.offer_expired`, `step.offer_withdrawn` with their payload keys.

Order: last protocol change before `pnpm schemas`.

Risks: the route-list test compares `HUB_API` and `app.ts` by `method path rule`; keep both in sync. The OpenAPI `operationId` is derived from the path; no clash with existing ones.

## AC-34 Version, placement, `pnpm check`

- `package.json` `"version": "0.1.11"`.
- Placement: `acceptMatches`, `pickSession`, `offerText`, `offerLine` in `src/core/offers.ts` (exported from `src/core/index.ts`); `parseAccept`, `AcceptRule`, `AcceptPolicy`, `ACCEPT_RULE_TEXT` in `src/protocol/config.ts`; `OfferState`, `StepOffer` in `src/protocol/goal.ts`; request/response types in `src/protocol/hub.ts`.
- Run, with the pinned pnpm on `PATH`: `pnpm lint`, `pnpm typecheck`, `pnpm boundaries`, `pnpm test`, `pnpm build` (= `pnpm check`), and `pnpm schemas` before `pnpm test`.

## AC-35 Borrowed sid

Files: `src/hub/service.ts` (B2 in `assignStep`, `assignGoal`, `acceptStep`, `claimStep`'s open-offer branch).
- Carol (token on C) with bob's sid on B: B2 `foreign = true` → 403 on claim and accept; nothing written (the check precedes the claim).
- Bob's token on B with carol's sid on B: `hs.userId !== actor.userId` → foreign → 403.
- Carol's assign with the sid of a session on alice's m1: foreign → 403; without sid: `byMachine` = carol's token machine, so `machine:m1` does not match → `auto: false`.
- A token without a machine and no sid → no caller machine → accept 403 `… not to this machine`.

Risks: claims of steps without an open offer must skip B2 entirely (unchanged behaviour, spec "Claims of steps without an open offer are unchanged").

## AC-36 Concurrency (two hubs, one store)

Files: `src/hub/service.ts`. Every offer-touching method runs in `goalTx` (`assignStep`, `assignGoal`, `acceptStep`, `declineStep`, `withdrawStep`, `withdrawGoal`, `claimStep`, `tick`, and the existing `approvePlan`/`doneStep`/`decideGate`/`resumeStep`/`replan`, which host B8/B9). No store interface changes.
- (a) two assigns: the second reads the first's committed offer → 409 `already offered`.
- (b) assign + claim: whichever takes the lock first decides; the other sees its result.
- (c) tick + accept: the tick's `goalTx` and the accept's `goalTx` serialise; the loser sees `expired` (accept → 409 `has no open offer`) or `claimed` (tick skips: `state !== "ready"`).

Risks: any read of a step before `serialize()` would break this; keep all reads inside `goalTx`'s callback. `views` such as `offers()`/`attentionFor` use `store.tx` only (read-only).

## AC-37 Question on an accepted offer

File: `src/hub/service.ts` `ask`.
- `toUsers: [...new Set([actor.userId, ...(owner ? [owner] : []), ...(step?.offer?.state === "accepted" ? [step.offer.by] : [])])]`.
- After `emit(question.asked)`: when the offer is accepted, B7 `offer_question` text `MESH: question on ${step.id} (offered to ${machineName(target)}) from @${actor.userId}: ${text}. Answer with: mesh answer ${q.id} <text>` — the spec writes `<text>` literally after `mesh answer <question id>`; keep the literal `<text>`.
- `answer()` needs no change: the offerer is in `toUsers`.

Risks: a question on a step without an accepted offer keeps `toUsers` exactly as before (the spread adds nothing).

## AC-38 Offer ends; release drops an accepted offer

Files: `src/core/offers.ts` (`endOffersLeavingReady`), `src/hub/service.ts` (B9 in `approvePlan`, `doneStep`, `decideGate`; `releaseStep`).
- B9 as described.
- `releaseStep`: after `release(...)`: `if (r.step.offer?.state === "accepted") delete next.offer` (copy `r.step` first); save that. Then `offer_done` cannot reach the offerer for a later holder's work (AC-19 checks `offer.state === "accepted"`).
- `GET /v1/offers` and attention read only open offers, so they stop listing it.

Risks: `replan` reopens only the design step (to `ready`) — no step leaves `ready` there. `resumeStep` moves `parked/failed` → `blocked`/`ready` (no open offer can exist on those). Takeover (`takeStep`) keeps an accepted offer (spec silent; planner decision D17, listed below).

## AC-39 Daemon retry with `Idempotency-Key`

Files: `src/daemon/daemon.ts` (AC-20), `src/hub/app.ts` (existing idempotency middleware; no change).
- The first accept call fails at the transport (reply lost) → `HubRpcError` 503 / offline → `handleOffer` returns without ack and without binding; the in-flight entry is removed in `finally`.
- The next pull calls `handleOffer` again; the accept with the same key `offer-<id>` gets the stored 200 → bind once, queue the brief once, ack `delivered`/`accepted`.

Risks: the hub stores the idempotent reply per `(key, userId)` only for 2xx JSON — a 409 is not stored, so a real refusal is answered fresh each time (fine). The link goes `offline` after a transport error; `pullInbox` does not run while offline, so the retry happens after the next successful probe/flush.

## AC-40 Unknown sid

Files: `src/hub/service.ts` (B2: an unknown sid is neither foreign nor a source of a machine; with a machine token the token's machine is the caller machine), `src/daemon/daemon.ts` (auto-accept under `steps` uses the local session list, AC-20), `src/daemon/tools.ts` (`mesh_assign` sends the calling sid; the hub records it as `bySid`).
- `mesh accept --launch` / `launchStep`: `mesh run --step` claims with no sid (machine token) → accept; the new session's SessionStart bind later claims again with its sid as the holder (same user re-bind, `claim` allows it; the offer is already `accepted`).
- Carol (token on C) with an unknown sid: claim → 409 `<id> is offered to <B name>` (not foreign, caller machine C ≠ B, not the offerer); accept → 403 `… not to this machine`.

Risks: do not 403 an unknown sid anywhere.

---

## Existing tests and generated files the developer adjusts

Only these. Each one asserts behaviour (or a type) the spec changes:

| File | Change | Why |
|---|---|---|
| `test/schemas.test.ts` `test_AC22_version` (line ~188) | `"0.1.10"` → `"0.1.11"`. | The version moves to 0.1.11 (AC-34). |
| `src/cli/tui/__snapshots__/render.test.ts.snap` (`render > renders the list (snapshot)`, footer line) | Footer becomes `⏎ jump · s say · a autopilot · L labels · n next step · o offers · g goals · m machines · r refresh · ↑↓ move · q quit`. Regenerate that file only (`vitest -u src/cli/tui/render.test.ts`) and check the diff is the footer line alone. | The spec changes the footer (AC-31). |
| `src/daemon/daemon.test.ts` (`CONFIG` literal, line ~18) | Add `accept: ["self"], assignments: "deliver"`. Assertions unchanged. | `DaemonConfig` output type gains two required keys (AC-01); type only. |
| `src/daemon/inventory.test.ts` (`config` literal in the helper, line ~87) | Same two keys. Assertions unchanged. | Same type change. |
| `test/m2-flow.test.ts` (`config` literal, line ~46) | Same two keys. Assertions unchanged. | Same type change. |
| `test/helpers/world.ts` (`config` literal in `person`, line ~117) | Same two keys (or the test side's own extension of `World` with `accept`/`assignments`, if it lands first: take theirs). | Same type change. |
| `schemas/hub-api.openapi.json` (generated) | `pnpm schemas`. | Seven new routes; `SyncRequest.machine.accept` (AC-33). |
| `skills/mesh/SKILL.md` (generated) | `pnpm schemas`. | `MESH_SKILL` mentions the new tools (AC-33). |

Not adjusted by the developer:
- `src/daemon/inventory.test.ts:225` (`expect(b.syncs[0].machine).toEqual({ share: "steps", repos: [] })`): the spec (Compatibility) assigns this update (`accept: ["self"]`) to the test-writer. On the implementation branch alone this one assertion fails until the test branch is merged; the developer reports it and does not edit it.
- `test/schemas.test.ts` route-list and OpenAPI tests: they compare `HUB_API` with `app.ts` and with the committed file; both sides change together.
- `src/cli/show.test.ts` and its snapshots: goals without offers/stick render byte-for-byte as before.
- `test/cli.test.ts` `test_AC01_newConfig_is_me`: holds because `newConfig` writes both new keys.
- `src/store/hub-store.contract.test.ts`: `SCHEMA_VERSION` stays 6; rows without `accept` are unchanged.
- `src/daemon/hub-link.test.ts`: fixtures without `accept` give the same `sessionMetadata`.
- `test/hub.test.ts:423` (attention `toEqual` with one question): that scenario has no offers.

If `pnpm test` shows another existing test failing only because of these contract changes (for example a strict `DaemonConfig` or sync-body shape), the developer adjusts it the same way (add the two keys) and lists it in the commit message. No assertion that pins behaviour the spec keeps may change.

## Planner decisions and open questions

Taken on the conservative reading; none changes a contract. The spec's "Open questions" section is
not edited by this step (this step commits the plan only); these are for the developer and reviewer.

- D1. `DaemonConfig` keeps the zod-inferred type (two new required output keys) and four code fixtures get the keys, rather than loosening the type. Alternative: export the TS type with the two keys optional and read them via `config.accept ?? ["self"]`; rejected because it diverges from the schema's output.
- D3. A target with more than three `/` parts → 404 `no machine <to>`.
- D4. Several sessions with the same exact `name` on the target machine → the ambiguous 409.
- D5. The offer message text uses `step.repo` as stored, also when empty.
- D6. Report-back messages carry `fromUser` = the offerer.
- D7. `step.offer_withdrawn` from B9 carries `user` = the actor of the transaction.
- D9. The foreign-sid 403 on assign comes after target resolution.
- D10. A decline replaces `offer.note` with the decline note (absent when none), since `OfferLine.note` for a declined offer is the decline note.
- D11. `mesh hub init` writes `offer_expiry: 30m` into its starter `thresholds`.
- D12. Goal assign offers steps in id order.
- D13. A `step.ready` re-emit for a step whose last offer ended (declined/expired) creates a new stick offer.
- D14. The design step's `step.done` on plan approval sends `offer_done` when its offer was accepted.
- D15. The daemon takes the offer title from the message text (`data` has no title).
- D16. `mesh accept --launch` on a step without a repo exits 2 with a hint.
- D17. Open question: a takeover (`POST /v1/steps/:id/take`) by another user keeps an `accepted` offer, so `offer_done` would reach the offerer for the taker's work. The spec only removes the offer on release. Left as is; a follow-up may drop the offer on takeover as on release.
- D18. Open question: `pickSession` with a step whose `repo` is empty never matches, so such auto offers end `listed` (or `launched` fails for lack of a repo).
