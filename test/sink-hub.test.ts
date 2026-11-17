// RL-9 World tests: sink stages open the clean-audit goal and add finding steps; later runs, two
// lineages, deps from `requires`, the item → step sync (resolved, refiled, dismissed, deferred,
// revert), a skipped sink stage, a sink failure, truncation, no reopen without a newer filing, the
// gate and resume settle paths. Criteria AC-01 … AC-07, AC-09, AC-10, AC-12, AC-20, AC-21. Written from the spec's contracts only (docs/specs/RL-9.md) and the test plan
// (docs/specs/plans/RL-9-test-plan.md). Expected finding-step ids come from the test-side formula
// (`fid`). Steps by id, items by fp, goals by `sink`, events by type + payload `from`.

import { afterEach, describe, expect, it } from "vitest";
import {
  acc,
  AUDIT,
  DAY_MS,
  DEBRIEF,
  disp,
  fA,
  fB,
  fC,
  fD,
  fE,
  fF,
  FILE,
  fpOf,
  GATE,
  fpR,
  IA,
  IB,
  IC,
  ID,
  IE,
  IF,
  item,
  LAST,
  LIN,
  LINK,
  NOV19,
  recArgs,
  Sk,
  TRIAGE,
  type Json,
  type Run,
} from "./helpers/sink-kit.ts";

let k: Sk;
afterEach(async () => {
  await k?.stop();
});

/** AC-01 state: run G1 raised A (S2) and B (S1), its filer accepted both with links. */
async function filedAB(o: { bRequiresA?: boolean } = {}): Promise<{ G1: Run; CG: string }> {
  k = await Sk.start();
  const G1 = await k.run();
  await k.raise(G1, [IA, IB]);
  await k.file(G1, [acc(fA), acc(fB, o.bRequiresA ? { requires: [fA] } : {})]);
  return { G1, CG: await k.CG() };
}
const iso = (ms: number) => new Date(ms).toISOString().slice(0, 10);

// =============================================================================================
// AC-01 First sink opens the goal
// =============================================================================================

describe("RL-9 AC-01 first sink", { timeout: 60_000 }, () => {
  it("test_AC01_goal_and_steps", async () => {
    k = await Sk.start();
    const G1 = await k.run();
    await k.raise(G1, [IA, IB]);
    // Control on the fixture: the audit's items are in lineage LIN() with the test-side fps.
    expect((await k.items()).map((x) => x.fp).sort()).toStrictEqual([fA, fB].sort());
    await k.file(G1, [acc(fA), acc(fB)]);
    // Positive control: the relay itself was not disturbed.
    expect((await k.step(G1.file)).state).toBe("done");
    expect((await k.goalView(G1.G)).goal.state).toBe("done");

    const cg = await k.cag();
    expect(cg, "clean-audit goal of (r, ci)").toBeDefined();
    const CG = cg.id as string;
    const view = await k.goalView(CG);
    const g = view.goal;
    expect(g.title).toBe("Clean audits: ci on r");
    expect(g.sink).toStrictEqual({ repo: "r", topic: "ci" });
    expect(g.topics).toStrictEqual(["ci"]);
    expect(g.state).toBe("in_progress");
    expect(g.ownerId).toBe("ann");
    expect(g.primaryRepo).toBe("r");
    const plans = view.plans as Json[];
    expect(plans, "exactly one plan version").toHaveLength(1);
    expect(plans[0]).toMatchObject({ version: 1, decision: "approved" });
    expect(plans[0].steps ?? []).toStrictEqual([]);

    const ida = k.fs(CG, fA);
    const idb = k.fs(CG, fB);
    const fs = await k.fsteps(CG);
    expect(fs.map((s) => s.id).sort()).toStrictEqual([ida, idb].sort());
    expect((view.steps as Json[]).filter((s) => s.kind === "implement").map((s) => s.id).sort()).toStrictEqual([ida, idb].sort());
    for (const [id, f, sev, title] of [
      [ida, fA, "S2", "[S2] T-A"],
      [idb, fB, "S1", "[S1] T-B"],
    ] as const) {
      const s = await k.step(id);
      expect(s, id).toMatchObject({ kind: "implement", repo: "r", state: "ready", severity: sev, title, planVersion: 1 });
      expect(s.finding).toStrictEqual({ lineage: LIN(), fp: f });
      expect(s.policy).toMatchObject({ worktree: true });
    }
    const brief = (await k.step(ida)).brief as string;
    for (const t of ["ra", "src/a.ts", "N-A", "3", "P-A", LINK(fA), "because accepted"]) expect(brief, t).toContain(t);
    expect(brief).not.toContain("(cut;");
    expect(brief.endsWith(LAST(LIN())), brief.slice(-200)).toBe(true);

    const created = await k.ev("goal.created", (e) => e.goal === CG);
    expect(created).toHaveLength(1);
    expect(created[0].payload).toMatchObject({ title: "Clean audits: ci on r", sink: { repo: "r", topic: "ci" } });
    const sunk = await k.ev("goal.sunk");
    expect(sunk).toHaveLength(1);
    expect(sunk[0].payload).toMatchObject({ goal: CG, from: G1.file, reopened: [] });
    expect([...(sunk[0].payload.added as string[])].sort()).toStrictEqual([ida, idb].sort());
    expect(await k.activity()).toContain(`2 findings from ${G1.file} (0 reopened)`);
  });

  it("test_AC01_unlinked_not_filed", async () => {
    k = await Sk.start();
    const G1 = await k.run();
    await k.raise(G1, [IA, IB]);
    await k.file(G1, [acc(fA), disp(fB, "accepted")]);
    const CG = await k.CG();
    // Control: A's step exists.
    expect((await k.fsteps(CG)).map((s) => s.id)).toStrictEqual([k.fs(CG, fA)]);
    const sunk = await k.ev("goal.sunk", (e) => e.payload?.from === G1.file);
    expect(sunk).toHaveLength(1);
    expect(sunk[0].payload.added).toStrictEqual([k.fs(CG, fA)]);
  });

  it("test_AC01_no_items_no_goal", async () => {
    k = await Sk.start();
    const G1 = await k.run();
    await k.raise(G1, []);
    await k.file(G1, []);
    // Control: the sink stage did finish.
    expect(["done", "skipped"]).toContain((await k.step(G1.file)).state);
    expect(await k.cag()).toBeUndefined();
    expect(await k.ev("goal.created", (e) => e.payload?.sink !== undefined)).toStrictEqual([]);
    expect(await k.ev("goal.sunk")).toStrictEqual([]);
    // Positive control in the same world: a later run that files A opens the goal.
    const G2 = await k.run();
    await k.raise(G2, [IA]);
    await k.file(G2, [acc(fA)]);
    expect(await k.cag(), "a filing run opens the goal").toBeDefined();
    expect(await k.ev("goal.sunk")).toHaveLength(1);
  });
});

