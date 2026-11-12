// RL-5 hub side end to end (World, hub API): sync of repo copies, visibility, catalog sources, the
// push route, GET /v1/agents, resolve, plan/pulse validation, goal pins and offer data, R-6 for
// pulses. Criteria AC-05 (hub API part), AC-06 to AC-08, AC-10, AC-11, AC-18, AC-19, AC-25. Written
// from the spec's contracts only (docs/specs/RL-5.md). Groups by name, copies by key, sources by repo
// id, events by type. Hashes are computed by the test (roster-kit `H`).

import { afterEach, describe, expect, it } from "vitest";
import { body, builtinRelay, relayBody, REPO, REPO_ID, snap, type Bare } from "./helpers/pulse-kit.ts";
import {
  AARD,
  ALPHA,
  BETA,
  C1,
  C2,
  C3,
  copiesOf,
  copyOf,
  DELTA,
  GAMMA,
  groupOf,
  H,
  H1,
  H2,
  H3,
  HO,
  OTHER,
  rep,
  REV1,
  REV2,
  REV3,
  Rk,
  ROSTER_HL,
  RULE,
  sha,
  SRC,
  SRC2,
  SRC_URL,
  type Json,
} from "./helpers/roster-kit.ts";

let k: Rk;
afterEach(async () => {
  await k?.stop();
});
async function start(): Promise<Rk> {
  k = await Rk.start();
  return k;
}
const digestOf = (defs: Record<string, string>) =>
  sha(
    Object.entries(defs)
      .map(([n, t]) => `agents/${n}.md\t${H(t)}\n`)
      .sort()
      .join(""),
  );
const PROBLEMS = (ps: string[]) => `the plan has ${ps.length} problem(s): ${ps.join("; ")}`;

