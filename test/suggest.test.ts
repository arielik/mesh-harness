// MM-4 "Suggest and convenience" end to end: a real hub (World), bare machines fed through
// POST /v1/sync, daemons for messages and maxSessions, and the CLI against them.
// Criteria AC-01 to AC-09, AC-11 to AC-13. Written from the spec's contracts only
// (docs/specs/MM-4.md). Suggestions are found by machine id, steps by id, messages by kind + toSid +
// text; order is asserted only where the rank key decides it.

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { dispatch } from "../src/cli/commands.ts";
import type { CliEnv } from "../src/cli/context.ts";
import { meshCommands } from "../src/cli/mesh-commands.ts";
import { resolvePaths, type DaemonConfig, type Session } from "../src/protocol/index.ts";
import { World, type Json, type Person } from "./helpers/world.ts";

// Copied from the spec, not imported, so a changed text turns the tests red.
const OLD_HUB = "the hub does not offer suggestions (it needs v0.1.13 or later)";
const SENT = (to: string) => `Sent to ${to}; mesh delivers it as soon as the session can take it.`;
const SAY_USAGE = "usage: mesh say <session> <text>\n       mesh say <machine>/<session> <text>";
const NOT_STARTING = (step: string, n: number, max: number) => `not starting a session for offered step ${step}: ${n} live sessions, maxSessions ${max}`;
const SUGGESTION_KEYS = ["auto", "idle", "lastSeen", "machine", "machineLabels", "name", "online", "reason", "repo", "sessionLabels", "to", "user"];

const R_A = "git.example.com/org/alpha";
const R_B = "git.example.com/org/beta";
const R_Z = "git.example.com/org/zeta";
const repoOf = (id: string) => ({ id, name: id.slice(id.lastIndexOf("/") + 1) });

let w: World;
const dirs: string[] = [];
const servers: Server[] = [];
afterEach(async () => {
  await w?.stop();
  for (const s of servers.splice(0)) await new Promise((r) => s.close(r));
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(cond: () => boolean | Promise<boolean>, ms = 2_000): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await cond()) return true;
    await sleep(10);
  }
  return cond();
}

async function world(): Promise<World> {
  w = new World();
  await w.start(["alice", "bob", "carol", "root"], { admins: ["root"] });
  return w;
}

// ---------------------------------------------------------------------------------------------
// Bare machines: a login (a device token bound to its own machine) and no daemon. The test states
// the machine's whole hub state with each sync.

interface Bare {
  user: string;
  token: string;
  machine: string;
}

async function bare(user: string, hostname: string): Promise<Bare> {
  const l = await w.login(user, { hostname });
  expect(l.machine, `machine id for ${hostname}`).toBeTruthy();
  return { user, token: l.token, machine: l.machine as string };
}

let sids = 0;
/** A session record as a daemon syncs it (repo alpha, idle, step-less unless stated). */
const sess = (sid: string, over: Partial<Session> = {}): Session => ({
  sid,
  claudeSessionIds: [`c-${sid}`],
  cwd: `/w/${sid}`,
  kind: "interactive",
  state: "idle",
  quiet: false,
  startedAt: w.clock - 10_000,
  lastEventAt: w.clock,
  turns: 1,
  humanPrompts: 1,
  seenByReconciler: true,
  repo: repoOf(R_A),
  ...over,
});
/** A fresh sid (unique in the hub), with a readable prefix. */
const sid = (p = "s") => `${p}-${String(++sids).padStart(4, "0")}-x`;

interface SyncOpts {
  share?: DaemonConfig["shareSessions"];
  repos?: string[];
  /** Default `["self"]`; `null`: the sync carries no policy. */
  accept?: string[] | null;
  sessions?: Session[];
}
async function sync(m: Bare, o: SyncOpts = {}): Promise<void> {
  const accept = o.accept === undefined ? ["self"] : o.accept;
  const machine = { share: o.share ?? "me", ...(o.repos ? { repos: o.repos.map(repoOf) } : {}), ...(accept ? { accept } : {}) };
  const r = await w.call(m.token, "POST", "/v1/sync", { events: [], counts: {}, sessions: o.sessions ?? [], machine });
  expect(r.status, JSON.stringify(r.json)).toBe(200);
}
async function mlabels(m: Bare, labels: string[]): Promise<void> {
  const r = await w.call(m.token, "POST", `/v1/machines/${m.machine}/labels`, { labels });
  expect(r.status, JSON.stringify(r.json)).toBe(200);
}
async function nickname(m: Bare | Person, n: string): Promise<void> {
  const token = "token" in m ? m.token : m.login.token;
  const id = "machine" in m ? m.machine : w.machineOf(m);
  const r = await w.call(token, "POST", `/v1/machines/${id}/name`, { nickname: n });
  expect(r.status, JSON.stringify(r.json)).toBe(200);
}
async function topic(token: string, name: string): Promise<void> {
  const r = await w.call(token, "POST", "/v1/topics", { name });
  expect([201, 409], JSON.stringify(r.json)).toContain(r.status);
}

const suggestPath = (target: string, q = "") => `${target.includes(".") ? `/v1/steps/${target}` : `/v1/goals/${target}`}/suggest${q}`;
const suggest = (token: string, target: string, q = "") => w.call(token, "GET", suggestPath(target, q));
/** A 200 suggest reply (fails the test otherwise). */
async function view(token: string, target: string, q = ""): Promise<Json> {
  const r = await suggest(token, target, q);
  expect(r.status, JSON.stringify(r.json)).toBe(200);
  expect(Array.isArray(r.json?.suggestions), JSON.stringify(r.json)).toBe(true);
  return r.json;
}
const byMachine = (v: Json, id: string): Json => (v?.suggestions ?? []).find((s: Json) => s.machine === id);
const machineSet = (v: Json): string[] => (v.suggestions as Json[]).map((s) => s.machine as string).sort();

interface StepIn {
  id: string;
  repo?: string;
  deps?: string[];
  kind?: string;
}
/** A goal of `token`'s user; with steps, a plan with them is approved at once. */
async function goal(token: string, steps: StepIn[], o: { topics?: string[]; primaryRepo?: string } = {}): Promise<string> {
  const g = await w.call(token, "POST", "/v1/goals", { title: "Suggest goal", ...(o.primaryRepo ? { primaryRepo: o.primaryRepo } : {}), ...(o.topics ? { topics: o.topics } : {}) });
  expect(g.status, JSON.stringify(g.json)).toBe(201);
  const G = g.json.id as string;
  if (steps.length) {
    const plan = steps.map((s) => ({ id: s.id, repo: s.repo ?? R_A, kind: s.kind ?? "implement", title: `Title ${s.id}`, brief: "b", deps: s.deps ?? [], ...(s.kind === "gate" ? { gate: "R1" } : {}) }));
    const p = await w.call(token, "POST", `/v1/goals/${G}/plan`, { steps: plan, approve: true });
    expect(p.status, JSON.stringify(p.json)).toBe(201);
  }
  return G;
}
async function stepOf(token: string, id: string): Promise<Json> {
  const r = await w.call(token, "GET", `/v1/steps/${id}`);
  expect(r.status, JSON.stringify(r.json)).toBe(200);
  return r.json.context.step;
}
async function goalDetail(token: string, G: string): Promise<Json> {
  const r = await w.call(token, "GET", `/v1/goals/${G}`);
  expect(r.status, JSON.stringify(r.json)).toBe(200);
  return r.json;
}
const allEvents = async (): Promise<Json[]> => w.hub.svc.store.events(0, 100_000);

/** Goal `G` of the cast: topics perf; s1 (alpha), s2 (beta), gate g, s3 blocked on s1 (zeta). */
async function castGoal(token: string): Promise<string> {
  await topic(token, "perf");
  return goal(token, [{ id: "s1", repo: R_A }, { id: "s2", repo: R_B }, { id: "g", kind: "gate", repo: R_A }, { id: "s3", repo: R_Z, deps: ["s1"] }], { topics: ["perf"] });
}

/** Two of `user`'s bare machines, as [larger id, smaller id]. */
async function two(user: string): Promise<[Bare, Bare]> {
  const x = await bare(user, `${user}-x-${++sids}`);
  const y = await bare(user, `${user}-y-${++sids}`);
  return x.machine > y.machine ? [x, y] : [y, x];
}

// ---------------------------------------------------------------------------------------------

