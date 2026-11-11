// M4.5 CLI pieces against real git: one worktree and branch per step, reused on a fix round.
// MM-2 AC-15: `mesh run --label` records the labels for each start folder before the session starts.
// MM-3 AC-27 / AC-40: `mesh accept <step> --launch` starts the session as `mesh run <repo> --step <step>` would.
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { run, type RunResult, type Runner } from "../src/claude/index.ts";
import { dispatch } from "../src/cli/commands.ts";
import { meshCommands, stepWorktree, type CliEnv } from "../src/cli/mesh-commands.ts";
import { Daemon, defaultDeps } from "../src/daemon/index.ts";
import { resolvePaths, type DaemonConfig } from "../src/protocol/index.ts";
import { DaemonStore } from "../src/store/index.ts";
import { World, type Json, type Person } from "./helpers/world.ts";

type Paths = ReturnType<typeof resolvePaths>;

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe("step worktrees", () => {
  it("creates <repo>/.claude/worktrees/<step> on mesh/<step> from a base, then reuses it", async () => {
    const repo = mkdtempSync(join(tmpdir(), "mesh-wt-"));
    dirs.push(repo);
    const git = (...args: string[]) => execFileSync("git", ["-C", repo, "-c", "user.email=t@t", "-c", "user.name=t", ...args], { encoding: "utf8" }).trim();
    git("init", "-q");
    writeFileSync(join(repo, "a.txt"), "base");
    git("add", "-A");
    git("commit", "-qm", "base");
    const base = git("rev-parse", "HEAD");
    writeFileSync(join(repo, "a.txt"), "later");
    git("commit", "-qam", "later");

    const first = await stepWorktree(run, repo, { id: "G3.write-tests", goal: "G3" }, base);
    expect(first).toMatchObject({ ok: true, created: true, branch: "mesh/g3-write-tests", base });
    if (!first.ok) return;
    expect(existsSync(join(first.path, "a.txt"))).toBe(true);
    expect(execFileSync("git", ["-C", first.path, "rev-parse", "HEAD"], { encoding: "utf8" }).trim()).toBe(base);

    const again = await stepWorktree(run, repo, { id: "G3.write-tests", goal: "G3" }, undefined);
    expect(again).toMatchObject({ ok: true, created: false, path: first.path });

    // The worktree folder was removed but the branch stays: the next round continues on it.
    git("worktree", "remove", "--force", first.path);
    const third = await stepWorktree(run, repo, { id: "G3.write-tests", goal: "G3" }, undefined);
    expect(third).toMatchObject({ ok: true, created: true, base: "mesh/g3-write-tests" });

    const bad = await stepWorktree(run, repo, { id: "G3.x", goal: "G3" }, "no-such-ref");
    expect(bad.ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------------------------
// MM-2 AC-15: `mesh run --label` (real tmux, a fake `claude`, a real daemon on the set-up config).

let haveTmux = true;
try {
  execFileSync("tmux", ["-V"]);
} catch {
  haveTmux = false;
}

const freePort = () =>
  new Promise<number>((ok, fail) => {
    const s = createServer();
    s.once("error", fail);
    s.listen(0, "127.0.0.1", () => {
      const port = (s.address() as { port: number }).port;
      s.close(() => ok(port));
    });
  });

interface Call {
  method: string;
  path: string;
  body: Json;
  /** Whether `claude` had been started (the fake recorded a call) when this request was made. */
  claudeStarted: boolean;
  /** Whether a tmux window had been opened for a session when this request was made. */
  windows: number;
}

interface Rig {
  root: string;
  ws: string;
  paths: Paths;
  daemon: Daemon;
  store: DaemonStore;
  config: DaemonConfig;
  record: string;
  socket: string;
  out: string[];
  err: string[];
  calls: Call[];
  w?: World;
}

const rigs: Rig[] = [];
const oldPath = process.env.PATH;
afterEach(async () => {
  for (const r of rigs.splice(0)) {
    try {
      execFileSync("tmux", ["-L", r.socket, "kill-server"], { stdio: "ignore" });
    } catch {
      // never started, or already gone
    }
    await r.daemon.stop();
    r.store.close();
    await r.w?.stop();
  }
  process.env.PATH = oldPath;
});

let rigCount = 0;

/**
 * A workspace `ws` with the given checkouts (fake `.git` folders, or real git repos with a commit),
 * a fake `claude` on PATH, `mesh setup` done on a free port, and a daemon listening there.
 */
async function rig(repos: string[], opts: { realGit?: boolean; world?: World; credentials?: Json } = {}): Promise<Rig> {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "mesh-runlabel-")));
  dirs.push(root);
  const ws = join(root, "ws");
  for (const name of repos) {
    const dir = join(ws, name);
    mkdirSync(dir, { recursive: true });
    if (opts.realGit) {
      const git = (...args: string[]) => execFileSync("git", ["-C", dir, "-c", "user.email=t@t", "-c", "user.name=t", ...args], { encoding: "utf8" });
      git("init", "-q");
      writeFileSync(join(dir, "a.txt"), "base");
      writeFileSync(join(dir, ".gitignore"), ".claude/\n");
      git("add", "-A");
      git("commit", "-qm", "base");
    } else {
      mkdirSync(join(dir, ".git"));
    }
  }
  const bin = join(root, "bin");
  mkdirSync(bin);
  const record = join(root, "calls.txt");
  const fake = join(bin, "claude");
  // `--bg` returns at once; an interactive start keeps running like Claude would.
  writeFileSync(fake, `#!/bin/sh\necho "$PWD|$*" >> '${record}'\ncase "$*" in *--bg*) exit 0;; esac\nexec sleep 30\n`);
  chmodSync(fake, 0o755);
  process.env.PATH = `${bin}:${oldPath}`;
  const paths = resolvePaths({ MESH_CONFIG_DIR: join(root, "cfg"), MESH_STATE_DIR: join(root, "state"), CLAUDE_CONFIG_DIR: join(root, "claude") }, root);
  const out: string[] = [];
  const err: string[] = [];
  const c: CliEnv = { io: { out: (t) => out.push(t), err: (t) => err.push(t) }, paths, env: {}, cwd: ws, self: [fake], version: "0.0.0" };
  const setup = meshCommands(c).find((x) => x.name === "setup") as { run(a: string[]): Promise<number> };
  expect(await setup.run(["--port", String(await freePort()), "--no-mcp"])).toBe(0);
  if (opts.credentials) writeFileSync(paths.credentials, JSON.stringify(opts.credentials), { mode: 0o600 });
  const config = JSON.parse(readFileSync(paths.daemonConfig, "utf8")) as DaemonConfig;
  const store = await DaemonStore.open(":memory:");
  const daemon = new Daemon({
    config,
    store,
    deps: defaultDeps({
      harness: () => undefined,
      claudeVersion: async () => "2.1.318",
      scanRuns: () => [],
      listAgents: async () => [],
      paste: async () => true,
      wakeBackground: async () => ({ ok: true }),
      notify: async () => undefined,
      log: () => undefined,
    }),
    intervals: { reconcileMs: 0, transcriptMs: 0, tickMs: 0, deliveryMs: 0 },
  });
  await daemon.start();
  out.length = 0;
  err.length = 0;
  const r: Rig = { root, ws, paths, daemon, store, config, record, socket: `meshlabel-${process.pid}-${++rigCount}`, out, err, calls: [], ...(opts.world ? { w: opts.world } : {}) };
  rigs.push(r);
  return r;
}

const windowsOf = (r: Rig): number => {
  try {
    return execFileSync("tmux", ["-L", r.socket, "list-windows", "-a", "-F", "#{window_name}"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] })
      .trim()
      .split("\n")
      .filter(Boolean).length;
  } catch {
    return 0;
  }
};

/** Run `mesh run …` with the rig's environment; every request to the daemon is recorded and may be answered by `answer`. */
async function meshRun(r: Rig, args: string[], answer?: (path: string, body: Json) => Response | undefined): Promise<number> {
  const real = globalThis.fetch;
  const spy = vi.spyOn(globalThis, "fetch").mockImplementation(async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (url.port === String(r.daemon.port) && url.pathname.startsWith("/local/")) {
      const method = init?.method ?? (input instanceof Request ? input.method : "GET");
      let body: Json;
      try {
        body = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
      } catch {
        body = init?.body;
      }
      r.calls.push({ method, path: url.pathname, body, claudeStarted: existsSync(r.record), windows: windowsOf(r) });
      const reply = answer?.(url.pathname, body);
      if (reply) return reply;
    }
    return real(input, init);
  });
  const c: CliEnv = { io: { out: (t) => r.out.push(t), err: (t) => r.err.push(t) }, paths: r.paths, env: {}, cwd: r.ws, self: [join(r.root, "bin", "claude")], version: "0.0.0" };
  const cmd = meshCommands(c).find((x) => x.name === "run") as { run(a: string[]): Promise<number> };
  try {
    return await cmd.run([...args, "--socket-name", r.socket]);
  } finally {
    spy.mockRestore();
  }
}

