// RL-21: a service token assigns a step for a person (x-mesh-on-behalf-of on POST /v1/steps/:id/assign
// and GET /v1/steps/:id/suggest, scope steps:assign), the headless mode and profile of the assign
// body, the refusal codes and the feature `step-assign-for`. Written from the spec's contracts
// (docs/specs/RL-21.md). Machines are bare (a login and syncs); steps by id, events by type + step.

import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { HUB_API, HUB_FEATURES, type Session } from "../src/protocol/index.ts";
import { Pk, snap, type Bare, type Json } from "./helpers/pulse-kit.ts";
import { rec } from "./helpers/review-kit.ts";

const H = "x-mesh-on-behalf-of";
const SVC_REPO = "git.example.com/org/svc";
const PROFILE = "extends: read-only\n";

let k: Pk;
afterEach(async () => {
  await k?.stop();
});

interface Cast {
  /** A service with goals:read and steps:assign. */
  svc: string;
  /** A service with every other scope, not steps:assign. */
  writer: string;
  /** ann's machine `box`: headless, accept self, shared with all. */
  ann: Bare;
  /** ann's second machine `two`: not headless, accept off (offers are listed). */
  ann2: Bare;
  /** bob's machine `box`: accept self and user:ann, shared with all, headless. */
  bob: Bare;
  /** root (admin)'s machine `rbox`. */
  root: Bare;
}

async function nick(m: Bare, nickname: string): Promise<void> {
  const r = await k.w.call(m.token, "POST", `/v1/machines/${m.machine}/name`, { nickname });
  expect(r.status, JSON.stringify(r.json)).toBe(200);
}

/** An idle session in svc, as a daemon syncs it. */
function idle(sid: string, o: Partial<Session> = {}): Session {
  return { ...k.idleSession(sid), repo: { id: SVC_REPO, name: "svc" }, ...o };
}

async function cast(): Promise<Cast> {
  k = await Pk.start();
  const svc = await k.w.hub.svc.serviceToken("svc", ["goals:read", "steps:assign"]);
  const writer = await k.w.hub.svc.serviceToken("writer", ["goals:read", "goals:write", "live:read", "pulses:write", "profiles:write"]);
  const ann = await k.bare("ann", "ann-box", { repos: [SVC_REPO], headless: true, share: "all", sessions: [idle("ann-s1", { name: "work" })] });
  await nick(ann, "box");
  const ann2 = await k.bare("ann", "ann-two", { repos: [SVC_REPO], accept: ["off"] });
  await nick(ann2, "two");
  const bob = await k.bare("bob", "bob-box", { repos: [SVC_REPO], accept: ["self", "user:ann"], share: "all", headless: true, sessions: [idle("bob-s1", { name: "bwork" })] });
  await nick(bob, "box");
  const root = await k.bare("root", "root-box", { repos: [SVC_REPO], headless: true });
  await nick(root, "rbox");
  return { svc, writer, ann, ann2, bob, root };
}

/** A goal of ann in repo svc with these plan steps (approved). Returns the goal id. */
async function goal(steps: Record<string, unknown>[] = [{ id: "a" }, { id: "b" }]): Promise<string> {
  return await k.r.goal(k.tok.ann as string, steps as never);
}

const as = (token: string, method: "GET" | "POST", path: string, body?: unknown, user?: string, extra: Record<string, string> = {}) =>
  k.w.call(token, method, path, body, { ...(user === undefined ? {} : { [H]: user }), ...extra });
const assignFor = (c: Cast, id: string, body: Record<string, unknown>, user = "ann", extra: Record<string, string> = {}) => as(c.svc, "POST", `/v1/steps/${id}/assign`, body, user, extra);
const suggestFor = (c: Cast, id: string, user = "ann", q = "") => as(c.svc, "GET", `/v1/steps/${id}/suggest${q}`, undefined, user);
const own = (who: string, id: string, body: Record<string, unknown>) => k.call(who, "POST", `/v1/steps/${id}/assign`, body);
const stepOf = (id: string) => k.step(id);
const offeredEvents = async (id: string): Promise<Json[]> => (await k.r.allEvents()).filter((e) => e.type === "step.offered" && e.step === id);
const offerMsgs = async (m: Bare, id: string): Promise<Json[]> => (await k.inbox(m.token)).filter((x) => x.kind === "offer" && x.data?.step === id);

