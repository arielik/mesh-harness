// RL-18 World tests through the hub API: sampling (AC-03, AC-04), verdicts (AC-05), the done gate and
// the MCP tool (AC-06), disagreements in calibration (AC-07) and health (AC-08). Written from the
// spec's contracts (docs/specs/RL-18.md). Every count is computed here from each test's own fixture.

import { createHash } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { ALPHA, CHECK, Ck, DAY, disp, fpOf, h12, HA, item, KEY, P, rec, V } from "./helpers/calib-kit.ts";
import { body } from "./helpers/pulse-kit.ts";
import type { PlanIn } from "./helpers/relay-kit.ts";
import { L } from "./helpers/review-kit.ts";
import { C1, H1, REV1, SRC, SRC_URL } from "./helpers/roster-kit.ts";
import type { Session } from "../src/protocol/index.ts";
import type { Json, Person } from "./helpers/world.ts";

let ck: Ck | undefined;
const fresh = async (o: { threshold?: number; clock?: number; spotChecks?: Record<string, unknown> } = {}): Promise<Ck> => {
  ck = await Ck.start(o);
  return ck;
};
afterEach(async () => {
  await ck?.stop();
  ck = undefined;
});

const ON = { rate: 1, min_per_week: 0 };
const CHECKER = { key: CHECK, hash: V };
const u = (lineage: string, fp: string, step: string, round: number) =>
  parseInt(createHash("sha256").update(JSON.stringify([lineage, fp, step, round]), "utf8").digest("hex").slice(0, 8), 16) / 2 ** 32;

/** ann's goal: the auditor (KEY@HA) raises `rules`; the step `validate` is ready. */
async function raised(k: Ck, rules: string[], owner: Person = k.c.ann, steps: PlanIn[] = [P.audit(), P.validate()]): Promise<string> {
  const G = await k.goal(owner, steps);
  k.tick();
  await k.raise(owner, `${G}.audit`, rules.map((r) => item(r)));
  k.tick();
  return G;
}
/** A goal where the checker (CHECK@V unless given) records `ds` = [[rule, disposition]] in `validate`. */
async function decided(k: Ck, ds: [string, string][], o: { owner?: Person; agent?: { key: string; hash?: string } } = {}): Promise<string> {
  const owner = o.owner ?? k.c.ann;
  const G = await raised(k, ds.map(([r]) => r), owner);
  await k.agentDispose(owner, `${G}.validate`, ds.map(([r, d]) => disp(fpOf(r), d, { reason: `why ${r}` })), (o.agent ?? CHECKER) as never);
  k.tick();
  return G;
}
async function opened(k: Ck): Promise<Json[]> {
  return k.ev("spot-check.opened");
}
/** Every spot-check goal (from the opened events), oldest first. */
async function spotGoals(k: Ck): Promise<Json[]> {
  const ids = [...new Set((await opened(k)).map((e) => e.goal as string))];
  const out: Json[] = [];
  for (const id of ids) out.push((await k.goalView(id)).goal);
  return out.sort((a, b) => a.createdAt - b.createdAt);
}
const entryAt = async (k: Ck, rule: string, lineage = L) => (await k.lastDisposition(fpOf(rule), lineage)).at as number;
const verdict = (k: Ck, who: Person | string, step: string, b: Record<string, unknown>) => k.r.call(who, "POST", `/v1/steps/${step}/spot-checks`, { reason: "R", answer: "ANS", ...b });

// =============================================================================================
// AC-03 sampling on and off, goal shape, exclusions
// =============================================================================================