// =============================================================================================
// AC-02 Later run adds only the new finding
// =============================================================================================

describe("RL-9 AC-02 later run", { timeout: 60_000 }, () => {
  it("test_AC02_new_only", async () => {
    const { CG } = await filedAB();
    const ida = k.fs(CG, fA);
    const idb = k.fs(CG, fB);
    await k.hold(k.bob, ida);
    const before = await k.snapshot(CG);
    const G2 = await k.run();
    await k.raise(G2, [IA, IB, IC]);
    await k.file(G2, [acc(fC)]);
    const fs = await k.fsteps(CG);
    expect(fs.map((s) => s.id).sort()).toStrictEqual([ida, idb, k.fs(CG, fC)].sort());
    expect(await k.step(k.fs(CG, fC))).toMatchObject({ state: "ready", severity: "S3", title: "[S3] T-C" });
    expect(await k.step(ida)).toMatchObject({ state: "claimed", holderUser: "bob" });
    const after = await k.snapshot(CG);
    const pick = (s: Json, id: string) => (s.steps as Json[]).find((x) => x.id === id);
    expect(pick(after, ida)).toStrictEqual(pick(before, ida));
    expect(pick(after, idb)).toStrictEqual(pick(before, idb));
    expect(after.plans, "no plan version added").toBe(1);
    const sunk = await k.ev("goal.sunk", (e) => e.payload?.from === G2.file);
    expect(sunk).toHaveLength(1);
    expect(sunk[0].payload).toMatchObject({ goal: CG, added: [k.fs(CG, fC)], reopened: [] });
    expect(await k.ev("step.reopened", (e) => e.goal === CG)).toStrictEqual([]);
    expect(await k.notes(ida)).not.toContain(`refiled by ${G2.file} (S2)`);
  });

  it("test_AC02_nothing_new_no_event", async () => {
    const { G1 } = await filedAB();
    const G2 = await k.run();
    await k.raise(G2, [IA, IB]);
    await k.file(G2, []);
    // Control: the G1 event exists.
    expect(await k.ev("goal.sunk", (e) => e.payload?.from === G1.file)).toHaveLength(1);
    expect(await k.ev("goal.sunk", (e) => e.payload?.from === G2.file)).toStrictEqual([]);
  });
});

// =============================================================================================
// AC-03 Two lineages, one goal
// =============================================================================================

describe("RL-9 AC-03 two lineages", { timeout: 60_000 }, () => {
  it("test_AC03_two_steps_one_fp", async () => {
    const { CG } = await filedAB();
    const H1 = await k.run({ preset: "relay2" });
    await k.raise(H1, [IA]);
    await k.file(H1, [acc(fA)]);
    expect(await k.cagAll()).toHaveLength(1);
    const one = k.fs(CG, fA, LIN("relay"));
    const two = k.fs(CG, fA, LIN("relay2"));
    expect(one).not.toBe(two);
    const forA = (await k.fsteps(CG)).filter((s) => s.finding.fp === fA);
    expect(forA.map((s) => s.id).sort()).toStrictEqual([one, two].sort());
    expect((await k.step(two)).finding).toStrictEqual({ lineage: LIN("relay2"), fp: fA });
    // A later run of `relay` without A: A of relay is resolved.
    const G2 = await k.run();
    await k.raise(G2, [IB]);
    expect((await k.item(fA)).state, "control: A of relay resolved").toBe("resolved");
    expect((await k.step(one)).state).toBe("done");
    expect((await k.step(two)).state).toBe("ready");
  });

  it("test_AC03_repo_exact_strings", async () => {
    k = await Sk.start();
    const G1 = await k.run();
    await k.raise(G1, [IA]);
    await k.file(G1, [acc(fA)]);
    // A goal on repo `group/r`: no person's checkout is `group/r`, so its stages go through the routes
    // (a route record keeps the rule as given, so B's fp there is of `rb`).
    const fRB = fpOf("rb");
    const H = await k.run({ preset: "grp", steps: [{ ...AUDIT, repo: "group/r" }, FILE({ repo: "group/r" })], primaryRepo: "group/r" });
    for (const [id, body] of [
      [H.audit, { coverage: "complete", assessment: "issues", items: [IB], dispositions: [], summary: "s" }],
      [H.file, { coverage: "complete", assessment: "clean", items: [], dispositions: [acc(fRB)], summary: "s" }],
    ] as const) {
      expect((await k.r.act(k.ann, id, "claim", {})).status, `claim ${id}`).toBe(200);
      const rv = await k.call(k.ann, "POST", `/v1/steps/${id}/review`, body);
      expect(rv.status, JSON.stringify(rv.json)).toBe(201);
      expect((await k.r.act(k.ann, id, "done", { outcome: "done", summary: "ok" })).status, `done ${id}`).toBe(200);
    }
    const r = await k.cag("r");
    const gr = await k.cag("group/r");
    expect(r, "goal of r").toBeDefined();
    expect(gr, "goal of group/r").toBeDefined();
    expect(r.id).not.toBe(gr.id);
    expect(gr.title).toBe("Clean audits: ci on r");
    expect((await k.fsteps(gr.id)).map((s) => s.finding)).toStrictEqual([{ lineage: LIN("grp", "group/r"), fp: fRB }]);
  });
});

// =============================================================================================
// AC-04 Deps from `requires`
// =============================================================================================

