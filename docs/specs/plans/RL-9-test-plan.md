# Test plan RL-9: Clean-audit goals (filed findings become workable steps)

Spec: `docs/specs/RL-9.md` (Draft, approved in review round 3; round-3 suggestions applied).

Inputs read: `docs/specs/RL-9.md` (problem, scope, interface contracts, acceptance criteria, open
questions); the role file `assets/sdd/.claude/agents/test-planner.md`; the format of
`docs/specs/plans/RL-8-test-plan.md`; the file names under `test/`, `test/helpers/` and
`src/core/*.test.ts`; the test kits `test/helpers/review-kit.ts` (`fp`, `fpOf`, `item`, `disp`, `rec`,
`Rk`: `goal(owner, steps, {preset})`, `claim`, `review`, `reviewOk`, `closeOk`, `submit`, `itemsOf`,
`itemOf`, `state`, `goalState`, `ctx`), `test/helpers/debrief-kit.ts` (`Dk`: `hold` = a session's
`mesh_claim`, `dispose`/`disposeOk` = `mesh_dispose`, `disposeRoute`, `revert`, `notes`, `ev`,
`patchStep`, `post`), the member list of `test/helpers/relay-kit.ts` (`Relay`: `start`, `call`, `goal`,
`plan`, `stepOf`, `assign`, `act`, `events`, `allEvents`, `nick`, `machineNick`, `cli`, `until`) and
of `test/helpers/world.ts` (`World.person`, `login`, `hook`, `tool`, `flush`, `api`, `call`,
`hubStore`), the member list of `test/helpers/calib-kit.ts` and `test/helpers/pulse-kit.ts`; the
existing tests used as patterns: `test/review-hub.test.ts` (`test_AC09_lineage_fallbacks`: lineage
`<preset>|<repo>|<agent or local id>`), `test/review-cli.test.ts` (`mesh items`, `goal plan --preset`
lineage), `test/programme.test.ts` (MCP `mesh_review`/`mesh_dispose`/`mesh_done` through `w.tool`,
`recArgs`), `test/debrief-hub.test.ts` (`AC-11 revert`, `readyIds`), `test/calibration-hub.test.ts`
(`RL-6 AC-05 filed items`, `test_AC13_replan_path`), `test/assign.test.ts` (`AC-15` ready lists, offers
first), `test/hub.test.ts` (topic add/delete), `test/pulse-cli.test.ts` (`commitPreset`, CLI pattern),
`test/docs-rl8.test.ts`, the version and route-table blocks of `test/schemas.test.ts`, the
`SCHEMA_VERSION` use in `test/m46-ops.test.ts`; the section list of `docs/guide/scheduled-reviews.md`
and the calibration and step paragraphs of `docs/guide/concepts.md` (a dropped calibration goal
releases its dismissals; step states).

Not read: `docs/specs/plans/RL-9-impl-plan.md` (the implementation plan), branch `impl/RL-9` and its
worktree; any implementation source of this row or of the code it changes (`src/hub/service.ts`,
`src/hub/app.ts`, `src/protocol/*.ts`, `src/core/policy.ts`, `src/core/*` other than `*.test.ts`,
`src/cli/*`, `src/store/*`), not even to check a name; `docs/plan/implementation-plan.md` (the API
table: only named below as a file a docs test reads). Interface names below come from the spec only.
Where a test needs a name the spec does not spell out (the `src/core` helpers of AC-17, the store's
step write), the test-writer takes it from the exported type, not from this plan.

Planned black-box from the contracts. Every negative assertion has a positive control in the same test
or a named sibling, so a test cannot pass because nothing happened. Each criterion names at least one
mutation of the implementation that must turn one of its tests red; the implementer or reviewer applies
it once by hand, confirms red, and reverts.

Rules every test follows:
- Expected finding-step ids are computed **test-side** from the documented formula (`fid` below),
  never by importing the implementation's helper, so the World tests check the formula too.
- Steps by id, items by `fp`, goals by `sink` (never by position or by goal number), events by type +
  goal/step + payload `from`.
- Relay stages are interactive steps run by persons through the hub tools (MCP over the person's
  daemon: `mesh_claim`, `mesh_review` with `coverage: complete` unless said, `mesh_dispose`,
  `mesh_done`), as the spec's Surfaces line says. Route calls are used only for refusals (status and
  text) and for reads.
