// The stage table (M4.5, R13; owner decision 10): one ordered list of categories per kind of
// thing, and every panel and count in the TUI, `mesh show` and the web is built from it.
// Categories never overlap; each count is the length of its list (tested as a property).

import type { Message, Session, Step } from "../protocol/index.ts";

export type SessionStage = "NEEDS YOU" | "WORKING" | "STALLED / QUIET" | "IDLE" | "ENDED";
export const SESSION_STAGES: readonly SessionStage[] = ["NEEDS YOU", "WORKING", "STALLED / QUIET", "IDLE", "ENDED"];

export function sessionStage(s: Session): SessionStage {
  if (s.state === "needs_you") return "NEEDS YOU";
  if (s.state === "stalled" || (s.state === "working" && s.quiet)) return "STALLED / QUIET";
  if (s.state === "working") return "WORKING";
  if (s.state === "ended") return "ENDED";
  return "IDLE";
}

export type StepStage = "needs a person" | "in progress" | "paused" | "ready" | "waiting" | "done" | "dropped";
export const STEP_STAGES: readonly StepStage[] = ["needs a person", "in progress", "paused", "ready", "waiting", "done", "dropped"];

/** Parked and failed steps, and gates waiting for a decision, need a person; everything else is work. */
export function stepStage(s: Step): StepStage {
  switch (s.state) {
    case "parked":
    case "failed":
      return "needs a person";
    case "ready":
      return s.kind === "gate" ? "needs a person" : "ready";
    case "claimed":
      return "in progress";
    case "paused":
      return "paused";
    case "blocked":
      return "waiting";
    case "done":
      return "done";
    case "dropped":
      return "dropped";
  }
}

export type MessageStage = "waiting" | "delivered" | "failed delivery";
export const MESSAGE_STAGES: readonly MessageStage[] = ["waiting", "delivered", "failed delivery"];

export function messageStage(m: Message): MessageStage {
  return m.state === "pending" ? "waiting" : m.state === "delivered" ? "delivered" : "failed delivery";
}

/** Items by stage, in stage order, every stage present (possibly empty). */
export function partition<T, S extends string>(items: readonly T[], stageOf: (t: T) => S, order: readonly S[]): { stage: S; items: T[] }[] {
  const by = new Map<S, T[]>(order.map((s) => [s, []]));
  for (const t of items) {
    const list = by.get(stageOf(t));
    if (!list) throw new Error(`stage ${stageOf(t)} is not in the table`);
    list.push(t);
  }
  return order.map((stage) => ({ stage, items: by.get(stage) ?? [] }));
}

/** "2 needs a person · 1 in progress · …": counts of non-empty stages, from the partition itself. */
export function stageSummary<T, S extends string>(items: readonly T[], stageOf: (t: T) => S, order: readonly S[]): string {
  return partition(items, stageOf, order)
    .filter((p) => p.items.length)
    .map((p) => `${p.items.length} ${p.stage}`)
    .join(" · ");
}
