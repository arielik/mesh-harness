// RL-2 hub side end to end (World): plan validation, the review route, the fold across goals,
// carry-forward, the REQ-5 done rule, dispositions and person precedence, reads, conditional stages
// and their re-evaluation, inputs, privacy, compatibility, idempotency, transactions and retention.
// Criteria AC-02 (World), AC-09 to AC-14, AC-16 to AC-18, AC-22 (World), AC-24 to AC-27, AC-29.
// Written from the spec's contracts only (docs/specs/RL-2.md). Steps by id, items by fp, events by
// type + step; expected fingerprints from the test-side formula (test/helpers/review-kit.ts).

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { exportLedger } from "../src/cli/ledger.ts";
import type { Session } from "../src/protocol/index.ts";
import { git, type PlanIn } from "./helpers/relay-kit.ts";
import { ALPHA, DAY_MS, disp, E1, E2, E9, fpOf, item, L, rec, relayPlan, Rk, S, type RCast } from "./helpers/review-kit.ts";
import type { Json } from "./helpers/world.ts";

let k: Rk;
let c: RCast;
afterEach(async () => {
  await k?.r.stop();
});
async function start(o: { hubYaml?: Record<string, unknown>; clock?: number } = {}): Promise<void> {
  ({ k, c } = await Rk.start(o));
}

const A = fpOf("A");
const B = fpOf("B");
const C = fpOf("C");
const D = fpOf("D");
const NOFP = "aaaaaaaaaaaaaaaa";
const ev = (type: string, step?: string) => k.r.events(type, step);
const rounds = async (id: string): Promise<Json[]> => ((await k.r.stepOf(id)).rounds ?? []) as Json[];
const lastHistory = (x: Json) => (x.history as Json[]).at(-1);
const PROBLEMS = (n: number, ps: string[]) => `the review record has ${n} problem(s): ${ps.join("; ")}`;

// ---------------------------------------------------------------------------------------------

describe("AC-02 plan", () => {
  it("test_AC02_plan_422", async () => {
    await start();
    const g = await k.r.call(c.ann, "POST", "/v1/goals", { title: "bad", primaryRepo: "svc" });
    const p = await k.r.plan(c.ann, g.json.id, [S.audit(), S.step("s", { deps: ["audit"], may_set: ["dismissed"] })]);
    expect(p.status, JSON.stringify(p.json)).toBe(422);
    expect(p.json.details).toContain('step "s": may_set needs consumes');
    const q = await k.r.plan(c.ann, g.json.id, [S.step("s", { consumes: ["open"] })]);
    expect(q.status).toBe(422);
    expect(q.json.details).toContain('step "s": consumes needs an earlier step with output: review-record that raises items (through deps)');
  });

  it("test_AC02_plan_stored", async () => {
    await start();
    const G = await k.goal(c.ann, relayPlan());
    const v = await k.r.stepOf(`${G}.validate`);
    expect(v.policy).toMatchObject({ when: { open: true }, consumes: ["open"], may_set: ["confirmed", "dismissed"], output: "review-record", mode: "headless", agent: "validator" });
    const d = await k.r.stepOf(`${G}.debrief`);
    expect(d.policy.when).toStrictEqual({ open: true, min_severity: "S2" });
    expect(d.policy.consumes).toStrictEqual(["open", "confirmed"]);
    expect(d.policy.may_set).toStrictEqual(["accepted", "dismissed", "deferred"]);
    expect((await k.r.stepOf(`${G}.audit`)).policy.output).toBe("review-record");
    expect((await k.r.stepOf(`${G}.audit`)).policy).not.toHaveProperty("consumes");
  });
});

// ---------------------------------------------------------------------------------------------

describe("AC-09 review route", () => {
  /** G: audit (held by ann), audit2 (output, ready), plain (no output), v (consuming, after audit). */
  async function held(): Promise<string> {
    await start();
    const G = await k.goal(c.ann, [S.audit(), S.step("audit2", { output: "review-record" }), S.step("plain"), S.validate({ id: "v" })]);
    await k.claim(c.ann, `${G}.audit`);
    return G;
  }

  it("test_AC09_404", async () => {
    const G = await held();
    expect(await k.review(c.ann, `${G}.nope`, rec())).toStrictEqual({ status: 404, json: { error: `no step ${G}.nope` } });
  });

  it("test_AC09_no_output", async () => {
    const G = await held();
    await k.claim(c.ann, `${G}.plain`);
    expect(await k.review(c.ann, `${G}.plain`, rec())).toStrictEqual({ status: 409, json: { error: `${G}.plain has no output: review-record` } });
  });

  it("test_AC09_not_held", async () => {
    const G = await held();
    // Posted by bob, who is not the holder either: the state check answers first.
    expect(await k.review(c.bob, `${G}.audit2`, rec())).toStrictEqual({ status: 409, json: { error: `${G}.audit2 is ready; only a held step takes a review record` } });
  });

  it("test_AC09_other_user", async () => {
    const G = await held();
    expect(await k.review(c.bob, `${G}.audit`, rec())).toStrictEqual({ status: 403, json: { error: `${G}.audit is held by ann` } });
    expect((await k.reviews(c.ann, `${G}.audit`)).json.reviews).toStrictEqual([]);
    // Control: an admin may submit it.
    expect((await k.review(c.root, `${G}.audit`, rec())).status).toBe(201);
  });

  it("test_AC09_foreign_sid", async () => {
    const G = await held();
    const sb: Session = { sid: "s-bob-on-bm", claudeSessionIds: ["c-bob"], cwd: "", kind: "interactive", state: "idle", quiet: false, startedAt: k.r.w.clock, lastEventAt: k.r.w.clock, turns: 0, humanPrompts: 0, seenByReconciler: true };
    await k.r.w.hubStore.upsertSession(sb, "bob", k.r.w.machineOf(c.bob), k.r.w.clock);
    expect(await k.review(c.ann, `${G}.audit`, rec({ items: [item("A")], sid: sb.sid }))).toStrictEqual({ status: 403, json: { error: `session ${sb.sid} is not yours on this machine` } });
    expect((await k.reviews(c.ann, `${G}.audit`)).json.reviews).toStrictEqual([]);
    expect((await k.r.artifactsOf(G, c.ann)).filter((a) => a.kind === "review")).toStrictEqual([]);
    expect(await ev("review.recorded", `${G}.audit`)).toHaveLength(0);
    // Control: the same record without the foreign sid is stored.
    expect((await k.review(c.ann, `${G}.audit`, rec({ items: [item("A")] }))).status).toBe(201);
  });

  it("test_AC09_second_in_round", async () => {
    const G = await held();
    expect((await k.review(c.ann, `${G}.audit`, rec())).status).toBe(201);
    expect(await k.review(c.ann, `${G}.audit`, rec({ items: [item("A")] }))).toStrictEqual({ status: 409, json: { error: `${G}.audit round 1 already has a review record` } });
  });

  it("test_AC09_problems_record_level", async () => {
    const G = await held();
    const p1 = `dispositions need consumes; ${G}.audit raises items`;
    expect(await k.review(c.ann, `${G}.audit`, rec({ items: [item("A")], dispositions: [disp(A, "dismissed")] }))).toStrictEqual({ status: 422, json: { error: PROBLEMS(1, [p1]), details: [p1] } });
    expect((await k.reviews(c.ann, `${G}.audit`)).json.reviews).toStrictEqual([]);
    await k.reviewOk(c.ann, `${G}.audit`, rec({ items: [item("A")] }));
    await k.closeOk(c.ann, `${G}.audit`);
    await k.claim(c.ann, `${G}.v`);
    const p2 = `${G}.v consumes items; its record may not raise new ones`;
    expect(await k.review(c.ann, `${G}.v`, rec({ items: [item("B")] }))).toStrictEqual({ status: 422, json: { error: PROBLEMS(1, [p2]), details: [p2] } });
  });

  it("test_AC09_success_shape", async () => {
    const G = await held();
    const res = await k.reviewOk(c.ann, `${G}.audit`, rec({ items: [item("I-03", { eh: E1 }), item("I-04")], subject: { repo: "other", commit: "c1" } }));
    expect(res.items).toStrictEqual([
      { fp: fpOf("I-03"), mark: "new", state: "open", title: "T-I-03" },
      { fp: fpOf("I-04"), mark: "new", state: "open", title: "T-I-04" },
    ]);
    const rv = res.review;
    expect(rv.record.items[0]).toMatchObject({ fp: fpOf("I-03"), eh: E1, mark: "new", key: { rule: "I-03", path: "src/a.ts" } });
    expect(rv.record.items[1]).not.toHaveProperty("eh");
    expect(rv.record.subject).toStrictEqual({ repo: "other", commit: "c1" });
    expect(rv).toMatchObject({ goal: G, step: `${G}.audit`, round: 1, lineage: L, raising: true, complete: true, by: "ann", undeclaredRules: 0 });
    expect(rv.fold).toStrictEqual({ new: 2, repeat: 0, regression: 0, resolved: 0, carried: 0 });
    expect(typeof rv.artifact).toBe("string");
    expect(res.resolved).toStrictEqual([]);
    expect(res.applied).toBe(0);
    expect(res.ignored).toStrictEqual([]);
    // raisedBy falls back to <repo name>/<local id> without an upload agent.
    expect((await k.itemOf(c.ann, fpOf("I-03"))).raisedBy).toStrictEqual({ key: "alpha/audit" });
  });

  it("test_AC09_lineage_fallbacks", async () => {
    await start();
    const G = await k.goal(c.ann, [S.step("scan", { output: "review-record" })]);
    await k.claim(c.ann, `${G}.scan`);
    expect((await k.reviewOk(c.ann, `${G}.scan`, rec())).review.lineage).toBe(`-|${ALPHA}|scan`);
    const H = await k.goal(c.ann, [S.audit()], { preset: { name: "relay", text: "steps: []\n" } });
    await k.claim(c.ann, `${H}.audit`);
    expect((await k.reviewOk(c.ann, `${H}.audit`, rec())).review.lineage).toBe(`relay|${ALPHA}|auditor`);
  });

  it("test_AC09_artifact", async () => {
    const G = await held();
    const res = await k.reviewOk(c.ann, `${G}.audit`, rec({ items: [item("A")], redactions: 2 }));
    const arts = (await k.r.artifactsOf(G, c.ann)).filter((a) => a.kind === "review");
    expect(arts).toHaveLength(1);
    expect(arts[0]).toMatchObject({ id: res.review.artifact, step: `${G}.audit`, round: 1, mediaType: "application/json", title: "review record", redactions: 2 });
    const got = await k.r.call(c.ann, "GET", `/v1/artifacts/${res.review.artifact}`);
    expect(got.status).toBe(200);
    expect(JSON.parse(got.json.content)).toStrictEqual(res.review.record);
    expect(await ev("step.artifact", `${G}.audit`)).toStrictEqual([]);
    // Not counted against per_round: ten more artifacts still fit.
    for (let i = 0; i < 10; i++) expect((await k.r.upload(c.ann, `${G}.audit`, { kind: "report", content: `n${i}` })).status, `upload ${i}`).toBe(201);
  });

  it("test_AC09_event", async () => {
    const G = await held();
    const res = await k.reviewOk(c.ann, `${G}.audit`, rec({ items: [item("A"), item("B"), item("A")] }));
    const es = await ev("review.recorded", `${G}.audit`);
    expect(es).toHaveLength(1);
    const e = es[0];
    expect(e).toMatchObject({ user: "ann", goal: G, step: `${G}.audit` });
    expect(Object.keys(e.payload).sort()).toStrictEqual(["already", "artifact", "assessment", "coverage", "dispositions", "fold", "ignored", "items", "lineage", "round", "undeclaredRules"]);
    expect(e.payload).toStrictEqual({ round: 1, lineage: L, coverage: "complete", assessment: "issues", items: 2, artifact: res.review.artifact, fold: { new: 2, repeat: 0, regression: 0, resolved: 0, carried: 0 }, dispositions: 0, ignored: 0, undeclaredRules: 0, already: 0 });
  });

  it("test_AC09_event_consuming_no_fold", async () => {
    const G = await held();
    await k.reviewOk(c.ann, `${G}.audit`, rec({ items: [item("A")] }));
    await k.closeOk(c.ann, `${G}.audit`);
    await k.claim(c.ann, `${G}.v`);
    await k.reviewOk(c.ann, `${G}.v`, rec({ dispositions: [disp(A, "confirmed")] }));
    const es = await ev("review.recorded", `${G}.v`);
    expect(es).toHaveLength(1);
    expect(es[0].payload).not.toHaveProperty("fold");
    expect(es[0].payload).toMatchObject({ round: 1, lineage: L, items: 0, dispositions: 1, ignored: 0 });
  });
});

