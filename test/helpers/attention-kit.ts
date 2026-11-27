// RL-22 test kit: a World with the cast of docs/specs/RL-22.md (ann owns the goals, bob a member,
// apu an approver, root an admin; services svc, reader, writer), bare machines whose sessions are
// synced, and the AC-10 world (one open item of each team-attention kind). Steps, sessions,
// questions and pulses are found by id; events by type + step.

import { createHash, randomUUID } from "node:crypto";
import { expect } from "vitest";
import { sha256 } from "../../src/auth/index.ts";
import type { Goal, Session, Step } from "../../src/protocol/index.ts";
import { World, type Json } from "./world.ts";

export const MIN = 60_000;
export const HOUR = 3_600_000;
/** 2026-11-20T12:00:00.000Z: "now" of the AC-10 world. */
export const NOW = Date.UTC(2026, 10, 20, 12);
export const H = "x-mesh-on-behalf-of";
export const REPO = "svc";
export const REPO_ID = "git.example.com/org/svc";

export const SVC_SCOPES = ["goals:read", "goals:decide", "questions:answer", "sessions:message", "goals:write"];

export interface Machine {
  user: string;
  token: string;
  machine: string;
}

export class Ak {
  readonly w: World;
  /** Device tokens of ann, bob, apu and root (each its own machine; ann's and bob's carry sessions). */
  tok: Record<string, string> = {};
  m: Record<string, Machine> = {};
  svc = "";
  reader = "";
  writer = "";
  /** The share level each machine syncs (default `all`). */
  share: Record<string, "steps" | "me" | "all"> = {};
  private sessions: Record<string, Session[]> = {};

  constructor(w: World) {
    this.w = w;
  }

  /** `approvers`: the users in the approvers group (default apu). */
  static async start(clock = NOW - 10 * HOUR, o: { approvers?: string[] } = {}): Promise<Ak> {
    const approvers = o.approvers ?? ["apu"];
    const w = new World();
    const users = ["ann", "bob", "apu", "root"];
    await w.start(users, {
      admins: ["root"],
      hubYaml: {
        auth: {
          providers: [
            {
              id: "team",
              kind: "token",
              users: users.map((n) => ({ name: n, token_sha256: sha256(`${n}-token-secret`), ...(approvers.includes(n) ? { groups: ["approvers"] } : {}) })),
              roles: { approver: ["approvers"] },
            },
          ],
        },
      },
    });
    w.clock = clock;
    const k = new Ak(w);
    let n = 0;
    for (const u of users) {
      const l = await w.login(u, { hostname: `${u}-box`, install: `inst-${u}-${++n}`.padEnd(8, "x") });
      k.tok[u] = l.token;
      k.m[u] = { user: u, token: l.token, machine: l.machine as string };
      k.sessions[u] = [];
      await k.sync(u);
    }
    k.svc = await w.hub.svc.serviceToken("svc", SVC_SCOPES as never);
    k.reader = await w.hub.svc.serviceToken("reader", ["goals:read"]);
    k.writer = await w.hub.svc.serviceToken("writer", ["goals:read", "goals:write"]);
    return k;
  }

  async stop(): Promise<void> {
    await this.w.stop();
  }

  get store() {
    return this.w.hub.svc.store;
  }

  // ---- calls ----------------------------------------------------------------------------------

  call(who: string, method: "GET" | "POST", path: string, body?: unknown, headers: Record<string, string> = {}) {
    return this.w.call(this.tok[who] ?? who, method, path, body, headers);
  }
  /** A call of the service token `svc` acting for `user` (no header when `user` is undefined). */
  as(user: string | undefined, method: "GET" | "POST", path: string, body?: unknown, token = this.svc, extra: Record<string, string> = {}) {
    return this.w.call(token, method, path, body, { ...(user === undefined ? {} : { [H]: user }), ...extra });
  }

  // ---- machines and sessions ------------------------------------------------------------------

  /** One sync of `user`'s machine with its sessions (share all, repo svc). */
  async sync(user: string): Promise<void> {
    const m = this.m[user] as Machine;
    const res = await this.w.call(m.token, "POST", "/v1/sync", {
      events: [],
      counts: {},
      sessions: this.sessions[user],
      machine: { share: this.share[user] ?? "all", repos: [{ id: REPO_ID, name: REPO }], accept: ["self"] },
    });
    expect(res.status, JSON.stringify(res.json)).toBe(200);
  }