/** A web session of `user` (no machine on it): a fetch with its cookie. */
async function webCall(user: string, method: "GET" | "POST", path: string, b?: unknown): Promise<{ status: number; json: Json }> {
  const url = k.w.hub.url;
  const login = await fetch(`${url}/auth/team/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ token: `${user}-token-secret`, client: "web" }) });
  const cookie = (login.headers.get("set-cookie") ?? "").split(";")[0] as string;
  expect(cookie).toMatch(/^mesh_session=/);
  const res = await fetch(url + path, { method, headers: { "content-type": "application/json", cookie, origin: new URL(url).origin }, ...(b !== undefined ? { body: JSON.stringify(b) } : {}) });
  const text = await res.text();
  return { status: res.status, json: text ? JSON.parse(text) : undefined };
}

// ---------------------------------------------------------------------------------------------

describe("AC-05 sync (hub API)", () => {
  it("test_AC05_outside_inventory", async () => {
    await start();
    const m = await k.k.bare("ann", "ann-box", { repos: [ALPHA] });
    await k.report(m, [rep(ALPHA, "reviewer", REV1), rep(BETA, "reviewer", REV2)], { repos: [ALPHA] });
    const v = await k.view("ann");
    expect(copyOf(v, "alpha/reviewer"), JSON.stringify(v)).toMatchObject({ origin: "repo", hash: H1, machines: 1 });
    expect(copyOf(v, "beta/reviewer")).toBeUndefined();
  });

  it("test_AC05_events_only_on_change", async () => {
    await start();
    const m = await k.k.bare("ann", "ann-box", { repos: [ALPHA] });
    await k.report(m, [rep(ALPHA, "reviewer", REV1), rep(ALPHA, "other", OTHER)]);
    await k.report(m, [rep(ALPHA, "reviewer", REV1), rep(ALPHA, "other", OTHER)]);
    await k.report(m, undefined);
    let es = (await k.events("agents.reported")).filter((e) => e.payload?.machine === m.machine);
    expect(es.map((e) => e.payload)).toStrictEqual([{ machine: m.machine, count: 2 }]);
    await k.report(m, [rep(ALPHA, "reviewer", REV1)]);
    es = (await k.events("agents.reported")).filter((e) => e.payload?.machine === m.machine);
    expect(es.map((e) => e.payload.count)).toStrictEqual([2, 1]);
    expect(copyOf(await k.view("ann"), "alpha/other")).toBeUndefined();
    expect(copyOf(await k.view("ann"), "alpha/reviewer")).toBeDefined();
    // No texts, descriptions or paths in the payload.
    for (const e of es) expect(Object.keys(e.payload).sort()).toStrictEqual(["count", "machine"]);
  });

  it("test_AC05_old_daemon_steps", async () => {
    await start();
    const m = await k.k.bare("ann", "ann-box", { repos: [ALPHA] });
    await k.report(m, [rep(ALPHA, "reviewer", REV1)], { share: "me" });
    expect(copyOf(await k.view("ann"), "alpha/reviewer")).toBeDefined();
    // An older daemon switched to steps: no agents key.
    await k.report(m, undefined, { share: "steps" });
    expect(copyOf(await k.view("ann"), "alpha/reviewer")).toBeUndefined();
    expect(copyOf(await k.view("bob"), "alpha/reviewer")).toBeUndefined();
    // The rows were kept: back to `me` without an agents key shows the copy again.
    await k.report(m, undefined, { share: "me" });
    expect(copyOf(await k.view("ann"), "alpha/reviewer")).toBeDefined();
  });
});

// ---------------------------------------------------------------------------------------------

describe("AC-06 visibility", () => {
  it("test_AC06_me_then_all", async () => {
    await start();
    await k.catalog({ rev: REV1 });
    const m = await k.k.bare("ann", "ann-box", { repos: [ALPHA] });
    await k.report(m, [rep(ALPHA, "reviewer", REV2)], { share: "me" });
    const asAnn = await k.view("ann");
    expect(copyOf(asAnn, "alpha/reviewer")).toMatchObject({ origin: "repo" });
    expect(copyOf(asAnn, "agents/rev")).toMatchObject({ origin: "catalog" });
    const asBob = await k.view("bob");
    expect(copyOf(asBob, "agents/rev")).toMatchObject({ origin: "catalog" });
    expect(copyOf(asBob, "alpha/reviewer")).toBeUndefined();
    await k.report(m, undefined, { share: "all" });
    expect(copyOf(await k.view("bob"), "alpha/reviewer")).toMatchObject({ origin: "repo" });
    const R = await k.w.hub.svc.serviceToken("reader", ["goals:read"]);
    const svc = await k.w.call(R, "GET", "/v1/agents");
    expect(svc.status, JSON.stringify(svc.json)).toBe(200);
    expect(copyOf(svc.json, "agents/rev")).toMatchObject({ origin: "catalog" });
  });
});

// ---------------------------------------------------------------------------------------------

describe("AC-07 catalog source route", () => {
  it("test_AC07_member_403", async () => {
    await start();
    expect((await k.source(SRC_URL, "agents", "ann")).status).toBe(403);
    expect(await k.events("catalog.saved")).toStrictEqual([]);
    // Control: an admin may.
    expect((await k.source(SRC_URL, "agents", "root")).status).toBe(201);
  });

  it("test_AC07_admin_create_replace", async () => {
    await start();
    const first = await k.source();
    expect(first.status, JSON.stringify(first.json)).toBe(201);
    expect(first.json).toMatchObject({ repo: SRC, name: "agents", folder: "agents", createdBy: "root", count: 0 });
    expect(typeof first.json.createdAt).toBe("number");
    expect("commit" in first.json).toBe(false);
    expect((await k.events("catalog.saved")).map((e) => e.payload)).toStrictEqual([{ repo: SRC, folder: "agents" }]);
    const m = await k.pusher();
    const pushed = await k.pushOk(m, C1, { rev: REV1, other: OTHER });
    k.w.clock += 1000;
    const again = await k.source(SRC_URL, "defs", "carol", { calibrator: "carol" });
    expect(again.status, JSON.stringify(again.json)).toBe(200);
    expect(again.json).toMatchObject({ repo: SRC, folder: "defs", calibrator: "carol", createdBy: "root", createdAt: first.json.createdAt });
    expect(again.json).toMatchObject({ commit: C1, digest: pushed.source.digest, count: 2 });
    expect(await k.events("catalog.saved")).toHaveLength(2);
    const idForm = await k.source("Git.Example.com/Team/X.git", "agents");
    expect(idForm.status, JSON.stringify(idForm.json)).toBe(201);
    expect(idForm.json.repo).toBe("git.example.com/team/x");
  });

  it("test_AC07_422_texts", async () => {
    await start();
    expect(await k.source("nope", "agents")).toStrictEqual({ status: 422, json: { error: "repo must be a repo id (host/path) or a remote URL" } });
    for (const folder of ["../x", "a/./b", "/abs", "a/../b"]) expect(await k.source(SRC_URL, folder), folder).toStrictEqual({ status: 422, json: { error: "folder must be a relative path inside the repo" } });
    const tilde = await k.source("https://git.example.com/team/a~b.git", "agents");
    expect(tilde.status).toBe(422);
    expect(tilde.json.error.startsWith("repo id ")).toBe(true);
    expect(tilde.json.error.endsWith(" cannot be used in an agent key")).toBe(true);
    expect(tilde.json.error).toContain("a~b");
    expect(await k.events("catalog.saved")).toStrictEqual([]);
    // Control: a valid save.
    expect((await k.source(SRC_URL, "agents/sub")).status).toBe(201);
  });

  // Source ids are capped at CATALOG_REPO_MAX (200) so every full-id roster key fits ROSTER_KEY_MAX.
  it("test_AC07_repo_id_over_200", async () => {
    await start();
    const long = `git.example.com/team/${"a".repeat(200 - 21)}`;
    expect(long).toHaveLength(200);
    const over = `${long}b`;
    expect(await k.source(over, "agents")).toStrictEqual({ status: 422, json: { error: `repo id ${over} is over 200 characters` } });
    expect(await k.events("catalog.saved")).toStrictEqual([]);
    // Control: exactly 200 characters is registered.
    const ok = await k.source(long, "agents");
    expect(ok.status, JSON.stringify(ok.json)).toBe(201);
    expect(ok.json.repo).toBe(long);
  });

  it("test_AC07_reregister_keeps_calibrator", async () => {
    await start();
    expect((await k.source(SRC_URL, "agents", "root", { calibrator: "carol" })).status).toBe(201);
    k.w.clock += 1000;
    const again = await k.source(SRC_URL, "defs");
    expect(again.status, JSON.stringify(again.json)).toBe(200);
    expect(again.json).toMatchObject({ repo: SRC, folder: "defs", calibrator: "carol" });
    const listed = ((await k.call("ann", "GET", "/v1/catalog-sources")).json.sources as Json[]).find((s) => s.repo === SRC);
    expect(listed).toMatchObject({ folder: "defs", calibrator: "carol" });
    // Control: a body with `calibrator` replaces it.
    expect((await k.source(SRC_URL, "defs", "root", { calibrator: "bob" })).json.calibrator).toBe("bob");
  });

  it("test_AC07_list", async () => {
    await start();
    await k.sourceOk("git.example.com/zed/agents", "agents");
    await k.sourceOk(SRC_URL, "agents");
    const l = await k.call("ann", "GET", "/v1/catalog-sources");
    expect(l.status, JSON.stringify(l.json)).toBe(200);
    expect((l.json.sources as Json[]).map((s) => s.repo)).toStrictEqual([SRC, "git.example.com/zed/agents"]);
  });
});

// ---------------------------------------------------------------------------------------------

describe("AC-08 push route", () => {
  it("test_AC08_refusals", async () => {
    await start();
    await k.sourceOk();
    const m = await k.pusher();
    const web = await webCall("root", "POST", "/v1/catalog-sources/push", { repo: SRC, commit: C1, defs: [{ path: "agents/rev.md", text: REV1 }] });
    expect(web).toStrictEqual({ status: 403, json: { error: "a catalog push needs a device token" } });
    expect(await k.push(m, C1, { rev: REV1 }, "git.example.com/team/none")).toStrictEqual({ status: 404, json: { error: "no catalog source git.example.com/team/none" } });
    const lacks = await k.pusher("root", [ALPHA], "root-other");
    expect(await k.push(lacks, C1, { rev: REV1 })).toStrictEqual({ status: 403, json: { error: `this machine does not report ${SRC} in its repo inventory` } });
    for (const path of ["agents/x/y.md", "agents/bad name.md", "other/rev.md", "agents/rev.txt"]) {
      const res = await k.w.call(m.token, "POST", "/v1/catalog-sources/push", { repo: SRC, commit: C1, defs: [{ path, text: REV1 }] });
      expect(res, path).toStrictEqual({ status: 422, json: { error: `catalog push: ${path} is not agents/<name>.md` } });
    }
    const twice = await k.w.call(m.token, "POST", "/v1/catalog-sources/push", { repo: SRC, commit: C1, defs: [{ path: "agents/rev.md", text: REV1 }, { path: "agents/rev.md", text: REV2 }] });
    expect(twice).toStrictEqual({ status: 422, json: { error: "catalog push: agents/rev.md appears twice" } });
    const many = Object.fromEntries(Array.from({ length: 100 }, (_, i) => [`a${i}`, "x".repeat(80_001)]));
    expect(await k.push(m, C1, many)).toStrictEqual({ status: 422, json: { error: "catalog push: texts total 8000100 characters, over 8000000" } });
    expect(await k.events("catalog.pushed")).toStrictEqual([]);
    const src = ((await k.call("ann", "GET", "/v1/catalog-sources")).json.sources as Json[]).find((s) => s.repo === SRC);
    expect("commit" in src).toBe(false);
    // Exactly 8 000 000 characters is allowed.
    const exact = Object.fromEntries(Array.from({ length: 80 }, (_, i) => [`b${i}`, "y".repeat(100_000)]));
    const ok = await k.push(m, C1, exact);
    expect(ok.status, JSON.stringify(ok.json).slice(0, 300)).toBe(200);
  });

  it("test_AC08_valid_pushes", async () => {
    await start();
    await k.sourceOk();
    const m = await k.pusher();
    const first = await k.pushOk(m, C1, { rev: REV1, other: OTHER });
    expect(first.added).toBe(2);
    expect(first.source).toMatchObject({ repo: SRC, count: 2, commit: C1, digest: digestOf({ rev: REV1, other: OTHER }), pushedBy: "root", pushedAt: k.w.clock });
    let es = await k.events("catalog.pushed");
    expect(es.map((e) => e.payload)).toStrictEqual([{ repo: SRC, commit: C1, added: 2, count: 2 }]);
    k.w.clock += 1000;
    const second = await k.pushOk(m, C2, { rev: REV2 });
    expect(second.added).toBe(1);
    expect(second.source).toMatchObject({ count: 1, commit: C2, digest: digestOf({ rev: REV2 }) });
    es = await k.events("catalog.pushed");
    expect(es.map((e) => e.payload)).toStrictEqual([
      { repo: SRC, commit: C1, added: 2, count: 2 },
      { repo: SRC, commit: C2, added: 1, count: 1 },
    ]);
    expect(await k.resolve("ann", "agents/other")).toStrictEqual({ status: 404, json: { error: `no agent other in catalog source ${SRC}` } });
    const old = await k.resolve("ann", `agents/other@${HO.slice(0, 12)}`);
    expect(old.status, JSON.stringify(old.json)).toBe(200);
    expect(old.json).toMatchObject({ text: OTHER, hash: HO, current: false });
  });
});

// ---------------------------------------------------------------------------------------------

describe("AC-10 GET /v1/agents", () => {
  const RV = (n: number) => REV1.replace("You review.", `You review ${n}.`);
  const [R1, R2, R3] = [RV(1), RV(2), RV(3)];
  const pin = { source: SRC, commit: C1, hash: H(R1) };

  async function fixture(): Promise<{ m1: Bare; m2: Bare; pushedAt: number; t2: number }> {
    await start();
    await k.sourceOk();
    const p = await k.pusher();
    await k.pushOk(p, C1, { reviewer: R1 });
    k.w.clock += 1000;
    await k.pushOk(p, C3, { reviewer: R3 });
    const pushedAt = k.w.clock;
    k.w.clock += 1000;
    const m1 = await k.k.bare("ann", "ann-box", { repos: [ALPHA, BETA, GAMMA, AARD] });
    await k.report(
      m1,
      [
        rep(ALPHA, "reviewer", R1, { pin }),
        rep(BETA, "reviewer", R2, { pin }),
        rep(GAMMA, "reviewer", R2),
        rep(GAMMA, "reviewer", R2, { kind: "opencode", path: ".opencode/agent/reviewer.md" }),
        rep(AARD, "reviewer", R3, { description: "Aard copy" }),
      ],
      { share: "all" },
    );
    k.w.clock += 1000;
    const t2 = k.w.clock;
    const m2 = await k.k.bare("bob", "bob-box", { repos: [ALPHA] });
    await k.report(m2, [rep(ALPHA, "reviewer", R1, { pin })], { share: "all" });
    return { m1, m2, pushedAt, t2 };
  }

  it("test_AC10_group_flags", async () => {
    const f = await fixture();
    const v = await k.view("ann");
    const g = groupOf(v, "reviewer");
    expect(g).toMatchObject({ name: "reviewer", diverged: true, pinned: true, behind: true, modified: true });
    const alpha = copyOf(v, "alpha/reviewer");
    expect(alpha).toMatchObject({ origin: "repo", kind: "claude", hash: H(R1), pinned: true, behind: true, modified: false, machines: 2, seenAt: f.t2, pin, repo: { id: ALPHA, name: "alpha" }, path: ".claude/agents/reviewer.md" });
    expect(copyOf(v, "beta/reviewer")).toMatchObject({ pinned: true, modified: true, behind: true });
    const gammaC = copyOf(v, "gamma/reviewer", "claude");
    expect(gammaC).toMatchObject({ pinned: false, modified: false, behind: false });
    const cat = copyOf(v, "agents/reviewer");
    expect(cat).toMatchObject({ origin: "catalog", commit: C3, seenAt: f.pushedAt, hash: H(R3), pinned: false, behind: false, modified: false, repo: { id: SRC, name: "agents" } });
    expect(groupOf(v, "reviewer").versions.find((x: Json) => x.hash === H(R3)).copies[0].key).toBe("agents/reviewer");
    expect(v.sources.map((s: Json) => s.repo)).toStrictEqual([SRC]);
  });

  it("test_AC10_order", async () => {
    const f = await fixture();
    const v = await k.view("ann");
    const g = groupOf(v, "reviewer");
    expect(g.versions.map((x: Json) => x.hash)).toStrictEqual([H(R2), H(R3), H(R1)]);
    const h2 = g.versions[0].copies.map((c: Json) => `${c.key}:${c.kind}`);
    expect(h2).toStrictEqual(["beta/reviewer:claude", "gamma/reviewer:claude", "gamma/reviewer:opencode"]);
    const h3 = g.versions[1];
    expect(h3.copies.map((c: Json) => c.key)).toStrictEqual(["agents/reviewer", "aardvark/reviewer"]);
    expect(h3.description).toBe("Reviews code");
    expect(g.versions[2].copies).toHaveLength(1);
    // A tie of copies is ordered by hash.
    k.w.clock += 1000;
    await k.report(
      f.m1,
      [
        rep(ALPHA, "reviewer", R1, { pin }),
        rep(BETA, "reviewer", R2, { pin }),
        rep(GAMMA, "reviewer", R2),
        rep(GAMMA, "reviewer", R2, { kind: "opencode", path: ".opencode/agent/reviewer.md" }),
        rep(AARD, "reviewer", R3, { description: "Aard copy" }),
        rep(DELTA, "reviewer", R1),
        rep(ALPHA, "zeta", OTHER),
        rep(ALPHA, "other", OTHER),
      ],
      { share: "all", repos: [ALPHA, BETA, GAMMA, AARD, DELTA] },
    );
    const v2 = await k.view("ann");
    const tie = [H(R1), H(R3)].sort();
    expect(groupOf(v2, "reviewer").versions.map((x: Json) => x.hash)).toStrictEqual([H(R2), ...tie]);
    expect((v2.agents as Json[]).map((x) => x.name)).toStrictEqual(["other", "reviewer", "zeta"]);
    expect(groupOf(v2, "zeta")).toMatchObject({ diverged: false, pinned: false, behind: false, modified: false });
  });

  it("test_AC10_filter_sources", async () => {
    await fixture();
    expect((await k.view("ann")).agents.length).toBeGreaterThanOrEqual(1);
    const none = await k.view("ann", "?name=other-name");
    expect(none.agents).toStrictEqual([]);
    expect(none.sources.map((s: Json) => s.repo)).toStrictEqual([SRC]);
    const only = await k.view("ann", "?name=reviewer");
    expect(only.agents.map((g: Json) => g.name)).toStrictEqual(["reviewer"]);
    expect(copiesOf(only).length).toBe(6);
  });
});

// ---------------------------------------------------------------------------------------------

describe("AC-11 resolve", () => {
  async function fixture(): Promise<Bare> {
    await start();
    await k.sourceOk();
    const m = await k.pusher();
    await k.pushOk(m, C1, { rev: REV1 });
    k.w.clock += 1000;
    await k.pushOk(m, C2, { rev: REV2 });
    return m;
  }

  it("test_AC11_current_and_refs", async () => {
    const m = await fixture();
    const cur = await k.resolve("ann", "agents/rev");
    expect(cur.status, JSON.stringify(cur.json)).toBe(200);
    expect(cur.json).toMatchObject({ key: "agents/rev", source: SRC, name: "rev", path: "agents/rev.md", hash: H2, commit: C2, commits: [C2], current: true, text: REV2, description: "Reviews code", model: "sonnet", tools: ["Read", "Grep"], rules: ["r.alpha", "r.beta"] });
    const byCommit = await k.resolve("ann", `agents/rev@${C1.slice(0, 7)}`);
    expect(byCommit.json).toMatchObject({ hash: H1, commit: C1, current: false, text: REV1 });
    expect((await k.resolve("ann", `agents/rev@${H1.slice(0, 12)}`)).json).toMatchObject({ hash: H1 });
    expect((await k.resolve("ann", `${SRC}/rev`)).json).toMatchObject({ hash: H2, commit: C2 });
    // A third push with the same text: the matched commit vs the newest.
    k.w.clock += 1000;
    await k.pushOk(m, C3, { rev: REV2 });
    expect((await k.resolve("ann", `agents/rev@${C2.slice(0, 7)}`)).json).toMatchObject({ hash: H2, commit: C2, commits: [C2, C3] });
    expect((await k.resolve("ann", "agents/rev")).json).toMatchObject({ hash: H2, commit: C3 });
  });

  it("test_AC11_errors", async () => {
    const m = await fixture();
    expect(await k.resolve("ann")).toStrictEqual({ status: 400, json: { error: RULE } });
    expect(await k.resolve("ann", "a/b@xyz")).toStrictEqual({ status: 400, json: { error: RULE } });
    expect(await k.resolve("ann", "nosuch/rev")).toStrictEqual({ status: 404, json: { error: "no catalog source matches nosuch" } });
    expect(await k.resolve("ann", "agents/nope")).toStrictEqual({ status: 404, json: { error: `no agent nope in catalog source ${SRC}` } });
    expect(await k.resolve("ann", "agents/rev@0000000")).toStrictEqual({ status: 404, json: { error: "no definition of agents/rev matches @0000000" } });
    // Two pushes whose commits share the prefix abcdef1, with different texts.
    await k.pushOk(m, `abcdef1a${"0".repeat(32)}`, { rev: REV3 });
    await k.pushOk(m, `abcdef1b${"0".repeat(32)}`, { rev: REV1.replace("You review.", "You review again.") });
    expect(await k.resolve("ann", "agents/rev@abcdef1")).toStrictEqual({ status: 409, json: { error: "@abcdef1 matches 2 definitions of agents/rev; give more characters" } });
    expect((await k.resolve("ann", "agents/rev@abcdef1a")).json).toMatchObject({ hash: H3 });
    // A second source with the same last segment.
    await k.sourceOk(SRC2, "agents");
    const amb = await k.resolve("ann", "agents/rev");
    expect(amb.status).toBe(409);
    const prefix = "agents matches 2 catalog sources: ";
    expect(amb.json.error.startsWith(prefix), amb.json.error).toBe(true);
    expect(new Set(amb.json.error.slice(prefix.length).split(/,\s*/))).toStrictEqual(new Set([SRC, SRC2]));
    // The full id still resolves.
    expect((await k.resolve("ann", `${SRC}/rev`)).status).toBe(200);
  });
});

// ---------------------------------------------------------------------------------------------

describe("AC-18 validation", () => {
  const step = (o: Record<string, unknown>) => ({ id: "audit", repo: REPO, kind: "review", title: "Audit", brief: "b", deps: [], ...o });
  async function goal(): Promise<string> {
    const g = await k.call("ann", "POST", "/v1/goals", { title: "roster goal", primaryRepo: REPO });
    expect(g.status, JSON.stringify(g.json)).toBe(201);
    return g.json.id as string;
  }
  const plan = (G: string, steps: unknown[], approve = true) => k.call("ann", "POST", `/v1/goals/${G}/plan`, { steps, approve });

  it("test_AC18_plan_ok", async () => {
    await start();
    await k.catalog();
    const G = await goal();
    const res = await plan(G, [step({ mode: "headless", agent: "agents/rev" })]);
    expect(res.status, JSON.stringify(res.json)).toBe(201);
    expect((await k.k.step(`${G}.audit`)).policy).toMatchObject({ mode: "headless", agent: "agents/rev" });
  });

  it("test_AC18_plan_errors", async () => {
    await start();
    await k.catalog();
    const G = await goal();
    const bad = await plan(G, [step({ mode: "headless", agent: "nosuch/rev" })]);
    expect(bad.status).toBe(422);
    expect(bad.json.details).toContain('step "audit": no catalog source matches nosuch');
    const noMode = await plan(G, [step({ agent: "agents/rev" })]);
    expect(noMode.status).toBe(422);
    expect(noMode.json.details).toContain('step "audit": profile, budget and agent need mode: headless');
    // Goal creation makes the design step; no step of the refused plan exists.
    expect((((await k.k.goal(G)).steps ?? []) as Json[]).filter((s) => s.id !== `${G}.design`)).toStrictEqual([]);
  });

  it("test_AC18_pulse_and_preset", async () => {
    await start();
    await k.catalog();
    const nope = body({ params: { repo: REPO, agent: "agents/nope" } }, "roster", ROSTER_HL);
    const want = `step "run": no agent nope in catalog source ${SRC}`;
    const p = await k.k.pulse("ann", nope);
    expect(p.status, JSON.stringify(p.json)).toBe(422);
    expect(p.json.details).toContain(want);
    const ingest = { preset: snap("roster", ROSTER_HL), params: { repo: REPO, agent: "agents/nope" } };
    const g = await k.call("ann", "POST", "/v1/goals/from-preset", ingest);
    expect(g.status, JSON.stringify(g.json)).toBe(422);
    expect(g.json.details).toContain(want);
    expect((await k.call("ann", "GET", "/v1/pulses")).json.pulses).toStrictEqual([]);
    // Control: the catalog agent.
    expect((await k.k.pulse("ann", body({ params: { repo: REPO, agent: "agents/rev" } }, "roster", ROSTER_HL))).status).toBe(201);
    expect((await k.call("ann", "POST", "/v1/goals/from-preset", { ...ingest, params: { repo: REPO, agent: "agents/rev" } })).status).toBe(201);
  });
});

// ---------------------------------------------------------------------------------------------

describe("AC-19 goal pins and offer data", () => {
  const step = (id: string, agent: string) => ({ id, repo: REPO, kind: "review", title: `T ${id}`, brief: "b", deps: [], mode: "headless", agent });
  const pinOf = (hash: string, commit: string) => ({ key: "agents/rev", source: SRC, name: "rev", hash, commit });
  interface F {
    A: Bare;
    pusher: Bare;
    G: string;
  }
  async function fixture(steps: unknown[]): Promise<F> {
    await start();
    const pusher = await k.catalog({ rev: REV1 });
    const A = await k.k.bare("ann", "hl-a", { headless: true });
    const g = await k.call("ann", "POST", "/v1/goals", { title: "roster goal", primaryRepo: REPO });
    const G = g.json.id as string;
    const res = await k.call("ann", "POST", `/v1/goals/${G}/plan`, { steps, approve: true });
    expect(res.status, JSON.stringify(res.json)).toBe(201);
    return { A, pusher, G };
  }
  const storedGoal = async (G: string): Promise<Json> => k.w.hubStore.getGoal(G);
  async function offer(f: F, id: string): Promise<Json> {
    const a = await k.call("ann", "POST", `/v1/steps/${id}/assign`, { to: f.A.machine });
    expect(a.status, JSON.stringify(a.json)).toBe(200);
    const ms = (await k.k.inbox(f.A.token)).filter((m) => m.kind === "offer" && m.data?.step === id);
    expect(ms, `offer of ${id}`).toHaveLength(1);
    return ms[0].data;
  }

  it("test_AC19_pin_on_approve", async () => {
    const f = await fixture([step("audit", "agents/rev")]);
    expect((await storedGoal(f.G)).agents).toStrictEqual({ "agents/rev": pinOf(H1, C1) });
    const d = await offer(f, `${f.G}.audit`);
    expect(d.agent).toBe("agents/rev");
    expect(d.agentDef).toStrictEqual(pinOf(H1, C1));
    expect("agentError" in d).toBe(false);
  });

  it("test_AC19_offer_stable", async () => {
    const f = await fixture([step("audit", "agents/rev"), step("again", "agents/rev")]);
    expect((await offer(f, `${f.G}.audit`)).agentDef.hash).toBe(H1);
    k.w.clock += 1000;
    await k.pushOk(f.pusher, C2, { rev: REV2 });
    await k.sourceOk(SRC2, "agents");
    const d = await offer(f, `${f.G}.again`);
    expect(d.agentDef).toStrictEqual(pinOf(H1, C1));
    expect("agentError" in d).toBe(false);
  });

  it("test_AC19_ref_and_v2", async () => {
    const f = await fixture([step("audit", "agents/rev")]);
    k.w.clock += 1000;
    await k.pushOk(f.pusher, C2, { rev: REV2 });
    k.w.clock += 1000;
    await k.pushOk(f.pusher, C3, { rev: REV3 });
    const ref = `agents/rev@${C1.slice(0, 7)}`;
    const byHash = `agents/rev@${H2.slice(0, 12)}`;
    const v2 = await k.call("ann", "POST", `/v1/goals/${f.G}/plan`, { steps: [step("audit", "agents/rev"), step("old", ref), step("mid", byHash)], approve: true });
    expect(v2.status, JSON.stringify(v2.json)).toBe(201);
    const agents = (await storedGoal(f.G)).agents;
    expect(agents["agents/rev"]).toStrictEqual(pinOf(H1, C1));
    expect(agents[ref]).toStrictEqual(pinOf(H1, C1));
    expect(agents[byHash]).toStrictEqual(pinOf(H2, C2));
    expect(Object.keys(agents).sort()).toStrictEqual(["agents/rev", byHash, ref].sort());
    expect((await offer(f, `${f.G}.mid`)).agentDef.hash).toBe(H2);
  });

  // A key already pinned on the goal is checked against that pin, not the source's current content.
  it("test_AC19_v2_repeats_pinned_key", async () => {
    const f = await fixture([step("audit", "agents/rev")]);
    k.w.clock += 1000;
    // rev leaves the source.
    await k.pushOk(f.pusher, C2, { other: OTHER });
    expect((await k.resolve("ann", "agents/rev")).status).toBe(404);
    const v2 = await k.call("ann", "POST", `/v1/goals/${f.G}/plan`, { steps: [step("audit", "agents/rev"), step("again", "agents/rev")] });
    expect(v2.status, JSON.stringify(v2.json)).toBe(201);
    const ap = await k.call("ann", "POST", `/v1/goals/${f.G}/approve`, {});
    expect(ap.status, JSON.stringify(ap.json)).toBe(200);
    expect((await storedGoal(f.G)).agents).toStrictEqual({ "agents/rev": pinOf(H1, C1) });
    expect((await offer(f, `${f.G}.again`)).agentDef).toStrictEqual(pinOf(H1, C1));
  });

  it("test_AC19_approve_fails", async () => {
    const f = await fixture([step("audit", "agents/rev")]);
    await k.pushOk(f.pusher, C2, { rev: REV1, rev2: OTHER });
    const g = await k.call("ann", "POST", "/v1/goals", { title: "later", primaryRepo: REPO });
    const G = g.json.id as string;
    const proposed = await k.call("ann", "POST", `/v1/goals/${G}/plan`, { steps: [step("audit", "agents/rev2")] });
    expect(proposed.status, JSON.stringify(proposed.json)).toBe(201);
    // rev2 is dropped between propose and approve.
    await k.pushOk(f.pusher, C3, { rev: REV1 });
    const ap = await k.call("ann", "POST", `/v1/goals/${G}/approve`, {});
    expect(ap.status, JSON.stringify(ap.json)).toBe(422);
    const problem = `step "audit": no agent rev2 in catalog source ${SRC}`;
    expect(ap.json.error).toBe(PROBLEMS([problem]));
    const d = await k.k.goal(G);
    expect(d.plans.at(-1).decision).not.toBe("approved");
    expect((await storedGoal(G)).agents?.["agents/rev2"]).toBeUndefined();
    // The goal's own design step is ready from creation; no step of the refused plan is.
    expect(((d.steps ?? []) as Json[]).filter((s) => s.state === "ready" && s.id !== `${G}.design`)).toStrictEqual([]);
    // Control: once rev2 is back, the approval pins it.
    await k.pushOk(f.pusher, `${"d".repeat(40)}`, { rev: REV1, rev2: OTHER });
    const ok = await k.call("ann", "POST", `/v1/goals/${G}/approve`, {});
    expect(ok.status, JSON.stringify(ok.json)).toBe(200);
    expect((await storedGoal(G)).agents["agents/rev2"]).toMatchObject({ name: "rev2", hash: HO });
  });

  it("test_AC19_not_pinned_and_rl1", async () => {
    const f = await fixture([step("audit", "agents/rev"), step("plain", "auditor")]);
    const g = await storedGoal(f.G);
    expect(g.agents["agents/rev"]).toBeDefined();
    delete g.agents["agents/rev"];
    await k.w.hubStore.saveGoal(g);
    const d = await offer(f, `${f.G}.audit`);
    expect(d.agentError).toBe(`agents/rev is not pinned in ${f.G}`);
    expect("agentDef" in d).toBe(false);
    expect(d.agent).toBe("agents/rev");
    const rl1 = await offer(f, `${f.G}.plain`);
    expect(rl1.agent).toBe("auditor");
    expect("agentDef" in rl1).toBe(false);
    expect("agentError" in rl1).toBe(false);
  });
});

// ---------------------------------------------------------------------------------------------

describe("AC-25 R-6 for pulses", () => {
  const roster = (o: Record<string, unknown> = {}) => body({ overlap: "allow", params: { repo: REPO, agent: "agents/rev" }, ...o }, "roster", ROSTER_HL);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- new store fields, read loosely
  const storedPulse = async (id: string): Promise<Json> => (k.w.hubStore as any).getPulse(id);
  async function fireOffer(A: Bare): Promise<{ G: string; data: Json }> {
    const G = (await k.k.fireOk("ann", "p-1")).goal as string;
    const ms = (await k.k.inbox(A.token)).filter((m) => m.kind === "offer" && m.data?.step === `${G}.run`);
    expect(ms, `offer of ${G}.run`).toHaveLength(1);
    return { G, data: ms[0].data };
  }
  async function setup(): Promise<{ A: Bare; pusher: Bare; view: Json }> {
    await start();
    const pusher = await k.catalog({ rev: REV1 });
    const view = await k.k.pulseOk("ann", roster());
    const A = await k.k.bare("ann", "hl-a", { headless: true, repos: [REPO_ID] });
    return { A, pusher, view };
  }

  it("test_AC25_pulse_pins", async () => {
    const { view } = await setup();
    expect(view.agents).toStrictEqual({ "agents/rev": H1 });
    expect((await storedPulse(view.id)).agents["agents/rev"]).toStrictEqual({ key: "agents/rev", source: SRC, name: "rev", hash: H1, commit: C1 });
    // The pulse detail carries the stored pulse, whose agents are full AgentDefs (as profiles are full snapshots).
    expect((await k.k.pulseOf(view.id)).agents).toStrictEqual({ "agents/rev": { key: "agents/rev", source: SRC, name: "rev", hash: H1, commit: C1 } });
    const ing = await k.call("ann", "POST", "/v1/goals/from-preset", { preset: snap("roster", ROSTER_HL), params: { repo: REPO, agent: "agents/rev" } });
    expect(ing.status, JSON.stringify(ing.json)).toBe(201);
    expect(((await k.w.hubStore.getGoal(ing.json.goal.id)) as Json).agents["agents/rev"]).toStrictEqual({ key: "agents/rev", source: SRC, name: "rev", hash: H1, commit: C1 });
  });

  it("test_AC25_fire_keeps_pin", async () => {
    const { A, pusher } = await setup();
    await k.pushOk(pusher, C2, { rev: REV2 });
    const one = await fireOffer(A);
    expect(((await k.w.hubStore.getGoal(one.G)) as Json).agents["agents/rev"].hash).toBe(H1);
    expect(one.data.agentDef.hash).toBe(H1);
    const upd = await k.k.act("ann", "p-1", "update", { window: "2h" });
    expect(upd.status, JSON.stringify(upd.json)).toBe(200);
    expect(upd.json.agents).toStrictEqual({ "agents/rev": H1 });
    expect((await storedPulse("p-1")).agents["agents/rev"].hash).toBe(H1);
    const two = await fireOffer(A);
    expect(two.data.agentDef.hash).toBe(H1);
  });

  it("test_AC25_update_params_repins", async () => {
    const { A, pusher } = await setup();
    await k.pushOk(pusher, C2, { rev: REV2 });
    const upd = await k.k.act("ann", "p-1", "update", { params: { repo: REPO, agent: "agents/rev", note: "v2" } });
    expect(upd.status, JSON.stringify(upd.json)).toBe(200);
    expect(upd.json.agents).toStrictEqual({ "agents/rev": H2 });
    expect((await fireOffer(A)).data.agentDef).toStrictEqual({ key: "agents/rev", source: SRC, name: "rev", hash: H2, commit: C2 });
    // A preset change re-pins too.
    await k.pushOk(pusher, C3, { rev: REV3 });
    const text = ROSTER_HL.replace("One roster step", "One roster step, v2");
    const p2 = await k.k.act("ann", "p-1", "update", { preset: snap("roster", text) });
    expect(p2.status, JSON.stringify(p2.json)).toBe(200);
    expect(p2.json.agents).toStrictEqual({ "agents/rev": H3 });
    expect((await fireOffer(A)).data.agentDef.hash).toBe(H3);
  });
});

// ---------------------------------------------------------------------------------------------

// RL-7 AC-08 (hub part) and AC-18 (World): invalid agent front matter on the roster and the catalog
// (docs/specs/RL-7.md, Agent front matter). The `invalid` text is not computed here: a hub-side test
// checks its documented prefix and `line 2`, and compares catalog and report texts with each other.
describe("RL-7 invalid agents (hub)", () => {
  /** Line 2 of the front matter is not valid YAML. */
  const BAD = "---\nname: bad\ndescription: Validates: findings\n---\nYou validate.\n";
  const GOOD = "---\ndescription: Good agent\n---\nYou review.\n";
  const INV = "front matter is not valid YAML: sample at line 2, column 14";
  const isInvalidText = (s: unknown) => typeof s === "string" && s.startsWith("front matter is not valid YAML: ") && s.includes("line 2");

  it("test_AC08_groups_from_report", async () => {
    await start();
    const m = await k.k.bare("ann", "ann-box", { repos: [ALPHA] });
    await k.report(m, [rep(ALPHA, "bad", BAD, { invalid: INV }), rep(ALPHA, "good", GOOD, { description: "Good agent" })]);
    const v = await k.view("ann");
    const bad = groupOf(v, "bad");
    const good = groupOf(v, "good");
    // Control: both groups are listed.
    expect(bad, JSON.stringify(v.agents)).toBeDefined();
    expect(good).toBeDefined();
    expect(good.versions[0].description).toBe("Good agent");
    expect(bad.invalid).toBe(true);
    expect(bad.versions).toHaveLength(1);
    expect(bad.versions[0]).toMatchObject({ hash: H(BAD), invalid: INV });
    expect(good.invalid).toBe(false);
    for (const x of good.versions as Json[]) expect(x.invalid).toBeUndefined();
  });

  it("test_AC08_catalog_resolve", async () => {
    await start();
    await k.catalog({ bad: BAD, good: GOOD });
    const bad = await k.resolve("ann", "agents/bad");
    expect(bad.status, JSON.stringify(bad.json)).toBe(200);
    expect(bad.json).toMatchObject({ key: "agents/bad", hash: H(BAD), text: BAD });
    expect(isInvalidText(bad.json.invalid), String(bad.json.invalid)).toBe(true);
    for (const f of ["description", "tools", "model", "rules"]) expect(bad.json[f], f).toBeUndefined();
    // Control: the valid definition resolves with its description and no `invalid`.
    const good = await k.resolve("ann", "agents/good");
    expect(good.json).toMatchObject({ key: "agents/good", description: "Good agent" });
    expect(good.json.invalid).toBeUndefined();
    // GET /v1/agents shows the catalog version as invalid too.
    const v = await k.view("ann");
    expect(groupOf(v, "bad")).toMatchObject({ invalid: true });
    expect(groupOf(v, "bad").versions[0].invalid).toBe(bad.json.invalid);
    expect(groupOf(v, "good").invalid).toBe(false);
  });

  it("test_AC18_world_repush", async () => {
    await start();
    await k.sourceOk();
    const m = await k.pusher();
    // As v0.1.20 stored the invalid file: `front: {}`.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- store method, read loosely
    await (k.w.hubStore as any).putCatalogDefs(SRC, C1, [{ path: "agents/bad.md", name: "bad", hash: H(BAD), text: BAD, front: {} }], "root", k.w.clock);
    const before = await k.resolve("ann", "agents/bad");
    expect(before.status, JSON.stringify(before.json)).toBe(200);
    expect(before.json.invalid).toBeUndefined();
    k.w.clock += 1000;
    await k.pushOk(m, C2, { bad: BAD });
    const after = await k.resolve("ann", "agents/bad");
    expect(isInvalidText(after.json.invalid), String(after.json.invalid)).toBe(true);
    expect(after.json.commits).toStrictEqual([C1, C2]);
  });

  it("test_AC18_world_push_twice", async () => {
    await start();
    await k.sourceOk();
    const m = await k.pusher();
    await k.pushOk(m, C1, { bad: BAD });
    k.w.clock += 1000;
    await k.pushOk(m, C2, { bad: BAD });
    const after = await k.resolve("ann", "agents/bad");
    expect(after.status, JSON.stringify(after.json)).toBe(200);
    expect(isInvalidText(after.json.invalid), String(after.json.invalid)).toBe(true);
    expect(after.json.commits).toStrictEqual([C1, C2]);
  });
});

// ---------------------------------------------------------------------------------------------

// RL-8 AC-08 and AC-09: `POST /v1/pulses` and `POST /v1/pulses/:id/update` reply with `warnings` for
// agents flagged invalid (docs/specs/RL-8.md, Pulse warnings). The `invalid` text of a repo copy is
// the one the machine reported; the catalog's is read back through resolve.
const RL8_BAD = "---\nname: bad\ndescription: Validates: findings\n---\nYou validate.\n";
const RL8_GOOD = "---\ndescription: Good agent\n---\nYou review.\n";
const RL8_INV = "front matter is not valid YAML: sample at line 2, column 14";
/** The `audit-relay` steps in plan order (ids as the preset gives them). */
const RELAY_STEPS = () => builtinRelay().plan.steps.map((s) => s.id as string);

describe("RL-8 AC-08 pulse warnings, repo agent", () => {
  const relay = (p: { agent: string; validator?: string; filer?: string; repo?: string }) =>
    relayBody({ params: { repo: p.repo ?? "alpha", agent: p.agent, validator: p.validator ?? "good", filer: p.filer ?? "good" } });
  const W = (step: string, agent: string, repo = "alpha") => `step "${step}": agent ${agent} in ${repo} has invalid front matter: ${RL8_INV}`;
  /** ann's machine (share `me`) reports alpha with an invalid `bad` and a valid `good`. */
  async function setup(): Promise<Bare> {
    await start();
    const m = await k.k.bare("ann", "ann-box", { repos: [ALPHA] });
    await k.report(m, [rep(ALPHA, "bad", RL8_BAD, { invalid: RL8_INV }), rep(ALPHA, "good", RL8_GOOD)]);
    return m;
  }
  async function create(who: string, b: unknown, headers: Record<string, string> = {}): Promise<{ status: number; json: Json }> {
    const res = await fetch(`${k.w.hub.url}/v1/pulses`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${k.k.tok[who]}`, ...headers },
      body: JSON.stringify(b),
    });
    return { status: res.status, json: await res.json() };
  }

  it("test_AC08_create_warns", async () => {
    await setup();
    const res = await create("ann", relay({ agent: "bad" }));
    expect(res.status, JSON.stringify(res.json)).toBe(201);
    expect(res.json.warnings).toStrictEqual([W("audit", "bad")]);
  });

  it("test_AC08_all_good_empty", async () => {
    await setup();
    const res = await create("ann", relay({ agent: "good" }));
    expect(res.status, JSON.stringify(res.json)).toBe(201);
    expect(res.json.warnings).toStrictEqual([]);
  });

  it("test_AC08_get_has_no_warnings", async () => {
    await setup();
    const res = await create("ann", relay({ agent: "bad" }));
    // Control: the POST reply carries them.
    expect(res.json.warnings).toStrictEqual([W("audit", "bad")]);
    const id = res.json.id as string;
    const list = await k.call("ann", "GET", "/v1/pulses");
    expect(list.status).toBe(200);
    const item = (list.json.pulses as Json[]).find((p) => p.id === id);
    expect(item, JSON.stringify(list.json)).toBeDefined();
    expect("warnings" in item).toBe(false);
    const one = await k.call("ann", "GET", `/v1/pulses/${id}`);
    expect(one.status).toBe(200);
    expect("warnings" in one.json).toBe(false);
    expect("warnings" in (one.json.pulse as Json)).toBe(false);
  });

  it("test_AC08_update_window_warns", async () => {
    await setup();
    const id = (await create("ann", relay({ agent: "bad" }))).json.id as string;
    const upd = await k.k.act("ann", id, "update", { window: "2h" });
    expect(upd.status, JSON.stringify(upd.json)).toBe(200);
    expect(upd.json.warnings).toStrictEqual([W("audit", "bad")]);
  });

  it("test_AC08_update_params_clears", async () => {
    await setup();
    const id = (await create("ann", relay({ agent: "bad" }))).json.id as string;
    const upd = await k.k.act("ann", id, "update", { params: { repo: "alpha", agent: "good", validator: "good", filer: "good" } });
    expect(upd.status, JSON.stringify(upd.json)).toBe(200);
    expect(upd.json.warnings).toStrictEqual([]);
  });

  it("test_AC08_two_steps_in_plan_order", async () => {
    await setup();
    const steps = RELAY_STEPS();
    expect(steps.slice(0, 2)).toStrictEqual(["audit", "validate"]);
    const res = await create("ann", relay({ agent: "bad", validator: "bad" }));
    expect(res.status, JSON.stringify(res.json)).toBe(201);
    expect(res.json.warnings).toStrictEqual([W(steps[0] as string, "bad"), W(steps[1] as string, "bad")]);
  });

  it("test_AC08_invisible_machine", async () => {
    await setup();
    const bob = await create("bob", relay({ agent: "bad" }));
    expect(bob.status, JSON.stringify(bob.json)).toBe(201);
    expect(bob.json.warnings).toStrictEqual([]);
    // Control: ann's identical call warns.
    const ann = await create("ann", relay({ agent: "bad" }));
    expect(ann.json.warnings).toStrictEqual([W("audit", "bad")]);
  });

  it("test_AC08_other_repo_no_warning", async () => {
    await start();
    const m = await k.k.bare("ann", "ann-box", { repos: [ALPHA, BETA] });
    await k.report(m, [rep(BETA, "bad", RL8_BAD, { invalid: RL8_INV }), rep(ALPHA, "good", RL8_GOOD), rep(BETA, "good", RL8_GOOD)]);
    const a = await create("ann", relay({ agent: "bad" }));
    expect(a.status, JSON.stringify(a.json)).toBe(201);
    expect(a.json.warnings).toStrictEqual([]);
    // Control: a step whose repo is beta warns.
    const b = await create("ann", relay({ agent: "bad", repo: "beta" }));
    expect(b.status, JSON.stringify(b.json)).toBe(201);
    expect(b.json.warnings).toStrictEqual([W("audit", "bad", "beta")]);
  });

  it("test_AC08_unknown_agent_no_warning", async () => {
    await setup();
    const res = await create("ann", relay({ agent: "nobody" }));
    expect(res.status, JSON.stringify(res.json)).toBe(201);
    expect(res.json.warnings).toStrictEqual([]);
  });

  it("test_AC08_opencode_copy_ignored", async () => {
    await start();
    const m = await k.k.bare("ann", "ann-box", { repos: [ALPHA] });
    await k.report(m, [rep(ALPHA, "bad", RL8_BAD, { kind: "opencode", path: ".opencode/agent/bad.md", invalid: RL8_INV }), rep(ALPHA, "good", RL8_GOOD)]);
    const res = await create("ann", relay({ agent: "bad" }));
    expect(res.status, JSON.stringify(res.json)).toBe(201);
    expect(res.json.warnings).toStrictEqual([]);
  });

  it("test_AC08_replay_keeps_first", async () => {
    const m = await setup();
    const b = relay({ agent: "bad" });
    const first = await create("ann", b, { "idempotency-key": "rl8-k" });
    expect(first.status, JSON.stringify(first.json)).toBe(201);
    expect(first.json.warnings).toStrictEqual([W("audit", "bad")]);
    // The machine now reports `bad` as valid.
    await k.report(m, [rep(ALPHA, "bad", RL8_BAD), rep(ALPHA, "good", RL8_GOOD)]);
    const again = await create("ann", b, { "idempotency-key": "rl8-k" });
    expect(again.json.id).toBe(first.json.id);
    expect(again.json.warnings).toStrictEqual([W("audit", "bad")]);
    // Control: the report took effect (a fresh update warns no more).
    const upd = await k.k.act("ann", first.json.id as string, "update", { window: "2h" });
    expect(upd.status, JSON.stringify(upd.json)).toBe(200);
    expect(upd.json.warnings).toStrictEqual([]);
  });
});

