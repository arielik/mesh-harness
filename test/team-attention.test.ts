// RL-22 AC-10 to AC-13: the team form of GET /v1/attention (sixteen kinds, users, rights, the stuck
// rows shared with GET /v1/stuck) and the personal form unchanged against a fixture written by the
// 0.1.41 code. Written from docs/specs/RL-22.md (§Team attention). Items are found by kind + ids.

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Ak, attentionWorld, HOUR, MIN, NOW, type AttWorld } from "./helpers/attention-kit.ts";
import type { Json } from "./helpers/world.ts";

const FIXTURE = join(import.meta.dirname, "fixtures", "attention-0.1.41.json");
const KINDS = [
  "plan",
  "gate",
  "debrief",
  "debrief-overdue",
  "hub-question",
  "parked",
  "failed",
  "paused",
  "stalled",
  "stuck-step",
  "stuck-session",
  "needs-you-session",
  "slot-missed",
  "pulse-blocked",
  "ready-unclaimed",
  "offer",
];

let world: AttWorld | undefined;
let ak: Ak | undefined;
afterEach(async () => {
  await world?.k.stop();
  await ak?.stop();
  world = undefined;
  ak = undefined;
});

const team = async (k: Ak, q = "", token = k.reader) => {
  const r = await k.w.call(token, "GET", `/v1/attention?team=1${q}`);
  expect(r.status, JSON.stringify(r.json)).toBe(200);
  return r.json;
};
const one = (items: Json[], kind: string, f: (x: Json) => boolean = () => true): Json => {
  const xs = items.filter((x) => x.kind === kind && f(x));
  expect(xs, `one ${kind}`).toHaveLength(1);
  return xs[0];
};