// ---------------------------------------------------------------------------------------------

/** One goal of lineage L: audit (inputs previous) records `items`, validate (consuming) records `dispositions`. */
async function cycle(items: unknown[], o: { coverage?: "complete" | "partial"; dispositions?: unknown[]; validate?: Record<string, unknown> } = {}): Promise<{ G: string; a: Json; v: Json }> {
  const G = await k.goal(c.ann, [S.audit({ inputs: ["previous"] }), S.validate({ may_set: ["confirmed", "dismissed", "deferred", "accepted"], ...o.validate })]);
  const a = await k.submit(c.ann, `${G}.audit`, rec({ items, ...(o.coverage ? { coverage: o.coverage } : {}) }));
  const v = await k.submit(c.ann, `${G}.validate`, rec({ dispositions: o.dispositions ?? [] }));
  return { G, a, v };
}

describe("AC-10 fold", () => {
  it("test_AC10_first", async () => {
    await start();
    const { a } = await cycle([item("A"), item("B")]);
    expect(k.markOf(a, A)).toBe("new");
    expect(k.markOf(a, B)).toBe("new");
    expect((a.items as Json[]).map((x) => x.state)).toStrictEqual(["open", "open"]);
    expect(a.review.fold).toStrictEqual({ new: 2, repeat: 0, regression: 0, resolved: 0, carried: 0 });
  });

  it("test_AC10_base_skips_consuming", async () => {
    await start();
    await cycle([item("A"), item("B")]);
    const { G, a } = await cycle([item("B"), item("C")]);
    expect(k.markOf(a, B)).toBe("repeat");
    expect(k.markOf(a, C)).toBe("new");
    expect(a.resolved).toStrictEqual([A]);
    expect(a.review.fold).toStrictEqual({ new: 1, repeat: 1, regression: 0, resolved: 1, carried: 0 });
    const x = await k.itemOf(c.ann, A);
    expect(x.state).toBe("resolved");
    expect(lastHistory(x)).toMatchObject({ kind: "fold", mark: "resolved", from: "open", to: "resolved", goal: G, step: `${G}.audit`, round: 1 });
  });

  it("test_AC10_regression_and_history", async () => {
    await start();
    const g1 = await cycle([item("A"), item("B")]);
    const g2 = await cycle([item("B"), item("C")]);
    const g3 = await cycle([item("A")]);
    expect(k.markOf(g3.a, A)).toBe("regression");
    expect((g3.a.items as Json[]).find((x) => x.fp === A).state).toBe("open");
    expect([...g3.a.resolved].sort()).toStrictEqual([B, C].sort());
    expect((await k.itemOf(c.ann, A)).state).toBe("open");
    // test_AC10_history
    const h = ((await k.itemOf(c.ann, A)).history as Json[]).filter((e) => e.kind === "fold");
    expect(h.map((e) => [e.mark, e.goal])).toStrictEqual([
      ["new", g1.G],
      ["resolved", g2.G],
      ["regression", g3.G],
    ]);
    expect(h[0]).toMatchObject({ from: null, to: "open" });
    expect(h[2]).toMatchObject({ from: "resolved", to: "open" });
  });

  it("test_AC10_partial_not_base", async () => {
    await start();
    await cycle([item("A")]);
    const g4 = await cycle([], { coverage: "partial" });
    expect(g4.a.resolved).toStrictEqual([]);
    expect(g4.a.review.complete).toBe(false);
    const x = await k.itemOf(c.ann, A);
    expect(x.state).toBe("open");
    expect((x.history as Json[]).filter((e) => e.goal === g4.G)).toStrictEqual([]);
    const g5 = await cycle([item("A")]);
    expect(k.markOf(g5.a, A)).toBe("repeat");
    expect(g5.a.resolved).toStrictEqual([]);
    expect(g5.a.review.fold.resolved).toBe(0);
  });

  it("test_AC10_partial_not_base_b", async () => {
    await start();
    await cycle([item("A")]);
    const g4 = await cycle([item("B")], { coverage: "partial" });
    expect(k.markOf(g4.a, B)).toBe("new");
    const g5 = await cycle([item("A")]);
    // Base = goal 3's complete record ([A]): B was never in a base, so it is not resolved.
    expect(g5.a.resolved).toStrictEqual([]);
    expect((await k.itemOf(c.ann, B)).state).toBe("open");
  });

  it("test_AC10_partial_new", async () => {
    await start();
    const { a } = await cycle([item("D")], { coverage: "partial" });
    expect(k.markOf(a, D)).toBe("new");
    expect((await k.itemOf(c.ann, D)).state).toBe("open");
    expect(a.review.fold).toStrictEqual({ new: 1, repeat: 0, regression: 0, resolved: 0, carried: 0 });
  });

  it("test_AC10_reopened_round", async () => {
    await start();
    const G = await k.goal(c.ann, [S.audit(), S.validate(), S.step("check", { kind: "verify", deps: ["validate"] })]);
    await k.submit(c.ann, `${G}.audit`, rec({ items: [item("A")] }));
    await k.submit(c.ann, `${G}.validate`, rec());
    await k.reopenVia(c.ann, G, "check", "audit");
    expect(await k.state(`${G}.audit`)).toBe("ready");
    await k.claim(c.ann, `${G}.audit`);
    const r2 = await k.reviewOk(c.ann, `${G}.audit`, rec());
    expect(r2.review.round).toBe(2);
    expect(r2.resolved).toStrictEqual([A]);
    expect((await k.itemOf(c.ann, A)).state).toBe("resolved");
  });

  it("test_AC10_previous_input", async () => {
    await start();
    const g1 = await cycle([item("A"), item("B")]);
    const G2 = await k.goal(c.ann, [S.audit({ inputs: ["previous"] }), S.validate()]);
    await k.claim(c.ann, `${G2}.audit`);
    const ins = ((await k.ctx(c.ann, `${G2}.audit`)).inputs ?? []) as Json[];
    const reviews = ins.filter((i) => i.kind === "review");
    expect(reviews).toHaveLength(1);
    expect(reviews[0]).toMatchObject({ from: `${g1.G}.audit`, artifact: g1.a.review.artifact });
    const content = JSON.parse(reviews[0].content);
    expect((content.items as Json[]).map((x) => x.fp)).toStrictEqual([A, B]);
    expect(content).toStrictEqual(g1.a.review.record);
  });
});

