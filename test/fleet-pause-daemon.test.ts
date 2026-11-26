// RL-24 daemon side (World + the fake claude): the daemon keeps the fleet pause from its last sync
// reply, starts no queued headless run while it is set, notifies once per change, and leaves an
// accept the hub refuses `409 fleet-paused` acked failed (no decline). Criteria AC-13 to AC-15.
// Written from the spec's contracts (docs/specs/RL-24.md). No test runs the real `claude`.

import { afterEach, describe, expect, it, vi } from "vitest";
import { Relay, sleep, until } from "./helpers/relay-kit.ts";
import type { Json, Person } from "./helpers/world.ts";

let r: Relay;
afterEach(async () => {
  vi.restoreAllMocks();
  await r?.stop();
});

const REASON = "bad agent release";

interface DCast {
  ann: Person;
  /** ann's other login: its offers to ann's machine are auto (accept `self`). */
  self: string;
  root: string;
}

async function dcast(o: { maxSessions?: number } = {}): Promise<DCast> {
  r = await Relay.start(["ann", "bob", "root"], { admins: ["root"] });
  const ann = await r.headlessPerson("ann", { nick: "hl" });
  if (o.maxSessions !== undefined) await r.w.restart(ann, { maxSessions: o.maxSessions });
  const self = await r.otherLogin("ann");
  const root = (await r.w.login("root", { hostname: "root-login" })).token;
  await r.w.flush();
  return { ann, self, root };
}

async function pause(k: DCast): Promise<void> {
  const res = await r.w.call(k.root, "POST", "/v1/fleet/pause", { reason: REASON });
  expect(res.status, JSON.stringify(res.json)).toBe(200);
  await r.w.flush();
}
async function resume(k: DCast): Promise<void> {
  const res = await r.w.call(k.root, "POST", "/v1/fleet/resume", {});
  expect(res.status, JSON.stringify(res.json)).toBe(200);
  await r.w.flush();
}

async function queuedRun(k: DCast, id: string): Promise<{ step: string; msg: Json }> {
  const G = await r.goal(k.self, [{ id, mode: "headless" }]);
  const step = `${G}.${id}`;
  r.script(step, [{ waitFor: "end" }]);
  const msg = await r.autoOffer(k.ann, step, k.self);
  await r.pull(k.ann);
  expect((await r.runOf(k.ann, step)).state).toBe("queued");
  return { step, msg };
}

describe("AC-13 queued runs while paused", { timeout: 40_000 }, () => {
  it("test_AC13_not_started_until_resumed", async () => {
    const k = await dcast({ maxSessions: 1 });
    await r.w.hook(k.ann, "SessionStart", 1);
    await r.w.flush();
    const { step } = await queuedRun(k, "q1");
    await pause(k);
    await r.w.hook(k.ann, "SessionEnd", 1);
    await r.reconcile(k.ann);
    await sleep(200);
    expect((await r.runOf(k.ann, step)).state).toBe("queued");
    expect(r.calls(step)).toStrictEqual([]);
    await resume(k);
    await r.reconcile(k.ann);
    await r.started(step);
    expect((await r.runOf(k.ann, step)).state).toBe("running");
  });

  it("test_AC13_deadline_release_while_paused", async () => {
    const k = await dcast({ maxSessions: 1 });
    await r.w.hook(k.ann, "SessionStart", 1);
    await r.w.flush();
    const { step, msg } = await queuedRun(k, "q2");
    await pause(k);
    r.w.clock = msg.data.deadline + 1;
    await r.reconcile(k.ann);
    expect((await r.runOf(k.ann, step)).state).toBe("released");
    expect((await r.stepOf(step)).state).toBe("ready");
    expect(r.calls(step)).toStrictEqual([]);
  });
});

