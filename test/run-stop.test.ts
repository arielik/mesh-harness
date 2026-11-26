// RL-26: POST /v1/steps/:id/stop-run at the hub (World, bare machines): the park, the one run_stop
// message, the events, the rights (own token and act-for with the member role only) and the
// transcript exception. Written from the spec's contracts (docs/specs/RL-26.md, AC-01 to AC-03, AC-07).

import { afterEach, describe, expect, it } from "vitest";
import { as, cast, events, goal, idle, messagesOf, runOn, type Cast } from "./helpers/stop-kit.ts";
import type { Json } from "./helpers/pulse-kit.ts";

let c: Cast | undefined;
afterEach(async () => {
  await c?.k.stop();
  c = undefined;
});

const stop = (c: Cast, token: string, id: string, reason = "wrong base", user?: string) => as(c, token, "POST", `/v1/steps/${id}/stop-run`, { reason }, user);
const stepOf = (c: Cast, id: string) => c.k.step(id);

/** Nothing of a stop happened to `id`: held as before, no run_stop message, no stop event. */
async function unchanged(c: Cast, id: string, state = "claimed"): Promise<void> {
  const st = await stepOf(c, id);
  expect(st.state).toBe(state);
  expect(st).not.toHaveProperty("stoppedRun");
  for (const m of [c.ann, c.bob, c.root, c.dave]) expect((await messagesOf(c, m)).filter((x: Json) => x.kind === "run_stop")).toStrictEqual([]);
  expect(await events(c, "run.stop_requested", id)).toStrictEqual([]);
}

describe("AC-01 a stop parks the step and asks the machine once", () => {
  it("test_AC01_stop_run_parks_and_messages", async () => {
    c = await cast();
    const G = await goal(c);
    const id = `${G}.a`;
    await runOn(c, id);
    const before = (await messagesOf(c, c.bob)).length;
    const r = await stop(c, c.k.tok.ann as string, id);
    expect(r.status, JSON.stringify(r.json)).toBe(200);
    expect(r.json.online).toBe(true);
    expect(typeof r.json.message).toBe("number");
    const st = await stepOf(c, id);
    expect(st.state).toBe("parked");
    expect(st.parkedReason).toBe("stopped: wrong base");
    for (const f of ["holderUser", "holderSid", "holderMachine", "claimedAt", "roundStartedAt", "outcome"]) expect(st, f).not.toHaveProperty(f);
    expect(st.rounds ?? []).toStrictEqual([]);
    expect(st.stoppedRun).toMatchObject({ machine: c.bob.machine, holder: "bob", by: "ann", runId: "run-1" });
    expect(st.stoppedRun).not.toHaveProperty("via");
    const msgs = await messagesOf(c, c.bob);
    expect(msgs).toHaveLength(before + 1);
    const m = msgs.find((x: Json) => x.kind === "run_stop");
    expect(m?.id).toBe(r.json.message);
    expect(m?.toSid).toBe("");
    expect(m?.text).toBe(`MESH: @ann stopped the headless run of ${id}: wrong base`);
    expect(m?.data).toStrictEqual({ step: id, goal: G, reason: "wrong base", by: "ann", runId: "run-1" });
    for (const x of [c.ann, c.root, c.dave]) expect((await messagesOf(c, x)).filter((y: Json) => y.kind === "parked" || y.kind === "run_stop")).toStrictEqual([]);
    const req = await events(c, "run.stop_requested", id);
    const parked = await events(c, "step.parked", id);
    expect(req).toHaveLength(1);
    expect(parked).toHaveLength(1);
    expect(req[0].seq).toBeLessThan(parked[0].seq);
    expect(req[0].user).toBe("ann");
    expect(req[0].payload).toStrictEqual({ machine: c.bob.machine, runId: "run-1", reason: "wrong base" });
    expect(parked[0].payload).toMatchObject({ reason: "stopped: wrong base", stopped: true });
  });
});

