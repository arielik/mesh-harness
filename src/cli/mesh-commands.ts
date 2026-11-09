// The M1 commands: setup, doctor, ls, say, jump, run, tui (plan §6.2, §7, §9).

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import {
  claudeMdInstalled,
  claudeStatePath,
  folderTrusted,
  claudeVersion,
  compareVersions,
  inspectSettingsFile,
  installMcp,
  installSkill,
  skillStatus,
  uninstallSkill,
  installSettingsFile,
  mcpInstalled,
  MIN_CLAUDE_VERSION,
  run as runProgram,
  type Runner,
  uninstallClaudeMd,
  uninstallMcp,
  uninstallSettingsFile,
} from "../claude/index.ts";
import { findSession, needsLabel, sessionLabel } from "../core/index.ts";
import { bindReturnKey, hasSession, newSession, newWindow, paneSocket, serverFromEnv, type TmuxServer } from "../mux/index.ts";
import { HOOK_KINDS, HOOKS_VERSION, MESH_SKILL, type DaemonConfig, type NotifyMode, type GoalDetail, type Session, type Step } from "../protocol/index.ts";
import { DaemonClient } from "./client.ts";
import type { Command } from "./commands.ts";
import { loadConfig, newConfig, parseArgs, saveConfig, type CliEnv } from "./context.ts";

export type { CliEnv } from "./context.ts";
import { HubClient, loadCredentials } from "./hub-client.ts";
import { hubCommands } from "./hub-commands.ts";
import { assetsCommand } from "./assets.ts";
import { ledgerCommand } from "./ledger.ts";
import { defaultRoots, resolveRepo } from "./repos.ts";
import { age, groupOf, ordered, since } from "./tui/render.ts";
import { jump, runTui } from "./tui/tui.ts";


function client(c: CliEnv): DaemonClient {
  return new DaemonClient(loadConfig(c.paths));
}

export function setupCommand(c: CliEnv): Command {
  return {
    name: "setup",
    summary: "install mesh's hooks into Claude Code (--uninstall to remove)",
    async run(args) {
      const a = parseArgs(args, ["port", "notify"]);
      const notifyArg = a.str("notify");
      if (notifyArg !== undefined && !["desktop", "terminal", "both", "off"].includes(notifyArg)) {
        c.io.err("--notify must be desktop, terminal, both or off");
        return 2;
      }
      const runner = c.runner ?? runProgram;
      if (a.has("uninstall")) {
        const r = uninstallSettingsFile(c.paths.claudeSettings);
        const md = uninstallClaudeMd(c.paths.claudeMd);
        const skill = uninstallSkill(c.paths.claudeSkill);
        const mcp = await uninstallMcp(runner);
        c.io.out(
          [
            r.changed ? `Removed mesh hooks from ${c.paths.claudeSettings}.` : "No mesh hooks were installed.",
            md.changed ? `Removed the mesh block from ${c.paths.claudeMd}.` : "",
            skill.changed ? `Removed the mesh skill ${c.paths.claudeSkill}.` : "",
            mcp ? "Removed the mesh MCP server." : "",
          ]
            .filter(Boolean)
            .join("\n"),
        );
        return 0;
      }
      let config: DaemonConfig;
      const port = a.str("port") ? Number(a.str("port")) : undefined;
      if (existsSync(c.paths.daemonConfig)) {
        config = loadConfig(c.paths);
        if (port !== undefined) config = { ...config, port };
        if (a.has("no-notify")) config = { ...config, notify: false };
        if (notifyArg) config = { ...config, notify: notifyArg as NotifyMode };
      } else {
        config = newConfig(port);
        if (a.has("no-notify")) config.notify = false;
        if (notifyArg) config.notify = notifyArg as NotifyMode;
      }
      saveConfig(c.paths, config);
      const r = installSettingsFile(c.paths.claudeSettings, config);
      const mcp = a.has("no-mcp") ? { ok: true, skipped: true } : await installMcp([...c.self, "mcp"], runner);
      // The skill replaces the CLAUDE.md block older versions wrote: remove that block if present.
      const legacy = uninstallClaudeMd(c.paths.claudeMd);
      const skill = a.has("no-mcp") ? undefined : installSkill(c.paths.claudeSkill);
      c.io.out(
        [
          `Config: ${c.paths.daemonConfig} (daemon port ${config.port})`,
          r.changed ? `Installed ${HOOK_KINDS.length} hooks (v${HOOKS_VERSION}) into ${c.paths.claudeSettings}.` : `Hooks (v${HOOKS_VERSION}) already installed in ${c.paths.claudeSettings}.`,
          "skipped" in mcp ? "Skipped the MCP server and the skill (--no-mcp)." : mcp.ok ? "Registered the mesh MCP server." : `Could not register the MCP server: ${"error" in mcp ? mcp.error : ""}`,
          skill?.foreign
            ? `Left ${c.paths.claudeSkill} alone: mesh did not write it. Move it away and run mesh setup again to get the mesh skill.`
            : skill
              ? `${skill.changed ? "Installed" : "Kept"} the mesh skill ${c.paths.claudeSkill}.`
              : "",
          legacy.changed ? `Removed the old mesh block from ${c.paths.claudeMd} (the skill replaces it).` : "",
          r.changed ? "Sessions that are already open keep their old hooks until you restart them." : "",
          "Claude sessions started from now on report to mesh. Next:",
          "  mesh up             # run the daemon here, or",
          "  mesh up --install   # run it as a user service",
          "  mesh                # the session list",
        ]
          .filter(Boolean)
          .join("\n"),
      );
      return 0;
    },
  };
}

