// End-to-end check of M3 against real Claude Code (haiku, your subscription): a design session
// proposes a plan with mesh_plan, a person asks for changes, the agent re-proposes, the plan is
// approved, two people (two daemons) do one step each in two repos, step records are committed and
// the goal finishes. Never touches ~/.claude. Run `pnpm build` and `pnpm spike interactive` first.

import { spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { MODEL, OUT, ROOT, capture, note, q, sh, sleep, tmux } from "./lib.ts";

interface Who {
  name: string;
  env: Record<string, string | undefined>;
  claudeDir: string;
  mcpConfig: string;
}

export async function runE2eM3(): Promise<void> {
  const out = join(OUT, "e2e-m3");
  rmSync(out, { recursive: true, force: true });
  mkdirSync(out, { recursive: true });
  const log = join(out, "results.md");
  const scratch = join(process.env.MESH_SPIKE_TMP ?? "/tmp", "mesh-spike");
  const repo1 = join(scratch, "interactive");
  const repo2 = join(scratch, "repo2");
  if (!existsSync(repo1)) throw new Error("run `pnpm spike interactive` first (it trusts the scratch folder)");
  for (const [dir, name] of [
    [repo1, "interactive"],
    [repo2, "repo2"],
  ] as const) {
    rmSync(join(dir, ".git"), { recursive: true, force: true });
    rmSync(join(dir, ".mesh"), { recursive: true, force: true });
    for (const f of ["hello.txt", "world.txt", "docs"]) rmSync(join(dir, f), { recursive: true, force: true });
    mkdirSync(dir, { recursive: true });
    await sh("git", ["init", "-q"], { cwd: dir });
    await sh("git", ["remote", "add", "origin", `git@gitlab.example:team/${name}.git`], { cwd: dir });
    await sh("git", ["-c", "user.email=e2e@mesh", "-c", "user.name=e2e", "commit", "-q", "--allow-empty", "-m", "init"], { cwd: dir });
  }

  const mesh = join(ROOT, "dist", "main.mjs");
  const hubPort = 36_000 + Math.floor(Math.random() * 3_000);
  const hubUrl = `http://127.0.0.1:${hubPort}`;
  const sha = (t: string) => createHash("sha256").update(t).digest("hex");
  writeFileSync(
    join(out, "hub.yaml"),
    `listen: 127.0.0.1:${hubPort}\ndb: hub.db\nauth:\n  providers:\n    - id: team\n      kind: token\n      users:\n        - { name: alice, token_sha256: ${sha("m3-alice")} }\n        - { name: bob, token_sha256: ${sha("m3-bob")} }\n  bootstrap_admins: [team:alice]\n`,
  );
  const check = (label: string, cond: boolean, detail = "") => note(log, `${cond ? "✅" : "❌"} ${label}${detail ? ` — ${detail}` : ""}`);
  const procs: ChildProcess[] = [];
  const base: Record<string, string | undefined> = { ...process.env, GIT_AUTHOR_NAME: "e2e", GIT_AUTHOR_EMAIL: "e2e@mesh", GIT_COMMITTER_NAME: "e2e", GIT_COMMITTER_EMAIL: "e2e@mesh" };
  delete base.CLAUDE_CONFIG_DIR;
  const run = (who: Who, args: string[], extra: Record<string, string> = {}) =>
    new Promise<{ code: number; stdout: string; stderr: string }>((resolve) => {
      const child = spawn(process.execPath, [mesh, ...args], { env: { ...who.env, ...extra } });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (d) => (stdout += d));
      child.stderr.on("data", (d) => (stderr += d));
      child.on("close", (code) => resolve({ code: code ?? 1, stdout, stderr }));
    });

  const person = async (name: string, port: number): Promise<Who> => {
    const dir = join(out, name);
    const env = { ...base, MESH_CONFIG_DIR: join(dir, "cfg"), MESH_STATE_DIR: join(dir, "state") };
    const who: Who = { name, env, claudeDir: join(dir, "claude"), mcpConfig: join(dir, "mcp.json") };
    await run(who, ["setup", "--port", String(port), "--no-notify", "--no-mcp"], { CLAUDE_CONFIG_DIR: who.claudeDir });
    const l = await run(who, ["login", "--hub", hubUrl, "--token", `m3-${name}`]);
    check(`${name}: mesh login`, l.code === 0, l.stdout.trim() || l.stderr.trim());
    const d = spawn(process.execPath, [mesh, "up"], { env, stdio: ["ignore", "ignore", "pipe"] });
    let dlog = "";
    d.stderr?.on("data", (x) => {
      dlog += x;
      writeFileSync(join(dir, "daemon.log"), dlog);
    });
    procs.push(d);
    writeFileSync(who.mcpConfig, JSON.stringify({ mcpServers: { mesh: { type: "stdio", command: process.execPath, args: [mesh, "mcp"], env: { MESH_CONFIG_DIR: env.MESH_CONFIG_DIR, MESH_STATE_DIR: env.MESH_STATE_DIR } } } }));
    return who;
  };

  const startClaude = async (who: Who, target: string, cwd: string, step: string, prompt: string) => {
    const settings = join(who.claudeDir, "settings.json");
    // Scratch repos only: allow shell commands so the run never waits on a permission prompt.
    const tools = ["mcp__mesh", "Write", "Edit", "Read", "Bash"].map(q).join(" ");
    const cmd = `claude ${q(prompt)} -n ${who.name}-${step.split(".")[1]} --model ${MODEL} --permission-mode default --settings ${q(settings)} --strict-mcp-config --mcp-config ${q(who.mcpConfig)} --allowedTools ${tools}`;
    const [session] = target.split(":");
    const exists = (await tmux("has-session", "-t", session as string)).code === 0;
    const envArgs = ["-e", `MESH_STEP=${step}`, "-e", "MESH_AUTOPILOT=off", "-e", `MESH_CONFIG_DIR=${who.env.MESH_CONFIG_DIR}`];
    if (exists) await tmux("new-window", "-d", "-t", `${session}:`, "-n", target.split(":")[1] as string, "-c", cwd, ...envArgs, cmd);
    else await tmux("new-session", "-d", "-s", session as string, "-n", target.split(":")[1] as string, "-x", "200", "-y", "50", "-c", cwd, ...envArgs, cmd);
    // A new folder asks for trust first (default "No, exit"): pick "Yes".
    for (let i = 0; i < 20; i++) {
      await sleep(1000);
      const screen = await capture(target);
      if (/trust this folder/i.test(screen)) {
        await tmux("send-keys", "-t", target, "Down");
        await sleep(300);
        await tmux("send-keys", "-t", target, "Enter");
        break;
      }
      if (/esc to interrupt|mesh_context|⏺/i.test(screen)) break;
    }
  };

  const goalShow = async (who: Who) => (await run(who, ["show", "G1"])).stdout;
  const until = async (who: Who, label: string, re: RegExp, ms: number): Promise<string> => {
    const t0 = Date.now();
    let last = "";
    while (Date.now() - t0 < ms) {
      last = await goalShow(who);
      if (re.test(last)) return last;
      await sleep(4000);
    }
    throw new Error(`timeout: ${label}\n${last}`);
  };

  try {
    procs.push(spawn(process.execPath, [mesh, "hub", "--config", join(out, "hub.yaml")], { env: base, stdio: "ignore" }));
    await sleep(1500);
    const alice = await person("alice", hubPort + 1);
    const bob = await person("bob", hubPort + 2);
    await sleep(1500);
    await tmux("kill-server");

    const g = await run(alice, ["goal", "new", "Two-repo greeting", "--repo", "interactive", "--repos", "repo2"]);
    check("goal created", g.code === 0, g.stdout.trim());
    const hubToken = (who: Who) => JSON.parse(readFileSync(join(who.env.MESH_CONFIG_DIR as string, "credentials.json"), "utf8")).token as string;
    const claimStep = (who: Who, step: string) => fetch(`${hubUrl}/v1/steps/${step}/claim`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${hubToken(who)}` }, body: "{}" });
    check("alice claimed G1.design", (await claimStep(alice, "G1.design")).ok);

    // The design session (started like `mesh run --design G1`).
    const designPrompt = [
      'You hold the design step of mesh goal G1 "Two-repo greeting". Start with the mesh_context tool.',
      "Write a very short design document at docs/design/g1-greeting.md (three lines are enough), then propose the plan with mesh_plan, design_ref interactive@main:docs/design/g1-greeting.md.",
      "The plan has exactly two implement steps without dependencies: id hello, repo interactive, brief: create hello.txt containing the word hello; and id world, repo repo2, brief: create world.txt containing the word world.",
      "After proposing, end your turn. If you receive a message asking for changes, apply them and propose again with mesh_plan.",
    ].join(" ");
    await startClaude(alice, "m3:design", repo1, "G1.design", designPrompt);
    let shown = await until(alice, "plan v1 proposed", /plan v1 pending/, 240_000);
    check("design session proposed plan v1 via mesh_plan", true, shown.split("\n").slice(0, 3).join(" | "));
    check("plan v1 file written into the repo", existsSync(join(repo1, ".mesh/goals/G1/plan.v1.yaml")));
    check("design document written", existsSync(join(repo1, "docs/design/g1-greeting.md")));

    const rev = await run(alice, ["goal", "revise", "G1", "Please", "add", "a", "third", "step", "id", "check,", "repo", "interactive,", "kind", "review,", "depending", "on", "hello", "and", "world,", "brief:", "confirm", "both", "files", "exist."]);
    check("revise sent", rev.code === 0, rev.stdout.trim());
    shown = await until(alice, "plan v2 proposed", /plan v2 pending/, 300_000);
    check("design session re-proposed plan v2 after the revise message", /changes from v1|\+check/.test(shown) || shown.includes("plan v2 pending"), shown.split("\n").slice(2, 4).join(" | "));

    const ap = await run(alice, ["goal", "approve", "G1", "--comment", "go ahead"]);
    check("plan v2 approved", ap.code === 0, ap.stdout.trim());
    for (let i = 0; i < 20 && !(existsSync(join(repo1, ".mesh/goals/G1/plan.v2.yaml")) && readFileSync(join(repo1, ".mesh/goals/G1/plan.v2.yaml"), "utf8").includes("decision: approved")); i++) await sleep(1000);
    check("approved plan file written into the design repo", existsSync(join(repo1, ".mesh/goals/G1/plan.v2.yaml")) && readFileSync(join(repo1, ".mesh/goals/G1/plan.v2.yaml"), "utf8").includes("decision: approved"));

    // Two people, two repos, in parallel.
    const workPrompt = (step: string) =>
      `You hold mesh step ${step}. Call mesh_context, do exactly what the brief says, then call mesh_done with a one-line summary. mesh_done writes a step record under .mesh/; then run git add -A and git commit -m "${step}" so your work and the record are committed.`;
    for (const [who, step] of [
      [alice, "G1.hello"],
      [bob, "G1.world"],
    ] as const) {
      check(`${who.name} claimed ${step}`, (await claimStep(who, step)).ok);
    }
    await startClaude(alice, "m3:hello", repo1, "G1.hello", workPrompt("G1.hello"));
    await startClaude(bob, "m3:world", repo2, "G1.world", workPrompt("G1.world"));
    shown = await until(alice, "both steps done", /✓ hello[\s\S]*✓ world|✓ world[\s\S]*✓ hello/, 300_000).catch((e: Error) => e.message);
    check("hello and world done by two people", /✓ hello/.test(shown) && /✓ world/.test(shown), shown.split("\n").filter((l) => /hello|world|check/.test(l)).join(" | "));
    await sleep(15_000);
    const files1 = (await sh("git", ["log", "--name-only", "--format="], { cwd: repo1 })).stdout;
    const files2 = (await sh("git", ["log", "--name-only", "--format="], { cwd: repo2 })).stdout;
    check("step record committed in repo1", files1.includes(".mesh/goals/G1/steps/hello.md"), files1.trim().split("\n").filter(Boolean).join(", "));
    check("step record committed in repo2", files2.includes(".mesh/goals/G1/steps/world.md"), files2.trim().split("\n").filter(Boolean).join(", "));
    const rec = existsSync(join(repo2, ".mesh/goals/G1/steps/world.md")) ? readFileSync(join(repo2, ".mesh/goals/G1/steps/world.md"), "utf8") : "";
    check("record has holder bob and turn facts", /user: bob/.test(rec) && /turns: \d+/.test(rec), rec.split("\n").filter((l) => /user:|turns:|human_prompts:/.test(l)).join(" ").trim());

    // The review step in repo1, then the goal is done.
    check("alice claimed G1.check", (await claimStep(alice, "G1.check")).ok);
    await startClaude(alice, "m3:check", repo1, "G1.check", `${workPrompt("G1.check")} The other repo is at ${repo2}.`);
    shown = await until(alice, "goal done", /\ndone · owner/, 240_000).catch((e: Error) => e.message);
    check("goal G1 done", /\ndone · owner/.test(shown), shown.split("\n").slice(0, 2).join(" | "));
    writeFileSync(join(out, "show.txt"), shown);
    for (const w of ["m3:design", "m3:hello", "m3:world", "m3:check"]) writeFileSync(join(out, `${w.replace(":", "-")}.txt`), await capture(w));
  } finally {
    await tmux("kill-server");
    for (const p of procs) p.kill("SIGTERM");
    await sleep(500);
  }
}