describe("AC-01 suggest filter", () => {
  async function cast() {
    await world();
    const A = await bare("alice", "h-a");
    const B = await bare("alice", "h-b");
    const C = await bare("alice", "h-c");
    const D = await bare("bob", "h-d");
    const E = await bare("bob", "h-e");
    const G = await castGoal(A.token);
    await sync(A, { repos: [R_A] });
    await sync(B, { repos: [R_B], sessions: [sess(sid("b"), { repo: repoOf(R_B) })] });
    const cs = sid("c");
    await sync(C, { sessions: [sess(cs)] });
    await sync(D, { repos: [R_A] });
    await sync(E, { repos: [R_B] });
    return { A, B, C, D, E, G, cs };
  }

  it("test_AC01_default_filter", async () => {
    const k = await cast();
    const v = await view(k.A.token, `${k.G}.s1`);
    expect(machineSet(v)).toStrictEqual([k.A.machine, k.C.machine].sort());
    expect(byMachine(v, k.B.machine)).toBeUndefined();
    expect(byMachine(v, k.D.machine)).toBeUndefined();
    expect(byMachine(v, k.E.machine)).toBeUndefined();
  });

  it("test_AC01_any_keeps_all", async () => {
    const k = await cast();
    const v = await view(k.A.token, `${k.G}.s1`, "?any=1");
    expect(machineSet(v)).toStrictEqual([k.A.machine, k.B.machine, k.C.machine].sort());
    expect(byMachine(v, k.B.machine).repo).toBe(false);
    expect(byMachine(v, k.A.machine).repo).toBe(true);
    expect(byMachine(v, k.C.machine).repo).toBe(true);
    expect(v.any).toBe(true);
  });

  it("test_AC01_team_adds_others", async () => {
    const k = await cast();
    const v = await view(k.A.token, `${k.G}.s1`, "?team=1");
    expect(machineSet(v)).toStrictEqual([k.A.machine, k.C.machine, k.D.machine].sort());
    expect(v.team).toBe(true);
    const all = await view(k.A.token, `${k.G}.s1`, "?team=1&any=1");
    expect(machineSet(all)).toStrictEqual([k.A.machine, k.B.machine, k.C.machine, k.D.machine, k.E.machine].sort());
    expect(byMachine(all, k.E.machine).repo).toBe(false);
  });

  it("test_AC01_flag_values", async () => {
    const k = await cast();
    for (const q of ["?team=true", "?any=yes", "?team=0", "?any=0&team=on"]) {
      const v = await view(k.A.token, `${k.G}.s1`, q);
      expect(v.team, q).toBe(false);
      expect(v.any, q).toBe(false);
      expect(machineSet(v), q).toStrictEqual([k.A.machine, k.C.machine].sort());
    }
  });

  it("test_AC01_view_fields", async () => {
    const k = await cast();
    const v = await view(k.A.token, `${k.G}.s1`, "?team=1");
    expect(v.target).toBe(`${k.G}.s1`);
    expect(v.steps).toStrictEqual([`${k.G}.s1`]);
    expect(v.repos).toStrictEqual([R_A]);
    expect(v.topics).toStrictEqual(["perf"]);
    expect(v.team).toBe(true);
    expect(v.any).toBe(false);
    expect(Object.keys(v).sort()).toStrictEqual(["any", "repos", "steps", "suggestions", "target", "team", "topics"]);
    for (const s of v.suggestions as Json[]) {
      const want = s.idle > 0 ? [...SUGGESTION_KEYS, "session"].sort() : SUGGESTION_KEYS;
      expect(Object.keys(s).sort(), s.machine).toStrictEqual(want);
    }
    // C has an idle session in alpha: its session key is there (positive control for the key check).
    expect(byMachine(v, k.C.machine).session).toBe(k.cs);
    expect(Object.hasOwn(byMachine(v, k.A.machine), "session")).toBe(false);
  });

  it("test_AC01_step_without_goal_topics", async () => {
    const k = await cast();
    const H = await goal(k.A.token, [{ id: "s1", repo: R_A }]);
    const v = await view(k.A.token, `${H}.s1`);
    expect(v.topics).toStrictEqual([]);
    expect(v.repos).toStrictEqual([R_A]);
  });
});

// ---------------------------------------------------------------------------------------------

describe("AC-02 rank", () => {
  const OFF = 200_000;

  /** The pair's rows from a suggest reply; asserts both are there. */
  function rows(v: Json, win: Bare, lose: Bare): { W: Json; L: Json; order: string[] } {
    const W = byMachine(v, win.machine);
    const L = byMachine(v, lose.machine);
    expect(W, "winner listed").toBeDefined();
    expect(L, "loser listed").toBeDefined();
    const order = (v.suggestions as Json[]).map((s) => s.machine).filter((m) => m === win.machine || m === lose.machine);
    return { W, L, order };
  }

  async function setup() {
    await world();
    const caller = await bare("alice", "alice-caller");
    const G = await castGoal(caller.token);
    return { caller, S: `${G}.s1` };
  }

  it("test_AC02_auto", async () => {
    const { caller, S } = await setup();
    const [win, lose] = await two("alice");
    await sync(win, { accept: ["self"] });
    w.clock += OFF;
    await mlabels(lose, ["alpha"]);
    await sync(lose, { accept: ["off"], repos: [R_A], sessions: [sess(sid("l"), { labels: ["perf"] }), sess(sid("l"))] });
    const { W, L, order } = rows(await view(caller.token, S, "?any=1"), win, lose);
    expect(W).toMatchObject({ auto: true, repo: false, sessionLabels: [], machineLabels: [], online: false, idle: 0 });
    expect(L).toMatchObject({ auto: false, repo: true, sessionLabels: ["perf"], machineLabels: ["alpha"], online: true, idle: 2 });
    expect(L.lastSeen).toBeGreaterThan(W.lastSeen);
    expect(order).toStrictEqual([win.machine, lose.machine]);
  });

  it("test_AC02_repo", async () => {
    const { caller, S } = await setup();
    const [win, lose] = await two("alice");
    await sync(win, { repos: [R_A] });
    w.clock += OFF;
    await mlabels(lose, ["perf", "alpha"]);
    await sync(lose, {});
    const { W, L, order } = rows(await view(caller.token, S, "?any=1"), win, lose);
    expect(W).toMatchObject({ auto: true, repo: true, sessionLabels: [], machineLabels: [], online: false, idle: 0 });
    expect(L).toMatchObject({ auto: true, repo: false, sessionLabels: [], machineLabels: ["alpha", "perf"], online: true, idle: 0 });
    expect(L.lastSeen).toBeGreaterThan(W.lastSeen);
    expect(order).toStrictEqual([win.machine, lose.machine]);
  });

  it("test_AC02_session_labels", async () => {
    const { caller, S } = await setup();
    const [win, lose] = await two("alice");
    await sync(win, { repos: [R_A], sessions: [sess(sid("w"), { labels: ["alpha", "perf"] })] });
    w.clock += OFF;
    await mlabels(lose, ["perf", "alpha"]);
    await sync(lose, { repos: [R_A], sessions: [sess(sid("l"), { labels: ["perf"] }), sess(sid("l")), sess(sid("l"))] });
    const { W, L, order } = rows(await view(caller.token, S), win, lose);
    expect(W).toMatchObject({ auto: true, repo: true, sessionLabels: ["alpha", "perf"], machineLabels: [], online: false, idle: 1 });
    expect(L).toMatchObject({ auto: true, repo: true, sessionLabels: ["perf"], machineLabels: ["alpha", "perf"], online: true, idle: 3 });
    expect(L.lastSeen).toBeGreaterThan(W.lastSeen);
    expect(order).toStrictEqual([win.machine, lose.machine]);
  });

  it("test_AC02_machine_labels", async () => {
    const { caller, S } = await setup();
    const [win, lose] = await two("alice");
    await mlabels(win, ["perf", "alpha"]);
    await sync(win, { repos: [R_A] });
    w.clock += OFF;
    await mlabels(lose, ["perf"]);
    await sync(lose, { repos: [R_A], sessions: [sess(sid("l"), { labels: ["other"] }), sess(sid("l"), { labels: ["other"] })] });
    const { W, L, order } = rows(await view(caller.token, S), win, lose);
    expect(W).toMatchObject({ auto: true, repo: true, sessionLabels: [], machineLabels: ["alpha", "perf"], online: false, idle: 0 });
    expect(L).toMatchObject({ auto: true, repo: true, sessionLabels: [], machineLabels: ["perf"], online: true, idle: 2 });
    expect(L.lastSeen).toBeGreaterThan(W.lastSeen);
    expect(order).toStrictEqual([win.machine, lose.machine]);
  });

  it("test_AC02_online", async () => {
    const { caller, S } = await setup();
    const [win, lose] = await two("alice");
    await sync(lose, { repos: [R_A], sessions: [sess(sid("l")), sess(sid("l"))] });
    w.clock += OFF;
    await sync(win, { repos: [R_A] });
    const { W, L, order } = rows(await view(caller.token, S), win, lose);
    expect(W).toMatchObject({ auto: true, repo: true, sessionLabels: [], machineLabels: [], online: true, idle: 0 });
    expect(L).toMatchObject({ auto: true, repo: true, sessionLabels: [], machineLabels: [], online: false, idle: 2 });
    expect(order).toStrictEqual([win.machine, lose.machine]);
  });

  it("test_AC02_idle", async () => {
    const { caller, S } = await setup();
    const [win, lose] = await two("alice");
    await sync(win, { repos: [R_A], sessions: [sess(sid("w")), sess(sid("w"))] });
    w.clock += 10_000;
    await sync(lose, { repos: [R_A], sessions: [sess(sid("l"))] });
    const { W, L, order } = rows(await view(caller.token, S), win, lose);
    expect(W).toMatchObject({ auto: true, repo: true, sessionLabels: [], machineLabels: [], online: true, idle: 2 });
    expect(L).toMatchObject({ auto: true, repo: true, sessionLabels: [], machineLabels: [], online: true, idle: 1 });
    expect(L.lastSeen).toBeGreaterThan(W.lastSeen);
    expect(order).toStrictEqual([win.machine, lose.machine]);
  });

  it("test_AC02_last_seen", async () => {
    const { caller, S } = await setup();
    const [win, lose] = await two("alice");
    await sync(lose, { repos: [R_A] });
    w.clock += 10_000;
    await sync(win, { repos: [R_A] });
    const { W, L, order } = rows(await view(caller.token, S), win, lose);
    expect(W).toMatchObject({ auto: true, repo: true, online: true, idle: 0, sessionLabels: [], machineLabels: [] });
    expect(L).toMatchObject({ auto: true, repo: true, online: true, idle: 0, sessionLabels: [], machineLabels: [] });
    expect(W.lastSeen).toBeGreaterThan(L.lastSeen);
    expect(order).toStrictEqual([win.machine, lose.machine]);
  });

  it("test_AC02_machine_id", async () => {
    const { caller, S } = await setup();
    const [big, small] = await two("alice");
    await sync(big, { repos: [R_A] });
    await sync(small, { repos: [R_A] });
    const { W, L, order } = rows(await view(caller.token, S), small, big);
    expect(W.lastSeen).toBe(L.lastSeen);
    expect(W).toMatchObject({ auto: L.auto, repo: L.repo, online: L.online, idle: L.idle });
    expect(order).toStrictEqual([small.machine, big.machine]);
  });

  it("test_AC02_auto_team", async () => {
    const { caller, S } = await setup();
    const [win, lose] = await two("bob");
    await sync(win, { accept: ["user:alice"], repos: [R_A] });
    w.clock += OFF;
    await mlabels(lose, ["perf"]);
    await sync(lose, { accept: ["self"], repos: [R_A] });
    const { W, L, order } = rows(await view(caller.token, S, "?team=1"), win, lose);
    expect(W).toMatchObject({ auto: true, repo: true, online: false, machineLabels: [] });
    expect(L).toMatchObject({ auto: false, repo: true, online: true, machineLabels: ["perf"] });
    expect(order).toStrictEqual([win.machine, lose.machine]);
  });
});

