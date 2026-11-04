import { describe, expect, it } from "vitest";
import type { Session, Step } from "../protocol/index.ts";
import { decide, MAX_NUDGES } from "./autopilot.ts";
import { claim, DEFAULT_CLAIM_RULES, finish, pause, pickNext, release, takeOver } from "./claims.ts";
import { allowed, canApprove, normalizeGroups, rolesFor } from "./roles.ts";

const step = (over: Partial<Step> = {}): Step => ({
  id: "G1.a",
  goal: "G1",
  planVersion: 1,
  kind: "implement",
  repo: "frr",
  title: "a",
  brief: "do a",
  deps: [],
  state: "ready",
  fixCycles: 0,
  updatedAt: 0,
  ...over,
});
const alice = { userId: "alice", sid: "s1", machine: "m1" };
const bob = { userId: "bob", sid: "s2" };
const H = DEFAULT_CLAIM_RULES.takeoverAfterMs;

describe("claims", () => {
  it("claims a ready step and lets the holder re-bind from a new session", () => {
    const r = claim(step(), alice, 10);
    expect(r.ok && r.step).toMatchObject({ state: "claimed", holderUser: "alice", holderSid: "s1", holderMachine: "m1", claimedAt: 10 });
    if (!r.ok) return;
    const again = claim(r.step, { userId: "alice", sid: "s9" }, 20);
    expect(again.ok && again.step).toMatchObject({ holderSid: "s9", claimedAt: 10 });
    expect(claim(r.step, bob, 30)).toMatchObject({ ok: false, status: 409 });
  });

  it("refuses blocked or done steps", () => {
    expect(claim(step({ state: "blocked" }), alice, 1)).toMatchObject({ ok: false, error: "G1.a is blocked, not ready" });
    expect(claim(step({ state: "done" }), alice, 1).ok).toBe(false);
  });

  it("re-claims a paused step by its holder", () => {
    const paused = pause(step({ state: "claimed", holderUser: "alice" }), 5);
    expect(paused).toMatchObject({ state: "paused", pausedAt: 5 });
    const r = claim(paused, { userId: "alice", sid: "s3" }, 6);
    expect(r.ok && r.step.pausedAt).toBeUndefined();
  });

  it("releases only by the holder or an admin", () => {
    const held = step({ state: "claimed", holderUser: "alice", holderSid: "s1" });
    expect(release(held, bob, false, 1)).toMatchObject({ ok: false, status: 403 });
    const r = release(held, bob, true, 1);
    expect(r.ok && r.step).toMatchObject({ state: "ready" });
    expect(r.ok && r.step.holderUser).toBeUndefined();
  });

  it("takes over paused/stalled steps after the threshold, or at once when privileged", () => {
    const paused = step({ state: "paused", holderUser: "alice", pausedAt: 0 });
    expect(takeOver(paused, bob, { privileged: false, now: H - 60_000 })).toMatchObject({ ok: false, error: expect.stringMatching(/in 1 min/) });
    expect(takeOver(paused, bob, { privileged: false, now: H + 1 }).ok).toBe(true);
    expect(takeOver(paused, bob, { privileged: true, now: 1 }).ok).toBe(true);
    const active = step({ state: "claimed", holderUser: "alice" });
    expect(takeOver(active, bob, { privileged: false, now: H * 10 })).toMatchObject({ ok: false, error: expect.stringMatching(/actively held/) });
    expect(takeOver(active, bob, { privileged: false, stalledSince: 0, now: H + 1 }).ok).toBe(true);
  });

  it("finishes: done, fail with reopen (back to waiting), fail alone (failed)", () => {
    const held = step({ state: "claimed", holderUser: "alice", holderSid: "s1" });
    expect(finish(held, bob, { summary: "x", outcome: "done" }, false, false, 1)).toMatchObject({ ok: false, status: 403 });
    const done = finish(held, alice, { summary: "ok", outcome: "done", mr: "!88" }, false, false, 2);
    expect(done.ok && done.step).toMatchObject({ state: "done", outcome: "done", summary: "ok", mr: "!88" });
    const back = finish(held, alice, { summary: "test failed", outcome: "fail" }, true, false, 2);
    expect(back.ok && back.step).toMatchObject({ state: "blocked", outcome: "fail" });
    expect(back.ok && back.step.holderUser).toBeUndefined();
    const failed = finish(held, alice, { summary: "cannot", outcome: "fail" }, false, false, 2);
    expect(failed.ok && failed.step.state).toBe("failed");
    expect(finish(step(), alice, { summary: "x", outcome: "done" }, false, false, 1).ok).toBe(false);
  });

  it("picks the next step: a ready direct dependent in the same repo first", () => {
    const finished = step({ id: "G1.a", state: "done" });
    const steps = [
      finished,
      step({ id: "G1.x", state: "ready" }),
      step({ id: "G1.b", state: "ready", deps: ["G1.a"] }),
      step({ id: "G1.c", state: "ready", deps: ["G1.a"], repo: "other" }),
      step({ id: "G2.z", goal: "G2", state: "ready" }),
    ];
    const same = (r: string) => r === "frr";
    expect(pickNext(finished, steps, same)?.id).toBe("G1.b");
    expect(pickNext(finished, steps.filter((s) => s.id !== "G1.b"), same)?.id).toBe("G1.x");
    expect(pickNext(finished, [finished], same)).toBeUndefined();
  });
});

