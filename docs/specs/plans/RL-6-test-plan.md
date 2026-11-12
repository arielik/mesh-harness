# Test plan RL-6: Calibration, stats and end-to-end acceptance

Spec: `docs/specs/RL-6.md` (Draft after review round 3: B1 replan path, B2 `item.reverted` kept, S1–S3
decided).

Inputs read: `docs/specs/RL-6.md` (problem, scope, interface contracts, acceptance criteria, open
questions); the role file `assets/sdd/.claude/agents/test-planner.md`; the format of
`docs/specs/plans/RL-5-test-plan.md`; the file names under `test/`, `test/helpers/`, `test/e2e-web/`,
`test/fixtures/` and `src/*/*.test.ts`; the exported names and method signatures of the test kits
`test/helpers/world.ts` (`World`, `Person`, `FAKE_CLAUDE`), `test/helpers/relay-kit.ts` (`Relay`:
`start`, `headlessPerson`, `otherLogin`, `call`, `goal`, `plan`, `stepOf`, `act`, `events`, `allEvents`,
`upload`, `autoOffer`, `pull`, `started`, `runSession`, `script`, `go`, `endRun`, `calls`, `runs`,
`runOf`, `cli`; `git`, `until`, `AUDITOR`), `test/helpers/review-kit.ts` (`Rk`: `start`, `goal`,
`claim`, `review`, `reviewOk`, `close`, `submit`, `reviews`, `itemsOf`, `itemOf`, `ctx`, `replan`;
`item`, `disp`, `rec` with `agent`/`undeclaredRules`, `fp`, `S`, `L`, `ALPHA`, `NOV19`, `DAY_MS`),
`test/helpers/debrief-kit.ts` (`Dk`: `hold`, `dispose`/`disposeOk` = `mesh_dispose`, `revert` =
`POST /v1/steps/:id/dispositions/revert`, `history`, `ev`), `test/helpers/pulse-kit.ts` (`Pk`: `pulseOk`,
`fireOk`, `goal`, `goalsOfPulse`, `eventsOfGoal`, `at`, `tickAt`, `bare`, `sync`, `storeWrap`; `snap`,
`sha`, `sha12`, `T0`, `DAY`), `test/helpers/roster-kit.ts` (`Rk` (roster): `sourceOk` with `extra`,
`pusher`, `pushOk`, `report`, `view`; `SRC`, `REV1`, `H`, `H1`), `test/helpers/pg.ts` (`PG_URL`);
the header comment of the fake `claude` fixture (`test/fixtures/claude/fake-claude/claude`); the user
list of `test/e2e-web/hub.yaml`; the existing pattern of `test/review-daemon.test.ts` AC-21 (a headless
run scripted with `waitFor`, its session calling `mesh_review`/`mesh_done` through `r.w.tool`), of
`test/relay-hub.test.ts` AC-31 (`POST /v1/steps/:id/run` with `telemetry`) and the `hubYaml` token
max-age setting of `test/pulse-daemon.test.ts`; the `TABLES` list of `test/m46-ops.test.ts`.

Not read: `docs/specs/plans/RL-6-impl-plan.md` (the implementation plan); any implementation source of
this row or of the code it changes (`src/protocol`, `src/core`, `src/store`, `src/hub`, `src/daemon`,
`src/claude`, `src/cli`, `web/`), not even to check a name.

Planned black-box from the contracts. Every negative assertion has a positive control in the same test
or a named sibling, so a test cannot pass because nothing happened. Each criterion names at least one
mutation of the implementation that must turn one of its tests red; the implementer or reviewer applies
it once by hand, confirms red, and reverts.

Rules every test follows: goals are found by id or by `calibration.key`/`calibration.hash`, items by
fingerprint, events by `type` (+ goal / payload field), stats entries by `hash`, never by position in a
whole list, except where the criterion asserts an order (stats `hashes`, `calibration.dismissals`, the
context `dismissals`, the web rows, the order of `calibration.done` before the next
`calibration.opened`). No test runs the real `claude` binary (World tests with headless runs use
`FAKE_CLAUDE`). Time comes from `w.clock`, set before every action whose time is asserted, so every
`at`/`finishedAt` is known to the test exactly. World tests that move the clock past 14 days set
`auth.session.device_max_age: "60d"` (as `test/pulse-daemon.test.ts`). **Counts are computed by the
test from its own fixture** (the table under each criterion), and fold values (`new`, `regressions`,
`carried`) are summed by the test from the records it reads back through
`GET /v1/steps/:id/reviews`, so the oracle does not come from the stats code.

The Postgres legs of the store contract (AC-04 second half) are skipped locally (`MESH_TEST_PG_URL`
unset); they are named "not run", never a failure. Every other criterion is judged on SQLite.

## Surfaces and files

| Surface | File | New or extended |
|---|---|---|
| unit, protocol (`DismissalRef`, `GoalCalibration`, `Goal.calibration`, `StepPolicy.inputs`) | `src/protocol/calibration.test.ts` | new |
| unit, policy (`INPUT_KEYWORDS`, `validatePolicies`) | `src/core/policy.test.ts` | extended (`describe("RL-6 calibration input")`) |
| unit, hub config | `src/hub/config.test.ts` | extended (`describe("RL-6 calibration threshold")`) |
| unit, `whenHolds` | `src/core/review.test.ts` | extended (`describe("RL-6 filed items")`) |
| unit + CLI, presets | `src/core/presets.test.ts` (extended), `test/relay-cli.test.ts` or `test/calibration-cli.test.ts` (`mesh preset ls`) | extended / new |
| hub copy (SQLite file) + store contract Postgres leg | `src/store/hub-store.contract.test.ts` (`describe("RL-6 hub copy tables")`) | extended |
| World / hub API: fixes 1 and 2, stats route, counting, trigger, calibrator, input, done | `test/calibration-hub.test.ts` | new |
| World / daemon + fake `claude`: whole programme | `test/programme.test.ts` | new |
| Playwright | `test/e2e-web/calibration.spec.ts` (new), `test/e2e-web/hub.yaml` (user `frank`) | new / extended |
| docs, skill, version, OpenAPI, route table | `test/schemas.test.ts` (`describe("RL-6 AC-15 docs and skill")`, `describe("RL-6 AC-16 checks, schema, routes")`), `src/claude/skill.test.ts` (existing skill equality) | extended |
| existing tests the spec says change | tests listing `BUILTIN_PRESETS`, `mesh preset ls`, the route list, `INPUT_KEYWORDS`, `TABLES` (`test/m46-ops.test.ts` keeps its own list; only the `COPY_TABLES` comparisons change), `package.json` version | updated by the test-writer (spec, Compatibility); nothing else in them changes |

