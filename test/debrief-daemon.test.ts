// RL-4 daemon side end to end (World): MCP `mesh_dispose` (recording, reply text, redaction, errors,
// offline), the `mesh_review` reply of a debrief record, and the local routes for the TUI
// (`GET /local/debriefs`, `POST /local/revert`). Criteria AC-08, AC-09 (tool), AC-10 (reply), AC-18
// (daemon routes). Written from the spec's contracts only (docs/specs/RL-4.md). No test runs the
// real `claude`.

import { afterEach, describe, expect, it } from "vitest";
import { A, B, C, dispositionsOf, Dk, NO_LEFT, REPO, S, TITLE, type Ids } from "./helpers/debrief-kit.ts";
import { GHP } from "./helpers/relay-kit.ts";
import { disp } from "./helpers/review-kit.ts";
import type { Json } from "./helpers/world.ts";

let k: Dk;
afterEach(async () => {
  await k?.r.stop();
});

async function fixture(o: { debrief?: Record<string, unknown>; extra?: unknown[] } = {}): Promise<Ids> {
  k = await Dk.start();
  const ids = await k.relay({ ...(o.debrief ? { debrief: o.debrief } : {}), ...(o.extra ? { extra: o.extra as never } : {}) });
  await k.auditDone(ids);
  return ids;
}
const debriefNotes = async (D: string) => (await k.notes(D)).filter((n) => n.startsWith("debrief:"));
const recArgs = (o: Record<string, unknown> = {}) => ({ coverage: "complete", assessment: "clean", items: [], summary: "s", ...o });

// ---------------------------------------------------------------------------------------------

describe("AC-08 mesh_dispose", () => {
  it("test_AC08_dispose_records", async () => {
    const { D, G } = await fixture();
    const pid = await k.hold(D);
    const text = await k.disposeOk(pid, A, "accepted", { reason: "R-A", answer: "ANS-A" });
    expect(text).toBe(`Recorded ${A}: accepted (was open). 2 item(s) left to decide.`);
    expect(await k.state(A)).toBe("accepted");
    const row = dispositionsOf(await k.history(A)).at(-1);
    expect(row).toMatchObject({ disposition: "accepted", decider: { kind: "person", user: "alice" }, via: "debrief-session", answer: "ANS-A", reason: "R-A", from: "open", to: "accepted", round: 1, step: D, goal: G });
    expect(await debriefNotes(D)).toStrictEqual([`debrief: accepted ${A} "${TITLE[A]}": R-A`]);
    expect(await k.ev("step.noted", D)).toHaveLength(1);
    const es = await k.ev("item.disposed", D);
    expect(es).toHaveLength(1);
    expect(es[0].payload).toMatchObject({ fp: A, disposition: "accepted", from: "open", decider: "person", via: "debrief-session", round: 1 });
    // The view's decided list carries the row with its title.
    const v = await k.viewOk(D);
    expect(v.decided).toHaveLength(1);
    expect(v.decided[0]).toMatchObject({ fp: A, disposition: "accepted", answer: "ANS-A", title: TITLE[A], revertable: true, via: "debrief-session" });
  });

  it("test_AC08_last_reply", async () => {
    const { D } = await fixture();
    const pid = await k.hold(D);
    expect(await k.disposeOk(pid, A, "accepted")).toBe(`Recorded ${A}: accepted (was open). 2 item(s) left to decide.`);
    expect(await k.disposeOk(pid, B, "dismissed")).toBe(`Recorded ${B}: dismissed (was open). 1 item(s) left to decide.`);
    expect(await k.disposeOk(pid, C, "deferred", { until: "2026-12-01" })).toBe(`Recorded ${C}: deferred (was open). ${NO_LEFT}`);
    expect(await k.item(C)).toMatchObject({ state: "deferred", until: "2026-12-01" });
  });

  it("test_AC08_redaction", async () => {
    const { D } = await fixture();
    const pid = await k.hold(D);
    await k.disposeOk(pid, A, "accepted", { reason: `r ${GHP}`, answer: `a ${GHP} and ${k.c.alice.config.key}` });
    const row = dispositionsOf(await k.history(A)).at(-1);
    expect(row.reason).toBe("r [REDACTED]");
    expect(row.answer).toBe("a [REDACTED] and [REDACTED]");
    const notes = (await debriefNotes(D)).join("\n");
    expect(notes).toContain("r [REDACTED]");
    expect(notes).not.toContain(GHP);
    expect(JSON.stringify(await k.item(A))).not.toContain(GHP);
    // Control: a plain answer is stored verbatim.
    await k.disposeOk(pid, B, "dismissed", { reason: "plain reason", answer: "plain answer" });
    expect(dispositionsOf(await k.history(B)).at(-1)).toMatchObject({ reason: "plain reason", answer: "plain answer" });
  });

  it("test_AC08_sends_sid_and_idempotency_key", async () => {
    const { D } = await fixture();
    const pid = await k.hold(D);
    const before = k.c.alice.requests.length;
    await k.disposeOk(pid, A, "accepted");
    const sent = k.c.alice.requests.slice(before).filter((x) => x.method === "POST" && x.path === `/v1/steps/${D}/dispositions`);
    expect(sent).toHaveLength(1);
    expect(sent[0]?.key, "Idempotency-Key").toBeTruthy();
  });
});

// ---------------------------------------------------------------------------------------------

