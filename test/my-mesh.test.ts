// MM-1 "My mesh" end to end: a real hub and daemons over HTTP (World), the CLI and the MCP tool
// against them. Criteria AC-04, AC-11, AC-12, AC-13, AC-15, AC-18 to AC-21, AC-28 to AC-30.

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { sha256 } from "../src/auth/index.ts";
import { dispatch } from "../src/cli/commands.ts";
import { DaemonClient } from "../src/cli/client.ts";
import type { CliEnv } from "../src/cli/context.ts";
import { meshCommands } from "../src/cli/mesh-commands.ts";
import { renderFleet } from "../src/core/index.ts";
import { buildHubConfig, startHub, type RunningHub } from "../src/hub/index.ts";
import { buildServer } from "../src/mcp/index.ts";
import { resolvePaths, type FleetView, type LoginResult, type Session } from "../src/protocol/index.ts";
import { fakeCheckout } from "./helpers/git-tree.ts";
import { PG_URL, PgFixture } from "./helpers/pg.ts";
import { World, type Json, type Person } from "./helpers/world.ts";

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
  cwd: `/w/${sid}`,
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
const machineIn = (view: Json, id: string): Json => view.machines.find((m: Json) => m.id === id);
const sidsOf = (m: Json): string[] => (m?.sessions ?? []).map((s: Json) => s.sid);

