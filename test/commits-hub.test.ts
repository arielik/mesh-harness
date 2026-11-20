// RL-13 (docs/specs/RL-13.md): the commit of each round, interactive side and hub contracts.
// AC-01 to AC-04 and AC-06 (hub refusals), AC-08 (step record, ledger schema), AC-09 (mesh show),
// AC-10 (features). Headless runs (AC-05, AC-07) are in test/commits-headless.test.ts.

import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parse } from "yaml";
import { renderGoal } from "../src/cli/show.ts";
import { HUB_FEATURES, LedgerStep, type GoalDetail, type Step } from "../src/protocol/index.ts";
import { World, type Person } from "./helpers/world.ts";

let w: World;
let alice: Person;

beforeEach(async () => {
  w = new World();
  await w.start(["alice", "root", "carol"], { admins: ["root"] });
  alice = await w.person("alice", "frr-dplane-ovs");
});
afterEach(() => w.stop());

const git = (cwd: string, args: string[]) => execFileSync("git", ["-C", cwd, "-c", "user.email=t@example.invalid", "-c", "user.name=t", ...args], { encoding: "utf8" }).trim();
const commitIn = (cwd: string, msg = "work") => {
  git(cwd, ["commit", "-q", "--allow-empty", "-m", msg]);
  return git(cwd, ["rev-parse", "HEAD"]);
};
const front = (text: string) => parse(text.split("---\n")[1] ?? "") as Record<string, unknown>;

async function held(repo = "frr-dplane-ovs", pid = 100): Promise<string> {
  const g = await w.api(alice, "POST", "/v1/goals", { title: "commits", primaryRepo: repo });
  const G = g.json.id as string;
  const p = await w.api(alice, "POST", `/v1/goals/${G}/plan`, { approve: true, steps: [{ id: "a", repo, kind: "implement", title: "a", brief: "do a" }] });
  expect(p.status, JSON.stringify(p.json)).toBe(201);
  w.hook(alice, "SessionStart", pid);
  const c = await w.tool(alice, pid, "mesh_claim", { step: `${G}.a` });
  expect(c.isError, c.text).toBeFalsy();
  return `${G}.a`;
}
const stepOf = async (id: string): Promise<Step> => (await w.api(alice, "GET", `/v1/steps/${id}`)).json.context.step as Step;
const doneEvents = async (id: string) => (await w.hubStore.events(0, 100_000)).filter((e) => (e.type === "step.done" || e.type === "step.failed") && e.step === id);

describe("RL-13 AC-01 HEAD of the step's checkout", () => {
  it("test_AC01_head", async () => {
    const head = commitIn(alice.repoDir);
    const id = await held();
    const d = await w.tool(alice, 100, "mesh_done", { summary: "did a" });
    expect(d.isError, d.text).toBeFalsy();
    const st = await stepOf(id);
    expect(st.rounds?.[0]?.commit).toBe(head);
    expect((await doneEvents(id))[0]?.payload.commit).toBe(head);
    const g = await w.api(alice, "GET", `/v1/goals/${id.split(".")[0]}`);
    expect((g.json.steps as Step[]).find((s) => s.id === id)?.rounds?.[0]?.commit).toBe(head);
  });

  it("test_AC01_no_cached_context", async () => {
    const head = commitIn(alice.repoDir);
    const id = await held();
    // As a step bound by the autopilot chain or an offer: the daemon has no cached context.
    alice.store.pruneStepCache(Number.MAX_SAFE_INTEGER);
    expect(alice.store.cachedStep(id)).toBeUndefined();
    expect((await w.tool(alice, 100, "mesh_done", { summary: "did a" })).isError).toBeFalsy();
    expect((await stepOf(id)).rounds?.[0]?.commit).toBe(head);
  });
});

