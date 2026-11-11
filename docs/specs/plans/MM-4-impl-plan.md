# MM-4 implementation plan: Suggest and convenience

Spec: `docs/specs/MM-4.md` (approved in review round 3). Branch: `feat/my-mesh-assign`. Release v0.1.12.

This plan covers the implementation only. It plans no new tests: the test side writes them from the
spec's contracts and never reads this plan. The section "Existing tests and generated files the
developer adjusts" lists every existing test and generated file whose asserted behaviour the spec
changes, and nothing else.

## 0. Overview, build order, shared building blocks

Bottom-up along `.dependency-cruiser.cjs` (`protocol` ← `core` ← `store` ← `hub` / `daemon` ← `cli`;
`web` imports `src/protocol` types and single browser-safe `src/core` files directly).

| Stage | Module | Work | Criteria |
|---|---|---|---|
| 1 | `src/protocol` | `Suggestion`, `SuggestView`, `MessageResult`, `MessageRequest.to` + refine (hub.ts); `DaemonConfig.maxSessions` (config.ts); 2 `HUB_API` rows + `/v1/messages` summary (hub-api.ts); `MESH_SKILL` rows (skill.ts) | AC-14, AC-17, AC-18 |
| 2 | `src/core` | new `src/core/suggest.ts` (pure: candidates, best session, `to`, rank, reason), exported from `src/core/index.ts` | AC-01 – AC-07 |
| 3 | `src/store` | none (no migration, no interface change; `listMachines({})`, `listSessions({live: true})`, `machineByNickname` exist) | – |
| 4 | `src/hub` | `HubService.suggestStep`, `suggestGoal` (read-only, `store.tx`); `HubService.say` gains `to`; 2 routes in `app.ts` | AC-01 – AC-08, AC-11 |
| 5 | `src/daemon` | `maxSessions` gate around `deps.launchStep` in `handleOffer`, pending-launch bookkeeping | AC-13 |
| 6 | `src/cli` | `mesh assign --suggest` + usage (offer-commands.ts); `mesh say <machine>/<session>` + usage + help (mesh-commands.ts); `mesh setup --max-sessions` | AC-09, AC-10, AC-12, AC-14 |
| 7 | `web/src` | `api.suggestStep/suggestGoal/assignStep/assignGoal`; `AssignPicker`; buttons in step panel and goal header; CSS | AC-15, AC-16 |
| 8 | repo | `pnpm schemas`; docs; plan §5.6; `package.json` 0.1.12; adjust `test/schemas.test.ts` version line; `pnpm check`, `pnpm build`, `pnpm test:web` | AC-17 – AC-19 |

Order constraints:
- Stage 1 first (every later stage imports the types). Stage 2 before stage 4.
- Stage 4 (hub routes, `say` with `to`) before stage 6 and 7, which call them.
- Stage 5 is independent of 4/6/7 once stage 1 has `DaemonConfig.maxSessions`.
- `pnpm schemas` after the last change to `src/protocol` (`HUB_API`, `MessageRequest`, `MESH_SKILL`).
- Docs and the version bump last; the version bump together with the `test/schemas.test.ts` version edit.

Blast radius summary: no hub schema migration, no store interface change, no new event type, no
new `/local` route, no new `DaemonClient` method, no MCP tool, no TUI change. Two new read-only hub
routes. `POST /v1/messages` gains an optional key; `toSid`/`toStep` replies stay byte-identical (no
`to` key). `DaemonConfig` gains an optional key, so existing `daemon.json` files and code fixtures
that build a `DaemonConfig` keep typechecking. Output changes for existing callers: `mesh help`
(`say` and `assign` summaries), the `mesh say` usage (gains a second line) and the `mesh assign`
usage (gains a second line; first line unchanged, existing tests use `startsWith`). `mesh say` with
a `/` in the target now goes to the hub.

### B1. `src/core/suggest.ts` (new, pure)

Imports: `type`s from `../protocol/index.ts` (`Suggestion`, `Session`, `ShareLevel`, `Repo`), `age` from
`./fleet.ts`, `repoMatches` from `./repo-id.ts`, `acceptMatches`, `machineName`, `sessionName` from `./offers.ts`,
`sessionVisible` from `./visibility.ts`. No `store` import (boundary `core → protocol` only):
structural input types instead of `MachineRow`/`HubSession`.

