# Spec MM-4: Suggest and convenience

## Status
Draft

Source: `docs/analysis/2026-11-11-my-mesh-and-assign.md`, section "MM-4: Suggest and convenience".
Builds on MM-1, MM-2 and MM-3 (`docs/specs/MM-1.md` … `MM-3.md`, landed in v0.1.9 … v0.1.11).
Release v0.1.12.

## Problem

MM-3 lets a person offer a step or a goal to a machine, but they must already know which machine
has the repo, is online, has an idle session that fits, and takes their offers automatically. The
web can see goals but cannot hand one out. Talking to a session on another machine needs its sid.
And a machine with `assignments: launch` starts a new session for every offer, without a cap.

## Scope

In:
- `GET /v1/steps/:id/suggest` and `GET /v1/goals/:id/suggest`: ranked machines for a step or a
  goal, each with a one-line reason; `team=1` adds everyone's machines, `any=1` keeps machines
  without the repo.
- `mesh assign <goal|step> --suggest [--team] [--any] [--json]`.
- Web: an **Assign** button on a ready step (step panel) and on a goal (goal header), opening a
  ranked picker that assigns with one click.
- `mesh say <machine>/<session> <text>`: through `POST /v1/messages`, which gains a `to` field
  resolved like an assign target.
- Daemon config `maxSessions`: `assignments: launch` never starts a session when that many are
  live; `mesh setup --max-sessions <n>|off`.
- Docs: concepts, how-to, install guide, the mesh skill, the plan API table.

Out:
- An MCP tool for suggest (the skill names the CLI). Suggest in the TUI.
- A weighted numeric score: ranking is the ordered key below, nothing else.
- `maxSessions` for `mesh run`, `mesh accept --launch` or a person starting `claude` by hand: it
  only gates the daemon's own launch for an offer.
- Accepting from the web (unchanged from MM-3).
- New events, a hub schema migration, a store interface change.

## Interface contracts

Names (as in MM-3): **machine name** = nickname, else hostname. **Session name** = `name`, else repo
name, else the first 8 characters of the sid. **Online** = hub `now - lastSeen < 120000` ms (the
existing rule of `/v1/fleet`). **Repo name** of a repo string = the part after its last `/`,
lower-cased. A **visible session** of a machine = a hub session record on it, from `listSessions({live: true})`
with `state !== "ended"` (the one source suggest, `to` on messages and assign all use), for which
`sessionVisible(viewer, {userId, step}, machine.share)` (MM-1) is true: all of the caller's own
sessions; another user's session only when it holds a step or its machine shares `all`.

### Types (src/protocol/hub.ts)

| Interface | Type | Change |
|---|---|---|
| `Suggestion` | interface | New: `{ machine: string; user: string; name: string; to: string; online: boolean; lastSeen: number; repo: boolean; idle: number; session?: string; sessionLabels: string[]; machineLabels: string[]; auto: boolean; reason: string }`. `machine` = machine id; `user` = its owner; `name` = machine name; `to` = what to pass as `--to` (below); `repo` = has every subject repo; `idle` = number of idle candidate sessions; `session` = sid of the best idle session (absent when `idle` is 0; a hint only: on accept the MM-3 daemon picks the session by its own rule, which may choose another); `sessionLabels` = labels of that session that are wanted labels, sorted; `machineLabels` = machine labels that are wanted labels, sorted; `auto` = the accept-policy verdict for an offer from the caller to the machine alone. |
| `SuggestView` | interface | New: `{ target: string; steps: string[]; repos: string[]; topics: string[]; team: boolean; any: boolean; suggestions: Suggestion[] }`. `target` = the step or goal id; `steps` = the offerable step ids, sorted (a step target: `[target]`; a goal: its offerable steps, possibly `[]`); `repos` = the subject repos (strings as stored on the steps, sorted, no repeats); `topics` = the goal's topics; `suggestions` in rank order. |
| `MessageRequest` | zod | Gains `to: z.string().min(1).max(200).optional()`; refine: one of `toSid`, `to`, `toStep` is required (message `toSid, to or toStep is required`). |
| `MessageResult` | interface | New name for the existing reply of `POST /v1/messages`: `{ id: number; toSid: string; to?: string }`. `to` (new) = `<machine name>/<session name>`, present only when the request used `to`; for display only (it need not resolve back as a target). |
| `DaemonConfig.maxSessions` (src/protocol/config.ts) | zod field | New: `z.number().int().min(1).max(1000).optional()`. Absent = no limit. A `daemon.json` without it parses as before. |

