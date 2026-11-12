// Step DAG rules (plan §3.4): plan validation, materializing steps, readiness, reopen.

import type { PlanStep, Step } from "../protocol/index.ts";
import { policyOf } from "./policy.ts";

export const MAX_STEPS = 50;

function distance(a: string, b: string): number {
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array<number>(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) (d[0] as number[])[j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      const row = d[i] as number[];
      const prev = d[i - 1] as number[];
      row[j] = Math.min((prev[j] as number) + 1, (row[j - 1] as number) + 1, (prev[j - 1] as number) + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
  }
  return (d[a.length] as number[])[b.length] as number;
}

function suggest(name: string, ids: string[]): string {
  const best = ids.map((id) => ({ id, d: distance(name, id) })).sort((x, y) => x.d - y.d)[0];
  return best && best.d <= 2 ? `; did you mean "${best.id}"?` : "";
}

/** Validate a plan's steps; errors are phrased so an agent can fix them. */
export function validatePlan(steps: readonly PlanStep[]): string[] {
  const errors: string[] = [];
  if (steps.length === 0) errors.push("a plan needs at least one step");
  if (steps.length > MAX_STEPS) errors.push(`a plan has at most ${MAX_STEPS} steps (got ${steps.length})`);
  const ids = steps.map((s) => s.id);
  const seen = new Set<string>();
  for (const id of ids) {
    if (id === "design") errors.push('step id "design" is reserved for the design step');
    if (seen.has(id)) errors.push(`step id "${id}" is used more than once`);
    seen.add(id);
  }
  for (const s of steps) {
    for (const dep of s.deps) {
      if (dep === s.id) errors.push(`step "${s.id}": depends on itself`);
      else if (!seen.has(dep)) errors.push(`step "${s.id}": dep "${dep}" not found${suggest(dep, ids)}`);
    }
  }
  if (errors.length === 0) {
    const cycle = findCycle(steps);
    if (cycle) errors.push(`dependency cycle: ${cycle.join(" → ")}`);
  }
  return errors;
}

function findCycle(steps: readonly PlanStep[]): string[] | undefined {
  const deps = new Map(steps.map((s) => [s.id, s.deps]));
  const state = new Map<string, 1 | 2>();
  const stack: string[] = [];
  const visit = (id: string): string[] | undefined => {
    if (state.get(id) === 2) return undefined;
    if (state.get(id) === 1) return [...stack.slice(stack.indexOf(id)), id];
    state.set(id, 1);
    stack.push(id);
    for (const d of deps.get(id) ?? []) {
      const c = visit(d);
      if (c) return c;
    }
    stack.pop();
    state.set(id, 2);
    return undefined;
  };
  for (const s of steps) {
    const c = visit(s.id);
    if (c) return c;
  }
  return undefined;
}

/** RL-2: a skipped dependency counts as satisfied (as done). */
const SATISFIED = new Set(["done", "dropped", "skipped"]);

function depsSatisfied(s: Step, byId: ReadonlyMap<string, Step>): boolean {
  return s.deps.every((d) => SATISFIED.has(byId.get(d)?.state ?? "dropped"));
}

/**
 * blocked ↔ ready according to deps. Claimed/paused/done/failed/dropped/skipped steps are left
 * alone. RL-2: a blocked step with `policy.when` is never made ready here (only `settle` decides it).
 */
export function recomputeReady(steps: readonly Step[], now: number): Step[] {
  const byId = new Map(steps.map((s) => [s.id, s]));
  const changed: Step[] = [];
  for (const s of steps) {
    if (s.state !== "blocked" && s.state !== "ready") continue;
    const ok = depsSatisfied(s, byId);
    const want = ok ? (s.state === "blocked" && s.policy?.when ? "blocked" : "ready") : "blocked";
    if (s.state !== want) {
      const next = { ...s, state: want, updatedAt: now } as Step;
      byId.set(s.id, next);
      changed.push(next);
    }
  }
  return changed;
}

/**
 * RL-2: readiness with conditional stages. Repeated until nothing changes: a blocked step whose deps
 * are satisfied becomes ready (no `when`, or `holds`) or skipped; a ready or skipped step with an
 * unsatisfied dep goes back to blocked. `holds` is called only for steps with `policy.when`.
 */
export function settle(steps: readonly Step[], now: number, holds: (s: Step) => boolean): { changed: Step[]; skipped: string[] } {
  const byId = new Map(steps.map((s) => [s.id, s]));
  const before = new Map(steps.map((s) => [s.id, s.state]));
  const memo = new Map<string, boolean>();
  const held = (s: Step) => {
    let v = memo.get(s.id);
    if (v === undefined) {
      v = holds(s);
      memo.set(s.id, v);
    }
    return v;
  };
  const touched = new Set<string>();
  for (let pass = 0; pass <= steps.length + 1; pass++) {
    let moved = false;
    for (const s0 of steps) {
      const s = byId.get(s0.id) as Step;
      let want: Step["state"] | undefined;
      if (s.state === "blocked") {
        if (depsSatisfied(s, byId)) want = !s.policy?.when || held(s) ? "ready" : "skipped";
      } else if (s.state === "ready" || s.state === "skipped") {
        if (!depsSatisfied(s, byId)) want = "blocked";
      }
      if (want && want !== s.state) {
        byId.set(s.id, { ...s, state: want, updatedAt: now });
        touched.add(s.id);
        moved = true;
      }
    }
    if (!moved) break;
  }
  const changed = [...touched].map((id) => byId.get(id) as Step).filter((s) => s.state !== before.get(s.id));
  return { changed, skipped: changed.filter((s) => s.state === "skipped").map((s) => s.id) };
}

/** Stable JSON (keys sorted) for comparing policies. */
function canon(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canon).join(",")}]`;
  if (v && typeof v === "object") {
    return `{${Object.keys(v)
      .sort()
      .filter((k) => (v as Record<string, unknown>)[k] !== undefined)
      .map((k) => `${JSON.stringify(k)}:${canon((v as Record<string, unknown>)[k])}`)
      .join(",")}}`;
  }
  return JSON.stringify(v) ?? "null";
}

export interface Materialized {
  /** Steps to insert or update (state already recomputed). */
  upserts: Step[];
  /** Claimed steps whose brief changed: their holders should be told. */
  changedForHolder: Step[];
}

/**
 * Turn an approved plan into steps (plan §3.4, replan rules): done steps stay; steps with the same
 * id keep their state; steps no longer in the plan are dropped; new steps start blocked.
 */
export function materialize(goal: string, version: number, plan: readonly PlanStep[], existing: readonly Step[], now: number): Materialized {
  const full = (local: string) => `${goal}.${local}`;
  const current = new Map(existing.map((s) => [s.id, s]));
  const inPlan = new Set(plan.map((p) => full(p.id)));
  const out = new Map<string, Step>();
  const changedForHolder: Step[] = [];

  for (const p of plan) {
    const id = full(p.id);
    const old = current.get(id);
    const policy = policyOf(p);
    const fields = { kind: p.kind, repo: p.repo, title: p.title, brief: p.brief, deps: p.deps.map(full), planVersion: version, ...(policy ? { policy } : {}) };
    if (old) {
      if (old.state === "done") {
        out.set(id, { ...old, planVersion: version });
        continue;
      }
      // RL-2: a skipped step stays skipped while its definition is unchanged; changed, it waits again.
      // A ready step that has `when` and changed is decided again as well (never made ready here).
      const same = () =>
        old.kind === p.kind && old.repo === p.repo && old.title === p.title && old.brief === p.brief && canon(old.deps) === canon(fields.deps) && canon(old.policy ?? {}) === canon(policy ?? {});
      let state = old.state === "dropped" ? "blocked" : old.state;
      if (old.state === "skipped" || (old.state === "ready" && policy?.when)) state = same() ? old.state : "blocked";
      const next: Step = { ...old, ...fields, state, updatedAt: now };
      if (!policy) delete next.policy;
      if (old.brief !== p.brief && (old.state === "claimed" || old.state === "paused")) changedForHolder.push(next);
      out.set(id, next);
    } else {
      out.set(id, { id, goal, ...fields, state: "blocked", fixCycles: 0, updatedAt: now });
    }
  }
  for (const old of existing) {
    if (inPlan.has(old.id) || old.kind === "design" || old.state === "done" || old.state === "dropped") continue;
    const dropped: Step = { ...old, state: "dropped", updatedAt: now };
    delete dropped.holderSid;
    if (dropped.offer?.state === "accepted") delete dropped.offer;
    out.set(old.id, dropped);
  }
  const all = new Map(existing.map((s) => [s.id, s]));
  for (const [id, s] of out) all.set(id, s);
  for (const s of recomputeReady([...all.values()], now)) {
    all.set(s.id, s);
    out.set(s.id, s);
  }
  return { upserts: [...out.values()], changedForHolder };
}

/**
 * Reopen done steps after a dependent failed: they become ready again (fix cycle). Done steps
 * downstream of a reopened step wait again too (M4.5): work built on the old result is redone
 * (a review after a spec fix, a combine after a code fix, a gate after either).
 */
export function reopen(steps: readonly Step[], ids: readonly string[], now: number): Step[] {
  const all = new Map(steps.map((s) => [s.id, s]));
  const changed = new Map<string, Step>();
  for (const id of ids) {
    const s = all.get(id);
    if (!s || s.state !== "done") continue;
    const next: Step = { ...s, state: "ready", fixCycles: s.fixCycles + 1, updatedAt: now };
    delete next.outcome;
    delete next.holderSid;
    // MM-3: a later holder's work is not reported to the offerer of an accepted offer.
    if (next.offer?.state === "accepted") delete next.offer;
    all.set(id, next);
    changed.set(id, next);
  }
  const queue = [...changed.keys()];
  while (queue.length) {
    const id = queue.shift() as string;
    // RL-2: skipped dependants wait again too (they are decided again once their deps are done).
    for (const d of [...all.values()].filter((x) => x.deps.includes(id) && (x.state === "done" || x.state === "skipped"))) {
      const next: Step = { ...d, state: "blocked", updatedAt: now };
      delete next.outcome;
      delete next.holderSid;
      if (next.offer?.state === "accepted") delete next.offer;
      all.set(d.id, next);
      changed.set(d.id, next);
      queue.push(d.id);
    }
  }
  // Ready dependents of a reopened step wait again.
  for (const s of recomputeReady([...all.values()], now)) {
    all.set(s.id, s);
    changed.set(s.id, s);
  }
  return [...changed.values()];
}

/** Direct dependents of a step. */
export function dependents(steps: readonly Step[], id: string): Step[] {
  return steps.filter((s) => s.deps.includes(id));
}

/** Topological order (dependencies first), stable by plan order. */
export function topoOrder(steps: readonly Step[]): Step[] {
  const byId = new Map(steps.map((s) => [s.id, s]));
  const done = new Set<string>();
  const out: Step[] = [];
  const visit = (s: Step, depth: number) => {
    if (done.has(s.id) || depth > steps.length) return;
    for (const d of s.deps) {
      const dep = byId.get(d);
      if (dep) visit(dep, depth + 1);
    }
    done.add(s.id);
    out.push(s);
  };
  for (const s of steps) visit(s, 0);
  return out;
}

/** Depth of each step: 0 for steps without (known) deps, else 1 + the deepest dep. For layouts. */
export function depths(steps: readonly Step[]): Map<string, number> {
  const byId = new Map(steps.map((s) => [s.id, s]));
  const memo = new Map<string, number>();
  const depth = (s: Step, guard: number): number => {
    const known = memo.get(s.id);
    if (known !== undefined) return known;
    if (guard > steps.length) return 0;
    const deps = s.deps.map((d) => byId.get(d)).filter((d): d is Step => d !== undefined);
    const v = deps.length ? 1 + Math.max(...deps.map((d) => depth(d, guard + 1))) : 0;
    memo.set(s.id, v);
    return v;
  };
  for (const s of steps) depth(s, 0);
  return memo;
}

/** Steps grouped by depth, each level in plan order. */
export function levels(steps: readonly Step[]): Step[][] {
  const d = depths(steps);
  const out: Step[][] = [];
  for (const s of steps) {
    const i = d.get(s.id) ?? 0;
    (out[i] ??= []).push(s);
  }
  return out.map((l) => l ?? []);
}