describe("roles", () => {
  it("normalizes Kanidm-style groups", () => {
    expect(normalizeGroups(["Mesh-Approvers@idm.lab", "mesh-admins@idm.lab"], ["strip_domain", "lowercase"])).toEqual(["mesh-approvers", "mesh-admins"]);
  });

  it("maps groups to roles; members by default; bootstrap admins", () => {
    const mapping = { approver: ["mesh-approvers"], admin: ["mesh-admins"], service: ["service"] };
    expect(rolesFor([], mapping)).toEqual(["member"]);
    expect(rolesFor(["mesh-approvers"], mapping)).toEqual(["member", "approver"]);
    expect(rolesFor([], mapping, [], true)).toEqual(["member", "admin"]);
    expect(rolesFor(["service"], mapping)).toEqual(["service"]);
    expect(rolesFor([], mapping, ["approver"])).toEqual(["member", "approver"]);
  });

  it.each([
    ["public", undefined, true],
    ["member", undefined, false],
    ["member", ["member"], true],
    ["member", ["service"], false],
    ["admin", ["member"], false],
    ["admin", ["member", "admin"], true],
    ["events", ["service"], true],
    ["events", ["member"], false],
  ] as const)("allowed(%s, %j) = %s", (rule, roles, expected) => {
    expect(allowed(rule, roles ? { userId: "u", roles } : undefined)).toBe(expected);
  });

  it("lets owners, approvers and admins approve", () => {
    expect(canApprove({ userId: "o", roles: ["member"] }, "o")).toBe(true);
    expect(canApprove({ userId: "x", roles: ["member"] }, "o")).toBe(false);
    expect(canApprove({ userId: "x", roles: ["member", "approver"] }, "o")).toBe(true);
  });
});

describe("autopilot", () => {
  const s = (over: Partial<Session>): Session => ({
    sid: "s",
    claudeSessionIds: [],
    cwd: "/w",
    kind: "interactive",
    state: "stalled",
    quiet: false,
    startedAt: 0,
    lastEventAt: 0,
    turns: 0,
    humanPrompts: 0,
    seenByReconciler: true,
    step: "G1.a",
    ...over,
  });

  it("nudges a stalled session twice, then escalates once", () => {
    expect(decide(s({}), "nudge")).toMatchObject({ kind: "nudge", text: expect.stringContaining("G1.a") });
    expect(decide(s({ nudges: MAX_NUDGES - 1 }), "chain")?.kind).toBe("nudge");
    expect(decide(s({ nudges: MAX_NUDGES }), "nudge")).toEqual({ kind: "escalate" });
    expect(decide(s({ nudges: MAX_NUDGES, escalated: true }), "nudge")).toBeNull();
  });

  it("never acts when off, without a step, or when the session needs the person", () => {
    expect(decide(s({}), "off")).toBeNull();
    expect(decide(s({ step: undefined }), "nudge")).toBeNull();
    expect(decide(s({ state: "needs_you", needs: "question" }), "chain")).toBeNull();
  });
});
