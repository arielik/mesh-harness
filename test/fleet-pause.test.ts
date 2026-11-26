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
  // After a hub restart the first request may go out on a socket of the stopped server: once more.
  const res = await fetch(k.w.hub.url + path).catch(() => fetch(k.w.hub.url + path));
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
    expect(r).toStrictEqual({ paused: { since: at, by: "root", via: "ops", reason: REASON }, withdrawn: 0 });
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

// ---------------------------------------------------------------------------------------------
// Effects while paused. P1: bob's pulse every hour from 09:00, window 50 min, missed record, overlap
// skip, one headless run step; m1: bob's headless machine (accept self: auto), its only candidate.

const HOUR = 3_600_000;
const MIN = 60_000;
/** Today at hh:mm:ss (T0 is 09:00). */
const at = (h: number, m = 0, s = 0) => T0 + (h - 9) * HOUR + m * MIN + s * 1000;
const iso = (ms: number) => new Date(ms).toISOString();
const TH = { thresholds: { offer_expiry: "2h", machine_offline: "15m" } };
let m1: Bare;

const p1 = (o: Record<string, unknown> = {}) => body({ when: { every: "1h", at: T0 }, window: "50m", missed: "record", overlap: "skip", ...o }, "solo-hl", SOLO_HL);

/** The cast, m1, and P1 created at `created` (default 09:20). */
async function pulseCast(o: { p?: Record<string, unknown>; created?: number; hubYaml?: Record<string, unknown> } = {}): Promise<void> {
  await cast({ clock: o.created ?? at(9, 20), hubYaml: o.hubYaml ?? TH });
  m1 = await k.bare("bob", "m1", { headless: true });
  await k.pulseOk("bob", p1(o.p));
}
const pulseEv = async (type: string) => (await k.pulseEvents(type, "p-1")).map((e) => e.payload);
const offeredOf = async (step: string) => (await k.r.allEvents()).filter((e) => e.type === "step.offered" && e.step === step);
const withdrawnOf = async (step: string) => (await k.r.allEvents()).filter((e) => e.type === "step.offer_withdrawn" && e.step === step);
const resumed = async (): Promise<Json> => (await fleetEvents()).filter((e) => e.type === "fleet.resumed").at(-1)?.payload;
const stepAs = (who: string, id: string, verb: string, b: Record<string, unknown> = {}) => k.call(who, "POST", `/v1/steps/${id}/${verb}`, b);

describe("AC-05 due slots while paused", { timeout: 60_000 }, () => {
  for (const missed of ["record", "catch-up-once"] as const) {
    it(`test_AC05_skipped_no_burst ${missed}`, async () => {
      await pulseCast({ p: { missed } });
      k.at(at(9, 30));
      await pauseOk("root");
      for (const h of [10, 11, 12]) await k.tickAt(at(h, 1), m1);
      const slots = (await k.slotsOf("p-1")).sort((a, b) => a.at - b.at);
      expect(slots.map((s) => [s.slot, s.state, s.reason, s.catchUp])).toStrictEqual([10, 11, 12].map((h) => [iso(at(h)), "skipped", "fleet_paused", undefined]));
      expect(await pulseEv("pulse.skipped")).toStrictEqual([10, 11, 12].map((h) => ({ pulse: "p-1", slot: iso(at(h)), reason: "fleet_paused" })));
      expect(await k.goalsOfPulse("p-1")).toStrictEqual([]);
      k.at(at(12, 30));
      await resumeOk("root");
      expect(await resumed()).toMatchObject({ skipped: 3, missed: 0 });
      await k.tickAt(at(12, 31), m1);
      expect(await k.slotsOf("p-1")).toHaveLength(3);
      await k.tickAt(at(13, 1), m1);
      const after = await k.slotsOf("p-1");
      expect(after.filter((s) => s.state === "fired").map((s) => s.slot)).toStrictEqual([iso(at(13))]);
      expect(await k.goalsOfPulse("p-1")).toHaveLength(1);
    });
  }

  it("test_AC05_tick_boundary", async () => {
    await pulseCast({ created: at(13, 20) });
    k.at(at(13, 30));
    await pauseOk("root");
    await k.tickAt(at(13, 59, 45), m1);
    k.at(at(14, 0, 10));
    await resumeOk("root");
    await k.tickAt(at(14, 0, 15), m1);
    const slots = await k.slotsOf("p-1");
    expect(slots.map((s) => [s.slot, s.state])).toStrictEqual([[iso(at(14)), "fired"]]);
    expect(await k.goalsOfPulse("p-1")).toHaveLength(1);
  });
});

