// RL-12 World tests of `GET /v1/health` (docs/specs/RL-12.md): slots and runs (AC-07), decisions,
// debriefs and findings (AC-08), blockedBy (AC-09), filters and the total (AC-10), scopes, no writes
// and features (AC-11).

import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { Ck, DAY, disp, fpOf, item, tel } from "./helpers/calib-kit.ts";
import { body, HOUR, MIN, type Pk } from "./helpers/pulse-kit.ts";
import type { Json } from "./helpers/world.ts";
import type { PulseSlot } from "../src/protocol/index.ts";
import { stage, topic } from "./helpers/health-kit.ts";

const NOW = Date.UTC(2026, 10, 20, 12, 30);
const AUD = { key: "alpha/auditor", hash: "a".repeat(64) };
const VAL = { key: "alpha/validator", hash: "b".repeat(64) };
const iso = (ms: number) => new Date(ms).toISOString();

const HL = `description: One headless step
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
/** audit → validate (headless) → debrief. */
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
    consumes: [open, accepted]
    may_set: [accepted, dismissed, confirmed]
    title: Debrief
    brief: Debrief.
`;
const INTERACTIVE = `description: One interactive step
steps:
  - id: run
    kind: implement
    repo: "{repo}"
    title: Run
    brief: Run.
`;

const health = async (k: Ck, q = "", who: unknown = k.c.ann): Promise<{ status: number; json: Json }> => k.r.call(who as never, "GET", `/v1/health${q}`);
const healthOk = async (k: Ck, q = ""): Promise<Json> => {
  const res = await health(k, q);
  expect(res.status, `health${q}: ${JSON.stringify(res.json)}`).toBe(200);
  return res.json;
};
const store = (k: Ck) => (k.w.hub.svc as unknown as { store: { addSlot(s: PulseSlot): Promise<boolean> } }).store;
const seed = (k: Ck, s: Partial<PulseSlot> & { at: number; state: PulseSlot["state"] }) =>
  store(k).addSlot({ pulse: "p-1", slot: iso(s.at), tried: [], decidedAt: s.at, ...s } as PulseSlot);

// =============================================================================================
// AC-07 Slots and runs
// =============================================================================================

