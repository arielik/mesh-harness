// RL-9 CLI against a World hub: `mesh goal plan` on a clean-audit goal, the sink checks through
// `mesh pulse add` / `mesh goal plan` (and their routes), `mesh next` in severity order, `mesh goal
// drop`, `mesh items sink`, the `mesh show` header. Criteria AC-08 (CLI), AC-11, AC-13 (CLI), AC-14
// (CLI), AC-15 (CLI), AC-16. Written from the spec's contracts only (docs/specs/RL-9.md) and the test
// plan. What the CLI changed is read back at the hub.

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { snap } from "./helpers/pulse-kit.ts";
import { git } from "./helpers/relay-kit.ts";
import { acc, AUDIT, CLEAN_TEXT, disp, fA, fB, FILE, fpR, IA, IB, item, LIN, orderSetup, Sk, TRIAGE, type Json, type Person } from "./helpers/sink-kit.ts";

let k: Sk | undefined;
const dirs: string[] = [];
afterEach(async () => {
  await k?.stop();
  k = undefined;
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
const K = () => k as Sk;
function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), "mesh-rl9-cli-"));
  dirs.push(d);
  return d;
}
const cli = (p: Person, args: string[], cwd?: string) => K().r.cli(p, args, { cwd: cwd ?? tmp() });

async function filed(items = [IA, IB], disps = [acc(fA), acc(fB)]): Promise<string> {
  k = await Sk.start();
  const G1 = await k.run();
  await k.raise(G1, items);
  await k.file(G1, disps);
  return k.CG();
}

// ---- AC-11 fixtures ---------------------------------------------------------------------------

const SINK_TEXT = /sink in step (G\d+\.)?file needs a stage that may set accepted/;
const UNKNOWN = (t: string) => `unknown topic ${t} (define with: mesh topic add <name>)`;

/** A repo preset: audit → file with `sink` given by `sinkLine` (YAML), `may_set` given. */
const preset = (sinkLine: string, maySet = "[accepted]") => `description: Sink check
steps:
  - id: audit
    kind: review
    repo: "{repo}"
    output: review-record
    title: Audit
    brief: Audit it.
  - id: file
    kind: review
    repo: "{repo}"
    deps: [audit]
    output: review-record
    consumes: [open, confirmed, accepted]
    may_set: ${maySet}
    ${sinkLine}
    title: File
    brief: File it.
`;
const NO_ACC = preset("sink: { topic: ci }", "[dismissed]");
const OK = preset("sink: { topic: ci }");
const NOPE = preset("sink: { topic: nope }");
const ALL = preset("sink: { topic: all }");
const PH = preset('sink: { topic: "{topic}" }');

/** The same two steps as a plan body (route) with `file` overridden. */
const planSteps = (file: Record<string, unknown>) => [
  { id: "audit", repo: "r", kind: "review", output: "review-record", title: "Audit", brief: "a", deps: [] },
  { id: "file", repo: "r", kind: "review", deps: ["audit"], output: "review-record", consumes: ["open", "confirmed", "accepted"], may_set: ["accepted"], sink: { topic: "ci" }, title: "File", brief: "f", ...file },
];
const planYaml = (sinkLine: string, maySet = "[accepted]") => `steps:
  - id: audit
    repo: r
    kind: review
    output: review-record
    title: Audit
    brief: a
  - id: file
    repo: r
    kind: review
    deps: [audit]
    output: review-record
    consumes: [open, confirmed, accepted]
    may_set: ${maySet}
    ${sinkLine}
    title: File
    brief: f
`;

function commitPreset(p: Person, name: string, text: string): void {
  mkdirSync(join(p.repoDir, ".mesh", "presets"), { recursive: true });
  writeFileSync(join(p.repoDir, ".mesh", "presets", `${name}.yaml`), text);
  git(p.repoDir, ["add", "-A"]);
  git(p.repoDir, ["commit", "-qm", `preset ${name}`]);
}
const pulseBody = (name: string, text: string, params: Record<string, string> = { repo: "r" }) => ({ preset: snap(name, text), params, when: { every: "7d" } });
const errText = (j: Json) => (typeof j === "string" ? j : String(j?.error ?? JSON.stringify(j)));

