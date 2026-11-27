// RL-28 reopen of a done goal: a proposal and an approval reopen it to in_progress (AC-10, AC-11),
// a revise leaves it done (AC-12), a replan reopens it to design (AC-13), every other refusal on a
// closed goal stays (AC-14), and the `state` filter of `GET /v1/goals` (AC-20). Written from
// docs/specs/RL-28.md. People: ann (member), bob (member, approver); the service svc acts for bob.

import { afterEach, describe, expect, it } from "vitest";
import { Ak, NOW } from "./helpers/attention-kit.ts";
import { CLEAN_TEXT, Sk, acc, fA, IA } from "./helpers/sink-kit.ts";
import type { Json } from "./helpers/world.ts";

let k: Ak;
let sk: Sk | undefined;
afterEach(async () => {
  await k?.stop();
  await sk?.stop();
  sk = undefined;
});

async function start(): Promise<Ak> {
  k = await Ak.start(NOW, { approvers: ["bob"] });
  k.svc = await k.w.hub.svc.serviceToken("svc", ["goals:read", "goals:write", "goals:decide", "goals:join", "live:read"]);
  return k;
}
const ofGoal = async (G: string, types?: string[]): Promise<Json[]> => (await k.store.events(0, 100_000)).filter((e) => e.goal === G && (types === undefined || types.includes(e.type)));
const state = async (G: string) => (await k.store.getGoal(G))?.state;
/** Claim and finish a step as `who`. */
async function finish(who: string, id: string): Promise<void> {
  const c = await k.call(who, "POST", `/v1/steps/${id}/claim`, {});
  expect(c.status, JSON.stringify(c.json)).toBe(200);
  const d = await k.call(who, "POST", `/v1/steps/${id}/done`, { summary: "ok" });
  expect(d.status, JSON.stringify(d.json)).toBe(200);
}
/** A goal of `owner` with steps a and b, both finished: the goal is done (one `goal.done`). */
async function doneGoal(owner = "ann"): Promise<string> {
  const G = await k.goal(owner, [{ id: "a" }, { id: "b" }], "done goal");
  await finish(owner, `${G}.a`);
  await finish(owner, `${G}.b`);
  expect(await state(G)).toBe("done");
  expect(await ofGoal(G, ["goal.done"])).toHaveLength(1);
  return G;
}
const AMEND = [{ id: "a" }, { id: "b" }, { id: "c" }];
const listed = async (who: string, G: string, query = ""): Promise<Json | undefined> => (await k.call(who, "GET", `/v1/goals${query}`)).json.goals.find((g: Json) => g.id === G);

describe("RL-28 AC-10 AC-11 an amendment reopens a done goal", () => {
  it("test_AC10_propose_then_approve", async () => {
    await start();
    const G4 = await doneGoal();
    const p = await k.plan("ann", G4, AMEND, false);
    expect(p.status, JSON.stringify(p.json)).toBe(201);
    expect(p.json.plan.version).toBe(2);
    expect(await state(G4)).toBe("done");
    expect((await listed("ann", G4))?.planPending).toBe(true);
    const seq = (await k.store.events(0, 100_000)).at(-1)?.seq as number;
    const ap = await k.call("bob", "POST", `/v1/goals/${G4}/approve`, {});
    expect(ap.status, JSON.stringify(ap.json)).toBe(200);
    expect(ap.json.goal.state).toBe("in_progress");
    expect(await state(G4)).toBe("in_progress");
    const after = (await ofGoal(G4, ["plan.approved", "goal.reopened", "step.ready"])).filter((e) => e.seq > seq);
    expect(after.map((e) => [e.type, e.step ?? null])).toStrictEqual([
      ["plan.approved", null],
      ["goal.reopened", null],
      ["step.ready", `${G4}.c`],
    ]);
    expect([after[1].user, after[1].payload]).toStrictEqual(["bob", { from: "done", to: "in_progress", version: 2 }]);
    const tl = await k.call("ann", "GET", `/v1/goals/${G4}/timeline`);
    expect(tl.json.timeline.filter((e: Json) => e.type === "goal.reopened").map((e: Json) => e.text)).toStrictEqual([`reopened ${G4} (in_progress)`]);
    expect((await listed("ann", G4))?.planPending).toBe(false);
    // The new step finishes: done again, a second goal.done.
    await finish("bob", `${G4}.c`);
    expect(await state(G4)).toBe("done");
    expect(await ofGoal(G4, ["goal.done"])).toHaveLength(2);
    // The trail's goal.yaml rolls up from the last goal.done.
    const files = await k.call("ann", "GET", `/v1/goals/${G4}/files`);
    expect(files.status).toBe(200);
  });

  it("test_AC10_propose_with_approve", async () => {
    await start();
    const G5 = await doneGoal("bob");
    const seq = (await k.store.events(0, 100_000)).at(-1)?.seq as number;
    const p = await k.plan("bob", G5, AMEND, true);
    expect(p.status, JSON.stringify(p.json)).toBe(201);
    expect(await state(G5)).toBe("in_progress");
    const after = (await ofGoal(G5, ["plan.proposed", "plan.approved", "goal.reopened"])).filter((e) => e.seq > seq);
    expect(after.map((e) => e.type)).toStrictEqual(["plan.proposed", "plan.approved", "goal.reopened"]);
  });

  it("test_AC11_skipped_only", async () => {
    await start();
    const G = await k.goal("ann", [{ id: "audit", kind: "review", output: "review-record" }], "audited");
    await k.patch(`${G}.audit`, { state: "done", outcome: "done" });
    await k.patchGoal(G, { state: "done" });
    const doneBefore = (await ofGoal(G, ["goal.done"])).length;
    const p = await k.plan("ann", G, [{ id: "audit", kind: "review", output: "review-record" }, { id: "fix", deps: ["audit"], when: { open: true }, consumes: ["open"] }], false);
    expect(p.status, JSON.stringify(p.json)).toBe(201);
    const ap = await k.call("bob", "POST", `/v1/goals/${G}/approve`, {});
    expect(ap.status, JSON.stringify(ap.json)).toBe(200);
    expect((await k.step(`${G}.fix`)).state).toBe("skipped");
    expect(await state(G)).toBe("done");
    expect(await ofGoal(G, ["goal.reopened"])).toStrictEqual([]);
    expect(await ofGoal(G, ["goal.done"])).toHaveLength(doneBefore);
  });
});

