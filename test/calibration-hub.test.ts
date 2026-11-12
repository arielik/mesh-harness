// RL-6 World tests through the hub API: filed items (fix 1, AC-05), agreeing agent dispositions
// (fix 2, AC-06), the stats route (AC-07, AC-08, AC-09), the calibration trigger (AC-10), the
// calibrator order (AC-11), the `calibration` input (AC-12) and calibration done (AC-13). Written from
// the spec's contracts only (docs/specs/RL-6.md). Counts are computed here from each test's own
// fixture; fold sums are read back from the records (`GET /v1/steps/:id/reviews`).

import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { ALPHA, CHECK, Ck, DAY, disp, enc, fpOf, h12, HA, HB, HZ, item, KEY, NOV19, P, rec, sha, tel, V } from "./helpers/calib-kit.ts";
import type { PlanIn } from "./helpers/relay-kit.ts";
import { L } from "./helpers/review-kit.ts";
import { C1, C2, H1, H2, REV1, REV2, SRC, SRC_URL } from "./helpers/roster-kit.ts";
import { body, SOLO_HL } from "./helpers/pulse-kit.ts";
import type { Json, Person } from "./helpers/world.ts";

const T = NOV19;
const F = sha("filer-f");
const FILER = { key: "alpha/filer", hash: F };
const LINK = "https://tracker.invalid/issue/1";
const reasonOf = (user: string) => `decided by ${user} in this goal`;

let ck: Ck | undefined;
const fresh = async (o: { threshold?: number; clock?: number } = {}): Promise<Ck> => {
  ck = await Ck.start(o);
  return ck;
};
const stopFresh = async () => {
  await ck?.stop();
  ck = undefined;
};

/** The `items` (dispositions) input of a step's context, parsed; undefined when absent. */
function itemsInput(ctx: Json): Json | undefined {
  const e = ((ctx.inputs ?? []) as Json[]).find((x) => x.artifact === "items");
  return e ? JSON.parse(e.content as string) : undefined;
}
function calibrationInputs(ctx: Json): Json[] {
  return ((ctx.inputs ?? []) as Json[]).filter((x) => x.artifact === "calibration");
}

// =============================================================================================
// AC-05 Filed items are not consumed (fix 1)
// =============================================================================================

describe("RL-6 AC-05 filed items", { timeout: 60_000 }, () => {
  let k: Ck;
  let ann: Person;
  const A = fpOf("A");
  const B = fpOf("B");
  /** audit → debrief (person, accepts) → file (interactive filer, consumes accepted, inputs dispositions). */
  const plan = (): PlanIn[] => [
    P.audit(),
    P.debrief({ deps: ["audit"], when: { open: true }, consumes: ["open"], may_set: ["accepted"] }),
    { id: "file", repo: ALPHA, deps: ["debrief"], output: "review-record", when: { open: true }, consumes: ["accepted"], may_set: ["accepted"], inputs: ["dispositions"] },
  ];
  let G1 = "";

  beforeAll(async () => {
    k = await Ck.start();
    ann = k.c.ann;
  });
  afterAll(async () => {
    await k?.stop();
  });

  async function debrief(G: string, accept: string[]): Promise<void> {
    await k.k.claim(ann, `${G}.debrief`);
    for (const f of accept) await k.personDispose(ann, `${G}.debrief`, f, "accepted");
    await k.k.reviewOk(ann, `${G}.debrief`, rec({ dispositions: [] }));
    await k.k.closeOk(ann, `${G}.debrief`);
  }

  it("test_AC05_unfiled_runs", async () => {
    G1 = await k.goal(ann, plan());
    await k.raise(ann, `${G1}.audit`, [item("A", { severity: "S2" })]);
    await debrief(G1, [A]);
    expect((await k.item(A, L)).state).toBe("accepted");
    expect(await k.k.state(`${G1}.file`)).toBe("ready");
    const input = itemsInput(await k.k.ctx(ann, `${G1}.file`));
    expect(input, "dispositions input of the filer").toBeDefined();
    expect((input.items as Json[]).map((x) => x.fp)).toContain(A);
  });

  it("test_AC05_filed_skipped", async () => {
    await k.k.claim(ann, `${G1}.file`);
    const res = await k.k.reviewOk(ann, `${G1}.file`, rec({ dispositions: [disp(A, "accepted", { link: LINK })] }));
    expect(res.applied).toBe(1);
    await k.k.closeOk(ann, `${G1}.file`);
    expect((await k.item(A, L)).link).toBe(LINK);
    // G2: A repeats (accepted with the link), nothing else is accepted.
    const G2 = await k.goal(ann, plan());
    await k.raise(ann, `${G2}.audit`, [item("A", { severity: "S2" })]);
    const a = await k.item(A, L);
    expect(a.state).toBe("accepted");
    expect(a.link).toBe(LINK);
    expect(await k.k.state(`${G2}.debrief`)).toBe("skipped");
    expect(await k.k.state(`${G2}.file`)).toBe("skipped");
    expect(await k.r.events("step.skipped", `${G2}.file`)).toHaveLength(1);
    const input = itemsInput(await k.k.ctx(ann, `${G2}.file`));
    expect(((input?.items ?? []) as Json[]).map((x) => x.fp)).not.toContain(A);
  });

  it("test_AC05_mixed_lists_only_unfiled", async () => {
    const G3 = await k.goal(ann, plan());
    await k.raise(ann, `${G3}.audit`, [item("A", { severity: "S2" }), item("B", { severity: "S3" })]);
    expect((await k.item(B, L)).state).toBe("open");
    await debrief(G3, [B]);
    expect(await k.k.state(`${G3}.file`)).toBe("ready");
    const input = itemsInput(await k.k.ctx(ann, `${G3}.file`));
    const fps = ((input?.items ?? []) as Json[]).map((x) => x.fp);
    expect(fps).toContain(B);
    expect(fps).not.toContain(A);
  });
});

// =============================================================================================
// AC-06 Agent dispositions that agree with a person (fix 2)
// =============================================================================================

