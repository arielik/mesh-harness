// RL-17 World tests of `GET /v1/changes` and `GET /v1/agents/:key/compare` (docs/specs/RL-17.md):
// profile, agent, catalog, pin and preset timelines (AC-01..AC-05), paging and 400s (AC-06), compare
// runs against `GET /v1/runs` (AC-07), compare items against the stats route (AC-08), compare 400s
// (AC-09), scopes, no writes and features (AC-10).

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Ck, DAY, disp, enc, fpOf, HA, HB, item, KEY, P, sha, tel } from "./helpers/calib-kit.ts";
import { body, SOLO_HL, snap } from "./helpers/pulse-kit.ts";
import { C2, C3, H1, H2, REV1, REV2, ROSTER_HL } from "./helpers/roster-kit.ts";
import type { Json } from "./helpers/world.ts";

const NOW = Date.UTC(2026, 10, 20, 12);
const BETA = "/src/beta";
const PROF1 = "description: one\nallow:\n  - Read\n";
const PROF2 = "description: two\nallow:\n  - Read\n  - Bash(npm test)\n";

const changes = async (k: Ck, query = ""): Promise<{ status: number; json: Json }> => k.r.call(k.c.ann, "GET", `/v1/changes${query}`);
const changesOk = async (k: Ck, query = ""): Promise<Json[]> => {
  const res = await changes(k, query);
  expect(res.status, `GET /v1/changes${query}: ${JSON.stringify(res.json)}`).toBe(200);
  return res.json.changes as Json[];
};
const compare = async (k: Ck, key: string, query: string): Promise<{ status: number; json: Json }> => k.r.call(k.c.ann, "GET", `/v1/agents/${enc(key)}/compare${query}`);
const compareOk = async (k: Ck, key: string, query: string): Promise<Json> => {
  const res = await compare(k, key, query);
  expect(res.status, `compare ${query}: ${JSON.stringify(res.json)}`).toBe(200);
  return res.json;
};
/** An event as a change entry shows it. */
const evView = (e: Json): Json => ({ id: e.id, seq: e.seq, type: e.type, at: e.at, ...(e.user !== undefined && e.user !== null ? { user: e.user } : {}) });
/** Telemetry of one run (the kit's literal with a profile and extra fields). */
const telOf = (runId: string, agentKey: string, agentHash: string | undefined, over: Json = {}): Json => ({ ...tel({ runId, agentKey, ...(agentHash !== undefined ? { agentHash } : {}), durationMs: 1_000 }), ...over });

/** A plain goal with one headless step `r` whose run reports `telemetry` now; returns the goal and step. */
async function plainRun(k: Ck, telemetry: Json, o: { repo?: string; outcome?: "done" | "fail" } = {}): Promise<{ G: string; step: string; at: number }> {
  const G = await k.goal(k.c.ann, [P.run("r", o.repo ? { repo: o.repo } : {})]);
  const at = await k.run(k.c.ann, `${G}.r`, telemetry, o.outcome ?? "done");
  return { G, step: `${G}.r`, at };
}
async function runFinished(k: Ck, step: string, runId: string): Promise<Json> {
  const evs = (await k.ev("run.finished")).filter((e) => e.step === step && e.payload.runId === runId);
  expect(evs).toHaveLength(1);
  return evs[0];
}

// =============================================================================================
// AC-01 AC-02 profiles and agents
// =============================================================================================

