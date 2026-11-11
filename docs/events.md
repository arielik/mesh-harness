# Hub events

The hub keeps every change and observation as an event: `GET /v1/events?after=<seq>&limit=<n>` with a service token (`mesh hub token --service analytics`), or `mesh ledger export --events`. The JSON Schema of one event is in [`schemas/hub-event.json`](../schemas/hub-event.json).

The events are the **live, precise channel**. They keep exact times and things only visible live, such as waits, stalls and abandoned work. The hub deletes them after `events_retention_days` (default 180). The **durable summary** of every step, plan and goal is the ledger committed in the repos (`.mesh/goals/**`, format `mesh.ledger.v1`, see [ledger.md](guide/ledger.md)). Nothing in the ledger is typed by hand.

Every event has `seq`, `id`, `at` (ms, hub clock; daemon clock for synced `session.*` and `agent.*`), `type`, and optionally `user`, `sid`, `goal`, `step` and `payload`.

## Written by the hub

| Type | When | Payload |
|---|---|---|
| `user.logged_in` | a login | `provider`, `client`, `machine` |
| `goal.created` | a new goal | `title` |
| `goal.replan` | the design is reopened | `comment` |
| `goal.done` | the last step finished | — |
| `plan.proposed` | `mesh_plan` / `mesh goal plan` | `version`, `steps` |
| `plan.approved` | approval | `version` |
| `plan.revised` | a person asked for changes | `version`, `comment` |
| `step.ready` | all dependencies done | — |
| `step.claimed` | a claim | — (`user`, `sid`) |
| `step.released` | `mesh_release` | `note` |
| `step.paused` | the holder's session ended or machine went offline | `reason` |
| `step.taken_over` | `mesh take` | `from` |
| `step.noted` | `mesh_note` | — |
| `step.done` / `step.failed` | `mesh_done` | `summary`, `mr`, `reopen`, `round`, `model`, `verdict`, `buckets` |
| `step.rejected` | `mesh_done` not accepted (reconcile: criteria not covered); the holder keeps the step | `reason`, `missing` |
| `step.parked` | a rule stopped the step (round cap, churn, stall, a bucket routed to a person, reconcile after a retry) | `reason`, `round` |
| `step.resumed` | a person resumed a parked or failed step | `comment`, `was` |
| `gate.approved` / `gate.rejected` | a person (or a recorded rule) decided a gate step | `gate`, `rule`, `comment`, `reopen` |
| `step.reopened` | a test, verify or review step failed it, or a gate was rejected | `by`, `reason` (bucket, criterion and assertion when given, never the tester's prose), `fixCycles`, `buckets` |
| `step.dropped` | a new plan removed it | — |
| `question.asked` / `question.answered` | `mesh_ask` / an answer | `question` |
| `message.sent` | a person messaged a session | `id` |
| `message.delivered` | the daemon delivered or failed a message | `id`, `state`, `method` |
| `machine.named` | a machine was named or its name cleared | `machine`, `nickname` (null when cleared) |
| `machine.labelled` | a machine's labels changed | `machine`, `labels` |
| `hub.events_pruned` | retention ran | `count`, `days` |

A plan replaced before anyone decided is stored as `superseded`, not `revised`. It emits no `plan.revised`, so design rounds count only human requests for changes.

## Synced by daemons

Only for sessions that hold a step; other sessions stay on the laptop.

| Type | When | Payload |
|---|---|---|
| `session.provenance` | a session takes a step | `claude_code`, `harness` (`hash`, `parts`), `repo_commit`, `mesh`, `model` |
| `session.turn_started` | a turn starts | `delivered` (true: mesh typed it), `model`, `repo` |
| `session.turn_stopped` | a turn ends | `effort`, `permission_mode` |
| `session.waiting` | the session needs a person | `needs` (permission, question, dialog, input) |
| `session.stalled` | no progress | — |
| `session.nudged` / `session.escalated` | autopilot | `n` |
| `session.rebound` | `/clear`, resume | — |
| `session.ended` | the session ended | `reason` |

## Workflow programmes

One Claude session runs many subagents (a workflow's `agent()` calls, or Task). They are captured from the `SubagentStart` and `SubagentStop` hooks plus Claude Code's own workflow files.

| Type | When | Payload |
|---|---|---|
| `agent.finished` | a labelled subagent finished | `key` (the team's id from the label), `role`, `label`, `model`, `workflow`, `workflow_run`, `started`, `finished`, `result` (scalar fields of the typed result), `repo` |

The event id is derived from the agent id, so capturing an agent again never duplicates it.