describe("AC-06 restart while paused", { timeout: 60_000 }, () => {
  async function restartedAt(reopen: number, missed: "record" | "catch-up-once"): Promise<Json[]> {
    await pulseCast({ created: at(12, 5), p: { missed } });
    const r = await pauseOk("root");
    k.at(at(12, 10));
    await k.w.stopHub();
    k.at(reopen);
    await k.w.startHubAgain();
    expect((await probe("/healthz")).paused).toStrictEqual(r.paused);
    await k.tickAt(reopen, m1);
    return (await k.slotsOf("p-1")).sort((a, b) => a.at - b.at).map((s) => ({ slot: s.slot, state: s.state, reason: s.reason, ...(s.catchUp ? { catchUp: true } : {}) }));
  }

  it("test_AC06a_in_window_skipped", async () => {
    expect(await restartedAt(at(14, 30), "record")).toStrictEqual([
      { slot: iso(at(13)), state: "missed", reason: "hub_down" },
      { slot: iso(at(14)), state: "skipped", reason: "fleet_paused" },
    ]);
  });

  it("test_AC06b_past_window_hub_down", async () => {
    expect(await restartedAt(at(14, 55), "record")).toStrictEqual([
      { slot: iso(at(13)), state: "missed", reason: "hub_down" },
      { slot: iso(at(14)), state: "missed", reason: "hub_down" },
    ]);
  });

  it("test_AC06c_catch_up_skipped", async () => {
    expect(await restartedAt(at(14, 55), "catch-up-once")).toStrictEqual([
      { slot: iso(at(13)), state: "missed", reason: "hub_down" },
      { slot: iso(at(14)), state: "skipped", reason: "fleet_paused", catchUp: true },
    ]);
    expect(await k.goalsOfPulse("p-1")).toStrictEqual([]);
  });
});

describe("AC-07 a pending slot's offer", { timeout: 60_000 }, () => {
  async function fired(): Promise<string> {
    await pulseCast();
    await k.tickAt(at(10), m1);
    const slot = await k.slotOf("p-1", iso(at(10)));
    expect(slot.tried).toStrictEqual([{ machine: m1.machine, at: at(10) }]);
    const rs = `${slot.goal as string}.run`;
    expect((await k.step(rs)).offer).toMatchObject({ to: { machine: m1.machine }, state: "offered" });
    return rs;
  }

  it("test_AC07a_withdrawn_then_offered_after_resume", async () => {
    const rs = await fired();
    const inbox = (await k.inbox(m1.token)).length;
    k.at(at(10, 5));
    expect((await pauseOk("root")).paused.by).toBe("root");
    const w = await withdrawnOf(rs);
    expect(w).toHaveLength(1);
    expect(w[0]).toMatchObject({ user: "root", payload: { machine: m1.machine, reason: "fleet paused" } });
    expect((await fleetEvents())[0].payload.withdrawn).toBe(1);
    expect((await k.inbox(m1.token)).length).toBe(inbox);
    expect((await k.step(rs)).state).toBe("ready");
    expect((await k.slotOf("p-1", iso(at(10)))).tried).toStrictEqual([]);
    for (const t of [at(10, 10), at(10, 20)]) await k.tickAt(t, m1);
    expect(await offeredOf(rs)).toHaveLength(1);
    expect((await k.slotOf("p-1", iso(at(10)))).tried).toStrictEqual([]);
    k.at(at(10, 25));
    await resumeOk("root");
    expect(await offeredOf(rs)).toHaveLength(1);
    await k.tickAt(at(10, 26), m1);
    expect(await offeredOf(rs)).toHaveLength(2);
    expect((await k.slotOf("p-1", iso(at(10)))).tried).toStrictEqual([{ machine: m1.machine, at: at(10, 26) }]);
  });

  it("test_AC07b_window_ends_while_paused", async () => {
    const rs = await fired();
    k.at(at(10, 5));
    await pauseOk("root");
    await k.tickAt(at(10, 50), m1);
    const slot = await k.slotOf("p-1", iso(at(10)));
    expect([slot.state, slot.reason]).toStrictEqual(["missed", "fleet_paused"]);
    const missed = await pulseEv("pulse.missed");
    expect(missed).toHaveLength(1);
    expect(missed[0]).toMatchObject({ reason: "fleet_paused" });
    expect(await k.goalState(rs.split(".")[0] as string)).toBe("dropped");
    await resumeOk("root");
    expect(await resumed()).toMatchObject({ skipped: 0, missed: 1 });
  });
});

