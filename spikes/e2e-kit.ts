// The SDD kit that ships with mesh-harness (assets/sdd), run for real: a toy Node repo, the kit
// installed with `mesh assets install`, one Claude Code session running .claude/workflows/sdd-programme.js
// (haiku), and a Solo mesh daemon recording it. Proves the repo is self-sufficient: no other repository
// is involved. Never touches ~/.claude settings; the daemon's backfill is off; the scratch session
// history is removed afterwards. Run `pnpm build` first.

import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";
import { MODEL, OUT, ROOT, forgetProject, note, sh, sleep } from "./lib.ts";

export async function runE2eKit(): Promise<void> {
  const out = join(OUT, "e2e-kit");
  rmSync(out, { recursive: true, force: true });
  mkdirSync(out, { recursive: true });
  const log = join(out, "results.md");
  const failures: string[] = [];
  const check = (label: string, ok: boolean, detail = "") => {
    note(log, `${ok ? "✅" : "❌"} ${label}${detail ? ` — ${detail}` : ""}`);
    if (!ok) failures.push(label);
  };
  const repo = join(process.env.MESH_SPIKE_TMP ?? "/tmp", "mesh-spike", "kit");
  rmSync(repo, { recursive: true, force: true });
  mkdirSync(repo, { recursive: true });
  const git = (...args: string[]) => sh("git", ["-c", "user.email=e2e@mesh", "-c", "user.name=e2e", ...args], { cwd: repo });
  await git("init", "-q", "-b", "main");
  writeFileSync(join(repo, "package.json"), `${JSON.stringify({ name: "toy", type: "module", scripts: { test: "node --test" } }, null, 2)}\n`);
  writeFileSync(join(repo, "CLAUDE.md"), "A tiny Node.js library. Tests use node:test in test/*.test.js and run with `npm test`. Keep everything minimal.\n");
  writeFileSync(join(repo, ".gitignore"), ".claude/worktrees/\nnode_modules/\n");

  const mesh = join(ROOT, "dist", "main.mjs");
  const port = 43_000 + Math.floor(Math.random() * 2_000);
  // `mesh` on the PATH, as an installed mesh would be (the programme's ledger step looks for it).
  const bin = join(out, "bin");
  mkdirSync(bin, { recursive: true });
  writeFileSync(join(bin, "mesh"), `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(join(ROOT, "dist", "main.mjs"))} "$@"\n`, { mode: 0o755 });
  const base: Record<string, string | undefined> = { ...process.env, PATH: `${bin}:${process.env.PATH ?? ""}`, MESH_CONFIG_DIR: join(out, "cfg"), MESH_STATE_DIR: join(out, "state"), GIT_AUTHOR_NAME: "e2e", GIT_AUTHOR_EMAIL: "e2e@mesh", GIT_COMMITTER_NAME: "e2e", GIT_COMMITTER_EMAIL: "e2e@mesh" };
  delete base.CLAUDE_CONFIG_DIR;
  const mcli = (args: string[], extra: Record<string, string> = {}) =>
    new Promise<{ code: number; stdout: string }>((resolve) => {
      const child = spawn(process.execPath, [mesh, ...args], { env: { ...base, ...extra }, cwd: repo });
      let stdout = "";
      child.stdout.on("data", (d) => (stdout += d));
      child.on("close", (code) => resolve({ code: code ?? 1, stdout }));
    });
  const procs: ChildProcess[] = [];
  try {
    const inst = await mcli(["assets", "install"]);
    check("mesh assets install copies the kit into the repo", inst.code === 0 && existsSync(join(repo, ".claude/workflows/sdd-programme.js")) && existsSync(join(repo, ".claude/agents/test-writer.md")), inst.stdout.split("\n").filter((l) => l.startsWith("+")).length + " files");
    await git("add", "-A");
    await git("commit", "-qm", "toy repo with the SDD kit");

    const claudeDir = join(out, "claude");
    await mcli(["setup", "--port", String(port), "--no-notify", "--no-mcp"], { CLAUDE_CONFIG_DIR: claudeDir });
    const d = spawn(process.execPath, [mesh, "up"], { env: { ...base, MESH_BACKFILL: "off" }, stdio: ["ignore", "ignore", "pipe"] });
    let dlog = "";
    d.stderr?.on("data", (x) => {
      dlog += x;
      writeFileSync(join(out, "daemon.log"), dlog);
    });
    procs.push(d);
    await sleep(2_000);
    check("Solo daemon running", /Solo/.test((await mcli(["status"])).stdout));

    const args = JSON.stringify({ rows: [{ key: "ROW-1", title: "add(a, b)", brief: "Add src/add.js exporting add(a, b) that returns a + b for two numbers and throws a TypeError when either argument is not a number. Two acceptance criteria: AC-01 sums, AC-02 TypeError." }] });
    const t0 = Date.now();
    const run = await new Promise<{ code: number; stdout: string }>((resolve) => {
      const child = spawn(
        "claude",
        [
          "-p",
          "--model",
          MODEL,
          "--settings",
          join(claudeDir, "settings.json"),
          "--strict-mcp-config",
          "--allowedTools",
          "Workflow",
          "Read",
          "Write",
          "Edit",
          "Bash",
          "Glob",
          "Grep",
          "--output-format",
          "text",
          `Run the workflow script .claude/workflows/sdd-programme.js with the Workflow tool, with args ${args}. Wait for it to finish, then reply with its result as JSON only.`,
        ],
        { cwd: repo, env: base, stdio: ["ignore", "pipe", "pipe"] },
      );
      let stdout = "";
      child.stdout.on("data", (x) => (stdout += x));
      const timer = setTimeout(() => child.kill("SIGTERM"), 1_800_000);
      child.on("close", (code) => {
        clearTimeout(timer);
        resolve({ code: code ?? 1, stdout });
      });
    });
    writeFileSync(join(out, "claude.txt"), run.stdout);
    check("the kit's programme ran to the end in one Claude session", run.code === 0, `${Math.round((Date.now() - t0) / 60_000)} min`);
    const landed = /ready to land/.test(run.stdout);
    const parked = /parked/.test(run.stdout);
    check("the row ended ready to land (or parked with a reason)", landed || parked, landed ? "ready to land" : (/"reason":\s*"([^"]+)"/.exec(run.stdout)?.[1] ?? "parked"));
    note(log, `(row outcome: ${landed ? "ready to land" : "parked"})`);

    await sleep(16_000);
    const branches = (await git("branch", "--list")).stdout;
    check("the two sides worked on their own branches", /impl\/ROW-1/.test(branches) && /test\/ROW-1/.test(branches), branches.replace(/\s+/g, " ").trim());
    const pending = join(repo, ".git", "mesh", "pending", "ROW-1");
    const records = existsSync(pending) ? readdirSync(pending).sort() : [];
    check("mesh recorded every role of the programme", ["spec-writer.md", "reviewer.md", "impl-planner.md", "test-planner.md"].every((f) => records.includes(f)), records.join(", "));
    const typed = records.filter((f) => {
      const doc = parse(readFileSync(join(pending, f), "utf8").split("---\n")[1] ?? "") as { rounds?: { result?: unknown; model?: string }[] };
      return doc.rounds?.every((r) => r.result !== undefined && r.model);
    });
    check("each record has the model and the typed result of every round", typed.length === records.length && records.length > 0, `${typed.length}/${records.length}`);
    const committed = (await git("log", "--all", "--name-only", "--format=")).stdout;
    check("the programme's ledger step committed the records (mesh ledger stage)", committed.includes(".mesh/goals/ROW-1/steps/"), committed.split("\n").filter((l) => l.includes(".mesh/")).slice(0, 4).join(", "));
    if (existsSync(join(pending, "reviewer.md"))) writeFileSync(join(out, "reviewer.ROW-1.md"), readFileSync(join(pending, "reviewer.md"), "utf8"));
  } finally {
    for (const p of procs) p.kill("SIGTERM");
    await sleep(500);
    forgetProject(repo);
  }
  note(log, failures.length ? `\n${failures.length} check(s) failed.` : "\nAll checks passed.");
  if (failures.length) {
    process.exitCode = 1;
    throw new Error(`e2e-kit: ${failures.join("; ")}`);
  }
}
