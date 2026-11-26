// Hub HTTP API request schemas and response shapes (plan §5.3–§5.6).

import { z } from "zod";
import type { Goal, Note, OfferState, Plan, PlanAc, Question, Step, StepFacts, StepKind, StepState, StoredArtifact, TrailFile, SpotSample } from "./goal.ts";
import { AcState, ArtifactKind, Commit, ArtifactMediaType, Failure, Findings, GoalState as GoalStateSchema, PlanInput, ProfileBase, ProfileName, RunExit, RunTelemetry, StepKind as StepKindSchema, StepState as StepStateSchema, Verdict } from "./goal.ts";
import { AcceptPolicy, ShareLevel } from "./config.ts";
import { Repo, Session, StateDay } from "./session.ts";
import { AgentReport } from "./roster.ts";
import { PresetSnapshot, PulseParams, SlotReason, SlotState } from "./pulse.ts";
import {
  Disposition,
  Fold,
  Requires,
  ReviewItem,
  Severity,
  ReviewRecord,
  type DispositionRow,
  type FoldMark,
  type ItemState,
  type ItemView,
  type ReviewEvidence,
  type StoredReview,
  TargetRepo,
} from "./review.ts";

export const IDEMPOTENCY_HEADER = "idempotency-key";
/** A service token acts for this person (user id) on the routes that allow it. */
export const ON_BEHALF_OF_HEADER = "x-mesh-on-behalf-of";
export const SESSION_COOKIE = "mesh_session";

/** Observation spooled by a daemon (plan §5.3). Ids make replays harmless. */
export const SyncEvent = z.object({
  id: z.string().uuid(),
  at: z.number(),
  type: z.string().regex(/^(session|message|agent)\.[a-z_]+$/),
  sid: z.string().optional(),
  step: z.string().optional(),
  payload: z.record(z.string(), z.unknown()).default({}),
});
export type SyncEvent = z.infer<typeof SyncEvent>;

/**
 * RL-14: a session's absolute state time on one step as of `asOf` (the daemon clock). The hub keeps
 * the newest report per `(step, sid)`, so a retried or replayed report never adds twice.
 */
export const StateTimeReport = z
  .object({
    sid: z.string().min(1).max(200),
    step: z.string().min(1).max(200),
    asOf: z.number().int().min(0),
    days: z.array(StateDay).min(1).max(400),
  })
  .superRefine((r, ctx) => {
    for (let i = 1; i < r.days.length; i++) {
      if ((r.days[i] as StateDay).day <= (r.days[i - 1] as StateDay).day) ctx.addIssue({ code: "custom", message: "days must be strictly ascending" });
    }
    if (r.asOf < (r.days.at(-1) as StateDay).day) ctx.addIssue({ code: "custom", message: "asOf is before the last day" });
  });
export type StateTimeReport = z.infer<typeof StateTimeReport>;

export const SyncRequest = z.object({
  events: z.array(SyncEvent).max(500).default([]),
  /** RL-14: state time per (session, step); each entry is checked alone and an invalid one is skipped. */
  stateTime: z.array(z.unknown()).max(500).optional(),
  /**
   * Full records of sessions that hold a step, plus metadata-only records of the other sessions
   * when the machine shares them (`shareSessions` `me` or `all`); otherwise those stay private (Q5).
   */
  sessions: z.array(Session).max(200).default([]),
  /** Session counts by state for the whole machine. */
  counts: z.record(z.string(), z.number().int()).default({}),
  /**
   * Facts about the machine (MM-1): its share level, and its repo inventory (ids and names only).
   * Absent (an older daemon): the hub keeps what it has. `repos` absent: inventory unchanged.
   * `accept` (MM-3): the machine's accept policy; absent: the hub keeps the stored one.
   */
  machine: z
    .object({
      share: ShareLevel,
      accept: AcceptPolicy.optional(),
      repos: z.array(Repo).max(500).optional(),
      /** RL-1: the daemon can run headless steps. Absent: the hub keeps the stored value. */
      headless: z.boolean().optional(),
      /** RL-5: agent files of its remote-backed repos. Absent: the hub keeps what it has; `[]`: none. */
      agents: z.array(AgentReport).max(2000).optional(),
      /**
       * RL-26: the owner allows remote session stops, the owner allows team offers, the daemon can
       * stop a headless run. A sync with `machine` stores an absent one as false.
       */
      remoteStop: z.boolean().optional(),
      teamOffers: z.boolean().optional(),
      runStop: z.boolean().optional(),
    })
    .optional(),
});
export type SyncRequest = z.infer<typeof SyncRequest>;

/** RL-24: the body of `POST /v1/fleet/pause`. */
export const FleetPauseRequest = z.object({ reason: z.string().trim().min(1).max(500) }).strict();
export type FleetPauseRequest = z.infer<typeof FleetPauseRequest>;
/** RL-24: the body of `POST /v1/fleet/resume` (`{}` or no body is accepted). */
export const FleetResumeRequest = z.object({ reason: z.string().trim().min(1).max(500).optional() }).strict();
export type FleetResumeRequest = z.infer<typeof FleetResumeRequest>;
/** RL-24: a stored fleet pause as replies, probes and the sync reply show it. */
export const FleetPause = z.object({
  /** Hub clock (ms) when the pause was stored. */
  since: z.number().int(),
  /** The person (never a service account under act-for). */
  by: z.string(),
  /** The service that acted for `by`. */
  via: z.string().optional(),
  reason: z.string(),
});
export type FleetPause = z.infer<typeof FleetPause>;
/** RL-24: the reply of the fleet pause and resume routes; a pause also says how many headless offers it withdrew. */
export const FleetState = z.object({ paused: FleetPause.nullable(), withdrawn: z.number().int().optional() });
export type FleetState = z.infer<typeof FleetState>;

/**
 * Reply to `POST /v1/sync`. `share`: the level the hub has stored for the token's machine (absent
 * when none was ever reported); a hub older than v0.1.10 answers `{ accepted }` only.
 */
export interface SyncResponse {
  accepted: number;
  share?: ShareLevel | undefined;
  /** RL-14: sessions of the body whose step the hub says they do not hold (their time stops accruing there). */
  notHeld?: { sid: string; step: string }[] | undefined;
  /** RL-24: the fleet pause (null: not paused); an older hub omits it. */
  paused?: FleetPause | null | undefined;
}

/** A machine nickname (MM-1): short, lowercase, unique among one person's machines. */
export const NICKNAME_RE = /^[a-z0-9][a-z0-9-]{0,31}$/;
/** The shape of a machine id; a nickname may not look like one. */
export const MACHINE_ID_RE = /^m-[0-9a-f]{8}$/;
export const NICKNAME_RULE = "nickname must match [a-z0-9][a-z0-9-]{0,31} and not look like a machine id";

export function nicknameOk(n: string): boolean {
  return NICKNAME_RE.test(n) && !MACHINE_ID_RE.test(n);
}

/** Body of `POST /v1/machines/:id/name`: a nickname, or null to clear it. */
export const MachineName = z.object({ nickname: z.string().refine(nicknameOk, NICKNAME_RULE).nullable() });

const LabelItems = z.array(z.string().max(40)).max(20);
/**
 * Body of `POST /v1/machines/:id/labels` (MM-2): replace the list, or add/remove labels (at least one
 * item in total). The hub normalises the items with `parseLabels`.
 */
