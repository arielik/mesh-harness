// RL-4 hub side end to end (World): never offered, assignee-only claim, pre-read, the debrief view and
// list, dispositions one at a time, revert, the debrief's own review record, person precedence,
// context inputs, privacy of events and exports, idempotency, compatibility and the long-held list.
// Criteria AC-01 (route), AC-03 to AC-07, AC-09 (route), AC-10 to AC-14, AC-21, AC-22, AC-25 (World).
// Written from the spec's contracts only (docs/specs/RL-4.md). Steps by id, items by fp, events by
// type + step; fingerprints from the test-side formula.

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { exportLedger } from "../src/cli/ledger.ts";
import type { Session } from "../src/protocol/index.ts";
import { A, B, C, dispositionsOf, Dk, IA, IB, IC, NOT_YOURS, PROBLEMS, REPO, S, TITLE, type Ids } from "./helpers/debrief-kit.ts";
import { DAY, git, MIN } from "./helpers/relay-kit.ts";
import { disp, E1, fp, item, rec } from "./helpers/review-kit.ts";
import type { Json } from "./helpers/world.ts";

let k: Dk;
afterEach(async () => {
  await k?.r.stop();
});

async function start(o: { clock?: number; hubYaml?: Record<string, unknown> } = {}): Promise<Dk> {
  k = await Dk.start(o);
  return k;
}
/** A fresh World with the relay fixture; audit done (A, B, C) unless `audit: false`. */
async function fixture(o: { debrief?: Record<string, unknown>; extra?: unknown[]; audit?: boolean; items?: unknown[]; report?: string | string[]; hubYaml?: Record<string, unknown> } = {}): Promise<Ids> {
  await start(o.hubYaml ? { hubYaml: o.hubYaml } : {});
  const ids = await k.relay({ ...(o.debrief ? { debrief: o.debrief } : {}), ...(o.extra ? { extra: o.extra as never } : {}) });
  if (o.audit !== false) await k.auditDone(ids, o.items, o.report !== undefined ? { report: o.report } : {});
  return ids;
}
const rounds = async (id: string): Promise<Json[]> => ((await k.step(id)).rounds ?? []) as Json[];
const offered = async (id: string) => (await k.ev("step.offered", id)).length;
const offerMsgs = async (id: string) => (await k.r.inboxOf(k.c.bob)).filter((m) => m.kind === "offer" && m.data?.step === id);
const readyIds = async (q = "") => ((await k.call(k.c.alice, "GET", `/v1/steps?ready=1${q}`)).json.steps as Json[]).map((s) => s.id as string);
/** A goal (same lineage) whose consuming stage `v` dismisses `dismiss` after audit raised A, B, C. */
async function earlierDismissal(dismiss: string): Promise<string> {
  const G = await k.goal(k.c.alice, [S.audit(), S.step("v", { deps: ["audit"], output: "review-record", consumes: ["open"], may_set: ["confirmed", "dismissed"] })]);
  await k.auditDone({ G, AU: `${G}.audit`, D: "", F: "" });
  await k.claim(k.c.alice, `${G}.v`);
  await k.reviewOk(k.c.alice, `${G}.v`, rec({ dispositions: [disp(dismiss, "dismissed")] }));
  await k.doneOk(k.c.alice, `${G}.v`);
  return G;
}
const reopen = async (G: string, check: string, target: string) => {
  await k.claim(k.c.alice, `${G}.${check}`);
  const f = await k.r.act(k.c.alice, `${G}.${check}`, "done", { outcome: "fail", summary: `reopen ${target}`, reopen: [target] });
  expect(f.status, JSON.stringify(f.json)).toBe(200);
};
const NOT_DEBRIEF = (id: string) => `${id} is not a debrief step`;
const NOT_DEBRIEF_DISPOSE = (id: string) => `${id} is not a debrief step; a stage records its dispositions in its review record (mesh_review)`;

// ---------------------------------------------------------------------------------------------

describe("AC-01 read route (World)", () => {
  it("test_AC01_read_route_400", async () => {
    const { D } = await fixture();
    const bad = await k.route(k.c.alice, D, "read", { x: 1 });
    expect(bad.status, JSON.stringify(bad.json)).toBe(400);
    expect(await k.step(D)).not.toHaveProperty("read");
    // Control: an empty body is accepted.
    expect((await k.route(k.c.alice, D, "read", {})).status).toBe(200);
  });
});

// ---------------------------------------------------------------------------------------------

