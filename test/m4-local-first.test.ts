// M4 local-first (docs/analysis/2026-11-04-local-first-and-workflow-capture.md §5):
//   T2 offline continuity: held step keeps working, records written locally, synced once on return
//   T3 Solo: a complete goal on the daemon's local hub, no team hub at all
//   T4 conflict: a result made offline that the hub refuses is kept (note + local record)
//   workflow capture: subagent hooks + Claude Code's files → pending records → mesh ledger stage
//   T5 is in src/core/agent-ledger.test.ts and src/claude/workflow.test.ts

import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parse } from "yaml";
import { scanWorkflowRuns } from "../src/claude/index.ts";
import { exportLedger, stage } from "../src/cli/ledger.ts";
import { buildHubConfig, startHub, type RunningHub } from "../src/hub/index.ts";
import { LedgerLine, LedgerRecord, type Credentials } from "../src/protocol/index.ts";
import { HubStore } from "../src/store/index.ts";
import { World, type Person } from "./helpers/world.ts";

let w: World;
let alice: Person;
let bob: Person;

beforeEach(async () => {
  w = new World();
  await w.start(["alice", "bob"]);
  alice = await w.person("alice", "frr-dplane-ovs");
  bob = await w.person("bob", "vpc-node-agent");
});
afterEach(() => w.stop());

const front = (text: string) => parse(text.split("---\n")[1] ?? "") as Record<string, unknown>;

async function goalWithSteps(owner: Person, steps: { id: string; repo: string }[]): Promise<string> {
  const g = await w.api(owner, "POST", "/v1/goals", { title: "offline work", primaryRepo: steps[0]?.repo });
  const id = g.json.id as string;
  const r = await w.api(owner, "POST", `/v1/goals/${id}/plan`, { approve: true, steps: steps.map((s) => ({ ...s, kind: "implement", title: s.id, brief: `do ${s.id}` })) });
  expect(r.status).toBe(201);
  return id;
}

describe("T2: offline continuity", () => {
  it("keeps a held step working while the hub is away, then syncs once", async () => {
    const G = await goalWithSteps(alice, [{ id: "a", repo: "frr-dplane-ovs" }]);
    w.hook(alice, "SessionStart", 100, { model: "claude-opus-5-5" });
    expect((await w.tool(alice, 100, "mesh_claim", { step: `${G}.a` })).text).toContain("do a");
    w.turn(alice, 100, "working");
    await w.flush();

    await w.stopHub();
    const t0 = Date.now();
    const ctx = await w.tool(alice, 100, "mesh_context");
    expect(ctx.isError).toBeFalsy();
    expect(ctx.text).toContain("do a");
    expect(ctx.text).toContain("the hub is offline");
    const t1 = Date.now();
    expect((await w.tool(alice, 100, "mesh_note", { text: "half way, offline" })).text).toContain("Noted locally");
    expect(Date.now() - t1).toBeLessThan(200);
    expect(t1 - t0).toBeLessThan(2_000);

    w.turn(alice, 100, "more work");
    const claimOther = await w.tool(alice, 100, "mesh_next");
    expect(claimOther.isError).toBe(true);
    expect(claimOther.text).toMatch(/offline.*keep working on the step you hold/s);

    w.clock += 60_000;
    const doneAt = w.clock;
    const done = await w.tool(alice, 100, "mesh_done", { summary: "done while offline", model: "claude-opus-5-5" });
    expect(done.text).toContain("recorded");
    expect(done.text).toContain("locally");
    const recPath = join(alice.repoDir, `.mesh/goals/${G}/steps/a.md`);
    const local = readFileSync(recPath, "utf8");
    expect(local).toContain("recorded_offline: true");
    const lf = front(local);
    expect(lf).toMatchObject({ schema: "mesh.ledger.v1", record: "step", outcome: "done", turns: 2 });
    expect((lf.rounds as { model: string }[])[0]?.model).toBe("claude-opus-5-5");
    expect(w.session(alice, 100).step).toBeUndefined();
    expect(alice.daemon.status()).toMatchObject({ hub: "offline", queued: 2 });

    await w.startHubAgain();
    // Background probes (backing off up to a minute) find the hub again.
    for (let i = 0; i < 3 && alice.daemon.status().hub !== "ok"; i++) {
      w.clock += 61_000;
      await alice.daemon.link?.flush();
    }
    expect(alice.daemon.status()).toMatchObject({ hub: "ok", queued: 0, outbox: 0 });
    const view = (await w.api(alice, "GET", `/v1/steps/${G}.a`)).json;
    expect(view.context.step).toMatchObject({ state: "done", summary: "done while offline" });
    expect(view.context.step.rounds[0]).toMatchObject({ n: 1, model: "claude-opus-5-5", finishedAt: doneAt });
    expect(view.context.notes.map((n: { text: string }) => n.text)).toEqual(["half way, offline"]);
    expect(view.facts).toMatchObject({ turns: 2 });
    // The hub's fuller record replaced the local one.
    expect(readFileSync(recPath, "utf8")).not.toContain("recorded_offline");

    await alice.daemon.link?.flush();
    expect((await w.api(alice, "GET", `/v1/steps/${G}.a`)).json.context.notes).toHaveLength(1);
  });
});

