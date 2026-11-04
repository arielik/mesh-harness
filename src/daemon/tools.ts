// Execution of the eight mesh MCP tools (plan §5.2). The shim sends the Claude pid; the daemon
// finds the session, calls the hub, and keeps the session's step binding up to date.

import { repoMatches, pickNext } from "../core/index.ts";
import { PlanStep, TOOLS, type DoneResult, type Session, type Step, type StepContext, type ToolName, type ToolResult, type TrailFile } from "../protocol/index.ts";
import { HubRpcError, type HubLink } from "./hub-link.ts";
import { commitHint, writeTrail } from "./trail.ts";

export interface ToolHost {
  link: HubLink;
  /** Update a session record (step binding, asked flag, nudge counters). */
  update(sid: string, patch: Partial<Session> & { clearStep?: boolean }): Session | undefined;
  /** Queue a local message for a session (delivered by the usual chain). */
  queue(sid: string, text: string): void;
  autopilotOf(s: Session): "off" | "nudge" | "chain";
}

const ok = (text: string): ToolResult => ({ text });
const fail = (text: string): ToolResult => ({ text, isError: true });

function fmtStep(s: Step): string {
  return `${s.id} [${s.state}] (${s.kind}, repo ${s.repo || "-"}) ${s.title}`;
}

export function brief(ctx: StepContext): string {
  const lines = [
    `You hold mesh step ${ctx.step.id}: ${ctx.step.title}`,
    `Goal ${ctx.goal.id}: ${ctx.goal.title}`,
    `Kind: ${ctx.step.kind}. Repo: ${ctx.step.repo || "(any)"}. State: ${ctx.step.state}.${ctx.step.fixCycles ? ` Fix cycle ${ctx.step.fixCycles}.` : ""}`,
  ];
  if (ctx.designRef) lines.push(`Design: ${ctx.designRef}`);
  lines.push("", "Brief:", ctx.step.brief);
  if (ctx.deps.length) {
    lines.push("", "Dependencies:");
    for (const d of ctx.deps) lines.push(`- ${d.id} [${d.state}] ${d.title}${d.summary ? ` — ${d.summary}` : ""}${d.branch ? ` (branch ${d.branch})` : ""}${d.mr ? ` (${d.mr})` : ""}`);
  }
  if (ctx.notes.length) {
    lines.push("", "Notes from earlier work:");
    for (const n of ctx.notes) lines.push(`- ${n.user}: ${n.text}`);
  }
  if (ctx.openQuestions.length) {
    lines.push("", "Open questions:");
    for (const q of ctx.openQuestions) lines.push(`- ${q.fromUser}: ${q.text}`);
  }
  lines.push("", "When finished call mesh_done (outcome fail + reopen if you found problems in earlier steps). Use mesh_note for progress.");
  return lines.join("\n");
}

export function stepMessage(step: string): string {
  return `MESH: your next step is ${step}. Call mesh_context to read its brief, then work on it.`;
}

/** Ready steps for a repo, sorted with the session's goal first. */
async function readySteps(host: ToolHost, repo: string | undefined): Promise<Step[]> {
  const q = repo ? `&repo=${encodeURIComponent(repo)}` : "";
  return (await host.link.rpc<{ steps: Step[] }>("GET", `/v1/steps?ready=1${q}`)).steps;
}

export async function runTool(host: ToolHost, s: Session, tool: ToolName, rawArgs: Record<string, unknown>, key: string): Promise<ToolResult> {
  try {
    return await dispatch(host, s, tool, rawArgs, key);
  } catch (e) {
    if (e instanceof HubRpcError) {
      const details = Array.isArray(e.details) ? `\n- ${(e.details as string[]).join("\n- ")}` : "";
      return fail(`${e.message}${details}`);
    }
    if (e instanceof Error && e.name === "ZodError") return fail(`invalid arguments: ${e.message}`);
    throw e;
  }
}

