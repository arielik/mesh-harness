import { z } from "zod";

export const GoalState = z.enum(["backlog", "design", "awaiting_approval", "in_progress", "done", "dropped"]);
export type GoalState = z.infer<typeof GoalState>;

/** Generic step kinds (M4.5 adds spec, plan, verify, merge and gate). Roles are free text. */
export const StepKind = z.enum(["design", "spec", "plan", "implement", "test", "verify", "review", "merge", "gate", "docs"]);
export type StepKind = z.infer<typeof StepKind>;

/** `parked`: stopped by a rule (round cap, churn, stall, an unrouted failure); a person decides. */
export const StepState = z.enum(["blocked", "ready", "claimed", "paused", "done", "failed", "parked", "dropped"]);
export type StepState = z.infer<typeof StepState>;

export const Goal = z.object({
  id: z.string(),
  title: z.string(),
  ownerId: z.string(),
  state: GoalState,
  primaryRepo: z.string().optional(),
  /** Other repos the design may touch (`mesh run --design` adds them with --add-dir). */
  repos: z.array(z.string()).optional(),
  issueUrl: z.string().optional(),
  /** Goals this one redoes (rework after merge). */
  reworks: z.array(z.string()).optional(),
  /** Plan template the design should follow (name and text), from `mesh goal new --preset`. */
  preset: z.object({ name: z.string(), text: z.string() }).optional(),
  /** Ids the team's own process uses for this work, e.g. {spec: "771", backlog: "NA-1054"}. */
  refs: z.record(z.string(), z.string()).optional(),
  priority: z.number().int(),
  createdAt: z.number(),
  updatedAt: z.number(),
});
export type Goal = z.infer<typeof Goal>;

/** A file a step produced, as given to mesh_done; sha is the git blob id when mesh could read the file. */
export const Artifact = z.object({ path: z.string().min(1).max(500), sha: z.string().optional() });
export type Artifact = z.infer<typeof Artifact>;

export const Bucket = z.enum(["spec-gap", "impl-bug", "test-bug", "infra", "unclear"]);
export type Bucket = z.infer<typeof Bucket>;
export const Verdict = z.enum(["approved", "changes_requested", "blocked", "pass", "fail"]);
export type Verdict = z.infer<typeof Verdict>;
export const AcState = z.enum(["met", "not_met", "unrun"]);
export type AcState = z.infer<typeof AcState>;
export const AcId = z.string().regex(/^[A-Za-z][A-Za-z0-9._-]{0,39}$/, "acceptance criterion ids look like AC-01");

export const Findings = z.object({ new: z.number().int().min(0), repeat: z.number().int().min(0), regression: z.number().int().min(0) });
export const Failure = z.object({ test: z.string().max(300).optional(), ac: AcId.optional(), bucket: Bucket, assertion: z.string().max(1000).optional() });
export type Failure = z.infer<typeof Failure>;

/** One mesh_done on a step: a step reopened for fixing has several rounds (M4, R3). */
export const Round = z.object({
  n: z.number().int().positive(),
  user: z.string(),
  sid: z.string().optional(),
  startedAt: z.number().optional(),
  finishedAt: z.number(),
  outcome: z.enum(["done", "fail"]),
  summary: z.string().optional(),
  /** Model the agent reported (mesh_done), when it did. */
  model: z.string().optional(),
  artifacts: z.array(Artifact).optional(),
  reopen: z.array(z.string()).optional(),
  branch: z.string().optional(),
  mr: z.string().optional(),
  // M4.5 (all optional): what the round found.
  verdict: Verdict.optional(),
  findings: Findings.optional(),
  blockers: z.number().int().min(0).optional(),
  failures: z.array(Failure).optional(),
  /** Per acceptance criterion: judged by verify/test/review steps. */
  acs: z.record(AcId, AcState).optional(),
  /** Criteria this round's work addresses (implementing and planning steps). */
  acsAddressed: z.array(AcId).optional(),
  /** The hub's reconcile check found criteria the step did not cover. */
  reconcile: z.object({ missing: z.array(AcId) }).optional(),
  /** Gate decisions: who, by which rule, with which inputs. */
  gate: z.object({ by: z.string(), rule: z.string().optional(), inputs: z.record(z.string(), z.unknown()).optional(), comment: z.string().optional() }).optional(),
  /** The rule that parked the step after this round. */
  parked: z.string().optional(),
});
export type Round = z.infer<typeof Round>;