### Test-side helper (new, `test/helpers/calib-kit.ts`, built on `Relay` and review-kit `Rk`)

- Constants: `KEY = "alpha/auditor"`, `CHECK = "alpha/checker"`, `HA = sha("auditor-a")`,
  `HB = sha("auditor-b")`, `HZ = sha("auditor-z")`, `V = sha("checker-v")` (64 hex each),
  `h12 = (h) => h.slice(0, 12)`; `enc = encodeURIComponent`.
- `Ck.start({threshold?, clock?, users?})` → `Rk.start({hubYaml: {calibration: {threshold}, auth:
  {session: {device_max_age: "60d", device_idle: "30d"}}}, clock})` (threshold omitted → no
  `calibration` key in the YAML, so the hub default applies). Cast: `ann`, `bob` (persons with daemons,
  `shareSessions: "me"`), `carol`, `root` (admin).
- `agentGoal(owner, o)` → a goal (plan approved) with `audit` = `S.audit()` (headless, `agent:
  "auditor"`, `output: review-record`) and, as asked, `validate` = `S.validate({when: {open: true}})`,
  a person's `debrief` (`deps: [validate|audit]`, `output: review-record`, `consumes` / `may_set` as
  given, interactive) and further steps.
- `raise(id, items, agent = {key: KEY, hash: HA}, extra = {})` = claim + `reviewOk` of
  `rec({items, agent, ...extra})` + done (the record's decider is the agent, as RL-2's
  `test_AC13_apply`). `raiseAsPerson(id, items)` = the same without `agent` on an interactive step.
- `agentDispose(id, dispositions, agent = {key: CHECK, hash: V})` = claim + `reviewOk(rec({dispositions,
  agent}))` + done.
- `personDispose(id, fp, disposition, extra)` = `Dk.hold` + `Dk.disposeOk` (`mesh_dispose` through the
  person's daemon); `revert(id, fp)` = `Dk.revert` (RL-4 revert route), expecting 200.
- `run(id, telemetry, outcome = "done")` = claim + `POST /v1/steps/<id>/run` `started` then `finished`
  with `telemetry` (`agentKey`, `agentHash`, `durationMs`, optional `costUsdEstimate`, the RL-1 fields
  the existing `T` literal of `test/relay-hub.test.ts` carries) + done with `outcome`; asserts the
  round's `outcome`, `finishedAt` and `telemetry` from `GET /v1/steps/<id>` (precondition, so a stats
  failure is not a fixture failure).
- `stats(key, query = "")` = `GET /v1/agents/${enc(key)}/stats${query}` as `ann`; `hashOf(s, h)`.
- `calibGoals(as = "ann")` = `GET /v1/goals` filtered to goals with `calibration`; `calibOf(key, hash)`.
- `cev(type)` = `allEvents()` of `calibration.opened|done`; `timeline(G)` = the goal's activity texts.

## Criteria

Notation per test: **Setup / Stimulus → Expect. FAILS when … . Control: … . Mutation: …**

### AC-01 Schemas and config (unit)

- `test_AC01_goal_calibration` (`src/protocol/calibration.test.ts`): a `Goal` literal (an existing valid
  goal fixture) plus `calibration: {key: KEY, hash: HA, threshold: 3, dismissals: [ref1, ref2]}` (refs
  `{lineage, fp, goal, step, round: 1, at}`) parses and keeps both refs in order; the same with
  `threshold: 0` fails; a ref with `round: 1.5` fails; a goal without `calibration` parses with no
  `calibration` key. FAILS when `threshold: 0` parses or the two-ref goal fails. Control: the two-ref
  goal parses. Mutation: `threshold: z.number().int().min(0)` → red; `DismissalRef` without `round`
  integer check → red.
- `test_AC01_step_policy_calibration_input`: `StepPolicy` with `inputs: ["calibration"]` parses;
  `inputs: ["calibrationx"]` keeps the existing behaviour for unknown keywords (asserted the same way
  the existing `dispositions` keyword test asserts it). Mutation: keyword set without `calibration` →
  red.
- `test_AC01_input_keywords` (`src/core/policy.test.ts`): `INPUT_KEYWORDS` contains `calibration`; a plan
  `[{id: "calibrate", kind: "review", inputs: ["calibration"], output: "review-record"}]` (no step with
  id `calibration`) → `validatePolicies` = `[]`. Control: a plan with `inputs: ["nosuch"]` (no such
  step) reports a problem (the existing unknown-input message). Mutation: drop `calibration` from
  `INPUT_KEYWORDS` → red (reported as unknown step).
- `test_AC01_config_threshold` (`src/hub/config.test.ts`): minimal hub YAML without `calibration` →
  `calibration.threshold === 5`; `calibration: {threshold: 2}` → 2; `{threshold: 1}` → 1 (boundary);
  `0`, `-1`, `1.5`, `"3"` → config parse throws. FAILS on another default or any accept/reject the
  other way. Control: 1 and 2 accepted. Mutation: default 3 → red; `min(0)` → red (`0` accepted);
  `z.coerce.number()` → red (`"3"` accepted; the spec says `<int ≥ 1>`; recorded as the conservative
  reading, see Open points).

### AC-02 `whenHolds` with filed items (unit, `src/core/review.test.ts`)

- `test_AC02_filed_not_consumed`: `whenHolds({open: true}, ["accepted"], [{state: "accepted",
  severity: "S2"}])` → `true`; with `link: "x"` → `false`. FAILS on another boolean. Control: the first
  call (`true`). Mutation: ignore `link` → red.
- `test_AC02_mixed`: `consumes ["accepted", "confirmed"]`, items `[{accepted, S2, link: "x"},
  {confirmed, S3}]` → `true`; items `[{accepted, S2, link: "x"}, {accepted, S3, link: "y"}]` → `false`.
  Mutation: "any item filed → false" → red (first case).
- `test_AC02_empty_when`: `whenHolds({}, ["accepted"], [{accepted, S2, link: "x"}])` → `true`;
  `whenHolds({}, ["accepted"], [])` → `true`. Mutation: apply the filed rule before the `{}` short
  circuit → red.

### AC-03 Built-in `calibrate` preset (unit + CLI)

