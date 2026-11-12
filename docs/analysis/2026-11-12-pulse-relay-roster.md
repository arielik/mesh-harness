# Pulse, Relay, Roster: scheduled agent work, reviewed by pipelines of agents and people

Status: revision 2 (2026-11-12), after cold review r1
([`reviews/2026-11-12-pulse-relay-roster-review-r1.md`](reviews/2026-11-12-pulse-relay-roster-review-r1.md),
26 findings; how each was handled: §11). Builds on v0.1.14 (goals, steps, presets, offers, labels,
My mesh).

## 0. Summary

mesh-harness coordinates goals and steps across people and their Claude Code sessions. This design adds
recurring agent work and the review of what it produces. Execution reuses goals and steps; the one new
lifecycle is the **item** (a finding in a review record), which is recorded, never executed.

- **Headless step**: a step a machine runs as `claude -p` with a pinned permission profile and budget,
  reporting through the mesh MCP tools, with telemetry.
- **Artifact**: hub-stored output of a round (report, review record, transcript).
- **Review record**: the schema-checked output of a review stage; the hub folds it with earlier records
  of the same **lineage** (new / repeat / regression / resolved) and carries dismissals forward.
- **Relay**: a preset whose stages run, validate, debrief and file; stages are conditional and may be
  agent-only. **Debrief** is a step a named person runs with an interactive Claude session.
- **Pulse**: a hub schedule that, at each slot, creates a goal from a preset snapshot with an approved
  plan and offers its run step to a machine that can run it now.
- **Roster**: agents of every repo and of catalog repos, by source and hash, installable into other
  repos by pinned reference.
- Project rules: structured output and telemetry for every run and review (R-2); every dismissal has a
  reason and decider and is counted against the agent that raised the item, and enough of them open a
  calibration goal (R-3).

## 1. Problem

1. Recurring agent work (weekly audits, nightly CI triage) runs from personal crontabs (mesh-ai
   `meshctl routine run`). The prompt carries the protocol: a "routine contract" that fingerprints by
   hand, calls `meshctl` in order and polls `ops status` with `sleep 10` (vpc-node-agent
   `.claude/agents/code-quality-audit.md`); a 27-rule allowlist per routine
   (`.claude/routines/cron/*.json`). Missed runs are invisible.
2. Agents are copied: 311 files under `~/vpc-devel/*/.claude/agents`, mostly the same roles
   (`doc-writer` ×23, `reviewer` ×21, `backlog-curator` ×18), drifted. No view says what an agent does
   or which copy is current.
3. Agent output (reports, later PRs) has no review path: who validates, who dismisses, what a repeat
   finding means, whether a dismissed finding comes back.
4. Nothing measures agents (accept/dismiss rates, cost, duration), so no data says which earn a
   schedule.

## 2. Requirements

- **REQ-1** A recurring job is a goal created from a preset snapshot by a schedule on the hub.
- **REQ-2** Every slot of a pulse is recorded as fired, skipped, missed or abandoned, with a reason;
  missed and abandoned are visible on the owner's Mine page and in the TUI, including slots missed
  while the hub was down.
- **REQ-3** A step can run an agent headless with a pinned permission profile and a budget, on an online
  machine that holds the repo and matches the pulse's labels.
- **REQ-4** Non-repo outputs are stored on the hub as artifacts attached to the producing round, after
  a secret-redaction pass on the machine. Artifacts are visible to every hub member (as goals are);
  their content never enters events or ledger exports.
- **REQ-5** A step with `output: review-record` closes `done` when, and only when, it submits a
  schema-valid review record; the record's verdict about the subject never fails the step.
- **REQ-6** The hub folds a complete record against the last complete record of its lineage (§5.3) and
  carries a dismissal forward when the evidence hash is unchanged.
- **REQ-7** Relays can be agent-only, person-only or mixed; a stage can be skipped by a condition on the
  item states, and a skipped stage is re-evaluated when its inputs change.
- **REQ-8** A debrief is claimable only by its assignee, presents items one at a time, and records each
  disposition with reason and decider (`via` debrief session).
- **REQ-9** Every dismissal has a reason and a decider and is counted against the raising agent's hash;
  when an agent hash reaches the threshold of uncalibrated dismissals, the hub opens a calibration goal.
- **REQ-10** Every headless run records telemetry (§5.9), complete when the CLI reports a result and
  partial (with exit reason) when it does not.
- **REQ-11** The roster lists agents of the repos in a machine's inventory (under its share level) and
  of registered catalog sources, with source, name, description, model, tools, declared rules and hash.
- **REQ-12** Installing a roster agent writes the file unchanged and records the pin (source, commit,
  hash) in `.mesh/agents.lock`; the harness reports copies that differ from their pin or whose source
  moved on.
