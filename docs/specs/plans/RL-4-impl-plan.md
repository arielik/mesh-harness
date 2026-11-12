# RL-4 implementation plan: Debrief

Spec: `docs/specs/RL-4.md` (revision 2, approved in review round 2). Branch: `feat/relay-design`.
Release v0.1.18. Design: `docs/analysis/2026-11-12-pulse-relay-roster.md` §5.3, §5.6, §5.7, §5.9, §6.

This plan covers the implementation only. It plans no new tests: the test side writes them from the
spec's contracts and never reads this plan. Section 2 lists every existing test and generated file
whose asserted behaviour the spec changes, and nothing else. Section 3 records the choices this plan
makes where the spec leaves room; the spec itself is not changed by this plan. Section 4 has one
section per acceptance criterion (AC-01 .. AC-25): files, changes (functions), migrations, order
constraints, blast radius and risks.

## 0. Overview, build order, shared building blocks

Bottom-up along `.dependency-cruiser.cjs` (`protocol` ← `core` ← `store` ← `hub`;
`protocol`/`core`/`store`/`claude` ← `daemon`; `cli` imports `protocol`, `core`, `claude`). No hub
migration: `SCHEMA_VERSION` stays (new fields live in JSON values; the new store filters use the
existing `step.updated_at` and `item_history.step` columns).

| Stage | Module | Work | Criteria |
|---|---|---|---|
| 1 | `src/protocol` | `review.ts` (`DispositionVia`, `answer`, revert history entry); `goal.ts` (`StepPolicy.mode`/`assignee`, `Step.read`, `Round.read`); `hub.ts` (`DisposeRequest`, `RevertRequest`, `ReadRequest`, result/view interfaces, `ReviewResult.already`); `tools.ts` (`mesh_dispose`); `skill.ts` (`MESH_DEBRIEF_SKILL`, `MESH_SKILL` row); `config.ts` (`claudeDebriefSkill`); `hub-api.ts` (5 rows) | AC-01, AC-16, AC-21, AC-23, AC-24 |
| 2 | `src/core` | `policy.ts`: `policyOf` defaults, `validatePolicies` (effective consumes, 4 messages), `debriefAssignee`, `isDebrief` | AC-02, AC-24 |
| 3 | `src/store` | `hub-store.ts`: `listSteps({updatedSince})`, `listDispositions({steps, since})`, `answer` mapped | AC-25 |
| 4 | `src/hub` | `service.ts`: never-offered guards, assignee claim check, `readStep`, `debriefView`, `debriefs`, `disposeStep`, `revertDisposition`, debrief rules in `submitReview`, `Round.read` at done, debrief inputs in `stepInputs`, `describe()`; `app.ts`: 5 routes | AC-03 .. AC-07, AC-10 .. AC-14, AC-21, AC-22 |
| 5 | `src/daemon` | `tools.ts`: `mesh_dispose`, `mesh_review` reply, `brief()` line; `daemon.ts`: `/local/debriefs`, `/local/revert` | AC-08, AC-09, AC-13, AC-18 |
| 6 | `src/claude`, `src/cli` | `skill.ts` text parameter; `mesh-commands.ts` setup/uninstall/doctor/skill `--debrief`; `client.ts` `debriefs`/`revert`; new `debrief` command; `tui/render.ts`, `tui/tui.ts` | AC-15 .. AC-18 |
| 7 | `web/` | `api.ts`, `mine.tsx`, `goals.tsx`, `styles.css` | AC-19, AC-20 |
| 8 | repo | `scripts/schemas.ts` writes `skills/mesh-debrief/SKILL.md`; docs; `package.json` 0.1.18; `pnpm schemas`; adjust the existing tests of section 2; full check | AC-16, AC-23, AC-24 |

Order constraints (global):
- Stage 1 first; inside it `review.ts` before `goal.ts`/`hub.ts` (`review.ts` stays self-contained,
  imports only `zod`; `hub.ts` imports `DispositionRow`, `ItemView`, `ItemState`, `Disposition` from it).
- Stage 2 before stage 4: the hub's guards call `debriefAssignee`; the stored `Step.policy` must carry
  the debrief defaults (via `policyOf` in `core/dag.ts` `materialize`) before any hub code reads
  `policy.consumes` of a debrief (see risk R1).
- Stage 3 before stage 4 (`GET /v1/debriefs` uses the new filters).
- Stage 5 needs the stage-4 routes for anything beyond compiling.
- Stage 6's `debrief` command needs `GET /v1/steps/:id/debrief` (stage 4) and `runCommand`.
- `pnpm schemas` after the last change to `src/protocol` (`HUB_API`, `StepPolicy`/`PlanStep`,
  `DispositionRow`, `MESH_SKILL`, `MESH_DEBRIEF_SKILL`) and after `scripts/schemas.ts` is extended.
- Docs and the version bump last.

### Shared building blocks (used by several criteria)

**B1. `isDebrief(p)` and `debriefAssignee(p, ownerId)`** (`src/core/policy.ts`, exported through
`src/core/index.ts`, which already re-exports `./policy.ts`). `isDebrief = (p) => p?.mode === "debrief"`.
`debriefAssignee(policy, ownerId)`: `!policy?.assignee || policy.assignee === "@owner" ? ownerId :
policy.assignee`. Pure; no hub/store imports (AC-24 boundary).

**B2. Hub private helpers** (`src/hub/service.ts`, new section `// ---------- debriefs (RL-4) ----------`
after the RL-2 review section):
- `assigneeOf(step: Step, goal?: Goal): Promise<string>`: `debriefAssignee(step.policy, (goal ??
  await this.goalOr404(step.goal)).ownerId)`. Read at every check (never cached across calls), so
  `@owner` follows `goal.ownerId` (AC-04).
- `refuseNonAssignee(actor, step)`: when `isDebrief(step.policy)` and `actor.userId !== assignee` →
  `HubError(403, \`${step.id} is a debrief for ${assignee}; only they can take it\`)`. No admin or
  owner exception.
