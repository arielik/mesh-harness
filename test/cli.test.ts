import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { RunResult, Runner } from "../src/claude/index.ts";
import { Daemon, defaultDeps } from "../src/daemon/index.ts";
import { resolvePaths } from "../src/protocol/index.ts";
import { DaemonStore } from "../src/store/index.ts";
import { parseArgs } from "../src/cli/context.ts";
import { meshCommands, type CliEnv } from "../src/cli/mesh-commands.ts";
import { defaultRoots, resolveRepo } from "../src/cli/repos.ts";
import { launchdPlist, systemdUnit } from "../src/cli/service.ts";

const dirs: string[] = [];
// One level down, so the folder's parent (a workspace root for `mesh run`) is ours, not /tmp.
const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), "mesh-cli-"));
  dirs.push(d);
  const w = join(d, "w");
  mkdirSync(w);
  return w;
};
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function env(root: string, runner?: Runner, extra: Partial<CliEnv> = {}) {
  const out: string[] = [];
  const err: string[] = [];
  const paths = resolvePaths({ MESH_CONFIG_DIR: join(root, "cfg"), MESH_STATE_DIR: join(root, "state"), CLAUDE_CONFIG_DIR: join(root, "claude") }, root);
  const c: CliEnv = {
    io: { out: (t) => out.push(t), err: (t) => err.push(t) },
    paths,
    env: {},
    cwd: root,
    self: ["mesh"],
    version: "0.0.0",
    ...(runner ? { runner } : {}),
    ...extra,
  };
  const cmd = (name: string) => meshCommands(c).find((x) => x.name === name) as { run(a: string[]): Promise<number> };
  return { c, out, err, cmd, paths };
}

const ok = (stdout = ""): RunResult => ({ code: 0, stdout, stderr: "" });

describe("parseArgs", () => {
  it("handles flags, values and positionals", () => {
    const a = parseArgs(["a", "--bg", "--model", "opus", "--prompt=do it", "b", "--", "--literal"], ["model"]);
    expect(a.positional).toEqual(["a", "b", "--literal"]);
    expect(a.has("bg")).toBe(true);
    expect(a.str("model")).toBe("opus");
    expect(a.str("prompt")).toBe("do it");
  });
});

describe("mesh setup", () => {
  it("creates a private config, installs hooks, and uninstalls them", async () => {
    const t = env(tmp());
    expect(await t.cmd("setup").run(["--port", "31234"])).toBe(0);
    const config = JSON.parse(readFileSync(t.paths.daemonConfig, "utf8"));
    expect(config.port).toBe(31234);
    expect(config.key).toMatch(/^[0-9a-f]{48}$/);
    expect(statSync(t.paths.daemonConfig).mode & 0o777).toBe(0o600);
    expect(readFileSync(t.paths.claudeSettings, "utf8")).toContain("127.0.0.1:31234/mesh/hook/stop");
    // Re-running keeps the key.
    await t.cmd("setup").run([]);
    expect(JSON.parse(readFileSync(t.paths.daemonConfig, "utf8")).key).toBe(config.key);
    expect(await t.cmd("setup").run(["--uninstall"])).toBe(0);
    expect(existsSync(t.paths.claudeSettings)).toBe(false);
  });
});

