// Find local checkouts for `mesh run <repo>` (plan §3.1, §7): a path, or a folder name under the
// workspace roots.

import { existsSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";

export function defaultRoots(cwd: string, configured: readonly string[], home = homedir()): string[] {
  const roots = [...configured, cwd, dirname(cwd), join(home, "src"), join(home, "code"), join(home, "work")];
  return [...new Set(roots.map((r) => resolve(r.replace(/^~(?=$|\/)/, home))))].filter((r) => existsSync(r));
}

const isRepo = (dir: string) => existsSync(join(dir, ".git"));

function children(dir: string): string[] {
  try {
    return readdirSync(dir)
      .filter((n) => !n.startsWith("."))
      .map((n) => join(dir, n))
      .filter((p) => {
        try {
          return statSync(p).isDirectory();
        } catch {
          return false;
        }
      });
  } catch {
    return [];
  }
}

/** Resolve one argument to a checkout directory. Throws with candidates when ambiguous. */
export function resolveRepo(arg: string, roots: readonly string[]): string {
  const direct = resolve(arg.replace(/^~(?=$|\/)/, homedir()));
  if (existsSync(direct) && isRepo(direct)) return direct;
  if (existsSync(direct) && statSync(direct).isDirectory() && (arg.includes("/") || arg.startsWith("."))) {
    throw new Error(`${direct} is not a git checkout`);
  }
  const name = basename(arg);
  const found = new Set<string>();
  for (const root of roots) {
    if (basename(root) === name && isRepo(root)) found.add(root);
    for (const child of children(root)) {
      if (basename(child) === name && isRepo(child)) found.add(child);
      for (const grandchild of children(child)) if (basename(grandchild) === name && isRepo(grandchild)) found.add(grandchild);
    }
  }
  if (found.size === 1) return [...found][0] as string;
  if (found.size === 0) {
    throw new Error(`no checkout named "${name}" under ${roots.join(", ")}. Pass a path, or add the parent folder to "workspaceRoots" in daemon.json.`);
  }
  throw new Error(`"${name}" is ambiguous:\n  ${[...found].join("\n  ")}\nPass a path instead.`);
}
