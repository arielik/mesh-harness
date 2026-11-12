// RL-1 daemon side end to end (World + the fake claude): `mesh_artifact`, headless offers and runs,
// run files, declines, the queue, close-as-fail, telemetry, budget, push, restart, offline done,
// idempotency, taken-over steps and no inbox delivery to a run. Criteria AC-14, AC-21 to AC-29,
// AC-36 to AC-39. Written from the spec's contracts only (docs/specs/RL-1.md). Steps by id, runs by
// `step`, events by type + step, artifacts by id or kind. No test runs the real `claude`.

import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AUDITOR, git, GHP, MESH_TOOL_RULES, PROMPT, Relay, sleep, until, alivePid, type PlanIn } from "./helpers/relay-kit.ts";
import type { Json, Person } from "./helpers/world.ts";

let r: Relay;
afterEach(async () => {
  await r?.stop();
});

const sha = (s: string) => createHash("sha256").update(s, "utf8").digest("hex");
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const slug = (id: string) => id.toLowerCase().replace(/[^a-z0-9]+/g, "-");
const LISTER = "---\nname: lister\ndescription: Lists\ntools: [Read, mcp__mesh__mesh_done]\n---\nYou list.\n";

interface DCast {
  ann: Person;
  bob: Person;
  /** ann's other login: its offers to ann's machine are auto (accept `self`). */
  self: string;
}

async function dcast(o: { maxSessions?: number; assignments?: "deliver" | "launch" | "off"; hubYaml?: Record<string, unknown>; share?: "steps" | "me" | "all" } = {}): Promise<DCast> {
  r = await Relay.start(["ann", "bob", "root"], { admins: ["root"], ...(o.hubYaml ? { hubYaml: o.hubYaml } : {}) });
  const ann = await r.headlessPerson("ann", { nick: "hl", agents: { lister: LISTER }, ...(o.share ? { person: { shareSessions: o.share } } : {}) });
  if (o.maxSessions !== undefined || o.assignments) await r.w.restart(ann, { ...(o.maxSessions !== undefined ? { maxSessions: o.maxSessions } : {}), ...(o.assignments ? { assignments: o.assignments } : {}) });
  const bob = await r.w.person("bob", "svc");
  await r.nick(bob, "bm");
  const self = await r.otherLogin("ann");
  await r.w.flush();
  return { ann, bob, self };
}

/** A goal of ann with one step `id` (policy fields in `step`); the fake gets `script`. Returns the step id. */
async function headlessStep(k: DCast, step: PlanIn, script: unknown[] = []): Promise<string> {
  const G = await r.goal(k.self, [step]);
  const id = `${G}.${step.id}`;
  r.script(id, script);
  return id;
}

/** Offer it to ann's machine (auto) and let the daemon pull it. */
async function offerAndPull(k: DCast, id: string): Promise<Json> {
  const msg = await r.autoOffer(k.ann, id, k.self);
  await r.pull(k.ann);
  return msg;
}

const acksOf = (p: Person, id: number) => p.acks.filter((a) => a.id === id);
const reqs = (p: Person, method: string, path: string) => p.requests.filter((q) => q.method === method && q.path === path);
const roundsOf = async (id: string) => ((await r.stepOf(id)).rounds ?? []) as Json[];
const notesOf = async (id: string): Promise<string[]> => {
  const c = await r.w.call(r.w.machines[0]?.login.token, "GET", `/v1/steps/${id}`);
  return ((c.json.context?.notes ?? []) as Json[]).map((n) => String(n.text));
};
const transcripts = async (G: string) => (await r.artifactsOf(G)).filter((a) => a.kind === "transcript");
const goalOf = (id: string) => id.split(".")[0] as string;

const INIT = '{"type":"system","subtype":"init","session_id":"$SESSION","model":"fake-model","tools":["Read"],"mcp_servers":[{"name":"mesh","status":"connected"}]}';
const say = (id: string, text: string) => JSON.stringify({ type: "assistant", message: { model: "fake-model", id, role: "assistant", content: [{ type: "text", text }], usage: { input_tokens: 3, output_tokens: 2, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } } });
const RESULT = JSON.stringify({ type: "result", subtype: "success", is_error: false, num_turns: 2, duration_ms: 777, total_cost_usd: 0.01, usage: { input_tokens: 5, output_tokens: 6, cache_read_input_tokens: 7, cache_creation_input_tokens: 8 }, permission_denials: [] });

// ---------------------------------------------------------------------------------------------