/** The step has no offer and no step.offered event. */
async function untouched(id: string): Promise<void> {
  expect((await stepOf(id)).offer).toBeUndefined();
  expect(await offeredEvents(id)).toStrictEqual([]);
}

// ---------------------------------------------------------------------------------------------

describe("AC-01 AC-02 scope and header", () => {
  it("test_AC01_scope_required", async () => {
    const c = await cast();
    const G = await goal();
    for (const user of [undefined, "ann"]) {
      expect(await as(c.writer, "POST", `/v1/steps/${G}.a/assign`, { to: "box" }, user)).toStrictEqual({ status: 403, json: { error: "forbidden", code: "forbidden" } });
      expect(await as(c.writer, "GET", `/v1/steps/${G}.a/suggest`, undefined, user)).toStrictEqual({ status: 403, json: { error: "forbidden", code: "forbidden" } });
    }
    expect(await k.w.call(undefined, "POST", `/v1/steps/${G}.a/assign`, { to: "box" })).toStrictEqual({ status: 401, json: { error: "login required", code: "login-required" } });
    await untouched(`${G}.a`);
    // A member's own token needs no scope.
    expect((await own("ann", `${G}.a`, { to: "box" })).status).toBe(200);
  });

  it("test_AC02_header_required", async () => {
    const c = await cast();
    const G = await goal();
    const r1 = await as(c.svc, "POST", `/v1/steps/${G}.a/assign`, { to: "box" });
    expect([r1.status, r1.json.code]).toStrictEqual([400, "on-behalf-of-required"]);
    for (const q of ["", "?team=1"]) {
      const r = await as(c.svc, "GET", `/v1/steps/${G}.a/suggest${q}`);
      expect([r.status, r.json.code], q).toStrictEqual([400, "on-behalf-of-required"]);
    }
    const r2 = await as(k.tok.ann as string, "POST", `/v1/steps/${G}.a/assign`, { to: "box" }, "bob");
    expect(r2).toStrictEqual({ status: 403, json: { error: "on-behalf-of is for service tokens only", code: "on-behalf-of-not-service" } });
    await untouched(`${G}.a`);
  });
});

describe("AC-03 unknown person", () => {
  it("test_AC03_unknown_person", async () => {
    const c = await cast();
    const G = await goal();
    for (const user of ["nobody", "Ann", " ", "svc", "writer"]) {
      const r = await assignFor(c, `${G}.a`, { to: "box" }, user);
      expect([r.status, r.json.code], JSON.stringify(user)).toStrictEqual([403, "user-unknown"]);
      const s = await suggestFor(c, `${G}.a`, user);
      expect([s.status, s.json.code], JSON.stringify(user)).toStrictEqual([403, "user-unknown"]);
    }
    await untouched(`${G}.a`);
  });
});

describe("AC-04 own machine, attributed", () => {
  it("test_AC04_own_machine_attributed", async () => {
    const c = await cast();
    const G = await goal();
    const id = `${G}.a`;
    const r = await assignFor(c, id, { to: "box", note: "from the dashboard" });
    expect(r.status, JSON.stringify(r.json)).toBe(200);
    expect(r.json.auto).toBe(true);
    const offer = (await stepOf(id)).offer;
    expect(offer).toMatchObject({ to: { machine: c.ann.machine }, by: "ann", via: "svc", state: "offered", auto: true });
    expect(offer).not.toHaveProperty("bySid");
    expect(offer).not.toHaveProperty("byMachine");
    expect(offer).not.toHaveProperty("mode");
    const [ev] = await offeredEvents(id);
    expect(ev?.user).toBe("ann");
    expect(ev?.payload).toMatchObject({ machine: c.ann.machine, via: "svc", auto: true });
    const [msg] = await offerMsgs(c.ann, id);
    expect(msg?.data).toMatchObject({ by: "ann", via: "svc" });
    expect(r.json.message).toBe(msg?.id);
    const offers = await k.call("ann", "GET", "/v1/offers");
    expect((offers.json.offers as Json[]).find((o) => o.step === id)).toMatchObject({ by: "ann", via: "svc" });
  });
});

