# Spec RL-9: Clean-audit goals (filed findings become workable steps)

## Status
Draft (approved in review round 3; round-3 suggestions applied)

Source: operating the v0.1.26 pulses (ten relay pulses across four repos). Builds on RL-2 (review
records, items, fold, dispositions), RL-3 (pulses, preset params), RL-4 (debriefs, revert), RL-6
(filed items, hub-opened goals: calibration). Release v0.1.27.

## Problem

A relay ends at its filer stage: each accepted finding gets a tracking row and becomes **filed**
(`accepted` with a `link`). After that mesh does nothing with it:

1. **Nobody can pick a finding up in mesh.** Filed items are visible only through `mesh items
   <lineage>`, one lineage (preset, repo, agent) at a time. There is no step to claim, no holder, no
   worktree, no way to offer one to another machine.
2. **No view per area.** CI findings come from several agents (a CI auditor, a harness auditor),
   code findings from others. People think in areas per repo ("clean the CI of repo X"), not in
   lineages.
3. **No order.** Severity lives on the item, but nothing ranks work by it, and there is no way to say
   "this fix cannot land before that one".
4. **No loop back.** When a later audit no longer raises a filed finding (`resolved`), nothing
   closes the work.

Today a goal's steps come only from an approved plan, which is capped at 50 steps and replaced as a
whole by a new version, and no person can end a goal (only pulses drop goals). A goal that collects
findings for months needs another way to add steps and a way to end it.

## Scope

In:
- A **sink** on a relay stage (`sink: { topic: "<topic>" }`). Items filed in its run are added, one
  step each, to the **clean-audit goal** of `(repo, topic)`, which the hub opens on first use.
- Clean-audit goals: keyed `(repo, topic)`, tagged with the topic, never completed by their steps,
  refusing plans. Finding steps are saved directly, not through plan versions.
- Step **severity** (from the item), in the step title and in the ready order within a goal.
- **Strict dependencies** between findings: an `accepted` disposition may carry `requires`; they
  become step deps when the step is created or reopened.
- **Item → step sync**: resolved → closed; refiled → reopened; dismissed or deferred → dropped;
  a reverted dismissal → reopened. Held steps are never changed, only noted.
- `mesh goal drop` (any goal), so a standing goal can end.
- Backfill: `mesh items sink`.
- `mesh show` header counts for a clean-audit goal.
- Docs, events, skill, schemas, version.

Out:
- Step → item: finishing a finding step records nothing on the item; the next audit decides
  (resolved or repeat).
- Editing deps by hand; moving steps between goals; merging topics.
- Ordering across goals (goal priority stays unused by the ready list); web changes beyond what the
  existing step views show (severity appears in the title).
- Caps on the number of finding steps.
- A migration: goals, steps and plans keep their whole object in a JSON `value` column, so the new
  fields need no column; lookups scan `listGoals` and `listSteps({goal})` as `calibrationScan` does.
  `SCHEMA_VERSION` stays 11.

## Interface contracts

Names used below.
- **Sink stage**: a plan step whose policy has `sink`.
- **Run**: as RL-2, the first raising step up a stage's deps; its **lineage** is
  `<preset>|<repo>|<agent>`; the lineage's **repo** is its middle segment.
- **Filed in the goal**: an item of the run's lineage in state `accepted` with a `link`, whose latest
  `accepted` disposition (any decider) was recorded in the sink stage's goal.
- **Clean-audit goal** of `(repo, topic)`: the goal with `sink = { repo, topic }` that is not
  `dropped`. Repos compare as exact strings, as lineages do (a pulse on `group/x` and one on `x`
  open two goals).
- **Finding step**: a step with `finding`. Its local id is `f-` followed by the first 16 characters
  of the lowercase base32 SHA-256 of `<lineage>|<fp>` (the encoding `fingerprint()` uses), so it is
  unique per `(lineage, fp)` and a valid local id (18 characters).
- **Severity rank**: `S1` = 1 … `S4` = 4.

### Types (src/protocol/goal.ts, review.ts, hub.ts; exported from src/protocol/index.ts)

