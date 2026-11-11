// MM-3: acceptMatches (AC-02), pickSession (AC-03), offerText and offerLine (AC-04), exported from src/core.

import { describe, expect, it } from "vitest";
import type { Session } from "../protocol/index.ts";
import { age } from "./fleet.ts";
import * as core from "./index.ts";

// The new names are read off the module namespace (they do not exist before MM-3).
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- new exports, read loosely
const C = core as any;
type Offer = { byUser: string; byMachine?: { id: string; userId: string; nickname?: string } };
const acceptMatches = (policy: readonly string[] | undefined, offer: Offer, target: { userId: string }): boolean => C.acceptMatches(policy, offer, target);
const pickSession = (sessions: readonly Session[], want: { repo: string; topics: readonly string[]; sid?: string }): Session | undefined => C.pickSession(sessions, want);
const offerText = (l: Record<string, unknown>): string => C.offerText(l);
const offerLine = (o: Record<string, unknown>, now: number): string => C.offerLine(o, now);

// ---------------------------------------------------------------------------------------------

describe("AC-02 acceptMatches", () => {
  const T = { userId: "alice" };
  const mA2 = { id: "m-0a1b2c3d", userId: "alice", nickname: "m1" };
  const mBob = { id: "m-bbbb0001", userId: "bob", nickname: "m1" };

  it("test_AC02_undefined_false", () => {
    // Positive control: the same offer matches an explicit self policy.
    expect(acceptMatches(["self"], { byUser: "alice" }, T)).toBe(true);
    expect(acceptMatches(undefined, { byUser: "alice" }, T)).toBe(false);
  });

  it("test_AC02_off_false", () => {
    expect(acceptMatches(["self"], { byUser: "alice" }, T)).toBe(true);
    expect(acceptMatches(["off"], { byUser: "alice" }, T)).toBe(false);
  });

  it("test_AC02_self", () => {
    expect(acceptMatches(["self"], { byUser: "alice" }, T)).toBe(true);
    expect(acceptMatches(["self"], { byUser: "bob" }, T)).toBe(false);
  });

  it("test_AC02_user_rule", () => {
    expect(acceptMatches(["user:bob"], { byUser: "bob" }, T)).toBe(true);
    expect(acceptMatches(["user:bob"], { byUser: "carol" }, T)).toBe(false);
    expect(acceptMatches(["user:bob"], { byUser: "alice" }, T)).toBe(false);
  });

  it("test_AC02_machine_id", () => {
    expect(acceptMatches(["machine:m-0a1b2c3d"], { byUser: "alice", byMachine: mA2 }, T)).toBe(true);
    expect(acceptMatches(["machine:m-0a1b2c3d"], { byUser: "alice", byMachine: mBob }, T)).toBe(false);
    expect(acceptMatches(["machine:m-0a1b2c3d"], { byUser: "alice" }, T)).toBe(false);
  });

  it("test_AC02_machine_nickname_own_only", () => {
    expect(acceptMatches(["machine:m1"], { byUser: "bob", byMachine: mA2 }, T)).toBe(true);
    expect(acceptMatches(["machine:m1"], { byUser: "bob", byMachine: mBob }, T)).toBe(false);
  });

  it("test_AC02_any_rule_matches", () => {
    expect(acceptMatches(["user:carol", "self"], { byUser: "alice" }, T)).toBe(true);
    expect(acceptMatches(["user:carol", "user:dave"], { byUser: "alice" }, T)).toBe(false);
  });

  it("test_AC02_machine_id_other_owner", () => {
    expect(acceptMatches(["machine:m-bbbb0001"], { byUser: "bob", byMachine: mBob }, T)).toBe(true);
  });
});

// ---------------------------------------------------------------------------------------------