/** Run a mesh command as on this machine (its config folder), recording the HTTP requests made. */
async function cli(p: Person, args: string[]): Promise<{ code: number; out: string; err: string; requests: string[] }> {
  const out: string[] = [];
  const err: string[] = [];
  const paths = resolvePaths({ MESH_CONFIG_DIR: p.dir, MESH_STATE_DIR: join(p.dir, "state"), CLAUDE_CONFIG_DIR: join(p.dir, "claude") }, p.dir);
  const c: CliEnv = { io: { out: (t) => out.push(t), err: (t) => err.push(t) }, paths, env: {}, cwd: p.dir, self: ["mesh"], version: "0.0.0" };
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

describe("AC-04 every sync carries machine.share; the hub stores it", () => {
  async function three() {
    await world(["ann", "bob", "cat"]);
    const ann = await w.person("ann", "alpha", { shareSessions: "steps" });
    const bob = await w.person("bob", "beta", { shareSessions: "me" });
    const cat = await w.person("cat", "gamma", { shareSessions: "all" });
    for (const [i, p] of [ann, bob, cat].entries()) w.hook(p, "SessionStart", 100 + i);
    await w.flush();
    await w.flush();
    return { ann, bob, cat };
  }

  it("test_AC04_sync_carries_share_each_level", async () => {
    const people = await three();
    for (const p of Object.values(people)) {
      const bodies = w.syncBodies(p);
      expect(bodies.length).toBeGreaterThanOrEqual(2);
      for (const b of bodies) expect(b.machine?.share).toBe(p.config.shareSessions);
    }
  });

  it("test_AC04_hub_stores_share", async () => {
    const people = await three();
    const seen: string[] = [];
    for (const p of Object.values(people)) {
      const m = machineIn(await fleet(p.login.token), w.machineOf(p));
      expect(m.share).toBe(p.config.shareSessions);
      seen.push(m.share);
    }
    expect(seen).toEqual(["steps", "me", "all"]);
  });

  it("test_AC04_share_change_after_restart", async () => {
    const { bob } = await three();
    expect(machineIn(await fleet(bob.login.token), w.machineOf(bob)).share).toBe("me");
    await w.restart(bob, { shareSessions: "steps" });
    await w.flush();
    expect(machineIn(await fleet(bob.login.token), w.machineOf(bob)).share).toBe("steps");
  });
});

describe("AC-28 POST /v1/sync replies with the stored share level", () => {
  it("test_AC28_reply_sequence", async () => {
    await world(["bob"]);
    const l = await w.login("bob");
    // test_AC28_reply_has_stored_share
    const first = await sync(l.token, { machine: { share: "me" } });
    expect(first.status).toBe(200);
    expect(first.json).toStrictEqual({ accepted: 0, share: "me" });
    // test_AC28_reply_keeps_stored_without_machine
    expect((await sync(l.token, {})).json).toStrictEqual({ accepted: 0, share: "me" });
    // test_AC28_reply_reflects_change
    expect((await sync(l.token, { machine: { share: "all" } })).json).toStrictEqual({ accepted: 0, share: "all" });
    expect((await sync(l.token, {})).json).toStrictEqual({ accepted: 0, share: "all" });
  });

  it("test_AC28_never_reported_no_key", async () => {
    await world(["bob"]);
    const l = await w.login("bob");
    const r = await sync(l.token, { sessions: [sess("s1")] });
    expect(r.status).toBe(200);
    expect(r.json).toStrictEqual({ accepted: 0 });
    expect(r.json).not.toHaveProperty("share");
    // Positive control: the key appears once a level is stored.
    expect((await sync(l.token, { machine: { share: "steps" } })).json).toStrictEqual({ accepted: 0, share: "steps" });
  });
});

describe("AC-11 GET /v1/fleet content and order", () => {
  /**
   * bob: laptop (online) and desk (offline, its id sorting before the laptop's); alice: one machine.
   * Exactly two bob logins: the one whose id sorts first plays the desk, so no extra machine is registered.
   */
  async function setup() {
    await world(["alice", "bob"]);
    const first = await w.login("bob", { hostname: "bob-one" });
    const second = await w.login("bob", { hostname: "bob-two" });
    const [desk, laptop] = (first.machine as string) < (second.machine as string) ? [first, second] : [second, first];
    const alice = await w.login("alice");
    const t = w.clock;
    await sync(desk.token, { machine: { share: "me" }, sessions: [sess("b4", { lastEventAt: t })] });
    await sync(alice.token, { machine: { share: "all" }, sessions: [sess("a1", { lastEventAt: t })] });
    w.clock += 3 * MIN;
    await sync(laptop.token, {
      machine: { share: "me" },
      sessions: [
        sess("b1", { lastEventAt: t + 10 }),
        sess("b2", { lastEventAt: t + 20, step: "G1.a", state: "working" }),
        sess("b3", { lastEventAt: t + 30, state: "ended", endedAt: t + 30, endedReason: "prompt_input_exit" }),
      ],
    });
    return { laptop, desk, alice };
  }

  it("test_AC11_fleet_lists_own_machines_only", async () => {
    const { laptop, desk, alice } = await setup();
    const view = await fleet(laptop.token);
    expect(view.user.id).toBe("bob");
    expect(view.machines.map((m: Json) => m.id).sort()).toEqual([laptop.machine, desk.machine].sort());
    const a = await fleet(alice.token);
    expect(a.machines.map((m: Json) => m.id)).toEqual([alice.machine]);
    expect(sidsOf(a.machines[0])).toEqual(["a1"]);
  });

  it("test_AC11_fleet_sessions_per_machine", async () => {
    const { laptop, desk } = await setup();
    const view = await fleet(laptop.token);
    expect(sidsOf(machineIn(view, laptop.machine as string))).toEqual(["b2", "b1"]);
    expect(sidsOf(machineIn(view, desk.machine as string))).toEqual(["b4"]);
    for (const m of view.machines) for (const s of m.sessions) expect(typeof s.lastEventAt).toBe("number");
    expect(JSON.stringify(view)).not.toContain('"b3"');
  });

  it("test_AC11_current_flag", async () => {
    const { laptop, desk } = await setup();
    const viaLaptop = await fleet(laptop.token);
    expect(machineIn(viaLaptop, laptop.machine as string).current).toBe(true);
    expect(machineIn(viaLaptop, desk.machine as string).current).toBe(false);
    const viaDesk = await fleet(desk.token);
    expect(machineIn(viaDesk, laptop.machine as string).current).toBe(false);
    expect(machineIn(viaDesk, desk.machine as string).current).toBe(true);
  });

  it("test_AC11_online_before_offline", async () => {
    const { laptop, desk } = await setup();
    const view = await fleet(laptop.token);
    expect(view.machines.map((m: Json) => [m.id, m.online])).toEqual([
      [laptop.machine, true],
      [desk.machine, false],
    ]);
  });

  it("test_AC11_ties_by_id_and_sid", async () => {
    await world(["bob"]);
    const x = await w.login("bob", { hostname: "bob-x" });
    const y = await w.login("bob", { hostname: "bob-y" });
    await sync(x.token, { machine: { share: "me" }, sessions: [sess("s-b", { lastEventAt: w.clock }), sess("s-a", { lastEventAt: w.clock })] });
    await sync(y.token, { machine: { share: "me" } });
    w.clock += 3 * MIN;
    const viewer = await w.login("bob", { hostname: "bob-viewer" });
    await sync(viewer.token, { machine: { share: "me" } });
    const view = await fleet(viewer.token);
    const ids = view.machines.map((m: Json) => m.id).filter((id: string) => id === x.machine || id === y.machine);
    expect(ids).toEqual([x.machine, y.machine].sort());
    expect(view.machines[0].id).toBe(viewer.machine);
    expect(sidsOf(machineIn(view, x.machine as string))).toEqual(["s-a", "s-b"]);
  });

  it("test_AC11_repos_empty_before_inventory", async () => {
    const { laptop } = await setup();
    const m = machineIn(await fleet(laptop.token), laptop.machine as string);
    expect(m.repos).toEqual([]);
    expect(m).not.toHaveProperty("reposAt");
  });

  it("test_AC11_own_nostep_whatever_level", async () => {
    const { laptop } = await setup();
    // The stored level does not filter the owner's own listed rows. (A sync lists every session the
    // machine shares, so b1 is listed again here; one it leaves out is hidden, see share-sessions.)
    await sync(laptop.token, { machine: { share: "steps" }, sessions: [sess("b1", { lastEventAt: w.clock })] });
    const m = machineIn(await fleet(laptop.token), laptop.machine as string);
    expect(m.share).toBe("steps");
    expect(sidsOf(m)).toContain("b1");
  });

  it("test_AC11_fleet_from_daemons", async () => {
    // The same through real daemons: a `me` no-step session reaches its owner's fleet.
    await world(["bob"]);
    const laptop = await w.person("bob", "alpha", { shareSessions: "me", hostname: "bob-laptop" });
    const desk = await w.person("bob", "beta", { shareSessions: "me", hostname: "bob-desk" });
    await w.hook(laptop, "SessionStart", 101);
    await w.hook(desk, "SessionStart", 201);
    await w.flush();
    await w.flush();
    const view = await fleet(laptop.login.token);
    expect(sidsOf(machineIn(view, w.machineOf(laptop)))).toEqual([w.session(laptop, 101).sid]);
    expect(sidsOf(machineIn(view, w.machineOf(desk)))).toEqual([w.session(desk, 201).sid]);
  });
});

describe("AC-12 GET /v1/fleet auth", () => {
  it("test_AC12_service_token_empty_fleet", async () => {
    await world(["bob"]);
    const l = await w.login("bob");
    await sync(l.token, { machine: { share: "all" }, sessions: [sess("s1")] });
    const token = await w.hub.svc.serviceToken("dashboard", ["live:read"]);
    const r = await w.call(token, "GET", "/v1/fleet");
    expect(r.status).toBe(200);
    expect(r.json.machines).toEqual([]);
    // Positive control: the member sees the machine.
    expect((await fleet(l.token)).machines).toHaveLength(1);
  });

  it("test_AC12_service_token_without_scope_403", async () => {
    await world(["bob"]);
    const token = await w.hub.svc.serviceToken("plain", ["goals:read"]);
    expect((await w.call(token, "GET", "/v1/fleet")).status).toBe(403);
  });

  it("test_AC12_no_token_401", async () => {
    await world(["bob"]);
    expect((await w.call(undefined, "GET", "/v1/fleet")).status).toBe(401);
  });
});

describe("AC-13 POST /v1/machines/:id/name", () => {
  async function setup() {
    await world(["alice", "bob"], { admins: ["alice"] });
    const L = await w.login("bob", { hostname: "bob-laptop" });
    const D = await w.login("bob", { hostname: "bob-desk" });
    const A = await w.login("alice", { hostname: "alice-box" });
    for (const l of [L, D, A]) await sync(l.token, { machine: { share: "me" } });
    expect(A.user.roles).toContain("admin");
    return { L, D, A };
  }
  const name = (token: string, id: string, nickname: unknown) => w.call(token, "POST", `/v1/machines/${id}/name`, { nickname });
  const nickOf = async (token: string, id: string) => machineIn(await fleet(token), id)?.nickname;
  const activity = async (token: string): Promise<string[]> => (await w.call(token, "GET", "/v1/live")).json.activity.map((a: Json) => a.text);

  it("test_AC13_owner_sets_nickname", async () => {
    const { L } = await setup();
    const r = await name(L.token, L.machine as string, "m2");
    expect(r.status).toBe(200);
    expect(r.json).toStrictEqual({ id: L.machine, hostname: "bob-laptop", nickname: "m2" });
    expect(await nickOf(L.token, L.machine as string)).toBe("m2");
    const live = (await w.call(L.token, "GET", "/v1/live")).json;
    const bob = live.people.find((p: Json) => p.user.id === "bob");
    expect(bob.machines.find((m: Json) => m.id === L.machine).nickname).toBe("m2");
    expect(live.activity.map((a: Json) => a.text).join("\n")).toContain("named machine bob-laptop m2");
  });

  it("test_AC13_clear_nickname", async () => {
    const { L } = await setup();
    await name(L.token, L.machine as string, "m2");
    const r = await name(L.token, L.machine as string, null);
    expect(r.status).toBe(200);
    expect(r.json).toStrictEqual({ id: L.machine, hostname: "bob-laptop" });
    expect(machineIn(await fleet(L.token), L.machine as string)).not.toHaveProperty("nickname");
    expect((await activity(L.token)).join("\n")).toContain("cleared the name of machine bob-laptop");
  });

  it("test_AC13_invalid_nicknames_400", async () => {
    const { L } = await setup();
    expect((await name(L.token, L.machine as string, "keep")).status).toBe(200);
    for (const bad of ["M2", "-x", "a".repeat(33), "m-0a1b2c3d", ""]) {
      const r = await name(L.token, L.machine as string, bad);
      expect(r.status, bad).toBe(400);
      expect(typeof r.json.error).toBe("string");
    }
    expect(await nickOf(L.token, L.machine as string)).toBe("keep");
  });

  it("test_AC13_valid_edge_nicknames", async () => {
    const { L } = await setup();
    for (const good of ["a", "a".repeat(32), "m-0a1b2c3", "m-0a1b2c3dz", "0-desk"]) {
      const r = await name(L.token, L.machine as string, good);
      expect(r.status, good).toBe(200);
      expect(await nickOf(L.token, L.machine as string)).toBe(good);
    }
  });

  it("test_AC13_unknown_id_404", async () => {
    const { L } = await setup();
    expect(await name(L.token, "m-ffffffff", "desk")).toEqual({ status: 404, json: { error: "no machine m-ffffffff" } });
  });

  it("test_AC13_other_users_machine_403", async () => {
    const { L, A } = await setup();
    expect(await name(L.token, A.machine as string, "mine")).toEqual({ status: 403, json: { error: "not your machine" } });
    expect(await name(A.token, L.machine as string, "mine")).toEqual({ status: 403, json: { error: "not your machine" } });
    expect(await nickOf(A.token, A.machine as string)).toBeUndefined();
    expect(await nickOf(L.token, L.machine as string)).toBeUndefined();
  });

  it("test_AC13_clash_409", async () => {
    const { L, D } = await setup();
    expect((await name(L.token, L.machine as string, "m2")).status).toBe(200);
    expect((await name(L.token, D.machine as string, "tower")).status).toBe(200);
    const r = await name(L.token, D.machine as string, "m2");
    expect(r).toEqual({ status: 409, json: { error: `nickname m2 is already used by your machine bob-laptop (${L.machine})` } });
    expect(await nickOf(L.token, D.machine as string)).toBe("tower");
  });

  it("test_AC13_same_nickname_other_user_allowed", async () => {
    const { L, A } = await setup();
    expect((await name(L.token, L.machine as string, "box")).status).toBe(200);
    expect((await name(A.token, A.machine as string, "box")).status).toBe(200);
  });

  it("test_AC13_concurrent_200_and_409", async () => {
    const { L, D } = await setup();
    for (let round = 0; round < 10; round++) {
      const n = `n${round}`;
      const rs = await Promise.all([name(L.token, L.machine as string, n), name(D.token, D.machine as string, n)]);
      expect(rs.map((r) => r.status).sort()).toEqual([200, 409]);
    }
  });

  it("test_AC13_event_recorded", async () => {
    const { L } = await setup();
    const events = async () => {
      const token = await w.hub.svc.serviceToken("feed");
      const r = await w.call(token, "GET", "/v1/events?after=0&limit=1000");
      return (r.json.events as Json[]).filter((e) => e.type === "machine.named");
    };
    const changedAfter = async (act: () => Promise<unknown>): Promise<boolean> => {
      const ctrl = new AbortController();
      const stream = await fetch(`${w.hub.url}/v1/stream`, { headers: { authorization: `Bearer ${L.token}` }, signal: ctrl.signal });
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
    expect(await changedAfter(() => name(L.token, L.machine as string, "m2"))).toBe(true);
    expect(await changedAfter(() => name(L.token, L.machine as string, null))).toBe(true);
    const evs = await events();
    expect(evs).toHaveLength(2);
    expect(evs[0]).toMatchObject({ user: "bob", payload: { machine: L.machine, nickname: "m2" } });
    expect(evs[1]).toMatchObject({ user: "bob", payload: { machine: L.machine, nickname: null } });
  });

  it("test_AC13_service_token_refused", async () => {
    const { L } = await setup();
    const token = await w.hub.svc.serviceToken("dashboard", ["live:read"]);
    expect((await name(token, L.machine as string, "m2")).status).not.toBe(200);
    expect(await nickOf(L.token, L.machine as string)).toBeUndefined();
  });
});

if (!PG_URL) process.stderr.write("my mesh: the Postgres leg of AC-13 is SKIPPED (set MESH_TEST_PG_URL=postgres://… to run it)\n");

describe.skipIf(!PG_URL)(`AC-13 POST /v1/machines/:id/name on Postgres${PG_URL ? "" : " (skipped: set MESH_TEST_PG_URL)"}`, () => {
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
    let json: Json;
    try {
      json = text ? JSON.parse(text) : undefined;
    } catch {
      json = text;
    }
    return { status: res.status, json };
  }

  it("test_AC13_concurrent_200_and_409_postgres", async () => {
    const config = buildHubConfig(
      { listen: "127.0.0.1:0", db: await pgdb.fresh(), auth: { providers: [{ id: "team", kind: "token", users: [{ name: "bob", token_sha256: sha256("bob-token-secret") }] }] } },
      { baseDir: "/", env: {} },
    );
    const hub = await startHub(config, { tickMs: 0, now: () => 2_000_000_000 });
    hubs.push(hub);
    const login = async (hostname: string, install: string) =>
      (await call(hub, "POST", "/auth/team/login", undefined, { token: "bob-token-secret", hostname, install })).json as LoginResult;
    const L = await login("bob-laptop", "inst-bob-laptop");
    const D = await login("bob-desk", "inst-bob-desk");
    expect(L.machine).toBeTruthy();
    expect(D.machine).toBeTruthy();
    expect(L.machine).not.toBe(D.machine);
    for (const l of [L, D]) expect((await call(hub, "POST", "/v1/sync", l.token, { events: [], counts: {}, sessions: [], machine: { share: "me" } })).status).toBe(200);
    const nicknames = async (): Promise<Record<string, unknown>> => {
      const r = await call(hub, "GET", "/v1/fleet", L.token);
      expect(r.status, JSON.stringify(r.json)).toBe(200);
      return Object.fromEntries((r.json.machines as Json[]).filter((m) => m.id === L.machine || m.id === D.machine).map((m) => [m.id, m.nickname]));
    };
    for (let round = 0; round < 10; round++) {
      const n = `n${round}`;
      const rs = await Promise.all([
        call(hub, "POST", `/v1/machines/${L.machine}/name`, L.token, { nickname: n }),
        call(hub, "POST", `/v1/machines/${D.machine}/name`, D.token, { nickname: n }),
      ]);
      expect(rs.map((r) => r.status).sort(), JSON.stringify(rs)).toEqual([200, 409]);
      const nicks = await nicknames();
      expect(Object.keys(nicks).sort()).toEqual([L.machine, D.machine].sort());
      expect(Object.values(nicks).filter((v) => v === n)).toHaveLength(1);
    }
  });
});

describe("AC-15 / AC-30 the daemon's repo inventory reaches the hub", () => {
  async function bobWithInventory(level: "me" | "all") {
    await world(["bob"]);
    const T = mkdtempSync(join(tmpdir(), "mesh-roots-"));
    dirs.push(T);
    fakeCheckout(join(T, "alpha"), "https://example.org/team/alpha.git");
    const bob = await w.person("bob", "beta", { shareSessions: level, workspaceRoots: [T], repoId: "example.org/team/beta" });
    await w.hook(bob, "SessionStart", 301);
    await w.flush();
    await w.flush();
    return { bob, T };
  }
  const ALPHA = { id: "example.org/team/alpha", name: "alpha" };
  const BETA = { id: "example.org/team/beta", name: "beta" };

  it("test_AC15_fleet_shows_inventory", async () => {
    const { bob } = await bobWithInventory("me");
    const view = await fleet(bob.login.token);
    const m = machineIn(view, w.machineOf(bob));
    expect(m.repos).toEqual(expect.arrayContaining([ALPHA, BETA]));
    expect(typeof m.reposAt).toBe("number");
    expect(m.reposAt).toBeLessThanOrEqual(view.now);
  });

  it("test_AC15_no_path_in_machine_record", async () => {
    const { bob, T } = await bobWithInventory("me");
    const m = machineIn(await fleet(bob.login.token), w.machineOf(bob));
    const { sessions: _sessions, ...record } = m;
    const text = JSON.stringify(record);
    expect(text).toContain("alpha");
    expect(text).not.toContain(T);
    expect(text).not.toContain(bob.repoDir);
    expect(text).not.toContain(bob.dir);
  });

  it("test_AC15_all_level_also_sends", async () => {
    const { bob } = await bobWithInventory("all");
    const m = machineIn(await fleet(bob.login.token), w.machineOf(bob));
    expect(m.repos).toEqual(expect.arrayContaining([ALPHA, BETA]));
    expect(typeof m.reposAt).toBe("number");
  });

  it("test_AC30_switch_me_to_steps_clears", async () => {
    const { bob } = await bobWithInventory("me");
    expect(machineIn(await fleet(bob.login.token), w.machineOf(bob)).repos.length).toBeGreaterThan(0);
    await w.restart(bob, { shareSessions: "steps" }, { repoId: "example.org/team/beta" });
    await w.flush();
    const m = machineIn(await fleet(bob.login.token), w.machineOf(bob));
    expect(m.share).toBe("steps");
    expect(m.repos).toEqual([]);
  });
});

describe("AC-18 / AC-19 / AC-21 the CLI and the daemon client", () => {
  /** bob on bob-laptop (this installation, with a daemon) and bob-desk (a login with a session). */
  async function setup() {
    await world(["bob"]);
    const laptop = await w.person("bob", "alpha", { shareSessions: "me", hostname: "bob-laptop" });
    await w.hook(laptop, "SessionStart", 401);
    const desk = await w.login("bob", { hostname: "bob-desk" });
    await sync(desk.token, { machine: { share: "me" }, sessions: [sess("d1", { repo: { id: "example.org/team/delta", name: "delta" }, name: "on-desk" })] });
    await w.flush();
    await w.flush();
    return { laptop, L: w.machineOf(laptop), desk, D: desk.machine as string };
  }
  const nickOf = async (token: string, id: string) => machineIn(await fleet(token), id)?.nickname;
  const NICK_ERR = "nickname must match [a-z0-9][a-z0-9-]{0,31} and not look like a machine id";

  it("test_AC18_machines_prints_renderFleet", async () => {
    const { laptop } = await setup();
    const view = await fleet(laptop.login.token);
    expect(view.machines.length).toBe(2);
    const r = await cli(laptop, ["machines"]);
    expect(r.code).toBe(0);
    expect(r.out.replace(/\n$/, "")).toBe(renderFleet(view));
    expect(r.out).toContain("on-desk");
  });

  it("test_AC18_fleet_alias_same_output", async () => {
    const { laptop } = await setup();
    const a = await cli(laptop, ["machines"]);
    const b = await cli(laptop, ["fleet"]);
    expect(b.code).toBe(0);
    expect(a.out.length).toBeGreaterThan(0);
    expect(b.out).toBe(a.out);
  });

  it("test_AC18_json_matches_hub", async () => {
    const { laptop } = await setup();
    const view = await fleet(laptop.login.token);
    for (const cmd of ["machines", "fleet"]) {
      const r = await cli(laptop, [cmd, "--json"]);
      expect(r.code).toBe(0);
      expect(r.out.replace(/\n$/, "")).toBe(JSON.stringify(view, null, 2));
      expect(JSON.parse(r.out)).toEqual(view);
    }
  });

  it("test_AC18_help_lists_both", async () => {
    const { laptop } = await setup();
    const r = await cli(laptop, ["help"]);
    expect(r.out).toMatch(/^\s+machines\b/m);
    expect(r.out).toMatch(/\bfleet\b/);
    expect(r.out).toMatch(/^\s+machine\b/m);
  });

  it("test_AC19_names_this_installation", async () => {
    const { laptop, L, D } = await setup();
    const r = await cli(laptop, ["machine", "name", "m2"]);
    expect(r.err).toBe("");
    expect(r.code).toBe(0);
    expect(r.out.trim()).toBe(`Named bob-laptop (${L}) m2.`);
    expect(await nickOf(laptop.login.token, L)).toBe("m2");
    expect(await nickOf(laptop.login.token, D)).toBeUndefined();
    expect(r.requests).toContain(`POST /v1/machines/${L}/name`);
  });

  it("test_AC19_invalid_refused_before_hub", async () => {
    const { laptop, L } = await setup();
    for (const bad of ["M2", "m-0a1b2c3d"]) {
      // test_AC19_machine_id_shape_refused is the second value.
      const r = await cli(laptop, ["machine", "name", bad]);
      expect(r.code, bad).toBe(2);
      expect(r.err).toContain(NICK_ERR);
      expect(r.requests.filter((x) => x.includes("/v1/machines"))).toEqual([]);
    }
    expect(await nickOf(laptop.login.token, L)).toBeUndefined();
  });

  it("test_AC19_machines_not_logged_in", async () => {
    await world(["bob"]);
    const solo = await w.person("bob", "alpha", { shareSessions: "me", noCredentials: true });
    const r = await cli(solo, ["machines"]);
    expect(r.code).toBe(1);
    expect(r.err).toContain("not logged in to a hub; run: mesh login");
  });

  it("test_AC19_no_machine_in_credentials", async () => {
    await world(["bob"]);
    const p = await w.person("bob", "alpha", { shareSessions: "me" });
    writeFileSync(p.credentialsPath, JSON.stringify({ hub: w.hub.url, token: p.login.token, user: p.login.user }));
    const r = await cli(p, ["machine", "name", "m2"]);
    expect(r.code).toBe(1);
    expect(r.err).toContain("this installation has no machine on the hub; run: mesh login");
  });

  it("test_AC19_by_hostname", async () => {
    const { laptop, L, D } = await setup();
    const r = await cli(laptop, ["machine", "name", "tower", "--machine", "bob-desk"]);
    expect(r.code).toBe(0);
    expect(r.out.trim()).toBe(`Named bob-desk (${D}) tower.`);
    expect(await nickOf(laptop.login.token, D)).toBe("tower");
    expect(await nickOf(laptop.login.token, L)).toBeUndefined();
  });

  it("test_AC19_by_id_and_by_nickname", async () => {
    const { laptop, D } = await setup();
    expect((await cli(laptop, ["machine", "name", "tower", "--machine", D])).code).toBe(0);
    expect(await nickOf(laptop.login.token, D)).toBe("tower");
    const r = await cli(laptop, ["machine", "name", "big", "--machine", "tower"]);
    expect(r.code).toBe(0);
    expect(r.out.trim()).toBe(`Named bob-desk (${D}) big.`);
    expect(await nickOf(laptop.login.token, D)).toBe("big");
  });

  it("test_AC19_nickname_before_hostname", async () => {
    const { laptop, L, D } = await setup();
    expect((await cli(laptop, ["machine", "name", "bob-desk"])).code).toBe(0);
    expect(await nickOf(laptop.login.token, L)).toBe("bob-desk");
    const r = await cli(laptop, ["machine", "name", "x1", "--machine", "bob-desk"]);
    expect(r.code).toBe(0);
    expect(await nickOf(laptop.login.token, L)).toBe("x1");
    expect(await nickOf(laptop.login.token, D)).toBeUndefined();
  });

  it("test_AC19_no_match", async () => {
    const { laptop } = await setup();
    const r = await cli(laptop, ["machine", "name", "x1", "--machine", "nope"]);
    expect(r.code).toBe(1);
    expect(r.err).toContain('no machine of yours matches "nope"');
  });

  it("test_AC19_ambiguous_hostname", async () => {
    const { laptop, D } = await setup();
    const third = await w.login("bob", { hostname: "bob-desk" });
    await sync(third.token, { machine: { share: "me" } });
    const r = await cli(laptop, ["machine", "name", "x1", "--machine", "bob-desk"]);
    expect(r.code).toBe(1);
    expect(r.err).toContain('"bob-desk" matches several of your machines');
    expect(r.err).toContain(D);
    expect(r.err).toContain(third.machine as string);
    expect(r.err).toContain("use the id");
    expect(await nickOf(laptop.login.token, D)).toBeUndefined();
  });

  it("test_AC19_clear", async () => {
    const { laptop, L } = await setup();
    expect((await cli(laptop, ["machine", "name", "m2"])).code).toBe(0);
    const r = await cli(laptop, ["machine", "name", "--clear"]);
    expect(r.code).toBe(0);
    expect(r.out.trim()).toBe(`Cleared the nickname of bob-laptop (${L}).`);
    expect(machineIn(await fleet(laptop.login.token), L)).not.toHaveProperty("nickname");
  });

  it("test_AC19_clash_shows_hub_text", async () => {
    const { laptop, D, desk } = await setup();
    expect((await w.call(desk.token, "POST", `/v1/machines/${D}/name`, { nickname: "m2" })).status).toBe(200);
    const r = await cli(laptop, ["machine", "name", "m2"]);
    expect(r.code).toBe(1);
    expect(r.err).toContain(`nickname m2 is already used by your machine bob-desk (${D})`);
  });

  it("test_AC19_usage", async () => {
    const { laptop } = await setup();
    for (const args of [["machine"], ["machine", "foo"], ["machine", "name"]]) {
      const r = await cli(laptop, args);
      expect(r.code, args.join(" ")).toBe(2);
      expect(r.err.startsWith("usage:")).toBe(true);
      expect(r.err).toContain("mesh machine name <nickname>");
    }
  });

  it("test_AC21_client_fleet", async () => {
    const { laptop } = await setup();
    const client = new DaemonClient({ port: laptop.daemon.port, key: laptop.config.key });
    const view = await client.fleet();
    expect(view.machines.length).toBe(2);
    expect(view).toEqual(await fleet(laptop.login.token));
  });
});

describe("AC-20 MCP mesh_fleet", () => {
  async function setup() {
    await world(["bob"]);
    const laptop = await w.person("bob", "alpha", { shareSessions: "me", hostname: "bob-laptop" });
    await w.hook(laptop, "SessionStart", 4242);
    const desk = await w.login("bob", { hostname: "bob-desk" });
    await sync(desk.token, { machine: { share: "me" }, sessions: [sess("d1", { name: "on-desk" })] });
    await w.flush();
    await w.flush();
    const server = buildServer({ daemonConfigPath: laptop.configPath, claudePid: 4242, version: "test" });
    const [a, b] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "test", version: "1" });
    await Promise.all([server.connect(a), client.connect(b)]);
    const call = async () => (await client.callTool({ name: "mesh_fleet", arguments: {} })) as { content: { text: string }[]; isError?: boolean };
    return { laptop, client, call };
  }

  it("test_AC20_tool_listed", async () => {
    const { client } = await setup();
    const { tools } = await client.listTools();
    const t = tools.find((x) => x.name === "mesh_fleet");
    expect(t?.description).toBe("Every machine logged in as your user and what each session on it is doing (read-only).");
    expect(t?.inputSchema.required ?? []).toEqual([]);
    await client.close();
  });

  it("test_AC20_same_text_as_cli", async () => {
    const { laptop, call, client } = await setup();
    const r = await call();
    expect(r.isError).toBeFalsy();
    const printed = await cli(laptop, ["machines"]);
    expect(printed.out).toContain("on-desk");
    expect(r.content[0]?.text).toBe(printed.out.replace(/\n$/, ""));
    await client.close();
  });

  it("test_AC20_offline_error_then_back_online", async () => {
    const { call, client } = await setup();
    await w.stopHub();
    const off = await call();
    expect(off.isError).toBe(true);
    expect(off.content[0]?.text).toMatch(/offline/i);
    // test_AC20_back_online
    await w.startHubAgain();
    w.clock += 10 * MIN;
    let back = await call();
    for (let i = 0; i < 5 && back.isError; i++) {
      w.clock += 10 * MIN;
      await w.flush();
      back = await call();
    }
    expect(back.isError).toBeFalsy();
    expect(back.content[0]?.text).toContain("on-desk");
    await client.close();
  });
});

