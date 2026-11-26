// RL-27 AC-01 to AC-07: the stuck items of the team form of GET /v1/attention carry the caller's
// floors only: a stuck session's `at` is the instant it entered needs_you, `forMs` the time since,
// a stuck step's `turns` its full count, and an item exactly at a floor is returned. Written from
// docs/specs/RL-27.md.

import { afterEach, describe, expect, it } from "vitest";
import { accrue } from "../src/core/state-time.ts";
import type { Session } from "../src/protocol/index.ts";
import { Ak, HOUR, MIN, NOW } from "./helpers/attention-kit.ts";
import type { Json } from "./helpers/world.ts";

let ak: Ak | undefined;
afterEach(async () => {
  await ak?.stop();
  ak = undefined;
});

const team = async (k: Ak, q = "") => {
  const r = await k.w.call(k.reader, "GET", `/v1/attention?team=1${q}`);
  expect(r.status, JSON.stringify(r.json)).toBe(200);
  return r.json;
};
const of = (a: Json, kind: string): Json[] => (a.items as Json[]).filter((x) => x.kind === kind);

/** A step of goal `G` held by `sid` of ann, the session in needs_you since `since` (none: no `stateSince`). */
async function waiting(k: Ak, G: string, id: string, sid: string, since: number | undefined, o: Partial<Session> = {}): Promise<void> {
  await k.hold(`${G}.${id}`, "ann", sid, NOW - 2 * HOUR);
  await k.session("ann", sid, { state: "needs_you", needs: "permission", step: `${G}.${id}`, ...(since === undefined ? {} : { stateSince: since }), lastStopAt: since ?? NOW - 3 * MIN, lastEventAt: since ?? NOW - 3 * MIN, ...o });
}
/** A step of goal `G` held by ann with no session, `n` turns since its commit (two turns before it); the turns' instants. */
async function turning(k: Ak, G: string, id: string, n: number): Promise<number[]> {
  const s = `${G}.${id}`;
  await k.hold(s, "ann", undefined, NOW - 3 * HOUR);
  await k.patch(s, { rounds: [{ n: 1, user: "ann", finishedAt: NOW - 2 * HOUR, outcome: "fail", commit: "c".repeat(40) }] });
  for (let i = 0; i < 2; i++) await k.turn(s, NOW - 150 * MIN + i * MIN);
  const ats = Array.from({ length: n }, (_, i) => NOW - 100 * MIN + i * MIN);
  for (const at of ats) await k.turn(s, at);
  return ats;
}

describe("RL-27 AC-01 a stuck session's at is its entry instant", () => {
  it("test_AC01_at_is_state_since", async () => {
    ak = await Ak.start(NOW - 3 * HOUR);
    const k = ak;
    const G = await k.goal("ann", [{ id: "a" }]);
    const T0 = NOW - 31 * MIN;
    k.w.clock = T0 + 25 * MIN;
    await waiting(k, G, "a", "s-1", T0, { lastStopAt: T0 + 20 * MIN, lastEventAt: T0 + 25 * MIN });
    k.w.clock = NOW;
    const a = await team(k, "&needsYouMs=1800000");
    expect(a.generatedAt).toBe(NOW);
    const xs = of(a, "stuck-session");
    expect(xs).toHaveLength(1);
    expect(xs[0]).toMatchObject({ sid: "s-1", step: `${G}.a`, at: T0, forMs: 31 * MIN });
    expect([T0 + 20 * MIN, T0 + 25 * MIN, T0 + 30 * MIN]).not.toContain(xs[0]?.at);
  });

  it("test_AC01_second_needs_you_keeps_state_since", () => {
    const T0 = NOW - 31 * MIN;
    const base: Session = { sid: "s-1", claudeSessionIds: [], cwd: "/w", kind: "interactive", state: "working", quiet: false, startedAt: T0 - HOUR, lastEventAt: T0 - MIN, turns: 1, humanPrompts: 1, seenByReconciler: true };
    const s0 = accrue(undefined, base, T0 - MIN);
    const s1 = accrue(s0, { ...s0, state: "needs_you", needs: "permission" }, T0);
    expect(s1.stateSince).toBe(T0);
    const s2 = accrue(s1, { ...s1, state: "needs_you", needs: "question" }, T0 + 20 * MIN);
    expect(s2.stateSince).toBe(T0);
  });
});

describe("RL-27 AC-02 the floor never changes at", () => {
  it("test_AC02_same_at_any_floor", async () => {
    ak = await Ak.start(NOW - 3 * HOUR);
    const k = ak;
    const G = await k.goal("ann", [{ id: "a" }]);
    const T0 = NOW - 31 * MIN;
    k.w.clock = T0 + 25 * MIN;
    await waiting(k, G, "a", "s-1", T0, { lastStopAt: T0 + 20 * MIN, lastEventAt: T0 + 25 * MIN });
    k.w.clock = NOW;
    const low = of(await team(k, "&needsYouMs=60000"), "stuck-session");
    const high = of(await team(k, "&needsYouMs=1800000"), "stuck-session");
    expect(low.map((x) => x.at)).toStrictEqual([T0]);
    expect(high.map((x) => x.at)).toStrictEqual([T0]);
  });
});