describe("AC-03 never offered", () => {
  it("test_AC03_assign_409", async () => {
    const { D, G } = await fixture({ extra: [S.step("side")] });
    expect(await k.r.assign(k.c.alice, D, { to: k.w.machineOf(k.c.bob) })).toStrictEqual({ status: 409, json: { error: `${D} is a debrief step: only alice runs it (mesh debrief ${D})` } });
    expect(await offered(D)).toBe(0);
    expect(await offerMsgs(D)).toStrictEqual([]);
    expect((await k.step(D)).offer).toBeUndefined();
    // Control: a ready interactive sibling is offered the same way.
    const side = await k.r.assign(k.c.alice, `${G}.side`, { to: k.w.machineOf(k.c.bob) });
    expect(side.status, JSON.stringify(side.json)).toBe(200);
    expect(await offered(`${G}.side`)).toBe(1);
  });

  it("test_AC03_assign_checks_order", async () => {
    const { D } = await fixture({ audit: false });
    expect((await k.step(D)).state).toBe("blocked");
    const res = await k.r.assign(k.c.alice, D, { to: k.w.machineOf(k.c.bob) });
    expect(res.status).toBe(409);
    expect(res.json.error).not.toContain("is a debrief step");
    expect(res.json.error).toContain(D);
  });

  it("test_AC03_goal_assign_only_debrief", async () => {
    const { G, D } = await fixture();
    expect((await k.step(D)).state).toBe("ready");
    expect(await k.call(k.c.alice, "POST", `/v1/goals/${G}/assign`, { to: k.w.machineOf(k.c.bob) })).toStrictEqual({ status: 409, json: { error: `${G} has no ready step to offer` } });
    expect(await offered(D)).toBe(0);
    // Control: with an interactive step ready too, goal assign offers that one only.
    const H = await k.goal(k.c.alice, [S.audit(), S.debrief(), S.file(), S.step("side", { deps: ["audit"] })]);
    await k.auditDone({ G: H, AU: `${H}.audit`, D: `${H}.debrief`, F: `${H}.file` });
    const ga = await k.call(k.c.alice, "POST", `/v1/goals/${H}/assign`, { to: k.w.machineOf(k.c.bob) });
    expect(ga.status, JSON.stringify(ga.json)).toBe(200);
    expect(await offered(`${H}.side`)).toBe(1);
    expect(await offered(`${H}.debrief`)).toBe(0);
    expect(await offerMsgs(`${H}.debrief`)).toStrictEqual([]);
  });

  it("test_AC03_stick_no_offer", async () => {
    await start();
    const G = await k.goal(k.c.alice, []);
    const st = await k.call(k.c.alice, "POST", `/v1/goals/${G}/assign`, { to: k.w.machineOf(k.c.bob), stick: true });
    expect(st.status, JSON.stringify(st.json)).toBe(200);
    // audit is interactive here, so the stick may offer it; alice (the offerer) claims it anyway.
    const p = await k.r.plan(k.c.alice, G, [S.audit({ mode: "interactive", agent: undefined }), S.debrief(), S.file(), S.step("side", { deps: ["audit"] })]);
    expect(p.status, JSON.stringify(p.json)).toBe(201);
    await k.auditDone({ G, AU: `${G}.audit`, D: `${G}.debrief`, F: `${G}.file` });
    await k.w.flush();
    expect((await k.step(`${G}.debrief`)).state).toBe("ready");
    expect(await offered(`${G}.debrief`)).toBe(0);
    expect(await offerMsgs(`${G}.debrief`)).toStrictEqual([]);
    expect((await k.step(`${G}.debrief`)).offer).toBeUndefined();
    // Control: side, ready at the same time, is offered through the same stick.
    expect(await offered(`${G}.side`)).toBe(1);
    expect(await offerMsgs(`${G}.side`)).toHaveLength(1);
  });

  it("test_AC03_ready_list", async () => {
    const { D, G } = await fixture({ extra: [S.step("side")] });
    for (const q of ["", `&repo=${REPO}`]) {
      const ids = await readyIds(q);
      expect(ids, q).toContain(`${G}.side`);
      expect(ids, q).not.toContain(D);
    }
    await k.w.hook(k.c.alice, "SessionStart", 77);
    const next = await k.w.tool(k.c.alice, 77, "mesh_next");
    expect(next.text).toContain(`${G}.side`);
    expect(next.text).not.toContain(D);
  });

  it("test_AC03_tui_n_never_claims", async () => {
    const { D } = await fixture();
    await k.w.hook(k.c.alice, "SessionStart", 78);
    await k.w.flush();
    const sid = k.w.session(k.c.alice, 78).sid;
    await k.r.local(k.c.alice, "POST", "/local/next", { target: sid });
    const d = await k.step(D);
    expect(d.state).toBe("ready");
    expect(d).not.toHaveProperty("holderUser");
    // Control: with an interactive step ready, the same call claims it.
    const H = await k.goal(k.c.alice, [S.step("side")]);
    const n = await k.r.local(k.c.alice, "POST", "/local/next", { target: sid });
    expect(n.status, JSON.stringify(n.json)).toBe(200);
    await k.w.flush();
    expect((await k.step(`${H}.side`)).state).toBe("claimed");
    expect((await k.step(D)).state).toBe("ready");
  });
});

// ---------------------------------------------------------------------------------------------

describe("AC-04 claim", () => {
  it("test_AC04_admin_refused", async () => {
    const { D } = await fixture();
    expect(await k.r.act(k.c.bob, D, "claim", {})).toStrictEqual({ status: 403, json: { error: NOT_YOURS(D, "alice") } });
    expect(await k.r.act(k.c.bob, D, "take", {})).toStrictEqual({ status: 403, json: { error: NOT_YOURS(D, "alice") } });
    const d = await k.step(D);
    expect(d.state).toBe("ready");
    expect(d).not.toHaveProperty("holderUser");
    expect(await k.ev("step.claimed", D)).toHaveLength(0);
    // Control: the assignee claims it.
    expect((await k.r.act(k.c.alice, D, "claim", {})).status).toBe(200);
    expect(await k.step(D)).toMatchObject({ state: "claimed", holderUser: "alice" });
  });

  it("test_AC04_take_from_holder", async () => {
    // Device tokens outlive the 10-day jump, so the kit's own logins (used by k.step) stay valid.
    const { D } = await fixture({ hubYaml: { auth: { session: { device_max_age: "60d", device_idle: "30d" } } } });
    await k.claim(k.c.alice, D);
    k.w.clock += 10 * DAY;
    // A login made at the new clock (in case the first ones expired).
    const bob = (await k.w.login("bob", { hostname: "bob-later" })).token;
    expect(await k.r.act(bob, D, "take", {})).toStrictEqual({ status: 403, json: { error: NOT_YOURS(D, "alice") } });
    expect((await k.step(D)).holderUser).toBe("alice");
  });

  it("test_AC04_named_assignee", async () => {
    const { D } = await fixture({ debrief: { assignee: "bob" } });
    expect(await k.r.act(k.c.alice, D, "claim", {})).toStrictEqual({ status: 403, json: { error: NOT_YOURS(D, "bob") } });
    expect((await k.step(D)).state).toBe("ready");
    expect((await k.r.act(k.c.bob, D, "claim", {})).status).toBe(200);
    expect(await k.step(D)).toMatchObject({ state: "claimed", holderUser: "bob" });
  });

  it("test_AC04_owner_resolved_at_claim", async () => {
    const { G, D } = await fixture();
    const g = await k.w.hubStore.getGoal(G);
    await k.w.hubStore.saveGoal({ ...(g as object), ownerId: "carol" } as never);
    expect(await k.r.act(k.c.alice, D, "claim", {})).toStrictEqual({ status: 403, json: { error: NOT_YOURS(D, "carol") } });
    const cl = await k.r.act(k.c.carol, D, "claim", {});
    expect(cl.status, JSON.stringify(cl.json)).toBe(200);
    expect(await k.step(D)).toMatchObject({ state: "claimed", holderUser: "carol" });
  });

  it("test_AC04_accept_open_offer", async () => {
    await start();
    const v1 = [S.audit(), S.step("x", { deps: ["audit"] }), S.step("check", { kind: "verify", deps: ["x"] })];
    const G = await k.goal(k.c.alice, v1);
    const x = `${G}.x`;
    await k.auditDone({ G, AU: `${G}.audit`, D: x, F: "" });
    expect((await k.step(x)).state).toBe("ready");
    const off = await k.r.assign(k.c.alice, x, { to: k.w.machineOf(k.c.bob) });
    expect(off.status, JSON.stringify(off.json)).toBe(200);
    expect((await k.step(x)).offer?.state).toBe("offered");
    const rp = await k.call(k.c.alice, "POST", `/v1/goals/${G}/replan`, { comment: "make x a debrief" });
    expect(rp.status, JSON.stringify(rp.json)).toBe(200);
    const v2 = [S.audit(), S.step("x", { kind: "review", deps: ["audit"], mode: "debrief", output: "review-record", may_set: ["accepted", "dismissed"] }), S.step("check", { kind: "verify", deps: ["x"] })];
    const p = await k.r.plan(k.c.alice, G, v2);
    expect(p.status, JSON.stringify(p.json)).toBe(201);
    const before = await k.step(x);
    expect(before.policy.mode).toBe("debrief");
    const acc = await k.r.act(k.c.bob, x, "accept", {});
    expect(acc).toStrictEqual({ status: 403, json: { error: NOT_YOURS(x, "alice") } });
    const after = await k.step(x);
    expect(after.state).toBe(before.state);
    expect(after).not.toHaveProperty("holderUser");
    // Control: alice (the assignee) is not refused by the assignee check.
    const mine = await k.r.act(k.c.alice, x, "accept", {});
    expect(JSON.stringify(mine.json)).not.toContain("is a debrief for");
  });
});

