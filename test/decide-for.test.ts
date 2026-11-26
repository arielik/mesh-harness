// RL-22 AC-01 to AC-09: a service decides for a person (scopes goals:decide, questions:answer,
// sessions:message; X-Mesh-On-Behalf-Of on the decision, answer, message, drop and create routes),
// with the person's member role only and `via` on every event. Written from docs/specs/RL-22.md
// (§Routes, §Act-for, §Attribution). Goals, steps and questions by id; events by type + goal/step.

import { createHash } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { Ak, NOW } from "./helpers/attention-kit.ts";
import type { Json } from "./helpers/world.ts";

let k: Ak;
afterEach(async () => {
  await k?.stop();
});

const sha = (s: string) => createHash("sha256").update(s, "utf8").digest("hex");
const SOLO = 'description: One step\nsteps:\n  - { id: run, kind: implement, repo: "{repo}", title: Run, brief: run }\n';

/** A goal of ann with a pending plan (v1); its design step held by ann's live session `s-design`. */
async function pending(): Promise<string> {
  const G = await k.goal("ann", [], "pending");
  expect((await k.plan("ann", G, [{ id: "a" }], false)).status).toBe(201);
  await k.hold(`${G}.design`, "ann", "s-design");
  await k.session("ann", "s-design", { state: "idle", step: `${G}.design` });
  return G;
}
/** A goal of ann with a done step `a` and a ready gate `g` (deps a), and a parked step `p`. */
async function gated(): Promise<string> {
  const G = await k.goal("ann", [{ id: "a" }, { id: "g", kind: "gate", gate: "R1", deps: ["a"] }, { id: "p" }], "gated");
  await k.patch(`${G}.a`, { state: "done", outcome: "done", rounds: [{ n: 1, user: "ann", finishedAt: k.w.clock, outcome: "done" }] });
  await k.patch(`${G}.g`, { state: "ready" });
  await k.patch(`${G}.p`, { state: "parked", parkedReason: "round cap (3)", parkedAt: k.w.clock });
  return G;
}

/** The nine routes of AC-01 as [method, path, body]. */
async function nine(): Promise<[string, string, Json][]> {
  const P = await pending();
  const G = await gated();
  const q = await k.ask("bob", "which?", { sid: "s-design" });
  await k.hold(`${G}.p`, "ann", "s-design");
  return [
    ["approve", `/v1/goals/${P}/approve`, {}],
    ["revise", `/v1/goals/${P}/revise`, { comment: "more" }],
    ["replan", `/v1/goals/${G}/replan`, {}],
    ["gate approve", `/v1/steps/${G}.g/approve`, {}],
    ["gate reject", `/v1/steps/${G}.g/reject`, { reopen: ["a"] }],
    ["resume", `/v1/steps/${G}.p/resume`, {}],
    ["park", `/v1/steps/${G}.p/park`, { reason: "stop" }],
    ["answer", `/v1/questions/${q}/answer`, { text: "yes" }],
    ["message", "/v1/messages", { toSid: "s-design", text: "hi" }],
  ];
}

describe("RL-22 AC-01 AC-02 AC-03 scopes, header, person", () => {
  it("test_AC01_scope_required", async () => {
    k = await Ak.start(NOW);
    for (const [name, path, body] of await nine()) {
      expect(await k.as("ann", "POST", path, body, k.writer), name).toStrictEqual({ status: 403, json: { error: "forbidden", code: "forbidden" } });
    }
    for (const [name, path, body] of await nine()) {
      const r = await k.as("ann", "POST", path, body);
      expect(r.status === 403 && r.json.code === "forbidden", `${name}: ${JSON.stringify(r)}`).toBe(false);
    }
  });

  it("test_AC02_header_required", async () => {
    k = await Ak.start(NOW);
    const routes = await nine();
    const before = (await k.store.events(0, 100_000)).length;
    for (const [name, path, body] of routes) {
      const r = await k.as(undefined, "POST", path, body);
      expect([r.status, r.json.code], name).toStrictEqual([400, "on-behalf-of-required"]);
    }
    expect((await k.store.events(0, 100_000)).length).toBe(before);
    for (const [name, path, body] of routes) {
      const r = await k.as("bob", "POST", path, body, k.tok.ann as string);
      expect(r, name).toStrictEqual({ status: 403, json: { error: "on-behalf-of is for service tokens only", code: "on-behalf-of-not-service" } });
    }
    expect((await k.store.events(0, 100_000)).length).toBe(before);
  });

  it("test_AC03_unknown_person", async () => {
    k = await Ak.start(NOW);
    const P = await pending();
    for (const user of ["nobody", "Ann", "writer", "svc"]) {
      const r = await k.as(user, "POST", `/v1/goals/${P}/approve`, {});
      expect([r.status, r.json.code], user).toStrictEqual([403, "user-unknown"]);
    }
  });
});

