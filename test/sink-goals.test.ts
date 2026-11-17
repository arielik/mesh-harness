// RL-9 World tests: a clean-audit goal stands (never done, refuses plans), the ready order by
// severity within a goal, `POST /v1/goals/:id/drop`, and the backfill route `POST /v1/items/sink`.
// Criteria AC-08, AC-13, AC-14, AC-15 (routes; the CLI sides are in test/sink-cli.test.ts). Written
// from the spec's contracts only (docs/specs/RL-9.md) and the test plan.

import { afterEach, describe, expect, it } from "vitest";
import { Ck, KEY, HA } from "./helpers/calib-kit.ts";
import { body, Pk } from "./helpers/pulse-kit.ts";
import { acc, AUDIT, CLEAN_TEXT, fA, fB, fC, FILE, fpR, IA, IB, IC, ID, fD, fid, item, LIN, orderSetup, Sk, type Json, type OrderWorld, type Run } from "./helpers/sink-kit.ts";

let k: Sk | undefined;
const stops: (() => Promise<void>)[] = [];
afterEach(async () => {
  await k?.stop();
  k = undefined;
  for (const s of stops.splice(0)) await s();
});
const K = () => k as Sk;

async function filed(items = [IA, IB], disps = [acc(fA), acc(fB)]): Promise<{ G1: Run; CG: string }> {
  k = await Sk.start();
  const G1 = await k.run();
  await k.raise(G1, items);
  await k.file(G1, disps);
  return { G1, CG: await k.CG() };
}

// =============================================================================================
// AC-08 Standing goal
// =============================================================================================

describe("RL-9 AC-08 standing", { timeout: 60_000 }, () => {
  it("test_AC08_never_done", async () => {
    const { CG } = await filed();
    const ida = K().fs(CG, fA);
    const idb = K().fs(CG, fB);
    await K().doStep(K().bob, ida);
    const G2 = await K().run();
    await K().raise(G2, [IA]);
    // Control: both paths ran.
    expect((await K().step(ida)).state).toBe("done");
    expect(await K().step(idb)).toMatchObject({ state: "done", summary: `resolved by ${G2.audit}` });
    expect((await K().fsteps(CG)).every((s) => s.state === "done")).toBe(true);
    expect((await K().goalView(CG)).goal.state).toBe("in_progress");
    expect(await K().ev("goal.done", (e) => e.goal === CG)).toStrictEqual([]);
  });

  it("test_AC08_plan_refused_route", async () => {
    const { CG } = await filed();
    const valid = [{ id: "fix", repo: "r", kind: "implement", title: "Fix", brief: "b", deps: [] }];
    const invalid = [{ id: "fix", repo: "r", kind: "implement", title: "Fix", brief: "b", deps: ["nope"] }];
    // Control: the invalid plan is a validation error on a plain goal.
    const P = await K().r.goal(K().ann);
    const pc = await K().call(K().ann, "POST", `/v1/goals/${P}/plan`, { steps: invalid, approve: true });
    expect(pc.status, JSON.stringify(pc.json)).not.toBe(201);
    expect(pc.status).not.toBe(409);
    for (const steps of [valid, invalid]) {
      const res = await K().call(K().ann, "POST", `/v1/goals/${CG}/plan`, { steps, approve: true });
      expect(res.status, JSON.stringify(res.json)).toBe(409);
      expect(res.json).toStrictEqual({ error: CLEAN_TEXT(CG) });
    }
    expect(((await K().goalView(CG)).plans as Json[]).length).toBe(1);
  });
});

// =============================================================================================
// AC-13 Ready order
// =============================================================================================

/** AC-13 world in a fresh Sk (kept in `k` for afterEach). */
async function orderWorld(sev: [string, string, string, string]): Promise<OrderWorld> {
  k = await Sk.start();
  return orderSetup(k, sev);
}

