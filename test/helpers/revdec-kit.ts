// RL-29 test kit: a review decided from a client (`POST /v1/steps/:id/decisions`) and the supersede of
// an older open review by a newer run of the same pulse and lineage. Built on the RL-6 `Ck` and the
// RL-3 `Pk`. Written from docs/specs/RL-29.md (§Acceptance criteria, World).
//
// World: pulse `p-1` of ann, preset `routine-audit` (audit headless → validate headless → debrief
// `consumes: [confirmed]`, `may_set: [accepted, dismissed, deferred]` → file `consumes: [accepted]`,
// `when: {open: true}`, `sink: {topic: audit}`, `inputs: [dispositions]`), repo alpha, agent `{agent}` (default auditor). bob a
// member, service `svc` (goals:decide) and `svc-read` (goals:read only). Goals are fired by hand, one
// minute apart, so a later fire is a newer run.

import { expect } from "vitest";
import { Ck, fpOf, item } from "./calib-kit.ts";
import { topic } from "./health-kit.ts";
import { AUD, VAL, record } from "./overlap-kit.ts";
import { snap, T0, type Pk } from "./pulse-kit.ts";
import type { Json, Person } from "./world.ts";

export const H = "x-mesh-on-behalf-of";
export const MIN = 60_000;
export const DAY = 86_400_000;
export const REPO = "alpha";
export const TITLE = "Clean audits: audit on alpha";

export const A = fpOf("A");
export const B = fpOf("B");
export const C = fpOf("C");
export const D = fpOf("D");
export const EH1 = "1".repeat(64);
export const EH2 = "2".repeat(64);
export const EV_A = [{ path: "src/a.ts", lines: [3, 4] }];
export const EV_C = [{ path: "src/c.ts", lines: [7, 9] }];
export const IA = item("A", { severity: "S1", title: "T-A", evidence: EV_A });
export const IB = item("B", { severity: "S2", title: "T-B", eh: EH1 });
export const IC = item("C", { severity: "S3", title: "T-C", evidence: EV_C });
export const TITLES: Record<string, string> = { [A]: "T-A", [B]: "T-B", [C]: "T-C" };

/** The hub's UTC date `days` after the World clock. */
export const dayOf = (ms: number, days = 0) => new Date(ms + days * DAY).toISOString().slice(0, 10);

/** The routine-audit preset; `maySet` replaces the debrief's `may_set`. */
export function routineText(o: { maySet?: string[]; gate?: boolean } = {}): string {
  return `description: Routine audit
steps:
  - id: audit
    kind: review
    repo: "{repo}"
    mode: headless
    agent: "{agent}"
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
    consumes: [confirmed]
    may_set: [${(o.maySet ?? ["accepted", "dismissed", "deferred"]).join(", ")}]
    title: Debrief
    brief: Debrief.
  - id: file
    kind: review
    repo: "{repo}"
    deps: [debrief]
    output: review-record
    when: { open: true }
    consumes: [accepted]
    may_set: [accepted]
    sink: { topic: audit }
    inputs: [dispositions]
    title: File
    brief: File.
${o.gate ? '  - { id: g, kind: gate, gate: R1, repo: "{repo}", deps: [debrief], title: G, brief: g }\n' : ""}`;
}

export const acc = (f: string, reason = "fix it", extra: Record<string, unknown> = {}) => ({ fingerprint: f, disposition: "accepted", reason, ...extra });
export const dis = (f: string, reason = "false positive", extra: Record<string, unknown> = {}) => ({ fingerprint: f, disposition: "dismissed", reason, ...extra });
export const def = (f: string, until: string | undefined, reason = "later") => ({ fingerprint: f, disposition: "deferred", reason, ...(until !== undefined ? { until } : {}) });

export interface Run {
  G: string;
  D: string;
  F: string;
  V: string;
  AU: string;
}

export class Rv {
  readonly k: Ck;
  readonly pk: Pk;
  svc = "";
  svcRead = "";

  constructor(k: Ck) {
    this.k = k;
    this.pk = k.pulses();
  }

