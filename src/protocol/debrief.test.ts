// RL-4 (unit): the mesh-debrief skill text (AC-16), the `mesh_dispose` tool and the tool list (AC-21),
// the debrief skill path. Written from the spec's contracts only (docs/specs/RL-4.md). New exports
// are read loosely so the file compiles before they exist; a missing export fails its test.

import { describe, expect, it } from "vitest";
import * as protocol from "./index.ts";
import { MESH_TOOL_RULES, resolvePaths, SKILL_MARKER, TOOLS } from "./index.ts";

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- new exports, read loosely
const P = protocol as any;

/** The tool list before RL-4 (test/m2-flow.test.ts, sorted). */
const RL3_TOOLS = ["mesh_accept", "mesh_artifact", "mesh_ask", "mesh_assign", "mesh_claim", "mesh_context", "mesh_done", "mesh_fleet", "mesh_next", "mesh_note", "mesh_offers", "mesh_plan", "mesh_release", "mesh_review"];

describe("RL-4 AC-16 mesh-debrief skill text", () => {
  it("test_AC16_skill_mentions", () => {
    const s = P.MESH_DEBRIEF_SKILL as string;
    expect(typeof s).toBe("string");
    for (const t of ["name: mesh-debrief", SKILL_MARKER, "mesh_context", "mesh_dispose", "answer", "mesh_review", "mesh_done", "transcript", "possible repeat of"]) expect(s, t).toContain(t);
    const fm = /^---\n([\s\S]*?)\n---\n/.exec(s);
    expect(fm, "front matter").not.toBeNull();
    const desc = /^description: (.+)$/m.exec(fm?.[1] ?? "")?.[1] ?? "";
    expect(desc).toContain("debrief");
    expect(desc).toContain("mesh debrief");
    expect(fm?.[1]).toMatch(/^name: mesh-debrief$/m);
  });

  it("test_AC16_skill_body_rules", () => {
    const s = (P.MESH_DEBRIEF_SKILL as string).toLowerCase();
    for (const t of ["one at a time", "untrusted", "deferred", "until", "coverage", "complete"]) expect(s, t).toContain(t);
  });

  it("test_AC16_skill_path", () => {
    const paths = resolvePaths({ CLAUDE_CONFIG_DIR: "/c" }, "/home/u") as unknown as Record<string, string>;
    expect(paths.claudeDebriefSkill).toBe("/c/skills/mesh-debrief/SKILL.md");
    // Control: the mesh skill path is unchanged.
    expect(paths.claudeSkill).toBe("/c/skills/mesh/SKILL.md");
  });
});

describe("RL-4 AC-21 tools", () => {
  it("test_AC21_tools_gain_mesh_dispose", () => {
    const names = Object.keys(TOOLS).sort();
    expect(names).toStrictEqual([...RL3_TOOLS, "mesh_dispose"].sort());
    const t = (TOOLS as Record<string, { description: string; input?: unknown; inputSchema?: unknown }>).mesh_dispose;
    expect(t?.description).toMatch(/debrief/);
    expect(t?.description).toContain("answer");
    expect(t?.description).toContain("until");
    expect(t?.description).toContain("mesh_review");
    expect(t?.description).toContain("mesh_done");
  });

  it("test_AC21_tool_rules_unchanged", () => {
    expect([...MESH_TOOL_RULES]).toStrictEqual(["mcp__mesh__mesh_context", "mcp__mesh__mesh_artifact", "mcp__mesh__mesh_review", "mcp__mesh__mesh_done"]);
    expect(MESH_TOOL_RULES).not.toContain("mcp__mesh__mesh_dispose");
  });
});
