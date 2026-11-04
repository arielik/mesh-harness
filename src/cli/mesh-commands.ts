// The M1 commands: setup, doctor, ls, say, jump, run, tui (plan §6.2, §7, §9).

import { existsSync } from "node:fs";
import { basename } from "node:path";
import {
  claudeVersion,
  compareVersions,
  inspectSettingsFile,
  installSettingsFile,
  MIN_CLAUDE_VERSION,
  run as runProgram,
  uninstallSettingsFile,
  type Runner,
} from "../claude/index.ts";
import { findSession, needsLabel, sessionLabel } from "../core/index.ts";
import { bindReturnKey, hasSession, newSession, newWindow, serverFromEnv, type TmuxServer } from "../mux/index.ts";
import type { DaemonConfig, MeshPaths, Session } from "../protocol/index.ts";
import { DaemonClient } from "./client.ts";
import type { Command } from "./commands.ts";
import { loadConfig, newConfig, parseArgs, saveConfig, type Io } from "./context.ts";
import { defaultRoots, resolveRepo } from "./repos.ts";
import { age, groupOf, ordered } from "./tui/render.ts";
import { jump, runTui } from "./tui/tui.ts";

export interface CliEnv {
  io: Io;
  paths: MeshPaths;
  env: Record<string, string | undefined>;
  cwd: string;
  /** argv to start this mesh binary (node + script), for tmux windows and services. */
  self: string[];
  runner?: Runner;
  version: string;
}

function client(c: CliEnv): DaemonClient {
  return new DaemonClient(loadConfig(c.paths));
}

export function setupCommand(c: CliEnv): Command {
  return {
    name: "setup",
    summary: "install mesh's hooks into Claude Code (--uninstall to remove)",
    async run(args) {
      const a = parseArgs(args, ["port"]);
      if (a.has("uninstall")) {
        const r = uninstallSettingsFile(c.paths.claudeSettings);
        c.io.out(r.changed ? `Removed mesh hooks from ${c.paths.claudeSettings}.` : "No mesh hooks were installed.");
        return 0;
      }
      let config: DaemonConfig;
      const port = a.str("port") ? Number(a.str("port")) : undefined;
      if (existsSync(c.paths.daemonConfig)) {
        config = loadConfig(c.paths);
        if (port !== undefined) config = { ...config, port };
        if (a.has("no-notify")) config = { ...config, notify: false };
      } else {
        config = newConfig(port);
        if (a.has("no-notify")) config.notify = false;
      }
      saveConfig(c.paths, config);
      const r = installSettingsFile(c.paths.claudeSettings, config);
      c.io.out(
        [
          `Config: ${c.paths.daemonConfig} (daemon port ${config.port})`,
          r.changed ? `Installed 5 hooks into ${c.paths.claudeSettings}.` : `Hooks already installed in ${c.paths.claudeSettings}.`,
          "Claude sessions started from now on report to mesh. Next:",
          "  mesh up             # run the daemon here, or",
          "  mesh up --install   # run it as a user service",
          "  mesh                # the session list",
        ].join("\n"),
      );
      return 0;
    },
  };
}

export function doctorCommand(c: CliEnv): Command {
  return {
    name: "doctor",
    summary: "check the installation",
    async run() {
      const runner = c.runner ?? runProgram;
      let failed = false;
      const ok = (t: string) => c.io.out(`✓ ${t}`);
      const bad = (t: string) => {
        failed = true;
        c.io.out(`✗ ${t}`);
      };
      const warn = (t: string) => c.io.out(`! ${t}`);

      let config: DaemonConfig | undefined;
      try {
        config = loadConfig(c.paths);
        ok(`config ${c.paths.daemonConfig}`);
      } catch (e) {
        bad(e instanceof Error ? e.message : String(e));
      }
      const v = await claudeVersion(runner);
      if (!v) bad("claude not found on PATH");
      else if (compareVersions(v, MIN_CLAUDE_VERSION) < 0) bad(`claude ${v} is older than ${MIN_CLAUDE_VERSION}; run: claude update`);
      else ok(`claude ${v}`);
      if ((await runner("curl", ["--version"], { timeoutMs: 5_000 })).code === 0) ok("curl");
      else bad("curl not found (the hooks use it)");
      if ((await runner("tmux", ["-V"], { timeoutMs: 5_000 })).code === 0) ok("tmux");
      else warn("tmux not found: jump and typing into sessions need it");
      if (config) {
        const st = inspectSettingsFile(c.paths.claudeSettings, config);
        if (st.installed.length === 5 && st.stale.length === 0) ok(`hooks installed in ${c.paths.claudeSettings}`);
        else if (st.installed.length === 0) bad("hooks not installed; run: mesh setup");
        else bad(`hooks out of date (${[...new Set([...st.stale])].join(", ") || "incomplete"}); run: mesh setup`);
        try {
          const h = await new DaemonClient(config).health();
          ok(`daemon running on 127.0.0.1:${config.port} (${h.sessions} live sessions)`);
        } catch (e) {
          bad(e instanceof Error ? e.message : String(e));
        }
      }
      return failed ? 1 : 0;
    },
  };
}

function line(s: Session, now: number): string {
  const g = groupOf(s);
  const what = g === "NEEDS YOU" ? needsLabel(s) : g === "IDLE" && s.lastMessage ? `done: ${s.lastMessage}` : g.toLowerCase();
  const since = age(now - (s.lastStopAt ?? s.lastEventAt));
  return `${sessionLabel(s).padEnd(24)} ${s.state.padEnd(9)} ${since.padStart(4)}  ${s.pane ?? s.bgId ?? "-"}  ${what}`;
}