describe("AC-08 refusals while paused", { timeout: 60_000 }, () => {
  it("test_AC08_paths", async () => {
    await pulseCast();
    const m2 = await k.bare("bob", "m2", { headless: false });
    const G0 = await k.r.goal(tokenOf("bob"), [{ id: "h", mode: "headless" }]);
    expect((await stepAs("bob", `${G0}.h`, "assign", { to: m1.machine })).status).toBe(200);
    await pauseOk("root");
    // Pulse fire.
    for (const b of [{}, { trial: true }]) refused(await k.act("bob", "p-1", "fire", b), 409, "fleet-paused");
    const dave = await k.act("dave", "p-1", "fire");
    expect(dave.status).toBe(403);
    expect(dave.json.code).toBeUndefined();
    expect(await k.slotsOf("p-1")).toStrictEqual([]);
    expect((await k.act("bob", "p-1", "fire")).json.error).toMatch(/^the fleet is paused since \S+ by root: bad agent release; an admin resumes it \(mesh fleet resume\)$/);
    // Step assign.
    const G1 = await k.r.goal(tokenOf("bob"), [{ id: "h", mode: "headless" }, { id: "i" }]);
    refused(await stepAs("bob", `${G1}.h`, "assign", { to: m1.machine }), 409, "fleet-paused");
    expect((await stepAs("bob", `${G1}.i`, "assign", { to: m1.machine })).status).toBe(200);
    expect((await k.step(`${G1}.i`)).offer.state).toBe("offered");
    // Goal assign.
    const G2 = await k.r.goal(tokenOf("bob"), [{ id: "h", mode: "headless" }, { id: "i" }]);
    const both = await k.call("bob", "POST", `/v1/goals/${G2}/assign`, { to: m1.machine });
    expect(both.status, JSON.stringify(both.json)).toBe(200);
    expect((both.json.steps as Json[]).map((s) => s.id)).toStrictEqual([`${G2}.i`]);
    const G3 = await k.r.goal(tokenOf("bob"), [{ id: "h", mode: "headless" }]);
    refused(await k.call("bob", "POST", `/v1/goals/${G3}/assign`, { to: m1.machine }), 409, "fleet-paused");
    const cannot = await k.call("bob", "POST", `/v1/goals/${G3}/assign`, { to: m2.machine });
    expect(cannot.status).toBe(409);
    expect(cannot.json).toStrictEqual({ error: `${G3} has no ready step to offer` });
    const G4 = await k.r.goal(tokenOf("bob"), [{ id: "h", mode: "headless" }]);
    const stick = await k.call("bob", "POST", `/v1/goals/${G4}/assign`, { to: m1.machine, stick: true });
    expect(stick.status, JSON.stringify(stick.json)).toBe(200);
    expect(stick.json.steps).toStrictEqual([]);
    expect(await offeredOf(`${G4}.h`)).toStrictEqual([]);
    // Accept of a headless offer the pause did not withdraw (store fixture).
    const st = await k.w.hub.svc.store.getStep(`${G0}.h`);
    expect(st?.offer?.state).toBe("withdrawn");
    await k.w.hub.svc.store.saveSteps([{ ...(st as never as Json), offer: { ...st?.offer, state: "offered" } }]);
    expect((await k.w.call(m2.token, "POST", `/v1/steps/${G0}.h/accept`, {})).status).toBe(403);
    refused(await k.w.call(m1.token, "POST", `/v1/steps/${G0}.h/accept`, {}), 409, "fleet-paused");
    expect((await k.step(`${G0}.h`)).offer.state).toBe("offered");
    // After the resume the stick offers G4.h once.
    await resumeOk("root");
    const o = await offeredOf(`${G4}.h`);
    expect(o).toHaveLength(1);
    expect(o[0].payload.machine).toBe(m1.machine);
  });
});