export function skillCommand(c: CliEnv): Command {
  return {
    name: "skill",
    summary: "print the mesh skill for Claude Code (mesh setup installs it)",
    async run() {
      c.io.out(MESH_SKILL.trimEnd());
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
        if (st.installed.length === HOOK_KINDS.length && st.stale.length === 0) ok(`hooks v${HOOKS_VERSION} installed in ${c.paths.claudeSettings}`);
        else if (st.installed.length === 0) bad("hooks not installed; run: mesh setup");
        else if ((st.version ?? HOOKS_VERSION) < HOOKS_VERSION) bad(`hooks are from an older mesh (v${st.version}, this mesh writes v${HOOKS_VERSION}); run: mesh setup`);
        else bad(`hooks out of date (${[...new Set([...st.stale])].join(", ") || "incomplete"}); run: mesh setup`);
        if (await mcpInstalled(runner)) ok("mesh MCP server registered");
        else warn("mesh MCP server not registered (agents can't use mesh tools); run: mesh setup");
        const sk = skillStatus(c.paths.claudeSkill);
        if (sk === "current") ok(`mesh skill ${c.paths.claudeSkill}`);
        else if (sk === "foreign") warn(`${c.paths.claudeSkill} was not written by mesh; agents get mesh's own instructions only from the MCP server`);
        else warn(`mesh skill ${sk === "missing" ? "not installed" : "out of date"}; run: mesh setup`);
        if (claudeMdInstalled(c.paths.claudeMd)) warn(`old mesh block in ${c.paths.claudeMd} (the skill replaces it); run: mesh setup`);
        try {
          const d = new DaemonClient(config);
          const h = await d.health();
          ok(`daemon running on 127.0.0.1:${config.port} (${h.sessions} live sessions)`);
          const st = await d.status();
          const old = st.oldHooks ?? 0;
          if (old > 0) warn(`${old} open session${old === 1 ? "" : "s"} started before the hooks were updated; restart ${old === 1 ? "it" : "them"} (exit, then claude --continue) to pick up the new hooks`);
          const creds = loadCredentials(c.paths);
          if (!creds) {
            if (st.mode === "solo") ok(`Solo: working on the local hub ${st.hubUrl ?? ""} (log in to a team hub with: mesh login --hub <url>)`);
            else warn("not logged in to a hub and no Solo hub; restart mesh up, or run: mesh login --hub <url>");
          } else if (st.hub === "ok") ok(`hub ${creds.hub} as ${creds.user.id}${st.outbox ? ` (${st.outbox} events waiting to sync)` : ""}`);
          else if (st.hub === "offline")
            warn(`hub ${creds.hub} offline${st.offlineSince ? ` since ${new Date(st.offlineSince).toISOString().slice(11, 16)} UTC` : ""}: working locally (${st.outbox} events, ${st.queued} calls queued)`);
          else bad(`hub ${creds.hub}: ${st.hub}${st.error ? ` (${st.error})` : ""}`);
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
  const ago = age(since(s, now));
  return `${sessionLabel(s).padEnd(24)} ${(s.step ?? "-").padEnd(14)} ${s.state.padEnd(9)} ${ago.padStart(4)}  ${s.pane ?? s.bgId ?? "-"}  ${what}`;
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
    summary: "start claude in tmux, one window per repo: mesh run <repo…> [--step S [--worktree] [--base REF] | --design G] [--auto L] [--bg --prompt P]",
    async run(args) {
      const a = parseArgs(args, ["model", "prompt", "session", "socket-name", "step", "auto", "design", "base"]);
      const designGoal = a.str("design");
      let design: GoalDetail | undefined;
      if (designGoal) {
        design = await HubClient.from(c.paths).get<GoalDetail>(`/v1/goals/${encodeURIComponent(designGoal)}`);
        if (a.positional.length === 0) {
          if (!design.goal.primaryRepo) {
            c.io.err(`${design.goal.id} has no primary repo; say where to design: mesh run <repo> --design ${design.goal.id}`);
            return 2;
          }
          a.positional.push(design.goal.primaryRepo);
        }
      }
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
      const extraArgv: string[] = [];
      const model = a.str("model");
      const step = a.str("step") ?? (design ? `${design.goal.id}.design` : undefined);
      const addDirs: string[] = [];
      for (const r of design?.goal.repos ?? []) {
        try {
          addDirs.push(resolveRepo(r, roots));
        } catch (e) {
          c.io.err(`warning: ${e instanceof Error ? e.message.split("\n")[0] : String(e)} (the design session won't see ${r})`);
        }
      }
      const auto = a.str("auto");
      if (auto && auto !== "off" && auto !== "nudge" && auto !== "chain") {
        c.io.err("--auto must be off, nudge or chain");
        return 2;
      }
      if (step && dirs.length !== 1) {
        c.io.err("--step starts one session: give exactly one repo");
        return 2;
      }
      if (step) {
        // Claim first so nobody else takes it while Claude starts; the session re-binds on start.
        const claimed = await HubClient.from(c.paths).post<Step>(`/v1/steps/${encodeURIComponent(step)}/claim`, {});
        c.io.out(`Claimed ${claimed.id}.`);
        const runner = c.runner ?? runProgram;
        // M4.5: one worktree and branch per step (the plan's `worktree`, or --worktree).
        if (a.has("worktree") || claimed.policy?.worktree) {
          const wt = await stepWorktree(runner, dirs[0] as string, claimed, a.str("base"));
          if (!wt.ok) {
            c.io.err(wt.error);
            return 1;
          }
          dirs[0] = wt.path;
          c.io.out(`${wt.created ? "Created" : "Using"} worktree ${wt.path} on branch ${wt.branch}${wt.created ? ` from ${wt.base}` : ""}.`);
        }
        // Paths the step must not read become Claude Code deny rules for its session (best effort).
        if (claimed.policy?.forbid?.length) {
          const file = join(c.paths.stateDir, "step-settings", `${claimed.id}.json`);
          mkdirSync(dirname(file), { recursive: true });
          writeFileSync(file, `${JSON.stringify({ permissions: { deny: claimed.policy.forbid.flatMap((p) => [`Read(${p})`, `Edit(${p})`]) } }, null, 2)}\n`);
          extraArgv.push("--settings", file);
          c.io.out(`The session may not read: ${claimed.policy.forbid.join(", ")} (Claude Code deny rules; shell commands are not covered).`);
        }
      }
      const prompt =
        a.str("prompt") ??
        (design
          ? `You hold the design step of mesh goal ${design.goal.id} "${design.goal.title}". Start with the mesh_context tool and follow its brief: write the design document, then propose the plan with mesh_plan.`
          : step
            ? `You hold mesh step ${step}. Start with the mesh_context tool, then work on it.`
            : undefined);
      const env: Record<string, string> = { ...(step ? { MESH_STEP: step } : {}), ...(auto ? { MESH_AUTOPILOT: auto } : {}) };
      const runner = c.runner ?? runProgram;

      if (a.has("bg")) {
        if (!prompt) {
          c.io.err("--bg needs --prompt: a background session must start with a task");
          return 2;
        }
        for (const dir of dirs) {
          const name = basename(dir);
          const argv = ["--bg", "--name", name, ...(model ? ["--model", model] : []), prompt];
          const r = await runner("claude", argv, { cwd: dir, timeoutMs: 60_000, env });
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
      // The prompt goes first: --add-dir takes a variable number of values.
      const claudeArgv = (name: string) => ["claude", ...(prompt ? [prompt] : []), "-n", name, ...(model ? ["--model", model] : []), ...extraArgv, ...addDirs.flatMap((d) => ["--add-dir", d])];
      const windows: string[] = [];
      let first = true;
      if (created) {
        if (!a.has("no-tui")) {
          await newSession(sessionName, { name: "mesh", cwd: c.cwd, argv: [...c.self, "tui"] }, tmux);
          first = false;
        }
        if (!a.has("no-bind")) await bindReturnKey(sessionName, "m", tmux);
      }
      const untrusted: string[] = [];
      let listed = config !== undefined;
      for (const dir of dirs) {
        const name = basename(dir);
        const label = step ? `${name}·${step}` : name;
        const spec = { name, cwd: dir, argv: claudeArgv(label), env };
        const pane = first ? await newSession(sessionName, spec, tmux) : await newWindow(sessionName, spec, tmux);
        first = false;
        windows.push(`${name} (${pane})`);
        if (folderTrusted(dir, claudeStatePath(c.env, c.env.HOME)) === false) untrusted.push(`${name} (${pane})`);
        // Until Claude's first hook, the daemon lists the window itself (it may wait at the trust prompt).
        if (config) {
          try {
            const socket = await paneSocket(pane, tmux);
            await new DaemonClient(config).launch({ pane, cwd: dir, name: label, ...(socket ? { tmuxSocket: socket } : {}), ...(step ? { step } : {}) });
          } catch {
            listed = false;
          }
        }
      }
      c.io.out(`Started in tmux session "${sessionName}": ${windows.join(", ")}`);
      if (created && !a.has("no-bind")) c.io.out("Press prefix + m to come back to the mesh window.");
      if (!inTmux) c.io.out(`Attach with: tmux attach -t ${sessionName}`);
      else if (created) c.io.out(`Switch with: tmux switch-client -t ${sessionName}`);
      if (untrusted.length) {
        c.io.out(`Claude asks whether you trust ${untrusted.length === 1 ? "this folder" : "these folders"} before it starts: ${untrusted.join(", ")}.`);
        c.io.out(`Switch to ${untrusted.length === 1 ? "it" : "each"} (tmux switch-client -t <pane>, or prefix + s) and choose "Yes, I trust this folder".${listed ? " The mesh list shows it under NEEDS YOU until you do." : ""}`);
      }
      return 0;
    },
  };
}

/**
 * The worktree of a step: <repo>/.claude/worktrees/<goal>-<step> on branch mesh/<goal>-<step>, made
 * from `base` (default HEAD) the first time, reused after (a fix round continues on the same branch).
 */
export async function stepWorktree(
  runner: Runner,
  repoDir: string,
  step: Pick<Step, "id" | "goal">,
  base: string | undefined,
): Promise<{ ok: true; path: string; branch: string; created: boolean; base: string } | { ok: false; error: string }> {
  const slug = step.id.toLowerCase().replace(/[^a-z0-9]+/g, "-");
  const path = join(repoDir, ".claude", "worktrees", slug);
  const branch = `mesh/${slug}`;
  if (existsSync(path)) return { ok: true, path, branch, created: false, base: base ?? "HEAD" };
  const git = (args: string[]) => runner("git", ["-C", repoDir, ...args], { timeoutMs: 60_000 });
  const exists = (await git(["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`])).code === 0;
  const r = exists ? await git(["worktree", "add", path, branch]) : await git(["worktree", "add", "-b", branch, path, base ?? "HEAD"]);
  if (r.code !== 0) return { ok: false, error: `could not create the worktree for ${step.id}: ${(r.stderr || r.stdout).trim()}` };
  return { ok: true, path, branch, created: true, base: exists ? branch : (base ?? "HEAD") };
}

export function statusCommand(c: CliEnv): Command {
  return {
    name: "status",
    summary: "the daemon and hub: team, Solo, or offline and working locally",
    async run() {
      const st = await client(c).status();
      const mode = st.mode === "solo" ? `Solo (local hub ${st.hubUrl ?? ""})` : st.mode === "team" ? `team hub ${st.hubUrl ?? ""}` : "no hub";
      c.io.out(`daemon on ${st.host}: ${mode}${st.user ? ` as ${st.user}` : ""}`);
      if (st.hub === "offline") c.io.out(`hub offline${st.offlineSince ? ` since ${new Date(st.offlineSince).toISOString().slice(11, 16)} UTC` : ""}: working locally; ${st.outbox} event(s) and ${st.queued ?? 0} call(s) are sent when it is back`);
      else if (st.hub === "auth-failed") c.io.out("the hub refused our login; run: mesh login");
      else if (st.outbox || st.queued) c.io.out(`${st.outbox} event(s) and ${st.queued ?? 0} call(s) waiting to sync`);
      return 0;
    },
  };
}

export function meshCommands(c: CliEnv): Command[] {
  return [setupCommand(c), doctorCommand(c), skillCommand(c), statusCommand(c), lsCommand(c), sayCommand(c), jumpCommand(c), runCommand(c), tuiCommand(c), ledgerCommand(c), assetsCommand(c), ...hubCommands(c)];
}
