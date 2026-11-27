// RL-29 AC-01 to AC-09: a person (or a service acting for one) decides a whole review from a client
// with `POST /v1/steps/:id/decisions` (docs/specs/RL-29.md, REQ-REVDEC-1 to -10). Steps by id, items by
// fingerprint, events by type + goal/step.

import { afterEach, describe, expect, it } from "vitest";
import { A, acc, B, C, D, dayOf, def, dis, REPO, Rv, TITLE, TITLES, type Json, type Run } from "./helpers/revdec-kit.ts";
import { record } from "./helpers/overlap-kit.ts";

let v: Rv | undefined;
afterEach(async () => {
  await v?.stop();
  v = undefined;
});

/** The World with G1's debrief ready (A S1, B S2, C S3 confirmed); returns G1 and its lineage. */
async function world(o: { threshold?: number; maySet?: string[] } = {}): Promise<{ v: Rv; R: Run; lineage: string }> {
  v = await Rv.start(o.threshold !== undefined ? { threshold: o.threshold } : {});
  await v.pulse("ann", o.maySet ? { maySet: o.maySet } : {});
  const R = await v.fire();
  const lineage = await v.audit(R);
  await v.validate(R);
  expect((await v.step(R.D)).state, "control: G1's debrief is ready").toBe("ready");
  return { v, R, lineage };
}

const AC01 = (today: number) => [acc(A), dis(B, "false positive"), def(C, dayOf(today, 30))];
const ORDER = ["item.disposed", "step.noted", "review.recorded", "step.done", "step.ready", "step.skipped", "goal.done"];
const ordered = (evs: Json[], G: string) => evs.filter((e) => e.goal === G && ORDER.includes(e.type)).map((e) => [e.type, e.step]);

describe("RL-29 AC-01 a whole review decided from a client", { timeout: 120_000 }, () => {
  it("test_AC01_decide_ready_review", async () => {
    const { v, R, lineage } = await world();
    const seq = await v.lastSeq();
    const res = await v.decide("ann", R.D, AC01(v.w.clock));
    expect(res.status, JSON.stringify(res.json)).toBe(200);
    expect(res.json).toStrictEqual({
      step: R.D,
      goal: R.G,
      round: 1,
      counts: { accepted: 1, dismissed: 1, deferred: 1 },
      next: [{ step: R.F, state: "ready" }],
      sink: { topic: "audit", title: TITLE },
    });
    expect((await v.item(A, lineage)).state).toBe("accepted");
    expect((await v.item(B, lineage)).state).toBe("dismissed");
    expect(await v.item(C, lineage)).toMatchObject({ state: "deferred", until: dayOf(v.w.clock, 30) });
    const st = await v.step(R.D);
    expect(st.state).toBe("done");
    expect(st.rounds).toHaveLength(1);
    expect(st.rounds[0]).toMatchObject({ n: 1, user: "ann", outcome: "done", summary: "1 accepted, 1 dismissed, 1 deferred by ann" });
    expect(st.rounds[0].sid).toBeUndefined();
    const recs = await v.reviews(R.D);
    expect(recs).toHaveLength(1);
    expect(recs[0]).toMatchObject({ round: 1, lineage, raising: false, complete: true, decider: { kind: "person", user: "ann" }, by: "ann" });
    expect(recs[0].record).toMatchObject({ coverage: "complete", assessment: "issues", items: [], summary: "1 accepted, 1 dismissed, 1 deferred by ann" });
    expect((recs[0].record.dispositions as Json[]).map((d) => [d.fingerprint, d.disposition])).toStrictEqual([
      [A, "accepted"],
      [B, "dismissed"],
      [C, "deferred"],
    ]);
    expect(st.rounds[0].artifactIds).toContain(recs[0].artifact);
    const evs = await v.since(seq);
    expect(ordered(evs, R.G)).toStrictEqual([
      ["item.disposed", R.D],
      ["step.noted", R.D],
      ["item.disposed", R.D],
      ["step.noted", R.D],
      ["item.disposed", R.D],
      ["step.noted", R.D],
      ["review.recorded", R.D],
      ["step.done", R.D],
      ["step.ready", R.F],
    ]);
    for (const e of evs.filter((x) => x.type === "item.disposed")) expect(e.payload).toMatchObject({ via: "review-submit", decider: "person", round: 1 });
    expect(evs.find((e) => e.type === "review.recorded")?.payload).toMatchObject({ round: 1, already: 0, dispositions: 3 });
    const notes = await v.notes(R.D);
    expect(notes).toStrictEqual([
      `debrief: accepted ${A} "${TITLES[A]}": fix it`,
      `debrief: dismissed ${B} "${TITLES[B]}": false positive`,
      `debrief: deferred ${C} "${TITLES[C]}": later`,
    ]);
  });

  it("test_AC01_bad_body_400", async () => {
    const { v, R, lineage } = await world();
    const before = await v.snapshot(R.D, lineage);
    const badDate = await v.decide("ann", R.D, [acc(A), dis(B), def(C, "2026-02-30")]);
    expect(badDate.status, JSON.stringify(badDate.json)).toBe(400);
    const noReason = await v.decide("ann", R.D, [{ fingerprint: A, disposition: "accepted" }, dis(B), dis(C)]);
    expect(noReason.status, JSON.stringify(noReason.json)).toBe(400);
    const empty = await v.decide("ann", R.D, [acc(A, ""), dis(B), dis(C)]);
    expect(empty.status, JSON.stringify(empty.json)).toBe(400);
    const extraKey = await v.decide("ann", R.D, { decisions: [acc(A), dis(B), dis(C)], extra: 1 });
    expect(extraKey.status, JSON.stringify(extraKey.json)).toBe(400);
    expect(await v.snapshot(R.D, lineage)).toStrictEqual(before);
  });
});