| Interface | Change |
|---|---|
| `StepPolicy.sink` | New, optional `{ topic: string }` (1–40 characters; placeholders filled like other preset fields). `policyOf` (`src/core/policy.ts`) copies it. |
| `Goal.sink` | New, optional `{ repo: string, topic: string }`; set only on clean-audit goals. |
| `Step.severity` | New, optional `Severity`; set on finding steps. |
| `Step.finding` | New, optional `{ lineage: string, fp: string }`. |
| `RecordDisposition.requires`, `DisposeRequest.requires` | New, optional `string[]` (1–20 fingerprints, `[a-z2-7]{16}`; a malformed list is the schema's 400). Allowed only with `disposition: "accepted"`: the service refuses any other disposition carrying it with 422 `requires is only for accepted` (the whole record, as other RL-2 record problems). Stored on the disposition history entry. |
| `SinkRequest` (hub.ts) | `{ lineage: string, topic: string, min_severity?: Severity, dry_run?: boolean }`. |
| `SinkResult` (hub.ts) | `{ goal: string \| null, added: string[], reopened: string[], skipped: number, notes: string[] }` (`goal` null on a dry run that would open a goal). |

### Checks (where `validatePolicies` runs: `proposePlan`, `presetChecks` for pulse add/update and ingest)

- A step with `sink` must have `may_set` containing `accepted`, else 422
  `sink in step <id> needs a stage that may set accepted`.
- The filled `sink.topic` is trimmed and lowercased like every topic, then must pass the topic-name
  syntax (else the existing 400 `bad topic "<t>"`, which is what an unfilled `{topic}` placeholder
  gets) and be a defined topic other than `all` (else 400
  `unknown topic <t> (define with: mesh topic add <name>)`).

### Opening the goal and adding steps (src/hub/service.ts)

**Trigger.** Whenever a sink stage enters `done` or `skipped`, by any path (`doneStep`, or
`settleSteps` from another step's done, plan approve, gate decide, reopen or resume), inside the same
`goalTx`. A skipped sink stage still sinks: a person may have filed items in a debrief.

**Never fails the caller for a sink reason.** Before writing anything, the hub checks what can stop
a sink: the topic still exists (a topic deleted after the pulse was made; `deleteTopic` leaves
`Goal.sink` as it is and only removes the tag, as today). If a check fails, nothing of the sink is
written, the caller's change commits, the hub adds a note on the sink stage `sink failed: <reason>`
and emits `goal.sink_failed { from: <sink step id>, reason }`. Every rule below is decided in memory
first and then written, so no rule fails half-way; a store error fails the caller's transaction as
any store error does today.

For each item filed in the goal, rules 1–5 apply (rule 2, 3 or 4 by the state of its finding step,
if any):

1. **Goal.** Find the clean-audit goal of `(lineage repo, topic)`. None → create it: title
   `Clean audits: <topic> on <repo name>` (`repoName`), owner the sink stage goal's owner, topics
   `[topic]`, `primaryRepo` the repo, `sink`, state `in_progress`, priority default, and an approved
   plan v1 with `steps: []` proposed and decided by the owner (written directly, as `createWithPlan`
   writes pulse plans; `validatePlan` is not run). Event `goal.created` with payload
   `{ title, sink: { repo, topic } }`.
2. **New finding step** (none for `(lineage, fp)`): saved directly with `planVersion: 1`;
   `kind: implement`; `repo` the lineage's repo; `severity` the item's; `finding`; policy
   `{ worktree: true }`; `title` = `[<severity>] <item title>`, cut to 200 characters (the last
   kept character replaced by `…` when cut); `brief` built from the item: rule, path, symbol,
   evidence (path, lines, note), proposal, link, the reasons of its dispositions, and the last line
   `When the fix lands, the next audit of <lineage> resolves this finding; do not edit the tracking row.`
   The brief is cut to 8000 characters keeping that last line, with
   `… (cut; mesh items <lineage>)` before it. State: `ready`, or `blocked` when it has deps not
   satisfied (`settle`).
3. **Existing finding step** `done` or `dropped`, and the item's latest `accepted` disposition is
   newer than the step's last change to `done`/`dropped` (its `updatedAt`): **reopened** (otherwise,
   for example a backfill or a second filer round over an item nobody filed again, unchanged) — state `ready` or `blocked` (by its
   deps, via `settle`), `fixCycles + 1`, `outcome`, `summary`, holder fields and `roundStartedAt`
   cleared, rounds kept; title, severity and brief rebuilt from the item; event `step.reopened` with today's payload
   `{ by: <goal owner>, reason: "refiled", fixCycles }` plus `from: <sink step id>`; note
   `refiled by <sink step id>`. Dependants are **not** reopened (no `dag.reopen`).
4. **Existing finding step** in any other state: unchanged. If `ready` or `blocked`, its severity,
   title and brief are rebuilt from the item; if held (`claimed`, `paused`, `parked`) or `failed`, it gets a note
   `refiled by <sink step id> (<severity>)`.
5. **Deps** (only for steps created or reopened in this event, after all steps of the event exist):
   a created step's deps are the resolved requires; a reopened step keeps its deps and adds the
   resolved requires. The requires are the union of `requires` over the
   item's `accepted` dispositions in the sink stage's goal. Each fp resolves to the finding step of
   `(item lineage, fp)` in the clean-audit goal; else to the only finding step there with that fp in
   any lineage; else it is left out with a note on the new step `requires <fp>: not in this goal`
   (or `… : ambiguous` when several lineages have it). A dep that would close a cycle is left out
   with the note `requires <fp>: cycle`. A `requires` is never refused for what it names (an fp
   with no step, or a cycle), at record, dispose or sink time.

One event per trigger: `goal.sunk { goal, from: <sink step id>, added: [ids], reopened: [ids] }`
(not emitted when both are empty). Activity text: `<n> findings from <from> (<m> reopened)`.

**Standing.** `goalComplete` returns false for a goal with `sink`, so no path (`applyApproved`,
`doneStep`, `decideGate`, `resumeStep`) marks it `done`. `proposePlan` on a goal with `sink` → 409
`<G> is a clean-audit goal; its steps come from audits`, checked before the plan is validated.

### Item → step sync (src/hub/service.ts: fold, `applyDisposition`, `disposeStep`, `revertDisposition`)

For the finding step of `(lineage, fp)` in the lineage repo's clean-audit goals (not `dropped`):

| Item event | Step state | Effect |
|---|---|---|
| `resolved` (fold of a complete record) | `ready`, `blocked` | `done`, outcome `done`, summary `resolved by <audit step id>`; event `step.done` |
| `resolved` | `claimed`, `paused`, `parked`, `failed` | note `resolved by <audit step id>` |
| `dismissed` or `deferred` disposition | `ready`, `blocked` | `dropped`, summary `<disposition> by <decider>: <reason>`; event `step.dropped { reason: "<disposition>" }` |
| `dismissed` or `deferred` | `claimed`, `paused`, `parked`, `failed` | note `<disposition> by <decider>: <reason>` |
| revert (RL-4, `POST /v1/steps/:id/dispositions/revert`) of the debrief disposition that dropped the step, so the item is filed again | `dropped` | reopened as rule 3 with its deps unchanged, event reason `reverted`, `from` the debrief step |
| raised again (`repeat`, `regression`) | `done` | note `raised again by <audit step id>` |
| revert of a debrief's `accepted` after the sink (item no longer filed) | `ready`, `blocked` | `dropped`, summary `reverted by <user>`; event `step.dropped { reason: "reverted" }` |
| revert of a debrief's `accepted` | held or `failed` | note `reverted by <user>` |
| any of the above | `done`, `skipped`, or a state not listed | nothing |

Events of the sync carry `by`: the decider's user (a person) or the goal owner (an agent decider or a
fold).

