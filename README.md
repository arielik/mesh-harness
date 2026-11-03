# mesh-harness

One place to see and steer all your Claude Code sessions, across repos and people.

- Proposal: [docs/analysis/2026-11-03-mesh-harness-proposal.md](docs/analysis/2026-11-03-mesh-harness-proposal.md)
- Journeys, dashboard and analysis: [docs/analysis/2026-11-03-journeys-dashboard-and-analysis.md](docs/analysis/2026-11-03-journeys-dashboard-and-analysis.md)
- Implementation plan (leads development): [docs/plan/implementation-plan.md](docs/plan/implementation-plan.md)
- M0 spike results: [docs/spikes/README.md](docs/spikes/README.md)

## Development

Requires pnpm. Node 24 is downloaded by pnpm (`devEngines`). tmux is needed for tests from M1 on.

```bash
pnpm install
pnpm check        # lint, typecheck, module boundaries, tests, build
node dist/main.mjs --help
```

Spikes against real Claude Code (uses your subscription; model haiku):

```bash
MESH_SPIKE_TMP=/tmp pnpm spike print
MESH_SPIKE_TMP=/tmp pnpm spike interactive   # also trusts a scratch folder used by the next one
MESH_SPIKE_TMP=/tmp pnpm spike background
```