describe("RL-29 AC-02 the file step files the accepted item", { timeout: 120_000 }, () => {
  it("test_AC02_file_after_decisions", async () => {
    const { v, R, lineage } = await world();
    await v.decideOk("ann", R.D, AC01(v.w.clock));
    await record(v.k, R.F, { dispositions: [{ fingerprint: A, disposition: "accepted", reason: "filed", link: "https://tracker.example/A" }] });
    expect((await v.step(R.F)).state).toBe("done");
    expect(await v.item(A, lineage)).toMatchObject({ state: "accepted", link: "https://tracker.example/A" });
    const cag = await v.cag();
    expect(cag?.title).toBe(TITLE);
    const view = await v.k.goalView(cag?.id as string);
    expect((view.steps as Json[]).filter((s) => s.finding?.fp === A)).toHaveLength(1);
  });
});

describe("RL-29 AC-03 every item dismissed", { timeout: 120_000 }, () => {
  it("test_AC03_all_dismissed", async () => {
    const { v, R } = await world({ threshold: 3 });
    expect(await v.k.calibGoals(), "control: no calibration goal yet").toHaveLength(0);
    const res = await v.decideOk("ann", R.D, [dis(A), dis(B), dis(C)]);
    expect(res.counts).toStrictEqual({ accepted: 0, dismissed: 3, deferred: 0 });
    expect(res.next).toStrictEqual([{ step: R.F, state: "skipped" }]);
    expect(res.sink).toBeNull();
    expect((await v.step(R.F)).state).toBe("skipped");
    expect(await v.goalState(R.G)).toBe("done");
    expect((await v.reviews(R.D))[0].record.assessment).toBe("clean");
    const cal = await v.k.calibGoals();
    expect(cal).toHaveLength(1);
    expect(cal[0].calibration).toMatchObject({ key: "alpha/auditor", hash: "a".repeat(64) });
    expect((await v.ev("calibration.opened")).length).toBe(1);
  });
});