describe("AC-14 mesh_artifact", { timeout: 40_000 }, () => {
  async function held(k: DCast, pid = 1): Promise<string> {
    const G = await r.goal(k.self, [{ id: "s" }]);
    await r.w.hook(k.ann, "SessionStart", pid);
    const c = await r.w.tool(k.ann, pid, "mesh_claim", { step: `${G}.s` });
    expect(c.isError, c.text).toBeFalsy();
    return `${G}.s`;
  }

  it("test_AC14_redacted_store", async () => {
    const k = await dcast();
    const id = await held(k);
    const res = await r.w.tool(k.ann, 1, "mesh_artifact" as never, { kind: "report", content: `a ${GHP} b ${k.ann.config.key} c ${k.ann.login.token}` });
    expect(res.isError, res.text).toBeFalsy();
    const [a] = (await r.artifactsOf(goalOf(id))).filter((x) => x.kind === "report");
    expect(a).toBeDefined();
    const stored = "a [REDACTED] b [REDACTED] c [REDACTED]";
    expect((await r.call(k.ann, "GET", `/v1/artifacts/${a.id}`)).json.content).toBe(stored);
    expect(a).toMatchObject({ redactions: 3, mediaType: "text/markdown", bytes: Buffer.byteLength(stored), step: id });
    expect(res.text).toBe(`Stored ${a.id} (report, ${Buffer.byteLength(stored)} bytes, 3 redaction(s)).`);
    // test_AC14_idempotency_key
    const up = reqs(k.ann, "POST", `/v1/steps/${id}/artifacts`);
    expect(up).toHaveLength(1);
    expect(up[0]?.key).toMatch(/^mesh_artifact-/);
  });

  it("test_AC14_media_type_and_title", async () => {
    const k = await dcast();
    const id = await held(k);
    const res = await r.w.tool(k.ann, 1, "mesh_artifact" as never, { kind: "review", title: "Findings", media_type: "application/json", content: '{"ok":true}' });
    expect(res.isError, res.text).toBeFalsy();
    const [a] = (await r.artifactsOf(goalOf(id))).filter((x) => x.kind === "review");
    expect(a).toMatchObject({ mediaType: "application/json", title: "Findings", redactions: 0 });
    expect(res.text).toBe(`Stored ${a.id} (review, 11 bytes, 0 redaction(s)).`);
  });

  it("test_AC14_no_step", async () => {
    const k = await dcast();
    const id = await held(k);
    await r.w.hook(k.ann, "SessionStart", 2);
    const res = await r.w.tool(k.ann, 2, "mesh_artifact" as never, { kind: "report", content: "x" });
    expect(res.isError).toBe(true);
    expect(res.text).toBe("this session holds no step");
    expect(await r.artifactsOf(goalOf(id))).toStrictEqual([]);
  });

  it("test_AC14_one_mib_shim", async () => {
    const k = await dcast();
    const id = await held(k);
    const res = await r.local(k.ann, "POST", "/local/mcp/mesh_artifact", { pid: 1, args: { kind: "report", content: "x".repeat(1_048_576) }, key: "shim-key-0001" });
    expect(res.status, JSON.stringify(res.json).slice(0, 300)).toBe(200);
    expect(res.json.isError).toBeFalsy();
    const [a] = await r.artifactsOf(goalOf(id));
    expect(a.bytes).toBe(1_048_576);
    expect(reqs(k.ann, "POST", `/v1/steps/${id}/artifacts`)[0]?.key).toBe("shim-key-0001");
  });

  it("test_AC14_hub_413", async () => {
    const k = await dcast();
    await held(k);
    const res = await r.w.tool(k.ann, 1, "mesh_artifact" as never, { kind: "report", content: "x".repeat(1_048_577) });
    expect(res.isError).toBe(true);
    expect(res.text).toContain("artifact is 1048577 bytes; the limit is 1048576");
  });

  it("test_AC14_offline", async () => {
    const k = await dcast();
    const id = await held(k);
    k.ann.offline = true;
    const res = await r.w.tool(k.ann, 1, "mesh_artifact" as never, { kind: "report", content: "while offline" });
    expect(res.isError).toBe(true);
    expect(res.text.startsWith("the hub is offline; the artifact was not stored.")).toBe(true);
    k.ann.offline = false;
    await r.w.flush();
    await r.w.flush();
    expect(await r.artifactsOf(goalOf(id))).toStrictEqual([]);
    // Positive control: online, the same call stores.
    expect((await r.w.tool(k.ann, 1, "mesh_artifact" as never, { kind: "report", content: "online" })).isError).toBeFalsy();
    expect(await r.artifactsOf(goalOf(id))).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------------------------

describe("AC-21 headless start", { timeout: 40_000 }, () => {
  const POLICY = { mode: "headless", profile: "propose-via-branch", budget: { turns: 5 }, agent: "auditor" };

  async function startAudit(k: DCast) {
    await r.w.hook(k.ann, "SessionStart", 1);
    await r.w.turn(k.ann, 1);
    await r.w.flush();
    const id = await headlessStep(k, { id: "audit", title: "Audit it", ...POLICY }, [{ waitFor: "end" }]);
    const msg = await offerAndPull(k, id);
    const call = await r.started(id);
    return { id, msg, call };
  }

  it("test_AC21_no_session_bound_and_claimed", async () => {
    const k = await dcast();
    const { id, msg } = await startAudit(k);
    await r.reconcile(k.ann);
    expect(k.ann.pastes).toStrictEqual([]);
    expect(r.w.session(k.ann, 1).step).toBeUndefined();
    // test_AC21_hub_claimed
    const st = await r.stepOf(id);
    expect(st.state).toBe("claimed");
    expect(st.holderMachine).toBe(r.w.machineOf(k.ann));
    expect(st.holderSid).toBeUndefined();
    expect(st.offer.state).toBe("accepted");
    expect(await until(() => acksOf(k.ann, msg.id).length > 0)).toBe(true);
    expect(acksOf(k.ann, msg.id)).toStrictEqual([{ id: msg.id, state: "delivered", method: "headless" }]);
  });

  it("test_AC21_run_file_and_argv", async () => {
    const k = await dcast();
    const { id, msg, call } = await startAudit(k);
    const run = await r.runOf(k.ann, id);
    expect(run).toMatchObject({ step: id, goal: goalOf(id), state: "running", profile: { name: "propose-via-branch", base: "propose-via-branch" }, budget: { turns: 5, minutes: 30 }, agent: { name: "auditor" } });
    expect(run.sessionId).toMatch(UUID);
    expect(typeof run.pid).toBe("number");
    expect(typeof run.startId).toBe("string");
    expect(typeof run.startedAt).toBe("number");
    expect(run.profile.sha256).toBe(msg.data.profile.sha256);
    const dir = r.runDir(k.ann, run);
    expect(r.calls(id)).toHaveLength(1);
    expect(call.argv).toStrictEqual([
      "-p",
      PROMPT(id, "Audit it"),
      "--output-format",
      "stream-json",
      "--verbose",
      "--session-id",
      run.sessionId,
      "--max-turns",
      "6",
      "--setting-sources",
      "user",
      "--settings",
      join(dir, "profile.json"),
      "--permission-mode",
      "default",
      "--strict-mcp-config",
      "--mcp-config",
      join(dir, "mcp.json"),
      "--agents",
      join(dir, "agents.json"),
      "--agent",
      "auditor",
    ]);
    expect(realpathSync(call.bin)).toBe(realpathSync(join(import.meta.dirname, "fixtures", "claude", "fake-claude", "claude")));
    for (const f of ["--model", "--bg", "--bare", "--dangerously-skip-permissions", "--max-budget-usd"]) expect(call.argv, f).not.toContain(f);
    // test_AC21_cwd_env
    expect(call.cwd).toBe(realpathSync(join(dir, "worktree")));
    expect(git(call.cwd, ["rev-parse", "HEAD"])).toBe(git(k.ann.repoDir, ["rev-parse", "HEAD"]));
    const wt = git(k.ann.repoDir, ["worktree", "list", "--porcelain"]);
    const block = wt.split("\n\n").find((b) => b.includes(join(dir, "worktree")) || b.includes(call.cwd));
    expect(block, wt).toBeDefined();
    expect(block).toContain("detached");
    expect(call.env).toMatchObject({ MESH_STEP: id, MESH_RUN: run.runId });
    expect(run.baseCommit).toBe(git(k.ann.repoDir, ["rev-parse", "HEAD"]));
  });

  it("test_AC21_usd_last", async () => {
    const k = await dcast();
    const id = await headlessStep(k, { id: "spend", mode: "headless", budget: { usd: 0.5 } }, [{ waitFor: "end" }]);
    await offerAndPull(k, id);
    const call = await r.started(id);
    expect(call.argv.slice(-2)).toStrictEqual(["--max-budget-usd", "0.5"]);
    const i = call.argv.indexOf("--max-turns");
    expect(call.argv[i + 1]).toBe("31");
    expect(call.argv).not.toContain("--agents");
    expect(call.argv).not.toContain("--agent");
  });

  it("test_AC21_event_and_idempotency", async () => {
    const k = await dcast();
    const { id, msg } = await startAudit(k);
    const run = await r.runOf(k.ann, id);
    expect(await until(async () => (await r.events("run.started", id)).length === 1)).toBe(true);
    const [ev] = await r.events("run.started", id);
    expect(ev.payload).toMatchObject({ runId: run.runId, machine: r.w.machineOf(k.ann), profile: "propose-via-branch", profileHash: msg.data.profile.sha256 });
    // test_AC21_idempotency_accept
    expect(reqs(k.ann, "POST", `/v1/steps/${id}/accept`).map((q) => q.key)).toStrictEqual([`offer-${msg.id}`]);
    expect(reqs(k.ann, "POST", `/v1/steps/${id}/run`).map((q) => q.key)).toStrictEqual([`run-${run.runId}-started`]);
  });

  it("test_AC21_no_restart_on_pull", async () => {
    const k = await dcast();
    const { id } = await startAudit(k);
    await r.pull(k.ann);
    await r.pull(k.ann);
    await r.reconcile(k.ann);
    await r.reconcile(k.ann);
    await sleep(200);
    expect(r.calls(id)).toHaveLength(1);
    expect((await r.runs(k.ann)).filter((x) => x.step === id)).toHaveLength(1);
  });

  it("test_AC21_interactive_control", async () => {
    const k = await dcast();
    await r.w.hook(k.ann, "SessionStart", 1);
    await r.w.turn(k.ann, 1);
    await r.w.flush();
    const id = await headlessStep(k, { id: "plainstep" });
    await offerAndPull(k, id);
    expect(await until(() => r.w.session(k.ann, 1).step === id)).toBe(true);
    expect(r.calls(id)).toStrictEqual([]);
  });
});

// ---------------------------------------------------------------------------------------------

describe("AC-22 run directory", { timeout: 40_000 }, () => {
  async function running(k: DCast, step: PlanIn) {
    const id = await headlessStep(k, step, [{ waitFor: "end" }]);
    const msg = await offerAndPull(k, id);
    await r.started(id);
    const run = await r.runOf(k.ann, id);
    return { id, msg, run, dir: r.runDir(k.ann, run) };
  }

  it("test_AC22_profile_and_mcp_json", async () => {
    const k = await dcast();
    const { msg, dir } = await running(k, { id: "audit", mode: "headless", profile: "propose-via-branch", agent: "auditor" });
    const raw = readFileSync(join(dir, "profile.json"), "utf8");
    expect(raw).toBe(JSON.stringify(msg.data.profile.settings));
    expect(JSON.parse(raw)).toStrictEqual(msg.data.profile.settings);
    const mcp = JSON.parse(readFileSync(join(dir, "mcp.json"), "utf8"));
    expect(Object.keys(mcp.mcpServers)).toStrictEqual(["mesh"]);
    expect(mcp).toStrictEqual({ mcpServers: { mesh: { command: process.execPath, args: [join(import.meta.dirname, "..", "dist", "main.mjs"), "mcp"] } } });
  });

  it("test_AC22_agents_tools", async () => {
    const k = await dcast();
    const { dir } = await running(k, { id: "audit", mode: "headless", agent: "auditor" });
    expect(JSON.parse(readFileSync(join(dir, "agents.json"), "utf8"))).toStrictEqual({ auditor: { description: "Audits", prompt: "You audit.", tools: ["Read", "Grep", ...MESH_TOOL_RULES], model: "haiku" } });
  });

  it("test_AC22_agents_tools_list", async () => {
    const k = await dcast();
    const { dir } = await running(k, { id: "list", mode: "headless", agent: "lister" });
    const a = JSON.parse(readFileSync(join(dir, "agents.json"), "utf8"));
    expect(a.lister.tools).toStrictEqual(["Read", "mcp__mesh__mesh_done", "mcp__mesh__mesh_context", "mcp__mesh__mesh_artifact", "mcp__mesh__mesh_review"]);
  });

  it("test_AC22_agent_without_tools", async () => {
    const k = await dcast();
    const { dir } = await running(k, { id: "pl", mode: "headless", agent: "plain" });
    expect(JSON.parse(readFileSync(join(dir, "agents.json"), "utf8"))).toStrictEqual({ plain: { description: "", prompt: "You are plain." } });
  });

  it("test_AC22_agent_key_hash", async () => {
    const k = await dcast();
    const { id } = await running(k, { id: "audit", mode: "headless", agent: "auditor" });
    r.go("end");
    await r.endRun(k.ann, id);
    const [round] = await roundsOf(id);
    const lf = sha(AUDITOR.replace(/\r\n/g, "\n"));
    expect(lf).not.toBe(sha(AUDITOR));
    expect(round?.telemetry).toMatchObject({ agentKey: "svc/auditor", agentHash: lf });
  });

  it("test_AC22_missing_agent", async () => {
    const k = await dcast();
    const id = await headlessStep(k, { id: "ghost", mode: "headless", agent: "ghost" }, []);
    await offerAndPull(k, id);
    await r.reconcile(k.ann);
    expect(await until(async () => (await r.stepOf(id)).state === "failed", 5_000)).toBe(true);
    const st = await r.stepOf(id);
    expect(st.rounds.at(-1)).toMatchObject({ outcome: "fail", summary: `headless run of ${id} did not start: no agent ghost in svc/.claude/agents` });
    expect(st.rounds.at(-1).telemetry?.exit).toBe("crashed");
    expect(r.calls(id)).toStrictEqual([]);
    expect(await until(async () => (await r.runOf(k.ann, id)).state === "finished")).toBe(true);
  });
});

// ---------------------------------------------------------------------------------------------

describe("AC-23 headless declines", { timeout: 40_000 }, () => {
  it("test_AC23_not_capable", async () => {
    const k = await dcast();
    // The hub stored `headless: true` from earlier syncs; the daemon now has no runsDir.
    await r.w.restart(k.ann, {}, { headless: { noRunsDir: true } });
    await r.w.flush();
    const id = await headlessStep(k, { id: "h", mode: "headless" });
    const msg = await offerAndPull(k, id);
    expect(await until(() => acksOf(k.ann, msg.id).length > 0)).toBe(true);
    expect(acksOf(k.ann, msg.id)).toStrictEqual([{ id: msg.id, state: "delivered", method: "declined" }]);
    const st = await r.stepOf(id);
    expect(st.state).toBe("ready");
    expect(st.offer).toMatchObject({ state: "declined", note: "this machine cannot run headless steps" });
    expect(r.calls(id)).toStrictEqual([]);
  });

  it("test_AC23_no_checkout", async () => {
    const k = await dcast();
    const id = await headlessStep(k, { id: "h", mode: "headless", repo: "elsewhere" });
    const msg = await offerAndPull(k, id);
    expect(await until(() => acksOf(k.ann, msg.id).length > 0)).toBe(true);
    expect(acksOf(k.ann, msg.id)).toStrictEqual([{ id: msg.id, state: "delivered", method: "declined" }]);
    expect((await r.stepOf(id)).offer).toMatchObject({ state: "declined", note: "repo elsewhere is not on this machine" });
    expect(r.calls(id)).toStrictEqual([]);
  });

  it("test_AC23_assignments_off", async () => {
    const k = await dcast({ assignments: "off" });
    const id = await headlessStep(k, { id: "h", mode: "headless" });
    const ctl = `${goalOf(await headlessStep(k, { id: "i" }))}.i`;
    const m1 = await offerAndPull(k, id);
    const m2 = await offerAndPull(k, ctl);
    expect(await until(() => acksOf(k.ann, m1.id).length > 0 && acksOf(k.ann, m2.id).length > 0)).toBe(true);
    const a = await r.stepOf(id);
    const b = await r.stepOf(ctl);
    expect(a.offer.state).toBe("declined");
    expect(a.offer.note).toBe(b.offer.note);
    expect(acksOf(k.ann, m1.id)).toStrictEqual([{ id: m1.id, state: "delivered", method: "declined" }]);
    expect(r.calls(id)).toStrictEqual([]);
  });

  it("test_AC23_manual", async () => {
    const k = await dcast();
    const G = await r.goal(k.bob, [{ id: "h", mode: "headless" }]);
    const id = `${G}.h`;
    r.script(id, []);
    expect((await r.assign(k.bob, id, { to: "ann/hl" })).json.auto).toBe(false);
    const msg = await r.offerMsg(k.ann, id);
    await r.pull(k.ann);
    await r.reconcile(k.ann);
    expect(await until(() => acksOf(k.ann, msg.id).length > 0)).toBe(true);
    expect(acksOf(k.ann, msg.id)).toStrictEqual([{ id: msg.id, state: "delivered", method: "listed" }]);
    expect(k.ann.notes.filter((n) => n.includes(id))).toHaveLength(1);
    expect(await r.stepOf(id)).toMatchObject({ state: "ready", offer: { state: "offered" } });
    expect(r.calls(id)).toStrictEqual([]);
    expect((await r.runs(k.ann)).filter((x) => x.step === id)).toStrictEqual([]);
  });

  it("test_AC23_control", async () => {
    const k = await dcast();
    const id = await headlessStep(k, { id: "h", mode: "headless" }, [{ waitFor: "end" }]);
    await offerAndPull(k, id);
    await r.started(id);
    expect((await r.stepOf(id)).state).toBe("claimed");
  });
});

// ---------------------------------------------------------------------------------------------

describe("AC-24 headless queue", { timeout: 40_000 }, () => {
  async function live(k: DCast, pid = 1) {
    await r.w.hook(k.ann, "SessionStart", pid);
    await r.w.flush();
  }

  it("test_AC24_queued_then_starts", async () => {
    const k = await dcast({ maxSessions: 1 });
    await live(k);
    const id = await headlessStep(k, { id: "q1", mode: "headless" }, [{ waitFor: "end" }]);
    const msg = await offerAndPull(k, id);
    expect(await until(() => acksOf(k.ann, msg.id).length > 0)).toBe(true);
    expect(acksOf(k.ann, msg.id)).toStrictEqual([{ id: msg.id, state: "delivered", method: "queued" }]);
    expect((await r.stepOf(id)).state).toBe("claimed");
    expect((await r.runOf(k.ann, id)).state).toBe("queued");
    await r.reconcile(k.ann);
    await sleep(200);
    expect(r.calls(id)).toStrictEqual([]);
    // test_AC24_starts_after_session_end
    await r.w.hook(k.ann, "SessionEnd", 1);
    await r.reconcile(k.ann);
    await r.started(id);
    expect((await r.runOf(k.ann, id)).state).toBe("running");
    expect(r.calls(id)).toHaveLength(1);
    expect(acksOf(k.ann, msg.id)).toHaveLength(1);
  });

  it("test_AC24_oldest_first", async () => {
    const k = await dcast({ maxSessions: 1 });
    await live(k);
    const q2 = await headlessStep(k, { id: "q2", mode: "headless" }, [{ waitFor: "q2" }]);
    const q3 = await headlessStep(k, { id: "q3", mode: "headless" }, [{ waitFor: "q3" }]);
    await offerAndPull(k, q2);
    r.w.clock += 1000;
    await offerAndPull(k, q3);
    expect((await r.runOf(k.ann, q2)).state).toBe("queued");
    expect((await r.runOf(k.ann, q3)).state).toBe("queued");
    await r.w.hook(k.ann, "SessionEnd", 1);
    await r.reconcile(k.ann);
    await r.started(q2);
    await sleep(200);
    expect((await r.runOf(k.ann, q2)).state).toBe("running");
    expect((await r.runOf(k.ann, q3)).state).toBe("queued");
    expect(r.calls(q3)).toStrictEqual([]);
    r.go("q2");
    await r.endRun(k.ann, q2);
    await r.reconcile(k.ann);
    await r.started(q3);
    expect((await r.runOf(k.ann, q3)).state).toBe("running");
  });

  it("test_AC24_deadline_release", async () => {
    const k = await dcast({ maxSessions: 1 });
    await live(k);
    const id = await headlessStep(k, { id: "q4", mode: "headless" }, [{ waitFor: "end" }]);
    const msg = await offerAndPull(k, id);
    expect((await r.runOf(k.ann, id)).state).toBe("queued");
    // test_AC24_before_deadline_control
    r.w.clock = msg.data.deadline - 1;
    await r.reconcile(k.ann);
    expect((await r.runOf(k.ann, id)).state).toBe("queued");
    expect((await r.stepOf(id)).state).toBe("claimed");
    r.w.clock = msg.data.deadline + 1;
    await r.reconcile(k.ann);
    const run = await r.runOf(k.ann, id);
    expect(run.state).toBe("released");
    const st = await r.stepOf(id);
    expect(st.state).toBe("ready");
    expect(st.holderUser).toBeUndefined();
    const notes = await notesOf(id);
    expect(notes.some((n) => /^capacity: no free session on \S+ before the run deadline$/.test(n)), JSON.stringify(notes)).toBe(true);
    expect(r.calls(id)).toStrictEqual([]);
    expect(reqs(k.ann, "POST", `/v1/steps/${id}/release`).map((q) => q.key)).toStrictEqual([`run-${run.runId}-release`]);
  });
});

// ---------------------------------------------------------------------------------------------

describe("AC-25 close as fail", { timeout: 40_000 }, () => {
  const script = (k: DCast, wait?: string) => [{ stdout: [INIT, say("m1", "looked at it"), say("m2", `the key is ${k.ann.config.key}`)] }, ...(wait ? [{ waitFor: wait }] : []), { exit: 0 }];

  it("test_AC25_not_before_exit_then_transcript", async () => {
    const k = await dcast();
    const id = await headlessStep(k, { id: "f", mode: "headless" });
    r.script(id, script(k, "f"));
    await offerAndPull(k, id);
    await r.started(id);
    // test_AC25_not_before_exit (control: the end is triggered by the exit)
    await r.reconcile(k.ann);
    await r.reconcile(k.ann);
    expect((await r.stepOf(id)).state).toBe("claimed");
    expect(await r.artifactsOf(goalOf(id))).toStrictEqual([]);
    r.go("f");
    await r.endRun(k.ann, id);
    // test_AC25_transcript
    const ts = await transcripts(goalOf(id));
    expect(ts).toHaveLength(1);
    expect(ts[0]).toMatchObject({ kind: "transcript", mediaType: "text/plain", title: "run transcript (no_result)" });
    const content = (await r.call(k.ann, "GET", `/v1/artifacts/${ts[0].id}`)).json.content as string;
    expect(content.split("\n")[0]).toBe("Run ended: no_result");
    expect(content).toContain("looked at it");
    expect(content).toContain("[REDACTED]");
    expect(content).not.toContain(k.ann.config.key);
    for (const l of content.split("\n")) {
      let obj: boolean;
      try {
        const v: unknown = JSON.parse(l);
        obj = typeof v === "object" && v !== null && !Array.isArray(v);
      } catch {
        obj = false;
      }
      expect(obj, l).toBe(false);
    }
    // test_AC25_failed
    const run = await r.runOf(k.ann, id);
    const st = await r.stepOf(id);
    expect(st.state).toBe("failed");
    const last = st.rounds.at(-1);
    expect(last).toMatchObject({ outcome: "fail", summary: "headless run ended without mesh_done (exit no_result)" });
    expect(last.artifactIds).toStrictEqual([ts[0].id]);
    expect(last.telemetry).toMatchObject({ exit: "no_result", turnsApprox: true, profile: "read-only", profileHash: st.offer.profile.sha256, runId: run.runId, undeclaredRules: 0, redactions: 0 });
    // test_AC25_order
    const idx = (method: string, path: string) => k.ann.requests.findIndex((q) => q.method === method && q.path === path);
    const runCalls = k.ann.requests.map((q, i) => ({ ...q, i })).filter((q) => q.method === "POST" && q.path === `/v1/steps/${id}/run`);
    const up = idx("POST", `/v1/steps/${id}/artifacts`);
    const dn = idx("POST", `/v1/steps/${id}/done`);
    expect(up).toBeGreaterThanOrEqual(0);
    expect(dn).toBeGreaterThan(up);
    expect(runCalls.at(-1)?.i).toBeGreaterThan(dn);
    expect(reqs(k.ann, "POST", `/v1/steps/${id}/artifacts`).map((q) => q.key)).toStrictEqual([`run-${run.runId}-transcript`]);
    expect(reqs(k.ann, "POST", `/v1/steps/${id}/done`).map((q) => q.key)).toStrictEqual([`run-${run.runId}-done`]);
    expect(runCalls.map((q) => q.key)).toStrictEqual([`run-${run.runId}-started`, `run-${run.runId}-finished`]);
    // test_AC25_event_and_files
    const ev = await r.events("run.finished", id);
    expect(ev).toHaveLength(1);
    expect(ev[0].payload).toMatchObject({ runId: run.runId, round: 1 });
    const dir = r.runDir(k.ann, run);
    expect(existsSync(join(dir, "worktree"))).toBe(false);
    expect(git(k.ann.repoDir, ["worktree", "list", "--porcelain"])).not.toContain(join(dir, "worktree"));
    expect(existsSync(join(dir, "stream.jsonl"))).toBe(true);
    expect(run).toMatchObject({ state: "finished", exitCode: 0, exit: "no_result" });
    expect(typeof run.endedAt).toBe("number");
  });
});

// ---------------------------------------------------------------------------------------------

describe("AC-26 done by the run", { timeout: 40_000 }, () => {
  it("test_AC26_done_kept_and_complete_telemetry", async () => {
    const k = await dcast();
    const id = await headlessStep(k, { id: "d", mode: "headless" }, [{ stdout: [INIT] }, { waitFor: "done" }, { stdout: [RESULT] }, { exit: 0 }]);
    await offerAndPull(k, id);
    await r.started(id);
    await r.runSession(k.ann, id, 7);
    const a1 = await r.w.tool(k.ann, 7, "mesh_artifact" as never, { kind: "report", content: `r1 ${GHP}` });
    expect(a1.isError, a1.text).toBeFalsy();
    const a2 = await r.w.tool(k.ann, 7, "mesh_artifact" as never, { kind: "report", content: "r2" });
    expect(a2.isError, a2.text).toBeFalsy();
    const d = await r.w.tool(k.ann, 7, "mesh_done", { outcome: "done", summary: "ok" });
    expect(d.isError, d.text).toBeFalsy();
    r.go("done");
    await r.endRun(k.ann, id);
    const st = await r.stepOf(id);
    expect(st.state).toBe("done");
    expect(st.rounds).toHaveLength(1);
    expect(await transcripts(goalOf(id))).toStrictEqual([]);
    expect(reqs(k.ann, "POST", `/v1/steps/${id}/done`)).toHaveLength(1);
    // test_AC26_complete_telemetry
    const reports = (await r.artifactsOf(goalOf(id))).filter((a) => a.kind === "report");
    expect(reports.map((a) => a.redactions)).toStrictEqual([1, 0]);
    expect(st.rounds[0].artifactIds).toStrictEqual(reports.map((a) => a.id));
    expect(st.rounds[0].telemetry).toMatchObject({ exit: "success", turnsApprox: false, turns: 2, costUsdEstimate: 0.01, redactions: 1, tokensIn: 5, tokensOut: 6 });
    // test_AC26_finished_event
    const ev = await r.events("run.finished", id);
    expect(ev).toHaveLength(1);
    expect(ev[0].payload).toMatchObject({ round: 1, exit: "success", turns: 2 });
  });
});

// ---------------------------------------------------------------------------------------------

describe("AC-27 budget", { timeout: 40_000 }, () => {
  it("test_AC27_not_yet_then_killed", async () => {
    const k = await dcast();
    const id = await headlessStep(k, { id: "b", mode: "headless", budget: { minutes: 1 } }, [{ spawnChild: true }, { waitFor: "never" }]);
    await offerAndPull(k, id);
    const call = await r.started(id);
    expect(await until(() => r.childPid(id) !== undefined)).toBe(true);
    const child = r.childPid(id) as number;
    const run = await r.runOf(k.ann, id);
    // test_AC27_not_yet
    r.w.clock = run.startedAt + 59_999;
    await r.reconcile(k.ann);
    await sleep(300);
    expect(alivePid(call.pid)).toBe(true);
    expect(alivePid(child)).toBe(true);
    expect((await r.runOf(k.ann, id)).state).toBe("running");
    // test_AC27_killed
    r.w.clock = run.startedAt + 60_000;
    await r.reconcile(k.ann);
    expect(await until(() => r.exitFile(k.ann, run) !== undefined, 7_000)).toBe(true);
    await r.reconcile(k.ann);
    expect(await until(() => !alivePid(call.pid) && !alivePid(child), 7_000)).toBe(true);
    expect(await r.runOf(k.ann, id)).toMatchObject({ state: "finished", killedForBudget: true, exit: "killed_budget" });
    const st = await r.stepOf(id);
    expect(st.state).toBe("failed");
    expect(st.rounds.at(-1).telemetry.exit).toBe("killed_budget");
    expect((await transcripts(goalOf(id))).map((t) => t.title)).toStrictEqual(["run transcript (killed_budget)"]);
  });

  it("test_AC27_crashed", async () => {
    const k = await dcast();
    const id = await headlessStep(k, { id: "c", mode: "headless" }, [{ stderr: ["boom-stderr-line"] }, { exit: 3 }]);
    await offerAndPull(k, id);
    await r.started(id);
    await r.endRun(k.ann, id);
    const st = await r.stepOf(id);
    expect(st.state).toBe("failed");
    expect(st.rounds.at(-1).summary).toBe("headless run ended without mesh_done (exit crashed)");
    const [t] = await transcripts(goalOf(id));
    const content = (await r.call(k.ann, "GET", `/v1/artifacts/${t.id}`)).json.content as string;
    expect(content).toContain("--- stderr (last 20 lines) ---");
    expect(content).toContain("boom-stderr-line");
    expect(await r.runOf(k.ann, id)).toMatchObject({ exitCode: 3, exit: "crashed", state: "finished" });
  });
});

// ---------------------------------------------------------------------------------------------

describe("AC-28 push", { timeout: 40_000 }, () => {
  function bareRemote(p: Person): string {
    const bare = join(p.dir, "remote.git");
    git(p.dir, ["init", "-q", "--bare", bare]);
    git(p.repoDir, ["remote", "add", "origin", bare]);
    git(p.repoDir, ["push", "-q", "origin", "HEAD:refs/heads/main"]);
    return bare;
  }
  const meshRefs = (bare: string) => git(bare, ["for-each-ref", "--format=%(refname) %(objectname)", "refs/heads/mesh/"]);

  it("test_AC28_pushed", async () => {
    const k = await dcast();
    const bare = bareRemote(k.ann);
    const id = await headlessStep(k, { id: "fix-it", mode: "headless", profile: "propose-via-branch" }, [{ commit: true }, { exit: 0 }]);
    await offerAndPull(k, id);
    await r.started(id);
    await r.endRun(k.ann, id);
    const branch = `mesh/${slug(id)}`;
    expect(branch).toMatch(/^mesh\/g\d+-fix-it$/);
    const head = r.calls(id)[0].head as string;
    expect(head).toMatch(/^[0-9a-f]{40}$/);
    expect(meshRefs(bare)).toBe(`refs/heads/${branch} ${head}`);
    const st = await r.stepOf(id);
    expect(st.rounds.at(-1).branch).toBe(branch);
    expect(st.branch).toBe(branch);
    expect((await r.events("run.finished", id))[0]?.payload.branch).toBe(branch);
  });

  it("test_AC28_no_commit_and_readonly", async () => {
    const k = await dcast();
    const bare = bareRemote(k.ann);
    const a = await headlessStep(k, { id: "nocommit", mode: "headless", profile: "propose-via-branch" }, [{ exit: 0 }]);
    await offerAndPull(k, a);
    await r.started(a);
    await r.endRun(k.ann, a);
    const b = await headlessStep(k, { id: "ro", mode: "headless", profile: "read-only" }, [{ commit: true }, { exit: 0 }]);
    await offerAndPull(k, b);
    await r.started(b);
    await r.endRun(k.ann, b);
    expect((await r.runOf(k.ann, a)).state).toBe("finished");
    expect((await r.runOf(k.ann, b)).state).toBe("finished");
    expect(meshRefs(bare)).toBe("");
    for (const id of [a, b]) {
      const st = await r.stepOf(id);
      expect(st.branch, id).toBeUndefined();
      expect(st.rounds.at(-1).branch, id).toBeUndefined();
    }
  });

  it("test_AC28_push_failure", async () => {
    const k = await dcast();
    const id = await headlessStep(k, { id: "fix-it", mode: "headless", profile: "propose-via-branch" }, [{ commit: true }, { exit: 0 }]);
    await offerAndPull(k, id);
    await r.started(id);
    await r.endRun(k.ann, id);
    expect((await r.runOf(k.ann, id)).state).toBe("finished");
    const notes = await notesOf(id);
    expect(notes.some((n) => n.startsWith(`headless run: could not push mesh/${slug(id)}: `) && n.length > `headless run: could not push mesh/${slug(id)}: `.length), JSON.stringify(notes)).toBe(true);
    const st = await r.stepOf(id);
    expect(st.branch).toBeUndefined();
    const run = await r.runOf(k.ann, id);
    expect(reqs(k.ann, "POST", `/v1/steps/${id}/note`).map((q) => q.key)).toStrictEqual([`run-${run.runId}-note`]);
  });

  it("test_AC28_after_done", async () => {
    const k = await dcast();
    const bare = bareRemote(k.ann);
    const id = await headlessStep(k, { id: "fix-it", mode: "headless", profile: "propose-via-branch" }, [{ commit: true }, { waitFor: "done" }, { exit: 0 }]);
    await offerAndPull(k, id);
    await r.started(id);
    await r.runSession(k.ann, id, 7);
    expect((await r.w.tool(k.ann, 7, "mesh_done", { outcome: "done", summary: "fixed" })).isError).toBeFalsy();
    r.go("done");
    await r.endRun(k.ann, id);
    const branch = `mesh/${slug(id)}`;
    expect(meshRefs(bare)).toBe(`refs/heads/${branch} ${r.calls(id)[0].head}`);
    const st = await r.stepOf(id);
    expect(st.state).toBe("done");
    expect(st.rounds).toHaveLength(1);
    expect(st.rounds[0].branch).toBe(branch);
  });
});

// ---------------------------------------------------------------------------------------------

describe("AC-29 restart", { timeout: 40_000 }, () => {
  /** Every JSON file under runsDir whose content is this run's file. */
  function runFiles(p: Person, runId: string): string[] {
    const out: string[] = [];
    const walk = (d: string) => {
      for (const f of readdirSync(d)) {
        const path = join(d, f);
        if (f === "worktree") continue;
        if (statSync(path).isDirectory()) walk(path);
        else if (f.endsWith(".json")) {
          try {
            if ((JSON.parse(readFileSync(path, "utf8")) as Json).runId === runId) out.push(path);
          } catch {
            /* not a run file */
          }
        }
      }
    };
    walk(p.runsDir as string);
    return out;
  }

  it("test_AC29a_adopt", async () => {
    const k = await dcast();
    const id = await headlessStep(k, { id: "a", mode: "headless" }, [{ waitFor: "end" }]);
    await offerAndPull(k, id);
    await r.started(id);
    const before = await r.runOf(k.ann, id);
    await r.w.restart(k.ann);
    await r.reconcile(k.ann);
    await r.reconcile(k.ann);
    await sleep(200);
    expect(r.calls(id)).toHaveLength(1);
    expect(await r.runOf(k.ann, id)).toMatchObject({ state: "running", pid: before.pid });
    r.go("end");
    await r.endRun(k.ann, id);
    expect((await r.stepOf(id)).state).toBe("failed");
    expect(await transcripts(goalOf(id))).toHaveLength(1);
    expect((await r.runOf(k.ann, id)).state).toBe("finished");
  });

  it("test_AC29b_reaped", async () => {
    const k = await dcast();
    const id = await headlessStep(k, { id: "b", mode: "headless" }, [{ waitFor: "end" }]);
    await offerAndPull(k, id);
    await r.started(id);
    const run = await r.runOf(k.ann, id);
    await k.ann.daemon.stop();
    r.go("end");
    expect(await until(() => r.exitFile(k.ann, run) !== undefined, 10_000)).toBe(true);
    await r.w.restart(k.ann);
    await r.reconcile(k.ann);
    expect(await until(async () => (await r.runOf(k.ann, id)).state === "finished", 3_000)).toBe(true);
    expect((await r.runOf(k.ann, id)).exitCode).toBe(0);
    expect((await r.stepOf(id)).state).toBe("failed");
    expect(await transcripts(goalOf(id))).toHaveLength(1);
    expect(r.calls(id)).toHaveLength(1);
  });

  it("test_AC29c_pid_reused", async () => {
    const k = await dcast();
    const id = await headlessStep(k, { id: "c", mode: "headless", budget: { minutes: 1 } }, [{ waitFor: "never" }]);
    await offerAndPull(k, id);
    const call = await r.started(id);
    const run = await r.runOf(k.ann, id);
    const files = runFiles(k.ann, run.runId);
    expect(files.length, "the run file").toBeGreaterThan(0);
    await k.ann.daemon.stop();
    // The run's process dies while the daemon is down; its exit file is lost.
    process.kill(-call.pid, "SIGKILL");
    expect(await until(() => r.exitFile(k.ann, run) !== undefined, 7_000)).toBe(true);
    rmSync(join(r.runDir(k.ann, run), "exit"));
    // Its pid now names an unrelated live process with another identity.
    const sleeper = r.liveSleep();
    for (const f of files) {
      const j = JSON.parse(readFileSync(f, "utf8")) as Json;
      writeFileSync(f, JSON.stringify({ ...j, pid: sleeper, startId: "other", startedAt: r.w.clock - 2 * 86_400_000 }));
    }
    await r.w.restart(k.ann);
    await r.reconcile(k.ann);
    expect(await until(async () => (await r.runOf(k.ann, id)).state === "finished", 3_000)).toBe(true);
    const after = await r.runOf(k.ann, id);
    expect(after.exit).toBe("crashed");
    expect("exitCode" in after).toBe(false);
    expect((await r.stepOf(id)).state).toBe("failed");
    await sleep(300);
    expect(alivePid(sleeper)).toBe(true);
  });

  it("test_AC29d_queued", async () => {
    const k = await dcast({ maxSessions: 1 });
    await r.w.hook(k.ann, "SessionStart", 1);
    await r.w.flush();
    const id = await headlessStep(k, { id: "d", mode: "headless" }, [{ waitFor: "end" }]);
    await offerAndPull(k, id);
    expect((await r.runOf(k.ann, id)).state).toBe("queued");
    await r.w.restart(k.ann);
    await r.reconcile(k.ann);
    await sleep(200);
    expect((await r.runOf(k.ann, id)).state).toBe("queued");
    expect(r.calls(id)).toStrictEqual([]);
    await r.w.hook(k.ann, "SessionEnd", 1);
    await r.reconcile(k.ann);
    await r.started(id);
    await r.reconcile(k.ann);
    await sleep(200);
    expect(r.calls(id)).toHaveLength(1);
  });

  it("test_AC29e_left_alone", async () => {
    const k = await dcast({ maxSessions: 1 });
    await r.w.hook(k.ann, "SessionStart", 1);
    await r.w.flush();
    const rel = await headlessStep(k, { id: "rel", mode: "headless" }, []);
    const msg = await offerAndPull(k, rel);
    r.w.clock = msg.data.deadline + 1;
    await r.reconcile(k.ann);
    expect((await r.runOf(k.ann, rel)).state).toBe("released");
    await r.w.hook(k.ann, "SessionEnd", 1);
    await r.reconcile(k.ann);
    const fin = await headlessStep(k, { id: "fin", mode: "headless" }, [{ exit: 0 }]);
    await offerAndPull(k, fin);
    await r.started(fin);
    await r.endRun(k.ann, fin);
    expect((await r.runOf(k.ann, fin)).state).toBe("finished");
    const ids = [(await r.runOf(k.ann, rel)).runId as string, (await r.runOf(k.ann, fin)).runId as string];
    const snap = () => ids.flatMap((x) => runFiles(k.ann, x)).map((f) => [f, readFileSync(f, "utf8")]);
    const before = snap();
    expect(before.length).toBeGreaterThanOrEqual(2);
    const mark = k.ann.requests.length;
    await r.w.restart(k.ann);
    await r.reconcile(k.ann);
    await r.reconcile(k.ann);
    expect(snap()).toStrictEqual(before);
    expect(k.ann.requests.slice(mark).filter((q) => ids.some((x) => q.key?.startsWith(`run-${x}-`)))).toStrictEqual([]);
    expect(r.calls(rel)).toStrictEqual([]);
    expect(r.calls(fin)).toHaveLength(1);
  });

  it("test_AC29f_stop_keeps_run", async () => {
    const k = await dcast();
    const id = await headlessStep(k, { id: "f", mode: "headless" }, [{ waitFor: "end" }]);
    await offerAndPull(k, id);
    const call = await r.started(id);
    const run = await r.runOf(k.ann, id);
    await k.ann.daemon.stop();
    await sleep(500);
    expect(alivePid(call.pid)).toBe(true);
    expect(r.exitFile(k.ann, run)).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------------------------

describe("AC-36 offline done", { timeout: 40_000 }, () => {
  async function offlineRun(withDone: boolean) {
    const k = await dcast();
    const id = await headlessStep(k, { id: "o", mode: "headless" }, [{ stdout: [INIT] }, { waitFor: "exit" }, { exit: 0 }]);
    await offerAndPull(k, id);
    await r.started(id);
    const run = await r.runSession(k.ann, id, 7);
    k.ann.offline = true;
    if (withDone) {
      const d = await r.w.tool(k.ann, 7, "mesh_done", { outcome: "done", summary: "ok" });
      expect(d.isError, d.text).toBeFalsy();
    }
    r.go("exit");
    expect(await until(() => r.exitFile(k.ann, run) !== undefined, 10_000)).toBe(true);
    await r.reconcile(k.ann);
    const waiting = await r.runOf(k.ann, id);
    expect(waiting.state).toBe("running");
    expect(typeof waiting.endedAt).toBe("number");
    const mark = k.ann.requests.length;
    k.ann.offline = false;
    await r.reconcile(k.ann);
    await r.reconcile(k.ann);
    return { k, id, run, mark };
  }

  it("test_AC36_replayed_first", async () => {
    const { k, id, run, mark } = await offlineRun(true);
    const after = k.ann.requests.slice(mark);
    const dn = after.findIndex((q) => q.method === "POST" && q.path === `/v1/steps/${id}/done`);
    const get = after.findIndex((q) => q.method === "GET" && q.path === `/v1/steps/${id}`);
    expect(dn).toBeGreaterThanOrEqual(0);
    if (get >= 0) expect(dn).toBeLessThan(get);
    const st = await r.stepOf(id);
    expect(st.state).toBe("done");
    expect(st.rounds).toHaveLength(1);
    expect(st.rounds[0].sid).toBe(r.w.session(k.ann, 7).sid);
    expect(await transcripts(goalOf(id))).toStrictEqual([]);
    expect(st.rounds[0].telemetry).toMatchObject({ exit: "no_result", runId: run.runId });
    expect((await r.runOf(k.ann, id)).state).toBe("finished");
  });

  it("test_AC36_control_without_done", async () => {
    const { id } = await offlineRun(false);
    expect((await r.stepOf(id)).state).toBe("failed");
    expect(await transcripts(goalOf(id))).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------------------------

describe("AC-37 run idempotency", { timeout: 40_000 }, () => {
  const closeScript = [{ stdout: [INIT, say("m1", "hello")] }, { waitFor: "end" }, { exit: 0 }];

  it("test_AC37_keys", async () => {
    const k = await dcast();
    const id = await headlessStep(k, { id: "k", mode: "headless" }, closeScript);
    const msg = await offerAndPull(k, id);
    await r.started(id);
    r.go("end");
    await r.endRun(k.ann, id);
    const run = await r.runOf(k.ann, id);
    const keys = k.ann.requests.filter((q) => q.path.startsWith(`/v1/steps/${id}/`) && q.method === "POST").map((q) => `${q.path.split("/").pop()} ${q.key}`);
    expect(keys).toStrictEqual([`accept offer-${msg.id}`, `run run-${run.runId}-started`, `artifacts run-${run.runId}-transcript`, `done run-${run.runId}-done`, `run run-${run.runId}-finished`]);
  });

  it("test_AC37_lost_replies", async () => {
    const k = await dcast();
    const id = await headlessStep(k, { id: "l", mode: "headless" }, closeScript);
    await offerAndPull(k, id);
    await r.started(id);
    k.ann.dropReplyOnce(/\/artifacts$/);
    k.ann.dropReplyOnce(/\/done$/);
    k.ann.dropReplyOnce(/\/run$/);
    r.go("end");
    await r.endRun(k.ann, id);
    for (let i = 0; i < 3; i++) await r.reconcile(k.ann);
    const run = await r.runOf(k.ann, id);
    expect(run.state).toBe("finished");
    expect(await transcripts(goalOf(id))).toHaveLength(1);
    const st = await r.stepOf(id);
    expect(st.rounds).toHaveLength(1);
    expect(st.rounds[0].outcome).toBe("fail");
    expect(await r.events("run.finished", id)).toHaveLength(1);
    for (const [path, key] of [
      [`/v1/steps/${id}/artifacts`, `run-${run.runId}-transcript`],
      [`/v1/steps/${id}/done`, `run-${run.runId}-done`],
    ] as const) {
      const sent = reqs(k.ann, "POST", path);
      expect(sent.length, path).toBeGreaterThanOrEqual(2);
      expect(new Set(sent.map((q) => q.key)), path).toStrictEqual(new Set([key]));
    }
    const fin = reqs(k.ann, "POST", `/v1/steps/${id}/run`).filter((q) => q.key === `run-${run.runId}-finished`);
    expect(fin.length).toBeGreaterThanOrEqual(2);
  });

  it("test_AC37_started_once", async () => {
    const k = await dcast();
    const id = await headlessStep(k, { id: "s", mode: "headless" }, [{ waitFor: "end" }]);
    k.ann.dropReplyOnce(/\/run$/);
    await offerAndPull(k, id);
    await r.started(id);
    await r.reconcile(k.ann);
    await r.reconcile(k.ann);
    const run = await r.runOf(k.ann, id);
    expect(reqs(k.ann, "POST", `/v1/steps/${id}/run`).filter((q) => q.key === `run-${run.runId}-started`)).toHaveLength(2);
    expect(await r.events("run.started", id)).toHaveLength(1);
  });

  it("test_AC37_5xx_retry", async () => {
    const k = await dcast();
    const id = await headlessStep(k, { id: "x", mode: "headless" }, closeScript);
    await offerAndPull(k, id);
    await r.started(id);
    k.ann.failOnce(/\/done$/, 503);
    r.go("end");
    await r.endRun(k.ann, id);
    await r.reconcile(k.ann);
    await r.reconcile(k.ann);
    const st = await r.stepOf(id);
    expect(st.state).toBe("failed");
    expect(st.rounds).toHaveLength(1);
    expect(await transcripts(goalOf(id))).toHaveLength(1);
    expect((await r.runOf(k.ann, id)).state).toBe("finished");
  });
});

// ---------------------------------------------------------------------------------------------

describe("AC-38 taken over", { timeout: 40_000 }, () => {
  async function pausedRun(k: DCast) {
    const bare = join(k.ann.dir, "remote.git");
    git(k.ann.dir, ["init", "-q", "--bare", bare]);
    git(k.ann.repoDir, ["remote", "add", "origin", bare]);
    const id = await headlessStep(k, { id: "t", mode: "headless", profile: "propose-via-branch" }, [{ commit: true }, { waitFor: "end" }, { exit: 0 }]);
    await offerAndPull(k, id);
    await r.started(id);
    k.ann.offline = true;
    r.w.clock += r.w.hubConfig.thresholds.machineOfflineMs + 1;
    await r.w.tick();
    expect((await r.stepOf(id)).state).toBe("paused");
    k.ann.offline = false;
    await r.w.flush();
    return { id, bare };
  }
  async function expectLeftAlone(k: DCast, id: string, bare: string, holderSid: string, holderUser: string) {
    r.go("end");
    await r.endRun(k.ann, id);
    expect(await transcripts(goalOf(id))).toStrictEqual([]);
    expect(reqs(k.ann, "POST", `/v1/steps/${id}/done`)).toStrictEqual([]);
    const st = await r.stepOf(id);
    expect(st).toMatchObject({ state: "claimed", holderSid, holderUser });
    expect(st.rounds ?? []).toStrictEqual([]);
    const ev = await r.events("run.finished", id);
    expect(ev).toHaveLength(1);
    expect("round" in ev[0].payload).toBe(false);
    expect(git(bare, ["for-each-ref", "refs/heads/mesh/"])).toBe("");
    expect((await r.runOf(k.ann, id)).state).toBe("finished");
  }

  it("test_AC38_same_user_other_session", async () => {
    const k = await dcast();
    const { id, bare } = await pausedRun(k);
    const ann2 = await r.w.person("ann", "svc", { hostname: "ann-two" });
    await r.w.hook(ann2, "SessionStart", 9);
    const c = await r.w.tool(ann2, 9, "mesh_claim", { step: id });
    expect(c.isError, c.text).toBeFalsy();
    await r.w.flush();
    await expectLeftAlone(k, id, bare, r.w.session(ann2, 9).sid, "ann");
  });

  it("test_AC38_same_machine_other_session", async () => {
    const k = await dcast();
    const { id, bare } = await pausedRun(k);
    await r.w.hook(k.ann, "SessionStart", 9);
    const c = await r.w.tool(k.ann, 9, "mesh_claim", { step: id });
    expect(c.isError, c.text).toBeFalsy();
    await r.w.flush();
    const run = await r.runOf(k.ann, id);
    expect(r.w.session(k.ann, 9).sid).not.toBe(run.sessionId);
    await expectLeftAlone(k, id, bare, r.w.session(k.ann, 9).sid, "ann");
  });

  it("test_AC38_other_user", async () => {
    const k = await dcast();
    const { id, bare } = await pausedRun(k);
    await r.w.hook(k.bob, "SessionStart", 9);
    await r.w.flush();
    r.w.clock += r.w.hubConfig.thresholds.takeoverAfterMs + 1;
    const sid = r.w.session(k.bob, 9).sid;
    let t = await r.act(k.bob, id, "take", { sid });
    if (t.status !== 200) t = await r.act(k.bob, id, "claim", { sid });
    expect(t.status, JSON.stringify(t.json)).toBe(200);
    await expectLeftAlone(k, id, bare, sid, "bob");
  });

  it("test_AC38_4xx_final", async () => {
    const k = await dcast();
    const id = await headlessStep(k, { id: "t", mode: "headless" }, [{ stdout: [INIT] }, { waitFor: "end" }, { exit: 0 }]);
    await offerAndPull(k, id);
    await r.started(id);
    const run = await r.runOf(k.ann, id);
    let open!: () => void;
    k.ann.hold = { path: /\/artifacts$/, until: new Promise<void>((ok) => (open = ok)) };
    r.go("end");
    expect(await until(() => r.exitFile(k.ann, run) !== undefined, 10_000)).toBe(true);
    const rec = r.reconcile(k.ann);
    expect(await until(() => reqs(k.ann, "POST", `/v1/steps/${id}/artifacts`).length === 1, 5_000)).toBe(true);
    const rel = await r.act(k.ann, id, "release", { note: "taking it back" });
    expect(rel.status, JSON.stringify(rel.json)).toBe(200);
    open();
    await rec;
    k.ann.hold = undefined;
    expect(k.ann.logs.some((l) => l.startsWith(`run ${run.runId}: POST /v1/steps/${id}/artifacts refused by the hub: `)), k.ann.logs.join("\n")).toBe(true);
    expect((await r.runOf(k.ann, id)).state).toBe("finished");
    await r.reconcile(k.ann);
    expect(reqs(k.ann, "POST", `/v1/steps/${id}/artifacts`)).toHaveLength(1);
    expect(await transcripts(goalOf(id))).toStrictEqual([]);
  });

  it("test_AC38_offline_retried", async () => {
    const k = await dcast();
    const id = await headlessStep(k, { id: "t", mode: "headless" }, [{ waitFor: "end" }, { exit: 0 }]);
    await offerAndPull(k, id);
    await r.started(id);
    const run = await r.runOf(k.ann, id);
    k.ann.offline = true;
    r.go("end");
    expect(await until(() => r.exitFile(k.ann, run) !== undefined, 10_000)).toBe(true);
    await r.reconcile(k.ann);
    await r.reconcile(k.ann);
    const w1 = await r.runOf(k.ann, id);
    expect(w1.state).toBe("running");
    expect(typeof w1.endedAt).toBe("number");
    k.ann.offline = false;
    await r.reconcile(k.ann);
    expect((await r.runOf(k.ann, id)).state).toBe("finished");
    expect((await r.stepOf(id)).state).toBe("failed");
  });
});

// ---------------------------------------------------------------------------------------------

describe("AC-39 run inbox", { timeout: 40_000 }, () => {
  it("test_AC39_no_delivery_to_the_run", async () => {
    // Share level `me`: the hub lists ann's session without a step (pid 8), so a say from ann's
    // other login can reach it (under the default `steps` the hub knows step holders only).
    const k = await dcast({ share: "me" });
    const id = await headlessStep(k, { id: "i", mode: "headless" }, [{ waitFor: "end" }]);
    await offerAndPull(k, id);
    await r.started(id);
    const run = await r.runSession(k.ann, id, 7);
    await r.w.hook(k.ann, "SessionStart", 8);
    await r.w.flush();
    const s7 = r.w.session(k.ann, 7).sid;
    const s8 = r.w.session(k.ann, 8).sid;
    // A say naming the run's session: the hub may queue it (201) or not list that session as live
    // (404, nothing queued). Either way no text may reach the run; a queued one must stay in the inbox.
    const toRun = await r.call(k.self, "POST", "/v1/messages", { toSid: s7, text: "ping-X to the run" });
    expect([201, 404], JSON.stringify(toRun.json)).toContain(toRun.status);
    const queuedForRun = toRun.status === 201;
    // The same say through this machine's own daemon (`mesh say <session>` on the machine).
    const localToRun = await r.local(k.ann, "POST", "/local/say", { target: s7, text: "ping-Z to the run" });
    expect(localToRun.json?.message?.state, JSON.stringify(localToRun.json)).not.toBe("delivered");
    const toPerson = await r.call(k.self, "POST", "/v1/messages", { toSid: s8, text: "ping-Y to the person" });
    expect(toPerson.status, JSON.stringify(toPerson.json)).toBe(201);
    await r.pull(k.ann);
    // test_AC39_no_stop_reply
    await r.w.hook(k.ann, "UserPromptSubmit", 7, { session_id: run.sessionId, prompt: "work" });
    const reply = await r.w.hook(k.ann, "Stop", 7, { session_id: run.sessionId, stop_hook_active: false, last_assistant_message: "x" });
    expect(JSON.stringify(reply ?? {})).not.toContain("ping-X");
    expect(JSON.stringify(reply ?? {})).not.toContain("ping-Z");
    k.ann.agents = [
      { kind: "interactive", pid: 7, cwd: join(r.runDir(k.ann, run), "worktree"), sessionId: run.sessionId, status: "idle" },
      { kind: "interactive", pid: 8, cwd: k.ann.repoDir, sessionId: "claude-8", status: "idle" },
    ] as never;
    for (const dt of [0, 10 * 60_000, 60 * 60_000, 4 * 3_600_000]) {
      r.w.clock += dt;
      await r.reconcile(k.ann);
      await k.ann.daemon.deliverPending();
    }
    expect(k.ann.pastes.filter((p) => p.pane === "%7")).toStrictEqual([]);
    expect(k.ann.pastes.filter((p) => p.text.includes("ping-X") || p.text.includes("ping-Z"))).toStrictEqual([]);
    expect(k.ann.notes.filter((n) => n.includes(s7) || n.includes("ping-X") || n.includes("ping-Z"))).toStrictEqual([]);
    // test_AC39_interactive_control: the person's session gets its message.
    const r8 = await r.w.hook(k.ann, "Stop", 8, { stop_hook_active: false, last_assistant_message: "y" });
    const delivered = JSON.stringify(r8 ?? {}).includes("ping-Y") || k.ann.pastes.some((p) => p.pane === "%8" && p.text.includes("ping-Y"));
    expect(delivered).toBe(true);
    // test_AC39_kept_in_inbox
    r.go("end");
    await r.endRun(k.ann, id);
    const pending = k.ann.store.pendingMessages(s7).map((m) => m.text);
    const hubInbox = (await r.inboxOf(k.ann)).map((m) => String(m.text));
    if (queuedForRun) expect(pending.some((t) => t.includes("ping-X")) || hubInbox.some((t) => t.includes("ping-X"))).toBe(true);
    // The local say is queued on this machine whatever the hub answered: it stays in the run's inbox.
    expect(pending.some((t) => t.includes("ping-Z")), JSON.stringify(pending)).toBe(true);
  });

  it("test_AC39_held_message_delivered_after_the_run", async () => {
    // Diff review round 2 S8/B1: a message held for over an hour while the run ran is delivered once
    // the run has ended and its session is alive again (a hook after the end, as `claude --resume`
    // gives); it is not failed for the time it waited during the run.
    const k = await dcast();
    // A 4-hour budget, so the run is not stopped while the clock moves on.
    const id = await headlessStep(k, { id: "i", mode: "headless", budget: { minutes: 240 } }, [{ waitFor: "end" }]);
    await offerAndPull(k, id);
    await r.started(id);
    const run = await r.runSession(k.ann, id, 7);
    const s7 = r.w.session(k.ann, 7).sid;
    const say = await r.local(k.ann, "POST", "/local/say", { target: s7, text: "ping-H held for the run" });
    const mid = Number(say.json?.message?.id);
    expect(Number.isInteger(mid), JSON.stringify(say.json)).toBe(true);
    k.ann.agents = [{ kind: "interactive", pid: 7, cwd: join(r.runDir(k.ann, run), "worktree"), sessionId: run.sessionId, status: "idle" }] as never;
    for (const dt of [0, 30 * 60_000, 60 * 60_000]) {
      r.w.clock += dt;
      await r.reconcile(k.ann);
      await k.ann.daemon.deliverPending();
    }
    expect(k.ann.store.message(mid)?.state, "held while the run runs").toBe("pending");
    r.go("end");
    await r.endRun(k.ann, id);
    expect(r.w.session(k.ann, 7).state, "the run's session is still alive").not.toBe("ended");
    await k.ann.daemon.deliverPending();
    expect(k.ann.store.message(mid)?.state, "not failed for its age").toBe("pending");
    r.w.clock += 60_000;
    const stop = await r.w.hook(k.ann, "Stop", 7, { session_id: run.sessionId, stop_hook_active: false, last_assistant_message: "z" });
    const m = k.ann.store.message(mid);
    expect(m?.state, JSON.stringify(m)).toBe("delivered");
    const got = JSON.stringify(stop ?? {}).includes("ping-H") || k.ann.pastes.some((p) => p.text.includes("ping-H"));
    expect(got).toBe(true);
  });
});