// ---------------------------------------------------------------------------------------------

describe("AC-11 carry", () => {
  it("test_AC11_dismissed_carried", async () => {
    await start();
    const g1 = await cycle([item("A", { eh: E1 })], { dispositions: [disp(A, "dismissed", { reason: "R-1" })] });
    expect(g1.v.applied).toBe(1);
    const g2 = await cycle([item("A", { eh: E1 })]);
    expect(k.markOf(g2.a, A)).toBe("repeat");
    expect((g2.a.items as Json[])[0].state).toBe("dismissed");
    expect(g2.a.review.fold).toMatchObject({ repeat: 1, carried: 1, regression: 0 });
    const x = await k.itemOf(c.ann, A);
    expect(x.state).toBe("dismissed");
    expect(x.dismissedEh).toBe(E1);
    expect(lastHistory(x)).toMatchObject({ kind: "fold", mark: "repeat", carried: true, from: "dismissed", to: "dismissed", goal: g2.G });
  });

  it("test_AC11_dismissed_changed_eh", async () => {
    await start();
    const g1 = await cycle([item("A", { eh: E1 })], { dispositions: [disp(A, "dismissed", { reason: "R-1" })] });
    const g2 = await cycle([item("A", { eh: E2 })]);
    expect(k.markOf(g2.a, A)).toBe("regression");
    const x = await k.itemOf(c.ann, A);
    expect(x.state).toBe("open");
    expect((x.history as Json[]).some((e) => e.kind === "disposition" && e.disposition === "dismissed" && e.goal === g1.G)).toBe(true);
    // An absent eh never equals a present dismissedEh.
    const g3 = await cycle([item("A", { eh: E2 })], { dispositions: [disp(A, "dismissed")] });
    expect(g3.v.applied).toBe(1);
    const g4 = await cycle([item("A")]);
    expect(k.markOf(g4.a, A)).toBe("regression");
  });

  it("test_AC11_dismissed_absent_eh", async () => {
    await start();
    await cycle([item("A")], { dispositions: [disp(A, "dismissed")] });
    const g2 = await cycle([item("A")]);
    expect(k.markOf(g2.a, A)).toBe("repeat");
    const x = await k.itemOf(c.ann, A);
    expect(x.state).toBe("dismissed");
    expect(x).not.toHaveProperty("dismissedEh");
  });

  it("test_AC11_accepted_link", async () => {
    await start();
    const LINK = "https://tracker.invalid/1";
    await cycle([item("A")], { dispositions: [disp(A, "accepted", { link: LINK })] });
    expect(await k.itemOf(c.ann, A)).toMatchObject({ state: "accepted", link: LINK });
    const g2 = await cycle([item("A")]);
    expect(k.markOf(g2.a, A)).toBe("repeat");
    expect(await k.itemOf(c.ann, A)).toMatchObject({ state: "accepted", link: LINK });
    const g3 = await cycle([]);
    expect(g3.a.resolved).toStrictEqual([A]);
    expect(await k.itemOf(c.ann, A)).toMatchObject({ state: "resolved", link: LINK });
    const g4 = await cycle([item("A")]);
    expect(k.markOf(g4.a, A)).toBe("regression");
    expect(await k.itemOf(c.ann, A)).toMatchObject({ state: "open", link: LINK });
  });

  it("test_AC11_deferred_past", async () => {
    await start();
    await cycle([item("A")], { dispositions: [disp(A, "deferred", { until: "2026-11-20" })] });
    expect(await k.itemOf(c.ann, A)).toMatchObject({ state: "deferred", until: "2026-11-20" });
    k.r.w.clock = Date.UTC(2026, 10, 21, 12);
    const g2 = await cycle([item("A")]);
    expect(k.markOf(g2.a, A)).toBe("repeat");
    expect((await k.itemOf(c.ann, A)).state).toBe("open");
  });

  it("test_AC11_deferred_future", async () => {
    await start();
    await cycle([item("A")], { dispositions: [disp(A, "deferred", { until: "2026-11-20" })] });
    const g2 = await cycle([item("A")]);
    expect(k.markOf(g2.a, A)).toBe("repeat");
    expect(await k.itemOf(c.ann, A)).toMatchObject({ state: "deferred", until: "2026-11-20" });
  });

  it("test_AC11_deferred_utc", async () => {
    const tz = process.env.TZ;
    process.env.TZ = "Pacific/Kiritimati";
    try {
      await start();
      await cycle([item("A")], { dispositions: [disp(A, "deferred", { until: "2026-11-21" })] });
      // UTC today is 2026-11-20; the local date (UTC+14) would already be 2026-11-21.
      k.r.w.clock = Date.UTC(2026, 10, 20, 23, 30);
      await cycle([item("A")]);
      expect((await k.itemOf(c.ann, A)).state).toBe("deferred");
    } finally {
      if (tz === undefined) delete process.env.TZ;
      else process.env.TZ = tz;
    }
  });
});

// ---------------------------------------------------------------------------------------------

describe("AC-12 done", () => {
  const NEED = (id: string, n: number) => `${id} needs a review record for round ${n} (output: review-record); submit it with mesh_review, then call mesh_done`;
  const REOPEN = "a step with output: review-record reopens nothing; its record carries the findings";
  /** G: fix (done), audit (deps fix, max_rounds 1, a route for impl-bug to fix), claimed by ann. */
  async function routed(): Promise<string> {
    await start();
    const G = await k.goal(c.ann, [S.step("fix"), S.audit({ deps: ["fix"], max_rounds: 1, route: { "impl-bug": "fix" } })]);
    await k.claim(c.ann, `${G}.fix`);
    await k.closeOk(c.ann, `${G}.fix`);
    await k.claim(c.ann, `${G}.audit`);
    return G;
  }

  it("test_AC12_no_record_409", async () => {
    const G = await routed();
    expect(await k.close(c.ann, `${G}.audit`)).toStrictEqual({ status: 409, json: { error: NEED(`${G}.audit`, 1) } });
    expect(await k.state(`${G}.audit`)).toBe("claimed");
    expect(await rounds(`${G}.audit`)).toHaveLength(0);
    // Through mesh_done from a session holding such a step.
    const H = await k.goal(c.ann, [S.step("scan", { output: "review-record" })]);
    await k.r.w.hook(c.ann, "SessionStart", 1);
    const cl = await k.r.w.tool(c.ann, 1, "mesh_claim", { step: `${H}.scan` });
    expect(cl.isError, cl.text).toBeFalsy();
    const t = await k.r.w.tool(c.ann, 1, "mesh_done", { outcome: "done", summary: "s" });
    expect(t.isError).toBe(true);
    expect(t.text).toContain(NEED(`${H}.scan`, 1));
    expect(await k.state(`${H}.scan`)).toBe("claimed");
    expect(await rounds(`${H}.scan`)).toHaveLength(0);
  });

  it("test_AC12_fail_with_record_is_done", async () => {
    const G = await routed();
    const res = await k.reviewOk(c.ann, `${G}.audit`, rec({ items: [item("A")] }));
    const d = await k.close(c.ann, `${G}.audit`, { outcome: "fail", verdict: "changes_requested", failures: [{ bucket: "impl-bug" }] });
    expect(d.status, JSON.stringify(d.json)).toBe(200);
    expect(await k.state(`${G}.audit`)).toBe("done");
    const rs = await rounds(`${G}.audit`);
    expect(rs).toHaveLength(1);
    expect(rs[0]).toMatchObject({ n: 1, outcome: "done", verdict: "changes_requested" });
    expect(rs[0].fold).toStrictEqual(res.review.fold);
    expect(rs[0]).not.toHaveProperty("findings");
    expect(rs[0].artifactIds).toContain(res.review.artifact);
    // Neither routed nor parked.
    expect(await k.state(`${G}.fix`)).toBe("done");
  });

  it("test_AC12_findings_sent", async () => {
    const G = await routed();
    const res = await k.reviewOk(c.ann, `${G}.audit`, rec({ items: [item("A")] }));
    await k.closeOk(c.ann, `${G}.audit`, { verdict: "approved", findings: { new: 1, repeat: 0, regression: 0 } });
    const [r1] = await rounds(`${G}.audit`);
    expect(r1.findings).toStrictEqual({ new: 1, repeat: 0, regression: 0 });
    expect(r1.fold).toStrictEqual(res.review.fold);
  });

  it.each([
    ["without a record", false],
    ["with a record", true],
  ])("test_AC12_reopen_400 %s", async (_n, withRecord) => {
    const G = await routed();
    if (withRecord) await k.reviewOk(c.ann, `${G}.audit`, rec());
    expect(await k.close(c.ann, `${G}.audit`, { outcome: "fail", reopen: ["x"] })).toStrictEqual({ status: 400, json: { error: REOPEN } });
    expect(await k.close(c.ann, `${G}.audit`, { outcome: "fail", reopen: ["fix"] })).toStrictEqual({ status: 400, json: { error: REOPEN } });
    expect(await k.state(`${G}.audit`)).toBe("claimed");
  });

  it("test_AC12_reopen_order_vs_gate", async () => {
    await start();
    const G = await k.goal(c.ann, [S.step("a"), S.step("g", { kind: "gate", gate: "R1", deps: ["a"] })]);
    await k.claim(c.ann, `${G}.a`);
    await k.closeOk(c.ann, `${G}.a`);
    const d = await k.close(c.ann, `${G}.g`, { outcome: "fail", reopen: ["x"] });
    expect(d.json?.error).not.toBe(REOPEN);
    expect(d.status).not.toBe(200);
  });

  it("test_AC12_fail_without_record", async () => {
    const G = await routed();
    const d = await k.close(c.ann, `${G}.audit`, { outcome: "fail", verdict: "changes_requested", failures: [{ bucket: "impl-bug" }] });
    expect(d.status, JSON.stringify(d.json)).toBe(200);
    // As today: without a record judgeDone applies, and max_rounds 1 parks the step (the control
    // for test_AC12_fail_with_record_is_done, where the same done closes it).
    expect(await k.state(`${G}.audit`)).toBe("parked");
    // A route alone is followed as today: the fix step is reopened.
    const H = await k.goal(c.ann, [S.step("fix"), S.audit({ deps: ["fix"], route: { "impl-bug": "fix" } })]);
    await k.claim(c.ann, `${H}.fix`);
    await k.closeOk(c.ann, `${H}.fix`);
    await k.claim(c.ann, `${H}.audit`);
    expect((await k.close(c.ann, `${H}.audit`, { outcome: "fail", verdict: "changes_requested", failures: [{ bucket: "impl-bug" }] })).status).toBe(200);
    expect(await k.state(`${H}.fix`)).toBe("ready");
    expect(await k.state(`${H}.audit`)).not.toBe("done");
    // Without a route: failed.
    const F = await k.goal(c.ann, [S.audit()]);
    await k.claim(c.ann, `${F}.audit`);
    expect((await k.close(c.ann, `${F}.audit`, { outcome: "fail" })).status).toBe(200);
    expect(await k.state(`${F}.audit`)).toBe("failed");
  });

  it("test_AC12_no_output_unchanged", async () => {
    await start();
    const G = await k.goal(c.ann, [S.step("s")]);
    await k.claim(c.ann, `${G}.s`);
    await k.closeOk(c.ann, `${G}.s`);
    expect(await k.state(`${G}.s`)).toBe("done");
    expect((await rounds(`${G}.s`))[0]).not.toHaveProperty("fold");
  });
});

