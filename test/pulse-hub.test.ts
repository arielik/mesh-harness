// RL-3 hub side end to end (World): pulse routes, preset validation, snapshots (R-6),
// create-with-plan, idempotent firing, overlap and abandon, machine choice and retries, missed
// reasons, downtime, manual fire, lifecycle, hidden goals, reads and scopes, ingest, events,
// compatibility, a window equal to the period, fire errors and deleted topics.
// Criteria AC-06 to AC-18, AC-21, AC-24, AC-28, AC-29 (World parts). Written from the spec's
// contracts only (docs/specs/RL-3.md). Pulses, slots and goals by id; events by type + pulse/slot;
// slot instants from fixed constants (test/helpers/pulse-kit.ts), never from `nextSlot`.

import { afterEach, describe, expect, it } from "vitest";
import {
  BAD_POLICY,
  BAD_POLICY_TEXT,
  body,
  DAY,
  GATE_FIRST,
  HOUR,
  iso,
  MIN,
  Pk,
  RELAY_PARAMS,
  RELAY_TEXT,
  relayBody,
  REPO,
  S,
  sha,
  sha12,
  snap,
  SOLO,
  SOLO_HL,
  T0,
  TEAM_RO,
  TEAM_RO_V2,
  TWO_HL,
  TWO_ROOTS,
  UNKNOWN_PROF,
  type Bare,
  type Json,
} from "./helpers/pulse-kit.ts";

let k: Pk;
afterEach(async () => {
  await k?.stop();
});
async function start(o: { hubYaml?: Record<string, unknown>; clock?: number } = {}): Promise<Pk> {
  k = await Pk.start(o);
  return k;
}
const NOW = T0 - DAY;
const PROBLEMS = (ps: string[]) => `the preset has ${ps.length} problem(s): ${ps.join("; ")}`;
const REPO_PROBLEM = "params.repo is required (the repo the preset's steps work in)";
const FIRST_STEP = (name: string, n: number) => `a pulse preset needs exactly one first step (no deps, not a gate); ${name} has ${n}`;
const FORBIDDEN = (owner: string, id: string) => `only @${owner} or an admin can change pulse ${id}`;
const keys = (o: Json) => Object.keys(o ?? {}).sort();
const THRESHOLDS = { thresholds: { offer_expiry: "30m", machine_offline: "15m" } };

async function builtinSha(name: string): Promise<string> {
  const res = await k.call("ann", "GET", `/v1/profiles/${name}`);
  expect(res.status, JSON.stringify(res.json)).toBe(200);
  return res.json.sha256 as string;
}
/** The goal a slot fired; asserts the slot is fired with a goal. */
async function firedGoal(id: string, slot: string): Promise<string> {
  const s = await k.slotOf(id, slot);
  expect(s.state, JSON.stringify(s)).toBe("fired");
  expect(typeof s.goal).toBe("string");
  return s.goal as string;
}

// ---------------------------------------------------------------------------------------------

describe("AC-06 create", () => {
  it("test_AC06_sha_mismatch", async () => {
    await start();
    const b = relayBody({ params: {} });
    b.preset = { ...b.preset, sha256: sha("other") };
    expect(await k.pulse("ann", b)).toStrictEqual({ status: 400, json: { error: "preset.sha256 is not the SHA-256 of preset.text" } });
    expect((await k.call("ann", "GET", "/v1/pulses")).json.pulses).toStrictEqual([]);
  });

  it("test_AC06_missing_repo", async () => {
    await start();
    expect(await k.pulse("ann", body({ params: {} }))).toStrictEqual({ status: 422, json: { error: PROBLEMS([REPO_PROBLEM]), details: [REPO_PROBLEM] } });
  });

  it("test_AC06_missing_validator", async () => {
    await start();
    const { validator: _v, ...params } = RELAY_PARAMS;
    const p = "preset audit-relay: unknown parameter {validator} in step validate";
    expect(await k.pulse("ann", relayBody({ params }))).toStrictEqual({ status: 422, json: { error: PROBLEMS([p]), details: [p] } });
  });

  it("test_AC06_two_roots", async () => {
    await start();
    expect(await k.pulse("ann", body({}, "two-roots", TWO_ROOTS))).toStrictEqual({ status: 422, json: { error: PROBLEMS([FIRST_STEP("two-roots", 2)]), details: [FIRST_STEP("two-roots", 2)] } });
    expect(await k.pulse("ann", body({}, "gate-first", GATE_FIRST))).toStrictEqual({ status: 422, json: { error: PROBLEMS([FIRST_STEP("gate-first", 1)]), details: [FIRST_STEP("gate-first", 1)] } });
  });

  it("test_AC06_unknown_profile", async () => {
    await start();
    const p = 'step "run": unknown profile "nope"';
    expect(await k.pulse("ann", body({}, "unknown-prof", UNKNOWN_PROF))).toStrictEqual({ status: 422, json: { error: PROBLEMS([p]), details: [p] } });
  });

  it("test_AC06_policy_error", async () => {
    await start();
    const res = await k.pulse("ann", body({}, "bad-policy", BAD_POLICY));
    expect(res.status, JSON.stringify(res.json)).toBe(422);
    expect(res.json.details).toContain(BAD_POLICY_TEXT);
    expect(res.json.error).toBe(PROBLEMS(res.json.details));
  });

  it("test_AC06_parse_error", async () => {
    await start();
    const res = await k.pulse("ann", body({ params: {} }, "bad", "steps: 5\n"));
    expect(res.status, JSON.stringify(res.json)).toBe(422);
    // The repo problem first, then the parse error, and nothing after it.
    expect(res.json.details).toHaveLength(2);
    expect(res.json.details[0]).toBe(REPO_PROBLEM);
    expect(res.json.details[1].startsWith("preset bad: ")).toBe(true);
    const one = await k.pulse("ann", body({}, "bad", "steps: 5\n"));
    expect(one.status).toBe(422);
    expect(one.json.details).toHaveLength(1);
    expect(one.json.details[0].startsWith("preset bad: ")).toBe(true);
  });

  it("test_AC06_two_problems", async () => {
    await start();
    const res = await k.pulse("ann", body({ params: {} }, "two-roots", TWO_ROOTS));
    expect(res).toStrictEqual({ status: 422, json: { error: PROBLEMS([REPO_PROBLEM, FIRST_STEP("two-roots", 2)]), details: [REPO_PROBLEM, FIRST_STEP("two-roots", 2)] } });
  });

  const schedule: [Record<string, string>, string][] = [
    [{ cron: "61 * * * *", tz: "UTC" }, 'bad cron "61 * * * *": minute value 61 is out of range 0-59'],
    [{ cron: "0 9 * * 1", tz: "Mars/Base" }, 'unknown time zone "Mars/Base"'],
    [{ cron: "0 0 31 2 *", tz: "UTC" }, 'cron "0 0 31 2 *" never fires'],
    [{ cron: "* * * * *", tz: "UTC" }, 'cron "* * * * *" fires more often than every 5m'],
    [{ cron: "*/4 * * * *", tz: "UTC" }, 'cron "*/4 * * * *" fires more often than every 5m'],
  ];
  it.each(schedule)("test_AC06_schedule_errors %j", async (when, error) => {
    await start();
    expect(await k.pulse("ann", body({ when }))).toStrictEqual({ status: 422, json: { error } });
  });

  it("test_AC06_cron_5m_ok", async () => {
    await start();
    const v = await k.pulseOk("ann", body({ when: { cron: "*/5 * * * *", tz: "UTC" } }));
    expect(v.schedule).toBe('cron "*/5 * * * *" UTC');
    expect(v.windowMs).toBe(5 * MIN);
  });

  it("test_AC06_unknown_topic", async () => {
    await start();
    const res = await k.pulse("ann", body({ topics: ["nope"] }));
    expect(res.status).toBe(400);
    expect(String(res.json.error).startsWith("unknown topic")).toBe(true);
    // Positive control: a defined topic is accepted.
    expect((await k.call("ann", "POST", "/v1/topics", { name: "t" })).status).toBe(201);
    expect((await k.pulseOk("ann", body({ topics: ["t"] }))).topics).toStrictEqual(["t"]);
  });

  it("test_AC06_success_relay", async () => {
    await start();
    const v = await k.pulseOk("ann", relayBody());
    expect(v.id).toBe("p-1");
    expect(v).toMatchObject({ version: 1, owner: "ann", title: "audit-relay on alpha", windowMs: 4 * HOUR, maxGoalAgeMs: 14 * DAY, nextAt: NOW + 7 * DAY, enabled: true, overlap: "skip", missed: "record", schedule: "every 7d" });
    expect(v.when).toStrictEqual({ every: "7d", anchor: NOW });
    for (const key of ["window", "maxGoalAge", "pausedReason", "deletedAt"]) expect(Object.hasOwn(v, key), key).toBe(false);
    expect(v.preset).toStrictEqual({ name: "audit-relay", sha256: sha(RELAY_TEXT()) });
    expect(v.profiles).toStrictEqual({ "propose-via-branch": await builtinSha("propose-via-branch"), "read-only": await builtinSha("read-only") });
    expect(v.params).toStrictEqual(RELAY_PARAMS);
    expect(v.recent).toStrictEqual([]);
  });

  it("test_AC06_every_30m", async () => {
    await start();
    const v = await k.pulseOk("ann", body({ when: { every: "30m" } }));
    expect(v.windowMs).toBe(30 * MIN);
    expect(v.maxGoalAgeMs).toBe(HOUR);
    expect(v.nextAt).toBe(NOW + 30 * MIN);
  });

  it("test_AC06_at_future", async () => {
    await start();
    expect((await k.pulseOk("ann", body({ when: { every: "7d", at: NOW + 2 * DAY } }))).nextAt).toBe(NOW + 2 * DAY);
    expect((await k.pulseOk("ann", body({ when: { every: "7d", at: NOW + 30 * DAY } }))).nextAt).toBe(NOW + 30 * DAY);
    const past = await k.pulseOk("ann", body({ when: { every: "7d", at: NOW - DAY } }));
    expect(past.nextAt).toBe(NOW + 6 * DAY);
    expect(past.when).toStrictEqual({ every: "7d", anchor: NOW - DAY });
  });

  it("test_AC06_headless_default_profile", async () => {
    await start();
    const v = await k.pulseOk("ann", body({}, "solo-hl", SOLO_HL));
    expect(v.profiles).toStrictEqual({ "read-only": await builtinSha("read-only") });
    // Positive control for the snapshot: an interactive preset snapshots no profile.
    expect((await k.pulseOk("ann", body())).profiles).toStrictEqual({});
  });

  it("test_AC06_event", async () => {
    await start();
    await k.pulseOk("ann", relayBody());
    const es = await k.pulseEvents("pulse.created", "p-1");
    expect(es).toHaveLength(1);
    expect(es[0].user).toBe("ann");
    expect(keys(es[0].payload)).toStrictEqual(["preset", "pulse", "schedule", "sha256", "title"]);
    expect(es[0].payload).toStrictEqual({ pulse: "p-1", title: "audit-relay on alpha", preset: "audit-relay", sha256: sha(RELAY_TEXT()), schedule: "every 7d" });
  });

  it("test_AC06_disabled", async () => {
    await start();
    const v = await k.pulseOk("ann", body({ enabled: false }));
    expect(v.enabled).toBe(false);
    expect(Object.hasOwn(v, "nextAt")).toBe(false);
  });

  it("test_AC06_given_window", async () => {
    await start();
    const v = await k.pulseOk("ann", body({ window: "2h", maxGoalAge: "3d" }));
    expect(v).toMatchObject({ window: "2h", windowMs: 2 * HOUR, maxGoalAge: "3d", maxGoalAgeMs: 3 * DAY });
  });

  it("test_AC06_cron_defaults", async () => {
    await start();
    // Period of a cron = the gap between its first two slots after the save time (weekly: 7 days).
    const v = await k.pulseOk("ann", body({ when: { cron: "0 9 * * 1", tz: "UTC" } }));
    expect(v).toMatchObject({ windowMs: 4 * HOUR, maxGoalAgeMs: 14 * DAY, nextAt: T0, schedule: 'cron "0 9 * * 1" UTC' });
    expect(v.when).toStrictEqual({ cron: "0 9 * * 1", tz: "UTC" });
  });
});