describe("RL-18 AC-03 sampling", { timeout: 90_000 }, () => {
  it("test_AC03_off_no_sampling", async () => {
    const k = await fresh();
    await decided(k, [
      ["A", "confirmed"],
      ["B", "dismissed"],
    ]);
    expect(await opened(k)).toStrictEqual([]);
    expect(await spotGoals(k)).toStrictEqual([]);
  });

  it("test_AC03_rate_one_goal_shape", async () => {
    const k = await fresh({ spotChecks: ON });
    const G = await raised(k, ["A", "B"]);
    const now = k.tick();
    await k.agentDispose(k.c.ann, `${G}.validate`, [disp(fpOf("A"), "confirmed"), disp(fpOf("B"), "dismissed")]);
    const gs = await spotGoals(k);
    expect(gs).toHaveLength(1);
    const S = gs[0];
    const atA = await entryAt(k, "A");
    const atB = await entryAt(k, "B");
    expect(S).toMatchObject({ ownerId: "ann", title: `Spot-check ${CHECK}@${h12(V)}`, primaryRepo: ALPHA, state: "in_progress", preset: { name: "spot-check" } });
    expect(S.refs).toBeUndefined();
    expect(S.spotCheck).toStrictEqual({
      key: CHECK,
      hash: V,
      samples: [
        { lineage: L, fp: fpOf("A"), goal: G, step: `${G}.validate`, round: 1, at: atA, disposition: "confirmed", why: "rate", sampledAt: now },
        { lineage: L, fp: fpOf("B"), goal: G, step: `${G}.validate`, round: 1, at: atB, disposition: "dismissed", why: "rate", sampledAt: now },
      ],
    });
    const view = await k.goalView(S.id);
    const check = (view.steps as Json[]).find((s) => s.id === `${S.id}.check`);
    expect(check).toMatchObject({ state: "ready", policy: { mode: "debrief", assignee: "@owner", output: "review-record", inputs: ["spot-check"] } });
    expect((view.plans as Json[])[0]).toMatchObject({ version: 1, decision: "approved", comment: `spot checks of ${CHECK}@${h12(V)} (rate 1, at least 0 per week)` });
    const evs = await opened(k);
    expect(evs.map((e) => e.payload)).toStrictEqual([
      { key: CHECK, hash: V, sample: 1, lineage: L, fp: fpOf("A"), decisionGoal: G, decisionStep: `${G}.validate`, round: 1, disposition: "confirmed", why: "rate" },
      { key: CHECK, hash: V, sample: 2, lineage: L, fp: fpOf("B"), decisionGoal: G, decisionStep: `${G}.validate`, round: 1, disposition: "dismissed", why: "rate" },
    ]);
    expect(evs.every((e) => e.goal === S.id && e.step === `${S.id}.check` && e.user === "ann")).toBe(true);
    // The goal's creation events come first.
    const all = await k.r.allEvents();
    const created = all.findIndex((e) => e.type === "goal.created" && e.goal === S.id);
    const first = all.findIndex((e) => e.type === "spot-check.opened");
    expect(created).toBeGreaterThanOrEqual(0);
    expect(created).toBeLessThan(first);
    // Activity text.
    expect(await k.timeline(S.id)).toContain(`opened spot check 1 of ${CHECK}@${h12(V)} (confirmed ${fpOf("A")})`);
  });

  it("test_AC03_not_sampled", async () => {
    const k = await fresh({ spotChecks: ON });
    const ann = k.c.ann;
    // An agent decision without a hash.
    const G1 = await decided(k, [["H", "confirmed"]], { agent: { key: CHECK } });
    // A person's stage record (an interactive consuming step).
    const G2 = await raised(k, ["Q"], ann, [P.audit(), P.validate({ mode: "interactive", agent: undefined })]);
    await k.k.submit(ann, `${G2}.validate`, rec({ dispositions: [disp(fpOf("Q"), "confirmed")] }));
    expect((await k.lastDisposition(fpOf("Q"), L)).decider).toStrictEqual({ kind: "person", user: "ann" });
    // An agent disposition that agrees with the person (RL-6 rule 2), then one the hub ignores.
    const filer = (id: string, deps: string[]): PlanIn => ({ id, repo: ALPHA, deps, mode: "headless", agent: "filer", output: "review-record", consumes: ["accepted"], may_set: ["accepted", "dismissed"] });
    const G3 = await k.goal(ann, [P.audit(), P.debrief({ deps: ["audit"], consumes: ["open"], may_set: ["accepted", "dismissed"] }), filer("file", ["debrief"]), filer("file2", ["file"])]);
    await k.raise(ann, `${G3}.audit`, [item("R")]);
    await k.k.claim(ann, `${G3}.debrief`);
    await k.personDispose(ann, `${G3}.debrief`, fpOf("R"), "accepted");
    await k.k.reviewOk(ann, `${G3}.debrief`, rec({ dispositions: [] }));
    await k.k.closeOk(ann, `${G3}.debrief`);
    const r1 = await k.k.submit(ann, `${G3}.file`, rec({ dispositions: [disp(fpOf("R"), "accepted", { link: "https://tracker.invalid/1" })], agent: CHECKER }));
    expect(r1.applied).toBe(1);
    const r2 = await k.k.submit(ann, `${G3}.file2`, rec({ dispositions: [disp(fpOf("R"), "dismissed")], agent: CHECKER }));
    expect(r2.applied).toBe(0);
    for (const G of [G1, G2, G3]) expect((await opened(k)).filter((e) => e.payload.decisionGoal === G), G).toStrictEqual([]);
    // A trial goal's decision.
    const pk = k.pulses();
    const p = await pk.pulseOk("ann", body({ params: { repo: "alpha" } }, "relay2", RELAY2));
    const GT = (await pk.act("ann", p.id as string, "fire", { trial: true })).json.slot.goal as string;
    const res = await k.raise(ann, `${GT}.audit`, [item("T")]);
    await k.agentDispose(ann, `${GT}.validate`, [disp(fpOf("T"), "confirmed")]);
    expect((await k.lastDisposition(fpOf("T"), res.review.lineage)).decider.kind).toBe("agent");
    expect(await opened(k)).toStrictEqual([]);
    // Control: a plain agent decision is sampled.
    const G4 = await decided(k, [["Z", "confirmed"]]);
    expect((await opened(k)).map((e) => e.payload.decisionGoal)).toStrictEqual([G4]);
  });
});

