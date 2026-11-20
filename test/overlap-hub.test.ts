// RL-15 World tests of the overlap policies `queue` and `supersede` (docs/specs/RL-15.md): queue,
// replace and release (AC-03), supersede (AC-04), the debrief carry (AC-05), sinks on supersede
// (AC-06) and the default (AC-11).

import { afterEach, describe, expect, it } from "vitest";
import { disp, fpOf, item, type Ck } from "./helpers/calib-kit.ts";
import { topic } from "./helpers/health-kit.ts";
import { auditAndValidate, DAY, debriefView, events, HOUR, record, relayPulse, relayText, start, startRun } from "./helpers/overlap-kit.ts";
import { iso, T0, type Pk } from "./helpers/pulse-kit.ts";
import type { Json } from "./helpers/world.ts";

const A = fpOf("A");
const B = fpOf("B");
const C = fpOf("C");

let k: Ck | undefined;
afterEach(async () => {
  await k?.stop();
  k = undefined;
});

async function goalsOfPulse(pk: Pk): Promise<string[]> {
  return pk.goalsOfPulse("p-1");
}

// =============================================================================================
// AC-03 Queue
// =============================================================================================

describe("RL-15 AC-03 queue", { timeout: 120_000 }, () => {
  it("test_AC03_queue_replace_release", async () => {
    const s = await start();
    k = s.k;
    const { pk } = s;
    await pk.pulseOk("ann", relayPulse({ overlap: "queue", maxGoalAge: "30d" }));
    await pk.tickAt(T0);
    const G1 = (await pk.slotOf("p-1", iso(T0))).goal as string;
    await startRun(k, `${G1}.audit`);
    await pk.tickAt(T0 + 1000);
    // Slot 2: G1 is busy → queued.
    await pk.tickAt(T0 + DAY);
    const s2 = await pk.slotOf("p-1", iso(T0 + DAY));
    expect(s2.state).toBe("queued");
    expect(s2.running).toBe(G1);
    expect(s2.queued).toBe(true);
    expect(s2.goal).toBeUndefined();
    const queuedEv = (await events(k, "pulse.queued")).map((e) => e.payload);
    expect(queuedEv).toStrictEqual([{ pulse: "p-1", slot: iso(T0 + DAY), running: G1 }]);
    // Slot 3: still busy → slot 2 replaced, slot 3 queued.
    await pk.tickAt(T0 + 2 * DAY);
    const s2b = await pk.slotOf("p-1", iso(T0 + DAY));
    expect(s2b).toMatchObject({ state: "skipped", reason: "overlap", running: G1, queued: true });
    const s3 = await pk.slotOf("p-1", iso(T0 + 2 * DAY));
    expect(s3.state).toBe("queued");
    const skippedEv = (await events(k, "pulse.skipped")).map((e) => e.payload);
    expect(skippedEv).toStrictEqual([{ pulse: "p-1", slot: iso(T0 + DAY), reason: "overlap", running: G1, replacedBy: iso(T0 + 2 * DAY) }]);
    expect((await pk.slotsOf("p-1")).filter((x) => x.state === "queued")).toHaveLength(1);
    // G1 ends its machine work (it waits on its debrief): the next tick releases slot 3.
    await record(k, `${G1}.audit`, { items: [], agent: { key: "alpha/auditor" }, claimed: true });
    await record(k, `${G1}.validate`, { dispositions: [], agent: { key: "alpha/validator" } });
    expect((await k.r.stepOf(`${G1}.debrief`)).state).toBe("ready");
    const nextAt = (await pk.pulseOf("p-1")).nextAt;
    const rel = T0 + 2 * DAY + HOUR;
    await pk.tickAt(rel);
    const s3b = await pk.slotOf("p-1", iso(T0 + 2 * DAY));
    expect(s3b.state).toBe("fired");
    expect(s3b.queued).toBe(true);
    expect(s3b.firedAt).toBe(rel);
    expect(s3b.until).toBe(rel + 4 * HOUR);
    expect(typeof s3b.goal).toBe("string");
    const fired = (await events(k, "pulse.fired")).filter((e) => e.payload.slot === iso(T0 + 2 * DAY));
    expect(fired.map((e) => e.payload)).toStrictEqual([{ pulse: "p-1", slot: iso(T0 + 2 * DAY), queued: true }]);
    expect((await pk.pulseOf("p-1")).nextAt).toBe(nextAt);
    const goals = await goalsOfPulse(pk);
    await pk.tickAt(rel + 1000);
    expect(await goalsOfPulse(pk)).toStrictEqual(goals);
  });

  it("test_AC03_manual_trial", async () => {
    const s = await start();
    k = s.k;
    const { pk } = s;
    await pk.pulseOk("ann", relayPulse({ overlap: "queue", maxGoalAge: "30d" }));
    const G = (await pk.fireOk("ann", "p-1")).goal as string;
    await startRun(k, `${G}.audit`);
    // A manual fire while G is busy queues (201).
    const m = await pk.act("ann", "p-1", "fire");
    expect(m.status).toBe(201);
    expect(m.json.slot.state).toBe("queued");
    expect(m.json.slot.manual).toBe(true);
    // A trial fire while busy is skipped.
    const t1 = await pk.act("ann", "p-1", "fire", { trial: true });
    expect(t1.json.slot.state).toBe("skipped");
    expect((await pk.slotOf("p-1", m.json.slot.slot)).state).toBe("queued");
    // G ends; before a tick a trial fire creates its goal and leaves the queued slot alone.
    await record(k, `${G}.audit`, { items: [], agent: { key: "alpha/auditor" }, claimed: true });
    await record(k, `${G}.validate`, { dispositions: [], agent: { key: "alpha/validator" } });
    const t2 = await pk.act("ann", "p-1", "fire", { trial: true });
    expect(t2.json.slot.state).toBe("fired");
    expect(t2.json.slot.trial).toBe(true);
    expect((await pk.slotOf("p-1", m.json.slot.slot)).state).toBe("queued");
    // The manual queued slot fires at the next tick: `manual` in the event, no user.
    k.tick(1000);
    await k.w.tick();
    const released = await pk.slotOf("p-1", m.json.slot.slot);
    expect(released.state).toBe("fired");
    const ev = (await events(k, "pulse.fired")).filter((e) => e.payload.slot === m.json.slot.slot);
    expect(ev).toHaveLength(1);
    expect(ev[0]?.payload).toStrictEqual({ pulse: "p-1", slot: m.json.slot.slot, manual: true, queued: true });
    expect(ev[0]?.user).toBeUndefined();
  });

  it("test_AC03_fire_replaces_queued", async () => {
    // A non-trial fire that creates a goal replaces the queued slot.
    const s = await start();
    k = s.k;
    const { pk } = s;
    await pk.pulseOk("ann", relayPulse({ overlap: "queue", maxGoalAge: "30d" }));
    const G = (await pk.fireOk("ann", "p-1")).goal as string;
    await startRun(k, `${G}.audit`);
    const q = (await pk.act("ann", "p-1", "fire")).json.slot.slot as string;
    await record(k, `${G}.audit`, { items: [], agent: { key: "alpha/auditor" }, claimed: true });
    await record(k, `${G}.validate`, { dispositions: [], agent: { key: "alpha/validator" } });
    k.tick(1000);
    const f = await pk.act("ann", "p-1", "fire");
    expect(f.json.slot.state).toBe("fired");
    expect((await pk.slotOf("p-1", q)).state).toBe("skipped");
    expect((await events(k, "pulse.skipped")).find((e) => e.payload.slot === q)?.payload).toStrictEqual({ pulse: "p-1", slot: q, reason: "overlap", running: G, replacedBy: f.json.slot.slot });
  });

  it("test_AC03_policy_change_pause_delete", async () => {
    const s = await start();
    k = s.k;
    const { pk } = s;
    await pk.pulseOk("ann", relayPulse({ overlap: "queue", maxGoalAge: "30d" }));
    const G = (await pk.fireOk("ann", "p-1")).goal as string;
    await startRun(k, `${G}.audit`);
    const q1 = (await pk.act("ann", "p-1", "fire")).json.slot.slot as string;
    // Policy changed to skip → the next tick skips it, without replacedBy.
    expect((await pk.act("ann", "p-1", "update", { overlap: "skip" })).status).toBe(200);
    k.tick(1000);
    await k.w.tick();
    expect((await pk.slotOf("p-1", q1)).state).toBe("skipped");
    expect((await events(k, "pulse.skipped")).find((e) => e.payload.slot === q1)?.payload).toStrictEqual({ pulse: "p-1", slot: q1, reason: "overlap", running: G });
    // Paused: a queued slot stays queued after the busy goal ends.
    expect((await pk.act("ann", "p-1", "update", { overlap: "queue" })).status).toBe(200);
    const q2 = (await pk.act("ann", "p-1", "fire")).json.slot.slot as string;
    expect((await pk.slotOf("p-1", q2)).state).toBe("queued");
    expect((await pk.act("ann", "p-1", "pause")).status).toBe(200);
    await record(k, `${G}.audit`, { items: [], agent: { key: "alpha/auditor" }, claimed: true });
    await record(k, `${G}.validate`, { dispositions: [], agent: { key: "alpha/validator" } });
    k.tick(1000);
    await k.w.tick();
    expect((await pk.slotOf("p-1", q2)).state).toBe("queued");
    // Deleted: skipped at the next tick.
    expect((await pk.act("ann", "p-1", "delete")).status).toBe(200);
    k.tick(1000);
    await k.w.tick();
    // A deleted pulse answers 404 to reads; read the slot from the store.
    const slot = await (k.w.hub.svc as unknown as { store: { getSlot(p: string, s: string): Promise<Json | undefined> } }).store.getSlot("p-1", q2);
    expect(slot?.state).toBe("skipped");
  });
});

