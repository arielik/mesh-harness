# MM-2 implementation plan: Labels

Spec: `docs/specs/MM-2.md` (revision 1). Branch: `feat/my-mesh-assign`. Release v0.1.10.

This plan covers the implementation only. It plans no new tests. The test side writes them from
the spec's contracts. The section "Existing tests and generated files the developer adjusts" lists
every existing test, snapshot and generated file whose asserted behaviour (or type) the spec
changes, and nothing else.

## 0. Overview and build order

The work goes bottom-up along the module boundaries in `.dependency-cruiser.cjs`. Each stage
typechecks on its own. The exception is `FleetMachine.labels`, which becomes a required field: three
existing test fixtures need `labels: []` in the same stage (see the last section).

| Stage | Module | Work | Criteria |
|---|---|---|---|
| 1 | `src/protocol` | `LABEL_RULE`, `MAX_LABELS`, `Label`, `parseLabels`, `Session.labels`, `LabelsResult` (session.ts); `LiveSession.labels`, `FleetMachine.labels`, `MachineLabels`, `MachineLabelsView` (hub.ts); `HUB_API` row; `MESH_SKILL` text | AC-01, AC-20, AC-21 |
| 2 | `src/core` | `fleet.ts`: labels in `renderFleet`, new `filterFleet` | AC-11, AC-12 |
| 3 | `src/store` | `MachineExtra.labels`, `machineFrom`, `MachineRow.labels`, `setMachineLabels`; `DaemonStore.checkoutLabels` / `setCheckoutLabels` | AC-04, AC-08, AC-10 |
| 4 | `src/hub` | `liveSession` copies labels; `fleet` adds machine labels; `labelMachine` service method; `machine.labelled` activity text; route in `app.ts` | AC-07, AC-09, AC-10, AC-20 |
| 5 | `src/daemon` | new `labels.ts` (checkout key, `.mesh/agent.yaml` read); initial labels in `commit`; `POST /local/labels`; `unknown` from `/v1/topics`; `sessionMetadata` copies labels | AC-02 to AC-07 |
| 6 | `src/cli` | `DaemonClient.labels` / `rememberLabels`; `mesh label`; `mesh run --label`; `mesh machine label`; `mesh machines/fleet --label`; TUI row prefix, footer, key `L` | AC-13 to AC-18 |
| 7 | `web/src` | `mine.tsx`: `span.labels` in the title, `labels` column | AC-19 |
| 8 | repo | `pnpm schemas`, docs, `package.json` 0.1.10, adjust the listed existing tests/snapshot, `pnpm check` | AC-20, AC-21, AC-22 |

Order constraints that hold across sections:
- Stage 1 comes first. Everything else imports `parseLabels`, `Label`, `MAX_LABELS`, `LABEL_RULE` and the new types.
- The store (stage 3) comes before the hub service (stage 4) and the daemon (stage 5).
- `core/fleet.ts` (stage 2) comes before the CLI (`mesh machines --label`) and needs nothing else. `mesh_fleet` (src/daemon/tools.ts) already calls `renderFleet` and needs no change.
- The daemon route `POST /local/labels` (stage 5) comes before `DaemonClient.labels` / `rememberLabels`, `mesh label`, `mesh run --label` and the TUI key (stage 6).
- `pnpm schemas` runs after the last change to `src/protocol` (`HUB_API`, `MachineLabels`, `Session`, `MESH_SKILL`). `Session` is part of the `SyncRequest` body, so the OpenAPI document changes too.
- Docs and the version bump go last. They do not affect compilation.

Blast radius summary: no hub schema migration (`SCHEMA_VERSION` stays 6). Machine labels live in the
existing JSON column `machine.extra`. Daemon checkout labels live in the existing `kv` table. Wire
changes are all additive. `Session.labels` is optional. A v0.1.9 hub strips it, because zod drops
unknown keys. `LiveSession.labels` is optional. `FleetMachine.labels` is a new required key in
`/v1/fleet` (old clients ignore it). There is one new hub route and one new hub event type. The
`/local/labels` route is new. Output without labels is byte-for-byte unchanged everywhere except
the TUI session-list footer, which gains `L labels`.

Decisions taken where the spec is silent (conservative reading; none changes a contract):
- D1. The daemon assigns initial labels to every session it records for the first time. That
  includes a session first seen by the reconciler (`applyObservation`), not only hooks, OpenCode
  events and `/local/launch`. All new records go through `Daemon.commit`, so there is one place to
  do it and every new record behaves the same.
- D2. `unknown` lookups from the daemon are capped at 2 s, because `DaemonClient` gives up after 5 s
  and the `HubLink` default timeout is 10 s. A timeout counts as "could not ask a hub", so the
  `unknown` key is absent.
- D3. With `mesh machines --label … --json`, nothing matching prints the filtered view (with an
  empty `machines`), not the sentence. The sentence goes only with the text output. JSON
  consumers get JSON.
- D4. `mesh label` with more than two positionals (`mesh label s a b`) prints the usage and exits 2.
  Labels are one comma-separated argument.

---

## AC-01 `parseLabels`, `Label` and `Session.labels`

Files: `src/protocol/session.ts` (`src/protocol/index.ts` already re-exports it).