const daemonSessions = async (r: Rig): Promise<Json[]> => {
  const res = await fetch(`http://127.0.0.1:${r.daemon.port}/local/sessions`, { headers: { "x-mesh-key": r.config.key } });
  return ((await res.json()) as Json).sessions;
};

let pids = 7000;
/** A SessionStart hook from a new session in `cwd` (optionally in a given tmux pane); returns the recorded session. */
async function hookAt(r: Rig, cwd: string, pane?: string): Promise<Json> {
  const pid = ++pids;
  await r.daemon.handleHook("SessionStart", { session_id: `claude-${pid}`, cwd, hook_event_name: "SessionStart", transcript_path: `/t/${pid}.jsonl` }, { claudePid: String(pid), tmuxPane: pane ?? `%${pid}` });
  const s = r.daemon.sessions.find((x) => x.pid === pid);
  expect(s, "session recorded").toBeDefined();
  return s;
}

const labelCalls = (r: Rig) => r.calls.filter((c) => c.method === "POST" && c.path === "/local/labels");
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const waitFor = async (cond: () => boolean, ms = 5_000) => {
  for (let t = 0; t < ms && !cond(); t += 100) await new Promise((ok) => setTimeout(ok, 100));
  return cond();
};

describe.skipIf(!haveTmux)("AC-15 mesh run --label", () => {
  it("test_AC15_records_before_start", async () => {
    const r = await rig(["frr"]);
    const dir = join(r.ws, "frr");
    expect(await meshRun(r, ["frr", "--label", "perf"])).toBe(0);
    const calls = labelCalls(r);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.body).toStrictEqual({ cwd: dir, labels: ["perf"] });
    expect(calls[0]?.claudeStarted).toBe(false);
    expect(calls[0]?.windows).toBe(0);
    // Before the placeholder is registered.
    const launchAt = r.calls.findIndex((c) => c.path === "/local/launch");
    expect(launchAt).toBeGreaterThan(r.calls.indexOf(calls[0] as Call));
    // The placeholder has the labels, and so has the session its first hook starts.
    const placeholder = (await daemonSessions(r)).find((s) => s.launching && s.cwd === dir);
    expect(placeholder?.labels).toStrictEqual(["perf"]);
    const adopted = await hookAt(r, dir, placeholder.pane);
    expect(adopted.sid).toBe(placeholder.sid);
    expect(adopted.labels).toStrictEqual(["perf"]);
    // Another new session in the same checkout gets them too.
    expect((await hookAt(r, dir)).labels).toStrictEqual(["perf"]);
  }, 30_000);

  it("test_AC15_worktree_gets_it", async () => {
    const w = new World();
    await w.start(["bob"]);
    const login = await w.login("bob");
    const r = await rig(["frr"], { realGit: true, world: w, credentials: { hub: w.hub.url, token: login.token, user: login.user, machine: login.machine } });
    const call = (method: "GET" | "POST", path: string, body?: unknown) => w.call(login.token, method, path, body);
    const g = await call("POST", "/v1/goals", { title: "labels", primaryRepo: "frr" });
    expect(g.status, JSON.stringify(g.json)).toBe(201);
    const plan = await call("POST", `/v1/goals/${g.json.id}/plan`, { steps: [{ id: "a", repo: "frr", kind: "implement", title: "a", brief: "a" }], approve: true });
    expect(plan.status, JSON.stringify(plan.json)).toBe(201);
    const main = join(r.ws, "frr");
    const code = await meshRun(r, ["frr", "--step", `${g.json.id}.a`, "--worktree", "--label", "perf"]);
    expect(code, r.err.join("\n")).toBe(0);
    const calls = labelCalls(r);
    expect(calls).toHaveLength(1);
    const wt = calls[0]?.body.cwd as string;
    expect(wt.startsWith(join(main, ".claude", "worktrees"))).toBe(true);
    expect(existsSync(wt)).toBe(true);
    expect(calls[0]?.body.labels).toStrictEqual(["perf"]);
    expect((await hookAt(r, wt)).labels).toStrictEqual(["perf"]);
    // Positive control for "not the main checkout": a session there gets no labels.
    expect(Object.hasOwn(await hookAt(r, main), "labels")).toBe(false);
  }, 30_000);

  it("test_AC15_bg_also", async () => {
    const r = await rig(["frr"]);
    const dir = join(r.ws, "frr");
    await meshRun(r, ["frr", "--bg", "--prompt", "do it", "--label", "perf"]);
    const calls = labelCalls(r);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.body).toStrictEqual({ cwd: dir, labels: ["perf"] });
    expect(calls[0]?.claudeStarted).toBe(false);
    expect((await hookAt(r, dir)).labels).toStrictEqual(["perf"]);
  }, 30_000);

  it("test_AC15_bad_label_no_process", async () => {
    const w = new World();
    await w.start(["bob"]);
    const login = await w.login("bob");
    const r = await rig(["frr"], { realGit: true, world: w, credentials: { hub: w.hub.url, token: login.token, user: login.user, machine: login.machine } });
    const g = await w.call(login.token, "POST", "/v1/goals", { title: "labels", primaryRepo: "frr" });
    await w.call(login.token, "POST", `/v1/goals/${g.json.id}/plan`, { steps: [{ id: "a", repo: "frr", kind: "implement", title: "a", brief: "a" }], approve: true });
    for (const args of [
      ["frr", "--label", "bad label"],
      ["frr", "--step", `${g.json.id}.a`, "--label", "bad label"],
    ]) {
      r.err.length = 0;
      expect(await meshRun(r, args), args.join(" ")).toBe(2);
      expect(r.err.join("\n")).toContain("not a label: bad label (");
    }
    expect(r.calls).toEqual([]);
    expect(windowsOf(r)).toBe(0);
    expect(existsSync(r.record)).toBe(false);
    const step = (await w.call(login.token, "GET", `/v1/steps/${g.json.id}.a`)).json.context.step;
    expect(step.state).toBe("ready");
  }, 30_000);

  it("test_AC15_daemon_failure_warns_and_starts", async () => {
    const r = await rig(["frr"]);
    const dir = join(r.ws, "frr");
    const code = await meshRun(r, ["frr", "--label", "perf"], (path) => (path === "/local/labels" ? json(500, { error: "boom" }) : undefined));
    expect(labelCalls(r)).toHaveLength(1);
    expect(r.err.join("\n")).toContain(`warning: could not record the labels for ${dir}: boom`);
    expect(code).toBe(0);
    expect(await waitFor(() => existsSync(r.record))).toBe(true);
    expect(readFileSync(r.record, "utf8")).toContain(`${dir}|`);
  }, 30_000);

  it("test_AC15_not_a_topic_once", async () => {
    const r = await rig(["frr", "agent"]);
    const code = await meshRun(r, ["frr", "agent", "--label", "perf"], (path, body) =>
      path === "/local/labels" ? json(200, { cwd: body.cwd, labels: ["perf"], unknown: ["perf"] }) : undefined,
    );
    expect(code).toBe(0);
    expect(labelCalls(r).map((c) => c.body.cwd).sort()).toEqual([join(r.ws, "agent"), join(r.ws, "frr")]);
    const lines = r.err.join("\n").split("\n");
    expect(lines.filter((l) => l.includes("not a topic"))).toEqual(["not a topic: perf; mesh topic add perf"]);
  }, 30_000);

  it("test_AC15_without_label_no_call", async () => {
    const r = await rig(["frr"]);
    expect(await meshRun(r, ["frr"])).toBe(0);
    // Positive control: the daemon's requests are seen (the placeholder is registered).
    expect(r.calls.map((c) => c.path)).toContain("/local/launch");
    expect(labelCalls(r)).toEqual([]);
    expect(Object.hasOwn(await hookAt(r, join(r.ws, "frr")), "labels")).toBe(false);
  }, 30_000);

  it("test_AC15_usage_mentions_label", async () => {
    const r = await rig([]);
    expect(await meshRun(r, [])).toBe(2);
    const err = r.err.join("\n");
    expect(err).toContain("usage: mesh run");
    expect(err).toContain("--label a,b");
  }, 30_000);
});

