// RL-14 (docs/specs/RL-14.md): time per session state, efficiency cards, the window, the stuck
// signal. AC-02 to AC-11 and AC-14 through the hub API with real daemons; AC-01/AC-04 core rules are
// in src/core/state-time.test.ts, AC-12 in the store contract, AC-13 in test/docs-rl14.test.ts.

import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DAY_MS, HUB_FEATURES, type Goal, type Session, type Step } from "../src/protocol/index.ts";
import { heldBy } from "../src/hub/service.ts";
import { HubLink } from "../src/daemon/hub-link.ts";
import { DaemonStore } from "../src/store/index.ts";
import { World, type Json, type Person } from "./helpers/world.ts";
import { tel as calibTel } from "./helpers/calib-kit.ts";

const MIN = 60_000;
const HOUR = 60 * MIN;
const REPO = "alpha";

let w: World;
let alice: Person;

beforeEach(async () => {
  w = new World();
  await w.start(["alice", "root", "bob"], { admins: ["root"] });
  alice = await w.person("alice", REPO);
});
afterEach(() => w.stop());

async function goal(p: Person, steps: string[] = ["a"], title = "eff"): Promise<string> {
  const g = await w.api(p, "POST", "/v1/goals", { title, primaryRepo: REPO });
  const G = g.json.id as string;
  const plan = await w.api(p, "POST", `/v1/goals/${G}/plan`, { approve: true, steps: steps.map((id) => ({ id, repo: REPO, kind: "implement", title: id, brief: `do ${id}` })) });
  expect(plan.status, JSON.stringify(plan.json)).toBe(201);
  return G;
}

/** A session of `p` (pid) that claims `step`. */
async function hold(p: Person, pid: number, step: string): Promise<Session> {
  w.hook(p, "SessionStart", pid);
  const c = await w.tool(p, pid, "mesh_claim", { step });
  expect(c.isError, c.text).toBeFalsy();
  return w.session(p, pid);
}

const notify = (p: Person, pid: number, type = "permission_prompt") =>
  p.daemon.handleHook("Notification", { session_id: `claude-${pid}`, cwd: p.repoDir, hook_event_name: "Notification", transcript_path: `/t/${pid}.jsonl`, notification_type: type }, { claudePid: String(pid), tmuxPane: `%${pid}` });
const stop = (p: Person, pid: number) => w.hook(p, "Stop", pid, { stop_hook_active: false, last_assistant_message: "done" });
const prompt = (p: Person, pid: number) => w.hook(p, "UserPromptSubmit", pid, { prompt: "work" });

const card = async (G: string): Promise<Json> => {
  const r = await w.api(alice, "GET", `/v1/goals/${G}/efficiency`);
  expect(r.status, JSON.stringify(r.json)).toBe(200);
  return r.json;
};
const stepCard = async (G: string, id: string): Promise<Json> => ((await card(G)).stepCards as Json[]).find((c) => c.step === id);
const rowOf = async (step: string, sid: string) => (await w.hubStore.listStepTimes({ steps: [step] })).find((r) => r.sid === sid);
const sum = (t: Json) => t.workingMs + t.needsYouMs + t.idleMs + t.stalledMs;
const sync = (p: Person, body: Json) => w.api(p, "POST", "/v1/sync", body);
const sess = (sid: string, over: Partial<Session> = {}): Session => ({
  sid,
  claudeSessionIds: [],
  cwd: "/r",
  kind: "interactive",
  state: "idle",
  quiet: false,
  startedAt: w.clock,
  lastEventAt: w.clock,
  turns: 0,
  humanPrompts: 0,
  seenByReconciler: false,
  ...over,
});
const day = (d: number, over: Json = {}) => ({ day: d, workingMs: 0, needsYouMs: 0, idleMs: 0, stalledMs: 0, ...over });
const ev = (type: string, step: string, at: number) => w.hubStore.appendEvent({ id: randomUUID(), at, type, step, payload: {} });

// =============================================================================================
// AC-02 end to end, AC-03 idempotent sync, AC-04 no leak
// =============================================================================================

