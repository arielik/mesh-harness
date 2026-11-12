# Review r1: Pulse, Relay, Roster (docs/analysis/2026-11-12-pulse-relay-roster.md)

Reviewer: cold architecture review against the code at `feat/relay-design` (v0.1.14). Line refs are to
this worktree.

**Verdict: changes_requested**

The direction is right: one engine (goals and steps), the hub schedules and machines run, and the
review record has a schema. But several load-bearing claims about existing mechanisms are wrong.
Presets are not available on the hub. Gate steps cannot be offered or claimed. Review verdicts fail
steps. `blind` blocks the same person. Auto offers go to idle interactive sessions first. Goal
visibility does not exist. The fold model also has gaps that would make carry-forward and calibration
noisy. None of this sinks the design, but a spec written from it now would fail its own first tests.

---

## Findings

### F1 (blocker) §5.5, §5.6: the hub cannot read presets; pulse and ingest have no preset source

The doc says a pulse names `preset: { name, repo? }` ("built-in or a repo's .mesh/presets") and the hub
"instantiate[s] the preset with params" at each slot. `/v1/goals/from-preset {preset, ...}` assumes the
same. In the code, presets are resolved on the **client**, from the CLI's cwd
(`src/cli/hub-commands.ts:106-119` `findPreset`), and instantiated on the client
(`hub-commands.ts:205`). The hub only knows the two built-ins and the `{name, text}` snapshot on a goal
(`src/protocol/goal.ts:67`, `service.ts:801-841`). Under REQ-13 the hub never reads repos, so it cannot
load `.mesh/presets/security-audit.yaml` at fire time.

**Recommendation:** at `mesh pulse add` time, the CLI resolves the preset and stores its text and a
hash on the pulse (`preset: {name, text, sha256, source: {repo, commit}}`). Each slot uses that
snapshot. Changing the preset is an explicit `mesh pulse update --preset`, which the owner re-approves
(this is the approval that "pulse:<id>" stands for). Ingest takes the same snapshot in its body, or a
pulse/registered-preset id. Write down that a repo's preset edits do **not** reach existing pulses.

### F2 (blocker) §5.6, §5.7: a debrief cannot be `kind: gate`

The example debrief is `kind: gate` and §5.7 offers it, claims it (`mesh debrief`) and closes it with
`mesh_done`. Gates refuse all three: offer (`service.ts:396`, `433`; `ready` filter `476`), suggest
(`498`), and done (`1291`: "a gate: a person decides it"). Gates are closed only by `mesh step approve`
(`1416-1434`). `validatePolicies` also forbids `blind/route/target` on gates (`policy.ts:41`). In
addition, `Step.offer` is a single offer to one machine (`goal.ts:182`), so "offers it to the
assignee's machines" (plural) has no representation.

**Recommendation:** make the debrief a non-gate step, for example `kind: review` with `mode: debrief`.
It gets one offer to one machine of the assignee; the assignee can re-target it. Or define it as a
"person step": no offer at all, listed under Assigned-to-you by `assignee`, claimable only by that
user. Spec the claim check (`holderUser === assignee`) and how the debrief records approval
(`Round.gate` vs dispositions).

### F3 (blocker) §5.3, §5.6: review verdicts fail the run step and stall the relay

The audit step is `kind: review` and the record carries `verdict`. In `doneStep`, any verdict in
`changes_requested | blocked | fail` makes the round `fail` (`service.ts:1301`, `policy.ts:55-60`). With
no `target` or `route`, `judgeDone` returns `fail` (`policy.ts:121-127`), the step is `failed`, and
`validate`, `debrief` and `file` never become ready (`dag.ts:75`: only done/dropped satisfy deps). So
an audit that *successfully finds problems* kills its own relay. Separately, `park_on: churn` reads
`findings.regression` as "regress the writer's own repairs" (`policy.ts:98-101`). The doc reuses
`Round.findings.regression` for "dismissed or resolved item came back with new evidence", which is a
different meaning.

**Recommendation:** separate "the run succeeded" from "the subject is clean". A record-producing step
closes `done` whenever a schema-valid record arrives, whatever the item verdict. Record the subject
verdict in the record, not in `Round.verdict`. Put the fold counts in a new `Round.fold {new, repeat,
regression, resolved, carried}`, and leave `Round.findings` with its M4.5 meaning.

