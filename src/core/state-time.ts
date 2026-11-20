// RL-14: milliseconds per session state, per session and step, per UTC day. Pure: callers pass the
// clock. The daemon closes a session's open interval on every change (`accrue`) and reports
// absolute totals (`liveDays`), so the hub can keep the newest report and never add twice.

import { DAY_MS, type Session, type SessionState, type StateDay } from "../protocol/index.ts";

/** States that accrue time (`ended` never does). */
export type TimedState = Exclude<SessionState, "ended">;
const FIELD: Record<TimedState, "workingMs" | "needsYouMs" | "idleMs" | "stalledMs"> = {
  working: "workingMs",
  needs_you: "needsYouMs",
  idle: "idleMs",
  stalled: "stalledMs",
};

/** Days a step keeps, and steps a session keeps (the newest by last day). */
export const MAX_DAYS = 400;
export const MAX_STEPS = 50;

export const heldKey = (sid: string, step: string): string => `${sid}\n${step}`;

/** The step `s` accrues to now, or undefined (a step the hub said `s` does not hold never accrues). */
export function accruingStep(s: Session): string | undefined {
  if (s.step === undefined || s.state === "ended" || s.launching === true) return undefined;
  if (s.stateTime?.notHeld?.includes(s.step)) return undefined;
  return s.step;
}

const dayOf = (t: number): number => Math.floor(t / DAY_MS) * DAY_MS;
const sum = (d: StateDay): number => d.workingMs + d.needsYouMs + d.idleMs + d.stalledMs;

/** `days` plus `[from, to)` in `state`'s bucket, split at UTC midnights; each day clamped to `DAY_MS`. */
export function addInterval(days: readonly StateDay[], state: TimedState, from: number, to: number): StateDay[] {
  const out = days.map((d) => ({ ...d }));
  if (!(to > from)) return out;
  const f = FIELD[state];
  for (let t = from; t < to; ) {
    const day = dayOf(t);
    const end = Math.min(to, day + DAY_MS);
    let d = out.find((x) => x.day === day);
    if (!d) {
      d = { day, workingMs: 0, needsYouMs: 0, idleMs: 0, stalledMs: 0 };
      out.push(d);
    }
    d[f] += Math.min(end - t, Math.max(0, DAY_MS - sum(d)));
    t = end;
  }
  out.sort((a, b) => a.day - b.day);
  return out.slice(-MAX_DAYS);
}

/**
 * Close `prev`'s open interval into `next` (the record that replaces it) at `now`. `next` keeps
 * every other field; `stateTime.since` becomes `now` and `stateSince` follows the state.
 */
export function accrue(prev: Session | undefined, next: Session, now: number): Session {
  const steps: Record<string, StateDay[]> = { ...(prev?.stateTime?.steps ?? next.stateTime?.steps ?? {}) };
  const step = prev?.stateTime ? accruingStep(prev) : undefined;
  if (prev?.stateTime && step !== undefined && prev.state !== "ended") {
    steps[step] = addInterval(steps[step] ?? [], prev.state, prev.stateTime.since, now);
  }
  // A mark only ever names the current step: a session that moved on starts unmarked.
  const notHeld = next.stateTime?.notHeld?.filter((x) => x === next.step);
  const marks = notHeld?.length ? { notHeld } : {};
  const nextStep = accruingStep({ ...next, stateTime: { since: now, steps, ...marks } });
  if (nextStep !== undefined) steps[nextStep] ??= [];
  const out: Session = { ...next, stateTime: { since: now, steps: trimSteps(steps), ...marks } };
  if (!prev || prev.state !== next.state) out.stateSince = now;
  else if (prev.stateSince !== undefined) out.stateSince = prev.stateSince;
  else delete out.stateSince;
  return out;
}

function trimSteps(steps: Record<string, StateDay[]>): Record<string, StateDay[]> {
  const ids = Object.keys(steps);
  if (ids.length <= MAX_STEPS) return steps;
  // A step with no day yet counts as the newest.
  const last = (id: string) => steps[id]?.at(-1)?.day ?? Number.MAX_SAFE_INTEGER;
  const keep = ids.sort((a, b) => last(b) - last(a)).slice(0, MAX_STEPS);
  return Object.fromEntries(keep.map((id) => [id, steps[id] as StateDay[]]));
}

/** `s`'s absolute totals for `step` at `now`: closed days plus the open interval when it accrues there. */
export function liveDays(s: Session, step: string, now: number): StateDay[] {
  const closed = s.stateTime?.steps[step] ?? [];
  if (!s.stateTime || accruingStep(s) !== step || s.state === "ended") return closed.map((d) => ({ ...d }));
  return addInterval(closed, s.state, s.stateTime.since, now);
}

/** Whether `s` accrues to `step` now (its entry is open). */
export function isOpen(s: Session, step: string): boolean {
  return s.stateTime !== undefined && accruingStep(s) === step;
}

