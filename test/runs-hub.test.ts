// RL-11 World tests of `GET /v1/runs` (docs/specs/RL-11.md): the round's machine and the new telemetry
// fields (AC-03), every RunRow field and the waste parts (AC-04), filters and the 400s (AC-05), paging
// (AC-06), the service scope (AC-07) and trial rows (AC-12).

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Ck, DAY, disp, fpOf, item, KEY, HA, P, tel } from "./helpers/calib-kit.ts";
import { body, SOLO_HL } from "./helpers/pulse-kit.ts";
import { L } from "./helpers/review-kit.ts";
import type { Json } from "./helpers/world.ts";

const NOW = Date.UTC(2026, 10, 20, 12);
const runs = async (k: Ck, query = "", who: string | Json = k.c.ann): Promise<{ status: number; json: Json }> =>
  k.r.call(who as never, "GET", `/v1/runs${query}`);
const runsOk = async (k: Ck, query = ""): Promise<Json> => {
  const res = await runs(k, query);
  expect(res.status, `GET /v1/runs${query}: ${JSON.stringify(res.json)}`).toBe(200);
  return res.json;
};
const ids = (page: Json) => (page.runs as Json[]).map((r) => r.runId as string);

/** Telemetry with extra fields over the kit's default. */
const telX = (runId: string, over: Json = {}, agentKey = KEY, agentHash = HA) => ({ ...tel({ runId, agentKey, agentHash, durationMs: 1_000 }), ...over });

/** Report the finished run of round 1 of an already closed step. */
async function report(k: Ck, id: string, telemetry: Json): Promise<{ status: number; json: Json }> {
  return k.r.call(k.c.ann, "POST", `/v1/steps/${id}/run`, { state: "finished", runId: telemetry.runId, round: 1, telemetry });
}

// =============================================================================================
// AC-03, AC-04 Rows, fields and waste
// =============================================================================================