export const Step = z.object({
  /** `<goal>.<local id>`, e.g. G17.dplane. */
  id: z.string(),
  goal: z.string(),
  planVersion: z.number().int(),
  kind: StepKind,
  repo: z.string(),
  title: z.string(),
  brief: z.string(),
  /** Full ids of the steps this one waits for. */
  deps: z.array(z.string()),
  state: StepState,
  holderUser: z.string().optional(),
  holderSid: z.string().optional(),
  holderMachine: z.string().optional(),
  branch: z.string().optional(),
  mr: z.string().optional(),
  summary: z.string().optional(),
  fixCycles: z.number().int(),
  outcome: z.enum(["done", "fail"]).optional(),
  claimedAt: z.number().optional(),
  pausedAt: z.number().optional(),
  /** When the current round started: first claim, or the reopen that started a fix cycle. */
  roundStartedAt: z.number().optional(),
  rounds: z.array(Round).optional(),
  /** Optional rules from the plan (M4.5); ids are local to the goal. */
  policy: z.lazy(() => StepPolicy).optional(),
  parkedReason: z.string().optional(),
  parkedAt: z.number().optional(),
  updatedAt: z.number(),
});
export type Step = z.infer<typeof Step>;

const localId = z
  .string()
  .regex(/^[a-z0-9][a-z0-9-]{0,39}$/, "step ids are lower-case letters, digits and dashes (max 40)");

/**
 * Optional rules a plan step may carry (M4.5). All generic: no roles engine, no workflow engine. A
 * plan without them works as before. Ids are local step ids of the same plan.
 */
export const StepPolicy = z.object({
  /** Free text, e.g. test-planner; grouped in the ledger. */
  role: z.string().max(60).optional(),
  /** Acceptance criteria this step covers or addresses. */
  acs: z.array(AcId).max(100).optional(),
  /** Steps this one must not see: their summary, notes, branch are hidden; their holders can't take it. */
  blind: z.array(localId).max(20).optional(),
  /** If set, the only dependencies whose summary and branch this step sees. */
  reads: z.array(localId).max(20).optional(),
  /** Paths the step's session may not read (best effort: Claude Code deny rules via `mesh run`). */
  forbid: z.array(z.string().min(1).max(200)).max(20).optional(),
  /** The shared contract (e.g. the spec's interface section) this step works from. */
  contract: z.string().max(300).optional(),
  /** Rounds before the step is parked for a person. */
  max_rounds: z.number().int().min(1).max(20).optional(),
  /** Park on churn (most findings regress the writer's own repairs) or stall (no new AC met). */
  park_on: z.array(z.enum(["churn", "stall"])).max(2).optional(),
  /** Where each failure bucket goes: a step to reopen, or park. */
  route: z.partialRecord(Bucket, z.union([localId, z.literal("park")])).optional(),
  /** For a review: the step its verdict is about (changes_requested reopens it). */
  target: localId.optional(),
  /** Reconcile: the step's acs_addressed must include all plan ACs (or these). */
  must_cover: z.union([z.literal("all"), z.array(AcId)]).optional(),
  /** `mesh run --step` makes a worktree and branch for it (base: from the goal's base, not HEAD). */
  worktree: z.union([z.boolean(), z.literal("base")]).optional(),
  /** The step (or goal) this one redoes. */
  reworks: z.string().max(100).optional(),
  /** For gate steps: the gate's name (R1, R2, R3). */
  gate: z.string().max(20).optional(),
});
export type StepPolicy = z.infer<typeof StepPolicy>;
export const POLICY_KEYS = Object.keys(StepPolicy.shape) as (keyof StepPolicy)[];