describe("RL-28 AC-12 revise", () => {
  it("test_AC12_revise_keeps_done", async () => {
    await start();
    const G = await doneGoal();
    expect((await k.plan("ann", G, AMEND, false)).status).toBe(201);
    const r = await k.call("bob", "POST", `/v1/goals/${G}/revise`, { comment: "smaller" });
    expect(r.status, JSON.stringify(r.json)).toBe(200);
    expect(await state(G)).toBe("done");
    expect((await k.store.listPlans(G)).at(-1)?.decision).toBe("revised");
    expect(await ofGoal(G, ["goal.reopened"])).toStrictEqual([]);
    expect((await listed("ann", G))?.planPending).toBe(false);
  });
});

describe("RL-28 AC-13 replan", () => {
  it("test_AC13_replan_reopens_to_design", async () => {
    await start();
    const G = await doneGoal();
    const r = await k.call("bob", "POST", `/v1/goals/${G}/replan`, { comment: "findings" });
    expect(r.status, JSON.stringify(r.json)).toBe(200);
    expect(await state(G)).toBe("design");
    expect((await k.step(`${G}.design`)).state).toBe("ready");
    const evs = await ofGoal(G, ["goal.replan", "goal.reopened"]);
    expect(evs.map((e) => e.type)).toStrictEqual(["goal.replan", "goal.reopened"]);
    expect([evs[1].user, evs[1].payload]).toStrictEqual(["bob", { from: "done", to: "design", comment: "findings" }]);
    // The normal path follows: a proposal awaits approval, its approval emits no second reopen.
    expect((await k.plan("ann", G, AMEND, false)).status).toBe(201);
    expect(await state(G)).toBe("awaiting_approval");
    expect((await k.call("bob", "POST", `/v1/goals/${G}/approve`, {})).status).toBe(200);
    expect(await state(G)).toBe("in_progress");
    expect(await ofGoal(G, ["goal.reopened"])).toHaveLength(1);
  });

  it("test_AC13_dropped_refused", async () => {
    await start();
    const D = await k.goal("ann", [{ id: "a" }], "dropped");
    expect((await k.call("ann", "POST", `/v1/goals/${D}/drop`, {})).status).toBe(200);
    const r = await k.call("bob", "POST", `/v1/goals/${D}/replan`, {});
    expect([r.status, r.json.code]).toStrictEqual([409, "goal-closed"]);
  });

  it("test_AC13_via", async () => {
    await start();
    // Replan through svc for bob (the owner: act-for keeps the member role only).
    const G = await doneGoal("bob");
    const rp = await k.as("bob", "POST", `/v1/goals/${G}/replan`, { comment: "again" });
    expect(rp.status, JSON.stringify(rp.json)).toBe(200);
    const [replan, reopen] = await ofGoal(G, ["goal.replan", "goal.reopened"]);
    expect([replan.user, replan.payload.via]).toStrictEqual(["bob", "svc"]);
    expect([reopen.user, reopen.payload]).toStrictEqual(["bob", { from: "done", to: "design", comment: "again", via: "svc" }]);
    // The proposal route takes no service token (unchanged by RL-28): bob proposes, svc approves for him.
    expect((await k.plan("bob", G, AMEND, false)).status).toBe(201);
    const ap = await k.as("bob", "POST", `/v1/goals/${G}/approve`, {});
    expect(ap.status, JSON.stringify(ap.json)).toBe(200);
    expect((await ofGoal(G, ["plan.approved"])).at(-1)?.payload.via).toBe("svc");
    // An approval through svc that reopens a done goal: goal.reopened carries via.
    const H = await doneGoal("bob");
    expect((await k.plan("bob", H, AMEND, false)).status).toBe(201);
    expect((await k.as("bob", "POST", `/v1/goals/${H}/approve`, {})).status).toBe(200);
    const [ro] = await ofGoal(H, ["goal.reopened"]);
    expect([ro.user, ro.payload]).toStrictEqual(["bob", { from: "done", to: "in_progress", version: 2, via: "svc" }]);
  });
});

