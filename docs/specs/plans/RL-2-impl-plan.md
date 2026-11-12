# RL-2 implementation plan: Review records, fold, item states, conditional stages

Spec: `docs/specs/RL-2.md` (revision 2, approved in review round 2). Branch: `feat/relay-design`.
Release v0.1.16. Design: `docs/analysis/2026-11-12-pulse-relay-roster.md` §5.3, §5.4, §5.6, §5.9.

This plan covers the implementation only. It plans no new tests: the test side writes them from the
spec's contracts and never reads this plan. Section "Existing tests and generated files" lists every
existing test and generated file whose asserted behaviour the spec changes, and nothing else.
Section "Plan-level decisions" records the choices this plan makes where the spec leaves room; the
spec itself is not changed by this plan. AC-15 is retired by the spec and has no section.

## 0. Overview, build order, shared building blocks

Bottom-up along `.dependency-cruiser.cjs` (`protocol` ← `core` ← `store` ← `hub`; `protocol`/`core`/
`store`/`claude` ← `daemon`; `cli` imports `protocol`, `core`). `src/daemon` may not import
`node:child_process` (rule `processes-only-in-adapters`): every git call of the daemon goes through
`run` from `src/claude/index.ts` or the `HeadlessRunner.git` of RL-1.

| Stage | Module | Work | Criteria |
|---|---|---|---|
| 1 | `src/protocol` | New `review.ts` (all zod types of the Types table); `goal.ts` (`StepState`, `StepPolicy`, `Round.fold`); `hub.ts` (`ReviewUpload`, `ReviewResult`); `tools.ts` (`mesh_review`); `hub-api.ts` (3 rows); `skill.ts` (`MESH_SKILL`) | AC-01, AC-25, AC-30, AC-31 |
| 2 | `src/core` | New `review.ts` (normPath, fingerprint, ruleSlug, mapRule, declaredRules, lineageKey, repoName, normalizeRegion, evidenceHash, foldItems, whenHolds, runOf, skipSummary, severity rank); `dag.ts` (`settle`, `skipped` in `recomputeReady`/`reopen`/`materialize`); `policy.ts` (`policyOf`, `validatePolicies`); `headless.ts` (`parseAgentFile.rules`); `stages.ts` (`skipped`) | AC-02 – AC-07 |
| 3 | `src/store` | Migration 9 (both dialects); review, item, history, disposition methods; `hub-copy.ts` `TABLES` | AC-08, AC-32 |
| 4 | `src/hub` | `service.ts`: `submitReview`, `stepReviews`, `lineageItems`, done rule, `settle` wiring in approve/done/gate/resume, goal done with `skipped`, `previous`/`dispositions` inputs, uploadArtifact count, `describe()` rows; `app.ts`: 3 routes | AC-09 – AC-14, AC-16 – AC-18, AC-22, AC-24, AC-26, AC-27, AC-29 |
| 5 | `src/daemon` | `tools.ts` `mesh_review`; `ToolHost` gains `git`, `runOf`, `reviewStored`; `runs.ts` (`runForSid`, `reviewStored`, telemetry `undeclaredRules`); `daemon.ts` wiring | AC-19 – AC-21 |
| 6 | `src/cli` | New `review-commands.ts` (`mesh items`); `hub-commands.ts` registration; `show.ts` `MARK.skipped` | AC-23 |
| 7 | `web/` | `styles.css` rule for `.dag .st-skipped` (rendering is already generic) | AC-28 |
| 8 | repo | Docs; `package.json` 0.1.16; `pnpm schemas`; adjust the listed existing tests; full check | AC-30, AC-31 |

Order constraints:
- Stage 1 first. Inside it `review.ts` first and **self-contained** (imports only `zod`): `goal.ts`
  imports `Fold`, `StepWhen`, `ItemState`, `Disposition` from it, so `review.ts` must never import
  `goal.ts` (no-circular rule). Then `goal.ts`, `hub.ts`, `tools.ts`, `hub-api.ts`, `skill.ts`; add
  `export * from "./review.ts"` to `src/protocol/index.ts`.
- Stage 2 before stages 3–6. Inside it `review.ts` before `dag.ts` (settle uses no review helpers, but
  `materialize`'s change detection and `policy.ts` validation share the "raising step" predicate,
  which lives in `core/review.ts`).
- Stage 3 before stage 4.
- Stage 5 needs the stage-4 route (`POST /v1/steps/:id/review`) for anything beyond compiling.
- `pnpm schemas` after the last change to `src/protocol` (`HUB_API`, `PlanStep` via `StepPolicy`,
  `MESH_SKILL`); it rewrites `schemas/hub-api.openapi.json`, `schemas/*.json` and `skills/mesh/SKILL.md`.
- Docs and the version bump last.

Blast radius summary:
- One hub migration (9) on both dialects, three new tables, no change to existing tables or rows.
- `StepState` gains `skipped`: every exhaustive `switch`/`Record` over step states must handle it
  (`src/core/stages.ts` `stepStage`, `src/cli/show.ts` `MARK`; `tsc` finds the rest). The web renders
  states generically (`st-${state}` class, `· {state}` in the panel).
- `recomputeReady`, `reopen`, `materialize` change only for steps with `policy.when` or in state
  `skipped`; plans without the new fields behave as before (AC-25).
- The hub's four readiness paths (approve, done, gate decide, resume) switch from `recomputeReady` to
  `settle`; for steps without `when` the result is identical (settle without `when` steps is
  recomputeReady plus the `skipped` rules, which never trigger).
- `doneStep` changes only for steps with `policy.output`.
- `stepInputs` now serves `previous` and `dispositions`; the relative order of artifact inputs is
  unchanged.
- One new MCP tool (`mesh_review`); the shim lists fourteen tools. `MESH_TOOL_RULES` and profile
  hashes are unchanged (the rule `mcp__mesh__mesh_review` was already listed in RL-1).
- Three new hub routes; existing routes keep their bodies.
- `mesh help` gains `items`; `mesh goal show` gains the `↷` mark.

### B1. Protocol (`src/protocol/review.ts`, new)

Exactly the Types table of the spec, in this declaration order (each one only uses earlier ones):
`Severity`, `ItemState`, `Disposition`, `FoldMark`, `Fold` (`z.object({new, repeat, regression,
resolved, carried})`, each `z.number().int().min(0)`), `StepWhen` (`z.object({open:
z.literal(true).optional(), min_severity: Severity.optional()}).strict()`), `ReviewEvidence` (strict,
`lines: z.tuple([int ≥ 1, int ≥ 1]).optional()` plus `.refine(e => !e.lines || e.lines[0] <= e.lines[1])`
with message `lines must be [start, end] with start ≤ end`), `ReviewKey` (strict `{rule, path?,
symbol?}`), `ReviewItem` (strict), `RecordDisposition` (strict), `ReviewSubject` (strict
`{repo?, commit?, artifact?}`), `ReviewRecord` (strict; `subject: ReviewSubject.default({})`,
`dispositions: z.array(RecordDisposition).max(500).default([])`, `items: z.array(ReviewItem).max(500)`),
`StoredReviewItem` (`ReviewItem.extend({fp: z.string(), eh: z.string().optional(), mark:
z.enum(["new","repeat","regression"]).optional()})`), `StoredRecord` (`ReviewRecord.extend({items:
z.array(StoredReviewItem)})`), `Decider` (`z.discriminatedUnion("kind", …)`), `StoredReview`,
`ItemHistoryEntry` (base object `.and(z.discriminatedUnion("kind", [fold, disposition]))`),
`DispositionRow`, `ItemRow` (= `ItemView` without `history`; exported because the store saves it),
`ItemView` (`ItemRow.extend({history: z.array(ItemHistoryEntry)})`). Export each zod value and its
`z.infer` type under the same name, as `goal.ts` does.

