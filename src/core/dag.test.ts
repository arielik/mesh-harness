import { describe, expect, it } from "vitest";
import type { PlanStep, Step } from "../protocol/index.ts";
import * as dag from "./dag.ts";
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

// ---------------------------------------------------------------------------------------------
// RL-2 AC-07 (unit): `settle()`, the `skipped` state and the dag changes. Written from the spec's
// contracts only (docs/specs/RL-2.md). `settle` is read loosely so the file compiles before it exists.

describe("RL-2 skipped", () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- new export, read loosely
  const settle = (dag as any).settle as (steps: readonly Step[], now: number, holds: (s: Step) => boolean) => { changed: Step[]; skipped: string[] };
  const WHEN = { when: { open: true }, consumes: ["open"] };
  const st = (id: string, state: string, deps: string[] = [], policy?: Record<string, unknown>): Step =>
    ({ id: `G1.${id}`, goal: "G1", planVersion: 1, kind: "implement", repo: "r", title: id, brief: `do ${id}`, deps: deps.map((d) => `G1.${d}`), state, fixCycles: 0, updatedAt: 0, ...(policy ? { policy } : {}) }) as unknown as Step;
  const stateOf = (steps: readonly Step[], id: string) => steps.find((s) => s.id === `G1.${id}`)?.state;
  const recorder = (answer: boolean | ((s: Step) => boolean)) => {
    const calls: string[] = [];
    const fn = (s: Step) => {
      calls.push(s.id);
      return typeof answer === "function" ? answer(s) : answer;
    };
    return { calls, fn };
  };
  const applied = (steps: Step[], changed: Step[]) => steps.map((s) => changed.find((c) => c.id === s.id) ?? s);

  it("test_AC07_settle_skip_and_cascade", () => {
    const steps = [st("a", "done"), st("v", "blocked", ["a"], WHEN), st("d", "blocked", ["v"])];
    const h = recorder(false);
    const out = settle(steps, 5, h.fn);
    expect(out.skipped).toStrictEqual(["G1.v"]);
    expect(stateOf(out.changed, "v")).toBe("skipped");
    expect(stateOf(out.changed, "d")).toBe("ready");
    expect(h.calls).toStrictEqual(["G1.v"]);
  });

  it("test_AC07_settle_ready", () => {
    const steps = [st("a", "done"), st("v", "blocked", ["a"], WHEN), st("d", "blocked", ["v"])];
    const out = settle(steps, 5, recorder(true).fn);
    expect(out.skipped).toStrictEqual([]);
    expect(stateOf(out.changed, "v")).toBe("ready");
    const after = applied(steps, out.changed);
    expect(stateOf(after, "d")).toBe("blocked");
  });

  it("test_AC07_ready_not_reevaluated", () => {
    const steps = [st("a", "done"), st("v", "ready", ["a"], WHEN)];
    const h = recorder(false);
    const out = settle(steps, 5, h.fn);
    expect(h.calls).not.toContain("G1.v");
    expect(out.changed).toStrictEqual([]);
    expect(out.skipped).toStrictEqual([]);
    // Control: the same step blocked is decided (and skipped).
    const h2 = recorder(false);
    const out2 = settle([st("a", "done"), st("v", "blocked", ["a"], WHEN)], 5, h2.fn);
    expect(h2.calls).toStrictEqual(["G1.v"]);
    expect(out2.skipped).toStrictEqual(["G1.v"]);
  });

  it("test_AC07_skipped_to_blocked", () => {
    const steps = [st("a", "ready"), st("v", "skipped", ["a"], WHEN)];
    const out = settle(steps, 5, recorder(false).fn);
    expect(stateOf(out.changed, "v")).toBe("blocked");
    // A ready step with an unsatisfied dep goes back to blocked too.
    const out2 = settle([st("a", "ready"), st("w", "ready", ["a"])], 5, recorder(false).fn);
    expect(stateOf(out2.changed, "w")).toBe("blocked");
  });

  it("test_AC07_holds_only_when", () => {
    const steps = [st("a", "done"), st("x", "blocked", ["a"]), st("v", "blocked", ["a"], WHEN), st("y", "blocked", ["a"])];
    const h = recorder(true);
    const out = settle(steps, 5, h.fn);
    expect(h.calls).toStrictEqual(["G1.v"]);
    for (const id of ["x", "v", "y"]) expect(stateOf(out.changed, id), id).toBe("ready");
  });

  it("test_AC07_dropped_satisfies", () => {
    const out = settle([st("a", "dropped"), st("b", "skipped"), st("v", "blocked", ["a", "b"], WHEN)], 5, recorder(true).fn);
    expect(stateOf(out.changed, "v")).toBe("ready");
  });

  it("test_AC07_recomputeReady", () => {
    const a = recomputeReady([st("a", "skipped"), st("c", "blocked", ["a"])], 5);
    expect(a.map((s) => [s.id, s.state])).toStrictEqual([["G1.c", "ready"]]);
    const b = recomputeReady([st("a", "done"), st("v", "blocked", ["a"], WHEN)], 5);
    expect(b.find((s) => s.id === "G1.v")?.state ?? "blocked").toBe("blocked");
    expect(b.filter((s) => s.state === "ready")).toStrictEqual([]);
  });

  it("test_AC07_reopen_cascade", () => {
    const steps = [st("a", "done"), st("v", "skipped", ["a"], WHEN), st("d", "done", ["v"]), st("o", "ready")];
    const changed = reopen(steps, ["G1.a"], 5);
    expect(stateOf(changed, "a")).toBe("ready");
    expect(stateOf(changed, "v")).toBe("blocked");
    expect(stateOf(changed, "d")).toBe("blocked");
    expect(changed.find((s) => s.id === "G1.o")).toBeUndefined();
  });

  const plan = (over: Record<string, unknown> = {}) => [p("a"), p("v", ["a"], { when: { open: true }, consumes: ["open"], ...over } as Partial<PlanStep>)];
  const existing = () => {
    const m = materialize("G1", 1, plan(), [], 1).upserts;
    return m.map((s) => (s.id === "G1.a" ? { ...s, state: "done" as const } : s.id === "G1.v" ? ({ ...s, state: "skipped", summary: "skipped: no item of a is open" } as unknown as Step) : s));
  };

  it("test_AC07_materialize_unchanged_skipped", () => {
    const m = materialize("G1", 2, plan(), existing(), 2);
    expect(stateOf(m.upserts, "v")).toBe("skipped");
    expect(stateOf(m.upserts, "a")).toBe("done");
  });

  it.each([
    ["brief", [p("a"), p("v", ["a"], { brief: "new brief", when: { open: true }, consumes: ["open"] } as Partial<PlanStep>)]],
    ["when.min_severity", plan({ when: { open: true, min_severity: "S2" } })],
    ["deps", [p("a"), p("b"), p("v", ["a", "b"], { when: { open: true }, consumes: ["open"] } as Partial<PlanStep>)]],
  ])("test_AC07_materialize_changed %s", (_what, next) => {
    const m = materialize("G1", 2, next as PlanStep[], existing(), 2);
    expect(stateOf(m.upserts, "v")).toBe("blocked");
  });

  it("test_AC07_materialize_new_when", () => {
    const done = materialize("G1", 1, [p("a")], [], 1).upserts.map((s) => ({ ...s, state: "done" as const }));
    const m = materialize("G1", 2, [p("a"), p("v", ["a"], { when: { open: true }, consumes: ["open"] } as Partial<PlanStep>), p("w", ["a"])], done, 2);
    expect(stateOf(m.upserts, "v")).toBe("blocked");
    // Control: a new sibling without `when` and done deps is ready.
    expect(stateOf(m.upserts, "w")).toBe("ready");
    // A new root step with `when` is not ready either.
    const r = materialize("G2", 1, [{ ...p("v"), when: { open: true }, consumes: ["open"] } as PlanStep], [], 1);
    expect(r.upserts.find((s) => s.id === "G2.v")?.state).toBe("blocked");
  });
});
