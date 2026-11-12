import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
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

// MM-1 (AC-01 newConfig, AC-02 `mesh setup` share level).
describe("mesh setup share level", () => {
  const ME_LINE = "Sessions without a step will be reported to the hub as metadata that only you can see (state, repo, name, times; no paths or text). Restart the daemon to apply.";
  const STEPS_LINE = "Only sessions holding a step will be reported to the hub. Restart the daemon to apply.";
  const ALL_LINE = "Sessions without a step will be reported to the hub as metadata (state, repo, name, times; no paths or text). Restart the daemon to apply.";
  const level = (t: ReturnType<typeof env>) => JSON.parse(readFileSync(t.paths.daemonConfig, "utf8")).shareSessions as string | undefined;
  const outText = (t: ReturnType<typeof env>) => t.out.join("\n");

  /** An existing config (as an older mesh wrote it) with the given level, or without the field. */
  async function existing(shareSessions: string | undefined) {
    const t = env(tmp());
    expect(await t.cmd("setup").run(["--port", "31236"])).toBe(0);
    const config = JSON.parse(readFileSync(t.paths.daemonConfig, "utf8"));
    if (shareSessions === undefined) delete config.shareSessions;
    else config.shareSessions = shareSessions;
    writeFileSync(t.paths.daemonConfig, JSON.stringify(config, null, 2), { mode: 0o600 });
    t.out.length = 0;
    t.err.length = 0;
    return t;
  }

  it("test_AC01_newConfig_is_me", async () => {
    const { newConfig } = await import("../src/cli/context.ts");
    const { DaemonConfig } = await import("../src/protocol/index.ts");
    const c = newConfig(31237);
    expect(c.shareSessions).toBe("me");
    expect(DaemonConfig.parse(c)).toEqual(c);
  });

  it("test_AC02_fresh_setup_writes_me", async () => {
    const t = env(tmp());
    expect(await t.cmd("setup").run(["--port", "31238"])).toBe(0);
    expect(level(t)).toBe("me");
    expect(outText(t)).toContain(ME_LINE);
  });

  it("test_AC02_existing_steps_kept", async () => {
    const t = await existing("steps");
    expect(await t.cmd("setup").run([])).toBe(0);
    expect(level(t)).toBe("steps");
    expect(outText(t)).not.toContain(ME_LINE);
    expect(outText(t)).not.toContain(STEPS_LINE);
  });

  it("test_AC02_existing_without_field_kept", async () => {
    const t = await existing(undefined);
    expect(await t.cmd("setup").run([])).toBe(0);
    expect([undefined, "steps"]).toContain(level(t));
    expect(outText(t)).not.toContain(ME_LINE);
  });

  it("test_AC02_flag_sets_all", async () => {
    const t = await existing("steps");
    expect(await t.cmd("setup").run(["--share-sessions", "all"])).toBe(0);
    expect(level(t)).toBe("all");
    expect(outText(t)).toContain(ALL_LINE);
  });

  it("test_AC02_alias_share", async () => {
    const t = await existing("steps");
    expect(await t.cmd("setup").run(["--share", "all"])).toBe(0);
    expect(level(t)).toBe("all");
    t.out.length = 0;
    expect(await t.cmd("setup").run(["--share", "me"])).toBe(0);
    expect(level(t)).toBe("me");
    expect(outText(t)).toContain(ME_LINE);
  });

  it("test_AC02_flag_me", async () => {
    const t = await existing("steps");
    expect(await t.cmd("setup").run(["--share-sessions", "me"])).toBe(0);
    expect(level(t)).toBe("me");
    expect(outText(t)).toContain(ME_LINE);
  });

  it("test_AC02_flag_steps_prints_line", async () => {
    const t = await existing("me");
    expect(await t.cmd("setup").run(["--share-sessions", "steps"])).toBe(0);
    expect(level(t)).toBe("steps");
    expect(outText(t)).toContain(STEPS_LINE);
    expect(outText(t)).not.toContain(ME_LINE);
  });

  it("test_AC02_bad_value_exit_2", async () => {
    const t = await existing("me");
    const before = readFileSync(t.paths.daemonConfig);
    expect(await t.cmd("setup").run(["--share-sessions", "nope"])).toBe(2);
    expect(t.err.join("\n")).toContain("--share-sessions must be steps, me or all");
    expect(readFileSync(t.paths.daemonConfig).equals(before)).toBe(true);
  });
});