/** A `StateTime` from days: the sums per state. */
export function totals(days: readonly StateDay[]): { workingMs: number; needsYouMs: number; idleMs: number; stalledMs: number } {
  const t = { workingMs: 0, needsYouMs: 0, idleMs: 0, stalledMs: 0 };
  for (const d of days) {
    t.workingMs += d.workingMs;
    t.needsYouMs += d.needsYouMs;
    t.idleMs += d.idleMs;
    t.stalledMs += d.stalledMs;
  }
  return t;
}

/**
 * Days apportioned to the window `[since, until)`: a day's time happened in `[day, min(day + D,
 * asOf))` and counts in proportion to the part of that span inside the window (rounded per field).
 */
export function apportion(days: readonly StateDay[], asOf: number, since: number, until: number): { workingMs: number; needsYouMs: number; idleMs: number; stalledMs: number; any: boolean } {
  const t = { workingMs: 0, needsYouMs: 0, idleMs: 0, stalledMs: 0, any: false };
  for (const d of days) {
    const e = Math.min(d.day + DAY_MS, asOf);
    let f: number;
    if (e <= d.day) f = d.day >= since && d.day < until ? 1 : 0;
    else f = Math.max(0, Math.min(e, until) - Math.max(d.day, since)) / (e - d.day);
    if (f <= 0) continue;
    t.any = true;
    t.workingMs += Math.round(d.workingMs * f);
    t.needsYouMs += Math.round(d.needsYouMs * f);
    t.idleMs += Math.round(d.idleMs * f);
    t.stalledMs += Math.round(d.stalledMs * f);
  }
  return t;
}

/** What the hub last accepted for a `(sid, step)` key (RL-14 sending rules). */
export interface SentMark {
  open: boolean;
  state: string;
  asOf: number;
  days: string;
}

export interface StateTimeEntry {
  sid: string;
  step: string;
  asOf: number;
  days: StateDay[];
}

/** Resend an open entry at least this often (and on every state or open/closed change). */
export const STATE_TIME_EVERY_MS = 60_000;
export const STATE_TIME_MAX = 500;

/**
 * The state time entries a sync carries, and the marks to remember once the hub accepted them:
 * keys never accepted, keys whose open/closed status or session state changed, open keys last
 * accepted `STATE_TIME_EVERY_MS` ago or more, closed keys whose days changed. Open ones first.
 */
export function selectStateTime(
  sessions: readonly Session[],
  now: number,
  memo: ReadonlyMap<string, SentMark>,
  max = STATE_TIME_MAX,
): { entries: StateTimeEntry[]; marks: [string, SentMark][] } {
  const picked: { open: boolean; e: StateTimeEntry; mark: SentMark; key: string }[] = [];
  for (const s of sessions) {
    if (!s.stateTime) continue;
    for (const step of Object.keys(s.stateTime.steps)) {
      const days = liveDays(s, step, now);
      if (!days.length) continue;
      const open = isOpen(s, step);
      const key = heldKey(s.sid, step);
      const json = JSON.stringify(days);
      const m = memo.get(key);
      const due = !m || m.open !== open || m.state !== s.state || (open ? now - m.asOf >= STATE_TIME_EVERY_MS : m.days !== json);
      if (!due) continue;
      picked.push({ open, key, e: { sid: s.sid, step, asOf: now, days }, mark: { open, state: s.state, asOf: now, days: json } });
    }
  }
  picked.sort((a, b) => (a.open === b.open ? (a.e.sid === b.e.sid ? (a.e.step < b.e.step ? -1 : 1) : a.e.sid < b.e.sid ? -1 : 1) : a.open ? -1 : 1));
  const top = picked.slice(0, max);
  return { entries: top.map((p) => p.e), marks: top.map((p) => [p.key, p.mark]) };
}

/** True while some closed key of `s` was not accepted with its final days (keep `s` in memory). */
export function finalPending(s: Session, memo: ReadonlyMap<string, SentMark>): boolean {
  if (!s.stateTime) return false;
  for (const step of Object.keys(s.stateTime.steps)) {
    if (isOpen(s, step)) return true;
    const days = s.stateTime.steps[step] ?? [];
    if (!days.length) continue;
    const m = memo.get(heldKey(s.sid, step));
    if (!m || m.days !== JSON.stringify(days)) return true;
  }
  return false;
}

/** `s` with the hub's verdict on whether it holds its step (`held` false: a `notHeld` mark), or `s` itself when nothing changes. */
export function withHeld(s: Session, held: boolean): Session {
  if (s.step === undefined || !s.stateTime) return s;
  const has = s.stateTime.notHeld?.includes(s.step) === true;
  if (has === !held) return s;
  const stateTime = { ...s.stateTime };
  if (held) delete stateTime.notHeld;
  else stateTime.notHeld = [s.step];
  return { ...s, stateTime };
}
