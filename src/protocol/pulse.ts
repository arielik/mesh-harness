// RL-3: pulses (hub schedules that create goals from a preset snapshot) and their slots.
import { z } from "zod";
import { type GoalState, PlanStep, ProfileSnapshot } from "./goal.ts";
import { AgentDef } from "./roster.ts";
import { DurationSpec, durationMs } from "./duration.ts";
import { Label } from "./session.ts";

export { DURATION_RE, DurationSpec, durationMs } from "./duration.ts";

export const PulseId = z.string().regex(/^p-[1-9][0-9]*$/);
export type PulseId = z.infer<typeof PulseId>;


/** What a pulse create or update says about its schedule (`at` = the anchor of `every`, ms). */
export const PulseWhenInput = z.union([
  z.object({ cron: z.string().min(1).max(100), tz: z.string().min(1).max(64) }).strict(),
  z.object({ every: DurationSpec, at: z.number().int().min(0).optional() }).strict(),
]);
export type PulseWhenInput = z.infer<typeof PulseWhenInput>;

/** A stored schedule. */
export const PulseWhen = z.union([
  z.object({ cron: z.string(), tz: z.string() }).strict(),
  z.object({ every: DurationSpec, anchor: z.number().int().min(0) }).strict(),
]);
export type PulseWhen = z.infer<typeof PulseWhen>;

/** The preset text a pulse runs, as it was sent (R-6). */
export const PresetSnapshot = z
  .object({
    name: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,59}$/),
    text: z.string().min(1).max(20_000),
    sha256: z.string().regex(/^[0-9a-f]{64}$/),
    source: z.object({ repo: z.string().min(1).max(300), commit: z.string().min(1).max(64) }).strict().optional(),
  })
  .strict();
export type PresetSnapshot = z.infer<typeof PresetSnapshot>;

export const PulseParams = z
  .record(z.string().regex(/^[a-z][a-z0-9_]{0,39}$/), z.string().max(300))
  .refine((r) => Object.keys(r).length <= 20, "at most 20 params");
export type PulseParams = z.infer<typeof PulseParams>;

export const PulseTarget = z
  .object({
    labels: z.array(Label).max(20).optional(),
    machines: z.array(z.string().min(1).max(100)).max(20).optional(),
  })
  .strict();
export type PulseTarget = z.infer<typeof PulseTarget>;

/** RL-15: `queue` waits for the running goal; `supersede` drops goals that only wait on people. */
export const Overlap = z.enum(["skip", "allow", "queue", "supersede"]);
export type Overlap = z.infer<typeof Overlap>;
const Missed = z.enum(["record", "catch-up-once"]);

/** The fields of `PulseCreate`, without defaults or refinements (`PulseUpdate` is built from it). */
export const PulseFields = z
  .object({
    title: z.string().min(1).max(200).optional(),
    preset: PresetSnapshot,
    params: PulseParams,
    when: PulseWhenInput,
    topics: z.array(z.string().max(40)).max(20).optional(),
    target: PulseTarget.optional(),
    window: DurationSpec.optional(),
    overlap: Overlap.optional(),
    maxGoalAge: DurationSpec.optional(),
    missed: Missed.optional(),
    enabled: z.boolean().optional(),
    /**
     * RL-8: repo agents (by name) the caller checked itself in the preset's source checkout at
     * `preset.source.commit` (`mesh pulse add` from a checkout); the hub leaves them out of its
     * warnings from the roster's copies. Never stored.
     */
    checkedAgents: z.array(z.string().min(1).max(100)).max(50).optional(),
  })
  .strict();

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

function inRange(v: string | undefined, lo: number, hi: number): boolean {
  if (v === undefined) return true;
  const ms = durationMs(v);
  return ms === undefined || (ms >= lo && ms <= hi);
}