describe("AC-09 mesh_dispose errors", () => {
  it("test_AC09_no_step_session", async () => {
    const { D } = await fixture();
    await k.w.hook(k.c.alice, "SessionStart", 9);
    const before = await k.snapshot(D);
    const t = await k.dispose(9, A, "accepted");
    expect(t.isError).toBe(true);
    expect(t.text).toBe("this session holds no step");
    expect(await k.snapshot(D)).toStrictEqual(before);
  });

  it("test_AC09_not_debrief", async () => {
    const { G, D } = await fixture({ extra: [S.step("rv", { deps: ["audit"], output: "review-record", consumes: ["open"], may_set: ["confirmed"] })] });
    const pid = await k.hold(`${G}.rv`);
    const before = await k.snapshot(D);
    const t = await k.dispose(pid, A, "accepted");
    expect(t.isError).toBe(true);
    expect(t.text).toContain(`${G}.rv is not a debrief step; a stage records its dispositions in its review record (mesh_review)`);
    expect(await k.state(A)).toBe("open");
    expect(await k.snapshot(D)).toStrictEqual(before);
    expect(await k.ev("item.disposed", `${G}.rv`)).toHaveLength(0);
  });

  it("test_AC09_tool_hub_errors", async () => {
    const { D } = await fixture();
    const pid = await k.hold(D);
    const t = await k.dispose(pid, B, "deferred");
    expect(t.isError).toBe(true);
    expect(t.text).toContain("deferred needs until (YYYY-MM-DD)");
    expect(await k.state(B)).toBe("open");
    expect(await k.ev("item.disposed", D)).toHaveLength(0);
  });

  it("test_AC09_offline", async () => {
    const { D } = await fixture();
    const pid = await k.hold(D);
    k.c.alice.offline = true;
    const t = await k.dispose(pid, A, "accepted");
    expect(t.isError).toBe(true);
    expect(t.text.startsWith("the hub is offline; the disposition was not recorded.")).toBe(true);
    k.c.alice.offline = false;
    await k.w.flush();
    await k.w.flush();
    expect(await k.state(A)).toBe("open");
    expect(await k.ev("item.disposed", D)).toHaveLength(0);
    // Control: online, the same call records.
    await k.disposeOk(pid, A, "accepted");
    expect(await k.state(A)).toBe("accepted");
    await k.w.flush();
    expect(await k.ev("item.disposed", D)).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------------------------

describe("AC-10 mesh_review reply in a debrief", () => {
  it("test_AC10b_reply_already", async () => {
    const { D, F } = await fixture();
    const pid = await k.hold(D);
    await k.disposeOk(pid, A, "accepted");
    await k.disposeOk(pid, B, "dismissed");
    const t = await k.w.tool(k.c.alice, pid, "mesh_review" as never, recArgs({ dispositions: [disp(A, "accepted"), disp(C, "deferred", { until: "2026-12-01" })] }));
    expect(t.isError, t.text).toBeFalsy();
    expect(t.text).toContain("1 disposition(s) were already recorded in this debrief.");
    const d = await k.w.tool(k.c.alice, pid, "mesh_done", { outcome: "done", summary: "s" });
    expect(d.isError, d.text).toBeFalsy();
    await k.w.flush();
    expect((await k.step(D)).state).toBe("done");
    expect((await k.step(F)).state).toBe("ready");
  });

  it("test_AC10e_reply_without_already", async () => {
    const { D } = await fixture();
    const pid = await k.hold(D);
    const t = await k.w.tool(k.c.alice, pid, "mesh_review" as never, recArgs());
    expect(t.isError, t.text).toBeFalsy();
    expect(t.text).not.toContain("already recorded in this debrief");
    expect(await k.reviews(D)).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------------------------

describe("AC-18 daemon local routes", () => {
  it("test_AC18_local_routes", async () => {
    const { D } = await fixture();
    await k.claim(k.c.alice, D);
    expect((await k.disposeRoute(k.c.alice, D, A, "accepted")).status).toBe(201);
    const hub = await k.list(k.c.alice);
    expect((hub.decided as Json[]).map((x) => x.fp)).toStrictEqual([A]);
    const loc = await k.r.local(k.c.alice, "GET", "/local/debriefs");
    expect(loc.status, JSON.stringify(loc.json)).toBe(200);
    expect(loc.json).toStrictEqual(hub);
    const rv = await k.r.local(k.c.alice, "POST", "/local/revert", { step: D, fingerprint: A });
    expect(rv.status, JSON.stringify(rv.json)).toBe(200);
    expect(rv.json.item).toMatchObject({ fp: A, state: "open" });
    expect(rv.json.reverted).toMatchObject({ fp: A, disposition: "accepted", step: D });
    expect(await k.state(A)).toBe("open");
    // A hub error keeps its status and text.
    expect(await k.r.local(k.c.alice, "POST", "/local/revert", { step: D, fingerprint: A })).toStrictEqual({ status: 409, json: { error: `${A} changed after the debrief decided it; nothing to revert` } });
  });

  it("test_AC18_local_routes_logged_out", async () => {
    await fixture();
    const out = await k.w.person("alice", REPO, { noCredentials: true, shareSessions: "me" });
    const NOT = { error: "not logged in to a hub; run: mesh login" };
    expect(await k.r.local(out, "GET", "/local/debriefs")).toStrictEqual({ status: 409, json: NOT });
    expect(await k.r.local(out, "POST", "/local/revert", { step: "G1.debrief", fingerprint: A })).toStrictEqual({ status: 409, json: NOT });
    // Control: the logged-in daemon answers.
    expect((await k.r.local(k.c.alice, "GET", "/local/debriefs")).status).toBe(200);
  });
});
