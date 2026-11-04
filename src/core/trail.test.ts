import { describe, expect, it } from "vitest";
import type { Goal, Plan, Step } from "../protocol/index.ts";
import { depths, levels, materialize } from "./dag.ts";
import { diffPlans, goalFile, planFile, stepFacts, stepRecord, type FactEvent } from "./trail.ts";

const T0 = Date.UTC(2026, 10, 3, 9, 12);
const M = 60_000;
const step: Step = {
  id: "G17.dplane",
  goal: "G17",
  planVersion: 2,
  kind: "implement",
  repo: "frr-dplane-ovs",
  title: "dplane",
  brief: "program v6",
  deps: ["G17.proto"],
  state: "done",
  outcome: "done",
  summary: "Added v6 underlay next-hop programming.",
  mr: "!88",
  branch: "mesh/g17-dplane",
  fixCycles: 1,
  updatedAt: T0 + 125 * M,
  rounds: [
    { n: 1, user: "ariel", sid: "s1", startedAt: T0, finishedAt: T0 + 40 * M, outcome: "done", summary: "first cut" },
    { n: 2, user: "tom", sid: "s2", startedAt: T0 + 70 * M, finishedAt: T0 + 125 * M, outcome: "done", summary: "Added v6 underlay next-hop programming.", model: "claude-sonnet-5", artifacts: [{ path: "docs/design/g17.md", sha: "abc123" }] },
  ],
};
const ev = (min: number, type: string, extra: Partial<FactEvent> = {}): FactEvent => ({ at: T0 + min * M, type, step: "G17.dplane", user: "ariel", payload: {}, ...extra });

const events: FactEvent[] = [
  ev(0, "step.claimed", { sid: "s1" }),
  ev(0, "session.provenance", { sid: "s1", payload: { claude_code: "2.1.318", harness: { hash: "h1", parts: { repo: "r1", user: "u1", plugins: "p1", mesh: "0.4.0" } }, repo_commit: "4e1d2a7", mesh: "0.4.0" } }),
  ev(1, "session.turn_started", { sid: "s1", payload: { delivered: false, model: "claude-opus-5-5" } }),
  ev(8, "session.turn_stopped", { sid: "s1", payload: { effort: "high", permission_mode: "default" } }),
  ev(10, "session.waiting", { sid: "s1", payload: { needs: "permission" } }),
  ev(16, "session.turn_started", { sid: "s1", payload: { delivered: false } }),
  ev(30, "session.nudged", { sid: "s1" }),
  ev(31, "session.turn_started", { sid: "s1", payload: { delivered: true } }),
  ev(50, "session.waiting", { sid: "s1" }),
  ev(53, "session.turn_started", { sid: "s1", payload: { delivered: false } }),
  ev(60, "step.paused"),
  ev(70, "step.taken_over", { user: "tom", sid: "s2" }),
  ev(71, "session.turn_started", { sid: "s2", payload: { delivered: true } }),
  ev(125, "step.done", { user: "tom", sid: "s2" }),
  ev(126, "session.turn_started", { step: "G17.other", sid: "s3" }),
];

describe("step facts", () => {
  const f = stepFacts(step, events);
  it("counts turns, human prompts, nudges and waits", () => {
    expect(f).toMatchObject({ turns: 5, humanPrompts: 3, nudges: 1, waits: { count: 2, minutes: 9 }, fixCycles: 1 });
  });
  it("tracks holders, sessions and models", () => {
    expect(f.holders).toEqual([
      { user: "ariel", from: T0, to: T0 + 60 * M },
      { user: "tom", from: T0 + 70 * M, to: T0 + 125 * M },
    ]);
    expect(f.sessions).toEqual(["s1", "s2"]);
    expect(f.models).toEqual(["claude-opus-5-5", "claude-sonnet-5"]);
    expect(f.segments.map((x) => [x.sid, x.model, x.modelSource, x.effort, x.claudeCode, x.turns, x.humanPrompts])).toEqual([
      ["s1", "claude-opus-5-5", "hook", "high", "2.1.318", 4, 3],
      ["s2", "claude-sonnet-5", "agent", undefined, undefined, 1, 0],
    ]);
    expect(f.segments[0]?.harness?.hash).toBe("h1");
    expect(f.segments[0]?.activeMinutes).toBeGreaterThan(0);
    expect(f).toMatchObject({ startedAt: T0, finishedAt: T0 + 125 * M });
  });
});