// =============================================================================================
// AC-08 goal plan refused (CLI)
// =============================================================================================

describe("RL-9 AC-08 goal plan refused", { timeout: 60_000 }, () => {
  it("test_AC08_plan_refused_cli", async () => {
    const CG = await filed();
    const s = K();
    const d = tmp();
    const valid = join(d, "plan.yaml");
    writeFileSync(valid, "steps:\n  - id: fix\n    repo: r\n    kind: implement\n    title: Fix\n    brief: b\n");
    const invalid = join(d, "bad.yaml");
    writeFileSync(invalid, "steps:\n  - id: fix\n    repo: r\n    kind: implement\n    title: Fix\n    brief: b\n    deps: [nope]\n");
    for (const f of [valid, invalid]) {
      const res = await cli(s.ann, ["goal", "plan", CG, "--file", f]);
      expect(res.code, `${f}: ${res.out}`).not.toBe(0);
      expect(res.err).toContain(CLEAN_TEXT(CG));
    }
    // Control: the same valid file on a plain goal.
    const P = await s.r.goal(s.ann);
    const ok = await cli(s.ann, ["goal", "plan", P, "--file", valid]);
    expect(ok.code, ok.err).toBe(0);
  });
});

// =============================================================================================
// AC-11 Checks
// =============================================================================================