Steps closed or dropped this way unblock their dependants (`settle`, as today).

### Ending a goal: `mesh goal drop` (src/hub/app.ts, service.ts, src/cli/hub-commands.ts)

`POST /v1/goals/:id/drop` `{ reason?: string }` (rule `member`, scope `goals:write`, tag `goals`):
the goal's owner, an approver or an admin. 404 unknown goal; 403 otherwise; 409
`<G> is <state>` when `done` or `dropped`; 409 `<G> has held steps: <ids>; release them first` when
a step is `claimed` or `paused`. Otherwise as the pulse `dropGoal`: every step not `done`,
`skipped`, `dropped` or `failed` (so `ready`, `blocked` and `parked` ones) → `dropped`, offers
withdrawn; goal `dropped`; events `goal.dropped { reason: "person", by, comment? }` and
`step.dropped` per step. CLI `mesh goal drop <G> [--reason "…"]` prints `Dropped <G>`. Any goal may
be dropped this way: a pulse's goal (its slot keeps its outcome; the pulse's overlap rule then sees
no open goal), a calibration goal (its dismissals are released, as the concepts guide states for a
dropped calibration goal). A later sink opens a new clean-audit goal.

### Ready order (src/hub/service.ts `listSteps`, `GET /v1/steps?ready=1`)