describe("AC-03 pickSession", () => {
  const R = "example.org/team/svc";
  const X = { id: "example.org/team/other", name: "other" };
  const inR = { id: R, name: "svc" };
  const s = (sid: string, over: Partial<Session> = {}): Session => ({
    sid,
    claudeSessionIds: [`c-${sid}`],
    cwd: `/w/${sid}`,
    kind: "interactive",
    state: "idle",
    quiet: false,
    startedAt: 1,
    lastEventAt: 10,
    turns: 1,
    humanPrompts: 1,
    seenByReconciler: true,
    repo: inR,
    ...over,
  });
  const want = (over: { topics?: string[]; sid?: string } = {}) => ({ repo: R, topics: over.topics ?? [], ...(over.sid ? { sid: over.sid } : {}) });

  it("test_AC03_sid_working_returned", () => {
    const named = s("aaaa1", { state: "working", repo: X });
    expect(pickSession([named], want({ sid: "aaaa1" }))?.sid).toBe("aaaa1");
  });

  it("test_AC03_sid_ended_undefined_no_fallback", () => {
    const list = [s("aaaa1", { state: "ended" }), s("idle1")];
    // Positive control: without the name the idle one is picked.
    expect(pickSession(list, want())?.sid).toBe("idle1");
    expect(pickSession(list, want({ sid: "aaaa1" }))).toBeUndefined();
  });

  it("test_AC03_sid_holds_step_undefined", () => {
    const list = [s("aaaa1", { step: "G1.a" }), s("idle1")];
    expect(pickSession(list, want({ sid: "aaaa1" }))).toBeUndefined();
  });

  it("test_AC03_sid_launching_undefined", () => {
    const list = [s("aaaa1", { launching: true } as Partial<Session>), s("idle1")];
    expect(pickSession(list, want({ sid: "aaaa1" }))).toBeUndefined();
  });

  it("test_AC03_sid_unknown_undefined", () => {
    expect(pickSession([s("idle1")], want({ sid: "nope" }))).toBeUndefined();
  });

  it("test_AC03_filters", () => {
    const list = [
      s("working", { state: "working", lastEventAt: 99 }),
      s("stepped", { step: "G1.a", lastEventAt: 98 }),
      s("launch", { launching: true, lastEventAt: 97 } as Partial<Session>),
      s("other", { repo: X, lastEventAt: 96 }),
      s("ok", { lastEventAt: 1 }),
    ];
    expect(pickSession(list, want())?.sid).toBe("ok");
  });

  it("test_AC03_label_overlap", () => {
    const list = [s("p1", { labels: ["perf"], lastEventAt: 50 }), s("p2", { labels: ["perf", "dataplane"], lastEventAt: 10 })];
    expect(pickSession(list, want({ topics: ["perf", "dataplane"] }))?.sid).toBe("p2");
  });

  it("test_AC03_tie_lastEventAt", () => {
    const list = [s("old", { labels: ["perf"], lastEventAt: 10 }), s("new", { labels: ["perf"], lastEventAt: 20 })];
    expect(pickSession(list, want({ topics: ["perf"] }))?.sid).toBe("new");
  });

  it("test_AC03_tie_sid", () => {
    const list = [s("bxyz"), s("Bxyz"), s("axyz")];
    // Code-point order: "B" (66) < "a" (97) < "b" (98).
    expect(pickSession(list, want())?.sid).toBe("Bxyz");
  });

  it("test_AC03_none", () => {
    expect(pickSession([s("w", { state: "working" })], want())).toBeUndefined();
    expect(pickSession([], want())).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------------------------

describe("AC-04 offerText and offerLine", () => {
  const line = (over: Record<string, unknown>) => ({ to: "m2", state: "offered", by: "alice", at: 1, ...over });

  it("test_AC04_text_offered", () => {
    expect(offerText(line({ to: "m2/perf" }))).toBe("offered to m2/perf by @alice");
  });

  it("test_AC04_text_accepted_with_accepted", () => {
    expect(offerText(line({ to: "m2/perf", state: "accepted", accepted: "m2/perf-bench" }))).toBe("offered to m2/perf → accepted by m2/perf-bench");
  });

  it("test_AC04_text_accepted_without_accepted", () => {
    expect(offerText(line({ state: "accepted" }))).toBe("offered to m2 → accepted by m2");
  });

  it("test_AC04_text_declined", () => {
    expect(offerText(line({ state: "declined" }))).toBe("offered to m2 → declined");
    expect(offerText(line({ state: "declined", note: "busy" }))).toBe("offered to m2 → declined: busy");
  });

  it("test_AC04_text_expired_withdrawn", () => {
    expect(offerText(line({ state: "expired", note: "x" }))).toBe("offered to m2 → expired");
    expect(offerText(line({ state: "withdrawn", note: "x" }))).toBe("offered to m2 → withdrawn");
  });

  const NOW = 5_000_000;
  const view = (over: Record<string, unknown>) => ({
    step: "G1.api",
    goal: "G1",
    title: "API",
    repo: "svc",
    kind: "implement",
    machine: "m-0000000b",
    to: "m2",
    by: "alice",
    at: NOW - 60_000,
    expiresAt: NOW + 30 * 60_000,
    auto: true,
    ...over,
  });

  it("test_AC04_line_auto_no_note", () => {
    expect(offerLine(view({}), NOW)).toBe(`G1.api "API" · svc · from @alice · to m2 · auto · expires in ${age(30 * 60_000)}`);
  });

  it("test_AC04_line_manual_note_empty_repo", () => {
    expect(offerLine(view({ repo: "", auto: false, note: "pls", expiresAt: NOW + 5 * 60_000 }), NOW)).toBe(
      `G1.api "API" · - · from @alice · to m2 · manual · expires in ${age(5 * 60_000)} · pls`,
    );
  });
});