describe("AC-09 stick while paused", { timeout: 60_000 }, () => {
  it("test_AC09_held_then_offered", async () => {
    await pulseCast();
    const gate = (id: string) => ({ id, kind: "gate", gate: "R1" });
    const G = await k.r.goal(tokenOf("bob"), [gate("g"), { id: "h", mode: "headless", deps: ["g"] }, gate("gi"), { id: "i", deps: ["gi"] }]);
    const a = await k.call("bob", "POST", `/v1/goals/${G}/assign`, { to: m1.machine, stick: true });
    expect(a.status, JSON.stringify(a.json)).toBe(200);
    const S = await k.r.goal(tokenOf("bob"), [{ id: "h", mode: "headless" }]);
    expect((await stepAs("bob", `${S}.h`, "assign", { to: m1.machine })).status).toBe(200);
    await pauseOk("root");
    expect((await stepAs("root", `${G}.g`, "approve")).status).toBe(200);
    expect((await k.step(`${G}.h`)).state).toBe("ready");
    expect(await offeredOf(`${G}.h`)).toStrictEqual([]);
    expect((await stepAs("root", `${G}.gi`, "approve")).status).toBe(200);
    expect(await offeredOf(`${G}.i`)).toHaveLength(1);
    await resumeOk("root");
    const o = await offeredOf(`${G}.h`);
    expect(o).toHaveLength(1);
    expect(o[0].payload.machine).toBe(m1.machine);
    expect(await offeredOf(`${S}.h`)).toHaveLength(1);
    expect((await k.step(`${S}.h`)).offer.state).toBe("withdrawn");
  });
});

describe("AC-10 running work untouched", { timeout: 60_000 }, () => {
  it("test_AC10_claimed_session_interactive_offer", async () => {
    await cast({ clock: at(9, 20), hubYaml: TH });
    m1 = await k.bare("bob", "m1", { headless: true, sessions: [k.idleSession("s-1")] });
    const G = await k.r.goal(tokenOf("bob"), [{ id: "h", mode: "headless" }, { id: "s" }, { id: "o" }]);
    expect((await stepAs("bob", `${G}.h`, "assign", { to: m1.machine })).status).toBe(200);
    expect((await k.w.call(m1.token, "POST", `/v1/steps/${G}.h/accept`, {})).status).toBe(200);
    const claim = await k.w.call(m1.token, "POST", `/v1/steps/${G}.s/claim`, { sid: "s-1" });
    expect(claim.status, JSON.stringify(claim.json)).toBe(200);
    expect((await stepAs("bob", `${G}.o`, "assign", { to: m1.machine })).status).toBe(200);
    const ids = [`${G}.h`, `${G}.s`, `${G}.o`];
    const before = await Promise.all(ids.map((id) => k.step(id)));
    expect(before.map((s) => s.state)).toStrictEqual(["claimed", "claimed", "ready"]);
    const inbox = await k.inbox(m1.token);
    k.at(at(9, 30));
    await pauseOk("root");
    k.at(at(9, 40));
    await resumeOk("root");
    expect(await Promise.all(ids.map((id) => k.step(id)))).toStrictEqual(before);
    expect(await k.inbox(m1.token)).toStrictEqual(inbox);
    expect((await fleetEvents())[0].payload.withdrawn).toBe(0);
  });
});

