import { parseAgentList, type AgentEntry } from "../protocol/index.ts";
import { run, type Runner } from "./exec.ts";

/** `claude agents --json --all` (spike S7: lists interactive and background sessions, ~0.12 s). */
export async function listAgents(runner: Runner = run): Promise<AgentEntry[] | null> {
  const r = await runner("claude", ["agents", "--json", "--all"], { timeoutMs: 10_000 });
  if (r.code !== 0) return null;
  return parseAgentList(r.stdout);
}
