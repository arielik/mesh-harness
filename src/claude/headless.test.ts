// RL-1 AC-18: processRunner with the fake claude (test/fixtures/claude/fake-claude/claude). Real
// processes; every group started here is SIGKILLed after each test so a failure leaves nothing.

import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import * as claude from "./index.ts";

interface Runner {
  start(spec: { argv: readonly string[]; cwd: string; env: Record<string, string>; runDir: string }): Promise<{ ok: true; pid: number; startId: string } | { ok: false; error: string }>;
  alive(pid: number, startId: string): boolean;
  kill(pid: number, startId: string): Promise<void>;
  git(cwd: string, args: readonly string[]): Promise<{ code: number; stdout: string; stderr: string }>;
}
const runner = (): Runner => (claude as unknown as { processRunner: Runner }).processRunner;

const FAKE = join(import.meta.dirname, "..", "..", "test", "fixtures", "claude", "fake-claude", "claude");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(cond: () => boolean, ms = 6_000): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (cond()) return true;
    await sleep(20);
  }
  return cond();
}
const gone = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return false;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "ESRCH";
  }
};
/** A zombie counts as gone: `ps` reports state Z, or nothing. */
const dead = (pid: number): boolean => {
  if (gone(pid)) return true;
  try {
    return execFileSync("ps", ["-o", "stat=", "-p", String(pid)], { encoding: "utf8" }).trim().startsWith("Z");
  } catch {
    return true;
  }
};

