// M4 on the hub: superseded plans (R4), rounds across fix cycles (R3), the design record and the
// goal roll-up (4.9, 4.13), artefact links (4.12), event retention and backup (R6), events feed (4.1).

import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parse } from "yaml";
import { HubStore } from "../src/store/index.ts";
import { World, type Json, type Person } from "./helpers/world.ts";

let w: World;
let alice: Person;
let bob: Person;
beforeEach(async () => {
  w = new World();
  await w.start(["alice", "bob"]);
  alice = await w.person("alice", "frr-dplane-ovs");
  bob = await w.person("bob", "vpc-node-agent");
});
afterEach(() => w.stop());

const front = (text: string) => parse(text.startsWith("---") ? (text.split("---\n")[1] ?? "") : text) as Json;
const steps = [
  { id: "impl", repo: "frr-dplane-ovs", kind: "implement", title: "impl", brief: "b" },
  { id: "verify", repo: "vpc-node-agent", kind: "test", title: "verify", brief: "b", deps: ["impl"] },
];

describe("plans", () => {
  it("marks a pending plan replaced by a new proposal as superseded, not revised", async () => {
    const g = (await w.api(alice, "POST", "/v1/goals", { title: "t", refs: { spec: "771", backlog: "ROW-42" } })).json;
    expect(g.refs).toEqual({ spec: "771", backlog: "ROW-42" });
    await w.api(alice, "POST", `/v1/goals/${g.id}/plan`, { steps });
    await w.api(alice, "POST", `/v1/goals/${g.id}/revise`, { comment: "split it" });
    await w.api(alice, "POST", `/v1/goals/${g.id}/plan`, { steps });
    await w.api(alice, "POST", `/v1/goals/${g.id}/plan`, { steps });
    const plans = (await w.api(alice, "GET", `/v1/goals/${g.id}`)).json.plans.map((p: Json) => p.decision);
    expect(plans).toEqual(["revised", "superseded", "pending"]);
    const files = (await w.api(alice, "GET", `/v1/goals/${g.id}/files`)).json.files as { path: string; text: string }[];
    expect(front(files.find((f) => f.path.endsWith("plan.v2.yaml"))?.text ?? "")).toMatchObject({ schema: "mesh.ledger.v1", record: "plan", decision: "superseded" });
    expect(front(files[0]?.text ?? "")).toMatchObject({ record: "goal", refs: { spec: "771" } });
  });
});