describe("RL-9 AC-04 requires", { timeout: 90_000 }, () => {
  async function dAfterE(): Promise<{ G1: Run; CG: string; idd: string; ide: string }> {
    k = await Sk.start();
    const G1 = await k.run();
    await k.raise(G1, [ID, IE]);
    // D listed before E.
    await k.file(G1, [acc(fD, { requires: [fE] }), acc(fE)]);
    const CG = await k.CG();
    return { G1, CG, idd: k.fs(CG, fD), ide: k.fs(CG, fE) };
  }

  it("test_AC04_dep_and_unblock", async () => {
    const { idd, ide } = await dAfterE();
    const d = await k.step(idd);
    expect(d.deps).toStrictEqual([ide]);
    expect(d.state).toBe("blocked");
    const e = await k.step(ide);
    expect(e.state).toBe("ready");
    expect(e.deps).toStrictEqual([]);
    expect((await k.notes(idd)).filter((n) => n.startsWith("requires "))).toStrictEqual([]);
    await k.doStep(k.ann, ide);
    expect((await k.step(ide)).state).toBe("done");
    expect((await k.step(idd)).state).toBe("ready");
  });

  it("test_AC04_not_in_goal", async () => {
    k = await Sk.start();
    const G1 = await k.run();
    await k.raise(G1, [ID, IE]);
    const fX = fpR("rx");
    const res = await k.file(G1, [acc(fD, { requires: [fX] }), acc(fE)]);
    expect(res.done?.isError).toBeFalsy();
    const CG = await k.CG();
    const d = await k.step(k.fs(CG, fD));
    expect(d.deps).toStrictEqual([]);
    expect(d.state).toBe("ready");
    expect(await k.notes(k.fs(CG, fD))).toContain(`requires ${fX}: not in this goal`);
  });

  it("test_AC04_cycle", async () => {
    const { CG, idd, ide } = await dAfterE();
    await k.doStep(k.ann, ide);
    await k.doStep(k.ann, idd);
    expect((await k.step(idd)).state).toBe("done");
    // The refile below is strictly later than E's step closing (rule 3: a newer filing reopens).
    k.tick();
    const G2 = await k.run();
    await k.raise(G2, [ID, IE]);
    const res = await k.stage(k.ann, G2.file, { assessment: "clean", dispositions: [acc(fE, { requires: [fD] })] });
    expect(res.review?.isError, res.review?.text).toBeFalsy();
    expect(res.done?.isError, res.done?.text).toBeFalsy();
    expect((await k.step(G2.file)).state).toBe("done");
    const e = await k.step(ide);
    expect(e.state).toBe("ready");
    expect(e.deps).toStrictEqual([]);
    expect(await k.notes(ide)).toContain(`requires ${fD}: cycle`);
    const sunk = await k.ev("goal.sunk", (x) => x.payload?.from === G2.file);
    expect(sunk).toHaveLength(1);
    expect(sunk[0].payload).toMatchObject({ goal: CG, added: [], reopened: [ide] });
    // Positive control: the non-cycle dep of D on E is still there.
    expect((await k.step(idd)).deps).toStrictEqual([ide]);
  });

  it("test_AC04_ambiguous_and_own_lineage", async () => {
    const { CG } = await filedAB();
    const H1 = await k.run({ preset: "relay2" });
    await k.raise(H1, [IA]);
    await k.file(H1, [acc(fA)]);
    const IX = item("rx", { title: "T-X" });
    const IY = item("ry", { title: "T-Y" });
    const IZ = item("rz", { title: "T-Z" });
    const [fX, fY, fZ] = [fpR("rx"), fpR("ry"), fpR("rz")];
    // (a) and (c): a relay3 run files X (requires A: two lineages have it) and Z (requires B: only relay has it).
    const R3 = await k.run({ preset: "relay3" });
    await k.raise(R3, [IX, IZ]);
    await k.file(R3, [acc(fX, { requires: [fA] }), acc(fZ, { requires: [fB] })]);
    const x = k.fs(CG, fX, LIN("relay3"));
    expect((await k.step(x)).deps).toStrictEqual([]);
    expect(await k.notes(x)).toContain(`requires ${fA}: ambiguous`);
    expect((await k.step(k.fs(CG, fZ, LIN("relay3")))).deps).toStrictEqual([k.fs(CG, fB, LIN("relay"))]);
    // (b) a relay2 run files Y requiring A: its own lineage's A first.
    const H2 = await k.run({ preset: "relay2" });
    await k.raise(H2, [IA, IY]);
    await k.file(H2, [acc(fY, { requires: [fA] })]);
    const y = k.fs(CG, fY, LIN("relay2"));
    expect((await k.step(y)).deps).toStrictEqual([k.fs(CG, fA, LIN("relay2"))]);
    expect((await k.notes(y)).filter((n) => n.startsWith("requires "))).toStrictEqual([]);
  });

  it("test_AC04_union_over_goal", async () => {
    k = await Sk.start();
    const G = await k.run({ steps: [AUDIT, DEBRIEF({ consumes: ["open"], may_set: ["accepted"] }), FILE({ deps: ["debrief"] })] });
    await k.raise(G, [ID, IE]);
    const pid = await k.hold(k.ann, G.s("debrief"));
    await k.toolOk(k.ann, pid, "mesh_dispose", { fingerprint: fD, disposition: "accepted", reason: "R-D", answer: "ANS-D", requires: [fE] });
    await k.toolOk(k.ann, pid, "mesh_review", { coverage: "complete", assessment: "clean", items: [], dispositions: [], summary: "s" });
    await k.toolOk(k.ann, pid, "mesh_done", { outcome: "done", summary: "debriefed" });
    await k.file(G, [acc(fD), acc(fE)]);
    const CG = await k.CG();
    expect((await k.step(k.fs(CG, fD))).deps).toStrictEqual([k.fs(CG, fE)]);
  });

  it("test_AC04_requires_only_accepted", async () => {
    await filedAB();
    const G2 = await k.run({ steps: [AUDIT, TRIAGE({ may_set: ["dismissed", "deferred", "accepted"] }), DEBRIEF({ consumes: ["accepted"], may_set: ["dismissed"] })] });
    await k.raise(G2, [IA, IB]);
    const before = (await k.items()).map((x) => ({ fp: x.fp, state: x.state, n: (x.history as Json[]).length }));
    const T = G2.s("triage");
    const pid = await k.hold(k.ann, T);
    const bad = { coverage: "complete", assessment: "clean", items: [], summary: "s", dispositions: [disp(fB, "dismissed"), { ...disp(fA, "dismissed"), requires: [fB] }] };
    const t = await k.tool(k.ann, pid, "mesh_review", bad);
    expect(t.isError, t.text).toBe(true);
    expect(t.text).toContain("requires is only for accepted");
    const route = await k.call(k.ann, "POST", `/v1/steps/${T}/review`, bad);
    expect(route.status, JSON.stringify(route.json)).toBe(422);
    expect(JSON.stringify(route.json)).toContain("requires is only for accepted");
    expect((await k.items()).map((x) => ({ fp: x.fp, state: x.state, n: (x.history as Json[]).length }))).toStrictEqual(before);
    // Malformed lists: the schema's 400.
    const many = Array.from({ length: 21 }, (_, i) => fpR(`m${i}`));
    for (const requires of [["NOT-AN-FP"], [], many]) {
      const res = await k.call(k.ann, "POST", `/v1/steps/${T}/review`, { ...bad, dispositions: [{ ...acc(fA), requires }] });
      expect(res.status, `requires ${JSON.stringify(requires).slice(0, 40)}: ${JSON.stringify(res.json)}`).toBe(400);
    }
    // The debrief route: dismissed with requires → 422.
    const D = G2.s("debrief");
    await k.hold(k.ann, D);
    const dr = await k.call(k.ann, "POST", `/v1/steps/${D}/dispositions`, { fingerprint: fA, disposition: "dismissed", reason: "R", answer: "ANS", requires: [fB] });
    expect(dr.status, JSON.stringify(dr.json)).toBe(422);
    expect(JSON.stringify(dr.json)).toContain("requires is only for accepted");
    // Positive controls (one review record per step round, so each on its own triage step).
    // Item state is per lineage, so the two controls must not touch the same items: ok1 runs first,
    // on G2's triage (lineage "relay"); ok2 runs on a fresh goal of another lineage ("relay2").
    // ok1: an accepted disposition with requires → 201.
    const ok1 = await k.call(k.ann, "POST", `/v1/steps/${T}/review`, { ...bad, dispositions: [{ ...acc(fA), requires: [fB] }] });
    expect(ok1.status, JSON.stringify(ok1.json)).toBe(201);
    // ok2: the rejected record's shape without requires → 201. The relay2 items are new (open), so this triage consumes open.
    const G3 = await k.run({ preset: "relay2", steps: [AUDIT, TRIAGE({ consumes: ["open"], may_set: ["dismissed", "deferred", "accepted"] })] });
    await k.raise(G3, [IA, IB]);
    const T3 = G3.s("triage");
    await k.hold(k.ann, T3);
    const ok2 = await k.call(k.ann, "POST", `/v1/steps/${T3}/review`, { ...bad, dispositions: [disp(fB, "dismissed"), disp(fA, "dismissed")] });
    expect(ok2.status, JSON.stringify(ok2.json)).toBe(201);
  });
});