describe("RL-13 AC-02 branch, other repo, no commits", () => {
  it("test_AC02_branch_local_then_origin", async () => {
    commitIn(alice.repoDir, "base");
    git(alice.repoDir, ["branch", "feat"]);
    git(alice.repoDir, ["checkout", "-q", "feat"]);
    const feat = commitIn(alice.repoDir, "feat work");
    git(alice.repoDir, ["checkout", "-q", "-"]);
    const id = await held();
    expect((await w.tool(alice, 100, "mesh_done", { summary: "x", branch: "feat" })).isError).toBeFalsy();
    expect((await stepOf(id)).rounds?.[0]?.commit).toBe(feat);

    // A branch only origin knows.
    const bare = join(alice.dir, "remote.git");
    git(alice.dir, ["init", "-q", "--bare", bare]);
    git(alice.repoDir, ["remote", "add", "origin", bare]);
    git(alice.repoDir, ["push", "-q", "origin", "feat:refs/heads/remote-only"]);
    git(alice.repoDir, ["fetch", "-q", "origin"]);
    const id2 = await held("frr-dplane-ovs", 101);
    expect((await w.tool(alice, 101, "mesh_done", { summary: "x", branch: "remote-only" })).isError).toBeFalsy();
    expect((await stepOf(id2)).rounds?.[0]?.commit).toBe(feat);
  });

  it("test_AC02_unknown_or_revision_branch", async () => {
    commitIn(alice.repoDir, "base");
    commitIn(alice.repoDir, "second");
    const id = await held();
    expect((await w.tool(alice, 100, "mesh_done", { summary: "x", branch: "nope" })).isError).toBeFalsy();
    expect((await stepOf(id)).rounds?.[0]?.commit).toBeUndefined();
    const id2 = await held("frr-dplane-ovs", 101);
    // Revision syntax on the real current branch: it would resolve without the name check.
    const cur = git(alice.repoDir, ["symbolic-ref", "--short", "HEAD"]);
    expect(git(alice.repoDir, ["rev-parse", "--verify", "-q", `refs/heads/${cur}~1^{commit}`])).toMatch(/^[0-9a-f]{40}$/);
    const d = await w.tool(alice, 101, "mesh_done", { summary: "x", branch: `${cur}~1` });
    expect(d.isError, d.text).toBeFalsy();
    expect((await stepOf(id2)).rounds?.[0]?.commit).toBeUndefined();
  });

  it("test_AC02_no_commits_and_no_checkout", async () => {
    const id = await held();
    expect((await w.tool(alice, 100, "mesh_done", { summary: "x" })).isError).toBeFalsy();
    expect((await stepOf(id)).rounds?.[0]?.commit).toBeUndefined();

    const outside = join(alice.dir, "not-a-repo");
    mkdirSync(outside);
    const id2 = await held("frr-dplane-ovs", 101);
    w.hook(alice, "UserPromptSubmit", 101, { cwd: outside, prompt: "x" });
    await w.flush();
    expect((await w.tool(alice, 101, "mesh_done", { summary: "x" })).isError).toBeFalsy();
    expect((await stepOf(id2)).rounds?.[0]?.commit).toBeUndefined();
  });

  it("test_AC02_other_repo", async () => {
    commitIn(alice.repoDir);
    // A step of another repo, held by a session in alice's checkout.
    const id = await held("vpc-node-agent");
    expect((await w.tool(alice, 100, "mesh_done", { summary: "x" })).isError).toBeFalsy();
    expect((await stepOf(id)).rounds?.[0]?.commit).toBeUndefined();
  });

  it("test_AC02_cwd_moved_to_other_repo", async () => {
    commitIn(alice.repoDir);
    const other = join(alice.dir, "other-repo");
    mkdirSync(other);
    git(other, ["init", "-q"]);
    git(other, ["remote", "add", "origin", "https://gitlab.lab/vpc/other-repo.git"]);
    commitIn(other);
    const id = await held();
    w.hook(alice, "UserPromptSubmit", 100, { cwd: other, prompt: "x" });
    await w.flush();
    expect((await w.tool(alice, 100, "mesh_done", { summary: "x" })).isError).toBeFalsy();
    expect((await stepOf(id)).rounds?.[0]?.commit).toBeUndefined();
  });
});

