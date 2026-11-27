// RL-28 goal members: join and leave (AC-01 to AC-04), the creator is a member (AC-05), no other
// write changes membership (AC-06), `members`, `planPending` and the `member` filter on the goal
// reads (AC-07), the live goal counts (AC-08), the feature, scope and copy table (AC-09) and the CLI
// (AC-16). Written from docs/specs/RL-28.md. People: ann (member), bob (member, approver); services
// svc (with goals:join) and svc-read (without it).

import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { dispatch } from "../src/cli/commands.ts";
import type { CliEnv } from "../src/cli/context.ts";
import { meshCommands } from "../src/cli/mesh-commands.ts";
import { HUB_API, HUB_FEATURES, resolvePaths, SERVICE_SCOPES, StepState, type Step } from "../src/protocol/index.ts";
import { TABLES as COPY_TABLES } from "../src/store/hub-copy.ts";
import { copyHubToPostgres, HubStore } from "../src/store/index.ts";
import { Ak, NOW, REPO } from "./helpers/attention-kit.ts";
import { PG_URL, PgFixture } from "./helpers/pg.ts";
import type { Json } from "./helpers/world.ts";

let k: Ak;
const dirs: string[] = [];
const pgdb = new PgFixture();
afterEach(async () => {
  await k?.stop();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  await pgdb.cleanup();
});
afterAll(() => pgdb.end());

const SOLO = 'description: One step\nsteps:\n  - { id: run, kind: implement, repo: "{repo}", title: Run, brief: run }\n';
const snap = (text: string) => ({ name: "solo", text, sha256: createHash("sha256").update(text, "utf8").digest("hex") });

/** The cast: bob is an approver too; `svc` has goals:join, `reader` (svc-read) has not. */
async function start(): Promise<Ak> {
  k = await Ak.start(NOW, { approvers: ["bob"] });
  k.svc = await k.w.hub.svc.serviceToken("svc", ["goals:read", "goals:write", "goals:decide", "goals:join", "live:read"]);
  k.reader = await k.w.hub.svc.serviceToken("svc-read", ["goals:read", "goals:write", "goals:decide", "live:read"]);
  return k;
}
const join_ = (who: string, G: string) => k.call(who, "POST", `/v1/goals/${G}/join`, {});
const leave = (who: string, G: string) => k.call(who, "POST", `/v1/goals/${G}/leave`, {});
const members = async (G: string, who = "ann"): Promise<string[]> => {
  const r = await k.call(who, "GET", `/v1/goals/${G}`);
  expect(r.status, JSON.stringify(r.json)).toBe(200);
  return r.json.members;
};
const ofGoal = async (type: string, G: string): Promise<Json[]> => (await k.store.events(0, 100_000)).filter((e) => e.type === type && e.goal === G);
const goals = async (who: string, query = "", token?: string, as?: string): Promise<Json[]> => {
  const r = token ? await k.as(as, "GET", `/v1/goals${query}`, undefined, token) : await k.call(who, "GET", `/v1/goals${query}`);
  expect(r.status, JSON.stringify(r.json)).toBe(200);
  return r.json.goals;
};