### F4 (major) §2 REQ-5, §5.3: "a review step MUST emit a record" breaks existing presets

`sdd-split` and `sdd-collapse` have `kind: review` steps (`presets.ts:24`, `32`, `45`) that never call
`mesh_review`. As written, REQ-5 fails them.

**Recommendation:** gate the rule on an explicit policy field (`output: review-record`), or on `mode:
headless | debrief`, not on `kind`.

### F5 (major) §5.4: offer handling sends headless steps to idle interactive sessions

For an `auto` offer, the daemon first picks an **idle session** in the repo and pastes the step into
it (`daemon.ts:653-677`, `bindOffered` `714-718`). It launches a new session only when none is idle
(`680`), and the launch is `mesh run <repo> --step` in tmux (`daemon.ts:112-115`). The offer message
carries no policy or mode (`service.ts:343-350`), so the daemon cannot tell a headless step apart.
When `maxSessions` is reached, the offer is just "listed" (`daemon.ts:684-688`). It then expires after
30 min (`config.ts:91`), so under the doc's rule a capacity shortage becomes a **missed** slot.

**Recommendation:** add `mode` (and profile and budget) to the offer message data. The daemon never
binds a headless or debrief step to an existing session. For capacity, a headless offer the machine
accepted but cannot start yet should stay accepted and queued locally, with its own run deadline.
Record `pulse_slot.state = missed` with a reason (`no_machine | not_accepted | capacity | expired`).

### F6 (major) §5.6: `blind: [audit]` hides exactly what the validator needs and refuses the same person

`blind` hides the partner's summary, notes and branch from the context (`policy.ts:179-189`). The
default `blind_guard` is `person` (`config.ts:70`), which refuses the step to **any user** who held a
partner (`policy.ts:161-167`). With headless runs on one person's machine, the auditor and the
validator have the same holder user, so the validator can never be claimed. A solo user cannot run
the example relay at all.

**Recommendation:** what the doc wants is "no shared session". That is already true for separate
`claude -p` processes. Drop `blind` from the example, or define a session-scoped variant for
agent-run steps. State that a validator reads the run's **record** (an artifact) through `inputs`, and
that `blind` does not hide artifacts named in `inputs`.

### F7 (major) §5.6: `when` and `dropped` collide with existing DAG semantics

Using `dropped` for "skipped by condition" works for readiness (`dag.ts:75`) and goal-done
(`service.ts:1398`, `1452`), but:

- `materialize` resets a dropped step that is still in the plan to `blocked` on any replan
  (`dag.ts:122`), so skipped steps come back.
- `reopen` only touches `done` steps and their done dependants (`dag.ts:151-176`). If the run step is
  reopened (route, fix cycle), a `when`-dropped validator is never re-evaluated, and the new record
  goes unreviewed.
- `parkedReason` is documented for `parked` (`goal.ts:37`, `179`).
- The event text says "dropped by a new plan" (`service.ts:1975-1976`), and the ledger and trail
  treat dropped as abandoned work (`service.ts:987`, `1700`).
- Readiness is recomputed in at least four places (approve, done, gate decide, reopen); "evaluated by
  the hub when deps are done" needs one choke point.

**Recommendation:** add a `skipped` step state, or `dropped` plus `dropReason: "when" | "replan"`.
Readiness treats it as satisfied. `reopen` re-evaluates `when` for skipped dependants, and replan
leaves it alone. Evaluate `when` inside `recomputeReady`'s callers through one function, and write an
AC for each of the five paths.

### F8 (major) §5.3: the fingerprint is only as stable as an LLM-chosen `rule` string

The hub hashes `rule ‖ normPath ‖ symbol ‖ extra`, but the agent picks every one of those inputs, in
free text, every week. "hardcoded-secret" vs "hardcoded-credential", or a different `symbol` for the
same function, gives a new fingerprint. A dismissed item then comes back as `new`, and R-3 counts no
dismissal. Moving the computation to the hub removes the hand-hashing, not the instability. The
current routine works only because it has a fixed **rule catalog** (`I-03`, `I-24`, ...;
vpc-node-agent `.claude/agents/code-quality-audit.md:124-126`). Also, `lineageKind` inside the hash
makes the same finding differ between a pulse run and an ingested run, for no benefit.

