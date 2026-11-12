// RL-4 test kit: debriefs through the hub and the daemon (World), built on `Relay` and the RL-2 kit.
// Written from the spec's contracts only (docs/specs/RL-4.md). Steps by id, items by fp, events by
// type + step. Fingerprints come from the test-side formula (review-kit `fp`).
//
// Cast: alice = goal owner and (by `@owner`) the debrief's assignee, with a daemon; bob = admin,
// with a daemon; carol = member (login only; the new owner in AC-04); dave = plain member (login
// only; neither decider, owner nor admin).

import { expect } from "vitest";
import { Relay, type PlanIn } from "./relay-kit.ts";
import { fp, item, NOV19, rec } from "./review-kit.ts";
import type { Json, Person } from "./world.ts";

/** The repo of the relay steps: a name, so `mesh run <repo name>` finds the people's checkouts. */
export const REPO = "svc";

/** Items of the relay fixture: A (S1), B (S2), C (S3); A carries an evidence note that must never reach the view. */
export const IA = item("r.alpha", { path: "src/a.ts", symbol: "fa", severity: "S1", title: "Alpha leak", evidence: [{ path: "src/a.ts", lines: [3, 5], note: "NOTE-A" }] });
export const IB = item("r.beta", { path: "src/b.ts", severity: "S2", title: "Beta bug", evidence: [{ path: "src/b.ts", lines: [1, 2] }] });
export const IC = item("r.gamma", { path: "src/c.ts", severity: "S3", title: "Gamma nit", evidence: [{ path: "src/c.ts" }] });
export const A = fp("r.alpha", "src/a.ts", "fa");
export const B = fp("r.beta", "src/b.ts");
export const C = fp("r.gamma", "src/c.ts");
export const TITLE: Record<string, string> = { [A]: "Alpha leak", [B]: "Beta bug", [C]: "Gamma nit" };

/** The no-more-items reply tail of `mesh_dispose` (spec, Daemon). */
export const NO_LEFT =
  "No item left to decide: store the summary with mesh_artifact (kind transcript), submit the review record with mesh_review (its dispositions: your latest decision per item, or none), then call mesh_done.";
export const NOT_YOURS = (id: string, who: string) => `${id} is a debrief for ${who}; only they can take it`;
export const PROBLEMS = (ps: string[]) => `the review record has ${ps.length} problem(s): ${ps.join("; ")}`;

export const S = {
  audit: (over: Record<string, unknown> = {}): PlanIn => ({ id: "audit", repo: REPO, mode: "headless", agent: "auditor", output: "review-record", ...over }),
  debrief: (over: Record<string, unknown> = {}): PlanIn => ({
    id: "debrief",
    repo: REPO,
    kind: "review",
    deps: ["audit"],
    mode: "debrief",
    output: "review-record",
    may_set: ["accepted", "dismissed", "deferred"],
    ...over,
  }),
  file: (over: Record<string, unknown> = {}): PlanIn => ({ id: "file", repo: REPO, deps: ["debrief"], output: "review-record", when: { open: true }, consumes: ["accepted"], ...over }),
  step: (id: string, over: Record<string, unknown> = {}): PlanIn => ({ id, repo: REPO, ...over }),
};

export interface Cast {
  alice: Person;
  bob: Person;
  /** Device tokens (logins without a daemon). */
  carol: string;
  dave: string;
}

export interface Ids {
  G: string;
  AU: string;
  D: string;
  F: string;
}

export class Dk {
  readonly r: Relay;
  c!: Cast;
  /** The lineage of the last audit record (from its ReviewResult). */
  lineage = "";
  private pids = 1000;

  constructor(r: Relay) {
    this.r = r;
  }

  static async start(o: { clock?: number; hubYaml?: Record<string, unknown> } = {}): Promise<Dk> {
    const r = await Relay.start(["alice", "bob", "carol", "dave"], { admins: ["bob"], ...(o.hubYaml ? { hubYaml: o.hubYaml } : {}) });
    r.w.clock = o.clock ?? NOV19;
    const k = new Dk(r);
    const alice = await r.w.person("alice", REPO, { shareSessions: "me" });
    const bob = await r.w.person("bob", REPO, { shareSessions: "me" });
    const carol = (await r.w.login("carol", { hostname: "carol-box" })).token;
    const dave = (await r.w.login("dave", { hostname: "dave-box" })).token;
    await r.w.flush();
    k.c = { alice, bob, carol, dave };
    return k;
  }