// MM-2 AC-14: `mesh label` usage (refused before any daemon call) and `mesh help`.
describe("AC-14 mesh label usage", () => {
  const USAGE = "usage: mesh label <session> <label,…> [--add|--rm]";

  it("test_AC14_usage_exit_2", async () => {
    const t = env(tmp());
    const label = meshCommands(t.c).find((x) => x.name === "label") as { run(a: string[]): Promise<number> } | undefined;
    expect(label, "mesh label exists").toBeDefined();
    for (const args of [[], ["s1"], ["s1", "a", "--clear"], ["s1", "a", "--add", "--rm"]]) {
      t.err.length = 0;
      expect(await (label as { run(a: string[]): Promise<number> }).run(args), args.join(" ")).toBe(2);
      const err = t.err.join("\n");
      expect(err.startsWith(USAGE), err).toBe(true);
      expect(err).toContain("mesh label <session> --clear");
    }
  });

  it("test_AC14_bad_label_exit_2_without_daemon", async () => {
    // No daemon is set up: the parse error comes first, so it is exit 2 (not "daemon not running").
    const t = env(tmp());
    const label = meshCommands(t.c).find((x) => x.name === "label") as { run(a: string[]): Promise<number> } | undefined;
    expect(label, "mesh label exists").toBeDefined();
    expect(await (label as { run(a: string[]): Promise<number> }).run(["s1", "bad label"])).toBe(2);
    expect(t.err.join("\n")).toContain("not a label: bad label (");
  });

  it("test_AC14_help_lists_label", async () => {
    const { dispatch } = await import("../src/cli/commands.ts");
    const t = env(tmp());
    const out: string[] = [];
    expect(await dispatch(["help"], meshCommands(t.c), "0.0.0", (x) => out.push(x))).toBe(0);
    const text = [...out, ...t.out].join("\n");
    expect(text).toMatch(/^\s+label\b/m);
    // Positive control: an existing command is listed the same way.
    expect(text).toMatch(/^\s+machines\b/m);
  });
});

// MM-3: usage of the offer commands (refused before any hub or daemon call), `mesh help`, and
// `mesh setup --accept/--assignments` (AC-25, AC-26, AC-28).
describe("MM-3 offer commands: usage and help", () => {
  type Cmd = { run(a: string[]): Promise<number> };
  const find = (t: ReturnType<typeof env>, name: string) => meshCommands(t.c).find((x) => x.name === name) as Cmd | undefined;
  const runCmd = async (t: ReturnType<typeof env>, name: string, args: string[]) => {
    const c = find(t, name);
    expect(c, `mesh ${name} exists`).toBeDefined();
    t.err.length = 0;
    t.out.length = 0;
    return (c as Cmd).run(args);
  };

  it("test_AC25_missing_to_usage", async () => {
    const t = env(tmp());
    for (const args of [[], ["G1"], ["G1.a"], ["G1", "--stick"]]) {
      expect(await runCmd(t, "assign", args), args.join(" ")).toBe(2);
      const err = t.err.join("\n");
      expect(err.startsWith('usage: mesh assign <goal|step> --to <machine>[/<session>] [--stick] [--note "…"]'), err).toBe(true);
    }
  });

  it("test_AC26_accept_both_flags", async () => {
    const t = env(tmp());
    for (const args of [[], ["G1.a", "--session", "a", "--launch"]]) {
      expect(await runCmd(t, "accept", args), args.join(" ")).toBe(2);
      expect(t.err.join("\n")).toContain("usage: mesh accept <step> [--session <s> | --launch]");
    }
  });

  it("test_AC26_decline_without_step", async () => {
    const t = env(tmp());
    expect(await runCmd(t, "decline", [])).toBe(2);
    expect(t.err.join("\n")).toContain("usage:");
  });

  it("test_AC26_session_accept_bad_rule_no_call", async () => {
    // No daemon is set up: the parse error comes first, so it is exit 2 (not "daemon not running").
    const t = env(tmp());
    expect(await runCmd(t, "session", ["accept", "perf", "--from", "bob"])).toBe(2);
    expect(t.err.join("\n")).toContain("not an accept rule: bob (an accept rule is self, off, user:<id> or machine:<nickname or id>)");
  });

  it("test_AC26_session_accept_usage", async () => {
    const t = env(tmp());
    for (const args of [["accept", "perf"], ["accept", "perf", "--off", "--clear"], ["accept", "perf", "--from", "self", "--off"], ["accept"]]) {
      expect(await runCmd(t, "session", args), args.join(" ")).toBe(2);
      const err = t.err.join("\n");
      expect(err.startsWith("usage: mesh session accept <session> --from <rule,…> | --off | --clear"), err).toBe(true);
    }
  });

  it("test_AC26_help_lists", async () => {
    const { dispatch } = await import("../src/cli/commands.ts");
    const t = env(tmp());
    const out: string[] = [];
    expect(await dispatch(["help"], meshCommands(t.c), "0.0.0", (x) => out.push(x))).toBe(0);
    const text = [...out, ...t.out].join("\n");
    // Positive control: an existing command is listed the same way.
    expect(text).toMatch(/^\s+machines\b/m);
    for (const name of ["assign", "offers", "accept", "decline", "withdraw", "session"]) expect(text, name).toMatch(new RegExp(`^\\s+${name}\\b`, "m"));
  });
});

