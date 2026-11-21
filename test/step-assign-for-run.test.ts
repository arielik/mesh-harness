// RL-21 AC-14 end to end (World + the fake claude): a service assigns an interactive step for a
// person with `mode: headless` and a profile; the person's daemon runs it as `claude -p` under that
// profile, bound to the run's own session. Written from the spec's contracts (docs/specs/RL-21.md).
// No test runs the real `claude`.

import { afterEach, describe, expect, it } from "vitest";
import { Relay, until } from "./helpers/relay-kit.ts";
import type { Json } from "./helpers/world.ts";

let r: Relay;
afterEach(async () => {
  await r?.stop();
});

/** The stream `result` event the fake prints. */
const RESULT_LINE =
  '{"type":"result","subtype":"success","is_error":false,"num_turns":2,"duration_ms":900,"total_cost_usd":0.001,"usage":{"input_tokens":5,"output_tokens":7,"cache_read_input_tokens":0,"cache_creation_input_tokens":0},"permission_denials":[],"session_id":"$SESSION"}';

describe("AC-14 an overridden step runs headless", { timeout: 60_000 }, () => {
  it("test_AC14_override_runs_headless", async () => {
    r = await Relay.start(["ann"]);
    const ann = await r.headlessPerson("ann", { nick: "hl" });
    const self = await r.otherLogin("ann");
    const svc = await r.w.hub.svc.serviceToken("svc", ["goals:read", "steps:assign"]);
    // An interactive step (no mode in the plan).
    const G = await r.goal(self, [{ id: "x", brief: "Do x (RL21)" }]);
    const id = `${G}.x`;
    r.script(id, [{ waitFor: `go-${id}` }, { stdout: [RESULT_LINE] }, { exit: 0 }]);
    const res = await r.w.call(svc, "POST", `/v1/steps/${id}/assign`, { to: "hl", mode: "headless", profile: "read-only" }, { "x-mesh-on-behalf-of": "ann" });
    expect(res.status, JSON.stringify(res.json)).toBe(200);
    expect(res.json.auto).toBe(true);
    await r.pull(ann);
    const call = await r.started(id);
    expect(call.env?.MESH_STEP).toBe(id);
    const run = await r.runOf(ann, id);
    expect(run.profile?.name).toBe("read-only");
    await r.w.flush();
    const step = await r.stepOf(id);
    expect(step.offer).toMatchObject({ state: "accepted", mode: "headless", via: "svc", by: "ann", profile: { name: "read-only" } });
    // The holder is the run's own session (kind print).
    const ss = (await r.sessionsOf(ann, run.sessionId as string)).filter((s: Json) => s.kind === "print");
    expect(ss).toHaveLength(1);
    expect(step.holderSid).toBe(ss[0]?.sid);
    // run.started names the profile.
    expect(await until(async () => (await r.events("run.started", id)).length > 0, 5_000)).toBe(true);
    const [started] = await r.events("run.started", id);
    expect(started?.payload?.profile).toBe("read-only");
    r.go(`go-${id}`);
  });
});
