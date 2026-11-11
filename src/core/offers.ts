// Offers (MM-3): accept policy, session pick, and the texts shared by the hub, the daemon, the CLI,
// the TUI and the web. Pure and browser-safe (web/src imports this file directly).

import type { AssignResult, GoalAssignResult, OfferLine, OfferView, Session, Step } from "../protocol/index.ts";
import { age } from "./fleet.ts";
import { repoMatches } from "./repo-id.ts";

/** The machine name: its nickname, else its hostname. */
export function machineName(m: { hostname: string; nickname?: string | undefined }): string {
  return m.nickname ?? m.hostname;
}

/** The session name: its name, else its repo name, else the first 8 characters of its sid. */
export function sessionName(s: { sid: string; name?: string | undefined; repo?: { name: string } | undefined }): string {
  return s.name ?? s.repo?.name ?? s.sid.slice(0, 8);
}

/**
 * Whether an accept policy takes an offer automatically. `undefined` (never reported) and `["off"]`
 * never do. `self`: the offerer owns the target; `user:<id>`: the offerer is that user;
 * `machine:<x>`: the offer was made from machine id `x`, or from a machine of the target's owner
 * with nickname `x`.
 */
export function acceptMatches(
  policy: readonly string[] | undefined,
  offer: { byUser: string; byMachine?: { id: string; userId: string; nickname?: string | undefined } | undefined },
  target: { userId: string },
): boolean {
  if (!policy || policy.includes("off")) return false;
  return policy.some((r) => {
    if (r === "self") return offer.byUser === target.userId;
    if (r.startsWith("user:")) return offer.byUser === r.slice("user:".length);
    if (r.startsWith("machine:")) {
      const x = r.slice("machine:".length);
      const m = offer.byMachine;
      return !!m && (m.id === x || (m.userId === target.userId && m.nickname === x));
    }
    return false;
  });
}

/**
 * The session an accepted offer goes to. With `want.sid`: that session when it is not ended, holds
 * no step and is not launching, else none (no other session is chosen). Without: the idle,
 * step-less, non-launching session in the repo with the most labels among `want.topics`; ties go to
 * the newer `lastEventAt`, then the smaller sid.
 */
export function pickSession(sessions: readonly Session[], want: { repo: string; topics: readonly string[]; sid?: string | undefined }): Session | undefined {
  if (want.sid !== undefined) {
    const s = sessions.find((x) => x.sid === want.sid);
    return s && s.state !== "ended" && !s.step && !s.launching ? s : undefined;
  }
  const score = (s: Session) => (s.labels ?? []).filter((l) => want.topics.includes(l)).length;
  const candidates = sessions.filter((s) => s.state === "idle" && !s.step && !s.launching && s.repo !== undefined && repoMatches(s.repo, want.repo));
  candidates.sort((a, b) => score(b) - score(a) || b.lastEventAt - a.lastEventAt || (a.sid < b.sid ? -1 : a.sid > b.sid ? 1 : 0));
  return candidates[0];
}

/** One line about a step's last offer (goal page, `mesh show`). */
export function offerText(l: OfferLine): string {
  switch (l.state) {
    case "offered":
      return `offered to ${l.to} by @${l.by}`;
    case "accepted":
      return `offered to ${l.to} → accepted by ${l.accepted ?? l.to}`;
    case "declined":
      return `offered to ${l.to} → declined${l.note ? `: ${l.note}` : ""}`;
    case "expired":
      return `offered to ${l.to} → expired`;
    case "withdrawn":
      return `offered to ${l.to} → withdrawn`;
  }
}

/** One open offer as `mesh offers`, MCP `mesh_offers` and the TUI list it. */
export function offerLine(o: OfferView, now: number): string {
  return (
    `${o.step} "${o.title}" · ${o.repo || "-"} · from @${o.by} · to ${o.to} · ${o.auto ? "auto" : "manual"} · expires in ${age(o.expiresAt - now)}` +
    (o.note ? ` · ${o.note}` : "")
  );
}

/**
 * Offers on steps that leave `ready` other than by a claim (a replan drops or blocks them, a rule
 * parks them) end as `withdrawn`. `prev`: the steps before the change; `next`: the steps to save.
 */
export function endOffersLeavingReady(prev: readonly Step[], next: readonly Step[], now: number): { steps: Step[]; ended: Step[] } {
  const before = new Map(prev.map((s) => [s.id, s]));
  const ended: Step[] = [];
  const steps = next.map((n) => {
    const p = before.get(n.id);
    if (!p || p.state !== "ready" || p.offer?.state !== "offered" || n.state === "ready") return n;
    const offer = n.offer ?? p.offer;
    if (offer.state !== "offered") return n;
    const e: Step = { ...n, offer: { ...offer, state: "withdrawn", decidedAt: now } };
    ended.push(e);
    return e;
  });
  return { steps, ended };
}

/** The stdout lines of `mesh assign` (and the text of MCP `mesh_assign`). `to`: the target as typed. */
export function assignText(kind: "step" | "goal", target: string, to: string, r: AssignResult | GoalAssignResult, stick: boolean): string[] {
  const suffix = r.auto ? "(auto-accept)." : "(waits for them to accept).";
  if (kind === "step" && "step" in r) {
    const lines = [`Offered ${r.step.id} to ${to} ${suffix}`];
    if (stick) lines.push(`Later steps of ${r.step.goal} go to ${to} too (until: mesh withdraw ${r.step.goal}).`);
    return lines;
  }
  const g = "goal" in r ? r.goal.id : target;
  const steps = "steps" in r ? r.steps : [];
  const lines = [steps.length ? `Offered ${steps.map((s) => s.id).join(", ")} to ${to} ${suffix}` : `No step of ${g} is ready now.`];
  if (stick) lines.push(`Later steps of ${g} go to ${to} too (until: mesh withdraw ${g}).`);
  return lines;
}
