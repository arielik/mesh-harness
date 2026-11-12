# Hub events

The hub keeps every change and observation as an event: `GET /v1/events?after=<seq>&limit=<n>` with a service token (`mesh hub token --service analytics`), or `mesh ledger export --events`. The JSON Schema of one event is in [`schemas/hub-event.json`](../schemas/hub-event.json).

The events are the **live, precise channel**. They keep exact times and things only visible live, such as waits, stalls and abandoned work. The hub deletes them after `events_retention_days` (default 180). The **durable summary** of every step, plan and goal is the ledger committed in the repos (`.mesh/goals/**`, format `mesh.ledger.v1`, see [ledger.md](guide/ledger.md)). Nothing in the ledger is typed by hand.

Every event has `seq`, `id`, `at` (ms, hub clock; daemon clock for synced `session.*` and `agent.*`), `type`, and optionally `user`, `sid`, `goal`, `step` and `payload`.

## Written by the hub

| Type | When | Payload |
|---|---|---|
| `user.logged_in` | a login | `provider`, `client`, `machine` |
| `goal.created` | a new goal | `title`; goals made by a pulse or by ingest: `preset` (name), and for a pulse `pulse`, `slot` |
| `goal.replan` | the design is reopened | `comment` |
| `goal.done` | the last step finished | — |
| `goal.dropped` | a pulse dropped the goal: its slot was missed, or its goal was abandoned | `reason` (`missed`, `abandoned`) |
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
| `step.offered` | a step was offered to a machine (`mesh assign`, `mesh_assign`, a goal's stick); `user` = the offerer, `sid` = the offering session | `machine` (target machine id), `sid` (target session, when named), `auto`, `note`, `stick` |
| `step.accepted` | the target machine accepted the offer (an accept, or a claim from that machine); `user`, `sid` = the accepting session | `machine`, `sid` |
| `step.declined` | the offer was declined | `machine`, `note` |
| `step.offer_expired` | the offer was not accepted within `thresholds.offer_expiry` | `machine` |
| `step.offer_withdrawn` | the offerer or an admin withdrew it, the offerer claimed the step, the step left `ready`, or a pulse moved on | `machine`, `reason` (`claimed by the offerer`, `step <state>`, `pulse: not accepted in time`, `pulse: slot missed`) |
| `step.artifact` | an artifact was stored for a held step (`mesh_artifact`, a run's transcript); `user`, `sid` | `id`, `kind`, `round`, `bytes`, `sha256`, `redactions` (never the content) |
| `run.started` | a machine started a headless run of the step | `runId`, `machine`, `profile`, `profileHash` (the profile the offer carried) |
| `run.finished` | a headless run ended (after its close-as-fail, if any) | `runId`, `round` (absent when the run has no round of its own), `branch`, and the telemetry fields (`turns`, `turnsApprox`, tokens, `costUsdEstimate`, `durationMs`, `exit`, `permissionDenials`, …) |
| `profile.saved` | a permission profile was registered or replaced | `name`, `sha256` |
| `review.recorded` | a review record was stored (`mesh_review`); `user`, `sid` | `round`, `lineage`, `coverage`, `assessment`, `items` (unique fingerprints), `artifact`, `fold` (raising records: `new`, `repeat`, `regression`, `resolved`, `carried`), `dispositions` (applied), `ignored`, `already` (dispositions a debrief already recorded with `mesh_dispose`; `0` outside debriefs), `undeclaredRules` (never item titles, evidence, proposals or reasons) |
| `item.disposed` | a consuming step's record set an item's disposition (one per applied disposition), or a debrief recorded a person's decision (`mesh_dispose`) | `lineage`, `fp`, `disposition`, `from`, `decider` (`agent` or `person`), `via` (`stage` or `debrief-session`), `round` (never the reason or the person's answer) |
| `item.reverted` | a debrief decision was reverted (Revert, TUI `u`); `user` | `lineage`, `fp`, `from` (the reverted state), `to` (the restored state), `round`, `via` (`ui`) (never a reason or title) |
| `step.read` | the assignee marked a debrief's pre-read as read; `user` | `round` |
| `step.skipped` | a conditional step (`when`) had nothing to consume when its dependencies were done | `reason` (`when`) |
| `step.dropped` | a new plan dropped the step, or a pulse dropped its goal | — (a new plan); `reason` (`missed`, `abandoned`) when a pulse dropped the goal |
| `pulse.created` | a pulse was saved | `pulse`, `title`, `preset` (name), `sha256`, `schedule` |
| `pulse.updated` | a pulse was changed, or a deleted topic was taken off it | `pulse`, `version`, `fields` (the changed body keys, sorted) |
| `pulse.paused` | the owner or an admin paused it; no `user` when the hub paused it because its owner is no longer a member | `pulse`, `reason` |
| `pulse.resumed` / `pulse.deleted` | resumed / removed | `pulse` |
| `pulse.fired` | a slot created a goal; `goal`, and `user` for a manual fire | `pulse`, `slot`, `manual`, `catchUp` |
| `pulse.skipped` | a slot was skipped while an earlier goal runs | `pulse`, `slot`, `reason` (`overlap`), `running` (that goal) |
| `pulse.missed` | a slot was missed; `goal` when it had one | `pulse`, `slot`, `reason` (`no_machine`, `not_accepted`, `capacity`, `expired`, `hub_down`, `error`), `tried` (machines offered), `error` (reason `error` only) |
| `pulse.abandoned` | a started goal older than `maxGoalAge` was dropped; `goal` | `pulse`, `slot` |
| `catalog.saved` | an admin registered a catalog source or changed its folder/calibrator; `user` | `repo`, `folder` |
| `catalog.pushed` | a machine pushed the committed definitions of a catalog source; `user` | `repo`, `commit`, `added` (new definitions), `count` (current definitions) |
| `agents.reported` | a sync changed the agent files a machine reports; `user` | `machine`, `count` |
| `hub.events_pruned` | retention ran | `count`, `days` |

Pulse event payloads never carry the preset text or a profile's settings. Roster event payloads
never carry agent texts, descriptions or paths.

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
