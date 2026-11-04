# mesh-harness

One place to see and steer all your Claude Code sessions, across repos and people.

- Proposal: [docs/analysis/2026-11-03-mesh-harness-proposal.md](docs/analysis/2026-11-03-mesh-harness-proposal.md)
- Journeys, dashboard and analysis: [docs/analysis/2026-11-03-journeys-dashboard-and-analysis.md](docs/analysis/2026-11-03-journeys-dashboard-and-analysis.md)
- Implementation plan (leads development): [docs/plan/implementation-plan.md](docs/plan/implementation-plan.md)
- Claude Code spike results: [docs/spikes/README.md](docs/spikes/README.md)

## Use it (M1: local)

```bash
pnpm install && pnpm build
alias mesh="node $PWD/dist/main.mjs"

mesh setup          # writes ~/.config/mesh/daemon.json and adds 5 hooks to ~/.claude/settings.json
mesh up             # the daemon (or: mesh up --install, then run the printed enable command)
mesh doctor         # checks claude, curl, tmux, hooks, daemon

mesh run frr-dplane-ovs vpc-node-agent   # tmux session "mesh": window 0 = list, one claude per repo
mesh                # the list: ⏎ jump · s say · r refresh · q quit (prefix + m comes back)
mesh ls             # same list, plain text (--json)
mesh say <session> "continue with the tests"
mesh jump <session>
mesh setup --uninstall   # removes the hooks, restoring your settings file byte for byte
```

Sessions you start yourself with `claude` show up too. With the hooks, mesh knows their tmux pane, so jump and say work; without them they still appear (from `claude agents --json`) but mesh can't type into them.

How messages reach a session: during a turn, mesh hands them over when the turn ends (Stop hook). At an idle prompt, it pastes them into the tmux pane, but only when Claude reports no dialog open. For background sessions, it wakes them in place. Prompts typed by mesh are not counted as human prompts.

## Use it with a team (M2: hub)

```bash
mesh hub init --users alice,bob --listen 0.0.0.0:7700   # writes mesh-hub.yaml, prints one token per person
mesh hub --config mesh-hub.yaml                          # the shared hub + web dashboard at its URL

mesh login --hub http://hub:7700 --token <token>         # each person, once (OIDC: --provider kanidm)
mesh setup                                               # re-run after upgrading: adds the MCP server

mesh goal new "IPv6 underlay" --repo frr-dplane-ovs --repos vpc-node-agent
mesh run --design G1                                     # a design session: writes the design, proposes the plan (mesh_plan)
mesh show G1                                             # the goal and its step DAG; a pending plan shows its changes
mesh goal revise G1 "split out the dplane tests"         # the design session gets the comment and re-proposes
mesh goal approve G1                                     # or approve in the web dashboard (Goals → G1 → Design)
mesh goal plan G1 --file plan.yaml                       # alternatively: write the plan yourself (approved at once)
mesh next                                                # ready steps
mesh run frr-dplane-ovs --step G1.dplane --auto chain    # a Claude session that holds the step
mesh take G1.agent                                       # continue someone's paused step
mesh answer 3 "yes, keep the v4 fallback"
mesh autopilot <session> off|nudge|chain
```

Every run leaves a trail in the repos, written by mesh and committed by the agents: `.mesh/goals/<G>/goal.yaml`, `plan.vN.yaml` (with the approval) and one `steps/<id>.md` record per step (holders, models, turns, human prompts, nudges, waits, fix cycles, MR, summary). mesh-ai reads it.

Agents use eight MCP tools (`mesh_context`, `mesh_next`, `mesh_claim`, `mesh_release`, `mesh_note`, `mesh_done`, `mesh_ask`, `mesh_plan`). With `--auto chain`, finishing a step claims the next ready one in the same repo and hands it over when the turn ends. With `nudge` (default), a session that stops mid-step gets "continue" twice, then mesh notifies you.

To add OIDC, see the commented example in the generated `mesh-hub.yaml` (Kanidm is a preset; any OIDC provider works).

## Development

Requires pnpm and tmux. Node 24 is downloaded by pnpm (`devEngines`).

```bash
pnpm check        # lint, typecheck, module boundaries, tests, build
```

Spikes and the end-to-end check run real Claude Code on your subscription (model haiku). They never touch `~/.claude/settings.json`:

```bash
export MESH_SPIKE_TMP=/tmp
pnpm spike print
pnpm spike interactive   # also trusts the scratch folder the next ones use
pnpm spike background
pnpm build && pnpm spike e2e   # M1 end to end
pnpm spike e2e-m2              # M2 end to end: hub, login, MCP tools, chain autopilot
pnpm spike e2e-m3              # M3 end to end: design → revise → approve → two people, two repos → records
pnpm test:web                  # Playwright smoke test of the dashboard (after pnpm build)
```
