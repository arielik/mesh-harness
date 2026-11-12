// RL-3: pure helpers of pulses: which machines a pulse offers its run step to, manual slot ids.

import { randomBytes } from "node:crypto";
import { HEADLESS_DEFAULTS, type Suggestion } from "../protocol/index.ts";
import { suggest, type SuggestMachine, type SuggestSession } from "./suggest.ts";

const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/** A 26-character ULID of `now` (Crockford base32: 10 characters of time, 16 of `rand`'s 10 bytes). */
export function ulid(now: number, rand: Uint8Array = randomBytes(10)): string {
  let time = "";
  let t = Math.max(0, Math.floor(now));
  for (let i = 0; i < 10; i++) {
    time = (ALPHABET[t % 32] as string) + time;
    t = Math.floor(t / 32);
  }
  let bits = 0n;
  for (const b of rand.subarray(0, 10)) bits = (bits << 8n) | BigInt(b);
  let r = "";
  for (let i = 0; i < 16; i++) {
    r = (ALPHABET[Number(bits & 31n)] as string) + r;
    bits >>= 5n;
  }
  return `${time}${r}`;
}

/** The slot id of a manual fire: `manual:` + a ULID of `now`. */
export function manualSlot(now: number, rand?: Uint8Array): string {
  return `manual:${ulid(now, rand)}`;
}

/** The profile names a plan's steps run with (headless steps without one: the default), sorted, unique. */
export function profileNames(steps: readonly { profile?: string | undefined; mode?: string | undefined }[]): string[] {
  const names = new Set<string>();
  for (const s of steps) {
    const n = s.profile ?? (s.mode === "headless" ? HEADLESS_DEFAULTS.profile : undefined);
    if (n !== undefined) names.add(n);
  }
  return [...names].sort();
}

export interface PulseCandidatesInput {
  owner: string;
  repo: string;
  topics: readonly string[];
  target: { labels?: readonly string[] | undefined; machines?: readonly string[] | undefined };
  /** The run step has mode: headless. */
  headless: boolean;
  /** Machine ids already offered this slot. */
  tried: ReadonlySet<string>;
  now: number;
  /** The hub's machineOfflineMs. */
  onlineMs: number;
  machines: readonly (SuggestMachine & { headless?: boolean | undefined })[];
  sessions: readonly SuggestSession[];
}

/**
 * The machines a pulse may offer its run step to, in `suggest`'s order: online, auto-accepting an
 * offer from the owner, with the repo, carrying every target label, headless-capable when the step
 * is headless, not tried this slot, and matching `target.machines` when it names any.
 */
export function pulseCandidates(o: PulseCandidatesInput): Suggestion[] {
  const byId = new Map(o.machines.map((m) => [m.id, m]));
  const callerNicknames = new Set(o.machines.filter((m) => m.userId === o.owner && m.nickname).map((m) => m.nickname as string));
  const ranked = suggest({
    caller: o.owner,
    callerMachine: undefined,
    now: o.now,
    onlineMs: o.onlineMs,
    repos: [o.repo],
    topics: o.topics,
    any: false,
    machines: o.machines,
    callerNicknames,
    sessions: o.sessions,
  });
  const labels = o.target.labels ?? [];
  const names = o.target.machines ?? [];
  return ranked.filter((s) => {
    const m = byId.get(s.machine);
    if (!m || !s.online || !s.auto) return false;
    if (!labels.every((l) => (m.labels ?? []).includes(l))) return false;
    if (o.headless && m.headless !== true) return false;
    if (o.tried.has(m.id)) return false;
    if (names.length === 0) return true;
    return names.some((n) => n === m.id || (m.nickname !== undefined && (n === `${m.userId}/${m.nickname}` || (m.userId === o.owner && n === m.nickname))));
  });
}