  /** The World at T0 with topic `audit` and the two service tokens. */
  static async start(o: { threshold?: number } = {}): Promise<Rv> {
    const k = await Ck.start({ clock: T0, ...(o.threshold !== undefined ? { threshold: o.threshold } : {}) });
    const v = new Rv(k);
    await topic(k, "audit");
    v.svc = await k.w.hub.svc.serviceToken("svc", ["goals:read", "goals:decide"]);
    v.svcRead = await k.w.hub.svc.serviceToken("svc-read", ["goals:read"]);
    return v;
  }

  async stop(): Promise<void> {
    await this.k.stop();
  }
  get w() {
    return this.k.w;
  }
  get ann(): Person {
    return this.k.c.ann;
  }
  get bob(): Person {
    return this.k.c.bob;
  }
  tick(ms = MIN): number {
    this.w.clock += ms;
    return this.w.clock;
  }

  /** A pulse of `who` (overlap `skip` unless given); returns its id. */
  async pulse(who = "ann", o: { agent?: string; maySet?: string[]; overlap?: string; gate?: boolean } = {}): Promise<string> {
    const p = await this.pk.pulseOk(who, {
      preset: snap("routine-audit", routineText(o)),
      params: { repo: REPO, agent: o.agent ?? "auditor" },
      when: { every: "30d", at: T0 + 365 * DAY },
      ...(o.overlap ? { overlap: o.overlap } : {}),
    });
    return p.id as string;
  }

  /** Fire pulse `p` by hand one minute later; returns the goal's step ids. */
  async fire(p = "p-1", o: { trial?: boolean; who?: string } = {}): Promise<Run> {
    this.tick();
    const res = await this.pk.act(o.who ?? "ann", p, "fire", o.trial ? { trial: true } : {});
    expect(res.status, JSON.stringify(res.json)).toBe(201);
    const G = res.json.slot.goal as string;
    expect(G, JSON.stringify(res.json)).toBeTruthy();
    return { G, D: `${G}.debrief`, F: `${G}.file`, V: `${G}.validate`, AU: `${G}.audit` };
  }

  /** The audit raises `items`; returns the lineage. */
  async audit(R: Run, items: unknown[] = [IA, IB, IC], coverage: "complete" | "partial" = "complete", agent = AUD): Promise<string> {
    const r = await record(this.k, R.AU, { items, agent, coverage });
    return r.review.lineage as string;
  }
  /** The validator confirms those of `fps` that are open in `lineage` (all of them without a lineage). */
  async validate(R: Run, fps: string[] = [A, B, C], lineage?: string): Promise<void> {
    const open = lineage ? new Set((await this.items(lineage)).filter((x) => x.state === "open").map((x) => x.fp as string)) : undefined;
    const confirm = fps.filter((f) => !open || open.has(f));
    await record(this.k, R.V, { dispositions: confirm.map((f) => ({ fingerprint: f, disposition: "confirmed", reason: "real" })), agent: VAL });
  }
  /** Fire, audit and validate (the validator confirms what is open): the review of the new goal is ready (or superseded). */
  async run(p = "p-1", o: { items?: unknown[]; confirm?: string[]; coverage?: "complete" | "partial"; trial?: boolean; who?: string } = {}): Promise<Run> {
    const R = await this.fire(p, { ...(o.trial ? { trial: true } : {}), ...(o.who ? { who: o.who } : {}) });
    const lineage = await this.audit(R, o.items ?? [IA, IB, IC], o.coverage ?? "complete");
    await this.validate(R, o.confirm ?? [A, B, C], lineage);
    return R;
  }

  // ---- the route ------------------------------------------------------------------------------

  /** `POST /v1/steps/<id>/decisions` as a person (a Person or a token). */
  decide(who: Person | string, id: string, decisions: unknown[] | unknown, headers: Record<string, string> = {}) {
    const token = typeof who === "string" ? (this.pk.tok[who] ?? who) : who.login.token;
    const body = Array.isArray(decisions) ? { decisions } : decisions;
    return this.w.call(token, "POST", `/v1/steps/${id}/decisions`, body, headers);
  }
  /** The same as a service (`svc` unless given) acting for `user` (no header when undefined). */
  decideAs(user: string | undefined, id: string, decisions: unknown[], token = this.svc, extra: Record<string, string> = {}) {
    return this.w.call(token, "POST", `/v1/steps/${id}/decisions`, { decisions }, { ...(user === undefined ? {} : { [H]: user }), ...extra });
  }
  async decideOk(who: Person | string, id: string, decisions: unknown[]): Promise<Json> {
    const r = await this.decide(who, id, decisions);
    expect(r.status, `decide ${id}: ${JSON.stringify(r.json)}`).toBe(200);
    return r.json;
  }

