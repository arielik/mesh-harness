// RL-18: spot checks of deciding agents, pure. The sampling rule (a hash of the decision below the
// rate, else a per-week minimum), and the counted disagreements calibration adds to an agent hash's
// counted dismissals. The hub reads and writes; these functions only decide and count.

import { createHash } from "node:crypto";
import type { DismissalRef, Goal, SpotSample } from "../protocol/index.ts";
import { type AgentRef, refKey } from "./calibration.ts";

export const SPOT_WEEK_MS = 7 * 86_400_000;
/** The most samples one spot-check goal holds; the next sample opens another goal. */
export const SPOT_MAX_SAMPLES = 50;

/** `u` of a decision: the first 8 hex digits of sha256(JSON [lineage, fp, step, round]) over 2^32. */
export function spotU(d: { lineage: string; fp: string; step: string; round: number }): number {
  const hex = createHash("sha256").update(JSON.stringify([d.lineage, d.fp, d.step, d.round]), "utf8").digest("hex").slice(0, 8);
  return parseInt(hex, 16) / 2 ** 32;
}

/**
 * Whether a decision is sampled: `rate` when its `u` is below the rate, else `minimum` when fewer than
 * `minPerWeek` samples of its agent were taken in the last 7 days (`recent`), else not.
 */
export function spotWhy(u: number, cfg: { rate: number; minPerWeek: number }, recent: number): "rate" | "minimum" | undefined {
  if (u < cfg.rate) return "rate";
  if (recent < cfg.minPerWeek) return "minimum";
  return undefined;
}

const sameAgent = (a: AgentRef, b: AgentRef) => a.key === b.key && a.hash === b.hash;
const isOpen = (g: Goal) => g.state !== "done" && g.state !== "dropped";

/** Spot-check goals of an agent hash (any state). */
export function spotCheckGoals(goals: readonly Goal[], agent: AgentRef): Goal[] {
  return goals.filter((g) => g.spotCheck && sameAgent({ key: g.spotCheck.key, hash: g.spotCheck.hash }, agent));
}

/** Samples of an agent hash taken at or after `since`, over its spot-check goals in any state. */
export function recentSamples(goals: readonly Goal[], agent: AgentRef, since: number): number {
  let n = 0;
  for (const g of spotCheckGoals(goals, agent)) for (const s of g.spotCheck?.samples ?? []) if (s.sampledAt >= since) n++;
  return n;
}

/** The ref of a sample (the decision's history entry). */
export function sampleRef(s: SpotSample): DismissalRef {
  return { lineage: s.lineage, fp: s.fp, goal: s.goal, step: s.step, round: s.round, at: s.at };
}

/** A counted disagreement: a `disagree` verdict on a sample of a spot-check goal (any state). */
export interface Disagreement {
  ref: DismissalRef;
  agent: AgentRef;
  /** The verdict's time. */
  at: number;
  sample: SpotSample;
}

export function countedDisagreements(goals: readonly Goal[]): Disagreement[] {
  const out: Disagreement[] = [];
  for (const g of goals) {
    const c = g.spotCheck;
    if (!c) continue;
    for (const s of c.samples) {
      if (s.verdict?.verdict !== "disagree") continue;
      out.push({ ref: sampleRef(s), agent: { key: c.key, hash: c.hash }, at: s.verdict.at, sample: s });
    }
  }
  return out.sort((a, b) => a.at - b.at || (refKey(a.ref) < refKey(b.ref) ? -1 : refKey(a.ref) > refKey(b.ref) ? 1 : 0));
}

/** Disagreement refs of an agent listed by an open calibration goal → calibrating; by a done one → calibrated. */
export function disagreementStatus(goals: readonly Goal[], agent: AgentRef): Map<string, "calibrating" | "calibrated"> {
  const out = new Map<string, "calibrating" | "calibrated">();
  const mine = goals.filter((g) => g.calibration && sameAgent({ key: g.calibration.key, hash: g.calibration.hash }, agent));
  for (const g of mine) if (isOpen(g)) for (const r of g.calibration?.disagreements ?? []) out.set(refKey(r), "calibrating");
  for (const g of mine) if (g.state === "done") for (const r of g.calibration?.disagreements ?? []) out.set(refKey(r), "calibrated");
  return out;
}

/** The uncalibrated counted disagreements of an agent hash, oldest verdict first. */
export function uncalibratedDisagreements(goals: readonly Goal[], agent: AgentRef): Disagreement[] {
  const status = disagreementStatus(goals, agent);
  return countedDisagreements(goals).filter((d) => sameAgent(d.agent, agent) && !status.has(refKey(d.ref)));
}

/** Open spot checks: samples without a verdict in open spot-check goals. */
export function openSpotChecks(goals: readonly Goal[]): SpotSample[] {
  const out: SpotSample[] = [];
  for (const g of goals) if (g.spotCheck && isOpen(g)) for (const s of g.spotCheck.samples) if (!s.verdict) out.push(s);
  return out;
}