describe("AC-02 refusals and the machine owner's own right", () => {
  it("test_AC02_refusals_with_codes", async () => {
    c = await cast();
    const G = await goal(c);
    const id = `${G}.a`;
    const unknown = await stop(c, c.k.tok.ann as string, `${G}.nope`);
    expect([unknown.status, unknown.json.code]).toStrictEqual([404, "step-unknown"]);
    // A dropped goal.
    const D = await goal(c);
    expect((await c.k.call("ann", "POST", `/v1/goals/${D}/drop`, {})).status).toBe(200);
    const closed = await stop(c, c.k.tok.ann as string, `${D}.a`);
    expect([closed.status, closed.json.code]).toStrictEqual([409, "goal-closed"]);
    await runOn(c, id);
    // The machine owner's right is never relayed; dave has neither right.
    const relayed = await stop(c, c.svc, id, "x", "bob");
    expect([relayed.status, relayed.json.code]).toStrictEqual([403, "not-approver"]);
    const dave = await stop(c, c.k.tok.dave as string, id);
    expect([dave.status, dave.json.code]).toStrictEqual([403, "not-approver"]);
    await unchanged(c, id);
    // bob's own token: the run is on his machine.
    const own = await stop(c, c.k.tok.bob as string, id);
    expect(own.status, JSON.stringify(own.json)).toBe(200);
  });

  it("test_AC02_not_a_run_and_unsupported", async () => {
    c = await cast();
    const G = await goal(c);
    // An interactive step claimed by a session.
    c.bob.facts.sessions = [idle(c, "bob-s1")];
    await c.k.sync(c.bob);
    expect((await c.k.w.call(c.bob.token, "POST", `/v1/steps/${G}.b/claim`, { sid: "bob-s1" })).status).toBe(200);
    const notRun = await stop(c, c.k.tok.ann as string, `${G}.b`);
    expect(notRun).toStrictEqual({ status: 409, json: { error: `${G}.b is not held by a headless run; park it instead (mesh step park ${G}.b)`, code: "not-a-run" } });
    await unchanged(c, `${G}.b`);
    // A holder machine that never reported runStop.
    const older = await c.k.bare("bob", "bob-old", { repos: c.bob.facts.repos ?? [], accept: ["self", "user:ann"], headless: true, share: "all" });
    await runOn(c, `${G}.a`, older);
    const unsupported = await stop(c, c.k.tok.ann as string, `${G}.a`);
    expect([unsupported.status, unsupported.json.code]).toStrictEqual([409, "run-stop-unsupported"]);
    expect(unsupported.json.error).toMatch(/runs an older mesh that cannot stop a run; park the step and ask bob to upgrade$/);
    await unchanged(c, `${G}.a`);
  });
});

describe("AC-03 act-for runs with the member role only", () => {
  it("test_AC03_act_for_rights", async () => {
    c = await cast();
    const G = await goal(c, [{ id: "a", mode: "headless" }, { id: "b", mode: "headless" }]);
    await runOn(c, `${G}.a`);
    const noHeader = await stop(c, c.svc, `${G}.a`);
    expect([noHeader.status, noHeader.json.code]).toStrictEqual([400, "on-behalf-of-required"]);
    const old = await stop(c, c.old, `${G}.a`, "x", "ann");
    expect(old).toStrictEqual({ status: 403, json: { error: "forbidden", code: "forbidden" } });
    for (const who of ["apu", "root"]) {
      const r = await stop(c, c.svc, `${G}.a`, "x", who);
      expect([r.status, r.json.code], who).toStrictEqual([403, "not-approver"]);
    }
    await unchanged(c, `${G}.a`);
    const forAnn = await stop(c, c.svc, `${G}.a`, "x", "ann");
    expect(forAnn.status, JSON.stringify(forAnn.json)).toBe(200);
    const [req] = await events(c, "run.stop_requested", `${G}.a`);
    expect([req.user, req.payload.via]).toStrictEqual(["ann", "svc"]);
    const [parked] = await events(c, "step.parked", `${G}.a`);
    expect([parked.user, parked.payload.via]).toStrictEqual(["ann", "svc"]);
    expect((await stepOf(c, `${G}.a`)).stoppedRun).toMatchObject({ by: "ann", via: "svc" });
    const msg = (await messagesOf(c, c.bob)).find((x: Json) => x.kind === "run_stop");
    expect(msg?.text).toBe(`MESH: @ann stopped the headless run of ${G}.a: x (via svc)`);
    // apu's own token: the approver role counts.
    await runOn(c, `${G}.b`, c.bob, "run-2");
    const apu = await stop(c, c.k.tok.apu as string, `${G}.b`);
    expect(apu.status, JSON.stringify(apu.json)).toBe(200);
  });
});

describe("AC-07 the transcript exception", () => {
  it("test_AC07_one_transcript_from_the_stopped_machine", async () => {
    c = await cast();
    const G = await goal(c);
    const id = `${G}.a`;
    await runOn(c, id);
    expect((await stop(c, c.k.tok.ann as string, id)).status).toBe(200);
    const up = (token: string, kind = "transcript") => c!.k.w.call(token, "POST", `/v1/steps/${id}/artifacts`, { kind, mediaType: "text/plain", content: "tail", title: "run transcript (killed_operator)" });
    const refused = { status: 409, json: { error: `${id} is parked; only a held step takes artifacts` } };
    expect(await up(c.bob.token, "report")).toStrictEqual(refused);
    expect(await up(c.k.tok.bob as string)).toStrictEqual(refused);
    expect(await up(c.ann.token)).toStrictEqual(refused);
    const first = await up(c.bob.token);
    expect(first.status, JSON.stringify(first.json)).toBe(201);
    expect(first.json.round).toBe(1);
    expect(first.json.kind).toBe("transcript");
    expect(await up(c.bob.token)).toStrictEqual(refused);
    const resumed = await c.k.call("ann", "POST", `/v1/steps/${id}/resume`, {});
    expect(resumed.status, JSON.stringify(resumed.json)).toBe(200);
    const st = await stepOf(c, id);
    expect(st).not.toHaveProperty("stoppedRun");
    const after = await up(c.bob.token);
    expect(after.status).toBe(409);
    expect(after.json.error).toBe(`${id} is ${st.state}; only a held step takes artifacts`);
  });
});
