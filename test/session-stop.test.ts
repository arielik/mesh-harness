// RL-26: POST /v1/sessions/:sid/stop at the hub (World, bare machines) and the consent facts of a
// sync: the opt-in check, the rights (act-for with the member role only), the checks in order,
// the one `stop` message, `session.stop_requested`, `machine.consent_changed`. Written from the
// spec's contracts (docs/specs/RL-26.md, AC-08, AC-11, AC-12 hub part).

import { afterEach, describe, expect, it } from "vitest";
import { as, cast, events, goal, idle, messagesOf, type Cast } from "./helpers/stop-kit.ts";
import type { Json } from "./helpers/pulse-kit.ts";

let c: Cast | undefined;
afterEach(async () => {
  await c?.k.stop();
  c = undefined;
});

const stopS = (c: Cast, token: string, sid: string, mode = "interrupt", reason = "looping", user?: string) => as(c, token, "POST", `/v1/sessions/${sid}/stop`, { mode, reason }, user);
const stopMsgs = async (c: Cast) => {
  const out: Json[] = [];
  for (const m of [c.ann, c.bob, c.root, c.dave]) out.push(...(await messagesOf(c, m)).filter((x: Json) => x.kind === "stop"));
  return out;
};

/** bob's session `bob-s1` ("bwork") holds ann's step G.b; bob-box reports `remoteStop` as given. */
async function held(c: Cast, remoteStop: boolean | undefined): Promise<string> {
  const G = await goal(c);
  if (remoteStop === undefined) delete c.bob.facts.remoteStop;
  else c.bob.facts.remoteStop = remoteStop;
  c.bob.facts.sessions = [idle(c, "bob-s1", { name: "bwork", step: `${G}.b`, pid: 4242, pane: "%3" })];
  await c.k.sync(c.bob);
  const cl = await c.k.w.call(c.bob.token, "POST", `/v1/steps/${G}.b/claim`, { sid: "bob-s1" });
  expect(cl.status, JSON.stringify(cl.json)).toBe(200);
  return G;
}

describe("AC-08 a machine that has not opted in", () => {
  it.each([
    ["never reported", undefined],
    ["reported false", false],
  ] as const)("test_AC08_stop_refused %s", async (_n, remoteStop) => {
    c = await cast();
    await held(c, remoteStop);
    const r = await stopS(c, c.k.tok.bob as string, "bob-s1");
    expect(r).toStrictEqual({ status: 409, json: { error: "box's owner has not allowed remote stops; ask bob to stop it", code: "stop-refused" } });
    expect(await stopMsgs(c)).toStrictEqual([]);
    expect(await events(c, "session.stop_requested")).toStrictEqual([]);
  });
});

