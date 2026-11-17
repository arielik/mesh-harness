# RL-9 implementation plan

Spec: `docs/specs/RL-9.md` (approved, review round 3; round-3 suggestions applied). Release v0.1.27.
One section per acceptance criterion (AC-01 .. AC-19); each lists files, changes, order, blast radius
and risks. Tests are not planned here (the test side plans from the spec alone and never sees this
plan). The developer changes no test except the existing ones listed under "Existing tests and
snapshots" at the end, and only where the spec changes the asserted behaviour.

No migration: `SCHEMA_VERSION` stays 11, no `HUB_MIGRATIONS`/`HUB_MIGRATIONS_PG` entry, no new
`HubStore` method. `Goal.sink`, `Step.severity`, `Step.finding` and `requires` live in the JSON
`value` columns. Lookups scan `store.listGoals()` and `store.listSteps({ goal })` as
`calibrationScan` does.

## 0. Build order (all criteria)

Layering as `.dependency-cruiser.cjs` (`protocol` ← nothing; `core` ← `protocol`; `store` ←
`protocol`; `hub` ← `protocol`, `core`, `store`; `cli` ← `core`, `protocol`).

| Stage | Module | Work | Criteria |
|---|---|---|---|
| 1 | `src/protocol` | `goal.ts` (`StepPolicy.sink`, `Goal.sink`, `Step.severity`, `Step.finding`), `review.ts` (`RecordDisposition.requires`, history entry and `DispositionRow.requires`), `hub.ts` (`DisposeRequest.requires`, `SinkRequest`, `SinkResult`, `GoalDrop`), `hub-api.ts` (two routes) | all |
| 2 | `src/store/hub-store.ts` | `listDispositions` copies `requires` | AC-04 |
| 3 | `src/core` | `policy.ts` (`policyOf` copies and normalises `sink`; `validatePolicies` sink rule), `presets.ts` (`instantiate` normalises `sink.topic`), new `findings.ts` (ids, title, brief, ready refill, counts, cycle test), `index.ts` export | AC-01, AC-11, AC-12, AC-13, AC-16, AC-17 |
| 4 | `src/hub/service.ts` | `requires` checks and storage; `goalComplete(goal, steps)`; `proposePlan` 409; sink topic checks; sink engine (B3); sink trigger in every settle path; item → step sync in fold, `applyDisposition`, `revertDisposition`; `dropGoalByPerson`; `sinkItems`; ready refill in `listSteps`; `describe()` texts | AC-01 .. AC-15 |
| 5 | `src/hub/app.ts` | `POST /v1/goals/:id/drop`, `POST /v1/items/sink` | AC-14, AC-15 |
| 6 | `src/cli` | `hub-commands.ts` (`mesh goal drop`), `review-commands.ts` (`mesh items sink`), `show.ts` (header line, finding titles) | AC-13 .. AC-16 |
| 7 | repo | docs, `MESH_SKILL`, tool descriptions, `pnpm schemas`, `package.json` 0.1.27, the version test, `pnpm check` | AC-18, AC-19 |

Order constraints (global):
- Stage 1 first. `Goal`, `Step` and `DispositionRow` are non-strict `z.object`s: a field missing from
  the schema is stripped silently on read (`Goal.parse` in `getGoal`/`listGoals`, `Step.parse` in
  `listSteps`), so the data would be lost without an error. `RecordDisposition` and
  `DisposeRequest` are `.strict()`: without the field every `requires` is a 400.
- Stage 2 with stage 1: `listDispositions` builds each `DispositionRow` field by field, so
  `requires` must be copied there explicitly or the sink never sees it.
- Stage 3 before stage 4 (the service only decides from and writes what the pure helpers compute).
- Inside stage 4: B3 (the sink engine) before the trigger hooks (AC-01, AC-09) and before
  `sinkItems` (AC-15); the sync helpers (B4) before the fold, dispose and revert hooks.
- `pnpm schemas` after the last change to `src/protocol` (`HUB_API`, `StepPolicy`,
  `RecordDisposition`, `DisposeRequest`, `MESH_SKILL`); docs and the version bump last.

## 1. Shared building blocks

**B1. Protocol.**
- `src/protocol/goal.ts`:
  - `StepPolicy` gains `sink: z.object({ topic: z.string().min(1).max(40) }).strict().optional()`
    (comment: RL-9, items filed in the run go to the clean-audit goal of `(repo, topic)`). It is
    spread into `PlanStep` and so into `PresetStep`; `POLICY_KEYS` picks it up automatically.
  - `Goal` gains `sink: z.object({ repo: z.string(), topic: z.string() }).optional()` (set only on
    clean-audit goals).
  - `Step` gains `severity: Severity.optional()` (import `Severity` from `./review.ts`, already
    imported module) and `finding: z.object({ lineage: z.string(), fp: z.string() }).optional()`.
- `src/protocol/review.ts`:
  - A local `const Fp = z.string().regex(/^[a-z2-7]{16}$/, …)` (same text as `fingerprint`), and
    `RecordDisposition` gains `requires: z.array(Fp).min(1).max(20).optional()`.
  - `DispositionEntry` (history) and `DispositionRow` gain `requires: z.array(z.string()).optional()`.
- `src/protocol/hub.ts`:
  - `DisposeRequest` gains `requires: z.array(Fingerprint).min(1).max(20).optional()`.
  - `GoalDrop = z.object({ reason: z.string().min(1).max(2000).optional() }).strict()`.
  - `SinkRequest = z.object({ lineage: z.string().min(1).max(600), topic: z.string().min(1).max(100), min_severity: Severity.optional(), dry_run: z.boolean().optional() }).strict()`
    (topic syntax is the service's 400, not the schema's, so the length cap is loose).
  - `interface SinkResult { goal: string | null; added: string[]; reopened: string[]; skipped: number; notes: string[] }`.
  - `src/protocol/index.ts` already re-exports these files.