describe("RL-28 AC-01 AC-02 AC-03 join and leave", () => {
  it("test_AC01_join", async () => {
    await start();
    const G1 = await k.goal("bob", [], "g1");
    const r = await join_("ann", G1);
    expect(r).toStrictEqual({ status: 200, json: { goal: G1, members: ["ann", "bob"], joined: true, changed: true } });
    const ev = (await ofGoal("goal.joined", G1)).filter((e) => e.user === "ann");
    expect(ev).toHaveLength(1);
    expect(ev[0].payload).toStrictEqual({});
    const again = await join_("ann", G1);
    expect(again).toStrictEqual({ status: 200, json: { goal: G1, members: ["ann", "bob"], joined: true, changed: false } });
    expect((await ofGoal("goal.joined", G1)).filter((e) => e.user === "ann")).toHaveLength(1);
    const tl = await k.call("ann", "GET", `/v1/goals/${G1}/timeline`);
    expect(tl.json.timeline.filter((e: Json) => e.type === "goal.joined" && e.user === "ann").map((e: Json) => e.text)).toStrictEqual([`joined ${G1}`]);
  });

  it("test_AC02_leave", async () => {
    await start();
    const G1 = await k.goal("bob", [], "g1");
    expect((await join_("ann", G1)).status).toBe(200);
    const r = await leave("ann", G1);
    expect(r).toStrictEqual({ status: 200, json: { goal: G1, members: ["bob"], joined: false, changed: true } });
    expect((await ofGoal("goal.left", G1)).map((e) => [e.user, e.payload])).toStrictEqual([["ann", {}]]);
    expect(await leave("ann", G1)).toStrictEqual({ status: 200, json: { goal: G1, members: ["bob"], joined: false, changed: false } });
    expect(await ofGoal("goal.left", G1)).toHaveLength(1);
    const tl = await k.call("ann", "GET", `/v1/goals/${G1}/timeline`);
    expect(tl.json.timeline.filter((e: Json) => e.type === "goal.left").map((e: Json) => e.text)).toStrictEqual([`left ${G1}`]);
    // The owner may leave like anyone.
    expect((await leave("bob", G1)).json).toStrictEqual({ goal: G1, members: [], joined: false, changed: true });
  });

  it("test_AC03_states", async () => {
    await start();
    const D = await k.goal("bob", [], "dropped");
    expect((await k.call("bob", "POST", `/v1/goals/${D}/drop`, {})).status).toBe(200);
    const before = (await k.store.events(0, 100_000)).length;
    const r = await join_("ann", D);
    expect([r.status, r.json.code]).toStrictEqual([409, "goal-closed"]);
    expect((await k.store.events(0, 100_000)).length).toBe(before);
    expect(await members(D)).toStrictEqual(["bob"]);
    // A leave is accepted in every state, dropped included.
    expect(await leave("bob", D)).toStrictEqual({ status: 200, json: { goal: D, members: [], joined: false, changed: true } });
    const F = await k.goal("bob", [{ id: "a" }], "done");
    await k.patchGoal(F, { state: "done" });
    expect((await join_("ann", F)).json).toStrictEqual({ goal: F, members: ["ann", "bob"], joined: true, changed: true });
    // An unknown goal.
    const u = await join_("ann", "G999");
    expect([u.status, u.json.code]).toStrictEqual([404, "goal-unknown"]);
    const ul = await leave("ann", "G999");
    expect([ul.status, ul.json.code]).toStrictEqual([404, "goal-unknown"]);
  });
});

describe("RL-28 AC-04 act-for", () => {
  it("test_AC04_service_for_person", async () => {
    await start();
    const G = await k.goal("ann", [], "g");
    const r = await k.as("bob", "POST", `/v1/goals/${G}/join`, {});
    expect(r).toStrictEqual({ status: 200, json: { goal: G, members: ["ann", "bob"], joined: true, changed: true } });
    const [ev] = (await ofGoal("goal.joined", G)).filter((e) => e.user === "bob");
    expect([ev.user, ev.payload]).toStrictEqual(["bob", { via: "svc" }]);
    const before = (await k.store.events(0, 100_000)).length;
    for (const verb of ["join", "leave"]) {
      const no = await k.as(undefined, "POST", `/v1/goals/${G}/${verb}`, {});
      expect([no.status, no.json.code], verb).toStrictEqual([400, "on-behalf-of-required"]);
      const ro = await k.as("bob", "POST", `/v1/goals/${G}/${verb}`, {}, k.reader);
      expect(ro, verb).toStrictEqual({ status: 403, json: { error: "forbidden", code: "forbidden" } });
    }
    expect((await k.store.events(0, 100_000)).length).toBe(before);
    const left = await k.as("bob", "POST", `/v1/goals/${G}/leave`, {});
    expect(left.json).toStrictEqual({ goal: G, members: ["ann"], joined: false, changed: true });
    const [lv] = await ofGoal("goal.left", G);
    expect([lv.user, lv.payload]).toStrictEqual(["bob", { via: "svc" }]);
    // A person joins only for themselves: the body takes no user.
    const other = await k.call("ann", "POST", `/v1/goals/${G}/join`, { user: "bob" });
    expect(other.status).toBe(400);
    expect(await members(G)).toStrictEqual(["ann"]);
  });

  it("test_AC04_idempotency_key", async () => {
    await start();
    const G = await k.goal("ann", [], "g");
    const key = { "idempotency-key": "join-1" };
    const a = await k.as("bob", "POST", `/v1/goals/${G}/join`, {}, k.svc, key);
    const b = await k.as("bob", "POST", `/v1/goals/${G}/join`, {}, k.svc, key);
    expect(a.json.changed).toBe(true);
    expect(b).toStrictEqual(a);
  });
});

