// RL-15 World tests of the debrief SLA (docs/specs/RL-15.md): events and attention (AC-07),
// auto-accept (AC-08), its revert (AC-09), health and run cards (AC-10).

import { afterEach, describe, expect, it } from "vitest";
import { disp, fpOf, item, type Ck } from "./helpers/calib-kit.ts";
import { attention, auditAndValidate, DAY, debriefView, events, HOUR, record, relayPulse, relayText, start, startRun } from "./helpers/overlap-kit.ts";
import { iso, T0, type Pk } from "./helpers/pulse-kit.ts";
import type { Json } from "./helpers/world.ts";

let k: Ck | undefined;
afterEach(async () => {
  await k?.stop();
  k = undefined;
});

const SLA = "    sla: 2h\n";
const BOB = "    assignee: bob\n";

/** The time the goal's debrief became ready: the validate step's first done round. */
async function readyAt(c: Ck, G: string): Promise<number> {
  const v = await c.r.stepOf(`${G}.validate`);
  return (v.rounds as Json[])[0]?.finishedAt as number;
}

// =============================================================================================
// AC-07 Events and attention
// =============================================================================================

describe("RL-15 AC-07 SLA events and attention", { timeout: 120_000 }, () => {
  it("test_AC07_events_attention", async () => {
    const s = await start();
    k = s.k;
    const { pk } = s;
    await pk.pulseOk("ann", relayPulse({}, relayText({ debrief: SLA + BOB })));
    await pk.tickAt(T0);
    const G = (await pk.slotOf("p-1", iso(T0))).goal as string;
    await auditAndValidate(k, G, [], []);
    const t = await readyAt(k, G);
    const D = `${G}.debrief`;
    const updatedAt = (await k.r.stepOf(D)).updatedAt;
    await pk.tickAt(t + 2 * HOUR - 1);
    expect(await events(k, "debrief.overdue")).toHaveLength(0);
    expect((await attention(k, k.c.bob)).filter((a) => a.kind === "debrief_overdue")).toHaveLength(0);
    await pk.tickAt(t + 2 * HOUR + 1);
    const ev = await events(k, "debrief.overdue");
    expect(ev.map((e) => [e.goal, e.step, e.payload])).toStrictEqual([[G, D, { to: "assignee", user: "bob", round: 1, since: t, slaMs: 7_200_000, dueAt: t + 2 * HOUR }]]);
    const bobAtt = (await attention(k, k.c.bob)).filter((a) => a.kind === "debrief_overdue");
    expect(bobAtt).toStrictEqual([{ kind: "debrief_overdue", text: `Debrief ${D} "Debrief" is overdue: waiting since ${iso(t)}, SLA 2h`, goal: G, step: D, at: t + 2 * HOUR }]);
    expect((await attention(k, k.c.ann)).filter((a) => a.kind === "debrief_overdue")).toHaveLength(0);
    // Twice the SLA: the pulse owner.
    await pk.tickAt(t + 4 * HOUR + 1);
    const ev2 = await events(k, "debrief.overdue");
    expect(ev2.map((e) => e.payload.to)).toStrictEqual(["assignee", "owner"]);
    expect(ev2[1]?.payload).toStrictEqual({ to: "owner", user: "ann", round: 1, since: t, slaMs: 7_200_000, dueAt: t + 4 * HOUR });
    expect((await attention(k, k.c.ann)).filter((a) => a.kind === "debrief_overdue").map((a) => a.step)).toStrictEqual([D]);
    await pk.tickAt(t + 5 * HOUR);
    expect(await events(k, "debrief.overdue")).toHaveLength(2);
    expect((await k.r.stepOf(D)).updatedAt).toBe(updatedAt);
    expect((await k.r.stepOf(D)).overdue).toStrictEqual({ since: t, assigneeAt: t + 2 * HOUR + 1, ownerAt: t + 4 * HOUR + 1 });
  });

  it("test_AC07_reopened_debrief_new_cycle", async () => {
    // A later interactive step closes fail and reopens the done debrief: a new cycle, overdue again.
    const s = await start();
    k = s.k;
    const { pk } = s;
    const check = "  - id: check\n    kind: review\n    repo: \"{repo}\"\n    deps: [debrief]\n    title: Check\n    brief: Check.\n";
    await pk.pulseOk("ann", relayPulse({}, relayText({ debrief: SLA }) + check));
    await pk.tickAt(T0);
    const G = (await pk.slotOf("p-1", iso(T0))).goal as string;
    await auditAndValidate(k, G, [], []);
    const t = await readyAt(k, G);
    const D = `${G}.debrief`;
    await pk.tickAt(t + 2 * HOUR);
    expect((await events(k, "debrief.overdue")).map((e) => e.payload.since)).toStrictEqual([t]);
    pk.at(t + 3 * HOUR);
    // The person does the debrief; a later step reopens it.
    await record(k, D, { dispositions: [] });
    await k.k.claim(k.c.ann, `${G}.check`);
    const d = await k.k.close(k.c.ann, `${G}.check`, { outcome: "fail", summary: "again", reopen: [D] });
    expect(d.status, JSON.stringify(d.json)).toBe(200);
    const t2 = (((await k.r.stepOf(`${G}.check`)).rounds as Json[]).at(-1) as Json).finishedAt as number;
    expect((await k.r.stepOf(D)).state).toBe("ready");
    await pk.tickAt(t2 + HOUR);
    expect(await events(k, "debrief.overdue")).toHaveLength(1);
    await pk.tickAt(t2 + 2 * HOUR);
    const ev = await events(k, "debrief.overdue");
    expect(ev.map((e) => [e.payload.to, e.payload.since, e.payload.dueAt])).toStrictEqual([
      ["assignee", t, t + 2 * HOUR],
      ["assignee", t2, t2 + 2 * HOUR],
    ]);
    expect((await k.r.stepOf(D)).overdue).toStrictEqual({ since: t2, assigneeAt: t2 + 2 * HOUR });
  });

  it("test_AC07_same_owner_no_escalation", async () => {
    const s = await start();
    k = s.k;
    const { pk } = s;
    await pk.pulseOk("ann", relayPulse({}, relayText({ debrief: SLA })));
    await pk.tickAt(T0);
    const G = (await pk.slotOf("p-1", iso(T0))).goal as string;
    await auditAndValidate(k, G, [], []);
    const t = await readyAt(k, G);
    await pk.tickAt(t + 5 * HOUR);
    expect((await events(k, "debrief.overdue")).map((e) => e.payload.to)).toStrictEqual(["assignee"]);
    expect((await attention(k, k.c.ann)).filter((a) => a.kind === "debrief_overdue")).toHaveLength(1);
  });
});

