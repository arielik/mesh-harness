// RL-4 CLI: `mesh debrief <step>` (fake runner, World hub), `mesh run --step` on a debrief, `mesh
// setup` / `mesh doctor` / `mesh skill --debrief` / `mesh help` for the mesh-debrief skill. Criteria
// AC-04 (CLI), AC-15, AC-16 (CLI). Written from the spec's contracts only (docs/specs/RL-4.md).
// tmux and `claude` are never run: the runner is a fake that records the calls.

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { Runner } from "../src/claude/index.ts";
import { dispatch } from "../src/cli/commands.ts";
import { meshCommands, type CliEnv } from "../src/cli/mesh-commands.ts";
import * as protocol from "../src/protocol/index.ts";
import { MESH_SKILL, resolvePaths, SKILL_MARKER } from "../src/protocol/index.ts";
import { Dk, NOT_YOURS, type Ids } from "./helpers/debrief-kit.ts";

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- new exports, read loosely
const P = protocol as any;

const PROMPT = (step: string) =>
  `You hold the mesh debrief step ${step}. Use the mesh-debrief skill: call mesh_context, then go through the items with me one at a time, highest severity first. Record each decision with mesh_dispose, then submit the debrief's review record with mesh_review and finish with mesh_done.`;
const WARN_READ = (step: string) => `warning: you have not marked the pre-read of ${step} as read (web step panel); starting anyway`;
const WARN_SKILL = "warning: the mesh-debrief skill is not installed or out of date; run: mesh setup";

interface Call {
  cmd: string;
  args: string[];
  cwd?: string | undefined;
}
/** A fake runner: tmux has no session yet; each new pane gets `%<n>`; every call is recorded. */
function fakeRunner(): { runner: Runner; calls: Call[] } {
  const calls: Call[] = [];
  let n = 500;
  const runner: Runner = async (cmd, args, opts) => {
    calls.push({ cmd, args: [...args], cwd: opts?.cwd });
    if (cmd === "claude" && args[0] === "--version") return { code: 0, stdout: "2.1.318 (Claude Code)\n", stderr: "" };
    if (cmd !== "tmux") return { code: 0, stdout: "", stderr: "" };
    if (args.includes("has-session")) return { code: 1, stdout: "", stderr: "no server" };
    if (args.includes("new-session") || args.includes("new-window")) return { code: 0, stdout: `%${++n}\n`, stderr: "" };
    return { code: 0, stdout: "", stderr: "" };
  };
  return { runner, calls };
}
const newPanes = (calls: Call[]) => calls.filter((c) => c.cmd === "tmux" && (c.args.includes("new-session") || c.args.includes("new-window")));
const after = (args: string[], flag: string) => {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : undefined;
};

// ---------------------------------------------------------------------------------------------
// World-backed: mesh run --step and mesh debrief.

let k: Dk | undefined;
afterEach(async () => {
  await k?.r.stop();
  k = undefined;
});

async function fixture(o: { audit?: boolean } = {}): Promise<{ k: Dk; ids: Ids }> {
  k = await Dk.start();
  const ids = await k.relay();
  if (o.audit !== false) await k.auditDone(ids);
  return { k, ids };
}
const skillPathOf = (k: Dk) => join(k.c.alice.dir, "claude", "skills", "mesh-debrief", "SKILL.md");

describe("AC-04 mesh run --step on a debrief", () => {
  it("test_AC04_cli_mesh_run_step", async () => {
    const { k, ids } = await fixture();
    const bob = fakeRunner();
    const res = await k.r.cli(k.c.bob, ["run", "svc", "--step", ids.D, "--no-tui"], { runner: bob.runner, cwd: k.c.bob.repoDir });
    expect(res.code).toBe(1);
    expect(res.err).toContain(NOT_YOURS(ids.D, "alice"));
    expect(newPanes(bob.calls)).toStrictEqual([]);
    expect((await k.step(ids.D)).state).toBe("ready");
    // Control: the assignee's mesh run claims it and opens the window.
    const al = fakeRunner();
    const ok = await k.r.cli(k.c.alice, ["run", "svc", "--step", ids.D, "--no-tui"], { runner: al.runner, cwd: k.c.alice.repoDir });
    expect(ok.code, ok.err).toBe(0);
    expect(newPanes(al.calls)).toHaveLength(1);
    expect(await k.step(ids.D)).toMatchObject({ state: "claimed", holderUser: "alice" });
  });
});