describe("RL-9 AC-11 checks", { timeout: 90_000 }, () => {
  it("test_AC11_sink_needs_accepted", async () => {
    k = await Sk.start();
    const s = k;
    // Positive control: a valid sink stage on a plain goal.
    const P0 = await s.r.goal(s.ann);
    const ok = await s.call(s.ann, "POST", `/v1/goals/${P0}/plan`, { steps: planSteps({}), approve: true });
    expect(ok.status, JSON.stringify(ok.json)).toBe(201);
    expect((await s.step(`${P0}.file`)).policy?.sink).toStrictEqual({ topic: "ci" });
    // Routes.
    const P = await s.r.goal(s.ann);
    const plan = await s.call(s.ann, "POST", `/v1/goals/${P}/plan`, { steps: planSteps({ may_set: ["dismissed"] }), approve: true });
    expect(plan.status, JSON.stringify(plan.json)).toBe(422);
    expect(errText(plan.json)).toMatch(SINK_TEXT);
    const pulse = await s.call(s.ann, "POST", "/v1/pulses", pulseBody("no-acc", NO_ACC));
    expect(pulse.status, JSON.stringify(pulse.json)).toBe(422);
    expect(errText(pulse.json)).toMatch(SINK_TEXT);
    // CLI.
    commitPreset(s.ann, "no-acc", NO_ACC);
    const add = await cli(s.ann, ["pulse", "add", "--preset", "no-acc", "--repo", "r", "--every", "7d"], s.ann.repoDir);
    expect(add.code, add.out).not.toBe(0);
    expect(add.err).toMatch(SINK_TEXT);
    const f = join(tmp(), "plan.yaml");
    writeFileSync(f, planYaml("sink: { topic: ci }", "[dismissed]"));
    const gp = await cli(s.ann, ["goal", "plan", P, "--file", f]);
    expect(gp.code, gp.out).not.toBe(0);
    expect(gp.err).toMatch(SINK_TEXT);
  });

  it("test_AC11_pulse_update", async () => {
    k = await Sk.start();
    const s = k;
    const created = await s.call(s.ann, "POST", "/v1/pulses", pulseBody("ok", OK));
    expect(created.status, JSON.stringify(created.json)).toBe(201);
    const id = created.json.id as string;
    const up = await s.call(s.ann, "POST", `/v1/pulses/${id}/update`, { preset: snap("no-acc", NO_ACC) });
    expect(up.status, JSON.stringify(up.json)).toBe(422);
    expect(errText(up.json)).toMatch(SINK_TEXT);
  });

  it("test_AC11_unknown_topic", async () => {
    k = await Sk.start();
    const s = k;
    for (const [t, text] of [
      ["nope", NOPE],
      ["all", ALL],
    ] as const) {
      const P = await s.r.goal(s.ann);
      const plan = await s.call(s.ann, "POST", `/v1/goals/${P}/plan`, { steps: planSteps({ sink: { topic: t } }), approve: true });
      expect(plan.status, `plan ${t}: ${JSON.stringify(plan.json)}`).toBe(400);
      expect(errText(plan.json)).toBe(UNKNOWN(t));
      const pulse = await s.call(s.ann, "POST", "/v1/pulses", pulseBody(t, text));
      expect(pulse.status, `pulse ${t}: ${JSON.stringify(pulse.json)}`).toBe(400);
      expect(errText(pulse.json)).toBe(UNKNOWN(t));
    }
    // CLI: pulse add with the repo preset.
    commitPreset(s.ann, "nope", NOPE);
    const add = await cli(s.ann, ["pulse", "add", "--preset", "nope", "--repo", "r", "--every", "7d"], s.ann.repoDir);
    expect(add.code).not.toBe(0);
    expect(add.err).toContain(UNKNOWN("nope"));
  });

  it("test_AC11_placeholder", async () => {
    k = await Sk.start();
    const s = k;
    // Unfilled `{topic}`: the existing 400 `bad topic "{topic}"`.
    const pulse = await s.call(s.ann, "POST", "/v1/pulses", pulseBody("ph", PH));
    expect(pulse.status, JSON.stringify(pulse.json)).toBe(400);
    expect(errText(pulse.json)).toMatch(/^bad topic "\{topic\}"/);
    const P = await s.r.goal(s.ann);
    const plan = await s.call(s.ann, "POST", `/v1/goals/${P}/plan`, { steps: planSteps({ sink: { topic: "{topic}" } }), approve: true });
    expect(plan.status, JSON.stringify(plan.json)).toBe(400);
    expect(errText(plan.json)).toMatch(/^bad topic "\{topic\}"/);
    // Filled with `CI`: accepted and stored lowercased.
    commitPreset(s.ann, "ph", PH);
    const G = await s.r.goal(s.ann);
    const gp = await cli(s.ann, ["goal", "plan", G, "--preset", "ph", "--repo", "r", "--params", "topic=CI"], s.ann.repoDir);
    expect(gp.code, gp.err).toBe(0);
    expect((await s.step(`${G}.file`)).policy?.sink).toStrictEqual({ topic: "ci" });
    const add = await cli(s.ann, ["pulse", "add", "--preset", "ph", "--repo", "r", "--params", "topic=CI", "--every", "7d"], s.ann.repoDir);
    expect(add.code, add.err).toBe(0);
    const pulses = await s.call(s.ann, "GET", "/v1/pulses");
    const pid = ((pulses.json.pulses as Json[]) ?? []).map((x) => x.id as string)[0];
    expect(pid, JSON.stringify(pulses.json)).toBeTruthy();
    const fire = await s.call(s.ann, "POST", `/v1/pulses/${pid}/fire`, {});
    expect(fire.status, JSON.stringify(fire.json)).toBe(201);
    const FG = fire.json.slot.goal as string;
    expect((await s.step(`${FG}.file`)).policy?.sink?.topic).toBe("ci");
  });
});

// =============================================================================================
// AC-13 mesh next
// =============================================================================================