After today's rules (debriefs out; steps offered to the viewer's machine first), the list is two
parts: the offered-here steps, then the rest. Within each part separately, and within each goal, the
positions held by its finding steps are refilled with those same steps sorted by severity rank, then
by their previous order. Other steps keep their positions, and no step crosses between the parts. So `mesh next`, `mesh_next` and the TUI
list an `S1` finding before an `S2` finding of the same goal, and nothing else moves.

### `mesh show` (src/cli)

For a goal with `sink`, the header gains one line:
`clean audits: <topic> on <repo name> · open S1 <a> · S2 <b> · S3 <c> · S4 <d> · done <n> · dropped <m>`,
where open = not `done`, `skipped` or `dropped`. Each finding step's row shows its title (which
carries the severity).

### Backfill: `mesh items sink` (`POST /v1/items/sink`)

`mesh items sink <lineage> --topic <t> [--min-severity S2] [--dry-run]` → `POST /v1/items/sink`
(rule `member`, scope `goals:write`, tag `goals`). Allowed for an admin, the owner of the lineage's
newest goal, or the owner of the existing clean-audit goal; else 403. Topic checks as above. It
applies rules 1–4 to the lineage's filed items at or above `min_severity` (all when absent), with
no deps; a new goal's owner is the caller. Idempotent: a second call adds nothing. `--dry-run`
changes nothing and returns what it would add. CLI output: `<G>: added <n>, reopened <m>`
(dry run: `would add <n> to <G or a new goal>`).

### Docs, events, schemas

Concepts (clean-audit goals; severity order; `requires`; `mesh goal drop`), scheduled-reviews guide
(a section "Clean-audit goals" after "Debrief"), the mesh skill (finding steps: read the brief, work
in the worktree, do not edit the tracking row), `docs/events.md` (`goal.sunk`, `goal.sink_failed`,
`goal.dropped` reason `person`, `step.reopened` reasons), the API table (`/v1/goals/:id/drop`,
`/v1/items/sink`). `pnpm schemas` regenerates the OpenAPI document and the ledger schemas.

### Compatibility

New optional fields and two new routes. A preset with `sink` sent to an older hub is refused with
422 (`PresetStep` is strict), so the hub ships first. Older daemons and CLIs ignore the new fields.

## Acceptance criteria

Surfaces: **World** tests (`test/helpers/world.ts`; hub, daemons and CLI in process). Unless a
criterion says headless, relay stages are **interactive steps run by persons** through the hub
tools: the raising stage submits `mesh_review` with items (`coverage: complete`) and `mesh_done`; a
consuming stage submits `mesh_review` with dispositions and `mesh_done`. Fixture "relay": a goal from
a repo preset with steps `audit` (raising, `output: review-record`), `file` (deps `[audit]`,
`consumes: [open, confirmed, accepted]`, `may_set: [accepted]`, `output: review-record`,
`sink: {topic: ci}`), topic `ci` defined, repo `r` (remote-backed as in RL-7). A "later run" is a
second goal of the same preset and repo, so it shares the lineage. **Unit** tests for pure parts in
`src/core`. **CLI** tests for output.

