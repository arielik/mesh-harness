// RL-6 test kit: calibration and agent statistics through the hub (World), built on the RL-2 review
// kit (`Rk`) and, for catalog sources and pulses, the RL-3/RL-5 kits on the same `Relay`. Written from
// the spec's contracts only (docs/specs/RL-6.md). Goals are found by id or by `calibration.key/hash`,
// items by fingerprint, events by type (+ goal), stats entries by hash.
//
// Every count a test asserts is computed by the test from its own fixture; time comes from `w.clock`,
// set before each action whose time is asserted.

import { createHash } from "node:crypto";
import { expect } from "vitest";
import type { PlanIn } from "./relay-kit.ts";
import { ALPHA, disp, fpOf, item, NOV19, rec, Rk, S, type RCast } from "./review-kit.ts";
import { Pk } from "./pulse-kit.ts";
import { Rk as RosterRk } from "./roster-kit.ts";
import type { Json, Person } from "./world.ts";

export const sha = (s: string) => createHash("sha256").update(s, "utf8").digest("hex");
export const KEY = "alpha/auditor";
export const CHECK = "alpha/checker";
export const HA = sha("auditor-a");
export const HB = sha("auditor-b");
export const HZ = sha("auditor-z");
export const V = sha("checker-v");
export const h12 = (h: string) => h.slice(0, 12);
export const enc = encodeURIComponent;
export const DAY = 86_400_000;

/** A complete RL-1 telemetry literal (the fields of `test/relay-hub.test.ts`'s `T`) for an agent run. */
export function tel(o: { runId: string; agentKey: string; agentHash?: string; durationMs: number; costUsdEstimate?: number }): Json {
  return {
    runId: o.runId,
    model: "m-x",
    agentKey: o.agentKey,
    ...(o.agentHash !== undefined ? { agentHash: o.agentHash } : {}),
    profile: "read-only",
    profileHash: "f".repeat(64),
    turns: 3,
    turnsApprox: false,
    tokensIn: 10,
    tokensOut: 20,
    cacheRead: 0,
    cacheWrite: 0,
    ...(o.costUsdEstimate !== undefined ? { costUsdEstimate: o.costUsdEstimate } : {}),
    durationMs: o.durationMs,
    exit: "success",
    permissionDenials: { count: 0, tools: [] },
    undeclaredRules: 0,
    redactions: 0,
  };
}

/** Plan steps (repo /src/alpha, lineage `-|/src/alpha|auditor` for `audit`). */
export const P = {
  audit: (over: Record<string, unknown> = {}): PlanIn => S.audit(over),
  validate: (over: Record<string, unknown> = {}): PlanIn => S.validate(over),
  /** A person's debrief (mode debrief, assignee = owner). */
  debrief: (over: Record<string, unknown> = {}): PlanIn => ({ id: "debrief", repo: ALPHA, kind: "review", deps: ["validate"], mode: "debrief", output: "review-record", may_set: ["accepted", "dismissed"], ...over }),
  /** A headless step without output: a run that only carries telemetry. */
  run: (id = "run", over: Record<string, unknown> = {}): PlanIn => ({ id, repo: ALPHA, mode: "headless", agent: "auditor", ...over }),
};

export interface CCast extends RCast {
  carol: string;
}

export class Ck {
  readonly k: Rk;
  readonly c: CCast;
  private pk?: Pk;
  private roster?: RosterRk;

  constructor(k: Rk, c: CCast) {
    this.k = k;
    this.c = c;
  }

  /** ann, bob (daemons, share `me`), carol (login), root (admin); `threshold` omitted → no `calibration` key. */
  static async start(o: { threshold?: number; clock?: number } = {}): Promise<Ck> {
    const hubYaml: Record<string, unknown> = { auth: { session: { device_max_age: "60d", device_idle: "30d" } } };
    if (o.threshold !== undefined) hubYaml.calibration = { threshold: o.threshold };
    const { k, c } = await Rk.start({ hubYaml, clock: o.clock ?? NOV19 });
    const carol = (await k.r.w.login("carol", { hostname: "carol-box" })).token;
    return new Ck(k, { ...c, carol });
  }