const dirs: string[] = [];
const groups: number[] = [];
const children: ChildProcess[] = [];
afterEach(() => {
  for (const g of groups.splice(0)) {
    try {
      process.kill(-g, "SIGKILL");
    } catch {
      /* gone */
    }
  }
  for (const c of children.splice(0)) c.kill("SIGKILL");
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function setup(step: string, script: unknown[]) {
  const root = mkdtempSync(join(tmpdir(), "mesh-headless-"));
  dirs.push(root);
  const fake = join(root, "fake");
  const cwd = join(root, "cwd");
  const runDir = join(root, "run");
  for (const d of [join(fake, "scripts"), join(fake, "calls"), join(fake, "go"), cwd, runDir]) mkdirSync(d, { recursive: true });
  writeFileSync(join(fake, "scripts", `${step}.json`), JSON.stringify(script));
  const calls = () => readdirSync(join(fake, "calls")).filter((f) => f.startsWith(`${step}-`) && f.endsWith(".json")).map((f) => JSON.parse(readFileSync(join(fake, "calls", f), "utf8")));
  const childPid = () => {
    const f = join(fake, "calls", `${step}-child.pid`);
    return existsSync(f) ? Number(readFileSync(f, "utf8")) : undefined;
  };
  const go = (name: string) => writeFileSync(join(fake, "go", name), "");
  const exitFile = () => (existsSync(join(runDir, "exit")) ? readFileSync(join(runDir, "exit"), "utf8").trim() : undefined);
  return { root, fake, cwd, runDir, calls, childPid, go, exitFile, spec: { argv: [FAKE, "-p", "hi"], cwd, env: { MESH_STEP: step, FAKE_CLAUDE_DIR: fake }, runDir } };
}

async function started(s: ReturnType<typeof setup>) {
  const r = await runner().start(s.spec);
  expect(r.ok, JSON.stringify(r)).toBe(true);
  if (!r.ok) throw new Error(r.error);
  groups.push(r.pid);
  return r;
}

describe("AC-18 process runner", { timeout: 20_000 }, () => {
  it("test_AC18_start_and_logs", async () => {
    const s = setup("s1", [{ stdout: ['{"a":1}'] }, { stderr: ["err1"] }, { waitFor: "end" }, { exit: 1 }]);
    const r = await started(s);
    expect(r.pid).toBeGreaterThan(0);
    expect(r.startId.length).toBeGreaterThan(0);
    expect(await until(() => s.calls().length === 1)).toBe(true);
    expect(Number(execFileSync("ps", ["-o", "pgid=", "-p", String(r.pid)], { encoding: "utf8" }).trim())).toBe(r.pid);
    expect(runner().alive(r.pid, r.startId)).toBe(true);
    expect(s.exitFile()).toBeUndefined();
    s.go("end");
    expect(await until(() => s.exitFile() !== undefined)).toBe(true);
    expect(s.exitFile()).toBe("1");
    expect(readFileSync(join(s.runDir, "stream.jsonl"), "utf8")).toBe('{"a":1}\n');
    expect(readFileSync(join(s.runDir, "stderr.log"), "utf8")).toContain("err1");
    expect(await until(() => !runner().alive(r.pid, r.startId))).toBe(true);
  });

  it("test_AC18_exit_zero", async () => {
    const s = setup("s0", [{ stdout: ["x"] }]);
    await started(s);
    expect(await until(() => s.exitFile() !== undefined)).toBe(true);
    expect(s.exitFile()).toBe("0");
  });

  it("test_AC18_env_cwd", async () => {
    process.env.FAKE_PARENT_VAR = "from-parent";
    try {
      const s = setup("s1", []);
      await started(s);
      expect(await until(() => s.calls().length === 1 && s.exitFile() !== undefined)).toBe(true);
      const [c] = s.calls();
      expect(realpathSync(c.cwd)).toBe(realpathSync(s.cwd));
      expect(c.env.MESH_STEP).toBe("s1");
      expect(c.env.FAKE_PARENT_VAR).toBe("from-parent");
      expect(c.argv).toStrictEqual(["-p", "hi"]);
    } finally {
      delete process.env.FAKE_PARENT_VAR;
    }
  });

  it("test_AC18_kill_group", async () => {
    const s = setup("s2", [{ spawnChild: true }, { waitFor: "never" }]);
    const r = await started(s);
    expect(await until(() => s.childPid() !== undefined)).toBe(true);
    const child = s.childPid() as number;
    // Positive control: both alive before the kill.
    expect(runner().alive(r.pid, r.startId)).toBe(true);
    expect(dead(child)).toBe(false);
    await runner().kill(r.pid, r.startId);
    expect(await until(() => dead(r.pid) && dead(child), 6_000)).toBe(true);
    expect(await until(() => s.exitFile() !== undefined, 6_000)).toBe(true);
    expect(s.exitFile()).toBe("143");
    expect(runner().alive(r.pid, r.startId)).toBe(false);
  });

  it("test_AC18_kill_ignores_term", async () => {
    const s = setup("s3", [{ ignoreTerm: true }, { waitFor: "never" }]);
    const r = await started(s);
    expect(await until(() => s.calls().length === 1)).toBe(true);
    await sleep(100);
    await runner().kill(r.pid, r.startId);
    expect(await until(() => dead(r.pid), 7_000)).toBe(true);
    expect(await until(() => s.exitFile() !== undefined, 2_000)).toBe(true);
    expect(s.exitFile()).toBe("137");
  });

  it("test_AC18_identity", async () => {
    const s = setup("s4", [{ waitFor: "never" }]);
    const r = await started(s);
    expect(await until(() => s.calls().length === 1)).toBe(true);
    expect(runner().alive(r.pid, r.startId)).toBe(true);
    expect(runner().alive(r.pid, `${r.startId}x`)).toBe(false);
    await runner().kill(r.pid, "other");
    await sleep(300);
    expect(dead(r.pid)).toBe(false);
    expect(runner().alive(r.pid, r.startId)).toBe(true);
  });

  it("test_AC18_unrelated", async () => {
    const sl = spawn("sleep", ["300"], { detached: true, stdio: "ignore" });
    children.push(sl);
    groups.push(sl.pid as number);
    await sleep(50);
    const pid = sl.pid as number;
    expect(runner().alive(pid, "other")).toBe(false);
    await runner().kill(pid, "other");
    await sleep(300);
    expect(gone(pid)).toBe(false);
    expect(() => process.kill(pid, 0)).not.toThrow();
  });

  it("test_AC18_start_failure", async () => {
    const s = setup("s5", []);
    let r: Awaited<ReturnType<Runner["start"]>> | undefined;
    let threw: unknown;
    try {
      r = await runner().start({ ...s.spec, argv: ["/nonexistent/claude"] });
    } catch (e) {
      threw = e;
    }
    expect(threw).toBeUndefined();
    expect(r).toBeDefined();
    if (r?.ok) {
      groups.push(r.pid);
      expect(await until(() => s.exitFile() !== undefined, 5_000)).toBe(true);
      expect(s.exitFile()).not.toBe("0");
    } else {
      expect(r?.error.length).toBeGreaterThan(0);
    }
  });

  it("test_AC18_git", async () => {
    const s = setup("s6", []);
    const g = (args: string[]) => execFileSync("git", ["-C", s.cwd, "-c", "user.email=t@example.invalid", "-c", "user.name=t", ...args], { encoding: "utf8" });
    g(["init", "-q"]);
    g(["commit", "-q", "--allow-empty", "-m", "x"]);
    const head = g(["rev-parse", "HEAD"]).trim();
    const r = await runner().git(s.cwd, ["rev-parse", "HEAD"]);
    expect(r.code).toBe(0);
    expect(r.stdout.trim()).toBe(head);
  });
});

// RL-7 AC-06: `HeadlessSpec.unsetEnv` (docs/specs/RL-7.md, Environment of a headless run). The child's
// environment is the waiter's environment, plus `spec.env`, minus `unsetEnv`.
describe("RL-7 unsetEnv", { timeout: 20_000 }, () => {
  const saved: Record<string, string | undefined> = {};
  afterEach(() => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
      delete saved[k];
    }
  });
  const setEnv = (k: string, v: string) => {
    if (!(k in saved)) saved[k] = process.env[k];
    process.env[k] = v;
  };
  async function probeOf(s: ReturnType<typeof setup>, extra: Record<string, unknown>) {
    const spec = { ...s.spec, env: { ...s.spec.env, A: "1", TMUX: "x" }, ...extra } as typeof s.spec;
    const r = await runner().start(spec);
    expect(r.ok, JSON.stringify(r)).toBe(true);
    if (!r.ok) throw new Error(r.error);
    groups.push(r.pid);
    expect(await until(() => s.calls().length === 1 && s.exitFile() !== undefined)).toBe(true);
    return s.calls()[0].probe as Record<string, string | null>;
  }

  it("test_AC06_unit_unset_env", async () => {
    setEnv("B", "2");
    setEnv("C", "3");
    const probe = await probeOf(setup("u6", []), { unsetEnv: ["TMUX", "B"] });
    expect(probe.A).toBe("1");
    expect(probe.C).toBe("3");
    expect(probe.TMUX).toBeNull();
    expect(probe.B).toBeNull();
    // Positive control: without unsetEnv the probe sees both (it reports variables that are there).
    const control = await probeOf(setup("u6c", []), {});
    expect(control.B).toBe("2");
    expect(control.TMUX).toBe("x");
  });
});