Notes:
- `ReviewRecord` must stay a `ZodObject` (not wrapped by `.refine`/`.transform` at the top level) so
  `.shape` and `.extend` work: `TOOLS.mesh_review.input` is `ReviewRecord.shape`, `ReviewUpload` is an
  `.extend` of it. The lines refinement sits on `ReviewEvidence` only.
- `StoredReviewItem` is a zod object as well as a type (the store parses rows with it); the spec's
  "type" is satisfied by its `z.infer`.

### B2. Core (`src/core/review.ts`, new; exported from `src/core/index.ts`)

Pure, `node:crypto` and `yaml` only (both already used by `src/core`). Functions with the spec's exact
signatures: `normPath`, `fingerprint`, `ruleSlug`, `mapRule`, `declaredRules`, `lineageKey`,
`repoName`, `normalizeRegion`, `evidenceHash`, `foldItems`, `whenHolds`. Helpers added by this plan
(pure, exported, not in the spec's contract, used by hub, daemon and CLI):
- `base32(buf: Buffer): string` (RFC 4648 alphabet `A-Z2-7`, no padding; `fingerprint` lowercases and
  takes 16 characters). Not exported from the index if lint complains about unused exports; keep it
  module-private otherwise.
- `SEVERITY_RANK: Record<Severity, number>` (`S1` 1 … `S4` 4); "at or above `X`" = `rank <= rank(X)`.
- `isRaising(p: { output?: unknown; consumes?: unknown } | undefined): boolean` = `!!p?.output && !p.consumes`.
- `runOf<T extends { id: string; deps: readonly string[]; policy?: … }>(step: T, steps: readonly T[], idOf?: (dep: string) => string): T | undefined`:
  breadth-first over `deps` (deps in their order, then their deps, …, visited set), the first step
  for which `isRaising(policy)` holds. Used with `Step` (full dep ids) and with `PlanStep` (local ids)
  — the generic parameter keeps it usable for both.
- `uniqueFps(items: readonly { fp: string }[]): string[]` (first occurrence order).
- `skipSummary(runLocal: string, when: StepWhen, consumes: readonly string[]): string` = the spec's
  summary text (`skipped: no item of <run> is <consumes joined " or ">` + ` at <min_severity> or above`).
- `lineageOf(goal: { preset?: { name: string } | undefined }, step: { id: string; goal: string; repo: string; policy?: { agent?: string } }): string`
  = `lineageKey({preset: goal.preset?.name ?? "-", repo: step.repo, agent: step.policy?.agent ?? local id})`.

`declaredRules` parses front matter with the same regex as `parseAgentFile` (extract a shared
`frontMatter(text): Record<string, unknown>` in `core/headless.ts` and use it in both); `mesh-rules`
as a YAML list (`String(x).trim()`) or a comma-separated string; `rulesYaml` parsed with `yaml.parse`
inside `try` (list of strings, or a mapping → its keys); empty entries dropped.

`evidenceHash`: tokens joined by `"\n"`, sha256 hex. `normalizeRegion`: `text.replace(/\s+/g, " ").trim()`.

`foldItems`: exactly the spec's table. Implementation order: iterate `items` (fps unique) building
`marks`/`states`/`carried`; then, when `complete && previous`, every fp of `previous` not in the item
set → `states.set(fp, "resolved")`, `resolved.push(fp)` (in `previous` order). `fold.new`,
`fold.repeat`, `fold.regression` count marks; `fold.resolved = resolved.length`; `fold.carried =
carried.length`. Deferred: `until <= today` compares the `YYYY-MM-DD` strings lexicographically; a
`deferred` row without `until` stays `deferred` (cannot happen through the hub: check 2).

`whenHolds`: `items.some(i => consumes.includes(i.state) && (!when.min_severity || rank(i.severity) <= rank(when.min_severity)))`.
With `when: {}` true (spec); the hub never sees `{}` (plan error).

## AC-01 Schemas

Files: `src/protocol/review.ts` (new, B1), `src/protocol/goal.ts`, `src/protocol/index.ts`.

Changes:
- `goal.ts`: `StepState` gains `"skipped"` (append at the end of the enum so existing ordinals and
  JSON stay as they are). Import `Disposition`, `Fold`, `ItemState`, `StepWhen` from `./review.ts`.
- `StepPolicy` gains, after `inputs`: `output: z.enum(["review-record"]).optional()`, `when:
  StepWhen.optional()`, `consumes: z.array(ItemState.exclude(["resolved"])).min(1).max(5).optional()`,
  `may_set: z.array(Disposition).min(1).max(4).optional()`. `PlanStep` picks them up through
  `...StepPolicy.shape`; `POLICY_KEYS` follows.
- `Round` gains `fold: Fold.optional()` after `telemetry`.
- `ReviewRecord`'s defaults (`subject: {}`, `dispositions: []`) come from `.default`.

Order: `review.ts` → `goal.ts` → `index.ts`.

Blast radius: plans and stored steps without the fields parse unchanged. The `Step.policy` lazy
reference is unaffected. A v0.1.15 hub strips the fields (non-strict `StepPolicy`).

Risks: `StepWhen` must be `.strict()` so `{x: 1}` is rejected; `open: z.literal(true)` so `false` is
rejected. `ItemState.exclude` exists on zod 4 enums.

## AC-02 `validatePolicies` and plan storage

Files: `src/core/policy.ts`.

Changes:
- `policyOf` key list gains `"output", "when", "consumes", "may_set"` (appended, so stored key order
  of existing policies is unchanged).
- `validatePolicies`, inside the per-step loop, after the RL-1 checks, in this order:
  1. `s.kind === "gate"` and any of `output`, `consumes`, `may_set`, `when` set → push
     `step "<id>": a gate step can't have output, consumes, may_set or when` and skip 2–5 for this step.
  2. `may_set && !consumes` → `step "<id>": may_set needs consumes`.
  3. `when && !consumes` → `step "<id>": when needs consumes (the item states it looks at)`.
  4. `when && !when.open && !when.min_severity` → `step "<id>": when needs open: true or min_severity`.
  5. `consumes` and `runOf(s, steps)` (B2, over `PlanStep`s by local id; deps that are not plan steps
     are ignored) is undefined → `step "<id>": consumes needs an earlier step with output: review-record that raises items (through deps)`.
- The `POST /v1/goals/:id/plan` path already turns `validatePolicies` errors into 422 (no hub change).

Order: after AC-01 and B2 (`runOf`).

Blast radius: only plans using the new fields get new errors.

Risks: check 5 must walk deps transitively (a consumer two deps away is valid) and must not accept a
step that has `output` **and** `consumes` as the raising one (`isRaising`). `validatePlan` runs first
and rejects cycles, but `runOf` keeps a visited set anyway.

## AC-03 `normPath`, `fingerprint`, `repoName`

Files: `src/core/review.ts`.

Changes:
- `normPath(p, root?)`: `p.replace(/\\/g, "/")`; when `root` is given, normalise it the same way
  (backslashes, trailing `/` removed) and strip `root` / `root + "/"`; then
  `while (p.startsWith("./")) p = p.slice(2)`; `p.replace(/\/{2,}/g, "/")`; strip one trailing `/`
  unless the whole path is `/`. `p === root` → `""`.
- `fingerprint(key)`: `base32(sha256(utf8(rule.trim() + "\n" + normPath(path ?? "") + "\n" + (symbol ?? "").trim()))).toLowerCase().slice(0, 16)`.
- `repoName(repo)`: strip trailing `/`s, then one trailing `.git`, then the last segment after `/`
  or `:` (so `git@host:team/alpha.git` → `alpha`; there is a `/` after the `:` there, so splitting on
  `/` suffices, but split on `/[/:]/` to also cover `host:alpha.git`).

Risks: `normPath` order matters (`./a//b/` → `a/b`: `./` removal first, then collapsing). Do the
root strip before the `./` loop as the spec says.

## AC-04 Declared rules and rule mapping

Files: `src/core/review.ts`, `src/core/headless.ts`.

Changes:
- `ruleSlug(s)`: `s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40)`,
  then trim `-` again after the cut; `""` → `"unnamed"`.
- `mapRule(rule, declared)`: per spec; `other:` prefix stripped case-insensitively before slugging
  (`other:Foo` → `other:foo`).
- `declaredRules(agentText, rulesYaml?)`: B2.
- `core/headless.ts`: extract `frontMatter(text)`; `AgentFile` gains `rules?: string[] | undefined`;
  `parseAgentFile` fills it from `mesh-rules` with the same list/comma parsing (absent when the key is
  absent).

Blast radius: `parseAgentFile` callers (`daemon/runs.ts`) ignore the new field.

Risks: `parseAgentFile`'s returned object is compared in existing unit tests with `toEqual`; add
`rules` only when present (spread) so those comparisons still hold.

## AC-05 Evidence hash

Files: `src/core/review.ts`. Functions `normalizeRegion`, `evidenceHash` as in B2. No other change.

Risks: `null` must hash as the literal token `missing` (not the sha of `"missing"`).

## AC-06 `foldItems`

Files: `src/core/review.ts` (B2). No other change.

Risks: `dismissed` with `eh` and `dismissedEh` both `undefined` is a repeat (carried); one present,
the other absent is a regression. A complete record resolves fps of `previous` "from any state"
(including `dismissed`/`accepted`).

## AC-07 `whenHolds`, `settle`, `recomputeReady`, `reopen`, `materialize`

Files: `src/core/dag.ts`, `src/core/review.ts`, `src/core/stages.ts`.

Changes in `dag.ts`:
- `SATISFIED = new Set(["done", "dropped", "skipped"])`; a helper `depsSatisfied(s, byId)`.
- `recomputeReady`: for `blocked`/`ready` steps: deps not satisfied → `blocked`; satisfied → `ready`,
  except a `blocked` step with `policy.when` stays `blocked`. A `ready` step with `when` and satisfied
  deps stays `ready`. Signature unchanged. `skipped` steps are not touched.
- New `export function settle(steps, now, holds)`: `byId` map; loop until a pass changes nothing:
  `blocked` + deps satisfied → `ready` when no `policy.when`, else `holds(s) ? "ready" : "skipped"`;
  `ready` + deps not satisfied → `blocked`; `skipped` + deps not satisfied → `blocked`; other states
  untouched; a `ready` step with satisfied deps is not looked at. `holds` is called at most once per
  step per call (memo map) and only for steps with `policy.when`. Changed steps get `updatedAt: now`
  and only a new `state`. Returns `{changed: [...final versions of changed steps], skipped: ids whose
  final state is skipped and were not skipped before}`.
- `reopen(steps, ids, now)`: the cascade (`queue` loop) also takes dependants in state `skipped`
  (`x.state === "done" || x.state === "skipped"`) and sends them to `blocked`, continuing through
  them. For a skipped step only `state`/`updatedAt` change (it has no outcome/holder/offer). The final
  `recomputeReady` pass stays (it will not make `when` steps ready).
- `materialize`: in the "existing step" branch, when `old.state === "skipped"`: unchanged definition
  (`kind`, `repo`, `title`, `brief`, `deps` (full ids), and policy compared with a canonical
  JSON — recursive key sort — of `old.policy` and the new `policy`) → keep `skipped` (with the new
  `planVersion`); changed → `blocked`. New steps are already `blocked`; with the `recomputeReady` change
  no `when` step becomes `ready` here. Add a module-private `canon(v)` for the comparison.

`stages.ts`: `stepStage` gains `case "skipped": return "done";` (see decisions; `STEP_STAGES`
unchanged).

Order: after AC-01 (`StepState`).

Blast radius: all four functions are used by the hub only; no change for steps without `when` that are
never `skipped`.

Risks:
- Termination: states only move blocked→ready/skipped, ready→blocked, skipped→blocked, and a step
  only goes back to blocked when a dep is unsatisfied, which no transition in `settle` creates
  except ready→blocked of a step that was already unsatisfied; cap the loop at `steps.length + 1`
  passes as a guard.
- `reopen` returns steps whose `state` became `blocked` from `skipped`; the hub must not emit
  `step.reopened` for them (it filters by the explicit ids already).

## AC-08 Hub store: migration 9 and review methods

Files: `src/store/hub-store.ts`.

Changes:
- `HUB_MIGRATIONS` entry 9 (comment `// v0.1.16 (RL-2): review records, item rows and their history.`):
  ```sql
  CREATE TABLE review_record (step TEXT NOT NULL, round INTEGER NOT NULL, goal TEXT NOT NULL, lineage TEXT NOT NULL,
    raising INTEGER NOT NULL, complete INTEGER NOT NULL, value TEXT NOT NULL, created_at INTEGER NOT NULL, PRIMARY KEY (step, round));
  CREATE INDEX review_record_lineage ON review_record (lineage, raising, complete);
  CREATE TABLE review_item (lineage TEXT NOT NULL, fp TEXT NOT NULL, value TEXT NOT NULL, updated_at INTEGER NOT NULL, PRIMARY KEY (lineage, fp));
  CREATE TABLE item_history (seq INTEGER PRIMARY KEY AUTOINCREMENT, lineage TEXT NOT NULL, fp TEXT NOT NULL, step TEXT NOT NULL, value TEXT NOT NULL);
  CREATE INDEX item_history_fp ON item_history (lineage, fp, seq);
  ```
- `HUB_MIGRATIONS_PG` entry 9: the same with `created_at BIGINT`, `updated_at BIGINT`, `ord BIGINT
  GENERATED ALWAYS AS IDENTITY` as the last column of `review_record`, and `seq BIGINT GENERATED
  ALWAYS AS IDENTITY PRIMARY KEY` in `item_history`.
- `SCHEMA_VERSION` follows (`HUB_MIGRATIONS.length` = 9).
- Methods (section `// ---------- review records and items (RL-2) ----------`):
  - `addReview(r)`: `StoredReview.parse(r)`; `INSERT … ON CONFLICT (step, round) DO NOTHING`; returns
    `changes === 1`.
  - `getReview(step, round)`; `listReviews(f)`: `WHERE` on the given columns (`raising`/`complete` as
    0/1), `ORDER BY ${dialect.stepOrder}` (`rowid` / `ord`, already the insertion-order expression of
    the dialects); parse with `StoredReview`.
  - `getItem(lineage, fp)`, `listItems(lineage)` (insertion order; the hub sorts), `saveItem(row)`:
    `ItemRow.parse`, `INSERT … ON CONFLICT (lineage, fp) DO UPDATE SET value = excluded.value,
    updated_at = excluded.updated_at`; `updated_at` = `row.last.at`.
  - `addItemHistory(lineage, fp, e)`: `ItemHistoryEntry.parse(e)`; insert with `step = e.step`.
  - `itemHistory(lineage, fp?)`: `ORDER BY seq`.
  - `listDispositions(f)`: `SELECT lineage, fp, value FROM item_history` with `WHERE` on `step`,
    `lineage`, `fp` columns, `ORDER BY seq`; parse, keep `kind === "disposition"` and (when `f.goal`)
    `e.goal === f.goal`; map to `DispositionRow` (`{lineage, fp, goal, step, round, disposition, from,
    reason, decider, via, link?, until?, at}`).
- Import the new protocol types.

Order: after AC-01. Before AC-32 (the copy uses the new tables).

Blast radius: new tables only. Review records are never pruned (`pruneArtifacts` untouched).

Risks: `ON CONFLICT … DO NOTHING` returns `changes` 0 on both dialects (pg adapter maps rowCount).
Use `dialect.stepOrder` rather than a literal so Postgres orders by `ord`.

## AC-09 `POST /v1/steps/:id/review`

Files: `src/protocol/hub.ts`, `src/protocol/hub-api.ts`, `src/hub/service.ts`, `src/hub/app.ts`.

Changes:
- `hub.ts`: `ReviewUpload = ReviewRecord.extend({ items: z.array(ReviewItem.extend({ eh: z.string().regex(/^[0-9a-f]{64}$/).optional() })).max(500), undeclaredRules: z.number().int().min(0).default(0), redactions: z.number().int().min(0).default(0), agent: z.object({ key: z.string().max(200), hash: z.string().max(64).optional() }).optional(), sid: z.string().optional() })`;
  `interface ReviewResult` as in the spec.
- `hub-api.ts`: row `{ method: "POST", path: "/v1/steps/:id/review", rule: "member", tag: "steps", body: ReviewUpload, status: 201, summary: "Submit the review record of the held step's current round (fingerprinted and folded by the hub)." }`.
- `app.ts`: `r("POST", "/v1/steps/:id/review", "member", async (c, a) => c.json(await svc.submitReview(a, param(c, "id"), await body(c, ReviewUpload)), 201))` next to `/artifacts`.
- `service.ts`: new `async submitReview(actor, id, b: ReviewUpload): Promise<ReviewResult>` inside
  `this.goalTx`:
  1. Checks in the spec's order: `stepOr404`; `!step.policy?.output` → 409; state → 409; holder →
     403; `b.sid` → `this.refuseForeign(await this.callerMachine(actor, b.sid), b.sid)`; `n =
     (rounds.length) + 1`; `getReview(step.id, n)` → 409.
  2. `goal = goalOr404`; `steps = listSteps({goal})`; `raising = isRaising(policy)`; `run = raising ?
     step : runOf(step, steps)`; `lineage = lineageOf(goal, run ?? step)`; `runRecord` (consuming) =
     last of `listReviews({step: run.id})` by `round` (max round).
  3. Fingerprint: `items = b.items.map(i => ({...stripEh(i), fp: fingerprint(i.key), ...(i.eh ? {eh: i.eh} : {})}))`;
     `fps = uniqueFps(items)`; first item per fp for fold input.
  4. Problems (helper `reviewProblems(...)`, private): record-level 1 and 2, then per disposition the
     first failing check of AC-13/AC-14 (see there); precedence-ignored ones collected separately.
     Non-empty problems → `throw new HubError(422, \`the review record has ${k} problem(s): ${list.join("; ")}\`, list)`.
  5. Raising: fold (AC-10); consuming: apply dispositions (AC-13).
  6. Build `record: StoredRecord = {...recordFieldsOf(b), items: storedItems}` (strip `undeclaredRules`,
     `redactions`, `agent`, `sid` from the body; items with `fp`, `eh`, `mark`).
  7. Artifact: `id = this.newArtifactId(now)`, `content = JSON.stringify(record)`, `addArtifact` with
     `kind: "review"`, `mediaType: "application/json"`, `title: "review record"`, `redactions:
     b.redactions`, `round: n`, `by: actor.userId`. No size/per-round check, no `step.artifact` event.
  8. `review: StoredReview = {goal, step, round: n, lineage, raising, complete: coverage === "complete",
     record, fold? (raising), artifact: id, undeclaredRules, decider, by, sid?, at: now}`;
     `addReview` → `false` → 409 (same text as step 1's check; reachable only in a race).
  9. Events: `review.recorded` (`user`, `sid`, `goal`, `step`; payload exactly `{round, lineage,
     coverage, assessment, items: fps.length, artifact, ...(fold ? {fold} : {}), dispositions:
     applied, ignored: ignored.length, undeclaredRules}`); then one `item.disposed` per applied
     disposition (AC-13).
  10. Return `{review, items: fps.map(fp => ({fp, mark?, state: row.state, title})), resolved, applied, ignored}`.
- `decider` (private helper `deciderOf(step, actor, agent)`): `policy.mode === "headless"` →
  `{kind: "agent", key: agent?.key ?? \`${repoName(step.repo)}/${local(step)}\`, ...(agent?.hash ? {hash} : {})}`;
  else `{kind: "person", user: actor.userId}`.
- `local` is already exported from `core/policy.ts`.

Order: after AC-08 (store) and B2. The fold (AC-10) and dispositions (AC-13) parts land in the same
method; build them in that order.

Blast radius: new route and method only.

Risks:
- Everything (checks, fold, item rows, history, artifact, record, events) is one `goalTx`, so a 422
  writes nothing and two racing calls serialise (AC-27).
- `refuseForeign` must run before the duplicate-record check (spec order) and before any write.
- The preset of the lineage is `goal.preset?.name`; `Goal.preset` already exists.

## AC-10 Fold through the hub

Files: `src/hub/service.ts` (inside `submitReview`, a private `foldRecord(...)`).

Changes:
- `base = (await listReviews({lineage, raising: true, complete: true})).at(-1)` — the current round
  has no record yet, so "other than (step, current round)" holds automatically; keep an explicit
  filter `!(r.step === step.id && r.round === n)` for clarity.
- `previous = base ? uniqueFps(base.record.items) : undefined`; `rows` = `listItems(lineage)` as a
  `Map(fp → row)`; `today = new Date(now).toISOString().slice(0, 10)`.
- `foldItems({items: firstPerFp, complete, previous, rows, today})`.
- Every stored item gets `mark: marks.get(fp)` (all copies of a duplicated fp carry it).
- Item rows: for each fp of the record (first item): existing row → `{...row, state, title, severity,
  category, eh (set, or key removed when the new item has none), last: {goal, step, round, at}}`; no
  row → `{lineage, fp, state: "open", rule/path/symbol from key, title, severity, category, eh?,
  raisedBy: agent ? {key, hash?} : {key: "<repo name>/<local id>"}, first: last: {goal, step: step.id,
  round: n, at: now}}`. For each resolved fp: `{...row, state: "resolved"}` (`last` unchanged).
  `saveItem` each.
- History: one `kind: "fold"` entry per fp of the record (`from` = prior row state or `null`, `to`,
  `mark`, `carried: true` when in `carried`), then one per resolved fp (`mark: "resolved"`), all with
  `at: now, goal, step, round: n`.
- `review.fold = fold`.
- Consuming records skip all of this (stored with `raising: false`, never a base).
- `previous` input: AC-22.

Risks: partial records are folded (new/repeat/regression) but resolve nothing (`complete: false` →
`foldItems` resolves nothing) and are never the base (`complete: true` filter). The base is chosen by
insertion order, never `at`.

## AC-11 Carry-forward, accepted links, deferred

Files: none beyond AC-10/AC-13: carry-forward is `foldItems` (AC-06) applied to the rows; `link` and
`dismissedEh` live on the row and are kept by the `{...row, …}` updates in AC-10 (only the fields
listed there are overwritten). `today` comes from `this.now()` (the World clock).

Risks: AC-10's row update must not drop `link`, `dismissedEh` or `until`; resolved → regression keeps
`link` (state `open`, link kept).

## AC-12 REQ-5 done rule

Files: `src/hub/service.ts` (`doneStep`).

Changes, inside `doneStep` in the spec's order:
1. After the gate check and before the `explicit` reopen-id loop: `if (step.policy?.output &&
   input.reopen.length) throw new HubError(400, "a step with output: review-record reopens nothing; its record carries the findings")`.
2. After the existing verdict rule, the `outcome === "done" && explicit.length` 400, the state 409 and
   holder 403: `const n = rounds.length + 1; const rec = step.policy?.output ? await
   this.store.getReview(step.id, n) : undefined;`
   - `policy.output && !rec && outcome === "done"` → 409 `${id} needs a review record for round ${n} (output: review-record); submit it with mesh_review, then call mesh_done`.
   - `rec` → `outcome = "done"` (declare `outcome` with `let`); the round is built with `outcome:
     "done"` and `verdict` as sent; `if (rec.fold) round.fold = rec.fold`; `decision = { action:
     "done" }` instead of `judgeDone(...)` (no reconcile, caps, park, routing).
   - `!rec` → unchanged path (`judgeDone`).
3. `round.artifactIds` already lists every artifact of `(step, n)`, which includes the record's
   `review` artifact (AC-09 stores it with `round: n`).
- The 409 throws before any write, so no round is added.
- The daemon's close-as-fail posts `outcome: "fail"` through the same route, so it closes `done` when a
  record exists (no daemon change).

Order: after AC-09.

Blast radius: steps without `policy.output` take exactly today's path.

Risks: `finish()` (core/claims) is called with `{...input, outcome}` — pass the overridden outcome so
the step becomes `done`. `step.done` (not `step.failed`) is emitted for a recorded step whose agent
sent `fail`.

## AC-13 Consuming records and dispositions

Files: `src/hub/service.ts` (`reviewProblems`, `applyDispositions`, private).

Changes:
- Record-level problems (exact texts): raising with `dispositions.length` → `dispositions need consumes; ${id} raises items`;
  consuming with `items.length` → `${id} consumes items; its record may not raise new ones`.
- Per disposition `d`, in record order, first failing check only, prefixed `disposition of ${d.fingerprint}: `:
  1. `!may_set?.includes(d.disposition)` → `${id} may not set ${d.disposition} (may_set: ${may_set?.join(", ") ?? "none"})`;
  2. `d.disposition === "deferred" && !d.until` → `deferred needs until (YYYY-MM-DD)`;
  3. fp seen earlier in this record's dispositions (a `Set` filled for every disposition, failing or
     not) → `listed twice`;
  4. `!runRecord || !uniqueFps(runRecord.record.items).includes(fp)` → `no item ${fp} in the record of ${run?.id ?? <the step's own id>}`
     (with no run step at all — impossible after plan validation — use the step id);
  5. precedence: decider is `agent` and `(await listDispositions({lineage, fp, goal: step.goal})).at(-1)?.decider.kind === "person"`
     → push to `ignored` `{fingerprint, reason: \`decided by ${last.decider.user} in this goal\`}`, skip 6;
  6. `row = getItem(lineage, fp)`; `!consumes.includes(row.state)` → `item ${fp} is ${row.state}; ${id} acts on ${consumes.join(", ")}`.
- Raising steps do not get per-disposition checks beyond record-level problem 1 (their dispositions
  already make the record fail).
- Applying (only when there are no problems), for each non-ignored disposition: `from = row.state`;
  `row.state = d.disposition`; `dismissed` → `dismissedEh = row.eh` (delete the key when `row.eh` is
  absent); `deferred` → `until = d.until`; `accepted` with `link` → `link = d.link`; `saveItem`;
  `addItemHistory` `{at: now, goal, step: step.id, round: n, from, to: d.disposition, kind:
  "disposition", disposition, reason, decider, via: "stage", link?, until?}`; event `item.disposed`
  (`user`, `goal`, `step`; payload `{lineage, fp, disposition, from, decider: decider.kind, via:
  "stage", round: n}`).
- `applied` = count applied.

Risks: one problem per disposition; check order exact; nothing applied when any problem exists
(collect all first, apply after). The `DispositionRow` comes from the history row (`listDispositions`),
so there is one storage of it.

## AC-14 Person precedence

Files: `src/hub/service.ts` (check 5 of AC-13). The person decider of an interactive consuming step
is `{kind: "person", user: actor.userId}` (AC-09 `deciderOf`). "Same goal" = `listDispositions({lineage,
fp, goal: step.goal}).at(-1)`; across goals no precedence (the latest applies, history keeps both).

Risks: checks 1–4 still run before precedence (a person-decided fp with a `may_set` problem is a 422,
not ignored). An ignored disposition does not count in `applied` and emits no `item.disposed`. The
record is accepted and the step can close `done` (AC-12).

## AC-16 Reads: items and reviews

Files: `src/hub/service.ts`, `src/hub/app.ts`, `src/protocol/hub-api.ts`.

Changes:
- `service.stepReviews(id)` in `this.store.tx`: `stepOr404`; `listReviews({step: id})` sorted by
  `round`; returns `{reviews}`.
- `service.lineageItems(lineage)` in `this.store.tx`: rows = `listItems(lineage)`; history =
  `itemHistory(lineage)` grouped by fp (one query); `ItemView = {...row, history}`; sort by
  `SEVERITY_RANK`, then `first.at`, then `fp`. Returns `{lineage, items}`.
- `app.ts`: `r("GET", "/v1/steps/:id/reviews", "member", …, "goals:read")`; `r("GET", "/v1/items",
  "member", async (c) => { const l = c.req.query("lineage"); if (!l) throw new HubError(400, "lineage is required"); return c.json(await svc.lineageItems(l)); }, "goals:read")`.
- `hub-api.ts` rows: `GET /v1/steps/:id/reviews` (scope `goals:read`, tag `steps`, summary "The review
  records of a step, by round."); `GET /v1/items` (scope `goals:read`, tag `goals`, `query: { lineage:
  "the lineage key <preset>|<repo>|<agent> (required)" }`, summary "The items of a lineage with their
  history, most severe first.").

Blast radius: new routes. Service tokens: the route rule plus `scope` enforce that `goals:read` may
call the GETs; `POST …/review` has no scope, so a service token is refused as for other step writes.

Risks: lineage keys contain `|`; the query parameter is URL-decoded by hono. Register `/v1/steps/:id/reviews`
before or after `/v1/steps/:id` — hono matches full paths, no conflict.

## AC-17 Conditional stages through the hub

Files: `src/hub/service.ts`.

Changes:
- Private `async holdsFor(goal, steps): Promise<(s: Step) => boolean>`: for every step with
  `policy.when` in `steps`: `run = runOf(s, steps)`; `rec` = latest record of `run` (max round, via
  `listReviews({step: run.id})`); none → `false`; else rows = `getItem(rec.lineage, fp)` for each
  unique fp; `whenHolds(s.policy.when, s.policy.consumes ?? [], rows.map(r => ({state, severity})))`.
  Results in a `Map`; returns `s => map.get(s.id) ?? false`. Precomputing is valid because nothing
  changes item rows during a `settle` call.
- Private `async afterSettle(actor, goal, steps, skipped, now)`: for each skipped id: set `summary =
  skipSummary(local(run), when, consumes)` on the step (saved with the other changes), emit
  `step.skipped` (`goal`, `step`, payload `{reason: "when"}`); then the goal-done check
  `steps.length > 0 && steps.every(s => ["done","skipped","dropped"].includes(s.state)) && steps.some(s => s.kind !== "design")`
  → save goal `done`, emit `goal.done`, return trail files as today.
- `doneStep`: replace `recomputeReady(steps, now)` with `settle(steps, now, await this.holdsFor(goal, steps)).changed`;
  apply the skip summaries before `saveSteps`; replace the inline goal-done check with the shared one
  (it now counts `skipped`).
- `decideGate`: same replacement (covers gate approve and reject-with-reopen).
- `approvePlan`: replace the second pass `recomputeReady(afterFirst, now)` with `settle(afterFirst,
  now, holds)`; emit `step.skipped` for skipped ones; after it, set the goal to `done` (with
  `goal.done`) when the shared check holds, else `in_progress` as today.
- `resumeStep`: replace `recomputeReady(all, now)` with `settle`; add the `step.skipped` events and the
  goal-done check (spec: "checked after every settle").
- `step.ready` events stay as today (only for steps that end `ready`).

Order: after AC-07 and AC-09/AC-10 (`holdsFor` reads records and rows).

Blast radius: for goals without `when` steps, `holdsFor` returns a constant function without store
reads and `settle` equals the old recomputation; the goal-done check only adds `skipped`.

Risks:
- `endOffersLeavingReady` is passed the settle changes as before; a step that goes `blocked →
  skipped` has no offer.
- `approvePlan` must settle **after** saving `materialize`'s upserts (it already re-lists
  `afterFirst`), so a new/changed `when` step is decided there.
- The skip summary uses the run's **local** id (`audit`), not the full id.

## AC-18 Re-evaluation (reopen, gate, replan)

Files: `src/core/dag.ts` (AC-07 `reopen`, `materialize`), `src/hub/service.ts` (AC-17 paths).

Changes: none beyond AC-07 and AC-17. Walkthrough to verify while implementing:
- `check` fails with `reopen: ["audit"]`: `reopen()` sends `audit` → ready, done `validate` → blocked,
  skipped `debrief`/`file` → blocked (cascade through skipped); then `settle` keeps them blocked (deps
  unsatisfied). `check` itself becomes `blocked` via `finish(reopening)`.
- audit round 2 record + done → `settle`: `validate` (when) → `holds` true with the S1 item → `ready`.
- Gate approve → `decideGate` → `settle` decides the consuming step behind the gate.
- Replan unchanged → `materialize` keeps `skipped`; changed brief → `blocked` → approve's `settle`.
- Replan making every step done/skipped/dropped → AC-17's goal-done check in `approvePlan`.

Risks: `materialize`'s own `recomputeReady` must treat `skipped` deps as satisfied (AC-07) so
dependants of an unchanged skipped step are not stuck blocked.

## AC-19 MCP `mesh_review` (interactive)

Files: `src/protocol/tools.ts`, `src/daemon/tools.ts`, `src/daemon/daemon.ts`.

Changes:
- `tools.ts`: `TOOLS.mesh_review = { description, input: ReviewRecord.shape }` after `mesh_artifact`;
  description covers the points listed in the spec (hub fingerprints and folds; `key.rule` from the
  agent's declared rules, reuse the previous record's keys; line numbers never matter; dispositions
  belong in a consuming step's record; the record never fails the step). Header comment "thirteen" →
  "fourteen". `MESH_TOOL_RULES` untouched.
- `ToolHost` gains:
  - `git?(cwd: string, args: readonly string[]): Promise<{ code: number; stdout: string; stderr: string }>`;
  - `runOf?(sid: string): { worktree?: string | undefined; agent?: { name: string; key: string; hash: string } | undefined } | undefined`;
  - `reviewStored?(sid: string, undeclaredRules: number): void`.
- `daemon.ts` `toolHost()`: `git: (cwd, args) => (this.deps.headless?.git ?? ((c, a) => run("git", a, { cwd: c, timeoutMs: 30_000 })))(cwd, args)`
  with `run` from `../claude/index.ts` (allowed import; keeps `child_process` out of `src/daemon`);
  `runOf: (sid) => this.runs?.runForSid(sid)`; `reviewStored: (sid, n) => this.runs?.reviewStored(sid, n)`.
  Optional `DaemonDeps.git` override for tests is not needed (World daemons get the default).
- `daemon/tools.ts` `case "mesh_review"` (new private `async function reviewUpload(host, s, args)`):
  1. `!s.step` → `fail("this session holds no step")`.
  2. Root: `run = host.runOf?.(s.sid)`; `root = run?.worktree ?? findRepoRoot(s.cwd)`.
     `commit = subject.commit ?? (root ? (await git(root, ["rev-parse", "HEAD"])).stdout.trim() || undefined : undefined)` (code ≠ 0 → absent).
  3. Agent: `run?.agent?.name`, else `policy.agent` from `contextOf(host, s.step)` (cached context; a
     failure to read it means no agent). Declared rules: read `<root>/.claude/agents/<agent>.md` and
     `<agent>.rules.yaml` with `readFileSync` in `try` (missing → `undefined`); no agent file → empty set.
  4. Each item: `key.rule = mapRule(rule, declared).rule` (count `undeclared`); `key.path` and every
     `evidence[].path` → `normPath(path, root)` (no root → `normPath(path)`).
  5. `eh` per item: for each evidence entry with `lines [a, b]`: `git show <commit>:<path>` in `root`
     (memo per path within the call); failure, no commit, no root, or `a > lineCount` → `null`; else
     lines `a..min(b, lineCount)` joined with `"\n"` (`lineCount` excludes the empty element after a
     final newline). `eh = evidenceHash(regions)`; key absent when `undefined`.
  6. Redaction with `redactSecrets(text, host.secrets?.() ?? [])` on `title`, `category`, `proposal`,
     each `evidence[].note`, `summary`, each disposition `reason`; `redactions` = sum of counts.
  7. Body: record fields (`subject` with `commit` filled), `undeclaredRules`, `redactions`, `agent:
     run.agent ? {key, hash}` (headless only), `sid: s.sid`.
  8. `host.link.rpc<ReviewResult>("POST", \`/v1/steps/${step}/review\`, body, key)`; offline →
     `fail(\`the hub is offline; the review record was not stored. ${OFFLINE_TAIL}\`)` (never queued);
     other hub errors propagate to `runTool`, which returns the hub's text (with details) as a tool error.
  9. On success: `host.reviewStored?.(s.sid, undeclared)`; reply built exactly as the spec's sentence
     sequence (`<k>` = `result.items.length`; Fold sentence when `result.review.fold`; Ignored
     sentence when `result.ignored.length`; undeclared sentence when `> 0`; then ` Finish with mesh_done.`).

Order: after AC-09 (hub route) and B2.

Blast radius: new tool case only; other tools unchanged. The shim lists `mesh_review` automatically
(from `TOOLS`), and `/local/mcp/:tool` accepts every `TOOL_NAMES` entry.

Risks:
- `dispatch` parses args with `z.object(TOOLS[tool].input)` (non-strict at the top level): unknown top
  keys are stripped there, nested objects stay strict; zod errors become `invalid arguments: …`.
- `key.path` and `scope`, `subject`, evidence paths are never redacted (spec).
- A session's `cwd` outside any git repo → no root: paths only normalised, no commit, regions `null`.

## AC-20 Evidence hash end to end

Files: `src/daemon/tools.ts` (AC-19 step 5), `src/core/review.ts` (AC-05). No further change.

Risks: the region is read at `subject.commit` (not the working tree), so the test's c1/c2/c3 commits
drive it; an evidence entry without `lines` contributes no region; a changed `note` never enters `eh`.
`git show` of a path missing at the commit fails → `null` → token `missing`.

## AC-21 Headless runs

Files: `src/daemon/runs.ts`.

Changes:
- `runForSid(sid)`: the running run whose `runSids(run)` has `sid` → `{worktree: run.worktree, agent: run.agent}`.
- `reviewStored(sid, undeclared)`: as `artifactStored`, append `{"undeclaredRules": n}` to
  `reviews.jsonl` of the run.
- `telemetry(run)`: `undeclaredRules` = sum over `reviews.jsonl` lines (0 when the file is missing or
  empty), replacing the constant `0`.
- The agent file (`<worktree>/.claude/agents/<agent>.md`) is read by `mesh_review` from the run's
  worktree (AC-19 step 3), so `mesh-rules` declared there count; `raisedBy` and the decider come from
  the upload's `agent` (`run.agent.key`/`hash`).
- `mesh_done` without a record gets the hub's 409 text as a tool error (no change: `runTool`); when the
  fake then exits, RL-1's close-as-fail posts `fail` → `failed`.

Order: after AC-19.

Risks: `this.read(run, "reviews.jsonl")` must tolerate the missing file (it does for
`artifacts.jsonl`; reuse it).

## AC-22 `mesh_context` inputs `previous` and `dispositions`

Files: `src/hub/service.ts` (`stepInputs`), `src/daemon/tools.ts` (`brief()` unchanged).

Changes: restructure `stepInputs` to walk `p.inputs` **in policy order**:
- Keep `served`, `MAX_ONE`, `MAX_ALL`, the blind/reads filters and a `seen` set for artifact sources;
  an id or `artifacts` adds its sources at that position (sources already served are skipped), so the
  relative order of artifact inputs is as today.
- `previous`: only when `isRaising(step.policy)`: `lineage = lineageOf(goal, step)`; base = last of
  `listReviews({lineage, raising: true, complete: true})` excluding `(step.id, currentRound)`; push
  `{from: base.step, artifact: base.artifact, kind: "review", title: \`previous review record (${base.goal} round ${base.round})\`, content, truncated}`
  with `content = JSON.stringify(base.record)` cut at `MAX_ONE`. Reads the stored record, never the
  artifact content (so retention pruning does not affect it, AC-29).
- `dispositions`: consuming → `run = runOf(step, steps)`, run's record, items it may act on now (rows of
  the record's unique fps with state in `consumes`); raising → `listItems(lineage)` not `resolved`.
  Each as `ItemView` with its history (`itemHistory(lineage)` grouped). None → nothing. Push
  `{from: run?.id ?? step.id, artifact: "items", kind: "review", title: "items and dispositions",
  content: JSON.stringify({lineage, items}), truncated}`.
- `stepInputs` needs the goal: pass it from `context()` (already loaded there).
- The fences of `brief()` (RL-1) already wrap every input, so planted text in an `evidence.note` stays
  between its own fence lines.

Blast radius: steps whose `inputs` list only ids/`artifacts` get the same inputs in the same order.

Risks: `StepInput.kind` is `ArtifactKind`; `"review"` is valid. `artifact: "items"` is a free string.

## AC-23 CLI `mesh items` and the skipped mark

Files: `src/cli/review-commands.ts` (new), `src/cli/hub-commands.ts`, `src/cli/show.ts`.

Changes:
- `itemsCommand(c: CliEnv): Command` — `name: "items"`, `summary: "items of a review lineage: <lineage key | step id> [--all] [--json]"`.
  - Argument containing `|` → lineage. Else step id: `GET /v1/steps/<id>/reviews`; latest record's
    `lineage`; none and the step has `policy.consumes` → `GET /v1/steps/<id>` (step) and
    `GET /v1/goals/<goal>` (steps), `runOf` (core), `GET /v1/steps/<run>/reviews`; still none → stderr
    `<step> has no review record`, exit 1. Hub refusals (404 etc.) → `orRefused` pattern (copy the
    helper or export it from `artifact-commands.ts`).
  - `GET /v1/items?lineage=<encodeURIComponent(key)>`; `--json` prints the reply (`JSON.stringify(r, null, 2)`);
    else filter out `resolved` unless `--all`; none → `No items in <lineage>.`; else one line per item
    `${fp}  ${state}  ${severity}  ${rule}  ${path ?? "-"}  ${title}` in the route's order.
  - No positional → usage on stderr, exit 2 (as `artifact`).
- `hub-commands.ts`: import and add `itemsCommand(c)` after `artifactCommand(c)` (so `mesh help`
  lists it).
- `show.ts`: `MARK` gains `skipped: "↷"`; color: dim (`"2"`) for skipped (cosmetic).

Order: after AC-16 (routes).

Blast radius: `mesh help` output gains one line.

Risks: the `--json` output must be the route's reply unchanged (including resolved items).

## AC-24 No free text in events or the ledger export

Files: `src/hub/service.ts`.

Changes: the payloads of `review.recorded`, `item.disposed`, `step.skipped` carry only the fields
listed in AC-09/AC-13/AC-17 (counts, fps, lineage, states, ids). `describe()` gains timeline texts that
use only those fields:
- `review.recorded` → `recorded a review record for ${s} (round ${round}, ${items} item(s))`;
- `item.disposed` → `${disposition} item ${fp} of ${s}`;
- `step.skipped` → `skipped ${s} (nothing to consume)`.
The skip summary (`step.summary`) names states and the run id only. Nothing else changes for `mesh
ledger export` (it exports events and trail records, neither of which holds record text).

Risks: do not put `summary`, titles, notes, proposals or reasons into any payload or `describe()` text.

## AC-25 Compatibility

Files: none beyond the above. Points to keep while implementing:
- Steps without the new fields: `doneStep`, `decideGate`, `approvePlan`, `resumeStep` produce the same
  states, events and goal done as before (`settle` = `recomputeReady` for them).
- `findings` on a step without `output` still land in `Round.findings` only; the hub never writes
  `Round.findings` from a record.
- `MESH_TOOL_RULES` and the built-in profiles (`core/profiles.ts`) are not touched, so their
  `sha256` stay as in RL-1.
- `TOOLS` gains `mesh_review` only (no `mesh_dispose`).

## AC-26 Idempotency

Files: none new. `POST /v1/steps/:id/review` is a `POST` with an actor, so the existing middleware in
`app.ts` (`IDEMPOTENCY_HEADER`, `getIdem`/`putIdem`) replays the stored 201 reply for the same key
without calling `submitReview` again. The daemon sends the shim's per-call key (`key` argument of
`dispatch`) as `Idempotency-Key` through `host.link.rpc(..., key)`.

Risks: none beyond keeping the `rpc` key argument.

## AC-27 Transactions

Files: `src/hub/service.ts` (`submitReview` in `goalTx`, AC-09).

Changes: none beyond AC-09: `goalTx` calls `store.serialize()` first (Postgres: the `events` lock;
SQLite: `BEGIN IMMEDIATE`), so two calls for the same (step, round) serialise and the second sees the
first record (409); two goals of one lineage serialise and the second reads the first as its fold
base. `addReview` returning `false` is the last guard (409).

## AC-28 Web renders a skipped step

Files: `web/src/styles.css` (optional styling), no TSX change.

Changes: the DAG node already has `className={\`node st-${s.state} …\`}` and shows `{s.state}`; the
step panel already prints `· {step.kind} · {step.repo} · {step.state}`. Add `.dag .st-skipped rect {
stroke-dasharray: 4 3; opacity: .7 }` and `.dag .st-skipped text { fill: var(--muted) }` (use the
existing variables of `styles.css`; check names when editing). `tsc -p web` must still pass with the
wider `StepState` (no exhaustive maps in `web/src` today).

Risks: none functional; `stepStage` (shared) maps `skipped` (AC-07), so stage counts in the web do not
throw `stage skipped is not in the table`.

## AC-29 Retention

Files: none new. `pruneArtifacts` only nulls `artifact.content`; `review_record`, `review_item`,
`item_history` are never pruned, and the `previous` input reads `StoredReview.record` (AC-22).

## AC-30 Docs and skill

Files: `docs/guide/concepts.md`, `docs/guide/howto.md`, `src/protocol/skill.ts`,
`skills/mesh/SKILL.md` (generated), `docs/plan/implementation-plan.md` §5.6, `docs/events.md`.

Changes:
- `concepts.md`: new section "Review records" after "Telemetry" with every topic of the spec's Docs
  row: `output: review-record` and REQ-5, record fields, declared rules (`mesh-rules`,
  `<name>.rules.yaml`, `other:<slug>`), fingerprint, evidence hash, lineage, fold base and marks,
  partial records, item states with the transitions table (design §5.3), dispositions with reason and
  decider, person precedence, `consumes`/`may_set`/`when`, the `skipped` state and when it is
  re-evaluated, the `previous`/`dispositions` inputs (fenced, untrusted).
- `howto.md`: "Review an agent's findings": a plan with a raising headless `audit` and a consuming
  `validate` (`when`, `consumes`, `may_set`), an agent file declaring `mesh-rules`, `mesh items`.
  Generic names only (`alpha`, `auditor`, `validator`).
- `skill.ts`: a `mesh_review` paragraph (when: steps with `output: review-record`, before `mesh_done`;
  record fields; reuse previous keys; declared rules; dispositions only in a consuming step's record;
  the record never fails the step). `pnpm schemas` regenerates `skills/mesh/SKILL.md`.
- Implementation plan §5.6: a row `POST /v1/steps/:id/review`, `GET /v1/steps/:id/reviews`,
  `GET /v1/items?lineage=` | Review records and items (v0.1.16).
- `events.md`: rows for `review.recorded`, `item.disposed`, `step.skipped` with the payload keys.

Risks: no team-, company- or person-specific names; examples use generic repo and agent names.

## AC-31 Version, checks, schemas, boundaries

Files: `package.json`, `schemas/hub-api.openapi.json` and other `schemas/*.json` (generated),
`skills/mesh/SKILL.md` (generated).

Changes:
- `package.json` `version` → `0.1.16`.
- Run `pnpm schemas` after all protocol changes; commit what it rewrites.
- `fingerprint`, `foldItems`, `evidenceHash`, `whenHolds`, `settle` live in `src/core` and import only
  `protocol`, `node:crypto`, `yaml`.
- Full run (with the PATH export of the task): `pnpm lint`, `pnpm typecheck`, `pnpm boundaries`,
  `pnpm test`, `pnpm build` (= `pnpm check`), then `pnpm test:web`.

Risks: the OpenAPI generator (`hub-api.ts`, `z.toJSONSchema(…, { unrepresentable: "any" })`) emits
the `lines` tuple as `prefixItems` and drops the `ReviewEvidence` refinement silently; no generator
change is needed. Defaults (`subject`, `dispositions`, `undeclaredRules`, `redactions`) appear as
optional in the input schema.

## AC-32 `mesh hub migrate`

Files: `src/store/hub-copy.ts`.

Changes: `TABLES` gains, after `profile`: `// RL-2` `{ name: "review_record" }` (rows in rowid
order; Postgres generates `ord`, as for `step`), `{ name: "review_item" }`, `{ name: "item_history",
identity: "seq" }` (copied with `OVERRIDING SYSTEM VALUE`, sequence moved past the max). The
`TRUNCATE … RESTART IDENTITY` list follows from `TABLES`.

Risks: `review_record` has no `ord` column on SQLite, so `PRAGMA table_info` gives exactly the
shared columns; `item_history.seq` exists on both (SQLite `INTEGER PRIMARY KEY AUTOINCREMENT`).

## Existing tests and generated files the developer adjusts

The spec (Compatibility) assigns these to the test-writer; if they are still unchanged when the
implementation lands, the developer adjusts exactly these assertions and nothing else:
- `src/store/hub-store.contract.test.ts` lines ~435, ~440, ~576–578: `SCHEMA_VERSION` and migration
  counts `8` → `9`.
- `test/m46-ops.test.ts` line ~74: `/readyz` `schema: 8` → `9`.
- `test/m2-flow.test.ts` line ~288: the sorted tool list gains `"mesh_review"` (between `mesh_release`
  and the end: sorted order is `…, "mesh_plan", "mesh_release", "mesh_review"`).
- `test/schemas.test.ts` line ~361 (`test_AC34_version`, RL-1): `"0.1.15"` → `"0.1.16"` (the spec
  allows only AC-31 to assert the version; this keeps one assertion with the new value).
- Generated, regenerated with `pnpm schemas` (drift checked by `test/schemas.test.ts`):
  `schemas/hub-api.openapi.json`, any `schemas/ledger-*.json`/`hub-event.json` that change through
  `PlanStep`/`Round`, `skills/mesh/SKILL.md`.
- Snapshots: none expected to change (`src/cli/__snapshots__/show.test.ts.snap` renders no skipped
  step; `MARK` gaining a key does not change existing output). If `mesh help` output is snapshotted
  anywhere, it gains the `items` line.

## Plan-level decisions (2026-11-12)

- **`stepStage("skipped")` = `"done"`.** The stage table must cover every state; a skipped step needs
  no work and counts as finished. `STEP_STAGES` is unchanged.
- **Review artifact and `per_round`.** The record's `review` artifact is not refused by the limits;
  `uploadArtifact`'s per-round count also excludes it (`listArtifacts` minus the id of
  `getReview(step, round)?.artifact`), so a step with a record keeps its full `per_round` for
  `mesh_artifact` uploads.
