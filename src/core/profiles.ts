// RL-1: permission profiles of headless runs. A profile compiles to Claude Code `permissions`
// settings; every allow list starts with the mesh tool rules. Pure (hashing only).

import { createHash } from "node:crypto";
import { parse } from "yaml";
import { MESH_TOOL_RULES, ProfileFile, type ProfileBase, type ProfileSettings, type ProfileSnapshot } from "../protocol/index.ts";

const READ_ONLY_ALLOW = [
  "Read",
  "Grep",
  "Glob",
  "LS",
  "Bash(git log --no-ext-diff *)",
  "Bash(git show --no-ext-diff *)",
  "Bash(git rev-parse *)",
  "Bash(git ls-files *)",
  "Bash(git cat-file *)",
];
const GIT_DENY = ["Bash(git * --output*)", "Bash(git -c *)", "Bash(git * --ext-diff*)"];
const READ_ONLY_DENY = [...GIT_DENY, "Edit", "Write", "NotebookEdit", "WebFetch", "WebSearch"];

const readOnly = (): ProfileSettings => ({ permissions: { allow: [...MESH_TOOL_RULES, ...READ_ONLY_ALLOW], deny: [...READ_ONLY_DENY] } });

export interface BuiltinProfile {
  name: ProfileBase;
  description: string;
  base: ProfileBase;
  settings: ProfileSettings;
}

/** The three built-in profiles, in this order. */
export const BUILTIN_PROFILES: readonly BuiltinProfile[] = [
  { name: "read-only", base: "read-only", description: "Read the repo; no edits, no commands but read-only git.", settings: readOnly() },
  { name: "read-only+checks", base: "read-only+checks", description: "As read-only; registered profiles add their check commands.", settings: readOnly() },
  {
    name: "propose-via-branch",
    base: "propose-via-branch",
    description: "Edit and commit in the run's worktree; the daemon pushes mesh/<slug>.",
    settings: {
      permissions: {
        allow: [...MESH_TOOL_RULES, ...READ_ONLY_ALLOW, "Edit", "Write", "Bash(git add *)", "Bash(git commit *)"],
        deny: [...GIT_DENY, "Bash(git push *)", "NotebookEdit", "WebFetch", "WebSearch"],
      },
    },
  },
];

export function builtinProfile(name: string): BuiltinProfile | undefined {
  return BUILTIN_PROFILES.find((b) => b.name === name);
}

const dedupe = (xs: readonly string[]): string[] => [...new Set(xs)];

/** A registered profile's settings: its base's rules, then its checks (as `Bash(<c>)`) and allows, then denies. */
export function compileProfile(file: ProfileFile): { base: ProfileSnapshot["base"]; settings: ProfileSettings } {
  const base = builtinProfile(file.extends) ?? (BUILTIN_PROFILES[0] as BuiltinProfile);
  return {
    base: file.extends,
    settings: {
      permissions: {
        allow: dedupe([...base.settings.permissions.allow, ...(file.checks ?? []).map((c) => `Bash(${c})`), ...(file.allow ?? [])]),
        deny: dedupe([...base.settings.permissions.deny, ...(file.deny ?? [])]),
      },
    },
  };
}

/** Lowercase hex SHA-256 of `JSON.stringify({ base, settings })`. */
export function profileSha256(base: string, settings: ProfileSettings): string {
  return createHash("sha256").update(JSON.stringify({ base, settings })).digest("hex");
}

/** A snapshot of a profile, with its hash. */
export function profileSnapshot(name: string, base: ProfileBase, settings: ProfileSettings): ProfileSnapshot {
  return { name, base, sha256: profileSha256(base, settings), settings };
}

const MESH_RULES: ReadonlySet<string> = new Set(MESH_TOOL_RULES);
const meshRuleRefused = (r: string) => r === "mcp__mesh" || (r.startsWith("mcp__mesh__") && !MESH_RULES.has(r));

/** Parse and check a registered profile's YAML text. */
export function parseProfile(text: string): { file: ProfileFile } | { error: string } {
  let doc: unknown;
  try {
    doc = parse(text);
  } catch (e) {
    return { error: `profile is not valid YAML: ${(e as Error).message}` };
  }
  const r = ProfileFile.safeParse(doc ?? {});
  if (!r.success) {
    const issue = r.error.issues[0];
    if (!issue) return { error: "profile is not valid" };
    const keys = (issue as { keys?: string[] }).keys;
    const path = issue.path.length ? issue.path.join(".") : keys?.length ? keys.join(", ") : "(root)";
    return { error: `${path}: ${issue.message}` };
  }
  const file = r.data;
  const refuse = (rule: string) => ({ error: `profiles may not allow ${rule}` });
  for (const a of file.allow ?? []) {
    if (meshRuleRefused(a) || a === "Bash" || a === "Bash(*)" || a === "Bash(:*)" || a.includes("git push")) return refuse(a);
  }
  for (const c of file.checks ?? []) {
    if (meshRuleRefused(c) || c === "*" || c.includes("git push")) return refuse(`Bash(${c})`);
  }
  return { file };
}