describe("AC-05 AC-06 AC-07 targets of another person", () => {
  it("test_AC05_other_machine_every_form", async () => {
    const c = await cast();
    const G = await goal();
    const id = `${G}.a`;
    // Positive control: ann's own token may offer to bob's machine (bob's rule user:ann), and can see his session.
    const forms = [c.bob.machine, "bob/box", "bob/box/bob-s1", `${c.bob.machine}/bob-s1`, "bob/box/bwork", "bob/box/no-such-session", `${c.bob.machine}/no-such-session`];
    for (const to of forms) {
      const r = await assignFor(c, id, { to });
      expect(r, to).toStrictEqual({ status: 403, json: { error: `machine not yours: ${to}`, code: "machine-not-yours" } });
    }
    const caps = await assignFor(c, id, { to: "Bob/box" });
    expect([caps.status, caps.json.code]).toStrictEqual([404, "machine-unknown"]);
    await untouched(id);
    expect((await own("ann", id, { to: "bob/box/bwork" })).status).toBe(200);
  });

  it("test_AC06_own_session", async () => {
    const c = await cast();
    const G = await goal();
    const r1 = await assignFor(c, `${G}.a`, { to: "box/work" });
    expect(r1.status, JSON.stringify(r1.json)).toBe(200);
    expect((await stepOf(`${G}.a`)).offer.to).toStrictEqual({ machine: c.ann.machine, sid: "ann-s1" });
    const r2 = await assignFor(c, `${G}.b`, { to: "ann/box/ann-" });
    expect(r2.status, JSON.stringify(r2.json)).toBe(200);
    expect((await stepOf(`${G}.b`)).offer.to).toStrictEqual({ machine: c.ann.machine, sid: "ann-s1" });
    // A session of bob's machine named through ann's machine is not found there.
    const G2 = await goal();
    for (const to of ["box/bwork", "box/bob-s1"]) {
      const r = await assignFor(c, `${G2}.a`, { to });
      expect([r.status, r.json.code], to).toStrictEqual([404, "session-unknown"]);
    }
  });

  it("test_AC06_session_not_yours", async () => {
    const c = await cast();
    const G = await goal();
    const id = `${G}.a`;
    // A session record of bob on ann's machine (a sid collision keeps its first owner).
    await k.w.hubStore.upsertSession(idle("bob-on-ann", { name: "intruder" }), "bob", c.ann.machine, k.w.clock);
    const r = await assignFor(c, id, { to: "box/intruder" });
    expect(r).toStrictEqual({ status: 403, json: { error: "session not yours: box/intruder", code: "session-not-yours" } });
    // An ended session of ann is not found.
    c.ann.facts.sessions = [idle("ann-s1", { name: "work", state: "ended", endedAt: k.w.clock })];
    await k.sync(c.ann);
    const ended = await assignFor(c, id, { to: "box/work" });
    expect([ended.status, ended.json.code]).toStrictEqual([404, "session-unknown"]);
    await untouched(id);
  });

  it("test_AC07_admin_grants_nothing", async () => {
    const c = await cast();
    const G = await goal();
    const r = await assignFor(c, `${G}.a`, { to: "bob/box" }, "root");
    expect([r.status, r.json.code]).toStrictEqual([403, "machine-not-yours"]);
    await untouched(`${G}.a`);
    // root's own token may offer to bob's machine (any member may): act-for grants less.
    expect((await own("root", `${G}.a`, { to: "bob/box" })).status).toBe(200);
    const ok = await assignFor(c, `${G}.b`, { to: "rbox" }, "root");
    expect(ok.status, JSON.stringify(ok.json)).toBe(200);
    expect((await stepOf(`${G}.b`)).offer).toMatchObject({ by: "root", via: "svc" });
  });
});

