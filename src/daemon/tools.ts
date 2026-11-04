// Execution of the eight mesh MCP tools (plan §5.2). The shim sends the Claude pid; the daemon
// finds the session, calls the hub, and keeps the session's step binding up to date.
//
// Local-first (M4): with the hub offline, the step a session holds keeps working. mesh_context
// answers from the last copy, mesh_done writes the record from local facts and queues the call,
// mesh_note / mesh_release / mesh_ask are queued. Only actions that need other people (claiming
// shared work, proposing a plan) say "offline", at once.

import { join } from "node:path";
import { pickNext, repoMatches, stepFacts, stepRecord, type FactEvent } from "../core/index.ts";
import { PlanStep, TOOLS, type DoneResult, type Session, type Step, type StepContext, type ToolName, type ToolResult, type TrailFile } from "../protocol/index.ts";
import type { PendingCall } from "../store/index.ts";
import { blobSha, findRepoRoot } from "./git.ts";
import { HubRpcError, type HubLink } from "./hub-link.ts";
import { commitHint, writeTrail } from "./trail.ts";

export interface ToolLocal {
  now(): number;
  cache(ctx: StepContext): void;
  cached(step: string): { ctx: StepContext; at: number } | undefined;
  /** Events the daemon recorded for a step (facts for an offline record). */
  events(step: string): FactEvent[];
  queueCall(call: PendingCall): void;
}

