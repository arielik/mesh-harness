# How-to, with examples

Short recipes for the things people do with mesh, each with a worked example. For the ideas behind them see [concepts](concepts.md); for installing, [install](install.md).

The examples use two repos, `payments-api` and `payments-web`, in `~/src`, and two people, alice and bob.

- [1. Start on your own (Solo)](#1-start-on-your-own-solo)
- [2. See and steer your sessions](#2-see-and-steer-your-sessions)
- [3. Join a team hub](#3-join-a-team-hub)
- [4. A goal from design to done](#4-a-goal-from-design-to-done)
- [5. Run the SDD cycle as mesh steps](#5-run-the-sdd-cycle-as-mesh-steps)
- [6. Run the SDD cycle as one unattended programme](#6-run-the-sdd-cycle-as-one-unattended-programme)
- [7. Decide gates, resume parked steps, take over work](#7-decide-gates-resume-parked-steps-take-over-work)
- [8. Work while the hub is down](#8-work-while-the-hub-is-down)
- [9. Export the ledger and ask it questions](#9-export-the-ledger-and-ask-it-questions)
- [10. Write your own plan or template](#10-write-your-own-plan-or-template)
- [11. Run a team hub](#11-run-a-team-hub)
- [12. Troubleshooting](#12-troubleshooting)

---

## 1. Start on your own (Solo)

New to mesh? [Your first hour](first-run.md) walks through this section and a first goal step by step.

```bash
curl -fsSL https://github.com/arielik/mesh-harness/releases/latest/download/install.sh | sh

mesh setup        # hooks + MCP server + the mesh skill
mesh up           # the daemon; it runs a local hub (Solo) until you log in to a team hub
mesh doctor
```

`mesh doctor` should end with:

```
✓ daemon running on 127.0.0.1:31944 (0 live sessions)
✓ Solo: working on the local hub http://127.0.0.1:53111 (log in to a team hub with: mesh login --hub <url>)
```

To keep the daemon running: `mesh up --install`, then run the command it prints (launchd on macOS, systemd on Linux).

## 2. See and steer your sessions

```bash
mesh run payments-api payments-web   # tmux session "mesh": window 0 = the list, one Claude per repo
mesh                                 # the list (also: mesh tui)
```

```
mesh 0.1 · alice

NEEDS YOU (1)
  ● payments-web    asks: Keep the v1 endpoint for old clients?          2m
WORKING (1)
  ◐ payments-api    working · turn 4 · 1m                                 1m
IDLE (1)
  ○ docs            done: Updated the README                              9m

⏎ jump · s say · a autopilot · n next step · g goals · r refresh · ↑↓ move · q quit
```

- **⏎** jumps to the session's tmux pane. Inside tmux, `prefix + m` brings you back to the list.
- **s** sends a message. It is typed into an idle session, or handed over when the session's turn ends.
- **a** sets autopilot:
  - `nudge` (default): a session that stops mid-step gets "continue" twice, then mesh notifies you;
  - `chain`: when a step is done, the session takes the next ready one;
  - `off`.

The same from the shell:

```bash
mesh ls                                        # plain list (--json for scripts)
mesh say payments-web "yes, keep v1 until March"
mesh jump payments-api
mesh autopilot payments-api chain
```

Sessions you start yourself with `claude` show up too. With the hooks installed, jump and say work for them.

**OpenCode.** After `mesh setup --agent opencode` ([install](install.md#opencode)), OpenCode sessions show up as well, marked `[oc]`/`·oc`, with the same states. Start them from mesh with `--agent opencode`; every `mesh run` form below works, except `--bg`:

```bash
mesh run payments-api --agent opencode                     # opencode --standalone in a tmux window
mesh run payments-api --agent opencode --step G3.api       # holds a step, with the mesh tools
mesh say payments-api "also update the changelog"          # queued in OpenCode, sent when it can take it
```

OpenCode sessions you start yourself with plain `opencode` (the shared background server) report their state, but mesh doesn't know their terminal, so `mesh jump` can't reach them.

## 3. Join a team hub

Someone runs the hub (see [11](#11-run-a-team-hub)) and gives you a token, or the hub uses OIDC:

```bash
mesh login --hub https://mesh.example --token 3f9a…      # token provider
mesh login --hub https://mesh.example --provider kanidm  # OIDC in the browser (any OIDC issuer)
mesh status
#   daemon on alice-laptop: team hub https://mesh.example as alice
mesh logout                                              # back to Solo
```

**Over SSH**, in a Linux session with no display (for example a shell opened with `sudo -iu` or `su -`), or with `--no-browser`, `mesh login` opens no browser. It prints the URL: open it on
any machine, sign in, and the page shows a one-time code; paste it into the terminal. With a hub
older than 0.1.2 the browser instead ends on an `http://127.0.0.1:…/callback?code=…` address it
can't open: paste that whole address. `--local` forces the usual localhost redirect, for example
with the port forwarded; a terminal login then still accepts the address pasted if the redirect lands
somewhere it can't be reached.

Each mesh installation has its own id (`install-id` in its config folder), so one person logged in
from two OS users or two containers on one host shows as two machines. From an older CLI (before
0.1.5) both would share one; log in again from each after updating.

The web dashboard is at the hub's URL. It has a Live page (who is working on what, and what needs whom), a Goals board, a page per goal with the step graph, and **Mine** (your own machines).

### See all your machines

Log in from each machine you work on. Then, from any of them:

```bash
mesh machines                      # or: mesh fleet; --json for the raw view
#   laptop (alice-laptop) · online · share me · 4 repos · this machine
#     payments-api · fix refunds · working · no step · [perf] · 12s
#     web · G3.web · needs_you (permission) · G3.web · 2m
#
#   build-box · last seen 3h ago · share me · 12 repos · [gpu]
#     no sessions
mesh machine name laptop           # name this machine
mesh machine name gpu --machine build-box   # name another one (id, nickname or hostname)
mesh machine name --clear          # remove this machine's name
```

In the TUI, `m` opens the **My machines** panel (your other machines; `m` again goes back, `g`
shows goals). The web dashboard's **Mine** page shows the same, refreshed every 15 seconds.

Sessions without a step appear only from machines whose share level is `me` or `all` (`mesh setup
--share-sessions me`, the default for new setups); see [What the hub sees](install.md#what-the-hub-sees).
The repo count comes from `workspaceRoots` in `daemon.json` (for example `["~/src"]`) plus the
repos of the current sessions; only ids and names are sent.

### Label sessions and machines

Labels say what a session or machine is for. They use the topic-name syntax, at most 10 each; see
[Label](concepts.md) for the rules.

```yaml
# .mesh/agent.yaml at the top of a checkout: the repo default for new sessions there
labels: [perf, dataplane]
```

```bash
mesh run payments-api --label perf          # new sessions in this checkout get perf (replaces the repo default)
mesh label fix-refunds perf,gpu             # set a live session's labels (also remembered for its checkout)
mesh label fix-refunds x --add              # add; --rm removes; --clear removes all
mesh machine label gpu,perf-lab             # label this machine (stored on the hub)
mesh machine label gpu --machine build-box  # label another of your machines; --add, --rm, --clear
mesh machines --label perf                  # only what carries every given label
```

In the TUI, `L` on a session opens `labels for <session>: ` with its current labels; Enter sets
them (an empty line clears them), Esc cancels. A label that is not a topic prints
`not a topic: <label>; mesh topic add <label>`; the label is set anyway.

### Hand work to another machine

Offer a step or a goal to another machine (yours or a teammate's), or to a session on it. Their
accept policy decides whether it is taken at once; otherwise it waits for them. See
[Offers and accept policy](concepts.md#offers-and-accept-policy).

```bash
mesh assign G7.api --to build-box                 # a step to one of your machines (nickname or id)
#   Offered G7.api to build-box (auto-accept).
mesh assign G7 --to bob/laptop --note "the API part"   # a goal's ready steps to bob's machine
#   Offered G7.design to laptop (waits for them to accept).
mesh assign G7 --to build-box/perf --stick        # a session by name; later ready steps go there too
mesh withdraw G7.api                              # take an open offer back; mesh withdraw G7 ends a stick

mesh offers                                       # what is offered to your machines (--json)
#   G7.api "API" · payments-api · from @alice · to build-box · manual · expires in 28m
mesh accept G7.api                                # an idle session here takes it (--session <s>, or --launch)
mesh decline G7.api --note "busy today"

mesh session accept perf --from self,user:bob     # whose offers this session takes automatically (--off, --clear)
mesh setup --accept self,user:bob                 # the machine policy (default self; restart the daemon)
mesh setup --assignments launch                   # deliver (default), launch or off
mesh setup --max-sessions 4                       # under launch: no new session while 4 are live (off: no limit)

mesh say build-box/perf "rebase on main first"    # a message to a session on another machine (bob/laptop/<session> for a teammate's)
#   Sent to build-box/perf; mesh delivers it as soon as the session can take it.
```

Not sure which machine to pick? Ask for a ranked list:

```bash
mesh assign G7 --suggest                          # your machines that have the repo, best first
#   Suggestions for G7 (best first):
#   1. build-box · auto-accept · online · has payments-api · 1 idle session · perf labelled payments · machine labels payments
#   2. laptop · auto-accept · last seen 3h ago · has payments-api · no idle session
#   Assign with: mesh assign G7 --to build-box
mesh assign G7 --suggest --team                   # also teammates' machines (bob/laptop …)
mesh assign G7.api --suggest --any --json         # also machines without the repo; the full view as JSON
```

On the web, a ready step's panel and a goal's header have an **Assign** button: it opens the same
ranked list (with **Team machines** and **Without the repo** switches) and offers with one click.

In the TUI the header counts the offers to this machine and `o` opens them: ⏎ accepts for an idle
session, `d` declines. The web's **Mine** page lists them under **Assigned to you** with a
**Decline** button and the `mesh accept` command (the web cannot accept: it has no session).

The `<session>` of a `<machine>/<session>` target (and of `mesh say`) is the session's name, else
the name it is shown under (an unnamed session shows as its repo, as in `accepted by m2/demo`),
else a sid prefix of at least 4 characters. When several sessions match, use a sid prefix.

Under `shareSessions: steps` the hub does not know an idle session, so a `<machine>/<session>`
target answers 404 until that session holds a step; offer to the machine alone instead.

### Run a step headless

A step a machine runs on its own, with no person watching (an audit, a triage). In the plan:

```yaml
# plan.yaml — mesh goal plan G9 --file plan.yaml
steps:
  - id: audit
    repo: payments-api
    kind: review
    title: Audit the error handling
    brief: Read the error paths and report what is missing.
    mode: headless
    agent: auditor          # .claude/agents/auditor.md in payments-api (optional)
    profile: read-only      # or a registered profile; default read-only
    budget: { turns: 20, minutes: 15 }
```

A template can leave the agent and profile open (`agent: "{agent}"`, `profile: "{profile}"`):
`mesh goal plan G9 --preset audit --repo payments-api --params agent=auditor,profile=read-only`.

A profile beyond the three built-ins:

```sh
cat > lint-checks.yaml <<'EOF'
description: read the repo and run its linters
extends: read-only+checks
checks: ["pnpm lint", "pnpm typecheck"]
EOF
mesh profile add lint-checks --file lint-checks.yaml
#   Saved profile lint-checks (sha256 3f9a1c0b7e22).
mesh profile ls
mesh profile show lint-checks        # the compiled Claude Code settings
```

Offer the step to a machine that can run it:

```sh
mesh assign G9.audit --to build-box
```

The machine needs mesh 0.1.15, `workspaceRoots` in its `daemon.json` with a checkout of the repo,
and an accept policy that takes your offer automatically (a manual offer of a headless step waits
and expires; `mesh accept` does not take one). Its daemon accepts, makes a worktree of that checkout
and starts `claude -p`. Then:

```sh
mesh artifact ls G9
#   a-01JD3K…  G9.audit r1  report  4180 B  Error handling audit
mesh artifact show a-01JD3K… > audit.md
```

On the machine, each run has a folder `<stateDir>/runs/<run id>/` (Linux:
`~/.local/state/mesh/runs/`): `run.json`, `stream.jsonl` (Claude Code's output), `stderr.log`,
the profile and MCP config it ran with. The worktree is removed when the run ends; the folder
stays. To read a run as a conversation: `claude --resume <sessionId>` (the `sessionId` in
`run.json`). Claude Code looks a session up by the folder it ran in, so run it from the run's
`worktree` path (`mkdir -p` it again if it was removed). A run that ended without `mesh_done` closed the step as
failed and stored its transcript as an artifact.

### Review an agent's findings

A raising step records findings; a consuming step after it confirms or dismisses them, and runs
only when there is something to look at:

```yaml
# plan.yaml — mesh goal plan G10 --file plan.yaml
steps:
  - id: audit
    repo: alpha
    kind: review
    title: Audit the error handling
    brief: Review the error paths; record each finding with mesh_review.
    mode: headless
    agent: auditor
    output: review-record     # closes done only with a review record
    inputs: [previous]        # the last complete record of this lineage
  - id: validate
    repo: alpha
    kind: review
    title: Validate the audit's findings
    brief: Check each open finding; confirm or dismiss it with a reason.
    deps: [audit]
    mode: headless
    agent: validator
    output: review-record
    consumes: [open]          # the item states it acts on
    may_set: [confirmed, dismissed]
    when: { open: true }      # skipped when no item is open
    inputs: [dispositions]    # the items it may act on now
```

The auditor declares the rules it checks in `.claude/agents/auditor.md`:

```markdown
---
name: auditor
description: Audits error handling
mesh-rules: [E-01, E-02, secrets]
---
Report each finding with key.rule set to one of your rules …
```

A rule it does not declare is recorded as `other:<slug>`. Reuse the previous record's keys for the
same finding: the hub matches findings by rule, path and symbol, never by line numbers.

Read the items of the lineage:

```sh
mesh items G10.audit                 # or the lineage key: mesh items '-|alpha|auditor'
#   q3k7d2m5x4c6v8b2  confirmed  S2  E-01  src/handler.ts  error swallowed in retry loop
mesh items G10.audit --all           # resolved items too
mesh items G10.audit --json          # with each item's history
```

In the next goal of the same lineage, findings that come back are `repeat` (dismissed ones stay
dismissed while their evidence is unchanged), findings the audit no longer reports are `resolved`,
and resolved ones that come back are `regression`.

## 4. A goal from design to done

```bash
mesh goal new "Refunds API" --repo payments-api --repos payments-web --refs spec=SPEC-7,backlog=ROW-42
#   Created G3 "Refunds API". Start the design with: mesh run --design G3
mesh run --design G3
```

The design session reads the code, writes `docs/design/g3-refunds.md` and proposes a plan with `mesh_plan`. You review it:

```bash
mesh show G3
```

```
G3 · Refunds API
awaiting approval · owner @alice · 0/1 steps done · payments-api
steps: 1 in progress
plan v1 pending · design payments-api@main:docs/design/g3-refunds.md
  approve: mesh goal approve G3   ·   ask for changes: mesh goal revise G3 "<comment>"
```

```bash
mesh goal revise G3 "split the web change into its own step"   # the design session gets the comment
mesh goal approve G3                                             # or: Goals → G3 → Design in the web
mesh next                                                        # what's ready
mesh run payments-api --step G3.api                              # a session that holds G3.api
```

Bob picks the other side in parallel:

```bash
mesh run payments-web --step G3.web --auto chain
```

Each agent finishes with `mesh_done`. mesh writes `.mesh/goals/G3/steps/<step>.md` into the repo, and the agent commits it with the work. When the last step is done, `goal.yaml` gets the roll-up.

### Group goals by topic

Topics are labels for goals, such as `dataplane` or `performance`. Every goal is in the topic `all`. Define the other topics once, then tag goals with them:

```bash
mesh topic add dataplane "packet path work"
mesh topic add performance
mesh goal new "OVS fast path" --repo frr-dplane-ovs --topics dataplane,performance
mesh goal tag G3 dataplane              # mesh goal untag G3 dataplane takes it off
mesh goal ls --topic dataplane          # goals tagged dataplane
mesh goal ls --topic dataplane,performance   # goals tagged with both
mesh topic ls                           # topics and how many goals each has
mesh topic rm performance               # its creator or an admin; untags its goals
```

Any member can tag or untag a goal. A topic has to be defined before you can use it, so a typo such as `dataplan` is refused, not created. A name is up to 40 characters: lowercase letters, digits, `.`, `_` and `-`. On the web, the Goals page has a chip per topic. Turn chips on to show only the goals that carry all of them; a goal you create there gets the topics you have on. A goal's page lists its topics, with × to remove one and a picker to add one. API: `GET /v1/goals?topic=dataplane,performance`, `GET /v1/topics`, `POST /v1/topics`, `POST /v1/goals/<G>/topics` with `{"add": [...], "remove": [...]}`.

## 5. Run the SDD cycle as mesh steps

The `sdd-split` template is the full cycle:

1. spec, then a cold review;
2. R2;
3. implementation and test plans written apart;
4. developer and test-writer blind to each other;
5. combine;
6. verify, with fixes routed by bucket;
7. diff review;
8. R3.

```bash
mesh preset show sdd-split | head -20
cat > acs.yaml <<'EOF'
- { id: AC-01, text: "POST /refunds returns 201 with the refund id", surface: api tests, fails_when: "any other status" }
- { id: AC-02, text: "a refund larger than the charge is refused", surface: api tests, fails_when: "201 for an over-refund" }
EOF
mesh goal new "Refunds API" --repo payments-api
mesh goal plan G4 --preset sdd-split --repo payments-api --acs acs.yaml
mesh show G4
```

The same agents take the steps (`mesh assets install` gives you a set; see [6](#6-run-the-sdd-cycle-as-one-unattended-programme)):

```bash
mesh run payments-api --step G4.spec                    # alice
mesh run payments-api --step G4.spec-review             # bob (alice wrote the spec, so mesh refuses her)
mesh step approve G4.r2 --comment "spec is good"        # alice, the owner
mesh run payments-api --step G4.develop                 # alice; worktree mesh/g4-develop
mesh run payments-api --step G4.write-tests             # bob; worktree from the base; alice is refused (blind)
```

What mesh does with each `mesh_done`:
- **A test plan missing AC-02:** "Not accepted: reconcile: … AC-02 …". The agent keeps the step and adds it.
- **A spec review with `verdict: changes_requested`:** the spec reopens. At the 3rd round, or on churn, the review is parked.
- **A verify with an impl-bug on AC-02:** `failures: [{ac: AC-02, bucket: impl-bug, assertion: "got 201"}]` reopens `develop`. The developer reads only "impl-bug AC-02: got 201". `combine` waits, then runs again.
- **Infra failures, or no progress in two rounds:** the step parks for a person ([7](#7-decide-gates-resume-parked-steps-take-over-work)).

## 6. Run the SDD cycle as one unattended programme

For a batch of work items in one Claude Code session, use the kit:

```bash
cd ~/src/payments-api
mesh assets install          # .claude/agents/*, .claude/workflows/sdd-programme.js, templates/spec.md
echo ".claude/worktrees/" >> .gitignore
git add -A && git commit -m "add the SDD kit"
claude
```

Then ask Claude:

> Run the workflow `.claude/workflows/sdd-programme.js` with args
> `{rows: [{key: "ROW-42", title: "Refunds API", brief: "POST /refunds …"}, {key: "ROW-43", title: "Refund emails", brief: "…"}]}`

Each row ends "ready to land" (branch `impl/ROW-42`, criteria judged) or "parked" with a reason. Nothing is pushed or merged.

With mesh running, every agent is recorded per role under the row's key, and the last step commits them:

```
.mesh/goals/ROW-42/steps/spec-writer.md     reviewer.md    impl-planner.md   test-planner.md
                         developer.md       test-writer.md merger.md          test-executor.md
                         reviewer-diff.md
```

```yaml
# .mesh/goals/ROW-42/steps/test-executor.md (front matter)
schema: mesh.ledger.v1
record: agent-step
key: ROW-42
role: test-executor
workflow: sdd-programme
models: [claude-sonnet-5-5]
rounds:
  - n: 1
    label: test-executor:ROW-42:c1
    model: claude-sonnet-5-5
    model_source: workflow
    duration_s: 84.2
    result: { verdict: FAIL, failing: [{ criterion: AC-02, bucket: impl-bug, note: got 201 }], self_check_clean: true }
  - n: 2
    label: test-executor:ROW-42:c2
    duration_s: 61.0
    result: { verdict: PASS, self_check_clean: true }
```

Without mesh the programme runs the same; only the records are missing. Change the agents and the workflow as you like: mesh relies only on the labels (`<role>:<key>[:<round>]`) and on the result fields named in each agent's "Report" section.

## 7. Decide gates, resume parked steps, take over work

```bash
mesh step approve G4.r3 --rule GATE-1 --comment "CI green, criteria met"
mesh step reject  G4.r3 --reopen develop --comment "AC-02 fails on the staging data"
mesh step resume  G4.verify --comment "the test database is back"
mesh take G3.web           # continue bob's paused step (after the take-over delay, or at once as the owner)
mesh answer 5 "yes, keep v1 until March"
```

All of these also work in the web: on the Goal page, click the step. Gates waiting for you, parked steps and agents' questions appear on the Live page under "Needs attention".

## 8. Work while the hub is down

Nothing to do. Your sessions keep working on the steps they hold:
- `mesh_context` answers from a local copy;
- `mesh_done` writes the step record locally (`recorded_offline: true`);
- notes, releases and questions are queued.

```bash
mesh status
#   daemon on alice-laptop: team hub https://mesh.example as alice
#   hub offline since 14:02 UTC: working locally; 12 event(s) and 2 call(s) are sent when it is back
```

When the hub is back, everything is sent once, and the hub's fuller record replaces the local one. If someone took your step over meanwhile, your result becomes a note on the step, and your local record stays.

## 9. Export the ledger and ask it questions

```bash
mesh ledger export --repo ~/src/payments-api --repo ~/src/payments-web --out ledger.jsonl
#   148 record(s), 3 file(s) not in mesh.ledger.v1 skipped
```

Each line is `{kind: "record", repo, path, ref, commit, record}`. The schemas are in [`schemas/`](../../schemas). Some questions with `jq`:

```bash
# Fix cycles and human prompts per model, for implementation steps
jq -r 'select(.kind=="record" and .record.record=="step" and .record.kind=="implement")
       | [(.record.models|join("+")), .record.fix_cycles, .record.human_prompts] | @tsv' ledger.jsonl \
  | awk -F'\t' '{n[$1]++; f[$1]+=$2; h[$1]+=$3} END {for (m in n) printf "%-30s steps %3d  fix cycles/step %.2f  prompts/step %.1f\n", m, n[m], f[m]/n[m], h[m]/n[m]}'

# Did a harness change help? Rounds per review, by harness hash
jq -r 'select(.record.record=="step" and .record.kind=="review") | [.record.segments[0].harness.hash, (.record.rounds|length)] | @tsv' ledger.jsonl | sort | uniq -c

# Failure buckets across all verify rounds of finished goals
jq -r 'select(.record.record=="goal" and .record.rollup.buckets) | .record.rollup.buckets | to_entries[] | "\(.key) \(.value)"' ledger.jsonl \
  | awk '{s[$1]+=$2} END {for (b in s) print b, s[b]}'

# Programmes: average duration per role
jq -r 'select(.record.record=="agent-step") | .record.role as $r | .record.rounds[] | [$r, .duration_s] | @tsv' ledger.jsonl \
  | awk -F'\t' '{n[$1]++; d[$1]+=$2} END {for (r in n) printf "%-15s %5.1f s\n", r, d[r]/n[r]}'
```

To include the hub's precise events, add `--events`. With a service token: `mesh hub token --service analytics`, then `--hub URL --token T`.

## 10. Write your own plan or template

A plan is YAML. Every rule is optional:

```yaml
# plan.yaml — mesh goal plan G5 --file plan.yaml
acs:
  - { id: AC-01, text: "exports a CSV of refunds", fails_when: "no file or wrong columns" }
steps:
  - { id: export, repo: payments-api, kind: implement, title: CSV export, brief: "…", acs: [AC-01], blind: [check] }
  - { id: check, repo: payments-api, kind: verify, title: Check, brief: "…", deps: [export],
      max_rounds: 2, route: { impl-bug: export, infra: park } }
  - { id: land, repo: payments-api, kind: gate, gate: R3, title: Approve, brief: "a person approves", deps: [check] }
```

A template is the same without repos. Save it as `.mesh/presets/<name>.yaml` in your repo:

```yaml
# .mesh/presets/hotfix.yaml — mesh goal plan G6 --preset hotfix --repo payments-api
description: Fix, independent check, approval
steps:
  - { id: fix, kind: implement, title: Fix, brief: "Fix {goal}; keep the change minimal.", blind: [check] }
  - { id: check, kind: verify, title: Check, brief: "Reproduce the bug, confirm the fix.", deps: [fix], route: { impl-bug: fix } }
  - { id: land, kind: gate, gate: R3, title: Approve, brief: "approve", deps: [check] }
```

`mesh preset ls` lists the built-in and repo templates. `mesh goal new … --preset hotfix` hands the template to the design session.

## 11. Run a team hub

```bash
mesh hub init --users alice,bob --listen 0.0.0.0:7700     # writes mesh-hub.yaml, prints one token per person
mesh hub --config mesh-hub.yaml                            # behind TLS when it leaves your machine
mesh hub token --service analytics --config mesh-hub.yaml  # read-only event feed for analysis
mesh hub backup /backups/mesh-$(date +%F).db --config mesh-hub.yaml   # SQLite; on Postgres use pg_dump
mesh hub revoke --user bob --config mesh-hub.yaml
```

For OIDC (Kanidm, Keycloak, GitLab, Google…), the roles (approver, admin), retention and the blind guard, see [auth](auth.md) and [operations](operations.md). For several replicas on Postgres (`mesh hub migrate`, the container image, `deploy/kubernetes/`), see [operations](operations.md#running-the-hub).

## 12. Troubleshooting

| Symptom | Try |
|---|---|
| A session isn't in the list | `mesh doctor`. Hooks missing? `mesh setup`. Started before `mesh up`? It appears on its next prompt. |
| "mesh doesn't know this Claude session yet" from a tool | The hooks aren't installed in the Claude config that session uses; run `mesh setup` for it. |
| A message never arrives | The session shows a dialog, or isn't in tmux. The TUI footer lists failed deliveries. |
| `mesh_claim` says "is blind to …" | That's the separation rule: someone who didn't work on the other side must take it. In Solo, use another session. |
| A step shows "parked" | Read the reason (`mesh show`, or the step in the web), fix the cause, then `mesh step resume`. |
| "hub login expired" | `mesh login` again. Nothing was lost; work was kept locally. |
| After upgrading Claude Code | `pnpm test:claude` checks everything mesh relies on. |
