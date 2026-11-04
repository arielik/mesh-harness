// T7 (local-first design §5): a workflow programme (one Claude session, five subagents, labels
// <role>:<key>[:<round>]) run against real Claude Code four ways:
//   (a) no daemon at all                     → the programme finishes, as fast as without mesh
//   (b) daemon, team hub blackholed          → finishes; records written locally; mesh status: offline
//   (c) hub restored in the middle of a run  → finishes; every agent reaches the hub exactly once
//   (d) Solo (no team hub configured)        → finishes; records and events on the local hub
// Never touches ~/.claude settings (hooks via --settings); the daemons' backfill is off, so they
// never scan your real projects; the session history of the scratch repo is removed afterwards.
// Run `pnpm build` first.

import { spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import { join } from "node:path";
import { parse } from "yaml";
import { MODEL, OUT, ROOT, forgetProject, note, sh, sleep, writeProgramme } from "./lib.ts";

interface Run {
  code: number;
  ms: number;
  stdout: string;
}

export async function runE2eOffline(): Promise<void> {
  const out = join(OUT, "e2e-offline");
  rmSync(out, { recursive: true, force: true });
  mkdirSync(out, { recursive: true });
  const log = join(out, "results.md");
  const failures: string[] = [];
  const check = (label: string, ok: boolean, detail = "") => {
    note(log, `${ok ? "✅" : "❌"} ${label}${detail ? ` — ${detail}` : ""}`);
    if (!ok) failures.push(label);
  };

  const scratch = join(process.env.MESH_SPIKE_TMP ?? "/tmp", "mesh-spike");
  const repo = join(scratch, "offline");
  rmSync(repo, { recursive: true, force: true });
  mkdirSync(repo, { recursive: true });
  await sh("git", ["init", "-q"], { cwd: repo });
  await sh("git", ["remote", "add", "origin", "git@gitlab.example:team/offline.git"], { cwd: repo });
  for (const key of ["OFF-A", "OFF-B", "OFF-C", "OFF-D"]) writeProgramme(join(scratch, `prog-${key}`), key);
  // One repo, four programme scripts (the agents are the same).
  writeProgramme(repo, "OFF-A");
  for (const key of ["OFF-A", "OFF-B", "OFF-C", "OFF-D"]) writeFileSync(join(repo, `programme-${key}.js`), readFileSync(join(scratch, `prog-${key}`, "programme.js"), "utf8"));
  await sh("git", ["-c", "user.email=e2e@mesh", "-c", "user.name=e2e", "add", "-A"], { cwd: repo });
  await sh("git", ["-c", "user.email=e2e@mesh", "-c", "user.name=e2e", "commit", "-qm", "init"], { cwd: repo });

  const mesh = join(ROOT, "dist", "main.mjs");
  const hubPort = 39_000 + Math.floor(Math.random() * 2_000);
  const daemonPort = hubPort + 1;
  const hubUrl = `http://127.0.0.1:${hubPort}`;
  const sha = (t: string) => createHash("sha256").update(t).digest("hex");
  writeFileSync(join(out, "hub.yaml"), `listen: 127.0.0.1:${hubPort}\ndb: hub.db\nauth:\n  providers:\n    - id: team\n      kind: token\n      users:\n        - { name: alice, token_sha256: ${sha("off-alice")} }\n  bootstrap_admins: [team:alice]\n`);

  const cfg = join(out, "cfg");
  const state = join(out, "state");
  const claudeScratch = join(out, "claude");
  const base: Record<string, string | undefined> = { ...process.env, MESH_CONFIG_DIR: cfg, MESH_STATE_DIR: state };
  delete base.CLAUDE_CONFIG_DIR;
  // Backfill off: a test daemon never imports workflow runs from your real Claude projects (the
  // hooks give it the exact files of each agent).
  const daemonEnv = { ...base, MESH_BACKFILL: "off" };
  const procs: ChildProcess[] = [];
  const mcli = (args: string[], env = base) =>
    new Promise<{ code: number; stdout: string; stderr: string }>((resolve) => {
      const child = spawn(process.execPath, [mesh, ...args], { env, cwd: repo });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (d) => (stdout += d));
      child.stderr.on("data", (d) => (stderr += d));
      child.on("close", (code) => resolve({ code: code ?? 1, stdout, stderr }));
    });
  let hub: ChildProcess | undefined;
  const startHub = async () => {
    hub = spawn(process.execPath, [mesh, "hub", "--config", join(out, "hub.yaml")], { env: base, stdio: "ignore" });
    procs.push(hub);
    for (let i = 0; i < 50; i++) {
      if ((await fetch(`${hubUrl}/health`).catch(() => undefined))?.ok) return;
      await sleep(200);
    }
    throw new Error("hub did not start");
  };
  const stopHub = async () => {
    if (!hub) return;
    hub.kill("SIGTERM");
    await new Promise((r) => hub?.once("close", r));
    hub = undefined;
  };
  let blackhole: { server: Server; sockets: Socket[] } | undefined;
  const startBlackhole = async () => {
    const sockets: Socket[] = [];
    const server = createServer((s) => void sockets.push(s));
    await new Promise<void>((r) => server.listen(hubPort, "127.0.0.1", () => r()));
    blackhole = { server, sockets };
  };
  const stopBlackhole = async () => {
    if (!blackhole) return;
    for (const s of blackhole?.sockets ?? []) s.destroy();
    await new Promise((r) => blackhole?.server.close(r));
    blackhole = undefined;
  };
  let daemon: ChildProcess | undefined;
  const startDaemon = async () => {
    daemon = spawn(process.execPath, [mesh, "up"], { env: daemonEnv, stdio: ["ignore", "ignore", "pipe"] });
    let dlog = "";
    daemon.stderr?.on("data", (x) => {
      dlog += x;
      writeFileSync(join(out, "daemon.log"), dlog);
    });
    procs.push(daemon);
    for (let i = 0; i < 50; i++) {
      if ((await mcli(["status"])).code === 0) return;
      await sleep(200);
    }
    throw new Error("daemon did not start");
  };
  const stopDaemon = async () => {
    if (!daemon) return;
    daemon.kill("SIGTERM");
    await new Promise((r) => daemon?.once("close", r));
    daemon = undefined;
  };
  const programme = (key: string): Promise<Run> =>
    new Promise((resolve) => {
      const t0 = Date.now();
      const child = spawn(
        "claude",
        ["-p", "--model", MODEL, "--settings", join(claudeScratch, "settings.json"), "--strict-mcp-config", "--allowedTools", "Workflow", "--output-format", "text", `Run the workflow script ./programme-${key}.js with the Workflow tool, wait for it to finish, then reply with the single word DONE.`],
        { cwd: repo, env: base, stdio: ["ignore", "pipe", "pipe"] },
      );
      let stdout = "";
      child.stdout.on("data", (d) => (stdout += d));
      const timer = setTimeout(() => child.kill("SIGTERM"), 600_000);
      child.on("close", (code) => {
        clearTimeout(timer);
        resolve({ code: code ?? 1, ms: Date.now() - t0, stdout });
      });
    });
  const pendingDir = (key: string) => join(repo, ".git", "mesh", "pending", key);
  const pending = (key: string) => (existsSync(pendingDir(key)) ? readdirSync(pendingDir(key)).sort() : []);
  const shape = (key: string) =>
    pending(key).map((f) => {
      const doc = parse(readFileSync(join(pendingDir(key), f), "utf8").split("---\n")[1] ?? "") as { role: string; rounds: { label: string; model?: string; result?: unknown }[] };
      return `${f}:${doc.role}:${doc.rounds.map((r) => `${r.label.replace(key, "K")}/${r.model ? "model" : "-"}/${r.result ? "typed" : "-"}`).join(",")}`;
    });
  const events = async (token: string, url: string, key: string) => {
    const r = await fetch(`${url}/v1/events?after=0&limit=1000`, { headers: { authorization: `Bearer ${token}` } });
    const j = (await r.json()) as { events: { id: string; type: string; payload: { key?: string } }[] };
    return j.events.filter((e) => e.type === "agent.finished" && e.payload.key === key);
  };
  const waitFor = async (label: string, pred: () => Promise<boolean> | boolean, ms: number) => {
    const t0 = Date.now();
    while (Date.now() - t0 < ms) {
      if (await pred()) return true;
      await sleep(1_000);
    }
    note(log, `(timed out waiting for ${label})`);
    return false;
  };

  try {
    const setup = await mcli(["setup", "--port", String(daemonPort), "--no-notify", "--no-mcp"], { ...base, CLAUDE_CONFIG_DIR: claudeScratch });
    const hooks = Object.keys((JSON.parse(readFileSync(join(claudeScratch, "settings.json"), "utf8")) as { hooks: object }).hooks);
    check("mesh setup installs 7 hooks (with SubagentStart/SubagentStop)", setup.code === 0 && hooks.includes("SubagentStart") && hooks.includes("SubagentStop") && hooks.length === 7, hooks.join(", "));

    // (a) no daemon at all.
    const a = await programme("OFF-A");
    check("(a) no daemon: the programme finishes", a.code === 0 && /DONE/.test(a.stdout), `${Math.round(a.ms / 1000)} s`);

    // (b) team hub blackholed.
    await startHub();
    const login = await mcli(["login", "--hub", hubUrl, "--token", "off-alice"]);
    check("logged in to the team hub", login.code === 0, login.stdout.trim());
    const svcToken = (await mcli(["hub", "token", "--service", "e2e", "--config", join(out, "hub.yaml")])).stdout.trim();
    await startDaemon();
    await stopHub();
    await startBlackhole();
    await waitFor("daemon offline", async () => /offline/.test((await mcli(["status"])).stdout), 60_000);
    const b = await programme("OFF-B");
    const st = (await mcli(["status"])).stdout.trim();
    check("(b) hub blackholed: the programme finishes", b.code === 0 && /DONE/.test(b.stdout), `${Math.round(b.ms / 1000)} s (no daemon: ${Math.round(a.ms / 1000)} s)`);
    check("(b) mesh status says offline, working locally", /offline/.test(st) && /working locally/.test(st), st.replace(/\n/g, " | "));
    await waitFor("records OFF-B", () => pending("OFF-B").length === 5, 30_000);
    check("(b) five records written locally", pending("OFF-B").length === 5, pending("OFF-B").join(", "));
    const staged = await mcli(["ledger", "stage", "OFF-B"]);
    check("(b) mesh ledger stage copies them into the tree", staged.code === 0 && staged.stdout.trim().split("\n").length === 5 && existsSync(join(repo, ".mesh/goals/OFF-B/steps/reviewer.md")), staged.stdout.trim().split("\n").join(", "));

    // (c) hub restored in the middle of a run.
    const cRun = programme("OFF-C");
    await waitFor("first OFF-C record", () => pending("OFF-C").length >= 1, 300_000);
    await stopBlackhole();
    await startHub();
    const c = await cRun;
    check("(c) hub restored mid-run: the programme finishes", c.code === 0 && /DONE/.test(c.stdout), `${Math.round(c.ms / 1000)} s`);
    const synced = await waitFor("sync after restore", async () => (await events(svcToken, hubUrl, "OFF-C")).length === 5 && (await events(svcToken, hubUrl, "OFF-B")).length === 5, 150_000);
    const evB = await events(svcToken, hubUrl, "OFF-B");
    const evC = await events(svcToken, hubUrl, "OFF-C");
    check("(c) every agent of both offline runs reached the hub, once", synced && new Set([...evB, ...evC].map((e) => e.id)).size === 10, `OFF-B ${evB.length}, OFF-C ${evC.length}`);
    const st2 = (await mcli(["status"])).stdout.trim();
    check("(c) mesh status: back online, nothing waiting", !/offline/.test(st2) && !/waiting/.test(st2), st2.replace(/\n/g, " | "));
    await sleep(3_000);
    const evB2 = await events(svcToken, hubUrl, "OFF-B");
    check("(c) no duplicates after more syncs", evB2.length === 5);

    // (d) Solo.
    await stopDaemon();
    await stopHub();
    await mcli(["logout"]);
    await startDaemon();
    const st3 = (await mcli(["status"])).stdout.trim();
    check("(d) Solo: the daemon runs its own local hub", /Solo/.test(st3), st3);
    const d = await programme("OFF-D");
    check("(d) Solo: the programme finishes", d.code === 0 && /DONE/.test(d.stdout), `${Math.round(d.ms / 1000)} s`);
    await waitFor("records OFF-D", () => pending("OFF-D").length === 5, 30_000);
    const solo = JSON.parse(readFileSync(join(state, "solo.json"), "utf8")) as { hub: string; token: string };
    await waitFor("solo events", async () => (await events(solo.token, solo.hub, "OFF-D")).length === 5, 30_000);
    check("(d) Solo: records written and events on the local hub", pending("OFF-D").length === 5 && (await events(solo.token, solo.hub, "OFF-D")).length === 5);

    // The daemon looks at Claude Code's files again 2 s and 15 s after each agent (late journal lines).
    await sleep(16_000);
    const shapes = ["OFF-B", "OFF-C", "OFF-D"].map((k) => shape(k).join(" "));
    check("records have the same shape in (b), (c) and (d)", new Set(shapes).size === 1, shape("OFF-B").join(" "));
    check("every round has a model and a typed result", shapes[0]?.split(" ").every((x) => !x.includes("/-")) ?? false);
    check("mesh adds little time to a programme", Math.max(b.ms, d.ms) - a.ms < 30_000, `none ${Math.round(a.ms / 1000)} s · offline ${Math.round(b.ms / 1000)} s · solo ${Math.round(d.ms / 1000)} s`);
    writeFileSync(join(out, "reviewer.OFF-B.md"), readFileSync(join(repo, ".mesh/goals/OFF-B/steps/reviewer.md"), "utf8"));
  } finally {
    for (const p of procs) p.kill("SIGTERM");
    await stopBlackhole().catch(() => undefined);
    await sleep(500);
    forgetProject(repo);
  }
  note(log, failures.length ? `\n${failures.length} check(s) failed.` : "\nAll checks passed.");
  if (failures.length) {
    process.exitCode = 1;
    throw new Error(`e2e-offline: ${failures.join("; ")}`);
  }
}