// ---------------------------------------------------------------------------------------------
// MM-3 AC-27 (and AC-40, a brand-new sid): `mesh accept <step> --launch` starts the session as
// `mesh run <repo> --step <step>` would. A fake runner records the tmux calls (nothing starts); a
// real hub and daemon (World) answer the claim and adopt the new session at its first hook.

interface TmuxCall {
  args: string[];
  cwd?: string;
  /** What the fake answered (the pane id for new-session / new-window). */
  stdout: string;
}

/** A fake runner: tmux has no session yet, each new pane gets `%<base + n>`; every tmux call is recorded. */
function fakeRunner(base: number): { runner: Runner; calls: TmuxCall[] } {
  const calls: TmuxCall[] = [];
  let n = 0;
  const runner: Runner = async (cmd, args, opts) => {
    if (cmd !== "tmux") return { code: 0, stdout: "", stderr: "" };
    const a = [...args];
    let res: RunResult = { code: 0, stdout: "", stderr: "" };
    if (a.includes("has-session")) res = { code: 1, stdout: "", stderr: "no server" };
    else if (a.includes("new-session") || a.includes("new-window")) res = { code: 0, stdout: `%${base + ++n}\n`, stderr: "" };
    calls.push({ args: a, ...(opts?.cwd ? { cwd: opts.cwd } : {}), stdout: res.stdout.trim() });
    return res;
  };
  return { runner, calls };
}

