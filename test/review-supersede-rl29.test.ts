// RL-29 AC-10 to AC-13: a newer run of the same pulse and lineage supersedes an older open review that
// no one has started deciding (REQ-REVSUP-1 to -6); decisions carry over by fingerprint (F-2, F-3);
// RL-15's fire-time supersede is unchanged. Written from docs/specs/RL-29.md.

import { afterEach, describe, expect, it } from "vitest";
import { record } from "./helpers/overlap-kit.ts";
import { A, acc, B, C, dayOf, DAY, def, dis, EH2, EV_C, IA, IB, IC, item, Rv, type Json, type Run } from "./helpers/revdec-kit.ts";
import { carryFps } from "../src/hub/service.ts";

let v: Rv | undefined;
afterEach(async () => {
  await v?.stop();
  v = undefined;
});

async function start(o: { overlap?: string; gate?: boolean } = {}): Promise<Rv> {
  v = await Rv.start();
  await v.pulse("ann", { ...(o.overlap ? { overlap: o.overlap } : {}), ...(o.gate ? { gate: true } : {}) });
  return v;
}

const SUP = ["step.ready", "goal.dropped", "step.dropped", "review.superseded"];

describe("RL-29 AC-10 a newer run supersedes an older untouched review", { timeout: 120_000 }, () => {
  it("test_AC10_supersede_and_file_carried", async () => {
    const v = await start();
    const R1 = await v.run();
    const lineage = (await v.reviews(R1.AU))[0].lineage as string;
    expect((await v.step(R1.D)).state).toBe("ready");
    const R2 = await v.fire();
    await v.audit(R2, [IA, IB], "partial");
    const seq = await v.lastSeq();
    await v.validate(R2, [A, B], lineage);
    expect(await v.goalState(R1.G)).toBe("dropped");
    for (const id of [R1.D, R1.F]) expect((await v.step(id)).state, id).toBe("dropped");
    const dropped = await v.ev("goal.dropped", (e) => e.goal === R1.G);
    expect(dropped).toHaveLength(1);
    expect(dropped[0].payload).toMatchObject({ reason: "superseded", comment: `superseded by ${R2.D}` });
    const sup = await v.ev("review.superseded");
    expect(sup).toHaveLength(1);
    expect(sup[0]).toMatchObject({ goal: R1.G, step: R1.D });
    expect(sup[0].payload).toStrictEqual({ lineage, pulse: "p-1", by: R2.D, goal: R2.G, carried: 3 });
    expect((await v.slotOf(R2.G)).carry).toStrictEqual([{ step: "debrief", lineage, fps: [A, B, C].sort() }]);
    expect(await v.openSet(R2.D)).toStrictEqual([A, B, C].sort());
    expect(await v.ev("pulse.superseded")).toHaveLength(0);
    const order = (await v.since(seq))
      .filter((e) => SUP.includes(e.type) && (e.goal === R1.G || e.step === R2.D))
      .map((e) => [e.type, e.step ?? e.goal]);
    expect(order).toStrictEqual([
      ["step.ready", R2.D],
      ["goal.dropped", R1.G],
      ["step.dropped", R1.D],
      ["step.dropped", R1.F],
      ["review.superseded", R1.D],
    ]);
    // The carried C is decided in G2's review and filed by G2's file step.
    const res = await v.decideOk("ann", R2.D, [dis(A), dis(B), acc(C)]);
    expect(res.next).toStrictEqual([{ step: R2.F, state: "ready" }]);
    await v.k.k.claim(v.ann, R2.F);
    const ins = ((await v.k.k.ctx(v.ann, R2.F)).inputs as Json[]).filter((i) => i.title === "items and dispositions");
    expect(ins).toHaveLength(1);
    const content = JSON.parse(ins[0].content);
    expect((content.items as Json[]).map((x) => x.fp)).toStrictEqual([C]);
    expect(content.items[0].evidence).toStrictEqual(EV_C);
    await record(v.k, R2.F, { dispositions: [{ fingerprint: C, disposition: "accepted", reason: "filed", link: "https://tracker.example/C" }], claimed: true });
    const cag = await v.cag();
    expect(cag, "a clean-audit goal of topic audit").toBeDefined();
    const view = await v.k.goalView(cag?.id as string);
    expect((view.steps as Json[]).filter((s) => s.finding?.fp === C)).toHaveLength(1);
  });
});