// =============================================================================================
// AC-04 Supersede
// =============================================================================================

describe("RL-15 AC-04 supersede", { timeout: 120_000 }, () => {
  it("test_AC04_supersede", async () => {
    const s = await start();
    k = s.k;
    const { pk } = s;
    await pk.pulseOk("ann", relayPulse({ overlap: "supersede" }));
    await pk.tickAt(T0);
    const G1 = (await pk.slotOf("p-1", iso(T0))).goal as string;
    await auditAndValidate(k, G1, [], []);
    expect((await k.r.stepOf(`${G1}.debrief`)).state).toBe("ready");
    // A trial goal fired after slot 1, also waiting at its debrief.
    pk.at(T0 + HOUR);
    const T = (await pk.act("ann", "p-1", "fire", { trial: true })).json.slot.goal as string;
    await auditAndValidate(k, T, [], []);
    await pk.tickAt(T0 + DAY);
    const s2 = await pk.slotOf("p-1", iso(T0 + DAY));
    expect(s2.state).toBe("fired");
    expect(s2.superseded).toStrictEqual([T, G1]);
    expect(await pk.goalState(G1)).toBe("dropped");
    expect(await pk.goalState(T)).toBe("dropped");
    expect((await k.r.stepOf(`${G1}.debrief`)).state).toBe("dropped");
    expect((await pk.slotOf("p-1", iso(T0))).state).toBe("fired");
    const dropped = (await events(k, "goal.dropped")).filter((e) => e.goal === G1 || e.goal === T);
    expect(dropped.map((e) => e.payload.reason)).toStrictEqual(["superseded", "superseded"]);
    expect((await events(k, "step.dropped")).find((e) => e.step === `${G1}.debrief`)?.payload.reason).toBe("superseded");
    const sup = (await events(k, "pulse.superseded")).map((e) => e.payload);
    expect(sup).toStrictEqual([
      { pulse: "p-1", slot: iso(T0 + DAY), goal: T, from: (await pk.slotsOf("p-1")).find((x) => x.goal === T)?.slot },
      { pulse: "p-1", slot: iso(T0 + DAY), goal: G1, from: iso(T0) },
    ]);
  });

  it("test_AC04_held_busy_trial", async () => {
    const s = await start();
    k = s.k;
    const { pk } = s;
    await pk.pulseOk("ann", relayPulse({ overlap: "supersede", maxGoalAge: "30d" }));
    await pk.tickAt(T0);
    const G1 = (await pk.slotOf("p-1", iso(T0))).goal as string;
    await auditAndValidate(k, G1, [], []);
    // A trial fire drops nothing.
    const t = await pk.act("ann", "p-1", "fire", { trial: true });
    expect(t.json.slot.superseded).toBeUndefined();
    expect(await pk.goalState(G1)).not.toBe("dropped");
    // A held debrief keeps its goal.
    await k.k.claim(k.c.ann, `${G1}.debrief`);
    // The trial goal is busy-free but not in a non-trial fire's way: drop it by hand first.
    const T = t.json.slot.goal as string;
    expect((await k.r.call(k.c.ann, "POST", `/v1/goals/${T}/drop`, {})).status).toBe(200);
    await pk.tickAt(T0 + DAY);
    const s2 = await pk.slotOf("p-1", iso(T0 + DAY));
    expect(s2.state).toBe("fired");
    expect(s2.superseded).toBeUndefined();
    expect(await pk.goalState(G1)).not.toBe("dropped");
    // A busy goal: the slot is skipped and nothing is dropped.
    const G2 = s2.goal as string;
    await startRun(k, `${G2}.audit`);
    await pk.tickAt(T0 + DAY + 1000);
    await pk.tickAt(T0 + 2 * DAY);
    const s3 = await pk.slotOf("p-1", iso(T0 + 2 * DAY));
    expect(s3).toMatchObject({ state: "skipped", reason: "overlap", running: G2 });
    expect(await pk.goalState(G1)).not.toBe("dropped");
  });

  it("test_AC04_max_goal_age", async () => {
    const s = await start();
    k = s.k;
    const { pk } = s;
    await pk.pulseOk("ann", relayPulse({ overlap: "supersede" }));
    await pk.tickAt(T0);
    const G1 = (await pk.slotOf("p-1", iso(T0))).goal as string;
    await startRun(k, `${G1}.audit`);
    await pk.tickAt(T0 + 1000);
    await pk.tickAt(T0 + DAY);
    expect((await pk.slotOf("p-1", iso(T0 + DAY))).state).toBe("skipped");
    await record(k, `${G1}.audit`, { items: [], agent: { key: "alpha/auditor" }, claimed: true });
    await record(k, `${G1}.validate`, { dispositions: [], agent: { key: "alpha/validator" } });
    // Two days after G1 was created (the default maxGoalAge): superseded, not abandoned.
    await pk.tickAt(T0 + 2 * DAY);
    expect((await pk.slotOf("p-1", iso(T0))).state).toBe("fired");
    expect((await pk.slotOf("p-1", iso(T0 + 2 * DAY))).superseded).toStrictEqual([G1]);
    expect((await events(k, "goal.dropped")).find((e) => e.goal === G1)?.payload.reason).toBe("superseded");
    // A busy goal past maxGoalAge is still abandoned.
    const G3 = (await pk.slotOf("p-1", iso(T0 + 2 * DAY))).goal as string;
    await startRun(k, `${G3}.audit`);
    await pk.tickAt(T0 + 2 * DAY + 1000);
    await pk.tickAt(T0 + 4 * DAY);
    expect((await pk.slotOf("p-1", iso(T0 + 2 * DAY))).state).toBe("abandoned");
    expect((await events(k, "goal.dropped")).find((e) => e.goal === G3)?.payload.reason).toBe("abandoned");
  });
});

