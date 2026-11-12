// RL-2 daemon side end to end (World + a temp git checkout + the fake claude): MCP `mesh_review`
// (root, commit, declared rules, path normalisation, evidence hash, redaction, reply text, offline),
// the evidence hash across commits, headless runs and idempotency through the shim. Criteria AC-19,
// AC-20, AC-21 and AC-26 (daemon). Written from the spec's contracts only (docs/specs/RL-2.md).
// Steps by id, items by fp, events by type + step. No test runs the real `claude`.

import { existsSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AUDITOR, git, GHP, Relay, type PlanIn } from "./helpers/relay-kit.ts";
import { disp, evidenceHashOf, fp, sha } from "./helpers/review-kit.ts";
import type { Json, Person } from "./helpers/world.ts";

let r: Relay;
afterEach(async () => {
  await r?.stop();
});

const NEED = (id: string, n: number) => `${id} needs a review record for round ${n} (output: review-record); submit it with mesh_review, then call mesh_done`;
const SIX = ["line one", "const secret = load();", "if (secret) {", "  use(secret);", "}", "end"];
/** The fp of a rule an agent-less session sends: mapped to other:<slug>. */
const ofp = (rule: string, path = "src/a.ts") => fp(`other:${rule.toLowerCase()}`, path);

interface Cast {
  ann: Person;
  /** ann's other login (owner of the goals). */
  self: string;
  /** ann's checkout, real path. */
  root: string;
}

/** ann with a checkout holding src/a.ts (six lines), committed; sessions in it share `me`. */
async function cast(): Promise<Cast> {
  r = await Relay.start(["ann", "bob"]);
  const ann = await r.w.person("ann", "svc", { shareSessions: "me" });
  const root = realpathSync(ann.repoDir);
  commitFile(root, "src/a.ts", `${SIX.join("\n")}\n`);
  const self = await r.otherLogin("ann");
  await r.w.flush();
  return { ann, self, root };
}
function commitFile(root: string, path: string, text: string): string {
  mkdirSync(join(root, path, ".."), { recursive: true });
  writeFileSync(join(root, path), text);
  git(root, ["add", "-A"]);
  git(root, ["commit", "-qm", `edit ${path}`]);
  return git(root, ["rev-parse", "HEAD"]);
}

async function goal(owner: string, steps: PlanIn[]): Promise<string> {
  const G = await r.goal(owner, steps.map((s) => ({ repo: "svc", ...s })));
  return G;
}
/** Session `pid` (in ann's checkout) claims `id` through MCP. */
async function sessionClaims(k: Cast, pid: number, id: string): Promise<void> {
  if (!r.w.session(k.ann, pid)) await r.w.hook(k.ann, "SessionStart", pid);
  const c = await r.w.tool(k.ann, pid, "mesh_claim", { step: id });
  expect(c.isError, c.text).toBeFalsy();
}
const tool = (k: Cast, pid: number, args: Record<string, unknown>) => r.w.tool(k.ann, pid, "mesh_review" as never, args);
async function toolOk(k: Cast, pid: number, args: Record<string, unknown>): Promise<string> {
  const t = await tool(k, pid, args);
  expect(t.isError, t.text).toBeFalsy();
  return t.text;
}
async function doneOk(k: Cast, pid: number): Promise<void> {
  const d = await r.w.tool(k.ann, pid, "mesh_done", { outcome: "done", summary: "s" });
  expect(d.isError, d.text).toBeFalsy();
  await r.w.flush();
}
async function stored(k: Cast, id: string): Promise<Json[]> {
  const res = await r.call(k.ann, "GET", `/v1/steps/${id}/reviews`);
  expect(res.status, JSON.stringify(res.json)).toBe(200);
  return res.json.reviews;
}
const recArgs = (o: Record<string, unknown> = {}) => ({ coverage: "complete", assessment: "issues", items: [], summary: "s", ...o });
const it1 = (rule: string, o: Record<string, unknown> = {}) => ({ key: { rule, path: "src/a.ts" }, title: `T-${rule}`, severity: "S3", category: "c", evidence: [], ...o });
const linesOf = (text: string, a: number, b: number) => text.split("\n").slice(a - 1, b).join("\n");

// ---------------------------------------------------------------------------------------------

