// Hub HTTP API request schemas and response shapes (plan §5.3–§5.6).

import { z } from "zod";
import type { Goal, Note, Plan, Question, Step, StepFacts, TrailFile } from "./goal.ts";
import { PlanInput } from "./goal.ts";
import { Session } from "./session.ts";

export const IDEMPOTENCY_HEADER = "idempotency-key";
export const SESSION_COOKIE = "mesh_session";

/** Observation spooled by a daemon (plan §5.3). Ids make replays harmless. */
export const SyncEvent = z.object({
  id: z.string().uuid(),
  at: z.number(),
  type: z.string().regex(/^(session|message)\.[a-z_]+$/),
  sid: z.string().optional(),
  step: z.string().optional(),
  payload: z.record(z.string(), z.unknown()).default({}),
});
export type SyncEvent = z.infer<typeof SyncEvent>;

export const SyncRequest = z.object({
  events: z.array(SyncEvent).max(500).default([]),
  /** Full records of sessions that hold a step (others stay private, Q5). */
  sessions: z.array(Session).max(200).default([]),
  /** Session counts by state for the whole machine. */
  counts: z.record(z.string(), z.number().int()).default({}),
});
export type SyncRequest = z.infer<typeof SyncRequest>;

export const AckRequest = z.object({ state: z.enum(["delivered", "failed"]), method: z.string().optional() });

export const LoginDirect = z.object({ token: z.string().optional(), hostname: z.string().max(200).optional(), client: z.enum(["cli", "web"]).default("cli") });
export const CliExchange = z.object({ code: z.string(), verifier: z.string(), hostname: z.string().max(200).optional() });
export const DevicePoll = z.object({ pollId: z.string(), hostname: z.string().max(200).optional() });

export const NewGoal = z.object({
  title: z.string().min(1).max(200),
  primaryRepo: z.string().optional(),
  issueUrl: z.string().url().optional(),
  repos: z.array(z.string()).max(20).optional(),
  priority: z.number().int().min(0).max(9).default(3),
});

export const ProposePlan = PlanInput.extend({ approve: z.boolean().default(false) });
export const Replan = z.object({ comment: z.string().max(4000).optional() });
export const Decide = z.object({ comment: z.string().max(4000).optional() });
export const Approve = Decide.extend({ version: z.number().int().positive().optional() });

export const ClaimRequest = z.object({ sid: z.string().optional() });
export const ReleaseRequest = z.object({ note: z.string().max(4000).optional() });
export const NoteRequest = z.object({ text: z.string().min(1).max(8000), sid: z.string().optional() });
export const DoneRequest = z.object({
  summary: z.string().min(1).max(8000),
  outcome: z.enum(["done", "fail"]).default("done"),
  branch: z.string().max(200).optional(),
  mr: z.string().max(200).optional(),
  reopen: z.array(z.string()).default([]),
  sid: z.string().optional(),
});
export const AskRequest = z.object({ text: z.string().min(1).max(4000), sid: z.string().optional(), step: z.string().optional() });
export const AnswerRequest = z.object({ text: z.string().min(1).max(4000) });
export const MessageRequest = z.object({ toSid: z.string().optional(), toStep: z.string().optional(), text: z.string().min(1).max(8000) }).refine((m) => m.toSid || m.toStep, "toSid or toStep is required");

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
}

export interface DoneResult {
  step: Step;
  reopened: string[];
  nowReady: string[];
  goalDone: boolean;
  /** The step record to commit with the work (`.mesh/goals/<G>/steps/<id>.md`). */
  record?: TrailFile | undefined;
}

export interface GoalDetail {
  goal: Goal;
  steps: Step[];
  plans: Plan[];
  /** Live state of each holder's session, by step id (stalled, needs you, …). */
  holders?: Record<string, { sid: string; state: string; needs?: string | undefined; user: string }> | undefined;
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
}

export interface LiveMachine {
  id: string;
  hostname: string;
  online: boolean;
  lastSeen: number;
  counts: Record<string, number>;
}

export interface Attention {
  kind: "approval" | "question" | "failed" | "stalled" | "paused" | "needs_you";
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
  goals: { id: string; title: string; state: string; owner: string; done: number; total: number; holders: string[] }[];
  attention: Attention[];
  activity: { seq: number; at: number; type: string; user?: string | undefined; goal?: string | undefined; step?: string | undefined; text: string }[];
}
