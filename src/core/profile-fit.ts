// RL-16: profile fitting. From the headless runs of one permission profile, the denied tools and
// command words and the tools offered but never used, each suggested as a profile change or held with
// a reason. Pure: the hub reads the runs, this decides. Nothing here writes a profile.

import { stringify } from "yaml";
import { PROFILE_FIT, type FitDenied, type FitHeld, type FitUnused, type ProfileBase, type ProfileFit, type ProfileFitHash, type ProfileSettings, type RunTelemetry } from "../protocol/index.ts";
import { parseProfile } from "./profiles.ts";

/** A command word a `Bash(<word> *)` rule can hold without quoting or glob characters. */
export const FIT_WORD = /^[A-Za-z0-9_][A-Za-z0-9._+-]*$/;
/** A tool name a bare rule can hold (`mcp__<server>__<tool>` included). */
export const FIT_TOOL = /^[A-Za-z_][A-Za-z0-9_.-]*$/;

/** Command words that run another command or arbitrary code: `Bash(<word> *)` would be as wide as `Bash(*)`. */
export const RUNS_ANYTHING: readonly string[] = [
  "bash",
  "sh",
  "zsh",
  "dash",
  "ksh",
  "fish",
  "csh",
  "tcsh",
  "env",
  "sudo",
  "su",
  "doas",
  "xargs",
  "eval",
  "exec",
  "nohup",
  "timeout",
  "nice",
  "ionice",
  "time",
  "watch",
  "command",
  "builtin",
  "source",
  "ssh",
  "python",
  "python3",
  "node",
  "perl",
  "ruby",
  "php",
  "deno",
  "bun",
  "npx",
  "pnpx",
  "bunx",
  "uvx",
  "uv",
  "pipx",
  "awk",
  "gawk",
  "mawk",
  "nawk",
  "lua",
  "tclsh",
  "pwsh",
  "busybox",
  "setsid",
  "stdbuf",
  "unbuffer",
  "flock",
  "chroot",
  "nsenter",
  "strace",
  "ltrace",
  "gdb",
  "parallel",
  "script",
];
const RUNS_ANYTHING_SET: ReadonlySet<string> = new Set(RUNS_ANYTHING);

/** The most entries `denied` and `unused` list. */
export const FIT_LIST_MAX = 200;

/** UTF-16 code-unit order (JavaScript's string `<`). */
const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/** The allow rule of a denial, or undefined when none can be built. */
export function fitAllowRule(tool: string, command: string | undefined): string | undefined {
  if (tool === "Bash") return command !== undefined && FIT_WORD.test(command) ? `Bash(${command} *)` : undefined;
  return FIT_TOOL.test(tool) ? tool : undefined;
}

/** The server-wide rules that also cover an MCP tool `mcp__<server>__<name>`. */
function serverRules(tool: string): string[] {
  const m = /^(mcp__[^_](?:[^_]|_(?!_))*)__./.exec(tool);
  return m ? [m[1] as string, `${m[1] as string}__*`] : [];
}

/** Does a rule (allow or deny) apply to this tool rule: `T`, `T(…)`, or the tool's MCP server? */
function ruleOnTool(rule: string, tool: string): boolean {
  return rule === tool || rule.startsWith(`${tool}(`) || serverRules(tool).includes(rule);
}

/** Does a deny rule cover this allow rule (so allowing it would fight the profile's denies)? */
export function denyCovers(deny: string, rule: string): boolean {
  const bash = /^Bash\((.+) \*\)$/.exec(rule);
  if (!bash) return ruleOnTool(deny, rule);
  const w = bash[1] as string;
  if (deny === "Bash") return true;
  const inner = /^Bash\((.*)\)$/s.exec(deny)?.[1];
  if (inner === undefined) return false;
  const first = inner.split(/[ :]/)[0] as string;
  if (first === w) return true;
  const star = first.indexOf("*");
  return star >= 0 && w.startsWith(first.slice(0, star));
}

/** Does an allow rule name this tool? */
const names = ruleOnTool;