describe("RL-9 AC-13 ready order", { timeout: 90_000 }, () => {
  it("test_AC13_control_same_severity", async () => {
    const { ids, P, x } = await orderWorld(["S3", "S3", "S3", "S3"]);
    expect(ids[0], "the offered step first").toBe(x.x4);
    expect([...ids].sort()).toStrictEqual([P, x.x1, x.x2, x.x3, x.x4].sort());
    // P's step lies before the finding steps, so a sort across goals would move it.
    const firstFinding = Math.min(...[x.x1, x.x2, x.x3].map((id) => ids.indexOf(id)));
    expect(ids.indexOf(P)).toBeLessThan(firstFinding);
  });

  it("test_AC13_severity_within_goal", async () => {
    const control = await orderWorld(["S3", "S3", "S3", "S3"]);
    const base = control.ids;
    await K().stop();
    k = undefined;
    const main = await orderWorld(["S3", "S1", "S2", "S4"]);
    const { ids, x, P } = main;
    // Same fps → same finding ids; same creation order → same goal ids.
    expect(main.x).toStrictEqual(control.x);
    expect(ids[0]).toBe(x.x4);
    const findings = new Set([x.x1, x.x2, x.x3]);
    const refill = [x.x1, x.x2, x.x3];
    const want = base.slice(1).map((id) => (findings.has(id) ? (refill.shift() as string) : id));
    expect(ids.slice(1)).toStrictEqual(want);
    expect(ids.indexOf(P)).toBe(base.indexOf(P));
  });
});

// =============================================================================================
// AC-14 Goal drop
// =============================================================================================

