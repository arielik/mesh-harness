// RL-20: `POST /v1/presets/check` runs the preset checks of `POST /v1/pulses` and writes nothing;
// `GET /v1/pulses/:id` carries the stored snapshot's `steps` (docs/specs/RL-20.md).

import { afterEach, describe, expect, it } from "vitest";
import { GATE_FIRST, REPO, SOLO, TWO_ROOTS, UNKNOWN_PROF, BAD_POLICY, BAD_POLICY_TEXT, snap } from "./helpers/pulse-kit.ts";
import { ALPHA, C1, C2, H, H1, REV1, REV2, RULE, Rk, rep, SRC, type Json } from "./helpers/roster-kit.ts";
import { TABLES } from "../src/store/hub-copy.ts";

let k: Rk;
afterEach(async () => {
  await k?.stop();
});

/** A two-agent relay: `audit` runs the roster key `{agent}`, `file` the repo agent `{filer}` and sinks to `topic`. */
const CHAIN = (topic = " CI ", o: { deps?: string; head?: string } = {}) => `${o.head ?? ""}description: Two-agent chain
steps:
  - id: audit
    kind: review
    mode: headless
    agent: "{agent}"
    output: review-record
    title: "Audit {repo}"
    brief: "Audit {repo}."
  - id: file
    kind: review
    deps: [${o.deps ?? "audit"}]
    mode: headless
    agent: "{filer}"
    output: review-record
    consumes: [open]
    may_set: [accepted, dismissed]
    sink: { topic: "${topic}" }
    title: "File {repo}"
    brief: "File the findings of {repo}."
`;
const PARAMS = { repo: REPO, agent: "agents/rev", filer: "checker" };
const WHEN = { every: "1d" };
const BAD_AGENT = "---\nname: bad\ndescription: Validates: findings\n---\nYou validate.\n";
const BAD_INV = "front matter is not valid YAML: sample at line 2, column 14";

async function start(): Promise<Rk> {
  k = await Rk.start();
  await k.catalog({ rev: REV1, bad: BAD_AGENT });
  expect((await k.call("ann", "POST", "/v1/topics", { name: "ci" })).status).toBe(201);
  return k;
}
function check(who: string | undefined, b: unknown, headers: Record<string, string> = {}) {
  return k.w.call(who === undefined ? undefined : (k.k.tok[who] ?? who), "POST", "/v1/presets/check", b, headers);
}
async function checkOk(b: unknown, who = "ann"): Promise<Json> {
  const res = await check(who, b);
  expect(res.status, JSON.stringify(res.json)).toBe(200);
  return res.json;
}

/** Every hub table's rows, in storage order (SQLite rowid). */
async function dump(): Promise<string> {
  const out: Record<string, unknown> = {};
  for (const t of TABLES) out[t.name] = await k.w.hubStore.db.all(`SELECT * FROM "${t.name}" ORDER BY rowid`);
  return JSON.stringify(out);
}
async function eventCount(): Promise<number> {
  return (await k.r.allEvents()).length;
}

describe("RL-20 AC-01 a valid two-agent chain", () => {
  it("test_AC01_valid_chain_steps_and_pins", async () => {
    await start();
    const preset = snap("chain", CHAIN());
    const c = await checkOk({ preset, params: PARAMS });
    expect(Object.keys(c).sort()).toStrictEqual(["agents", "ok", "problems", "steps", "warnings"]);
    expect(c).toMatchObject({ ok: true, problems: [], warnings: [] });
    expect(c.steps.map((s: Json) => s.id)).toStrictEqual(["audit", "file"]);
    expect(c.steps[0]).toMatchObject({ id: "audit", repo: REPO, agent: "agents/rev", deps: [], title: "Audit alpha", output: "review-record" });
    expect(c.steps[1]).toMatchObject({ id: "file", repo: REPO, agent: "checker", deps: ["audit"], sink: { topic: "ci" }, brief: "File the findings of alpha." });
    expect(c.agents).toStrictEqual({ "agents/rev": { key: "agents/rev", source: SRC, name: "rev", hash: H1, commit: C1 } });
    // Create agrees.
    const p = await k.k.pulse("ann", { preset, params: PARAMS, when: WHEN });
    expect(p.status, JSON.stringify(p.json)).toBe(201);
    expect(p.json.agents).toStrictEqual({ "agents/rev": H1 });
    expect(p.json.warnings).toStrictEqual(c.warnings);
  });
});

