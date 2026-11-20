// RL-14: efficiency cards of a goal and its steps, figures in a window, and the stuck signal. Pure:
// the hub passes the steps, the state time rows and the events it read, and the clock.

import type { Goal, Round, Step } from "../protocol/index.ts";
import type { GoalEfficiency, Rollup, SessionTime, StateDay, StateTime, StepEfficiency, StepFigures, StepWindowRow } from "../protocol/index.ts";
import { apportion, totals } from "./state-time.ts";

/** One session's state time on one step, as the hub stores it. */
export interface TimeRow {
  step: string;
  sid: string;
  userId: string;
  machineId: string;
  asOf: number;
  days: StateDay[];
}

/** The events the figures count. */
export interface FigureEvent {
  at: number;
  type: string;
  step?: string | undefined;
}

export const FIGURE_EVENTS = ["session.turn_started", "step.reopened", "step.taken_over"] as const;

const zeroTime = (): StateTime => ({ workingMs: 0, needsYouMs: 0, idleMs: 0, stalledMs: 0 });
function addTime(a: StateTime, b: StateTime): StateTime {
  return { workingMs: a.workingMs + b.workingMs, needsYouMs: a.needsYouMs + b.needsYouMs, idleMs: a.idleMs + b.idleMs, stalledMs: a.stalledMs + b.stalledMs };
}
const pickTime = (t: StateTime): StateTime => ({ workingMs: t.workingMs, needsYouMs: t.needsYouMs, idleMs: t.idleMs, stalledMs: t.stalledMs });

/** Figures from the given rounds, events and state time (absent `time`: no row). */
function figures(rounds: readonly Round[], events: readonly FigureEvent[], time: StateTime | undefined): StepFigures {
  const runs = rounds.filter((r) => r.telemetry);
  const costs = runs.map((r) => r.telemetry?.costUsdEstimate).filter((c): c is number => c !== undefined);
  return {
    ...(time ? { stateTime: time } : {}),
    turns: events.filter((e) => e.type === "session.turn_started").length,
    rounds: rounds.length,
    fails: rounds.filter((r) => r.outcome === "fail").length,
    parks: rounds.filter((r) => r.parked !== undefined).length,
    commits: rounds.filter((r) => r.commit !== undefined).length,
    takeOvers: events.filter((e) => e.type === "step.taken_over").length,
    runs: runs.length,
    runDurationMs: runs.reduce((n, r) => n + (r.telemetry?.durationMs ?? 0), 0),
    runTurns: runs.reduce((n, r) => n + (r.telemetry?.turns ?? 0), 0),
    ...(costs.length ? { costUsd: round4(costs.reduce((n, c) => n + c, 0)) } : {}),
  };
}

const round4 = (n: number) => Math.round(n * 10_000) / 10_000;

/** A step is done first try: done now, no fix cycle, no failed round. */
export function firstTry(s: Step): boolean {
  return s.state === "done" && s.fixCycles === 0 && !(s.rounds ?? []).some((r) => r.outcome === "fail");
}

function sessionTimes(rows: readonly TimeRow[]): SessionTime[] {
  const by = new Map<string, SessionTime>();
  for (const r of rows) {
    const t = totals(r.days);
    const cur = by.get(r.sid);
    if (!cur) by.set(r.sid, { sid: r.sid, user: r.userId, machine: r.machineId, asOf: r.asOf, ...t });
    else by.set(r.sid, { ...cur, ...addTime(cur, t), asOf: Math.max(cur.asOf, r.asOf) });
  }
  return [...by.values()].sort((a, b) => (a.sid < b.sid ? -1 : a.sid > b.sid ? 1 : 0));
}

/** The card of one step, all time. `rows` and `events` are the step's own. */
export function stepCard(s: Step, rows: readonly TimeRow[], events: readonly FigureEvent[], now: number): StepEfficiency {
  const rounds = s.rounds ?? [];
  const time = rows.length ? rows.map((r) => totals(r.days)).reduce(addTime, zeroTime()) : undefined;
  const startedAt = rounds[0]?.startedAt ?? ((s.state === "claimed" || s.state === "paused") && s.claimedAt !== undefined ? s.claimedAt : undefined);
  const newest = rounds.at(-1);
  let endAt: number | undefined;
  if ((s.state === "done" || s.state === "failed") && newest) endAt = newest.finishedAt;
  else if ((s.state === "dropped" || s.state === "skipped") && startedAt !== undefined) endAt = s.updatedAt;
  const withCommit = [...rounds].reverse().find((r) => r.commit !== undefined);
  const done = s.state === "done";
  return {
    step: s.id,
    kind: s.kind,
    mode: s.policy?.mode ?? "interactive",
    repo: s.repo,
    state: s.state,
    fixCycles: s.fixCycles,
    ...((s.state === "claimed" || s.state === "paused") && s.holderUser ? { holder: s.holderUser } : {}),
    ...(s.movedTo ? { movedTo: s.movedTo } : {}),
    ...(startedAt !== undefined ? { startedAt } : {}),
    ...(endAt !== undefined ? { endAt } : {}),
    ...(startedAt !== undefined ? { wallMs: Math.max(0, (endAt ?? now) - startedAt) } : {}),
    ...(withCommit ? { commit: withCommit.commit, commitAt: withCommit.finishedAt } : {}),
    ...figures(rounds, events, time),
    done,
    firstTryPass: firstTry(s),
    sessions: sessionTimes(rows),
  };
}