**Recommendation:**
- Let an agent declare its rule ids, in front matter or a sibling file. `mesh_review` rejects
  undeclared rules, or maps them to `other:<slug>` and counts them in telemetry.
- Always give the previous record's keys as input, so the agent reuses keys.
- Drop `lineageKind` from the hash.
- Add a spec'd near-match: same rule and path with a different symbol is shown as "possible repeat
  of <fp>" for the debrief.
- Say how a file rename is handled; today it shows as resolved plus new.

### F9 (major) §5.3: the evidence hash defeats carry-forward

`eh = sha256(canonical evidence)` includes `lines`, `quote`, `command` and `output`, all written by the
agent. Line numbers shift with any unrelated edit above the finding. Quotes vary in extent and
whitespace from run to run. So almost every repeat of a dismissed item gets a new `eh` and is marked
`regression`. That is the opposite of REQ-6's intent, and it floods the debrief with already-dismissed
items.

**Recommendation:** compute `eh` on the machine, not from agent text: the normalized content of the
referenced file region at `subject.commit` (or the blob sha of `path` plus the enclosing symbol), with
`lines` excluded. Write ACs: "unrelated edit above the finding → carried", and "edit inside the
quoted region → regression".

### F10 (major) §5.3, §5.6: the fold is undefined for partial runs and contradicts the example brief

`resolved` = "in the previous record, absent now". The example audit brief says "Report only what is
new or changed since the previous record". An agent that obeys that brief makes every unchanged item
`resolved`, and the next week it comes back as `regression`. A run that hit `--max-turns` or timed out
also leaves items out. The current routine has `outcome: ok | partial | failed` for exactly this
reason (code-quality-audit.md:86-89). The doc's record has no completeness field. Also undefined:

- what a repeat of an **accepted** (already filed) item does, which today means re-filing it weekly;
- what happens to `deferred`;
- whether a record from a failed round is ever folded.

**Recommendation:**
- Add `coverage: "complete" | "partial"` (and optionally `scope: paths[]`) to the record. Only a
  complete record can mark items `resolved`, and only within its scope.
- Fold only against the last **complete** record of the lineage.
- Spec item state transitions as a table: open, confirmed, accepted (with a link to the filed item),
  dismissed, deferred (with an until-date), resolved. Give the effect of repeat, regression and
  resolved on each. An accepted item that repeats is shown with its link, and is not re-filed.
- Fix the example brief: "report every finding; the hub computes what is new".

### F11 (major) §5.3, OQ-2: composing dispositions across stages is under-specified, and R-3 depends on it

"Item state = the last disposition" lets a filer agent's later `accepted` silently override a person's
`dismissed`, or a validator overwrite a person's call on a re-run. The `disposition` table is keyed by
`goal`, but item state lives across goals (by lineage). It needs `lineage` and `fp` as the lookup key,
or carry-forward cannot find past dispositions.

**Recommendation:**
- Each stage declares `consumes: [states]` and `may_set: [dispositions]` (the doc's own OQ-2
  proposal; make it normative).
- Person decisions outrank agent decisions in the same goal. An agent may not change a person's
  disposition.
- Key the table `(lineage, fp, goal, step, round)`, so a calibration can tell "validator dismissed,
  person reinstated" (validator error) from "auditor wrong" (auditor error). Without that split,
  calibration trains the auditor on the validator's mistakes.

### F12 (major) §5.4: Claude Code CLI assumptions need correction or verification

Checked as far as I can without running the CLI. Verify each in slice 1, not slice 2.

- `--output-format stream-json` with `-p` requires `--verbose` (fairly sure; the CLI errors without
  it).
- The `result` event has `subtype`, `num_turns`, `duration_ms`, `total_cost_usd`, `usage`
  (input/output plus cache_creation/cache_read tokens) and `is_error`. It has no single `model`. Take
  the model from the `system`/`init` event (or per-model usage, if present). `tokensIn` must say
  whether cache tokens are included. `total_cost_usd` is a client-side estimate, and notional on
  subscription plans; label it so.
