// RL-7 daemon side end to end (World + the fake claude): a headless run's session is registered and
// bound by the daemon itself (no hooks), hooks stay idempotent, a first tool call binds, the session
// ends with the run (also when reaped at restart), no rebind after done, the run's environment, fail
// fast on invalid agent front matter, and the `mesh_done` reply of a headless run. Criteria AC-01 to
// AC-06, AC-10, AC-14, AC-19, AC-20. Written from the spec's contracts only (docs/specs/RL-7.md).
// "No hook is sent" means the test never calls `w.hook`/`w.turn`/`r.runSession` for the run, and the
// fake sends none. Sessions are found by Claude session id or `sid`, steps by id, requests by
// (method, path, key). No test runs the real `claude`.

import { existsSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { parseAgentFile } from "../src/core/index.ts";
import { git, Relay, sleep, until, type PlanIn } from "./helpers/relay-kit.ts";
import type { Json, Person } from "./helpers/world.ts";

let r: Relay;
const tmp: string[] = [];
const savedEnv: Record<string, string | undefined> = {};
afterEach(async () => {
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
    delete savedEnv[k];
  }
  await r?.stop();
  for (const d of tmp.splice(0)) rmSync(d, { recursive: true, force: true });
});
const setEnv = (k: string, v: string) => {
  if (!(k in savedEnv)) savedEnv[k] = process.env[k];
  process.env[k] = v;
};

/** The stream `result` event of the spike (§2 shape). */
const RESULT_LINE =
  '{"type":"result","subtype":"success","is_error":false,"num_turns":2,"duration_ms":900,"total_cost_usd":0.001,"usage":{"input_tokens":5,"output_tokens":7,"cache_read_input_tokens":0,"cache_creation_input_tokens":0},"permission_denials":[],"session_id":"$SESSION"}';
const GOOD = "---\ndescription: Good agent\n---\nYou review.\n";
/** Line 2 of the front matter (`description: Validates: findings`) is not valid YAML. */
const BAD = "---\nname: bad\ndescription: Validates: findings\n---\nYou validate.\n";
const UNKNOWN = "mesh doesn't know this Claude session yet (are the hooks installed? run `mesh doctor`).";
const NO_STEP = "this session holds no step";
const BRIEF = "Review module X (RL7-BRIEF)";
const MIN = 60_000;

interface Cast {
  ann: Person;
  /** ann's other login: its offers to ann's machine are auto (accept `self`). */
  self: string;
}

/** ann (share `me`) with a remote-backed checkout `svc` holding the agents `good` and `bad`. */
async function cast(o: { maxSessions?: number } = {}): Promise<Cast> {
  r = await Relay.start(["ann"]);
  const ann = await r.headlessPerson("ann", { person: { shareSessions: "me" }, agents: { good: GOOD, bad: BAD } });
  git(ann.repoDir, ["remote", "add", "origin", "https://git.example.com/rl7/svc.git"]);
  if (o.maxSessions !== undefined) await r.w.restart(ann, { maxSessions: o.maxSessions });
  const self = await r.otherLogin("ann");
  await r.w.flush();
  return { ann, self };
}

/** A goal of ann with one step (`mode: headless` unless given); the fake gets `script`. Returns the step id. */
async function headlessStep(k: Cast, step: PlanIn, script?: unknown[]): Promise<string> {
  const G = await r.goal(k.self, [{ mode: "headless", brief: BRIEF, ...step }]);
  const id = `${G}.${step.id}`;
  r.script(id, script ?? [{ waitFor: `go-${id}` }, { stdout: [RESULT_LINE] }, { exit: 0 }]);
  return id;
}

/** Offer it, pull, and wait for the fake to start. */
async function startRun(k: Cast, id: string): Promise<{ call: Json; run: Json }> {
  await r.autoOffer(k.ann, id, k.self);
  await r.pull(k.ann);
  const call = await r.started(id);
  const run = await r.runOf(k.ann, id);
  return { call, run };
}