// ---------------------------------------------------------------------------------------------

describe("AC-05 read", () => {
  it("test_AC05_read_by_assignee", async () => {
    const { D, G } = await fixture();
    const t0 = k.w.clock;
    expect(await k.route(k.c.alice, D, "read", {})).toStrictEqual({ status: 200, json: { read: { user: "alice", at: t0, round: 1 } } });
    expect((await k.step(D)).read).toStrictEqual({ user: "alice", at: t0, round: 1 });
    const es = await k.ev("step.read", D);
    expect(es).toHaveLength(1);
    expect(es[0]).toMatchObject({ user: "alice", goal: G, step: D });
    expect(es[0].payload).toStrictEqual({ round: 1 });
    k.w.clock += MIN;
    expect((await k.route(k.c.alice, D, "read", {})).status).toBe(200);
    expect((await k.step(D)).read).toStrictEqual({ user: "alice", at: t0 + MIN, round: 1 });
  });

  it("test_AC05_read_refusals", async () => {
    const { D, AU, G } = await fixture();
    expect(await k.route(k.c.bob, D, "read", {})).toStrictEqual({ status: 403, json: { error: NOT_YOURS(D, "alice") } });
    expect(await k.route(k.c.alice, AU, "read", {})).toStrictEqual({ status: 409, json: { error: NOT_DEBRIEF(AU) } });
    expect(await k.route(k.c.alice, `${G}.nope`, "read", {})).toStrictEqual({ status: 404, json: { error: `no step ${G}.nope` } });
    const H = await k.relay();
    expect(await k.route(k.c.alice, H.D, "read", {})).toStrictEqual({ status: 409, json: { error: `${H.D} is blocked` } });
    expect(await k.step(D)).not.toHaveProperty("read");
    expect(await k.step(H.D)).not.toHaveProperty("read");
    expect(await k.ev("step.read")).toHaveLength(0);
    // Control: the assignee's read of the ready debrief succeeds.
    expect((await k.route(k.c.alice, D, "read", {})).status).toBe(200);
    expect(await k.ev("step.read", D)).toHaveLength(1);
  });

  it("test_AC05_round_read_on_done", async () => {
    const { D } = await fixture();
    expect((await k.route(k.c.alice, D, "read", {})).status).toBe(200);
    const at = (await k.step(D)).read.at;
    await k.claim(k.c.alice, D);
    await k.reviewOk(k.c.alice, D, rec());
    await k.doneOk(k.c.alice, D);
    expect((await rounds(D))[0].read).toStrictEqual({ user: "alice", at });
    // A debrief done without a read has no read on its round.
    const H = await k.relay();
    await k.auditDone(H);
    await k.claim(k.c.alice, H.D);
    await k.reviewOk(k.c.alice, H.D, rec());
    await k.doneOk(k.c.alice, H.D);
    const [r1] = await rounds(H.D);
    expect(r1).toBeDefined();
    expect(r1).not.toHaveProperty("read");
  });

  it("test_AC05_read_other_round", async () => {
    const { G, D } = await fixture({ extra: [S.step("check", { kind: "verify", deps: ["debrief"] })] });
    expect((await k.route(k.c.alice, D, "read", {})).status).toBe(200);
    await k.claim(k.c.alice, D);
    await k.reviewOk(k.c.alice, D, rec());
    await k.doneOk(k.c.alice, D);
    await reopen(G, "check", "debrief");
    expect((await k.step(D)).state).toBe("ready");
    // The list shows the stale read as not read (round 2).
    const s = ((await k.list()).debriefs as Json[]).find((x) => x.step === D);
    expect(s?.read).toBe(false);
    await k.claim(k.c.alice, D);
    await k.reviewOk(k.c.alice, D, rec());
    await k.doneOk(k.c.alice, D);
    const rs = await rounds(D);
    expect(rs).toHaveLength(2);
    expect(rs[0]).toHaveProperty("read");
    expect(rs[1]).not.toHaveProperty("read");
  });
});

// ---------------------------------------------------------------------------------------------

