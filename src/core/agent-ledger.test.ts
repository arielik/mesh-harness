import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import type { AgentRun } from "../protocol/index.ts";
import { LedgerRecord } from "../protocol/index.ts";
import { agentRecords, parseLabel } from "./agent-ledger.ts";

describe("workflow labels", () => {
  it("parses the canonical <role>:<key>[:<round>] format", () => {
    expect(parseLabel("reviewer:NA-1054:r2")).toEqual({ role: "reviewer", key: "NA-1054", name: "reviewer", round: 2 });
    expect(parseLabel("test-executor:NA-1054:c3")).toMatchObject({ name: "test-executor", round: 3 });
    expect(parseLabel("reviewer:NA-1054:diff1")).toMatchObject({ name: "reviewer-diff", round: 1 });
    expect(parseLabel("developer:NA-1054:fix1")).toMatchObject({ name: "developer" });
    expect(parseLabel("spec-writer:NA-1054")).toMatchObject({ name: "spec-writer", round: 1 });
    expect(parseLabel("gate-advisor:NA-1054:R3:1")).toMatchObject({ name: "gate-advisor-r3", round: 1 });
    expect(parseLabel("ledger")).toBeUndefined();
    expect(parseLabel("spec 1")).toBeUndefined();
    expect(parseLabel(undefined)).toBeUndefined();
  });
});

describe("agent-step records", () => {
  const T = Date.UTC(2026, 10, 4, 12);
  const run = (agentId: string, label: string, at: number, extra: Partial<AgentRun> = {}): AgentRun => ({
    agentId,
    claudeSessionId: "c1",
    cwd: "/r",
    role: label.split(":")[0] as string,
    label,
    startedAt: at,
    finishedAt: at + 60_000,
    model: "claude-opus-5-5",
    workflowRun: "wf_1",
    workflowName: "define-rows",
    ...extra,
  });
  it("groups rounds per key and record, in the order they ran, with typed results", () => {
    const files = agentRecords([
      run("a2", "reviewer:NA-1054:r2", T + 3 * 60_000, { result: { verdict: "APPROVED", blocking_open: 0 } }),
      run("a1", "reviewer:NA-1054:r1", T + 60_000, { result: { verdict: "CHANGES REQUESTED", blocking_open: 2, note: "x".repeat(500) } }),
      run("w1", "spec-writer:NA-1054", T),
      run("x1", "ledger", T),
      run("d1", "developer:NA-1054", T + 10 * 60_000, { model: "claude-sonnet-5-5" }),
      run("d2", "developer:NA-1054:fix1", T + 20 * 60_000, { model: "claude-sonnet-5-5" }),
    ]);
    expect(files.map((f) => f.path)).toEqual([".mesh/goals/NA-1054/steps/developer.md", ".mesh/goals/NA-1054/steps/reviewer.md", ".mesh/goals/NA-1054/steps/spec-writer.md"]);
    const rev = parse((files[1]?.text ?? "").split("---\n")[1] ?? "");
    expect(LedgerRecord.safeParse(rev).success).toBe(true);
    expect(rev.rounds.map((r: { n: number; label: string; result: { verdict: string } }) => [r.n, r.label, r.result.verdict])).toEqual([
      [1, "reviewer:NA-1054:r1", "CHANGES REQUESTED"],
      [2, "reviewer:NA-1054:r2", "APPROVED"],
    ]);
    expect(rev.rounds[0].result.note.length).toBe(300);
    expect(rev.rounds[0]).toMatchObject({ model: "claude-opus-5-5", model_source: "workflow", duration_s: 60, started: "2026-11-04T12:01:00Z" });
    const dev = parse((files[0]?.text ?? "").split("---\n")[1] ?? "");
    expect(dev.rounds.map((r: { label: string }) => r.label)).toEqual(["developer:NA-1054", "developer:NA-1054:fix1"]);
    expect(dev.models).toEqual(["claude-sonnet-5-5"]);
  });
});