describe("RL-9 AC-13 mesh next", { timeout: 60_000 }, () => {
  it("test_AC13_mesh_next", async () => {
    k = await Sk.start();
    const w = await orderSetup(k, ["S3", "S1", "S2", "S4"]);
    const res = await cli(k.bob, ["next"]);
    expect(res.code, res.err).toBe(0);
    const seen: string[] = [];
    for (const m of res.out.matchAll(/\bG\d+\.[a-z0-9-]+/g)) if (!seen.includes(m[0])) seen.push(m[0]);
    // Control: the plain goal's step is listed.
    expect(seen).toContain(w.P);
    expect(seen).toStrictEqual(w.ids);
    expect(w.ids.slice(0, 1)).toStrictEqual([w.x.x4]);
    expect(w.ids.filter((id) => id.startsWith(`${w.CG}.`))).toStrictEqual([w.x.x4, w.x.x1, w.x.x2, w.x.x3]);
  });
});

// =============================================================================================
// AC-14 mesh goal drop
// =============================================================================================

describe("RL-9 AC-14 mesh goal drop", { timeout: 60_000 }, () => {
  it("test_AC14_cli", async () => {
    const CG = await filed();
    const s = K();
    const ida = s.fs(CG, fA);
    await s.hold(s.bob, ida);
    const held = await cli(s.ann, ["goal", "drop", CG]);
    expect(held.code).not.toBe(0);
    expect(held.err).toContain("has held steps");
    expect((await s.goalView(CG)).goal.state).toBe("in_progress");
    expect((await s.r.act(s.bob, ida, "release", {})).status).toBe(200);
    const res = await cli(s.ann, ["goal", "drop", CG, "--reason", "x"]);
    expect(res.code, res.err).toBe(0);
    expect(res.out.trim()).toBe(`Dropped ${CG}`);
    expect((await s.goalView(CG)).goal.state).toBe("dropped");
    const gd = await s.ev("goal.dropped", (e) => e.goal === CG);
    expect(gd).toHaveLength(1);
    expect(gd[0].payload).toMatchObject({ reason: "person", comment: "x" });
  });
});

// =============================================================================================
// AC-15 mesh items sink
// =============================================================================================