describe("RL-17 AC-01 AC-02 profile and agent timelines", { timeout: 90_000 }, () => {
  let k: Ck;
  const t: Record<string, number> = {};
  let P1 = "";
  let P2 = "";
  type Run = { G: string; step: string; at: number };
  const runs = {} as Record<"p1" | "p2" | "a1" | "a2" | "b1", Run>;

  beforeAll(async () => {
    k = await Ck.start({ clock: NOW - 10 * DAY });
    const save = async (text: string): Promise<string> => {
      const res = await k.r.call(k.c.ann, "POST", "/v1/profiles", { name: "p", text });
      expect([200, 201], JSON.stringify(res.json)).toContain(res.status);
      return res.json.sha256 as string;
    };
    t.p1 = NOW - 9 * DAY;
    k.at(t.p1);
    P1 = await save(PROF1);
    k.at(NOW - 8 * DAY);
    runs.p1 = await plainRun(k, telOf("rp1", "zeta/other", undefined, { profile: "p", profileHash: P1 }));
    t.p2 = NOW - 7 * DAY;
    k.at(t.p2);
    P2 = await save(PROF2);
    k.at(NOW - 6 * DAY);
    runs.p2 = await plainRun(k, telOf("rp2", "zeta/other", undefined, { profile: "p", profileHash: P2 }));
    // Agent zeta/agent: HA twice, then HB.
    k.at(NOW - 5 * DAY);
    runs.a1 = await plainRun(k, telOf("ra1", "zeta/agent", HA));
    k.at(NOW - 4 * DAY);
    runs.a2 = await plainRun(k, telOf("ra2", "zeta/agent", HA));
    k.at(NOW - 3 * DAY);
    runs.b1 = await plainRun(k, telOf("rb1", "zeta/agent", HB));
    k.at(NOW);
  });
  afterAll(async () => {
    await k?.stop();
  });

  it("test_AC01_profile_timeline", async () => {
    expect(P1).not.toBe(P2);
    const saved = await k.ev("profile.saved");
    expect(saved).toHaveLength(2);
    const list = await changesOk(k, "?profile=p");
    expect(list).toStrictEqual([
      { kind: "profile", key: "p", hash: P2, firstSeen: t.p2, previous: P1, source: "event", event: { ...evView(saved[1]), user: "ann" }, sightings: 2 },
      { kind: "profile", key: "p", hash: P1, firstSeen: t.p1, source: "event", event: { ...evView(saved[0]), user: "ann" }, sightings: 2 },
    ]);
    expect(list[0].event.at).toBe(t.p2);
  });

  it("test_AC02_agent_timeline_from_runs", async () => {
    const ev = await runFinished(k, runs.b1.step, "rb1");
    const ev1 = await runFinished(k, runs.a1.step, "ra1");
    expect(await changesOk(k, `?agent=${enc("zeta/agent")}`)).toStrictEqual([
      { kind: "agent", key: "zeta/agent", hash: HB, firstSeen: runs.b1.at, previous: HA, source: "run", goal: runs.b1.G, step: runs.b1.step, round: 1, runId: "rb1", event: evView(ev), sightings: 1 },
      { kind: "agent", key: "zeta/agent", hash: HA, firstSeen: runs.a1.at, source: "run", goal: runs.a1.G, step: runs.a1.step, round: 1, runId: "ra1", event: evView(ev1), sightings: 2 },
    ]);
    expect(ev.user).toBe("ann");
    // A run without agentHash sights no agent entry.
    expect(await changesOk(k, `?agent=${enc("zeta/other")}`)).toStrictEqual([]);
  });
});

// =============================================================================================
// AC-03 catalog pushes and pins; AC-04 presets
// =============================================================================================

