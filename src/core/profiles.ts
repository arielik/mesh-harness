// RL-1: permission profiles of headless runs. A profile compiles to Claude Code `permissions`
// settings; every allow list starts with the mesh tool rules. Pure (hashing only).

import { createHash } from "node:crypto";
import { parse } from "yaml";
import { MESH_TOOL_RULES, ProfileFile, type ProfileBase, type ProfileSettings, type ProfileSnapshot } from "../protocol/index.ts";
import { HEADLESS_ENV_UNSET } from "./headless.ts";

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
  // Some Claude Code builds start `claude -p` without the Grep and Glob tools (search runs through
  // Bash), so a run's search has these shell forms; SEARCH_DENY keeps them from running or writing.
  "Bash(grep *)",
  "Bash(rg *)",
  "Bash(find *)",
];
const GIT_DENY = ["Bash(git * --output*)", "Bash(git -c *)", "Bash(git * --ext-diff*)"];
/** find actions that run commands or write files, and rg's preprocessor (it runs a command per file). */
const SEARCH_DENY = ["Bash(find *-exec*)", "Bash(find *-ok*)", "Bash(find *-delete*)", "Bash(find *-fprint*)", "Bash(find *-fls*)", "Bash(rg *--pre*)"];
const READ_ONLY_DENY = [...GIT_DENY, ...SEARCH_DENY, "Edit", "Write", "NotebookEdit", "WebFetch", "WebSearch"];

const readOnly = (): ProfileSettings => ({ permissions: { allow: [...MESH_TOOL_RULES, ...READ_ONLY_ALLOW], deny: [...READ_ONLY_DENY] } });

export interface BuiltinProfile {
  name: ProfileBase;
  description: string;
  base: ProfileBase;
  settings: ProfileSettings;
}

/** The three built-in profiles, in this order. */
export const BUILTIN_PROFILES: readonly BuiltinProfile[] = [
  { name: "read-only", base: "read-only", description: "Read the repo; no edits, no commands but read-only git and search.", settings: readOnly() },
  { name: "read-only+checks", base: "read-only+checks", description: "As read-only; registered profiles add their check commands.", settings: readOnly() },
  {
    name: "propose-via-branch",
    base: "propose-via-branch",
    description: "Edit and commit in the run's worktree; the daemon pushes mesh/<slug>.",
    settings: {
      permissions: {
        allow: [...MESH_TOOL_RULES, ...READ_ONLY_ALLOW, "Edit", "Write", "Bash(git add *)", "Bash(git commit *)"],
        deny: [...GIT_DENY, ...SEARCH_DENY, "Bash(git push *)", "NotebookEdit", "WebFetch", "WebSearch"],
      },
    },
  },
];

export function builtinProfile(name: string): BuiltinProfile | undefined {
  return BUILTIN_PROFILES.find((b) => b.name === name);
}

const dedupe = (xs: readonly string[]): string[] => [...new Set(xs)];

/**
 * A registered profile's settings: its base's rules, then its checks (as `Bash(<c>)`) and allows,
 * then denies; `env` only when the profile sets variables (so a profile without them keeps its hash).
 */
export function compileProfile(file: ProfileFile): { base: ProfileSnapshot["base"]; settings: ProfileSettings } {
  const base = builtinProfile(file.extends) ?? (BUILTIN_PROFILES[0] as BuiltinProfile);
  const env = file.env && Object.keys(file.env).length ? Object.fromEntries(Object.entries(file.env).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) : undefined;
  return {
    base: file.extends,
    settings: {
      permissions: {
        allow: dedupe([...base.settings.permissions.allow, ...(file.checks ?? []).map((c) => `Bash(${c})`), ...(file.allow ?? [])]),
        deny: dedupe([...base.settings.permissions.deny, ...(file.deny ?? [])]),
      },
      ...(env ? { env } : {}),
    },
  };
}

/** The most variables a profile sets, and the longest value. */
export const PROFILE_ENV_MAX = 50;
export const PROFILE_ENV_VALUE_MAX = 1000;