describe("RL-9 AC-15 mesh items sink", { timeout: 90_000 }, () => {
  it("test_AC15_cli", async () => {
    k = await Sk.start();
    const s = k;
    const P1 = item("p1", { severity: "S1", title: "T-P1" });
    const P2 = item("p2", { severity: "S2", title: "T-P2" });
    const P4 = item("p4", { severity: "S4", title: "T-P4" });
    const L = LIN("plain");
    const R = await s.run({ preset: "plain", steps: [AUDIT, FILE({ sink: undefined })] });
    await s.raise(R, [P1, P2, P4]);
    await s.file(R, [acc(fpR("p1")), acc(fpR("p2")), acc(fpR("p4"))]);
    expect(await s.cag()).toBeUndefined();
    const dry = await cli(s.ann, ["items", "sink", L, "--topic", "ci", "--min-severity", "S2", "--dry-run"]);
    expect(dry.code, dry.err).toBe(0);
    expect(dry.out.trim()).toBe("would add 2 to a new goal");
    expect(await s.cag()).toBeUndefined();
    // A member who is neither owner nor admin.
    const no = await cli(s.bob, ["items", "sink", L, "--topic", "ci"]);
    expect(no.code).not.toBe(0);
    expect(await s.cag()).toBeUndefined();
    const run = await cli(s.ann, ["items", "sink", L, "--topic", "ci", "--min-severity", "S2"]);
    expect(run.code, run.err).toBe(0);
    const CG = await s.CG();
    expect(run.out.trim()).toBe(`${CG}: added 2, reopened 0`);
    expect(await s.fsteps(CG)).toHaveLength(2);
    const again = await cli(s.ann, ["items", "sink", L, "--topic", "ci", "--min-severity", "S2"]);
    expect(again.out.trim()).toBe(`${CG}: added 0, reopened 0`);
    const dry2 = await cli(s.ann, ["items", "sink", L, "--topic", "ci", "--min-severity", "S2", "--dry-run"]);
    expect(dry2.out.trim()).toBe(`would add 0 to ${CG}`);
    expect(await s.fsteps(CG)).toHaveLength(2);
  });

  // The CLI's convention for a usage problem: exit 2, the usage (or the error) on stderr, no hub call.
  it("test_AC15_usage_errors", async () => {
    k = await Sk.start();
    const s = k;
    const L = LIN("plain");
    const R = await s.run({ preset: "plain", steps: [AUDIT, FILE({ sink: undefined })] });
    await s.raise(R, [item("p1", { severity: "S1", title: "T-P1" })]);
    await s.file(R, [acc(fpR("p1"))]);
    const sinkCalls = (r: { requests: string[] }) => r.requests.filter((x) => x.includes("/items/sink"));
    const noTopic = await cli(s.ann, ["items", "sink", L]);
    expect(noTopic.code, noTopic.err).toBe(2);
    expect(noTopic.err).toMatch(/mesh items sink/);
    expect(sinkCalls(noTopic)).toStrictEqual([]);
    const badSev = await cli(s.ann, ["items", "sink", L, "--topic", "ci", "--min-severity", "S9"]);
    expect(badSev.code, badSev.err).toBe(2);
    expect(badSev.err).toMatch(/S9|mesh items sink/);
    expect(sinkCalls(badSev)).toStrictEqual([]);
    expect(await s.cag()).toBeUndefined();
    // Positive control: the same command with valid arguments calls the hub and exits 0.
    const ok = await cli(s.ann, ["items", "sink", L, "--topic", "ci", "--min-severity", "S2", "--dry-run"]);
    expect(ok.code, ok.err).toBe(0);
    expect(sinkCalls(ok)).toHaveLength(1);
  });
});

// =============================================================================================
// AC-16 mesh show header
// =============================================================================================

describe("RL-9 AC-16 mesh show", { timeout: 60_000 }, () => {
  it("test_AC16_header_counts", async () => {
    k = await Sk.start();
    const s = k;
    const X = [
      item("x1", { severity: "S1", title: "T-X1" }),
      item("x2", { severity: "S2", title: "T-X2" }),
      item("x3", { severity: "S2", title: "T-X3" }),
      item("x4", { severity: "S3", title: "T-X4" }),
      item("x5", { severity: "S3", title: "T-X5" }),
    ];
    const fx = (n: number) => fpR(`x${n}`);
    const G1 = await s.run();
    await s.raise(G1, X);
    await s.file(G1, [1, 2, 3, 4, 5].map((n) => acc(fx(n))));
    const CG = await s.CG();
    await s.doStep(s.ann, s.fs(CG, fx(4)));
    const G2 = await s.run({ steps: [AUDIT, TRIAGE()] });
    await s.raise(G2, X);
    await s.file(G2, [disp(fx(5), "dismissed", { reason: "no" })], { stage: "triage" });
    expect((await s.step(s.fs(CG, fx(5)))).state, "control: X5 dropped").toBe("dropped");
    const res = await cli(s.ann, ["show", CG]);
    expect(res.code, res.err).toBe(0);
    const lines = res.out.split("\n").map((l) => l.trim());
    expect(lines.filter((l) => l.startsWith("clean audits:"))).toStrictEqual(["clean audits: ci on r · open S1 1 · S2 2 · S3 0 · S4 0 · done 1 · dropped 1"]);
    for (const t of ["[S1] T-X1", "[S2] T-X2", "[S2] T-X3"]) expect(res.out, t).toContain(t);
    // Control: a plain goal has no such line.
    const plain = await cli(s.ann, ["show", G1.G]);
    expect(plain.code, plain.err).toBe(0);
    expect(plain.out).not.toContain("clean audits:");
  });
});