- A run killed by SIGTERM or SIGKILL emits **no** `result` event. Telemetry must then be partial
  (duration from the daemon, turns counted from stream events). The schema must allow missing fields
  with `exit: "killed_budget" | "crashed"`.
- `--agents <json>` defines **subagents** the main loop may delegate to. It does not make the main
  thread run as that agent. Running the session *as* an agent needs `--agent <name>` together with
  `--agents` or an installed file. I believe `--agent` exists in recent versions; not certain. The
  fallback "body as `--append-system-prompt`" also drops the agent's `tools` and `model` front matter
  unless the harness maps them.
- `--settings` does **not** override the user's settings. It adds a higher-precedence source, and
  permission rules from user, project and local settings still merge (deny wins anywhere, allows
  accumulate). A user-level `Bash(*)` allow survives a `read-only` profile. See F13.
- `--mcp-config <mesh mcp>`: mesh's MCP server is already registered at **user** scope
  (`src/claude/extras.ts:13`). Passing it again risks a duplicate server name. Either rely on user
  scope, or pass `--strict-mcp-config --mcp-config` with only mesh.
- In `-p` mode, a tool call that is not allowed is denied, not prompted. Every profile must
  explicitly allow `mcp__mesh__mesh_context`, `mesh_artifact`, `mesh_review` and `mesh_done`. The
  profile table lists none of them, so as written a `read-only` run could not report.
- Session binding depends on mesh's hooks in **user** settings (`installer.ts:1-45`, `X-Mesh-Step`
  from `MESH_STEP`). The MCP shim maps calls to sessions by parent pid (`mcp/shim.ts:1-3`). Restricting
  setting sources to harden the profile (F13) would also cut off the hooks. Test that `claude -p`
  fires SessionStart and Stop hooks, and that the shim resolves its session.

### F13 (major) §5.4, §7: permission profiles are not a sandbox as specified

- Merging (F12) means a profile cannot take away the user's or the repo's allows. The audited repo's
  `.claude/settings.json` can add allows and **hooks**: arbitrary shell, running before any prompt.
  Its `.mcp.json` and `CLAUDE.md` also load. For a third-party or ingested repo, that is code
  execution, not prompt injection. Mitigation: load only the user and flag setting sources
  (`--setting-sources`; verify it exists), use `--strict-mcp-config`, and treat `CLAUDE.md` as
  untrusted input.
- `read-only` allows `git diff`/`git log`. `git diff --output=<file>` writes files, and
  `git -c core.pager=...` or `--ext-diff` run programs. Allow rules need exact argument shapes, or the
  daemon should provide those reads.
- `propose-via-branch` allows `git push origin <prefix>/*`. The refspec `git push origin
  mesh/x:main` matches that prefix and pushes to `main`. Do not give the agent push at all: it commits
  in the worktree, and **the daemon** pushes `HEAD:refs/heads/<prefix>/<step-id>` after the run.
- §7 says profiles can come from `.mesh/profiles/<name>.yaml` **of the step's repo**. For any ingested
  or third-party subject, that is the attacker's repo. A PR can edit the profile it then runs under.
  Resolve profiles from the pulse snapshot (F1) or the default branch at the pinned commit, and
  record and compare the hash. "Reviewed like code" protects nothing on a PR branch.
- Existing precedent: `forbid` already compiles to `--settings` deny rules and says "best effort; shell
  commands are not covered" (`mesh-commands.ts:565-573`). The doc should say plainly that profiles
  inherit that limit. The only hard boundary is an OS sandbox or container. List that as a later
  option (a runner label such as `sandboxed`).

### F14 (major) §5.4: process lifecycle and failure modes are under-specified

- **Daemon restart or upgrade mid-run:** a `claude -p` child of the daemon dies with it or becomes an
  orphan. Run the process detached (tmux, as `launchStep` does, or `setsid`), and write a local run
  file (pid, step, deadline, stream log path) so a restarted daemon can adopt or reap it.