Changes:
- `export const LABEL_RULE = "a label is 1-40 characters: lowercase letters, digits, '.', '_' or '-', starting with a letter or digit";`
- `export const MAX_LABELS = 10;`
- `export const Label = z.string().regex(/^[a-z0-9][a-z0-9._-]{0,39}$/, LABEL_RULE);`. Same regex as `TopicName` in `goal.ts`. It is not imported from there, so `session.ts` keeps no dependency on `goal.ts`.
- `export function parseLabels(input: string | readonly string[]): { labels: string[] } | { error: string }`:
  1. `const items = typeof input === "string" ? input.split(",") : [...input];`
  2. For each item: `t = item.trim()`; skip when `t === ""`. Then `l = t.toLowerCase()`; if `!Label.safeParse(l).success`, return `{ error: \`not a label: ${t} (${LABEL_RULE})\` }`. This uses the first bad item, and the message names the item as trimmed, not lowercased.
  3. Put the results in a `Set`. If `set.size > MAX_LABELS`, return `{ error: "at most 10 labels" }`.
  4. `return { labels: [...set].sort() }`. The default sort is code-point order for these ASCII strings. `all` gets no special case.
- `Session`: add `labels: z.array(Label).max(MAX_LABELS).optional()` after `name`, with a doc comment: "What the session is for (MM-2), topic-name syntax; absent when none, never []".
- `export interface LabelsResult` as in the spec: a union of `{ session: Session; unknown?: string[] }` and `{ cwd: string; labels: string[]; unknown?: string[] }`. It is used as the type of the daemon's reply.

Order: first change of the release.

Blast radius: `Session` is parsed in `SyncRequest` (hub), `SessionsResponse` (CLI) and the daemon store load. Every one of these is optional and additive. A stored session whose `labels` was never written stays valid.

Risks: the `"-x"` case must fail on the regex, not be trimmed away, and `trim()` does not remove `-`, so this works. The `"a b"` error must quote `a b` exactly. Do not lowercase before taking the text for the error message.

## AC-02 `sessionMetadata` and `syncedSessions` carry labels

File: `src/daemon/hub-link.ts` `sessionMetadata`.

Change: add `...(s.labels?.length ? { labels: s.labels } : {}),` after `name`. `syncedSessions` needs no change: step holders are sent as full records, which already include `labels`, and the rest go through `sessionMetadata`.

Order: after AC-01 (the `Session.labels` type).

Blast radius: the sync body of `me`/`all` machines. Under `steps`, no-step sessions are still not sent.

Risks: an empty list must never produce `labels: []`. The daemon never stores `[]` (AC-05), and this guard makes sure of it as well.

## AC-03 Repo default from `.mesh/agent.yaml`

New file: `src/daemon/labels.ts` (daemon layer, as AC-22 requires).
- `import { findRepoRoot } from "./git.ts"`, `import { parse } from "yaml"`, `readFileSync`/`existsSync`, `resolve`/`join`.
- `export function checkoutTop(cwd: string): string | undefined { return findRepoRoot(cwd); }`. `findRepoRoot` already returns the nearest folder at or above `cwd` that has a `.git` entry, whether a folder or a file, so worktrees are covered.
- `export function checkoutKey(cwd: string): string { return checkoutTop(cwd) ?? resolve(cwd); }`
- `export function repoDefaultLabels(cwd: string, log: (line: string) => void): string[] | undefined`:
  - `top = checkoutTop(cwd)`. If there is none, return `undefined`. `file = join(top, ".mesh", "agent.yaml")`. If the file does not exist, return `undefined` without logging.
  - Read it and `parse()` inside try/catch. On a read or YAML error: `log(\`${file}: ignored (${reason})\`)`, return `undefined`.
  - `labels = doc?.labels`. If it is not an array whose items are all strings: log `…: ignored (labels must be a list of strings)`, return `undefined`. A missing `labels` key returns `undefined` without logging.
  - `r = parseLabels(labels)`. On error: log `…: ignored (<error>)`, return `undefined`. Otherwise return `r.labels` (it may be `[]`).
- `export function initialLabels(cwd: string, remembered: (key: string) => string[] | undefined, log): string[] | undefined`: `const mem = remembered(checkoutKey(cwd)); if (mem !== undefined) return mem; return repoDefaultLabels(cwd, log);`. This is a pure function of the file system and the store accessor.

File: `src/daemon/daemon.ts` `commit(result)`:
- Next to the existing `repoForCwd` fill-in, for each `s` in `changed` with `!before.has(s.sid)` and `s.labels === undefined` and `s.cwd` set (a first record, see D1): `const l = initialLabels(s.cwd, (k) => this.store.checkoutLabels(k), this.deps.log); if (l?.length) s.labels = l;`.
- A placeholder adopted by its first hook keeps its sid and its record (`applyHook` reuses the placeholder at `index`), so it is not "new" and keeps its labels. Sessions loaded from the store at start do not go through `commit`, so they keep their labels.

Order: needs AC-01, and `DaemonStore.checkoutLabels` (AC-04) for the remembered branch. The file branch alone can land first if `remembered` returns `undefined` until then.

Blast radius: every newly recorded session does a few `existsSync` calls up the directory tree, plus at most one small file read. This happens only on first record, not on each hook.

Risks:
- `s.cwd` can be `""` for a reconciler entry without a cwd. That case is skipped.
- Relative `cwd` values are resolved by `findRepoRoot`/`resolve`.
- Symlinked temp folders (macOS `/tmp`) are not realpath'd. The spec says "absolute paths", so the same string the hook reports is used.

