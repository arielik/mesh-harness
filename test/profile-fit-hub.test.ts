// RL-16 World tests of `GET /v1/profiles/:name/fit` (docs/specs/RL-16.md): runs split by hash, the
// window and trial (AC-05), the reply against `fitProfile` and the list cap (AC-06), errors, access,
// no writes and the feature (AC-07).

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { fitProfile, type FitRun } from "../src/core/index.ts";
import type { ProfileView, RunTelemetry } from "../src/protocol/index.ts";
import { Ck, DAY, HA, KEY, P, tel } from "./helpers/calib-kit.ts";
import { body, SOLO_HL } from "./helpers/pulse-kit.ts";
import type { PlanIn } from "./helpers/relay-kit.ts";
import { ALPHA } from "./helpers/review-kit.ts";
import type { Json } from "./helpers/world.ts";

const NOW = Date.UTC(2026, 10, 20, 12);
const enc = encodeURIComponent;

const CI_V1 = "extends: read-only\nchecks: [\"make lint\"]\n";
const CI_V2 = "extends: read-only\nchecks: [\"make lint\"]\nallow: [\"Bash(make *)\"]\n";
const TOOLS = ["Bash", "CronCreate", "Read", "mcp__mesh__mesh_done"];

describe("RL-16 AC-05 AC-06 AC-07 profile fit route", { timeout: 120_000 }, () => {
  let k: Ck;
  let h1 = "";
  let h2 = "";
  let roHash = "";
  let pulse = "";
  let n = 0;

  const fitCall = (name: string, query = "", who: Json | string = k.c.ann) => k.r.call(who as never, "GET", `/v1/profiles/${enc(name)}/fit${query}`);
  async function fitOk(name: string, query = ""): Promise<Json> {
    const res = await fitCall(name, query);
    expect(res.status, `fit ${name}${query}: ${JSON.stringify(res.json)}`).toBe(200);
    return res.json;
  }
  /** A plain goal's headless run of `profile` at `hash`, finished at `when`. */
  async function profRun(profile: string, hash: string, when: number, over: Partial<RunTelemetry> = {}, extra: PlanIn[] = []): Promise<string> {
    const G = await k.goal(k.c.ann, [P.run("r"), ...extra]);
    k.at(when);
    await k.run(k.c.ann, `${G}.r`, { ...tel({ runId: `r${++n}`, agentKey: KEY, agentHash: HA, durationMs: 1_000 }), profile, profileHash: hash, ...over } as Json);
    return G;
  }
  /** Round 2 of `<G>.r`: its dependant `t` fails and reopens it, then it runs again. */
  async function secondRun(G: string, when: number, telemetry: Json): Promise<void> {
    const id = `${G}.r`;
    await k.k.claim(k.c.ann, `${G}.t`);
    expect((await k.k.close(k.c.ann, `${G}.t`, { outcome: "fail", summary: "again", reopen: ["r"] })).status).toBe(200);
    k.at(when);
    await k.k.claim(k.c.ann, id);
    expect((await k.k.close(k.c.ann, id, { outcome: "done", summary: "ok" })).status).toBe(200);
    const f = await k.r.call(k.c.ann, "POST", `/v1/steps/${id}/run`, { state: "finished", runId: telemetry.runId, round: 2, telemetry });
    expect(f.status, JSON.stringify(f.json)).toBe(200);
    expect(((await k.r.stepOf(id)).rounds as Json[]).map((r) => r.n)).toStrictEqual([1, 2]);
  }
  async function save(name: string, text: string): Promise<string> {
    const res = await k.r.call(k.c.ann, "POST", "/v1/profiles", { name, text });
    expect([200, 201], JSON.stringify(res.json)).toContain(res.status);
    return res.json.sha256 as string;
  }

  beforeAll(async () => {
    k = await Ck.start({ clock: NOW - 20 * DAY });
    const pk = k.pulses();
    pulse = (await pk.pulseOk("ann", body({ params: { repo: "alpha" } }, "solo-hl", SOLO_HL))).id as string;
    h1 = await save("ci", CI_V1);
    roHash = ((await k.r.call(k.c.ann, "GET", "/v1/profiles/read-only")).json as ProfileView).sha256;
    // H1: one run 15 days old (round 1 of a step that is reopened later), four in the default window (the first is
    // round 2 of that same step, so the step is in the window but its old round is not), one in a trial goal.
    const old = await profRun("ci", h1, NOW - 15 * DAY, { denied: [{ tool: "Bash", command: "make", count: 1 }], permissionDenials: { count: 1, tools: ["Bash"] } }, [
      { id: "t", repo: ALPHA, deps: ["r"] },
    ]);
    await secondRun(old, NOW - 10 * DAY, {
      ...tel({ runId: `r${++n}`, agentKey: KEY, agentHash: HA, durationMs: 1_000 }),
      profile: "ci",
      profileHash: h1,
      denied: [{ tool: "Bash", command: "make", count: 2 }],
      permissionDenials: { count: 2, tools: ["Bash"] },
      tools: TOOLS,
      toolsUsed: ["Bash", "Read"],
    } as Json);
    for (let i = 1; i < 4; i++) {
      await profRun("ci", h1, NOW - 10 * DAY + i, { denied: [{ tool: "Bash", command: "make", count: 2 }], permissionDenials: { count: 2, tools: ["Bash"] }, tools: TOOLS, toolsUsed: ["Bash", "Read"] });
    }
    const fired = await pk.act("ann", pulse, "fire", { trial: true });
    expect(fired.status, JSON.stringify(fired.json)).toBe(201);
    const TG = fired.json.slot.goal as string;
    k.at(NOW - 9 * DAY);
    await k.run(k.c.ann, `${TG}.run`, { ...tel({ runId: "r-trial", agentKey: KEY, agentHash: HA, durationMs: 1_000 }), profile: "ci", profileHash: h1 } as Json);
    // Re-saved: H2, with two runs that deny cargo.
    k.at(NOW - 5 * DAY);
    h2 = await save("ci", CI_V2);
    for (let i = 0; i < 2; i++) {
      await profRun("ci", h2, NOW - 3 * DAY + i, { denied: [{ tool: "Bash", command: "cargo", count: 1 }], permissionDenials: { count: 1, tools: ["Bash"] } });
    }
    // Another profile's run, and five read-only runs for AC-06.
    await profRun("other", h1, NOW - 2 * DAY);
    for (let i = 0; i < 5; i++) {
      const denied = Array.from({ length: 41 }, (_, j) => ({ tool: "Bash", command: `c${i}-${j}`, count: 1 }));
      await profRun("read-only", roHash, NOW - 1 * DAY + i, { denied: [{ tool: "Bash", command: "cargo", count: 1 }, ...denied], permissionDenials: { count: 42, tools: ["Bash"] }, tools: TOOLS, toolsUsed: ["Bash", "Read"] });
    }
    k.at(NOW);
  });
  afterAll(async () => {
    await k?.stop();
  });

  it("test_AC05_hashes_window_trial", async () => {
    expect(h1).not.toBe(h2);
    const events = (await k.r.allEvents()) as Json[];
    expect(events.filter((e) => e.type === "profile.saved").map((e) => e.payload.sha256)).toStrictEqual([h1, h2]);
    const f = await fitOk("ci");
    expect(f.sha256).toBe(h2);
    expect(f.hashes).toStrictEqual([
      { sha256: h2, current: true, runs: 2, toolRuns: 0, deniedRuns: 2, denials: 2, firstAt: NOW - 3 * DAY, lastAt: NOW - 3 * DAY + 1 },
      { sha256: h1, current: false, runs: 4, toolRuns: 4, deniedRuns: 4, denials: 8, firstAt: NOW - 10 * DAY, lastAt: NOW - 10 * DAY + 3 },
    ]);
    expect(f.sample).toStrictEqual({ runs: 2, toolRuns: 0 });
    // Only H2's runs count: cargo (few-runs), not H1's make.
    expect(f.denied).toStrictEqual([{ tool: "Bash", command: "cargo", runs: 2, count: 2, rule: "Bash(cargo *)", suggest: false, held: "few-runs" }]);
    expect(f.unused).toStrictEqual([]);
    expect(f.diff).toStrictEqual({ allow: [], deny: [] });
    expect((await fitOk("ci", "?days=16")).hashes[1].runs).toBe(5);
    const withTrial = await fitOk("ci", "?trial=include");
    expect(withTrial.trial).toBe("include");
    expect(withTrial.hashes[1].runs).toBe(5);
    // The sample plus the other hashes equals the GET /v1/runs rows of the profile (same window and trial).
    for (const [q, trial] of [["", "exclude"], ["?trial=include", "include"]] as const) {
      const fit = await fitOk("ci", q);
      const rows = (await k.r.call(k.c.ann, "GET", `/v1/runs?since=${fit.window.since}&until=${fit.window.until + 1}&trial=${trial}&limit=1000`)).json.runs as Json[];
      const total = (fit.hashes as Json[]).reduce((s, h) => s + (h.runs as number), 0);
      expect(total, q).toBe(rows.filter((r) => r.telemetry.profile === "ci").length);
    }
  });

  it("test_AC06_reply_equals_fitProfile_and_cap", async () => {
    const f = await fitOk("read-only");
    expect(f).toMatchObject({ profile: "read-only", builtIn: true, base: "read-only", sha256: roHash, trial: "exclude", window: { until: NOW, since: NOW - 14 * DAY, days: 14 } });
    // Rebuild the input from GET /v1/runs and compare field for field.
    const rows = (await k.r.call(k.c.ann, "GET", `/v1/runs?since=${NOW - 14 * DAY}&until=${NOW + 1}&limit=1000`)).json.runs as Json[];
    const runs: FitRun[] = rows.filter((r) => r.telemetry.profile === "read-only").map((r) => ({ finishedAt: r.finishedAt as number, telemetry: r.telemetry as RunTelemetry }));
    const view = (await k.r.call(k.c.ann, "GET", "/v1/profiles/read-only")).json as ProfileView;
    const want = fitProfile({ profile: { name: view.name, builtIn: true, base: view.base, sha256: view.sha256, settings: view.settings }, runs, window: { since: NOW - 14 * DAY, until: NOW, days: 14 }, trial: "exclude" });
    expect(f).toStrictEqual(JSON.parse(JSON.stringify(want)));
    // 5 runs × 41 distinct commands + cargo = 206 groups: 200 listed, 6 cut; cargo (5 of 5) suggested first.
    expect(f.denied).toHaveLength(200);
    expect(f.truncated).toStrictEqual({ denied: 6, unused: 0 });
    expect(f.denied[0]).toMatchObject({ command: "cargo", runs: 5, suggest: true });
    expect(f.diff.allow).toStrictEqual(["Bash(cargo *)"]);
    expect(f.diff.deny).toStrictEqual(["CronCreate"]);
  });

  it("test_AC07_errors_access_no_writes_feature", async () => {
    for (const [q, msg] of [
      ["?days=0", "days must be a whole number from 1 to 90"],
      ["?days=91", "days must be a whole number from 1 to 90"],
      ["?days=x", "days must be a whole number from 1 to 90"],
      ["?trial=only", "trial must be exclude or include"],
    ] as const) {
      expect(await fitCall("ci", q), q).toStrictEqual({ status: 400, json: { error: msg } });
    }
    expect(await fitCall("nope")).toStrictEqual({ status: 404, json: { error: "no profile nope" } });
    // Parameters are checked before the profile is read.
    expect(await fitCall("nope", "?days=0")).toStrictEqual({ status: 400, json: { error: "days must be a whole number from 1 to 90" } });
    const svc = k.w.hub.svc;
    const withScope = await svc.serviceToken("dash", ["goals:read"]);
    const without = await svc.serviceToken("other", []);
    const path = "/v1/profiles/ci/fit";
    const evBefore = (await k.r.call(k.c.ann, "GET", "/v1/events?after=0&limit=1000")).json;
    const profBefore = (await k.r.call(k.c.ann, "GET", "/v1/profiles/ci")).json;
    expect((await k.w.call(withScope, "GET", path)).status).toBe(200);
    expect((await k.w.call(without, "GET", path)).status).toBe(403);
    expect((await k.w.call(undefined as never, "GET", path)).status).toBe(401);
    expect(await k.w.call(withScope, "GET", path, undefined, { "x-mesh-on-behalf-of": "ann" })).toStrictEqual({ status: 400, json: { error: "on-behalf-of is not accepted on this route", code: "on-behalf-of-not-accepted" } });
    expect((await k.r.call(k.c.ann, "GET", "/v1/events?after=0&limit=1000")).json).toStrictEqual(evBefore);
    expect((await k.r.call(k.c.ann, "GET", "/v1/profiles/ci")).json).toStrictEqual(profBefore);
    const features = (await k.w.call(undefined as never, "GET", "/healthz")).json.features as string[];
    expect(features).toContain("profile-fit");
    expect(features).toStrictEqual([...features].sort());
  });
});