describe("RL-22 AC-10 team form", () => {
  it("test_AC10_every_kind", async () => {
    world = await attentionWorld();
    const { k, G1, G2, G3, P1, P2, q1, q2, stuckAt, times: t } = world;
    const a = await team(k);
    expect(a.generatedAt).toBe(NOW);
    expect(a.thresholds).toStrictEqual({ needsYouMs: 1_800_000, turns: 40 });
    expect(a.truncated).toBe(false);
    expect(a.users).toStrictEqual(["ann", "apu", "bob", "root"]);
    const items = a.items as Json[];
    const count = (kind: string) => items.filter((x) => x.kind === kind).length;
    for (const kind of KINDS) expect(count(kind), kind).toBe(kind === "hub-question" || kind === "needs-you-session" ? 2 : 1);
    expect(items).toHaveLength(18);
    for (const x of items) {
      for (const f of ["key", "kind", "goal", "step", "repo", "who", "at", "text"]) expect(x, `${x.kind} ${f}`).toHaveProperty(f);
      expect(x).not.toHaveProperty("options");
      expect(typeof x.text).toBe("string");
    }
    const ats = items.map((x) => x.at as number);
    expect(ats).toStrictEqual([...ats].sort((p, q) => p - q));
    expect(new Set(items.map((x) => x.key)).size).toBe(items.length);

    const s = (id: string) => `${G2}.${id}`;
    expect(one(items, "plan")).toMatchObject({ goal: G1, step: null, repo: "svc", who: "ann", at: t.plan, planVersion: 2 });
    expect(one(items, "gate")).toMatchObject({ goal: G2, step: s("gate"), repo: "svc", who: "ann", at: t.gate });
    expect(one(items, "debrief")).toMatchObject({ goal: G2, step: s("deb1"), who: "ann", at: t.approved });
    expect(one(items, "debrief-overdue")).toMatchObject({ goal: G2, step: s("deb2"), who: "ann", at: t.approved + HOUR, sla: { dueAt: t.approved + HOUR, breached: true, escalated: true }, escalatedTo: "ann" });
    expect(one(items, "hub-question", (x) => x.question === q1)).toMatchObject({ goal: G2, step: s("stall"), repo: "svc", who: "bob", at: t.q1, sid: "s-stall", toUsers: ["bob", "ann"] });
    expect(one(items, "hub-question", (x) => x.question === q2)).toMatchObject({ goal: null, step: null, repo: null, who: "ann", at: t.q2, sid: "s-ny2", toUsers: ["ann"] });
    expect(one(items, "parked")).toMatchObject({ goal: G2, step: s("park"), who: "ann", at: t.park, reason: "round cap (3)" });
    expect(one(items, "failed")).toMatchObject({ goal: G2, step: s("fail"), who: "ann", at: t.fail, reason: "tests failed" });
    expect(one(items, "paused")).toMatchObject({ goal: G2, step: s("pause"), who: "bob", at: t.pause, holder: "bob" });
    expect(one(items, "stalled")).toMatchObject({ goal: G2, step: s("stall"), who: "bob", at: t.stall, sid: "s-stall" });
    expect(one(items, "stuck-step")).toMatchObject({ goal: G2, step: s("stuck"), who: "ann", at: stuckAt, turns: 41, holder: "ann" });
    expect(one(items, "stuck-session")).toMatchObject({ goal: G2, step: s("ny"), who: "ann", at: t.ny, sid: "s-ny", machine: k.m.ann?.machine, forMs: 31 * MIN });
    expect(one(items, "needs-you-session", (x) => x.sid === "s-ny")).toMatchObject({ goal: G2, step: s("ny"), who: "ann", at: t.ny, machine: k.m.ann?.machine, needs: "permission" });
    expect(one(items, "needs-you-session", (x) => x.sid === "s-ny2")).toMatchObject({ goal: null, step: null, repo: null, who: "ann", at: t.ny2, needs: "question" });
    expect(one(items, "slot-missed")).toMatchObject({ goal: null, step: null, repo: null, who: "bob", at: t.missed, pulse: P2, slot: new Date(t.missed).toISOString(), reason: "no_machine" });
    expect(one(items, "pulse-blocked")).toMatchObject({ goal: G3, step: `${G3}.run`, who: "ann", at: t.blocked, pulse: P1 });
    expect(one(items, "ready-unclaimed")).toMatchObject({ goal: G2, step: s("impl"), who: null, at: t.approved, stepKind: "implement" });
    expect(one(items, "ready-unclaimed")).not.toHaveProperty("mode");
    expect(one(items, "offer")).toMatchObject({ goal: G2, step: s("off"), who: "bob", at: t.offer, targetMachine: k.m.bob?.machine });
    // Closed and trial goals.
    expect(items.some((x) => x.goal === world?.G4 || x.goal === world?.G5)).toBe(false);
    const withTrial = (await team(k, "&trial=include")).items as Json[];
    expect(withTrial.filter((x) => x.goal === world?.G5).map((x) => [x.kind, x.step])).toStrictEqual([["failed", `${world.G5}.y`]]);
    expect(withTrial.some((x) => x.goal === world?.G4)).toBe(false);
    // Keys are stable across reads.
    expect(((await team(k)).items as Json[]).map((x) => x.key)).toStrictEqual(items.map((x) => x.key));
  });
});