- `debriefData(step, goal, steps)`: `{ run?, record?, lineage?, items: DebriefItem[], report? }`.
  `run`/`record` from the existing `runRecordOf`; `lineage = lineageOf(goal, run)` when there is a
  run; `items` = `recordItems(record)` filtered by `step.policy.consumes` (always set for a debrief
  after B1/policyOf), sorted with the existing `byItemOrder`, turned into `ItemView` with
  `withHistory`, then extended with `evidence` (from the record's first item with that fp:
  `it.evidence.map(({path, lines}) => ({path, ...(lines ? {lines} : {})}))`, never `note`) and
  `nearMatches` (B3). `report` (B4).
- B3 `nearMatches(row, all: ItemRow[])`: `all` = `store.listItems(lineage)` loaded once per call;
  keep `o.fp !== row.fp && o.rule === row.rule && ((row.path !== undefined && o.path === row.path) ||
  (row.symbol !== undefined && o.symbol === row.symbol && o.path !== row.path))`; map to `{fp, state,
  title, ...(symbol)}`; sorted by `fp` (`listItems` already orders by fp); each row once (a filter
  over distinct rows guarantees that).
- B4 `runReport(run)`: `store.listArtifacts({step: run.id})`, keep `kind === "report"`, take the
  highest `round` that has one, and the last uploaded in it (the store's insertion order / max
  `createdAt`, then id); `content` = `store.getArtifact(id)?.content?.toString("utf8") ?? null`
  (null once `prunedAt`).
- `sessionDecision(lineage, fp, step, n)`: the last of `store.listDispositions({lineage, fp, step:
  step.id})` with `via === "debrief-session" && round === n` (whatever happened since).
- `isRevertable(d: DispositionRow)`: `last = (await store.itemHistory(d.lineage, d.fp)).at(-1)`;
  revertable when `last.kind === "disposition" && last.via === "debrief-session"` and `last.step,
  round, at, disposition, from` equal `d`'s. Callers that hold several rows of one `(lineage, fp)`
  additionally treat only the last such row as a candidate (two rows with identical fields at the
  same ms can then never both be revertable; risk R4).
- `decidedView(d)`: `{...d, title: (await store.getItem(d.lineage, d.fp))?.title ?? "", revertable}`.
- `debriefNote(actor, step, sid, text, at)`: `store.addNote({step, user, ...(sid), text, at})` plus
  event `step.noted` (`user`, `sid`, `goal`, `step`), exactly as `noteStep` does.
- `applyDisposition(lineage, row, d, decider, via, seenAt, answer?)`: the body of the existing
  dispositions loop of `submitReview` extracted unchanged (state, `dismissedEh`, `until`, `link`,
  `saveItem`, `addItemHistory` with `via` and, when given, `answer`), returning the stored
  `DispositionRow`. `submitReview` calls it with `via: "stage"` for non-debrief records (byte-identical
  rows and events, AC-21).
- `dispositionProblem(step, d, runFps, consumes, row, ownLatest)`: RL-2 checks 1, 2, 4 and 6 extracted
  from `submitReview` with their exact texts (`… may not set …`, `deferred needs until (YYYY-MM-DD)`,
  `no item <fp> in the record of <run>`, `item <fp> is <state>; <id> acts on …`); check 3 (`listed
  twice`) and 5 (person precedence) stay inline in `submitReview`. `ownLatest` (dispose route only)
  makes check 6 pass when the item's latest disposition entry is this step's in the current round.

## 1. Files touched (summary)

`src/protocol/review.ts`, `goal.ts`, `hub.ts`, `tools.ts`, `skill.ts`, `config.ts`, `hub-api.ts`;
`src/core/policy.ts`; `src/store/hub-store.ts`; `src/hub/service.ts`, `app.ts`; `src/daemon/tools.ts`,
`daemon.ts`; `src/claude/skill.ts`; `src/cli/mesh-commands.ts`, `client.ts`, `review-commands.ts`
(new `debriefCommand`), `tui/render.ts`, `tui/tui.ts`; `web/src/api.ts`, `mine.tsx`, `goals.tsx`,
`styles.css`; `scripts/schemas.ts`; generated `schemas/*.json`, `schemas/hub-api.openapi.json`,
`skills/mesh/SKILL.md`, new `skills/mesh-debrief/SKILL.md`; `docs/guide/concepts.md`, `howto.md`,
`docs/plan/implementation-plan.md`, `docs/events.md`; `package.json`.

## 2. Existing tests and generated files the spec changes

The developer may adjust only these, and only in the asserted behaviour the spec changes:

| File | Assertion | Change |
|---|---|---|
| `src/cli/tui/render.test.ts:274` | local `OFFERS_FOOTER` constant | New footer text `⏎ accept · d decline · u revert · o back to sessions · details: mesh offers`. |
| `test/m2-flow.test.ts:287-288` | exact sorted MCP tool list (and its comment "no mesh_dispose") | Add `mesh_dispose`; update the comment. |
| `test/review-hub.test.ts:183` | `review.recorded` payload `toStrictEqual` | Gains `already: 0`. |
| `schemas/*.json`, `schemas/hub-api.openapi.json`, `skills/mesh/SKILL.md` | drift check in `test/schemas.test.ts` | Regenerated with `pnpm schemas` (not hand-edited). |
| new `skills/mesh-debrief/SKILL.md` | generated | Written by `pnpm schemas`. |

Checked and **not** affected: `test/relay-daemon.test.ts:315` (`MESH_TOOL_RULES`, unchanged);
`test/review-hub.test.ts:195,553` (`toMatchObject`); `test/review-hub.test.ts:549-550` (`item.disposed`
payload keys unchanged for stage records); `test/review-daemon.test.ts:140,156,161` (no `already`
sentence when `already` is empty); `test/hub.test.ts:116` (`>`); `test/cli.test.ts` help tests
(registration adds `debrief`; they match listed names only); `src/claude/skill.test.ts` (defaults keep
`MESH_SKILL`); `test/m46-ops.test.ts` (no migration). `test/e2e-web/mine.spec.ts:188` asserts
`Nothing is assigned to you.` for a user on the shared e2e hub: it stays valid as long as the new e2e
fixtures do not give that user a debrief (test-side concern, risk R9).