describe("RL-13 AC-03 explicit commit", () => {
  it("test_AC03_explicit_wins_and_lowercased", async () => {
    commitIn(alice.repoDir);
    const id = await held();
    const given = "AB".repeat(20);
    expect((await w.tool(alice, 100, "mesh_done", { summary: "x", commit: given })).isError).toBeFalsy();
    expect((await stepOf(id)).rounds?.[0]?.commit).toBe(given.toLowerCase());
  });

  it("test_AC03_malformed_fails_tool", async () => {
    commitIn(alice.repoDir);
    const id = await held();
    for (const bad of ["abc1234", "z".repeat(40), "a".repeat(41)]) {
      const d = await w.tool(alice, 100, "mesh_done", { summary: "x", commit: bad });
      expect(d.isError, bad).toBe(true);
      expect(d.text).toContain("commit must be a full commit id");
    }
    expect(alice.requests.filter((q) => q.path === `/v1/steps/${id}/done`)).toHaveLength(0);
    expect((await stepOf(id)).state).toBe("claimed");
  });

  it("test_AC03_hub_refuses_malformed", async () => {
    const id = await held();
    const d = await w.api(alice, "POST", `/v1/steps/${id}/done`, { summary: "x", commit: "ABC" });
    expect(d.status).toBe(400);
    const r = await w.api(alice, "POST", `/v1/steps/${id}/run`, { state: "finished", runId: "r1", round: 1, commit: "abc" });
    expect(r.status).toBe(400);
    const sha256 = "c".repeat(64);
    expect((await w.api(alice, "POST", `/v1/steps/${id}/done`, { summary: "x", commit: sha256 })).status).toBe(200);
    expect((await stepOf(id)).rounds?.[0]?.commit).toBe(sha256);
  });
});

describe("RL-13 AC-04 offline", () => {
  it("test_AC04_offline_without_cache_sends_no_commit", async () => {
    commitIn(alice.repoDir);
    const id = await held();
    alice.store.pruneStepCache(Number.MAX_SAFE_INTEGER);
    await w.stopHub();
    const d = await w.tool(alice, 100, "mesh_done", { summary: "offline, no cache" });
    expect(d.isError, d.text).toBeFalsy();
    await w.startHubAgain();
    for (let i = 0; i < 3 && alice.daemon.status().hub !== "ok"; i++) {
      w.clock += 61_000;
      await alice.daemon.link?.flush();
    }
    expect(alice.daemon.status()).toMatchObject({ hub: "ok", queued: 0 });
    const st = await stepOf(id);
    expect(st.state).toBe("done");
    expect(st.rounds?.[0]?.commit).toBeUndefined();
  });

  it("test_AC04_offline_done_keeps_commit", async () => {
    const head = commitIn(alice.repoDir);
    const id = await held();
    await w.tool(alice, 100, "mesh_context");
    await w.stopHub();
    const d = await w.tool(alice, 100, "mesh_done", { summary: "offline" });
    expect(d.text).toContain("locally");
    const [G] = id.split(".");
    const local = readFileSync(join(alice.repoDir, `.mesh/goals/${G}/steps/a.md`), "utf8");
    expect((front(local).rounds as { commit?: string }[])[0]?.commit).toBe(head);
    await w.startHubAgain();
    for (let i = 0; i < 3 && alice.daemon.status().hub !== "ok"; i++) {
      w.clock += 61_000;
      await alice.daemon.link?.flush();
    }
    expect(alice.daemon.status()).toMatchObject({ hub: "ok", queued: 0 });
    expect((await stepOf(id)).rounds?.[0]?.commit).toBe(head);
  });
});