export const MachineLabels = z.union([
  z.object({ labels: LabelItems }).strict(),
  z
    .object({ add: LabelItems.optional(), remove: LabelItems.optional() })
    .strict()
    .refine((b) => (b.add?.length ?? 0) + (b.remove?.length ?? 0) > 0, "give labels to add or remove"),
]);
export type MachineLabels = z.infer<typeof MachineLabels>;

/** Reply of `POST /v1/machines/:id/labels`. `unknown`: those of `labels` that are not defined topics, sorted. */
export interface MachineLabelsView {
  id: string;
  hostname: string;
  nickname?: string | undefined;
  labels: string[];
  unknown: string[];
}

export const AckRequest = z.object({ state: z.enum(["delivered", "failed"]), method: z.string().optional() });

/**
 * `install`: the logging-in mesh installation's own id (its config folder's `install-id`). The hub
 * keys a machine by it, so one person on two OS users or two containers of one host gets two
 * machines; without it (an older CLI) the hub falls back to person + hostname.
 */
const InstallId = z.string().regex(/^[A-Za-z0-9_-]{8,64}$/);
export const LoginDirect = z.object({ token: z.string().optional(), hostname: z.string().max(200).optional(), install: InstallId.optional(), client: z.enum(["cli", "web"]).default("cli") });
export const CliExchange = z.object({ code: z.string(), verifier: z.string(), hostname: z.string().max(200).optional(), install: InstallId.optional() });
export const DevicePoll = z.object({ pollId: z.string(), hostname: z.string().max(200).optional(), install: InstallId.optional() });

export const NewGoal = z.object({
  title: z.string().min(1).max(200),
  primaryRepo: z.string().optional(),
  issueUrl: z.string().url().optional(),
  repos: z.array(z.string()).max(20).optional(),
  refs: z.record(z.string().max(40), z.string().max(200)).optional(),
  reworks: z.array(z.string().max(100)).max(20).optional(),
  preset: z.object({ name: z.string().min(1).max(60), text: z.string().min(1).max(20_000) }).optional(),
  priority: z.number().int().min(0).max(9).default(3),
  /** Topics to tag the goal with; each must already exist (`all` is implicit). */
  topics: z.array(z.string().max(40)).max(20).optional(),
});

/** RL-3: body of `POST /v1/goals/from-preset` (ingest: a goal with an approved plan from a preset). */
export const GoalFromPreset = z
  .object({
    preset: PresetSnapshot.omit({ source: true }),
    params: PulseParams,
    title: z.string().min(1).max(200).optional(),
    topics: z.array(z.string().max(40)).max(20).optional(),
    refs: NewGoal.shape.refs,
    priority: z.number().int().min(0).max(9).default(3),
  })
  .strict();
export type GoalFromPreset = z.infer<typeof GoalFromPreset>;

export const NewTopic = z.object({
  name: z.string().min(1).max(40),
  description: z.string().max(200).optional(),
});
export const GoalTopicsChange = z
  .object({
    add: z.array(z.string().max(40)).max(20).default([]),
    remove: z.array(z.string().max(40)).max(20).default([]),
  })
  .refine((b) => b.add.length + b.remove.length > 0, "give topics to add or remove");

/** A topic as the hub lists it: with the number of goals tagged with it (for `all`: every goal). */
export interface TopicView {
  name: string;
  description?: string | undefined;
  createdBy?: string | undefined;
  createdAt?: number | undefined;
  goals: number;
}

export const ProposePlan = PlanInput.extend({
  approve: z.boolean().default(false),
  /**
   * The plan template the plan was made from (`mesh goal plan --preset`). The goal records it, so
   * its review lineages are `<preset>|<repo>|<agent>` like those of a pulse's goals from the same
   * preset, not `-|<repo>|<agent>`.
   */
  preset: NewGoal.shape.preset,
});
export const Replan = z.object({ comment: z.string().max(4000).optional() });
export const Decide = z.object({ comment: z.string().max(4000).optional() });
export const Approve = Decide.extend({ version: z.number().int().positive().optional() });

export const ClaimRequest = z.object({ sid: z.string().optional() });
/**
 * MM-3: body of `POST /v1/steps/:id/assign` and `POST /v1/goals/:id/assign`. `to` = the target
 * (`<machine>` or `<machine>/<session>`); `sid` = the offering session.
 */
export const AssignRequest = z.object({
  to: z.string().min(1).max(200),
  sid: z.string().optional(),
  stick: z.boolean().default(false),
  note: z.string().max(2000).optional(),
});
export type AssignRequest = z.infer<typeof AssignRequest>;
/**
 * RL-21: body of `POST /v1/steps/:id/assign`: `mode: "headless"` with a `profile` runs a step
 * headless that does not declare it (the caller's own machines only).
 */
export const StepAssignRequest = AssignRequest.extend({ mode: z.literal("headless").optional(), profile: ProfileName.optional() });
export type StepAssignRequest = z.infer<typeof StepAssignRequest>;
/** MM-3: body of `POST /v1/steps/:id/decline`. */
export const DeclineRequest = z.object({ note: z.string().max(2000).optional() });
export const ReleaseRequest = z.object({ note: z.string().max(4000).optional() });
export const NoteRequest = z.object({ text: z.string().min(1).max(8000), sid: z.string().optional() });
export const DoneRequest = z.object({
  summary: z.string().min(1).max(8000),
  outcome: z.enum(["done", "fail"]).default("done"),
  branch: z.string().max(200).optional(),
  mr: z.string().max(200).optional(),
  /** RL-13: the head commit of the step's work. */
  commit: Commit.optional(),
  reopen: z.array(z.string()).default([]),
  sid: z.string().optional(),
  model: z.string().max(100).optional(),
  artifacts: z.array(z.object({ path: z.string().min(1).max(500), sha: z.string().max(64).optional() })).max(50).optional(),
  /** When the daemon finished it (offline replays keep the real time). */
  at: z.number().optional(),
  verdict: Verdict.optional(),
  findings: Findings.optional(),
  blockers: z.number().int().min(0).optional(),
  failures: z.array(Failure).max(100).optional(),
  acs: z.record(z.string(), AcState).optional(),
  acs_addressed: z.array(z.string().max(40)).max(100).optional(),
  /**
   * RL-1: the daemon's close-as-fail of a headless run that ended without mesh_done. The step fails
   * (as an outcome `fail` without a record) even when a review record was stored in the round.
   */
  closeAsFail: z.literal(true).optional(),
});
/** RL-1: body of `POST /v1/profiles`. */
export const ProfileSave = z.object({ name: ProfileName, text: z.string().min(1).max(20000) });
/** RL-1: body of `POST /v1/steps/:id/artifacts`. */
export const ArtifactUpload = z.object({
  kind: ArtifactKind,
  title: z.string().max(200).optional(),
  mediaType: ArtifactMediaType.default("text/markdown"),
  content: z.string().min(1),
  redactions: z.number().int().min(0).default(0),
  sid: z.string().optional(),
});
/** RL-2: body of `POST /v1/steps/:id/review` (the daemon adds `eh`, the counts, `agent` and `sid`). */
export const ReviewUpload = ReviewRecord.extend({
  items: z.array(ReviewItem.extend({ eh: z.string().regex(/^[0-9a-f]{64}$/).optional() })).max(500),
  undeclaredRules: z.number().int().min(0).default(0),
  redactions: z.number().int().min(0).default(0),
  agent: z.object({ key: z.string().max(200), hash: z.string().max(64).optional() }).optional(),
  sid: z.string().optional(),
});
export type ReviewUpload = z.infer<typeof ReviewUpload>;