## 3. Plan-level decisions

1. `validatePolicies` runs every check on an **effective** step list in which a debrief without
   `consumes` has `consumes: ["open", "confirmed"]`; this also feeds `runOf` for other steps, so a
   step downstream of a debrief never sees the debrief as a raising step (R1).
2. The gate + debrief rule is checked first in the loop body and `continue`s, so that step gets no
   other error (not even ref or RL-1/RL-2 errors).
3. A debrief record's dispositions add notes through the same helper as the dispose route, so each
   also emits `step.noted` (spec: "adds a note"; the event follows the note route's behaviour).
4. `review.recorded` carries `already` on every record (`0` outside debriefs), matching "gains
   `already: number`".
5. `item.reverted` payload: `{lineage, fp, from, to, round, via: "ui"}`; `from`/`to` are states.
6. `offerStep` is not changed; every caller is guarded (assign, goal assign via `offerableSteps`,
   stick via `emitReady`, pulse `attempt` returns early for a debrief run step as a defensive guard).
7. `GET /v1/steps/:id/debrief` with a run but no record: `run` and `lineage` set, `items: []`.
8. The `debrief` CLI command lives in `src/cli/review-commands.ts` next to `items` and gets `mesh run`
   injected as a callback (as `offerCommands` does), registered in `meshCommands`.
9. The revert route keeps the item row's `last` unchanged (a revert is not a sighting).

## 4. Per acceptance criterion

### AC-01 Schemas

Files: `src/protocol/goal.ts`, `src/protocol/review.ts`, `src/protocol/hub.ts`.

Changes:
- `goal.ts` `StepPolicy.mode`: `z.enum(["interactive", "headless", "debrief"]).optional()`; new
  `assignee: z.union([z.literal("@owner"), z.string().regex(/^[^@\s]\S{0,99}$/, "assignee is a user id
  or @owner")]).optional()` (after `may_set`). `PlanStep` and `POLICY_KEYS` pick it up through
  `StepPolicy.shape`.
- `goal.ts` `Step.read`: `z.object({user: z.string(), at: z.number(), round: z.number().int().min(1)})
  .optional()`; `Round.read`: `z.object({user: z.string(), at: z.number()}).optional()`.
- `review.ts`: `export const DispositionVia = z.enum(["stage", "debrief-session"])` (+ type).
  `DispositionEntry.via` and `DispositionRow.via` → `DispositionVia`; both gain `answer:
  z.string().optional()`. New `RevertEntry = z.object({kind: z.literal("revert"), disposition:
  Disposition, decider: z.object({kind: z.literal("person"), user: z.string()}), via:
  z.literal("ui"), reason: z.string().optional()})`; `ItemHistoryEntry = HistoryBase.and(
  z.discriminatedUnion("kind", [FoldEntry, DispositionEntry, RevertEntry]))`.
- `hub.ts`: `DisposeRequest` (strict): `fingerprint` regex as `RecordDisposition`, `disposition:
  Disposition`, `reason: string 1..2000`, `answer: string 1..4000`, `until?` date regex, `link?
  1..500`, `sid?`. `RevertRequest` (strict): `{fingerprint, reason?: 1..2000}`. `ReadRequest =
  z.object({}).strict()`. Interfaces `DisposeResult`, `RevertResult`, `DecidedView`, `DebriefItem`,
  `DebriefView`, `DebriefSummary`, `DebriefList` exactly as the Types table. `ReviewResult` gains
  `already: string[]`.
- The 400 for `{x: 1}` on `POST …/read` comes from `body(c, ReadRequest)` in `app.ts` (zod error →
  400 through the existing error handler; AC-05 route).

Order: before everything else. Blast radius: every reader of `DispositionRow.via` (TS widens from a
literal to an enum: `submitReview` still writes `"stage"`); `jsonSchemas()` output (regenerated).
Risks: `ItemHistoryEntry` is an intersection; adding a third union member must keep RL-2 rows parsing
(no new required keys on existing members) — `answer` is optional, `via` accepts `"stage"`.

### AC-02 Policy validation and defaults

Files: `src/core/policy.ts` (and the export through `src/core/index.ts`, already `export *`).

Changes:
- `policyOf`: add `"assignee"` to `keys`; after copying, when `out.mode === "debrief"`: `out.consumes
  ??= ["open", "confirmed"]`, `out.assignee ??= "@owner"`.
- `validatePolicies`: build `eff = steps.map((s) => s.mode === "debrief" && !s.consumes ? {...s,
  consumes: ["open", "confirmed"]} : s)` and use `eff` for the loop, `byId` and `runOf` (decision 1).
  At the top of the per-step loop: `if (s.kind === "gate" && s.mode === "debrief") { errors.push(
  \`step "${s.id}": a gate step can't be a debrief\`); continue; }` (decision 2). After the RL-1 block:
  `assignee !== undefined && mode !== "debrief"` → `assignee needs mode: debrief`; for `mode ===
  "debrief"`: `!output` → `a debrief step needs output: review-record`; `!may_set` → `a debrief step
  needs may_set (the decisions the person may record)`. The existing RL-1 message covers `profile`,
  `budget`, `agent` (mode ≠ headless) unchanged. The existing RL-2 `consumes needs an earlier step…`
  fires for a debrief without a raising step upstream because its effective `consumes` is set.
- `debriefAssignee`, `isDebrief` (B1).

Order: after AC-01. Blast radius: plan proposal (`proposePlan`), preset validation in `goalFromPreset`
/ pulses (both call `validatePolicies`), `materialize` (stored policies of debrief steps gain the two
defaults). Plans without `mode: debrief` produce identical output (no new key copied unless present).
Risks: R1 — if `policyOf` did not fill `consumes`, `isRaising` would classify a debrief (`output`, no
`consumes`) as raising, and `runOf` of the downstream `file` step would stop at the debrief.

### AC-03 Never offered

Files: `src/hub/service.ts`.

Changes:
- `assignStep`: after the gate and state checks, `if (isDebrief(step.policy))` → `HubError(409,
  \`${step.id} is a debrief step: only ${assignee} runs it (mesh debrief ${step.id})\`)` (assignee via
  B2 `assigneeOf`).
- `offerableSteps`: also `&& !isDebrief(s.policy)`; goal assign then hits the existing `has no ready
  step to offer` 409 when only debriefs are ready (and `suggestGoal` ignores them too).
- `emitReady`: return before the stick logic when `isDebrief(s.policy)` (`step.ready` is still
  emitted).
- `listSteps`: when `filter.ready`, drop `isDebrief(s.policy)` before the repo/viewer filtering. This
  covers `mesh next`, `mesh_next`, `mesh_context` without a step, `/local/next` (`assignNext`, TUI `n`)
  and autopilot chaining, which all use `GET /v1/steps?ready=1`.
- `attempt` (pulses): defensive early return when the run step is a debrief (decision 6).

Order: after AC-02 (B1). Blast radius: only steps with `mode: debrief`. Risks: none for existing plans;
`listSteps({ready})` without debriefs is unchanged.

### AC-04 Assignee-only claim, accept and take-over

Files: `src/hub/service.ts`.

Changes:
- `claimInTx`: first statement `await this.refuseNonAssignee(actor, step)` (before the gate, parked
  and blind checks), so `claimStep` (all three of its branches), `acceptStep`, `mesh_claim`, `mesh run
  --step` (`POST /claim`) and `mesh_accept`/`/local/accept` (`POST /accept`) are covered. Note that in
  `acceptStep` the offer/machine checks run before `claimInTx`; that is fine for AC-04 (bob's machine
  is the target, so the next check is the assignee check).
- `takeStep`: `await this.refuseNonAssignee(actor, step)` right after loading the step, before
  `takeOver`.
- Replan keeps an open offer on a step that becomes a debrief (no withdrawal; spec Open questions).

Order: after B2. Blast radius: all claim paths, but the check is a no-op for non-debrief steps.
Risks: `refuseNonAssignee` reads the goal inside the claim transaction (one extra `getGoal`); it must
use `goal.ownerId` at that moment (no caching) so the store-side owner change in the test applies.
`mesh run` already prints a thrown hub error and exits 1 through `src/main.ts`; no CLI change.

### AC-05 Pre-read

Files: `src/hub/service.ts`, `src/hub/app.ts`, `src/protocol/hub-api.ts`.

Changes:
- `readStep(actor, id)`: in `goalTx`: `stepOr404`; not debrief → 409 `<id> is not a debrief step`;
  `refuseNonAssignee` → 403; state not in `ready|claimed|paused` → 409 `<id> is <state>`. `read =
  {user, at: now, round: (rounds?.length ?? 0) + 1}`; `saveStepFrom({...step, read, updatedAt: now},
  step)`; event `step.read` (`user`, `goal`, `step`, payload `{round}`); return `{read}`.
- `doneStep`: when building `round`, add `...(step.read && step.read.round === n ? {read: {user:
  step.read.user, at: step.read.at}} : {})`. Every branch that appends `round` (done, reject, park,
  reopen, fail) uses the same object, so the read is copied wherever the round lands.
- `app.ts`: `r("POST", "/v1/steps/:id/read", "member", async (c, a) => { await body(c, ReadRequest);
  return c.json(await svc.readStep(a, param(c, "id"))); })`.
- `hub-api.ts`: row `POST /v1/steps/:id/read`, member, tag `steps`, `body: ReadRequest`.
- `describe()`: `step.read` → `read the pre-read of <step>` (no titles).

Order: after AC-01/B2. Blast radius: `Round` gains an optional field (trail `stepRecord` maps rounds
field by field, so step records and the ledger are unchanged). Risks: `saveStepFrom` races with a
concurrent claim → its 409 `changed just now`; acceptable (inside `goalTx`).

### AC-06 Debrief view

Files: `src/hub/service.ts`, `src/hub/app.ts`, `src/protocol/hub-api.ts`.

Changes:
- `debriefView(id)`: `store.tx`: `stepOr404`; not debrief → 409 `<id> is not a debrief step`; `goal`,
  `steps = listSteps({goal})`; `debriefData` (B2–B4); `decided` = `listDispositions({step: id})`
  filtered `via === "debrief-session"` (insertion order, all rounds) mapped with `decidedView` (B2:
  `revertable` via `isRevertable`, last-per-fp rule). Reply `{step, goal, title, repo, state,
  assignee, ...(run ? {run: run.id, lineage} : {}), ...(report ? {report} : {}), items, decided,
  ...(step.read ? {read} : {})}`.
- `app.ts`: `r("GET", "/v1/steps/:id/debrief", "member", …, "goals:read")`; place it before the
  generic `GET /v1/steps/:id` for readability (Hono matches by segment count anyway).
- `hub-api.ts`: row with `scope: "goals:read"`, tag `steps`.

Order: after B2–B4. Blast radius: read-only. Risks: an item carried from an earlier goal in a state not
consumed (e.g. `dismissed`) is excluded by the `consumes` filter — relies on the stored policy having
the default `consumes` (R1). Near-match rule must exclude "same rule, other path, other or no symbol"
(B3 covers it: path differs and symbols differ/undefined).

### AC-07 `GET /v1/debriefs`

Files: `src/hub/service.ts`, `src/hub/app.ts`, `src/protocol/hub-api.ts` (store work in AC-25).

Changes:
- `debriefs(actor)`: `store.tx`: for each of `ready`, `claimed`, `paused`: `store.listSteps({state})`,
  keep `isDebrief`; resolve assignee per goal (cache goals in a `Map` within this call only), keep
  `assignee === actor.userId`; sort with `cmp` on id; each → `DebriefSummary {step, goal, title, repo,
  state, items: debriefData(...).items.length, read: step.read?.round === current round}`.
  `decided`: `since = now − 7 d`; `ids = (await store.listSteps({updatedSince: since})).filter(
  isDebrief).map(id)`; `rows = await store.listDispositions({steps: ids, since})`; keep `via ===
  "debrief-session" && decider.kind === "person" && decider.user === actor.userId`; keep revertable
  (B2, last-per-fp rule); map `decidedView`; sort newest first (`at` desc, ties by insertion order
  reversed).
- `app.ts`: `r("GET", "/v1/debriefs", "member", …)`; `hub-api.ts` row, tag `steps`.

Order: after AC-25 store filters. Blast radius: read-only; polled every 5 s by the TUI. Risks: cost —
`debriefData` per listed debrief loads item rows of its run's record; acceptable for a person's handful
of debriefs; never a full scan of `item_history` (only rows of recently updated debrief steps).

### AC-08 `mesh_dispose` happy path (route + tool)

Files: `src/hub/service.ts`, `src/hub/app.ts`, `src/protocol/hub-api.ts`, `src/protocol/tools.ts`,
`src/daemon/tools.ts`.

Changes (hub, `disposeStep(actor, id, b: DisposeRequest)` in `goalTx`), checks in the spec's order:
404; not debrief → 409 `… a stage records its dispositions in its review record (mesh_review)`; state
not `claimed|paused` → 409 `<id> is <state>; only a held debrief takes dispositions`; `holderUser !==
actor.userId` → 403 `<id> is held by <holderUser>`; `b.sid` → `refuseForeign(callerMachine(...))`;
`store.getReview(id, n)` exists → 409 `<id> round <n> already has a review record`; then `runRecordOf`,
`row = getItem(lineage, fp)`, `ownLatest = (listDispositions({lineage, fp})).at(-1)` is this step and
round `n`; `dispositionProblem(...)` → 422 with the bare text (no prefix). Apply with
`applyDisposition(lineage, row, b, {kind: "person", user}, "debrief-session", seenAt, b.answer)`
(`seenAt = {goal, step, round: n, at: now}`); note via `debriefNote` with `debrief: <disposition>
<fp> "<row.title>": <reason>`; event `item.disposed` (payload as RL-2 with `via: "debrief-session"`,
`decider: "person"`); `saveStepFrom({...step, updatedAt: now}, step)`; `left` = `debriefData(...)
.items.length` after the write (item rows re-read); 201 `{disposition, item: ItemView (withHistory),
left, note}`. No redaction in the hub.
- `app.ts`: `r("POST", "/v1/steps/:id/dispositions", "member", … 201)`; `hub-api.ts` row with
  `body: DisposeRequest`, `status: 201`.
- `tools.ts` (protocol): `mesh_dispose` entry, input `DisposeRequest.omit({sid: true}).shape`
  (strict object shape reused), description per the Types table; header comment "fifteen tools".
  `MESH_TOOL_RULES` untouched.
- `daemon/tools.ts` `case "mesh_dispose"`: no step → `this session holds no step`; `if
  (host.link.offline) await host.link.flush({probeNow: true})`; redact `reason` and `answer` with
  `redactSecrets(text, host.secrets?.() ?? [])`; `rpc("POST", /v1/steps/<step>/dispositions, {...args,
  reason, answer, sid: s.sid}, key)`; offline (503) → `the hub is offline; the disposition was not
  recorded. ${OFFLINE_TAIL}`; never `orQueue`. Reply `Recorded <fp>: <disposition> (was <from>).` +
  (`left > 0` ? ` <left> item(s) left to decide.` : the documented "No item left…" sentence). Other
  hub errors flow through `runTool`'s `HubRpcError` handler (message text as is).

Order: after B2 (AC-25 is not needed here). Blast radius: new route and tool only; the shim lists the
tool automatically (`TOOL_NAMES`). Risks: `redactSecrets` must be applied to both fields before the
body is built; the shim's key is the Idempotency-Key (AC-22).

### AC-09 `mesh_dispose` errors

Files: as AC-08.

Changes: the order of checks in `disposeStep` is the spec's; nothing is written before the last check
(all checks precede `applyDisposition`, the note, events and the step save; `goalTx` rolls back on a
throw). `dispositionProblem` reuses RL-2 texts: `may_set` → `<id> may not set dismissed (may_set: …)`;
`deferred needs until (YYYY-MM-DD)`; `no item <fp> in the record of <audit id>`; `item <fp> is
<state>; <id> acts on open, confirmed`. Change of mind: `ownLatest` lets an `accepted` item (not
consumed) be re-disposed by the same step in the same round, stored with `from: "accepted"`. Daemon:
offline path returns the documented error and queues nothing.

Risks: zod errors on the tool input surface as `invalid arguments: …` before the hub is called;
`ownLatest` must look at disposition rows only (a later fold or revert entry is not a disposition, so
after a revert the item is `open` and passes check 6 anyway).

### AC-10 The debrief's own review record

Files: `src/hub/service.ts`, `src/protocol/hub.ts`, `src/daemon/tools.ts`.

Changes in `submitReview`:
- Holder check: `if (step.holderUser !== actor.userId && (isDebrief(p) || !actor.roles.includes("admin")))`
  → 403 `<id> is held by <holderUser>`.
- In the consuming branch, after check 4 (`no item … in the record`) and before check 5: when
  `isDebrief(p)`, `S = sessionDecision(lineage, fp, step, n)`; if `S`: same disposition → push fp to
  `already` (not applied, no problem); different → problem `<fp> was decided in this debrief as
  <S.disposition>; list that decision or leave it out` (prefixed `disposition of <fp>: ` as all
  problems). Check 3 (`listed twice`) still runs before (as today, `given` set), so A twice → `listed
  twice`.
- Apply: `applyDisposition(..., isDebrief(p) ? "debrief-session" : "stage", seenAt)` (no `answer`);
  for a debrief also `debriefNote(...)` per applied disposition (decision 3) and `item.disposed` with
  the matching `via`.
- `review.recorded` payload gains `already: already.length` (decision 4); `ReviewResult.already` is
  `already` (`[]` outside debriefs).
- Decider: `deciderOf` already returns `{kind: "person", user}` for a non-headless step.
- Daemon `mesh_review` reply: after the Ignored sentence, `if (r.already?.length) text += \` ${n}
  disposition(s) were already recorded in this debrief.\`` (before the undeclared sentence).
- `doneStep` needs no change: REQ-5 already requires the record; `settle` makes `file` ready.

Order: after AC-08 (session decisions exist only through the route). Blast radius: `submitReview` for
every record (extracted helpers must keep RL-2 texts and event payload keys; only `already` is added).
Risks: R2 — the `already` lookup must use the current round `n` and this step only; a revert during
the session leaves `S` in place, so a matching record entry is `already` and A stays `open` (no new
history entry).

### AC-11 Revert

Files: `src/hub/service.ts`, `src/hub/app.ts`, `src/protocol/hub-api.ts`.

Changes: `revertDisposition(actor, id, b: RevertRequest)` in `goalTx`: 404; not debrief → 409; `d =
(listDispositions({step: id, fp})).filter(via debrief-session).at(-1)`; none → 404 `<id> has no
debrief disposition of <fp>`; `goal = goalOr404`; caller not `d.decider.user`, not `goal.ownerId`,
not admin → 403 `only <decider user>, the goal owner or an admin can revert this`; `!isRevertable(d)`
→ 409 `<fp> changed after the debrief decided it; nothing to revert`. Row: `state = d.from`;
`dismissedEh = row.eh` when `d.from === "dismissed"` (else delete); delete `until` unless `d.from ===
"deferred"`; `link` unchanged; `saveItem`. History: `{at: now, goal: step.goal, step: id, round:
d.round, from: d.disposition, to: d.from, kind: "revert", disposition: d.disposition, decider: {kind:
"person", user: actor.userId}, via: "ui", ...(reason)}`. Note `debrief: reverted <fp> to <to> (was
<from>)` via `debriefNote`. Event `item.reverted` (`user`, `goal`, `step`, payload decision 5). Any
step state. 200 `{item: ItemView, reverted: d, note}`.
- `app.ts` route `POST /v1/steps/:id/dispositions/revert`; `hub-api.ts` row (`body: RevertRequest`).
- `describe()`: `item.reverted` → `reverted item <fp> of <step>`.

Order: after AC-08. Blast radius: new route only. Risks: R4 (revertable identity); a revert after a
later fold (next goal) is refused because the fold entry is now last.

### AC-12 Person precedence

Files: `src/hub/service.ts` (no new code beyond AC-08).

Changes: none extra — RL-2 check 5 reads `listDispositions({lineage, fp, goal})` and refuses an agent
disposition when the latest is a person's; a `debrief-session` disposition is stored with `decider:
{kind: "person", user}`, so the later headless stage gets `ignored` with `decided by alice in this
goal`. Verify `listDispositions` still returns debrief rows (it filters only on `kind ===
"disposition"`).

Risks: if `listDispositions` were changed to drop non-`stage` rows, precedence would break; keep the
filter as is.

### AC-13 `mesh_context` of a debrief

Files: `src/hub/service.ts` (`stepInputs`), `src/daemon/tools.ts` (`brief`).

Changes:
- `stepInputs`: replace the early `return []` with `if (!p?.inputs?.length && !isDebrief(p)) return
  []`; before the policy-`inputs` loop, when `isDebrief(p)`: `d = debriefData(step, goal, steps)`; if
  `d.items.length` → `push({from: run.id, artifact: "debrief", kind: "review", title: \`debrief items
  (${n})\`}, JSON.stringify({lineage, items}))`; if `d.report?.content` → `push({from: run.id,
  artifact: report.artifact.id, kind: "report", title: report.artifact.title ?? "report"}, content)`.
  Both under the same `MAX_ONE`/`MAX_ALL` caps; then the loop over `p.inputs ?? []` as today. The
  debrief inputs are not deduplicated against a policy `artifacts`/run-step input (the spec orders
  the debrief inputs first and asks for no dedupe).
- `brief()`: after `lines.push("", "Brief:", ctx.step.brief)`, `if (ctx.step.policy?.mode ===
  "debrief") lines.push("", "This step is a debrief with your person: follow the mesh-debrief skill
  (mesh_dispose for each decision, then mesh_review, then mesh_done).")`. Inputs stay inside the
  existing content-hash fences (evidence notes are not in the content; report text is).

Order: after B2–B4. Blast radius: context for debrief steps only. Risks: content equality with the
view's `items` requires the same builder (`debriefData`) in both places.

### AC-14 Events and exports carry no text

Files: `src/hub/service.ts`, `docs/events.md`.

Changes: payloads exactly `item.disposed {lineage, fp, disposition, from, decider, via, round}`,
`item.reverted {lineage, fp, from, to, round, via}`, `step.read {round}`, `step.noted` (no payload),
`review.recorded` (+`already`). `describe()` texts for the new types carry ids only. Ledger export is
built from step-record front matter (`src/cli/ledger.ts` `parseRecordText`), which never contains
notes; no change there.

Risks: the hub event `describe()` must not interpolate titles; notes may carry reasons and titles
(allowed).

### AC-15 `mesh debrief`

Files: `src/cli/review-commands.ts` (new `debriefCommand(c, run)`), `src/cli/mesh-commands.ts`
(registration `debriefCommand(c, (args) => runCommand(c).run(args))` in `meshCommands`).

Changes: `parseArgs(args, ["session", "socket-name"])`; no positional → stderr `usage: mesh debrief
<step>`, 2. `hub = HubClient.from(c.paths)`; `view = hub.get<DebriefView>(/v1/steps/<step>/debrief)`
(a `HubCallError` → its message on stderr, 1); `me = hub.get("/v1/me").user.id`; `view.assignee !==
me` → `<step> is a debrief for <assignee>; only they can run it`, 1; state not `ready|claimed|paused`
→ `<step> is <state>; a debrief starts when it is ready`, 1. Warnings to stderr (not blocking):
pre-read — the view has no current round, so fetch `GET /v1/steps/<step>` (`StepView.context.step`)
and warn when `view.read` is absent or `view.read.round !== (step.rounds?.length ?? 0) + 1`; skill —
`skillStatus(c.paths.claudeDebriefSkill, MESH_DEBRIEF_SKILL) !== "current"`. Then `return run([repoName(view.repo), "--step", step, "--prompt",
PROMPT, ...(session ? ["--session", s] : []), ...(socket ? ["--socket-name", x] : []), ...(no-tui ?
["--no-tui"] : [])])`. `mesh run` claims (prints `Claimed …`), sets `MESH_STEP`, resolves the repo in
the workspace roots, and starts tmux through the fake `runner` in tests.

Order: after AC-06 and AC-16 (`claudeDebriefSkill`). Blast radius: new command; `mesh help` lists it.
Risks: refusals happen before `mesh run` (no claim, no tmux); `parseArgs` boolean `--no-tui` must be
forwarded as given; repo name = last `/` segment of `view.repo`.

### AC-16 Skill shipping

Files: `src/protocol/skill.ts`, `src/protocol/config.ts`, `src/claude/skill.ts`,
`src/cli/mesh-commands.ts`, `scripts/schemas.ts`.

Changes:
- `skill.ts`: `MESH_DEBRIEF_SKILL` (front matter `name: mesh-debrief`, description naming debrief
  steps and `mesh debrief`, `SKILL_MARKER`, the normative body of the Types table including
  `mesh_context`, `mesh_dispose`, `answer`, `mesh_review`, `mesh_done`, `transcript`, `possible repeat
  of`). Generic wording only.
- `config.ts`: `MeshPaths.claudeDebriefSkill = join(claudeConfigDir, "skills", "mesh-debrief",
  "SKILL.md")`.
- `claude/skill.ts`: `skillStatus(path, text = MESH_SKILL)`, `installSkill(path, text = MESH_SKILL)`
  compare/write `text`; `uninstallSkill` unchanged (removes the file, its folder, then `skills/` when
  empty).
- `mesh-commands.ts` setup: `debrief = a.has("no-mcp") ? undefined : installSkill(c.paths.
  claudeDebriefSkill, MESH_DEBRIEF_SKILL)`; output line after the mesh skill line: foreign → `Left
  <path> alone: mesh did not write it.`; else `Installed|Kept the mesh-debrief skill <path>.`.
  Uninstall: `uninstallSkill(c.paths.claudeDebriefSkill)` → `Removed the mesh-debrief skill <path>.`
  (after the mesh skill line). Doctor: `skillStatus(claudeDebriefSkill, MESH_DEBRIEF_SKILL)`: current →
  `ok("mesh-debrief skill <path>")`; missing → `warn("mesh-debrief skill not installed; run: mesh
  setup")`; outdated or foreign → `warn("mesh-debrief skill out of date; run: mesh setup")` (foreign
  is not specified; conservative: warning). `skillCommand`: `parseArgs(args)`; `--debrief` prints
  `MESH_DEBRIEF_SKILL.trimEnd()`.
- `scripts/schemas.ts`: also write `skills/mesh-debrief/SKILL.md`; update its stdout line.

Order: protocol first, then claude, then CLI, then `pnpm schemas`. Blast radius: setup/doctor/uninstall
output gains lines (spec Compatibility). Risks: uninstall order — remove `mesh` then `mesh-debrief` so
`skills/` is removed only when both are gone (the existing loop stops at a non-empty folder).

### AC-17 `renderOffers`

Files: `src/cli/tui/render.ts`.

Changes: `OFFERS_FOOTER` new text. `v` gains `debriefs?: readonly DebriefSummary[]`, `decided?:
readonly DecidedView[]`. After the offer lines: if `debriefs?.length`, push `DEBRIEFS` and per
debrief `${sel(d.step)}mesh debrief ${d.step}  ${d.state}  ${d.items} item(s)  "${d.title}"`; if
`decided?.length`, push `DECIDED IN DEBRIEF` and per entry `${sel(\`decided:${e.step}:${e.fp}\`)}${e.fp}
${e.disposition} (was ${e.from})  ${e.step}  "${e.title}"` (two spaces between fields as the spec
writes them). Height/clip logic unchanged.

Risks: exact spacing must match the spec strings.

### AC-18 TUI keys and daemon local routes

Files: `src/cli/tui/tui.ts`, `src/cli/client.ts`, `src/daemon/daemon.ts`.

Changes:
- `daemon.ts`: `debriefsLocal()` (credentials check → 409 `not logged in to a hub; run: mesh login`;
  `rpc GET /v1/debriefs`; `HubRpcError` → `HttpError(status, message)`), `revertLocal({step,
  fingerprint})` (400 on a bad body, `rpc POST /v1/steps/<step>/dispositions/revert {fingerprint}` with
  `randomUUID()` key); routes `GET /local/debriefs`, `POST /local/revert` in the request switch.
- `client.ts`: `debriefs(): Promise<DebriefList>`, `revert(step, fingerprint): Promise<RevertResult>`.
- `tui.ts`: state `debriefs: DebriefSummary[] = []`, `decided: DecidedView[] = []`; `loadOffers`
  also `try { const d = await client.debriefs(); debriefs = d.debriefs; decided = d.decided } catch {
  debriefs = []; decided = [] }` (silent, decision per spec); cursor ids = offers, then debriefs, then
  `decided:<step>:<fp>`; `moveOffer` walks that list; `⏎` on an offer → accept (as today), on a
  debrief → status `Start it with: mesh debrief <step>`; `u` on a decided id → `client.revert(step,
  fp)` → status `Reverted <fp> to <r.item.state>.` or the error text, then reload; `d` only for offer
  ids; badge `offers: offers.length + debriefs.length`; `renderOffers` gets `debriefs`, `decided`.

Order: after AC-07/AC-11 routes and AC-17. Risks: parsing `decided:<step>:<fp>` — step ids contain
`.` but no `:`, fps contain no `:`; split on the first and last `:`.

### AC-19 Web Mine

Files: `web/src/api.ts`, `web/src/mine.tsx`, `web/src/styles.css`.

Changes: `api.debriefs()`, `api.revert(step, fp)`, `api.read(step)`, `api.debrief(step)`. `MinePage`
loads `api.debriefs().catch(() => ({debriefs: [], decided: []}))` with the others; `Offers` gets
`debriefs`, `decided`, `onRevert`: after the offers, `li.debrief[data-step]` with text `<step>
"<title>" · debrief · <items> item(s) to decide`, link `open` to `#/goal/<goal>`, `<code>mesh debrief
<step></code>`; when `decided.length`, `<h3>Decided in debrief</h3>` and `li.decided[data-fp]` with
text `<fp> <disposition> (was <from>) · <step> · "<title>"` and `<button aria-label="Revert <fp>">Revert
</button>` → `api.revert` then `load()`. `Nothing is assigned to you.` only when all three lists are
empty. Small CSS for `.offers .debrief`, `.offers .decided` if needed.

Risks: shared e2e hub (R9).

### AC-20 Web step panel

Files: `web/src/goals.tsx`, `web/src/api.ts`.

Changes: `StepPanel`: hide the Assign button when `step.policy?.mode === "debrief"`; when debrief, load
`api.debrief(step.id)` (errors into the panel's error line) and render `<section className="debrief"
aria-label="debrief">`: `Assignee: @<assignee>`; `<pre className="report">` or `No report.`; `<ul
className="items">` with `<li data-fp>` `<severity> <title> · <state>` plus ` · possible repeat of
<fp>` per near-match; for state `ready|claimed|paused` only: `Mark as read` button (`aria-label="Mark
pre-read as read"`, calls `api.read` then reloads the debrief view) while `read` is absent or
`read.round !== (step.rounds?.length ?? 0) + 1`, else `Read by @<user>`; `decided` non-empty →
heading `Decided in debrief` and `li.decided[data-fp]` with `Revert` (`aria-label="Revert <fp>"`) on
revertable ones. `GoalPage.offerable` also excludes debrief steps (goal Assign button).

Risks: the panel must reload the debrief view after read/revert (not only the step view).

### AC-21 Compatibility

Files: all of the above; section 2 lists the only test edits.

Changes: none beyond keeping RL-2 paths byte-identical: extracted helpers keep texts; `via: "stage"`
for non-debrief records; `already: []` and `already: 0`; `TOOLS` gains only `mesh_dispose`;
`MESH_TOOL_RULES` and `src/core/profiles.ts` untouched (profile hashes unchanged); no migration
(`HUB_MIGRATIONS` untouched).

Risks: refactoring `submitReview` (helpers B2) is the main regression risk; keep the order of problems
and of writes.

### AC-22 Idempotency

Files: none new — `src/hub/app.ts`'s route wrapper caches `POST` replies (status < 300, JSON) per
`Idempotency-Key` and user, so a replay returns the stored reply without running the handler (one
history entry, note and event). Only requirement: both routes are `POST`, return JSON, and the daemon
sends the shim key (`mesh_dispose`) / a fresh UUID (`/local/revert`).

### AC-23 Docs

Files: `docs/guide/concepts.md` (new "Debriefs" section; the relay paragraph's "A person's debrief
stage comes later." points to it), `docs/guide/howto.md` (new "Debrief an agent's findings" section
before Troubleshooting, renumbering later sections), `src/protocol/skill.ts` `MESH_SKILL` (command-table
row `mesh debrief <step>` and a sentence pointing to the `mesh-debrief` skill) → `skills/mesh/SKILL.md`
via `pnpm schemas`, `docs/plan/implementation-plan.md` §5.6 (five rows, v0.1.18), `docs/events.md`
(`item.reverted`, `step.read`, `via` values on `item.disposed`, `already` on `review.recorded`). No team,
company or person names; examples use the spec's generic users (`alice`, `bob`) only where the spec does.

### AC-24 Version, checks, OpenAPI, boundaries

Files: `package.json` (`0.1.18`), `src/protocol/hub-api.ts` (5 rows matching `app.ts` rule, scope,
tag, body, status), generated schemas. `debriefAssignee` in `src/core/policy.ts` (imports only
`protocol` and `core`). Run `pnpm schemas`, then `pnpm check` and `pnpm test:web` after `pnpm build`.

### AC-25 Store filters

Files: `src/store/hub-store.ts` (both dialects share the class; `PgDb` only executes SQL).

Changes:
- `listSteps(filter)`: `updatedSince?: number` → `where.push("updated_at >= ?")`; `args` type becomes
  `SqlValue[]`.
- `listDispositions(f)`: `steps?: string[]` → `[]` returns `[]` before any query; otherwise
  `step IN (?, ?, …)`; `since?: number` → after parsing, skip entries with `e.at < since` (no `at`
  column, per the spec's "existing columns" note); map `answer` into the row when present. Existing
  filters (`step`, `lineage`, `fp`, `goal`) combine with AND as today.
- `disposeStep` saves the step with `updatedAt = at` so `listSteps({updatedSince})` finds a long-held
  debrief (AC-08).

Risks: the Postgres `step.updated_at` is `BIGINT` — the parameter is a JS number (as other filters);
`IN` lists are bounded by the number of debrief steps updated in 7 days.

## 5. Risks (cross-cutting)

- R1 Debrief misclassified as raising: `isRaising` = `output && !consumes`. Mitigated by `policyOf`
  defaults (stored policy) and the effective list in `validatePolicies`. Steps stored before this
  release cannot be debriefs (v0.1.17 rejects the mode).
- R2 Session decision vs record: scoped to (this step, current round, `via: debrief-session`).
- R3 Refactoring `submitReview`: keep RL-2 problem order, texts and event payloads (plus `already`).
- R4 Revertable identity: no `seq` in `DispositionRow`; compare the last history entry's fields and
  only consider the last row per `(lineage, fp)`.
- R5 `GET /v1/debriefs` cost on a 5 s poll: bounded by state-indexed `listSteps` and the 7-day window.
- R6 `@owner` resolved per check: every check calls `assigneeOf` with a fresh goal read.
- R7 Offers left open on a replanned step: only the assignee can accept (claim check in `claimInTx`).
- R8 Skill activation in interactive sessions is not covered by the spike; prompt and brief both name
  the skill (spec Open questions).
- R9 Shared e2e hub: new web fixtures must not give existing e2e users debriefs that break
  `mine.spec.ts:188`.