describe("AC-19 queued slots", { timeout: 60_000 }, () => {
  /** P1 under queue: the 10:00 goal runs (run step accepted and started), slot 11:00 queued. */
  async function queued(): Promise<string> {
    await pulseCast({ p: { overlap: "queue" } });
    await k.tickAt(at(10), m1);
    const G = (await k.slotOf("p-1", iso(at(10)))).goal as string;
    expect((await k.w.call(m1.token, "POST", `/v1/steps/${G}.run/accept`, {})).status).toBe(200);
    expect((await k.w.call(m1.token, "POST", `/v1/steps/${G}.run/run`, { state: "started", runId: "r-1" })).status).toBe(200);
    await k.tickAt(at(11, 1), m1);
    expect((await k.slotOf("p-1", iso(at(11)))).state).toBe("queued");
    return G;
  }
  const end = async (G: string, t: number) => {
    k.at(t);
    expect((await k.w.call(m1.token, "POST", `/v1/steps/${G}.run/release`, {})).status).toBe(200);
    const d = await k.call("bob", "POST", `/v1/goals/${G}/drop`, {});
    expect(d.status, JSON.stringify(d.json)).toBe(200);
  };

  it("test_AC19a_released_while_paused_is_skipped", async () => {
    const G = await queued();
    k.at(at(11, 10));
    await pauseOk("root");
    await end(G, at(11, 20));
    await k.tickAt(at(11, 21), m1);
    const s = await k.slotOf("p-1", iso(at(11)));
    expect([s.state, s.reason]).toStrictEqual(["skipped", "fleet_paused"]);
    expect((await pulseEv("pulse.skipped")).filter((p) => p.slot === iso(at(11)))).toStrictEqual([{ pulse: "p-1", slot: iso(at(11)), reason: "fleet_paused" }]);
    expect(await k.goalsOfPulse("p-1")).toStrictEqual([G]);
    k.at(at(11, 30));
    await resumeOk("root");
    await k.tickAt(at(11, 31), m1);
    expect(await k.goalsOfPulse("p-1")).toStrictEqual([G]);
    expect(await resumed()).toMatchObject({ skipped: 1, missed: 0 });
  });

  it("test_AC19b_resumed_before_release", async () => {
    const G = await queued();
    k.at(at(11, 10));
    await pauseOk("root");
    k.at(at(11, 15));
    await resumeOk("root");
    await end(G, at(11, 20));
    await k.tickAt(at(11, 21), m1);
    expect((await k.slotOf("p-1", iso(at(11)))).state).toBe("fired");
    expect(await k.goalsOfPulse("p-1")).toHaveLength(2);
  });

  it("test_AC19c_due_while_paused_not_queued", async () => {
    await queued();
    k.at(at(11, 10));
    await pauseOk("root");
    await k.tickAt(at(12, 1), m1);
    expect((await k.slotOf("p-1", iso(at(12)))).state).toBe("skipped");
    expect((await k.slotOf("p-1", iso(at(12)))).reason).toBe("fleet_paused");
    expect((await k.slotOf("p-1", iso(at(11)))).state).toBe("queued");
  });
});

describe("AC-20 only held steps are offered again", { timeout: 60_000 }, () => {
  it("test_AC20_declined_and_expired_stay", async () => {
    await cast({ clock: at(9, 40), hubYaml: { thresholds: { offer_expiry: "5m", machine_offline: "15m" } } });
    m1 = await k.bare("bob", "m1", { headless: true });
    const gate = (id: string) => ({ id, kind: "gate", gate: "R1" });
    const G = await k.r.goal(tokenOf("bob"), [
      { id: "s1", mode: "headless" },
      { id: "s2", mode: "headless" },
      gate("ga"),
      { id: "s3", mode: "headless", deps: ["ga"] },
      gate("gb"),
      { id: "s4", mode: "headless", deps: ["gb"] },
    ]);
    k.at(at(9, 50));
    const a = await k.call("bob", "POST", `/v1/goals/${G}/assign`, { to: m1.machine, stick: true });
    expect((a.json.steps as Json[]).map((s) => s.id)).toStrictEqual([`${G}.s1`, `${G}.s2`]);
    expect((await stepAs("bob", `${G}.s1`, "decline")).status).toBe(200);
    await k.tickAt(at(9, 55), m1);
    expect((await k.step(`${G}.s2`)).offer.state).toBe("expired");
    k.at(at(9, 58));
    expect((await stepAs("root", `${G}.ga`, "approve")).status).toBe(200);
    expect((await k.step(`${G}.s3`)).offer.state).toBe("offered");
    k.at(at(10));
    expect((await pauseOk("root")) && (await fleetEvents())[0].payload.withdrawn).toBe(1);
    k.at(at(10, 2));
    expect((await stepAs("root", `${G}.gb`, "approve")).status).toBe(200);
    expect(await offeredOf(`${G}.s4`)).toStrictEqual([]);
    k.at(at(10, 5));
    await resumeOk("root");
    expect(await offeredOf(`${G}.s3`)).toHaveLength(2);
    expect(await offeredOf(`${G}.s4`)).toHaveLength(1);
    expect(await offeredOf(`${G}.s1`)).toHaveLength(1);
    expect(await offeredOf(`${G}.s2`)).toHaveLength(1);
    await k.tickAt(at(10, 6), m1);
    expect(await offeredOf(`${G}.s1`)).toHaveLength(1);
    expect(await offeredOf(`${G}.s2`)).toHaveLength(1);
    expect((await k.step(`${G}.s1`)).offer.state).toBe("declined");
    expect((await k.step(`${G}.s2`)).offer.state).toBe("expired");
  });
});
