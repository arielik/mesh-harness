// Write trail files (goal.yaml, plan versions, step records) into a session's repo so the agent
// commits them with its work (journeys doc §3.1).

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, normalize } from "node:path";
import type { TrailFile } from "../protocol/index.ts";
import { commonDir, findGitDir, findRepoRoot } from "./git.ts";

export function writeTrail(cwd: string, files: readonly TrailFile[]): { root?: string; written: string[] } {
  const root = findRepoRoot(cwd);
  if (!root) return { written: [] };
  const written: string[] = [];
  for (const f of files) {
    const rel = normalize(f.path);
    if (!rel.startsWith(".mesh/") || rel.includes("..")) continue;
    const abs = join(root, rel);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, f.text);
    written.push(rel);
  }
  return { root, written };
}

export function commitHint(written: readonly string[]): string {
  return written.length ? `Commit ${written.length === 1 ? "it" : "them"} with your work: git add ${written.join(" ")}` : "";
}

/**
 * Records of a workflow programme wait in <git-common-dir>/mesh/pending/<key>/: shared by every
 * worktree of the repo, outside any working tree. `mesh ledger stage <key>` copies them into the tree
 * that commits the ledger (owner decision 17).
 */
export function writePending(cwd: string, key: string, files: readonly TrailFile[]): string[] {
  const gitDir = findGitDir(cwd);
  if (!gitDir || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(key)) return [];
  const dir = join(commonDir(gitDir), "mesh", "pending", key);
  const written: string[] = [];
  for (const f of files) {
    const name = f.path.split("/").pop() ?? "";
    if (!/^[A-Za-z0-9._-]+\.md$/.test(name)) continue;
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, name), f.text);
    written.push(join(dir, name));
  }
  return written;
}