```ts
export interface SuggestMachine { id: string; userId: string; hostname: string; nickname?: string; lastSeen: number;
  share?: ShareLevel; repos?: Repo[]; labels?: string[]; accept?: string[] }
export interface SuggestSession { userId: string; machineId: string; session: Session }
export interface SuggestInput {
  caller: string;                                   // actor.userId
  callerMachine?: { id: string; userId: string; nickname?: string };  // token's machine, absent for cookie / no-machine token
  now: number; onlineMs: number;                    // hub ONLINE_MS (120 000)
  repos: readonly string[]; topics: readonly string[];
  any: boolean;
  machines: readonly SuggestMachine[];              // candidates (caller's, or all with team)
  callerNicknames: ReadonlySet<string>;             // nicknames of ALL the caller's machines (for `to`)
  sessions: readonly SuggestSession[];              // listSessions({live:true}), unfiltered
}
export function repoName(r: string): string        // part after last "/", lower-cased
export function wantedLabels(topics, repos): Set<string>   // topics ∪ repoName(each repo)
export function suggestionTo(m, caller, callerNicknames): string
export function compareSuggestions(a: Suggestion, b: Suggestion): number   // the Rank key only
export function suggestionReason(s: Suggestion, ctx: { caller; now; repos; unmatched: string[]; bestName?: string }): string
export function suggest(input: SuggestInput): Suggestion[]                 // filtered and sorted
```

`suggest` per machine `M`:
1. `visible` = `sessions` with `machineId === M.id`, `session.state !== "ended"`,
   `sessionVisible(caller, {userId, step: session.step}, M.share)`.
2. `unmatched` = `repos.filter(r => !(M.repos ?? []).some(x => repoMatches(x, r)) && !visible.some(v => v.session.repo && repoMatches(v.session.repo, r)))`; `repo = unmatched.length === 0` (true for empty `repos`).
3. `idleSessions` = `visible` with `state === "idle"`, `!step`, `!launching`, and when `repos.length` a
   `session.repo` with `repos.some(r => repoMatches(session.repo, r))`. `idle = idleSessions.length`.
4. Best: sort by `(labels ∩ W).length` desc, `lastEventAt` desc, sid code-point asc (use the same
   `<`/`>` comparison as `pickSession`, not `localeCompare`). `session` = its sid (omit the key when
   `idle === 0`), `sessionLabels` = sorted `(best.labels ?? []) ∩ W` (`[]` without a best).
5. `machineLabels` = sorted `(M.labels ?? []) ∩ W`. Sort with default `Array.prototype.sort` (code points).
6. `online = now - M.lastSeen < onlineMs`. `auto = acceptMatches(M.accept, {byUser: caller, byMachine: callerMachine}, {userId: M.userId})`.
7. `to = suggestionTo(...)`: `M.userId === caller` → `M.nickname ?? M.id`; else
   `M.nickname && !callerNicknames.has(M.userId) ? `${M.userId}/${M.nickname}` : M.id`.
8. `name = machineName(M)`; `user = M.userId`; `machine = M.id`; `lastSeen = M.lastSeen`.
9. `reason` from step 10; keep `unmatched` out of the returned object (not in `Suggestion`).

Filter: drop `repo === false` unless `any`. Sort with `compareSuggestions`:
`auto` (true first) → `repo` (true first) → `sessionLabels.length` desc → `machineLabels.length` desc →
`online` (true first) → `idle` desc → `lastSeen` desc → `machine` code-point asc. Nothing else.

10. Reason parts joined with `" · "`: `@${user}` only when `user !== caller`; `auto ? "auto-accept" : "waits for them to accept"`;
`online ? "online" : `last seen ${age(now - lastSeen)} ago``; when `repos.length`: `repo ? `has ${repos.map(repoName).join(",")}` : `no ${unmatched.map(repoName).join(",")}``;
`idle === 0 ? "no idle session" : idle === 1 ? "1 idle session" : `${idle} idle sessions``;
when `sessionLabels.length`: `${sessionName(best.session)} labelled ${sessionLabels.join(",")}`;
when `machineLabels.length`: `machine labels ${machineLabels.join(",")}`.

