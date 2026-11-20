// RL-11 World tests of trial fires (docs/specs/RL-11.md, "Trial fires", "Trial goals in counting"):
// marks and events (AC-08), overlap (AC-09), agent statistics (AC-10) and calibration (AC-11).

import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { Ck, CHECK, DAY, disp, fpOf, h12, HA, item, KEY, P, tel, V } from "./helpers/calib-kit.ts";
import { body, MIN, Pk, SOLO_HL, T0, type Bare } from "./helpers/pulse-kit.ts";
import type { Json, Person } from "./helpers/world.ts";

const sha = (s: string) => s.padEnd(64, "0");
const H2 = sha("h2");

/** audit (K raises) → validate (the checker accepts or dismisses) → debrief (the owner decides). */
const RELAY3 = `description: Audit, validate, debrief
steps:
  - id: audit
    kind: review
    repo: "{repo}"
    mode: headless
    agent: auditor
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
    may_set: [accepted, dismissed]
    title: Validate
    brief: Validate.
  - id: debrief
    kind: review
    repo: "{repo}"
    deps: [validate]
    mode: debrief
    output: review-record
    consumes: [open, dismissed]
    may_set: [confirmed, dismissed]
    title: Debrief
    brief: Debrief.
`;

// =============================================================================================
// AC-08 marks, events, body, the error path; AC-09 overlap
// =============================================================================================

describe("RL-11 AC-08 AC-09 trial fires at the hub", { timeout: 60_000 }, () => {
  let k: Pk;
  afterEach(async () => {
    await k?.stop();
  });
  const NOW = T0 - DAY;
  const start = async () => {
    k = await Pk.start({ clock: NOW });
  };

  it("test_AC08_marks_and_events", async () => {
    await start();
    await k.pulseOk("ann", body({}, "solo-hl", SOLO_HL));
    const res = await k.act("ann", "p-1", "fire", { trial: true });
    expect(res.status, JSON.stringify(res.json)).toBe(201);
    const slot = res.json.slot;
    expect(slot).toMatchObject({ state: "fired", manual: true, trial: true });
    const G = slot.goal as string;
    expect((await k.goal(G)).goal.trial).toBe(true);
    expect((await k.slotOf("p-1", slot.slot)).trial).toBe(true);
    const fired = await k.pulseEvents("pulse.fired", "p-1");
    expect(fired.at(-1).payload).toMatchObject({ pulse: "p-1", slot: slot.slot, manual: true, trial: true });
    expect((await k.eventsOfGoal("goal.created", G))[0].payload.trial).toBe(true);
    // Without trial: no mark, no payload key.
    k.at(NOW + MIN);
    const plain = await k.fireOk("ann", "p-1");
    expect("trial" in plain).toBe(false);
    expect("trial" in (await k.goal(plain.goal)).goal).toBe(false);
    expect("trial" in (await k.pulseEvents("pulse.fired", "p-1")).at(-1).payload).toBe(false);
    expect("trial" in (await k.eventsOfGoal("goal.created", plain.goal))[0].payload).toBe(false);
    expect((await k.act("ann", "p-1", "fire", { trial: false })).json.slot.trial).toBeUndefined();
    // A strict body.
    expect((await k.act("ann", "p-1", "fire", { trial: true, x: 1 })).status).toBe(400);
    // No body at all (an older client) fires as before.
    k.at(NOW + 2 * MIN);
    const bare = await k.w.call(k.tok.ann, "POST", "/v1/pulses/p-1/fire");
    expect(bare.status, JSON.stringify(bare.json)).toBe(201);
    expect(bare.json.slot.state).not.toBe("missed");
    expect("trial" in bare.json.slot).toBe(false);
  });

  it("test_AC08_for_person", async () => {
    await start();
    await k.pulseOk("ann", body({}, "solo-hl", SOLO_HL));
    const svc = await k.w.hub.svc.serviceToken("mesh-ai", ["goals:read", "pulses:write"]);
    const res = await k.w.call(svc, "POST", "/v1/pulses/p-1/fire", { trial: true }, { "x-mesh-on-behalf-of": "ann" });
    expect(res.status, JSON.stringify(res.json)).toBe(201);
    expect(res.json.slot).toMatchObject({ trial: true, by: "ann", state: "fired" });
  });

  it("test_AC08_error_path_keeps_trial", async () => {
    await start();
    await k.pulseOk("ann", body({}, "solo-hl", SOLO_HL));
    k.storeWrap({
      createGoal: (orig, g, ...rest) => {
        if ((g as Json)?.refs?.pulse === "p-1") throw new Error("boom");
        return orig(g, ...rest);
      },
    });
    const res = await k.act("ann", "p-1", "fire", { trial: true });
    expect(res.status, JSON.stringify(res.json)).toBe(201);
    expect(res.json.slot).toMatchObject({ state: "missed", reason: "error", manual: true, trial: true, error: "boom" });
  });

  it("test_AC09_trial_goal_does_not_block", async () => {
    await start();
    await k.pulseOk("ann", body({}, "solo-hl", SOLO_HL));
    const A: Bare = await k.bare("ann", "box-a", { headless: true });
    const trial = (await k.act("ann", "p-1", "fire", { trial: true })).json.slot;
    expect(trial.state).toBe("fired");
    expect((await k.step(`${trial.goal}.run`)).offer?.to?.machine).toBe(A.machine);
    // The scheduled slot at T0 fires although the trial goal still has machine work.
    await k.tickAt(T0, A);
    const s = await k.slotOf("p-1", new Date(T0).toISOString());
    expect(s.state).toBe("fired");
    expect(s.goal).toBeDefined();
  });

  it("test_AC09_trial_fire_skipped_by_normal_goal", async () => {
    await start();
    await k.pulseOk("ann", body({}, "solo-hl", SOLO_HL));
    const A: Bare = await k.bare("ann", "box-a", { headless: true });
    const normal = await k.fireOk("ann", "p-1");
    expect((await k.step(`${normal.goal}.run`)).offer?.to?.machine).toBe(A.machine);
    k.at(NOW + MIN);
    const res = await k.act("ann", "p-1", "fire", { trial: true });
    expect(res.json.slot).toMatchObject({ state: "skipped", reason: "overlap", trial: true, running: normal.goal });
    expect((await k.slotOf("p-1", res.json.slot.slot)).running).toBe(normal.goal);
    // Every overlap skip records the running goal, trial or not.
    k.at(NOW + 2 * MIN);
    expect((await k.fireOk("ann", "p-1")).running).toBe(normal.goal);
  });
});

