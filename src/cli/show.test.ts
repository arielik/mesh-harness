import { describe, expect, it } from "vitest";
import type { GoalDetail, Step } from "../protocol/index.ts";
import { renderGoal } from "./show.ts";

const step = (id: string, over: Partial<Step>): Step => ({
  id: `G17.${id}`,
  goal: "G17",
  planVersion: 2,
  kind: "implement",
  repo: "frr-dplane-ovs",
  title: id,
  brief: "b",
  deps: [],
  state: "blocked",
  fixCycles: 0,
  updatedAt: 0,
  ...over,
});

const detail: GoalDetail = {
  goal: { id: "G17", title: "IPv6 underlay", ownerId: "ariel", state: "in_progress", primaryRepo: "frr-dplane-ovs", priority: 3, createdAt: 0, updatedAt: 0 },
  plans: [
    { goal: "G17", version: 1, steps: [], proposedBy: "ariel", proposedAt: 0, decision: "revised", decidedBy: "sara" },
    {
      goal: "G17",
      version: 2,
      designRef: "frr@main:docs/design/g17.md",
      steps: [
        { id: "proto", repo: "proto-defs", kind: "implement", title: "proto", brief: "b", deps: [] },
        { id: "dplane", repo: "frr-dplane-ovs", kind: "implement", title: "dplane", brief: "b", deps: ["proto"] },
      ],
      proposedBy: "ariel",
      proposedAt: 0,
      decision: "approved",
      decidedBy: "sara",
    },
  ],
  steps: [
    step("design", { kind: "design", state: "done", planVersion: 0, summary: "plan v2 approved" }),
    step("proto", { repo: "proto-defs", state: "done", mr: "!41", summary: "fields added" }),
    step("agent", { repo: "vpc-node-agent", deps: ["G17.proto"], state: "claimed", holderUser: "tom", holderSid: "s2" }),
    step("dplane", { deps: ["G17.proto"], state: "claimed", holderUser: "ariel", holderSid: "s1", fixCycles: 1 }),
    step("dplane-t", { kind: "test", deps: ["G17.dplane"], state: "blocked" }),
    step("e2e", { kind: "test", repo: "vpc-lab", deps: ["G17.agent", "G17.dplane-t"] }),
    step("docs", { kind: "docs", state: "dropped" }),
    step("old", { state: "ready", repo: "proto-defs" }),
  ],
  holders: { "G17.agent": { sid: "s2", state: "working", user: "tom" }, "G17.dplane": { sid: "s1", state: "needs_you", needs: "permission", user: "ariel" } },
};

describe("mesh show", () => {
  it("renders the goal DAG by level (snapshot)", () => {
    expect(renderGoal(detail)).toMatchSnapshot();
  });

  it("explains a pending plan with its changes", () => {
    const pending = { ...detail, plans: [...detail.plans, { ...detail.plans[1], version: 3, decision: "pending", steps: [...(detail.plans[1]?.steps ?? []), { id: "docs", repo: "d", kind: "docs", title: "docs", brief: "b", deps: [] }] }] } as GoalDetail;
    const out = renderGoal(pending);
    expect(out).toContain("plan v3 pending");
    expect(out).toContain("changes from v2: +docs");
    expect(out).toContain("mesh goal approve G17");
  });
});

// MM-3 AC-29: offers among a step's extras, the stick line after the topics line.
describe("AC-29 offers in mesh show", () => {
  const holderId = "G17.agent";
  const withOffers = (extra: Record<string, unknown>) =>
    ({
      ...detail,
      goal: { ...detail.goal, topics: ["perf"] },
      ...extra,
    }) as unknown as GoalDetail;
  const accepted = { to: "m2", state: "accepted", by: "ariel", at: 1, accepted: "m2/perf-bench" };

  it("test_AC29_render_offer_line", () => {
    const out = renderGoal(withOffers({ offers: { [holderId]: accepted } }));
    const line = out.split("\n").find((l) => /^\s+\S+ agent\s/.test(l));
    expect(line, out).toBeDefined();
    expect(line).toContain("offered to m2 → accepted by m2/perf-bench");
    // After the holder.
    expect((line as string).indexOf("@tom")).toBeGreaterThanOrEqual(0);
    expect((line as string).indexOf("@tom")).toBeLessThan((line as string).indexOf("offered to m2"));
    // Only that step carries it.
    expect(out.split("\n").filter((l) => l.includes("offered to"))).toHaveLength(1);
  });

  it("test_AC29_render_open_offer", () => {
    const out = renderGoal(withOffers({ offers: { "G17.old": { to: "m2/perf", state: "offered", by: "ariel", at: 1 } } }));
    const line = out.split("\n").find((l) => /^\s+\S+ old\s/.test(l));
    expect(line).toContain("offered to m2/perf by @ariel");
  });

  it("test_AC29_render_stick_line", () => {
    const out = renderGoal(withOffers({ stick: "m2" })).split("\n");
    const topics = out.findIndex((l) => l.startsWith("topics:"));
    expect(topics, out.join("\n")).toBeGreaterThan(0);
    expect(out[topics + 1]).toBe("sticks to m2: its next ready steps are offered there (mesh withdraw G17)");
  });

  it("test_AC29_old_snapshots_unchanged", () => {
    // A goal without offers or stick renders exactly as without the new keys.
    const plain = renderGoal(detail);
    expect(renderGoal({ ...detail } as GoalDetail)).toBe(plain);
    expect(plain).not.toContain("offered to");
    expect(plain).not.toContain("sticks to");
  });
});

// RL-2 AC-23 (unit): a `skipped` step renders with the mark ↷ (MARK in src/cli/show.ts).
describe("RL-2 skipped mark", () => {
  it("test_AC23_show_mark_unit", () => {
    const skipped = { ...detail, steps: detail.steps.map((s) => (s.id === "G17.e2e" ? ({ ...s, state: "skipped", summary: "skipped: no item of dplane is open" } as unknown as Step) : s)) } as GoalDetail;
    const line = renderGoal(skipped)
      .split("\n")
      .find((l) => l.includes("e2e"));
    expect(line).toBeDefined();
    expect(line).toContain("↷");
    // Control: the unchanged goal does not show it.
    expect(renderGoal(detail)).not.toContain("↷");
  });
});

// RL-7 AC-13 (unit): the "steps done" count counts `done` or `skipped` non-dropped steps; the total is
// unchanged (non-dropped steps). docs/specs/RL-7.md, Progress text.
describe("RL-7 AC-13 progress", () => {
  const goalWith = (state: string, steps: Step[]): GoalDetail => ({ ...detail, goal: { ...detail.goal, state } as GoalDetail["goal"], steps, holders: {} });
  const sk = (id: string) => step(id, { state: "skipped", summary: `skipped: ${id}` } as unknown as Partial<Step>);

  it("test_AC13_render_counts", () => {
    const done = renderGoal(goalWith("done", [step("a", { state: "done", summary: "ok" }), sk("b"), sk("c"), step("d", { state: "dropped" })]));
    expect(done).toContain("done · owner @ariel · 3/3 steps done");
    // Positive control: the skipped steps are rendered (with the RL-2 mark).
    expect(done).toContain("↷");
    const mixed = renderGoal(goalWith("in_progress", [step("a", { state: "done", summary: "ok" }), step("r", { state: "ready" }), sk("c")]));
    expect(mixed).toContain("· owner @ariel · 2/3 steps done");
    // The existing fixture (no skipped steps) still reads 2/7.
    expect(renderGoal(detail)).toContain("in progress · owner @ariel · 2/7 steps done");
  });
});
