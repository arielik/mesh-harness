# Test plan RL-10: Findings name their repo (clean-audit steps land where the fix is)

Spec: `docs/specs/RL-10.md` (approved after review round 3; its blocker fixed, round-3 suggestions
applied). Builds on `docs/specs/RL-9.md`.

Inputs read: `docs/specs/RL-10.md` (problem, scope, interface contracts, acceptance criteria, open
questions); `docs/specs/RL-9.md` (for the RL-9 names RL-10 keeps); the role file
`assets/sdd/.claude/agents/test-planner.md`; the format of `docs/specs/plans/RL-9-test-plan.md`; the
file names under `test/` and `test/helpers/`; the test kits `test/helpers/sink-kit.ts` (`Sk`: `start`,
`run`, `hold`, `tool`, `toolOk`, `doStep`, `stage`, `stageOk`, `debriefAccept`, `tick`, `raise`,
`file`, `goals`, `cagAll`, `cag`, `CG`, `goalView`, `fsteps`, `fs`, `step`, `maybeStep`, `notes`, `ev`,
`activity`, `items`, `item`, `patchStep`, `snapshot`; `LIN`, `fid`, `LAST`, `LINK`, `AUDIT`, `FILE`,
`TRIAGE`, `DEBRIEF`, `acc`, `recArgs`, `IA` … `IF`, `fpR`, `fA` … `fF`), `test/helpers/review-kit.ts`
(`item`, `disp`, `fpOf`, `base32`, `markOf`), the member list of `test/helpers/relay-kit.ts` (`act`,
`cli` with its `requests`, `stepOf`, `allEvents`, `plan`, `goal`) and of `test/helpers/world.ts`
(`person`, `login`, `tool`, `hook`, `flush`, `hubStore`); the existing tests used as patterns:
`test/sink-hub.test.ts` (AC-07b debrief + revert, the headless triage through routes),
`test/sink-goals.test.ts` (AC-15 backfill route), `test/sink-cli.test.ts` (`cli`, AC-15 usage errors,
AC-16 `mesh show` header), `test/review-cli.test.ts` (`mesh items` lines and `--json`),
`test/review-hub.test.ts` (`PROBLEMS`, `markOf`, `fold` counts), `test/docs-rl9.test.ts`, the RL-6 and
RL-9 version / route-table / OpenAPI blocks of `test/schemas.test.ts`; the section list of
`docs/guide/scheduled-reviews.md` and `docs/guide/concepts.md`.

Not read: `docs/specs/plans/RL-10-impl-plan.md` (the implementation plan, if any), branch `impl/RL-10`
and its worktree; any implementation source of this row or of the code it changes (`src/hub/*`,
`src/protocol/*.ts`, `src/core/*` other than `*.test.ts`, `src/cli/*`, `src/store/*`,
`src/daemon/*`), not even to check a name. Interface names below come from the spec only. Where a test
needs a name the spec does not spell out, the test-writer takes it from the exported type, not from
this plan.

Planned black-box from the contracts. Every negative assertion has a positive control in the same test
or a named sibling, so a test cannot pass because nothing happened. Each criterion names at least one
mutation of the implementation that must turn one of its tests red; the implementer or reviewer applies
it once by hand, confirms red, and reverts.

Rules every test follows (as RL-9):
- Expected finding-step ids are computed **test-side** with `fid(lineage, fp)` (`f-` + 16 base32 chars
  of `sha256("<lineage>|<fp>")`), never from the implementation. The local id does not depend on the
  repo, so the same `fid` is expected in every goal a step is moved to.
- Steps by full id, items by `fp`, goals by `sink` (`k.cag(repo)`; never by position or goal number),
  events by type + step/goal + payload.
- Relay stages are interactive steps run by persons through the hub tools (MCP: `mesh_claim`,
  `mesh_review`, `mesh_dispose`, `mesh_done`); records with `repo` on items go through `mesh_review`, so
  the daemon's tool schema is exercised. Route calls are used for refusals (status and text), for reads,
  and for `POST /v1/items/retarget` where the route result is asserted.
- "Nothing written" compares a world snapshot (`k.world()`, below) taken before the stimulus with one
  taken after a `w.flush()`.
- Time: `k.tick()` between a close and a later filing, so "filed after close" is decided by time, not
  by the event-order tie-break, unless a test says otherwise.
- RL-9 tests (`test/sink-*.test.ts`, `test/docs-rl9.test.ts`) are not edited. `test/helpers/sink-kit.ts`
  gets **additions only**; no existing export changes signature or behaviour.

## Spec points the test-writer should know

- **AC-06b event reason.** AC-06b says the sink's revive of the moved-away `r` step emits
  `step.reopened` reason `moved`; the contract ("Placing the home step", last paragraph) says
  `refiled` for a sink's reopen or revive and `moved` for a move's. The plan isolates this assertion in
  its own test (`test_AC06b_sink_revive_reason`) and pins the AC's value (`moved`). If the
  implementation follows the contract, that one test is red and the conflict goes back to the spec
  owner; no other test depends on the reason of a sink revive.
- **Version line.** AC-13 requires `0.1.28`. The two existing release-line assertions in
  `test/schemas.test.ts` (`RL-6 … test_AC16_version` and `RL-9 … test_AC19_version`, both
  `0.1.27`) are the release line every row bumps (RL-9 did the same, "was v0.1.26"); they become
  `0.1.28` with the comment `RL-10 AC-13: the release is v0.1.28 (was v0.1.27)`. That literal is the only
  edit to an existing test; the RL-9 sink tests and kit exports stay unchanged.

## Fixture changes (test side only)