// ---------------------------------------------------------------------------------------------

describe("AC-03 suggestion fields", () => {
  async function setup(o: SyncOpts = {}) {
    await world();
    const caller = await bare("alice", "alice-caller");
    const G = await castGoal(caller.token);
    const M = await bare("alice", "h-m");
    await sync(M, { repos: [R_A], ...o });
    return { caller, M, S: `${G}.s1`, G };
  }

  it("test_AC03_idle_counts_only_candidates", async () => {
    await world();
    const caller = await bare("alice", "alice-caller");
    const G = await castGoal(caller.token);
    const M = await bare("alice", "h-m");
    const i = Array.from({ length: 7 }, (_, n) => sid(`i${n + 1}`));
    await sync(M, {
      repos: [R_A],
      sessions: [
        sess(i[0] as string),
        sess(i[1] as string, { step: "X9.s1" }),
        sess(i[2] as string, { launching: true }),
        sess(i[3] as string, { state: "working" }),
        sess(i[4] as string, { repo: repoOf(R_B) }),
        sess(i[5] as string, { state: "ended", endedAt: w.clock }),
        sess(i[6] as string),
      ],
    });
    const s = byMachine(await view(caller.token, `${G}.s1`), M.machine);
    expect(s.idle).toBe(2);
    expect([i[0], i[6]]).toContain(s.session);
  });

  it("test_AC03_best_by_labels", async () => {
    const { caller, M, S } = await setup();
    const [p1, p2] = [sid("p1"), sid("p2")];
    await sync(M, { repos: [R_A], sessions: [sess(p1, { labels: ["perf"], lastEventAt: 20 }), sess(p2, { labels: ["alpha", "perf"], lastEventAt: 10 })] });
    const s = byMachine(await view(caller.token, S), M.machine);
    expect(s.idle).toBe(2);
    expect(s.session).toBe(p2);
    expect(s.sessionLabels).toStrictEqual(["alpha", "perf"]);
  });

  it("test_AC03_best_tie_last_event", async () => {
    const { caller, M, S } = await setup();
    const [old, young] = [sid("aa"), sid("zz")];
    await sync(M, { repos: [R_A], sessions: [sess(old, { labels: ["perf"], lastEventAt: 10 }), sess(young, { labels: ["perf"], lastEventAt: 20 })] });
    expect(byMachine(await view(caller.token, S), M.machine).session).toBe(young);
  });

  it("test_AC03_best_tie_sid", async () => {
    const { caller, M, S } = await setup();
    const upper = `B-${sid("t")}`;
    const lower = `a-${sid("t")}`;
    await sync(M, { repos: [R_A], sessions: [sess(lower, { lastEventAt: 10 }), sess(upper, { lastEventAt: 10 })] });
    expect(byMachine(await view(caller.token, S), M.machine).session).toBe(upper);
  });

  it("test_AC03_session_labels_intersection", async () => {
    const { caller, M, S } = await setup();
    const s1 = sid("l");
    await sync(M, { repos: [R_A], sessions: [sess(s1, { labels: ["zzz", "perf", "alpha", "x"] })] });
    const s = byMachine(await view(caller.token, S), M.machine);
    expect(s.session).toBe(s1);
    expect(s.sessionLabels).toStrictEqual(["alpha", "perf"]);
  });

  it("test_AC03_no_idle_no_session", async () => {
    const { caller, M, S } = await setup();
    await sync(M, { repos: [R_A], sessions: [sess(sid("i4"), { state: "working", labels: ["perf"] })] });
    const s = byMachine(await view(caller.token, S), M.machine);
    expect(s).toBeDefined();
    expect(s.idle).toBe(0);
    expect("session" in s).toBe(false);
    expect(s.sessionLabels).toStrictEqual([]);
  });

  it("test_AC03_machine_labels_intersection", async () => {
    const { caller, M, S } = await setup();
    await mlabels(M, ["gpu", "perf", "alpha"]);
    expect(byMachine(await view(caller.token, S), M.machine).machineLabels).toStrictEqual(["alpha", "perf"]);
  });

  it("test_AC03_online_boundary", async () => {
    await world();
    const caller = await bare("alice", "alice-caller");
    const G = await castGoal(caller.token);
    const M = await bare("alice", "h-m");
    const N = await bare("alice", "h-n");
    const t0 = w.clock;
    await sync(M, { repos: [R_A] });
    w.clock = t0 + 1;
    await sync(N, { repos: [R_A] });
    w.clock = t0 + 120_000;
    const v = await view(caller.token, `${G}.s1`);
    expect(byMachine(v, N.machine)).toMatchObject({ online: true, lastSeen: t0 + 1 });
    expect(byMachine(v, M.machine)).toMatchObject({ online: false, lastSeen: t0 });
  });

  it("test_AC03_auto_self_own", async () => {
    const { caller, M, S } = await setup({ accept: ["self"] });
    expect(byMachine(await view(caller.token, S), M.machine).auto).toBe(true);
  });

  it("test_AC03_auto_bob_self", async () => {
    const { M, S } = await setup({ accept: ["self"] });
    const bob = await bare("bob", "bob-caller");
    const s = byMachine(await view(bob.token, S, "?team=1"), M.machine);
    expect(s).toBeDefined();
    expect(s.auto).toBe(false);
  });

  it("test_AC03_auto_user_rule", async () => {
    const { M, S } = await setup({ accept: ["user:bob"] });
    const bob = await bare("bob", "bob-caller");
    expect(byMachine(await view(bob.token, S, "?team=1"), M.machine).auto).toBe(true);
  });

  it("test_AC03_auto_off", async () => {
    const { caller, M, S } = await setup({ accept: ["off"] });
    const s = byMachine(await view(caller.token, S), M.machine);
    expect(s, "an off machine is still listed").toBeDefined();
    expect(s.auto).toBe(false);
  });

  it("test_AC03_auto_no_policy", async () => {
    const { caller, M, S } = await setup({ accept: null });
    const fleet = (await w.call(M.token, "GET", "/v1/fleet")).json;
    expect(Object.hasOwn(fleet.machines.find((m: Json) => m.id === M.machine), "accept")).toBe(false);
    expect(byMachine(await view(caller.token, S), M.machine).auto).toBe(false);
  });

  it("test_AC03_auto_machine_rule", async () => {
    await world();
    const caller = await bare("alice", "alice-caller");
    const G = await castGoal(caller.token);
    const M = await bare("alice", "h-m");
    const Bb = await bare("bob", "bob-b");
    const Bo = await bare("bob", "bob-other");
    await sync(M, { repos: [R_A], accept: [`machine:${Bb.machine}`] });
    expect(byMachine(await view(Bb.token, `${G}.s1`, "?team=1"), M.machine).auto).toBe(true);
    expect(byMachine(await view(Bo.token, `${G}.s1`, "?team=1"), M.machine).auto).toBe(false);
  });

  it("test_AC03_user_and_name", async () => {
    const { caller, M, S } = await setup();
    await nickname(M, "lab");
    const N = await bare("alice", "h-n");
    await sync(N, { repos: [R_A] });
    const v = await view(caller.token, S);
    expect(byMachine(v, M.machine)).toMatchObject({ user: "alice", name: "lab" });
    expect(byMachine(v, N.machine)).toMatchObject({ user: "alice", name: "h-n" });
  });
});

// ---------------------------------------------------------------------------------------------

describe("AC-04 privacy with team=1", () => {
  async function setup(share: DaemonConfig["shareSessions"], o: { inventory?: boolean; step?: string } = {}) {
    await world();
    const caller = await bare("alice", "alice-caller");
    const G = await castGoal(caller.token);
    const Bm = await bare("bob", "bob-bm");
    const bs = sid("bs");
    await sync(Bm, { share, ...(o.inventory === false ? {} : { repos: [R_A] }), sessions: [sess(bs, { name: "bench", labels: ["perf"], ...(o.step ? { step: o.step } : {}) })] });
    return { caller, Bm, bs, S: `${G}.s1`, G };
  }

  it("test_AC04_me_hidden", async () => {
    const { caller, Bm, bs, S } = await setup("me");
    const s = byMachine(await view(caller.token, S, "?team=1"), Bm.machine);
    expect(s).toBeDefined();
    expect(s.idle).toBe(0);
    expect(Object.hasOwn(s, "session")).toBe(false);
    expect(s.sessionLabels).toStrictEqual([]);
    expect(s.reason).not.toContain("bench");
    expect(s.reason).not.toContain(bs);
    expect(s.reason).not.toContain("labelled");
  });

  it("test_AC04_all_visible", async () => {
    const { caller, Bm, bs, S } = await setup("all");
    const s = byMachine(await view(caller.token, S, "?team=1"), Bm.machine);
    expect(s.idle).toBe(1);
    expect(s.session).toBe(bs);
    expect(s.sessionLabels).toStrictEqual(["perf"]);
    expect(s.reason).toContain("bench labelled perf");
  });

  it("test_AC04_steps_hidden", async () => {
    const { caller, Bm, bs, S } = await setup("steps");
    const s = byMachine(await view(caller.token, S, "?team=1"), Bm.machine);
    expect(s).toBeDefined();
    expect(s.idle).toBe(0);
    expect(Object.hasOwn(s, "session")).toBe(false);
    expect(s.reason).not.toContain(bs);
  });

  it("test_AC04_hidden_session_not_repo", async () => {
    const { caller, Bm, S } = await setup("me", { inventory: false });
    expect(byMachine(await view(caller.token, S, "?team=1"), Bm.machine)).toBeUndefined();
    const s = byMachine(await view(caller.token, S, "?team=1&any=1"), Bm.machine);
    expect(s).toBeDefined();
    expect(s.repo).toBe(false);
  });

  it("test_AC04_hidden_session_repo_all", async () => {
    const { caller, Bm, S } = await setup("all", { inventory: false });
    const s = byMachine(await view(caller.token, S, "?team=1"), Bm.machine);
    expect(s).toBeDefined();
    expect(s.repo).toBe(true);
  });

  it("test_AC04_step_holder_visible_not_idle", async () => {
    await world();
    const caller = await bare("alice", "alice-caller");
    const G = await castGoal(caller.token);
    const Bm = await bare("bob", "bob-bm");
    await sync(Bm, { share: "me", repos: [R_A], sessions: [sess(sid("bs"), { name: "bench", step: "X9.s1" })] });
    const s = byMachine(await view(caller.token, `${G}.s1`, "?team=1"), Bm.machine);
    expect(s).toBeDefined();
    expect(s.repo).toBe(true);
    expect(s.idle).toBe(0);
  });

  it("test_AC04_own_me_counted", async () => {
    await world();
    const caller = await bare("alice", "alice-caller");
    const G = await castGoal(caller.token);
    const M = await bare("alice", "h-m");
    const own = sid("own");
    await sync(M, { share: "me", sessions: [sess(own)] });
    const s = byMachine(await view(caller.token, `${G}.s1`), M.machine);
    expect(s).toBeDefined();
    expect(s.idle).toBe(1);
    expect(s.session).toBe(own);
  });

  it("test_AC04_bob_sees_own", async () => {
    const { Bm, bs, S } = await setup("me");
    const s = byMachine(await view(Bm.token, S), Bm.machine);
    expect(s.idle).toBe(1);
    expect(s.session).toBe(bs);
  });
});