### Suggest (hub)

**Subject.**
- Step `S`: `repos` = `[S.repo]` when `S.repo` is not empty, else `[]`; `topics` = topics of `S`'s goal (`[]` when none).
- Goal `G`: the **offerable steps** = steps of `G` with `state === "ready"`, `kind !== "gate"` and no open offer
  (the steps `POST /v1/goals/:id/assign` would offer). `repos` = their distinct non-empty `repo` strings,
  sorted (code-point order); when there are no offerable steps: `[G.primaryRepo]` if it has one, else `[]`.
  `topics` = `G.topics` (`[]` when none).
- **Wanted labels** `W` = `topics` ∪ {repo name of each of `repos`}.

**Candidate machines.** The caller's machines (all of them, online or not); with `team=1`, every
machine in the hub. For each machine `M`:
- `repo`: `true` when `repos` is empty; else every `r` in `repos` is matched (`repoMatches(x, r)`,
  `src/core/repo-id.ts`) by an entry `x` of `M`'s repo inventory or by the `repo` of a visible session on `M`.
- **Idle candidate sessions**: visible sessions on `M` with `state === "idle"`, no `step`, not
  `launching`, and (when `repos` is not empty) a `repo` matched by one of `repos`. `idle` = their count.
  The **best** one: most labels in `W`; ties: larger `lastEventAt`, then smaller sid (code-point order).
- `auto` = `acceptMatches(M.accept, {byUser: caller, byMachine: the token's machine (absent for a token or cookie without one)}, {userId: M.userId})` (MM-3 `src/core/offers.ts`). No session override is used (the suggestion names the machine only).
- `to`: the caller's machine → its nickname, else its id. Another user's machine → `<user>/<nickname>`
  when it has a nickname and the caller has no machine whose nickname is `<user>`; else its id.
  Passing `to` to `POST /v1/steps/:id/assign` (or the goal route) resolves to `M` (MM-3 target resolution).

**Filter.** Without `any=1`, machines with `repo === false` are left out. Nothing else is left out
(offline machines and `["off"]` policies stay, ranked low).

**Rank** (the only order; earlier keys win): `auto` (true first); `repo` (true first);
`sessionLabels.length` (more first); `machineLabels.length` (more first); `online` (true first);
`idle` (more first); `lastSeen` (newer first); `machine` id (code-point order, smaller first).

**Reason**: these parts in this order, joined with ` · `:
1. `@<user>` — only when the machine is not the caller's;
2. `auto-accept` when `auto`, else `waits for them to accept`;
3. `online`, else `last seen <age(now - lastSeen)> ago` (`age` from `src/core/fleet.ts`);
4. when `repos` is not empty: `has <repo names of repos, joined ",">` when `repo`, else `no <repo names of the unmatched repos, joined ",">`;
5. `no idle session` (0), `1 idle session` (1), `<n> idle sessions` (n > 1);
6. when `sessionLabels` is not empty: `<session name of the best session> labelled <sessionLabels joined ",">`;
7. when `machineLabels` is not empty: `machine labels <machineLabels joined ",">`.

Example: `auto-accept · online · has alpha · 1 idle session · perf-bench labelled perf · machine labels perf`.

### Hub HTTP API (src/hub/app.ts, listed in `HUB_API` in src/protocol/hub-api.ts)

New routes: rule `member`, no service scope (a service token gets 403, as the assign routes),
query `{ team: "1: also everyone's machines", any: "1: also machines without the repo" }`. Read-only:
no event, no state change. Any other value than `1` for `team`/`any` means off.

| Route | Behaviour |
|---|---|
| `GET /v1/steps/:id/suggest` (tag `steps`) | 404 `no step <id>`; gate → 409 `<id> is a gate: a person decides it`; not `ready` → 409 `<id> is <state>, not ready`. A step with an open offer is answered (read-only). 200 `SuggestView`. |
| `GET /v1/goals/:id/suggest` (tag `goals`) | 404 `no goal <id>`; goal `done` or `dropped` → 409 `<id> is <state>`. 200 `SuggestView`. |
| `POST /v1/messages` (`MessageRequest`) | When `toSid` is given: unchanged (`to` and `toStep` ignored). Else when `to` is given: resolved as an MM-3 assign target (`<machine>/<session>`, `<user>/<nickname>/<session>`; same errors: 404 `no machine <ref>`, 404 `no session <ref> on <machine name>`, 409 `"<ref>" matches several sessions on <machine name>`; only visible sessions match); a `to` that resolves to a machine without a session → 400 `say needs a session: <machine>/<session>`. The message is queued to that session exactly as with `toSid` (kind `say`, event `message.sent`). 201 `MessageResult` with `to`. Else `toStep`: unchanged. Neither → 400 (zod). |