function ranges(v: { when?: PulseWhenInput | undefined; window?: string | undefined; maxGoalAge?: string | undefined }, ctx: z.RefinementCtx): void {
  if (v.when && "every" in v.when && !inRange(v.when.every, 5 * MIN, 366 * DAY)) ctx.addIssue({ code: "custom", message: "every is 5m to 366d", path: ["when", "every"] });
  if (!inRange(v.window, MIN, 30 * DAY)) ctx.addIssue({ code: "custom", message: "window is 1m to 30d", path: ["window"] });
  if (!inRange(v.maxGoalAge, HOUR, 366 * DAY)) ctx.addIssue({ code: "custom", message: "maxGoalAge is 1h to 366d", path: ["maxGoalAge"] });
}

/** Body of `POST /v1/pulses`. */
export const PulseCreate = PulseFields.extend({
  target: PulseTarget.default({}),
  overlap: Overlap.default("skip"),
  missed: Missed.default("record"),
  enabled: z.boolean().default(true),
}).superRefine(ranges);
export type PulseCreate = z.infer<typeof PulseCreate>;

/** Body of `POST /v1/pulses/:id/update`: only the fields to change (no defaults). */
export const PulseUpdate = PulseFields.omit({ enabled: true })
  .partial()
  .superRefine((v, ctx) => {
    ranges(v, ctx);
    if (Object.keys(v).filter((k) => k !== "checkedAgents").length === 0) ctx.addIssue({ code: "custom", message: "give at least one field to change" });
  });
export type PulseUpdate = z.infer<typeof PulseUpdate>;

export const SlotState = z.enum(["fired", "skipped", "missed", "abandoned", "queued"]);
export type SlotState = z.infer<typeof SlotState>;
export const SlotReason = z.enum(["overlap", "no_machine", "not_accepted", "capacity", "expired", "hub_down", "max_goal_age", "error"]);
export type SlotReason = z.infer<typeof SlotReason>;

export const SlotTry = z.object({
  machine: z.string(),
  at: z.number(),
  outcome: z.enum(["accepted", "declined", "timeout", "released", "capacity"]).optional(),
});
export type SlotTry = z.infer<typeof SlotTry>;

const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
export const MANUAL_SLOT_RE = /^manual:[0-9A-HJKMNP-TV-Z]{26}$/;

/** RL-15: undecided debrief items of superseded goals, carried into the next goal's debrief. */
export const Carry = z.object({
  /** The local id of the debrief step. */
  step: z.string(),
  lineage: z.string(),
  /** 1..1000 fingerprints, unique, sorted. */
  fps: z
    .array(z.string())
    .min(1)
    .max(1000)
    .refine((a) => a.every((x, i) => i === 0 || (a[i - 1] as string) < x), "fps are unique and sorted"),
});
export type Carry = z.infer<typeof Carry>;

/** One slot of a pulse: due (or manual) time and what happened to it. */
export const PulseSlot = z.object({
  pulse: PulseId,
  /** ISO of `at` (scheduled), or `manual:` + a ULID. */
  slot: z.string().refine((s) => ISO_RE.test(s) || MANUAL_SLOT_RE.test(s), "a slot is an ISO time or manual:<ULID>"),
  /** Due time; for a manual slot the fire time. */
  at: z.number(),
  state: SlotState,
  reason: SlotReason.optional(),
  goal: z.string().optional(),
  manual: z.literal(true).optional(),
  /** Manual: the caller. */
  by: z.string().optional(),
  catchUp: z.literal(true).optional(),
  /** RL-11: a trial fire (`mesh pulse fire --trial`). */
  trial: z.literal(true).optional(),
  /** RL-11: a slot skipped for overlap: the goal that was running. RL-15: also a queued slot's. */
  running: z.string().optional(),
  /** RL-15: the slot waited in state `queued` (kept after it fires or is skipped). */
  queued: z.literal(true).optional(),
  /** RL-15: the goals this fire dropped (`overlap: supersede`), in slot order. */
  superseded: z.array(z.string()).optional(),
  /** RL-15: the debrief items carried from the superseded goals. */
  carry: z.array(Carry).optional(),
  firedAt: z.number().optional(),
  /** Fired slots: the end of the window. */
  until: z.number().optional(),
  startedAt: z.number().optional(),
  /** Reason `error`: the message. */
  error: z.string().max(500).optional(),
  tried: z.array(SlotTry).default([]),
  decidedAt: z.number(),
});
export type PulseSlot = z.infer<typeof PulseSlot>;