// =============================================================================================
// AC-05 Resolved closes the step
// =============================================================================================

describe("RL-9 AC-05 resolved", { timeout: 60_000 }, () => {
  it("test_AC05_ready_closed_and_dependant_settled", async () => {
    const { CG } = await filedAB({ bRequiresA: true });
    const ida = k.fs(CG, fA);
    const idb = k.fs(CG, fB);
    expect((await k.step(idb)).state, "control: B blocked on A").toBe("blocked");
    const G2 = await k.run();
    await k.raise(G2, [IB], { who: k.bob });
    expect((await k.item(fA)).state).toBe("resolved");
    expect(await k.step(ida)).toMatchObject({ state: "done", outcome: "done", summary: `resolved by ${G2.audit}` });
    const done = await k.ev("step.done", (e) => e.step === ida);
    expect(done).toHaveLength(1);
    expect(done[0].payload?.by).toBe("ann");
    expect((await k.step(idb)).state).toBe("ready");
  });

  it("test_AC05_held_only_noted", async () => {
    const { CG } = await filedAB();
    const ida = k.fs(CG, fA);
    await k.hold(k.bob, ida);
    const G2 = await k.run();
    await k.raise(G2, [IB], { who: k.bob });
    expect((await k.item(fA)).state, "control: A resolved").toBe("resolved");
    expect(await k.step(ida)).toMatchObject({ state: "claimed", holderUser: "bob" });
    expect(await k.notes(ida)).toContain(`resolved by ${G2.audit}`);
    expect(await k.ev("step.done", (e) => e.step === ida)).toStrictEqual([]);
  });

  it("test_AC05_failed_only_noted", async () => {
    const { CG } = await filedAB();
    const ida = k.fs(CG, fA);
    await k.patchStep(ida, { state: "failed" });
    const G2 = await k.run();
    await k.raise(G2, [IB]);
    expect((await k.item(fA)).state, "control: A resolved").toBe("resolved");
    expect((await k.step(ida)).state).toBe("failed");
    expect(await k.notes(ida)).toContain(`resolved by ${G2.audit}`);
  });

  it("test_AC05_partial_record_no_change", async () => {
    const { CG } = await filedAB({ bRequiresA: true });
    const ida = k.fs(CG, fA);
    const before = await k.snapshot(CG);
    const G2 = await k.run();
    await k.raise(G2, [IB], { coverage: "partial" });
    expect((await k.item(fA)).state).toBe("accepted");
    expect((await k.step(ida)).state).toBe("ready");
    expect(await k.snapshot(CG)).toStrictEqual(before);
    expect(await k.ev("step.done", (e) => e.step === ida)).toStrictEqual([]);
    // Control that the finding steps exist at all (so "unchanged" is not "empty").
    expect((before.steps as Json[]).some((s) => s.id === ida)).toBe(true);
  });
});

// =============================================================================================
// AC-06 Refiled reopens the step
// =============================================================================================