export interface ToolHost {
  link: HubLink;
  local: ToolLocal;
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

const isOffline = (e: unknown) => e instanceof HubRpcError && e.status === 503;
const OFFLINE_TAIL = "You can keep working on the step you hold; claiming new work and plans need the hub.";

export async function runTool(host: ToolHost, s: Session, tool: ToolName, rawArgs: Record<string, unknown>, key: string): Promise<ToolResult> {
  try {
    return await dispatch(host, s, tool, rawArgs, key);
  } catch (e) {
    if (e instanceof HubRpcError) {
      const details = Array.isArray(e.details) ? `\n- ${(e.details as string[]).join("\n- ")}` : "";
      return fail(isOffline(e) ? `${e.message}. ${OFFLINE_TAIL}` : `${e.message}${details}`);
    }
    if (e instanceof Error && e.name === "ZodError") return fail(`invalid arguments: ${e.message}`);
    throw e;
  }
}

/** Call the hub; while it is offline, queue the call and return undefined instead. */
async function orQueue<T>(host: ToolHost, path: string, body: Record<string, unknown>, key: string, label: string, cwd?: string): Promise<T | undefined> {
  try {
    return await host.link.rpc<T>("POST", path, body, key);
  } catch (e) {
    if (!isOffline(e)) throw e;
    host.local.queueCall({ key, at: host.local.now(), method: "POST", path, body, label, cwd });
    return undefined;
  }
}

async function contextOf(host: ToolHost, step: string): Promise<{ ctx: StepContext; offlineSince?: number }> {
  try {
    const ctx = await host.link.rpc<StepContext>("GET", `/v1/steps/${encodeURIComponent(step)}/context`);
    host.local.cache(ctx);
    return { ctx };
  } catch (e) {
    const c = isOffline(e) ? host.local.cached(step) : undefined;
    if (!c) throw e;
    return { ctx: c.ctx, offlineSince: c.at };
  }
}

/** Artifacts as given by the agent, with their git blob ids when the files exist. */
function artifactsOf(cwd: string, paths: unknown): { path: string; sha?: string }[] | undefined {
  if (!Array.isArray(paths) || paths.length === 0) return undefined;
  const root = findRepoRoot(cwd);
  return paths
    .filter((p): p is string => typeof p === "string" && p.length > 0)
    .slice(0, 50)
    .map((p) => {
      const sha = root && !p.startsWith("/") && !p.includes("..") ? blobSha(join(root, p)) : undefined;
      return { path: p, ...(sha ? { sha } : {}) };
    });
}

async function dispatch(host: ToolHost, s: Session, tool: ToolName, rawArgs: Record<string, unknown>, key: string): Promise<ToolResult> {
  const { z } = await import("zod");
  const args = z.object(TOOLS[tool].input as Record<string, never>).parse(rawArgs) as Record<string, unknown>;
  const repoId = s.repo?.id;

  switch (tool) {
    case "mesh_context": {
      if (s.step) {
        const { ctx, offlineSince } = await contextOf(host, s.step);
        const tail = offlineSince ? `\n\n(mesh: the hub is offline; this is the brief as of ${new Date(offlineSince).toISOString().slice(0, 16)}Z. Keep working; mesh_done and mesh_note are recorded locally and sent later.)` : "";
        return ok(brief(ctx) + tail);
      }
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
      const { ctx } = await contextOf(host, step.id);
      return ok(brief(ctx));
    }
    case "mesh_release": {
      if (!s.step) return fail("this session holds no step");
      const r = await orQueue(host, `/v1/steps/${encodeURIComponent(s.step)}/release`, { note: args.note }, key, `mesh_release ${s.step}`, s.cwd);
      host.update(s.sid, { clearStep: true });
      return ok(r === undefined ? `Released ${s.step} locally; the hub is offline and gets it when it is back.` : `Released ${s.step}.`);
    }
    case "mesh_note": {
      if (!s.step) return fail("this session holds no step; claim one first");
      const r = await orQueue(host, `/v1/steps/${encodeURIComponent(s.step)}/note`, { text: args.text, sid: s.sid }, key, `mesh_note ${s.step}`, s.cwd);
      return ok(r === undefined ? "Noted locally (the hub is offline; it gets the note when it is back)." : "Noted.");
    }
    case "mesh_done": {
      if (!s.step) return fail("this session holds no step");
      const outcome = (args.outcome as "done" | "fail" | undefined) ?? "done";
      const now = host.local.now();
      const artifacts = artifactsOf(s.cwd, args.artifacts);
      const body = {
        summary: args.summary,
        branch: args.branch,
        mr: args.mr,
        outcome,
        reopen: args.reopen ?? [],
        sid: s.sid,
        at: now,
        ...(typeof args.model === "string" && args.model ? { model: args.model } : {}),
        ...(artifacts ? { artifacts } : {}),
      };
      let r: DoneResult | undefined;
      try {
        r = await host.link.rpc<DoneResult>("POST", `/v1/steps/${encodeURIComponent(s.step)}/done`, body, key);
      } catch (e) {
        if (!isOffline(e)) throw e;
        return doneOffline(host, s, s.step, body, key);
      }
      host.update(s.sid, { clearStep: true });
      const lines = [`${r.step.id} is ${r.step.state}.`];
      if (r.record) {
        const w = writeTrail(s.cwd, [r.record, ...(r.files ?? [])]);
        if (w.written.length) lines.push(`mesh wrote ${w.written.length === 1 ? "the step record" : "the step record and goal file"} ${w.written.join(", ")}. ${commitHint(w.written)}`);
        else lines.push(`Step record (save as ${r.record.path} and commit it):\n${r.record.text}`);
      }
      if (r.reopened.length) lines.push(`Reopened for fixing: ${r.reopened.join(", ")}.`);
      if (r.goalDone) lines.push(`Goal ${r.step.goal} is done.`);
      if (outcome === "done" && host.autopilotOf(s) === "chain") {
        const ready = await readySteps(host, repoId).catch(() => [] as Step[]);
        const sameRepo = (repo: string) => !repo || !s.repo || repoMatches(s.repo, repo);
        const next = pickNext(r.step, ready, sameRepo);
        if (next) {
          try {
            const claimed = await host.link.rpc<Step>("POST", `/v1/steps/${encodeURIComponent(next.id)}/claim`, { sid: s.sid }, `${key}:chain`);
            host.update(s.sid, { step: claimed.id, nudges: 0, escalated: false });
            host.queue(s.sid, stepMessage(claimed.id));
            lines.push(`Autopilot claimed your next step: ${claimed.id}. Its brief arrives when this turn ends.`);
          } catch {
            // someone else took it, or the hub went away; nothing to chain
          }
        }
      }
      return ok(lines.join(" "));
    }
    case "mesh_ask": {
      const r = await orQueue(host, "/v1/questions", { text: args.question, sid: s.sid, ...(s.step ? { step: s.step } : {}) }, key, "mesh_ask", s.cwd);
      host.update(s.sid, { asked: true });
      return ok(r === undefined ? "Asked locally: the hub is offline, so the question waits until it is back. End your turn now; the answer will arrive as a message." : "Asked. End your turn now; the answer will arrive as a message.");
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

/** mesh_done while the hub is offline: record locally from local facts, send later (M4, 4.0.4). */
function doneOffline(host: ToolHost, s: Session, stepId: string, body: Record<string, unknown> & { at: number }, key: string): ToolResult {
  const cached = host.local.cached(stepId);
  host.local.queueCall({ key, at: body.at, method: "POST", path: `/v1/steps/${encodeURIComponent(stepId)}/done`, body, label: `mesh_done ${stepId}`, cwd: s.cwd });
  host.update(s.sid, { clearStep: true });
  if (!cached) return ok(`The hub is offline. mesh recorded your mesh_done for ${stepId} and sends it when the hub is back; the step record follows then.`);
  const prev = cached.ctx.step;
  const outcome = body.outcome as "done" | "fail";
  const round = {
    n: (prev.rounds?.length ?? 0) + 1,
    user: prev.holderUser ?? "me",
    sid: s.sid,
    ...(prev.roundStartedAt ?? prev.claimedAt ? { startedAt: (prev.roundStartedAt ?? prev.claimedAt) as number } : {}),
    finishedAt: body.at,
    outcome,
    summary: String(body.summary),
    ...(typeof body.model === "string" ? { model: body.model } : {}),
    ...(Array.isArray(body.artifacts) ? { artifacts: body.artifacts as { path: string; sha?: string }[] } : {}),
  };
  const step: Step = {
    ...prev,
    state: outcome === "done" ? "done" : "failed",
    outcome,
    summary: String(body.summary),
    ...(typeof body.branch === "string" ? { branch: body.branch } : {}),
    ...(typeof body.mr === "string" ? { mr: body.mr } : {}),
    rounds: [...(prev.rounds ?? []), round],
    updatedAt: body.at,
  };
  const events: FactEvent[] = [
    ...(prev.claimedAt !== undefined ? [{ at: prev.claimedAt, type: "step.claimed", user: round.user, sid: s.sid, step: stepId, payload: {} }] : []),
    ...host.local.events(stepId),
    { at: body.at, type: outcome === "done" ? "step.done" : "step.failed", user: round.user, sid: s.sid, step: stepId, payload: {} },
  ];
  const record = stepRecord(step, stepFacts(step, events), cached.ctx.notes.filter((n) => !n.text.startsWith("Reopened by")));
  const text = record.text.replace(/^---\n/, "---\nrecorded_offline: true\n");
  const w = writeTrail(s.cwd, [{ path: record.path, text }]);
  return ok(
    `The hub is offline: mesh recorded ${stepId} as ${step.state} locally${w.written.length ? ` and wrote the step record ${w.written[0]}. ${commitHint(w.written)}` : ""}. The hub gets it when it is back (facts from other people's sessions are added then).`,
  );
}