- **Race:** the hub tick pauses a claimed step 2 min after its holder session ends
  (`service.ts:1853-1861`, `pause_grace` 2 min). The daemon's "close as fail with transcript" must
  land first. Otherwise the step is `paused`, not `failed`, and the relay hangs.
- **Machine sleeps mid-run:** after 15 min offline the hub pauses the step (`machine_offline`). On
  wake the process continues and calls `mesh_done` on a paused step. Spec whether that is accepted.
  Spec how the minutes budget counts sleep (wall clock vs monotonic).
- **Stuck goal plus `overlap: skip`:** one paused or parked relay goal makes every later slot
  `skipped`, indefinitely. That is the same failure the doc criticizes cron for: silence. Add
  `pulse.max_goal_age` (for example 2× period). After it, the hub drops the old goal with a reason and
  marks its slot `abandoned`.
- **Transcript:** "last 4 KB of output" of stream-json is JSON noise. Keep the full stream log on the
  machine, and upload a rendered tail (last assistant messages plus the error) capped at the artifact
  limit.

### F15 (major) §5.5: pulse scheduling gaps

- **Missed slots during hub downtime are not recorded.** "nextAt advances past now (no burst)" with
  `missed: record` silently skips them, which contradicts REQ-2. Write a `pulse_slot` row
  `state=missed, reason=hub_down` for each skipped slot (cap the count), and fire at most one.
- **Machine choice:** `suggest` ranks an **offline** machine with matching labels above an online one
  (MM-4.md:209-211; `suggest.ts:68-79`). Labels are only a rank key, never a filter
  (`suggest.ts:57-59`). "Filtered by target" is new behaviour. Spec it: drop offline machines, require
  `target.labels` ⊆ machine labels, and require `auto` (a non-auto offer to someone else's machine
  rarely lands within 30 min).
- **One offer expiry for everything:** the global 30 min `offer_expiry` (`config.ts:91`) decides
  "missed" for a weekly job. Add a per-pulse `window` (for example 4h), used for the run step's offer
  and for retries to the next candidate machine before declaring missed.
- **Manual `fire`:** the `(pulse, slot)` key needs a distinct slot value (for example `manual:<ulid>`)
  and a rule for whether it counts for `overlap`.
- **Cron:** name the library, DST behaviour (a 02:30 slot on spring-forward day: skip or shift?) and
  the anchor of `every: 7d` (createdAt? last fire?). Each needs an AC.
- **Transactions:** `tick()` runs everything in **one** `goalTx` (`service.ts:1851`). Firing a pulse
  (create goal, plan, approve, offer) inside it means one bad preset rolls back the whole tick,
  including offer expiry. Fire each slot in its own transaction, after the existing tick work. The
  `pulse_slot` row insert must be the first write and must be unique.
- **Plan approval by a pulse:** `approvePlan` requires `canApprove(actor, goal.ownerId)`
  (`service.ts:1105`). The tick needs a system actor acting as the owner. Spec what happens when the
  owner loses the member role, then pause the pulse. `gate.rule` is a `Round` field of gate steps
  (`goal.ts:146`), not a plan field. Record the approval as `plan.decidedBy = owner`, `comment =
  "pulse p-3 (preset sha …)"`.
- **Design step:** every goal is created with a ready design step (`service.ts:824-850`) and emits
  `step.ready`. A pulse goal needs a create-with-approved-plan path that never readies or offers the
  design step, and never asks anyone to commit trail files (`service.ts:981-990`).

### F16 (major) §5.6: preset params are not substituted where the example uses them

`instantiate` replaces only `{repo}` and `{goal}`, and only in `repo`, `title` and `brief`
(`presets.ts:68-79`). The example uses `{agent}`, `{validator}` and `{filer}` in **policy** fields.
These would pass validation as literal strings and fail at run time.

**Recommendation:** generic `{param}` substitution over all string fields of a step. Fail at `pulse
add` on an unknown or unfilled param. Validate the filled `agent` against the roster.

### F17 (major) §2 REQ-4, §7: "the goal's visibility" does not exist

There is no goal-level visibility. Visibility exists only for sessions (`core/visibility.ts:5-12`).
Every member, and any `goals:read` service token, sees every goal. So an audit artifact quoting a
secret is readable hub-wide, and possibly exported by `mesh ledger export`.