describe("RL-14 AC-02 AC-03 AC-04 daemon to hub", () => {
  it("test_AC02_state_time_end_to_end", async () => {
    const G = await goal(alice);
    const s = await hold(alice, 100, `${G}.a`);
    prompt(alice, 100);
    w.clock += 30_000;
    await notify(alice, 100);
    w.clock += 120_000;
    stop(alice, 100);
    w.clock += 5 * MIN + 1;
    alice.daemon.tick();
    expect(w.session(alice, 100).state).toBe("stalled");
    w.clock += 10_000;
    await w.flush();
    const c = await stepCard(G, `${G}.a`);
    expect(c.stateTime).toStrictEqual({ workingMs: 30_000, needsYouMs: 120_000, idleMs: 5 * MIN + 1, stalledMs: 10_000 });
    expect(c.sessions).toStrictEqual([{ sid: s.sid, user: "alice", machine: w.machineOf(alice), asOf: w.clock, ...c.stateTime }]);
    const g = await card(G);
    expect(g.stateTime).toStrictEqual(c.stateTime);
    expect(g.stateTimeSteps).toBe(1);
  });

  it("test_AC03_same_body_twice_and_older", async () => {
    const G = await goal(alice);
    const s = await hold(alice, 100, `${G}.a`);
    prompt(alice, 100);
    w.clock += 40_000;
    await w.flush();
    const older = (alice.syncs as Json[]).filter((b) => b.stateTime?.length).at(-1);
    w.clock += 90_000;
    stop(alice, 100);
    await w.flush();
    const newer = (alice.syncs as Json[]).filter((b) => b.stateTime?.length).at(-1);
    expect(newer.stateTime[0].asOf).toBeGreaterThan(older.stateTime[0].asOf);
    const stored = await rowOf(`${G}.a`, s.sid);
    expect(sum(stored?.days[0])).toBe(130_000);
    // The same body again, then the older one: nothing changes.
    expect((await sync(alice, { stateTime: newer.stateTime })).status).toBe(200);
    expect((await sync(alice, { stateTime: older.stateTime })).status).toBe(200);
    expect(await rowOf(`${G}.a`, s.sid)).toStrictEqual(stored);
  });

  it("test_AC03_lost_reply_offline_restart", async () => {
    const G = await goal(alice);
    const s = await hold(alice, 100, `${G}.a`);
    prompt(alice, 100);
    w.clock += 20_000;
    alice.dropReplyOnce(/\/v1\/sync/);
    await alice.daemon.link?.flush();
    w.clock += 70_000;
    await w.flush();
    expect(sum((await rowOf(`${G}.a`, s.sid))?.days[0])).toBe(90_000);
    // Offline for 10 min, then back.
    await w.goOffline(alice);
    w.clock += 10 * MIN;
    await alice.daemon.link?.flush();
    alice.offline = false;
    w.clock += 1000;
    await alice.daemon.link?.flush({ probeNow: true });
    await alice.daemon.link?.flush();
    expect(sum((await rowOf(`${G}.a`, s.sid))?.days[0])).toBe(90_000 + 10 * MIN + 1000);
    // A daemon restart: totals continue, never restart from 0 or double.
    await w.restart(alice);
    w.clock += 60_000;
    alice.daemon.tick();
    await w.flush();
    const row = await rowOf(`${G}.a`, s.sid);
    expect(sum(row?.days[0])).toBe(90_000 + 10 * MIN + 1000 + 60_000);
    expect(row?.days[0]?.workingMs).toBe(sum(row?.days[0]));
  });

  it("test_AC04_no_leak_in_records", async () => {
    const G = await goal(alice);
    await hold(alice, 100, `${G}.a`);
    w.clock += 5000;
    await w.flush();
    for (const b of alice.syncs as Json[]) for (const x of b.sessions ?? []) expect(x).not.toHaveProperty("stateTime");
    const live = await w.api(alice, "GET", "/v1/live");
    expect(JSON.stringify(live.json)).not.toContain("stateTime");
    const hs = await w.hubStore.getSession(w.session(alice, 100).sid);
    expect(hs?.session).not.toHaveProperty("stateTime");
    expect(hs?.session.stateSince).toBeDefined();
  });
});