describe("RL-29 AC-04 a service acting for the person", { timeout: 120_000 }, () => {
  it("test_AC04_act_for", async () => {
    const { v, R, lineage } = await world();
    const before = await v.snapshot(R.D, lineage);
    const noHeader = await v.decideAs(undefined, R.D, AC01(v.w.clock));
    expect([noHeader.status, noHeader.json.code]).toStrictEqual([400, "on-behalf-of-required"]);
    const reader = await v.decideAs("ann", R.D, AC01(v.w.clock), v.svcRead);
    expect(reader.status).toBe(403);
    expect(await v.snapshot(R.D, lineage)).toStrictEqual(before);
    const seq = await v.lastSeq();
    const res = await v.decideAs("ann", R.D, AC01(v.w.clock));
    expect(res.status, JSON.stringify(res.json)).toBe(200);
    expect(res.json).toMatchObject({ step: R.D, round: 1, counts: { accepted: 1, dismissed: 1, deferred: 1 }, next: [{ step: R.F, state: "ready" }], sink: { topic: "audit", title: TITLE } });
    const evs = await v.since(seq);
    const disposed = evs.filter((e) => e.type === "item.disposed");
    expect(disposed).toHaveLength(3);
    for (const e of disposed) {
      expect(e.user).toBe("ann");
      expect(e.payload).toMatchObject({ via: "review-submit", service: "svc", decider: "person" });
    }
    for (const t of ["review.recorded", "step.done"]) {
      const e = evs.find((x) => x.type === t && x.step === R.D);
      expect(e?.user, t).toBe("ann");
      expect(e?.payload.via, t).toBe("svc");
    }
    expect((await v.step(R.D)).rounds[0].user).toBe("ann");
    expect((await v.reviews(R.D))[0].decider).toStrictEqual({ kind: "person", user: "ann" });
  });
});

describe("RL-29 AC-05 who may decide, and in which state", { timeout: 120_000 }, () => {
  it("test_AC05_refusals", async () => {
    const { v, R, lineage } = await world();
    const set = AC01(v.w.clock);
    const gateGoal = await v.k.goal(v.ann, [{ id: "g", repo: REPO, kind: "gate", gate: "R1" }]);
    const before = await v.snapshot(R.D, lineage);
    const bob = await v.decide(v.bob, R.D, set);
    expect([bob.status, bob.json.code]).toStrictEqual([403, "not-assignee"]);
    const gate = await v.decide("ann", `${gateGoal}.g`, set);
    expect([gate.status, gate.json.code]).toStrictEqual([409, "not-a-review"]);
    const unknown = await v.decide("ann", "G999.debrief", set);
    expect([unknown.status, unknown.json.code]).toStrictEqual([404, "step-unknown"]);
    await v.patchStep(R.D, { state: "claimed", holderUser: "bob", claimedAt: v.w.clock });
    const foreign = await v.decide("ann", R.D, set);
    expect([foreign.status, foreign.json.code]).toStrictEqual([409, "review-not-open"]);
    await v.patchStep(R.D, { state: "ready", holderUser: undefined, claimedAt: undefined });
    expect(await v.snapshot(R.D, lineage)).toStrictEqual(before);
    // A round that already has a review record.
    await v.k.k.claim(v.ann, R.D);
    const sub = await v.k.k.review(v.ann, R.D, { coverage: "complete", assessment: "clean", items: [], dispositions: [], summary: "s" });
    expect(sub.status, JSON.stringify(sub.json)).toBe(201);
    const recorded = await v.decide("ann", R.D, set);
    expect([recorded.status, recorded.json.code]).toStrictEqual([409, "review-recorded"]);
  });

  it("test_AC05_claimed_by_the_decider_and_done", async () => {
    const { v, R } = await world();
    await v.k.k.claim(v.ann, R.D);
    await v.decideOk("ann", R.D, AC01(v.w.clock));
    const st = await v.step(R.D);
    expect(st.state).toBe("done");
    for (const f of ["holderUser", "holderSid", "holderMachine", "claimedAt"]) expect(st[f], f).toBeUndefined();
    const again = await v.decide("ann", R.D, AC01(v.w.clock));
    expect([again.status, again.json.code]).toStrictEqual([409, "review-not-open"]);
  });

  it("test_AC05_paused", async () => {
    const { v, R } = await world();
    await v.patchStep(R.D, { state: "paused", holderUser: "ann", claimedAt: v.w.clock, pausedAt: v.w.clock });
    await v.decideOk("ann", R.D, AC01(v.w.clock));
    expect((await v.step(R.D)).state).toBe("done");
  });

  it("test_AC05_held_by_a_session", async () => {
    const { v, R } = await world();
    const m = await v.pk.bare("ann", "ann-box2", { repos: ["git.example.com/org/alpha"], sessions: [v.pk.idleSession("s1")] });
    const c = await v.w.call(m.token, "POST", `/v1/steps/${R.D}/claim`, { sid: "s1" });
    expect(c.status, JSON.stringify(c.json)).toBe(200);
    expect((await v.step(R.D)).holderSid, "control: s1 holds the review").toBe("s1");
    await v.decideOk("ann", R.D, AC01(v.w.clock));
    const st = await v.step(R.D);
    for (const f of ["holderUser", "holderSid", "holderMachine"]) expect(st[f], f).toBeUndefined();
    const msgs = (await v.pk.inbox(m.token)).filter((x) => String(x.text).startsWith(`MESH: ${R.D} was finished from a client by ann`));
    expect(msgs).toHaveLength(1);
    expect(msgs[0].text).toBe(`MESH: ${R.D} was finished from a client by ann (1 accepted, 1 dismissed, 1 deferred)`);
  });

  it("test_AC05_superseded_review", async () => {
    const { v, R } = await world();
    const R2 = await v.run();
    expect(await v.goalState(R.G), "control: G1 superseded").toBe("dropped");
    const res = await v.decide("ann", R.D, AC01(v.w.clock));
    expect([res.status, res.json.code]).toStrictEqual([409, "review-not-open"]);
    expect(res.json.error).toContain(`superseded by ${R2.D}`);
  });
});

