# The mesh development cycle: design → spec → split plans → blind build → evaluate → retrofit

Date: 2026-11-04. Status: **implemented in M4 (capture) and M4.5 (rules, gates, templates)**. See the plan's M4.5 status for where the build differs; how to run it is in [docs/guide/cycle.md](../guide/cycle.md). Follows the owner decisions in [2026-11-04-team-value-metrics-and-ledger.md](2026-11-04-team-value-metrics-and-ledger.md#owner-decisions-2026-11-04).

Sources studied (read-only):
- `architecture-and-standards`: the canonical assets in `claude-assets/` (agents, workflows `define-rows.js`, `build-rows.js`, `gate-rule.js`, blocks, hooks, `sync-manifest.json`) and the templates.
- `vpc-node-agent`: `.claude/` and 22,042 commits of artefacts: 742 specs, 1,452 review files, 1,019 plans, ~830 progress logs, 108 programme ledgers, 8,250 evidence files, plus `evidence/lane/verdicts.json` and `.id-ledger.tsv`.

## TL;DR

- **The team's process is good, and it already works.** It runs as follows:
  - spec, then a cold review loop (3-round cap, churn breaker);
  - an implementation plan and a test plan written in parallel without sharing;
  - developer and test-writer in separate worktrees, with tests that must fail first;
  - a read-only executor with failure buckets and a 3-cycle cap;
  - a cold diff review, then a gate with a recorded approval.
- **What it loses is the data.**
  - The programme scripts already get typed results back from every agent (`REVIEW{verdict, blockers, regressions_majority}`, `EXEC{verdict, failures[{bucket}]}`) and then **throw them away**. Only the prose an agent writes reaches git.
  - Rounds and verdicts live in file names, in 16+ spellings. The model is never recorded per role: 28 commits from one Claude session cover every role.
  - Plans are overwritten. Gate lines are free text.
  - `harness-efficiency` rebuilds the metrics by grepping for words like "red" and "loop".
- **Isolation is mostly on trust.**
  - The test-planner writes in the same tree where the impl plan is being committed.
  - The test-writer's base contains the impl plan.
  - Test-bug fixes run in the developer's worktree.
  - The impl-plan template hands the developer's "Public API" to the test-writer, against the rule that the test side never sees it.
- **The proposal: run the same cycle on mesh, as a plan preset, not an engine.**
  - mesh adds four things the scripts lack: one holder per step, isolation it enforces, round and cycle caps the hub applies, and **a generated ledger record per step built from tool arguments and hooks**.
  - The team keeps its artefacts (spec, reviews, plans, evidence); mesh records reference them.
- **Engine changes stay small and generic:**
  - more step kinds;
  - `blind` and `reads` on steps;
  - `max_rounds` and park rules;
  - human `gate` steps;
  - a reconcile check on ACs;
  - a goal roll-up record.

  All are optional fields, so a plain three-step plan still works.
- **The retrofit loop closes the circle.**
  1. A weekly batch over `mesh ledger export` finds regressions by model and by harness hash.
  2. It proposes harness changes as goals.
  3. The next cohort shows whether the change helped.

## 1. What the team's process is today

### 1.1 The stages (canonical `claude-assets`, as run in vpc-node-agent)