describe("AC-06 view", () => {
  it("test_AC06_view_fields", async () => {
    // C is recorded first, so an order by first.at alone would put it first.
    const { G, D, AU } = await fixture({ items: [IC, IA, IB] });
    const v = await k.viewOk(D);
    expect(v).toMatchObject({ step: D, goal: G, repo: REPO, state: "ready", assignee: "alice", run: AU, lineage: k.lineage, decided: [] });
    expect(typeof v.title).toBe("string");
    expect(k.lineage.length).toBeGreaterThan(0);
    expect(v.report.content).toBe("REPORT-TEXT");
    expect(v.report.artifact.kind).toBe("report");
    expect((v.items as Json[]).map((x) => x.fp)).toStrictEqual([A, B, C]);
    for (const x of v.items as Json[]) expect(x.state, x.fp).toBe("open");
    expect(v.items[0].evidence).toStrictEqual([{ path: "src/a.ts", lines: [3, 5] }]);
    expect(v.items[1].evidence).toStrictEqual([{ path: "src/b.ts", lines: [1, 2] }]);
    expect(JSON.stringify(v)).not.toContain("NOTE-A");
    expect(v).not.toHaveProperty("read");
    // Any member, and a goals:read token, get the same view.
    expect(await k.viewOk(D, k.c.bob)).toStrictEqual(v);
    const t = await k.w.hub.svc.serviceToken("viewer", ["goals:read"]);
    expect(await k.viewOk(D, t)).toStrictEqual(v);
  });

  it("test_AC06_report_latest", async () => {
    const { D } = await fixture({ report: ["R1", "R2"] });
    expect((await k.viewOk(D)).report.content).toBe("R2");
  });

  it("test_AC06_near_matches", async () => {
    const A2i = item("r.alpha", { path: "src/a.ts", symbol: "fb", severity: "S2", title: "A2" });
    const A3i = item("r.alpha", { path: "src/moved.ts", symbol: "fa", severity: "S2", title: "A3" });
    const A4i = item("r.alpha", { path: "src/z.ts", symbol: "fz", severity: "S2", title: "A4" });
    const A5i = item("r.alpha", { path: "src/y.ts", severity: "S2", title: "A5" });
    const A6i = item("r.alpha", { path: "src/w.ts", severity: "S2", title: "A6" });
    const { D } = await fixture({ items: [IA, A2i, A3i, A4i, A5i, A6i] });
    const A2 = fp("r.alpha", "src/a.ts", "fb");
    const A3 = fp("r.alpha", "src/moved.ts", "fa");
    const A5 = fp("r.alpha", "src/y.ts");
    const A6 = fp("r.alpha", "src/w.ts");
    const v = await k.viewOk(D);
    const of = (f: string) => ((v.items as Json[]).find((x) => x.fp === f)?.nearMatches ?? []) as Json[];
    expect(of(A).map((x) => x.fp)).toStrictEqual([A2, A3].sort());
    expect(of(A).find((x) => x.fp === A2)).toStrictEqual({ fp: A2, state: "open", title: "A2", symbol: "fb" });
    expect(of(A).find((x) => x.fp === A3)).toStrictEqual({ fp: A3, state: "open", title: "A3", symbol: "fa" });
    expect(of(A2).map((x) => x.fp)).toStrictEqual([A]);
    expect(of(A3).map((x) => x.fp)).toStrictEqual([A]);
    expect(of(A5)).toStrictEqual([]);
    expect(of(A6)).toStrictEqual([]);
  });

  it("test_AC06_consumed_filter", async () => {
    await start();
    // G1: the debrief view lists A while it is open; then a consuming stage dismisses it.
    const G1 = await k.goal(k.c.alice, [S.audit(), S.debrief(), S.step("v", { deps: ["audit"], output: "review-record", consumes: ["open"], may_set: ["dismissed"] })]);
    await k.auditDone({ G: G1, AU: `${G1}.audit`, D: `${G1}.debrief`, F: "" });
    expect(((await k.viewOk(`${G1}.debrief`)).items as Json[]).map((x) => x.fp)).toContain(A);
    await k.claim(k.c.alice, `${G1}.v`);
    await k.reviewOk(k.c.alice, `${G1}.v`, rec({ dispositions: [disp(A, "dismissed")] }));
    // G2: A is carried dismissed (not consumed by the debrief).
    const ids = await k.relay();
    await k.auditDone(ids);
    expect(await k.state(A)).toBe("dismissed");
    expect(((await k.viewOk(ids.D)).items as Json[]).map((x) => x.fp)).toStrictEqual([B, C]);
  });

  it("test_AC06_errors_and_empty", async () => {
    const { D, AU, G } = await fixture({ audit: false });
    expect(await k.view(AU)).toStrictEqual({ status: 409, json: { error: NOT_DEBRIEF(AU) } });
    expect(await k.view(`${G}.nope`)).toStrictEqual({ status: 404, json: { error: `no step ${G}.nope` } });
    const v = await k.viewOk(D);
    expect(v.items).toStrictEqual([]);
    expect(v.decided).toStrictEqual([]);
    expect(v).not.toHaveProperty("report");
    expect(v.assignee).toBe("alice");
  });
});

// ---------------------------------------------------------------------------------------------

describe("AC-07 list", () => {
  const mine = async (D: string, who = k.c.alice) => ((await k.list(who)).debriefs as Json[]).find((x) => x.step === D);

  it("test_AC07_states", async () => {
    const { G, D } = await fixture({ audit: false });
    expect(await mine(D)).toBeUndefined();
    await k.auditDone({ G, AU: `${G}.audit`, D, F: `${G}.file` });
    expect(await mine(D)).toStrictEqual({ step: D, goal: G, title: (await k.step(D)).title, repo: REPO, state: "ready", items: 3, read: false });
    // bob is not the assignee: his list is empty while alice's is not.
    expect((await k.list(k.c.bob)).debriefs).toStrictEqual([]);
    expect((await k.route(k.c.alice, D, "read", {})).status).toBe(200);
    expect((await mine(D))?.read).toBe(true);
    await k.claim(k.c.alice, D);
    expect((await mine(D))?.state).toBe("claimed");
    await k.patchStep(D, { state: "paused" });
    expect((await mine(D))?.state).toBe("paused");
    await k.patchStep(D, { state: "claimed" });
    await k.reviewOk(k.c.alice, D, rec());
    await k.doneOk(k.c.alice, D);
    expect(await mine(D)).toBeUndefined();
  });

  it("test_AC07_order", async () => {
    await start();
    const one = await k.relay();
    await k.auditDone(one);
    const two = await k.relay();
    await k.auditDone(two);
    const steps = ((await k.list()).debriefs as Json[]).map((x) => x.step as string);
    expect(steps).toStrictEqual([one.D, two.D].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)));
  });

  it("test_AC07_decided", async () => {
    const { D } = await fixture();
    await k.claim(k.c.alice, D);
    expect((await k.disposeRoute(k.c.alice, D, A, "accepted")).status).toBe(201);
    k.w.clock += MIN;
    expect((await k.disposeRoute(k.c.alice, D, B, "dismissed")).status).toBe(201);
    let l = await k.list();
    expect((l.decided as Json[]).map((x) => x.fp)).toStrictEqual([B, A]);
    for (const x of l.decided as Json[]) expect(x).toMatchObject({ title: TITLE[x.fp], revertable: true, via: "debrief-session", step: D, decider: { kind: "person", user: "alice" } });
    expect((await k.list(k.c.bob)).decided).toStrictEqual([]);
    expect((await k.revert(k.c.alice, D, B)).status).toBe(200);
    l = await k.list();
    expect((l.decided as Json[]).map((x) => x.fp)).toStrictEqual([A]);
    k.w.clock += 8 * DAY;
    const later = (await k.w.login("alice", { hostname: "alice-later" })).token;
    expect((await k.list(later)).decided).toStrictEqual([]);
  });

  it("test_AC07_count_items", async () => {
    const { D } = await fixture();
    await k.claim(k.c.alice, D);
    expect((await k.disposeRoute(k.c.alice, D, A, "accepted")).status).toBe(201);
    expect((await mine(D))?.items).toBe(2);
  });
});

// ---------------------------------------------------------------------------------------------