- A "nothing changed" assertion compares a snapshot taken before the stimulus (steps of the clean-audit
  goal with `state`, `title`, `severity`, `deps`, `fixCycles`, holder; the event count by type; the
  goal's plan version) with one taken after a `w.flush()`.
- The Postgres legs of the store contract are not touched by this row; they are skipped locally
  (`MESH_TEST_PG_URL` unset) and named "not run", never a failure.

## Fixture changes (test side only)

| File | Change |
|---|---|
| `test/helpers/sink-kit.ts` (new) | `Sk.start()`: `Relay.start(["ann", "bob", "carol", "root"], {admins: ["root"]})`, clock `NOV19`; `ann` and `bob` = `w.person(<name>, "r", {shareSessions: "me"})` (repo `r`, the default remote-backed checkout as in RL-7); `carol` = a login only (a member, not owner, approver or admin); `root` = admin token; ann defines topic `ci` (`POST /v1/topics {name: "ci"}` → 201). |
| `test/helpers/sink-kit.ts` | Plan steps: `AUDIT = {id: "audit", repo: "r", output: "review-record"}` (interactive; no agent, so the lineage's agent is the local id); `FILE(over) = {id: "file", repo: "r", deps: ["audit"], consumes: ["open", "confirmed", "accepted"], may_set: ["accepted"], output: "review-record", sink: {topic: "ci"}, ...over}`; `TRIAGE = {id: "triage", repo: "r", deps: ["audit"], output: "review-record", consumes: ["accepted"], may_set: ["dismissed", "deferred"]}` (no sink); `DEBRIEF(over)` = `{id: "debrief", repo: "r", mode: "debrief", deps: ["audit"], output: "review-record", ...over}`. |
| `test/helpers/sink-kit.ts` | `run(o?: {preset?: string; steps?: PlanIn[]; owner?: Person})` → `{G, AU, F, ...}`: a goal of `owner` (default ann) created with `preset: {name: o.preset ?? "relay", text: "steps: []\n"}` (as `Rk.goal` does) and its plan (default `[AUDIT, FILE()]`) approved. Two calls with the same preset are a "later run" (same lineage). |
| `test/helpers/sink-kit.ts` | `stage(p, id, body, o?: {done?: boolean})`: a fresh pid, `w.hook(p, "SessionStart", pid)`, `mesh_claim {step: id}`, `mesh_review recArgs(body)`, then (unless `done: false`) `mesh_done {outcome: "done", summary: "ok"}`; `w.flush()`; returns `{pid, review, doneText, doneError}`. `raise(G, items, o?)` = `stage(ann, G.audit, {items, coverage})`; `file(G, dispositions)` = `stage(ann, G.file, {assessment: "clean", dispositions})`. `acc(f, o?: {requires?: string[]; link?: string})` = `disp(f, "accepted", {link: o.link ?? LINK(f)})` plus `requires` when given; `LINK(f) = "https://tracker.example/" + f`. |
| `test/helpers/sink-kit.ts` | `LIN(preset = "relay") = \`${preset}|r|audit\`` (AC-01 asserts it equals the audit's `ReviewResult.review.lineage`, so a lineage rule change fails there, not everywhere). `fid(lineage, f) = "f-" + base32(sha256(\`${lineage}|${f}\`)).slice(0, 16)` with the lowercase RFC 4648 alphabet as `review-kit.ts`'s `base32` (export that function from `review-kit.ts` instead of copying it). `LAST(lineage) = \`When the fix lands, the next audit of ${lineage} resolves this finding; do not edit the tracking row.\``. |
| `test/helpers/sink-kit.ts` | Reads: `cag(repo = "r", topic = "ci")` = the goals of `GET /v1/goals` (all states) whose `sink` deep-equals `{repo, topic}` and state is not `dropped` (expects at most one; returns it or `undefined`); `cagAll(repo, topic)` including dropped ones; `fsteps(CG)` = the goal's steps with `finding` (from `GET /v1/goals/:id`); `fstep(CG, lineage, f)` = the step `${CG}.${fid(lineage, f)}` (`r.stepOf`); `notes(id)` (as `Dk.notes`); `ev(type, pred)` over `r.allEvents()`; `activity()` = the texts of `GET /v1/live` activity; `patchStep(id, over)` (as `Dk.patchStep`, only for states no route reaches in one call: `paused`, `parked`, `failed`); `snapshot(CG)` per the rules above. |
| `test/helpers/sink-kit.ts` | `items3()`: `A = item("ra", {severity: "S2", title: "T-A", proposal: "P-A", evidence: [{path: "src/a.ts", lines: [3, 5], note: "N-A"}]})`, `B = item("rb", {severity: "S1", title: "T-B"})`, `C`, `D`, `E`, `F` (S3 unless a test says), fps `fA … fF` by `fpOf`. |
| `test/schemas.test.ts` | The release line becomes `0.1.27` (comment `RL-9 AC-19`); a new assertion `HubStore.SCHEMA_VERSION === 11`; the route-table test gains the two rows of AC-18. |
| `src/core/*` unit test | New file `src/core/finding-step.test.ts` (AC-17); it imports the id and title helpers from whichever `src/core` module exports them (the test-writer reads the export, the spec names no function). |

## Surfaces and files

| Surface | File | New or extended |
|---|---|---|
| World (hub, daemons, MCP): sink, goal, steps, deps, sync, skipped sink, sink failure, truncation | `test/sink-hub.test.ts` | new |
| World: standing goal, ready order, goal drop, backfill route | `test/sink-goals.test.ts` | new |
| CLI against a World hub: `mesh goal plan`, `mesh pulse add`, `mesh next`, `mesh goal drop`, `mesh items sink`, `mesh show` | `test/sink-cli.test.ts` | new |
| unit, finding-step id and title | `src/core/finding-step.test.ts` | new |
| docs / skill | `test/docs-rl9.test.ts`, `src/claude/skill.test.ts` (unchanged: `MESH_SKILL` = `skills/mesh/SKILL.md`) | new / unchanged |
| CI | `test/schemas.test.ts` (version, `SCHEMA_VERSION`, route table, OpenAPI up to date), `test/boundaries.test.ts` (unchanged) | extended / unchanged |

Describe names follow `RL-9 AC-NN <topic>`; tests are `test_ACNN_<what>`.

---

## AC-01 First sink opens the goal

`describe("RL-9 AC-01 first sink")`, `test/sink-hub.test.ts`.

### test_AC01_goal_and_steps
- Setup: `Sk.start()`; `G1 = run()`.
- Stimulus: `raise(G1, [A, B])` (the ReviewResult's lineage `=== LIN()`: a control on the fixture);
  `file(G1, [acc(fA), acc(fB)])`.
- Expected:
  - `CG = cag()` exists: `title === "Clean audits: ci on r"`, `sink` `toStrictEqual({repo: "r", topic:
    "ci"})`, `topics` `toStrictEqual(["ci"])`, `state === "in_progress"`, owner `ann`, `primaryRepo ===
    "r"`; its plan: exactly one version, `1`, approved, `steps` `[]`.
  - `fsteps(CG)` has exactly two steps with ids `${CG}.${fid(LIN(), fA)}` and `${CG}.${fid(LIN(), fB)}`;
    each `kind: "implement"`, `repo: "r"`, `state: "ready"`, `finding` `toStrictEqual({lineage: LIN(),
    fp})`, `severity` `S2`/`S1`, `title` `"[S2] T-A"`/`"[S1] T-B"`, `planVersion: 1`, policy
    `worktree: true` (where the step view carries its policy).
  - A's brief contains `ra`, `src/a.ts`, `N-A`, `3`, `P-A`, `LINK(fA)`, the filer's reason
    `because accepted`, does not contain `(cut;`, and ends with `LAST(LIN())`.
  - Event `goal.created` for CG with payload `{title: "Clean audits: ci on r", sink: {repo: "r", topic:
    "ci"}}` (`toMatchObject`); exactly one `goal.sunk` with `{goal: CG, from: G1.file, reopened: []}`
    and `added` sorted equal to the two ids; `activity()` contains `2 findings from ${G1}.file (0
    reopened)`.
  - Positive control that the relay itself was not disturbed: `G1.file` is `done` and G1 is `done`.
- FAIL state: no goal or another title/sink/topics/state; a plan version with steps (or a v2); other ids;
  a missing field; a brief without the link or last line; no `goal.sunk`.
- Mutations: (1) save finding steps through a new plan version → red on "one version, no steps";
  (2) id from `fp` alone (no lineage) → red on ids; (3) skip the event → red.

### test_AC01_unlinked_not_filed
- `file(G1, [acc(fA), disp(fB, "accepted")])` (B accepted **without** a link).
- Expected: one finding step (A's); `goal.sunk.added` has only A's id. Control: same test asserts A's
  step exists. FAIL: a step for B. Mutation: treat any `accepted` as filed → red.

### test_AC01_no_items_no_goal
- `raise(G1, [])`; `file(G1, [])` → `cag()` is `undefined`, no `goal.created` with a `sink`, no
  `goal.sunk`. Control: `test_AC01_goal_and_steps`. Mutation: open the goal on every sink stage done →
  red.

## AC-02 Later run adds only the new finding

`describe("RL-9 AC-02 later run")`.

### test_AC02_new_only
- Setup: AC-01 state (A, B filed from G1); `G2 = run()`. bob claims A's finding step through MCP
  (`mesh_claim`) **before** G2's file stage.
- Stimulus: `raise(G2, [A, B, C])`; `file(G2, [acc(fC)])`.
- Expected: `fsteps(CG)` has exactly three steps; C's id `fid(LIN(), fC)`, `ready`; A's step still
  `claimed` with holder bob; B's still `ready` with the same title/severity/deps as before (snapshot);
  the plan of CG still has one version; `goal.sunk` from `G2.file` has `added: [C id]`, `reopened: []`;
  no `step.reopened`.
- FAIL state: A or B changed, a duplicate step for A or B, a plan version added.
- Mutations: (1) treat every item in `accepted` state of the lineage as "filed in the goal" (ignore
  which goal the latest `accepted` was recorded in) → A gets a note or B is touched → red on the
  snapshot; (2) add steps by plan version → red.

### test_AC02_nothing_new_no_event
- `G2` raises A and B only; `file(G2, [])` → no `goal.sunk` with `from: G2.file`. Control: the G1 event
  exists. Mutation: emit `goal.sunk` with empty lists → red.

## AC-03 Two lineages, one goal

`describe("RL-9 AC-03 two lineages")`.

### test_AC03_two_steps_one_fp
- Setup: AC-01 state (lineage `LIN("relay")`); `H1 = run({preset: "relay2"})`.
- Stimulus: `raise(H1, [A])` (same key `{rule, path, symbol}` as A → same `fA`); `file(H1, [acc(fA)])`.
- Expected: still exactly one clean-audit goal of `(r, ci)` (CG); it has two steps with `finding.fp ===
  fA`, ids `fid(LIN("relay"), fA)` and `fid(LIN("relay2"), fA)` (different).
- Stimulus 2: a later run of `relay` (`G2 = run()`) raises B only, complete → item A of `LIN("relay")`
  `resolved`.
- Expected 2: the `relay` A step is `done`; the `relay2` A step is still `ready`.
- FAIL: one step for both, an id clash (a 409/500 or an overwrite), both closed.
- Mutations: (1) id from `fp` only → one step → red; (2) sync by `fp` without lineage → both closed → red;
  (3) key the goal by lineage instead of `(repo, topic)` → two goals → red.

### test_AC03_repo_exact_strings (contract, no AC)
- Two presets on repos `r` and `group/r` (the second goal's steps `repo: "group/r"`; its stages are run
  through the review routes as `Rk.submit` does, since no person's checkout is `group/r`) each file one
  item → two clean-audit goals, `sink.repo` `r` and `group/r`. FAIL: one goal. Mutation: compare repos
  by `repoName` → red.

## AC-04 Deps from `requires`

`describe("RL-9 AC-04 requires")`.

### test_AC04_dep_and_unblock
- `G1 = run()`; `raise(G1, [D, E])`; `file(G1, [acc(fD, {requires: [fE]}), acc(fE)])` (D listed
  **before** E).
- Expected: D's step `deps` `toStrictEqual([E step id])` (as the step view lists deps; local or full id as
  the view does), state `blocked`; E's step `ready`, no deps; no `requires` note on D.
- Stimulus 2: ann claims E's step through MCP and calls `mesh_done` → E's step `done`, D's step `ready`.
- FAIL: no dep, D `ready` before E is done, D still `blocked` after.
- Mutations: (1) resolve requires while creating steps in record order (before E exists) → note `not in
  this goal`, no dep → red; (2) skip `settle` → D `ready` at once → red.

### test_AC04_not_in_goal
- `file(G1, [acc(fD, {requires: [fX]}), acc(fE)])` where `fX = fpOf("rx")` (never raised) → D's step
  has no deps, is `ready`, and its notes contain `requires ${fX}: not in this goal`. Control: the dep
  test above. FAIL: a refusal (the filer's `mesh_review` or `mesh_done` errors), a dep, no note.
  Mutation: refuse unknown requires at record time → red.

### test_AC04_cycle
- After `test_AC04_dep_and_unblock` (E done, D ready): ann does D's step (`mesh_done`) → D `done`.
  `G2 = run()`; `raise(G2, [D, E])` (repeat); `file(G2, [acc(fE, {requires: [fD]})])`.
- Expected: E's step reopened (`ready`), its `deps` still `[]` (the dep E→D would close the cycle
  D→E→D); its notes contain `requires ${fD}: cycle`; the filer's `mesh_review` and `mesh_done` have no
  `isError`, `G2.file` is `done`; `goal.sunk` from `G2.file` has `reopened: [E id]`.
- Positive control: in the same world the non-cycle dep of D on E is still present.
- FAIL: a dep added, no note, or the filer refused (the record or the done).
- Mutations: (1) run the plan DAG check over the new deps and throw → filer refused → red; (2) add the dep
  without the cycle check → red.

### test_AC04_ambiguous_and_own_lineage (contract, no AC)
- Steps for `fA` in lineages `relay` and `relay2` (AC-03 setup). (a) A `relay3` run files X with
  `requires: [fA]` → X's step has no dep, note `requires ${fA}: ambiguous`. (b) A `relay2` run files Y with
  `requires: [fA]` → Y's dep is the `relay2` A step (own lineage first), no note. (c) A `relay3` run
  files Z with `requires: [fB]` (B only in `relay`) → dep on the `relay` B step (the only one).
- Mutation: pick the first match across lineages → red on (a) or (b).

### test_AC04_union_over_goal (contract, no AC)
- Plan `[AUDIT, DEBRIEF({consumes: ["open"], may_set: ["accepted"]}), FILE({deps: ["debrief"]})]`; in the
  debrief ann calls `mesh_dispose` with `accepted`, `requires: [fE]` for D (no link); the filer accepts D
  with a link and no `requires`, and E → D's step depends on E's. Mutation: take only the latest
  disposition's `requires` → red.

### test_AC04_requires_only_accepted
- A `triage`-stage record (`mesh_review`) with `[disp(fB, "dismissed"), {...disp(fA, "dismissed"),
  requires: [fB]}]` → the tool reply is an error with `requires is only for accepted` (route equivalent:
  `POST /v1/steps/<id>/review` → 422 with that text); items A and B unchanged (the whole record refused).
  `POST /v1/steps/<debrief>/dispositions` with `dismissed` and `requires` → 422, same text.
- Malformed: `requires: ["NOT-AN-FP"]`, `[]`, and 21 fps on an `accepted` → 400 (schema).
- Positive control: the same record without `requires` → 201; an `accepted` with `requires: [fB]` → 201.
- FAIL: accepted, another status or text, part of the record applied. Mutation: drop the
  disposition-kind check → 201 → red.

## AC-05 Resolved closes the step

`describe("RL-9 AC-05 resolved")`.

### test_AC05_ready_closed_and_dependant_settled
- Setup: `G1`: `raise([A, B])`; `file([acc(fA), acc(fB, {requires: [fA]})])` → B `blocked`. `G2 =
  run()`; **bob** runs `G2.audit` with a complete record raising B only.
- Expected: item A `resolved` (control); A's step `done`, outcome `done`, summary `resolved by
  ${G2}.audit`; one `step.done` for A's step whose `by` is `ann` (the goal owner; bob ran the audit);
  B's step `ready`.
- FAIL: A's step not done, another summary, B still blocked, `by` bob.
- Mutation: close the step without `settle` → B blocked → red; `by` = the record's user → red.

### test_AC05_held_only_noted
- As above but bob claims A's step through MCP before `G2.audit` → A's step still `claimed` by bob, its
  notes contain `resolved by ${G2}.audit`; no `step.done` for it; item A `resolved` (control).
- Sibling `test_AC05_failed_only_noted` (contract): A's step patched to `failed` → stays `failed`, same
  note.
- FAIL: a held step closed or released. Mutation: close any non-done step → red.

### test_AC05_partial_record_no_change
- As the first test but `G2.audit`'s record is `coverage: "partial"` → item A still `accepted`; A's step
  `ready`; snapshot unchanged; no `step.done`. Control: the complete-record test. Mutation: run the
  resolve sync on partial records → red.

## AC-06 Refiled reopens the step

`describe("RL-9 AC-06 refiled")`.

### test_AC06_reopen_after_resolve
- Setup: `G1` files A (S2) and B (`requires: [fA]`); `G2` complete record without A → A's step `done`,
  B `ready`; ann does B's step → `done`. Record A's step `fixCycles` (`n0`) and `rounds.length`.
- Stimulus: `G3 = run()`; `raise(G3, [{...A, severity: "S1"}, B])` → A's mark `regression` (control);
  `file(G3, [acc(fA)])`.
- Expected: A's step `ready`, `fixCycles === n0 + 1`, no `outcome`/`summary`/holder, rounds length
  unchanged, `severity: "S1"`, `title: "[S1] T-A"`; one `step.reopened` for it with payload
  `toMatchObject({by: "ann", reason: "refiled", fixCycles: n0 + 1, from: \`${G3}.file\`})`; note
  `refiled by ${G3}.file`; `goal.sunk` `{added: [], reopened: [A id]}`; `activity()` contains `1
  findings from ${G3}.file (1 reopened)`. B's step still `done`, no `step.reopened` for B.
- FAIL: not reopened, no event or note, B reopened, title/severity stale.
- Mutations: (1) use `dag.reopen` (dependants too) → B reopened → red; (2) add a new step instead of
  reopening → a second id or a clash → red; (3) keep the outcome/summary → red.

### test_AC06_reopen_with_deps_blocked
- Same, with A refiled carrying `requires: [fC]` where C's step is `ready` (not done) → A reopened
  `blocked`, deps contain C's step. Mutation: reopen always `ready` → red.

### test_AC06_dropped_refiled (contract rule 3)
- A's step `dropped` by a triage dismissal (AC-07 a), then a later run raises A, its filer accepts A with
  a link → A's step `ready`, `step.reopened` reason `refiled`.

### test_AC06_rule4_ready_and_held (contract rule 4)
- (a) B's step `ready` (S1); a later run raises B as S3 and files it again → B's step still `ready`,
  `severity: "S3"`, `title: "[S3] T-B"`, no `step.reopened`, `fixCycles` unchanged. (b) B's step
  `claimed` by bob; same refile → still claimed, title unchanged, note `refiled by <file id> (S3)`.
- Mutation: reopen held steps → red on (b). (If the test-writer reads the spec's opening sentence of
  "Opening the goal" as excluding these items from rules 1–4, rule 4 still states the effect; keep the
  test.)

## AC-07 Dismissed, deferred, revert

`describe("RL-9 AC-07 dismissed and deferred")`.

### test_AC07a_dismiss_and_defer_drop_ready
- Setup: `G1` files A, B, C (all `ready`). bob claims A's step. `G2 = run({steps: [AUDIT, TRIAGE]})`.
- Stimulus: `raise(G2, [A, B, C])` (B, C marked `repeat`: control); triage by ann: `[disp(fB,
  "dismissed", {reason: "RB"}), disp(fC, "deferred", {reason: "RC", until: <NOV19 + 30 d>}), disp(fA,
  "dismissed", {reason: "RA"})]`.
- Expected: B's step `dropped`, summary `dismissed by ann: RB`, one `step.dropped` with `reason:
  "dismissed"` and `by: "ann"`; C's step `dropped`, summary `deferred by ann: RC`, `reason: "deferred"`;
  A's step still `claimed` by bob with note `dismissed by ann: RA`; no new finding step.
- FAIL: not dropped, other summary/reason, A changed.
- Mutations: (1) drop held steps too → red on A; (2) summary from the disposition only (no decider) →
  red.

### test_AC07b_debrief_dismiss_then_revert
- Setup: `G1` files D with `requires: [fE]` and E (D `blocked` on E). `G2 = run({steps: [AUDIT,
  DEBRIEF({consumes: ["accepted"], may_set: ["dismissed"]})]})`; `raise(G2, [D, E])`.
- Stimulus: ann holds `G2.debrief` (`mesh_claim`), `mesh_dispose` D `dismissed` → D's step `dropped`.
  Then `POST /v1/steps/${G2}.debrief/dispositions/revert {fingerprint: fD}` (ann) → 200.
- Expected: item D `accepted` with its link again (control: the revert worked); D's step reopened,
  `blocked` (E not done), deps unchanged (`[E id]`), one `step.reopened` with `reason: "reverted"`, `from:
  \`${G2}.debrief\``, `by: "ann"`.
- FAIL: not dropped, not reopened, other deps, other reason.
- Mutation: reopen with `deps` recomputed from requires of `G2` (none) → deps `[]` → red; skip the
  revert hook → red.

### test_AC07_revert_accepted_drops (contract table, no AC)
- The AC-09 world (F filed by the debrief, step `ready`): `POST /v1/steps/<debrief>/dispositions/revert
  {fingerprint: fF}` → F's step `dropped`, summary `reverted by ann`, `step.dropped` `reason:
  "reverted"`. Sibling with F's step claimed by bob → still claimed, note `reverted by ann`.

### test_AC07_agent_decider_by_owner (contract, no AC)
- A triage record carrying `agent: {key: "x/checker"}` (an agent decider) dismisses B → `step.dropped`
  `by` is the clean-audit goal's owner (ann), even when bob submits it.

## AC-08 Standing goal

`describe("RL-9 AC-08 standing")` (`test/sink-goals.test.ts`) and `describe("RL-9 AC-08 goal plan
refused")` (`test/sink-cli.test.ts`).

### test_AC08_never_done
- Setup: `G1` files A and B. Stimulus: bob claims A's step through MCP and calls `mesh_done` → A
  `done`; `G2` raises a complete record without B → B `done` (resolved).
- Expected: every finding step `done` (control that both paths ran); CG `in_progress`; no `goal.done`
  for CG. FAIL: CG `done`. Mutation: drop the `sink` check in `goalComplete` → red.

### test_AC08_plan_refused_route
- `POST /v1/goals/${CG}/plan` with a valid one-step plan (`approve: true`) → 409 `{error: \`${CG} is a
  clean-audit goal; its steps come from audits\`}`; with an invalid plan (a dep on an unknown step id,
  which on a normal goal gives a validation error: control on a plain goal) → the same 409 text. Plan
  versions of CG unchanged (one).
- FAIL: 201, or a 400/422 validation error first. Mutation: validate before the clean-audit check → red
  on the invalid plan.

### test_AC08_plan_refused_cli
- `mesh goal plan ${CG} --file plan.yaml` (a valid one-step plan written to a temp dir) and with an invalid
  one → exit non-zero both times, stderr contains `${CG} is a clean-audit goal; its steps come from
  audits`. Control: the same valid file on a plain goal → exit 0.

## AC-09 Skipped sink still sinks

`describe("RL-9 AC-09 skipped sink")`.

### test_AC09_debrief_files_then_file_skipped
- `G = run({steps: [AUDIT, DEBRIEF({consumes: ["open"], may_set: ["accepted"]}), FILE({deps:
  ["debrief"], when: {open: true}})]})`; `raise(G, [F])`; ann holds `G.debrief`, `mesh_dispose` F
  `accepted` with `link: LINK(fF)`, then `mesh_done`.
- Expected: `G.file` `skipped` (no open item left); `cag()` exists and has F's step
  `fid(LIN(), fF)` `ready`; `goal.sunk` `from: \`${G}.file\``. Control: item F `accepted` with the link.
- FAIL: `file` not skipped, or no step for F. Mutation: sink only from `doneStep` (not from `settleSteps`)
  → red.

## AC-10 A sink never fails the filer

`describe("RL-9 AC-10 sink failure")`.

### test_AC10_topic_deleted
- Setup: AC-01 state; `G2 = run()`; `raise(G2, [A, B, C])`. Then `POST /v1/topics/ci/delete` (ann, the
  creator) → 200.
- Stimulus: `file(G2, [acc(fC)])`.
- Expected: the `mesh_done` reply has no `isError`; `G2.file` `done`; its notes contain one line matching
  `/^sink failed: .+/`; one `goal.sink_failed` with payload `{from: \`${G2}.file\`, reason}` where
  `reason` is a non-empty string and the note equals `sink failed: ${reason}`; no step for C; CG snapshot
  unchanged; no `goal.sunk` from `G2.file`. CG keeps `sink {repo: "r", topic: "ci"}` and no longer has the
  tag `ci`. Positive control: the G1 `goal.sunk` exists.
- FAIL: the done refused, no note/event, a step for C, or a partial sink.
- Mutations: (1) throw inside the transaction → done refused → red; (2) write steps before the topic
  check → C step → red.

### test_AC10_no_goal_opened (contract)
- Topic deleted before the first sink → no clean-audit goal, the note and event as above, `G1.file`
  `done`. Mutation: open the goal before checking → red.

## AC-11 Checks

`describe("RL-9 AC-11 checks")` in `test/sink-cli.test.ts` (route status + CLI text).

Preset texts (repo presets committed with `commitPreset` into ann's checkout `r`, as
`test/pulse-cli.test.ts`): `NO_ACC` = audit + file with `sink: {topic: ci}` and `may_set: [dismissed]`;
`NOPE` (`sink: {topic: nope}`), `ALL` (`topic: all`), `PH` (`sink: {topic: "{topic}"}`).

- `test_AC11_sink_needs_accepted`: `POST /v1/goals/:id/plan` with NO_ACC's steps → 422 `{error: "sink in
  step file needs a stage that may set accepted"}`; `POST /v1/pulses` with NO_ACC's snapshot → 422 same
  text; `mesh pulse add --preset no-acc --repo r --every 7d` and `mesh goal plan <G> --file` → exit
  non-zero, stderr contains the text. Sibling `test_AC11_pulse_update` (contract): update to NO_ACC →
  422.
- `test_AC11_unknown_topic`: NOPE → 400 `unknown topic nope (define with: mesh topic add <name>)`; ALL →
  400 `unknown topic all (define with: mesh topic add <name>)`, both through plan and pulse add.
- `test_AC11_placeholder`: PH with no `topic` param → 400 `bad topic "{topic}"`; with `--params
  topic=CI` → `mesh goal plan <G> --preset ph --repo r --params topic=CI` exit 0 and the stored step
  `G.file` has `policy.sink` `{topic: "ci"}` (where the step view carries policy; else the plan
  version's step); `mesh pulse add … --params topic=CI` → exit 0, then `POST /v1/pulses/<id>/fire` → the
  goal's `file` step has `sink.topic === "ci"`.
- Positive control: FILE() (valid) on a plain goal → 201.
- FAIL: accepted when it should be refused, another status or text, `CI` stored. Mutations: (1) skip
  the may_set check → red; (2) check the topic before filling placeholders → `{topic}` passes or
  `CI` refused → red; (3) do not lowercase → `CI` stored → red.

## AC-12 Truncation

`describe("RL-9 AC-12 truncation")`.

### test_AC12_title_and_brief
- Item `L = item("rl", {severity: "S1", title: "t".repeat(200), proposal: "p".repeat(4000), evidence:
  Array.from({length: 20}, (_, i) => ({path: \`src/e${i}.ts\`, note: String(i % 10).repeat(1000)}))})`
  (ASCII only, so length = characters); filed in G1.
- Expected: title `=== ("[S1] " + "t".repeat(200)).slice(0, 199) + "…"` (length 200); brief
  `length <= 8000`, ends with `LAST(LIN())`, contains `… (cut; mesh items ${LIN()})`, and that text's index
  is before the last line's. Control: AC-01's brief has no `(cut;`.
- FAIL: a field over the limit, the last line lost. Mutation: cut the brief at 8000 without keeping the
  last line → red.

## AC-13 Ready order

`describe("RL-9 AC-13 ready order")` (`test/sink-goals.test.ts`) and `describe("RL-9 AC-13 mesh
next")` (`test/sink-cli.test.ts`).

### test_AC13_severity_within_goal
- Setup `world(sev)`: `G1` files X3 (sev[0]); then a plain goal `G2` (`r.goal`, one step `s`, `ready`);
  then a later run files X1, X2, X4 (sev[1..3]) in one record; X4's step assigned to ann's machine
  (`r.assign(ann, id, {to: <ann's machine nick>})`). Every other step of both relays is done or
  skipped.
- Main: `world(["S3", "S1", "S2", "S4"])`; `ids = GET /v1/steps?ready=1` with ann's machine login
  (`w.api(ann, …)`).
- Control twin `test_AC13_control_same_severity`: `world(["S3", "S3", "S3", "S3"])` (same fps → same
  finding ids; goal ids are the same as creation order is the same) → `base`. In the control assert that
  `G2.s` lies between two G1 finding steps in `base` (else the test-writer moves `G2`'s creation until it
  does, so a cross-goal sort is caught).
- Expected: `ids[0] === X4 step`; `ids.slice(1)` equals `base.slice(1)` with the positions held by G1
  finding steps refilled with `[X1, X2, X3]` steps in that order; `G2.s` at the same index as in `base`.
- FAIL: another order, or the offered step not first.
- Mutations: (1) sort all ready steps by severity → `G2.s` moves → red; (2) sort before splitting off the
  offered part → X4 not first or S1 before it → red; (3) no sort → red.

### test_AC13_mesh_next
- Same main world; `mesh next` (ann's CLI) → the step ids in its output, in order of appearance, equal
  `ids`. Control: the output lists `G2.s`.

## AC-14 Goal drop

`describe("RL-9 AC-14 goal drop")` (`test/sink-goals.test.ts`) and `describe("RL-9 AC-14 mesh goal
drop")` (`test/sink-cli.test.ts`).

### test_AC14_drop_clean_audit_goal
- Setup: CG with a `ready` step (A), a `blocked` step (B requires C), and C's step patched to `parked`
  (`patchStep`); A's step offered to bob's machine. No held step.
- Stimulus: ann `POST /v1/goals/${CG}/drop {reason: "done with it"}` → 200.
- Expected: CG `dropped`; A, B and C steps `dropped`; A's offer `withdrawn`; one `goal.dropped` with
  payload `toMatchObject({reason: "person", by: "ann", comment: "done with it"})`; one `step.dropped` per
  step (3). Then a new run files D → `cag()` is a **new** goal (id ≠ CG, same title, sink), with D's
  step; `cagAll()` has two entries.
- FAIL: a step left open, no event, no new goal (or D's step added to the dropped CG).
- Mutation: leave `parked` steps → red; find the clean-audit goal without the "not dropped" filter →
  red.

### test_AC14_refusals
- A step `claimed` (bob, MCP) → 409 `{error: \`${CG} has held steps: ${id}; release them first\`}`; a
  `paused` one (`patchStep`) → 409 naming it; after the release → 200 (control). carol → 403; root (admin)
  → 200 on another goal (control); an approver (hub role, when the World's hub config can give one; else
  named "not run") → 200. Unknown `G999` → 404. Again on a dropped goal → 409 `${CG} is dropped`; a `done`
  plain goal → 409 `<G> is done`.
- Mutation: count only `claimed` as held → paused dropped → red; owner-only rule → admin 403 → red.

### test_AC14_pulse_and_calibration_goals
- A pulse goal (`Pk` pattern: `pulseOk` with `overlap: "skip"`, `fireOk`) dropped by its owner → 200, the
  slot keeps its outcome (`slotOf` unchanged), and the next fire opens a new goal (the overlap rule sees no
  open goal). A calibration goal (`Ck` `openC` pattern) dropped by its calibrator → its dismissals are
  uncalibrated again (`hashStats` `calibrating: 0`, `uncalibrated` back to the count before).
- Mutation: drop only goals with `sink` → 409/422 → red.

### test_AC14_cli
- `mesh goal drop ${CG} --reason "x"` → exit 0, stdout `Dropped ${CG}`; `goal.dropped` comment `x`. A
  held step → exit non-zero, stderr contains `has held steps`.

## AC-15 Backfill

`describe("RL-9 AC-15 backfill")` (`test/sink-goals.test.ts` for the route,
`describe("RL-9 AC-15 mesh items sink")` in `test/sink-cli.test.ts`).

- Setup: a lineage `LIN("plain")` whose goal (`run({preset: "plain", steps: [AUDIT, FILE({sink:
  undefined})]})`, owner ann) files P1 (S1), P2 (S2), P4 (S4), P1 with `requires: [fP2]`; no clean-audit
  goal (control: `cag()` undefined).
- `test_AC15_dry_run`: `mesh items sink plain|r|audit --topic ci --min-severity S2 --dry-run` (ann) →
  exit 0, stdout `would add 2 to a new goal`; no clean-audit goal, no `goal.created`/`goal.sunk` added
  (event counts). Route: `POST /v1/items/sink {lineage, topic: "ci", min_severity: "S2", dry_run: true}`
  → 200, `goal: null`, `added` the two ids (sorted equal to `fid` of P1, P2), `reopened: []`, `skipped`
  a number.
- `test_AC15_apply_and_idempotent`: without `--dry-run` → stdout `${CG}: added 2, reopened 0`; CG has
  exactly the P1 and P2 steps, owner ann (the caller), **no deps** (P1's requires ignored); again →
  `${CG}: added 0, reopened 0`; `--dry-run` again → `would add 0 to ${CG}`. Sibling: P1's step done,
  `mesh items sink` again → `reopened 1` (rules 3).
- `test_AC15_who`: carol (member, not owner of the lineage's newest goal or of CG, not admin) → 403
  (exit non-zero); root (admin) → 200 (control); bob as owner of a newer goal of the lineage → 200.
  `--topic nope` → 400 `unknown topic nope …`.
- FAIL: wrong count, a change on dry run, duplicates on the second call, deps, or no 403.
- Mutations: (1) ignore `min_severity` → `added 3` → red; (2) write on dry run → red; (3) apply requires
  → red.

## AC-16 `mesh show` header

`describe("RL-9 AC-16 mesh show")`, `test/sink-cli.test.ts`.

### test_AC16_header_counts
- Setup: G1 files X1 (S1), X2 (S2), X3 (S2), X4 (S3), X5 (S3); ann does X4's step (`mesh_done`) →
  done; a triage run dismisses X5 → its step dropped.
- Stimulus: `mesh show ${CG}`.
- Expected: exactly one line `clean audits: ci on r · open S1 1 · S2 2 · S3 0 · S4 0 · done 1 · dropped
  1`; lines with `[S1] T-X1`, `[S2] T-X2`, `[S2] T-X3`. Control: `mesh show ${G1}` has no `clean audits:`
  line.
- FAIL: another line or counts. Mutation: count done/dropped steps as open → red.

## AC-17 Id and title helpers (unit)

`describe("RL-9 AC-17 finding step helpers")`, `src/core/finding-step.test.ts`.

- `test_AC17_id_fixed`: for `("relay|r|audit", "aaaaaaaaaaaaaaaa")` the id equals a literal pinned by the
  test-writer from the documented formula (computed once with the test-side `fid` and written into the
  test), matches `/^f-[a-z2-7]{16}$/`, length 18; equals `fid(...)`.
- `test_AC17_id_other_lineage`: same fp, lineage `relay2|r|audit` → a different id.
- `test_AC17_title_cut`: full titles of 199 and 200 characters → unchanged; 201 → first 199 + `…`
  (length 200).
- FAIL: another id, a title over 200. Mutation: hash `<fp>|<lineage>` → red; cut at 200 then add `…` →
  201 → red.

## AC-18 Docs, events, skill, schemas

`test/docs-rl9.test.ts`, `describe("RL-9 AC-18 docs")`:
- `test_AC18_concepts`: `docs/guide/concepts.md` has a paragraph (split on blank lines) with
  `clean-audit goal` (case-insensitive) and `sink`; one on severity order (`S1` and `severity` and
  `ready` or `order`); one with `requires`; one with `mesh goal drop`.
- `test_AC18_guide`: `docs/guide/scheduled-reviews.md` has the heading `## Clean-audit goals` after `##
  Debrief` (index of the heading greater than the Debrief heading's).
- `test_AC18_skill`: `MESH_SKILL` has a paragraph on finding steps mentioning `brief`, `worktree` and
  `tracking row`; `skills/mesh/SKILL.md` equals `MESH_SKILL`.
- `test_AC18_events`: `docs/events.md` contains `goal.sunk`, `goal.sink_failed`, a line with `goal.dropped`
  and `person`, a line (or paragraph) with `step.reopened`, `refiled` and `reverted`.
- `test_AC18_api_table`: `docs/plan/implementation-plan.md` has a line with `/v1/goals/:id/drop` and one
  with `/v1/items/sink`.
- `test/schemas.test.ts` route table: `HUB_API` rows `POST /v1/goals/:id/drop` and `POST /v1/items/sink`
  with `rule: "member"`, `scope: "goals:write"`, `tag: "goals"`; the OpenAPI document is up to date
  (`pnpm schemas` leaves no diff: `git diff --exit-code schemas/`).
- Specific names: review step (not automated), as in RL-7/RL-8.
- FAIL: a missing entry or mismatch. Mutation: remove the guide heading → red.

## AC-19 CI

- `test/schemas.test.ts`: version `0.1.27` (`test_AC19_version`); `HubStore.SCHEMA_VERSION === 11`
  (`test_AC19_schema_version`).
- `pnpm check` (lint, typecheck, boundaries, test, build) passes; Postgres legs not run locally.
- FAIL: any check red, or the schema version changed. Mutation: bump `SCHEMA_VERSION` → red.

## Coverage

| Criterion | Tests |
|---|---|
| AC-01 | `test_AC01_goal_and_steps`, `test_AC01_unlinked_not_filed`, `test_AC01_no_items_no_goal` |
| AC-02 | `test_AC02_new_only`, `test_AC02_nothing_new_no_event` |
| AC-03 | `test_AC03_two_steps_one_fp`, `test_AC03_repo_exact_strings` |
| AC-04 | `test_AC04_dep_and_unblock`, `test_AC04_not_in_goal`, `test_AC04_cycle`, `test_AC04_ambiguous_and_own_lineage`, `test_AC04_union_over_goal`, `test_AC04_requires_only_accepted` |
| AC-05 | `test_AC05_ready_closed_and_dependant_settled`, `test_AC05_held_only_noted`, `test_AC05_failed_only_noted`, `test_AC05_partial_record_no_change` |
| AC-06 | `test_AC06_reopen_after_resolve`, `test_AC06_reopen_with_deps_blocked`, `test_AC06_dropped_refiled`, `test_AC06_rule4_ready_and_held` |
| AC-07 | `test_AC07a_dismiss_and_defer_drop_ready`, `test_AC07b_debrief_dismiss_then_revert`, `test_AC07_revert_accepted_drops`, `test_AC07_agent_decider_by_owner` |
| AC-08 | `test_AC08_never_done`, `test_AC08_plan_refused_route`, `test_AC08_plan_refused_cli` |
| AC-09 | `test_AC09_debrief_files_then_file_skipped` |
| AC-10 | `test_AC10_topic_deleted`, `test_AC10_no_goal_opened` |
| AC-11 | `test_AC11_sink_needs_accepted`, `test_AC11_pulse_update`, `test_AC11_unknown_topic`, `test_AC11_placeholder` |
| AC-12 | `test_AC12_title_and_brief` |
| AC-13 | `test_AC13_severity_within_goal`, `test_AC13_control_same_severity`, `test_AC13_mesh_next` |
| AC-14 | `test_AC14_drop_clean_audit_goal`, `test_AC14_refusals`, `test_AC14_pulse_and_calibration_goals`, `test_AC14_cli` |
| AC-15 | `test_AC15_dry_run`, `test_AC15_apply_and_idempotent`, `test_AC15_who` |
| AC-16 | `test_AC16_header_counts` |
| AC-17 | `test_AC17_id_fixed`, `test_AC17_id_other_lineage`, `test_AC17_title_cut` |
| AC-18 | `test_AC18_concepts`, `test_AC18_guide`, `test_AC18_skill`, `test_AC18_events`, `test_AC18_api_table`, route-table and OpenAPI tests (+ review for names) |
| AC-19 | `test_AC19_version`, `test_AC19_schema_version`, `pnpm check` |

## Not planned (contract parts no AC drives)

- Sink triggers through plan approve, gate decide, reopen and resume (`settleSteps` paths other than a
  step's done): only the done path (AC-01) and the skip-after-done path (AC-09) are driven; a mutation
  that sinks only from `doneStep` is caught by AC-09.
- `presetChecks` on ingest: no ingest fixture with a `sink`; covered by the shared check (AC-11) and
  review.
- A store error inside the sink failing the caller's transaction: no World hook for a store fault in
  this path beyond `Pk.storeWrap`; the test-writer may add it with `storeWrap` if the write method is
  reachable from the exported store type.
- Older hubs and daemons (Compatibility): no World hook for an older hub; review only.
- Web views: out of scope (severity is in the title, which AC-01 checks).
