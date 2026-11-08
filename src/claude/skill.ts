// `mesh setup` installs the mesh skill into Claude Code's user skills folder
// (~/.claude/skills/mesh/SKILL.md). It replaces the block older versions added to ~/.claude/CLAUDE.md:
// a skill is loaded only when a session needs it, and `mesh skill` prints the copy that matches
// the installed mesh.

import { existsSync, readdirSync, readFileSync, rmSync, rmdirSync } from "node:fs";
import { dirname } from "node:path";
import { MESH_SKILL, SKILL_MARKER, writeFileAtomic } from "../protocol/index.ts";

export type SkillStatus = "missing" | "current" | "outdated" | "foreign";

export function skillStatus(path: string): SkillStatus {
  if (!existsSync(path)) return "missing";
  const text = readFileSync(path, "utf8");
  if (!text.includes(SKILL_MARKER)) return "foreign";
  return text === MESH_SKILL ? "current" : "outdated";
}

/**
 * Write the skill. A SKILL.md at that path that mesh did not write is left alone (the result says
 * so); mesh's own copy is refreshed when it is out of date.
 */
export function installSkill(path: string): { changed: boolean; foreign: boolean } {
  const st = skillStatus(path);
  if (st === "foreign") return { changed: false, foreign: true };
  if (st === "current") return { changed: false, foreign: false };
  writeFileAtomic(path, MESH_SKILL);
  return { changed: true, foreign: false };
}

/** Remove mesh's skill (only if mesh wrote it), and its folder when that leaves it empty. */
export function uninstallSkill(path: string): { changed: boolean } {
  const st = skillStatus(path);
  if (st === "missing" || st === "foreign") return { changed: false };
  rmSync(path);
  // The mesh folder, then the skills folder if mesh's was the only thing in it.
  for (const dir of [dirname(path), dirname(dirname(path))]) {
    try {
      if (readdirSync(dir).length > 0) break;
      rmdirSync(dir);
    } catch {
      break;
    }
  }
  return { changed: true };
}