### Daemon (src/daemon)

| Interface | Behaviour |
|---|---|
| `maxSessions` and launch | Under `assignments: "launch"`, before an offer would call `deps.launchStep`: when `maxSessions` is set and the **live count** ≥ `maxSessions`, `launchStep` is not called; the daemon logs `not starting a session for offered step <step>: <n> live sessions, maxSessions <max>` and handles the offer as listed (MM-3 (3): the notification when notifications are on, ack `delivered` method `listed`). Live count = the daemon's sessions with `state !== "ended"` (any agent, any kind, `launching` included) + launches this daemon started for an offer and not yet seen as a session holding that step, each counted for at most 120 000 ms of the daemon clock after its `launchStep` call. A `launchStep` that answered `{ok: false}` is not counted. Absent `maxSessions`: as MM-3. Offers handled concurrently in one pull respect the limit together (never more launches than free places). |
| `mesh setup --max-sessions <n>\|off` (src/cli/mesh-commands.ts) | `<n>` an integer 1–1000 → writes `maxSessions: n`, prints `An offer starts a session only while fewer than <n> are live. Restart the daemon to apply.`; `off` → removes the field, prints `An offer may start a session however many are live. Restart the daemon to apply.`; any other value (or none) → stderr `--max-sessions must be a whole number from 1 to 1000, or off`, exit 2. Without the flag the field is unchanged. |

No new `/local` route and no new `DaemonClient` method.

### CLI

| Command | Behaviour |
|---|---|
| `mesh assign <goal\|step> --suggest [--team] [--any] [--json]` | Target with `.` → `GET /v1/steps/:id/suggest`, else `GET /v1/goals/:id/suggest`, with `?team=1` / `any=1` only for the flags given. stdout: first line `Suggestions for <target> (best first):`, then per suggestion `` `${i + 1}. ${s.to} · ${s.reason}` `` (i from 0, rank order), then `Assign with: mesh assign <target> --to <to of the first>`, with ` --stick` appended when `steps` is empty (a goal with no step ready now; MM-3 refuses a goal assign without `--stick` then). No suggestion: the single line `No machine to suggest for <target>; try --team or --any.` `--json`: the `SuggestView` as `JSON.stringify(view, null, 2)`. Exit 0. Hub error (status ≥ 400): its text on stderr, exit 1. A reply with status < 400 whose JSON has no `suggestions` array (an older hub answers an unknown GET with 200 HTML or text) → stderr `the hub does not offer suggestions (it needs v0.1.12 or later)`, exit 1, nothing on stdout. |
| `mesh assign` usage | `--suggest` together with `--to`, `--stick` or `--note`; `--team`, `--any` or `--json` without `--suggest`; neither `--to` nor `--suggest`; no target → stderr = `usage: mesh assign <goal\|step> --to <machine>[/<session>] [--stick] [--note "…"]` + `\n       mesh assign <goal\|step> --suggest [--team] [--any] [--json]`, exit 2 (the MM-3 first line is unchanged). The MM-3 `--to` behaviour is unchanged. |
| `mesh say <target> <text…>` | `<target>` without `/`: unchanged (local daemon, `DaemonClient.say` → `{message, sid}`). With `/`: `POST /v1/messages {to: <target>, text: <words joined " ">}` with the hub credentials (`HubClient.post<MessageResult>`); stdout `Sent to <reply to>; mesh delivers it as soon as the session can take it.`, exit 0. Hub error: its text on stderr, exit 1; not logged in: the `HubClient.from` error text on stderr, exit 1. Missing target or text: `usage: mesh say <session> <text>\n       mesh say <machine>/<session> <text>` on stderr, exit 2. |
| `mesh help` | `say` summary: `send a message to a session: mesh say <session> <text>, or <machine>/<session> for another machine`. `assign` summary mentions `--suggest`. |

### Web (web/src)

