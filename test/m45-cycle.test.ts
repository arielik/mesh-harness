// M4.5 end to end, in process: the sdd-split template with three people. Spec ⇄ cold review (a
// verdict reopens the spec), an R2 gate decided by a person, reconcile on the plans, blind sides
// enforced on claims and context, a verify failure routed by bucket to the developer (the downstream
// combine re-runs), a diff review, an R3 gate, and records with verdicts, criteria and separation.
// Then: parking (cap, infra), resume, and the Solo blind rule.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parse } from "yaml";
import { BUILTIN_PRESETS, instantiate } from "../src/core/index.ts";
import { buildHubConfig, startHub } from "../src/hub/index.ts";
import { HubStore } from "../src/store/index.ts";
import { World, type Json, type Person } from "./helpers/world.ts";

let w: World;
let alice: Person;
let bob: Person;
let carol: Person;
beforeEach(async () => {
  w = new World();
  await w.start(["alice", "bob", "carol"]);
  alice = await w.person("alice", "frr");
  bob = await w.person("bob", "frr");
  carol = await w.person("carol", "frr");
  w.hook(alice, "SessionStart", 100, { model: "claude-opus-5-5" });
  w.hook(bob, "SessionStart", 200, { model: "claude-sonnet-5-5" });
  w.hook(carol, "SessionStart", 300, { model: "claude-haiku-5-5" });
});
afterEach(() => w.stop());

const ACS = [
  { id: "AC-01", text: "v6 next hops are programmed", surface: "OVS lane", fails_when: "no flow for the v6 prefix" },
  { id: "AC-02", text: "ECMP across both uplinks", surface: "OVS lane", fails_when: "one bucket only" },
];
const split = BUILTIN_PRESETS.find((p) => p.name === "sdd-split");
const front = (text: string) => parse(text.split("---\n")[1] ?? "") as Json;

async function newGoal(): Promise<string> {
  const g = await w.api(alice, "POST", "/v1/goals", { title: "IPv6 underlay", primaryRepo: "frr", refs: { spec: "771" } });
  const plan = instantiate(split as NonNullable<typeof split>, { repo: "frr", goal: g.json.id, acs: ACS });
  const p = await w.api(alice, "POST", `/v1/goals/${g.json.id}/plan`, { ...plan, approve: true });
  expect(p.status, JSON.stringify(p.json)).toBe(201);
  return g.json.id as string;
}

const claim = (p: Person, pid: number, G: string, s: string) => w.tool(p, pid, "mesh_claim", { step: `${G}.${s}` });
const done = (p: Person, pid: number, args: Record<string, unknown>) => w.tool(p, pid, "mesh_done", { summary: "ok", ...args });

