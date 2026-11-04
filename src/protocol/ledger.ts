// mesh.ledger.v1: the records mesh writes into repos under .mesh/goals/** (M4, R1). Generated, never
// hand-written. Readers accept unknown fields: new fields are always optional (additive evolution).

import { z } from "zod";

export const LEDGER_SCHEMA = "mesh.ledger.v1";
export const LedgerRecordKind = z.enum(["goal", "plan", "step", "agent-step"]);
export type LedgerRecordKind = z.infer<typeof LedgerRecordKind>;

const base = { schema: z.literal(LEDGER_SCHEMA), record: LedgerRecordKind };
const time = z.string().regex(/^\d{4}-\d\d-\d\dT\d\d:\d\d(:\d\d)?Z$/, "an ISO time (UTC, minutes or seconds)");
const int = z.number().int();
const waits = z.object({ count: int, minutes: z.number() }).describe("times the agent waited on a person, and for how long");
const harness = z.object({ hash: z.string(), parts: z.record(z.string(), z.string()) }).describe("hashes of repo CLAUDE.md+.claude/**, user CLAUDE.md/agents/skills, plugins, mesh version");
const artifact = z.object({ path: z.string(), sha: z.string().optional().describe("git blob id when mesh could read the file") });

export const LedgerGoal = z.looseObject({
  ...base,
  record: z.literal("goal"),
  id: z.string(),
  title: z.string(),
  owner: z.string(),
  state: z.string().optional(),
  primary_repo: z.string().optional(),
  repos: z.array(z.string()).optional(),
  issue: z.string().optional(),
  refs: z.record(z.string(), z.string()).optional().describe("the team's own ids, e.g. {spec: '771', backlog: 'NA-1054'}"),
  created: time.optional(),
  done: time.optional(),
  rollup: z
    .looseObject({
      steps: int,
      done: int,
      dropped: int,
      rounds: int,
      fix_cycles: int,
      plan_versions: int,
      design_rounds: int.describe("plan versions a person sent back (revised); superseded ones do not count"),
      people: z.array(z.string()),
      models: z.array(z.string()),
      harnesses: z.array(z.string()),
      human_prompts: int,
      nudges: int,
      wait_minutes: z.number(),
      active_minutes: z.number(),
      lead_time_hours: z.number().optional(),
      by_kind: z.record(z.string(), z.object({ steps: int, rounds: int, fix_cycles: int, minutes: z.number() })),
    })
    .optional()
    .describe("totals, written when the goal is done"),
});

export const LedgerPlan = z.looseObject({
  ...base,
  record: z.literal("plan"),
  goal: z.string(),
  version: int,
  design: z.string().optional(),
  proposed: z.object({ by: z.string(), at: time }).optional(),
  decision: z.enum(["pending", "approved", "revised", "superseded"]),
  decided: z.object({ by: z.string().optional(), at: time.optional(), comment: z.string().optional() }).optional(),
  steps: z.array(z.looseObject({ id: z.string(), kind: z.string(), repo: z.string().optional(), title: z.string().optional(), deps: z.array(z.string()).optional(), brief: z.string().optional() })),
});

const segment = z.looseObject({
  sid: z.string(),
  user: z.string().optional(),
  from: time,
  to: time.optional(),
  model: z.string().optional(),
  model_source: z.enum(["hook", "agent", "workflow"]).optional(),
  effort: z.string().optional(),
  permission_mode: z.string().optional(),
  claude_code: z.string().optional(),
  harness: harness.optional(),
  repo_commit: z.string().optional(),
  mesh: z.string().optional(),
  turns: int.optional(),
  human_prompts: int.optional(),
  nudges: int.optional(),
  waits: waits.optional(),
  active_minutes: z.number().optional(),
});

const round = z.looseObject({
  n: int,
  user: z.string().optional(),
  started: time.optional(),
  finished: time,
  minutes: z.number().optional(),
  outcome: z.string(),
  model: z.string().optional(),
  reopen: z.array(z.string()).optional(),
  artifacts: z.array(artifact).optional(),
  summary: z.string().optional(),
});

export const LedgerStep = z.looseObject({
  ...base,
  record: z.literal("step"),
  goal: z.string(),
  step: z.string(),
  kind: z.string(),
  repo: z.string().optional(),
  plan: z.string().optional(),
  plan_approved: z.object({ by: z.string(), at: time.optional() }).optional(),
  holders: z.array(z.object({ user: z.string(), from: time, to: time.optional() })).optional(),
  sessions: z.array(z.string()).optional(),
  models: z.array(z.string()).optional(),
  turns: int.optional(),
  human_prompts: int.optional().describe("prompts a person typed (messages mesh delivered are not counted)"),
  nudges: int.optional(),
  waits: waits.optional(),
  active_minutes: z.number().optional(),
  fix_cycles: int.optional(),
  outcome: z.string(),
  mr: z.string().optional(),
  branch: z.string().optional(),
  started: time.optional(),
  finished: time.optional(),
  artifacts: z.array(artifact).optional(),
  recorded_offline: z.boolean().optional().describe("written by the daemon while the hub was offline"),
  segments: z.array(segment).optional(),
  rounds: z.array(round).optional(),
});

/** A role in a workflow programme (one Claude session, many subagents), keyed by the team's own id. */
export const LedgerAgentStep = z.looseObject({
  ...base,
  record: z.literal("agent-step"),
  key: z.string().describe("the team's id from the label, e.g. NA-1054"),
  role: z.string(),
  name: z.string(),
  workflow: z.string().optional(),
  models: z.array(z.string()).optional(),
  rounds_count: int.optional(),
  started: time.optional(),
  finished: time.optional(),
  rounds: z.array(
    z.looseObject({
      n: int,
      label: z.string(),
      agent_id: z.string(),
      workflow_run: z.string().optional(),
      phase: z.string().optional(),
      model: z.string().optional(),
      model_source: z.literal("workflow").optional(),
      started: time.optional(),
      finished: time.optional(),
      duration_s: z.number().optional(),
      attempt: int.optional(),
      state: z.string().optional(),
      tool_calls: int.optional(),
      result: z.unknown().optional().describe("the agent's typed result (workflow schema), long strings cut to 300 characters"),
    }),
  ),
});

export const LedgerRecord = z.discriminatedUnion("record", [LedgerGoal, LedgerPlan, LedgerStep, LedgerAgentStep]);
export type LedgerRecord = z.infer<typeof LedgerRecord>;

/** One line of `mesh ledger export` (JSONL): a committed record, or a hub event (--events). */
export const LedgerLine = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("record"), repo: z.string(), path: z.string(), ref: z.string(), commit: z.string(), record: z.record(z.string(), z.unknown()) }),
  z.object({ kind: z.literal("event"), event: z.record(z.string(), z.unknown()) }),
]);
export type LedgerLine = z.infer<typeof LedgerLine>;