describe("RL-6 AC-06 agreeing agent dispositions", { timeout: 60_000 }, () => {
  afterEach(stopFresh);
  const A = fpOf("A");
  const B = fpOf("B");
  const filer = (id: string, deps: string[]): PlanIn => ({ id, repo: ALPHA, deps, mode: "headless", agent: "filer", output: "review-record", consumes: ["accepted"], may_set: ["accepted", "dismissed"] });
  const plan = (): PlanIn[] => [P.audit(), P.debrief({ deps: ["audit"], consumes: ["open"], may_set: ["accepted", "dismissed"] }), filer("file", ["debrief"]), filer("file2", ["file"])];

  /** ann's debrief accepts A (and closes); the filer step is ready. */
  async function accepted(k: Ck): Promise<string> {
    const ann = k.c.ann;
    const G = await k.goal(ann, plan());
    await k.raise(ann, `${G}.audit`, [item("A", { severity: "S2" })]);
    await k.k.claim(ann, `${G}.debrief`);
    await k.personDispose(ann, `${G}.debrief`, A, "accepted");
    await k.k.reviewOk(ann, `${G}.debrief`, rec({ dispositions: [] }));
    await k.k.closeOk(ann, `${G}.debrief`);
    await k.k.claim(ann, `${G}.file`);
    return G;
  }

  it("test_AC06_agree_applied_and_person_still_wins", async () => {
    const k = await fresh();
    const ann = k.c.ann;
    const G = await accepted(k);
    const disposedBefore = (await k.r.events("item.disposed", `${G}.file`)).length;
    const res = await k.k.reviewOk(ann, `${G}.file`, rec({ dispositions: [disp(A, "accepted", { link: LINK })], agent: FILER }));
    expect(res.applied).toBe(1);
    expect(res.ignored).toStrictEqual([]);
    const a = await k.item(A, L);
    expect(a.state).toBe("accepted");
    expect(a.link).toBe(LINK);
    expect((await k.lastDisposition(A, L)).decider).toStrictEqual({ kind: "agent", key: FILER.key, hash: FILER.hash });
    expect((await k.r.events("item.disposed", `${G}.file`)).filter((e) => e.payload.fp === A)).toHaveLength(disposedBefore + 1);
    await k.k.closeOk(ann, `${G}.file`);
    // test_AC06_person_still_wins_after_agent_entry: a later agent stage that dismisses A is ignored.
    const n = ((await k.item(A, L)).history as Json[]).length;
    await k.k.claim(ann, `${G}.file2`);
    const r2 = await k.k.reviewOk(ann, `${G}.file2`, rec({ dispositions: [disp(A, "dismissed")], agent: FILER }));
    expect(r2.ignored).toStrictEqual([{ fingerprint: A, reason: reasonOf("ann") }]);
    expect(r2.applied).toBe(0);
    const after = await k.item(A, L);
    expect(after.state).toBe("accepted");
    expect(after.link).toBe(LINK);
    expect((after.history as Json[]).length).toBe(n);
  });

  it("test_AC06_disagree_ignored", async () => {
    const k = await fresh();
    const ann = k.c.ann;
    const G = await accepted(k);
    const n = ((await k.item(A, L)).history as Json[]).length;
    const res = await k.k.reviewOk(ann, `${G}.file`, rec({ dispositions: [disp(A, "dismissed")], agent: FILER }));
    expect(res.ignored).toStrictEqual([{ fingerprint: A, reason: reasonOf("ann") }]);
    expect(res.applied).toBe(0);
    const a = await k.item(A, L);
    expect(a.state).toBe("accepted");
    expect((a.history as Json[]).length).toBe(n);
    expect(await k.r.events("item.disposed", `${G}.file`)).toHaveLength(0);
  });

  it("test_AC06_restate_not_consumed_no_422", async () => {
    const k = await fresh();
    const ann = k.c.ann;
    const G = await k.goal(ann, [
      P.audit(),
      P.debrief({ deps: ["audit"], consumes: ["open"], may_set: ["accepted", "dismissed"] }),
      { id: "stage", repo: ALPHA, deps: ["debrief"], mode: "headless", agent: "checker", output: "review-record", consumes: ["open"], may_set: ["dismissed"] },
    ]);
    await k.raise(ann, `${G}.audit`, [item("A"), item("B")]);
    await k.k.claim(ann, `${G}.debrief`);
    await k.personDispose(ann, `${G}.debrief`, A, "dismissed");
    await k.k.reviewOk(ann, `${G}.debrief`, rec({ dispositions: [] }));
    await k.k.closeOk(ann, `${G}.debrief`);
    const n = ((await k.item(A, L)).history as Json[]).length;
    await k.k.claim(ann, `${G}.stage`);
    const res = await k.k.review(ann, `${G}.stage`, rec({ dispositions: [disp(A, "dismissed"), disp(B, "dismissed")], agent: { key: CHECK, hash: V } }));
    expect(res.status, JSON.stringify(res.json)).toBe(201);
    expect(res.json.ignored).toStrictEqual([{ fingerprint: A, reason: reasonOf("ann") }]);
    // Control: B (open, no person disposition) is applied as RL-2.
    expect(res.json.applied).toBe(1);
    expect((await k.item(B, L)).state).toBe("dismissed");
    const a = await k.item(A, L);
    expect(a.state).toBe("dismissed");
    expect((a.history as Json[]).length).toBe(n);
    expect((await k.k.close(ann, `${G}.stage`)).status).toBe(200);
  });
});

// =============================================================================================
// AC-07 Stats route shape
// =============================================================================================

describe("RL-6 AC-07 stats route", { timeout: 60_000 }, () => {
  afterEach(stopFresh);
  const DAYS = "days must be a whole number from 1 to 365";
  const KEYERR = "an agent key is <repo>/<name>";

  it("test_AC07_days_400", async () => {
    const k = await fresh();
    for (const d of ["0", "366", "x", "1.5"]) {
      expect(await k.r.call(k.c.ann, "GET", `/v1/agents/${enc(KEY)}/stats?days=${d}`), `days=${d}`).toStrictEqual({ status: 400, json: { error: DAYS } });
    }
    for (const d of ["1", "365"]) expect((await k.r.call(k.c.ann, "GET", `/v1/agents/${enc(KEY)}/stats?days=${d}`)).status, `days=${d}`).toBe(200);
  });

  it("test_AC07_key_400", async () => {
    const k = await fresh();
    expect(await k.r.call(k.c.ann, "GET", "/v1/agents/nokey/stats")).toStrictEqual({ status: 400, json: { error: KEYERR } });
    const k331 = `a/${"b".repeat(329)}`;
    const k330 = `a/${"b".repeat(328)}`;
    expect(k331).toHaveLength(331);
    expect(await k.r.call(k.c.ann, "GET", `/v1/agents/${enc(k331)}/stats`)).toStrictEqual({ status: 400, json: { error: KEYERR } });
    expect((await k.r.call(k.c.ann, "GET", `/v1/agents/${enc(k330)}/stats`)).status).toBe(200);
    expect((await k.r.call(k.c.ann, "GET", "/v1/agents/alpha%2Fauditor/stats")).status).toBe(200);
  });

  it("test_AC07_unknown_and_header", async () => {
    const k = await fresh();
    k.at(T);
    expect(await k.stats("zz/none")).toStrictEqual({ key: "zz/none", days: 30, since: T - 30 * DAY, threshold: 5, hashes: [] });
    expect(await k.stats("zz/none", "?days=7")).toStrictEqual({ key: "zz/none", days: 7, since: T - 7 * DAY, threshold: 5, hashes: [] });
    await stopFresh();
    const k2 = await fresh({ threshold: 2 });
    k2.at(T + 5);
    expect(await k2.stats("zz/none")).toStrictEqual({ key: "zz/none", days: 30, since: T + 5 - 30 * DAY, threshold: 2, hashes: [] });
  });

  it("test_AC07_auth", async () => {
    const k = await fresh();
    const path = `/v1/agents/${enc(KEY)}/stats`;
    expect((await k.w.call(undefined, "GET", path)).status).toBe(401);
    const reader = await k.w.hub.svc.serviceToken("reader", ["goals:read"]);
    expect((await k.w.call(reader, "GET", path)).status).toBe(200);
    const other = await k.w.hub.svc.serviceToken("live", ["live:read"]);
    expect((await k.w.call(other, "GET", path)).status).toBe(403);
  });
});