| Interface | Change |
|---|---|
| `api` (web/src/api.ts) | New: `suggestStep(id: string, o: {team?: boolean; any?: boolean}): Promise<SuggestView>`, `suggestGoal(id, o): Promise<SuggestView>`, `assignStep(id: string, to: string): Promise<AssignResult>`, `assignGoal(id: string, to: string): Promise<GoalAssignResult>` (bodies `{to}`; no `sid`, no `stick`). |
| Step panel (goals.tsx, `aria-label="step details"`) | A button with accessible name `Assign step` (text `Assign`) when the step is `ready`, not a gate, and its offer is not open (`detail.offers[id]?.state !== "offered"`). |
| Goal header (goals.tsx) | A button with accessible name `Assign goal` (text `Assign`) when the goal is not `done`/`dropped` and has at least one offerable step (ready, not a gate, offer not open). |
| Picker | Either button opens one element with `aria-label="assign picker"` containing: checkboxes labelled `Team machines` (`team`) and `Without the repo` (`any`), both off at open, each change refetches; one `li.suggestion` per suggestion in rank order with attribute `data-machine="<machine id>"`, containing `strong.to` (text `to`), `span.reason` (text `reason`) and a button with accessible name `Assign to <to>`; none: `p.empty` text `No machine to suggest.`; a `Cancel` button closes it. Clicking `Assign to <to>` posts the assign; on success the picker closes and `p.assigned` shows `assignText(kind, target, to, result, false).join(" ")` (MM-3 `src/core/offers.ts`); the page then reloads (the step panel shows the MM-3 `p.offer` within the usual SSE refresh); on error `p.error` with the hub's text and the picker stays open. |

### Client methods and return shapes (for tests)

| Method | Returns |
|---|---|
| World `w.api(p, method, path, body?)` / `w.call(token, method, path, body?)` (test/helpers/world.ts, existing) | `{ status: number; json: any }`; `json` for 200 suggest = `SuggestView`, for 201 messages = `MessageResult`, for errors `{ error: string, details?: string[] }`. |
| `HubClient.get<T>(path)` / `post<T>(path, body)` (src/cli/hub-client.ts, existing) | the reply JSON as `T` (`SuggestView`, `MessageResult`); a status ≥ 400 throws `HubCallError` with the hub's `error` text. |
| `DaemonClient.say(target, text)` (existing) | `{ message: Message; sid: string }` (unchanged). |
| web `api.*` | as listed in the Web table. |

The test side may extend `World.restart` to pass `maxSessions` (as MM-3 added `accept`/`assignments`);
a machine's repo inventory comes from `workspaceRoots` (MM-1) or from a direct `POST /v1/sync` with
`machine.repos` on that machine's token.

### Docs

| File | Change |
|---|---|
| `docs/guide/concepts.md` | In "Offers and accept policy": **Suggest** (what is ranked, the rank order, `--team` shows others' idle sessions only when visible, `--any`; that with `--team` any member learns whether a teammate's machine has a given repo and which of its machine labels match, never its inventory list); `maxSessions` under **Assignments**. |
| `docs/guide/howto.md` | "Hand work to another machine": `mesh assign <G> --suggest [--team] [--any]` with a sample output, the web **Assign** button, `mesh say <machine>/<session> "…"`. |
| `docs/guide/install.md` | `daemon.json` field `maxSessions`; `mesh setup --max-sessions`. |
| `src/protocol/skill.ts` `MESH_SKILL` and generated `skills/mesh/SKILL.md` | Rows for `mesh assign <goal\|step> --suggest` and `mesh say <machine>/<session> "<text>"`. |
| `docs/plan/implementation-plan.md` §5.6 | Rows `GET /v1/steps/:id/suggest`, `GET /v1/goals/:id/suggest` (v0.1.12); the `POST /v1/messages` row mentions `to`. |

### Compatibility

- `daemon.json` without `maxSessions` behaves as v0.1.11.
- `POST /v1/messages` with `toSid` or `toStep` answers exactly as before (the new `to` key is absent).
- A v0.1.11 hub answers a suggest GET with its catch-all 200 (web `index.html` or plain text), not
  404. The CLI detects the missing `suggestions` array and prints
  `the hub does not offer suggestions (it needs v0.1.12 or later)`, exit 1 (CLI row above).
- `mesh say <machine>/<session>` against a v0.1.11 hub gets its 400 (`toSid or toStep is required`);
  the CLI prints that text and exits 1.
