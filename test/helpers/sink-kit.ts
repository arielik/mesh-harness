// RL-9 test kit: clean-audit goals (sink stages, finding steps, item → step sync) through the hub
// (World), built on `Relay` and the RL-2 review kit. Written from the spec's contracts only
// (docs/specs/RL-9.md). Expected finding-step ids are computed here, test-side, from the documented
// formula (never by importing the implementation's helper). Steps by id, items by fp, goals by
// `sink`, events by type + goal/step + payload `from`.
//
// Relay stages are interactive steps run by persons through the hub tools (MCP over the person's
// daemon: `mesh_claim`, `mesh_review`, `mesh_dispose`, `mesh_done`).

import { createHash } from "node:crypto";
import { expect } from "vitest";
import { git, Relay, type PlanIn } from "./relay-kit.ts";
import { base32, disp, fpOf, item, NOV19 } from "./review-kit.ts";
import type { Json, Person } from "./world.ts";

export const REPO = "r";
export const DAY_MS = 86_400_000;
export { NOV19 };

/** The lineage of the `audit` stage of a goal made from preset `preset` on repo `repo` (interactive: agent = local id). */
export const LIN = (preset = "relay", repo = REPO) => `${preset}|${repo}|audit`;
/** The documented finding-step local id: `f-` + the first 16 chars of the lowercase base32 SHA-256 of `<lineage>|<fp>`. */
export const fid = (lineage: string, f: string) => `f-${base32(createHash("sha256").update(`${lineage}|${f}`, "utf8").digest()).slice(0, 16)}`;
/** The documented last line of a finding step's brief. */
export const LAST = (lineage: string) => `When the fix lands, the next audit of ${lineage} resolves this finding; do not edit the tracking row.`;
export const LINK = (f: string) => `https://tracker.example/${f}`;
export const CLEAN_TEXT = (G: string) => `${G} is a clean-audit goal; its steps come from audits`;

export const AUDIT: PlanIn = { id: "audit", repo: REPO, output: "review-record" };
export const FILE = (over: Record<string, unknown> = {}): PlanIn => ({
  id: "file",
  repo: REPO,
  deps: ["audit"],
  consumes: ["open", "confirmed", "accepted"],
  may_set: ["accepted"],
  output: "review-record",
  sink: { topic: "ci" },
  ...over,
});
export const TRIAGE = (over: Record<string, unknown> = {}): PlanIn => ({ id: "triage", repo: REPO, deps: ["audit"], output: "review-record", consumes: ["accepted"], may_set: ["dismissed", "deferred"], ...over });
/** A gate step (a person decides it) after `deps`. */
export const GATE = (deps: string[], over: Record<string, unknown> = {}): PlanIn => ({ id: "gate", repo: REPO, kind: "gate", gate: "R1", deps, ...over });
export const DEBRIEF = (over: Record<string, unknown> = {}): PlanIn => ({ id: "debrief", repo: REPO, mode: "debrief", deps: ["audit"], output: "review-record", ...over });

/** An `accepted` disposition with a link (default `LINK(f)`) and, when given, `requires`. */
export const acc = (f: string, o: { requires?: string[]; link?: string; reason?: string } = {}) => ({
  ...disp(f, "accepted", { link: o.link ?? LINK(f), ...(o.reason ? { reason: o.reason } : {}) }),
  ...(o.requires ? { requires: o.requires } : {}),
});
export const recArgs = (o: Record<string, unknown>) => ({ coverage: "complete", assessment: "issues", items: [], dispositions: [], summary: "s", ...o });

/** Items of the fixture: A (S2, with evidence and a proposal), B (S1), C … F, X (S3). */
export const IA = item("ra", { severity: "S2", title: "T-A", proposal: "P-A", evidence: [{ path: "src/a.ts", lines: [3, 5], note: "N-A" }] });
export const IB = item("rb", { severity: "S1", title: "T-B" });
export const IC = item("rc", { title: "T-C" });
export const ID = item("rd", { title: "T-D" });
export const IE = item("re", { title: "T-E" });
export const IF = item("rf", { title: "T-F" });
/**
 * The fp of an item raised by `item(rule)` in an interactive stage: with no agent, every rule is
 * recorded as `other:<slug>` (concepts, Declared rules), and the fingerprint is of the recorded key.
 */
export const fpR = (rule: string, path = "src/a.ts") => fpOf(`other:${rule}`, path);
export const fA = fpR("ra");
export const fB = fpR("rb");
export const fC = fpR("rc");
export const fD = fpR("rd");
export const fE = fpR("re");
export const fF = fpR("rf");