describe("RL-22 AC-04 attribution", () => {
  it("test_AC04_plan_approve_revise_replan", async () => {
    k = await Ak.start(NOW);
    const P = await pending();
    const ok = await k.as("ann", "POST", `/v1/goals/${P}/approve`, {});
    expect(ok.status, JSON.stringify(ok.json)).toBe(200);
    expect((await k.store.listPlans(P)).at(-1)?.decidedBy).toBe("ann");
    const [ev] = (await k.events("plan.approved")).filter((e) => e.goal === P);
    expect([ev.user, ev.payload.via]).toStrictEqual(["ann", "svc"]);
    // The same by ann's own token: no via.
    const P2 = await pending();
    expect((await k.call("ann", "POST", `/v1/goals/${P2}/approve`, {})).status).toBe(200);
    const [own] = (await k.events("plan.approved")).filter((e) => e.goal === P2);
    expect(own.user).toBe("ann");
    expect(own.payload).not.toHaveProperty("via");
    // Revise: the design session's message ends with " (via svc)".
    const P3 = await pending();
    expect((await k.as("ann", "POST", `/v1/goals/${P3}/revise`, { comment: "split it" })).status).toBe(200);
    const [rev] = (await k.events("plan.revised")).filter((e) => e.goal === P3);
    expect([rev.user, rev.payload.via]).toStrictEqual(["ann", "svc"]);
    const msg = (await k.inbox("ann")).filter((m) => m.kind === "plan_revised" && m.data?.goal === P3);
    expect(msg).toHaveLength(1);
    expect(msg[0].text.endsWith(" (via svc)")).toBe(true);
    expect([msg[0].fromUser, msg[0].data.via]).toStrictEqual(["ann", "svc"]);
    // Replan of an approved goal.
    expect((await k.as("ann", "POST", `/v1/goals/${P}/replan`, { comment: "again" })).status).toBe(200);
    const [rp] = (await k.events("goal.replan")).filter((e) => e.goal === P);
    expect([rp.user, rp.payload.via]).toStrictEqual(["ann", "svc"]);
  });

  it("test_AC04_gate_and_resume", async () => {
    k = await Ak.start(NOW);
    const G = await gated();
    expect((await k.as("ann", "POST", `/v1/steps/${G}.g/reject`, { reopen: ["a"], comment: "redo" })).status).toBe(200);
    const [rej] = await k.events("gate.rejected", `${G}.g`);
    expect([rej.user, rej.payload.via]).toStrictEqual(["ann", "svc"]);
    const [ro] = await k.events("step.reopened", `${G}.a`);
    expect([ro.user, ro.payload.via]).toStrictEqual(["ann", "svc"]);
    expect((await k.step(`${G}.g`)).rounds?.at(-1)?.gate?.by).toBe("ann");
    const G2 = await gated();
    expect((await k.as("ann", "POST", `/v1/steps/${G2}.g/approve`, {})).status).toBe(200);
    const [ap] = await k.events("gate.approved", `${G2}.g`);
    expect([ap.user, ap.payload.via]).toStrictEqual(["ann", "svc"]);
    expect((await k.as("ann", "POST", `/v1/steps/${G2}.p/resume`, { comment: "go" })).status).toBe(200);
    const [rs] = await k.events("step.resumed", `${G2}.p`);
    expect([rs.user, rs.payload.via]).toStrictEqual(["ann", "svc"]);
    const notes = await k.store.listNotes(`${G2}.p`);
    expect(notes.at(-1)?.user).toBe("ann");
  });
});

