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

The web dashboard is at the hub's URL. It has a Live page (who is working on what, and what needs whom), a Goals board, and a page per goal with the step graph.

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