export interface Run {
  G: string;
  audit: string;
  file: string;
  /** `${G}.${local}` */
  s(local: string): string;
}

export interface StageResult {
  pid: number;
  review: { isError?: boolean; text: string } | undefined;
  done: { isError?: boolean; text: string } | undefined;
}

export class Sk {
  readonly r: Relay;
  ann!: Person;
  bob!: Person;
  carol!: string;
  root!: string;
  private pids = 100;

  constructor(r: Relay) {
    this.r = r;
  }

  /**
   * ann and bob with daemons in repo `r` (a remote-backed checkout with one commit, share `me`),
   * carol a login only (a member: not owner, approver or admin), root an admin login. Clock NOV19.
   * ann defines topic `ci`.
   */
  static async start(o: { topic?: boolean } = {}): Promise<Sk> {
    const r = await Relay.start(["ann", "bob", "carol", "root"], { admins: ["root"] });
    r.w.clock = NOV19;
    const k = new Sk(r);
    k.ann = await r.w.person("ann", REPO, { shareSessions: "me" });
    k.bob = await r.w.person("bob", REPO, { shareSessions: "me" });
    for (const p of [k.ann, k.bob]) {
      git(p.repoDir, ["commit", "-q", "--allow-empty", "-m", "init"]);
      git(p.repoDir, ["remote", "add", "origin", "https://git.example.com/rl9/r.git"]);
    }
    k.carol = (await r.w.login("carol", { hostname: "carol-box" })).token;
    k.root = (await r.w.login("root", { hostname: "root-box" })).token;
    await r.w.flush();
    if (o.topic !== false) {
      const t = await r.call(k.ann, "POST", "/v1/topics", { name: "ci" });
      expect(t.status, JSON.stringify(t.json)).toBe(201);
    }
    return k;
  }

  get w() {
    return this.r.w;
  }
  async stop(): Promise<void> {
    await this.r.stop();
  }
  call(who: Person | string, method: "GET" | "POST", path: string, body?: unknown) {
    return this.r.call(who, method, path, body);
  }

  /** A goal of `owner` made from preset `preset` (default `relay`) with `steps` (default audit → file), plan approved. */
  async run(o: { preset?: string; steps?: PlanIn[]; owner?: Person | string; primaryRepo?: string } = {}): Promise<Run> {
    const owner = o.owner ?? this.ann;
    const g = await this.call(owner, "POST", "/v1/goals", { title: `Relay ${Math.random().toString(36).slice(2, 8)}`, primaryRepo: o.primaryRepo ?? REPO, preset: { name: o.preset ?? "relay", text: "steps: []\n" } });
    expect(g.status, JSON.stringify(g.json)).toBe(201);
    const G = g.json.id as string;
    const steps = (o.steps ?? [AUDIT, FILE()]).map((s) => ({ repo: REPO, ...s }));
    const p = await this.r.plan(owner, G, steps);
    expect(p.status, `plan of ${G}: ${JSON.stringify(p.json)}`).toBe(201);
    return { G, audit: `${G}.audit`, file: `${G}.file`, s: (l: string) => `${G}.${l}` };
  }

  /** A fresh session of `p` claims `id` through MCP (`mesh_claim`); returns its pid. */
  async hold(p: Person, id: string): Promise<number> {
    const pid = ++this.pids;
    await this.w.hook(p, "SessionStart", pid);
    const c = await this.w.tool(p, pid, "mesh_claim", { step: id });
    expect(c.isError, `mesh_claim ${id}: ${c.text}`).toBeFalsy();
    await this.w.flush();
    return pid;
  }
  tool(p: Person, pid: number, name: string, args: Record<string, unknown>) {
    return this.w.tool(p, pid, name as never, args);
  }
  async toolOk(p: Person, pid: number, name: string, args: Record<string, unknown>): Promise<string> {
    const t = await this.tool(p, pid, name, args);
    expect(t.isError, `${name}: ${t.text}`).toBeFalsy();
    await this.w.flush();
    return t.text;
  }
  /** `p` holds `id` through MCP and finishes it with `mesh_done` (done). */
  async doStep(p: Person, id: string): Promise<void> {
    const pid = await this.hold(p, id);
    await this.toolOk(p, pid, "mesh_done", { outcome: "done", summary: "fixed" });
  }