/** A mesh command as on this World machine (its config folder), with the fake runner. */
async function meshAs(p: Person, runner: Runner, args: string[]): Promise<{ code: number; out: string; err: string }> {
  const out: string[] = [];
  const err: string[] = [];
  const paths = resolvePaths({ MESH_CONFIG_DIR: p.dir, MESH_STATE_DIR: join(p.dir, "state"), CLAUDE_CONFIG_DIR: join(p.dir, "claude") }, p.dir);
  // Run from inside the checkout, so `<repo>` resolves there (not by scanning the temp folder's neighbours).
  const c: CliEnv = { io: { out: (t) => out.push(t), err: (t) => err.push(t) }, paths, env: {}, cwd: p.repoDir, self: ["mesh"], version: "0.0.0", runner };
  let code: number;
  try {
    code = await dispatch(args, meshCommands(c), "0.0.0", (t) => out.push(t));
  } catch (e) {
    err.push(`mesh: ${e instanceof Error ? e.message : String(e)}`);
    code = 1;
  }
  return { code, out: out.join("\n"), err: err.join("\n") };
}

/** The tmux calls with this step id and the pane ids made neutral, to compare two runs. */
const tmuxShape = (calls: TmuxCall[], step: string): Json =>
  JSON.parse(
    JSON.stringify(calls.map((x) => ({ args: x.args, cwd: x.cwd })))
      .replaceAll(step, "<step>")
      .replace(/%\d+/g, "%<pane>"),
  );