describe("T4: a result made offline that the hub refuses", () => {
  it("keeps both: a note on the step and the local record", async () => {
    const G = await goalWithSteps(bob, [{ id: "a", repo: "frr-dplane-ovs" }]);
    w.hook(alice, "SessionStart", 100);
    await w.tool(alice, 100, "mesh_claim", { step: `${G}.a` });
    await w.flush();

    alice.offline = true;
    // Bob owns the goal and takes the step over while Alice can't reach the hub.
    expect((await w.api(bob, "POST", `/v1/steps/${G}.a/take`, {})).status).toBe(200);
    const done = await w.tool(alice, 100, "mesh_done", { summary: "my offline result" });
    expect(done.text).toContain("locally");
    expect(existsSync(join(alice.repoDir, `.mesh/goals/${G}/steps/a.md`))).toBe(true);

    alice.offline = false;
    for (let i = 0; i < 3 && alice.daemon.status().hub !== "ok"; i++) {
      w.clock += 61_000;
      await alice.daemon.link?.flush();
    }
    for (let i = 0; i < 20; i++) {
      const notes = (await w.api(bob, "GET", `/v1/steps/${G}.a/context`)).json.notes as { text: string }[];
      if (notes.some((n) => n.text.includes("refused"))) break;
      await new Promise((r) => setTimeout(r, 25));
    }
    const ctx = (await w.api(bob, "GET", `/v1/steps/${G}.a/context`)).json;
    expect(ctx.step).toMatchObject({ state: "claimed", holderUser: "bob" });
    expect(ctx.notes.map((n: { text: string }) => n.text).join()).toMatch(/Result recorded offline and refused by the hub .*my offline result/);
    expect(alice.notes.join()).toContain("refused by the hub");
    expect(alice.daemon.status().queued).toBe(0);
  });
});