| # | Stage | Agent (model in front matter) | Output | Exit / loop |
|---|---|---|---|---|
| 0 | Reserve id | orchestrator, `scripts/reserve-id.mjs` (push to `develop` as compare-and-swap) | `.id-ledger.tsv` row | push accepted |
| 1 | Design / ADR (when an interface changes) | `adr-author`, `analyst` (opus) | `adr/NNNN-*.md` | human (R1) |
| 2 | Spec | `spec-writer` (opus), 5-group interview; unattended answers become open questions | `specs/NNN-*.md` (Draft), index row, progress log | — |
| 3 | Spec review | `reviewer` (opus), *cold on the spec, warm on the record* | `reviews/NNN/r<N>-<VERDICT>.md` | APPROVED / CHANGES REQUESTED / BLOCKED. Four blocker kinds, finding classes NEW / REPEAT / REGRESSION-OF-OWN-REPAIR, **3 rounds**, churn (more than half regressions) → park. Approval = R2 |
| 4 | Plans, in parallel | `impl-planner` ‖ `test-planner` (opus) | `plans/NNN-impl-plan.md`, `plans/NNN-test-plan.md` (per AC: what exact state makes it FAIL, positive control, mutation) | — |
| 5 | Reconcile | mechanical (orchestrator) | — | every AC in the test plan, else loop the test-planner once |
| 6 | Build, in parallel | `developer` ‖ `test-writer` (sonnet), separate worktrees | commits `feat(..) [AC-n]`, `test(..) [AC-..]` | test-writer: **fail-first at the pre-change baseline** |
| 7 | Combine | merge agent | test branch merged into build branch | conflict → park |
| 8 | Execute | `test-executor` (opus), **read-only** | `evidence/spec-NNN/<date>-<suite>-PASS\|FAIL.txt` | failures bucketed spec-gap / impl-bug / test-bug / infra; **3 cycles with no new AC green** → park |
| 8b | Mutations | test-writer role, throwaway worktree | `evidence/spec-NNN/mutations.md` | each named mutation killed or survived |
| 9 | Diff review | `reviewer` | `reviews/NNN/final-r<N>-*.md` (or `diff-r<N>`) | 2–3 rounds |
| 10 | Gate | `make merge-gate`; rule GATE-1 (D1–D6), else `gate-advisor` | `Gate: R3 \| by: … \| verdict-ref: … \| gate-run: …` | R3, then MERGE |
| 11 | Close | orchestrator | CHANGELOG, BACKLOG row removed, spec `Implemented` | — |
| 12 | Retro | none per spec. Weekly `harness-efficiency` routine greps reviews, `Gate:` lines and words in `progress/` | findings → proposed BACKLOG rows | — |

The **programme loop** runs many rows (backlog items) through this. It is a JS `Workflow` (`progress/programme-*-scripts/programme.js`) with phases `Spec → Plan → Deps → Build → Test → Close`, rows in parallel with dependencies as promises, and one ledger file per programme (≤300 lines) with Queue, Gate verdicts, Ids, Decisions and RESUME.

### 1.2 One real spec, end to end (spec 771, `NA-1054`)

The trail took **12.5 hours** from id reservation to close:
- 3 spec revisions and 5 review files: `r1-CHANGES_REQUESTED`, `r2-APPROVED`, `r-post1-CHANGES_REQUESTED`, `r-post2-APPROVED` and `final-p3c1-PASS`.
- 2 generations of plans, the first overwritten.
- 2 builds, after a lane capture disproved the first design.
- 1 executor cycle.
- Merge-gate pass 2 failed three times: one impl-bug, then two infra failures.
- 2 status changes that had to be reverted.

What is lost along the way:
- **Round counting.** The 3-round cap silently restarted after the redesign. Nothing records that this was rounds 3 and 4.
- **A spec defect fixed in the wrong place.** The test plan overrode AC-02 (decision D-1) instead of the spec being fixed.
- **Model and role.** All 28 commits carry one `Claude-Session` and one model, so a review cannot be told apart from a writer's work. The agent files say the developer runs on sonnet, but the commits say opus.
- **Failure types.** Merge-gate failures were classified only in prose in `progress/771.md`. That file's status table was never updated.

### 1.3 What can be measured today, and how badly

| Metric | Where it comes from | Quality |
|---|---|---|
| Spec review rounds | count files in `reviews/NNN/` (from spec 260 on): 1 file → 32 specs, 2 → 155, 3 → 173, 4 → 89, 5+ → 34 | usable, but verdict tokens come in 16+ spellings |
| Finding classes / churn | "Churn check" line (1,378 of 1,449 files) | parseable, ~50 free-text variants |
| Per-AC lane status | `evidence/lane/verdicts.json` (schema 1, 2,013 entries) | **machine-readable**, lane criteria only, overwritten each run |
| Executor / gate cycles | commit subjects, `-FAIL-N.txt`, `exec-cN/`, progress prose | fragile regex |
| Failure bucket | progress prose; the script's `failures[].bucket` is discarded | prose only |
| Model per role | `Co-Authored-By` trailer, `# Runner:` header, plan `Author:` | per commit, not per role; front matter disagrees |
| Time per stage | git commit dates by `type(NNN)` subject | good for recent specs |
| Tokens, cost | `mesh-emit` → `.mesh-events.jsonl` (gitignored, absent) | none in git |
| Plan history, status history | overwritten files; git only | git archaeology |

