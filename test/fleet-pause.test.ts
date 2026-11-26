// RL-24: fleet pause, a kill switch for unattended work. `POST /v1/fleet/pause` and
// `POST /v1/fleet/resume` (scope `fleet:pause`, act-for keeping the person's admin role), the stored
// state, `paused` on the probes and the sync reply, and what the hub does while paused. Written from
// the spec's contracts (docs/specs/RL-24.md). Machines are bare (a login and syncs); pulses, slots
// and steps by id; events by type.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../src/hub/app.ts";
import type { HubService } from "../src/hub/service.ts";
import { HUB_API, IDEMPOTENCY_HEADER } from "../src/protocol/index.ts";
import { copyHubToPostgres, HUB_MIGRATIONS, HubStore, openSyncDb } from "../src/store/index.ts";
import { PG_URL, PgFixture } from "./helpers/pg.ts";
import { body, Pk, SOLO_HL, T0, type Bare, type Json } from "./helpers/pulse-kit.ts";

const H = "x-mesh-on-behalf-of";
const REASON = "bad agent release";

let k: Pk;
let ops: string;
let reader: string;
const dirs: string[] = [];
const pgdb = new PgFixture();
afterEach(async () => {
  await k?.stop();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
afterAll(async () => {
  await pgdb.end();
});

/** ann, bob, carol (admin), dave, root (admin); services `ops` (fleet:pause) and `reader` (goals:read). */
async function cast(o: { clock?: number; hubYaml?: Record<string, unknown> } = {}): Promise<void> {
  k = await Pk.start(o);
  ops = await k.w.hub.svc.serviceToken("ops", ["fleet:pause"]);
  reader = await k.w.hub.svc.serviceToken("reader", ["goals:read"]);
}

const tokenOf = (who: string) => k.tok[who] ?? who;
const headers = (user?: string, extra: Record<string, string> = {}) => ({ ...(user === undefined ? {} : { [H]: user }), ...extra });
const pauseAs = (who: string, user?: string, b: unknown = { reason: REASON }, extra: Record<string, string> = {}) => k.w.call(tokenOf(who), "POST", "/v1/fleet/pause", b, headers(user, extra));
const resumeAs = (who: string, user?: string, b: unknown = {}, extra: Record<string, string> = {}) => k.w.call(tokenOf(who), "POST", "/v1/fleet/resume", b, headers(user, extra));
const fleetEvents = async (): Promise<Json[]> => (await k.r.allEvents()).filter((e) => e.type === "fleet.paused" || e.type === "fleet.resumed");
async function probe(path: "/healthz" | "/health"): Promise<Json> {
  const res = await fetch(k.w.hub.url + path);
  expect(res.status).toBe(200);
  return await res.json();
}
async function pauseOk(who = "root", user?: string, reason = REASON): Promise<Json> {
  const res = await pauseAs(who, user, { reason });
  expect(res.status, JSON.stringify(res.json)).toBe(200);
  return res.json;
}
async function resumeOk(who = "root", user?: string, b: unknown = {}): Promise<Json> {
  const res = await resumeAs(who, user, b);
  expect(res.status, JSON.stringify(res.json)).toBe(200);
  return res.json;
}
function refused(res: { status: number; json: Json }, status: number, code: string): void {
  expect(res.status, JSON.stringify(res.json)).toBe(status);
  expect(res.json.code, JSON.stringify(res.json)).toBe(code);
}

// ---------------------------------------------------------------------------------------------

describe("AC-01 rights", { timeout: 30_000 }, () => {
  it("test_AC01_rights_table", async () => {
    await cast();
    for (const route of ["pause", "resume"] as const) {
      const call = route === "pause" ? pauseAs : resumeAs;
      const b = route === "pause" ? { reason: REASON } : {};
      refused(await call("bob", undefined, b), 403, "not-admin");
      refused(await call("bob", "root", b), 403, "on-behalf-of-not-service");
      refused(await call(ops, undefined, b), 400, "on-behalf-of-required");
      refused(await call(ops, "bob", b), 403, "not-admin");
      refused(await call(ops, "nobody", b), 403, "user-unknown");
      refused(await call(ops, "reader", b), 403, "user-unknown");
      refused(await call(reader, "root", b), 403, "forbidden");
    }
    expect(await k.w.hub.svc.store.getFleetPause()).toBeUndefined();
    expect(await fleetEvents()).toStrictEqual([]);
    expect((await pauseAs("root")).status).toBe(200);
    expect((await resumeAs("root")).status).toBe(200);
    expect((await pauseAs(ops, "root")).status).toBe(200);
    expect((await resumeAs(ops, "root")).status).toBe(200);
    const all = await k.r.allEvents();
    expect(JSON.stringify(all)).not.toContain("on-behalf-of-not-accepted");
  });

  it("test_AC01_admin_removed_refused_next_request", async () => {
    await cast();
    await k.w.hub.svc.store.setUserRoles("carol", ["member"]);
    refused(await pauseAs(ops, "carol"), 403, "not-admin");
    refused(await pauseAs("carol"), 403, "not-admin");
  });
});

describe("AC-02 act-for keeps admin on the fleet routes only", { timeout: 30_000 }, () => {
  it("test_AC02_unit_hub_api", () => {
    const admin = HUB_API.filter((r) => r.onBehalfOfRoles?.includes("admin")).map((r) => `${r.method} ${r.path}`);
    expect(admin.sort()).toStrictEqual(["POST /v1/fleet/pause", "POST /v1/fleet/resume"]);
    for (const r of HUB_API.filter((x) => x.onBehalfOfRoles?.includes("admin"))) {
      expect(r).toMatchObject({ rule: "member", scope: "fleet:pause", onBehalfOf: true, onBehalfOfRequired: true });
    }
    const svc = { config: { url: "http://127.0.0.1:1" } } as unknown as HubService;
    const served = createApp(svc).routes.filter((r) => r.onBehalfOfRoles?.includes("admin")).map((r) => `${r.method} ${r.path}`);
    expect(served.sort()).toStrictEqual(admin);
  });

  it("test_AC02_other_route_member_only", async () => {
    await cast();
    const ops2 = await k.w.hub.svc.serviceToken("ops2", ["pulses:write"]);
    await k.pulseOk("bob", body({ when: { every: "1h", at: T0 } }, "solo-hl", SOLO_HL));
    const viaRoot = await k.w.call(ops2, "POST", "/v1/pulses/p-1/update", { window: "2h" }, { [H]: "root" });
    expect(viaRoot.status, JSON.stringify(viaRoot.json)).toBe(403);
    const own = await k.call("root", "POST", "/v1/pulses/p-1/update", { window: "2h" });
    expect(own.status, JSON.stringify(own.json)).toBe(200);
  });
});

describe("AC-03 pause and resume", { timeout: 30_000 }, () => {
  it("test_AC03_service_for_root", async () => {
    await cast();
    const at = k.w.clock;
    const r = await pauseOk(ops, "root");
    expect(r).toStrictEqual({ paused: { since: at, by: "root", via: "ops", reason: REASON } });
    let ev = await fleetEvents();
    expect(ev).toHaveLength(1);
    expect(ev[0]).toMatchObject({ type: "fleet.paused", user: "root", payload: { reason: REASON, withdrawn: 0, via: "ops" } });
    expect(ev[0].goal ?? undefined).toBeUndefined();
    k.w.clock += 60_000;
    expect(await resumeOk(ops, "root", { reason: "fixed" })).toStrictEqual({ paused: null });
    ev = await fleetEvents();
    expect(ev).toHaveLength(2);
    expect(ev[1]).toMatchObject({ type: "fleet.resumed", user: "root", payload: { pausedAt: at, pausedBy: "root", skipped: 0, missed: 0, reason: "fixed", via: "ops" } });
  });

  it("test_AC03_own_token_no_via", async () => {
    await cast();
    const r = await pauseOk("root");
    expect(r.paused).toStrictEqual({ since: k.w.clock, by: "root", reason: REASON });
    await resumeOk("root");
    const ev = await fleetEvents();
    expect(ev.map((e) => e.type)).toStrictEqual(["fleet.paused", "fleet.resumed"]);
    for (const e of ev) {
      expect(e.user).toBe("root");
      expect(e.payload.via).toBeUndefined();
    }
    expect(ev[1].payload).toStrictEqual({ pausedAt: r.paused.since, pausedBy: "root", skipped: 0, missed: 0 });
  });
});

describe("AC-04 codes and idempotency", { timeout: 30_000 }, () => {
  it("test_AC04_conflicts_and_bodies", async () => {
    await cast();
    refused(await resumeAs("root"), 409, "fleet-not-paused");
    expect((await resumeAs("root")).json.error).toBe("the fleet is not paused");
    expect((await pauseAs("root", undefined, { reason: "" })).status).toBe(400);
    expect((await pauseAs("root", undefined, { reason: "   " })).status).toBe(400);
    expect((await pauseAs("root", undefined, { reason: "x".repeat(501) })).status).toBe(400);
    expect((await pauseAs("root", undefined, {})).status).toBe(400);
    expect((await pauseAs("root", undefined, { reason: "x".repeat(500) })).status).toBe(200);
    const again = await pauseAs("root");
    refused(again, 409, "fleet-already-paused");
    expect(again.json.error).toBe(`the fleet is already paused since ${new Date(k.w.clock).toISOString()} by root: ${"x".repeat(500)}`);
    expect(await fleetEvents()).toHaveLength(1);
    expect((await resumeAs("root", undefined, { reason: "x".repeat(501) })).status).toBe(400);
    expect((await k.w.call(tokenOf("root"), "POST", "/v1/fleet/resume")).status).toBe(200);
  });

  it("test_AC04_idempotency_key", async () => {
    await cast();
    const key = { [IDEMPOTENCY_HEADER]: "fleet-1" };
    const a = await pauseAs(ops, "root", { reason: REASON }, key);
    const b = await pauseAs(ops, "root", { reason: REASON }, key);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(b.json).toStrictEqual(a.json);
    expect(await fleetEvents()).toHaveLength(1);
  });
});

describe("AC-11 the probes", { timeout: 30_000 }, () => {
  it("test_AC11_healthz_and_health", async () => {
    await cast();
    for (const p of ["/healthz", "/health"] as const) {
      const v = await probe(p);
      expect(v.paused).toBeNull();
      expect(v.features).toContain("fleet-pause");
    }
    const r = await pauseOk(ops, "root");
    for (const p of ["/healthz", "/health"] as const) expect((await probe(p)).paused).toStrictEqual(r.paused);
    await resumeOk("root");
    for (const p of ["/healthz", "/health"] as const) expect((await probe(p)).paused).toBeNull();
  });

  it("test_AC11_no_store_call", async () => {
    await cast();
    await pauseOk("root");
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- every method of the store, spied
    const s = k.w.hub.svc.store as any;
    const names = Object.getOwnPropertyNames(Object.getPrototypeOf(s)).filter((n) => n !== "constructor" && typeof s[n] === "function");
    const spies = names.map((n) => ({ n, spy: vi.spyOn(s, n) }));
    try {
      const v = await probe("/healthz");
      expect(v.paused.by).toBe("root");
      await probe("/health");
      expect(spies.filter((x) => x.spy.mock.calls.length > 0).map((x) => x.n)).toStrictEqual([]);
    } finally {
      for (const x of spies) x.spy.mockRestore();
    }
  });
});

describe("AC-12 the sync reply", { timeout: 30_000 }, () => {
  it("test_AC12_sync_paused", async () => {
    await cast();
    const m: Bare = await k.bare("bob", "m1", { headless: true });
    const sync = () => k.w.call(m.token, "POST", "/v1/sync", { events: [], counts: {}, sessions: [] });
    expect((await sync()).json.paused).toBeNull();
    const r = await pauseOk("root");
    expect((await sync()).json.paused).toStrictEqual(r.paused);
    await resumeOk("root");
    expect((await sync()).json.paused).toBeNull();
  });
});

describe("AC-17 migration", { timeout: 60_000 }, () => {
  function file(): string {
    const d = mkdtempSync(join(tmpdir(), "mesh-rl24-"));
    dirs.push(d);
    return join(d, "hub.db");
  }

  it("test_AC17_schema12_sqlite", async () => {
    expect(HubStore.SCHEMA_VERSION).toBe(13);
    const path = file();
    const old = await openSyncDb(path, HUB_MIGRATIONS.slice(0, 12));
    old.close();
    const s = await HubStore.open(path);
    try {
      expect(await s.schemaVersion()).toBe(13);
      expect(await s.getFleetPause()).toBeUndefined();
      await s.setFleetPause({ since: 1, by: "root", reason: "r", held: ["G1.a"], skipped: 2, missed: 1 }, 5);
      expect(await s.getFleetPause()).toStrictEqual({ since: 1, by: "root", reason: "r", held: ["G1.a"], skipped: 2, missed: 1 });
      await s.setFleetPause(undefined, 6);
      expect(await s.getFleetPause()).toBeUndefined();
    } finally {
      await s.close();
    }
  });

  it.skipIf(!PG_URL)("test_AC17_postgres_migrate_and_copy", async () => {
    const path = file();
    const s = await HubStore.open(path);
    const row = { since: 7, by: "root", via: "ops", reason: "r", held: ["G1.a"], skipped: 1, missed: 0 };
    await s.setFleetPause(row, 7);
    await s.close();
    const url = await pgdb.fresh();
    await copyHubToPostgres(path, url);
    const pg = await HubStore.open(url);
    try {
      expect(await pg.schemaVersion()).toBe(13);
      expect(await pg.getFleetPause()).toStrictEqual(row);
    } finally {
      await pg.close();
    }
  });
});