describe("RL-29 AC-10b an older review that becomes ready after a newer one", { timeout: 120_000 }, () => {
  it("test_AC10b_older_ready_later", async () => {
    const v = await start();
    const R1 = await v.fire();
    const lineage = await v.audit(R1);
    await v.patchStep(R1.V, { state: "parked", parkedReason: "round cap (3)", parkedAt: v.w.clock });
    const R2 = await v.fire();
    await v.audit(R2, [IA, IB], "partial");
    await v.validate(R2, [A, B], lineage);
    expect((await v.step(R2.D)).state, "control: G2's review is ready").toBe("ready");
    expect(await v.goalState(R1.G), "control: G1 is still open").not.toBe("dropped");
    const resumed = await v.k.r.call(v.ann, "POST", `/v1/steps/${R1.V}/resume`, {});
    expect(resumed.status, JSON.stringify(resumed.json)).toBe(200);
    const seq = await v.lastSeq();
    // record() asserts the review 201 and the done 200 of the validator.
    await v.validate(R1, [A, B, C], lineage);
    expect(await v.goalState(R1.G)).toBe("dropped");
    expect(await v.goalState(R2.G)).not.toBe("dropped");
    const sup = await v.ev("review.superseded");
    expect(sup).toHaveLength(1);
    expect(sup[0]).toMatchObject({ goal: R1.G, step: R1.D, payload: { by: R2.D, goal: R2.G, carried: 3 } });
    expect((await v.slotOf(R2.G)).carry).toStrictEqual([{ step: "debrief", lineage, fps: [A, B, C].sort() }]);
    const evs = (await v.since(seq)).map((e) => [e.type, e.step ?? e.goal]);
    const at = (t: string, s: string) => evs.findIndex(([x, y]) => x === t && y === s);
    expect(at("step.done", R1.V)).toBeGreaterThanOrEqual(0);
    expect(at("step.ready", R1.D)).toBeGreaterThan(at("step.done", R1.V));
    expect(at("goal.dropped", R1.G)).toBeGreaterThan(at("step.ready", R1.D));
    const res = await v.decide("ann", R1.D, [acc(A), dis(B), dis(C)]);
    expect([res.status, res.json.code]).toStrictEqual([409, "review-not-open"]);
    expect(res.json.error).toContain(`superseded by ${R2.D}`);
  });
});

describe("RL-29 AC-11 when an older review is kept", { timeout: 180_000 }, () => {
  const kept = async (v: Rv, R1: Run) => {
    expect(await v.goalState(R1.G)).not.toBe("dropped");
    expect(await v.ev("review.superseded")).toHaveLength(0);
  };

  it("test_AC11_claimed_or_decided", async () => {
    let w = await start();
    let R1 = await w.run();
    await w.k.k.claim(w.ann, R1.D);
    await w.run();
    await kept(w, R1);
    await w.stop();
    w = await start();
    R1 = await w.run();
    await w.k.k.claim(w.ann, R1.D);
    await w.k.personDispose(w.ann, R1.D, A, "accepted");
    expect((await w.k.r.call(w.ann, "POST", `/v1/steps/${R1.D}/release`, {})).status).toBe(200);
    expect((await w.step(R1.D)).state, "control: released").toBe("ready");
    await w.run();
    await kept(w, R1);
  });

  it("test_AC11_trial", async () => {
    let w = await start();
    let R1 = await w.run("p-1", { trial: true });
    await w.run();
    await kept(w, R1);
    await w.stop();
    w = await start();
    R1 = await w.run();
    await w.run("p-1", { trial: true });
    await kept(w, R1);
  });

  it("test_AC11_other_lineage_or_pulse", async () => {
    let w = await start();
    let R1 = await w.run();
    const up = await w.pk.act("ann", "p-1", "update", { params: { repo: "alpha", agent: "auditor2" } });
    expect(up.status, JSON.stringify(up.json)).toBe(200);
    await w.run();
    await kept(w, R1);
    await w.stop();
    w = await start();
    const q = await w.pulse("bob");
    R1 = await w.run(q, { who: "bob" });
    expect((await w.view(R1.D)).assignee, "control: bob's review").toBe("bob");
    await w.run("p-1");
    await kept(w, R1);
  });

  it("test_AC11_other_paused_step", async () => {
    const w = await start();
    const R1 = await w.run();
    await w.patchStep(R1.F, { state: "paused", holderUser: "ann", claimedAt: w.w.clock, pausedAt: w.w.clock });
    await w.run();
    await kept(w, R1);
  });

  it("test_AC11_ready_again_after_release", async () => {
    const w = await start();
    const R1 = await w.run();
    await w.k.k.claim(w.ann, R1.D);
    const R2 = await w.run();
    expect((await w.k.r.call(w.ann, "POST", `/v1/steps/${R1.D}/release`, {})).status).toBe(200);
    await w.k.k.claim(w.ann, R2.D);
    expect((await w.k.r.call(w.ann, "POST", `/v1/steps/${R2.D}/release`, {})).status).toBe(200);
    expect((await w.step(R2.D)).state, "control: G2's review is ready again").toBe("ready");
    await kept(w, R1);
  });

  it("test_AC11_paused_untouched_is_superseded", async () => {
    const w = await start();
    const R1 = await w.run();
    await w.patchStep(R1.D, { state: "paused", holderUser: "ann", claimedAt: w.w.clock, pausedAt: w.w.clock });
    const R2 = await w.run();
    expect(await w.goalState(R1.G)).toBe("dropped");
    expect((await w.ev("review.superseded"))[0]?.payload.by).toBe(R2.D);
  });
});