describe("AC-14 notifications", { timeout: 40_000 }, () => {
  const fleetNotes = (p: Person) => p.notes.filter((n) => n.includes("fleet"));

  it("test_AC14_once_per_change", async () => {
    const k = await dcast();
    expect(fleetNotes(k.ann)).toStrictEqual([]);
    await pause(k);
    expect(fleetNotes(k.ann)).toStrictEqual([`mesh: fleet paused by @root: ${REASON}`]);
    await r.w.flush();
    expect(fleetNotes(k.ann)).toHaveLength(1);
    await resume(k);
    expect(fleetNotes(k.ann)).toStrictEqual([`mesh: fleet paused by @root: ${REASON}`, "mesh: fleet resumed"]);
    await r.w.flush();
    expect(fleetNotes(k.ann)).toHaveLength(2);
  });

  it("test_AC14_via_in_text", async () => {
    const k = await dcast();
    const ops = await r.w.hub.svc.serviceToken("ops", ["fleet:pause"]);
    expect((await r.w.call(ops, "POST", "/v1/fleet/pause", { reason: REASON }, { "x-mesh-on-behalf-of": "root" })).status).toBe(200);
    await r.w.flush();
    expect(fleetNotes(k.ann)).toStrictEqual([`mesh: fleet paused by @root via ops: ${REASON}`]);
  });

  it("test_AC14_none_on_first_reply_after_start", async () => {
    const k = await dcast();
    await pause(k);
    k.ann.notes.length = 0;
    await r.w.restart(k.ann);
    await r.w.flush();
    expect(fleetNotes(k.ann)).toStrictEqual([]);
    const st = await r.local(k.ann, "GET", "/local/status");
    expect(st.json.fleetPaused).toMatchObject({ by: "root", reason: REASON });
  });

  it("test_AC14_notify_off", async () => {
    const k = await dcast();
    k.ann.config = { ...k.ann.config, notify: "off" };
    await r.w.restart(k.ann);
    await r.w.flush();
    await pause(k);
    await resume(k);
    expect(fleetNotes(k.ann)).toStrictEqual([]);
  });

  it("test_AC14_older_hub_changes_nothing", async () => {
    const k = await dcast();
    const svc = r.w.hub.svc;
    const orig = svc.sync.bind(svc);
    vi.spyOn(svc, "sync").mockImplementation(async (...a: Parameters<typeof svc.sync>) => {
      const { paused: _p, ...rest } = await orig(...a);
      return rest;
    });
    await pause(k);
    expect(fleetNotes(k.ann)).toStrictEqual([]);
    expect((await r.local(k.ann, "GET", "/local/status")).json.fleetPaused).toBeUndefined();
  });
});

describe("AC-15 a refused accept", { timeout: 40_000 }, () => {
  it("test_AC15_acked_failed_no_decline", async () => {
    const k = await dcast();
    const G = await r.goal(k.self, [{ id: "h", mode: "headless" }]);
    const step = `${G}.h`;
    const msg = await r.autoOffer(k.ann, step, k.self);
    const res = await r.w.call(k.root, "POST", "/v1/fleet/pause", { reason: REASON });
    expect(res.status).toBe(200);
    // An offer the pause did not withdraw (as one made by an older replica during an upgrade).
    const st = await r.w.hub.svc.store.getStep(step);
    await r.w.hub.svc.store.saveSteps([{ ...(st as never as Json), offer: { ...st?.offer, state: "offered" } }]);
    await r.pull(k.ann);
    expect(await until(() => k.ann.acks.some((a) => a.id === msg.id))).toBe(true);
    const ack = k.ann.acks.find((a) => a.id === msg.id);
    expect(ack?.state).toBe("failed");
    expect(ack?.method).toMatch(/^the fleet is paused since \S+ by root: bad agent release; an admin resumes it \(mesh fleet resume\)$/);
    expect(k.ann.requests.filter((q) => q.path === `/v1/steps/${step}/decline`)).toStrictEqual([]);
    expect(r.calls(step)).toStrictEqual([]);
  });
});