describe("RL-9 AC-14 goal drop", { timeout: 90_000 }, () => {
  it("test_AC14_drop_clean_audit_goal", async () => {
    const { CG } = await filed([IA, IB, IC], [acc(fA), acc(fB, { requires: [fC] }), acc(fC)]);
    const s = K();
    const [ida, idb, idc] = [fA, fB, fC].map((f) => s.fs(CG, f)) as [string, string, string];
    await s.patchStep(idc, { state: "parked" });
    await s.r.nick(s.bob, "bob-box");
    expect((await s.r.assign(s.ann, ida, { to: "bob/bob-box" })).status).toBe(200);
    expect((await s.step(idb)).state, "control: B blocked").toBe("blocked");
    const res = await s.call(s.ann, "POST", `/v1/goals/${CG}/drop`, { reason: "done with it" });
    expect(res.status, JSON.stringify(res.json)).toBe(200);
    expect((await s.goalView(CG)).goal.state).toBe("dropped");
    for (const id of [ida, idb, idc]) expect((await s.step(id)).state, id).toBe("dropped");
    expect((await s.step(ida)).offer?.state).toBe("withdrawn");
    const gd = await s.ev("goal.dropped", (e) => e.goal === CG);
    expect(gd).toHaveLength(1);
    expect(gd[0].payload).toMatchObject({ reason: "person", by: "ann", comment: "done with it" });
    expect((await s.ev("step.dropped", (e) => e.goal === CG)).map((e) => e.step).sort()).toStrictEqual([ida, idb, idc].sort());
    // A later sink opens a new goal.
    const G2 = await s.run();
    await s.raise(G2, [IA, IB, IC, ID]);
    await s.file(G2, [acc(fD)]);
    const ng = await s.cag();
    expect(ng, "a new clean-audit goal").toBeDefined();
    expect(ng.id).not.toBe(CG);
    expect(ng.title).toBe("Clean audits: ci on r");
    expect(ng.sink).toStrictEqual({ repo: "r", topic: "ci" });
    expect((await s.fsteps(ng.id)).map((x) => x.id)).toStrictEqual([s.fs(ng.id, fD)]);
    expect((await s.fsteps(CG)).map((x) => x.id).sort()).toStrictEqual([ida, idb, idc].sort());
    expect(await s.cagAll()).toHaveLength(2);
  });

  it("test_AC14_refusals", async () => {
    const { G1, CG } = await filed([IA, IB, IC], [acc(fA), acc(fB), acc(fC)]);
    const s = K();
    const [ida, idb] = [fA, fB].map((f) => s.fs(CG, f)) as [string, string];
    await s.hold(s.bob, ida);
    expect(await s.call(s.ann, "POST", `/v1/goals/${CG}/drop`, {})).toStrictEqual({ status: 409, json: { error: `${CG} has held steps: ${ida}; release them first` } });
    expect((await s.r.act(s.bob, ida, "release", {})).status).toBe(200);
    await s.patchStep(idb, { state: "paused" });
    const paused = await s.call(s.ann, "POST", `/v1/goals/${CG}/drop`, {});
    expect(paused.status).toBe(409);
    expect(paused.json.error).toContain(idb);
    await s.patchStep(idb, { state: "ready" });
    expect((await s.call(s.carol, "POST", `/v1/goals/${CG}/drop`, {})).status).toBe(403);
    expect((await s.call(s.ann, "POST", "/v1/goals/G999/drop", {})).status).toBe(404);
    // An admin may drop another member's goal (control).
    const P = await s.r.goal(s.ann, [{ id: "s", repo: "r" }]);
    expect((await s.call(s.root, "POST", `/v1/goals/${P}/drop`, {})).status).toBe(200);
    expect((await s.goalView(P)).goal.state).toBe("dropped");
    // After the release: the owner drops it.
    expect((await s.call(s.ann, "POST", `/v1/goals/${CG}/drop`, {})).status).toBe(200);
    expect(await s.call(s.ann, "POST", `/v1/goals/${CG}/drop`, {})).toStrictEqual({ status: 409, json: { error: `${CG} is dropped` } });
    expect((await s.goalView(G1.G)).goal.state).toBe("done");
    expect(await s.call(s.ann, "POST", `/v1/goals/${G1.G}/drop`, {})).toStrictEqual({ status: 409, json: { error: `${G1.G} is done` } });
  });

  it("test_AC14_pulse_goal", async () => {
    const p = await Pk.start();
    stops.push(() => p.stop());
    await p.pulseOk("ann", body({ overlap: "skip" }));
    const first = await p.fireOk("ann", "p-1");
    const G = first.goal as string;
    expect(typeof G).toBe("string");
    const slotsBefore = await p.slotsOf("p-1");
    const res = await p.call("ann", "POST", `/v1/goals/${G}/drop`, {});
    expect(res.status, JSON.stringify(res.json)).toBe(200);
    expect(await p.goalState(G)).toBe("dropped");
    expect(await p.slotsOf("p-1")).toStrictEqual(slotsBefore);
    const gd = await p.eventsOfGoal("goal.dropped", G);
    expect(gd).toHaveLength(1);
    expect(gd[0].payload).toMatchObject({ reason: "person", by: "ann" });
    // The overlap rule sees no open goal: the next fire opens a new one.
    p.at(p.w.clock + 60_000);
    const second = await p.fireOk("ann", "p-1");
    expect(second.state).toBe("fired");
    expect(typeof second.goal).toBe("string");
    expect(second.goal).not.toBe(G);
  });

  it("test_AC14_calibration_goal", async () => {
    const c = await Ck.start({ threshold: 2 });
    stops.push(() => c.stop());
    await c.dismissOne(c.c.ann, "X1");
    await c.dismissOne(c.c.ann, "X2");
    const cs = await c.calibOf(KEY, HA);
    expect(cs).toHaveLength(1);
    const C = cs[0].id as string;
    const owner = cs[0].ownerId === "ann" ? c.c.ann : c.c.bob;
    expect(await c.hashStats(KEY, HA)).toMatchObject({ calibrating: 2, uncalibrated: 0 });
    const res = await c.r.call(owner, "POST", `/v1/goals/${C}/drop`, {});
    expect(res.status, JSON.stringify(res.json)).toBe(200);
    expect(await c.k.goalState(owner, C)).toBe("dropped");
    expect(await c.hashStats(KEY, HA)).toMatchObject({ calibrating: 0, uncalibrated: 2 });
  });
});

// =============================================================================================
// AC-15 Backfill (route)
// =============================================================================================