export function lsCommand(c: CliEnv): Command {
  return {
    name: "ls",
    summary: "list your Claude sessions (--json)",
    async run(args) {
      const a = parseArgs(args);
      const data = await client(c).sessions();
      if (a.has("json")) {
        c.io.out(JSON.stringify(data, null, 2));
        return 0;
      }
      const now = Date.now();
      const list = ordered(data.sessions);
      if (list.length === 0) c.io.out("No sessions.");
      for (const s of list) c.io.out(line(s, now));
      return 0;
    },
  };
}

export function sayCommand(c: CliEnv): Command {
  return {
    name: "say",
    summary: "send a message to a session: mesh say <session> <text>",
    async run(args) {
      const [target, ...words] = args;
      if (!target || words.length === 0) {
        c.io.err("usage: mesh say <session> <text>");
        return 2;
      }
      const r = await client(c).say(target, words.join(" "));
      c.io.out(r.message.state === "delivered" ? "Delivered." : "Queued; mesh delivers it as soon as the session can take it.");
      return 0;
    },
  };
}

export function jumpCommand(c: CliEnv): Command {
  return {
    name: "jump",
    summary: "switch to a session's tmux pane, or attach a background session",
    async run(args) {
      const [target] = args;
      if (!target) {
        c.io.err("usage: mesh jump <session>");
        return 2;
      }
      const s = findSession((await client(c).sessions()).sessions, target);
      if (!s) {
        c.io.err(`no live session matches "${target}"`);
        return 1;
      }
      const r = await jump(s, c.env);
      if (r.message) (r.ok ? c.io.out : c.io.err)(r.message);
      return r.ok ? 0 : 1;
    },
  };
}

export function tuiCommand(c: CliEnv): Command {
  return {
    name: "tui",
    summary: "the live session list (also: plain `mesh`)",
    async run() {
      const config = loadConfig(c.paths);
      return runTui(new DaemonClient(config), { header: `mesh ${c.version} · ${c.env.USER ?? ""}`, env: c.env });
    },
  };
}

export function runCommand(c: CliEnv): Command {
  return {
    name: "run",
    summary: "start claude in tmux windows, one per repo: mesh run <repo…> [--bg --prompt P] [--model M]",
    async run(args) {
      const a = parseArgs(args, ["model", "prompt", "session", "socket-name"]);
      if (a.positional.length === 0) {
        c.io.err("usage: mesh run <repo…> [--model M] [--prompt P] [--bg] [--session NAME] [--no-tui] [--no-bind]");
        return 2;
      }
      let config: DaemonConfig | undefined;
      try {
        config = loadConfig(c.paths);
      } catch {
        c.io.err("warning: mesh is not set up (run `mesh setup`); these sessions won't report to mesh.");
      }
      const roots = defaultRoots(c.cwd, config?.workspaceRoots ?? []);
      const dirs = a.positional.map((r) => resolveRepo(r, roots));
      const model = a.str("model");
      const prompt = a.str("prompt");
      const runner = c.runner ?? runProgram;

      if (a.has("bg")) {
        if (!prompt) {
          c.io.err("--bg needs --prompt: a background session must start with a task");
          return 2;
        }
        for (const dir of dirs) {
          const name = basename(dir);
          const argv = ["--bg", "--name", name, ...(model ? ["--model", model] : []), prompt];
          const r = await runner("claude", argv, { cwd: dir, timeoutMs: 60_000 });
          if (r.code !== 0) {
            c.io.err(`${name}: ${(r.stderr || r.stdout).trim()}`);
            return 1;
          }
          c.io.out(`${name}: ${r.stdout.split("\n")[0]?.trim()}`);
        }
        return 0;
      }

      const sessionName = a.str("session") ?? "mesh";
      const inTmux = serverFromEnv(c.env.TMUX);
      const server: TmuxServer = a.str("socket-name") ? { socketName: a.str("socket-name") } : (inTmux ?? {});
      const tmux = { ...server, runner };
      const created = !(await hasSession(sessionName, tmux));
      const claudeArgv = (name: string) => ["claude", "-n", name, ...(model ? ["--model", model] : []), ...(prompt ? [prompt] : [])];
      const windows: string[] = [];
      let first = true;
      if (created) {
        if (!a.has("no-tui")) {
          await newSession(sessionName, { name: "mesh", cwd: c.cwd, argv: [...c.self, "tui"] }, tmux);
          first = false;
        }
        if (!a.has("no-bind")) await bindReturnKey(sessionName, "m", tmux);
      }
      for (const dir of dirs) {
        const name = basename(dir);
        const spec = { name, cwd: dir, argv: claudeArgv(name) };
        const pane = first ? await newSession(sessionName, spec, tmux) : await newWindow(sessionName, spec, tmux);
        first = false;
        windows.push(`${name} (${pane})`);
      }
      c.io.out(`Started in tmux session "${sessionName}": ${windows.join(", ")}`);
      if (created && !a.has("no-bind")) c.io.out("Press prefix + m to come back to the mesh window.");
      if (!inTmux) c.io.out(`Attach with: tmux attach -t ${sessionName}`);
      else if (created) c.io.out(`Switch with: tmux switch-client -t ${sessionName}`);
      c.io.out("A new folder shows Claude's trust dialog first; mesh lists that window as needing you until you accept it.");
      return 0;
    },
  };
}

export function meshCommands(c: CliEnv): Command[] {
  return [setupCommand(c), doctorCommand(c), lsCommand(c), sayCommand(c), jumpCommand(c), runCommand(c), tuiCommand(c)];
}
