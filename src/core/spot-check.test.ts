// RL-18 AC-02 and AC-09 (unit): the pure sampling rule, the built-in `spot-check` preset and its plan
// rule, and the debrief prompt of a spot-check step. Written from docs/specs/RL-18.md.

import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { MESH_TOOL_RULES, TOOLS } from "../protocol/index.ts";
import { BUILTIN_PRESETS, instantiate } from "./presets.ts";
import { INPUT_KEYWORDS, validatePolicies } from "./policy.ts";
import { spotU, spotWhy } from "./spot-check.ts";

const u = (lineage: string, fp: string, step: string, round: number) =>
  parseInt(createHash("sha256").update(JSON.stringify([lineage, fp, step, round]), "utf8").digest("hex").slice(0, 8), 16) / 2 ** 32;

describe("RL-18 AC-02 sampling rule", () => {
  it("test_AC02_u_is_the_hash", () => {
    const ds = [
      ["-|/src/alpha|auditor", "aaaaaaaaaaaaaaaa", "G1.validate", 1],
      ["-|/src/alpha|auditor", "bbbbbbbbbbbbbbbb", "G1.validate", 1],
      ["-|/src/beta|auditor", "aaaaaaaaaaaaaaaa", "G12.file", 3],
    ] as const;
    for (const [lineage, fp, step, round] of ds) {
      const x = spotU({ lineage, fp, step, round });
      expect(x).toBe(u(lineage, fp, step, round));
      expect(x >= 0 && x < 1).toBe(true);
    }
    // Every part of the decision matters.
    expect(spotU({ lineage: "l", fp: "f", step: "G1.v", round: 1 })).not.toBe(spotU({ lineage: "l", fp: "f", step: "G1.v", round: 2 }));
  });

  it("test_AC02_rate_and_minimum", () => {
    expect(spotWhy(0.999, { rate: 1, minPerWeek: 0 }, 0)).toBe("rate");
    expect(spotWhy(0, { rate: 0, minPerWeek: 0 }, 0)).toBeUndefined();
    expect(spotWhy(0.3, { rate: 0.5, minPerWeek: 0 }, 9)).toBe("rate");
    expect(spotWhy(0.5, { rate: 0.5, minPerWeek: 0 }, 0)).toBeUndefined();
    const run = (minPerWeek: number) => {
      let recent = 0;
      const whys: (string | undefined)[] = [];
      for (let i = 0; i < 3; i++) {
        const w = spotWhy(0.7, { rate: 0, minPerWeek }, recent);
        whys.push(w);
        if (w) recent++;
      }
      return whys;
    };
    // rate 0, min 1: the first of three decisions (no recent sample) is a minimum, the others not.
    expect(run(1)).toStrictEqual(["minimum", undefined, undefined]);
    expect(run(2)).toStrictEqual(["minimum", "minimum", undefined]);
  });
});

describe("RL-18 AC-09 preset, policy, tools, prompt", () => {
  it("test_AC09_preset_policy_tools", () => {
    expect(BUILTIN_PRESETS.map((p) => p.name)).toStrictEqual(["sdd-split", "sdd-collapse", "audit-relay", "calibrate", "spot-check"]);
    const p = BUILTIN_PRESETS.find((x) => x.name === "spot-check");
    expect(p?.description).toBe("Spot-check the item decisions of a validating or filing agent (opened by the hub when spot_checks samples one).");
    const plan = instantiate(p as never, { repo: "alpha", goal: "G9", params: { agent: "alpha/checker", hash: "0123456789ab" } });
    expect(plan.steps).toHaveLength(1);
    expect(plan.steps[0]).toMatchObject({
      id: "check",
      kind: "review",
      repo: "alpha",
      mode: "debrief",
      assignee: "@owner",
      output: "review-record",
      may_set: ["confirmed"],
      inputs: ["spot-check"],
      title: "Spot-check alpha/checker@0123456789ab",
    });
    expect(validatePolicies(plan.steps as never, undefined)).toStrictEqual([]);
    // An ordinary debrief without a run still gets the RL-2 consumes error.
    const { inputs: _inputs, ...plain } = plan.steps[0] as Record<string, unknown>;
    expect(validatePolicies([plain] as never, undefined)).toStrictEqual(['step "check": consumes needs an earlier step with output: review-record that raises items (through deps)']);
    expect(INPUT_KEYWORDS.has("spot-check")).toBe(true);
    expect(Object.keys(TOOLS)).toContain("mesh_spot_check");
    expect([...MESH_TOOL_RULES]).toStrictEqual(["mcp__mesh__mesh_context", "mcp__mesh__mesh_artifact", "mcp__mesh__mesh_review", "mcp__mesh__mesh_done"]);
  });
});
