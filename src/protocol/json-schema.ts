// JSON Schemas of what mesh hands to other tools (M4, 4.1): ledger records and export lines, hub
// events. Generated from the zod schemas; `pnpm schemas` writes schemas/*.json and a test fails when
// the committed files drift.

import { z } from "zod";
import { LedgerAgentStep, LedgerGoal, LedgerLine, LedgerPlan, LedgerStep } from "./ledger.ts";

/** A hub event as served by GET /v1/events and included by `mesh ledger export --events`. */
export const HubEvent = z.object({
  seq: z.number().int(),
  id: z.string(),
  at: z.number().describe("milliseconds since the epoch, hub clock (or the daemon's for synced events)"),
  type: z.string().describe("see docs/events.md"),
  user: z.string().optional(),
  sid: z.string().optional(),
  goal: z.string().optional(),
  step: z.string().optional(),
  payload: z.record(z.string(), z.unknown()),
});

export function jsonSchemas(): Record<string, unknown> {
  const gen = (s: z.ZodType, id: string, title: string) => ({ $id: `https://mesh.local/schemas/${id}.json`, title, ...z.toJSONSchema(s, { io: "input", unrepresentable: "any" }) });
  return {
    "ledger-goal": gen(LedgerGoal, "ledger-goal", "mesh.ledger.v1 goal record (.mesh/goals/<G>/goal.yaml)"),
    "ledger-plan": gen(LedgerPlan, "ledger-plan", "mesh.ledger.v1 plan record (.mesh/goals/<G>/plan.vN.yaml)"),
    "ledger-step": gen(LedgerStep, "ledger-step", "mesh.ledger.v1 step record (front matter of .mesh/goals/<G>/steps/<id>.md)"),
    "ledger-agent-step": gen(LedgerAgentStep, "ledger-agent-step", "mesh.ledger.v1 workflow agent record (front matter of .mesh/goals/<key>/steps/<role>.md)"),
    "ledger-line": gen(LedgerLine, "ledger-line", "one line of `mesh ledger export` (JSONL)"),
    "hub-event": gen(HubEvent, "hub-event", "one hub event (GET /v1/events)"),
  };
}
