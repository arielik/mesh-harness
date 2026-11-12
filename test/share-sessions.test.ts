// Q5 opt-in: a machine with shareSessions "all" reports sessions without a step to the hub as
// metadata only; the default keeps them local (the hub sees counts).

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { World, type Person } from "./helpers/world.ts";

type Json = any; // eslint-disable-line @typescript-eslint/no-explicit-any

let w: World;
let alice: Person;
let bob: Person;

beforeEach(async () => {
  w = new World();
  await w.start(["alice", "bob"]);
  alice = await w.person("alice", "frr-dplane-ovs", { shareSessions: "all" });
  bob = await w.person("bob", "vpc-node-agent");
});
afterEach(() => w.stop());

const sessionsOf = (live: Json, user: string): Json[] => live.people.find((p: Json) => p.user.id === user).sessions;

describe("sharing sessions without a step", () => {
  it("reports opted-in sessions as metadata; others stay local", async () => {
    w.hook(alice, "SessionStart", 101);
    await w.turn(alice, 101, "secret answer text");
    w.hook(bob, "SessionStart", 201);
    await w.turn(bob, 201, "bob's text");
    await w.flush();

    const live = (await w.api(alice, "GET", "/v1/live")).json;
    const a = sessionsOf(live, "alice");
    expect(a).toHaveLength(1);
    expect(a[0]).toMatchObject({ sid: w.session(alice, 101).sid, repo: "frr-dplane-ovs", state: "idle" });
    expect(a[0].step).toBeUndefined();
    expect(sessionsOf(live, "bob")).toEqual([]);
    expect(live.people.find((p: Json) => p.user.id === "bob").machines[0].counts).toMatchObject({ idle: 1 });
    expect(JSON.stringify(live)).not.toContain("secret answer text");

    // A dashboard backend reads the same rows with a live:read service token.
    const token = await w.hub.svc.serviceToken("dashboard", ["live:read"]);
    const r = await fetch(`${w.hub.url}/v1/live`, { headers: { authorization: `Bearer ${token}` } });
    expect(r.status).toBe(200);
    expect(sessionsOf(await r.json(), "alice").map((s: Json) => s.sid)).toEqual([w.session(alice, 101).sid]);
  });

  it("drops shared rows once the machine stops sharing them", async () => {
    w.hook(alice, "SessionStart", 101);
    await w.turn(alice, 101);
    await w.flush();
    expect(sessionsOf((await w.api(alice, "GET", "/v1/live")).json, "alice")).toHaveLength(1);

    (alice.daemon.config as { shareSessions: string }).shareSessions = "steps";
    await w.flush();
    expect(sessionsOf((await w.api(alice, "GET", "/v1/live")).json, "alice")).toEqual([]);
  });

  it("hides unlisted sessions from the live view but keeps their rows for routing", async () => {
    const g = await w.api(alice, "POST", "/v1/goals", { title: "x" });
    w.hook(alice, "SessionStart", 101);
    w.hook(alice, "SessionStart", 102);
    await w.tool(alice, 102, "mesh_claim", { step: `${g.json.id}.design` });
    await w.flush();
    expect(sessionsOf((await w.api(alice, "GET", "/v1/live")).json, "alice")).toHaveLength(2);

    // A sync that lists only the step holder: the other session leaves the view.
    const holder = w.session(alice, 102);
    expect((await w.api(alice, "POST", "/v1/sync", { sessions: [holder] })).status).toBe(200);
    expect(sessionsOf((await w.api(alice, "GET", "/v1/live")).json, "alice").map((s: Json) => s.sid)).toEqual([holder.sid]);
    expect(await w.hub.svc.store.getSession(w.session(alice, 101).sid)).toBeDefined();

    // Listed again: back in the view.
    await w.flush();
    expect(sessionsOf((await w.api(alice, "GET", "/v1/live")).json, "alice")).toHaveLength(2);
  });
});
