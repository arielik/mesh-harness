// MM-3 "Assign" end to end: a real hub and daemons over HTTP (World), the CLI and the MCP tools
// against them. Criteria AC-05 (hub side), AC-07 to AC-26, AC-29, AC-30, AC-35, AC-37 to AC-40.
// Written from the spec's contracts only (docs/specs/MM-3.md). Steps are found by id, messages by
// kind + step, events by type + step, machines by id.

import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Runner } from "../src/claude/index.ts";
import { DaemonClient } from "../src/cli/client.ts";
import { dispatch } from "../src/cli/commands.ts";
import type { CliEnv } from "../src/cli/context.ts";
import { meshCommands } from "../src/cli/mesh-commands.ts";
import * as core from "../src/core/index.ts";
import { stepMessage } from "../src/daemon/tools.ts";
import { resolvePaths, type DaemonConfig, type Session } from "../src/protocol/index.ts";
import { World, type Json, type Person } from "./helpers/world.ts";

// Copied from the spec, not imported, so a changed text turns the tests red.
const RULE = "an accept rule is self, off, user:<id> or machine:<nickname or id>";
const NOT_YOURS = (sid: string) => `session ${sid} is not yours on this machine`;
const OFFERED_TO = (id: string, name: string) => `${id} is offered to ${name}`;
const NOT_THIS = (id: string, name: string) => `${id} is offered to ${name}, not to this machine`;
const NO_OPEN = (id: string) => `${id} has no open offer`;
const MIN = 60_000;
const EXPIRY = 30 * MIN;

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- new core exports, read loosely
const offerLine = (o: Json, now: number): string => (core as any).offerLine(o, now);