const RELAY2 = `description: Audit, validate
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
    may_set: [confirmed, accepted, dismissed]
    title: Validate
    brief: Validate.
  - id: debrief
    kind: review
    repo: "{repo}"
    deps: [validate]
    mode: debrief
    output: review-record
    consumes: [open, confirmed, dismissed]
    may_set: [confirmed, dismissed]
    title: Debrief
    brief: Debrief.
`;

// =============================================================================================
// AC-04 appending, the cap, the minimum, the rate, checker rule 1
// =============================================================================================

describe("RL-18 AC-04 appending and the rule", { timeout: 120_000 }, () => {
  it("test_AC04_append_then_new_goal", async () => {
    const k = await fresh({ spotChecks: ON });
    await decided(k, [["A", "confirmed"]]);
    await decided(k, [["B", "dismissed"]]);
    let gs = await spotGoals(k);
    expect(gs).toHaveLength(1);
    expect(gs[0].spotCheck.samples.map((x: Json) => x.fp)).toStrictEqual([fpOf("A"), fpOf("B")]);
    await k.k.claim(k.c.ann, `${gs[0].id}.check`);
    await decided(k, [["C", "confirmed"]]);
    gs = await spotGoals(k);
    expect(gs).toHaveLength(2);
    expect(gs[0].spotCheck.samples).toHaveLength(2);
    expect(gs[1].spotCheck.samples.map((x: Json) => x.fp)).toStrictEqual([fpOf("C")]);
    const ev = (await opened(k)).at(-1);
    expect(ev?.goal).toBe(gs[1].id);
    expect(ev?.payload.sample).toBe(1);
  });

  it("test_AC04_cap_50", async () => {
    const k = await fresh({ spotChecks: ON });
    const rules = Array.from({ length: 51 }, (_, i) => `R${i}`);
    await decided(
      k,
      rules.map((r) => [r, "confirmed"]),
    );
    const gs = await spotGoals(k);
    expect(gs.map((g) => g.spotCheck.samples.length)).toStrictEqual([50, 1]);
    expect(gs[1].spotCheck.samples[0].fp).toBe(fpOf("R50"));
  });

  it("test_AC04_minimum_per_week", async () => {
    const T = Date.UTC(2026, 10, 1, 12);
    const k = await fresh({ spotChecks: { rate: 0, min_per_week: 1 }, clock: T });
    await decided(k, [
      ["A", "confirmed"],
      ["A2", "confirmed"],
    ]);
    k.at(T + 3 * DAY);
    await decided(k, [["B", "confirmed"]]);
    k.at(T + 8 * DAY);
    await decided(k, [["C", "confirmed"]]);
    const samples = (await spotGoals(k)).flatMap((g) => g.spotCheck.samples as Json[]);
    expect(samples.map((x) => [x.fp, x.why])).toStrictEqual([
      [fpOf("A"), "minimum"],
      [fpOf("C"), "minimum"],
    ]);
  });

  it("test_AC04_rate_half", async () => {
    const k = await fresh({ spotChecks: { rate: 0.5, min_per_week: 0 } });
    const rules = Array.from({ length: 16 }, (_, i) => `H${i}`);
    const G = await decided(
      k,
      rules.map((r) => [r, "confirmed"]),
    );
    const want = rules.map((r) => fpOf(r)).filter((f) => u(L, f, `${G}.validate`, 1) < 0.5);
    expect(want.length).toBeGreaterThan(0);
    expect(want.length).toBeLessThan(rules.length);
    const samples = (await spotGoals(k)).flatMap((g) => g.spotCheck.samples as Json[]);
    expect(samples.map((x) => x.fp)).toStrictEqual(want);
    expect(samples.every((x) => x.why === "rate")).toBe(true);
  });

  it("test_AC04_catalog_checker", async () => {
    const k = await fresh({ spotChecks: ON });
    const cat = k.catalog();
    await cat.sourceOk(SRC_URL, "agents", "root", { calibrator: "carol" });
    const m = await cat.pusher();
    await cat.pushOk(m, C1, { rev: REV1 });
    await decided(k, [["A", "confirmed"]], { agent: { key: "agents/rev", hash: H1 } });
    const gs = await spotGoals(k);
    expect(gs).toHaveLength(1);
    expect(gs[0]).toMatchObject({ ownerId: "carol", primaryRepo: SRC, spotCheck: { key: "agents/rev", hash: H1 } });
  });
});