// =============================================================================================
// AC-05 Carry
// =============================================================================================

const EV = [{ path: "src/a.ts", lines: [3, 4] }];

describe("RL-15 AC-05 carry", { timeout: 120_000 }, () => {
  it("test_AC05_carry_partial", async () => {
    const s = await start();
    k = s.k;
    const { pk } = s;
    await pk.pulseOk("ann", relayPulse({ overlap: "supersede" }));
    await pk.tickAt(T0);
    const G1 = (await pk.slotOf("p-1", iso(T0))).goal as string;
    const lineage = await auditAndValidate(k, G1, [item("A", { evidence: EV }), item("B"), item("C")], [disp(A, "confirmed"), disp(B, "confirmed"), disp(C, "dismissed")], "partial");
    await pk.tickAt(T0 + DAY);
    const s2 = await pk.slotOf("p-1", iso(T0 + DAY));
    expect(s2.carry).toStrictEqual([{ step: "debrief", lineage, fps: [A, B].sort() }]);
    const G2 = s2.goal as string;
    await auditAndValidate(k, G2, [item("B")], [], "partial");
    const v = await debriefView(k, `${G2}.debrief`);
    expect((v.items as Json[]).map((i) => i.fp).sort()).toStrictEqual([A, B].sort());
    expect((v.items as Json[]).find((i) => i.fp === A)?.evidence).toStrictEqual(EV);
    await k.k.claim(k.c.ann, `${G2}.debrief`);
    await k.personDispose(k.c.ann, `${G2}.debrief`, A, "accepted");
    const bad = await k.r.call(k.c.ann, "POST", `/v1/steps/${G2}.debrief/dispositions`, { fingerprint: C, disposition: "accepted", reason: "r", answer: "a" });
    expect(bad.status).toBe(422);
    expect(bad.json.error).toBe(`no item ${C} in the record of ${G2}.audit`);
  });

  it("test_AC05_carry_complete_resolved", async () => {
    // G1 partial, G2 complete without A: A stays confirmed and listed.
    let s = await start();
    k = s.k;
    await s.pk.pulseOk("ann", relayPulse({ overlap: "supersede" }));
    await s.pk.tickAt(T0);
    let G1 = (await s.pk.slotOf("p-1", iso(T0))).goal as string;
    await auditAndValidate(k, G1, [item("A"), item("B")], [disp(A, "confirmed"), disp(B, "confirmed")], "partial");
    await s.pk.tickAt(T0 + DAY);
    let G2 = (await s.pk.slotOf("p-1", iso(T0 + DAY))).goal as string;
    let lineage = await auditAndValidate(k, G2, [item("B")], [], "complete");
    expect((await k.item(A, lineage)).state).toBe("confirmed");
    expect(((await debriefView(k, `${G2}.debrief`)).items as Json[]).map((i) => i.fp)).toContain(A);
    // A carried item dismissed meanwhile is not listed.
    await k.k.claim(k.c.ann, `${G2}.debrief`);
    await k.personDispose(k.c.ann, `${G2}.debrief`, A, "dismissed");
    expect(((await debriefView(k, `${G2}.debrief`)).items as Json[]).map((i) => i.fp)).not.toContain(A);
    await k.stop();
    // G1 complete, G2 complete without A: A is resolved and not listed.
    s = await start();
    k = s.k;
    await s.pk.pulseOk("ann", relayPulse({ overlap: "supersede" }));
    await s.pk.tickAt(T0);
    G1 = (await s.pk.slotOf("p-1", iso(T0))).goal as string;
    await auditAndValidate(k, G1, [item("A"), item("B")], [disp(A, "confirmed"), disp(B, "confirmed")], "complete");
    await s.pk.tickAt(T0 + DAY);
    G2 = (await s.pk.slotOf("p-1", iso(T0 + DAY))).goal as string;
    lineage = await auditAndValidate(k, G2, [item("B")], [], "complete");
    expect((await k.item(A, lineage)).state).toBe("resolved");
    expect(((await debriefView(k, `${G2}.debrief`)).items as Json[]).map((i) => i.fp)).toStrictEqual([B]);
  });

  it("test_AC05_chain_and_when", async () => {
    const s = await start();
    k = s.k;
    const { pk } = s;
    await pk.pulseOk("ann", relayPulse({ overlap: "supersede" }, relayText({ when: true })));
    await pk.tickAt(T0);
    const G1 = (await pk.slotOf("p-1", iso(T0))).goal as string;
    await auditAndValidate(k, G1, [item("A")], [disp(A, "confirmed")], "partial");
    await pk.tickAt(T0 + DAY);
    const G2 = (await pk.slotOf("p-1", iso(T0 + DAY))).goal as string;
    // G2's run raises nothing: its debrief (when: open) is still ready for the carried A.
    await auditAndValidate(k, G2, [], [], "partial");
    expect((await k.r.stepOf(`${G2}.debrief`)).state).toBe("ready");
    await pk.tickAt(T0 + 2 * DAY);
    const s3 = await pk.slotOf("p-1", iso(T0 + 2 * DAY));
    expect(s3.superseded).toStrictEqual([G2]);
    expect((s3.carry as Json[])[0]?.fps).toStrictEqual([A]);
    const G3 = s3.goal as string;
    await auditAndValidate(k, G3, [], [], "partial");
    expect(((await debriefView(k, `${G3}.debrief`)).items as Json[]).map((i) => i.fp)).toStrictEqual([A]);
  });
});