/** The run's session: the one whose `claudeSessionIds` holds the run's session id (exactly one). */
async function runSessionOf(p: Person, run: Json): Promise<Json> {
  const ss = await r.sessionsOf(p, run.sessionId);
  expect(ss, JSON.stringify(ss)).toHaveLength(1);
  return ss[0];
}
const bySid = (p: Person, sid: string): Json | undefined => (p.daemon.sessions as Json[]).find((s) => s.sid === sid);
const claimsOf = (p: Person, id: string) => p.requests.map((q, i) => ({ ...q, i })).filter((q) => q.method === "POST" && q.path === `/v1/steps/${id}/claim`);
const real = (p: string) => realpathSync(p);

/** AC-01 state: a running headless run, no hook sent. */
async function running(o: { maxSessions?: number; step?: Partial<PlanIn>; script?: unknown[] } = {}) {
  const k = await cast(o);
  const id = await headlessStep(k, { id: "reg", ...o.step }, o.script);
  const { call, run } = await startRun(k, id);
  return { k, id, call, run };
}

// ---------------------------------------------------------------------------------------------

describe("AC-01 registration without hooks", { timeout: 60_000 }, () => {
  it("test_AC01_registered_at_start", async () => {
    const { k, id, call, run } = await running();
    // Positive control: the run did start, with a live process.
    expect(run.state).toBe("running");
    expect(run.pid).toBe(call.pid);
    const s = await runSessionOf(k.ann, run);
    expect(s).toMatchObject({ state: "working", kind: "print", pid: call.pid, step: id });
    expect(real(s.cwd)).toBe(real(r.worktreeOf(k.ann, run)));
    expect(s.repo?.name).toBe("svc");
    expect(s.pane).toBeUndefined();
    expect(s.tmuxSocket).toBeUndefined();
    await r.w.flush();
    expect((await r.stepOf(id)).holderSid).toBe(s.sid);
    // Rule 1 order: the bind claim (key bind:<sid>:<step>) goes before the first POST …/run.
    const claim = k.ann.requests.findIndex((q) => q.method === "POST" && q.path === `/v1/steps/${id}/claim` && q.key === `bind:${s.sid}:${id}`);
    const runReq = k.ann.requests.findIndex((q) => q.method === "POST" && q.path === `/v1/steps/${id}/run`);
    expect(claim, JSON.stringify(k.ann.requests.filter((q) => q.path.startsWith(`/v1/steps/${id}`)))).toBeGreaterThanOrEqual(0);
    expect(runReq).toBeGreaterThan(claim);
  });

  it("test_AC01_not_stalled_by_tick", async () => {
    const { k, id, run } = await running({ step: { budget: { minutes: 1440 } } });
    const s = await runSessionOf(k.ann, run);
    expect(s.state).toBe("working");
    r.w.clock += 30 * MIN;
    k.ann.daemon.tick();
    await r.w.flush();
    expect(bySid(k.ann, s.sid)?.state).toBe("working");
    const att = (await r.w.api(k.ann, "GET", "/v1/attention")).json.attention as Json[];
    expect(att.filter((a) => a.step === id && /stall/.test(String(a.kind)))).toStrictEqual([]);
    // Never presumed ended while the run runs (no `claude agents` view of it, a long time later).
    r.w.clock += 20 * 60 * MIN;
    k.ann.agents = [];
    k.ann.daemon.tick();
    await r.reconcile(k.ann);
    expect((await r.runOf(k.ann, id)).state).toBe("running");
    expect(bySid(k.ann, s.sid)?.state).toBe("working");
  });

  it("test_AC01_control_interactive_stalls", async () => {
    const k = await cast();
    const G = await r.goal(k.self, [{ id: "plain" }]);
    const pid = r.liveSleep();
    await r.w.hook(k.ann, "SessionStart", pid);
    const c = await r.w.tool(k.ann, pid, "mesh_claim", { step: `${G}.plain` });
    expect(c.isError, c.text).toBeFalsy();
    await r.w.turn(k.ann, pid, "Next I'll update the tests.");
    r.w.clock += 30 * MIN;
    k.ann.daemon.tick();
    const s = r.w.session(k.ann, pid) as Json;
    expect(s.state === "stalled" || (s.nudges ?? 0) > 0, JSON.stringify(s)).toBe(true);
  });
});

// ---------------------------------------------------------------------------------------------