// ---------------------------------------------------------------------------------------------

describe("AC-05 to", () => {
  async function cast() {
    await world();
    const An = await bare("alice", "h-an");
    const Au = await bare("alice", "h-au");
    const Bn = await bare("bob", "h-bn");
    const Bu = await bare("bob", "h-bu");
    for (const m of [An, Au, Bn, Bu]) await sync(m, { repos: [R_A] });
    await nickname(An, "lab");
    await nickname(Bn, "rig");
    await topic(An.token, "perf");
    const G = await goal(An.token, ["s1", "t1", "t2", "t3"].map((id) => ({ id, repo: R_A })), { topics: ["perf"] });
    return { An, Au, Bn, Bu, G };
  }

  it("test_AC05_to_values", async () => {
    const k = await cast();
    const v = await view(k.An.token, `${k.G}.s1`, "?team=1");
    expect(byMachine(v, k.An.machine).to).toBe("lab");
    expect(byMachine(v, k.Au.machine).to).toBe(k.Au.machine);
    expect(byMachine(v, k.Bn.machine).to).toBe("bob/rig");
    expect(byMachine(v, k.Bu.machine).to).toBe(k.Bu.machine);
  });

  it("test_AC05_to_clash_user_nickname", async () => {
    const k = await cast();
    // Positive control: before the clash bob's machine is bob/rig.
    expect(byMachine(await view(k.An.token, `${k.G}.s1`, "?team=1"), k.Bn.machine).to).toBe("bob/rig");
    await nickname(k.Au, "bob");
    expect(byMachine(await view(k.An.token, `${k.G}.s1`, "?team=1"), k.Bn.machine).to).toBe(k.Bn.machine);
  });

  it("test_AC05_round_trip", async () => {
    const k = await cast();
    const v = await view(k.An.token, `${k.G}.s1`, "?team=1");
    const ours = [k.An, k.Au, k.Bn, k.Bu].map((m) => byMachine(v, m.machine));
    for (const [i, s] of ours.entries()) {
      const id = `${k.G}.${["s1", "t1", "t2", "t3"][i]}`;
      const r = await w.call(k.An.token, "POST", `/v1/steps/${id}/assign`, { to: s.to });
      expect(r.status, `${s.to}: ${JSON.stringify(r.json)}`).toBe(200);
      expect(r.json.step.offer.to.machine, s.to).toBe(s.machine);
    }
  });

  it("test_AC05_round_trip_goal", async () => {
    const k = await cast();
    const K = await goal(k.An.token, [{ id: "a", repo: R_A }]);
    const v = await view(k.An.token, K, "?team=1");
    const first = v.suggestions[0];
    expect(first).toBeDefined();
    const r = await w.call(k.An.token, "POST", `/v1/goals/${K}/assign`, { to: first.to });
    expect(r.status, JSON.stringify(r.json)).toBe(200);
    expect((await stepOf(k.An.token, `${K}.a`)).offer.to.machine).toBe(first.machine);
  });

  it("test_AC05_nickname_shared_across_users", async () => {
    const k = await cast();
    const Cl = await bare("carol", "h-cl");
    await sync(Cl, { repos: [R_A] });
    await nickname(Cl, "lab");
    const v = await view(k.An.token, `${k.G}.s1`, "?team=1");
    expect(byMachine(v, k.An.machine).to).toBe("lab");
    expect(byMachine(v, Cl.machine).to).toBe("carol/lab");
    const r = await w.call(k.An.token, "POST", `/v1/steps/${k.G}.s1/assign`, { to: "lab" });
    expect(r.status, JSON.stringify(r.json)).toBe(200);
    expect(r.json.step.offer.to.machine).toBe(k.An.machine);
  });
});

// ---------------------------------------------------------------------------------------------

describe("AC-06 reason", () => {
  async function setup() {
    await world();
    const caller = await bare("alice", "alice-caller");
    const G = await castGoal(caller.token);
    return { caller, G, S: `${G}.s1` };
  }

  it("test_AC06_own_full", async () => {
    const { caller, S } = await setup();
    const M = await bare("alice", "h-m");
    await mlabels(M, ["perf"]);
    await sync(M, { repos: [R_A], sessions: [sess(sid("pb"), { name: "perf-bench", labels: ["perf"] })] });
    expect(byMachine(await view(caller.token, S), M.machine).reason).toBe("auto-accept · online · has alpha · 1 idle session · perf-bench labelled perf · machine labels perf");
  });

  it("test_AC06_other_offline", async () => {
    const { caller, S } = await setup();
    const Bm = await bare("bob", "bob-bm");
    await sync(Bm, { repos: [R_A] });
    w.clock += 300_000;
    expect(byMachine(await view(caller.token, S, "?team=1"), Bm.machine).reason).toBe("@bob · waits for them to accept · last seen 5m ago · has alpha · no idle session");
  });

  it("test_AC06_any_no_repo", async () => {
    const { caller, S } = await setup();
    const N = await bare("alice", "h-n");
    await sync(N, {});
    expect(byMachine(await view(caller.token, S, "?any=1"), N.machine).reason).toBe("auto-accept · online · no alpha · no idle session");
  });

  it("test_AC06_three_idle", async () => {
    const { caller, S } = await setup();
    const M = await bare("alice", "h-m");
    await sync(M, { repos: [R_A], sessions: [sess(sid("t")), sess(sid("t")), sess(sid("t"))] });
    expect(byMachine(await view(caller.token, S), M.machine).reason).toBe("auto-accept · online · has alpha · 3 idle sessions");
  });

  it("test_AC06_empty_repo_step", async () => {
    await world();
    const caller = await bare("alice", "alice-caller");
    // A new goal without a primary repo: its design step is ready and has no repo.
    const g = await w.call(caller.token, "POST", "/v1/goals", { title: "No repo" });
    expect(g.status, JSON.stringify(g.json)).toBe(201);
    const id = `${g.json.id}.design`;
    const step = await stepOf(caller.token, id);
    expect(step.state).toBe("ready");
    expect(step.repo || "", "the design step of a goal without primaryRepo has no repo").toBe("");
    const M = await bare("alice", "h-m");
    await sync(M, { sessions: [sess(sid("e"), { repo: repoOf(R_Z) })] });
    const v = await view(caller.token, id);
    expect(v.repos).toStrictEqual([]);
    expect(byMachine(v, M.machine).reason).toBe("auto-accept · online · 1 idle session");
  });

  it("test_AC06_two_repos", async () => {
    const { caller, G } = await setup();
    const none = await bare("alice", "h-none");
    const both = await bare("alice", "h-both");
    const onlyA = await bare("alice", "h-a");
    await sync(none, {});
    await sync(both, { repos: [R_A, R_B] });
    await sync(onlyA, { repos: [R_A] });
    const v = await view(caller.token, G, "?any=1");
    expect(byMachine(v, none.machine).reason).toBe("auto-accept · online · no alpha,beta · no idle session");
    expect(byMachine(v, both.machine).reason).toBe("auto-accept · online · has alpha,beta · no idle session");
    expect(byMachine(v, onlyA.machine).reason).toBe("auto-accept · online · no beta · no idle session");
  });

  it("test_AC06_session_name_fallback", async () => {
    const { caller, S } = await setup();
    const M = await bare("alice", "h-m");
    await sync(M, { repos: [R_A], sessions: [sess(sid("nf"), { labels: ["perf"] })] });
    expect(byMachine(await view(caller.token, S), M.machine).reason).toContain(" · alpha labelled perf");
  });

  it("test_AC06_labels_joined", async () => {
    const { caller, S } = await setup();
    const M = await bare("alice", "h-m");
    await mlabels(M, ["alpha", "perf"]);
    await sync(M, { repos: [R_A], sessions: [sess(sid("lj"), { name: "lj", labels: ["perf", "alpha"] })] });
    const reason = byMachine(await view(caller.token, S), M.machine).reason as string;
    expect(reason.endsWith("lj labelled alpha,perf · machine labels alpha,perf"), reason).toBe(true);
  });
});

// ---------------------------------------------------------------------------------------------