  // ---- reads ----------------------------------------------------------------------------------

  async step(id: string): Promise<Json> {
    return this.k.r.stepOf(id);
  }
  async goalState(G: string): Promise<string> {
    return this.pk.goalState(G);
  }
  async item(f: string, lineage: string): Promise<Json> {
    return this.k.item(f, lineage);
  }
  async items(lineage: string): Promise<Json[]> {
    const res = await this.k.r.call(this.ann, "GET", `/v1/items?lineage=${encodeURIComponent(lineage)}`);
    expect(res.status, JSON.stringify(res.json)).toBe(200);
    return res.json.items;
  }
  async view(id: string): Promise<Json> {
    const res = await this.k.r.call(this.ann, "GET", `/v1/steps/${id}/debrief`);
    expect(res.status, JSON.stringify(res.json)).toBe(200);
    return res.json;
  }
  async openSet(id: string): Promise<string[]> {
    return ((await this.view(id)).items as Json[]).map((i) => i.fp as string).sort();
  }
  async reviews(id: string): Promise<Json[]> {
    const r = await this.k.r.call(this.ann, "GET", `/v1/steps/${id}/reviews`);
    expect(r.status, JSON.stringify(r.json)).toBe(200);
    return r.json.reviews;
  }
  async notes(id: string): Promise<string[]> {
    const r = await this.k.r.call(this.ann, "GET", `/v1/steps/${id}`);
    expect(r.status, JSON.stringify(r.json)).toBe(200);
    return ((r.json.context.notes ?? []) as Json[]).map((n) => n.text as string);
  }
  async events(): Promise<Json[]> {
    return this.k.r.allEvents();
  }
  async lastSeq(): Promise<number> {
    return (await this.events()).at(-1)?.seq ?? 0;
  }
  async since(seq: number): Promise<Json[]> {
    return (await this.events()).filter((e) => e.seq > seq);
  }
  async ev(type: string, pred: (e: Json) => boolean = () => true): Promise<Json[]> {
    return (await this.events()).filter((e) => e.type === type && pred(e));
  }
  /** The slot of goal `G` of pulse `p`. */
  async slotOf(G: string, p = "p-1"): Promise<Json> {
    const s = (await this.pk.slotsOf(p)).find((x) => x.goal === G);
    expect(s, `slot of ${G}`).toBeDefined();
    return s as Json;
  }
  /** Every goal (plain list and `?pulses=1`), by id. */
  async goals(): Promise<Json[]> {
    const all = new Map<string, Json>();
    for (const q of ["", "?pulses=1"]) for (const g of await this.k.goals(this.ann, q)) all.set(g.id, g);
    return [...all.values()];
  }
  /** The clean-audit goal of topic audit, or undefined. */
  async cag(): Promise<Json | undefined> {
    return (await this.goals()).find((g) => g.sink?.topic === "audit" && g.state !== "dropped");
  }
  /** What a refusal must leave alone: every event, the item rows of `lineage` and the step `id`. */
  async snapshot(id: string, lineage: string): Promise<Json> {
    const items = (await this.items(lineage)).map((x) => ({ fp: x.fp, state: x.state, n: (x.history as Json[]).length }));
    const s = await this.step(id);
    return { events: (await this.events()).length, items, step: { state: s.state, rounds: (s.rounds ?? []).length, holderUser: s.holderUser }, reviews: (await this.reviews(id)).length };
  }
  /** Set a stored step's fields directly (states no single route reaches: paused, a foreign holder). */
  async patchStep(id: string, over: Record<string, unknown>): Promise<void> {
    const s = await this.w.hubStore.getStep(id);
    expect(s, id).toBeDefined();
    await this.w.hubStore.saveSteps([{ ...(s as object), ...over } as never]);
  }
}

export { AUD, VAL, fpOf, item, T0 };
export type { Json, Person };