/** RL-2: reply of `POST /v1/steps/:id/review`. */
export interface ReviewResult {
  review: StoredReview;
  /** This record's items: unique fps in record order. */
  items: { fp: string; mark?: FoldMark; state: ItemState; title: string }[];
  /** Fps the fold resolved. */
  resolved: string[];
  /** Dispositions applied. */
  applied: number;
  /** Dispositions not applied (a person decided those items in this goal). */
  ignored: { fingerprint: string; reason: string }[];
  /** RL-4: fps whose disposition this debrief already recorded with mesh_dispose (`[]` outside debriefs). */
  already: string[];
}

const Fingerprint = z.string().regex(/^[a-z2-7]{16}$/, "a fingerprint is 16 characters of a-z and 2-7");

/** RL-4: body of `POST /v1/steps/:id/dispositions` (one decision of the person in a debrief). */
export const DisposeRequest = z
  .object({
    fingerprint: Fingerprint,
    disposition: Disposition,
    reason: z.string().min(1).max(2000),
    answer: z.string().min(1).max(4000),
    until: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "until is a date YYYY-MM-DD").optional(),
    link: z.string().min(1).max(500).optional(),
    /** RL-9: only with `accepted`: the fingerprints this fix cannot land before. */
    requires: Requires.optional(),
    sid: z.string().optional(),
  })
  .strict();
export type DisposeRequest = z.infer<typeof DisposeRequest>;

/** RL-9: body of `POST /v1/goals/:id/drop` (end any goal; no step may be held). */
export const GoalDrop = z.object({ reason: z.string().min(1).max(2000).optional() }).strict();
export type GoalDrop = z.infer<typeof GoalDrop>;

/** RL-9: body of `POST /v1/items/sink` (add a lineage's filed items to its clean-audit goal). */
export const SinkRequest = z
  .object({
    lineage: z.string().min(1).max(600),
    topic: z.string().min(1).max(100),
    min_severity: Severity.optional(),
    dry_run: z.boolean().optional(),
  })
  .strict();
export type SinkRequest = z.infer<typeof SinkRequest>;

/**
 * RL-9: reply of `POST /v1/items/sink`. `goal` is null on a dry run that would open a goal (the ids
 * then start with `<new>.`). `skipped` counts filed items left as they were.
 *
 * RL-10: `goals` has one entry per target repo of the selected items, ordered by repo. `goal` is the
 * entry's goal when there is exactly one entry, the lineage repo's clean-audit goal (or null) when
 * there is none, else null; `added` and `reopened` are the unions over the entries.
 */
export interface SinkResult {
  goal: string | null;
  added: string[];
  reopened: string[];
  skipped: number;
  notes: string[];
  goals: { goal: string | null; repo: string; added: string[]; reopened: string[] }[];
}

/**
 * RL-10: body of `POST /v1/items/retarget` (set the target repo of a lineage's items and move their
 * open finding steps). Exactly one of `fps` / `all` and one of `repo` / `from_key_path` (checked by
 * the hub, 400 otherwise).
 */
export const RetargetRequest = z
  .object({
    lineage: z.string().min(1).max(600),
    fps: z.array(Fingerprint).min(1).max(500).optional(),
    all: z.literal(true).optional(),
    repo: TargetRepo.optional(),
    from_key_path: z.literal(true).optional(),
    dry_run: z.boolean().optional(),
  })
  .strict();
export type RetargetRequest = z.infer<typeof RetargetRequest>;

/**
 * RL-10: reply of `POST /v1/items/retarget`. `items` lists the items whose target repo changed
 * (`from`, `to`: repos); `moved` the finding steps moved (`from`, `to`: step ids; on a dry run a step
 * in a goal still to be created is named `new:<repo>/<local id>`); `held` the held steps left in
 * place; `notes` the items left out and the moves skipped.
 */
export interface RetargetResult {
  items: { fp: string; from: string; to: string }[];
  moved: { from: string; to: string }[];
  held: string[];
  notes: string[];
}

/** RL-4: reply of `POST /v1/steps/:id/dispositions`. */
export interface DisposeResult {
  disposition: DispositionRow;
  item: ItemView;
  /** Debrief items after this one. */
  left: number;
  note: Note;
}

/** RL-4: body of `POST /v1/steps/:id/dispositions/revert`. */
export const RevertRequest = z.object({ fingerprint: Fingerprint, reason: z.string().min(1).max(2000).optional() }).strict();
export type RevertRequest = z.infer<typeof RevertRequest>;

/** RL-4: reply of `POST /v1/steps/:id/dispositions/revert`. */
export interface RevertResult {
  item: ItemView;
  reverted: DispositionRow;
  note: Note;
}

/** RL-18: body of `POST /v1/steps/:id/spot-checks` (a person's verdict on one sampled decision). */
export const SpotCheckRequest = z
  .object({
    sample: z.number().int().min(1),
    verdict: z.enum(["agree", "disagree"]),
    reason: z.string().min(1).max(2000),
    answer: z.string().min(1).max(4000),
    /** Only with `disagree`: the decision the person would have taken. */
    expected: Disposition.optional(),
    sid: z.string().optional(),
  })
  .strict();
export type SpotCheckRequest = z.infer<typeof SpotCheckRequest>;

/** RL-18: reply of `POST /v1/steps/:id/spot-checks`. */
export interface SpotCheckResult {
  sample: SpotSample & { n: number };
  /** Samples of the goal without a verdict. */
  left: number;
}

/** RL-4: a debrief disposition as the lists show it. */
export type DecidedView = DispositionRow & { title: string; revertable: boolean };

/**
 * RL-2: an item a consuming step gets in its `dispositions` input: the row with its history, plus the
 * evidence (path, lines, note) and proposal of the item in its run's latest record, so the step can
 * cite them (a filer links the pipeline the auditor named).
 */
export type ConsumedItem = ItemView & { evidence: ReviewEvidence[]; proposal?: string };

/** RL-4: an item of a debrief: evidence locations (never the agent's note) and possible repeats. */
export type DebriefItem = ItemView & {
  evidence: { path: string; lines?: [number, number] }[];
  nearMatches: { fp: string; state: ItemState; title: string; symbol?: string }[];
};

/** RL-4: body of `POST /v1/steps/:id/read`. */
export const ReadRequest = z.object({}).strict();

/** RL-4: reply of `GET /v1/steps/:id/debrief`. */
export interface DebriefView {
  step: string;
  goal: string;
  title: string;
  repo: string;
  state: StepState;
  /** Resolved (`@owner` → the goal's owner). */
  assignee: string;
  run?: string;
  lineage?: string;
  report?: { artifact: StoredArtifact; content: string | null };
  items: DebriefItem[];
  decided: DecidedView[];
  read?: { user: string; at: number; round: number };
}