### 1.4 Where context can leak today

1. The test-planner writes into the same main tree where the impl-planner commits at the same moment, so the impl plan is on disk next to it (`build-rows.js`).
2. The test-writer branches from a base that already holds the committed impl plan.
3. In `programme.js`, test-bug fixes run in the developer's worktree, and the mutation campaign must read the implementation.
4. `templates/impl-plan.md` and `agent-developer.md` route the developer's "Public API exported" block to the test-writer.
5. Fix prompts pass the executor's failure JSON (test names, excerpts) straight to the developer.
6. In unattended runs a spec-gap is fixed by a spec "amendment" with no review round.
7. The only proof of isolation is the planner's self-declared `Source read: none` row.

Isolation is enforced by prompts plus `git status` self-checks. The canonical README says so itself: *"`tools:` cannot scope a path, and `Bash` can still write."*

## 2. The proposed cycle on mesh

### 2.1 Principles

1. **Same cycle, same artefacts.** The spec, review files, plans and evidence stay where the team keeps them. mesh does not replace a single template.
2. **The cycle is a plan preset, not engine code.** mesh knows steps, kinds, dependencies, holders, rounds and guards. The preset `sdd-split` arranges them, and other teams can use other presets or none.
3. **Every number comes from a tool argument, a hook or an event.** No agent types `Gate:`, `Verdict:` or `Runner:` lines for analysis. The prose files stay human-readable, and the record next to them is generated.
4. **Isolation is structural first and prompt-based last.** Separate steps, separate sessions, separate worktrees on branches that don't contain the other side's files, a filtered `mesh_context`, and per-step deny rules where Claude Code supports them.
5. **The hub enforces caps.** Round and cycle caps and churn/stall rules are plan data, and the hub parks the step. The orchestrator no longer counts.
6. **People approve at gates. Everything else runs unattended.** R1/R2/R3 are human `gate` steps, or a recorded default rule where the team allows one.

### 2.2 The graph

```
                       ┌────────────── DEFINE ──────────────┐
 goal ──► design ──► spec ⇄ spec-review (≤3 rounds) ──► [R2 gate: approve spec + build plan]
          (ADR if         reviewer: cold on spec,                       │
          needed, R1)     warm on the record                            ▼
                       ┌──────────────── BUILD ─────────────────────────────────────┐
                       │  impl-plan ─────► develop ─────┐                           │
                       │  (blind: test-*)  (blind: test-*, worktree impl/…)          │
                       │                                ├─► combine ─► verify ⇄ fix │
                       │  test-plan ─────► write-tests ─┘   (merge)    (read-only,  │
                       │  (blind: impl-*)  (blind: impl-*, worktree test/…  ≤3 cycles│
                       │        ▲          from BASE, fail-first)          no new AC│
                       │        └── reconcile: every AC planned ──┘        green)   │
                       └────────────────────────────────────────────────────────────┘
                                            ▼
                         diff-review (≤2 rounds) ──► [R3 gate: CI + AC table] ──► land ──► goal roll-up
                                                                                      │
                                weekly: ledger export ──► retrofit analysis ──► harness goals
```

### 2.3 Stage by stage

