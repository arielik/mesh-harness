// RL-5 daemon side end to end (World + real git checkouts + the fake claude): discovery in the sync,
// the catalog push of committed content, roster runs and roster runs that do not start. Criteria
// AC-05 (daemon part), AC-09, AC-20, AC-21. Written from the spec's contracts only
// (docs/specs/RL-5.md). Rescans: the clock moves past the MM-1 repo scan interval (300 000 ms) and the
// daemon syncs. No test runs the real `claude`.

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { git, MESH_TOOL_RULES, Relay, until } from "./helpers/relay-kit.ts";
import { parseAgentFile } from "../src/core/index.ts";
import { C1, H, H1, OTHER, REV1, REV2, REV3, SRC, SRC_URL } from "./helpers/roster-kit.ts";
import type { Json, Person } from "./helpers/world.ts";

let r: Relay;
afterEach(async () => {
  vi.restoreAllMocks();
  await r?.stop();
});

const SCAN_MS = 300_000;
const ALPHA_URL = "https://git.example.com/team/alpha.git";

/** Users ann, bob, carol (members) and root (admin). */
async function start(): Promise<void> {
  r = await Relay.start(["ann", "bob", "carol", "root"], { admins: ["root"] });
}
/** A device login of the admin `root` (its own machine). */
async function root(): Promise<string> {
  return (await r.w.login("root", { hostname: "root-box" })).token;
}
function put(dir: string, rel: string, text: string): void {
  mkdirSync(join(dir, rel, ".."), { recursive: true });
  writeFileSync(join(dir, rel), text);
}
function commitAll(dir: string, msg = "c"): string {
  git(dir, ["add", "-A"]);
  git(dir, ["commit", "-q", "-m", msg]);
  return git(dir, ["rev-parse", "HEAD"]);
}
/** Advance past the scan interval and let every daemon sync. */
async function rescan(): Promise<void> {
  r.w.clock += SCAN_MS + 1;
  await r.w.flush();
}
/** Advance past the scan interval and let only `p` sync. */
async function rescanOne(p: Person): Promise<void> {
  r.w.clock += SCAN_MS + 1;
  await p.daemon.link?.flush();
}
const pushCalls = (p: Person) => p.requests.filter((q) => q.method === "POST" && q.path === "/v1/catalog-sources/push");
const view = async (p: Person | string): Promise<Json> => {
  const res = await r.call(p, "GET", "/v1/agents");
  expect(res.status, JSON.stringify(res.json)).toBe(200);
  return res.json;
};
const copies = (v: Json): Json[] => ((v.agents ?? []) as Json[]).flatMap((g) => (g.versions as Json[]).flatMap((x) => x.copies as Json[]));
const repoCopies = (v: Json) => copies(v).filter((c) => c.origin === "repo");
const reported = async (machine: string) => (await r.allEvents()).filter((e) => e.type === "agents.reported" && e.payload?.machine === machine);
const withAgents = (p: Person) => p.syncs.filter((s) => s.machine && "agents" in s.machine);

/** A person whose checkout `repo` has `origin` = `remote`, scanned under `share`. */
async function scanned(name: string, repo: string, remote: string, share: "me" | "all" | "steps", files: Record<string, string> = {}, commit = false): Promise<Person> {
  const p = await r.w.person(name, repo, { shareSessions: share });
  git(p.repoDir, ["remote", "add", "origin", remote]);
  for (const [rel, text] of Object.entries(files)) put(p.repoDir, rel, text);
  if (commit) commitAll(p.repoDir, "init");
  await r.w.restart(p, { workspaceRoots: [p.dir] });
  await r.w.flush();
  return p;
}

// ---------------------------------------------------------------------------------------------