// =============================================================================================
// AC-05 verdicts; AC-06 the done gate
// =============================================================================================

describe("RL-18 AC-05 AC-06 verdicts", { timeout: 90_000 }, () => {
  async function fixture(): Promise<{ k: Ck; G: string; S: string; X: string }> {
    const k = await fresh({ spotChecks: ON });
    const G = await raised(k, ["A", "B"]);
    await k.agentDispose(k.c.ann, `${G}.validate`, [disp(fpOf("A"), "confirmed", { reason: "looks real" }), disp(fpOf("B"), "dismissed", { reason: "noise" })]);
    const S = (await spotGoals(k))[0].id as string;
    return { k, G, S, X: `${S}.check` };
  }

  it("test_AC05_route_checks", async () => {
    const { k, G, X } = await fixture();
    const ann = k.c.ann;
    expect(await verdict(k, ann, "G999.check", { sample: 1, verdict: "agree" })).toMatchObject({ status: 404, json: { error: "no step G999.check" } });
    expect(await verdict(k, ann, `${G}.validate`, { sample: 1, verdict: "agree" })).toMatchObject({ status: 409, json: { error: `${G}.validate is not a spot-check step` } });
    expect(await verdict(k, ann, X, { sample: 1, verdict: "agree" })).toMatchObject({ status: 409, json: { error: `${X} is ready; only a held spot check takes verdicts` } });
    // Only the assignee claims it (RL-4).
    const bc = await k.r.act(k.c.bob, X, "claim", {});
    expect(bc.status).toBe(403);
    await k.k.claim(ann, X);
    expect(await verdict(k, k.c.bob, X, { sample: 1, verdict: "agree" })).toMatchObject({ status: 403, json: { error: `${X} is held by ann` } });
    expect(await verdict(k, k.c.root, X, { sample: 1, verdict: "agree" })).toMatchObject({ status: 403, json: { error: `${X} is held by ann` } });
    const sb: Session = { sid: "s-bob-on-bm", claudeSessionIds: ["c-bob"], cwd: "", kind: "interactive", state: "idle", quiet: false, startedAt: k.w.clock, lastEventAt: k.w.clock, turns: 0, humanPrompts: 0, seenByReconciler: true };
    await k.w.hubStore.upsertSession(sb, "bob", k.w.machineOf(k.c.bob), k.w.clock);
    expect(await verdict(k, ann, X, { sample: 1, verdict: "agree", sid: sb.sid })).toStrictEqual({ status: 403, json: { error: `session ${sb.sid} is not yours on this machine` } });
    expect(await verdict(k, ann, X, { sample: 3, verdict: "agree" })).toMatchObject({ status: 404, json: { error: `${X} has no sample 3` } });
    expect(await verdict(k, ann, X, { sample: 1, verdict: "agree", expected: "dismissed" })).toMatchObject({ status: 422, json: { error: "expected is only for disagree" } });
    expect(await verdict(k, ann, X, { sample: 1, verdict: "disagree", expected: "confirmed" })).toMatchObject({ status: 422, json: { error: "expected confirmed is the agent's decision; record agree" } });
    expect((await verdict(k, ann, X, { sample: 1, verdict: "maybe" })).status).toBe(400);
    expect((await verdict(k, ann, X, { sample: 1, verdict: "agree", extra: 1 })).status).toBe(400);
    const ok = await verdict(k, ann, X, { sample: 1, verdict: "agree" });
    expect(ok.status).toBe(201);
    expect(await verdict(k, ann, X, { sample: 1, verdict: "disagree" })).toMatchObject({ status: 409, json: { error: `sample 1 of ${X} already has a verdict` } });
  });

  it("test_AC05_verdict_and_context", async () => {
    const { k, G, S, X } = await fixture();
    const ann = k.c.ann;
    const debriefs = await k.r.call(ann, "GET", "/v1/debriefs");
    expect((debriefs.json.debriefs as Json[]).map((d) => d.step)).toContain(X);
    await k.k.claim(ann, X);
    const at = k.tick();
    const res = await verdict(k, ann, X, { sample: 2, verdict: "disagree", expected: "confirmed", reason: "it is real", answer: "No, that one is a real leak" });
    expect(res.status).toBe(201);
    const atB = await entryAt(k, "B");
    expect(res.json).toStrictEqual({
      sample: {
        n: 2,
        lineage: L,
        fp: fpOf("B"),
        goal: G,
        step: `${G}.validate`,
        round: 1,
        at: atB,
        disposition: "dismissed",
        why: "rate",
        sampledAt: res.json.sample.sampledAt,
        verdict: { verdict: "disagree", reason: "it is real", answer: "No, that one is a real leak", expected: "confirmed", by: "ann", at },
      },
      left: 1,
    });
    // The item is unchanged by a verdict.
    expect((await k.item(fpOf("B"), L)).state).toBe("dismissed");
    const ev = await k.ev("spot-check.decided", S);
    expect(ev).toHaveLength(1);
    expect(ev[0]).toMatchObject({ user: "ann", step: X, payload: { key: CHECK, hash: V, sample: 2, lineage: L, fp: fpOf("B"), verdict: "disagree", expected: "confirmed" } });
    expect(await k.timeline(S)).toContain(`spot check 2 of ${CHECK}@${h12(V)}: disagree`);
    // The spot-check input.
    const ctx = await k.k.ctx(ann, X);
    const ins = ((ctx.inputs ?? []) as Json[]).filter((x) => x.artifact === "spot-check");
    expect(ins).toHaveLength(1);
    expect(ins[0]).toMatchObject({ from: S, kind: "review", title: `spot checks of ${CHECK}@${h12(V)} (2)` });
    const c = JSON.parse(ins[0].content as string);
    expect(c.agent).toStrictEqual({ key: CHECK, hash: V });
    expect(c.samples).toHaveLength(2);
    expect(c.samples[0]).toMatchObject({ sample: 1, fp: fpOf("A"), disposition: "confirmed", why: "rate", reason: "looks real", title: "T-A", state: "confirmed", rule: "A", path: "src/a.ts" });
    expect("verdict" in c.samples[0]).toBe(false);
    expect(Array.isArray(c.samples[0].evidence)).toBe(true);
    expect(c.samples[1]).toMatchObject({ sample: 2, fp: fpOf("B"), disposition: "dismissed", reason: "noise", state: "dismissed", verdict: { verdict: "disagree", by: "ann" } });
  });

  it("test_AC06_done_gate", async () => {
    const { k, S, X } = await fixture();
    const ann = k.c.ann;
    await k.k.claim(ann, X);
    expect((await verdict(k, ann, X, { sample: 1, verdict: "agree" })).status).toBe(201);
    await k.k.reviewOk(ann, X, rec({ dispositions: [], assessment: "clean" }));
    const d = await k.k.close(ann, X);
    expect(d).toMatchObject({ status: 409, json: { error: `${X} has 1 sample(s) without a verdict; record each with mesh_spot_check, then mesh_done` } });
    expect((await verdict(k, ann, X, { sample: 2, verdict: "agree" })).status).toBe(201);
    await k.k.closeOk(ann, X);
    expect((await k.goalView(S)).goal.state).toBe("done");
  });
});