/** Tools a fit never drops besides mesh's own: the one that loads the mesh skill. */
const NEVER_DROP: ReadonlySet<string> = new Set(["Skill"]);

/** One run of the profile, as the hub found it. */
export interface FitRun {
  finishedAt: number;
  telemetry: RunTelemetry;
}

export interface FitInput {
  profile: { name: string; builtIn: boolean; base: ProfileBase; sha256: string; settings: ProfileSettings; text?: string | undefined };
  /** The profile's runs: `telemetry.profile` is the profile, in the window, passing `trial`. */
  runs: readonly FitRun[];
  window: { since: number; until: number; days: number };
  trial: "exclude" | "include";
}

/** The fit report of one profile (docs/specs/RL-16.md). */
export function fitProfile(input: FitInput): ProfileFit {
  const { profile } = input;
  const allow = profile.settings.permissions.allow;
  const deny = profile.settings.permissions.deny;

  // hashes: the current one first, then the others by lastAt descending, then sha256.
  const byHash = new Map<string, ProfileFitHash>();
  const hashOf = (h: string): ProfileFitHash => {
    let e = byHash.get(h);
    if (!e) {
      e = { sha256: h, current: h === profile.sha256, runs: 0, toolRuns: 0, deniedRuns: 0, denials: 0 };
      byHash.set(h, e);
    }
    return e;
  };
  hashOf(profile.sha256);
  const isToolRun = (t: RunTelemetry) => t.tools !== undefined && t.toolsUsed !== undefined;
  for (const r of input.runs) {
    const t = r.telemetry;
    const e = hashOf(t.profileHash);
    e.runs++;
    if (isToolRun(t)) e.toolRuns++;
    if (t.permissionDenials.count > 0) e.deniedRuns++;
    e.denials += t.permissionDenials.count;
    e.firstAt = e.firstAt === undefined ? r.finishedAt : Math.min(e.firstAt, r.finishedAt);
    e.lastAt = e.lastAt === undefined ? r.finishedAt : Math.max(e.lastAt, r.finishedAt);
  }
  const current = byHash.get(profile.sha256) as ProfileFitHash;
  const others = [...byHash.values()].filter((e) => !e.current).sort((a, b) => (b.lastAt ?? 0) - (a.lastAt ?? 0) || cmp(a.sha256, b.sha256));
  const hashes = [current, ...others];

  const sampleRuns = input.runs.filter((r) => r.telemetry.profileHash === profile.sha256);
  const toolRuns = sampleRuns.filter((r) => isToolRun(r.telemetry));
  const sample = { runs: sampleRuns.length, toolRuns: toolRuns.length };

  // Validation: the profile file with the diff so far and one more rule, through parseProfile.
  let file: Record<string, unknown> | undefined;
  let fileError: string | undefined;
  if (profile.builtIn) file = { extends: profile.base };
  else {
    const parsed = parseProfile(profile.text ?? "");
    if ("error" in parsed) fileError = parsed.error;
    else file = { ...parsed.file };
  }
  const diff = { allow: [] as string[], deny: [] as string[] };
  const refusal = (extra: { allow?: string; deny?: string }): string | undefined => {
    if (!file) return fileError ?? "profile is not valid";
    const f = file as { allow?: string[]; deny?: string[] };
    const cand = {
      ...file,
      allow: [...(f.allow ?? []), ...diff.allow, ...(extra.allow !== undefined ? [extra.allow] : [])],
      deny: [...(f.deny ?? []), ...diff.deny, ...(extra.deny !== undefined ? [extra.deny] : [])],
    };
    const r = parseProfile(stringify(cand));
    return "error" in r ? r.error : undefined;
  };

  // denied
  const groups = new Map<string, { tool: string; command?: string; runs: number; count: number }>();
  for (const r of sampleRuns) {
    for (const d of r.telemetry.denied ?? []) {
      const key = `${d.tool}\n${d.command === undefined ? "-" : `+${d.command}`}`;
      let g = groups.get(key);
      if (!g) {
        g = { tool: d.tool, ...(d.command !== undefined ? { command: d.command } : {}), runs: 0, count: 0 };
        groups.set(key, g);
      }
      g.runs++;
      g.count += d.count;
    }
  }
  const deniedAll = [...groups.values()].sort(
    (a, b) =>
      b.runs - a.runs ||
      b.count - a.count ||
      cmp(a.tool, b.tool) ||
      (a.command === undefined ? (b.command === undefined ? 0 : -1) : b.command === undefined ? 1 : cmp(a.command, b.command)),
  );
  const frequentAt = Math.ceil(PROFILE_FIT.minShare * sample.runs);
  const denied: FitDenied[] = deniedAll.map((g) => {
    const rule = fitAllowRule(g.tool, g.command);
    let held: FitHeld | undefined;
    let why: string | undefined;
    if (g.tool === "Bash" && g.command === undefined) held = "no-command";
    else if (rule === undefined) held = "not-a-word";
    else if (g.tool === "Bash" && RUNS_ANYTHING_SET.has(g.command as string)) held = "runs-anything";
    else if (allow.includes(rule)) held = "already-allowed";
    else if (deny.some((d) => denyCovers(d, rule))) held = "denied-by-profile";
    else if (sample.runs < PROFILE_FIT.minRuns) held = "few-runs";
    else if (g.runs < frequentAt) held = "rare";
    else {
      why = refusal({ allow: rule });
      if (why !== undefined) held = "refused";
    }
    if (held === undefined && rule !== undefined) diff.allow.push(rule);
    return {
      tool: g.tool,
      ...(g.command !== undefined ? { command: g.command } : {}),
      runs: g.runs,
      count: g.count,
      ...(rule !== undefined ? { rule } : {}),
      suggest: held === undefined,
      ...(held !== undefined ? { held } : {}),
      ...(why !== undefined ? { refusal: why } : {}),
    };
  });

  // unused
  const offered = new Map<string, number>();
  const used = new Set<string>();
  for (const r of toolRuns) {
    for (const t of new Set(r.telemetry.tools ?? [])) offered.set(t, (offered.get(t) ?? 0) + 1);
    for (const t of r.telemetry.toolsUsed ?? []) used.add(t);
  }
  const unusedAll = [...offered.entries()].filter(([t]) => !used.has(t)).sort(([a, na], [b, nb]) => nb - na || cmp(a, b));
  const unused: FitUnused[] = unusedAll.map(([tool, offeredRuns]) => {
    let held: FitHeld | undefined;
    let why: string | undefined;
    if (tool.startsWith("mcp__mesh__") || NEVER_DROP.has(tool)) held = "mesh-tool";
    else if (allow.some((a) => names(a, tool))) held = "allowed";
    else if (deny.includes(tool)) held = "already-denied";
    else if (!FIT_TOOL.test(tool)) held = "not-a-word";
    else if (sample.toolRuns < PROFILE_FIT.minRuns || offeredRuns < PROFILE_FIT.minRuns) held = "few-runs";
    else {
      why = refusal({ deny: tool });
      if (why !== undefined) held = "refused";
    }
    if (held === undefined) diff.deny.push(tool);
    return { tool, offeredRuns, suggest: held === undefined, ...(held !== undefined ? { held } : {}), ...(why !== undefined ? { refusal: why } : {}) };
  });

  const cutDenied = Math.max(0, denied.length - FIT_LIST_MAX);
  const cutUnused = Math.max(0, unused.length - FIT_LIST_MAX);
  return {
    profile: profile.name,
    builtIn: profile.builtIn,
    base: profile.base,
    sha256: profile.sha256,
    window: input.window,
    trial: input.trial,
    thresholds: { ...PROFILE_FIT },
    hashes,
    sample,
    denied: denied.slice(0, FIT_LIST_MAX),
    unused: unused.slice(0, FIT_LIST_MAX),
    ...(cutDenied || cutUnused ? { truncated: { denied: cutDenied, unused: cutUnused } } : {}),
    diff,
  };
}