// =============================================================================================
// AC-08 Auto-accept, AC-09 revert, AC-10 health
// =============================================================================================

const E = fpOf("E");
const F = fpOf("F");
const G_ = fpOf("G");
const H = fpOf("H");
const I = fpOf("I");
const ITEMS = [item("E", { severity: "S3" }), item("F", { severity: "S4" }), item("G", { severity: "S2" }), item("H", { severity: "S3" }), item("I", { severity: "S4" })];
const VALIDATE = [disp(E, "confirmed"), disp(F, "confirmed"), disp(G_, "confirmed")];

/** A pulse whose debrief has sla 2h, auto_accept S3/S4 and `assignee`; one goal past its SLA. */
async function autoFixture(o: { assignee?: string } = {}): Promise<{ pk: Pk; G: string; D: string; lineage: string; t: number }> {
  const s = await start();
  k = s.k;
  const { pk } = s;
  const top = "debrief:\n  sla: 2h\n  auto_accept: [S3, S4]\n";
  await pk.pulseOk("ann", relayPulse({}, relayText({ top, debrief: o.assignee ? `    assignee: ${o.assignee}\n` : "" })));
  await pk.tickAt(T0);
  const G = (await pk.slotOf("p-1", iso(T0))).goal as string;
  const lineage = await auditAndValidate(k, G, ITEMS, VALIDATE);
  const D = `${G}.debrief`;
  // A person confirms I in the debrief, then releases it.
  const who = o.assignee === "bob" ? k.c.bob : k.c.ann;
  await k.k.claim(who, D);
  await k.personDispose(who, D, I, "confirmed");
  expect((await k.r.call(who, "POST", `/v1/steps/${D}/release`, {})).status).toBe(200);
  const t = await readyAt(k, G);
  return { pk, G, D, lineage, t };
}

