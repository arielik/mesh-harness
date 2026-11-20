// RL-12 World tests of `GET /v1/pulses/:id/runs` (docs/specs/RL-12.md): a full card (AC-01), stage
// times (AC-02), skipped, missed and manual cards (AC-03), dispositions and sinks (AC-04), delta
// (AC-05), paging and the 400s (AC-06).

import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { Ck, DAY, disp, fpOf, item, rec, tel } from "./helpers/calib-kit.ts";
import { cards, cardsOk, stage, topic } from "./helpers/health-kit.ts";
import { body, MIN, type Pk } from "./helpers/pulse-kit.ts";
import type { Json } from "./helpers/world.ts";

const NOW = Date.UTC(2026, 10, 20, 12);
const AUD = { key: "alpha/auditor", hash: "a".repeat(64) };
const VAL = { key: "alpha/validator", hash: "b".repeat(64) };
const FIL = { key: "alpha/filer", hash: "c".repeat(64) };
const LINK = (f: string) => `https://tracker.example/${f}`;

/** audit → validate → file (sinks into topic ci) → debrief. */
const RELAY4 = `description: Audit, validate, file, debrief
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
  - id: file
    kind: review
    repo: "{repo}"
    deps: [validate]
    mode: headless
    agent: filer
    output: review-record
    consumes: [accepted]
    may_set: [accepted]
    sink: { topic: ci }
    title: File
    brief: File.
  - id: debrief
    kind: review
    repo: "{repo}"
    deps: [file]
    mode: debrief
    output: review-record
    consumes: [open]
    may_set: [confirmed, dismissed, accepted]
    title: Debrief
    brief: Debrief.
`;

/** a → b → c, interactive, no records (c may fail and reopen b). */
const CHAIN = `description: Chain
steps:
  - id: a
    kind: implement
    repo: "{repo}"
    title: A
    brief: A.
  - id: b
    kind: implement
    repo: "{repo}"
    deps: [a]
    title: B
    brief: B.
  - id: c
    kind: verify
    repo: "{repo}"
    deps: [b]
    title: C
    brief: C.
`;

// =============================================================================================
// AC-01 A full card
// =============================================================================================