describe("RL-17 AC-03 AC-04 catalog, pins and presets", { timeout: 90_000 }, () => {
  let k: Ck;
  const t: Record<string, number> = {};
  let pinPulse = "";
  let wPulse = "";
  const T1 = SOLO_HL;
  const T2 = `${SOLO_HL}# v2\n`;
  const fired: Record<string, string> = {};

  beforeAll(async () => {
    k = await Ck.start({ clock: NOW - 20 * DAY });
    const rk = k.catalog();
    t.push1 = NOW - 19 * DAY;
    k.at(t.push1);
    const pusher = await rk.catalog({ rev: REV1 });
    k.at(NOW - 18 * DAY);
    await rk.pushOk(pusher, C2, { rev: REV1 });
    t.push3 = NOW - 17 * DAY;
    k.at(t.push3);
    await rk.pushOk(pusher, C3, { rev: REV2 });
    // A pulse pinning agents/rev at H2.
    t.pin = NOW - 16 * DAY;
    k.at(t.pin);
    const pk = k.pulses();
    pinPulse = (await pk.pulseOk("ann", body({ overlap: "allow", params: { repo: "alpha", agent: "agents/rev" } }, "roster", ROSTER_HL))).id as string;
    // Preset w: created (T1), fired, updated (T2), fired.
    t.w1 = NOW - 10 * DAY;
    k.at(t.w1);
    wPulse = (await pk.pulseOk("ann", body({ overlap: "allow", params: { repo: "alpha" } }, "w", T1))).id as string;
    t.f1 = NOW - 9 * DAY;
    k.at(t.f1);
    fired.f1 = (await pk.fireOk("ann", wPulse)).goal as string;
    t.w2 = NOW - 8 * DAY;
    k.at(t.w2);
    const up = await pk.act("ann", wPulse, "update", { preset: snap("w", T2) });
    expect(up.status, JSON.stringify(up.json)).toBe(200);
    t.f2 = NOW - 7 * DAY;
    k.at(t.f2);
    fired.f2 = (await pk.fireOk("ann", wPulse)).goal as string;
    // An update of the title only.
    k.at(NOW - 6 * DAY);
    expect((await pk.act("ann", wPulse, "update", { title: "renamed" })).status).toBe(200);
    // A re-snapshot of the pin pulse (new preset text) carries the pins.
    k.at(NOW - 5 * DAY);
    expect((await pk.act("ann", pinPulse, "update", { preset: snap("roster", `${ROSTER_HL}# v2\n`) })).status).toBe(200);
    k.at(NOW);
  });
  afterAll(async () => {
    await k?.stop();
  });

  it("test_AC03_catalog_and_pins", async () => {
    const pushes = await k.ev("catalog.pushed");
    expect(pushes).toHaveLength(3);
    const created = (await k.ev("pulse.created")).filter((e) => e.payload.pulse === pinPulse);
    expect(created).toHaveLength(1);
    expect(created[0].payload.agents).toStrictEqual([{ key: "agents/rev", hash: H2 }]);
    expect(await changesOk(k, `?agent=${enc("agents/rev")}`)).toStrictEqual([
      { kind: "agent", key: "agents/rev", hash: H2, firstSeen: t.push3, previous: H1, source: "event", event: evView(pushes[2]), sightings: 3 },
      { kind: "agent", key: "agents/rev", hash: H1, firstSeen: t.push1, source: "event", event: evView(pushes[0]), sightings: 1 },
    ]);
    // pulse.updated payloads: a re-snapshot names preset, sha256 and pins; a title change none.
    const updated = await k.ev("pulse.updated");
    const pinUpd = updated.filter((e) => e.payload.pulse === pinPulse);
    expect(pinUpd).toHaveLength(1);
    expect(pinUpd[0].payload).toMatchObject({ preset: "roster", sha256: sha(`${ROSTER_HL}# v2\n`), agents: [{ key: "agents/rev", hash: H2 }] });
    const wUpd = updated.filter((e) => e.payload.pulse === wPulse);
    expect(wUpd).toHaveLength(2);
    expect(wUpd[0].payload).toMatchObject({ preset: "w", sha256: sha(T2) });
    expect("agents" in wUpd[0].payload).toBe(false);
    for (const f of ["preset", "sha256", "agents"]) expect(f in wUpd[1].payload, f).toBe(false);
  });

  it("test_AC04_preset_timeline", async () => {
    const upd = (await k.ev("pulse.updated")).filter((e) => e.payload.pulse === wPulse)[0];
    const crt = (await k.ev("pulse.created")).filter((e) => e.payload.pulse === wPulse)[0];
    expect(await changesOk(k, "?preset=w")).toStrictEqual([
      { kind: "preset", key: "w", hash: sha(T2), firstSeen: t.w2, previous: sha(T1), source: "event", pulse: wPulse, event: evView(upd), sightings: 2 },
      { kind: "preset", key: "w", hash: sha(T1), firstSeen: t.w1, source: "event", pulse: wPulse, event: evView(crt), sightings: 2 },
    ]);
    // With a repo, event sightings drop: the goals are the first sightings.
    const g2 = (await k.ev("goal.created", fired.f2))[0];
    const g1 = (await k.ev("goal.created", fired.f1))[0];
    expect(await changesOk(k, "?preset=w&repo=alpha")).toStrictEqual([
      { kind: "preset", key: "w", hash: sha(T2), firstSeen: t.f2, previous: sha(T1), source: "goal", goal: fired.f2, event: evView(g2), sightings: 1 },
      { kind: "preset", key: "w", hash: sha(T1), firstSeen: t.f1, source: "goal", goal: fired.f1, event: evView(g1), sightings: 1 },
    ]);
    expect(await changesOk(k, "?preset=w&repo=beta")).toStrictEqual([]);
  });
});