describe("AC-02 tools without hooks", { timeout: 60_000 }, () => {
  it("test_AC02_tools_without_hooks", async () => {
    const { k, id, call } = await running();
    const G = id.split(".")[0] as string;
    const ctx = await r.w.tool(k.ann, call.pid, "mesh_context");
    expect(ctx.isError, ctx.text).toBeFalsy();
    expect(ctx.text).toContain(id);
    expect(ctx.text).toContain("RL7-BRIEF");
    expect(ctx.text).not.toContain("holds no");
    expect(ctx.text).not.toContain("doesn't know this Claude session");
    const a = await r.w.tool(k.ann, call.pid, "mesh_artifact" as never, { kind: "report", content: "rl7 report" });
    expect(a.isError, a.text).toBeFalsy();
    const d = await r.w.tool(k.ann, call.pid, "mesh_done", { outcome: "done", summary: "ok" });
    expect(d.isError, d.text).toBeFalsy();
    r.go(`go-${id}`);
    await r.endRun(k.ann, id);
    const st = await r.stepOf(id);
    expect(st.state).toBe("done");
    expect(st.rounds).toHaveLength(1);
    expect(await r.events("step.done", id)).toHaveLength(1);
    expect(await r.events("step.failed", id)).toStrictEqual([]);
    expect((await r.runOf(k.ann, id)).state).toBe("finished");
    const arts = await r.artifactsOf(G);
    // Positive control: the listing holds the stored report.
    expect(arts.filter((x) => x.kind === "report" && x.step === id)).toHaveLength(1);
    expect(arts.filter((x) => x.kind === "transcript")).toStrictEqual([]);
    expect(st.rounds.at(-1).telemetry).toMatchObject({ turnsApprox: false, turns: 2 });
  });
});

// ---------------------------------------------------------------------------------------------

describe("AC-03 hooks stay idempotent", { timeout: 60_000 }, () => {
  async function hooks(withStep: boolean) {
    const { k, id, call, run } = await running();
    const s = await runSessionOf(k.ann, run);
    await r.w.flush();
    const holder = (await r.stepOf(id)).holderSid;
    const cwd = r.worktreeOf(k.ann, run);
    const headers = { tmuxPane: undefined, ...(withStep ? { step: id } : {}) };
    await r.w.hook(k.ann, "SessionStart", call.pid, { session_id: run.sessionId, cwd }, headers);
    await r.w.hook(k.ann, "UserPromptSubmit", call.pid, { session_id: run.sessionId, cwd, prompt: "work" }, headers);
    const stop = await r.w.hook(k.ann, "Stop", call.pid, { session_id: run.sessionId, cwd, stop_hook_active: false, last_assistant_message: "ok" }, headers);
    await r.w.flush();
    const after = await r.sessionsOf(k.ann, run.sessionId);
    expect(after).toHaveLength(1);
    expect(after[0].sid).toBe(s.sid);
    expect((await r.stepOf(id)).holderSid).toBe(holder);
    expect(holder).toBe(s.sid);
    expect(stop).toStrictEqual({});
    expect(k.ann.requests.filter((q) => q.key === `bind:${s.sid}:${id}`)).toHaveLength(1);
    // Positive control: a SessionStart of an unrelated pid does add a session to the listing.
    const before = (await r.local(k.ann, "GET", "/local/sessions")).json.sessions.length as number;
    const other = r.liveSleep();
    await r.w.hook(k.ann, "SessionStart", other, { session_id: `other-${other}` });
    expect((await r.local(k.ann, "GET", "/local/sessions")).json.sessions.length).toBe(before + 1);
  }

  it("test_AC03_hooks_idempotent_with_step", async () => {
    await hooks(true);
  });

  it("test_AC03_hooks_idempotent_without_step", async () => {
    await hooks(false);
  });
});

// ---------------------------------------------------------------------------------------------

