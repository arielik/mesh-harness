// RL-16 unit tests of `fitProfile` (docs/specs/RL-16.md, "Building the report"): denied groups and
// their reasons (AC-01), thresholds (AC-02), validation through parseProfile (AC-03) and unused tools
// (AC-04). Every expected value is computed from the spec's rules over the fixture below.

import { stringify } from "yaml";
import { describe, expect, it } from "vitest";
import { BUILTIN_PROFILES, compileProfile, fitProfile, parseProfile, profileSha256, type FitInput, type FitRun } from "../src/core/index.ts";
import type { ProfileFit, RunTelemetry } from "../src/protocol/index.ts";

const WINDOW = { since: 0, until: 14 * 86_400_000, days: 14 };

/** A registered profile from YAML text, as the hub stores it. */
function registered(name: string, text: string): FitInput["profile"] {
  const parsed = parseProfile(text);
  if ("error" in parsed) throw new Error(parsed.error);
  const { base, settings } = compileProfile(parsed.file);
  return { name, builtIn: false, base, sha256: profileSha256(base, settings), settings, text };
}
function builtin(name: string): FitInput["profile"] {
  const b = BUILTIN_PROFILES.find((x) => x.name === name);
  if (!b) throw new Error(name);
  return { name, builtIn: true, base: b.base, sha256: profileSha256(b.base, b.settings), settings: b.settings };
}

type Den = { tool: string; command?: string; count: number };
/** One run at `hash` with these denials (and, optionally, offered and used tools). */
function run(hash: string, denied: Den[] = [], tools?: { offered: string[]; used?: string[] }, at = 1_000): FitRun {
  const count = denied.reduce((n, d) => n + d.count, 0);
  const t: RunTelemetry = {
    runId: `r-${Math.random()}`,
    profile: "p",
    profileHash: hash,
    turns: 1,
    turnsApprox: false,
    tokensIn: 0,
    tokensOut: 0,
    cacheRead: 0,
    cacheWrite: 0,
    durationMs: 1,
    exit: "success",
    permissionDenials: { count, tools: [...new Set(denied.map((d) => d.tool))] },
    undeclaredRules: 0,
    redactions: 0,
    ...(denied.length ? { denied } : {}),
    ...(tools ? { tools: tools.offered } : {}),
    ...(tools?.used ? { toolsUsed: [...tools.used].sort() } : {}),
  };
  return { finishedAt: at, telemetry: t };
}
const fit = (profile: FitInput["profile"], runs: FitRun[]): ProfileFit => fitProfile({ profile, runs, window: WINDOW, trial: "exclude" });
/** n runs at hash h; run i gets the denials whose predicate holds for i. */
function runs(h: string, n: number, plan: { d: Den; in: (i: number) => boolean }[]): FitRun[] {
  return Array.from({ length: n }, (_, i) => run(h, plan.filter((p) => p.in(i)).map((p) => p.d)));
}
const lt = (k: number) => (i: number) => i < k;
/** The profile file with the diff applied passes parseProfile. */
function diffPasses(p: FitInput["profile"], f: ProfileFit): void {
  const base: Record<string, unknown> = p.builtIn ? { extends: p.base } : (parseProfile(p.text ?? "") as { file: Record<string, unknown> }).file;
  const allow = [...((base.allow as string[] | undefined) ?? []), ...f.diff.allow];
  const deny = [...((base.deny as string[] | undefined) ?? []), ...f.diff.deny];
  expect(parseProfile(stringify({ ...base, allow, deny }))).not.toHaveProperty("error");
}