describe("AC-19 mesh_review", { timeout: 40_000 }, () => {
  it("test_AC19_commit_default", async () => {
    const k = await cast();
    const G = await goal(k.self, [{ id: "audit", output: "review-record" }]);
    await sessionClaims(k, 1, `${G}.audit`);
    await toolOk(k, 1, recArgs({ items: [it1("I-03", { key: { rule: "I-03", path: join(k.root, "src", "a.ts") }, evidence: [{ path: join(k.root, "src", "a.ts") }] })] }));
    const [rv] = await stored(k, `${G}.audit`);
    expect(rv.record.subject.commit).toBe(git(k.root, ["rev-parse", "HEAD"]));
    expect(rv.record.items[0].key).toStrictEqual({ rule: "other:i-03", path: "src/a.ts" });
    expect(rv.record.items[0].evidence[0].path).toBe("src/a.ts");
    expect(rv.record.items[0].fp).toBe(ofp("I-03"));
    expect(rv.undeclaredRules).toBe(1);
    const es = await r.events("review.recorded", `${G}.audit`);
    expect(es).toHaveLength(1);
    expect(es[0].payload.undeclaredRules).toBe(1);
    // subject.repo is left as given (absent here).
    expect(rv.record.subject).not.toHaveProperty("repo");
  });

  it("test_AC19_subject_given", async () => {
    const k = await cast();
    const G = await goal(k.self, [{ id: "audit", output: "review-record" }]);
    await sessionClaims(k, 1, `${G}.audit`);
    await toolOk(k, 1, recArgs({ subject: { commit: "abc", repo: "x" }, items: [it1("I-03", { key: { rule: "I-03", path: "/elsewhere/b.ts" } })] }));
    const [rv] = await stored(k, `${G}.audit`);
    expect(rv.record.subject).toStrictEqual({ commit: "abc", repo: "x" });
    expect(rv.record.items[0].key.path).toBe("/elsewhere/b.ts");
  });

  it("test_AC19_redaction", async () => {
    const k = await cast();
    const G = await goal(k.self, [
      { id: "audit", output: "review-record" },
      { id: "v", deps: ["audit"], output: "review-record", consumes: ["open"], may_set: ["dismissed"] },
    ]);
    await sessionClaims(k, 1, `${G}.audit`);
    await toolOk(k, 1, recArgs({ items: [it1("I-03", { title: `t ${GHP}`, evidence: [{ path: "src/a.ts", note: `n ${GHP}` }] })] }));
    const [a] = await stored(k, `${G}.audit`);
    expect(a.record.items[0].title).toBe("t [REDACTED]");
    expect(a.record.items[0].evidence[0]).toStrictEqual({ path: "src/a.ts", note: "n [REDACTED]" });
    expect(a.record.items[0].key).toStrictEqual({ rule: "other:i-03", path: "src/a.ts" });
    const arts = await r.artifactsOf(G, k.ann);
    expect(arts.find((x) => x.id === a.artifact)?.redactions).toBe(2);
    await doneOk(k, 1);
    await sessionClaims(k, 1, `${G}.v`);
    await toolOk(k, 1, recArgs({ assessment: "clean", dispositions: [disp(ofp("I-03"), "dismissed", { reason: `r ${k.ann.config.key}` })] }));
    const [v] = await stored(k, `${G}.v`);
    expect(v.record.dispositions[0].reason).toBe("r [REDACTED]");
    expect(v.record.dispositions[0].fingerprint).toBe(ofp("I-03"));
    expect((await r.artifactsOf(G, k.ann)).find((x) => x.id === v.artifact)?.redactions).toBe(1);
  });

  it("test_AC19_reply_raising", async () => {
    const k = await cast();
    const G = await goal(k.self, [{ id: "audit", output: "review-record" }]);
    await sessionClaims(k, 1, `${G}.audit`);
    const text = await toolOk(k, 1, recArgs({ items: [it1("I-03"), it1("I-03", { title: "again" }), it1("I-04")] }));
    const re = new RegExp(`^Recorded the review record of ${G.replace(".", "\\.")}\\.audit round 1 \\(2 item\\(s\\), 0 disposition\\(s\\)\\)\\. Fold: 2 new, 0 repeat, 0 regression, 0 resolved, 0 carried\\. 3 rule\\(s\\) are not declared by the agent and were recorded as other:\\S+\\. Finish with mesh_done\\.$`);
    expect(text).toMatch(re);
  });

  it("test_AC19_reply_consuming_and_ignored", async () => {
    const k = await cast();
    const G = await goal(k.self, [
      { id: "audit", output: "review-record" },
      { id: "v", deps: ["audit"], output: "review-record", consumes: ["open"], may_set: ["dismissed"] },
      { id: "recheck", deps: ["v"], mode: "headless", output: "review-record", consumes: ["open"], may_set: ["confirmed"] },
    ]);
    await sessionClaims(k, 1, `${G}.audit`);
    await toolOk(k, 1, recArgs({ items: [it1("A"), it1("B")] }));
    await doneOk(k, 1);
    await sessionClaims(k, 1, `${G}.v`);
    const text = await toolOk(k, 1, recArgs({ assessment: "clean", dispositions: [disp(ofp("A"), "dismissed")] }));
    expect(text).toBe(`Recorded the review record of ${G}.v round 1 (0 item(s), 1 disposition(s)). Finish with mesh_done.`);
    await doneOk(k, 1);
    // test_AC19_reply_ignored: the headless recheck may not override the person's dismissal.
    await sessionClaims(k, 1, `${G}.recheck`);
    const t2 = await toolOk(k, 1, recArgs({ assessment: "clean", dispositions: [disp(ofp("A"), "confirmed"), disp(ofp("B"), "confirmed")] }));
    expect(t2).toBe(`Recorded the review record of ${G}.recheck round 1 (0 item(s), 1 disposition(s)). Ignored 1 disposition(s): a person decided those items in this goal. Finish with mesh_done.`);
  });

  it("test_AC19_no_step", async () => {
    const k = await cast();
    const G = await goal(k.self, [{ id: "audit", output: "review-record" }]);
    await r.w.hook(k.ann, "SessionStart", 2);
    const t = await tool(k, 2, recArgs());
    expect(t.isError).toBe(true);
    expect(t.text).toBe("this session holds no step");
    expect(await stored(k, `${G}.audit`)).toStrictEqual([]);
  });

  it("test_AC19_offline", async () => {
    const k = await cast();
    const G = await goal(k.self, [{ id: "audit", output: "review-record" }]);
    await sessionClaims(k, 1, `${G}.audit`);
    k.ann.offline = true;
    const t = await tool(k, 1, recArgs({ items: [it1("A")] }));
    expect(t.isError).toBe(true);
    expect(t.text.startsWith("the hub is offline; the review record was not stored.")).toBe(true);
    k.ann.offline = false;
    await r.w.flush();
    await r.w.flush();
    expect(await stored(k, `${G}.audit`)).toStrictEqual([]);
    // Control: online, the same call stores.
    await toolOk(k, 1, recArgs({ items: [it1("A")] }));
    expect(await stored(k, `${G}.audit`)).toHaveLength(1);
  });

  it("test_AC19_hub_error", async () => {
    const k = await cast();
    const G = await goal(k.self, [{ id: "audit", output: "review-record" }]);
    await sessionClaims(k, 1, `${G}.audit`);
    await toolOk(k, 1, recArgs());
    const t = await tool(k, 1, recArgs({ items: [it1("A")] }));
    expect(t.isError).toBe(true);
    expect(t.text).toContain(`${G}.audit round 1 already has a review record`);
  });
});