describe("AC-04 bind on first tool call", { timeout: 60_000 }, () => {
  it("test_AC04a_rebind_after_session_end", async () => {
    const { k, id, call, run } = await running();
    const s = await runSessionOf(k.ann, run);
    await r.w.hook(k.ann, "SessionEnd", call.pid, { session_id: run.sessionId, cwd: r.worktreeOf(k.ann, run) }, { tmuxPane: undefined });
    // Control: the end took effect.
    expect(bySid(k.ann, s.sid)?.state).toBe("ended");
    const ctx = await r.w.tool(k.ann, call.pid, "mesh_context");
    expect(ctx.isError, ctx.text).toBeFalsy();
    expect(ctx.text).toContain(id);
    const after = await r.sessionsOf(k.ann, run.sessionId);
    expect(after).toHaveLength(1);
    expect(after[0].sid).toBe(s.sid);
    expect(after[0].state).not.toBe("ended");
    expect(after[0].step).toBe(id);
  });

  it("test_AC04b_bind_hook_session_without_step", async () => {
    const { k, id, call, run } = await running();
    await r.w.hook(k.ann, "SessionEnd", call.pid, { session_id: run.sessionId, cwd: r.worktreeOf(k.ann, run) }, { tmuxPane: undefined });
    const folder = mkdtempSync(join(tmpdir(), "mesh-rl7-other-"));
    tmp.push(folder);
    const otherId = `other-${run.sessionId}`;
    await r.w.hook(k.ann, "SessionStart", call.pid, { session_id: otherId, cwd: folder }, { tmuxPane: undefined });
    const [o] = await r.sessionsOf(k.ann, otherId);
    // Control: a live session with that id and no step.
    expect(o, "the other session").toBeDefined();
    expect(o.state).not.toBe("ended");
    expect(o.step).toBeUndefined();
    const ctx = await r.w.tool(k.ann, call.pid, "mesh_context");
    expect(ctx.isError, ctx.text).toBeFalsy();
    expect(ctx.text).toContain(id);
    const now = bySid(k.ann, o.sid);
    expect(now?.step).toBe(id);
    expect(now?.claudeSessionIds).toContain(run.sessionId);
    await r.w.flush();
    expect(k.ann.requests.filter((q) => q.method === "POST" && q.path === `/v1/steps/${id}/claim` && q.key === `bind:${o.sid}:${id}`)).toHaveLength(1);
  });

  it("test_AC04c_controls_unchanged", async () => {
    const { k, id } = await running();
    const stranger = r.liveSleep();
    const t = await r.w.tool(k.ann, stranger, "mesh_context");
    expect(t.text).toBe(UNKNOWN);
    const pid2 = r.liveSleep();
    await r.w.hook(k.ann, "SessionStart", pid2);
    const d = await r.w.tool(k.ann, pid2, "mesh_done", { outcome: "done", summary: "x" });
    expect(d.isError).toBe(true);
    expect(d.text).toBe(NO_STEP);
    expect(r.w.session(k.ann, pid2).step).toBeUndefined();
    expect((await r.stepOf(id)).state).toBe("claimed");
  });
});

// ---------------------------------------------------------------------------------------------

describe("AC-05 session ends with the run", { timeout: 60_000 }, () => {
  async function queued() {
    const k = await cast({ maxSessions: 1 });
    const e1 = await headlessStep(k, { id: "e1" }, [{ waitFor: "go-e1" }, { exit: 0 }]);
    const { run } = await startRun(k, e1);
    const e2 = await headlessStep(k, { id: "e2" }, [{ waitFor: "go-e2" }, { exit: 0 }]);
    await r.autoOffer(k.ann, e2, k.self);
    await r.pull(k.ann);
    await r.reconcile(k.ann);
    await sleep(200);
    // Control before the end: e2 waits behind e1, whose session is working.
    expect(r.calls(e2)).toStrictEqual([]);
    expect((await r.runOf(k.ann, e2)).state).toBe("queued");
    const s = await runSessionOf(k.ann, run);
    expect(s.state).toBe("working");
    return { k, e1, e2, run, s };
  }
  async function closed(k: Cast, e1: string, e2: string, sid: string) {
    expect(bySid(k.ann, sid)?.state).toBe("ended");
    const st = await r.stepOf(e1);
    expect(st.state).toBe("failed");
    expect(st.rounds.at(-1).summary).toContain("headless run ended without mesh_done (exit no_result)");
    await r.reconcile(k.ann);
    await r.started(e2);
    expect((await r.runOf(k.ann, e2)).state).toBe("running");
  }

  it("test_AC05_session_ends_with_run", async () => {
    const { k, e1, e2, s } = await queued();
    r.go("go-e1");
    await r.endRun(k.ann, e1);
    await closed(k, e1, e2, s.sid);
  });

  it("test_AC19_session_ended_on_reap", async () => {
    const { k, e1, e2, run, s } = await queued();
    await r.w.restart(k.ann, {}, {}, async () => {
      r.go("go-e1");
      expect(await until(() => r.exitFile(k.ann, run) !== undefined, 10_000), "exit file").toBe(true);
    });
    await r.reconcile(k.ann);
    await closed(k, e1, e2, s.sid);
  });
});

