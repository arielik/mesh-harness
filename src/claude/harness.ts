// The harness hash (M4, owner decision 4): what shapes an agent besides the model. Hashes only;
// file contents never leave this function.
//   repo    — CLAUDE.md and .claude/** at the repo root
//   user    — ~/.claude CLAUDE.md, agents/**, skills/**
//   plugins — installed plugin names and versions
//   mesh    — the mesh version

import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import type { Harness } from "../protocol/index.ts";

const MAX_FILES = 3000;
const MAX_BYTES = 2 << 20;
/** Under .claude these are state, not harness. */
const SKIP = new Set(["worktrees", "projects", "todos", "shell-snapshots", "statsig", "logs", "cache", "ide", "plans", "file-history", "session-env", "settings.local.json", ".DS_Store"]);

const sha = (s: string | Buffer) => createHash("sha256").update(s).digest("hex");

function walk(root: string, rel: string, out: string[]): void {
  if (out.length >= MAX_FILES) return;
  const dir = join(root, rel);
  let entries: string[];
  try {
    entries = readdirSync(dir).sort();
  } catch {
    return;
  }
  for (const name of entries) {
    if (SKIP.has(name) || name.startsWith(".mesh-backup")) continue;
    const r = rel ? `${rel}/${name}` : name;
    let st;
    try {
      st = statSync(join(root, r));
    } catch {
      continue;
    }
    if (st.isDirectory()) walk(root, r, out);
    else if (st.isFile() && st.size <= MAX_BYTES) out.push(r);
    if (out.length >= MAX_FILES) return;
  }
}

/** Hash of a set of files: their paths (relative to base) and contents. Empty set → "none". */
function hashFiles(base: string, files: readonly string[]): string {
  if (files.length === 0) return "none";
  const h = createHash("sha256");
  for (const f of [...files].sort()) {
    try {
      h.update(`${relative(base, f)}\u0000${sha(readFileSync(f))}\n`);
    } catch {
      // vanished while hashing
    }
  }
  return h.digest("hex").slice(0, 12);
}

function filesUnder(root: string, sub: string): string[] {
  const out: string[] = [];
  walk(root, sub, out);
  return out.map((r) => join(root, r));
}

function pluginsPart(claudeHome: string): string {
  const p = join(claudeHome, "plugins", "installed_plugins.json");
  if (!existsSync(p)) return "none";
  try {
    const j = JSON.parse(readFileSync(p, "utf8")) as { plugins?: Record<string, unknown> };
    const list: string[] = [];
    for (const [name, v] of Object.entries(j.plugins ?? j)) {
      const entries = Array.isArray(v) ? v : [v];
      for (const e of entries) list.push(`${name}@${String((e as { version?: string } | undefined)?.version ?? "?")}`);
    }
    return list.length ? sha(list.sort().join("\n")).slice(0, 12) : "none";
  } catch {
    return "unreadable";
  }
}

export function computeHarness(opts: { repoRoot?: string | undefined; claudeHome: string; meshVersion: string }): Harness {
  const repoFiles = opts.repoRoot ? [join(opts.repoRoot, "CLAUDE.md"), ...filesUnder(opts.repoRoot, ".claude")].filter((f) => existsSync(f)) : [];
  const userFiles = [join(opts.claudeHome, "CLAUDE.md"), ...filesUnder(opts.claudeHome, "agents"), ...filesUnder(opts.claudeHome, "skills")].filter((f) => existsSync(f));
  const parts = {
    repo: opts.repoRoot ? hashFiles(opts.repoRoot, repoFiles) : "none",
    user: hashFiles(opts.claudeHome, userFiles),
    plugins: pluginsPart(opts.claudeHome),
    mesh: opts.meshVersion,
  };
  return { hash: sha(JSON.stringify(parts)).slice(0, 12), parts };
}