/** RL-4: one debrief in `GET /v1/debriefs`. */
export interface DebriefSummary {
  step: string;
  goal: string;
  title: string;
  repo: string;
  state: StepState;
  /** Debrief items. */
  items: number;
  /** Read in the current round. */
  read: boolean;
}

/** RL-4: reply of `GET /v1/debriefs`. */
export interface DebriefList {
  debriefs: DebriefSummary[];
  decided: DecidedView[];
}

/** RL-1: body of `POST /v1/steps/:id/run`. */
export const RunReport = z.object({
  state: z.enum(["started", "finished"]),
  runId: z.string().min(1).max(100),
  round: z.number().int().positive().optional(),
  telemetry: RunTelemetry.optional(),
  branch: z.string().max(200).optional(),
  /** RL-13: the run's result commit (finished reports with a round only). */
  commit: Commit.optional(),
});
export const GateDecision = z.object({ comment: z.string().max(4000).optional(), rule: z.string().max(60).optional(), inputs: z.record(z.string(), z.unknown()).optional(), reopen: z.array(z.string()).max(50).optional() });
export const ResumeRequest = z.object({ comment: z.string().max(4000).optional() });
/** RL-22: `POST /v1/steps/:id/park`: a person parks a claimed or paused step by hand. */
export const StepPark = z.object({ reason: z.string().trim().min(1).max(500) }).strict();
export type StepPark = z.infer<typeof StepPark>;

/** RL-26: body of `POST /v1/steps/:id/stop-run`. */
export const StopRun = z.object({ reason: z.string().trim().min(1).max(500) }).strict();
export type StopRun = z.infer<typeof StopRun>;
/** RL-26: body of `POST /v1/sessions/:sid/stop`. */
export const StopSession = z.object({ mode: z.enum(["interrupt", "end"]), reason: z.string().trim().min(1).max(500) }).strict();
export type StopSession = z.infer<typeof StopSession>;
export const AskRequest = z.object({ text: z.string().min(1).max(4000), sid: z.string().optional(), step: z.string().optional() });
export const AnswerRequest = z.object({ text: z.string().min(1).max(4000) });
/** `to` (MM-4): `<machine>/<session>` or `<user>/<nickname>/<session>`, resolved like an assign target. */
export const MessageRequest = z
  .object({ toSid: z.string().optional(), to: z.string().min(1).max(200).optional(), toStep: z.string().optional(), text: z.string().min(1).max(8000) })
  .refine((m) => m.toSid || m.to || m.toStep, "toSid, to or toStep is required");

/** Reply of `POST /v1/messages`. `to` (MM-4): `<machine name>/<session name>`, only when the request used `to`. */
export interface MessageResult {
  id: number;
  toSid: string;
  to?: string | undefined;
}

export interface UserView {
  id: string;
  name: string;
  roles: string[];
}

export interface LoginResult {
  token: string;
  user: UserView;
  machine?: string | undefined;
  expiresAt: number;
}

export interface ProviderInfo {
  id: string;
  kind: string;
  label: string;
  flows: string[];
}

export interface InboxMessage {
  id: number;
  toSid: string;
  kind: string;
  text: string;
  fromUser: string;
  createdAt: number;
  /** Structured details for the daemon, e.g. {goal, version} on plan approval. */
  data?: Record<string, unknown> | undefined;
}

export interface StepContext {
  step: Step;
  goal: Goal;
  designRef?: string | undefined;
  deps: Pick<Step, "id" | "title" | "state" | "summary" | "branch" | "mr">[];
  notes: Note[];
  openQuestions: Question[];
  /** The plan's acceptance criteria this step covers (all of them when it names none). */
  acs?: PlanAc[] | undefined;
  /** RL-1: artifacts the step's policy `inputs` names (untrusted content). */
  inputs?: StepInput[] | undefined;
}

/** RL-1: one artifact served to a step as input. */
export interface StepInput {
  /** The step id it came from. */
  from: string;
  artifact: string;
  kind: ArtifactKind;
  title?: string | undefined;
  content: string;
  truncated: boolean;
  /**
   * RL-2: set when an item list (`dispositions`, the debrief items) is served in part: whole items
   * `from` .. `from + count - 1` of `total`. `mesh_context` with `items_from` serves the next ones.
   */
  page?: StepInputPage | undefined;
}

/** RL-2: which items of an item list an input holds (0-based `from`). */
export interface StepInputPage {
  from: number;
  count: number;
  total: number;
}

export interface DoneResult {
  step: Step;
  reopened: string[];
  nowReady: string[];
  goalDone: boolean;
  /** The step record to commit with the work (`.mesh/goals/<G>/steps/<id>.md`). */
  record?: TrailFile | undefined;
  /** Other trail files to write now, e.g. goal.yaml with its roll-up when the goal finished. */
  files?: TrailFile[] | undefined;
  /** The step was parked by a rule; a person decides how to go on. */
  parked?: string | undefined;
  /** Not accepted (reconcile): the session still holds the step and should fix it. */
  rejected?: string | undefined;
}

export interface GoalDetail {
  goal: Goal;
  steps: Step[];
  plans: Plan[];
  /** Live state of each holder's session, by step id (stalled, needs you, …). */
  holders?: Record<string, { sid: string; state: string; needs?: string | undefined; user: string; agent?: string | undefined }> | undefined;
  /** MM-3: each step's last offer, by step id; absent when no step has one. */
  offers?: Record<string, OfferLine> | undefined;
  /** MM-3: the target text of the goal's stick; absent when none. */
  stick?: string | undefined;
}

/** MM-3: reply of `POST /v1/steps/:id/assign`. */
export interface AssignResult {
  step: Step;
  auto: boolean;
  /** RL-21: the id of the offer message to the target machine (its `message.delivered` event has it as `payload.id`). */
  message?: number | undefined;
}

/** MM-3: reply of `POST /v1/goals/:id/assign`: the steps offered now, and the policy verdict. */
export interface GoalAssignResult {
  goal: Goal;
  steps: Step[];
  auto: boolean;
}

/**
 * MM-4: one machine of `GET /v1/steps/:id/suggest` / `GET /v1/goals/:id/suggest`. `machine` = id;
 * `user` = owner; `name` = machine name; `to` = what to pass as `--to`; `repo` = has every subject
 * repo; `idle` = idle candidate sessions; `session` = sid of the best one (a hint; absent when
 * `idle` is 0); `sessionLabels` / `machineLabels` = wanted labels of that session / the machine,
 * sorted; `auto` = the machine policy's verdict for an offer from the caller.
 */
export interface Suggestion {
  machine: string;
  user: string;
  name: string;
  to: string;
  online: boolean;
  lastSeen: number;
  repo: boolean;
  idle: number;
  session?: string | undefined;
  sessionLabels: string[];
  machineLabels: string[];
  auto: boolean;
  reason: string;
}

/** MM-4: reply of the suggest routes; `suggestions` in rank order. */
export interface SuggestView {
  target: string;
  steps: string[];
  repos: string[];
  topics: string[];
  team: boolean;
  any: boolean;
  suggestions: Suggestion[];
}

/** MM-3: reply of `POST /v1/goals/:id/withdraw`: the step ids whose offers were withdrawn, sorted. */
export interface GoalWithdrawResult {
  goal: Goal;
  withdrawn: string[];
}