// =============================================================================================
// AC-10 Statistics
// =============================================================================================

describe("RL-11 AC-10 statistics", { timeout: 90_000 }, () => {
  let k: Ck;
  const N1 = fpOf("N1");
  const N2 = fpOf("N2");
  const X = fpOf("X");
  const T1 = fpOf("T1");
  const T2 = fpOf("T2");
  const folds: Record<string, Json> = {};
  const at: Record<string, number> = {};
  const NOW = Date.UTC(2026, 10, 20, 12);
  const checker = { key: CHECK, hash: V };
  const auditor = { key: KEY, hash: HA };

  beforeAll(async () => {
    k = await Ck.start({ clock: NOW - 6 * DAY });
    const ann: Person = k.c.ann;
    const dbr = P.debrief({ consumes: ["open", "dismissed"], may_set: ["confirmed", "dismissed"] });
    // N (normal): a run of K@H (1000 ms); K raises N1, N2; C accepts N1, dismisses N2; ann confirms N2.
    const N = await k.goal(ann, [P.run("r"), P.audit(), P.validate({ may_set: ["accepted", "dismissed"] }), dbr]);
    k.at(NOW - 5 * DAY);
    await k.run(ann, `${N}.r`, tel({ runId: "n", agentKey: KEY, agentHash: HA, durationMs: 1_000 }));
    k.tick();
    await k.raise(ann, `${N}.audit`, [item("N1"), item("N2")], auditor);
    k.tick();
    await k.agentDispose(ann, `${N}.validate`, [disp(N1, "accepted"), disp(N2, "dismissed")], checker);
    k.tick();
    await k.k.claim(ann, `${N}.debrief`);
    await k.personDispose(ann, `${N}.debrief`, N2, "confirmed");
    // M (normal): K raises X; C dismisses X.
    const M = await k.goal(ann, [P.audit(), P.validate({ may_set: ["accepted", "dismissed"] })]);
    k.at(NOW - 4 * DAY);
    await k.raise(ann, `${M}.audit`, [item("X")], auditor);
    at.M = k.tick();
    await k.agentDispose(ann, `${M}.validate`, [disp(X, "dismissed")], checker);
    // T (trial pulse goal): a run of K@H (3000 ms); K raises T1, T2, X; C dismisses T1, accepts T2; ann confirms T1, dismisses X.
    const pk = k.pulses();
    const p = await pk.pulseOk("ann", body({ params: { repo: "alpha" } }, "relay3", RELAY3));
    k.at(NOW - 3 * DAY);
    const T = (await pk.act("ann", p.id as string, "fire", { trial: true })).json.slot.goal as string;
    expect((await k.goalView(T)).goal.trial).toBe(true);
    const runT = await pk.pulseOk("ann", body({ params: { repo: "alpha" } }, "solo-hl", SOLO_HL));
    const TR = (await pk.act("ann", runT.id as string, "fire", { trial: true })).json.slot.goal as string;
    await k.run(ann, `${TR}.run`, tel({ runId: "t", agentKey: KEY, agentHash: HA, durationMs: 3_000 }));
    k.tick();
    await k.raise(ann, `${T}.audit`, [item("T1"), item("T2"), item("X")], auditor);
    k.tick();
    await k.agentDispose(ann, `${T}.validate`, [disp(T1, "dismissed"), disp(T2, "accepted")], checker);
    k.tick();
    await k.k.claim(ann, `${T}.debrief`);
    await k.personDispose(ann, `${T}.debrief`, T1, "confirmed");
    at.T = k.tick();
    await k.personDispose(ann, `${T}.debrief`, X, "dismissed");
    // T2 (trial): only a run of K@H2.
    const T2g = (await pk.act("ann", runT.id as string, "fire", { trial: true })).json.slot;
    expect(T2g.state, JSON.stringify(T2g)).toBe("fired");
    k.tick();
    await k.run(ann, `${T2g.goal}.run`, tel({ runId: "t2", agentKey: KEY, agentHash: H2, durationMs: 5_000 }));
    for (const [name, G] of [["N", N], ["M", M], ["T", T]] as const) {
      const rv = (await k.k.reviews(ann, `${G}.audit`)).json.reviews as Json[];
      folds[name] = rv[0].fold ?? {};
    }
    k.at(NOW);
  });
  afterAll(async () => {
    await k?.stop();
  });
  const sum = (names: string[], f: string) => names.reduce((n, x) => n + ((folds[x]?.[f] as number | undefined) ?? 0), 0);

  it("test_AC10_default", async () => {
    const s = await k.hashStats(KEY, HA);
    expect(s).toStrictEqual({
      hash: HA,
      runs: 1,
      failures: 0,
      meanCostUsd: null,
      meanDurationMs: 1_000,
      raised: 3,
      new: sum(["N", "M"], "new"),
      regressions: sum(["N", "M"], "regression"),
      carried: sum(["N", "M"], "carried"),
      undeclaredRules: 0,
      accepted: 1,
      dismissedByAgents: 2,
      dismissedByPeople: 0,
      reinstated: 0,
      uncalibrated: 2,
      calibrating: 0,
      calibrated: 0,
      lastAt: at.M,
    });
    expect((await k.hashStats(CHECK, V)).reinstated).toBe(1);
    expect(k.hashOf(await k.stats(KEY), H2)).toBeUndefined();
  });

  it("test_AC10_include", async () => {
    const s = await k.hashStats(KEY, HA, "?trial=include");
    expect(s).toMatchObject({
      runs: 2,
      meanDurationMs: 2_000,
      raised: 6,
      new: sum(["N", "M", "T"], "new"),
      regressions: sum(["N", "M", "T"], "regression"),
      carried: sum(["N", "M", "T"], "carried"),
      accepted: 2,
      dismissedByAgents: 3,
      dismissedByPeople: 1,
      uncalibrated: 2,
      calibrating: 0,
      calibrated: 0,
      lastAt: at.T,
    });
    expect((await k.hashStats(CHECK, V, "?trial=include")).reinstated).toBe(2);
    expect(k.hashOf(await k.stats(KEY, "?trial=include"), H2)).toMatchObject({ runs: 1 });
  });

  it("test_AC10_400", async () => {
    const res = await k.r.call(k.c.ann, "GET", `/v1/agents/${encodeURIComponent(KEY)}/stats?trial=x`);
    expect(res).toStrictEqual({ status: 400, json: { error: "trial must be exclude or include" } });
  });
});