## AC-04 Remembered labels per checkout (store, `{cwd}` form, restart)

File: `src/store/daemon-store.ts`:
- `checkoutLabels(key: string): string[] | undefined { const v = this.getKv(\`checkout-labels:${key}\`); return v === undefined ? undefined : (JSON.parse(v) as string[]); }`
- `setCheckoutLabels(key: string, labels: readonly string[]): void { this.setKv(\`checkout-labels:${key}\`, JSON.stringify([...labels])); }`
- No migration. `kv` exists (migration in `DAEMON_MIGRATIONS`) and lives in the same store file, so it survives a restart.

File: `src/daemon/daemon.ts`, new route in `handle()` (see AC-05 for the shared parsing):
- `{cwd, labels}` with no `target`: `r = parseLabels(labels)`; on error, `HttpError(400, r.error)`. `key = checkoutKey(cwd)`; `this.store.setCheckoutLabels(key, r.labels)`; reply `{ cwd: key, labels: r.labels, ...unknownOf(r.labels) }`. No session changes.

Precedence (spec "Which labels a session gets") is implemented by `initialLabels` (AC-03). A remembered `[]` returns `[]`, so `commit` sets no labels and does not fall back to the file. Two worktrees of one repo have different `findRepoRoot` results, so they have different keys and do not inherit.

Order: store methods first, then `initialLabels`, then the route.

Blast radius: new kv keys only.

Risks: `labels` in the body must be an array of strings. Anything else gets the 400 usage text (AC-05). A `cwd` that does not exist still gets a key (the resolved path), and this is harmless.

## AC-05 `POST /local/labels {target, labels, mode}`

File: `src/daemon/daemon.ts`.
- In `handle()`: `if (req.method === "POST" && path === "/local/labels") return send(res, 200, await this.labels(await readJson(req)));`
- New `async labels(body: unknown): Promise<LabelsResult>`:
  - `const USAGE = "expected {target, labels, mode: set|add|rm} or {cwd, labels}"`.
  - `b` = the body as a record. `labels` must be an array of strings, else `HttpError(400, USAGE)`.
  - If `typeof b.target === "string" && b.target`: `mode` must be `set|add|rm`, else 400 USAGE. Then:
    - `s = findSession(this.sessions, b.target)`. If none: `HttpError(404, \`no live session matches "${b.target}"\`)`. This is the same text `say` uses.
    - `r = parseLabels(b.labels)`. On error: 400 with `r.error`.
    - `cur = s.labels ?? []`. `next` = `set`: `r.labels`; `add`: `[...new Set([...cur, ...r.labels])].sort()`; `rm`: `cur.filter((l) => !r.labels.includes(l))`.
    - If `next.length > MAX_LABELS`: `HttpError(400, "at most 10 labels")`. Nothing has been written at this point.
    - `const updated = this.update(s.sid, { labels: next.length ? next : undefined })`. `update` deletes keys whose value is `undefined`, saves through `commit` (which persists the session and observes it) and calls `link.flush()`, so the next sync carries the new list (AC-07).
    - `this.store.setCheckoutLabels(checkoutKey(s.cwd), next)`. Other live sessions are not touched.
    - Reply `{ session: updated, ...await this.unknownOf(next) }`.
  - Else if `typeof b.cwd === "string" && b.cwd`: AC-04 branch.
  - Else 400 USAGE.
- Every validation happens before any write, so a refused call changes nothing.

Order: after AC-04's store methods and AC-06's `unknownOf` (or stub it as `{}` first).

Blast radius: `update()` is the existing path used by autopilot and step binding. `observe()` enqueues hub events only on new provenance, rebinds, turn counts and state/needs changes, so a label-only change enqueues no event. The label change reaches the hub through the session records of the next sync only.

Risks: `findSession` also matches by repo name and cwd suffix. That is the documented selector behaviour, shared with `say`.

## AC-06 `unknown` from the hub's topics

File: `src/daemon/daemon.ts`, new private `async unknownOf(labels: readonly string[]): Promise<{ unknown?: string[] }>`:
- If `!this.link?.credentials()`, return `{}`. The link exists with team credentials or with the Solo hub's (`opts.solo`).
- `Promise.race` of `this.link.rpc<{ topics: { name: string }[] }>("GET", "/v1/topics")` and a 2 s timer (D2). On a throw or timeout, return `{}`. While offline, `rpc` fails at once.
- `defined = new Set(topics.map((t) => t.name))`. The hub's list starts with `all`, so `all` is never unknown. Return `{ unknown: labels.filter((l) => !defined.has(l)).sort() }`. That is `[]` when all are defined.

Order: with AC-05.

Blast radius: one hub GET per label call. It is never on the hook path.

Risks: a `goals:read` scope is not required, because the daemon uses a member machine token. Leave the timer unreferenced (`unref`) so it cannot keep a test process alive.

## AC-07 Labels reach `/v1/live` and `/v1/fleet` through sync

Files:
- `src/daemon/hub-link.ts`: AC-02.
- `src/hub/service.ts` `liveSession(hs)`: add `...(hs.session.labels?.length ? { labels: hs.session.labels } : {})`. Both `/v1/live` and `/v1/fleet` build sessions with it (`fleet` spreads it), so one change covers both. Visibility (`sessionVisible`) is unchanged.
- `src/protocol/hub.ts` `LiveSession`: `labels?: string[] | undefined` (doc: "absent when none"). `FleetSession` inherits it.
- The hub's `sync` stores `Session` as JSON (`upsertSession` → `json(s)`), so `labels` passes through once `Session` has the field.