describe("RL-22 AC-11 stuck rows agree with GET /v1/stuck", () => {
  it("test_AC11_same_rows", async () => {
    ak = await Ak.start(NOW - 10 * HOUR);
    const k = ak;
    const G = await k.goal("ann", [{ id: "a" }, { id: "b" }, { id: "c" }]);
    // a: 8 turns after its commit; b: 4 turns; c: held by a session in needs_you for 2 minutes.
    k.w.clock = NOW - 2 * HOUR;
    await k.hold(`${G}.a`, "ann", undefined, NOW - 2 * HOUR);
    await k.patch(`${G}.a`, { rounds: [{ n: 1, user: "ann", finishedAt: NOW - HOUR, outcome: "fail", commit: "a".repeat(40) }] });
    for (let i = 0; i < 2; i++) await k.turn(`${G}.a`, NOW - 90 * MIN + i * MIN);
    for (let i = 0; i < 8; i++) await k.turn(`${G}.a`, NOW - 50 * MIN + i * MIN);
    const T5 = NOW - 50 * MIN + 4 * MIN;
    await k.hold(`${G}.b`, "ann", undefined, NOW - 2 * HOUR);
    for (let i = 0; i < 4; i++) await k.turn(`${G}.b`, NOW - 50 * MIN + i * MIN);
    await k.hold(`${G}.c`, "ann", "s-c", NOW - 2 * HOUR);
    await k.session("ann", "s-c", { state: "needs_you", step: `${G}.c`, stateSince: NOW - 2 * MIN });
    k.w.clock = NOW;
    const q = "?needsYouMs=60000&turns=5";
    const st = (await k.w.call(k.reader, "GET", `/v1/stuck${q}`)).json;
    const items = (await team(k, `&${q.slice(1)}`)).items as Json[];
    expect((await team(k, `&${q.slice(1)}`)).thresholds).toStrictEqual({ needsYouMs: 60_000, turns: 5 });
    const steps = items.filter((x) => x.kind === "stuck-step");
    expect(steps.map((x) => [x.step, x.turns])).toStrictEqual((st.steps as Json[]).map((x) => [x.step, x.turns]));
    expect(steps.map((x) => x.step)).toStrictEqual([`${G}.a`]);
    expect(steps[0].at).toBe(T5);
    const sessions = items.filter((x) => x.kind === "stuck-session");
    expect(sessions.map((x) => [x.sid, x.step, x.at])).toStrictEqual((st.sessions as Json[]).map((x) => [x.sid, x.step, x.since]));
    expect(sessions.map((x) => x.sid)).toStrictEqual(["s-c"]);
  });
});

describe("RL-22 AC-12 team rights", () => {
  it("test_AC12_rights", async () => {
    world = await attentionWorld();
    const { k } = world;
    expect(await k.w.call(k.reader, "GET", "/v1/attention")).toMatchObject({ status: 400, json: { code: "team-required" } });
    expect(await k.call("bob", "GET", "/v1/attention?team=1")).toMatchObject({ status: 403, json: { code: "team-forbidden" } });
    const root = await k.call("root", "GET", "/v1/attention?team=1");
    expect(root.status).toBe(200);
    expect(root.json.users).toStrictEqual(["ann", "apu", "bob", "root"]);
    expect(await k.as("ann", "GET", "/v1/attention?team=1", undefined, k.reader)).toMatchObject({ status: 400, json: { code: "on-behalf-of-not-accepted" } });
    expect(await k.w.call(k.reader, "GET", "/v1/attention?team=2")).toMatchObject({ status: 400, json: { code: "bad-query" } });
    for (const q of ["&needsYouMs=59999", "&turns=0", "&trial=x", "&limit=0", "&limit=5001"]) expect((await k.w.call(k.reader, "GET", `/v1/attention?team=1${q}`)).json.code, q).toBe("bad-query");
    const lim = await team(k, "&limit=1");
    expect(lim.items).toHaveLength(1);
    expect(lim.truncated).toBe(true);
    expect(lim.users).toStrictEqual(["ann", "apu", "bob", "root"]);
    // A service without goals:read.
    const none = await k.w.hub.svc.serviceToken("none", []);
    expect(await k.w.call(none, "GET", "/v1/attention?team=1")).toStrictEqual({ status: 403, json: { error: "forbidden", code: "forbidden" } });
  });
});

describe("RL-22 AC-13 personal form unchanged", () => {
  it("test_AC13_personal_fixture", async () => {
    world = await attentionWorld();
    const { k } = world;
    const got: Record<string, Json> = {};
    for (const u of ["ann", "bob", "apu", "root"]) {
      const r = await k.call(u, "GET", "/v1/attention");
      expect(r.status, JSON.stringify(r.json)).toBe(200);
      got[u] = r.json;
    }
    if (process.env.RL22_WRITE_FIXTURE === "1") writeFileSync(FIXTURE, `${JSON.stringify(got, null, 2)}\n`);
    expect(existsSync(FIXTURE)).toBe(true);
    expect(got).toStrictEqual(JSON.parse(readFileSync(FIXTURE, "utf8")));
  });
});
