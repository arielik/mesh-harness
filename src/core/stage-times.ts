// RL-12: the times of a step in a run card (docs/specs/RL-12.md, "Stage times"). Pure.
import type { Plan, Step } from "../protocol/index.ts";

export interface StageTimes {
  readyAt?: number;
  startedAt?: number;
  waitMs?: number;
  cycleReadyAt?: number;
  waitingMs?: number;
}

/** A dep's first end: its first `done` round's finish; a skipped or dropped dep's `updatedAt`; else none. */
export function firstEnd(dep: Step): number | undefined {
  const done = (dep.rounds ?? []).find((r) => r.outcome === "done");
  if (done) return done.finishedAt;
  if (dep.state === "skipped" || dep.state === "dropped") return dep.updatedAt;
  return undefined;
}

const OPEN = new Set(["ready", "claimed", "paused"]);

/**
 * The stage times of `s`, a step of a goal whose steps are `steps` (by id, moved-away ones included
 * so deps resolve) and whose plans are `plans`.
 */
export function stageTimes(s: Step, steps: ReadonlyMap<string, Step>, plans: readonly Plan[], now: number): StageTimes {
  const out: StageTimes = {};
  let readyAt: number | undefined;
  if (s.deps.length) {
    let latest = -Infinity;
    let all = true;
    for (const id of s.deps) {
      const dep = steps.get(id);
      const end = dep ? firstEnd(dep) : undefined;
      if (end === undefined) {
        all = false;
        break;
      }
      latest = Math.max(latest, end);
    }
    if (all) readyAt = latest;
  } else {
    const local = s.id.slice(s.goal.length + 1);
    const plan = [...plans]
      .filter((p) => p.decision === "approved" && p.decidedAt !== undefined)
      .sort((a, b) => a.version - b.version)
      .find((p) => p.steps.some((x) => x.id === local));
    readyAt = plan?.decidedAt;
  }
  if (readyAt !== undefined) out.readyAt = readyAt;
  const first = s.rounds?.[0];
  const startedAt = first ? first.startedAt : s.state === "claimed" || s.state === "paused" ? s.claimedAt : undefined;
  if (startedAt !== undefined) out.startedAt = startedAt;
  if (startedAt !== undefined && readyAt !== undefined) out.waitMs = Math.max(0, startedAt - readyAt);
  // A later cycle: the step's own last round, a round that reopened it, or a dep done again.
  if (OPEN.has(s.state)) {
    const me = s.id.toLowerCase();
    let t = s.rounds?.at(-1)?.finishedAt;
    const later = (x: number) => {
      if (t === undefined || x > t) t = x;
    };
    for (const x of steps.values()) {
      if (x.goal !== s.goal) continue;
      for (const r of x.rounds ?? []) if (r.reopen?.some((id) => id.toLowerCase() === me)) later(r.finishedAt);
    }
    for (const id of s.deps) {
      const done = (steps.get(id)?.rounds ?? []).filter((r) => r.outcome === "done").at(-1);
      if (done) later(done.finishedAt);
    }
    if (t !== undefined && (readyAt === undefined || t > readyAt)) out.cycleReadyAt = t;
  }
  if (s.state === "ready") {
    const from = out.cycleReadyAt ?? readyAt;
    if (from !== undefined) out.waitingMs = Math.max(0, now - from);
  }
  return out;
}
