// The trail every run leaves in the repo (journeys doc §3.1), in the mesh.ledger.v1 format (M4):
// goal.yaml, plan versions and one record per step. Pure: facts are computed from hub events
// passed in. Everything here is generated; nothing is typed by hand.

import { stringify } from "yaml";
import { LEDGER_SCHEMA, type Goal, type Harness, type Plan, type Segment, type Step, type StepFacts, type TrailFile } from "../protocol/index.ts";

export interface FactEvent {
  at: number;
  type: string;
  user?: string | undefined;
  sid?: string | undefined;
  step?: string | undefined;
  payload: Record<string, unknown>;
}

/** ISO time in UTC, to the minute (records are summaries; exact times stay in hub events). */
export const iso = (ms: number | undefined) => (ms === undefined ? undefined : new Date(ms).toISOString().replace(/:\d\d\.\d{3}Z$/, "Z"));
/** ISO time in UTC, to the second. */
export const isoSec = (ms: number | undefined) => (ms === undefined ? undefined : new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z"));
const minutes = (ms: number) => Math.round(ms / 6_000) / 10;
const str = (v: unknown) => (typeof v === "string" && v ? v : undefined);

interface SegAcc {
  seg: Segment;
  waitingSince?: number | undefined;
  workingSince?: number | undefined;
  waitMs: number;
  activeMs: number;
}

/** Compute a step's facts from the events that mention it (sorted by time). */
export function stepFacts(step: Step, events: readonly FactEvent[]): StepFacts {
  const evs = [...events].filter((e) => e.step === step.id).sort((a, b) => a.at - b.at);
  const holders: StepFacts["holders"] = [];
  const models = new Set<string>();
  const segs = new Map<string, SegAcc>();
  let finishedAt: number | undefined;

  const closeHolder = (at: number) => {
    const last = holders.at(-1);
    if (last && last.to === undefined) last.to = at;
  };
  const segOf = (e: FactEvent): SegAcc | undefined => {
    if (!e.sid) return undefined;
    let a = segs.get(e.sid);
    if (!a) {
      a = { seg: { sid: e.sid, from: e.at, turns: 0, humanPrompts: 0, nudges: 0, waits: { count: 0, minutes: 0 }, activeMinutes: 0 }, waitMs: 0, activeMs: 0 };
      segs.set(e.sid, a);
    }
    if (e.user && !a.seg.user) a.seg.user = e.user;
    a.seg.to = e.at;
    return a;
  };
  const stopWorking = (a: SegAcc, at: number) => {
    if (a.workingSince !== undefined) a.activeMs += Math.max(0, at - a.workingSince);
    a.workingSince = undefined;
  };

  for (const e of evs) {
    const a = segOf(e);
    const model = str(e.payload.model);
    if (model) models.add(model);
    switch (e.type) {
      case "step.claimed":
      case "step.taken_over":
        if (e.user && holders.at(-1)?.user !== e.user) {
          closeHolder(e.at);
          holders.push({ user: e.user, from: e.at });
        } else if (e.user && holders.at(-1)?.to !== undefined) {
          // The same person again after a pause or a reopen.
          holders.push({ user: e.user, from: e.at });
        }
        break;
      case "step.released":
      case "step.paused":
        closeHolder(e.at);
        break;
      case "step.reopened":
        finishedAt = undefined;
        break;
      case "step.done":
      case "step.failed":
        closeHolder(e.at);
        finishedAt = e.at;
        if (a) stopWorking(a, e.at);
        break;
      case "session.turn_started":
        if (!a) break;
        a.seg.turns++;
        if (e.payload.delivered !== true) a.seg.humanPrompts++;
        if (model) {
          a.seg.model = model;
          a.seg.modelSource = "hook";
        }
        if (a.waitingSince !== undefined) {
          a.waitMs += e.at - a.waitingSince;
          a.waitingSince = undefined;
        }
        if (a.workingSince === undefined) a.workingSince = e.at;
        break;
      case "session.turn_stopped":
        if (!a) break;
        stopWorking(a, e.at);
        if (str(e.payload.effort)) a.seg.effort = str(e.payload.effort);
        if (str(e.payload.permission_mode)) a.seg.permissionMode = str(e.payload.permission_mode);
        break;
      case "session.waiting":
        if (!a) break;
        stopWorking(a, e.at);
        a.seg.waits.count++;
        if (a.waitingSince === undefined) a.waitingSince = e.at;
        break;
      case "session.stalled":
      case "session.ended":
        if (a) stopWorking(a, e.at);
        break;
      case "session.nudged":
        if (a) a.seg.nudges++;
        break;
      case "session.provenance":
        if (!a) break;
        if (str(e.payload.claude_code)) a.seg.claudeCode = str(e.payload.claude_code);
        if (str(e.payload.repo_commit)) a.seg.repoCommit = str(e.payload.repo_commit);
        if (str(e.payload.mesh)) a.seg.mesh = str(e.payload.mesh);
        if (e.payload.harness && typeof e.payload.harness === "object") a.seg.harness = e.payload.harness as Harness;
        if (str(e.payload.model) && !a.seg.model) {
          a.seg.model = str(e.payload.model);
          a.seg.modelSource = "hook";
        }
        break;
    }
  }
  // A model the agent reported in mesh_done fills segments the hooks left without one.
  for (const r of step.rounds ?? []) {
    if (!r.model) continue;
    models.add(r.model);
    const a = r.sid ? segs.get(r.sid) : undefined;
    if (a && !a.seg.model) {
      a.seg.model = r.model;
      a.seg.modelSource = "agent";
    }
  }
  const segments = [...segs.values()].map((a) => ({ ...a.seg, waits: { count: a.seg.waits.count, minutes: minutes(a.waitMs) }, activeMinutes: minutes(a.activeMs) }));
  const sum = (f: (s: Segment) => number) => segments.reduce((n, s) => n + f(s), 0);
  const startedAt = holders[0]?.from;
  return {
    holders,
    sessions: segments.map((s) => s.sid),
    models: [...models],
    turns: sum((s) => s.turns),
    humanPrompts: sum((s) => s.humanPrompts),
    nudges: sum((s) => s.nudges),
    waits: { count: sum((s) => s.waits.count), minutes: Math.round(sum((s) => s.waits.minutes) * 10) / 10 },
    fixCycles: step.fixCycles,
    ...(startedAt !== undefined ? { startedAt } : {}),
    ...(finishedAt !== undefined ? { finishedAt } : {}),
    segments,
  };
}

export function goalDir(goal: string): string {
  return `.mesh/goals/${goal}`;
}

export function stepRecordPath(step: Step): string {
  return `${goalDir(step.goal)}/steps/${step.id.slice(step.goal.length + 1)}.md`;
}

/** No YAML anchors: every record is read by plain parsers. */
export const YAML_OPTS = { lineWidth: 0, aliasDuplicateObjects: false } as const;

const header = (record: string) => ({ schema: LEDGER_SCHEMA, record });

function segmentDoc(s: Segment): Record<string, unknown> {
  return {
    sid: s.sid,
    ...(s.user ? { user: s.user } : {}),
    from: iso(s.from),
    ...(s.to !== undefined ? { to: iso(s.to) } : {}),
    ...(s.model ? { model: s.model, model_source: s.modelSource ?? "hook" } : {}),
    ...(s.effort ? { effort: s.effort } : {}),
    ...(s.permissionMode ? { permission_mode: s.permissionMode } : {}),
    ...(s.claudeCode ? { claude_code: s.claudeCode } : {}),
    ...(s.harness ? { harness: s.harness } : {}),
    ...(s.repoCommit ? { repo_commit: s.repoCommit } : {}),
    ...(s.mesh ? { mesh: s.mesh } : {}),
    turns: s.turns,
    human_prompts: s.humanPrompts,
    nudges: s.nudges,
    waits: s.waits,
    active_minutes: s.activeMinutes,
  };
}

/** The step record: YAML front matter plus the summary (and notes) as the body. */
export function stepRecord(
  step: Step,
  facts: StepFacts,
  notes: readonly { user: string; text: string }[] = [],
  plan?: Plan,
  blind?: { steps: string[]; separated: boolean },
): TrailFile {
  const pol = step.policy;
  const rounds = step.rounds ?? [];
  const last = rounds.at(-1);
  const front: Record<string, unknown> = {
    ...header("step"),
    goal: step.goal,
    step: step.id.slice(step.goal.length + 1),
    kind: step.kind,
    repo: step.repo,
    plan: `v${step.planVersion}`,
    ...(plan?.decision === "approved" && plan.decidedBy ? { plan_approved: { by: plan.decidedBy, at: iso(plan.decidedAt) } } : {}),
    ...(pol?.role ? { role: pol.role } : {}),
    ...(pol?.acs?.length ? { acs: pol.acs } : {}),
    ...(pol?.gate ? { gate: pol.gate } : {}),
    ...(pol?.reworks ? { reworks: pol.reworks } : {}),
    ...(pol?.contract ? { contract: pol.contract } : {}),
    ...(blind ? { blind } : {}),
    ...(step.state === "parked" ? { parked: { reason: step.parkedReason ?? "", at: iso(step.parkedAt) } } : {}),
    holders: facts.holders.map((h) => ({ user: h.user, from: iso(h.from), ...(h.to !== undefined ? { to: iso(h.to) } : {}) })),
    sessions: facts.sessions,
    models: facts.models,
    turns: facts.turns,
    human_prompts: facts.humanPrompts,
    nudges: facts.nudges,
    waits: facts.waits,
    active_minutes: Math.round(facts.segments.reduce((n, s) => n + s.activeMinutes, 0) * 10) / 10,
    fix_cycles: facts.fixCycles,
    outcome: step.outcome ?? step.state,
    ...(step.mr ? { mr: step.mr } : {}),
    ...(step.branch ? { branch: step.branch } : {}),
    ...(facts.startedAt !== undefined ? { started: iso(facts.startedAt) } : {}),
    ...(facts.finishedAt !== undefined ? { finished: iso(facts.finishedAt) } : {}),
    ...(last?.artifacts?.length ? { artifacts: last.artifacts } : {}),
    ...(facts.segments.length ? { segments: facts.segments.map(segmentDoc) } : {}),
    ...(rounds.length
      ? {
          rounds: rounds.map((r) => ({
            n: r.n,
            user: r.user,
            ...(r.startedAt !== undefined ? { started: iso(r.startedAt) } : {}),
            finished: iso(r.finishedAt),
            ...(r.startedAt !== undefined ? { minutes: minutes(r.finishedAt - r.startedAt) } : {}),
            outcome: r.outcome,
            ...(r.model ? { model: r.model } : {}),
            ...(r.verdict ? { verdict: r.verdict } : {}),
            ...(r.findings ? { findings: r.findings } : {}),
            ...(r.blockers !== undefined ? { blockers: r.blockers } : {}),
            ...(r.failures?.length ? { failures: r.failures } : {}),
            ...(r.acs ? { acs: r.acs } : {}),
            ...(r.acsAddressed?.length ? { acs_addressed: r.acsAddressed } : {}),
            ...(r.reconcile ? { reconcile: r.reconcile } : {}),
            ...(r.gate ? { gate: r.gate } : {}),
            ...(r.parked ? { parked: r.parked } : {}),
            ...(r.reopen?.length ? { reopen: r.reopen } : {}),
            ...(r.artifacts?.length ? { artifacts: r.artifacts } : {}),
            ...(r.summary ? { summary: r.summary.length > 300 ? `${r.summary.slice(0, 297)}...` : r.summary } : {}),
          })),
        }
      : {}),
  };
  const body = [step.summary ?? "", ...(notes.length ? ["", "Notes:", ...notes.map((n) => `- ${n.user}: ${n.text.replace(/\n+/g, " ")}`)] : [])].join("\n").trim();
  return { path: stepRecordPath(step), text: `---\n${stringify(front, YAML_OPTS).trimEnd()}\n---\n${body}\n` };
}

/** Totals for a finished goal (M4, 4.13): the per-goal retro, generated with no agent. */
export interface GoalRollup {
  steps: number;
  done: number;
  dropped: number;
  rounds: number;
  fixCycles: number;
  planVersions: number;
  designRounds: number;
  people: string[];
  models: string[];
  harnesses: string[];
  humanPrompts: number;
  nudges: number;
  waitMinutes: number;
  activeMinutes: number;
  leadTimeHours?: number | undefined;
  byKind: Record<string, { steps: number; rounds: number; fixCycles: number; minutes: number }>;
  /** M4.5: parks, failure buckets, and per criterion the round it was first met in (by step). */
  parks: number;
  buckets: Record<string, number>;
  acs: Record<string, { met: boolean; firstMet?: { step: string; round: number } | undefined }>;
  gates: { step: string; by: string; rule?: string | undefined }[];
}

export function goalRollup(goal: Goal, steps: readonly Step[], plans: readonly Plan[], facts: ReadonlyMap<string, StepFacts>, doneAt: number | undefined): GoalRollup {
  const live = steps.filter((s) => s.state !== "dropped");
  const people = new Set<string>();
  const models = new Set<string>();
  const harnesses = new Set<string>();
  let humanPrompts = 0;
  let nudges = 0;
  let waitMinutes = 0;
  let activeMinutes = 0;
  const byKind: GoalRollup["byKind"] = {};
  for (const s of live) {
    const f = facts.get(s.id);
    for (const h of f?.holders ?? []) people.add(h.user);
    for (const m of f?.models ?? []) models.add(m);
    for (const seg of f?.segments ?? []) if (seg.harness) harnesses.add(seg.harness.hash);
    humanPrompts += f?.humanPrompts ?? 0;
    nudges += f?.nudges ?? 0;
    waitMinutes += f?.waits.minutes ?? 0;
    activeMinutes += f?.segments.reduce((n, x) => n + x.activeMinutes, 0) ?? 0;
    const k = (byKind[s.kind] ??= { steps: 0, rounds: 0, fixCycles: 0, minutes: 0 });
    k.steps++;
    k.rounds += s.rounds?.length ?? 0;
    k.fixCycles += s.fixCycles;
    if (f?.startedAt !== undefined && f.finishedAt !== undefined) k.minutes = Math.round((k.minutes + (f.finishedAt - f.startedAt) / 60_000) * 10) / 10;
  }
  return {
    steps: live.length,
    done: live.filter((s) => s.state === "done").length,
    dropped: steps.length - live.length,
    rounds: live.reduce((n, s) => n + (s.rounds?.length ?? 0), 0),
    fixCycles: live.reduce((n, s) => n + s.fixCycles, 0),
    planVersions: plans.length,
    designRounds: plans.filter((p) => p.decision === "revised").length,
    people: [...people].sort(),
    models: [...models].sort(),
    harnesses: [...harnesses].sort(),
    humanPrompts,
    nudges,
    waitMinutes: Math.round(waitMinutes * 10) / 10,
    activeMinutes: Math.round(activeMinutes * 10) / 10,
    ...(doneAt !== undefined ? { leadTimeHours: Math.round((doneAt - goal.createdAt) / 360_000) / 10 } : {}),
    byKind,
    parks: live.reduce((n, s) => n + (s.rounds ?? []).filter((r) => r.parked).length, 0),
    buckets: live.flatMap((s) => (s.rounds ?? []).flatMap((r) => (r.failures ?? []).map((f) => f.bucket))).reduce<Record<string, number>>((m, b) => ({ ...m, [b]: (m[b] ?? 0) + 1 }), {}),
    acs: acRollup(live, plans),
    gates: live.flatMap((s) => (s.rounds ?? []).filter((r) => r.gate && r.outcome === "done").map((r) => ({ step: s.id.slice(s.goal.length + 1), by: r.gate?.by ?? r.user, ...(r.gate?.rule ? { rule: r.gate.rule } : {}) }))),
  };
}

function acRollup(steps: readonly Step[], plans: readonly Plan[]): GoalRollup["acs"] {
  const plan = plans.filter((p) => p.decision === "approved").at(-1);
  const out: GoalRollup["acs"] = {};
  for (const a of plan?.acs ?? []) out[a.id] = { met: false };
  const judged = steps.flatMap((s) => (s.rounds ?? []).filter((r) => r.acs).map((r) => ({ s, r }))).sort((x, y) => x.r.finishedAt - y.r.finishedAt);
  for (const { s, r } of judged) {
    for (const [ac, state] of Object.entries(r.acs ?? {})) {
      const cur = (out[ac] ??= { met: false });
      if (state === "met" && !cur.firstMet) cur.firstMet = { step: s.id.slice(s.goal.length + 1), round: r.n };
      cur.met = state === "met";
    }
  }
  return out;
}

export function goalFile(goal: Goal, rollup?: GoalRollup, doneAt?: number): TrailFile {
  const doc = {
    ...header("goal"),
    id: goal.id,
    title: goal.title,
    owner: goal.ownerId,
    state: goal.state,
    ...(goal.primaryRepo ? { primary_repo: goal.primaryRepo } : {}),
    ...(goal.repos?.length ? { repos: goal.repos } : {}),
    ...(goal.issueUrl ? { issue: goal.issueUrl } : {}),
    ...(goal.refs && Object.keys(goal.refs).length ? { refs: goal.refs } : {}),
    ...(goal.reworks?.length ? { reworks: goal.reworks } : {}),
    ...(goal.preset ? { preset: goal.preset.name } : {}),
    created: iso(goal.createdAt),
    ...(doneAt !== undefined ? { done: iso(doneAt) } : {}),
    ...(rollup
      ? {
          rollup: {
            steps: rollup.steps,
            done: rollup.done,
            dropped: rollup.dropped,
            rounds: rollup.rounds,
            fix_cycles: rollup.fixCycles,
            plan_versions: rollup.planVersions,
            design_rounds: rollup.designRounds,
            people: rollup.people,
            models: rollup.models,
            harnesses: rollup.harnesses,
            human_prompts: rollup.humanPrompts,
            nudges: rollup.nudges,
            wait_minutes: rollup.waitMinutes,
            active_minutes: rollup.activeMinutes,
            ...(rollup.leadTimeHours !== undefined ? { lead_time_hours: rollup.leadTimeHours } : {}),
            by_kind: Object.fromEntries(Object.entries(rollup.byKind).map(([k, v]) => [k, { steps: v.steps, rounds: v.rounds, fix_cycles: v.fixCycles, minutes: v.minutes }])),
            ...(rollup.parks ? { parks: rollup.parks } : {}),
            ...(Object.keys(rollup.buckets).length ? { buckets: rollup.buckets } : {}),
            ...(Object.keys(rollup.acs).length
              ? { acs: Object.fromEntries(Object.entries(rollup.acs).map(([k, v]) => [k, { met: v.met, ...(v.firstMet ? { first_met: v.firstMet } : {}) }])) }
              : {}),
            ...(rollup.gates.length ? { gates: rollup.gates } : {}),
          },
        }
      : {}),
  };
  return { path: `${goalDir(goal.id)}/goal.yaml`, text: stringify(doc, YAML_OPTS) };
}

/** plan.vN.yaml: the steps plus the decision (approval record) once decided. */
export function planFile(plan: Plan): TrailFile {
  const doc = {
    ...header("plan"),
    goal: plan.goal,
    version: plan.version,
    ...(plan.designRef ? { design: plan.designRef } : {}),
    proposed: { by: plan.proposedBy, at: iso(plan.proposedAt) },
    decision: plan.decision,
    ...(plan.decidedBy || plan.decidedAt !== undefined
      ? { decided: { ...(plan.decidedBy ? { by: plan.decidedBy } : {}), at: iso(plan.decidedAt), ...(plan.comment ? { comment: plan.comment } : {}) } }
      : {}),
    ...(plan.acs?.length ? { acs: plan.acs } : {}),
    steps: plan.steps.map((s) => {
      const { id, repo, kind, title, deps, brief, ...policy } = s;
      const extra = Object.fromEntries(Object.entries(policy).filter(([, v]) => v !== undefined));
      return { id, repo, kind, title, ...(deps.length ? { deps } : {}), ...extra, brief };
    }),
  };
  return { path: `${goalDir(plan.goal)}/plan.v${plan.version}.yaml`, text: stringify(doc, YAML_OPTS) };
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