- **REQ-13** The hub never clones repositories or runs agents.
- **REQ-14** Nothing team- or company-specific in the harness.

Non-goals now: PR intake (the ingest route of §5.5 is the hook), what a filer writes, artifact ACLs
(OQ-3), OS-level sandboxing (a later runner label, §7).

## 3. Terms

| Term | Meaning |
|---|---|
| **Headless step** | A step with `mode: headless`, run by a machine as a non-interactive Claude Code process. |
| **Profile** | A named permission set, snapshotted by hash where it is used. |
| **Artifact** | Hub-stored content attached to a round: `report`, `review`, `transcript`. |
| **Review record** | The structured output of a review stage (§5.3). |
| **Item** | An entry of a review record, identified by its fingerprint. |
| **Lineage** | `(preset name, subject repo, raising agent name)`: the series records are compared within. |
| **Disposition** | A decision on an item: `confirmed`, `dismissed`, `deferred`, `accepted`, with reason and decider. |
| **Relay** | A preset whose stages review a run's record. |
| **Debrief** | A step mode: the assignee and an interactive Claude session go through the items. |
| **Pulse** | A schedule firing a preset snapshot at slots. |
| **Slot** | One due time of a pulse (or `manual:<ulid>`), unique per pulse. |
| **Roster** | The hub's list of agent definitions. |
| **Agent key** | `<source repo>/<name>`; `@<hash>` names one exact definition. |
| **Catalog source** | A registered repo whose agent folder is offered for install (e.g. a repo with only `agents/`). |

## 4. Principles (project rules)

- **R-1 Goals and steps for execution; items are records.** Everything that runs is a step of a goal
  created from a preset. Items have their own disposition lifecycle (§5.3, a table, not code paths),
  and are never executed.
- **R-2 Structured output and telemetry, always.** No step mode ships without its telemetry fields; no
  review stage is accepted without a schema-valid record; free text is attached, never parsed.
- **R-3 Dismissals are evidence.** Each has a reason and a decider and counts against the raising
  agent's hash; a threshold opens a calibration goal. Person decisions outrank agent decisions.
- **R-4 References, not copies.** Agents install by pinned reference; drift is reported.
- **R-5 Generic core.** The harness ships mechanisms, built-in profiles and presets, and the debrief
  skill; domain content is repo files.
- **R-6 Snapshots at the trust boundary.** What a slot runs (preset text, profile, agent definition) is
  pinned by hash when the pulse is created or updated, never read from the subject repo at run time.

## 5. Detailed design

### 5.1 Headless step

**Policy fields** (`StepPolicy`, all optional; existing plans unchanged):

```ts
mode?: "interactive" | "headless" | "debrief"         // default interactive (today)
agent?: string                                        // "<name>" in the step repo, or a roster key
profile?: string                                      // headless only; resolved per R-6
budget?: { turns?: number, minutes?: number }         // wall clock, includes machine sleep
output?: "review-record"                              // REQ-5 applies only with this
inputs?: ("previous" | "dispositions" | "artifacts" | localId)[]
when?: { open?: true, min_severity?: "S1"|"S2"|"S3"|"S4" }   // §5.4
consumes?: ItemState[]; may_set?: Disposition[]       // §5.3
assignee?: string                                     // debrief: user id, or "@owner"
```

`instantiate` substitutes `{param}` in every string field of a step (today only `{repo}` and `{goal}` in
repo/title/brief; review F16); an unknown or unfilled param fails at preset instantiation.

**Offer and start.** The offer message (MM-3 machine inbox, `kind: offer`) gains `mode`, `profile`,
`budget` and the run deadline. A daemon:

- never binds a `headless` or `debrief` step to an existing session (today an auto offer is pasted into
  an idle session first, `daemon.ts:653-677`);
- accepts a headless offer when `assignments` allows it and the repo is present, then starts it at once
  or, at `maxSessions`, keeps it **accepted and queued** locally until a slot frees or the run deadline
  passes (then it releases the step with reason `capacity`);
- starts the run **detached** (its own process group via `setsid`, or tmux like `launchStep`), writes a
  local run file `{step, pid, deadline, log}` under the state dir, and on restart adopts live runs and
  reaps dead ones (review F14).

**Command** (verified in the S1 spike, review F12; flags marked † are believed present, to confirm):

```
claude -p "<pointer prompt>" --output-format stream-json --verbose --max-turns <n>
       --settings <profile.json> --setting-sources user †  --strict-mcp-config --mcp-config <mesh only>
       [--agent <name> †] [--agents <json>] [--model <m>]
```

