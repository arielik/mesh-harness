import { z } from "zod";

export const GoalState = z.enum(["backlog", "design", "awaiting_approval", "in_progress", "done", "dropped"]);
export type GoalState = z.infer<typeof GoalState>;

export const StepKind = z.enum(["design", "implement", "test", "review", "docs"]);
export type StepKind = z.infer<typeof StepKind>;

export const StepState = z.enum(["blocked", "ready", "claimed", "paused", "done", "failed", "dropped"]);
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
  updatedAt: z.number(),
});
export type Step = z.infer<typeof Step>;

const localId = z
  .string()
  .regex(/^[a-z0-9][a-z0-9-]{0,39}$/, "step ids are lower-case letters, digits and dashes (max 40)");

/** One step as written in a plan (`mesh goal plan`, `mesh_plan`). Ids are local to the goal. */
export const PlanStep = z.object({
  id: localId,
  repo: z.string().min(1),
  kind: StepKind.exclude(["design"]),
  title: z.string().min(1).max(200),
  brief: z.string().min(1).max(8000),
  deps: z.array(z.string()).default([]),
});
export type PlanStep = z.infer<typeof PlanStep>;

export const PlanInput = z.object({
  design_ref: z.string().optional(),
  steps: z.array(PlanStep),
});
export type PlanInput = z.infer<typeof PlanInput>;

/** `superseded`: replaced by a newer proposal before anyone decided (not a human request for changes). */
export const PlanDecision = z.enum(["pending", "approved", "revised", "superseded"]);

export const Plan = z.object({
  goal: z.string(),
  version: z.number().int(),
  designRef: z.string().optional(),
  steps: z.array(PlanStep),
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
