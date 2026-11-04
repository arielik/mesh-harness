// The trail every run leaves in the repo (journeys doc §3.1): goal.yaml, plan versions and one
// record per step. Pure: facts are computed from hub events passed in.

import { stringify } from "yaml";
import type { Goal, Plan, Step, StepFacts, TrailFile } from "../protocol/index.ts";

export interface FactEvent {
  at: number;
  type: string;
  user?: string | undefined;
  sid?: string | undefined;
  step?: string | undefined;
  payload: Record<string, unknown>;
}

const iso = (ms: number | undefined) => (ms === undefined ? undefined : new Date(ms).toISOString().replace(/:\d\d\.\d{3}Z$/, "Z"));

/** Compute a step's facts from the events that mention it (sorted by time). */
export function stepFacts(step: Step, events: readonly FactEvent[]): StepFacts {
  const evs = [...events].filter((e) => e.step === step.id).sort((a, b) => a.at - b.at);
  const holders: StepFacts["holders"] = [];
  const sessions = new Set<string>();
  const models = new Set<string>();
  let turns = 0;
  let humanPrompts = 0;
  let nudges = 0;
  let waitCount = 0;
  let waitMs = 0;
  const waitingSince = new Map<string, number>();
  let finishedAt: number | undefined;

  const closeHolder = (at: number) => {
    const last = holders.at(-1);
    if (last && last.to === undefined) last.to = at;
  };
  for (const e of evs) {
    if (e.sid) sessions.add(e.sid);
    const model = e.payload.model;
    if (typeof model === "string" && model) models.add(model);
    switch (e.type) {
      case "step.claimed":
      case "step.taken_over":
        if (e.user && holders.at(-1)?.user !== e.user) {
          closeHolder(e.at);
          holders.push({ user: e.user, from: e.at });
        }
        break;
      case "step.released":
      case "step.paused":
        closeHolder(e.at);
        break;
      case "step.done":
      case "step.failed":
        closeHolder(e.at);
        finishedAt = e.at;
        break;
      case "session.turn_started": {
        turns++;
        if (e.payload.delivered !== true) humanPrompts++;
        const since = e.sid ? waitingSince.get(e.sid) : undefined;
        if (since !== undefined && e.sid) {
          waitMs += e.at - since;
          waitingSince.delete(e.sid);
        }
        break;
      }
      case "session.waiting":
        waitCount++;
        if (e.sid && !waitingSince.has(e.sid)) waitingSince.set(e.sid, e.at);
        break;
      case "session.nudged":
        nudges++;
        break;
    }
  }
  const startedAt = holders[0]?.from;
  return {
    holders,
    sessions: [...sessions],
    models: [...models],
    turns,
    humanPrompts,
    nudges,
    waits: { count: waitCount, minutes: Math.round(waitMs / 6_000) / 10 },
    fixCycles: step.fixCycles,
    ...(startedAt !== undefined ? { startedAt } : {}),
    ...(finishedAt !== undefined ? { finishedAt } : {}),
  };
}

export function goalDir(goal: string): string {
  return `.mesh/goals/${goal}`;
}

export function stepRecordPath(step: Step): string {
  return `${goalDir(step.goal)}/steps/${step.id.slice(step.goal.length + 1)}.md`;
}

/** The step record: YAML front matter plus the summary (and notes) as the body. */
export function stepRecord(step: Step, facts: StepFacts, notes: readonly { user: string; text: string }[] = []): TrailFile {
  const front: Record<string, unknown> = {
    goal: step.goal,
    step: step.id.slice(step.goal.length + 1),
    kind: step.kind,
    repo: step.repo,
    plan: `v${step.planVersion}`,
    holders: facts.holders.map((h) => ({ user: h.user, from: iso(h.from), ...(h.to !== undefined ? { to: iso(h.to) } : {}) })),
    sessions: facts.sessions,
    models: facts.models,
    turns: facts.turns,
    human_prompts: facts.humanPrompts,
    nudges: facts.nudges,
    waits: facts.waits,
    fix_cycles: facts.fixCycles,
    outcome: step.outcome ?? step.state,
    ...(step.mr ? { mr: step.mr } : {}),
    ...(step.branch ? { branch: step.branch } : {}),
    ...(facts.startedAt !== undefined ? { started: iso(facts.startedAt) } : {}),
    ...(facts.finishedAt !== undefined ? { finished: iso(facts.finishedAt) } : {}),
  };
  const body = [step.summary ?? "", ...(notes.length ? ["", "Notes:", ...notes.map((n) => `- ${n.user}: ${n.text.replace(/\n+/g, " ")}`)] : [])].join("\n").trim();
  return { path: stepRecordPath(step), text: `---\n${stringify(front, { lineWidth: 0 }).trimEnd()}\n---\n${body}\n` };
}

export function goalFile(goal: Goal): TrailFile {
  const doc = {
    id: goal.id,
    title: goal.title,
    owner: goal.ownerId,
    ...(goal.primaryRepo ? { primary_repo: goal.primaryRepo } : {}),
    ...(goal.repos?.length ? { repos: goal.repos } : {}),
    ...(goal.issueUrl ? { issue: goal.issueUrl } : {}),
    created: iso(goal.createdAt),
  };
  return { path: `${goalDir(goal.id)}/goal.yaml`, text: stringify(doc, { lineWidth: 0 }) };
}

/** plan.vN.yaml: the steps plus the decision (approval record) once decided. */
export function planFile(plan: Plan): TrailFile {
  const doc = {
    goal: plan.goal,
    version: plan.version,
    ...(plan.designRef ? { design: plan.designRef } : {}),
    proposed: { by: plan.proposedBy, at: iso(plan.proposedAt) },
    decision: plan.decision,
    ...(plan.decidedBy ? { decided: { by: plan.decidedBy, at: iso(plan.decidedAt), ...(plan.comment ? { comment: plan.comment } : {}) } } : {}),
    steps: plan.steps.map((s) => ({ id: s.id, repo: s.repo, kind: s.kind, title: s.title, ...(s.deps.length ? { deps: s.deps } : {}), brief: s.brief })),
  };
  return { path: `${goalDir(plan.goal)}/plan.v${plan.version}.yaml`, text: stringify(doc, { lineWidth: 0 }) };
}

export interface PlanDiff {
  added: string[];
  removed: string[];
  changed: string[];
}

/** What changed between two plan versions (by step id). */
export function diffPlans(a: Plan | undefined, b: Plan): PlanDiff {
  const before = new Map((a?.steps ?? []).map((s) => [s.id, JSON.stringify(s)]));
  const after = new Map(b.steps.map((s) => [s.id, JSON.stringify(s)]));
  return {
    added: [...after.keys()].filter((id) => !before.has(id)),
    removed: [...before.keys()].filter((id) => !after.has(id)),
    changed: [...after.keys()].filter((id) => before.has(id) && before.get(id) !== after.get(id)),
  };
}