Order: after AC-01 and AC-02.

Blast radius: `/v1/live` JSON gains an optional key. The web Live page ignores it (out of scope).

Risks: the key must be absent, not `labels: undefined` serialised. `JSON.stringify` drops `undefined` anyway, but in-process `toStrictEqual` comparisons would see it, so use the spread form.

## AC-08 `HubStore` machine labels (no migration)

File: `src/store/hub-store.ts`:
- `type MachineExtra = { repos?: Repo[]; reposAt?: number; labels?: string[] }`.
- `MachineRow`: `labels?: string[]` (doc: "MM-2: what the machine has; absent when none").
- `machineFrom`: add `...(Array.isArray(x.labels) && x.labels.length ? { labels: x.labels } : {})` after `reposAt`.
- New `setMachineLabels(id: string, labels: readonly string[]): Promise<void>`: `this.tx(async () => { const r = await this.db.get<{ extra: string | null }>(\`SELECT extra FROM machine WHERE id = ?${this.db.dialect.forUpdate}\`, id); if (!r) return; const { labels: _old, ...rest } = machineExtra(r.extra); await this.db.run("UPDATE machine SET extra = ? WHERE id = ?", json(labels.length ? { ...rest, labels: [...labels] } : rest), id); })`. It does not touch `nickname`, `share` or `last_seen`.
- `touchMachine`: already spreads `machineExtra(r.extra)` when it replaces `repos`, so labels are kept. Add the fact to the doc comment.
- `SCHEMA_VERSION` stays `HUB_MIGRATIONS.length` (6). Do not append a migration.
- `src/store/hub-copy.ts` copies `machine` rows with `extra` as-is, so it needs no change.

Order: before AC-09.

Blast radius: clearing writes `{}` (or `{repos…}`) instead of `NULL` into `extra`. `machineFrom` maps both to the same row, so the row compares equal with `toStrictEqual`.

Risks: on Postgres, `forUpdate` locks the row. `this.tx` must reuse the outer transaction when the service already opened one, as `setMachineNickname` does today.

## AC-09 `POST /v1/machines/:id/labels`

Files:
- `src/protocol/hub.ts`:
  - `const LabelItems = z.array(z.string().max(40)).max(20);`
  - `export const MachineLabels = z.union([z.object({ labels: LabelItems }).strict(), z.object({ add: LabelItems.optional(), remove: LabelItems.optional() }).strict().refine((b) => (b.add?.length ?? 0) + (b.remove?.length ?? 0) > 0, "give labels to add or remove")]);` and `export type MachineLabels = z.infer<typeof MachineLabels>`.
  - `export interface MachineLabelsView { id: string; hostname: string; nickname?: string | undefined; labels: string[]; unknown: string[] }`.
- `src/protocol/hub-api.ts`: after the `/v1/machines/:id/name` row: `{ method: "POST", path: "/v1/machines/:id/labels", rule: "member", tag: "daemon", body: MachineLabels, summary: "Label one of your machines (replace, or add/remove)." }`. It has no `scope`, so service tokens get 403 as they do on `/name`.
- `src/hub/app.ts`: `r("POST", "/v1/machines/:id/labels", "member", async (c, a) => c.json(await svc.labelMachine(a, param(c, "id"), await body(c, MachineLabels))))`, next to `/name`, with no scope argument.
- `src/hub/service.ts` new `async labelMachine(actor, id, change: MachineLabels): Promise<MachineLabelsView>`:
  1. Normalise outside the transaction: for `labels`, `parseLabels(change.labels)`. For `add`/`remove`, `parseLabels(change.add ?? [])` and `parseLabels(change.remove ?? [])`. The first `{error}` becomes `HubError(400, error)`. A replace list with more than 10 distinct labels gets `parseLabels`'s own `at most 10 labels`.
  2. `this.store.tx(async () => { await this.store.serialize(); const m = await this.store.getMachine(id); …`. `serialize()` makes two concurrent edits run one after another, so both adds land on SQLite and on Postgres.
  3. If there is no machine: `HubError(404, \`no machine ${id}\`)`. If `m.userId !== actor.userId`: `HubError(403, "not your machine")`, with no admin exception.
  4. `before = m.labels ?? []`. `next` = replace: the parsed list; add/remove: `[...new Set([...before, ...add])].filter((l) => !remove.includes(l)).sort()`. If `next.length > MAX_LABELS`: `HubError(400, "at most 10 labels")`.
  5. If `next.join(",") !== before.join(",")`: `await this.store.setMachineLabels(id, next); await this.emit({ type: "machine.labelled", user: actor.userId, payload: { machine: id, labels: next } })`. `emit` publishes the SSE `changed` hint after commit. Otherwise no write and no event.
  6. `defined = new Set([ALL_TOPIC, ...(await this.store.listTopics()).map((t) => t.name)])`. Return `{ id, hostname, ...(m.nickname ? { nickname: m.nickname } : {}), labels: next, unknown: next.filter((l) => !defined.has(l)) }`. `next` is sorted, so `unknown` is too.