describe("AC-08 AC-09 step and option refusals", () => {
  it("test_AC08_step_refusal_codes", async () => {
    const c = await cast();
    const G = await goal([{ id: "a" }, { id: "z", deps: ["a"] }, { id: "g", kind: "gate" }, { id: "o" }]);
    expect((await own("ann", `${G}.o`, { to: "two" })).status).toBe(200);
    const cases: [string, number, string, string][] = [
      [`${G}.nope`, 404, "step-unknown", `no step ${G}.nope`],
      [`${G}.g`, 409, "step-gate", `${G}.g is a gate: a person decides it`],
      [`${G}.z`, 409, "step-not-ready", `${G}.z is blocked, not ready`],
      [`${G}.o`, 409, "step-offered", `${G}.o is already offered to two; withdraw it first (mesh withdraw ${G}.o)`],
    ];
    for (const [id, status, code, error] of cases) {
      expect(await assignFor(c, id, { to: "box" }), id).toStrictEqual({ status, json: { error, code } });
      expect(await own("ann", id, { to: "box" }), id).toStrictEqual({ status, json: { error, code } });
    }
  });

  it("test_AC08_debrief_code", async () => {
    const c = await cast();
    const G = await goal([
      { id: "r", output: "review-record" },
      { id: "d", deps: ["r"], mode: "debrief", output: "review-record", may_set: ["accepted", "dismissed"] },
    ]);
    // Make the debrief ready (its raising step done) in the store.
    const steps = await k.w.hubStore.listSteps({ goal: G });
    await k.w.hubStore.saveSteps(steps.map((s) => (s.id === `${G}.r` ? { ...s, state: "done" as const } : s.id === `${G}.d` ? { ...s, state: "ready" as const } : s)));
    const r = await assignFor(c, `${G}.d`, { to: "box" });
    expect([r.status, r.json.code], JSON.stringify(r.json)).toStrictEqual([409, "step-debrief"]);
  });

  it("test_AC09_act_for_options", async () => {
    const c = await cast();
    const G = await goal();
    for (const extra of [{ sid: "ann-s1" }, { stick: true }]) {
      const r = await assignFor(c, `${G}.a`, { to: "box", ...extra });
      expect([r.status, r.json.code], JSON.stringify(extra)).toStrictEqual([400, "on-behalf-of-option"]);
    }
    const s = await suggestFor(c, `${G}.a`, "ann", "?team=1");
    expect([s.status, s.json.code]).toStrictEqual([400, "on-behalf-of-option"]);
    await untouched(`${G}.a`);
    expect((await k.r.allEvents()).filter((e) => e.type === "goal.stuck" || (e.goal === G && e.type === "goal.stick"))).toStrictEqual([]);
  });
});

describe("AC-10 AC-21 suggest for a person", () => {
  it("test_AC10_suggest_only_persons", async () => {
    const c = await cast();
    const G = await goal();
    // A session of bob on ann's shared machine: ann's own token may see it, the service never.
    await k.w.hubStore.upsertSession(idle("bob-on-ann", { name: "intruder" }), "bob", c.ann.machine, k.w.clock);
    const mine = await k.call("ann", "GET", `/v1/steps/${G}.a/suggest`);
    expect((mine.json.suggestions as Json[]).find((s) => s.machine === c.ann.machine)?.idle).toBe(2);
    for (const q of ["", "?any=1"]) {
      const r = await suggestFor(c, `${G}.a`, "ann", q);
      expect(r.status, JSON.stringify(r.json)).toBe(200);
      const machines = (r.json.suggestions as Json[]).map((s) => s.machine as string).sort();
      const anns = (await k.w.hubStore.listMachines({ userId: "ann" })).map((m) => m.id);
      // Without any=1 only the machines with repo svc; with it every machine of ann (her login too).
      expect(machines, q).toStrictEqual((q ? anns : [c.ann.machine, c.ann2.machine]).sort());
      expect(r.json.team).toBe(false);
      for (const s of r.json.suggestions as Json[]) {
        expect(s.user).toBe("ann");
        if (s.session !== undefined) expect(s.session).toBe("ann-s1");
      }
      const box = (r.json.suggestions as Json[]).find((s) => s.machine === c.ann.machine);
      expect(box?.auto).toBe(true);
      expect([box?.idle, box?.session]).toStrictEqual([1, "ann-s1"]);
      expect(JSON.stringify(r.json)).not.toContain("bob-on-ann");
      expect((r.json.suggestions as Json[]).find((s) => s.machine === c.ann2.machine)?.auto).toBe(false);
    }
    // Unchanged for ann's own token: team=1 lists bob's machine too.
    const team = await k.call("ann", "GET", `/v1/steps/${G}.a/suggest?team=1`);
    expect((team.json.suggestions as Json[]).map((s) => s.machine)).toContain(c.bob.machine);
  });

  it("test_AC21_suggest_round_trip", async () => {
    const c = await cast();
    const G = await goal();
    const s = await suggestFor(c, `${G}.a`);
    const first = (s.json.suggestions as Json[])[0] as Json;
    expect(first.machine).toBe(c.ann.machine);
    const r = await assignFor(c, `${G}.a`, { to: first.to });
    expect(r.status, JSON.stringify(r.json)).toBe(200);
    expect((await stepOf(`${G}.a`)).offer.to.machine).toBe(first.machine);
  });
});