  /** A stage run by `p` through MCP: claim, `mesh_review recArgs(body)`, then (unless `done: false`) `mesh_done`. */
  async stage(p: Person, id: string, body: Record<string, unknown>, o: { done?: boolean } = {}): Promise<StageResult> {
    const pid = await this.hold(p, id);
    const review = await this.tool(p, pid, "mesh_review", recArgs(body));
    await this.w.flush();
    let done: StageResult["done"];
    if (o.done !== false) {
      done = await this.tool(p, pid, "mesh_done", { outcome: "done", summary: "ok" });
      await this.w.flush();
    }
    return { pid, review, done };
  }
  /** `stage` expecting no tool error. */
  async stageOk(p: Person, id: string, body: Record<string, unknown>, o: { done?: boolean } = {}): Promise<StageResult> {
    const res = await this.stage(p, id, body, o);
    expect(res.review?.isError, `mesh_review ${id}: ${res.review?.text}`).toBeFalsy();
    if (res.done) expect(res.done.isError, `mesh_done ${id}: ${res.done.text}`).toBeFalsy();
    return res;
  }
  /**
   * In debrief step `D`, `p` files `f` with `mesh_dispose` (`accepted`, link `link`) and submits an
   * empty complete record; then `mesh_done` unless `done: false`. Returns the session pid.
   */
  async debriefAccept(p: Person, D: string, f: string, o: { link?: string; done?: boolean } = {}): Promise<number> {
    const pid = await this.hold(p, D);
    await this.toolOk(p, pid, "mesh_dispose", { fingerprint: f, disposition: "accepted", reason: `R-${f}`, answer: `ANS-${f}`, link: o.link ?? LINK(f) });
    await this.toolOk(p, pid, "mesh_review", recArgs({ assessment: "clean" }));
    if (o.done !== false) await this.toolOk(p, pid, "mesh_done", { outcome: "done", summary: "debriefed" });
    return pid;
  }
  /** Advance the World clock (hub and daemons) by `ms`, so the next change is strictly later. */
  tick(ms = 60_000): void {
    this.w.clock += ms;
  }

  /** The audit of `R` raises `items` (complete unless said). */
  raise(R: Run, items: unknown[], o: { who?: Person; coverage?: "complete" | "partial" } = {}): Promise<StageResult> {
    return this.stageOk(o.who ?? this.ann, R.audit, { items, coverage: o.coverage ?? "complete", assessment: items.length ? "issues" : "clean" });
  }
  /** The `file` stage (or `stage`) of `R` records `dispositions`. */
  file(R: Run, dispositions: unknown[], o: { who?: Person; stage?: string; agent?: { key: string; hash?: string } } = {}): Promise<StageResult> {
    return this.stageOk(o.who ?? this.ann, o.stage ? R.s(o.stage) : R.file, { assessment: "clean", dispositions, ...(o.agent ? { agent: o.agent } : {}) });
  }

  // ---- reads ----------------------------------------------------------------------------------