// =============================================================================================
// AC-08 Stats values
// =============================================================================================

describe("RL-6 AC-08 stats values", { timeout: 60_000 }, () => {
  let k: Ck;
  const A = fpOf("A");
  const B = fpOf("B");
  const C = fpOf("C");
  const D = fpOf("D");
  const E = fpOf("E");
  const Z = fpOf("Z");
  const t: Record<string, number> = {};
  const folds: Json[] = [];

  const dbr = (deps: string[]) => P.debrief({ deps, consumes: ["open", "confirmed"], may_set: ["accepted", "dismissed"] });

  beforeAll(async () => {
    k = await Ck.start();
    const ann = k.c.ann;
    // G0, T−40d: HB raises Z; the checker dismisses Z.
    const G0 = await k.goal(ann, [P.audit(), P.validate()]);
    k.at(T - 40 * DAY);
    await k.raise(ann, `${G0}.audit`, [item("Z")], { key: KEY, hash: HB });
    t.Z = T - 40 * DAY + 1_000;
    k.at(t.Z);
    await k.agentDispose(ann, `${G0}.validate`, [disp(Z, "dismissed")]);
    // G1, T−10d: run (cost 0.30, 60 000 ms); record raises A (S2), B, C with 1 undeclared rule.
    const G1 = await k.goal(ann, [P.run("r"), P.audit(), P.validate(), dbr(["validate"])]);
    k.at(T - 10 * DAY);
    t.r1 = await k.run(ann, `${G1}.r`, tel({ runId: "r1", agentKey: KEY, agentHash: HA, costUsdEstimate: 0.3, durationMs: 60_000 }));
    k.at(T - 10 * DAY + 1_000);
    await k.raise(ann, `${G1}.audit`, [item("A", { severity: "S2" }), item("B"), item("C")], { key: KEY, hash: HA }, { undeclaredRules: 1 });
    t.B = T - 9 * DAY;
    k.at(t.B);
    await k.agentDispose(ann, `${G1}.validate`, [disp(B, "dismissed")]);
    k.at(T - 8 * DAY);
    await k.k.claim(ann, `${G1}.debrief`);
    t.A = T - 8 * DAY;
    await k.personDispose(ann, `${G1}.debrief`, A, "accepted");
    t.C = T - 8 * DAY + 1_000;
    k.at(t.C);
    await k.personDispose(ann, `${G1}.debrief`, C, "dismissed");
    // G2, T−5d: run (no cost, 30 002 ms); record raises A, D, E with 2 undeclared rules; the debrief
    // accepts D and dismisses E, and both are reverted.
    const G2 = await k.goal(ann, [P.run("r"), P.audit(), dbr(["audit"])]);
    k.at(T - 5 * DAY);
    t.r2 = await k.run(ann, `${G2}.r`, tel({ runId: "r2", agentKey: KEY, agentHash: HA, durationMs: 30_002 }));
    k.at(T - 5 * DAY + 1_000);
    await k.raise(ann, `${G2}.audit`, [item("A", { severity: "S2" }), item("D"), item("E")], { key: KEY, hash: HA }, { undeclaredRules: 2 });
    k.at(T - 4 * DAY);
    await k.k.claim(ann, `${G2}.debrief`);
    await k.personDispose(ann, `${G2}.debrief`, D, "accepted");
    k.tick();
    await k.revert(ann, `${G2}.debrief`, D);
    k.tick();
    await k.personDispose(ann, `${G2}.debrief`, E, "dismissed");
    k.tick();
    await k.revert(ann, `${G2}.debrief`, E);
    // G3, T−3d: a failed run (cost 0.10, 90 000 ms), no record.
    const G3 = await k.goal(ann, [P.run("r")]);
    k.at(T - 3 * DAY);
    t.r3 = await k.run(ann, `${G3}.r`, tel({ runId: "r3", agentKey: KEY, agentHash: HA, costUsdEstimate: 0.1, durationMs: 90_000 }), "fail");
    // G4, T−2d: HZ's record raises nothing.
    const G4 = await k.goal(ann, [P.audit()]);
    k.at(T - 2 * DAY);
    await k.raise(ann, `${G4}.audit`, [], { key: KEY, hash: HZ });
    for (const G of [G1, G2]) {
      const rv = (await k.k.reviews(ann, `${G}.audit`)).json.reviews as Json[];
      expect(rv).toHaveLength(1);
      folds.push(rv[0].fold ?? {});
    }
    expect(folds[0].new, "G1 fold.new (sanity)").toBe(3);
    k.at(T);
  });
  afterAll(async () => {
    await k?.stop();
  });

  const sum = (f: string) => folds.reduce((n, x) => n + ((x[f] as number | undefined) ?? 0), 0);

  it("test_AC08_values_30d", async () => {
    const s = await k.stats(KEY);
    expect(s.hashes.map((h: Json) => h.hash)).toStrictEqual([HA, HB]);
    expect(s.hashes[0]).toStrictEqual({
      hash: HA,
      runs: 3,
      failures: 1,
      meanCostUsd: expect.closeTo(0.2, 10),
      meanDurationMs: 60_001,
      raised: 6,
      new: sum("new"),
      regressions: sum("regression"),
      carried: sum("carried"),
      undeclaredRules: 3,
      accepted: 1,
      dismissedByAgents: 1,
      dismissedByPeople: 1,
      reinstated: 0,
      uncalibrated: 2,
      calibrating: 0,
      calibrated: 0,
      lastAt: t.r3,
    });
    expect(s.hashes[1]).toStrictEqual({
      hash: HB,
      runs: 0,
      failures: 0,
      meanCostUsd: null,
      meanDurationMs: null,
      raised: 0,
      new: 0,
      regressions: 0,
      carried: 0,
      undeclaredRules: 0,
      accepted: 0,
      dismissedByAgents: 0,
      dismissedByPeople: 0,
      reinstated: 0,
      uncalibrated: 1,
      calibrating: 0,
      calibrated: 0,
      lastAt: t.Z,
    });
  });

  it("test_AC08_window_1d", async () => {
    const s = await k.stats(KEY, "?days=1");
    expect(s).toMatchObject({ key: KEY, days: 1, since: T - DAY });
    expect(s.hashes.map((h: Json) => h.hash)).toStrictEqual([HA, HB]);
    expect(s.hashes[0]).toStrictEqual({
      hash: HA,
      runs: 0,
      failures: 0,
      meanCostUsd: null,
      meanDurationMs: null,
      raised: 0,
      new: 0,
      regressions: 0,
      carried: 0,
      undeclaredRules: 0,
      accepted: 0,
      dismissedByAgents: 0,
      dismissedByPeople: 0,
      reinstated: 0,
      uncalibrated: 2,
      calibrating: 0,
      calibrated: 0,
      lastAt: t.C,
    });
    expect(s.hashes[1]).toMatchObject({ hash: HB, uncalibrated: 1, lastAt: t.Z });
  });
});

