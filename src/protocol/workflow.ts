// One subagent run inside a Claude Code session (Task or workflow agent()), as mesh captures it from
// the SubagentStart/SubagentStop hooks and Claude Code's own workflow files (M4, workflow capture).

import { z } from "zod";

export const AgentRun = z.object({
  agentId: z.string(),
  /** Claude session that ran it, and the mesh session when the daemon knows it. */
  claudeSessionId: z.string(),
  sid: z.string().optional(),
  cwd: z.string(),
  /** agent_type: the role (spec-writer, reviewer, ...). */
  role: z.string(),
  /** The workflow's label, e.g. "reviewer:ROW-42:r2", or a Task description. */
  label: z.string().optional(),
  phase: z.string().optional(),
  workflowRun: z.string().optional(),
  workflowName: z.string().optional(),
  model: z.string().optional(),
  startedAt: z.number().optional(),
  finishedAt: z.number().optional(),
  durationMs: z.number().optional(),
  attempt: z.number().int().optional(),
  state: z.string().optional(),
  toolCalls: z.number().int().optional(),
  /** The agent's typed result (a workflow schema: result), when it had one. */
  result: z.unknown().optional(),
});
export type AgentRun = z.infer<typeof AgentRun>;