describe("RL-12 AC-07 slots and runs", { timeout: 90_000 }, () => {
  let k: Ck;
  let pk: Pk;
  const g: string[] = [];
  let trialG = "";
  const due = (i: number) => NOW - i * DAY + HOUR; // never `now`

  beforeAll(async () => {
    k = await Ck.start({ clock: NOW - 10 * DAY });
    pk = k.pulses();
    const ann = k.c.ann;
    await pk.pulseOk("ann", body({ params: { repo: "alpha" }, overlap: "allow", maxGoalAge: "30d", when: { every: "1d", at: NOW + 30 * DAY } }, "hl", HL));
    // g0: a goal whose run finished 9 days ago (out of the window).
    k.at(NOW - 9 * DAY);
    g.push((await pk.fireOk("ann", "p-1")).goal as string);
    await stage(k, ann, `${g[0]}.run`, { items: [], agent: AUD, telemetry: tel({ runId: "old", agentKey: AUD.key, agentHash: AUD.hash, durationMs: 9 }) });
    // g1..g4: manual fires in the window (4 manual slots), each started at once (a later fire retires pending slots).
    const fire = async (i: number) => {
      k.at(due(8 - i) + 10 * MIN);
      const G = (await pk.fireOk("ann", "p-1")).goal as string;
      g.push(G);
      return G;
    };
    const G1 = await fire(1);
    k.tick(MIN);
    await stage(k, ann, `${G1}.run`, { started: true, items: [], agent: AUD, telemetry: { ...tel({ runId: "r1", agentKey: AUD.key, agentHash: AUD.hash, durationMs: 1_000, costUsdEstimate: 1 }), turns: 4 } });
    const G2 = await fire(2);
    k.tick(MIN);
    await stage(k, ann, `${G2}.run`, {
      started: true,
      items: [],
      agent: AUD,
      outcome: "fail",
      telemetry: { ...tel({ runId: "r2", agentKey: AUD.key, agentHash: AUD.hash, durationMs: 2_000 }), turns: 6, exit: "killed_budget", permissionDenials: { count: 3, tools: ["Bash"] } },
    });
    const G3 = await fire(3);
    await k.k.claim(ann, `${G3}.run`);
    await k.r.call(ann, "POST", `/v1/steps/${G3}.run/run`, { state: "started", runId: "r3" });
    expect((await k.r.call(ann, "POST", `/v1/steps/${G3}.run/release`, { note: "x" })).status).toBe(200);
    expect((await k.r.call(ann, "POST", `/v1/goals/${G3}/drop`, { reason: "x" })).status).toBe(200);
    const G4 = await fire(4);
    await k.k.claim(ann, `${G4}.run`);
    await k.r.call(ann, "POST", `/v1/steps/${G4}.run/run`, { state: "started", runId: "r4" });
    // A trial fire in the window.
    k.at(due(2) + 10 * MIN);
    trialG = (await pk.act("ann", "p-1", "fire", { trial: true })).json.slot.goal as string;
    // Scheduled slots: 7 in the window, 1 older.
    await seed(k, { at: due(8), state: "fired", goal: g[0] as string, startedAt: due(8) + MIN, firedAt: due(8), until: due(8) + HOUR });
    await seed(k, { at: due(7), state: "fired", goal: g[1] as string, startedAt: due(7) + MIN, firedAt: due(7), until: due(7) + HOUR });
    await seed(k, { at: due(6), state: "fired", goal: g[2] as string, startedAt: due(6) + MIN, firedAt: due(6), until: due(6) + HOUR });
    await seed(k, { at: due(5), state: "abandoned", reason: "max_goal_age", goal: g[3] as string, startedAt: due(5) + MIN, firedAt: due(5), until: due(5) + HOUR });
    await seed(k, { at: due(4), state: "skipped", reason: "overlap", running: g[1] as string });
    await seed(k, { at: due(3), state: "missed", reason: "no_machine" });
    await seed(k, { at: due(2), state: "missed", reason: "capacity" });
    await seed(k, { at: due(1), state: "fired", goal: g[4] as string, firedAt: due(1), until: NOW + 2 * HOUR });
    k.at(NOW);
  });
  afterAll(async () => {
    await k?.stop();
  });

  it("test_AC07_slots_runs_goals", async () => {
    const h = await healthOk(k);
    expect(h.window).toStrictEqual({ since: NOW - 7 * DAY, until: NOW, days: 7 });
    const p = h.pulses[0] as Json;
    expect(p).toMatchObject({ pulse: "p-1", title: "hl on alpha", owner: "ann", enabled: true, schedule: "every 1d" });
    expect(p.slots).toStrictEqual({ due: 7, fired: 3, started: 3, skipped: 1, missed: { no_machine: 1, capacity: 1 }, abandoned: 1, queued: 0 });
    expect(p.manual).toBe(4);
    // The newest slot is the scheduled slot due(1) (the trial fire is left out).
    expect(p.lastSlot).toStrictEqual({ slot: iso(due(1)), at: due(1), state: "fired" });
    expect(p.runs).toStrictEqual({ count: 2, durationMs: 3_000, turns: 10, costUsd: 1, failed: 1, overBudget: 1, denials: 3, allDismissed: 0 });
    // g1 done, g2 failed step (goal open), g3 dropped, g4 open; g0 is out of the window.
    expect(p.goals).toStrictEqual({ created: 4, done: 1, dropped: 1, open: 2 });
    // The same runs as GET /v1/runs over all pages.
    const runs = (await k.r.call(k.c.ann, "GET", `/v1/runs?pulse=p-1&since=${NOW - 7 * DAY}&until=${NOW + 1}&limit=1`)).json;
    let count = (runs.runs as Json[]).length;
    let next = runs.next as string | undefined;
    while (next) {
      const r = (await k.r.call(k.c.ann, "GET", `/v1/runs?pulse=p-1&since=${NOW - 7 * DAY}&until=${NOW + 1}&limit=1&cursor=${next}`)).json;
      count += (r.runs as Json[]).length;
      next = r.next as string | undefined;
    }
    expect(count).toBe(p.runs.count);
    expect(h.total).toMatchObject({ pulses: 1, slots: p.slots, manual: 4, runs: p.runs, goals: p.goals });
  });

  it("test_AC07_trial_include", async () => {
    const p = (await healthOk(k, "?trial=include")).pulses[0] as Json;
    expect(p.manual).toBe(5);
    expect(p.slots.due).toBe(7);
    expect(p.goals.created).toBe(5);
    expect(p.lastSlot).toMatchObject({ state: "fired" });
    expect(trialG).toBeTruthy();
  });
});