describe("RL-6 AC-08 stats edges", { timeout: 60_000 }, () => {
  afterEach(stopFresh);

  it("test_AC08_window_edge", async () => {
    const k = await fresh();
    const G = await k.goal(k.c.ann, [P.run("r")]);
    k.at(T - 10 * DAY);
    const fin = await k.run(k.c.ann, `${G}.r`, tel({ runId: "e1", agentKey: KEY, agentHash: HA, durationMs: 1_000 }));
    expect(fin).toBe(T - 10 * DAY);
    k.at(T);
    expect((await k.hashStats(KEY, HA, "?days=10")).runs).toBe(1);
    k.at(T + 1);
    expect((await k.stats(KEY, "?days=10")).hashes).toStrictEqual([]);
  });

  it("test_AC08_tie_order", async () => {
    const k = await fresh();
    const G1 = await k.goal(k.c.ann, [P.audit()]);
    const G2 = await k.goal(k.c.ann, [P.audit({ agent: "other" })]);
    k.at(T - DAY);
    await k.raise(k.c.ann, `${G1}.audit`, [item("A")], { key: KEY, hash: HB });
    await k.raise(k.c.ann, `${G2}.audit`, [item("B")], { key: KEY, hash: HA });
    k.at(T);
    const s = await k.stats(KEY);
    expect(s.hashes.map((h: Json) => h.lastAt)).toStrictEqual([T - DAY, T - DAY]);
    expect(s.hashes.map((h: Json) => h.hash)).toStrictEqual([HA, HB].sort());
  });

  it("test_AC08_hashless_runs", async () => {
    const k = await fresh();
    const G = await k.goal(k.c.ann, [P.run("r")]);
    k.at(T - DAY);
    await k.run(k.c.ann, `${G}.r`, tel({ runId: "n1", agentKey: KEY, durationMs: 2_000 }));
    k.at(T);
    const s = await k.stats(KEY);
    expect(s.hashes).toHaveLength(1);
    expect(s.hashes[0]).toMatchObject({ hash: "", runs: 1, failures: 0, meanDurationMs: 2_000, meanCostUsd: null, lastAt: T - DAY });
  });
});

// =============================================================================================
// AC-09 Reinstated and once per goal
// =============================================================================================

describe("RL-6 AC-09 reinstated and once per goal", { timeout: 60_000 }, () => {
  let k: Ck;
  const A = fpOf("A");
  const B = fpOf("B");
  let G2 = "";
  let rAt = 0;
  beforeAll(async () => {
    k = await Ck.start();
  });
  afterAll(async () => {
    await k?.stop();
  });
  const dbr = (deps: string[]) => P.debrief({ deps, consumes: ["dismissed"], may_set: ["accepted", "dismissed"] });

  it("test_AC09_once_per_goal", async () => {
    const ann = k.c.ann;
    const G1 = await k.goal(ann, [P.audit(), P.validate(), dbr(["validate"])]);
    k.tick();
    await k.raise(ann, `${G1}.audit`, [item("A"), item("B")]);
    k.tick();
    await k.agentDispose(ann, `${G1}.validate`, [disp(A, "dismissed"), disp(B, "dismissed")]);
    k.tick();
    await k.k.claim(ann, `${G1}.debrief`);
    await k.personDispose(ann, `${G1}.debrief`, B, "dismissed");
    const ha = await k.hashStats(KEY, HA);
    expect(ha).toMatchObject({ dismissedByAgents: 2, dismissedByPeople: 0, uncalibrated: 2 });
    // The checker has no counts at all yet (its reinstated is 0).
    expect((await k.stats(CHECK)).hashes).toStrictEqual([]);
  });

  it("test_AC09_reinstated", async () => {
    const ann = k.c.ann;
    G2 = await k.goal(ann, [P.audit(), dbr(["audit"])]);
    k.tick();
    await k.raise(ann, `${G2}.audit`, [item("A"), item("B")]);
    expect((await k.item(A, L)).state).toBe("dismissed");
    expect((await k.item(B, L)).state).toBe("dismissed");
    rAt = k.tick();
    await k.k.claim(ann, `${G2}.debrief`);
    await k.personDispose(ann, `${G2}.debrief`, A, "accepted");
    const v = await k.hashStats(CHECK, V);
    expect(v).toMatchObject({ reinstated: 1, lastAt: rAt });
    const ha = await k.hashStats(KEY, HA);
    expect(ha).toMatchObject({ dismissedByAgents: 2, dismissedByPeople: 0, reinstated: 0, accepted: 1 });
  });

  it("test_AC09_reinstated_reverted", async () => {
    k.tick();
    await k.revert(k.c.ann, `${G2}.debrief`, A);
    expect((await k.stats(CHECK)).hashes).toStrictEqual([]);
    expect(await k.hashStats(KEY, HA)).toMatchObject({ accepted: 0, dismissedByAgents: 2 });
  });
});

describe("RL-6 AC-09 own accepted replaced in the same round", { timeout: 60_000 }, () => {
  afterEach(stopFresh);
  const A = fpOf("A");
  const B = fpOf("B");

  // Spec Open questions, "Change of mind inside one round" (S3): only a person's *dismissal* replaced by
  // the same person in the same round stops counting. An `accepted` entry so replaced is not reverted,
  // so it still counts toward `accepted`, and it is the next non-reverted entry after the validator's
  // dismissal, so it still reinstates.
  it("test_AC09_own_accepted_replaced_same_round", async () => {
    const k = await fresh();
    const ann = k.c.ann;
    const G = await k.goal(ann, [P.audit(), P.validate(), P.debrief({ deps: ["validate"], consumes: ["dismissed"], may_set: ["accepted", "deferred"] })]);
    k.tick();
    await k.raise(ann, `${G}.audit`, [item("A"), item("B")]);
    k.tick();
    await k.agentDispose(ann, `${G}.validate`, [disp(A, "dismissed"), disp(B, "dismissed")]);
    await k.k.claim(ann, `${G}.debrief`);
    k.tick();
    await k.personDispose(ann, `${G}.debrief`, A, "accepted");
    k.tick();
    await k.personDispose(ann, `${G}.debrief`, A, "deferred", { until: "2027-01-31" });
    k.tick();
    // Control: B accepted and not replaced.
    await k.personDispose(ann, `${G}.debrief`, B, "accepted");
    expect((await k.item(A, L)).state).toBe("deferred");
    expect((await k.item(B, L)).state).toBe("accepted");
    expect(await k.hashStats(CHECK, V)).toMatchObject({ reinstated: 2 });
    expect(await k.hashStats(KEY, HA)).toMatchObject({ accepted: 2, dismissedByAgents: 2, dismissedByPeople: 0, uncalibrated: 2, reinstated: 0 });
  });
});

// =============================================================================================
// AC-10 Trigger
// =============================================================================================

const OPENED_TEXT = (n: number) => `opened calibration of ${KEY}@${h12(HA)} (${n} dismissals)`;