// ---------------------------------------------------------------------------------------------

describe("AC-13 dispositions", () => {
  /** G: audit [A eh E1, B eh E2] done; `validate` (consuming, policy over) held by ann. */
  async function consuming(over: Record<string, unknown> = {}, extra: PlanIn[] = []): Promise<string> {
    await start();
    const G = await k.goal(c.ann, [S.audit(), S.validate(over), ...extra]);
    await k.submit(c.ann, `${G}.audit`, rec({ items: [item("A", { eh: E1 }), item("B", { eh: E2 })] }));
    await k.claim(c.ann, `${G}.validate`);
    return G;
  }

  it("test_AC13_apply", async () => {
    const G = await consuming();
    const res = await k.reviewOk(c.ann, `${G}.validate`, rec({ dispositions: [disp(A, "confirmed", { reason: "r1" }), disp(B, "dismissed", { reason: "r2" })], agent: { key: "validator@x", hash: "h1" } }));
    expect(res.applied).toBe(2);
    expect(res.ignored).toStrictEqual([]);
    expect(res.items).toStrictEqual([]);
    expect(res.review.raising).toBe(false);
    expect(res.review.lineage).toBe(L);
    const a = await k.itemOf(c.ann, A);
    const b = await k.itemOf(c.ann, B);
    expect(a.state).toBe("confirmed");
    expect(b.state).toBe("dismissed");
    expect(b.dismissedEh).toBe(E2);
    const decider = { kind: "agent", key: "validator@x", hash: "h1" };
    expect(lastHistory(a)).toMatchObject({ kind: "disposition", disposition: "confirmed", reason: "r1", decider, via: "stage", round: 1, from: "open", to: "confirmed", goal: G, step: `${G}.validate` });
    expect(lastHistory(b)).toMatchObject({ kind: "disposition", disposition: "dismissed", reason: "r2", decider, via: "stage", round: 1, from: "open", to: "dismissed" });
    const es = await ev("item.disposed", `${G}.validate`);
    expect(es).toHaveLength(2);
    const byFp = Object.fromEntries(es.map((e) => [e.payload.fp, e.payload]));
    expect(byFp[A]).toStrictEqual({ lineage: L, fp: A, disposition: "confirmed", from: "open", decider: "agent", via: "stage", round: 1 });
    expect(byFp[B]).toStrictEqual({ lineage: L, fp: B, disposition: "dismissed", from: "open", decider: "agent", via: "stage", round: 1 });
    expect(es[0]).toMatchObject({ user: "ann", goal: G, step: `${G}.validate` });
    const rec1 = (await ev("review.recorded", `${G}.validate`))[0];
    expect(rec1.payload).toMatchObject({ dispositions: 2, ignored: 0 });
  });

  const MAY = (G: string, d: string, list = "confirmed, dismissed") => `${G}.validate may not set ${d} (may_set: ${list})`;
  async function refused(G: string, id: string, dispositions: unknown[], details: string[]): Promise<void> {
    expect(await k.review(c.ann, id, rec({ dispositions }))).toStrictEqual({ status: 422, json: { error: PROBLEMS(details.length, details), details } });
    expect((await k.reviews(c.ann, id)).json.reviews).toStrictEqual([]);
    expect(await ev("item.disposed", id)).toHaveLength(0);
    expect((await k.itemOf(c.ann, A)).state).not.toBe("dismissed");
  }

  it("test_AC13_problem_may_set", async () => {
    const G = await consuming();
    await refused(G, `${G}.validate`, [disp(A, "accepted")], [`disposition of ${A}: ${MAY(G, "accepted")}`]);
    expect((await k.itemOf(c.ann, A)).state).toBe("open");
  });

  it("test_AC13_problem_no_item", async () => {
    const G = await consuming();
    await refused(G, `${G}.validate`, [disp(NOFP, "confirmed")], [`disposition of ${NOFP}: no item ${NOFP} in the record of ${G}.audit`]);
  });

  it("test_AC13_problem_state", async () => {
    await start();
    const G = await k.goal(c.ann, [S.audit(), S.validate({ id: "v1", may_set: ["confirmed"] }), S.validate({ id: "v2", deps: ["v1"] })]);
    await k.submit(c.ann, `${G}.audit`, rec({ items: [item("A"), item("B")] }));
    await k.submit(c.ann, `${G}.v1`, rec({ dispositions: [disp(A, "confirmed")] }));
    await k.claim(c.ann, `${G}.v2`);
    const p = `disposition of ${A}: item ${A} is confirmed; ${G}.v2 acts on open`;
    expect(await k.review(c.ann, `${G}.v2`, rec({ dispositions: [disp(A, "dismissed")] }))).toStrictEqual({ status: 422, json: { error: PROBLEMS(1, [p]), details: [p] } });
    expect((await k.itemOf(c.ann, A)).state).toBe("confirmed");
    // Control: B (still open) may be dismissed by v2.
    expect((await k.reviewOk(c.ann, `${G}.v2`, rec({ dispositions: [disp(B, "dismissed")] }))).applied).toBe(1);
  });

  it("test_AC13_problem_until", async () => {
    const G = await consuming({ may_set: ["confirmed", "dismissed", "deferred"] });
    await refused(G, `${G}.validate`, [disp(A, "deferred")], [`disposition of ${A}: deferred needs until (YYYY-MM-DD)`]);
  });

  it("test_AC13_problem_twice", async () => {
    const G = await consuming();
    await refused(G, `${G}.validate`, [disp(A, "confirmed"), disp(A, "dismissed")], [`disposition of ${A}: listed twice`]);
  });

  it("test_AC13_valid_with_bad_rejects_all", async () => {
    const G = await consuming();
    const res = await k.review(c.ann, `${G}.validate`, rec({ dispositions: [disp(A, "confirmed"), disp(B, "accepted")] }));
    expect(res.status).toBe(422);
    expect(res.json.details).toStrictEqual([`disposition of ${B}: ${MAY(G, "accepted")}`]);
    expect((await k.itemOf(c.ann, A)).state).toBe("open");
    expect(await ev("item.disposed", `${G}.validate`)).toHaveLength(0);
  });

  it("test_AC13_first_check_only", async () => {
    const G = await consuming();
    const res = await k.review(c.ann, `${G}.validate`, rec({ dispositions: [disp(NOFP, "accepted")] }));
    expect(res.status).toBe(422);
    expect(res.json.details).toStrictEqual([`disposition of ${NOFP}: ${MAY(G, "accepted")}`]);
  });

  it("test_AC13_record_order", async () => {
    const G = await consuming();
    const res = await k.review(c.ann, `${G}.validate`, rec({ dispositions: [disp(NOFP, "confirmed"), disp(A, "accepted")] }));
    expect(res.status).toBe(422);
    const details = [`disposition of ${NOFP}: no item ${NOFP} in the record of ${G}.audit`, `disposition of ${A}: ${MAY(G, "accepted")}`];
    expect(res.json).toStrictEqual({ error: PROBLEMS(2, details), details });
  });

  it("test_AC13_record_level_first", async () => {
    const G = await consuming();
    const res = await k.review(c.ann, `${G}.validate`, rec({ items: [item("Z")], dispositions: [disp(NOFP, "confirmed")] }));
    expect(res.status).toBe(422);
    expect(res.json.details).toStrictEqual([`${G}.validate consumes items; its record may not raise new ones`, `disposition of ${NOFP}: no item ${NOFP} in the record of ${G}.audit`]);
  });

  it("test_AC13_no_may_set", async () => {
    await start();
    const G = await k.goal(c.ann, [S.audit(), { id: "validate", repo: ALPHA, deps: ["audit"], mode: "headless", output: "review-record", consumes: ["open"] }]);
    await k.submit(c.ann, `${G}.audit`, rec({ items: [item("A")] }));
    await k.claim(c.ann, `${G}.validate`);
    const res = await k.review(c.ann, `${G}.validate`, rec({ dispositions: [disp(A, "confirmed")] }));
    expect(res.status).toBe(422);
    expect(res.json.details).toStrictEqual([`disposition of ${A}: ${G}.validate may not set confirmed (may_set: none)`]);
  });

  it("test_AC13_person_decider", async () => {
    await start();
    const G = await k.goal(c.ann, [S.audit(), S.step("rv", { deps: ["audit"], output: "review-record", consumes: ["open"], may_set: ["confirmed", "dismissed"] })]);
    await k.submit(c.ann, `${G}.audit`, rec({ items: [item("A"), item("B")] }));
    await k.claim(c.ann, `${G}.rv`);
    const res = await k.reviewOk(c.ann, `${G}.rv`, rec({ dispositions: [disp(A, "confirmed")], agent: { key: "ignored/agent" } }));
    expect(res.applied).toBe(1);
    expect(lastHistory(await k.itemOf(c.ann, A)).decider).toStrictEqual({ kind: "person", user: "ann" });
    const es = await ev("item.disposed", `${G}.rv`);
    expect(es).toHaveLength(1);
    expect(es[0].payload.decider).toBe("person");
  });

  it("test_AC13_agent_fallback_key", async () => {
    const G = await consuming();
    await k.reviewOk(c.ann, `${G}.validate`, rec({ dispositions: [disp(A, "confirmed")] }));
    expect(lastHistory(await k.itemOf(c.ann, A)).decider).toStrictEqual({ kind: "agent", key: "alpha/validate" });
  });
});