describe("RL-29 AC-05b decisions a session made earlier in the round", { timeout: 120_000 }, () => {
  it("test_AC05b_earlier_session_decision", async () => {
    const { v, R } = await world();
    await v.k.k.claim(v.ann, R.D);
    await v.k.personDispose(v.ann, R.D, A, "accepted");
    await v.patchStep(R.D, { state: "paused", pausedAt: v.w.clock });
    const seq = await v.lastSeq();
    const res = await v.decideOk("ann", R.D, [dis(B), dis(C)]);
    expect(res.counts).toStrictEqual({ accepted: 1, dismissed: 2, deferred: 0 });
    expect(res.next).toStrictEqual([{ step: R.F, state: "ready" }]);
    const rec = (await v.reviews(R.D))[0];
    expect((rec.record.dispositions as Json[]).map((d) => d.fingerprint)).toStrictEqual([A, B, C]);
    expect(rec.record.assessment).toBe("issues");
    expect((await v.since(seq)).find((e) => e.type === "review.recorded")?.payload).toMatchObject({ already: 1, dispositions: 3 });
  });

  it("test_AC05b_reverted_session_decision", async () => {
    const { v, R } = await world();
    await v.k.k.claim(v.ann, R.D);
    await v.k.personDispose(v.ann, R.D, A, "accepted");
    await v.k.revert(v.ann, R.D, A);
    const seq = await v.lastSeq();
    const res = await v.decideOk("ann", R.D, [acc(A), dis(B), dis(C)]);
    expect(res.counts).toStrictEqual({ accepted: 1, dismissed: 2, deferred: 0 });
    const rec = (await v.reviews(R.D))[0];
    expect((rec.record.dispositions as Json[]).map((d) => d.fingerprint)).toStrictEqual([A, B, C]);
    expect((await v.since(seq)).find((e) => e.type === "review.recorded")?.payload).toMatchObject({ already: 0 });
  });
});

describe("RL-29 AC-06 an invalid decision set", { timeout: 120_000 }, () => {
  const refused = async (v: Rv, id: string, decisions: unknown[], code: string, n: number, has?: string) => {
    const r = await v.decide("ann", id, decisions);
    expect([r.status, r.json.code], JSON.stringify(r.json)).toStrictEqual([422, code]);
    expect(Array.isArray(r.json.problems), JSON.stringify(r.json)).toBe(true);
    for (const p of r.json.problems as unknown[]) expect(typeof p).toBe("string");
    expect(r.json.problems, JSON.stringify(r.json.problems)).toHaveLength(n);
    if (has) expect((r.json.problems as string[]).some((p) => p.includes(has)), JSON.stringify(r.json.problems)).toBe(true);
  };

  it("test_AC06_refusals", async () => {
    const { v, R, lineage } = await world();
    const before = await v.snapshot(R.D, lineage);
    const later = dayOf(v.w.clock, 30);
    await refused(v, R.D, [acc(A), dis(B)], "review-incomplete", 1, C);
    await refused(v, R.D, [acc(A), dis(B), dis(C), dis(D)], "review-unknown-item", 1, D);
    // Incomplete comes first when both fail.
    await refused(v, R.D, [acc(A), dis(D)], "review-incomplete", 3);
    await refused(v, R.D, [acc(A), acc(A), dis(B), dis(C)], "review-invalid", 1, A);
    await refused(v, R.D, [acc(A), dis(B), def(C, undefined)], "review-invalid", 1, C);
    await refused(v, R.D, [acc(A), dis(B), def(C, dayOf(v.w.clock))], "review-invalid", 1, C);
    await refused(v, R.D, [acc(A), dis(B, "no", { requires: [A] }), dis(C)], "review-invalid", 1, B);
    // One problem per failing decision.
    await refused(v, R.D, [acc(A), acc(A), dis(B, "no", { requires: [C] }), def(C, undefined)], "review-invalid", 3);
    await refused(v, R.D, [acc(A), dis(B), def(C, later), acc(A)], "review-invalid", 1);
    expect(await v.snapshot(R.D, lineage)).toStrictEqual(before);
  });

  it("test_AC06_may_set", async () => {
    const { v, R, lineage } = await world({ maySet: ["dismissed", "deferred"] });
    const before = await v.snapshot(R.D, lineage);
    await refused(v, R.D, [acc(A), dis(B), dis(C)], "review-invalid", 1, A);
    expect(await v.snapshot(R.D, lineage)).toStrictEqual(before);
  });
});