describe("RL-15 AC-08 auto-accept", { timeout: 120_000 }, () => {
  it("test_AC08_auto_accept", async () => {
    const { pk, G, D, lineage, t } = await autoFixture();
    const c = k as Ck;
    await pk.tickAt(t + 2 * HOUR - 1);
    expect((await c.item(E, lineage)).state).toBe("confirmed");
    await pk.tickAt(t + 2 * HOUR);
    for (const [fp, sev] of [[E, "S3"], [F, "S4"]] as const) {
      const it = await c.item(fp, lineage);
      expect(it.state).toBe("accepted");
      expect(it.link).toBeUndefined();
      const last = await c.lastDisposition(fp, lineage);
      expect(last).toMatchObject({ disposition: "accepted", decider: { kind: "agent", key: "mesh/debrief-sla" }, via: "auto-accept", reason: `accepted after the debrief SLA (2h): confirmed by alpha/validator at ${sev}`, goal: G, step: D, round: 1 });
      expect(last.link).toBeUndefined();
    }
    expect((await c.item(G_, lineage)).state).toBe("confirmed");
    expect((await c.item(H, lineage)).state).toBe("open");
    expect((await c.item(I, lineage)).state).toBe("confirmed");
    const disposed = (await events(c, "item.disposed")).filter((e) => e.payload.via === "auto-accept");
    expect(disposed.map((e) => e.payload.fp).sort()).toStrictEqual([E, F].sort());
    expect(disposed[0]?.payload).toMatchObject({ disposition: "accepted", from: "confirmed", decider: "agent", round: 1 });
    expect((await events(c, "debrief.auto_accepted")).map((e) => [e.step, e.payload])).toStrictEqual([[D, { round: 1, items: 2 }]]);
    expect((await events(c, "step.noted")).filter((e) => e.step === D)).toHaveLength(3);
    const decided = ((await debriefView(c, D)).decided as Json[]).filter((d) => d.via === "auto-accept");
    expect(decided.map((d) => [d.fp, d.revertable]).sort()).toStrictEqual([[E, true], [F, true]].sort());
    expect((await c.r.stepOf(D)).state).toBe("ready");
    // Further ticks change nothing.
    await pk.tickAt(t + 3 * HOUR);
    expect(await events(c, "debrief.auto_accepted")).toHaveLength(1);
  });

  it("test_AC08_session_decisions", async () => {
    const { pk, D, t } = await autoFixture();
    const c = k as Ck;
    await pk.tickAt(t + 2 * HOUR);
    await c.k.claim(c.c.ann, D);
    // Overrule F in the session without a revert.
    await c.personDispose(c.c.ann, D, F, "dismissed");
    // The closing record lists E as accepted: counted in `already`.
    const r = await c.k.review(c.c.ann, D, { coverage: "complete", assessment: "clean", items: [], dispositions: [disp(E, "accepted")], summary: "s" });
    expect(r.status, JSON.stringify(r.json)).toBe(201);
    expect(r.json.already).toStrictEqual([E]);
  });

  it("test_AC08_claimed_none_trial", async () => {
    const s = await start();
    k = s.k;
    const { pk } = s;
    const top = "debrief:\n  sla: 2h\n  auto_accept: [S3, S4]\n";
    await pk.pulseOk("ann", relayPulse({ overlap: "allow" }, relayText({ top })));
    await pk.pulseOk("ann", relayPulse({ overlap: "allow" }, relayText({ debrief: SLA }), "relay2"));
    // p-1: a claimed debrief past its SLA gets no auto-accept.
    const G1 = (await pk.fireOk("ann", "p-1")).goal as string;
    const l1 = await auditAndValidate(k, G1, [item("E", { severity: "S3" })], [disp(E, "confirmed")]);
    await k.k.claim(k.c.ann, `${G1}.debrief`);
    // p-1 trial goal: no event, attention or auto-accept.
    const T = (await pk.act("ann", "p-1", "fire", { trial: true })).json.slot.goal as string;
    await auditAndValidate(k, T, [item("E", { severity: "S3" }), item("F", { severity: "S3" })], [disp(F, "confirmed")]);
    // p-2: no auto_accept.
    const G2 = (await pk.fireOk("ann", "p-2")).goal as string;
    const l2 = await auditAndValidate(k, G2, [item("E", { severity: "S3" })], [disp(E, "confirmed")]);
    k.tick(3 * HOUR);
    await k.w.tick();
    expect((await k.item(E, l1)).state).toBe("confirmed");
    expect((await k.item(F, l1)).state).toBe("confirmed");
    expect((await k.item(E, l2)).state).toBe("confirmed");
    const overdue = await events(k, "debrief.overdue");
    expect(overdue.map((e) => e.goal).sort()).toStrictEqual([G1, G2].sort());
    expect((await attention(k, k.c.ann)).filter((a) => a.kind === "debrief_overdue").map((a) => a.goal).sort()).toStrictEqual([G1, G2].sort());
    expect(T).toBeTruthy();
  });
});

