// RL-19 World tests of `GET /v1/findings/rollup` (docs/specs/RL-19.md): rows, counts, kind and pulse
// (AC-01), latestReport (AC-02), aggregation (AC-03), target repo (AC-04), the window (AC-05), trial
// and excluded goals (AC-06), filters and 400s (AC-07), the preset kind through the hub (AC-08), scopes,
// on-behalf, no writes and features (AC-09).

import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { Ck, DAY, disp, fpOf, item, P } from "./helpers/calib-kit.ts";
import { HOUR, snap, type Pk } from "./helpers/pulse-kit.ts";
import type { Json, Person } from "./helpers/world.ts";
import type { HubStore } from "../src/store/index.ts";

const NOW = Date.UTC(2026, 10, 20, 12, 30);
const AUD = { key: "repo/auditor", hash: "a".repeat(64) };
const VAL = { key: "repo/validator", hash: "b".repeat(64) };
const Z = { S1: 0, S2: 0, S3: 0, S4: 0 };
const sev = (o: Partial<typeof Z>) => ({ ...Z, ...o });

/** audit ({agent}) → validate: the validator may confirm, accept or dismiss. */
const relay = (kind?: string) => `description: Audit and validate
${kind ? `kind: ${kind}\n` : ""}steps:
  - id: audit
    kind: review
    repo: "{repo}"
    mode: headless
    agent: "{agent}"
    output: review-record
    title: Audit
    brief: Audit.
  - id: validate
    kind: review
    repo: "{repo}"
    deps: [audit]
    mode: headless
    agent: validator
    output: review-record
    consumes: [open]
    may_set: [confirmed, accepted, dismissed]
    title: Validate
    brief: Validate.
`;
const RELAY_A = relay("code-audit");
const RELAY_B = relay();
const pulseBody = (preset: "relay-a" | "relay-b", repo: string, agent = "auditor", text?: string) => ({
  preset: snap(preset, text ?? (preset === "relay-a" ? RELAY_A : RELAY_B)),
  params: { repo, agent },
  when: { every: "1d", at: NOW + 60 * DAY },
  overlap: "allow",
  maxGoalAge: "60d",
});

const rollup = (k: Ck, q = "", who: unknown = k.c.ann): Promise<{ status: number; json: Json }> => k.r.call(who as never, "GET", `/v1/findings/rollup${q}`);
const rollupOk = async (k: Ck, q = ""): Promise<Json> => {
  const res = await rollup(k, q);
  expect(res.status, `rollup${q}: ${JSON.stringify(res.json)}`).toBe(200);
  return res.json;
};
const rowsOf = async (k: Ck, q = ""): Promise<Json[]> => (await rollupOk(k, q)).rows as Json[];
const rowOf = async (k: Ck, repo: string, preset: string, q = ""): Promise<Json | undefined> => (await rowsOf(k, q)).find((r) => r.repo === repo && r.preset === preset);
const storeOf = (k: Ck) => (k.w.hub.svc as unknown as { store: HubStore }).store;

interface Rep {
  content: string;
  title?: string;
}
/** Claim a step, upload `reports` (one ms apart), submit a record, close it done. Returns report ids and the record time. */
async function stage(k: Ck, who: Person, id: string, o: { items?: unknown[]; dispositions?: unknown[]; agent?: { key: string; hash?: string }; reports?: Rep[] }): Promise<{ reports: string[]; at: number }> {
  await k.k.claim(who, id);
  const reports: string[] = [];
  for (const r of o.reports ?? []) {
    k.tick(1);
    const u = await k.r.call(who, "POST", `/v1/steps/${id}/artifacts`, { kind: "report", content: r.content, ...(r.title ? { title: r.title } : {}) });
    expect(u.status, JSON.stringify(u.json)).toBe(201);
    reports.push(u.json.id as string);
  }
  const at = k.tick(1);
  const res = await k.k.review(who, id, { coverage: "complete", assessment: (o.items ?? []).length ? "issues" : "clean", items: o.items ?? [], dispositions: o.dispositions ?? [], summary: "s", ...(o.agent ? { agent: o.agent } : {}) });
  expect(res.status, `review ${id}: ${JSON.stringify(res.json)}`).toBe(201);
  const d = await k.k.close(who, id, { outcome: "done", summary: "ok" });
  expect(d.status, `close ${id}: ${JSON.stringify(d.json)}`).toBe(200);
  return { reports, at };
}
const fire = async (pk: Pk, id: string): Promise<string> => (await pk.fireOk("ann", id)).goal as string;