| File | Change |
|---|---|
| `test/helpers/sink-kit.ts` | `X = "x"`, `Y = "y"` (target-only repos). `IR(it, repo)` = `{...it, repo}` (an item with a target repo). `TITLE(repo, topic = "ci") = \`Clean audits: ${topic} on ${repo}\`` (single-segment repos: the repo name is the repo). Items `IG = item("rg", {title: "T-G"})` … `IN` as needed, fps `fG` … by `fpR`. |
| `test/helpers/sink-kit.ts` | `fpByRule(rule, lineage = LIN())`: the fp of the item whose stored `key.rule === "other:" + rule` (read back from `items()`), for items whose key has no `path` (AC-08 J) where the test cannot compute the fp. `noPath(rule, o)` = `item(rule, o)` with `key` `{rule, symbol: "s-" + rule}` (no `path`). |
| `test/helpers/sink-kit.ts` | `retarget(who, body)` = `call(who, "POST", "/v1/items/retarget", body)`; `retargetOk(who, body)` expects 200 and returns `json` (a `RetargetResult`). |
| `test/helpers/sink-kit.ts` | `release(p, id)` = `r.act(p, id, "release", {})` expecting 200, then `flush`. `finish(p, id)`: claim and finish a finding step **through the routes** (`r.act(p, id, "claim", {})`, `r.act(p, id, "done", {outcome: "done", summary: "fixed"})`, each 200), because a step in repo `x` has no checkout on any person's machine. If the hub refuses a route claim of that step for repo reasons, the test-writer adds a World person `dan = w.person("dan", "x", {shareSessions: "me"})` in `Sk.start({xPerson: true})` and uses `doStep(dan, id)`; either is a person finishing it, which is what the ACs need. |
| `test/helpers/sink-kit.ts` | `revertD(D, f)` = `POST /v1/steps/${D}/dispositions/revert {fingerprint: f}` (ann) → 200. `debriefDismiss(R, f)`: ann holds `R.s("debrief")`, `mesh_dispose {fingerprint: f, disposition: "dismissed", reason: "R-" + f, answer: "ANS-" + f}`; returns the debrief id. `DEBRIEF_DISMISS = DEBRIEF({consumes: ["accepted"], may_set: ["dismissed"]})` (the RL-9 AC-07b shape). |
| `test/helpers/sink-kit.ts` | Reads: `liveOpen(f, lineage = LIN(), topic = "ci")` = every finding step with `finding` `{lineage, fp: f}` over all non-dropped clean-audit goals of `topic` (`goals()` filtered by `sink.topic`), without `movedTo`, state not `done`/`skipped`/`dropped` (the "at most one open step" check: tests assert `toHaveLength(1)` or `0`); `allFor(f)` the same without the filters (moved-away and closed included). `world()` = `{goals: snapshot(G) for every clean-audit goal, items: items() rows (fp, state, repo, history length), events: count by type over allEvents()}` for "nothing written". |
| `test/helpers/sink-kit.ts` | `moveOf(fromId)` = the single `step.dropped` event for `fromId` whose payload `reason === "moved"` (expects at most one). |
| `test/schemas.test.ts` | Release line `0.1.28` (see above); new `describe("RL-10 AC-12/AC-13 routes and schema")` with the route row, OpenAPI path, `SCHEMA_VERSION === 11`. |

The relay fixture stays RL-9's: `Sk.start()` (ann, bob with daemons in repo `r`; carol a member login;
root admin; topic `ci`); `run()` = audit → file with `sink: {topic: ci}`, lineage `LIN()` =
`relay|r|audit`; "a later run" = another `run()` of the same preset.

## Surfaces and files

| Surface | File | New or extended |
|---|---|---|
| World (hub, daemons, MCP): recording the repo, sink by target repo, fold move, placing, revive, sync across goals, deps, retarget route, backfill route | `test/retarget-hub.test.ts` | new |
| CLI against a World hub: `mesh items` (arrow, `--json`), `mesh items retarget`, `mesh items sink` grouped output, `mesh show` counts after a move | `test/retarget-cli.test.ts` | new |
| docs / skill | `test/docs-rl10.test.ts`, `src/claude/skill.test.ts` (unchanged: `MESH_SKILL` = `skills/mesh/SKILL.md`) | new / unchanged |
| CI | `test/schemas.test.ts` (release line, route table, OpenAPI, `SCHEMA_VERSION`) | extended |
| kit | `test/helpers/sink-kit.ts` | extended (additions only) |

ACs that need both the World and the CLI (AC-06 … AC-10) put the CLI command in
`test/retarget-cli.test.ts` and the state assertions next to it (the CLI file reads hub state back, as
`sink-cli.test.ts` does); the same scenario's route-level assertions live in `test/retarget-hub.test.ts`
with `retargetOk` in place of the command.

Describe names follow `RL-10 AC-NN <topic>`; tests are `it("test_ACNN_<what>")`.

---

## AC-01 Sink by target repo

`describe("RL-10 AC-01 sink by target repo")`, `test/retarget-hub.test.ts`.

### test_AC01_three_goals
- Setup: `Sk.start()`; `G1 = run()`.
- Stimulus: `raise(G1, [IR(IA, X), IR(IB, Y), IC])` through `mesh_review` (control: no `isError`; the
  fps are `fA`, `fB`, `fC`: `repo` is not in the key); `file(G1, [acc(fA), acc(fB), acc(fC)])`.
- Expected:
  - `cag(X)`, `cag(Y)`, `cag("r")` each exist, `title` `TITLE(X)` / `TITLE(Y)` / `TITLE("r")`, `sink`
    `toStrictEqual({repo, topic: "ci"})`, owner ann.
  - `fsteps(cag(X))` is exactly `[${Gx}.${fid(LIN(), fA)}]` with `repo: "x"`, `finding`
    `{lineage: LIN(), fp: fA}`, `ready`; likewise B only in Gy (`repo: "y"`), C only in Gr (`repo: "r"`).
  - Exactly three `goal.sunk` with `from: G1.file`, one per goal, each `added` the one id of its goal,
    `reopened: []`.
  - `liveOpen(f)` has length 1 for each of A, B, C.
- FAIL state: a step in another goal or with `repo` `r` for A/B; a missing goal; one `goal.sunk` listing
  all three; an id that differs from `fid`.
- Mutations: (1) group by the lineage repo (RL-9) → all three in Gr → red; (2) set `repo` on the step
  from the lineage repo but the goal from the target → red on `repo`; (3) one `goal.sunk` for the
  whole sink → red; (4) include `repo` in the fingerprint → fps differ → red at the control.