  get w() {
    return this.r.w;
  }

  call(who: Person | string, method: "GET" | "POST", path: string, body?: unknown) {
    return this.r.call(who, method, path, body);
  }

  /** POST with an optional Idempotency-Key header. */
  async post(who: Person | string, path: string, body: unknown, idem?: string): Promise<{ status: number; json: Json }> {
    const token = typeof who === "string" ? who : who.login.token;
    const res = await fetch(`${this.w.hub.url}${path}`, {
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

  /** A goal of `owner` with these steps, plan approved; returns the goal id. */
  async goal(owner: Person | string, steps: PlanIn[]): Promise<string> {
    return this.r.goal(owner, steps);
  }

  /** The relay fixture: audit → debrief (mode debrief, no consumes, no assignee) → file. */
  async relay(o: { debrief?: Record<string, unknown>; extra?: PlanIn[]; owner?: Person | string; audit?: Record<string, unknown> } = {}): Promise<Ids> {
    const G = await this.goal(o.owner ?? this.c.alice, [S.audit(o.audit), S.debrief(o.debrief), S.file(), ...(o.extra ?? [])]);
    return { G, AU: `${G}.audit`, D: `${G}.debrief`, F: `${G}.file` };
  }

  async claim(who: Person | string, id: string): Promise<void> {
    const c = await this.r.act(who, id, "claim", {});
    expect(c.status, `claim ${id}: ${JSON.stringify(c.json)}`).toBe(200);
  }
  async review(who: Person | string, id: string, body: unknown, idem?: string) {
    return this.post(who, `/v1/steps/${id}/review`, body, idem);
  }
  async reviewOk(who: Person | string, id: string, body: unknown): Promise<Json> {
    const res = await this.review(who, id, body);
    expect(res.status, `review ${id}: ${JSON.stringify(res.json)}`).toBe(201);
    return res.json;
  }
  async doneOk(who: Person | string, id: string): Promise<Json> {
    const d = await this.r.act(who, id, "done", { outcome: "done", summary: "ok" });
    expect(d.status, `done ${id}: ${JSON.stringify(d.json)}`).toBe(200);
    return d.json;
  }

  /** alice claims audit, uploads `report`, records `items`, closes it done → the debrief is ready. */
  async auditDone(ids: Ids, items: unknown[] = [IA, IB, IC], o: { report?: string | string[]; who?: Person | string } = {}): Promise<Json> {
    const who = o.who ?? this.c.alice;
    await this.claim(who, ids.AU);
    const reports = o.report === undefined ? ["REPORT-TEXT"] : Array.isArray(o.report) ? o.report : [o.report];
    for (const content of reports) {
      const up = await this.r.upload(who, ids.AU, { kind: "report", content });
      expect(up.status, JSON.stringify(up.json)).toBe(201);
    }
    const res = await this.reviewOk(who, ids.AU, rec({ items }));
    this.lineage = res.review.lineage as string;
    await this.doneOk(who, ids.AU);
    return res;
  }

  /** A fresh session of `p` claims `id` through MCP (`mesh_claim`); returns its pid. */
  async hold(id: string, p: Person = this.c.alice): Promise<number> {
    const pid = ++this.pids;
    await this.w.hook(p, "SessionStart", pid);
    const c = await this.w.tool(p, pid, "mesh_claim", { step: id });
    expect(c.isError, c.text).toBeFalsy();
    await this.w.flush();
    return pid;
  }

  /** `mesh_dispose` through the person's daemon (reason R-<fp>, answer ANS-<fp> unless given). */
  dispose(pid: number, f: string, disposition: string, extra: Record<string, unknown> = {}, p: Person = this.c.alice) {
    return this.w.tool(p, pid, "mesh_dispose" as never, { fingerprint: f, disposition, reason: `R-${f}`, answer: `ANS-${f}`, ...extra });
  }
  async disposeOk(pid: number, f: string, disposition: string, extra: Record<string, unknown> = {}, p: Person = this.c.alice): Promise<string> {
    const t = await this.dispose(pid, f, disposition, extra, p);
    expect(t.isError, t.text).toBeFalsy();
    return t.text;
  }

  /** `POST /v1/steps/<id>/<verb>` with an optional Idempotency-Key. */
  route(who: Person | string, id: string, verb: string, body: unknown, idem?: string) {
    return this.post(who, `/v1/steps/${id}/${verb}`, body, idem);
  }
  /** The dispositions route directly (reason R-<fp>, answer ANS-<fp> unless given). */
  disposeRoute(who: Person | string, id: string, f: string, disposition: string, extra: Record<string, unknown> = {}, idem?: string) {
    return this.route(who, id, "dispositions", { fingerprint: f, disposition, reason: `R-${f}`, answer: `ANS-${f}`, ...extra }, idem);
  }
  revert(who: Person | string, id: string, f: string, extra: Record<string, unknown> = {}, idem?: string) {
    return this.route(who, id, "dispositions/revert", { fingerprint: f, ...extra }, idem);
  }

  async items(who: Person | string = this.c.alice, lineage = this.lineage): Promise<Json[]> {
    const res = await this.call(who, "GET", `/v1/items?lineage=${encodeURIComponent(lineage)}`);
    expect(res.status, JSON.stringify(res.json)).toBe(200);
    return res.json.items;
  }
  async item(f: string, lineage = this.lineage): Promise<Json> {
    const xs = (await this.items(this.c.alice, lineage)).filter((x) => x.fp === f);
    expect(xs, `one item ${f}`).toHaveLength(1);
    return xs[0];
  }
  async history(f: string, lineage = this.lineage): Promise<Json[]> {
    return (await this.item(f, lineage)).history as Json[];
  }
  async state(f: string): Promise<string> {
    return (await this.item(f)).state as string;
  }
  async step(id: string): Promise<Json> {
    return this.r.stepOf(id);
  }
  async notes(id: string): Promise<string[]> {
    const r = await this.call(this.c.alice, "GET", `/v1/steps/${id}`);
    expect(r.status, JSON.stringify(r.json)).toBe(200);
    return ((r.json.context.notes ?? []) as Json[]).map((n) => n.text as string);
  }
  async ev(type: string, step?: string): Promise<Json[]> {
    return this.r.events(type, step);
  }
  async view(id: string, who: Person | string = this.c.alice): Promise<{ status: number; json: Json }> {
    return this.call(who, "GET", `/v1/steps/${id}/debrief`);
  }
  async viewOk(id: string, who: Person | string = this.c.alice): Promise<Json> {
    const v = await this.view(id, who);
    expect(v.status, JSON.stringify(v.json)).toBe(200);
    return v.json;
  }
  async list(who: Person | string = this.c.alice): Promise<Json> {
    const l = await this.call(who, "GET", "/v1/debriefs");
    expect(l.status, JSON.stringify(l.json)).toBe(200);
    return l.json;
  }
  async reviews(id: string): Promise<Json[]> {
    const r = await this.call(this.c.alice, "GET", `/v1/steps/${id}/reviews`);
    expect(r.status, JSON.stringify(r.json)).toBe(200);
    return r.json.reviews;
  }
  /** Set a stored step's fields directly (e.g. `paused`), as other World tests reach the store. */
  async patchStep(id: string, over: Record<string, unknown>): Promise<void> {
    const s = await this.w.hubStore.getStep(id);
    expect(s, id).toBeDefined();
    await this.w.hubStore.saveSteps([{ ...(s as object), ...over } as never]);
  }

  /** What a debrief error must leave alone: items, history lengths, notes and event counts of `D`. */
  async snapshot(D: string): Promise<Json> {
    const xs = await this.items();
    return {
      items: xs.map((x) => ({ fp: x.fp, state: x.state, n: (x.history as Json[]).length })),
      notes: await this.notes(D),
      disposed: (await this.ev("item.disposed", D)).length,
      noted: (await this.ev("step.noted", D)).length,
      reverted: (await this.ev("item.reverted", D)).length,
      reviews: (await this.reviews(D)).length,
    };
  }
}

/** The disposition history entries of an item. */
export const dispositionsOf = (h: Json[]) => h.filter((e) => e.kind === "disposition");