describe("RL-15 AC-09 revert", { timeout: 120_000 }, () => {
  it("test_AC09_revert", async () => {
    const { pk, D, lineage, t } = await autoFixture({ assignee: "bob" });
    const c = k as Ck;
    await pk.tickAt(t + 2 * HOUR);
    expect((await c.item(E, lineage)).state).toBe("accepted");
    const no = await c.r.call(c.c.carol as never, "POST", `/v1/steps/${D}/dispositions/revert`, { fingerprint: E });
    expect(no.status).toBe(403);
    expect(no.json.error).toBe("only bob, the goal owner or an admin can revert this");
    await c.revert(c.c.bob, D, E);
    expect((await c.item(E, lineage)).state).toBe("confirmed");
    expect((await events(c, "item.reverted")).map((e) => e.payload.fp)).toStrictEqual([E]);
    await pk.tickAt(t + 3 * HOUR);
    expect((await c.item(E, lineage)).state).toBe("confirmed");
    // A later complete audit resolves F: the auto-accept is no longer revertable.
    await pk.tickAt(T0 + DAY);
    const G2 = (await pk.slotOf("p-1", iso(T0 + DAY))).goal as string;
    await record(c, `${G2}.audit`, { items: [], agent: { key: "alpha/auditor" } });
    expect((await c.item(F, lineage)).state).toBe("resolved");
    const late = await c.r.call(c.c.bob, "POST", `/v1/steps/${D}/dispositions/revert`, { fingerprint: F });
    expect(late.status).toBe(409);
  });
});