describe("AC-15 mesh debrief", () => {
  it("test_AC15_usage", async () => {
    const { k } = await fixture({ audit: false });
    const f = fakeRunner();
    const res = await k.r.cli(k.c.alice, ["debrief"], { runner: f.runner, cwd: k.c.alice.repoDir });
    expect(res.code).toBe(2);
    expect(res.err).toContain("usage: mesh debrief <step>");
    expect(newPanes(f.calls)).toStrictEqual([]);
  });

  it("test_AC15_not_debrief", async () => {
    const { k, ids } = await fixture();
    const f = fakeRunner();
    const res = await k.r.cli(k.c.alice, ["debrief", ids.AU], { runner: f.runner, cwd: k.c.alice.repoDir });
    expect(res.code).toBe(1);
    expect(res.err).toContain(`${ids.AU} is not a debrief step`);
    expect(newPanes(f.calls)).toStrictEqual([]);
  });

  it("test_AC15_other_user", async () => {
    const { k, ids } = await fixture();
    const f = fakeRunner();
    const res = await k.r.cli(k.c.bob, ["debrief", ids.D], { runner: f.runner, cwd: k.c.bob.repoDir });
    expect(res.code).toBe(1);
    expect(res.err).toContain(`${ids.D} is a debrief for alice; only they can run it`);
    expect(f.calls.filter((c) => c.cmd === "tmux")).toStrictEqual([]);
    const d = await k.step(ids.D);
    expect(d.state).toBe("ready");
    expect(d).not.toHaveProperty("holderUser");
  });

  it("test_AC15_blocked", async () => {
    const { k, ids } = await fixture({ audit: false });
    const f = fakeRunner();
    const res = await k.r.cli(k.c.alice, ["debrief", ids.D], { runner: f.runner, cwd: k.c.alice.repoDir });
    expect(res.code).toBe(1);
    expect(res.err).toContain(`${ids.D} is blocked; a debrief starts when it is ready`);
    expect(newPanes(f.calls)).toStrictEqual([]);
    expect((await k.step(ids.D)).state).toBe("blocked");
  });

  it("test_AC15_launch", async () => {
    const { k, ids } = await fixture();
    const f = fakeRunner();
    const res = await k.r.cli(k.c.alice, ["debrief", ids.D, "--no-tui"], { runner: f.runner, cwd: k.c.alice.repoDir });
    expect(res.code, res.err).toBe(0);
    expect(res.err).toContain(WARN_READ(ids.D));
    expect(res.err).toContain(WARN_SKILL);
    const panes = newPanes(f.calls);
    expect(panes).toHaveLength(1);
    const args = panes[0]?.args as string[];
    const ci = args.indexOf("claude");
    expect(ci, JSON.stringify(args)).toBeGreaterThanOrEqual(0);
    expect(args[ci + 1]).toBe(PROMPT(ids.D));
    expect(args.filter((a, i) => args[i - 1] === "-e")).toContain(`MESH_STEP=${ids.D}`);
    expect(after(args, "-c") ?? panes[0]?.cwd).toBe(k.c.alice.repoDir);
    expect(await k.step(ids.D)).toMatchObject({ state: "claimed", holderUser: "alice" });
  });

  it("test_AC15_session_flag_and_no_warnings", async () => {
    const { k, ids } = await fixture();
    // Control: with a read in this round and the skill installed, no warning lines.
    expect((await k.route(k.c.alice, ids.D, "read", {})).status).toBe(200);
    const path = skillPathOf(k);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, P.MESH_DEBRIEF_SKILL);
    const f = fakeRunner();
    const res = await k.r.cli(k.c.alice, ["debrief", ids.D, "--session", "x", "--no-tui"], { runner: f.runner, cwd: k.c.alice.repoDir });
    expect(res.code, res.err).toBe(0);
    expect(res.err).not.toContain("warning:");
    const panes = newPanes(f.calls);
    expect(panes).toHaveLength(1);
    const args = panes[0]?.args as string[];
    expect(args.includes("new-session") ? after(args, "-s") : (after(args, "-t") ?? "").replace(/^=/, "").split(":")[0]).toBe("x");
    expect(args[args.indexOf("claude") + 1]).toBe(PROMPT(ids.D));
  });
});

// ---------------------------------------------------------------------------------------------
// Local CLI: setup, doctor, skill, help.

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
function env(runner: Runner) {
  // The prefix must not contain "mesh-debrief": setup prints its config path, and AC-16 checks
  // that --no-mcp output never names the skill.
  const d = mkdtempSync(join(tmpdir(), "rl4-cli-"));
  dirs.push(d);
  const root = join(d, "w");
  mkdirSync(root);
  const out: string[] = [];
  const err: string[] = [];
  const paths = resolvePaths({ MESH_CONFIG_DIR: join(root, "cfg"), MESH_STATE_DIR: join(root, "state"), CLAUDE_CONFIG_DIR: join(root, "claude") }, root);
  const c: CliEnv = { io: { out: (t) => out.push(t), err: (t) => err.push(t) }, paths, env: {}, cwd: root, self: ["mesh"], version: "0.0.0", runner };
  const cmd = (name: string) => meshCommands(c).find((x) => x.name === name) as { run(a: string[]): Promise<number> } | undefined;
  const skill = join(root, "claude", "skills", "mesh-debrief", "SKILL.md");
  const text = () => out.join("\n");
  return { c, out, err, cmd, paths, skill, text };
}

