// RL-3 AC-02 and AC-03: cron parsing, `nextSlot` with IANA time zones and the DST rules, `every`
// slots, periods, schedule text and durations (docs/specs/RL-3.md, Core). Expected instants are the
// spec's vectors, written out by hand.

import { describe, expect, it } from "vitest";
import { nextSlot, parseCron, parseDurationSpec, periodMs, scheduleText, validTimeZone } from "./schedule.ts";

const MIN = 60_000;
const HOUR = 3_600_000;
const DAY = 86_400_000;
const T0 = Date.UTC(2026, 10, 16, 9); // 2026-11-16T09:00:00Z, a Monday
const iso = (ms: number | undefined) => (ms === undefined ? undefined : new Date(ms).toISOString());
const at = (s: string) => Date.parse(s);
const cron = (expr: string, tz: string) => ({ cron: expr, tz });
/** `n` successive slots after `from`. */
function chain(when: Parameters<typeof nextSlot>[0], from: number, n: number): (string | undefined)[] {
  const out: (string | undefined)[] = [];
  let t: number | undefined = from;
  for (let i = 0; i < n && t !== undefined; i++) {
    t = nextSlot(when, t);
    out.push(iso(t));
  }
  return out;
}

const FIELDS = "a cron expression has 5 fields (minute hour day-of-month month day-of-week)";

describe("AC-02 cron", () => {
  const errors: [string, string][] = [
    ["* * * *", FIELDS],
    ["* * * * * *", FIELDS],
    ["61 * * * *", "minute value 61 is out of range 0-59"],
    ["* * * 13 *", "month value 13 is out of range 1-12"],
    ["a * * * *", 'bad minute field "a"'],
    ["5-3 * * * *", 'bad minute field "5-3"'],
    ["* 24 * * *", "hour value 24 is out of range 0-23"],
    ["* * 0 * *", "day-of-month value 0 is out of range 1-31"],
    ["* * * * 8", "day-of-week value 8 is out of range 0-7"],
    ["*/0 * * * *", 'bad minute field "*/0"'],
    ["MON * * * *", 'bad minute field "MON"'],
    ["? * * * *", 'bad minute field "?"'],
  ];
  it.each(errors)("test_AC02_cron_errors %s", (expr, error) => {
    expect(parseCron(expr)).toStrictEqual({ ok: false, error });
  });

  it("test_AC02_cron_accepts", () => {
    for (const e of ["0,15,30,45 * * * *", "0 9-17 * * 1-5", "*/15 * * * *", "5/20 * * * *", "0 0 * * 7", "  0  9 * * 1 "]) expect(parseCron(e).ok, e).toBe(true);
  });

  it("test_AC02_n_slash_s", () => {
    expect(chain(cron("5/20 * * * *", "UTC"), at("2026-11-12T00:00:00Z"), 3)).toStrictEqual(["2026-11-12T00:05:00.000Z", "2026-11-12T00:25:00.000Z", "2026-11-12T00:45:00.000Z"]);
  });

  const vectors: [string, string, string, string, string][] = [
    ["0 9 * * 1", "America/New_York", "2026-11-12T00:00:00Z", "2026-11-16T14:00:00.000Z", "weekly"],
    ["30 2 * * *", "Europe/Berlin", "2026-03-28T12:00:00Z", "2026-03-29T01:00:00.000Z", "gap"],
    ["30 2 * * *", "Europe/Berlin", "2026-10-24T12:00:00Z", "2026-10-25T00:30:00.000Z", "overlap first"],
    ["30 2 * * *", "Europe/Berlin", "2026-10-25T00:30:00Z", "2026-10-26T01:30:00.000Z", "overlap once"],
    ["*/30 * * * *", "Europe/Berlin", "2026-10-25T00:30:00Z", "2026-10-25T02:00:00.000Z", "*/30 overlap"],
    ["*/30 * * * *", "Europe/Berlin", "2026-03-29T00:30:00Z", "2026-03-29T01:00:00.000Z", "*/30 gap"],
    ["*/30 * * * *", "Europe/Berlin", "2026-03-29T01:00:00Z", "2026-03-29T01:30:00.000Z", "*/30 gap, next"],
    ["0 0 1 * 1", "UTC", "2026-11-12T00:00:00Z", "2026-11-16T00:00:00.000Z", "day OR"],
    ["0 12 * * 7", "UTC", "2026-11-12T00:00:00Z", "2026-11-15T12:00:00.000Z", "dow 7"],
  ];
  it.each(vectors)("test_AC02_vectors %s %s after %s", (expr, tz, after, want) => {
    expect(iso(nextSlot(cron(expr, tz), at(after)))).toBe(want);
  });

  it("test_AC02_overlap_no_double", () => {
    expect(chain(cron("*/30 * * * *", "Europe/Berlin"), at("2026-10-24T23:50:00Z"), 6)).toStrictEqual([
      "2026-10-25T00:00:00.000Z",
      "2026-10-25T00:30:00.000Z",
      "2026-10-25T02:00:00.000Z",
      "2026-10-25T02:30:00.000Z",
      "2026-10-25T03:00:00.000Z",
      "2026-10-25T03:30:00.000Z",
    ]);
  });

  it("test_AC02_gap_no_missing", () => {
    expect(chain(cron("30 2 * * *", "Europe/Berlin"), at("2026-03-28T12:00:00Z"), 2)).toStrictEqual(["2026-03-29T01:00:00.000Z", "2026-03-30T00:30:00.000Z"]);
  });

  it("test_AC02_gap_coincide", () => {
    // 02:00 and 02:30 do not exist on 2026-03-29 in Berlin: both map to 03:00 CEST, which is a slot too: one slot.
    expect(chain(cron("0,30 2,3 * * *", "Europe/Berlin"), at("2026-03-28T12:00:00Z"), 3)).toStrictEqual(["2026-03-29T01:00:00.000Z", "2026-03-29T01:30:00.000Z", "2026-03-30T00:00:00.000Z"]);
  });

  it("test_AC02_never", { timeout: 2_000 }, () => {
    expect(nextSlot(cron("0 0 31 2 *", "UTC"), 0)).toBeUndefined();
    expect(nextSlot(cron("0 0 30 2 *", "UTC"), 0)).toBeUndefined();
    // Positive control: a date that exists fires.
    expect(iso(nextSlot(cron("0 0 28 2 *", "UTC"), at("2026-11-12T00:00:00Z")))).toBe("2027-02-28T00:00:00.000Z");
  });

  it("test_AC02_tz", () => {
    expect(["Mars/Base", "", "UTC", "Europe/Berlin", "America/New_York"].map(validTimeZone)).toStrictEqual([false, false, true, true, true]);
  });

  it("test_AC02_strictly_after", () => {
    expect(iso(nextSlot(cron("0 9 * * 1", "America/New_York"), at("2026-11-16T14:00:00Z")))).toBe("2026-11-23T14:00:00.000Z");
  });
});

