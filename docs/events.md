# Hub events

The hub keeps every change and observation as an event: `GET /v1/events?after=<seq>&limit=<n>` with a service token (`mesh hub token --service analytics`), or `mesh ledger export --events`. The JSON Schema of one event is in [`schemas/hub-event.json`](../schemas/hub-event.json).

The events are the **live, precise channel**. They keep exact times and things only visible live, such as waits, stalls and abandoned work. The hub deletes them after `events_retention_days` (default 180). The **durable summary** of every step, plan and goal is the ledger committed in the repos (`.mesh/goals/**`, format `mesh.ledger.v1`, see [ledger.md](guide/ledger.md)). Nothing in the ledger is typed by hand.

Every event has `seq`, `id`, `at` (ms, hub clock; daemon clock for synced `session.*` and `agent.*`), `type`, and optionally `user`, `sid`, `goal`, `step` and `payload`. When a service token acted for a person (`X-Mesh-On-Behalf-Of`, see [auth](guide/auth.md)), `user` is the person and `payload.via` the service.

## Written by the hub

| Type | When | Payload |
|---|---|---|
| `user.logged_in` | a login | `provider`, `client`, `machine` |
| `goal.created` | a new goal | `title`; goals made by a pulse or by ingest: `preset` (name), and for a pulse `pulse`, `slot`, and `trial: true` for a trial fire (0.1.30); a clean-audit goal opened by a sink: `sink` (`repo`, `topic`) |
| `goal.replan` | the design is reopened | `comment` |
| `goal.done` | the last step finished | — |
| `goal.dropped` | a pulse dropped the goal (its slot was missed, or its goal was abandoned), or a person dropped it (`mesh goal drop`; `user`) | `reason` (`missed`, `abandoned`, `person`); for `person` also `by` and `comment` (the `--reason`, when given) |
| `goal.sunk` | a sink stage (done or skipped) or `mesh items sink` added or reopened finding steps in a clean-audit goal, or a move put finding steps in it; one per clean-audit goal that got steps; `goal` = the clean-audit goal, `step` = the sink stage (or the audit step of a fold move). Activity: `<n> findings from <from> (<m> reopened)` | `goal`, `from` (the sink stage's id, `mesh items sink`, the audit step's id for a fold move, or `mesh items retarget`), `added` (created and moved steps), `reopened` (step ids) |
| `goal.sink_failed` | a sink stage could not sink (its topic is no longer defined); nothing of the sink was written, the stage's own change committed, and the stage got the note `sink failed: <reason>`; `goal`, `step` = the relay goal and its sink stage | `from` (the sink stage's id), `reason` |
| `plan.proposed` | `mesh_plan` / `mesh goal plan` | `version`, `steps` |
| `plan.approved` | approval | `version` |
| `plan.revised` | a person asked for changes | `version`, `comment` |
| `step.ready` | all dependencies done | — |
| `step.claimed` | a claim | — (`user`, `sid`) |
| `step.released` | `mesh_release` | `note` |
| `step.paused` | the holder's session ended or machine went offline | `reason` |
| `step.taken_over` | `mesh take` | `from` |
| `step.noted` | `mesh_note` | — |
| `step.done` / `step.failed` | `mesh_done`; `step.done` also when a later complete audit resolved the item of a ready or blocked finding step (`user` = the goal owner) | `summary`, `mr`, `reopen`, `round`, `commit` (from 0.1.32, when the round has one), `model`, `verdict`, `buckets`; a resolved finding: `summary` (`resolved by <audit step id>`), `by` (the goal owner) |
| `step.rejected` | `mesh_done` not accepted (reconcile: criteria not covered); the holder keeps the step | `reason`, `missing` |
| `step.parked` | a rule stopped the step (round cap, churn, stall, a bucket routed to a person, reconcile after a retry) | `reason`, `round` |
| `step.resumed` | a person resumed a parked or failed step | `comment`, `was` |
| `gate.approved` / `gate.rejected` | a person (or a recorded rule) decided a gate step | `gate`, `rule`, `comment`, `reopen` |
| `step.reopened` | a test, verify or review step failed it, or a gate was rejected; a finding step whose item was filed again (`refiled`: reopened, or a moved-away step revived by a sink), whose dismissal or deferral was reverted (`reverted`), or that a move reopened or revived (`moved`) | `by`, `reason` (bucket, criterion and assertion when given, never the tester's prose; `refiled`, `reverted` or `moved` for finding steps), `fixCycles`, `buckets`; finding steps: `by` = the goal owner (refiled), the reverting person, or the mover (the retarget caller, else the owner of the goal the step left), `from` = the sink stage, the debrief step, the audit step of a fold move or `mesh items retarget`. Activity for `moved`: `<step> reopened: its finding was moved here (fix cycle <n>)` |
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
| `run.finished` | a headless run ended (after its close-as-fail, if any) | `runId`, `round` (absent when the run has no round of its own), `branch`, `commit` (from 0.1.32: the run's result commit), and the telemetry fields (`turns`, `turnsApprox`, tokens, `costUsdEstimate`, `durationMs`, `exit`, `permissionDenials`, `toolsUsed` and `denied` from 0.1.30, …) |
| `profile.saved` | a permission profile was registered or replaced | `name`, `sha256`, `via` (the service that acted for `user`, when one did) |
| `review.recorded` | a review record was stored (`mesh_review`); `user`, `sid` | `round`, `lineage`, `coverage`, `assessment`, `items` (unique fingerprints), `artifact`, `fold` (raising records: `new`, `repeat`, `regression`, `resolved`, `carried`), `dispositions` (applied), `ignored`, `already` (dispositions a debrief already recorded with `mesh_dispose`; `0` outside debriefs), `undeclaredRules` (never item titles, evidence, proposals or reasons) |
| `item.disposed` | a consuming step's record set an item's disposition (one per applied disposition), or a debrief recorded a person's decision (`mesh_dispose`) | `lineage`, `fp`, `disposition`, `from`, `decider` (`agent` or `person`), `via` (`stage` or `debrief-session`), `round` (never the reason or the person's answer) |
| `item.reverted` | a debrief decision was reverted (Revert, TUI `u`); `user` | `lineage`, `fp`, `from` (the reverted state), `to` (the restored state), `round`, `via` (`ui`) (never a reason or title) |
| `item.retargeted` | an item's target repo changed: a raising record's item carries another `repo` (the fold; `goal`, `step` = the audit's goal and step) or `mesh items retarget` set it; `user` = the record's submitter or the caller. Activity: `retargeted item <fp> to <to>` | `lineage`, `fp`, `from`, `to` (target repos), `by` |
| `step.read` | the assignee marked a debrief's pre-read as read; `user` | `round` |
| `calibration.opened` | the hub opened a calibration goal for an agent hash (its uncalibrated dismissals reached the threshold); `goal` = the new goal, `user` = the calibrator. Activity: `opened calibration of <key>@<hash12> (<n> dismissals)` | `key`, `hash`, `dismissals` (listed), `disagreements` (listed, only when there are any), `threshold`, `calibrator` |
| `calibration.done` | a calibration goal became done (its listed dismissals are calibrated); `goal`. Activity: `calibration of <key>@<hash12> done: <outcome>` | `key`, `hash`, `dismissals` (listed), `disagreements` (listed, only when there are any), `outcome` (`change`: the `calibrate` record's assessment is `issues`; `no-change`: `clean`; else `none`) |
| `spot-check.opened` | a deciding agent's decision was sampled for a person's spot check (`spot_checks`); `goal` = the spot-check goal, `step` = its check step, `user` = the goal owner. Activity: `opened spot check <n> of <key>@<hash12> (<disposition> <fp>)` | `key`, `hash`, `sample` (its number), `lineage`, `fp`, `decisionGoal`, `decisionStep`, `round`, `disposition`, `why` (`rate` or `minimum`) |
| `spot-check.decided` | a person recorded a verdict on a sample (`mesh_spot_check`); `user`, `sid`, `goal`, `step`. Activity: `spot check <n> of <key>@<hash12>: <verdict>` | `key`, `hash`, `sample`, `lineage`, `fp`, `verdict` (`agree` or `disagree`), `expected` (with `disagree`, when given) (never the reason or the person's answer) |
| `step.skipped` | a conditional step (`when`) had nothing to consume when its dependencies were done | `reason` (`when`) |
| `step.dropped` | a new plan dropped the step, a pulse or a person dropped its goal, the item of a ready or blocked finding step was dismissed, deferred or its filing reverted, or an open finding step was moved to the clean-audit goal of its item's target repo | — (a new plan); `reason` (`missed`, `abandoned`) when a pulse dropped the goal, `person` when a person did, `dismissed`, `deferred` or `reverted` for a finding step, with `by` (also `user`) = the deciding person, or the goal owner for an agent decider; `moved` for a moved finding step, with `to` (the new step id) and `by` (also `user`) = the retarget caller, else the owner of the goal the step left. Activity for `moved`: `<step> moved to <new id>` |
| `pulse.created` | a pulse was saved | `pulse`, `title`, `preset` (name), `sha256`, `schedule`, `agents` (from 0.1.34: the roster pins as `[{key, hash}]`, when it pins any), `via` |
| `pulse.updated` | a pulse was changed, or a deleted topic was taken off it | `pulse`, `version`, `fields` (the changed body keys, sorted), `via`; from 0.1.34, when the update re-snapshots (a new `preset` or `params`): `preset` (name), `sha256` and `agents` (the pins, when any) |
| `pulse.paused` | the owner or an admin paused it; no `user` when the hub paused it because its owner is no longer a member | `pulse`, `reason`, `via` |
| `pulse.resumed` / `pulse.deleted` | resumed / removed | `pulse`, `via` |
| `pulse.fired` | a slot created a goal; `goal`, and `user` for a manual fire | `pulse`, `slot`, `manual`, `catchUp`, `trial` (a trial fire, 0.1.30), `via` |
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