describe("RL-28 AC-05 AC-06 the creator is a member; nothing else changes membership", () => {
  it("test_AC05_creator", async () => {
    await start();
    const G2 = await k.goal("ann", [], "g2");
    expect(await members(G2)).toStrictEqual(["ann"]);
    const evs = (await k.store.events(0, 100_000)).filter((e) => e.goal === G2 && (e.type === "goal.created" || e.type === "goal.joined"));
    expect(evs.map((e) => [e.type, e.user, e.payload.via])).toStrictEqual([
      ["goal.created", "ann", undefined],
      ["goal.joined", "ann", undefined],
    ]);
    // A service creates as itself: no member.
    const own = await k.w.call(k.svc, "POST", "/v1/goals", { title: "svc goal" });
    expect(own.status, JSON.stringify(own.json)).toBe(201);
    expect(own.json.ownerId).toBe("svc");
    expect(await members(own.json.id)).toStrictEqual([]);
    expect(await ofGoal("goal.joined", own.json.id)).toStrictEqual([]);
    // A service creates for ann: ann is a member, the event names the service.
    const forAnn = await k.as("ann", "POST", "/v1/goals", { title: "for ann" });
    expect(forAnn.status).toBe(201);
    expect(await members(forAnn.json.id)).toStrictEqual(["ann"]);
    expect((await ofGoal("goal.joined", forAnn.json.id)).map((e) => [e.user, e.payload])).toStrictEqual([["ann", { via: "svc" }]]);
    // From a preset for bob: bob is a member, joined after goal.created.
    const fp = await k.as("bob", "POST", "/v1/goals/from-preset", { preset: snap(SOLO), params: { repo: REPO } });
    expect(fp.status, JSON.stringify(fp.json)).toBe(201);
    const F = fp.json.goal.id as string;
    expect(fp.json.members).toStrictEqual(["bob"]);
    const types = (await k.store.events(0, 100_000)).filter((e) => e.goal === F).map((e) => e.type);
    expect(types.indexOf("goal.joined")).toBeGreaterThan(types.indexOf("goal.created"));
    expect((await ofGoal("goal.joined", F)).map((e) => [e.user, e.payload])).toStrictEqual([["bob", { via: "svc" }]]);
    // From a preset by the service as itself: no member.
    const fs = await k.w.call(k.svc, "POST", "/v1/goals/from-preset", { preset: snap(SOLO), params: { repo: REPO } });
    expect(fs.status, JSON.stringify(fs.json)).toBe(201);
    expect(fs.json.members).toStrictEqual([]);
  });

  it("test_AC05_pulse_goal", async () => {
    await start();
    const p = await k.call("ann", "POST", "/v1/pulses", { preset: snap(SOLO), params: { repo: REPO }, when: { every: "1d", at: NOW + 3_600_000 } });
    expect(p.status, JSON.stringify(p.json)).toBe(201);
    const f = await k.call("ann", "POST", `/v1/pulses/${p.json.id}/fire`, {});
    expect(f.status, JSON.stringify(f.json)).toBe(201);
    const G = f.json.slot.goal as string;
    expect((await k.store.getGoal(G))?.refs?.pulse).toBe(p.json.id);
    expect(await members(G)).toStrictEqual([]);
    expect(await ofGoal("goal.joined", G)).toStrictEqual([]);
  });

  it("test_AC06_claim_gate_approval", async () => {
    await start();
    const G2 = await k.goal("ann", [], "g2");
    expect((await k.plan("ann", G2, [{ id: "a" }, { id: "g", kind: "gate", gate: "R1", deps: ["a"] }], false)).status).toBe(201);
    expect((await k.call("bob", "POST", `/v1/goals/${G2}/approve`, {})).status).toBe(200);
    const c = await k.call("bob", "POST", `/v1/steps/${G2}.a/claim`, {});
    expect(c.status, JSON.stringify(c.json)).toBe(200);
    const d = await k.call("bob", "POST", `/v1/steps/${G2}.a/done`, { summary: "ok" });
    expect(d.status, JSON.stringify(d.json)).toBe(200);
    expect((await k.step(`${G2}.g`)).state).toBe("ready");
    const g = await k.call("bob", "POST", `/v1/steps/${G2}.g/approve`, {});
    expect(g.status, JSON.stringify(g.json)).toBe(200);
    expect(await members(G2)).toStrictEqual(["ann"]);
    expect((await ofGoal("goal.joined", G2)).map((e) => e.user)).toStrictEqual(["ann"]);
  });
});