// =============================================================================================
// AC-05 trial, repo, previous under since, pruned events
// =============================================================================================

describe("RL-17 AC-05 trial, repo, since and retention", { timeout: 90_000 }, () => {
  let k: Ck;
  type Run = { G: string; step: string; at: number };
  const r = {} as Record<"trial" | "beta" | "alpha" | "s0" | "s1" | "s2", Run>;
  const HT = sha("trial-hash");
  const S = [sha("s1"), sha("s2"), sha("s3")];

  beforeAll(async () => {
    k = await Ck.start({ clock: NOW - 10 * DAY });
    const pk = k.pulses();
    const p = (await pk.pulseOk("ann", body({ overlap: "allow", params: { repo: "alpha" } }, "solo-hl", SOLO_HL))).id as string;
    const tr = await pk.act("ann", p, "fire", { trial: true });
    expect(tr.status, JSON.stringify(tr.json)).toBe(201);
    const TG = tr.json.slot.goal as string;
    k.at(NOW - 9 * DAY);
    const at = await k.run(k.c.ann, `${TG}.run`, telOf("rt", "trial/agent", HT));
    r.trial = { G: TG, step: `${TG}.run`, at };
    k.at(NOW - 8 * DAY);
    r.beta = await plainRun(k, telOf("rm-beta", "multi/agent", HA), { repo: BETA });
    k.at(NOW - 7 * DAY);
    r.alpha = await plainRun(k, telOf("rm-alpha", "multi/agent", HA));
    for (const [i, h] of S.entries()) {
      k.at(NOW - (6 - i) * DAY);
      r[`s${i}` as "s0" | "s1" | "s2"] = await plainRun(k, telOf(`rs${i}`, "seq/agent", h));
    }
    k.at(NOW);
  });
  afterAll(async () => {
    await k?.stop();
  });

  it("test_AC05_trial", async () => {
    expect(await changesOk(k, `?agent=${enc("trial/agent")}`)).toStrictEqual([]);
    const inc = await changesOk(k, `?agent=${enc("trial/agent")}&trial=include`);
    expect(inc.map((e) => [e.hash, e.firstSeen, e.goal])).toStrictEqual([[HT, r.trial.at, r.trial.G]]);
  });

  it("test_AC05_repo", async () => {
    expect((await changesOk(k, `?agent=${enc("multi/agent")}`)).map((e) => [e.firstSeen, e.runId, e.sightings])).toStrictEqual([[r.beta.at, "rm-beta", 2]]);
    expect((await changesOk(k, `?agent=${enc("multi/agent")}&repo=${enc("/src/alpha")}`)).map((e) => [e.firstSeen, e.runId, e.sightings])).toStrictEqual([[r.alpha.at, "rm-alpha", 1]]);
    expect((await changesOk(k, `?agent=${enc("multi/agent")}&repo=${enc(BETA)}`)).map((e) => e.runId)).toStrictEqual(["rm-beta"]);
  });

  it("test_AC05_previous_under_since", async () => {
    const list = await changesOk(k, `?agent=${enc("seq/agent")}&since=${r.s1.at}`);
    expect(list.map((e) => [e.hash, e.previous])).toStrictEqual([
      [S[2], S[1]],
      [S[1], S[0]],
    ]);
    // until is exclusive.
    expect((await changesOk(k, `?agent=${enc("seq/agent")}&until=${r.s1.at}`)).map((e) => e.hash)).toStrictEqual([S[0]]);
  });

  it("test_AC05_pruned_event", async () => {
    // Drop every event older than the seq/agent runs (the s0 run's run.finished goes too).
    const before = (await changesOk(k, `?agent=${enc("seq/agent")}`)).find((e) => e.hash === S[0]);
    expect(before?.event?.type).toBe("run.finished");
    await k.w.hubStore.pruneEvents(r.s0.at + 1);
    const after = (await changesOk(k, `?agent=${enc("seq/agent")}`)).find((e) => e.hash === S[0]);
    const { event: _e, ...rest } = before as Json;
    expect(after).toStrictEqual(rest);
  });
});

