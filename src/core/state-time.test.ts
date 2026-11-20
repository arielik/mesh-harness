// RL-14 AC-01 (accrual) and AC-04 (sending rules), docs/specs/RL-14.md.

import { describe, expect, it } from "vitest";
import { DAY_MS, type Session } from "../protocol/index.ts";
import { accrue, addInterval, apportion, finalPending, liveDays, selectStateTime, STATE_TIME_EVERY_MS, totals, withHeld, type SentMark } from "./state-time.ts";

const T0 = 1_000 * DAY_MS; // a UTC midnight
const base = (over: Partial<Session> = {}): Session => ({
  sid: "s1",
  claudeSessionIds: [],
  cwd: "/r",
  kind: "interactive",
  state: "working",
  quiet: false,
  startedAt: T0,
  lastEventAt: T0,
  turns: 0,
  humanPrompts: 0,
  seenByReconciler: false,
  step: "G1.a",
  ...over,
});

/** Walk a session through states: each entry is [state, ms spent in it]. */
function walk(start: Session, at: number, path: [Session["state"], number][]): { s: Session; at: number } {
  let s = accrue(undefined, start, at);
  for (const [state, ms] of path) {
    at += ms;
    s = accrue(s, { ...s, state }, at);
  }
  return { s, at };
}

describe("RL-14 AC-01 accrue", () => {
  it("test_AC01_buckets", () => {
    const { s } = walk(base({ state: "working" }), T0 + 1000, [
      ["needs_you", 10_000],
      ["idle", 20_000],
      ["stalled", 5_000],
      ["working", 7_000],
    ]);
    expect(totals(s.stateTime?.steps["G1.a"] ?? [])).toStrictEqual({ workingMs: 10_000, needsYouMs: 20_000, idleMs: 5_000, stalledMs: 7_000 });
  });

  it("test_AC01_midnight_split", () => {
    const s0 = accrue(undefined, base(), T0 + DAY_MS - 1000);
    const s1 = accrue(s0, { ...s0, state: "idle" }, T0 + DAY_MS + 3000);
    expect(s1.stateTime?.steps["G1.a"]).toStrictEqual([
      { day: T0, workingMs: 1000, needsYouMs: 0, idleMs: 0, stalledMs: 0 },
      { day: T0 + DAY_MS, workingMs: 3000, needsYouMs: 0, idleMs: 0, stalledMs: 0 },
    ]);
  });

  it("test_AC01_no_step_ended_placeholder", () => {
    for (const over of [{ step: undefined }, { state: "ended" as const }, { launching: true }]) {
      const b = base(over);
      if (over.step === undefined && "step" in over) delete b.step;
      const s0 = accrue(undefined, b, T0);
      const s1 = accrue(s0, { ...s0 }, T0 + 60_000);
      expect(Object.values(s1.stateTime?.steps ?? {}).flat(), JSON.stringify(over)).toStrictEqual([]);
    }
  });

  it("test_AC01_step_change", () => {
    const s0 = accrue(undefined, base(), T0);
    const s1 = accrue(s0, { ...s0, step: "G1.b" }, T0 + 4000);
    const s2 = accrue(s1, { ...s1 }, T0 + 10_000);
    expect(totals(s2.stateTime?.steps["G1.a"] ?? []).workingMs).toBe(4000);
    expect(totals(s2.stateTime?.steps["G1.b"] ?? []).workingMs).toBe(6000);
  });

  it("test_AC01_clock_back_and_clamp", () => {
    const s0 = accrue(undefined, base(), T0 + 10_000);
    const back = accrue(s0, { ...s0 }, T0 + 5_000);
    expect(back.stateTime?.steps["G1.a"]).toStrictEqual([]);
    // A day never holds more than DAY_MS.
    const full = addInterval([{ day: T0, workingMs: DAY_MS - 10, needsYouMs: 0, idleMs: 0, stalledMs: 0 }], "idle", T0, T0 + 1000);
    expect(full[0]?.idleMs).toBe(10);
  });

  it("test_AC01_state_since", () => {
    const s0 = accrue(undefined, base(), T0);
    expect(s0.stateSince).toBe(T0);
    const s1 = accrue(s0, { ...s0, turns: 1 }, T0 + 5);
    expect(s1.stateSince).toBe(T0);
    const s2 = accrue(s1, { ...s1, state: "needs_you" }, T0 + 9);
    expect(s2.stateSince).toBe(T0 + 9);
    // A record from before the upgrade, already in its state: stays unset.
    const old = base({ state: "needs_you" });
    expect(accrue(old, { ...old }, T0).stateSince).toBeUndefined();
  });

  it("test_AC01_apportion", () => {
    const days = [{ day: T0, workingMs: 1000, needsYouMs: 2000, idleMs: 0, stalledMs: 0 }];
    // Whole day inside: all of it; half the day's span: half.
    expect(apportion(days, T0 + DAY_MS * 2, T0, T0 + DAY_MS)).toMatchObject({ workingMs: 1000, needsYouMs: 2000, any: true });
    expect(apportion(days, T0 + DAY_MS * 2, T0 + DAY_MS / 2, T0 + DAY_MS)).toMatchObject({ workingMs: 500, needsYouMs: 1000 });
    // The current day is cut at asOf: [T0, T0 + 1h) is the whole span.
    expect(apportion(days, T0 + 3_600_000, T0 + 1_800_000, T0 + DAY_MS)).toMatchObject({ workingMs: 500 });
    expect(apportion(days, T0 + DAY_MS, T0 + DAY_MS, T0 + 2 * DAY_MS).any).toBe(false);
  });
});