- `test_AC03_builtin_order` (`src/core/presets.test.ts`): `BUILTIN_PRESETS.map(p => p.name)` has
  `calibrate` immediately after `audit-relay`, and is the previous list with that one name inserted
  (previous list written literally in the test). Description equals the spec text byte for byte.
  Mutation: append at the end of a longer list / before `audit-relay` → red.
- `test_AC03_instantiate`: `instantiate(calibrate, {repo: "alpha", agent: "alpha/auditor", hash:
  "0123456789ab"})` → exactly one step; `toStrictEqual` on the documented fields: `id: "calibrate"`,
  `kind: "review"`, `repo: "alpha"`, `output: "review-record"`, `inputs: ["calibration"]`, `title:
  "Calibrate alpha/auditor@0123456789ab"`, `brief` = the spec brief with `{agent}`/`{hash}` replaced
  (literal in the test); no `mode`, `agent`, `profile`, `consumes`, `may_set`, `when` keys. FAILS on any
  field, extra key or text difference. Mutation: `mode: "headless"` → red; brief with `{hash}` left
  unreplaced → red.
- `test_AC03_validate_and_relay_unchanged`: `validatePolicies` of the instantiated plan → `[]`;
  `audit-relay` deep-equals a literal snapshot taken from the RL-4 test (copied, not recomputed).
  Mutation: change `audit-relay` → red.
- `test_AC03_cli_preset_ls` (CLI via `Relay.cli`): `mesh preset ls` stdout has a `calibrate` line on
  the line after `audit-relay`'s, with the description. Control: `audit-relay` line present. Mutation:
  CLI sorts by name → red.

### AC-04 Hub copy tables (`src/store/hub-store.contract.test.ts`)

- `test_AC04_tables_equal_migrated` (SQLite, always): open a fresh SQLite file in a temp dir, apply
  `HUB_MIGRATIONS`, read `SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'
  AND name <> 'schema_version'` → set `M`; `TABLES.map(t => t.name)` → list `T`. Expect
  `new Set(T).size === T.length` (no duplicates) and set equality `M == T`; `T` contains `topic`, right
  after `idem`. FAILS when a migrated table is missing from `TABLES`, a name is not a table, or a
  duplicate exists. Control: `M` non-empty and contains `goal`, `topic`. Mutation: remove `topic` from
  `TABLES` → red; add `{name: "goal"}` twice → red; add a non-table `{name: "ghost"}` → red.
- `test_AC04_migrate_copies_topics` (Postgres leg, `describe.skipIf(!PG_URL)`): a SQLite hub with two
  topics (created through the store calls the topic feature uses) → `mesh hub migrate` into the
  Postgres fixture → the target lists both topics deep-equal. **Not run here** (`MESH_TEST_PG_URL`
  unset; CI runs it). SQLite stand-in that runs locally: the same migrate into a second fresh **SQLite**
  file, both topics present. Mutation: `TABLES` without `topic` → both red.

### AC-05 Filed items not consumed (World hub API, `test/calibration-hub.test.ts`)

Plan per goal (repo ALPHA, lineage `L`): `audit` (agent `KEY`@`HA`), `file` = `{deps: [audit], output:
review-record, consumes: [accepted], may_set: [accepted], inputs: [dispositions], when: {open: true}}`
(interactive, so the test drives it); a person `debrief` between them where the scenario needs an
`accepted` without link.

- `test_AC05_unfiled_runs`: G1 `audit` raises A (S2) and records A `accepted` (no link) via a person
  debrief (`consumes [open]`, `may_set [accepted]`) → `G1.file` becomes `ready`; `ctx(G1.file)` inputs
  contain the `dispositions` entry listing A. Control for the next test. Mutation: treat every accepted
  as filed → red.
- `test_AC05_filed_skipped`: continue: `G1.file` records A `accepted` with `link: "https://x/1"` (fix 2
  applies; asserted in AC-06) and is done. G2 of the lineage: `audit` raises A again (carried `accepted`
  with the link, asserted on the item row) and nothing else is accepted → `G2.file` state `skipped`,
  exactly one `step.skipped` event for `G2.file`, and its context (if fetched while skipped) has no
  `dispositions` entry for A. FAILS when the filer is `ready`/runs for the filed item. Control:
  `test_AC05_mixed_lists_only_unfiled`. Mutation: `when` ignores `link` → red.
- `test_AC05_mixed_lists_only_unfiled`: G3: A filed (carried) and new item B accepted without link by
  the debrief → `G3.file` `ready`; the `dispositions` input lists B and not A. FAILS when the filer is
  skipped while B exists or A is listed. Mutation: filter the input on the goal's state instead of the
  link → red; skip on "any filed" → red.

### AC-06 Agreeing agent dispositions (World hub API)

Plan: `audit` (agent), `debrief` (person ann, `consumes [open]`, `may_set [accepted, dismissed]`),
`file` (headless-style agent record: `rec({agent: {key: "alpha/filer", hash: F}})`, `consumes
[accepted]`, `may_set [accepted, dismissed]`), `file2` (same policy, `deps: [file]`).

- `test_AC06_agree_applied`: ann accepts A in the debrief; `G.file` record `[disp(A, "accepted", {link:
  "https://x/1"})]` → 201, `applied: 1`, `ignored: []`; item A `link` = the link, state `accepted`; last
  history entry `decider` = `{kind: "agent", key: "alpha/filer", hash: F}`; one new `item.disposed`
  event for A in G. FAILS when the agreeing disposition is ignored. Mutation: keep the RL-2 "any person
  disposition → ignored" rule → red.
- `test_AC06_disagree_ignored`: same setup, fresh goal; the filer's record `[disp(A, "dismissed")]` →
  201, `ignored` toStrictEqual `[{fingerprint: A, reason: "decided by ann in this goal"}]`, `applied:
  0`; A still `accepted`, history length unchanged, no new `item.disposed`. Control: the
  `test_AC06_agree_applied` apply. Mutation: apply whenever the state is consumed → red.
