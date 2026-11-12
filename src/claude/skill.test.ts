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

// RL-4 AC-16 (unit): installSkill / skillStatus take the skill text (docs/specs/RL-4.md).
describe("RL-4 AC-16 mesh-debrief skill", () => {
  const debriefPath = () => {
    const d = mkdtempSync(join(tmpdir(), "mesh-skill-"));
    dirs.push(d);
    return join(d, "skills", "mesh-debrief", "SKILL.md");
  };

  it("test_AC16_install_text_arg", async () => {
    const protocol = (await import("../protocol/index.ts")) as Record<string, unknown>;
    const text = protocol.MESH_DEBRIEF_SKILL as string;
    expect(typeof text).toBe("string");
    const install = installSkill as unknown as (p: string, t?: string) => { changed: boolean; foreign: boolean };
    const status = skillStatus as unknown as (p: string, t?: string) => string;
    const p = debriefPath();
    expect(status(p, text)).toBe("missing");
    expect(install(p, text)).toEqual({ changed: true, foreign: false });
    expect(readFileSync(p, "utf8")).toBe(text);
    expect(status(p, text)).toBe("current");
    // The default text is the mesh skill: this file is not current for it.
    expect(status(p)).not.toBe("current");
    expect(install(p, text).changed).toBe(false);
    expect(uninstallSkill(p).changed).toBe(true);
    expect(existsSync(dirname(p))).toBe(false);
    // Control: the default install still writes the mesh skill.
    const q = skillPath();
    installSkill(q);
    expect(readFileSync(q, "utf8")).toBe(MESH_SKILL);
  });
});

// RL-7 AC-16: the "Headless runs" section says the step record mesh writes is not committed in a
// headless run, because the run's worktree is discarded (docs/specs/RL-7.md, Docs).
describe("RL-7 AC-16 skill", () => {
  /** The text from the heading line holding `title` up to the next heading. */
  const section = (text: string, title: string): string => {
    const lines = text.split("\n");
    const start = lines.findIndex((l) => /^#+ /.test(l) && l.includes(title));
    if (start < 0) return "";
    const end = lines.findIndex((l, i) => i > start && /^#+ /.test(l));
    return lines.slice(start, end < 0 ? undefined : end).join("\n");
  };
  const NOT_COMMITTED = /not (be )?committed|never commit|do not commit|don't commit/i;

  it("test_AC16_skill_headless_record", () => {
    const repoSkill = readFileSync(join(import.meta.dirname, "..", "..", "skills", "mesh", "SKILL.md"), "utf8");
    expect(repoSkill).toBe(MESH_SKILL);
    const s = section(MESH_SKILL, "Headless runs");
    expect(s.length, "a Headless runs section").toBeGreaterThan(0);
    expect(s).toContain("step record");
    expect(s).toMatch(NOT_COMMITTED);
    expect(s).toMatch(/discarded/i);
    // Control: the regex is not vacuous: a section that does not say it does not match.
    expect(section(MESH_SKILL, "Pulse goals")).not.toMatch(NOT_COMMITTED);
    expect("Commit the step record with your work.").not.toMatch(NOT_COMMITTED);
  });
});