**Recommendation:** either add artifact ACLs in this design (owner, assignee and stage holders by
default; `share: team` opt-in), or state plainly in §7 that artifacts are team-visible. Then add a
mandatory redaction pass in the daemon before upload (known secret patterns, recorded as
`redactions: n` in telemetry). Keep artifact content out of events and ledger exports.

### F18 (major) §5.1: the install marker breaks agent files

The doc writes `<!-- mesh-agent: ... -->` as the **first line** of `.claude/agents/<name>.md`. Claude
Code agent files must begin with the `---` front matter. A leading comment most likely makes the file
unparseable as an agent (verify). The marker also changes the content hash, so the installed copy
never equals the source hash.

**Recommendation:** put provenance only in `.mesh/agents.lock`, or in a front-matter key the CLI
ignores. Define the hash over the file minus that key. Add an AC: an installed agent is listed by
Claude Code, and `hash(installed) == pin.hash`.

### F19 (minor) §5.1: roster transport details

- The sync caps `repos` at 500 (`protocol/hub.ts:37`); give `agents` a cap too.
- The "inbox channel" is hub→machine messages the daemon pulls. There is no synchronous
  request/response, so `GET /v1/agents/:key/body` cannot block on a daemon.
- Use-without-install needs the **body on the running machine**, which may not have the catalog
  checked out. That forces OQ-1: catalog-source bodies must be stored on the hub (about 1–3 MB, so
  just push them).
- Discovery reads agents of private repos. Say whether agent names and descriptions follow the
  machine's share level.
- User-level `~/.claude/agents` and plugin agents are out of scope; say so.

### F20 (minor) §5.4: prompt-built inputs belong behind `mesh_context`, not argv

Previous records plus dispositions can be large, and briefs are capped at 8000 characters
(`goal.ts:234`). Put a short pointer in the prompt and serve `inputs` from `mesh_context` (or
`mesh_inputs`), fenced and labelled untrusted there. This also lets interactive and debrief steps
reuse it.

### F21 (minor) §5.7: who "decided" in a debrief

`mesh_dispose` is called by the LLM, so "decider = the person because the session is theirs" records
the model's interpretation as the person's decision. A skill can dispose items the person never saw.

**Recommendation:** record `decider: {kind: person, user, via: "debrief-session"}`. Either require the
person's literal answer text in `reason`, or confirm dispositions in the TUI or web (a one-key confirm
per item). Calibration weighs `via: session` lower than direct UI decisions.

### F22 (minor) §5.8: calibration is over-built for an MVP

Hidden pulses per agent key contradict REQ-2's "missed is visible". "A pulse cannot be enabled
without a calibration policy" blocks the dogfood in S4, which comes before S6. Calibrating a
catalog agent whose source repo the pulse owner does not own (OQ-4) proposes branches nobody can merge.

**Recommendation:** for MVP, calibration is a **query plus a trigger**. When an agent hash reaches N
undecided dismissals, the hub creates one visible calibration goal for the agent's source owner (or a
configured calibrator). No hidden pulses. Make R-3 "every dismissal has reason and decider and is
counted against the raising agent hash"; the automatic prompt-rewrite goal is a later slice.

### F23 (minor) R-1, §8: the item model *is* a second state machine; say so

R-1 says "if a feature needs its own state machine, the design is wrong", yet items have states,
transitions, carry-forward and a table keyed across goals. That is fine and probably unavoidable.
Pretending otherwise is how the transitions in F10 and F11 went unspecified. Restate R-1 as "goals and
steps for execution; items are records with a defined disposition lifecycle, never executed".

### F24 (minor) §5.5: goal-list clutter and lineage

52 relay goals per pulse per year, plus calibrations, all in `listGoals` (`service.ts:854-857`), in My
mesh and in the ledger. Add `refs.pulse` filtering: hide pulse goals by default and show them under
the pulse, with a "last N runs" view. Lineage = "pulse id" breaks when a pulse is recreated, or when
two pulses audit the same repo. Define lineage explicitly as `(preset name, subject repo, raising agent
name)`, with the pulse id as an attribute, so history survives pulse edits.

