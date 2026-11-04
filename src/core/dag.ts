// Step DAG rules (plan §3.4): plan validation, materializing steps, readiness, reopen.

import type { PlanStep, Step } from "../protocol/index.ts";

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

const SATISFIED = new Set(["done", "dropped"]);

/** blocked ↔ ready according to deps. Claimed/paused/done/failed/dropped steps are left alone. */
export function recomputeReady(steps: readonly Step[], now: number): Step[] {
  const byId = new Map(steps.map((s) => [s.id, s]));
  const changed: Step[] = [];
  for (const s of steps) {
    if (s.state !== "blocked" && s.state !== "ready") continue;
    const ok = s.deps.every((d) => SATISFIED.has(byId.get(d)?.state ?? "dropped"));
    const want = ok ? "ready" : "blocked";
    if (s.state !== want) {
      const next = { ...s, state: want, updatedAt: now } as Step;
      byId.set(s.id, next);
      changed.push(next);
    }
  }
  return changed;
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
    const fields = { kind: p.kind, repo: p.repo, title: p.title, brief: p.brief, deps: p.deps.map(full), planVersion: version };
    if (old) {
      if (old.state === "done") {
        out.set(id, { ...old, planVersion: version });
        continue;
      }
      const next: Step = { ...old, ...fields, state: old.state === "dropped" ? "blocked" : old.state, updatedAt: now };
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

/** Reopen done steps after a dependent failed: they become ready again (fix cycle). */
export function reopen(steps: readonly Step[], ids: readonly string[], now: number): Step[] {
  const all = new Map(steps.map((s) => [s.id, s]));
  const changed = new Map<string, Step>();
  for (const id of ids) {
    const s = all.get(id);
    if (!s || s.state !== "done") continue;
    const next: Step = { ...s, state: "ready", fixCycles: s.fixCycles + 1, updatedAt: now };
    delete next.outcome;
    delete next.holderSid;
    all.set(id, next);
    changed.set(id, next);
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
