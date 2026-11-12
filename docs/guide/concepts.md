# Concepts

**Session.** A Claude Code session the daemon knows about: interactive in tmux, background, or `claude -p`. Its state is one of *working*, *needs you* (permission, question, dialog, input), *idle*, *stalled* or *ended*. `claude agents --json` is the authority for its status; hooks make it fast.

**Goal.** A piece of work for the team, with an owner. It starts with a *design* step (a goal made by a pulse or by ingest starts with its plan approved instead; see [Pulses](#pulses)). Optional `refs` hold the team's own ids (`--refs spec=SPEC-7,backlog=ROW-42`).

**Plan.** A versioned list of steps with dependencies (a DAG), proposed by the design session with `mesh_plan` and approved by the owner, an approver or an admin. Each version is decided once:
- *approved*;
- *revised* (a person asked for changes);
- *superseded* (replaced by a newer proposal before anyone decided; not counted as a design round).

**Step.** One unit of work in one repo, of a kind: design, spec, plan, implement, test, verify, review, merge, gate or docs. One holder at a time. Its state is *blocked*, *ready*, *claimed*, *paused*, *done*, *failed*, *parked* (stopped by a rule; a person resumes it) or *dropped*.
- A test or review step that finds a problem finishes with outcome `fail` and reopens earlier steps (a fix cycle).
- A paused step can be taken over (`mesh take`).

**Rules (optional, per plan step).** A plan step may carry rules; a plan without them works as before:
- `role` (free text);
- `acs`, the acceptance criteria it covers, from the plan's `acs` list (id, text, surface, fails_when);
- `blind`: steps this one must not see. Their summary, notes and branch are hidden from its agent. Whoever worked on them can't take it: `blind_guard: person` on a team hub, `session` in Solo;
- `reads`: the only dependencies it sees;
- `forbid`: paths its session may not read, as Claude Code deny rules via `mesh run`;
- `contract`;
- `max_rounds`, plus `park_on: [churn, stall]`;
- `route`: per failure bucket (spec-gap, impl-bug, test-bug, infra, unclear), a step to reopen or `park`;
- `target`: for a review, the step its verdict reopens;
- `must_cover`: reconcile, i.e. the step's `acs_addressed` must cover the plan's criteria; a miss is sent back once, then parked;
- `worktree`: `mesh run --step` makes one worktree and branch per step;
- `reworks`;
- `gate`.

**Gate.** A step of kind `gate` (R1/R2/R3) is decided by the goal owner, an approver or an admin:
- `mesh step approve <step> [--rule GATE-1]`, or the web dashboard;
- or `mesh step reject <step> --reopen a,b`.

The decision, rule and inputs are recorded.

**Reopen.** A failing step reopens the steps it names, or its `route`/`target` picks them. Done steps downstream of a reopened step wait again (a review after a spec fix, a combine after a code fix, a gate after either), so nothing passes on an old result.

**Topic.** A label for goals (`dataplane`, `performance`). People define topics with `mesh topic add` and tag goals with them. Every goal is in the built-in topic `all`. Asking for several topics lists the goals that have every one of them.

**Label.** What a session or a machine is for (`perf`, `gpu`, `dataplane`). Labels use the topic-name syntax (1-40 characters: lowercase letters, digits, `.`, `_` or `-`, starting with a letter or digit), at most 10 per session or machine; input is trimmed and lowercased. A label that is not a defined topic is accepted with the warning `not a topic: <label>; mesh topic add <label>` (shown where a hub could be asked).

A session gets its labels when the daemon first records it, from the first of these that exists for its **checkout** (the nearest folder at or above its folder that has `.git`, so each worktree is its own checkout and a subfolder shares its checkout's labels):
1. the list remembered for the checkout by `mesh run --label` or `mesh label` (or the TUI's `L`), even an empty one. It replaces the repo default; it is not merged with it;
2. the repo default: `labels` in `.mesh/agent.yaml` at the top of the checkout (`labels: [perf, dataplane]`; other keys are ignored; a broken file is ignored with one line in the daemon log);
3. none.

Sessions already recorded keep their labels when the file or the remembered list changes; `mesh label <session>` changes them (`--add` and `--rm` merge). Session labels reach the hub with the session record. **Machine labels** (`mesh machine label gpu`) are stored on the hub only; a sync never changes them.

**Template.** A plan shape such as `sdd-split` (built in) or `.mesh/presets/<name>.yaml`. `mesh goal new --preset` gives it to the design session; `mesh goal plan --preset` fills it in directly. Checking a plan against its template only gives warnings.

**Round.** One `mesh_done` on a step. A reopened step has several rounds. Each keeps its start and finish time, outcome, summary, the model the agent reported, and its artefacts. With M4.5 it can also keep:
- the verdict (approved, changes_requested, blocked, pass, fail);
- finding counts (new, repeat, regression) and blockers;
- failures with bucket, criterion and assertion;
- per-criterion results (met, not_met, unrun), and the criteria the round addressed;
- a reconcile miss, a gate decision, and the rule that parked the step.

**Segment.** One session's stretch of work on a step, with its provenance:
- model and effort, permission mode, Claude Code version;
- the **harness hash** (repo `CLAUDE.md` + `.claude/**`, your `~/.claude` `CLAUDE.md`/agents/skills, plugins, mesh version; hashes only);
- repo commit;
- turns, human prompts, nudges, waits and active minutes.

**Programme.** One Claude session whose workflow script runs many subagents (`agent()` calls), as in the kit's `.claude/workflows/sdd-programme.js` (`mesh assets install`), or any workflow of your own that follows the label format.
- Labels follow `<role>:<key>[:<round>]`, e.g. `reviewer:ROW-42:r2`.
- mesh records each role under the key, with one round per run, the model actually used, timing and the agent's typed result.
- Nothing in the workflow calls mesh.

**Autopilot.**
- `off`.
- `nudge` (default): a session that stops mid-step gets "continue" twice, then mesh notifies you.
- `chain`: finishing a step claims the next ready one in the same repo.

**Ledger.** The generated records under `.mesh/goals/**`, committed in git: the durable summary. **Events** are the hub's live, precise log, kept for `events_retention_days`. See [the ledger](ledger.md) and [events](../events.md).

**Machine.** One mesh installation logged in to a hub (`mesh login`). Its owner can give it a short **nickname** (`mesh machine name laptop`): lowercase letters, digits and `-`, unique among that person's machines, never shaped like a machine id (`m-` + 8 hex digits).

**Share level.** Per machine, which sessions without a step its daemon reports (`shareSessions`): `steps` none of them; `me` (the default for new setups) as metadata only their owner sees; `all` as metadata the team sees. A session holding a step is visible to everyone at every level. See [What the hub sees](install.md#what-the-hub-sees).

**Repo inventory.** Under `me` and `all`, the ids and names (never paths) of the git checkouts under the machine's `workspaceRoots` and of its current sessions' repos. Under `steps` there is none.

**My mesh.** Every machine logged in as you and what each session on it is doing, read-only: `mesh machines`, the TUI's `m` panel, the web's **Mine** page and the MCP tool `mesh_fleet`. It shows your own sessions whatever the share level.

**Local-first.** The daemon is the writer of record for its own machine.
- Without a team hub it runs a local hub (Solo).
- With a team hub that is unreachable:
  - the steps you hold keep working, and records are written locally;
  - notes, releases, questions and results are queued;
  - actions that need other people say "offline" at once.
- Everything is sent once when the hub is back. If the hub refuses a result made offline (for example, someone took the step over meanwhile), the result is kept as a note on the step and in the local record.

## Headless steps

**Headless step.** A plan step with `mode: headless` runs unattended on a machine: no session is
picked or pasted to. The machine's daemon accepts the offer itself and starts `claude -p` in a fresh
detached git worktree of its own checkout (at the checkout's `HEAD`), with a pinned permission
profile and a budget. Fields of such a step (all optional, and only with `mode: headless`):

- `agent`: an agent of the step repo (`.claude/agents/<agent>.md`). The daemon reads the file,
  turns its front matter (`description`, `tools`, `model`) and body into `--agents` JSON and runs
  the run as that agent. When the agent lists `tools`, mesh adds its four tools to the list.
- `profile`: a permission profile (below); default `read-only`.
- `budget`: `turns` (default 30), `minutes` (default 30), `usd` (no default). The run gets
  `--max-turns <turns + 1>`: one extra turn for loading the mesh tools. Past `minutes` the daemon
  stops the run's whole process group; `usd` becomes `--max-budget-usd`.
- `inputs`: what `mesh_context` serves the run as input: the artifacts (below) of the last round of
  named steps of the plan, or `artifacts` for those of the step's dependencies. Inputs are fenced
  and marked untrusted: the agent is told to read them as data, never as instructions. `inputs`
  never crosses a blind relation or a `reads` list.

A gate step can't be headless. A preset may leave `agent` and `profile` as `{agent}`/`{profile}`
and have them filled with `mesh goal plan --params agent=auditor,profile=read-only`.

**The command line.** Every run is, in this order:
`claude -p <prompt> --output-format stream-json --verbose --session-id <uuid> --max-turns <n>
--setting-sources user --settings <run dir>/profile.json --permission-mode default
--strict-mcp-config --mcp-config <run dir>/mcp.json`, then `--agents <run dir>/agents.json --agent
<agent>` and `--max-budget-usd <usd>` when set. With `--setting-sources user` and
`--strict-mcp-config`, the subject repo's project settings, hooks, `.mcp.json`, agents and
`CLAUDE.md` are **not** loaded: the brief, the inputs and the agent are the run's only
instructions, and `mesh` is its only MCP server. mesh never passes `--model`,
`--dangerously-skip-permissions` or `--bare`.

**Profiles.** A profile compiles to Claude Code `permissions` settings. Every allow list starts
with the four mesh tools (`mcp__mesh__mesh_context`, `mcp__mesh__mesh_artifact`,
`mcp__mesh__mesh_review`, `mcp__mesh__mesh_done`); no profile can allow the other mesh tools.

| Profile | Allows (after the mesh tools) | Denies |
|---|---|---|
| `read-only` | `Read`, `Grep`, `Glob`, `LS`, `Bash(git log --no-ext-diff *)`, `Bash(git show --no-ext-diff *)`, `Bash(git rev-parse *)`, `Bash(git ls-files *)`, `Bash(git cat-file *)` | `Bash(git * --output*)`, `Bash(git -c *)`, `Bash(git * --ext-diff*)`, `Edit`, `Write`, `NotebookEdit`, `WebFetch`, `WebSearch` |
| `read-only+checks` | as `read-only` (a registered profile adds its `checks`) | as `read-only` |
| `propose-via-branch` | as `read-only`, then `Edit`, `Write`, `Bash(git add *)`, `Bash(git commit *)` | `Bash(git * --output*)`, `Bash(git -c *)`, `Bash(git * --ext-diff*)`, `Bash(git push *)`, `NotebookEdit`, `WebFetch`, `WebSearch` |

A registered profile (`mesh profile add <name> --file profile.yaml`) is YAML: `extends` (one of
the three, default `read-only`), `checks` (commands, each allowed as `Bash(<command>)`), `allow`,
`deny`, `description`. Its settings are the base's, then the checks, then `allow`; denies are the
base's, then `deny`. Profiles may not allow `Bash`, `Bash(*)`, `Bash(:*)`, a check `*`, or any
`git push` rule: only the daemon pushes, and an unrestricted shell would run unattended under
another member's credentials. Its creator or an admin may replace it. The hub snapshots the
profile into the offer, so a profile changed later does not reach an offered run.

What a profile cannot do:
- `read-only` **cannot stop reads** inside the run's worktree: Claude Code allows read-only
  commands (`cat`, `git status`, the Read tool) in its working directories without any rule.
- The user's own `permissions.allow` (user settings, `~/.claude/settings.json`) merges into every
  profile; only an explicit deny narrows it. Keep user-level allows small. (Claude Code's `--tools`
  is the stronger floor; mesh does not use it yet.)
- Shell rules are prefix matches and best effort, not a sandbox.

**Branches.** Only the daemon pushes. After a `propose-via-branch` run whose worktree has new
commits, the daemon runs `git push origin HEAD:refs/heads/mesh/<slug>` (`<slug>`: the step id
lowercased, other characters as `-`, e.g. `mesh/g17-audit`) and records the branch on the round and
the step. A failed push becomes a note on the step. Other profiles never push.

**Capacity.** A headless run counts toward `maxSessions` like a session. At the cap the offer is
accepted and the run is queued; queued runs start oldest first when a place frees up. A queued run
still waiting at its deadline (offer time + `thresholds.offer_expiry`) is released with the note
`capacity: no free session on <host> before the run deadline`.

**Close-as-fail.** A run that ends (exits, crashes, or is stopped for its budget) without an
accepted `mesh_done` while its machine and session still hold the step is closed by the daemon:
it stores a `transcript` artifact (the rendered tail of the run: last assistant texts, errors,
stderr; secrets redacted; never raw JSON) and finishes the step with outcome `fail`, summary
`headless run ended without mesh_done (exit <exit>)`. A step someone took over meanwhile is left to
its new holder. Runs outlive the daemon: a restarted daemon adopts runs that are still alive and
closes those that ended meanwhile. A machine that can run headless steps says so to the hub (it
needs mesh 0.1.15 and `workspaceRoots` with the repo); other machines are never offered one.

## Artifacts

**Artifact.** Output of a step's round that does not belong in the repo (a report, a review, a run
transcript), stored on the hub: `mesh_artifact` (MCP) from the session that holds the step.
- Kinds `report`, `review`, `transcript`; media types `text/markdown` (default),
  `application/json`, `text/plain`.
- Limits (hub YAML `artifacts`): `max_bytes` per artifact (default 1 MiB), `per_round` (default
  10) per step round. An artifact belongs to the round the holder is working on; `mesh_done` lists
  the round's artifact ids on the round.
- **Redaction on the machine.** The daemon removes private key blocks, known token forms
  (`ghp_…`, `glpat-…`, `xox…-`, `AKIA…`, `sk-…`, …), `password=…`-style values and its own key and
  hub token before sending; the hub records how many were removed. Redaction is best effort.
- **Team-visible.** Every member can read every artifact (`mesh artifact ls <G>`,
  `mesh artifact show <id>`). Artifact content never appears in hub events or in the ledger export,
  only ids and hashes.
- **Retention.** The content of artifacts of goals that are `done` or `dropped` is pruned after
  `retention_days` (default 365; 0 keeps it forever). Metadata and the SHA-256 stay.

## Telemetry

Each headless run reports `round.telemetry` to the hub (`POST /v1/steps/:id/run`): `runId`,
`model`, `agentKey` (`<repo name>/<agent>`) and `agentHash` (SHA-256 of the agent file), `profile`
and `profileHash`, `sessionId`, `turns`, `tokensIn`, `tokensOut`, `cacheRead`, `cacheWrite`,
`costUsdEstimate`, `durationMs`, `exit` (`success`, an `error_*` subtype of the CLI's result,
`killed_budget`, `crashed`, `no_result`), `permissionDenials` (count and tools), `tools`,
`mcpServers` and `redactions`.
- **Complete** when the run's stream ends with Claude Code's `result` event: the numbers are the
  CLI's own.
- **Partial** otherwise (killed, crashed): `turns` counts distinct assistant messages and is marked
  `turnsApprox: true`, tokens are summed once per message, `durationMs` comes from the daemon and
  there is no cost.
- The cost is the client's estimate (`total_cost_usd`), not a bill.

## Review records

**Review record.** A step with `output: review-record` (a review stage) records its findings as
structured data with `mesh_review`, then calls `mesh_done`. The step closes `done` only with a
record for its current round (REQ-5: `mesh_done` without one is refused with 409); with a record it
closes `done` whatever its outcome or verdict says. The record's `assessment` never fails the step,
and a step with `output` never reopens other steps: its record carries the findings.

A record has `subject` (`repo`, `commit`, `artifact`; `commit` defaults to `HEAD` of the step's
worktree), `coverage` (`complete` or `partial`), `scope` (paths looked at), `assessment` (`clean`,
`issues`, `blocked`), `items`, `dispositions` and `summary`. Each item has `key` (`rule`, `path`,
`symbol`), `title`, `severity` (`S1` most severe … `S4`), `category`, `evidence` (`path`, `lines`
`[start, end]`, `note`) and a `proposal`. The hub stores the record as a `review` artifact of the
round too (it does not count against `per_round`).

**Declared rules.** An agent lists the rules it checks in its front matter (`mesh-rules: [I-03,
secrets]`, or a comma-separated string) or in a sibling `<name>.rules.yaml` (a list, or a mapping
whose keys are rule ids). A `key.rule` the agent does not declare is recorded as `other:<slug>` and
counted (`undeclaredRules`, also in a headless run's telemetry). With no agent, every rule is
`other:<slug>`.

**Fingerprint.** An item's identity: the first 16 characters of the lowercased base32 SHA-256 of
`rule`, the normalised `path` (relative to the repo root, `/` separators) and `symbol`. Line
numbers, title, severity and evidence never enter it, so a finding keeps its identity when code
moves.

**Evidence hash.** The daemon reads each evidence region (`lines`) at `subject.commit` (`git show`)
and hashes it with whitespace collapsed: `eh`. A region that cannot be read hashes as `missing`.
Agent-written text never enters it; a moved region keeps its hash, an edit inside it changes it.

**Lineage.** Records of the same reviewer on the same repo form a lineage `<preset>|<repo>|<agent>`
(the goal's preset name or `-`; the step's repo; the step's `agent`, else its local id). A
consuming step belongs to the lineage of its run (the first raising step up its deps).

**Fold.** The hub folds each raising record (a step with `output` and no `consumes`) against the
**fold base**, the last complete raising record of its lineage: each item is `new`, `repeat` or
`regression`; with `coverage: complete`, an item of the base that is absent now is `resolved`. A
partial record is folded for new, repeat and regression but resolves nothing and is never a base;
consuming records are never a base either. The round of the step gets `fold` (counts of `new`,
`repeat`, `regression`, `resolved` and `carried`); `findings` keeps its own meaning.

**Item states.** Each fingerprint of a lineage has one item with a state and a history:

| From | Event | To |
|---|---|---|
| (none) | raised | `open` (`new`) |
| `open`, `confirmed`, `accepted` | raised again | unchanged (`repeat`) |
| `dismissed` | raised again with the same `eh` | `dismissed` (`repeat`, carried) |
| `dismissed` | raised again with another `eh` | `open` (`regression`) |
| `deferred` | raised again, `until` passed | `open` (`repeat`) |
| `deferred` | raised again, `until` not passed | `deferred` (`repeat`) |
| `resolved` | raised again | `open` (`regression`) |
| any | absent from a complete record whose base held it | `resolved` |
| a consumed state | a disposition | `confirmed`, `dismissed`, `deferred` (with `until`) or `accepted` (with `link`) |

**Dispositions.** A consuming step (`consumes: [open]`, for example a validator) records
dispositions in its own `mesh_review` record, each with the item's fingerprint, a reason and the
decider: an agent (a headless step, by its agent key and hash) or a person (an interactive step, by
the caller). It may set only the dispositions in its `may_set`, and only on items of its run's
record whose state is in its `consumes`. A record with a problem (a disposition outside `may_set`,
`deferred` without `until`, a fingerprint listed twice or not in the run's record, an item in a
state the step does not consume) is refused whole with 422. **Person precedence:** when a person
decided an item in the same goal, a later agent disposition of it is ignored (listed as ignored, the
record is still accepted). Across goals the latest disposition applies; the history keeps all.

**Conditional stages.** `when: {open: true}` or `when: {min_severity: S2}` (with `consumes`) makes a
step run only when its run's record has an item in a consumed state (at or above that severity).
Otherwise the step becomes **`skipped`** (summary `skipped: no item of <run> is …`, event
`step.skipped`), counts as satisfied for its dependants, and a goal whose steps are all `done`,
`skipped` or `dropped` is done. The hub decides a `when` step when its dependencies are done (plan
approve, step done, gate decide, reopen, resume). A skipped step is decided again only when a
dependency is reopened or a new plan changes it; a later disposition does not un-skip it.

**Inputs.** `inputs: [previous]` serves a raising step the fold base of its lineage;
`inputs: [dispositions]` serves a consuming step the items it may act on now (a raising step: its
lineage's items that are not resolved), with their history. Both arrive fenced as untrusted input,
like artifacts.

## Pulses

**Pulse.** A hub schedule that runs a preset by itself: at each **slot** it creates a goal with an
approved plan from the preset (no design step, no approval round) and offers the goal's first step
to a machine that can run it now. `mesh pulse add --preset audit-relay --repo alpha --params
agent=auditor,validator=checker,filer=filer --every 7d` makes one; its owner is whoever saved it.

**Snapshots (R-6).** What a slot runs is pinned when the pulse is saved: the preset text (sent by
the CLI, with its sha256 and, for a repo file, the repo and commit it came from) and every
permission profile its steps use (resolved on the hub). Later edits of the repo's
`.mesh/presets/<name>.yaml` or a replaced profile (`mesh profile add`) never change what the next
slot runs; `mesh pulse update --preset …` (or new `--params`) takes a new snapshot and bumps the
pulse's `version`. Saving the pulse is the plan approval of every slot until that update. Goals
made by a pulse keep the profile snapshot (`profiles`); their headless steps are offered only with
it, and a step whose profile is not in it is not offered. The agent definition file is not pinned
yet: the run reads it from the run's worktree.

**Schedule.** `--every <duration>` (`30m`, `4h`, `7d`; 5 minutes to 366 days) counts periods from
an anchor: `--at <ISO>` when given (an `--at` in the future is the first slot, however far ahead),
else the save time, so the first slot is one period after saving. `--cron "<5 fields>" --tz <zone>`
uses standard 5-field cron (minute, hour, day of month, month, day of week; `*`, lists, ranges,
steps; day of week 0 or 7 is Sunday; when both day fields are restricted either may match) in an
IANA time zone (default: the CLI's zone); it may fire at most every 5 minutes. Daylight saving: a
slot in the spring-forward gap runs at the first minute after the gap (02:30 → 03:00), and a slot in
the repeated autumn hour runs once, at its first occurrence.

**Slots.** Every slot is recorded, with a reason when it did not run: `fired` (a goal was created;
the slot's run **started** once the first step reported a headless run start, or an interactive
first step was claimed), `skipped` (`overlap`), `missed` (`no_machine`, `not_accepted`, `capacity`,
`expired`, `hub_down`, `error`) or `abandoned` (`max_goal_age`). `mesh pulse show <id>` lists them.

**Machine choice and window.** The first step is offered by the owner to the first candidate in
`mesh assign --suggest` order among machines that are online, have the step's repo, auto-accept an
offer from the owner (their accept policy), carry every `--labels` label (a filter, never a rank
key), can run headless steps when the step is headless, and match `--machines` when given. Each
machine is tried at most once per slot. An offer not accepted within a third of the window (at most
the hub's offer expiry) is withdrawn and the next candidate gets one; a decline or a release (a run
queue full: `capacity`) moves on too. The goal's stick is set to the machine, so later steps follow
it. The **window** (`--window`, default the smaller of 4 hours and the period) runs from the slot's
due time: a slot whose run has not started when it ends is `missed` and its goal is dropped. An offer
a person made meanwhile (`mesh assign`) is left alone until it ends.

**Overlap and `maxGoalAge`.** With `--overlap skip` (the default) a slot is `skipped` while a goal of
an earlier slot is unfinished; `allow` fires anyway. A started goal older than `--max-goal-age`
(default twice the period) is dropped at the next slot, which is recorded `abandoned`; a goal that
never started is ended by its window instead.

**Downtime.** Slots that passed while the hub was down are recorded `missed`/`hub_down` (the 10
latest at most). The latest one still fires when its window has not ended; with `--missed
catch-up-once` it fires anyway (marked `catchUp`), with the default `record` it does not.

**Manual fire.** `mesh pulse fire <id>` fires a slot now (`manual:<ULID>`), also while the pulse is
paused; it counts for overlap and does not move the schedule. `pause`, `resume` (slots passed while
paused are not recorded), `update` and `rm` (its goals stay) are for the owner or an admin. A pulse
whose owner is no longer a member pauses itself at its next slot.

**Pulse goals** carry `refs.pulse` and `refs.slot` and are left out of goal lists (`mesh goal ls`,
the dashboard) unless asked for (`mesh goal ls --pulses`, `GET /v1/goals?pulses=1`); a goal page,
its steps, offers and attention items show them as usual.

**Ingest.** `POST /v1/goals/from-preset` (scope `goals:write` for a service token) runs the same
create-with-plan for another system: a goal owned by the caller, with an approved plan and the
profile snapshot, and no design step. Ingest goals are listed as usual and are not offered by
themselves.

**Built-in `audit-relay`.** Three headless review stages: `audit` (`{agent}`, profile
`read-only`) raises findings; `validate` (`{validator}`) runs only when items are open and confirms
or dismisses them; `file` (`{filer}`, profile `propose-via-branch`) runs only when items are
confirmed, proposes an entry for each on the run's branch and records it `accepted` with its link.
It needs params `agent`, `validator` and `filer`. It stays agent-only; a repo that wants its owner to
decide the findings adds a debrief stage in its own `.mesh/presets` (see *Debriefs*).

## Debriefs

**Debrief step.** A step with `mode: debrief` is a person's review of the items an earlier stage
raised, run in an interactive Claude session that goes through the items one at a time. Its
`assignee` is `@owner` (the goal's owner, read at each check, so a change of owner moves the
debrief) or a user id. Defaults: `consumes: [open, confirmed]` and `assignee: "@owner"`. It needs
`output: review-record` and `may_set` (the decisions the person may record); it can't be a gate, and
`profile`, `budget` and `agent` stay headless-only.

**Never offered.** A debrief is never offered: `mesh assign` (step and goal), a goal's stick and
pulses leave it out, and ready lists (`mesh next`, `mesh_next`, the TUI `n` key, autopilot) do not
show it. Only its assignee can claim, accept or take it over (403 for anyone else, admins and the
goal owner included). The assignee finds it under **Assigned to you** (web Mine page, TUI `o`).

**Pre-read.** The web step panel of a debrief shows the run's report and the items (severity,
title, state, and `possible repeat of <fp>` for a near-match: another item of the lineage with the
same rule and path, or the same rule and symbol in another file). **Mark as read** records the read
(`POST /v1/steps/:id/read`, assignee only); the round keeps it (`read`) when the step is done.

**Running it.** `mesh debrief <step>` checks that you are the assignee and the step is ready (or
yours already), warns when you have not marked the pre-read or the `mesh-debrief` skill is missing,
then runs `mesh run <repo> --step <step>` with a prompt that names the skill. The `mesh-debrief`
skill (installed by `mesh setup`) has the session call `mesh_context` (its `debrief items` input
lists the items most severe first, with evidence locations and near-matches; the report is another
input, both fenced as untrusted data), show each item with its evidence read from the repo, ask the
person, and record the decision with `mesh_dispose`: the disposition, the reason and `answer`, the
person's own words (the daemon redacts secrets in both). Each decision is applied at once, stored
with `via: debrief-session` (record dispositions of stages have `via: stage`) and decider the
person, and added to the step as a note (`debrief: accepted <fp> "<title>": <reason>`). A person may
change a decision in the same round with another `mesh_dispose`.

**The debrief's own record.** The session ends with `mesh_review` (`items: []`, the latest decision
per item, or none) and `mesh_done`. Only the holder may submit it. A disposition in it for an item
decided with `mesh_dispose` is never applied twice: the same decision is listed in `already` (also
when the person reverted it meanwhile, so the revert stays); another one is a problem. Other
dispositions are applied as usual (with `via: debrief-session`).

**Revert.** Each debrief decision can be reverted with one key while it is the item's latest change
(`u` in the TUI `o` panel, Revert on the Mine page or the step panel; `POST
/v1/steps/:id/dispositions/revert`), by the deciding person, the goal owner or an admin. The item
goes back to the state it had before; the history keeps a `revert` entry (`via: ui`) and the step a
note. A revert does not re-run later stages. Person precedence applies to debrief decisions as to
any person's: a later agent disposition of the item in the same goal is ignored. Events never
carry answers, reasons or titles; notes and the item history do (team-visible).

## Offers and accept policy

**Offer.** Someone hands a ready step to a machine, or to a session on it: `mesh assign G7.api --to build-box` or `--to build-box/perf`. An offer is an overlay on a `ready` step: `offered`, then `accepted`, `declined`, `expired` or `withdrawn`. The step keeps its last offer (the goal page and `mesh show` show it). A goal is assigned through its ready steps (in a new goal: its design step).

- **Who.** Any member may offer a ready step that is not a gate. The target machine accepts it (a claim from that machine is an accept). The target machine's owner, or a user its accept policy names, may decline. The offerer or an admin may withdraw.
- **Claim guard.** While a step is offered, only the target machine can take it; the offerer may still claim it from elsewhere, which withdraws the offer. Other claims are refused. Ready-step lists (`mesh next`, `mesh_next`) leave out steps offered to other machines and list those offered to this one first.
- **Expiry.** An offer not accepted within `thresholds.offer_expiry` (hub configuration, default 30 minutes) expires; the step is ready for anyone again and the offerer sees it under attention.
- **Stick.** `mesh assign <G> --stick` also offers every later ready step of the goal to the same target, until `mesh withdraw <G>`.
- **Privacy.** The target of an offer, including a named session, is visible to everyone who can see the step, even a session the team cannot otherwise see (share level `me`). The offerer chose to name it.
- **Report back.** The offering session (MCP `mesh_assign` sends it; the CLI sends none) gets a message when the offer is accepted, declined or expires, and later when the step is done, fails, or its holder asks a question (the offerer may answer it). Releasing, reopening, replanning or taking over an accepted step drops the offer, so later holders' work is not reported.

**Accept policy.** Whose offers a machine takes automatically, decided by the hub when the offer is made: rules `self` (your own offers), `user:<id>`, `machine:<nickname or id>` (offers made from that machine; a nickname means one of your own machines), or `off`. The machine policy is `accept` in `daemon.json` (default `["self"]`), synced to the hub; a session may override it (`mesh session accept <session> --from user:bob`, `--off`, `--clear`). A machine whose daemon never reported a policy gets manual offers only.

**Assignments.** What the daemon does with an offer (`assignments` in `daemon.json`): `deliver` accepts an automatic offer for an idle session in the repo (the one with the most goal-topic labels) and sends it the brief, else lists the offer for you (`mesh offers`, the TUI's `o`, the web's **Mine** page) and notifies you; `launch` starts a session when none is idle; `off` declines every offer. Under `launch`, `maxSessions` in `daemon.json` (`mesh setup --max-sessions <n>|off`; absent = no limit) caps it: no session is started while that many are live on the machine (every non-ended session, plus sessions just launched for an offer that have not shown up yet, for up to two minutes); the offer is listed for you instead. It gates only the daemon's own launch for an offer, not `mesh run`, `mesh accept --launch` or a `claude` you start by hand.

**Suggest.** `mesh assign <goal|step> --suggest` (and the web's **Assign** button) ranks machines for an offer, each with a one-line reason. The subject is the step's repo (for a goal: the repos of the steps an assign would offer now, else its primary repo) and the goal's topics; the wanted labels are those topics and the repo names. Candidates are your machines, online or not; `--team` adds everyone's. A machine without the repo (neither in its repo inventory nor in a session you can see) is left out unless `--any`. The order is a strict key, earlier keys win: the accept policy takes your offer automatically; has the repo; wanted labels on its best idle session; wanted labels on the machine; online; number of idle sessions in the repo; last seen; machine id. Session facts (idle sessions, the best one, its labels) come only from sessions you can see: with `--team`, a teammate's idle session counts only when their machine shares `all`. With `--team` any member learns whether a teammate's machine has a given repo and which of its machine labels match the wanted ones, never its inventory list.