// =============================================================================================
// One hub: AC-01, AC-02, AC-03, AC-06 (trial), AC-07, AC-09
// =============================================================================================

describe("RL-19 roll-up", { timeout: 120_000 }, () => {
  let k: Ck;
  let pk: Pk;
  const A = (r: string) => fpOf(r);
  let g1 = { reports: [] as string[], at: 0 };
  let g3 = { reports: [] as string[], at: 0 };
  let g4 = { reports: [] as string[], at: 0 };
  let g2at = 0;
  let trialAudit = { reports: [] as string[], at: 0 };
  let G3 = "";
  let G3v = "";
  let G4 = "";
  let GT = "";

  beforeAll(async () => {
    k = await Ck.start({ clock: NOW - 3 * DAY });
    pk = k.pulses();
    const ann = k.c.ann;
    await pk.pulseOk("ann", pulseBody("relay-a", "alpha")); // p-1
    await pk.pulseOk("ann", pulseBody("relay-a", "beta")); // p-2
    await pk.pulseOk("ann", pulseBody("relay-b", "alpha")); // p-3
    await pk.pulseOk("ann", pulseBody("relay-a", "alpha", "auditor2")); // p-4
    await pk.pulseOk("ann", pulseBody("relay-b", "beta")); // p-5 (trial only)

    // p-1 (alpha, relay-a): all four severities; the validator confirms, accepts (with and without a link) and dismisses.
    k.at(NOW - 2 * DAY);
    const G1 = await fire(pk, "p-1");
    g1 = await stage(k, ann, `${G1}.audit`, {
      items: [item("A1", { severity: "S1" }), item("A2", { severity: "S2" }), item("A3", { severity: "S3" }), item("A4", { severity: "S4" }), item("A5", { severity: "S1" })],
      agent: AUD,
      reports: [{ content: "# p-1 report" }],
    });
    await stage(k, ann, `${G1}.validate`, {
      dispositions: [disp(A("A2"), "confirmed"), disp(A("A3"), "accepted", { link: "https://tracker.example/A3" }), disp(A("A4"), "accepted"), disp(A("A5"), "dismissed")],
      agent: VAL,
    });

    // p-2 (beta, relay-a): no report.
    const G2 = await fire(pk, "p-2");
    g2at = (await stage(k, ann, `${G2}.audit`, { items: [item("C1", { severity: "S2" }), item("C2", { severity: "S3" })], agent: AUD })).at;
    await stage(k, ann, `${G2}.validate`, { dispositions: [disp(A("C2"), "accepted")], agent: VAL });

    // p-3 (alpha, relay-b): two reports on the audit step, a later one on the validate step.
    G3 = await fire(pk, "p-3");
    g3 = await stage(k, ann, `${G3}.audit`, { items: [item("D1", { severity: "S4" })], agent: AUD, reports: [{ content: "# first" }, { content: "# second", title: "Audit report" }] });
    G3v = `${G3}.validate`;
    await stage(k, ann, G3v, { dispositions: [], agent: VAL, reports: [{ content: "# validate" }] });

    // p-4 (alpha, relay-a, another agent), an hour later.
    k.at(NOW - 2 * DAY + HOUR);
    G4 = await fire(pk, "p-4");
    g4 = await stage(k, ann, `${G4}.audit`, { items: [item("B1", { severity: "S2" }), item("B2", { severity: "S4" })], agent: AUD, reports: [{ content: "# p-4 report" }] });

    // A trial fire of p-5 (beta, relay-b), and a trial run of p-1 that raises T (a complete audit lists every item again).
    k.at(NOW - DAY);
    const G5 = (await pk.act("ann", "p-5", "fire", { trial: true })).json.slot.goal as string;
    await stage(k, ann, `${G5}.audit`, { items: [item("E1", { severity: "S1" })], agent: AUD });
    GT = (await pk.act("ann", "p-1", "fire", { trial: true })).json.slot.goal as string;
    trialAudit = await stage(k, ann, `${GT}.audit`, {
      items: [item("A1", { severity: "S1" }), item("A2", { severity: "S2" }), item("A3", { severity: "S3" }), item("A4", { severity: "S4" }), item("A5", { severity: "S1" }), item("T", { severity: "S3" })],
      agent: AUD,
      reports: [{ content: "# trial report" }],
    });
    k.at(NOW);
  });
  afterAll(async () => {
    await k?.stop();
  });

  it("test_AC01_rows_counts_kind_pulse", async () => {
    const r = await rollupOk(k);
    expect(r.window).toStrictEqual({ since: NOW - 30 * DAY, until: NOW, days: 30 });
    const rows = r.rows as Json[];
    expect(rows.map((x) => [x.repo, x.preset])).toStrictEqual([
      ["alpha", "relay-a"],
      ["alpha", "relay-b"],
      ["beta", "relay-a"],
    ]);
    const [aa, ab, ba] = rows as [Json, Json, Json];
    // (alpha, relay-a): p-1 (A1 S1 open, A2 S2 confirmed, A3 S3 and A4 S4 accepted, A5 dismissed, T S3 from the trial run) + p-4 (B1 S2, B2 S4 open).
    expect(aa.open).toStrictEqual(sev({ S1: 1, S2: 2, S3: 1, S4: 1 }));
    expect(aa.accepted).toStrictEqual(sev({ S3: 1, S4: 1 }));
    expect(aa.kind).toBe("code-audit");
    // (alpha, relay-b): no kind declared.
    expect(ab).toStrictEqual({ preset: "relay-b", repo: "alpha", pulse: "p-3", lineages: 1, lastRaisedAt: g3.at, open: sev({ S4: 1 }), accepted: Z, latestReport: ab.latestReport });
    expect("kind" in ab).toBe(false);
    // (beta, relay-a): no report.
    expect(ba).toStrictEqual({ preset: "relay-a", repo: "beta", kind: "code-audit", pulse: "p-2", lineages: 1, lastRaisedAt: g2at, open: sev({ S2: 1 }), accepted: sev({ S3: 1 }) });
    // No cost anywhere.
    expect(JSON.stringify(r)).not.toMatch(/cost|usd/i);
  });

  it("test_AC02_latest_report", async () => {
    const ab = (await rowOf(k, "alpha", "relay-b")) as Json;
    // The audit step's second report, not the validate step's later one.
    expect(ab.latestReport).toStrictEqual({ ref: g3.reports[1], at: ab.latestReport.at, goal: G3, step: `${G3}.audit`, round: 1, title: "Audit report" });
    const art = (await k.r.call(k.c.ann, "GET", `/v1/artifacts/${g3.reports[1]}`)).json;
    expect(ab.latestReport.at).toBe(art.artifact.createdAt);
    const validateArt = (await storeOf(k).listArtifacts({ step: G3v }))[0];
    expect(validateArt?.createdAt).toBeGreaterThan(ab.latestReport.at as number);
    expect("latestReport" in ((await rowOf(k, "beta", "relay-a")) as Json)).toBe(false);
    // Pruned content: the row still names the report, marked pruned.
    expect(await storeOf(k).pruneArtifacts([G3], NOW, NOW)).toBeGreaterThan(0);
    expect(((await rowOf(k, "alpha", "relay-b")) as Json).latestReport).toStrictEqual({ ...ab.latestReport, pruned: true });
  });

  it("test_AC03_two_agents_one_row", async () => {
    const aa = (await rowOf(k, "alpha", "relay-a")) as Json;
    expect(aa.lineages).toBe(2);
    expect(aa.pulse).toBe("p-4");
    expect(aa.lastRaisedAt).toBe(g4.at);
    expect(aa.latestReport).toMatchObject({ ref: g4.reports[0], goal: G4, step: `${G4}.audit` });
    expect(g4.at).toBeGreaterThan(g1.at);
  });

  it("test_AC06_trial", async () => {
    // exclude (default): no trial-only row; the trial run's report and record are left out, its items are not.
    expect(await rowOf(k, "beta", "relay-b")).toBeUndefined();
    const inc = (await rowOf(k, "beta", "relay-b", "?trial=include")) as Json;
    expect(inc).toMatchObject({ preset: "relay-b", repo: "beta", pulse: "p-5", lineages: 1, open: sev({ S1: 1 }), accepted: Z });
    expect("kind" in inc).toBe(false);
    const aaInc = (await rowOf(k, "alpha", "relay-a", "?trial=include")) as Json;
    expect(aaInc.latestReport).toMatchObject({ ref: trialAudit.reports[0], goal: GT });
    expect(aaInc.lastRaisedAt).toBe(trialAudit.at);
    expect(aaInc.pulse).toBe("p-1");
    const aa = (await rowOf(k, "alpha", "relay-a")) as Json;
    expect(aa.open).toStrictEqual(aaInc.open);
    expect(aa.open.S3).toBe(1); // T
  });

  it("test_AC07_filters", async () => {
    const all = await rowsOf(k);
    const keys = (rows: Json[]) => rows.map((x) => `${x.repo}/${x.preset}`);
    expect(keys(await rowsOf(k, "?repo=beta"))).toStrictEqual(["beta/relay-a"]);
    expect(keys(await rowsOf(k, "?preset=relay-b"))).toStrictEqual(["alpha/relay-b"]);
    expect(keys(await rowsOf(k, "?repo=alpha&preset=relay-a"))).toStrictEqual(["alpha/relay-a"]);
    expect(await rowsOf(k, "?repo=nope")).toStrictEqual([]);
    for (const q of ["?repo=beta", "?preset=relay-b", "?repo=alpha&preset=relay-a"]) {
      for (const row of await rowsOf(k, q)) expect(row).toStrictEqual(all.find((x) => x.repo === row.repo && x.preset === row.preset));
    }
  });

  it("test_AC07_400s", async () => {
    const DAYS = "days must be a whole number from 1 to 365";
    for (const [q, msg] of [
      ["?days=0", DAYS],
      ["?days=366", DAYS],
      ["?days=x", DAYS],
      ["?days=1.5", DAYS],
      ["?days=0365", DAYS],
      ["?days=", DAYS],
      ["?trial=only", "trial must be exclude or include"],
    ] as const) {
      expect(await rollup(k, q), q).toStrictEqual({ status: 400, json: { error: msg } });
    }
    expect((await rollupOk(k, "?days=365")).window.days).toBe(365);
    expect((await rollupOk(k, "?days=1")).window).toStrictEqual({ since: NOW - DAY, until: NOW, days: 1 });
  });

  it("test_AC09_scopes_on_behalf_no_writes", async () => {
    const svc = k.w.hub.svc;
    const withScope = await svc.serviceToken("dash", ["goals:read"]);
    const without = await svc.serviceToken("other", []);
    const goalsBefore = JSON.stringify((await k.r.call(k.c.ann, "GET", "/v1/goals?pulses=1")).json);
    const stepsBefore = JSON.stringify((await storeOf(k).listSteps({})).map((s) => [s.id, s.updatedAt]));
    const evBefore = (await k.r.call(k.c.ann, "GET", "/v1/events?after=0&limit=1000")).json;
    const path = "/v1/findings/rollup";
    expect((await k.w.call(withScope, "GET", path)).status).toBe(200);
    expect((await k.w.call(without, "GET", path)).status).toBe(403);
    expect((await k.w.call(undefined as never, "GET", path)).status).toBe(401);
    expect(await k.w.call(withScope, "GET", path, undefined, { "x-mesh-on-behalf-of": "ann" })).toStrictEqual({ status: 400, json: { error: "on-behalf-of is not accepted on this route", code: "on-behalf-of-not-accepted" } });
    expect(JSON.stringify((await k.r.call(k.c.ann, "GET", "/v1/goals?pulses=1")).json)).toBe(goalsBefore);
    expect(JSON.stringify((await storeOf(k).listSteps({})).map((s) => [s.id, s.updatedAt]))).toBe(stepsBefore);
    expect((await k.r.call(k.c.ann, "GET", "/v1/events?after=0&limit=1000")).json).toStrictEqual(evBefore);
    const features = (await k.w.call(undefined as never, "GET", "/healthz")).json.features as string[];
    expect(features).toContain("findings-rollup");
    expect([...features].sort()).toStrictEqual(features);
  });
});