describe("RL-11 AC-03 AC-04 rows", { timeout: 90_000 }, () => {
  let k: Ck;
  const A = fpOf("A");
  const B = fpOf("B");
  const C = fpOf("C");
  let G1 = "";
  let G2 = "";
  let G3 = "";
  let G4 = "";
  const at: Record<string, number> = {};

  beforeAll(async () => {
    k = await Ck.start({ clock: NOW - 5 * DAY });
    const ann = k.c.ann;
    // G1: audit raises A, B, C (run with toolsUsed and denied); the validator accepts A, dismisses B and C.
    G1 = await k.goal(ann, [P.audit(), P.validate({ may_set: ["accepted", "dismissed"] }), P.debrief({ deps: ["validate"], consumes: ["accepted"], may_set: ["dismissed"] })]);
    k.at(NOW - 4 * DAY);
    await k.raise(ann, `${G1}.audit`, [item("A"), item("B"), item("C")]);
    const t1 = telX("r-audit", { toolsUsed: ["Bash", "Read"], denied: [{ tool: "Bash", command: "git", count: 2 }], permissionDenials: { count: 2, tools: ["Bash"] } });
    expect((await report(k, `${G1}.audit`, t1)).status).toBe(200);
    k.tick();
    await k.agentDispose(ann, `${G1}.validate`, [disp(A, "accepted"), disp(B, "dismissed"), disp(C, "dismissed")]);
    // G2: a run killed for its budget, 4 denials, round failed.
    G2 = await k.goal(ann, [P.run("r")]);
    k.at(NOW - 3 * DAY);
    at.G2 = await k.run(ann, `${G2}.r`, telX("r-budget", { exit: "killed_budget", permissionDenials: { count: 4, tools: ["Bash"] } }), "fail");
    // G3: a run the daemon stopped after its accepted mesh_done (no_result), round done.
    G3 = await k.goal(ann, [P.run("r")]);
    k.at(NOW - 2 * DAY);
    at.G3 = await k.run(ann, `${G3}.r`, telX("r-noresult", { exit: "no_result", turnsApprox: true }));
    // G4: a round without telemetry.
    G4 = await k.goal(ann, [P.run("r")]);
    await k.k.claim(ann, `${G4}.r`);
    expect((await k.k.close(ann, `${G4}.r`, { outcome: "done", summary: "ok" })).status).toBe(200);
    k.at(NOW);
  });
  afterAll(async () => {
    await k?.stop();
  });

  it("test_AC03_machine_and_fields", async () => {
    const step = await k.r.stepOf(`${G1}.audit`);
    const round = (step.rounds as Json[])[0];
    expect(round.machine).toBe(k.w.machineOf(k.c.ann));
    expect(round.telemetry.toolsUsed).toStrictEqual(["Bash", "Read"]);
    expect(round.telemetry.denied).toStrictEqual([{ tool: "Bash", command: "git", count: 2 }]);
    const row = (await runsOk(k)).runs.find((r: Json) => r.runId === "r-audit");
    expect(row.machine).toBe(k.w.machineOf(k.c.ann));
    expect(row.telemetry.toolsUsed).toStrictEqual(["Bash", "Read"]);
    expect(row.telemetry.denied).toStrictEqual([{ tool: "Bash", command: "git", count: 2 }]);
  });

  it("test_AC03_invalid_lists", async () => {
    const G = await k.goal(k.c.ann, [P.run("r")]);
    await k.k.claim(k.c.ann, `${G}.r`);
    expect((await k.k.close(k.c.ann, `${G}.r`, { outcome: "done", summary: "ok" })).status).toBe(200);
    const bad: Json[] = [
      { toolsUsed: Array.from({ length: 201 }, (_, i) => `T${String(i).padStart(3, "0")}`) },
      { toolsUsed: ["Read", "Bash"] },
      { toolsUsed: ["Bash", "Bash"] },
      { denied: Array.from({ length: 51 }, (_, i) => ({ tool: "Bash", command: `c${i}`, count: 1 })) },
      { denied: [{ tool: "Bash", count: 0 }] },
      { denied: [{ tool: "Bash", command: "x".repeat(65), count: 1 }] },
      { denied: [{ tool: "Bash", command: "git", count: 1 }, { tool: "Bash", command: "git", count: 2 }] },
    ];
    for (const over of bad) {
      const res = await report(k, `${G}.r`, telX("r-bad", over));
      expect(res.status, JSON.stringify(over).slice(0, 80)).toBe(400);
    }
    expect(((await k.r.stepOf(`${G}.r`)).rounds as Json[])[0].telemetry).toBeUndefined();
  });

  it("test_AC04_rows", async () => {
    const page = await runsOk(k);
    expect(ids(page).filter((x) => x.startsWith("r-") && x !== "r-bad")).toStrictEqual(["r-noresult", "r-budget", "r-audit"]);
    const [noResult, budget, audit] = ["r-noresult", "r-budget", "r-audit"].map((x) => (page.runs as Json[]).find((r) => r.runId === x) as Json);
    const g1 = await k.r.stepOf(`${G1}.audit`);
    const r1 = (g1.rounds as Json[])[0];
    const rv = (await k.k.reviews(k.c.ann, `${G1}.audit`)).json.reviews as Json[];
    expect(audit).toStrictEqual({
      runId: "r-audit",
      goal: G1,
      step: `${G1}.audit`,
      round: 1,
      kind: g1.kind,
      repo: g1.repo,
      user: "ann",
      owner: "ann",
      machine: k.w.machineOf(k.c.ann),
      trial: false,
      ...(r1.startedAt !== undefined ? { startedAt: r1.startedAt } : {}),
      finishedAt: r1.finishedAt,
      outcome: "done",
      telemetry: r1.telemetry,
      fold: rv[0].fold,
      items: { raised: 3, open: 0, confirmed: 0, accepted: 1, dismissed: 2, deferred: 0, resolved: 0 },
      waste: { failed: false, overBudget: false, denials: 2, allDismissed: false },
      artifacts: r1.artifactIds ?? [],
    });
    expect(budget).toMatchObject({ goal: G2, outcome: "fail", finishedAt: at.G2, trial: false, waste: { failed: true, overBudget: true, denials: 4, allDismissed: false } });
    expect("items" in budget).toBe(false);
    expect("pulse" in budget).toBe(false);
    expect(noResult).toMatchObject({ goal: G3, outcome: "done", waste: { failed: false, overBudget: false, denials: 0, allDismissed: false } });
    expect(ids(page)).not.toContain(undefined);
    expect((page.runs as Json[]).some((r) => r.goal === G4)).toBe(false);
  });

  it("test_AC04_all_dismissed_now", async () => {
    await k.k.claim(k.c.ann, `${G1}.debrief`);
    await k.personDispose(k.c.ann, `${G1}.debrief`, A, "dismissed");
    expect((await k.item(A, L)).state).toBe("dismissed");
    const audit = (await runsOk(k)).runs.find((r: Json) => r.runId === "r-audit");
    expect(audit.items).toStrictEqual({ raised: 3, open: 0, confirmed: 0, accepted: 0, dismissed: 3, deferred: 0, resolved: 0 });
    expect(audit.waste.allDismissed).toBe(true);
  });
});