// =============================================================================================
// AC-08 Decisions, debriefs and findings
// =============================================================================================

describe("RL-12 AC-08 decisions", { timeout: 90_000 }, () => {
  let k: Ck;
  let pk: Pk;
  const F = fpOf("F");
  const Gx = fpOf("G");
  const O = fpOf("O");
  const T = fpOf("T");
  let debriefReady = 0;
  let g1Ready = 0;

  beforeAll(async () => {
    k = await Ck.start({ clock: NOW - 20 * DAY });
    pk = k.pulses();
    await topic(k);
    const ann = k.c.ann;
    await pk.pulseOk("ann", body({ params: { repo: "alpha" }, overlap: "allow", maxGoalAge: "30d", when: { every: "1d", at: NOW + 30 * DAY } }, "relay3", RELAY3));
    await pk.pulseOk("ann", body({ params: { repo: "alpha" }, overlap: "allow", maxGoalAge: "30d", when: { every: "1d", at: NOW + 30 * DAY } }, "relay3", RELAY3));
    // Goal 1 of p-1, before the window: O accepted (then, in the window, nothing).
    k.at(NOW - 10 * DAY);
    const G1 = (await pk.fireOk("ann", "p-1")).goal as string;
    await stage(k, ann, `${G1}.audit`, { started: true, items: [item("O", { severity: "S2" })], agent: AUD, telemetry: tel({ runId: "a1", agentKey: AUD.key, agentHash: AUD.hash, durationMs: 1, costUsdEstimate: 3 }) });
    g1Ready = await stage(k, ann, `${G1}.validate`, { dispositions: [disp(O, "accepted")], agent: VAL });
    // Goal 2 of p-1, in the window: raises O (repeat), F (S1), G (S3), X (S4, stays open);
    // validate accepts F; the debrief accepts F again with a link (two rows, one item), and accepts
    // G, then reverts that (G is open again).
    k.at(NOW - 2 * DAY);
    const G2 = (await pk.fireOk("ann", "p-1")).goal as string;
    await stage(k, ann, `${G2}.audit`, {
      started: true,
      items: [item("O", { severity: "S2" }), item("F", { severity: "S1" }), item("G"), item("X", { severity: "S4" })],
      agent: AUD,
      telemetry: tel({ runId: "a2", agentKey: AUD.key, agentHash: AUD.hash, durationMs: 1, costUsdEstimate: 1 }),
    });
    await stage(k, ann, `${G2}.validate`, { dispositions: [disp(F, "accepted")], agent: VAL });
    debriefReady = (await k.r.stepOf(`${G2}.validate`)).rounds[0].finishedAt as number;
    k.at(NOW - DAY);
    await k.k.claim(ann, `${G2}.debrief`);
    await k.personDispose(ann, `${G2}.debrief`, F, "accepted", { link: "https://tracker.example/F" });
    // G: a person accepts it, then reverts: not counted.
    await k.personDispose(ann, `${G2}.debrief`, Gx, "accepted");
    await k.revert(ann, `${G2}.debrief`, Gx);
    // The debrief stays claimed (open).
    // p-2: a trial goal that accepts T.
    k.at(NOW - DAY + HOUR);
    const GT = (await pk.act("ann", "p-2", "fire", { trial: true })).json.slot.goal as string;
    // A complete audit lists every item again (one it leaves out would be resolved).
    await stage(k, ann, `${GT}.audit`, {
      started: true,
      items: [item("O", { severity: "S2" }), item("F", { severity: "S1" }), item("G"), item("X", { severity: "S4" }), item("T")],
      agent: AUD,
    });
    await stage(k, ann, `${GT}.validate`, { dispositions: [disp(T, "accepted")], agent: VAL });
    k.at(NOW);
  });
  afterAll(async () => {
    await k?.stop();
  });

  it("test_AC08_accepted_and_ratio", async () => {
    const h = await healthOk(k);
    const [p1, p2] = h.pulses as Json[];
    // F counts once (validator + debrief rows); G reverted to open; O accepted before the window.
    expect(p1?.accepted).toBe(1);
    expect(p1?.costPerAcceptedUsd).toBe(1);
    expect(p2?.accepted).toBe(0);
    expect(p2?.costPerAcceptedUsd).toBeUndefined();
    const inc = await healthOk(k, "?trial=include");
    expect((inc.pulses as Json[])[1]?.accepted).toBe(1);
    expect(inc.total.accepted).toBe(2);
  });

  it("test_AC08_debriefs", async () => {
    const h = await healthOk(k);
    const p1 = (h.pulses as Json[])[0] as Json;
    // G1's debrief (ready since its validate) and G2's (claimed).
    expect(p1.debriefs.open).toBe(2);
    // The oldest is G1's debrief, ready since G1's validate finished.
    expect(p1.debriefs.oldestMs).toBe(NOW - g1Ready);
    expect(p1.debriefs.oldestMs).toBeGreaterThan(NOW - debriefReady);
    expect((h.pulses as Json[])[1]?.debriefs).toStrictEqual({ open: 0, overdue: 0, breaches: [] });
    expect(((await healthOk(k, "?trial=include")).pulses as Json[])[1]?.debriefs.open).toBe(1);
    expect(h.total.debriefs.open).toBe(2);
  });

  it("test_AC08_findings", async () => {
    const h = await healthOk(k);
    const p1 = (h.pulses as Json[])[0] as Json;
    // Lineage relay3|alpha|auditor (both pulses): O accepted (S2), F accepted (S1), G open again (S3), X open (S4), T accepted (S3).
    const want = { open: { S1: 0, S2: 0, S3: 1, S4: 1 }, accepted: { S1: 1, S2: 1, S3: 1, S4: 0 } };
    expect(p1.findings).toStrictEqual(want);
    // p-2's only goal is a trial goal: no lineage by default.
    expect((h.pulses as Json[])[1]?.findings).toStrictEqual({ open: { S1: 0, S2: 0, S3: 0, S4: 0 }, accepted: { S1: 0, S2: 0, S3: 0, S4: 0 } });
    // With include both pulses name the lineage; the total counts each item once.
    const inc = await healthOk(k, "?trial=include");
    expect((inc.pulses as Json[])[1]?.findings).toStrictEqual(want);
    expect(inc.total.findings).toStrictEqual(want);
  });
});