  /** Every goal (both the plain list and `?pulses=1`), by id. */
  async goals(): Promise<Json[]> {
    const all = new Map<string, Json>();
    for (const q of ["", "?pulses=1"]) {
      const res = await this.call(this.ann, "GET", `/v1/goals${q}`);
      expect(res.status, JSON.stringify(res.json)).toBe(200);
      for (const g of res.json.goals as Json[]) all.set(g.id, g);
    }
    return [...all.values()];
  }
  /** Every goal whose `sink` deep-equals `{repo, topic}`, dropped included. */
  async cagAll(repo = REPO, topic = "ci"): Promise<Json[]> {
    return (await this.goals()).filter((g) => g.sink && g.sink.repo === repo && g.sink.topic === topic && Object.keys(g.sink).length === 2);
  }
  /** The clean-audit goal of `(repo, topic)` (not dropped), or undefined; at most one. */
  async cag(repo = REPO, topic = "ci"): Promise<Json | undefined> {
    const xs = (await this.cagAll(repo, topic)).filter((g) => g.state !== "dropped");
    expect(xs.length, `at most one clean-audit goal of (${repo}, ${topic})`).toBeLessThanOrEqual(1);
    return xs[0];
  }
  /** The clean-audit goal id of `(repo, topic)`, expected to exist. */
  async CG(repo = REPO, topic = "ci"): Promise<string> {
    const g = await this.cag(repo, topic);
    expect(g, `clean-audit goal of (${repo}, ${topic})`).toBeDefined();
    return g.id as string;
  }
  async goalView(G: string): Promise<Json> {
    const res = await this.call(this.ann, "GET", `/v1/goals/${G}`);
    expect(res.status, JSON.stringify(res.json)).toBe(200);
    return res.json;
  }
  /** The goal's steps with `finding`. */
  async fsteps(G: string): Promise<Json[]> {
    return ((await this.goalView(G)).steps as Json[]).filter((s) => s.finding);
  }
  /** The full id of the finding step of `(lineage, f)` in goal `CG`. */
  fs(CG: string, f: string, lineage = LIN()): string {
    return `${CG}.${fid(lineage, f)}`;
  }
  async step(id: string): Promise<Json> {
    return this.r.stepOf(id);
  }
  async maybeStep(id: string): Promise<Json | undefined> {
    const r = await this.call(this.ann, "GET", `/v1/steps/${id}`);
    return r.status === 200 ? r.json.context.step : undefined;
  }
  async notes(id: string): Promise<string[]> {
    const r = await this.call(this.ann, "GET", `/v1/steps/${id}`);
    expect(r.status, JSON.stringify(r.json)).toBe(200);
    return ((r.json.context.notes ?? []) as Json[]).map((n) => n.text as string);
  }
  async ev(type: string, pred: (e: Json) => boolean = () => true): Promise<Json[]> {
    return (await this.r.allEvents()).filter((e) => e.type === type && pred(e));
  }
  async activity(): Promise<string[]> {
    const r = await this.call(this.ann, "GET", "/v1/live");
    expect(r.status).toBe(200);
    return (r.json.activity as Json[]).map((a) => a.text as string);
  }
  async items(lineage = LIN()): Promise<Json[]> {
    const res = await this.call(this.ann, "GET", `/v1/items?lineage=${encodeURIComponent(lineage)}`);
    expect(res.status, JSON.stringify(res.json)).toBe(200);
    return res.json.items;
  }
  async item(f: string, lineage = LIN()): Promise<Json> {
    const xs = (await this.items(lineage)).filter((x) => x.fp === f);
    expect(xs, `one item ${f} in ${lineage}`).toHaveLength(1);
    return xs[0];
  }
  /** Set a stored step's fields directly (only for states no route reaches in one call: paused, parked, failed). */
  async patchStep(id: string, over: Record<string, unknown>): Promise<void> {
    const s = await this.w.hubStore.getStep(id);
    expect(s, id).toBeDefined();
    await this.w.hubStore.saveSteps([{ ...(s as object), ...over } as never]);
  }
  /** What a "nothing changed" assertion compares: the goal's steps, event counts by type, its plan versions. */
  async snapshot(CG: string): Promise<Json> {
    const view = await this.goalView(CG);
    const steps = (view.steps as Json[])
      .map((s) => ({ id: s.id, state: s.state, title: s.title, severity: s.severity, deps: s.deps, fixCycles: s.fixCycles, holderUser: s.holderUser }))
      .sort((a, b) => String(a.id).localeCompare(String(b.id)));
    const counts: Record<string, number> = {};
    for (const e of await this.r.allEvents()) if (e.goal === CG || e.payload?.goal === CG) counts[e.type] = (counts[e.type] ?? 0) + 1;
    return { steps, counts, plans: ((view.plans ?? []) as Json[]).length };
  }

  // ---- RL-10 additions (docs/specs/RL-10.md): retarget, release, finish, revert, live-step reads ----