describe("RL-22 AC-05 member role only", () => {
  it("test_AC05_owner_only_through_a_service", async () => {
    k = await Ak.start(NOW);
    const P = await pending();
    const G = await gated();
    for (const user of ["apu", "bob", "root"]) {
      const a = await k.as(user, "POST", `/v1/goals/${P}/approve`, {});
      expect([a.status, a.json.code], user).toStrictEqual([403, "not-approver"]);
      expect(a.json.error).toBe(`only the goal owner, approvers or admins can approve ${P}`);
      const g = await k.as(user, "POST", `/v1/steps/${G}.g/approve`, {});
      expect([g.status, g.json.code], user).toStrictEqual([403, "not-approver"]);
    }
    expect((await k.as("ann", "POST", `/v1/goals/${P}/approve`, {})).status).toBe(200);
    expect((await k.as("ann", "POST", `/v1/steps/${G}.g/approve`, {})).status).toBe(200);
    for (const user of ["apu", "root"]) {
      const P2 = await pending();
      const G2 = await gated();
      expect((await k.call(user, "POST", `/v1/goals/${P2}/approve`, {})).status, user).toBe(200);
      expect((await k.call(user, "POST", `/v1/steps/${G2}.g/approve`, {})).status, user).toBe(200);
    }
  });
});

describe("RL-22 AC-06 answer", () => {
  it("test_AC06_answer_for_a_person", async () => {
    k = await Ak.start(NOW);
    const G = await k.goal("ann", [{ id: "a" }]);
    await k.hold(`${G}.a`, "bob", "s-bob");
    await k.session("bob", "s-bob", { step: `${G}.a` });
    const q = await k.ask("bob", "which branch?", { sid: "s-bob", step: `${G}.a` });
    const other = await k.ask("bob", "and this?", { sid: "s-bob", step: `${G}.a` });
    expect(await k.as("root", "POST", `/v1/questions/${other}/answer`, { text: "no" })).toMatchObject({ status: 403, json: { code: "not-addressed", error: `question ${other} is not addressed to you` } });
    expect((await k.call("root", "POST", `/v1/questions/${other}/answer`, { text: "no" })).status).toBe(200);
    expect((await k.as("bob", "POST", `/v1/questions/${q}/answer`, { text: "main" })).status).toBe(200);
    const [ev] = (await k.events("question.answered")).filter((e) => e.payload.question === q);
    expect([ev.user, ev.payload.via]).toStrictEqual(["bob", "svc"]);
    expect((await k.store.getQuestion(q))?.answeredBy).toBe("bob");
    const msg = (await k.inbox("bob")).filter((m) => m.kind === "answer" && m.text.includes("main"));
    expect(msg).toHaveLength(1);
    expect(msg[0].text.endsWith(" (via svc)")).toBe(true);
    expect(msg[0].data?.via).toBe("svc");
    expect(await k.as("bob", "POST", `/v1/questions/${q}/answer`, { text: "again" })).toMatchObject({ status: 409, json: { code: "question-answered", error: `question ${q} is already answered` } });
    expect(await k.as("bob", "POST", "/v1/questions/999/answer", { text: "x" })).toMatchObject({ status: 404, json: { code: "question-unknown", error: "no question 999" } });
  });
});

describe("RL-22 AC-07 message", () => {
  it("test_AC07_message_for_a_person", async () => {
    k = await Ak.start(NOW);
    k.share.bob = "steps";
    await k.session("ann", "s-ann", { state: "idle" });
    await k.session("bob", "s-bob", { state: "idle" });
    const r = await k.as("ann", "POST", "/v1/messages", { toSid: "s-ann", text: "look at G1" });
    expect(r.status, JSON.stringify(r.json)).toBe(201);
    const [m] = (await k.inbox("ann")).filter((x) => x.kind === "say");
    expect([m.fromUser, m.text, m.data?.via]).toStrictEqual(["ann", "look at G1", "svc"]);
    const [ev] = await k.events("message.sent");
    expect([ev.user, ev.payload.via]).toStrictEqual(["ann", "svc"]);
    // bob's session holds no step: not visible to ann.
    expect(await k.as("ann", "POST", "/v1/messages", { toSid: "s-bob", text: "x" })).toMatchObject({ status: 404, json: { code: "session-unknown", error: "session s-bob is not live on any machine" } });
    const G = await k.goal("ann", [{ id: "a" }]);
    expect(await k.as("ann", "POST", "/v1/messages", { toStep: `${G}.a`, text: "x" })).toMatchObject({ status: 409, json: { code: "step-unheld", error: `${G}.a has no session holding it` } });
    expect(await k.as("ann", "POST", "/v1/messages", { toStep: "G99.a", text: "x" })).toMatchObject({ status: 404, json: { code: "step-unknown", error: "no step G99.a" } });
  });
});