describe("RL-20 AC-02/AC-03 problems equal create's refusals", () => {
  /** Check and create the same preset and params; return both answers. */
  async function both(text: string, params: Record<string, string> = PARAMS, name = "chain"): Promise<{ c: Json; p: { status: number; json: Json } }> {
    const preset = snap(name, text);
    const c = await checkOk({ preset, params });
    const p = await k.k.pulse("ann", { preset, params, when: WHEN });
    expect(c.ok, JSON.stringify(c)).toBe(false);
    expect("steps" in c).toBe(false);
    expect("agents" in c).toBe(false);
    return { c, p };
  }
  async function same422(text: string, want: string | RegExp, params?: Record<string, string>, name?: string): Promise<Json> {
    const { c, p } = await both(text, params, name);
    expect(p.status, JSON.stringify(p.json)).toBe(422);
    expect(c.problems).toStrictEqual(p.json.details);
    if (typeof want === "string") expect(c.problems).toContain(want);
    else expect(c.problems.some((x: string) => want.test(x)), JSON.stringify(c.problems)).toBe(true);
    return c;
  }
  async function same400(text: string, want: string): Promise<void> {
    const { c, p } = await both(text);
    expect(p).toStrictEqual({ status: 400, json: { error: want } });
    expect(c.problems).toStrictEqual([want]);
  }

  it("test_AC02_each_problem_class", async () => {
    await start();
    await same422("description: x\nsteps: [\n", /^preset chain: /);
    await same422(CHAIN(" CI ", { deps: "audti" }), 'step "file": dep "audti" not found; did you mean "audit"?');
    const cycle = `description: cycle
steps:
  - { id: r, kind: implement, title: R, brief: r }
  - { id: a, kind: implement, deps: [r, b], title: A, brief: a }
  - { id: b, kind: implement, deps: [a], title: B, brief: b }
`;
    await same422(cycle, /^dependency cycle: /);
    await same422(TWO_ROOTS, "a pulse preset needs exactly one first step (no deps, not a gate); chain has 2");
    await same422(GATE_FIRST, "a pulse preset needs exactly one first step (no deps, not a gate); chain has 1");
    await same422(UNKNOWN_PROF, 'step "run": unknown profile "nope"');
    await same422(CHAIN(), `step "audit": no catalog source matches nope`, { ...PARAMS, agent: "nope/rev" });
    // A bad key fails the plan shape once substituted: create's unprefixed text, the same here.
    const badKey = await same422(CHAIN(), /agent key must be/, { ...PARAMS, agent: "agents/rev@zz" });
    expect(badKey.problems[0]).toContain(RULE);
    await same422(CHAIN(), "params.repo is required (the repo the preset's steps work in)", { agent: "agents/rev", filer: "checker" });
    await same422(CHAIN(" CI ", { head: "kind: Bad Kind\n" }), /kind must match/);
    await same422(BAD_POLICY, BAD_POLICY_TEXT);
    await same422(CHAIN(), "preset chain: unknown parameter {agent} in step audit", { repo: REPO, filer: "checker" });
    const many = `description: many\nsteps:\n${Array.from({ length: 51 }, (_, i) => `  - { id: s${i}, kind: implement, ${i ? `deps: [s${i - 1}], ` : ""}title: S, brief: s }`).join("\n")}\n`;
    await same422(many, "a plan has at most 50 steps (got 51)");
    // Sink topics: create's 400, the check's problem.
    await same400(CHAIN(" Nope "), "unknown topic nope (define with: mesh topic add <name>)");
    await same400(CHAIN("ci/nightly"), (await both(CHAIN("ci/nightly"))).p.json.error);
    expect((await both(CHAIN("ci/nightly"))).c.problems[0]).toMatch(/^bad topic "ci\/nightly": /);
    await same400(CHAIN("all"), "unknown topic all (define with: mesh topic add <name>)");
    // Nothing was created.
    expect((await k.call("ann", "GET", "/v1/pulses")).json.pulses).toStrictEqual([]);
  });

  it("test_AC03_several_problems_in_create_order", async () => {
    await start();
    const twoProblems = `description: two
steps:
  - { id: run, kind: review, mode: headless, profile: nope, title: R, brief: r }
  - { id: next, kind: review, deps: [rnu], title: N, brief: n }
`;
    const c = await same422(twoProblems, 'step "run": unknown profile "nope"');
    expect(c.problems).toHaveLength(2);
    expect(c.problems[0]).toMatch(/^step "next": dep "rnu" not found/);
    // A 422 problem and an unknown sink: create's details, then the sink problem.
    const mixed = await both(CHAIN(" nope ", { deps: "audti" }));
    expect(mixed.p.status).toBe(422);
    expect(mixed.c.problems).toStrictEqual([...mixed.p.json.details, "unknown topic nope (define with: mesh topic add <name>)"]);
    // Two unknown sink topics: both problems; create names the first.
    const two = CHAIN(" a1 ").replace("  - id: file", `  - id: file2
    kind: review
    deps: [audit]
    mode: headless
    agent: "{filer}"
    output: review-record
    consumes: [open]
    may_set: [accepted]
    sink: { topic: "b2" }
    title: F2
    brief: f2
  - id: file`);
    const t = await both(two);
    expect(t.p).toStrictEqual({ status: 400, json: { error: "unknown topic b2 (define with: mesh topic add <name>)" } });
    expect(t.c.problems).toStrictEqual(["unknown topic b2 (define with: mesh topic add <name>)", "unknown topic a1 (define with: mesh topic add <name>)"]);
    // Two steps sinking to the same unknown topic: one problem.
    const dup = await both(two.replace('sink: { topic: "b2" }', 'sink: { topic: "A1" }'));
    expect(dup.p).toStrictEqual({ status: 400, json: { error: "unknown topic a1 (define with: mesh topic add <name>)" } });
    expect(dup.c.problems).toStrictEqual(["unknown topic a1 (define with: mesh topic add <name>)"]);
  });
});