- `test_AC06_person_still_wins_after_agent_entry`: continue `test_AC06_agree_applied`: `G.file2`
  record `[disp(A, "dismissed")]` → ignored with reason `decided by ann in this goal`; A stays
  `accepted` with the link. FAILS when the latest entry (the agent's) rather than the latest person
  entry is compared. Mutation: compare with the latest entry of any decider → red.
- `test_AC06_restate_not_consumed_no_422`: another goal G' of the lineage: ann's debrief dismisses A;
  a later agent stage `{consumes: [open], may_set: [dismissed]}` records `[disp(A, "dismissed")]` →
  200/201 (not 422), `ignored` = `[{fingerprint: A, reason: "decided by ann in this goal"}]`; A still
  `dismissed`, history length unchanged, and `done` on that stage → 200. FAILS on a 422 or a new history
  entry. Control: the same stage with an fp B that is `open` and has no person disposition → applied
  (RL-2 behaviour kept). Mutation: run the consumes state check before precedence → 422 → red; apply
  equal values regardless of state → red (new history entry).

### AC-07 Stats route shape (World hub API)

- `test_AC07_days_400`: `days=0`, `days=366`, `days=x`, `days=1.5` each → 400 `{error: "days must be a
  whole number from 1 to 365"}`. Control: `days=1` and `days=365` → 200. Mutation: `max(366)` → red;
  `parseInt` (accepts `1.5`) → red.
- `test_AC07_key_400`: `/v1/agents/nokey/stats` → 400 `{error: "an agent key is <repo>/<name>"}`;
  a key of 331 chars with a `/` → 400 same; 330 chars → 200. Control: `alpha%2Fauditor` → 200.
  Mutation: limit 331 → red.
- `test_AC07_unknown_and_header`: with clock `T`, `GET /v1/agents/zz%2Fnone/stats` → 200
  toStrictEqual `{key: "zz/none", days: 30, since: T - 30 * DAY, threshold: 5, hashes: []}`; in a hub
  with `threshold: 2`, `threshold: 2`. `?days=7` → `days: 7`, `since: T - 7 * DAY`. Mutation: `since`
  from midnight → red; `threshold` hard-coded → red.
- `test_AC07_auth`: no token → 401; a service token with scope `goals:read` → 200; a service token
  without it → 403 (the existing scope rule; control for the positive). Mutation: rule `admin` → red.
- `test_AC07_route_table` (unit in `test/schemas.test.ts`): `HUB_API` has an entry for `GET
  /v1/agents/:key/stats` with rule `member`, scope `goals:read`, tag `goals`. Mutation: tag `agents` →
  red.

### AC-08 Stats values (World hub API)

Fixture (threshold 5 so no goal opens; `T = NOV19`; each step's time is set by `w.clock` first):

| When | Goal | Event |
|---|---|---|
| T−40d | G0 | `audit` record by `KEY`@`HB` raises Z; `validate` (`CHECK`@`V`) dismisses Z |
| T−10d | G1 | `audit` run: telemetry `{agentKey: KEY, agentHash: HA, costUsdEstimate: 0.30, durationMs: 60000}`, done; record by `KEY`@`HA` raises A (S2), B, C, `undeclaredRules: 1` |
| T−9d | G1 | `validate` (`CHECK`@`V`) dismisses B |
| T−8d | G1 | ann's debrief (`consumes [open, confirmed]`, `may_set [accepted, dismissed]`): accepts A, dismisses C |
| T−5d | G2 | `audit` run: `{HA, no costUsdEstimate, durationMs: 30002}`, done; record by `KEY`@`HA` raises A, D, E, `undeclaredRules: 2` |
| T−4d | G2 | ann's debrief: accepts D then **reverts** it (RL-4 revert); dismisses E then **reverts** it |
| T−3d | G3 | `audit` run: `{HA, costUsdEstimate: 0.10, durationMs: 90000}`, closed with `outcome: fail`, no record |
| T−2d | G4 | `audit` record by `KEY`@`HZ` raising no items (all counts 0) |

Query at `T`.

- `test_AC08_values_30d`: `stats(KEY)` → `hashes.map(h => h.hash)` = `[HA, HB]` (HZ absent). HA
  toStrictEqual `{hash: HA, runs: 3, failures: 1, meanCostUsd: ≈0.2 (toBeCloseTo, 10), meanDurationMs:
  60001 (Math.round(180002/3)), raised: 6, new/regressions/carried: the sums of `fold` of G1's and G2's
  audit records read back by the test (and G1's `fold.new` asserted = 3 as a sanity check),
  undeclaredRules: 3, accepted: 1, dismissedByAgents: 1, dismissedByPeople: 1, reinstated: 0,
  uncalibrated: 2, calibrating: 0, calibrated: 0, lastAt: <G3 finishedAt>}` with no `calibration` key.
  HB: `runs: 0, failures: 0, meanCostUsd: null, meanDurationMs: null, raised: 0, …, dismissedByAgents:
  0, uncalibrated: 1, lastAt: <Z dismissal at (T−40d)>`. FAILS on any count, mean, null, order or
  `lastAt`; the reverted `accepted` of D or dismissal of E counted; HZ listed. Control: HA present with
  non-zero counts. Mutations: count reverted entries → `accepted: 2` / `dismissedByPeople: 2` → red;
  `Math.floor` → 60000 → red; mean cost over all runs (0 for missing) → 0.1333 → red; drop the
  "non-zero" filter → HZ listed → red; `lastAt` fallback to `0` → HB order/value red.
- `test_AC08_window_1d`: `stats(KEY, "?days=1")` → HA: `runs 0, failures 0, meanCostUsd null,
  meanDurationMs null, raised 0, accepted 0, dismissedBy* 0, undeclaredRules 0, uncalibrated 2`,
  `lastAt` = the newest counted dismissal of HA (C at T−8d); HB `uncalibrated: 1`; order by `lastAt`
  desc = `[HA, HB]`. Mutation: window applied to `uncalibrated` → red.
- `test_AC08_window_edge`: a fresh hub; one run of HA finishing at exactly `T − 10d`; at clock `T`
  `?days=10` → `runs: 1`; clock `T + 1` → the hash disappears (no non-zero count). Mutation: `>` instead
  of `≥` → red.
- `test_AC08_tie_order`: two hashes with the same `lastAt` (two records at the same clock) → ordered by
  hash ascending (computed in the test). Mutation: order by hash descending on ties → red.
- `test_AC08_hashless_runs`: a run with telemetry without `agentHash` → counted under `hash: ""`.
  Mutation: skip runs without hash → red.

### AC-09 Reinstated and once per goal (World hub API)

Plan of G1/G2: `audit` (`KEY`@`HA`), `validate` (`CHECK`@`V`, `consumes [open]`, `may_set [confirmed,
dismissed]`), `debrief` (ann, `consumes [dismissed]`, `may_set [accepted, dismissed]`, `when: {}`).

- `test_AC09_once_per_goal`: G1: audit raises A, B; validate dismisses A and B; ann dismisses B again
  in the debrief → `stats(KEY)` HA: `dismissedByAgents: 2`, `dismissedByPeople: 0`, `uncalibrated: 2`;
  `stats(CHECK)` V: `reinstated: 0` (entry absent or 0 — V has no other counts, so the entry is absent;
  the test asserts absence and, as control, that `stats(CHECK)` lists V once it has a reinstatement
  below). FAILS when B counts twice or as a person dismissal. Mutation: latest entry per
  `(goal, lineage, fp)` instead of earliest → `dismissedByPeople: 1` → red; no dedup → 3 → red.
- `test_AC09_reinstated`: G2: audit raises A, B (carried `dismissed`, asserted on items); ann's debrief
  accepts A → `stats(CHECK)` V `reinstated: 1`, `lastAt` = ann's entry `at`; HA `dismissedByAgents`
  still 2, HA `reinstated: 0`; HA `accepted: 1`. FAILS when the reinstatement is missing, counted
  against the auditor, or removes the auditor's dismissal. Mutation: count against the raising agent →
  red; skip person-next check → red (next test).
- `test_AC09_reinstated_reverted`: ann reverts the G2 acceptance (RL-4 revert, 200) → V `reinstated:
  0` (V's entry gone or 0). Control: the 1 before the revert. Mutation: ignore reverts when finding the
  next entry → red.
- `test_AC09_not_reinstated_by_dismissal`: in another goal a person re-dismisses an agent-dismissed
  item (next person entry is `dismissed`) → `reinstated` unchanged. Mutation: count any next person
  entry → red.

### AC-10 Trigger (World hub API)

Each dismissal below is of a distinct item raised by `KEY`@`HA` in its own goal (`raise` then
`agentDispose` by `CHECK`@`V`), unless stated. Threshold 3. Owners: goals 1–2 `ann`, goal 3 `bob`.

- `test_AC10_opens_at_threshold`: after dismissal 2 → `calibGoals()` = `[]`, no `calibration.opened`.
  After dismissal 3 (bob's goal G3, item X3, lineage `L3`) → exactly one calibration goal C:
  owner `bob` (rule 3: owner of the goal of the newest dismissal); title `Calibrate alpha/auditor@<h12(HA)>`;
  `primaryRepo` = the repo part of `L3` (`L3.split("|")[1]`); `preset.name: "calibrate"`; no
  `refs.pulse`; topics empty; `profiles` `{}`; plan v1 approved with comment `calibration of
  alpha/auditor@<h12> (3 dismissals, threshold 3)`; no `plan_approved` message to bob; state
  `in_progress`; no design step; exactly one step `<C>.calibrate`, `ready`; `calibration`
  toStrictEqual `{key: KEY, hash: HA, threshold: 3, dismissals: [ref1, ref2, ref3]}` oldest first, each
  ref's fields equal to the validate history entry the test reads (`lineage, fp, goal, step, round,
  at`); C listed by plain `GET /v1/goals`. One `calibration.opened` event: user `bob`, goal C, payload
  toStrictEqual `{key: KEY, hash: HA, dismissals: 3, threshold: 3, calibrator: "bob"}`; C's timeline
  contains `opened calibration of alpha/auditor@<h12> (3 dismissals)`. `stats(KEY)` HA: `calibrating:
  3`, `uncalibrated: 0`, `calibration: C`. FAILS when the goal opens at 2 or not at 3, or any field,
  payload, text or count differs. Control: the 0 goals after 2. Mutations: `>` instead of `≥` → red;
  owner of the oldest dismissal → `ann` → red; dismissals newest first → red; design step created →
  red; event payload with `calibrator` missing → red.
- `test_AC10_no_second_goal`: continue: dismissals 4 and 5 → still one calibration goal of
  `(KEY, HA)`, one `calibration.opened`; HA `uncalibrated: 2`, `calibrating: 3`. Mutation: trigger
  ignores open goals → red.
- `test_AC10_dispose_counts`: fresh hub, threshold 3: two stage dismissals and a third through
  `mesh_dispose` (ann's debrief, `consumes [open]`, `may_set [dismissed]`) → one goal whose third ref's
  `step` is the debrief step. Mutation: trigger only on the record path → red.
- `test_AC10_revert_not_counted`: fresh hub, threshold 3: one `mesh_dispose` dismissal X1, reverted →
  event `item.reverted` for X1, no `calibration.*` event; two more dismissals X2, X3 → no goal,
  `uncalibrated: 2`; a 4th X4 → one goal whose refs are X2, X3, X4 (no ref with fp X1). FAILS when the
  revert counts or opens a goal. Control: the goal at X4. Mutation: count reverted entries → goal at
  X3 → red; trigger on revert → red.
- `test_AC10_person_raised`: items raised by ann's interactive step (`raiseAsPerson`), dismissed by
  `CHECK` three times → no calibration goal, no event; `stats(CHECK)` unaffected for them (control:
  `test_AC10_opens_at_threshold`'s agent-raised items open a goal). Mutation: count dismissals whose
  raising record has a person decider → red.
- `test_AC10_hashless`: records with `agent: {key: "alpha/nohash"}` (no hash), three dismissals →
  no calibration goal, no `calibration.opened`; `stats("alpha/nohash")` → exactly one entry `hash: ""`
  with `uncalibrated: 3`. Mutation: trigger for `""` → red; drop hash-less entries → red.
- `test_AC10_other_goal_counts_again`: the same fp dismissed in two different goals → two counted
  dismissals (`uncalibrated: 2`). Mutation: dedup per `(lineage, fp)` → red.
- `test_AC10_change_of_mind_own` (spec Open question S3): ann dismisses X then, in the same step and
  round, accepts it (RL-4 `own` replacement) → not a counted dismissal (`uncalibrated` unchanged,
  `accepted` +1). Mutation: count the replaced entry → red.

### AC-11 Calibrator order (World hub API, plus roster-kit catalog and pulse-kit pulses)

Threshold 1 (each test opens one goal with its first dismissal).

- `test_AC11_catalog_calibrator`: catalog source SRC with `calibrator: "carol"`, pushed `rev` = REV1 at
  C1; records by `{key: "agents/rev", hash: H1}` raise X in ann's goal; one dismissal → calibration
  goal owner `carol`, `primaryRepo` = `SRC` (the source repo id, not the lineage repo); event payload
  `calibrator: "carol"`. Mutation: skip rule 1 → owner ann → red; repo from the lineage → red.
- `test_AC11_catalog_hash_must_match`: same source, records by `agents/rev`@`H2` (no definition with
  that hash) → rule 1 does not apply (owner by rule 2/3 = ann; repo = lineage repo). Mutation: match on
  key only → carol → red.
- `test_AC11_calibrator_not_a_user`: source `calibrator: "ghost"` (no such user); a pulse of `bob`
  whose goal ran `agents/rev` (headless round with telemetry `agentKey: "agents/rev"`) → owner `bob`,
  `primaryRepo` = `SRC` (step 1 found the definition). Mutation: stop at rule 1 and open nothing → red;
  repo from lineage when calibrator unresolved → red.
- `test_AC11_newest_pulse`: repo agent `KEY`: pulses of `ann` (round `finishedAt` T−2d) and `bob`
  (T−1d), both with telemetry `agentKey: KEY` (any hash, one of them a different hash) → owner `bob`.
  Control variant: swap times → `ann`. Mutation: oldest pulse / first pulse created → red; require the
  same hash → red (the different-hash one is the newest in the swapped variant).
- `test_AC11_no_pulse_falls_to_goal_owner`: runs of `KEY` only in goals without `refs.pulse` (owner
  carol), newest dismissal in bob's goal → owner `bob`. Mutation: treat any goal with a run as a pulse
  goal → carol → red.

### AC-12 The `calibration` input (World hub API)

- `test_AC12_context_repo_agent`: the goal C of `test_AC10_opens_at_threshold` (3 dismissals, items
  with `title`, `severity`, `category`, `rule`, `path`, `symbol` on X1, no `symbol` on X2, evidence
  `[{path, lines: [3, 5], note: "N1"}]` on X1); `GET /v1/steps/<C>.calibrate/context` → exactly one
  input with `artifact: "calibration"`: `from: C`, `kind: "review"`, `title: "dismissals of
  alpha/auditor@<h12> (3)"`, `truncated: false`; `JSON.parse(content)` toStrictEqual the object the
  test builds: `agent: {key: KEY, hash: HA}` (no `text` key), `dismissals` in ref order each
  `{lineage, fp, goal, step, round, at, reason, decider, via, title, severity, category, rule, path,
  symbol?, evidence}` with `answer` only where the dismissal had one (the `mesh_dispose` one in a
  variant), `evidence` equal to the item's evidence in its raising record. FAILS on a missing, extra
  or different field or order. Mutation: evidence from the latest record instead of the raising one →
  red (the test changes the evidence note in a later record of the lineage); `text: undefined` written
  as a key → red under toStrictEqual after JSON round trip only if serialised as `null` (asserted
  `"text" in agent === false`).
- `test_AC12_context_catalog_text`: the goal of `test_AC11_catalog_calibrator` → `agent.text` === REV1
  byte for byte. Mutation: text from the newest def instead of the hash's → red (push REV2 at C2 after
  the dismissal).
- `test_AC12_fenced_untrusted`: `mesh_context` through ann's/bob's daemon for `<C>.calibrate` (as the
  holder) renders the calibration input inside the same untrusted fence/label as any other input
  (the test compares the wrapper lines with those of a `dispositions` input rendered in AC-05).
  Mutation: render the content raw → red.
- `test_AC12_no_calibration_goal`: an ordinary goal with a step `{inputs: ["calibration"]}` → its
  context has no input with `artifact: "calibration"` (control: the same request shape returns the
  entry for `<C>.calibrate`). Mutation: emit an empty entry → red.
- `test_AC12_size_cap`: 60 dismissals with long titles (over the RL-1 per-input cap) → `truncated:
  true` and `content.length` ≤ the RL-1 cap (the cap value taken from the existing RL-1 input test).
  Mutation: no cap → red.

### AC-13 Calibration done (World hub API)

Base: threshold 3, goal C open with 3 listed dismissals (from the AC-10 fixture), calibrator `bob`.

- `test_AC13_done_no_change`: bob claims `<C>.calibrate`, `reviewOk(rec({assessment: "clean", summary:
  "no change: fine"}))`, done → C `done`; one `calibration.done` (goal C) payload toStrictEqual `{key:
  KEY, hash: HA, dismissals: 3, outcome: "no-change"}`; C's timeline contains `calibration of
  alpha/auditor@<h12> done: no-change`; HA `calibrated: 3`, `calibrating: 0`, no `calibration` key; the
  three items' rows and history unchanged (deep-equal before/after). Mutation: skip the done hook on the
  step-done path → red; write to items → red.
- `test_AC13_issues_change`: same, `assessment: "issues"`, summary `changed definition` → `outcome:
  "change"`. Mutation: map by summary prefix → red.
- `test_AC13_next_goal_on_next_dismissal`: after `test_AC13_done_no_change`, threshold 3: two more
  dismissals → no goal (`uncalibrated: 2`); a third → a new goal C2 listing exactly those 3. Mutation:
  count calibrated as uncalibrated → goal opens at once → red.
- `test_AC13_done_opens_next_at_once`: while C is open add 3 more dismissals (`uncalibrated: 3`, no new
  goal); bob completes C → events in order: `calibration.done` (C) then `calibration.opened` (C2) with
  `dismissals: 3`; C2 lists the 3 new refs. Mutation: no trigger after done → red; trigger before
  marking calibrated → C2 lists 6 → red.
- `test_AC13_replan_path`: C open; bob proposes and approves plan v2 = `[{id: "recheck", kind: "review",
  repo: <C primaryRepo>}]` (no `consumes`/`when`) → `<C>.calibrate` `dropped`, `<C>.recheck` `ready`, C
  `in_progress`, no `calibration.done`; bob claims and dones `recheck` → C `done`, one `goal.done`, one
  `calibration.done` `{dismissals: 3, outcome: "none"}`; HA `calibrated: 3`. FAILS when the replan path
  does not mark calibrated or reports another outcome. Mutation: hook only on the calibrate step's done
  → red; outcome from any review in the goal → still `none` (no record), so the second mutation is:
  outcome `no-change` default → red.
- `test_AC13_listed_revert`: threshold 3, C listing 3 dismissals, one of them X via `mesh_dispose`;
  revert X → one `item.reverted`, no `calibration.*` event, C still `in_progress`,
  `calibration.dismissals` unchanged (deep-equal), HA `calibrating: 2`, `uncalibrated: 0`; done →
  `calibration.done` `dismissals: 3`; HA `calibrated: 2`. Variant (S1): after the revert, a later
  non-reverted dismissal of X in the same goal → that one is `uncalibrated: 1` (not listed). Mutation:
  shrink the list on revert → `dismissals: 2` → red; count reverted as calibrating → 3 → red; match refs
  by `(goal, lineage, fp)` only → variant red.
- `test_AC13_dropped_goal`: drop C (owner drop) → no `calibration.*` event, HA `uncalibrated: 3`,
  `calibrating: 0`, no `calibration`; the next dismissal opens C2 listing 4. Mutation: drop treated as
  done → red; drop triggers → red.

### AC-14 Web Roster statistics (Playwright, `test/e2e-web/calibration.spec.ts`)

Fixture: `frank` added to `test/e2e-web/hub.yaml` (a test-only token hash, comment "RL-6 spec only").
Seeded through the hub API with frank's device login (as `roster.spec.ts` seeds erin): a sync reporting
repo copies `<repo>/scout` (hash S) and `<repo>/idle` (another name, so its own group) under share
`me`; a goal with a headless step whose round finishes with telemetry `{agentKey: "<repo>/scout",
agentHash: S, costUsdEstimate: 0.1234, durationMs: 65000}` and a raising record by `<repo>/scout`@S
with 2 items.

- `test_AC14_stats_table`: log in as frank, open the Roster, group `scout`: click
  `button.roster-stats-toggle` (text `Stats`) → `table.roster-stats` visible with
  `tr[data-key="<repo>/scout"][data-hash="<S>"]`; `td[data-col=hash]` `<h12(S)>`, `runs` `1`,
  `failures` `0`, `cost` `$0.12`, `duration` `65.0s`, `raised` `2`, `accepted` `0`,
  `dismissed-agents` `0`, `dismissed-people` `0`, `reinstated` `0`, `carried` `0`, `regressions` `0`,
  `undeclared` `0`, `uncalibrated` `0`, `calibration` `-`. FAILS on a selector, text or format.
  Mutation: `toFixed(3)` cost → red; duration in ms → red.
- `test_AC14_toggle_no_reload`: second click → table hidden; count `GET …/stats` requests
  (`page.on("request")`): one per distinct key on the first click, none on hide. Mutation: reload on
  hide → red.
- `test_AC14_empty`: group `idle` → click → `p.empty` `No runs or findings in the last 30 days.` inside
  that group, no `table.roster-stats` rows. Control: scout's rows. Mutation: render an empty table →
  red.
- `test_AC14_error`: `page.route("**/v1/agents/*/stats*", 500 {error: "boom"})` → `p.error` with text
  `boom` inside the group. Mutation: generic error text → red.
- `test_AC14_calibration_link` (optional if seeding a calibration goal stays cheap: threshold of the
  shared e2e hub is the default 5, so five dismissals): `td[data-col=calibration] a[href="#/goal/<id>"]`.
  Left optional because the shared e2e hub config is not changed for RL-6 (see Open points).

### AC-15 Docs and skill (`test/schemas.test.ts` + review)

- `test_AC15_skill`: `MESH_SKILL` === `skills/mesh/SKILL.md` text (existing check), and it contains
  `calibration`, `mesh_review`, `issues`, `clean`, `no change:`. Mutation: edit only one copy → red.
- `test_AC15_docs`: `docs/guide/concepts.md` has headings `Calibration` and `Agent statistics` and
  mentions `calibration.threshold`, `reinstated`, `calibrate`; `docs/guide/howto.md` has `Calibrate an
  agent`; `docs/guide/install.md` contains `calibration:` and `threshold: 5`;
  `docs/plan/implementation-plan.md` contains `/v1/agents/:key/stats`; `docs/events.md` contains
  `calibration.opened`, `calibration.done`, `opened calibration of`, `done: `. Mutation: drop any row →
  red.
- Review item (not automated): no team-, company- or person-specific name added to code or docs
  (`git diff` of the row read by the reviewer; test fixture user names are generic).

### AC-16 Version, checks, OpenAPI (`test/schemas.test.ts` + CI)

- `test_AC16_version`: `package.json` `version === "0.1.20"`.
- `test_AC16_openapi_route`: `schemas/hub-api.openapi.json` equals the freshly generated document
  (existing check) and has path `/v1/agents/{key}/stats` `get` with the rule/scope/tag extensions the
  RL-5 route test reads, plus a `days` query parameter. Mutation: forget `pnpm schemas` → red.
- Commands (CI and the implementer): `pnpm lint`, `pnpm typecheck`, `pnpm boundaries`, `pnpm test`,
  `pnpm build` (= `pnpm check`), `pnpm test:web` after `pnpm build`, `pnpm schemas` with no diff.

### AC-17 Whole programme (`test/programme.test.ts`, World + fake `claude`)

Setup: `Relay.start(["ann"], {hubYaml: {calibration: {threshold: 2}, auth: {session:
{device_max_age: "60d", device_idle: "30d"}}}})`; `ann = headlessPerson("ann", {agents: {auditor,
checker, filer}, person: {shareSessions: "me"}})` (runner, accept `self`, remote-backed repo `alpha`);
ann adds an every-7d pulse whose preset text is the design §5.6 relay (`audit`; `validate`;
`debrief` `assignee: "@owner"`, `when: {open: true, min_severity: S2}`, `consumes [open, confirmed]`,
`may_set [accepted, dismissed, deferred]`; `file` `consumes [accepted]`, `may_set [accepted]`,
`output: review-record`, `inputs: [dispositions]`), params `agent=auditor,validator=checker,filer=filer`.
Headless runs follow the AC-21 pattern of `test/review-daemon.test.ts`: `r.script(id, [{waitFor:
"end-<pid>"}])`, offer, `pull`, `started`, the run's session calls `mesh_artifact`/`mesh_review`/
`mesh_done` via `r.w.tool`, `r.go`, `endRun`. Hashes of the three agents are computed by the test from
the committed texts (RL-5 `agentFileHash` contract) and compared with `telemetry.agentHash`.

One `it` with labelled `expect` messages per stage (`test_AC17_whole_programme`), so a failure names
the stage:

1. **Slot 1** fires G1: no design step; `G1.audit` offered to ann's runner and run there (fake call file
   for `G1.audit`, `cwd` under the runner's workspace); it uploads a `report` artifact and a complete
   record with A (S2) and B (S3).
2. `G1.validate` runs on the runner (one fake call), confirms A, dismisses B.
3. `G1.debrief` `ready`, assignee ann, **never offered** (no offer message for it in any inbox, no fake
   call); ann holds it and `mesh_dispose` accepts A; submits the debrief record; done.
4. `G1.file` offered to the runner, runs (propose-via-branch: the round has a `branch`), records A
   `accepted` with `link` (applied, fix 2); G1 `done`; `calibGoals()` = `[]` (1 dismissal < 2).
5. **Slot 2** (clock + 7d) fires G2; the audit raises A, B, new C (S3), B's evidence unchanged → the
   record's `fold.carried === 1`; B `dismissed`, A `accepted` with the link (item row).
6. `G2.validate` dismisses C → exactly one calibration goal for `(alpha/auditor, <auditor hash>)`, owner
   `ann` (rule 2: pulse owner), `calibration.dismissals` fps = `[B, C]` in that order.
7. `G2.debrief` and `G2.file` `skipped` (fix 1 for `file`); `r.calls("<G2>.debrief")` and
   `r.calls("<G2>.file")` empty; G2 `done`.
8. Every round of every step run carries `telemetry` with the right `agentKey`.
9. `stats("alpha/auditor")` → one hash entry: `runs: 2`, `raised: 5`, `new: 3`, `carried: 1`,
   `accepted: 1`, `dismissedByAgents: 2`, `dismissedByPeople: 0`, `calibrating: 2`, `calibration` = the
   goal; `stats("alpha/checker")` `runs: 2`; `stats("alpha/filer")` `runs: 1`.

FAILS when any step is not run, runs elsewhere, runs twice or re-files; a dismissal is not carried; the
link is lost; telemetry is missing; a stats value differs; or there is no, an early, or a second
calibration goal. Control: each stage asserts the positive state (ran, offered) before the negatives
(not offered, skipped). Mutations: revert fix 1 → `G2.file` runs → red; revert fix 2 → A has no link
after G1 → red; threshold `>` → no goal → red; count carried dismissal B again in G2 → goal at slot 2
lists 3 → red.

## Coverage

| Criterion | Tests |
|---|---|
| AC-01 | `test_AC01_goal_calibration`, `test_AC01_step_policy_calibration_input`, `test_AC01_input_keywords`, `test_AC01_config_threshold` |
| AC-02 | `test_AC02_filed_not_consumed`, `test_AC02_mixed`, `test_AC02_empty_when` |
| AC-03 | `test_AC03_builtin_order`, `test_AC03_instantiate`, `test_AC03_validate_and_relay_unchanged`, `test_AC03_cli_preset_ls` |
| AC-04 | `test_AC04_tables_equal_migrated`, `test_AC04_migrate_copies_topics` (Postgres leg not run here; SQLite stand-in runs) |
| AC-05 | `test_AC05_unfiled_runs`, `test_AC05_filed_skipped`, `test_AC05_mixed_lists_only_unfiled` |
| AC-06 | `test_AC06_agree_applied`, `test_AC06_disagree_ignored`, `test_AC06_person_still_wins_after_agent_entry`, `test_AC06_restate_not_consumed_no_422` |
| AC-07 | `test_AC07_days_400`, `test_AC07_key_400`, `test_AC07_unknown_and_header`, `test_AC07_auth`, `test_AC07_route_table` |
| AC-08 | `test_AC08_values_30d`, `test_AC08_window_1d`, `test_AC08_window_edge`, `test_AC08_tie_order`, `test_AC08_hashless_runs` |
| AC-09 | `test_AC09_once_per_goal`, `test_AC09_reinstated`, `test_AC09_reinstated_reverted`, `test_AC09_not_reinstated_by_dismissal` |
| AC-10 | `test_AC10_opens_at_threshold`, `test_AC10_no_second_goal`, `test_AC10_dispose_counts`, `test_AC10_revert_not_counted`, `test_AC10_person_raised`, `test_AC10_hashless`, `test_AC10_other_goal_counts_again`, `test_AC10_change_of_mind_own` |
| AC-11 | `test_AC11_catalog_calibrator`, `test_AC11_catalog_hash_must_match`, `test_AC11_calibrator_not_a_user`, `test_AC11_newest_pulse`, `test_AC11_no_pulse_falls_to_goal_owner` |
| AC-12 | `test_AC12_context_repo_agent`, `test_AC12_context_catalog_text`, `test_AC12_fenced_untrusted`, `test_AC12_no_calibration_goal`, `test_AC12_size_cap` |
| AC-13 | `test_AC13_done_no_change`, `test_AC13_issues_change`, `test_AC13_next_goal_on_next_dismissal`, `test_AC13_done_opens_next_at_once`, `test_AC13_replan_path`, `test_AC13_listed_revert`, `test_AC13_dropped_goal` |
| AC-14 | `test_AC14_stats_table`, `test_AC14_toggle_no_reload`, `test_AC14_empty`, `test_AC14_error` (`test_AC14_calibration_link` optional) |
| AC-15 | `test_AC15_skill`, `test_AC15_docs`, review item |
| AC-16 | `test_AC16_version`, `test_AC16_openapi_route`, `pnpm check`, `pnpm test:web`, `pnpm schemas` |
| AC-17 | `test_AC17_whole_programme` |

## Risks

- Kits: review-kit `Rk`, roster-kit `Rk` and `Pk` each start their own `Relay` with their own cast;
  AC-11 needs a catalog source, pulses and agent records in one hub. `calib-kit` starts one `Relay`
  and reuses the kits' request helpers on it (their constructors take a `Relay`/`Pk`); if a kit
  hard-codes its cast, `calib-kit` adds thin wrappers rather than changing the kit.
- Agent deciders in hub-API tests come from `rec({agent})` on headless steps (the RL-2 test pattern);
  only AC-17 proves the daemon path end to end.
- The calibration goal's plan comment and the "no `plan_approved` message" are read through the goal
  view and the owner's inbox; if the comment is only on the plan route, the test reads that route.
- Timings in AC-17 depend on the fake's `waitFor` handshakes; the test uses `until` with the RL-4
  timeouts (60 s describe timeout).

## Open points for the spec (not decided here; conservative reading used)

- 2026-11-12 `calibration.threshold` given as a string (`"3"`) in YAML: the spec says `<int ≥ 1>`; the
  plan expects a config error (conservative). If the existing config parser coerces strings elsewhere,
  the spec should say so and the case is dropped.
- 2026-11-12 `link: ""` on an accepted item: the spec says "with a `link`"; the plan leaves the empty
  string case out unless the spec settles it.
- 2026-11-12 AC-14 calibration-link cell: seeding a calibration goal in the shared e2e hub needs 5
  dismissals (default threshold); planned as optional.