describe("RL-9 AC-06 refiled", { timeout: 90_000 }, () => {
  /** A resolved (step done), B (requires A) done by ann. */
  async function resolvedA(): Promise<{ CG: string; ida: string; idb: string }> {
    const { CG } = await filedAB({ bRequiresA: true });
    const ida = k.fs(CG, fA);
    const idb = k.fs(CG, fB);
    const G2 = await k.run();
    await k.raise(G2, [IB]);
    expect((await k.step(ida)).state).toBe("done");
    expect((await k.step(idb)).state).toBe("ready");
    await k.doStep(k.ann, idb);
    expect((await k.step(idb)).state).toBe("done");
    // Later filings are strictly newer than the steps' close (rule 3).
    k.tick();
    return { CG, ida, idb };
  }

  it("test_AC06_reopen_after_resolve", async () => {
    const { CG, ida, idb } = await resolvedA();
    const a0 = await k.step(ida);
    const n0 = a0.fixCycles as number;
    const rounds0 = ((a0.rounds ?? []) as Json[]).length;
    const G3 = await k.run();
    await k.raise(G3, [{ ...IA, severity: "S1" }, IB]);
    expect((await k.item(fA)).state, "control: A raised again (regression)").toBe("open");
    await k.file(G3, [acc(fA)]);
    const a = await k.step(ida);
    expect(a).toMatchObject({ state: "ready", fixCycles: n0 + 1, severity: "S1", title: "[S1] T-A" });
    for (const f of ["outcome", "summary", "holderUser", "holderSid", "holderMachine", "roundStartedAt"]) expect(a[f], f).toBeUndefined();
    expect(((a.rounds ?? []) as Json[]).length).toBe(rounds0);
    const ro = await k.ev("step.reopened", (e) => e.step === ida);
    expect(ro).toHaveLength(1);
    expect(ro[0].payload).toMatchObject({ by: "ann", reason: "refiled", fixCycles: n0 + 1, from: G3.file });
    expect(await k.notes(ida)).toContain(`refiled by ${G3.file}`);
    const sunk = await k.ev("goal.sunk", (e) => e.payload?.from === G3.file);
    expect(sunk).toHaveLength(1);
    expect(sunk[0].payload).toMatchObject({ goal: CG, added: [], reopened: [ida] });
    expect(await k.activity()).toContain(`1 findings from ${G3.file} (1 reopened)`);
    expect((await k.step(idb)).state).toBe("done");
    expect(await k.ev("step.reopened", (e) => e.step === idb)).toStrictEqual([]);
  });

  it("test_AC06_reopen_with_deps_blocked", async () => {
    const { ida } = await resolvedA();
    // C filed and ready (not done).
    const G3 = await k.run();
    await k.raise(G3, [IB, IC]);
    await k.file(G3, [acc(fC)]);
    const CG = await k.CG();
    const idc = k.fs(CG, fC);
    expect((await k.step(idc)).state).toBe("ready");
    const G4 = await k.run();
    await k.raise(G4, [IA, IB, IC]);
    await k.file(G4, [acc(fA, { requires: [fC] })]);
    const a = await k.step(ida);
    expect(a.state).toBe("blocked");
    expect(a.deps).toContain(idc);
  });

  it("test_AC06_dropped_refiled", async () => {
    const { CG } = await filedAB();
    const ida = k.fs(CG, fA);
    // A deferred (until tomorrow) by a triage: its ready step is dropped.
    const G2 = await k.run({ steps: [AUDIT, TRIAGE()] });
    await k.raise(G2, [IA, IB]);
    await k.file(G2, [disp(fA, "deferred", { reason: "later", until: iso(NOV19 + DAY_MS) })], { stage: "triage" });
    expect((await k.step(ida)).state).toBe("dropped");
    // After `until`, a later run raises A again (open), and its filer accepts it with a link.
    k.w.clock = NOV19 + 3 * DAY_MS;
    const G3 = await k.run();
    await k.raise(G3, [IA, IB]);
    expect((await k.item(fA)).state, "control: A open again").toBe("open");
    await k.file(G3, [acc(fA)]);
    expect((await k.step(ida)).state).toBe("ready");
    const ro = await k.ev("step.reopened", (e) => e.step === ida);
    expect(ro).toHaveLength(1);
    expect(ro[0].payload).toMatchObject({ reason: "refiled", from: G3.file });
  });

  it("test_AC06_rule4_ready_and_held", async () => {
    const { CG } = await filedAB();
    const idb = k.fs(CG, fB);
    const n0 = (await k.step(idb)).fixCycles as number;
    // (a) B's step ready (S1): refiled as S3 → still ready, severity and title updated, not reopened.
    const IB3 = { ...IB, severity: "S3" };
    const G2 = await k.run();
    await k.raise(G2, [IA, IB3]);
    await k.file(G2, [acc(fB, { link: `${LINK(fB)}-2` })]);
    expect(await k.step(idb)).toMatchObject({ state: "ready", severity: "S3", title: "[S3] T-B", fixCycles: n0 });
    expect(await k.ev("step.reopened", (e) => e.step === idb)).toStrictEqual([]);
    // (b) B's step claimed by bob: a refile (as S2) leaves it claimed with its title, and notes it.
    await k.hold(k.bob, idb);
    const G3 = await k.run();
    await k.raise(G3, [IA, { ...IB, severity: "S2" }]);
    await k.file(G3, [acc(fB, { link: `${LINK(fB)}-3` })]);
    expect(await k.step(idb)).toMatchObject({ state: "claimed", holderUser: "bob", title: "[S3] T-B" });
    expect(await k.notes(idb)).toContain(`refiled by ${G3.file} (S2)`);
  });
});

// =============================================================================================
// AC-07 Dismissed, deferred, revert
// =============================================================================================

