// RL-3 AC-09 (concurrent): two hub replicas (two HubService instances, each with its own store
// connection to one database) tick at the same time: one goal and one `pulse.fired` per slot.
// SQLite (a file) always; Postgres when MESH_TEST_PG_URL is set. Written from the spec's contracts
// only (docs/specs/RL-3.md).

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { sha256 } from "../src/auth/index.ts";
import { buildHubConfig, startHub, type RunningHub } from "../src/hub/index.ts";
import { HubStore } from "../src/store/index.ts";
import { PG_URL, PgFixture } from "./helpers/pg.ts";
import { body, DAY, iso, T0, type Json } from "./helpers/pulse-kit.ts";

const pgdb = new PgFixture();
const dirs: string[] = [];
const hubs: RunningHub[] = [];
const stores: HubStore[] = [];
let clock = T0 - DAY;

afterEach(async () => {
  for (const h of hubs.splice(0)) await h.stop().catch(() => undefined);
  for (const s of stores.splice(0)) await s.close().catch(() => undefined);
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
afterAll(async () => {
  await pgdb.end();
});

async function call(hub: RunningHub, method: "GET" | "POST", path: string, token: string, b?: unknown): Promise<{ status: number; json: Json }> {
  const res = await fetch(hub.url + path, { method, headers: { "content-type": "application/json", authorization: `Bearer ${token}` }, ...(b !== undefined ? { body: JSON.stringify(b) } : {}) });
  const text = await res.text();
  let json: Json;
  try {
    json = text ? JSON.parse(text) : undefined;
  } catch {
    json = text;
  }
  return { status: res.status, json };
}

async function replicas(db: string): Promise<{ h1: RunningHub; h2: RunningHub; token: string }> {
  const config = buildHubConfig(
    { listen: "127.0.0.1:0", db, auth: { providers: [{ id: "team", kind: "token", users: [{ name: "ann", token_sha256: sha256("ann-token-secret") }] }] } },
    { baseDir: "/", env: {} },
  );
  const s1 = await HubStore.open(db);
  stores.push(s1);
  const h1 = await startHub(config, { store: s1, tickMs: 0, now: () => clock });
  hubs.push(h1);
  const s2 = await HubStore.open(db);
  stores.push(s2);
  const h2 = await startHub(config, { store: s2, tickMs: 0, now: () => clock });
  hubs.push(h2);
  const login = await fetch(`${h1.url}/auth/team/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ token: "ann-token-secret", hostname: "ann-laptop", install: "inst-ann-1" }) });
  const token = ((await login.json()) as { token: string }).token;
  return { h1, h2, token };
}

async function twoTicks(db: string): Promise<void> {
  clock = T0 - DAY;
  const { h1, h2, token } = await replicas(db);
  const created = await call(h1, "POST", "/v1/pulses", token, body());
  expect(created.status, JSON.stringify(created.json)).toBe(201);
  clock = T0;
  await Promise.all([h1.svc.tick(), h2.svc.tick()]);
  const goals = ((await call(h2, "GET", "/v1/goals?pulses=1", token)).json.goals as Json[]).filter((g) => g.refs?.pulse === "p-1");
  expect(goals).toHaveLength(1);
  const fired = (await h1.svc.store.events(0, 100_000)).filter((e) => e.type === "pulse.fired" && (e.payload as Json)?.pulse === "p-1" && (e.payload as Json)?.slot === iso(T0));
  expect(fired).toHaveLength(1);
  const d = await call(h1, "GET", "/v1/pulses/p-1", token);
  expect(d.status).toBe(200);
  expect((d.json.slots as Json[]).map((s) => [s.slot, s.state, s.goal])).toStrictEqual([[iso(T0), "fired", goals[0].id]]);
  expect(d.json.pulse.nextAt).toBe(T0 + DAY);
}

describe("AC-09 two replicas", { timeout: 30_000 }, () => {
  it("test_AC09_two_services sqlite", async () => {
    for (let i = 0; i < 3; i++) {
      const d = mkdtempSync(join(tmpdir(), "mesh-pulse-replicas-"));
      dirs.push(d);
      await twoTicks(join(d, "hub.db"));
      for (const h of hubs.splice(0)) await h.stop();
      for (const s of stores.splice(0)) await s.close();
    }
  });

  it.skipIf(!PG_URL)("test_AC09_two_services postgres", async () => {
    for (let i = 0; i < 3; i++) {
      await twoTicks(await pgdb.fresh());
      for (const h of hubs.splice(0)) await h.stop();
      for (const s of stores.splice(0)) await s.close();
    }
  });
});