// =============================================================================================
// AC-11 Calibration
// =============================================================================================

describe("RL-11 AC-11 calibration", { timeout: 90_000 }, () => {
  let k: Ck | undefined;
  afterEach(async () => {
    await k?.stop();
    k = undefined;
  });
  const NOW = Date.UTC(2026, 10, 20, 12);

  /** A trial goal of `owner`'s pulse in which K@H raises `rule` and the checker dismisses it. */
  async function trialDismissal(c: Ck, owner: "ann" | "bob", rule: string): Promise<string> {
    const pk = c.pulses();
    const p = await pk.pulseOk(owner, body({ params: { repo: "alpha" } }, "relay3", RELAY3));
    const G = (await pk.act(owner, p.id as string, "fire", { trial: true })).json.slot.goal as string;
    c.tick();
    await c.raise(c.c[owner], `${G}.audit`, [item(rule)], { key: KEY, hash: HA });
    c.tick();
    await c.agentDispose(c.c[owner], `${G}.validate`, [disp(fpOf(rule), "dismissed")]);
    return G;
  }
  /** A normal goal of carol in which K@H raises `rule` and the checker dismisses it. */
  async function normalDismissal(c: Ck, rule: string): Promise<string> {
    const G = await c.goal(c.c.carol, [P.audit(), P.validate()]);
    c.tick();
    await c.raise(c.c.carol, `${G}.audit`, [item(rule)], { key: KEY, hash: HA });
    c.tick();
    await c.agentDispose(c.c.carol, `${G}.validate`, [disp(fpOf(rule), "dismissed")]);
    return G;
  }

  it("test_AC11_trial_dismissals_never_count", async () => {
    k = await Ck.start({ threshold: 2, clock: NOW - DAY });
    await trialDismissal(k, "ann", "t1");
    await trialDismissal(k, "ann", "t2");
    expect(await k.calibOf(KEY, HA)).toStrictEqual([]);
    const n1 = await normalDismissal(k, "n1");
    expect(await k.calibOf(KEY, HA)).toStrictEqual([]);
    const n2 = await normalDismissal(k, "n2");
    const cs = await k.calibOf(KEY, HA);
    expect(cs).toHaveLength(1);
    expect((cs[0].calibration.dismissals as Json[]).map((d) => d.goal).sort()).toStrictEqual([n1, n2].sort());
    const opened = await k.ev("calibration.opened", cs[0].id);
    expect(opened[0].payload.dismissals).toBe(2);
    expect(cs[0].title).toBe(`Calibrate ${KEY}@${h12(HA)}`);
  });

  it("test_AC11_calibrator_skips_trial_goals", async () => {
    k = await Ck.start({ threshold: 2, clock: NOW - 3 * DAY });
    const pk = k.pulses();
    // ann's pulse ran K in an older normal goal.
    const pa = await pk.pulseOk("ann", body({ params: { repo: "alpha" } }, "solo-hl", SOLO_HL));
    const GA = (await pk.fireOk("ann", pa.id as string)).goal as string;
    k.at(NOW - 2 * DAY);
    await k.run(k.c.ann, `${GA}.run`, tel({ runId: "ra", agentKey: KEY, agentHash: HA, durationMs: 1_000 }));
    // bob's pulse ran K in the newest goal, a trial goal.
    const pb = await pk.pulseOk("bob", body({ params: { repo: "alpha" } }, "solo-hl", SOLO_HL));
    const GB = (await pk.act("bob", pb.id as string, "fire", { trial: true })).json.slot.goal as string;
    k.at(NOW - DAY);
    await k.run(k.c.bob, `${GB}.run`, tel({ runId: "rb", agentKey: KEY, agentHash: HA, durationMs: 1_000 }));
    k.at(NOW);
    await normalDismissal(k, "n1");
    await normalDismissal(k, "n2");
    const cs = await k.calibOf(KEY, HA);
    expect(cs).toHaveLength(1);
    expect(cs[0].ownerId).toBe("ann");
  });
});

