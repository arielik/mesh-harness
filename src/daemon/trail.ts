// Write trail files (goal.yaml, plan versions, step records) into a session's repo so the agent
// commits them with its work (journeys doc §3.1).

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, normalize } from "node:path";
import type { TrailFile } from "../protocol/index.ts";
import { findRepoRoot } from "./git.ts";

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