describe("AC-03 every", () => {
  const A = T0;
  const W = { every: "7d", anchor: A };

  it("test_AC03_every_next", () => {
    expect(nextSlot(W, A)).toBe(A + 7 * DAY);
    expect(nextSlot(W, A - 1)).toBe(A);
    expect(nextSlot(W, A + 10 * DAY)).toBe(A + 14 * DAY);
    expect(nextSlot(W, A + 7 * DAY)).toBe(A + 14 * DAY);
    expect(nextSlot(W, A + 7 * DAY - 1)).toBe(A + 7 * DAY);
  });

  it("test_AC03_future_anchor", () => {
    expect(nextSlot({ every: "7d", anchor: A + 30 * DAY }, A)).toBe(A + 30 * DAY);
  });

  it("test_AC03_periodMs", () => {
    expect(periodMs(cron("0 9 * * 1", "UTC"), at("2026-11-12T00:00:00Z"))).toBe(7 * DAY);
    expect(periodMs({ every: "4h", anchor: 0 }, 0)).toBe(4 * HOUR);
    expect(periodMs(cron("0 9 * * 1-5", "UTC"), at("2026-11-13T10:00:00Z"))).toBe(DAY);
    expect(periodMs(cron("0 0 31 2 *", "UTC"), 0)).toBeUndefined();
  });

  it("test_AC03_scheduleText", () => {
    expect(scheduleText({ every: "7d", anchor: 5 })).toBe("every 7d");
    expect(scheduleText(cron("0 9 * * 1", "Europe/Berlin"))).toBe('cron "0 9 * * 1" Europe/Berlin');
  });

  it("test_AC03_durations", () => {
    expect(parseDurationSpec("4h")).toBe(14_400_000);
    expect(parseDurationSpec("30m")).toBe(30 * MIN);
    expect(parseDurationSpec("7d")).toBe(604_800_000);
    expect(parseDurationSpec("999999m")).toBe(59_999_940_000);
    for (const bad of ["4w", "0h", "1000000m", "4H", " 4h"]) expect(() => parseDurationSpec(bad), bad).toThrow(new Error(`invalid duration "${bad}" (use e.g. 30m, 4h, 7d)`));
  });
});
