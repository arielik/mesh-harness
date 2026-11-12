// RL-3: pulse schedules. Pure: cron parsing, slot times in an IANA time zone (with the DST rules),
// `every` slots from an anchor, durations and the schedule text.

import { durationMs, type PulseWhen } from "../protocol/index.ts";

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

/** Milliseconds of a duration (`30m`, `4h`, `7d`); throws on anything else. */
export function parseDurationSpec(s: string): number {
  const ms = durationMs(s);
  if (ms === undefined) throw new Error(`invalid duration "${s}" (use e.g. 30m, 4h, 7d)`);
  return ms;
}

/** A parsed 5-field cron expression. Day of week 7 is folded to 0 (Sunday). */
export interface Cron {
  minute: Set<number>;
  hour: Set<number>;
  dom: Set<number>;
  month: Set<number>;
  dow: Set<number>;
  /** The field text starts with `*` (unrestricted). */
  domStar: boolean;
  dowStar: boolean;
}

const FIELDS = [
  ["minute", 0, 59],
  ["hour", 0, 23],
  ["day-of-month", 1, 31],
  ["month", 1, 12],
  ["day-of-week", 0, 7],
] as const;

const ITEM_RE = /^(\*|\d+(?:-\d+)?)(?:\/(\d+))?$/;

function parseField(text: string, name: string, min: number, max: number): Set<number> | string {
  const out = new Set<number>();
  const bad = `bad ${name} field "${text}"`;
  for (const item of text.split(",")) {
    const m = ITEM_RE.exec(item);
    if (!m) return bad;
    const range = m[1] as string;
    const stepText = m[2];
    let lo: number;
    let hi: number;
    if (range === "*") {
      lo = min;
      hi = max;
    } else {
      const [a, b] = range.split("-").map(Number) as [number, number | undefined];
      for (const n of b === undefined ? [a] : [a, b]) if (n < min || n > max) return `${name} value ${n} is out of range ${min}-${max}`;
      if (b !== undefined && a > b) return bad;
      lo = a;
      hi = b ?? (stepText !== undefined ? max : a);
    }
    const step = stepText === undefined ? 1 : Number(stepText);
    if (step < 1) return bad;
    for (let n = lo; n <= hi; n += step) out.add(n);
  }
  return out;
}

/** Parse a 5-field cron expression (minute hour day-of-month month day-of-week). */
export function parseCron(expr: string): { ok: true; cron: Cron } | { ok: false; error: string } {
  const parts = expr.trim().split(/\s+/);
  if (parts.length !== 5 || parts[0] === "") return { ok: false, error: "a cron expression has 5 fields (minute hour day-of-month month day-of-week)" };
  const sets: Set<number>[] = [];
  for (let i = 0; i < 5; i++) {
    const [name, min, max] = FIELDS[i] as (typeof FIELDS)[number];
    const r = parseField(parts[i] as string, name, min, max);
    if (typeof r === "string") return { ok: false, error: r };
    sets.push(r);
  }
  const dow = new Set([...(sets[4] as Set<number>)].map((d) => (d === 7 ? 0 : d)));
  return {
    ok: true,
    cron: {
      minute: sets[0] as Set<number>,
      hour: sets[1] as Set<number>,
      dom: sets[2] as Set<number>,
      month: sets[3] as Set<number>,
      dow,
      domStar: (parts[2] as string).startsWith("*"),
      dowStar: (parts[4] as string).startsWith("*"),
    },
  };
}

/** True when `Intl` accepts `tz` as a time zone (e.g. "UTC", "Europe/Berlin"). */
export function validTimeZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

// ---------- wall clock in a time zone ----------

const formats = new Map<string, Intl.DateTimeFormat>();
function format(tz: string): Intl.DateTimeFormat {
  let f = formats.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", { timeZone: tz, hourCycle: "h23", year: "numeric", month: "numeric", day: "numeric", hour: "numeric", minute: "numeric" });
    formats.set(tz, f);
  }
  return f;
}

