// MM-2 labels end to end: a real hub and daemons over HTTP (World), the CLI and the MCP tool
// against them. Criteria AC-05 (client), AC-06, AC-07, AC-09, AC-10, AC-11 (MCP), AC-13, AC-14, AC-16.

import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { sha256 } from "../src/auth/index.ts";
import { DaemonClient } from "../src/cli/client.ts";
import { dispatch } from "../src/cli/commands.ts";
import type { CliEnv } from "../src/cli/context.ts";
import { meshCommands } from "../src/cli/mesh-commands.ts";
import { filterFleet, renderFleet } from "../src/core/index.ts";
import { buildHubConfig, startHub, type RunningHub } from "../src/hub/index.ts";
import { buildServer } from "../src/mcp/index.ts";
import { resolvePaths, type FleetView, type LoginResult, type Session } from "../src/protocol/index.ts";
import { fakeCheckout } from "./helpers/git-tree.ts";
import { PG_URL, PgFixture } from "./helpers/pg.ts";
import { World, type Json, type Person } from "./helpers/world.ts";

// Copied from the spec, not imported, so a changed text turns the tests red.
const RULE = "a label is 1-40 characters: lowercase letters, digits, '.', '_' or '-', starting with a letter or digit";
const NOT_TOPIC = (l: string) => `not a topic: ${l}; mesh topic add ${l}`;
const L = (n: number) => Array.from({ length: n }, (_, i) => `l${String(i + 1).padStart(2, "0")}`);

