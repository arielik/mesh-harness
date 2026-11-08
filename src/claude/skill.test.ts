import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { MESH_SKILL, SKILL_MARKER } from "../protocol/index.ts";
import { installSkill, skillStatus, uninstallSkill } from "./skill.ts";

const dirs: string[] = [];
const skillPath = () => {
  const d = mkdtempSync(join(tmpdir(), "mesh-skill-"));
  dirs.push(d);
  return join(d, "skills", "mesh", "SKILL.md");
};
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe("the mesh skill", () => {
  it("installs, is current, and uninstalls with its folder", () => {
    const p = skillPath();
    expect(skillStatus(p)).toBe("missing");
    expect(installSkill(p)).toEqual({ changed: true, foreign: false });
    expect(readFileSync(p, "utf8")).toBe(MESH_SKILL);
    expect(skillStatus(p)).toBe("current");
    expect(installSkill(p).changed).toBe(false);
    expect(uninstallSkill(p).changed).toBe(true);
    expect(existsSync(dirname(p))).toBe(false);
  });

  it("refreshes an outdated copy of its own", () => {
    const p = skillPath();
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, `---\nname: mesh\n---\n${SKILL_MARKER}\nold text\n`);
    expect(skillStatus(p)).toBe("outdated");
    expect(installSkill(p).changed).toBe(true);
    expect(skillStatus(p)).toBe("current");
  });

  it("never touches a skill named mesh that it did not write", () => {
    const p = skillPath();
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, "---\nname: mesh\n---\nsomeone else's\n");
    expect(skillStatus(p)).toBe("foreign");
    expect(installSkill(p)).toEqual({ changed: false, foreign: true });
    expect(uninstallSkill(p).changed).toBe(false);
    expect(readFileSync(p, "utf8")).toContain("someone else's");
  });

  it("has the frontmatter Claude Code needs", () => {
    expect(MESH_SKILL).toMatch(/^---\nname: mesh\ndescription: .{80,1024}\n---\n/);
  });
});