describe("RL-9 AC-07 dismissed and deferred", { timeout: 90_000 }, () => {
  it("test_AC07a_dismiss_and_defer_drop_ready", async () => {
    k = await Sk.start();
    const G1 = await k.run();
    await k.raise(G1, [IA, IB, IC]);
    await k.file(G1, [acc(fA), acc(fB), acc(fC)]);
    const CG = await k.CG();
    const [ida, idb, idc] = [fA, fB, fC].map((f) => k.fs(CG, f)) as [string, string, string];
    await k.hold(k.bob, ida);
    const n0 = (await k.fsteps(CG)).length;
    const G2 = await k.run({ steps: [AUDIT, TRIAGE()] });
    await k.raise(G2, [IA, IB, IC]);
    await k.file(
      G2,
      [disp(fB, "dismissed", { reason: "RB" }), disp(fC, "deferred", { reason: "RC", until: iso(NOV19 + 30 * DAY_MS) }), disp(fA, "dismissed", { reason: "RA" })],
      { stage: "triage" },
    );
    expect((await k.item(fB)).state, "control: B dismissed").toBe("dismissed");
    expect(await k.step(idb)).toMatchObject({ state: "dropped", summary: "dismissed by ann: RB" });
    const db = await k.ev("step.dropped", (e) => e.step === idb);
    expect(db).toHaveLength(1);
    expect(db[0].payload).toMatchObject({ reason: "dismissed", by: "ann" });
    expect(await k.step(idc)).toMatchObject({ state: "dropped", summary: "deferred by ann: RC" });
    const dc = await k.ev("step.dropped", (e) => e.step === idc);
    expect(dc).toHaveLength(1);
    expect(dc[0].payload).toMatchObject({ reason: "deferred" });
    expect(await k.step(ida)).toMatchObject({ state: "claimed", holderUser: "bob" });
    expect(await k.notes(ida)).toContain("dismissed by ann: RA");
    expect(await k.fsteps(CG)).toHaveLength(n0);
  });

  it("test_AC07b_debrief_dismiss_then_revert", async () => {
    k = await Sk.start();
    const G1 = await k.run();
    await k.raise(G1, [ID, IE]);
    await k.file(G1, [acc(fD, { requires: [fE] }), acc(fE)]);
    const CG = await k.CG();
    const idd = k.fs(CG, fD);
    const ide = k.fs(CG, fE);
    expect((await k.step(idd)).state, "control: D blocked on E").toBe("blocked");
    const G2 = await k.run({ steps: [AUDIT, DEBRIEF({ consumes: ["accepted"], may_set: ["dismissed"] })] });
    await k.raise(G2, [ID, IE]);
    const D = G2.s("debrief");
    const pid = await k.hold(k.ann, D);
    await k.toolOk(k.ann, pid, "mesh_dispose", { fingerprint: fD, disposition: "dismissed", reason: "R-D", answer: "ANS-D" });
    expect((await k.step(idd)).state).toBe("dropped");
    const rv = await k.call(k.ann, "POST", `/v1/steps/${D}/dispositions/revert`, { fingerprint: fD });
    expect(rv.status, JSON.stringify(rv.json)).toBe(200);
    expect(await k.item(fD), "control: D filed again").toMatchObject({ state: "accepted", link: LINK(fD) });
    const d = await k.step(idd);
    expect(d.state).toBe("blocked");
    expect(d.deps).toStrictEqual([ide]);
    const ro = await k.ev("step.reopened", (e) => e.step === idd);
    expect(ro).toHaveLength(1);
    expect(ro[0].payload).toMatchObject({ reason: "reverted", from: D, by: "ann" });
  });

  /** AC-09 world: F filed by the debrief, `file` skipped, F's step ready. */
  async function debriefFiledF(): Promise<{ G: Run; CG: string; idf: string; D: string; pid: number }> {
    k = await Sk.start();
    const G = await k.run({ steps: [AUDIT, DEBRIEF({ consumes: ["open"], may_set: ["accepted"] }), FILE({ deps: ["debrief"], when: { open: true } })] });
    await k.raise(G, [IF]);
    const D = G.s("debrief");
    const pid = await k.hold(k.ann, D);
    await k.toolOk(k.ann, pid, "mesh_dispose", { fingerprint: fF, disposition: "accepted", reason: "R-F", answer: "ANS-F", link: LINK(fF) });
    await k.toolOk(k.ann, pid, "mesh_review", { coverage: "complete", assessment: "clean", items: [], dispositions: [], summary: "s" });
    await k.toolOk(k.ann, pid, "mesh_done", { outcome: "done", summary: "debriefed" });
    const CG = await k.CG();
    return { G, CG, idf: k.fs(CG, fF), D, pid };
  }

  it("test_AC07_revert_accepted_drops", async () => {
    const { idf, D } = await debriefFiledF();
    expect((await k.step(idf)).state).toBe("ready");
    const rv = await k.call(k.ann, "POST", `/v1/steps/${D}/dispositions/revert`, { fingerprint: fF });
    expect(rv.status, JSON.stringify(rv.json)).toBe(200);
    expect(await k.step(idf)).toMatchObject({ state: "dropped", summary: "reverted by ann" });
    const dr = await k.ev("step.dropped", (e) => e.step === idf);
    expect(dr).toHaveLength(1);
    expect(dr[0].payload).toMatchObject({ reason: "reverted" });
  });

  it("test_AC07_revert_accepted_held_noted", async () => {
    const { idf, D } = await debriefFiledF();
    await k.hold(k.bob, idf);
    const rv = await k.call(k.ann, "POST", `/v1/steps/${D}/dispositions/revert`, { fingerprint: fF });
    expect(rv.status, JSON.stringify(rv.json)).toBe(200);
    expect(await k.step(idf)).toMatchObject({ state: "claimed", holderUser: "bob" });
    expect(await k.notes(idf)).toContain("reverted by ann");
  });

  // RL-2: a record from a headless step has an agent decider (its agent key); from an interactive
  // step, the person (the caller), whatever `agent` it sends. The headless stage is claimed and its
  // record uploaded through the hub routes, as RL-2's own consuming-stage tests do.
  it("test_AC07_agent_decider_by_owner", async () => {
    const { CG } = await filedAB();
    const idb = k.fs(CG, fB);
    const G2 = await k.run({ steps: [AUDIT, TRIAGE({ mode: "headless", agent: "checker" })] });
    await k.raise(G2, [IA, IB]);
    const T = G2.s("triage");
    const c = await k.r.act(k.bob, T, "claim", {});
    expect(c.status, `claim ${T}: ${JSON.stringify(c.json)}`).toBe(200);
    const up = await k.call(k.bob, "POST", `/v1/steps/${T}/review`, recArgs({ assessment: "clean", dispositions: [disp(fB, "dismissed", { reason: "RB" })], agent: { key: "r/checker", hash: "h1" } }));
    expect(up.status, JSON.stringify(up.json)).toBe(201);
    const d = await k.r.act(k.bob, T, "done", { outcome: "done", summary: "ok" });
    expect(d.status, JSON.stringify(d.json)).toBe(200);
    await k.w.flush();
    // Controls: B was dismissed, and by an agent (not bob, the caller).
    const b = await k.item(fB);
    expect(b.state).toBe("dismissed");
    expect((b.history as Json[]).at(-1)?.decider?.kind).toBe("agent");
    const s = await k.step(idb);
    expect(s.state).toBe("dropped");
    expect(s.summary).toMatch(/^dismissed by .+: RB$/);
    const dr = await k.ev("step.dropped", (e) => e.step === idb);
    expect(dr).toHaveLength(1);
    expect(dr[0].payload).toMatchObject({ reason: "dismissed", by: "ann" });
    expect(dr[0].payload.by).not.toBe("bob");
  });

  it("test_AC07_person_decider_by_caller", async () => {
    const { CG } = await filedAB();
    const idb = k.fs(CG, fB);
    const G2 = await k.run({ steps: [AUDIT, TRIAGE()] });
    await k.raise(G2, [IA, IB]);
    // An interactive step: the decider is bob (the caller), whatever `agent` the upload names.
    await k.file(G2, [disp(fB, "dismissed", { reason: "RB" })], { stage: "triage", who: k.bob, agent: { key: "x/checker" } });
    expect(await k.step(idb)).toMatchObject({ state: "dropped", summary: "dismissed by bob: RB" });
    const dr = await k.ev("step.dropped", (e) => e.step === idb);
    expect(dr).toHaveLength(1);
    expect(dr[0].payload).toMatchObject({ reason: "dismissed", by: "bob" });
  });
});

// =============================================================================================
// AC-09 Skipped sink still sinks
// =============================================================================================