describe("RL-12 AC-01 a full card", { timeout: 90_000 }, () => {
  let k: Ck;
  let pk: Pk;
  let G = "";
  const A = fpOf("A");
  const B = fpOf("B");
  const t = { due: 0, audit: 0, validate: 0, file: 0, now: 0 };
  let slot: Json = {};
  let reportId = "";

  beforeAll(async () => {
    k = await Ck.start({ clock: NOW - 2 * DAY });
    pk = k.pulses();
    await topic(k);
    const ann = k.c.ann;
    t.due = NOW - DAY;
    await pk.pulseOk("ann", body({ params: { repo: "alpha" }, when: { every: "1d", at: t.due } }, "relay4", RELAY4));
    await pk.tickAt(t.due);
    slot = (await pk.slotsOf("p-1"))[0] as Json;
    G = slot.goal as string;
    expect(G, JSON.stringify(slot)).toBeTruthy();
    k.at(t.due + 5 * MIN);
    t.audit = await stage(k, ann, `${G}.audit`, {
      started: true,
      report: "# Audit\n",
      items: [item("A"), item("B"), item("C")],
      agent: AUD,
      telemetry: { ...tel({ runId: "r-audit", agentKey: AUD.key, agentHash: AUD.hash, durationMs: 1_000, costUsdEstimate: 0.5 }), turns: 5 },
    });
    k.at(t.due + 20 * MIN);
    t.validate = await stage(k, ann, `${G}.validate`, {
      dispositions: [disp(A, "accepted"), disp(B, "dismissed")],
      agent: VAL,
      telemetry: { ...tel({ runId: "r-val", agentKey: VAL.key, agentHash: VAL.hash, durationMs: 2_000 }), turns: 3 },
    });
    k.at(t.due + 30 * MIN);
    t.file = await stage(k, ann, `${G}.file`, { dispositions: [disp(A, "accepted", { link: LINK(A) })], agent: FIL });
    k.at(t.due + 90 * MIN);
    t.now = t.due + 90 * MIN;
    reportId = ((await k.r.call(ann, "GET", `/v1/goals/${G}/artifacts`)).json.artifacts as Json[]).find((a) => a.kind === "report")?.id as string;
  });
  afterAll(async () => {
    await k?.stop();
  });

  it("test_AC01_card", async () => {
    const page = await cardsOk(k, "p-1");
    expect(page.pulse).toBe("p-1");
    expect(page.next).toBeUndefined();
    const c = page.cards[0] as Json;
    const s = await pk.slotOf("p-1", slot.slot as string);
    const g = (await k.goalView(G)).goal;
    expect(c).toMatchObject({
      slot: s.slot,
      at: t.due,
      state: "fired",
      goal: G,
      manual: false,
      trial: false,
      catchUp: false,
      tries: s.tried.length,
      startedAt: s.startedAt,
      startWaitMs: (s.startedAt as number) - t.due,
      goalTitle: g.title,
      goalState: "in_progress",
      goalCreatedAt: g.createdAt,
      totals: { runs: 2, durationMs: 3_000, turns: 8, costUsd: 0.5 },
      items: { raised: 3, open: 1, confirmed: 0, accepted: 1, dismissed: 1, deferred: 0, resolved: 0 },
      dispositions: { accepted: 2, dismissed: 1, confirmed: 0, deferred: 0, byPeople: 0, reverted: 0 },
      reports: [reportId],
    });
    const audit = ((await k.r.stepOf(`${G}.audit`)).rounds as Json[])[0];
    expect(c.fold).toStrictEqual(audit.fold);
    expect(c.sinks).toHaveLength(1);
    expect(c.sinks[0]).toMatchObject({ repo: "alpha", topic: "ci", steps: 1 });
    const stages = c.stages as Json[];
    expect(stages.map((x) => x.step)).toStrictEqual(["audit", "validate", "file", "debrief"].map((x) => `${G}.${x}`));
    expect(stages[0]).toMatchObject({ kind: "review", mode: "headless", state: "done", agent: AUD.key, rounds: 1, outcome: "done", readyAt: g.createdAt, finishedAt: t.audit, runs: 1, durationMs: 1_000, turns: 5, costUsd: 0.5, exit: "success" });
    expect(stages[0].waitMs).toBe(Math.max(0, (stages[0].startedAt as number) - g.createdAt));
    expect(stages[1]).toMatchObject({ mode: "headless", agent: VAL.key, readyAt: t.audit, finishedAt: t.validate, runs: 1, durationMs: 2_000, turns: 3 });
    expect(stages[1].costUsd).toBeUndefined();
    expect(stages[1].waitMs).toBe((stages[1].startedAt as number) - t.audit);
    expect(stages[2]).toMatchObject({ agent: "filer", runs: 0, durationMs: 0, turns: 0, readyAt: t.validate });
    expect(stages[2].exit).toBeUndefined();
    expect(stages[3]).toMatchObject({ mode: "debrief", state: "ready", rounds: 0, readyAt: t.file, waitingMs: t.now - t.file });
    expect(stages[3].waitMs).toBeUndefined();
    expect(stages[3].cycleReadyAt).toBeUndefined();
  });
});

// =============================================================================================
// AC-02 Stage times
// =============================================================================================