describe("RL-9 AC-15 backfill", { timeout: 90_000 }, () => {
  const P1 = item("p1", { severity: "S1", title: "T-P1" });
  const P2 = item("p2", { severity: "S2", title: "T-P2" });
  const P4 = item("p4", { severity: "S4", title: "T-P4" });
  const [f1, f2, f4] = [fpR("p1"), fpR("p2"), fpR("p4")];
  const L = LIN("plain");
  const PLAIN = [AUDIT, FILE({ sink: undefined })];

  /** A lineage `plain|r|audit` with three filed items (S1 requiring S2, S2, S4) and no clean-audit goal. */
  async function plain(): Promise<Sk> {
    k = await Sk.start();
    const R = await k.run({ preset: "plain", steps: PLAIN });
    await k.raise(R, [P1, P2, P4]);
    await k.file(R, [acc(f1, { requires: [f2] }), acc(f2), acc(f4)]);
    expect((await k.items(L)).filter((x) => x.state === "accepted" && x.link).length, "control: three filed items").toBe(3);
    expect(await k.cag()).toBeUndefined();
    return k;
  }
  const sink = (s: Sk, who: Json, b: Record<string, unknown> = {}) => s.call(who, "POST", "/v1/items/sink", { lineage: L, topic: "ci", ...b });

  it("test_AC15_dry_run", async () => {
    const s = await plain();
    const before = { created: (await s.ev("goal.created")).length, sunk: (await s.ev("goal.sunk")).length };
    const res = await sink(s, s.ann, { min_severity: "S2", dry_run: true });
    expect(res.status, JSON.stringify(res.json)).toBe(200);
    expect(res.json.goal).toBeNull();
    // No goal yet: each id ends with the documented local id (`<G>.` prefix or none).
    const added = res.json.added as string[];
    expect(added).toHaveLength(2);
    for (const f of [f1, f2]) expect(added.filter((id) => id === fid(L, f) || id.endsWith(`.${fid(L, f)}`)), f).toHaveLength(1);
    expect(res.json.reopened).toStrictEqual([]);
    expect(typeof res.json.skipped).toBe("number");
    expect(Array.isArray(res.json.notes)).toBe(true);
    expect(await s.cag()).toBeUndefined();
    expect({ created: (await s.ev("goal.created")).length, sunk: (await s.ev("goal.sunk")).length }).toStrictEqual(before);
  });

  it("test_AC15_apply_and_idempotent", async () => {
    const s = await plain();
    const res = await sink(s, s.ann, { min_severity: "S2" });
    expect(res.status, JSON.stringify(res.json)).toBe(200);
    const CG = await s.CG();
    expect(res.json.goal).toBe(CG);
    expect([...res.json.added].sort()).toStrictEqual([s.fs(CG, f1, L), s.fs(CG, f2, L)].sort());
    expect(res.json.reopened).toStrictEqual([]);
    expect((await s.goalView(CG)).goal.ownerId).toBe("ann");
    const fs = await s.fsteps(CG);
    expect(fs.map((x) => x.id).sort()).toStrictEqual([s.fs(CG, f1, L), s.fs(CG, f2, L)].sort());
    for (const x of fs) expect(x.deps, `${x.id} has no deps`).toStrictEqual([]);
    const again = await sink(s, s.ann, { min_severity: "S2" });
    expect(again.status).toBe(200);
    expect(again.json).toMatchObject({ goal: CG, added: [], reopened: [] });
    expect(await s.fsteps(CG)).toHaveLength(2);
    // P1's step done by a person → a backfill leaves it done: nothing was filed after it closed (rule 3).
    s.tick();
    await s.doStep(s.ann, s.fs(CG, f1, L));
    s.tick();
    const third = await sink(s, s.ann, { min_severity: "S2" });
    expect(third.status, JSON.stringify(third.json)).toBe(200);
    expect(third.json).toMatchObject({ goal: CG, added: [], reopened: [] });
    expect((await s.step(s.fs(CG, f1, L))).state).toBe("done");
    // Control: P2's step is still ready.
    expect((await s.step(s.fs(CG, f2, L))).state).toBe("ready");
  });

  it("test_AC15_who", async () => {
    const s = await plain();
    const no = await sink(s, s.carol);
    expect(no.status, JSON.stringify(no.json)).toBe(403);
    expect(await s.cag()).toBeUndefined();
    const bad = await sink(s, s.ann, { topic: "nope" });
    expect(bad).toStrictEqual({ status: 400, json: expect.objectContaining({ error: "unknown topic nope (define with: mesh topic add <name>)" }) });
    // bob owns the lineage's newest goal.
    const R2 = await s.run({ preset: "plain", steps: PLAIN, owner: s.bob });
    await s.raise(R2, [P1, P2, P4], { who: s.bob });
    const byBob = await sink(s, s.bob, { min_severity: "S2" });
    expect(byBob.status, JSON.stringify(byBob.json)).toBe(200);
    const CG = await s.CG();
    expect((await s.goalView(CG)).goal.ownerId, "a new goal's owner is the caller").toBe("bob");
    // An admin (control).
    const byRoot = await sink(s, s.root);
    expect(byRoot.status, JSON.stringify(byRoot.json)).toBe(200);
    expect(byRoot.json.added).toStrictEqual([s.fs(CG, f4, L)]);
  });
});
