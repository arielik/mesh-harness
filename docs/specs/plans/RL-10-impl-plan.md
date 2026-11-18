# RL-10 implementation plan

Spec: `docs/specs/RL-10.md` (approved after review round 3; round-3 suggestions applied). Builds on
RL-9 (`docs/specs/RL-9.md`, `docs/specs/plans/RL-9-impl-plan.md`). Release v0.1.28. One section per
acceptance criterion (AC-01 .. AC-13, with AC-06b .. AC-06e); each lists files, changes, order,
blast radius and risks. Tests are not planned here (the test side plans from the spec alone and never
sees this plan). The developer changes no test except the existing ones listed under "Existing tests
and snapshots" at the end, and only where the spec changes the asserted behaviour.

No migration: `SCHEMA_VERSION` stays 11, no `HUB_MIGRATIONS`/`HUB_MIGRATIONS_PG` entry, no new
`HubStore` method. `ItemRow.repo` and `Step.movedTo` live in the JSON `value` columns. Lookups scan
`store.listGoals()` and `store.listSteps({ goal })` / `store.getStep(id)` as RL-9 does.

The centre of the work is **one placing routine** (B4 below) used by every path that opens a finding
step: the sink (RL-9 rules 2-4), the backfill, a move (fold, retarget, and a sink that meets an open
foreign step) and the revert reopen. It decides in memory across several clean-audit goals (one
`NEW_GOAL`-style placeholder per `(repo, topic)` still to be opened), then writes once. Moved-away
steps (`movedTo` set) are invisible to every lookup except "what is the home step" and the
filed-after-every-close gate.

## 0. Build order (all criteria)

Layering as `.dependency-cruiser.cjs` (`protocol` ← nothing; `core` ← `protocol`; `store` ←
`protocol`; `hub` ← `protocol`, `core`, `store`; `cli` ← `core`, `protocol`).

| Stage | Module | Work | Criteria |
|---|---|---|---|
| 1 | `src/protocol` | `review.ts` (`ReviewItem.repo`, `ItemRow.repo`), `goal.ts` (`Step.movedTo`), `hub.ts` (`RetargetRequest`, `RetargetResult`, `SinkResult.goals`), `hub-api.ts` (one route), `tools.ts` (description) | all |
| 2 | `src/core/finding-step.ts` | `targetRepo`, `isMovedAway`, `keyPathRepo`, `sinkCounts` skips moved-away steps | AC-01, AC-02, AC-08, AC-12 |
| 3 | `src/hub/service.ts` | the 422 of one fp with two repos; row `repo` in the fold; lookups across every clean-audit goal (B3); the placing work (B4); sink, backfill, revert through it; fold move; `retargetItems`; `describe()` texts | AC-01 .. AC-11 |
| 4 | `src/hub/app.ts` | `POST /v1/items/retarget` | AC-07 .. AC-09 |
| 5 | `src/cli` | `review-commands.ts` (`mesh items` path column, `mesh items sink` per-entry lines, `mesh items retarget`) | AC-02, AC-06 .. AC-10 |
| 6 | repo | docs, `MESH_SKILL`, `pnpm schemas`, `package.json` 0.1.28, the two version tests, `pnpm check` | AC-12, AC-13 |

Order constraints (global):
- Stage 1 first. `ItemRow` and `Step` are non-strict `z.object`s parsed on every read
  (`ItemRow.parse` in `getItem`/`listItems`/`saveItem`, `Step.parse` in `listSteps`): without the
  field in the schema, `repo` and `movedTo` are stripped silently and lost. `ReviewItem` is
  `.strict()`: without the field every item with `repo` is a 400 (which is AC-02's 301-character
  case only after the field exists with its cap). `StoredReviewItem` and `StoredRecord` extend
  `ReviewItem`, so stored records read back with `repo` only after stage 1.
- Stage 2 before stage 3 (the service decides with the pure helpers).
- Inside stage 3: B3 (lookups) and B4 (placing work, write) before the entry points that use them
  (B5 sync changes, B6 `runSink`/`sinkItems`, B7 fold move, B8 `retargetItems`). Run the RL-9 test
  files (`test/sink-hub.test.ts`, `test/sink-goals.test.ts`, `test/sink-cli.test.ts`) right after
  B4 replaces `decideSink`/`writeSink`: they are the regression net for the refactor and must pass
  unchanged.
- `pnpm schemas` after the last change to `src/protocol` (`HUB_API`, `ReviewItem`, `MESH_SKILL`);
  docs and the version bump last.

## 1. Shared building blocks