/** The wall minute of instant `t` in `tz`, as a "local epoch" (`Date.UTC` of the wall fields). */
function wallKey(t: number, tz: string): number {
  const p: Record<string, number> = {};
  for (const part of format(tz).formatToParts(new Date(t))) if (part.type !== "literal") p[part.type] = Number(part.value);
  const hour = p.hour === 24 ? 0 : (p.hour as number);
  return Date.UTC(p.year as number, (p.month as number) - 1, p.day as number, hour, p.minute as number);
}

/** The offset of `tz` at instant `t` (wall minus UTC), in ms. */
function offsetAt(t: number, tz: string): number {
  const m = Math.floor(t / MIN) * MIN;
  return wallKey(m, tz) - m;
}

/**
 * The instant of wall minute `w` (local epoch) in `tz`: the first occurrence when it occurs twice;
 * the first existing wall minute after the gap when it does not exist.
 */
function instantOf(w: number, tz: string): number {
  const before = offsetAt(w - DAY, tz);
  const after = offsetAt(w + DAY, tz);
  const candidates = [...new Set([w - before, w - after])].sort((a, b) => a - b);
  for (const c of candidates) if (wallKey(c, tz) === w) return c;
  // A gap: the transition instant (the first minute with the later offset).
  let lo = candidates[0] as number;
  let hi = candidates[candidates.length - 1] as number;
  if (offsetAt(lo, tz) === after) return lo;
  // invariant: offset at lo != after, offset at hi == after (or hi is the last candidate)
  while (hi - lo > MIN) {
    const mid = lo + Math.floor((hi - lo) / MIN / 2) * MIN;
    if (offsetAt(mid, tz) === after) hi = mid;
    else lo = mid;
  }
  return hi;
}

function cronDayMatches(c: Cron, y: number, mo: number, d: number): boolean {
  if (!c.month.has(mo)) return false;
  const dow = new Date(Date.UTC(y, mo - 1, d)).getUTCDay();
  const domOk = c.dom.has(d);
  const dowOk = c.dow.has(dow);
  if (!c.domStar && !c.dowStar) return domOk || dowOk;
  return domOk && dowOk;
}

const HORIZON_DAYS = 5 * 366 + 2;

function nextCron(c: Cron, tz: string, after: number): number | undefined {
  const start = wallKey(after, tz);
  // Wall minutes more than 3 hours before `after`'s wall time can never map to an instant after it.
  const floor = start - 3 * HOUR;
  const hours = [...c.hour].sort((a, b) => a - b);
  const minutes = [...c.minute].sort((a, b) => a - b);
  let day = Math.floor((start - DAY) / DAY) * DAY;
  for (let i = 0; i < HORIZON_DAYS; i++, day += DAY) {
    const date = new Date(day);
    if (!cronDayMatches(c, date.getUTCFullYear(), date.getUTCMonth() + 1, date.getUTCDate())) continue;
    for (const h of hours) {
      if (day + h * HOUR + 59 * MIN < floor) continue;
      for (const mi of minutes) {
        const w = day + h * HOUR + mi * MIN;
        if (w < floor) continue;
        const t = instantOf(w, tz);
        if (t > after) return t;
      }
    }
  }
  return undefined;
}

/** The first slot instant after `after` (ms), or `undefined` when the schedule never fires again. */
export function nextSlot(when: PulseWhen, after: number): number | undefined {
  if ("every" in when) {
    const p = parseDurationSpec(when.every);
    if (when.anchor > after) return when.anchor;
    return when.anchor + (Math.floor((after - when.anchor) / p) + 1) * p;
  }
  const parsed = parseCron(when.cron);
  if (!parsed.ok) return undefined;
  return nextCron(parsed.cron, when.tz, after);
}

/** The period of a schedule: `every`'s duration; for cron, the gap between the first two slots after `from`. */
export function periodMs(when: PulseWhen, from: number): number | undefined {
  if ("every" in when) return parseDurationSpec(when.every);
  const a = nextSlot(when, from);
  const b = a === undefined ? undefined : nextSlot(when, a);
  return a === undefined || b === undefined ? undefined : b - a;
}

/** `every <duration>` or `cron "<expr>" <tz>`. */
export function scheduleText(when: PulseWhen): string {
  return "every" in when ? `every ${when.every}` : `cron "${when.cron}" ${when.tz}`;
}
