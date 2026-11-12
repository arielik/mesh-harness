// The thirteen mesh MCP tools (plan §5.2): names, descriptions and input schemas, shared by the
// stdio shim (`mesh mcp`) and the daemon that executes them.

import { z } from "zod";
import { AcState, ArtifactKind, ArtifactMediaType, Failure, Findings, PlanAc, PlanStep, Verdict } from "./goal.ts";

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
      model: z.string().optional().describe("the model you are running as, e.g. claude-opus-5-5"),
      artifacts: z.array(z.string()).optional().describe("repo-relative paths of files this step produced (spec, review, plan, evidence)"),
      verdict: Verdict.optional().describe("reviews: approved | changes_requested | blocked; verify/test runs: pass | fail"),
      findings: Findings.optional().describe("reviews: how many findings are new, repeat, or regressions of the writer's own repairs"),
      blockers: z.number().int().min(0).optional().describe("reviews: blocking findings still open"),
      failures: z.array(Failure).optional().describe("verify/test runs: each failure with its bucket (spec-gap, impl-bug, test-bug, infra, unclear), criterion and the failing assertion"),
      acs: z.record(z.string(), AcState).optional().describe("only if your brief lists acceptance criteria (verify/test/review steps): each one by its id as met, not_met or unrun"),
      acs_addressed: z.array(z.string()).optional().describe("only if your brief lists acceptance criteria: the ids your work covers, e.g. ['AC-01']"),
    },
  },
  mesh_artifact: {
    description:
      "Store a report (or other output that is not part of the repo) on the hub for this step's round. The content is redacted for secrets on this machine first, then stored on the hub, where the team can read it.",
    input: {
      kind: ArtifactKind.describe("report | review | transcript"),
      title: z.string().max(200).optional(),
      media_type: ArtifactMediaType.optional().describe("text/markdown (default), application/json or text/plain"),
      content: z.string().min(1),
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
      acs: z.array(PlanAc).optional().describe("the acceptance criteria (id, text, surface, fails_when), if the design defines them"),
    },
  },
  mesh_fleet: {
    description: "Every machine logged in as your user and what each session on it is doing (read-only).",
    input: {},
  },
  mesh_assign: {
    description:
      "Offer a mesh goal or step to another machine or session (<machine>/<session>); it is accepted automatically if their accept policy allows, else it waits for them.",
    input: {
      target: z.string().describe("goal id (G17) or step id (G17.dplane)"),
      to: z.string().describe("machine nickname, id, or <machine>/<session>"),
      stick: z.boolean().optional().describe("goals: later ready steps of the goal go to the same target"),
      note: z.string().optional().describe("a note for the receiver"),
    },
  },
  mesh_offers: {
    description: "Steps offered to your machines, waiting for an accept.",
    input: {},
  },
  mesh_accept: {
    description: "Accept a step offered to this machine: this session takes it.",
    input: { step: z.string().describe("full step id, e.g. G17.dplane") },
  },
} as const;

export type ToolName = keyof typeof TOOLS;

/** RL-1: the permission rules every headless profile allows first, in this order. */
export const MESH_TOOL_RULES = ["mcp__mesh__mesh_context", "mcp__mesh__mesh_artifact", "mcp__mesh__mesh_review", "mcp__mesh__mesh_done"] as const;
export const TOOL_NAMES = Object.keys(TOOLS) as ToolName[];

/** POST /local/mcp/:tool from the shim to the daemon. */
export const ToolCall = z.object({
  pid: z.number().int().positive(),
  args: z.record(z.string(), z.unknown()).default({}),
  key: z.string().min(8),
  /** The agent's own session id when the agent names it in the MCP call (OpenCode's `_meta["ai.opencode/sessionID"]`). */
  agentSessionId: z.string().min(1).optional(),
});
export type ToolCall = z.infer<typeof ToolCall>;

export interface ToolResult {
  text: string;
  isError?: boolean;
}

/**
 * The block `mesh setup` used to add to ~/.claude/CLAUDE.md (plan §4.6). Since hooks v2 the `mesh`
 * skill replaces it; `mesh setup` removes the block when it finds one.
 */
export const CLAUDE_MD_BLOCK = [
  "<!-- mesh:begin (managed by `mesh setup`; remove with `mesh setup --uninstall`) -->",
  "## mesh",
  "If you hold a mesh step, or are told one is assigned, start with the `mesh_context` tool.",
  "Use `mesh_note` for progress others may need, and push your branch before long pauses.",
  "Finish a step with `mesh_done` (pass `model`, the model you run as, and `artifacts`, the files you produced); ask your person with `mesh_ask`, then end your turn.",
  "If a mesh tool says the hub is offline, keep working on the step you hold: mesh records it locally and sends it later.",
  "<!-- mesh:end -->",
].join("\n");