describe("mesh setup --agent opencode", () => {
  const runner: Runner = async (cmd, args) => (cmd === "opencode" && args[0] === "--version" ? ok("2.2.4\n") : ok());

  it("installs only the OpenCode plugin and skill, and uninstalls them", async () => {
    const t = env(tmp(), runner);
    expect(await t.cmd("setup").run(["--agent", "opencode", "--port", "31235"])).toBe(0);
    expect(existsSync(t.paths.claudeSettings)).toBe(false);
    const plugin = readFileSync(t.paths.opencodePlugin, "utf8");
    expect(plugin).toContain(JSON.stringify(t.paths.daemonConfig));
    expect(plugin).toContain('["mesh","mcp"]');
    expect(existsSync(t.paths.opencodeSkill)).toBe(true);
    expect(t.out.join("\n")).toContain("OpenCode sessions started from now on report to mesh");
    expect(await t.cmd("setup").run(["--agent", "opencode", "--uninstall"])).toBe(0);
    expect(existsSync(t.paths.opencodePlugin)).toBe(false);
    expect(existsSync(t.paths.opencodeSkill)).toBe(false);
    // The folders mesh created for its files go with them; OpenCode's config folder stays.
    expect(existsSync(join(t.paths.opencodeConfigDir, "plugins"))).toBe(false);
    expect(existsSync(join(t.paths.opencodeConfigDir, "skills"))).toBe(false);
  });

  it("--agent all installs both; plain --uninstall removes both", async () => {
    const t = env(tmp(), runner);
    expect(await t.cmd("setup").run(["--agent", "all", "--no-mcp"])).toBe(0);
    expect(existsSync(t.paths.claudeSettings)).toBe(true);
    expect(existsSync(t.paths.opencodePlugin)).toBe(true);
    expect(await t.cmd("setup").run(["--uninstall"])).toBe(0);
    expect(existsSync(t.paths.claudeSettings)).toBe(false);
    expect(existsSync(t.paths.opencodePlugin)).toBe(false);
  });

  it("warns about an OpenCode older than the v2 plugin API, and doctor flags it", async () => {
    const old: Runner = async (cmd, args) => (cmd === "opencode" && args[0] === "--version" ? ok("1.18.29\n") : cmd === "claude" ? ok("2.1.317") : ok());
    const t = env(tmp(), old);
    await t.cmd("setup").run(["--agent", "opencode"]);
    expect(t.out.join("\n")).toContain("older than 2.2.4");
    await t.cmd("doctor").run([]);
    expect(t.out.join("\n")).toMatch(/✗ opencode 1\.18\.29 is older/);
    expect(t.out.join("\n")).toContain("✓ OpenCode plugin v1");
  });

  it("doctor does not require Claude Code when only OpenCode is set up", async () => {
    const t = env(tmp(), async (cmd, args) => (cmd === "opencode" && args[0] === "--version" ? ok("2.2.4\n") : cmd === "claude" ? { code: 127, stdout: "", stderr: "not found" } : ok()));
    await t.cmd("setup").run(["--agent", "opencode"]);
    await t.cmd("doctor").run([]);
    const out = t.out.join("\n");
    expect(out).toContain("! mesh is set up for OpenCode only");
    expect(out).not.toContain("claude not found");
    expect(out).not.toContain("hooks not installed");
    expect(out).toContain("✓ opencode 2.2.4");
  });

  it("rejects an unknown agent", async () => {
    const t = env(tmp(), runner);
    expect(await t.cmd("setup").run(["--agent", "cursor"])).toBe(2);
  });
});

describe("mesh doctor", () => {
  const runner: Runner = async (cmd, args) => {
    if (cmd === "claude" && args[0] === "--version") return ok("2.1.317 (Claude Code)\n");
    return ok();
  };

  it("fails without setup", async () => {
    const t = env(tmp(), runner);
    expect(await t.cmd("doctor").run([])).toBe(1);
    expect(t.out.join("\n")).toContain("✗ mesh is not set up");
  });

  it("passes with hooks installed and the daemon running", async () => {
    const t = env(tmp(), runner);
    await t.cmd("setup").run([]);
    const config = JSON.parse(readFileSync(t.paths.daemonConfig, "utf8"));
    const store = await DaemonStore.open(":memory:");
    const daemon = new Daemon({
      config,
      store,
      deps: defaultDeps({ harness: () => undefined, claudeVersion: async () => undefined, scanRuns: () => [], listAgents: async () => [], paste: async () => true, wakeBackground: async () => ({ ok: true }), notify: async () => undefined, log: () => undefined }),
      intervals: { reconcileMs: 0, transcriptMs: 0, tickMs: 0, deliveryMs: 0 },
    });
    await daemon.start();
    try {
      expect(await t.cmd("doctor").run([])).toBe(0);
      expect(t.out.join("\n")).toContain("✓ daemon running");
    } finally {
      await daemon.stop();
      store.close();
    }
  });

  it("flags an old Claude Code", async () => {
    const t = env(tmp(), async (cmd, args) => (cmd === "claude" && args[0] === "--version" ? ok("2.1.200 (Claude Code)") : ok()));
    await t.cmd("doctor").run([]);
    expect(t.out.join("\n")).toContain("older than 2.1.314");
  });
});

describe("repo resolution", () => {
  it("finds checkouts by name under the roots and by path", () => {
    const root = tmp();
    for (const p of ["a/frr", "b/vpc/agent", "c/other"]) mkdirSync(join(root, p, ".git"), { recursive: true });
    const roots = defaultRoots(root, [join(root, "a"), join(root, "b")]);
    expect(resolveRepo("frr", roots)).toBe(join(root, "a", "frr"));
    expect(resolveRepo("agent", roots)).toBe(join(root, "b", "vpc", "agent"));
    expect(resolveRepo(join(root, "c", "other"), roots)).toBe(join(root, "c", "other"));
    expect(() => resolveRepo("missing", roots)).toThrow(/no checkout named "missing"/);
  });

  it("reports ambiguous names", () => {
    const root = tmp();
    for (const p of ["a/x", "b/x"]) mkdirSync(join(root, p, ".git"), { recursive: true });
    expect(() => resolveRepo("x", [join(root, "a"), join(root, "b")])).toThrow(/ambiguous/);
  });
});

