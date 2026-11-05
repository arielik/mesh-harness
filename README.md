# mesh-harness

One place to see and steer all your Claude Code sessions, across repos and people, and a ledger in git of how the work went.

**Self-contained.** Everything needed is in this repo:
- the tool;
- an example spec-driven development kit (`assets/sdd`: agents, a programme workflow, a spec template; `mesh assets install`);
- plan templates;
- the docs.

It needs Claude Code on a subscription login, Node and git. It needs no other repository, no API keys and no Agent SDK, and none of its parts depends on a particular identity provider, issue tracker or analysis tool.

- Documentation: [docs/README.md](docs/README.md) · [how-to with examples](docs/guide/howto.md)
- Guide: [overview](docs/guide/overview.md) · [concepts](docs/guide/concepts.md) · [the development cycle](docs/guide/cycle.md) · [install](docs/guide/install.md) · [auth](docs/guide/auth.md) · [operations](docs/guide/operations.md) · [the ledger](docs/guide/ledger.md) · [events](docs/events.md)
- How it works, in pictures: [docs/explainer/how-mesh-harness-works.html](docs/explainer/how-mesh-harness-works.html)
- The SDD kit: [assets/sdd/README.md](assets/sdd/README.md)
- Design history (optional reading): [docs/analysis/](docs/analysis/README.md) · [implementation plan](docs/plan/implementation-plan.md) · [Claude Code spike results](docs/spikes/README.md)

## Use it (M1: local)

```bash
pnpm install && pnpm build
alias mesh="node $PWD/dist/main.mjs"

mesh setup          # writes ~/.config/mesh/daemon.json and adds 7 hooks to ~/.claude/settings.json
mesh up             # the daemon, with its own local hub (Solo) until you log in to a team hub
mesh status         # team, Solo, or "hub offline, working locally"
mesh doctor         # checks claude, curl, tmux, hooks, daemon

mesh run payments-api payments-web   # tmux session "mesh": window 0 = list, one claude per repo
mesh                # the list: ⏎ jump · s say · r refresh · q quit (prefix + m comes back)
mesh ls             # same list, plain text (--json)
mesh say <session> "continue with the tests"
mesh jump <session>
mesh setup --uninstall   # removes the hooks, restoring your settings file byte for byte
```

Sessions you start yourself with `claude` show up too. With the hooks, mesh knows their tmux pane, so jump and say work; without them they still appear (from `claude agents --json`) but mesh can't type into them.

Nothing in your agents, skills or workflows needs mesh: without it they run as before. With `mesh up` and no team hub, everything (goals, plans, steps, records) runs on a local hub (Solo). With a team hub that goes away, the steps you hold keep working, records are written locally, and everything is sent once when the hub is back.

How messages reach a session: during a turn, mesh hands them over when the turn ends (Stop hook). At an idle prompt, it pastes them into the tmux pane, but only when Claude reports no dialog open. For background sessions, it wakes them in place. Prompts typed by mesh are not counted as human prompts.

## Use it with a team (M2: hub)

```bash
mesh hub init --users alice,bob --listen 0.0.0.0:7700   # writes mesh-hub.yaml, prints one token per person
mesh hub --config mesh-hub.yaml                          # the shared hub + web dashboard at its URL

mesh login --hub http://hub:7700 --token <token>         # each person, once (OIDC: --provider kanidm)
mesh setup                                               # re-run after upgrading: adds the MCP server

mesh goal new "IPv6 underlay" --repo payments-api --repos payments-web
mesh run --design G1                                     # a design session: writes the design, proposes the plan (mesh_plan)
mesh show G1                                             # the goal and its step DAG; a pending plan shows its changes
mesh goal revise G1 "split out the dplane tests"         # the design session gets the comment and re-proposes
mesh goal approve G1                                     # or approve in the web dashboard (Goals → G1 → Design)
mesh goal plan G1 --file plan.yaml                       # alternatively: write the plan yourself (approved at once)
mesh next                                                # ready steps
mesh run payments-api --step G1.dplane --auto chain    # a Claude session that holds the step
mesh take G1.agent                                       # continue someone's paused step
mesh answer 3 "yes, keep the v4 fallback"
mesh autopilot <session> off|nudge|chain
mesh goal plan G1 --preset sdd-split --repo payments-api --acs acs.yaml   # the SDD cycle as a template (docs/guide/cycle.md)
mesh step approve G1.r2                                  # gates; reject --reopen a,b; resume a parked step
mesh run payments-api --step G1.write-tests --worktree # one worktree and branch per step
```

Every run leaves a trail in the repos, written by mesh and committed by the agents, in the `mesh.ledger.v1` format ([the ledger](docs/guide/ledger.md)): `.mesh/goals/<G>/goal.yaml` (with a roll-up when done), `plan.vN.yaml` (with the approval) and one `steps/<id>.md` record per step (segments with model, effort, Claude Code version and harness hash; rounds; holders, turns, human prompts, nudges, waits, fix cycles, artefacts). Nothing in it is typed by hand.

Workflow programmes (one Claude session whose workflow runs subagents, labelled `<role>:<key>[:<round>]`) are captured too: mesh reads the subagent hooks and Claude Code's workflow files, writes one record per role under `<git dir>/mesh/pending/<key>/`, and `mesh ledger stage <key>` copies them into the tree that commits the ledger. `mesh ledger export --repo A --repo B [--events] --out ledger.jsonl` gives an analysis tool one validated JSONL file.

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
pnpm spike e2e-offline         # M4: a programme four ways: no daemon, hub cut, hub restored mid-run, Solo
pnpm spike e2e-m45             # M4.5: criteria, blind sides, a routed impl-bug fix, an R3 gate (two people)
pnpm spike e2e-kit             # the shipped SDD kit: mesh assets install, one Claude session runs the whole cycle
pnpm test:claude               # contract suite: every Claude Code behaviour mesh relies on (run after upgrading Claude Code)
pnpm schemas                   # regenerate schemas/*.json after changing src/protocol
pnpm test:web                  # Playwright smoke test of the dashboard (after pnpm build)
```

## License

[PolyForm Noncommercial 1.0.0](LICENSE.md): free to use, change and share for any noncommercial purpose (personal, research, education, nonprofit and public institutions). Commercial use needs a separate license from the author. See [NOTICE](NOTICE).