describe("AC-11 to AC-13 AC-20 headless override", () => {
  it("test_AC11_headless_override_offer", async () => {
    const c = await cast();
    const G = await goal();
    const id = `${G}.a`;
    const r = await assignFor(c, id, { to: "box", mode: "headless", profile: "read-only" });
    expect(r.status, JSON.stringify(r.json)).toBe(200);
    const ro = (await k.call("ann", "GET", "/v1/profiles/read-only")).json;
    const [msg] = await offerMsgs(c.ann, id);
    expect(msg?.data).toMatchObject({ mode: "headless", profile: { name: "read-only", sha256: ro.sha256 }, budget: { turns: 30, minutes: 30 } });
    expect(msg?.data.budget).not.toHaveProperty("usd");
    expect(typeof msg?.data.deadline).toBe("number");
    expect((await stepOf(id)).offer).toMatchObject({ mode: "headless", profile: { name: "read-only", sha256: ro.sha256 }, via: "svc" });
    const [ev] = await offeredEvents(id);
    expect(ev?.payload).toMatchObject({ mode: "headless", profile: "read-only", via: "svc" });
    // Without the fields: an interactive offer (RL-1 AC-20).
    expect((await assignFor(c, `${G}.b`, { to: "box" })).status).toBe(200);
    const [plain] = await offerMsgs(c.ann, `${G}.b`);
    expect(plain?.data).not.toHaveProperty("mode");
    expect(plain?.data).not.toHaveProperty("profile");
    expect((await stepOf(`${G}.b`)).offer).not.toHaveProperty("mode");
  });

  it("test_AC12_override_refusals", async () => {
    const c = await cast();
    const G = await goal([{ id: "a" }, { id: "h", mode: "headless", profile: "read-only" }]);
    const cases: [string, Record<string, unknown>, number, string, Bare?][] = [
      [`${G}.a`, { to: "box", mode: "headless" }, 400, "profile-required"],
      [`${G}.a`, { to: "box", profile: "read-only" }, 400, "profile-needs-headless"],
      [`${G}.a`, { to: "box/work", mode: "headless", profile: "read-only" }, 400, "headless-session-target"],
      [`${G}.h`, { to: "box", profile: "propose-via-branch" }, 409, "profile-mismatch"],
      [`${G}.a`, { to: "two", mode: "headless", profile: "read-only" }, 409, "headless-unsupported"],
      [`${G}.a`, { to: "box", mode: "headless", profile: "no-such-profile" }, 409, "headless-profile-unknown"],
    ];
    for (const [id, body, status, code] of cases) {
      for (const via of [true, false]) {
        const r = via ? await assignFor(c, id, body) : await own("ann", id, body);
        expect([r.status, r.json.code], `${JSON.stringify(body)} via=${via} ${JSON.stringify(r.json)}`).toStrictEqual([status, code]);
      }
      await untouched(id);
    }
    // Positive control: the declared profile itself is fine.
    expect((await assignFor(c, `${G}.h`, { to: "box", profile: "read-only" })).status).toBe(200);
  });

  it("test_AC12_pinned_profiles", async () => {
    const c = await cast();
    const text = `description: pinned
steps:
  - { id: a, kind: implement, repo: "{repo}", title: A, brief: a }
  - { id: h, kind: review, repo: "{repo}", deps: [a], mode: headless, profile: read-only, title: H, brief: h }
`;
    const made = await k.call("ann", "POST", "/v1/goals/from-preset", { title: "pinned", preset: snap("pinned", text), params: { repo: "svc" } });
    expect(made.status, JSON.stringify(made.json)).toBe(201);
    const G = made.json.goal.id as string;
    expect(Object.keys(made.json.goal.profiles ?? {})).toStrictEqual(["read-only"]);
    const r = await assignFor(c, `${G}.a`, { to: "box", mode: "headless", profile: "propose-via-branch" });
    expect([r.status, r.json.code]).toStrictEqual([409, "headless-profile-not-pinned"]);
    await untouched(`${G}.a`);
    const ok = await assignFor(c, `${G}.a`, { to: "box", mode: "headless", profile: "read-only" });
    expect(ok.status, JSON.stringify(ok.json)).toBe(200);
    expect((await stepOf(`${G}.a`)).offer.profile.sha256).toBe(made.json.goal.profiles["read-only"].sha256);
  });

  it("test_AC13_override_own_machine_only", async () => {
    await cast();
    const G = await goal();
    const r = await own("ann", `${G}.a`, { to: "bob/box", mode: "headless", profile: "read-only" });
    expect([r.status, r.json.code]).toStrictEqual([403, "machine-not-yours"]);
    await untouched(`${G}.a`);
    expect((await own("ann", `${G}.a`, { to: "bob/box" })).status).toBe(200);
  });

  it("test_AC20_profile_choice", async () => {
    const c = await cast();
    const G = await goal([{ id: "a" }, { id: "b" }, { id: "c" }, { id: "d" }]);
    expect((await k.call("bob", "POST", "/v1/profiles", { name: "bobs", text: PROFILE })).status).toBe(201);
    expect((await k.call("ann", "POST", "/v1/profiles", { name: "anns", text: PROFILE })).status).toBe(201);
    const bobs = await assignFor(c, `${G}.a`, { to: "box", mode: "headless", profile: "bobs" });
    expect([bobs.status, bobs.json.code]).toStrictEqual([403, "profile-not-yours"]);
    await untouched(`${G}.a`);
    expect((await assignFor(c, `${G}.a`, { to: "box", mode: "headless", profile: "anns" })).status).toBe(200);
    expect((await assignFor(c, `${G}.b`, { to: "box", mode: "headless", profile: "read-only" })).status).toBe(200);
    // ann herself may name bob's profile on her own machine.
    expect((await own("ann", `${G}.c`, { to: "box", mode: "headless", profile: "bobs" })).status).toBe(200);
    const stick = await own("ann", `${G}.d`, { to: "box", mode: "headless", profile: "read-only", stick: true });
    expect([stick.status, stick.json.code]).toStrictEqual([400, "headless-stick"]);
    const stickFor = await assignFor(c, `${G}.d`, { to: "box", mode: "headless", profile: "read-only", stick: true });
    expect([stickFor.status, stickFor.json.code]).toStrictEqual([400, "on-behalf-of-option"]);
    await untouched(`${G}.d`);
  });
});