describe("RL-6 AC-10 trigger", { timeout: 90_000 }, () => {
  afterEach(stopFresh);

  it("test_AC10_opens_at_threshold_and_no_second_goal", async () => {
    const k = await fresh({ threshold: 3 });
    const { ann, bob } = k.c;
    const d1 = await k.dismissOne(ann, "X1");
    const d2 = await k.dismissOne(ann, "X2");
    expect(await k.calibGoals()).toStrictEqual([]);
    expect(await k.ev("calibration.opened")).toStrictEqual([]);
    expect(await k.hashStats(KEY, HA)).toMatchObject({ uncalibrated: 2, calibrating: 0 });
    const d3 = await k.dismissOne(bob, "X3");
    const cs = await k.calibOf(KEY, HA);
    expect(cs).toHaveLength(1);
    const Cid = cs[0].id as string;
    const view = await k.goalView(Cid, bob);
    const g = view.goal;
    const refs = [d1, d2, d3].map((d) => ({ lineage: L, fp: d.fp, goal: d.G, step: `${d.G}.validate`, round: 1, at: d.at }));
    expect(g).toMatchObject({ ownerId: "bob", title: `Calibrate ${KEY}@${h12(HA)}`, primaryRepo: ALPHA, state: "in_progress" });
    expect(g.preset?.name).toBe("calibrate");
    expect(g.refs?.pulse).toBeUndefined();
    expect(g.topics ?? []).toStrictEqual([]);
    expect(g.profiles ?? {}).toStrictEqual({});
    expect(g.calibration).toStrictEqual({ key: KEY, hash: HA, threshold: 3, dismissals: refs });
    expect((view.steps as Json[]).map((s) => s.id)).toStrictEqual([`${Cid}.calibrate`]);
    expect(await k.k.state(`${Cid}.calibrate`)).toBe("ready");
    const plans = view.plans as Json[];
    expect(plans).toHaveLength(1);
    expect(plans[0]).toMatchObject({ version: 1, decision: "approved", comment: `calibration of ${KEY}@${h12(HA)} (3 dismissals, threshold 3)` });
    expect((await k.goals(bob)).map((x) => x.id)).toContain(Cid);
    const inbox = await k.r.inboxOf(bob);
    expect(inbox.filter((m) => m.kind === "plan_approved" && JSON.stringify(m).includes(Cid))).toStrictEqual([]);
    const opened = await k.ev("calibration.opened");
    expect(opened).toHaveLength(1);
    expect(opened[0]).toMatchObject({ user: "bob", goal: Cid });
    expect(opened[0].payload).toStrictEqual({ key: KEY, hash: HA, dismissals: 3, threshold: 3, calibrator: "bob" });
    expect(await k.timeline(Cid)).toContain(OPENED_TEXT(3));
    expect(await k.hashStats(KEY, HA)).toMatchObject({ calibrating: 3, uncalibrated: 0, calibrated: 0, calibration: Cid });
    // test_AC10_no_second_goal: a 4th and 5th dismissal open nothing more.
    await k.dismissOne(ann, "X4");
    await k.dismissOne(ann, "X5");
    expect(await k.calibOf(KEY, HA)).toHaveLength(1);
    expect(await k.ev("calibration.opened")).toHaveLength(1);
    expect(await k.hashStats(KEY, HA)).toMatchObject({ calibrating: 3, uncalibrated: 2, calibration: Cid });
  });

  it("test_AC10_dispose_counts", async () => {
    const k = await fresh({ threshold: 3 });
    const { ann } = k.c;
    await k.dismissOne(ann, "X1");
    await k.dismissOne(ann, "X2");
    const G = await k.goal(ann, [P.audit(), P.debrief({ deps: ["audit"], consumes: ["open"], may_set: ["dismissed"] })]);
    k.tick();
    await k.raise(ann, `${G}.audit`, [item("X3")]);
    await k.k.claim(ann, `${G}.debrief`);
    expect(await k.calibGoals()).toStrictEqual([]);
    const at = k.tick();
    await k.personDispose(ann, `${G}.debrief`, fpOf("X3"), "dismissed");
    const cs = await k.calibOf(KEY, HA);
    expect(cs).toHaveLength(1);
    const last = cs[0].calibration.dismissals.at(-1);
    expect(last).toStrictEqual({ lineage: L, fp: fpOf("X3"), goal: G, step: `${G}.debrief`, round: 1, at });
    expect(cs[0].ownerId).toBe("ann");
  });

  it("test_AC10_revert_not_counted", async () => {
    const k = await fresh({ threshold: 3 });
    const { ann } = k.c;
    const G = await k.goal(ann, [P.audit(), P.debrief({ deps: ["audit"], consumes: ["open"], may_set: ["dismissed"] })]);
    k.tick();
    await k.raise(ann, `${G}.audit`, [item("X1")]);
    await k.k.claim(ann, `${G}.debrief`);
    k.tick();
    await k.personDispose(ann, `${G}.debrief`, fpOf("X1"), "dismissed");
    k.tick();
    await k.revert(ann, `${G}.debrief`, fpOf("X1"));
    expect((await k.ev("item.reverted", G)).filter((e) => e.payload.fp === fpOf("X1"))).toHaveLength(1);
    expect(await k.calEvents()).toStrictEqual([]);
    const d2 = await k.dismissOne(ann, "X2");
    const d3 = await k.dismissOne(ann, "X3");
    expect(await k.calibGoals()).toStrictEqual([]);
    expect(await k.hashStats(KEY, HA)).toMatchObject({ uncalibrated: 2 });
    const d4 = await k.dismissOne(ann, "X4");
    const cs = await k.calibOf(KEY, HA);
    expect(cs).toHaveLength(1);
    expect(cs[0].calibration.dismissals.map((r: Json) => r.fp)).toStrictEqual([d2.fp, d3.fp, d4.fp]);
  });

  it("test_AC10_person_raised", async () => {
    const k = await fresh({ threshold: 3 });
    const { ann } = k.c;
    for (const rule of ["P1", "P2", "P3"]) {
      const G = await k.goal(ann, [{ id: "audit", repo: ALPHA, kind: "review", output: "review-record" }, P.validate()]);
      k.tick();
      await k.raise(ann, `${G}.audit`, [item(rule)], null);
      k.tick();
      await k.agentDispose(ann, `${G}.validate`, [disp(fpOf(rule), "dismissed")]);
    }
    expect(await k.calibGoals()).toStrictEqual([]);
    expect(await k.calEvents()).toStrictEqual([]);
    // Control: three agent-raised dismissals in the same hub open a goal.
    for (const rule of ["X1", "X2", "X3"]) await k.dismissOne(ann, rule);
    expect(await k.calibOf(KEY, HA)).toHaveLength(1);
    expect((await k.calibOf(KEY, HA))[0].calibration.dismissals.map((r: Json) => r.fp)).toStrictEqual(["X1", "X2", "X3"].map((r) => fpOf(r)));
  });

  it("test_AC10_hashless", async () => {
    const k = await fresh({ threshold: 3 });
    const { ann } = k.c;
    for (const rule of ["N1", "N2", "N3"]) {
      const G = await k.goal(ann, [P.audit(), P.validate()]);
      k.tick();
      await k.raise(ann, `${G}.audit`, [item(rule)], { key: "alpha/nohash" });
      k.tick();
      await k.agentDispose(ann, `${G}.validate`, [disp(fpOf(rule), "dismissed")]);
    }
    expect(await k.calibGoals()).toStrictEqual([]);
    expect(await k.ev("calibration.opened")).toStrictEqual([]);
    const s = await k.stats("alpha/nohash");
    expect(s.hashes).toHaveLength(1);
    expect(s.hashes[0]).toMatchObject({ hash: "", uncalibrated: 3, dismissedByAgents: 3 });
  });

  it("test_AC10_other_goal_counts_again", async () => {
    const k = await fresh();
    const { ann } = k.c;
    const X = fpOf("X");
    const G1 = await k.goal(ann, [P.audit(), P.validate()]);
    k.tick();
    await k.raise(ann, `${G1}.audit`, [item("X", { eh: "1".repeat(64) })]);
    k.tick();
    await k.agentDispose(ann, `${G1}.validate`, [disp(X, "dismissed")]);
    const G2 = await k.goal(ann, [P.audit(), P.validate()]);
    k.tick();
    await k.raise(ann, `${G2}.audit`, [item("X", { eh: "2".repeat(64) })]);
    expect((await k.item(X, L)).state, "X reopened by a regression").toBe("open");
    k.tick();
    await k.agentDispose(ann, `${G2}.validate`, [disp(X, "dismissed")]);
    expect(await k.hashStats(KEY, HA)).toMatchObject({ uncalibrated: 2, dismissedByAgents: 2 });
  });

  it("test_AC10_change_of_mind_own", async () => {
    const k = await fresh();
    const { ann } = k.c;
    const G = await k.goal(ann, [P.audit(), P.debrief({ deps: ["audit"], consumes: ["open"], may_set: ["accepted", "dismissed"] })]);
    k.tick();
    await k.raise(ann, `${G}.audit`, [item("X"), item("Y")]);
    await k.k.claim(ann, `${G}.debrief`);
    k.tick();
    await k.personDispose(ann, `${G}.debrief`, fpOf("X"), "dismissed");
    k.tick();
    await k.personDispose(ann, `${G}.debrief`, fpOf("X"), "accepted");
    k.tick();
    // Control: Y dismissed and not replaced counts.
    await k.personDispose(ann, `${G}.debrief`, fpOf("Y"), "dismissed");
    expect(await k.hashStats(KEY, HA)).toMatchObject({ uncalibrated: 1, dismissedByPeople: 1, accepted: 1 });
  });
});