/** MM-3: one open offer (`GET /v1/offers`). `to` = target text; `expiresAt = at + offerExpiryMs`. */
export interface OfferView {
  step: string;
  goal: string;
  title: string;
  repo: string;
  kind: StepKind;
  machine: string;
  sid?: string | undefined;
  to: string;
  by: string;
  bySid?: string | undefined;
  byMachine?: string | undefined;
  at: number;
  expiresAt: number;
  auto: boolean;
  note?: string | undefined;
  /** RL-21: the service that made the offer for `by`. */
  via?: string | undefined;
  /** RL-26: a headless offer, with the profile it runs under. */
  mode?: "headless" | undefined;
  profile?: { name: string; sha256: string } | undefined;
  /** RL-26: an offer a service made for a person to this teammate machine (never auto). */
  team?: true | undefined;
}

/** RL-26: one teammate machine of `GET /v1/machines?offers=team`. `repos`: repo names. */
export interface TeamMachine {
  id: string;
  name: string;
  nickname?: string | undefined;
  owner: string;
  labels: string[];
  online: boolean;
  lastSeen: number;
  headless: boolean;
  repos: string[];
}

/** MM-3: a step's last offer on the goal page. `accepted` = `<machine name>/<session name>` once accepted. */
export interface OfferLine {
  to: string;
  state: OfferState;
  by: string;
  at: number;
  accepted?: string | undefined;
  note?: string | undefined;
}

export interface StepView {
  context: StepContext;
  facts: StepFacts;
}

export interface TimelineEntry {
  seq: number;
  at: number;
  type: string;
  user?: string | undefined;
  step?: string | undefined;
  text: string;
}

export interface LiveSession {
  sid: string;
  machine: string;
  user: string;
  repo?: string | undefined;
  name?: string | undefined;
  step?: string | undefined;
  state: string;
  needs?: string | undefined;
  autopilot?: string | undefined;
  lastTurnAt?: number | undefined;
  /** MM-2: the session's labels; absent when none. */
  labels?: string[] | undefined;
}

export interface LiveMachine {
  id: string;
  hostname: string;
  nickname?: string | undefined;
  online: boolean;
  lastSeen: number;
  counts: Record<string, number>;
}

export interface Attention {
  kind: "approval" | "question" | "failed" | "stalled" | "paused" | "parked" | "needs_you" | "offer" | "offer_expired" | "debrief_overdue";
  text: string;
  goal?: string | undefined;
  step?: string | undefined;
  sid?: string | undefined;
  question?: number | undefined;
  at: number;
}

export interface LiveView {
  now: number;
  me: UserView;
  people: { user: UserView; online: boolean; machines: LiveMachine[]; sessions: LiveSession[] }[];
  goals: { id: string; title: string; state: string; owner: string; topics: string[]; done: number; total: number; holders: string[] }[];
  attention: Attention[];
  activity: { seq: number; at: number; type: string; user?: string | undefined; goal?: string | undefined; step?: string | undefined; text: string }[];
}

/** A session in `GET /v1/fleet` (MM-1). */
export interface FleetSession extends LiveSession {
  lastEventAt: number;
  /** MM-3: the session's accept override; absent when none. */
  accept?: string[] | undefined;
}

/** One of the caller's machines in `GET /v1/fleet` (MM-1). */
export interface FleetMachine {
  id: string;
  hostname: string;
  nickname?: string | undefined;
  online: boolean;
  lastSeen: number;
  counts: Record<string, number>;
  /** Absent: the machine's daemon never reported a share level. */
  share?: ShareLevel | undefined;
  /** `[]` when none was reported. */
  repos: Repo[];
  reposAt?: number | undefined;
  /** MM-2: the machine's labels, sorted; `[]` when none. */
  labels: string[];
  /** MM-3: the accept policy its daemon last reported; absent when never reported. */
  accept?: string[] | undefined;
  /** The user id of the person the machine is logged in as (0.1.29+; absent from an older hub). */
  owner?: string | undefined;
  /** This is the machine of the calling token. */
  current: boolean;
  sessions: FleetSession[];
}

/** `GET /v1/fleet`: every machine logged in as the caller and what each session on it does. */
export interface FleetView {
  now: number;
  user: UserView;
  machines: FleetMachine[];
}

/** RL-11: the feature names `GET /healthz` reports (sorted; a release adds names, never removes one). */
export const HUB_FEATURES: readonly string[] = ["agent-compare", "alert-notify", "changes", "commits", "debrief-sla", "decide-for", "efficiency", "findings-rollup", "fleet-pause", "health", "overlap-policy", "preset-check", "profile-fit", "pulse-runs", "questions-list", "run-stop", "runs", "session-stop", "spot-checks", "step-assign-for", "step-park", "team-attention", "team-offers", "trial"];

/** RL-25: an RFC 3339 time as Alertmanager writes it (fractions to nanoseconds, `Z` or an offset). */
const Rfc3339 = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/i, "not an RFC 3339 time")
  .refine((v) => !Number.isNaN(Date.parse(v)), "not an RFC 3339 time");

/** RL-25: one alert of an Alertmanager webhook (unknown keys are stripped). */
export const AlertItem = z.object({
  status: z.enum(["firing", "resolved"]),
  labels: z.record(z.string(), z.string()),
  annotations: z.record(z.string(), z.string()).default({}),
  startsAt: Rfc3339,
  endsAt: z.string().optional(),
  generatorURL: z.string().optional(),
  fingerprint: z.string().min(1).max(64),
});
export type AlertItem = z.infer<typeof AlertItem>;

/** RL-25: body of `POST /v1/alerts/webhook`, the Alertmanager webhook (version "4"). */
export const AlertWebhook = z.object({
  version: z.string(),
  status: z.enum(["firing", "resolved"]),
  receiver: z.string().max(200).optional(),
  groupKey: z.string().max(2000).optional(),
  externalURL: z.string().max(2000).optional(),
  truncatedAlerts: z.number().int().min(0).optional(),
  alerts: z.array(AlertItem).max(1000),
});
export type AlertWebhook = z.infer<typeof AlertWebhook>;

/** RL-25: why an alert notified no one. */
export const AlertSkipReason = z.enum(["no-person", "person-unknown", "no-machine"]);

/** RL-25: the reply of `POST /v1/alerts/webhook` (`received = notified + reminded + resolved + suppressed + skipped.length`). */
export const AlertWebhookResult = z.object({
  received: z.number().int(),
  notified: z.number().int(),
  reminded: z.number().int(),
  resolved: z.number().int(),
  suppressed: z.number().int(),
  skipped: z.array(z.object({ fingerprint: z.string(), reason: AlertSkipReason })),
});
export type AlertWebhookResult = z.infer<typeof AlertWebhookResult>;

/** RL-11: the item states now of the items a run's raising record listed. */
export const RunItems = z.object({
  raised: z.number().int(),
  open: z.number().int(),
  confirmed: z.number().int(),
  accepted: z.number().int(),
  dismissed: z.number().int(),
  deferred: z.number().int(),
  resolved: z.number().int(),
});
export type RunItems = z.infer<typeof RunItems>;

/** RL-11: raw waste parts of a run (no composite score). */
export const RunWaste = z.object({
  /** The round's outcome is `fail`. */
  failed: z.boolean(),
  /** The run was killed for its budget. */
  overBudget: z.boolean(),
  denials: z.number().int(),
  /** The round's raising record listed items and every one of them is dismissed now. */
  allDismissed: z.boolean(),
});
export type RunWaste = z.infer<typeof RunWaste>;