describe("AC-29 messages to sessions the caller cannot see", () => {
  async function setup() {
    await world(["alice", "bob"]);
    const alice = await w.person("alice", "alpha");
    const bob = await w.person("bob", "beta", { shareSessions: "me" });
    await w.hook(bob, "SessionStart", 501);
    await w.flush();
    await w.flush();
    const sBob = w.session(bob, 501).sid;
    // A step holder of bob's, reported by the same machine (with the daemon's own session: a sync
    // lists every session the machine shares, and one it leaves out is hidden).
    await sync(bob.login.token, { machine: { share: "me" }, sessions: [w.session(bob, 501), sess("s-step", { step: "G1.a", state: "working" })] });
    // The hub has bob's no-step session (positive control).
    expect(sidsOf(machineIn(await fleet(bob.login.token), w.machineOf(bob)))).toContain(sBob);
    return { alice, bob, sBob };
  }
  const say = (p: Person, toSid: string, text: string) => w.api(p, "POST", "/v1/messages", { toSid, text });
  const inbox = async (p: Person): Promise<Json[]> => (await w.call(p.login.token, "GET", "/v1/inbox")).json.messages;

  it("test_AC29_alice_to_bob_me_session_404", async () => {
    const { alice, bob, sBob } = await setup();
    const r = await say(alice, sBob, "from alice, hidden");
    expect(r).toEqual({ status: 404, json: { error: `session ${sBob} is not live on any machine` } });
    expect((await inbox(bob)).filter((m) => m.text === "from alice, hidden")).toEqual([]);
  });

  it("test_AC29_same_as_unknown_sid", async () => {
    const { alice } = await setup();
    expect(await say(alice, "s-nope", "x")).toEqual({ status: 404, json: { error: "session s-nope is not live on any machine" } });
  });

  it("test_AC29_bob_can_message_own", async () => {
    const { bob, sBob } = await setup();
    expect((await say(bob, sBob, "from bob")).status).toBe(201);
    expect((await inbox(bob)).map((m) => m.text)).toContain("from bob");
  });

  it("test_AC29_step_holder_reachable", async () => {
    const { alice, bob, sBob } = await setup();
    expect((await say(alice, "s-step", "to the step")).status).toBe(201);
    expect((await inbox(bob)).map((m) => m.text)).toContain("to the step");
    expect((await say(alice, sBob, "hidden")).status).toBe(404);
  });

  it("test_AC29_all_machine_reachable", async () => {
    const { alice, bob, sBob } = await setup();
    await w.restart(bob, { shareSessions: "all" });
    await w.flush();
    await w.flush();
    expect((await say(alice, sBob, "now visible")).status).toBe(201);
  });
});
