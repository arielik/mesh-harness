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
  issueUrl: z.string().optional(),
  priority: z.number().int(),
  createdAt: z.number(),
  updatedAt: z.number(),
});
export type Goal = z.infer<typeof Goal>;

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

export const PlanDecision = z.enum(["pending", "approved", "revised"]);

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
