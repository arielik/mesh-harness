// RL-3 AC-01: protocol schemas of pulses, slots, ingest and `Goal.profiles` (docs/specs/RL-3.md,
// Types). Written from the spec's contracts only.

import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { Goal, GoalFromPreset, PulseCreate, PulseId, PulseSlot, PulseUpdate, SlotReason, SlotState } from "./index.ts";

const sha = (s: string) => createHash("sha256").update(s, "utf8").digest("hex");
const snap = (name: string, text: string, source?: { repo: string; commit: string }) => ({ name, text, sha256: sha(text), ...(source ? { source } : {}) });
const MIN_BODY = { preset: snap("p", "x\n"), params: { repo: "r" }, when: { every: "7d" } };
const DURATION_TEXT = "a duration is a number and m, h or d, e.g. 30m, 4h, 7d";

/** The zod issue messages of a failed parse (empty when it parsed). */
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- any zod schema
const messages = (schema: any, v: unknown): string[] => {
  const r = schema.safeParse(v);
  return r.success ? [] : (r.error.issues as { message: string }[]).map((i) => i.message);
};

describe("AC-01 schemas", () => {
  it("test_AC01_create_minimal_defaults", () => {
    const p = PulseCreate.parse(MIN_BODY);
    expect(p.overlap).toBe("skip");
    expect(p.missed).toBe("record");
    expect(p.enabled).toBe(true);
    expect(p.target).toStrictEqual({});
    for (const k of ["window", "maxGoalAge", "title", "topics"]) expect(Object.hasOwn(p, k), k).toBe(false);
  });

  it("test_AC01_when_forms", () => {
    expect(PulseCreate.parse({ ...MIN_BODY, when: { cron: "0 9 * * 1", tz: "UTC" } }).when).toStrictEqual({ cron: "0 9 * * 1", tz: "UTC" });
    expect(PulseCreate.parse({ ...MIN_BODY, when: { every: "30m", at: 0 } }).when).toStrictEqual({ every: "30m", at: 0 });
    expect(PulseCreate.safeParse({ ...MIN_BODY, when: { every: "366d" } }).success).toBe(true);
    expect(PulseCreate.safeParse({ ...MIN_BODY, when: { every: "5m" } }).success).toBe(true);
  });

  const params21 = Object.fromEntries(Array.from({ length: 21 }, (_, i) => [`k${i}`, "v"]));
  const rejects: [string, Record<string, unknown>, string | undefined][] = [
    ["every 7w", { when: { every: "7w" } }, undefined],
    ["every 1m", { when: { every: "1m" } }, "every is 5m to 366d"],
    ["every 367d", { when: { every: "367d" } }, "every is 5m to 366d"],
    ["window 0h", { window: "0h" }, DURATION_TEXT],
    ["window 31d", { window: "31d" }, "window is 1m to 30d"],
    ["maxGoalAge 30m", { maxGoalAge: "30m" }, "maxGoalAge is 1h to 366d"],
    ["maxGoalAge 367d", { maxGoalAge: "367d" }, "maxGoalAge is 1h to 366d"],
    ["sha256 of 63 chars", { preset: { ...snap("p", "x\n"), sha256: "a".repeat(63) } }, undefined],
    ["sha256 upper case", { preset: { ...snap("p", "x\n"), sha256: sha("x\n").toUpperCase() } }, undefined],
    ["params key Repo", { params: { repo: "r", Repo: "x" } }, undefined],
    ["21 params", { params: { ...params21 } }, undefined],
    ["param value of 301 chars", { params: { repo: "r", v: "x".repeat(301) } }, undefined],
    ["unknown key", { foo: 1 }, undefined],
    ["mixed when", { when: { cron: "* * * * *", tz: "UTC", every: "1d" } }, undefined],
    ["stored when form", { when: { every: "1d", anchor: 0 } }, undefined],
    ["overlap queue", { overlap: "queue" }, undefined],
    ["21 target labels", { target: { labels: Array.from({ length: 21 }, (_, i) => `l${i}`) } }, undefined],
  ];
  it.each(rejects)("test_AC01_create_rejects %s", (_name, over, msg) => {
    const body = { ...MIN_BODY, ...over };
    expect(PulseCreate.safeParse(body).success).toBe(false);
    if (msg) expect(messages(PulseCreate, body)).toContain(msg);
  });

  it("test_AC01_create_boundaries", () => {
    const params20 = Object.fromEntries([["repo", "r"], ...Array.from({ length: 19 }, (_, i) => [`k${i}`, "v"])]);
    const ok = (over: Record<string, unknown>) => expect(PulseCreate.safeParse({ ...MIN_BODY, ...over }).success, JSON.stringify(over).slice(0, 80)).toBe(true);
    ok({ window: "1m" });
    ok({ window: "30d" });
    ok({ maxGoalAge: "1h" });
    ok({ maxGoalAge: "366d" });
    ok({ params: params20 });
    ok({ params: { repo: "r", v: "x".repeat(300) } });
    ok({ preset: snap(`a${"b".repeat(59)}`, "x\n") });
    ok({ preset: snap("p", "y".repeat(20000)) });
  });

  it("test_AC01_update", () => {
    expect(PulseUpdate.safeParse({}).success).toBe(false);
    expect(messages(PulseUpdate, {})).toContain("give at least one field to change");
    expect(PulseUpdate.parse({ window: "2h" })).toMatchObject({ window: "2h" });
    expect(PulseUpdate.safeParse({ enabled: false }).success).toBe(false);
    expect(messages(PulseUpdate, { when: { every: "1m" } })).toContain("every is 5m to 366d");
  });

  it("test_AC01_slot_ids", () => {
    const base = { pulse: "p-1", at: 1, state: "fired", decidedAt: 1 };
    const ok = PulseSlot.parse({ ...base, slot: `manual:${"0123456789ABCDEFGHJKMNPQRS"}` });
    expect(ok.tried).toStrictEqual([]);
    expect(PulseSlot.safeParse({ ...base, slot: "manual:x" }).success).toBe(false);
    expect(PulseSlot.safeParse({ ...base, slot: `manual:${"0".repeat(25)}` }).success).toBe(false);
    for (const bad of ["I", "L", "O", "U"]) expect(PulseSlot.safeParse({ ...base, slot: `manual:${bad}${"0".repeat(25)}` }).success, bad).toBe(false);
    // A scheduled slot id (the ISO of its time) parses.
    expect(PulseSlot.safeParse({ ...base, slot: new Date(1).toISOString() }).success).toBe(true);
  });

  it("test_AC01_enums", () => {
    for (const s of ["fired", "skipped", "missed", "abandoned"]) expect(SlotState.safeParse(s).success, s).toBe(true);
    expect(SlotState.safeParse("done").success).toBe(false);
    for (const s of ["overlap", "no_machine", "not_accepted", "capacity", "expired", "hub_down", "max_goal_age", "error"]) expect(SlotReason.safeParse(s).success, s).toBe(true);
    expect(SlotReason.safeParse("timeout").success).toBe(false);
  });

  it("test_AC01_goal_profiles", () => {
    const g = { id: "G1", title: "t", ownerId: "ann", state: "in_progress", priority: 3, createdAt: 1, updatedAt: 1 };
    const parsed = Goal.parse(g);
    expect(Object.hasOwn(parsed, "profiles")).toBe(false);
    const profiles = { "read-only": { name: "read-only", base: "read-only", sha256: "a".repeat(64), settings: { permissions: { allow: ["Read"], deny: [] } } } };
    expect(Goal.parse({ ...g, profiles }).profiles).toStrictEqual(profiles);
  });

  it("test_AC01_goal_from_preset", () => {
    const body = { preset: snap("p", "x\n"), params: { repo: "r" } };
    expect(GoalFromPreset.parse(body).priority).toBe(3);
    expect(GoalFromPreset.safeParse({ ...body, preset: snap("p", "x\n", { repo: "r", commit: "c" }) }).success).toBe(false);
    expect(GoalFromPreset.safeParse({ ...body, priority: 10 }).success).toBe(false);
    expect(GoalFromPreset.safeParse({ ...body, foo: 1 }).success).toBe(false);
  });

  it("test_AC01_pulse_id", () => {
    for (const ok of ["p-1", "p-10"]) expect(PulseId.safeParse(ok).success, ok).toBe(true);
    for (const bad of ["p-0", "p-01", "p1"]) expect(PulseId.safeParse(bad).success, bad).toBe(false);
  });
});