// =============================================================================================
// AC-05, AC-06, AC-07, AC-12 Filters, paging, scope, trial
// =============================================================================================

describe("RL-11 AC-05 AC-06 AC-07 AC-12 queries", { timeout: 90_000 }, () => {
  let k: Ck;
  const t: Record<string, number> & { b: number } = { b: 0 };
  const goals: Record<string, string> = {};
  let p1 = "";
  let p2 = "";

  /** A pulse of `owner` fired now (trial or not); its goal's headless `run` reports `runId` at `when`. */
  async function pulseRun(owner: "ann" | "bob", pulse: string, runId: string, when: number, trial = false, agent = KEY): Promise<{ G: string; at: number }> {
    const pk = k.pulses();
    const res = await pk.act(owner, pulse, "fire", trial ? { trial: true } : {});
    expect(res.status, JSON.stringify(res.json)).toBe(201);
    const G = res.json.slot.goal as string;
    k.at(when);
    const finished = await k.run(k.c[owner], `${G}.run`, tel({ runId, agentKey: agent, agentHash: HA, durationMs: 1_000 }));
    return { G, at: finished };
  }

  beforeAll(async () => {
    k = await Ck.start({ clock: NOW - 31.5 * DAY });
    const pk = k.pulses();
    p1 = (await pk.pulseOk("ann", body({ params: { repo: "alpha" } }, "solo-hl", SOLO_HL))).id as string;
    p2 = (await pk.pulseOk("bob", body({ params: { repo: "beta" } }, "solo-hl", SOLO_HL))).id as string;
    // A row 31 days old, and a row 29 days old outside every other filter (a plain goal of carol).
    goals.old = (await pulseRun("ann", p1, "old", NOW - 31 * DAY)).G;
    const g29 = await k.goal(k.c.carol, [P.run("r")]);
    k.at(NOW - 29 * DAY);
    await k.run(k.c.carol, `${g29}.r`, tel({ runId: "r29", agentKey: "gamma/x", agentHash: HA, durationMs: 1_000 }));
    goals.r29 = g29;
    // a < d < b = c < trial, across pulses, repos, agents and users; b and c tie.
    const a = await pulseRun("ann", p1, "a", NOW - 3 * DAY);
    const b = await pulseRun("bob", p2, "b", NOW - 2 * DAY, false, "beta/other");
    const c = await pulseRun("ann", p1, "c", NOW - 2 * DAY);
    const d = await pulseRun("bob", p2, "d", NOW - 2.5 * DAY, false, "beta/other");
    const tr = await pulseRun("ann", p1, "trial", NOW - 1 * DAY + 1, true);
    Object.assign(goals, { a: a.G, b: b.G, c: c.G, d: d.G, tr: tr.G });
    Object.assign(t, { a: a.at, b: b.at, c: c.at, d: d.at, tr: tr.at });
    k.at(NOW);
  });
  afterAll(async () => {
    await k?.stop();
  });

  it("test_AC05_filters", async () => {
    expect(ids(await runsOk(k))).toStrictEqual([...sortRuns(["a", "b", "c", "d"]), "r29"]);
    // The default window is 30 days: 29 days old is in, 31 is out.
    expect(ids(await runsOk(k, `?goal=${goals.r29}`))).toStrictEqual(["r29"]);
    expect(ids(await runsOk(k, `?goal=${goals.old}`))).toStrictEqual([]);
    // An empty or unknown goal gives no rows.
    expect(ids(await runsOk(k, "?goal="))).toStrictEqual([]);
    expect(ids(await runsOk(k, "?goal=G999"))).toStrictEqual([]);
    expect(ids(await runsOk(k, `?goal=${goals.a}`))).toStrictEqual(["a"]);
    expect(ids(await runsOk(k, `?pulse=${p2}`))).toStrictEqual(sortRuns(["b", "d"]));
    expect(ids(await runsOk(k, "?repo=beta"))).toStrictEqual(sortRuns(["b", "d"]));
    expect(ids(await runsOk(k, `?agent=${encodeURIComponent(KEY)}`))).toStrictEqual(sortRuns(["a", "c"]));
    expect(ids(await runsOk(k, "?user=bob"))).toStrictEqual(sortRuns(["b", "d"]));
    expect(ids(await runsOk(k, `?since=${t.b}`))).toStrictEqual(sortRuns(["b", "c"]));
    expect(ids(await runsOk(k, `?until=${t.b}`))).toStrictEqual([...sortRuns(["a", "d"]), "r29"]);
    const iso = new Date(t.b).toISOString();
    // The same instant as t.b written with a +02:00 offset.
    const off = new Date(t.b + 7_200_000).toISOString().replace("Z", "+02:00");
    expect(ids(await runsOk(k, `?since=${encodeURIComponent(iso)}`))).toStrictEqual(sortRuns(["b", "c"]));
    expect(ids(await runsOk(k, `?until=${encodeURIComponent(off)}`))).toStrictEqual([...sortRuns(["a", "d"]), "r29"]);
    // The default window is 30 days: the 31-day-old row is left out; asking for it brings it back.
    expect(ids(await runsOk(k, `?since=${NOW - 32 * DAY}`))).toContain("old");
    // Only an old `until`: an empty list, not a 400.
    expect(ids(await runsOk(k, `?until=${NOW - 35 * DAY}`))).toStrictEqual([]);
  });

  /** Expected order of `xs`: newest finishedAt first, then goal, step, round. */
  function sortRuns(xs: string[]): string[] {
    const at = (x: string) => t[x] ?? 0;
    const g = (x: string) => goals[x] ?? "";
    return [...xs].sort((x, y) => at(y) - at(x) || (g(x) < g(y) ? -1 : g(x) > g(y) ? 1 : 0));
  }

  it("test_AC05_400", async () => {
    const cases: [string, string][] = [
      ["?since=Nov%2020%202026", "since must be milliseconds since the epoch or an ISO time"],
      ["?since=abc", "since must be milliseconds since the epoch or an ISO time"],
      ["?until=2026-13-45T99:99:99Z", "until must be milliseconds since the epoch or an ISO time"],
      [`?since=${t.b}&until=${t.b}`, "since must be before until"],
      ["?limit=0", "limit must be a whole number from 1 to 1000"],
      ["?limit=1001", "limit must be a whole number from 1 to 1000"],
      ["?trial=yes", "trial must be exclude, include or only"],
      ["?cursor=%%%", "cursor is not valid"],
      ["?cursor=bm90IGpzb24", "cursor is not valid"],
    ];
    for (const [q, msg] of cases) {
      const res = await runs(k, q);
      expect(res, q).toStrictEqual({ status: 400, json: { error: msg } });
    }
  });

  it("test_AC06_paging", async () => {
    const all = ids(await runsOk(k, `?trial=include&since=${NOW - 10 * DAY}`));
    expect(all).toHaveLength(5);
    // b and c share finishedAt and are rows 2 and 3: the boundary between pages 1 and 2 splits them.
    expect(t.b).toBe(t.c);
    expect([all[1], all[2]].sort()).toStrictEqual(["b", "c"]);
    const pages: string[][] = [];
    let cursor: string | undefined;
    for (;;) {
      const page = await runsOk(k, `?trial=include&since=${NOW - 10 * DAY}&limit=2${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`);
      pages.push(ids(page));
      cursor = page.next as string | undefined;
      if (!cursor) break;
    }
    expect(pages.map((p) => p.length)).toStrictEqual([2, 2, 1]);
    expect(pages.flat()).toStrictEqual(all);
  });

  it("test_AC07_scope", async () => {
    const reader = await k.w.hub.svc.serviceToken("viewer", ["goals:read"]);
    const writer = await k.w.hub.svc.serviceToken("writer", ["goals:write"]);
    expect((await k.w.call(reader, "GET", "/v1/runs")).status).toBe(200);
    expect((await k.w.call(writer, "GET", "/v1/runs")).status).toBe(403);
    expect((await k.w.call(undefined, "GET", "/v1/runs")).status).toBe(401);
  });

  it("test_AC12_trial_rows", async () => {
    expect(ids(await runsOk(k))).not.toContain("trial");
    expect(ids(await runsOk(k, "?trial=include"))).toContain("trial");
    expect(ids(await runsOk(k, "?trial=include"))).toContain("a");
    expect(ids(await runsOk(k, "?trial=only"))).toStrictEqual(["trial"]);
    const row = (await runsOk(k, "?trial=only")).runs[0];
    expect(row).toMatchObject({ trial: true, pulse: p1, goal: goals.tr });
  });
});
