// RL-15 test helpers: pulses with a relay preset (headless audit → headless validate → debrief), the
// stages of their goals, slots and the debrief SLA. Built on the RL-6 `Ck` and the RL-3 `Pk`.
import { expect } from "vitest";
import { Ck, rec } from "./calib-kit.ts";
import { snap, T0, type Pk } from "./pulse-kit.ts";
import type { Json, Person } from "./world.ts";

export const HOUR = 3_600_000;
export const DAY = 86_400_000;
export const AUD = { key: "alpha/auditor", hash: "a".repeat(64) };
export const VAL = { key: "alpha/validator", hash: "b".repeat(64) };

/** audit (headless) → validate (headless, confirms or dismisses) → debrief, with optional extra debrief lines. */
export function relayText(o: { debrief?: string; top?: string; when?: boolean } = {}): string {
  return `description: Audit, validate, debrief
${o.top ?? ""}steps:
  - id: audit
    kind: review
    repo: "{repo}"
    mode: headless
    agent: auditor
    output: review-record
    title: Audit
    brief: Audit.
  - id: validate
    kind: review
    repo: "{repo}"
    deps: [audit]
    mode: headless
    agent: validator
    output: review-record
    consumes: [open]
    may_set: [confirmed, dismissed]
    title: Validate
    brief: Validate.
  - id: debrief
    kind: review
    repo: "{repo}"
    deps: [validate]
    mode: debrief
    output: review-record
    consumes: [open, confirmed]
    may_set: [accepted, dismissed, confirmed]
${o.when ? "    when: { open: true }\n" : ""}${o.debrief ?? ""}    title: Debrief
    brief: Debrief.
`;
}

/** A pulse body (every 1d from T0, repo alpha). */
export const relayPulse = (o: Record<string, unknown> = {}, text = relayText(), name = "relay") => ({
  preset: snap(name, text),
  params: { repo: "alpha" },
  when: { every: "1d", at: T0 },
  ...o,
});

export async function start(clock = T0 - HOUR): Promise<{ k: Ck; pk: Pk }> {
  const k = await Ck.start({ clock });
  return { k, pk: k.pulses() };
}

/** Claim a step and report its run started (the slot is started at the next tick). */
export async function startRun(k: Ck, id: string, who: Person = k.c.ann): Promise<void> {
  await k.k.claim(who, id);
  const s = await k.r.call(who, "POST", `/v1/steps/${id}/run`, { state: "started", runId: `run-${id}` });
  expect(s.status, JSON.stringify(s.json)).toBe(200);
}

/** Submit a record on a held (or claimable) step and close it done; returns the ReviewResult. */
export async function record(k: Ck, id: string, o: { items?: unknown[]; dispositions?: unknown[]; agent?: { key: string; hash?: string }; coverage?: "complete" | "partial"; claimed?: boolean }, who: Person = k.c.ann): Promise<Json> {
  if (!o.claimed) await k.k.claim(who, id);
  const r = await k.k.review(who, id, rec({ items: o.items ?? [], dispositions: o.dispositions ?? [], coverage: o.coverage ?? "complete", ...(o.agent ? { agent: o.agent } : {}) } as never));
  expect(r.status, `review ${id}: ${JSON.stringify(r.json)}`).toBe(201);
  const d = await k.k.close(who, id, { outcome: "done", summary: "ok" });
  expect(d.status, `close ${id}: ${JSON.stringify(d.json)}`).toBe(200);
  return r.json;
}

/** Run a goal's audit (raising `items`) and validate (`dispositions`); returns the lineage. */
export async function auditAndValidate(k: Ck, G: string, items: unknown[], dispositions: unknown[], coverage: "complete" | "partial" = "complete"): Promise<string> {
  const r = await record(k, `${G}.audit`, { items, agent: AUD, coverage });
  await record(k, `${G}.validate`, { dispositions, agent: VAL });
  return r.review.lineage as string;
}

export async function events(k: Ck, type: string): Promise<Json[]> {
  return (await k.r.allEvents()).filter((e) => e.type === type);
}

/** The slot of a pulse by id (through `GET /v1/pulses/:id`). */
export async function slot(pk: Pk, id: string, s: string): Promise<Json> {
  return pk.slotOf(id, s);
}

export async function debriefView(k: Ck, id: string, who: Person = k.c.ann): Promise<Json> {
  const res = await k.r.call(who, "GET", `/v1/steps/${id}/debrief`);
  expect(res.status, JSON.stringify(res.json)).toBe(200);
  return res.json;
}

export async function attention(k: Ck, who: Person | string): Promise<Json[]> {
  const res = await k.r.call(who as never, "GET", "/v1/attention");
  expect(res.status, JSON.stringify(res.json)).toBe(200);
  return res.json.attention as Json[];
}

export const iso = (ms: number) => new Date(ms).toISOString();