### test_AC01_repo_equal_lineage_repo (contract)
- `IR(IA, "r")` (explicit lineage repo) filed → one goal (Gr), A's step there; no other clean-audit goal.
  Mutation: treat "repo set" as "foreign" → red.

## AC-02 The repo is recorded and kept

`describe("RL-10 AC-02 recording the repo")`, `test/retarget-hub.test.ts`; CLI part in
`describe("RL-10 AC-02 mesh items")`, `test/retarget-cli.test.ts`.

### test_AC02_row_and_kept
- Setup: AC-01 state.
- Expected 1: `item(fA).repo === "x"`; `item(fC)` has no `repo` key (`"repo" in row` false);
  `item(fB).repo === "y"`.
- Stimulus: `G2 = run()`; `raise(G2, [IA, IB, IC])` (A and B **without** repo, complete).
- Expected 2: `item(fA).repo === "x"`, `item(fB).repo === "y"` (kept); A's step still in Gx, `ready`,
  same `fixCycles`; Gr has no step for A (`maybeStep(${Gr}.${fid(LIN(), fA)})` undefined); no
  `item.retargeted` event; `liveOpen(fA)` length 1.
- Positive control: A is marked `repeat` in G2's fold (the record was folded, see AC-03).
- FAIL: repo not stored, cleared by the record without it, a step moved back to Gr.
- Mutation: on fold, set `row.repo = item.repo` unconditionally (undefined clears it) → red.

### test_AC02_repo_length
- A record (route `POST /v1/steps/${G.audit}/review` by the holder) with one item `repo: "x".repeat(301)`
  → 400; `"x".repeat(300)` → 201 (control). `repo: "   "` → 400 (empty after trim). `repo: "  x  "` →
  201 and the row's `repo === "x"` (trimmed). Through MCP, the 301-character item makes `mesh_review`
  return `isError` (the daemon's tool schema or the hub's 400, either).
- FAIL: the long or blank repo accepted, the untrimmed value stored. Mutation: no max length → red.

### test_AC02_items_cli (`retarget-cli.test.ts`)
- AC-01 state; `mesh items ${LIN()}` (ann) → exit 0; the line of A contains `src/a.ts → x`; B's `src/a.ts
  → y`; C's line contains `src/a.ts` and no `→`. An item with no path and `repo: x` (`noPath("rz")` with
  `IR`, raised in G1) prints `- → x`. An item with `repo: "r"` (the lineage repo) prints no `→`.
- `mesh items ${LIN()} --json` → `JSON.parse(out)` equals the route's `GET /v1/items?lineage=…` (as
  RL-2 AC-23), A's row has `repo: "x"`, C's row has no `repo`.
- FAIL: no arrow, an arrow for C or the lineage-repo item, `repo` missing in JSON. Mutation: print the
  arrow whenever `repo` is set → red on the lineage-repo item.

## AC-03 Same fingerprint, two repos

`describe("RL-10 AC-03 same fp two repos")`, `test/retarget-hub.test.ts`.

### test_AC03_refused
- Setup: `G1 = run()`; ann claims `G1.audit` (`hold`). `PROBLEMS(n, ps)` as `review-hub.test.ts`.
- Stimulus: route `POST /v1/steps/${G1.audit}/review` with `items: [IR(IA, X), IR(IA, Y)]`.
- Expected: 422, `json.error` contains `item ${fA} is listed for more than one repo (x, y); put the repo in
  its key` (and equals `PROBLEMS(1, [that text])` when it is the only problem); `items()` empty; no
  `review.*` event added (`world()` unchanged).
- Siblings (contract): `[IR(IA, X), IA, IR(IA, Y)]` → `(x, r, y)` (absent = lineage repo, record order);
  `[IR(IA, X), IA, IR(IA, X)]` → `(x, r)` (distinct).
- Positive control: `[IR(IA, X), IR(IA, X)]` → 201, one item A with `repo: "x"`; `[IA, IA]` → 201
  (RL-2: first kept).
- FAIL: 201 for two repos, 422 for one, other text, an item stored.
- Mutations: (1) no check → 201 → red; (2) compare `repo` with absent as `undefined` (not the lineage
  repo) → `[IR(IA, "r"), IA]` refused → red (add that pair as a positive control: 201).

### test_AC03_repeat_same_fp
- AC-01 state (A raised with `repo: x`); `G2 = run()`; ann holds `G2.audit` and submits via the route a
  complete record raising `IA` (no repo) → 201; `markOf(res.json, fA) === "repeat"`;
  `res.json.review.fold` has `new: 0` for A (`repeat ≥ 1`); `items()` still has exactly one row with
  `fp === fA`.
- FAIL: `new`, a second row. Mutation: hash `repo` into the fp → red.

## AC-04 Resolved and dismissed sync across repos

`describe("RL-10 AC-04 sync across goals")`, `test/retarget-hub.test.ts`.

### test_AC04_resolved_in_target_goal
- AC-01 state. `G2 = run()`; **bob** runs `G2.audit` complete raising B and C only.
- Expected: item A `resolved` (control); A's step in Gx `done`, `summary === \`resolved by ${G2.audit}\``;
  B's step in Gy and C's step in Gr unchanged (`snapshot` before/after equal for Gy and Gr).
- FAIL: A's step not found (still `ready`), or a step in another goal touched.
- Mutation: look up finding steps only in the lineage repo's clean-audit goal (RL-9) → A `ready` → red.

### test_AC04_dismissed_in_target_goal
- AC-01 state. `G2 = run({steps: [AUDIT, TRIAGE()]})`; `raise(G2, [IA, IB, IC])`; triage (ann)
  `[disp(fB, "dismissed", {reason: "RB"})]`.
- Expected: B's step in Gy `dropped`, `summary === "dismissed by ann: RB"`, `step.dropped` reason
  `dismissed`; Gx and Gr snapshots unchanged.
- FAIL / Mutation: as above.

## AC-05 Fold move

`describe("RL-10 AC-05 fold move")`, `test/retarget-hub.test.ts`.

### test_AC05_open_step_moved_by_fold
- Setup: `G1 = run()`; `raise(G1, [ID, IE])`; `file(G1, [acc(fD), acc(fE, {requires: [fD]})])` →
  `rD = ${Gr}.${fid(LIN(), fD)}` `ready`, `rE` `blocked` on `rD` (control). `k.tick()`.
