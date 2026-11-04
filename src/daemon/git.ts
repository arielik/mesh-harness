// Repo identity for a working directory, read straight from .git (no git process).

import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { repoFromRemote } from "../core/index.ts";
import type { Repo } from "../protocol/index.ts";

/** Find the git dir for `cwd` (walking up), following `.git` files used by worktrees. */
export function findGitDir(cwd: string): string | undefined {
  let dir = resolve(cwd);
  for (;;) {
    const dotGit = join(dir, ".git");
    if (existsSync(dotGit)) {
      if (statSync(dotGit).isDirectory()) return dotGit;
      const m = /^gitdir:\s*(.+)$/m.exec(readFileSync(dotGit, "utf8"));
      if (m?.[1]) {
        const gitdir = m[1].trim();
        return isAbsolute(gitdir) ? gitdir : resolve(dir, gitdir);
      }
      return undefined;
    }
    const parent = dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

/** The config file of the repository (the common dir for worktrees). */
function configFile(gitDir: string): string {
  const common = join(gitDir, "commondir");
  if (existsSync(common)) {
    const c = readFileSync(common, "utf8").trim();
    return join(isAbsolute(c) ? c : resolve(gitDir, c), "config");
  }
  return join(gitDir, "config");
}

/** Remote URLs by name from a git config file's text. */
export function parseRemotes(config: string): Map<string, string> {
  const remotes = new Map<string, string>();
  let current: string | undefined;
  for (const raw of config.split("\n")) {
    const line = raw.trim();
    const section = /^\[remote\s+"([^"]+)"\]$/.exec(line);
    if (section) {
      current = section[1];
      continue;
    }
    if (line.startsWith("[")) {
      current = undefined;
      continue;
    }
    const url = /^url\s*=\s*(.+)$/.exec(line);
    if (current && url?.[1] && !remotes.has(current)) remotes.set(current, url[1].trim());
  }
  return remotes;
}

/** Repo for a working directory: the `origin` remote, else the first remote. */
export function repoForCwd(cwd: string): Repo | undefined {
  if (!cwd) return undefined;
  try {
    const gitDir = findGitDir(cwd);
    if (!gitDir) return undefined;
    const remotes = parseRemotes(readFileSync(configFile(gitDir), "utf8"));
    const url = remotes.get("origin") ?? remotes.values().next().value;
    return url ? repoFromRemote(url) : undefined;
  } catch {
    return undefined;
  }
}

/** The working tree root for `cwd` (the folder holding `.git`, a dir or a worktree's file). */
export function findRepoRoot(cwd: string): string | undefined {
  let dir = resolve(cwd);
  for (;;) {
    if (existsSync(join(dir, ".git"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}