// ---------------------------------------------------------------------------------------------

describe("AC-14 precedence", () => {
  const PLAN = (): PlanIn[] => [
    S.audit(),
    S.step("review", { deps: ["audit"], output: "review-record", consumes: ["open"], may_set: ["dismissed"] }),
    S.step("recheck", { deps: ["review"], mode: "headless", output: "review-record", consumes: ["open"], may_set: ["confirmed", "dismissed", "deferred"] }),
    S.step("check", { kind: "verify", deps: ["recheck"] }),
  ];
  /** audit [A, B, C] (A with `aOpts`); the person on `review` dismisses A. Recheck is held by ann. */
  async function personDismissed(aOpts: Record<string, unknown> = {}): Promise<string> {
    const G = await k.goal(c.ann, PLAN());
    await k.submit(c.ann, `${G}.audit`, rec({ items: [item("A", aOpts), item("B"), item("C")] }));
    await k.submit(c.ann, `${G}.review`, rec({ dispositions: [disp(A, "dismissed", { reason: "person says no" })] }));
    await k.claim(c.ann, `${G}.recheck`);
    return G;
  }

  it("test_AC14_ignored", async () => {
    await start();
    const G = await personDismissed();
    const res = await k.reviewOk(c.ann, `${G}.recheck`, rec({ dispositions: [disp(A, "confirmed"), disp(B, "confirmed")] }));
    expect(res.ignored).toStrictEqual([{ fingerprint: A, reason: "decided by ann in this goal" }]);
    expect(res.applied).toBe(1);
    expect((await k.itemOf(c.ann, A)).state).toBe("dismissed");
    expect((await k.itemOf(c.ann, B)).state).toBe("confirmed");
    const es = await ev("item.disposed", `${G}.recheck`);
    expect(es.map((e) => e.payload.fp)).toStrictEqual([B]);
    expect((await ev("review.recorded", `${G}.recheck`))[0].payload).toMatchObject({ dispositions: 1, ignored: 1 });
    expect((await k.reviews(c.ann, `${G}.recheck`)).json.reviews).toHaveLength(1);
    await k.closeOk(c.ann, `${G}.recheck`);
    expect(await k.state(`${G}.recheck`)).toBe("done");
  });

  it("test_AC14_conflicts", async () => {
    await start();
    const G = await personDismissed();
    await k.reviewOk(c.ann, `${G}.recheck`, rec({ dispositions: [disp(B, "confirmed")] }));
    await k.closeOk(c.ann, `${G}.recheck`);
    await k.reopenVia(c.ann, G, "check", "recheck");
    expect(await k.state(`${G}.recheck`)).toBe("ready");
    await k.claim(c.ann, `${G}.recheck`);
    const one = async (d: unknown, p: string) => expect(await k.review(c.ann, `${G}.recheck`, rec({ dispositions: [d] }))).toStrictEqual({ status: 422, json: { error: PROBLEMS(1, [p]), details: [p] } });
    // test_AC14_conflict_may_set
    await one(disp(A, "accepted"), `disposition of ${A}: ${G}.recheck may not set accepted (may_set: confirmed, dismissed, deferred)`);
    // test_AC14_conflict_until
    await one(disp(A, "deferred"), `disposition of ${A}: deferred needs until (YYYY-MM-DD)`);
    // test_AC14_conflict_no_item
    await one(disp(NOFP, "confirmed"), `disposition of ${NOFP}: no item ${NOFP} in the record of ${G}.audit`);
    // Control: a precedence-only conflict in round 2 is still ignored, not refused.
    const ok = await k.reviewOk(c.ann, `${G}.recheck`, rec({ dispositions: [disp(A, "confirmed")] }));
    expect(ok.review.round).toBe(2);
    expect(ok.ignored).toStrictEqual([{ fingerprint: A, reason: "decided by ann in this goal" }]);
  });

  it("test_AC14_cross_goal", async () => {
    await start();
    const G1 = await personDismissed();
    await k.reviewOk(c.ann, `${G1}.recheck`, rec());
    await k.closeOk(c.ann, `${G1}.recheck`);
    const G2 = await k.goal(c.ann, PLAN());
    const a2 = await k.submit(c.ann, `${G2}.audit`, rec({ items: [item("A", { eh: E9 })] }));
    expect(k.markOf(a2, A)).toBe("regression");
    await k.submit(c.ann, `${G2}.review`, rec());
    await k.claim(c.ann, `${G2}.recheck`);
    const res = await k.reviewOk(c.ann, `${G2}.recheck`, rec({ dispositions: [disp(A, "confirmed")] }));
    expect(res.applied).toBe(1);
    expect(res.ignored).toStrictEqual([]);
    const x = await k.itemOf(c.ann, A);
    expect(x.state).toBe("confirmed");
    const ds = (x.history as Json[]).filter((e) => e.kind === "disposition");
    expect(ds.map((e) => [e.goal, e.disposition, e.decider.kind])).toStrictEqual([
      [G1, "dismissed", "person"],
      [G2, "confirmed", "agent"],
    ]);
  });
});

// ---------------------------------------------------------------------------------------------

