// End-to-end check of M1 against real Claude Code (model haiku, your subscription).
// Builds nothing: run `pnpm build` first. Never touches ~/.claude/settings.json: `mesh setup` writes
// into a scratch CLAUDE_CONFIG_DIR and the Claude session loads that file with --settings.
// Needs the folder trusted by `pnpm spike interactive`.

import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { MODEL, OUT, ROOT, capture, note, q, sh, sleep, tmux } from "./lib.ts";

type S = { sid: string; state: string; needs?: string; pane?: string; turns: number; humanPrompts: number; lastMessage?: string; claudeSessionIds: string[]; name?: string; repo?: { name: string } };

export async function runE2e(): Promise<void> {
  const out = join(OUT, "e2e");
  rmSync(out, { recursive: true, force: true });
  mkdirSync(out, { recursive: true });
  const log = join(out, "results.md");
  const dir = join(process.env.MESH_SPIKE_TMP ?? "/tmp", "mesh-spike", "interactive");
  if (!existsSync(dir)) throw new Error("run `pnpm spike interactive` first (it trusts the scratch folder)");
  if (!existsSync(join(dir, ".git"))) await sh("git", ["init", "-q"], { cwd: dir });
  await sh("git", ["remote", "remove", "origin"], { cwd: dir });
  await sh("git", ["remote", "add", "origin", "git@gitlab.example:team/interactive.git"], { cwd: dir });

  const mesh = join(ROOT, "dist", "main.mjs");
  const port = 30_000 + Math.floor(Math.random() * 10_000);
  const baseEnv: Record<string, string | undefined> = { ...process.env, MESH_CONFIG_DIR: join(out, "cfg"), MESH_STATE_DIR: join(out, "state") };
  delete baseEnv.CLAUDE_CONFIG_DIR;
  const meshCmd = (args: string[], extra: Record<string, string> = {}) =>
    new Promise<{ code: number; stdout: string; stderr: string }>((resolve) => {
      const child = spawn(process.execPath, [mesh, ...args], { env: { ...baseEnv, ...extra } });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (d) => (stdout += d));
      child.stderr.on("data", (d) => (stderr += d));
      child.on("close", (code) => resolve({ code: code ?? 1, stdout, stderr }));
    });
  const ls = async (): Promise<S[]> => (JSON.parse((await meshCmd(["ls", "--json"])).stdout) as { sessions: S[] }).sessions;
  const until = async (label: string, pred: (s: S[]) => boolean, ms = 60_000): Promise<S[]> => {
    const t0 = Date.now();
    for (;;) {
      const s = await ls();
      if (pred(s)) return s;
      if (Date.now() - t0 > ms) throw new Error(`timeout: ${label}\n${JSON.stringify(s, null, 2)}`);
      await sleep(1000);
    }
  };
  const check = (label: string, cond: boolean, detail = "") => note(log, `${cond ? "✅" : "❌"} ${label}${detail ? ` — ${detail}` : ""}`);

  const claudeDir = join(out, "claude");
  const setup = await meshCmd(["setup", "--port", String(port), "--no-notify"], { CLAUDE_CONFIG_DIR: claudeDir });
  check("mesh setup", setup.code === 0, setup.stderr.trim());
  const settings = join(claudeDir, "settings.json");

  let daemon: ChildProcess | undefined;
  try {
    // Backfill off: a test daemon never imports workflow runs from your real Claude projects.
    daemon = spawn(process.execPath, [mesh, "up"], { env: { ...baseEnv, MESH_BACKFILL: "off" }, stdio: ["ignore", "ignore", "pipe"] });
    let daemonLog = "";
    daemon.stderr?.on("data", (d) => {
      daemonLog += d;
      writeFileSync(join(out, "daemon.log"), daemonLog);
    });
    await sleep(1500);
    const doctor = await meshCmd(["doctor"], { CLAUDE_CONFIG_DIR: claudeDir });
    check("mesh doctor", doctor.code === 0, doctor.stdout.trim().replace(/\n/g, " | "));

    await tmux("kill-server");
    const T = "e2e:0";
    await tmux("new-session", "-d", "-s", "e2e", "-x", "200", "-y", "50", "-c", dir, `claude -n e2e-session --model ${MODEL} --permission-mode default --settings ${q(settings)}`);

    let s = await until("session appears and is ready", (x) => x.some((y) => y.name === "e2e-session" && y.pane !== undefined && y.state === "idle"), 90_000);
    let me = s.find((y) => y.name === "e2e-session") as S;
    check("session tracked with pane, name and repo", !!me.pane && me.repo?.name === "interactive", `sid=${me.sid} pane=${me.pane} repo=${me.repo?.name}`);
    const sid = me.sid;

    // 1. mesh say into an idle prompt → bracketed paste.
    const say1 = await meshCmd(["say", "e2e-session", "Reply with exactly the word: PASTED"]);
    s = await until("pasted reply", (x) => x.some((y) => y.sid === sid && y.lastMessage === "PASTED" && y.state === "idle"));
    me = s.find((y) => y.sid === sid) as S;
    check("say → paste into idle prompt", me.lastMessage === "PASTED", say1.stdout.trim());
    check("delivered prompt not counted as human", me.turns === 1 && me.humanPrompts === 0, `turns=${me.turns} human=${me.humanPrompts}`);

    // 2. Permission dialog: needs you; say is held until the dialog is gone.
    await tmux("send-keys", "-t", T, "-l", "Use the Bash tool to run exactly: touch e2e-marker.txt (do not ask, just run it)");
    await sleep(300);
    await tmux("send-keys", "-t", T, "Enter");
    s = await until("needs you: permission", (x) => x.some((y) => y.sid === sid && y.state === "needs_you" && y.needs === "permission"));
    check("permission dialog → needs_you(permission)", true);
    await meshCmd(["say", "e2e-session", "Reply with exactly the word: AFTERDIALOG"]);
    await sleep(6000);
    const screen = await capture(T);
    check("nothing typed while the dialog is open", !screen.includes("AFTERDIALOG") && !existsSync(join(dir, "e2e-marker.txt")));
    await tmux("send-keys", "-t", T, "Escape");
    s = await until("held message delivered after dialog", (x) => x.some((y) => y.sid === sid && y.lastMessage === "AFTERDIALOG"), 90_000);
    check("held message delivered once the prompt was free", true);

    // 3. Stop-hook delivery while working.
    await tmux("send-keys", "-t", T, "-l", "Count from 1 to 40, one number per line, no other text.");
    await sleep(300);
    await tmux("send-keys", "-t", T, "Enter");
    await until("working", (x) => x.some((y) => y.sid === sid && y.state === "working"), 30_000);
    await meshCmd(["say", "e2e-session", "MESH: after counting, reply with exactly the word: EXTRA"]);
    s = await until("stop-hook delivery", (x) => x.some((y) => y.sid === sid && y.lastMessage === "EXTRA"), 90_000);
    check("say while working → delivered by the Stop hook", true);

    // 4. Question detection.
    await tmux("send-keys", "-t", T, "-l", "Ask me one short yes/no question about my favourite colour, then stop. No tools.");
    await sleep(300);
    await tmux("send-keys", "-t", T, "Enter");
    s = await until("question", (x) => x.some((y) => y.sid === sid && y.state === "needs_you" && y.needs === "question"), 60_000);
    check("plain-text question → needs_you(question)", true, (s.find((y) => y.sid === sid) as S).lastMessage ?? "");

    // 5. /clear keeps the mesh session.
    await tmux("send-keys", "-t", T, "-l", "/clear");
    await sleep(300);
    await tmux("send-keys", "-t", T, "Enter");
    s = await until("rebind after /clear", (x) => x.some((y) => y.sid === sid && y.claudeSessionIds.length >= 2), 30_000);
    check("/clear rebinds to the same sid", s.filter((y) => y.name === "e2e-session" || y.sid === sid).length === 1);

    // 6. TUI renders inside tmux.
    await tmux("new-window", "-d", "-t", "e2e:", "-n", "tui", "-e", `MESH_CONFIG_DIR=${baseEnv.MESH_CONFIG_DIR}`, "-e", `MESH_STATE_DIR=${baseEnv.MESH_STATE_DIR}`, `${q(process.execPath)} ${q(mesh)}`);
    await sleep(3000);
    const tui = await capture("e2e:tui");
    writeFileSync(join(out, "tui.txt"), tui);
    check("TUI lists the session", tui.includes("e2e-session") && tui.includes("jump"), tui.split("\n").filter((l) => l.trim()).slice(0, 6).join(" / "));

    // 7. /exit ends it.
    await tmux("send-keys", "-t", T, "-l", "/exit");
    await sleep(300);
    await tmux("send-keys", "-t", T, "Enter");
    s = await until("ended", (x) => x.some((y) => y.sid === sid && y.state === "ended"), 30_000);
    check("/exit → ended", true);
  } finally {
    await tmux("kill-server");
    daemon?.kill("SIGTERM");
    await sleep(500);
  }
}