describe("RL-29 AC-11 a review reopened from done is not a settle", { timeout: 120_000 }, () => {
  it("test_AC11_reopened_by_gate_kept", async () => {
    const w = await start({ gate: true });
    const R1 = await w.run();
    await w.decideOk("ann", R1.D, [acc(A), dis(B), dis(C)]);
    const R2 = await w.run();
    expect((await w.step(R2.D)).state, "control: G2's review is open").toBe("ready");
    const rej = await w.k.r.call(w.ann, "POST", `/v1/steps/${R1.G}.g/reject`, { reopen: ["debrief"], comment: "again" });
    expect(rej.status, JSON.stringify(rej.json)).toBe(200);
    expect((await w.step(R1.D)).state, "control: G1's review reopened").toBe("ready");
    expect(await w.goalState(R1.G)).not.toBe("dropped");
    expect(await w.ev("review.superseded")).toHaveLength(0);
  });
});

describe("RL-29 REQ-REVSUP-2 the carry cap keeps the most severe", () => {
  it("test_carry_cap_item_order", () => {
    const row = (fp: string, severity: string, at: number) => ({ fp, severity, first: { at } }) as never;
    const rows = [row("zzzzzzzzzzzzzzzz", "S1", 5000), ...Array.from({ length: 1000 }, (_, i) => row(`a${String(i).padStart(15, "0")}`, "S4", i))];
    const kept = carryFps(rows);
    expect(kept).toHaveLength(1000);
    expect(kept).toContain("zzzzzzzzzzzzzzzz");
    expect(kept).not.toContain(`a${String(999).padStart(15, "0")}`);
    expect(kept).toStrictEqual([...kept].sort());
  });
});

describe("RL-29 AC-12 decisions carry over by fingerprint", { timeout: 120_000 }, () => {
  it("test_AC12_carry_over", async () => {
    const v = await start();
    const R1 = await v.run();
    const lineage = (await v.reviews(R1.AU))[0].lineage as string;
    const until = dayOf(v.w.clock, 30);
    await v.decideOk("ann", R1.D, [acc(A), dis(B), def(C, until)]);
    const R2 = await v.run();
    expect(await v.openSet(R2.D)).toStrictEqual([]);
    expect((await v.item(A, lineage)).state).toBe("accepted");
    expect((await v.item(B, lineage)).state).toBe("dismissed");
    expect(await v.item(C, lineage)).toMatchObject({ state: "deferred", until });
    // Past C's until: C opens, the validator confirms it, G3 lists C only.
    // Two steps, each within the device tokens' idle limit (30 days).
    v.w.clock += 16 * DAY;
    await v.goals();
    v.w.clock += 16 * DAY;
    const R3 = await v.run();
    expect((await v.item(C, lineage)).state).toBe("confirmed");
    expect(await v.openSet(R3.D)).toStrictEqual([C]);
    // B's evidence changed: B is open again (regression) and listed after validation.
    const R4 = await v.fire();
    const res = await record(v.k, R4.AU, { items: [IA, item("B", { severity: "S2", title: "T-B", eh: EH2 }), IC], agent: { key: "alpha/auditor", hash: "a".repeat(64) } });
    expect((res.items as Json[]).find((x) => x.fp === B)).toMatchObject({ mark: "regression", state: "open" });
    await v.validate(R4, [A, B, C], lineage);
    expect(await v.openSet(R4.D)).toContain(B);
  });
});

describe("RL-29 AC-13 RL-15 supersede at fire time", { timeout: 120_000 }, () => {
  it("test_AC13_fire_time_supersede", async () => {
    const v = await start({ overlap: "supersede" });
    const R1 = await v.run();
    const R2 = await v.fire();
    expect(await v.goalState(R1.G)).toBe("dropped");
    const ps = await v.ev("pulse.superseded");
    expect(ps.map((e) => e.payload.goal)).toStrictEqual([R1.G]);
    expect((await v.slotOf(R2.G)).carry?.[0]?.fps).toStrictEqual([A, B, C].sort());
    expect(await v.ev("review.superseded")).toHaveLength(0);
  });
});