describe("RL-12 AC-02 stage times", { timeout: 90_000 }, () => {
  let k: Ck | undefined;
  afterEach(async () => {
    await k?.stop();
    k = undefined;
  });

  it("test_AC02_fix_cycle", async () => {
    k = await Ck.start({ clock: NOW - DAY });
    const pk = k.pulses();
    const ann = k.c.ann;
    await pk.pulseOk("ann", body({ params: { repo: "alpha" } }, "chain", CHAIN));
    const G = (await pk.fireOk("ann", "p-1")).goal as string;
    const created = (await k.goalView(G)).goal.createdAt as number;
    k.at(NOW - DAY + 10 * MIN);
    const aDone = await stage(k, ann, `${G}.a`);
    k.at(NOW - DAY + 30 * MIN);
    await k.k.claim(ann, `${G}.b`);
    const bStart = (await k.r.stepOf(`${G}.b`)).claimedAt as number;
    k.at(NOW - DAY + 40 * MIN);
    const d = await k.k.close(ann, `${G}.b`, { outcome: "done", summary: "ok" });
    expect(d.status).toBe(200);
    k.at(NOW - DAY + 50 * MIN);
    const cFail = await stage(k, ann, `${G}.c`, { outcome: "fail", reopen: [`${G}.b`] });
    k.at(NOW - DAY + 70 * MIN);
    await k.k.claim(ann, `${G}.b`);
    let st = ((await cardsOk(k, "p-1")).cards[0].stages as Json[]).find((x) => x.step === `${G}.b`) as Json;
    expect(st).toMatchObject({ state: "claimed", readyAt: aDone, startedAt: bStart, waitMs: bStart - aDone, cycleReadyAt: cFail });
    expect(st.waitingMs).toBeUndefined();
    // a: no deps → plan v1 approval (the goal's creation).
    const a = ((await cardsOk(k, "p-1")).cards[0].stages as Json[])[0];
    expect(a.readyAt).toBe(created);
    k.at(NOW - DAY + 80 * MIN);
    const d2 = await k.k.close(ann, `${G}.b`, { outcome: "done", summary: "ok" });
    expect(d2.status).toBe(200);
    const bDone2 = ((await k.r.stepOf(`${G}.b`)).rounds as Json[]).at(-1)?.finishedAt as number;
    k.at(NOW - DAY + 100 * MIN);
    st = ((await cardsOk(k, "p-1")).cards[0].stages as Json[]).find((x) => x.step === `${G}.c`) as Json;
    expect(st).toMatchObject({ state: "ready", cycleReadyAt: bDone2, waitingMs: NOW - DAY + 100 * MIN - bDone2 });
  });

  it("test_AC02_failed_and_dropped_deps", async () => {
    k = await Ck.start({ clock: NOW - DAY });
    const pk = k.pulses();
    const ann = k.c.ann;
    await pk.pulseOk("ann", body({ params: { repo: "alpha" } }, "chain", CHAIN));
    const G = (await pk.fireOk("ann", "p-1")).goal as string;
    k.at(NOW - DAY + 10 * MIN);
    // a fails (no reopen): b stays blocked with no readyAt.
    await stage(k, ann, `${G}.a`, { outcome: "fail" });
    let stages = (await cardsOk(k, "p-1")).cards[0].stages as Json[];
    expect(stages[0].state).toBe("failed");
    expect(stages[1]).toMatchObject({ state: "blocked" });
    expect(stages[1].readyAt).toBeUndefined();
    // Dropping the goal drops b and c: no waitMs.
    k.at(NOW - DAY + 20 * MIN);
    const drop = await k.r.call(ann, "POST", `/v1/goals/${G}/drop`, { reason: "test" });
    expect(drop.status, JSON.stringify(drop.json)).toBe(200);
    stages = (await cardsOk(k, "p-1")).cards[0].stages as Json[];
    expect(stages[1]).toMatchObject({ state: "dropped" });
    expect(stages[1].waitMs).toBeUndefined();
    expect(stages[1].waitingMs).toBeUndefined();
  });

  it("test_AC02_skipped_dep", async () => {
    k = await Ck.start({ clock: NOW - DAY });
    const pk = k.pulses();
    const ann = k.c.ann;
    const COND = `description: Conditional
steps:
  - id: audit
    kind: review
    repo: "{repo}"
    output: review-record
    title: Audit
    brief: Audit.
  - id: triage
    kind: review
    repo: "{repo}"
    deps: [audit]
    output: review-record
    consumes: [open]
    may_set: [dismissed]
    when: { open: true }
    title: Triage
    brief: Triage.
  - id: after
    kind: docs
    repo: "{repo}"
    deps: [triage]
    title: After
    brief: After.
`;
    await pk.pulseOk("ann", body({ params: { repo: "alpha" } }, "cond", COND));
    const G = (await pk.fireOk("ann", "p-1")).goal as string;
    k.at(NOW - DAY + 10 * MIN);
    await stage(k, ann, `${G}.audit`, { items: [], agent: AUD });
    const triage = await k.r.stepOf(`${G}.triage`);
    expect(triage.state).toBe("skipped");
    k.at(NOW - DAY + 30 * MIN);
    const after = ((await cardsOk(k, "p-1")).cards[0].stages as Json[]).find((x) => x.step === `${G}.after`) as Json;
    expect(after).toMatchObject({ state: "ready", readyAt: triage.updatedAt, waitingMs: NOW - DAY + 30 * MIN - (triage.updatedAt as number) });
  });
});

