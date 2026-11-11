// Git checkouts for tests, written as files (no git process): a `.git` folder with HEAD and a config
// naming the remote, or a worktree's `.git` file pointing at a git dir elsewhere. Enough for the
// daemon's git readers, which parse these files themselves.

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

function gitDir(dir: string, remote: string | undefined): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "HEAD"), "ref: refs/heads/main\n");
  const origin = remote ? `[remote "origin"]\n\turl = ${remote}\n\tfetch = +refs/heads/*:refs/remotes/origin/*\n` : "";
  writeFileSync(join(dir, "config"), `[core]\n\trepositoryformatversion = 0\n\tbare = false\n${origin}`);
}

/** A checkout at `dir` whose origin is `remote` (none when undefined). */
export function fakeCheckout(dir: string, remote?: string): string {
  mkdirSync(dir, { recursive: true });
  gitDir(join(dir, ".git"), remote);
  return dir;
}

/** A worktree-style checkout at `dir`: a `.git` file pointing at `store`, a git dir with `remote`. */
export function fakeWorktree(dir: string, store: string, remote: string): string {
  gitDir(store, remote);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, ".git"), `gitdir: ${store}\n`);
  return dir;
}