describe("AC-11 rights and checks", () => {
  it("test_AC11_rights", async () => {
    c = await cast();
    const G = await held(c, true);
    const refused = async (token: string, user?: string) => {
      const r = await stopS(c!, token, "bob-s1", "interrupt", "looping", user);
      expect([r.status, r.json.code], `${user ?? "own"}`).toStrictEqual([403, "not-allowed"]);
    };
    await refused(c.svc, "apu");
    await refused(c.svc, "root");
    await refused(c.k.tok.dave as string);
    expect((await stopS(c, c.svc, "bob-s1")).json.code).toBe("on-behalf-of-required");
    expect(await stopS(c, c.old, "bob-s1", "interrupt", "x", "ann")).toStrictEqual({ status: 403, json: { error: "forbidden", code: "forbidden" } });
    expect(await stopMsgs(c)).toStrictEqual([]);
    // svc for ann (owner of the goal of the held step).
    const forAnn = await stopS(c, c.svc, "bob-s1", "end", "wrong turn", "ann");
    expect(forAnn.status, JSON.stringify(forAnn.json)).toBe(200);
    expect(forAnn.json.online).toBe(true);
    const [m] = await stopMsgs(c);
    expect(m.id).toBe(forAnn.json.message);
    expect(m.toSid).toBe("");
    expect(m.text).toBe("MESH: @ann asks to end session bwork: wrong turn (via svc)");
    expect(m.data).toStrictEqual({ sid: "bob-s1", mode: "end", reason: "wrong turn", by: "ann", via: "svc" });
    const [ev] = await events(c, "session.stop_requested");
    expect([ev.user, ev.sid]).toStrictEqual(["ann", "bob-s1"]);
    expect(ev.payload).toStrictEqual({ machine: c.bob.machine, mode: "end", reason: "wrong turn", step: `${G}.b`, via: "svc" });
    for (const who of ["apu", "root", "bob"]) {
      const r = await stopS(c, c.k.tok[who] as string, "bob-s1");
      expect(r.status, `${who}: ${JSON.stringify(r.json)}`).toBe(200);
    }
    // The step the session holds is not changed.
    expect((await c.k.step(`${G}.b`)).state).toBe("claimed");
  });

  it("test_AC11_checks_in_order", async () => {
    c = await cast();
    await held(c, true);
    const t = c.k.tok.bob as string;
    expect(await stopS(c, t, "nope-sid")).toStrictEqual({ status: 404, json: { error: "no session nope-sid", code: "session-unknown" } });
    // Prefixes are not resolved: the route takes the exact sid.
    expect((await stopS(c, t, "bob-")).json.code).toBe("session-unknown");
    c.bob.facts.sessions = [
      idle(c, "bob-s1", { name: "bwork" }),
      idle(c, "bob-run", { kind: "print" }),
      idle(c, "bob-oc", { agent: "opencode" }),
      idle(c, "bob-old", { state: "ended", endedAt: c.k.w.clock }),
    ];
    await c.k.sync(c.bob);
    expect(await stopS(c, t, "bob-run")).toStrictEqual({ status: 409, json: { error: "bob-run is a headless run; stop it with mesh stop <step>", code: "session-is-run" } });
    expect((await stopS(c, t, "bob-old")).json.code).toBe("session-ended");
    expect((await stopS(c, t, "bob-oc")).json.code).toBe("stop-unsupported");
    // A body that is not a stop.
    expect((await stopS(c, t, "bob-s1", "kill")).status).toBe(400);
    expect(await stopMsgs(c)).toStrictEqual([]);
  });
});

describe("AC-12 consent facts on sync", () => {
  it("test_AC12_consent_changed_and_downgrade", async () => {
    c = await cast();
    const consent = async () => (await events(c!, "machine.consent_changed")).filter((e) => e.payload.machine === c!.bob.machine);
    expect(await consent()).toStrictEqual([]);
    c.bob.facts.remoteStop = true;
    await c.k.sync(c.bob);
    const evs = await consent();
    expect(evs).toHaveLength(1);
    expect(evs[0].user).toBe("bob");
    expect(evs[0].payload).toStrictEqual({ machine: c.bob.machine, remoteStop: true, teamOffers: false });
    await c.k.sync(c.bob);
    expect(await consent()).toHaveLength(1);
    // An older daemon: machine facts without the three fields.
    const G = await held(c, true);
    for (const f of ["remoteStop", "teamOffers", "runStop"] as const) delete c.bob.facts[f];
    await c.k.sync(c.bob);
    expect(await consent()).toHaveLength(2);
    expect((await consent())[1].payload).toStrictEqual({ machine: c.bob.machine, remoteStop: false, teamOffers: false });
    expect((await stopS(c, c.k.tok.bob as string, "bob-s1")).json.code).toBe("stop-refused");
    // A run on the downgraded machine cannot be stopped.
    const r = await c.k.call("ann", "POST", `/v1/steps/${G}.a/assign`, { to: c.bob.machine });
    expect(r.status).toBe(200);
    expect((await c.k.w.call(c.bob.token, "POST", `/v1/steps/${G}.a/accept`, {})).status).toBe(200);
    expect((await c.k.call("ann", "POST", `/v1/steps/${G}.a/stop-run`, { reason: "x" })).json.code).toBe("run-stop-unsupported");
    // A sync without machine facts keeps what is stored (no event).
    await c.k.w.call(c.bob.token, "POST", "/v1/sync", { events: [], counts: {}, sessions: [] });
    expect(await consent()).toHaveLength(2);
  });
});