describe("RL-13 AC-06 run report rules", () => {
  it("test_AC06_run_report", async () => {
    const id = await held();
    const c = "d".repeat(40);
    // Checked before the step lookup: even an unknown step answers 400.
    expect((await w.api(alice, "POST", `/v1/steps/G999.x/run`, { state: "started", runId: "r", commit: c })).status).toBe(400);
    const started = await w.api(alice, "POST", `/v1/steps/${id}/run`, { state: "started", runId: "r", commit: c });
    expect(started.status).toBe(400);
    expect(started.json.error).toContain("commit needs a finished report with a round");
    expect((await w.api(alice, "POST", `/v1/steps/${id}/run`, { state: "finished", runId: "r", commit: c })).status).toBe(400);
    expect((await w.api(alice, "POST", `/v1/steps/${id}/done`, { summary: "x" })).status).toBe(200);
    expect((await stepOf(id)).rounds?.[0]?.commit).toBeUndefined();
    // Another user (not admin) may not set it.
    const bob = await w.login("root");
    const asRoot = await w.call(bob.token, "POST", `/v1/steps/${id}/run`, { state: "finished", runId: "r", round: 1, commit: c });
    expect(asRoot.status).toBe(200); // admin
    const carol = await w.login("carol");
    expect((await w.call(carol.token, "POST", `/v1/steps/${id}/run`, { state: "finished", runId: "r", round: 1, commit: "e".repeat(40) })).status).toBe(403);
    expect((await stepOf(id)).rounds?.[0]?.commit).toBe(c);
    // Only a commit: still updates; run.finished carries it.
    const c2 = "f".repeat(40);
    expect((await w.api(alice, "POST", `/v1/steps/${id}/run`, { state: "finished", runId: "r2", round: 1, commit: c2 })).status).toBe(200);
    expect((await stepOf(id)).rounds?.[0]?.commit).toBe(c2);
    const ev = (await w.hubStore.events(0, 100_000)).filter((e) => e.type === "run.finished" && e.step === id).at(-1);
    expect(ev?.payload.commit).toBe(c2);
  });
});

describe("RL-13 AC-08 step record and ledger", () => {
  it("test_AC08_record_and_schema", async () => {
    const head = commitIn(alice.repoDir);
    const id = await held();
    expect((await w.tool(alice, 100, "mesh_done", { summary: "x" })).isError).toBeFalsy();
    const [G] = id.split(".");
    const rec = front(readFileSync(join(alice.repoDir, `.mesh/goals/${G}/steps/a.md`), "utf8"));
    expect((rec.rounds as { commit?: string }[])[0]?.commit).toBe(head);
    expect(LedgerStep.safeParse(rec).success).toBe(true);
    const bad = { ...rec, rounds: [{ ...(rec.rounds as object[])[0], commit: "nothex" }] };
    expect(LedgerStep.safeParse(bad).success).toBe(false);

    const root = join(import.meta.dirname, "..");
    expect(readFileSync(join(root, "schemas/ledger-step.json"), "utf8")).toContain('"commit"');
    const api = JSON.parse(readFileSync(join(root, "schemas/hub-api.openapi.json"), "utf8")) as { paths: Record<string, Record<string, unknown>> };
    const op = (path: string, method: string) => JSON.stringify(api.paths[path]?.[method] ?? null);
    expect(op("/v1/steps/{id}/done", "post"), "DoneRequest").toContain('"commit"');
    expect(op("/v1/steps/{id}/run", "post"), "RunReport").toContain('"commit"');
    expect(op("/v1/runs", "get"), "RunRow").toContain('"commit"');
    expect(op("/v1/pulses/{id}/runs", "get"), "StageCard").toContain('"commit"');
  });
});

describe("RL-13 AC-09 mesh show, AC-10 features", () => {
  it("test_AC09_show", () => {
    const c = "0123456789abcdef0123456789abcdef01234567";
    const st: Step = { id: "G1.a", goal: "G1", planVersion: 1, kind: "implement", repo: "r", title: "a", brief: "b", deps: [], state: "done", fixCycles: 0, updatedAt: 0, rounds: [{ n: 1, user: "u", finishedAt: 1, outcome: "done", commit: c }] };
    const d: GoalDetail = { goal: { id: "G1", title: "t", ownerId: "u", state: "done", primaryRepo: "r", priority: 3, createdAt: 0, updatedAt: 0 }, plans: [], steps: [st] } as unknown as GoalDetail;
    expect(renderGoal(d)).toContain(c.slice(0, 9));
    expect(renderGoal(d)).not.toContain(c.slice(0, 10));
    const none = { ...d, steps: [{ ...st, rounds: [{ n: 1, user: "u", finishedAt: 1, outcome: "done" }] }] } as unknown as GoalDetail;
    expect(renderGoal(none)).not.toContain(c.slice(0, 9));
  });

  it("test_AC10_features", async () => {
    expect(HUB_FEATURES).toContain("commits");
    expect((await w.call(undefined as never, "GET", "/healthz")).json.features).toContain("commits");
  });
});
