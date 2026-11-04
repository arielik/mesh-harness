// End-to-end check of M2 against real Claude Code (model haiku, your subscription):
// hub + token login + daemon + MCP tools + chain autopilot across two steps.
// Never touches ~/.claude: hooks via --settings, MCP via --mcp-config. Run `pnpm build` first and
// `pnpm spike interactive` once (it trusts the scratch folder).

import { spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { MODEL, OUT, ROOT, capture, note, q, sh, sleep, tmux } from "./lib.ts";

export async function runE2eM2(): Promise<void> {
  const out = join(OUT, "e2e-m2");
  rmSync(out, { recursive: true, force: true });
  mkdirSync(out, { recursive: true });
  const log = join(out, "results.md");
  const dir = join(process.env.MESH_SPIKE_TMP ?? "/tmp", "mesh-spike", "interactive");
  if (!existsSync(dir)) throw new Error("run `pnpm spike interactive` first (it trusts the scratch folder)");
  if (!existsSync(join(dir, ".git"))) await sh("git", ["init", "-q"], { cwd: dir });
  await sh("git", ["remote", "remove", "origin"], { cwd: dir });
  await sh("git", ["remote", "add", "origin", "git@gitlab.example:team/interactive.git"], { cwd: dir });
  for (const f of ["alpha.txt", "beta.txt"]) rmSync(join(dir, f), { force: true });

  const mesh = join(ROOT, "dist", "main.mjs");
  const hubPort = 31_000 + Math.floor(Math.random() * 5_000);
  const hubUrl = `http://127.0.0.1:${hubPort}`;
  const token = "e2e-m2-alice-token";
  writeFileSync(
    join(out, "hub.yaml"),
    `listen: 127.0.0.1:${hubPort}\ndb: hub.db\nauth:\n  providers:\n    - id: team\n      kind: token\n      users:\n        - { name: alice, token_sha256: ${createHash("sha256").update(token).digest("hex")} }\n  bootstrap_admins: [team:alice]\n`,
  );
  const env: Record<string, string | undefined> = { ...process.env, MESH_CONFIG_DIR: join(out, "cfg"), MESH_STATE_DIR: join(out, "state") };
  delete env.CLAUDE_CONFIG_DIR;
  const meshCmd = (args: string[], extra: Record<string, string> = {}) =>
    new Promise<{ code: number; stdout: string; stderr: string }>((resolve) => {
      const child = spawn(process.execPath, [mesh, ...args], { env: { ...env, ...extra } });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (d) => (stdout += d));
      child.stderr.on("data", (d) => (stderr += d));
      child.on("close", (code) => resolve({ code: code ?? 1, stdout, stderr }));
    });
  const check = (label: string, cond: boolean, detail = "") => note(log, `${cond ? "✅" : "❌"} ${label}${detail ? ` — ${detail}` : ""}`);
  const procs: ChildProcess[] = [];
  const daemonLog: string[] = [];

  try {
    const hub = spawn(process.execPath, [mesh, "hub", "--config", join(out, "hub.yaml")], { env, stdio: ["ignore", "pipe", "pipe"] });
    procs.push(hub);
    await sleep(1500);
    const claudeDir = join(out, "claude");
    check("mesh setup (hooks, no MCP)", (await meshCmd(["setup", "--port", String(hubPort + 1), "--no-notify", "--no-mcp"], { CLAUDE_CONFIG_DIR: claudeDir })).code === 0);
    const login = await meshCmd(["login", "--hub", hubUrl, "--token", token]);
    check("mesh login", login.code === 0, login.stdout.trim() || login.stderr.trim());
    // Backfill off: a test daemon never imports workflow runs from your real Claude projects.
    const daemon = spawn(process.execPath, [mesh, "up"], { env: { ...env, MESH_BACKFILL: "off" }, stdio: ["ignore", "ignore", "pipe"] });
    daemon.stderr?.on("data", (d) => {
      daemonLog.push(String(d));
      writeFileSync(join(out, "daemon.log"), daemonLog.join(""));
    });
    procs.push(daemon);
    await sleep(1500);
    const doctor = await meshCmd(["doctor"], { CLAUDE_CONFIG_DIR: claudeDir });
    check("mesh doctor shows the hub", doctor.stdout.includes(`hub ${hubUrl} as alice`), doctor.stdout.split("\n").filter((l) => l.includes("hub")).join(" | "));

    const g = await meshCmd(["goal", "new", "E2E", "chain", "--repo", "interactive"]);
    check("mesh goal new", g.code === 0, g.stdout.trim());
    writeFileSync(
      join(out, "plan.yaml"),
      [
        "steps:",
        "  - id: alpha",
        "    repo: interactive",
        "    kind: implement",
        "    title: write alpha",
        "    brief: Create a file named alpha.txt in the current folder containing exactly the word alpha. Use the Write tool.",
        "  - id: beta",
        "    repo: interactive",
        "    kind: implement",
        "    title: write beta",
        "    brief: Create a file named beta.txt in the current folder containing exactly the word beta. Use the Write tool.",
        "    deps: [alpha]",
        "",
      ].join("\n"),
    );
    const plan = await meshCmd(["goal", "plan", "G1", "--file", join(out, "plan.yaml")]);
    check("plan approved", plan.code === 0, plan.stdout.trim());
    const claim = await meshCmd(["next"]);
    check("mesh next lists G1.alpha", claim.stdout.includes("G1.alpha"));

    // A Claude session started the way `mesh run --step G1.alpha --auto chain` starts it.
    const settings = join(claudeDir, "settings.json");
    const mcpConfig = join(out, "mcp.json");
    writeFileSync(
      mcpConfig,
      JSON.stringify({ mcpServers: { mesh: { type: "stdio", command: process.execPath, args: [mesh, "mcp"], env: { MESH_CONFIG_DIR: env.MESH_CONFIG_DIR, MESH_STATE_DIR: env.MESH_STATE_DIR } } } }),
    );
    await meshCmd(["goal", "show", "G1"]);
    const claimed = await fetch(`${hubUrl}/v1/steps/G1.alpha/claim`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${JSON.parse(readFileSync(join(out, "cfg", "credentials.json"), "utf8")).token}` },
      body: "{}",
    });
    check("claimed G1.alpha before starting", claimed.ok);
    await tmux("kill-server");
    const prompt = "You hold mesh step G1.alpha. Start with the mesh_context tool, do exactly what the brief says, then call mesh_done with a one-line summary. If mesh gives you another step, do the same for it.";
    await tmux(
      "new-session", "-d", "-s", "m2", "-x", "200", "-y", "50", "-c", dir,
      "-e", "MESH_STEP=G1.alpha", "-e", "MESH_AUTOPILOT=chain",
      // The prompt goes first: --allowedTools takes a variable number of values.
      `claude ${q(prompt)} -n e2e-m2 --model ${MODEL} --permission-mode default --settings ${q(settings)} --strict-mcp-config --mcp-config ${q(mcpConfig)} --allowedTools mcp__mesh Write Edit`,
    );

    const t0 = Date.now();
    let goalDone = false;
    while (Date.now() - t0 < 240_000) {
      const r = await meshCmd(["goal", "show", "G1"]);
      writeFileSync(join(out, "goal.txt"), r.stdout);
      if (/\ndone · owner/.test(r.stdout)) {
        goalDone = true;
        break;
      }
      await sleep(4000);
    }
    const screen = await capture("m2:0");
    writeFileSync(join(out, "screen.txt"), screen);
    check("alpha.txt written by the agent", existsSync(join(dir, "alpha.txt")) && readFileSync(join(dir, "alpha.txt"), "utf8").includes("alpha"));
    check("chain autopilot handed over G1.beta and the agent finished it", existsSync(join(dir, "beta.txt")));
    check("goal G1 done on the hub", goalDone, readFileSync(join(out, "goal.txt"), "utf8").split("\n").slice(0, 4).join(" | "));
    const ls = await meshCmd(["ls"]);
    check("mesh ls shows the session", ls.stdout.includes("e2e-m2"), ls.stdout.trim().split("\n")[0] ?? "");
    const creds = JSON.parse(readFileSync(join(out, "cfg", "credentials.json"), "utf8"));
    const live = (await (await fetch(`${hubUrl}/v1/live`, { headers: { authorization: `Bearer ${creds.token}` } })).json()) as { activity: { text: string }[] };
    const acts = (live.activity as { text: string }[]).map((a) => a.text);
    check("hub activity shows both steps finished", acts.some((t) => t.includes("finished G1.alpha")) && acts.some((t) => t.includes("finished G1.beta")), acts.slice(0, 6).join(" | "));
  } finally {
    await tmux("kill-server");
    for (const p of procs) p.kill("SIGTERM");
    await sleep(500);
  }
}