describe("RL-16 AC-01 denied groups", () => {
  it("test_AC01_order_reasons_rules", () => {
    const p = registered("ci", "extends: read-only\nchecks: [\"make lint\"]\n");
    const h = p.sha256;
    // 6 runs; (runs, count): git (5,5), cargo (4,5), Bash- (4,4), sh (4,4), make (3,3), Task (3,3), WebFetch (3,3), x (1,1).
    const rs = runs(h, 6, [
      { d: { tool: "Bash", command: "git", count: 1 }, in: lt(5) },
      { d: { tool: "Bash", command: "cargo", count: 1 }, in: (i) => i >= 1 && i < 4 },
      { d: { tool: "Bash", count: 1 }, in: lt(4) },
      { d: { tool: "Bash", command: "sh", count: 1 }, in: lt(4) },
      { d: { tool: "Bash", command: "make", count: 1 }, in: lt(3) },
      { d: { tool: "Task", count: 1 }, in: lt(3) },
      { d: { tool: "WebFetch", count: 1 }, in: lt(3) },
      { d: { tool: "Bash", command: "x", count: 1 }, in: (i) => i === 5 },
    ]);
    // cargo: 3 runs with count 1 above plus one run with count 2 → 4 runs, 5 denials.
    rs[5]?.telemetry.denied?.push({ tool: "Bash", command: "cargo", count: 2 });
    const f = fit(p, rs);
    expect(f.sample).toStrictEqual({ runs: 6, toolRuns: 0 });
    expect(f.denied).toStrictEqual([
      { tool: "Bash", command: "git", runs: 5, count: 5, rule: "Bash(git *)", suggest: false, held: "denied-by-profile" },
      { tool: "Bash", command: "cargo", runs: 4, count: 5, rule: "Bash(cargo *)", suggest: true },
      { tool: "Bash", runs: 4, count: 4, suggest: false, held: "no-command" },
      { tool: "Bash", command: "sh", runs: 4, count: 4, rule: "Bash(sh *)", suggest: false, held: "runs-anything" },
      { tool: "Bash", command: "make", runs: 3, count: 3, rule: "Bash(make *)", suggest: true },
      { tool: "Task", runs: 3, count: 3, rule: "Task", suggest: true },
      { tool: "WebFetch", runs: 3, count: 3, rule: "WebFetch", suggest: false, held: "denied-by-profile" },
      { tool: "Bash", command: "x", runs: 1, count: 1, rule: "Bash(x *)", suggest: false, held: "rare" },
    ]);
    expect(f.diff).toStrictEqual({ allow: ["Bash(cargo *)", "Bash(make *)", "Task"], deny: [] });
    expect(f.thresholds).toStrictEqual({ minRuns: 5, minShare: 0.5 });
    diffPasses(p, f);
  });
});

describe("RL-16 AC-02 thresholds", () => {
  const p = builtin("read-only");
  const cargo = (n: number, k: number) => fit(p, runs(p.sha256, n, [{ d: { tool: "Bash", command: "cargo", count: 1 }, in: lt(k) }])).denied[0]?.held;
  it("test_AC02_small_and_share", () => {
    expect(cargo(4, 4)).toBe("few-runs");
    expect(cargo(5, 2)).toBe("rare");
    expect(cargo(5, 3)).toBeUndefined();
    expect(cargo(10, 5)).toBeUndefined();
    expect(cargo(10, 4)).toBe("rare");
    // A reason before few-runs wins over it.
    expect(fit(p, runs(p.sha256, 4, [{ d: { tool: "Bash", command: "sh", count: 1 }, in: lt(4) }])).denied[0]?.held).toBe("runs-anything");
  });
});

describe("RL-16 AC-03 validation", () => {
  it("test_AC03_refused_mesh_tool", () => {
    const p = builtin("read-only");
    const f = fit(p, runs(p.sha256, 5, [{ d: { tool: "mcp__mesh__mesh_dispose", count: 1 }, in: () => true }]));
    expect(f.denied[0]).toMatchObject({ rule: "mcp__mesh__mesh_dispose", suggest: false, held: "refused", refusal: "profiles may not allow mcp__mesh__mesh_dispose" });
    expect(f.diff.allow).toStrictEqual([]);
  });

  it("test_AC03_refused_rule_limit", () => {
    const allow = Array.from({ length: 99 }, (_, i) => `Bash(tool${i} *)`);
    const p = registered("big", stringify({ extends: "read-only", allow }));
    const f = fit(
      p,
      runs(p.sha256, 5, [
        { d: { tool: "Bash", command: "cargo", count: 2 }, in: () => true },
        { d: { tool: "Bash", command: "make", count: 1 }, in: () => true },
      ]),
    );
    expect(f.denied.map((d) => [d.command, d.held, d.refusal])).toStrictEqual([
      ["cargo", undefined, undefined],
      ["make", "refused", "allow: allow has at most 100 rules"],
    ]);
    expect(f.diff.allow).toStrictEqual(["Bash(cargo *)"]);
    diffPasses(p, f);
  });

  it("test_AC03_already_allowed_and_not_a_word", () => {
    const p = registered("c", "allow: [\"Bash(cargo *)\"]\n");
    const f = fit(
      p,
      runs(p.sha256, 5, [
        { d: { tool: "Bash", command: "cargo", count: 1 }, in: () => true },
        { d: { tool: "Bash", command: "x(y", count: 1 }, in: () => true },
      ]),
    );
    expect(f.denied).toStrictEqual([
      { tool: "Bash", command: "cargo", runs: 5, count: 5, rule: "Bash(cargo *)", suggest: false, held: "already-allowed" },
      { tool: "Bash", command: "x(y", runs: 5, count: 5, suggest: false, held: "not-a-word" },
    ]);
    diffPasses(p, f);
  });
});