let w: World;
afterEach(async () => {
  await w?.stop();
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

// ---------------------------------------------------------------------------------------------
// World helpers

type Share = DaemonConfig["shareSessions"];

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

async function nick(p: Person, nickname: string): Promise<void> {
  const r = await w.api(p, "POST", `/v1/machines/${w.machineOf(p)}/name`, { nickname });
  expect(r.status, JSON.stringify(r.json)).toBe(200);
}

const label = (p: Person, target: string, labels: string[]) => local(p, "POST", "/local/labels", { target, labels, mode: "set" });

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

interface StepIn {
  id: string;
  deps?: string[];
  kind?: string;
}

let goals = 0;
/** A goal of `owner` in repo svc; with steps, a plan with them is approved at once (design done). */
async function goal(owner: Person | string, steps: (string | StepIn)[] = [], topics?: string[]): Promise<string> {
  const token = typeof owner === "string" ? owner : owner.login.token;
  const g = await w.call(token, "POST", "/v1/goals", { title: `Offer goal ${++goals}`, primaryRepo: "svc", ...(topics ? { topics } : {}) });
  expect(g.status, JSON.stringify(g.json)).toBe(201);
  const G = g.json.id as string;
  if (steps.length) {
    const plan = steps.map((s) => (typeof s === "string" ? { id: s } : s)).map((s) => ({ id: s.id, repo: "svc", kind: s.kind ?? "implement", title: `Title ${s.id}`, brief: "b", deps: s.deps ?? [] }));
    const p = await w.call(token, "POST", `/v1/goals/${G}/plan`, { steps: plan, approve: true });
    expect(p.status, JSON.stringify(p.json)).toBe(201);
  }
  return G;
}

async function stepOf(id: string): Promise<Json> {
  const r = await w.call(w.machines[0]?.login.token, "GET", `/v1/steps/${id}`);
  expect(r.status, JSON.stringify(r.json)).toBe(200);
  return r.json.context.step;
}
async function detailOf(G: string): Promise<Json> {
  const r = await w.call(w.machines[0]?.login.token, "GET", `/v1/goals/${G}`);
  expect(r.status, JSON.stringify(r.json)).toBe(200);
  return r.json;
}

const assign = (p: Person | string, id: string, body: Record<string, unknown>) => w.call(typeof p === "string" ? p : p.login.token, "POST", `/v1/steps/${id}/assign`, body);
const assignGoal = (p: Person | string, G: string, body: Record<string, unknown>) => w.call(typeof p === "string" ? p : p.login.token, "POST", `/v1/goals/${G}/assign`, body);
const act = (p: Person | string, id: string, verb: "accept" | "decline" | "withdraw" | "claim" | "release" | "done", body: Record<string, unknown> = {}) =>
  w.call(typeof p === "string" ? p : p.login.token, "POST", `/v1/steps/${id}/${verb}`, body);

async function events(type: string, step: string): Promise<Json[]> {
  return (await w.hub.svc.store.events(0, 100_000)).filter((e) => e.type === type && e.step === step);
}
async function inboxOf(p: Person): Promise<Json[]> {
  const r = await w.call(p.login.token, "GET", "/v1/inbox");
  expect(r.status).toBe(200);
  return r.json.messages;
}
const offerMsgs = async (p: Person, step: string) => (await inboxOf(p)).filter((m) => m.kind === "offer" && m.data?.step === step);
const mentions = (m: Json, step: string) => m.data?.step === step || String(m.text).includes(step);
const reportOf = async (p: Person, sid: string, kind: string, step: string) => (await inboxOf(p)).filter((m) => m.toSid === sid && m.kind === kind && mentions(m, step));
const attention = async (p: Person | string): Promise<Json[]> => (await w.call(typeof p === "string" ? p : p.login.token, "GET", "/v1/attention")).json.attention;
const offersOf = async (p: Person): Promise<Json[]> => {
  const r = await w.call(p.login.token, "GET", "/v1/offers");
  expect(r.status, JSON.stringify(r.json)).toBe(200);
  return r.json.offers;
};
const readyIds = async (p: Person): Promise<string[]> => (await w.call(p.login.token, "GET", "/v1/steps?ready=1")).json.steps.map((s: Json) => s.id);
const activity = async (p: Person): Promise<string[]> => (await w.call(p.login.token, "GET", "/v1/live")).json.activity.map((a: Json) => a.text);

interface Cast {
  A1: Person;
  A2: Person;
  B: Person;
  B2: Person;
  C: Person;
  D: Person;
  root: string;
  /** alice's session on A1 (the offering session), on A2, bob's `perf` and `perf-bench` on B, his session on B2, carol's on C, dave's on D. */
  sa: string;
  sa2: string;
  perf: string;
  bench: string;
  sb2: string;
  sc: string;
  sd: string;
}

/**
 * alice: A1 (`a1`) and A2 (`m1`); bob: B (`m2`, hostname host-b, shares `all`) and B2 (`b2`);
 * carol: C (`m2` too); dave: D (`d`); root is an admin. Topics perf and dataplane exist.
 */
async function cast(o: { bShare?: Share; a2Share?: Share } = {}): Promise<Cast> {
  w = new World();
  await w.start(["alice", "bob", "carol", "dave", "root"], { admins: ["root"] });
  const A1 = await w.person("alice", "svc", { shareSessions: "me", hostname: "alice-a1" });
  const A2 = await w.person("alice", "svc", { shareSessions: o.a2Share ?? "me", hostname: "alice-a2" });
  const B = await w.person("bob", "svc", { shareSessions: o.bShare ?? "all", hostname: "host-b" });
  const B2 = await w.person("bob", "svc", { shareSessions: "me", hostname: "bob-b2" });
  const C = await w.person("carol", "svc", { shareSessions: "me", hostname: "carol-c" });
  const D = await w.person("dave", "svc", { shareSessions: "me", hostname: "dave-d" });
  const root = (await w.login("root", { hostname: "root-box" })).token;
  for (const [p, n] of [
    [A1, "a1"],
    [A2, "m1"],
    [B, "m2"],
    [B2, "b2"],
    [C, "m2"],
    [D, "d"],
  ] as const)
    await nick(p, n);
  for (const name of ["perf", "dataplane"]) expect((await w.call(A1.login.token, "POST", "/v1/topics", { name })).status).toBe(201);
  w.hook(A1, "SessionStart", 100);
  w.hook(A2, "SessionStart", 110);
  const perf = await namedSession(B, 201, "perf");
  const bench = await namedSession(B, 202, "perf-bench");
  expect((await label(B, bench, ["perf"])).status).toBe(200);
  w.hook(B2, "SessionStart", 210);
  w.hook(C, "SessionStart", 300);
  w.hook(D, "SessionStart", 400);
  await w.flush();
  await w.flush();
  return {
    A1,
    A2,
    B,
    B2,
    C,
    D,
    root,
    sa: w.session(A1, 100).sid,
    sa2: w.session(A2, 110).sid,
    perf,
    bench,
    sb2: w.session(B2, 210).sid,
    sc: w.session(C, 300).sid,
    sd: w.session(D, 400).sid,
  };
}

interface CliRun {
  code: number;
  out: string;
  err: string;
  requests: string[];
}

/** Run a mesh command as on this machine (its config folder), recording the HTTP requests made. */
async function cli(p: Person, args: string[], o: { runner?: Runner; cwd?: string } = {}): Promise<CliRun> {
  const out: string[] = [];
  const err: string[] = [];
  const paths = resolvePaths({ MESH_CONFIG_DIR: p.dir, MESH_STATE_DIR: join(p.dir, "state"), CLAUDE_CONFIG_DIR: join(p.dir, "claude") }, p.dir);
  const c: CliEnv = {
    io: { out: (t) => out.push(t), err: (t) => err.push(t) },
    paths,
    env: {},
    cwd: o.cwd ?? p.dir,
    self: ["mesh"],
    version: "0.0.0",
    ...(o.runner ? { runner: o.runner } : {}),
  };
  const requests: string[] = [];
  const real = globalThis.fetch;
  const spy = vi.spyOn(globalThis, "fetch").mockImplementation((input: string | URL | Request, init?: RequestInit) => {
    const url = input instanceof Request ? input.url : String(input);
    requests.push(`${init?.method ?? (input instanceof Request ? input.method : "GET")} ${new URL(url).pathname}`);
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

// ---------------------------------------------------------------------------------------------

describe("AC-05 the hub stores the accept policy", () => {
  it("test_AC05_sync_body_default", async () => {
    const k = await cast();
    const bodies = w.syncBodies(k.B);
    expect(bodies.length).toBeGreaterThan(0);
    expect(bodies.at(-1).machine?.accept).toStrictEqual(["self"]);
  });

  it("test_AC05_sync_body_config_fleet_and_keep", async () => {
    const k = await cast();
    await w.restart(k.B, { accept: ["user:alice"] });
    await w.flush();
    const n = w.syncBodies(k.B).length;
    await w.flush();
    const later = w.syncBodies(k.B).slice(n - 1);
    expect(later.length).toBeGreaterThan(0);
    for (const b of later) expect(b.machine?.accept).toStrictEqual(["user:alice"]);
    // test_AC05_fleet_shows_accept
    const fleet = async () => (await w.api(k.B, "GET", "/v1/fleet")).json;
    expect((await fleet()).machines.find((m: Json) => m.id === w.machineOf(k.B)).accept).toStrictEqual(["user:alice"]);
    // test_AC05_sync_without_accept_keeps
    const r = await w.call(k.B.login.token, "POST", "/v1/sync", { events: [], counts: {}, sessions: [], machine: { share: "all" } });
    expect(r.status).toBe(200);
    expect((await fleet()).machines.find((m: Json) => m.id === w.machineOf(k.B)).accept).toStrictEqual(["user:alice"]);
  });

  it("test_AC05_never_reported_absent", async () => {
    const k = await cast();
    const fresh = await w.login("bob", { hostname: "never-synced" });
    const raw = await w.login("bob", { hostname: "raw-sync" });
    expect((await w.call(raw.token, "POST", "/v1/sync", { events: [], counts: {}, sessions: [], machine: { share: "me" } })).status).toBe(200);
    const fleet = (await w.api(k.B, "GET", "/v1/fleet")).json;
    // Positive control: B reported its policy.
    expect(fleet.machines.find((m: Json) => m.id === w.machineOf(k.B)).accept).toStrictEqual(["self"]);
    for (const id of [fresh.machine, raw.machine]) {
      const m = fleet.machines.find((x: Json) => x.id === id);
      expect(m, id).toBeDefined();
      expect(Object.hasOwn(m, "accept"), id).toBe(false);
    }
  });

  it("test_AC05_session_override_in_fleet", async () => {
    const k = await cast();
    const set = await local(k.B, "POST", "/local/session-accept", { target: "perf", accept: ["user:alice"] });
    expect(set.status, JSON.stringify(set.json)).toBe(200);
    await w.flush();
    const fleet = (await w.api(k.B, "GET", "/v1/fleet")).json;
    const sessions = fleet.machines.find((m: Json) => m.id === w.machineOf(k.B)).sessions as Json[];
    expect(sessions.find((s) => s.sid === k.perf).accept).toStrictEqual(["user:alice"]);
    expect(Object.hasOwn(sessions.find((s) => s.sid === k.bench), "accept")).toBe(false);
    const live = (await w.api(k.B, "GET", "/v1/live")).json;
    const liveSession = live.people.flatMap((p: Json) => p.sessions).find((s: Json) => s.sid === k.perf);
    expect(liveSession).toBeDefined();
    expect(Object.hasOwn(liveSession, "accept")).toBe(false);
  });
});

// ---------------------------------------------------------------------------------------------

describe("AC-07 POST /v1/steps/:id/assign", () => {
  it("test_AC07_assign_to_other_user_machine", async () => {
    const k = await cast();
    const G = await goal(k.A1, ["a"]);
    const id = `${G}.a`;
    const r = await assign(k.A1, id, { to: "bob/m2", sid: k.sa });
    expect(r.status, JSON.stringify(r.json)).toBe(200);
    expect(typeof r.json.auto).toBe("boolean");
    expect(r.json.step.id).toBe(id);
    expect(r.json.step.state).toBe("ready");
    const o = r.json.step.offer;
    expect(o.to).toStrictEqual({ machine: w.machineOf(k.B) });
    expect(o).toMatchObject({ by: "alice", bySid: k.sa, byMachine: w.machineOf(k.A1), at: w.clock, state: "offered", auto: r.json.auto });
    expect((await stepOf(id)).offer).toMatchObject({ state: "offered", to: { machine: w.machineOf(k.B) } });
    const ev = await events("step.offered", id);
    expect(ev).toHaveLength(1);
    expect(ev[0].payload).toMatchObject({ machine: w.machineOf(k.B), auto: r.json.auto });
  });

  it("test_AC07_assign_to_own_nickname", async () => {
    const k = await cast();
    const G = await goal(k.A1, ["a"]);
    const r = await assign(k.A1, `${G}.a`, { to: "m1" });
    expect(r.status, JSON.stringify(r.json)).toBe(200);
    expect(r.json.step.offer.to).toStrictEqual({ machine: w.machineOf(k.A2) });
  });

  /** After an error: no offer and no event; a valid assign then succeeds. */
  async function stillOfferable(k: Cast, id: string) {
    expect((await stepOf(id)).offer).toBeUndefined();
    expect(await events("step.offered", id)).toEqual([]);
    expect((await assign(k.A1, id, { to: "m1" })).status).toBe(200);
  }

  it("test_AC07_no_step_404", async () => {
    const k = await cast();
    const G = await goal(k.A1, ["a"]);
    expect(await assign(k.A1, `${G}.nope`, { to: "m1" })).toEqual({ status: 404, json: { error: `no step ${G}.nope` } });
    expect((await assign(k.A1, `${G}.a`, { to: "m1" })).status).toBe(200);
  });

  it("test_AC07_gate_409", async () => {
    const k = await cast();
    const G = await goal(k.A1, ["a", { id: "g", kind: "gate" }]);
    expect((await stepOf(`${G}.g`)).state).toBe("ready");
    expect(await assign(k.A1, `${G}.g`, { to: "m1" })).toEqual({ status: 409, json: { error: `${G}.g is a gate: a person decides it` } });
    expect((await stepOf(`${G}.g`)).offer).toBeUndefined();
    expect((await assign(k.A1, `${G}.a`, { to: "m1" })).status).toBe(200);
  });

  it("test_AC07_not_ready_409", async () => {
    const k = await cast();
    const G = await goal(k.A1, ["a", { id: "z", deps: ["a"] }]);
    expect(await assign(k.A1, `${G}.z`, { to: "m1" })).toEqual({ status: 409, json: { error: `${G}.z is blocked, not ready` } });
    expect((await assign(k.A1, `${G}.a`, { to: "m1" })).status).toBe(200);
  });

  it("test_AC07_already_offered_409", async () => {
    const k = await cast();
    const G = await goal(k.A1, ["a"]);
    const id = `${G}.a`;
    expect((await assign(k.A1, id, { to: "bob/m2" })).status).toBe(200);
    expect(await assign(k.A1, id, { to: "m1" })).toEqual({ status: 409, json: { error: `${id} is already offered to m2; withdraw it first (mesh withdraw ${id})` } });
    expect((await stepOf(id)).offer.to).toStrictEqual({ machine: w.machineOf(k.B) });
    expect(await events("step.offered", id)).toHaveLength(1);
  });

  it("test_AC07_no_machine_404", async () => {
    const k = await cast();
    const G = await goal(k.A1, ["a"]);
    expect(await assign(k.A1, `${G}.a`, { to: "x" })).toEqual({ status: 404, json: { error: "no machine x" } });
    await stillOfferable(k, `${G}.a`);
  });

  it("test_AC07_no_session_404", async () => {
    const k = await cast();
    const G = await goal(k.A1, ["a"]);
    expect(await assign(k.A1, `${G}.a`, { to: "bob/m2/nosuch" })).toEqual({ status: 404, json: { error: "no session nosuch on m2" } });
    await stillOfferable(k, `${G}.a`);
  });

  it("test_AC07_me_session_of_other_user_404", async () => {
    const k = await cast();
    await namedSession(k.B2, 211, "secret");
    await w.flush();
    const G = await goal(k.A1, ["a", "b"]);
    expect(await assign(k.A1, `${G}.a`, { to: "bob/b2/secret" })).toEqual({ status: 404, json: { error: "no session secret on b2" } });
    // Positive control: bob himself may name his own session.
    expect((await assign(k.B, `${G}.b`, { to: "b2/secret" })).status).toBe(200);
    await stillOfferable(k, `${G}.a`);
  });

  it("test_AC07_ambiguous_prefix_409", async () => {
    const k = await cast();
    const rec = (sid: string): Session => ({
      sid,
      claudeSessionIds: [`c-${sid}`],
      cwd: "",
      kind: "interactive",
      state: "idle",
      quiet: false,
      startedAt: w.clock,
      lastEventAt: w.clock,
      turns: 0,
      humanPrompts: 0,
      seenByReconciler: true,
    });
    await w.hubStore.upsertSession(rec("pfx1-aaaa"), "bob", w.machineOf(k.B), w.clock);
    await w.hubStore.upsertSession(rec("pfx1-bbbb"), "bob", w.machineOf(k.B), w.clock);
    const G = await goal(k.A1, ["a"]);
    expect(await assign(k.A1, `${G}.a`, { to: "bob/m2/pfx1" })).toEqual({ status: 409, json: { error: '"pfx1" matches several sessions on m2' } });
    // Positive control: a longer, unique prefix resolves.
    const ok = await assign(k.A1, `${G}.a`, { to: "bob/m2/pfx1-a" });
    expect(ok.status, JSON.stringify(ok.json)).toBe(200);
    expect(ok.json.step.offer.to).toStrictEqual({ machine: w.machineOf(k.B), sid: "pfx1-aaaa" });
  });

  it("test_AC07_service_token_403", async () => {
    const k = await cast();
    const G = await goal(k.A1, ["a"]);
    const svc = await w.hub.svc.serviceToken("dash");
    expect((await assign(svc, `${G}.a`, { to: "bob/m2" })).status).toBe(403);
    await stillOfferable(k, `${G}.a`);
  });
});

// ---------------------------------------------------------------------------------------------

describe("AC-08 target resolution", () => {
  const toOf = async (p: Person, id: string, to: string) => {
    const r = await assign(p, id, { to });
    expect(r.status, `${to}: ${JSON.stringify(r.json)}`).toBe(200);
    return r.json.step.offer.to;
  };

  it("test_AC08_own_nickname_first", async () => {
    const k = await cast();
    const G = await goal(k.A1, ["a"]);
    expect(await toOf(k.C, `${G}.a`, "m2")).toStrictEqual({ machine: w.machineOf(k.C) });
  });

  it("test_AC08_machine_id", async () => {
    const k = await cast();
    const G = await goal(k.A1, ["a"]);
    expect(await toOf(k.A1, `${G}.a`, w.machineOf(k.B))).toStrictEqual({ machine: w.machineOf(k.B) });
  });

  it("test_AC08_user_slash_nickname", async () => {
    const k = await cast();
    const G = await goal(k.A1, ["a"]);
    expect(await toOf(k.A1, `${G}.a`, "bob/m2")).toStrictEqual({ machine: w.machineOf(k.B) });
  });

  it("test_AC08_session_by_name", async () => {
    const k = await cast();
    const G = await goal(k.A1, ["a"]);
    expect(await toOf(k.B, `${G}.a`, "m2/perf")).toStrictEqual({ machine: w.machineOf(k.B), sid: k.perf });
  });

  it("test_AC08_session_by_prefix", async () => {
    const k = await cast();
    const G = await goal(k.A1, ["a"]);
    expect(k.perf.slice(0, 6)).not.toBe(k.bench.slice(0, 6));
    expect(await toOf(k.B, `${G}.a`, `m2/${k.bench.slice(0, 6)}`)).toStrictEqual({ machine: w.machineOf(k.B), sid: k.bench });
  });

  it("test_AC08_prefix_too_short", async () => {
    const k = await cast();
    const G = await goal(k.A1, ["a"]);
    const p3 = k.bench.slice(0, 3);
    expect(await assign(k.B, `${G}.a`, { to: `m2/${p3}` })).toEqual({ status: 404, json: { error: `no session ${p3} on m2` } });
    expect(await toOf(k.B, `${G}.a`, `m2/${k.bench.slice(0, 4)}`)).toStrictEqual({ machine: w.machineOf(k.B), sid: k.bench });
  });

  it("test_AC08_user_nick_session", async () => {
    const k = await cast();
    const G = await goal(k.A1, ["a"]);
    expect(await toOf(k.A1, `${G}.a`, "bob/m2/perf")).toStrictEqual({ machine: w.machineOf(k.B), sid: k.perf });
  });

  it("test_AC08_own_machine_no_session", async () => {
    const k = await cast();
    const G = await goal(k.A1, ["a"]);
    expect(await assign(k.B, `${G}.a`, { to: "m2/x" })).toEqual({ status: 404, json: { error: "no session x on m2" } });
    expect(await toOf(k.B, `${G}.a`, "m2/perf")).toStrictEqual({ machine: w.machineOf(k.B), sid: k.perf });
  });

  it("test_AC08_ended_session_excluded", async () => {
    const k = await cast();
    w.hook(k.B, "SessionStart", 203);
    await w.flush();
    const gone = w.session(k.B, 203).sid;
    const G = await goal(k.A1, ["a", "b"]);
    // Positive control: while live it resolves.
    expect(await toOf(k.B, `${G}.b`, `m2/${gone}`)).toStrictEqual({ machine: w.machineOf(k.B), sid: gone });
    w.hook(k.B, "SessionEnd", 203);
    await w.flush();
    expect((await assign(k.B, `${G}.a`, { to: `m2/${gone}` })).status).toBe(404);
  });
});

// ---------------------------------------------------------------------------------------------

describe("AC-09 accept policy at offer time", () => {
  const autoOf = async (p: Person | string, id: string, to: string) => {
    const r = await assign(p, id, { to });
    expect(r.status, `${to}: ${JSON.stringify(r.json)}`).toBe(200);
    expect(r.json.step.offer.auto).toBe(r.json.auto);
    return r.json.auto as boolean;
  };
  const policy = async (p: Person, accept: string[]) => {
    await w.restart(p, { accept });
    await w.flush();
  };

  it("test_AC09_self_default_own", async () => {
    const k = await cast();
    const G = await goal(k.A1, ["a"]);
    expect(await autoOf(k.A1, `${G}.a`, "m1")).toBe(true);
  });

  it("test_AC09_self_other_user", async () => {
    const k = await cast();
    const G = await goal(k.A1, ["a", "b"]);
    expect(await autoOf(k.B, `${G}.a`, "alice/m1")).toBe(false);
    expect(await autoOf(k.A1, `${G}.b`, "m1")).toBe(true);
  });

  it("test_AC09_user_rule", async () => {
    const k = await cast();
    await policy(k.A2, ["user:bob"]);
    const G = await goal(k.A1, ["a", "b"]);
    expect(await autoOf(k.B, `${G}.a`, "alice/m1")).toBe(true);
    expect(await autoOf(k.C, `${G}.b`, "alice/m1")).toBe(false);
  });

  it("test_AC09_machine_rule_from_that_machine_only", async () => {
    const k = await cast();
    await policy(k.A2, [`machine:${w.machineOf(k.B)}`]);
    const G = await goal(k.A1, ["a", "b"]);
    expect(await autoOf(k.B, `${G}.a`, "alice/m1")).toBe(true);
    expect(await autoOf(k.B2, `${G}.b`, "alice/m1")).toBe(false);
  });

  it("test_AC09_off", async () => {
    const k = await cast();
    await policy(k.A2, ["off"]);
    const G = await goal(k.A1, ["a", "b"]);
    expect(await autoOf(k.A1, `${G}.a`, "m1")).toBe(false);
    // Positive control: alice's other machine still has self.
    expect(await autoOf(k.A2, `${G}.b`, "a1")).toBe(true);
  });

  it("test_AC09_session_override", async () => {
    const k = await cast({ a2Share: "all" });
    await namedSession(k.A2, 111, "ovr");
    const set = await local(k.A2, "POST", "/local/session-accept", { target: "ovr", accept: ["user:bob"] });
    expect(set.status, JSON.stringify(set.json)).toBe(200);
    await w.flush();
    const G = await goal(k.A1, ["a", "b"]);
    expect(await autoOf(k.B, `${G}.a`, "alice/m1/ovr")).toBe(true);
    expect(await autoOf(k.B, `${G}.b`, "alice/m1")).toBe(false);
  });

  it("test_AC09_never_reported", async () => {
    const k = await cast();
    const third = await w.login("alice", { hostname: "alice-third" });
    const G = await goal(k.A1, ["a", "b"]);
    expect(await autoOf(k.A1, `${G}.a`, third.machine as string)).toBe(false);
    expect(await autoOf(k.A1, `${G}.b`, "m1")).toBe(true);
  });
});

// ---------------------------------------------------------------------------------------------

describe("AC-10 the machine-wide message", () => {
  it("test_AC10_row_on_target", async () => {
    const k = await cast();
    const G = await goal(k.A1, ["a"], ["perf", "dataplane"]);
    const id = `${G}.a`;
    const r = await assign(k.A1, id, { to: "bob/m2", note: "pls" });
    expect(r.status).toBe(200);
    const rows = await offerMsgs(k.B, id);
    expect(rows).toHaveLength(1);
    const m = rows[0];
    expect(m.toSid).toBe("");
    expect(m.kind).toBe("offer");
    expect(m.fromUser).toBe("alice");
    expect(m.text).toBe(`MESH: @alice offers step ${id} "Title a" (repo svc) to this machine: pls`);
    expect(m.data).toStrictEqual({ step: id, goal: G, repo: "svc", topics: ["dataplane", "perf"], auto: false, by: "alice", note: "pls" }); // goal topics are stored sorted
  });

  it("test_AC10_named_session_sid", async () => {
    const k = await cast();
    const G = await goal(k.A1, ["a"]);
    const id = `${G}.a`;
    expect((await assign(k.A1, id, { to: "bob/m2/perf" })).status).toBe(200);
    const [m] = await offerMsgs(k.B, id);
    expect(m.data.sid).toBe(k.perf);
    expect(Object.hasOwn(m.data, "note")).toBe(false);
    expect(m.text).toBe(`MESH: @alice offers step ${id} "Title a" (repo svc) to this machine`);
  });

  it("test_AC10_not_on_other_machines_one_row", async () => {
    const k = await cast();
    const G = await goal(k.A1, ["a"]);
    const id = `${G}.a`;
    expect((await assign(k.A1, id, { to: "bob/m2" })).status).toBe(200);
    expect(await offerMsgs(k.B, id)).toHaveLength(1);
    for (const p of [k.B2, k.A1, k.A2, k.C, k.D]) expect(await offerMsgs(p, id), p.hostname).toEqual([]);
  });
});

// ---------------------------------------------------------------------------------------------

describe("AC-11 the claim guard", () => {
  it("test_AC11_third_user_409_then_target_claim_is_accept", async () => {
    const k = await cast();
    const G = await goal(k.A1, ["a"]);
    const id = `${G}.a`;
    expect((await assign(k.A1, id, { to: "bob/m2", sid: k.sa })).status).toBe(200);
    expect(await act(k.C, id, "claim", { sid: k.sc })).toEqual({ status: 409, json: { error: OFFERED_TO(id, "m2") } });
    expect(await stepOf(id)).toMatchObject({ state: "ready", offer: { state: "offered" } });
    // test_AC11_target_machine_claim_is_accept
    const c = await act(k.B, id, "claim", { sid: k.bench });
    expect(c.status, JSON.stringify(c.json)).toBe(200);
    const s = await stepOf(id);
    expect(s.holderSid).toBe(k.bench);
    expect(s.offer.state).toBe("accepted");
    expect(s.offer.decidedAt).toBe(w.clock);
    const acc = await events("step.accepted", id);
    expect(acc).toHaveLength(1);
    expect(acc[0].payload).toMatchObject({ machine: w.machineOf(k.B), sid: k.bench });
    expect(await events("step.claimed", id)).toHaveLength(1);
    expect(await reportOf(k.A1, k.sa, "offer_accepted", id)).toHaveLength(1);
  });

  it("test_AC11_offerer_other_machine_withdraws", async () => {
    const k = await cast();
    const G = await goal(k.A1, ["a"]);
    const id = `${G}.a`;
    expect((await assign(k.A1, id, { to: "bob/m2", sid: k.sa })).status).toBe(200);
    const c = await act(k.A2, id, "claim", { sid: k.sa2 });
    expect(c.status, JSON.stringify(c.json)).toBe(200);
    const s = await stepOf(id);
    expect(s).toMatchObject({ holderUser: "alice", holderSid: k.sa2 });
    expect(s.offer.state).toBe("withdrawn");
    const wd = await events("step.offer_withdrawn", id);
    expect(wd).toHaveLength(1);
    expect(wd[0].payload.reason).toBe("claimed by the offerer");
    expect(await events("step.accepted", id)).toEqual([]);
  });

  it("test_AC11_no_offer_unchanged", async () => {
    const k = await cast();
    const G = await goal(k.A1, ["a"]);
    const c = await act(k.C, `${G}.a`, "claim", { sid: k.sc });
    expect(c.status, JSON.stringify(c.json)).toBe(200);
    expect((await stepOf(`${G}.a`)).offer).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------------------------

describe("AC-12 POST /v1/steps/:id/accept", () => {
  it("test_AC12_accept_sequence", async () => {
    const k = await cast();
    const G = await goal(k.A1, ["a", "b"]);
    const id = `${G}.a`;
    expect((await assign(k.A1, id, { to: "bob/m2" })).status).toBe(200);
    // test_AC12_other_machine_same_owner_403
    expect(await act(k.B2, id, "accept", { sid: k.sb2 })).toEqual({ status: 403, json: { error: NOT_THIS(id, "m2") } });
    expect((await stepOf(id)).offer.state).toBe("offered");
    // test_AC12_accept_from_target
    const r = await act(k.B, id, "accept", { sid: k.bench });
    expect(r.status, JSON.stringify(r.json)).toBe(200);
    expect(r.json.id).toBe(id);
    expect(r.json.holderSid).toBe(k.bench);
    // A plain claim's state (a sibling claimed the ordinary way).
    const plain = await act(k.C, `${G}.b`, "claim", { sid: k.sc });
    expect(r.json.state).toBe(plain.json.state);
    expect(r.json.offer.state).toBe("accepted");
    expect(r.json.offer.decidedAt).toBe(w.clock);
    const claimed = await events("step.claimed", id);
    const accepted = await events("step.accepted", id);
    expect(claimed).toHaveLength(1);
    expect(accepted).toHaveLength(1);
    expect(claimed[0].seq).toBeLessThan(accepted[0].seq);
    expect(accepted[0].payload).toMatchObject({ machine: w.machineOf(k.B), sid: k.bench });
    // test_AC12_second_accept_409
    expect(await act(k.B, id, "accept", { sid: k.perf })).toEqual({ status: 409, json: { error: NO_OPEN(id) } });
    expect((await stepOf(id)).holderSid).toBe(k.bench);
  });

  it("test_AC12_no_open_offer_409", async () => {
    const k = await cast();
    const G = await goal(k.A1, ["a"]);
    expect(await act(k.B, `${G}.a`, "accept", { sid: k.bench })).toEqual({ status: 409, json: { error: NO_OPEN(`${G}.a`) } });
    expect((await stepOf(`${G}.a`)).state).toBe("ready");
  });

  it("test_AC12_other_session_than_named", async () => {
    const k = await cast();
    const G = await goal(k.A1, ["a"]);
    const id = `${G}.a`;
    expect((await assign(k.A1, id, { to: "bob/m2/perf" })).status).toBe(200);
    const r = await act(k.B, id, "accept", { sid: k.bench });
    expect(r.status, JSON.stringify(r.json)).toBe(200);
    expect((await stepOf(id)).holderSid).toBe(k.bench);
  });
});

// ---------------------------------------------------------------------------------------------

describe("AC-13 decline and withdraw", () => {
  it("test_AC13_owner_declines", async () => {
    const k = await cast();
    const G = await goal(k.A1, ["a"]);
    const id = `${G}.a`;
    expect((await assign(k.A1, id, { to: "bob/m2" })).status).toBe(200);
    // test_AC13_other_403 first: carol is neither the owner nor matched.
    expect(await act(k.C, id, "decline", { note: "no" })).toEqual({ status: 403, json: { error: `only the owner of m2 can decline ${id}` } });
    expect((await stepOf(id)).offer.state).toBe("offered");
    const r = await act(k.B2, id, "decline", { note: "busy" });
    expect(r.status, JSON.stringify(r.json)).toBe(200);
    expect(r.json.state).toBe("ready");
    expect(r.json.offer).toMatchObject({ state: "declined", note: "busy", decidedAt: w.clock });
    const ev = await events("step.declined", id);
    expect(ev).toHaveLength(1);
    expect(ev[0].payload).toMatchObject({ machine: w.machineOf(k.B), note: "busy" });
  });

  it("test_AC13_policy_user_may_decline", async () => {
    const k = await cast();
    await w.restart(k.B, { accept: ["self", "user:dave"] });
    await w.flush();
    const G = await goal(k.A1, ["a", "b"]);
    expect((await assign(k.A1, `${G}.a`, { to: "bob/m2" })).status).toBe(200);
    expect((await act(k.D, `${G}.a`, "decline", {})).status).toBe(200);
    // Positive control: carol, not matched, may not.
    expect((await assign(k.A1, `${G}.b`, { to: "bob/m2" })).status).toBe(200);
    expect((await act(k.C, `${G}.b`, "decline", {})).status).toBe(403);
  });

  it("test_AC13_session_override_used", async () => {
    const k = await cast();
    expect((await local(k.B, "POST", "/local/session-accept", { target: "perf", accept: ["user:carol"] })).status).toBe(200);
    await w.flush();
    const G = await goal(k.A1, ["a", "b"]);
    expect((await assign(k.A1, `${G}.a`, { to: "bob/m2/perf" })).status).toBe(200);
    expect((await act(k.C, `${G}.a`, "decline", {})).status).toBe(200);
    expect((await assign(k.A1, `${G}.b`, { to: "bob/m2" })).status).toBe(200);
    expect((await act(k.C, `${G}.b`, "decline", {})).status).toBe(403);
  });

  it("test_AC13_withdraw_sequence", async () => {
    const k = await cast();
    const G = await goal(k.A1, ["a", "b"]);
    const id = `${G}.a`;
    expect((await assign(k.A1, id, { to: "bob/m2" })).status).toBe(200);
    // test_AC13_other_withdraw_403
    expect(await act(k.C, id, "withdraw")).toEqual({ status: 403, json: { error: `only @alice or an admin can withdraw the offer of ${id}` } });
    // test_AC13_offerer_withdraws
    const r = await act(k.A1, id, "withdraw");
    expect(r.status, JSON.stringify(r.json)).toBe(200);
    expect(r.json.offer).toMatchObject({ state: "withdrawn", decidedAt: w.clock });
    expect(await events("step.offer_withdrawn", id)).toHaveLength(1);
    // test_AC13_withdraw_no_offer_409, test_AC13_decline_no_offer_409
    expect(await act(k.A1, id, "withdraw")).toEqual({ status: 409, json: { error: NO_OPEN(id) } });
    expect(await act(k.B, id, "decline")).toEqual({ status: 409, json: { error: NO_OPEN(id) } });
    // test_AC13_admin_withdraws
    expect((await assign(k.A1, `${G}.b`, { to: "bob/m2" })).status).toBe(200);
    expect((await act(k.root, `${G}.b`, "withdraw")).status).toBe(200);
    expect((await stepOf(`${G}.b`)).offer.state).toBe("withdrawn");
  });

  it("test_AC13_follow_up", async () => {
    const k = await cast();
    const G = await goal(k.A1, ["a", "b"]);
    expect((await assign(k.A1, `${G}.a`, { to: "bob/m2" })).status).toBe(200);
    expect((await act(k.B, `${G}.a`, "decline")).status).toBe(200);
    expect((await assign(k.A1, `${G}.b`, { to: "bob/m2" })).status).toBe(200);
    expect((await act(k.A1, `${G}.b`, "withdraw")).status).toBe(200);
    // Declined: anyone may claim it.
    expect((await act(k.C, `${G}.a`, "claim", { sid: k.sc })).status).toBe(200);
    // Withdrawn: it may be offered again.
    expect((await assign(k.A1, `${G}.b`, { to: "m1" })).status).toBe(200);
    expect((await stepOf(`${G}.b`)).offer).toMatchObject({ state: "offered", to: { machine: w.machineOf(k.A2) } });
  });

  it("test_AC13_decline_keeps_stick", async () => {
    const k = await cast();
    const G = await goal(k.A1);
    const r = await assignGoal(k.A1, G, { to: "bob/m2", stick: true });
    expect(r.status, JSON.stringify(r.json)).toBe(200);
    expect((await act(k.B, `${G}.design`, "decline")).status).toBe(200);
    expect((await detailOf(G)).stick).toBe("m2");
  });
});

// ---------------------------------------------------------------------------------------------

describe("AC-14 expiry", () => {
  it("test_AC14_expiry_sequence", async () => {
    const k = await cast();
    const G = await goal(k.A1, ["a"]);
    const id = `${G}.a`;
    const t0 = w.clock;
    expect((await assign(k.A1, id, { to: "bob/m2" })).status).toBe(200);
    // test_AC14_not_before
    w.clock = t0 + 29 * MIN;
    await w.tick();
    expect((await stepOf(id)).offer.state).toBe("offered");
    expect(await events("step.offer_expired", id)).toEqual([]);
    // test_AC14_at_deadline
    w.clock = t0 + EXPIRY;
    await w.tick();
    const s = await stepOf(id);
    expect(s.offer.state).toBe("expired");
    expect(s.offer.decidedAt).toBe(w.clock);
    expect(s.state).toBe("ready");
    const ev = await events("step.offer_expired", id);
    expect(ev).toHaveLength(1);
    expect(ev[0].payload).toMatchObject({ machine: w.machineOf(k.B) });
    // test_AC14_tick_twice_once
    w.clock += MIN;
    await w.tick();
    expect(await events("step.offer_expired", id)).toHaveLength(1);
    // test_AC14_attention_offerer
    const item = (await attention(k.A1)).find((a) => a.kind === "offer_expired" && a.step === id);
    expect(item).toMatchObject({ kind: "offer_expired", text: `the offer of ${id} to m2 expired; it is ready again`, goal: G, step: id, at: s.offer.decidedAt });
    for (const p of [k.B, k.C]) expect((await attention(p)).filter((a) => a.kind === "offer_expired" && a.step === id)).toEqual([]);
    // test_AC14_claimable_after
    expect((await act(k.C, id, "claim", { sid: k.sc })).status).toBe(200);
    expect((await attention(k.A1)).filter((a) => a.kind === "offer_expired" && a.step === id)).toEqual([]);
  });

  it("test_AC14_not_ready_step_not_expired", async () => {
    const k = await cast();
    const G = await goal(k.A1, ["a"]);
    const id = `${G}.a`;
    expect((await assign(k.A1, id, { to: "bob/m2" })).status).toBe(200);
    expect((await act(k.B, id, "accept", { sid: k.bench })).status).toBe(200);
    w.clock += EXPIRY + MIN;
    await w.tick();
    expect((await stepOf(id)).offer.state).toBe("accepted");
    expect(await events("step.offer_expired", id)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------------------------

describe("AC-15 GET /v1/offers and GET /v1/steps?ready=1", () => {
  it("test_AC15_offers_membership", async () => {
    const k = await cast();
    const G = await goal(k.A1, ["s1", "s2", "s3", "s4", "s5", "s6", "s7"]);
    const S = (n: number) => `${G}.s${n}`;
    // S6 expires first.
    expect((await assign(k.A1, S(6), { to: "bob/m2" })).status).toBe(200);
    w.clock += EXPIRY;
    await w.tick();
    expect((await stepOf(S(6))).offer.state).toBe("expired");
    const at = w.clock;
    expect((await assign(k.A1, S(1), { to: "bob/m2", note: "n" })).status).toBe(200);
    expect((await assign(k.A1, S(2), { to: "bob/b2" })).status).toBe(200);
    expect((await assign(k.A1, S(3), { to: "m1" })).status).toBe(200);
    expect((await assign(k.A1, S(4), { to: "bob/m2" })).status).toBe(200);
    expect((await act(k.B, S(4), "decline")).status).toBe(200);
    expect((await assign(k.A1, S(5), { to: "bob/m2" })).status).toBe(200);
    expect((await act(k.A1, S(5), "withdraw")).status).toBe(200);
    expect((await assign(k.A1, S(7), { to: "bob/m2" })).status).toBe(200);
    expect((await act(k.B, S(7), "accept", { sid: k.perf })).status).toBe(200);
    for (const p of [k.B, k.B2]) {
      const offers = await offersOf(p);
      expect(offers.map((o) => o.step).sort(), p.hostname).toEqual([S(1), S(2)]);
      const o1 = offers.find((o) => o.step === S(1));
      expect(o1).toMatchObject({ step: S(1), goal: G, title: "Title s1", repo: "svc", kind: "implement", machine: w.machineOf(k.B), to: "m2", by: "alice", at, expiresAt: at + EXPIRY, auto: false, note: "n" });
    }
    // test_AC15_alice_sees_her_own
    const mine = (await offersOf(k.A1)).map((o) => o.step);
    expect(mine).toContain(S(3));
    expect(mine).not.toContain(S(1));
    expect(mine).not.toContain(S(2));
  });

  it("test_AC15_offers_order", async () => {
    const k = await cast();
    const G = await goal(k.A1, ["s0", "s1", "s2"]);
    expect((await assign(k.A1, `${G}.s0`, { to: "bob/m2" })).status).toBe(200);
    w.clock += 1;
    expect((await assign(k.A1, `${G}.s2`, { to: "bob/m2" })).status).toBe(200);
    expect((await assign(k.A1, `${G}.s1`, { to: "bob/m2" })).status).toBe(200);
    expect((await offersOf(k.B)).map((o) => o.step)).toEqual([`${G}.s0`, `${G}.s1`, `${G}.s2`]);
  });

  it("test_AC15_ready_lists", async () => {
    const k = await cast();
    const G = await goal(k.A1, ["a", "b", "r"]);
    const R = `${G}.r`;
    expect((await assign(k.A1, R, { to: "bob/m2" })).status).toBe(200);
    // test_AC15_ready_target_first
    const forB = await readyIds(k.B);
    expect(forB[0]).toBe(R);
    // test_AC15_ready_other_machine_hidden (control: the others are listed)
    for (const p of [k.B2, k.C]) {
      const ids = await readyIds(p);
      expect(ids, p.hostname).toEqual(expect.arrayContaining([`${G}.a`, `${G}.b`]));
      expect(ids, p.hostname).not.toContain(R);
    }
    // test_AC15_ready_offerer_sees
    expect(await readyIds(k.A1)).toContain(R);
    // test_AC15_unfiltered_carries_offer
    const all = (await w.call(k.C.login.token, "GET", "/v1/steps")).json.steps as Json[];
    expect(all.find((s) => s.id === R)?.offer).toMatchObject({ state: "offered", to: { machine: w.machineOf(k.B) } });
  });
});

// ---------------------------------------------------------------------------------------------

describe("AC-16 attention kind offer", () => {
  const offerItem = async (p: Person, id: string) => (await attention(p)).find((a) => a.kind === "offer" && a.step === id);

  it("test_AC16_offer_item_for_target_owner", async () => {
    const k = await cast();
    const G = await goal(k.A1, ["a"]);
    const id = `${G}.a`;
    const r = await assign(k.A1, id, { to: "bob/m2" });
    expect(r.status).toBe(200);
    const want = { kind: "offer", text: `@alice offers ${id} "Title a" to m2`, goal: G, step: id, at: r.json.step.offer.at };
    expect(await offerItem(k.B, id)).toMatchObject(want);
    const live = (await w.api(k.B2, "GET", "/v1/live")).json.attention as Json[];
    expect(live.find((a) => a.kind === "offer" && a.step === id)).toMatchObject(want);
    // test_AC16_not_for_others
    expect(await offerItem(k.C, id)).toBeUndefined();
    expect(await offerItem(k.A1, id)).toBeUndefined();
  });

  it("test_AC16_gone_after_end", async () => {
    const k = await cast();
    const G = await goal(k.A1, ["a", "b", "c", "d"]);
    const ends: [string, () => Promise<unknown>][] = [
      [`${G}.a`, () => act(k.B, `${G}.a`, "decline")],
      [`${G}.b`, () => act(k.A1, `${G}.b`, "withdraw")],
      [`${G}.c`, () => act(k.B, `${G}.c`, "accept", { sid: k.bench })],
    ];
    for (const [id, end] of ends) {
      expect((await assign(k.A1, id, { to: "bob/m2" })).status).toBe(200);
      expect(await offerItem(k.B, id), id).toBeDefined();
      await end();
      expect(await offerItem(k.B, id), id).toBeUndefined();
    }
    const d = `${G}.d`;
    expect((await assign(k.A1, d, { to: "bob/m2" })).status).toBe(200);
    expect(await offerItem(k.B, d)).toBeDefined();
    w.clock += EXPIRY;
    await w.tick();
    expect(await offerItem(k.B, d)).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------------------------

describe("AC-17 goal assign", () => {
  it("test_AC17_new_goal_design", async () => {
    const k = await cast();
    const G = await goal(k.A1);
    const r = await assignGoal(k.A1, G, { to: "bob/m2" });
    expect(r.status, JSON.stringify(r.json)).toBe(200);
    expect(r.json.goal.id).toBe(G);
    expect(r.json.steps.map((s: Json) => s.id)).toEqual([`${G}.design`]);
    expect(r.json.auto).toBe(false);
    expect(await offerMsgs(k.B, `${G}.design`)).toHaveLength(1);
    expect(await events("step.offered", `${G}.design`)).toHaveLength(1);
  });

  it("test_AC17_skips_already_offered_and_gates", async () => {
    const k = await cast();
    const G = await goal(k.A1, ["a", "b", { id: "g", kind: "gate" }]);
    expect((await assign(k.A1, `${G}.b`, { to: "m1" })).status).toBe(200);
    const r = await assignGoal(k.A1, G, { to: "bob/m2" });
    expect(r.status, JSON.stringify(r.json)).toBe(200);
    expect(r.json.steps.map((s: Json) => s.id)).toEqual([`${G}.a`]);
    expect((await stepOf(`${G}.b`)).offer.to).toStrictEqual({ machine: w.machineOf(k.A2) });
    expect((await stepOf(`${G}.g`)).offer).toBeUndefined();
  });

  it("test_AC17_nothing_ready_409_and_stick", async () => {
    const k = await cast();
    const G = await goal(k.A1, ["a"]);
    expect((await act(k.A1, `${G}.a`, "claim", { sid: k.sa })).status).toBe(200);
    expect(await assignGoal(k.A1, G, { to: "bob/m2" })).toEqual({ status: 409, json: { error: `${G} has no ready step to offer` } });
    // test_AC17_stick_nothing_ready
    const r = await assignGoal(k.A1, G, { to: "bob/m2", stick: true });
    expect(r.status, JSON.stringify(r.json)).toBe(200);
    expect(r.json.steps).toEqual([]);
    expect(r.json.auto).toBe(false);
    expect(r.json.goal.stick).toMatchObject({ to: { machine: w.machineOf(k.B) }, by: "alice", at: w.clock });
    const H = await goal(k.A1, ["a"]);
    expect((await act(k.A1, `${H}.a`, "claim", { sid: k.sa })).status).toBe(200);
    const own = await assignGoal(k.A1, H, { to: "m1", stick: true });
    expect(own.status).toBe(200);
    expect(own.json.auto).toBe(true);
  });

  it("test_AC17_done_goal_409", async () => {
    const k = await cast();
    const G = await goal(k.A1, ["a"]);
    expect((await act(k.A1, `${G}.a`, "claim", {})).status).toBe(200);
    expect((await act(k.A1, `${G}.a`, "done", { summary: "ok" })).json.goalDone).toBe(true);
    expect(await assignGoal(k.A1, G, { to: "bob/m2", stick: true })).toEqual({ status: 409, json: { error: `${G} is done` } });
  });

  it("test_AC17_no_goal_404_and_target_errors", async () => {
    const k = await cast();
    expect(await assignGoal(k.A1, "G999", { to: "bob/m2" })).toEqual({ status: 404, json: { error: "no goal G999" } });
    const G = await goal(k.A1);
    expect(await assignGoal(k.A1, G, { to: "x" })).toEqual({ status: 404, json: { error: "no machine x" } });
    expect((await assignGoal(k.A1, G, { to: "bob/m2" })).status).toBe(200);
  });
});

// ---------------------------------------------------------------------------------------------

describe("AC-18 stick", () => {
  it("test_AC18_stick_sequence", async () => {
    const k = await cast();
    const G = await goal(k.A1);
    expect((await assignGoal(k.A1, G, { to: "bob/m2", stick: true })).status).toBe(200);
    const plan = [
      { id: "a", repo: "svc", kind: "implement", title: "Title a", brief: "b", deps: [] },
      { id: "b", repo: "svc", kind: "implement", title: "Title b", brief: "b", deps: ["a"] },
      { id: "gate", repo: "svc", kind: "gate", title: "Title gate", brief: "b", deps: ["a"] },
      { id: "c", repo: "svc", kind: "implement", title: "Title c", brief: "b", deps: ["b"] },
      { id: "d", repo: "svc", kind: "implement", title: "Title d", brief: "b", deps: ["c"] },
    ];
    expect((await w.call(k.A1.login.token, "POST", `/v1/goals/${G}/plan`, { steps: plan, approve: true })).status).toBe(201);
    // test_AC18_ready_steps_offered
    const a = await stepOf(`${G}.a`);
    expect(a.offer).toMatchObject({ state: "offered", stick: true, by: "alice", to: { machine: w.machineOf(k.B) } });
    const ev = await events("step.offered", `${G}.a`);
    expect(ev).toHaveLength(1);
    expect(ev[0].payload.stick).toBe(true);
    expect(await offerMsgs(k.B, `${G}.a`)).toHaveLength(1);
    // Finish a (the offerer claims it from her own machine: that withdraws the offer).
    expect((await act(k.A1, `${G}.a`, "claim", { sid: k.sa })).status).toBe(200);
    expect((await act(k.A1, `${G}.a`, "done", { summary: "ok" })).status).toBe(200);
    // test_AC18_gate_not_offered
    expect((await stepOf(`${G}.b`)).offer).toMatchObject({ state: "offered", stick: true });
    expect((await stepOf(`${G}.gate`)).state).toBe("ready");
    expect((await stepOf(`${G}.gate`)).offer).toBeUndefined();
    expect(await events("step.offered", `${G}.gate`)).toEqual([]);
    // test_AC18_one_message_each
    expect(await offerMsgs(k.B, `${G}.b`)).toHaveLength(1);
    // test_AC18_release_not_reoffered
    expect((await act(k.B, `${G}.b`, "accept", { sid: k.bench })).status).toBe(200);
    expect((await act(k.B, `${G}.b`, "release", {})).status).toBe(200);
    expect((await stepOf(`${G}.b`)).offer).toBeUndefined();
    expect(await events("step.offered", `${G}.b`)).toHaveLength(1);
    // c becomes ready: offered by the stick.
    expect((await act(k.C, `${G}.b`, "claim", { sid: k.sc })).status).toBe(200);
    expect((await act(k.C, `${G}.b`, "done", { summary: "ok" })).status).toBe(200);
    expect((await stepOf(`${G}.c`)).offer).toMatchObject({ state: "offered", stick: true });
    // test_AC18_goal_withdraw
    const wd = await w.call(k.A1.login.token, "POST", `/v1/goals/${G}/withdraw`, {});
    expect(wd.status, JSON.stringify(wd.json)).toBe(200);
    expect(wd.json.withdrawn).toEqual([`${G}.c`]);
    expect(Object.hasOwn(wd.json.goal, "stick")).toBe(false);
    expect((await stepOf(`${G}.c`)).offer.state).toBe("withdrawn");
    expect(await events("step.offer_withdrawn", `${G}.c`)).toHaveLength(1);
    expect((await act(k.C, `${G}.c`, "claim", { sid: k.sc })).status).toBe(200);
    expect((await act(k.C, `${G}.c`, "done", { summary: "ok" })).status).toBe(200);
    expect((await stepOf(`${G}.d`)).state).toBe("ready");
    expect((await stepOf(`${G}.d`)).offer).toBeUndefined();
    // test_AC18_withdraw_nothing_409
    expect(await w.call(k.A1.login.token, "POST", `/v1/goals/${G}/withdraw`, {})).toEqual({ status: 409, json: { error: `${G} has no stick and no open offer of yours` } });
  });

  it("test_AC18_goal_withdraw_others_offers", async () => {
    const k = await cast();
    const G = await goal(k.A1, ["a", "b"]);
    expect((await assignGoal(k.A1, G, { to: "bob/m2", stick: true })).status).toBe(200);
    expect((await act(k.A1, `${G}.b`, "withdraw")).status).toBe(200);
    expect((await assign(k.C, `${G}.b`, { to: "bob/m2" })).status).toBe(200);
    const r = await w.call(k.A1.login.token, "POST", `/v1/goals/${G}/withdraw`, {});
    expect(r.status, JSON.stringify(r.json)).toBe(200);
    expect(r.json.withdrawn).toEqual([`${G}.a`]);
    expect((await stepOf(`${G}.b`)).offer.state).toBe("offered");
    const admin = await w.call(k.root, "POST", `/v1/goals/${G}/withdraw`, {});
    expect(admin.status, JSON.stringify(admin.json)).toBe(200);
    expect(admin.json.withdrawn).toEqual([`${G}.b`]);
    expect((await stepOf(`${G}.b`)).offer.state).toBe("withdrawn");
  });

  it("test_AC18_target_gone_keeps_stick", async () => {
    const k = await cast();
    const G = await goal(k.A1, ["a", { id: "b", deps: ["a"] }]);
    expect((await act(k.A1, `${G}.a`, "claim", { sid: k.sa })).status).toBe(200);
    const st = await assignGoal(k.A1, G, { to: "bob/m2/perf", stick: true });
    expect(st.status, JSON.stringify(st.json)).toBe(200);
    expect((await detailOf(G)).stick).toBe("m2/perf");
    w.hook(k.B, "SessionEnd", 201);
    await w.flush();
    expect((await act(k.A1, `${G}.a`, "done", { summary: "ok" })).status).toBe(200);
    expect((await stepOf(`${G}.b`)).state).toBe("ready");
    expect((await stepOf(`${G}.b`)).offer).toBeUndefined();
    expect(await events("step.offered", `${G}.b`)).toEqual([]);
    // The stick is kept (its target text still names machine m2 and a session).
    expect((await detailOf(G)).stick).toMatch(/^m2\/.+/);
  });
});

// ---------------------------------------------------------------------------------------------

describe("AC-19 report back", () => {
  async function offered(k: Cast, steps: (string | StepIn)[] = ["a"], body: Record<string, unknown> = { to: "bob/m2" }) {
    const G = await goal(k.A1, steps);
    for (const s of steps) {
      const id = `${G}.${typeof s === "string" ? s : s.id}`;
      expect((await assign(k.A1, id, { sid: k.sa, ...body })).status).toBe(200);
    }
    return G;
  }

  it("test_AC19_accepted", async () => {
    const k = await cast();
    const G = await offered(k);
    const id = `${G}.a`;
    expect((await act(k.B, id, "accept", { sid: k.bench })).status).toBe(200);
    const rows = await reportOf(k.A1, k.sa, "offer_accepted", id);
    expect(rows).toHaveLength(1);
    expect(rows[0].text).toBe(`MESH: m2/perf-bench accepted ${id} "Title a".`);
  });

  it("test_AC19_declined_note", async () => {
    const k = await cast();
    const G = await offered(k, ["a", "b"]);
    expect((await act(k.B, `${G}.a`, "decline", { note: "busy" })).status).toBe(200);
    expect((await act(k.B, `${G}.b`, "decline", {})).status).toBe(200);
    expect((await reportOf(k.A1, k.sa, "offer_declined", `${G}.a`)).map((m) => m.text)).toEqual([`MESH: m2 declined ${G}.a "Title a": busy. It is ready again.`]);
    expect((await reportOf(k.A1, k.sa, "offer_declined", `${G}.b`)).map((m) => m.text)).toEqual([`MESH: m2 declined ${G}.b "Title b". It is ready again.`]);
  });

  it("test_AC19_expired", async () => {
    const k = await cast();
    const G = await offered(k);
    w.clock += EXPIRY;
    await w.tick();
    expect((await reportOf(k.A1, k.sa, "offer_expired", `${G}.a`)).map((m) => m.text)).toEqual([
      `MESH: the offer of ${G}.a "Title a" to m2 expired (not accepted within 30 min). It is ready again.`,
    ]);
  });

  it("test_AC19_done_failed_question", async () => {
    const k = await cast();
    w.hook(k.B, "SessionStart", 203);
    await w.flush();
    const s3 = w.session(k.B, 203).sid;
    const G = await offered(k, ["a", { id: "t", kind: "test" }, "q"]);
    // One session per step.
    for (const [s, sid] of [
      ["a", k.bench],
      ["t", k.perf],
      ["q", s3],
    ] as const)
      expect((await act(k.B, `${G}.${s}`, "accept", { sid })).status).toBe(200);
    // test_AC19_done
    expect((await act(k.B, `${G}.a`, "done", { summary: "ok" })).status).toBe(200);
    expect((await reportOf(k.A1, k.sa, "offer_done", `${G}.a`)).map((m) => m.text)).toEqual([`MESH: ${G}.a "Title a" (offered to m2) is done: ok`]);
    // test_AC19_failed
    expect((await act(k.B, `${G}.t`, "done", { summary: "boom", outcome: "fail" })).status).toBe(200);
    expect((await reportOf(k.A1, k.sa, "offer_failed", `${G}.t`)).map((m) => m.text)).toEqual([`MESH: ${G}.t "Title t" (offered to m2) failed: boom`]);
    // test_AC19_question
    const q = await w.call(k.B.login.token, "POST", "/v1/questions", { text: "why?", sid: s3, step: `${G}.q` });
    expect(q.status).toBe(201);
    const rows = await reportOf(k.A1, k.sa, "offer_question", `${G}.q`);
    expect(rows).toHaveLength(1);
    expect(rows[0].text.startsWith(`MESH: question on ${G}.q (offered to m2) from @bob: why?. Answer with: mesh answer ${q.json.id} `)).toBe(true);
  });

  it("test_AC19_no_sid_none", async () => {
    const k = await cast();
    const G = await goal(k.A1, ["a", "b"]);
    for (const s of ["a", "b"]) expect((await assign(k.A1, `${G}.${s}`, { to: "bob/m2" })).status).toBe(200);
    expect((await act(k.B, `${G}.a`, "accept", { sid: k.bench })).status).toBe(200);
    expect((await act(k.B, `${G}.b`, "decline", {})).status).toBe(200);
    expect((await stepOf(`${G}.a`)).offer.state).toBe("accepted");
    for (const p of w.machines) for (const m of await inboxOf(p)) expect(String(m.kind).startsWith("offer_") && (mentions(m, `${G}.a`) || mentions(m, `${G}.b`)), JSON.stringify(m)).toBe(false);
  });

  it("test_AC19_ended_session_none", async () => {
    const k = await cast();
    const G = await offered(k);
    w.hook(k.A1, "SessionEnd", 100);
    await w.flush();
    expect((await act(k.B, `${G}.a`, "accept", { sid: k.bench })).status).toBe(200);
    expect(await reportOf(k.A1, k.sa, "offer_accepted", `${G}.a`)).toEqual([]);
  });

  it("test_AC19_withdraw_none", async () => {
    const k = await cast();
    const G = await offered(k);
    expect((await act(k.A1, `${G}.a`, "withdraw")).status).toBe(200);
    expect((await inboxOf(k.A1)).filter((m) => String(m.kind).startsWith("offer_"))).toEqual([]);
  });
});

// ---------------------------------------------------------------------------------------------
// Daemon side: a smaller cast. bob's B (`m2`) in repo svc, his B2 (`b2`); alice's A1 with session sa.

interface DCast {
  A1: Person;
  B: Person;
  B2: Person;
  C: Person;
  sa: string;
}
async function dcast(o: { bShare?: Share; accept?: string[]; assignments?: "deliver" | "launch" | "off" } = {}): Promise<DCast> {
  w = new World();
  await w.start(["alice", "bob", "carol"]);
  const A1 = await w.person("alice", "svc", { shareSessions: "me", hostname: "alice-a1" });
  const B = await w.person("bob", "svc", { shareSessions: o.bShare ?? "all", hostname: "host-b" });
  const B2 = await w.person("bob", "svc", { shareSessions: "me", hostname: "bob-b2" });
  const C = await w.person("carol", "svc", { shareSessions: "me", hostname: "carol-c" });
  await nick(A1, "a1");
  await nick(B, "m2");
  await nick(B2, "b2");
  await nick(C, "c");
  for (const name of ["perf", "dataplane"]) expect((await w.call(A1.login.token, "POST", "/v1/topics", { name })).status).toBe(201);
  if (o.accept || o.assignments) await w.restart(B, { ...(o.accept ? { accept: o.accept } : {}), ...(o.assignments ? { assignments: o.assignments } : {}) });
  w.hook(A1, "SessionStart", 100);
  w.hook(B2, "SessionStart", 210);
  await w.flush();
  return { A1, B, B2, C, sa: w.session(A1, 100).sid };
}
/** An auto offer: bob from B2 to his B (policy self). */
async function autoOffer(d: DCast, id: string, to = "m2"): Promise<number> {
  const r = await assign(d.B2, id, { to });
  expect(r.status, JSON.stringify(r.json)).toBe(200);
  expect(r.json.auto).toBe(true);
  const [m] = await offerMsgs(d.B, id);
  expect(m, "the machine-wide message").toBeDefined();
  return m.id as number;
}
const acksOf = (p: Person, id: number) => p.acks.filter((a) => a.id === id);
const sessionsOf = async (p: Person): Promise<Json[]> => (await local(p, "GET", "/local/sessions")).json.sessions;

describe("AC-20 daemon auto-accept", () => {
  it("test_AC20_binds_idle_session", async () => {
    const d = await dcast();
    w.hook(d.B, "SessionStart", 201);
    await w.flush();
    const s1 = w.session(d.B, 201).sid;
    const G = await goal(d.A1, ["a"], ["perf"]);
    const id = `${G}.a`;
    const msg = await autoOffer(d, id);
    await pull(d.B);
    expect(await until(async () => (await stepOf(id)).offer?.state === "accepted")).toBe(true);
    expect((await sessionsOf(d.B)).find((s) => s.sid === s1)?.step).toBe(id);
    expect((await stepOf(id)).holderSid).toBe(s1);
    expect(d.B.store.pendingMessages(s1).map((m) => m.text)).toContain(stepMessage(id));
    await observeIdle(d.B, [201]);
    expect(await until(() => d.B.pastes.some((p) => p.pane === "%201" && p.text.includes(id)))).toBe(true);
    // test_AC20_ack_delivered_accepted
    expect(await until(() => acksOf(d.B, msg).length > 0)).toBe(true);
    expect(acksOf(d.B, msg)).toEqual([{ id: msg, state: "delivered", method: "accepted" }]);
    // test_AC20_second_pull_nothing
    await pull(d.B);
    await pull(d.B);
    await observeIdle(d.B, [201]);
    expect(d.B.pastes.filter((p) => p.text.includes(id))).toHaveLength(1);
    expect(await events("step.accepted", id)).toHaveLength(1);
    expect(acksOf(d.B, msg)).toHaveLength(1);
  });

  it("test_AC20_prefers_labels", async () => {
    const d = await dcast();
    const p2 = await namedSession(d.B, 202, "p2");
    w.clock += MIN;
    const p1 = await namedSession(d.B, 201, "p1");
    expect((await label(d.B, p1, ["perf"])).status).toBe(200);
    expect((await label(d.B, p2, ["perf", "dataplane"])).status).toBe(200);
    w.clock += MIN;
    w.hook(d.B, "Stop", 201, { stop_hook_active: false, last_assistant_message: "x" });
    await w.flush();
    const G = await goal(d.A1, ["a"], ["perf", "dataplane"]);
    const id = `${G}.a`;
    await autoOffer(d, id);
    await pull(d.B);
    expect(await until(async () => (await stepOf(id)).holderSid !== undefined)).toBe(true);
    expect((await stepOf(id)).holderSid).toBe(p2);
    expect(w.session(d.B, 202).step).toBe(id);
    expect(w.session(d.B, 201).step).toBeUndefined();
  });

  it("test_AC20_named_working_waits_for_stop", async () => {
    const d = await dcast();
    const wk = await namedSession(d.B, 205, "wk");
    w.hook(d.B, "UserPromptSubmit", 205, { prompt: "work" });
    expect(w.session(d.B, 205).state).toBe("working");
    await w.flush();
    const G = await goal(d.A1, ["a"]);
    const id = `${G}.a`;
    await autoOffer(d, id, "m2/wk");
    await pull(d.B);
    expect(await until(async () => (await stepOf(id)).holderSid === wk)).toBe(true);
    expect((await stepOf(id)).offer.state).toBe("accepted");
    expect(d.B.pastes.filter((p) => p.text.includes(id))).toEqual([]);
    const reply = w.hook(d.B, "Stop", 205, { stop_hook_active: false, last_assistant_message: "done" });
    await observeIdle(d.B, [205]);
    const delivered = JSON.stringify(reply).includes(id) || d.B.pastes.some((p) => p.text.includes(id));
    expect(delivered).toBe(true);
  });

  it("test_AC20_no_double_while_in_flight", async () => {
    const d = await dcast();
    w.hook(d.B, "SessionStart", 201);
    await w.flush();
    const G = await goal(d.A1, ["a"]);
    const id = `${G}.a`;
    await autoOffer(d, id);
    let open!: () => void;
    d.B.hold = { path: /\/accept$/, until: new Promise<void>((r) => (open = r)) };
    const first = d.B.daemon.link?.pullInbox();
    await sleep(50);
    const second = d.B.daemon.link?.pullInbox();
    await sleep(50);
    open();
    await Promise.all([first, second]);
    await sleep(150);
    d.B.hold = undefined;
    expect(d.B.requests.filter((r) => r.method === "POST" && r.path === `/v1/steps/${id}/accept`)).toHaveLength(1);
    expect((await stepOf(id)).offer?.state).toBe("accepted");
  });

  it("test_AC20_two_offers_one_idle_session", async () => {
    // Two auto offers reach B in one pull; B has one idle step-less session. That session takes one
    // of them; the other has no idle session left, so it is listed (deliver) and stays offered.
    const d = await dcast();
    w.hook(d.B, "SessionStart", 201);
    await w.flush();
    const s1 = w.session(d.B, 201).sid;
    const G = await goal(d.A1, ["a", "b"]);
    const ids = [`${G}.a`, `${G}.b`];
    const msgs = [await autoOffer(d, ids[0] as string), await autoOffer(d, ids[1] as string)];
    await pull(d.B);
    expect(await until(() => msgs.every((m) => acksOf(d.B, m).length > 0))).toBe(true);
    const steps = await Promise.all(ids.map((id) => stepOf(id)));
    const taken = steps.filter((s) => s.offer?.state === "accepted");
    const left = steps.filter((s) => s.offer?.state === "offered");
    // Positive control: one offer was accepted for the idle session, and the session holds it.
    expect(taken).toHaveLength(1);
    expect(taken[0].holderSid).toBe(s1);
    expect(w.session(d.B, 201).step).toBe(taken[0].id);
    expect((await sessionsOf(d.B)).find((s) => s.sid === s1)?.step).toBe(taken[0].id);
    // The other one: still offered at the hub, not held, listed for the person.
    expect(left).toHaveLength(1);
    expect(left[0]).toMatchObject({ state: "ready", offer: { state: "offered" } });
    expect(left[0].holderSid).toBeUndefined();
    const takenMsg = msgs[ids.indexOf(taken[0].id)] as number;
    const leftMsg = msgs[ids.indexOf(left[0].id)] as number;
    expect(acksOf(d.B, takenMsg)).toEqual([{ id: takenMsg, state: "delivered", method: "accepted" }]);
    expect(acksOf(d.B, leftMsg)).toEqual([{ id: leftMsg, state: "delivered", method: "listed" }]);
    expect(d.B.requests.filter((r) => r.method === "POST" && r.path === `/v1/steps/${left[0].id}/accept`)).toEqual([]);
    expect(await events("step.accepted", left[0].id)).toEqual([]);
    expect(await events("step.accepted", taken[0].id)).toHaveLength(1);
  });
});

describe("AC-21 daemon without an idle session", () => {
  async function busy(d: DCast) {
    w.hook(d.B, "SessionStart", 201);
    w.hook(d.B, "UserPromptSubmit", 201, { prompt: "work" });
    await w.flush();
  }

  it("test_AC21_deliver_lists_and_notifies", async () => {
    const d = await dcast();
    await busy(d);
    const G = await goal(d.A1, ["a"]);
    const id = `${G}.a`;
    const msg = await autoOffer(d, id);
    await pull(d.B);
    expect(await until(() => acksOf(d.B, msg).length > 0)).toBe(true);
    expect(acksOf(d.B, msg)).toEqual([{ id: msg, state: "delivered", method: "listed" }]);
    expect(d.B.notes.filter((n) => n.includes(id))).toEqual([`mesh: @bob offers ${id} "Title a": mesh offers`]);
    expect(await stepOf(id)).toMatchObject({ state: "ready", offer: { state: "offered" } });
    expect(d.B.launches).toEqual([]);
  });

  it("test_AC21_launch_calls_fake", async () => {
    const d = await dcast({ assignments: "launch" });
    await busy(d);
    const G = await goal(d.A1, ["a"]);
    const id = `${G}.a`;
    const msg = await autoOffer(d, id);
    await pull(d.B);
    expect(await until(() => acksOf(d.B, msg).length > 0)).toBe(true);
    expect(d.B.launches).toStrictEqual([{ repo: "svc", step: id }]);
    expect(acksOf(d.B, msg)).toEqual([{ id: msg, state: "delivered", method: "launched" }]);
  });

  it("test_AC21_launch_fail_lists", async () => {
    const d = await dcast({ assignments: "launch" });
    d.B.launchResult = { ok: false, error: "x" };
    await busy(d);
    const G = await goal(d.A1, ["a"]);
    const id = `${G}.a`;
    const msg = await autoOffer(d, id);
    await pull(d.B);
    expect(await until(() => acksOf(d.B, msg).length > 0)).toBe(true);
    expect(d.B.launches).toHaveLength(1);
    expect(acksOf(d.B, msg)).toEqual([{ id: msg, state: "delivered", method: "listed" }]);
    expect(d.B.notes.filter((n) => n.includes(id))).toHaveLength(1);
  });

  it("test_AC21_manual_never_launches", async () => {
    const d = await dcast({ assignments: "launch" });
    w.hook(d.B, "SessionStart", 201);
    await w.flush();
    const G = await goal(d.A1, ["a"]);
    const id = `${G}.a`;
    const r = await assign(d.A1, id, { to: "bob/m2" });
    expect(r.json.auto).toBe(false);
    const [m] = await offerMsgs(d.B, id);
    await pull(d.B);
    expect(await until(() => acksOf(d.B, m.id).length > 0)).toBe(true);
    expect(d.B.launches).toEqual([]);
    expect(w.session(d.B, 201).step).toBeUndefined();
    expect(await stepOf(id)).toMatchObject({ state: "ready", offer: { state: "offered" } });
    expect(d.B.notes.filter((n) => n.includes(id))).toEqual([`mesh: @alice offers ${id} "Title a": mesh offers`]);
  });
});

describe("AC-22 assignments off, refused accept, unknown kind", () => {
  it("test_AC22_off_declines_auto_and_manual", async () => {
    const d = await dcast({ assignments: "off" });
    w.hook(d.B, "SessionStart", 201);
    await w.flush();
    const G = await goal(d.A1, ["a", "b"]);
    const mAuto = await autoOffer(d, `${G}.a`);
    expect((await assign(d.A1, `${G}.b`, { to: "bob/m2", sid: d.sa })).status).toBe(200);
    const [mManual] = await offerMsgs(d.B, `${G}.b`);
    await pull(d.B);
    expect(await until(() => acksOf(d.B, mAuto).length > 0 && acksOf(d.B, mManual.id).length > 0)).toBe(true);
    for (const s of ["a", "b"]) expect((await stepOf(`${G}.${s}`)).offer, s).toMatchObject({ state: "declined", note: "this machine does not take assignments" });
    expect(acksOf(d.B, mAuto)).toEqual([{ id: mAuto, state: "delivered", method: "declined" }]);
    expect(acksOf(d.B, mManual.id)).toEqual([{ id: mManual.id, state: "delivered", method: "declined" }]);
    expect(await reportOf(d.A1, d.sa, "offer_declined", `${G}.b`)).toHaveLength(1);
    expect(w.session(d.B, 201).step).toBeUndefined();
  });

  it("test_AC22_refused_accept_failed", async () => {
    const d = await dcast();
    w.hook(d.B, "SessionStart", 201);
    await w.flush();
    const G = await goal(d.A1, ["a"]);
    const id = `${G}.a`;
    const msg = await autoOffer(d, id);
    expect((await act(d.B2, id, "withdraw")).status).toBe(200);
    await pull(d.B);
    expect(await until(() => acksOf(d.B, msg).length > 0)).toBe(true);
    expect(acksOf(d.B, msg)).toEqual([{ id: msg, state: "failed" }].map((x) => expect.objectContaining(x)));
    // The daemon tried (an accept request was made), then bound nothing.
    expect(d.B.requests.some((r) => r.method === "POST" && r.path === `/v1/steps/${id}/accept`)).toBe(true);
    expect((await sessionsOf(d.B)).filter((s) => s.step)).toEqual([]);
    await observeIdle(d.B, [201]);
    expect(d.B.pastes).toEqual([]);
  });

  it("test_AC22_unknown_kind_failed", async () => {
    const d = await dcast();
    w.hook(d.B, "SessionStart", 201);
    await w.flush();
    const m = await w.hubStore.addMessage({ toMachine: w.machineOf(d.B), toSid: "", fromUser: "bob", kind: "other", text: "x" }, w.clock);
    await pull(d.B);
    expect(await until(() => acksOf(d.B, m.id).length > 0)).toBe(true);
    expect(acksOf(d.B, m.id)[0]?.state).toBe("failed");
    expect(d.B.notes).toEqual([]);
    expect(d.B.pastes).toEqual([]);
  });

  it("test_AC22_session_messages_unchanged", async () => {
    const d = await dcast();
    w.hook(d.B, "SessionStart", 201);
    await w.flush();
    const sid = w.session(d.B, 201).sid;
    expect((await w.call(d.B2.login.token, "POST", "/v1/messages", { toSid: sid, text: "hello there" })).status).toBe(201);
    await pull(d.B);
    await observeIdle(d.B, [201]);
    expect(await until(() => d.B.pastes.some((p) => p.text === "hello there"))).toBe(true);
  });
});

describe("AC-23 daemon local routes (World)", () => {
  async function two(d: DCast) {
    const perf = await namedSession(d.B, 201, "perf");
    const other = await namedSession(d.B, 202, "other");
    expect((await label(d.B, other, ["perf", "dataplane"])).status).toBe(200);
    await w.flush();
    return { perf, other };
  }

  it("test_AC23_accept_with_target", async () => {
    const d = await dcast();
    const { perf } = await two(d);
    const G = await goal(d.A1, ["a"]);
    const id = `${G}.a`;
    expect((await assign(d.A1, id, { to: "bob/m2" })).status).toBe(200);
    const r = await local(d.B, "POST", "/local/accept", { step: id, target: "perf" });
    expect(r).toEqual({ status: 200, json: { step: id, sid: perf, message: `perf now holds ${id}` } });
    expect(w.session(d.B, 201).step).toBe(id);
    expect(d.B.store.pendingMessages(perf).map((m) => m.text)).toContain(stepMessage(id));
    expect(await stepOf(id)).toMatchObject({ holderSid: perf, offer: { state: "accepted" } });
  });

  it("test_AC23_accept_target_any_state", async () => {
    const d = await dcast();
    const wk = await namedSession(d.B, 205, "wk");
    w.hook(d.B, "UserPromptSubmit", 205, { prompt: "go" });
    await w.flush();
    const G = await goal(d.A1, ["a"]);
    const id = `${G}.a`;
    expect((await assign(d.A1, id, { to: "bob/m2" })).status).toBe(200);
    const r = await local(d.B, "POST", "/local/accept", { step: id, target: "wk" });
    expect(r.status, JSON.stringify(r.json)).toBe(200);
    expect(r.json.sid).toBe(wk);
    expect(w.session(d.B, 205).step).toBe(id);
  });

  it("test_AC23_accept_pick", async () => {
    const d = await dcast();
    const { other } = await two(d);
    const G = await goal(d.A1, ["a"], ["perf", "dataplane"]);
    const id = `${G}.a`;
    expect((await assign(d.A1, id, { to: "bob/m2" })).status).toBe(200);
    const r = await local(d.B, "POST", "/local/accept", { step: id });
    expect(r.status, JSON.stringify(r.json)).toBe(200);
    expect(r.json).toEqual({ step: id, sid: other, message: `other now holds ${id}` });
  });

  it("test_AC23_accept_named_sid_used", async () => {
    const d = await dcast();
    const { perf } = await two(d);
    const G = await goal(d.A1, ["a"], ["perf", "dataplane"]);
    const id = `${G}.a`;
    expect((await assign(d.A1, id, { to: "bob/m2/perf" })).status).toBe(200);
    const r = await local(d.B, "POST", "/local/accept", { step: id });
    expect(r.status, JSON.stringify(r.json)).toBe(200);
    expect(r.json.sid).toBe(perf);
  });

  it("test_AC23_accept_no_candidate_and_unknown_target", async () => {
    const d = await dcast();
    w.hook(d.B, "SessionStart", 205);
    w.hook(d.B, "UserPromptSubmit", 205, { prompt: "go" });
    await w.flush();
    const G = await goal(d.A1, ["a"]);
    const id = `${G}.a`;
    expect((await assign(d.A1, id, { to: "bob/m2" })).status).toBe(200);
    expect(await local(d.B, "POST", "/local/accept", { step: id })).toEqual({ status: 409, json: { error: "no idle session for svc on this machine; use --session <s> or --launch" } });
    expect(await local(d.B, "POST", "/local/accept", { step: id, target: "nope" })).toEqual({ status: 404, json: { error: 'no live session matches "nope"' } });
    expect((await stepOf(id)).offer.state).toBe("offered");
    expect(w.session(d.B, 205).step).toBeUndefined();
  });

  it("test_AC23_accept_hub_error_passthrough", async () => {
    const d = await dcast();
    await two(d);
    const G = await goal(d.A1, ["a"]);
    const id = `${G}.a`;
    expect((await assign(d.A1, id, { to: "bob/b2" })).status).toBe(200);
    expect(await local(d.B, "POST", "/local/accept", { step: id, target: "perf" })).toEqual({ status: 403, json: { error: NOT_THIS(id, "b2") } });
    expect(w.session(d.B, 201).step).toBeUndefined();
  });

  it("test_AC23_offers_this_machine_only_and_decline", async () => {
    const d = await dcast();
    const G = await goal(d.A1, ["a", "b"]);
    expect((await assign(d.A1, `${G}.a`, { to: "bob/m2" })).status).toBe(200);
    expect((await assign(d.A1, `${G}.b`, { to: "bob/b2" })).status).toBe(200);
    const r = await local(d.B, "GET", "/local/offers");
    expect(r.status).toBe(200);
    expect(r.json.offers.map((o: Json) => o.step)).toEqual([`${G}.a`]);
    // test_AC23_decline
    const dec = await local(d.B, "POST", "/local/decline", { step: `${G}.a`, note: "x" });
    expect(dec.status, JSON.stringify(dec.json)).toBe(200);
    expect(dec.json.step.offer).toMatchObject({ state: "declined", note: "x" });
  });

  it("test_AC23_session_accept_set_clear", async () => {
    const d = await dcast();
    const { perf } = await two(d);
    const set = await local(d.B, "POST", "/local/session-accept", { target: "perf", accept: ["user:bob"] });
    expect(set.status, JSON.stringify(set.json)).toBe(200);
    expect(set.json.session).toMatchObject({ sid: perf, accept: ["user:bob"] });
    await w.flush();
    const fleetSession = async () => ((await w.api(d.B, "GET", "/v1/fleet")).json.machines as Json[]).flatMap((m) => m.sessions).find((s: Json) => s.sid === perf);
    expect((await fleetSession()).accept).toStrictEqual(["user:bob"]);
    const clear = await local(d.B, "POST", "/local/session-accept", { target: "perf", accept: null });
    expect(clear.status).toBe(200);
    expect(Object.hasOwn(clear.json.session, "accept")).toBe(false);
    await w.flush();
    expect(Object.hasOwn(await fleetSession(), "accept")).toBe(false);
    // test_AC23_session_accept_bad_rule_400, test_AC23_session_accept_unknown_404
    expect(await local(d.B, "POST", "/local/session-accept", { target: "perf", accept: ["bob"] })).toEqual({ status: 400, json: { error: `not an accept rule: bob (${RULE})` } });
    expect(Object.hasOwn(w.session(d.B, 201), "accept")).toBe(false);
    expect(await local(d.B, "POST", "/local/session-accept", { target: "nope", accept: ["self"] })).toEqual({ status: 404, json: { error: 'no live session matches "nope"' } });
  });

  it("test_AC23_not_logged_in_409", async () => {
    const d = await dcast();
    const off = await w.person("bob", "svc", { noCredentials: true, hostname: "bob-off" });
    const G = await goal(d.A1, ["a"]);
    expect(await local(off, "POST", "/local/accept", { step: `${G}.a` })).toEqual({ status: 409, json: { error: "not logged in to a hub; run: mesh login" } });
    expect((await local(off, "GET", "/local/offers")).status).toBe(409);
  });

  it("test_AC23_client_methods", async () => {
    const d = await dcast();
    const { perf } = await two(d);
    const G = await goal(d.A1, ["a", "b"]);
    expect((await assign(d.A1, `${G}.a`, { to: "bob/m2" })).status).toBe(200);
    expect((await assign(d.A1, `${G}.b`, { to: "bob/m2" })).status).toBe(200);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- new client methods
    const client = new DaemonClient({ port: d.B.daemon.port, key: d.B.config.key }) as any;
    // DaemonClient.offers() resolves to the offer list itself (OfferView[]), as the CLI and TUI use it.
    expect((await client.offers()).map((o: Json) => o.step).sort()).toEqual([`${G}.a`, `${G}.b`]);
    expect(await client.accept(`${G}.a`, "perf")).toEqual({ step: `${G}.a`, sid: perf, message: `perf now holds ${G}.a` });
    expect((await client.decline(`${G}.b`, "x")).step.offer).toMatchObject({ state: "declined", note: "x" });
    expect((await client.sessionAccept("perf", ["user:bob"])).accept).toStrictEqual(["user:bob"]);
    await expect(client.sessionAccept("nope", null)).rejects.toThrow('no live session matches "nope"');
  });
});

// ---------------------------------------------------------------------------------------------

describe("AC-24 MCP tools", () => {
  it("test_AC24_assign_step_bySid_and_goal", async () => {
    const k = await cast();
    const G = await goal(k.A1, ["a"]);
    const r = await w.tool(k.A1, 100, "mesh_assign" as never, { target: `${G}.a`, to: "bob/m2" });
    expect(r.isError).toBeUndefined();
    expect(r.text).toBe(`Offered ${G}.a to bob/m2 (waits for them to accept).`);
    expect((await stepOf(`${G}.a`)).offer.bySid).toBe(k.sa);
    // test_AC24_assign_goal
    const H = await goal(k.A1);
    const g = await w.tool(k.A1, 100, "mesh_assign" as never, { target: H, to: "m1" });
    expect(g.text).toBe(`Offered ${H}.design to m1 (auto-accept).`);
    // test_AC24_assign_error
    // A step with no open offer, so the reply is about the target (an open offer is refused first).
    const E = await goal(k.A1, ["a"]);
    const bad = await w.tool(k.A1, 100, "mesh_assign" as never, { target: `${E}.a`, to: "x" });
    expect(bad.isError).toBe(true);
    expect(bad.text).toContain("no machine x");
  });

  it("test_AC24_offers", async () => {
    const k = await cast();
    const none = await w.tool(k.B, 202, "mesh_offers" as never, {});
    expect(none.text).toBe("No offers for your machines.");
    const G = await goal(k.A1, ["a"]);
    expect((await assign(k.A1, `${G}.a`, { to: "bob/m2", note: "pls" })).status).toBe(200);
    const [view] = await offersOf(k.B);
    const r = await w.tool(k.B, 202, "mesh_offers" as never, {});
    expect(r.text.split("\n")).toContain(offerLine(view, w.clock));
  });

  it("test_AC24_accept_binds_and_other_machine_error", async () => {
    const k = await cast();
    const G = await goal(k.A1, ["a"]);
    const id = `${G}.a`;
    expect((await assign(k.A1, id, { to: "bob/m2" })).status).toBe(200);
    const bad = await w.tool(k.B2, 210, "mesh_accept" as never, { step: id });
    expect(bad.isError).toBe(true);
    expect(bad.text).toContain(NOT_THIS(id, "m2"));
    expect((await stepOf(id)).offer.state).toBe("offered");
    const r = await w.tool(k.B, 202, "mesh_accept" as never, { step: id });
    expect(r.isError).toBeUndefined();
    expect(r.text).toContain(`You hold mesh step ${id}`);
    expect(w.session(k.B, 202).step).toBe(id);
    expect(await stepOf(id)).toMatchObject({ holderSid: k.bench, offer: { state: "accepted" } });
  });

  it("test_AC24_next_offered_first", async () => {
    const k = await cast();
    const G = await goal(k.A1, ["a", "b", "z"]);
    expect((await assign(k.A1, `${G}.z`, { to: "bob/m2" })).status).toBe(200);
    const r = await w.tool(k.B, 202, "mesh_next");
    const lines = r.text.split("\n").filter((l) => l.includes(`${G}.`));
    expect(lines.length).toBeGreaterThanOrEqual(3);
    expect(lines[0]).toContain(`${G}.z`);
    expect((lines[0] ?? "").endsWith(" · offered to you by @alice")).toBe(true);
    for (const l of lines.slice(1)) expect(l).not.toContain("offered to you");
  });
});

// ---------------------------------------------------------------------------------------------

describe("AC-25 CLI mesh assign", () => {
  it("test_AC25_step_manual_auto_note", async () => {
    const k = await cast();
    const G = await goal(k.A1, ["a", "b"]);
    const r = await cli(k.A1, ["assign", `${G}.a`, "--to", "bob/m2", "--note", "pls"]);
    expect(r.err).toBe("");
    expect(r.code).toBe(0);
    expect(r.out).toBe(`Offered ${G}.a to bob/m2 (waits for them to accept).`);
    expect(r.requests).toContain(`POST /v1/steps/${G}.a/assign`);
    const o = (await stepOf(`${G}.a`)).offer;
    expect(o.note).toBe("pls");
    expect(o.bySid).toBeUndefined();
    // test_AC25_step_auto
    const a = await cli(k.A1, ["assign", `${G}.b`, "--to", "m1"]);
    expect(a.code).toBe(0);
    expect(a.out).toBe(`Offered ${G}.b to m1 (auto-accept).`);
  });

  it("test_AC25_goal_with_stick", async () => {
    const k = await cast();
    const G = await goal(k.A1, ["a", "b"]);
    const r = await cli(k.A1, ["assign", G, "--to", "m1", "--stick"]);
    expect(r.code, r.err).toBe(0);
    expect(r.requests).toContain(`POST /v1/goals/${G}/assign`);
    const [l1, l2] = r.out.split("\n");
    expect([`Offered ${G}.a, ${G}.b to m1 (auto-accept).`, `Offered ${G}.b, ${G}.a to m1 (auto-accept).`]).toContain(l1);
    expect(l2).toBe(`Later steps of ${G} go to m1 too (until: mesh withdraw ${G}).`);
  });

  it("test_AC25_goal_stick_nothing_ready", async () => {
    const k = await cast();
    const G = await goal(k.A1, ["a"]);
    expect((await act(k.A1, `${G}.a`, "claim", { sid: k.sa })).status).toBe(200);
    const r = await cli(k.A1, ["assign", G, "--to", "m1", "--stick"]);
    expect(r.code, r.err).toBe(0);
    expect(r.out.split("\n")).toEqual([`No step of ${G} is ready now.`, `Later steps of ${G} go to m1 too (until: mesh withdraw ${G}).`]);
  });

  it("test_AC25_missing_to_usage_and_hub_404", async () => {
    const k = await cast();
    const G = await goal(k.A1, ["a"]);
    for (const args of [["assign", G], ["assign"]]) {
      const r = await cli(k.A1, args);
      expect(r.code, args.join(" ")).toBe(2);
      expect(r.err.startsWith('usage: mesh assign <goal|step> --to <machine>[/<session>] [--stick] [--note "…"]'), r.err).toBe(true);
      expect(r.requests.filter((x) => x.includes("/assign"))).toEqual([]);
    }
    // test_AC25_hub_404_exit_1
    const bad = await cli(k.A1, ["assign", `${G}.a`, "--to", "x"]);
    expect(bad.code).toBe(1);
    expect(bad.err).toContain("no machine x");
  });
});

describe("AC-26 CLI offers, accept, decline, withdraw, session accept", () => {
  it("test_AC26_offers_text_and_json", async () => {
    const k = await cast();
    const none = await cli(k.B, ["offers"]);
    expect(none.code, none.err).toBe(0);
    expect(none.out).toBe("No offers for your machines.");
    const G = await goal(k.A1, ["a"]);
    expect((await assign(k.A1, `${G}.a`, { to: "bob/m2" })).status).toBe(200);
    const [view] = await offersOf(k.B);
    const text = await cli(k.B, ["offers"]);
    // The CLI has no injected clock: it counts the expiry against wall time.
    expect(text.out).toBe(offerLine(view, Date.now()));
    const json = await cli(k.B, ["offers", "--json"]);
    expect(JSON.parse(json.out).offers.map((o: Json) => o.step)).toEqual([`${G}.a`]);
  });

  it("test_AC26_accept_session_and_error", async () => {
    const k = await cast();
    const G = await goal(k.A1, ["a", "b"]);
    expect((await assign(k.A1, `${G}.a`, { to: "bob/m2" })).status).toBe(200);
    const r = await cli(k.B, ["accept", `${G}.a`, "--session", "perf"]);
    expect(r.code, r.err).toBe(0);
    expect(r.out).toBe(`perf now holds ${G}.a`);
    expect((await stepOf(`${G}.a`)).holderSid).toBe(k.perf);
    // test_AC26_accept_error_exit_1
    expect((await assign(k.A1, `${G}.b`, { to: "bob/b2" })).status).toBe(200);
    const bad = await cli(k.B, ["accept", `${G}.b`, "--session", "perf-bench"]);
    expect(bad.code).toBe(1);
    expect(bad.err).toContain(NOT_THIS(`${G}.b`, "b2"));
  });

  it("test_AC26_decline", async () => {
    const k = await cast();
    const G = await goal(k.A1, ["a"]);
    expect((await assign(k.A1, `${G}.a`, { to: "bob/m2" })).status).toBe(200);
    const r = await cli(k.B, ["decline", `${G}.a`, "--note", "x"]);
    expect(r.code, r.err).toBe(0);
    expect(r.out).toBe(`Declined ${G}.a.`);
    expect((await stepOf(`${G}.a`)).offer).toMatchObject({ state: "declined", note: "x" });
    expect((await cli(k.B, ["decline"])).code).toBe(2);
  });

  it("test_AC26_withdraw_step_goal", async () => {
    const k = await cast();
    const G = await goal(k.A1, ["a", "b"]);
    expect((await assign(k.A1, `${G}.a`, { to: "bob/m2" })).status).toBe(200);
    const s = await cli(k.A1, ["withdraw", `${G}.a`]);
    expect(s.code, s.err).toBe(0);
    expect(s.out).toBe(`Withdrew the offer of ${G}.a.`);
    expect((await assignGoal(k.A1, G, { to: "bob/m2", stick: true })).status).toBe(200);
    const g = await cli(k.A1, ["withdraw", G]);
    expect(g.code, g.err).toBe(0);
    const offeredNow = ["a", "b"].map((x) => `${G}.${x}`);
    expect([`Withdrew the offers of ${G}: ${offeredNow.join(", ")}; later steps are no longer offered.`, `Withdrew the offers of ${G}: ${offeredNow.join(",")}; later steps are no longer offered.`]).toContain(g.out);
    const G2 = await goal(k.A1, ["a"]);
    expect((await act(k.A1, `${G2}.a`, "claim", { sid: k.sa })).status).toBe(200);
    expect((await assignGoal(k.A1, G2, { to: "bob/m2", stick: true })).status).toBe(200);
    const g2 = await cli(k.A1, ["withdraw", G2]);
    expect(g2.out).toBe(`Withdrew the offers of ${G2}: none; later steps are no longer offered.`);
    const again = await cli(k.A1, ["withdraw", G2]);
    expect(again.code).toBe(1);
  });

  it("test_AC26_session_accept_forms", async () => {
    const k = await cast();
    const from = await cli(k.B, ["session", "accept", "perf", "--from", "self,user:bob"]);
    expect(from.code, from.err).toBe(0);
    expect(from.out).toBe("perf: accepts offers from self, user:bob");
    // Positive control for "no daemon call" below: this one reached the daemon.
    expect(from.requests).toContain("POST /local/session-accept");
    expect(w.session(k.B, 201)).toMatchObject({ accept: ["self", "user:bob"] });
    const off = await cli(k.B, ["session", "accept", "perf", "--off"]);
    expect(off.out).toBe("perf: accepts no offer automatically");
    const clear = await cli(k.B, ["session", "accept", "perf", "--clear"]);
    expect(clear.out).toBe("perf: uses the machine policy");
    expect(Object.hasOwn(w.session(k.B, 201), "accept")).toBe(false);
    // A bad rule: exit 2, no daemon call.
    const bad = await cli(k.B, ["session", "accept", "perf", "--from", "bob"]);
    expect(bad.code).toBe(2);
    expect(bad.err).toContain(`not an accept rule: bob (${RULE})`);
    expect(bad.requests).toEqual([]);
  });
});

// ---------------------------------------------------------------------------------------------

describe("AC-29 goal detail offers and stick", () => {
  it("test_AC29_detail_offers_stick", async () => {
    const k = await cast();
    const G = await goal(k.A1, ["s", "t"]);
    // test_AC29_detail_no_keys
    const before = await detailOf(G);
    expect(Object.hasOwn(before, "offers")).toBe(false);
    expect(Object.hasOwn(before, "stick")).toBe(false);
    const at = w.clock;
    expect((await assign(k.A1, `${G}.s`, { to: "bob/m2" })).status).toBe(200);
    expect((await act(k.B, `${G}.s`, "accept", { sid: k.bench })).status).toBe(200);
    expect((await assign(k.A1, `${G}.t`, { to: "bob/m2" })).status).toBe(200);
    expect((await act(k.B, `${G}.t`, "decline", { note: "busy" })).status).toBe(200);
    const d = await detailOf(G);
    expect(d.offers[`${G}.s`]).toStrictEqual({ to: "m2", state: "accepted", by: "alice", at, accepted: "m2/perf-bench" });
    expect(d.offers[`${G}.t`]).toMatchObject({ to: "m2", state: "declined", by: "alice", note: "busy" });
    expect(Object.hasOwn(d, "stick")).toBe(false);
    // test_AC29_detail_stick
    const H = await goal(k.A1);
    expect((await assignGoal(k.A1, H, { to: "bob/m2", stick: true })).status).toBe(200);
    expect((await detailOf(H)).stick).toBe("m2");
  });

  it("test_AC29_accepted_no_session_record", async () => {
    const k = await cast({ bShare: "steps" });
    const G = await goal(k.A1, ["s"]);
    expect((await assign(k.A1, `${G}.s`, { to: "bob/m2" })).status).toBe(200);
    const r = await act(k.B, `${G}.s`, "accept", { sid: "s-never-synced" });
    expect(r.status, JSON.stringify(r.json)).toBe(200);
    expect((await detailOf(G)).offers[`${G}.s`].accepted).toBe("m2");
  });
});

describe("AC-30 /v1/live activity texts", () => {
  it("test_AC30_activity_texts", async () => {
    const k = await cast();
    const G = await goal(k.A1, ["a", "b", "c", "d"]);
    const id = (s: string) => `${G}.${s}`;
    for (const s of ["a", "b", "c", "d"]) expect((await assign(k.A1, id(s), { to: "bob/m2" })).status).toBe(200);
    expect((await act(k.B, id("a"), "accept", { sid: k.bench })).status).toBe(200);
    expect((await act(k.B, id("b"), "decline")).status).toBe(200);
    expect((await act(k.A1, id("c"), "withdraw")).status).toBe(200);
    w.clock += EXPIRY;
    await w.tick();
    const texts = await activity(k.A1);
    expect(texts).toContain(`offered ${id("a")} to host-b`);
    expect(texts).toContain(`accepted ${id("a")} on host-b`);
    expect(texts).toContain(`declined ${id("b")} on host-b`);
    expect(texts).toContain(`withdrew the offer of ${id("c")} to host-b`);
    expect(texts).toContain(`the offer of ${id("d")} to host-b expired`);
  });
});

// ---------------------------------------------------------------------------------------------

describe("AC-35 borrowed sid", () => {
  it("test_AC35_carol_with_bobs_sid", async () => {
    const k = await cast();
    const G = await goal(k.A1, ["a"]);
    const id = `${G}.a`;
    expect((await assign(k.A1, id, { to: "bob/m2" })).status).toBe(200);
    expect(await act(k.C, id, "claim", { sid: k.bench })).toEqual({ status: 403, json: { error: NOT_YOURS(k.bench) } });
    expect(await act(k.C, id, "accept", { sid: k.bench })).toEqual({ status: 403, json: { error: NOT_YOURS(k.bench) } });
    expect(await stepOf(id)).toMatchObject({ state: "ready", offer: { state: "offered" } });
    // Positive control: bob's own sid from B.
    expect((await act(k.B, id, "accept", { sid: k.bench })).status).toBe(200);
  });

  it("test_AC35_bob_accept_with_carols_sid_on_B", async () => {
    const k = await cast();
    const sc: Session = { sid: "s-carol-on-b", claudeSessionIds: ["c-x"], cwd: "", kind: "interactive", state: "idle", quiet: false, startedAt: w.clock, lastEventAt: w.clock, turns: 0, humanPrompts: 0, seenByReconciler: true };
    await w.hubStore.upsertSession(sc, "carol", w.machineOf(k.B), w.clock);
    const G = await goal(k.A1, ["a"]);
    const id = `${G}.a`;
    expect((await assign(k.A1, id, { to: "bob/m2" })).status).toBe(200);
    expect(await act(k.B, id, "accept", { sid: sc.sid })).toEqual({ status: 403, json: { error: NOT_YOURS(sc.sid) } });
    expect((await stepOf(id)).offer.state).toBe("offered");
    expect((await act(k.B, id, "accept", { sid: k.bench })).status).toBe(200);
  });

  it("test_AC35_assign_with_sid_of_m1_and_without", async () => {
    const k = await cast();
    await w.restart(k.A1, { accept: ["machine:m1"] });
    await w.flush();
    const G = await goal(k.A1, ["a"]);
    const id = `${G}.a`;
    expect(await assign(k.C, id, { to: "alice/a1", sid: k.sa2 })).toEqual({ status: 403, json: { error: NOT_YOURS(k.sa2) } });
    expect((await stepOf(id)).offer).toBeUndefined();
    // test_AC35_assign_without_sid
    const r = await assign(k.C, id, { to: "alice/a1" });
    expect(r.status, JSON.stringify(r.json)).toBe(200);
    expect(r.json.auto).toBe(false);
    expect(r.json.step.offer.byMachine).toBe(w.machineOf(k.C));
  });

  it("test_AC35_tokenless_machine_accept", async () => {
    const k = await cast();
    const G = await goal(k.A1, ["a"]);
    const id = `${G}.a`;
    expect((await assign(k.A1, id, { to: "bob/m2" })).status).toBe(200);
    // A web session of bob: no machine.
    const login = await fetch(`${w.hub.url}/auth/team/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ token: "bob-token-secret", client: "web" }) });
    const cookie = (login.headers.get("set-cookie") ?? "").split(";")[0] as string;
    expect(cookie).toMatch(/^mesh_session=/);
    const r = await fetch(`${w.hub.url}/v1/steps/${id}/accept`, { method: "POST", headers: { "content-type": "application/json", cookie, origin: new URL(w.hub.url).origin }, body: "{}" });
    expect(r.status).toBe(403);
    expect(await r.json()).toEqual({ error: NOT_THIS(id, "m2") });
    expect((await stepOf(id)).offer.state).toBe("offered");
  });

  it("test_AC35_unknown_sid_not_403", async () => {
    const k = await cast();
    const G = await goal(k.A1, ["a"]);
    const id = `${G}.a`;
    expect((await assign(k.A1, id, { to: "bob/m2" })).status).toBe(200);
    expect(await act(k.C, id, "claim", { sid: "s-hub-never-saw" })).toEqual({ status: 409, json: { error: OFFERED_TO(id, "m2") } });
  });
});

describe("AC-37 question on an accepted offer", () => {
  it("test_AC37_offerer_in_toUsers_attention_message_answer", async () => {
    const k = await cast();
    const G = await goal(k.A1, ["a", "n"]);
    const id = `${G}.a`;
    expect((await assign(k.D, id, { to: "bob/m2", sid: k.sd })).status).toBe(200);
    expect((await act(k.B, id, "accept", { sid: k.bench })).status).toBe(200);
    const q = await w.call(k.B.login.token, "POST", "/v1/questions", { text: "which way?", sid: k.bench, step: id });
    expect(q.status).toBe(201);
    const toUsers = q.json.toUsers as string[];
    expect(toUsers).toContain("dave");
    expect(toUsers).toContain("alice");
    expect(new Set(toUsers).size).toBe(toUsers.length);
    expect(toUsers.at(-1)).toBe("dave");
    // test_AC37_dave_attention_question
    expect((await attention(k.D)).find((a) => a.kind === "question" && a.question === q.json.id)).toBeDefined();
    // test_AC37_offer_question_message
    const rows = await reportOf(k.D, k.sd, "offer_question", id);
    expect(rows).toHaveLength(1);
    expect(rows[0].text).toContain(`mesh answer ${q.json.id}`);
    // test_AC37_dave_answers
    expect((await w.call(k.D.login.token, "POST", `/v1/questions/${q.json.id}/answer`, { text: "ok" })).status).toBe(200);
  });

  it("test_AC37_no_offer_and_declined_unchanged", async () => {
    const k = await cast();
    const G = await goal(k.A1, ["a", "b"]);
    expect((await act(k.B, `${G}.a`, "claim", { sid: k.bench })).status).toBe(200);
    const q1 = await w.call(k.B.login.token, "POST", "/v1/questions", { text: "q1", sid: k.bench, step: `${G}.a` });
    expect(q1.json.toUsers).toContain("alice");
    expect(q1.json.toUsers).not.toContain("dave");
    expect((await assign(k.D, `${G}.b`, { to: "bob/m2", sid: k.sd })).status).toBe(200);
    expect((await act(k.B, `${G}.b`, "decline")).status).toBe(200);
    expect((await act(k.B, `${G}.b`, "claim", { sid: k.perf })).status).toBe(200);
    const q2 = await w.call(k.B.login.token, "POST", "/v1/questions", { text: "q2", sid: k.perf, step: `${G}.b` });
    expect(q2.status).toBe(201);
    expect(q2.json.toUsers).not.toContain("dave");
    expect(await reportOf(k.D, k.sd, "offer_question", `${G}.b`)).toEqual([]);
  });
});

describe("AC-38 offer ends with its step; release removes the offer", () => {
  const replan = async (k: Cast, G: string, steps: Json[]) => {
    expect((await w.call(k.A1.login.token, "POST", `/v1/goals/${G}/replan`, { comment: "again" })).status).toBe(200);
    const p = await w.call(k.A1.login.token, "POST", `/v1/goals/${G}/plan`, { steps, approve: true });
    expect(p.status, JSON.stringify(p.json)).toBe(201);
  };
  const S = (id: string, deps: string[] = []) => ({ id, repo: "svc", kind: "implement", title: `Title ${id}`, brief: "b", deps });

  for (const [name, steps] of [
    ["test_AC38_replan_drops", [S("a")]],
    ["test_AC38_replan_blocks", [S("a"), S("z", ["a"]), S("b", ["z"])]],
  ] as const) {
    it(name, async () => {
      const k = await cast();
      const G = await goal(k.A1, ["a", "b"]);
      const b = `${G}.b`;
      expect((await assign(k.A1, b, { to: "bob/m2", sid: k.sa })).status).toBe(200);
      expect((await offersOf(k.B)).map((o) => o.step)).toContain(b);
      await replan(k, G, steps as unknown as Json[]);
      const s = await stepOf(b);
      expect(s.state).not.toBe("ready");
      expect(s.offer.state).toBe("withdrawn");
      const ev = await events("step.offer_withdrawn", b);
      expect(ev).toHaveLength(1);
      expect(ev[0].payload.reason).toMatch(/^step (blocked|dropped|parked)$/);
      if (name === "test_AC38_replan_blocks") expect(ev[0].payload.reason).toBe("step blocked");
      // test_AC38_lists_cleared
      expect((await offersOf(k.B)).map((o) => o.step)).not.toContain(b);
      expect((await attention(k.B)).filter((a) => a.kind === "offer" && a.step === b)).toEqual([]);
      // test_AC38_no_report_back
      expect((await inboxOf(k.A1)).filter((m) => String(m.kind).startsWith("offer_") && mentions(m, b))).toEqual([]);
    });
  }

  it("test_AC38_release_removes_and_no_done_after", async () => {
    const k = await cast();
    const G = await goal(k.A1, ["a"]);
    const id = `${G}.a`;
    expect((await assign(k.A1, id, { to: "bob/m2", sid: k.sa })).status).toBe(200);
    expect((await act(k.B, id, "accept", { sid: k.bench })).status).toBe(200);
    expect((await stepOf(id)).offer.state).toBe("accepted");
    expect((await act(k.B, id, "release", {})).status).toBe(200);
    expect(Object.hasOwn(await stepOf(id), "offer")).toBe(false);
    expect((await detailOf(G)).offers?.[id]).toBeUndefined();
    // test_AC38_no_done_after_release
    expect((await act(k.C, id, "claim", { sid: k.sc })).status).toBe(200);
    expect((await act(k.C, id, "done", { summary: "ok" })).status).toBe(200);
    expect(await reportOf(k.A1, k.sa, "offer_done", id)).toEqual([]);
  });

  it("test_AC38_take_removes_and_no_done_after", async () => {
    // As release: a takeover of a step whose offer is accepted leaves the step without an offer, and the
    // later holder's done reports nothing to the offering session.
    const k = await cast();
    const G = await goal(k.A1, ["a"]);
    const id = `${G}.a`;
    expect((await assign(k.A1, id, { to: "bob/m2", sid: k.sa })).status).toBe(200);
    expect((await act(k.B, id, "accept", { sid: k.bench })).status).toBe(200);
    expect((await stepOf(id)).offer.state).toBe("accepted");
    // root (an admin) takes it over from bob.
    const t = await w.call(k.root, "POST", `/v1/steps/${id}/take`, {});
    expect(t.status, JSON.stringify(t.json)).toBe(200);
    const s = await stepOf(id);
    expect(s.holderUser).toBe("root");
    expect(Object.hasOwn(s, "offer")).toBe(false);
    expect((await detailOf(G)).offers?.[id]).toBeUndefined();
    expect((await act(k.root, id, "done", { summary: "ok" })).status).toBe(200);
    expect(await reportOf(k.A1, k.sa, "offer_done", id)).toEqual([]);
  });

  it("test_AC38_reopen_removes_and_no_done_after", async () => {
    // A done step whose offer was accepted, reopened by a failing test: the reopened step has no offer, and
    // the later holder's done sends no second offer_done to the offering session.
    const k = await cast();
    const G = await goal(k.A1, ["a", { id: "t", kind: "test", deps: ["a"] }]);
    const id = `${G}.a`;
    expect((await assign(k.A1, id, { to: "bob/m2", sid: k.sa })).status).toBe(200);
    expect((await act(k.B, id, "accept", { sid: k.bench })).status).toBe(200);
    expect((await act(k.B, id, "done", { summary: "first" })).status).toBe(200);
    expect((await reportOf(k.A1, k.sa, "offer_done", id)).map((m) => m.text)).toEqual([`MESH: ${id} "Title a" (offered to m2) is done: first`]);
    expect((await act(k.C, `${G}.t`, "claim", { sid: k.sc })).status).toBe(200);
    const f = await act(k.C, `${G}.t`, "done", { summary: "a is wrong", outcome: "fail", reopen: ["a"] });
    expect(f.status, JSON.stringify(f.json)).toBe(200);
    expect(f.json.reopened).toEqual([id]);
    const s = await stepOf(id);
    expect(s.state).toBe("ready");
    expect(Object.hasOwn(s, "offer")).toBe(false);
    expect((await detailOf(G)).offers?.[id]).toBeUndefined();
    expect((await act(k.C, id, "claim", { sid: k.sc })).status).toBe(200);
    expect((await act(k.C, id, "done", { summary: "second" })).status).toBe(200);
    expect((await reportOf(k.A1, k.sa, "offer_done", id)).map((m) => m.text)).toEqual([`MESH: ${id} "Title a" (offered to m2) is done: first`]);
  });
});

describe("AC-39 daemon retry after a lost reply", () => {
  async function setup() {
    const d = await dcast();
    w.hook(d.B, "SessionStart", 201);
    await w.flush();
    const G = await goal(d.A1, ["a"]);
    const id = `${G}.a`;
    const msg = await autoOffer(d, id);
    d.B.dropReplyOnce(new RegExp(`^/v1/steps/${id.replace(".", "\\.")}/accept$`));
    await pull(d.B);
    const accepts = () => d.B.requests.filter((r) => r.method === "POST" && r.path === `/v1/steps/${id}/accept`);
    // Positive control: the first try reached the hub (its reply was lost).
    expect(await until(() => accepts().length === 1)).toBe(true);
    expect((await stepOf(id)).offer.state).toBe("accepted");
    return { d, id, msg, accepts };
  }
  async function endState(d: DCast, id: string, msg: number, accepts: () => Person["requests"]) {
    expect(await until(() => acksOf(d.B, msg).length > 0)).toBe(true);
    expect(accepts()).toHaveLength(2);
    for (const r of accepts()) expect(r.key).toBe(`offer-${msg}`);
    expect(acksOf(d.B, msg)).toEqual([{ id: msg, state: "delivered", method: "accepted" }]);
    expect(w.session(d.B, 201).step).toBe(id);
    expect((await stepOf(id)).holderSid).toBe(w.session(d.B, 201).sid);
    expect(await events("step.accepted", id)).toHaveLength(1);
    await observeIdle(d.B, [201]);
    expect(await until(() => d.B.pastes.some((p) => p.text.includes(id)))).toBe(true);
    await pull(d.B);
    await observeIdle(d.B, [201]);
    expect(d.B.pastes.filter((p) => p.text.includes(id))).toHaveLength(1);
  }

  it("test_AC39_lost_reply_retried", async () => {
    const { d, id, msg, accepts } = await setup();
    expect(acksOf(d.B, msg).filter((a) => a.state === "failed")).toEqual([]);
    await pull(d.B);
    await endState(d, id, msg, accepts);
  });

  it("test_AC39_restart_retry", async () => {
    const { d, id, msg, accepts } = await setup();
    await w.restart(d.B);
    await pull(d.B);
    await endState(d, id, msg, accepts);
  });
});

describe("AC-40 unknown sid", () => {
  it("test_AC40_auto_accept_unsynced", async () => {
    const d = await dcast({ bShare: "steps" });
    w.hook(d.B, "SessionStart", 201);
    await w.flush();
    const sid = w.session(d.B, 201).sid;
    expect(await w.hubStore.getSession(sid)).toBeUndefined();
    const G = await goal(d.A1, ["a"]);
    const id = `${G}.a`;
    const msg = await autoOffer(d, id);
    await pull(d.B);
    expect(await until(() => acksOf(d.B, msg).length > 0)).toBe(true);
    expect(acksOf(d.B, msg)).toEqual([{ id: msg, state: "delivered", method: "accepted" }]);
    expect(await stepOf(id)).toMatchObject({ holderSid: sid, offer: { state: "accepted" } });
  });

  it("test_AC40_launch_new_sid", async () => {
    // assignments: "launch" and no session on B: the daemon calls launchStep (a fake here). What the
    // default launchStep starts, `mesh run <repo> --step <step> --no-tui` (tmux through a fake runner),
    // then makes a brand-new session whose first hook ends with the offer accepted and held by its sid.
    const d = await dcast({ bShare: "steps", assignments: "launch" });
    const G = await goal(d.A1, ["a"]);
    const id = `${G}.a`;
    const msg = await autoOffer(d, id);
    await pull(d.B);
    expect(await until(() => acksOf(d.B, msg).length > 0)).toBe(true);
    expect(d.B.launches).toStrictEqual([{ repo: "svc", step: id }]);
    expect(acksOf(d.B, msg)).toEqual([{ id: msg, state: "delivered", method: "launched" }]);
    // The fake started nothing: the offer is still open.
    expect((await stepOf(id)).offer.state).toBe("offered");
    const panes: string[] = [];
    let n = 0;
    const runner: Runner = async (cmd, args) => {
      if (cmd !== "tmux") return { code: 0, stdout: "", stderr: "" };
      if (args.includes("has-session")) return { code: 1, stdout: "", stderr: "no server" };
      if (args.includes("new-session") || args.includes("new-window")) {
        const pane = `%${260 + ++n}`;
        if (args.some((a) => a.includes(id))) panes.push(pane);
        return { code: 0, stdout: `${pane}\n`, stderr: "" };
      }
      return { code: 0, stdout: "", stderr: "" };
    };
    const run = await cli(d.B, ["run", "svc", "--step", id, "--no-tui"], { runner, cwd: d.B.repoDir });
    expect(run.code, run.err).toBe(0);
    expect(panes).toHaveLength(1);
    const pid = Number((panes[0] as string).slice(1));
    await w.hook(d.B, "SessionStart", pid);
    const s = w.session(d.B, pid);
    expect(s?.step).toBe(id);
    await w.flush();
    await w.flush();
    expect(await stepOf(id)).toMatchObject({ state: "claimed", holderSid: s.sid, offer: { state: "accepted" } });
    expect(await events("step.accepted", id)).toHaveLength(1);
  });

  it("test_AC40_launch_new_sid_step_header", async () => {
    // As test_AC40_launch_new_sid, with the first hook carrying X-Mesh-Step (MESH_STEP set by mesh run).
    const d = await dcast({ bShare: "steps", assignments: "launch" });
    const G = await goal(d.A1, ["a"]);
    const id = `${G}.a`;
    const msg = await autoOffer(d, id);
    await pull(d.B);
    expect(await until(() => acksOf(d.B, msg).length > 0)).toBe(true);
    expect(acksOf(d.B, msg)).toEqual([{ id: msg, state: "delivered", method: "launched" }]);
    const panes: string[] = [];
    let n = 0;
    const runner: Runner = async (cmd, args) => {
      if (cmd !== "tmux") return { code: 0, stdout: "", stderr: "" };
      if (args.includes("has-session")) return { code: 1, stdout: "", stderr: "no server" };
      if (args.includes("new-session") || args.includes("new-window")) {
        const pane = `%${280 + ++n}`;
        if (args.some((a) => a.includes(id))) panes.push(pane);
        return { code: 0, stdout: `${pane}\n`, stderr: "" };
      }
      return { code: 0, stdout: "", stderr: "" };
    };
    const run = await cli(d.B, ["run", "svc", "--step", id, "--no-tui"], { runner, cwd: d.B.repoDir });
    expect(run.code, run.err).toBe(0);
    expect(panes).toHaveLength(1);
    const pid = Number((panes[0] as string).slice(1));
    await w.hook(d.B, "SessionStart", pid, {}, { step: id });
    const s = w.session(d.B, pid);
    expect(s?.step).toBe(id);
    await w.flush();
    await w.flush();
    expect(await stepOf(id)).toMatchObject({ state: "claimed", holderSid: s.sid, offer: { state: "accepted" } });
    expect(await events("step.accepted", id)).toHaveLength(1);
  });

  it("test_AC40_mesh_assign_unsynced_bySid", async () => {
    const d = await dcast({ bShare: "steps" });
    w.hook(d.B, "SessionStart", 201);
    await w.flush();
    const sid = w.session(d.B, 201).sid;
    const G = await goal(d.A1, ["a"]);
    const r = await w.tool(d.B, 201, "mesh_assign" as never, { target: `${G}.a`, to: "b2" });
    expect(r.isError, r.text).toBeUndefined();
    expect(r.text).toBe(`Offered ${G}.a to b2 (auto-accept).`);
    expect((await stepOf(`${G}.a`)).offer.bySid).toBe(sid);
  });

  it("test_AC40_carol_unknown_sid", async () => {
    const d = await dcast({ bShare: "steps" });
    const G = await goal(d.A1, ["a"]);
    const id = `${G}.a`;
    expect((await assign(d.A1, id, { to: "bob/m2" })).status).toBe(200);
    expect(await act(d.C, id, "claim", { sid: "s-unknown-1" })).toEqual({ status: 409, json: { error: OFFERED_TO(id, "m2") } });
    expect(await act(d.C, id, "accept", { sid: "s-unknown-2" })).toEqual({ status: 403, json: { error: NOT_THIS(id, "m2") } });
    expect((await stepOf(id)).offer.state).toBe("offered");
    // Positive control: an unknown sid from B is accepted.
    expect((await act(d.B, id, "accept", { sid: "s-unknown-3" })).status).toBe(200);
  });
});