describe("rounds, design record, roll-up", () => {
  it("keeps every round of a step through a fix cycle and totals the goal", async () => {
    const G = (await w.api(alice, "POST", "/v1/goals", { title: "t", primaryRepo: "frr-dplane-ovs" })).json.id as string;
    w.hook(alice, "SessionStart", 100, { model: "claude-opus-5-5" });
    await w.tool(alice, 100, "mesh_claim", { step: `${G}.design` });
    w.clock += 5 * 60_000;
    await w.tool(alice, 100, "mesh_plan", { goal: G, design_ref: "docs/design/x.md", steps });
    await w.api(alice, "POST", `/v1/goals/${G}/approve`, {});
    const files = (await w.api(alice, "GET", `/v1/goals/${G}/files`)).json.files as { path: string; text: string }[];
    const design = front(files.find((f) => f.path.endsWith("steps/design.md"))?.text ?? "");
    expect(design).toMatchObject({ record: "step", kind: "design", outcome: "done", rounds: [expect.objectContaining({ n: 1, minutes: 5, artifacts: [{ path: "docs/design/x.md" }] })] });

    // Round 1 of impl, a failing verify reopens it, round 2, verify passes.
    await w.tool(alice, 100, "mesh_claim", { step: `${G}.impl` });
    w.turn(alice, 100, "impl");
    await w.flush();
    w.clock += 20 * 60_000;
    await w.tool(alice, 100, "mesh_done", { summary: "first cut", model: "claude-opus-5-5", artifacts: ["src/a.ts"] });
    w.hook(bob, "SessionStart", 200, { model: "claude-sonnet-5-5" });
    await w.tool(bob, 200, "mesh_claim", { step: `${G}.verify` });
    w.clock += 10 * 60_000;
    await w.tool(bob, 200, "mesh_done", { summary: "AC-02 fails", outcome: "fail", reopen: ["impl"] });
    await w.tool(alice, 100, "mesh_claim", { step: `${G}.impl` });
    w.clock += 15 * 60_000;
    const d2 = await w.tool(alice, 100, "mesh_done", { summary: "fixed AC-02" });
    expect(d2.text).toContain("is done");
    await w.tool(bob, 200, "mesh_claim", { step: `${G}.verify` });
    w.clock += 5 * 60_000;
    const last = await w.tool(bob, 200, "mesh_done", { summary: "all green" });
    expect(last.text).toContain(`Goal ${G} is done.`);

    const impl = front((await import("node:fs")).readFileSync(join(alice.repoDir, `.mesh/goals/${G}/steps/impl.md`), "utf8"));
    expect(impl.fix_cycles).toBe(1);
    expect(impl.plan_approved).toMatchObject({ by: "alice" });
    expect(impl.rounds.map((r: Json) => [r.n, r.minutes, r.outcome, r.summary])).toEqual([
      [1, 20, "done", "first cut"],
      [2, 15, "done", "fixed AC-02"],
    ]);
    expect(impl.rounds[0].artifacts).toEqual([{ path: "src/a.ts" }]);
    const verify = front((await import("node:fs")).readFileSync(join(bob.repoDir, `.mesh/goals/${G}/steps/verify.md`), "utf8"));
    expect(verify.rounds.map((r: Json) => [r.outcome, r.reopen ?? null])).toEqual([
      ["fail", [`${G}.impl`]],
      ["done", null],
    ]);
    expect(verify.segments[0]).toMatchObject({ user: "bob", model: "claude-sonnet-5-5", model_source: "hook", claude_code: "2.1.318", harness: { hash: "h0" } });

    // The goal file with its roll-up went to the session that finished the goal.
    const goal = front((await import("node:fs")).readFileSync(join(bob.repoDir, `.mesh/goals/${G}/goal.yaml`), "utf8"));
    expect(goal).toMatchObject({ record: "goal", state: "done" });
    expect(goal.rollup).toMatchObject({ steps: 3, done: 3, rounds: 5, fix_cycles: 1, plan_versions: 1, design_rounds: 0, people: ["alice", "bob"], harnesses: ["h0"] });
    expect(goal.rollup.models).toEqual(expect.arrayContaining(["claude-opus-5-5", "claude-sonnet-5-5"]));
    expect(goal.rollup.by_kind.implement).toMatchObject({ steps: 1, rounds: 2, fix_cycles: 1 });
    expect(goal.rollup.lead_time_hours).toBeCloseTo(0.9, 1);
  });
});

describe("events: retention, backup, feed", () => {
  it("prunes old events, backs up the database and serves the feed to a service token", async () => {
    const svc = w.hub.svc;
    await w.api(alice, "POST", "/v1/goals", { title: "old" });
    w.clock += 200 * 86_400_000;
    // (Alice's device token has expired by now; act as her directly.)
    svc.createGoal({ userId: "alice", roles: ["member"], tokenHash: "", tokenKind: "device" }, { title: "new", priority: 3 });
    const before = svc.events(0, 1000).length;
    expect(svc.pruneEvents()).toBeGreaterThan(0);
    expect(svc.events(0, 1000).length).toBeLessThan(before);
    expect(svc.events(0, 1000).length).toBeGreaterThan(1);
    expect(svc.events(0, 1000).every((e) => e.at > w.clock - 180 * 86_400_000)).toBe(true);

    const token = svc.serviceToken("mesh-ai");
    const feed = await fetch(`${w.hub.url}/v1/events?after=0&limit=2`, { headers: { authorization: `Bearer ${token}` } });
    expect(feed.status).toBe(200);
    const body = (await feed.json()) as Json;
    expect(body.events).toHaveLength(2);
    expect((await fetch(`${w.hub.url}/v1/goals`, { headers: { authorization: `Bearer ${token}` } })).status).toBe(403);

    const dir = mkdtempSync(join(tmpdir(), "mesh-backup-"));
    try {
      const file = join(dir, "hub.backup.db");
      w.hubStore.backup(file);
      expect(existsSync(file)).toBe(true);
      const copy = await HubStore.open(file);
      expect(copy.listGoals().map((g) => g.title)).toEqual(["old", "new"]);
      copy.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