describe("M4.5: the sdd-split cycle", () => {
  it("runs spec → review → R2 → blind build → routed fix → diff review → R3", async () => {
    const G = await newGoal();
    const step = async (s: string) => (await w.api(alice, "GET", `/v1/steps/${G}.${s}`)).json.context.step as Json;

    // Spec, then a cold review that asks for changes: the spec is reopened, the review waits.
    expect((await claim(alice, 100, G, "spec")).text).toContain("Acceptance criteria:\n- AC-01: v6 next hops are programmed");
    await done(alice, 100, { acs_addressed: ["AC-01", "AC-02"], artifacts: ["specs/771.md"] });
    expect((await claim(alice, 100, G, "spec-review")).text).toMatch(/blind to .*spec.*(alice|this session) worked on/);
    const rv = await claim(bob, 200, G, "spec-review");
    expect(rv.text).toContain("verdict (approved | changes_requested | blocked");
    expect(rv.text).toContain("(hidden: this step is blind to it)");
    expect((await done(bob, 200, { verdict: "changes_requested", findings: { new: 2, repeat: 0, regression: 0 }, blockers: 1 })).text).toContain("Reopened for fixing");
    expect((await step("spec")).state).toBe("ready");
    expect((await step("spec-review")).state).toBe("blocked");
    await claim(alice, 100, G, "spec");
    await done(alice, 100, { acs_addressed: ["AC-01", "AC-02"] });
    await claim(bob, 200, G, "spec-review");
    await done(bob, 200, { verdict: "approved", findings: { new: 0, repeat: 0, regression: 1 }, blockers: 0 });

    // R2 is a person's decision.
    expect((await claim(bob, 200, G, "r2")).text).toMatch(/is a gate: a person decides it/);
    expect((await w.api(alice, "GET", "/v1/attention")).json.attention.map((a: Json) => a.text)).toEqual(expect.arrayContaining([expect.stringContaining(`Gate R2 for ${G}`)]));
    expect((await w.api(bob, "POST", `/v1/steps/${G}.r2/approve`, {})).status).toBe(403);
    const r2 = await w.api(alice, "POST", `/v1/steps/${G}.r2/approve`, { comment: "spec is good", rule: "owner" });
    expect(r2.json.nowReady.sort()).toEqual([`${G}.impl-plan`, `${G}.test-plan`]);

    // Plans: reconcile rejects a plan that misses a criterion, once.
    await claim(alice, 100, G, "impl-plan");
    const miss = await done(alice, 100, { acs_addressed: ["AC-01"] });
    expect(miss.isError).toBe(true);
    expect(miss.text).toMatch(/Not accepted: reconcile: .*AC-02.*You still hold/s);
    expect(w.session(alice, 100).step).toBe(`${G}.impl-plan`);
    await done(alice, 100, { acs_addressed: ["AC-01", "AC-02"] });
    expect((await claim(alice, 100, G, "test-plan")).text).toMatch(/blind to .*impl-plan.*(alice|this session) worked on/);
    await claim(bob, 200, G, "test-plan");
    await done(bob, 200, { acs_addressed: ["AC-01", "AC-02"] });

    // Build: each side by someone who never saw the other.
    expect((await claim(bob, 200, G, "develop")).text).toMatch(/blind to .*test-plan.*(bob|this session) worked on/);
    const dv = await claim(alice, 100, G, "develop");
    expect(dv.text).toContain("Blind: you must not read the work of test-plan, write-tests");
    await done(alice, 100, { acs_addressed: ["AC-01", "AC-02"], branch: "impl/771" });
    expect((await claim(alice, 100, G, "write-tests")).isError).toBe(true);
    await claim(bob, 200, G, "write-tests");
    await done(bob, 200, { acs_addressed: ["AC-01", "AC-02"], branch: "test/771" });
    await claim(carol, 300, G, "combine");
    await done(carol, 300, {});

    // Verify fails AC-02 with an impl-bug: the developer gets the bucket and assertion only; the
    // combine downstream of the fix runs again.
    await claim(bob, 200, G, "verify");
    const v1 = await done(bob, 200, { verdict: "fail", acs: { "AC-01": "met", "AC-02": "not_met" }, failures: [{ ac: "AC-02", bucket: "impl-bug", assertion: "expected 2 ECMP buckets, got 1" }], summary: "the developer used a single bucket in flow_mod.rs line 88" });
    expect(v1.text).toContain(`Reopened for fixing: ${G}.develop`);
    expect((await step("combine")).state).toBe("blocked");
    const fix = await claim(alice, 100, G, "develop");
    expect(fix.text).toContain("impl-bug AC-02: expected 2 ECMP buckets, got 1");
    expect(fix.text).not.toContain("flow_mod.rs");
    await done(alice, 100, { acs_addressed: ["AC-02"] });
    await claim(carol, 300, G, "combine");
    await done(carol, 300, {});
    await claim(bob, 200, G, "verify");
    await done(bob, 200, { verdict: "pass", acs: { "AC-01": "met", "AC-02": "met" } });

    // Diff review: nobody who built either side.
    for (const [p, pid] of [
      [alice, 100],
      [bob, 200],
    ] as const)
      expect((await claim(p, pid, G, "diff-review")).isError).toBe(true);
    await claim(carol, 300, G, "diff-review");
    await done(carol, 300, { verdict: "approved", findings: { new: 1, repeat: 0, regression: 0 }, blockers: 0 });
    const r3 = await w.api(alice, "POST", `/v1/steps/${G}.r3/approve`, { rule: "GATE-1", inputs: { ci: "green" } });
    expect(r3.json.goalDone).toBe(true);

    // Records.
    const rec = (p: Person, s: string) => front(readFileSync(join(p.repoDir, `.mesh/goals/${G}/steps/${s}.md`), "utf8"));
    const verify = rec(bob, "verify");
    expect(verify).toMatchObject({ role: "test-executor", blind: { steps: ["impl-plan"], separated: true } });
    expect(verify.rounds.map((r: Json) => [r.verdict, r.acs, r.failures?.[0]?.bucket ?? null, r.reopen ?? null])).toEqual([
      ["fail", { "AC-01": "met", "AC-02": "not_met" }, "impl-bug", [`${G}.develop`]],
      ["pass", { "AC-01": "met", "AC-02": "met" }, null, null],
    ]);
    expect(rec(alice, "develop")).toMatchObject({ fix_cycles: 1, blind: { steps: ["test-plan", "write-tests", "diff-review"], separated: true }, rounds: [expect.objectContaining({ acs_addressed: ["AC-01", "AC-02"] }), expect.objectContaining({ acs_addressed: ["AC-02"] })] });
    expect(rec(alice, "impl-plan").rounds.map((r: Json) => r.reconcile?.missing ?? null)).toEqual([["AC-02"], null]);
    expect(rec(bob, "spec-review").rounds.map((r: Json) => [r.verdict, r.findings])).toEqual([
      ["changes_requested", { new: 2, repeat: 0, regression: 0 }],
      ["approved", { new: 0, repeat: 0, regression: 1 }],
    ]);
    const files = (await w.api(alice, "GET", `/v1/goals/${G}/files`)).json.files as { path: string; text: string }[];
    const plan = parse(files.find((f) => f.path.endsWith("plan.v1.yaml"))?.text ?? "") as Json;
    expect(plan.acs.map((a: Json) => a.id)).toEqual(["AC-01", "AC-02"]);
    expect(plan.steps.find((s: Json) => s.id === "verify")).toMatchObject({ role: "test-executor", route: { "impl-bug": "develop" }, max_rounds: 3 });
    expect(r3.json.files[0].path).toBe(`.mesh/goals/${G}/goal.yaml`);
    const goal = parse(r3.json.files[0].text) as Json;
    expect(files.filter((f) => /steps\/(r2|r3)\.md$/.test(f.path)).map((f) => front(f.text).rounds[0].gate.by)).toEqual(["alice", "alice"]);
    expect(goal.rollup).toMatchObject({
      buckets: { "impl-bug": 1 },
      acs: { "AC-01": { met: true, first_met: { step: "verify", round: 1 } }, "AC-02": { met: true, first_met: { step: "verify", round: 2 } } },
      gates: [
        { step: "r2", by: "alice", rule: "owner" },
        { step: "r3", by: "alice", rule: "GATE-1" },
      ],
    });
    expect(goal.rollup.people).toEqual(["alice", "bob", "carol"]);
  });

  it("parks at the round cap and on routed infra failures; a person resumes", async () => {
    const G = (await w.api(alice, "POST", "/v1/goals", { title: "t" })).json.id as string;
    await w.api(alice, "POST", `/v1/goals/${G}/plan`, {
      approve: true,
      steps: [
        { id: "build", repo: "frr", kind: "implement", title: "b", brief: "b" },
        { id: "verify", repo: "frr", kind: "verify", title: "v", brief: "v", deps: ["build"], max_rounds: 2, route: { "impl-bug": "build", infra: "park" } },
      ],
    });
    const cycle = async (bucket: string) => {
      await claim(alice, 100, G, "build");
      await done(alice, 100, {});
      await claim(bob, 200, G, "verify");
      return done(bob, 200, { verdict: "fail", failures: [{ bucket }] });
    };
    expect((await cycle("impl-bug")).text).toContain("Reopened");
    const parked = await cycle("impl-bug");
    expect(parked.text).toMatch(/parked: not passed after 2 round\(s\)/);
    const s = (await w.api(alice, "GET", `/v1/steps/${G}.verify`)).json.context.step;
    expect(s).toMatchObject({ state: "parked", parkedReason: expect.stringContaining("max_rounds 2") });
    expect((await claim(bob, 200, G, "verify")).text).toMatch(/is parked/);
    expect((await w.api(alice, "GET", "/v1/attention")).json.attention.map((a: Json) => a.kind)).toContain("parked");
    expect((await w.api(bob, "POST", `/v1/steps/${G}.verify/resume`, {})).status).toBe(403);
    const resumed = await w.api(alice, "POST", `/v1/steps/${G}.verify/resume`, { comment: "flaky lane fixed" });
    expect(resumed.json.state).toBe("ready");

    await claim(bob, 200, G, "verify");
    expect((await done(bob, 200, { verdict: "fail", failures: [{ bucket: "infra" }] })).text).toMatch(/parked: infra: routed to a person/);
  });

  it("Solo: the same person may play both sides, but never from the same session", async () => {
    const config = buildHubConfig({ listen: "127.0.0.1:0", db: ":memory:", blind_guard: "session", auth: { providers: [{ id: "local", kind: "none", user: "dana" }] } }, { baseDir: "/", env: {} });
    const solo = await startHub(config, { store: await HubStore.open(":memory:"), tickMs: 0, now: () => w.clock });
    try {
      const login = await solo.svc.loginDirect("local", { client: "cli", hostname: "dana" });
      const dana = await w.person("dana", "frr", { solo: { hub: solo.url, token: login.token, user: login.user, ...(login.machine ? { machine: login.machine } : {}) } });
      const call = (path: string, body: unknown) => fetch(solo.url + path, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${login.token}` }, body: JSON.stringify(body) });
      const G = ((await (await call("/v1/goals", { title: "t" })).json()) as Json).id as string;
      await call(`/v1/goals/${G}/plan`, { approve: true, steps: [{ id: "dev", repo: "frr", kind: "implement", title: "d", brief: "d", blind: ["tests"] }, { id: "tests", repo: "frr", kind: "test", title: "t", brief: "t" }] });
      w.hook(dana, "SessionStart", 400);
      w.hook(dana, "SessionStart", 401);
      await claim(dana, 400, G, "dev");
      await done(dana, 400, {});
      expect((await claim(dana, 400, G, "tests")).text).toMatch(/this session worked on/);
      expect((await claim(dana, 401, G, "tests")).isError).toBeFalsy();
    } finally {
      await solo.stop();
    }
  });
});

describe("M4.5: forgiving criteria", () => {
  it("drops criterion ids the plan doesn't know instead of failing mesh_done", async () => {
    const G = (await w.api(alice, "POST", "/v1/goals", { title: "t" })).json.id as string;
    await w.api(alice, "POST", `/v1/goals/${G}/plan`, { approve: true, steps: [{ id: "a", repo: "frr", kind: "implement", title: "a", brief: "a" }, { id: "b", repo: "frr", kind: "implement", title: "b", brief: "b" }] });
    await claim(alice, 100, G, "a");
    const r = await done(alice, 100, { acs_addressed: ["world.txt", "AC-01", "a descriptive string"], acs: { "not an id": "met" } });
    expect(r.isError).toBeFalsy();
    const step = (await w.api(alice, "GET", `/v1/steps/${G}.a`)).json.context.step;
    expect(step.state).toBe("done");
    // This plan defines no criteria, so none are kept.
    expect(step.rounds[0].acsAddressed).toBeUndefined();
    expect(step.rounds[0].acs).toBeUndefined();
  });
});