describe("RL-16 AC-03 covers and names", () => {
  it("test_AC03_glob_deny_and_server_allow", () => {
    const p = registered("g", 'deny: ["Bash(c*)"]\nallow: ["mcp__srv"]\n');
    const rs = Array.from({ length: 5 }, () => run(p.sha256, [{ tool: "Bash", command: "cargo", count: 1 }], { offered: ["mcp__srv__q", "Read"], used: ["Read"] }));
    const f = fit(p, rs);
    expect(f.denied[0]).toMatchObject({ command: "cargo", held: "denied-by-profile" });
    expect(f.unused).toStrictEqual([{ tool: "mcp__srv__q", offeredRuns: 5, suggest: false, held: "allowed" }]);
  });
});

describe("RL-16 AC-03 the spec's cover examples", () => {
  const covered = (deny: string, command: string) => {
    const p = registered("d", stringify({ deny: [deny] }));
    return fit(p, runs(p.sha256, 5, [{ d: { tool: "Bash", command, count: 1 }, in: () => true }])).denied[0]?.held;
  };
  it("test_AC03_cover_cases", () => {
    expect(covered("Bash", "cargo")).toBe("denied-by-profile");
    expect(covered("Bash(*)", "cargo")).toBe("denied-by-profile");
    expect(covered("Bash(* --x)", "cargo")).toBe("denied-by-profile");
    expect(covered("Bash(make lint)", "make")).toBe("denied-by-profile");
    expect(covered("Bash(cargo:*)", "cargo")).toBe("denied-by-profile");
    expect(covered("Bash(cargox *)", "cargo")).toBeUndefined();
    expect(covered("Bash(d*)", "cargo")).toBeUndefined();
    // The built-in denies of the read-only base (its find rule is also allowed, so find is already-allowed).
    const ro = builtin("read-only");
    expect(fit(ro, runs(ro.sha256, 5, [{ d: { tool: "Bash", command: "find", count: 1 }, in: () => true }])).denied[0]?.held).toBe("already-allowed");
    // A server-wide MCP deny covers a tool of that server.
    const p = registered("m", stringify({ deny: ["mcp__srv__*"] }));
    expect(fit(p, runs(p.sha256, 5, [{ d: { tool: "mcp__srv__q", count: 1 }, in: () => true }])).denied[0]?.held).toBe("denied-by-profile");
  });

  it("test_AC03_unused_refused", () => {
    const deny = Array.from({ length: 100 }, (_, i) => `Bash(tool${i} *)`);
    const p = registered("full", stringify({ deny }));
    const rs = Array.from({ length: 5 }, () => run(p.sha256, [], { offered: ["CronCreate", "Read"], used: ["Read"] }));
    const u = fit(p, rs).unused[0];
    expect(u).toMatchObject({ tool: "CronCreate", suggest: false, held: "refused" });
    expect(u?.refusal).toMatch(/^deny: /);
  });
});