- Stimulus: `G2 = run()`; **bob** runs `G2.audit` complete raising `IR(ID, X)` and `IE`; **no** `file`
  stage done (G2's file stays open: the move needs no sink).
- Expected, right after the audit's `mesh_review` (before `mesh_done`; read with `stage(..., {done:
  false})`):
  - `item(fD).repo === "x"`; one `item.retargeted` with payload `toMatchObject({lineage: LIN(), fp: fD,
    from: "r", to: "x", by: "bob"})` and event `user` bob.
  - `Gx = cag(X)` exists (`TITLE(X)`, owner ann = Gr's owner); `xD = ${Gx}.${fid(LIN(), fD)}` (same
    local id as `rD`): `repo: "x"`, `ready`, `finding` `{lineage: LIN(), fp: fD}`, notes contain
    `moved from ${rD}`, `fixCycles` equal to `rD`'s.
  - `rD`: `dropped`, `movedTo === xD`, `summary === \`moved to ${xD}\``; `moveOf(rD).payload`
    `toMatchObject({reason: "moved", to: xD})`, event `user` ann (A's owner: not a retarget).
  - `rE`: `ready`, notes contain `dep ${rD} moved to ${xD}`.
  - One `goal.sunk` on Gx with `from: G2.audit`, `added: [xD]`.
  - `liveOpen(fD)` is `[xD]`.
- FAIL: two open steps for D, `rD` not dropped or without `movedTo`, E `blocked` or without the note, the
  move only after the sink.
- Mutations: (1) no fold move (move only on sink) → red; (2) `rD` dropped without `movedTo` → red; (3)
  skip settling `A`'s dependants → E blocked → red; (4) a new local id in Gx → red.

### test_AC05_fixcycles_carried (contract)
- As above, but before G2: `rD` done by ann (`doStep`), then a run refiles D → `rD` reopened,
  `fixCycles` 1 (control). Then the fold move → `xD.fixCycles === 1`.
- Mutation: created steps always `fixCycles: 0` → red.

### test_AC05_move_deps_in_new_goal (contract, step 4)
- `file(G1, [acc(fD, {requires: [fE]}), acc(fE)])` → `rD` blocked on `rE`. Fold moves D to x (E stays) →
  `xD` `ready`, no deps, notes contain `requires ${fE}: not in this goal`. Sibling: E moved to x first
  (by a fold), then D → `xD` deps `[xE]` (as the view lists deps), `blocked`.
- Mutation: copy `rD`'s deps across goals → red.

### test_AC05_topic_gone (contract, step 1)
- `rD` ready; `POST /v1/topics/ci/delete` (ann) → 200; G2's audit raises `IR(ID, X)` → `item(fD).repo
  === "x"` (control: the row changed), no `cag(X)`, `rD` still `ready` without `movedTo`, notes contain
  `move to x skipped: topic ci is not defined`; the record was accepted (no `isError`).
- Mutation: create the goal regardless → red; fail the record → red.

## AC-06 Held, and moving back

`describe("RL-10 AC-06 held and moving back")`; route parts in `test/retarget-hub.test.ts`, the
`mesh items retarget` commands in `test/retarget-cli.test.ts` (same describe name in both files, as RL-9
did for CLI siblings).

Scenario (one test, `test_AC06_held_then_back`, in `retarget-cli.test.ts`; a route twin
`test_AC06_held_then_back_route` in `retarget-hub.test.ts` with `retargetOk` in place of the CLI):
1. `G1` files D (no repo) → `rD` ready. bob holds `rD` (`hold`) → `claimed`.
2. `G2` audit raises `IR(ID, X)` → `rD` still `claimed` by bob, in Gr, no `movedTo`; notes contain
   `retarget to x: release the step, then run the retarget again`; `item(fD).repo === "x"` (control);
   no `cag(X)` or no step for D in it.
3. `G2` file accepts D (refile) → still no D step in any `x` goal (`allFor(fD)` is `[rD]`); notes of `rD`
   contain `filed for repo x; move it with: mesh items retarget ${LIN()} ${fD} --repo x` exactly once
   (count the note).
4. `release(bob, rD)` → `ready`. `mesh items retarget ${LIN()} ${fD} --repo x` (ann) → exit 0, first
   line `retargeted 0 items; moved 1 steps; held 0` (the target did not change), a line `${rD} → ${xD}`.
   `rD` `dropped`, `movedTo: xD`; `xD` `ready` with note `moved from ${rD}`.
5. `mesh items retarget ${LIN()} ${fD} --repo r` → exit 0; first line `retargeted 1 items; moved 1
   steps; held 0`. `rD` is **revived**: `ready`, no `movedTo`, no `summary`/`outcome`/holder, `repo:
   "r"`, its notes still contain the notes of steps 2–3 and now `moved back from ${xD}`; `fixCycles`
   unchanged; one `step.reopened` for `rD` with reason `moved`. `xD` `dropped`, `movedTo: rD`. Gr has
   exactly one finding step for D (`fsteps(Gr)` filter `fp === fD` length 1). `item(fD).repo === "r"`.
6. `G3 = run({steps: [AUDIT, DEBRIEF_DISMISS]})`; `raise(G3, [ID, IE])`; `debriefDismiss(G3, fD)` → `rD`
   `dropped` (summary `dismissed by ann: …`); `xD` still `dropped` with `movedTo` (no new
   `step.dropped` for `xD`).
7. `revertD(G3.s("debrief"), fD)` → 200; item D `accepted` (control); `rD` reopened (`ready`), one
   `step.reopened` for `rD` with reason `reverted`; `xD` still `dropped` with `movedTo`; no
   `step.reopened` for `xD` at any point.
- Throughout: `liveOpen(fD).length <= 1` after each step (asserted after 2, 3, 4, 5, 7).
- FAIL: a held step moved (step 2/3), a step created in x while D is held, a duplicate, a second step id
  in Gr, the moved-away step reopened (step 7), `movedTo` left on a revived step.
- Mutations: (1) move held steps → red at 2; (2) sink creates the home step without the foreign check →
  red at 3; (3) revive by creating a fresh step (new id or cleared notes) → red at 5; (4) the revert
  matches moved-away steps → `xD` reopened → red at 7; (5) step 3 skipped when the target is unchanged →
  no move at 4 → red.

## AC-06b Revive by sink, closed home reopened by a move

`describe("RL-10 AC-06b revive by sink")`, scenario in `test/retarget-cli.test.ts`; `revived()` is a
kit-level setup function shared with AC-06c.

`revived()`: `G1` files D → `rD`. `mesh items retarget ${LIN()} ${fD} --repo x` → `xD` ready, `rD`
moved-away. `finish(bob, xD)` → `done`. `k.tick()`. `G2` audit raises `IR(ID, "r")` (fold: target x → r,
`item.retargeted` from x to r; `xD` closed so nothing moves: control that `rD` is still moved-away
right after the audit). `G2` file accepts D.

### test_AC06b_revive_by_sink
- Expected after `revived()`: `rD` `ready`, no `movedTo`, no `summary`/`outcome`/holder, `repo: "r"`,
  its notes from before the move still there (compare with the notes read before the first retarget);
  Gr's finding steps for D: exactly `[rD]` (no other
  id); `xD` still `done` (no `step.reopened` for `xD`); one `step.reopened` for `rD` with `from:
  G2.file`; `goal.sunk` on Gr from `G2.file` lists `rD` under `reopened` (or `added`: the AC does not say
  which; assert it is in one of them).
- FAIL: a new id in Gr, `rD` overwritten (notes lost), `xD` reopened.
- Mutations: (1) on a moved-away home, create a step under a new id → red; (2) revive without clearing
  `movedTo` → red.

### test_AC06b_sink_revive_reason
- Same world; the `step.reopened` of `rD` has `reason === "moved"` (the AC's value; see "Spec points").

### test_AC06b_move_reopens_closed_home
- Continue: `mesh items retarget ${LIN()} ${fD} --repo x` → exit 0, `moved 1`. `rD` `dropped`,
  `movedTo: xD`; `xD` `ready`, `fixCycles === before + 1`, notes contain `moved from ${rD}`, one new
  `step.reopened` for `xD` with reason `moved`.
- FAIL: `xD` stays done, a new id in Gx. Mutation: a move into a closed home skips the reopen → red.

### test_AC06b_not_filed_again_no_revive (contract: "filed after close of every finding step")
- As `revived()` but the `G2` file stage files nothing for D (D raised with `repo: r` only) → `rD` stays
  moved-away, `xD` stays `done`, no `step.reopened`. Then a backfill `mesh items sink ${LIN()} --topic ci`
  → still nothing for D (D's latest `accepted` is older than `xD`'s close). Control: the
  `test_AC06b_revive_by_sink` world.
- Mutation: compare only with the home step's close → backfill revives → red.

## AC-06c One open step

`describe("RL-10 AC-06c one open step")`, `test/retarget-hub.test.ts` (setup through
`retargetOk` in place of the CLI).

### test_AC06c_held_foreign_closed_home
- Setup: `revived()` (route version) → `rD` ready, `xD` done. bob holds `rD`. `k.tick()`.
- Stimulus: `G3` audit raises `IR(ID, X)`; `G3` file accepts D.
- Expected: `xD` still `done` (no new `step.reopened` for it); `rD` `claimed` by bob, notes contain
  `retarget to x: release the step, then run the retarget again` (fold) and `filed for repo x; move it
  with: mesh items retarget ${LIN()} ${fD} --repo x` (sink); `liveOpen(fD)` is `[rD]`.
- FAIL: `xD` reopened (two open steps for D).
- Mutation: run the home-step rules before the foreign check → `xD` reopened → red.

## AC-06d Sink move

`describe("RL-10 AC-06d sink move")`, `test/retarget-cli.test.ts`.

### test_AC06d_retarget_held_then_sink_moves
- Setup: `G1` files D → `rD`; bob holds `rD`.
- `mesh items retarget ${LIN()} ${fD} --repo x` (ann) → exit 0, first line `retargeted 1 items; moved 0
  steps; held 1`, a line `held: ${rD}`; `item(fD).repo === "x"`; `rD` `claimed`, note `retarget to x:
  release …`.
- `release(bob, rD)`. `k.tick()`. `G2` audit raises `ID` (no repo) → no `item.retargeted` from the fold
  (count unchanged: the target stays x), `rD` still in Gr `ready` (control: no fold move). `G2` file
  accepts D.
- Expected: `xD` exists in Gx, `ready`, note `moved from ${rD}`; `rD` `dropped`, `movedTo: xD`;
  `moveOf(rD)` exists; `goal.sunk` on Gx from `G2.file` with `xD` in `added`; `liveOpen(fD)` is `[xD]`.
- FAIL: no move (rD still ready and an `xD` created → two open), or no step in x.
- Mutation: sink rule 2 creates the home step without moving the open foreign step → red.

## AC-06e Revert reopens only home; backfill does not re-create

`describe("RL-10 AC-06e revert only home")`, `test/retarget-cli.test.ts`.

### test_AC06e_revert_and_backfill
- Setup: `G1` files D → `rD`. `G2 = run({steps: [AUDIT, TRIAGE()]})` raises D; triage dismisses D →
  `rD` `dropped` (live). `mesh items retarget ${LIN()} ${fD} --repo x` → first line `retargeted 1 items;
  moved 0 steps; held 0`; `rD` unchanged (snapshot).
- `k.tick()`; `G3` raises D, file accepts D → `xD` created in Gx (`ready`, `repo: "x"`); `rD` still
  `dropped`, no `movedTo`.
- `G4 = run({steps: [AUDIT, DEBRIEF_DISMISS]})`; raise D; `debriefDismiss(G4, fD)` → `xD` `dropped`; no
  new `step.dropped` for `rD`. `revertD(G4.s("debrief"), fD)` → `xD` `ready`, `step.reopened` reason
  `reverted`; `rD` still `dropped` (no `step.reopened` for `rD` ever).
- `k.tick()`; `finish(bob, xD)` → `done`. `k.tick()`. `mesh items sink ${LIN()} --topic ci` → exit 0,
  stdout `${Gx}: added 0, reopened 0` (one entry: RL-9's line, no suffix); Gx and Gr finding steps
  unchanged (`snapshot`), no `step.reopened`, no new step id anywhere (`allFor(fD)` is `[rD, xD]`).
- FAIL: `rD` reopened, a step re-created, the backfill reopening `xD`.
- Mutations: (1) the revert reopens the step in the goal of the lineage repo → `rD` reopened → red;
  (2) the backfill reopens a closed home step without the "filed after close" test → `xD` reopened →
  red. (The "every finding step" half of that test is driven by `test_AC06b_not_filed_again_no_revive`.)

## AC-07 Retarget by repo

`describe("RL-10 AC-07 retarget by repo")`; route in `test/retarget-hub.test.ts`, CLI in
`test/retarget-cli.test.ts`.

Setup `fg()`: `G1 = run()`; `raise(G1, [IR(IA, X), IF, IG])`; `file(G1, [acc(fA), acc(fF), acc(fG)])` →
Gx exists (A's step), `rF`, `rG` in Gr. bob holds `rG`.

### test_AC07_route
- `before = world()`; `dry = retargetOk(ann, {lineage: LIN(), fps: [fF, fG], repo: "x", dry_run: true})`;
  `world()` equals `before` (nothing written).
- `real = retargetOk(ann, {lineage: LIN(), fps: [fF, fG], repo: "x"})`.
- Expected: `real` `toStrictEqual(dry)` (Gx exists, so no `new:` names); `real.items` sorted by fp equals
  `[{fp: fF, from: "r", to: "x"}, {fp: fG, from: "r", to: "x"}]` sorted; `real.moved` is `[{from: rF,
  to: xF}]`; `real.held` is `[rG]`. `xF` `ready` in Gx; `rF` `dropped`, `movedTo: xF`, `moveOf(rF)` with
  event `user` ann (the caller). `rG` `claimed` by bob, note `retarget to x: release the step, then run
  the retarget again`. `item(fF).repo` and `item(fG).repo` `"x"`; two `item.retargeted` events (one per
  fp) with `user` ann and payload `by: "ann"`; items' `history.length` unchanged from `before`.
  `goal.sunk` on Gx with `from: "mesh items retarget"`, `added: [xF]`.
- `release(bob, rG)`; again `retargetOk(...)` (same body) → `items: []`, `moved: [{from: rG, to: xG}]`,
  `held: []`; `xG` `ready`; no new `item.retargeted`.
- FAIL: a held step moved, a dry run that writes, a dry result that differs, an item history entry, no
  move on the second call.
- Mutations: (1) step 3 only for items whose target changed → second call moves nothing → red; (2) add a
  history entry → red; (3) dry run writes the row → red.

### test_AC07_dry_run_new_goal (contract)
- `fg()`; `retargetOk(ann, {lineage: LIN(), fps: [fF], repo: "y", dry_run: true})` (no Gy) → `moved` is
  `[{from: rF, to: \`new:y/${fid(LIN(), fF)}\`}]`; no `cag(Y)` afterwards.

### test_AC07_cli
- `fg()`; `mesh items retarget ${LIN()} ${fF} ${fG} --repo x --dry-run` → exit 0, first line `would
  retarget 2 items; moved 1 steps; held 1`, lines `${rF} → ${xF}` and `held: ${rG}`; nothing written.
  Without `--dry-run` → first line `retargeted 2 items; moved 1 steps; held 1`, same other lines.
- Mutation: print `retargeted` on a dry run → red.

### test_AC07_moved_into_goal_owned_by_other (contract)
- Gx created by bob's own run (bob's `run({preset: "bobs", owner: bob})` files `IR(IC, X)`), then ann
  retargets F to x → `xF` in bob's Gx (only one `cag(X)`), 200.

## AC-08 Retarget from key path

`describe("RL-10 AC-08 retarget from key path")`; CLI in `test/retarget-cli.test.ts`, route twin in
`test/retarget-hub.test.ts`.

### test_AC08_from_key_path
- Setup: `G1` raises `H = item("rh", {path: "x"})`, `I = item("ri", {path: "y"})`, `J = noPath("rj")`,
  `K = item("rk", {path: "src/a.rs"})`, `L = item("rl", {path: "a.ts"})`, all accepted → five steps in
  Gr. fps: `fpR("rh", "x")`, …, `fJ = fpByRule("rj")`.
- Stimulus: `mesh items retarget ${LIN()} --all --from-key-path` (ann).
- Expected: exit 0; first line exactly `retargeted 2 items; moved 2 steps; held 0`; lines `${rH} → ${xH}`,
  `${rI} → ${yI}`, `note: ${fJ}: no key path`, `note: ${fK}: key path src/a.rs is not a repo name`, `note:
  ${fL}: key path a.ts is not a repo name`. `cag(X)` has only H's step, `cag(Y)` only I's; no clean-audit
  goal with `sink.repo` `src/a.rs`, `a.ts` or `src` (no junk goal: the set of clean-audit goals is
  exactly `{r, x, y}`); J, K, L rows have no `repo`, their steps `ready` in Gr.
- Route twin: `RetargetResult.notes` contains those three texts; `items` `[{fH, r, x}, {fI, r, y}]`.
- FAIL: another target, a junk goal, a missing note, other output.
- Mutations: (1) no path check → goals for `src/a.rs` / `a.ts` → red; (2) treat a missing path as `""`
  and set it → red; (3) a note text change → red.

### test_AC08_key_path_edges (contract)
- `path: "infra.config"` (ends in `.` + 6 letters) → target `infra.config`; `path: "v.yaml"` → note; `path:
  "a.b2"` → note. Mutation: `\.\w+$` without the 1–5 bound → red on `infra.config`.

## AC-09 Retarget checks

`describe("RL-10 AC-09 retarget checks")`; route in `test/retarget-hub.test.ts`, CLI in
`test/retarget-cli.test.ts`.

### test_AC09_route_refusals
- Setup: `fg()` (no bob hold needed). `before = world()`. `TXT = "retarget needs fps or all, and repo or
  from_key_path"`.
- Each → status and `json.error`, and `world()` equals `before` after each:
  - `{lineage, repo: "x"}` (neither fps nor all) → 400 `TXT`; `{lineage, fps: [fF], all: true, repo: "x"}`
    → 400 `TXT`; `{lineage, fps: [fF]}` (no target) → 400 `TXT`; `{lineage, fps: [fF], repo: "x",
    from_key_path: true}` → 400 `TXT`.
  - `{lineage, fps: [], repo: "x"}` → 400 (schema; the text is not asserted); `fps: ["NOT-AN-FP"]` → 400;
    501 fps → 400; `repo: "x".repeat(301)` → 400.
  - `{lineage: "nope|r|audit", all: true, repo: "x"}` → 404 `no items in nope|r|audit`.
  - `{lineage, fps: [fF, fpR("zz")], repo: "x"}` → 404 `unknown item ${fpR("zz")} in ${LIN()}`, and F
    unchanged (nothing written even for the known fp).
  - carol → 403; bob (member, owns no goal of the lineage nor a clean-audit goal holding its steps) → 403.
- Positive controls: root (admin) `{lineage, fps: [fF], repo: "x", dry_run: true}` → 200; ann (owner of
  the lineage's newest goal) → 200; bob after he owns Gx holding a live finding step of the lineage
  (`test_AC07_moved_into_goal_owned_by_other` world) → 200.
- FAIL: another status or text, a write on a refused call.
- Mutations: (1) validate fps per item and write before the unknown-fp check → F moved → red; (2)
  owner-of-newest-goal only → bob's allowed case 403 → red.

### test_AC09_cli_usage
- `mesh items retarget ${LIN()} --all` (no target) → exit 2, stderr matches `/mesh items retarget/`, no
  request to `/v1/items/retarget` (`requests` filter). Same for: no lineage (`mesh items retarget`);
  `${fF} --all --repo x`; neither fps nor `--all` (`--repo x`); `--repo x --from-key-path`.
- Positive control: `mesh items retarget ${LIN()} ${fF} --repo x --dry-run` → exit 0, one request.
- A refused call (carol's CLI) → exit non-zero (not 2), stderr contains the hub text.
- FAIL: another exit code, a request sent. Mutation: let the hub validate → a request → red.

## AC-10 Backfill grouped

`describe("RL-10 AC-10 backfill grouped")`; CLI in `test/retarget-cli.test.ts`, route in
`test/retarget-hub.test.ts`.

Setup `plainX()`: `R = run({preset: "plain", steps: [AUDIT, FILE({sink: undefined})]})`; `raise(R,
[IR(P1, X), IR(P2, X), P3])`; `file(R, [acc(f1), acc(f2), acc(f3)])`; `L = LIN("plain")`; no clean-audit
goal (control: `cag("r")`, `cag(X)` undefined).

### test_AC10_cli
- `mesh items sink ${L} --topic ci --dry-run` → exit 0, `out.trim().split("\n")` equals `["would add 1
  to a new goal (r)", "would add 2 to a new goal (x)"]`; `world()` unchanged.
- Without `--dry-run` → two goals: Gr (P3's step, `repo: "r"`), Gx (P1, P2, `repo: "x"`), no deps; output
  `[\`${Gr}: added 1, reopened 0 (r)\`, \`${Gx}: added 2, reopened 0 (x)\`]`.
- Again → `[\`${Gr}: added 0, reopened 0 (r)\`, \`${Gx}: added 0, reopened 0 (x)\`]`; no new steps.
- Control (RL-9 output unchanged): a lineage whose items all target its own repo → `mesh items sink` prints
  RL-9's single line without suffix (and the RL-9 test `test_AC15_cli` passes unedited).
- FAIL: wrong grouping, a write on dry run, duplicates, a suffix on the single-entry output.
- Mutations: (1) group by lineage repo → `added 3` in Gr → red; (2) always suffix → RL-9 line changed →
  red.

### test_AC10_route
- `POST /v1/items/sink {lineage: L, topic: "ci", dry_run: true}` → 200, `goal: null`, `goals` length 2
  ordered `r`, `x`, each `goal: null`, `added` the local or `new:`-named ids (match by suffix
  `fid(L, f)` as the RL-9 test does), `reopened: []`; top-level `added` is their union. Real call →
  `goals[i].goal` = Gr / Gx, top-level `goal: null` (two entries). A one-entry call (only P3 selected via
  `min_severity` so only `r` remains, or a lineage of own-repo items) → `goal` = that entry's goal.
- With no filed item selected (`min_severity: "S1"` when none is S1) → `goals: []`, `goal` RL-9's (null).
- Permission (contract): bob after owning a clean-audit goal `(x, ci)` (his own run filed `IR(IC, X)`) →
  200 on L's backfill; carol → 403.
- Mutation: omit empty-group filtering → an entry with no items → red.

## AC-11 Deps stay within a goal

`describe("RL-10 AC-11 deps within a goal")`, `test/retarget-hub.test.ts`.

### test_AC11_requires_across_goals
- `G1` raises `IR(M, X)`, `IR(N, Y)`; file `[acc(fM, {requires: [fN]}), acc(fN)]` → `xM` `ready`, `deps`
  `[]`, notes contain `requires ${fN}: not in this goal`; `yN` `ready`.
### test_AC11_requires_same_target
- Fresh world: `IR(M, X)`, `IR(N, X)` → `xM` deps `[xN]` (as listed), `blocked`; no `not in this goal`
  note.
- FAIL: a dep across goals, no note. Mutation: resolve requires across all clean-audit goals → red.

### test_AC11_moved_away_not_matched (contract: lookups see live steps only)
- AC-05 world after the move (D live in Gx, `rD` moved-away); a later run files E2 (no repo) with
  `requires: [fD]` → its step in Gr has no dep and the note `requires ${fD}: not in this goal` (not a dep on
  the moved-away `rD`). Mutation: match moved-away steps → dep on `rD` → red.

## AC-12 Docs, events, skill, schemas

`test/docs-rl10.test.ts`, `describe("RL-10 AC-12 docs")` (section-scoped as `docs-rl9.test.ts`):
- `test_AC12_concepts`: the `## Clean-audit goals` section of `docs/guide/concepts.md` has a paragraph with
  `target repo` and one with `move` (or `moved`) and `mesh items retarget`.
- `test_AC12_guide`: the `## Clean-audit goals` section of `docs/guide/scheduled-reviews.md` contains
  `repo` in a paragraph that also contains `key` (auditors that check other repos keep the repo in the key),
  a paragraph with `fold` or `moves` and `open`, `mesh items retarget` and `--dry-run`.
- `test_AC12_skill`: `MESH_SKILL` has a paragraph with `mesh_review` and `repo`; `skills/mesh/SKILL.md`
  equals `MESH_SKILL`.
- `test_AC12_events`: `docs/events.md` contains `item.retargeted`; a paragraph with `step.dropped`,
  `moved` and `to`; a paragraph with `step.reopened` and `moved`.
- `test_AC12_api_table`: `docs/plan/implementation-plan.md` has a line with `/v1/items/retarget`.
- `test/schemas.test.ts`, `describe("RL-10 AC-12/AC-13 routes and schema")`: `test_AC12_route_table`:
  `HUB_API` row `POST /v1/items/retarget` `{rule: "member", scope: "goals:write", tag: "goals"}` and served
  by `createApp` (control: `POST /v1/items/sink` still there); `test_AC12_openapi`: the generated document
  equals `schemas/hub-api.openapi.json` and has `paths["/v1/items/retarget"].post`; the review route's
  item schema has a `repo` property with `maxLength: 300` (located by walking the request body of
  `/v1/steps/{id}/review` to `items.items.properties.repo`; if the generator names it differently, the
  test-writer finds the `ReviewItem` schema by its `key` property). `pnpm schemas` leaves no diff
  (`git diff --exit-code schemas/` in CI).
- Specific names: review step (not automated), as RL-7 … RL-9.
- FAIL: a missing entry or mismatch. Mutation: remove the events line → red.

## AC-13 CI

- `test/schemas.test.ts`: `test_AC13_version` (new, `0.1.28`) and the two existing release-line
  literals bumped (see "Spec points"); `test_AC13_schema_version`: `HubStore.SCHEMA_VERSION === 11`.
- RL-9 tests unchanged: reviewer check `git diff --stat <base>..HEAD -- test/sink-hub.test.ts
  test/sink-goals.test.ts test/sink-cli.test.ts test/docs-rl9.test.ts` is empty, and the diff of
  `test/helpers/sink-kit.ts` only adds lines (no removed or changed line).
- `pnpm check` (lint, typecheck, boundaries, test, build) passes; Postgres legs not run locally.
- FAIL: any check red, a schema version change, an RL-9 test edited. Mutation: bump `SCHEMA_VERSION` → red.

## Coverage

| Criterion | Tests |
|---|---|
| AC-01 | `test_AC01_three_goals`, `test_AC01_repo_equal_lineage_repo` |
| AC-02 | `test_AC02_row_and_kept`, `test_AC02_repo_length`, `test_AC02_items_cli` |
| AC-03 | `test_AC03_refused`, `test_AC03_repeat_same_fp` |
| AC-04 | `test_AC04_resolved_in_target_goal`, `test_AC04_dismissed_in_target_goal` |
| AC-05 | `test_AC05_open_step_moved_by_fold`, `test_AC05_fixcycles_carried`, `test_AC05_move_deps_in_new_goal`, `test_AC05_topic_gone` |
| AC-06 | `test_AC06_held_then_back`, `test_AC06_held_then_back_route` |
| AC-06b | `test_AC06b_revive_by_sink`, `test_AC06b_sink_revive_reason`, `test_AC06b_move_reopens_closed_home`, `test_AC06b_not_filed_again_no_revive` |
| AC-06c | `test_AC06c_held_foreign_closed_home` |
| AC-06d | `test_AC06d_retarget_held_then_sink_moves` |
| AC-06e | `test_AC06e_revert_and_backfill` |
| AC-07 | `test_AC07_route`, `test_AC07_dry_run_new_goal`, `test_AC07_cli`, `test_AC07_moved_into_goal_owned_by_other` |
| AC-08 | `test_AC08_from_key_path` (CLI + route twin), `test_AC08_key_path_edges` |
| AC-09 | `test_AC09_route_refusals`, `test_AC09_cli_usage` |
| AC-10 | `test_AC10_cli`, `test_AC10_route` |
| AC-11 | `test_AC11_requires_across_goals`, `test_AC11_requires_same_target`, `test_AC11_moved_away_not_matched` |
| AC-12 | `test_AC12_concepts`, `test_AC12_guide`, `test_AC12_skill`, `test_AC12_events`, `test_AC12_api_table`, `test_AC12_route_table`, `test_AC12_openapi` (+ review for names) |
| AC-13 | `test_AC13_version`, `test_AC13_schema_version`, RL-9 diff check, `pnpm check` |

## Contract parts covered beyond the ACs (in the files above)

- `mesh show` counts see live steps only: `test_AC05_show_counts_live` in `test/retarget-cli.test.ts`
  (`describe("RL-10 AC-05 mesh show")`): after the fold move, `mesh show ${Gr}` header line is `clean
  audits: ci on r · open S1 0 · S2 0 · S3 1 · S4 0 · done 0 · dropped 0` (E open; the moved-away `rD` not
  counted as dropped) and `mesh show ${Gx}` counts D as open. Mutation: count moved-away as dropped →
  red.
- The fold's held note "once per call" and the sink's `filed for repo …` note once per call (counted in
  AC-06 step 3).

## Not planned

- The order "fold move before the RL-9 resolved sync in the same transaction": not observable beyond
  AC-05's end state; review only.
- A store fault mid-move (all-or-nothing writes): no World hook for a store fault in this path; review
  only (the dry-run "nothing written" checks cover the decide-then-write split from the other side).
- Older hubs and daemons refusing `repo` (Compatibility): no World hook for an older hub or daemon;
  review only.
- Postgres legs of the store: skipped locally (`MESH_TEST_PG_URL` unset), named "not run".
- Web views: out of scope.