describe("T3: Solo", () => {
  let solo: RunningHub;
  let soloCreds: Credentials;
  beforeEach(async () => {
    const config = buildHubConfig({ listen: "127.0.0.1:0", db: ":memory:", auth: { providers: [{ id: "local", kind: "none", user: "carol" }], bootstrap_admins: ["local:carol"] } }, { baseDir: "/", env: {} });
    solo = await startHub(config, { store: await HubStore.open(":memory:"), tickMs: 0, now: () => w.clock });
    const login = await solo.svc.loginDirect("local", { client: "cli", hostname: "carol-laptop" });
    soloCreds = { hub: solo.url, token: login.token, user: login.user, ...(login.machine ? { machine: login.machine } : {}) };
  });
  afterEach(() => solo.stop());

  it("runs a whole goal on the local hub with no team hub", async () => {
    const carol = await w.person("carol-solo", "solo-repo", { solo: soloCreds });
    expect(existsSync(carol.credentialsPath)).toBe(false);
    expect(carol.daemon.status()).toMatchObject({ mode: "solo", hub: "ok", user: "carol" });
    const call = (method: "GET" | "POST", path: string, body?: unknown) =>
      fetch(solo.url + path, { method, headers: { "content-type": "application/json", authorization: `Bearer ${soloCreds.token}` }, ...(body ? { body: JSON.stringify(body) } : {}) }).then((r) => r.json() as Promise<Record<string, unknown>>);
    const g = await call("POST", "/v1/goals", { title: "solo goal", primaryRepo: "solo-repo", refs: { spec: "900" } });
    const G = g.id as string;

    w.hook(carol, "SessionStart", 300, { model: "claude-haiku-5-5" });
    expect((await w.tool(carol, 300, "mesh_claim", { step: `${G}.design` })).text).toContain("Design");
    const p = await w.tool(carol, 300, "mesh_plan", { goal: G, steps: [{ id: "x", repo: "solo-repo", kind: "implement", title: "x", brief: "do x" }] });
    expect(p.text).toContain("Plan v1");
    await call("POST", `/v1/goals/${G}/approve`, {});
    await carol.daemon.link?.pullInbox();
    for (let i = 0; i < 40 && !existsSync(join(carol.repoDir, `.mesh/goals/${G}/steps/design.md`)); i++) await new Promise((r) => setTimeout(r, 25));
    expect(front(readFileSync(join(carol.repoDir, `.mesh/goals/${G}/steps/design.md`), "utf8"))).toMatchObject({ record: "step", kind: "design", outcome: "done" });

    await w.tool(carol, 300, "mesh_claim", { step: `${G}.x` });
    w.turn(carol, 300, "doing x");
    await carol.daemon.link?.flush();
    const done = await w.tool(carol, 300, "mesh_done", { summary: "x done", artifacts: ["README.md"] });
    expect(done.text).toContain(`Goal ${G} is done.`);
    const goalYaml = parse(readFileSync(join(carol.repoDir, `.mesh/goals/${G}/goal.yaml`), "utf8")) as Record<string, unknown>;
    expect(goalYaml).toMatchObject({ schema: "mesh.ledger.v1", record: "goal", state: "done", refs: { spec: "900" } });
    expect(goalYaml.rollup).toMatchObject({ steps: 2, done: 2, people: ["carol"] });
    const rec = front(readFileSync(join(carol.repoDir, `.mesh/goals/${G}/steps/x.md`), "utf8"));
    expect(rec).toMatchObject({ turns: 1, segments: [expect.objectContaining({ model: "claude-haiku-5-5", claude_code: "2.1.318", harness: expect.objectContaining({ hash: "h0" }) })] });
  });
});

describe("workflow capture", () => {
  const FIX = join(import.meta.dirname, "fixtures/claude/workflow");
  let home: string;
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "mesh-claude-home-"));
    cpSync(FIX, home, { recursive: true });
  });
  afterEach(() => rmSync(home, { recursive: true, force: true }));
  const sessionDir = () => join(home, "projects/-work-repo/77bcebc0-c12b-4e38-9074-6154e5d8f697");
  const transcript = (id: string) => join(sessionDir(), "subagents/workflows/wf_1e81d3e1-027", `agent-${id}.jsonl`);

  it("turns subagent hooks and Claude Code's files into pending records, staged into the tree", async () => {
    w.hook(alice, "SessionStart", 100);
    const sub = (kind: "SubagentStart" | "SubagentStop", id: string, type: string) =>
      alice.daemon.handleHook(kind, { session_id: "claude-100", cwd: alice.repoDir, hook_event_name: kind, agent_id: id, agent_type: type, ...(kind === "SubagentStop" ? { agent_transcript_path: transcript(id) } : {}) }, {});
    sub("SubagentStart", "a565ba12294ed8700", "spec-writer");
    w.clock += 70_000;
    sub("SubagentStop", "a565ba12294ed8700", "spec-writer");
    sub("SubagentStart", "ad3d5cc636df29ba5", "reviewer");
    w.clock += 30_000;
    sub("SubagentStop", "ad3d5cc636df29ba5", "reviewer");
    // A subagent never changes its session's state.
    expect(w.session(alice, 100).state).toBe("idle");

    const pending = join(alice.repoDir, ".git", "mesh", "pending", "ROW-42");
    expect(readdirSync(pending).sort()).toEqual(["reviewer.md", "spec-writer.md"]);
    const rev = front(readFileSync(join(pending, "reviewer.md"), "utf8"));
    expect(LedgerRecord.safeParse(rev).success).toBe(true);
    expect(rev).toMatchObject({ record: "agent-step", key: "ROW-42", role: "reviewer", workflow: "sdd-programme", models: ["claude-opus-5-5"] });
    expect((rev.rounds as Record<string, unknown>[])[0]).toMatchObject({ label: "reviewer:ROW-42:r1", duration_s: 1.3, result: { verdict: "APPROVED" } });

    expect(stage(alice.repoDir, "ROW-42")).toEqual([".mesh/goals/ROW-42/steps/reviewer.md", ".mesh/goals/ROW-42/steps/spec-writer.md"]);
    expect(stage(alice.repoDir, "NO-SUCH")).toEqual([]);

    await w.flush();
    const events = (await w.api(alice, "GET", "/v1/live")).json;
    void events;
    const all = (await w.hub.svc.events(0, 1000)).filter((e) => e.type === "agent.finished");
    expect(all.map((e) => [e.payload.key, e.payload.role, (e.payload.result as Record<string, unknown> | undefined)?.verdict])).toEqual([
      ["ROW-42", "spec-writer", undefined],
      ["ROW-42", "reviewer", "APPROVED"],
    ]);
    // Re-capturing the same agent never duplicates its hub event.
    sub("SubagentStop", "ad3d5cc636df29ba5", "reviewer");
    await w.flush();
    expect((await w.hub.svc.events(0, 1000)).filter((e) => e.type === "agent.finished")).toHaveLength(2);
  });

  it("backfills runs Claude Code recorded while the daemon was not watching", async () => {
    // Point the recorded transcripts at Bob's repo, as if the programme ran there.
    for (const id of ["a565ba12294ed8700", "ad3d5cc636df29ba5"]) {
      const f = transcript(id);
      writeFileSync(f, readFileSync(f, "utf8").replace('"cwd":"/work/repo"', `"cwd":${JSON.stringify(bob.repoDir)}`));
    }
    (bob.daemon.deps as { scanRuns?: (since: number) => unknown }).scanRuns = (since: number) => scanWorkflowRuns(home, since);
    bob.daemon.backfill();
    expect(readdirSync(join(bob.repoDir, ".git", "mesh", "pending", "ROW-42")).sort()).toEqual(["reviewer.md", "spec-writer.md"]);
    const spec = front(readFileSync(join(bob.repoDir, ".git", "mesh", "pending", "ROW-42", "spec-writer.md"), "utf8"));
    expect((spec.rounds as Record<string, unknown>[])[0]).toMatchObject({ result: { acceptance_criteria: ["AC-01", "AC-02"] }, tool_calls: 3 });
  });
});