Export from `src/core/index.ts` (`export * from "./suggest.ts";`). Check that no exported name
collides with existing core exports (`repoName` is new; grep before adding).

### B2. Hub subject and view (`src/hub/service.ts`)

Private helper `private async suggestView(actor, target, steps: Step[], repos: string[], topics: string[], q: {team, any}): Promise<SuggestView>`:
- `all = q.team ? await store.listMachines() : await store.listMachines({ userId: actor.userId })`;
  `mine = q.team ? all.filter(m => m.userId === actor.userId) : all`; `callerNicknames = new Set(mine.flatMap(m => m.nickname ? [m.nickname] : []))`.
- `callerMachine = actor.machineId ? await store.getMachine(actor.machineId) : undefined`, mapped to `{id, userId, nickname?}`.
- `sessions = await store.listSessions({ live: true })` (one read, the spec's single source).
- `suggestions = suggest({...})`; return `{ target, steps, repos, topics, team: q.team, any: q.any, suggestions }`.

## AC-01 Step suggest, filter

Files: `src/protocol/hub.ts`, `src/core/suggest.ts`, `src/hub/service.ts`, `src/hub/app.ts`, `src/protocol/hub-api.ts`.

Changes:
- `hub.ts`: add `Suggestion` and `SuggestView` interfaces exactly as the spec's Types table (next to `GoalAssignResult`). Re-exported by `src/protocol/index.ts` already (`export * from "./hub.ts"`; verify).
- `service.ts`: `async suggestStep(actor: Actor, id: string, q: { team: boolean; any: boolean }): Promise<SuggestView>` inside `this.store.tx` (read-only, no `goalTx`, no `emit`):
  `step = stepOr404(id)`; gate → `HubError(409, `${id} is a gate: a person decides it`)`; `state !== "ready"` → `HubError(409, `${id} is ${state}, not ready`)`;
  open offer is NOT an error. `repos = step.repo ? [step.repo] : []`; `topics = (await store.getGoal(step.goal))?.topics ?? []`; `steps = [step.id]`; `suggestView(actor, step.id, ...)`.
- `app.ts` route (next to `/v1/steps/:id/assign`): `r("GET", "/v1/steps/:id/suggest", "member", async (c, a) => c.json(await svc.suggestStep(a, param(c, "id"), flags(c))))` with no scope argument. Local helper `const flags = (c) => ({ team: c.req.query("team") === "1", any: c.req.query("any") === "1" })`.
- `target` is the step id as stored (`step.id`), `team`/`any` echo the parsed flags.

Order: protocol types → core B1 → service → route → `HUB_API` row (AC-17).
Blast radius: new code only. Risk: `listSessions({live:true})` reads all live sessions hub-wide; acceptable (same as `findSessionOn`). Risk: `listMachines()` default order is `user_id, hostname`; the rank never depends on it (last key is `machine` id).

## AC-02 Rank key position

Files: `src/core/suggest.ts` (`compareSuggestions`).
Changes: a single comparator chaining the eight keys in spec order, using `Number(b.auto) - Number(a.auto)` etc., `b.lastSeen - a.lastSeen`, and code-point compare for `machine`. No other tiebreak, no score.
Risk: using `localeCompare` for ids would deviate from code-point order; do not.

## AC-03 Fields

Files: `src/core/suggest.ts`, `src/hub/service.ts` (`ONLINE_MS` passed as `onlineMs`).
Changes: steps 1–8 of B1. `auto` uses the token's machine only (`actor.machineId`), never a `sid`; machine policy only (no session `accept` override). `acceptMatches(undefined, …)` is already `false` (no reported policy).
Risk: label intersection must include repo names (a session label `alpha` counts when a subject repo's name is `alpha`). Use the same `repoName` for `W` and for the reason.

## AC-04 Privacy with `team=1`

Files: `src/core/suggest.ts`.
Changes: B1 step 1 filters with `sessionVisible(caller, …, M.share)` before computing `repo` (session repos), `idle`, `session`, `sessionLabels` and `reason`. Nothing else reads sessions.
Risk: `M.repos` (inventory) stays usable for `repo` of a teammate's machine; it is never returned (only `repo: boolean` and the matched names already in `repos`), matching the concepts text.

## AC-05 `to`

Files: `src/core/suggest.ts` (`suggestionTo`), `src/hub/service.ts` (B2 `callerNicknames` from all the caller's machines, also when `team` is off).
Changes: as B1 step 7. Round trip: `resolveTarget` → `findMachine(actor, ref)` tries id, then caller nickname, then `<user>/<nickname>`; the `callerNicknames.has(user)` guard keeps `<user>/<nick>` from being read as `<caller nickname>/<session>`.
Risk: `findMachine` tries `getMachine(ref)` first; a nickname equal to another machine's id would resolve to that id. Machine ids are generated (not nickname syntax), so no change.

## AC-06 Reason text

Files: `src/core/suggest.ts` (`suggestionReason`).
Changes: B1 step 10 exactly; `age` from `src/core/fleet.ts`; separators `" · "` (middle dot U+00B7 with spaces) and `","` with no space inside lists. Empty step repo → no repo part.
Risk: the reason names `sessionName(best.session)` (name, else repo name, else 8-char sid), not `sessionLabel`.

## AC-07 Goal suggest

Files: `src/hub/service.ts`, `src/hub/app.ts`.
Changes: `async suggestGoal(actor, id, q): Promise<SuggestView>` in `store.tx`: `goal = goalOr404(id)`; `done`/`dropped` → `HubError(409, `${id} is ${goal.state}`)`;
`offerable = (await store.listSteps({ goal: goal.id })).filter(s => s.state === "ready" && s.kind !== "gate" && s.offer?.state !== "offered").sort((a, b) => cmp(a.id, b.id))` (the same filter as `assignGoal`; extract it as a private `offerableSteps(goalId)` used by both, so the two can never diverge);
`repos = offerable.length ? [...new Set(offerable.map(s => s.repo).filter(Boolean))].sort(cmp) : goal.primaryRepo ? [goal.primaryRepo] : []`; `topics = goal.topics ?? []`; `steps = offerable.map(s => s.id)`.
Route: `r("GET", "/v1/goals/:id/suggest", "member", …)` next to `/v1/goals/:id/assign`, no scope.
Blast radius: `assignGoal` refactored to call `offerableSteps` (behaviour identical). Risk: `cmp` in service.ts is code-point; reuse it.

## AC-08 Step suggest errors

Files: `src/hub/service.ts`, `src/hub/app.ts`.
Changes: error order 404 → gate 409 → not-ready 409 (gate checked before state, as `assignStep`). Service token: the route has rule `member` and no scope, so `allowed()` already gives 403 (as the assign routes). No `emit`, no `save*` in either suggest method; run in `store.tx`, not `goalTx` (no `serialize`).
Risk: none beyond keeping the methods read-only.

## AC-09 CLI `mesh assign --suggest`

Files: `src/cli/offer-commands.ts`.
Changes in `assignCommand.run`:
- `a = parseArgs(args, ["to", "note"])`; `suggestMode = a.has("suggest")`.
- Usage check (AC-10) first, then for `suggestMode`:
  `path = `${isStep(target) ? "/v1/steps" : "/v1/goals"}/${enc(target)}/suggest``, query built from `team`/`any` flags (`?team=1`, `&any=1` only when given).
  `view = await HubClient.from(c.paths).get<SuggestView>(path)` inside `orFail`. If `!Array.isArray(view?.suggestions)` → `c.io.err("the hub does not offer suggestions (it needs v0.1.12 or later)")`, return 1, print nothing. (`hubFetch` turns a non-JSON 200 into `{}`, so this covers both stub cases.)
  `--json` → `c.io.out(JSON.stringify(view, null, 2))`.
  Empty → `No machine to suggest for ${target}; try --team or --any.`
  Else heading `Suggestions for ${target} (best first):`, lines `${i + 1}. ${s.to} · ${s.reason}`, then `Assign with: mesh assign ${target} --to ${first.to}` + (`view.steps.length === 0` ? `" --stick"` : `""`). Exit 0.
- Hub ≥ 400 → `HubCallError` caught by `orFail` → stderr text, exit 1 (existing).
- `assign` summary: append `; ranked machines: mesh assign <goal|step> --suggest [--team] [--any] [--json]` (mentions `--suggest`, AC-09/help row).
Order: after AC-01/AC-07 routes exist. Risk: `<target>` in the heading is the text as typed.

## AC-10 CLI usage

Files: `src/cli/offer-commands.ts`.
Changes: `ASSIGN_USAGE` becomes the two lines
`usage: mesh assign <goal|step> --to <machine>[/<session>] [--stick] [--note "…"]` + `\n       mesh assign <goal|step> --suggest [--team] [--any] [--json]` (first line byte-identical to MM-3).
Usage (exit 2, before any `HubClient` call) when: no target; `suggest` with any of `has("to")`, `has("stick")`, `has("note")`; not `suggest` with any of `has("team")`, `has("any")`, `has("json")`; not `suggest` and no `--to` value. Use `has` (not `str`) for the conflict checks so a bare `--to` also conflicts.
Blast radius: existing MM-3 tests assert `startsWith` the first line: stay green.

## AC-11 `POST /v1/messages {to}`

Files: `src/protocol/hub.ts`, `src/hub/service.ts`, `src/hub/app.ts` (signature only).
Changes:
- `MessageRequest = z.object({ toSid: z.string().optional(), to: z.string().min(1).max(200).optional(), toStep: z.string().optional(), text: … }).refine((m) => m.toSid || m.to || m.toStep, "toSid, to or toStep is required")`.
- `export interface MessageResult { id: number; toSid: string; to?: string }`.
- `HubService.say(actor, input: { toSid?; to?; toStep?; text }): Promise<MessageResult>`, three branches in this order:
  1. `toSid !== undefined`: today's code unchanged (visibility check, `message`, `emit`), reply `{ id, toSid }` (no `to` key).
  2. `to !== undefined`: `t = await this.resolveTarget(actor, input.to)` (MM-3 errors and visibility via `findSessionOn`); `!t.session` → `HubError(400, "say needs a session: <machine>/<session>")` (literal text, see Open questions); `sid = t.session.session.sid`; `id = await this.message(sid, actor.userId, "say", input.text)`; `undefined` → the existing 404 text; `emit message.sent` as today; reply `{ id, toSid: sid, to: `${machineName(t.machine)}/${sessionName(t.session.session)}` }`.
  3. `toStep`: today's code unchanged (holder sid, 409 when none).
- `app.ts`: unchanged call (`svc.say(a, await body(c, MessageRequest))`, 201).
Order: before AC-12. Blast radius: the `toSid`/`toStep` paths keep their texts and replies. The 400 text for an empty body changes to `toSid, to or toStep is required` (no existing test asserts it).

## AC-12 CLI `mesh say <machine>/<session>`

Files: `src/cli/mesh-commands.ts` (`sayCommand`).
Changes:
- Usage text `usage: mesh say <session> <text>\n       mesh say <machine>/<session> <text>`, exit 2, when target or text is missing.
- `target.includes("/")` → `try { const hub = HubClient.from(c.paths); const r = await hub.post<MessageResult>("/v1/messages", { to: target, text: words.join(" ") }); c.io.out(`Sent to ${r.to ?? target}; mesh delivers it as soon as the session can take it.`); return 0; } catch (e) { c.io.err(message); return 1; }` (covers `HubClient.from`'s not-logged-in error and `HubCallError`).
- Without `/`: unchanged (`DaemonClient.say`).
- Summary: `send a message to a session: mesh say <session> <text>, or <machine>/<session> for another machine`.
Imports: `type MessageResult` from `../protocol/index.ts` (`HubClient` already imported).
Risk: `r.to ?? target` fallback only matters against a hub that omits `to`; a v0.1.11 hub answers 400 before that.

## AC-13 `maxSessions` in the daemon

Files: `src/protocol/config.ts`, `src/daemon/daemon.ts`.
Changes:
- `DaemonConfig.maxSessions: z.number().int().min(1).max(1000).optional()` with a doc comment ("MM-4: under `assignments: launch`, an offer starts a session only while fewer are live; absent = no limit").
- `Daemon`: `private pendingLaunches = new Map<number, { step: string; at: number }>()` (key: offer message id) and
  `private liveCount(): number` that first prunes entries with `deps.now() - at >= 120_000` or with a session in `this.sessions` (`state !== "ended"`) whose `step === entry.step` (pruned for good: once seen, never counted again), then returns `this.sessions.filter(s => s.state !== "ended").length + this.pendingLaunches.size`. Constant `LAUNCH_PENDING_MS = 120_000`.
- In `handleOffer`, the `assignments === "launch"` branch: synchronously (no `await` between check and reservation, so concurrent offers of one pull see each other's reservations):
  ```ts
  const max = this.config.maxSessions;
  if (max !== undefined) {
    const n = this.liveCount();
    if (n >= max) { this.deps.log(`not starting a session for offered step ${step}: ${n} live sessions, maxSessions ${max}`); return await listed(); }
    this.pendingLaunches.set(m.id, { step, at: this.deps.now() });
  }
  const r = await this.deps.launchStep?.(…) ?? { ok: false, error: "no launcher" };
  if (!r.ok) this.pendingLaunches.delete(m.id);
  ```
  then the existing `launched` ack / failure log / `listed()`. The reservation's `at` is taken before the `launchStep` call (spec: "after its `launchStep` call" — the clock read is the same tick; see Open questions).
- Without `maxSessions` the branch is exactly as MM-3 (no map writes).
Order: config field first. Blast radius: only the launch branch; deliver/off/manual paths untouched. Hidden sessions (`launching && ended`) are excluded by `state !== "ended"`.
Risks: a launch whose session appears without the step bound (no `SessionStart` step) stays counted until expiry, then the session itself counts — intended by the spec (120 s cap). A thrown `launchStep` (rejects) must also release the place: wrap in `try/finally`-style handling (`catch` → treat as `{ok: false}`), since today a rejection would propagate to `handleOffer`'s caller log.

## AC-14 `DaemonConfig` and `mesh setup --max-sessions`

Files: `src/protocol/config.ts` (above), `src/cli/mesh-commands.ts` (`setupCommand`).
Changes:
- Add `"max-sessions"` to the value flags of `parseArgs`. When `a.has("max-sessions")`: `raw = a.str("max-sessions")`; `raw === "off"` → `maxArg = "off"`; `/^\d+$/.test(raw)` and `1 ≤ n ≤ 1000` → `maxArg = n`; else `c.io.err("--max-sessions must be a whole number from 1 to 1000, or off")`, return 2. Validate with the other flag checks, before any write.
- After the other config merges: `maxArg === "off"` → `const { maxSessions: _, ...rest } = config; config = rest`; number → `config = { ...config, maxSessions: maxArg }`; absent → unchanged.
- Output line (both the Claude and the OpenCode-only output lists, right after `acceptLine`): number → `An offer starts a session only while fewer than ${n} are live. Restart the daemon to apply.`; off → `An offer may start a session however many are live. Restart the daemon to apply.`; else no line.
- `newConfig` unchanged (no default).
Risk: none for removal: `saveConfig` writes `JSON.stringify(config)` as given (no schema pass).

## AC-15 Web step assign

Files: `web/src/api.ts`, `web/src/goals.tsx`, `web/src/styles.css`.
Changes:
- `api.ts`: `suggestStep(id, o: { team?: boolean; any?: boolean })` → `call<SuggestView>("GET", `/v1/steps/${enc(id)}/suggest${qs(o)}`)`, `suggestGoal(id, o)` on `g(id) + "/suggest"`, `assignStep(id, to)` → `call<AssignResult>("POST", `/v1/steps/${enc(id)}/assign`, { to })`, `assignGoal(id, to)` → `call<GoalAssignResult>("POST", `${g(id)}/assign`, { to })`. `qs` emits `?team=1`/`any=1` only for true flags. Import the types from `../../src/protocol/hub.ts`.
- `goals.tsx`: new component `AssignPicker({ kind: "step" | "goal", target: string, onAssigned: (text: string) => void, onCancel: () => void })`:
  state `team=false`, `any=false`, `view?`, `error?`; `useEffect` fetches `kind === "step" ? api.suggestStep : api.suggestGoal` on open and whenever `team`/`any` change. Renders `<div className="card picker" aria-label="assign picker">` with two `<label><input type="checkbox" …/> Team machines</label>` / `Without the repo`, a `<ul>` of `<li className="suggestion" data-machine={s.machine}><strong className="to">{s.to}</strong> <span className="reason">{s.reason}</span> <button aria-label={`Assign to ${s.to}`}>Assign</button></li>` in the order received, `<p className="empty">No machine to suggest.</p>` when the list is empty, `<button>Cancel</button>` → `onCancel`, and `<p className="error">` for an error. Click → `(kind === "step" ? api.assignStep : api.assignGoal)(target, s.to)` → on success `onAssigned(assignText(kind, target, s.to, r, false).join(" "))`; on error `setError(e.message)` and stay open.
- `StepPanel`: state `picking`, `assigned?`. Button `<button className="small" aria-label="Assign step">Assign</button>` when `step.state === "ready" && step.kind !== "gate" && offer?.state !== "offered"` (`offer` is the `detail.offers[id]` prop already passed). `onAssigned` → `setPicking(false); setAssigned(text); reload(); onChange()` (the GoalPage `load` refetches `detail`, so `offer` becomes `offered` and the button goes; the SSE `changed` refresh does the same). Render `{assigned && <p className="assigned">{assigned}</p>}`. Reset `assigned`/`picking` when `id` changes (in the existing `useEffect` on `reload`).
- Import `assignText` from `../../src/core/offers.ts` (already browser-safe and imported for `offerText`).
- `styles.css`: `.picker`, `.picker li.suggestion`, `.picker .reason` (muted), `p.assigned`; follow the MM-3 `.mine .offers` block.
Order: after AC-01/AC-07 routes. Risk: "the page then reloads" is read as the existing in-app reload (`load()`), not `window.location.reload()`, which would drop `p.assigned`.

## AC-16 Web goal assign and visibility

Files: `web/src/goals.tsx`.
Changes in `GoalPage`: `offerable = detail.steps.filter(s => s.state === "ready" && s.kind !== "gate" && detail.offers?.[s.id]?.state !== "offered")`; when `g.state !== "done" && g.state !== "dropped" && offerable.length > 0` render `<button className="small" aria-label="Assign goal">Assign</button>` in the header line (the `<p className="muted">` that holds `Replan`). State `picking`, `assigned?`; the picker (`kind="goal"`, `target=g.id`) renders below the header; `onAssigned` → close, `setAssigned(text)`, `load()`. `p.assigned` below the header. `Cancel` closes. Empty list text comes from `AssignPicker`.
Risk: header visibility uses `detail.offers` (the step's last offer); a step whose last offer is `declined`/`expired` is offerable, matching the hub filter.

## AC-17 OpenAPI and route table

Files: `src/protocol/hub-api.ts`, `schemas/hub-api.openapi.json` (generated).
Changes:
- Two rows: `{ method: "GET", path: "/v1/steps/:id/suggest", rule: "member", tag: "steps", query: SUGGEST_QUERY, summary: "Machines to offer a ready step to, best first, each with a reason (read-only)." }` and `{ method: "GET", path: "/v1/goals/:id/suggest", rule: "member", tag: "goals", query: SUGGEST_QUERY, summary: "Machines to offer a goal's ready steps to, best first, each with a reason (read-only)." }` with `const SUGGEST_QUERY = { team: "1: also everyone's machines", any: "1: also machines without the repo" }`. No `scope`.
- `/v1/messages` summary: "Send a message to a session (by sid or `<machine>/<session>`) or to whoever holds a step." The body schema change (`to`) flows in from `MessageRequest`.
- Run `pnpm schemas`; commit the regenerated `schemas/hub-api.openapi.json` (other `schemas/*.json` must not change; check the diff).
Risk: `operationId`s are derived from the path (`getV1StepsIdSuggest`, `getV1GoalsIdSuggest`): unique.

## AC-18 Docs and skill

Files: `docs/guide/concepts.md`, `docs/guide/howto.md`, `docs/guide/install.md`, `src/protocol/skill.ts`, `skills/mesh/SKILL.md` (generated), `docs/plan/implementation-plan.md`.
Changes:
- concepts "Offers and accept policy": a **Suggest** paragraph (what is ranked; the rank order auto, repo, session labels, machine labels, online, idle sessions, last seen, id; `--team` shows teammates' idle sessions only when visible to you; `--any`; with `--team` any member learns whether a teammate's machine has a given repo and which of its machine labels match, never its inventory list). Under **Assignments**: `maxSessions`.
- howto "Hand work to another machine": `mesh assign G7 --suggest [--team] [--any]` with a sample output (heading, two numbered lines, `Assign with:`), the web **Assign** button (step panel and goal header), `mesh say build-box/perf "…"`.
- install "Offers: `accept` and `assignments`": a `maxSessions` table row, `mesh setup --max-sessions 4` / `off`.
- `skill.ts` command table: rows `` `mesh assign <goal\|step> --suggest` `` ("ranked machines to offer work to (`--team`, `--any`)") and `` `mesh say <machine>/<session> "<text>"` `` ("send a message to a session on another machine"); then `pnpm schemas` regenerates `skills/mesh/SKILL.md`.
- plan §5.6: rows `GET /v1/steps/:id/suggest`, `GET /v1/goals/:id/suggest` marked `Suggest (v0.1.12)`; the `POST /v1/messages` row becomes "Messages (`toSid`, `toStep`, or `to`: `<machine>/<session>`, v0.1.12)".
- Names in examples generic (`alice`, `bob`, `build-box`, `perf`), no team/company names.

## AC-19 Checks and version

Files: `package.json` (`"version": "0.1.12"`), `test/schemas.test.ts` (version line).
Order: last. Run `pnpm lint`, `pnpm typecheck`, `pnpm boundaries`, `pnpm test`, `pnpm build` (= `pnpm check`), then `pnpm test:web` after `pnpm build`.
Risk: `pnpm boundaries` — `src/core/suggest.ts` must not import `src/store` (structural types only); `web` imports only `src/core/offers.ts` and protocol types.

## Existing tests and generated files the developer adjusts

| File | Why | Change |
|---|---|---|
| `test/schemas.test.ts` `test_AC34_version` (line ~260) | asserts `package.json` version `0.1.11`; AC-19 bumps to 0.1.12 | expect `"0.1.12"` (or drop the assertion: the MM-4 spec says no test asserts the version; conservative choice: update the literal) |
| `schemas/hub-api.openapi.json` | generated; two routes, `to` in `MessageRequest`, `/v1/messages` summary | `pnpm schemas` |
| `skills/mesh/SKILL.md` | generated from `MESH_SKILL` | `pnpm schemas` |

No other existing test changes: the route-table tests compare `HUB_API` with `app.ts` (both gain the
same rows); MM-3 usage tests use `startsWith` on the unchanged first line; `POST /v1/messages` tests
with `toSid` assert status/text that do not change; no snapshot contains the `say`/`assign` help
summaries or the setup output.

## Open questions (plan-level; the spec is unchanged)

- The 400 text for a `to` without a session is written in the spec as `say needs a session: <machine>/<session>`.
  Read literally (a usage hint, placeholders not filled in), unlike `no machine <ref>` where the spec fills the ref. If the reviewer reads it as filled in, change one string in `HubService.say`.
- "Counted for at most 120 000 ms … after its `launchStep` call": the reservation is taken just before the call (in the same tick, so concurrent offers see it) with `deps.now()`; the expiry is measured from that clock read. With the fake clock both readings are equal.
- A `launchStep` that rejects (throws) is treated as `{ok: false}`: it releases its place.
- `has <names>` / `no <names>` list one repo name per subject repo without removing duplicate names (two repos with the same last segment would print the name twice); the spec says "repo names of repos" and `repos` has no repeats as strings.
- `p.assigned` for a goal is shown in the goal header area; the spec names only its text.
