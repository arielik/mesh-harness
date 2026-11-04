// The eight mesh MCP tools (plan §5.2): names, descriptions and input schemas, shared by the
// stdio shim (`mesh mcp`) and the daemon that executes them.

import { z } from "zod";
import { PlanStep } from "./goal.ts";

export const TOOLS = {
  mesh_context: {
    description: "Your mesh step (or what to do if you hold none): brief, design link, dependencies' summaries and branches, notes from earlier holders. Call it first.",
    input: {},
  },
  mesh_next: {
    description: "List ready mesh steps for this repo (or the given repo) that you could claim.",
    input: { repo: z.string().optional().describe("repo name or id; defaults to this session's repo") },
  },
  mesh_claim: {
    description: "Take a ready mesh step (e.g. G17.dplane) for this session.",
    input: { step: z.string().describe("full step id, e.g. G17.dplane") },
  },
  mesh_release: {
    description: "Give back the step this session holds, with a handoff note for whoever continues.",
    input: { note: z.string().optional().describe("what is done, what is left, gotchas") },
  },
  mesh_note: {
    description: "Record progress or handoff notes on your step so others (or a later session) can continue. Push your work-in-progress branch first.",
    input: { text: z.string().min(1) },
  },
  mesh_done: {
    description:
      "Finish your step. outcome 'done' completes it. A test or review step that found a problem in earlier steps uses outcome 'fail' and lists them in 'reopen' so they get fixed.",
    input: {
      summary: z.string().min(1).describe("what you did, in a few sentences"),
      branch: z.string().optional(),
      mr: z.string().optional().describe("merge request or pull request reference, e.g. !88"),
      outcome: z.enum(["done", "fail"]).optional(),
      reopen: z.array(z.string()).optional().describe("step ids to reopen when outcome is fail, e.g. ['dplane']"),
    },
  },
  mesh_ask: {
    description: "Ask your person (and the goal owner) a question. After calling it, end your turn and wait: the answer arrives as a message.",
    input: { question: z.string().min(1) },
  },
  mesh_plan: {
    description: "Design sessions only: propose the step plan (a DAG) for a goal after writing the design document. It waits for human approval.",
    input: {
      goal: z.string().describe("goal id, e.g. G17"),
      design_ref: z.string().optional().describe("where the design document is, e.g. repo@branch:path"),
      steps: z.array(PlanStep).min(1),
    },
  },
} as const;

export type ToolName = keyof typeof TOOLS;
export const TOOL_NAMES = Object.keys(TOOLS) as ToolName[];

/** POST /local/mcp/:tool from the shim to the daemon. */
export const ToolCall = z.object({ pid: z.number().int().positive(), args: z.record(z.string(), z.unknown()).default({}), key: z.string().min(8) });
export type ToolCall = z.infer<typeof ToolCall>;

export interface ToolResult {
  text: string;
  isError?: boolean;
}

/** Instructions added to the user's ~/.claude/CLAUDE.md by `mesh setup` (plan §4.6). */
export const CLAUDE_MD_BLOCK = [
  "<!-- mesh:begin (managed by `mesh setup`; remove with `mesh setup --uninstall`) -->",
  "## mesh",
  "If you hold a mesh step, or are told one is assigned, start with the `mesh_context` tool.",
  "Use `mesh_note` for progress others may need, and push your branch before long pauses.",
  "Finish a step with `mesh_done`; ask your person with `mesh_ask`, then end your turn.",
  "<!-- mesh:end -->",
].join("\n");
