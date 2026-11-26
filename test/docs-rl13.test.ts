// RL-13 AC-10: the docs, the mesh skill and the version cover the commit of each round
// (docs/specs/RL-13.md, "Docs").

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { MESH_SKILL } from "../src/protocol/index.ts";

const ROOT = join(import.meta.dirname, "..");
const read = (rel: string) => readFileSync(join(ROOT, rel), "utf8");
function section(text: string, title: string, level = "##"): string {
  const re = new RegExp(`^${level} ${title.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*$`, "m");
  const start = text.search(re);
  expect(start, `${level} ${title}`).toBeGreaterThanOrEqual(0);
  const rest = text.slice(start + `${level} ${title}`.length);
  const next = rest.search(level === "##" ? /^## /m : /^##+ /m);
  return next < 0 ? rest : rest.slice(0, next);
}

describe("RL-13 AC-10 docs", () => {
  it("test_AC10_concepts", () => {
    const c = read("docs/guide/concepts.md");
    const round = c.slice(c.indexOf("**Round.**"), c.indexOf("**Segment.**"));
    expect(round).toContain("**commit**");
    expect(round).toMatch(/step's repo/);
    expect(round).toMatch(/discarded worktree/);
    expect(section(c, "Runs")).toContain("`commit`");
    expect(section(c, "Pulse health")).toContain("`commit`");
  });

  it("test_AC10_operations_events_plan", () => {
    const o = read("docs/guide/operations.md");
    expect(section(o, "Upgrading to 0.1.40")).toContain("0.1.32 records the commit of each step round");
    expect(section(o, "Probes", "###")).toContain("`commits`");
    const ev = read("docs/events.md");
    expect(ev.split("\n").some((l) => l.includes("`step.done`") && l.includes("`commit`"))).toBe(true);
    expect(ev.split("\n").some((l) => l.includes("`run.finished`") && l.includes("`commit`"))).toBe(true);
    const plan = read("docs/plan/implementation-plan.md");
    expect(plan).toContain("mesh_done(summary, branch?, mr?, commit?");
  });

  it("test_AC10_skill_and_version", () => {
    expect(read("skills/mesh/SKILL.md")).toBe(MESH_SKILL);
    expect(MESH_SKILL).toContain("pass `commit` only when the work is in a");
    expect((JSON.parse(read("package.json")) as { version: string }).version).toBe("0.1.41");
  });
});
