// RL-17: the change timeline, pure. The hub collects sightings of agent, profile and preset hashes
// (runs, goals, registration events); these functions pick each hash's first sighting, link it to the
// previous hash of the same key, and order and page the entries (docs/specs/RL-17.md).

export type ChangeKind = "agent" | "profile" | "preset";
export type SightingSource = "event" | "goal" | "run";

/** One place the hub recorded a `(kind, key, hash)` at a time. */
export interface Sighting {
  kind: ChangeKind;
  key: string;
  hash: string;
  at: number;
  source: SightingSource;
  /** Event sightings: the event's seq, id, type, user and (pulse events) pulse. */
  event?: { seq: number; id: string; type: string; at: number; user?: string | undefined; pulse?: string | undefined } | undefined;
  goal?: string | undefined;
  step?: string | undefined;
  round?: number | undefined;
  runId?: string | undefined;
}

export interface TimelineEntry {
  kind: ChangeKind;
  key: string;
  hash: string;
  firstSeen: number;
  previous?: string | undefined;
  first: Sighting;
  sightings: number;
}

const RANK: Record<SightingSource, number> = { event: 0, goal: 1, run: 2 };
const bin = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/** Sighting order: time, then source (event, goal, run), then event seq, goal id, or (step, round). */
export function sightingCmp(a: Sighting, b: Sighting): number {
  return (
    a.at - b.at ||
    RANK[a.source] - RANK[b.source] ||
    (a.event?.seq ?? 0) - (b.event?.seq ?? 0) ||
    bin(a.goal ?? "", b.goal ?? "") ||
    bin(a.step ?? "", b.step ?? "") ||
    (a.round ?? 0) - (b.round ?? 0)
  );
}

/** Entry order: `firstSeen` descending, then kind, key, hash ascending (binary strings). */
export function entryCmp(a: { firstSeen: number; kind: string; key: string; hash: string }, b: { firstSeen: number; kind: string; key: string; hash: string }): number {
  return b.firstSeen - a.firstSeen || bin(a.kind, b.kind) || bin(a.key, b.key) || bin(a.hash, b.hash);
}

/** One entry per `(kind, key, hash)` of the given (already filtered) sightings, in entry order, with `previous`. */
export function timeline(sightings: readonly Sighting[]): TimelineEntry[] {
  const byHash = new Map<string, TimelineEntry>();
  for (const s of sightings) {
    const k = `${s.kind}\n${s.key}\n${s.hash}`;
    const e = byHash.get(k);
    if (!e) byHash.set(k, { kind: s.kind, key: s.key, hash: s.hash, firstSeen: s.at, first: s, sightings: 1 });
    else {
      e.sightings++;
      if (sightingCmp(s, e.first) < 0) {
        e.first = s;
        e.firstSeen = s.at;
      }
    }
  }
  const entries = [...byHash.values()].sort(entryCmp);
  // previous: the next entry of the same (kind, key) in entry order (oldest last).
  const older = new Map<string, TimelineEntry>();
  for (let i = entries.length - 1; i >= 0; i--) {
    const e = entries[i] as TimelineEntry;
    const k = `${e.kind}\n${e.key}`;
    const prev = older.get(k);
    if (prev) e.previous = prev.hash;
    older.set(k, e);
  }
  return entries;
}