let w: World;
const dirs: string[] = [];
afterEach(async () => {
  await w?.stop();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

async function world(users: string[], opts: { admins?: string[] } = {}): Promise<World> {
  w = new World();
  await w.start(users, opts);
  return w;
}

const MIN = 60_000;

const sess = (sid: string, over: Partial<Session> = {}): Session => ({
  sid,
  claudeSessionIds: [`c-${sid}`],
  cwd: "",
  kind: "interactive",
  state: "idle",
  quiet: false,
  startedAt: w.clock - 10_000,
  lastEventAt: w.clock,
  turns: 1,
  humanPrompts: 1,
  seenByReconciler: true,
  ...over,
});

const sync = (token: string, body: Record<string, unknown>) => w.call(token, "POST", "/v1/sync", { events: [], counts: {}, sessions: [], ...body });
const fleet = async (token: string): Promise<FleetView & Json> => {
  const r = await w.call(token, "GET", "/v1/fleet");
  expect(r.status, JSON.stringify(r.json)).toBe(200);
  return r.json;
};
const live = async (token: string): Promise<Json> => {
  const r = await w.call(token, "GET", "/v1/live");
  expect(r.status, JSON.stringify(r.json)).toBe(200);
  return r.json;
};
const machineIn = (view: Json, id: string): Json => view.machines.find((m: Json) => m.id === id);

/** Every session record anywhere in a hub view (an object with a sid, a state and a lastEventAt or machine). */
function sessionsIn(x: Json, out: Json[] = []): Json[] {
  if (Array.isArray(x)) for (const v of x) sessionsIn(v, out);
  else if (x && typeof x === "object") {
    // Fleet sessions carry lastEventAt; /v1/live sessions (LiveSession) carry their machine instead.
    if (typeof x.sid === "string" && typeof x.state === "string" && (typeof x.lastEventAt === "number" || typeof x.machine === "string")) out.push(x);
    for (const v of Object.values(x)) sessionsIn(v, out);
  }
  return out;
}
const sessionIn = (view: Json, sid: string): Json => sessionsIn(view).find((s) => s.sid === sid);
const activity = async (token: string): Promise<string[]> => (await live(token)).activity.map((a: Json) => a.text);

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
const label = (p: Person, target: string, labels: string[], mode: "set" | "add" | "rm" = "set") => local(p, "POST", "/local/labels", { target, labels, mode });
const defineTopics = async (p: Person | LoginResult, names: string[]) => {
  const token = "login" in p ? p.login.token : p.token;
  for (const name of names) expect((await w.call(token, "POST", "/v1/topics", { name })).status).toBe(201);
};

interface CliRun {
  code: number;
  out: string;
  err: string;
  requests: string[];
  bodies: { request: string; body: Json }[];
}

/** Run a mesh command as on this machine (its config folder), recording the HTTP requests made. */
async function cli(p: Person, args: string[]): Promise<CliRun> {
  const out: string[] = [];
  const err: string[] = [];
  const paths = resolvePaths({ MESH_CONFIG_DIR: p.dir, MESH_STATE_DIR: join(p.dir, "state"), CLAUDE_CONFIG_DIR: join(p.dir, "claude") }, p.dir);
  const c: CliEnv = { io: { out: (t) => out.push(t), err: (t) => err.push(t) }, paths, env: {}, cwd: p.dir, self: ["mesh"], version: "0.0.0" };
  const requests: string[] = [];
  const bodies: { request: string; body: Json }[] = [];
  const real = globalThis.fetch;
  const spy = vi.spyOn(globalThis, "fetch").mockImplementation((input: string | URL | Request, init?: RequestInit) => {
    const url = input instanceof Request ? input.url : String(input);
    const request = `${init?.method ?? (input instanceof Request ? input.method : "GET")} ${new URL(url).pathname}`;
    requests.push(request);
    if (typeof init?.body === "string") {
      try {
        bodies.push({ request, body: JSON.parse(init.body) });
      } catch {
        // not JSON
      }
    }
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
  return { code, out: out.join("\n"), err: err.join("\n"), requests, bodies };
}
const errLines = (r: CliRun) => r.err.split("\n").filter(Boolean);

/** A session named `name` in the person's checkout: a `mesh run` placeholder adopted by its first hook. */
async function namedSession(p: Person, pid: number, name: string): Promise<Session> {
  const r = await local(p, "POST", "/local/launch", { pane: `%${pid}`, cwd: p.repoDir, name });
  expect(r.status, JSON.stringify(r.json)).toBe(200);
  await w.hook(p, "SessionStart", pid);
  const s = w.session(p, pid);
  expect(s.name).toBe(name);
  return s;
}

// ---------------------------------------------------------------------------------------------

describe("AC-05 DaemonClient labels and rememberLabels", () => {
  it("test_AC05_client_methods", async () => {
    await world(["bob"]);
    const bob = await w.person("bob", "alpha", { shareSessions: "me" });
    await w.hook(bob, "SessionStart", 101);
    const sid = w.session(bob, 101).sid;
    const client = new DaemonClient({ port: bob.daemon.port, key: bob.config.key });
    const set = await client.labels(sid, ["q"], "set");
    expect(set.session.sid).toBe(sid);
    expect(set.session.labels).toStrictEqual(["q"]);
    expect(w.session(bob, 101).labels).toStrictEqual(["q"]);
    const added = await client.labels(sid, ["Z"], "add");
    expect(added.session.labels).toStrictEqual(["q", "z"]);
    const remembered = await client.rememberLabels(bob.repoDir, ["r"]);
    expect(remembered).toMatchObject({ cwd: bob.repoDir, labels: ["r"] });
    await w.hook(bob, "SessionStart", 102);
    expect(w.session(bob, 102).labels).toStrictEqual(["r"]);
    await expect(client.labels("nope", ["a"], "set")).rejects.toThrow('no live session matches "nope"');
  });
});

describe("AC-06 unknown: labels that are not topics", () => {
  async function setup(topics: string[]) {
    await world(["bob"]);
    const bob = await w.person("bob", "alpha", { shareSessions: "me" });
    await defineTopics(bob, topics);
    await w.hook(bob, "SessionStart", 201);
    return { bob, sid: w.session(bob, 201).sid };
  }

  it("test_AC06_unknown_lists_undefined_topics", async () => {
    const { bob, sid } = await setup(["perf"]);
    const r = await label(bob, sid, ["perf", "gpu"]);
    expect(r.status).toBe(200);
    expect(r.json.session.labels).toStrictEqual(["gpu", "perf"]);
    expect(r.json.unknown).toStrictEqual(["gpu"]);
  });

  it("test_AC06_all_defined_empty_array", async () => {
    const { bob, sid } = await setup(["perf", "gpu"]);
    const r = await label(bob, sid, ["perf", "gpu"]);
    expect(r.status).toBe(200);
    expect(r.json.unknown).toStrictEqual([]);
    // `all` is a listed topic: no warning for it.
    expect((await label(bob, sid, ["all"])).json.unknown).toStrictEqual([]);
  });

  it("test_AC06_cwd_form_has_unknown", async () => {
    const { bob } = await setup(["perf"]);
    const r = await local(bob, "POST", "/local/labels", { cwd: bob.repoDir, labels: ["gpu", "perf"] });
    expect(r.status).toBe(200);
    expect(r.json).toStrictEqual({ cwd: bob.repoDir, labels: ["gpu", "perf"], unknown: ["gpu"] });
  });

  it("test_AC06_sorted", async () => {
    const { bob, sid } = await setup(["perf"]);
    expect((await label(bob, sid, ["zz", "aa", "perf"])).json.unknown).toStrictEqual(["aa", "zz"]);
  });

  it("test_AC06_hub_offline_no_key", async () => {
    const { bob, sid } = await setup(["perf"]);
    // Positive control: with the hub reachable the key is there.
    expect((await label(bob, sid, ["perf"])).json.unknown).toStrictEqual([]);
    bob.offline = true;
    const r = await label(bob, sid, ["gpu"]);
    expect(r.status).toBe(200);
    expect(r.json.session.labels).toStrictEqual(["gpu"]);
    expect(Object.hasOwn(r.json, "unknown")).toBe(false);
    expect(w.session(bob, 201).labels).toStrictEqual(["gpu"]);
  });

  it("test_AC06_not_logged_in_no_key", async () => {
    await world(["bob"]);
    const bob = await w.person("bob", "alpha", { noCredentials: true });
    await w.hook(bob, "SessionStart", 202);
    const r = await label(bob, w.session(bob, 202).sid, ["gpu"]);
    expect(r.status).toBe(200);
    expect(r.json.session.labels).toStrictEqual(["gpu"]);
    expect(Object.hasOwn(r.json, "unknown")).toBe(false);
  });
});

describe("AC-07 session labels reach the hub", () => {
  async function setup() {
    await world(["alice", "bob"]);
    const alice = await w.person("alice", "alpha", { shareSessions: "me" });
    const bob = await w.person("bob", "beta", { shareSessions: "me", hostname: "bob-laptop" });
    await w.hook(bob, "SessionStart", 301);
    await w.hook(bob, "SessionStart", 302);
    await w.flush();
    await w.flush();
    return { alice, bob, s1: w.session(bob, 301).sid, s2: w.session(bob, 302).sid };
  }
  const views = async (p: Person) => ({ fleet: await fleet(p.login.token), live: await live(p.login.token) });

  it("test_AC07_no_step_session_labels_in_my_views", async () => {
    const { bob, s1 } = await setup();
    expect((await label(bob, s1, ["perf"])).status).toBe(200);
    await w.flush();
    const v = await views(bob);
    expect(sessionIn(v.fleet, s1)?.labels).toStrictEqual(["perf"]);
    expect(sessionIn(v.live, s1)?.labels).toStrictEqual(["perf"]);
  });

  it("test_AC07_relabel_not_stale", async () => {
    const { bob, s1 } = await setup();
    await label(bob, s1, ["perf"]);
    await w.flush();
    await label(bob, s1, ["gpu"]);
    await w.flush();
    const v = await views(bob);
    expect(sessionIn(v.fleet, s1)?.labels).toStrictEqual(["gpu"]);
    expect(sessionIn(v.live, s1)?.labels).toStrictEqual(["gpu"]);
  });

  it("test_AC07_alice_still_cannot_see", async () => {
    const { alice, bob, s1 } = await setup();
    await label(bob, s1, ["perf"]);
    await w.flush();
    // Positive control: bob's own live view lists it.
    expect(sessionIn(await live(bob.login.token), s1)).toBeDefined();
    const text = JSON.stringify(await live(alice.login.token));
    expect(text).not.toContain(s1);
  });

  it("test_AC07_step_holder_labels_visible_to_others", async () => {
    const { alice, bob } = await setup();
    const g = await w.api(bob, "POST", "/v1/goals", { title: "labels", primaryRepo: "beta" });
    expect(g.status, JSON.stringify(g.json)).toBe(201);
    const plan = await w.api(bob, "POST", `/v1/goals/${g.json.id}/plan`, { steps: [{ id: "a", repo: "beta", kind: "implement", title: "a", brief: "a" }], approve: true });
    expect(plan.status, JSON.stringify(plan.json)).toBe(201);
    await w.hook(bob, "SessionStart", 303);
    const claimed = await w.tool(bob, 303, "mesh_claim", { step: `${g.json.id}.a` });
    expect(claimed.isError, claimed.text).toBeFalsy();
    const sid = w.session(bob, 303).sid;
    expect((await label(bob, sid, ["dataplane"])).status).toBe(200);
    await w.flush();
    await w.flush();
    expect(sessionIn(await live(alice.login.token), sid)?.labels).toStrictEqual(["dataplane"]);
  });

  it("test_AC07_unlabelled_no_key", async () => {
    const { bob, s1, s2 } = await setup();
    await label(bob, s1, ["perf"]);
    await w.flush();
    const v = await views(bob);
    // Positive control: the labelled neighbour has the key.
    expect(sessionIn(v.fleet, s1)?.labels).toStrictEqual(["perf"]);
    for (const view of [v.fleet, v.live]) {
      const s = sessionIn(view, s2);
      expect(s).toBeDefined();
      expect(Object.hasOwn(s, "labels")).toBe(false);
    }
  });

  it("test_AC07_clear_removes_key_on_hub", async () => {
    const { bob, s1 } = await setup();
    await label(bob, s1, ["perf"]);
    await w.flush();
    expect(sessionIn(await fleet(bob.login.token), s1)?.labels).toStrictEqual(["perf"]);
    await label(bob, s1, []);
    await w.flush();
    const v = await views(bob);
    for (const view of [v.fleet, v.live]) {
      const s = sessionIn(view, s1);
      expect(s).toBeDefined();
      expect(Object.hasOwn(s, "labels")).toBe(false);
    }
  });

  it("test_AC07_steps_machine_keeps_free_sessions_off", async () => {
    await world(["bob"]);
    const desk = await w.person("bob", "beta", { shareSessions: "steps", hostname: "bob-desk" });
    const g = await w.api(desk, "POST", "/v1/goals", { title: "labels", primaryRepo: "beta" });
    await w.api(desk, "POST", `/v1/goals/${g.json.id}/plan`, { steps: [{ id: "a", repo: "beta", kind: "implement", title: "a", brief: "a" }], approve: true });
    await w.hook(desk, "SessionStart", 401);
    await w.hook(desk, "SessionStart", 402);
    expect((await w.tool(desk, 402, "mesh_claim", { step: `${g.json.id}.a` })).isError).toBeFalsy();
    const free = w.session(desk, 401).sid;
    const holder = w.session(desk, 402).sid;
    expect((await label(desk, free, ["x"])).status).toBe(200);
    expect((await label(desk, holder, ["y"])).status).toBe(200);
    await w.flush();
    await w.flush();
    const v = { fleet: await fleet(desk.login.token), live: await live(desk.login.token) };
    // Positive control: the step holder is there, with its labels.
    expect(sessionIn(v.fleet, holder)?.labels).toStrictEqual(["y"]);
    expect(sessionIn(v.fleet, free)).toBeUndefined();
    expect(sessionIn(v.live, free)).toBeUndefined();
    for (const b of w.syncBodies(desk)) expect((b.sessions as Json[]).map((s) => s.sid)).not.toContain(free);
  });
});

describe("AC-09 POST /v1/machines/:id/labels", () => {
  /** bob: M (bob-laptop, nickname lab) and D (bob-desk, no nickname); alice; carol (admin). Topic gpu. */
  async function setup() {
    await world(["alice", "bob", "carol"], { admins: ["carol"] });
    const M = await w.login("bob", { hostname: "bob-laptop" });
    const D = await w.login("bob", { hostname: "bob-desk" });
    const A = await w.login("alice", { hostname: "alice-box" });
    const C = await w.login("carol", { hostname: "carol-box" });
    for (const l of [M, D, A, C]) await sync(l.token, { machine: { share: "me" } });
    expect(C.user.roles).toContain("admin");
    expect((await w.call(M.token, "POST", `/v1/machines/${M.machine}/name`, { nickname: "lab" })).status).toBe(200);
    await defineTopics(M, ["gpu"]);
    return { M, D, A, C, id: M.machine as string };
  }
  const post = (token: string, id: string, body: unknown) => w.call(token, "POST", `/v1/machines/${id}/labels`, body);
  const labelsOf = async (token: string, id: string) => machineIn(await fleet(token), id)?.labels;
  const events = async () => {
    const token = await w.hub.svc.serviceToken("feed");
    const r = await w.call(token, "GET", "/v1/events?after=0&limit=1000");
    return (r.json.events as Json[]).filter((e) => e.type === "machine.labelled");
  };

  it("test_AC09_replace", async () => {
    const { M, id } = await setup();
    const r = await post(M.token, id, { labels: ["Perf-Lab", "gpu"] });
    expect(r.status, JSON.stringify(r.json)).toBe(200);
    expect(r.json).toStrictEqual({ id, hostname: "bob-laptop", nickname: "lab", labels: ["gpu", "perf-lab"], unknown: ["perf-lab"] });
    expect(await labelsOf(M.token, id)).toStrictEqual(["gpu", "perf-lab"]);
  });

  it("test_AC09_no_nickname_no_key", async () => {
    const { D } = await setup();
    const r = await post(D.token, D.machine as string, { labels: ["gpu"] });
    expect(r.status).toBe(200);
    expect(r.json).toStrictEqual({ id: D.machine, hostname: "bob-desk", labels: ["gpu"], unknown: [] });
  });

  it("test_AC09_add_remove", async () => {
    const { M, id } = await setup();
    await post(M.token, id, { labels: ["gpu", "perf-lab"] });
    expect((await post(M.token, id, { add: ["x"] })).json.labels).toStrictEqual(["gpu", "perf-lab", "x"]);
    expect((await post(M.token, id, { remove: ["gpu"] })).json.labels).toStrictEqual(["perf-lab", "x"]);
    expect((await post(M.token, id, { add: ["y"], remove: ["x"] })).json.labels).toStrictEqual(["perf-lab", "y"]);
    expect(await labelsOf(M.token, id)).toStrictEqual(["perf-lab", "y"]);
  });

  it("test_AC09_clear", async () => {
    const { M, id } = await setup();
    await post(M.token, id, { labels: ["gpu"] });
    const r = await post(M.token, id, { labels: [] });
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({ labels: [], unknown: [] });
    expect(await labelsOf(M.token, id)).toStrictEqual([]);
  });

  it("test_AC09_empty_bodies_400", async () => {
    const { M, id } = await setup();
    expect((await post(M.token, id, { labels: ["keep"] })).status).toBe(200);
    for (const body of [{}, { add: [], remove: [] }, { labels: "x" }, { labels: L(21) }, { add: L(21) }]) {
      const r = await post(M.token, id, body);
      expect(r.status, JSON.stringify(body)).toBe(400);
      expect(typeof r.json.error).toBe("string");
    }
    expect(await labelsOf(M.token, id)).toStrictEqual(["keep"]);
  });

  it("test_AC09_bad_label_400", async () => {
    const { M, id } = await setup();
    await post(M.token, id, { labels: ["keep"] });
    expect(await post(M.token, id, { labels: ["bad label"] })).toEqual({ status: 400, json: { error: `not a label: bad label (${RULE})` } });
    expect(await post(M.token, id, { add: ["bad label"] })).toEqual({ status: 400, json: { error: `not a label: bad label (${RULE})` } });
    expect(await labelsOf(M.token, id)).toStrictEqual(["keep"]);
  });

  it("test_AC09_eleven_400_unchanged", async () => {
    const { M, id } = await setup();
    expect(await post(M.token, id, { labels: L(11) })).toEqual({ status: 400, json: { error: "at most 10 labels" } });
    expect(await labelsOf(M.token, id)).toStrictEqual([]);
    expect((await post(M.token, id, { labels: L(10) })).status).toBe(200);
    expect(await post(M.token, id, { add: ["zz"] })).toEqual({ status: 400, json: { error: "at most 10 labels" } });
    expect(await labelsOf(M.token, id)).toStrictEqual(L(10));
  });

  it("test_AC09_unknown_machine_404", async () => {
    const { M } = await setup();
    expect(await post(M.token, "nope", { labels: ["a"] })).toEqual({ status: 404, json: { error: "no machine nope" } });
  });

  it("test_AC09_other_user_403_also_admin", async () => {
    const { M, A, C, id } = await setup();
    await post(M.token, id, { labels: ["keep"] });
    for (const t of [A.token, C.token]) expect(await post(t, id, { labels: ["mine"] })).toEqual({ status: 403, json: { error: "not your machine" } });
    expect(await labelsOf(M.token, id)).toStrictEqual(["keep"]);
  });

  it("test_AC09_service_token_403", async () => {
    const { M, id } = await setup();
    const token = await w.hub.svc.serviceToken("dashboard", ["live:read"]);
    expect((await post(token, id, { labels: ["svc"] })).status).toBe(403);
    expect(await labelsOf(M.token, id)).toStrictEqual([]);
  });

  it("test_AC09_unknown_exact", async () => {
    const { M, id } = await setup();
    expect((await post(M.token, id, { labels: ["zeta", "gpu", "perf-lab"] })).json.unknown).toStrictEqual(["perf-lab", "zeta"]);
    expect((await post(M.token, id, { labels: ["gpu"] })).json.unknown).toStrictEqual([]);
  });

  it("test_AC09_event_and_activity", async () => {
    const { M, id } = await setup();
    const changedAfter = async (act: () => Promise<unknown>): Promise<boolean> => {
      const ctrl = new AbortController();
      const stream = await fetch(`${w.hub.url}/v1/stream`, { headers: { authorization: `Bearer ${M.token}` }, signal: ctrl.signal });
      const reader = (stream.body as ReadableStream<Uint8Array>).getReader();
      await new Promise((ok) => setTimeout(ok, 50));
      let seen = "";
      await act();
      const deadline = Date.now() + 2_000;
      while (!seen.includes("changed") && Date.now() < deadline) {
        const next = await Promise.race([reader.read(), new Promise<{ done: true; value: undefined }>((ok) => setTimeout(() => ok({ done: true, value: undefined }), 2_000))]);
        if (next.done) break;
        seen += new TextDecoder().decode(next.value);
      }
      ctrl.abort();
      return seen.includes("changed");
    };
    expect(await events()).toEqual([]);
    expect(await changedAfter(() => post(M.token, id, { labels: ["perf-lab", "gpu"] }))).toBe(true);
    const evs = await events();
    expect(evs).toHaveLength(1);
    expect(evs[0]?.user).toBe("bob");
    expect(evs[0]?.payload).toStrictEqual({ machine: id, labels: ["gpu", "perf-lab"] });
    expect(await activity(M.token)).toContain("labelled machine bob-laptop gpu, perf-lab");
  });

  it("test_AC09_clear_activity", async () => {
    const { M, id } = await setup();
    await post(M.token, id, { labels: ["gpu", "perf-lab"] });
    expect((await post(M.token, id, { labels: [] })).status).toBe(200);
    const evs = await events();
    expect(evs).toHaveLength(2);
    expect(evs[1]?.payload).toStrictEqual({ machine: id, labels: [] });
    expect(await activity(M.token)).toContain("cleared the labels of machine bob-laptop");
  });

  it("test_AC09_no_change_no_event", async () => {
    const { M, id } = await setup();
    expect((await post(M.token, id, { labels: ["gpu"] })).status).toBe(200);
    // Positive control: the first set recorded one event.
    expect(await events()).toHaveLength(1);
    expect((await post(M.token, id, { labels: ["gpu"] })).status).toBe(200);
    expect((await post(M.token, id, { remove: ["absent"] })).status).toBe(200);
    expect((await post(M.token, id, { add: ["GPU"] })).status).toBe(200);
    expect(await events()).toHaveLength(1);
  });

  it("test_AC09_concurrent_adds", async () => {
    const { M, id } = await setup();
    for (let round = 0; round < 5; round++) {
      const [a, b] = [`a${round}`, `b${round}`];
      const rs = await Promise.all([post(M.token, id, { add: [a] }), post(M.token, id, { add: [b] })]);
      expect(rs.map((r) => r.status)).toEqual([200, 200]);
      expect(await labelsOf(M.token, id)).toEqual(expect.arrayContaining([a, b]));
    }
    expect(await labelsOf(M.token, id)).toHaveLength(10);
  });
});

if (!PG_URL) process.stderr.write("labels: the Postgres leg of AC-09 is SKIPPED (set MESH_TEST_PG_URL=postgres://… to run it)\n");

describe.skipIf(!PG_URL)(`AC-09 concurrent machine labels on Postgres${PG_URL ? "" : " (skipped: set MESH_TEST_PG_URL)"}`, () => {
  const pgdb = new PgFixture();
  const hubs: RunningHub[] = [];
  afterEach(async () => {
    for (const h of hubs.splice(0)) await h.stop();
    await pgdb.cleanup();
  });
  afterAll(() => pgdb.end());

  async function call(hub: RunningHub, method: string, path: string, token?: string, body?: unknown): Promise<{ status: number; json: Json }> {
    const res = await fetch(hub.url + path, {
      method,
      headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    const text = await res.text();
    return { status: res.status, json: text ? JSON.parse(text) : undefined };
  }

  it("test_AC09_concurrent_adds_postgres", async () => {
    const config = buildHubConfig(
      { listen: "127.0.0.1:0", db: await pgdb.fresh(), auth: { providers: [{ id: "team", kind: "token", users: [{ name: "bob", token_sha256: sha256("bob-token-secret") }] }] } },
      { baseDir: "/", env: {} },
    );
    // Two hubs on one database, so the two adds race across processes' connections too.
    const one = await startHub(config, { tickMs: 0, now: () => 2_000_000_000 });
    hubs.push(one);
    const two = await startHub(config, { tickMs: 0, now: () => 2_000_000_000 });
    hubs.push(two);
    const L1 = (await call(one, "POST", "/auth/team/login", undefined, { token: "bob-token-secret", hostname: "bob-laptop", install: "inst-bob-laptop" })).json as LoginResult;
    expect((await call(one, "POST", "/v1/sync", L1.token, { events: [], counts: {}, sessions: [], machine: { share: "me" } })).status).toBe(200);
    const id = L1.machine as string;
    const labels = async () => ((await call(one, "GET", "/v1/fleet", L1.token)).json.machines as Json[]).find((m) => m.id === id)?.labels;
    for (let round = 0; round < 5; round++) {
      const [a, b] = [`a${round}`, `b${round}`];
      const rs = await Promise.all([call(one, "POST", `/v1/machines/${id}/labels`, L1.token, { add: [a] }), call(two, "POST", `/v1/machines/${id}/labels`, L1.token, { add: [b] })]);
      expect(rs.map((r) => r.status), JSON.stringify(rs)).toEqual([200, 200]);
      expect(await labels()).toEqual(expect.arrayContaining([a, b]));
    }
  });
});

describe("AC-10 GET /v1/fleet machine labels and sync", () => {
  async function setup() {
    await world(["bob"]);
    const bob = await w.person("bob", "beta", { shareSessions: "me", repoId: "example.org/team/beta" });
    await w.hook(bob, "SessionStart", 501);
    await w.flush();
    await w.flush();
    return { bob, id: w.machineOf(bob) };
  }
  const labelsOf = async (p: Person) => machineIn(await fleet(p.login.token), w.machineOf(p))?.labels;

  it("test_AC10_default_empty_array", async () => {
    const { bob } = await setup();
    expect(await labelsOf(bob)).toStrictEqual([]);
  });

  it("test_AC10_after_post", async () => {
    const { bob, id } = await setup();
    expect((await w.call(bob.login.token, "POST", `/v1/machines/${id}/labels`, { labels: ["gpu"] })).status).toBe(200);
    expect(await labelsOf(bob)).toStrictEqual(["gpu"]);
  });

  it("test_AC10_sync_keeps", async () => {
    const { bob, id } = await setup();
    await w.call(bob.login.token, "POST", `/v1/machines/${id}/labels`, { labels: ["gpu"] });
    // A hook and a sync.
    await w.hook(bob, "SessionStart", 502);
    await w.flush();
    expect(await labelsOf(bob)).toStrictEqual(["gpu"]);
    // A sync that replaces the repo inventory.
    const before = machineIn(await fleet(bob.login.token), id).repos;
    const T = realpathSync(mkdtempSync(join(tmpdir(), "mesh-roots-")));
    dirs.push(T);
    fakeCheckout(join(T, "alpha"), "https://example.org/team/alpha.git");
    await w.restart(bob, { workspaceRoots: [T] }, { repoId: "example.org/team/beta" });
    await w.flush();
    await w.flush();
    const after = machineIn(await fleet(bob.login.token), id);
    expect(after.repos).not.toEqual(before);
    expect(after.repos).toEqual(expect.arrayContaining([{ id: "example.org/team/alpha", name: "alpha" }]));
    expect(after.labels).toStrictEqual(["gpu"]);
    // A raw sync without `machine`, and one with machine facts.
    expect((await sync(bob.login.token, {})).status).toBe(200);
    expect(await labelsOf(bob)).toStrictEqual(["gpu"]);
    expect((await sync(bob.login.token, { machine: { share: "me", repos: [] } })).status).toBe(200);
    expect(await labelsOf(bob)).toStrictEqual(["gpu"]);
  });

  it("test_AC10_sync_body_has_no_machine_labels", async () => {
    const { bob, id } = await setup();
    await w.call(bob.login.token, "POST", `/v1/machines/${id}/labels`, { labels: ["gpu"] });
    await w.hook(bob, "SessionStart", 503);
    await w.flush();
    expect(await labelsOf(bob)).toStrictEqual(["gpu"]);
    const bodies = w.syncBodies(bob);
    expect(bodies.length).toBeGreaterThan(0);
    for (const b of bodies) expect(b.machine === undefined || !Object.hasOwn(b.machine, "labels")).toBe(true);
  });
});

describe("AC-11 MCP mesh_fleet with labels", () => {
  it("test_AC11_mcp_mesh_fleet_equals_cli", async () => {
    await world(["bob"]);
    const laptop = await w.person("bob", "alpha", { shareSessions: "me", hostname: "bob-laptop" });
    await w.hook(laptop, "SessionStart", 4242);
    expect((await label(laptop, w.session(laptop, 4242).sid, ["perf"])).status).toBe(200);
    const desk = await w.login("bob", { hostname: "bob-desk" });
    await sync(desk.token, { machine: { share: "me" }, sessions: [sess("d1", { name: "on-desk", labels: ["dataplane"] })] });
    expect((await w.call(desk.token, "POST", `/v1/machines/${desk.machine}/labels`, { labels: ["gpu", "perf-lab"] })).status).toBe(200);
    await w.flush();
    await w.flush();
    const server = buildServer({ daemonConfigPath: laptop.configPath, claudePid: 4242, version: "test" });
    const [a, b] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "test", version: "1" });
    await Promise.all([server.connect(a), client.connect(b)]);
    const r = (await client.callTool({ name: "mesh_fleet", arguments: {} })) as { content: { text: string }[]; isError?: boolean };
    expect(r.isError).toBeFalsy();
    const printed = await cli(laptop, ["machines"]);
    expect(printed.out).toContain("[gpu, perf-lab]");
    expect(printed.out).toContain("[dataplane]");
    expect(printed.out).toContain("[perf]");
    expect(r.content[0]?.text).toBe(printed.out.replace(/\n$/, ""));
    await client.close();
  });
});

describe("AC-13 mesh machines --label / mesh fleet --label", () => {
  /** bob: laptop (this installation, labelled perf, one unlabelled session); desk (unlabelled) with a perf session and another. */
  async function setup() {
    await world(["bob"]);
    const laptop = await w.person("bob", "alpha", { shareSessions: "me", hostname: "bob-laptop" });
    await w.hook(laptop, "SessionStart", 601);
    const desk = await w.login("bob", { hostname: "bob-desk" });
    await sync(desk.token, {
      machine: { share: "me" },
      sessions: [sess("d1", { name: "perf-work", labels: ["perf"] }), sess("d2", { name: "other-work", lastEventAt: w.clock - MIN })],
    });
    expect((await w.call(laptop.login.token, "POST", `/v1/machines/${w.machineOf(laptop)}/labels`, { labels: ["perf"] })).status).toBe(200);
    await w.flush();
    await w.flush();
    return { laptop, desk };
  }

  for (const cmd of ["machines", "fleet"]) {
    it(`test_AC13_filtered_text (${cmd})`, async () => {
      const { laptop } = await setup();
      const view = await fleet(laptop.login.token);
      const want = renderFleet(filterFleet(view, ["perf"]));
      const r = await cli(laptop, [cmd, "--label", "perf"]);
      expect(r.code, r.err).toBe(0);
      expect(r.out.replace(/\n$/, "")).toBe(want);
      expect(r.out).toContain("perf-work");
      expect(r.out).not.toContain("other-work");
      // Positive control: unfiltered output differs.
      const all = await cli(laptop, [cmd]);
      expect(all.out).toContain("other-work");
      expect(all.out).not.toBe(r.out);
    });

    it(`test_AC13_json_filtered (${cmd})`, async () => {
      const { laptop } = await setup();
      const view = await fleet(laptop.login.token);
      const r = await cli(laptop, [cmd, "--label", "perf", "--json"]);
      expect(r.code, r.err).toBe(0);
      expect(JSON.parse(r.out)).toStrictEqual(filterFleet(view, ["perf"]));
    });

    it(`test_AC13_no_match_message (${cmd})`, async () => {
      const { laptop } = await setup();
      const one = await cli(laptop, [cmd, "--label", "nope"]);
      expect(one.code).toBe(0);
      expect(one.out.trim()).toBe("No machine or session of yours is labelled nope.");
      const two = await cli(laptop, [cmd, "--label", "nope,zz"]);
      expect(two.code).toBe(0);
      expect(two.out.trim()).toBe("No machine or session of yours is labelled nope and zz.");
      // The spec example writes the given order; parseLabels sorts. Either is accepted here (see the test plan's open questions).
      const three = await cli(laptop, [cmd, "--label", "zz,nope"]);
      expect(three.code).toBe(0);
      expect(["No machine or session of yours is labelled nope and zz.", "No machine or session of yours is labelled zz and nope."]).toContain(three.out.trim());
    });

    it(`test_AC13_bad_label_exit_2 (${cmd})`, async () => {
      const { laptop } = await setup();
      const r = await cli(laptop, [cmd, "--label", "bad label"]);
      expect(r.code).toBe(2);
      expect(r.err).toContain(`not a label: bad label (${RULE})`);
      expect(r.requests).not.toContain("GET /v1/fleet");
    });
  }

  it("test_AC13_no_label_unchanged", async () => {
    const { laptop } = await setup();
    const view = await fleet(laptop.login.token);
    const r = await cli(laptop, ["machines"]);
    expect(r.code).toBe(0);
    expect(r.out.replace(/\n$/, "")).toBe(renderFleet(view));
  });
});

describe("AC-14 mesh label", () => {
  async function setup() {
    await world(["bob"]);
    const bob = await w.person("bob", "alpha", { shareSessions: "me" });
    await defineTopics(bob, ["perf"]);
    const s1 = await namedSession(bob, 701, "s1");
    return { bob, s1 };
  }

  it("test_AC14_set_prints_and_stores", async () => {
    const { bob } = await setup();
    const r = await cli(bob, ["label", "s1", "perf,gpu"]);
    expect(r.code, r.err).toBe(0);
    expect(r.out.trim()).toBe("s1: labels gpu, perf");
    expect(w.session(bob, 701).labels).toStrictEqual(["gpu", "perf"]);
  });

  it("test_AC14_not_a_topic_warning_once", async () => {
    const { bob } = await setup();
    const r = await cli(bob, ["label", "s1", "perf,gpu"]);
    expect(r.code).toBe(0);
    expect(errLines(r)).toEqual([NOT_TOPIC("gpu")]);
    expect(r.out).not.toContain("not a topic");
  });

  it("test_AC14_add_rm", async () => {
    const { bob } = await setup();
    expect((await cli(bob, ["label", "s1", "perf,gpu"])).code).toBe(0);
    const add = await cli(bob, ["label", "s1", "x", "--add"]);
    expect(add.code).toBe(0);
    expect(add.out.trim()).toBe("s1: labels gpu, perf, x");
    const rm = await cli(bob, ["label", "s1", "gpu", "--rm"]);
    expect(rm.code).toBe(0);
    expect(rm.out.trim()).toBe("s1: labels perf, x");
    expect(w.session(bob, 701).labels).toStrictEqual(["perf", "x"]);
  });

  it("test_AC14_clear", async () => {
    const { bob } = await setup();
    await cli(bob, ["label", "s1", "perf"]);
    expect(w.session(bob, 701).labels).toStrictEqual(["perf"]);
    const r = await cli(bob, ["label", "s1", "--clear"]);
    expect(r.code).toBe(0);
    expect(r.out.trim()).toBe("s1: no labels");
    expect(Object.hasOwn(w.session(bob, 701), "labels")).toBe(false);
  });

  it("test_AC14_who_fallbacks", async () => {
    const { bob } = await setup();
    await w.hook(bob, "SessionStart", 702);
    const unnamed = w.session(bob, 702);
    expect(unnamed.name).toBeUndefined();
    const byRepo = await cli(bob, ["label", unnamed.sid, "perf"]);
    expect(byRepo.code, byRepo.err).toBe(0);
    expect(byRepo.out.trim()).toBe("alpha: labels perf");
    const bare = realpathSync(mkdtempSync(join(tmpdir(), "mesh-norepo-")));
    dirs.push(bare);
    await w.hook(bob, "SessionStart", 703, { cwd: bare });
    const anon = w.session(bob, 703);
    expect(anon.repo).toBeUndefined();
    const bySid = await cli(bob, ["label", anon.sid, "perf"]);
    expect(bySid.code, bySid.err).toBe(0);
    expect(bySid.out.trim()).toBe(`${anon.sid.slice(0, 8)}: labels perf`);
  });

  it("test_AC14_bad_label_exit_2_no_call", async () => {
    const { bob } = await setup();
    await cli(bob, ["label", "s1", "perf"]);
    const r = await cli(bob, ["label", "s1", "bad label"]);
    expect(r.code).toBe(2);
    expect(r.err).toContain(`not a label: bad label (${RULE})`);
    expect(r.requests.filter((x) => x.includes("/local/labels"))).toEqual([]);
    expect(w.session(bob, 701).labels).toStrictEqual(["perf"]);
  });

  it("test_AC14_no_session_exit_1", async () => {
    const { bob } = await setup();
    const r = await cli(bob, ["label", "nope", "a"]);
    expect(r.code).toBe(1);
    expect(r.err).toContain('no live session matches "nope"');
  });

  it("test_AC14_usage_exit_2_with_daemon", async () => {
    const { bob } = await setup();
    for (const args of [["label"], ["label", "s1"], ["label", "s1", "a", "--clear"], ["label", "s1", "a", "--add", "--rm"]]) {
      const r = await cli(bob, args);
      expect(r.code, args.join(" ")).toBe(2);
      expect(r.err.startsWith("usage: mesh label <session> <label,…> [--add|--rm]"), r.err).toBe(true);
      expect(r.err).toContain("mesh label <session> --clear");
    }
    expect(Object.hasOwn(w.session(bob, 701), "labels")).toBe(false);
  });
});

describe("AC-16 mesh machine label", () => {
  /** bob: laptop (this installation, M1) and desk (M2, nickname lab). Topic gpu. */
  async function setup() {
    await world(["bob"]);
    const laptop = await w.person("bob", "alpha", { shareSessions: "me", hostname: "bob-laptop" });
    const desk = await w.login("bob", { hostname: "bob-desk" });
    await sync(desk.token, { machine: { share: "me" } });
    expect((await w.call(desk.token, "POST", `/v1/machines/${desk.machine}/name`, { nickname: "lab" })).status).toBe(200);
    await defineTopics(laptop, ["gpu"]);
    await w.flush();
    await w.flush();
    return { laptop, M1: w.machineOf(laptop), M2: desk.machine as string };
  }
  const labelsOf = async (p: Person, id: string) => machineIn(await fleet(p.login.token), id)?.labels;

  it("test_AC16_label_this_machine", async () => {
    const { laptop, M1, M2 } = await setup();
    const r = await cli(laptop, ["machine", "label", "gpu,perf-lab"]);
    expect(r.code, r.err).toBe(0);
    expect(r.out.trim()).toBe(`bob-laptop (${M1}): labels gpu, perf-lab`);
    expect(r.requests).toContain(`POST /v1/machines/${M1}/labels`);
    expect(await labelsOf(laptop, M1)).toStrictEqual(["gpu", "perf-lab"]);
    expect(await labelsOf(laptop, M2)).toStrictEqual([]);
  });

  it("test_AC16_unknown_warning", async () => {
    const { laptop } = await setup();
    const r = await cli(laptop, ["machine", "label", "gpu,perf-lab"]);
    expect(r.code).toBe(0);
    expect(errLines(r)).toEqual([NOT_TOPIC("perf-lab")]);
  });

  it("test_AC16_add_rm_clear", async () => {
    const { laptop, M1 } = await setup();
    expect((await cli(laptop, ["machine", "label", "gpu,perf-lab"])).code).toBe(0);
    const add = await cli(laptop, ["machine", "label", "x", "--add"]);
    expect(add.out.trim()).toBe(`bob-laptop (${M1}): labels gpu, perf-lab, x`);
    expect(add.bodies.find((b) => b.request === `POST /v1/machines/${M1}/labels`)?.body).toStrictEqual({ add: ["x"] });
    const rm = await cli(laptop, ["machine", "label", "gpu", "--rm"]);
    expect(rm.out.trim()).toBe(`bob-laptop (${M1}): labels perf-lab, x`);
    expect(rm.bodies.find((b) => b.request === `POST /v1/machines/${M1}/labels`)?.body).toStrictEqual({ remove: ["gpu"] });
    const clear = await cli(laptop, ["machine", "label", "--clear"]);
    expect(clear.code).toBe(0);
    expect(clear.out.trim()).toBe(`bob-laptop (${M1}): no labels`);
    expect(clear.bodies.find((b) => b.request === `POST /v1/machines/${M1}/labels`)?.body).toStrictEqual({ labels: [] });
    expect(await labelsOf(laptop, M1)).toStrictEqual([]);
  });

  it("test_AC16_other_machine_by_nickname", async () => {
    const { laptop, M1, M2 } = await setup();
    const r = await cli(laptop, ["machine", "label", "gpu", "--machine", "lab"]);
    expect(r.code, r.err).toBe(0);
    expect(r.out.trim()).toBe(`bob-desk (${M2}): labels gpu`);
    expect(await labelsOf(laptop, M2)).toStrictEqual(["gpu"]);
    expect(await labelsOf(laptop, M1)).toStrictEqual([]);
  });

  it("test_AC16_machine_nope", async () => {
    const { laptop } = await setup();
    const ref = await cli(laptop, ["machine", "name", "x1", "--machine", "nope"]);
    expect(ref.code).toBe(1);
    expect(ref.err).toContain('no machine of yours matches "nope"');
    const r = await cli(laptop, ["machine", "label", "gpu", "--machine", "nope"]);
    expect(r.code).toBe(1);
    expect(r.err).toContain('no machine of yours matches "nope"');
  });

  it("test_AC16_bad_label_no_hub_call", async () => {
    const { laptop, M1 } = await setup();
    const r = await cli(laptop, ["machine", "label", "bad label"]);
    expect(r.code).toBe(2);
    expect(r.err).toContain(`not a label: bad label (${RULE})`);
    expect(r.requests.filter((x) => x.endsWith("/labels"))).toEqual([]);
    expect(await labelsOf(laptop, M1)).toStrictEqual([]);
  });

  it("test_AC16_hub_400", async () => {
    const { laptop, M1 } = await setup();
    expect((await w.call(laptop.login.token, "POST", `/v1/machines/${M1}/labels`, { labels: L(10) })).status).toBe(200);
    const r = await cli(laptop, ["machine", "label", "zz", "--add"]);
    expect(r.code).toBe(1);
    expect(r.err).toContain("at most 10 labels");
    expect(await labelsOf(laptop, M1)).toStrictEqual(L(10));
  });

  it("test_AC16_usage", async () => {
    const { laptop } = await setup();
    for (const args of [["machine", "label"], ["machine"]]) {
      const r = await cli(laptop, args);
      expect(r.code, args.join(" ")).toBe(2);
      expect(r.err).toContain("mesh machine label <label,…> [--add|--rm] [--machine <id|nickname|hostname>]");
    }
  });
});