// =============================================================================================
// AC-07 disagreements in calibration
// =============================================================================================

describe("RL-18 AC-07 calibration", { timeout: 120_000 }, () => {
  /** n decisions of the checker in one goal, each sampled; verdicts recorded by ann. */
  async function judged(k: Ck, rules: string[], verdicts: string[]): Promise<string> {
    await decided(
      k,
      rules.map((r) => [r, "confirmed"]),
    );
    const S = (await spotGoals(k)).at(-1)?.id as string;
    const X = `${S}.check`;
    await k.k.claim(k.c.ann, X);
    for (const [i, v] of verdicts.entries()) {
      k.tick();
      const r = await verdict(k, k.c.ann, X, { sample: i + 1, verdict: v });
      expect(r.status, JSON.stringify(r.json)).toBe(201);
    }
    return S;
  }

  it("test_AC07_disagreements_open_calibration", async () => {
    const k = await fresh({ spotChecks: ON, threshold: 3 });
    const S = await judged(k, ["A", "B", "C", "D"], ["disagree", "agree", "disagree"]);
    expect(await k.calibOf(CHECK, V)).toStrictEqual([]);
    k.tick();
    expect((await verdict(k, k.c.ann, `${S}.check`, { sample: 4, verdict: "disagree" })).status).toBe(201);
    const cs = await k.calibOf(CHECK, V);
    expect(cs).toHaveLength(1);
    const samples = (await k.goalView(S)).goal.spotCheck.samples as Json[];
    const ref = (x: Json) => ({ lineage: x.lineage, fp: x.fp, goal: x.goal, step: x.step, round: x.round, at: x.at });
    expect(cs[0].calibration).toStrictEqual({ key: CHECK, hash: V, threshold: 3, dismissals: [], disagreements: [samples[0], samples[2], samples[3]].map(ref) });
    const ev = await k.ev("calibration.opened", cs[0].id);
    expect(ev[0].payload).toStrictEqual({ key: CHECK, hash: V, dismissals: 0, disagreements: 3, threshold: 3, calibrator: "ann" });
    expect(((await k.goalView(cs[0].id)).plans as Json[])[0].comment).toBe(`calibration of ${CHECK}@${h12(V)} (0 dismissals, 3 disagreements, threshold 3)`);
    // The calibration input lists the disagreements with the verdict and the agent's reason.
    const ctx = await k.k.ctx(k.c.ann, `${cs[0].id}.calibrate`);
    const ins = ((ctx.inputs ?? []) as Json[]).filter((x) => x.artifact === "calibration");
    expect(ins[0].title).toBe(`dismissals of ${CHECK}@${h12(V)} (0), disagreements (3)`);
    const c = JSON.parse(ins[0].content as string);
    expect(c.dismissals).toStrictEqual([]);
    expect(c.disagreements).toHaveLength(3);
    expect(c.disagreements[0]).toMatchObject({ ...ref(samples[0]), disposition: "confirmed", reason: "why A", verdict: { reason: "R", answer: "ANS", by: "ann" }, title: "T-A", rule: "A" });
  });

  it("test_AC07_mixed", async () => {
    const k = await fresh({ spotChecks: ON, threshold: 3 });
    // The checker raises items too (as the auditor of another goal) and two get dismissed.
    for (const r of ["M1", "M2"]) {
      const G = await k.goal(k.c.bob, [P.audit(), P.validate()]);
      await k.raise(k.c.bob, `${G}.audit`, [item(r)], CHECKER);
      await k.agentDispose(k.c.bob, `${G}.validate`, [disp(fpOf(r), "dismissed")], { key: "alpha/other", hash: HA });
    }
    expect(await k.calibOf(CHECK, V)).toStrictEqual([]);
    await judged(k, ["A"], ["disagree"]);
    const cs = await k.calibOf(CHECK, V);
    expect(cs).toHaveLength(1);
    expect(cs[0].calibration.dismissals).toHaveLength(2);
    expect(cs[0].calibration.disagreements).toHaveLength(1);
    // The newest listed dismissal decides the calibrator (rule 3: its goal's owner).
    expect(cs[0].ownerId).toBe("bob");
  });

  it("test_AC07_done_counts_again", async () => {
    const k = await fresh({ spotChecks: ON, threshold: 2 });
    await judged(k, ["A", "B"], ["disagree", "disagree"]);
    const cs = await k.calibOf(CHECK, V);
    expect(cs).toHaveLength(1);
    const C = cs[0].id as string;
    await k.k.claim(k.c.ann, `${C}.calibrate`);
    await k.k.reviewOk(k.c.ann, `${C}.calibrate`, rec({ assessment: "clean", summary: "no change: fine" }));
    await k.k.closeOk(k.c.ann, `${C}.calibrate`);
    const done = await k.ev("calibration.done", C);
    expect(done[0].payload).toStrictEqual({ key: CHECK, hash: V, dismissals: 0, disagreements: 2, outcome: "no-change" });
    await judged(k, ["C"], ["disagree"]);
    expect((await k.calibOf(CHECK, V)).filter((g) => g.state !== "done")).toStrictEqual([]);
    await judged(k, ["D"], ["disagree"]);
    const open = (await k.calibOf(CHECK, V)).filter((g) => g.state !== "done");
    expect(open).toHaveLength(1);
    expect(open[0].calibration.disagreements.map((d: Json) => d.fp)).toStrictEqual([fpOf("C"), fpOf("D")]);
  });

  it("test_AC07_no_disagreements_no_key", async () => {
    const k = await fresh({ threshold: 1 });
    await k.dismissOne(k.c.ann, "X");
    const cs = await k.calibOf(KEY, HA);
    expect(cs).toHaveLength(1);
    expect("disagreements" in cs[0].calibration).toBe(false);
    expect("disagreements" in (await k.ev("calibration.opened", cs[0].id))[0].payload).toBe(false);
  });
});

