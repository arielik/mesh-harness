import { describe, expect, it } from "vitest";
import type { PlanStep, Step } from "../protocol/index.ts";
import { dependents, materialize, recomputeReady, reopen, topoOrder, validatePlan } from "./dag.ts";

const p = (id: string, deps: string[] = [], over: Partial<PlanStep> = {}): PlanStep => ({
  id,
  repo: "frr",
  kind: "implement",
  title: id,
  brief: `do ${id}`,
  deps,
  ...over,
});

const G17 = [p("proto"), p("agent", ["proto"]), p("dplane", ["proto"]), p("dplane-t", ["dplane"], { kind: "test" }), p("e2e", ["agent", "dplane-t"], { kind: "test" })];

const byId = (steps: Step[]) => Object.fromEntries(steps.map((s) => [s.id.split(".")[1], s.state]));

describe("validatePlan", () => {
  it("accepts a valid DAG", () => expect(validatePlan(G17)).toEqual([]));

  it("explains unknown deps with a suggestion", () => {
    expect(validatePlan([p("agent"), p("e2e", ["agnt"])])).toEqual(['step "e2e": dep "agnt" not found; did you mean "agent"?']);
  });

  it.each([
    [[], "a plan needs at least one step"],
    [[p("a"), p("a")], 'step id "a" is used more than once'],
    [[p("design")], 'step id "design" is reserved for the design step'],
    [[p("a", ["a"])], 'step "a": depends on itself'],
    [[p("a", ["b"]), p("b", ["c"]), p("c", ["a"])], "dependency cycle: a → b → c → a"],
  ])("rejects %j", (steps, error) => {
    expect(validatePlan(steps)).toContain(error);
  });

  it("limits plan size", () => {
    expect(validatePlan(Array.from({ length: 51 }, (_, i) => p(`s${i}`)))[0]).toMatch(/at most 50/);
  });
});

describe("materialize", () => {
  it("creates steps with roots ready and the rest blocked", () => {
    const m = materialize("G17", 1, G17, [], 1);
    expect(byId(m.upserts)).toEqual({ proto: "ready", agent: "blocked", dplane: "blocked", "dplane-t": "blocked", e2e: "blocked" });
    expect(m.upserts.find((s) => s.id === "G17.e2e")?.deps).toEqual(["G17.agent", "G17.dplane-t"]);
  });

  it("replans: done stays, same id keeps state, removed is dropped, changed brief of a claimed step is reported", () => {
    const v1 = materialize("G17", 1, G17, [], 1).upserts.map((s) =>
      s.id === "G17.proto" ? { ...s, state: "done" as const } : s.id === "G17.dplane" ? { ...s, state: "claimed" as const, holderUser: "u1" } : s,
    );
    const plan2 = [p("proto"), p("dplane", ["proto"], { brief: "new brief" }), p("docs", ["dplane"], { kind: "docs" })];
    const m = materialize("G17", 2, plan2, v1, 2);
    const states = byId(m.upserts);
    expect(states).toMatchObject({ proto: "done", dplane: "claimed", docs: "blocked", agent: "dropped", "dplane-t": "dropped", e2e: "dropped" });
    expect(m.changedForHolder.map((s) => s.id)).toEqual(["G17.dplane"]);
    expect(m.upserts.every((s) => s.planVersion === 2 || s.state === "dropped")).toBe(true);
  });
});

describe("readiness and reopen", () => {
  it("unblocks dependents when deps are done or dropped", () => {
    const steps = materialize("G1", 1, [p("a"), p("b"), p("c", ["a", "b"])], [], 1).upserts;
    const s2 = steps.map((s) => (s.id === "G1.a" ? { ...s, state: "done" as const } : s.id === "G1.b" ? { ...s, state: "dropped" as const } : s));
    expect(recomputeReady(s2, 2).map((s) => [s.id, s.state])).toEqual([["G1.c", "ready"]]);
  });

  it("reopens a done step, counts a fix cycle, and re-blocks ready dependents", () => {
    let steps = materialize("G1", 1, [p("impl"), p("test", ["impl"]), p("docs", ["impl"])], [], 1).upserts;
    steps = steps.map((s) => (s.id === "G1.impl" ? { ...s, state: "done" as const, outcome: "done" as const } : s));
    steps = steps.map((s) => (s.id === "G1.docs" ? { ...s, state: "ready" as const } : s));
    const changed = reopen(steps, ["G1.impl", "G1.unknown"], 5);
    const impl = changed.find((s) => s.id === "G1.impl");
    expect(impl).toMatchObject({ state: "ready", fixCycles: 1 });
    expect(impl?.outcome).toBeUndefined();
    expect(changed.find((s) => s.id === "G1.docs")?.state).toBe("blocked");
  });

  it("orders topologically and finds dependents", () => {
    const steps = materialize("G1", 1, [p("c", ["b"]), p("b", ["a"]), p("a")], [], 1).upserts;
    expect(topoOrder(steps).map((s) => s.id)).toEqual(["G1.a", "G1.b", "G1.c"]);
    expect(dependents(steps, "G1.a").map((s) => s.id)).toEqual(["G1.b"]);
  });
});
