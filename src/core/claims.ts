// Claims on steps (plan §3.5). Pure: each function returns the new step or an error.

import type { Step } from "../protocol/index.ts";

export interface Actor {
  userId: string;
  sid?: string | undefined;
  machine?: string | undefined;
}

export type Outcome = { ok: true; step: Step } | { ok: false; error: string; status: 404 | 409 | 403 };

export interface ClaimRules {
  takeoverAfterMs: number;
}

export const DEFAULT_CLAIM_RULES: ClaimRules = { takeoverAfterMs: 4 * 60 * 60_000 };

function hold(s: Step, a: Actor, now: number): Step {
  const next: Step = { ...s, state: "claimed", holderUser: a.userId, claimedAt: s.holderUser === a.userId ? (s.claimedAt ?? now) : now, updatedAt: now };
  delete next.pausedAt;
  if (a.sid) next.holderSid = a.sid;
  else delete next.holderSid;
  if (a.machine) next.holderMachine = a.machine;
  return next;
}

/** Ready steps can be claimed by anyone; claimed/paused steps only re-bound by their holder. */
export function claim(s: Step, a: Actor, now: number): Outcome {
  if (s.state === "ready") return { ok: true, step: hold(s, a, now) };
  if ((s.state === "claimed" || s.state === "paused") && s.holderUser === a.userId) return { ok: true, step: hold(s, a, now) };
  if (s.state === "claimed" || s.state === "paused") return { ok: false, status: 409, error: `${s.id} is held by ${s.holderUser}` };
  return { ok: false, status: 409, error: `${s.id} is ${s.state}, not ready` };
}

export function release(s: Step, a: Actor, isAdmin: boolean, now: number): Outcome {
  if (s.state !== "claimed" && s.state !== "paused") return { ok: false, status: 409, error: `${s.id} is not held` };
  if (s.holderUser !== a.userId && !isAdmin) return { ok: false, status: 403, error: `${s.id} is held by ${s.holderUser}` };
  const next: Step = { ...s, state: "ready", updatedAt: now };
  delete next.holderUser;
  delete next.holderSid;
  delete next.holderMachine;
  delete next.claimedAt;
  delete next.pausedAt;
  return { ok: true, step: next };
}

export function pause(s: Step, now: number): Step {
  if (s.state !== "claimed") return s;
  return { ...s, state: "paused", pausedAt: now, updatedAt: now };
}

/** Since when the step has been paused or stalled, if it is. */
export function idleSince(s: Step, stalledSince: number | undefined): number | undefined {
  if (s.state === "paused") return s.pausedAt ?? s.updatedAt;
  if (s.state === "claimed" && stalledSince !== undefined) return stalledSince;
  return undefined;
}

/** Take over a paused or stalled step (plan §3.5). */
export function takeOver(
  s: Step,
  a: Actor,
  opts: { privileged: boolean; stalledSince?: number | undefined; now: number; rules?: ClaimRules },
): Outcome {
  const rules = opts.rules ?? DEFAULT_CLAIM_RULES;
  if (s.state !== "claimed" && s.state !== "paused") return { ok: false, status: 409, error: `${s.id} is ${s.state}; nothing to take over` };
  if (s.holderUser === a.userId) return { ok: true, step: hold(s, a, opts.now) };
  const since = idleSince(s, opts.stalledSince);
  if (!opts.privileged) {
    if (since === undefined) return { ok: false, status: 409, error: `${s.id} is actively held by ${s.holderUser}` };
    if (opts.now - since < rules.takeoverAfterMs) {
      const mins = Math.ceil((rules.takeoverAfterMs - (opts.now - since)) / 60_000);
      return { ok: false, status: 409, error: `${s.id} can be taken over in ${mins} min (or by the goal owner now)` };
    }
  }
  return { ok: true, step: hold(s, a, opts.now) };
}

export interface DoneInput {
  summary: string;
  outcome: "done" | "fail";
  branch?: string | undefined;
  mr?: string | undefined;
}

/**
 * Finish a held step. `done` completes it. `fail` with steps to reopen sends this step back to
 * waiting (blocked, unheld) while the reopened steps are fixed; `fail` alone marks it failed.
 */
export function finish(s: Step, a: Actor, input: DoneInput, reopening: boolean, isAdmin: boolean, now: number): Outcome {
  if (s.state !== "claimed" && s.state !== "paused") return { ok: false, status: 409, error: `${s.id} is ${s.state}; claim it first` };
  if (s.holderUser !== a.userId && !isAdmin) return { ok: false, status: 403, error: `${s.id} is held by ${s.holderUser}` };
  const next: Step = { ...s, summary: input.summary, outcome: input.outcome, updatedAt: now };
  if (input.branch) next.branch = input.branch;
  if (input.mr) next.mr = input.mr;
  delete next.pausedAt;
  if (input.outcome === "done") next.state = "done";
  else if (reopening) {
    next.state = "blocked";
    delete next.holderUser;
    delete next.holderSid;
    delete next.holderMachine;
    delete next.claimedAt;
  } else next.state = "failed";
  return { ok: true, step: next };
}

/**
 * Next step for a session after it finished one (autopilot `chain`, plan §3.6): the first ready
 * direct dependent in the same repo, else any ready step of the goal in the same repo.
 */
export function pickNext(finished: Step, steps: readonly Step[], sameRepo: (repo: string) => boolean): Step | undefined {
  const ready = steps.filter((s) => s.state === "ready" && s.goal === finished.goal && sameRepo(s.repo));
  return ready.find((s) => s.deps.includes(finished.id)) ?? ready[0];
}
