// RL-1 AC-01: the headless policy fields and the new protocol types. Written from the spec's
// contracts only (docs/specs/RL-1.md). New exports are read loosely so the file compiles before
// they exist; a missing export fails the test that needs it.

import { describe, expect, it } from "vitest";
import * as protocol from "./index.ts";
import { PlanInput, PlanStep, StepPolicy } from "./index.ts";

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- new exports, read loosely
const P = protocol as any;

const base = { id: "audit", repo: "r", kind: "implement", title: "Audit", brief: "b" } as const;
const headless = {
  mode: "headless",
  agent: "auditor",
  profile: "read-only+checks",
  budget: { turns: 5, minutes: 10, usd: 0.5 },
  inputs: ["artifacts", "run"],
};

describe("AC-01 StepPolicy", () => {
  it("test_AC01_accepts_headless_fields", () => {
    const r = PlanStep.safeParse({ ...base, ...headless });
    expect(r.success, JSON.stringify(r.error?.issues)).toBe(true);
    const parsed = r.data as Record<string, unknown>;
    for (const [k, v] of Object.entries(headless)) expect(parsed[k], k).toStrictEqual(v);
    const pol = StepPolicy.safeParse(headless);
    expect(pol.success).toBe(true);
    expect(pol.data).toMatchObject(headless);
    for (const [k, v] of Object.entries(headless)) expect((pol.data as Record<string, unknown>)[k], k).toStrictEqual(v);
  });

  it.each([
    // RL-4 AC-01 made "debrief" a valid mode; an unknown mode is still refused.
    ["mode batch", { mode: "batch" }],
    ["profile with space and caps", { mode: "headless", profile: "Read Only" }],
    ["budget turns 0", { mode: "headless", budget: { turns: 0 } }],
    ["budget minutes 1441", { mode: "headless", budget: { minutes: 1441 } }],
    ["budget usd 0", { mode: "headless", budget: { usd: 0 } }],
    ["unknown budget key", { mode: "headless", budget: { turns: 1, foo: 1 } }],
    ["21 inputs", { mode: "headless", inputs: Array.from({ length: 21 }, () => "previous") }],
    ["budget usd above 1000", { mode: "headless", budget: { usd: 1000.01 } }],
    ["budget turns 501", { mode: "headless", budget: { turns: 501 } }],
  ])("test_AC01_rejects %s", (_name, extra) => {
    expect(PlanStep.safeParse({ ...base, ...extra }).success).toBe(false);
    expect(StepPolicy.safeParse(extra).success).toBe(false);
  });

  it("test_AC01_accepts_mode_debrief", () => {
    // RL-4 AC-01: the debrief mode parses in both a plan step and a policy.
    expect(PlanStep.safeParse({ ...base, mode: "debrief" }).success).toBe(true);
    expect(StepPolicy.safeParse({ mode: "debrief" }).success).toBe(true);
  });

  it("test_AC01_boundaries", () => {
    const edge = {
      mode: "headless",
      budget: { turns: 500, minutes: 1440, usd: 1000 },
      inputs: Array.from({ length: 20 }, () => "previous"),
      profile: "a".repeat(40),
      agent: "A".repeat(64),
    };
    const r = PlanStep.safeParse({ ...base, ...edge });
    expect(r.success, JSON.stringify(r.error?.issues)).toBe(true);
    expect((r.data as Record<string, unknown>).budget).toStrictEqual(edge.budget);
    expect((r.data as Record<string, unknown>).profile).toBe(edge.profile);
    expect((r.data as Record<string, unknown>).agent).toBe(edge.agent);
    // One past each edge is refused (the same schema).
    expect(PlanStep.safeParse({ ...base, ...edge, profile: "a".repeat(41) }).success).toBe(false);
    expect(PlanStep.safeParse({ ...base, ...edge, agent: "A".repeat(65) }).success).toBe(false);
    expect(PlanStep.safeParse({ ...base, mode: "interactive" }).success).toBe(true);
  });

  it("test_AC01_old_plan_unchanged", () => {
    const old = {
      design_ref: "docs/x.md",
      steps: [
        { id: "spec", repo: "r", kind: "implement", title: "Spec", brief: "b", role: "spec-writer", acs: ["AC-01"], forbid: ["secret/**"] },
        { id: "develop", repo: "r", kind: "implement", title: "Dev", brief: "b", deps: ["spec"], blind: ["tests"], reads: ["spec"], worktree: true },
        { id: "tests", repo: "r", kind: "implement", title: "Tests", brief: "b", deps: ["spec"], blind: ["develop"] },
        { id: "gate", repo: "r", kind: "gate", title: "Gate", brief: "b", deps: ["develop", "tests"], gate: "R1" },
      ],
      acs: [{ id: "AC-01", text: "a" }],
    };
    const parsed = PlanInput.parse(old);
    expect(parsed).toStrictEqual({
      design_ref: "docs/x.md",
      steps: [
        { id: "spec", repo: "r", kind: "implement", title: "Spec", brief: "b", deps: [], role: "spec-writer", acs: ["AC-01"], forbid: ["secret/**"] },
        { id: "develop", repo: "r", kind: "implement", title: "Dev", brief: "b", deps: ["spec"], blind: ["tests"], reads: ["spec"], worktree: true },
        { id: "tests", repo: "r", kind: "implement", title: "Tests", brief: "b", deps: ["spec"], blind: ["develop"] },
        { id: "gate", repo: "r", kind: "gate", title: "Gate", brief: "b", deps: ["develop", "tests"], gate: "R1" },
      ],
      acs: [{ id: "AC-01", text: "a" }],
    });
    for (const s of parsed.steps) for (const k of ["mode", "agent", "profile", "budget", "inputs"]) expect(k in s, `${s.id}.${k}`).toBe(false);
  });

  it("test_AC01_other_types", () => {
    for (const ok of ["success", "error_max_turns", "error_during_execution", "killed_budget", "crashed", "no_result"]) expect(P.RunExit.safeParse(ok).success, ok).toBe(true);
    for (const bad of ["error_", "Success", "killed", "error_Max"]) expect(P.RunExit.safeParse(bad).success, bad).toBe(false);
    const up = P.ArtifactUpload.parse({ kind: "report", content: "x" });
    expect(up).toMatchObject({ kind: "report", content: "x", mediaType: "text/markdown", redactions: 0 });
    expect(P.ArtifactUpload.safeParse({ kind: "report", content: "" }).success).toBe(false);
    expect(P.ArtifactUpload.safeParse({ kind: "notes", content: "x" }).success).toBe(false);
    expect(P.RunReport.safeParse({ state: "started", runId: "r1" }).success).toBe(true);
    expect(P.RunReport.safeParse({ state: "ended", runId: "r1" }).success).toBe(false);
    expect(P.ProfileName.safeParse("read-only+checks").success).toBe(true);
    expect(P.ProfileName.safeParse("-x").success).toBe(false);
    expect(P.ArtifactKind.options).toStrictEqual(["report", "review", "transcript"]);
    expect(P.ArtifactMediaType.options).toStrictEqual(["text/markdown", "application/json", "text/plain"]);
    expect(P.HEADLESS_DEFAULTS).toStrictEqual({ profile: "read-only", turns: 30, minutes: 30 });
    expect(P.MESH_TOOL_RULES).toStrictEqual(["mcp__mesh__mesh_context", "mcp__mesh__mesh_artifact", "mcp__mesh__mesh_review", "mcp__mesh__mesh_done"]);
    expect(P.StepBudget.safeParse({}).success).toBe(true);
  });
});