// =============================================================================================
// AC-03 Skipped, missed and manual cards
// =============================================================================================

describe("RL-12 AC-03 slot cards", { timeout: 90_000 }, () => {
  let k: Ck | undefined;
  afterEach(async () => {
    await k?.stop();
    k = undefined;
  });

  it("test_AC03_skipped_missed_manual", async () => {
    k = await Ck.start({ clock: NOW - 3 * DAY });
    const pk = k.pulses();
    const ann = k.c.ann;
    const SOLO_HL2 = `description: One headless step
steps:
  - id: run
    kind: review
    repo: "{repo}"
    mode: headless
    agent: auditor
    title: Run
    brief: Run.
`;
    const due = NOW - 2 * DAY;
    await pk.pulseOk("ann", body({ params: { repo: "alpha" }, when: { every: "1d", at: due }, window: "1h" }, "solo", SOLO_HL2));
    // Slot 1 (scheduled) fires; nobody starts it; its window ends → missed (expired), goal dropped.
    await pk.tickAt(due);
    await pk.tickAt(due + 2 * 3_600_000);
    const s1 = (await pk.slotsOf("p-1")).find((s) => s.at === due) as Json;
    expect(s1.state, JSON.stringify(s1)).toBe("missed");
    // A manual fire, started 5 minutes later.
    k.at(due + 3 * 3_600_000);
    const man = await pk.fireOk("ann", "p-1");
    k.at(due + 3 * 3_600_000 + 5 * MIN);
    await k.k.claim(ann, `${man.goal}.run`);
    await k.r.call(ann, "POST", `/v1/steps/${man.goal}.run/run`, { state: "started", runId: "x" });
    // Another manual fire while that goal runs → skipped.
    k.at(due + 3 * 3_600_000 + 6 * MIN);
    const sk = await pk.fireOk("ann", "p-1");
    expect(sk.state).toBe("skipped");
    const page = await cardsOk(k, "p-1");
    const byslot = new Map((page.cards as Json[]).map((c) => [c.slot, c] as const));
    const cs = byslot.get(sk.slot) as Json;
    expect(cs).toMatchObject({ state: "skipped", reason: "overlap", running: man.goal, manual: true, stages: [], totals: { runs: 0, durationMs: 0, turns: 0 }, sinks: [], reports: [] });
    expect(cs.goal).toBeUndefined();
    expect(cs.goalState).toBeUndefined();
    const cm = byslot.get(s1.slot) as Json;
    expect(cm).toMatchObject({ state: "missed", reason: s1.reason, goal: s1.goal, goalState: "dropped", until: s1.until, tries: (s1.tried as Json[]).length });
    const cman = byslot.get(man.slot) as Json;
    const sman = await pk.slotOf("p-1", man.slot as string);
    expect(cman).toMatchObject({ manual: true, state: "fired", startWaitMs: (sman.startedAt as number) - (sman.firedAt as number) });
    expect(cman.startWaitMs).toBe(5 * MIN);
  });
});

// =============================================================================================
// AC-04 Dispositions and sinks
// =============================================================================================

/** audit (interactive, raising) → debrief that may accept with a link and sinks into topic ci. */
const AUDIT_DEBRIEF = `description: Audit and debrief
steps:
  - id: audit
    kind: review
    repo: "{repo}"
    mode: headless
    agent: auditor
    output: review-record
    title: Audit
    brief: Audit.
  - id: debrief
    kind: review
    repo: "{repo}"
    deps: [audit]
    mode: debrief
    output: review-record
    consumes: [open, accepted]
    may_set: [accepted, dismissed]
    sink: { topic: ci }
    title: Debrief
    brief: Debrief.
`;