| Stage | mesh step (`kind` / `role`) | Isolation | What the agent passes to mesh | What mesh records (generated) |
|---|---|---|---|---|
| **Design** | `design` / `designer` (ADR when an interface changes) | — | `mesh_done(summary, artifacts:[adr path], model)` | segment provenance, design doc ref and sha, R1 gate if an ADR was proposed |
| **Spec** | `spec` / `spec-writer` | — | `mesh_done(artifacts:[spec path], acs:[AC-01…], open_questions:n)` | the AC list becomes plan data (`acs`), spec revision = round number |
| **Spec review** | `review` / `reviewer`, target `spec`, `max_rounds: 3` | must not be held by the spec-writer's session or person | `mesh_done(verdict: approved\|changes_requested\|blocked, findings:{new, repeat, regression}, blockers:n, artifacts:[review file])` | round n, verdict, finding classes. **The hub reopens `spec` on changes_requested, parks on churn (regression > half) or on the cap.** |
| **R2 gate** | `gate` (person or recorded default rule) | — | approve / revise in web or CLI | `by`, `rule`, `verdict_ref` (the approving review), comment. This replaces the free-text `Gate: R2` line. |
| **Impl plan** | `plan` / `impl-planner` | `blind: [test-plan, write-tests]` | `mesh_done(artifacts:[impl plan], acs_addressed:[…])` | plan committed **on the impl branch only** |
| **Test plan** | `plan` / `test-planner` | `blind: [impl-plan, develop]`; `reads: [spec]` | `mesh_done(artifacts:[test plan], acs_addressed:[…], mutations:n)` | plan committed **on the test branch only** |
| **Reconcile** | automatic (hub check, no agent) | — | — | `reconcile: {missing_acs:[…]}`. If an AC is missing, the hub reopens `test-plan` once, then parks. |
| **Develop** | `implement` / `developer`, worktree `impl/<goal>` | `blind: [test-plan, write-tests]` | `mesh_done(branch, head, acs_addressed:[…], model)` | segments, commits range |
| **Write tests** | `test` / `test-writer`, worktree `test/<goal>` from **BASE** | `blind: [impl-plan, develop]` | `mesh_done(branch, head, fail_first:{red:[AC…], not_red:[AC…]})` | fail-first per AC: a test that passed on the baseline is flagged |
| **Combine** | `merge` / `merger` (agent or `mesh` itself) | — | `mesh_done(head, conflict:false)` | a conflict means one side touched the other's files → park |
| **Verify** | `verify` / `test-executor`, read-only, `max_rounds: 3` | `blind: [impl-plan]`; the read-only check runs `git status` at the end | `mesh_done(verdict: pass\|fail, acs:{AC-01: met\|not_met\|unrun, …}, surfaces_not_run:[…], failures:[{test, ac, bucket: spec-gap\|impl-bug\|test-bug\|infra}], artifacts:[evidence])` | per-AC outcome per cycle. **The hub reopens `develop` for impl-bug, `write-tests` for test-bug, routes spec-gap back through `spec-review` (never an unreviewed amendment), and parks infra. It stops after 3 cycles with no new AC met.** |
| **Mutations** (optional) | `test` / `mutation`, throwaway worktree | — | `mesh_done(mutations:{killed:n, survived:[ids]})` | kill rate |
| **Diff review** | `review` / `reviewer`, target `diff`, `max_rounds: 2` | not held by anyone who held develop or write-tests | `mesh_done(verdict, findings:{impl, test}, blockers)` | rounds, and which side each finding reopens |
| **R3 gate** | `gate` | — | approve in web/CLI, or a default rule (GATE-1 D1–D6) evaluated from recorded data | `by`, `rule`, D1–D6 inputs, **CI result** (M5 ingest, the authority for test counts), final AC table |
| **Land** | `merge` / `lander` | — | `mesh_done(head)` | landed sha |
| **Roll-up** | automatic at goal done | — | — | goal record: totals per stage, rounds, cycles, buckets, parks, people, models, harness hashes, lead time |

Fixed IDs remain the team's. mesh step ids are `G<n>.<local>`, and the spec id (`771`) and backlog row (`NA-1054`) are recorded as `refs` on the goal. `reserve-id.mjs` stays as it is.

### 2.4 How isolation is enforced, layer by layer