describe("AC-09 errors (route)", () => {
  it("test_AC09_not_held", async () => {
    const { D } = await fixture();
    const before = await k.snapshot(D);
    expect(await k.disposeRoute(k.c.alice, D, A, "accepted")).toStrictEqual({ status: 409, json: { error: `${D} is ready; only a held debrief takes dispositions` } });
    expect(await k.snapshot(D)).toStrictEqual(before);
  });

  it("test_AC09_other_holder", async () => {
    const { D } = await fixture();
    await k.claim(k.c.alice, D);
    const before = await k.snapshot(D);
    expect(await k.disposeRoute(k.c.bob, D, A, "accepted")).toStrictEqual({ status: 403, json: { error: `${D} is held by alice` } });
    expect(await k.snapshot(D)).toStrictEqual(before);
  });

  it("test_AC09_foreign_sid", async () => {
    const { D } = await fixture();
    await k.claim(k.c.alice, D);
    const sb: Session = { sid: "s-bob-x", claudeSessionIds: ["c-bob-x"], cwd: "", kind: "interactive", state: "idle", quiet: false, startedAt: k.w.clock, lastEventAt: k.w.clock, turns: 0, humanPrompts: 0, seenByReconciler: true };
    await k.w.hubStore.upsertSession(sb, "bob", k.w.machineOf(k.c.bob), k.w.clock);
    const before = await k.snapshot(D);
    expect(await k.disposeRoute(k.c.alice, D, A, "accepted", { sid: sb.sid })).toStrictEqual({ status: 403, json: { error: `session ${sb.sid} is not yours on this machine` } });
    expect(await k.snapshot(D)).toStrictEqual(before);
    // Control: without the foreign sid it is recorded.
    expect((await k.disposeRoute(k.c.alice, D, A, "accepted")).status).toBe(201);
  });

  it("test_AC09_after_record", async () => {
    const { D } = await fixture();
    await k.claim(k.c.alice, D);
    await k.reviewOk(k.c.alice, D, rec());
    const before = await k.snapshot(D);
    expect(await k.disposeRoute(k.c.alice, D, A, "accepted")).toStrictEqual({ status: 409, json: { error: `${D} round 1 already has a review record` } });
    expect(await k.snapshot(D)).toStrictEqual(before);
  });

  it("test_AC09_rl2_checks", async () => {
    await start();
    await earlierDismissal(A);
    const ids = await k.relay({ debrief: { may_set: ["accepted", "deferred"] } });
    await k.auditDone(ids);
    const { D, AU } = ids;
    expect(await k.state(A)).toBe("dismissed");
    await k.claim(k.c.alice, D);
    const before = await k.snapshot(D);
    const NONE = fp("r.none");
    const cases: [string, string, Record<string, unknown>, string][] = [
      [B, "dismissed", {}, `${D} may not set dismissed (may_set: accepted, deferred)`],
      [B, "deferred", {}, "deferred needs until (YYYY-MM-DD)"],
      [NONE, "accepted", {}, `no item ${NONE} in the record of ${AU}`],
      [A, "accepted", {}, `item ${A} is dismissed; ${D} acts on open, confirmed`],
    ];
    for (const [f, d, extra, text] of cases) {
      const res = await k.disposeRoute(k.c.alice, D, f, d, extra);
      expect(res.status, text).toBe(422);
      expect(res.json.error, text).toBe(text);
    }
    expect(await k.snapshot(D)).toStrictEqual(before);
    // Control: a valid decision on B is recorded.
    expect((await k.disposeRoute(k.c.alice, D, B, "deferred", { until: "2026-12-01" })).status).toBe(201);
  });

  it("test_AC09_order", async () => {
    const { D, AU, G } = await fixture({ debrief: { may_set: ["accepted", "deferred"] } });
    // Not a debrief (and not held) → the not-debrief text.
    expect(await k.disposeRoute(k.c.alice, AU, A, "accepted")).toStrictEqual({ status: 409, json: { error: NOT_DEBRIEF_DISPOSE(AU) } });
    // Unknown step first of all.
    expect((await k.disposeRoute(k.c.alice, `${G}.nope`, A, "accepted")).status).toBe(404);
    // Ready D posted by bob (not the holder either) → the state text.
    expect(await k.disposeRoute(k.c.bob, D, A, "accepted")).toStrictEqual({ status: 409, json: { error: `${D} is ready; only a held debrief takes dispositions` } });
    await k.claim(k.c.alice, D);
    // Held by alice; bob with a foreign sid → the holder text.
    const sa: Session = { sid: "s-alice-x", claudeSessionIds: ["c-alice-x"], cwd: "", kind: "interactive", state: "idle", quiet: false, startedAt: k.w.clock, lastEventAt: k.w.clock, turns: 0, humanPrompts: 0, seenByReconciler: true };
    await k.w.hubStore.upsertSession(sa, "alice", k.w.machineOf(k.c.alice), k.w.clock);
    expect(await k.disposeRoute(k.c.bob, D, A, "accepted", { sid: sa.sid })).toStrictEqual({ status: 403, json: { error: `${D} is held by alice` } });
    // Bad may_set + unknown fp → the may_set text (check 1 before 2).
    const NONE = fp("r.none");
    expect((await k.disposeRoute(k.c.alice, D, NONE, "dismissed")).json.error).toBe(`${D} may not set dismissed (may_set: accepted, deferred)`);
    // Record present + bad may_set → the record text.
    await k.reviewOk(k.c.alice, D, rec());
    expect(await k.disposeRoute(k.c.alice, D, A, "dismissed")).toStrictEqual({ status: 409, json: { error: `${D} round 1 already has a review record` } });
  });

  it("test_AC09_change_of_mind", async () => {
    const { G, D } = await fixture({ extra: [S.step("check", { kind: "verify", deps: ["debrief"] })] });
    await k.claim(k.c.alice, D);
    const one = await k.disposeRoute(k.c.alice, D, A, "accepted");
    expect(one.status, JSON.stringify(one.json)).toBe(201);
    const two = await k.disposeRoute(k.c.alice, D, A, "dismissed");
    expect(two.status, JSON.stringify(two.json)).toBe(201);
    expect(two.json.disposition).toMatchObject({ fp: A, disposition: "dismissed", from: "accepted", round: 1 });
    expect(await k.state(A)).toBe("dismissed");
    // Control: in round 2 a round-1 decision is not this round's: B accepted in round 1 is refused.
    expect((await k.disposeRoute(k.c.alice, D, B, "accepted")).status).toBe(201);
    await k.reviewOk(k.c.alice, D, rec());
    await k.doneOk(k.c.alice, D);
    await reopen(G, "check", "debrief");
    await k.claim(k.c.alice, D);
    const r2 = await k.disposeRoute(k.c.alice, D, B, "dismissed");
    expect(r2).toStrictEqual({ status: 422, json: { error: `item ${B} is accepted; ${D} acts on open, confirmed` } });
  });
});

// ---------------------------------------------------------------------------------------------