// =============================================================================================
// AC-08 health
// =============================================================================================

describe("RL-18 AC-08 health", { timeout: 120_000 }, () => {
  const health = async (k: Ck, q = "") => {
    const r = await k.r.call(k.c.ann, "GET", `/v1/health${q}`);
    expect(r.status, JSON.stringify(r.json)).toBe(200);
    return r.json;
  };

  it("test_AC08_decisions_and_share", async () => {
    const T = Date.UTC(2026, 10, 20, 12);
    const k = await fresh({ clock: T - 3 * DAY });
    const ann = k.c.ann;
    const pk = k.pulses();
    const p1 = (await pk.pulseOk("ann", body({ params: { repo: "alpha" } }, "relay2", RELAY2))).id as string;
    const p2 = (await pk.pulseOk("ann", body({ params: { repo: "alpha" } }, "relay2", RELAY2))).id as string;
    const p3 = (await pk.pulseOk("ann", body({ params: { repo: "alpha" } }, "relay2", RELAY2))).id as string;
    // An old goal of p1: decisions before the window (days=1).
    const G0 = (await pk.fireOk("ann", p1)).goal as string;
    await k.raise(ann, `${G0}.audit`, [item("O")]);
    await k.agentDispose(ann, `${G0}.validate`, [disp(fpOf("O"), "confirmed")]);
    k.at(T - 3_600_000);
    // p1's goal in the window: 3 agent decisions, 1 person decision (reverted later: still counts).
    const G = (await pk.fireOk("ann", p1)).goal as string;
    await k.raise(ann, `${G}.audit`, [item("X"), item("Y"), item("Z")]);
    await k.agentDispose(ann, `${G}.validate`, [disp(fpOf("X"), "accepted"), disp(fpOf("Y"), "dismissed"), disp(fpOf("Z"), "confirmed")]);
    await k.k.claim(ann, `${G}.debrief`);
    await k.personDispose(ann, `${G}.debrief`, fpOf("Y"), "confirmed");
    await k.revert(ann, `${G}.debrief`, fpOf("Y"));
    // A trial goal of p1 with one agent decision.
    const GT = (await pk.act("ann", p1, "fire", { trial: true })).json.slot.goal as string;
    await k.raise(ann, `${GT}.audit`, [item("T")]);
    await k.agentDispose(ann, `${GT}.validate`, [disp(fpOf("T"), "confirmed")]);
    // p3: agent decisions only.
    const G3 = (await pk.fireOk("ann", p3)).goal as string;
    await k.raise(ann, `${G3}.audit`, [item("P")]);
    await k.agentDispose(ann, `${G3}.validate`, [disp(fpOf("P"), "confirmed")]);
    k.at(T);
    const h = await health(k, "?days=1");
    const of = (id: string) => (h.pulses as Json[]).find((x) => x.pulse === id) as Json;
    expect(of(p1).decisions).toStrictEqual({ total: 4, byPeople: 1 });
    expect(of(p1).humanDecisionShare).toBe(0.25);
    expect(of(p2).decisions).toStrictEqual({ total: 0, byPeople: 0 });
    expect("humanDecisionShare" in of(p2)).toBe(false);
    expect(of(p3).decisions).toStrictEqual({ total: 1, byPeople: 0 });
    expect(of(p3).humanDecisionShare).toBe(0);
    expect(h.total.decisions).toStrictEqual({ total: 5, byPeople: 1 });
    expect(h.total.humanDecisionShare).toBe(0.2);
    // Trial included: p1 gains the trial goal's decision.
    const hi = await health(k, "?days=1&trial=include");
    expect((hi.pulses as Json[]).find((x) => x.pulse === p1)?.decisions).toStrictEqual({ total: 5, byPeople: 1 });
    expect(hi.total.humanDecisionShare).toBe(Math.round((1 / 6) * 10_000) / 10_000);
    // A wider window takes the old goal's decision.
    expect((await health(k, "?days=7")).pulses.find((x: Json) => x.pulse === p1).decisions).toStrictEqual({ total: 5, byPeople: 1 });
    // No spot checks configured: zeros.
    expect(h.total.spotChecks).toStrictEqual({ open: 0, decided: 0, disagreed: 0 });
  });

  it("test_AC08_spot_checks_total", async () => {
    const T = Date.UTC(2026, 10, 20, 12);
    const k = await fresh({ spotChecks: ON, clock: T - 2 * DAY });
    await decided(k, [
      ["A", "confirmed"],
      ["B", "confirmed"],
      ["C", "confirmed"],
      ["D", "confirmed"],
    ]);
    const S = (await spotGoals(k))[0];
    const X = `${S.id}.check`;
    await k.k.claim(k.c.ann, X);
    k.at(T - 3 * 3_600_000);
    expect((await verdict(k, k.c.ann, X, { sample: 1, verdict: "agree" })).status).toBe(201);
    expect((await verdict(k, k.c.ann, X, { sample: 2, verdict: "disagree" })).status).toBe(201);
    k.at(T);
    const h = (await k.r.call(k.c.ann, "GET", "/v1/health?days=1")).json;
    const sampledAt = S.spotCheck.samples[0].sampledAt as number;
    expect(h.total.spotChecks).toStrictEqual({ open: 2, oldestMs: T - sampledAt, decided: 2, disagreed: 1 });
    // Whatever the filters say.
    const f = (await k.r.call(k.c.ann, "GET", "/v1/health?days=1&repo=nope")).json;
    expect(f.pulses).toStrictEqual([]);
    expect(f.total.spotChecks).toStrictEqual(h.total.spotChecks);
    // A verdict before the window is not decided in it.
    expect((await k.r.call(k.c.ann, "GET", "/v1/health?days=1")).json.total.spotChecks.decided).toBe(2);
    k.at(T + 2 * DAY);
    expect((await k.r.call(k.c.ann, "GET", "/v1/health?days=1")).json.total.spotChecks).toMatchObject({ open: 2, decided: 0, disagreed: 0 });
  });
});