export const Pulse = z.object({
  id: PulseId,
  owner: z.string(),
  title: z.string(),
  when: PulseWhen,
  preset: PresetSnapshot,
  params: PulseParams,
  profiles: z.record(z.string(), ProfileSnapshot),
  /** RL-5: roster keys of the plan pinned to catalog definitions (R-6), keyed by the policy string. */
  agents: z.record(z.string(), AgentDef).default({}),
  topics: z.array(z.string()),
  target: PulseTarget,
  /** As given; absent = the default. */
  window: DurationSpec.optional(),
  windowMs: z.number().int().positive(),
  overlap: Overlap,
  /** As given; absent = the default. */
  maxGoalAge: DurationSpec.optional(),
  maxGoalAgeMs: z.number().int().positive(),
  missed: Missed,
  enabled: z.boolean(),
  pausedReason: z.string().optional(),
  /** Absent when paused or deleted. */
  nextAt: z.number().optional(),
  version: z.number().int().min(1),
  createdAt: z.number(),
  updatedAt: z.number(),
  deletedAt: z.number().optional(),
});
export type Pulse = z.infer<typeof Pulse>;

/** A pulse as lists show it: no preset text, profiles by sha256 only. */
export type PulseView = Omit<Pulse, "preset" | "profiles" | "agents"> & {
  preset: { name: string; sha256: string; source?: { repo: string; commit: string } | undefined };
  profiles: Record<string, string>;
  /** RL-5: roster key to the pinned hash. */
  agents: Record<string, string>;
  schedule: string;
  /** The 10 newest slots. */
  recent: PulseSlot[];
  /**
   * RL-8: agents the pulse's steps name that the roster flags invalid, one line per step. Only in the
   * replies of `POST /v1/pulses` and `POST /v1/pulses/:id/update` (possibly empty); never stored.
   */
  warnings?: string[] | undefined;
};

/** The daemon's `GET /local/pulses` (the TUI's pulses panel): the hub's pulses and the state of the goals their recent slots name. */
export interface PulseList {
  pulses: PulseView[];
  goals: Record<string, string>;
}

export interface PulseDetail {
  pulse: Pulse;
  schedule: string;
  /** The 50 newest. */
  slots: PulseSlot[];
  /** State of each goal named by those slots. */
  goals: Record<string, GoalState>;
  /**
   * RL-20: the stored snapshot's plan, instantiated with the pulse's params and `{goal}` = "this goal"
   * (a slot's goal gets its own id); absent when the snapshot no longer parses or instantiates.
   */
  steps?: PlanStep[] | undefined;
}

/** RL-20: body of `POST /v1/presets/check` (a read): the preset and params as `PulseCreate` takes them. */
export const PresetCheck = z
  .object({
    preset: PresetSnapshot,
    params: PulseParams,
    checkedAgents: z.array(z.string().min(1).max(100)).max(50).optional(),
  })
  .strict();
export type PresetCheck = z.infer<typeof PresetCheck>;

/** RL-20: the answer of `POST /v1/presets/check`. */
export const PresetCheckResult = z.object({
  /** No problems: pulse create passes its preset checks against the hub's state now. */
  ok: z.boolean(),
  /** What makes pulse create refuse, with create's texts (its 422 `details`, then sink-topic 400s). */
  problems: z.array(z.string()),
  /** RL-8: invalid agents of the plan; never make `ok` false. */
  warnings: z.array(z.string()),
  /** Only when `ok`: the plan as a slot's goal gets it, `{goal}` = "this goal". */
  steps: z.array(PlanStep).optional(),
  /** Only when `ok`: the roster keys pinned as pulse create pins them (repo agents are not pinned). */
  agents: z.record(z.string(), AgentDef).optional(),
});
export type PresetCheckResult = z.infer<typeof PresetCheckResult>;

/** RL-11: the optional body of `POST /v1/pulses/:id/fire`. */
export const PulseFire = z.object({ trial: z.boolean().optional() }).strict();
export type PulseFire = z.infer<typeof PulseFire>;

export interface FireResult {
  slot: PulseSlot;
}