describe("RL-28 AC-14 refusals that stay", () => {
  it("test_AC14_dropped_and_done", async () => {
    await start();
    const D = await k.goal("ann", [{ id: "a" }], "dropped");
    expect((await k.call("ann", "POST", `/v1/goals/${D}/drop`, {})).status).toBe(200);
    expect(await k.plan("ann", D, AMEND, false)).toStrictEqual({ status: 409, json: { error: `${D} is dropped` } });
    const G = await doneGoal();
    const drop = await k.call("ann", "POST", `/v1/goals/${G}/drop`, {});
    expect([drop.status, drop.json.code]).toStrictEqual([409, "goal-closed"]);
    // A done goal's step held again by a test seam: park and stop-run still refuse.
    await k.hold(`${G}.a`, "ann", undefined);
    const park = await k.call("ann", "POST", `/v1/steps/${G}.a/park`, { reason: "stop" });
    expect([park.status, park.json.code]).toStrictEqual([409, "goal-closed"]);
    const stop = await k.call("ann", "POST", `/v1/steps/${G}.a/stop-run`, { reason: "stop" });
    expect([stop.status, stop.json.code]).toStrictEqual([409, "goal-closed"]);
    expect(await state(G)).toBe("done");
  });

  it("test_AC14_clean_audit", { timeout: 60_000 }, async () => {
    sk = await Sk.start();
    const run = await sk.run();
    await sk.raise(run, [IA]);
    await sk.file(run, [acc(fA)]);
    const CG = await sk.CG();
    const steps = [{ id: "fix", repo: "r", kind: "implement", title: "Fix", brief: "b", deps: [] }];
    const refused = { error: CLEAN_TEXT(CG) };
    const r = await sk.call(sk.ann, "POST", `/v1/goals/${CG}/plan`, { steps, approve: false });
    expect([r.status, r.json]).toStrictEqual([409, refused]);
    // AC-05: the hub opened it; nobody is a member.
    const d = await sk.call(sk.ann, "GET", `/v1/goals/${CG}`);
    expect(d.json.members).toStrictEqual([]);
    // Done (a test seam): still refused, and a replan stays goal-closed.
    const g = await sk.w.hub.svc.store.getGoal(CG);
    await sk.w.hub.svc.store.saveGoal({ ...(g as NonNullable<typeof g>), state: "done" });
    const r2 = await sk.call(sk.ann, "POST", `/v1/goals/${CG}/plan`, { steps, approve: false });
    expect([r2.status, r2.json]).toStrictEqual([409, refused]);
  });
});

describe("RL-28 AC-20 state filter", () => {
  it("test_AC20_open_done_dropped_all", async () => {
    await start();
    const open = await k.goal("ann", [{ id: "a" }], "open");
    const amended = await doneGoal();
    expect((await k.plan("ann", amended, AMEND, false)).status).toBe(201);
    const done = await doneGoal();
    const dropped = await k.goal("ann", [{ id: "a" }], "dropped");
    expect((await k.call("ann", "POST", `/v1/goals/${dropped}/drop`, {})).status).toBe(200);
    const ids = async (q: string) => {
      const r = await k.call("ann", "GET", `/v1/goals${q}`);
      expect(r.status, JSON.stringify(r.json)).toBe(200);
      return r.json.goals.map((g: Json) => g.id);
    };
    expect(await ids("?state=open")).toStrictEqual([open, amended]);
    const a = await listed("ann", amended, "?state=open");
    expect([a.state, a.planPending]).toStrictEqual(["done", true]);
    expect(await ids("?state=done")).toStrictEqual([done]);
    expect(await ids("?state=dropped")).toStrictEqual([dropped]);
    expect(await ids("?state=all")).toStrictEqual([open, amended, done, dropped]);
    expect(await ids("")).toStrictEqual([open, amended, done, dropped]);
    // Each goal is in exactly one of open, done, dropped.
    const parts = [...(await ids("?state=open")), ...(await ids("?state=done")), ...(await ids("?state=dropped"))].sort();
    expect(parts).toStrictEqual([open, amended, done, dropped].sort());
    // With member: the two filters together.
    expect(await ids("?state=open&member=me")).toStrictEqual([open, amended]);
    expect(await ids("?state=open&member=bob")).toStrictEqual([]);
    const bad = await k.call("ann", "GET", "/v1/goals?state=closed");
    expect([bad.status, bad.json.code]).toStrictEqual([400, "bad-query"]);
  });
});
