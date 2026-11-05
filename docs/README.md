# mesh-harness documentation

mesh gives you one place to see and steer every Claude Code session you and your team run, across repos and people. It also leaves a ledger in git of how the work went, so you can tell whether a model, a prompt or your process changed for the better.

Everything is in this repository. You need Claude Code on a subscription login, Node and git; no API keys, no Agent SDK, no other repository.

## Start here

| If you want to… | Read |
|---|---|
| understand what mesh is and isn't | [Overview](guide/overview.md) |
| install it and get going in Solo mode | [Install](guide/install.md) |
| do something specific, with examples | [How-to](guide/howto.md) |
| learn the words (goal, step, round, segment, gate, blind, programme…) | [Concepts](guide/concepts.md) |
| run a spec-driven development cycle | [The development cycle](guide/cycle.md) and [the SDD kit](../assets/sdd/README.md) |
| set up sign-in for a team (none, tokens, OIDC) | [Auth](guide/auth.md) |
| run the hub: backup, retention, upgrades, privacy switches | [Operations](guide/operations.md) |
| read or analyse the records mesh writes | [The ledger](guide/ledger.md), [events](events.md), [JSON Schemas](../schemas) |
| see it all in pictures | [How mesh-harness works](explainer/how-mesh-harness-works.html) (open in a browser) |

## A first session in five commands

```bash
pnpm install && pnpm build && alias mesh="node $PWD/dist/main.mjs"
mesh setup && mesh up            # hooks into Claude Code; the daemon with its own local hub
mesh run my-repo                 # Claude in tmux, and the session list next to it
mesh goal new "My first goal" --repo my-repo && mesh run --design G1
mesh show G1
```

More in the [how-to](guide/howto.md).

## The pieces

- **Hooks** (7, fire-and-forget, localhost only). They tell the daemon about sessions and subagents.
- **The daemon** (`mesh up`). Your sessions, message delivery, autopilot, the records it writes into repos, and a local hub for Solo.
- **MCP tools** (8) for agents: `mesh_context`, `mesh_next`, `mesh_claim`, `mesh_release`, `mesh_note`, `mesh_done`, `mesh_ask`, `mesh_plan`.
- **The hub** (`mesh hub`). Shared goals, plans, steps, claims, gates, the event log and the web dashboard.
- **The ledger.** `.mesh/goals/**` in your repos: generated records (`mesh.ledger.v1`), committed with the work. `mesh ledger export` turns them into JSONL for any analysis tool.
- **The SDD kit** (`assets/sdd`, `mesh assets install`). Agents, an unattended programme workflow, and a spec template. Plus plan templates (`mesh preset ls`).

## For contributors

| | |
|---|---|
| [Implementation plan](plan/implementation-plan.md) | milestones M0–M4.5 with what was built, how it was tested and where it differs |
| [Design history](analysis/README.md) | the proposal, journeys, critic analyses and decisions |
| [Claude Code spikes](spikes/README.md) | what mesh relies on in Claude Code, verified; re-check with `pnpm test:claude` |
| [Later](later.md) | ideas deliberately deferred |
| [Dependencies](dependencies.md) | third-party packages and why |

Development: `pnpm check` (lint, typecheck, module boundaries, tests, build), `pnpm test:web` (Playwright), and `pnpm spike <name>` for the end-to-end checks against real Claude Code (see the top-level README).

## License

[PolyForm Noncommercial 1.0.0](../LICENSE.md): free for any noncommercial purpose. Commercial use needs a separate license from the author.
