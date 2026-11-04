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
```