// =============================================================================================
// AC-09 blockedBy
// =============================================================================================

describe("RL-12 AC-09 blockedBy", { timeout: 90_000 }, () => {
  let k: Ck | undefined;
  afterEach(async () => {
    await k?.stop();
    k = undefined;
  });
  const blocked = async (c: Ck) => ((await healthOk(c)).pulses as Json[])[0]?.blockedBy;

  it("test_AC09_claimed_headless_blocks", async () => {
    k = await Ck.start({ clock: NOW - HOUR });
    const pk = k.pulses();
    await pk.pulseOk("ann", body({ params: { repo: "alpha" } }, "hl", HL));
    const G = (await pk.fireOk("ann", "p-1")).goal as string;
    await k.k.claim(k.c.ann, `${G}.run`);
    await k.r.call(k.c.ann, "POST", `/v1/steps/${G}.run/run`, { state: "started", runId: "x" });
    k.at(NOW);
    expect(await blocked(k)).toStrictEqual({ goal: G, step: `${G}.run`, ageMs: HOUR });
  });

  it("test_AC09_trial_and_debrief_do_not_block", async () => {
    k = await Ck.start({ clock: NOW - HOUR });
    const pk = k.pulses();
    await pk.pulseOk("ann", body({ params: { repo: "alpha" } }, "relay3", RELAY3));
    const T = (await pk.act("ann", "p-1", "fire", { trial: true })).json.slot.goal as string;
    await k.k.claim(k.c.ann, `${T}.audit`);
    expect(await blocked(k)).toBeUndefined();
    // A normal goal waiting only on its debrief.
    const G = (await pk.fireOk("ann", "p-1")).goal as string;
    await stage(k, k.c.ann, `${G}.audit`, { items: [item("A")], agent: AUD });
    await stage(k, k.c.ann, `${G}.validate`, { dispositions: [], agent: VAL });
    expect((await k.r.stepOf(`${G}.debrief`)).state).toBe("ready");
    expect(await blocked(k)).toBeUndefined();
  });

  it("test_AC09_too_old_or_expired_does_not_block", async () => {
    k = await Ck.start({ clock: NOW - 3 * HOUR });
    const pk = k.pulses();
    await pk.pulseOk("ann", body({ params: { repo: "alpha" }, maxGoalAge: "2h", window: "1h", overlap: "skip" }, "hl", HL));
    // A started goal older than maxGoalAge: the next fire would abandon it.
    const G = (await pk.fireOk("ann", "p-1")).goal as string;
    await k.k.claim(k.c.ann, `${G}.run`);
    await k.r.call(k.c.ann, "POST", `/v1/steps/${G}.run/run`, { state: "started", runId: "x" });
    k.at(NOW - 90 * MIN);
    expect(await blocked(k)).toMatchObject({ goal: G });
    k.at(NOW);
    expect(await blocked(k)).toBeUndefined();
  });

  it("test_AC09_pending_window_over_does_not_block", async () => {
    k = await Ck.start({ clock: NOW - 2 * HOUR });
    const pk = k.pulses();
    await pk.pulseOk("ann", body({ params: { repo: "alpha" }, window: "1h" }, "hl", HL));
    const G = (await pk.fireOk("ann", "p-1")).goal as string;
    k.at(NOW - 2 * HOUR + 30 * MIN);
    expect(await blocked(k)).toMatchObject({ goal: G, step: `${G}.run` });
    k.at(NOW);
    expect(await blocked(k)).toBeUndefined();
  });

  it("test_AC09_claimed_interactive_counts_as_started", async () => {
    k = await Ck.start({ clock: NOW - 3 * HOUR });
    const pk = k.pulses();
    await pk.pulseOk("ann", body({ params: { repo: "alpha" }, window: "4h", maxGoalAge: "2h" }, "int", INTERACTIVE));
    const G = (await pk.fireOk("ann", "p-1")).goal as string;
    await k.k.claim(k.c.ann, `${G}.run`);
    // Pending (no startedAt yet), claimed: started by slotStarted; older than maxGoalAge → abandoned by a fire.
    k.at(NOW);
    expect(await blocked(k)).toBeUndefined();
    k.at(NOW - 2 * HOUR);
    expect(await blocked(k)).toMatchObject({ goal: G, step: `${G}.run` });
  });

  it("test_AC09_overlap_allow", async () => {
    k = await Ck.start({ clock: NOW - HOUR });
    const pk = k.pulses();
    await pk.pulseOk("ann", body({ params: { repo: "alpha" }, overlap: "allow" }, "hl", HL));
    const G = (await pk.fireOk("ann", "p-1")).goal as string;
    await k.k.claim(k.c.ann, `${G}.run`);
    expect(await blocked(k)).toBeUndefined();
  });
});

