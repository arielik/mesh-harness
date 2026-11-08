import { existsSync } from "node:fs";
import { dirname, join, normalize, resolve } from "node:path";
import { writeFileAtomic, type TrailFile } from "../protocol/index.ts";

/** Write trail files into the git checkout containing `cwd`; returns the paths written. */
export function writeTrailHere(cwd: string, files: readonly TrailFile[]): string[] {
  let root = resolve(cwd);
  while (!existsSync(join(root, ".git"))) {
    const up = dirname(root);
    if (up === root) return [];
    root = up;
  }
  const out: string[] = [];
  for (const f of files) {
    const rel = normalize(f.path);
    if (!rel.startsWith(".mesh/") || rel.includes("..")) continue;
    writeFileAtomic(join(root, rel), f.text);
    out.push(rel);
  }
  return out;
}