| Layer | What it stops | Status |
|---|---|---|
| **Separate steps, separate holders** | The same session or person doing both sides. The claim guard refuses anyone who held a blinded step; `chain` won't hand it to them. | M4.5 (R12) |
| **Branches that don't contain the other side** | The impl plan sitting in the test-writer's tree (leaks 1 and 2). Plans are committed on their own branch; the test worktree is created from BASE. | M4.5 (R15 + plan placement) |
| **Filtered `mesh_context`** | Seeing the other side's summary, notes, branch or plan path. Only `reads:` artefacts are shown, and the spec's interface section is the contract. | M4.5 (R12, R16) |
| **Fix routing through mesh** | The executor's raw failure JSON going to the developer (leak 5). The reopen message carries AC id, bucket and assertion text only, never test source. | M4.5 |
| **Per-step deny rules** | Casual reads of `crates/*/src/**` by a test step. `mesh run --step` passes `--settings` with `permissions.deny: ["Read(<paths>)"]` from the step's `forbid`. These rules cover Claude's file tools, not every shell command, so they are best-effort. | M4.5, opt-in |
| **Recorded proof** | Claims of isolation with no evidence. The record holds `blind.separated: true\|false`, the holders on both sides, and the worktree base sha. | M4.5 |

mesh does not sandbox the shell. The remaining risk is an agent deliberately running `cat` on the other branch. Separate worktrees from BASE leave nothing on disk to read, and the record makes any shared holder visible.

### 2.5 What the generated record adds over today

| Today (hand-written or file name) | With mesh (generated) |
|---|---|
| `reviews/771/r-post1-CHANGES_REQUESTED.md`, round in the file name | `rounds[n] = {verdict: changes_requested, findings: {new: 1}, model, harness, at}` |
| `# Runner: test-executor (claude-opus-5-5), cycle 3` | `segments[].model`, `model_source`, `effort`, cycle = round |
| `Gate: R3 \| by: default-rule GATE-1 \| gate-run: <300 chars>` | gate record from structured inputs: rule, D1–D6 values, CI run id |
| Executor buckets in progress prose | `failures[].bucket` per cycle |
| Plans overwritten in place | plan step rounds keep each revision's sha |
| Status rewinds visible only in git | step state history in hub events + rounds in the record |
| `Source read: none` (self-declared) | `blind.separated`, holders, worktree base |
| Lead time from commit dates | per-stage `started` / `finished`, waits, human prompts |

## 3. Retrofit: feeding lessons back into the harness

The team has no per-spec retro today. A weekly routine guesses rework from words in progress logs. On mesh the loop is:

