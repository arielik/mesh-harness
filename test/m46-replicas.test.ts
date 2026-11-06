// M4.6 stage 3: several hub replicas on one Postgres. Device logins, SSE hints and the periodic
// tick must work whichever replica a request lands on. The tick part also runs on SQLite.
// The Postgres legs run when MESH_TEST_PG_URL is set (see test/helpers/pg.ts).

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { sha256 } from "../src/auth/index.ts";
import { buildHubConfig, startHub, type Hint, type HubConfig, type RunningHub } from "../src/hub/index.ts";
import type { LoginResult, Step } from "../src/protocol/index.ts";
import { LOCKS } from "../src/store/index.ts";
import { MockOidc } from "./fixtures/mock-oidc.ts";
import { PG_URL, PgFixture, until } from "./helpers/pg.ts";

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- JSON responses in assertions
type Json = any;

const TOKEN = "alice-secret-token";
const mock = new MockOidc();
const pgdb = new PgFixture();
let clock = 1_762_000_000_000;

beforeAll(() => mock.start());
afterAll(async () => {
  await mock.stop();
  await pgdb.end();
});

if (!PG_URL) process.stderr.write("m46 replicas: the Postgres legs are SKIPPED (set MESH_TEST_PG_URL=postgres://… to run them)\n");

function makeConfig(db: string): HubConfig {
  return buildHubConfig(
    {
      listen: "127.0.0.1:0",
      db,
      auth: {
        providers: [
          { id: "team", kind: "token", users: [{ name: "alice", token_sha256: sha256(TOKEN) }] },
          { id: "kanidm", kind: "oidc", preset: "kanidm", issuer: mock.issuer, client_id: "mesh", allow_insecure: true },
        ],
      },
      thresholds: { takeover_after: "4h", pause_grace: "2m", machine_offline: "15m" },
    },
    { baseDir: "/", env: {} },
  );
}