- `src/protocol/hub-api.ts`: import `GoalDrop`, `SinkRequest`; rows
  `{ method: "POST", path: "/v1/goals/:id/drop", rule: "member", scope: "goals:write", tag: "goals", body: GoalDrop, summary: "Drop a goal (its owner, an approver or an admin); no step may be held." }`
  and `{ method: "POST", path: "/v1/items/sink", rule: "member", scope: "goals:write", tag: "goals", body: SinkRequest, summary: "Add a lineage's filed items to the clean-audit goal of (repo, topic) (backfill)." }`.

**B2. Core `src/core/findings.ts`** (new; `export * from "./findings.ts"` in `src/core/index.ts`).
Pure; imports types from `../protocol/index.ts`, `base32`, `repoName`, `SEVERITY_RANK` from
`./review.ts`, `createHash` from `node:crypto` (as `review.ts` does).
- `findingStepId(lineage: string, fp: string): string` →
  `"f-" + base32(sha256(\`${lineage}|${fp}\`)).toLowerCase().slice(0, 16)` (local id, 18
  characters, matches `localId`). The full id is `${goal}.${findingStepId(…)}`.
- `cutTitle(text: string, max = 200): string` → `text` when `length <= max`, else
  `text.slice(0, max - 1) + "…"` (the last kept character replaced by `…`; result exactly `max`).
- `findingTitle(severity: Severity, title: string): string` → `cutTitle(\`[${severity}] ${title}\`)`.
- `lineageRepo(lineage: string): string` → the text between the first and the last `|`.
- `FINDING_BRIEF_MAX = 8000`; `findingLastLine(lineage)` =
  `When the fix lands, the next audit of ${lineage} resolves this finding; do not edit the tracking row.`
- `findingBrief(o: { lineage; item: ItemRow; evidence: ReviewEvidence[]; proposal?: string; reasons: string[] }): string`:
  lines `Finding ${fp} of ${lineage} (${severity}, ${category})`, `rule: …`, `path: …` (when set),
  `symbol: …` (when set), `evidence:` with one `- path[:a-b]` line each plus its note, `proposal:`
  block (when set), `link: …`, `dispositions:` with the reasons, then the last line. When the whole
  text exceeds 8000: `head = body.slice(0, 8000 - tail.length)` where
  `tail = "\n… (cut; mesh items " + lineage + ")\n" + lastLine`; result `head + tail` (≤ 8000, ends
  with the last line). Avoid cutting inside a surrogate pair (drop a trailing high surrogate).
- `refillBySeverity(steps: readonly Step[]): Step[]` (the ready-order rule, one part): for each goal,
  collect the indexes of its finding steps (`finding !== undefined && severity !== undefined`), sort
  those steps stably by `SEVERITY_RANK[severity]` (ties keep their previous order), write them back
  into the same indexes. Other steps never move.
- `sinkCounts(steps: readonly Step[]): { open: Record<Severity, number>; done: number; dropped: number }`
  over finding steps: open = state not `done`, `skipped`, `dropped`, counted by severity.
- `closesCycle(deps: ReadonlyMap<string, readonly string[]>, from: string, to: string): boolean`:
  true when `from === to` or `to` reaches `from` through `deps` (iterative DFS with a seen set).