/** Sum of figures (stateTime and costUsd absent when absent on every part). */
function sumFigures(parts: readonly StepFigures[]): StepFigures & { stateTimeSteps: number } {
  const timed = parts.filter((p) => p.stateTime);
  const costs = parts.filter((p) => p.costUsd !== undefined);
  const n = (f: (p: StepFigures) => number) => parts.reduce((a, p) => a + f(p), 0);
  return {
    ...(timed.length ? { stateTime: timed.map((p) => p.stateTime as StateTime).reduce(addTime, zeroTime()) } : {}),
    stateTimeSteps: timed.length,
    turns: n((p) => p.turns),
    rounds: n((p) => p.rounds),
    fails: n((p) => p.fails),
    parks: n((p) => p.parks),
    commits: n((p) => p.commits),
    takeOvers: n((p) => p.takeOvers),
    runs: n((p) => p.runs),
    runDurationMs: n((p) => p.runDurationMs),
    runTurns: n((p) => p.runTurns),
    ...(costs.length ? { costUsd: round4(costs.reduce((a, p) => a + (p.costUsd as number), 0)) } : {}),
  };
}

/** The card of a goal: every step (in the order given), summed. */
export function goalCard(goal: Goal, steps: readonly Step[], rows: readonly TimeRow[], events: readonly FigureEvent[], now: number): GoalEfficiency {
  const lc = (x: string) => x.toLowerCase();
  const cards = steps.map((s) =>
    stepCard(
      s,
      rows.filter((r) => lc(r.step) === lc(s.id)),
      events.filter((e) => e.step !== undefined && lc(e.step) === lc(s.id)),
      now,
    ),
  );
  let endAt: number | undefined;
  if (goal.state === "done" || goal.state === "dropped") {
    const ends = cards.map((c) => c.endAt).filter((x): x is number => x !== undefined);
    endAt = ends.length ? Math.max(...ends) : goal.updatedAt;
  }
  return {
    goal: goal.id,
    title: goal.title,
    state: goal.state,
    trial: goal.trial === true,
    createdAt: goal.createdAt,
    ...(endAt !== undefined ? { endAt } : {}),
    wallMs: Math.max(0, (endAt ?? now) - goal.createdAt),
    ...sumFigures(cards),
    fixCycles: cards.reduce((a, c) => a + c.fixCycles, 0),
    steps: cards.length,
    done: cards.filter((c) => c.done).length,
    firstTryPass: cards.filter((c) => c.firstTryPass).length,
    sessions: sessionTimes(rows),
    stepCards: cards,
  };
}

/**
 * A step's figures inside `[since, until)`, or undefined when the step is not in the window (no
 * state time inside it, no round finished in it, no counted event in it).
 */
export function stepWindow(s: Step, rows: readonly TimeRow[], events: readonly FigureEvent[], since: number, until: number): StepWindowRow | undefined {
  const inW = (t: number) => t >= since && t < until;
  const rounds = (s.rounds ?? []).filter((r) => inW(r.finishedAt));
  const evs = events.filter((e) => inW(e.at));
  let any = false;
  let time: StateTime | undefined;
  if (rows.length) {
    time = zeroTime();
    for (const r of rows) {
      const a = apportion(r.days, r.asOf, since, until);
      if (a.any) any = true;
      time = addTime(time, pickTime(a));
    }
  }
  if (!any && !rounds.length && !evs.length) return undefined;
  const newest = s.rounds?.at(-1);
  const done = s.state === "done" && newest?.outcome === "done" && inW(newest.finishedAt) ? 1 : 0;
  return {
    step: s.id,
    repo: s.repo,
    ...figures(rounds, evs, time),
    reopens: evs.filter((e) => e.type === "step.reopened").length,
    done,
    firstTryPass: done && firstTry(s) ? 1 : 0,
  };
}

/** Sums of window rows. */
export function rollup(rows: readonly StepWindowRow[]): Rollup {
  return {
    steps: rows.length,
    ...sumFigures(rows),
    reopens: rows.reduce((a, r) => a + r.reopens, 0),
    done: rows.reduce((a, r) => a + r.done, 0),
    firstTryPass: rows.reduce((a, r) => a + r.firstTryPass, 0),
  };
}

/** Turns of a step after its newest round with a commit (all turns when none has one). */
export function turnsSinceCommit(s: Step, events: readonly FigureEvent[]): { turns: number; commit?: string; commitAt?: number } {
  const c = [...(s.rounds ?? [])].reverse().find((r) => r.commit !== undefined);
  const after = c?.finishedAt ?? Number.NEGATIVE_INFINITY;
  const turns = events.filter((e) => e.type === "session.turn_started" && e.at > after).length;
  return { turns, ...(c?.commit ? { commit: c.commit, commitAt: c.finishedAt } : {}) };
}