  /** Add (or replace) a session of `user` and sync it. */
  async session(user: string, sid: string, o: Partial<Session> = {}): Promise<Session> {
    const s: Session = {
      sid,
      claudeSessionIds: [`c-${sid}`],
      cwd: `/w/${sid}`,
      kind: "interactive",
      state: "idle",
      quiet: false,
      startedAt: this.w.clock - 10_000,
      lastEventAt: this.w.clock,
      turns: 1,
      humanPrompts: 1,
      seenByReconciler: true,
      repo: { id: REPO_ID, name: REPO },
      ...o,
    };
    this.sessions[user] = [...(this.sessions[user] ?? []).filter((x) => x.sid !== sid), s];
    await this.sync(user);
    return s;
  }

  // ---- goals and steps ------------------------------------------------------------------------

  /** A goal of `owner` in repo svc; with steps, a plan with them, approved. */
  async goal(owner: string, steps: Record<string, unknown>[] = [], title = "goal"): Promise<string> {
    const g = await this.call(owner, "POST", "/v1/goals", { title, primaryRepo: REPO });
    expect(g.status, JSON.stringify(g.json)).toBe(201);
    const G = g.json.id as string;
    if (steps.length) {
      const r = await this.plan(owner, G, steps, true);
      expect(r.status, JSON.stringify(r.json)).toBe(201);
    }
    return G;
  }
  plan(who: string, G: string, steps: Record<string, unknown>[], approve: boolean) {
    const plan = steps.map((s) => ({ repo: REPO, kind: "implement", title: `Title ${String(s.id)}`, brief: "b", deps: [], ...s }));
    return this.call(who, "POST", `/v1/goals/${G}/plan`, { steps: plan, approve });
  }
  async step(id: string): Promise<Step> {
    return (await this.store.getStep(id)) as Step;
  }
  /** Overwrite fields of a step in the store (a test seam). */
  async patch(id: string, o: Partial<Step>, drop: (keyof Step)[] = []): Promise<Step> {
    const s: Step = { ...(await this.step(id)), ...o };
    for (const f of drop) delete s[f];
    await this.store.saveSteps([s]);
    return s;
  }
  async patchGoal(id: string, o: Partial<Goal>): Promise<void> {
    await this.store.saveGoal({ ...((await this.store.getGoal(id)) as Goal), ...o });
  }
  /** Claim a step for a session of `user` on their machine. */
  async hold(id: string, user: string, sid: string | undefined, at = this.w.clock): Promise<Step> {
    return await this.patch(id, { state: "claimed", holderUser: user, ...(sid ? { holderSid: sid, holderMachine: this.m[user]?.machine as string } : {}), claimedAt: at, roundStartedAt: at, updatedAt: at });
  }
  async turn(step: string, at: number): Promise<void> {
    await this.store.appendEvent({ id: randomUUID(), at, type: "session.turn_started", step, payload: {} });
  }
  async events(type: string, step?: string): Promise<Json[]> {
    return (await this.store.events(0, 100_000)).filter((e) => e.type === type && (step === undefined || e.step === step));
  }
  async inbox(user: string): Promise<Json[]> {
    const r = await this.w.call(this.m[user]?.token, "GET", "/v1/inbox");
    expect(r.status, JSON.stringify(r.json)).toBe(200);
    return r.json.messages;
  }
  async ask(who: string, text: string, o: { sid?: string; step?: string } = {}): Promise<number> {
    const r = await this.call(who, "POST", "/v1/questions", { text, ...o });
    expect(r.status, JSON.stringify(r.json)).toBe(201);
    return r.json.id as number;
  }
}

/** Ids of the AC-10 world. */
export interface AttWorld {
  k: Ak;
  /** Plan v2 awaiting approval. */
  G1: string;
  /** The work goal: gate, deb1, deb2, park, fail, pause, stall, stuck, ny, impl, off. */
  G2: string;
  /** The goal blocking pulse P1 (step run, headless, claimed). */
  G3: string;
  /** A done goal with a parked step. */
  G4: string;
  /** A trial goal with a failed step. */
  G5: string;
  P1: string;
  P2: string;
  q1: number;
  q2: number;
  /** The `at` of the 40th turn of G2.stuck after its last commit. */
  stuckAt: number;
  times: Record<TimeKey, number>;
}