describe("RL-16 AC-04 unused tools", () => {
  const p = builtin("read-only");
  const offered = ["Read", "Grep", "Bash", "CronCreate", "Task", "Skill", "mcp__mesh__mesh_done", "mcp__mesh__mesh_note"];
  const used = ["Read", "Bash", "mcp__mesh__mesh_done", "Task"];
  const toolRun = (i: number) =>
    run(p.sha256, i === 0 ? [{ tool: "Task", count: 1 }] : [], { offered: [...offered, ...(i < 3 ? ["Edit"] : []), ...(i < 4 ? ["Rare"] : [])], used: i === 0 ? used : used.filter((u) => u !== "Task") });

  it("test_AC04_drops_and_holds", () => {
    const f = fit(p, Array.from({ length: 5 }, (_, i) => toolRun(i)));
    expect(f.sample).toStrictEqual({ runs: 5, toolRuns: 5 });
    expect(f.unused).toStrictEqual([
      { tool: "CronCreate", offeredRuns: 5, suggest: true },
      { tool: "Grep", offeredRuns: 5, suggest: false, held: "allowed" },
      { tool: "Skill", offeredRuns: 5, suggest: false, held: "mesh-tool" },
      { tool: "mcp__mesh__mesh_note", offeredRuns: 5, suggest: false, held: "mesh-tool" },
      { tool: "Rare", offeredRuns: 4, suggest: false, held: "few-runs" },
      { tool: "Edit", offeredRuns: 3, suggest: false, held: "already-denied" },
    ]);
    expect(f.diff.deny).toStrictEqual(["CronCreate"]);
    diffPasses(p, f);
  });

  it("test_AC04_few_tool_runs_and_runs_without_toolsUsed", () => {
    const four = Array.from({ length: 4 }, (_, i) => toolRun(i));
    expect(fit(p, four).unused.find((u) => u.tool === "CronCreate")?.held).toBe("few-runs");
    // A fifth run without toolsUsed is not a tool run: its tools are not counted.
    const f = fit(p, [...four, run(p.sha256, [], { offered: [...offered, "NewTool"] })]);
    expect(f.sample).toStrictEqual({ runs: 5, toolRuns: 4 });
    expect(f.unused.map((u) => u.tool)).not.toContain("NewTool");
    expect(f.unused.find((u) => u.tool === "CronCreate")).toMatchObject({ offeredRuns: 4, held: "few-runs" });
  });
});

describe("RL-16 hashes and the cap", () => {
  it("test_AC05_hashes_unit", () => {
    const p = builtin("read-only");
    const old = "a".repeat(64);
    const older = "0".repeat(64);
    const tie = "b".repeat(64);
    const f = fit(p, [
      run(tie, [], undefined, 5),
      run(old, [{ tool: "Bash", command: "make", count: 2 }], undefined, 10),
      run(older, [], undefined, 5),
      run(old, [], undefined, 30),
      run(p.sha256, [], undefined, 20),
    ]);
    // Current first, then lastAt descending, then sha256.
    expect(f.hashes).toStrictEqual([
      { sha256: p.sha256, current: true, runs: 1, toolRuns: 0, deniedRuns: 0, denials: 0, firstAt: 20, lastAt: 20 },
      { sha256: old, current: false, runs: 2, toolRuns: 0, deniedRuns: 1, denials: 2, firstAt: 10, lastAt: 30 },
      { sha256: older, current: false, runs: 1, toolRuns: 0, deniedRuns: 0, denials: 0, firstAt: 5, lastAt: 5 },
      { sha256: tie, current: false, runs: 1, toolRuns: 0, deniedRuns: 0, denials: 0, firstAt: 5, lastAt: 5 },
    ]);
    // Older hashes' denials are not in the sample.
    expect(f.denied).toStrictEqual([]);
    expect(fit(p, []).hashes).toStrictEqual([{ sha256: p.sha256, current: true, runs: 0, toolRuns: 0, deniedRuns: 0, denials: 0 }]);
  });

  it("test_AC06_cap_unit", () => {
    const p = builtin("read-only");
    const rs = Array.from({ length: 5 }, (_, r) => run(p.sha256, Array.from({ length: 41 }, (_, i) => ({ tool: "Bash", command: `c${r}-${i}`, count: 1 }))));
    const f = fit(p, rs);
    expect(f.denied).toHaveLength(200);
    expect(f.truncated).toStrictEqual({ denied: 5, unused: 0 });
  });
});
