# Spec RL-6: Calibration, stats and end-to-end acceptance

## Status
Draft

Source: `docs/analysis/2026-11-12-pulse-relay-roster.md` §5.8 (Calibration), §5.9 (Telemetry and
`/stats`), §5.10 (Roster views with stats), REQ-9, R-3, slice S6 of §9, and the "End-to-end acceptance
(whole programme)" paragraph of §10 with the OQ-2 and OQ-4 defaults;
`docs/analysis/2026-11-12-claude-cli-spike.md` wins where it differs (it does not touch this row).
Builds on RL-1..RL-5 (headless runs and telemetry, review records and item states, pulses, debriefs,
roster), landed as v0.1.15..v0.1.19. Release v0.1.20.

## Problem

Dismissals are recorded (RL-2, RL-4) but nothing counts them against the agent that raised the item,
so a noisy agent keeps its schedule and nobody is asked to fix it (R-3). Telemetry is stored per round
(RL-1) but nothing sums it per agent, so no data says which agents earn a schedule (problem 4 of the
design). The pieces RL-1..RL-5 delivered were each tested alone; no test runs the whole programme
(pulse → headless audit → validator → person's debrief → filer → second slot → stats → calibration),
and such a run exposes two RL-2/RL-4 gaps (below). Separately, `mesh hub migrate` has never copied the
`topic` table (v0.1.8): it is missing from `TABLES` in `src/store/hub-copy.ts`.

## Scope

In:
- Counting dismissals per raising agent `(key, hash)`; reinstatements per dismissing agent.
- Hub config `calibration.threshold`; the trigger that opens one visible calibration goal per agent
  hash from the new built-in `calibrate` preset, for the resolved calibrator; the `calibration` step
  input; marking dismissals calibrated when that goal is done; events `calibration.opened|done`.
- `GET /v1/agents/:key/stats?days=` per hash.
- Web Roster: per-group statistics table.
- Fixes exposed by the end-to-end test (impl-bug in RL-2/RL-4): agent dispositions that agree with a
  person's decision in the same goal; filed (`accepted` with a `link`) items no longer consumed.
- Fix (older bug): `topic` in `TABLES`, with a test that every hub table is in `TABLES`; shipped as
  its own commit with its own changelog line, so it can be picked or reverted alone.
- The whole-programme World test (design §10) and any further gap in RL-1..RL-5 it exposes, fixed in
  the module that owns it (impl-bug).
- Docs: concepts, how-to, install (hub config), the mesh skill, the plan API table, the events list.

Out:
- A CLI for statistics (`mesh agent stats`); TUI views of stats or calibration (Open questions).
- A calibrator agent: the calibration step is a person's interactive step.
- Per-repo calibrator configuration (Open questions); clearing a catalog source's `calibrator`.
- Changing the built-in `audit-relay` (stays agent-only, RL-4); a built-in relay with a debrief.
- Disabling calibration (threshold 0); retroactive goals for agents that crossed the threshold before
  v0.1.20 without a new dismissal.
- New migrations: `SCHEMA_VERSION` stays 11.

## Interface contracts

Names used below.
- **Agent key**: the `key` RL-1/RL-5 runs report (`RunTelemetry.agentKey`, the `agent` decider of a
  review record, `ItemRow.raisedBy.key`): `<repo name>/<agent name>` for a repo agent,
  the canonical key `<source repo name>/<name>` for a roster agent. **Agent hash**: the matching
  `agentHash` / decider `hash`; `""` stands for "no hash".
- **Raising record of a disposition**: the newest raising review record (`StoredReview.raising`) of
  the disposition's lineage whose `goal` is the disposition's goal. Its **raising agent** is that
  record's decider when `decider.kind = "agent"` (`(decider.key, decider.hash ?? "")`). A disposition
  whose raising record is missing or has a person decider has no raising agent and is never counted.
- **Reverted entry**: a disposition history entry whose next history entry of the same `(lineage, fp)`
  is a `revert` entry. Reverted entries count toward nothing below.
- **Counted dismissal**: per `(goal, lineage, fp)`, the **earliest** item history entry
  `kind: "disposition"`, `disposition: "dismissed"` (any decider, any `via`) of that goal that has a
  raising agent and is not reverted. At most one counted dismissal exists per `(goal, lineage, fp)`: a
  second dismissal of the same fp in the same goal (a person's after an agent's, or an agreeing agent's
  after a person's) adds nothing. Its decider (agent or person) and `at` are those of that earliest
  entry. A dismissal of the same fp in another goal is another counted dismissal. Identified by
  **`DismissalRef`** `{ lineage, fp, goal, step, round, at }` (fields of the history entry).
- **Calibration goal** of `(key, hash)`: a goal whose `calibration.key`/`calibration.hash` are those.
  It is **open** while the goal is not `done` or `dropped`. A counted dismissal is **calibrating** when
  an open calibration goal lists it, **calibrated** when a `done` one lists it, else **uncalibrated**.
- **Window**: `since = now − days × 86 400 000`; an event is in the window when its time `≥ since`.

### Types (src/protocol/goal.ts, src/protocol/roster.ts, src/protocol/hub.ts; exported from src/protocol/index.ts)

| Interface | Type | Change |
|---|---|---|
| `DismissalRef` (goal.ts) | zod | `{ lineage: string, fp: string, goal: string, step: string, round: int, at: number }`. |
| `GoalCalibration` (goal.ts) | zod | `{ key: string, hash: string, threshold: int ≥ 1, dismissals: DismissalRef[] }`. |
| `Goal.calibration` | zod field | New, optional `GoalCalibration`; set only on goals the trigger creates; stored in the goal value. |
| `StepPolicy.inputs` | zod field | The keyword set gains `"calibration"`; `INPUT_KEYWORDS` (src/core/policy.ts) gains it (a step id `calibration` is then never an input step, as for the other keywords). |
| `AgentHashStats` (roster.ts) | interface | `{ hash: string, runs: number, failures: number, meanCostUsd: number \| null, meanDurationMs: number \| null, raised: number, new: number, regressions: number, carried: number, undeclaredRules: number, accepted: number, dismissedByAgents: number, dismissedByPeople: number, reinstated: number, uncalibrated: number, calibrating: number, calibrated: number, calibration?: string, lastAt: number }`. |
| `AgentStats` (roster.ts) | interface | `{ key: string, days: number, since: number, threshold: number, hashes: AgentHashStats[] }`. |
| `HubConfig.calibration` (src/hub/config.ts) | field | `{ threshold: number }`, from YAML `calibration: { threshold: <int ≥ 1> }` (default 5; 0, negatives and non-integers fail config parsing). |

### Pure function changes (src/core/review.ts)

| Function | Contract |
|---|---|
| `whenHolds(when, consumes, items: { state: ItemState; severity: Severity; link?: string \| undefined }[])` | As RL-2, except that an item with `state: "accepted"` **and** a `link` (filed) never matches a consumed state. `when: {}` still returns `true`. |

### Fixes to RL-2/RL-4 behaviour (src/hub/service.ts)

1. **Filed items are not consumed.** An item in state `accepted` with a `link` is treated as not in a
   consumed state by `when` evaluation (settle: plan approve, step done, gate decide, reopen) and by
   the `dispositions` input of a consuming step (it is left out). The disposition checks of a record
   and of `mesh_dispose` are unchanged.
2. **Agent dispositions that agree with a person.** The order of the record checks stays as RL-2:
   `may_set`, `until`, listed twice, not in the run's record, then person precedence, then the state
   check against `consumes` (422). Only the precedence step changes. In a consuming stage's record
   (agent decider), for a disposition of an fp that has a person disposition in the same goal, the hub
   looks at the latest **person** disposition of that fp in the goal (`<user>` its decider):
   - same `disposition` value **and** the item's current state is in the stage's `consumes` →
     applied (history entry with the agent decider; `link`/`until` set on the row as RL-2);
   - otherwise (a different value, or the same value while the item's state is not in `consumes`) →
     put in `ignored` with the RL-2 reason `decided by <user> in this goal`; the item is unchanged and
     the record gets no 422 for it (as RL-2).

   So a record RL-2 accepted is never refused under RL-6: every disposition RL-2 ignored is either
   still ignored or applied. Precedence looks at the latest person disposition in the goal, not the
   latest entry, so an agent entry after a person's never lets a later agent stage override the
   person. Dispositions of an fp with no person disposition in the goal behave as RL-2.
3. Any other gap the whole-programme test (AC-17) exposes is fixed where it lives and listed in the
   implementation notes of the change; no contract above changes for it.

### Counting and statistics

`GET /v1/agents/:key/stats` (src/hub/app.ts, src/protocol/hub-api.ts): rule `member`, scope
`goals:read`, tag `goals`. `:key` is the agent key with `/` percent-encoded (`encodeURIComponent`,
e.g. `/v1/agents/alpha%2Fauditor/stats`). Query `days` (optional, default 30).

- `days` not an integer from 1 to 365 → 400 `days must be a whole number from 1 to 365`.
- A decoded key that is empty, longer than 330 characters or without `/` → 400
  `an agent key is <repo>/<name>`.
- An unknown key → 200 with `hashes: []`.
- 200 `AgentStats`: `key` as decoded, `days`, `since`, `threshold` = the hub's threshold.
  `hashes`: one entry per hash with at least one non-zero count below or a `calibration`, ordered by
  `lastAt` descending, then hash. Per hash `h`:

| Field | Value |
|---|---|
| `runs` | Rounds of `mode: headless` steps whose `telemetry.agentKey = key` and `(telemetry.agentHash ?? "") = h`, with `finishedAt` in the window. |
| `failures` | Those runs with `outcome: "fail"`. |
| `meanCostUsd` | Mean of `telemetry.costUsdEstimate` over the runs that have it (unrounded); `null` when none. |
| `meanDurationMs` | `Math.round` of the mean `telemetry.durationMs` over the runs; `null` when no run. |
| `raised` | Over the raising review records with decider `{kind: agent, key, hash: h}` (hash absent = `""`) and `at` in the window: the sum of their distinct fingerprints. |
| `new`, `regressions`, `carried` | Sum of `fold.new`, `fold.regression`, `fold.carried` of those records (a record without `fold` adds 0). |
| `undeclaredRules` | Sum of `StoredReview.undeclaredRules` of those records. |
| `accepted` | Distinct `(goal, lineage, fp)` with a non-reverted `accepted` disposition entry with `at` in the window whose raising agent is `(key, h)`. |
| `dismissedByAgents` / `dismissedByPeople` | Counted dismissals with `at` in the window whose raising agent is `(key, h)`, by the decider of the counted entry (`agent` / `person`). |
| `reinstated` | Non-reverted dismissal entries whose **decider** is `{kind: agent, key, hash: h}` and whose next disposition entry of the same `(lineage, fp)` (any goal) is non-reverted, has a `person` decider and a disposition other than `dismissed`, with that person's entry `at` in the window. |
| `uncalibrated`, `calibrating`, `calibrated` | All counted dismissals (no window) whose raising agent is `(key, h)`, by calibration status. |
| `calibration` | The id of the open calibration goal of `(key, h)`, when there is one. |
| `lastAt` | The newest of: run `finishedAt` (counted runs), raising record `at` (counted records), `accepted` entry `at`, counted dismissal `at` (in-window ones, for `dismissedBy*`), and the **person's** entry `at` for `reinstated`. When none of these is in the window: the newest `at` of the hash's counted dismissals (any time), else the calibration goal's `createdAt`. |

Stats count every goal (goals are team-visible); no share level applies.

**Reads.** No new `HubStore` method: the route and the trigger use the existing reads
`listSteps({})` (rounds and their telemetry), `listReviews({ raising: true })` (raising records),
`listDispositions({})` (disposition entries, in history order), `itemHistory(lineage)` per lineage that
has a disposition (to find reverts and next entries), `listGoals()` (calibration goals, pulse goals)
and `listCatalogSources()`/`listCatalogDefs({})` (calibrator rule 1). The trigger runs them inside the
goal transaction of the request that recorded the dismissal.

### Calibration trigger (src/hub/service.ts)

- **When.** In the same transaction, after the hub records a dismissal (a consuming record that
  applies a `dismissed`, `POST /v1/steps/:id/dispositions` / `mesh_dispose` with `dismissed`), for its
  raising agent `(key, hash)`; and after a calibration goal becomes `done`, for its `(key, hash)`. A
  revert never triggers. Hash `""` never triggers.
- **Condition.** No open calibration goal of `(key, hash)` exists and `uncalibrated ≥ threshold`.
- **Calibrator** (first that resolves to an existing user):
  1. the `calibrator` of a catalog source that has a definition (any commit) with
     `canonicalKey(source, name) = key` and `hash` = the agent hash (first such source by repo id);
  2. the owner of the newest pulse goal that ran `key` (any hash): among goals with `refs.pulse`, the
     one holding the headless round with `telemetry.agentKey = key` and the largest `finishedAt` (a
     pulse goal's owner is its pulse's owner);
  3. the owner of the goal of the newest uncalibrated dismissal.

  Users are never removed today, so rule 3 always resolves. Should none resolve, the trigger opens no
  goal and emits no event; the next trigger for `(key, hash)` tries again.
- **Repo** of the goal: the catalog source's repo id when step 1 found a definition (also when that
  source has no calibrator), else the repo part of the lineage of the newest uncalibrated dismissal
  (the step repo of its raising record).
- **Goal.** Created like a pulse goal (create-with-plan: no design step, plan v1 approved, no
  `plan_approved` message, `in_progress`) from the built-in `calibrate` preset with params
  `{repo, agent: key, hash: <hash12>}`: owner = calibrator, title `Calibrate <key>@<hash12>`,
  `primaryRepo` = repo, `preset.name` = `calibrate`, no `refs.pulse`, no topics, `profiles` `{}`,
  plan comment `calibration of <key>@<hash12> (<n> dismissals, threshold <t>)`, and
  `calibration = {key, hash, threshold: t, dismissals}` where `dismissals` = every uncalibrated counted
  dismissal of `(key, hash)` (`n` of them), oldest first. Shown in `GET /v1/goals` by default. Event
  `calibration.opened` (user = calibrator, goal = the new goal) with payload
  `{key, hash, dismissals: n, threshold: t, calibrator}`. At most one open calibration goal per
  `(key, hash)`.
- **Done.** One hook covers every path that sets a goal `done` (step done, gate decide, resume, plan
  approve/replan): wherever the hub emits `goal.done` for a goal with `calibration`, in the same
  transaction its listed dismissals become calibrated (no write to the items), the hub emits
  `calibration.done` (goal) with payload `{key, hash, dismissals: n, outcome}`, and the trigger runs
  for `(key, hash)`. `outcome` = `change` when the newest review record of the goal's `calibrate` step
  has `assessment: "issues"`, `no-change` for `"clean"`, else `none` (also when a replan dropped the
  step). A dropped calibration goal is not open and lists nothing calibrated; dropping it triggers
  nothing (its dismissals wait for the next trigger).
- **A listed dismissal reverted later.** The revert emits nothing and does not change the goal: the
  goal stays open, `calibration.dismissals` is unchanged, and `calibration.done` reports `n` = the
  number of listed refs. The reverted entry is no longer a counted dismissal, so it counts in no bucket
  (`uncalibrated`, `calibrating`, `calibrated`).
- **Activity texts** (`describe()`, shown in goal timelines and the overview activity):
  `calibration.opened` → `opened calibration of <key>@<hash12> (<n> dismissals)`;
  `calibration.done` → `calibration of <key>@<hash12> done: <outcome>`.

### Built-in `calibrate` preset (src/core/presets.ts)

`BUILTIN_PRESETS` gains, after `audit-relay`, `calibrate` with description
`Calibrate an agent from the dismissals of its findings (opened by the hub when an agent reaches the dismissal threshold).`
and one step:

| Field | Value |
|---|---|
| `id` / `kind` / `repo` | `calibrate` / `review` / `"{repo}"` |
| `output` / `inputs` | `review-record` / `[calibration]` |
| `title` | `Calibrate {agent}@{hash}` |
| `brief` | `Read the input "calibration" from mesh_context: the dismissed findings of {agent}@{hash} with their evidence and reasons, and the agent's definition when the hub has it. Either change the agent's definition on this step's branch so such findings are no longer raised, or decide that no change is needed. Then submit a review record with no items (mesh_review): assessment "issues" with a summary of the change, or assessment "clean" with a summary starting "no change:" and the reason; then mesh_done.` |

No `mode` (interactive), no `agent`, no `profile`. `validatePolicies` reports nothing for it.

### The `calibration` input (mesh_context, `GET /v1/steps/:id/context`)

For a step whose `inputs` include `calibration` and whose goal has `calibration`, the inputs carry
one entry `{from: <goal id>, artifact: "calibration", kind: "review", title: "dismissals of <key>@<hash12> (<n>)", content, truncated}`
(fenced and labelled untrusted as every input; the RL-1 size caps apply). `content` is the JSON text of
`{ agent: { key, hash, text? }, dismissals: { lineage, fp, goal, step, round, at, reason, decider, via, answer?, title, severity, category, rule, path?, symbol?, evidence }[] }`
in `dismissals` order, where the item fields come from the item row and `evidence` is the item's
evidence in its raising record (path, lines, note). `text` is the catalog definition text of
`(key, hash)` when step 1 of the calibrator rule finds one, else absent. A goal without `calibration`:
no entry.

### Web (web/src/roster.tsx, web/src/api.ts)

- Each `section.roster-group` gains a `button.roster-stats-toggle` with text `Stats`. A click loads
  `GET /v1/agents/<encoded key>/stats?days=30` for each distinct copy `key` of the group (copy order:
  the group's `versions` in reply order, then each version's `copies` in order; a key's first
  occurrence fixes its place) and shows one `table.roster-stats` in the group; a second click hides it
  (no reload while hidden).
- One `tr` per `(key, hash)` with `data-key` and `data-hash` (full hash; `""` for no hash), keys in
  copy order, hashes in reply order, with one `td[data-col=…]` per column:
  `hash` (hash12, or `-`), `runs`, `failures`, `cost` (`$<meanCostUsd.toFixed(2)>`, or `-`),
  `duration` (`<(meanDurationMs/1000).toFixed(1)>s`, or `-`), `raised`, `accepted`,
  `dismissed-agents`, `dismissed-people`, `reinstated`, `carried`, `regressions`, `undeclared`,
  `uncalibrated` (decimal integers), `calibration` (`a[href="#/goal/<id>"]` with the id as text, or `-`).
- No row in any reply → `p.empty` `No runs or findings in the last 30 days.` inside the group. A
  failing request → `p.error` with the hub's text inside the group.

### Hub copy (src/store/hub-copy.ts)

`TABLES` gains `{ name: "topic" }` (after `idem`). Afterwards the set of names in `TABLES` equals the
set of tables a fresh SQLite database has after `HUB_MIGRATIONS` (excluding `sqlite_%` and
`schema_version`), with no duplicates; `mesh hub migrate` therefore copies topic rows.

### Docs

| File | Change |
|---|---|
| `docs/guide/concepts.md` | "Calibration": what a counted dismissal is (raising agent = the agent of the run's record in that goal; both deciders; once per goal and item; reverts excluded; person-raised items not counted), reinstatements counted against the dismissing agent, the threshold (`calibration.threshold`, default 5), one open goal per agent hash, the calibrator order (catalog source `calibrator`, owner of the latest pulse that ran the agent, owner of the goal of the latest dismissal), the `calibrate` preset and its record, calibrated on done. "Agent statistics": the route, the window, every field. The two RL-6 rules on filed items and agreeing agent dispositions under "Review records". |
| `docs/guide/howto.md` | "Calibrate an agent": reading the Roster statistics, what the calibrator gets, running the step (`mesh run --step`, the `calibration` input, a change on the branch or `no change:`), setting the threshold. |
| `docs/guide/install.md` (hub config) | `calibration: { threshold: 5 }`. |
| `src/protocol/skill.ts` `MESH_SKILL` + `skills/mesh/SKILL.md` | A row for a calibration step: read the `calibration` input, change the agent on the branch or decide no change, `mesh_review` with no items and `assessment` `issues`/`clean`, then `mesh_done`. |
| `docs/plan/implementation-plan.md` §5.6 | Row for `GET /v1/agents/:key/stats?days=` (v0.1.20). |
| `docs/events.md` | `calibration.opened`, `calibration.done` with their payloads and activity texts. |

### Compatibility

- No migration. Stored goals without `calibration` are not calibration goals. Dismissals recorded
  before v0.1.20 count as uncalibrated; they open a goal only at the next dismissal of that agent hash
  (or the next calibration goal done).
- Hub config files without `calibration` get threshold 5.
- Review records: every agent disposition RL-2 put in `ignored` for person precedence is still
  ignored, except one that agrees with the person's latest decision in the goal while the item's state
  is in the stage's `consumes`, which is now applied. No record RL-2 accepted gets a 422.
- Existing tests that list `BUILTIN_PRESETS`, `mesh preset ls`, the route list, `INPUT_KEYWORDS`,
  `TABLES` or `package.json` version are updated by the test-writer.

## Acceptance criteria

Surfaces: unit tests (`src/core`, `src/protocol`, `src/hub/config.ts`); the `HubStore`/hub-copy
checks (SQLite always; Postgres legs only when `MESH_TEST_PG_URL` is set, not run locally); World
tests (`test/helpers/world.ts` and kits, extendable) with the fake `claude` of RL-1 (never the real
binary); Playwright (`test/e2e-web`, `pnpm test:web`). Fixture rules: a daemon reports only
remote-backed repos and only under `shareSessions` `me`/`all`; World tests past 14 days give device
tokens a longer max age (as `test/pulse-daemon.test.ts`); web e2e specs share one hub, so the RL-6 spec
logs in as a new user `frank` (added to `test/e2e-web/hub.yaml`) no other spec asserts on; a goal made
through `POST /v1/goals` gets a ready design step (pulse, ingest and calibration goals do not).

| Id | Criterion | Surface | What exact state makes it FAIL? |
|---|---|---|---|
| AC-01 | Schemas and config: `Goal` accepts a `calibration` with two `DismissalRef`s and rejects `threshold: 0`; `StepPolicy` accepts `inputs: ["calibration"]`; `INPUT_KEYWORDS` has `calibration`, and a plan with `inputs: ["calibration"]` and no step of that id passes `validatePolicies`; hub YAML without `calibration` → threshold 5; `calibration: {threshold: 2}` → 2; `0`, `-1`, `1.5` → config error. | unit | Any accept/reject the other way or another default. |
| AC-02 | `whenHolds({open: true}, ["accepted"], [{state: "accepted", severity: "S2"}])` = true; with `link: "x"` = false; `consumes ["accepted", "confirmed"]` with a linked accepted and a confirmed item = true; `when: {}` with only a linked accepted item = true. | unit | Another boolean. |
| AC-03 | Built-in `calibrate`: listed by `mesh preset ls` after `audit-relay`; `instantiate` with `{repo: "alpha", agent: "alpha/auditor", hash: "0123456789ab"}` gives exactly one step with the documented fields, title `Calibrate alpha/auditor@0123456789ab` and the documented brief; `validatePolicies` reports nothing; `audit-relay` is unchanged. | unit + CLI | A field, text or list order differs. |
| AC-04 | Hub copy: the names of `TABLES` equal (as a set, no duplicates) the tables of a fresh SQLite file migrated with `HUB_MIGRATIONS` (excluding `sqlite_%`, `schema_version`), so `topic` is in it; with Postgres set, `mesh hub migrate` of a SQLite hub with two topics copies both. | unit (SQLite file) + contract (Postgres leg) | A migrated table missing from `TABLES`, a name not a table, a duplicate, or (Postgres) topics not copied. |
| AC-05 | Filed items (fix 1): a goal whose filer step `consumes: [accepted]`, `when: {open: true}`: after its run's record leaves item A `accepted` without link the filer becomes `ready` and its `dispositions` input lists A; in a later goal of the lineage where A repeats `accepted` with a link and no other item is accepted, the filer is `skipped` (event `step.skipped`) and has no `dispositions` input entry for A. | World (hub API) | The filer runs for a filed item, is skipped while an unfiled accepted item exists, or the input lists a filed item. |
| AC-06 | Agreeing agent dispositions (fix 2), filer policy `consumes: [accepted]`, `may_set: [accepted, dismissed]`: a person's debrief accepts A; the filer's record (agent) with A `accepted` + `link` → applied (`applied: 1`, no `ignored`), item `link` set, history entry with the agent decider, event `item.disposed`; the same record with A `dismissed` → `ignored` `[{fingerprint: A, reason: "decided by <user> in this goal"}]` and A unchanged; after the agent's agreeing entry, a later agent stage in the goal (same policy) that dismisses A is still ignored. State check kept: in another goal a person's debrief dismisses A, and a later agent stage with `consumes: [open]`, `may_set: [dismissed]` restates A `dismissed` → 200, `ignored` `[{fingerprint: A, reason: "decided by <user> in this goal"}]`, no 422, A still `dismissed` with no new history entry, and the step can be done. | World (hub API) | An agreeing disposition ignored while its state is consumed, a disagreeing one applied, the person's decision overridden after an agent entry, or a 422 / a history entry for the agreeing restatement whose state is not consumed. |
| AC-07 | Stats route: `days=0`, `days=366`, `days=x` → 400 `days must be a whole number from 1 to 365`; key `nokey` (no `/`) → 400 `an agent key is <repo>/<name>`; unknown key → 200 `hashes: []`, `days: 30`, `since` = now − 30 days, `threshold` = config; no token → 401; a service token with `goals:read` → 200; the route is in `HUB_API` with rule `member`, scope `goals:read`, tag `goals`. | World (hub API) | Another status, text, field or route entry. |
| AC-08 | Stats values: for agent `alpha/auditor` with two hashes H1, H2: runs (incl. one `fail` and one without `costUsdEstimate`), raising records with folds and undeclared rules, dispositions by agent and person, one reverted dismissal, one reverted `accepted` entry and one dismissal outside the window, each field of `AgentHashStats` equals the documented value (the reverted entries count toward nothing); `days=1` excludes the older entries but keeps `uncalibrated`; hashes ordered by `lastAt` as documented (H2's only activity is an old dismissal, so its `lastAt` is that dismissal's `at` and it sorts after H1); `meanCostUsd`/`meanDurationMs` `null` for a hash without runs. | World (hub API) | Any count, mean, null, order, `lastAt` or window differs, or a reverted entry is counted. |
| AC-09 | Reinstated and once per goal: in goal G1 the auditor raises A and B; validator `alpha/checker` (hash V) dismisses both; the person's debrief in G1 (consumes `dismissed`, may_set `[accepted, dismissed]`) dismisses B again and leaves A → the auditor has `dismissedByAgents: 2`, `dismissedByPeople: 0`, `uncalibrated: 2` (B once), and `alpha/checker` V `reinstated: 0`. In G2 (A carried `dismissed`) a person's debrief (consumes `dismissed`) accepts A → `alpha/checker` V `reinstated: 1`; the auditor's `dismissedByAgents` stays 2. That G2 acceptance reverted (RL-4 revert) → `reinstated: 0`. | World (hub API) | A dismissal counted twice in one goal, a reinstatement missing, extra, counted after a revert or against the wrong agent. |
| AC-10 | Trigger: threshold 3; dismissals of distinct items raised by `alpha/auditor`@H: after the 2nd no calibration goal; the 3rd (stage record) opens exactly one goal with the documented owner, title, comment, `primaryRepo`, `preset.name`, `calibration` (3 refs, oldest first, `threshold: 3`), state `in_progress`, no design step, `<G>.calibrate` `ready`, no `refs.pulse`, shown in `GET /v1/goals`; event `calibration.opened` with exactly the documented payload, and the goal timeline text `opened calibration of alpha/auditor@<hash12> (3 dismissals)`; stats `calibrating: 3`, `uncalibrated: 0`, `calibration` = its id. A 4th and 5th dismissal open no second goal (`uncalibrated: 2`). A `mesh_dispose` dismissal counts like a stage one. A reverted dismissal is not counted, and the revert itself opens nothing: in a fresh hub with threshold 3, one `mesh_dispose` dismissal reverted (no event), then two more dismissals → no goal, `uncalibrated: 2`; a 4th → one goal whose `calibration` lists 3 refs, none of them the reverted one. Items raised by a person's interactive step and dismissed 3 times → no goal. A hash-less agent (its records' decider has no `hash`) whose items are dismissed 3 times → no goal, and its stats show one entry `hash: ""` with `uncalibrated: 3`. | World (hub API) | A goal opened early, late, twice, on a revert, for a hash-less agent or for a person-raised item, or a field, payload, text or count differs. |
| AC-11 | Calibrator order: a catalog definition `agents/rev`@H with source `calibrator: carol` → owner `carol` and repo = the source repo id; the same with `calibrator` naming no user → the pulse rule; a repo agent run by pulses of `ann` (older) and `bob` (newer) → `bob`; runs only in goals without `refs.pulse` → the owner of the goal of the newest dismissal. | World (hub API) | Another owner or repo. |
| AC-12 | Calibration input: `GET /v1/steps/<G>.calibrate/context` has one input `artifact: "calibration"` with the documented title and content (agent key/hash, `text` = the catalog text for a catalog agent and absent for a repo agent, each dismissal with reason, decider, via, item fields and evidence from its raising record) in order; a step with `inputs: [calibration]` in a goal without `calibration` gets no such input. | World (hub API) | A missing, extra or different field or order. |
| AC-13 | Done: the calibrator claims `<G>.calibrate`, submits a record with no items and `assessment: "clean"`, summary `no change: …`, then done → goal `done`; event `calibration.done` `{key, hash, dismissals: 3, outcome: "no-change"}`; stats `calibrated: 3`, `calibrating: 0`, no `calibration`. Goal timeline text `calibration of alpha/auditor@<hash12> done: no-change`. With 2 more uncalibrated dismissals and threshold 3, the next dismissal opens a new goal listing those 3; a goal done while `uncalibrated` ≥ threshold opens the next one at once. `assessment: "issues"` → `outcome: "change"`. Replan path: for an open calibration goal (3 listed dismissals) the calibrator proposes and approves a plan whose only step is `recheck` (`kind: review`, the goal's repo, `consumes: [open]`, `when: {open: true}`; its lineage has no items) → on approval settle marks `recheck` `skipped` and the goal `done` (event `goal.done`), `calibration.done` with `dismissals: 3`, `outcome: "none"`, its 3 dismissals `calibrated`. Listed dismissal reverted: in an open calibration goal listing 3 dismissals, one of them a `mesh_dispose` dismissal, that one reverted → no event, goal still open, stats `calibrating: 2`; done → `calibration.done` with `dismissals: 3`, stats `calibrated: 2`. | World (hub API) | A missing or wrong event, text, count or outcome, a done path that does not mark the dismissals calibrated, a reverted listed dismissal counted or changing the goal, or a next goal opened at the wrong time. |
| AC-14 | Web Roster metrics (as `frank`, after seeding through the hub API a reported repo copy `<repo>/scout` and one done headless round with telemetry `agentKey` `<repo>/scout` and a raising record): the group's `Stats` button shows `table.roster-stats` with a `tr[data-key][data-hash]` whose `td[data-col]` texts follow the documented formats (`runs` `1`, `cost` `$0.12` for 0.1234, `duration` `65.0s` for 65 000); a second click hides it; a group without activity shows `No runs or findings in the last 30 days.` | Playwright | A selector, text or format differs, or the table does not toggle. |
| AC-15 | Docs: concepts, how-to, install, mesh skill, plan API table and events list cover the Docs table; `MESH_SKILL` equals `skills/mesh/SKILL.md` and names the calibration step; no team-, company- or person-specific name is added to code or docs. | review + skill test | A missing section, row or mention, a mismatch, or a specific name. |
| AC-16 | `package.json` version `0.1.20`; `pnpm check` passes (lint, typecheck, boundaries, test, build); `pnpm test:web` passes after `pnpm build`; `schemas/hub-api.openapi.json` matches `pnpm schemas` and lists the stats route with its rule, scope and tag. | CI | Any check fails or the document differs. |
| AC-17 | Whole programme (one World test, fake `claude`, hub config `calibration.threshold: 2`, device tokens 60 days): owner `ann` with a runner machine (share `me`, accept `self`, remote-backed repo `alpha` with agents `auditor`, `checker`, `filer`) adds an every-7d pulse of the design §5.6 relay (preset text with `audit`, `validate`, `debrief` (`assignee: "@owner"`, `when: {open: true, min_severity: S2}`, consumes `[open, confirmed]`, may_set `[accepted, dismissed, deferred]`) and `file` (consumes `[accepted]`, `may_set: [accepted]`, `output: review-record`, `inputs: [dispositions]`), params `agent=auditor,validator=checker,filer=filer`). **Slot 1** fires G1 (no design step); `G1.audit` is offered to the runner and run headless; the run stores a `report` artifact and a complete record with A (S2) and B (S3); `G1.validate` runs on the runner and confirms A, dismisses B; `G1.debrief` is ready for `ann` only, never offered; `ann` accepts A with `mesh_dispose`, submits the debrief record and is done; `G1.file` is offered to the runner, runs (propose-via-branch) and records A `accepted` with a link; G1 `done`; no calibration goal (1 dismissal). **Slot 2** fires G2; the audit raises A, B and new C (S3) with B's evidence unchanged → fold `carried: 1`, B `dismissed`, A `accepted` with the link; `G2.validate` dismisses C → one calibration goal for `alpha/auditor`@<auditor hash> owned by `ann` listing B and C; `G2.debrief` and `G2.file` are `skipped` and the fake was never started for them; G2 `done`. Rounds of both audit runs (and of every step run) carry `telemetry`; `GET /v1/agents/alpha%2Fauditor/stats` has one hash with `runs: 2`, `raised: 5`, `new: 3`, `carried: 1`, `accepted: 1`, `dismissedByAgents: 2`, `dismissedByPeople: 0`, `calibrating: 2`, `calibration` = the goal; `alpha/checker` has `runs: 2`, `alpha/filer` `runs: 1`. | World + fake claude | Any step not run, run elsewhere, run twice or re-filed, a dismissal not carried, a link lost, a missing telemetry, a wrong stats value, or no / an early / a second calibration goal. |

## Open questions

- 2026-11-12 **Relay with a debrief in the whole-programme test.** Design §10 says the built-in
  `audit-relay`, which RL-3/RL-4 kept agent-only (no debrief). Assumed: the built-in stays unchanged;
  AC-17 uses the design §5.6 relay as the pulse's preset text (a repo preset, snapshotted per R-6),
  with `file` given `output: review-record` and `may_set: [accepted]` (as RL-3 did for the agent-only
  form) so the filer can record its link. A built-in relay with a debrief is left for a later row.
- 2026-11-12 **Filed items (fix 1).** Design §5.3 says an accepted item is "never re-filed", but with
  `file` consuming `[accepted]` every later slot would re-run the filer. Assumed: `accepted` with a
  `link` is filed and no longer consumed (`when`, `dispositions` input); the disposition checks are
  unchanged, so a filer that runs for another item may still restate a filed one.
- 2026-11-12 **Agreeing agent dispositions (fix 2).** RL-2 ignored every agent disposition of an fp a
  person decided in the goal, so the filer could not record its link after a debrief accepted the
  item. Assumed: an agent disposition with the same value as the person's latest decision in the goal
  is applied when the item's state is in the stage's `consumes`, else ignored as RL-2 (no 422), so the
  RL-2 check order and every record RL-2 accepted stay valid (revised after review round 1, B1);
  precedence compares with the latest person entry, not the latest entry.
- 2026-11-12 **What counts toward calibration.** Assumed: every non-reverted dismissal, by an agent or
  a person, counts against the agent of the raising record of that goal, once per
  `(goal, lineage, fp)` (the earliest such entry decides agent/person and time; added after review
  round 1); reverted `accepted` and person entries count toward nothing either; dismissals of items raised
  by a person's step never count; a person reinstating an agent's dismissal adds to the dismissing
  agent's `reinstated` but does not remove the dismissal from the raiser's count, and `reinstated` does
  not trigger calibration of the dismissing agent. Carried dismissals (fold) are not new dismissals.
- 2026-11-12 **Calibrator (design OQ-4 default).** Catalog source `calibrator`, else the owner of the
  most recent pulse that ran the agent key (any hash), else the owner of the goal of the newest
  dismissal. "Configured per repo" (design §5.8) has no setting yet; left for a later row.
- 2026-11-12 **The calibration step is a person's.** The design names "the agent's calibrator" without
  an agent to run; the `calibrate` preset has one interactive step owned by the calibrator's goal. Its
  record has no items (outcome from `assessment`); a change is the step's branch. The record folds into
  lineage `calibrate|<repo>|calibrate`, which nothing counts (person decider).
- 2026-11-12 **Calibrated means listed in a done goal.** No item or history row is written; a dropped
  calibration goal releases its dismissals (they count as uncalibrated again) but triggers nothing; the
  next dismissal or calibration done of that agent hash opens a new goal. Every `goal.done` path runs
  the done handling (a replan that drops the step gives `outcome: "none"`). A listed dismissal reverted
  while the goal is open leaves the goal and its list unchanged and counts in no bucket (added after
  review round 2, B1).
- 2026-11-12 **No calibrator.** Users are never removed today, so calibrator rule 3 always resolves.
  If none resolves, no goal and no event; the next trigger retries. No criterion (not reachable).
- 2026-11-12 **Reads for stats and the trigger.** No new `HubStore` methods (so no new store contract
  criterion): both scan with the existing reads, which are unfiltered across lineages. That is linear
  in the hub's review history per dismissal; acceptable at the current scale. Indexed queries by
  decider or telemetry key are left for a later row if it gets slow.
- 2026-11-12 **Threshold.** `calibration.threshold` ≥ 1, default 5; no way to switch calibration off
  (design: counting is always on, a pulse never needs a policy enabled). Agents above the threshold
  before v0.1.20 get a goal at their next dismissal.
- 2026-11-12 **Stats window and sources.** Runs from rounds (`finishedAt`), records from review
  records (`at`), dispositions from item history (`at`); events are not used (they are pruned).
  `uncalibrated`/`calibrating`/`calibrated` ignore the window. Agent key collisions (RL-5 open
  question) remain: two repos with the same last segment share stats; the hash tells them apart.
- 2026-11-12 **No stats CLI or TUI.** Design §6 lists no CLI for stats; the route and the web Roster
  page carry them. A `mesh agent stats` command is left for a later row.
- 2026-11-12 **Several replicas.** The trigger runs inside the goal transaction, so two replicas
  recording dismissals of one agent hash at once must still open one goal; criteria judge it on the
  SQLite leg; the Postgres legs of the store contract are not run locally (CI runs them).
