# Later

These items are deliberately left out of [the implementation plan](plan/implementation-plan.md). To take one on, move it into a milestone of the plan with acceptance checks.

| Item | Why it was deferred |
|---|---|
| `mesh run --lane` (open one session per ready step of a lane) | `mesh run --step` once per step covers it |
| Lane computation and critical-path rendering on the Goal page | The DAG laid out by depth is enough at first |
| Design contributors (several sessions co-writing a design) | Notes on the design step cover the first need |
| Replan matching by brief hash | Matching by step id is simpler and predictable |
| Push export sinks (webhook, JSONL) | mesh-ai pulls `GET /v1/events?after=` |
| Node SEA single binaries | The npm package is enough to start (the hub image moved to M4.6) |
| Claude Code channels as a delivery path | Research preview; revisit once stable |
| GitLab issue import, comments, MR guard | Optional integration (M5) |
| JWT/JWKS for other services | The hub's opaque tokens plus service tokens are enough |
| Local web "My sessions" page | The TUI covers it, and it adds local CSRF surface |
| Token usage via OpenTelemetry | An analysis concern for mesh-ai, opt-in |
| Replay evals | mesh-ai, after step records exist |
| TanStack Query in the web app | A small fetch + SSE hook was enough for the Live page |
| A real-Kanidm test in CI | The mock issuer covers the protocol; verify against a lab Kanidm manually |
| Goal model and goal identity (backlog, capabilities, use cases in git, in owner or dedicated repos; see `architecture-and-standards`) | Owner decision 15: debate separately; until then programme records are keyed by the team's own ids and Solo goals stay local |
| Publishing goals created offline to the team hub | Depends on the goal model |
| RL-19 (queued 2026-11-20): findings roll-up per preset and repo, `open`/`accepted` by severity S1-S4 with the latest report artifact (a `GET /v1/findings/rollup?days=` route, or a repo breakdown in `GET /v1/health` findings), its own `/healthz` feature; optionally a `kind` per preset | Requested by a dashboard client that today makes 2 + 2·pulses + lineages calls per page; not started, waits for the owner's go |
| RL-20 (queued 2026-11-21): a read-only preset check route that runs the pulse preset checks on `{preset: {name, text, sha256}, params}` without writing (no pulse, pin or event) and answers `{ok, problems, warnings, steps?, agents?}`, with its own `/healthz` feature | Requested by a dashboard client composing presets before they become pulses; not started, waits for the owner's go |
