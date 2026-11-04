import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { computeHarness } from "./harness.ts";
import { agentPaths, readAgentFiles, scanWorkflowRuns } from "./workflow.ts";

const HOME = join(import.meta.dirname, "../../test/fixtures/claude/workflow");
const SESSION = join(HOME, "projects/-work-repo/77bcebc0-c12b-4e38-9074-6154e5d8f697");
const transcript = (id: string) => join(SESSION, "subagents/workflows/wf_1e81d3e1-027", `agent-${id}.jsonl`);

describe("Claude Code workflow files", () => {
  it("finds the journal, meta and run files of a workflow agent", () => {
    const p = agentPaths(transcript("a565ba12294ed8700"), "a565ba12294ed8700");
    expect(p.workflowRun).toBe("wf_1e81d3e1-027");
    expect(p.run).toBe(join(SESSION, "workflows/wf_1e81d3e1-027.json"));
  });

  it("reads label, phase, model, timing and the typed result", () => {
    const r = readAgentFiles(transcript("ad3d5cc636df29ba5"), "ad3d5cc636df29ba5");
    expect(r).toMatchObject({
      label: "reviewer:NA-1054:r1",
      phase: "Define",
      model: "claude-opus-5-5",
      workflowRun: "wf_1e81d3e1-027",
      workflowName: "define-rows",
      startedAt: 1793820203860,
      durationMs: 1255,
      attempt: 1,
      state: "done",
      toolCalls: 1,
      roleFromMeta: "reviewer",
      result: { verdict: "APPROVED", blocking_open: 0 },
    });
    expect(JSON.stringify(r)).not.toContain("tokens");
  });

  it("falls back to the meta file for a Task subagent and never throws on missing files", () => {
    const dir = mkdtempSync(join(tmpdir(), "mesh-wf-"));
    try {
      mkdirSync(join(dir, "subagents"));
      writeFileSync(join(dir, "subagents", "agent-x1.meta.json"), JSON.stringify({ agentType: "spec-writer", description: "write the spec", pickedEffortModel: "claude-haiku-5-5" }));
      expect(readAgentFiles(join(dir, "subagents", "agent-x1.jsonl"), "x1")).toEqual({ label: "write the spec", model: "claude-haiku-5-5", roleFromMeta: "spec-writer" });
      expect(readAgentFiles(join(dir, "nope", "agent-y.jsonl"), "y")).toEqual({});
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("backfills runs recorded since a time", () => {
    const runs = scanWorkflowRuns(HOME, 0);
    expect(runs.map((r) => [r.label, r.role, r.cwd, r.finishedAt])).toEqual([
      ["spec-writer:NA-1054", "spec-writer", "/work/repo", 1793820202645 + 1178],
      ["reviewer:NA-1054:r1", "reviewer", "/work/repo", 1793820203860 + 1255],
    ]);
    expect(runs[0]?.result).toMatchObject({ acceptance_criteria: ["AC-01", "AC-02"] });
    expect(scanWorkflowRuns(HOME, Date.now() + 60_000)).toEqual([]);
  });
});

describe("harness hash", () => {
  const root = mkdtempSync(join(tmpdir(), "mesh-harness-"));
  afterAll(() => rmSync(root, { recursive: true, force: true }));
  const repo = join(root, "repo");
  const home = join(root, "home");
  mkdirSync(join(repo, ".claude", "agents"), { recursive: true });
  mkdirSync(join(repo, ".claude", "worktrees", "wt1"), { recursive: true });
  mkdirSync(join(home, "skills", "x"), { recursive: true });
  mkdirSync(join(home, "plugins"), { recursive: true });
  writeFileSync(join(repo, "CLAUDE.md"), "rules");
  writeFileSync(join(repo, ".claude", "agents", "reviewer.md"), "review");
  writeFileSync(join(home, "CLAUDE.md"), "me");
  writeFileSync(join(home, "skills", "x", "SKILL.md"), "skill");
  writeFileSync(join(home, "plugins", "installed_plugins.json"), JSON.stringify({ version: 2, plugins: { "a@m": [{ version: "1.0.0" }] } }));

  it("changes only the part that changed", () => {
    const h1 = computeHarness({ repoRoot: repo, claudeHome: home, meshVersion: "0.4.0" });
    writeFileSync(join(repo, ".claude", "worktrees", "wt1", "noise.md"), "state, not harness");
    expect(computeHarness({ repoRoot: repo, claudeHome: home, meshVersion: "0.4.0" })).toEqual(h1);
    writeFileSync(join(home, "skills", "x", "SKILL.md"), "skill v2");
    const h2 = computeHarness({ repoRoot: repo, claudeHome: home, meshVersion: "0.4.0" });
    expect(h2.parts.user).not.toBe(h1.parts.user);
    expect([h2.parts.repo, h2.parts.plugins, h2.parts.mesh]).toEqual([h1.parts.repo, h1.parts.plugins, "0.4.0"]);
    expect(h2.hash).not.toBe(h1.hash);
    expect(h2.hash).toMatch(/^[0-9a-f]{12}$/);
    expect(computeHarness({ claudeHome: join(root, "none"), meshVersion: "1" }).parts).toEqual({ repo: "none", user: "none", plugins: "none", mesh: "1" });
  });
});