describe("AC-07 goal suggest", () => {
  /** The cast goal plus an offered step s4 (zeta). */
  async function setup() {
    await world();
    const caller = await bare("alice", "alice-caller");
    await topic(caller.token, "perf");
    const G = await goal(
      caller.token,
      [{ id: "s1", repo: R_A }, { id: "s2", repo: R_B }, { id: "g", kind: "gate", repo: R_A }, { id: "s3", repo: R_Z, deps: ["s1"] }, { id: "s4", repo: R_Z }],
      { topics: ["perf"] },
    );
    const r = await w.call(caller.token, "POST", `/v1/steps/${G}.s4/assign`, { to: caller.machine });
    expect(r.status, JSON.stringify(r.json)).toBe(200);
    return { caller, G };
  }

  it("test_AC07_steps_and_repos", async () => {
    const { caller, G } = await setup();
    const v = await view(caller.token, G);
    expect(v.target).toBe(G);
    expect(v.steps).toStrictEqual([`${G}.s1`, `${G}.s2`]);
    expect(v.repos).toStrictEqual([R_A, R_B]);
    expect(v.topics).toStrictEqual(["perf"]);
  });

  it("test_AC07_repo_requires_all", async () => {
    const { caller, G } = await setup();
    const a = await bare("alice", "h-a");
    const ab = await bare("alice", "h-ab");
    const b = await bare("alice", "h-b");
    await sync(a, { repos: [R_A] });
    await sync(ab, { repos: [R_A, R_B] });
    await sync(b, { repos: [R_B] });
    const v = await view(caller.token, G);
    expect(byMachine(v, ab.machine)?.repo).toBe(true);
    expect(byMachine(v, a.machine)).toBeUndefined();
    expect(byMachine(v, b.machine)).toBeUndefined();
    const any = await view(caller.token, G, "?any=1");
    expect(byMachine(any, a.machine).repo).toBe(false);
    expect(byMachine(any, b.machine).repo).toBe(false);
    expect(byMachine(any, ab.machine).repo).toBe(true);
  });

  it("test_AC07_repo_via_sessions", async () => {
    const { caller, G } = await setup();
    const m = await bare("alice", "h-m");
    await sync(m, { repos: [R_A], sessions: [sess(sid("vb"), { repo: repoOf(R_B), state: "working" })] });
    expect(byMachine(await view(caller.token, G), m.machine)?.repo).toBe(true);
  });

  it("test_AC07_duplicate_repos", async () => {
    await world();
    const caller = await bare("alice", "alice-caller");
    const D = await goal(caller.token, [{ id: "a", repo: R_A }, { id: "b", repo: R_A }]);
    const v = await view(caller.token, D);
    expect(v.steps).toStrictEqual([`${D}.a`, `${D}.b`]);
    expect(v.repos).toStrictEqual([R_A]);
  });

  it("test_AC07_primary_repo_fallback", async () => {
    await world();
    const caller = await bare("alice", "alice-caller");
    const P = await goal(caller.token, [{ id: "a", repo: R_A }, { id: "b", repo: R_Z, deps: ["a"] }], { primaryRepo: R_B });
    expect((await w.call(caller.token, "POST", `/v1/steps/${P}.a/claim`, {})).status).toBe(200);
    const m = await bare("alice", "h-m");
    await sync(m, { repos: [R_B] });
    const v = await view(caller.token, P);
    expect(v.steps).toStrictEqual([]);
    expect(v.repos).toStrictEqual([R_B]);
    expect(byMachine(v, m.machine)?.repo).toBe(true);
  });

  it("test_AC07_no_primary", async () => {
    await world();
    const caller = await bare("alice", "alice-caller");
    const P = await goal(caller.token, [{ id: "a", repo: R_A }]);
    expect((await w.call(caller.token, "POST", `/v1/steps/${P}.a/claim`, {})).status).toBe(200);
    const m = await bare("alice", "h-m");
    await sync(m, {});
    const v = await view(caller.token, P);
    expect(v.steps).toStrictEqual([]);
    expect(v.repos).toStrictEqual([]);
    expect(byMachine(v, m.machine)?.repo).toBe(true);
    expect(byMachine(v, caller.machine)?.repo).toBe(true);
  });

  it("test_AC07_done_409", async () => {
    await world();
    const caller = await bare("alice", "alice-caller");
    const D = await goal(caller.token, [{ id: "a", repo: R_A }]);
    // Positive control: an open goal answers 200.
    expect((await suggest(caller.token, D)).status).toBe(200);
    expect((await w.call(caller.token, "POST", `/v1/steps/${D}.a/claim`, {})).status).toBe(200);
    expect((await w.call(caller.token, "POST", `/v1/steps/${D}.a/done`, { summary: "ok" })).status).toBe(200);
    expect((await goalDetail(caller.token, D)).goal.state).toBe("done");
    expect(await suggest(caller.token, D)).toEqual({ status: 409, json: { error: `${D} is done` } });
    const X = await goal(caller.token, [{ id: "a", repo: R_A }]);
    const g = await w.hubStore.getGoal(X);
    expect(g).toBeDefined();
    await w.hubStore.saveGoal({ ...(g as NonNullable<typeof g>), state: "dropped" });
    expect(await suggest(caller.token, X)).toEqual({ status: 409, json: { error: `${X} is dropped` } });
  });

  it("test_AC07_unknown_404", async () => {
    await world();
    const caller = await bare("alice", "alice-caller");
    expect(await suggest(caller.token, "NOPE")).toEqual({ status: 404, json: { error: "no goal NOPE" } });
  });
});

// ---------------------------------------------------------------------------------------------

describe("AC-08 step suggest errors, read-only", () => {
  async function setup() {
    await world();
    const caller = await bare("alice", "alice-caller");
    const M = await bare("alice", "h-m");
    await sync(M, { repos: [R_A, R_B] });
    const G = await castGoal(caller.token);
    return { caller, M, G };
  }

  it("test_AC08_unknown", async () => {
    const { caller, G } = await setup();
    expect(await suggest(caller.token, `${G}.nope`)).toEqual({ status: 404, json: { error: `no step ${G}.nope` } });
  });

  it("test_AC08_gate", async () => {
    const { caller, G } = await setup();
    expect((await stepOf(caller.token, `${G}.g`)).state).toBe("ready");
    expect(await suggest(caller.token, `${G}.g`)).toEqual({ status: 409, json: { error: `${G}.g is a gate: a person decides it` } });
  });

  it("test_AC08_blocked", async () => {
    const { caller, G } = await setup();
    expect(await suggest(caller.token, `${G}.s3`)).toEqual({ status: 409, json: { error: `${G}.s3 is blocked, not ready` } });
  });

  it("test_AC08_claimed", async () => {
    const { caller, G } = await setup();
    // Positive control: s2 answers 200 while ready.
    expect((await suggest(caller.token, `${G}.s2`)).status).toBe(200);
    expect((await w.call(caller.token, "POST", `/v1/steps/${G}.s2/claim`, {})).status).toBe(200);
    const state = (await stepOf(caller.token, `${G}.s2`)).state as string;
    expect(state).not.toBe("ready");
    expect(await suggest(caller.token, `${G}.s2`)).toEqual({ status: 409, json: { error: `${G}.s2 is ${state}, not ready` } });
  });

  it("test_AC08_service_token", async () => {
    const { caller, G } = await setup();
    const svc = await w.hub.svc.serviceToken("dash");
    expect((await suggest(svc, `${G}.s1`)).status).toBe(403);
    expect((await suggest(svc, G)).status).toBe(403);
    // test_AC08_member_ok: a member device token gets 200 on both routes.
    expect((await suggest(caller.token, `${G}.s1`)).status).toBe(200);
    expect((await suggest(caller.token, G)).status).toBe(200);
  });

  it("test_AC08_offered_answers", async () => {
    const { caller, M, G } = await setup();
    expect((await w.call(caller.token, "POST", `/v1/steps/${G}.s1/assign`, { to: M.machine })).status).toBe(200);
    const r = await suggest(caller.token, `${G}.s1`);
    expect(r.status, JSON.stringify(r.json)).toBe(200);
    expect(r.json.target).toBe(`${G}.s1`);
    expect(Array.isArray(r.json.suggestions)).toBe(true);
  });

  it("test_AC08_read_only", async () => {
    const { caller, M, G } = await setup();
    expect((await w.call(caller.token, "POST", `/v1/steps/${G}.s2/assign`, { to: M.machine })).status).toBe(200);
    const before = await allEvents();
    const steps = await Promise.all([`${G}.s1`, `${G}.s2`].map((id) => stepOf(caller.token, id)));
    const detail = await goalDetail(caller.token, G);
    let ok = 0;
    for (let i = 0; i < 3; i++)
      for (const q of ["", "?team=1", "?any=1", "?team=1&any=1"])
        for (const target of [`${G}.s1`, G]) {
          const r = await suggest(caller.token, target, q);
          if (r.status === 200 && Array.isArray(r.json?.suggestions)) ok++;
        }
    // Positive control: the calls were answered.
    expect(ok).toBe(24);
    const after = await allEvents();
    expect(after.length).toBe(before.length);
    expect(after.at(-1)?.id).toBe(before.at(-1)?.id);
    expect(await Promise.all([`${G}.s1`, `${G}.s2`].map((id) => stepOf(caller.token, id)))).toStrictEqual(steps);
    expect(await goalDetail(caller.token, G)).toStrictEqual(detail);
  });
});

// ---------------------------------------------------------------------------------------------
// CLI

interface CliRun {
  code: number;
  out: string;
  err: string;
  /** `METHOD /path?query` of every HTTP request the command made. */
  requests: string[];
}

/** Run a mesh command with this config folder (credentials.json, daemon.json), recording its requests. */
async function cliIn(dir: string, args: string[]): Promise<CliRun> {
  const out: string[] = [];
  const err: string[] = [];
  const paths = resolvePaths({ MESH_CONFIG_DIR: dir, MESH_STATE_DIR: join(dir, "state"), CLAUDE_CONFIG_DIR: join(dir, "claude") }, dir);
  const c: CliEnv = { io: { out: (t) => out.push(t), err: (t) => err.push(t) }, paths, env: {}, cwd: dir, self: ["mesh"], version: "0.0.0" };
  const requests: string[] = [];
  const real = globalThis.fetch;
  const spy = vi.spyOn(globalThis, "fetch").mockImplementation((input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    requests.push(`${init?.method ?? (input instanceof Request ? input.method : "GET")} ${url.pathname}${url.search}`);
    return real(input, init);
  });
  let code: number;
  try {
    code = await dispatch(args, meshCommands(c), "0.0.0", (t) => out.push(t));
  } catch (e) {
    err.push(`mesh: ${e instanceof Error ? e.message : String(e)}`);
    code = 1;
  } finally {
    spy.mockRestore();
  }
  return { code, out: out.join("\n"), err: err.join("\n"), requests };
}
const cli = (p: Person, args: string[]) => cliIn(p.dir, args);
const lines = (s: string) => s.split("\n").filter((l) => l !== "");