  /** `POST /v1/items/retarget` as `who`. */
  retarget(who: Person | string, body: Record<string, unknown>) {
    return this.call(who, "POST", "/v1/items/retarget", body);
  }
  /** `retarget` expecting 200; returns the `RetargetResult`. */
  async retargetOk(who: Person | string, body: Record<string, unknown>): Promise<Json> {
    const res = await this.retarget(who, body);
    expect(res.status, `retarget ${JSON.stringify(body)}: ${JSON.stringify(res.json)}`).toBe(200);
    await this.w.flush();
    return res.json;
  }
  /** `p` releases `id` through the route (200). */
  async release(p: Person | string, id: string): Promise<void> {
    const res = await this.r.act(p, id, "release", {});
    expect(res.status, `release ${id}: ${JSON.stringify(res.json)}`).toBe(200);
    await this.w.flush();
  }
  /** `p` claims and finishes `id` (done) through the routes: a step in a target-only repo has no checkout. */
  async finish(p: Person | string, id: string): Promise<void> {
    const c = await this.r.act(p, id, "claim", {});
    expect(c.status, `claim ${id}: ${JSON.stringify(c.json)}`).toBe(200);
    const d = await this.r.act(p, id, "done", { outcome: "done", summary: "fixed" });
    expect(d.status, `done ${id}: ${JSON.stringify(d.json)}`).toBe(200);
    await this.w.flush();
  }
  /** ann reverts the disposition of `f` recorded in debrief step `D` (200). */
  async revertD(D: string, f: string): Promise<void> {
    const rv = await this.call(this.ann, "POST", `/v1/steps/${D}/dispositions/revert`, { fingerprint: f });
    expect(rv.status, `revert ${f} in ${D}: ${JSON.stringify(rv.json)}`).toBe(200);
    await this.w.flush();
  }
  /** ann holds the debrief step of `R` and dismisses `f` with `mesh_dispose`; returns the debrief id. */
  async debriefDismiss(R: Run, f: string): Promise<string> {
    const D = R.s("debrief");
    const pid = await this.hold(this.ann, D);
    await this.toolOk(this.ann, pid, "mesh_dispose", { fingerprint: f, disposition: "dismissed", reason: `R-${f}`, answer: `ANS-${f}` });
    return D;
  }
  /** Every finding step of `(lineage, f)` over every clean-audit goal (any topic, dropped goals and moved-away steps included), full ids sorted. */
  async allFor(f: string, lineage = LIN()): Promise<string[]> {
    const out: string[] = [];
    for (const g of await this.goals()) {
      if (!g.sink) continue;
      for (const s of await this.fsteps(g.id as string)) if (s.finding?.lineage === lineage && s.finding?.fp === f) out.push(s.id as string);
    }
    return out.sort();
  }
  /** The live finding steps of `(lineage, f)` of `topic` that are not closed (no `movedTo`, goal not dropped, state not done/skipped/dropped), sorted. */
  async liveOpen(f: string, lineage = LIN(), topic = "ci"): Promise<string[]> {
    const out: string[] = [];
    for (const g of await this.goals()) {
      if (!g.sink || g.sink.topic !== topic || g.state === "dropped") continue;
      for (const s of await this.fsteps(g.id as string)) {
        if (s.finding?.lineage !== lineage || s.finding?.fp !== f) continue;
        const full = await this.step(s.id as string);
        if (full.movedTo === undefined && !["done", "skipped", "dropped"].includes(full.state as string)) out.push(s.id as string);
      }
    }
    return out.sort();
  }
  /** The single `step.dropped` event of `fromId` with reason `moved` (undefined when none; never two). */
  async moveOf(fromId: string): Promise<Json | undefined> {
    const xs = await this.ev("step.dropped", (e) => e.step === fromId && e.payload?.reason === "moved");
    expect(xs.length, `at most one move of ${fromId}`).toBeLessThanOrEqual(1);
    return xs[0];
  }
  /** The fp of the item of `lineage` whose stored rule is `other:<rule>` (for keys whose fp the test cannot compute). */
  async fpByRule(rule: string, lineage = LIN()): Promise<string> {
    const xs = (await this.items(lineage)).filter((x) => (x.rule ?? x.key?.rule) === `other:${rule}`);
    expect(xs, `one item with rule other:${rule}`).toHaveLength(1);
    return xs[0].fp as string;
  }
  /** What "nothing written" compares: every clean-audit goal's snapshot, the lineage's item rows, event counts by type. */
  async world(lineage = LIN()): Promise<Json> {
    const goals: Record<string, Json> = {};
    for (const g of (await this.goals()).filter((x) => x.sink)) goals[g.id as string] = { state: g.state, sink: g.sink, ownerId: g.ownerId, ...(await this.snapshot(g.id as string)) };
    const items = (await this.items(lineage))
      .map((x) => ({ fp: x.fp, state: x.state, repo: x.repo, history: ((x.history ?? []) as Json[]).length }))
      .sort((a, b) => String(a.fp).localeCompare(String(b.fp)));
    const events: Record<string, number> = {};
    for (const e of await this.r.allEvents()) events[e.type] = (events[e.type] ?? 0) + 1;
    return { goals, items, events };
  }
}

export interface OrderWorld {
  ids: string[];
  /** The plain goal's step. */
  P: string;
  CG: string;
  x: Record<"x1" | "x2" | "x3" | "x4", string>;
}

/**
 * AC-13: a plain goal P (one ready step `s`) made first, so its step comes before the clean-audit
 * goal's in the ready list; then G1 files X3 (sev[0]); then a later run files X1, X2, X4 (sev[1..3])
 * in one record; X4's step offered to bob's machine. Every relay step is done. `ids`: bob's ready list.
 */
