// RL-6: calibration and agent statistics, pure. Counted dismissals per raising agent, their
// calibration status (listed by an open or a done calibration goal), and the per-hash statistics of
// `GET /v1/agents/:key/stats`. The hub reads; these functions only count.

import type {
  AgentHashStats,
  AgentStats,
  Decider,
  DismissalRef,
  DispositionRow,
  DispositionVia,
  Goal,
  ItemHistoryEntry,
  StoredReview,
  Step,
} from "../protocol/index.ts";

/** An agent key and hash (`""` for no hash). */
export interface AgentRef {
  key: string;
  hash: string;
}

export function agentRefKey(a: AgentRef): string {
  return `${a.key}\n${a.hash}`;
}

/** The identity of a listed dismissal: the full ref. */
export function refKey(r: DismissalRef): string {
  return JSON.stringify([r.lineage, r.fp, r.goal, r.step, r.round, r.at]);
}

/** A disposition entry with its place in history order and whether it was reverted. */
export interface Entry extends DispositionRow {
  ord: number;
  reverted: boolean;
}

/**
 * Disposition rows (`listDispositions({})`, history order) flagged as reverted: the next history
 * entry of the item is a `revert`, or (a dismissal only) the same person replaced it in the same debrief
 * step and round (a change of mind).
 */
export function flagEntries(rows: readonly DispositionRow[], historyOf: (lineage: string, fp: string) => readonly ItemHistoryEntry[]): Entry[] {
  const out: Entry[] = rows.map((r, ord) => ({ ...r, ord, reverted: false }));
  const byItem = new Map<string, Entry[]>();
  for (const e of out) {
    const k = `${e.lineage}\n${e.fp}`;
    const list = byItem.get(k);
    if (list) list.push(e);
    else byItem.set(k, [e]);
  }
  for (const list of byItem.values()) {
    const first = list[0] as Entry;
    const history = historyOf(first.lineage, first.fp);
    let k = 0;
    for (let i = 0; i < history.length && k < list.length; i++) {
      const h = history[i] as ItemHistoryEntry;
      if (h.kind !== "disposition") continue;
      const e = list[k] as Entry;
      const next = history[i + 1];
      if (next?.kind === "revert") e.reverted = true;
      k++;
    }
    for (let j = 0; j + 1 < list.length; j++) {
      const e = list[j] as Entry;
      const n = list[j + 1] as Entry;
      if (
        e.disposition === "dismissed" &&
        e.via === "debrief-session" &&
        n.via === "debrief-session" &&
        e.decider.kind === "person" &&
        n.decider.kind === "person" &&
        n.decider.user === e.decider.user &&
        n.goal === e.goal &&
        n.step === e.step &&
        n.round === e.round
      )
        e.reverted = true;
    }
  }
  return out;
}

const goalLineage = (goal: string, lineage: string) => `${goal}\n${lineage}`;

/** The raising agent per `(goal, lineage)`: the decider of the newest raising record when an agent. */
export function raisingAgents(reviews: readonly StoredReview[]): Map<string, AgentRef | null> {
  const out = new Map<string, AgentRef | null>();
  for (const r of reviews) {
    if (!r.raising) continue;
    out.set(goalLineage(r.goal, r.lineage), r.decider.kind === "agent" ? { key: r.decider.key, hash: r.decider.hash ?? "" } : null);
  }
  return out;
}

export function raisingAgentOf(raising: ReadonlyMap<string, AgentRef | null>, goal: string, lineage: string): AgentRef | undefined {
  return raising.get(goalLineage(goal, lineage)) ?? undefined;
}

/** A counted dismissal: the earliest non-reverted dismissal per `(goal, lineage, fp)` of an agent-raised item. */
export interface Counted {
  ref: DismissalRef;
  raising: AgentRef;
  decider: Decider;
  via: DispositionVia;
  reason: string;
  answer?: string | undefined;
  ord: number;
}

export function countedDismissals(entries: readonly Entry[], raising: ReadonlyMap<string, AgentRef | null>): Counted[] {
  const seen = new Set<string>();
  const out: Counted[] = [];
  for (const e of entries) {
    if (e.disposition !== "dismissed" || e.reverted) continue;
    const agent = raisingAgentOf(raising, e.goal, e.lineage);
    if (!agent) continue;
    const k = `${e.goal}\n${e.lineage}\n${e.fp}`;
    if (seen.has(k)) continue;
    seen.add(k);
    out.push({
      ref: { lineage: e.lineage, fp: e.fp, goal: e.goal, step: e.step, round: e.round, at: e.at },
      raising: agent,
      decider: e.decider,
      via: e.via,
      reason: e.reason,
      ...(e.answer !== undefined ? { answer: e.answer } : {}),
      ord: e.ord,
    });
  }
  return out.sort((a, b) => a.ref.at - b.ref.at || a.ord - b.ord);
}