describe("RL-9 AC-09 skipped sink", { timeout: 60_000 }, () => {
  it("test_AC09_debrief_files_then_file_skipped", async () => {
    k = await Sk.start();
    const G = await k.run({ steps: [AUDIT, DEBRIEF({ consumes: ["open"], may_set: ["accepted"] }), FILE({ deps: ["debrief"], when: { open: true } })] });
    await k.raise(G, [IF]);
    const pid = await k.hold(k.ann, G.s("debrief"));
    await k.toolOk(k.ann, pid, "mesh_dispose", { fingerprint: fF, disposition: "accepted", reason: "R-F", answer: "ANS-F", link: LINK(fF) });
    await k.toolOk(k.ann, pid, "mesh_review", { coverage: "complete", assessment: "clean", items: [], dispositions: [], summary: "s" });
    await k.toolOk(k.ann, pid, "mesh_done", { outcome: "done", summary: "debriefed" });
    expect(await k.item(fF), "control: F filed").toMatchObject({ state: "accepted", link: LINK(fF) });
    expect((await k.step(G.file)).state).toBe("skipped");
    const cg = await k.cag();
    expect(cg, "clean-audit goal").toBeDefined();
    expect((await k.step(k.fs(cg.id, fF))).state).toBe("ready");
    expect(await k.ev("goal.sunk", (e) => e.payload?.from === G.file)).toHaveLength(1);
  });
});

// =============================================================================================
// AC-10 A sink never fails the filer
// =============================================================================================

describe("RL-9 AC-10 sink failure", { timeout: 60_000 }, () => {
  it("test_AC10_topic_deleted", async () => {
    const { G1, CG } = await filedAB();
    const G2 = await k.run();
    await k.raise(G2, [IA, IB, IC]);
    const del = await k.call(k.ann, "POST", "/v1/topics/ci/delete");
    expect(del.status, JSON.stringify(del.json)).toBe(200);
    const before = await k.snapshot(CG);
    const res = await k.stage(k.ann, G2.file, { assessment: "clean", dispositions: [acc(fC)] });
    expect(res.review?.isError, res.review?.text).toBeFalsy();
    expect(res.done?.isError, res.done?.text).toBeFalsy();
    expect((await k.step(G2.file)).state).toBe("done");
    const failed = (await k.notes(G2.file)).filter((n) => /^sink failed: .+/.test(n));
    expect(failed).toHaveLength(1);
    const ev = await k.ev("goal.sink_failed", (e) => e.payload?.from === G2.file);
    expect(ev).toHaveLength(1);
    expect(typeof ev[0].payload.reason).toBe("string");
    expect(ev[0].payload.reason.length).toBeGreaterThan(0);
    expect(failed[0]).toBe(`sink failed: ${ev[0].payload.reason}`);
    expect(await k.maybeStep(k.fs(CG, fC))).toBeUndefined();
    expect(await k.snapshot(CG)).toStrictEqual(before);
    expect(await k.ev("goal.sunk", (e) => e.payload?.from === G2.file)).toStrictEqual([]);
    const g = (await k.goalView(CG)).goal;
    expect(g.sink).toStrictEqual({ repo: "r", topic: "ci" });
    expect(g.topics ?? []).not.toContain("ci");
    // Positive control: the G1 sink happened.
    expect(await k.ev("goal.sunk", (e) => e.payload?.from === G1.file)).toHaveLength(1);
  });

  it("test_AC10_no_goal_opened", async () => {
    k = await Sk.start();
    const G1 = await k.run();
    await k.raise(G1, [IA]);
    expect((await k.call(k.ann, "POST", "/v1/topics/ci/delete")).status).toBe(200);
    const res = await k.stage(k.ann, G1.file, { assessment: "clean", dispositions: [acc(fA)] });
    expect(res.done?.isError, res.done?.text).toBeFalsy();
    expect((await k.step(G1.file)).state).toBe("done");
    expect(await k.cagAll()).toStrictEqual([]);
    expect((await k.notes(G1.file)).some((n) => /^sink failed: .+/.test(n))).toBe(true);
    expect(await k.ev("goal.sink_failed", (e) => e.payload?.from === G1.file)).toHaveLength(1);
  });
});

// =============================================================================================
// AC-12 Truncation
// =============================================================================================

describe("RL-9 AC-12 truncation", { timeout: 60_000 }, () => {
  it("test_AC12_title_and_brief", async () => {
    k = await Sk.start();
    const IL = item("rl", {
      severity: "S1",
      title: "t".repeat(200),
      proposal: "p".repeat(4000),
      evidence: Array.from({ length: 20 }, (_, i) => ({ path: `src/e${i}.ts`, note: String(i % 10).repeat(1000) })),
    });
    const fL = fpR("rl");
    const G1 = await k.run();
    await k.raise(G1, [IL]);
    await k.file(G1, [acc(fL)]);
    const CG = await k.CG();
    const s = await k.step(k.fs(CG, fL));
    expect(s.title).toBe(`${`[S1] ${"t".repeat(200)}`.slice(0, 199)}…`);
    expect((s.title as string).length).toBe(200);
    const brief = s.brief as string;
    expect(brief.length).toBeLessThanOrEqual(8000);
    expect(brief.endsWith(LAST(LIN())), brief.slice(-200)).toBe(true);
    const cut = `… (cut; mesh items ${LIN()})`;
    expect(brief).toContain(cut);
    expect(brief.lastIndexOf(cut)).toBeLessThan(brief.lastIndexOf(LAST(LIN())));
  });
});

// =============================================================================================
// AC-20 Not refiled, not reopened
// =============================================================================================

