import { z } from "zod";

/** One entry of `claude agents --json --all` (spike S7, fixtures in test/fixtures/claude/agents). */
export const AgentEntry = z.looseObject({
  kind: z.string(),
  cwd: z.string().optional(),
  sessionId: z.string().optional(),
  pid: z.number().int().optional(),
  id: z.string().optional(),
  name: z.string().optional(),
  startedAt: z.number().optional(),
  status: z.string().optional(),
  waitingFor: z.string().optional(),
  state: z.string().optional(),
});
export type AgentEntry = z.infer<typeof AgentEntry>;

export const AgentList = z.array(AgentEntry);

/** Parse `claude agents --json` output; returns null when it isn't a valid list. */
export function parseAgentList(stdout: string): AgentEntry[] | null {
  try {
    const parsed = AgentList.safeParse(JSON.parse(stdout));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}