const sameAgent = (a: AgentRef, b: AgentRef) => a.key === b.key && a.hash === b.hash;
const isOpen = (g: Goal) => g.state !== "done" && g.state !== "dropped";

/** Calibration goals of an agent hash. */
export function calibrationGoals(goals: readonly Goal[], agent: AgentRef): Goal[] {
  return goals.filter((g) => g.calibration && sameAgent({ key: g.calibration.key, hash: g.calibration.hash }, agent));
}

/** The open calibration goal of an agent hash (the oldest, should there ever be two). */
export function openCalibration(goals: readonly Goal[], agent: AgentRef): Goal | undefined {
  return calibrationGoals(goals, agent)
    .filter(isOpen)
    .sort((a, b) => a.createdAt - b.createdAt)[0];
}

export type CalibrationStatus = "uncalibrated" | "calibrating" | "calibrated";

/** Refs listed by a done calibration goal → calibrated; by an open one → calibrating. Dropped goals list nothing. */
export function calibrationStatus(goals: readonly Goal[]): Map<string, Exclude<CalibrationStatus, "uncalibrated">> {
  const out = new Map<string, Exclude<CalibrationStatus, "uncalibrated">>();
  for (const g of goals) {
    if (!g.calibration || g.state === "done" || g.state === "dropped") continue;
    for (const r of g.calibration.dismissals) out.set(refKey(r), "calibrating");
  }
  for (const g of goals) {
    if (!g.calibration || g.state !== "done") continue;
    for (const r of g.calibration.dismissals) out.set(refKey(r), "calibrated");
  }
  return out;
}

export function statusOf(c: Counted, status: ReadonlyMap<string, Exclude<CalibrationStatus, "uncalibrated">>): CalibrationStatus {
  return status.get(refKey(c.ref)) ?? "uncalibrated";
}

/** The uncalibrated counted dismissals of an agent hash, oldest first. */
export function uncalibrated(counted: readonly Counted[], status: ReadonlyMap<string, Exclude<CalibrationStatus, "uncalibrated">>, agent: AgentRef): Counted[] {
  return counted.filter((c) => sameAgent(c.raising, agent) && statusOf(c, status) === "uncalibrated");
}

interface HashAcc extends Omit<AgentHashStats, "meanCostUsd" | "meanDurationMs" | "lastAt"> {
  costs: number[];
  durations: number[];
  last: number | undefined;
  anyDismissalAt: number | undefined;
}

