# Spec MM-2: Labels: what a session or machine is for

## Status
Draft (revision 1)

Source: `docs/analysis/2026-11-11-my-mesh-and-assign.md`, section "MM-2: Labels". Builds on MM-1
(`docs/specs/MM-1.md`, v0.1.9). Release v0.1.10.

## Problem

MM-1 shows every machine logged in as me and what each session on it is doing, but not what a
session or a machine is *for*. Nothing says "this session works on performance" or "this machine
has the GPU". MM-3 (assign) and MM-4 (suggest) need that to pick a session or machine for a step,
and a person needs it to find the right session among many. Goals already carry topics
(`mesh topic`); labels reuse the topic names.

## Scope

In:
- `Session.labels` (at most 10, topic-name syntax), from three sources: the repo default
  (`.mesh/agent.yaml`), `mesh run --label`, and `mesh label <session>` / TUI key `L`. Labels set by
  the last two are remembered per checkout in the daemon store, so a new session there gets them.
- Session labels travel with the session record to the hub (full records and `sessionMetadata`),
  and show in `/v1/live` sessions, `/v1/fleet` sessions, `mesh machines`, `mesh_fleet`, the TUI and
  the web Mine tab.
- Machine labels: `mesh machine label`, stored on the hub machine row (no schema migration), shown
  in `/v1/fleet`, `mesh machines`, the web Mine tab.
- A label that is not a defined topic is accepted, with the warning
  `not a topic: <label>; mesh topic add <label>`.
- `mesh machines --label a,b` filters.
- Docs: install guide, concepts, how-to, the mesh skill, the plan API table, the events list.