// =============================================================================================
// AC-06 Sinks on supersede
// =============================================================================================

describe("RL-15 AC-06 sinks", { timeout: 120_000 }, () => {
  it("test_AC06_sink_on_supersede", async () => {
    const s = await start();
    k = s.k;
    const { pk } = s;
    await topic(k, "ci");
    await pk.pulseOk("ann", relayPulse({ overlap: "supersede" }, relayText({ debrief: "    sink: { topic: ci }\n" })));
    await pk.tickAt(T0);
    const G1 = (await pk.slotOf("p-1", iso(T0))).goal as string;
    const D = fpOf("D");
    await auditAndValidate(k, G1, [item("D")], [disp(D, "confirmed")]);
    await k.k.claim(k.c.ann, `${G1}.debrief`);
    await k.personDispose(k.c.ann, `${G1}.debrief`, D, "accepted", { link: "https://tracker.example/1" });
    expect((await k.r.call(k.c.ann, "POST", `/v1/steps/${G1}.debrief/release`, {})).status).toBe(200);
    expect(await k.calibGoals()).toHaveLength(0);
    await pk.tickAt(T0 + DAY);
    expect(await pk.goalState(G1)).toBe("dropped");
    const all = new Map<string, Json>();
    for (const q of ["", "?pulses=1"]) for (const g of await k.goals(k.c.ann, q)) all.set(g.id, g);
    const clean = [...all.values()].filter((g) => g.sink);
    expect(clean).toHaveLength(1);
    expect(clean[0]?.state).not.toBe("dropped");
    const view = await k.goalView(clean[0]?.id as string);
    expect((view.steps as Json[]).filter((x) => x.finding?.fp === D)).toHaveLength(1);
  });
});

// =============================================================================================
// AC-11 Default
// =============================================================================================

describe("RL-15 AC-11 default", { timeout: 60_000 }, () => {
  it("test_AC11_default_and_features", async () => {
    const s = await start();
    k = s.k;
    const p = await s.pk.pulseOk("ann", relayPulse());
    expect(p.overlap).toBe("skip");
    const bad = await s.pk.pulse("ann", relayPulse({ overlap: "later" }));
    expect(bad.status).toBe(400);
    expect((await k.w.call(undefined as never, "GET", "/healthz")).json.features).toEqual(expect.arrayContaining(["debrief-sla", "overlap-policy"]));
  });
});
