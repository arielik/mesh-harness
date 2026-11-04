// Autopilot decisions (plan §3.6). The daemon executes them through delivery.

import type { Session } from "../protocol/index.ts";

export type AutopilotLevel = "off" | "nudge" | "chain";
export const MAX_NUDGES = 2;

export type Action = { kind: "nudge"; text: string } | { kind: "escalate" };

export function nudgeText(step: string): string {
  return `MESH: continue with step ${step}. If you are blocked, call mesh_ask; if the step is finished, call mesh_done.`;
}

/**
 * What to do with a session now. Never acts on needs-you sessions (questions and dialogs go to the
 * person). Chaining to the next step happens right after mesh_done, not here.
 */
export function decide(s: Session, level: AutopilotLevel): Action | null {
  if (level === "off" || s.state !== "stalled" || !s.step) return null;
  if ((s.nudges ?? 0) < MAX_NUDGES) return { kind: "nudge", text: nudgeText(s.step) };
  if (!s.escalated) return { kind: "escalate" };
  return null;
}