/** A config folder whose credentials point at `hub` (as alice). */
function credsFor(hub: string, p: Person): string {
  const dir = mkdtempSync(join(tmpdir(), "mesh-suggest-cli-"));
  dirs.push(dir);
  writeFileSync(join(dir, "credentials.json"), JSON.stringify({ hub, token: p.login.token, user: p.login.user, machine: p.login.machine }));
  return dir;
}

/** A stub hub: `handler` answers every request; every request is recorded. */
async function stub(handler: (req: IncomingMessage, res: ServerResponse) => void): Promise<{ url: string; seen: string[] }> {
  const seen: string[] = [];
  const s = createServer((req, res) => {
    seen.push(`${req.method} ${req.url}`);
    handler(req, res);
  });
  servers.push(s);
  await new Promise<void>((r) => s.listen(0, "127.0.0.1", () => r()));
  const port = (s.address() as { port: number }).port;
  return { url: `http://127.0.0.1:${port}`, seen };
}

describe("AC-09 CLI mesh assign --suggest", () => {
  /** alice's machine A1 (a daemon, for the CLI's credentials) with bare machines A (alpha) and C (session in alpha); bob's D (alpha). */
  async function setup() {
    await world();
    const A1 = await w.person("alice", "svc", { shareSessions: "me", hostname: "alice-a1" });
    const A = await bare("alice", "h-a");
    const B = await bare("alice", "h-b");
    const C = await bare("alice", "h-c");
    const D = await bare("bob", "h-d");
    await nickname(A, "lab");
    await sync(A, { repos: [R_A] });
    await sync(B, { repos: [R_B] });
    await sync(C, { sessions: [sess(sid("c"))] });
    await sync(D, { repos: [R_A] });
    const G = await castGoal(A1.login.token);
    return { A1, A, B, C, D, G };
  }

  it("test_AC09_lines", async () => {
    const k = await setup();
    const S = `${k.G}.s1`;
    const r = await cli(k.A1, ["assign", S, "--suggest"]);
    expect(r.err).toBe("");
    expect(r.code).toBe(0);
    const v = await view(k.A1.login.token, S);
    expect(v.suggestions.length).toBeGreaterThanOrEqual(2);
    expect(lines(r.out)).toStrictEqual([
      `Suggestions for ${S} (best first):`,
      ...v.suggestions.map((s: Json, i: number) => `${i + 1}. ${s.to} · ${s.reason}`),
      `Assign with: mesh assign ${S} --to ${v.suggestions[0].to}`,
    ]);
    expect(r.requests).toContain(`GET /v1/steps/${S}/suggest`);
  });

  it("test_AC09_goal_route", async () => {
    const k = await setup();
    // The goal's offerable steps need R_A and R_B; only a machine holding both is suggested without --any.
    const E = await bare("alice", "h-e");
    await sync(E, { repos: [R_A, R_B] });
    const r = await cli(k.A1, ["assign", k.G, "--suggest"]);
    expect(r.code, r.err).toBe(0);
    expect(r.requests).toContain(`GET /v1/goals/${k.G}/suggest`);
    expect(r.requests.filter((x) => /\/v1\/steps\/.*\/suggest/.test(x))).toEqual([]);
    const out = lines(r.out);
    expect(out[0]).toBe(`Suggestions for ${k.G} (best first):`);
    const v = await view(k.A1.login.token, k.G);
    expect(out.at(-1)).toBe(`Assign with: mesh assign ${k.G} --to ${v.suggestions[0].to}`);
  });

  it("test_AC09_goal_stick_hint", async () => {
    const k = await setup();
    const P = await goal(k.A1.login.token, [{ id: "a", repo: R_A }, { id: "b", repo: R_A, deps: ["a"] }], { primaryRepo: R_A });
    expect((await w.call(k.A1.login.token, "POST", `/v1/steps/${P}.a/claim`, {})).status).toBe(200);
    const v = await view(k.A1.login.token, P);
    expect(v.steps).toStrictEqual([]);
    const r = await cli(k.A1, ["assign", P, "--suggest"]);
    expect(r.code, r.err).toBe(0);
    expect(lines(r.out).at(-1)).toBe(`Assign with: mesh assign ${P} --to ${v.suggestions[0].to} --stick`);
  });

  it("test_AC09_flags_reach_hub", async () => {
    const k = await setup();
    const S = `${k.G}.s1`;
    const plain = await cli(k.A1, ["assign", S, "--suggest"]);
    expect(plain.code, plain.err).toBe(0);
    expect(plain.requests).toContain(`GET /v1/steps/${S}/suggest`);
    expect(plain.out).not.toContain("bob/");
    const team = await cli(k.A1, ["assign", S, "--suggest", "--team"]);
    expect(team.code, team.err).toBe(0);
    expect(team.requests).toContain(`GET /v1/steps/${S}/suggest?team=1`);
    expect(team.out).toContain(`${k.D.machine} · @bob`);
    const any = await cli(k.A1, ["assign", S, "--suggest", "--any"]);
    expect(any.code, any.err).toBe(0);
    expect(any.requests).toContain(`GET /v1/steps/${S}/suggest?any=1`);
    expect(any.out).toContain(`${k.B.machine} · `);
    expect(plain.out).not.toContain(`${k.B.machine} · `);
    const both = await cli(k.A1, ["assign", S, "--suggest", "--team", "--any"]);
    expect(both.code, both.err).toBe(0);
    const q = both.requests.find((x) => x.startsWith(`GET /v1/steps/${S}/suggest?`));
    expect(q).toBeDefined();
    const params = new URLSearchParams((q as string).split("?")[1]);
    expect(params.get("team")).toBe("1");
    expect(params.get("any")).toBe("1");
    for (const r of [plain, team, any, both]) expect(r.requests.join(" ")).not.toMatch(/(team|any)=0/);
  });

  it("test_AC09_json", async () => {
    const k = await setup();
    const S = `${k.G}.s1`;
    const r = await cli(k.A1, ["assign", S, "--suggest", "--json"]);
    expect(r.code, r.err).toBe(0);
    const v = await view(k.A1.login.token, S);
    expect(r.out.trim()).toBe(JSON.stringify(v, null, 2));
  });

  it("test_AC09_none", async () => {
    const k = await setup();
    const N = await goal(k.A1.login.token, [{ id: "s1", repo: R_Z }]);
    const r = await cli(k.A1, ["assign", `${N}.s1`, "--suggest"]);
    expect(r.code, r.err).toBe(0);
    expect(r.out.trim()).toBe(`No machine to suggest for ${N}.s1; try --team or --any.`);
  });

  it("test_AC09_hub_404", async () => {
    const k = await setup();
    const r = await cli(k.A1, ["assign", "X9.s9", "--suggest"]);
    expect(r.code).toBe(1);
    expect(r.err).toContain("no step X9.s9");
    expect(r.out).toBe("");
  });

  async function oldHub(k: Awaited<ReturnType<typeof setup>>, type: string, body: string) {
    const s = await stub((_req, res) => {
      res.writeHead(200, { "content-type": type });
      res.end(body);
    });
    const r = await cliIn(credsFor(s.url, k.A1), ["assign", `${k.G}.s1`, "--suggest"]);
    return { r, s };
  }

  it("test_AC09_old_hub_html", async () => {
    const k = await setup();
    const { r, s } = await oldHub(k, "text/html", "<!doctype html><title>x</title>");
    expect(s.seen.some((x) => x.includes("/suggest"))).toBe(true);
    expect(r.code).toBe(1);
    expect(r.err).toContain(OLD_HUB);
    expect(r.out).toBe("");
  });

  it("test_AC09_old_hub_json", async () => {
    const k = await setup();
    const { r } = await oldHub(k, "application/json", '{"ok":true}');
    expect(r.code).toBe(1);
    expect(r.err).toContain(OLD_HUB);
    expect(r.out).toBe("");
  });

  it("test_AC09_stub_control", async () => {
    const k = await setup();
    const S = `${k.G}.s1`;
    const one = { machine: "m-0000abcd", user: "alice", name: "lab", to: "lab", online: true, lastSeen: 1, repo: true, idle: 0, sessionLabels: [], machineLabels: [], auto: true, reason: "auto-accept · online" };
    const sv = { target: S, steps: [S], repos: [R_A], topics: [], team: false, any: false, suggestions: [one] };
    const { r } = await oldHub(k, "application/json", JSON.stringify(sv));
    expect(r.code, r.err).toBe(0);
    expect(lines(r.out)).toStrictEqual([`Suggestions for ${S} (best first):`, "1. lab · auto-accept · online", `Assign with: mesh assign ${S} --to lab`]);
  });
});

// ---------------------------------------------------------------------------------------------

