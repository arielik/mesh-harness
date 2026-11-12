# Scheduled reviews: pulses, relays, debriefs, roster

A walkthrough, from an empty runner machine to a weekly agent audit whose findings are validated,
decided and filed, with numbers per agent. Every command and output below comes from a real run
(Claude Code, model haiku) on a small demo repo; ids, times and hashes will differ for you. For
the exact rules behind each part, follow the links into [concepts](concepts.md).

The example: one repo `demo` (four small JavaScript files with a hardcoded token, two `eval`s and
two TODO markers), one person `ann` who owns the schedule, and one machine of hers with the
nickname `runner` that does the work.

- [What it is](#what-it-is)
- [Prerequisites](#prerequisites)
- [Set up a runner machine](#set-up-a-runner-machine)
- [Write the agents](#write-the-agents)
- [Pick or write a relay preset](#pick-or-write-a-relay-preset)
- [Create and run a pulse](#create-and-run-a-pulse)
- [Read the results](#read-the-results)
- [Debrief: decide the findings yourself](#debrief-decide-the-findings-yourself)
- [How findings are compared from run to run](#how-findings-are-compared-from-run-to-run)
- [Calibration and agent statistics](#calibration-and-agent-statistics)
- [The roster: share agents between repos](#the-roster-share-agents-between-repos)
- [Goals from other systems (ingest)](#goals-from-other-systems-ingest)
- [Troubleshooting](#troubleshooting)

## What it is

A **pulse** is a schedule on the hub. At each slot it creates a goal from a **relay preset** (a plan
template whose steps review each other's output), with the plan already approved, and offers the
first step to a machine of yours that can run it now. That machine's daemon runs each step
**headless**: `claude -p` with one of your agents, in a throwaway git worktree, under a pinned
permission profile and a budget. The agents report through mesh's MCP tools: a report, a
structured **review record** of findings, and `mesh_done`. The hub compares each record with the
previous one (new, repeat, regression, resolved), later stages confirm, dismiss or file the
findings, and every dismissal counts against the agent that raised the finding.

```
hub: pulse p-1 "audit-relay on demo", every 7d
  │  slot due
  ▼
goal G7, plan approved from the preset snapshot ─────────► offer "audit" to runner
                                                            (online, has demo, your labels,
                                                             auto-accepts your offers)
runner (mesh daemon)
  audit     claude -p --agent auditor    → report + review record (items)
            hub folds it: new · repeat · regression · resolved
  validate  only when items are open     → confirmed / dismissed, with reasons
  debrief   you, interactive (optional)  → accepted / dismissed / deferred
  file      only when items wait         → accepted, with a link; branch mesh/g7-file
  ▼
goal done · mesh items · agent stats · a calibration goal after enough dismissals
```

Nothing here needs an API key: runs use the Claude Code login of the person whose daemon runs them.

## Prerequisites

- **mesh 0.1.22 on the hub and on every machine that runs or debriefs steps.** Upgrade the hub
  first, then the daemons, then run `mesh setup` on each machine (it installs the `mesh-debrief`
  skill). Older daemons can talk to the new hub but cannot run, or run worse, what this guide
  describes; see [Upgrading to 0.1.24](operations.md#upgrading-to-0124).
- **A team hub** you are logged in to (`mesh login`). In Solo mode the same commands go to the local hub,
  and your own machine is the only runner.
- **The repo has a git remote** on the runner. mesh names repos by their remote (`origin`, else
  the first one, e.g. `git.example.com/org/demo`, short name `demo`); a checkout without a remote is
  not in the machine's repo inventory, so it is never offered work and its agents are not on the
  roster.
- **The runner shares at `me` or `all`** (`shareSessions` in `daemon.json`). At `steps` the daemon
  sends no repo inventory, so the hub does not know the runner has the repo and a pulse never picks
  it (the slot is missed with `no_machine`).
- **Claude Code** logged in on the runner, as for any mesh machine ([install](install.md)).

## Set up a runner machine

Any machine with mesh can be a runner: a spare box, a VM, or your laptop. On it:

```sh
mesh setup --share-sessions me --accept self --assignments launch --max-sessions 2
mesh login --hub https://mesh.example --token <token>
mesh machine name runner          # a nickname, shown in offers and slots
mesh machine label runner         # optional: pulses can be pinned to machines with this label
```

Then add the folders that hold your checkouts to `workspaceRoots` in `~/.config/mesh/daemon.json`
(the daemon looks two folder levels deep). The runner of the example:

```json
{
  "port": 27832,
  "key": "…",
  "notify": "off",
  "workspaceRoots": ["/home/ann/src"],
  "autopilot": "off",
  "shareSessions": "me",
  "accept": ["self"],
  "assignments": "launch",
  "maxSessions": 2
}
```

| Field | For scheduled reviews |
|---|---|
| `workspaceRoots` | Needed. A daemon with no entry cannot run headless steps and says so to the hub. The repo must be checked out under one of them. |
| `shareSessions` | `me` or `all`, so the repo inventory reaches the hub (see Prerequisites). |
| `accept` | Whose offers are taken automatically. A pulse offers only to machines that auto-accept the pulse owner: `self` for your own pulses, `user:<id>` to run someone else's. A headless step offered manually waits and expires (`mesh accept` does not take one). |
| `assignments` | `deliver` or `launch` both run headless offers; `off` declines every offer. `launch` also starts an interactive session when someone offers this machine an interactive step. |
| `maxSessions` | Optional cap. A headless run counts like a session, and so do your own open sessions on that machine; at the cap a run is accepted and **queued** until a place frees, or released with the note `capacity: …` at its deadline. |

Restart the daemon after changing `daemon.json` (`mesh up`, or `mesh up --install` for a user
service), then check the machine from anywhere:

```sh
mesh machines                     # runner online, share me, its repos, labels
mesh doctor                       # on the runner: hooks, MCP server, mesh and mesh-debrief skills, daemon, hub
```

`MESH_CLAUDE_BIN` in the daemon's environment points runs at another `claude` executable.

### How a run is started and isolated

When an offer arrives the daemon:

1. accepts it (or queues it at `maxSessions`);
2. makes a detached worktree of its checkout at the checkout's `HEAD`, in a run folder
   `<stateDir>/runs/<run id>/` (Linux: `~/.local/state/mesh/runs/`);
3. starts `claude -p` in it with its own session id, the permission profile as settings, mesh as
   the only MCP server, and the agent passed with `--agents`/`--agent`;
4. registers the run's session and binds the step to it (no hooks needed);
5. watches the budget, and when the process ends sends telemetry, pushes the branch of a
   `propose-via-branch` run, and removes the worktree. The run folder stays.

What the run does **not** get:
- the repo's project settings, hooks, `.mcp.json`, `CLAUDE.md` and project agents
  (`--setting-sources user`, `--strict-mcp-config`): the brief, the agent and the inputs from
  `mesh_context` are its only instructions;
- your terminal: `TMUX`, `TMUX_PANE`, `MESH_AUTOPILOT` and `CLAUDE_PID` are removed from its
  environment;
- any messages: nothing is pasted into it and autopilot leaves it alone;
- push rights: only the daemon pushes, and only `propose-via-branch` runs, to `mesh/<step>`.

**Permission profiles.** `read-only` (the default: `Read`, `Grep`, `Glob`, `LS` and exact read-only
git commands; no edits, no web), `read-only+checks` (plus commands a registered profile lists, such
as `pnpm lint`), `propose-via-branch` (plus `Edit`, `Write`, `git add`, `git commit`). Every profile
also allows the four tools a run needs: `mesh_context`, `mesh_artifact`, `mesh_review`, `mesh_done`.
Register your own with `mesh profile add <name> --file profile.yaml`; `mesh profile show <name>`
prints the compiled settings. Profiles are best effort, not a sandbox: your user-level
`permissions.allow` in `~/.claude/settings.json` still applies to runs, so keep it small on a runner.
The full table is in [concepts](concepts.md#headless-steps).

**Budget.** `turns` (default 30), `minutes` (default 30) and optionally `usd` per step. Past the
minutes the daemon stops the run's whole process group; the step then fails with a transcript.

### What it costs

Each run is a Claude Code session on the runner's login and counts against that login's usage like
any other. The hub keeps the client's own numbers per run (turns, tokens, cache reads and writes,
`costUsdEstimate`, duration); `costUsdEstimate` is Claude Code's estimate, not a bill. In the demo,
an audit of four small files with haiku took 9-10 turns, about 15 seconds and an estimated $0.003; a
validator or filer run less. Your agents' `model`, the repo's size and the budgets decide the rest.
See the numbers per agent in [Calibration and agent statistics](#calibration-and-agent-statistics).

## Write the agents

Agents are ordinary Claude Code agent files in the repo: `.claude/agents/<name>.md`, committed. A
run reads the file from its worktree, so the runner runs what is committed at its checkout's `HEAD`
(or a pinned catalog definition, see [the roster](#the-roster-share-agents-between-repos)).

**Front matter.** The run uses `description`, `tools`, `model` and the body; the agent's name is the
file name (front matter `name` is ignored). mesh adds its four tools to `tools` when you list tools.
`mesh-rules` declares the rule ids the agent reports findings under; give it, because it keeps
findings stable from run to run (see [below](#how-findings-are-compared-from-run-to-run)).

The front matter must be valid YAML. The usual mistake is an unquoted `: ` inside `description`:

```yaml
description: Validates audit findings: confirms real issues        # invalid YAML
description: "Validates audit findings: confirms real issues"      # fine
```

An agent with invalid front matter is flagged on the roster, `mesh pulse add` warns about it, and a
run of it fails at start without spending a turn (see [Troubleshooting](#troubleshooting)).

**How an agent reports.** The brief tells the run to call `mesh_context` first. Then:

| Tool | When |
|---|---|
| `mesh_context` | first: the step's brief and its **inputs** (the previous record, the items it may act on, earlier steps' reports), fenced as untrusted data |
| `mesh_artifact` | to store a report (`kind: report`, Markdown by default) on the hub for the round; secrets are redacted on the machine first |
| `mesh_review` | once, for a step with `output: review-record`: the findings (`items`) of a raising step, or the decisions (`dispositions`) of a consuming one |
| `mesh_done` | last, with a short summary. On a step with `output: review-record`, `mesh_done` without a record is refused. |

A record's items each have a key `{rule, path, symbol}`, a `title`, a `severity` (`S1` most severe to
`S4`), a `category` and `evidence` (`path`, `lines: [start, end]`, `note`). A disposition names the
item's `fingerprint` (from the inputs), the `disposition` and a `reason`; `accepted` may carry a
`link`, `deferred` needs `until` (YYYY-MM-DD). `coverage: complete` says the agent looked at
everything in scope; only then do missing findings count as resolved.

### The three agents of the example

`.claude/agents/auditor.md`, the raising agent:

```markdown
---
name: auditor
description: Audits the repo for hardcoded secrets, eval of input and TODO markers
tools: Read, Grep, Glob
model: haiku
mesh-rules: [secret, eval, todo]
---
You are a small code auditor. Look only at the files under src/ (use Glob "src/**/*.js", then Read each file).
Rules:
- secret: a hardcoded credential or token string in source (severity S1)
- eval: eval() of untrusted input (severity S2)
- todo: a TODO marker left in code (severity S4)
Report one item per finding with key {rule, path, symbol}: path relative to the repo root, symbol the name of the
exported const or function that contains the finding (for example API_TOKEN, calculate, parsePort). Give a short title,
the severity above, category "security" for secret/eval or "hygiene" for todo, and evidence {path, lines}.
Report only what the files contain now; never repeat findings from earlier inputs that are no longer in the code.
In the report artifact, use one heading per finding of the form "### <n>. <rule>: <short title>", and quote each
offending source line verbatim in a code block.
Steps, keep it short: call mesh_context; read the files; store a short markdown report with mesh_artifact (kind report);
submit the findings with mesh_review (coverage complete, assessment issues or clean, items, summary); then call mesh_done.
```

`.claude/agents/validator.md`, a consuming agent that confirms or dismisses open findings:

```markdown
---
name: validator
description: "Validates audit findings: confirms real security issues, dismisses TODO markers"
tools: Read, Grep, Glob
model: haiku
mesh-rules: [secret, eval, todo]
---
You validate the open findings of an audit. Call mesh_context first: the input "dispositions" lists the open items
with their fingerprints. For each open item, read its evidence file and decide:
- rule secret or eval: confirm it (disposition confirmed) when the code matches, with a one-line reason.
- rule todo: dismiss it (disposition dismissed), reason "TODO markers are tracked in the issue tracker, not by audits".
Submit one mesh_review with items: [] (raise nothing new), coverage complete, assessment issues, the dispositions
(fingerprint, disposition, reason) and a short summary. Then call mesh_done. Keep it short.
```

`.claude/agents/filer.md`, a consuming agent that records each confirmed finding as filed. This one
only records a link; a real filer would also write an entry (it runs under `propose-via-branch`, so
it may edit and commit in its worktree, and the daemon pushes the branch):

```markdown
---
name: filer
description: Records confirmed findings as accepted, with a tracker link
tools: Read
model: haiku
---
Do not edit, write or commit anything. Call mesh_context: the input "dispositions" lists the confirmed items with their
fingerprints. Submit one mesh_review with items: [], coverage complete, assessment issues, summary "filed",
and a disposition for each confirmed item: disposition accepted, reason "recorded by the filer",
link "https://tracker.example.com/demo/<fingerprint>". Then call mesh_done.
```

Commit them and make sure the runner's checkout has the commit (`git pull` there): the run uses the
checkout's `HEAD`, not your working tree.

## Pick or write a relay preset

### The built-in `audit-relay`

`mesh preset show audit-relay` prints it. Three headless review stages:

| Step | Agent | Profile | Runs when | Does |
|---|---|---|---|---|
| `audit` | `{agent}` | `read-only` | always | raises findings; input `previous` (the last complete record, so it can reuse keys) |
| `validate` | `{validator}` | `read-only` | an item is `open` | confirms or dismisses each open item; inputs: the audit's report and the open items |
| `file` | `{filer}` | `propose-via-branch` | an item is `confirmed` and not yet filed | records each one `accepted` with its link |

Params: `agent`, `validator` and `filer` (required), `turns` (default 80) and `minutes` (default 60)
for the audit's budget. `validate` and `file` get the default budget (30 turns, 30 minutes). A stage
that has nothing to do is **skipped** and the goal still finishes.

### Your own relay in `.mesh/presets`

A repo preset is a YAML file `.mesh/presets/<name>.yaml`, committed. `mesh preset ls` lists it next
to the built-ins (from the current folder up to the top of the checkout). Steps default to the repo
`{repo}`; `{param}` placeholders are filled from `--params`, or from the preset's own `params:`
defaults. This one adds a debrief by the goal owner and smaller budgets:

```yaml
# .mesh/presets/audit-debrief.yaml
description: Audit, validate, the owner's debrief, file
params: { turns: 20, minutes: 15 }
steps:
  - id: audit
    kind: review
    mode: headless
    agent: "{agent}"
    profile: read-only
    output: review-record
    inputs: [previous]
    budget: { turns: "{turns}", minutes: "{minutes}", usd: 0.5 }
    title: "Audit {repo}"
    brief: "Audit {repo}. Report every finding you see, with keys from your declared rules; the hub works out what is new."
  - id: validate
    kind: review
    deps: [audit]
    mode: headless
    agent: "{validator}"
    profile: read-only
    output: review-record
    when: { open: true }
    consumes: [open]
    may_set: [confirmed, dismissed]
    inputs: [audit, dispositions]
    budget: { turns: 15, minutes: 10 }
    title: Validate the findings
    brief: Try to refute each open item from the source; confirm or dismiss each with a reason.
  - id: debrief
    kind: review
    deps: [validate]
    mode: debrief
    output: review-record
    when: { open: true, min_severity: S2 }
    consumes: [open, confirmed]
    may_set: [accepted, dismissed, deferred]
    title: Decide the findings
    brief: Go through the findings with the goal owner, one at a time.
  - id: file
    kind: docs
    deps: [debrief]
    mode: headless
    agent: "{filer}"
    profile: propose-via-branch
    output: review-record
    when: { open: true }
    consumes: [accepted]
    may_set: [accepted]
    inputs: [dispositions]
    budget: { turns: 12, minutes: 10 }
    title: File the accepted findings
    brief: Propose an entry for each accepted item on this run's branch, then submit a review record that sets each one accepted with its link.
```

(The filer agent of this preset reads the **accepted** items, not the confirmed ones.)

The fields, in short ([concepts](concepts.md#review-records) has the rules):

| Field | Meaning |
|---|---|
| `mode` | `headless` (a machine runs it), `debrief` (a person, see below) or `interactive` (the default: any session) |
| `agent`, `profile`, `budget` | headless only: the agent (a file name in `.claude/agents/`, or a roster key), the permission profile, `turns`/`minutes`/`usd` |
| `output: review-record` | the step closes `done` only with a review record; what the record says never fails the step |
| `consumes` | the item states the step acts on (`open`, `confirmed`, `dismissed`, `deferred`, `accepted`); a step with `consumes` decides items, it does not raise them |
| `may_set` | the decisions it may record: `confirmed`, `dismissed`, `deferred`, `accepted`. A filer needs `accepted` here to record its links. |
| `when` | `{open: true}`: run only when an item of this run is in a consumed state; `{min_severity: S2}` also needs one at or above that severity. Otherwise the step is `skipped`. |
| `inputs` | what `mesh_context` serves: `previous` (the last complete record), `dispositions` (the items it may act on now), `artifacts` (reports of its dependencies) or a step id (that step's reports) |
| `assignee` | debrief only: `@owner` (the default: the goal's owner) or a user id |

A pulse preset needs exactly one first step (no `deps`, not a gate). A step id is lower-case letters,
digits and dashes. Use it once by hand before you schedule it:

```sh
mesh goal new "Try the relay" --repo demo
mesh goal plan G8 --preset audit-debrief --repo demo --params agent=auditor,validator=validator,filer=filer
mesh assign G8 --to runner
```

## Create and run a pulse

Run `mesh pulse add` from inside the repo when the preset is a repo file (the CLI reads it from the
current folder and sends a snapshot of it to the hub); a built-in preset works from anywhere.

```sh
mesh pulse add --preset audit-relay --repo demo \
  --params agent=auditor,validator=validator,filer=filer,turns=15,minutes=10 --every 7d
#   Created pulse p-2 "audit-relay on demo": every 7d, next run 2026-11-19T16:16:04.427Z.
```

The pulse is yours (its owner): its goals are owned by you, and saving it approves the plan of every
slot. What a slot runs is pinned when you save it: the preset text, the permission profiles it
uses and any roster agent (by hash). Editing `.mesh/presets/…` later changes nothing until
`mesh pulse update p-2 --preset audit-debrief` (from the repo) takes a new snapshot. A repo agent
(`agent: auditor`) is not pinned: each run reads it from the runner's checkout.

Flags of `mesh pulse add` (and `update`, except `--paused`):

| Flag | Meaning |
|---|---|
| `--every <dur>` | a period: `30m`, `4h`, `7d` (5 minutes to 366 days), counted from `--at <ISO>` when given, else from now (the first slot is one period away) |
| `--cron "<5 fields>" --tz <zone>` | standard cron in an IANA time zone (default: your CLI's), e.g. `--cron "0 9 * * 1" --tz Europe/Berlin` for Mondays 09:00; at most every 5 minutes |
| `--labels a,b` / `--machines a,b` | only machines with every label / only these machines |
| `--window <dur>` | how long after the slot's time the run may start (default the smaller of 4h and the period; 1m to 30d). A slot whose run has not started by then is `missed` and its goal dropped. |
| `--overlap skip\|allow` | `skip` (default): no new goal while one of an earlier slot is unfinished |
| `--max-goal-age <dur>` | a started goal older than this is dropped at the next slot, recorded `abandoned` (default twice the period; 1h to 366d) |
| `--missed record\|catch-up-once` | slots that passed while the hub was down: only recorded (default), or the latest one still fires |
| `--title`, `--topics`, `--paused` | the goals' title, topics; create it paused |

The other commands:

```sh
mesh pulse ls                     # --mine: only yours; --json
#   p-1  paused  @ann  every 7d  next -  last fired  audit-relay on demo
#   p-2  active  @ann  every 7d  next 2026-11-19T16:16:04.427Z  last fired  audit-relay on demo
mesh pulse fire p-2               # a slot now (also while paused); does not move the schedule
#   Fired pulse p-2: slot manual:01M788WWN19A00CN1Y9AXJ8JF4 → G7.
mesh pulse show p-2               # --json for everything, including a fire error's text
#   p-2 "audit-relay on demo"  @ann  active
#   schedule: every 7d, next 2026-11-19T16:16:04.427Z
#   preset: audit-relay 999b7a4eb79b, params agent=auditor,validator=validator,filer=filer,turns=15,minutes=10,repo=demo
#   target: any machine that auto-accepts
#   slots:
#     manual:01M788WWN19A00CN1Y9AXJ8JF4  fired  G7  tried m-f0a5e736
#     manual:01M788V7D7ZR5FW6YCTNEG1YMS  fired  G6  tried m-f0a5e736
mesh pulse pause p-2              # slots passed while paused are not recorded
mesh pulse resume p-2
mesh pulse update p-2 --window 2h --labels runner
mesh pulse rm p-2                 # its goals stay
mesh goal ls --pulses             # pulse goals are left out of goal lists otherwise
```

`pause`, `resume`, `update` and `rm` are for the owner or an admin. A `mesh pulse fire` while a goal
of an earlier slot runs prints `Pulse p-2 skipped slot …: G7 is still running (overlap: skip).`

**Which machine.** At a slot the hub offers the first step, as you, to the first machine in
`mesh assign --suggest` order that is online, has the repo, auto-accepts your offers, carries every
`--labels` label, can run headless steps, and is in `--machines` when given. An offer not accepted
within a third of the window moves on to the next machine; each machine is tried once per slot.
The goal then sticks to that machine, so its later steps go there too.

**Every slot is recorded**, with a reason when it did not run:

| State | Reason | Meaning |
|---|---|---|
| `fired` | | a goal was created (its run started, or is about to) |
| `skipped` | `overlap` | a goal of an earlier slot was still unfinished |
| `missed` | `no_machine` | no candidate: nothing online with the repo, the labels and an accept policy that takes your offer |
| | `not_accepted` | every candidate declined or did not answer in time |
| | `capacity` | the runner's queue was full until the deadline |
| | `expired` | accepted, but the run did not start before the window ended |
| | `hub_down` | the hub was not running at the slot's time |
| | `error` | the fire failed; the text is in `mesh pulse show --json` |
| `abandoned` | `max_goal_age` | the earlier goal ran too long and was dropped |

You see them in `mesh pulse ls` (the last slot), `mesh pulse show` (the latest slots, with the
machines tried) and on the web **Mine** page under **Pulses** (your pulses and their recent slots).

## Read the results

```sh
mesh show G7
#   G7 · audit-relay on demo (manual:01M788WWN19A00CN1Y9AXJ8JF4)
#   done · owner @ann · 3/3 steps done · demo
#   sticks to runner: its next ready steps are offered there (mesh withdraw G7)
#   steps: 3 done
#   plan v1 approved by @ann
#
#   start
#     ✓ audit     review    demo             done     offered to runner → accepted by runner/worktree-13  — Audited src/run.js, src/config.js, src/util.js and src/calc.js. Five findings: …
#   then (after audit)
#     ✓ validate  review    demo             done     offered to runner → accepted by runner/worktree-cb  — Checked all five G7.audit findings against source. …
#   then (after validate)
#     ✓ file      docs      demo             done     offered to runner → accepted by runner/worktree-1a  — Filed the confirmed item t6f6zxy5uazi6nsb …
```

A step with nothing to do shows `↷ … skipped` and counts as done. The reports and records:

```sh
mesh artifact ls G7
#   a-01M788X56WD4PTWM16WRC1P73Q  G7.audit r1  report  691 B  Audit demo: src/*.js findings
#   a-01M788X7DKNQD6M2XV6QE0BAF1  G7.audit r1  review  2261 B  review record
#   a-01M788XR4SP0Q519P1QJE27KT3  G7.validate r1  review  700 B  review record
#   a-01M788XV0CD204N4HJ81V0J93Q  G7.validate r1  report  744 B  G7.validate: validation of audit findings for demo
#   a-01M788Y2S1XEH7H413PZVDYEZV  G7.file r1  review  314 B  review record
mesh artifact show a-01M788X56WD4PTWM16WRC1P73Q
#   # Audit demo: src/*.js findings
#   …
#   ### 1. secret: Hardcoded API token in API_TOKEN
#   export const API_TOKEN = "[REDACTED]";
```

The token in the source was replaced on the runner before the report left it (see
[Troubleshooting: redaction](#redaction)). The review record (`kind: review`) is JSON: each item with
its fingerprint (`fp`), evidence hash (`eh`) and its `mark` in this run (`new`, `repeat`,
`regression`).

The findings themselves, across all runs of the lineage:

```sh
mesh items G7.audit               # or by lineage key: mesh items 'audit-relay|demo|auditor'
#   ngkbp5u46dadarew  accepted  S1  secret  src/config.js  Hardcoded API token in API_TOKEN
#   t6f6zxy5uazi6nsb  accepted  S2  eval  src/calc.js  eval() of untrusted input in calculate
#   gdiea6ozenkfw5ru  accepted  S2  eval  src/run.js  eval() of user-supplied code in runScript
#   ph2vnwa44lzrfvta  dismissed  S4  todo  src/util.js  TODO marker in parsePort
#   2ea4nufsrv3rdxyh  dismissed  S4  todo  src/util.js  TODO marker in formatHost
mesh items G7.audit --all         # resolved items too
mesh items G7.audit --json        # each item's history: fold marks, dispositions with reason, decider, link
```

On the web:
- **Mine → Pulses**: your pulses, their schedule and recent slots with reasons.
- **Mine → Assigned to you**: debriefs waiting for you, and decisions you made in debriefs (with
  Revert).
- **Goals → G7**, a step's panel: summary, holder, rounds; for a failed step the reason and a
  **Resume** button; for a debrief the pre-read.
- **Needs attention** (home): a failed step of a goal you own, with its reason.
- **Roster**: agents by name and version, flags, and **Stats** per agent.

Per-run numbers (`round.telemetry`: model, agent key and hash, profile, turns, tokens, cost estimate,
duration, exit, permission denials, tools used, redactions) and fold counts are in the goal's JSON
(`GET /v1/goals/G7`) and in the `run.finished` and `review.recorded` events.

## Debrief: decide the findings yourself

A `mode: debrief` step (the `debrief` step of the preset above) is yours: it is never offered to a
machine and never shows in ready lists; only its assignee can claim it. When the stages before it are
done it appears under **Assigned to you** on the web Mine page and in the TUI's `o` panel
(`mesh debrief G9.debrief  ready  3 item(s)  "Decide the findings"`).

1. **Pre-read.** Open the step's panel on the goal page: the run's report and the items (severity,
   title, state, and `possible repeat of <fp>` when a finding looks like another one in the
   lineage). Press **Mark as read**.
2. **Run it** on a machine with the repo:

   ```sh
   mesh debrief G9.debrief          # [--session NAME] [--no-tui]
   ```

   It checks that you are the assignee and the step is ready, warns (without stopping) when you have
   not marked the pre-read or the `mesh-debrief` skill is missing (`mesh setup` installs it), then
   starts an interactive Claude session in tmux that holds the step.
3. The session goes through the items one at a time, most severe first: title, severity, the
   evidence read from the repo (not the agent's quote), earlier reasons (such as the validator's),
   near-matches. You answer; it records your decision at once with `mesh_dispose`, your words as
   the answer, and adds a note to the step. It may only record what the step's `may_set` allows;
   `deferred` needs a date. Skip an item and nothing is recorded for it.
4. At the end it stores a short transcript, submits the debrief's record and calls `mesh_done`. The
   filer then runs if you accepted something.

**One-key revert.** Changed your mind? While a decision is the item's latest change, revert it: `u`
on the entry under DECIDED IN DEBRIEF in the TUI `o` panel, or **Revert** on the Mine page or the
step panel. The item goes back to its earlier state; the history keeps both. A revert does not re-run
later stages.

A person's decision outranks an agent's in the same goal: a later agent decision of the item is
ignored (an agreeing one, such as the filer recording its link on an item you accepted, is applied).

## How findings are compared from run to run

Each raising agent on each repo has a **lineage**, `<preset>|<repo>|<agent>` (here
`audit-relay|demo|auditor`). Every finding gets a **fingerprint** from its rule, its path and its
symbol: never the line numbers, the title or the wording. When a new complete record arrives, the
hub compares it with the last complete record of the lineage:

| Mark | In plain words |
|---|---|
| `new` | never seen in this lineage |
| `repeat` | reported again; it keeps its state (still `open`, still `confirmed`, still `accepted` with its link) |
| `carried` | a repeat of a **dismissed** finding whose evidence did not change: it stays dismissed, nobody looks at it again |
| `regression` | it was resolved and is back, or it was dismissed and its evidence lines changed: it is `open` again |
| `resolved` | in the previous complete record, missing now |

In the demo, the first audit (G3) found 3 `new` items; the validator confirmed two and dismissed the
TODO, and the filer filed the two. The next audit (G4) reported the same three: 3 `repeat`, 1
`carried`, nothing open, so `validate` and `file` were **skipped** and cost nothing.

Things to know:
- **Declared rules keep fingerprints stable.** A rule the agent does not declare in `mesh-rules` is
  recorded as `other:<slug>` of whatever words it used this time, so the same finding can come back
  under another key and look `new`. Declare your rules and tell the agent to reuse the keys of the
  previous record (the `previous` input serves them). Undeclared rules are counted
  (`undeclaredRules`).
- **The symbol is part of the identity.** Ask for a stable symbol (the function or constant that
  contains the finding), not a line or a phrase.
- **`coverage: complete` resolves; `partial` never does.** An agent that skips a file but still says
  `complete` resolves that file's findings, and they come back as `regression` next time. Use
  `partial` (with `scope`) when it looked at part of the repo.
- **The evidence hash** is computed on the runner from the code at `lines`, so a dismissed finding
  reopens only when that code changes, not when code above it moves.

## Calibration and agent statistics

Every dismissal counts against the agent that raised the finding, whoever dismissed it (an agent
stage or a person), once per goal and item; a reverted dismissal does not count. When a person
decides otherwise on an item an agent dismissed, that counts as `reinstated` against the dismissing
agent (for example the validator).

**Threshold.** When one agent version (hash) has `calibration.threshold` uncalibrated dismissals
(`mesh-hub.yaml`, default 5), the hub opens a goal `Calibrate <key>@<hash12>` for its calibrator: the
catalog source's `calibrator`, else the owner of the latest pulse goal that ran the agent, else the
owner of the goal of the latest dismissal. Its one step is interactive:

```sh
mesh run demo --step G21.calibrate
```

The session reads the input `calibration` (each dismissed finding with its reason, who dismissed
it, the evidence, and the agent's definition) and either changes the agent on the step's branch so
such findings are no longer raised (`assessment: "issues"`), or records `assessment: "clean"` with a
summary `no change: <why>`. When the goal is done those dismissals are calibrated; the count starts
again. At most one calibration goal per agent hash is open.

**Statistics.** `GET /v1/agents/<repo>%2F<name>/stats?days=30` (members, or a service token with
`goals:read`), and the same numbers under **Stats** on the web Roster page. For the demo's auditor:

```json
{
  "key": "demo/auditor", "days": 30, "threshold": 5,
  "hashes": [{
    "hash": "d8f09bd2ee83…", "runs": 5, "failures": 0,
    "raised": 18, "new": 5, "regressions": 1, "carried": 5, "undeclaredRules": 0,
    "accepted": 4, "dismissedByAgents": 2, "dismissedByPeople": 0, "reinstated": 0,
    "uncalibrated": 2, "calibrating": 0, "calibrated": 0,
    "meanCostUsd": 0.002508002, "meanDurationMs": 15386, "lastAt": 1794500397857
  }]
}
```

Read it per hash: a new version of the agent file starts fresh. Many dismissals and few accepts
mean a noisy agent; regressions and undeclared rules mean unstable keys; failures and cost tell
whether it earns its schedule. Field meanings: [concepts](concepts.md#agent-statistics).

## The roster: share agents between repos

The hub lists the agents of every repo the machines report and of registered catalog repos:

```sh
mesh agents                        # --name <name>, --json
#   auditor  versions 1  copies 1
#     d8f09bd2ee83  Audits the repo for hardcoded secrets, eval of input and TODO markers
#       demo/auditor  repo
#   broken  versions 1  copies 1  invalid
#     b7bf18f76c4b  invalid: front matter is not valid YAML: Nested mappings are not allowed in compact mappings at line 2, column 14
#       demo/broken  repo
```

A daemon reads `.claude/agents/*.md` (and `.opencode/agent/*.md`) of its remote-backed checkouts
under `workspaceRoots` on its repo scan, at share `me` (only you see your copies) or `all`. It sends
front matter and hash, never the text. Flags: `diverged` (several versions of one name), `pinned`,
`modified` (differs from its pin), `behind` (the catalog moved on), `invalid` (front matter is not
valid YAML).

**Catalog sources.** An admin registers a repo that holds shared agents; a machine with a checkout
of it pushes the committed definitions at the remote's default branch, with their text:

```sh
mesh agent source add https://git.example.com/org/agents.git --folder agents --calibrator ann
mesh agent source ls
```

**Install by reference** into a repo, then keep it current (commit both files):

```sh
mesh agent add agents/reviewer --repo ~/src/demo      # writes .claude/agents/reviewer.md, pins it in .mesh/agents.lock
mesh agent outdated --repo ~/src/demo                 # ok, modified, behind, missing, gone; exit 1 unless all ok
mesh agent diff reviewer --repo ~/src/demo
mesh agent update reviewer --repo ~/src/demo          # asks first; --yes without a terminal
```

A headless step can also run a catalog agent its repo does not contain: `agent: agents/reviewer`
(or `agents/reviewer@<hash or commit>`), pinned by hash when the plan is approved or the pulse saved.
Rules of a catalog agent come from its front matter `mesh-rules` only. Details:
[concepts](concepts.md#roster).

## Goals from other systems (ingest)

Another system (a CI job, a bot that watches pull requests) can create the same kind of goal without
a pulse: `POST /v1/goals/from-preset` with a service token that has scope `goals:write`
(`mesh hub token --service <name> --scope goals:write --config mesh-hub.yaml`, on the hub). The body:

```json
{
  "preset": { "name": "audit-relay", "text": "<preset text>", "sha256": "<sha256 of text>" },
  "params": { "repo": "demo", "agent": "auditor", "validator": "validator", "filer": "filer" },
  "title": "Audit demo for a change",
  "refs": { "change": "PR-123" }
}
```

`text` is the preset's YAML (a repo preset file, or a built-in as `mesh preset show <name>` prints
it); `sha256` is the hex SHA-256 of exactly the text you send. The goal is owned by the caller, its plan is approved, the profiles and roster agents are
pinned as for a pulse. It is not offered by itself: offer its first step (`mesh assign`, or
`POST /v1/steps/:id/assign`). `refs` are your own ids (`pulse` and `slot` are reserved); they do not
enter the lineage, so an ingest goal of the same preset, repo and agent is folded together with the
pulse's goals. Use another preset name (or agent) when its findings should be compared separately.
Pull-request intake will build on this route.

## Troubleshooting

### A run fails at start

The step is `failed` at once and no tokens are spent. `mesh show` marks it `✗ … failed`; the reason
is on the step's panel (and under **Needs attention**) and in the runner's daemon log:

```
run g2-audit-mwdr26f7: headless run of G2.audit did not start: agent broken has invalid front matter: front matter is not valid YAML: Nested mappings are not allowed in compact mappings at line 2, column 14
run g1-audit-mwdr1wev: headless run of G1.audit did not start: could not make a worktree: fatal: could not create directory of '.git/worktrees/worktree': Permission denied
```

| Reason starts with | Fix |
|---|---|
| `agent <name> has invalid front matter` | quote the `description` (or fix the YAML), commit, pull on the runner. `mesh agents` shows `invalid` until the next scan. |
| `could not make a worktree: fatal: …` | git's own error. Usually the daemon cannot write the checkout's `.git` (permissions, a sandbox). `… already exists` means a daemon stopped in the middle of a start left the run's worktree folder: remove `<run dir>/worktree` and run `git worktree prune` in the checkout. |
| agent missing, roster definition not available, missing profile | the agent file is not in the runner's checkout at `HEAD`; the catalog definition was never pushed; the profile was removed. |

A failed step leaves its goal open, and with `--overlap skip` the next slots are skipped until the
goal is older than `--max-goal-age` and abandoned. After fixing the cause, either resume the step
(`mesh step resume G2.audit`, or **Resume** on its panel; it is offered to the machine the goal
sticks to) or fire a fresh slot once the old goal is out of the way.

`mesh pulse add` and `mesh pulse update` already warn about agents the roster flags invalid; the
pulse is still saved:

```
Created pulse p-1 "audit-relay on demo": every 7d, next run 2026-11-19T16:15:31.279Z.
warning: step "audit": agent broken in demo has invalid front matter: front matter is not valid YAML: Nested mappings are not allowed in compact mappings at line 2, column 14
```

### A run ended without `mesh_done`

The run started but ended (exit, crash, budget) without an accepted `mesh_done`: the step fails with
`headless run ended without mesh_done (exit <exit>)` and a `transcript` artifact holds the tail of
the run (last assistant texts and errors, secrets redacted). Read it with `mesh artifact ls <G>` and
`mesh artifact show <id>`. Usual causes: the budget was too small (`turns`, `minutes`), the agent
was not told to call `mesh_review` and `mesh_done`, or it was denied a tool it needed.

### Permission denials

A tool the profile does not allow is denied, not prompted. The count and the tools are in the run's
telemetry (`permissionDenials`), and the details in the run's stream log on the runner:

```sh
jq -c 'select(.type == "result") | .permission_denials' ~/.local/state/mesh/runs/<run id>/stream.jsonl
```

Give the agent the tools it needs in its front matter, or use a profile that allows them (for checks:
a registered `read-only+checks` profile).

### The repo is not offered, or a slot is `missed (no_machine)`

- The checkout has no remote: add one (`git remote add origin …`).
- The checkout is not under `workspaceRoots`, or deeper than two levels.
- The runner shares at `steps`: `mesh setup --share-sessions me` and restart the daemon.
- `mesh machines` shows the runner offline, without the repo, or without the pulse's labels.
- The runner's `accept` does not take the pulse owner's offers (`self` only takes your own;
  add `user:<owner>`).
- The runner is older than 0.1.15 or has no `workspaceRoots`: it cannot run headless steps.

### A step is never picked up

- Its slot's window ended before the run started (`missed (expired)`): the runner was busy at
  `maxSessions` (your own open sessions count), or asleep. Widen `--window` or raise `maxSessions`.
- `missed (capacity)`: the run waited in the runner's queue until its deadline.
- A later step of a running goal follows the goal's stick: if the runner went offline mid-goal, the
  step waits. `mesh withdraw <G>` ends the stick; then offer it elsewhere with `mesh assign`.
- A debrief is never offered: it waits for its assignee (`mesh debrief <step>`).

### Where runs live on the runner

`<stateDir>/runs/<run id>/` (Linux: `~/.local/state/mesh/runs/`), one folder per run, kept after the
run (remove old ones by hand):

| File | Content |
|---|---|
| `run.json` | step, goal, repo, state, session id, checkout, worktree, base commit, pid, exit, profile, budget, agent key and hash |
| `stream.jsonl` | Claude Code's stream-json output |
| `stderr.log` | the process's stderr |
| `profile.json`, `mcp.json`, `agents.json` | the settings, MCP config and agent the run started with |
| `artifacts.jsonl`, `reviews.jsonl` | what the run stored, with redaction counts |

The worktree (`<run dir>/worktree`) is removed when the run ends. The daemon's own log (`mesh up`'s
output, or the service's log file) has one line per start and finish. To read a run as a
conversation: `mkdir -p` the worktree path from `run.json` again, then `claude --resume <sessionId>`
from inside it.

### Redaction

Before a report, record or transcript leaves the runner, the daemon removes private key blocks,
known token forms (`ghp_…`, `glpat-…`, `xox…-`, `AKIA…`, `sk-…`, …), `password=…`-style values
and its own credentials, and the hub records how many (`redactions`). A `secret: …` written as prose
stays as it is. Redaction is best effort: keep real secrets out of what agents read, and remember
that every member of the hub can read every artifact.