- `describe()` in service.ts: new case `"machine.labelled"`: `const host = hostnames?.get(String(payload.machine)) ?? String(payload.machine); const ls = (payload.labels as string[] | undefined) ?? []; return ls.length ? \`labelled machine ${host} ${ls.join(", ")}\` : \`cleared the labels of machine ${host}\`;`.
- How a service token reaches 403: `r(...)` without a scope already refuses service tokens (as on `/name`). `{}` and `{add: [], remove: []}` fail the union, and `body()`'s zod error maps to 400 the same way other bodies do. Check that the app's error handler turns a `ZodError` into 400. It does for `MachineName` today.

Order: after AC-08 and AC-01. The `HUB_API` row and the `app.ts` route go in together (AC-20).

Blast radius: one new event type in the events table and the analysis feed. Live activity gains one text form.

Risks: a `{labels: [...], add: [...]}` body fails the strict union (400). This is intended. Do the normalisation errors before the `getMachine` lookup, so a bad label on an unknown id gives 400, not 404. The spec lists "Every item normalised …; error: 400" first.

## AC-10 `/v1/fleet` machine labels; sync never changes them

Files:
- `src/protocol/hub.ts` `FleetMachine`: `labels: string[]` (doc: "MM-2: the machine's labels, sorted; [] when none"), after `reposAt`.
- `src/hub/service.ts` `fleet()`: add `labels: m.labels ?? []` to each machine object.
- `sync` calls `touchMachine` (AC-08 keeps the labels). A sync without `machine` takes the `UPDATE … last_seen, counts` branch, which does not touch `extra`.
- `SyncRequest.machine` gets no `labels` field (out of scope: the daemon does not send them).

Order: after AC-08.

Blast radius: `FleetMachine` gets a required field, which the web (`mine.tsx`), `renderFleet`, the TUI panel and the three test fixtures listed at the end all read.

Risks: none beyond the fixture typecheck.

## AC-11 `renderFleet` with labels; `mesh_fleet` text

File: `src/core/fleet.ts`:
- `const tag = (ls: readonly string[] | undefined) => (ls?.length ? \` · [${[...ls].sort().join(", ")}]\` : "");`
- `sessionLine`: `… · ${s.step ?? "no step"}${tag(s.labels)} · ${age(…)}`.
- `machineBlock` head: `… · ${n} ${n === 1 ? "repo" : "repos"}${tag(m.labels)}${m.current ? " · this machine" : ""}`.
- Write `m.labels` defensively as `m.labels ?? []` (the `tag` helper accepts `undefined`). A view from a v0.1.9 hub has no machine `labels` key, and the output must then match MM-1 exactly.
- `src/daemon/tools.ts` `mesh_fleet` already returns `renderFleet(view)`. No change. `mesh machines` without `--label` prints `renderFleet(filterFleet(view, []))`, which is the same view, so the two texts are equal.

Order: after AC-01/AC-10 types.

Blast radius: CLI `mesh machines`, the TUI My machines panel and MCP `mesh_fleet`. Output without labels is unchanged.

Risks: keep the separator order exactly: machine labels come before ` · this machine`, session labels after the step.

## AC-12 `filterFleet`

File: `src/core/fleet.ts`, exported through the existing `export * from "./fleet.ts"`:
```ts
export function filterFleet(view: FleetView, labels: readonly string[]): FleetView {
  if (labels.length === 0) return view;
  const has = (ls: readonly string[] | undefined) => labels.every((l) => (ls ?? []).includes(l));
  const machines = view.machines.flatMap((m) => {
    if (has(m.labels)) return [m];
    const sessions = m.sessions.filter((s) => has(s.labels));
    return sessions.length ? [{ ...m, sessions }] : [];
  });
  return { ...view, machines };
}
```
It keeps order, `now`, `user` and `current`. It is a pure function.

Order: with AC-11.

Blast radius: none outside the CLI.

Risks: `labels` reaches it already normalised by `parseLabels` in the CLI. `filterFleet` does not lowercase.

## AC-13 `mesh machines --label` / `mesh fleet --label`

File: `src/cli/machine-commands.ts` `machinesCommand`:
- `const a = parseArgs(args, ["label"]);`
- Before credentials: `const raw = a.str("label"); let want: string[] = []; if (raw !== undefined) { const r = parseLabels(raw); if ("error" in r) { c.io.err(r.error); return 2; } want = r.labels; }`. A bare `--label` with no value is `true`, and `a.str` returns `undefined`. Treat `a.has("label") && raw === undefined` as `parseLabels("")`, which means no filter.
- `const shown = filterFleet(view, want);`
- `--json`: `JSON.stringify(shown, null, 2)` (D3).
- Text: if `want.length && shown.machines.length === 0 && view.machines.length > 0`, print `No machine or session of yours is labelled ${asGiven.join(" and ")}.`. Otherwise print `renderFleet(shown)`. Exit 0. `asGiven` is the list in the order the user typed it: `raw.split(",")`, trimmed, lowercased, empties dropped, deduplicated in first-seen order. The spec example `--label perf,gpu` → `… labelled perf and gpu.` keeps the typed order, while `parseLabels` sorts. The filter uses the sorted `want`. The order does not matter for an all-of match.
- Update `summary` to mention `--label a,b`.

Order: after AC-12.

Blast radius: `mesh fleet` is the same command object under another name, so it is covered.