**B3. Sink engine (`src/hub/service.ts`, all inside the caller's `goalTx`).**
- `private async cleanAuditGoal(repo: string, topic: string): Promise<Goal | undefined>`:
  `(await this.store.listGoals()).find((g) => g.sink?.repo === repo && g.sink.topic === topic && g.state !== "dropped")`.
  Exact string compare (spec).
- `private async filedItems(lineage: string, goalId?: string): Promise<{ row: ItemRow; requires: string[] }[]>`:
  `listItems(lineage)` with `state === "accepted" && link !== undefined`; when `goalId` is given,
  keep only items whose last `accepted` row of `listDispositions({ lineage })` (grouped by fp, one
  read) has `goal === goalId` (any decider); `requires` = union, in order, of `requires` over that
  item's `accepted` rows with `goal === goalId` (empty without `goalId`). Sorted with `byItemOrder`
  (severity, first seen, fp) so creation order is deterministic.
- `private async itemEvidence(lineage, fp)`: the newest `listReviews({ lineage, raising: true })`
  record that has the fp → `{ evidence, proposal }` of its first item with that fp (else `[]`).
- `private async decideSink(o: { repo; topic; items; owner; from; deps: boolean; minRank?: number }): Promise<SinkPlan>`
  decides everything in memory, writes nothing:
  - `goal` = `cleanAuditGoal(repo, topic)`; `existing` = its steps (`listSteps({ goal })`) or `[]`.
  - Per item (rank filter when `minRank`): `local = findingStepId(item.lineage, fp)`, `cur` =
    existing step with that local id (and `finding.lineage/fp` equal; an id with another `finding`
    would be a hash clash: treat as covered and add a note, never overwrite).
    - none → **create** (rule 2) with `brief` from `findingBrief` (reasons from `itemHistory` of
      kind `disposition`: `<disposition> by <decider>: <reason>`), `title` from `findingTitle`,
      `kind: "implement"`, `repo`, `severity`, `finding`, `policy: { worktree: true }`,
      `planVersion: 1`, `deps: []`, `state: "blocked"`, `fixCycles: 0`.
    - `done` or `dropped` → **reopen** (rule 3): `state: "blocked"`, `fixCycles + 1`, title and
      severity updated; delete `outcome`, `summary`, `holderUser`, `holderSid`, `holderMachine`,
      `claimedAt`, `pausedAt`, `roundStartedAt`, `parkedReason`, `parkedAt`; drop an `accepted`
      offer (as `dag.reopen`); `rounds` kept; note `refiled by <from>`.
    - `ready`/`blocked` → update title and severity (rule 4), count `skipped`.
    - `claimed`/`paused`/`parked`/`failed` → note `refiled by <from> (<severity>)`, count `skipped`.
    - `skipped` or anything else → nothing, count `skipped`.
  - Deps (rule 5, only when `deps`): after all creates/reopens exist in the in-memory map, for each
    created or reopened step in item order: resolve each `requires` fp to `<G>.<findingStepId(item lineage, fp)>`
    if present; else the single step of the goal whose `finding.fp === fp`; else note
    `requires <fp>: not in this goal` (or `… : ambiguous` when several lineages have it). Skip a dep
    already present. `closesCycle(depsMap, stepId, depId)` → note `requires <fp>: cycle`; else add
    the dep and update `depsMap` at once (later checks see it). A created step's deps are the
    resolved list; a reopened step keeps its deps and adds.
  - State: run core `settle` (holds `() => true`; finding steps have no `when`) over the goal's
    whole in-memory step list; created/reopened steps come out `ready` or `blocked`; a `ready`
    dependant of a reopened step may go back to `blocked` (see AC-06 risks).
  - The new goal's id is unknown before `createGoal`: decide with local ids and a placeholder
    prefix, map to `<G>.<local>` after the goal exists (deps too).
- `private async writeSink(plan: SinkPlan, now): Promise<SinkResult>` writes in this order:
  1. no goal → `store.createGoal({ title: \`Clean audits: ${topic} on ${repoName(repo)}\`, ownerId: owner, state: "in_progress", primaryRepo: repo, topics: [topic], sink: { repo, topic }, priority: 3, createdAt, updatedAt })`
     (not `createGoal` of the service: no design step), `savePlan({ goal, version: 1, steps: [], proposedBy: owner, proposedAt: now, decision: "approved", decidedBy: owner, decidedAt: now })`,
     event `goal.created` `user: owner`, payload `{ title, sink: { repo, topic } }`.
     `validatePlan` is not run (it refuses `steps: []`).
  2. `endOffersLeavingReady(existing, changed, now)` then `store.saveSteps(...)`; `emitOffersEnded`.
  3. notes (`store.addNote`, `user` = goal owner) and `step.noted` events.
  4. per reopened step: `step.reopened` `user: owner`, payload `{ by: owner, reason, fixCycles, from }`.
  5. `emitReady` for every changed step that is `ready` now (a stick may offer it).
  6. `goal.sunk` (only when `added` or `reopened` is non-empty): event `goal` = the clean-audit goal,
     `step` = `from` when it is a step id, payload `{ goal, from, added, reopened }`.
- `private async runSink(relayGoal: Goal, sinkStep: Step, steps: readonly Step[], now)`: the trigger
  body (AC-01, AC-09, AC-10):
  1. Pre-check (before any write): `topic = sinkStep.policy.sink.topic` (normalised);
     `await this.store.getTopic(topic)` missing → note on the sink stage `sink failed: topic ${topic} is not defined`
     (`user` = relay goal owner), `step.noted`, event `goal.sink_failed` (`goal` = relay goal,
     `step` = sink step, payload `{ from: sinkStep.id, reason }`), return.
  2. `run = runOf(sinkStep, steps, (s) => s.policy)`; none → return silently (validation makes it
     impossible). `lineage = lineageOf(relayGoal, run)`, `repo = lineageRepo(lineage)`.
  3. `items = filedItems(lineage, relayGoal.id)`; empty → return (no event).
  4. `decideSink({ repo, topic, items, owner: relayGoal.ownerId, from: sinkStep.id, deps: true })`,
     then `writeSink`.
- `private async sinkAfter(relayGoal: Goal, steps: readonly Step[], ids: Iterable<string>, now)`:
  for each id whose step (from `steps`) has `policy.sink` and state `done` or `skipped`, `runSink`.

**B4. Item → step sync (`src/hub/service.ts`, inside the caller's transaction).**
- `private async findingStepsOf(lineage, fp): Promise<{ goal: Goal; step: Step }[]>`: every goal
  with `sink?.repo === lineageRepo(lineage)` and `state !== "dropped"`, and its step
  `${goal.id}.${findingStepId(lineage, fp)}` when it exists (`getStep`).
- `private async closeFinding(goal, step, o: { state: "done" | "dropped"; summary; by; event; payload }, now)`:
  for `ready`/`blocked` only: save with `state`, `summary`, `outcome: "done"` for done, delete
  holder fields; settle the goal's steps (core `settle`) and save the changes with
  `endOffersLeavingReady`; emit `step.done` (`user: by`, payload `{ summary }`) or `step.dropped`
  (`user: by`, payload `{ reason }`); `emitReady` for dependants now ready. No `Round` is added.
- `private async noteFinding(step, text, by, now)`: `addNote` + `step.noted`.
- `private async reopenFinding(goal, step, o: { reason: "reverted"; from; by }, now)`: as rule 3
  without new deps (deps unchanged), settle, save, `step.reopened` payload `{ by, reason, fixCycles, from }`,
  note `reverted by <from>` (the debrief step), `emitReady`.
- `by` (spec "Events of the sync carry by"): the decider's user for a person decider, else the
  goal owner (agent decider or a fold).

## 2. Choices where the spec leaves room

1. **Topic normalisation** ("stored as `ci`"): trimmed and lowercased in three places so every
   stored copy is lowercase: `instantiate` (preset paths: pulses, ingest, `mesh goal plan --preset`),
   `proposePlan` (plan steps before `savePlan`) and `policyOf` (the step's policy). The topic check
   (`topicName`) runs on the raw text, so an unfilled `{topic}` gives `bad topic "{topic}"`.
2. **Order of refusals.** A plan or preset with both a 422 problem and a bad sink topic gets the 422
   (the aggregate is thrown first); the 400 topic check runs after it.
3. **`proposePlan` on a sink goal**: the 409 is checked first, before the `done`/`dropped` state
   check and before any validation.
4. **Header repo** (`mesh show`): `repoName(sink.repo)`, as the goal title uses, so a path-like repo
   string shows its last segment.
5. **Backfill `from`**: the text `mesh items sink` (no step id), used in notes and in `goal.sunk`
   (`step` left unset). `SinkResult.notes` lists every note text the call wrote (or would write).
   `skipped` counts filed items at or above `min_severity` that were left unchanged (rule 4 or an
   unlisted state).
6. **Dry-run count**: `would add <n>` with `n = added.length` (reopened ones are not "added"; the
   reply still lists them). Wet output `<G>: added <n>, reopened <m>`.
7. **`goal.sunk` activity**: `<n> findings from <from> (<m> reopened)` with
   `n = added + reopened`, `m = reopened`.
8. **Within one sink event** steps are created in `byItemOrder` (severity, first seen, fp).
9. **Revert row "the debrief disposition that dropped the step"**: on a revert whose reverted
   disposition is `dismissed` or `deferred` and that leaves the item filed (`accepted` with `link`),
   a `dropped` finding step of `(lineage, fp)` in a non-dropped clean-audit goal is reopened. The
   hub keeps no pointer from the step to the disposition; the revert is only allowed while that
   disposition is the item's latest change, so a dropped step at that moment was dropped by it.
10. **Pulse `goal.dropped` payload** stays `{ reason }`; the person drop adds `by` and `comment`.
11. **Lineage of the backfill's newest goal**: the goal with the largest `createdAt` among the goals
   of `listReviews({ lineage })`.
12. **The sink pre-check** covers the topic only (the spec's one named check).

---

## AC-01 Relay run 1 opens the goal and adds steps

**Files.** `src/protocol/goal.ts`, `src/core/findings.ts`, `src/core/policy.ts`,
`src/hub/service.ts`.

**Changes.**
- B1, B2, B3 as above.
- `policyOf`: add `"sink"` to its key list; when present, copy as
  `{ topic: sink.topic.trim().toLowerCase() }`.
- `doneStep`: after `emitSkipped(...)` and before the goal-complete block, call
  `await this.sinkAfter(goal, steps, [r.step.id, ...settled.skipped], now)` (the finished step only
  counts when `outcome === "done"`; `sinkAfter` checks the state). `steps` is the in-memory final
  list already computed there.
- Goal standing (also AC-08): `goalComplete` becomes
  `private static goalComplete(goal: Pick<Goal, "sink">, steps)` returning `false` when `goal.sink`;
  update the five callers (`applyApproved`, `doneStep`, `decideGate`, `resumeStep`; `applyApproved`
  passes `fresh ?? goal`). A finding step finished by `mesh_done` runs `doneStep` in the clean-audit
  goal and must not mark it done.
- `describe()`: `goal.sunk` → `${n} findings from ${from} (${m} reopened)`; `goal.created` with
  `sink` keeps `created <G> "<title>"`.

**Order.** After stages 1-3. The `goalComplete` change before any finding step can be finished.

**Blast radius.** Every `doneStep` of a step with `sink` (new) and every goal-complete decision
(unchanged for goals without `sink`). Goal creation by the hub without a design step and without a
preset.

**Risks.**
- `store.createGoal` opens its own `tx` with lock `goals` inside the caller's `goalTx`; the same
  nesting already works in `createWithPlan` (calibration trigger), on SQLite and Postgres.
- A clean-audit goal has plan v1 with `steps: []`. Nothing may ever `materialize` it: a later
  approved plan would drop every finding step (steps not in the plan are dropped). `proposePlan`
  refuses (AC-08); `approvePlan` finds no pending plan (404); `replan` finds no design step (404).
  Keep it that way; do not add a design step.
- `GoalDetail`, `goalYaml` and `recordOf` for a goal with `steps: []` in v1 and steps saved
  directly: check `goalFiles` does not throw on steps whose `planVersion` plan has no such step
  (`context()` reads `plan.acs`, which is absent: fine).

## AC-02 Run 2 adds only the newly filed item

**Files.** `src/hub/service.ts` (B3 `filedItems`, rules 2 and 4).

**Changes.** None beyond B3: "filed in the goal" keys on the item's **latest** `accepted` row being
in the sink stage's goal, so A and B (accepted in run 1's goal, raised again as `repeat` and still
filed) are not considered by run 2's sink. Only C gets a step. No `savePlan` call after the goal's
creation.

**Order.** With AC-01.

**Blast radius.** None beyond AC-01.

**Risks.** The latest `accepted` row is read from `listDispositions({ lineage })` in seq order;
reverted entries are not filtered (an RL-4 revert writes a `revert` history entry, not a disposition
row). A reverted `accepted` leaves the item un-filed anyway (state not `accepted`), so it is not
picked up.

## AC-03 Two lineages, one goal

**Files.** `src/core/findings.ts` (`findingStepId`), `src/hub/service.ts`.

**Changes.** None beyond B2/B3/B4: the id hashes `<lineage>|<fp>`; `cleanAuditGoal` keys on
`(repo, topic)` only, so a second preset on the same repo with the same topic shares the goal; the
fold sync (AC-05) looks up `findingStepId(lineage, fp)` of its own lineage only.

**Order.** With AC-01.

**Blast radius / risks.** `lineageRepo` must return the same string for both lineages (both are
`lineageOf` of a step whose `repo` is the preset's `{repo}`): exact compare, as the spec says.

## AC-04 Deps and `requires`

**Files.** `src/protocol/review.ts`, `src/protocol/hub.ts`, `src/store/hub-store.ts`,
`src/hub/service.ts`, `src/core/findings.ts` (`closesCycle`).

**Changes.**
- Protocol: B1 (`requires` on `RecordDisposition`, `DisposeRequest`, the history entry and the row).
- `hub-store.ts` `listDispositions`: add `...(e.requires !== undefined ? { requires: e.requires } : {})`
  to the row it builds.
- `applyDisposition`: `d` gains `requires` in its `Pick`; the history entry and the returned row
  carry `...(d.requires?.length ? { requires: d.requires } : {})`. Written only when present, so
  existing rows and strict comparisons are unchanged.
- `submitReview`: in the per-disposition check, first
  `if (d.requires && d.disposition !== "accepted") problem = "requires is only for accepted"`
  (before the `may_set` check), so the whole record is refused with today's 422
  `the review record has N problem(s): disposition of <fp>: requires is only for accepted`.
- `disposeStep`: first check `if (b.requires && b.disposition !== "accepted") throw new HubError(422, "requires is only for accepted")`;
  `applyDisposition(..., b, ...)` passes `requires` through (the body is the `d`).
- Resolution, notes and cycle test in `decideSink` (B3 deps). A `requires` is never refused for
  what it names.
- AC-04's "E's step done → D's step ready": a person's `mesh_done` on E runs `doneStep` in the
  clean-audit goal; its existing `settleSteps` makes D `ready` (no change).

**Order.** Protocol and store before the service.

**Blast radius.** The `mesh_review` and `mesh_dispose` tool schemas (`ReviewRecord.shape`,
`DisposeRequest.omit(...)`) gain `requires`; the daemon (`reviewUpload`, `mesh_dispose`) spreads the
dispositions through unchanged, so no daemon change.

**Risks.**
- `ItemHistoryEntry` is `HistoryBase.and(discriminatedUnion(...))`; adding the optional field to
  `DispositionEntry` keeps older rows parsing.
- The cycle case of AC-04 needs E reopened with new deps while D already depends on E: the check
  must use the in-memory deps after this event's additions (B3), not the stored ones.

## AC-05 Resolved closes; held steps get a note; partial records change nothing

**Files.** `src/hub/service.ts` (`submitReview`, B4).

**Changes.**
- In `submitReview`, after the `for (const fp of f.resolved)` loop (only reached for a complete
  record with a fold base): for each resolved fp, for each `findingStepsOf(lineage, fp)`:
  `ready`/`blocked` → `closeFinding(state "done", summary \`resolved by ${step.id}\`, by goal owner)`;
  `claimed`/`paused`/`parked`/`failed` → `noteFinding(\`resolved by ${step.id}\`)`; else nothing.
- In the same place, for fps with mark `repeat` or `regression` whose finding step is `done` →
  note `raised again by ${step.id}` (table row "raised again").
- A partial record gives `f.resolved = []` (`foldItems` only resolves when `complete`), so nothing
  is closed.

**Order.** After B4.

**Blast radius.** Every complete raising record whose lineage repo has a clean-audit goal. Records
of repos without one do one `listGoals()` scan more.

**Risks.**
- The sync runs inside `submitReview`'s `goalTx`, before the review row is stored; a store error
  fails the record as any store error does.
- Settling the clean-audit goal after a close may make dependants ready and offer them through a
  stick (`emitReady`); intended ("unblock their dependants").

## AC-06 Refiled reopens

**Files.** `src/hub/service.ts` (B3 rule 3).

**Changes.** None beyond B3: a `done` finding step covered again by a filed item is reopened with
`fixCycles + 1`, `step.reopened` reason `refiled` with `from`, note `refiled by <sink step id>`.
`dag.reopen` is not used, so done dependants stay `done`.

**Order.** With AC-01.

**Blast radius.** Only finding steps.

**Risks.** `settle` turns a `ready` dependant of the reopened step back to `blocked` (a dep is no
longer satisfied). The spec only protects done dependants ("not reopened"); a ready one waiting
again is the existing settle rule. A `claimed` dependant is never touched.

## AC-07 Dismissed or deferred later; debrief revert

**Files.** `src/hub/service.ts` (`applyDisposition`, `revertDisposition`, B4).

**Changes.**
- `applyDisposition`: after `saveItem`/`addItemHistory`, when `d.disposition` is `dismissed` or
  `deferred`: for each `findingStepsOf(lineage, fp)`, with
  `text = \`${d.disposition} by ${deciderText}: ${d.reason}\`` (`deciderText` = the person's user,
  or the agent key for an agent decider; `by` = the person's user or the goal owner):
  `ready`/`blocked` → `closeFinding(state "dropped", summary text, payload { reason: d.disposition })`;
  `claimed`/`paused`/`parked`/`failed` → `noteFinding(text)`; else nothing. Both callers
  (`submitReview`, `disposeStep`) get it.
- `revertDisposition`, after the history entry is written (needs `step.id` of the debrief and
  `actor.userId`):
  - reverted `d.disposition` is `dismissed` or `deferred` and `next.state === "accepted" && next.link`
    (filed again) → each `dropped` finding step of `(d.lineage, fp)` →
    `reopenFinding(reason "reverted", from: step.id, by: actor.userId)` with its deps unchanged;
    note `reverted by ${step.id}`.
  - reverted `d.disposition === "accepted"` and the item is no longer filed → `ready`/`blocked`
    finding steps → `closeFinding(state "dropped", summary \`reverted by ${actor.userId}\`, payload { reason: "reverted" })`;
    held or `failed` → note `reverted by ${actor.userId}`.
- `describe()` `step.dropped`: add `dismissed`, `deferred`, `reverted`, `person` texts
  (`${s} dropped: its finding was dismissed` etc.); `abandoned`/`missed` texts unchanged.

**Order.** After B4.

**Blast radius.** Every dismissal and deferral (stage records and debriefs) and every revert of a
debrief disposition, whenever the lineage repo has a clean-audit goal.

**Risks.**
- `isRevertable` reads the item's last history entry; the sync writes notes and step rows only,
  never item history, so a later revert stays possible (the reviewer's point in r3).
- Revert keeps the row's `link` (`{ ...row, state: to }`), so a reverted dismissal of a filed item
  leaves it `accepted` with its link (filed) as the spec assumes.
- See choice 9 for identifying "the disposition that dropped the step".

## AC-08 Standing goal; `mesh goal plan` refused

**Files.** `src/hub/service.ts` (`goalComplete`, `proposePlan`).

**Changes.**
- `goalComplete` as in AC-01.
- `proposePlan`: first statement after `goalOr404`:
  `if (goal.sink) throw new HubError(409, \`${goal.id} is a clean-audit goal; its steps come from audits\`)`,
  before the state check and before `validatePlan`/`validatePolicies`/`pinAgents`.

**Order.** Independent of the sink engine.

**Blast radius.** Only goals with `sink`.

**Risks.**
- `mesh goal plan <G> --file x.yaml` parses the file with `PlanInput.parse` in the CLI
  (`readPlan`). A file that fails the zod schema (a missing `brief`, a bad id) fails in the CLI
  before any request, so it can never get the 409. The hub-side guarantee holds for any plan that
  reaches it (one that fails `validatePlan`, e.g. an unknown dep or a cycle). If the test's invalid
  plan is schema-invalid, the developer does not change the test; record it in the spec's Open
  questions and report it.
- The app's `body(c, ProposePlan)` parse runs before the service: a body that fails `ProposePlan`
  over HTTP is a 400 before the 409, for the same reason.

## AC-09 Skipped sink stage still sinks

**Files.** `src/hub/service.ts` (`applyApproved`, `decideGate`, `resumeStep`, `doneStep`).

**Changes.** Call `sinkAfter` for every step that `settleSteps` skipped, in each path that settles:
- `doneStep`: already (AC-01: `settled.skipped`). AC-09 is this path (the debrief's `mesh_done`
  settles `file` to `skipped`).
- `decideGate`: after `emitSkipped`, `sinkAfter(goal, steps, settled.skipped, now)`.
- `resumeStep`: after `emitSkipped`, `sinkAfter(goal, after, settled.skipped, now)`.
- `applyApproved` (approve and `createWithPlan`): after `emitSkipped`, with `finalSteps`.
- "Reopen" is covered: `doneStep` runs `dag.reopen` then `settleSteps`, so a skip there is in
  `settled.skipped`.

**Order.** After AC-01.

**Blast radius.** Steps with `sink` only.

**Risks.**
- F is filed by the debrief's `mesh_dispose` (`accepted` with `link`) in the same goal, so it is
  "filed in the goal" even though `file` never ran; `filedItems` must not require the sink stage
  itself to have decided.
- A sink stage `done` and later reopened and done again sinks again; idempotent (covered items are
  rule 4).

## AC-10 Sink never fails the filer

**Files.** `src/hub/service.ts` (`runSink` pre-check).

**Changes.** B3 `runSink` step 1. `deleteTopic` is unchanged (it leaves `Goal.sink` and only
removes the tag; the clean-audit goal of `(repo, ci)` stays findable by `sink.topic`).
`describe()` `goal.sink_failed` → `sink of ${from} failed: ${reason}`.

**Order.** With AC-01.

**Blast radius.** None beyond the sink stage.

**Risks.**
- Everything after the pre-check is decided in memory (`decideSink`) before `writeSink`, so no rule
  can fail half-way; only a store error can, and that fails the caller's transaction as today.
- The note and event are written in the caller's transaction: if the caller's own change fails
  later in the transaction they roll back with it (intended).

## AC-11 Checks of `sink`

**Files.** `src/core/policy.ts`, `src/core/presets.ts`, `src/hub/service.ts`.

**Changes.**
- `validatePolicies`: for each step with `sink` (checked before the gate `continue`):
  `if (!s.may_set?.includes("accepted")) errors.push(\`sink in step ${s.id} needs a stage that may set accepted\`)`.
  Runs in `proposePlan` (422 `the plan has …`) and `presetChecks` (422 `the preset has …`, pulse
  add/update and ingest).
- `instantiate`: after filling, for each step with `sink`, set `sink.topic` to the trimmed,
  lowercased text (choice 1).
- New `private async checkSinkTopics(steps: readonly PlanStep[]): Promise<void>` in the service:
  per step with `sink`: `name = topicName(sink.topic)` (400 `bad topic "<raw>": …` for a bad name,
  which is what an unfilled `{topic}` gets); `name === ALL_TOPIC || !(await this.store.getTopic(name))`
  → `400 unknown topic ${name} (define with: mesh topic add <name>)` (the `knownTopics` text;
  `knownTopics` itself silently drops `all`, so it is not reused). Then write `sink.topic = name`.
- Call it in `proposePlan` right after the 422 `errors` throw, and in `presetChecks` right after
  the final `if (problems.length) fail()`.

**Order.** Core before service.

**Blast radius.** Plans and presets with `sink` only; `instantiate` changes no other field.

**Risks.**
- `mesh goal plan --preset … --params topic=CI` instantiates in the CLI; with the `instantiate`
  change the CLI already sends `ci`. `mesh pulse add` sends the preset text and params; the hub's
  `presetChecks` instantiates. Both reach the same checks.
- A pulse made while the topic existed fires later through `createWithPlan`, which does not run
  `presetChecks`; a topic deleted in between is AC-10's case (sink failed note), not a fire error.

## AC-12 Truncation of title and brief

**Files.** `src/core/findings.ts`.

**Changes.** `findingTitle`/`cutTitle` and `findingBrief` as in B2. An item title of 200 characters
plus `[S1] ` is 205 → cut to 200 ending in `…`. The brief keeps the last line and puts
`… (cut; mesh items <lineage>)` before it.

**Order.** Stage 3.

**Blast radius.** Finding steps only.

**Risks.** `Step.brief` has no schema cap; `PlanStep.brief` has 8000. Finding steps never go
through `PlanStep`, but keep the 8000 cap so `mesh_context` and the trail stay bounded.

## AC-13 Ready order

**Files.** `src/core/findings.ts` (`refillBySeverity`), `src/hub/service.ts` (`listSteps`).

**Changes.** In `listSteps`, when `filter.ready`:
- with a viewer: `steps = [...refillBySeverity(steps.filter(here)), ...refillBySeverity(steps.filter((s) => !here(s)))]`
  (replacing today's concatenation; the filter of offers to other machines stays before it);
- without a viewer: `steps = refillBySeverity(steps)`.
Nothing else changes, so `mesh next`, `mesh_next` (daemon `tools.ts` `GET /v1/steps?ready=1`) and
the TUI see the new order. `mesh next --repo` filters client-side and keeps the order.

**Order.** After stage 3.

**Blast radius.** Ready lists that contain finding steps; every other list is returned as today
(a goal without finding steps has no index to refill).

**Risks.** "Previous order" is the store order (`rowid` on SQLite, `ord` on Postgres, insertion
order). `saveSteps` upserts with `ON CONFLICT DO UPDATE`, which keeps the row and its order, so a
reopened finding step keeps its original place.

## AC-14 `mesh goal drop`

**Files.** `src/hub/service.ts`, `src/hub/app.ts`, `src/protocol/hub.ts`, `src/protocol/hub-api.ts`,
`src/cli/hub-commands.ts`.

**Changes.**
- `dropGoal(goalId, reason: "abandoned" | "missed" | "person", now, o: { by?: string; comment?: string } = {})`:
  `goal.dropped` gets `user: o.by` and payload `{ reason, ...(o.by ? { by } : {}), ...(o.comment ? { comment } : {}) }`;
  `step.dropped` `user: o.by`, payload `{ reason }`. Pulse calls unchanged (no `o`).
- New `async dropGoalByPerson(actor: Actor, id: string, reason: string | undefined): Promise<Goal>`
  in `goalTx`: `goalOr404` (404); `!canApprove(actor, goal.ownerId)` → 403
  `only the goal owner, approvers or admins can drop ${goal.id}`; `done`/`dropped` → 409
  `${goal.id} is ${goal.state}`; held = steps `claimed` or `paused` → 409
  `${goal.id} has held steps: ${ids.join(", ")}; release them first`; else
  `dropGoal(goal.id, "person", now, { by: actor.userId, comment: reason })` and return the stored goal.
  Parked steps are dropped (they are not in `dropGoal`'s skip list).
- `app.ts`: `r("POST", "/v1/goals/:id/drop", "member", async (c, a) => c.json(await svc.dropGoalByPerson(a, param(c, "id"), (await body(c, GoalDrop)).reason)), "goals:write")`.
- `hub-commands.ts` `goalCommand`: usage line `mesh goal drop <G> [--reason "…"]`; add `"reason"`
  to the `parseArgs` value flags; case `drop`: POST, print `Dropped ${id}` (use the reply's
  `goal.id`), summary text gains `drop`.
- "A later sink opens a new goal": `cleanAuditGoal` skips dropped goals (B3).
- A pulse's goal: the slot is untouched by `dropGoal`; the overlap rule already skips dropped
  goals (`fireSlot`). A calibration goal: `calibrationStatus` ignores dropped goals, which releases
  its dismissals (no new code).

**Order.** Protocol and route row before `app.ts` (the served = documented test).

**Blast radius.** One new route; `dropGoal` signature (two pulse callers, unchanged behaviour).

**Risks.**
- `canApprove` is owner, approver or admin, as the spec states. Do not use `isOwnerOrAdmin`.
- The description of `goal.dropped` (`${s} dropped (${reason})`) already reads well for `person`.
- Offers of dropped steps are withdrawn by `dropGoal` (`emitOffersEnded(undefined, …)`); pass the
  actor instead so the withdrawal events carry the user.

## AC-15 Backfill `mesh items sink`

**Files.** `src/hub/service.ts`, `src/hub/app.ts`, `src/protocol/hub.ts`, `src/protocol/hub-api.ts`,
`src/cli/review-commands.ts`.

**Changes.**
- New `async sinkItems(actor: Actor, b: SinkRequest): Promise<SinkResult>` in `goalTx`:
  1. `topic = topicName(b.topic)`; `topic === ALL_TOPIC` or unknown → 400 as AC-11.
  2. `repo = lineageRepo(b.lineage)`; `existing = cleanAuditGoal(repo, topic)`; newest goal of the
     lineage (choice 11). Allowed when admin, `actor.userId === newest?.ownerId` or
     `=== existing?.ownerId`; else 403 `only an admin, the owner of the lineage's newest goal or of ${existing?.id ?? "the clean-audit goal"} can sink ${b.lineage}`.
  3. `items = filedItems(b.lineage)` (no goal filter, no requires).
  4. `plan = decideSink({ repo, topic, items, owner: actor.userId, from: "mesh items sink", deps: false, minRank: b.min_severity && SEVERITY_RANK[b.min_severity] })`.
  5. `dry_run` → return `{ goal: existing?.id ?? null, added, reopened, skipped, notes }` with the
     would-be local ids mapped onto `existing.id` (or `<new>` placeholder ids when there is none;
     state that in the doc of `SinkResult`), nothing written.
  6. else `writeSink(plan, now)` and return its result.
- `app.ts`: `r("POST", "/v1/items/sink", "member", async (c, a) => c.json(await svc.sinkItems(a, await body(c, SinkRequest))), "goals:write")`.
  Distinct from `GET /v1/items` (method differs).
- `review-commands.ts` `itemsCommand`: when `a.positional[0] === "sink"`: parse
  `parseArgs(args, ["topic", "min-severity"])`; `lineage = positional[1]`, `--topic` required
  (usage error 2 otherwise), `--min-severity` validated against `Severity` (2 on a bad value),
  `--dry-run` boolean. POST; print dry run `would add ${r.added.length} to ${r.goal ?? "a new goal"}`,
  else `${r.goal}: added ${r.added.length}, reopened ${r.reopened.length}`. `HubCallError` → stderr,
  1, as the existing branch. Usage text gains the `sink` form.

**Order.** After B3 and AC-14's protocol work.

**Blast radius.** One new route and one CLI branch. `mesh items <lineage>` unchanged (a lineage
always has `|`; `sink` is never a step id, which is `G<n>.<local>`).

**Risks.**
- Idempotence: the second call finds every item covered by a non-done step → `added 0`.
- The dry run must not call `createGoal` (it allocates a goal number).

## AC-16 `mesh show` header

**Files.** `src/cli/show.ts`.

**Changes.** In `renderGoal`, after the `topics:` line, when `g.sink`:
`const c = sinkCounts(d.steps)`;
`lines.push(\`clean audits: ${g.sink.topic} on ${repoName(g.sink.repo)} · open S1 ${c.open.S1} · S2 ${c.open.S2} · S3 ${c.open.S3} · S4 ${c.open.S4} · done ${c.done} · dropped ${c.dropped}\`)`.
Step rows of finding steps (`s.finding`) show `s.title` after the state column (before the
extras). The "dropped by a later plan" line keeps its text for other goals; for a sink goal it
reads `dropped: …` (only when `g.sink`, so existing snapshots stay unchanged).

**Order.** After stage 3 (imports `sinkCounts`, `repoName` from `../core/index.ts`).

**Blast radius.** Rendering of goals with `sink` only.

**Risks.** `src/cli/__snapshots__/show.test.ts.snap` renders goals without `sink`; it must not
change. Choice 4 for the repo text.

## AC-17 Step id and title helpers (unit)

**Files.** `src/core/findings.ts`.

**Changes.** Export `findingStepId(lineage, fp)` (the 18-character local id), `cutTitle(text, max = 200)`
and `findingTitle(severity, title)` from `src/core` (B2).

**Order.** Stage 3.

**Blast radius.** None.

**Risks.** The spec names the rules, not the helpers. The test side picks its own import names;
at the combine step, if a unit test imports another name or signature from `src/core`, add an
export with that name (an alias or a thin wrapper) rather than changing the test.

## AC-18 Docs, events, skill, schemas

**Files.** `docs/guide/concepts.md`, `docs/guide/scheduled-reviews.md`, `docs/events.md`,
`docs/plan/implementation-plan.md`, `src/protocol/skill.ts` (`MESH_SKILL`), `skills/mesh/SKILL.md`
(generated), `src/protocol/tools.ts` (descriptions), `schemas/hub-api.openapi.json` and any
`schemas/*.json` that changes (generated), optionally `docs/guide/operations.md`.

**Changes.**
- `concepts.md`: new `## Clean-audit goals` section (after `## Calibration` / before
  `## Agent statistics`, or after `## Debriefs`): `sink: { topic }` on a stage, one goal per
  `(repo, topic)` opened by the hub, finding steps (`f-…` ids, `[S<n>]` titles, brief, worktree),
  never completed by its steps and refusing plans, **severity order** of the ready list,
  **`requires`** on `accepted` dispositions (deps, never refused), the item → step sync table in
  prose, `mesh items sink`, and **`mesh goal drop`** (any goal; held steps refused; pulse and
  calibration goals).
- `scheduled-reviews.md`: section `## Clean-audit goals` right after
  `## Debrief: decide the findings yourself` (before `## How findings are compared from run to run`),
  with a preset snippet using `sink: { topic: ci }` on the filer, `mesh show` with the header line,
  `mesh items sink`, `mesh goal drop`.
- `docs/events.md`: rows `goal.sunk` (`goal`, `from`, `added`, `reopened`; activity text) and
  `goal.sink_failed` (`from`, `reason`); `goal.created` adds `sink` for clean-audit goals;
  `goal.dropped` reasons `missed`, `abandoned`, `person` (with `by`, `comment`); `step.reopened`
  reasons `refiled` and `reverted` with `from` (and `by` = the goal owner or the person);
  `step.dropped` reasons `person`, `dismissed`, `deferred`, `reverted`; `step.done` from a
  resolved finding.
- `docs/plan/implementation-plan.md` API table: rows `POST /v1/goals/:id/drop` and
  `POST /v1/items/sink` (`(v0.1.27)`), next to the goals and items rows. Keep the RL-7/RL-8 strings
  the docs tests assert.
- `MESH_SKILL`: section `## Finding steps` (read the brief, work in the step's worktree, do not edit
  the tracking row; the next audit resolves the finding; finishing the step records nothing on the
  item) and CLI rows `mesh goal drop <G>` and `mesh items sink <lineage> --topic <t>`. Regenerate
  `skills/mesh/SKILL.md` with `pnpm schemas`.
- `src/protocol/tools.ts`: `mesh_review` and `mesh_dispose` descriptions mention that an
  `accepted` disposition may carry `requires` (fingerprints this fix cannot land before).
- `operations.md` "Upgrading to …": one sentence for 0.1.27 (upgrade the hub first: a preset with
  `sink` is refused by an older hub). Rename the heading only if no doc link or test pins it
  (`scheduled-reviews.md` links `#upgrading-to-0126`; update that link with it).
- No team-, company- or person-specific names; samples use `demo`, `r`, `ci`, `ann`.

**Order.** After the code (texts follow the behaviour); `pnpm schemas` last.

**Blast radius / risks.** `test/docs-rl7.test.ts`, `test/docs-rl8.test.ts`, the RL-6 docs tests
and the skill equality tests assert earlier strings in the same files; edit around them, never
remove them. The OpenAPI document changes (two routes, `requires`, `sink`): commit the regenerated
file; the ledger schemas are `looseObject`s and are expected to stay unchanged.

## AC-19 Version and checks

**Files.** `package.json`, `test/schemas.test.ts` (the version pin only).

**Changes.** `"version": "0.1.27"`. Run `pnpm schemas`, then `pnpm check` (lint, typecheck,
boundaries, test, build). `SCHEMA_VERSION` stays 11 (no migration added).

**Order.** Last.

**Risks.** `pnpm boundaries`: `src/core/findings.ts` imports only `../protocol` and `./review.ts`;
`src/cli/show.ts` imports core (allowed).

---

## Existing tests and snapshots the developer may adjust

Only where the spec changes the asserted behaviour:

- `test/schemas.test.ts` `test_AC16_version` (~line 686): `0.1.26` → `0.1.27` (keep the comment
  style: "RL-9 AC-19").
- `schemas/hub-api.openapi.json`, `skills/mesh/SKILL.md` and any other `schemas/*.json` that
  changes: regenerated by `pnpm schemas`, never by hand. The tests that compare them with the
  generators then pass without an edit.
- Route list tests ("served = documented", `test_AC*_openapi_routes`): pass once `HUB_API` and
  `app.ts` both have the two rows; no edit.
- Tests that compare a whole `DispositionRow`, history entry, `Goal` or `Step` with
  `toStrictEqual`: unchanged (the new fields are written only when present).
- Tests of `goal.dropped`/`step.dropped` for pulses (`test/pulse-hub.test.ts` ~line 1586 asserts
  the activity text is not "dropped by a new plan"): unchanged (pulse payloads and texts kept).
- `src/cli/__snapshots__/show.test.ts.snap`: unchanged (no fixture has `sink`).
- Ready-list order assertions in existing tests: unchanged (no finding steps there).

No `SCHEMA_VERSION` change, no store contract test change, no web change.