1. **Per goal, automatically:** the roll-up record at goal done. It needs no agent and no prose.
2. **Weekly batch:** `mesh ledger export` → JSONL → a `retrofit` analysis, either a mesh-ai view or an agent routine like `harness-efficiency`. It compares cohorts by `model`, `harness.hash` (per part), `role` and `kind`, using:
   - spec review rounds and churn rate;
   - reconcile misses and fail-first misses (tests that didn't go red);
   - verify cycles and failure-bucket mix;
   - ACs met per cycle and time per AC;
   - diff-review rounds and parks with their reasons;
   - human prompts and waits per stage;
   - rework links after merge;
   - gate overturns (how often a person reverses a default rule).
3. **Findings become goals.** Example: "test-planner on model X misses positive controls; tighten `test-planner.md` rule 4". The goal's change edits `claude-assets/`, so the next run's **harness hash changes**.
4. **Next cohort.** Steps with the new harness hash are compared with the old ones. The harness change is kept or reverted on evidence.

This is the "retrofit the process" loop: the same ledger that measures a model getting worse also measures whether a prompt or agent change helped.

## 4. What mesh must add (engine), and what it must not

### Engine additions (all optional, all generic)

| # | Addition | Why | Milestone |
|---|---|---|---|
| C1 | Step kinds `spec`, `plan`, `verify`, `merge`, `gate` added to `design`, `implement`, `test`, `review`, `docs` | name the stages without a role registry | M4.5 |
| C2 | `max_rounds` per step plus park rules (churn: regressions over half; stall: no new AC met in N cycles) | caps enforced by the hub, not counted in prompts | M4.5 |
| C3 | `reopen` routing by bucket: `spec-gap\|impl-bug\|test-bug\|infra\|unclear` (the team's taxonomy, replacing R7's names) | fix loops without an orchestrator script | M4.5 (with R7) |
| C4 | `gate` steps done by a person (web/CLI) or by a recorded rule; the record holds rule inputs | replaces free-text `Gate:` lines | M4.5 |
| C5 | Reconcile check: every plan AC appears in the `acs_addressed` of the steps marked as covering it | the mechanical AC check, done by the hub | M4.5 (with R9) |
| C6 | `reads:` / `forbid:` on steps: the `mesh_context` filter plus optional Claude deny rules; plans on their own branches | structural isolation | M4.5 (with R12/R15) |
| C7 | `artifacts:` (path + sha) and `refs:` (spec id, backlog row) on `mesh_done` and goals | link the record to the team's files | M4 (with R1) |
| C8 | Goal roll-up record at goal done | per-goal retro with no agent | M4 |
| C9 | Plan presets, including `sdd-split` | the cycle as data | moved from M5 to M4.5 |
| C10 | Export adapters: optional join of `evidence/lane/verdicts.json`-style files by path | reuse the team's one machine-readable ledger | M5 |

### Not added

- **A role registry, gate rules in code, or a workflow engine.** The preset carries roles as free strings, and the hub only applies the caps and guards the plan asks for.
- **A replacement for the team's templates or `reserve-id`.**
- **Token or cost tracking** (owner decision 9), or **agent-reported test counts** (owner decision 7). CI is the authority.

## 5. Example preset (abridged)

```yaml
# presets/sdd-split.yaml — offered to the design session; the session fills repos, ACs and briefs
preset: sdd-split
steps:
  - { id: spec,        kind: spec,      role: spec-writer }
  - { id: spec-review, kind: review,    role: reviewer, deps: [spec], target: spec, max_rounds: 3,
      park_on: [churn], not_held_by: [spec] }
  - { id: r2,          kind: gate,      deps: [spec-review], gate: R2 }
  - { id: impl-plan,   kind: plan,      role: impl-planner, deps: [r2], blind: [test-plan, write-tests] }
  - { id: test-plan,   kind: plan,      role: test-planner, deps: [r2], blind: [impl-plan, develop], reads: [spec] }
  - { id: develop,     kind: implement, role: developer,    deps: [impl-plan], blind: [test-plan, write-tests], worktree: true }
  - { id: write-tests, kind: test,      role: test-writer,  deps: [test-plan], blind: [impl-plan, develop], worktree: base,
      forbid: ["crates/*/src/**"] }
  - { id: combine,     kind: merge,     deps: [develop, write-tests] }
  - { id: verify,      kind: verify,    role: test-executor, deps: [combine], blind: [impl-plan], max_rounds: 3,
      park_on: [stall], reopen: { impl-bug: develop, test-bug: write-tests, spec-gap: spec-review, infra: park } }
  - { id: diff-review, kind: review,    role: reviewer, deps: [verify], target: diff, max_rounds: 2,
      not_held_by: [develop, write-tests] }
  - { id: r3,          kind: gate,      deps: [diff-review], gate: R3, needs: [ci] }
acs:
  - { id: AC-01, text: "…", surface: "OVS lane", fails_when: "…" }
```

A "collapse" variant for test-only specs drops `impl-plan` and `develop`, and lets mutations stand in as the fail-first evidence. That is a second preset, not an engine flag.

## 6. Open questions for the owner

1. **Define stage.** Should spec and spec review be mesh steps (recommended: each review round is then a cold session with its own record)? Or should the design session run them and propose only the build plan?
2. **R2 and R3 defaults.** May a recorded default rule (GATE-1 D1–D6) close a gate without a person when every input is green, as the canonical assets allow today?
3. **Adoption path.** Run the next vpc-node-agent programme on mesh with the `sdd-split` preset, keeping `programme.js` as the reference? Or first make `programme.js` call mesh (claim / done) so the typed results it already has stop being lost?
4. **Backfill.** Is a one-off import of history worth it (review file names, `verdicts.json` history, git trailers) for a baseline cohort? Or do we start the ledger clean?