describe("RL-15 AC-10 health and cards", { timeout: 120_000 }, () => {
  it("test_AC10_health_breaches", async () => {
    const { pk, G, D, t } = await autoFixture({ assignee: "bob" });
    const c = k as Ck;
    await pk.tickAt(t + 2 * HOUR + 5);
    const h = (await c.r.call(c.c.ann, "GET", "/v1/health")).json;
    const p = (h.pulses as Json[])[0] as Json;
    expect(p.debriefs.overdue).toBe(1);
    expect(p.debriefs.breaches).toStrictEqual([{ goal: G, step: D, assignee: "bob", owner: "ann", slaMs: 7_200_000, since: t, breachedAt: t + 2 * HOUR, escalated: false, autoAccepted: 2 }]);
    expect(h.total.debriefs.overdue).toBe(1);
    await pk.tickAt(t + 4 * HOUR);
    const p2 = ((await c.r.call(c.c.ann, "GET", "/v1/health")).json.pulses as Json[])[0] as Json;
    expect(p2.debriefs.breaches[0].escalated).toBe(true);
  });

  it("test_AC10_trial_breach_only_with_include", async () => {
    const s = await start();
    k = s.k;
    const { pk } = s;
    await pk.pulseOk("ann", relayPulse({}, relayText({ debrief: SLA })));
    const T = (await pk.act("ann", "p-1", "fire", { trial: true })).json.slot.goal as string;
    await auditAndValidate(k, T, [], []);
    k.tick(3 * HOUR);
    const ex = ((await k.r.call(k.c.ann, "GET", "/v1/health")).json.pulses as Json[])[0] as Json;
    expect(ex.debriefs.overdue).toBe(0);
    const inc = ((await k.r.call(k.c.ann, "GET", "/v1/health?trial=include")).json.pulses as Json[])[0] as Json;
    expect(inc.debriefs.overdue).toBe(1);
    expect(inc.debriefs.breaches[0].goal).toBe(T);
  });

  it("test_AC10_queue_supersede_cards", async () => {
    const s = await start();
    k = s.k;
    const { pk } = s;
    await pk.pulseOk("ann", relayPulse({ overlap: "queue", maxGoalAge: "30d" }));
    await pk.tickAt(T0);
    const G1 = (await pk.slotOf("p-1", iso(T0))).goal as string;
    await startRun(k, `${G1}.audit`);
    await pk.tickAt(T0 + 1000);
    await pk.tickAt(T0 + DAY);
    const h = ((await k.r.call(k.c.ann, "GET", "/v1/health")).json.pulses as Json[])[0] as Json;
    expect(h.slots.queued).toBe(1);
    expect(h.blockedBy).toMatchObject({ goal: G1, step: `${G1}.audit` });
    let cards = (await k.r.call(k.c.ann, "GET", "/v1/pulses/p-1/runs")).json.cards as Json[];
    expect(cards[0]).toMatchObject({ slot: iso(T0 + DAY), state: "queued", queued: true, superseded: [], stages: [] });
    // Release: startWaitMs from firedAt.
    await record(k, `${G1}.audit`, { items: [], agent: { key: "alpha/auditor" }, claimed: true });
    await record(k, `${G1}.validate`, { dispositions: [], agent: { key: "alpha/validator" } });
    await pk.tickAt(T0 + DAY + HOUR);
    const G2 = (await pk.slotOf("p-1", iso(T0 + DAY))).goal as string;
    pk.at(T0 + DAY + 2 * HOUR);
    await startRun(k, `${G2}.audit`);
    cards = (await k.r.call(k.c.ann, "GET", "/v1/pulses/p-1/runs")).json.cards as Json[];
    expect(cards[0]).toMatchObject({ state: "fired", queued: true, startWaitMs: HOUR });
    // Supersede: the card lists the dropped goals; blockedBy absent with allow.
    expect((await pk.act("ann", "p-1", "update", { overlap: "supersede" })).status).toBe(200);
    expect(((await k.r.call(k.c.ann, "GET", "/v1/health")).json.pulses as Json[])[0]?.blockedBy).toMatchObject({ goal: G2 });
    expect((await pk.act("ann", "p-1", "update", { overlap: "allow" })).status).toBe(200);
    expect(((await k.r.call(k.c.ann, "GET", "/v1/health")).json.pulses as Json[])[0]?.blockedBy).toBeUndefined();
    expect((await pk.act("ann", "p-1", "update", { overlap: "supersede" })).status).toBe(200);
    await record(k, `${G2}.audit`, { items: [], agent: { key: "alpha/auditor" }, claimed: true });
    await record(k, `${G2}.validate`, { dispositions: [], agent: { key: "alpha/validator" } });
    await pk.tickAt(T0 + 2 * DAY);
    cards = (await k.r.call(k.c.ann, "GET", "/v1/pulses/p-1/runs")).json.cards as Json[];
    // RL-29: G2's review superseded G1's untouched one when it became ready; the fire supersedes G2.
    expect(cards[0]?.superseded).toStrictEqual([G2]);
    expect((await events(k, "review.superseded")).map((e) => [e.goal, e.payload.by])).toStrictEqual([[G1, `${G2}.debrief`]]);
  });
});