// =============================================================================================
// AC-11 Calibrator order
// =============================================================================================

describe("RL-6 AC-11 calibrator order", { timeout: 90_000 }, () => {
  afterEach(stopFresh);
  const REV = "agents/rev";

  /** One agent-raised dismissal of `key@hash` in `owner`'s goal (threshold 1 opens a goal at once). */
  async function dismissBy(k: Ck, owner: Person | string, key: string, hash: string, rule = "X1"): Promise<{ G: string; fp: string }> {
    const G = await k.goal(owner, [P.audit(), P.validate()]);
    k.tick();
    await k.raise(owner, `${G}.audit`, [item(rule)], { key, hash });
    k.tick();
    await k.agentDispose(owner, `${G}.validate`, [disp(fpOf(rule), "dismissed")]);
    return { G, fp: fpOf(rule) };
  }
  async function catalog(k: Ck, calibrator: string): Promise<void> {
    const cat = k.catalog();
    await cat.sourceOk(SRC_URL, "agents", "root", { calibrator });
    const m = await cat.pusher();
    await cat.pushOk(m, C1, { rev: REV1 });
  }
  /** A pulse of `owner` whose goal's headless `run` reports telemetry for `key@hash`, finished at `at`. */
  async function pulseRun(k: Ck, owner: "ann" | "bob", key: string, hash: string, at: number): Promise<string> {
    const pk = k.pulses();
    const p = await pk.pulseOk(owner, body({}, "solo-hl", SOLO_HL));
    const slot = await pk.fireOk(owner, p.id as string);
    const PG = slot.goal as string;
    expect((await k.goalView(PG)).goal.refs?.pulse).toBe(p.id);
    k.at(at);
    await k.run(k.c[owner], `${PG}.run`, tel({ runId: `run-${owner}-${at}`, agentKey: key, agentHash: hash, durationMs: 1_000 }));
    return PG;
  }

  it("test_AC11_catalog_calibrator", async () => {
    const k = await fresh({ threshold: 1 });
    await catalog(k, "carol");
    await dismissBy(k, k.c.ann, REV, H1);
    const cs = await k.calibOf(REV, H1);
    expect(cs).toHaveLength(1);
    expect(cs[0]).toMatchObject({ ownerId: "carol", primaryRepo: SRC });
    const opened = await k.ev("calibration.opened", cs[0].id);
    expect(opened).toHaveLength(1);
    expect(opened[0].payload.calibrator).toBe("carol");
    expect(opened[0].user).toBe("carol");
  });

  it("test_AC11_catalog_hash_must_match", async () => {
    const k = await fresh({ threshold: 1 });
    await catalog(k, "carol");
    await dismissBy(k, k.c.ann, REV, H2);
    const cs = await k.calibOf(REV, H2);
    expect(cs).toHaveLength(1);
    expect(cs[0]).toMatchObject({ ownerId: "ann", primaryRepo: ALPHA });
  });

  it("test_AC11_calibrator_not_a_user", async () => {
    const k = await fresh({ threshold: 1 });
    await catalog(k, "ghost");
    await pulseRun(k, "bob", REV, H1, T - DAY);
    k.at(T);
    await dismissBy(k, k.c.ann, REV, H1);
    const cs = await k.calibOf(REV, H1);
    expect(cs).toHaveLength(1);
    expect(cs[0]).toMatchObject({ ownerId: "bob", primaryRepo: SRC });
  });

  it("test_AC11_newest_pulse", async () => {
    const k = await fresh({ threshold: 1 });
    await pulseRun(k, "ann", KEY, HA, T - 2 * DAY);
    await pulseRun(k, "bob", KEY, HB, T - DAY);
    k.at(T);
    await dismissBy(k, k.c.carol, KEY, HA);
    expect((await k.calibOf(KEY, HA))[0]?.ownerId).toBe("bob");
  });

  it("test_AC11_newest_pulse_swapped", async () => {
    const k = await fresh({ threshold: 1 });
    await pulseRun(k, "bob", KEY, HA, T - 2 * DAY);
    await pulseRun(k, "ann", KEY, HB, T - DAY);
    k.at(T);
    await dismissBy(k, k.c.carol, KEY, HA);
    expect((await k.calibOf(KEY, HA))[0]?.ownerId).toBe("ann");
  });

  it("test_AC11_no_pulse_falls_to_goal_owner", async () => {
    const k = await fresh({ threshold: 1 });
    const G = await k.goal(k.c.carol, [P.run("r")]);
    k.at(T - DAY);
    await k.run(k.c.carol, `${G}.r`, tel({ runId: "c1", agentKey: KEY, agentHash: HA, durationMs: 1_000 }));
    k.at(T);
    await dismissBy(k, k.c.bob, KEY, HA);
    expect((await k.calibOf(KEY, HA))[0]?.ownerId).toBe("bob");
  });
});