describe("AC-10 record", () => {
  const SESSION = (f: string, d: string) => `disposition of ${f}: ${f} was decided in this debrief as ${d}; list that decision or leave it out`;

  it("test_AC10a_conflict_422", async () => {
    const { D } = await fixture();
    await k.claim(k.c.alice, D);
    expect((await k.disposeRoute(k.c.alice, D, A, "accepted")).status).toBe(201);
    expect((await k.disposeRoute(k.c.alice, D, B, "dismissed")).status).toBe(201);
    const before = await k.snapshot(D);
    const res = await k.review(k.c.alice, D, rec({ dispositions: [disp(A, "accepted"), disp(B, "accepted")] }));
    expect(res.status, JSON.stringify(res.json)).toBe(422);
    expect(res.json.error).toBe(PROBLEMS([SESSION(B, "dismissed")]));
    expect(await k.snapshot(D)).toStrictEqual(before);
    expect(await k.reviews(D)).toStrictEqual([]);
  });

  it("test_AC10b_already_and_done", async () => {
    const { D, F } = await fixture();
    await k.claim(k.c.alice, D);
    expect((await k.disposeRoute(k.c.alice, D, A, "accepted")).status).toBe(201);
    expect((await k.disposeRoute(k.c.alice, D, B, "dismissed")).status).toBe(201);
    const res = await k.reviewOk(k.c.alice, D, rec({ dispositions: [disp(A, "accepted"), disp(C, "deferred", { until: "2026-12-01", reason: "R-later" })] }));
    expect(res.already).toStrictEqual([A]);
    expect(res.ignored).toStrictEqual([]);
    expect(await k.state(C)).toBe("deferred");
    const cRow = dispositionsOf(await k.history(C)).at(-1);
    expect(cRow).toMatchObject({ disposition: "deferred", via: "debrief-session", decider: { kind: "person", user: "alice" }, step: D, round: 1 });
    expect(cRow).not.toHaveProperty("answer");
    expect(await k.notes(D)).toContain(`debrief: deferred ${C} "${TITLE[C]}": R-later`);
    expect(dispositionsOf(await k.history(A))).toHaveLength(1);
    const recd = await k.ev("review.recorded", D);
    expect(recd).toHaveLength(1);
    expect(recd[0].payload.already).toBe(1);
    expect((await k.reviews(D))[0].decider).toStrictEqual({ kind: "person", user: "alice" });
    await k.doneOk(k.c.alice, D);
    expect((await k.step(D)).state).toBe("done");
    expect((await k.step(F)).state).toBe("ready");
  });

  it("test_AC10c_revert_survives", async () => {
    const { D } = await fixture();
    await k.claim(k.c.alice, D);
    expect((await k.disposeRoute(k.c.alice, D, A, "accepted")).status).toBe(201);
    expect((await k.revert(k.c.alice, D, A)).status).toBe(200);
    const h = await k.history(A);
    expect(h.at(-1)?.kind).toBe("revert");
    const res = await k.reviewOk(k.c.alice, D, rec({ dispositions: [disp(A, "accepted")] }));
    expect(res.already).toStrictEqual([A]);
    expect(await k.state(A)).toBe("open");
    expect(await k.history(A)).toStrictEqual(h);
  });

  it("test_AC10d_change_of_mind", async () => {
    const { D } = await fixture();
    await k.claim(k.c.alice, D);
    expect((await k.disposeRoute(k.c.alice, D, A, "accepted")).status).toBe(201);
    expect((await k.disposeRoute(k.c.alice, D, A, "dismissed")).status).toBe(201);
    const bad = await k.review(k.c.alice, D, rec({ dispositions: [disp(A, "accepted")] }));
    expect(bad.status).toBe(422);
    expect(bad.json.error).toBe(PROBLEMS([SESSION(A, "dismissed")]));
    const twice = await k.review(k.c.alice, D, rec({ dispositions: [disp(A, "dismissed"), disp(A, "dismissed")] }));
    expect(twice.status).toBe(422);
    expect(twice.json.error).toBe(PROBLEMS([`disposition of ${A}: listed twice`]));
    const res = await k.reviewOk(k.c.alice, D, rec({ dispositions: [disp(A, "dismissed")] }));
    expect(res.already).toStrictEqual([A]);
    expect(await k.state(A)).toBe("dismissed");
    expect(dispositionsOf(await k.history(A))).toHaveLength(2);
  });

  it("test_AC10e_empty", async () => {
    const { D } = await fixture();
    await k.claim(k.c.alice, D);
    const res = await k.reviewOk(k.c.alice, D, rec());
    expect(res.already).toStrictEqual([]);
  });

  it("test_AC10f_admin_not_holder", async () => {
    const { D, G } = await fixture({ extra: [S.step("rv", { deps: ["audit"], output: "review-record", consumes: ["open"], may_set: ["confirmed"] })] });
    await k.claim(k.c.alice, D);
    expect(await k.review(k.c.bob, D, rec())).toStrictEqual({ status: 403, json: { error: `${D} is held by alice` } });
    expect(await k.reviews(D)).toStrictEqual([]);
    // Control: on an ordinary review step held by alice, the admin's record is accepted (RL-2).
    await k.claim(k.c.alice, `${G}.rv`);
    expect((await k.review(k.c.bob, `${G}.rv`, rec())).status).toBe(201);
  });
});

// ---------------------------------------------------------------------------------------------

