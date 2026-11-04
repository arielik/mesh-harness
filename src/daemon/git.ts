// Repo identity for a working directory, read straight from .git (no git process).

import { createHash } from "node:crypto";
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

/** The common git dir (shared by all worktrees of a repository). */
export function commonDir(gitDir: string): string {
  const common = join(gitDir, "commondir");
  if (existsSync(common)) {
    const c = readFileSync(common, "utf8").trim();
    return isAbsolute(c) ? c : resolve(gitDir, c);
  }
  return gitDir;
}

/** The config file of the repository (the common dir for worktrees). */
function configFile(gitDir: string): string {
  return join(commonDir(gitDir), "config");
}

/** The commit checked out in `cwd` (HEAD resolved through loose refs and packed-refs). */
export function headCommit(cwd: string): string | undefined {
  try {
    const gitDir = findGitDir(cwd);
    if (!gitDir) return undefined;
    const head = readFileSync(join(gitDir, "HEAD"), "utf8").trim();
    const ref = /^ref:\s*(.+)$/.exec(head)?.[1];
    if (!ref) return /^[0-9a-f]{40}$/.test(head) ? head : undefined;
    for (const dir of [gitDir, commonDir(gitDir)]) {
      const loose = join(dir, ref);
      if (existsSync(loose)) return readFileSync(loose, "utf8").trim();
    }
    const packed = join(commonDir(gitDir), "packed-refs");
    if (existsSync(packed)) {
      for (const line of readFileSync(packed, "utf8").split("\n")) {
        const [sha, name] = line.trim().split(" ");
        if (name === ref && sha && /^[0-9a-f]{40}$/.test(sha)) return sha;
      }
    }
    return undefined;
  } catch {
    return undefined;
  }
}

/** The git blob id of a file (what `git hash-object` prints), without running git. */
export function blobSha(path: string): string | undefined {
  try {
    const data = readFileSync(path);
    return createHash("sha1").update(`blob ${data.length}\0`).update(data).digest("hex");
  } catch {
    return undefined;
  }
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