describe("RL-22 AC-08 drop", () => {
  it("test_AC08_drop", async () => {
    k = await Ak.start(NOW);
    const G = await k.goal("ann", [{ id: "a" }]);
    const r = await k.as("ann", "POST", `/v1/goals/${G}/drop`, { reason: "dup" });
    expect(r.status, JSON.stringify(r.json)).toBe(200);
    const [ev] = (await k.events("goal.dropped")).filter((e) => e.goal === G);
    expect([ev.user, ev.payload.by, ev.payload.via]).toStrictEqual(["ann", "ann", "svc"]);
    expect(await k.as("ann", "POST", `/v1/goals/${G}/drop`, {})).toMatchObject({ status: 409, json: { code: "goal-closed", error: `${G} is dropped` } });
    const H = await k.goal("ann", [{ id: "a" }]);
    await k.hold(`${H}.a`, "ann", undefined);
    expect(await k.as("ann", "POST", `/v1/goals/${H}/drop`, {})).toMatchObject({ status: 409, json: { code: "goal-held" } });
    // writer without the header: its own goal (today), not ann's.
    const W = await k.w.call(k.writer, "POST", "/v1/goals", { title: "w", primaryRepo: "svc" });
    expect(W.status).toBe(201);
    expect((await k.w.call(k.writer, "POST", `/v1/goals/${W.json.id}/drop`, {})).status).toBe(200);
    expect(await k.w.call(k.writer, "POST", `/v1/goals/${H}/drop`, {})).toMatchObject({ status: 403, json: { code: "not-approver" } });
    expect(await k.as("ann", "POST", "/v1/goals/G99/drop", {})).toMatchObject({ status: 404, json: { code: "goal-unknown", error: "no goal G99" } });
  });
});

describe("RL-22 AC-09 create", () => {
  it("test_AC09_create_for_a_person", async () => {
    k = await Ak.start(NOW);
    const g = await k.as("ann", "POST", "/v1/goals", { title: "for ann", primaryRepo: "svc" });
    expect(g.status, JSON.stringify(g.json)).toBe(201);
    expect(g.json.ownerId).toBe("ann");
    const [ev] = (await k.events("goal.created")).filter((e) => e.goal === g.json.id);
    expect([ev.user, ev.payload.via]).toStrictEqual(["ann", "svc"]);
    const ingest = { title: "ingest", preset: { name: "solo", text: SOLO, sha256: sha(SOLO) }, params: { repo: "svc" } };
    const p = await k.as("ann", "POST", "/v1/goals/from-preset", ingest);
    expect(p.status, JSON.stringify(p.json)).toBe(201);
    const pid = p.json.goal.id as string;
    expect(p.json.goal.ownerId).toBe("ann");
    const [pc] = (await k.events("goal.created")).filter((e) => e.goal === pid);
    expect([pc.user, pc.payload.via]).toStrictEqual(["ann", "svc"]);
    const [pa] = (await k.events("plan.approved")).filter((e) => e.goal === pid);
    expect([pa.user, pa.payload.via]).toStrictEqual(["ann", "svc"]);
    // Without the header: owned by the service (today).
    const s = await k.as(undefined, "POST", "/v1/goals", { title: "own", primaryRepo: "svc" });
    expect([s.status, s.json.ownerId]).toStrictEqual([201, "svc"]);
    const [sc] = (await k.events("goal.created")).filter((e) => e.goal === s.json.id);
    expect(sc.payload).not.toHaveProperty("via");
    const sp = await k.as(undefined, "POST", "/v1/goals/from-preset", ingest);
    expect([sp.status, sp.json.goal.ownerId]).toStrictEqual([201, "svc"]);
  });
});
