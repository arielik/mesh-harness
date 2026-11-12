// Hub HTTP API request schemas and response shapes (plan §5.3–§5.6).

import { z } from "zod";
import type { Goal, Note, OfferState, Plan, PlanAc, Question, Step, StepFacts, StepKind, TrailFile } from "./goal.ts";
import { AcState, Failure, Findings, PlanInput, Verdict } from "./goal.ts";
import { AcceptPolicy, ShareLevel } from "./config.ts";
import { Repo, Session } from "./session.ts";

export const IDEMPOTENCY_HEADER = "idempotency-key";
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

export const SyncRequest = z.object({
  events: z.array(SyncEvent).max(500).default([]),
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
  machine: z.object({ share: ShareLevel, accept: AcceptPolicy.optional(), repos: z.array(Repo).max(500).optional() }).optional(),
});
export type SyncRequest = z.infer<typeof SyncRequest>;

/**
 * Reply to `POST /v1/sync`. `share`: the level the hub has stored for the token's machine (absent
 * when none was ever reported); a hub older than v0.1.10 answers `{ accepted }` only.
 */
export interface SyncResponse {
  accepted: number;
  share?: ShareLevel | undefined;
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

export const ProposePlan = PlanInput.extend({ approve: z.boolean().default(false) });
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
/** MM-3: body of `POST /v1/steps/:id/decline`. */
export const DeclineRequest = z.object({ note: z.string().max(2000).optional() });
export const ReleaseRequest = z.object({ note: z.string().max(4000).optional() });
export const NoteRequest = z.object({ text: z.string().min(1).max(8000), sid: z.string().optional() });
export const DoneRequest = z.object({
  summary: z.string().min(1).max(8000),
  outcome: z.enum(["done", "fail"]).default("done"),
  branch: z.string().max(200).optional(),
  mr: z.string().max(200).optional(),
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
});
export const GateDecision = z.object({ comment: z.string().max(4000).optional(), rule: z.string().max(60).optional(), inputs: z.record(z.string(), z.unknown()).optional(), reopen: z.array(z.string()).max(50).optional() });
export const ResumeRequest = z.object({ comment: z.string().max(4000).optional() });
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
  kind: "approval" | "question" | "failed" | "stalled" | "paused" | "parked" | "needs_you" | "offer" | "offer_expired";
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