/** RL-11: one row of `GET /v1/runs`: a headless run that closed a round. */
export const RunRow = z.object({
  runId: z.string(),
  goal: z.string(),
  step: z.string(),
  round: z.number().int(),
  kind: StepKindSchema,
  repo: z.string(),
  branch: z.string().optional(),
  /** RL-13: the round's commit. */
  commit: Commit.optional(),
  user: z.string(),
  owner: z.string(),
  machine: z.string().optional(),
  pulse: z.string().optional(),
  slot: z.string().optional(),
  trial: z.boolean(),
  startedAt: z.number().optional(),
  finishedAt: z.number(),
  outcome: z.enum(["done", "fail"]),
  telemetry: RunTelemetry,
  fold: Fold.optional(),
  items: RunItems.optional(),
  waste: RunWaste,
  artifacts: z.array(z.string()),
});
export type RunRow = z.infer<typeof RunRow>;

export const RunsPage = z.object({ runs: z.array(RunRow), next: z.string().optional() });
export type RunsPage = z.infer<typeof RunsPage>;

// ---------- RL-12: pulse run cards and the health scorecard ----------

const int = z.number().int();

/** RL-12: one step of a run card's goal, with its times, runs and cost. */
export const StageCard = z.object({
  step: z.string(),
  kind: StepKindSchema,
  mode: z.enum(["interactive", "headless", "debrief"]),
  state: StepStateSchema,
  holder: z.string().optional(),
  agent: z.string().optional(),
  rounds: int,
  outcome: z.enum(["done", "fail"]).optional(),
  /** When the step could first start: the latest first end of its deps, or the plan approval. */
  readyAt: z.number().optional(),
  startedAt: z.number().optional(),
  finishedAt: z.number().optional(),
  /** The first cycle's wait: `startedAt − readyAt`. */
  waitMs: z.number().optional(),
  /** A reopened step that is open again: when the round that reopened it finished. */
  cycleReadyAt: z.number().optional(),
  /** A ready step: how long it has been waiting now. */
  waitingMs: z.number().optional(),
  runs: int,
  durationMs: int,
  turns: int,
  costUsd: z.number().optional(),
  exit: RunExit.optional(),
  /** RL-13: the commit of the step's newest round. */
  commit: Commit.optional(),
});
export type StageCard = z.infer<typeof StageCard>;

const FoldSums = Fold;
const CardItems = z.object({ raised: int, open: int, confirmed: int, accepted: int, dismissed: int, deferred: int, resolved: int });

/** RL-12: one slot of a pulse with what its goal did. */
export const RunCard = z.object({
  slot: z.string(),
  at: z.number(),
  state: SlotState,
  reason: SlotReason.optional(),
  by: z.string().optional(),
  running: z.string().optional(),
  error: z.string().optional(),
  firedAt: z.number().optional(),
  until: z.number().optional(),
  startedAt: z.number().optional(),
  decidedAt: z.number(),
  goal: z.string().optional(),
  manual: z.boolean(),
  trial: z.boolean(),
  catchUp: z.boolean(),
  /** RL-15: the slot waited in state `queued`. */
  queued: z.boolean(),
  /** RL-15: the goals this fire superseded (dropped). */
  superseded: z.array(z.string()),
  tries: int,
  startWaitMs: z.number().optional(),
  goalTitle: z.string().optional(),
  goalState: GoalStateSchema.optional(),
  goalCreatedAt: z.number().optional(),
  stages: z.array(StageCard),
  totals: z.object({ runs: int, durationMs: int, turns: int, costUsd: z.number().optional() }),
  fold: FoldSums.optional(),
  items: CardItems.optional(),
  dispositions: z.object({ confirmed: int, dismissed: int, deferred: int, accepted: int, byPeople: int, reverted: int }),
  reports: z.array(z.string()),
  sinks: z.array(z.object({ goal: z.string(), repo: z.string(), topic: z.string(), steps: int })),
  delta: z
    .object({ slot: z.string(), goal: z.string(), durationMs: int, turns: int, costUsd: z.number().optional(), raised: int, new: int, regression: int })
    .optional(),
});
export type RunCard = z.infer<typeof RunCard>;

export const RunCardsPage = z.object({ pulse: z.string(), cards: z.array(RunCard), next: z.string().optional() });
export type RunCardsPage = z.infer<typeof RunCardsPage>;

/** Counts by severity (RL-12; exported by RL-19). */
export const BySeverity = z.object({ S1: int, S2: int, S3: int, S4: int });
export type BySeverity = z.infer<typeof BySeverity>;
const HealthSlots = z.object({ due: int, fired: int, started: int, skipped: int, missed: z.record(z.string(), int), abandoned: int, queued: int });
const HealthRuns = z.object({
  count: int,
  durationMs: int,
  turns: int,
  costUsd: z.number().optional(),
  failed: int,
  overBudget: int,
  denials: int,
  allDismissed: int,
});
const HealthGoals = z.object({ created: int, done: int, dropped: int, open: int });
const Oldest = z.object({ open: int, oldestMs: z.number().optional() });
/** RL-15: a debrief past its SLA. */
export const DebriefBreach = z.object({
  goal: z.string(),
  step: z.string(),
  assignee: z.string(),
  /** The escalation user: the pulse owner (the goal owner without a pulse). */
  owner: z.string(),
  slaMs: int,
  /** When the debrief began to wait (this cycle). */
  since: z.number(),
  /** `since + slaMs`. */
  breachedAt: z.number(),
  /** Past twice the SLA. */
  escalated: z.boolean(),
  /** Its `auto-accept` dispositions in its current round. */
  autoAccepted: int,
});
export type DebriefBreach = z.infer<typeof DebriefBreach>;
const PulseDebriefs = Oldest.extend({ overdue: int, breaches: z.array(DebriefBreach) });
const TotalDebriefs = Oldest.extend({ overdue: int });
const HealthFindings = z.object({ open: BySeverity, accepted: BySeverity });
/** RL-18: item decisions (disposition history entries) in the window, and how many people took. */
const HealthDecisions = z.object({ total: int, byPeople: int });
/** RL-18: the hub's spot checks: open samples, the oldest one's wait, verdicts in the window. */
const HealthSpotChecks = z.object({ open: int, oldestMs: z.number().optional(), decided: int, disagreed: int });

/** RL-12: one pulse's scorecard over the window. */
export const PulseHealth = z.object({
  pulse: z.string(),
  title: z.string(),
  owner: z.string(),
  enabled: z.boolean(),
  schedule: z.string(),
  pausedReason: z.string().optional(),
  nextAt: z.number().optional(),
  slots: HealthSlots,
  manual: int,
  lastSlot: z.object({ slot: z.string(), at: z.number(), state: SlotState, reason: SlotReason.optional() }).optional(),
  blockedBy: z.object({ goal: z.string(), step: z.string(), ageMs: z.number() }).optional(),
  runs: HealthRuns,
  goals: HealthGoals,
  accepted: int,
  costPerAcceptedUsd: z.number().optional(),
  debriefs: PulseDebriefs,
  findings: HealthFindings,
  decisions: HealthDecisions,
  /** RL-18: `decisions.byPeople / decisions.total`, 4 decimals; absent at 0 decisions. */
  humanDecisionShare: z.number().optional(),
});
export type PulseHealth = z.infer<typeof PulseHealth>;

