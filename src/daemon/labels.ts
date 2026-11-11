// MM-2: which labels a new session gets. The checkout key of a cwd, the repo default from
// `.mesh/agent.yaml`, and the order of the sources (a remembered list replaces the repo default).

import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parse } from "yaml";
import { parseLabels } from "../protocol/index.ts";
import { findRepoRoot } from "./git.ts";

/** The checkout a cwd is in: the nearest folder at or above it with a `.git` folder or file. */
export function checkoutTop(cwd: string): string | undefined {
  return findRepoRoot(cwd);
}

/** The key labels are remembered under: the checkout top, else the cwd itself (absolute). */
export function checkoutKey(cwd: string): string {
  return checkoutTop(cwd) ?? resolve(cwd);
}

/**
 * The repo default: `labels` in `.mesh/agent.yaml` at the checkout top, normalised. Undefined when
 * there is none; a broken file logs one line and counts as none.
 */
export function repoDefaultLabels(cwd: string, log: (line: string) => void): string[] | undefined {
  const top = checkoutTop(cwd);
  if (!top) return undefined;
  const file = join(top, ".mesh", "agent.yaml");
  if (!existsSync(file)) return undefined;
  let doc: unknown;
  try {
    doc = parse(readFileSync(file, "utf8"));
  } catch (e) {
    log(`${file}: ignored (${(e as Error).message.split("\n")[0] ?? "unreadable"})`);
    return undefined;
  }
  const labels = doc && typeof doc === "object" ? (doc as Record<string, unknown>).labels : undefined;
  if (labels === undefined || labels === null) return undefined;
  if (!Array.isArray(labels) || !labels.every((l) => typeof l === "string")) {
    log(`${file}: ignored (labels must be a list of strings)`);
    return undefined;
  }
  const r = parseLabels(labels as string[]);
  if ("error" in r) {
    log(`${file}: ignored (${r.error})`);
    return undefined;
  }
  return r.labels;
}

/** The labels a session first recorded in `cwd` gets: the remembered list, else the repo default. */
export function initialLabels(cwd: string, remembered: (key: string) => string[] | undefined, log: (line: string) => void): string[] | undefined {
  const mem = remembered(checkoutKey(cwd));
  if (mem !== undefined) return mem;
  return repoDefaultLabels(cwd, log);
}