describe("RL-12 AC-04 dispositions and sinks", { timeout: 90_000 }, () => {
  let k: Ck;
  let pk: Pk;
  const D = fpOf("D");
  const E = fpOf("E");
  const F = fpOf("F");
  const H = fpOf("H");
  const R = fpOf("R");
  let G1 = "";
  let G2 = "";
  const lineage = "audit-debrief|alpha|auditor";

  /** Run one goal: the audit raises `items`; ann decides each in the debrief, then closes it. */
  async function run(decide: [string, string][], items: unknown[]): Promise<string> {
    const ann = k.c.ann;
    k.tick(MIN);
    const G = (await pk.fireOk("ann", "p-1")).goal as string;
    k.tick(MIN);
    await stage(k, ann, `${G}.audit`, { items, agent: AUD });
    k.tick(MIN);
    await k.k.claim(ann, `${G}.debrief`);
    for (const [f, d] of decide) await k.personDispose(ann, `${G}.debrief`, f, d, d === "accepted" ? { link: LINK(f) } : {});
    const rv = await k.k.review(ann, `${G}.debrief`, rec({ items: [], dispositions: [] }) as never);
    expect(rv.status, JSON.stringify(rv.json)).toBe(201);
    const d = await k.k.close(ann, `${G}.debrief`, { outcome: "done", summary: "ok" });
    expect(d.status, JSON.stringify(d.json)).toBe(200);
    return G;
  }
  const cardOf = async (G: string) => ((await cardsOk(k, "p-1")).cards as Json[]).find((c) => c.goal === G) as Json;

  beforeAll(async () => {
    k = await Ck.start({ clock: NOW - 2 * DAY });
    pk = k.pulses();
    await topic(k);
    await pk.pulseOk("ann", body({ params: { repo: "alpha" } }, "audit-debrief", AUDIT_DEBRIEF));
    // G1: D accepted (filed) then reverted; E dismissed; F and H filed; R filed (filed again in G2).
    G1 = await run(
      [
        [D, "accepted"],
        [E, "dismissed"],
        [F, "accepted"],
        [H, "accepted"],
        [R, "accepted"],
      ],
      [item("D"), item("E"), item("F"), item("H"), item("R")],
    );
    k.tick(MIN);
    await k.revert(k.c.ann, `${G1}.debrief`, D);
    // F's target repo moves to beta: its finding step moves to the beta clean-audit goal.
    const rt = await k.r.call(k.c.ann, "POST", "/v1/items/retarget", { lineage, fps: [F], repo: "beta" });
    expect(rt.status, JSON.stringify(rt.json)).toBe(200);
    // G2: everything raised again (a complete audit resolves what it does not list); R filed again.
    G2 = await run([[R, "accepted"]], [item("D"), item("E"), item("F"), item("H"), item("R")]);
  });
  afterAll(async () => {
    await k?.stop();
  });

  it("test_AC04_dispositions", async () => {
    const c = await cardOf(G1);
    expect(c.dispositions).toStrictEqual({ accepted: 4, dismissed: 1, confirmed: 0, deferred: 0, byPeople: 5, reverted: 1 });
  });

  it("test_AC04_sinks", async () => {
    const goals = (await k.r.call(k.c.ann, "GET", "/v1/goals")).json.goals as Json[];
    const clean = (repo: string) => goals.find((g) => g.sink?.repo === repo && g.state !== "dropped")?.id as string;
    const CA = clean("alpha");
    const CB = clean("beta");
    expect(CA && CB, JSON.stringify(goals.map((g) => [g.id, g.sink, g.state]))).toBeTruthy();
    // G1: H in alpha, F in beta; D reverted and R filed again in G2 are not listed.
    let c = await cardOf(G1);
    expect(c.sinks).toStrictEqual(
      [
        { goal: CA, repo: "alpha", topic: "ci", steps: 1 },
        { goal: CB, repo: "beta", topic: "ci", steps: 1 },
      ].sort((a, b) => Number(a.goal.slice(1)) - Number(b.goal.slice(1))),
    );
    expect((await cardOf(G2)).sinks).toStrictEqual([{ goal: CA, repo: "alpha", topic: "ci", steps: 1 }]);
    // A dropped clean-audit goal is not listed.
    const drop = await k.r.call(k.c.ann, "POST", `/v1/goals/${CB}/drop`, { reason: "x" });
    expect(drop.status, JSON.stringify(drop.json)).toBe(200);
    c = await cardOf(G1);
    expect(c.sinks).toStrictEqual([{ goal: CA, repo: "alpha", topic: "ci", steps: 1 }]);
  });
});

