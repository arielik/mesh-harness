// RL-22 AC-14: GET /v1/questions?state=open lists the unanswered questions a caller may see, oldest
// first. Written from docs/specs/RL-22.md (§Open questions). Questions by id.

import { afterEach, describe, expect, it } from "vitest";
import { Ak, HOUR, NOW } from "./helpers/attention-kit.ts";

let k: Ak;
afterEach(async () => {
  await k?.stop();
});

describe("RL-22 AC-14 open questions", () => {
  it("test_AC14_list", async () => {
    k = await Ak.start(NOW - 3 * HOUR);
    const G = await k.goal("ann", [{ id: "a" }]);
    await k.hold(`${G}.a`, "bob", "s-bob");
    await k.session("bob", "s-bob", { step: `${G}.a` });
    k.w.clock = NOW - 2 * HOUR;
    const q1 = await k.ask("bob", "which branch?", { sid: "s-bob", step: `${G}.a` });
    k.w.clock = NOW - HOUR;
    const q2 = await k.ask("ann", "lunch?", { sid: "s-ann" });
    const q3 = await k.ask("ann", "answered?");
    expect((await k.call("ann", "POST", `/v1/questions/${q3}/answer`, { text: "yes" })).status).toBe(200);
    k.w.clock = NOW;

    const all = await k.w.call(k.reader, "GET", "/v1/questions?state=open");
    expect(all.status, JSON.stringify(all.json)).toBe(200);
    expect(all.json).toStrictEqual({
      truncated: false,
      questions: [
        { id: q1, goal: G, step: `${G}.a`, repo: "svc", sid: "s-bob", fromUser: "bob", toUsers: ["bob", "ann"], text: "which branch?", at: NOW - 2 * HOUR },
        { id: q2, sid: "s-ann", fromUser: "ann", toUsers: ["ann"], text: "lunch?", at: NOW - HOUR },
      ],
    });
    expect((await k.call("root", "GET", "/v1/questions?state=open")).json.questions.map((q: { id: number }) => q.id)).toStrictEqual([q1, q2]);
    expect((await k.call("bob", "GET", "/v1/questions?state=open")).json.questions.map((q: { id: number }) => q.id)).toStrictEqual([q1]);
    const lim = (await k.w.call(k.reader, "GET", "/v1/questions?state=open&limit=1")).json;
    expect([lim.truncated, lim.questions.length]).toStrictEqual([true, 1]);
    for (const q of ["", "?state=answered", "?state=open&limit=0"]) {
      const r = await k.w.call(k.reader, "GET", `/v1/questions${q}`);
      expect([r.status, r.json.code], q).toStrictEqual([400, "bad-query"]);
    }
    expect(await k.as("ann", "GET", "/v1/questions?state=open", undefined, k.reader)).toMatchObject({ status: 400, json: { code: "on-behalf-of-not-accepted" } });
  });
});