describe("RL-29 AC-07 an empty decision set", { timeout: 120_000 }, () => {
  it("test_AC07_empty_open_set", async () => {
    const { v, R, lineage } = await world();
    // G1's review is held (so a newer run does not supersede it); every item is decided in G2's.
    await v.k.k.claim(v.ann, R.D);
    const R2 = await v.run();
    expect(await v.goalState(R.G), "control: a held review is not superseded").not.toBe("dropped");
    const early = await v.decide("ann", R.D, []);
    expect([early.status, early.json.code]).toStrictEqual([422, "review-incomplete"]);
    await v.k.k.claim(v.ann, R2.D);
    for (const f of [A, B, C]) await v.k.personDispose(v.ann, R2.D, f, "dismissed");
    expect(await v.openSet(R.D), "control: G1's open set emptied by G2's decisions").toStrictEqual([]);
    const res = await v.decideOk("ann", R.D, []);
    expect(res.counts).toStrictEqual({ accepted: 0, dismissed: 0, deferred: 0 });
    expect(res.next).toStrictEqual([{ step: R.F, state: "skipped" }]);
    expect((await v.step(R.D)).state).toBe("done");
    expect((await v.step(R.F)).state).toBe("skipped");
    expect((await v.item(A, lineage)).state).toBe("dismissed");
  });
});

describe("RL-29 AC-08 a review-submit decision is a debrief decision", { timeout: 120_000 }, () => {
  it("test_AC08_lists_revert_stats", async () => {
    const { v, R, lineage } = await world();
    await v.decideOk("ann", R.D, AC01(v.w.clock));
    const view = await v.view(R.D);
    expect((view.decided as Json[]).map((d) => [d.fp, d.via]).sort()).toStrictEqual([[A, "review-submit"], [B, "review-submit"], [C, "review-submit"]].sort());
    const list = await v.k.r.call(v.ann, "GET", "/v1/debriefs");
    expect(list.status).toBe(200);
    expect((list.json.decided as Json[]).map((d) => d.fp).sort()).toStrictEqual([A, B, C].sort());
    const stats = await v.k.hashStats("alpha/auditor", "a".repeat(64));
    expect(stats.dismissedByPeople).toBe(1);
    const seq = await v.lastSeq();
    await v.k.revert(v.ann, R.D, B);
    expect((await v.item(B, lineage)).state).toBe("confirmed");
    expect((await v.since(seq)).filter((e) => e.type === "item.reverted").map((e) => e.payload.fp)).toStrictEqual([B]);
  });
});

describe("RL-29 AC-09 Idempotency-Key", { timeout: 120_000 }, () => {
  it("test_AC09_repeat", async () => {
    const { v, R } = await world();
    const set = AC01(v.w.clock);
    const first = await v.decide("ann", R.D, set, { "idempotency-key": "k-rl29" });
    expect(first.status, JSON.stringify(first.json)).toBe(200);
    const n = (await v.events()).length;
    const second = await v.decide("ann", R.D, set, { "idempotency-key": "k-rl29" });
    expect(second).toStrictEqual(first);
    expect((await v.events()).length).toBe(n);
    expect(await v.reviews(R.D)).toHaveLength(1);
  });
});