Risks: the message order (typed order, not sorted) is the easy thing to get wrong. With an empty fleet (no machines) and a label, the existing "No machines logged in…" text from `renderFleet` stays.

## AC-14 `mesh label`

Files:
- `src/cli/client.ts`: `labels(target, labels, mode)` → `this.call("POST", "/local/labels", { target, labels, mode })`, returning `{ session: Session.parse(r.session), ...(r.unknown ? { unknown: r.unknown } : {}) }`. `rememberLabels(cwd, labels)` → `this.call("POST", "/local/labels", { cwd, labels })`. Import `LabelsResult` for the return types.
- `src/cli/mesh-commands.ts`: new `labelCommand(c)`, registered in `meshCommands` (after `sayCommand`), so `mesh help` lists `label`.
  - `name: "label"`, `summary: "say what a session is for: mesh label <session> <label,…> [--add|--rm] | --clear"`.
  - `const USAGE = "usage: mesh label <session> <label,…> [--add|--rm]\n       mesh label <session> --clear";`
  - `a = parseArgs(args)`; `[target, raw] = a.positional`; `clear = a.has("clear")`; `add = a.has("add")`; `rm = a.has("rm")`.
  - Misuse prints USAGE to stderr and exits 2: `!target`, `(!raw && !clear)`, `(raw && clear)`, `(add && rm)`, `(clear && (add || rm))`, `a.positional.length > 2` (D4).
  - `const r = clear ? { labels: [] } : parseLabels(raw)`. On error: `c.io.err(r.error)`, return 2. This happens before any `DaemonClient` call.
  - `try { res = await client(c).labels(target, r.labels, clear ? "set" : add ? "add" : rm ? "rm" : "set") } catch (e) { c.io.err(e.message); return 1; }`. This covers 404/400 and `DaemonUnreachable`, which print the bare text, not `mesh: …`.
  - `who = s.name ?? s.repo?.name ?? s.sid.slice(0, 8)`. This is the same expression `autopilotCommand` uses; factor it into a small `whoOf(s)` helper in mesh-commands.ts and reuse it in the TUI.
  - stdout: `s.labels?.length ? \`${who}: labels ${s.labels.join(", ")}\` : \`${who}: no labels\``.
  - For each `l` of `res.unknown ?? []`: `c.io.err(\`not a topic: ${l}; mesh topic add ${l}\`)`. Exit 0.

Order: after AC-05/AC-06.

Blast radius: one new command and two new client methods.

Risks: `parseArgs` without value flags treats `--add` / `--rm` / `--clear` as booleans, as intended. A label string starting with `--` is treated as a flag. That is acceptable, because labels cannot start with `-`.

## AC-15 `mesh run --label`

File: `src/cli/mesh-commands.ts` `runCommand`:
- Add `"label"` to the `parseArgs` value flags.
- Right after `parseArgs`, before the `--agent` check and before the `--design` hub GET, the claim, tmux and the runner: `const rawLabels = a.str("label"); let runLabels: string[] | undefined; if (rawLabels !== undefined) { const r = parseLabels(rawLabels); if ("error" in r) { c.io.err(r.error); return 2; } runLabels = r.labels; }`.
- New local helper `const recordLabels = async (dirs: readonly string[]) => { … }`. It runs only when `runLabels !== undefined && config`. For each `dir`: `try { const r = await new DaemonClient(config).rememberLabels(dir, runLabels); if (!warned && r.unknown) { for (const l of r.unknown) c.io.err(\`not a topic: ${l}; mesh topic add ${l}\`); warned = true; } } catch (e) { c.io.err(\`warning: could not record the labels for ${dir}: ${msg}\`); }`. The `not a topic` lines come from the first successful reply only.
- Call `await recordLabels(dirs)` once, after the `--step` block (so `dirs[0]` is the worktree when one is used) and before the `if (a.has("bg"))` branch. Both the `--bg` loop and the tmux loop come after it, so every session starts after its checkout's list is remembered. The `/local/launch` placeholder and the first hook both go through `commit`, so both get the list.
- Usage line: add `[--label a,b]` to the `mesh run <repo…> …` usage text and to `summary`.

Order: after AC-14's `rememberLabels`.

Blast radius: `mesh run` without `--label` is unchanged. There are no extra daemon calls.

Risks:
- `resolveRepo` returns absolute paths, and the daemon reduces each to its checkout key, so a repo given as a subfolder still lands on its checkout.
- With `--design`, `addDirs` get no labels. Only the directories where sessions start do.

## AC-16 `mesh machine label`

File: `src/cli/machine-commands.ts` `machineCommand`:
- `MACHINE_USAGE` gains a third line: `       mesh machine label <label,…> [--add|--rm] [--machine <id|nickname|hostname>]`, followed by `       mesh machine label --clear [--machine <id|nickname|hostname>]`. It still contains `mesh machine name <nickname>`, which the existing MM-1 test checks.
- Factor out the shared "which machine" block: `async function targetMachine(c, creds, a): Promise<{ id: string } | { code: number }>`. It does the current logic for `--machine`, with the same messages and exit codes. `name` and `label` both use it.
- `sub === "label"`: `[, raw] = a.positional`. Usage and exit 2 when `(!raw && !clear) || (raw && clear) || (add && rm) || (clear && (add || rm))`. `r = clear ? { labels: [] } : parseLabels(raw)`. On error: stderr, exit 2. All of this happens before any hub call, including the `--machine` fleet lookup.
- Body: `clear` or no flag → `{ labels: r.labels }`; `--add` → `{ add: r.labels }`; `--rm` → `{ remove: r.labels }`.
- `HubClient.post<MachineLabelsView>(\`/v1/machines/${id}/labels\`, body)`. On `HubCallError`: `c.io.err(e.message)`, exit 1.
- stdout: `res.labels.length ? \`${res.hostname} (${res.id}): labels ${res.labels.join(", ")}\` : \`${res.hostname} (${res.id}): no labels\``. For each `res.unknown`: stderr `not a topic: <l>; mesh topic add <l>`. Exit 0.
- `summary` mentions `label`.
- Any other `sub` (not `name`, not `label`): usage and exit 2, as today.

