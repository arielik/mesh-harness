// Optional step rules (M4.5): reconcile, review verdicts, failure routing, round caps, churn and
// stall parking, blind steps. Pure: the hub applies the decisions. A step without a policy behaves
// as before (outcome done/fail + explicit reopen).

import type { PlanAc, PlanStep, Round, Step, StepContext, StepPolicy } from "../protocol/index.ts";

export const local = (s: Step) => s.id.slice(s.goal.length + 1);
const full = (goal: string, id: string) => (id.includes(".") ? id : `${goal}.${id}`);

/** The policy fields of a plan step, without the undefined ones. */
export function policyOf(p: PlanStep): StepPolicy | undefined {
  const keys = ["role", "acs", "blind", "reads", "forbid", "contract", "max_rounds", "park_on", "route", "target", "must_cover", "worktree", "reworks", "gate"] as const;
  const out: Record<string, unknown> = {};
  for (const k of keys) if (p[k] !== undefined) out[k] = p[k];
  return Object.keys(out).length ? (out as StepPolicy) : undefined;
}

/** Plan checks for the optional rules; phrased so an agent can fix them. */
export function validatePolicies(steps: readonly PlanStep[], acs: readonly PlanAc[] | undefined): string[] {
  const errors: string[] = [];
  const ids = new Set(steps.map((s) => s.id));
  const acIds = new Set((acs ?? []).map((a) => a.id));
  const seenAc = new Set<string>();
  for (const a of acs ?? []) {
    if (seenAc.has(a.id)) errors.push(`acceptance criterion ${a.id} is listed twice`);
    seenAc.add(a.id);
  }
  for (const s of steps) {
    const refs: [string, string[]][] = [
      ["blind", s.blind ?? []],
      ["reads", s.reads ?? []],
      ["target", s.target ? [s.target] : []],
      ["route", Object.values(s.route ?? {}).filter((v): v is string => v !== "park")],
    ];
    for (const [field, list] of refs) for (const r of list) if (!ids.has(r)) errors.push(`step "${s.id}": ${field} names "${r}", which is not a step of this plan`);
    if (s.blind?.includes(s.id)) errors.push(`step "${s.id}": a step can't be blind to itself`);
    if (s.target && !s.deps.includes(s.target)) errors.push(`step "${s.id}": target "${s.target}" must also be in deps (the review waits for its fix)`);
    for (const a of s.acs ?? []) if (acs && !acIds.has(a)) errors.push(`step "${s.id}": acceptance criterion ${a} is not in the plan's acs`);
    if (s.must_cover && !acs?.length) errors.push(`step "${s.id}": must_cover needs the plan's acs`);
    if (Array.isArray(s.must_cover)) for (const a of s.must_cover) if (!acIds.has(a)) errors.push(`step "${s.id}": must_cover names ${a}, which is not in the plan's acs`);
    if (s.kind === "gate" && (s.blind || s.route || s.target)) errors.push(`step "${s.id}": a gate step is decided by a person; blind, route and target don't apply`);
  }
  return errors;
}

export type DoneDecision =
  | { action: "done"; reason?: undefined }
  /** Not accepted (reconcile): the holder keeps the step and fixes it. */
  | { action: "reject"; reason: string; missing: string[] }
  | { action: "reopen"; reopen: string[]; reason: string }
  | { action: "park"; reason: string }
  /** Failed with nothing to reopen (the pre-M4.5 behaviour). */
  | { action: "fail" };

const FAILING = new Set(["changes_requested", "blocked", "fail"]);

/** Did this round fail? The verdict, when given, decides; else the outcome. */
export function failing(r: Pick<Round, "verdict" | "outcome">): boolean {
  return r.verdict ? FAILING.has(r.verdict) : r.outcome === "fail";
}

const met = (r: Round) => Object.values(r.acs ?? {}).filter((v) => v === "met").length;

/** Consecutive latest failing rounds in which no new criterion was met (stall). */
export function staleRounds(rounds: readonly Round[]): number {
  let best = -1;
  let stale = 0;
  for (const r of rounds) {
    const m = met(r);
    if (m > best) {
      best = m;
      stale = 0;
    } else stale++;
  }
  return stale;
}

/** Rounds in a row without a new criterion met before a step parks on stall. */
export const STALL_AFTER = 2;

/**
 * What finishing a step means under its policy. `round` is the round being added (prior rounds are
 * in step.rounds); `explicit` are the steps the agent asked to reopen.
 */