// =============================================================================================
// AC-04 target repo
// =============================================================================================

describe("RL-19 AC-04 target repo", { timeout: 90_000 }, () => {
  let k: Ck;
  afterAll(async () => {
    await k?.stop();
  });

  it("test_AC04_target_repo_and_retarget", async () => {
    k = await Ck.start({ clock: NOW - 2 * DAY });
    const pk = k.pulses();
    const ann = k.c.ann;
    await pk.pulseOk("ann", pulseBody("relay-a", "alpha")); // pA = p-1
    await pk.pulseOk("ann", pulseBody("relay-a", "beta")); // pB = p-2
    const GB = await fire(pk, "p-2");
    const t1 = await stage(k, ann, `${GB}.audit`, { items: [item("B1", { severity: "S2" })], agent: AUD, reports: [{ content: "# RB" }] });
    k.tick(HOUR);
    const GA = await fire(pk, "p-1");
    const t2 = await stage(k, ann, `${GA}.audit`, { items: [item("A1", { severity: "S1" }), { ...item("X1", { severity: "S3" }), repo: "beta" }], agent: AUD, reports: [{ content: "# RA" }] });
    k.at(NOW);
    const rows = await rowsOf(k);
    expect(rows.map((x) => [x.repo, x.preset])).toStrictEqual([
      ["alpha", "relay-a"],
      ["beta", "relay-a"],
    ]);
    const [alpha, beta] = rows as [Json, Json];
    expect(alpha).toMatchObject({ lineages: 1, open: sev({ S1: 1 }), accepted: Z, pulse: "p-1", lastRaisedAt: t2.at });
    expect(alpha.latestReport.ref).toBe(t2.reports[0]);
    // The beta row: its own audit's pulse, time and report, although the alpha audit is newer.
    expect(beta).toMatchObject({ lineages: 2, open: sev({ S2: 1, S3: 1 }), accepted: Z, pulse: "p-2", lastRaisedAt: t1.at });
    expect(beta.latestReport.ref).toBe(t1.reports[0]);

    const res = await k.r.call(ann, "POST", "/v1/items/retarget", { lineage: "relay-a|alpha|auditor", fps: [fpOf("A1")], repo: "gamma" });
    expect(res.status, JSON.stringify(res.json)).toBe(200);
    const after = await rowsOf(k);
    expect(after.map((x) => [x.repo, x.preset])).toStrictEqual([
      ["alpha", "relay-a"],
      ["beta", "relay-a"],
      ["gamma", "relay-a"],
    ]);
    const [a2, , gamma] = after as [Json, Json, Json];
    // The audited repo keeps its row with zeros.
    expect(a2).toMatchObject({ lineages: 1, open: Z, accepted: Z, pulse: "p-1" });
    // No home lineage: the retargeting audit's pulse, time and report.
    expect(gamma).toMatchObject({ lineages: 1, open: sev({ S1: 1 }), accepted: Z, pulse: "p-1", lastRaisedAt: t2.at, kind: "code-audit" });
    expect(gamma.latestReport.ref).toBe(t2.reports[0]);
    // A filter on the row repo never changes a row's counts (the alpha lineage feeds three rows).
    expect(await rowsOf(k, "?repo=gamma")).toStrictEqual([gamma]);
    expect(await rowsOf(k, "?repo=alpha")).toStrictEqual([a2]);
    // A deleted pulse is not named.
    const del = await pk.act("ann", "p-2", "delete");
    expect(del.status, JSON.stringify(del.json)).toBe(200);
    const b2 = (await rowOf(k, "beta", "relay-a")) as Json;
    expect("pulse" in b2).toBe(false);
    expect(b2.open).toStrictEqual(sev({ S2: 1, S3: 1 }));
  });
});

