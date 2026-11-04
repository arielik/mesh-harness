// How to get a message into a session (plan §6.4, spikes S1, S4, S8). Pure decision; the daemon
// executes it.

import { promptIsFree, type Rules } from "../core/index.ts";
import type { Session } from "../protocol/index.ts";

export type DeliveryPlan =
  | { method: "stop" } // wait: the next Stop hook returns it as additionalContext
  | { method: "paste"; pane: string }
  | { method: "wake"; bgId: string; sessionId: string }
  | { method: "wait"; reason: string }
  | { method: "fail"; reason: string };

/** Maximum time a message may stay pending before it is marked failed. */
export const MESSAGE_TTL_MS = 60 * 60_000;

export function planDelivery(s: Session | undefined, now: number, rules?: Rules): DeliveryPlan {
  if (!s || s.state === "ended") return { method: "fail", reason: "session ended" };
  if (s.state === "working") return { method: "stop" };
  if (s.state === "needs_you" && (s.needs === "permission" || s.needs === "dialog")) {
    return { method: "wait", reason: `a ${s.needs} dialog is open` };
  }
  if (s.pane && promptIsFree(s, now, rules)) return { method: "paste", pane: s.pane };
  const sessionId = s.claudeSessionIds.at(-1);
  const o = s.observed;
  if (s.kind === "background" && s.bgId && sessionId && o?.state === "done" && o.status !== "waiting" && o.status !== "busy") {
    return { method: "wake", bgId: s.bgId, sessionId };
  }
  if (s.pane) return { method: "wait", reason: "waiting for the prompt to be free" };
  return { method: "wait", reason: "no way to type into this session; it will get the message when its turn ends" };
}
