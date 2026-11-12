// RL-2 AC-01 and AC-25 (unit): the review policy fields, the `skipped` state, review records and the
// `mesh_review` tool. Written from the spec's contracts only (docs/specs/RL-2.md). New exports are
// read loosely so the file compiles before they exist; a missing export fails the test that needs it.

import { describe, expect, it } from "vitest";
import * as protocol from "./index.ts";
import { PlanInput, PlanStep, StepPolicy, StepState } from "./index.ts";

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- new exports, read loosely
const P = protocol as any;

const base = { id: "validate", repo: "r", kind: "implement", title: "Validate", brief: "b" } as const;
const review = { output: "review-record", when: { open: true, min_severity: "S2" }, consumes: ["open", "confirmed"], may_set: ["dismissed"] };

const item = (over: Record<string, unknown> = {}) => ({
  key: { rule: "I-03", path: "src/a.ts", symbol: "f" },
  title: "Hard-coded secret",
  severity: "S2",
  category: "security",
  evidence: [{ path: "src/a.ts", lines: [3, 3], note: "here" }],
  ...over,
});
const record = (over: Record<string, unknown> = {}) => ({ coverage: "complete", assessment: "issues", items: [item()], summary: "s", ...over });
const ok = (x: { success: boolean; error?: { issues: unknown } }) => expect(x.success, JSON.stringify(x.error?.issues)).toBe(true);