describe("RL-9 AC-20 not refiled, not reopened", { timeout: 90_000 }, () => {
  /**
   * Run G1 (audit → file → gate) files A and B; ann finishes A's finding step (`mesh_done`), a minute
   * after the filing. Returns A's step as it is then.
   */
  async function aDone(): Promise<{ G1: Run; CG: string; ida: string; idb: string; a0: Json }> {
    k = await Sk.start();
    const G1 = await k.run({ steps: [AUDIT, FILE(), GATE(["file"])] });
    await k.raise(G1, [IA, IB]);
    await k.file(G1, [acc(fA), acc(fB)]);
    const CG = await k.CG();
    const ida = k.fs(CG, fA);
    const idb = k.fs(CG, fB);
    k.tick();
    await k.doStep(k.ann, ida);
    const a0 = await k.step(ida);
    expect(a0.state, "control: A's step done by a person").toBe("done");
    k.tick();
    return { G1, CG, ida, idb, a0 };
  }

  it("test_AC20_backfill_and_second_round_keep_done", async () => {
    const { G1, CG, ida, idb, a0 } = await aDone();
    expect(await k.item(fA), "control: A still filed").toMatchObject({ state: "accepted", link: LINK(fA) });
    // `mesh items sink` over the lineage: nothing was filed after A's step closed.
    const bf = await k.call(k.ann, "POST", "/v1/items/sink", { lineage: LIN(), topic: "ci" });
    expect(bf.status, JSON.stringify(bf.json)).toBe(200);
    expect(bf.json).toMatchObject({ goal: CG, added: [], reopened: [] });
    expect(await k.step(ida)).toMatchObject({ state: "done", fixCycles: a0.fixCycles });
    // A second round of the same `file` stage: the gate is rejected and reopens it; it records nothing new.
    const rj = await k.call(k.ann, "POST", `/v1/steps/${G1.s("gate")}/reject`, { comment: "again", reopen: ["file"] });
    expect(rj.status, JSON.stringify(rj.json)).toBe(200);
    expect((await k.step(G1.file)).state, "control: file reopened").toBe("ready");
    k.tick();
    await k.file(G1, []);
    expect((await k.step(G1.file)).state, "control: file's second round done").toBe("done");
    expect(await k.step(ida)).toMatchObject({ state: "done", fixCycles: a0.fixCycles });
    expect(await k.ev("step.reopened", (e) => e.step === ida)).toStrictEqual([]);
    expect(await k.ev("goal.sunk", (e) => e.payload?.goal === CG)).toHaveLength(1);
    // Control: B's step (ready) is still there and ready.
    expect((await k.step(idb)).state).toBe("ready");
  });

  it("test_AC20_refile_reopens_with_new_link", async () => {
    const { CG, ida, a0 } = await aDone();
    // Positive control for the same world: before the refile, the brief holds the first link.
    expect(a0.brief as string).toContain(LINK(fA));
    const NEW = `https://tracker.example/new/${fA}`;
    const G2 = await k.run();
    await k.raise(G2, [IA, IB]);
    k.tick();
    await k.file(G2, [acc(fA, { link: NEW })]);
    expect(await k.item(fA), "control: A refiled with the new link").toMatchObject({ state: "accepted", link: NEW });
    const a = await k.step(ida);
    expect(a).toMatchObject({ state: "ready", fixCycles: (a0.fixCycles as number) + 1 });
    const brief = a.brief as string;
    expect(brief).toContain(NEW);
    expect(brief).not.toContain(LINK(fA));
    expect(brief.endsWith(LAST(LIN())), brief.slice(-200)).toBe(true);
    const ro = await k.ev("step.reopened", (e) => e.step === ida);
    expect(ro).toHaveLength(1);
    expect(ro[0].payload).toMatchObject({ reason: "refiled", from: G2.file });
    expect((await k.goalView(CG)).goal.state).toBe("in_progress");
  });
});

// =============================================================================================
// AC-21 Sink after other settle paths
// =============================================================================================

describe("RL-9 AC-21 sink after gate approval and resume", { timeout: 90_000 }, () => {
  it("test_AC21_gate_approve_skips_and_sinks", async () => {
    k = await Sk.start();
    const G = await k.run({
      steps: [AUDIT, DEBRIEF({ consumes: ["open"], may_set: ["accepted"] }), GATE(["debrief"]), FILE({ deps: ["gate"], when: { open: true } })],
    });
    await k.raise(G, [IF]);
    await k.debriefAccept(k.ann, G.s("debrief"), fF);
    expect(await k.item(fF), "control: F filed").toMatchObject({ state: "accepted", link: LINK(fF) });
    // Controls: the gate waits for a person, `file` waits for the gate, nothing sunk yet.
    expect((await k.step(G.s("gate"))).state).toBe("ready");
    expect((await k.step(G.file)).state).toBe("blocked");
    expect(await k.cag()).toBeUndefined();
    const ap = await k.call(k.ann, "POST", `/v1/steps/${G.s("gate")}/approve`, { comment: "ok" });
    expect(ap.status, JSON.stringify(ap.json)).toBe(200);
    expect((await k.step(G.file)).state).toBe("skipped");
    const cg = await k.cag();
    expect(cg, "clean-audit goal").toBeDefined();
    expect((await k.step(k.fs(cg.id, fF))).state).toBe("ready");
    expect(await k.ev("goal.sunk", (e) => e.payload?.from === G.file)).toHaveLength(1);
  });

  // A resume returns a parked step to `ready`, so a parked dependency of `file` cannot let `file` be
  // decided by the resume itself. The world here: the debrief filed F and its step is marked done in
  // the store directly (no settle ran, so `file` is still `blocked` with its dependencies done), and
  // `p`, a step after the audit, is parked. Resuming `p` settles the goal: `file` is decided
  // (`skipped`), and its sink runs.
  it("test_AC21_resume_skips_and_sinks", async () => {
    k = await Sk.start();
    const G = await k.run({
      steps: [AUDIT, { id: "p", repo: "r", deps: ["audit"] }, DEBRIEF({ consumes: ["open"], may_set: ["accepted"] }), FILE({ deps: ["debrief"], when: { open: true } })],
    });
    await k.raise(G, [IF]);
    await k.debriefAccept(k.ann, G.s("debrief"), fF, { done: false });
    await k.patchStep(G.s("debrief"), { state: "done", outcome: "done", summary: "debriefed", holderUser: undefined, holderSid: undefined, holderMachine: undefined });
    await k.patchStep(G.s("p"), { state: "parked", parkedReason: "infra: routed to a person" });
    // Controls: F filed, `file` not decided yet, nothing sunk.
    expect(await k.item(fF)).toMatchObject({ state: "accepted", link: LINK(fF) });
    expect((await k.step(G.file)).state).toBe("blocked");
    expect(await k.cag()).toBeUndefined();
    const rs = await k.call(k.ann, "POST", `/v1/steps/${G.s("p")}/resume`, { comment: "back" });
    expect(rs.status, JSON.stringify(rs.json)).toBe(200);
    expect((await k.step(G.s("p"))).state).toBe("ready");
    expect((await k.step(G.file)).state).toBe("skipped");
    const cg = await k.cag();
    expect(cg, "clean-audit goal").toBeDefined();
    expect((await k.step(k.fs(cg.id, fF))).state).toBe("ready");
    expect(await k.ev("goal.sunk", (e) => e.payload?.from === G.file)).toHaveLength(1);
  });
});
