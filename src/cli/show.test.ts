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