// ---------------------------------------------------------------------------------------------

describe("AC-20 evidence", { timeout: 40_000 }, () => {
  const PLAN: PlanIn[] = [
    { id: "audit", output: "review-record" },
    { id: "v", deps: ["audit"], output: "review-record", consumes: ["open"], may_set: ["dismissed"] },
  ];
  /** A goal: the session audits with `items` (and `subject`), then v records `dispositions`. Returns audit's stored record. */
  async function round(k: Cast, items: unknown[], o: { subject?: Record<string, unknown>; dispositions?: unknown[] } = {}): Promise<Json> {
    const G = await goal(k.self, PLAN);
    await sessionClaims(k, 1, `${G}.audit`);
    await toolOk(k, 1, recArgs({ items, ...(o.subject ? { subject: o.subject } : {}) }));
    await doneOk(k, 1);
    await sessionClaims(k, 1, `${G}.v`);
    await toolOk(k, 1, recArgs({ assessment: "clean", dispositions: o.dispositions ?? [] }));
    await doneOk(k, 1);
    return (await stored(k, `${G}.audit`))[0];
  }
  const ev = (lines: [number, number], note?: string) => it1("I-03", { evidence: [{ path: "src/a.ts", lines, ...(note ? { note } : {}) }] });
  const F = ofp("I-03");
  const itemsOf = async (k: Cast) => (await r.call(k.ann, "GET", `/v1/items?lineage=${encodeURIComponent("-|svc|audit")}`)).json.items as Json[];

  it("test_AC20_hash_moved_changed", async () => {
    const k = await cast();
    const c1 = `${SIX.join("\n")}\n`;
    // test_AC20_hash_c1
    const g1 = await round(k, [ev([3, 4])], { dispositions: [disp(F, "dismissed")] });
    const eh1 = evidenceHashOf([linesOf(c1, 3, 4)]);
    expect(g1.record.items[0].eh).toBe(eh1);
    expect(eh1).toBe(sha(sha("if (secret) { use(secret);")));
    // test_AC20_moved_region: two lines inserted above; the agent reports [5, 6].
    commitFile(k.root, "src/a.ts", `added 1\nadded 2\n${c1}`);
    const g2 = await round(k, [ev([5, 6])]);
    expect(g2.record.items[0].eh).toBe(eh1);
    expect(g2.record.items[0].mark).toBe("repeat");
    expect((await itemsOf(k)).find((x) => x.fp === F).state).toBe("dismissed");
    // test_AC20_changed_region: a token inside the region changes.
    commitFile(k.root, "src/a.ts", `added 1\nadded 2\n${c1.replace("use(secret)", "leak(secret)")}`);
    const g3 = await round(k, [ev([5, 6])]);
    expect(g3.record.items[0].eh).not.toBe(eh1);
    expect(g3.record.items[0].mark).toBe("regression");
    expect((await itemsOf(k)).find((x) => x.fp === F).state).toBe("open");
  });

  it("test_AC20_note_only", async () => {
    const k = await cast();
    const a = await round(k, [ev([3, 4], "first note")]);
    const b = await round(k, [ev([3, 4], "a different note")]);
    expect(a.record.items[0].eh).toBe(evidenceHashOf([linesOf(`${SIX.join("\n")}\n`, 3, 4)]));
    expect(b.record.items[0].eh).toBe(a.record.items[0].eh);
  });

  it("test_AC20_missing_and_no_lines", async () => {
    const k = await cast();
    const missing = evidenceHashOf([null]);
    const g = await round(k, [
      it1("M1", { evidence: [{ path: "src/none.ts", lines: [1, 2] }] }),
      it1("M2", { evidence: [{ path: "src/a.ts", lines: [50, 51] }] }),
      it1("N", { evidence: [{ path: "src/a.ts", note: "no lines" }] }),
      it1("P", { evidence: [{ path: "src/a.ts", note: "x" }, { path: "src/a.ts", lines: [1, 1] }] }),
    ]);
    const byRule = Object.fromEntries((g.record.items as Json[]).map((x) => [x.key.rule, x]));
    expect(byRule["other:m1"].eh).toBe(missing);
    expect(byRule["other:m2"].eh).toBe(missing);
    expect(byRule["other:n"]).not.toHaveProperty("eh");
    // Only evidence entries with lines enter the hash.
    expect(byRule["other:p"].eh).toBe(evidenceHashOf(["line one"]));
  });

  it("test_AC20_commit_never_an_option", async () => {
    // Review RL-2 diff r1 B1: agent-written subject.commit never reaches git as an option; a commit
    // that starts with "-" is a failed read, so its regions hash as missing (spec: unreadable → missing).
    const k = await cast();
    const out = mkdtempSync(join(tmpdir(), "rl2-"));
    try {
      const c1 = git(k.root, ["rev-parse", "HEAD"]);
      // Control: a valid commit reads the region.
      const ok = await round(k, [ev([3, 4])], { subject: { commit: c1 } });
      expect(ok.record.items[0].eh).toBe(evidenceHashOf([linesOf(`${SIX.join("\n")}\n`, 3, 4)]));
      // Read as an option, this commit makes the daemon's read of src/a.ts write to <out>/x:src/a.ts.
      mkdirSync(join(out, "x:src"));
      const opt = `--output=${join(out, "x")}`;
      expect(opt.length).toBeLessThanOrEqual(64);
      const bad = await round(k, [ev([3, 4])], { subject: { commit: opt } });
      expect(bad.record.items[0].eh).toBe(evidenceHashOf([null]));
      expect(readdirSync(join(out, "x:src"))).toStrictEqual([]);
      expect(readdirSync(out)).toStrictEqual(["x:src"]);
      expect(existsSync(join(k.root, "x:src"))).toBe(false);
    } finally {
      rmSync(out, { recursive: true, force: true });
    }
  });

  it("test_AC20_uses_commit_not_worktree", async () => {
    const k = await cast();
    const c1 = git(k.root, ["rev-parse", "HEAD"]);
    writeFileSync(join(k.root, "src", "a.ts"), `${SIX.join("\n").replace("use(secret)", "changed(secret)")}\n`);
    const g = await round(k, [ev([3, 4])], { subject: { commit: c1 } });
    expect(g.record.items[0].eh).toBe(evidenceHashOf([linesOf(`${SIX.join("\n")}\n`, 3, 4)]));
  });
});