describe("RL-28 AC-07 the goal list and detail", () => {
  it("test_AC07_members_and_filter", async () => {
    await start();
    const A = await k.goal("ann", [], "ann's");
    const B = await k.goal("bob", [], "bob's");
    const AB = await k.goal("ann", [], "both");
    expect((await join_("bob", AB)).status).toBe(200);
    expect((await k.plan("ann", A, [{ id: "a" }], false)).status).toBe(201);
    const all = await goals("ann");
    expect(all.map((g) => [g.id, g.members, g.planPending])).toStrictEqual([
      [A, ["ann"], true],
      [B, ["bob"], false],
      [AB, ["ann", "bob"], false],
    ]);
    expect((await goals("ann", "?member=bob")).map((g) => g.id)).toStrictEqual([B, AB]);
    expect((await goals("ann", "?member=me")).map((g) => g.id)).toStrictEqual([A, AB]);
    expect((await goals("bob", "?member=me")).map((g) => g.id)).toStrictEqual([B, AB]);
    expect((await goals("", "?member=me", k.svc, "bob")).map((g) => g.id)).toStrictEqual([B, AB]);
    expect(await goals("", "?member=me", k.svc)).toStrictEqual([]);
    expect(await k.call("ann", "GET", "/v1/goals?member=nobody")).toStrictEqual({ status: 200, json: { goals: [] } });
    expect(await members(B)).toStrictEqual(["bob"]);
    // Topic filter and member filter together.
    expect((await goals("ann", "?member=bob&topic=all")).map((g) => g.id)).toStrictEqual([B, AB]);
  });
});

describe("RL-28 AC-08 live", () => {
  it("test_AC08_counts", async () => {
    await start();
    const G = await k.goal("ann", [{ id: "a" }, { id: "b" }, { id: "c" }, { id: "d" }, { id: "e" }, { id: "f" }, { id: "deb", kind: "review" }], "live");
    // A findings review (a test seam, as the RL-22 attention world does).
    await k.patch(`${G}.deb`, { policy: { mode: "debrief" } });
    await k.patch(`${G}.a`, { state: "done", outcome: "done" });
    await k.patch(`${G}.c`, { state: "parked", parkedReason: "round cap (3)", parkedAt: k.w.clock });
    await k.patch(`${G}.d`, { state: "failed", outcome: "fail" });
    await k.patch(`${G}.e`, { state: "blocked" });
    await k.patch(`${G}.f`, { state: "dropped" });
    expect((await k.step(`${G}.b`)).state).toBe("ready");
    expect((await k.step(`${G}.deb`)).state).toBe("ready");
    const before = await live(G);
    expect(before.planPending).toBe(false);
    // A pending amendment.
    expect((await k.plan("ann", G, [{ id: "a" }, { id: "b" }, { id: "z" }], false)).status).toBe(201);
    expect((await k.store.getGoal(G))?.state).toBe("in_progress");
    const g = await live(G);
    const zero = Object.fromEntries(StepState.options.map((s) => [s, 0]));
    expect(g.stepStates).toStrictEqual({ ...zero, done: 2, ready: 2, parked: 1, failed: 1, blocked: 1, dropped: 1 });
    expect(Object.keys(g.stepStates).sort()).toStrictEqual([...StepState.options].sort());
    expect(g.review).toBe(1);
    expect(g.planPending).toBe(true);
    // done, total and holders keep their 0.1.44 meaning (dropped steps left out).
    const steps = (await k.store.listSteps({ goal: G })).filter((s: Step) => s.state !== "dropped");
    expect([g.done, g.total, g.holders]).toStrictEqual([steps.filter((s) => s.state === "done").length, steps.length, []]);
    expect([g.done, g.total]).toStrictEqual([2, 7]);
    // A claimed or paused review counts; a done one does not.
    await k.hold(`${G}.deb`, "bob", undefined);
    expect((await live(G)).review).toBe(1);
    await k.patch(`${G}.deb`, { state: "paused" });
    expect((await live(G)).review).toBe(1);
    await k.patch(`${G}.deb`, { state: "done" });
    expect((await live(G)).review).toBe(0);
  });

  async function live(G: string): Promise<Json> {
    const r = await k.call("ann", "GET", "/v1/live");
    expect(r.status, JSON.stringify(r.json)).toBe(200);
    return r.json.goals.find((g: Json) => g.id === G);
  }
});