- The prompt is short: the brief plus "call `mesh_context` for your inputs". Inputs (previous record,
  dispositions, artifacts) are served by `mesh_context`, fenced and labelled untrusted (briefs are capped
  at 8000 characters; review F20).
- Project settings, hooks and `.mcp.json` of the subject repo are not loaded (`--setting-sources user`);
  mesh's own hooks live in user settings (`installer.ts`), so session binding still works; S1 verifies
  that `claude -p` fires SessionStart/Stop and that the MCP shim resolves its session. If
  `--setting-sources` is not available, the run uses a clean config dir with only mesh's settings.
- Every profile allows `mcp__mesh__mesh_context`, `mesh_artifact`, `mesh_review`, `mesh_done` (in `-p`
  mode an unlisted tool is denied, not prompted).
- Agent: a name present in the step repo runs with `--agent <name>`; a roster agent absent from the repo
  is passed with `--agents` and selected with `--agent` (S5; until verified, roster runs write the
  definition into the run's worktree `.claude/agents/`, which is discarded).
- `claude --bg` with `claude agents --json` (already used, `mesh-commands.ts:603-616`) is evaluated in
  the spike as an alternative to managing the process (review F26).

**End of run.** The session reports with MCP: `mesh_artifact`, `mesh_review` (if `output`),
`mesh_done`. The daemon reads the stream log:

- `result` event present: telemetry complete (§5.9);
- no `mesh_done` from the session: the daemon closes the round `fail` with the exit reason and a rendered
  tail (last assistant messages and the error, not raw JSON) as a `transcript` artifact;
- killed (budget, crash): no `result` event; partial telemetry with `exit: killed_budget | crashed`.

**Hub side.** A headless step's holder session is the `claude -p` session. The hub does not apply the
2-minute "holder ended → pause" rule to headless steps (`service.ts:1853-1861`); the daemon's close is
authoritative, and a headless step whose machine is offline past `machine_offline` is paused as today.
A late `mesh_done` on a paused headless step from the same holder session is accepted (the machine
slept). Commits: a `propose-via-branch` run commits in its worktree; **the daemon** pushes
`HEAD:refs/heads/mesh/<step-id>` after the run; the agent has no push rule (review F13).

**Profiles** (YAML compiled to Claude Code `permissions.allow/deny`):

| Profile | Allows (beyond the mesh MCP tools) | Notes |
|---|---|---|
| `read-only` | Read, Grep, Glob, LS; exact git reads: `git log --no-ext-diff …`, `git show --no-ext-diff …`, `git rev-parse …`, `git ls-files …`, `git cat-file …` | deny `--output`, `-c`, `--ext-diff`, any other Bash, Edit, Write, WebFetch |
| `read-only+checks` | `read-only` + commands listed in the profile itself | the commands are part of the snapshot |
| `propose-via-branch` | `read-only` + Edit/Write inside the run worktree + `git add`/`git commit` there | no push; the daemon pushes |

Profiles are built in or registered on the hub (`POST /v1/profiles`, owner/admin) and snapshotted by
hash on the pulse; a step names a profile, the run uses the snapshot (R-6). Permission rules are best
effort for shell commands (as `forbid` today, `mesh-commands.ts:565-573`); a hard boundary needs an OS
sandbox (§7).

### 5.2 Artifacts

Repo files stay as today (`Round.artifacts: {path, sha}`). New, hub-stored:

```ts
StoredArtifact = { id: string /* a-<ulid> */, goal: string, step: string, round: number,
                   kind: "report" | "review" | "transcript", mediaType: "text/markdown" |
                   "application/json" | "text/plain", bytes: number, sha256: string,
                   redactions: number, title?: string, createdAt: number, by: string }
```

- Table `artifact` (metadata as JSON text like other tables; content in a BLOB/bytea column). Limits:
  `artifacts.max_bytes` 1 MiB each, 10 per round. Expected growth: 30 weekly pulses × 3 artifacts ×
  ~50 KB ≈ 230 MB/year; `artifacts.retention_days` (default 365) prunes content of done goals, keeping
  metadata and sha.
- Upload: MCP `mesh_artifact {kind, title, media_type, content}` → the daemon redacts (known secret
  patterns: private keys, tokens of common providers, `password=`/`secret=` assignments; count in
  `redactions`) → `POST /v1/steps/:id/artifacts`; the round gets `artifactIds`.
- Read: `GET /v1/artifacts/:id`, `GET /v1/goals/:id/artifacts`, member or `goals:read`. Content is never
  copied into events or `mesh ledger export` (only id, kind, sha).

### 5.3 Review records, fold and item states

**Record** (MCP `mesh_review`, zod-validated, at most one per round):

```ts
ReviewItem = {
  key: { rule: string, path?: string, symbol?: string },   // rule from the agent's declared rules
  title: string, severity: "S1" | "S2" | "S3" | "S4", category: string,
  evidence: { path: string, lines?: [number, number], note?: string }[],
  proposal?: string,
}
ReviewRecord = {
  subject: { repo?: string, commit?: string, artifact?: string },
  coverage: "complete" | "partial",
  scope?: string[],                       // paths covered when partial
  assessment: "clean" | "issues" | "blocked",   // about the subject; never fails the step (REQ-5)
  items: ReviewItem[],
  dispositions: { fingerprint: string, disposition: Disposition, reason: string }[],
  summary: string,
}
```

**Declared rules** (review F8). An agent declares its rule ids in front matter (`mesh-rules: [I-03,
secrets, …]`) or a sibling `<name>.rules.yaml`. `mesh_review` maps an undeclared rule to
`other:<slug>` and counts it in telemetry (`undeclaredRules`). The previous record's item keys are part
of `mesh_context` inputs so the agent reuses them. An agent with no declared rules still works; its
fingerprints are less stable, which the stats show.

**Fingerprint** (hub): `fp = base32(sha256(rule ‖ normPath ‖ symbol))[0..16]`; `normPath` is relative to
the repo root; line numbers never enter it. **Near-match**: same rule and path, other symbol, is shown as
"possible repeat of <fp>" in the debrief; a renamed file shows as resolved + new, with a near-match on
rule and symbol.

**Evidence hash** (machine, review F9): for each evidence entry with `lines`, the daemon reads that
region of `path` at `subject.commit`, normalizes it (whitespace collapsed, line numbers excluded) and
hashes it; `eh` = hash of those hashes in order. Agent-written text never enters `eh`. An unrelated edit
above the region leaves `eh` unchanged; an edit inside it changes `eh`.

**Fold** (hub, on a `run` stage record with `coverage: complete`), against the last complete record of
the same lineage:

| Mark | Condition |
|---|---|
| `new` | fp not in the lineage's item history |
| `repeat` | fp in the previous complete record |
| `regression` | fp was resolved, or dismissed with a different `eh` |
| `resolved` | fp in the previous complete record, absent now, and within `scope` |

A partial record is stored and shown but never resolves anything and is not the base of the next fold.
Fold counts go to a new `Round.fold {new, repeat, regression, resolved, carried}`; `Round.findings` keeps
its M4.5 meaning (churn rule).

**Item states** (one row per `(lineage, fp)` plus a history; review F10, F11):

| State | Entered by | On `repeat` | On `regression` | On `resolved` |
|---|---|---|---|---|
| `open` | new | stays open | — | `resolved` |
| `confirmed` | a stage `confirmed` it | stays confirmed | stays | `resolved` |
| `dismissed` | a stage dismissed it | carried (`carry:<round>`), stays | `open` (history kept) | `resolved` |
| `deferred` | deferred with `until` date | stays until `until`, then `open` | `open` | `resolved` |
| `accepted` | accepted (`link` to the filed entry) | stays, shown with link, never re-filed | `open` with link | `resolved` |
| `resolved` | absent in a complete record | — | `open` | — |

- A stage acts on items in the states its `consumes` lists (default for a validator `[open]`, for a
  debrief `[open, confirmed]`, for a filer `[accepted]`) and may set only `may_set`.
- Precedence: a person's disposition is never changed by an agent in the same goal; across goals the
  latest decision applies, and the history keeps both, so calibration can tell "validator dismissed,
  person reinstated" (validator error) from "person dismissed the auditor's item" (auditor error).
- Disposition rows: `(lineage, fp, goal, step, round, disposition, reason, decider, via, at)`, with
  decider `{kind: agent, key, hash}` or `{kind: person, user}` and `via: stage | debrief-session | ui`.

### 5.4 Conditional stages: the `skipped` state

A new step state `skipped` (review F7): readiness treats it as satisfied (like done); a goal whose steps
are all done/skipped/dropped is done; replan keeps a skipped step skipped unless its definition changed;
**reopen** of a step re-evaluates `when` for its skipped dependants (they return to `blocked`).
`when` is evaluated in one function, `settle(goal)`, called from every path that changes readiness
(plan approve, step done, gate decide, reopen): `open: true` holds when at least one item of the run's
record is in a state the step `consumes`; `min_severity` additionally requires one such item at or above
the severity. False → `skipped` with event `step.skipped {reason: "when"}`.

### 5.5 Pulse and ingest

```ts
Pulse = { id: "p-<n>", owner: string, title: string,
          when: { cron: string, tz: string } | { every: string, anchor: number },
          preset: { name: string, text: string, sha256: string, source?: { repo: string, commit: string } },
          params: Record<string, string>,          // repo, agent, validator, filer, …
          profiles: Record<string, { text: string, sha256: string }>,   // snapshots (R-6)
          topics?: string[], target: { labels?: string[], machines?: string[] },
          window: string,                          // e.g. "4h": offer + retries before missed
          overlap: "skip" | "allow", maxGoalAge: string,   // default 2× period
          missed: "record" | "catch-up-once", enabled: boolean, nextAt: number, createdAt: number }
```

- **Create/update.** `mesh pulse add --preset <name> --param k=v … --every 7d|--cron "…" --tz …`: the CLI
  resolves the preset (repo `.mesh/presets` or built in) and the profiles it names, instantiates it once
  to validate (unknown params fail), and sends the snapshots. The owner creating the pulse is the plan
  approval for every slot; `mesh pulse update --preset` replaces the snapshot and is a new approval. A
  repo's later preset edits do not reach the pulse (R-6).
- **Tick.** After the existing tick work, and outside its transaction (`service.ts:1851` runs one
  `goalTx`), for each due pulse, in its own transaction: insert `pulse_slot (pulse, slot)` first (unique;
  a second replica or retry stops here); if `overlap: skip` and an earlier goal of the pulse is not
  finished → slot `skipped`; if that earlier goal is older than `maxGoalAge` → drop it (reason
  `abandoned`), slot of that goal `abandoned`, and fire. Fire = create the goal through a new
  **create-with-plan** path (no design step, no trail-commit request; `service.ts:824-850` today creates
  a ready design step), plan `decidedBy = owner`, comment `"pulse p-3 (preset <sha>)"`, as a system actor
  acting for the owner; if the owner is no longer a member, the pulse is paused with an event.
- **Machine choice.** Candidates = online machines (seen within `machine_offline`) that hold the repo,
  carry every `target.labels` (a filter, not a rank key), and would auto-accept; ranked by `suggest`.
  The run step is offered to the first; on decline or no acceptance within `min(offer_expiry, window/3)`,
  to the next; when `window` passes without a start → slot `missed` with reason `no_machine |
  not_accepted | capacity | expired`.
- **Downtime.** On the first tick after downtime, each slot passed is recorded `missed, reason:
  hub_down` (at most 10 rows per pulse), then one slot fires if `missed: catch-up-once`.
- **Cron.** A maintained 5-field cron parser with IANA time zones; on a DST gap the slot fires at the
  next valid minute, on a DST overlap once. `every` slots are `anchor + k·period` (anchor = creation
  time, or an explicit `--at`). Manual `mesh pulse fire` uses slot `manual:<ulid>` and counts for
  `overlap`.
- **Goals of pulses** carry `refs.pulse`, `refs.slot`; goal lists hide them by default (`--pulses` shows
  them), the pulse view shows the last N runs.
- **Ingest.** `POST /v1/goals/from-preset {preset: {name, text, sha256}, params, topics, artifacts[]}`
  with scope `goals:write` uses the same create-with-plan path; PR intake later builds on it.

### 5.6 Relay example

A generic built-in `audit-relay` (any repo can carry its own in `.mesh/presets`, snapshotted per R-6):

```yaml
description: Audit by an agent, validated by an agent, optionally debriefed by the owner, filed by an agent.
steps:
  - id: audit
    kind: review
    repo: "{repo}"
    agent: "{agent}"
    mode: headless
    profile: read-only
    output: review-record
    budget: { turns: 80, minutes: 60 }
    inputs: [previous]
    title: Audit {repo}
    brief: Audit {repo}. Report every finding you see, with keys from your declared rules; the hub works out what is new.
  - id: validate
    kind: review
    deps: [audit]
    agent: "{validator}"
    mode: headless
    profile: read-only
    output: review-record
    when: { open: true }
    consumes: [open]
    may_set: [confirmed, dismissed]
    inputs: [audit, dispositions]
    title: Validate the findings
    brief: Try to refute each open item from the source; confirm or dismiss each with a reason.
  - id: debrief
    kind: review
    deps: [validate]
    mode: debrief
    assignee: "@owner"
    output: review-record
    when: { open: true, min_severity: S2 }
    consumes: [open, confirmed]
    may_set: [accepted, dismissed, deferred]
    title: Debrief the findings
    brief: Go through the confirmed items with the owner, one at a time.
  - id: file
    kind: docs
    deps: [debrief]
    agent: "{filer}"
    mode: headless
    profile: propose-via-branch
    when: { open: true }
    consumes: [accepted]
    title: File the accepted items
    brief: Propose an entry for each accepted item; record its link.
```

Agent-only: omit `debrief` (then `file` consumes `confirmed`). Person-only: omit `validate`. No `blind`:
separate headless processes share no session, and `blind` (with the default `blind_guard: person`)
would refuse the validator to the same user (review F6).

### 5.7 Debrief

1. A `mode: debrief` step is never offered and never auto-launched. When ready it is listed for its
   assignee under **Assigned to you** (Mine, TUI); claiming requires `holder user = assignee`.
2. **Pre-read.** The web step panel renders the run's report and the items in the states the step
   consumes; `POST /v1/steps/:id/read` records the read. Starting without it warns, does not block.
3. `mesh debrief <step>` claims and opens an interactive Claude session in tmux in the subject repo, with
   the built-in `mesh-debrief` skill; inputs come from `mesh_context` (untrusted, fenced).
4. Items one at a time, highest severity first: title, evidence (rendered from the repo, not the agent's
   quote), the validator's reason, earlier dispositions of the fp and near-matches. For each, the skill
   calls `mesh_dispose {fingerprint, disposition, reason, answer}` where `answer` is the person's words;
   recorded with decider = person, `via: debrief-session`. The TUI and web list these as "decided in
   debrief" with a one-key revert (`via: ui` then).
5. The skill writes a summary (`transcript` artifact) and submits the debrief's review record
   (`mesh_review` with dispositions), then `mesh_done`. Each disposition is also a step note, so the
   goal's trail shows the decisions.

### 5.8 Calibration (R-3)

- Counting is always on: the hub counts dismissals per raising agent hash (person and agent deciders
  separately, and "validator dismissed, person reinstated" against the validator).
- Trigger, not schedule: when an agent hash has ≥ `calibration.threshold` (default 5) uncalibrated
  dismissals, the hub creates one visible goal from the built-in `calibrate` preset for the agent's
  calibrator (configured per catalog source or repo; default the owner of the most recent pulse that ran
  the agent). Input: those dismissals with items, evidence and reasons, plus the agent definition.
  Outcome: a proposed change to the agent (branch, via the daemon) or "no change" with a reason, as a
  review record of category `calibration`; the dismissals are then marked calibrated.
- No hidden pulses; a pulse never requires a calibration policy to be enabled.

### 5.9 Telemetry (R-2)

`Round.telemetry = { model, agentKey, agentHash, profile, profileHash, turns, tokensIn, tokensOut,
cacheRead, cacheWrite, costUsdEstimate, durationMs, exit, undeclaredRules, redactions }`:

- from the stream: `model` from the `system/init` event; `num_turns`, `usage`, `total_cost_usd` (a client
  estimate, labelled as such), `duration_ms`, `subtype` from `result`;
- without `result`: `durationMs` from the daemon, `turns` counted from assistant events, `exit:
  killed_budget | crashed | no_result`.

Events (payloads without artifact content): `pulse.fired|skipped|missed|abandoned`, `run.started`,
`run.finished` (telemetry), `review.recorded` (fold counts), `item.disposed`, `step.skipped`,
`calibration.opened|done`. `GET /v1/agents/:key/stats?days=30` per hash: runs, failures, mean cost and
duration, items raised, accepted, dismissed by agents / by people, reinstated, carried, regressions,
undeclared rules.

### 5.10 Roster

- **Discovery** (S5): the repo scan (MM-1, every 5 min, under `workspaceRoots`, only when the share level
  sends an inventory) also reads `<repo>/.claude/agents/*.md` and `<repo>/.opencode/agent/*.md` front
  matter (`name, description, model, tools, mesh-rules`) and `hash = sha256(file, LF-normalized)`. Sent
  on change, capped at 2000 per machine. User-level and plugin agents are out of scope.
- **Catalog sources**: `POST /v1/catalog-sources {repo, folder, calibrator?}` (admin). A machine that has
  the source checked out pushes its definitions **with bodies** (so any runner can use them without the
  checkout; ~1–3 MB for 300 files, on change). Repo agents are sent without bodies.
- **Install by reference**: `mesh agent add <source>/<name>[@commit] --repo <path>` writes the file
  **unchanged** to `.claude/agents/<name>.md` and the entry `{name, source, commit, hash}` to
  `.mesh/agents.lock`; `hash(installed) == pin.hash` holds. `mesh agent outdated`, `diff`, `update`.
  Updating from a catalog source shows the diff and needs the person's confirmation.
- **Views**: `GET /v1/agents` grouped by name, hashes, repos, flags `diverged`, `pinned`, `behind`,
  `modified`; web Roster page with stats (§5.9).

## 6. Data model and interfaces

| Change | Detail |
|---|---|
| Hub migrations 8–12 | `artifact`; `review_item (lineage, fp, state, …)` + `disposition`; `pulse`, `pulse_slot`; `profile`; `agent_def`, `catalog_source` |
| `StepState` | + `skipped` |
| `StepPolicy` | `mode`, `agent`, `profile`, `budget`, `output`, `inputs`, `when`, `consumes`, `may_set`, `assignee` |
| `Round` | `artifactIds`, `telemetry`, `fold`, `read` |
| Offer message data | `mode`, `profile`, `budget`, `deadline` |
| `instantiate` | `{param}` over all string fields; unknown param fails |
| Routes | `/v1/steps/:id/artifacts`, `/v1/artifacts/:id`, `/v1/goals/:id/artifacts`, `/v1/pulses…`, `/v1/pulses/:id/fire`, `/v1/goals/from-preset`, `/v1/profiles`, `/v1/steps/:id/read`, `/v1/items?lineage=`, `/v1/agents…`, `/v1/agents/:key/stats`, `/v1/catalog-sources` |
| MCP | `mesh_artifact`, `mesh_review`, `mesh_dispose`; `mesh_context` gains `inputs` |
| CLI | `mesh pulse add|ls|show|update|pause|resume|fire|rm`, `mesh debrief <step>`, `mesh artifact show`, `mesh items <lineage>`, `mesh agents`, `mesh agent add|outdated|diff|update` |
| Built-ins | profiles `read-only`, `read-only+checks`, `propose-via-branch`; presets `audit-relay`, `calibrate`; skill `mesh-debrief` |

## 7. Security

- **Untrusted subject repos.** A headless run loads user settings only (no project settings, hooks or
  `.mcp.json` of the audited repo), mesh MCP only (`--strict-mcp-config`); the repo's `CLAUDE.md` is
  read as content, not trusted instructions (stated in the profile's system note).
- **Injection chain** (report → validator → filer): profiles are read-only except
  `propose-via-branch`, which has no push; the daemon pushes to `mesh/<step-id>` only; inputs reach later
  stages through `mesh_context` fenced as untrusted; a test plants an instruction in a finding's note
  and checks the filer's prompt carries it fenced.
- **Profiles are snapshots** (R-6): a PR cannot change the profile it runs under. Shell allow rules are
  best effort; for untrusted code use a runner labelled `sandboxed` (container or OS sandbox; later).
- **Third-party agents** from catalog sources: pinned by commit; updates need a confirmed diff; default
  profile `read-only`.
- **Artifacts** are team-visible (no goal ACLs exist); the daemon redacts known secret patterns before
  upload; content never enters events or ledger exports. ACLs are OQ-3.

## 8. Alternatives considered

| Alternative | Why not |
|---|---|
| A separate review queue engine | Execution would duplicate goals/steps/offers; items stay records (R-1). |
| Cron on machines | Missed slots invisible; protocol in prompts; no idempotency. |
| Agents on the hub | No repos or credentials there by design (REQ-13). |
| Copying catalog agents | Recreates drift; pins make it visible. |
| Claude Code cloud scheduled agents | No reach into private networks and checkouts; no link to goals. |
| Agent-computed fingerprints and evidence hashes | Unstable; the hub and machine compute them from declared rules and file content. |
| Reading presets/profiles from the subject repo at run time | The hub cannot read repos, and a PR could change its own profile (R-6). |

## 9. Slices

| Slice | Version | Content | Depends on |
|---|---|---|---|
| S1 Headless + artifacts + telemetry | 0.1.15 | CLI spike (flags †, hooks in `-p`, MCP binding, `--bg` vs `-p`); `mode: headless`, offer data, queueing, detached runs, run file, profiles + snapshots, `mesh_artifact`, redaction, telemetry, `{param}` substitution | — |
| S2 Review records | 0.1.16 | `output`, `mesh_review`, declared rules, fingerprint, evidence hash, fold, item states, dispositions, `skipped`/`when`/`consumes`/`may_set`, `settle()` | S1 |
| S3 Pulse | 0.1.17 | snapshots, create-with-plan, tick firing, slots, machine choice and window, downtime, cron/DST, ingest route, hidden pulse goals; **dogfood**: agent-only `audit-relay` on mesh-harness | S1, S2 |
| S4 Debrief | 0.1.18 | `mode: debrief`, assignee claim, pre-read, `mesh debrief`, `mesh-debrief` skill, `mesh_dispose`, UI revert | S2 |
| S5 Roster | 0.1.19 | discovery, catalog sources with bodies, lock file, install/outdated/diff/update, views, roster agents in headless runs | S1 |
| S6 Calibration + stats | 0.1.20 | dismissal counting views, threshold trigger, `calibrate` preset, `/stats`, Roster metrics | S2, S5 |

## 10. Open questions

- **OQ-1** Item lineage for ingested goals (PRs): `(preset, repo, agent)` plus the PR id?
- **OQ-2** Debrief confirmation: is the one-key revert enough, or must every `via: debrief-session`
  disposition be confirmed in the UI before it counts for calibration?
- **OQ-3** Artifact access control (owner, assignee, stage holders) vs team-visible with redaction.
- **OQ-4** Calibrator default when an agent comes from a catalog source nobody on the pulse owns.
- **OQ-5** Spike outcome: `claude -p` process management vs `claude --bg` sessions.

**Defaults taken for implementation (2026-11-12):** OQ-1 lineage `(preset, repo, agent)`; ingested goals
add `refs.subject` (e.g. a PR id) to the lineage when given. OQ-2 the one-key revert is enough;
`via: debrief-session` dispositions count for calibration. OQ-3 artifacts are team-visible with
redaction; no ACLs. OQ-4 the calibrator is the catalog source's `calibrator`, else the owner of the most
recent pulse that ran the agent. OQ-5 decided by the spike
([`2026-11-12-claude-cli-spike.md`](2026-11-12-claude-cli-spike.md)).

**End-to-end acceptance (whole programme):** a World test (fake `claude` executable) where a pulse
fires the built-in `audit-relay` on a repo; the run step executes headless on a runner machine,
submits a report and a review record; the validator dismisses one item and confirms one; the debrief
(assignee) accepts it; the filer step runs; the goal is done; a second slot carries the dismissal
forward and shows the accepted item with its link without re-filing; telemetry and `/stats` reflect
both runs; reaching the dismissal threshold opens a calibration goal.

## 11. Review r1: disposition of findings

| Finding | Change |
|---|---|
| F1 hub cannot read presets | Preset (and profile) snapshots on the pulse, R-6, §5.5 |
| F2 debrief cannot be a gate | `kind: review` + `mode: debrief`, never offered, assignee-only claim, §5.7 |
| F3 verdict fails the run | `output: review-record` closes done on a valid record; `assessment` in the record; `Round.fold` separate from `Round.findings`, REQ-5, §5.3 |
| F4 REQ-5 breaks SDD presets | Rule keyed on `output`, not `kind` |
| F5 offers to idle sessions, capacity | Mode in offer data, never bound to a session, accepted-and-queued, missed reasons, §5.1, §5.5 |
| F6 `blind` | Removed from the example; inputs explicit, §5.6 |
| F7 `when` vs dropped | New `skipped` state, `settle()`, reopen re-evaluates, §5.4 |
| F8 unstable fingerprint | Declared rules, previous keys as input, no lineage kind in hash, near-match, renames, §5.3 |
| F9 evidence hash | Computed by the machine from the file region, lines excluded, §5.3 |
| F10 fold gaps | `coverage`/`scope`, fold against last complete, state table, brief fixed, §5.3, §5.6 |
| F11 composing dispositions | `consumes`/`may_set` normative, person precedence, table keyed by lineage, §5.3 |
| F12 CLI claims | Corrected (`--verbose`, model from init, no result when killed, `--agent` vs `--agents`, settings merge, MCP scope, allow mesh tools); verified in the S1 spike |
| F13 profiles not a sandbox | User setting source only, strict MCP, no agent push, snapshots, exact git rules, sandbox runner later, §5.1, §7 |
| F14 lifecycle | Detached runs, run file, adopt/reap, daemon close authoritative over pause rule, late done accepted, `maxGoalAge`, rendered transcript |
| F15 scheduling gaps | Downtime slots recorded, target labels as filter, online only, `window` with retries, manual slot, cron/DST, per-slot transactions, system actor, create-with-plan |
| F16 params | `{param}` over all string fields; fail on unknown |
| F17 visibility | Team-visible stated, redaction, no content in events/exports; ACLs OQ-3 |
| F18 install marker | File installed unchanged; provenance only in the lock |
| F19 roster transport | Caps, catalog bodies pushed, share level applies, user/plugin agents out of scope |
| F20 inputs in argv | Served by `mesh_context` |
| F21 who decided | `via: debrief-session`, person's `answer` stored, UI revert, OQ-2 |
| F22 calibration over-built | Trigger-based visible goal, no hidden pulses, no enable precondition |
| F23 R-1 wording | R-1 restated: items are records with a lifecycle |
| F24 goal clutter, lineage | Pulse goals hidden by default; lineage = (preset, repo, agent) |
| F25 slice order | Adopted: headless first, roster fifth |
| F26 `claude --bg` | Evaluated in the S1 spike, OQ-5 |