// =============================================================================================
// AC-05 window (a goal without a schedule and without a preset)
// =============================================================================================

describe("RL-19 AC-05 window", { timeout: 90_000 }, () => {
  let k: Ck;
  afterAll(async () => {
    await k?.stop();
  });

  it("test_AC05_window", async () => {
    const T0 = NOW - 40 * DAY;
    k = await Ck.start({ clock: T0 - HOUR });
    const ann = k.c.ann;
    const G = await k.goal(ann, [P.audit(), P.validate({ may_set: ["confirmed", "dismissed"] }), P.debrief({ consumes: ["open", "confirmed"] })]);
    k.at(T0 - 1);
    const rec = await stage(k, ann, `${G}.audit`, { items: [item("W1", { severity: "S2" }), item("W2", { severity: "S3" })], agent: AUD });
    await stage(k, ann, `${G}.validate`, { dispositions: [disp(fpOf("W1"), "confirmed")], agent: VAL });
    // Accepted yesterday by a person in the goal's debrief.
    k.at(NOW - DAY);
    // A fresh login: the first one expired over 40 days.
    const again = (await k.w.login("ann", { hostname: "ann-again" })).token;
    await k.k.claim(again, `${G}.debrief`);
    await k.personDispose(again, `${G}.debrief`, fpOf("W1"), "accepted");
    k.at(NOW);
    const read = async (q: string) => {
      const res = await k.r.call(again, "GET", `/v1/findings/rollup${q}`);
      expect(res.status, JSON.stringify(res.json)).toBe(200);
      return res.json.rows as Json[];
    };
    expect(await read("")).toStrictEqual([]);
    const rows = await read("?days=45");
    expect(rows).toHaveLength(1);
    const row = rows[0] as Json;
    // A goal without a preset: preset "-", no kind, no pulse; current states.
    expect(row).toStrictEqual({ preset: "-", repo: "/src/alpha", lineages: 1, lastRaisedAt: rec.at, open: sev({ S3: 1 }), accepted: sev({ S2: 1 }) });
    // The boundary: a record exactly at since counts, one 1 ms older does not.
    k.at(rec.at + 45 * DAY);
    expect(await read("?days=45")).toHaveLength(1);
    k.at(rec.at + 45 * DAY + 1);
    expect(await read("?days=45")).toStrictEqual([]);
  });
});