describe("trail files (golden)", () => {
  it("renders a step record", () => {
    const r = stepRecord(step, stepFacts(step, events), [{ user: "ariel", text: "v4 fallback stays on\n(decided with owner)" }]);
    expect(r.path).toBe(".mesh/goals/G17/steps/dplane.md");
    expect(r.text).toMatchSnapshot();
  });

  const plan: Plan = {
    goal: "G17",
    version: 2,
    designRef: "frr-dplane-ovs@design/g17:docs/design/g17-ipv6-underlay.md",
    steps: [
      { id: "proto", repo: "proto-defs", kind: "implement", title: "proto", brief: "add fields", deps: [] },
      { id: "dplane", repo: "frr-dplane-ovs", kind: "implement", title: "dplane", brief: "program v6", deps: ["proto"] },
    ],
    proposedBy: "ariel",
    proposedAt: T0,
    decision: "approved",
    decidedBy: "sara",
    decidedAt: T0 + 30 * M,
    comment: "ship it",
  };

  it("renders plan and goal files", () => {
    const p = planFile(plan);
    expect(p.path).toBe(".mesh/goals/G17/plan.v2.yaml");
    expect(p.text).toMatchSnapshot();
    const goal: Goal = { id: "G17", title: "IPv6 underlay", ownerId: "ariel", state: "in_progress", primaryRepo: "frr-dplane-ovs", repos: ["proto-defs"], priority: 3, createdAt: T0, updatedAt: T0 };
    expect(goalFile(goal)).toEqual({ path: ".mesh/goals/G17/goal.yaml", text: expect.stringContaining("repos:\n  - proto-defs") });
  });

  it("diffs plan versions", () => {
    const v3: Plan = { ...plan, version: 3, steps: [plan.steps[0] as Plan["steps"][number], { ...(plan.steps[1] as Plan["steps"][number]), brief: "new" }, { id: "docs", repo: "d", kind: "docs", title: "docs", brief: "b", deps: [] }] };
    expect(diffPlans(plan, v3)).toEqual({ added: ["docs"], removed: [], changed: ["dplane"] });
    expect(diffPlans(undefined, plan)).toEqual({ added: ["proto", "dplane"], removed: [], changed: [] });
  });
});

describe("DAG layout", () => {
  it("groups steps by depth", () => {
    const steps = materialize(
      "G1",
      1,
      [
        { id: "proto", repo: "r", kind: "implement", title: "p", brief: "b", deps: [] },
        { id: "agent", repo: "r", kind: "implement", title: "a", brief: "b", deps: ["proto"] },
        { id: "dplane", repo: "r", kind: "implement", title: "d", brief: "b", deps: ["proto"] },
        { id: "e2e", repo: "r", kind: "test", title: "e", brief: "b", deps: ["agent", "dplane"] },
      ],
      [],
      0,
    ).upserts;
    expect(levels(steps).map((l) => l.map((s) => s.id))).toEqual([["G1.proto"], ["G1.agent", "G1.dplane"], ["G1.e2e"]]);
    expect(depths(steps).get("G1.e2e")).toBe(2);
  });
});

describe("goal roll-up", () => {
  it("totals a finished goal", async () => {
    const { goalRollup, goalFile } = await import("./trail.ts");
    const goal: Goal = { id: "G17", title: "t", ownerId: "ariel", state: "done", priority: 3, createdAt: T0, updatedAt: T0, refs: { spec: "771" } };
    const facts = new Map([[step.id, stepFacts(step, events)]]);
    const plans: Plan[] = [
      { goal: "G17", version: 1, steps: [], proposedBy: "ariel", proposedAt: T0, decision: "revised" },
      { goal: "G17", version: 2, steps: [], proposedBy: "ariel", proposedAt: T0, decision: "superseded" },
      { goal: "G17", version: 3, steps: [], proposedBy: "ariel", proposedAt: T0, decision: "approved" },
    ];
    const r = goalRollup(goal, [step], plans, facts, T0 + 180 * M);
    expect(r).toMatchObject({ steps: 1, done: 1, rounds: 2, fixCycles: 1, planVersions: 3, designRounds: 1, people: ["ariel", "tom"], leadTimeHours: 3 });
    expect(r.byKind.implement).toMatchObject({ steps: 1, rounds: 2, fixCycles: 1 });
    const text = goalFile(goal, r, T0 + 180 * M).text;
    expect(text).toContain("schema: mesh.ledger.v1");
    expect(text).toContain("design_rounds: 1");
    expect(text).toContain("spec: \"771\"");
  });
});