// =============================================================================================
// AC-06 paging and 400s
// =============================================================================================

describe("RL-17 AC-06 paging and 400s", { timeout: 90_000 }, () => {
  let k: Ck;
  const at: number[] = [];

  beforeAll(async () => {
    k = await Ck.start({ clock: NOW - 10 * DAY });
    // Five agent hashes; the 2nd and 3rd finish at the same time.
    for (let i = 0; i < 5; i++) {
      k.at(NOW - [5, 4, 4, 2, 1][i]! * DAY);
      at.push((await plainRun(k, telOf(`p${i}`, `page/a${i}`, sha(`page-${i}`)))).at);
    }
    k.at(NOW);
  });
  afterAll(async () => {
    await k?.stop();
  });

  it("test_AC06_paging", async () => {
    expect(at[1]).toBe(at[2]);
    const all = await changesOk(k, "?kind=agent");
    expect(all).toHaveLength(5);
    expect(all.every((e) => e.kind === "agent")).toBe(true);
    // firstSeen descending, the tie by key.
    const sorted = [...all].sort((a, b) => b.firstSeen - a.firstSeen || (a.key < b.key ? -1 : 1));
    expect(all).toStrictEqual(sorted);
    const pages: Json[][] = [];
    let cursor: string | undefined;
    for (;;) {
      const res = await changes(k, `?kind=agent&limit=2${cursor ? `&cursor=${enc(cursor)}` : ""}`);
      expect(res.status).toBe(200);
      pages.push(res.json.changes as Json[]);
      cursor = res.json.next as string | undefined;
      if (!cursor) break;
    }
    expect(pages.map((p) => p.length)).toStrictEqual([2, 2, 1]);
    expect(pages.flat()).toStrictEqual(all);
    // A page that ends exactly at the last entry has no next.
    const full = await changes(k, "?kind=agent&limit=5");
    expect(full.json.changes).toHaveLength(5);
    expect("next" in full.json).toBe(false);
    // Key filters across kinds; the shared profile is one entry.
    const both = await changesOk(k, `?agent=${enc("page/a0")}&profile=read-only`);
    expect(both.map((e) => `${e.kind}:${e.key}`).sort()).toStrictEqual(["agent:page/a0", "profile:read-only"]);
    expect((await changesOk(k, "?kind=profile")).map((e) => e.sightings)).toStrictEqual([5]);
  });

  it("test_AC06_400s", async () => {
    for (const [q, msg] of [
      ["?kind=x", "kind must be agent, profile or preset"],
      ["?limit=0", "limit must be a whole number from 1 to 500"],
      ["?limit=501", "limit must be a whole number from 1 to 500"],
      ["?trial=only", "trial must be exclude or include"],
      ["?since=abc", "since must be milliseconds since the epoch or an ISO time"],
      ["?until=abc", "until must be milliseconds since the epoch or an ISO time"],
      [`?since=${at[0]}&until=${at[0]}`, "since must be before until"],
      ["?cursor=nope", "cursor is not valid"],
    ] as const) {
      expect(await changes(k, q), q).toStrictEqual({ status: 400, json: { error: msg } });
    }
  });
});

// =============================================================================================
// AC-07 AC-08 AC-09 compare
// =============================================================================================