### F25 (suggestion) §9: slice order

S1 (Roster) delivers nothing toward the stated pain (recurring audits reviewed), yet it is the first
slice and most of its surface (catalog sources, lock file, diff, update) is independent. Proposed
order:

- **S1′ Headless run + artifacts + telemetry + CLI verification spike** (F12, F13, F14), using an agent
  name already in the repo.
- **S2′ Review record + fold + dispositions + `skipped`/`when`** (F3, F7–F11).
- **S3′ Pulse** (F1, F15), then dogfood agent-only.
- **S4′ Debrief.**
- **S5′ Roster and install-by-reference.**
- **S6′ Calibration goal.**

The dogfood then starts two versions earlier. The `--agents`/`--agent` question (OQ-5) only matters
once roster agents run in repos that lack them, so it moves to S5′.

### F26 (suggestion) §5.4: consider `claude --bg` or the existing launcher instead of a new process manager

The CLI already uses `claude --bg` (`mesh-commands.ts:603-616`), and the daemon reconciles with
`claude agents --json` (`daemon.ts:1`). If background sessions report a final result, the harness gets
lifecycle, listing and reattach for free. Evaluate this against raw `claude -p` in the S1′ spike before
building pid and log management.

---

## Testability gaps a spec writer cannot close from this doc

- `when.open`: "exact rule in the spec" with no rule. Needs the F10/F11 state table first.
- "Mine and TUI show missed slots of the last 7 days" needs a shape (per pulse: slot time, state,
  reason, goal link).
- "Evidence quotes are rendered as code, never as instructions" is not testable as phrased. Specify
  the fencing format and a test with an injection string in a quote.
- "maxSessions counts headless runs" is already true for any session that shows up through hooks
  (`daemon.ts:709-721`). The real question is queueing at capacity (F5).
- `artifacts.max_bytes` 2 MiB × 20 per round × weekly × many pulses, in a JSON-in-TEXT schema (all
  current tables store `value TEXT`, `hub-store.ts:10-60`): give the expected growth and say whether
  SQLite BLOB in the same file is acceptable.

## What is good

- The hub schedules and records, machines run (REQ-13). This keeps credentials and checkouts where
  they are and reuses offers and labels instead of inventing a runner pool.
- Moving fingerprinting and the fold out of agent prompts into the hub removes the most fragile part
  of today's routine contract (polling `ops status` with `sleep 10`).
- `(pulse, slot)` uniqueness, conditional saves and leader-only tick fit the existing replica model
  (`server.ts:62-71`, `service.ts:1857-1861`).
- Mandatory structured output and telemetry as a shipping rule (R-2), with telemetry keyed by agent
  hash, makes "did this prompt change help?" answerable.
- Pinned references with drift reporting is the right answer to 311 drifting copies, and it is cleanly
  separable.

## Top 3 changes I would insist on

1. **Fix the mechanism mismatches before specifying anything.** Snapshot the preset text on the pulse
   (the hub cannot read repo presets; F1). Make the debrief a non-gate step (F2). Decouple "record
   produced" from step failure and keep `Round.findings` semantics (F3). Replace `dropped` for
   `when`-skipped with a state that survives replan and reopen (F7). Route headless offers past idle
   interactive sessions, with capacity queueing (F5).
2. **Make the fold trustworthy.** A declared rule catalog per agent and previous keys as input (F8).
   A machine-computed evidence hash that ignores line numbers and quote wording (F9). A `coverage`
   field so partial runs never "resolve" items (F10). A normative item-state table with precedence
   of person over agent decisions, keyed by lineage (F11). Without these, carry-forward and R-3
   calibration measure noise.
3. **Treat headless runs as a security boundary only where they are one.** Verify the CLI flags in
   the first slice (`--verbose`, `--agent` vs `--agents`, `--setting-sources`, `--strict-mcp-config`,
   allowing mesh MCP tools; F12). Never load project settings, hooks or MCP from the audited repo.
   The daemon pushes, not the agent (F13). Resolve profiles from the pinned pulse snapshot, never from
   the subject branch. Either add artifact ACLs or declare artifacts team-visible, with redaction
   (F17).