// =============================================================================================
// AC-06 calibration and spot-check goals; AC-08 preset kind through the hub
// =============================================================================================

describe("RL-19 AC-06 AC-08 hub goals and kinds", { timeout: 90_000 }, () => {
  let k: Ck | undefined;
  afterEach(async () => {
    await k?.stop();
    k = undefined;
  });

  it("test_AC06_calibration_and_spot_check_goals", async () => {
    k = await Ck.start({ threshold: 1, spotChecks: { rate: 1, min_per_week: 0 }, clock: NOW - DAY });
    const ann = k.c.ann;
    // One goal whose validator dismisses A: a calibration goal (threshold 1) and a spot check (rate 1).
    const G = await k.goal(ann, [P.audit(), P.validate()]);
    k.tick();
    await k.raise(ann, `${G}.audit`, [item("A")]);
    k.tick();
    await k.agentDispose(ann, `${G}.validate`, [disp(fpOf("A"), "dismissed")]);
    const cal = (await k.calibGoals())[0] as Json;
    const spot = (await k.ev("spot-check.opened"))[0]?.goal as string;
    expect(cal?.id).toBeDefined();
    expect(spot).toBeDefined();
    // Their raising records (no items), as their steps submit them.
    const store = storeOf(k);
    const base = (await store.listReviews({ raising: true }))[0] as Awaited<ReturnType<HubStore["listReviews"]>>[number];
    for (const [goal, step, lineage] of [
      [cal.id as string, `${cal.id}.calibrate`, "calibrate|/src/alpha|calibrate"],
      [spot, `${spot}.check`, "spot-check|/src/alpha|check"],
    ] as const) {
      expect(await store.addReview({ ...base, goal, step, round: 1, lineage, record: { ...base.record, items: [] }, at: k.tick() })).toBe(true);
    }
    k.at(NOW);
    const rows = await rowsOf(k, "?trial=include");
    expect(rows.map((r) => [r.repo, r.preset])).toStrictEqual([["/src/alpha", "-"]]);
  });

  it("test_AC08_pulse_create_kind", async () => {
    k = await Ck.start({ clock: NOW });
    const pk = k.pulses();
    const bad = await pk.pulse("ann", pulseBody("relay-a", "alpha", "auditor", relay("Bad Kind")));
    expect(bad.status, JSON.stringify(bad.json)).toBe(422);
    expect(bad.json.error).toContain("kind must match ^[a-z][a-z0-9-]{0,39}$");
    const num = await pk.pulse("ann", pulseBody("relay-a", "alpha", "auditor", RELAY_B.replace("steps:", "kind: 5\nsteps:")));
    expect(num.status).toBe(422);
    await pk.pulseOk("ann", pulseBody("relay-a", "alpha"));
    // Ingest refuses it too.
    const ing = await k.r.call(k.c.ann, "POST", "/v1/goals/from-preset", { title: "x", preset: snap("relay-a", relay("Bad Kind")), params: { repo: "alpha", agent: "auditor" } });
    expect(ing.status, JSON.stringify(ing.json)).toBe(422);
  });

  it("test_AC08_stored_invalid_kind_fires_and_updates", async () => {
    k = await Ck.start({ clock: NOW - DAY });
    const pk = k.pulses();
    await pk.pulseOk("ann", pulseBody("relay-b", "alpha"));
    // A snapshot stored before this release with an invalid kind.
    const store = storeOf(k);
    const p = (await store.getPulse("p-1")) as NonNullable<Awaited<ReturnType<HubStore["getPulse"]>>>;
    await store.savePulse({ ...p, preset: snap("relay-b", relay("Bad Kind")) });
    const upd = await pk.act("ann", "p-1", "update", { params: { repo: "alpha", agent: "auditor2" } });
    expect(upd.status, JSON.stringify(upd.json)).toBe(200);
    const G = await fire(pk, "p-1");
    await stage(k, k.c.ann, `${G}.audit`, { items: [item("K")], agent: AUD });
    k.at(NOW);
    const row = (await rowsOf(k))[0] as Json;
    expect(row).toMatchObject({ preset: "relay-b", repo: "alpha", pulse: "p-1" });
    expect("kind" in row).toBe(false);
    // Sending the bad preset in an update is refused.
    const upd2 = await pk.act("ann", "p-1", "update", { preset: snap("relay-b", relay("Bad Kind")) });
    expect(upd2.status).toBe(422);
  });
});