  get r() {
    return this.k.r;
  }
  get w() {
    return this.k.r.w;
  }
  async stop(): Promise<void> {
    await this.r.stop();
  }
  tick(ms = 1_000): number {
    this.w.clock += ms;
    return this.w.clock;
  }
  at(ms: number): void {
    this.w.clock = ms;
  }
  token(who: Person | string): string {
    return typeof who === "string" ? who : who.login.token;
  }

  // ---- goals and records ----------------------------------------------------------------------

  goal(owner: Person | string, steps: PlanIn[]): Promise<string> {
    return this.k.goal(owner, steps);
  }

  /** Claim `id`, submit a raising record of `items` by `agent`, close it done; returns the ReviewResult. */
  raise(who: Person | string, id: string, items: unknown[], agent: { key: string; hash?: string } | null = { key: KEY, hash: HA }, extra: Record<string, unknown> = {}): Promise<Json> {
    return this.k.submit(who, id, rec({ items, ...(agent ? { agent } : {}), ...extra }));
  }

  /** Claim `id`, submit a consuming record with `dispositions` by `agent`, close it done. */
  agentDispose(who: Person | string, id: string, dispositions: unknown[], agent: { key: string; hash?: string } = { key: CHECK, hash: V }): Promise<Json> {
    return this.k.submit(who, id, rec({ dispositions, agent }));
  }

  /** A person's disposition on a held debrief (`POST /v1/steps/:id/dispositions`, as `mesh_dispose`). */
  async personDispose(who: Person | string, id: string, fp: string, disposition: string, extra: Record<string, unknown> = {}): Promise<Json> {
    const res = await this.r.call(who, "POST", `/v1/steps/${id}/dispositions`, { fingerprint: fp, disposition, reason: `R-${fp}`, answer: `ANS-${fp}`, ...extra });
    expect(res.status, `dispose ${fp} on ${id}: ${JSON.stringify(res.json)}`).toBe(201);
    return res.json;
  }

  /** RL-4 revert of a debrief disposition, expecting 200. */
  async revert(who: Person | string, id: string, fp: string): Promise<Json> {
    const res = await this.r.call(who, "POST", `/v1/steps/${id}/dispositions/revert`, { fingerprint: fp });
    expect(res.status, `revert ${fp} on ${id}: ${JSON.stringify(res.json)}`).toBe(200);
    return res.json;
  }

  /** A full one-item goal: audit by KEY@`hash` raises `rule`, validate (CHECK@V) dismisses it. */
  async dismissOne(owner: Person, rule: string, o: { hash?: string; itemOpts?: Record<string, unknown>; reason?: string } = {}): Promise<{ G: string; fp: string; at: number }> {
    const G = await this.goal(owner, [P.audit(), P.validate()]);
    this.tick();
    await this.raise(owner, `${G}.audit`, [item(rule, o.itemOpts ?? {})], { key: KEY, hash: o.hash ?? HA });
    const at = this.tick();
    const f = fpOf(rule, (o.itemOpts?.path as string | undefined) ?? "src/a.ts", (o.itemOpts?.symbol as string | undefined) ?? "");
    await this.agentDispose(owner, `${G}.validate`, [disp(f, "dismissed", { reason: o.reason ?? `no ${rule}` })]);
    return { G, fp: f, at };
  }

  /** Claim `id`, close it with `outcome`, then report the finished run of round 1 with `telemetry`. */
  async run(who: Person | string, id: string, telemetry: Json, outcome: "done" | "fail" = "done"): Promise<number> {
    await this.k.claim(who, id);
    const d = await this.k.close(who, id, { outcome, summary: "ok" });
    expect(d.status, `close ${id}: ${JSON.stringify(d.json)}`).toBe(200);
    const f = await this.r.call(who, "POST", `/v1/steps/${id}/run`, { state: "finished", runId: telemetry.runId, round: 1, telemetry });
    expect(f.status, `run ${id}: ${JSON.stringify(f.json)}`).toBe(200);
    const st = await this.r.stepOf(id);
    const round = (st.rounds as Json[])[0];
    expect(round.outcome, `round outcome of ${id}`).toBe(outcome);
    expect(round.telemetry, `telemetry of ${id}`).toStrictEqual(telemetry);
    return round.finishedAt as number;
  }