export const HealthTotal = z.object({
  pulses: int,
  slots: HealthSlots,
  manual: int,
  runs: HealthRuns,
  goals: HealthGoals,
  accepted: int,
  costPerAcceptedUsd: z.number().optional(),
  debriefs: TotalDebriefs,
  findings: HealthFindings,
  calibrations: Oldest,
  decisions: HealthDecisions,
  humanDecisionShare: z.number().optional(),
  spotChecks: HealthSpotChecks,
});
export type HealthTotal = z.infer<typeof HealthTotal>;

/** RL-12: `GET /v1/health`. */
export const Health = z.object({
  window: z.object({ since: z.number(), until: z.number(), days: int }),
  pulses: z.array(PulseHealth),
  total: HealthTotal,
});
export type Health = z.infer<typeof Health>;

// ---------- RL-19: findings roll-up per preset and repo ----------

/** RL-19: the newest report artifact of a roll-up row. */
export const RollupReport = z.object({
  /** The artifact id; its content is at `GET /v1/artifacts/<ref>`. */
  ref: z.string(),
  /** The artifact's `createdAt` (ms). */
  at: z.number(),
  goal: z.string(),
  step: z.string(),
  round: int,
  title: z.string().optional(),
  /** The content was pruned. */
  pruned: z.literal(true).optional(),
});
export type RollupReport = z.infer<typeof RollupReport>;

/** RL-19: one row of `GET /v1/findings/rollup`: a (preset, repo). */
export const RollupRow = z.object({
  /** The lineage preset (`-` for goals without a preset). */
  preset: z.string(),
  /** The repo: the target repo of the items, or the audited repo. */
  repo: z.string(),
  /** The `kind` the preset declares (from the goal of the newest source record). */
  kind: z.string().optional(),
  /** The pulse of the newest source record that names an existing pulse. */
  pulse: z.string().optional(),
  /** The number of contributing lineages. */
  lineages: int,
  /** The `at` of the newest source record (ms). */
  lastRaisedAt: z.number(),
  /** Items in state open or confirmed now. */
  open: BySeverity,
  /** Items in state accepted now. */
  accepted: BySeverity,
  latestReport: RollupReport.optional(),
});
export type RollupRow = z.infer<typeof RollupRow>;

/** RL-19: `GET /v1/findings/rollup`. */
export const FindingsRollup = z.object({
  window: z.object({ since: z.number(), until: z.number(), days: int }),
  rows: z.array(RollupRow),
});
export type FindingsRollup = z.infer<typeof FindingsRollup>;

// ---------- RL-16: profile fitting ----------

/** RL-16: the thresholds of a profile fit (reported in the reply). */
export const PROFILE_FIT = { minRuns: 5, minShare: 0.5 } as const;

/** RL-16: why a denial or an unused tool is not suggested. */
export const FitHeld = z.enum(["no-command", "not-a-word", "runs-anything", "already-allowed", "denied-by-profile", "few-runs", "rare", "refused", "mesh-tool", "allowed", "already-denied"]);
export type FitHeld = z.infer<typeof FitHeld>;

/** RL-16: the runs of a profile at one hash. */
export const ProfileFitHash = z.object({
  sha256: z.string(),
  current: z.boolean(),
  runs: int,
  toolRuns: int,
  deniedRuns: int,
  denials: int,
  firstAt: z.number().optional(),
  lastAt: z.number().optional(),
});
export type ProfileFitHash = z.infer<typeof ProfileFitHash>;

/** RL-16: one denied tool (and Bash command word) over the sample. */
export const FitDenied = z.object({
  tool: z.string(),
  command: z.string().optional(),
  runs: int,
  count: int,
  rule: z.string().optional(),
  suggest: z.boolean(),
  held: FitHeld.optional(),
  refusal: z.string().optional(),
});
export type FitDenied = z.infer<typeof FitDenied>;

/** RL-16: one tool offered in the sample's tool runs and used in none. */
export const FitUnused = z.object({ tool: z.string(), offeredRuns: int, suggest: z.boolean(), held: FitHeld.optional(), refusal: z.string().optional() });
export type FitUnused = z.infer<typeof FitUnused>;

/** RL-16: `GET /v1/profiles/:name/fit`. */
export const ProfileFit = z.object({
  profile: z.string(),
  builtIn: z.boolean(),
  base: ProfileBase,
  sha256: z.string(),
  window: z.object({ since: z.number(), until: z.number(), days: int }),
  trial: z.enum(["exclude", "include"]),
  thresholds: z.object({ minRuns: int, minShare: z.number() }),
  hashes: z.array(ProfileFitHash),
  sample: z.object({ runs: int, toolRuns: int }),
  denied: z.array(FitDenied),
  unused: z.array(FitUnused),
  truncated: z.object({ denied: int, unused: int }).optional(),
  diff: z.object({ allow: z.array(z.string()), deny: z.array(z.string()) }),
});
export type ProfileFit = z.infer<typeof ProfileFit>;

/** RL-17: the event that introduced a change (`GET /v1/changes`). */
export const ChangeEvent = z.object({ id: z.string(), seq: int, type: z.string(), at: z.number(), user: z.string().optional() });
export type ChangeEvent = z.infer<typeof ChangeEvent>;

/** RL-17: one `(kind, key, hash)` of the change timeline with its first sighting. */
export const ChangeEntry = z.object({
  kind: z.enum(["agent", "profile", "preset"]),
  key: z.string(),
  hash: z.string(),
  firstSeen: z.number(),
  previous: z.string().optional(),
  source: z.enum(["event", "goal", "run"]),
  goal: z.string().optional(),
  step: z.string().optional(),
  round: int.optional(),
  runId: z.string().optional(),
  pulse: z.string().optional(),
  event: ChangeEvent.optional(),
  sightings: int,
});
export type ChangeEntry = z.infer<typeof ChangeEntry>;

/** RL-17: `GET /v1/changes`. */
export const ChangesPage = z.object({ changes: z.array(ChangeEntry), next: z.string().optional() });
export type ChangesPage = z.infer<typeof ChangesPage>;

/** RL-17: the run aggregate of one hash: the RL-12 health `runs` plus the number of runs with a cost. */
export const CompareRuns = HealthRuns.extend({ costRuns: int });
export type CompareRuns = z.infer<typeof CompareRuns>;

/** RL-17: one hash of `GET /v1/agents/:key/compare`: the RL-12 run aggregate and the RL-6 item counts. */
export const HashSide = z.object({
  hash: z.string(),
  runs: CompareRuns,
  items: z.object({ raised: int, new: int, regressions: int, carried: int, accepted: int, dismissedByAgents: int, dismissedByPeople: int }),
  firstAt: z.number().optional(),
  lastAt: z.number().optional(),
});
export type HashSide = z.infer<typeof HashSide>;

/** RL-17: `GET /v1/agents/:key/compare`. */
export const AgentCompare = z.object({
  key: z.string(),
  since: z.number().optional(),
  until: z.number().optional(),
  repo: z.string().optional(),
  trial: z.enum(["exclude", "include"]),
  from: HashSide,
  to: HashSide,
});
export type AgentCompare = z.infer<typeof AgentCompare>;