describe("AC-15 AC-16 AC-22 other routes, idempotency, offer text", () => {
  it("test_AC15_no_act_for_elsewhere", async () => {
    const c = await cast();
    const G = await goal();
    expect((await own("ann", `${G}.b`, { to: "two" })).status).toBe(200);
    const calls: [("GET" | "POST"), string, unknown][] = [
      ["POST", `/v1/goals/${G}/assign`, { to: "box" }],
      ["GET", `/v1/goals/${G}/suggest`, undefined],
      ["POST", `/v1/steps/${G}.b/accept`, {}],
      ["POST", `/v1/steps/${G}.b/decline`, {}],
      ["POST", `/v1/steps/${G}.b/withdraw`, {}],
      ["POST", `/v1/steps/${G}.a/claim`, {}],
    ];
    for (const [method, path, b] of calls) {
      expect(await as(c.svc, method, path, b, "ann"), path).toStrictEqual({ status: 403, json: { error: "forbidden", code: "forbidden" } });
    }
    await untouched(`${G}.a`);
    expect((await stepOf(`${G}.b`)).offer.state).toBe("offered");
  });

  it("test_AC16_idempotency_per_person", async () => {
    const c = await cast();
    const G = await goal();
    const key = { "idempotency-key": "k-1" };
    const r1 = await assignFor(c, `${G}.a`, { to: "box" }, "ann", key);
    expect(r1.status, JSON.stringify(r1.json)).toBe(200);
    const r2 = await assignFor(c, `${G}.a`, { to: "box" }, "ann", key);
    expect(r2).toStrictEqual(r1);
    expect(await offeredEvents(`${G}.a`)).toHaveLength(1);
    // The same key for another person is not replayed: bob's request runs (and is refused as not his).
    const r3 = await assignFor(c, `${G}.a`, { to: "box" }, "bob", key);
    expect(r3.status).toBe(409);
    expect(r3.json.code).toBe("step-offered");
  });

  it("test_AC22_offer_text_via", async () => {
    const c = await cast();
    const G = await goal();
    expect((await assignFor(c, `${G}.a`, { to: "box", note: "please" })).status).toBe(200);
    expect((await own("ann", `${G}.b`, { to: "box", note: "please" })).status).toBe(200);
    const [viaMsg] = await offerMsgs(c.ann, `${G}.a`);
    const [ownMsg] = await offerMsgs(c.ann, `${G}.b`);
    expect(viaMsg?.text).toBe(`MESH: @ann offers step ${G}.a "Title a" (repo svc) to this machine: please (via svc)`);
    expect(ownMsg?.text).toBe(`MESH: @ann offers step ${G}.b "Title b" (repo svc) to this machine: please`);
    expect(ownMsg?.data).not.toHaveProperty("via");
  });
});

