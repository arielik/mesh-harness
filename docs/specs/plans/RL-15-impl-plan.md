# Implementation plan: docs/specs/RL-15.md

1. **Protocol.** `src/protocol/duration.ts` (leaf: `DURATION_RE`, `DurationSpec`, `durationMs`), re-exported
   from `pulse.ts`. `Overlap` gains `queue`, `supersede`; `SlotState` gains `queued`; `PulseSlot` gains
   `queued`, `superseded`, `carry` (`Carry`). `StepPolicy` gains `sla` (1h..30d) and `auto_accept`
   (S3/S4); `Step.overdue`. `DispositionVia` gains `auto-accept`; `SLA_DECIDER`. `Attention.kind`
   gains `debrief_overdue`; `RunCard` gains `queued`, `superseded`; health `slots.queued`,
   `debriefs.overdue`, `debriefs.breaches` (`DebriefBreach`); `HUB_FEATURES`.
2. **Core.** `presets.ts`: `Preset.debrief`, parsed strictly, written by `presetText`, copied by
   `instantiate` onto debrief steps. `policy.ts`: `policyOf` copies `sla`, `auto_accept`;
   `validatePolicies` adds the five texts. `src/core/sla.ts` (pure): `slaState(step, steps, plans,
   now)` → `{since, dueAt, escalateAt, breached, escalated}`.
3. **Hub, overlap** (`fireSlot`): busy goal helper shared by skip/queue/supersede and release;
   abandon skips waiting goals under supersede (non-trial fire); queue/replace; supersede = carry,
   sink, `dropGoal(…, "superseded")`, `pulse.superseded`; the goal creation moved into
   `createSlotGoal` used by fire and release. `releaseQueued(now)` in `tick` after `advancePending`.
4. **Hub, carry**: `debriefSet(step, goal, steps)` used by `debriefData`, `holdsFor` (debrief
   steps), `disposeStep`, `submitReview` (debrief); evidence of carried items from the row's `last`
   record.
5. **Hub, SLA**: `debriefSlaTick(now)` (events, `Step.overdue` with `updatedAt` kept, auto-accept);
   revert, `isRevertable`, `decidedViews`, `sessionDecision`, `own` take `auto-accept`; 403 text;
   `attentionFor` items; health `queued`, `blockedBy` for queue/supersede, `overdue`, `breaches`;
   run-card `queued`, `superseded`, `startWaitMs`.
6. **CLI**: `--overlap` usage; fire prints queued, skipped with the pulse's policy.
7. **Docs**: concepts, scheduled-reviews, operations, events, implementation plan; `node
   scripts/schemas.ts`.