describe("AC-05 sync (daemon)", { timeout: 40_000 }, () => {
  it("test_AC05_daemon_reports", async () => {
    await start();
    const ann = await scanned("ann", "alpha", ALPHA_URL, "me", { ".claude/agents/reviewer.md": REV1, ".claude/agents/other.md": OTHER });
    await rescan();
    const sent = withAgents(ann).at(-1);
    expect(sent?.machine.agents, JSON.stringify(ann.syncs.at(-1)?.machine)).toHaveLength(2);
    const v = await view(ann);
    for (const key of ["alpha/reviewer", "alpha/other"]) expect(copies(v).find((c) => c.key === key), key).toMatchObject({ origin: "repo", machines: 1 });
    expect(copies(v).find((c) => c.key === "alpha/reviewer").hash).toBe(H(REV1));
    const machine = r.w.machineOf(ann);
    expect((await reported(machine)).map((e) => e.payload)).toStrictEqual([{ machine, count: 2 }]);
    // No change: no agents key, no new event.
    const mark = ann.syncs.length;
    await rescan();
    await rescan();
    expect(ann.syncs.length).toBeGreaterThan(mark);
    for (const s of ann.syncs.slice(mark)) expect("agents" in (s.machine ?? {})).toBe(false);
    expect(await reported(machine)).toHaveLength(1);
    // A deleted file is gone after the next rescan.
    rmSync(join(ann.repoDir, ".claude", "agents", "other.md"));
    await rescan();
    expect(withAgents(ann).at(-1)?.machine.agents.map((a: Json) => a.name)).toStrictEqual(["reviewer"]);
    const v2 = await view(ann);
    expect(copies(v2).find((c) => c.key === "alpha/other")).toBeUndefined();
    expect(copies(v2).find((c) => c.key === "alpha/reviewer")).toBeDefined();
    expect((await reported(machine)).map((e) => e.payload.count)).toStrictEqual([2, 1]);
  });

  it("test_AC05_switch_to_steps", async () => {
    await start();
    const ann = await scanned("ann", "alpha", ALPHA_URL, "me", { ".claude/agents/reviewer.md": REV1 });
    await rescan();
    expect(repoCopies(await view(ann)).map((c) => c.key)).toStrictEqual(["alpha/reviewer"]);
    await r.w.restart(ann, { shareSessions: "steps" });
    await r.w.flush();
    await rescan();
    expect(repoCopies(await view(ann))).toStrictEqual([]);
  });

  it("test_AC05_steps_from_start", async () => {
    await start();
    const carol = await scanned("carol", "alpha", ALPHA_URL, "steps", { ".claude/agents/reviewer.md": REV1 });
    await rescan();
    await rescan();
    await rescan();
    expect(carol.syncs.length).toBeGreaterThan(0);
    for (const s of carol.syncs) {
      const a = s.machine?.agents;
      expect(a === undefined || (Array.isArray(a) && a.length === 0), JSON.stringify(a)).toBe(true);
    }
    expect(repoCopies(await view(carol))).toStrictEqual([]);
    // Control: the same checkout under `me` is reported.
    const ann = await scanned("ann", "alpha", ALPHA_URL, "me", { ".claude/agents/reviewer.md": REV1 });
    await rescan();
    expect(withAgents(ann).at(-1)?.machine.agents).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------------------------

describe("AC-09 daemon push", { timeout: 60_000 }, () => {
  async function register(): Promise<string> {
    const t = await root();
    const res = await r.w.call(t, "POST", "/v1/catalog-sources", { repo: SRC_URL, folder: "agents" });
    expect(res.status, JSON.stringify(res.json)).toBe(201);
    return t;
  }
  const resolve = (p: Person, key: string) => r.call(p, "GET", `/v1/agents/resolve?key=${encodeURIComponent(key)}`);
  const sourceOf = async (p: Person): Promise<Json> => ((await r.call(p, "GET", "/v1/catalog-sources")).json.sources as Json[]).find((s) => s.repo === SRC);
  /** Rescan until `cond` holds (at most 3 times). */
  async function settle(cond: () => Promise<boolean>, one?: Person): Promise<void> {
    for (let i = 0; i < 3 && !(await cond()); i++) await (one ? rescanOne(one) : rescan());
    expect(await cond(), "settled").toBe(true);
  }

  it("test_AC09_pushes_committed", async () => {
    await start();
    await register();
    const ann = await scanned("ann", "agents", SRC_URL, "me", { "agents/rev.md": REV1 }, true);
    const A1 = git(ann.repoDir, ["rev-parse", "HEAD"]);
    await settle(async () => (await resolve(ann, "agents/rev")).status === 200);
    const res = await resolve(ann, "agents/rev");
    expect(res.json.text).toBe(REV1);
    expect(res.json.text).toContain("\r\n");
    expect(res.json.commit).toBe(A1);
    expect(pushCalls(ann).length).toBeGreaterThanOrEqual(1);
    const n = pushCalls(ann).length;
    await rescan();
    await rescan();
    expect(pushCalls(ann)).toHaveLength(n);
  });

  it("test_AC09_uncommitted_ignored", async () => {
    await start();
    await register();
    const ann = await scanned("ann", "agents", SRC_URL, "me", { "agents/rev.md": REV1 }, true);
    await settle(async () => (await resolve(ann, "agents/rev")).status === 200);
    const n = pushCalls(ann).length;
    put(ann.repoDir, "agents/rev.md", REV2);
    put(ann.repoDir, "agents/new.md", OTHER);
    await rescan();
    await rescan();
    expect(pushCalls(ann)).toHaveLength(n);
    expect((await resolve(ann, "agents/rev")).json.text).toBe(REV1);
    git(ann.repoDir, ["add", "agents/rev.md"]);
    git(ann.repoDir, ["commit", "-q", "-m", "edit"]);
    const A2 = git(ann.repoDir, ["rev-parse", "HEAD"]);
    await rescan();
    expect(pushCalls(ann)).toHaveLength(n + 1);
    const res = await resolve(ann, "agents/rev");
    expect(res.json).toMatchObject({ text: REV2, commit: A2 });
    expect((await resolve(ann, "agents/new")).status).toBe(404);
    expect((await sourceOf(ann)).commit).toBe(A2);
  });

  it("test_AC09_origin_head", async () => {
    await start();
    const ann = await r.w.person("ann", "agents", { shareSessions: "me" });
    git(ann.repoDir, ["remote", "add", "origin", SRC_URL]);
    put(ann.repoDir, "agents/rev.md", REV1);
    commitAll(ann.repoDir, "a1");
    put(ann.repoDir, "agents/rev.md", REV2);
    const A2 = commitAll(ann.repoDir, "a2");
    put(ann.repoDir, "agents/rev.md", REV3);
    const A3 = commitAll(ann.repoDir, "a3");
    expect(A3).not.toBe(A2);
    git(ann.repoDir, ["update-ref", "refs/remotes/origin/main", A2]);
    git(ann.repoDir, ["symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main"]);
    await register();
    await r.w.restart(ann, { workspaceRoots: [ann.dir] });
    await r.w.flush();
    await settle(async () => (await resolve(ann, "agents/rev")).status === 200);
    expect((await resolve(ann, "agents/rev")).json).toMatchObject({ text: REV2, commit: A2 });
    expect((await sourceOf(ann)).commit).toBe(A2);
  });

  it.each([["ann first"], ["carol first"]])("test_AC09_two_daemons_forward_only (%s)", async (order) => {
    await start();
    const ann = await scanned("ann", "agents", SRC_URL, "me", { "agents/rev.md": REV1 }, true);
    const C1x = git(ann.repoDir, ["rev-parse", "HEAD"]);
    const carol = await r.w.person("carol", "agents", { shareSessions: "me" });
    git(carol.repoDir, ["remote", "add", "origin", SRC_URL]);
    git(carol.repoDir, ["fetch", "-q", ann.repoDir, "HEAD"]);
    git(carol.repoDir, ["reset", "-q", "--hard", "FETCH_HEAD"]);
    put(carol.repoDir, "agents/rev.md", REV2);
    const C2x = commitAll(carol.repoDir, "c2");
    expect(git(carol.repoDir, ["merge-base", "--is-ancestor", C1x, C2x])).toBe("");
    await r.w.restart(carol, { workspaceRoots: [carol.dir] });
    await r.w.flush();
    // The source exists only now, so nothing was pushed yet.
    await register();
    const commitIs = (c: string) => async () => (await sourceOf(ann))?.commit === c;
    if (order === "ann first") {
      await settle(commitIs(C1x), ann);
      await settle(commitIs(C2x), carol);
    } else {
      await settle(commitIs(C2x), carol);
      const n = pushCalls(ann).length;
      await rescanOne(ann);
      await rescanOne(ann);
      expect(pushCalls(ann)).toHaveLength(n);
      expect(ann.logs).toContain(`catalog push of ${SRC} skipped: ${C1x.slice(0, 7)} does not descend from ${C2x.slice(0, 7)}`);
    }
    expect((await sourceOf(ann)).commit).toBe(C2x);
    expect((await resolve(ann, "agents/rev")).json).toMatchObject({ text: REV2, commit: C2x });
    const a = pushCalls(ann).length;
    const c = pushCalls(carol).length;
    await rescan();
    await rescan();
    expect(pushCalls(ann)).toHaveLength(a);
    expect(pushCalls(carol)).toHaveLength(c);
    expect((await sourceOf(ann)).commit).toBe(C2x);
  });

  // A refusal is logged and tried again on the next rescan (REPO_SCAN_MS), not on every flush.
  it("test_AC09_refused_push_waits_for_rescan", async () => {
    await start();
    await register();
    const ann = await r.w.person("ann", "agents", { shareSessions: "me" });
    git(ann.repoDir, ["remote", "add", "origin", SRC_URL]);
    put(ann.repoDir, "agents/rev.md", REV1);
    const A1 = commitAll(ann.repoDir);
    // The hub stub refuses the first push with 422.
    ann.failOnce(/^\/v1\/catalog-sources\/push$/, 422);
    await r.w.restart(ann, { workspaceRoots: [ann.dir] });
    await r.w.flush();
    expect(pushCalls(ann), "the first push was sent and refused").toHaveLength(1);
    expect(ann.logs.some((l) => l.startsWith(`catalog push of ${SRC} refused: `) && l.includes("simulated")), ann.logs.join("\n")).toBe(true);
    expect((await resolve(ann, "agents/rev")).status).toBe(404);
    // Flushes before the scan interval has passed send no push again.
    for (let i = 0; i < 4; i++) {
      r.w.clock += 1_000;
      await ann.daemon.link?.flush();
    }
    await r.w.flush();
    expect(pushCalls(ann)).toHaveLength(1);
    // The first flush after the next rescan pushes again, and this time the hub accepts it.
    await rescanOne(ann);
    expect(pushCalls(ann)).toHaveLength(2);
    expect((await resolve(ann, "agents/rev")).json).toMatchObject({ text: REV1, commit: A1 });
    // Accepted: later rescans without a change push nothing.
    await rescanOne(ann);
    expect(pushCalls(ann)).toHaveLength(2);
  });

  // diff r2 S8: within one scan a refused push is not sent again, also when another push of the pass
  // failed with a 5xx; the failed push is retried after a back-off of 30 s that doubles, not every flush.
  it("test_AC09_refusal_kept_and_5xx_backs_off", async () => {
    await start();
    const t = await register();
    const SRC2_URL = "https://git.example.com/other/agents.git";
    const add = await r.w.call(t, "POST", "/v1/catalog-sources", { repo: SRC2_URL, folder: "agents" });
    expect(add.status, JSON.stringify(add.json)).toBe(201);
    const ann = await r.w.person("ann", "agents", { shareSessions: "me" });
    git(ann.repoDir, ["remote", "add", "origin", SRC_URL]);
    put(ann.repoDir, "agents/rev.md", REV1);
    const A1 = commitAll(ann.repoDir);
    const two = join(ann.dir, "other");
    mkdirSync(two);
    git(two, ["init", "-q"]);
    git(two, ["remote", "add", "origin", SRC2_URL]);
    put(two, "agents/rev.md", REV2);
    const B1 = commitAll(two);
    // The first push of the pass is refused (422), the second fails (500), and so does its first retry.
    const PUSH = /^\/v1\/catalog-sources\/push$/;
    ann.failOnce(PUSH, 422);
    ann.failOnce(PUSH, 500);
    ann.failOnce(PUSH, 500);
    await r.w.restart(ann, { workspaceRoots: [ann.dir] });
    await r.w.flush();
    expect(pushCalls(ann), ann.logs.join("\n")).toHaveLength(2);
    const repoIn = (word: string) => {
      const ls = ann.logs.filter((l) => l.startsWith("catalog push of ") && l.includes(` ${word}: `));
      expect(ls, `${word}: ${ann.logs.join("\n")}`).toHaveLength(1);
      return ls[0]!.slice("catalog push of ".length, ls[0]!.indexOf(` ${word}: `));
    };
    const refused = repoIn("refused");
    const failed = repoIn("failed");
    expect([refused, failed].sort()).toStrictEqual(["git.example.com/other/agents", SRC].sort());
    const commitOf = { [SRC]: A1, "git.example.com/other/agents": B1 } as Record<string, string>;
    const stored = async (repo: string) => ((await r.call(ann, "GET", "/v1/catalog-sources")).json.sources as Json[]).find((s) => s.repo === repo)?.commit;
    const flushAt = async (ms: number) => {
      r.w.clock += ms;
      await ann.daemon.link?.flush();
    };
    // Flushes before the 30 s back-off has passed send nothing (neither the refused nor the failed push).
    for (let i = 0; i < 4; i++) await flushAt(5_000);
    expect(pushCalls(ann)).toHaveLength(2);
    // After 30 s: only the failed push is sent again (and fails again).
    await flushAt(10_001);
    expect(pushCalls(ann)).toHaveLength(3);
    expect(ann.logs.filter((l) => l.startsWith(`catalog push of ${refused} refused: `))).toHaveLength(1);
    expect(ann.logs.filter((l) => l.startsWith(`catalog push of ${failed} failed: `))).toHaveLength(2);
    // The back-off doubled: 30 s later nothing, 60 s later the retry, which the hub accepts.
    await flushAt(30_000);
    expect(pushCalls(ann)).toHaveLength(3);
    await flushAt(30_001);
    expect(pushCalls(ann)).toHaveLength(4);
    expect(await stored(failed)).toBe(commitOf[failed]);
    expect(await stored(refused)).toBeUndefined();
    // Done for this scan: further flushes send nothing.
    for (let i = 0; i < 3; i++) await flushAt(60_000);
    expect(pushCalls(ann)).toHaveLength(4);
    // The next rescan sends the refused push again (accepted now); the accepted one is unchanged.
    await rescanOne(ann);
    expect(pushCalls(ann)).toHaveLength(5);
    expect(await stored(refused)).toBe(commitOf[refused]);
  });

  it("test_AC09_steps_and_404", async () => {
    await start();
    await register();
    const carol = await scanned("carol", "agents", SRC_URL, "steps", { "agents/rev.md": REV1 }, true);
    await rescan();
    await rescan();
    expect(carol.requests.filter((q) => q.path.startsWith("/v1/catalog-sources"))).toStrictEqual([]);
    // A 404 on the source list does not stop the sync.
    const ann = await r.w.person("ann", "agents", { shareSessions: "me" });
    git(ann.repoDir, ["remote", "add", "origin", SRC_URL]);
    put(ann.repoDir, "agents/rev.md", REV1);
    commitAll(ann.repoDir);
    ann.failOnce(/^\/v1\/catalog-sources$/, 404);
    const mark = ann.syncs.length;
    await r.w.restart(ann, { workspaceRoots: [ann.dir] });
    await r.w.flush();
    expect(ann.syncs.length).toBeGreaterThan(mark);
    expect(ann.requests.some((q) => q.method === "GET" && q.path === "/v1/catalog-sources")).toBe(true);
    expect((await r.w.hubStore.getMachine(r.w.machineOf(ann)) as Json)?.repos?.map((x: Json) => x.id)).toContain(SRC);
    await settle(async () => (await resolve(ann, "agents/rev")).status === 200);
    expect(pushCalls(ann).length).toBeGreaterThanOrEqual(1);
  });
});

// ---------------------------------------------------------------------------------------------

/** A catalog with `rev` = REV1 at C1, pushed from a root device that reports the source. */
async function catalogOnHub(): Promise<void> {
  const t = await root();
  expect((await r.w.call(t, "POST", "/v1/catalog-sources", { repo: SRC_URL, folder: "agents" })).status).toBe(201);
  const sync = await r.w.call(t, "POST", "/v1/sync", { events: [], counts: {}, sessions: [], machine: { share: "me", repos: [{ id: SRC, name: "agents" }] } });
  expect(sync.status).toBe(200);
  const p = await r.w.call(t, "POST", "/v1/catalog-sources/push", { repo: SRC, commit: C1, defs: [{ path: "agents/rev.md", text: REV1 }] });
  expect(p.status, JSON.stringify(p.json)).toBe(200);
}

interface HCast {
  ann: Person;
  self: string;
  id: string;
  G: string;
}
async function rosterStep(o: { output?: boolean; unpin?: boolean } = {}): Promise<HCast> {
  await start();
  await catalogOnHub();
  const ann = await r.headlessPerson("ann", { nick: "hl", person: { shareSessions: "me" } });
  put(ann.repoDir, "src/a.ts", "one\ntwo\n");
  commitAll(ann.repoDir, "src");
  const self = await r.otherLogin("ann");
  await r.w.flush();
  const G = await r.goal(self, [{ id: "audit", mode: "headless", agent: "agents/rev", ...(o.output ? { output: "review-record" } : {}) }]);
  if (o.unpin) {
    const g = (await r.w.hubStore.getGoal(G)) as Json;
    expect(g.agents?.["agents/rev"]).toBeDefined();
    delete g.agents["agents/rev"];
    await r.w.hubStore.saveGoal(g);
  }
  return { ann, self, id: `${G}.audit`, G };
}

describe("AC-20 roster run", { timeout: 60_000 }, () => {
  it("test_AC20_argv_files", async () => {
    const k = await rosterStep();
    const agentFile = join(k.ann.repoDir, ".claude", "agents", "rev.md");
    expect(existsSync(agentFile)).toBe(false);
    r.script(k.id, [{ waitFor: "end" }]);
    await r.autoOffer(k.ann, k.id, k.self);
    await r.pull(k.ann);
    const call = await r.started(k.id);
    const run = await r.runOf(k.ann, k.id);
    const dir = r.runDir(k.ann, run);
    expect(call.argv.slice(-4)).toStrictEqual(["--agents", join(dir, "agents.json"), "--agent", "rev"]);
    expect(call.argv.slice(0, 2)[0]).toBe("-p");
    expect(readFileSync(join(dir, "agent.md")).equals(Buffer.from(REV1, "utf8"))).toBe(true);
    expect(JSON.parse(readFileSync(join(dir, "agents.json"), "utf8"))).toStrictEqual({ rev: { description: "Reviews code", prompt: "You review.", tools: ["Read", "Grep", ...MESH_TOOL_RULES], model: "sonnet" } });
    expect(run.agent).toStrictEqual({ name: "rev", key: "agents/rev", hash: H1 });
    expect(existsSync(join(dir, "worktree", ".claude", "agents", "rev.md"))).toBe(false);
    r.go("end");
    await r.endRun(k.ann, k.id);
    expect(existsSync(agentFile)).toBe(false);
    expect(existsSync(join(dir, "worktree", ".claude", "agents", "rev.md"))).toBe(false);
    const st = await r.stepOf(k.id);
    expect(st.rounds.at(-1).telemetry).toMatchObject({ agentKey: "agents/rev", agentHash: H1 });
  });

  it("test_AC20_telemetry_rules", async () => {
    const k = await rosterStep({ output: true });
    r.script(k.id, [{ waitFor: "end-7" }]);
    await r.autoOffer(k.ann, k.id, k.self);
    await r.pull(k.ann);
    await r.started(k.id);
    await r.runSession(k.ann, k.id, 7);
    const item = (rule: string) => ({ key: { rule, path: "src/a.ts" }, title: `T-${rule}`, severity: "S3", category: "c", evidence: [] });
    const t = await r.w.tool(k.ann, 7, "mesh_review" as never, { coverage: "complete", assessment: "issues", items: [item("r.alpha"), item("r.zeta")], summary: "s" });
    expect(t.isError, t.text).toBeFalsy();
    const d = await r.w.tool(k.ann, 7, "mesh_done", { outcome: "done", summary: "s" });
    expect(d.isError, d.text).toBeFalsy();
    r.go("end-7");
    await r.endRun(k.ann, k.id);
    const [rv] = (await r.call(k.ann, "GET", `/v1/steps/${k.id}/reviews`)).json.reviews as Json[];
    expect(rv.undeclaredRules).toBe(1);
    expect((rv.record.items as Json[]).map((x) => x.key.rule)).toContain("r.alpha");
    const st = await r.stepOf(k.id);
    expect(st.rounds.at(-1).telemetry).toMatchObject({ agentKey: "agents/rev", agentHash: H1, undeclaredRules: 1 });
  });
});

// ---------------------------------------------------------------------------------------------

describe("AC-21 roster run not started", { timeout: 60_000 }, () => {
  async function failed(k: HCast, reason: string | RegExp): Promise<void> {
    expect(await until(async () => (await r.stepOf(k.id)).state === "failed", 8_000), "step failed").toBe(true);
    const st = await r.stepOf(k.id);
    expect(st.rounds.at(-1).outcome).toBe("fail");
    const summary = st.rounds.at(-1).summary as string;
    const prefix = `headless run of ${k.id} did not start: `;
    expect(summary.startsWith(prefix), summary).toBe(true);
    if (typeof reason === "string") expect(summary.slice(prefix.length)).toBe(reason);
    else expect(summary.slice(prefix.length)).toMatch(reason);
    expect(st.rounds.at(-1).telemetry?.exit).toBe("crashed");
    expect(r.calls(k.id)).toStrictEqual([]);
  }

  it("test_AC21_agent_error", async () => {
    const k = await rosterStep({ unpin: true });
    await r.autoOffer(k.ann, k.id, k.self);
    await r.pull(k.ann);
    await r.reconcile(k.ann);
    await failed(k, `roster agent agents/rev was not resolved by the hub: agents/rev is not pinned in ${k.G}`);
  });

  it("test_AC21_resolve_404", async () => {
    const k = await rosterStep();
    k.ann.failOnce(/^\/v1\/agents\/resolve/, 404);
    await r.autoOffer(k.ann, k.id, k.self);
    await r.pull(k.ann);
    await r.reconcile(k.ann);
    await failed(k, /^roster agent agents\/rev is not available: .*simulated/);
  });

  it("test_AC21_hash_mismatch", async () => {
    const k = await rosterStep();
    const real = globalThis.fetch;
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input: string | URL | Request, init?: RequestInit) => {
      const url = input instanceof Request ? input.url : String(input);
      const res = await real(input, init);
      if (!new URL(url).pathname.startsWith("/v1/agents/resolve") || res.status !== 200) return res;
      const j = (await res.json()) as Json;
      return new Response(JSON.stringify({ ...j, text: `${String(j.text)}tampered\n` }), { status: 200, headers: { "content-type": "application/json" } });
    });
    await r.autoOffer(k.ann, k.id, k.self);
    await r.pull(k.ann);
    await r.reconcile(k.ann);
    await failed(k, "roster agent agents/rev does not match its hash");
  });

  it("test_AC21_control_starts", async () => {
    const k = await rosterStep();
    r.script(k.id, []);
    await r.autoOffer(k.ann, k.id, k.self);
    await r.pull(k.ann);
    await r.started(k.id);
  });
});

// ---------------------------------------------------------------------------------------------

// RL-7 AC-08 (daemon part) and AC-10 (roster agent): agent front matter that is not valid YAML is
// reported with `invalid` and its hash, and a roster agent with such a text fails the step at start
// (docs/specs/RL-7.md, Agent front matter; Headless start).
describe("RL-7 AC-08 invalid agents", { timeout: 60_000 }, () => {
  /** Line 2 of the front matter is not valid YAML. */
  const BAD = "---\nname: bad\ndescription: Validates: findings\n---\nYou validate.\n";
  const GOOD = "---\ndescription: Good agent\n---\nYou review.\n";
  const INV_PREFIX = "front matter is not valid YAML: ";
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- new field, read loosely
  const invalidOf = (text: string): string => (parseAgentFile(text) as any).invalid;

  it("test_AC08_report_and_groups", async () => {
    await start();
    const ann = await scanned("ann", "alpha", ALPHA_URL, "me", { ".claude/agents/bad.md": BAD, ".claude/agents/good.md": GOOD });
    await rescan();
    const rows = (withAgents(ann).at(-1)?.machine.agents ?? []) as Json[];
    const bad = rows.find((a) => a.name === "bad");
    const good = rows.find((a) => a.name === "good");
    // Control: the valid file is reported with its description.
    expect(good, JSON.stringify(rows)).toMatchObject({ description: "Good agent", hash: H(GOOD) });
    expect(good.invalid).toBeUndefined();
    expect(bad, JSON.stringify(rows)).toBeDefined();
    expect(bad.hash).toBe(H(BAD));
    expect(typeof bad.invalid).toBe("string");
    expect(bad.invalid.startsWith(INV_PREFIX), bad.invalid).toBe(true);
    expect(bad.invalid).toContain("line 2");
    expect(bad.invalid).toBe(invalidOf(BAD));
    for (const f of ["description", "tools", "model", "rules"]) expect(bad[f], f).toBeUndefined();
    const v = await view(ann);
    const groups = v.agents as Json[];
    const gb = groups.find((g) => g.name === "bad");
    const gg = groups.find((g) => g.name === "good");
    expect(gb, JSON.stringify(groups)).toMatchObject({ invalid: true });
    expect(gb.versions[0]).toMatchObject({ hash: H(BAD), invalid: bad.invalid });
    expect(gg).toMatchObject({ invalid: false });
    for (const x of gg.versions as Json[]) expect(x.invalid).toBeUndefined();
  });

  it("test_AC10_roster_agent_invalid", async () => {
    await start();
    const t = await root();
    expect((await r.w.call(t, "POST", "/v1/catalog-sources", { repo: SRC_URL, folder: "agents" })).status).toBe(201);
    expect((await r.w.call(t, "POST", "/v1/sync", { events: [], counts: {}, sessions: [], machine: { share: "me", repos: [{ id: SRC, name: "agents" }] } })).status).toBe(200);
    const p = await r.w.call(t, "POST", "/v1/catalog-sources/push", { repo: SRC, commit: C1, defs: [{ path: "agents/bad.md", text: BAD }] });
    expect(p.status, JSON.stringify(p.json)).toBe(200);
    const ann = await r.headlessPerson("ann", { nick: "hl", person: { shareSessions: "me" } });
    const self = await r.otherLogin("ann");
    await r.w.flush();
    const G = await r.goal(self, [{ id: "ff2", mode: "headless", agent: "agents/bad" }]);
    const id = `${G}.ff2`;
    const key = ((await r.w.hubStore.getGoal(G)) as Json).agents?.["agents/bad"]?.key ?? "agents/bad";
    r.script(id, []);
    await r.autoOffer(ann, id, self);
    await r.pull(ann);
    await r.reconcile(ann);
    expect(await until(async () => (await r.stepOf(id)).state === "failed", 8_000), "step failed").toBe(true);
    const st = await r.stepOf(id);
    const inv = invalidOf(BAD);
    expect(typeof inv).toBe("string");
    expect(inv.startsWith(INV_PREFIX)).toBe(true);
    expect(st.rounds.at(-1)).toMatchObject({ outcome: "fail", summary: `headless run of ${id} did not start: roster agent ${key} has invalid front matter: ${inv}` });
    await r.reconcile(ann);
    await new Promise((res) => setTimeout(res, 200));
    expect(r.calls(id)).toStrictEqual([]);
    const run = (await r.runs(ann)).find((x) => x.step === id);
    expect(run?.state).toBe("finished");
    expect(existsSync(join(r.runDir(ann, run), "agents.json"))).toBe(false);
  });
});