describe("AC-16 reads", () => {
  it("test_AC16_items_order", async () => {
    await start();
    await cycle([item("X"), item("Z")]);
    k.r.w.clock += 1000;
    await cycle([item("X"), item("Y", { severity: "S1" }), item("V"), item("Z"), item("W", { severity: "S2" })]);
    const xs = await k.itemsOf(c.ann);
    const s3old = [fpOf("X"), fpOf("Z")].sort();
    expect(xs.map((x) => x.fp)).toStrictEqual([fpOf("Y"), fpOf("W"), ...s3old, fpOf("V")]);
    for (const x of xs) {
      expect((x.history as Json[]).length, x.fp).toBeGreaterThan(0);
      expect(x.first).toMatchObject({ step: expect.stringMatching(/\.audit$/), round: 1 });
      expect(x.last).toMatchObject({ round: 1 });
      expect(x.lineage).toBe(L);
    }
    expect(xs.find((x) => x.fp === fpOf("X")).first.at).toBeLessThan(xs.find((x) => x.fp === fpOf("X")).last.at);
  });

  it("test_AC16_items_unknown_and_400", async () => {
    await start();
    expect(await k.r.call(c.ann, "GET", "/v1/items?lineage=nope")).toStrictEqual({ status: 200, json: { lineage: "nope", items: [] } });
    expect(await k.r.call(c.ann, "GET", "/v1/items")).toStrictEqual({ status: 400, json: { error: "lineage is required" } });
  });

  it("test_AC16_reviews", async () => {
    await start();
    const G = await k.goal(c.ann, [S.audit(), S.step("check", { kind: "verify", deps: ["audit"] })]);
    await k.submit(c.ann, `${G}.audit`, rec({ items: [item("A")] }));
    await k.reopenVia(c.ann, G, "check", "audit");
    await k.submit(c.ann, `${G}.audit`, rec());
    const r = await k.reviews(c.ann, `${G}.audit`);
    expect(r.status).toBe(200);
    expect((r.json.reviews as Json[]).map((x) => x.round)).toStrictEqual([1, 2]);
    expect(await k.reviews(c.ann, `${G}.nope`)).toStrictEqual({ status: 404, json: { error: `no step ${G}.nope` } });
  });

  it("test_AC16_service_token", async () => {
    await start();
    const G = await k.goal(c.ann, [S.audit()]);
    await k.claim(c.ann, `${G}.audit`);
    const t = await k.r.w.hub.svc.serviceToken("viewer", ["goals:read"]);
    expect((await k.r.call(t, "GET", `/v1/items?lineage=${encodeURIComponent(L)}`)).status).toBe(200);
    expect((await k.r.call(t, "GET", `/v1/steps/${G}.audit/reviews`)).status).toBe(200);
    expect((await k.review(t, `${G}.audit`, rec())).status).toBe(403);
    // Control: the holder may post it.
    expect((await k.review(c.ann, `${G}.audit`, rec())).status).toBe(201);
  });
});

// ---------------------------------------------------------------------------------------------

describe("AC-17 when", () => {
  it("test_AC17_blocked_on_approve", async () => {
    await start();
    const G = await k.goal(c.ann, relayPlan());
    expect(await k.state(`${G}.audit`)).toBe("ready");
    expect(await k.state(`${G}.validate`)).toBe("blocked");
    expect(await ev("step.ready", `${G}.validate`)).toStrictEqual([]);
    expect(await ev("step.skipped", `${G}.validate`)).toStrictEqual([]);
  });

  it("test_AC17_not_ready_on_replan_approve", async () => {
    // A when step added by a replan after its dependency is done is decided at approve, never made ready first.
    await start();
    const base = [S.audit(), S.step("check", { kind: "verify", deps: ["audit"] })];
    const v = S.validate({ when: { open: true, min_severity: "S2" } });
    const G = await k.goal(c.ann, base);
    await k.submit(c.ann, `${G}.audit`, rec({ items: [item("P", { severity: "S3" })] }));
    expect(await k.state(`${G}.audit`)).toBe("done");
    await k.replan(c.ann, G, [...base, v]);
    const s = await k.r.stepOf(`${G}.validate`);
    expect(s.state).toBe("skipped");
    expect(s.summary).toBe("skipped: no item of audit is open at S2 or above");
    expect(await ev("step.ready", `${G}.validate`)).toStrictEqual([]);
    expect(await ev("step.skipped", `${G}.validate`)).toHaveLength(1);
    // Control: an S1 item holds the same when, so the added step is ready.
    const beta = (p: PlanIn[]) => p.map((x) => ({ ...x, repo: "/src/beta" }));
    const H = await k.goal(c.ann, beta(base));
    await k.submit(c.ann, `${H}.audit`, rec({ items: [item("Q", { severity: "S1" })] }));
    await k.replan(c.ann, H, beta([...base, v]));
    expect(await k.state(`${H}.validate`)).toBe("ready");
    expect(await ev("step.skipped", `${H}.validate`)).toStrictEqual([]);
  });

  it("test_AC17_skip_cascade", async () => {
    await start();
    const G = await k.goal(c.ann, relayPlan());
    const P = fpOf("P");
    await k.submit(c.ann, `${G}.audit`, rec({ items: [item("P", { severity: "S3" })] }));
    expect(await k.state(`${G}.validate`)).toBe("ready");
    await k.submit(c.ann, `${G}.validate`, rec({ dispositions: [disp(P, "confirmed")] }));
    const d = await k.r.stepOf(`${G}.debrief`);
    expect(d.state).toBe("skipped");
    expect(d.summary).toBe("skipped: no item of audit is open or confirmed at S2 or above");
    const es = await ev("step.skipped", `${G}.debrief`);
    expect(es).toHaveLength(1);
    expect(es[0].payload).toStrictEqual({ reason: "when" });
    const f = await k.r.stepOf(`${G}.file`);
    expect(f.state).toBe("skipped");
    expect(f.summary).toBe("skipped: no item of audit is accepted");
    expect(await ev("step.skipped", `${G}.file`)).toHaveLength(1);
    expect(await ev("step.ready", `${G}.debrief`)).toStrictEqual([]);
    expect(await k.goalState(c.ann, G)).toBe("done");
    expect((await ev("goal.done")).filter((e) => e.goal === G)).toHaveLength(1);
  });

  it("test_AC17_clean_audit", async () => {
    await start();
    const G = await k.goal(c.ann, relayPlan());
    await k.submit(c.ann, `${G}.audit`, rec());
    const v = await k.r.stepOf(`${G}.validate`);
    expect(v.state).toBe("skipped");
    expect(v.summary).toBe("skipped: no item of audit is open");
    expect(await k.state(`${G}.debrief`)).toBe("skipped");
    expect(await k.state(`${G}.file`)).toBe("skipped");
    expect(await ev("step.ready", `${G}.validate`)).toStrictEqual([]);
    expect(await k.goalState(c.ann, G)).toBe("done");
  });

  it("test_AC17_s1_ready", async () => {
    await start();
    const G = await k.goal(c.ann, relayPlan());
    const P = fpOf("P");
    await k.submit(c.ann, `${G}.audit`, rec({ items: [item("P", { severity: "S1" })] }));
    await k.submit(c.ann, `${G}.validate`, rec({ dispositions: [disp(P, "confirmed")] }));
    expect(await k.state(`${G}.debrief`)).toBe("ready");
    expect(await ev("step.ready", `${G}.debrief`)).toHaveLength(1);
    expect(await ev("step.skipped", `${G}.debrief`)).toHaveLength(0);
    expect(await k.state(`${G}.file`)).toBe("blocked");
  });

  it("test_AC17_validate_ready", async () => {
    await start();
    const G = await k.goal(c.ann, relayPlan());
    await k.submit(c.ann, `${G}.audit`, rec({ items: [item("P")] }));
    expect(await k.state(`${G}.validate`)).toBe("ready");
    expect(await ev("step.ready", `${G}.validate`)).toHaveLength(1);
  });

  it("test_AC17_validate_state_from_rows", async () => {
    await start();
    const G = await k.goal(c.ann, relayPlan([S.step("v2", { deps: ["validate"], output: "review-record", when: { open: true }, consumes: ["open"] })]));
    const P = fpOf("P");
    await k.submit(c.ann, `${G}.audit`, rec({ items: [item("P")] }));
    await k.submit(c.ann, `${G}.validate`, rec({ dispositions: [disp(P, "confirmed")] }));
    expect(await k.state(`${G}.v2`)).toBe("skipped");
  });
});

// ---------------------------------------------------------------------------------------------