describe("AC-01 schemas", () => {
  it("test_AC01_policy_accepts", () => {
    const pol = StepPolicy.safeParse(review);
    ok(pol);
    for (const [k, v] of Object.entries(review)) expect((pol.data as Record<string, unknown>)[k], k).toStrictEqual(v);
    const ps = PlanStep.safeParse({ ...base, deps: ["audit"], ...review });
    ok(ps);
    for (const [k, v] of Object.entries(review)) expect((ps.data as Record<string, unknown>)[k], k).toStrictEqual(v);
  });

  it.each([
    ["output report", { output: "report" }],
    ["when open false", { when: { open: false } }],
    ["when unknown key", { when: { x: 1 } }],
    ["when severity S5", { when: { min_severity: "S5" } }],
    ["consumes empty", { consumes: [] }],
    ["consumes resolved", { consumes: ["resolved"] }],
    ["consumes six", { consumes: ["open", "confirmed", "dismissed", "deferred", "accepted", "open"] }],
    ["may_set open", { may_set: ["open"] }],
    ["may_set empty", { may_set: [] }],
    ["may_set five", { may_set: ["confirmed", "dismissed", "deferred", "accepted", "confirmed"] }],
  ])("test_AC01_policy_rejects %s", (_name, bad) => {
    expect(StepPolicy.safeParse(bad).success).toBe(false);
    expect(PlanStep.safeParse({ ...base, ...bad }).success).toBe(false);
  });

  it("test_AC01_policy_limits_control", () => {
    // Positive control for the rejects: five consumes and four may_set are the maximum.
    ok(StepPolicy.safeParse({ consumes: ["open", "confirmed", "dismissed", "deferred", "accepted"], may_set: ["confirmed", "dismissed", "deferred", "accepted"] }));
    ok(StepPolicy.safeParse({ when: { open: true } }));
    ok(StepPolicy.safeParse({ when: { min_severity: "S4" } }));
  });

  it("test_AC01_step_state_skipped", () => {
    expect(StepState.safeParse("skipped").success).toBe(true);
    expect(StepState.safeParse("skip").success).toBe(false);
    // Control: an old state still parses.
    expect(StepState.safeParse("done").success).toBe(true);
  });

  it("test_AC01_enums", () => {
    expect(P.Severity.options).toStrictEqual(["S1", "S2", "S3", "S4"]);
    expect(P.ItemState.options).toStrictEqual(["open", "confirmed", "dismissed", "deferred", "accepted", "resolved"]);
    expect(P.Disposition.options).toStrictEqual(["confirmed", "dismissed", "deferred", "accepted"]);
    expect(P.FoldMark.options).toStrictEqual(["new", "repeat", "regression", "resolved"]);
    ok(P.Fold.safeParse({ new: 0, repeat: 1, regression: 0, resolved: 2, carried: 1 }));
    expect(P.Fold.safeParse({ new: -1, repeat: 1, regression: 0, resolved: 2, carried: 1 }).success).toBe(false);
  });

  it("test_AC01_record_valid", () => {
    const r = P.ReviewRecord.safeParse(record());
    ok(r);
    expect(r.data.subject).toStrictEqual({});
    expect(r.data.dispositions).toStrictEqual([]);
    expect(r.data.items).toStrictEqual([item()]);
  });

  const withEvidence = (e: Record<string, unknown>) => record({ items: [item({ evidence: [{ path: "src/a.ts", ...e }] })] });
  const disp = (fingerprint: string) => record({ items: [], assessment: "clean", dispositions: [{ fingerprint, disposition: "dismissed", reason: "r" }] });
  it.each([
    ["lines 5,3", withEvidence({ lines: [5, 3] })],
    ["lines 0,2", withEvidence({ lines: [0, 2] })],
    ["severity S5", record({ items: [item({ severity: "S5" })] })],
    ["501 items", record({ items: Array.from({ length: 501 }, () => item()) })],
    ["fingerprint ABC", disp("ABC")],
    ["fingerprint with 0 and 1", disp("abcdefgh0123456z")],
    ["fingerprint uppercase", disp("ABCDEFGHIJKLMN27")],
    ["unknown top-level key", record({ extra: 1 })],
    ["unknown key in key", record({ items: [item({ key: { rule: "I-03", line: 3 } })] })],
    ["unknown key in item", record({ items: [item({ lines: [1, 2] })] })],
    ["coverage other", record({ coverage: "most" })],
    ["empty summary", record({ summary: "" })],
  ])("test_AC01_record_rejects %s", (_name, bad) => {
    expect(P.ReviewRecord.safeParse(bad).success).toBe(false);
  });

  it("test_AC01_record_boundaries", () => {
    ok(P.ReviewRecord.safeParse(record({ items: Array.from({ length: 500 }, () => item()) })));
    ok(P.ReviewRecord.safeParse(withEvidence({ lines: [1, 1] })));
    const d = P.ReviewRecord.safeParse(record({ items: [], assessment: "clean", dispositions: [{ fingerprint: "abcdefghijklmn27", disposition: "deferred", reason: "later", until: "2026-12-01", link: "https://tracker.invalid/1" }] }));
    ok(d);
    expect(d.data.dispositions[0]).toStrictEqual({ fingerprint: "abcdefghijklmn27", disposition: "deferred", reason: "later", until: "2026-12-01", link: "https://tracker.invalid/1" });
  });

  it("test_AC01_review_upload", () => {
    const u = P.ReviewUpload.safeParse(record({ items: [item({ eh: "a".repeat(64) })] }));
    ok(u);
    expect(u.data.undeclaredRules).toBe(0);
    expect(u.data.redactions).toBe(0);
    expect(u.data.items[0].eh).toBe("a".repeat(64));
    ok(P.ReviewUpload.safeParse(record({ agent: { key: "svc/auditor", hash: "h" }, sid: "s1", undeclaredRules: 2, redactions: 1 })));
  });

  it("test_AC01_old_plan_unchanged", () => {
    const old = {
      design_ref: "docs/x.md",
      steps: [
        { id: "spec", repo: "r", kind: "implement", title: "Spec", brief: "b", role: "spec-writer", acs: ["AC-01"] },
        { id: "audit", repo: "r", kind: "implement", title: "Audit", brief: "b", deps: ["spec"], mode: "headless", agent: "auditor", inputs: ["previous"] },
        { id: "gate", repo: "r", kind: "gate", title: "Gate", brief: "b", deps: ["audit"], gate: "R1" },
      ],
      acs: [{ id: "AC-01", text: "a" }],
    };
    const parsed = PlanInput.parse(old);
    expect(parsed).toStrictEqual({
      design_ref: "docs/x.md",
      steps: [
        { id: "spec", repo: "r", kind: "implement", title: "Spec", brief: "b", deps: [], role: "spec-writer", acs: ["AC-01"] },
        { id: "audit", repo: "r", kind: "implement", title: "Audit", brief: "b", deps: ["spec"], mode: "headless", agent: "auditor", inputs: ["previous"] },
        { id: "gate", repo: "r", kind: "gate", title: "Gate", brief: "b", deps: ["audit"], gate: "R1" },
      ],
      acs: [{ id: "AC-01", text: "a" }],
    });
    for (const s of parsed.steps) for (const k of ["output", "when", "consumes", "may_set"]) expect(k in s, `${s.id}.${k}`).toBe(false);
  });
});

describe("AC-25 compat (unit)", () => {
  it("test_AC25_tools", () => {
    const names = Object.keys(P.TOOLS as Record<string, unknown>);
    expect(names).toContain("mesh_review");
    expect(names).not.toContain("mesh_dispose");
    // Control: the RL-1 tools are still there.
    expect(names).toContain("mesh_artifact");
    expect(names).toContain("mesh_done");
    const t = (P.TOOLS as Record<string, { description: string }>).mesh_review;
    expect(t?.description).toMatch(/fingerprint/i);
    expect(t?.description).toMatch(/mesh_done|never fails the step/i);
  });

  it("test_AC25_tool_rules", () => {
    expect(P.MESH_TOOL_RULES).toStrictEqual(["mcp__mesh__mesh_context", "mcp__mesh__mesh_artifact", "mcp__mesh__mesh_review", "mcp__mesh__mesh_done"]);
  });
});