// =============================================================================================
// AC-12 The calibration input
// =============================================================================================

describe("RL-6 AC-12 calibration input", { timeout: 90_000 }, () => {
  afterEach(stopFresh);

  it("test_AC12_context_repo_agent", async () => {
    const k = await fresh({ threshold: 3 });
    const { ann, bob } = k.c;
    const ev1 = [{ path: "src/x1.ts", lines: [3, 5], note: "N1" }];
    const o1 = { path: "src/x1.ts", symbol: "f1", title: "Leak one", severity: "S2", category: "sec", evidence: ev1 };
    const o2 = { path: "src/x2.ts", title: "Two", severity: "S3", category: "style", evidence: [] };
    const o3 = { path: "src/x3.ts", title: "Three", severity: "S1", category: "bug", evidence: [{ path: "src/x3.ts" }] };
    const d1 = await k.dismissOne(ann, "X1", { itemOpts: o1, reason: "r1" });
    const d2 = await k.dismissOne(ann, "X2", { itemOpts: o2, reason: "r2" });
    const d3 = await k.dismissOne(bob, "X3", { itemOpts: o3, reason: "r3" });
    const Cid = (await k.calibOf(KEY, HA))[0]?.id as string;
    expect(Cid).toBeTruthy();
    const ctx = await k.k.ctx(bob, `${Cid}.calibrate`);
    const ins = calibrationInputs(ctx);
    expect(ins).toHaveLength(1);
    const e = ins[0];
    expect(e).toMatchObject({ from: Cid, artifact: "calibration", kind: "review", title: `dismissals of ${KEY}@${h12(HA)} (3)`, truncated: false });
    const content = JSON.parse(e.content as string);
    const decider = { kind: "agent", key: CHECK, hash: V };
    const row = (d: { G: string; fp: string; at: number }, rule: string, o: Json, reason: string) => ({
      lineage: L,
      fp: d.fp,
      goal: d.G,
      step: `${d.G}.validate`,
      round: 1,
      at: d.at,
      reason,
      decider,
      via: "stage",
      title: o.title,
      severity: o.severity,
      category: o.category,
      rule,
      path: o.path,
      ...(o.symbol ? { symbol: o.symbol } : {}),
      evidence: o.evidence,
    });
    expect(content).toStrictEqual({ agent: { key: KEY, hash: HA }, dismissals: [row(d1, "X1", o1, "r1"), row(d2, "X2", o2, "r2"), row(d3, "X3", o3, "r3")] });
    expect("text" in content.agent).toBe(false);
  });

  it("test_AC12_context_catalog_text", async () => {
    const k = await fresh({ threshold: 1 });
    const cat = k.catalog();
    await cat.sourceOk(SRC_URL, "agents", "root", { calibrator: "carol" });
    const m = await cat.pusher();
    await cat.pushOk(m, C1, { rev: REV1 });
    const G = await k.goal(k.c.ann, [P.audit(), P.validate()]);
    k.tick();
    await k.raise(k.c.ann, `${G}.audit`, [item("X1")], { key: "agents/rev", hash: H1 });
    k.tick();
    await k.agentDispose(k.c.ann, `${G}.validate`, [disp(fpOf("X1"), "dismissed")]);
    // A newer definition after the dismissal: the text stays the one of the agent's hash.
    await cat.pushOk(m, C2, { rev: REV2 });
    const Cid = (await k.calibOf("agents/rev", H1))[0]?.id as string;
    expect(Cid).toBeTruthy();
    const ins = calibrationInputs(await k.k.ctx(k.c.carol, `${Cid}.calibrate`));
    expect(ins).toHaveLength(1);
    const content = JSON.parse(ins[0].content as string);
    expect(content.agent.key).toBe("agents/rev");
    expect(content.agent.hash).toBe(H1);
    expect([REV1, REV1.replace(/\r\n/g, "\n")]).toContain(content.agent.text);
  });

  it("test_AC12_no_calibration_goal", async () => {
    const k = await fresh({ threshold: 1 });
    const G = await k.goal(k.c.ann, [{ id: "s", repo: ALPHA, kind: "review", output: "review-record", inputs: ["calibration"] }]);
    expect(calibrationInputs(await k.k.ctx(k.c.ann, `${G}.s`))).toStrictEqual([]);
    // Control: a calibration goal's step gets the entry.
    await k.dismissOne(k.c.ann, "X1");
    const Cid = (await k.calibOf(KEY, HA))[0]?.id as string;
    expect(calibrationInputs(await k.k.ctx(k.c.ann, `${Cid}.calibrate`))).toHaveLength(1);
  });

  it("test_AC12_size_cap", async () => {
    const k = await fresh({ threshold: 60 });
    const { ann } = k.c;
    const rules = Array.from({ length: 60 }, (_, i) => `R${i}`);
    const G = await k.goal(ann, [P.audit(), P.validate()]);
    k.tick();
    await k.raise(ann, `${G}.audit`, rules.map((r) => item(r, { title: `${r} ${"t".repeat(150)}`, evidence: [{ path: "src/a.ts", lines: [1, 2], note: "n".repeat(1000) }] })));
    k.tick();
    await k.agentDispose(ann, `${G}.validate`, rules.map((r) => disp(fpOf(r), "dismissed")));
    const Cid = (await k.calibOf(KEY, HA))[0]?.id as string;
    expect(Cid).toBeTruthy();
    const ins = calibrationInputs(await k.k.ctx(ann, `${Cid}.calibrate`));
    expect(ins).toHaveLength(1);
    expect(ins[0].truncated).toBe(true);
    expect((ins[0].content as string).length).toBeLessThanOrEqual(50_000);
  });
});

// =============================================================================================
// AC-13 Calibration done
// =============================================================================================

