// RL-15: the SLA state of a debrief step (docs/specs/RL-15.md, "Debrief SLA"). Pure.
import { durationMs, type Plan, type Step } from "../protocol/index.ts";
import { stageTimes } from "./stage-times.ts";

export interface SlaState {
  slaMs: number;
  /** When the debrief began to wait in this cycle (`cycleReadyAt ?? readyAt`). */
  since: number;
  /** `since + slaMs`. */
  dueAt: number;
  /** `since + 2 × slaMs`. */
  escalateAt: number;
  breached: boolean;
  escalated: boolean;
}

const OPEN = new Set(["ready", "claimed", "paused"]);

/**
 * The SLA state of `s` at `now`, or undefined when it has none: not a debrief with `sla`, not
 * `ready`, `claimed` or `paused`, or without a waiting-since time. `steps` holds the goal's steps by id.
 */
export function slaState(s: Step, steps: ReadonlyMap<string, Step>, plans: readonly Plan[], now: number): SlaState | undefined {
  const sla = s.policy?.mode === "debrief" ? s.policy.sla : undefined;
  if (sla === undefined || !OPEN.has(s.state)) return undefined;
  const slaMs = durationMs(sla);
  if (slaMs === undefined) return undefined;
  const t = stageTimes(s, steps, plans, now);
  const since = t.cycleReadyAt ?? t.readyAt;
  if (since === undefined) return undefined;
  const dueAt = since + slaMs;
  const escalateAt = since + 2 * slaMs;
  return { slaMs, since, dueAt, escalateAt, breached: now >= dueAt, escalated: now >= escalateAt };
}