describe("ledger export", () => {
  it("exports committed records as JSONL, validating mesh.ledger.v1", async () => {
    const G = await goalWithSteps(alice, [{ id: "a", repo: "frr-dplane-ovs" }]);
    w.hook(alice, "SessionStart", 100);
    await w.tool(alice, 100, "mesh_claim", { step: `${G}.a` });
    await w.tool(alice, 100, "mesh_done", { summary: "done" });
    const files = (await w.api(alice, "GET", `/v1/goals/${G}/files`)).json.files as { path: string; text: string }[];
    for (const f of files) {
      execFileSync("mkdir", ["-p", join(alice.repoDir, f.path, "..")]);
      writeFileSync(join(alice.repoDir, f.path), f.text);
    }
    writeFileSync(join(alice.repoDir, ".mesh/goals", G, "steps", "old.md"), "---\ngoal: G0\nstep: old\n---\nlegacy, before v1\n");
    writeFileSync(join(alice.repoDir, ".mesh/goals", G, "steps", "bad.md"), "---\nschema: mesh.ledger.v1\nrecord: step\ngoal: G0\n---\n");
    const g = (args: string[]) => execFileSync("git", ["-C", alice.repoDir, "-c", "user.email=t@t", "-c", "user.name=t", ...args]);
    g(["add", "-A"]);
    g(["commit", "-qm", "records"]);

    const r = exportLedger([alice.repoDir], undefined);
    expect(r.records).toBe(4);
    expect(r.skipped).toBe(1);
    expect(r.invalid.map((x) => x.path)).toEqual([`.mesh/goals/${G}/steps/bad.md`]);
    const lines = r.lines.map((l) => LedgerLine.parse(JSON.parse(l)));
    expect(lines.map((l) => (l.kind === "record" ? `${String(l.record.record)}:${l.path.split("/").pop()}` : "")).sort()).toEqual(["goal:goal.yaml", "plan:plan.v1.yaml", "step:a.md", "step:design.md"].sort());
    expect(lines.every((l) => l.kind === "record" && l.ref === "HEAD" && /^[0-9a-f]{40}$/.test(l.commit))).toBe(true);
  });
});