async function call(hub: RunningHub, method: string, path: string, token?: string, body?: unknown): Promise<{ status: number; json: Json }> {
  const res = await fetch(hub.url + path, {
    method,
    headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const text = await res.text();
  return { status: res.status, json: text ? JSON.parse(text) : undefined };
}

const login = async (hub: RunningHub): Promise<LoginResult> => (await call(hub, "POST", "/auth/team/login", undefined, { token: TOKEN, hostname: "laptop" })).json;

/** A step claimed by alice on a machine last seen 20 minutes ago: the next tick pauses it. */
async function seedOfflineClaim(hub: RunningHub): Promise<string> {
  const s = hub.svc.store;
  const user = await s.upsertIdentity({ provider: "team", subject: "alice", name: "alice", groups: [] }, clock);
  await s.upsertMachine({ id: "m-1", userId: user.id, hostname: "laptop" }, clock - 20 * 60_000);
  const step: Step = {
    id: "G1.impl",
    goal: "G1",
    planVersion: 1,
    kind: "implement",
    repo: "example/app",
    title: "impl",
    brief: "",
    deps: [],
    state: "claimed",
    holderUser: user.id,
    holderMachine: "m-1",
    claimedAt: clock - 20 * 60_000,
    fixCycles: 0,
    updatedAt: clock - 20 * 60_000,
  };
  await s.saveSteps([step]);
  return step.id;
}

const pausedEvents = async (hub: RunningHub) => (await hub.svc.store.events(0, 1000)).filter((e) => e.type === "step.paused");

describe("tick is safe to run twice at once", () => {
  it("on SQLite (one hub)", async () => {
    const hub = await startHub(makeConfig(":memory:"), { tickMs: 0, now: () => clock });
    try {
      const id = await seedOfflineClaim(hub);
      await Promise.all([hub.svc.tick(), hub.svc.tick()]);
      expect((await hub.svc.store.getStep(id))?.state).toBe("paused");
      expect(await pausedEvents(hub)).toHaveLength(1);
      expect(await hub.runTick()).toBe(true); // the only process always leads
    } finally {
      await hub.stop();
    }
  });
});

describe.skipIf(!PG_URL)(`two hub replicas on one Postgres${PG_URL ? "" : " (skipped: set MESH_TEST_PG_URL)"}`, () => {
  let target: string;
  let a: RunningHub;
  let b: RunningHub;
  const running: RunningHub[] = [];

  beforeEach(async () => {
    clock = 1_762_000_000_000;
    target = await pgdb.fresh();
    a = await startHub(makeConfig(target), { tickMs: 0, now: () => clock });
    running.push(a);
    b = await startHub(makeConfig(target), { tickMs: 0, now: () => clock });
    running.push(b);
  });
  afterEach(async () => {
    for (const h of running.splice(0)) await h.stop();
    await pgdb.cleanup();
  });

  it("finishes a device login on B that was started on A", async () => {
    const start = await call(a, "POST", "/auth/kanidm/device", undefined, { hostname: "box" });
    expect(start.status).toBe(200);
    expect(start.json.state).toBeUndefined();
    mock.approveDevice(start.json.userCode);
    let r = { status: 202, json: {} as Json };
    for (let i = 0; i < 60 && r.status === 202; i++) {
      await new Promise((ok) => setTimeout(ok, 100));
      // Alternate replicas, as a round-robin load balancer would.
      r = await call(i % 2 ? a : b, "POST", "/auth/kanidm/device/poll", undefined, { pollId: start.json.pollId, hostname: "box" });
    }
    expect(r.status).toBe(200);
    expect(r.json.token).toMatch(/^mh_d_/);
    expect((await call(a, "GET", "/v1/me", r.json.token)).json.user.id).toBe("alice");
    // Consumed: a replayed poll finds nothing, on either replica.
    expect((await call(a, "POST", "/auth/kanidm/device/poll", undefined, { pollId: start.json.pollId })).status).toBe(404);
  });

  it("delivers a hint published on A to subscribers on B, once on each replica", async () => {
    const onA: Hint[] = [];
    const onB: Hint[] = [];
    a.svc.bus.subscribe((h) => onA.push(h));
    b.svc.bus.subscribe((h) => onB.push(h));
    const alice = await login(a);
    const created = await call(a, "POST", "/v1/goals", alice.token, { title: "over two replicas" });
    expect(created.status).toBe(201);
    await until(() => onB.some((h) => h.type === "changed"), 5_000, "the hint on B");
    // Let any echo arrive before counting: A must not see its own hints twice.
    await new Promise((ok) => setTimeout(ok, 200));
    expect(onA.filter((h) => h.type === "changed")).toEqual(onB.filter((h) => h.type === "changed"));
    expect(new Set(onA.map((h) => JSON.stringify(h))).size).toBe(onA.length);
  });

  it("tells B's subscribers to resync after B's listener reconnects, then delivers again", async () => {
    const onB: Hint[] = [];
    b.svc.bus.subscribe((h) => onB.push(h));
    // Kills the listener connections of both replicas; each reconnects by itself.
    expect(await pgdb.terminate(target, "mesh-hub listen")).toBe(2);
    await until(() => onB.some((h) => h.type === "resync"), 10_000, "resync on B");
    const alice = await login(a);
    await call(a, "POST", "/v1/goals", alice.token, { title: "after the reconnect" });
    await until(() => onB.some((h) => h.type === "changed"), 5_000, "a hint after the reconnect");
  });

  it("runs tick on one replica only, and hands over when the leader goes away", async () => {
    expect(await a.runTick()).toBe(true);
    expect(await b.runTick()).toBe(false);
    expect(await a.runTick()).toBe(true); // still leading
    // The leader's connection dies (a crashed pod): the server drops its lock.
    expect(await pgdb.terminateLockHolder(target, LOCKS.tick)).toBe(1);
    expect(await b.runTick()).toBe(true);
    expect(await a.runTick()).toBe(false);
    // A clean shutdown releases the lock at once.
    await b.stop();
    running.splice(running.indexOf(b), 1);
    expect(await a.runTick()).toBe(true);
  });

  it("pauses an abandoned claim once when both replicas tick at the same time", async () => {
    const id = await seedOfflineClaim(a);
    await Promise.all([a.svc.tick(), b.svc.tick(), a.svc.tick(), b.svc.tick()]);
    expect((await b.svc.store.getStep(id))?.state).toBe("paused");
    expect(await pausedEvents(a)).toHaveLength(1);
  });
});