describe("AC-11 revert", () => {
  it("test_AC11_revert_accept", async () => {
    const { D, G } = await fixture();
    await k.claim(k.c.alice, D);
    const d = await k.disposeRoute(k.c.alice, D, A, "accepted");
    expect(d.status, JSON.stringify(d.json)).toBe(201);
    const rv = await k.revert(k.c.alice, D, A);
    expect(rv.status, JSON.stringify(rv.json)).toBe(200);
    expect(await k.state(A)).toBe("open");
    expect(rv.json.item).toMatchObject({ fp: A, state: "open" });
    expect((await k.history(A)).at(-1)).toMatchObject({ kind: "revert", disposition: "accepted", from: "accepted", to: "open", via: "ui", decider: { kind: "person", user: "alice" }, goal: G, step: D, round: 1 });
    expect(await k.notes(D)).toContain(`debrief: reverted ${A} to open (was accepted)`);
    const es = await k.ev("item.reverted", D);
    expect(es).toHaveLength(1);
    expect(es[0]).toMatchObject({ user: "alice", goal: G, step: D });
    expect(es[0].payload).toStrictEqual({ lineage: k.lineage, fp: A, from: "accepted", to: "open", round: 1, via: "ui" });
    expect(rv.json.reverted).toStrictEqual(d.json.disposition);
    expect(typeof rv.json.note.text).toBe("string");
  });

  it("test_AC11_revert_dismissal", async () => {
    await start();
    const G0 = await k.goal(k.c.alice, [
      S.audit(),
      S.step("v", { deps: ["audit"], mode: "headless", output: "review-record", consumes: ["open"], may_set: ["confirmed"] }),
      S.debrief({ deps: ["v"] }),
      S.file(),
    ]);
    const ids = { G: G0, AU: `${G0}.audit`, D: `${G0}.debrief`, F: `${G0}.file` };
    await k.auditDone(ids, [{ ...IA, eh: E1 }, IB, IC]);
    await k.claim(k.c.alice, `${ids.G}.v`);
    await k.reviewOk(k.c.alice, `${ids.G}.v`, rec({ dispositions: [disp(A, "confirmed")] }));
    await k.doneOk(k.c.alice, `${ids.G}.v`);
    const D = ids.D;
    await k.claim(k.c.alice, D);
    expect((await k.disposeRoute(k.c.alice, D, A, "dismissed")).status).toBe(201);
    expect(await k.item(A)).toMatchObject({ state: "dismissed", dismissedEh: E1 });
    expect((await k.revert(k.c.alice, D, A)).status).toBe(200);
    const a = await k.item(A);
    expect(a.state).toBe("confirmed");
    expect(a).not.toHaveProperty("dismissedEh");
    expect(a).not.toHaveProperty("until");
    // A deferral reverted to open keeps no until.
    expect((await k.disposeRoute(k.c.alice, D, B, "deferred", { until: "2026-12-01" })).status).toBe(201);
    expect((await k.item(B)).until).toBe("2026-12-01");
    expect((await k.revert(k.c.alice, D, B)).status).toBe(200);
    const b = await k.item(B);
    expect(b.state).toBe("open");
    expect(b).not.toHaveProperty("until");
  });

  it("test_AC11_who", async () => {
    const { D } = await fixture();
    await k.claim(k.c.alice, D);
    expect((await k.disposeRoute(k.c.alice, D, A, "accepted")).status).toBe(201);
    expect(await k.revert(k.c.dave, D, A)).toStrictEqual({ status: 403, json: { error: "only alice, the goal owner or an admin can revert this" } });
    expect(await k.state(A)).toBe("accepted");
    expect((await k.revert(k.c.bob, D, A)).status).toBe(200);
    expect(await k.state(A)).toBe("open");
    // The goal owner may revert a decision of the assignee.
    const H = await k.relay({ debrief: { assignee: "carol" } });
    await k.auditDone(H);
    await k.claim(k.c.carol, H.D);
    expect((await k.disposeRoute(k.c.carol, H.D, B, "dismissed")).status).toBe(201);
    expect((await k.revert(k.c.alice, H.D, B)).status).toBe(200);
    expect(await k.state(B)).toBe("open");
  });

  it("test_AC11_not_revertable", async () => {
    const { D, AU } = await fixture();
    await k.claim(k.c.alice, D);
    expect((await k.disposeRoute(k.c.alice, D, A, "accepted")).status).toBe(201);
    expect((await k.revert(k.c.alice, D, A)).status).toBe(200);
    expect(await k.revert(k.c.alice, D, A)).toStrictEqual({ status: 409, json: { error: `${A} changed after the debrief decided it; nothing to revert` } });
    expect(await k.revert(k.c.alice, D, C)).toStrictEqual({ status: 404, json: { error: `${D} has no debrief disposition of ${C}` } });
    expect(await k.revert(k.c.alice, AU, A)).toStrictEqual({ status: 409, json: { error: NOT_DEBRIEF(AU) } });
    // A later fold of B (next goal of the lineage) makes B's decision not revertable.
    expect((await k.disposeRoute(k.c.alice, D, B, "accepted")).status).toBe(201);
    const H = await k.relay();
    await k.auditDone(H);
    expect((await k.history(B)).at(-1)?.kind).toBe("fold");
    expect(await k.revert(k.c.alice, D, B)).toStrictEqual({ status: 409, json: { error: `${B} changed after the debrief decided it; nothing to revert` } });
    expect(await k.state(B)).toBe("accepted");
  });

  it("test_AC11_done_debrief", async () => {
    const { D } = await fixture();
    await k.claim(k.c.alice, D);
    expect((await k.disposeRoute(k.c.alice, D, A, "accepted")).status).toBe(201);
    await k.reviewOk(k.c.alice, D, rec());
    await k.doneOk(k.c.alice, D);
    expect((await k.step(D)).state).toBe("done");
    expect((await k.revert(k.c.alice, D, A)).status).toBe(200);
    expect(await k.state(A)).toBe("open");
  });
});

// ---------------------------------------------------------------------------------------------

describe("AC-12 person precedence", () => {
  it("test_AC12_agent_ignored", async () => {
    const { D, G } = await fixture({ extra: [S.step("recheck", { deps: ["debrief"], mode: "headless", output: "review-record", consumes: ["open"], may_set: ["confirmed", "dismissed"] })] });
    await k.claim(k.c.alice, D);
    expect((await k.disposeRoute(k.c.alice, D, A, "dismissed")).status).toBe(201);
    await k.reviewOk(k.c.alice, D, rec());
    await k.doneOk(k.c.alice, D);
    await k.claim(k.c.alice, `${G}.recheck`);
    const res = await k.reviewOk(k.c.alice, `${G}.recheck`, rec({ dispositions: [disp(A, "confirmed"), disp(B, "confirmed")] }));
    expect(res.ignored).toStrictEqual([{ fingerprint: A, reason: "decided by alice in this goal" }]);
    expect(await k.state(A)).toBe("dismissed");
    expect(await k.state(B)).toBe("confirmed");
  });
});

// ---------------------------------------------------------------------------------------------

describe("AC-13 context inputs", () => {
  it("test_AC13_inputs", async () => {
    const { D, AU } = await fixture();
    await k.claim(k.c.alice, D);
    const ctx = async () => {
      const c = await k.call(k.c.alice, "GET", `/v1/steps/${D}/context`);
      expect(c.status, JSON.stringify(c.json)).toBe(200);
      return ((c.json.context ?? c.json).inputs ?? []) as Json[];
    };
    const view = await k.viewOk(D);
    const ins = await ctx();
    expect(ins[0]).toMatchObject({ from: AU, artifact: "debrief", kind: "review", title: "debrief items (3)" });
    expect(JSON.parse(ins[0].content)).toStrictEqual({ lineage: k.lineage, items: view.items });
    expect(ins[1]).toMatchObject({ from: AU, kind: "report", content: "REPORT-TEXT", artifact: view.report.artifact.id });
    for (const [f, d] of [
      [A, "accepted"],
      [B, "dismissed"],
      [C, "accepted"],
    ] as const)
      expect((await k.disposeRoute(k.c.alice, D, f, d)).status).toBe(201);
    const after = await ctx();
    expect(after.filter((x) => x.artifact === "debrief")).toStrictEqual([]);
    expect(after[0]).toMatchObject({ kind: "report", content: "REPORT-TEXT" });
  });
});

// ---------------------------------------------------------------------------------------------