/** One step as written in a plan (`mesh goal plan`, `mesh_plan`). Ids are local to the goal. */
export const PlanStep = z.object({
  id: localId,
  repo: z.string().min(1),
  kind: StepKind.exclude(["design"]),
  title: z.string().min(1).max(200),
  brief: z.string().min(1).max(8000),
  deps: z.array(z.string()).default([]),
  ...StepPolicy.shape,
});
export type PlanStep = z.infer<typeof PlanStep>;

/** An acceptance criterion of the plan (optional, M4.5). */
export const PlanAc = z.object({ id: AcId, text: z.string().min(1).max(2000), surface: z.string().max(200).optional(), fails_when: z.string().max(2000).optional() });
export type PlanAc = z.infer<typeof PlanAc>;

export const PlanInput = z.object({
  design_ref: z.string().optional(),
  steps: z.array(PlanStep),
  acs: z.array(PlanAc).max(100).optional(),
});
export type PlanInput = z.infer<typeof PlanInput>;

/** `superseded`: replaced by a newer proposal before anyone decided (not a human request for changes). */
export const PlanDecision = z.enum(["pending", "approved", "revised", "superseded"]);

export const Plan = z.object({
  goal: z.string(),
  version: z.number().int(),
  designRef: z.string().optional(),
  steps: z.array(PlanStep),
  acs: z.array(PlanAc).optional(),
  proposedBy: z.string(),
  proposedAt: z.number(),
  decision: PlanDecision,
  decidedBy: z.string().optional(),
  decidedAt: z.number().optional(),
  comment: z.string().optional(),
});
export type Plan = z.infer<typeof Plan>;

export const Note = z.object({ id: z.number().int(), step: z.string(), user: z.string(), sid: z.string().optional(), text: z.string(), at: z.number() });
export type Note = z.infer<typeof Note>;

export const Question = z.object({
  id: z.number().int(),
  step: z.string().optional(),
  sid: z.string().optional(),
  fromUser: z.string(),
  toUsers: z.array(z.string()),
  text: z.string(),
  at: z.number(),
  answer: z.string().optional(),
  answeredBy: z.string().optional(),
  answeredAt: z.number().optional(),
});
export type Question = z.infer<typeof Question>;

/** Where a session's harness came from (M4, R2): hashes only, never file contents. */
export const Harness = z.object({ hash: z.string(), parts: z.record(z.string(), z.string()) });
export type Harness = z.infer<typeof Harness>;

/** One session's stretch of work on a step (M4, R2). */
export const Segment = z.object({
  sid: z.string(),
  user: z.string().optional(),
  from: z.number(),
  to: z.number().optional(),
  model: z.string().optional(),
  modelSource: z.enum(["hook", "agent", "workflow"]).optional(),
  effort: z.string().optional(),
  permissionMode: z.string().optional(),
  claudeCode: z.string().optional(),
  harness: Harness.optional(),
  repoCommit: z.string().optional(),
  mesh: z.string().optional(),
  turns: z.number().int(),
  humanPrompts: z.number().int(),
  nudges: z.number().int(),
  waits: z.object({ count: z.number().int(), minutes: z.number() }),
  activeMinutes: z.number(),
});
export type Segment = z.infer<typeof Segment>;

/** Facts about one step, computed from hub events (journeys doc §3.1). */
export const StepFacts = z.object({
  holders: z.array(z.object({ user: z.string(), from: z.number(), to: z.number().optional() })),
  sessions: z.array(z.string()),
  models: z.array(z.string()),
  turns: z.number().int(),
  humanPrompts: z.number().int(),
  nudges: z.number().int(),
  waits: z.object({ count: z.number().int(), minutes: z.number() }),
  fixCycles: z.number().int(),
  startedAt: z.number().optional(),
  finishedAt: z.number().optional(),
  segments: z.array(Segment).default([]),
});
export type StepFacts = z.infer<typeof StepFacts>;

/** A file mesh asks a session to commit (step records, plan versions, goal.yaml). */
export const TrailFile = z.object({ path: z.string(), text: z.string() });
export type TrailFile = z.infer<typeof TrailFile>;