  // ---- reads ----------------------------------------------------------------------------------

  async stats(key: string, query = "", who: Person | string = this.c.ann): Promise<Json> {
    const res = await this.r.call(who, "GET", `/v1/agents/${enc(key)}/stats${query}`);
    expect(res.status, `stats ${key}${query}: ${JSON.stringify(res.json)}`).toBe(200);
    expect(Array.isArray(res.json?.hashes), `stats ${key}${query} is an AgentStats reply: ${String(JSON.stringify(res.json)).slice(0, 200)}`).toBe(true);
    return res.json;
  }
  hashOf(s: Json, h: string): Json | undefined {
    return (s.hashes as Json[]).find((x) => x.hash === h);
  }
  async hashStats(key: string, h: string, query = ""): Promise<Json> {
    const e = this.hashOf(await this.stats(key, query), h);
    expect(e, `stats entry ${key}@${h12(h)}`).toBeDefined();
    return e;
  }

  async goals(who: Person | string = this.c.ann, query = ""): Promise<Json[]> {
    const res = await this.r.call(who, "GET", `/v1/goals${query}`);
    expect(res.status, JSON.stringify(res.json)).toBe(200);
    return res.json.goals;
  }
  /** Every calibration goal (read through `GET /v1/goals?pulses=1` so no goal is hidden). */
  async calibGoals(): Promise<Json[]> {
    const all = new Map<string, Json>();
    for (const q of ["", "?pulses=1"]) for (const g of await this.goals(this.c.ann, q)) if (g.calibration) all.set(g.id, g);
    return [...all.values()];
  }
  async calibOf(key: string, hash: string): Promise<Json[]> {
    return (await this.calibGoals()).filter((g) => g.calibration.key === key && g.calibration.hash === hash);
  }
  async goalView(G: string, who: Person | string = this.c.ann): Promise<Json> {
    const res = await this.r.call(who, "GET", `/v1/goals/${G}`);
    expect(res.status, JSON.stringify(res.json)).toBe(200);
    return res.json;
  }
  async timeline(G: string): Promise<string[]> {
    const res = await this.r.call(this.c.ann, "GET", `/v1/goals/${G}/timeline`);
    expect(res.status, JSON.stringify(res.json)).toBe(200);
    return (res.json.timeline as Json[]).map((t) => t.text as string);
  }
  async ev(type: string, goal?: string): Promise<Json[]> {
    return (await this.r.allEvents()).filter((e) => e.type === type && (goal === undefined || e.goal === goal));
  }
  async calEvents(): Promise<Json[]> {
    return (await this.r.allEvents()).filter((e) => typeof e.type === "string" && e.type.startsWith("calibration."));
  }
  async item(f: string, lineage: string): Promise<Json> {
    return this.k.itemOf(this.c.ann, f, lineage);
  }
  /** The latest history entry of kind `disposition` of an item. */
  async lastDisposition(f: string, lineage: string): Promise<Json> {
    const h = ((await this.item(f, lineage)).history as Json[]).filter((e) => e.kind === "disposition");
    return h[h.length - 1];
  }

  // ---- catalog and pulses (same hub) ----------------------------------------------------------

  pulses(): Pk {
    if (!this.pk) {
      this.pk = new Pk(this.r);
      this.pk.tok = { ann: this.c.ann.login.token, bob: this.c.bob.login.token, carol: this.c.carol, root: this.c.root };
    }
    return this.pk;
  }
  catalog(): RosterRk {
    if (!this.roster) this.roster = new RosterRk(this.pulses());
    return this.roster;
  }
}

export { ALPHA, disp, fpOf, item, NOV19, rec };
