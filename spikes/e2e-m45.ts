// End-to-end check of M4.5 against real Claude Code (haiku, your subscription). Two people, two
// daemons, one repo; a plan with acceptance criteria, blind sides, a verify step that routes an
// impl-bug back to the developer, and an R3 gate a person approves:
//   develop (alice, blind to write-tests) ‖ write-tests (bob, blind to develop) → verify (bob) → r3
// The agents report verdicts, criteria and failure buckets through mesh_done; the hub routes the
// fix, the developer gets only the bucket and assertion, and the records carry it all.
// Never touches ~/.claude settings. Run `pnpm build` and `pnpm spike interactive` first.

import { spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";
import { MODEL, OUT, ROOT, capture, note, q, sh, sleep, tmux } from "./lib.ts";

interface Who {
  name: string;
  env: Record<string, string | undefined>;
  claudeDir: string;
  mcpConfig: string;
}

export async function runE2eM45(): Promise<void> {
  const out = join(OUT, "e2e-m45");
  rmSync(out, { recursive: true, force: true });
  mkdirSync(out, { recursive: true });
  const log = join(out, "results.md");
  const failures: string[] = [];
  const check = (label: string, cond: boolean, detail = "") => {
    note(log, `${cond ? "✅" : "❌"} ${label}${detail ? ` — ${detail}` : ""}`);
    if (!cond) failures.push(label);
  };
  const scratch = join(process.env.MESH_SPIKE_TMP ?? "/tmp", "mesh-spike");
  const repo = join(scratch, "interactive");
  if (!existsSync(repo)) throw new Error("run `pnpm spike interactive` first (it trusts the scratch folder)");
  rmSync(join(repo, ".git"), { recursive: true, force: true });
  for (const f of [".mesh", "hello.txt", "FIXED", "test.sh", "world.txt", "docs"]) rmSync(join(repo, f), { recursive: true, force: true });
  await sh("git", ["init", "-q"], { cwd: repo });
  await sh("git", ["remote", "add", "origin", "git@gitlab.example:team/interactive.git"], { cwd: repo });
  await sh("git", ["-c", "user.email=e2e@mesh", "-c", "user.name=e2e", "commit", "-q", "--allow-empty", "-m", "init"], { cwd: repo });

  const mesh = join(ROOT, "dist", "main.mjs");
  const hubPort = 41_000 + Math.floor(Math.random() * 2_000);
  const hubUrl = `http://127.0.0.1:${hubPort}`;
  const sha = (t: string) => createHash("sha256").update(t).digest("hex");
  writeFileSync(join(out, "hub.yaml"), `listen: 127.0.0.1:${hubPort}\ndb: hub.db\nauth:\n  providers:\n    - id: team\n      kind: token\n      users:\n        - { name: alice, token_sha256: ${sha("m45-alice")} }\n        - { name: bob, token_sha256: ${sha("m45-bob")} }\n  bootstrap_admins: [team:alice]\n`);
  const procs: ChildProcess[] = [];
  const base: Record<string, string | undefined> = { ...process.env, GIT_AUTHOR_NAME: "e2e", GIT_AUTHOR_EMAIL: "e2e@mesh", GIT_COMMITTER_NAME: "e2e", GIT_COMMITTER_EMAIL: "e2e@mesh" };
  delete base.CLAUDE_CONFIG_DIR;
  const run = (who: Who, args: string[], extra: Record<string, string> = {}) =>
    new Promise<{ code: number; stdout: string; stderr: string }>((resolve) => {
      // cwd: the scratch repo, so commands that write trail files write them there.
      const child = spawn(process.execPath, [mesh, ...args], { env: { ...who.env, ...extra }, cwd: repo });
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
    const l = await run(who, ["login", "--hub", hubUrl, "--token", `m45-${name}`]);
    check(`${name}: mesh login`, l.code === 0, l.stdout.trim() || l.stderr.trim());
    // Backfill off: a test daemon never imports workflow runs from your real Claude projects.
    const d = spawn(process.execPath, [mesh, "up", "--no-solo"], { env: { ...env, MESH_BACKFILL: "off" }, stdio: ["ignore", "ignore", "pipe"] });
    let dlog = "";
    d.stderr?.on("data", (x) => {
      dlog += x;
      writeFileSync(join(dir, "daemon.log"), dlog);
    });
    procs.push(d);
    writeFileSync(who.mcpConfig, JSON.stringify({ mcpServers: { mesh: { type: "stdio", command: process.execPath, args: [mesh, "mcp"], env: { MESH_CONFIG_DIR: env.MESH_CONFIG_DIR, MESH_STATE_DIR: env.MESH_STATE_DIR } } } }));
    return who;
  };
  const startClaude = async (who: Who, target: string, step: string, prompt: string) => {
    const settings = join(who.claudeDir, "settings.json");
    // Scratch repo only: allow shell commands so the run never waits on a permission prompt.
    const tools = ["mcp__mesh", "Write", "Edit", "Read", "Bash"].map(q).join(" ");
    const cmd = `claude ${q(prompt)} -n ${who.name}-${step.split(".")[1]} --model ${MODEL} --permission-mode default --settings ${q(settings)} --strict-mcp-config --mcp-config ${q(who.mcpConfig)} --allowedTools ${tools}`;
    const [session, window] = target.split(":") as [string, string];
    const exists = (await tmux("has-session", "-t", session)).code === 0;
    const envArgs = ["-e", `MESH_STEP=${step}`, "-e", "MESH_AUTOPILOT=off", "-e", `MESH_CONFIG_DIR=${who.env.MESH_CONFIG_DIR}`];
    if (exists) await tmux("new-window", "-d", "-t", `${session}:`, "-n", window, "-c", repo, ...envArgs, cmd);
    else await tmux("new-session", "-d", "-s", session, "-n", window, "-x", "200", "-y", "50", "-c", repo, ...envArgs, cmd);
  };
  const token = (who: Who) => (JSON.parse(readFileSync(join(who.env.MESH_CONFIG_DIR as string, "credentials.json"), "utf8")) as { token: string }).token;
  const api = async (who: Who, method: "GET" | "POST", path: string, body?: unknown) => {
    const r = await fetch(hubUrl + path, { method, headers: { "content-type": "application/json", authorization: `Bearer ${token(who)}` }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
    return { status: r.status, json: (await r.json()) as Record<string, unknown> & { [k: string]: unknown } };
  };
  const stepOf = async (who: Who, id: string) => ((await api(who, "GET", `/v1/steps/G1.${id}`)).json.context as { step: { state: string; rounds?: { verdict?: string }[]; fixCycles: number } }).step;
  const until = async (label: string, pred: () => Promise<boolean>, ms: number) => {
    const t0 = Date.now();
    while (Date.now() - t0 < ms) {
      if (await pred()) return true;
      await sleep(4_000);
    }
    note(log, `(timed out: ${label})`);
    return false;
  };

  try {
    procs.push(spawn(process.execPath, [mesh, "hub", "--config", join(out, "hub.yaml")], { env: base, stdio: "ignore" }));
    await sleep(1500);
    const alice = await person("alice", hubPort + 1);
    const bob = await person("bob", hubPort + 2);
    await sleep(1500);
    await tmux("kill-server");

    await run(alice, ["goal", "new", "Greeting", "--repo", "interactive", "--refs", "spec=900"]);
    writeFileSync(
      join(out, "plan.yaml"),
      `acs:
  - { id: AC-01, text: hello.txt contains hello, fails_when: hello.txt missing or without hello }
  - { id: AC-02, text: the FIXED marker exists, fails_when: no file named FIXED }
steps:
  - id: develop
    repo: interactive
    kind: implement
    role: developer
    title: develop
    blind: [write-tests]
    acs: [AC-01, AC-02]
    brief: "Create hello.txt containing the word hello. Then read the notes in mesh_context: if a note says the step was reopened, also create an empty file named FIXED. Call mesh_done with acs_addressed [AC-01, AC-02]."
  - id: write-tests
    repo: interactive
    kind: test
    role: test-writer
    title: write tests
    blind: [develop]
    acs: [AC-01, AC-02]
    brief: "Create test.sh with two lines: grep -q hello hello.txt and test -f FIXED. Do not run it and do not look at other files. Call mesh_done with acs_addressed [AC-01, AC-02]."
  - id: verify
    repo: interactive
    kind: verify
    role: test-executor
    title: verify
    deps: [develop, write-tests]
    route: { impl-bug: develop, infra: park }
    max_rounds: 3
    brief: "Check whether a file named FIXED exists (ls). If it does NOT exist: call mesh_done with verdict fail, acs {AC-01: met, AC-02: not_met}, failures [{ac: AC-02, bucket: impl-bug, assertion: FIXED marker missing}], summary 'FIXED missing'. If it exists: call mesh_done with verdict pass, acs {AC-01: met, AC-02: met}. Do not create or change any file."
  - id: r3
    repo: interactive
    kind: gate
    gate: R3
    title: R3
    deps: [verify]
    brief: a person approves the landing
`,
    );
    const plan = await run(alice, ["goal", "plan", "G1", "--file", join(out, "plan.yaml")]);
    check("plan with criteria, blind sides, routing and a gate approved", plan.code === 0, plan.stdout.trim() || plan.stderr.trim());

    // The blind guard: alice holds develop, so she may not take write-tests.
    check("alice claims develop", (await api(alice, "POST", "/v1/steps/G1.develop/claim", {})).status === 200);
    const refused = await api(alice, "POST", "/v1/steps/G1.write-tests/claim", {});
    check("the blind guard refuses alice on write-tests", refused.status === 409 && /blind to G1.develop/.test(String(refused.json.error)), String(refused.json.error));
    check("bob claims write-tests", (await api(bob, "POST", "/v1/steps/G1.write-tests/claim", {})).status === 200);
    const ctx = (await api(bob, "GET", "/v1/steps/G1.write-tests/context?agent=1")).json as { acs?: unknown[] };
    check("the agent's context carries the criteria", (ctx.acs?.length ?? 0) === 2);

    const work = (step: string) => `You hold mesh step ${step}. Call mesh_context, do exactly what the brief says, then call mesh_done with the fields the brief names. If you receive a message that the step was reopened, call mesh_claim for it, then mesh_context, and do the brief again.`;
    await startClaude(alice, "m45:develop", "G1.develop", work("G1.develop"));
    await startClaude(bob, "m45:tests", "G1.write-tests", work("G1.write-tests"));
    check("develop and write-tests done by two people", await until("both done", async () => (await stepOf(alice, "develop")).state === "done" && (await stepOf(alice, "write-tests")).state === "done", 300_000));

    check("bob claims verify", (await api(bob, "POST", "/v1/steps/G1.verify/claim", {})).status === 200);
    await startClaude(bob, "m45:verify", "G1.verify", `${work("G1.verify")} When the step is ready again later, you get a message: then claim G1.verify with mesh_claim and do the brief again.`);
    const failed = await until("verify round 1 fails and reopens develop", async () => (await stepOf(alice, "develop")).fixCycles === 1, 300_000);
    const v1 = await stepOf(alice, "verify");
    check("verify reported fail with an impl-bug; the hub reopened develop", failed && v1.rounds?.[0]?.verdict === "fail", JSON.stringify(v1.rounds?.[0] ?? {}).slice(0, 300));
    const devCtx = (await api(alice, "GET", "/v1/steps/G1.develop/context?agent=1")).json as { notes: { text: string }[] };
    const reopenNote = devCtx.notes.map((n) => n.text).find((t) => t.startsWith("Reopened by")) ?? "";
    check("the developer gets the bucket and assertion, not the tester's summary", /impl-bug AC-02/.test(reopenNote) && !/FIXED missing/.test(reopenNote), reopenNote);

    const fixed = await until("develop fixed", async () => (await stepOf(alice, "develop")).state === "done" && existsSync(join(repo, "FIXED")), 300_000);
    check("alice's session fixed develop on its own (it got the reopen message)", fixed);
    await run(bob, ["say", "bob-verify", "MESH: G1.verify is ready again. Claim it with mesh_claim, call mesh_context and do the brief again."]);
    check("verify passes in round 2", await until("verify pass", async () => (await stepOf(alice, "verify")).state === "done", 300_000));

    const r3 = await run(alice, ["step", "approve", "G1.r3", "--rule", "GATE-1", "--comment", "e2e"]);
    check("alice approves the R3 gate; the goal is done", r3.code === 0 && /Goal G1 is done/.test(r3.stdout), r3.stdout.trim() || r3.stderr.trim());

    await sleep(3_000);
    const rec = (p: string) => (existsSync(join(repo, p)) ? (parse(readFileSync(join(repo, p), "utf8").split("---\n")[1] ?? "") as Record<string, unknown>) : {});
    const verify = rec(".mesh/goals/G1/steps/verify.md") as { rounds?: { verdict?: string; acs?: Record<string, string>; failures?: { bucket: string }[] }[]; role?: string };
    check(
      "verify.md: two rounds with verdicts, criteria and the bucket",
      verify.rounds?.length === 2 && verify.rounds[0]?.verdict === "fail" && verify.rounds[0]?.failures?.[0]?.bucket === "impl-bug" && verify.rounds[1]?.acs?.["AC-02"] === "met",
      JSON.stringify(verify.rounds ?? []).slice(0, 400),
    );
    const develop = rec(".mesh/goals/G1/steps/develop.md") as { blind?: { separated: boolean }; fix_cycles?: number; segments?: { model?: string }[] };
    check("develop.md: blind sides kept apart, one fix cycle, models recorded", develop.blind?.separated === true && develop.fix_cycles === 1 && !!develop.segments?.[0]?.model, JSON.stringify({ blind: develop.blind, fix: develop.fix_cycles, model: develop.segments?.[0]?.model }));
    const goal = existsSync(join(repo, ".mesh/goals/G1/goal.yaml")) ? (parse(readFileSync(join(repo, ".mesh/goals/G1/goal.yaml"), "utf8")) as { rollup?: { acs?: Record<string, { first_met?: { round: number } }>; buckets?: Record<string, number>; gates?: unknown[] } }) : {};
    check("goal.yaml roll-up: criteria first met, buckets, gates", goal.rollup?.acs?.["AC-02"]?.first_met?.round === 2 && goal.rollup?.buckets?.["impl-bug"] === 1 && (goal.rollup?.gates?.length ?? 0) === 1, JSON.stringify(goal.rollup ?? {}).slice(0, 400));
    for (const w of ["m45:develop", "m45:tests", "m45:verify"]) writeFileSync(join(out, `${w.replace(":", "-")}.txt`), await capture(w));
  } finally {
    await tmux("kill-server");
    for (const p of procs) p.kill("SIGTERM");
    await sleep(500);
  }
  note(log, failures.length ? `\n${failures.length} check(s) failed.` : "\nAll checks passed.");
  if (failures.length) {
    process.exitCode = 1;
    throw new Error(`e2e-m45: ${failures.join("; ")}`);
  }
}