async function dispatch(host: ToolHost, s: Session, tool: ToolName, rawArgs: Record<string, unknown>, key: string): Promise<ToolResult> {
  const { z } = await import("zod");
  const args = z.object(TOOLS[tool].input as Record<string, never>).parse(rawArgs) as Record<string, unknown>;
  const repoId = s.repo?.id;

  switch (tool) {
    case "mesh_context": {
      if (s.step) return ok(brief(await host.link.rpc<StepContext>("GET", `/v1/steps/${encodeURIComponent(s.step)}/context`)));
      const steps = await readySteps(host, repoId);
      return ok(
        steps.length
          ? `This session holds no mesh step. Ready steps for ${s.repo?.name ?? "this repo"}:\n${steps.map(fmtStep).join("\n")}\nClaim one with mesh_claim if you were asked to pick work.`
          : `This session holds no mesh step, and no step is ready for ${s.repo?.name ?? "this repo"}. Work on what your person asked.`,
      );
    }
    case "mesh_next": {
      const steps = await readySteps(host, (args.repo as string | undefined) ?? repoId);
      return ok(steps.length ? steps.map(fmtStep).join("\n") : "No ready steps.");
    }
    case "mesh_claim": {
      const id = String(args.step);
      const step = await host.link.rpc<Step>("POST", `/v1/steps/${encodeURIComponent(id)}/claim`, { sid: s.sid }, key);
      host.update(s.sid, { step: step.id, nudges: 0, escalated: false });
      const ctx = await host.link.rpc<StepContext>("GET", `/v1/steps/${encodeURIComponent(step.id)}/context`);
      return ok(brief(ctx));
    }
    case "mesh_release": {
      if (!s.step) return fail("this session holds no step");
      await host.link.rpc("POST", `/v1/steps/${encodeURIComponent(s.step)}/release`, { note: args.note }, key);
      host.update(s.sid, { clearStep: true });
      return ok(`Released ${s.step}.`);
    }
    case "mesh_note": {
      if (!s.step) return fail("this session holds no step; claim one first");
      await host.link.rpc("POST", `/v1/steps/${encodeURIComponent(s.step)}/note`, { text: args.text, sid: s.sid }, key);
      return ok("Noted.");
    }
    case "mesh_done": {
      if (!s.step) return fail("this session holds no step");
      const outcome = (args.outcome as "done" | "fail" | undefined) ?? "done";
      const r = await host.link.rpc<DoneResult>(
        "POST",
        `/v1/steps/${encodeURIComponent(s.step)}/done`,
        { summary: args.summary, branch: args.branch, mr: args.mr, outcome, reopen: args.reopen ?? [], sid: s.sid },
        key,
      );
      host.update(s.sid, { clearStep: true });
      const lines = [`${r.step.id} is ${r.step.state}.`];
      if (r.record) {
        const w = writeTrail(s.cwd, [r.record]);
        if (w.written.length) lines.push(`mesh wrote the step record ${w.written[0]}. ${commitHint(w.written)}`);
        else lines.push(`Step record (save as ${r.record.path} and commit it):\n${r.record.text}`);
      }
      if (r.reopened.length) lines.push(`Reopened for fixing: ${r.reopened.join(", ")}.`);
      if (r.goalDone) lines.push(`Goal ${r.step.goal} is done.`);
      if (outcome === "done" && host.autopilotOf(s) === "chain") {
        const ready = await readySteps(host, repoId);
        const sameRepo = (repo: string) => !repo || !s.repo || repoMatches(s.repo, repo);
        const next = pickNext(r.step, ready, sameRepo);
        if (next) {
          try {
            const claimed = await host.link.rpc<Step>("POST", `/v1/steps/${encodeURIComponent(next.id)}/claim`, { sid: s.sid }, `${key}:chain`);
            host.update(s.sid, { step: claimed.id, nudges: 0, escalated: false });
            host.queue(s.sid, stepMessage(claimed.id));
            lines.push(`Autopilot claimed your next step: ${claimed.id}. Its brief arrives when this turn ends.`);
          } catch {
            // someone else took it; nothing to chain
          }
        }
      }
      return ok(lines.join(" "));
    }
    case "mesh_ask": {
      await host.link.rpc("POST", "/v1/questions", { text: args.question, sid: s.sid, ...(s.step ? { step: s.step } : {}) }, key);
      host.update(s.sid, { asked: true });
      return ok("Asked. End your turn now; the answer will arrive as a message.");
    }
    case "mesh_plan": {
      const steps = z.array(PlanStep).parse(args.steps);
      const r = await host.link.rpc<{ plan: { version: number; goal: string } }>(
        "POST",
        `/v1/goals/${encodeURIComponent(String(args.goal))}/plan`,
        { design_ref: args.design_ref, steps, approve: false },
        key,
      );
      const { files } = await host.link.rpc<{ files: TrailFile[] }>("GET", `/v1/goals/${encodeURIComponent(r.plan.goal)}/files`);
      const w = writeTrail(s.cwd, files.filter((f) => f.path.endsWith("goal.yaml") || f.path.endsWith(`plan.v${r.plan.version}.yaml`)));
      return ok(
        `Plan v${r.plan.version} for ${r.plan.goal} proposed with ${steps.length} steps. ${w.written.length ? `mesh wrote ${w.written.join(" and ")}. ${commitHint(w.written)} together with the design document. ` : ""}It waits for approval; you'll get a message when it is approved or needs changes. End your turn.`,
      );
    }
  }
}