describe("AC-18 re-evaluation", () => {
  it("test_AC18_reopen", async () => {
    await start();
    const G = await k.goal(c.ann, relayPlan([S.step("check", { kind: "verify", deps: ["file"] })]));
    const P = fpOf("P");
    const Q = fpOf("Q");
    await k.submit(c.ann, `${G}.audit`, rec({ items: [item("P")] }));
    await k.submit(c.ann, `${G}.validate`, rec({ dispositions: [disp(P, "confirmed")] }));
    expect(await k.state(`${G}.debrief`)).toBe("skipped");
    expect(await k.state(`${G}.file`)).toBe("skipped");
    expect(await k.state(`${G}.check`)).toBe("ready");
    await k.reopenVia(c.ann, G, "check", "audit");
    expect(await k.state(`${G}.audit`)).toBe("ready");
    for (const s of ["validate", "debrief", "file"]) expect(await k.state(`${G}.${s}`), s).toBe("blocked");
    await k.submit(c.ann, `${G}.audit`, rec({ items: [item("Q", { severity: "S1" })] }));
    expect(await k.state(`${G}.validate`)).toBe("ready");
    await k.submit(c.ann, `${G}.validate`, rec({ dispositions: [disp(Q, "confirmed")] }));
    expect(await k.state(`${G}.debrief`)).toBe("ready");
  });

  it("test_AC18_gate_approve", async () => {
    await start();
    const G = await k.goal(c.ann, [S.audit(), S.step("gate", { kind: "gate", gate: "R1", deps: ["audit"] }), S.step("c", { deps: ["gate"], output: "review-record", consumes: ["open"], when: { open: true } })]);
    await k.submit(c.ann, `${G}.audit`, rec());
    expect(await k.state(`${G}.c`)).toBe("blocked");
    const ap = await k.r.call(c.ann, "POST", `/v1/steps/${G}.gate/approve`, { comment: "ok" });
    expect(ap.status, JSON.stringify(ap.json)).toBe(200);
    expect(await k.state(`${G}.c`)).toBe("skipped");
    expect(await ev("step.skipped", `${G}.c`)).toHaveLength(1);
  });

  it("test_AC18_replan_unchanged_and_changed", async () => {
    await start();
    const plan = relayPlan([S.step("check", { kind: "verify", deps: ["file"] })]);
    const G = await k.goal(c.ann, plan);
    await k.submit(c.ann, `${G}.audit`, rec());
    expect(await k.state(`${G}.debrief`)).toBe("skipped");
    expect(await ev("step.skipped", `${G}.debrief`)).toHaveLength(1);
    // test_AC18_replan_unchanged
    await k.replan(c.ann, G, plan);
    expect(await k.state(`${G}.debrief`)).toBe("skipped");
    expect(await ev("step.skipped", `${G}.debrief`)).toHaveLength(1);
    expect(await ev("step.ready", `${G}.debrief`)).toHaveLength(0);
    // test_AC18_replan_changed_brief: decided again, skipped again (nothing to consume).
    await k.replan(
      c.ann,
      G,
      plan.map((s) => (s.id === "debrief" ? { ...s, brief: "a new brief" } : s)),
    );
    expect(await k.state(`${G}.debrief`)).toBe("skipped");
    expect(await ev("step.skipped", `${G}.debrief`)).toHaveLength(2);
    expect(await ev("step.ready", `${G}.debrief`)).toHaveLength(0);
  });

  it("test_AC18_replan_changed_brief_ready", async () => {
    await start();
    // debrief consumes [open] here, so a confirmed item at S2 does not hold it; a changed policy that consumes confirmed does.
    const plan = [S.audit(), S.validate(), S.step("debrief", { deps: ["validate"], output: "review-record", when: { min_severity: "S2" }, consumes: ["open"] }), S.step("check", { kind: "verify", deps: ["debrief"] })];
    const G = await k.goal(c.ann, plan);
    const P = fpOf("P");
    await k.submit(c.ann, `${G}.audit`, rec({ items: [item("P", { severity: "S1" })] }));
    await k.submit(c.ann, `${G}.validate`, rec({ dispositions: [disp(P, "confirmed")] }));
    expect(await k.state(`${G}.debrief`)).toBe("skipped");
    await k.replan(
      c.ann,
      G,
      plan.map((s) => (s.id === "debrief" ? { ...s, brief: "look at confirmed ones", consumes: ["open", "confirmed"] } : s)),
    );
    expect(await k.state(`${G}.debrief`)).toBe("ready");
  });

  it("test_AC18_replan_adds_when", async () => {
    await start();
    const base = [S.audit(), S.step("check", { kind: "verify", deps: ["audit"] })];
    const x = S.step("x", { deps: ["audit"], output: "review-record", consumes: ["open"], when: { open: true } });
    const G = await k.goal(c.ann, base);
    await k.submit(c.ann, `${G}.audit`, rec({ items: [item("Q", { severity: "S1" })] }));
    await k.replan(c.ann, G, [...base, x]);
    expect(await k.state(`${G}.x`)).toBe("ready");
    // With nothing open: skipped on approve, never ready.
    const H = await k.goal(c.ann, base.map((s) => ({ ...s, repo: "/src/beta" })));
    await k.submit(c.ann, `${H}.audit`, rec());
    await k.replan(c.ann, H, [...base, x].map((s) => ({ ...s, repo: "/src/beta" })));
    expect(await k.state(`${H}.x`)).toBe("skipped");
    expect(await ev("step.ready", `${H}.x`)).toHaveLength(0);
  });

  it("test_AC18_replan_goal_done", async () => {
    await start();
    const G = await k.goal(c.ann, [S.audit(), S.step("check", { kind: "verify", deps: ["audit"] })]);
    await k.submit(c.ann, `${G}.audit`, rec());
    expect(await k.goalState(c.ann, G)).not.toBe("done");
    await k.replan(c.ann, G, [S.audit(), S.step("x", { deps: ["audit"], output: "review-record", consumes: ["open"], when: { open: true } })]);
    expect(await k.state(`${G}.x`)).toBe("skipped");
    expect(await k.goalState(c.ann, G)).toBe("done");
    expect((await ev("goal.done")).filter((e) => e.goal === G)).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------------------------

describe("AC-22 inputs", () => {
  it("test_AC22_previous", async () => {
    await start();
    const g1 = await cycle([item("A")]);
    const G2 = await k.goal(c.ann, [S.audit({ inputs: ["previous"] })]);
    await k.claim(c.ann, `${G2}.audit`);
    const ins = (await k.ctx(c.ann, `${G2}.audit`)).inputs as Json[];
    expect(ins).toStrictEqual([{ from: `${g1.G}.audit`, artifact: g1.a.review.artifact, kind: "review", title: `previous review record (${g1.G} round 1)`, content: JSON.stringify(g1.a.review.record), truncated: false }]);
  });

  it("test_AC22_previous_none", async () => {
    await start();
    await cycle([item("A")], { coverage: "partial" });
    const G2 = await k.goal(c.ann, [S.audit({ inputs: ["previous"] })]);
    await k.claim(c.ann, `${G2}.audit`);
    const ctx = await k.ctx(c.ann, `${G2}.audit`);
    expect(((ctx.inputs ?? []) as Json[]).filter((i) => i.kind === "review")).toStrictEqual([]);
    // Control: after a complete record there is one.
    await k.reviewOk(c.ann, `${G2}.audit`, rec({ items: [item("A")] }));
    await k.closeOk(c.ann, `${G2}.audit`);
    const G3 = await k.goal(c.ann, [S.audit({ inputs: ["previous"] })]);
    await k.claim(c.ann, `${G3}.audit`);
    expect(((await k.ctx(c.ann, `${G3}.audit`)).inputs as Json[]).filter((i) => i.kind === "review")).toHaveLength(1);
  });

  it("test_AC22_dispositions_consuming", async () => {
    await start();
    const G = await k.goal(c.ann, [S.audit(), S.validate({ id: "v1", may_set: ["confirmed"] }), S.validate({ id: "v2", deps: ["v1"], inputs: ["dispositions"] })]);
    await k.submit(c.ann, `${G}.audit`, rec({ items: [item("A"), item("B")] }));
    await k.submit(c.ann, `${G}.v1`, rec({ dispositions: [disp(B, "confirmed")] }));
    await k.claim(c.ann, `${G}.v2`);
    const ins = (await k.ctx(c.ann, `${G}.v2`)).inputs as Json[];
    expect(ins).toHaveLength(1);
    expect(ins[0]).toMatchObject({ from: `${G}.audit`, artifact: "items", kind: "review", title: "items and dispositions", truncated: false });
    const content = JSON.parse(ins[0].content);
    expect(content.lineage).toBe(L);
    expect((content.items as Json[]).map((x) => x.fp)).toStrictEqual([A]);
    expect((content.items[0].history as Json[]).length).toBeGreaterThan(0);
  });

  it("test_AC22_dispositions_raising", async () => {
    await start();
    await cycle([item("A"), item("B"), item("C")], { dispositions: [disp(B, "dismissed")] });
    await cycle([item("A"), item("B")]);
    expect((await k.itemOf(c.ann, C)).state).toBe("resolved");
    const G3 = await k.goal(c.ann, [S.audit({ inputs: ["dispositions"] })]);
    await k.claim(c.ann, `${G3}.audit`);
    const ins = (await k.ctx(c.ann, `${G3}.audit`)).inputs as Json[];
    expect(ins).toHaveLength(1);
    expect(ins[0]).toMatchObject({ from: `${G3}.audit`, artifact: "items", kind: "review", title: "items and dispositions" });
    expect(((JSON.parse(ins[0].content).items as Json[]).map((x) => x.fp) as string[]).sort()).toStrictEqual([A, B].sort());
  });

  it("test_AC22_none", async () => {
    await start();
    const G = await k.goal(c.ann, [S.audit({ agent: "fresh", inputs: ["dispositions", "previous"] })]);
    await k.claim(c.ann, `${G}.audit`);
    const ctx = await k.ctx(c.ann, `${G}.audit`);
    expect("inputs" in ctx ? ctx.inputs : []).toStrictEqual([]);
  });
});

// ---------------------------------------------------------------------------------------------

describe("AC-24 privacy", () => {
  const MK = { title: "MK-TITLE-7f3", note: "MK-NOTE-7f3", prop: "MK-PROP-7f3", r1: "MK-REASON1-7f3", r2: "MK-REASON2-7f3", r3: "MK-REASON3-7f3" };
  it("test_AC24_no_markers", async () => {
    await start();
    const G = await k.goal(c.ann, [
      S.audit(),
      S.step("review", { deps: ["audit"], output: "review-record", consumes: ["open"], may_set: ["dismissed"] }),
      S.step("recheck", { deps: ["review"], mode: "headless", output: "review-record", consumes: ["open"], may_set: ["confirmed"] }),
    ]);
    await k.submit(c.ann, `${G}.audit`, rec({ items: [item("A", { title: MK.title, proposal: MK.prop, evidence: [{ path: "src/a.ts", note: MK.note }] }), item("B")] }));
    await k.submit(c.ann, `${G}.review`, rec({ dispositions: [disp(A, "dismissed", { reason: MK.r1 })] }));
    const rc = await k.submit(c.ann, `${G}.recheck`, rec({ dispositions: [disp(A, "confirmed", { reason: MK.r2 }), disp(B, "confirmed", { reason: MK.r3 })] }));
    expect(rc.ignored).toHaveLength(1);
    const all = JSON.stringify(await k.r.allEvents());
    const t = await k.r.w.hub.svc.serviceToken("feed", ["goals:read"]);
    const feed = await k.r.call(t, "GET", "/v1/events?after=0");
    expect(feed.status).toBe(200);
    const files = (await k.r.call(c.ann, "GET", `/v1/goals/${G}/files`)).json.files as { path: string; text: string }[];
    for (const f of files) {
      mkdirSync(join(c.ann.repoDir, f.path, ".."), { recursive: true });
      writeFileSync(join(c.ann.repoDir, f.path), f.text);
    }
    git(c.ann.repoDir, ["add", "-A"]);
    git(c.ann.repoDir, ["commit", "-qm", "records"]);
    const ledger = exportLedger([c.ann.repoDir], undefined).lines.join("\n");
    for (const m of Object.values(MK)) {
      expect(all, m).not.toContain(m);
      expect(JSON.stringify(feed.json), m).not.toContain(m);
      expect(JSON.stringify(files), m).not.toContain(m);
      expect(ledger, m).not.toContain(m);
    }
    // Positive: the events exist and name the fp.
    expect(await ev("review.recorded", `${G}.audit`)).toHaveLength(1);
    const disposed = await ev("item.disposed", `${G}.review`);
    expect(disposed).toHaveLength(1);
    expect(JSON.stringify(disposed)).toContain(A);
    // test_AC24_markers_stored (control: the markers were stored)
    const stored = JSON.stringify((await k.reviews(c.ann, `${G}.audit`)).json) + JSON.stringify(await k.itemOf(c.ann, A));
    for (const m of [MK.title, MK.note, MK.prop, MK.r1]) expect(stored, m).toContain(m);
  });
});

// ---------------------------------------------------------------------------------------------

describe("AC-25 compat", () => {
  it("test_AC25_plain_flow", async () => {
    await start();
    const G = await k.goal(c.ann, [S.step("a"), S.step("b", { kind: "verify", deps: ["a"] })]);
    expect(await k.state(`${G}.b`)).toBe("blocked");
    await k.claim(c.ann, `${G}.a`);
    await k.closeOk(c.ann, `${G}.a`);
    expect(await k.state(`${G}.b`)).toBe("ready");
    await k.reopenVia(c.ann, G, "b", "a");
    expect(await k.state(`${G}.a`)).toBe("ready");
    expect(await k.state(`${G}.b`)).toBe("blocked");
    await k.claim(c.ann, `${G}.a`);
    await k.closeOk(c.ann, `${G}.a`);
    await k.claim(c.ann, `${G}.b`);
    await k.closeOk(c.ann, `${G}.b`);
    expect(await k.goalState(c.ann, G)).toBe("done");
    const types = (await k.r.allEvents()).filter((e) => e.goal === G).map((e) => e.type as string);
    expect(types.filter((t) => t.startsWith("review.") || t.startsWith("item.") || t === "step.skipped")).toStrictEqual([]);
    expect(types.filter((t) => t === "goal.done")).toHaveLength(1);
  });

  it("test_AC25_findings", async () => {
    await start();
    const G = await k.goal(c.ann, [S.step("s")]);
    await k.claim(c.ann, `${G}.s`);
    await k.closeOk(c.ann, `${G}.s`, { verdict: "approved", findings: { new: 2, repeat: 1, regression: 0 } });
    const [r1] = await rounds(`${G}.s`);
    expect(r1.findings).toStrictEqual({ new: 2, repeat: 1, regression: 0 });
    expect(r1).not.toHaveProperty("fold");
    expect(await k.itemsOf(c.ann, `-|${ALPHA}|s`)).toStrictEqual([]);
  });
});

// ---------------------------------------------------------------------------------------------

describe("AC-26 idempotency", () => {
  it("test_AC26_replay_raising", async () => {
    await start();
    const G = await k.goal(c.ann, [S.audit()]);
    await k.claim(c.ann, `${G}.audit`);
    const body = rec({ items: [item("A"), item("B")] });
    const one = await k.review(c.ann, `${G}.audit`, body, "k1");
    const two = await k.review(c.ann, `${G}.audit`, body, "k1");
    expect(one.status).toBe(201);
    expect(two).toStrictEqual(one);
    expect((await k.reviews(c.ann, `${G}.audit`)).json.reviews).toHaveLength(1);
    expect((await k.r.artifactsOf(G, c.ann)).filter((a) => a.kind === "review")).toHaveLength(1);
    for (const f of [A, B]) expect(((await k.itemOf(c.ann, f)).history as Json[]).length, f).toBe(1);
    expect(await ev("review.recorded", `${G}.audit`)).toHaveLength(1);
    // test_AC26_other_key: the store guard still holds.
    expect((await k.review(c.ann, `${G}.audit`, body, "k2")).status).toBe(409);
  });

  it("test_AC26_replay_consuming", async () => {
    await start();
    const G = await k.goal(c.ann, [S.audit(), S.validate()]);
    await k.submit(c.ann, `${G}.audit`, rec({ items: [item("A"), item("B")] }));
    await k.claim(c.ann, `${G}.validate`);
    const body = rec({ dispositions: [disp(A, "confirmed"), disp(B, "dismissed")] });
    const one = await k.review(c.ann, `${G}.validate`, body, "kc");
    const two = await k.review(c.ann, `${G}.validate`, body, "kc");
    expect(one.status).toBe(201);
    expect(two).toStrictEqual(one);
    expect(await ev("item.disposed", `${G}.validate`)).toHaveLength(2);
    expect(((await k.itemOf(c.ann, A)).history as Json[]).filter((e) => e.kind === "disposition")).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------------------------

describe("AC-27 concurrency", () => {
  it("test_AC27_same_round", async () => {
    await start();
    const G = await k.goal(c.ann, [S.audit()]);
    await k.claim(c.ann, `${G}.audit`);
    const [x, y] = await Promise.all([k.review(c.ann, `${G}.audit`, rec({ items: [item("A")] })), k.review(c.ann, `${G}.audit`, rec({ items: [item("B")] }))]);
    expect([x.status, y.status].sort()).toStrictEqual([201, 409]);
    const won = x.status === 201 ? A : B;
    const lost = won === A ? B : A;
    expect(((await k.itemOf(c.ann, won)).history as Json[]).length).toBe(1);
    expect((await k.itemsOf(c.ann)).filter((i) => i.fp === lost)).toStrictEqual([]);
    expect((await k.reviews(c.ann, `${G}.audit`)).json.reviews).toHaveLength(1);
  });

  it("test_AC27_two_goals", async () => {
    await start();
    for (let i = 0; i < 10; i++) {
      const steps = [S.audit({ agent: `aud${i}` })];
      const G1 = await k.goal(c.ann, steps);
      const G2 = await k.goal(c.ann, steps);
      await k.claim(c.ann, `${G1}.audit`);
      await k.claim(c.ann, `${G2}.audit`);
      const [x, y] = await Promise.all([k.review(c.ann, `${G1}.audit`, rec({ items: [item("A")] })), k.review(c.ann, `${G2}.audit`, rec({ items: [item("A")] }))]);
      expect([x.status, y.status], `iteration ${i}`).toStrictEqual([201, 201]);
      const marks = [k.markOf(x.json, A), k.markOf(y.json, A)].sort();
      expect(marks, `iteration ${i}`).toStrictEqual(["new", "repeat"]);
      expect(x.json.review.fold.new + y.json.review.fold.new).toBe(1);
    }
  });
});

// ---------------------------------------------------------------------------------------------

describe("AC-29 retention", () => {
  it("test_AC29_prune_keeps_record", async () => {
    await start({ hubYaml: { artifacts: { retention_days: 30 } } });
    const T0 = k.r.w.clock;
    const G1 = await k.goal(c.ann, [S.audit()]);
    const a = await k.submit(c.ann, `${G1}.audit`, rec({ items: [item("A")] }));
    expect(await k.goalState(c.ann, G1)).toBe("done");
    k.r.w.clock = T0 + 31 * DAY_MS;
    await k.r.w.tick();
    // A login made at the new clock (the first ones have expired).
    const t = (await k.r.w.login("ann", { hostname: "ann-later" })).token;
    const art = await k.r.call(t, "GET", `/v1/artifacts/${a.review.artifact}`);
    expect(art.status).toBe(200);
    expect(art.json.content).toBeNull();
    expect(art.json.artifact.prunedAt).toBe(T0 + 31 * DAY_MS);
    const rs = (await k.reviews(t, `${G1}.audit`)).json.reviews as Json[];
    expect(rs).toHaveLength(1);
    expect(rs[0].record).toStrictEqual(a.review.record);
    expect((await k.itemOf(t, A)).state).toBe("open");
    const G2 = await k.goal(t, [S.audit({ inputs: ["previous"] })]);
    await k.claim(t, `${G2}.audit`);
    const ins = (await k.ctx(t, `${G2}.audit`)).inputs as Json[];
    expect(ins).toHaveLength(1);
    expect(ins[0].content).toBe(JSON.stringify(a.review.record));
  });
});