| Id | Criterion | Surface | What exact state makes it FAIL? |
|---|---|---|---|
| AC-01 | Relay run 1: `audit` raises items A (S2) and B (S1); `file` accepts both with links → goal `Clean audits: ci on r` exists with `sink {repo, topic: ci}`, topics `[ci]`, state `in_progress`, plan v1 with no steps; it has exactly two `implement` steps with ids `f-<hash(lineage|fp)>`, `severity`, `finding`, titles `[S2] …`/`[S1] …`, state `ready`, briefs containing the link and the last line; event `goal.sunk` with both ids. | World | Missing goal or steps, other ids, a plan version with steps, or no event. |
| AC-02 | Run 2 (later run) raises A, B and new C; a person claims A's step first; `file` accepts C → one new step for C; A's step is still `claimed` by that person, B's still `ready`; no new plan version. | World | A or B changed, a duplicate step, or a plan version added. |
| AC-03 | Two lineages, one goal: a second preset (another name) on the same repo with `sink: {topic: ci}` raises the same key `{rule, path, symbol}` as A and files it → the goal has two steps for that fp with different ids; resolving it in one lineage closes only that lineage's step. | World | One step for both, an id clash, or both closed. |
| AC-04 | Deps: `file` accepts D with `requires: [fpE]` and E → D's step has a dep on E's step and is `blocked`; E's step done → D's step `ready`. A `requires` naming an fp not in the goal → no dep and the note `requires <fp>: not in this goal`. A `requires` that would close a cycle (E later refiled with `requires: [fpD]` after a reopen) → no dep, note `requires <fp>: cycle`, and the filer's `mesh_done` succeeds. `requires` on a `dismissed` disposition → 422 `requires is only for accepted`. | World | Missing or extra dep, a refusal of the filer, or no note. |
| AC-05 | Resolved: a later run's complete record without A → A's step (`ready`) is `done` with summary `resolved by <audit step id>` and its dependants are settled; with A's step `claimed` instead → still claimed, with the note. A partial record without A changes nothing. | World | Not closed, a held step changed, or a partial record closing it. |
| AC-06 | Refiled: A resolved (step done), then raised again (`regression`), and filed again → A's step state `ready` (or `blocked` by deps), `fixCycles` +1, event `step.reopened` with reason `refiled`, note `refiled by …`; a done dependant of A stays `done`. | World | Not reopened, a dependant reopened, or no event. |
| AC-07 | Dismissed or deferred later. (a) A later run of the lineage whose consuming stage has `consumes: [accepted]`, `may_set: [dismissed, deferred]` (no sink) gets B raised again (`repeat`) and dismisses it → B's `ready` step is `dropped` with summary `dismissed by <decider>: <reason>`; deferring C (`until` in the future) in the same way drops C's `ready` step with `deferred by …`; with A's step `claimed`, dismissing A leaves it `claimed` with the note `dismissed by …`. (b) In a later run that raises D again (`repeat`), a debrief stage (RL-4: `mode: debrief`, deps `[audit]`, `output: review-record`, `consumes: [accepted]`, `may_set: [dismissed]`) dismisses filed item D with `mesh_dispose` → D's step `dropped`; `POST /v1/steps/<debrief step>/dispositions/revert` of that decision → D is filed again and its step is reopened (`ready` or `blocked`), its deps unchanged, event `step.reopened` reason `reverted`. | World | Not dropped, a held step changed, not reopened, or other deps or summary. |
| AC-08 | Standing: all finding steps done (one by a person's `mesh_done`, one by the resolved sync) → goal still `in_progress`. `mesh goal plan <G> --file x.yaml` with a valid one-step plan, and with an invalid one → 409 with the clean-audit text both times. | World + CLI | Goal `done`, the plan accepted, or a validation error first. |
| AC-09 | Skipped sink: a relay `audit` → `debrief` (`mode: debrief`, deps `[audit]`, `output: review-record`, `consumes: [open]`, `may_set: [accepted]`) → `file` (`when: {open: true}`, `consumes: [open, confirmed, accepted]`, `may_set: [accepted]`, `sink: {topic: ci}`); the audit raises only F; in the debrief the person calls `mesh_dispose` with `accepted` and a link for F, then `mesh_done` → `file` is `skipped` and F has a finding step in the clean-audit goal. | World | `file` not skipped, or no step for F. |
| AC-10 | Sink never fails the filer: delete topic `ci` after the goal of run 2 was created and before its `file` stage is done → `mesh_done` of `file` succeeds; note `sink failed: …` on the stage and event `goal.sink_failed { from, reason }`; no step added or reopened and no `goal.sunk`. | World | The done refused, no note/event, or a partial sink. |
| AC-11 | Checks: a preset step with `sink` and no `may_set: [accepted]` → `mesh pulse add` and `mesh goal plan` refused with 422 and the sink text; `sink: {topic: nope}` → 400 unknown topic; `sink: {topic: all}` → 400 unknown topic; `sink: {topic: "{topic}"}` with no `topic` param → 400 `bad topic "{topic}"`; with `--params topic=CI` → accepted, stored as `ci`. | World + CLI | Accepted when it should be refused, or another status or text. |
| AC-12 | Truncation: an item title of 200 characters and severity S1 → title exactly 200 characters ending in `…`; a proposal of 4000 characters and 20 evidence notes of 1000 characters → brief ≤ 8000 characters, contains `… (cut; mesh items <lineage>)` and ends with the last line. | World | Longer fields, or the last line lost. |
| AC-13 | Ready order: in goal G1, ready finding steps S3 (added first), S1, S2, plus an S4 finding step of G1 offered to the viewer's machine; in goal G2 a plain ready step → `GET /v1/steps?ready=1` lists the offered S4 first, then G1's S1, S2, S3 in the positions the three held, and G2's step where it was. `mesh next` prints the same order. | World + CLI | Another order, or the offered step not first. |
| AC-14 | Goal drop: owner drops a clean-audit goal with a `ready`, a `blocked` and a `parked` step and no held step → goal `dropped`, those three steps `dropped`, event `goal.dropped` reason `person`; a later sink opens a new goal. With a `claimed` step → 409 naming it. A user who is not owner, approver or admin → 403. A pulse's goal can be dropped the same way. `mesh goal drop <G>` prints `Dropped <G>`. | World + CLI | Dropped with a held step, a step left open, a 200 for another user, or no new goal. |
| AC-15 | Backfill: a lineage with three filed items (S1, S2, S4) and no clean-audit goal → `mesh items sink <lineage> --topic ci --min-severity S2 --dry-run` prints `would add 2 to a new goal` and changes nothing; without `--dry-run` → goal with two steps; again → `added 0`. A member who is neither owner nor admin → 403. | World + CLI | Wrong count, a change on dry run, duplicates, or no 403. |
| AC-16 | `mesh show <G>` of a clean-audit goal with open S1 1, S2 2, done 1, dropped 1 → header line `clean audits: ci on r · open S1 1 · S2 2 · S3 0 · S4 0 · done 1 · dropped 1`. | CLI | Another line or counts. |
| AC-17 | Step id and title helpers (unit): the id for a fixed `(lineage, fp)` equals the expected 18-character value and differs for another lineage with the same fp; the cut title rule at 199, 200 and 201 characters. | unit | Another id, or a title over 200. |
| AC-18 | Docs, events, skill, schemas: the concepts, guide, skill, events and API table entries named above exist; `MESH_SKILL` equals `skills/mesh/SKILL.md`; `pnpm schemas` leaves no diff; no team-, company- or person-specific name in code or docs. | docs test + CI | A missing entry, a mismatch, or a specific name. |
| AC-20 | Not refiled, not reopened: an item filed in run 1 whose finding step a person finished (`mesh_done`), then `mesh items sink <lineage> --topic ci` and a second round of the same `file` stage (resumed or reopened) → the step stays `done`, no `step.reopened`. Refiling it in a later run (a new `accepted` after the step closed) reopens it, and its brief then holds the new link. | World | The step reopened without a new filing, or the old link kept after a refile. |
| AC-21 | Sink after other settle paths: `audit` → `debrief` (files F) → `gate` → `file` (`when: {open: true}`, sink): approving the gate → `file` `skipped` and F has a finding step; the same with a parked step upstream of `file` resumed through `POST /v1/steps/:id/resume`. | World | No step for F on either path. |
| AC-19 | `package.json` version `0.1.27`; `pnpm check` passes; `SCHEMA_VERSION` still 11. | CI | Any check fails, or a schema change. |

## Open questions

None open. Decided by the owner (2026-11-17): one goal per repo and topic with a step per finding;
the topic set per pulse; resolved findings close their steps; finishing a step is one-way; no deps
CLI and no cap in this release; the goal's owner is the owner of the goal whose sink opened it.