Out:
- Labelling a session on another machine (no write to another machine's sessions; MM-3 territory).
- Using labels to pick or rank anything (MM-3, MM-4).
- Labels on the web Live page (only the `/v1/live` API carries them), a label filter on the web.
- An MCP tool to set labels; labels in `mesh ls` / `mesh show`.
- Sending machine labels from the daemon with sync (see Open questions).

## Interface contracts

### Types (src/protocol)

| Interface | Type | Change |
|---|---|---|
| `LABEL_RULE` (src/protocol/session.ts) | const string | New: `"a label is 1-40 characters: lowercase letters, digits, '.', '_' or '-', starting with a letter or digit"`. |
| `MAX_LABELS` (src/protocol/session.ts) | const | New: `10`. |
| `Label` (src/protocol/session.ts) | zod schema | New: `z.string().regex(/^[a-z0-9][a-z0-9._-]{0,39}$/, LABEL_RULE)` (the topic-name syntax). |
| `parseLabels(input: string \| readonly string[]): { labels: string[] } \| { error: string }` (src/protocol/session.ts) | function | New. A string is split on `,`. Each item is trimmed and lowercased; empty items are dropped; repeats removed; result sorted (code-point order). An item that is then not a `Label`: `{ error: "not a label: <item as trimmed> (<LABEL_RULE>)" }` (the first such item). More than `MAX_LABELS` distinct labels: `{ error: "at most 10 labels" }`. `all` is an ordinary label. `""` gives `{ labels: [] }`. |
| `Session.labels` (src/protocol/session.ts) | zod field | New: `z.array(Label).max(10).optional()`. Absent when the session has no labels (never `[]`). |
| `LiveSession` (src/protocol/hub.ts) | interface | Gains `labels?: string[]`: the session's labels, key absent when it has none. `FleetSession` inherits it. |
| `FleetMachine` (src/protocol/hub.ts) | interface | Gains `labels: string[]`: the machine's labels, sorted; `[]` when none. |
| `MachineLabels` (src/protocol/hub.ts) | zod schema | New body of `POST /v1/machines/:id/labels`: either `{ labels: string[] }` (replace; max 20 items before normalising) or `{ add?: string[]; remove?: string[] }` (each max 20; at least one item in total, else 400). Items are strings of at most 40 characters; the hub normalises them with `parseLabels`. |
| `MachineLabelsView` (src/protocol/hub.ts) | interface | New: `{ id: string; hostname: string; nickname?: string; labels: string[]; unknown: string[] }`. `unknown`: those of `labels` that are not a defined topic (`GET /v1/topics` names), sorted. |
| `LabelsResult` (src/protocol/session.ts) | interface | New reply of `POST /local/labels`: `{ session: Session; unknown?: string[] }` for a target, `{ cwd: string; labels: string[]; unknown?: string[] }` for a cwd. `unknown` as above; key absent when the daemon could not ask a hub (not logged in, offline, error). |

A v0.1.9 hub receiving a `Session` with `labels` drops the key (zod strips unknown keys): no error.

### Repo default file

`.mesh/agent.yaml` at the top of a checkout (the nearest folder at or above the session's cwd that
has a `.git` folder or file). YAML; only the key `labels` is read: a list of strings, normalised with
`parseLabels`. Other keys are ignored. A missing file, invalid YAML, `labels` not a list of strings,
or a `parseLabels` error: no repo default (the daemon logs one line naming the file and the reason;
the session is recorded as usual).

### Which labels a session gets (daemon)

When the daemon records a session for the first time (a hook from a new session, an OpenCode event,
or a `mesh run` placeholder via `POST /local/launch`), its `labels` are:
1. the labels remembered for its checkout (set by `mesh run --label` or `mesh label`), if any are
   remembered, even an empty list (then: no labels);
2. else the repo default from `.mesh/agent.yaml`;
3. else none.

A remembered list replaces the repo default; it is not merged with it (`--add` merges on purpose).
A placeholder adopted by its first hook keeps its labels. Sessions recorded before this release, and
sessions already recorded when a remembered list or the file changes, keep their labels.
The **checkout key** of a cwd: the checkout top (as above), else the cwd itself, both as absolute
paths. Two worktrees of one repo are two checkouts.

### Daemon store (src/store/daemon-store.ts)

| Interface | Change |
|---|---|
| `checkoutLabels(key: string): string[] \| undefined` | New. The list remembered for a checkout key; `undefined` when none was ever remembered; `[]` when an empty list was. |
| `setCheckoutLabels(key: string, labels: readonly string[]): void` | New. Remembers (replaces) the list. Survives a daemon restart (same store file). No schema change needed (the `kv` table may hold it). |

### Daemon local API (src/daemon/daemon.ts) and client (src/cli/client.ts)

| Route / method | Behaviour |
|---|---|
| `POST /local/labels {target: string, labels: string[], mode: "set"\|"add"\|"rm"}` | Finds the live session with `findSession(target)`; none: 404 `{error: "no live session matches \"<target>\""}`. `labels` normalised with `parseLabels`; error: 400 `{error}` with its text. New list: `set` = labels; `add` = current ∪ labels; `rm` = current − labels; sorted; more than 10: 400 `{error: "at most 10 labels"}` and nothing changes. Stores it on the session (empty list: `labels` key removed), remembers it for the session's checkout key, and replies 200 `LabelsResult` `{session, unknown?}`. Other live sessions are not changed. |
| `POST /local/labels {cwd: string, labels: string[]}` | Normalised as above (400 on error). Remembers the list for the checkout key of `cwd` (no session changes). 200 `{cwd: <checkout key>, labels, unknown?}`. |
| Neither `target` nor `cwd`, or `target` without a valid `mode` | 400 `{error: "expected {target, labels, mode: set|add|rm} or {cwd, labels}"}`. |
| `DaemonClient.labels(target: string, labels: string[], mode: "set"\|"add"\|"rm"): Promise<{session: Session; unknown?: string[]}>` | New. |
| `DaemonClient.rememberLabels(cwd: string, labels: string[]): Promise<{cwd: string; labels: string[]; unknown?: string[]}>` | New. |

`unknown` is computed by the daemon from the hub's `GET /v1/topics` (team or Solo hub) at the time
of the call.

### Sync (src/daemon/hub-link.ts)

| Interface | Change |
|---|---|
| `sessionMetadata(s)` | Also copies `labels` when present. Still no `cwd` text, `pane`, `pid`, `transcriptPath`, `lastMessage`. |
| Sync body | Unchanged otherwise: step holders' full records carry `labels`; no-step sessions under `me`/`all` carry them through `sessionMetadata`; under `steps` no-step sessions are not sent. The next sync after a label change carries the new list. |

### Hub store (src/store/hub-store.ts)

| Interface | Change |
|---|---|
| `HubStore.SCHEMA_VERSION` | Stays 6 (no new migration). |
| `MachineRow` | Gains `labels?: string[]`, absent when none (a row without labels still compares equal, with `toStrictEqual`, to the MM-1 shape). |
| `setMachineLabels(id: string, labels: readonly string[]): Promise<void>` | New. Replaces the machine's labels; `[]` removes them (key absent afterwards). Keeps `repos`/`reposAt`, `share`, `nickname`. Unknown id: no-op. |
| `touchMachine(..., facts)` | A sync that replaces the repo inventory keeps the labels. |

### Hub HTTP API (src/hub/app.ts, listed in `HUB_API` in src/protocol/hub-api.ts)

| Route | Rule | Behaviour |
|---|---|---|
| `POST /v1/machines/:id/labels` | member (no service scope), tag `daemon` | Body `MachineLabels`. Every item normalised with `parseLabels`; error: 400 `{error}` with its text. New list: `{labels}` replaces; `{add, remove}` = current ∪ add − remove; sorted. More than 10: 400 `{error: "at most 10 labels"}`. 404 `{error: "no machine <id>"}`; 403 `{error: "not your machine"}` for another user's machine (admins too). 200 `MachineLabelsView`. Concurrent changes of one machine are applied one after another (two concurrent `add` calls both land). When the list changed, event `machine.labelled` (user = caller, payload `{machine: <id>, labels: string[]}`), which sends the SSE `changed` hint; its `/v1/live` activity text: `labelled machine <hostname> <a, b>` (labels joined by `, `), or `cleared the labels of machine <hostname>` for an empty list. No change: no event. |
| `GET /v1/live` | unchanged rule | Each listed session carries `labels` when it has any. Visibility unchanged (MM-1). |
| `GET /v1/fleet` | unchanged rule | Sessions carry `labels` when they have any; each machine carries `labels` (`[]` when none). |
| `POST /v1/sync` | unchanged | Does not touch machine labels (a v0.1.9 or v0.1.10 daemon's sync never changes them). |

`schemas/hub-api.openapi.json` (generated by `pnpm schemas`) lists the new route.

### Rendering (src/core/fleet.ts, exported from `src/core/index.ts`)

`renderFleet` (MM-1) changes only where labels exist; output without labels is byte-for-byte as in MM-1.
```
<title> · <presence> · share <share> · <n> repo|repos[ · [<machine labels>]][ · this machine]
  <repo> · <name> · <state> · <step>[ · [<session labels>]] · <age>
```
`[<labels>]` = the sorted labels joined by `, ` in square brackets, e.g. ` · [gpu, perf-lab]`; left
out when there are none.

```ts
export function filterFleet(view: FleetView, labels: readonly string[]): FleetView
```
New. Empty `labels`: `view` unchanged. Otherwise a machine whose labels include every given label is
kept with all its sessions; any other machine is kept with only its sessions whose labels include
every given label, and dropped when none do. Order, `now`, `user` and `current` unchanged.

### CLI

| Command | Behaviour |
|---|---|
| `mesh label <session> <label,…> [--add\|--rm]` | Labels parsed with `parseLabels` before any call; error: its text on stderr, exit 2. Calls `POST /local/labels` with mode `set` (default), `add` or `rm`. Success: stdout `<who>: labels <a, b>` or `<who>: no labels`, where `<who>` = session name, else repo name, else the first 8 characters of the sid; then, for each label in `unknown`, one stderr line `not a topic: <label>; mesh topic add <label>`; exit 0. Daemon error (404, 400): its `error` text on stderr, exit 1. |
| `mesh label <session> --clear` | Same with mode `set` and `[]`; stdout `<who>: no labels`. |
| `mesh label` misuse (no session, no labels and no `--clear`, labels with `--clear`, both `--add` and `--rm`) | stderr starting with `usage: mesh label <session> <label,…> [--add|--rm]` and containing `mesh label <session> --clear`, exit 2. Listed in `mesh help`. |
| `mesh run <repo…> --label a,b` | Parsed with `parseLabels` before anything else happens (no claim, no tmux, no `claude`); error: its text on stderr, exit 2. When mesh is set up: before starting each session, `POST /local/labels {cwd: <dir>, labels}` for each directory a session starts in (the step worktree when one is used), so the new session gets them; tmux and `--bg` alike. A failing call: stderr `warning: could not record the labels for <dir>: <message>`, the session still starts. Each label in `unknown` (from the first successful reply) gives one stderr line `not a topic: <label>; mesh topic add <label>`. Without `--label` nothing changes. The usage line mentions `--label a,b`. |
| `mesh machine label <label,…> [--add\|--rm] [--machine <id\|nickname\|hostname>]` | Parsed before any hub call; error: its text on stderr, exit 2. Machine chosen as for `mesh machine name` (MM-1: same messages and exit codes). Calls `POST /v1/machines/:id/labels` (`{labels}`, or `{add}` / `{remove}`). Success: stdout `<hostname> (<id>): labels <a, b>` or `<hostname> (<id>): no labels`; then one stderr line per `unknown` label `not a topic: <label>; mesh topic add <label>`; exit 0. Hub error: its `error` text on stderr, exit 1. |
| `mesh machine label --clear [--machine …]` | `{labels: []}`; stdout `<hostname> (<id>): no labels`. |
| `mesh machine` usage | Now also contains `mesh machine label <label,…> [--add|--rm] [--machine <id|nickname|hostname>]` (exit 2 as in MM-1, also for `label` without labels and without `--clear`). |
| `mesh machines [--label a,b] [--json]` (and `mesh fleet`) | `--label` parsed with `parseLabels` (error: stderr text, exit 2). Prints `renderFleet(filterFleet(view, labels))`; `--json` prints the filtered `FleetView`. Nothing matches (and the view had machines): stdout `No machine or session of yours is labelled <a and b>` (labels joined by ` and `) followed by `.`, exit 0. |

### TUI (src/cli/tui)

| Interface | Change |
|---|---|
| Session row (`render`) | A session with labels shows `[<a, b>] ` at the start of its detail text (before `idle`, `working · …`, etc.). |
| Session list footer (`render`) | Contains `L labels`. |
| Key `L` (tui.ts) | On the selected session: opens the input line `labels for <who>: ` prefilled with its labels joined by `, ` (empty when none). Enter: `parseLabels` of the value; error: shown as the status; else `DaemonClient.labels(sid, labels, "set")` (empty value clears) and the status `<who>: labels <a, b>` / `<who>: no labels`, followed by ` · not a topic: <label>; mesh topic add <label>` for each `unknown` label. Esc cancels. Does nothing in the My machines and goals views. |
| `renderMachines` (MM-1) | Shows the labels through `renderFleet` (no other change). |

### Web (web/src/mine.tsx)

| Interface | Change |
|---|---|
| Mine tab | A machine with labels shows them in its title line as `span.labels` (text: labels joined by `, `). The sessions table gains a `labels` column (labels joined by `, `, empty when none) between `step` and `age`. |

### Docs

| File | Change |
|---|---|
| `docs/guide/concepts.md` | "Labels": what a session/machine label is, topic syntax, at most 10, the three sources and their order (remembered list replaces the repo default), per checkout, `.mesh/agent.yaml` format, machine labels on the hub, the `not a topic` warning. |
| `docs/guide/howto.md` | A subsection "Label sessions and machines": `.mesh/agent.yaml`, `mesh run --label`, `mesh label`, TUI `L`, `mesh machine label`, `mesh machines --label`. Example `mesh machines` output in "See all your machines" shows labels. |
| `docs/guide/install.md` "What the hub sees" | Session metadata now includes its labels. |
| `src/protocol/skill.ts` `MESH_SKILL` and generated `skills/mesh/SKILL.md` | Mention labels (`mesh label`, `.mesh/agent.yaml`, `mesh machines --label`). |
| `docs/plan/implementation-plan.md` §5.6 | A row: `POST /v1/machines/:id/labels` — machine labels (v0.1.10). |
| `docs/events.md` | Row `machine.labelled` (a machine's labels changed; payload `machine`, `labels`). |

## Acceptance criteria

Surfaces: unit tests; daemon tests (a real `Daemon` over its local HTTP API with a temp store, as in
`src/daemon/daemon.test.ts`); `HubStore` contract test (`src/store/hub-store.contract.test.ts`, SQLite
always, Postgres when its URL is set); World tests (`test/helpers/world.ts`: real hub + daemons over
HTTP; `test/my-mesh.test.ts` or a new file); CLI tests (`test/cli.test.ts` style); Playwright
(`pnpm test:web`, not part of `pnpm check`). Tests that need `.mesh/agent.yaml` or git checkouts make
them in temp folders.

| Id | Criterion | Surface | What exact state makes it FAIL? |
|---|---|---|---|
| AC-01 | `parseLabels("Perf, gpu,perf")` → `{labels: ["gpu", "perf"]}`; `parseLabels(["b", "a"])` → `["a", "b"]`; `""` and `" , "` → `[]`; `"a b"` → `{error: "not a label: a b (" + LABEL_RULE + ")"}`; `"-x"` → error naming `-x`; 11 distinct valid labels → `{error: "at most 10 labels"}`, 10 → ok; a 40-char label ok, 41 → error. `Session` accepts `labels` of up to 10 valid labels and rejects 11, an invalid one, or an uppercase one. | unit (`src/protocol/*.test.ts`) | Any listed result differs. |
| AC-02 | `sessionMetadata` of a session with `labels: ["perf"]` carries `labels: ["perf"]` and still none of `pid`, `pane`, `transcriptPath`, `lastMessage`, and `cwd` is `""`; without labels the result has no `labels` key. `syncedSessions(all, "me")` carries labels for step holders and no-step sessions. | unit (`src/daemon/hub-link.test.ts`) | Labels dropped, `labels: []`/`undefined` key present, or a private field leaks. |
| AC-03 | Repo default: a new session (hook) whose cwd is a checkout, or a subfolder of one, with `.mesh/agent.yaml` `labels: [Perf, dataplane]` is recorded with `labels: ["dataplane", "perf"]`. With no file, invalid YAML, `labels: "x"`, or `labels: ["bad label"]`, the session is recorded with no `labels` key. | daemon test (`GET /local/sessions`) | Wrong labels, a `labels` key on the failure cases, or the session not recorded. |
| AC-04 | Remembered labels: `POST /local/labels {cwd: <checkout>/sub, labels: ["GPU"]}` answers 200 with `cwd` = the checkout top and `labels: ["gpu"]`; a session recorded afterwards in that checkout (also through `POST /local/launch`) has `labels: ["gpu"]` even though `.mesh/agent.yaml` there says `[perf]`; a session in another worktree of the same repo gets that worktree's own default; a session already live in the checkout keeps its labels; remembering `[]` gives the next new session no labels despite the file; after closing and reopening the daemon on the same store file, a new session in the checkout still gets the remembered list. | daemon test | Any session gets other labels, the worktree inherits, a live session changes, or the memory is lost on restart. |
| AC-05 | `POST /local/labels {target, labels, mode}`: `set ["b","a"]` → session `labels: ["a","b"]`; `add ["c"]` → `["a","b","c"]`; `rm ["a","x"]` → `["b","c"]`; `set []` → no `labels` key; the list is remembered for the session's checkout (a new session there gets it); another live session in the same checkout is unchanged; unknown target → 404 `no live session matches "<t>"`; an add that would make 11 → 400 `at most 10 labels` and labels unchanged; an invalid label → 400 with the `parseLabels` text; a body with neither `target` nor `cwd` → 400 with the documented text. | daemon test | Any list, status or message differs, or a refused call changed something. |
| AC-06 | `unknown`: with a hub where topic `perf` is defined, labelling `[perf, gpu]` replies `unknown: ["gpu"]`; with all labels defined `unknown: []`; without hub credentials (and no Solo hub) the reply has no `unknown` key and the labels are still set. | World or daemon test with a hub | Wrong list, `unknown` present without a hub, or the call fails without a hub. |
| AC-07 | Sync: after `mesh label`/`POST /local/labels` on bob's no-step session on a `me` machine and `w.flush()`, bob's `GET /v1/fleet` and `GET /v1/live` list that session with `labels`; alice's `/v1/live` still does not list it; a step holder's labels are listed in alice's `/v1/live`; a session without labels has no `labels` key in either view; on a `steps` machine no-step sessions (and so their labels) stay off the hub. | World | Labels missing or stale after flush, a hidden session shown, a `labels` key on an unlabelled session, or a `steps` no-step session on the hub. |
| AC-08 | `HubStore.SCHEMA_VERSION` is still 6; `setMachineLabels(id, ["gpu","perf"])` then `getMachine` has `labels: ["gpu","perf"]`; `setMachineLabels(id, [])` leaves a row equal (`toStrictEqual`) to the row before any label (no `labels` key); `setMachineLabels` keeps `repos`, `reposAt`, `share`, `nickname`; a later `touchMachine` with new `repos` keeps `labels`; an unknown id changes nothing. | contract test (SQLite and Postgres) | Version changed, labels lost or not cleared, another field lost, or a row created. |
| AC-09 | `POST /v1/machines/:id/labels`: owner `{labels: ["Perf-Lab","gpu"]}` → 200 `{id, hostname, labels: ["gpu","perf-lab"], unknown: [...]}` (with `nickname` when set); `{add: ["x"]}` and `{remove: ["gpu"]}` edit the list; `{labels: []}` clears; `{}` and `{add: [], remove: []}` → 400; `"bad label"` → 400 with the `parseLabels` text; 11 labels (directly or by `add`) → 400 `at most 10 labels`, list unchanged; unknown id → 404 `no machine <id>`; another user's machine, also as admin → 403 `not your machine`; a `live:read` service token → 403; `unknown` lists exactly the labels that are not defined topics; each change records `machine.labelled` with payload `{machine, labels}` and `/v1/live` activity `labelled machine <hostname> gpu, perf-lab` (after clearing: `cleared the labels of machine <hostname>`); a call that changes nothing records no event; two concurrent `{add: ["a"]}` and `{add: ["b"]}` both land (SQLite and Postgres). | World / hub test | Any status, body, message, event or activity text differs, or a concurrent add is lost. |
| AC-10 | `GET /v1/fleet`: each machine has `labels` (`[]` before any; the stored list after `POST …/labels`); a sync of that machine (also one replacing `repos`, also a body without `machine`) does not change them. | World | `labels` missing, not `[]` by default, or changed by a sync. |
| AC-11 | `renderFleet` gives exactly the documented lines for: a machine with labels `[gpu, perf-lab]` that is `current` (` · [gpu, perf-lab] · this machine`), a session with labels `[perf]` (`… · <step> · [perf] · <age>`); for a view without any labels the output equals the MM-1 output (the MM-1 test cases unchanged). MCP `mesh_fleet` returns the same text as `mesh machines` for a labelled fleet. | unit (`src/core/fleet.test.ts`), World (MCP) | Any character differs, or the MM-1 cases change. |
| AC-12 | `filterFleet`: `[]` returns the view unchanged; `["perf"]` keeps a machine labelled `perf` with all its sessions, keeps another machine with only its `perf` sessions, drops a machine with no match; `["perf","gpu"]` keeps only sessions/machines with both; `now`, `user`, order and `current` are unchanged. | unit (`src/core/fleet.test.ts`) | Any kept/dropped item differs or other fields change. |
| AC-13 | `mesh machines --label perf` prints `renderFleet(filterFleet(view, ["perf"]))`; `--label perf --json` prints the filtered `FleetView`; with no match it prints `No machine or session of yours is labelled perf.` (two labels: `… labelled perf and gpu.`), exit 0; `--label "bad label"` exits 2 with the `parseLabels` text. `mesh fleet` behaves the same. | World / CLI | Unfiltered output, wrong message, or wrong exit code. |
| AC-14 | `mesh label <s> perf,gpu` prints `<who>: labels gpu, perf`, exit 0, and the daemon's session has them; `--add x` / `--rm gpu` edit; `--clear` prints `<who>: no labels`; with a hub where `perf` is a topic and `gpu` is not, stderr has exactly one line `not a topic: gpu; mesh topic add gpu`; `mesh label <s> "bad label"` exits 2 without a daemon call; `mesh label nope a` exits 1 with `no live session matches "nope"`; `mesh label`, `mesh label <s>`, `mesh label <s> a --clear`, `mesh label <s> a --add --rm` exit 2 with the usage; `mesh help` lists `label`. | CLI (daemon + hub in the test) | Other text, exit code, or labels. |
| AC-15 | `mesh run <repo> --label perf` records `perf` for the repo's checkout before starting (the placeholder from `POST /local/launch` and the session from its first hook have `labels: ["perf"]`); with `--step S --worktree` the worktree's checkout gets it, not the main checkout; `--bg` also records it; `--label "bad label"` exits 2 before any claim, tmux or agent process (fake runner sees no call); a daemon call failure prints `warning: could not record the labels for <dir>: …` and the session still starts; an undefined topic prints `not a topic: perf; mesh topic add perf` once. | CLI with a fake runner and a test daemon (`test/cli.test.ts` / `test/m45-cli.test.ts` style) | Labels missing or on the wrong checkout, any process started on a parse error, no warning, or the start aborted. |
| AC-16 | `mesh machine label gpu,perf-lab` labels this installation's machine (stdout `<hostname> (<id>): labels gpu, perf-lab`); `--add`, `--rm`, `--clear` (stdout `… : no labels`); `--machine <nickname of my other machine>` labels that one; `--machine nope` exits 1 with the MM-1 message; `"bad label"` exits 2 without a hub call; a hub 400 (11 labels) exits 1 with `at most 10 labels`; an undefined topic prints `not a topic: <l>; mesh topic add <l>`; `mesh machine label` without labels and without `--clear` exits 2 with a usage containing `mesh machine label`. | World / CLI | Wrong machine, other text or exit code. |
| AC-17 | TUI `render`: a session with labels `["gpu","perf"]` has a row containing `[gpu, perf] ` before its detail text (width 120); the session list footer contains `L labels`; rows of sessions without labels are unchanged from v0.1.9 (existing snapshots). | unit (`src/cli/tui/render.test.ts`) | Labels missing, footer without `L labels`, or an unlabelled row changed. |
| AC-18 | TUI key `L`: prompt `labels for <who>: ` prefilled with the current labels; Enter sets them through `DaemonClient.labels(…, "set")`; an invalid value shows the `parseLabels` error as status and changes nothing; Esc changes nothing. | review (tui.ts has no harness), manual | Key missing, wrong prompt, or a refused value changes labels. |
| AC-19 | Web Mine tab shows a machine's labels (`span.labels` text `gpu, perf-lab`) and a `labels` column with a session's labels; a label set with `mesh label` while the page is open appears within 20 s without reload. | Playwright (`test/e2e-web`) | Labels or column missing, or not refreshed within 20 s. |
| AC-20 | `schemas/hub-api.openapi.json` matches `pnpm schemas` and lists `POST /v1/machines/{id}/labels`; `HUB_API` matches the routes `src/hub/app.ts` serves (rule and scope). | `test/schemas.test.ts` | Stale file, route missing, or rule/scope mismatch. |
| AC-21 | Docs: concepts, how-to and install guide describe labels as in the Docs table; plan §5.6 lists `POST /v1/machines/:id/labels`; `docs/events.md` lists `machine.labelled`; `MESH_SKILL` mentions `mesh label` and equals `skills/mesh/SKILL.md`. | `test/schemas.test.ts` (skill), review | Any of these missing, or the skill file differs from `MESH_SKILL`. |
| AC-22 | `package.json` version is `0.1.10`; `pnpm check` passes (lint, typecheck, boundaries, test, build); `parseLabels`/`Label` live in `src/protocol`, `filterFleet` in `src/core`, the `.mesh/agent.yaml` read in `src/daemon`. | `pnpm check` | Any check fails, or the version is not 0.1.10. |

## Open questions
- (2026-11-11) The design says the sources are "merged, strongest last". Assumed: a stronger source
  replaces a weaker one (a remembered list replaces the repo default; `mesh label` without flags
  replaces the session's list); `--add` / `--rm` are the way to merge. The union reading is the
  alternative.
- (2026-11-11) "Remembered per cwd … a new session in the same repo or worktree gets them".
  Assumed: per checkout (the nearest folder with `.git` at or above the cwd), so each worktree has its
  own list and a subfolder shares its checkout's list. Sharing across all worktrees of one repo is
  the alternative.
- (2026-11-11) The design says machine labels are "stored on the hub machine row, sent with sync".
  Assumed, as for the nickname in MM-1: the hub is the only source (`POST /v1/machines/:id/labels`,
  which also lets `--machine` label another of my machines, even offline); the daemon does not send
  them with sync and sync never changes them.
- (2026-11-11) The `not a topic` warning needs the hub's topic list, so it is shown only when a hub
  could be asked (CLI and TUI through the daemon; machine labels through the hub reply). Labels from
  `.mesh/agent.yaml` are never warned about (no one is at a prompt when a session starts).
- (2026-11-11) Labels are assigned when the daemon first records a session; sessions from before
  the upgrade, and live sessions when `.mesh/agent.yaml` or a remembered list changes later, keep
  theirs (use `mesh label` to change them).
- (2026-11-11) `mesh setup`'s `me`/`all` lines list "state, repo, name, times"; they are not changed
  (MM-1 tests pin them); the install guide adds labels to what the hub sees.
- (2026-11-11) `--label a,b` filters on every label given (as `--topic` does for goals); a machine
  that matches keeps all its sessions.
- (2026-11-11) `all` is accepted as an ordinary label (it is a listed topic, so no warning).