describe("AC-14 privacy", () => {
  const MK = { title: "TITLE-MK-4d1", reason: "REASON-MK-4d1", answer: "ANSWER-MK-4d1", report: "REPORT-MK-4d1", rev: "REVREASON-MK-4d1" };
  it("test_AC14_no_markers", async () => {
    const { G, D } = await fixture({ items: [{ ...IA, title: MK.title }, IB, IC], report: MK.report });
    await k.claim(k.c.alice, D);
    expect((await k.disposeRoute(k.c.alice, D, A, "accepted", { reason: MK.reason, answer: MK.answer })).status).toBe(201);
    expect((await k.revert(k.c.alice, D, A, { reason: MK.rev })).status).toBe(200);
    expect((await k.disposeRoute(k.c.alice, D, A, "dismissed", { reason: MK.reason, answer: MK.answer })).status).toBe(201);
    await k.reviewOk(k.c.alice, D, rec({ dispositions: [disp(B, "accepted", { reason: MK.reason })] }));
    await k.doneOk(k.c.alice, D);
    const all = JSON.stringify(await k.r.allEvents());
    const t = await k.w.hub.svc.serviceToken("feed", ["goals:read"]);
    const feed = await k.call(t, "GET", "/v1/events?after=0");
    expect(feed.status).toBe(200);
    const files = (await k.call(k.c.alice, "GET", `/v1/goals/${G}/files`)).json.files as { path: string; text: string }[];
    for (const f of files) {
      mkdirSync(join(k.c.alice.repoDir, f.path, ".."), { recursive: true });
      writeFileSync(join(k.c.alice.repoDir, f.path), f.text);
    }
    git(k.c.alice.repoDir, ["add", "-A"]);
    git(k.c.alice.repoDir, ["commit", "-qm", "records"]);
    const ledger = exportLedger([k.c.alice.repoDir], undefined).lines.join("\n");
    for (const m of Object.values(MK)) {
      expect(all, m).not.toContain(m);
      expect(JSON.stringify(feed.json), m).not.toContain(m);
      expect(ledger, m).not.toContain(m);
    }
    // Positive: the events exist and the notes carry the reason and the title.
    expect(await k.ev("item.disposed", D)).toHaveLength(3);
    expect(await k.ev("item.reverted", D)).toHaveLength(1);
    const notes = (await k.notes(D)).join("\n");
    expect(notes).toContain(MK.reason);
    expect(notes).toContain(MK.title);
  });
});

// ---------------------------------------------------------------------------------------------

describe("AC-21 compatibility", () => {
  it("test_AC21_stage_via_and_already", async () => {
    await start();
    const G = await k.goal(k.c.alice, [S.audit(), S.step("v", { deps: ["audit"], mode: "headless", output: "review-record", consumes: ["open"], may_set: ["confirmed", "dismissed"] })]);
    await k.auditDone({ G, AU: `${G}.audit`, D: "", F: "" });
    await k.claim(k.c.alice, `${G}.v`);
    const res = await k.reviewOk(k.c.alice, `${G}.v`, rec({ dispositions: [disp(A, "confirmed")] }));
    expect(res.already).toStrictEqual([]);
    expect(res.applied).toBe(1);
    const row = dispositionsOf(await k.history(A)).at(-1);
    expect(row.via).toBe("stage");
    expect(row).not.toHaveProperty("answer");
    const es = await k.ev("item.disposed", `${G}.v`);
    expect(es[0].payload.via).toBe("stage");
    // A raising record has already: [] too.
    const H = await k.goal(k.c.alice, [S.audit()]);
    await k.claim(k.c.alice, `${H}.audit`);
    expect((await k.reviewOk(k.c.alice, `${H}.audit`, rec({ items: [IA] }))).already).toStrictEqual([]);
  });
});

// ---------------------------------------------------------------------------------------------

describe("AC-22 idempotency", () => {
  it("test_AC22_dispose_replay", async () => {
    const { D } = await fixture();
    await k.claim(k.c.alice, D);
    const one = await k.disposeRoute(k.c.alice, D, A, "accepted", {}, "k1");
    const two = await k.disposeRoute(k.c.alice, D, A, "accepted", {}, "k1");
    expect(one.status, JSON.stringify(one.json)).toBe(201);
    expect(two).toStrictEqual(one);
    expect(dispositionsOf(await k.history(A))).toHaveLength(1);
    expect((await k.notes(D)).filter((n) => n.startsWith("debrief:"))).toHaveLength(1);
    expect(await k.ev("item.disposed", D)).toHaveLength(1);
    expect(await k.ev("step.noted", D)).toHaveLength(1);
    const r1 = await k.revert(k.c.alice, D, A, {}, "k2");
    const r2 = await k.revert(k.c.alice, D, A, {}, "k2");
    expect(r1.status, JSON.stringify(r1.json)).toBe(200);
    expect(r2).toStrictEqual(r1);
    expect((await k.history(A)).filter((e) => e.kind === "revert")).toHaveLength(1);
    expect((await k.notes(D)).filter((n) => n.startsWith("debrief: reverted"))).toHaveLength(1);
    expect(await k.ev("item.reverted", D)).toHaveLength(1);
    // Control: another key is a new request, refused as not revertable.
    expect((await k.revert(k.c.alice, D, A, {}, "k3")).status).toBe(409);
  });
});

// ---------------------------------------------------------------------------------------------

describe("AC-08 (hub) step saved with the disposition", () => {
  it("test_AC08_step_updatedAt", async () => {
    const { D } = await fixture();
    await k.claim(k.c.alice, D);
    k.w.clock += 5 * MIN;
    const d = await k.disposeRoute(k.c.alice, D, A, "accepted");
    expect(d.status, JSON.stringify(d.json)).toBe(201);
    expect(d.json.disposition.at).toBe(k.w.clock);
    expect((await k.step(D)).updatedAt).toBe(d.json.disposition.at);
    expect(d.json.left).toBe(2);
    expect(d.json.item).toMatchObject({ fp: A, state: "accepted" });
    expect(d.json.note.text).toBe(`debrief: accepted ${A} "${TITLE[A]}": R-${A}`);
  });

  it("test_AC08_hub_does_not_redact", async () => {
    const { D } = await fixture();
    await k.claim(k.c.alice, D);
    const secret = "gh" + "p_" + "Q7x".repeat(12);
    expect((await k.disposeRoute(k.c.alice, D, A, "accepted", { answer: `a ${secret}` })).status).toBe(201);
    expect(dispositionsOf(await k.history(A)).at(-1).answer).toBe(`a ${secret}`);
  });
});

// ---------------------------------------------------------------------------------------------

describe("AC-25 long-held debrief (World)", () => {
  it("test_AC25_long_held", async () => {
    const { D } = await fixture();
    await k.claim(k.c.alice, D);
    k.w.clock += 8 * DAY;
    const alice = (await k.w.login("alice", { hostname: "alice-later" })).token;
    expect((await k.disposeRoute(alice, D, A, "accepted")).status).toBe(201);
    const l = await k.list(alice);
    expect((l.decided as Json[]).map((x) => x.fp)).toStrictEqual([A]);
  });
});