Order: after AC-09 (route) and AC-01.

Blast radius: the `name` subcommand's behaviour is unchanged. The refactor only moves code.

Risks: `--add` with an empty list (`mesh machine label "" --add`) has `raw` empty, which is the usage case. That avoids sending `{add: []}`, which the hub would refuse with 400.

## AC-17 TUI `render`: label prefix and footer

File: `src/cli/tui/render.ts` `render()`:
- At the line that computes `middle`: `const text = (s.labels?.length ? \`[${s.labels.join(", ")}] \` : "") + detail(s, v.now);` then `fit(text, …)`. `detail()` stays unchanged, so rows without labels are byte-identical.
- Footer string: insert ` · L labels` after `a autopilot` (giving `⏎ jump · s say · a autopilot · L labels · n next step · g goals · m machines · r refresh · ↑↓ move · q quit`). `fit` does not clip the footer today. Check the 120/100-width snapshot fits, and accept the snapshot update listed below.
- `renderMachines` needs no change. It goes through `renderFleet` (AC-11).

Order: after AC-01.

Blast radius: the session-list snapshot footer line (listed below).

Risks: width. The label prefix eats into the detail column, and `fit` already truncates.

## AC-18 TUI key `L`

File: `src/cli/tui/tui.ts`:
- `prompt` type: add `kind: "say" | "labels"`. The existing `s` branch sets `kind: "say"`.
- In the session-list key handler (after the `goals || machines` early return, so `L` does nothing in those views): `else if (key === "L") { const who = whoOf(s); prompt = { kind: "labels", label: \`labels for ${who}: \`, value: (s.labels ?? []).join(", "), target: s.sid }; draw(); }`. Use the `who` helper from AC-14. Either move it to `render.ts` or put a small one in `tui/` so the TUI does not import a command module.
- Enter in the prompt branch: if `p.kind === "labels"`: `r = parseLabels(p.value)`. If there is an error: `status = r.error`; `draw()`; return with no call. Otherwise `try { const res = await client.labels(p.target, r.labels, "set"); const s2 = res.session; status = (s2.labels?.length ? \`${who}: labels ${s2.labels.join(", ")}\` : \`${who}: no labels\`) + (res.unknown ?? []).map((l) => \` · not a topic: ${l}; mesh topic add ${l}\`).join(""); } catch (e) { status = message }`, then `await refresh()`. An empty value sends `[]`, which clears. Keep the existing `say` path for `kind === "say"`, but drop its `p.value.trim()` guard only for labels. For `say`, an empty value still does nothing.
- Esc already clears `prompt` without a call.
- The `label` text for `who` is built when `L` is pressed. Keep it on the prompt object (`who`) for the status.

Order: after AC-14's `DaemonClient.labels`.

Blast radius: the `say` prompt behaviour is unchanged.

Risks: there is no harness (review/manual criterion). Make sure `L` (uppercase) does not collide with existing keys. None uses it.

## AC-19 Web Mine tab

File: `web/src/mine.tsx` `Machine`:
- In `<h3>`, after the title text and before ` · this machine`: `{m.labels?.length ? <> <span className="labels">{m.labels.join(", ")}</span></> : null}`. Use `?.` because an older hub sends no key.
- Sessions table: `<th>labels</th>` between `step` and `age`. The cell is `<td className="labels">{s.labels?.join(", ") ?? ""}</td>`.
- Refresh: the page already refetches on the SSE `changed` hint and every 15 s. A `mesh label` on a `me` machine reaches the hub at the next daemon flush (`update()` calls `link.flush()` at once), and the 15 s poll is within 20 s, so no change is needed there.
- Optional CSS in the existing web stylesheet: `.labels` muted pill style. It is cosmetic.

Order: after AC-10/AC-07 types.

Blast radius: Mine page only. The Live page is unchanged (out of scope).

Risks: none. Playwright is not part of `pnpm check`. Run `pnpm test:web` by hand when a browser is available.

## AC-20 OpenAPI and `HUB_API`

- `HUB_API` row and `app.ts` route as in AC-09, with the same rule (`member`) and no scope on both.
- Run `pnpm schemas`. It regenerates `schemas/hub-api.openapi.json` (the new path `/v1/machines/{id}/labels`, the `MachineLabels` body, and the `SyncRequest` body whose `Session` gains `labels`) and `skills/mesh/SKILL.md`. Check that `hubOpenApi()` turns the `z.union` body into JSON Schema without throwing. Zod 4 `toJSONSchema` supports unions and `.strict()`. If the refine on the add/remove branch is not representable, it is dropped from the document, which is acceptable.