describe("RL-14 AC-04 retention, strip, hub switch", () => {
  it("test_AC04_hub_strips_state_time", async () => {
    const G = await goal(alice);
    const r = await sync(alice, { sessions: [sess("s-x", { step: `${G}.a`, stateTime: { since: w.clock, steps: { [`${G}.a`]: [] } } })] });
    expect(r.status).toBe(200);
    const hs = await w.hubStore.getSession("s-x");
    expect(hs).toBeDefined();
    expect(hs?.session).not.toHaveProperty("stateTime");
  });

  it("test_AC04_ended_kept_until_accepted", async () => {
    const G = await goal(alice);
    const s = await hold(alice, 100, `${G}.a`);
    prompt(alice, 100);
    w.clock += 10_000;
    await w.flush();
    await w.goOffline(alice);
    w.clock += 5_000;
    w.hook(alice, "SessionEnd", 100, { reason: "exit" });
    expect(alice.daemon.sessions.find((x) => x.sid === s.sid)?.state).toBe("ended");
    // A day later the final 15 s were never accepted: the session stays in memory.
    w.clock += 25 * HOUR;
    alice.daemon.tick();
    expect(alice.daemon.sessions.some((x) => x.sid === s.sid)).toBe(true);
    alice.offline = false;
    await alice.daemon.link?.flush({ probeNow: true });
    await alice.daemon.link?.flush();
    expect(sum((await rowOf(`${G}.a`, s.sid))?.days[0])).toBe(15_000);
    alice.daemon.tick();
    expect(alice.daemon.sessions.some((x) => x.sid === s.sid)).toBe(false);
  });

  it("test_AC04_marks_cleared_on_hub_switch", async () => {
    const calls: [readonly string[], readonly unknown[]][] = [];
    const link = new HubLink({
      credentialsPath: "/nonexistent",
      store: await DaemonStore.open(":memory:"),
      sessions: () => [sess("s1", { step: "G1.a" }), sess("s2")],
      onMessage: () => "unknown",
      onNotHeld: (sids, nh) => calls.push([sids, nh]),
      log: () => undefined,
      now: () => w.clock,
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- the private credentials switch
    const facts = (c: Json) => (link as any).factsFor(c);
    link.stateTimeSent.set("s1\nG1.a", { open: true, state: "idle", asOf: 1, days: "[]" });
    facts({ hub: "http://h1", machine: "m-1" });
    expect(calls).toStrictEqual([]);
    facts({ hub: "http://h1", machine: "m-1" });
    expect(calls).toStrictEqual([]);
    facts({ hub: "http://h2", machine: "m-1" });
    expect(calls).toStrictEqual([[["s1"], []]]);
    expect(link.stateTimeSent.size).toBe(0);
  });
});

// =============================================================================================
// AC-05 hub acceptance
// =============================================================================================

describe("RL-14 AC-05 hub acceptance", () => {
  it("test_AC05_bad_entries_skipped", async () => {
    const G = await goal(alice);
    const D0 = Math.floor(w.clock / DAY_MS) * DAY_MS;
    const good = { sid: "s-good", step: `${G}.a`, asOf: w.clock, days: [day(D0, { workingMs: 5 })] };
    const bad = [
      { sid: "s-b1", step: `${G}.a`, asOf: w.clock, days: [day(D0 + 1, { workingMs: 5 })] },
      { sid: "s-b2", step: `${G}.a`, asOf: w.clock, days: [day(D0, { workingMs: DAY_MS + 1 })] },
      { sid: "s-b3", step: `${G}.a`, asOf: w.clock, days: [day(D0, { workingMs: DAY_MS, idleMs: 1 })] },
      { sid: "s-b4", step: `${G}.a`, asOf: w.clock + DAY_MS, days: [day(D0 + DAY_MS), day(D0)] },
      { sid: "s-b5", step: "G999.zz", asOf: w.clock, days: [day(D0, { workingMs: 5 })] },
      "nonsense",
    ];
    // bob's session s-bob: alice may not write its row.
    const bob = await w.person("bob", REPO);
    expect((await sync(bob, { sessions: [sess("s-bob")] })).status).toBe(200);
    const r = await sync(alice, {
      events: [{ id: randomUUID(), at: w.clock, type: "session.turn_started", sid: "s-good", step: `${G}.a`, payload: {} }],
      sessions: [sess("s-good", { step: `${G}.a` })],
      stateTime: [...bad, { ...good, sid: "s-bob" }, good],
    });
    expect(r.status).toBe(200);
    expect(r.json.accepted).toBe(1);
    expect((await w.hubStore.listStepTimes({ steps: [`${G}.a`] })).map((x) => x.sid)).toStrictEqual(["s-good"]);
    expect(await w.hubStore.getSession("s-good")).toBeDefined();
  });

  it("test_AC05_too_many_400", async () => {
    const r = await sync(alice, { stateTime: Array.from({ length: 501 }, () => ({})) });
    expect(r.status).toBe(400);
  });
});

// =============================================================================================
// AC-06 card figures, AC-07 absent not zero
// =============================================================================================

describe("RL-14 AC-06 AC-07 cards", () => {
  it("test_AC06_card_figures", async () => {
    const G = await goal(alice, ["a", "b", "c", "d", "e"]);
    const T = w.clock;
    const C1 = "1".repeat(40);
    const steps = await w.hubStore.listSteps({ goal: G });
    const get = (id: string) => steps.find((s) => s.id === `${G}.${id}`) as Step;
    const tel = (durationMs: number, turns: number, cost?: number) => ({ ...calibTel({ runId: randomUUID(), agentKey: "alpha/x", durationMs, ...(cost !== undefined ? { costUsdEstimate: cost } : {}) }), turns });
    const a: Step = { ...get("a"), state: "done", rounds: [{ n: 1, user: "alice", startedAt: T + 1000, finishedAt: T + 61_000, outcome: "done", commit: C1, telemetry: tel(50_000, 7, 0.5) as never }], updatedAt: T + 61_000 };
    const b: Step = {
      ...get("b"),
      state: "done",
      fixCycles: 1,
      rounds: [
        { n: 1, user: "alice", startedAt: T, finishedAt: T + 10_000, outcome: "fail", parked: "max_rounds" },
        { n: 2, user: "alice", startedAt: T + 20_000, finishedAt: T + 30_000, outcome: "done", telemetry: tel(1000, 2) as never },
      ],
      updatedAt: T + 30_000,
    };
    const c: Step = { ...get("c"), state: "claimed", holderUser: "bob", claimedAt: T + 5000, updatedAt: T + 5000 };
    const d: Step = { ...get("d"), state: "dropped", rounds: [{ n: 1, user: "alice", startedAt: T, finishedAt: T + 1000, outcome: "fail" }], updatedAt: T + 2000 };
    const e: Step = { ...get("e"), movedTo: "G99.x", state: "dropped", updatedAt: T };
    await w.hubStore.saveSteps([a, b, c, d, e]);
    await ev("step.taken_over", `${G}.c`, T + 6000);
    for (let i = 0; i < 3; i++) await ev("session.turn_started", `${G}.a`, T + i);
    w.clock = T + 100_000;
    const g = await card(G);
    const by = (id: string) => (g.stepCards as Json[]).find((x) => x.step === `${G}.${id}`);
    expect(by("a")).toMatchObject({ rounds: 1, fails: 0, parks: 0, commits: 1, takeOvers: 0, fixCycles: 0, done: true, firstTryPass: true, runs: 1, runDurationMs: 50_000, runTurns: 7, costUsd: 0.5, turns: 3, startedAt: T + 1000, endAt: T + 61_000, wallMs: 60_000, commit: C1, commitAt: T + 61_000, sessions: [] });
    expect(by("a")).not.toHaveProperty("stateTime");
    expect(by("b")).toMatchObject({ rounds: 2, fails: 1, parks: 1, commits: 0, fixCycles: 1, done: true, firstTryPass: false, runs: 1, runDurationMs: 1000, runTurns: 2, startedAt: T, endAt: T + 30_000, wallMs: 30_000 });
    expect(by("b")).not.toHaveProperty("costUsd");
    expect(by("c")).toMatchObject({ state: "claimed", holder: "bob", takeOvers: 1, startedAt: T + 5000, wallMs: 95_000, done: false, firstTryPass: false });
    expect(by("c")).not.toHaveProperty("endAt");
    expect(by("d")).toMatchObject({ endAt: T + 2000, wallMs: 2000 });
    expect(by("e")).toMatchObject({ movedTo: "G99.x" });
    expect(by("e")).not.toHaveProperty("wallMs");
    // The goal's design step (done in one round when the plan was approved) counts too.
    expect(g.stepCards.map((x: Json) => x.step)).toStrictEqual([`${G}.design`, ...["a", "b", "c", "d", "e"].map((x) => `${G}.${x}`)]);
    expect(g).toMatchObject({ goal: G, steps: 6, done: 3, firstTryPass: 2, rounds: 5, fails: 2, parks: 1, commits: 1, takeOvers: 1, fixCycles: 1, runs: 2, runDurationMs: 51_000, runTurns: 9, costUsd: 0.5, turns: 3, stateTimeSteps: 0, trial: false });
    expect(g.wallMs).toBe(w.clock - (g.createdAt as number));
    expect(g).not.toHaveProperty("stateTime");
    expect(g).not.toHaveProperty("endAt");
  });

  it("test_AC07_absent_not_zero", async () => {
    const G = await goal(alice, ["a", "b"]);
    const D0 = Math.floor(w.clock / DAY_MS) * DAY_MS;
    // An older daemon: a session holding a with no stateTime.
    expect((await sync(alice, { sessions: [sess("s-old", { step: `${G}.a` })] })).status).toBe(200);
    const by = (g: Json, id: string) => (g.stepCards as Json[]).find((x) => x.step === `${G}.${id}`);
    let g = await card(G);
    expect(by(g, "a")).not.toHaveProperty("stateTime");
    expect(by(g, "a").sessions).toStrictEqual([]);
    expect(g).not.toHaveProperty("stateTime");
    // A row of zeros on b: present with zeros.
    expect((await sync(alice, { sessions: [sess("s-new", { step: `${G}.b` })], stateTime: [{ sid: "s-new", step: `${G}.b`, asOf: w.clock, days: [day(D0)] }] })).status).toBe(200);
    g = await card(G);
    expect(by(g, "b").stateTime).toStrictEqual({ workingMs: 0, needsYouMs: 0, idleMs: 0, stalledMs: 0 });
    expect(g.stateTime).toStrictEqual({ workingMs: 0, needsYouMs: 0, idleMs: 0, stalledMs: 0 });
    expect(g.stateTimeSteps).toBe(1);
  });
});

// =============================================================================================
// AC-08 window, AC-09 parameters
// =============================================================================================

describe("RL-14 AC-08 AC-09 window", () => {
  it("test_AC08_window_apportion", async () => {
    const G = await goal(alice, ["a"]);
    const D1 = (Math.floor(w.clock / DAY_MS) + 1) * DAY_MS;
    const D2 = D1 + DAY_MS;
    w.clock = D2 + 6 * HOUR;
    const st = (await w.hubStore.getStep(`${G}.a`)) as Step;
    await w.hubStore.putStepTime({ step: st.id, sid: "s1", goal: G, userId: "alice", machineId: "m", asOf: D2 + 2 * HOUR, days: [day(D1, { workingMs: 4000, needsYouMs: 2000 }), day(D2, { idleMs: 3000 })] });
    const win = async (q: string) => {
      const r = await w.api(alice, "GET", `/v1/efficiency${q}`);
      expect(r.status, JSON.stringify(r.json)).toBe(200);
      return r.json;
    };
    // days=1 on D2: only D2's bucket.
    let r = await win("?days=1");
    expect(r.window).toStrictEqual({ since: D2, until: w.clock + 1 });
    expect(r.total.stateTime).toStrictEqual({ workingMs: 0, needsYouMs: 0, idleMs: 3000, stalledMs: 0 });
    // Whole buckets at midnights.
    r = await win(`?since=${D1}&until=${D2}`);
    expect(r.total.stateTime).toStrictEqual({ workingMs: 4000, needsYouMs: 2000, idleMs: 0, stalledMs: 0 });
    // From noon of D1: half of D1's bucket, all of D2's.
    r = await win(`?since=${D1 + 12 * HOUR}&until=${D2 + DAY_MS}`);
    expect(r.total.stateTime).toStrictEqual({ workingMs: 2000, needsYouMs: 1000, idleMs: 3000, stalledMs: 0 });
    // The current day is cut at as_of (D2 + 2 h): from D2 + 1 h, half of it.
    r = await win(`?since=${D2 + HOUR}&until=${D2 + DAY_MS}`);
    expect(r.total.stateTime).toStrictEqual({ workingMs: 0, needsYouMs: 0, idleMs: 1500, stalledMs: 0 });
    // After as_of: the step is not in the window.
    r = await win(`?since=${D2 + 3 * HOUR}&until=${D2 + DAY_MS}`);
    expect(r.goals).toStrictEqual([]);
    expect(r.total).toMatchObject({ steps: 0, stateTimeSteps: 0 });
    expect(r.total).not.toHaveProperty("stateTime");
  });

  it("test_AC08_window_counts_filters", async () => {
    const G1 = await goal(alice, ["a", "b"]);
    const G2 = await goal(alice, ["a"]);
    const D1 = (Math.floor(w.clock / DAY_MS) + 1) * DAY_MS;
    w.clock = D1 + 12 * HOUR;
    // G1.a: a round, turns, a reopen and a take-over in the window, one turn before it.
    const a = (await w.hubStore.getStep(`${G1}.a`)) as Step;
    await w.hubStore.saveSteps([{ ...a, state: "done", rounds: [{ n: 1, user: "alice", finishedAt: D1 + HOUR, outcome: "done", commit: "2".repeat(40) }], updatedAt: D1 + HOUR }]);
    await ev("session.turn_started", `${G1}.a`, D1 - 1);
    await ev("session.turn_started", `${G1}.a`, D1 + 1);
    await ev("session.turn_started", `${G1}.a`, D1 + 2);
    await ev("step.reopened", `${G1}.a`, D1 + 3);
    await ev("step.taken_over", `${G1}.a`, D1 + 4);
    // G1.b: in another repo, state time only.
    const b = (await w.hubStore.getStep(`${G1}.b`)) as Step;
    await w.hubStore.saveSteps([{ ...b, repo: "beta" }]);
    await w.hubStore.putStepTime({ step: b.id, sid: "s1", goal: G1, userId: "alice", machineId: "m", asOf: D1 + 2 * HOUR, days: [day(D1, { workingMs: 100 })] });
    // G2 is a trial goal with one turn.
    const g2 = await w.hubStore.getGoal(G2);
    await w.hubStore.saveGoal({ ...(g2 as Goal), trial: true });
    await ev("session.turn_started", `${G2}.a`, D1 + 5);
    const get = async (q: string) => (await w.api(alice, "GET", `/v1/efficiency?days=1${q}`)).json;
    const r = await get("&steps=1");
    expect(r.goals.map((g: Json) => g.goal)).toStrictEqual([G1]);
    expect(r.goals[0].stepRows).toStrictEqual([
      { step: `${G1}.a`, repo: REPO, turns: 2, rounds: 1, fails: 0, parks: 0, commits: 1, takeOvers: 1, runs: 0, runDurationMs: 0, runTurns: 0, reopens: 1, done: 1, firstTryPass: 1 },
      { step: `${G1}.b`, repo: "beta", stateTime: { workingMs: 100, needsYouMs: 0, idleMs: 0, stalledMs: 0 }, turns: 0, rounds: 0, fails: 0, parks: 0, commits: 0, takeOvers: 0, runs: 0, runDurationMs: 0, runTurns: 0, reopens: 0, done: 0, firstTryPass: 0 },
    ]);
    expect(r.total).toMatchObject({ steps: 2, turns: 2, rounds: 1, reopens: 1, takeOvers: 1, done: 1, firstTryPass: 1, stateTimeSteps: 1 });
    expect(r.repos.map((x: Json) => [x.repo, x.steps])).toStrictEqual([
      [REPO, 1],
      ["beta", 1],
    ]);
    expect(r.goals[0]).toMatchObject({ steps: 2, turns: 2, stateTimeSteps: 1 });
    expect((await get("")).goals[0]).not.toHaveProperty("stepRows");
    expect((await get("&repo=beta")).total).toMatchObject({ steps: 1, turns: 0 });

    const inc = await get("&trial=include");
    expect(inc.goals.map((g: Json) => g.goal)).toStrictEqual([G2, G1]);
    expect(inc.goals[0].trial).toBe(true);
    expect(inc.total.turns).toBe(3);
    // A step in the window by an event only: its done round finished before the window.
    await ev("session.turn_started", `${G1}.a`, D1 + 3 * HOUR);
    const late = (await w.api(alice, "GET", `/v1/efficiency?since=${D1 + 2 * HOUR}&until=${D1 + 4 * HOUR}&steps=1`)).json;
    expect(late.goals[0].stepRows).toMatchObject([{ step: `${G1}.a`, turns: 1, rounds: 0, done: 0, firstTryPass: 0 }]);
  });

  it("test_AC09_window_params", async () => {
    for (const [q, msg] of [
      ["?days=0", "days must be a whole number from 1 to 90"],
      ["?days=91", "days must be a whole number from 1 to 90"],
      ["?days=x", "days must be a whole number from 1 to 90"],
      ["?days=2&since=1", "days cannot be combined with since or until"],
      ["?since=5&until=5", "since must be before until"],
      [`?since=0&until=${91 * DAY_MS}`, "the window is at most 90 days"],
      ["?since=yesterday", "since must be milliseconds since the epoch or an ISO time"],
      ["?trial=only", "trial must be exclude or include"],
    ] as const) {
      expect(await w.api(alice, "GET", `/v1/efficiency${q}`), q).toStrictEqual({ status: 400, json: { error: msg } });
    }
    const r = await w.api(alice, "GET", "/v1/efficiency");
    expect(r.json.window).toStrictEqual({ since: Math.floor(w.clock / DAY_MS) * DAY_MS - 6 * DAY_MS, until: w.clock + 1 });
  });
});

// =============================================================================================
// AC-10 stuck
// =============================================================================================

describe("RL-14 AC-10 stuck", () => {
  it("test_AC10_stuck_sessions", async () => {
    const G = await goal(alice, ["a", "b", "c"]);
    for (const [sid, id] of [
      ["s-a", "a"],
      ["s-b", "b"],
    ] as const) {
      expect((await w.api(alice, "POST", `/v1/steps/${G}.${id}/claim`, { sid })).status).toBe(200);
    }
    const T = w.clock;
    expect(
      (
        await sync(alice, {
          sessions: [
            sess("s-a", { state: "needs_you", needs: "permission", step: `${G}.a`, stateSince: T }),
            sess("s-b", { state: "needs_you", step: `${G}.b` }),
            // Left on a step it does not hold (c is not claimed).
            sess("s-c", { state: "needs_you", step: `${G}.c`, stateSince: T }),
          ],
        })
      ).status,
    ).toBe(200);
    const stuck = async (q = "") => (await w.api(alice, "GET", `/v1/stuck${q}`)).json;
    w.clock = T + 29 * MIN;
    expect((await stuck()).sessions).toStrictEqual([]);
    w.clock = T + 31 * MIN;
    const s = await stuck();
    expect(s.sessions).toStrictEqual([{ sid: "s-a", user: "alice", machine: w.machineOf(alice), step: `${G}.a`, goal: G, repo: REPO, needs: "permission", since: T, forMs: 31 * MIN, lastSeenAt: T }]);
    expect(s.unmeasured).toBe(1);
    expect(s.repos).toStrictEqual([{ repo: REPO, sessions: 1, steps: 0 }]);
    expect(s.thresholds).toStrictEqual({ needsYouMs: 1_800_000, turns: 40 });
    w.clock = T + 2 * MIN;
    expect((await stuck("?needsYouMs=60000")).sessions).toHaveLength(1);
    for (const [q, msg] of [
      ["?needsYouMs=59999", "needsYouMs must be a whole number from 60000 to 604800000"],
      ["?turns=0", "turns must be a whole number from 1 to 10000"],
      ["?trial=x", "trial must be exclude or include"],
    ] as const) {
      expect(await w.api(alice, "GET", `/v1/stuck${q}`), q).toStrictEqual({ status: 400, json: { error: msg } });
    }
  });

  it("test_AC10_stuck_steps", async () => {
    const G = await goal(alice, ["a", "b", "c"]);
    const T = w.clock;
    const C = "3".repeat(40);
    const steps = ["a", "b", "c"].map((id) => w.hubStore.getStep(`${G}.${id}`));
    const [sa, sb, sc] = (await Promise.all(steps)) as Step[];
    const claimed = (s: Step, rounds: Step["rounds"] = []): Step => ({ ...s, state: "claimed", holderUser: "alice", claimedAt: T, rounds, updatedAt: T });
    await w.hubStore.saveSteps([
      claimed(sa as Step, [{ n: 1, user: "alice", finishedAt: T + 100, outcome: "fail", commit: C }]),
      claimed(sb as Step),
      claimed(sc as Step, [{ n: 1, user: "alice", finishedAt: T + 100_000, outcome: "fail", commit: C }]),
    ]);
    // a: 40 turns after its commit (and 5 before); b: 39 turns, no commit; c: 50 turns all before its commit.
    for (let i = 0; i < 5; i++) await ev("session.turn_started", `${G}.a`, T + i);
    for (let i = 0; i < 40; i++) await ev("session.turn_started", `${G}.a`, T + 1000 + i);
    for (let i = 0; i < 39; i++) await ev("session.turn_started", `${G}.b`, T + i);
    for (let i = 0; i < 50; i++) await ev("session.turn_started", `${G}.c`, T + i);
    const s = (await w.api(alice, "GET", "/v1/stuck")).json;
    expect(s.steps).toStrictEqual([{ step: `${G}.a`, goal: G, repo: REPO, holder: "alice", turns: 40, commit: C, commitAt: T + 100, claimedAt: T }]);
    expect(s.repos).toStrictEqual([{ repo: REPO, sessions: 0, steps: 1 }]);
    expect((await w.api(alice, "GET", "/v1/stuck?turns=39")).json.steps.map((x: Json) => x.step)).toStrictEqual([`${G}.a`, `${G}.b`]);
    // A trial goal's step only with trial=include.
    await w.hubStore.saveGoal({ ...((await w.hubStore.getGoal(G)) as Goal), trial: true });
    expect((await w.api(alice, "GET", "/v1/stuck")).json.steps).toStrictEqual([]);
    expect((await w.api(alice, "GET", "/v1/stuck?trial=include")).json.steps).toHaveLength(1);
    expect((await w.api(alice, "GET", "/v1/stuck?trial=include&repo=beta")).json.steps).toHaveLength(0);
  });
});

// =============================================================================================
// AC-11 scopes, no writes, features
// =============================================================================================

describe("RL-14 AC-11 scopes", () => {
  it("test_AC11_auth_no_writes_features", async () => {
    const G = await goal(alice);
    const svc = w.hub.svc;
    const withScope = await svc.serviceToken("dash", ["goals:read"]);
    const without = await svc.serviceToken("other", []);
    const evBefore = (await w.hubStore.events(0, 100_000)).length;
    const stepsBefore = JSON.stringify(await w.hubStore.listSteps({}));
    for (const path of [`/v1/goals/${G}/efficiency`, "/v1/efficiency", "/v1/stuck"]) {
      expect((await w.call(withScope, "GET", path)).status, path).toBe(200);
      expect((await w.call(without, "GET", path)).status, path).toBe(403);
      expect((await w.call(undefined, "GET", path)).status, path).toBe(401);
      expect(await w.call(withScope, "GET", path, undefined, { "x-mesh-on-behalf-of": "alice" }), path).toStrictEqual({ status: 400, json: { error: "on-behalf-of is not accepted on this route", code: "on-behalf-of-not-accepted" } });
    }
    expect(await w.call(withScope, "GET", "/v1/goals/G999/efficiency")).toStrictEqual({ status: 404, json: { error: "no goal G999" } });
    expect((await w.hubStore.events(0, 100_000)).length).toBe(evBefore);
    expect(JSON.stringify(await w.hubStore.listSteps({}))).toBe(stepsBefore);
    const f = (await w.call(undefined, "GET", "/healthz")).json.features as string[];
    expect(f).toContain("efficiency");
    expect(f).toStrictEqual([...f].sort());
    expect(HUB_FEATURES).toContain("efficiency");
  });
});

// =============================================================================================
// AC-14 not held
// =============================================================================================

describe("RL-14 AC-14 not held", () => {
  it("test_AC14_take_over", async () => {
    const root = await w.person("root", REPO);
    const G = await goal(alice);
    const A = await hold(alice, 100, `${G}.a`);
    w.clock += 10_000;
    await w.flush();
    w.hook(root, "SessionStart", 200);
    const B = w.session(root, 200);
    const t = await w.api(root, "POST", `/v1/steps/${G}.a/take`, { sid: B.sid });
    expect(t.status, JSON.stringify(t.json)).toBe(200);
    const takenAt = w.clock;
    await w.flush();
    const reply = alice.syncs.at(-1);
    expect(reply).toBeDefined();
    expect(w.session(alice, 100).stateTime?.notHeld).toStrictEqual([`${G}.a`]);
    w.clock += HOUR;
    alice.daemon.tick();
    expect(w.session(alice, 100).state).toBe("stalled");
    w.clock += 5000;
    await w.flush();
    const row = await rowOf(`${G}.a`, A.sid);
    expect(sum(row?.days[0])).toBe(takenAt - (A.stateTime?.since ?? 0));
    // The hub does not list A as stuck either.
    const st = (await w.api(alice, "GET", "/v1/stuck?needsYouMs=60000")).json;
    expect(st.sessions).toStrictEqual([]);
  });

  it("test_AC14_cli_take_restart_reclaim", async () => {
    const root = await w.person("root", REPO);
    const G = await goal(alice);
    const A = await hold(alice, 100, `${G}.a`);
    const T = w.clock;
    w.clock += 10_000;
    // A CLI take (no sid) by another person.
    expect((await w.api(root, "POST", `/v1/steps/${G}.a/take`, {})).status).toBe(200);
    await w.flush();
    expect(w.session(alice, 100).stateTime?.notHeld).toStrictEqual([`${G}.a`]);
    const marked = sum((await rowOf(`${G}.a`, A.sid))?.days[0]);
    expect(marked).toBe(10_000);
    // A restart keeps the mark: the hour adds nothing.
    await w.restart(alice);
    w.clock += HOUR;
    alice.daemon.tick();
    await w.flush();
    expect(sum((await rowOf(`${G}.a`, A.sid))?.days[0])).toBe(10_000);
    // Alice takes it back for A: the mark clears at the next reply, accrual restarts there.
    expect((await w.api(alice, "POST", `/v1/steps/${G}.a/take`, { sid: A.sid })).status).toBe(200);
    await w.flush();
    const back = w.clock;
    expect(w.session(alice, 100).stateTime?.notHeld).toBeUndefined();
    w.clock += 7000;
    await w.flush();
    w.clock += STATE_EVERY;
    await w.flush();
    expect(sum((await rowOf(`${G}.a`, A.sid))?.days[0])).toBe(10_000 + (w.clock - back));
    expect(T).toBeLessThan(back);
  });

  it("test_AC14_headless_held", async () => {
    const G = await goal(alice);
    // A step with no holder session, held by alice on her machine (a headless accept, or a CLI take with {}).
    expect((await w.api(alice, "POST", `/v1/steps/${G}.a/claim`, {})).status).toBe(200);
    const st = (await w.hubStore.getStep(`${G}.a`)) as Step;
    expect(st.holderSid).toBeUndefined();
    const m = w.machineOf(alice);
    expect(heldBy(st, "any-run-sid", "alice", m)).toBe(true);
    expect(heldBy(st, "any-run-sid", "bob", m)).toBe(false);
    expect(heldBy({ ...st, holderMachine: "m-other" }, "x", "alice", m)).toBe(false);
    expect(heldBy({ ...st, holderSid: "s1" }, "s2", "alice", m)).toBe(false);
    expect(heldBy({ ...st, state: "done" }, "x", "alice", m)).toBe(false);
    const r = await sync(alice, { sessions: [sess("s-run", { state: "working", kind: "print", step: `${G}.a` })] });
    expect(r.json.notHeld).toStrictEqual([]);
  });
});

describe("RL-14 AC-14 release and unknown steps", () => {
  it("test_AC14_drop_and_unknown", async () => {
    const G = await goal(alice);
    const A = await hold(alice, 100, `${G}.a`);
    w.clock += 10_000;
    await w.flush();
    expect(w.session(alice, 100).stateTime?.notHeld).toBeUndefined();
    // An admin releases the step A holds (a goal with held steps cannot be dropped).
    const root = await w.person("root", REPO);
    const rel = await w.api(root, "POST", `/v1/steps/${G}.a/release`, {});
    expect(rel.status, JSON.stringify(rel.json)).toBe(200);
    const dropped = w.clock;
    await w.flush();
    expect(w.session(alice, 100).stateTime?.notHeld).toStrictEqual([`${G}.a`]);
    w.clock += HOUR;
    alice.daemon.tick();
    await w.flush();
    expect(sum((await rowOf(`${G}.a`, A.sid))?.days[0])).toBe(dropped - (A.stateTime?.since ?? 0));
    // No step holder in the body: no notHeld key. An unknown step: listed.
    expect((await sync(alice, { sessions: [sess("s-free")] })).json).not.toHaveProperty("notHeld");
    expect((await sync(alice, { sessions: [sess("s-gone", { step: "G999.x" })] })).json.notHeld).toStrictEqual([{ sid: "s-gone", step: "G999.x" }]);
  });

  it("test_AC14_holder_row_grows", async () => {
    const root = await w.person("root", REPO);
    const G = await goal(alice);
    await hold(alice, 100, `${G}.a`);
    w.clock += 1000;
    w.hook(root, "SessionStart", 200);
    const B = w.session(root, 200);
    expect((await w.api(root, "POST", `/v1/steps/${G}.a/take`, { sid: B.sid })).status).toBe(200);
    // root's daemon binds the step to B as a claim from that session would.
    root.daemon.update(B.sid, { step: `${G}.a` });
    w.clock += 30_000;
    await w.flush();
    const first = sum((await rowOf(`${G}.a`, B.sid))?.days[0]);
    w.clock += STATE_EVERY;
    await w.flush();
    expect(sum((await rowOf(`${G}.a`, B.sid))?.days[0])).toBe(first + STATE_EVERY);
    expect(w.session(root, 200).stateTime?.notHeld).toBeUndefined();
  });
});

const STATE_EVERY = 60_000;