export function judgeDone(step: Step, round: Round, explicit: readonly string[], planAcs: readonly PlanAc[] | undefined): DoneDecision {
  const p = step.policy ?? {};
  // Caps and stalls count from the last time a person resumed the step (a parked round).
  const prior = step.rounds ?? [];
  const lastPark = prior.map((r) => !!r.parked).lastIndexOf(true);
  const rounds = [...prior.slice(lastPark + 1), round];
  const fails = failing(round);

  if (!fails && p.must_cover) {
    const expected = p.must_cover === "all" ? (planAcs ?? []).map((a) => a.id) : p.must_cover;
    const covered = new Set([...(round.acsAddressed ?? []), ...Object.keys(round.acs ?? {})]);
    const missing = expected.filter((a) => !covered.has(a));
    if (missing.length) {
      const tried = (step.rounds ?? []).filter((r) => r.reconcile?.missing.length).length;
      if (tried >= 1) return { action: "park", reason: `reconcile: ${missing.join(", ")} still not covered after a retry` };
      return { action: "reject", reason: `reconcile: the plan's criteria ${missing.join(", ")} are not covered; add them (acs_addressed) and call mesh_done again`, missing };
    }
  }
  if (!fails) return { action: "done" };

  const failingRounds = rounds.filter(failing).length;
  if (p.park_on?.includes("churn") && round.findings) {
    const total = round.findings.new + round.findings.repeat + round.findings.regression;
    if (total > 0 && round.findings.regression * 2 > total) return { action: "park", reason: `churn: ${round.findings.regression} of ${total} findings regress the writer's own repairs` };
  }
  if (p.max_rounds && failingRounds >= p.max_rounds) return { action: "park", reason: `not passed after ${failingRounds} round(s) (max_rounds ${p.max_rounds})` };
  if (p.park_on?.includes("stall") && staleRounds(rounds.filter(failing)) >= STALL_AFTER) return { action: "park", reason: `stall: no new acceptance criterion met in ${STALL_AFTER} rounds` };

  const reopen = new Set(explicit.map((r) => full(step.goal, r)));
  const unrouted: string[] = [];
  for (const f of round.failures ?? []) {
    const to = p.route?.[f.bucket];
    if (to === "park") return { action: "park", reason: `${f.bucket}${f.ac ? ` on ${f.ac}` : ""}: routed to a person` };
    if (to) reopen.add(full(step.goal, to));
    else unrouted.push(f.bucket);
  }
  if (p.target && round.verdict && (round.verdict === "changes_requested" || round.verdict === "blocked")) reopen.add(full(step.goal, p.target));
  if (reopen.size) {
    const why = (round.failures ?? []).length ? (round.failures ?? []).map((f) => `${f.bucket}${f.ac ? ` ${f.ac}` : ""}`).join(", ") : (round.verdict ?? "failed");
    return { action: "reopen", reopen: [...reopen], reason: why };
  }
  return { action: "fail" };
}

/** What a reopened step's holder is told: criterion, bucket and assertion only, never the tester's prose (leak 5). */
export function reopenText(by: Step, round: Round, fallback: string): string {
  if (round.failures?.length) return round.failures.map((f) => `${f.bucket}${f.ac ? ` ${f.ac}` : ""}${f.assertion ? `: ${f.assertion}` : ""}`).join("; ");
  if (by.policy?.blind?.length || by.policy?.reads) return `${by.id} found problems (${round.verdict ?? "fail"}); details are kept from you on purpose (blind steps)`;
  return fallback;
}

// ---------- blind steps ----------

/** Steps on the other side of a blind relation with `s` (either side may declare it). */
export function blindPartners(s: Step, steps: readonly Step[]): Step[] {
  const mine = new Set((s.policy?.blind ?? []).map((b) => full(s.goal, b)));
  return steps.filter((o) => o.goal === s.goal && o.id !== s.id && (mine.has(o.id) || (o.policy?.blind ?? []).some((b) => full(o.goal, b) === s.id)));
}

/** Everyone (people and sessions) who held a step, from its rounds and current holder. */
export function holdersOf(s: Step): { users: Set<string>; sids: Set<string> } {
  const users = new Set<string>();
  const sids = new Set<string>();
  for (const r of s.rounds ?? []) {
    users.add(r.user);
    if (r.sid) sids.add(r.sid);
  }
  if (s.holderUser) users.add(s.holderUser);
  if (s.holderSid) sids.add(s.holderSid);
  return { users, sids };
}

/**
 * Why `who` may not hold `s` (blind guard), or undefined. Scope "person": nobody who held a partner
 * step; "session": only the same session is refused (Solo, one person playing both sides).
 */
export function blindConflict(s: Step, steps: readonly Step[], who: { userId: string; sid?: string | undefined }, scope: "person" | "session"): string | undefined {
  for (const o of blindPartners(s, steps)) {
    const h = holdersOf(o);
    if (who.sid && h.sids.has(who.sid)) return `${s.id} is blind to ${o.id}, which this session worked on; use another session`;
    if (scope === "person" && h.users.has(who.userId)) return `${s.id} is blind to ${o.id}, which ${who.userId} worked on; someone else must take it`;
  }
  return undefined;
}

/** Were the two sides really kept apart (no person in common)? */
export function blindSeparated(s: Step, steps: readonly Step[]): { steps: string[]; separated: boolean } | undefined {
  const partners = blindPartners(s, steps);
  if (!partners.length) return undefined;
  const mine = holdersOf(s).users;
  const theirs = new Set(partners.flatMap((o) => [...holdersOf(o).users]));
  return { steps: partners.map(local), separated: ![...mine].some((u) => theirs.has(u)) };
}

/** The context an agent gets: blinded and unread dependencies show only their id, title and state. */
export function agentContext(ctx: StepContext, steps: readonly Step[]): StepContext {
  const p = ctx.step.policy;
  if (!p?.blind?.length && !p?.reads) return ctx;
  const hidden = new Set(blindPartners(ctx.step, steps).map((o) => o.id));
  const reads = p.reads ? new Set(p.reads.map((r) => full(ctx.step.goal, r))) : undefined;
  return {
    ...ctx,
    deps: ctx.deps.map((d) => (hidden.has(d.id) || (reads && !reads.has(d.id)) ? { id: d.id, title: d.title, state: d.state, summary: "(hidden: this step is blind to it)" } : d)),
  };
}