describe("AC-16 mesh setup, doctor and skill", () => {
  it("test_AC16_paths", () => {
    const t = env(fakeRunner().runner);
    expect((t.paths as unknown as Record<string, string>).claudeDebriefSkill).toBe(t.skill);
  });

  it("test_AC16_setup_install_keep", async () => {
    const t = env(fakeRunner().runner);
    expect(await t.cmd("setup")?.run(["--port", "31301"])).toBe(0);
    expect(existsSync(t.skill)).toBe(true);
    expect(readFileSync(t.skill, "utf8")).toBe(P.MESH_DEBRIEF_SKILL);
    expect(t.text()).toContain(`Installed the mesh-debrief skill ${t.skill}.`);
    t.out.length = 0;
    expect(await t.cmd("setup")?.run([])).toBe(0);
    expect(t.text()).toContain(`Kept the mesh-debrief skill ${t.skill}.`);
    // --uninstall removes it and its folder.
    t.out.length = 0;
    expect(await t.cmd("setup")?.run(["--uninstall"])).toBe(0);
    expect(existsSync(t.skill)).toBe(false);
    expect(existsSync(dirname(t.skill))).toBe(false);
    expect(t.text()).toContain(`Removed the mesh-debrief skill ${t.skill}.`);
  });

  it("test_AC16_setup_foreign_and_no_mcp", async () => {
    const t = env(fakeRunner().runner);
    mkdirSync(dirname(t.skill), { recursive: true });
    writeFileSync(t.skill, "---\nname: mesh-debrief\n---\nsomeone else's\n");
    expect(await t.cmd("setup")?.run(["--port", "31302"])).toBe(0);
    expect(t.text()).toContain(`Left ${t.skill} alone: mesh did not write it.`);
    expect(readFileSync(t.skill, "utf8")).toBe("---\nname: mesh-debrief\n---\nsomeone else's\n");
    // --no-mcp skips the skill (no file, no line).
    const u = env(fakeRunner().runner);
    expect(await u.cmd("setup")?.run(["--port", "31303", "--no-mcp"])).toBe(0);
    expect(existsSync(u.skill)).toBe(false);
    expect(u.text()).not.toContain("mesh-debrief");
    // Control: the mesh skill line of setup is still there in the first run.
    expect(t.text()).toContain("the mesh skill");
  });

  it("test_AC16_doctor", async () => {
    const t = env(fakeRunner().runner);
    expect(await t.cmd("setup")?.run(["--port", "31304"])).toBe(0);
    t.out.length = 0;
    const current = await t.cmd("doctor")?.run([]);
    expect(t.text()).toContain(`✓ mesh-debrief skill ${t.skill}`);
    rmSync(t.skill);
    t.out.length = 0;
    const missing = await t.cmd("doctor")?.run([]);
    expect(t.text()).toContain("! mesh-debrief skill not installed; run: mesh setup");
    mkdirSync(dirname(t.skill), { recursive: true });
    writeFileSync(t.skill, `---\nname: mesh-debrief\n---\n${SKILL_MARKER}\nold text\n`);
    t.out.length = 0;
    const old = await t.cmd("doctor")?.run([]);
    expect(t.text()).toContain("! mesh-debrief skill out of date; run: mesh setup");
    // Warnings, not failures: the exit code does not change with them.
    expect(missing).toBe(current);
    expect(old).toBe(current);
  });

  it("test_AC16_skill_flag", async () => {
    const t = env(fakeRunner().runner);
    expect(await t.cmd("skill")?.run(["--debrief"])).toBe(0);
    expect(t.text().trim()).toBe(String(P.MESH_DEBRIEF_SKILL).trim());
    const u = env(fakeRunner().runner);
    expect(await u.cmd("skill")?.run([])).toBe(0);
    expect(u.text().trim()).toBe(MESH_SKILL.trim());
  });

  it("test_AC16_help_lists_debrief", async () => {
    const t = env(fakeRunner().runner);
    expect(t.cmd("debrief"), "a debrief command").toBeDefined();
    const out: string[] = [];
    await dispatch(["help"], meshCommands(t.c), "0.0.0", (x) => out.push(x));
    expect([...out, ...t.out].join("\n")).toMatch(/\bdebrief\b/);
  });
});