describe("RL-8 AC-09 pulse warnings, roster key", () => {
  const roster = (agent: string, o: Record<string, unknown> = {}) => body({ overlap: "allow", params: { repo: REPO, agent, ...o } }, "roster", ROSTER_HL);
  async function invalidText(): Promise<string> {
    const res = await k.resolve("ann", "agents/bad");
    expect(res.status, JSON.stringify(res.json)).toBe(200);
    const inv = res.json.invalid as string;
    expect(inv.startsWith("front matter is not valid YAML: "), inv).toBe(true);
    return inv;
  }

  it("test_AC09_invalid_key_warns", async () => {
    await start();
    await k.catalog({ bad: RL8_BAD, good: RL8_GOOD });
    const inv = await invalidText();
    const res = await k.k.pulse("ann", roster("agents/bad"));
    expect(res.status, JSON.stringify(res.json)).toBe(201);
    expect(Object.keys(res.json.agents ?? {})).toStrictEqual(["agents/bad"]);
    expect(res.json.warnings).toStrictEqual([`step "run": roster agent agents/bad has invalid front matter: ${inv}`]);
  });

  it("test_AC09_valid_key_none", async () => {
    await start();
    await k.catalog({ bad: RL8_BAD, good: RL8_GOOD });
    const res = await k.k.pulse("ann", roster("agents/good"));
    expect(res.status, JSON.stringify(res.json)).toBe(201);
    expect(res.json.warnings).toStrictEqual([]);
  });

  it("test_AC09_update_uses_pin", async () => {
    await start();
    const pusher = await k.catalog({ bad: RL8_BAD, good: RL8_GOOD });
    const inv = await invalidText();
    const view = await k.k.pulseOk("ann", roster("agents/bad"));
    // A valid `bad` at a new commit (new hash).
    k.w.clock += 1000;
    await k.pushOk(pusher, C2, { bad: RL8_GOOD.replace("Good agent", "Bad, fixed"), good: RL8_GOOD });
    const upd = await k.k.act("ann", view.id, "update", { window: "2h" });
    expect(upd.status, JSON.stringify(upd.json)).toBe(200);
    expect(upd.json.warnings).toStrictEqual([`step "run": roster agent agents/bad has invalid front matter: ${inv}`]);
    // Control: a params update re-pins to the valid version.
    const re = await k.k.act("ann", view.id, "update", { params: { repo: REPO, agent: "agents/bad", note: "v2" } });
    expect(re.status, JSON.stringify(re.json)).toBe(200);
    expect(re.json.warnings).toStrictEqual([]);
  });

  it("test_AC09_pre_rl7_def_no_warning", async () => {
    await start();
    await k.sourceOk();
    await k.pusher();
    // As v0.1.20 stored the invalid file: `front: {}`, no `invalid`.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- store method, read loosely
    await (k.w.hubStore as any).putCatalogDefs(SRC, C1, [{ path: "agents/bad.md", name: "bad", hash: H(RL8_BAD), text: RL8_BAD, front: {} }], "root", k.w.clock);
    const res = await k.k.pulse("ann", roster("agents/bad"));
    expect(res.status, JSON.stringify(res.json)).toBe(201);
    expect(res.json.warnings).toStrictEqual([]);
  });
});