describe("RL-28 AC-09 feature, scope, routes, copy", () => {
  it("test_AC09_registry", async () => {
    await start();
    expect(HUB_FEATURES).toContain("goal-members");
    expect((await k.w.call(undefined as never, "GET", "/healthz")).json.features).toContain("goal-members");
    expect(SERVICE_SCOPES).toContain("goals:join");
    for (const verb of ["join", "leave"]) {
      const row = HUB_API.find((r) => r.method === "POST" && r.path === `/v1/goals/:id/${verb}`);
      expect(row, verb).toMatchObject({ rule: "member", scope: "goals:join", onBehalfOf: true, onBehalfOfRequired: true });
    }
    expect(HUB_API.find((r) => r.method === "GET" && r.path === "/v1/goals")).toMatchObject({ onBehalfOf: true, onBehalfOfOptional: true });
    expect(COPY_TABLES.map((t) => t.name)).toContain("goal_member");
  });

  it.skipIf(!PG_URL)("test_AC09_migrate_copies_goal_members", async () => {
    const d = mkdtempSync(join(tmpdir(), "mesh-rl28-"));
    dirs.push(d);
    const file = join(d, "hub.db");
    const s = await HubStore.open(file);
    await s.addGoalMember("G1", "ann", NOW);
    await s.addGoalMember("G1", "bob", NOW + 1);
    await s.close();
    const url = await pgdb.fresh();
    const report = await copyHubToPostgres(file, url);
    expect(report.tables.find((x) => x.name === "goal_member")?.rows).toBe(2);
    const p = await HubStore.open(url);
    try {
      expect(await p.goalMembers("G1")).toStrictEqual(["ann", "bob"]);
    } finally {
      await p.close();
    }
  });
});

describe("RL-28 AC-16 CLI", () => {
  /** Run `mesh …` as `who` (a credentials file with their device token). */
  async function cli(who: string, args: string[]): Promise<{ code: number; out: string; err: string }> {
    const dir = mkdtempSync(join(tmpdir(), "mesh-rl28-cli-"));
    dirs.push(dir);
    writeFileSync(join(dir, "credentials.json"), JSON.stringify({ hub: k.w.hub.url, token: k.tok[who], user: { id: who, name: who, roles: ["member"] }, machine: k.m[who]?.machine }));
    const out: string[] = [];
    const err: string[] = [];
    const c: CliEnv = {
      io: { out: (t) => out.push(t), err: (t) => err.push(t) },
      paths: resolvePaths({ MESH_CONFIG_DIR: dir, MESH_STATE_DIR: join(dir, "state"), CLAUDE_CONFIG_DIR: join(dir, "claude") }, dir),
      env: {},
      cwd: dir,
      self: ["mesh"],
      version: "0.0.0",
    };
    const wr = vi.spyOn(process.stdout, "write").mockImplementation((() => true) as typeof process.stdout.write);
    let code: number;
    try {
      code = await dispatch(args, meshCommands(c), "0.0.0", (t) => out.push(t));
    } catch (e) {
      err.push(`mesh: ${e instanceof Error ? e.message : String(e)}`);
      code = 1;
    } finally {
      wr.mockRestore();
    }
    return { code, out: out.join("\n"), err: err.join("\n") };
  }

  it("test_AC16_join_leave_ls_show", async () => {
    await start();
    const G1 = await k.goal("bob", [], "first");
    const G2 = await k.goal("ann", [], "second");
    const j = await cli("ann", ["goal", "join", G1]);
    expect(j.code, j.err).toBe(0);
    expect(j.out).toBe(`Joined ${G1} (members: ann, bob)`);
    expect((await cli("ann", ["goal", "join", G1])).out).toBe(`Already a member of ${G1}`);
    const mine = await cli("ann", ["goal", "ls", "--mine"]);
    expect(mine.code, mine.err).toBe(0);
    expect(mine.out.split("\n")).toStrictEqual([
      `${G1.padEnd(5)} ${"backlog".padEnd(18)} @${"bob".padEnd(12)} +2 first`,
      `${G2.padEnd(5)} ${"backlog".padEnd(18)} @${"ann".padEnd(12)} +1 second`,
    ]);
    const bobs = await cli("ann", ["goal", "ls", "--member", "bob"]);
    expect(bobs.out.split("\n").map((l) => l.split(" ")[0])).toStrictEqual([G1]);
    expect((await cli("ann", ["goal", "ls", "--member", "nobody"])).out).toBe("No goals match.");
    const show = await cli("ann", ["goal", "show", G1]);
    expect(show.code, show.err).toBe(0);
    expect(show.out.split("\n")).toContain("members: ann, bob");
    const l = await cli("ann", ["goal", "leave", G1]);
    expect(l.out).toBe(`Left ${G1}`);
    expect((await cli("ann", ["goal", "leave", G1])).out).toBe(`Not a member of ${G1}`);
    expect((await cli("ann", ["goal", "ls", "--mine"])).out.split("\n").map((x) => x.split(" ")[0])).toStrictEqual([G2]);
    // The usage text lists the new forms.
    const help = await cli("ann", ["goal"]);
    expect(help.err).toContain("mesh goal join <G>");
    expect(help.err).toContain("--mine | --member <user>");
    expect(help.err).toContain("--state open|done|dropped|all");
  });
});