/**
 * Variables a profile may not set: mesh's own (`MESH_ENV_RESERVED`, any `MESH_HUB_*`, and those a
 * headless run drops), Claude Code's and the API client's (`CLAUDE_*`, `ANTHROPIC_*`: endpoint,
 * credentials, tools), git's (`GIT_*`: config, ssh and diff commands) and anything that changes which
 * program runs or what it loads first (`PATH`, `LD_*`, `NODE_OPTIONS`, `BASH_ENV`, proxies, CA files,
 * ...). A run executes under its runner's login, so a profile written by another member never
 * redirects either. Other `MESH_*` names belong to other tools (a telemetry client's gateway, say) and
 * may be set; a test keeps every `MESH_*` name in mesh's source in this list.
 */
export const MESH_ENV_RESERVED = [
  "MESH_ASSETS_DIR",
  "MESH_AUTOPILOT",
  "MESH_BACKFILL",
  "MESH_CLAUDE_BIN",
  "MESH_CONFIG_DIR",
  "MESH_DEBRIEF_SKILL",
  "MESH_HOOK_PATH",
  "MESH_HUB",
  "MESH_KANIDM_SECRET",
  "MESH_MCP_INSTRUCTIONS",
  "MESH_OPENCODE_PLUGIN_VERSION",
  "MESH_PACKAGE",
  "MESH_PREFIX",
  "MESH_REPO",
  "MESH_RULES",
  "MESH_RUN",
  "MESH_SKILL",
  "MESH_STATE_DIR",
  "MESH_STEP",
  "MESH_SYSTEM_CA",
  "MESH_TEST",
  "MESH_TEST_PG_URL",
  "MESH_TOKEN",
  "MESH_TOOL_RULES",
  "MESH_VERSION",
  "MESH_NO_SETUP",
] as const;
const ENV_RESERVED_PREFIXES = ["MESH_HUB_", "CLAUDE_", "ANTHROPIC_", "GIT_", "LD_", "DYLD_"] as const;
const ENV_RESERVED = new Set<string>([
  ...HEADLESS_ENV_UNSET,
  ...MESH_ENV_RESERVED,
  "PATH",
  "HOME",
  "USER",
  "LOGNAME",
  "SHELL",
  "TMPDIR",
  "IFS",
  "ENV",
  "BASH_ENV",
  "PROMPT_COMMAND",
  "NODE_OPTIONS",
  "NODE_PATH",
  "NODE_EXTRA_CA_CERTS",
  "PYTHONPATH",
  "PYTHONHOME",
  "PYTHONSTARTUP",
  "PERL5OPT",
  "PERL5LIB",
  "RUBYOPT",
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "ALL_PROXY",
  "NO_PROXY",
  "SSL_CERT_FILE",
  "SSL_CERT_DIR",
]);

/** Why a profile may not set this variable, or undefined when it may. */
export function profileEnvError(name: string, value: string): string | undefined {
  if (!/^[A-Z_][A-Z0-9_]*$/.test(name) || name.length > 100) return `env: ${name} is not a variable name (1-100 of A-Z, 0-9 and _, not starting with a digit)`;
  if (ENV_RESERVED.has(name) || ENV_RESERVED_PREFIXES.some((p) => name.startsWith(p))) return `profiles may not set ${name}`;
  if (/[\n\r\0]/.test(value)) return `env.${name}: a value may not contain a line break or NUL`;
  if (value.length > PROFILE_ENV_VALUE_MAX) return `env.${name}: a value is at most ${PROFILE_ENV_VALUE_MAX} characters`;
  return undefined;
}

/**
 * The environment a headless run's process gets from its profile snapshot. Checked again here: a
 * snapshot comes from the hub, and a variable this version refuses never reaches the run.
 */
export function profileRunEnv(settings: ProfileSettings): { env: Record<string, string> } | { error: string } {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(settings.env ?? {})) {
    const why = typeof v === "string" ? profileEnvError(k, v) : `env.${k}: a value is a string`;
    if (why) return { error: why };
    env[k] = v;
  }
  return { env };
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
  const env = Object.entries(file.env ?? {});
  if (env.length > PROFILE_ENV_MAX) return { error: `env: a profile sets at most ${PROFILE_ENV_MAX} variables` };
  for (const [k, v] of env) {
    const why = profileEnvError(k, v);
    if (why) return { error: why };
  }
  return { file };
}