describe("RL-17 AC-07 AC-08 AC-09 compare", { timeout: 120_000 }, () => {
  let k: Ck;
  const SINCE = NOW - 30 * DAY;
  const t: Record<string, number> = {};
  const X = fpOf("X");
  const Y = fpOf("Y");
  const Z = fpOf("Z");

  /** Report the finished run of round 1 of an already closed step. */
  async function report(id: string, telemetry: Json): Promise<void> {
    const res = await k.r.call(k.c.ann, "POST", `/v1/steps/${id}/run`, { state: "finished", runId: telemetry.runId, round: 1, telemetry });
    expect(res.status, JSON.stringify(res.json)).toBe(200);
  }

  beforeAll(async () => {
    k = await Ck.start({ clock: NOW - 20 * DAY });
    // HA: a budget-killed failed run (cost 0.5) and a plain run without cost.
    k.at(NOW - 19 * DAY);
    t.ha1 = (await plainRun(k, telOf("ha1", KEY, HA, { costUsdEstimate: 0.5, turns: 4, exit: "killed_budget", permissionDenials: { count: 3, tools: ["Bash"] } }), { outcome: "fail" })).at;
    k.at(NOW - 18 * DAY);
    t.ha2 = (await plainRun(k, telOf("ha2", KEY, HA, { durationMs: 3_000, turns: 6 }))).at;
    // HA in beta (cost 1).
    k.at(NOW - 17 * DAY);
    t.ha3 = (await plainRun(k, telOf("ha3", KEY, HA, { costUsdEstimate: 1 }), { repo: BETA })).at;
    // HB: an audit whose items are all dismissed (cost 0.25).
    // In its own repo (lineage), so the later alpha audits do not resolve its items.
    const GB = await k.goal(k.c.ann, [P.audit({ repo: "/src/gamma" }), P.validate({ repo: "/src/gamma" })]);
    k.at(NOW - 16 * DAY);
    await k.raise(k.c.ann, `${GB}.audit`, [item("Q1"), item("Q2")], { key: KEY, hash: HB });
    await report(`${GB}.audit`, telOf("hb1", KEY, HB, { costUsdEstimate: 0.25 }));
    t.hb1 = ((await k.r.stepOf(`${GB}.audit`)).rounds as Json[])[0].finishedAt as number;
    k.tick();
    await k.agentDispose(k.c.ann, `${GB}.validate`, [disp(fpOf("Q1"), "dismissed"), disp(fpOf("Q2"), "dismissed")]);
    // HA items: G1 (alpha) raises X, Y, Z; the checker accepts X and Z and dismisses Y; ann dismisses X in a debrief.
    const G1 = await k.goal(k.c.ann, [P.audit(), P.validate({ may_set: ["accepted", "dismissed"] }), P.debrief({ deps: ["validate"], consumes: ["accepted"], may_set: ["dismissed"] })]);
    t.rec1 = NOW - 15 * DAY;
    k.at(t.rec1);
    await k.raise(k.c.ann, `${G1}.audit`, [item("X"), item("Y"), item("Z")], { key: KEY, hash: HA });
    k.tick();
    await k.agentDispose(k.c.ann, `${G1}.validate`, [disp(X, "accepted"), disp(Y, "dismissed"), disp(Z, "accepted")]);
    k.tick();
    await k.k.claim(k.c.ann, `${G1}.debrief`);
    await k.personDispose(k.c.ann, `${G1}.debrief`, X, "dismissed");
    // HA items: G2 (beta) raises W.
    const G2 = await k.goal(k.c.ann, [P.audit({ repo: BETA })]);
    t.rec2 = NOW - 14 * DAY;
    k.at(t.rec2);
    await k.raise(k.c.ann, `${G2}.audit`, [item("W")], { key: KEY, hash: HA });
    // A trial run of HA (cost 2).
    const pk = k.pulses();
    const p = (await pk.pulseOk("ann", body({ overlap: "allow", params: { repo: "alpha" } }, "solo-hl", SOLO_HL))).id as string;
    const tr = await pk.act("ann", p, "fire", { trial: true });
    expect(tr.status, JSON.stringify(tr.json)).toBe(201);
    k.at(NOW - 13 * DAY);
    t.trial = await k.run(k.c.ann, `${tr.json.slot.goal as string}.run`, telOf("hat", KEY, HA, { costUsdEstimate: 2 }));
    k.at(NOW);
  });
  afterAll(async () => {
    await k?.stop();
  });

  /** The run aggregate of `GET /v1/runs` rows of `hash` (all pages). */
  async function fromRuns(query: string, hash: string): Promise<Json> {
    const rows: Json[] = [];
    let cursor: string | undefined;
    for (;;) {
      const res = await k.r.call(k.c.ann, "GET", `/v1/runs?agent=${enc(KEY)}&limit=1${query}${cursor ? `&cursor=${enc(cursor)}` : ""}`);
      expect(res.status, JSON.stringify(res.json)).toBe(200);
      rows.push(...(res.json.runs as Json[]));
      cursor = res.json.next as string | undefined;
      if (!cursor) break;
    }
    const mine = rows.filter((r) => r.telemetry.agentHash === hash);
    const costs = mine.filter((r) => r.telemetry.costUsdEstimate !== undefined);
    return {
      count: mine.length,
      durationMs: mine.reduce((s, r) => s + r.telemetry.durationMs, 0),
      turns: mine.reduce((s, r) => s + r.telemetry.turns, 0),
      ...(costs.length ? { costUsd: costs.reduce((s, r) => s + r.telemetry.costUsdEstimate, 0) } : {}),
      costRuns: costs.length,
      failed: mine.filter((r) => r.waste.failed).length,
      overBudget: mine.filter((r) => r.waste.overBudget).length,
      denials: mine.reduce((s, r) => s + r.waste.denials, 0),
      allDismissed: mine.filter((r) => r.waste.allDismissed).length,
    };
  }

  it("test_AC07_compare_runs", async () => {
    const c = await compareOk(k, KEY, `?from=${HA}&to=${HB}&since=${SINCE}`);
    expect(c.key).toBe(KEY);
    expect(c.since).toBe(SINCE);
    expect(c.trial).toBe("exclude");
    expect("until" in c || "repo" in c).toBe(false);
    expect(c.from.hash).toBe(HA);
    expect(c.from.runs).toStrictEqual({ count: 3, durationMs: 5_000, turns: 13, costUsd: 1.5, costRuns: 2, failed: 1, overBudget: 1, denials: 3, allDismissed: 0 });
    expect([c.from.firstAt, c.from.lastAt]).toStrictEqual([t.ha1, t.ha3]);
    expect(c.to.runs).toStrictEqual({ count: 1, durationMs: 1_000, turns: 3, costUsd: 0.25, costRuns: 1, failed: 0, overBudget: 0, denials: 0, allDismissed: 1 });
    expect([c.to.firstAt, c.to.lastAt]).toStrictEqual([t.hb1, t.hb1]);
    // Agreement with GET /v1/runs under each filter.
    for (const q of [`&since=${SINCE}`, `&since=${SINCE}&until=${t.ha3}`, `&since=${SINCE}&repo=${enc(BETA)}`, `&since=${SINCE}&trial=include`]) {
      const cq = await compareOk(k, KEY, `?from=${HA}&to=${HB}${q}`);
      expect(cq.from.runs, q).toStrictEqual(await fromRuns(q, HA));
      expect(cq.to.runs, q).toStrictEqual(await fromRuns(q, HB));
    }
    const inc = await compareOk(k, KEY, `?from=${HA}&to=${HB}&trial=include`);
    expect(inc.from.runs).toMatchObject({ count: 4, costUsd: 3.5, costRuns: 3 });
    expect(inc.trial).toBe("include");
    // An unknown hash: zeros without costUsd, firstAt, lastAt.
    const z = await compareOk(k, KEY, `?from=${HA}&to=${"0".repeat(64)}`);
    expect(z.to).toStrictEqual({
      hash: "0".repeat(64),
      runs: { count: 0, durationMs: 0, turns: 0, costRuns: 0, failed: 0, overBudget: 0, denials: 0, allDismissed: 0 },
      items: { raised: 0, new: 0, regressions: 0, carried: 0, accepted: 0, dismissedByAgents: 0, dismissedByPeople: 0 },
    });
  });

  it("test_AC08_compare_items_agree_with_stats", async () => {
    const fields = ["raised", "new", "regressions", "carried", "accepted", "dismissedByAgents", "dismissedByPeople"];
    for (const trial of ["exclude", "include"]) {
      const s = await k.stats(KEY, `?days=30&trial=${trial}`);
      const c = await compareOk(k, KEY, `?from=${HA}&to=${HB}&since=${NOW - 30 * DAY}&trial=${trial}`);
      for (const side of [c.from, c.to]) {
        const h = k.hashOf(s, side.hash as string);
        for (const f of fields) expect(side.items[f], `${trial} ${f} ${side.hash.slice(0, 6)}`).toBe(h?.[f] ?? 0);
      }
    }
    const c = await compareOk(k, KEY, `?from=${HA}&to=${HB}&since=${SINCE}`);
    expect(c.from.items).toMatchObject({ raised: 4, accepted: 2, dismissedByAgents: 1, dismissedByPeople: 1 });
    expect(c.to.items).toMatchObject({ raised: 2, dismissedByAgents: 2 });
    // until before the second record; repo beta.
    expect((await compareOk(k, KEY, `?from=${HA}&to=${HB}&until=${t.rec2}`)).from.items).toMatchObject({ raised: 3, accepted: 2 });
    expect((await compareOk(k, KEY, `?from=${HA}&to=${HB}&repo=${enc(BETA)}`)).from.items).toStrictEqual({
      raised: 1,
      new: c.from.items.new - (await compareOk(k, KEY, `?from=${HA}&to=${HB}&repo=${enc("/src/alpha")}`)).from.items.new,
      regressions: 0,
      carried: 0,
      accepted: 0,
      dismissedByAgents: 0,
      dismissedByPeople: 0,
    });
  });

  it("test_AC09_compare_400s", async () => {
    for (const [key, q, msg] of [
      [KEY, `?to=${HB}`, "from is required"],
      [KEY, `?from=${HA}`, "to is required"],
      [KEY, `?from=${"a".repeat(201)}&to=${HB}`, "from must be at most 200 characters"],
      ["nokey", `?from=${HA}&to=${HB}`, "an agent key is <repo>/<name>"],
      [KEY, `?from=${HA}&to=${HB}&trial=only`, "trial must be exclude or include"],
      [KEY, `?from=${HA}&to=${HB}&since=abc`, "since must be milliseconds since the epoch or an ISO time"],
      [KEY, `?from=${HA}&to=${HB}&since=${NOW}&until=${NOW}`, "since must be before until"],
    ] as const) {
      expect(await compare(k, key, q), q).toStrictEqual({ status: 400, json: { error: msg } });
    }
  });
});

