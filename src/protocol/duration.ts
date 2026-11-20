// Durations (RL-3, moved here by RL-15 so step policies can use them without an import cycle).
import { z } from "zod";

/** A duration: a number and m (minutes), h (hours) or d (days), e.g. 30m, 4h, 7d. */
export const DURATION_RE = /^[1-9][0-9]{0,5}(m|h|d)$/;
const UNIT_MS = { m: 60_000, h: 3_600_000, d: 86_400_000 } as const;

/** Milliseconds of a duration; `undefined` when `s` is not one. */
export function durationMs(s: string): number | undefined {
  if (!DURATION_RE.test(s)) return undefined;
  const unit = s.slice(-1) as keyof typeof UNIT_MS;
  return Number(s.slice(0, -1)) * UNIT_MS[unit];
}

export const DurationSpec = z.string().regex(DURATION_RE, "a duration is a number and m, h or d, e.g. 30m, 4h, 7d");
export type DurationSpec = z.infer<typeof DurationSpec>;
