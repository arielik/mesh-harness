# Later

These items are deliberately left out of [the implementation plan](plan/implementation-plan.md). To take one on, move it into a milestone of the plan with acceptance checks.

| Item | Why it was deferred |
|---|---|
| `mesh run --lane` (open one session per ready step of a lane) | `mesh run --step` once per step covers it |
| Lane computation and critical-path rendering on the Goal page | The DAG laid out by depth is enough at first |
| Design contributors (several sessions co-writing a design) | Notes on the design step cover the first need |
| Replan matching by brief hash | Matching by step id is simpler and predictable |
| Push export sinks (webhook, JSONL) | mesh-ai pulls `GET /v1/events?after=` |
| Node SEA single binaries, hub container image | The npm package is enough to start |
| Claude Code channels as a delivery path | Research preview; revisit once stable |
| GitLab issue import, comments, MR guard | Optional integration (M5) |
| JWT/JWKS for other services | The hub's opaque tokens plus service tokens are enough |
| Local web "My sessions" page | The TUI covers it, and it adds local CSRF surface |
| Token usage via OpenTelemetry | An analysis concern for mesh-ai, opt-in |
| Replay evals | mesh-ai, after step records exist |
