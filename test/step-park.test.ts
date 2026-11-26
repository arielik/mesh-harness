// RL-22 AC-15 to AC-21: a person parks a claimed or paused step by hand (POST /v1/steps/:id/park,
// `mesh step park`), also through a service acting for the goal owner. Written from
// docs/specs/RL-22.md (§Park). Steps by id, events by type + step, messages by kind + step text.

import { afterEach, describe, expect, it } from "vitest";
import { Ak, NOW } from "./helpers/attention-kit.ts";
import { Relay } from "./helpers/relay-kit.ts";
import type { Json } from "./helpers/world.ts";

let k: Ak | undefined;
let r: Relay | undefined;
afterEach(async () => {
  await k?.stop();
  await r?.stop();
  k = undefined;
  r = undefined;
});

const park = (ak: Ak, who: string, id: string, reason: unknown = "wrong branch") => ak.call(who, "POST", `/v1/steps/${id}/park`, { reason });

/** ann's goal with steps a (held by bob's live session s-bob), b (deps a), c, and a gate g. */
async function world(): Promise<{ ak: Ak; G: string }> {
  const ak = await Ak.start(NOW);
  k = ak;
  const G = await ak.goal("ann", [{ id: "a" }, { id: "b", deps: ["a"] }, { id: "c" }, { id: "g", kind: "gate", gate: "R1" }, { id: "d" }]);
  await ak.hold(`${G}.a`, "bob", "s-bob");
  await ak.session("bob", "s-bob", { state: "working", step: `${G}.a` });
  return { ak, G };
}

describe("RL-22 AC-15 park a claimed step", () => {
  it("test_AC15_park_claimed", async () => {
    const { ak, G } = await world();
    const id = `${G}.a`;
    const before = await ak.step(id);
    const res = await park(ak, "ann", id);
    expect(res.status, JSON.stringify(res.json)).toBe(200);
    const st = await ak.step(id);
    expect(res.json.step).toMatchObject({ id, state: "parked", parkedReason: "operator: wrong branch" });
    expect(st).toMatchObject({ state: "parked", parkedReason: "operator: wrong branch", parkedAt: NOW });
    for (const f of ["holderUser", "holderSid", "holderMachine", "claimedAt", "roundStartedAt", "outcome"]) expect(st, f).not.toHaveProperty(f);
    expect(st.rounds ?? []).toStrictEqual(before.rounds ?? []);
    const evs = await ak.events("step.parked", id);
    expect(evs).toHaveLength(1);
    expect(evs[0].user).toBe("ann");
    expect(evs[0].payload).toStrictEqual({ reason: "operator: wrong branch", operator: true, was: "claimed", holder: "bob" });
    const msgs = (await ak.inbox("bob")).filter((m) => m.kind === "parked");
    expect(msgs).toHaveLength(1);
    expect(msgs[0].text).toBe(`MESH: @ann parked step ${id}: wrong branch. Stop working on it; your notes are kept. A person resumes it (mesh step resume ${id}).`);
    expect(msgs[0].toSid).toBe("s-bob");
    // The holder's done is refused.
    expect(await ak.call("bob", "POST", `/v1/steps/${id}/done`, { summary: "ok", sid: "s-bob" })).toMatchObject({ status: 409, json: { error: `${id} is parked; claim it first` } });
    // Resume: its dependencies are done (none), so ready.
    const rs = await ak.call("ann", "POST", `/v1/steps/${id}/resume`, {});
    expect(rs.status, JSON.stringify(rs.json)).toBe(200);
    expect((await ak.step(id)).state).toBe("ready");
  });
});

describe("RL-22 AC-16 AC-17 what is parked", () => {
  it("test_AC16_paused_and_ready", async () => {
    const { ak, G } = await world();
    await ak.patch(`${G}.c`, { state: "paused", holderUser: "bob", pausedAt: NOW - 1000 });
    const res = await park(ak, "ann", `${G}.c`);
    expect(res.status, JSON.stringify(res.json)).toBe(200);
    expect((await ak.events("step.parked", `${G}.c`))[0].payload).toMatchObject({ was: "paused", holder: "bob" });
    // A ready step, with and without an open offer.
    const ready = await ak.step(`${G}.d`);
    const notParkable = { status: 409, json: { error: `${G}.d is ready; only a claimed or paused step is parked by hand`, code: "step-not-parkable" } };
    expect(await park(ak, "ann", `${G}.d`)).toStrictEqual(notParkable);
    const offered = await ak.patch(`${G}.d`, { offer: { to: { machine: ak.m.bob?.machine as string }, by: "ann", at: NOW, state: "offered", auto: false } });
    expect(await park(ak, "ann", `${G}.d`)).toStrictEqual(notParkable);
    expect(await ak.step(`${G}.d`)).toStrictEqual(offered);
    expect(ready.state).toBe("ready");
  });

  it("test_AC17_refusals", async () => {
    const { ak, G } = await world();
    const code = async (who: string, id: string, reason?: unknown) => {
      const r2 = await park(ak, who, id, reason);
      return [r2.status, r2.json.code];
    };
    expect(await code("ann", `${G}.g`)).toStrictEqual([409, "step-gate"]);
    const D = await ak.goal("ann", [{ id: "x" }]);
    await ak.patch(`${D}.x`, { kind: "review", policy: { mode: "debrief" }, state: "claimed", holderUser: "ann" });
    expect(await code("ann", `${D}.x`)).toStrictEqual([409, "step-debrief"]);
    expect((await park(ak, "ann", `${G}.a`)).status).toBe(200);
    expect(await code("ann", `${G}.a`)).toStrictEqual([409, "step-parked"]);
    expect(await code("ann", `${G}.b`)).toStrictEqual([409, "step-not-parkable"]);
    expect(await code("ann", `${G}.d`)).toStrictEqual([409, "step-not-parkable"]);
    await ak.patch(`${G}.c`, { state: "done", outcome: "done" });
    expect(await code("ann", `${G}.c`)).toStrictEqual([409, "step-not-parkable"]);
    await ak.patch(`${G}.d`, { state: "failed", outcome: "fail" });
    expect(await code("ann", `${G}.d`)).toStrictEqual([409, "step-not-parkable"]);
    const X = await ak.goal("ann", [{ id: "x" }]);
    await ak.hold(`${X}.x`, "ann", undefined);
    await ak.patchGoal(X, { state: "dropped" });
    expect(await code("ann", `${X}.x`)).toStrictEqual([409, "goal-closed"]);
    const Y = await ak.goal("ann", [{ id: "y" }]);
    await ak.hold(`${Y}.y`, "ann", undefined);
    expect(await code("bob", `${Y}.y`)).toStrictEqual([403, "not-approver"]);
    for (const reason of ["", "x".repeat(501)]) {
      const r2 = await park(ak, "ann", `${Y}.y`, reason);
      expect(r2.status).toBe(400);
      expect(r2.json).not.toHaveProperty("code");
    }
    expect(await park(ak, "ann", "G99.a")).toStrictEqual({ status: 404, json: { error: "no step G99.a", code: "step-unknown" } });
    expect((await ak.step(`${Y}.y`)).state).toBe("claimed");
  });
});