describe("AC-11 POST /v1/messages with to", () => {
  /** alice's A1 (`a1`, share me) with sessions perf and other; bob's B (`rig`, share all) with bench; bob's B2 (`quietbox`, share me) with quiet. */
  async function cast() {
    await world();
    const A1 = await w.person("alice", "svc", { shareSessions: "me", hostname: "alice-a1" });
    const B = await w.person("bob", "svc", { shareSessions: "all", hostname: "bob-b" });
    const B2 = await w.person("bob", "svc", { shareSessions: "me", hostname: "bob-b2" });
    await nickname(A1, "a1");
    await nickname(B, "rig");
    await nickname(B2, "quietbox");
    const perf = await namedSession(A1, 100, "perf");
    const other = await namedSession(A1, 101, "other");
    const bench = await namedSession(B, 200, "bench");
    const quiet = await namedSession(B2, 300, "quiet");
    await w.flush();
    await w.flush();
    return { A1, B, B2, perf, other, bench, quiet };
  }
  const say = (p: Person, body: Record<string, unknown>) => w.api(p, "POST", "/v1/messages", body);
  const inbox = async (p: Person): Promise<Json[]> => (await w.api(p, "GET", "/v1/inbox")).json.messages;
  const sent = async () => (await allEvents()).filter((e) => e.type === "message.sent");

  it("test_AC11_by_name", async () => {
    const k = await cast();
    const n = (await sent()).length;
    const r = await say(k.A1, { to: "a1/perf", text: "hi" });
    expect(r.status, JSON.stringify(r.json)).toBe(201);
    expect(r.json).toStrictEqual({ id: r.json.id, toSid: k.perf, to: "a1/perf" });
    expect(typeof r.json.id).toBe("number");
    const rows = (await inbox(k.A1)).filter((m) => m.kind === "say" && m.toSid === k.perf && m.text === "hi");
    expect(rows).toHaveLength(1);
    expect((await sent()).length).toBe(n + 1);
    await pull(k.A1);
    await observeIdle(k.A1, [100, 101]);
    expect(await until(() => k.A1.pastes.some((p) => p.pane === "%100" && p.text.includes("hi")))).toBe(true);
  });

  it("test_AC11_by_sid_prefix", async () => {
    const k = await cast();
    const r = await say(k.A1, { to: `a1/${k.other.slice(0, 6)}`, text: "x" });
    expect(r.status, JSON.stringify(r.json)).toBe(201);
    expect(r.json.toSid).toBe(k.other);
    expect(r.json.to).toBe("a1/other");
  });

  it("test_AC11_other_user", async () => {
    const k = await cast();
    const r = await say(k.A1, { to: "bob/rig/bench", text: "from alice" });
    expect(r.status, JSON.stringify(r.json)).toBe(201);
    expect(r.json.toSid).toBe(k.bench);
    expect(r.json.to).toBe("rig/bench");
    expect((await inbox(k.B)).filter((m) => m.kind === "say" && m.toSid === k.bench && m.text === "from alice")).toHaveLength(1);
    await pull(k.B);
    await observeIdle(k.B, [200]);
    expect(await until(() => k.B.pastes.some((p) => p.pane === "%200" && p.text.includes("from alice")))).toBe(true);
  });

  it("test_AC11_hostname_display", async () => {
    await world();
    const A1 = await w.person("alice", "svc", { shareSessions: "me", hostname: "alice-plain" });
    const s = await namedSession(A1, 100, "perf");
    await w.flush();
    await w.flush();
    const r = await say(A1, { to: `${w.machineOf(A1)}/perf`, text: "x" });
    expect(r.status, JSON.stringify(r.json)).toBe(201);
    expect(r.json.toSid).toBe(s);
    expect(r.json.to).toBe("alice-plain/perf");
  });

  it("unnamed session: addressed by the repo name it is shown under; two of them are ambiguous", async () => {
    await world();
    const A1 = await w.person("alice", "svc", { shareSessions: "me", hostname: "alice-plain" });
    await w.hook(A1, "SessionStart", 101);
    await w.flush();
    await w.flush();
    const s = w.session(A1, 101);
    expect(s.name).toBeUndefined();
    const shown = s.repo?.name as string;
    expect(shown).toBeTruthy();
    const r = await say(A1, { to: `${w.machineOf(A1)}/${shown}`, text: "x" });
    expect(r.status, JSON.stringify(r.json)).toBe(201);
    expect(r.json.toSid).toBe(s.sid);
    expect(r.json.to).toBe(`alice-plain/${shown}`);
    await w.hook(A1, "SessionStart", 102);
    await w.flush();
    await w.flush();
    expect(await say(A1, { to: `${w.machineOf(A1)}/${shown}`, text: "x" })).toEqual({
      status: 409,
      json: { error: `"${shown}" matches several sessions on alice-plain` },
    });
  });

  it("test_AC11_no_machine", async () => {
    const k = await cast();
    expect(await say(k.A1, { to: "x/perf", text: "x" })).toEqual({ status: 404, json: { error: "no machine x/perf" } });
  });

  it("test_AC11_no_session", async () => {
    const k = await cast();
    expect(await say(k.A1, { to: "a1/nope", text: "x" })).toEqual({ status: 404, json: { error: "no session nope on a1" } });
  });

  it("test_AC11_hidden_session", async () => {
    const k = await cast();
    expect(await say(k.A1, { to: "bob/quietbox/quiet", text: "peek" })).toEqual({ status: 404, json: { error: "no session quiet on quietbox" } });
    expect((await inbox(k.B2)).filter((m) => m.text === "peek")).toEqual([]);
    // test_AC11_hidden_control: bob himself reaches it.
    const own = await say(k.B, { to: "quietbox/quiet", text: "own" });
    expect(own.status, JSON.stringify(own.json)).toBe(201);
    expect(own.json.toSid).toBe(k.quiet);
  });

  it("test_AC11_ambiguous", async () => {
    const k = await cast();
    await namedSession(k.A1, 102, "dup");
    await namedSession(k.A1, 103, "dup");
    await w.flush();
    expect(await say(k.A1, { to: "a1/dup", text: "x" })).toEqual({ status: 409, json: { error: '"dup" matches several sessions on a1' } });
  });

  it("test_AC11_machine_only", async () => {
    const k = await cast();
    expect(await say(k.A1, { to: "a1", text: "x" })).toEqual({ status: 400, json: { error: "say needs a session: <machine>/<session>" } });
  });

  it("test_AC11_tosid_unchanged", async () => {
    const k = await cast();
    const a = await say(k.A1, { toSid: k.perf, text: "plain" });
    expect(a.status, JSON.stringify(a.json)).toBe(201);
    expect(a.json.toSid).toBe(k.perf);
    expect(Object.hasOwn(a.json, "to")).toBe(false);
    const b = await say(k.A1, { toSid: k.perf, to: "x/y", text: "bogus to" });
    expect(b.status, JSON.stringify(b.json)).toBe(201);
    expect(b.json.toSid).toBe(k.perf);
    expect(Object.hasOwn(b.json, "to")).toBe(false);
  });

  it("test_AC11_tostep_unchanged", async () => {
    const k = await cast();
    const G = await goal(k.A1.login.token, [{ id: "a", repo: "svc" }]);
    const c = await w.api(k.A1, "POST", `/v1/steps/${G}.a/claim`, { sid: k.perf });
    expect(c.status, JSON.stringify(c.json)).toBe(200);
    const r = await say(k.B, { toStep: `${G}.a`, text: "to the holder" });
    expect(r.status, JSON.stringify(r.json)).toBe(201);
    expect(r.json.toSid).toBe(k.perf);
    expect(Object.hasOwn(r.json, "to")).toBe(false);
  });

  it("test_AC11_neither_400", async () => {
    const k = await cast();
    expect((await say(k.A1, { text: "x" })).status).toBe(400);
  });
});

// ---------------------------------------------------------------------------------------------

describe("AC-12 CLI mesh say", () => {
  async function cast() {
    await world();
    const A1 = await w.person("alice", "svc", { shareSessions: "me", hostname: "alice-a1" });
    await nickname(A1, "m2");
    const perf = await namedSession(A1, 100, "perf");
    await w.flush();
    await w.flush();
    return { A1, perf };
  }

  it("test_AC12_remote_ok", async () => {
    const k = await cast();
    const r = await cli(k.A1, ["say", "m2/perf", "hello", "there"]);
    expect(r.err).toBe("");
    expect(r.code).toBe(0);
    expect(r.out.trim()).toBe(SENT("m2/perf"));
    expect(r.requests).toContain("POST /v1/messages");
    const rows = (await w.api(k.A1, "GET", "/v1/inbox")).json.messages.filter((m: Json) => m.kind === "say" && m.toSid === k.perf && m.text === "hello there");
    expect(rows).toHaveLength(1);
  });

  it("test_AC12_unknown_machine", async () => {
    const k = await cast();
    const r = await cli(k.A1, ["say", "nope/perf", "hi"]);
    expect(r.code).toBe(1);
    expect(r.err).toContain("no machine nope");
    expect(r.out).toBe("");
  });

  it("test_AC12_not_logged_in", async () => {
    await world();
    const A1 = await w.person("alice", "svc", { shareSessions: "me", noCredentials: true });
    const ref = await cli(A1, ["offers"]);
    expect(ref.code).toBe(1);
    expect(ref.err).not.toBe("");
    const r = await cli(A1, ["say", "m2/perf", "hi"]);
    expect(r.code).toBe(1);
    expect(r.err).toBe(ref.err);
    expect(r.requests.filter((x) => x.includes("/local/say"))).toEqual([]);
  });

  it("test_AC12_old_hub", async () => {
    const k = await cast();
    const s = await stub((_req, res) => {
      res.writeHead(400, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "toSid or toStep is required" }));
    });
    const r = await cliIn(credsFor(s.url, k.A1), ["say", "m2/perf", "hi"]);
    expect(s.seen).toContain("POST /v1/messages");
    expect(r.code).toBe(1);
    expect(r.err).toContain("toSid or toStep is required");
  });

  it("test_AC12_local_unchanged", async () => {
    const k = await cast();
    const r = await cli(k.A1, ["say", "perf", "hello"]);
    expect(r.code, r.err).toBe(0);
    expect(["Delivered.", "Queued; mesh delivers it as soon as the session can take it."]).toContain(r.out.trim());
    expect(r.requests).toContain("POST /local/say");
    expect(r.requests.filter((x) => x.includes("/v1/messages"))).toEqual([]);
  });

  it("test_AC12_slash_goes_to_hub", async () => {
    const k = await cast();
    // The session's folder is <dir>/svc: before MM-4, `<dir name>/svc` matched it locally.
    const target = `${basename(dirname(k.A1.repoDir))}/${basename(k.A1.repoDir)}`;
    const r = await cli(k.A1, ["say", target, "hi"]);
    expect(r.requests.filter((x) => x.includes("/local/say"))).toEqual([]);
    expect(r.requests).toContain("POST /v1/messages");
  });

  it("test_AC12_usage", async () => {
    const k = await cast();
    for (const args of [["say"], ["say", "m2/perf"]]) {
      const r = await cli(k.A1, args);
      expect(r.code, args.join(" ")).toBe(2);
      expect(r.err.trim(), args.join(" ")).toBe(SAY_USAGE);
      expect(r.requests.filter((x) => x.includes("/v1/messages") || x.includes("/local/say"))).toEqual([]);
    }
  });
});

// ---------------------------------------------------------------------------------------------
// Daemon helpers (as in test/assign.test.ts).