type TimeKey = "plan" | "approved" | "gate" | "park" | "fail" | "pause" | "stall" | "ny" | "ny2" | "offer" | "q1" | "q2" | "blocked" | "missed" | "trialFail";

const WORK = ["gate", "deb1", "deb2", "park", "fail", "pause", "stall", "stuck", "ny", "impl", "off"];

/** The AC-10 world, built at fixed times; the clock ends at NOW. */
export async function attentionWorld(): Promise<AttWorld> {
  const k = await Ak.start(NOW - 10 * HOUR);
  const w = k.w;
  const at = (ms: number) => (w.clock = ms);
  const t = {} as Record<TimeKey, number>;

  // G1: plan v1 superseded by v2, awaiting approval; its design step is held (not ready-unclaimed).
  at(NOW - 9 * HOUR);
  const G1 = await k.goal("ann", [], "plan goal");
  expect((await k.plan("ann", G1, [{ id: "a" }], false)).status).toBe(201);
  t.plan = at(NOW - 8 * HOUR - 50 * MIN);
  expect((await k.plan("ann", G1, [{ id: "a" }, { id: "b" }], false)).status).toBe(201);
  await k.hold(`${G1}.design`, "ann", undefined, NOW - 8 * HOUR - 40 * MIN);

  // G2: the work goal, approved at NOW - 8h; every step ready, then put in its state.
  t.approved = at(NOW - 8 * HOUR);
  const G2 = await k.goal("ann", WORK.map((id) => (id === "gate" ? { id, kind: "gate", gate: "R1" } : { id })), "work goal");
  const s = (id: string) => `${G2}.${id}`;
  t.gate = NOW - 7 * HOUR - 50 * MIN;
  await k.patch(s("gate"), { updatedAt: t.gate });
  await k.patch(s("deb1"), { kind: "review", policy: { mode: "debrief" }, updatedAt: NOW - 7 * HOUR });
  await k.patch(s("deb2"), { kind: "review", policy: { mode: "debrief", sla: "1h" }, read: { user: "ann", at: NOW - 6 * HOUR, round: 1 }, updatedAt: NOW - 6 * HOUR });
  t.park = NOW - 7 * HOUR - 40 * MIN;
  await k.patch(s("park"), { state: "parked", parkedReason: "round cap (3)", parkedAt: t.park, outcome: "fail", updatedAt: t.park });
  t.fail = NOW - 7 * HOUR - 30 * MIN;
  await k.patch(s("fail"), { state: "failed", outcome: "fail", summary: "tests failed", updatedAt: t.fail });
  t.pause = NOW - 7 * HOUR - 20 * MIN;
  await k.patch(s("pause"), { state: "paused", holderUser: "bob", claimedAt: NOW - 7 * HOUR - 25 * MIN, pausedAt: t.pause, updatedAt: t.pause });
  // stall: held by bob's session s-stall, which is stalled.
  at(NOW - 7 * HOUR);
  await k.hold(s("stall"), "bob", "s-stall", NOW - 7 * HOUR - 10 * MIN);
  t.stall = NOW - 6 * HOUR - 50 * MIN;
  await k.session("bob", "s-stall", { state: "stalled", step: s("stall"), lastStopAt: t.stall, lastEventAt: t.stall, stateSince: t.stall });
  // stuck: held by ann (no session), 41 turns since its last commit.
  await k.hold(s("stuck"), "ann", undefined, NOW - 6 * HOUR);
  await k.patch(s("stuck"), { rounds: [{ n: 1, user: "ann", finishedAt: NOW - 5 * HOUR - 30 * MIN, outcome: "fail", commit: "c".repeat(40) }] });
  for (let i = 0; i < 3; i++) await k.turn(s("stuck"), NOW - 6 * HOUR + i * MIN);
  for (let i = 0; i < 41; i++) await k.turn(s("stuck"), NOW - 5 * HOUR + i * MIN);
  const stuckAt = NOW - 5 * HOUR + 39 * MIN;
  // ny: held by ann's session s-ny, in needs_you for 31 minutes.
  at(NOW - 40 * MIN);
  await k.hold(s("ny"), "ann", "s-ny", NOW - 40 * MIN);
  t.ny = NOW - 31 * MIN;
  await k.session("ann", "s-ny", { state: "needs_you", needs: "permission", step: s("ny"), stateSince: t.ny, lastStopAt: t.ny, lastEventAt: t.ny });
  // A second session in needs_you for 1 minute, with no step.
  t.ny2 = NOW - MIN;
  await k.session("ann", "s-ny2", { state: "needs_you", needs: "question", stateSince: t.ny2, lastStopAt: t.ny2, lastEventAt: t.ny2 });
  // impl: ready, no offer. off: ready, offered by ann to bob's machine.
  await k.patch(s("impl"), { updatedAt: NOW - 7 * HOUR - 5 * MIN });
  t.offer = NOW - 3 * HOUR;
  await k.patch(s("off"), { offer: { to: { machine: k.m.bob?.machine as string }, by: "ann", at: t.offer, state: "offered", auto: false }, updatedAt: t.offer });

  // Two open questions: one on G2.stall from bob's session, one without a step from ann's s-ny2.
  t.q1 = at(NOW - 4 * HOUR);
  const q1 = await k.ask("bob", "which branch?", { sid: "s-stall", step: s("stall") });
  t.q2 = at(NOW - 2 * HOUR);
  const q2 = await k.ask("ann", "lunch?", { sid: "s-ny2" });

  // P1 (ann, overlap skip) blocked by G3, whose headless step run is claimed by a working session.
  at(NOW - 3 * HOUR - 30 * MIN);
  const P1 = await pulse(k, "ann", { overlap: "skip" });
  t.blocked = at(NOW - 3 * HOUR);
  const G3 = await k.goal("ann", [{ id: "run", kind: "review", mode: "headless" }], "running goal");
  await k.hold(`${G3}.run`, "ann", "s-run", NOW - 2 * HOUR - 50 * MIN);
  await k.session("ann", "s-run", { state: "working", step: `${G3}.run`, stateSince: NOW - 10 * MIN, lastEventAt: NOW - 10 * MIN });
  await k.store.addSlot({ pulse: P1, slot: new Date(NOW - 3 * HOUR).toISOString(), at: NOW - 3 * HOUR, state: "fired", goal: G3, firedAt: NOW - 3 * HOUR, until: NOW + 10 * HOUR, startedAt: NOW - 2 * HOUR - 50 * MIN, tried: [], decidedAt: NOW - 3 * HOUR });
  // P2 (bob): its newest slot missed for no machine.
  at(NOW - 2 * HOUR - 30 * MIN);
  const P2 = await pulse(k, "bob", {});
  t.missed = NOW - 2 * HOUR - 20 * MIN;
  await k.store.addSlot({ pulse: P2, slot: new Date(t.missed).toISOString(), at: t.missed, state: "missed", reason: "no_machine", tried: [], decidedAt: t.missed });

  // Closed and trial goals: a done goal's parked step, a trial goal's failed step.
  at(NOW - HOUR);
  const G4 = await k.goal("ann", [{ id: "x" }], "done goal");
  await k.patch(`${G4}.x`, { state: "parked", parkedReason: "round cap (2)", parkedAt: NOW - HOUR, updatedAt: NOW - HOUR });
  await k.patchGoal(G4, { state: "done" });
  const G5 = await k.goal("ann", [{ id: "y" }], "trial goal");
  t.trialFail = NOW - 50 * MIN;
  await k.patch(`${G5}.y`, { state: "failed", summary: "trial failed", updatedAt: t.trialFail });
  await k.patchGoal(G5, { trial: true });

  at(NOW);
  return { k, G1, G2, G3, G4, G5, P1, P2, q1, q2, stuckAt, times: t };
}

const SOLO = `description: One step
steps:
  - id: run
    kind: implement
    repo: "{repo}"
    title: "Run {repo}"
    brief: "Do the thing in {repo}."
`;

async function pulse(k: Ak, owner: string, o: Record<string, unknown>): Promise<string> {
  const text = SOLO;
  const r = await k.call(owner, "POST", "/v1/pulses", {
    preset: { name: "solo", text, sha256: createHash("sha256").update(text, "utf8").digest("hex") },
    params: { repo: REPO },
    when: { every: "1d", at: NOW + 10 * HOUR },
    ...o,
  });
  expect(r.status, JSON.stringify(r.json)).toBe(201);
  return r.json.id as string;
}