describe("RL-22 AC-18 AC-21 park through a service", () => {
  it("test_AC18_act_for", async () => {
    const { ak, G } = await world();
    expect(await ak.as("apu", "POST", `/v1/steps/${G}.a/park`, { reason: "stop" })).toMatchObject({ status: 403, json: { code: "not-approver" } });
    const res = await ak.as("ann", "POST", `/v1/steps/${G}.a/park`, { reason: "stop" });
    expect(res.status, JSON.stringify(res.json)).toBe(200);
    const [ev] = await ak.events("step.parked", `${G}.a`);
    expect([ev.user, ev.payload.via, ev.payload.reason]).toStrictEqual(["ann", "svc", "operator: stop"]);
    const [m] = (await ak.inbox("bob")).filter((x) => x.kind === "parked");
    expect(m.text.endsWith(" (via svc)")).toBe(true);
    expect([m.fromUser, m.data?.via]).toStrictEqual(["ann", "svc"]);
  });

  it("test_AC21_idempotency", async () => {
    const { ak, G } = await world();
    const send = () => ak.as("ann", "POST", `/v1/steps/${G}.a/park`, { reason: "stop" }, ak.svc, { "idempotency-key": "park-1" });
    const first = await send();
    expect(first.status).toBe(200);
    expect(await send()).toStrictEqual(first);
    expect(await ak.events("step.parked", `${G}.a`)).toHaveLength(1);
  });
});

describe("RL-22 AC-20 CLI", () => {
  it("test_AC20_mesh_step_park", async () => {
    r = await Relay.start(["ann", "bob"]);
    const ann = await r.w.person("ann", "svc");
    const bob = await r.w.person("bob", "svc");
    const G = await r.goal(ann, [{ id: "build" }]);
    expect((await r.act(bob, `${G}.build`, "claim", {})).status).toBe(200);
    const out = await r.cli(ann, ["step", "park", `${G}.build`, "wrong", "branch"]);
    expect([out.code, out.out.trim()], out.err).toStrictEqual([0, `${G}.build parked: operator: wrong branch`]);
    expect(out.requests).toContain(`POST /v1/steps/${G}.build/park`);
    const again = await r.cli(ann, ["step", "park", `${G}.build`, "again"]);
    expect(again.code).toBe(1);
    expect(again.err).toContain(`${G}.build is already parked`);
    const help = await r.cli(ann, ["step", "--help"]);
    expect(`${help.out}${help.err}`).toContain("mesh step park <step> <reason…>");
  });
});

describe("RL-22 AC-19 a headless run whose step is parked", { timeout: 40_000 }, () => {
  it("test_AC19_run_keeps_running", async () => {
    r = await Relay.start(["ann", "bob", "root"], { admins: ["root"] });
    const relay = r;
    const ann = await relay.headlessPerson("ann", { nick: "hl" });
    const self = await relay.otherLogin("ann");
    await relay.w.flush();
    const G = await relay.goal(self, [{ id: "run", mode: "headless" }]);
    const id = `${G}.run`;
    relay.script(id, [{ waitFor: "done" }, { exit: 0 }]);
    await relay.autoOffer(ann, id, self);
    await relay.pull(ann);
    const call: Json = await relay.started(id);
    await relay.runSession(ann, id, 7);
    const res = await relay.act(self, id, "park", { reason: "wrong branch" });
    expect(res.status, JSON.stringify(res.json)).toBe(200);
    // The run is not killed: its process is alive.
    expect(relay.allCalls().some((c) => c.env?.MESH_STEP === id)).toBe(true);
    const run = await relay.runOf(ann, id);
    expect(run.state).toBe("running");
    const d = await relay.w.tool(ann, 7, "mesh_done", { outcome: "done", summary: "ok" });
    expect(d.isError).toBe(true);
    expect(d.text).toContain(`${id} is parked; claim it first`);
    expect((await relay.stepOf(id)).state).toBe("parked");
    expect(typeof call.pid).toBe("number");
    relay.go("done");
    await relay.endRun(ann, id);
    expect((await relay.stepOf(id)).state).toBe("parked");
  });
});
