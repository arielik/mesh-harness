// Claude Code asks "Do you trust this folder?" the first time it starts in a folder, before any hook
// runs. `mesh run` checks Claude's own record (projects.<folder>.hasTrustDialogAccepted in
// ~/.claude.json) so it can tell the person which windows wait for that answer.

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

/** Where Claude Code keeps its global state: $CLAUDE_CONFIG_DIR/.claude.json, else ~/.claude.json. */
export function claudeStatePath(env: Record<string, string | undefined> = process.env, home = homedir()): string {
  return env.CLAUDE_CONFIG_DIR ? join(env.CLAUDE_CONFIG_DIR, ".claude.json") : join(home, ".claude.json");
}

/**
 * Has the person accepted the trust prompt for this folder? Trust is recorded per folder (a trusted
 * parent does not count). `undefined` when Claude's state can't be read.
 */
export function folderTrusted(dir: string, statePath = claudeStatePath()): boolean | undefined {
  if (!existsSync(statePath)) return undefined;
  try {
    const state = JSON.parse(readFileSync(statePath, "utf8")) as { projects?: Record<string, { hasTrustDialogAccepted?: boolean }> };
    return state.projects?.[resolve(dir)]?.hasTrustDialogAccepted === true;
  } catch {
    return undefined;
  }
}