describe("AC-18 AC-19 headless offers and run-held steps", () => {
  it("test_AC18_headless_offer_not_accepted_into_session", async () => {
    const c = await cast();
    const G = await goal([{ id: "a" }, { id: "h", mode: "headless" }]);
    const id = `${G}.a`;
    // ann2 has no accept policy: the overridden offer is listed, not auto.
    c.ann2.facts.headless = true;
    c.ann2.facts.sessions = [idle("two-s1")];
    await k.sync(c.ann2);
    const r = await own("ann", id, { to: "two", mode: "headless", profile: "read-only" });
    expect(r.status, JSON.stringify(r.json)).toBe(200);
    expect(r.json.auto).toBe(false);
    const want = { status: 409, json: { error: `${id} is offered to run headless; the machine's daemon starts it, or withdraw it first (mesh withdraw ${id})`, code: "offer-headless" } };
    expect(await k.w.call(c.ann2.token, "POST", `/v1/steps/${id}/accept`, { sid: "two-s1" })).toStrictEqual(want);
    expect(await k.w.call(c.ann2.token, "POST", `/v1/steps/${id}/claim`, { sid: "two-s1" })).toStrictEqual(want);
    expect((await stepOf(id)).offer.state).toBe("offered");
    // A declared headless step whose stored offer has no mode (made before the upgrade).
    expect((await own("ann", `${G}.h`, { to: "two" })).status).toBe(200);
    const st = (await k.w.hubStore.getStep(`${G}.h`)) as NonNullable<Awaited<ReturnType<typeof k.w.hubStore.getStep>>>;
    const { mode: _m, ...old } = st.offer as NonNullable<typeof st.offer>;
    await k.w.hubStore.saveSteps([{ ...st, offer: old }]);
    expect((await k.w.call(c.ann2.token, "POST", `/v1/steps/${G}.h/accept`, { sid: "two-s1" })).json.code).toBe("offer-headless");
    // The machine's own accept without a sid (as a run does) succeeds.
    const acc = await k.w.call(c.ann2.token, "POST", `/v1/steps/${id}/accept`, {});
    expect(acc.status, JSON.stringify(acc.json)).toBe(200);
    expect((await stepOf(id)).offer.state).toBe("accepted");
  });

  it("test_AC19_run_held_narrow", async () => {
    const c = await cast();
    const G = await goal([
      { id: "a", output: "review-record" },
      { id: "b", output: "review-record" },
    ]);
    const t0 = k.w.clock;
    /** Offer `id` headless to ann's box, accept it as a run does (no sid), bind it to a print session. */
    const runIt = async (id: string, sid: string): Promise<Session> => {
      expect((await assignFor(c, id, { to: "box", mode: "headless", profile: "read-only" })).status).toBe(200);
      expect((await k.w.call(c.ann.token, "POST", `/v1/steps/${id}/accept`, {})).status).toBe(200);
      const run: Session = { ...idle(sid), kind: "print", state: "working", step: id };
      c.ann.facts.sessions = [...(c.ann.facts.sessions ?? []).filter((x) => x.sid !== sid), run];
      await k.sync(c.ann);
      expect((await k.w.call(c.ann.token, "POST", `/v1/steps/${id}/claim`, { sid })).status).toBe(200);
      return run;
    };
    const reviewsOf = async (id: string) => ((await k.call("ann", "GET", `/v1/steps/${id}/reviews`)).json.reviews as Json[]).map((x) => x.decider.kind);

    // a: held by its run (print session): an agent decides its record, and the tick leaves it alone.
    const runA = await runIt(`${G}.a`, "run-a");
    const agentRec = await k.w.call(c.ann.token, "POST", `/v1/steps/${G}.a/review`, rec({ sid: "run-a" }));
    expect(agentRec.status, JSON.stringify(agentRec.json)).toBe(201);
    expect(await reviewsOf(`${G}.a`)).toStrictEqual(["agent"]);
    c.ann.facts.sessions = [{ ...runA, state: "ended", endedAt: t0 }];
    await k.tickAt(t0 + 10 * 60_000, c.ann);
    expect((await stepOf(`${G}.a`)).state).toBe("claimed");

    // b: its run fails; resumed and claimed from an interactive session it is not run-held any more.
    await runIt(`${G}.b`, "run-b");
    const failed = await k.w.call(c.ann.token, "POST", `/v1/steps/${G}.b/done`, { summary: "no", outcome: "fail", sid: "run-b" });
    expect(failed.status, JSON.stringify(failed.json)).toBe(200);
    const resumed = await k.call("ann", "POST", `/v1/steps/${G}.b/resume`, {});
    expect(resumed.status, JSON.stringify(resumed.json)).toBe(200);
    const st = await stepOf(`${G}.b`);
    expect([st.state, st.offer?.state, st.offer?.mode]).toStrictEqual(["ready", "accepted", "headless"]);
    const t1 = k.w.clock;
    const int: Session = { ...idle("int-b"), state: "working", step: `${G}.b` };
    c.ann.facts.sessions = [int];
    await k.sync(c.ann);
    expect((await k.w.call(c.ann.token, "POST", `/v1/steps/${G}.b/claim`, { sid: "int-b" })).status).toBe(200);
    const personRec = await k.w.call(c.ann.token, "POST", `/v1/steps/${G}.b/review`, rec({ sid: "int-b" }));
    expect(personRec.status, JSON.stringify(personRec.json)).toBe(201);
    expect(await reviewsOf(`${G}.b`)).toStrictEqual(["person"]);
    c.ann.facts.sessions = [{ ...int, state: "ended", endedAt: t1 }];
    await k.tickAt(t1 + 10 * 60_000, c.ann);
    expect((await stepOf(`${G}.b`)).state).toBe("paused");
  });
});