Order: after every `src/protocol` change (rerun if one changes later).

## AC-21 Docs and skill

- `docs/guide/concepts.md`: after the **Topic** paragraph, a **Label** paragraph: session and machine labels; topic-name syntax; at most 10; the three sources and their order (a remembered list from `mesh run --label` / `mesh label` / TUI `L` replaces the repo default `.mesh/agent.yaml`; it is per checkout, so each worktree has its own); the `.mesh/agent.yaml` format (`labels: [perf, dataplane]`, other keys ignored); machine labels stored on the hub (`mesh machine label`); the `not a topic: <label>; mesh topic add <label>` warning.
- `docs/guide/howto.md`: a new `### Label sessions and machines` under section 3, after "See all your machines". It shows `.mesh/agent.yaml`, `mesh run <repo> --label perf`, `mesh label <session> perf,gpu [--add|--rm|--clear]`, TUI `L`, `mesh machine label gpu,perf-lab [--machine …]`, `mesh machines --label perf`. Update the example output in "See all your machines" to show ` · [gpu]` on a machine line and ` · [perf]` on a session line.
- `docs/guide/install.md` "What the hub sees": one sentence saying a session's metadata includes its labels (for the `me`/`all` levels and step holders). The `mesh setup` lines stay unchanged (spec open question).
- `src/protocol/skill.ts` `MESH_SKILL`: a paragraph and command-table rows for `mesh label <session> a,b` (with `--add|--rm|--clear`), `.mesh/agent.yaml` `labels:`, `mesh machine label`, and `mesh machines --label a,b`. Then `pnpm schemas` regenerates `skills/mesh/SKILL.md`.
- `docs/plan/implementation-plan.md` §5.6: a new row `| \`POST /v1/machines/:id/labels\` | Machine labels (v0.1.10) |` after the My mesh row.
- `docs/events.md`: the row `| \`machine.labelled\` | a machine's labels changed | \`machine\`, \`labels\` |` after `machine.named`.
- Keep everything generic: example labels such as `perf`, `gpu`, `dataplane`, and hostnames such as `build-box`.

Order: last. `MESH_SKILL` must be updated before the final `pnpm schemas`.

## AC-22 Version, layering, `pnpm check`

- `package.json` `"version": "0.1.10"`.
- Layering: `parseLabels`/`Label`/`MAX_LABELS`/`LABEL_RULE` are in `src/protocol/session.ts`. `filterFleet` is in `src/core/fleet.ts`. The `.mesh/agent.yaml` read is in `src/daemon/labels.ts`. The CLI and TUI import `parseLabels` from `../protocol/index.ts` and `filterFleet` from `../core/index.ts`. Nothing in `src/protocol` or `src/core` reads files.
- Run `pnpm lint`, `pnpm typecheck`, `pnpm boundaries`, `pnpm test`, `pnpm build` (`pnpm check`). Before every `pnpm` run, set `PATH` to include the pinned pnpm directory.

---

## Existing tests and generated files the developer adjusts

Only these. Each one asserts behaviour (or a type) the spec changes:

| File | Change | Why |
|---|---|---|
| `test/schemas.test.ts` (version assertion, line ~127) | `"0.1.9"` → `"0.1.10"`. | The version moves to 0.1.10 (AC-22). |
| `src/cli/tui/__snapshots__/render.test.ts.snap` (session list snapshot, footer line) | The footer line gains ` · L labels`: `⏎ jump · s say · a autopilot · L labels · n next step · g goals · m machines · r refresh · ↑↓ move · q quit`. Rows unchanged. Regenerate with `vitest -u` for that file only and check that the diff is the footer line alone. | The footer must contain `L labels` (AC-17). |
| `src/core/fleet.test.ts` (`machine()` factory) | Add `labels: []` to the factory defaults. Assertions unchanged. | `FleetMachine.labels` is a required field (AC-10). It is type-only, and the MM-1 render cases still render the same output. |
| `src/cli/tui/render.test.ts` (`machine()` factory, line ~113) | Add `labels: []` to the factory defaults. Assertions unchanged. | Same type change. |
| `src/daemon/inventory.test.ts` (`FLEET` literal) | Add `labels: []` to the machine object. Assertions unchanged. | Same type change. |
| `schemas/hub-api.openapi.json` (generated) | Regenerate with `pnpm schemas`. | New route; `Session.labels` in the sync body (AC-20). |
| `skills/mesh/SKILL.md` (generated) | Regenerate with `pnpm schemas`. | `MESH_SKILL` mentions labels (AC-21). |

Not adjusted, because they still hold:
- `test/my-mesh.test.ts`: `mesh machine` usage still contains `mesh machine name <nickname>`. `/name` replies are unchanged. Rows without labels are unchanged.
- `src/store/hub-store.contract.test.ts`: `SCHEMA_VERSION` is still 6, and machine rows without labels are unchanged.
- `src/daemon/hub-link.test.ts`: fixtures without labels give the same `sessionMetadata`.
- `test/schemas.test.ts` route-list tests: they compare `HUB_API` with `app.ts`, and both gain the same row.

If `pnpm test` shows another existing test failing only because of these contract changes (for example a strict shape assertion on a `FleetMachine`), the developer adjusts that test the same way (add `labels: []`) and adds it to this table in the PR description. No assertion that pins behaviour the spec keeps may change.