// =============================================================================================
// AC-10 Filters and total; AC-11 scopes, no writes, features
// =============================================================================================

describe("RL-12 AC-10 AC-11 filters, total, scopes", { timeout: 90_000 }, () => {
  let k: Ck;
  let pk: Pk;

  beforeAll(async () => {
    k = await Ck.start({ threshold: 1, clock: NOW - DAY });
    pk = k.pulses();
    for (const t of ["x", "y"]) await topic(k, t);
    await pk.pulseOk("ann", body({ params: { repo: "alpha" }, topics: ["x"] }, "hl", HL));
    await pk.pulseOk("ann", body({ params: { repo: "beta" }, topics: ["x", "y"] }, "hl", HL));
    await pk.fireOk("ann", "p-1");
    await pk.fireOk("ann", "p-2");
    // An open calibration goal (threshold 1): one dismissal of an agent's item.
    await k.dismissOne(k.c.ann, "cal");
    k.at(NOW);
  });
  afterAll(async () => {
    await k?.stop();
  });

  it("test_AC10_filters_and_total", async () => {
    const ids = async (q: string) => ((await healthOk(k, q)).pulses as Json[]).map((p) => p.pulse);
    expect(await ids("")).toStrictEqual(["p-1", "p-2"]);
    expect(await ids("?repo=alpha")).toStrictEqual(["p-1"]);
    expect(await ids("?topic=y")).toStrictEqual(["p-2"]);
    expect(await ids("?topic=%20X%20")).toStrictEqual(["p-1", "p-2"]);
    expect(await ids("?topic=all")).toStrictEqual(["p-1", "p-2"]);
    const h = await healthOk(k);
    expect(h.total.pulses).toBe(2);
    expect(h.total.manual).toBe(2);
    const open = (await k.calibGoals()).filter((g) => g.state !== "done" && g.state !== "dropped");
    const calOpen = open.length;
    expect(calOpen, "an open calibration goal").toBeGreaterThanOrEqual(1);
    expect(h.total.calibrations.open).toBe(calOpen);
    expect(h.total.calibrations.oldestMs).toBe(NOW - Math.min(...open.map((g) => g.createdAt as number)));
    // The total follows the filter.
    const alpha = await healthOk(k, "?repo=alpha");
    expect(alpha.total).toMatchObject({ pulses: 1, manual: 1 });
    expect((await healthOk(k, "?repo=beta&topic=nope")).total.calibrations.open).toBe(calOpen);
    for (const [q, msg] of [
      ["?days=0", "days must be a whole number from 1 to 90"],
      ["?days=91", "days must be a whole number from 1 to 90"],
      ["?days=x", "days must be a whole number from 1 to 90"],
      ["?trial=only", "trial must be exclude or include"],
    ] as const) {
      expect(await health(k, q), q).toStrictEqual({ status: 400, json: { error: msg } });
    }
  });

  it("test_AC11_scopes_no_writes_features", async () => {
    const svc = k.w.hub.svc;
    const withScope = await svc.serviceToken("dash", ["goals:read"]);
    const without = await svc.serviceToken("other", []);
    const goalsBefore = JSON.stringify((await k.r.call(k.c.ann, "GET", "/v1/goals?pulses=1")).json);
    const evBefore = (await k.r.call(k.c.ann, "GET", "/v1/events?after=0&limit=1000")).json;
    for (const path of ["/v1/health", "/v1/pulses/p-1/runs"]) {
      expect((await k.w.call(withScope, "GET", path)).status, path).toBe(200);
      expect((await k.w.call(without, "GET", path)).status, path).toBe(403);
      expect((await k.w.call(undefined as never, "GET", path)).status, path).toBe(401);
      const ob = await k.w.call(withScope, "GET", path, undefined, { "x-mesh-on-behalf-of": "ann" });
      expect(ob, path).toStrictEqual({ status: 400, json: { error: "on-behalf-of is not accepted on this route", code: "on-behalf-of-not-accepted" } });
    }
    expect(JSON.stringify((await k.r.call(k.c.ann, "GET", "/v1/goals?pulses=1")).json)).toBe(goalsBefore);
    expect((await k.r.call(k.c.ann, "GET", "/v1/events?after=0&limit=1000")).json).toStrictEqual(evBefore);
    expect((await k.w.call(undefined as never, "GET", "/healthz")).json.features).toStrictEqual(["agent-compare", "changes", "commits", "debrief-sla", "efficiency", "findings-rollup", "fleet-pause", "health", "overlap-policy", "preset-check", "profile-fit", "pulse-runs", "runs", "spot-checks", "step-assign-for", "trial"]);
  });
});
