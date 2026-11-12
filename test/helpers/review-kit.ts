// RL-2 test kit: review records through the hub (World), built on `Relay`. Expected fingerprints are
// computed here, test-side, from the documented formula (never by importing `fingerprint`), so the
// World tests check the formula too. Steps by id, items by fp, events by type + step.

import { createHash } from "node:crypto";
import { expect } from "vitest";
import { Relay, type PlanIn } from "./relay-kit.ts";
import type { Json, Person } from "./world.ts";

export const ALPHA = "/src/alpha";
/** The lineage of `audit` steps below: no preset, repo `/src/alpha`, agent `auditor`. */
export const L = `-|${ALPHA}|auditor`;
export const E1 = "1".repeat(64);
export const E2 = "2".repeat(64);
export const E9 = "9".repeat(64);
export const DAY_MS = 86_400_000;
/** 2026-11-19T12:00:00Z: the clock the review tests start at (today = 2026-11-19). */
export const NOV19 = Date.UTC(2026, 10, 19, 12);

export const sha = (s: string) => createHash("sha256").update(s, "utf8").digest("hex");
const B32 = "abcdefghijklmnopqrstuvwxyz234567";
function base32(buf: Buffer): string {
  let bits = 0;
  let v = 0;
  let out = "";
  for (const b of buf) {
    v = (v << 8) | b;
    bits += 8;
    while (bits >= 5) {
      out += B32[(v >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += B32[(v << (5 - bits)) & 31];
  return out;
}
/** The documented fingerprint of an already normalised key. */
export const fp = (rule: string, path = "", symbol = "") => base32(createHash("sha256").update(`${rule}\n${path}\n${symbol}`, "utf8").digest()).slice(0, 16);
/** fp of `item(rule)` with its default path. */
export const fpOf = (rule: string, path = "src/a.ts", symbol = "") => fp(rule, path, symbol);
/** The documented evidence hash of regions (null = missing). */
export const evidenceHashOf = (regions: (string | null)[]) => (regions.length === 0 ? undefined : sha(regions.map((x) => (x === null ? "missing" : sha(x.replace(/\s+/g, " ").trim()))).join("\n")));

export interface ItemOpts {
  path?: string;
  symbol?: string;
  title?: string;
  severity?: string;
  category?: string;
  evidence?: unknown[];
  eh?: string;
  proposal?: string;
}
export const item = (rule: string, o: ItemOpts = {}) => ({
  key: { rule, path: o.path ?? "src/a.ts", ...(o.symbol ? { symbol: o.symbol } : {}) },
  title: o.title ?? `T-${rule}`,
  severity: o.severity ?? "S3",
  category: o.category ?? "c",
  evidence: o.evidence ?? [],
  ...(o.eh ? { eh: o.eh } : {}),
  ...(o.proposal ? { proposal: o.proposal } : {}),
});
export const disp = (fingerprint: string, disposition: string, o: { reason?: string; until?: string; link?: string } = {}) => ({ fingerprint, disposition, reason: o.reason ?? `because ${disposition}`, ...(o.until ? { until: o.until } : {}), ...(o.link ? { link: o.link } : {}) });

export interface RecOpts {
  items?: unknown[];
  dispositions?: unknown[];
  coverage?: "complete" | "partial";
  assessment?: string;
  agent?: { key: string; hash?: string };
  sid?: string;
  subject?: Record<string, unknown>;
  summary?: string;
  redactions?: number;
  undeclaredRules?: number;
}
export const rec = (o: RecOpts = {}) => {
  const items = o.items ?? [];
  return {
    coverage: o.coverage ?? "complete",
    assessment: o.assessment ?? (items.length ? "issues" : "clean"),
    items,
    dispositions: o.dispositions ?? [],
    summary: o.summary ?? "s",
    ...(o.subject ? { subject: o.subject } : {}),
    ...(o.agent ? { agent: o.agent } : {}),
    ...(o.sid ? { sid: o.sid } : {}),
    ...(o.redactions !== undefined ? { redactions: o.redactions } : {}),
    ...(o.undeclaredRules !== undefined ? { undeclaredRules: o.undeclaredRules } : {}),
  };
};

/** Plan steps of one lineage (repo /src/alpha). */
export const S = {
  audit: (over: Record<string, unknown> = {}): PlanIn => ({ id: "audit", repo: ALPHA, mode: "headless", agent: "auditor", output: "review-record", ...over }),
  validate: (over: Record<string, unknown> = {}): PlanIn => ({
    id: "validate",
    repo: ALPHA,
    deps: ["audit"],
    mode: "headless",
    agent: "validator",
    output: "review-record",
    consumes: ["open"],
    may_set: ["confirmed", "dismissed"],
    ...over,
  }),
  step: (id: string, over: Record<string, unknown> = {}): PlanIn => ({ id, repo: ALPHA, ...over }),
};

/** AC-17's relay: audit → validate (when open) → debrief (interactive, S2) → file (accepted). */
export const relayPlan = (extra: PlanIn[] = []): PlanIn[] => [
  S.audit(),
  S.validate({ when: { open: true } }),
  S.step("debrief", { deps: ["validate"], output: "review-record", when: { open: true, min_severity: "S2" }, consumes: ["open", "confirmed"], may_set: ["accepted", "dismissed", "deferred"] }),
  S.step("file", { deps: ["debrief"], output: "review-record", when: { open: true }, consumes: ["accepted"] }),
  ...extra,
];

export interface RCast {
  ann: Person;
  bob: Person;
  root: string;
}

export class Rk {
  readonly r: Relay;
  constructor(r: Relay) {
    this.r = r;
  }

  /** ann (shareSessions `me`), bob, root (admin login); the clock at NOV19 before any login. */
  static async start(o: { hubYaml?: Record<string, unknown>; clock?: number } = {}): Promise<{ k: Rk; c: RCast }> {
    const r = await Relay.start(["ann", "bob", "carol", "root"], { admins: ["root"], ...(o.hubYaml ? { hubYaml: o.hubYaml } : {}) });
    r.w.clock = o.clock ?? NOV19;
    const ann = await r.w.person("ann", "svc", { shareSessions: "me" });
    const bob = await r.w.person("bob", "svc", { shareSessions: "me" });
    const root = (await r.w.login("root", { hostname: "root-box" })).token;
    await r.w.flush();
    return { k: new Rk(r), c: { ann, bob, root } };
  }

  /** A goal of `owner` (optionally with a preset), its plan approved; returns the goal id. */
  async goal(owner: Person | string, steps: PlanIn[], o: { preset?: { name: string; text: string } } = {}): Promise<string> {
    const g = await this.r.call(owner, "POST", "/v1/goals", { title: `Review goal ${Math.random().toString(36).slice(2, 8)}`, primaryRepo: "svc", ...(o.preset ? { preset: o.preset } : {}) });
    expect(g.status, JSON.stringify(g.json)).toBe(201);
    const G = g.json.id as string;
    const p = await this.r.plan(owner, G, steps);
    expect(p.status, JSON.stringify(p.json)).toBe(201);
    return G;
  }

  async claim(who: Person | string, id: string): Promise<void> {
    const c = await this.r.act(who, id, "claim", {});
    expect(c.status, `claim ${id}: ${JSON.stringify(c.json)}`).toBe(200);
  }

  /** POST /v1/steps/<id>/review, with an Idempotency-Key when given. */
  async review(who: Person | string, id: string, body: unknown, idem?: string): Promise<{ status: number; json: Json }> {
    const token = typeof who === "string" ? who : who.login.token;
    const res = await fetch(`${this.r.w.hub.url}/v1/steps/${id}/review`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}`, ...(idem ? { "idempotency-key": idem } : {}) },
      body: JSON.stringify(body),
    });
    const text = await res.text();
    let json: Json;
    try {
      json = text ? JSON.parse(text) : undefined;
    } catch {
      json = text;
    }
    return { status: res.status, json };
  }

  /** review(), expecting 201; returns the ReviewResult. */
  async reviewOk(who: Person | string, id: string, body: unknown): Promise<Json> {
    const res = await this.review(who, id, body);
    expect(res.status, `review ${id}: ${JSON.stringify(res.json)}`).toBe(201);
    return res.json;
  }

  close(who: Person | string, id: string, body: Record<string, unknown> = {}) {
    return this.r.act(who, id, "done", { outcome: "done", summary: "ok", ...body });
  }
  async closeOk(who: Person | string, id: string, body: Record<string, unknown> = {}): Promise<Json> {
    const d = await this.close(who, id, body);
    expect(d.status, `done ${id}: ${JSON.stringify(d.json)}`).toBe(200);
    return d.json;
  }

  /** Claim `<G>.<id>`, submit `body`, close it done; returns the ReviewResult. */
  async submit(who: Person | string, id: string, body: unknown): Promise<Json> {
    await this.claim(who, id);
    const res = await this.reviewOk(who, id, body);
    await this.closeOk(who, id);
    return res;
  }

  async reviews(who: Person | string, id: string): Promise<{ status: number; json: Json }> {
    return this.r.call(who, "GET", `/v1/steps/${id}/reviews`);
  }
  async itemsOf(who: Person | string, lineage = L): Promise<Json[]> {
    const res = await this.r.call(who, "GET", `/v1/items?lineage=${encodeURIComponent(lineage)}`);
    expect(res.status, JSON.stringify(res.json)).toBe(200);
    return res.json.items;
  }
  async itemOf(who: Person | string, f: string, lineage = L): Promise<Json> {
    const xs = (await this.itemsOf(who, lineage)).filter((x) => x.fp === f);
    expect(xs, `one item ${f} in ${lineage}`).toHaveLength(1);
    return xs[0];
  }
  async state(id: string): Promise<string> {
    return (await this.r.stepOf(id)).state as string;
  }
  async goalState(who: Person | string, G: string): Promise<string> {
    const g = await this.r.call(who, "GET", `/v1/goals/${G}`);
    expect(g.status, JSON.stringify(g.json)).toBe(200);
    return g.json.goal.state as string;
  }
  async ctx(who: Person | string, id: string): Promise<Json> {
    const c = await this.r.call(who, "GET", `/v1/steps/${id}/context`);
    expect(c.status, JSON.stringify(c.json)).toBe(200);
    return c.json.context ?? c.json;
  }
  /** Approve `steps` as a new plan of G (replan first). */
  async replan(owner: Person | string, G: string, steps: PlanIn[]): Promise<void> {
    const rp = await this.r.call(owner, "POST", `/v1/goals/${G}/replan`, { comment: "again" });
    expect(rp.status, JSON.stringify(rp.json)).toBe(200);
    const p = await this.r.plan(owner, G, steps);
    expect(p.status, JSON.stringify(p.json)).toBe(201);
  }
  /** `t` (a verify step, deps include `s`) fails with reopen [s]: s gets a new round. */
  async reopenVia(who: Person | string, G: string, t: string, s: string): Promise<void> {
    await this.claim(who, `${G}.${t}`);
    const f = await this.close(who, `${G}.${t}`, { outcome: "fail", reopen: [s] });
    expect(f.status, JSON.stringify(f.json)).toBe(200);
  }
  markOf(res: Json, f: string): string | undefined {
    return (res.items as Json[]).find((x) => x.fp === f)?.mark;
  }
}