describe("MM-3 mesh setup --accept / --assignments", () => {
  const cfg = (t: ReturnType<typeof env>) => JSON.parse(readFileSync(t.paths.daemonConfig, "utf8")) as Record<string, unknown>;
  const outText = (t: ReturnType<typeof env>) => t.out.join("\n");
  async function existing() {
    const t = env(tmp());
    expect(await t.cmd("setup").run(["--port", "31240"])).toBe(0);
    t.out.length = 0;
    t.err.length = 0;
    return t;
  }

  it("test_AC28_accept_user", async () => {
    const t = await existing();
    expect(await t.cmd("setup").run(["--accept", "user:bob"])).toBe(0);
    expect(cfg(t).accept).toStrictEqual(["user:bob"]);
    expect(outText(t)).toContain("Offers from user:bob are accepted automatically. Restart the daemon to apply.");
  });

  it("test_AC28_accept_multi", async () => {
    const t = await existing();
    expect(await t.cmd("setup").run(["--accept", "self,user:bob"])).toBe(0);
    expect(cfg(t).accept).toStrictEqual(["self", "user:bob"]);
    expect(outText(t)).toContain("Offers from self, user:bob are accepted automatically. Restart the daemon to apply.");
  });

  it("test_AC28_accept_off", async () => {
    const t = await existing();
    expect(await t.cmd("setup").run(["--accept", "off"])).toBe(0);
    expect(cfg(t).accept).toStrictEqual(["off"]);
    expect(outText(t)).toContain("No offer is accepted automatically. Restart the daemon to apply.");
  });

  it("test_AC28_accept_bad", async () => {
    const t = await existing();
    const before = readFileSync(t.paths.daemonConfig);
    expect(await t.cmd("setup").run(["--accept", "bad"])).toBe(2);
    expect(t.err.join("\n")).toContain("not an accept rule: bad (");
    expect(readFileSync(t.paths.daemonConfig).equals(before)).toBe(true);
  });

  it("test_AC28_assignments_launch", async () => {
    const t = await existing();
    expect(await t.cmd("setup").run(["--assignments", "launch"])).toBe(0);
    expect(cfg(t).assignments).toBe("launch");
  });

  it("test_AC28_assignments_bad", async () => {
    const t = await existing();
    const before = readFileSync(t.paths.daemonConfig);
    expect(await t.cmd("setup").run(["--assignments", "x"])).toBe(2);
    expect(t.err.join("\n")).toContain("--assignments must be deliver, launch or off");
    expect(readFileSync(t.paths.daemonConfig).equals(before)).toBe(true);
  });

  it("test_AC28_other_setup_keeps", async () => {
    const t = await existing();
    const c = cfg(t);
    writeFileSync(t.paths.daemonConfig, JSON.stringify({ ...c, accept: ["user:bob"], assignments: "off" }, null, 2), { mode: 0o600 });
    expect(await t.cmd("setup").run(["--share", "me"])).toBe(0);
    // Positive control: the setup ran (it wrote the share level).
    expect(cfg(t).shareSessions).toBe("me");
    expect(cfg(t).accept).toStrictEqual(["user:bob"]);
    expect(cfg(t).assignments).toBe("off");
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
    // A port the OS just handed out, not setup's random pick: parallel test files collided on it.
    const port = await new Promise<number>((done) => {
      const srv = createServer();
      srv.listen(0, "127.0.0.1", () => {
        const p = (srv.address() as { port: number }).port;
        srv.close(() => done(p));
      });
    });
    await t.cmd("setup").run(["--port", String(port)]);
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

// ---------------------------------------------------------------------------------------------
// MM-4: `mesh assign` usage with --suggest (AC-10), `mesh help` (AC-10), `mesh setup --max-sessions` (AC-14).

const MM3_ASSIGN_USAGE = 'usage: mesh assign <goal|step> --to <machine>[/<session>] [--stick] [--note "…"]';
const ASSIGN_USAGE = `${MM3_ASSIGN_USAGE}\n       mesh assign <goal|step> --suggest [--team] [--any] [--json]`;

describe("AC-10 mesh assign usage with --suggest", () => {
  /** A counting stub hub; the CLI's credentials point at it. Every request answers 404 JSON. */
  async function rig() {
    const t = env(tmp());
    const seen: string[] = [];
    const server = createServer((req, res) => {
      seen.push(`${req.method} ${req.url}`);
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "no machine m2" }));
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
    const port = (server.address() as { port: number }).port;
    mkdirSync(t.paths.configDir, { recursive: true });
    writeFileSync(t.paths.credentials, JSON.stringify({ hub: `http://127.0.0.1:${port}`, token: "t", user: { id: "alice", name: "alice", roles: [] }, machine: "m-00000001" }));
    const run = async (args: string[]) => {
      t.out.length = 0;
      t.err.length = 0;
      const code = await t.cmd("assign").run(args);
      return { code, err: t.err.join("\n"), out: t.out.join("\n") };
    };
    return { t, seen, run, close: () => new Promise((r) => server.close(r)) };
  }

  const CASES: [string, string[][]][] = [
    ["test_AC10_suggest_with_to", [["G1", "--suggest", "--to", "m2"]]],
    ["test_AC10_suggest_with_stick", [["G1", "--suggest", "--stick"]]],
    ["test_AC10_suggest_with_note", [["G1", "--suggest", "--note", "x"]]],
    ["test_AC10_team_without_suggest", [["G1", "--to", "m2", "--team"], ["G1", "--team"]]],
    ["test_AC10_any_without_suggest", [["G1", "--any"], ["G1", "--to", "m2", "--any"]]],
    ["test_AC10_json_without_suggest", [["G1", "--to", "m2", "--json"]]],
    ["test_AC10_neither", [["G1"], ["G1.a"]]],
    ["test_AC10_no_target", [[], ["--suggest"]]],
  ];

  for (const [name, argsList] of CASES)
    it(name, async () => {
      const r = await rig();
      try {
        for (const args of argsList) {
          const x = await r.run(args);
          expect(x.code, args.join(" ")).toBe(2);
          expect(x.err.trim(), args.join(" ")).toBe(ASSIGN_USAGE);
          // test_AC10_first_line_mm3
          expect(x.err.split("\n")[0], args.join(" ")).toBe(MM3_ASSIGN_USAGE);
        }
        // test_AC10_no_hub_call
        expect(r.seen).toEqual([]);
      } finally {
        await r.close();
      }
    });

  it("test_AC10_no_hub_call_control", async () => {
    // A valid --to call does reach the stub (so the zero count above means no call was made).
    const r = await rig();
    try {
      const x = await r.run(["G1.a", "--to", "m2"]);
      expect(x.code).toBe(1);
      expect(r.seen.length).toBeGreaterThan(0);
    } finally {
      await r.close();
    }
  });

  it("test_AC10_help_lines", async () => {
    const { dispatch } = await import("../src/cli/commands.ts");
    const t = env(tmp());
    const out: string[] = [];
    expect(await dispatch(["help"], meshCommands(t.c), "0.0.0", (x) => out.push(x))).toBe(0);
    const text = [...out, ...t.out].join("\n");
    expect(text).toContain("send a message to a session: mesh say <session> <text>, or <machine>/<session> for another machine");
    const assignLine = text.split("\n").find((l) => /^\s+assign\b/.test(l));
    expect(assignLine, "assign is listed").toBeDefined();
    expect(assignLine).toContain("--suggest");
  });
});

describe("AC-14 mesh setup --max-sessions", () => {
  const MAX_BAD = "--max-sessions must be a whole number from 1 to 1000, or off";
  const MAX_ON = (n: number) => `An offer starts a session only while fewer than ${n} are live. Restart the daemon to apply.`;
  const MAX_OFF = "An offer may start a session however many are live. Restart the daemon to apply.";
  const cfg = (t: ReturnType<typeof env>) => JSON.parse(readFileSync(t.paths.daemonConfig, "utf8")) as Record<string, unknown>;
  async function existing() {
    const t = env(tmp());
    expect(await t.cmd("setup").run(["--port", "31250"])).toBe(0);
    t.out.length = 0;
    t.err.length = 0;
    return t;
  }

  it("test_AC14_setup_n", async () => {
    const t = await existing();
    const before = cfg(t);
    expect(await t.cmd("setup").run(["--max-sessions", "3"])).toBe(0);
    expect(cfg(t)).toStrictEqual({ ...before, maxSessions: 3 });
    expect(t.out.join("\n")).toContain(MAX_ON(3));
  });

  it("test_AC14_setup_off", async () => {
    const t = await existing();
    expect(await t.cmd("setup").run(["--max-sessions", "3"])).toBe(0);
    expect(cfg(t).maxSessions).toBe(3);
    t.out.length = 0;
    expect(await t.cmd("setup").run(["--max-sessions", "off"])).toBe(0);
    expect(Object.hasOwn(cfg(t), "maxSessions")).toBe(false);
    expect(t.out.join("\n")).toContain(MAX_OFF);
  });

  it("test_AC14_setup_bad", async () => {
    const t = await existing();
    // Positive control: a good value is written (so the refusals below are the parser, not a broken flag).
    expect(await t.cmd("setup").run(["--max-sessions", "5"])).toBe(0);
    const before = readFileSync(t.paths.daemonConfig);
    for (const args of [["--max-sessions", "x"], ["--max-sessions", "0"], ["--max-sessions", "1001"], ["--max-sessions", "2.5"], ["--max-sessions"]]) {
      t.err.length = 0;
      expect(await t.cmd("setup").run(args), args.join(" ")).toBe(2);
      expect(t.err.join("\n").trim(), args.join(" ")).toBe(MAX_BAD);
      expect(readFileSync(t.paths.daemonConfig).equals(before), args.join(" ")).toBe(true);
    }
  });

  it("test_AC14_setup_bounds_ok", async () => {
    const t = await existing();
    for (const n of [1, 1000]) {
      expect(await t.cmd("setup").run(["--max-sessions", String(n)]), String(n)).toBe(0);
      expect(cfg(t).maxSessions).toBe(n);
    }
  });

  it("test_AC14_setup_without_flag_keeps", async () => {
    const t = await existing();
    writeFileSync(t.paths.daemonConfig, JSON.stringify({ ...cfg(t), maxSessions: 4 }, null, 2), { mode: 0o600 });
    expect(await t.cmd("setup").run(["--share", "me"])).toBe(0);
    // Positive control: the setup ran (it wrote the share level).
    expect(cfg(t).shareSessions).toBe("me");
    expect(cfg(t).maxSessions).toBe(4);
  });
});