// ---------------------------------------------------------------------------------------------

describe("AC-21 headless review", { timeout: 60_000 }, () => {
  const RULED = AUDITOR.replace("model: haiku\r\n", "model: haiku\r\nmesh-rules: [I-03]\r\n").replace("name: auditor", "name: ruled");
  interface HCast {
    ann: Person;
    self: string;
  }
  async function hcast(agents: Record<string, string> = {}): Promise<HCast> {
    r = await Relay.start(["ann", "bob"]);
    const ann = await r.headlessPerson("ann", { nick: "hl", agents: { ruled: RULED, ...agents }, person: { shareSessions: "me" } });
    commitFile(ann.repoDir, "src/a.ts", `${SIX.join("\n")}\n`);
    const self = await r.otherLogin("ann");
    await r.w.flush();
    return { ann, self };
  }
  async function run(k: HCast, id: string, pid: number): Promise<Json> {
    r.script(id, [{ waitFor: `end-${pid}` }]);
    await r.autoOffer(k.ann, id, k.self);
    await r.pull(k.ann);
    await r.started(id);
    return r.runSession(k.ann, id, pid);
  }

  it("test_AC21_rules_and_done", async () => {
    const k = await hcast();
    const G = await r.goal(k.self, [{ id: "audit", mode: "headless", agent: "ruled", output: "review-record" }]);
    const id = `${G}.audit`;
    await run(k, id, 7);
    const t = await r.w.tool(k.ann, 7, "mesh_review" as never, recArgs({ items: [it1("I-03", { evidence: [{ path: "src/a.ts", lines: [3, 4] }] }), it1("x")] }));
    expect(t.isError, t.text).toBeFalsy();
    const d = await r.w.tool(k.ann, 7, "mesh_done", { outcome: "done", summary: "s" });
    expect(d.isError, d.text).toBeFalsy();
    r.go("end-7");
    await r.endRun(k.ann, id);
    const st = await r.stepOf(id);
    expect(st.state).toBe("done");
    const tel = st.rounds.at(-1).telemetry;
    expect(tel.undeclaredRules).toBe(1);
    const [rv] = (await r.call(k.ann, "GET", `/v1/steps/${id}/reviews`)).json.reviews as Json[];
    expect((rv.record.items as Json[]).map((x) => x.key.rule)).toStrictEqual(["I-03", "other:x"]);
    expect(rv.undeclaredRules).toBe(1);
    expect(rv.record.items[0].eh).toBe(evidenceHashOf([linesOf(`${SIX.join("\n")}\n`, 3, 4)]));
    const lineage = `-|svc|ruled`;
    const items = (await r.call(k.ann, "GET", `/v1/items?lineage=${encodeURIComponent(lineage)}`)).json.items as Json[];
    expect(items).toHaveLength(2);
    for (const x of items) expect(x.raisedBy, x.fp).toStrictEqual({ key: tel.agentKey, hash: tel.agentHash });
    expect(tel.agentKey).toBe("svc/ruled");
  });

  it("test_AC21_rules_yaml", async () => {
    const k = await hcast();
    writeFileSync(join(k.ann.repoDir, ".claude", "agents", "auditor.rules.yaml"), "- x\n");
    git(k.ann.repoDir, ["add", "-A"]);
    git(k.ann.repoDir, ["commit", "-qm", "rules"]);
    const G = await r.goal(k.self, [{ id: "audit", mode: "headless", agent: "auditor", output: "review-record" }]);
    const id = `${G}.audit`;
    await run(k, id, 7);
    const t = await r.w.tool(k.ann, 7, "mesh_review" as never, recArgs({ items: [it1("x")] }));
    expect(t.isError, t.text).toBeFalsy();
    expect(t.text).not.toContain("not declared");
    const [rv] = (await r.call(k.ann, "GET", `/v1/steps/${id}/reviews`)).json.reviews as Json[];
    expect(rv.record.items[0].key.rule).toBe("x");
    expect(rv.undeclaredRules).toBe(0);
  });

  it("test_AC21_consuming_decider", async () => {
    const k = await hcast({ validator: "---\nname: validator\ndescription: Validates\n---\nYou validate.\n" });
    const G = await r.goal(k.self, [
      { id: "audit", output: "review-record" },
      { id: "validate", deps: ["audit"], mode: "headless", agent: "validator", output: "review-record", consumes: ["open"], may_set: ["confirmed"] },
    ]);
    const audit = await r.act(k.ann, `${G}.audit`, "claim", {});
    expect(audit.status, JSON.stringify(audit.json)).toBe(200);
    const A = fp("A", "src/a.ts");
    const up = await r.call(k.ann, "POST", `/v1/steps/${G}.audit/review`, recArgs({ items: [it1("A")] }));
    expect(up.status, JSON.stringify(up.json)).toBe(201);
    expect((await r.act(k.ann, `${G}.audit`, "done", { summary: "ok" })).status).toBe(200);
    const id = `${G}.validate`;
    await run(k, id, 8);
    const t = await r.w.tool(k.ann, 8, "mesh_review" as never, recArgs({ assessment: "clean", dispositions: [disp(A, "confirmed")] }));
    expect(t.isError, t.text).toBeFalsy();
    const d = await r.w.tool(k.ann, 8, "mesh_done", { outcome: "done", summary: "s" });
    expect(d.isError, d.text).toBeFalsy();
    r.go("end-8");
    await r.endRun(k.ann, id);
    const tel = (await r.stepOf(id)).rounds.at(-1).telemetry;
    const x = ((await r.call(k.ann, "GET", `/v1/items?lineage=${encodeURIComponent("-|svc|audit")}`)).json.items as Json[]).find((i) => i.fp === A);
    expect(x.state).toBe("confirmed");
    expect(x.history.at(-1).decider).toStrictEqual({ kind: "agent", key: tel.agentKey, hash: tel.agentHash });
    expect(tel.agentKey).toBe("svc/validator");
  });

  it("test_AC21_done_without_review", async () => {
    const k = await hcast();
    const G = await r.goal(k.self, [{ id: "audit", mode: "headless", agent: "ruled", output: "review-record" }]);
    const id = `${G}.audit`;
    await run(k, id, 7);
    const d = await r.w.tool(k.ann, 7, "mesh_done", { outcome: "done", summary: "s" });
    expect(d.isError).toBe(true);
    expect(d.text).toContain(NEED(id, 1));
    r.go("end-7");
    await r.endRun(k.ann, id);
    const st = await r.stepOf(id);
    expect(st.state).toBe("failed");
    // test_AC21_telemetry_zero
    expect(st.rounds.at(-1).outcome).toBe("fail");
    expect(st.rounds.at(-1).telemetry.undeclaredRules).toBe(0);
  });
});