// =============================================================================================
// AC-10b A reinstatement belongs to the agent's dismissal, across goals
// =============================================================================================

describe("RL-11 AC-10b reinstatement across goals", { timeout: 60_000 }, () => {
  let k: Ck;
  const NOW = Date.UTC(2026, 10, 20, 12);
  afterAll(async () => {
    await k?.stop();
  });

  it("test_AC10b_reinstated_by_the_dismissal_goal", async () => {
    k = await Ck.start({ clock: NOW - 3 * DAY });
    const ann: Person = k.c.ann;
    const pk = k.pulses();
    // One pulse, so the trial goal and the later normal goal share the lineage (same preset and repo).
    const p = await pk.pulseOk("ann", body({ params: { repo: "alpha" } }, "relay3", RELAY3));
    const Y = fpOf("Y");
    // T (trial): K raises Y; the checker dismisses Y.
    const T = (await pk.act("ann", p.id as string, "fire", { trial: true })).json.slot.goal as string;
    k.tick();
    await k.raise(ann, `${T}.audit`, [item("Y")], { key: KEY, hash: HA });
    k.tick();
    await k.agentDispose(ann, `${T}.validate`, [disp(Y, "dismissed")], { key: CHECK, hash: V });
    // N (normal, later): K raises Y again; the validator leaves it; ann confirms Y in N's debrief.
    k.at(NOW - 2 * DAY);
    const N = (await pk.fireOk("ann", p.id as string)).goal as string;
    k.tick();
    await k.raise(ann, `${N}.audit`, [item("Y")], { key: KEY, hash: HA });
    k.tick();
    await k.agentDispose(ann, `${N}.validate`, [], { key: CHECK, hash: V });
    k.tick();
    await k.k.claim(ann, `${N}.debrief`);
    await k.personDispose(ann, `${N}.debrief`, Y, "confirmed");
    k.at(NOW);
    // The person's decision is in a normal goal, but the dismissal it reinstates is in the trial goal.
    expect(k.hashOf(await k.stats(CHECK), V)?.reinstated ?? 0).toBe(0);
    expect((await k.hashStats(CHECK, V, "?trial=include")).reinstated).toBe(1);
  });
});
