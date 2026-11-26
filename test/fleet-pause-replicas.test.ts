// RL-24 AC-11 (replicas): two hub replicas on one database each keep their own copy of the fleet
// pause for `/healthz`; a pause or resume served by one shows on the other within `pauseRefreshMs`
// (5 s by default), and `stop()` leaves no timer behind. SQLite (a file) always; Postgres when
// MESH_TEST_PG_URL is set. Written from the spec's contracts (docs/specs/RL-24.md).

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { sha256 } from "../src/auth/index.ts";
import { buildHubConfig, startHub, type RunningHub } from "../src/hub/index.ts";
import { HubStore } from "../src/store/index.ts";
import { PG_URL, PgFixture } from "./helpers/pg.ts";
import type { Json } from "./helpers/world.ts";

const pgdb = new PgFixture();
const dirs: string[] = [];
const hubs: RunningHub[] = [];
const stores: HubStore[] = [];

afterEach(async () => {
  vi.useRealTimers();
  for (const h of hubs.splice(0)) await h.stop().catch(() => undefined);
  for (const s of stores.splice(0)) await s.close().catch(() => undefined);
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
afterAll(async () => {
  await pgdb.end();
});

async function call(hub: RunningHub, method: "GET" | "POST", path: string, token?: string, b?: unknown): Promise<{ status: number; json: Json }> {
  const res = await fetch(hub.url + path, {
    method,
    headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
    ...(b !== undefined ? { body: JSON.stringify(b) } : {}),
  });
  return { status: res.status, json: await res.json() };
}

async function replicas(db: string): Promise<{ a: RunningHub; b: RunningHub; token: string }> {
  // One config per replica: startHub writes the real port into the config's URL.
  const config = () => buildHubConfig(
    { listen: "127.0.0.1:0", db, auth: { providers: [{ id: "team", kind: "token", users: [{ name: "root", token_sha256: sha256("root-token-secret") }] }], bootstrap_admins: ["team:root"] } },
    { baseDir: "/", env: {} },
  );
  const open = async () => {
    const s = await HubStore.open(db);
    stores.push(s);
    const h = await startHub(config(), { store: s, tickMs: 0 });
    hubs.push(h);
    return h;
  };
  const a = await open();
  const b = await open();
  const login = await call(a, "POST", "/auth/team/login", undefined, { token: "root-token-secret", hostname: "root-laptop", install: "inst-root-1" });
  return { a, b, token: login.json.token as string };
}

/**
 * `/healthz` of `hub` once the re-read the timer started has settled (the read is real I/O, so
 * `advanceTimersByTimeAsync` does not wait for it); real timeouts, at most 2 s.
 */
async function pausedAfterRead(hub: RunningHub, want: unknown): Promise<unknown> {
  let v: unknown;
  for (let i = 0; i < 40; i++) {
    v = (await call(hub, "GET", "/healthz")).json.paused;
    if (JSON.stringify(v) === JSON.stringify(want)) break;
    await new Promise((ok) => setTimeout(ok, 50));
  }
  return v;
}

async function followsWithin5s(db: string): Promise<void> {
  // Only the intervals are faked: the servers and fetch keep their real timers.
  vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
  const { a, b, token } = await replicas(db);
  expect((await call(b, "GET", "/healthz")).json.paused).toBeNull();
  const p = await call(a, "POST", "/v1/fleet/pause", token, { reason: "incident 42" });
  expect(p.status, JSON.stringify(p.json)).toBe(200);
  expect((await call(a, "GET", "/healthz")).json.paused).toStrictEqual(p.json.paused);
  expect((await call(b, "GET", "/healthz")).json.paused).toBeNull();
  await vi.advanceTimersByTimeAsync(5_000);
  expect(await pausedAfterRead(b, p.json.paused)).toStrictEqual(p.json.paused);
  expect((await call(b, "POST", "/v1/fleet/resume", token, {})).status).toBe(200);
  expect((await call(a, "GET", "/healthz")).json.paused).toStrictEqual(p.json.paused);
  await vi.advanceTimersByTimeAsync(5_000);
  expect(await pausedAfterRead(a, null)).toBeNull();
  for (const h of hubs.splice(0)) await h.stop();
  expect(vi.getTimerCount()).toBe(0);
}

describe("AC-11 two replicas", { timeout: 30_000 }, () => {
  it("test_AC11_replicas sqlite", async () => {
    const d = mkdtempSync(join(tmpdir(), "mesh-rl24-rep-"));
    dirs.push(d);
    await followsWithin5s(join(d, "hub.db"));
  });

  it.skipIf(!PG_URL)("test_AC11_replicas postgres", async () => {
    await followsWithin5s(await pgdb.fresh());
  });
});