// ---------- RL-14: time per session state, efficiency cards, stuck signal ----------

const ms = z.number().int().min(0);

/** Milliseconds per session state. */
export const StateTime = z.object({ workingMs: ms, needsYouMs: ms, idleMs: ms, stalledMs: ms });
export type StateTime = z.infer<typeof StateTime>;

/** One session's state time (on a step, or summed over a goal's steps). `machine` is the machine id. */
export const SessionTime = StateTime.extend({ sid: z.string(), user: z.string(), machine: z.string(), asOf: z.number() });
export type SessionTime = z.infer<typeof SessionTime>;

/** Figures of a step, all time (card) or inside a window. `stateTime` absent: no session reported any (not zero). */
export const StepFigures = z.object({
  stateTime: StateTime.optional(),
  turns: int,
  rounds: int,
  fails: int,
  parks: int,
  commits: int,
  takeOvers: int,
  runs: int,
  runDurationMs: ms,
  runTurns: int,
  costUsd: z.number().optional(),
});
export type StepFigures = z.infer<typeof StepFigures>;

export const StepEfficiency = StepFigures.extend({
  step: z.string(),
  kind: StepKindSchema,
  mode: z.string(),
  repo: z.string(),
  state: StepStateSchema,
  fixCycles: int,
  holder: z.string().optional(),
  movedTo: z.string().optional(),
  startedAt: z.number().optional(),
  endAt: z.number().optional(),
  wallMs: ms.optional(),
  commit: z.string().optional(),
  commitAt: z.number().optional(),
  done: z.boolean(),
  firstTryPass: z.boolean(),
  sessions: z.array(SessionTime),
});
export type StepEfficiency = z.infer<typeof StepEfficiency>;

/** `GET /v1/goals/:id/efficiency`. */
export const GoalEfficiency = StepFigures.extend({
  goal: z.string(),
  title: z.string(),
  state: z.string(),
  trial: z.boolean(),
  createdAt: z.number(),
  endAt: z.number().optional(),
  wallMs: ms,
  stateTimeSteps: int,
  fixCycles: int,
  steps: int,
  done: int,
  firstTryPass: int,
  sessions: z.array(SessionTime),
  stepCards: z.array(StepEfficiency),
});
export type GoalEfficiency = z.infer<typeof GoalEfficiency>;

/** A step's figures inside a window. */
export const StepWindowRow = StepFigures.extend({ step: z.string(), repo: z.string(), reopens: int, done: int, firstTryPass: int });
export type StepWindowRow = z.infer<typeof StepWindowRow>;

/** Sums over the steps in a window. */
export const Rollup = StepFigures.extend({ steps: int, stateTimeSteps: int, reopens: int, done: int, firstTryPass: int });
export type Rollup = z.infer<typeof Rollup>;

/** `GET /v1/efficiency`. */
export const EfficiencyWindow = z.object({
  window: z.object({ since: z.number(), until: z.number() }),
  total: Rollup,
  repos: z.array(Rollup.extend({ repo: z.string() })),
  goals: z.array(Rollup.extend({ goal: z.string(), title: z.string(), state: z.string(), trial: z.boolean(), stepRows: z.array(StepWindowRow).optional() })),
});
export type EfficiencyWindow = z.infer<typeof EfficiencyWindow>;

/** `GET /v1/stuck`. */
export const Stuck = z.object({
  thresholds: z.object({ needsYouMs: ms, turns: int }),
  sessions: z.array(
    z.object({ sid: z.string(), user: z.string(), machine: z.string(), step: z.string(), goal: z.string(), repo: z.string(), needs: z.string().optional(), since: z.number(), forMs: ms, lastSeenAt: z.number() }),
  ),
  steps: z.array(z.object({ step: z.string(), goal: z.string(), repo: z.string(), holder: z.string().optional(), turns: int, commit: z.string().optional(), commitAt: z.number().optional(), claimedAt: z.number().optional() })),
  repos: z.array(z.object({ repo: z.string(), sessions: int, steps: int })),
  unmeasured: int,
});
export type Stuck = z.infer<typeof Stuck>;

/** RL-22: the kinds of the team form of `GET /v1/attention` (mesh-ai ADR-0025 D24.1). */
export const TEAM_ATTENTION_KINDS = [
  "plan",
  "gate",
  "debrief",
  "debrief-overdue",
  "hub-question",
  "parked",
  "failed",
  "paused",
  "stalled",
  "stuck-step",
  "stuck-session",
  "needs-you-session",
  "slot-missed",
  "pulse-blocked",
  "ready-unclaimed",
  "offer",
] as const;

/** RL-22: one open item of the team (`GET /v1/attention?team=1`). */
export const TeamAttentionItem = z.object({
  /** Stable across reads: `<kind>:<goal|pulse|->:<step|slot|->:<question|sid|->`. */
  key: z.string(),
  kind: z.enum(TEAM_ATTENTION_KINDS),
  goal: z.string().nullable(),
  step: z.string().nullable(),
  /** The step's repo, else the goal's primary repo, else null. */
  repo: z.string().nullable(),
  /** The one hub user the item waits on, or null. */
  who: z.string().nullable(),
  /** When the item started waiting. */
  at: z.number(),
  text: z.string(),
  goalTitle: z.string().optional(),
  stepTitle: z.string().optional(),
  planVersion: int.optional(),
  question: int.optional(),
  toUsers: z.array(z.string()).optional(),
  sid: z.string().optional(),
  machine: z.string().optional(),
  needs: z.string().optional(),
  holder: z.string().optional(),
  reason: z.string().optional(),
  sla: z.object({ dueAt: z.number(), breached: z.literal(true), escalated: z.boolean() }).optional(),
  escalatedTo: z.string().optional(),
  turns: int.optional(),
  forMs: ms.optional(),
  pulse: z.string().optional(),
  slot: z.string().optional(),
  stepKind: z.string().optional(),
  mode: z.string().optional(),
  targetMachine: z.string().optional(),
});
export type TeamAttentionItem = z.infer<typeof TeamAttentionItem>;

/** RL-22: `GET /v1/attention?team=1`. */
export const TeamAttention = z.object({
  generatedAt: z.number(),
  thresholds: z.object({ needsYouMs: ms, turns: int }),
  /** More items than `limit`: the oldest `limit` are returned. */
  truncated: z.boolean(),
  /** Every hub user that is not a service account, sorted. */
  users: z.array(z.string()),
  items: z.array(TeamAttentionItem),
});
export type TeamAttention = z.infer<typeof TeamAttention>;

/** RL-22: one unanswered question (`GET /v1/questions?state=open`). */
export const OpenQuestion = z.object({
  id: int,
  goal: z.string().optional(),
  step: z.string().optional(),
  repo: z.string().optional(),
  sid: z.string().optional(),
  fromUser: z.string(),
  toUsers: z.array(z.string()),
  text: z.string(),
  at: z.number(),
});
export type OpenQuestion = z.infer<typeof OpenQuestion>;
export const OpenQuestions = z.object({ truncated: z.boolean(), questions: z.array(OpenQuestion) });
export type OpenQuestions = z.infer<typeof OpenQuestions>;