- **Duplicate fps.** Every copy of a duplicated fp in a record carries the fp's mark; only the first
  copy feeds the fold, the item row and the history.
- **Row fields on dispositions.** Applying a disposition sets only the fields the spec names
  (`state`, `dismissedEh`, `until`, `link`); earlier `until`/`dismissedEh` values stay on the row
  (they are read only in the matching state).
- **Leaving `skipped`.** `settle` and `reopen` change only `state` and `updatedAt` of a step leaving
  `skipped`; the skip `summary` stays until the step is done again (as a reopened done step keeps
  its summary).
- **`holds` precomputation.** The hub computes `holds` for all `when` steps of the goal before calling
  `settle` (item rows do not change during it).
- **Daemon git.** The daemon runs git through `run` of `src/claude` (or the headless runner's `git`
  when present) to respect the process boundary; `subject.commit` uses `git rev-parse HEAD` as the spec says.
- **`mesh items` empty output.** `No items in <lineage>.` is printed when no line would be printed
  (also when only resolved items exist and `--all` is absent).
- **`describe()` texts** for the three new events are added for the timeline; they contain no record
  text.
- **Brief text.** `brief()` and `headlessPrompt` are not changed; the tool description and the skill
  tell the agent about `mesh_review`.

## Checks

This plan is a document only. Checks run for it: none (`pnpm lint`, `pnpm typecheck`,
`pnpm boundaries`, `pnpm test`, `pnpm build`, `pnpm test:web`, `pnpm schemas` were not run; there is no
code change to check).