// ---------------------------------------------------------------------------------------------

describe("AC-20 no rebind after done", { timeout: 60_000 }, () => {
  it("test_AC20_no_rebind_after_done", async () => {
    const { k, id, call, run } = await running();
    const s = await runSessionOf(k.ann, run);
    const d = await r.w.tool(k.ann, call.pid, "mesh_done", { outcome: "done", summary: "ok" });
    expect(d.isError, d.text).toBeFalsy();
    await r.w.flush();
    expect((await r.stepOf(id)).state).toBe("done");
    const done = k.ann.requests.findIndex((q) => q.method === "POST" && q.path === `/v1/steps/${id}/done`);
    expect(done).toBeGreaterThanOrEqual(0);
    // Positive control: the log holds the rule-1 claim before the done.
    expect(claimsOf(k.ann, id).filter((q) => q.i < done)).toHaveLength(1);
    const ctx = await r.w.tool(k.ann, call.pid, "mesh_context");
    expect(ctx.text.startsWith("This session holds no mesh step"), ctx.text).toBe(true);
    await r.w.flush();
    expect(bySid(k.ann, s.sid)?.step).toBeUndefined();
    expect(claimsOf(k.ann, id).filter((q) => q.i > done)).toStrictEqual([]);
    const again = await r.w.tool(k.ann, call.pid, "mesh_done", { outcome: "done", summary: "again" });
    expect(again.text).toBe(NO_STEP);
  });

  it("test_AC20_no_rebind_after_offline_done", async () => {
    const { k, id, call, run } = await running();
    const s = await runSessionOf(k.ann, run);
    await r.w.flush();
    k.ann.offline = true;
    const mark = k.ann.requests.length;
    const d = await r.w.tool(k.ann, call.pid, "mesh_done", { outcome: "done", summary: "ok" });
    expect(d.isError, d.text).toBeFalsy();
    expect(d.text).toContain("The hub is offline");
    k.ann.offline = false;
    const ctx = await r.w.tool(k.ann, call.pid, "mesh_context");
    expect(ctx.text.startsWith("This session holds no mesh step"), ctx.text).toBe(true);
    await r.w.flush();
    await r.w.flush();
    expect(bySid(k.ann, s.sid)?.step).toBeUndefined();
    expect(claimsOf(k.ann, id).filter((q) => q.i >= mark)).toStrictEqual([]);
    // Control: the queued done reaches the hub once the link is back (move the clock past its retry
    // wait, as the other local-first tests do).
    for (let i = 0; i < 3 && k.ann.daemon.status().hub !== "ok"; i++) {
      r.w.clock += 61_000;
      await k.ann.daemon.link?.flush();
    }
    await r.w.flush();
    expect(k.ann.daemon.status().hub).toBe("ok");
    expect((await r.stepOf(id)).state).toBe("done");
    expect(claimsOf(k.ann, id).filter((q) => q.i >= mark)).toStrictEqual([]);
  });
});

// ---------------------------------------------------------------------------------------------

describe("AC-06 environment", { timeout: 60_000 }, () => {
  it("test_AC06_world_env_stripped", async () => {
    setEnv("TMUX", "/tmp/tmux-1/default,1,0");
    setEnv("TMUX_PANE", "%3");
    setEnv("MESH_AUTOPILOT", "chain");
    setEnv("CLAUDE_PID", "4242");
    setEnv("FAKE_PARENT_VAR", "kept");
    const { id, call, run } = await running();
    expect(call.probe, JSON.stringify(call)).toBeDefined();
    expect(call.probe).toMatchObject({ TMUX: null, TMUX_PANE: null, MESH_AUTOPILOT: null, CLAUDE_PID: null, FAKE_PARENT_VAR: "kept", MESH_STEP: id, MESH_RUN: run.runId });
  });
});