**B1. Protocol.**
- `src/protocol/review.ts`:
  - `ReviewItem` gains `repo: z.string().trim().min(1).max(300).optional()` with the comment
    "RL-10: the repo the finding is about (its target repo); never part of `key` or the
    fingerprint". The trim makes `StoredReviewItem.repo` the trimmed text (`body(c, ReviewUpload)`
    parses before the service). A 301-character or blank `repo` is the schema's 400.
    `ReviewUpload.items` is `ReviewItem.extend({ eh })`, so it inherits the field;
    `StoredReviewItem` too.
  - `ItemRow` gains `repo: z.string().optional()` ("RL-10: the target repo when set; absent = the
    lineage repo"). `ItemView` extends it, so `GET /v1/items` and `mesh items --json` carry it.
- `src/protocol/goal.ts`: `Step` gains `movedTo: z.string().optional()` ("RL-10: set only on a
  moved-away finding step: the full id of the step it was moved to").
- `src/protocol/hub.ts`:
  - `RetargetRequest = z.object({ lineage: z.string().min(1).max(600), fps: z.array(Fingerprint).min(1).max(500).optional(), all: z.literal(true).optional(), repo: z.string().trim().min(1).max(300).optional(), from_key_path: z.literal(true).optional(), dry_run: z.boolean().optional() }).strict()`
    (reuse the local `Fingerprint`). The one-of rule is **not** a zod refine: the service throws
    the 400 with the spec's exact text (B8), so the text never goes through the app's zod-issue
    formatting.
  - `interface RetargetResult { items: { fp: string; from: string; to: string }[]; moved: { from: string; to: string }[]; held: string[]; notes: string[] }`
    with a doc comment naming the dry-run id form `new:<repo>/<local id>`.
  - `SinkResult` gains `goals: { goal: string | null; repo: string; added: string[]; reopened: string[] }[]`;
    update its doc comment (`goal` = the entry's goal when exactly one entry, else null; with no
    entry, the lineage repo's clean-audit goal or null).
  - `src/protocol/index.ts` already re-exports these files.
- `src/protocol/hub-api.ts`: import `RetargetRequest`; row after `/v1/items/sink`:
  `{ method: "POST", path: "/v1/items/retarget", rule: "member", scope: "goals:write", tag: "goals", body: RetargetRequest, summary: "Set the target repo of a lineage's items and move their open finding steps." }`.
- `src/protocol/tools.ts` `mesh_review` description: "Each item may carry repo: the repo the
  finding is about when it is not the repo the audit runs in (keep that repo in the key too, e.g. in
  path)." The tool input is `ReviewRecord.shape`, so the field is accepted with no other change.

**B2. Core (`src/core/finding-step.ts`, pure).**
- `targetRepo(row: Pick<ItemRow, "lineage" | "repo">): string` → `row.repo ?? lineageRepo(row.lineage)`.
- `isMovedAway(s: Pick<Step, "movedTo">): boolean` → `s.movedTo !== undefined`.
- `keyPathRepo(path: string | undefined): { repo: string } | { note: "none" | "bad" }`: `undefined`
  → `none`; `path.includes("/") || /\.[A-Za-z0-9]{1,5}$/.test(path)` → `bad`; else `{ repo: path }`.
  The service writes the notes (`<fp>: no key path`, `<fp>: key path <path> is not a repo name`).
- `sinkCounts`: `continue` for a moved-away step before counting (spec: the `mesh show` counts see
  live finding steps only). `refillBySeverity` needs no change (moved-away steps are `dropped`, never
  in a ready list).
- Exported through `src/core/index.ts` (already `export * from "./finding-step.ts"`).

**B3. Lookups (`src/hub/service.ts`).** Names: **open** = `ready`/`blocked`; **held** =
`HELD_OR_FAILED` (`claimed`, `paused`, `parked`, `failed`, as the spec's "Held"); **closed** =
`done`/`skipped`/`dropped` (new `const CLOSED = new Set(["done", "skipped", "dropped"])`).
- `private async cleanAuditGoals(topic?: string): Promise<Goal[]>`: every goal with `sink`, not
  `dropped`, and `sink.topic === topic` when given. Replaces `sinkGoalsOf(lineage)` (which kept only
  the lineage repo's goals). `cleanAuditGoal(repo, topic)` stays.
- `findingStepsOf(lineage, fp, goals?)`: `goals` default `cleanAuditGoals()` (every repo), and
  skip a step with `movedTo` (`live` only). Used by the closing rows (B5) unchanged otherwise
  (`getStep` per goal).
- `private async itemRequires(lineage, fp): Promise<string[]>`: union, in order, of `requires` over
  every `accepted` row of `listDispositions({ lineage, fp })` (any goal): "requires of an item" for
  moves.
- `private async newestGoalOf(lineage): Promise<Goal | undefined>`: lifted out of `sinkItems`
  unchanged (largest `createdAt`, then `goalSeq`), shared by the backfill and the retarget.

**B4. The placing work (`src/hub/service.ts`; replaces `decideSink`, `writeSink`, `SinkPlan`, and
`reopenFinding`).** Decide everything in memory over several goals, then write once, inside the
caller's `goalTx`.

Types (module level, next to `SinkItem`):
```ts
interface WorkGoal {
  repo: string; topic: string;
  goal: Goal | undefined;          // undefined: still to be opened
  gid: string;                     // goal id, or a placeholder `<new:N>` (unique per call)
  owner: string;                   // the goal's owner, or the owner a new goal gets
  existing: Step[];                // as read
  all: Map<string, Step>;          // in memory
  changed: Set<string>;
  added: string[]; reopened: string[];   // goal.sunk / SinkResult (moves are listed under added)
}
type IdText = (id: string) => string;    // renders a possibly-placeholder id
interface Work {
  now: number; from: string; fromStep?: string | undefined;
  goals: Map<string, WorkGoal>;          // by gid
  byKey: Map<string, string>;            // `${repo}\0${topic}` → gid
  loaded: Set<string>;                   // topics whose clean-audit goals are loaded
  notes: { step: string; user: string; text: (id: IdText) => string }[];
  events: { type: "step.dropped" | "step.reopened"; goal: string; step: string; user: string; payload: (id: IdText) => Record<string, unknown> }[];
  touched: { id: string; lineage: string; requires: readonly string[]; deps: "add" | "replace" | "none" }[];
  heldNoted: Set<string>;                // "once per call" notes
  skipped: number; resultNotes: ((id: IdText) => string)[];
}
```
Placeholders are opaque (`<new:1>`, `<new:2>`, …), never derived from the repo: a repo may contain
`.` or `/`, and code that splits ids at the first `.` (`local()` in `show.ts`, `writeWork`'s map) must keep working on
them. **Every text that names a step id** (note texts, `summary: moved to …`, event payloads,
`movedTo` itself) is built through an `IdText` at write time (thunks above), so a placeholder never
leaks into a stored text or a dry-run reply in the wrong form.

Routines:
- `private async loadTopic(w, topic)`: once per topic per call, every non-dropped clean-audit goal
  of the topic with `listSteps({ goal })` into `w.goals`/`w.byKey`. Retarget and the fold move load
  the topics of the goals they find steps in. This is the multi-goal view the placing needs (home,
  foreign, every-close gate), read once.
- `private workGoal(w, repo, topic, ownerIfNew): WorkGoal`: the loaded goal of `(repo, topic)`, else
  a new placeholder entry (`goal: undefined`, `existing: []`, owner `ownerIfNew`). Exact string
  compare, as `cleanAuditGoal`.
- `findings(w, lineage, fp, topic)`: every finding step of `(lineage, fp)` in the loaded goals of the
  topic, as `{ wg, step }`, moved-away included (callers filter). Matched by
  `${wg.gid}.${findingStepId(lineage, fp)}` and `finding.lineage/fp` equal.
- `private async placeHome(w, item: SinkItem & { requires }, topic, o: { kind: "sink" | "backfill" | "revert"; user: string; ownerIfNew: string; revertFrom?: string })`:
  1. `target = targetRepo(item.row)`; `home = workGoal(w, target, topic, o.ownerIfNew)`;
     `homeId = ${home.gid}.${findingStepId(lineage, fp)}`.
  2. **Foreign first**: `foreign` = `findings(...)` with `wg !== home`, not moved-away, not closed.
     Any held → for each held one, note `filed for repo ${target}; move it with: mesh items retarget ${lineage} ${fp} --repo ${target}`
     (deduped by `w.heldNoted` key `${step.id}\0${target}`), count skipped, **return** (nothing
     opens). Any open → `moveStep(w, wg, S, target, { user: wg.owner, … })` for it and **return**
     (the move opens the home step; rules 3-5 do not run again). By the invariant there is at most
     one open-or-held foreign step per topic; held is checked before open.
  3. **Hash clash** (RL-9): a step at `homeId` with another `finding` → note, skipped, return.
  4. **Gate** (kind `sink`/`backfill` only, and only before a create, revive or reopen): every
     *closed* finding step of `(lineage, fp)` in the loaded goals of the topic (home or foreign,
     moved-away included; goals that are `dropped` are not loaded, see choice 3) must pass
     `filedAfterClose(step, row, item.accepted)`; with no finding step at all, pass. Fail →
     skipped, return.
  5. **Home step by what exists**:
     - none → **create** (RL-9 rule 2 fields; `repo: target`; `fixCycles: 0`); `home.added`;
       touched `deps: o.kind === "sink" ? "replace" : "none"`.
     - moved-away → **revive**: `revived(cur, item, target, now)` = `{ ...cur, state: "blocked", repo: target, title, severity, brief, deps: [], updatedAt: now }`
       minus `movedTo`, `summary`, `outcome`, holder fields, `claimedAt`, `pausedAt`,
       `roundStartedAt`, `parkedReason`, `parkedAt` (and an `accepted` offer, as
       `reopenedFinding`); notes and `rounds` kept; `fixCycles` unchanged. Event `step.reopened`
       `{ by: o.user, reason: "moved", fixCycles, from: w.from }` (choice 1), note
       `refiled by ${w.from}`; `home.reopened`; touched `deps: o.kind === "sink" ? "replace" : "none"`.
     - live and `done`/`dropped` → kind `sink`/`backfill`: **reopen** as RL-9 rule 3
       (`reopenedFinding`, title, severity, brief rebuilt, note `refiled by …`, reason `refiled`,
       `home.reopened`, touched `deps: sink ? "add" : "none"`). Kind `revert`: only a `dropped` home
       → `reopenedFinding` with deps unchanged, note `reverted by ${o.revertFrom}`, reason
       `reverted`, `from: o.revertFrom`, `by: o.user` (RL-9 `reopenFinding` behaviour; no title or
       brief rebuild, as today).
     - live and `skipped` → skipped (as RL-9; finding steps are never skipped).
     - live and open → kind `sink`/`backfill`: RL-9 rule 4 (title/severity/brief update when they
       differ), skipped. Held → note `refiled by ${w.from} (${severity})`, skipped.
     For kind `revert`, anything other than a live `dropped` home (none, moved-away, open, held,
     `done`) → nothing (spec: "With no home step, or a moved-away one, nothing is reopened").
- `private async moveStep(w, A: WorkGoal, S: Step, n: string, o: { user: string; item: ItemRow })` → `string | undefined` (the new id):
  1. `t = A.topic`; `!(await this.store.getTopic(t))` → note on `S`
     `move to ${n} skipped: topic ${t} is not defined`, push the same text to `w.resultNotes`,
     return undefined. Else `await loadTopic(w, t)`; `B = workGoal(w, n, t, A.owner)`.
  2. Home step `H` (`${B.gid}.${findingStepId}`), no gate:
     - none → create with the item's title/severity/brief, `repo: n`, `fixCycles: S.fixCycles`;
       note `moved from ${S.id}`;
     - moved-away → revive (as above), note `moved back from ${S.id}`, reason `moved`;
     - live closed (`done`/`dropped`/`skipped`) → `reopenedFinding` + item fields, `repo: n`
       (`fixCycles + 1`), note `moved from ${S.id}`, reason `moved`;
     - live open or held → unchanged, note `moved from ${S.id}` (choice 5; unreachable by the
       invariant).
     Touched `deps: "replace"` with `requires = await itemRequires(lineage, fp)` (unless unchanged
     in the last case). `B.added.push(H)` (move step 5: moved steps listed under `added`).
  3. `S` → `{ ...S, state: "dropped", movedTo: H, summary: moved to H, updatedAt: now }` in `A`;
     event `step.dropped { reason: "moved", to: H, by: o.user }` (user `o.user`); every step of `A`
     whose `deps` include `S.id` gets note `dep ${S.id} moved to ${H}`. Offers: handled by
     `endOffersLeavingReady` at write (S leaves `ready`). `A` is otherwise left as it is.
  4. `o.user`: the retarget caller, else `A.owner` (spec "Events of a move carry user").
- `private finishWork(w)`: (a) deps phase = RL-9 rule 5 per touched entry, within its own
  `WorkGoal`, once every placement of the call exists (so a dep on a step created or moved in the
  same call resolves): `replace` starts from `[]`, `add` from the current deps, `none` skips. The
  candidate search ignores moved-away steps (`all.get(own)` must be live; the single-candidate scan
  filters `!movedTo`). Notes `requires <fp>: not in this goal` / `ambiguous` / `cycle` as RL-9,
  `closesCycle` over the goal's in-memory deps. (b) per `WorkGoal` with changes:
  `settle([...all.values()], now, () => true).changed` merged into `changed` (this unblocks `A`'s
  dependants of a moved step and sets created/revived/reopened steps `ready` or `blocked`).
- `private async writeWork(w): Promise<Map<string, string>>` (gid → real id):
  1. Placeholder goals with `added`/`reopened` non-empty, **sorted by repo then topic**, are opened
     exactly as RL-9 `writeSink` step 1 (title `Clean audits: ${topic} on ${repoName(repo)}`,
     owner, `sink`, plan v1 without steps, `goal.created`). A placeholder with no added/reopened
     step is never opened (and has no changed step: a held stop or failed gate writes nothing to it).
  2. `id: IdText` maps `<new:N>.` prefixes to the real goal ids; map `id`, `goal`, `deps`,
     `movedTo` of every changed step (a moved-away step in `A` points into `B`).
  3. Per goal (existing goals first in gid order, then new ones): `endOffersLeavingReady(existing,
     changed, now)`, `saveSteps`, `emitOffersEnded({ userId: <the event user> })`.
  4. Queued `step.dropped` (moved) events, then notes (`addNote` + `step.noted`, `user` = the
     note's user), then `step.reopened` events (payload `{ by, reason, fixCycles, from }`).
  5. `emitReady` for each changed step that is `ready` now and was not before (both goals).
  6. One `goal.sunk` per goal with `added` or `reopened` non-empty: `user` = goal owner, `step` =
     `w.fromStep` when set, payload `{ goal, from: w.from, added, reopened }` (RL-9 payload).
- `private renderDry(w, form: "sink" | "retarget"): IdText`: a placeholder id renders as
  `<new>.<local>` for the sink/backfill (RL-9's dry-run form, kept) and as
  `new:${repo}/${local}` for the retarget (spec).

Order of events matches RL-9 `writeSink` (created → saved → offers → notes → reopened → ready →
sunk) with the moved `step.dropped` added after the save, so a single-goal sink emits exactly what it
emits today.

**B5. Sync (closing rows and the revert reopen).**
- `syncDisposition`, `syncFold`, the `accepted`-reverted branch of `syncRevert`: unchanged logic,
  lookups through `findingStepsOf` over **every** clean-audit goal, live only (B3). In
  `submitReview` the `sinkGoals` prefetch becomes `cleanAuditGoals()`; in `syncFold` the `goals`
  read the same.
- `syncRevert`'s reopening branch (`dismissed`/`deferred` reverted, item filed again): replace the
  loop over `reopenFinding` with: `topics` = the topics of the non-dropped clean-audit goals holding
  a finding step of `(lineage, fp)` (any state); for each topic: `w = new Work(from: debriefStep)`,
  `loadTopic`, `placeHome(w, { row: next, … }, topic, { kind: "revert", user: by, revertFrom: debriefStep })`;
  then `finishWork`, `writeWork`. Only a live `dropped` home step reopens; a dropped step in another
  goal stays dropped; a held foreign step stops it with the `filed for repo …` note; an open foreign
  step is moved (the move reopens the home step, reason `moved`). The note `reverted by <debrief>`
  and event reason `reverted` stay (RL-9 test `sink-hub.test.ts` ~614).
- Delete `reopenFinding` once nothing calls it.

**B6. Sink and backfill (`runSink`, `sinkItems`).**
- `runSink`: pre-check and `filedItems(lineage, relayGoal.id)` unchanged. Then
  `w = new Work(from: sinkStep.id, fromStep: sinkStep.id)`; `loadTopic(w, topic)`; for each item in
  `byItemOrder`: `placeHome(w, item, topic, { kind: "sink", user: <home goal owner>, ownerIfNew: relayGoal.ownerId })`;
  `finishWork`; `writeWork`. Groups by target repo fall out of `placeHome` (each item's home goal is
  `(targetRepo, topic)`); there is one `goal.sunk` per goal that got added, moved or reopened steps.
- `sinkItems`:
  1. `topic = sinkTopic(b.topic)` (400s unchanged).
  2. `items = filedItems(b.lineage)` (all filed items, no goal filter).
  3. Permission: admin, `newestGoalOf(lineage)?.ownerId`, or the owner of any existing
     `cleanAuditGoal(r, topic)` for `r` in `{ lineageRepo(lineage) } ∪ { targetRepo(i.row) for i in items }`;
     else 403 with RL-9's text (`… or of ${goalOfLineageRepo?.id ?? "the clean-audit goal"} …`).
  4. `selected` = items at or above `min_severity`. `w` with `from: "mesh items sink"`, no
     `fromStep`; `placeHome(..., { kind: "backfill", user: actor.userId (goal owner for existing goals, as RL-9), ownerIfNew: actor.userId })`.
  5. Result: `repos` = distinct `targetRepo` of `selected`, sorted (`cmp`). `goals` = per repo:
     `wg = byKey(repo, topic)` → `{ goal: <real id> | (dry run or never opened) null, repo, added, reopened }`
     (ids rendered by `writeWork`'s map, or `renderDry(w, "sink")` on a dry run).
     `goal` = `goals[0].goal` when exactly one entry; with none,
     `cleanAuditGoal(lineageRepo, topic)?.id ?? null`; with several, `null`. `added`, `reopened` =
     unions in entry order; `skipped` = `w.skipped`; `notes` = every rendered note text of the call.
  6. `dry_run`: decide (B4 up to `finishWork`), render, return; nothing written, no `createGoal`.

**B7. Fold (`submitReview`).**
- Two repos for one fp: after the two record-level problems and before the disposition checks,
  when `raising`: for each fp in `uniqueFps(items)` order, `repos = [...new Set(items.filter((i) => i.fp === fp).map((i) => i.repo ?? lineageRepo(lineage)))]`;
  `repos.length > 1` → `problems.push(\`item ${fp} is listed for more than one repo (${repos.join(", ")}); put the repo in its key\`)`.
  It then goes out in the existing 422 `the review record has N problem(s): …`; nothing is stored
  (the throw is before any write). One repo listed twice keeps RL-2's "first kept".
- Row: in the per-fp loop, both branches get `...(it.repo !== undefined ? { repo: it.repo } : {})`
  after the other fields (`row` branch: `{ ...row, …, ...(it.repo ? { repo } : {}) }` so a missing
  `repo` keeps the row's). Collect `retargeted.push({ fp, from: targetRepo(row), to: targetRepo(next) })`
  when `row` exists and the two differ (a new row has no previous target: no event).
- Fold move: after the `for (const fp of f.resolved)` loop and **before** `syncFold`:
  `if (retargeted.length) await this.foldMove(goal, step, lineage, retargeted, actor.userId, now)`:
  - per item: event `item.retargeted` (`user: actor.userId`, `goal: goal.id`, `step: step.id`,
    payload `{ lineage, fp, from, to, by: actor.userId }`);
  - `w = new Work(from: step.id, fromStep: step.id)`; load the topics of every non-dropped
    clean-audit goal holding a live finding step of the item; then exactly retarget step 3 (B8
    `retargetSteps`) with `user` = each step's goal owner (`A.owner`) and the held note
    `retarget to ${to}: release the step, then run the retarget again`; `finishWork`; `writeWork`.

**B8. Retarget (`retargetItems(actor, b: RetargetRequest): Promise<RetargetResult>`).**
1. Before the transaction: `(b.fps ? 1 : 0) + (b.all ? 1 : 0) !== 1 || (b.repo !== undefined ? 1 : 0) + (b.from_key_path ? 1 : 0) !== 1`
   → `HubError(400, "retarget needs fps or all, and repo or from_key_path")`.
2. In `goalTx`: `rows = listItems(lineage)`; none → 404 `no items in ${lineage}`. `fps` (deduped,
   request order): first unknown → 404 `unknown item ${fp} in ${lineage}`.
3. Permission: admin, `newestGoalOf(lineage)?.ownerId`, or the owner of a non-dropped clean-audit
   goal that holds a live finding step of the lineage (scan `cleanAuditGoals()` steps for
   `finding.lineage === lineage && !movedTo`); else 403
   `only an admin, the owner of the lineage's newest goal or of a clean-audit goal with its steps can retarget ${lineage}`.
   (Order 400 → 404 → 403: choice 6.)
4. `selected` = the `fps` rows in request order, or every row in `byItemOrder` for `all`.
5. Per item: new target `to` = `b.repo` or `keyPathRepo(row.path)` (left out with
   `<fp>: no key path` / `<fp>: key path ${path} is not a repo name` in `notes`; no step 3).
   `to !== targetRepo(row)` → `rows to save: { ...row, repo: to }`, `items.push({ fp, from, to })`,
   queue `item.retargeted` (`user: actor.userId`, payload `{ lineage, fp, from, to, by: actor.userId }`,
   no goal). **No item history entry.**
6. `retargetSteps(w, row, to, user)` (shared with B7): every live finding step of `(lineage, fp)`
   in a non-dropped clean-audit goal, not closed, whose goal's `sink.repo !== to`, in gid order:
   open → `moveStep(w, A, S, to, { user })`, `moved.push({ from: S.id, to: <new id> })` when it
   moved; held → note `retarget to ${to}: release the step, then run the retarget again` (once per
   call), `held.push(S.id)`. Runs whether or not the target changed.
7. `finishWork`. `dry_run` → render with `renderDry(w, "retarget")`, return, nothing written.
   Else: `saveItem` per changed row, the `item.retargeted` events, `writeWork`, render with the real
   map, return.

## 2. Choices where the spec leaves room

1. **Event reason of a revive.** The spec's "Event reasons" line says a sink's revive is `refiled`;
   AC-06b says the sink's revive emits `step.reopened` reason `moved` (round-3 S6 named the
   conflict). The plan emits **`moved` for every revive** (a moved-away step coming back is a move
   back) and `refiled` for a sink's reopen of a live closed home step; a sink revive also gets the
   note `refiled by <from>`. AC-06b is the criterion a test is written from. If the combine step
   meets a test that asserts `refiled` for a sink revive, do not edit the test: record the conflict in
   the spec's Open questions and report it.
2. **A revived step's deps** start from `[]` (sink: rule 5 adds; backfill and move: as their rule),
   never its old deps: they point at steps of the goal as it was when it moved away.
3. **The every-close gate** reads finding steps of non-dropped clean-audit goals only (the same
   goals every lookup reads). Including a dropped goal's steps would stop RL-9's "after a
   clean-audit goal is dropped, the next sink opens a new one".
4. **`added` for moves.** A step moved (or moved back) into a goal is listed under that goal's
   `added`, in `goal.sunk` (spec move step 5) and in `SinkResult` (entry and union). A sink's revive
   is listed under `reopened`.
5. **Move into an open or held home step** (unreachable by the invariant, possible with hand-made
   data): `S` is still dropped with `movedTo` the home id and the home step gets the note
   `moved from <S>`; nothing else changes on it.
6. **Retarget check order**: 400 (schema, then one-of), 404 lineage, 404 fp, then 403. Any member can
   already read items (`GET /v1/items`), so the 404 tells nothing new, and a caller who owns the
   relay can see 404 for a typo instead of 403.
7. **`RetargetResult.notes`** holds only the item notes (`<fp>: no key path`, `… is not a repo
   name`) and skipped moves (`move to <n> skipped: topic <t> is not defined`); the routine notes on
   steps (`moved from …`, `dep … moved to …`, `requires …`) are not repeated there. `held` and
   `moved` carry the rest. `SinkResult.notes` keeps RL-9's meaning (every note text the call wrote).
8. **Retarget order**: `fps` in request order (deduped); `--all` in `byItemOrder`. Within an item, its
   steps in goal-number order.
9. **Owner of a goal opened by a move**: `A`'s owner (spec move step 1), also inside a sink or
   backfill; a goal opened by a sink's create keeps RL-9's owner (the relay goal's owner; the caller
   for a backfill).
10. **Who is `user` on a sink placement** (create, reopen, revive, rule-4 notes): the home goal's
    owner, as RL-9 (`writeSink` used the clean-audit goal's owner). On a move: B4 `moveStep` o.user.
11. **The `(lineage, fp)` held-note dedupe** ("once per call") keys on step id and target.
12. **Revert topics**: the topics of the non-dropped clean-audit goals holding any finding step of
    the item; per topic, only the home step is a candidate. RL-9 choice 9 (no pointer from step to
    disposition; a dropped step at revert time was dropped by that disposition) still applies.
13. **`mesh show`**: only the counts change (moved-away steps left out). A moved-away step stays in
    the `dropped:` line of its goal (it is `dropped`); no new line, so existing snapshots stay.
14. **`item.retargeted` activity text**: `retargeted item <fp> to <to>` (fp and repo only, as the
    RL-2 item texts carry fps and no titles).

---

## AC-01 Items of one run land in their target repos' goals

**Files.** `src/protocol/review.ts`, `src/core/finding-step.ts`, `src/hub/service.ts`.

**Changes.**
- B1 (`ReviewItem.repo`, `ItemRow.repo`), B2 (`targetRepo`), B4, B6 (`runSink`).
- The fold stores `repo` on new rows (B7 row change), so `filedItems` rows carry the target.
- `placeHome` puts A in `(x, ci)`, B in `(y, ci)`, C in `(r, ci)`; three placeholders, opened in
  repo order (`r`, `x`, `y`) by `writeWork`; each created step has `repo` = its target and the RL-9
  id `f-<hash(lineage|fp)>`; one `goal.sunk` per goal.

**Order.** After B1-B4.

**Blast radius.** Every sink run. For an item without `repo` the home goal is the lineage repo's, so
RL-9 behaviour is unchanged (one goal, same ids, same events in the same order).

**Risks.**
- `writeWork` opens up to N goals in one transaction (`store.createGoal` nests a `tx` inside
  `goalTx`, as RL-9's single open already does). Goal numbers are allocated in repo order; nothing
  else may depend on which goal gets the lower number.
- The refactor of `decideSink`/`writeSink` into the work routines is the biggest regression risk of
  RL-10: notes text, `skipped` counts, `byItemOrder` creation order, the `goal.sunk` payload and the
  emit order must stay as RL-9. Run the RL-9 sink test files after B4, before anything else.

## AC-02 Repo stored on the row, kept, capped

**Files.** `src/protocol/review.ts`, `src/hub/service.ts` (`submitReview` row), `src/cli/review-commands.ts`.

**Changes.**
- B7 row: set `repo` when the item has it, else keep the row's.
- `mesh items` table (`itemsCommand`): path column = `${i.path ?? "-"}` and, when
  `i.repo !== undefined && i.repo !== lineageRepo(lineage)`, `${i.path ?? "-"} → ${i.repo}`
  (`lineageRepo` from `../core/index.ts`). `--json` prints the hub reply, which has `repo` once B1
  is in.
- A later record raising A without `repo`: the row keeps `repo: "x"`, the target does not change, no
  fold move; `file`'s sink finds A's home step in `x` open (rule 4).
- 301 characters → `ReviewItem` max 300 → the app's 400 before the service.

**Order.** After B1.

**Blast radius.** Every raising record (one more field copied); `mesh items` output only for rows
whose target differs from the lineage repo.

**Risks.**
- `next = { ...row, … }` already keeps unknown-to-the-fold fields; the explicit spread must not set
  `repo: undefined` (the `ItemRow.parse` in `saveItem` would accept it, but a later
  `toStrictEqual` on rows written without `repo` would see the key). Write it only when present.
- `.trim()` in a zod 4 schema is a check, not a transform that breaks `z.toJSONSchema({ io: "input" })`;
  verify `pnpm schemas` still produces the OpenAPI document without an `unrepresentable` fallback.

## AC-03 One fingerprint, two repos

**Files.** `src/hub/service.ts` (`submitReview`).

**Changes.** B7 "two repos for one fp". The repo of an item without `repo` is the lineage repo, so
`x` + absent is two repos `(x, r)`, and `r` + absent is one. The fingerprint (`fingerprint(i.key)`)
never reads `repo`, so a later run raising A's key without `repo` gets mark `repeat` from
`foldItems` unchanged.

**Order.** With B7.

**Blast radius.** Raising records that list an fp twice (today silently first-kept).

**Risks.** The problem must be pushed before the `if (problems.length) throw` and before any
`saveItem`; the existing structure already throws before the fold, so nothing is stored. The text is
one entry of the existing message, so the 422 body is `the review record has 1 problem(s): item …`.

## AC-04 Resolved and dismissed sync across repos

**Files.** `src/hub/service.ts` (B3 `cleanAuditGoals`, `findingStepsOf`; B5).

**Changes.** The closing rows look in every non-dropped clean-audit goal (not only the lineage
repo's) and skip moved-away steps. A resolved by a later complete record → A's step in the `x` goal
`done` (`resolved by …`); B dismissed later → B's step in `y` `dropped`.

**Order.** After B3.

**Blast radius.** Every complete raising record and every dismissal/deferral/revert whose lineage has
clean-audit goals: the scan is now over all clean-audit goals of every repo (`getStep` per goal per
fp).

**Risks.** Cost: `syncFold` does `goals × fps` `getStep` calls inside the record's transaction. With
tens of clean-audit goals and a 500-item record that is thousands of point reads. Acceptable for the
expected sizes (one goal per repo × topic); if it shows up, build a per-call index from one
`listSteps({ goal })` per goal (the work's `loadTopic` does that already) instead of changing the
contract.

## AC-05 Fold move

**Files.** `src/hub/service.ts` (B7 `foldMove`, B4 `moveStep`, `finishWork`, `writeWork`).

**Changes.**
- D's row gets `repo: "x"` in the fold; `retargeted` has D (`r` → `x`); `item.retargeted` emitted.
- `retargetSteps`: D's step in the `r` goal is open → `moveStep`: home in `(x, ci)` is new
  (placeholder) → created with D's title/severity/brief, `repo: x`, `fixCycles` of the old step,
  note `moved from <old id>`; the old step `dropped`, `movedTo`, summary `moved to <new id>`, event
  `step.dropped { reason: "moved", to, by }`; E (a dependant in `r`) gets the note
  `dep <old id> moved to <new id>` and `settle` makes it `ready` (a dropped dep is satisfied).
- D's new step deps: `itemRequires(D)` resolved in `x` (none), so `ready`.
- `goal.sunk` on the `x` goal with `from` = the audit step id, `added: [<new id>]`.
- No sink is needed: it runs in `submitReview`.

**Order.** After B4. Inside `submitReview`: after the item rows and the resolved rows are saved,
before `syncFold` (so `syncFold` and the dispositions see the moved steps).

**Blast radius.** Raising records whose items change target (only when an auditor starts or changes
`repo`, or a retarget set a repo and the auditor now sends another).

**Risks.**
- The fold move writes into a clean-audit goal from inside the audit step's `submitReview`; a store
  error fails the record (as RL-9's sync). No sink reason fails it: an undefined topic is a note.
- AC-05's record must raise E too (coverage complete): if E were left out it would be resolved by the
  same fold after the move (round-3 S1). The implementation is right either way.
- E's note text names the real new id: the note is rendered at write time (B4 thunks), after the `x`
  goal exists.

## AC-06 Held steps, moving back, revert after moves

**Files.** `src/hub/service.ts` (B4, B5, B7, B8), `src/hub/app.ts`, `src/cli/review-commands.ts`.

**Changes.**
- Fold with D `claimed` in `r`: `retargetSteps` → held → note `retarget to x: release the step, then
  run the retarget again`. `file` refiles D → `placeHome`: foreign held → note
  `filed for repo x; move it with: mesh items retarget <lineage> <fpD> --repo x`, nothing opens, no
  `x` goal is opened (no added/reopened in that placeholder).
- Release (existing route) → `ready`; `mesh items retarget <lineage> <fpD> --repo x` → target
  unchanged (`x`), `items` empty, step 3 moves the `r` step (create in `x`).
- `--repo r` → target `x` → `r` changes, `items` lists D; step 3: the `x` step (open, goal repo `x`
  ≠ `r`) → `moveStep` into `(r, ci)`: the home id is the moved-away `r` step → revive (`movedTo`
  cleared, notes kept, note `moved back from <x id>`, reason `moved`); the `x` step becomes
  moved-away.
- Later run, debrief dismisses D → `syncDisposition` drops the live `r` step only (the `x` step is
  moved-away). Revert → B5: topics with a finding step of D: `ci`; home `(r, ci)` live `dropped` →
  reopened (reason `reverted`); the `x` step stays `dropped`.

**Order.** After B4, B5, B8.

**Blast radius.** Held finding steps get notes they did not get before (fold, sink).

**Risks.**
- A revive must not clear the step's notes (they are separate rows, `addNote`) nor `rounds`.
- `isRevertable` reads the item's last history entry; the fold move and the retarget write no item
  history, so the debrief's dismissal stays revertable.

## AC-06b Revive by sink; move into a live closed home

**Files.** `src/hub/service.ts` (B4).

**Changes.**
- D moved `r` → `x`, the `x` step `done` by a person. Later run raises D with `repo: r`: fold target
  `x` → `r`, `item.retargeted`; `retargetSteps` finds no live, not-closed step outside `r` (the `x`
  step is `done`, the `r` one moved-away). `file` refiles D → `placeHome` (sink): no foreign open or
  held step; gate: the moved-away `r` step (closed at the move) and the `x` step (closed when done)
  are both older than the new `accepted` → home (`r`) is moved-away → revive (`ready`, `movedTo`
  cleared, `step.reopened` reason `moved`, choice 1), no new id; the `x` step stays `done`.
- Retarget D to `x` → step 3 moves the `r` step: home in `x` is live `done` → reopened
  (`fixCycles + 1`, note `moved from <r id>`, reason `moved`); the `r` step moved-away again.

**Order.** With B4.

**Blast radius.** None beyond B4.

**Risks.** `filedAfterClose` compares with `updatedAt`; a moved-away step's `updatedAt` is the move
time and its last close event is the `step.dropped` (reason `moved`), so the same-millisecond
tie-break works unchanged. The test clock (`tick`) separates them anyway.

## AC-06c One open step per item

**Files.** `src/hub/service.ts` (B4 foreign-first).

**Changes.** D's step `claimed` in `r`, its live home step in `x` `done`; a later run raises D with
`repo: x` (fold: held → retarget note) and files it → `placeHome` checks foreign first: held → the
`filed for repo x; …` note and return, before the gate and before rule 3 on the `x` step. The `x` step
stays `done`.

**Order.** With B4.

**Blast radius / risks.** The order inside `placeHome` (foreign check before the gate and the home
step) is the whole of this criterion; keep it as one function so no caller can skip the check.

## AC-06d Sink move

**Files.** `src/hub/service.ts` (B4, B6, B8).

**Changes.** D `claimed` in `r`; retarget to `x` sets the row and lists the step in `held`; release;
a later run raises D without `repo` (target stays `x`, no fold move); `file` refiles D →
`placeHome`: foreign open (`r`) → `moveStep` into `(x, ci)` (create), `r` step moved-away. One live
open step, in `x`.

**Order.** With B6.

**Blast radius.** Every sink of an item whose target differs from where its open step is.

**Risks.** The move is not gated (spec): a sink of an item filed long ago still moves its open
step. `goal.sunk` on the `x` goal carries `from` = the sink stage id and lists the moved step under
`added`.

## AC-06e Revert reopens only the home step; backfill keeps finished work

**Files.** `src/hub/service.ts` (B5, B6).

**Changes.**
- D's `r` step dismissed (live `dropped`). Retarget to `x`: nothing to move (closed). A later run
  files D → `placeHome`: no foreign open/held; gate: the `r` step closed before the new `accepted` →
  create in `x`.
- A debrief dismisses D (`x` dropped); revert → B5 per topic `ci`: home `(x, ci)` live `dropped` →
  reopened (`reverted`); the `r` step is not home → stays `dropped`.
- Person finishes the `x` step; backfill → `placeHome` (backfill): home `x` live `done`; gate: the
  latest `accepted` is older than the `x` close → skipped; nothing created in `x` or `r`.

**Order.** After B5, B6.

**Blast radius.** Every revert of a debrief dismissal/deferral of a filed item.

**Risks.** RL-9 reopened every `dropped` step of the item (in the lineage repo's goals). The new rule
reopens at most one per topic. An RL-9 test reverting with one step per item is unchanged.

## AC-07 Retarget by repo

**Files.** `src/protocol/hub.ts`, `src/protocol/hub-api.ts`, `src/hub/service.ts` (B8),
`src/hub/app.ts`, `src/cli/review-commands.ts`.

**Changes.**
- `app.ts`, next to `/v1/items/sink`:
  `r("POST", "/v1/items/retarget", "member", async (c, a) => c.json(await svc.retargetItems(a, await body(c, RetargetRequest))), "goals:write")`.
- B8. F (open) → moved; G (`claimed`) → note, `held`; both rows `repo: x`; one `item.retargeted`
  each (`user` = caller); no `addItemHistory`. Second call after G's release: `items` empty, G moved.
- Dry run: B8 decides through `finishWork`, renders with `renderDry(w, "retarget")`; with the `x`
  goal existing every id is real, so the reply equals the first real call's. No `saveItem`, no
  event, no note.
- CLI `itemsRetarget(c, args, usage)` (dispatched when `args[0] === "retarget"`, before the
  positional parse): `parseArgs(args, ["repo"])`; `lineage = positional[0]`, `fps = positional.slice(1)`;
  usage errors (exit 2, usage on stderr, no request): no lineage; `fps.length > 0` === `has("all")`;
  `has("repo")` === `has("from-key-path")`; `has("repo") && !str("repo")`. Body
  `{ lineage, ...(fps.length ? { fps } : { all: true }), ...(repo ? { repo } : { from_key_path: true }), ...(dry ? { dry_run: true } : {}) }`.
  Output: `${dry ? "would retarget" : "retargeted"} ${r.items.length} items; moved ${r.moved.length} steps; held ${r.held.length}`,
  then `${m.from} → ${m.to}` per move, `held: ${id}` per held, `note: ${n}` per note.
  `HubCallError` → stderr, exit 1. Usage text gains
  `mesh items retarget <lineage> (<fp>… | --all) (--repo <r> | --from-key-path) [--dry-run]`; the
  command summary mentions `retarget`.

**Order.** Protocol row and route together (the served = documented test); service before CLI.

**Blast radius.** One new route, one CLI branch. `mesh items <lineage>` unchanged (a lineage has
`|`, a step id has `.`; neither is `retarget`).

**Risks.**
- A held step must never be moved (`retargetSteps` checks the state from the loaded goal steps of
  this transaction; a concurrent claim is serialised by `goalTx`).
- The dry run must not call `createGoal` (it allocates a goal number) nor `loadTopic` side effects
  (reads only).

## AC-08 Retarget from key path

**Files.** `src/core/finding-step.ts` (`keyPathRepo`), `src/hub/service.ts` (B8 step 5).

**Changes.** `--all --from-key-path`: H (`path: x`) → `x`, I (`path: y`) → `y`, each moved to the
goal of its target (two placeholders opened in repo order); J, K, L left out with their notes (in
`notes`, in item order). CLI first line `retargeted 2 items; moved 2 steps; held 0`.

**Order.** With AC-07.

**Blast radius.** None beyond AC-07.

**Risks.** `src/a.rs` contains `/`; `a.ts` ends in `.ts`; a dotted repo name such as `x.y` would be
refused when its last segment is 1-5 letters or digits (spec rule, accepted). `group/x` is reachable
only with `--repo` (spec).

## AC-09 Retarget checks

**Files.** `src/hub/service.ts` (B8 steps 1-3), `src/protocol/hub.ts`, `src/cli/review-commands.ts`.

**Changes.** As B8 and the CLI usage rules in AC-07. `fps: []` fails `min(1)` (the schema's 400).
Refusals throw before any write; the one-of 400 is thrown before `goalTx`.

**Order.** With AC-07.

**Blast radius.** None beyond AC-07.

**Risks.** Choice 6 (check order). The 403 text is the plan's (the spec fixes only the status).

## AC-10 Backfill grouped by target repo

**Files.** `src/hub/service.ts` (B6 `sinkItems`), `src/protocol/hub.ts` (`SinkResult.goals`),
`src/cli/review-commands.ts` (`itemsSink`).

**Changes.**
- B6. Dry run on a lineage with targets `x` (2) and `r` (1), no goals → entries `r` (`goal: null`,
  `added` 1) and `x` (`goal: null`, `added` 2); top-level `goal: null`.
- `itemsSink` output: with `r.goals.length <= 1`, exactly RL-9's line; else one line per entry
  (`goals` order): dry `would add ${e.added.length} to ${e.goal ?? "a new goal"} (${repoName(e.repo)})`,
  wet `${e.goal ?? "no goal"}: added ${e.added.length}, reopened ${e.reopened.length} (${repoName(e.repo)})`.
  `repoName` from `../core/index.ts`.
- Idempotent: the second call finds both homes open (rule 4) → `added 0, reopened 0` per entry.

**Order.** After B6.

**Blast radius.** `mesh items sink` output only for lineages with two or more target repos; RL-9
lineages print exactly as today.

**Risks.**
- An older CLI against a 0.1.28 hub prints the top-level line (`no goal: …` when several entries):
  acceptable, the hub ships first.
- The RL-9 dry-run ids keep the `<new>.` prefix (RL-9 test `test_AC15_dry_run` accepts it); two new
  goals' ids look alike in the union and are told apart by `goals`.

## AC-11 Deps stay within a goal

**Files.** `src/hub/service.ts` (B4 `finishWork` deps phase).

**Changes.** M (`x`) requires N (`y`): both placed first; the deps phase looks for N's step in `x`
only → note `requires <fpN>: not in this goal`, M `ready`. N also `x`: own id in `x` (in memory) →
dep, M `blocked`.

**Order.** With B4.

**Blast radius.** None beyond RL-9 rule 5, now per goal of the work.

**Risks.** The deps phase must run after every placement of the call (as RL-9's `touched` loop), or
M's dep on N would depend on item order.

## AC-12 Docs, events, skill, schemas

**Files.** `docs/guide/concepts.md`, `docs/guide/scheduled-reviews.md`, `docs/events.md`,
`docs/plan/implementation-plan.md`, `docs/guide/operations.md`, `src/protocol/skill.ts`
(`MESH_SKILL`), `skills/mesh/SKILL.md` (generated), `src/protocol/tools.ts`,
`schemas/hub-api.openapi.json` (generated), `src/hub/service.ts` (`describe()`).

**Changes.**
- `concepts.md` `## Clean-audit goals`: a **Target repo** paragraph (item `repo`; target = `repo` or
  the lineage repo; the clean-audit goal and the step's `repo` follow it; one fp with two repos is
  422, keep the repo in the key) and a **Moves** paragraph (fold move, retarget, sink move; moved-away
  steps with `movedTo`, `moved to …` / `moved from …` / `moved back from …`, dependants notes; held
  steps get a note and stay; only one live open step per item and topic; revert reopens only the home
  step; `mesh items retarget`). Update "Backfill" (grouped by target repo, one line per goal).
  Keep every paragraph the RL-9 docs test reads (`sink`, severity order, `requires`,
  `mesh goal drop`).
- `scheduled-reviews.md` `## Clean-audit goals`: a subsection or bullets "Auditors that check other
  repos": set `repo` on each item and keep the repo in the key (`path` or `symbol`); when an auditor
  starts sending `repo`, the next record moves the open steps; `mesh items retarget <lineage> --all
  --from-key-path --dry-run` for items not raised again (dry run first), `--repo` for one item or a
  `group/x` repo. Generic names only (`demo`, `r`, `x`, `ci`, `ann`).
- `docs/events.md`: new row `item.retargeted` (`user`; payload `lineage`, `fp`, `from`, `to`, `by`;
  emitted by the fold and `mesh items retarget`); `step.dropped` reasons add `moved` with `to`;
  `step.reopened` reasons add `moved` (a move, a move back, a revive) with `from`; keep the RL-9
  paragraph that has `step.reopened`, `refiled` and `reverted` together; `goal.sunk` lists moved
  steps under `added`.
- `docs/plan/implementation-plan.md` API table: row `POST /v1/items/retarget` (`(v0.1.28)`,
  members: admin, the owner of the lineage's newest goal or of a clean-audit goal with its steps;
  scope `goals:write`); the `/v1/items/sink` row mentions the per-repo `goals`.
- `operations.md` "Upgrading to 0.1.27" paragraph: one sentence for 0.1.28 (hub first, then the
  daemons of the auditor machines, then the auditors add `repo`). Keep the heading (two links pin
  `#upgrading-to-0127`).
- `MESH_SKILL` "Review records": items may carry `repo` (the repo the finding is about), keep the repo
  in the key; CLI table row `mesh items retarget <lineage> <fp>… --repo <r>`. Regenerate
  `skills/mesh/SKILL.md` with `pnpm schemas`.
- `describe()`: `step.dropped` reason `moved` → `${s} moved to ${String(payload.to)}`;
  `step.reopened` reason `moved` → `${s} reopened: its finding was moved here (fix cycle n)`;
  `item.retargeted` → `retargeted item ${fp} to ${to}`.
- `pnpm schemas` regenerates the OpenAPI document (route, `repo`, `RetargetRequest`) and the skill;
  the ledger schemas and `hub-event.json` are not expected to change (`Step.movedTo` is not a ledger
  field).

**Order.** After the code; `pnpm schemas` last.

**Blast radius / risks.** `test/docs-rl9.test.ts`, the RL-7/RL-8/RL-6 docs tests and the skill
equality tests read the same files: edit around their strings, never remove them. No team-, company-
or person-specific names.

## AC-13 Version and checks

**Files.** `package.json`, `test/schemas.test.ts` (the two version pins only).

**Changes.** `"version": "0.1.28"`; `pnpm schemas`; `pnpm check` (lint, typecheck, boundaries, test,
build). `SCHEMA_VERSION` stays 11.

**Order.** Last.

**Risks.** `pnpm boundaries`: the CLI imports `lineageRepo`, `repoName` from core (allowed); core
imports only protocol. The RL-9 test files must pass unchanged (see the AC-01 risk).

---

## Existing tests and snapshots the developer may adjust

Only where the spec changes the asserted behaviour:

- `test/schemas.test.ts` `test_AC16_version` (~line 687) and RL-9 `test_AC19_version` (~line 783):
  `0.1.27` → `0.1.28` (comment "RL-10 AC-13: the release is v0.1.28 (was v0.1.27)"). This is the only
  edit to an RL-9 test; AC-13's "RL-9 tests pass unchanged" cannot cover the version pin the spec
  itself bumps.
- `schemas/hub-api.openapi.json`, `skills/mesh/SKILL.md`: regenerated by `pnpm schemas`, never by
  hand.
- Route list tests: pass once `HUB_API` and `app.ts` both have the row; no edit.
- `test/sink-hub.test.ts`, `test/sink-goals.test.ts`, `test/sink-cli.test.ts`,
  `test/docs-rl9.test.ts`: unchanged. They assert `SinkResult` with `toMatchObject` (the new `goals`
  field does not break them), RL-9's CLI lines (kept for zero or one entry), `<new>.`-or-bare dry-run
  ids (kept), and `step.reopened` reason `reverted` on a revert (kept).
- Tests comparing whole `ItemRow`, `Step` or stored records with `toStrictEqual`: unchanged (`repo`
  and `movedTo` written only when present).
- `src/cli/__snapshots__/show.test.ts.snap`: unchanged (no fixture has a moved-away step; the counts
  change only for those).

No `SCHEMA_VERSION` change, no store contract test change, no web change.

## Risk summary

1. AC-06b's revive reason (`moved`) contradicts the spec's "Event reasons" line (`refiled`); the plan
   follows AC-06b (choice 1). Flag at combine if a test disagrees.
2. Replacing `decideSink`/`writeSink` with the multi-goal work can change RL-9 output in small ways
   (note texts, `skipped`, event order, owners); RL-9 test files are the guard.
3. Placeholder ids leaking into stored text: every id-bearing text is rendered at write time.
4. Lookups now span every clean-audit goal (`goals × fps` reads in the record transaction).
5. A sink, backfill or fold can now write into several goals, and into goals owned by others (allowed
   by the spec), in one transaction; goal numbers for new goals follow repo order.
6. Revert now reopens at most the home step per topic (RL-9 reopened every dropped match).
7. Two version pins in `test/schemas.test.ts` must move to 0.1.28.