/** A request to a person's daemon (local API). */
async function local(p: Person, method: "GET" | "POST", path: string, body?: unknown): Promise<{ status: number; json: Json }> {
  const r = await fetch(`http://127.0.0.1:${p.daemon.port}${path}`, {
    method,
    headers: { "x-mesh-key": p.config.key, "content-type": "application/json" },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const text = await r.text();
  return { status: r.status, json: text ? JSON.parse(text) : undefined };
}

/** A session named `name` in the person's checkout: a `mesh run` placeholder adopted by its first hook. */
async function namedSession(p: Person, pid: number, name: string): Promise<string> {
  const r = await local(p, "POST", "/local/launch", { pane: `%${pid}`, cwd: p.repoDir, name });
  expect(r.status, JSON.stringify(r.json)).toBe(200);
  await w.hook(p, "SessionStart", pid);
  const s = w.session(p, pid);
  expect(s.name).toBe(name);
  return s.sid;
}

/** Make the daemon see these sessions' processes idle (so pending messages may be pasted). */
async function observeIdle(p: Person, pids: number[]): Promise<void> {
  p.agents = pids.map((pid) => ({ kind: "interactive", pid, cwd: p.repoDir, sessionId: `claude-${pid}`, status: "idle" }));
  await p.daemon.reconcile();
  await p.daemon.deliverPending();
}

/** Pull this machine's inbox and give the daemon time to handle what it got. */
async function pull(p: Person, settle = 150): Promise<void> {
  await p.daemon.link?.pullInbox();
  await sleep(settle);
}

// ---------------------------------------------------------------------------------------------

describe("AC-13 maxSessions gates the daemon's launch for an offer", () => {
  interface DCast {
    A1: Person;
    B: Person;
    B2: Person;
    G: string;
    next: () => string;
  }
  /** bob's B (`m2`, launch, self, notifications on) and B2 (`b2`); alice's goal with many ready steps in svc. */
  async function dcast(maxSessions: number | undefined): Promise<DCast> {
    await world();
    const A1 = await w.person("alice", "svc", { shareSessions: "me", hostname: "alice-a1" });
    const B = await w.person("bob", "svc", { shareSessions: "all", hostname: "host-b" });
    const B2 = await w.person("bob", "svc", { shareSessions: "me", hostname: "bob-b2" });
    await nickname(B, "m2");
    await nickname(B2, "b2");
    await w.restart(B, { accept: ["self"], assignments: "launch", maxSessions });
    w.hook(B2, "SessionStart", 900);
    await w.flush();
    const ids = Array.from({ length: 8 }, (_, i) => `s${i + 1}`);
    const G = await goal(A1.login.token, ids.map((id) => ({ id, repo: "svc" })));
    let n = 0;
    return { A1, B, B2, G, next: () => `${G}.${ids[n++]}` };
  }
  /** `n` working sessions on B (none idle in the repo, so an offer goes to the launch path). */
  async function live(d: DCast, pids: number[]): Promise<void> {
    for (const pid of pids) {
      w.hook(d.B, "SessionStart", pid);
      w.hook(d.B, "UserPromptSubmit", pid, { prompt: "work" });
    }
    await w.flush();
  }
  /** An auto offer: bob from B2 to his B (policy self); returns the machine-wide message id. */
  async function autoOffer(d: DCast, id: string): Promise<number> {
    const r = await w.api(d.B2, "POST", `/v1/steps/${id}/assign`, { to: "m2" });
    expect(r.status, JSON.stringify(r.json)).toBe(200);
    expect(r.json.auto).toBe(true);
    const msgs = (await w.api(d.B, "GET", "/v1/inbox")).json.messages as Json[];
    const m = msgs.find((x) => x.kind === "offer" && x.data?.step === id);
    expect(m, "the machine-wide message").toBeDefined();
    return m.id as number;
  }
  const acksOf = (p: Person, id: number) => p.acks.filter((a) => a.id === id);
  async function offerAndPull(d: DCast, id: string): Promise<number> {
    const msg = await autoOffer(d, id);
    await pull(d.B);
    expect(await until(() => acksOf(d.B, msg).length > 0)).toBe(true);
    return msg;
  }

  it("test_AC13_at_limit_no_launch", async () => {
    const d = await dcast(2);
    await live(d, [201, 202]);
    const id = d.next();
    const msg = await offerAndPull(d, id);
    expect(d.B.launches).toEqual([]);
    expect(d.B.logs).toContain(NOT_STARTING(id, 2, 2));
    expect(acksOf(d.B, msg)).toEqual([{ id: msg, state: "delivered", method: "listed" }]);
    expect(d.B.notes.filter((n) => n.includes(id))).toHaveLength(1);
    expect((await stepOf(d.A1.login.token, id)).offer.state).toBe("offered");
  });

  it("test_AC13_under_limit_launches", async () => {
    const d = await dcast(3);
    await live(d, [201, 202]);
    const id = d.next();
    await offerAndPull(d, id);
    expect(d.B.launches).toStrictEqual([{ repo: "svc", step: id }]);
    // Now 2 live + 1 pending launch = 3: the next offer is listed.
    const next = d.next();
    const msg = await offerAndPull(d, next);
    expect(d.B.launches).toHaveLength(1);
    expect(acksOf(d.B, msg)).toEqual([{ id: msg, state: "delivered", method: "listed" }]);
    expect(d.B.logs).toContain(NOT_STARTING(next, 3, 3));
  });

  it("test_AC13_concurrent_offers", async () => {
    const d = await dcast(2);
    await live(d, [201]);
    const ids = [d.next(), d.next()];
    const msgs = [await autoOffer(d, ids[0] as string), await autoOffer(d, ids[1] as string)];
    await pull(d.B);
    expect(await until(() => msgs.every((m) => acksOf(d.B, m).length > 0))).toBe(true);
    expect(d.B.launches).toHaveLength(1);
    const listed = msgs.filter((m) => acksOf(d.B, m).some((a) => a.method === "listed"));
    expect(listed).toHaveLength(1);
  });

  it("test_AC13_pending_counts_and_expires", async () => {
    const d = await dcast(2);
    await live(d, [201]);
    const t = w.clock;
    await offerAndPull(d, d.next());
    expect(d.B.launches).toHaveLength(1);
    // test_AC13_pending_counts_before_expiry: the launched session never appears.
    w.clock = t + 60_000;
    const id2 = d.next();
    const m2 = await offerAndPull(d, id2);
    expect(d.B.launches).toHaveLength(1);
    expect(acksOf(d.B, m2)).toEqual([{ id: m2, state: "delivered", method: "listed" }]);
    // test_AC13_pending_expires
    w.clock = t + 121_000;
    const id3 = d.next();
    await offerAndPull(d, id3);
    expect(d.B.launches).toHaveLength(2);
    expect(d.B.launches[1]).toStrictEqual({ repo: "svc", step: id3 });
  });

  it("test_AC13_no_double_count", async () => {
    const d = await dcast(3);
    await live(d, [201]);
    const id1 = d.next();
    await offerAndPull(d, id1);
    expect(d.B.launches).toHaveLength(1);
    // What mesh run does for the launched step: a placeholder holding the step, adopted by its first hook.
    const placeholder = await local(d.B, "POST", "/local/launch", { pane: "%260", cwd: d.B.repoDir, step: id1 });
    expect(placeholder.status, JSON.stringify(placeholder.json)).toBe(200);
    await w.hook(d.B, "SessionStart", 260, {}, { step: id1 });
    const s = w.session(d.B, 260);
    expect(s?.step).toBe(id1);
    await w.flush();
    await w.flush();
    expect(await until(async () => (await stepOf(d.A1.login.token, id1)).holderSid === s.sid)).toBe(true);
    await offerAndPull(d, d.next());
    expect(d.B.launches).toHaveLength(2);
    // Control: 2 live + 1 pending = 3, so the next offer is not launched (the limit is in force).
    await offerAndPull(d, d.next());
    expect(d.B.launches).toHaveLength(2);
  });

  it("test_AC13_failed_launch_not_counted", async () => {
    const d = await dcast(2);
    await live(d, [201]);
    d.B.launchResult = { ok: false, error: "x" };
    await offerAndPull(d, d.next());
    expect(d.B.launches).toHaveLength(1);
    delete d.B.launchResult;
    await offerAndPull(d, d.next());
    expect(d.B.launches).toHaveLength(2);
    // Control: that launch does use a place (1 live + 1 pending = 2), so the next offer is listed.
    const m = await offerAndPull(d, d.next());
    expect(d.B.launches).toHaveLength(2);
    expect(acksOf(d.B, m)).toEqual([{ id: m, state: "delivered", method: "listed" }]);
  });

  it("test_AC13_ended_not_counted", async () => {
    const d = await dcast(2);
    await live(d, [201, 202]);
    w.hook(d.B, "SessionEnd", 202);
    await w.flush();
    expect(w.session(d.B, 202).state).toBe("ended");
    const id = d.next();
    await offerAndPull(d, id);
    expect(d.B.launches).toStrictEqual([{ repo: "svc", step: id }]);
    // Control: 1 live + 1 pending = 2, so the next offer is listed.
    const m = await offerAndPull(d, d.next());
    expect(d.B.launches).toHaveLength(1);
    expect(acksOf(d.B, m)).toEqual([{ id: m, state: "delivered", method: "listed" }]);
  });

  it("test_AC13_any_session_counts", async () => {
    const d = await dcast(2);
    await live(d, [201]);
    const elsewhere = join(d.B.dir, "elsewhere");
    mkdirSync(elsewhere);
    w.hook(d.B, "SessionStart", 203, { cwd: elsewhere });
    await w.flush();
    expect(w.session(d.B, 203).state).toBe("idle");
    const id = d.next();
    const msg = await offerAndPull(d, id);
    expect(d.B.launches).toEqual([]);
    expect(acksOf(d.B, msg)).toEqual([{ id: msg, state: "delivered", method: "listed" }]);
  });

  it("test_AC13_absent_no_limit", async () => {
    const d = await dcast(undefined);
    await live(d, [201, 202, 203, 204, 205]);
    for (let i = 0; i < 3; i++) await offerAndPull(d, d.next());
    expect(d.B.launches).toHaveLength(3);
  });
});