// ---------------------------------------------------------------------------------------------

describe("AC-10 fail fast", { timeout: 60_000 }, () => {
  it("test_AC10_repo_agent_invalid", async () => {
    const k = await cast();
    const id = await headlessStep(k, { id: "ff1", agent: "bad" }, []);
    await r.autoOffer(k.ann, id, k.self);
    await r.pull(k.ann);
    await r.reconcile(k.ann);
    expect(await until(async () => (await r.stepOf(id)).state === "failed", 5_000), "step failed").toBe(true);
    await r.reconcile(k.ann);
    await sleep(200);
    expect(r.calls(id)).toStrictEqual([]);
    const inv = (parseAgentFile(BAD) as Json).invalid as string;
    expect(typeof inv).toBe("string");
    expect(inv.startsWith("front matter is not valid YAML: "), inv).toBe(true);
    const st = await r.stepOf(id);
    expect(st.rounds.at(-1)).toMatchObject({ outcome: "fail", summary: `headless run of ${id} did not start: agent bad has invalid front matter: ${inv}` });
    expect(await until(async () => (await r.runOf(k.ann, id)).state === "finished")).toBe(true);
    const run = await r.runOf(k.ann, id);
    expect(existsSync(join(r.runDir(k.ann, run), "agents.json"))).toBe(false);
    expect(existsSync(r.worktreeOf(k.ann, run))).toBe(false);
  });

  it("test_AC10_control_good_starts", async () => {
    const k = await cast();
    const id = await headlessStep(k, { id: "ff3", agent: "good" });
    const { call } = await startRun(k, id);
    expect(call.argv).toContain("--agents");
    const i = (call.argv as string[]).indexOf("--agent");
    expect(call.argv[i + 1]).toBe("good");
  });
});

// ---------------------------------------------------------------------------------------------

describe("AC-14 mesh_done reply", { timeout: 60_000 }, () => {
  it("test_AC14_headless_online", async () => {
    const { k, id, call, run } = await running();
    const d = await r.w.tool(k.ann, call.pid, "mesh_done", { outcome: "done", summary: "ok" });
    expect(d.isError, d.text).toBeFalsy();
    expect(d.text).toContain("mesh wrote the step record");
    expect(d.text).not.toMatch(/git add/);
    expect(d.text).not.toMatch(/commit/i);
    // Control: the trail is still written in the worktree.
    const G = id.split(".")[0] as string;
    const step = id.slice(G.length + 1);
    expect(existsSync(join(r.worktreeOf(k.ann, run), ".mesh", "goals", G, "steps", `${step}.md`))).toBe(true);
  });

  it("test_AC14_headless_offline", async () => {
    const { k, id, call } = await running();
    await r.w.flush();
    k.ann.offline = true;
    const d = await r.w.tool(k.ann, call.pid, "mesh_done", { outcome: "done", summary: "ok" });
    k.ann.offline = false;
    expect(d.isError, d.text).toBeFalsy();
    expect(d.text.startsWith(`The hub is offline: mesh recorded ${id} as done locally and wrote the step record `), d.text).toBe(true);
    expect(d.text.endsWith(". The hub gets it when it is back (facts from other people's sessions are added then)."), d.text).toBe(true);
    expect(d.text).not.toMatch(/commit/i);
  });

  it("test_AC14_interactive_control", async () => {
    const k = await cast();
    // Two steps, so the goal stays open and the reply names the step record alone.
    const G = await r.goal(k.self, [{ id: "plain" }, { id: "later" }]);
    const pid = r.liveSleep();
    await r.w.hook(k.ann, "SessionStart", pid);
    const c = await r.w.tool(k.ann, pid, "mesh_claim", { step: `${G}.plain` });
    expect(c.isError, c.text).toBeFalsy();
    const d = await r.w.tool(k.ann, pid, "mesh_done", { outcome: "done", summary: "ok" });
    expect(d.isError, d.text).toBeFalsy();
    expect(d.text, d.text).toContain("Commit it with your work: git add");
  });
});
