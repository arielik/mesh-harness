// A machine's repo inventory (MM-1): ids and names of the git checkouts under the configured
// workspace roots, read from .git without spawning git. Never contains a path.

import { readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Repo } from "../protocol/index.ts";
import { repoForCwd } from "./git.ts";

/** The daemon rescans the workspace roots at most once per this interval. */
export const REPO_SCAN_MS = 300_000;
/** Most repos one inventory carries (SyncRequest allows 500). */
export const REPO_INVENTORY_MAX = 500;
/** How deep below a root a checkout is looked for (as `mesh run` resolves repos). */
const SCAN_DEPTH = 2;

function expandHome(root: string): string {
  if (root === "~") return homedir();
  if (root.startsWith("~/")) return join(homedir(), root.slice(2));
  return root;
}

function exists(p: string): boolean {
  try {
    statSync(p);
    return true;
  } catch {
    return false;
  }
}

function isDir(p: string): boolean {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Deduplicate by id, drop checkouts without a remote and `local/` ids (a file path), sort by name
 * then id, and keep at most REPO_INVENTORY_MAX.
 */
export function repoInventory(repos: Iterable<Repo | undefined>): Repo[] {
  const byId = new Map<string, Repo>();
  for (const r of repos) {
    if (!r || r.id.startsWith("local/") || byId.has(r.id)) continue;
    byId.set(r.id, { id: r.id, name: r.name });
  }
  return [...byId.values()]
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    .slice(0, REPO_INVENTORY_MAX);
}

/**
 * The repos of the git checkouts (a `.git` folder or file) at depth 0, 1 and 2 under each root
 * (a leading `~` is the home folder). Hidden folders and `node_modules` are skipped, a checkout is
 * not descended into, and missing or unreadable roots are ignored.
 */
export function scanRepos(roots: readonly string[]): Repo[] {
  const found: (Repo | undefined)[] = [];
  const visit = (dir: string, depth: number): void => {
    if (exists(join(dir, ".git"))) {
      found.push(repoForCwd(dir));
      return;
    }
    if (depth >= SCAN_DEPTH) return;
    let names: string[];
    try {
      names = readdirSync(dir);
    } catch {
      return;
    }
    for (const name of names.sort()) {
      if (name.startsWith(".") || name === "node_modules") continue;
      const child = join(dir, name);
      if (isDir(child)) visit(child, depth + 1);
    }
  };
  for (const root of roots) visit(expandHome(root), 0);
  return repoInventory(found);
}