- `mesh say` with a `/` in the target now always goes to the hub (before, a local session whose
  folder ended in that path matched).

## Acceptance criteria

Surfaces: World tests (`test/helpers/world.ts`; a new `test/suggest.test.ts`); CLI tests
(`test/assign.test.ts` `cli` style, against a World hub); daemon via World (fake `launchStep`);
`test/schemas.test.ts`; Playwright (`pnpm test:web`, needs `pnpm build` first; not in `pnpm check`).
Tests find suggestions by `machine` id, steps by step id, messages by `kind` + `toSid` + text, and
never by hostname, list position or an order this spec does not state. Order is asserted only where
the Rank key decides it. No test asserts `package.json`'s version.

| Id | Criterion | Surface | What exact state makes it FAIL? |
|---|---|---|---|
| AC-01 | Step suggest, filter: alice has machines A (inventory has the step's repo), B (no repo, no session in it), C (no inventory but a visible session in the repo). `GET /v1/steps/<S>/suggest` lists A and C, not B; with `any=1` lists all three, B with `repo: false`. Bob's machines appear only with `team=1`. `steps` (`[<S>]`), `repos`, `topics`, `team`, `any`, `target` are as defined. | World | A machine wrongly in or out, or a `SuggestView` field differs. |
| AC-02 | Rank key position: for each key k in order (`auto`, `repo` (with `any=1`), `sessionLabels.length`, `machineLabels.length`, `online`, `idle`, `lastSeen`, machine id) one pair of machines where the expected winner is better on k, equal on every earlier key, and **worse on every later key it can be worse on** (e.g. `auto`: auto, no repo, no labels, offline, 0 idle, older, larger id against not auto with all of those better; `online`: online with 0 idle sessions and the larger id against offline with 2 idle sessions and the smaller id; `lastSeen` is necessarily newer for the online one). Assert the winner comes first in each pair. | World (clock) | Any pair in the other order (e.g. two keys swapped or a key left out). |
| AC-03 | Fields: `idle` counts only idle, step-less, non-launching visible sessions in a subject repo; `session` is the best one (more wanted labels, then newer `lastEventAt`, then smaller sid) and absent when `idle` is 0; `sessionLabels`/`machineLabels` are the sorted intersections with `W` (a label equal to the step's repo name counts); `online` follows the 120 s rule; `auto` is `true` for alice→her own machine with `["self"]` and `false` for bob→alice's machine with `["self"]`, `true` with `["user:bob"]`, `false` with `["off"]` or no reported policy. | World | Any field differs. |
| AC-04 | Privacy with `team=1`: bob's idle step-less session on a machine sharing `me` is not counted in `idle` nor named in `session`/`reason` for alice; under `all` it is. Alice's own `me` sessions are always counted for her. | World | Another user's hidden session counted or named. |
| AC-05 | `to`: alice's nicknamed machine → nickname; un-nicknamed → id; bob's nicknamed machine (team) → `bob/<nickname>`; un-nicknamed → id. For each suggestion, `POST /v1/steps/<S>/assign {to}` targets that `machine` (`step.offer.to.machine`). | World | Wrong `to`, or an assign to another machine. |
| AC-06 | Reason text exactly as specified, for: own online machine with `auto`, repo, one idle labelled session and a machine label; another user's offline machine (`@bob · waits for them to accept · last seen 5m ago · …`); `any=1` machine (`no <name>`); 0 and 3 idle sessions; a step with an empty repo (no repo part). | World (clock) | Any character differs. |
| AC-07 | Goal suggest: `steps` lists exactly the offerable step ids; subject repos are the distinct repos of the goal's offerable steps (a gate, an offered step and a non-ready step add none); a goal without offerable steps uses `primaryRepo`; `repo` is true only when all repos are matched; a done goal → 409 `<G> is done`; unknown → 404 `no goal <G>`. | World | Wrong `repos`, `repo`, status or text. |
| AC-08 | Step suggest errors: unknown 404 `no step <id>`; gate 409 `<id> is a gate: a person decides it`; blocked/claimed 409 `<id> is <state>, not ready`; a service token 403. A step with an open offer still answers 200. Suggest emits no event and changes no step (events after = events before). | World | Other status/text, an event, or a changed step. |
| AC-09 | CLI `mesh assign <S> --suggest`: stdout has the heading, numbered `<to> · <reason>` lines in the hub's order and `Assign with: mesh assign <S> --to <first to>`; a goal with no offerable step prints that line with ` --stick` appended; `--team`/`--any` reach the hub as query flags (the result changes as in AC-01); `--json` prints the `SuggestView`; no candidate → `No machine to suggest for <S>; try --team or --any.`; exit 0. A goal target uses the goal route. Hub 404 → its text, exit 1. A hub stub answering the suggest GET with 200 and a non-JSON body (or JSON without `suggestions`) → stderr `the hub does not offer suggestions (it needs v0.1.12 or later)`, exit 1, empty stdout. | CLI (World hub; a stub HTTP server for the old-hub case) | Other text, order, route or exit code. |
| AC-10 | CLI usage: `--suggest --to m2`, `--suggest --stick`, `--suggest --note x`, `--team` without `--suggest`, `--any` without `--suggest`, `--json` without `--suggest`, a target with neither `--to` nor `--suggest`, and no target each exit 2 with stderr equal to the two-line usage (first line exactly the MM-3 one); no hub call is made. MM-3 `mesh assign --to` tests stay green. | CLI | Exit ≠ 2, other text, or a hub request. |
| AC-11 | `POST /v1/messages {to: "<machine>/<session>", text}`: alice → her own machine's session by name, by sid prefix ≥ 4, and bob's visible session via `bob/<nick>/<session>` → 201 `{id, toSid, to: "<machine name>/<session name>"}`, an inbox row on that machine with that `toSid`, kind `say`, the text, and event `message.sent`; the target daemon pastes it (World `pastes`). Errors: `no machine x` 404; `no session x on <name>` 404 (also for bob's hidden `me` session); ambiguous 409; `to` naming only a machine → 400 `say needs a session: <machine>/<session>`. With `toSid` or `toStep` the reply has no `to` and behaviour is as before. | World | Wrong status, text, row, missing paste, or `to` present for `toSid`. |
| AC-12 | CLI `mesh say m2/perf hello there` → stdout `Sent to m2/perf; mesh delivers it as soon as the session can take it.`, exit 0, and the hub has the message; an unknown machine → stderr `no machine …`, exit 1; not logged in → exit 1 with the `HubClient.from` text; `mesh say perf hello` (no `/`) still goes to the local daemon with its existing output (`Delivered.` or `Queued; mesh delivers it as soon as the session can take it.`); `mesh say` alone → the two-line usage, exit 2. | CLI (World hub) | Other text, route or exit code. |
| AC-13 | `maxSessions`: under `assignments: launch` with `maxSessions: 2` and two live sessions (none idle in the repo), an auto offer does not call `launchStep`; the ack is `delivered`/`listed`; with notifications on (`notifyChannels(config).any`) the person gets the MM-3 notification. With one live session, two auto offers in one inbox pull give exactly one `launchStep` call and one `listed` ack. Pending launch expiry: after that launch, with the launched session never appearing, a new auto offer before 120 s (daemon clock) does not call `launchStep` and is acked `listed`; a new auto offer after 120 s **calls** `launchStep` (exactly one more call). No double count: `maxSessions: 3`, one live session, an offer launches; the launched session then appears holding that step (World `hook(p, "SessionStart", pid, {}, {step})`, then wait for the bind); a new auto offer **calls** `launchStep` (2 live, not 3). A `launchStep` answering `{ok: false}` does not use a place (the next offer calls `launchStep`). Without `maxSessions` three offers give three launches. | World (fake `launchStep`, clock) | A launch over the limit, a missing launch under it or after expiry, a double-counted launch, or a wrong ack. |
| AC-14 | `DaemonConfig.parse` of an MM-3 `daemon.json` has no `maxSessions`; `0`, `1001`, `2.5` are rejected. `mesh setup --max-sessions 3` writes `maxSessions: 3` and prints its line; `--max-sessions off` removes the key and prints its line; `--max-sessions x` exits 2 with `--max-sessions must be a whole number from 1 to 1000, or off`; a setup without the flag keeps the field. | unit + CLI | Wrong file content, text or exit. |
| AC-15 | Web step, signed in as bob: on a goal page with a ready step in repo `alpha` and bob's machine (inventory `alpha`, nickname), clicking `Assign step` shows `assign picker` with an `li.suggestion[data-machine=<id>]` whose `strong.to` and `span.reason` equal the hub's suggestion; `Assign to <to>` closes the picker, shows `p.assigned` `Offered <step> to <to> (…)` and, within 20 s, the step panel's `p.offer`; the hub has `offer.state "offered"` to that machine; the `Assign step` button is gone for that step. Checking `Team machines` adds a teammate's (alice's) machine with `alpha` in its inventory (by `data-machine`). The e2e hub is shared across spec files: rows are found only by `data-machine`, never counted. | Playwright (`test/e2e-web`) | Button, picker, row, text, or the offer missing. |
| AC-16 | Web goal: `Assign goal` in the header of a goal with an offerable step opens the picker from the goal route; `Assign to <to>` offers the goal's offerable steps (hub check by step id); a goal without one shows no `Assign goal`; a step that is a gate or not ready shows no `Assign step`; an empty suggestion list shows `No machine to suggest.`; `Cancel` closes the picker. | Playwright | Wrong button visibility, wrong route, or text. |
| AC-17 | `schemas/hub-api.openapi.json` matches `pnpm schemas` and lists the two suggest routes with the `team`/`any` query and the `to` field of `MessageRequest`; `HUB_API` matches `src/hub/app.ts` (rule `member`, no scope). | `test/schemas.test.ts` | Stale or missing entry. |
| AC-18 | Docs: concepts, how-to and install guide cover the Docs table; plan §5.6 lists the two routes (v0.1.12) and `to` on messages; `MESH_SKILL` has the `--suggest` and `mesh say <machine>/<session>` rows and equals `skills/mesh/SKILL.md`. | review + existing skill test | A missing item or skill mismatch. |
| AC-19 | `pnpm check` (lint, typecheck, boundaries, test, build) and `pnpm test:web` (after `pnpm build`) pass; `package.json` is 0.1.12 (review only). | `pnpm check`, `pnpm test:web`, review | Any check fails. |

## Open questions
- (2026-11-11) The design names only `GET /v1/steps/:id/suggest`; `mesh assign <goal> --suggest` and
  the web goal button need a goal subject, so `GET /v1/goals/:id/suggest` was added. Its subject is the
  steps a goal assign would offer (their repos together), else the goal's primary repo.
- (2026-11-11) The design lists factors, not weights. Assumed a strict ordered key in the listed
  order with auto first: auto, repo, session labels, machine labels, online, idle sessions, then
  last seen and id. An offline machine with matching labels therefore ranks above an online one
  without; revisit if that reads wrong in use.
- (2026-11-11) "Label overlap with the goal topics and step repo" read as: a label counts when it
  is a goal topic or the step's repo name. Session overlap uses the best idle session in the repo only.
- (2026-11-11) A suggestion names a machine, never a session (the daemon picks the session when it
  accepts, MM-3); `auto` is therefore the machine policy's verdict, not a session override.
- (2026-11-11) The design says "the CLI resolves the name" for `mesh say <machine>/<session>`. Chose
  to send the name to the hub (`to` on `POST /v1/messages`), which resolves it with the MM-3 assign
  rules and visibility checks: another user's machine and session are only known to the hub, and one
  rule set avoids two diverging resolvers. The design's "existing /v1/messages" still holds.
- (2026-11-11) A `mesh say` target with `/` always goes to the hub; a session the hub does not know
  (under `shareSessions: steps`, an idle session) answers 404, as an assign target does.
- (2026-11-11) `maxSessions` has no default (absent = no limit, as v0.1.11). It gates only the
  daemon's launch for an offer; `mesh accept --launch` and `mesh run` are a person's explicit choice.
  The live count includes all non-ended sessions of the machine (also ones without mesh steps).
- (2026-11-11) No MCP suggest tool: the design names CLI and HTTP only.
- (2026-11-11) The web assign sends no `stick` and no `note` (the picker is a quick hand-off; the CLI
  has both).
- (2026-11-11, round 1) An older hub answers an unknown GET with its catch-all 200, so the CLI checks
  for a `suggestions` array instead of relying on 404. Making the hub answer 404 JSON for unknown
  `/v1/*` paths was not chosen (wider change, affects every route); revisit separately.
- (2026-11-11, round 1) `Suggestion.session` scores by `W` (topics and repo names) while the MM-3
  daemon picks by topics only; kept as a hint rather than changing either rule.
- (2026-11-11, round 1) `SuggestView.steps` was added so the CLI can tell a goal with no step ready
  now and print `--stick` in its hint.