/** `GET /v1/agents/:key/stats`: the statistics of an agent key per hash over the window. */
export function agentStats(o: {
  key: string;
  days: number;
  since: number;
  threshold: number;
  steps: readonly Step[];
  reviews: readonly StoredReview[];
  entries: readonly Entry[];
  raising: ReadonlyMap<string, AgentRef | null>;
  counted: readonly Counted[];
  status: ReadonlyMap<string, Exclude<CalibrationStatus, "uncalibrated">>;
  goals: readonly Goal[];
}): AgentStats {
  const { key, since } = o;
  const acc = new Map<string, HashAcc>();
  const of = (hash: string): HashAcc => {
    let a = acc.get(hash);
    if (!a) {
      a = {
        hash,
        runs: 0,
        failures: 0,
        raised: 0,
        new: 0,
        regressions: 0,
        carried: 0,
        undeclaredRules: 0,
        accepted: 0,
        dismissedByAgents: 0,
        dismissedByPeople: 0,
        reinstated: 0,
        uncalibrated: 0,
        calibrating: 0,
        calibrated: 0,
        costs: [],
        durations: [],
        last: undefined,
        anyDismissalAt: undefined,
      };
      acc.set(hash, a);
    }
    return a;
  };
  const seenAt = (a: HashAcc, at: number) => {
    a.last = a.last === undefined ? at : Math.max(a.last, at);
  };

  // Runs: rounds of headless steps with this agent key.
  for (const s of o.steps) {
    if (s.policy?.mode !== "headless") continue;
    for (const r of s.rounds ?? []) {
      const t = r.telemetry;
      if (!t || t.agentKey !== key || r.finishedAt < since) continue;
      const a = of(t.agentHash ?? "");
      a.runs++;
      if (r.outcome === "fail") a.failures++;
      if (t.costUsdEstimate !== undefined) a.costs.push(t.costUsdEstimate);
      a.durations.push(t.durationMs);
      seenAt(a, r.finishedAt);
    }
  }

  // Raising records of this agent key.
  for (const r of o.reviews) {
    if (!r.raising || r.decider.kind !== "agent" || r.decider.key !== key || r.at < since) continue;
    const a = of(r.decider.hash ?? "");
    a.raised += new Set(r.record.items.map((i) => i.fp)).size;
    a.new += r.fold?.new ?? 0;
    a.regressions += r.fold?.regression ?? 0;
    a.carried += r.fold?.carried ?? 0;
    a.undeclaredRules += r.undeclaredRules;
    seenAt(a, r.at);
  }

  // Accepted: distinct (goal, lineage, fp) of non-reverted acceptances of items this key raised.
  const accepted = new Set<string>();
  for (const e of o.entries) {
    if (e.disposition !== "accepted" || e.reverted || e.at < since) continue;
    const agent = raisingAgentOf(o.raising, e.goal, e.lineage);
    if (!agent || agent.key !== key) continue;
    const k = `${agent.hash}\n${e.goal}\n${e.lineage}\n${e.fp}`;
    const a = of(agent.hash);
    seenAt(a, e.at);
    if (accepted.has(k)) continue;
    accepted.add(k);
    a.accepted++;
  }

  // Counted dismissals of items this key raised.
  for (const c of o.counted) {
    if (c.raising.key !== key) continue;
    const a = of(c.raising.hash);
    a.anyDismissalAt = a.anyDismissalAt === undefined ? c.ref.at : Math.max(a.anyDismissalAt, c.ref.at);
    const st = statusOf(c, o.status);
    if (st === "uncalibrated") a.uncalibrated++;
    else if (st === "calibrating") a.calibrating++;
    else a.calibrated++;
    if (c.ref.at < since) continue;
    if (c.decider.kind === "agent") a.dismissedByAgents++;
    else a.dismissedByPeople++;
    seenAt(a, c.ref.at);
  }

  // Reinstated: this key's own dismissals whose next non-reverted disposition is a person's other decision.
  const live = o.entries.filter((e) => !e.reverted);
  const nextOf = new Map<number, Entry>();
  const lastByItem = new Map<string, Entry>();
  for (const e of live) {
    const k = `${e.lineage}\n${e.fp}`;
    const prev = lastByItem.get(k);
    if (prev) nextOf.set(prev.ord, e);
    lastByItem.set(k, e);
  }
  for (const e of live) {
    if (e.disposition !== "dismissed" || e.decider.kind !== "agent" || e.decider.key !== key) continue;
    const n = nextOf.get(e.ord);
    if (!n || n.decider.kind !== "person" || n.disposition === "dismissed" || n.at < since) continue;
    const a = of(e.decider.hash ?? "");
    a.reinstated++;
    seenAt(a, n.at);
  }

  // Open calibration goals of this key.
  const open = new Map<string, Goal>();
  for (const g of o.goals) {
    if (!g.calibration || g.calibration.key !== key) continue;
    const og = openCalibration(o.goals, { key, hash: g.calibration.hash });
    if (og) {
      open.set(g.calibration.hash, og);
      of(g.calibration.hash);
    }
  }

  const hashes: AgentHashStats[] = [];
  for (const a of acc.values()) {
    const cal = open.get(a.hash);
    const counts = [
      a.runs,
      a.failures,
      a.raised,
      a.new,
      a.regressions,
      a.carried,
      a.undeclaredRules,
      a.accepted,
      a.dismissedByAgents,
      a.dismissedByPeople,
      a.reinstated,
      a.uncalibrated,
      a.calibrating,
      a.calibrated,
    ];
    if (!cal && counts.every((n) => n === 0)) continue;
    const lastAt = a.last ?? a.anyDismissalAt ?? cal?.createdAt ?? 0;
    const { costs, durations, last: _last, anyDismissalAt: _any, ...rest } = a;
    hashes.push({
      ...rest,
      meanCostUsd: costs.length ? costs.reduce((x, y) => x + y, 0) / costs.length : null,
      meanDurationMs: durations.length ? Math.round(durations.reduce((x, y) => x + y, 0) / durations.length) : null,
      ...(cal ? { calibration: cal.id } : {}),
      lastAt,
    });
  }
  hashes.sort((x, y) => y.lastAt - x.lastAt || (x.hash < y.hash ? -1 : x.hash > y.hash ? 1 : 0));
  return { key, days: o.days, since, threshold: o.threshold, hashes };
}