// =============================================================================================
// AC-10 scopes, no writes, features
// =============================================================================================

describe("RL-17 AC-10 scopes", { timeout: 60_000 }, () => {
  let k: Ck;
  beforeAll(async () => {
    k = await Ck.start({ clock: NOW - DAY });
    await plainRun(k, telOf("s1", KEY, HA));
    k.at(NOW);
  });
  afterAll(async () => {
    await k?.stop();
  });

  it("test_AC10_scopes_no_writes_features", async () => {
    const svc = k.w.hub.svc;
    const withScope = await svc.serviceToken("dash", ["goals:read"]);
    const without = await svc.serviceToken("other", []);
    const goalsBefore = JSON.stringify((await k.r.call(k.c.ann, "GET", "/v1/goals?pulses=1")).json);
    const stepsBefore = JSON.stringify((await k.r.call(k.c.ann, "GET", "/v1/steps")).json);
    const evBefore = (await k.r.call(k.c.ann, "GET", "/v1/events?after=0&limit=1000")).json;
    for (const path of ["/v1/changes", `/v1/agents/${enc(KEY)}/compare?from=${HA}&to=${HB}`]) {
      expect((await k.w.call(withScope, "GET", path)).status, path).toBe(200);
      expect((await k.w.call(without, "GET", path)).status, path).toBe(403);
      expect((await k.w.call(undefined as never, "GET", path)).status, path).toBe(401);
      const ob = await k.w.call(withScope, "GET", path, undefined, { "x-mesh-on-behalf-of": "ann" });
      expect(ob, path).toStrictEqual({ status: 400, json: { error: "on-behalf-of is not accepted on this route", code: "on-behalf-of-not-accepted" } });
    }
    expect(JSON.stringify((await k.r.call(k.c.ann, "GET", "/v1/goals?pulses=1")).json)).toBe(goalsBefore);
    expect(JSON.stringify((await k.r.call(k.c.ann, "GET", "/v1/steps")).json)).toBe(stepsBefore);
    expect((await k.r.call(k.c.ann, "GET", "/v1/events?after=0&limit=1000")).json).toStrictEqual(evBefore);
    expect((await k.w.call(undefined as never, "GET", "/healthz")).json.features).toEqual(expect.arrayContaining(["agent-compare", "changes"]));
  });
});