// ---------------------------------------------------------------------------------------------

describe("AC-26 idempotency (daemon)", { timeout: 40_000 }, () => {
  it("test_AC26_daemon_key", async () => {
    const k = await cast();
    const G = await goal(k.self, [{ id: "audit", output: "review-record" }]);
    await sessionClaims(k, 1, `${G}.audit`);
    const args = recArgs({ items: [it1("A")] });
    const one = await r.local(k.ann, "POST", "/local/mcp/mesh_review", { pid: 1, args, key: "shim-review-0001" });
    expect(one.status, JSON.stringify(one.json)).toBe(200);
    expect(one.json.isError, JSON.stringify(one.json)).toBeFalsy();
    const two = await r.local(k.ann, "POST", "/local/mcp/mesh_review", { pid: 1, args, key: "shim-review-0001" });
    expect(two.json.isError, JSON.stringify(two.json)).toBeFalsy();
    expect(await stored(k, `${G}.audit`)).toHaveLength(1);
    expect(await r.events("review.recorded", `${G}.audit`)).toHaveLength(1);
    const keys = k.ann.requests.filter((q) => q.method === "POST" && q.path === `/v1/steps/${G}.audit/review`).map((q) => q.key);
    expect(keys).toStrictEqual(["shim-review-0001", "shim-review-0001"]);
  });
});