export async function orderSetup(s: Sk, sev: [string, string, string, string]): Promise<OrderWorld> {
  const P = await s.r.goal(s.ann, [{ id: "s", repo: REPO }]);
  const X3 = item("x3", { severity: sev[0], title: "T-X3" });
  const X1 = item("x1", { severity: sev[1], title: "T-X1" });
  const X2 = item("x2", { severity: sev[2], title: "T-X2" });
  const X4 = item("x4", { severity: sev[3], title: "T-X4" });
  const G1 = await s.run();
  await s.raise(G1, [X3]);
  await s.file(G1, [acc(fpR("x3"))]);
  const G2 = await s.run();
  await s.raise(G2, [X3, X1, X2, X4]);
  await s.file(G2, [acc(fpR("x1")), acc(fpR("x2")), acc(fpR("x4"))]);
  const CG = await s.CG();
  const x = { x1: s.fs(CG, fpR("x1")), x2: s.fs(CG, fpR("x2")), x3: s.fs(CG, fpR("x3")), x4: s.fs(CG, fpR("x4")) };
  await s.r.nick(s.bob, "bob-box");
  const off = await s.r.assign(s.ann, x.x4, { to: "bob/bob-box" });
  expect(off.status, JSON.stringify(off.json)).toBe(200);
  const res = await s.call(s.bob, "GET", "/v1/steps?ready=1");
  expect(res.status).toBe(200);
  return { ids: (res.json.steps as Json[]).map((t) => t.id as string), P: `${P}.s`, CG, x };
}

export { disp, fpOf, item };
export type { Json, Person, PlanIn };

// ---- RL-10 additions (docs/specs/RL-10.md): target repos ------------------------------------------

/** Repos used only as targets (no checkout, no daemon). */
export const X = "x";
export const Y = "y";
/** An item with a target repo (`repo` is not part of the key). */
export const IR = <T extends object>(it: T, repo: string): T & { repo: string } => ({ ...it, repo });
/** The documented title of the clean-audit goal of a single-segment repo. */
export const TITLE = (repo: string, topic = "ci") => `Clean audits: ${topic} on ${repo}`;
/** `item(rule, o)` with a key that has no `path` (a symbol instead). */
export const noPath = (rule: string, o: Parameters<typeof item>[1] = {}) => ({ ...item(rule, o), key: { rule, symbol: `s-${rule}` } });
export const IG = item("rg", { title: "T-G" });
export const IM = item("rm", { title: "T-M" });
export const IN = item("rn", { title: "T-N" });
export const fG = fpR("rg");
export const fM = fpR("rm");
export const fN = fpR("rn");
/** A debrief stage that consumes `accepted` and may set `dismissed` (the RL-9 AC-07b shape). */
export const DEBRIEF_DISMISS = DEBRIEF({ consumes: ["accepted"], may_set: ["dismissed"] });

/**
 * AC-06b / AC-06c setup: G1 files D (no repo) → `rD` in the `r` goal; `retarget(fD, "x")` moves it
 * to `xD`; bob finishes `xD` (done); a later run G2 raises D with `repo: r` (fold: target x → r,
 * nothing open to move), then (unless `fileD: false`) G2's `file` refiles D.
 */
export async function revived(k: Sk, retarget: (f: string, repo: string) => Promise<unknown>, o: { fileD?: boolean } = {}) {
  const G1 = await k.run();
  await k.raise(G1, [ID]);
  await k.file(G1, [acc(fD)]);
  const Gr = await k.CG(REPO);
  const rD = k.fs(Gr, fD);
  const notes0 = await k.notes(rD);
  await retarget(fD, X);
  const Gx = await k.CG(X);
  const xD = k.fs(Gx, fD);
  expect((await k.step(xD)).state, "control: D moved to x").toBe("ready");
  expect((await k.step(rD)).movedTo, "control: rD moved away").toBe(xD);
  k.tick();
  await k.finish(k.bob, xD);
  expect((await k.step(xD)).state, "control: xD done").toBe("done");
  k.tick();
  const G2 = await k.run();
  await k.raise(G2, [IR(ID, REPO)]);
  expect((await k.item(fD)).repo, "control: the fold set D's target back to r").toBe(REPO);
  expect((await k.step(rD)).movedTo, "control: nothing moved by the fold (xD closed)").toBe(xD);
  if (o.fileD !== false) await k.file(G2, [acc(fD)]);
  else await k.file(G2, []);
  return { G1, G2, Gr, Gx, rD, xD, notes0 };
}