describe("RL-20 AC-04 warnings", () => {
  it("test_AC04_roster_and_repo_agent_warnings", async () => {
    await start();
    const inv = (await k.resolve("ann", "agents/bad")).json.invalid as string;
    expect(inv.startsWith("front matter is not valid YAML: "), inv).toBe(true);
    const m = await k.k.bare("ann", "ann-box", { repos: [ALPHA] });
    await k.report(m, [rep(ALPHA, "badrepo", BAD_AGENT, { invalid: BAD_INV })]);
    const preset = snap("chain", CHAIN());
    const params = { repo: REPO, agent: "agents/bad", filer: "badrepo" };
    const c = await checkOk({ preset, params });
    expect(c.ok).toBe(true);
    const want = [`step "audit": roster agent agents/bad has invalid front matter: ${inv}`, `step "file": agent badrepo in alpha has invalid front matter: ${BAD_INV}`];
    expect(c.warnings).toStrictEqual(want);
    expect((await checkOk({ preset, params, checkedAgents: ["badrepo"] })).warnings).toStrictEqual([want[0]]);
    // A problem does not hide the warnings of what resolved.
    expect(await checkOk({ preset: snap("chain", CHAIN(" nope ")), params })).toMatchObject({ ok: false, warnings: want });
    const p = await k.k.pulse("ann", { preset, params, when: WHEN });
    expect(p.status).toBe(201);
    expect(p.json.warnings).toStrictEqual(c.warnings);
  });
});

