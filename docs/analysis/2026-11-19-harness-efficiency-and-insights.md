# Harness efficiency and insights: what mesh should measure and expose next

Date: 2026-11-19. Status: **analysis for discussion**, revised after a critique round (r2,
[§6](#6-critique-and-amendments-r2)); nothing is built by this document. Read §6 first: it corrects
two findings below and moves CI data out of the hub.
Code read at v0.1.29 (`71f3f3e`). Hub data read from one team hub at v0.1.28.

Evidence markers: **[data]** comes from the hub event log (`mesh ledger export --events`, 5 731
events, the 10 days 2026-11-09 to 2026-11-19). **[code]** was checked in source. **[inferred]** is my
own reasoning.

---

## TL;DR

1. mesh already **records** almost everything needed to judge how well a harness works: run
   telemetry (turns, cost, duration, exit, permission denials), review folds, dispositions, pulse
   slots, offers, waits, programme records. What it lacks is a **read model**. Every consumer that
   wants an answer like "how efficient were our audits this week" has to fetch events and re-join
   goals, steps, runs, reviews and artifacts itself. The fix is a small set of **roll-up endpoints**
   with stable schemas (I-1 to I-4), not new raw data.
2. The deployment that was read shows the problems that a health view should surface first:
   - **People are the bottleneck, not agents.** Agent stages are claimed in minutes, while 7 audit
     goals have waited **3.2 days** at an unclaimed debrief. Because a pulse skips a slot while its
     last goal runs, 5 slots of 5 pulses were **skipped (overlap)**. **[data]**
   - **Findings pile up.** Clean-audit goals hold 49 + 11 + 2 ready finding steps, and none has been
     claimed. 415 new items were raised and 15 resolved. **[data]**
   - **Waste is visible but not named.** 31 of 86 runs (36%) hit a permission denial, 122 in all,
     all `Bash`. 3 runs ended at `error_max_turns`. Every run carried 35 to 37 tools, including
     scheduling and workflow tools no audit uses. **[data]**
   - **Nobody checks the checkers.** All 499 item decisions were taken by agents; none by a person.
     Calibration exists for auditors; validators and filers are never sampled. **[data]**
   - **Metrics people want are stuck in prose.** CI audits report "38 re-runs, ~15 h" or "lane flakes
     reddened 7 gates (~3.5 h)" in item titles and reports. mesh cannot chart them. **[data]**
3. Recommended order: **I-1 run ledger and waste score**, **I-2 pulse health and run cards**, **I-3
   structured measures in review records** (the source for CI times and any numeric trend), **I-4
   flow and burn-down**, then the policies that act on them (**I-5 debrief SLA and overlap policy**,
   **I-6 profile fitting from denials**, **I-7 adaptive cadence**). Each is optional data or a
   read-only roll-up; none changes how a step runs unless a pulse opts in.

---

## 1. How mesh is used today **[data]**

One team hub, one owner, one runner machine, 10 days.

| What | Number |
|---|---|
| Pulses | 10, across 4 repos: code-quality, complexity, harness-efficiency and CI audits; 3 relay presets (`routine-audit`, `routine-ci`, the built-in `audit-relay`) |
| Pulse fires | 29, of which **26 manual** (`mesh pulse fire`) and 3 on schedule |
| Pulse goals | 29: 22 done, 7 open (all at an unclaimed `debrief`) |
| Headless runs | 86; models: 75 Opus, 11 Sonnet; 1 981 turns; estimated cost **$256.75** |
| Review records | 86; assessment `issues` 81, `clean` 5; coverage `complete` 77, `partial` 9 |
| Folds | new 415, repeat 114, carried 15, resolved 15, regression 6 |
| Dispositions | confirmed 344, accepted 78, dismissed 77; **all by agents** |
| Calibration goals | 4 opened (15, 14, 5 and 10 dismissals); all 4 `calibrate` steps unclaimed for 3.2 days |
| Clean-audit goals | 3 open (62 finding steps ready, 4 done, 0 claimed) |
| Programme records (`agent.finished`) | 3 512 over 8+ repos; no mesh view reads them |
| Configuration churn | 63 `pulse.updated`, 55 `profile.saved` in 10 days |

### 1.1 Per agent and stage

| Agent (stage) | Runs | Exits | Turns median / max | Minutes median | Cost (est.) | Denials |
|---|---|---|---|---|---|---|
| finding-validator (validate) | 29 | 26 ok, **3 max turns** | 26 / 49 | 1.8 | $30.81 | 41 |
| backlog-filer (file) | 11 | 11 ok | 16 / 68 | 0.6 | $2.53 | 16 |
| harness-efficiency (audit) | 11 | 11 ok | 8 / 32 | 2.0 | $67.65 | 39 |
| complexity-audit (audit) | 11 | 11 ok | 9 / 17 | 2.8 | **$98.00** | 0 |
| dataplane-ci (audit) | 9 | 9 ok | 19 / 25 | 1.4 | $7.85 | 10 |
| code-quality-audit (audit) | 7 | 7 ok | 83 / 102 | 6.9 | $32.77 | 4 |
| ci-finding-validator (validate) | 6 | 6 ok | 9 / 13 | 0.5 | $2.14 | 1 |

Readings **[inferred]**:
- complexity-audit costs about **$9 per run** with few turns: large context per turn, which is a
  prompt or input-size question, not a turn question. "Cost per accepted finding" would show whether
  that is worth it; today nobody can compute it without joining three sources.
- The validator is the agent with denials and max-turn exits. A validator should be the cheapest
  stage; it is the second most expensive in total.
- Agent stages wait seconds for a claim (median 0.0 h) and run in minutes; the **people steps wait
  days**. A dashboard that leads with run cost would point at the wrong problem.

### 1.2 What a consumer has to do today **[code]**

To show "the latest run of each pulse, with cost, findings and the report", a client calls
`/v1/pulses`, then per slot `/v1/goals/:id`, `/v1/goals/:id/artifacts`, `/v1/artifacts/:id`,
`/v1/items?lineage=`, and reads `run.finished` from `/v1/events` for telemetry, which is not on the
goal. That is about five calls per run and a join in the client. `/v1/agents/:key/stats` is the only
roll-up, and it is per agent, not per pulse, repo, topic or team. `/healthz` returns `{ok:true}`
without a version.

---

## 2. What "efficient" should mean

Five questions, each with metrics that can be computed from data mesh already holds (or one small
addition, marked).

| Question | Metric | Source |
|---|---|---|
| **Is the harness wasting work?** | wasted turns (§2.1), denial rate, max-turn and crash exits, `turnsApprox` share, tool surface vs tools used (addition: tools used) | `run.finished` |
| **Is scheduled work happening?** | on-time slots / due slots, skipped and missed by reason, manual vs scheduled fires, open goals per pulse and their age | `pulse.*`, `goal.*` |
| **Is the signal good?** | confirm / accept / dismiss rates per agent and hash, reinstated rate, novelty (new / raised), repeat rate, clean runs, coverage `partial` share | `review.recorded`, `item.disposed`, agent stats |
| **Does work get finished?** | goal lead time, clean-audit burn-down, finding age by severity, finding-to-fix time, resolved / new ratio, fix cycles | `goal.*`, `step.*`, folds |
| **Where do people slow it down?** | wait on people by step kind (debrief, gate, calibrate, design), debrief age, questions open, human-decision share | `step.ready` → `step.claimed`, `question.*`, `item.disposed.decider` |

And one value metric that ties them together: **cost per accepted finding** (and per fixed finding),
per agent hash, per pulse.

### 2.1 A definition of wasted turns

"Wasted" must be computed the same way everywhere, so the hub should define it **[inferred]**:

| Component | Rule |
|---|---|
| Failed-run turns | all turns of a run whose `exit` is not `success` and whose round was retried or the step failed |
| Denial turns | one turn per permission denial (each denial costs at least the call and the reaction) |
| Budget overrun | turns past the preset's `turns` budget (the run is killed there; the whole round is waste if no result) |
| Empty audit turns | turns of an audit whose items were all dismissed (the run produced no value) |
| Re-raise turns | an estimate: share of a raising run's items that were `repeat` of a dismissed item |

Report it as `wastedTurns` and `wasteRatio = wastedTurns / turns`, per run and rolled up. Keep the
components so a reader sees *why*.

---

## 3. Proposals

Each proposal is generic: no team, product or tool name. Effort: S (≤ 2 days), M (≤ 1 week),
L (> 1 week).

### I-1 Run ledger and waste score (S, MUST)

- `GET /v1/runs?since=&pulse=&repo=&agent=&goal=&limit=`: one row per headless run with the step,
  goal, pulse and slot it belongs to, the full telemetry, `wastedTurns` with its components, the
  review fold counts of the round, and the artifact ids of the round. One call replaces the event
  scan.
- Add to the run's telemetry (daemon, from the stream it already parses): **`toolsUsed`** (distinct
  tool names called) next to the existing `tools` (offered). The gap is the surface to trim.
- Add **`denials[]`** detail, redacted to the first word of a `Bash` command (`git`, `cargo`,
  `make`) plus the tool name. Today only the tool name and count are kept, which says "Bash was
  denied" but not what to allow.

### I-2 Pulse health and run cards (M, MUST)

- `GET /v1/pulses/:id/runs?limit=`: one **run card** per slot: slot time, fired / skipped / missed
  with reason, goal and state, per stage (state, holder, wait, minutes, turns, cost, exit), folds
  (new / repeat / regression / resolved), dispositions, the **report artifact id** and the clean-audit
  goal the run sank into. Plus `delta` against the previous complete run (cost, turns, new items,
  regressions).
- `GET /v1/health?days=7&repo=&topic=`: a scorecard per pulse and a team total:
  `slotsDue`, `slotsOnTime`, `skipped`, `missed` (by reason), `blockedBy` (the open step that holds
  the pulse, with its age), runs, cost, `wasteRatio`, `acceptedPerRun`, `costPerAccepted`,
  `openDebriefs`, `openCalibrations`, findings open by severity. **One call gives the overview
  page.**
- Both answer for a service token with `goals:read`, so any dashboard can show them.
- `/healthz` returns `{ok, version, schema}` so a client knows which shapes to expect.

### I-3 Structured measures in review records (M, MUST)

Audits already measure things (CI minutes, re-run counts, flake counts, function complexity,
coverage) and write them as prose. Add an optional **`measures`** list to a review record:

```yaml
measures:
  - key: ci.pipeline.duration.p50   # dotted, declared like rules
    value: 23.4
    unit: min                       # min, s, count, ratio, usd, …
    scope: develop                  # optional: branch, job, path
    window: 7d                      # optional: what the value covers
```

- Keys are declared in the agent's front matter (like `mesh-rules`), so an undeclared key is
  reported, as `undeclaredRules` is today.
- The hub stores them per lineage (pulse / repo / agent) and compares them run to run, like folds:
  `delta`, and a **regression** when a key moves past a threshold declared with the key
  (`worse: up|down`, `threshold: 15%`). A measure regression can raise an item, so it flows into
  the clean-audit goal like any finding.
- `GET /v1/measures?key=&repo=&since=` returns the series. This is how **CI times**, **flake
  rate** or **complexity hotspots** become charts without a second ingestion path.

### I-4 Flow and burn-down (M, SHOULD)

- `GET /v1/flow?topic=&repo=&days=`: per clean-audit goal and severity: open, added, resolved
  (by audit), fixed (by step), dropped, **age** percentiles, and daily points for a burn-down.
- Finding-to-fix time per severity: from the item's first `new` fold to the step's `done` or the
  item's `resolved` fold.
- Goal completion for every goal, not only pulse goals: steps done / total, lead time, time in
  each state, and the share of that time spent waiting on people.

### I-5 Debrief SLA and overlap policy (M, SHOULD)

The data shows the main loss is a person-step left open, which then silences the schedule.

- A pulse option `overlap: skip | queue | supersede` (default `skip`, today's behaviour).
  `supersede` drops the waiting goal when the next slot fires; the new audit's fold carries the
  open items forward (`carried`), so nothing is lost and the debrief covers both runs.
- A per-preset `debrief.sla` (e.g. `48h`): past it the hub raises an attention item for the
  assignee, then for the pulse owner, and the health scorecard shows `blockedBy`.
- An optional **auto-file after SLA** for items an agent validator confirmed at S3 or S4, so low
  severity items never wait on a person; S1 and S2 always wait.

### I-6 Profile fitting from denials and tool use (S, SHOULD)

- `mesh profile fit <name> --days 14`: reads the runs that used the profile, lists the denied
  command words and the offered-but-unused tools, and prints a proposed profile diff (allow `cargo
  test`, drop `CronCreate`). The person saves it; the change shows up as a `profile.saved` with a
  new hash, and I-8 compares before and after.

### I-7 Adaptive cadence (S, COULD)

- A pulse option `cadence: adaptive` with bounds (`min: 1d`, `max: 14d`): after N runs with no
  new accepted item and no measure regression, the interval doubles (up to `max`); a regression
  or a new S1/S2 item halves it. Each change is a `pulse.updated` with `via: cadence`. Quiet
  repos stop paying for empty audits; noisy ones get looked at more.

### I-8 Change markers and before/after (M, SHOULD)

- Every run already carries `agentHash`, `profileHash`, the preset hash and (for sessions) the
  harness hash. Add a **change timeline**: `GET /v1/changes?repo=&agent=` listing when each hash
  first appeared, with the event that introduced it.
- `GET /v1/agents/:key/compare?from=<hash>&to=<hash>`: the I-1/I-2 metrics for the runs of each
  hash, side by side, with the run counts so small samples are visible. This answers "did that
  agent edit help?" without a spreadsheet.

### I-9 Checking the checkers (S, SHOULD)

- Spot checks: for each agent hash that decides items (validators, filers), the hub samples a
  small share of its decisions (`sample: 5%`, at least 1 per week) into a debrief-like step for a
  person. A disagreement counts like a dismissal, so the existing calibration machinery covers
  validators too.
- Health shows `humanDecisionShare`. A value of 0, as today, is a warning, not a goal.

### I-10 Trial runs stay out of the statistics (S, SHOULD)

26 of 29 fires were manual, mostly while the agents were being tuned. Add `mesh pulse fire
--trial` (payload `trial: true` on `pulse.fired` and the goal): trial goals are shown, but excluded
from health, stats and calibration counts by default (`?trial=include` to add them).

### I-11 Links and reports index (S, SHOULD)

- Every roll-up row carries `links` (`goal`, `step`, `run`, `report`, `pulse`, `item`) as hub
  paths, so a client never builds URLs.
- `GET /v1/reports?repo=&topic=&latest=1`: the newest report artifact per pulse (or repo and
  topic), with its run card id. "Show me the latest audit of each repo" is then one call.

### I-12 Change hints with a subject (S, COULD)

The stream's change hint carries only a sequence number, so a client refetches everything on each
hint. Add the subject (`goal`, `pulse`, `step`) and the event type, so a page refreshes only what
changed.

### I-13 Programme analytics (M, COULD)

Programme records (`agent.finished`) are the biggest data set in the hub (3 512 in 10 days) and
nothing in mesh reads them. A roll-up per role and model: count, duration percentiles, result
fields (verdict distribution where the typed result has one). Same endpoint shape as I-1.

### I-15 Time per session state and a goal efficiency card (M, SHOULD)

"Time spent waiting on a person" is the number an owner asks for first, and mesh does not keep it.
The daemon already knows each session's state (`working`, `needs_you`, `stalled`, `idle`) and
syncs `session.waiting` / `session.turn_*` for sessions that hold a step.
- Accumulate **seconds per state** per session and per step, and sync the totals with the step
  (no new event per transition).
- Roll it up into an **efficiency card per goal** (and per step): turns, wall time, active time,
  people-wait time, cost, fix cycles and reopens, parks and take-overs, **first-try pass** (done
  with no reopen). The goal roll-up in the ledger already has most of these at the end; the card
  makes them live and readable while the goal runs.
- A **stuck signal** per repo: a session `needs_you` longer than a threshold, or a step with many
  turns and no commit on its branch.

### I-16 One verdict vocabulary everywhere (S, SHOULD)

Step records already type `verdict` (`approved`, `changes_requested`, `blocked`, `pass`, `fail`)
**[code]**. Programme records keep the subagent's typed result as free scalars, so consumers map
`PASS`, `Pass`, `APPROVED` themselves. Normalise `result.verdict` to the same enum when it matches
(keep the raw value next to it), and report the share that did not match.

### I-17 Links to the outside: commits, merge requests, external rows (S, SHOULD)

- `mesh_done` takes `mr` today; add the **head commit** of the step's branch per round, so a run,
  a fix step and a CI result can be joined by commit, not by repo name and time window.
- Goals carry `refs` (`spec=`, `backlog=`). Allow `refs` on **steps** too, set by a plan or by the
  session (`mesh_note` with a ref), so a step can name the external row or programme that worked
  on it.
- With I-3, a CI audit can put the commit in a measure's `scope`, which ties pipeline times to the
  step that pushed.

### I-18 Pushed roll-ups and a read scope for events (S, COULD)

- A `metrics.rollup` event every N minutes (window, scope, the I-2 scorecard numbers), so a
  consumer that already folds events gets the numbers without polling roll-up endpoints.
- An explicit `events:read` service scope, instead of the implicit rule that lets any service
  token page `/v1/events`.

### I-19 One person id (S, COULD)

A person shows up as a hub user, a git author and an SSO subject. `GET /v1/people` (admin or a
service scope) returning the hub user with its known git author emails (from the commits the
daemon records) and its SSO subject removes the mapping every consumer writes.

### I-14 Outside the box **[inferred]**

- **mesh audits itself.** A built-in preset `harness-health` that reads `/v1/health` and
  `/v1/runs` (no repo access) and files findings such as "validator X: 3 max-turn exits this week"
  or "pulse p blocked 3 days by its debrief" into a clean-audit goal of the hub's own topic. The
  harness's own inefficiency becomes workable steps, through the same flow as any audit.
- **A weekly digest artifact.** The hub writes one Markdown report per team (or topic) each week:
  the scorecard, the top regressions, the oldest waiting steps, cost per accepted finding. It is
  an artifact, so any client links to it, and it is the "latest pulses" report in one place.
- **Prometheus / OpenMetrics `/metrics`.** Gauges for the I-2 scorecard (slots, waits, waste,
  cost) so an existing Grafana can alert on "a pulse blocked for 48 h" with no new UI.
- **Budget guard.** A per-pulse rolling cost cap (`budget: {usd: 50, per: 7d}`): past it, slots
  are skipped with reason `budget` and the owner is told.
- **Fix steps for agents.** Finding steps of S3/S4 that carry a concrete proposal can be offered
  to a runner as headless `implement` steps (with a fix profile and a review gate). The 49 ready
  steps of one goal are mostly mechanical; today they wait for a person to start a session.

---

## 4. Priorities

| # | Proposal | Effort | Priority | Unblocks |
|---|---|---|---|---|
| I-1 | Run ledger, waste score, tools used, denial detail | S | MUST | every efficiency view; I-6 |
| I-2 | Pulse run cards, health scorecard, versioned `/healthz` | M | MUST | an overview page in one call |
| I-3 | Structured measures with run-to-run regression | M | MUST | CI times and any numeric trend |
| I-4 | Flow and burn-down | M | SHOULD | goal completion and finding age |
| I-5 | Debrief SLA and overlap policy | M | SHOULD | pulses no longer silenced by a person-step |
| I-8 | Change markers and before/after | M | SHOULD | "did that change help?" |
| I-9 | Spot checks for deciding agents | S | SHOULD | trust in agent-only decisions |
| I-10 | Trial fires | S | SHOULD | clean statistics |
| I-11 | Links and reports index | S | SHOULD | latest reports in one call |
| I-15 | Time per session state, goal efficiency card, stuck signal | M | SHOULD | "waiting on a person" time |
| I-16 | One verdict vocabulary | S | SHOULD | no client-side normalising |
| I-17 | Commit per round, refs on steps | S | SHOULD | joins without time windows |
| I-6 | Profile fitting | S | SHOULD | fewer denials |
| I-7 | Adaptive cadence | S | COULD | less cost on quiet repos |
| I-12 | Change hints with a subject | S | COULD | cheaper live pages |
| I-13 | Programme analytics | M | COULD | use of the largest data set |
| I-18 | Pushed roll-ups, `events:read` scope | S | COULD | consumers fold instead of polling |
| I-19 | One person id | S | COULD | no identity mapping in clients |
| I-14 | Self-audit, digest, `/metrics`, budget guard, agent fix steps | S–M each | COULD | — |

A first release (I-1, I-2, I-10, I-11) is about one week and needs no schema change in agents or
presets. I-3 needs agents to emit measures, so it should ship with one reference agent and preset.

## 5. Decisions for the owner

1. Is a hub-computed **waste score** wanted, with the components of §2.1, or only the raw numbers?
2. `overlap: supersede` and **auto-file after SLA** change outcomes, not only views. Opt-in per
   pulse (recommended) or a team default?
3. Should denial detail keep the **first word** of a denied `Bash` command (recommended), or only
   the tool name as today? The first word can name an internal tool.
4. Spot checks add person-steps. Which sample rate, and is it per agent hash or per pulse?
5. Measures: free keys declared per agent (recommended), or a fixed catalogue in mesh?
   *(r2: see §6.3; measures are no longer the path for CI data.)*

---

## 6. Critique and amendments (r2)

A second pass over this document, plus a look at the CI and code-quality data the team already
collects outside mesh. Read live on 2026-11-19 with read-only credentials: the CI server's API (14
days of pipelines of the 4 audited repos, about 4 000 pipelines), its Prometheus (365 days
retention) and the analysis server's API. The dashboards were read from their provisioned
definitions.

### 6.1 What the first pass got wrong or overstated

| # | Claim in §1–§3 | Correction |
|---|---|---|
| C-1 | "People are the bottleneck": 7 goals waited 3.2 days at a debrief and silenced 4 pulses. | All 7 goals came from **manual trial fires** on the same day, while the agents were being tuned. They are trial goals nobody meant to debrief, not production work waiting on a person. The real finding is **trial hygiene**: a trial goal left open silences the schedule. I-10 (trial fires) moves to MUST, and I-5 needs `supersede` mainly for this case. The "0 of 499 decisions by a person" stands, but with no production debrief run yet it shows the process has not been exercised, not that people are slow. |
| C-2 | "Findings pile up: 0 of 62 finding steps claimed". | The clean-audit goals were created 2 days before the read. Too early for a burn-down conclusion. Keep I-4, drop the claim. |
| C-3 | complexity-audit "costs about $9 per run … large context per turn". | Wrong cause. Runs with 2 turns and no output tokens still cost $2–4, and one 8-turn run cost $24.71 on 2.1 M cache-read tokens. The cost comes from **subagents** the audit starts (Task, Workflow), which the parent run's token fields do not show. New I-22. |
| C-4 | Denials are counted as waste. | A denial can be the profile doing its job. A denied command costs one short turn, not a run. Count denials and show them next to the profile, but keep them out of a waste figure unless the same command is denied in most runs (then it is a profile gap). |
| C-5 | A hub-computed `wasteRatio` (§2.1). | The components are judgement calls (an audit whose items were all dismissed may still have been worth running). Expose the **raw components** per run; let each consumer weigh them. No composite score in the hub. |
| C-6 | I-3: CI times as `measures` that audit agents write. | A number that an agent reads from a CI system and retypes is a worse copy of a number a script can read directly. CI and code-quality numbers have **deterministic sources** (§6.2). The hub should not hold a second copy; it should make the **join** possible (§6.3). |
| C-7 | 19 proposals and about 10 new endpoints. | Too many to act on. §6.4 cuts the core to three read endpoints and two telemetry fields. |

### 6.2 External data that already exists

| Source | What it holds (verified) | Gaps for our questions |
|---|---|---|
| CI server API (GitLab, GraphQL) | every pipeline: ref, **commit**, source (push, merge request, schedule), status, duration, queued time, retried jobs; one paged query per repo | nothing aggregates it; one repo produced 3 100 pipelines in 14 days, so reads must be windowed |
| CI pipelines exporter → Prometheus | 37 projects, 62 branch refs: last pipeline status, id, duration, queued time, run count; 943 job series (status, duration, queued time, artifact size); 365 days retention | gauges hold the **last** pipeline per ref; **no commit** label; branch pipelines only |
| CI test collector → Prometheus | per develop pipeline of seven repos: job, section and test durations | covers develop only |
| Static analysis server (SonarQube) | 12 projects including 3 of the 4 audited repos, analysed on every push; gate, coverage, complexity, cognitive complexity, code smells, debt, duplication; per-file measures through its API | the 4th audited repo is not analysed |
| CI dashboards (Grafana) | four boards: overview (failing / passing, latest per branch, failed jobs), **timing** (per-run time, job time against its 14-day median, queued time, stage breakdown, **regressions: last 3 runs over 1.3× median**, an alert `CIJobSlowerThanMedian`, before/after 7 days, slowest tests, **flaky tests and jobs**), runners, analysis server | read by people; no harness data on them |

What the data says about the audited repos (14 days):

| | Repo A | Repo B | Repo C | Repo D |
|---|---|---|---|---|
| Pipelines (of them skipped) | 3 114 (809) | 533 (294) | 282 (137) | 77 (77) |
| CI hours | 260 | 22 | 77 | 0 |
| Successful pipeline, p50 / p90 | 5.2 / 14.9 min | 6.9 / 11.0 min | 50.7 / 104.9 min | — |
| Failed, share of finished | 55% (develop 47%) | 10% (develop 9%) | 41% (develop 34%) | — |
| Develop re-runs of a commit already green on its branch | **58, 15.3 h** | 2, 0.1 h | 0 | — |
| Analysis gate | `ERROR`: 423 new violations | `ERROR`: new coverage 72.9% < 80%, 16 new violations | `ERROR`: new coverage 71.7% < 80%, 11 new violations | not analysed |

Queue time is negligible everywhere (p90 ≤ 0.3 min); runner capacity is not the problem.

**One p50 per repo hides the profiles.** A repo runs several pipeline profiles: a pipeline where no
job ran (`[skip ci]` or rules), a fast check profile, an integration profile, a lab or end-to-end
profile, a nightly schedule. Their times differ by two orders of magnitude, so CI time must be
reported **per profile**: the source (push, merge request, schedule) plus the set of stages that
ran, and per job family (shard suffixes folded). From the same 14 days (p50 / p95 of successful
pipelines; "Failed" is FAILED / (SUCCESS + FAILED), cancelled pipelines left out; see the caveat
below the tables):

| Repo | Profile (source: stages) | Pipelines | p50 / p95 | Failed | CI hours |
|---|---|---|---|---|---|
| all | no job ran (`[skip ci]`, rules) | 811 / 294 / 137 | 0 s (no duration recorded) | — | 0 |
| A | push: check | 1 664 | 4.2 / 14.6 min | 55% | **161.6** |
| A | push: check + lab | 299 | 18.6 / 60.2 min | 88% (but 241 of 299 cancelled) | 22.1 |
| A | push: check + infra + integration + lab + publish | 114 | 13.3 / 26.0 min | 27% | 28.4 |
| A | merge request: check + integration | 29 | 6.3 / 17.3 min | 24% | 3.4 |
| A | schedule: check + infra + integration + lab | 18 | 31.4 / 32.8 min | 73% | 9.5 |
| A | schedule: check + infra + lab | 5 | 91.3 / 91.7 min | 100% | 6.3 |
| B | push: check + conformance + consumer + test + verify-images | 84 | 8.2 / 13.4 min | 0% | 12.4 |
| B | push: check + consumer + test | 59 | 1.4 / 9.4 min | **100%** | 2.6 |
| B | merge request: check + conformance + consumer + test | 18 | 7.4 / 16.0 min | 0% | 2.3 |
| C | push: check + integration + unit-test | 62 | 54.9 / 104.9 min | 15% | 35.1 |
| C | schedule: check + integration + report + unit-test | 9 | **230.8 / 236.4 min** | 56% | 32.8 |
| C | push: check (+ unit-test) | 48 | 0.9–1.2 / 1–4 min | 22–60% | 1.0 |

Job families that carry the time (share of all job time in the repo):

| Repo | Stage / job family | Runs | p50 / p95 | Failed | Share |
|---|---|---|---|---|---|
| A | check / check | 2 240 | 5.7 / 13.5 min | 45% | 28% |
| A | check / unit-hermetic | 2 238 | 0.7 / 10.9 min | 19% | 21% |
| A | check / unit | 2 240 | 2.4 / 9.5 min | 8% | 18% |
| A | infra / sharded end-to-end lane (5 shards) | 1 050 | 0.4 / 12.5 min | 0% | 13% |
| A | lab / formal (full) | 45 | 26.5 / 32.8 min | 10% | 4% |
| B | consumer / consumer-build | 189 | 5.4 / 11.8 min | 1% | 25% |
| B | test / coverage, unit-tests | 274 | 3.2–3.6 / 8 min | 0% | 27% |
| B | conformance / per OVS version | 265 | 1.5 / 1.7 min | 0–1% (23 retries) | 11% |
| C | integration / local-behavior | 47 | 91.6 / 102.8 min | 12% | **47%** |
| C | integration / coverage (nightly) | 9 | 118.2 / 119.6 min | 0% | 20% |
| C | integration / local-behavior on develop | 16 | 51.8 / 54.9 min | 12% | 17% |

Readings: in repo A the fast check profile fails in more than half the runs that finish (822 failed,
670 passed, 172 cancelled) and uses 62% of the repo's CI hours, which is mainly a pre-push problem,
not a slow-test one. The lab profile is mostly **cancelled** (241 of 299, presumably superseded by a
newer push), not failing: counted over all finished pipelines it fails 17%. In repo C one integration job is half of all CI time. A dashboard that shows one p50 per
repo shows none of this. The profile key (source + stages) and the job family are the two
dimensions any CI-time view needs, and `[skip ci]` pipelines must be counted apart and kept out of
the percentiles.

**Caveat on these tables (found when the numbers were reproduced independently).** The window here
runs from 2026-11-05 to the read time (2026-11-19 about 21:00 UTC), and "Failed" leaves cancelled
pipelines out, which overstates failure where many pipelines are cancelled. Percentiles use a floor
index over successful runs, and some classes are small: repo C's integration profile has 18 to 23
successful runs, and its p50 moves from 55 to 91 minutes when the window ends a day earlier. A CI
view should therefore use a closed window, split outcomes three ways (success, failed, cancelled),
show `n` with each percentile and suppress percentiles below a minimum sample, and keep pipelines
that failed with no job (configuration errors) apart from `[skip ci]`.

**C-8 The CI audit was right, at a price.** Its finding "38 develop re-runs of branch-green commits
(~15 h)" matches the query above (58 re-runs, 15.3 h over a longer window). A paged query computes
it in seconds. The agent spent turns on arithmetic a script does exactly, and the dashboards already
show slow-job regressions and flaky jobs the agent would otherwise have to derive. This is the case
for I-20.

### 6.3 Where each kind of data should live

- **The hub owns harness-native facts:** runs, steps, rounds, pulses, slots, findings, dispositions,
  waits, session states. Only it can produce them.
- **External signals stay where they are** (the CI server, the exporter in Prometheus, the analysis
  server), and a consumer joins them with hub data. The hub's job is to make the join **exact**:
  - the **head commit per round** (I-17) is promoted to MUST. With it, "pipelines run on commits
    made by mesh steps", "CI minutes per goal" and "red pipelines after an agent change" are a join on
    the commit, not a guess by repo and time window;
  - a run row (I-1) carries `repo`, `branch` and `commit` so it lines up with pipelines.
- **I-3 is narrowed:** `measures` stay possible for numbers that only the audit can produce (for
  example "functions over the complexity threshold" counted by the agent's own tool), declared and
  compared like rules. They are no longer the route for CI or analysis-server numbers. Priority:
  COULD.
- **One board for both:** the hub's `/metrics` endpoint (I-14) moves to SHOULD. Scraped by the same
  Prometheus as CI and analysis data, a dashboard can put harness runs, waits and cost next to
  pipeline times and quality gates with no new UI.

### 6.4 New proposals

**I-20 Deterministic inputs for audits (M, SHOULD).** A preset step may declare `inputs:`, commands
the daemon runs before the agent starts (in the run's worktree, under the same profile), whose output
is attached as an artifact and named in the agent's context. A CI audit then starts from a computed
digest (pipelines per commit, re-runs of green commits, retried jobs, duration percentiles) and a
quality audit from the analysis server's measures. The agent interprets; it does not count. Fewer
turns, and the numbers in the report are the script's, not the model's.

**I-21 Pulses triggered by an external change (M, COULD).** Besides a schedule, a pulse may fire on
a signal: `POST /v1/pulses/:id/signal` with a reason (for example a quality gate turning `ERROR`, or
the default branch's pipeline failing three times). The hub applies the pulse's overlap rule, and the
slot records the reason. With I-7 this replaces "run weekly whatever happens" with "run when
something changed".

**I-22 Subagent cost in run telemetry (S, MUST).** A run's `turns`, tokens and cost must include the
subagents it started, with a breakdown (`subagents: {count, tokens, costUsdEstimate}`). Without it,
the most expensive audits look cheap per turn and "cost per agent" is wrong.

### 6.5 Revised core

| Order | Item | Why first |
|---|---|---|
| 1 | I-10 trial fires (MUST) | the open trial goals are what silences the schedule today |
| 2 | I-22 subagent cost (MUST) and I-1 run rows with raw waste components, `toolsUsed`, denial detail, `commit` (MUST) | every efficiency number depends on them |
| 3 | I-17 head commit per round (MUST) | the exact join to CI and analysis data |
| 4 | I-2 pulse run cards and health, versioned `/healthz` (MUST) | the overview in one call |
| 5 | I-14 `/metrics` (SHOULD) | harness next to CI in an existing dashboard |
| 6 | I-20 deterministic audit inputs (SHOULD) | cheaper audits with exact numbers |
| 7 | I-5, I-6, I-8, I-9, I-15 (SHOULD) | policies and comparisons once the data is right |
| later | I-3 (narrowed), I-4, I-7, I-11–I-13, I-16, I-18, I-19, I-21 (COULD) | — |

A composite waste score, CI measures in review records, and a CI copy in the hub are dropped.