describe("RL-14 AC-04 sending rules", () => {
  const mark = (e: ReturnType<typeof selectStateTime>) => new Map<string, SentMark>(e.marks);

  it("test_AC04_select_rules", () => {
    let s = accrue(undefined, base(), T0);
    // A just-claimed step with nothing accrued yet: nothing to send.
    expect(selectStateTime([s], T0, new Map()).entries).toStrictEqual([]);
    const first = selectStateTime([s], T0 + 1000, new Map());
    expect(first.entries).toHaveLength(1);
    const memo = mark(first);
    // Open: not again before 60 s, again after.
    expect(selectStateTime([s], T0 + 30_000, memo).entries).toHaveLength(0);
    expect(selectStateTime([s], T0 + 1000 + STATE_TIME_EVERY_MS, memo).entries).toHaveLength(1);
    // A state change: at once.
    s = accrue(s, { ...s, state: "needs_you" }, T0 + 2000);
    expect(selectStateTime([s], T0 + 3000, memo).entries).toHaveLength(1);
    // Closed (step released): once, then not again.
    s = accrue(s, { ...s, step: undefined } as Session, T0 + 4000);
    delete s.step;
    const closed = selectStateTime([s], T0 + 5000, memo);
    expect(closed.entries).toHaveLength(1);
    expect(totals(closed.entries[0]?.days ?? [])).toStrictEqual({ workingMs: 2000, needsYouMs: 2000, idleMs: 0, stalledMs: 0 });
    const memo2 = new Map([...memo, ...closed.marks]);
    expect(selectStateTime([s], T0 + 500_000, memo2).entries).toHaveLength(0);
  });

  it("test_AC04_cap_and_order", () => {
    const sessions: Session[] = [];
    for (let i = 0; i < 4; i++) {
      let s = accrue(undefined, base({ sid: `s${i}`, step: `G1.s${i}` }), T0);
      s = accrue(s, { ...s }, T0 + 1000);
      if (i % 2 === 0) {
        s = accrue(s, { ...s }, T0 + 1000);
        delete s.step;
      }
      sessions.push(s);
    }
    const r = selectStateTime(sessions, T0 + 2000, new Map(), 3);
    expect(r.entries.map((e) => e.sid)).toStrictEqual(["s1", "s3", "s0"]);
  });

  it("test_AC04_final_pending", () => {
    let s = accrue(undefined, base(), T0);
    s = accrue(s, { ...s, state: "ended" }, T0 + 1000);
    expect(finalPending(s, new Map())).toBe(true);
    const r = selectStateTime([s], T0 + 2000, new Map());
    expect(finalPending(s, new Map(r.marks))).toBe(false);
  });

  it("test_AC04_not_held_mark", () => {
    let s = accrue(undefined, base(), T0);
    // Marked at T0 + 1000: the second before counts as held, nothing after.
    s = accrue(s, withHeld(s, false), T0 + 1000);
    expect(liveDays(s, "G1.a", T0 + 99_000)).toStrictEqual([{ day: T0, workingMs: 1000, needsYouMs: 0, idleMs: 0, stalledMs: 0 }]);
    // Unmarked at T0 + 50 000: nothing for the gap, accrual restarts there.
    s = accrue(s, withHeld(s, true), T0 + 50_000);
    expect(totals(liveDays(s, "G1.a", T0 + 51_000)).workingMs).toBe(2000);
    // A mark for another step is dropped when the session moves on.
    const m = accrue(s, withHeld(s, false), T0 + 52_000);
    expect(accrue(m, { ...m, step: "G1.b" }, T0 + 53_000).stateTime?.notHeld).toBeUndefined();
  });
});