describe("AC-17 codes additive, feature, schema and docs", () => {
  it("test_AC17_codes_additive_feature_docs", async () => {
    const c = await cast();
    // An existing refusal keeps its text (and gains no code where none is defined).
    const pulse = await as(c.writer, "POST", "/v1/pulses/p-none/pause", {}, "ann");
    expect(pulse.json.error).toBe("no pulse p-none");
    expect(pulse.json).not.toHaveProperty("code");
    expect((await k.w.call(undefined, "GET", "/healthz")).json.features).toContain("step-assign-for");
    expect(HUB_FEATURES).toContain("step-assign-for");
    for (const path of ["/v1/steps/:id/assign", "/v1/steps/:id/suggest"]) {
      const row = HUB_API.find((x) => x.path === path);
      expect(row?.scope, path).toBe("steps:assign");
      expect(row?.onBehalfOf, path).toBe(true);
    }
    expect(HUB_API.find((x) => x.path === "/v1/steps/:id/suggest")?.onBehalfOfRequired).toBe(true);
    const doc = JSON.parse(readFileSync("schemas/hub-api.openapi.json", "utf8")) as Json;
    const body = JSON.stringify(doc.paths["/v1/steps/{id}/assign"].post);
    for (const t of ["mode", "profile", "x-mesh-on-behalf-of"]) expect(body, t).toContain(t);
    const auth = readFileSync("docs/guide/auth.md", "utf8");
    for (const t of ["steps:assign", "step-assign-for", "machine-not-yours", "session-not-yours", "offer-headless", "profile-not-yours", "/v1/steps/:id/assign", "/v1/steps/:id/suggest"]) expect(auth, t).toContain(t);
    const ops = readFileSync("docs/guide/operations.md", "utf8");
    expect(ops).toContain("0.1.40 (RL-21)");
    expect(readFileSync("docs/events.md", "utf8")).toMatch(/step\.offered.*via/);
  });
});