describe("RL-27 AC-03 no stateSince, no stuck session", () => {
  it("test_AC03_unmeasured_session", async () => {
    ak = await Ak.start(NOW - 3 * HOUR);
    const k = ak;
    const G = await k.goal("ann", [{ id: "a" }]);
    k.w.clock = NOW - 2 * HOUR;
    await waiting(k, G, "a", "s-1", undefined, { lastStopAt: NOW - 2 * HOUR, lastEventAt: NOW - 2 * HOUR });
    k.w.clock = NOW;
    for (const q of ["&needsYouMs=60000", "&needsYouMs=1800000", ""]) {
      const a = await team(k, q);
      expect(of(a, "stuck-session"), q).toStrictEqual([]);
      expect(of(a, "needs-you-session").map((x) => [x.sid, x.step]), q).toStrictEqual([["s-1", `${G}.a`]]);
    }
  });
});

describe("RL-27 AC-04 an item exactly at a floor is returned", () => {
  it("test_AC04_boundaries", async () => {
    ak = await Ak.start(NOW - 4 * HOUR);
    const k = ak;
    const G = await k.goal("ann", [{ id: "a" }, { id: "b" }, { id: "c" }, { id: "d" }]);
    k.w.clock = NOW - MIN;
    await waiting(k, G, "a", "s-60", NOW - 60_000);
    await waiting(k, G, "b", "s-59", NOW - 59_999);
    await turning(k, G, "c", 5);
    await turning(k, G, "d", 4);
    k.w.clock = NOW;
    const a = await team(k, "&needsYouMs=60000&turns=5");
    expect(of(a, "stuck-session").map((x) => [x.sid, x.forMs])).toStrictEqual([["s-60", 60_000]]);
    expect(of(a, "stuck-step").map((x) => [x.step, x.turns])).toStrictEqual([[`${G}.c`, 5]]);
  });
});

describe("RL-27 AC-05 a stuck step's turns is its full count", () => {
  it("test_AC05_turns_not_capped", async () => {
    ak = await Ak.start(NOW - 4 * HOUR);
    const k = ak;
    const G = await k.goal("ann", [{ id: "a" }]);
    const ats = await turning(k, G, "a", 47);
    k.w.clock = NOW;
    for (const n of [1, 40, 47]) {
      const xs = of(await team(k, `&turns=${n}`), "stuck-step");
      expect(xs.map((x) => [x.step, x.turns, x.at]), `turns=${n}`).toStrictEqual([[`${G}.a`, 47, ats[n - 1]]]);
    }
  });
});

describe("RL-27 AC-06 the floors are the only thresholds", () => {
  it("test_AC06_lowest_floors_and_defaults", async () => {
    ak = await Ak.start(NOW - 4 * HOUR);
    const k = ak;
    const G = await k.goal("ann", ["s1", "s2", "s3", "t1", "t2", "t3"].map((id) => ({ id })));
    k.w.clock = NOW - MIN;
    await waiting(k, G, "s1", "s-1", NOW - MIN);
    await waiting(k, G, "s2", "s-2", NOW - 10 * MIN);
    await waiting(k, G, "s3", "s-3", NOW - 45 * MIN);
    await turning(k, G, "t1", 1);
    await turning(k, G, "t2", 10);
    await turning(k, G, "t3", 41);
    k.w.clock = NOW;
    const low = await team(k, "&needsYouMs=60000&turns=1");
    expect(low.thresholds).toStrictEqual({ needsYouMs: 60_000, turns: 1 });
    expect(low.truncated).toBe(false);
    expect(of(low, "stuck-session").map((x) => x.sid).sort()).toStrictEqual(["s-1", "s-2", "s-3"]);
    expect(of(low, "stuck-step").map((x) => x.step).sort()).toStrictEqual([`${G}.t1`, `${G}.t2`, `${G}.t3`]);
    const dflt = await team(k);
    expect(dflt.thresholds).toStrictEqual({ needsYouMs: 1_800_000, turns: 40 });
    expect(of(dflt, "stuck-session").map((x) => x.sid)).toStrictEqual(["s-3"]);
    expect(of(dflt, "stuck-step").map((x) => x.step)).toStrictEqual([`${G}.t3`]);
  });

  it("test_AC06_paused_step_session", async () => {
    ak = await Ak.start(NOW - 4 * HOUR);
    const k = ak;
    const G = await k.goal("ann", [{ id: "a" }]);
    k.w.clock = NOW - MIN;
    await waiting(k, G, "a", "s-p", NOW - 5 * MIN);
    await k.patch(`${G}.a`, { state: "paused", pausedAt: NOW - 2 * MIN });
    k.w.clock = NOW;
    expect(of(await team(k, "&needsYouMs=60000"), "stuck-session").map((x) => [x.sid, x.at])).toStrictEqual([["s-p", NOW - 5 * MIN]]);
  });
});

describe("RL-27 AC-07 open goals only", () => {
  it("test_AC07_trial_and_done", async () => {
    ak = await Ak.start(NOW - 4 * HOUR);
    const k = ak;
    const T = await k.goal("ann", [{ id: "a" }], "trial goal");
    const D = await k.goal("ann", [{ id: "a" }], "done goal");
    k.w.clock = NOW - MIN;
    await waiting(k, T, "a", "s-t", NOW - 45 * MIN);
    await waiting(k, D, "a", "s-d", NOW - 45 * MIN);
    await k.patchGoal(T, { trial: true });
    await k.patchGoal(D, { state: "done" });
    k.w.clock = NOW;
    expect(of(await team(k, "&needsYouMs=60000"), "stuck-session")).toStrictEqual([]);
    expect(of(await team(k, "&needsYouMs=60000&trial=include"), "stuck-session").map((x) => x.sid)).toStrictEqual(["s-t"]);
  });
});
