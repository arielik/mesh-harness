// Q5 opt-in: a machine with shareSessions "all" reports sessions without a step to the hub as
// metadata only; the default keeps them local (the hub sees counts).
// MM-1: a third level `me` reports them as metadata that only their owner sees (AC-09, AC-10).

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { DaemonConfig } from "../src/protocol/index.ts";
import { World, type Person } from "./helpers/world.ts";

type Json = any; // eslint-disable-line @typescript-eslint/no-explicit-any

let w: World;
let alice: Person;
let bob: Person;

const sessionsOf = (live: Json, user: string): Json[] => live.people.find((p: Json) => p.user.id === user)?.sessions ?? [];
const machinesOf = (live: Json, user: string): Json[] => live.people.find((p: Json) => p.user.id === user)?.machines ?? [];
const liveAs = async (token: string): Promise<Json> => {
  const r = await fetch(`${w.hub.url}/v1/live`, { headers: { authorization: `Bearer ${token}` } });
  expect(r.status).toBe(200);
  return r.json();
};

describe("sharing sessions without a step", () => {
  beforeEach(async () => {
    w = new World();
    await w.start(["alice", "bob"]);
    alice = await w.person("alice", "frr-dplane-ovs", { shareSessions: "all" });
    bob = await w.person("bob", "vpc-node-agent");
  });
  afterEach(() => w.stop());

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

describe("AC-09 /v1/live hides `me` sessions from everyone but their owner", () => {
  let sBob: string;
  let svc: string;
  beforeEach(async () => {
    w = new World();
    await w.start(["alice", "bob"]);
    alice = await w.person("alice", "alpha", { repoId: "example.org/team/alpha" });
    bob = await w.person("bob", "beta", { shareSessions: "me", repoId: "example.org/team/beta" });
    await w.hook(bob, "SessionStart", 201);
    // First sync: the hub confirms `me`; second: the no-step session goes up as metadata.
    await w.flush();
    await w.flush();
    sBob = w.session(bob, 201).sid;
    svc = await w.hub.svc.serviceToken("dashboard", ["live:read"]);
  });
  afterEach(() => w.stop());

  it("test_AC09_session_reached_hub", async () => {
    const r = await w.api(bob, "GET", "/v1/fleet");
    expect(r.status).toBe(200);
    const sids = r.json.machines.flatMap((m: Json) => m.sessions.map((s: Json) => s.sid));
    expect(sids).toContain(sBob);
  });

  it("test_AC09_alice_does_not_see_bob_me_session", async () => {
    const forAlice = await liveAs(alice.login.token);
    const forBob = await liveAs(bob.login.token);
    // Positive control: the hub has the session and shows it to bob.
    expect(sessionsOf(forBob, "bob").map((s) => s.sid)).toContain(sBob);
    expect(sessionsOf(forAlice, "bob").map((s) => s.sid)).not.toContain(sBob);
    expect(JSON.stringify(forAlice.people.find((p: Json) => p.user.id === "bob")?.sessions ?? [])).not.toContain(sBob);
    const counts = machinesOf(forAlice, "bob")[0]?.counts;
    expect(counts).toEqual(machinesOf(forBob, "bob")[0]?.counts);
    expect(counts?.idle).toBeGreaterThanOrEqual(1);
  });

  it("test_AC09_bob_sees_own_me_session", async () => {
    expect(sessionsOf(await liveAs(bob.login.token), "bob").map((s) => s.sid)).toContain(sBob);
  });

  it("test_AC09_service_token_does_not_see", async () => {
    const live = await liveAs(svc);
    expect(sessionsOf(live, "bob").map((s) => s.sid)).not.toContain(sBob);
    expect(machinesOf(live, "bob")[0]?.counts?.idle).toBeGreaterThanOrEqual(1);
    // Positive control: the owner's view lists it.
    expect(sessionsOf(await liveAs(bob.login.token), "bob").map((s) => s.sid)).toContain(sBob);
  });
});

describe("AC-10 /v1/live regressions", () => {
  afterEach(() => w.stop());

  async function goalWithStep(owner: Person, repo: string): Promise<string> {
    const g = await w.api(owner, "POST", "/v1/goals", { title: "share levels", primaryRepo: repo });
    expect(g.status).toBe(201);
    const id = g.json.id as string;
    const r = await w.api(owner, "POST", `/v1/goals/${id}/plan`, { approve: true, steps: [{ id: "a", repo, kind: "implement", title: "a", brief: "do a" }] });
    expect(r.status).toBe(201);
    return `${id}.a`;
  }

  it.each(["steps", "me", "all"] as DaemonConfig["shareSessions"][])("test_AC10_step_holder_visible_all_levels (%s)", async (level) => {
    w = new World();
    await w.start(["alice", "bob"]);
    alice = await w.person("alice", "alpha", { repoId: "example.org/team/alpha" });
    bob = await w.person("bob", "beta", { shareSessions: level, repoId: "example.org/team/beta" });
    const step = await goalWithStep(bob, "example.org/team/beta");
    await w.hook(bob, "SessionStart", 301);
    expect((await w.tool(bob, 301, "mesh_claim", { step })).isError).toBeFalsy();
    await w.flush();
    await w.flush();
    const sid = w.session(bob, 301).sid;
    const svc = await w.hub.svc.serviceToken("dashboard", ["live:read"]);
    for (const token of [alice.login.token, svc]) {
      const s = sessionsOf(await liveAs(token), "bob").find((x) => x.sid === sid);
      expect(s, `${level} ${token === svc ? "service" : "alice"}`).toBeDefined();
      expect(s.step).toBe(step);
    }
  });

  it("test_AC10_all_shows_nostep_to_others", async () => {
    w = new World();
    await w.start(["alice", "bob"]);
    alice = await w.person("alice", "alpha", { repoId: "example.org/team/alpha" });
    bob = await w.person("bob", "beta", { shareSessions: "all", repoId: "example.org/team/beta" });
    await w.hook(bob, "SessionStart", 302);
    await w.flush();
    await w.flush();
    const sid = w.session(bob, 302).sid;
    const svc = await w.hub.svc.serviceToken("dashboard", ["live:read"]);
    expect(sessionsOf(await liveAs(alice.login.token), "bob").map((s) => s.sid)).toContain(sid);
    expect(sessionsOf(await liveAs(svc), "bob").map((s) => s.sid)).toContain(sid);
  });

  it("test_AC10_unreported_share_owner_only", async () => {
    w = new World();
    await w.start(["alice", "bob"]);
    alice = await w.person("alice", "alpha", { repoId: "example.org/team/alpha" });
    // An older daemon: no `machine` in its sync body.
    const old = await w.login("bob", { hostname: "bob-old" });
    const session = {
      sid: "s-old",
      claudeSessionIds: ["c-old"],
      cwd: "",
      kind: "interactive",
      state: "idle",
      quiet: false,
      startedAt: w.clock - 1000,
      lastEventAt: w.clock,
      turns: 1,
      humanPrompts: 1,
      seenByReconciler: true,
    };
    const r = await w.call(old.token, "POST", "/v1/sync", { events: [], sessions: [session], counts: { idle: 1 } });
    expect(r.status).toBe(200);
    const svc = await w.hub.svc.serviceToken("dashboard", ["live:read"]);
    expect(sessionsOf(await liveAs(old.token), "bob").map((s) => s.sid)).toContain("s-old");
    expect(sessionsOf(await liveAs(alice.login.token), "bob").map((s) => s.sid)).not.toContain("s-old");
    expect(sessionsOf(await liveAs(svc), "bob").map((s) => s.sid)).not.toContain("s-old");
    const fleet = await w.call(old.token, "GET", "/v1/fleet");
    expect(fleet.status).toBe(200);
    const m = fleet.json.machines.find((x: Json) => x.id === old.machine);
    expect(m).toBeDefined();
    expect(m).not.toHaveProperty("share");
  });
});