const isNewPane = (x: TmuxCall) => x.args.includes("new-window") || x.args.includes("new-session");

/** The pane of the window that runs the step (its argv names the step). */
const stepPane = (calls: TmuxCall[], step: string): number | undefined => {
  const c = calls.find((x) => isNewPane(x) && x.args.some((a) => a.includes(step)));
  return c ? Number(c.stdout.replace("%", "")) : undefined;
};

describe("AC-27 mesh accept --launch", () => {
  let world: World | undefined;
  afterEach(async () => {
    await world?.stop();
    world = undefined;
  });

  /** bob's machine B (`m2`, repo svc); alice (a login, no daemon) owns a goal with ready steps a and b. */
  async function setup(): Promise<{ w: World; B: Person; alice: string; G: string }> {
    const w = new World();
    world = w;
    await w.start(["alice", "bob", "carol"]);
    const B = await w.person("bob", "svc", { hostname: "host-b" });
    expect((await w.api(B, "POST", `/v1/machines/${w.machineOf(B)}/name`, { nickname: "m2" })).status).toBe(200);
    const alice = (await w.login("alice", { hostname: "alice-a1" })).token;
    const g = await w.call(alice, "POST", "/v1/goals", { title: "launch goal", primaryRepo: "svc" });
    expect(g.status, JSON.stringify(g.json)).toBe(201);
    const G = g.json.id as string;
    const plan = ["a", "b"].map((id) => ({ id, repo: "svc", kind: "implement", title: `Title ${id}`, brief: "b", deps: [] }));
    const p = await w.call(alice, "POST", `/v1/goals/${G}/plan`, { steps: plan, approve: true });
    expect(p.status, JSON.stringify(p.json)).toBe(201);
    return { w, B, alice, G };
  }
  const stepOf = async (w: World, token: string, id: string): Promise<Json> => (await w.call(token, "GET", `/v1/steps/${id}`)).json.context.step;

  it("test_AC27_launch_accepts_and_starts", async () => {
    const { w, B, alice, G } = await setup();
    const plain = `${G}.a`;
    const offered = `${G}.b`;
    // The recorded call of `mesh run <repo> --step <step>` (a step without an offer).
    const ref = fakeRunner(800);
    const ran = await meshAs(B, ref.runner, ["run", "svc", "--step", plain]);
    expect(ran.code, ran.err).toBe(0);
    expect(ref.calls.some(isNewPane)).toBe(true);
    // b offered to B (alice offers; bob's policy is self, so it waits for him), then mesh accept b --launch.
    const a = await w.call(alice, "POST", `/v1/steps/${offered}/assign`, { to: "bob/m2" });
    expect(a.status, JSON.stringify(a.json)).toBe(200);
    expect((await stepOf(w, alice, offered)).offer.state).toBe("offered");
    const launch = fakeRunner(900);
    const r = await meshAs(B, launch.runner, ["accept", offered, "--launch"]);
    expect(r.code, r.err).toBe(0);
    // The same tmux calls as mesh run <repo> --step <step>.
    expect(tmuxShape(launch.calls, offered)).toStrictEqual(tmuxShape(ref.calls, plain));
    // The claim from this machine is the accept.
    expect((await stepOf(w, alice, offered)).offer.state).toBe("accepted");
    // The new session's first hook (AC-40: a brand-new sid, never synced): the offer is held by that sid.
    const pane = stepPane(launch.calls, offered);
    expect(pane, "the step's window").toBeDefined();
    await w.hook(B, "SessionStart", pane as number);
    const s = w.session(B, pane as number);
    expect(s?.step).toBe(offered);
    await w.flush();
    await w.flush();
    expect(await stepOf(w, alice, offered)).toMatchObject({ state: "claimed", holderSid: s.sid, offer: { state: "accepted" } });
    expect((await w.hub.svc.store.events(0, 100_000)).filter((e) => e.type === "step.accepted" && e.step === offered)).toHaveLength(1);
  }, 30_000);

  it("test_AC27_launch_accepts_and_starts_step_header", async () => {
    // The real path: mesh run sets MESH_STEP in the window, and the hook sends it as X-Mesh-Step.
    const { w, B, alice, G } = await setup();
    const offered = `${G}.b`;
    const a = await w.call(alice, "POST", `/v1/steps/${offered}/assign`, { to: "bob/m2" });
    expect(a.status, JSON.stringify(a.json)).toBe(200);
    const launch = fakeRunner(920);
    const r = await meshAs(B, launch.runner, ["accept", offered, "--launch"]);
    expect(r.code, r.err).toBe(0);
    expect((await stepOf(w, alice, offered)).offer.state).toBe("accepted");
    const pane = stepPane(launch.calls, offered);
    expect(pane, "the step's window").toBeDefined();
    await w.hook(B, "SessionStart", pane as number, {}, { step: offered });
    const s = w.session(B, pane as number);
    expect(s?.step).toBe(offered);
    await w.flush();
    await w.flush();
    expect(await stepOf(w, alice, offered)).toMatchObject({ state: "claimed", holderSid: s.sid, offer: { state: "accepted" } });
    expect((await w.hub.svc.store.events(0, 100_000)).filter((e) => e.type === "step.accepted" && e.step === offered)).toHaveLength(1);
  }, 30_000);

  it("test_AC27_launch_other_machine_offer", async () => {
    const { w, B, alice, G } = await setup();
    const id = `${G}.b`;
    const C = await w.person("carol", "svc", { hostname: "carol-c" });
    expect((await w.api(C, "POST", `/v1/machines/${w.machineOf(C)}/name`, { nickname: "c" })).status).toBe(200);
    const a = await w.call(alice, "POST", `/v1/steps/${id}/assign`, { to: "carol/c" });
    expect(a.status, JSON.stringify(a.json)).toBe(200);
    const launch = fakeRunner(950);
    const r = await meshAs(B, launch.runner, ["accept", id, "--launch"]);
    expect(r.code).toBe(1);
    expect(r.err).toContain(`${id} is offered to c`);
    expect(launch.calls.filter(isNewPane)).toEqual([]);
    expect(await stepOf(w, alice, id)).toMatchObject({ state: "ready", offer: { state: "offered" } });
    // Positive control: from carol's machine C the same command accepts and starts the session.
    const fromC = fakeRunner(960);
    const ok = await meshAs(C, fromC.runner, ["accept", id, "--launch"]);
    expect(ok.code, ok.err).toBe(0);
    expect(fromC.calls.some(isNewPane)).toBe(true);
    expect((await stepOf(w, alice, id)).offer.state).toBe("accepted");
  }, 30_000);

  // MM-4 AC-13 (scope guard): `maxSessions` gates only the daemon's own launch for an offer, never
  // `mesh accept --launch` (a person's explicit choice).
  it("test_AC13_accept_launch_not_gated", async () => {
    const { w, B, alice, G } = await setup();
    await w.restart(B, { assignments: "launch", maxSessions: 1 });
    w.hook(B, "SessionStart", 970);
    w.hook(B, "UserPromptSubmit", 970, { prompt: "work" });
    await w.flush();
    const id = `${G}.b`;
    const a = await w.call(alice, "POST", `/v1/steps/${id}/assign`, { to: "bob/m2" });
    expect(a.status, JSON.stringify(a.json)).toBe(200);
    const launch = fakeRunner(980);
    const r = await meshAs(B, launch.runner, ["accept", id, "--launch"]);
    expect(r.code, r.err).toBe(0);
    expect(stepPane(launch.calls, id), "the step's window").toBeDefined();
    expect((await stepOf(w, alice, id)).offer.state).toBe("accepted");
  }, 30_000);
});