describe("RL-6 AC-13 calibration done", { timeout: 90_000 }, () => {
  afterEach(stopFresh);
  const DONE_TEXT = (o: string) => `calibration of ${KEY}@${h12(HA)} done: ${o}`;

  /** Threshold 3: X1, X2 in ann's goals, X3 in bob's → calibration goal C (calibrator bob). */
  async function openC(): Promise<{ k: Ck; C: string; fps: string[] }> {
    const k = await fresh({ threshold: 3 });
    const fps: string[] = [];
    for (const [who, rule] of [
      [k.c.ann, "X1"],
      [k.c.ann, "X2"],
      [k.c.bob, "X3"],
    ] as const)
      fps.push((await k.dismissOne(who, rule)).fp);
    const cs = await k.calibOf(KEY, HA);
    expect(cs).toHaveLength(1);
    expect(cs[0].ownerId).toBe("bob");
    return { k, C: cs[0].id as string, fps };
  }
  async function complete(k: Ck, C: string, body: unknown): Promise<void> {
    await k.k.claim(k.c.bob, `${C}.calibrate`);
    await k.k.reviewOk(k.c.bob, `${C}.calibrate`, body);
    await k.k.closeOk(k.c.bob, `${C}.calibrate`);
  }

  it("test_AC13_done_no_change", async () => {
    const { k, C, fps } = await openC();
    const before = await Promise.all(fps.map((f) => k.item(f, L)));
    await complete(k, C, rec({ assessment: "clean", summary: "no change: fine" }));
    expect(await k.k.goalState(k.c.bob, C)).toBe("done");
    const done = await k.ev("calibration.done");
    expect(done).toHaveLength(1);
    expect(done[0].goal).toBe(C);
    expect(done[0].payload).toStrictEqual({ key: KEY, hash: HA, dismissals: 3, outcome: "no-change" });
    expect(await k.timeline(C)).toContain(DONE_TEXT("no-change"));
    const ha = await k.hashStats(KEY, HA);
    expect(ha).toMatchObject({ calibrated: 3, calibrating: 0, uncalibrated: 0 });
    expect("calibration" in ha).toBe(false);
    expect(await Promise.all(fps.map((f) => k.item(f, L)))).toStrictEqual(before);
  });

  it("test_AC13_issues_change", async () => {
    const { k, C } = await openC();
    await complete(k, C, rec({ assessment: "issues", summary: "changed definition" }));
    const done = await k.ev("calibration.done", C);
    expect(done).toHaveLength(1);
    expect(done[0].payload).toStrictEqual({ key: KEY, hash: HA, dismissals: 3, outcome: "change" });
    expect(await k.timeline(C)).toContain(DONE_TEXT("change"));
  });

  it("test_AC13_next_goal_on_next_dismissal", async () => {
    const { k, C } = await openC();
    await complete(k, C, rec({ assessment: "clean", summary: "no change: fine" }));
    const a = await k.dismissOne(k.c.ann, "Y1");
    const b = await k.dismissOne(k.c.ann, "Y2");
    expect(await k.calibOf(KEY, HA)).toHaveLength(1);
    expect(await k.hashStats(KEY, HA)).toMatchObject({ uncalibrated: 2, calibrated: 3 });
    const c = await k.dismissOne(k.c.ann, "Y3");
    const open = (await k.calibOf(KEY, HA)).filter((g) => g.id !== C);
    expect(open).toHaveLength(1);
    expect(open[0].calibration.dismissals.map((r: Json) => r.fp)).toStrictEqual([a.fp, b.fp, c.fp]);
    expect(open[0].ownerId).toBe("ann");
  });

  it("test_AC13_done_opens_next_at_once", async () => {
    const { k, C } = await openC();
    const ys: string[] = [];
    for (const r of ["Y1", "Y2", "Y3"]) ys.push((await k.dismissOne(k.c.ann, r)).fp);
    expect(await k.calibOf(KEY, HA)).toHaveLength(1);
    expect(await k.hashStats(KEY, HA)).toMatchObject({ uncalibrated: 3, calibrating: 3 });
    await complete(k, C, rec({ assessment: "clean", summary: "no change: fine" }));
    const cal = await k.calEvents();
    const types = cal.map((e) => `${e.type}:${e.goal === C ? "C" : "C2"}`);
    expect(types).toStrictEqual(["calibration.opened:C", "calibration.done:C", "calibration.opened:C2"]);
    expect(cal[2].payload).toMatchObject({ dismissals: 3 });
    const next = (await k.calibOf(KEY, HA)).filter((g) => g.id !== C);
    expect(next).toHaveLength(1);
    expect(next[0].calibration.dismissals.map((r: Json) => r.fp)).toStrictEqual(ys);
  });

  it("test_AC13_replan_path", async () => {
    const { k, C } = await openC();
    const bob = k.c.bob;
    // Plan v2 proposed and approved through POST /v1/goals/:id/plan (no /replan call).
    const v2 = await k.r.plan(bob, C, [{ id: "recheck", kind: "review", repo: ALPHA }]);
    expect(v2.status, JSON.stringify(v2.json)).toBe(201);
    expect(await k.k.state(`${C}.calibrate`)).toBe("dropped");
    expect(await k.k.state(`${C}.recheck`)).toBe("ready");
    expect(await k.k.goalState(bob, C)).toBe("in_progress");
    expect(await k.ev("calibration.done")).toStrictEqual([]);
    await k.k.claim(bob, `${C}.recheck`);
    await k.k.closeOk(bob, `${C}.recheck`);
    expect(await k.k.goalState(bob, C)).toBe("done");
    expect(await k.ev("goal.done", C)).toHaveLength(1);
    const done = await k.ev("calibration.done", C);
    expect(done).toHaveLength(1);
    expect(done[0].payload).toStrictEqual({ key: KEY, hash: HA, dismissals: 3, outcome: "none" });
    expect(await k.hashStats(KEY, HA)).toMatchObject({ calibrated: 3, calibrating: 0 });
  });

  it("test_AC13_listed_revert", async () => {
    const k = await fresh({ threshold: 3 });
    const { ann, bob } = k.c;
    await k.dismissOne(ann, "X1");
    await k.dismissOne(ann, "X2");
    const G = await k.goal(bob, [P.audit(), P.debrief({ deps: ["audit"], consumes: ["open"], may_set: ["dismissed"] })]);
    k.tick();
    await k.raise(bob, `${G}.audit`, [item("X3")]);
    await k.k.claim(bob, `${G}.debrief`);
    k.tick();
    const X3 = fpOf("X3");
    await k.personDispose(bob, `${G}.debrief`, X3, "dismissed");
    const cs = await k.calibOf(KEY, HA);
    expect(cs).toHaveLength(1);
    const C = cs[0].id as string;
    const listed = cs[0].calibration.dismissals;
    expect(listed.map((r: Json) => r.fp)).toContain(X3);
    const calBefore = (await k.calEvents()).length;
    k.tick();
    await k.revert(bob, `${G}.debrief`, X3);
    expect((await k.ev("item.reverted", G)).filter((e) => e.payload.fp === X3)).toHaveLength(1);
    expect(await k.calEvents()).toHaveLength(calBefore);
    expect(await k.k.goalState(bob, C)).toBe("in_progress");
    expect((await k.calibOf(KEY, HA))[0].calibration.dismissals).toStrictEqual(listed);
    expect(await k.hashStats(KEY, HA)).toMatchObject({ calibrating: 2, uncalibrated: 0 });
    // Variant (S1): a later dismissal of X3 in the same goal is not listed, so it is uncalibrated.
    k.tick();
    await k.personDispose(bob, `${G}.debrief`, X3, "dismissed");
    expect(await k.hashStats(KEY, HA)).toMatchObject({ calibrating: 2, uncalibrated: 1 });
    await k.k.claim(bob, `${C}.calibrate`);
    await k.k.reviewOk(bob, `${C}.calibrate`, rec({ assessment: "clean", summary: "no change: ok" }));
    await k.k.closeOk(bob, `${C}.calibrate`);
    const done = await k.ev("calibration.done", C);
    expect(done).toHaveLength(1);
    expect(done[0].payload).toMatchObject({ dismissals: 3, outcome: "no-change" });
    expect(await k.hashStats(KEY, HA)).toMatchObject({ calibrated: 2, calibrating: 0, uncalibrated: 1 });
  });
});