describe("RL-20 AC-05/AC-06 sha256 and bodies", () => {
  it("test_AC05_sha256", async () => {
    await start();
    const bad = { preset: { ...snap("solo", SOLO), sha256: snap("x", "other").sha256 }, params: { repo: REPO } };
    const want = { status: 400, json: { error: "preset.sha256 is not the SHA-256 of preset.text" } };
    expect(await check("ann", bad)).toStrictEqual(want);
    expect(await k.k.pulse("ann", { ...bad, when: WHEN })).toStrictEqual(want);
    const uni = SOLO.replace('title: "Run {repo}"', 'title: "Prüfe {repo} – ok"');
    expect(await checkOk({ preset: snap("solo", uni), params: { repo: REPO } })).toMatchObject({ ok: true, steps: [{ title: "Prüfe alpha – ok" }] });
  });

  it("test_AC06_malformed_bodies", async () => {
    await start();
    const raw = await fetch(`${k.w.hub.url}/v1/presets/check`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${k.k.tok.ann}` }, body: "{" });
    expect({ status: raw.status, json: await raw.json() }).toStrictEqual({ status: 400, json: { error: "invalid JSON body" } });
    const solo = snap("solo", SOLO);
    const params21 = Object.fromEntries(Array.from({ length: 21 }, (_, i) => [`p${i}`, "x"]));
    for (const b of [
      {},
      { preset: { name: "solo", sha256: solo.sha256 }, params: { repo: REPO } },
      { preset: snap("solo", "x".repeat(20_001)), params: { repo: REPO } },
      { preset: solo, params: { ...params21, repo: REPO } },
      { preset: solo, params: { Repo: REPO } },
      { preset: solo, params: { repo: REPO }, when: WHEN },
    ]) {
      const res = await check("ann", b);
      expect(res.status, JSON.stringify(b).slice(0, 80)).toBe(400);
      expect(res.json.error).toBe("invalid request");
      expect(Array.isArray(res.json.details)).toBe(true);
    }
    const pad = SOLO + "#" + "x".repeat(20_000 - SOLO.length - 2) + "\n";
    expect(pad.length).toBe(20_000);
    expect((await checkOk({ preset: snap("solo", pad), params: { repo: REPO } })).ok).toBe(true);
  });
});

describe("RL-20 AC-07/AC-08 scopes and no writes", () => {
  it("test_AC07_scopes_on_behalf", async () => {
    await start();
    const svc = k.w.hub.svc;
    const reader = await svc.serviceToken("dash", ["goals:read"]);
    const writer = await svc.serviceToken("other", ["pulses:write"]);
    const b = { preset: snap("chain", CHAIN()), params: PARAMS };
    expect((await check("ann", b)).status).toBe(200);
    const r = await check(reader, b);
    expect(r.status, JSON.stringify(r.json)).toBe(200);
    expect(r.json.ok).toBe(true);
    expect(await check(writer, b)).toStrictEqual({ status: 403, json: { error: "forbidden", code: "forbidden" } });
    expect(await check(undefined, b)).toStrictEqual({ status: 401, json: { error: "login required", code: "login-required" } });
    expect(await check(reader, b, { "x-mesh-on-behalf-of": "ann" })).toStrictEqual({ status: 400, json: { error: "on-behalf-of is not accepted on this route", code: "on-behalf-of-not-accepted" } });
  });

  it("test_AC08_no_writes_no_events_no_replay", async () => {
    await start();
    const pusher = await k.pusher("root", [SRC], "root-pusher-2");
    const before = await dump();
    const events = await eventCount();
    const valid = { preset: snap("chain", CHAIN()), params: PARAMS };
    expect((await checkOk(valid)).ok).toBe(true);
    expect((await checkOk({ preset: snap("chain", CHAIN(" CI ", { deps: "x" })), params: PARAMS })).ok).toBe(false);
    expect((await check("ann", { preset: { ...valid.preset, sha256: "0".repeat(64) }, params: PARAMS })).status).toBe(400);
    expect((await check("ann", { preset: valid.preset })).status).toBe(400);
    const KEY = { "idempotency-key": "rl20-check-1" };
    const first = await check("ann", valid, KEY);
    expect(first.json.agents["agents/rev"].hash).toBe(H1);
    expect(await dump()).toBe(before);
    expect(await eventCount()).toBe(events);
    // The catalog moves on: the same key answers from the state now, not a replay.
    await k.pushOk(pusher, C2, { rev: REV2, bad: BAD_AGENT });
    const after = await dump();
    const second = await check("ann", valid, KEY);
    expect(second.status).toBe(200);
    expect(second.json.agents["agents/rev"]).toMatchObject({ hash: H(REV2), commit: C2 });
    expect(await dump()).toBe(after);
    expect(await k.w.hubStore.db.all(`SELECT * FROM "idem"`)).toStrictEqual([]);
  });
});

describe("RL-20 AC-09 steps in the pulse detail", () => {
  it("test_AC09_pulse_detail_steps", async () => {
    await start();
    const preset = snap("chain", CHAIN());
    const c = await checkOk({ preset, params: PARAMS });
    const id = (await k.k.pulseOk("ann", { preset, params: PARAMS, when: WHEN })).id as string;
    const d = await k.k.detail("ann", id);
    expect(d.steps).toStrictEqual(c.steps);
    // A stored snapshot that no longer parses: no steps, still 200.
    const stored = await k.w.hubStore.getPulse(id);
    if (!stored) throw new Error("no pulse");
    await k.w.hubStore.savePulse({ ...stored, preset: { ...stored.preset, text: "steps: [\n" } });
    const d2 = await k.k.detail("ann", id);
    expect("steps" in d2).toBe(false);
    expect(d2.pulse.id).toBe(id);
  });
});