// =============================================================================================
// AC-05 delta; AC-06 paging and errors
// =============================================================================================

const SOLO_I = `description: One interactive step
steps:
  - id: run
    kind: review
    repo: "{repo}"
    mode: headless
    agent: auditor
    output: review-record
    title: Run
    brief: Run.
`;

describe("RL-12 AC-05 AC-06 delta and paging", { timeout: 90_000 }, () => {
  let k: Ck;
  let pk: Pk;
  const slots: Json[] = [];
  const goals: string[] = [];

  /** Fire (trial or not) and finish the goal's step with `n` items and a run of `ms`/`turns`/`cost`. */
  async function done(trial: boolean, n: number, ms: number, turns: number, cost?: number): Promise<void> {
    k.tick(MIN);
    const res = await pk.act("ann", "p-1", "fire", trial ? { trial: true } : {});
    expect(res.status, JSON.stringify(res.json)).toBe(201);
    const G = res.json.slot.goal as string;
    k.tick(MIN);
    const items = Array.from({ length: n }, (_, i) => item(`r${goals.length}-${i}`));
    await stage(k, k.c.ann, `${G}.run`, {
      items,
      agent: AUD,
      telemetry: { ...tel({ runId: `r-${G}`, agentKey: AUD.key, agentHash: AUD.hash, durationMs: ms, ...(cost !== undefined ? { costUsdEstimate: cost } : {}) }), turns },
    });
    slots.push(res.json.slot);
    goals.push(G);
  }

  beforeAll(async () => {
    k = await Ck.start({ clock: NOW - DAY });
    pk = k.pulses();
    await pk.pulseOk("ann", body({ params: { repo: "alpha" }, overlap: "allow" }, "solo-i", SOLO_I));
    await done(false, 2, 1_000, 4); // s0: no cost
    await done(true, 5, 9_000, 9, 1); // s1: trial
    await done(false, 3, 3_000, 6, 0.5); // s2
    await done(false, 4, 4_000, 7, 0.75); // s3
    k.tick(MIN);
    const open = await pk.fireOk("ann", "p-1"); // s4: open
    slots.push(open);
    goals.push(open.goal as string);
    k.tick(MIN);
  });
  afterAll(async () => {
    await k?.stop();
  });
  const bySlot = (page: Json) => new Map((page.cards as Json[]).map((c) => [c.slot, c] as const));

  it("test_AC05_delta", async () => {
    const m = bySlot(await cardsOk(k, "p-1", "?trial=include"));
    const [s0, s1, s2, s3, s4] = slots.map((s) => m.get(s.slot) as Json);
    expect(s4?.delta).toBeUndefined();
    expect(s3?.delta).toStrictEqual({ slot: slots[2]?.slot, goal: goals[2], durationMs: 1_000, turns: 1, costUsd: 0.25, raised: 1, new: 1, regression: 0 });
    // s2's previous complete run skips the trial s1; s0 had no cost.
    expect(s2?.delta).toStrictEqual({ slot: slots[0]?.slot, goal: goals[0], durationMs: 2_000, turns: 2, raised: 1, new: 1, regression: 0 });
    expect(s1?.delta).toBeUndefined();
    expect(s0?.delta).toBeUndefined();
    // Default (trial excluded): the same deltas.
    const d = bySlot(await cardsOk(k, "p-1"));
    expect(d.get(slots[2]?.slot)?.delta).toStrictEqual(s2?.delta);
    expect(d.has(slots[1]?.slot)).toBe(false);
  });

  it("test_AC05_retried_round_fold", async () => {
    // A raising step whose first round closed fail with a fold, then done again: only the newest fold counts.
    k.tick(MIN);
    const G = (await pk.fireOk("ann", "p-1")).goal as string;
    expect(G, "s5 fires (overlap: allow)").toBeTruthy();
    k.tick(MIN);
    await stage(k, k.c.ann, `${G}.run`, { items: [item("z1"), item("z2")], agent: AUD, outcome: "fail" });
    const rs = await k.r.call(k.c.ann, "POST", `${"/v1/steps/"}${G}.run/resume`, { comment: "retry" });
    expect(rs.status, JSON.stringify(rs.json)).toBe(200);
    k.tick(MIN);
    await stage(k, k.c.ann, `${G}.run`, { items: [item("z1"), item("z2"), item("z3")], agent: AUD });
    const step = await k.r.stepOf(`${G}.run`);
    const rounds = (step.rounds as Json[]).filter((r) => r.fold);
    expect(rounds.length, "two folded rounds").toBe(2);
    const c = ((await cardsOk(k, "p-1")).cards as Json[]).find((x) => x.goal === G) as Json;
    expect(c.fold).toStrictEqual(rounds.at(-1)?.fold);
  });

  it("test_AC06_paging", async () => {
    const all = (await cardsOk(k, "p-1", "?limit=100")).cards as Json[];
    expect(all.every((c) => c.trial === false)).toBe(true);
    const seen: string[] = [];
    let q = "?limit=2";
    for (let i = 0; i < 10; i++) {
      const page = await cardsOk(k, "p-1", q);
      expect((page.cards as Json[]).length).toBeLessThanOrEqual(2);
      seen.push(...(page.cards as Json[]).map((c) => c.slot as string));
      if (!page.next) break;
      q = `?limit=2&cursor=${page.next}`;
    }
    expect(seen).toStrictEqual(all.map((c) => c.slot));
    expect(((await cardsOk(k, "p-1", "?trial=include&limit=100")).cards as Json[]).length).toBe(all.length + 1);
    expect(((await cardsOk(k, "p-1", "?trial=only")).cards as Json[]).map((c) => c.slot)).toStrictEqual([slots[1]?.slot]);
    // A cursor from exclude used with include: the cards after that position.
    const p1 = await cardsOk(k, "p-1", "?limit=1");
    const inc = (await cardsOk(k, "p-1", "?trial=include&limit=100")).cards as Json[];
    const after = (await cardsOk(k, "p-1", `?trial=include&limit=100&cursor=${p1.next}`)).cards as Json[];
    expect(after.map((c) => c.slot)).toStrictEqual(inc.slice(1).map((c) => c.slot));
    // The last card of a page still gets its delta from a later page.
    const s3page = await cardsOk(k, "p-1", `?limit=1&cursor=${(await cardsOk(k, "p-1", "?limit=2")).next}`);
    expect(s3page.cards[0].slot).toBe(slots[3]?.slot);
    expect(s3page.cards[0].delta?.slot).toBe(slots[2]?.slot);
  });

  it("test_AC06_errors", async () => {
    for (const [q, msg] of [
      ["?limit=0", "limit must be a whole number from 1 to 100"],
      ["?limit=101", "limit must be a whole number from 1 to 100"],
      ["?trial=x", "trial must be exclude, include or only"],
      ["?cursor=zz", "cursor is not valid"],
      [`?cursor=${Buffer.from(JSON.stringify([1.5, "2026-11-20T12:00:00.000Z"])).toString("base64url")}`, "cursor is not valid"],
      [`?cursor=${Buffer.from(JSON.stringify([1e300, "2026-11-20T12:00:00.000Z"])).toString("base64url")}`, "cursor is not valid"],
      [`?cursor=${Buffer.from(JSON.stringify([1, "x\u0000"])).toString("base64url")}`, "cursor is not valid"],
    ] as const) {
      expect(await cards(k, "p-1", q), q).toStrictEqual({ status: 400, json: { error: msg } });
    }
    expect((await cards(k, "p-9")).status).toBe(404);
    await pk.pulseOk("ann", body({ params: { repo: "alpha" } }, "solo-i", SOLO_I));
    expect((await pk.act("ann", "p-2", "delete")).status).toBe(200);
    expect(await cards(k, "p-2")).toStrictEqual({ status: 404, json: { error: "no pulse p-2" } });
  });
});