describe("service files (golden)", () => {
  const spec = { node: "/usr/bin/node", script: "/opt/mesh/dist/main.mjs", path: "/usr/local/bin:/usr/bin:/bin", logFile: "/home/dev/.local/state/mesh/daemon.log" };
  it("launchd plist", () => expect(launchdPlist(spec)).toMatchSnapshot());
  it("systemd unit", () => expect(systemdUnit(spec)).toMatchSnapshot());
});

let haveTmux = true;
try {
  execFileSync("tmux", ["-V"]);
} catch {
  haveTmux = false;
}

describe.skipIf(!haveTmux)("mesh run (real tmux, fake claude)", () => {
  it("opens a tmux window per repo running claude with a name", async () => {
    const root = tmp();
    const bin = join(root, "bin");
    mkdirSync(bin);
    const record = join(root, "calls.txt");
    const fake = join(bin, "claude");
    writeFileSync(fake, `#!/bin/sh\necho "$PWD|$*" >> '${record}'\nexec sleep 30\n`);
    chmodSync(fake, 0o755);
    for (const p of ["frr", "agent"]) mkdirSync(join(root, "ws", p, ".git"), { recursive: true });
    const socket = `meshrun-${process.pid}`;
    const oldPath = process.env.PATH;
    process.env.PATH = `${bin}:${oldPath}`;
    try {
      const t = env(root, undefined, { cwd: join(root, "ws"), self: [fake] });
      const code = await t.cmd("run").run(["frr", "agent", "--model", "haiku", "--socket-name", socket]);
      expect(t.err.join("\n")).toContain("not set up");
      expect(code).toBe(0);
      const windows = execFileSync("tmux", ["-L", socket, "list-windows", "-t", "mesh", "-F", "#{window_name}"]).toString().trim().split("\n");
      expect(windows).toEqual(["mesh", "frr", "agent"]);
      for (let i = 0; i < 50 && (!existsSync(record) || readFileSync(record, "utf8").split("\n").filter(Boolean).length < 3); i++) {
        await new Promise((r) => setTimeout(r, 100));
      }
      const calls = readFileSync(record, "utf8").trim().split("\n").sort();
      expect(calls).toContain(`${join(root, "ws", "frr")}|-n frr --model haiku`);
      expect(calls).toContain(`${join(root, "ws", "agent")}|-n agent --model haiku`);
      expect(t.out.join("\n")).toContain('Started in tmux session "mesh"');
    } finally {
      process.env.PATH = oldPath;
      try {
        execFileSync("tmux", ["-L", socket, "kill-server"]);
      } catch {
        // already gone
      }
    }
  });

  it("opens OpenCode windows with a private server and the prompt (--agent opencode)", async () => {
    const root = tmp();
    const bin = join(root, "bin");
    mkdirSync(bin);
    const record = join(root, "calls.txt");
    const fake = join(bin, "opencode");
    writeFileSync(fake, `#!/bin/sh\necho "$PWD|$*|$MESH_AUTOPILOT" >> '${record}'\nexec sleep 30\n`);
    chmodSync(fake, 0o755);
    mkdirSync(join(root, "ws", "frr", ".git"), { recursive: true });
    const socket = `meshrunoc-${process.pid}`;
    const oldPath = process.env.PATH;
    process.env.PATH = `${bin}:${oldPath}`;
    try {
      const t = env(root, undefined, { cwd: join(root, "ws"), self: [fake] });
      const code = await t.cmd("run").run(["frr", "--agent", "opencode", "--prompt", "fix the build", "--auto", "chain", "--model", "haiku", "--no-tui", "--socket-name", socket]);
      expect(code).toBe(0);
      expect(t.err.join("\n")).toContain("no --model flag");
      for (let i = 0; i < 50 && !existsSync(record); i++) await new Promise((r) => setTimeout(r, 100));
      expect(readFileSync(record, "utf8").trim()).toBe(`${join(root, "ws", "frr")}|--standalone --prompt fix the build|chain`);
    } finally {
      process.env.PATH = oldPath;
      try {
        execFileSync("tmux", ["-L", socket, "kill-server"]);
      } catch {
        // already gone
      }
    }
  });

  it("refuses --bg with OpenCode", async () => {
    const root = tmp();
    mkdirSync(join(root, "frr", ".git"), { recursive: true });
    const t = env(root);
    expect(await t.cmd("run").run(["frr", "--agent", "opencode", "--bg", "--prompt", "x"])).toBe(2);
  });

  it("refuses --bg without a prompt", async () => {
    const root = tmp();
    mkdirSync(join(root, "frr", ".git"), { recursive: true });
    const t = env(root);
    expect(await t.cmd("run").run(["frr", "--bg"])).toBe(2);
  });
});