// ---------------------------------------------------------------------------------------------

describe("AC-07 snapshots", () => {
  const TEAM_RO_TEXT = "extends: read-only\n";
  const TEAM_RO_TEXT2 = "extends: propose-via-branch\n";
  async function setup(): Promise<{ s1: string; s2: string; A: Bare }> {
    await start();
    const first = await k.call("ann", "POST", "/v1/profiles", { name: "team-ro", text: TEAM_RO_TEXT });
    expect(first.status, JSON.stringify(first.json)).toBe(201);
    const v = await k.pulseOk("ann", body({ overlap: "allow" }, "team-ro", TEAM_RO));
    expect(v.profiles).toStrictEqual({ "team-ro": first.json.sha256 });
    const second = await k.call("ann", "POST", "/v1/profiles", { name: "team-ro", text: TEAM_RO_TEXT2 });
    expect(second.status, JSON.stringify(second.json)).toBe(200);
    expect(second.json.sha256).not.toBe(first.json.sha256);
    const A = await k.bare("ann", "hl-a", { headless: true });
    return { s1: first.json.sha256, s2: second.json.sha256, A };
  }

  it("test_AC07_profile_pinned", async () => {
    const { s1, A } = await setup();
    const slot = await k.fireOk("ann", "p-1");
    const G = slot.goal as string;
    expect((await k.goal(G)).goal.profiles["team-ro"].sha256).toBe(s1);
    const st = await k.step(`${G}.run`);
    expect(st.offer).toMatchObject({ to: { machine: A.machine }, state: "offered" });
    expect(st.offer.profile).toStrictEqual({ name: "team-ro", sha256: s1 });
    const msgs = (await k.inbox(A.token)).filter((m) => m.kind === "offer" && m.data?.step === `${G}.run`);
    expect(msgs).toHaveLength(1);
    expect(msgs[0].data.profile.sha256).toBe(s1);
    expect((await k.pulseOf("p-1")).profiles["team-ro"].sha256).toBe(s1);
  });

  it("test_AC07_control_live_profile", async () => {
    const { s2, A } = await setup();
    const g = await k.call("ann", "POST", "/v1/goals", { title: "ordinary", primaryRepo: REPO });
    const G = g.json.id as string;
    const p = await k.call("ann", "POST", `/v1/goals/${G}/plan`, { steps: [{ id: "run", repo: REPO, kind: "review", title: "R", brief: "r", deps: [], mode: "headless", profile: "team-ro" }], approve: true });
    expect(p.status, JSON.stringify(p.json)).toBe(201);
    expect((await k.call("ann", "POST", `/v1/steps/${G}.run/assign`, { to: A.machine })).status).toBe(200);
    expect((await k.step(`${G}.run`)).offer.profile.sha256).toBe(s2);
  });

  it("test_AC07_update_preset", async () => {
    const { s2 } = await setup();
    const res = await k.act("ann", "p-1", "update", { preset: snap("team-ro-v2", TEAM_RO_V2) });
    expect(res.status, JSON.stringify(res.json)).toBe(200);
    expect(res.json.version).toBe(2);
    expect(res.json.preset.sha256).toBe(sha(TEAM_RO_V2));
    // The update re-resolves the profiles: the replaced team-ro.
    expect(res.json.profiles).toStrictEqual({ "team-ro": s2 });
    const G = (await k.fireOk("ann", "p-1")).goal as string;
    const d = await k.goal(G);
    expect((d.steps as Json[]).map((s) => s.id).sort()).toStrictEqual([`${G}.after`, `${G}.run`]);
    expect(d.goal.preset).toStrictEqual({ name: "team-ro-v2", text: TEAM_RO_V2 });
  });

  it("test_AC07_update_window_only", async () => {
    const { s1 } = await setup();
    const before = await k.pulseOf("p-1");
    const res = await k.act("ann", "p-1", "update", { window: "2h" });
    expect(res.status, JSON.stringify(res.json)).toBe(200);
    expect(res.json.version).toBe(1);
    expect(res.json.profiles).toStrictEqual({ "team-ro": s1 });
    expect(res.json.preset.sha256).toBe(before.preset.sha256);
    const after = await k.pulseOf("p-1");
    expect(after.profiles).toStrictEqual(before.profiles);
    expect(after.version).toBe(1);
    expect(after.windowMs).toBe(2 * HOUR);
  });

  it("test_AC07_not_in_snapshot", async () => {
    const { A } = await setup();
    const G = (await k.fireOk("ann", "p-1")).goal as string;
    // A pulse goal has no design step: replan is 404; a later plan comes through the direct plan route.
    const rp = await k.call("ann", "POST", `/v1/goals/${G}/replan`, { comment: "again" });
    expect(rp.status, JSON.stringify(rp.json)).toBe(404);
    const steps = [
      { id: "run", repo: REPO, kind: "review", title: "R", brief: "r", deps: [], mode: "headless", agent: "auditor", profile: "team-ro" },
      { id: "x", repo: REPO, kind: "review", title: "X", brief: "x", deps: [], mode: "headless", profile: "read-only" },
    ];
    const p = await k.call("ann", "POST", `/v1/goals/${G}/plan`, { steps, approve: true });
    expect(p.status, JSON.stringify(p.json)).toBe(201);
    expect((await k.step(`${G}.x`)).state).toBe("ready");
    const res = await k.call("ann", "POST", `/v1/steps/${G}.x/assign`, { to: A.machine });
    expect(res.status, JSON.stringify(res.json)).toBe(409);
    expect(res.json.error).toContain(`${G}.x: profile read-only is not in the goal's snapshot`);
    expect((await k.step(`${G}.x`)).offer).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------------------------

describe("AC-08 create-with-plan", () => {
  /** p-1: built-in audit-relay, every 1d from T0; a headless machine of ann that is not a candidate (other repo). */
  async function fire(): Promise<{ G: string; other: Bare }> {
    await start();
    const other = await k.bare("ann", "hl-other", { headless: true, repos: ["git.example.com/org/beta"] });
    await k.pulseOk("ann", relayBody({ when: { every: "1d", at: T0 } }));
    await k.tickAt(T0);
    return { G: await firedGoal("p-1", iso(T0)), other };
  }

  it("test_AC08_goal_shape", async () => {
    const { G } = await fire();
    const s = await k.slotOf("p-1", iso(T0));
    expect(s).toMatchObject({ pulse: "p-1", slot: iso(T0), at: T0, state: "fired", goal: G, firedAt: T0, until: T0 + 4 * HOUR, tried: [] });
    const g = (await k.goal(G)).goal;
    expect(g.refs).toStrictEqual({ pulse: "p-1", slot: iso(T0) });
    expect(g.preset).toStrictEqual({ name: "audit-relay", text: RELAY_TEXT() });
    expect(g).toMatchObject({ primaryRepo: REPO, title: `audit-relay on alpha (${iso(T0)})`, ownerId: "ann", state: "in_progress", priority: 3 });
    const pulse = await k.pulseOf("p-1");
    expect(g.profiles).toStrictEqual(pulse.profiles);
    expect(keys(g.profiles)).toStrictEqual(["propose-via-branch", "read-only"]);
  });

  it("test_AC08_no_design", async () => {
    const { G } = await fire();
    expect(((await k.goal(G)).steps as Json[]).map((s) => s.id)).toStrictEqual([`${G}.audit`, `${G}.validate`, `${G}.file`]);
  });

  it("test_AC08_plan", async () => {
    const { G } = await fire();
    const plans = (await k.goal(G)).plans as Json[];
    expect(plans).toHaveLength(1);
    expect(plans[0]).toMatchObject({ version: 1, decision: "approved", proposedBy: "ann", decidedBy: "ann", comment: `pulse p-1 (preset audit-relay ${sha12(RELAY_TEXT())})` });
  });

  it("test_AC08_states", async () => {
    const { G } = await fire();
    expect((await k.step(`${G}.audit`)).state).toBe("ready");
    expect((await k.step(`${G}.validate`)).state).toBe("blocked");
    expect((await k.step(`${G}.file`)).state).toBe("blocked");
  });

  it("test_AC08_events", async () => {
    const { G } = await fire();
    const created = await k.eventsOfGoal("goal.created", G);
    expect(created).toHaveLength(1);
    expect(created[0].user).toBe("ann");
    expect(created[0].payload).toMatchObject({ preset: "audit-relay", pulse: "p-1", slot: iso(T0) });
    expect(typeof created[0].payload.title).toBe("string");
    const approved = await k.eventsOfGoal("plan.approved", G);
    expect(approved).toHaveLength(1);
    expect(approved[0].payload).toMatchObject({ version: 1 });
    expect((await k.eventsOfGoal("step.ready", G)).map((e) => e.step)).toStrictEqual([`${G}.audit`]);
    expect(await k.pulseEvents("pulse.fired", "p-1")).toHaveLength(1);
  });

  it("test_AC08_no_inbox", async () => {
    const { G, other } = await fire();
    await k.w.flush();
    const mentions = (ms: Json[]) => ms.filter((m) => m.kind === "plan_approved" || JSON.stringify(m).includes(G));
    expect(mentions(await k.inbox(k.tok.ann as string))).toStrictEqual([]);
    expect(mentions(await k.inbox(other.token))).toStrictEqual([]);
    // Positive control: the same inbox read sees a message about G once a step of G is offered there.
    const relayed = await k.call("ann", "POST", `/v1/steps/${G}.audit/assign`, { to: other.machine });
    expect(relayed.status, JSON.stringify(relayed.json)).toBe(200);
    expect(mentions(await k.inbox(other.token)).map((m) => m.kind)).toStrictEqual(["offer"]);
  });

  it("test_AC08_lineage", async () => {
    const { G } = await fire();
    expect((await k.stepAct(k.tok.ann as string, `${G}.audit`, "claim")).status).toBe(200);
    const rec = { coverage: "complete", assessment: "issues", items: [{ key: { rule: "R-1", path: "src/a.ts" }, title: "T", severity: "S3", category: "c", evidence: [] }], dispositions: [], summary: "s" };
    const res = await k.stepAct(k.tok.ann as string, `${G}.audit`, "review", rec);
    expect(res.status, JSON.stringify(res.json)).toBe(201);
    expect(res.json.review.lineage).toBe(`audit-relay|${REPO}|auditor`);
    const items = await k.call("ann", "GET", `/v1/items?lineage=${encodeURIComponent(`audit-relay|${REPO}|auditor`)}`);
    expect((items.json.items as Json[]).map((x) => x.key?.rule ?? x.rule)).toStrictEqual(["R-1"]);
  });
});

// ---------------------------------------------------------------------------------------------

describe("AC-09 idempotent", () => {
  async function setup(): Promise<void> {
    await start();
    await k.pulseOk("ann", body());
  }

  it("test_AC09_two_ticks", async () => {
    await setup();
    k.at(T0);
    await k.w.tick();
    await k.w.tick();
    expect((await k.slotsOf("p-1")).map((s) => s.slot)).toStrictEqual([iso(T0)]);
    expect((await k.pulseEvents("pulse.fired", "p-1")).filter((e) => e.payload.slot === iso(T0))).toHaveLength(1);
    expect(await k.goalsOfPulse("p-1")).toHaveLength(1);
    expect((await k.pulseOf("p-1")).nextAt).toBe(T0 + DAY);
  });

  it("test_AC09_concurrent_ticks", async () => {
    for (let i = 0; i < 5; i++) {
      if (i > 0) await k.stop();
      await setup();
      k.at(T0);
      await Promise.all([k.w.tick(), k.w.tick()]);
      expect((await k.slotsOf("p-1")).map((s) => s.slot), `run ${i}`).toStrictEqual([iso(T0)]);
      expect(await k.goalsOfPulse("p-1"), `run ${i}`).toHaveLength(1);
      expect((await k.pulseEvents("pulse.fired", "p-1")).filter((e) => e.payload.slot === iso(T0)), `run ${i}`).toHaveLength(1);
    }
  });

  it("test_AC09_slot_preinserted", async () => {
    await setup();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- new store method
    expect(await (k.w.hubStore as any).addSlot({ pulse: "p-1", slot: iso(T0), at: T0, state: "fired", tried: [], decidedAt: T0 })).toBe(true);
    await k.tickAt(T0);
    expect(await k.goalsOfPulse("p-1")).toStrictEqual([]);
    expect(await k.pulseEvents("pulse.fired", "p-1")).toStrictEqual([]);
    expect((await k.pulseOf("p-1")).nextAt).toBe(T0 + DAY);
  });

  it("test_AC09_stale_due", async () => {
    await setup();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- new store method
    const copy = await (k.w.hubStore as any).getPulse("p-1");
    expect(copy).toMatchObject({ enabled: true, nextAt: T0 });
    expect((await k.act("ann", "p-1", "pause")).status).toBe(200);
    k.storeWrap({ duePulses: () => [copy] });
    await k.tickAt(T0);
    expect(await k.slotsOf("p-1")).toStrictEqual([]);
    const p = await k.pulseOf("p-1");
    expect(p.enabled).toBe(false);
    expect(Object.hasOwn(p, "nextAt")).toBe(false);
    expect(p.pausedReason).toBe("paused by ann");
  });

  it("test_AC09_stale_due_control", async () => {
    await setup();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- new store method
    const copy = await (k.w.hubStore as any).getPulse("p-1");
    k.storeWrap({ duePulses: () => [copy] });
    await k.tickAt(T0);
    expect((await k.slotsOf("p-1")).map((s) => [s.slot, s.state])).toStrictEqual([[iso(T0), "fired"]]);
  });
});

// ---------------------------------------------------------------------------------------------

describe("AC-10 overlap and abandon", () => {
  const Sk = (n: number) => S(n, DAY);
  async function setup(o: Record<string, unknown> = {}, machine = true): Promise<Bare | undefined> {
    await start();
    const M = machine ? await k.bare("ann", "box-m") : undefined;
    await k.pulseOk("ann", body({ maxGoalAge: "3d", ...o }));
    return M;
  }
  /** Fire S0 and let M accept (claim) the run step; returns G1. */
  async function claimed(M: Bare): Promise<string> {
    await k.tickAt(Sk(0), M);
    const G1 = await firedGoal("p-1", iso(Sk(0)));
    expect((await k.step(`${G1}.run`)).offer).toMatchObject({ to: { machine: M.machine }, state: "offered", by: "ann" });
    const acc = await k.stepAct(M.token, `${G1}.run`, "accept");
    expect(acc.status, JSON.stringify(acc.json)).toBe(200);
    expect((await k.step(`${G1}.run`)).state).toBe("claimed");
    return G1;
  }

  it("test_AC10_skip_then_abandon", async () => {
    const M = (await setup()) as Bare;
    const G1 = await claimed(M);
    await k.tickAt(Sk(0) + MIN, M);
    expect((await k.slotOf("p-1", iso(Sk(0)))).startedAt).toBe(Sk(0) + MIN);
    for (const n of [1, 2]) {
      await k.tickAt(Sk(n), M);
      const s = await k.slotOf("p-1", iso(Sk(n)));
      expect(s).toMatchObject({ state: "skipped", reason: "overlap" });
      expect(Object.hasOwn(s, "goal")).toBe(false);
      const ev = (await k.pulseEvents("pulse.skipped", "p-1")).filter((e) => e.payload.slot === iso(Sk(n)));
      expect(ev).toHaveLength(1);
      expect(ev[0].payload).toStrictEqual({ pulse: "p-1", slot: iso(Sk(n)), reason: "overlap", running: G1 });
    }
    expect(await k.goalState(G1)).toBe("in_progress");
    await k.tickAt(Sk(3), M);
    expect(await k.goalState(G1)).toBe("dropped");
    const gd = await k.eventsOfGoal("goal.dropped", G1);
    expect(gd).toHaveLength(1);
    expect(gd[0].payload).toStrictEqual({ reason: "abandoned" });
    expect((await k.step(`${G1}.run`)).state).toBe("dropped");
    const sd = (await k.eventsOfGoal("step.dropped", G1)).filter((e) => e.step === `${G1}.run`);
    expect(sd).toHaveLength(1);
    expect(sd[0].payload).toStrictEqual({ reason: "abandoned" });
    expect(await k.slotOf("p-1", iso(Sk(0)))).toMatchObject({ state: "abandoned", reason: "max_goal_age", goal: G1 });
    const ab = await k.pulseEvents("pulse.abandoned", "p-1");
    expect(ab).toHaveLength(1);
    expect(ab[0].payload).toStrictEqual({ pulse: "p-1", slot: iso(Sk(0)) });
    expect(ab[0].goal).toBe(G1);
    const G2 = await firedGoal("p-1", iso(Sk(3)));
    expect(G2).not.toBe(G1);
  });

  it("test_AC10_not_before_age", async () => {
    const M = (await setup()) as Bare;
    const G1 = await claimed(M);
    for (const t of [Sk(0) + MIN, Sk(1), Sk(2), Sk(3) - MIN]) await k.tickAt(t, M);
    expect(await k.goalState(G1)).toBe("in_progress");
    expect(await k.pulseEvents("pulse.abandoned", "p-1")).toStrictEqual([]);
    expect((await k.slotOf("p-1", iso(Sk(0)))).state).toBe("fired");
    // Positive control: at exactly 3 days it is abandoned.
    await k.tickAt(Sk(3), M);
    expect(await k.goalState(G1)).toBe("dropped");
  });

  it("test_AC10_allow", async () => {
    const M = (await setup({ overlap: "allow" })) as Bare;
    const G1 = await claimed(M);
    await k.tickAt(Sk(0) + MIN, M);
    await k.tickAt(Sk(1), M);
    const G2 = await firedGoal("p-1", iso(Sk(1)));
    expect(G2).not.toBe(G1);
    expect(await k.goalState(G1)).toBe("in_progress");
  });

  it("test_AC10_done_never_blocks", async () => {
    const M = (await setup()) as Bare;
    const G1 = await claimed(M);
    const d = await k.stepAct(M.token, `${G1}.run`, "done", { outcome: "done", summary: "ok" });
    expect(d.status, JSON.stringify(d.json)).toBe(200);
    expect(await k.goalState(G1)).toBe("done");
    await k.tickAt(Sk(1), M);
    const G2 = await firedGoal("p-1", iso(Sk(1)));
    expect(G2).not.toBe(G1);
    await k.tickAt(Sk(3), M);
    expect((await k.slotOf("p-1", iso(Sk(0)))).state).toBe("fired");
    expect(await k.goalState(G1)).toBe("done");
    expect((await k.pulseEvents("pulse.abandoned", "p-1")).filter((e) => e.payload.slot === iso(Sk(0)))).toStrictEqual([]);
  });

  it("test_AC10_no_machine", async () => {
    await setup({}, false);
    await k.tickAt(Sk(0));
    const G1 = await firedGoal("p-1", iso(Sk(0)));
    await k.tickAt(Sk(0) + 4 * HOUR);
    expect(await k.slotOf("p-1", iso(Sk(0)))).toMatchObject({ state: "missed", reason: "no_machine", goal: G1, tried: [] });
    expect(await k.goalState(G1)).toBe("dropped");
    expect((await k.eventsOfGoal("goal.dropped", G1)).map((e) => e.payload)).toStrictEqual([{ reason: "missed" }]);
    await k.tickAt(Sk(1));
    const G2 = await firedGoal("p-1", iso(Sk(1)));
    expect(G2).not.toBe(G1);
    for (const t of [Sk(1) + 4 * HOUR, Sk(2), Sk(2) + 4 * HOUR, Sk(3)]) await k.tickAt(t);
    expect((await k.slotOf("p-1", iso(Sk(0)))).state).toBe("missed");
    expect((await k.pulseEvents("pulse.abandoned", "p-1")).filter((e) => e.payload.slot === iso(Sk(0)))).toStrictEqual([]);
  });

  it("test_AC10_window_edge", async () => {
    await setup({}, false);
    await k.tickAt(Sk(0));
    const G1 = await firedGoal("p-1", iso(Sk(0)));
    await k.tickAt(Sk(0) + 4 * HOUR - 1);
    expect((await k.slotOf("p-1", iso(Sk(0)))).state).toBe("fired");
    expect(await k.goalState(G1)).toBe("in_progress");
  });
});

// ---------------------------------------------------------------------------------------------

interface Fleet {
  A: Bare;
  B: Bare;
  C: Bare;
  D: Bare;
  E: Bare;
  alive: Bare[];
}
/**
 * ann's headless machines: A and B (label audit; A has an idle session in alpha, so suggest ranks it
 * first), C (label audit, offline at T0: never synced after NOW), D (online, no label), E (online,
 * headless, no label: a target for a person's offer). Pulse p-1: SOLO_HL, target labels [audit].
 */
async function fleet(o: Record<string, unknown> = {}, text = SOLO_HL, hubYaml: Record<string, unknown> = THRESHOLDS): Promise<Fleet> {
  await start({ hubYaml });
  const A = await k.bare("ann", "hl-a", { headless: true, sessions: [k.idleSession("s-a-1")] }, ["audit"]);
  const B = await k.bare("ann", "hl-b", { headless: true }, ["audit"]);
  const C = await k.bare("ann", "hl-c", { headless: true }, ["audit"]);
  const D = await k.bare("ann", "hl-d", { headless: true });
  const E = await k.bare("ann", "hl-e", { headless: true });
  await k.pulseOk("ann", body({ target: { labels: ["audit"] }, window: "1h", ...o }, "solo-hl", text));
  return { A, B, C, D, E, alive: [A, B, D, E] };
}
const offersOf = async (id: string): Promise<Json[]> => (await k.r.allEvents()).filter((e) => e.type === "step.offered" && e.step === id);
const stickOf = async (G: string): Promise<Json> => ((await k.w.hubStore.getGoal(G)) as Json)?.stick;

describe("AC-11 machine choice", () => {
  it("test_AC11_first_offer", async () => {
    const f = await fleet();
    await k.tickAt(T0, ...f.alive);
    const G = await firedGoal("p-1", iso(T0));
    const st = await k.step(`${G}.run`);
    expect(st.offer).toMatchObject({ to: { machine: f.A.machine }, by: "ann", state: "offered", at: T0 });
    expect(Object.hasOwn(st.offer, "bySid")).toBe(false);
    expect(Object.hasOwn(st.offer, "byMachine")).toBe(false);
    expect((await k.slotOf("p-1", iso(T0))).tried).toStrictEqual([{ machine: f.A.machine, at: T0 }]);
    expect(await stickOf(G)).toMatchObject({ to: { machine: f.A.machine }, by: "ann" });
    const msg = (await k.inbox(f.A.token)).filter((m) => m.kind === "offer" && m.data?.step === `${G}.run`);
    expect(msg).toHaveLength(1);
    expect(msg[0].data.deadline).toBe(T0 + 30 * MIN);
  });

  it("test_AC11_deadline_window_bound", async () => {
    const f = await fleet({ window: "20m" });
    await k.tickAt(T0, ...f.alive);
    const G = await firedGoal("p-1", iso(T0));
    const msg = (await k.inbox(f.A.token)).filter((m) => m.kind === "offer" && m.data?.step === `${G}.run`);
    expect(msg).toHaveLength(1);
    expect(msg[0].data.deadline).toBe(T0 + 20 * MIN);
  });

  it("test_AC11_declined", async () => {
    const f = await fleet();
    await k.tickAt(T0, ...f.alive);
    const G = await firedGoal("p-1", iso(T0));
    expect((await k.stepAct(f.A.token, `${G}.run`, "decline", { note: "no" })).status).toBe(200);
    await k.tickAt(T0 + MIN, ...f.alive);
    expect((await k.slotOf("p-1", iso(T0))).tried).toStrictEqual([
      { machine: f.A.machine, at: T0, outcome: "declined" },
      { machine: f.B.machine, at: T0 + MIN },
    ]);
    expect((await k.step(`${G}.run`)).offer).toMatchObject({ to: { machine: f.B.machine }, state: "offered" });
    expect((await stickOf(G)).to.machine).toBe(f.B.machine);
  });

  it("test_AC11_timeout_withdraw", async () => {
    const f = await fleet();
    await k.tickAt(T0, ...f.alive);
    const G = await firedGoal("p-1", iso(T0));
    await k.tickAt(T0 + 19 * MIN, ...f.alive);
    expect((await k.slotOf("p-1", iso(T0))).tried).toHaveLength(1);
    expect((await k.step(`${G}.run`)).offer).toMatchObject({ to: { machine: f.A.machine }, state: "offered" });
    await k.tickAt(T0 + 20 * MIN, ...f.alive);
    const wd = (await k.r.allEvents()).filter((e) => e.type === "step.offer_withdrawn" && e.step === `${G}.run`);
    expect(wd).toHaveLength(1);
    expect(wd[0].payload.reason).toBe("pulse: not accepted in time");
    const tried = (await k.slotOf("p-1", iso(T0))).tried as Json[];
    expect(tried.map((t) => [t.machine, t.outcome])).toStrictEqual([
      [f.A.machine, "timeout"],
      [f.B.machine, undefined],
    ]);
    expect((await k.step(`${G}.run`)).offer).toMatchObject({ to: { machine: f.B.machine }, state: "offered" });
  });

  it("test_AC11_timeout_expiry_pass", async () => {
    const f = await fleet({ window: "3h" });
    await k.tickAt(T0, ...f.alive);
    const G = await firedGoal("p-1", iso(T0));
    await k.tickAt(T0 + 30 * MIN + 1_000, ...f.alive);
    const all = await k.r.allEvents();
    expect(all.filter((e) => e.type === "step.offer_expired" && e.step === `${G}.run`)).toHaveLength(1);
    expect(all.filter((e) => e.type === "step.offer_withdrawn" && e.step === `${G}.run`)).toStrictEqual([]);
    const tried = (await k.slotOf("p-1", iso(T0))).tried as Json[];
    expect(tried.map((t) => [t.machine, t.outcome])).toStrictEqual([
      [f.A.machine, "timeout"],
      [f.B.machine, undefined],
    ]);
    expect((await k.step(`${G}.run`)).offer).toMatchObject({ to: { machine: f.B.machine }, state: "offered", at: T0 + 30 * MIN + 1_000 });
  });

  it("test_AC11_person_offer_waits", async () => {
    const f = await fleet();
    await k.tickAt(T0, ...f.alive);
    const G = await firedGoal("p-1", iso(T0));
    expect((await k.stepAct(f.A.token, `${G}.run`, "decline")).status).toBe(200);
    const person = await k.call("ann", "POST", `/v1/steps/${G}.run/assign`, { to: f.E.machine });
    expect(person.status, JSON.stringify(person.json)).toBe(200);
    for (const t of [T0 + MIN, T0 + 2 * MIN]) {
      await k.tickAt(t, ...f.alive);
      expect((await k.step(`${G}.run`)).offer).toMatchObject({ to: { machine: f.E.machine }, state: "offered" });
      expect(((await k.slotOf("p-1", iso(T0))).tried as Json[]).map((x) => x.machine)).toStrictEqual([f.A.machine]);
    }
    expect((await offersOf(`${G}.run`)).map((e) => e.payload.machine)).not.toContain(f.B.machine);
    expect((await k.stepAct(f.E.token, `${G}.run`, "decline")).status).toBe(200);
    await k.tickAt(T0 + 3 * MIN, ...f.alive);
    expect((await k.step(`${G}.run`)).offer).toMatchObject({ to: { machine: f.B.machine }, state: "offered" });
    expect(((await k.slotOf("p-1", iso(T0))).tried as Json[]).map((x) => x.machine)).toStrictEqual([f.A.machine, f.B.machine]);
  });

  it("test_AC11_capacity_release", async () => {
    const f = await fleet();
    await k.tickAt(T0, ...f.alive);
    const G = await firedGoal("p-1", iso(T0));
    expect((await k.stepAct(f.A.token, `${G}.run`, "accept")).status).toBe(200);
    await k.tickAt(T0 + MIN / 2, ...f.alive);
    expect(((await k.slotOf("p-1", iso(T0))).tried as Json[])[0].outcome).toBe("accepted");
    expect((await k.stepAct(f.A.token, `${G}.run`, "release", { note: "capacity: queue full" })).status).toBe(200);
    await k.tickAt(T0 + MIN, ...f.alive);
    const tried = (await k.slotOf("p-1", iso(T0))).tried as Json[];
    expect(tried.map((t) => [t.machine, t.outcome])).toStrictEqual([
      [f.A.machine, "capacity"],
      [f.B.machine, undefined],
    ]);
    expect((await k.step(`${G}.run`)).offer).toMatchObject({ to: { machine: f.B.machine }, state: "offered" });
  });

  it("test_AC11_release_other_note", async () => {
    const f = await fleet();
    await k.tickAt(T0, ...f.alive);
    const G = await firedGoal("p-1", iso(T0));
    expect((await k.stepAct(f.A.token, `${G}.run`, "accept")).status).toBe(200);
    expect((await k.stepAct(f.A.token, `${G}.run`, "release", { note: "busy" })).status).toBe(200);
    await k.tickAt(T0 + MIN, ...f.alive);
    const tried = (await k.slotOf("p-1", iso(T0))).tried as Json[];
    expect(tried.map((t) => [t.machine, t.outcome])).toStrictEqual([
      [f.A.machine, "released"],
      [f.B.machine, undefined],
    ]);
    expect((await k.step(`${G}.run`)).offer).toMatchObject({ to: { machine: f.B.machine }, state: "offered" });
  });

  it("test_AC11_never_c_d_or_twice", async () => {
    const f = await fleet();
    await k.tickAt(T0, ...f.alive);
    const G = await firedGoal("p-1", iso(T0));
    expect((await k.stepAct(f.A.token, `${G}.run`, "decline")).status).toBe(200);
    await k.tickAt(T0 + MIN, ...f.alive);
    expect((await k.step(`${G}.run`)).offer).toMatchObject({ to: { machine: f.B.machine } });
    expect((await k.stepAct(f.B.token, `${G}.run`, "decline")).status).toBe(200);
    for (let t = T0 + 5 * MIN; t <= T0 + HOUR; t += 5 * MIN) await k.tickAt(t, ...f.alive);
    const targets = (await offersOf(`${G}.run`)).map((e) => e.payload.machine as string);
    expect(targets).toStrictEqual([f.A.machine, f.B.machine]);
    for (const m of [f.C, f.D, f.E]) expect(targets).not.toContain(m.machine);
    expect(await k.slotOf("p-1", iso(T0))).toMatchObject({ state: "missed", reason: "not_accepted" });
  });

  it("test_AC11_stick_follows", async () => {
    const f = await fleet({}, TWO_HL);
    await k.tickAt(T0, ...f.alive);
    const G = await firedGoal("p-1", iso(T0));
    expect((await k.stepAct(f.A.token, `${G}.run`, "accept")).status).toBe(200);
    const d = await k.stepAct(f.A.token, `${G}.run`, "done", { outcome: "done", summary: "ok" });
    expect(d.status, JSON.stringify(d.json)).toBe(200);
    const next = await k.step(`${G}.next`);
    expect(next.state).toBe("ready");
    expect(next.offer).toMatchObject({ to: { machine: f.A.machine }, state: "offered", stick: true });
    expect(((await k.slotOf("p-1", iso(T0))).tried as Json[]).map((t) => t.machine)).toStrictEqual([f.A.machine]);
  });
});

// ---------------------------------------------------------------------------------------------

describe("AC-12 missed reasons", () => {
  /** Only A (headless, label audit) unless `none`. */
  async function solo(o: { none?: boolean; hubYaml?: Record<string, unknown> } = {}): Promise<{ A?: Bare; alive: Bare[] }> {
    await start({ hubYaml: o.hubYaml ?? THRESHOLDS });
    const A = o.none ? undefined : await k.bare("ann", "hl-a", { headless: true }, ["audit"]);
    await k.pulseOk("ann", body({ target: { labels: ["audit"] }, window: "1h" }, "solo-hl", SOLO_HL));
    return { ...(A ? { A } : {}), alive: A ? [A] : [] };
  }
  /** The window end: slot missed with `reason`, the goal dropped, no open offer, one pulse.missed. */
  async function missedWith(G: string, reason: string, tried: number): Promise<void> {
    const s = await k.slotOf("p-1", iso(T0));
    expect(s).toMatchObject({ state: "missed", reason, goal: G });
    expect(await k.goalState(G)).toBe("dropped");
    expect((await k.eventsOfGoal("goal.dropped", G)).map((e) => e.payload)).toStrictEqual([{ reason: "missed" }]);
    const offer = (await k.step(`${G}.run`)).offer;
    if (offer) expect(offer.state).not.toBe("offered");
    const ev = await k.pulseEvents("pulse.missed", "p-1");
    expect(ev).toHaveLength(1);
    expect(keys(ev[0].payload)).toStrictEqual(["pulse", "reason", "slot", "tried"]);
    expect(ev[0].payload).toStrictEqual({ pulse: "p-1", slot: iso(T0), reason, tried });
    expect(ev[0].goal).toBe(G);
  }

  it("test_AC12_no_machine", async () => {
    await solo({ none: true });
    await k.tickAt(T0);
    const G = await firedGoal("p-1", iso(T0));
    await k.tickAt(T0 + HOUR);
    await missedWith(G, "no_machine", 0);
  });

  it("test_AC12_declined_only", async () => {
    const { A, alive } = await solo();
    await k.tickAt(T0, ...alive);
    const G = await firedGoal("p-1", iso(T0));
    expect((await k.stepAct((A as Bare).token, `${G}.run`, "decline")).status).toBe(200);
    await k.tickAt(T0 + HOUR, ...alive);
    await missedWith(G, "not_accepted", 1);
  });

  it("test_AC12_still_offered", async () => {
    // offer_expiry 2h: the timeout is min(2h, 20m) = 20m, and no tick runs between the offer and the window end.
    const { alive } = await solo({ hubYaml: { thresholds: { offer_expiry: "2h", machine_offline: "15m" } } });
    await k.tickAt(T0, ...alive);
    const G = await firedGoal("p-1", iso(T0));
    expect((await k.step(`${G}.run`)).offer.state).toBe("offered");
    await k.tickAt(T0 + HOUR, ...alive);
    await missedWith(G, "not_accepted", 1);
    expect((await k.step(`${G}.run`)).offer.state).toBe("withdrawn");
  });

  it("test_AC12_capacity", async () => {
    const { A, alive } = await solo();
    await k.tickAt(T0, ...alive);
    const G = await firedGoal("p-1", iso(T0));
    expect((await k.stepAct((A as Bare).token, `${G}.run`, "accept")).status).toBe(200);
    expect((await k.stepAct((A as Bare).token, `${G}.run`, "release", { note: "capacity: full" })).status).toBe(200);
    await k.tickAt(T0 + HOUR, ...alive);
    await missedWith(G, "capacity", 1);
  });

  it("test_AC12_expired", async () => {
    const { A, alive } = await solo();
    await k.tickAt(T0, ...alive);
    const G = await firedGoal("p-1", iso(T0));
    expect((await k.stepAct((A as Bare).token, `${G}.run`, "accept")).status).toBe(200);
    await k.tickAt(T0 + 5 * MIN, ...alive);
    await k.tickAt(T0 + HOUR, ...alive);
    await missedWith(G, "expired", 1);
    expect((await k.step(`${G}.run`)).state).toBe("dropped");
    const sd = (await k.eventsOfGoal("step.dropped", G)).filter((e) => e.step === `${G}.run`);
    expect(sd.map((e) => e.payload)).toStrictEqual([{ reason: "missed" }]);
  });

  it("test_AC12_started_headless", async () => {
    const { A, alive } = await solo();
    await k.tickAt(T0, ...alive);
    const G = await firedGoal("p-1", iso(T0));
    expect((await k.stepAct((A as Bare).token, `${G}.run`, "accept")).status).toBe(200);
    k.at(T0 + 10 * MIN);
    const run = await k.stepAct((A as Bare).token, `${G}.run`, "run", { state: "started", runId: "r1" });
    expect(run.status, JSON.stringify(run.json)).toBe(200);
    // Set by the report at once, before any tick.
    expect((await k.slotOf("p-1", iso(T0))).startedAt).toBe(T0 + 10 * MIN);
    await k.tickAt(T0 + HOUR, ...alive);
    await k.tickAt(T0 + 5 * HOUR, ...alive);
    expect(await k.slotOf("p-1", iso(T0))).toMatchObject({ state: "fired", startedAt: T0 + 10 * MIN });
    expect(await k.goalState(G)).toBe("in_progress");
    expect(await k.pulseEvents("pulse.missed", "p-1")).toStrictEqual([]);
  });

  it("test_AC12_started_interactive", async () => {
    await start({ hubYaml: THRESHOLDS });
    const M = await k.bare("ann", "box-m");
    await k.pulseOk("ann", body({ window: "1h" }));
    await k.tickAt(T0, M);
    const G = await firedGoal("p-1", iso(T0));
    k.at(T0 + 5 * MIN);
    expect((await k.stepAct(M.token, `${G}.run`, "accept")).status).toBe(200);
    await k.tickAt(T0 + 6 * MIN, M);
    expect((await k.slotOf("p-1", iso(T0))).startedAt).toBe(T0 + 6 * MIN);
    await k.tickAt(T0 + 2 * HOUR, M);
    expect((await k.slotOf("p-1", iso(T0))).state).toBe("fired");
    expect(await k.goalState(G)).toBe("in_progress");
  });
});

// ---------------------------------------------------------------------------------------------

describe("AC-13 downtime", () => {
  const Sk = (n: number) => S(n, HOUR);
  async function down(o: Record<string, unknown>, moveMs: number): Promise<void> {
    await start();
    await k.pulseOk("ann", body({ when: { every: "1h", at: T0 }, window: "30m", ...o }));
    k.at(Sk(0) - MIN);
    await k.w.tick();
    await k.w.stopHub();
    k.at(Sk(0) - MIN + moveMs);
    await k.w.startHubAgain();
    await k.w.tick();
  }
  const rows = async () => (await k.slotsOf("p-1")).map((s) => [s.slot, s.state, s.reason ?? null, s.goal ?? null]);

  it("test_AC13_fires_latest_in_window", async () => {
    await down({}, 5 * HOUR + 11 * MIN);
    const s5 = await k.slotOf("p-1", iso(Sk(5)));
    expect(s5).toMatchObject({ state: "fired", at: Sk(5), until: Sk(5) + 30 * MIN });
    expect(typeof s5.goal).toBe("string");
    const all = await rows();
    expect(all).toHaveLength(6);
    for (const n of [0, 1, 2, 3, 4]) expect(all, String(n)).toContainEqual([iso(Sk(n)), "missed", "hub_down", null]);
    expect((await k.pulseOf("p-1")).nextAt).toBe(Sk(6));
  });

  it("test_AC13_record_none", async () => {
    await down({}, 4 * HOUR + 41 * MIN);
    const all = await rows();
    expect(all).toHaveLength(5);
    for (const n of [0, 1, 2, 3, 4]) expect(all, String(n)).toContainEqual([iso(Sk(n)), "missed", "hub_down", null]);
    expect(await k.pulseEvents("pulse.fired", "p-1")).toStrictEqual([]);
    expect(await k.goalsOfPulse("p-1")).toStrictEqual([]);
    expect((await k.pulseOf("p-1")).nextAt).toBe(Sk(5));
  });

  it("test_AC13_catch_up_once", async () => {
    await down({ missed: "catch-up-once" }, 4 * HOUR + 41 * MIN);
    const now = Sk(4) + 40 * MIN;
    const s4 = await k.slotOf("p-1", iso(Sk(4)));
    expect(s4).toMatchObject({ state: "fired", catchUp: true, firedAt: now, until: now + 30 * MIN, at: Sk(4) });
    const all = await rows();
    expect(all).toHaveLength(5);
    for (const n of [0, 1, 2, 3]) expect(all, String(n)).toContainEqual([iso(Sk(n)), "missed", "hub_down", null]);
    const fired = await k.pulseEvents("pulse.fired", "p-1");
    expect(fired).toHaveLength(1);
    expect(fired[0].payload).toStrictEqual({ pulse: "p-1", slot: iso(Sk(4)), catchUp: true });
    expect((await k.pulseOf("p-1")).nextAt).toBe(Sk(5));
  });

  it("test_AC13_cap_10", async () => {
    await down({}, 20 * HOUR);
    const all = await rows();
    expect(all).toHaveLength(10);
    expect(all.map((r) => r[0]).sort()).toStrictEqual(Array.from({ length: 10 }, (_, i) => iso(Sk(10 + i))).sort());
    for (const r of all) expect(r.slice(1)).toStrictEqual(["missed", "hub_down", null]);
    expect(await k.goalsOfPulse("p-1")).toStrictEqual([]);
    expect((await k.pulseOf("p-1")).nextAt).toBe(Sk(20));
  });

  it("test_AC13_fired_then_stopped", async () => {
    await start();
    await k.pulseOk("ann", body({ when: { every: "1h", at: T0 }, window: "30m" }));
    await k.tickAt(Sk(0));
    const G = await firedGoal("p-1", iso(Sk(0)));
    expect((await k.slotOf("p-1", iso(Sk(0)))).until).toBe(Sk(0) + 30 * MIN);
    await k.w.stopHub();
    k.at(Sk(0) + 50 * MIN);
    await k.w.startHubAgain();
    await k.w.tick();
    expect(await rows()).toStrictEqual([[iso(Sk(0)), "missed", "no_machine", G]]);
    expect(await k.goalState(G)).toBe("dropped");
    expect((await k.pulseOf("p-1")).nextAt).toBe(Sk(1));
  });

  it("test_AC13_on_time_control", async () => {
    await start();
    await k.pulseOk("ann", body({ when: { every: "1h", at: T0 }, window: "30m" }));
    await k.tickAt(Sk(0) + 20_000);
    expect(await k.slotOf("p-1", iso(Sk(0)))).toMatchObject({ state: "fired", firedAt: Sk(0) + 20_000, until: Sk(0) + 30 * MIN });
    expect((await k.pulseOf("p-1")).nextAt).toBe(Sk(1));
  });
});

// ---------------------------------------------------------------------------------------------

describe("AC-14 manual fire", () => {
  const MANUAL = /^manual:[0-9A-HJKMNP-TV-Z]{26}$/;
  async function setup(o: Record<string, unknown> = {}): Promise<void> {
    await start();
    await k.pulseOk("ann", body({ when: { every: "1d", at: T0 + 2 * DAY }, ...o }));
    k.at(T0);
  }

  it("test_AC14_owner_fire", async () => {
    await setup();
    const res = await k.act("ann", "p-1", "fire");
    expect(res.status, JSON.stringify(res.json)).toBe(201);
    const s = res.json.slot;
    expect(s.slot).toMatch(MANUAL);
    expect(s).toMatchObject({ pulse: "p-1", manual: true, by: "ann", at: T0, state: "fired", firedAt: T0, until: T0 + 4 * HOUR });
    expect(typeof s.goal).toBe("string");
    expect(await k.slotOf("p-1", s.slot)).toStrictEqual(s);
    expect((await k.pulseOf("p-1")).nextAt).toBe(T0 + 2 * DAY);
    const ev = await k.pulseEvents("pulse.fired", "p-1");
    expect(ev).toHaveLength(1);
    expect(ev[0].payload).toStrictEqual({ pulse: "p-1", slot: s.slot, manual: true });
    expect(ev[0].user).toBe("ann");
    expect(ev[0].goal).toBe(s.goal);
    expect((await k.goal(s.goal)).goal.title).toBe(`solo on alpha (${s.slot})`);
  });

  it("test_AC14_second_skipped", async () => {
    await setup();
    const first = await k.fireOk("ann", "p-1");
    const second = await k.fireOk("ann", "p-1");
    expect(second.slot).not.toBe(first.slot);
    expect(second).toMatchObject({ state: "skipped", reason: "overlap", manual: true });
    expect(Object.hasOwn(second, "goal")).toBe(false);
  });

  it("test_AC14_paused", async () => {
    await setup();
    expect((await k.act("ann", "p-1", "pause")).status).toBe(200);
    const s = await k.fireOk("ann", "p-1");
    expect(s.state).toBe("fired");
    const p = await k.pulseOf("p-1");
    expect(p.enabled).toBe(false);
    expect(Object.hasOwn(p, "nextAt")).toBe(false);
  });

  it("test_AC14_forbidden", async () => {
    await setup();
    expect(await k.act("bob", "p-1", "fire")).toStrictEqual({ status: 403, json: { error: FORBIDDEN("ann", "p-1") } });
    expect(await k.slotsOf("p-1")).toStrictEqual([]);
  });

  it("test_AC14_admin", async () => {
    await setup();
    const s = await k.fireOk("carol", "p-1");
    expect(s).toMatchObject({ by: "carol", state: "fired", manual: true });
  });

  it("test_AC14_not_found", async () => {
    await setup();
    expect(await k.act("ann", "p-9", "fire")).toStrictEqual({ status: 404, json: { error: "no pulse p-9" } });
    expect((await k.act("ann", "p-1", "delete")).status).toBe(200);
    expect(await k.act("ann", "p-1", "fire")).toStrictEqual({ status: 404, json: { error: "no pulse p-1" } });
  });

  it("test_AC14_blocks_scheduled", async () => {
    await setup({ maxGoalAge: "7d" });
    const M = await k.bare("ann", "box-m");
    const s = await k.fireOk("ann", "p-1");
    const G1 = s.goal as string;
    expect((await k.stepAct(M.token, `${G1}.run`, "accept")).status).toBe(200);
    await k.tickAt(T0 + MIN, M);
    expect((await k.slotOf("p-1", s.slot)).startedAt).toBe(T0 + MIN);
    await k.tickAt(T0 + 2 * DAY, M);
    expect(await k.slotOf("p-1", iso(T0 + 2 * DAY))).toMatchObject({ state: "skipped", reason: "overlap" });
    const ev = (await k.pulseEvents("pulse.skipped", "p-1")).filter((e) => e.payload.slot === iso(T0 + 2 * DAY));
    expect(ev.map((e) => e.payload.running)).toStrictEqual([G1]);
  });
});

// ---------------------------------------------------------------------------------------------

describe("AC-15 lifecycle", () => {
  async function setup(o: Record<string, unknown> = {}): Promise<void> {
    await start();
    k.at(T0 - HOUR);
    await k.pulseOk("ann", body(o));
  }

  it("test_AC15_pause", async () => {
    await setup();
    const res = await k.act("ann", "p-1", "pause");
    expect(res.status, JSON.stringify(res.json)).toBe(200);
    expect(res.json).toMatchObject({ id: "p-1", enabled: false, pausedReason: "paused by ann" });
    expect(Object.hasOwn(res.json, "nextAt")).toBe(false);
    await k.tickAt(T0);
    await k.tickAt(T0 + DAY);
    expect(await k.slotsOf("p-1")).toStrictEqual([]);
    const ev = await k.pulseEvents("pulse.paused", "p-1");
    expect(ev).toHaveLength(1);
    expect(ev[0].user).toBe("ann");
    expect(ev[0].payload).toStrictEqual({ pulse: "p-1", reason: "paused by ann" });
  });

  it("test_AC15_pause_twice", async () => {
    await setup();
    expect((await k.act("ann", "p-1", "pause")).status).toBe(200);
    expect(await k.act("ann", "p-1", "pause")).toStrictEqual({ status: 409, json: { error: "pulse p-1 is already paused" } });
  });

  it("test_AC15_resume", async () => {
    await setup();
    expect((await k.act("ann", "p-1", "pause")).status).toBe(200);
    await k.tickAt(T0);
    await k.tickAt(T0 + DAY);
    k.at(T0 + DAY + HOUR);
    const res = await k.act("ann", "p-1", "resume");
    expect(res.status, JSON.stringify(res.json)).toBe(200);
    expect(res.json).toMatchObject({ enabled: true, nextAt: T0 + 2 * DAY });
    expect(Object.hasOwn(res.json, "pausedReason")).toBe(false);
    await k.w.tick();
    expect(await k.slotsOf("p-1")).toStrictEqual([]);
    const ev = await k.pulseEvents("pulse.resumed", "p-1");
    expect(ev.map((e) => e.payload)).toStrictEqual([{ pulse: "p-1" }]);
    expect(ev[0].user).toBe("ann");
    // Positive control: the next slot after the resume fires.
    await k.tickAt(T0 + 2 * DAY);
    expect((await k.slotOf("p-1", iso(T0 + 2 * DAY))).state).toBe("fired");
  });

  it("test_AC15_resume_active", async () => {
    await setup();
    expect(await k.act("ann", "p-1", "resume")).toStrictEqual({ status: 409, json: { error: "pulse p-1 is not paused" } });
  });

  it("test_AC15_update_when", async () => {
    await setup();
    const t = T0 - HOUR + 5 * MIN;
    k.at(t);
    const res = await k.act("ann", "p-1", "update", { when: { every: "2d" } });
    expect(res.status, JSON.stringify(res.json)).toBe(200);
    expect(res.json.nextAt).toBe(t + 2 * DAY);
    expect(res.json.when).toStrictEqual({ every: "2d", anchor: t });
    expect(res.json.version).toBe(1);
    const ev = await k.pulseEvents("pulse.updated", "p-1");
    expect(ev.map((e) => e.payload)).toStrictEqual([{ pulse: "p-1", version: 1, fields: ["when"] }]);
  });

  it("test_AC15_defaults_follow_period", async () => {
    await setup({ when: { every: "7d" } });
    const v0 = await k.pulseOf("p-1");
    expect(v0).toMatchObject({ windowMs: 4 * HOUR, maxGoalAgeMs: 14 * DAY });
    const steps: [Record<string, unknown>, number, number][] = [
      [{ when: { every: "1d" } }, 4 * HOUR, 2 * DAY],
      [{ when: { every: "2h" } }, 2 * HOUR, 4 * HOUR],
      [{ title: "x" }, 2 * HOUR, 4 * HOUR],
    ];
    for (const [b, w, m] of steps) {
      const res = await k.act("ann", "p-1", "update", b);
      expect(res.status, JSON.stringify(res.json)).toBe(200);
      expect(res.json.windowMs, JSON.stringify(b)).toBe(w);
      expect(res.json.maxGoalAgeMs, JSON.stringify(b)).toBe(m);
      expect(Object.hasOwn(res.json, "window")).toBe(false);
      expect(Object.hasOwn(res.json, "maxGoalAge")).toBe(false);
    }
    expect((await k.pulseOf("p-1")).title).toBe("x");
  });

  it("test_AC15_given_window_kept", async () => {
    await setup({ window: "4h" });
    const res = await k.act("ann", "p-1", "update", { when: { every: "30m" } });
    expect(res.status, JSON.stringify(res.json)).toBe(200);
    expect(res.json).toMatchObject({ window: "4h", windowMs: 4 * HOUR, maxGoalAgeMs: HOUR });
  });

  async function firedSlot(): Promise<Json> {
    const s = await k.fireOk("ann", "p-1");
    expect(s.state).toBe("fired");
    return s;
  }

  it("test_AC15_delete", async () => {
    await setup();
    const s = await firedSlot();
    const res = await k.act("ann", "p-1", "delete");
    expect(res).toStrictEqual({ status: 200, json: { pulse: "p-1" } });
    expect(await k.call("ann", "GET", "/v1/pulses/p-1")).toStrictEqual({ status: 404, json: { error: "no pulse p-1" } });
    expect(((await k.call("ann", "GET", "/v1/pulses")).json.pulses as Json[]).map((p) => p.id)).not.toContain("p-1");
    await k.tickAt(s.at + 5 * HOUR);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- new store method
    expect(((await (k.w.hubStore as any).getSlot("p-1", s.slot)) as Json).state).toBe("fired");
    expect(await k.goalState(s.goal)).toBe("in_progress");
    expect((await k.pulseEvents("pulse.deleted", "p-1")).map((e) => e.payload)).toStrictEqual([{ pulse: "p-1" }]);
  });

  it("test_AC15_delete_control", async () => {
    await setup();
    const s = await firedSlot();
    await k.tickAt(s.at + 5 * HOUR);
    expect(await k.slotOf("p-1", s.slot)).toMatchObject({ state: "missed", reason: "no_machine" });
    expect(await k.goalState(s.goal)).toBe("dropped");
  });

  it("test_AC15_owner_not_member", async () => {
    await setup();
    await k.w.hubStore.setUserRoles("ann", []);
    await k.tickAt(T0);
    const p = await k.pulseOf("p-1", "carol");
    expect(p).toMatchObject({ enabled: false, pausedReason: "owner ann is not a member" });
    expect(Object.hasOwn(p, "nextAt")).toBe(false);
    const ev = await k.pulseEvents("pulse.paused", "p-1");
    expect(ev).toHaveLength(1);
    expect(ev[0].user ?? undefined).toBeUndefined();
    expect(ev[0].payload).toStrictEqual({ pulse: "p-1", reason: "owner ann is not a member" });
    expect(await k.slotsOf("p-1", "carol")).toStrictEqual([]);
    expect(await k.goalsOfPulse("p-1", "carol")).toStrictEqual([]);
  });

  it.each(["member", "approver", "admin"])("test_AC15_owner_member_roles %s", async (role) => {
    await setup();
    await k.w.hubStore.setUserRoles("ann", [role]);
    await k.tickAt(T0);
    expect((await k.slotOf("p-1", iso(T0), "carol")).state).toBe("fired");
  });

  it.each([
    ["update", { title: "x" }],
    ["pause", {}],
    ["resume", {}],
    ["delete", {}],
  ] as const)("test_AC15_non_owner %s", async (verb, b) => {
    await setup();
    expect(await k.act("bob", "p-1", verb, b)).toStrictEqual({ status: 403, json: { error: FORBIDDEN("ann", "p-1") } });
    // Positive control: an admin may.
    if (verb !== "resume") expect((await k.act("carol", "p-1", verb, b)).status).toBe(200);
  });

  it.each([
    ["update", { title: "x" }],
    ["pause", {}],
    ["resume", {}],
    ["fire", {}],
    ["delete", {}],
  ] as const)("test_AC15_not_found %s", async (verb, b) => {
    await setup();
    expect(await k.act("ann", "p-9", verb, b)).toStrictEqual({ status: 404, json: { error: "no pulse p-9" } });
  });
});

// ---------------------------------------------------------------------------------------------

describe("AC-16 hidden goals", () => {
  async function setup(): Promise<{ GP: string; GO: string; GX: string }> {
    await start();
    expect((await k.call("ann", "POST", "/v1/topics", { name: "t" })).status).toBe(201);
    await k.pulseOk("ann", body({ topics: ["t"] }));
    const GP = (await k.fireOk("ann", "p-1")).goal as string;
    const GO = (await k.call("ann", "POST", "/v1/goals", { title: "ordinary", primaryRepo: REPO, topics: ["t"] })).json.id as string;
    const GX = (await k.call("ann", "POST", "/v1/goals", { title: "untagged", primaryRepo: REPO })).json.id as string;
    return { GP, GO, GX };
  }
  const listed = async (q = "") => ((await k.call("ann", "GET", `/v1/goals${q}`)).json.goals as Json[]).map((g) => g.id as string).sort();

  it("test_AC16_default_list", async () => {
    const { GP, GO, GX } = await setup();
    const ids = await listed();
    expect(ids).toContain(GO);
    expect(ids).toContain(GX);
    expect(ids).not.toContain(GP);
  });

  it("test_AC16_with_pulses", async () => {
    const { GP, GO, GX } = await setup();
    expect(await listed("?pulses=1")).toStrictEqual([GP, GO, GX].sort());
    expect(await listed("?pulses=1&topic=t")).toStrictEqual([GP, GO].sort());
    expect(await listed("?topic=t")).toStrictEqual([GO]);
  });

  it("test_AC16_live", async () => {
    const { GP, GO } = await setup();
    const ids = ((await k.call("ann", "GET", "/v1/live")).json.goals as Json[]).map((g) => g.id);
    expect(ids).toContain(GO);
    expect(ids).not.toContain(GP);
  });

  it("test_AC16_detail_attention", async () => {
    const { GP } = await setup();
    expect((await k.call("ann", "GET", `/v1/goals/${GP}`)).status).toBe(200);
    expect((await k.stepAct(k.tok.ann as string, `${GP}.run`, "claim")).status).toBe(200);
    expect((await k.stepAct(k.tok.ann as string, `${GP}.run`, "done", { outcome: "fail", summary: "no" })).status).toBe(200);
    const att = (await k.call("ann", "GET", "/v1/attention")).json.attention as Json[];
    expect(att.filter((a) => a.step === `${GP}.run`).map((a) => a.kind)).toContain("failed");
  });
});

// ---------------------------------------------------------------------------------------------

describe("AC-17 reads", () => {
  const M1 = "zqx-preset-mark-7";
  const M2 = "zqx-profile-mark-9";
  const MARKED = SOLO_HL.replace('brief: "Audit {repo}."', `brief: "Audit {repo}. ${M1}"`).replace("agent: auditor", "agent: auditor\n    profile: team-mark");

  async function setup(): Promise<void> {
    await start();
    expect((await k.call("ann", "POST", "/v1/profiles", { name: "team-mark", text: `extends: read-only\nallow: ["Grep(${M2})"]\n` })).status).toBe(201);
    await k.pulseOk("ann", body({ overlap: "allow" }));
    await k.pulseOk("ann", body({}, "marked", MARKED));
    await k.pulseOk("bob", body());
    await k.pulseOk("bob", body());
    expect((await k.act("bob", "p-4", "delete")).status).toBe(200);
  }

  it("test_AC17_list", async () => {
    await setup();
    const res = await k.call("ann", "GET", "/v1/pulses");
    expect(res.status).toBe(200);
    const ps = res.json.pulses as Json[];
    expect(ps.map((p) => p.id)).toStrictEqual(["p-1", "p-2", "p-3"]);
    for (const p of ps) {
      for (const key of keys(p.preset)) expect(["name", "sha256", "source"], key).toContain(key);
      for (const v of Object.values(p.profiles)) expect(v).toMatch(/^[0-9a-f]{64}$/);
    }
    expect(keys(ps[1].profiles)).toStrictEqual(["team-mark"]);
    const text = JSON.stringify(res.json);
    expect(text).not.toContain(M1);
    expect(text).not.toContain(M2);
    // Positive control: the markers are stored (detail has the preset text; the profile has the rule).
    expect(JSON.stringify(await k.detail("ann", "p-2"))).toContain(M1);
    expect(JSON.stringify((await k.call("ann", "GET", "/v1/profiles/team-mark")).json)).toContain(M2);
  });

  it("test_AC17_recent", async () => {
    await setup();
    for (let i = 0; i < 12; i++) {
      k.at(NOW + i * MIN);
      await k.fireOk("ann", "p-1");
    }
    const row = ((await k.call("ann", "GET", "/v1/pulses")).json.pulses as Json[]).find((p) => p.id === "p-1");
    expect(row.recent).toHaveLength(10);
    const d = await k.detail("ann", "p-1");
    expect(d.slots).toHaveLength(12);
    expect(row.recent).toStrictEqual((d.slots as Json[]).slice(0, 10));
    const ats = (row.recent as Json[]).map((s) => s.at);
    expect(ats).toStrictEqual([...ats].sort((a, b) => b - a));
    expect(ats[0]).toBe(NOW + 11 * MIN);
  });

  it("test_AC17_mine", async () => {
    await setup();
    expect(((await k.call("bob", "GET", "/v1/pulses?mine=1")).json.pulses as Json[]).map((p) => p.id)).toStrictEqual(["p-3"]);
    expect(((await k.call("ann", "GET", "/v1/pulses?mine=1")).json.pulses as Json[]).map((p) => p.id)).toStrictEqual(["p-1", "p-2"]);
  });

  it("test_AC17_detail", async () => {
    await setup();
    for (let i = 0; i < 54; i++) {
      k.at(NOW + i * 1_000);
      await k.fireOk("ann", "p-1");
    }
    // Their windows end (no machine): those goals are dropped; one more fire stays in progress.
    await k.tickAt(NOW + 5 * HOUR);
    const last = await k.fireOk("ann", "p-1");
    const d = await k.detail("ann", "p-1");
    expect(d.slots).toHaveLength(50);
    expect(d.slots[0].slot).toBe(last.slot);
    const ats = (d.slots as Json[]).map((s) => s.at);
    expect(ats).toStrictEqual([...ats].sort((a, b) => b - a));
    expect(keys(d.goals)).toStrictEqual((d.slots as Json[]).map((s) => s.goal as string).sort());
    expect(d.goals[last.goal]).toBe("in_progress");
    expect(d.goals[d.slots[1].goal]).toBe("dropped");
    expect(d.pulse.preset.text).toBe(SOLO);
    expect(d.schedule).toBe("every 1d");
  });

  it("test_AC17_scopes", async () => {
    await setup();
    const R = await k.w.hub.svc.serviceToken("reader", ["goals:read"]);
    const W = await k.w.hub.svc.serviceToken("writer", ["goals:write"]);
    expect((await k.w.call(R, "GET", "/v1/pulses")).status).toBe(200);
    expect((await k.w.call(R, "GET", "/v1/pulses/p-1")).status).toBe(200);
    expect((await k.w.call(R, "POST", "/v1/pulses", body())).status).toBe(403);
    expect((await k.w.call(R, "POST", "/v1/pulses/p-1/fire", {})).status).toBe(403);
    const ingest = { preset: { name: "solo", text: SOLO, sha256: sha(SOLO) }, params: { repo: REPO } };
    expect((await k.w.call(W, "POST", "/v1/goals/from-preset", ingest)).status).toBe(201);
    expect((await k.w.call(R, "POST", "/v1/goals/from-preset", ingest)).status).toBe(403);
  });
});

// ---------------------------------------------------------------------------------------------

describe("AC-18 ingest", () => {
  const ingest = (o: Record<string, unknown> = {}) => ({ preset: { name: "audit-relay", text: RELAY_TEXT(), sha256: sha(RELAY_TEXT()) }, params: { ...RELAY_PARAMS }, ...o });

  async function created(): Promise<string> {
    await start();
    expect((await k.call("ann", "POST", "/v1/topics", { name: "t" })).status).toBe(201);
    const res = await k.call("ann", "POST", "/v1/goals/from-preset", ingest({ refs: { ticket: "x" }, topics: ["t"] }));
    expect(res.status, JSON.stringify(res.json)).toBe(201);
    return res.json.goal.id as string;
  }

  it("test_AC18_create", async () => {
    await created();
    const res = await k.call("ann", "POST", "/v1/goals/from-preset", ingest({ refs: { ticket: "y" } }));
    expect(res.status, JSON.stringify(res.json)).toBe(201);
    const d = res.json;
    const G = d.goal.id as string;
    expect((d.steps as Json[]).map((s) => s.id)).toStrictEqual([`${G}.audit`, `${G}.validate`, `${G}.file`]);
    expect(d.plans).toHaveLength(1);
    expect(d.plans[0]).toMatchObject({ version: 1, decision: "approved", proposedBy: "ann", decidedBy: "ann", comment: `ingest (preset audit-relay ${sha12(RELAY_TEXT())})` });
    expect(d.goal).toMatchObject({ ownerId: "ann", refs: { ticket: "y" }, title: "audit-relay on alpha", priority: 3, state: "in_progress", primaryRepo: REPO });
    expect(d.goal.preset).toStrictEqual({ name: "audit-relay", text: RELAY_TEXT() });
    expect(keys(d.goal.profiles)).toStrictEqual(["propose-via-branch", "read-only"]);
    expect(d.goal.profiles["read-only"].sha256).toBe(await builtinSha("read-only"));
    expect((await k.eventsOfGoal("goal.created", G)).map((e) => e.payload.preset)).toStrictEqual(["audit-relay"]);
  });

  it("test_AC18_listed", async () => {
    const G = await created();
    const ids = ((await k.call("ann", "GET", "/v1/goals")).json.goals as Json[]).map((g) => g.id);
    expect(ids).toContain(G);
    expect((await k.goal(G)).goal.topics).toStrictEqual(["t"]);
  });

  it("test_AC18_no_auto_offer", async () => {
    const G = await created();
    const A = await k.bare("ann", "hl-a", { headless: true });
    await k.tickAt(NOW + MIN, A);
    expect((await k.step(`${G}.audit`)).offer).toBeUndefined();
    expect(((await k.w.hubStore.getGoal(G)) as Json).stick).toBeUndefined();
    // Positive control: a person may offer it.
    expect((await k.call("ann", "POST", `/v1/steps/${G}.audit/assign`, { to: A.machine })).status).toBe(200);
  });

  it.each([["pulse"], ["slot"]])("test_AC18_refs_reserved %s", async (key) => {
    await start();
    expect(await k.call("ann", "POST", "/v1/goals/from-preset", ingest({ refs: { [key]: "x" } }))).toStrictEqual({ status: 400, json: { error: "refs.pulse and refs.slot are set by pulses only" } });
  });

  it("test_AC18_sha", async () => {
    await start();
    const b = ingest();
    b.preset = { ...b.preset, sha256: sha("other") };
    expect(await k.call("ann", "POST", "/v1/goals/from-preset", b)).toStrictEqual({ status: 400, json: { error: "preset.sha256 is not the SHA-256 of preset.text" } });
  });

  it("test_AC18_problem", async () => {
    await start();
    const res = await k.call("ann", "POST", "/v1/goals/from-preset", { preset: { name: "two-roots", text: TWO_ROOTS, sha256: sha(TWO_ROOTS) }, params: { repo: REPO } });
    expect(res).toStrictEqual({ status: 422, json: { error: PROBLEMS([FIRST_STEP("two-roots", 2)]), details: [FIRST_STEP("two-roots", 2)] } });
  });

  it("test_AC18_source_rejected", async () => {
    await start();
    const b = ingest();
    const res = await k.call("ann", "POST", "/v1/goals/from-preset", { ...b, preset: { ...b.preset, source: { repo: "alpha", commit: "c1" } } });
    expect(res.status).toBe(400);
  });
});

// ---------------------------------------------------------------------------------------------

describe("AC-21 events", () => {
  const M1 = "zqx-preset-mark-7";
  const M2 = "zqx-profile-mark-9";
  const MARKED = SOLO_HL.replace('brief: "Audit {repo}."', `brief: "Audit {repo}. ${M1}"`).replace("agent: auditor", "agent: auditor\n    profile: team-mark");

  it("test_AC21_keys_lifecycle", async () => {
    await start();
    await k.pulseOk("ann", body());
    expect((await k.act("ann", "p-1", "update", { window: "2h", overlap: "allow" })).status).toBe(200);
    expect((await k.act("ann", "p-1", "pause")).status).toBe(200);
    expect((await k.act("ann", "p-1", "resume")).status).toBe(200);
    expect((await k.act("ann", "p-1", "delete")).status).toBe(200);
    const one = async (type: string) => {
      const es = await k.pulseEvents(type, "p-1");
      expect(es, type).toHaveLength(1);
      expect(es[0].user, type).toBe("ann");
      return es[0];
    };
    expect((await one("pulse.created")).payload.pulse).toBe("p-1");
    const up = await one("pulse.updated");
    expect(keys(up.payload)).toStrictEqual(["fields", "pulse", "version"]);
    expect(up.payload).toStrictEqual({ pulse: "p-1", version: 1, fields: ["overlap", "window"] });
    expect(keys((await one("pulse.paused")).payload)).toStrictEqual(["pulse", "reason"]);
    expect((await one("pulse.resumed")).payload).toStrictEqual({ pulse: "p-1" });
    expect((await one("pulse.deleted")).payload).toStrictEqual({ pulse: "p-1" });
  });

  it("test_AC21_keys_fired_and_dropped", async () => {
    await start();
    await k.pulseOk("ann", body({ window: "1h" }));
    await k.tickAt(T0);
    const G = await firedGoal("p-1", iso(T0));
    const fired = await k.pulseEvents("pulse.fired", "p-1");
    expect(fired).toHaveLength(1);
    expect(fired[0].payload).toStrictEqual({ pulse: "p-1", slot: iso(T0) });
    expect(fired[0].goal).toBe(G);
    await k.tickAt(T0 + HOUR);
    const gd = await k.eventsOfGoal("goal.dropped", G);
    expect(gd).toHaveLength(1);
    expect(gd[0].payload).toStrictEqual({ reason: "missed" });
    const sd = await k.eventsOfGoal("step.dropped", G);
    expect(sd.map((e) => [e.step, e.payload])).toStrictEqual([[`${G}.run`, { reason: "missed" }]]);
  });

  it("test_AC21_step_dropped_by_plan", async () => {
    await start();
    const G = (await k.call("ann", "POST", "/v1/goals", { title: "ordinary", primaryRepo: REPO })).json.id as string;
    const step = (id: string) => ({ id, repo: REPO, kind: "implement", title: id, brief: "b", deps: [] });
    expect((await k.call("ann", "POST", `/v1/goals/${G}/plan`, { steps: [step("s"), step("u")], approve: true })).status).toBe(201);
    expect((await k.call("ann", "POST", `/v1/goals/${G}/replan`, { comment: "again" })).status).toBe(200);
    expect((await k.call("ann", "POST", `/v1/goals/${G}/plan`, { steps: [step("s")], approve: true })).status).toBe(201);
    const sd = (await k.eventsOfGoal("step.dropped", G)).filter((e) => e.step === `${G}.u`);
    expect(sd).toHaveLength(1);
    expect(Object.hasOwn(sd[0].payload ?? {}, "reason")).toBe(false);
  });

  it("test_AC21_no_markers", async () => {
    await start();
    expect((await k.call("ann", "POST", "/v1/profiles", { name: "team-mark", text: `extends: read-only\nallow: ["Grep(${M2})"]\n` })).status).toBe(201);
    await k.pulseOk("ann", body({ window: "1h" }, "marked", MARKED));
    expect((await k.act("ann", "p-1", "update", { title: "marked pulse" })).status).toBe(200);
    expect((await k.act("ann", "p-1", "pause")).status).toBe(200);
    expect((await k.act("ann", "p-1", "resume")).status).toBe(200);
    await k.tickAt(T0);
    await k.tickAt(T0 + HOUR);
    await k.fireOk("ann", "p-1");
    const text = JSON.stringify(await k.r.allEvents());
    expect(text).toContain("pulse.missed");
    expect(text).not.toContain(M1);
    expect(text).not.toContain(M2);
    // Positive control: the markers exist where they belong.
    expect(JSON.stringify(await k.detail("ann", "p-1"))).toContain(M1);
    expect(JSON.stringify((await k.call("ann", "GET", "/v1/profiles/team-mark")).json)).toContain(M2);
  });

  it("test_AC21_activity", async () => {
    await start();
    await k.pulseOk("ann", body({ window: "1h" }));
    await k.tickAt(T0);
    const G = await firedGoal("p-1", iso(T0));
    await k.tickAt(T0 + HOUR);
    const act = (await k.call("ann", "GET", "/v1/live")).json.activity as Json[];
    const fired = act.filter((a) => a.type === "pulse.fired");
    expect(fired.length).toBeGreaterThan(0);
    expect(fired[0].text).toContain("p-1");
    for (const a of act.filter((x) => String(x.type).startsWith("pulse."))) expect(a.text, a.type).toContain("p-1");
    const dropped = act.filter((a) => a.type === "step.dropped" && a.step === `${G}.run`);
    expect(dropped).toHaveLength(1);
    expect(dropped[0].text).toContain("dropped: its pulse slot was missed");
    expect(dropped[0].text).not.toContain("dropped by a new plan");
  });

  it("test_AC21_activity_abandoned", async () => {
    await start();
    const M = await k.bare("ann", "box-m");
    await k.pulseOk("ann", body({ maxGoalAge: "1d" }));
    await k.tickAt(T0, M);
    const G = await firedGoal("p-1", iso(T0));
    expect((await k.stepAct(M.token, `${G}.run`, "accept")).status).toBe(200);
    await k.tickAt(T0 + MIN, M);
    await k.tickAt(T0 + DAY, M);
    expect(await k.goalState(G)).toBe("dropped");
    const act = (await k.call("ann", "GET", "/v1/live")).json.activity as Json[];
    const dropped = act.filter((a) => a.type === "step.dropped" && a.step === `${G}.run`);
    expect(dropped).toHaveLength(1);
    expect(dropped[0].text).toContain("dropped: its goal was abandoned");
    expect(act.filter((a) => a.type === "pulse.abandoned").map((a) => a.text).join("\n")).toContain("p-1");
  });
});

// ---------------------------------------------------------------------------------------------

describe("AC-24 compatibility", () => {
  it("test_AC24_create_goal_design", async () => {
    await start();
    const g = await k.call("ann", "POST", "/v1/goals", { title: "ordinary", primaryRepo: REPO });
    expect(g.status).toBe(201);
    const G = g.json.id as string;
    const d = await k.goal(G);
    expect((d.steps as Json[]).map((s) => s.id)).toContain(`${G}.design`);
    expect(Object.hasOwn(d.goal, "profiles")).toBe(false);
    expect(((await k.call("ann", "GET", "/v1/goals")).json.goals as Json[]).map((x) => x.id)).toContain(G);
  });

  it("test_AC24_live_profile", async () => {
    await start();
    const A = await k.bare("ann", "hl-a", { headless: true });
    expect((await k.call("ann", "POST", "/v1/profiles", { name: "team-ro", text: "extends: read-only\n" })).status).toBe(201);
    const G = (await k.call("ann", "POST", "/v1/goals", { title: "ordinary", primaryRepo: REPO })).json.id as string;
    const p = await k.call("ann", "POST", `/v1/goals/${G}/plan`, { steps: [{ id: "run", repo: REPO, kind: "review", title: "R", brief: "r", deps: [], mode: "headless", profile: "team-ro" }], approve: true });
    expect(p.status).toBe(201);
    const second = await k.call("ann", "POST", "/v1/profiles", { name: "team-ro", text: "extends: propose-via-branch\n" });
    expect(second.status).toBe(200);
    expect((await k.call("ann", "POST", `/v1/steps/${G}.run/assign`, { to: A.machine })).status).toBe(200);
    expect((await k.step(`${G}.run`)).offer.profile.sha256).toBe(second.json.sha256);
  });

  it("test_AC24_tick_unchanged", async () => {
    await start({ hubYaml: THRESHOLDS });
    const A = await k.bare("ann", "box-a");
    const G = (await k.call("ann", "POST", "/v1/goals", { title: "ordinary", primaryRepo: REPO })).json.id as string;
    expect((await k.call("ann", "POST", `/v1/goals/${G}/plan`, { steps: [{ id: "s", repo: REPO, kind: "implement", title: "s", brief: "b", deps: [] }], approve: true })).status).toBe(201);
    expect((await k.call("ann", "POST", `/v1/steps/${G}.s/assign`, { to: A.machine })).status).toBe(200);
    await k.tickAt(NOW + 31 * MIN);
    expect((await k.step(`${G}.s`)).offer.state).toBe("expired");
    const all = await k.r.allEvents();
    expect(all.filter((e) => e.type === "step.offer_expired" && e.step === `${G}.s`)).toHaveLength(1);
    expect(all.filter((e) => String(e.type).startsWith("pulse."))).toStrictEqual([]);
    expect((await k.call("ann", "GET", "/v1/pulses")).json).toStrictEqual({ pulses: [] });
  });
});

// ---------------------------------------------------------------------------------------------

describe("AC-28 window = period", () => {
  const Sk = (n: number) => S(n, 30 * MIN);
  it.each([[0], [20_000]])("test_AC28_every_slot_fires offset %d", async (off) => {
    await start();
    await k.pulseOk("ann", body({ when: { every: "30m", at: T0 } }));
    for (const n of [0, 1, 2]) await k.tickAt(Sk(n) + off);
    const slots = await k.slotsOf("p-1");
    expect(slots.map((s) => s.state)).not.toContain("skipped");
    const goals = [0, 1, 2].map((n) => slots.find((s) => s.slot === iso(Sk(n)))?.goal);
    expect(new Set(goals).size).toBe(3);
    for (const g of goals) expect(typeof g).toBe("string");
    expect(await k.pulseEvents("pulse.fired", "p-1")).toHaveLength(3);
    for (const n of [0, 1]) {
      expect(await k.slotOf("p-1", iso(Sk(n)))).toMatchObject({ state: "missed", reason: "no_machine" });
      expect(await k.goalState(goals[n] as string)).toBe("dropped");
    }
    expect((await k.slotOf("p-1", iso(Sk(2)))).state).toBe("fired");
    expect((await k.slotOf("p-1", iso(Sk(0)))).until).toBe(Sk(0) + 30 * MIN);
  });
});

// ---------------------------------------------------------------------------------------------

describe("AC-29 errors and topics", () => {
  const BOOM = `boom-${"x".repeat(600)}`;
  async function setup(): Promise<void> {
    await start();
    expect((await k.call("ann", "POST", "/v1/topics", { name: "t" })).status).toBe(201);
    await k.pulseOk("ann", body({ topics: ["t"] }));
    await k.pulseOk("ann", body());
  }
  /** goal inserts for p-1's goals throw. */
  const failGoals = () =>
    k.storeWrap({
      createGoal: (orig, g, ...rest) => {
        if ((g as Json)?.refs?.pulse === "p-1") throw new Error(BOOM);
        return orig(g, ...rest);
      },
    });

  it("test_AC29_topic_delete", async () => {
    await setup();
    k.at(NOW + MIN);
    const del = await k.call("ann", "POST", "/v1/topics/t/delete", {});
    expect(del.status, JSON.stringify(del.json)).toBe(200);
    const p1 = await k.pulseOf("p-1");
    expect(p1).toMatchObject({ topics: [], version: 1, updatedAt: NOW + MIN });
    const ev = await k.pulseEvents("pulse.updated", "p-1");
    expect(ev).toHaveLength(1);
    expect(ev[0].user).toBe("ann");
    expect(ev[0].payload).toStrictEqual({ pulse: "p-1", version: 1, fields: ["topics"] });
    expect(await k.pulseEvents("pulse.updated", "p-2")).toStrictEqual([]);
    const td = (await k.r.allEvents()).filter((e) => e.type === "topic.deleted");
    expect(keys(td[0].payload)).toStrictEqual(["goals", "topic"]);
    await k.tickAt(T0);
    await firedGoal("p-1", iso(T0));
    await firedGoal("p-2", iso(T0));
  });

  it("test_AC29_fire_error", async () => {
    await setup();
    failGoals();
    await k.tickAt(T0);
    const s = await k.slotOf("p-1", iso(T0));
    expect(s).toMatchObject({ state: "missed", reason: "error", error: BOOM.slice(0, 500) });
    expect(Object.hasOwn(s, "goal")).toBe(false);
    expect(await k.goalsOfPulse("p-1")).toStrictEqual([]);
    const ev = await k.pulseEvents("pulse.missed", "p-1");
    expect(ev).toHaveLength(1);
    expect(ev[0].payload).toStrictEqual({ pulse: "p-1", slot: iso(T0), reason: "error", tried: 0, error: BOOM.slice(0, 500) });
    expect((await k.pulseOf("p-1")).nextAt).toBe(T0 + DAY);
    await firedGoal("p-2", iso(T0));
  });

  it("test_AC29_no_retry", async () => {
    await setup();
    const undo = failGoals();
    await k.tickAt(T0);
    undo();
    await k.tickAt(T0 + MIN);
    expect(await k.slotOf("p-1", iso(T0))).toMatchObject({ state: "missed", reason: "error" });
    expect(await k.goalsOfPulse("p-1")).toStrictEqual([]);
  });

  it("test_AC29_manual_error", async () => {
    await setup();
    failGoals();
    k.at(NOW + MIN);
    const res = await k.act("ann", "p-1", "fire");
    expect(res.status, JSON.stringify(res.json)).toBe(201);
    expect(res.json.slot).toMatchObject({ state: "missed", reason: "error", manual: true, error: BOOM.slice(0, 500) });
    // Positive control: p-2 fires manually.
    expect((await k.fireOk("ann", "p-2")).state).toBe("fired");
  });

  it("test_AC29_second_tx_throws", async () => {
    await setup();
    const undo = k.storeWrap({
      addSlot: (orig, s, ...rest) => {
        if ((s as Json)?.pulse === "p-1") throw new Error("slot write failed");
        return orig(s, ...rest);
      },
    });
    await k.tickAt(T0);
    expect(await k.slotsOf("p-1")).toStrictEqual([]);
    await firedGoal("p-2", iso(T0));
    undo();
    await k.tickAt(T0 + MIN);
    await firedGoal("p-1", iso(T0));
  });
});
