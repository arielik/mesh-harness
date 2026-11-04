// Readers for Claude Code's own records of subagents (M4, workflow capture). Verified against Claude
// Code 2.1.318 (docs/analysis/2026-11-04-local-first-and-workflow-capture.md §2); the contract suite
// (pnpm test:claude) re-checks the format on upgrades. Only metadata files are read: the run journal,
// agent-<id>.meta.json and workflows/<run>.json — never the conversation itself, except the `cwd`
// field of an agent transcript's first line when backfilling.
//
//   <session>/subagents/workflows/<run>/journal.jsonl        label, phase, typed result per agent
//   <session>/subagents/workflows/<run>/agent-<id>.meta.json  agentType, workflowPhase, model
//   <session>/workflows/<run>.json                           per agent: label, model, startedAt, durationMs, attempt, state
//   <session>/subagents/agent-<id>.meta.json                  Task subagents (description = label)

import { existsSync, openSync, readdirSync, readFileSync, readSync, closeSync, statSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import type { AgentRun } from "../protocol/index.ts";

type Partial_ = Partial<Omit<AgentRun, "agentId" | "claudeSessionId" | "cwd" | "role">>;

function readJson(p: string): Record<string, unknown> | undefined {
  try {
    return JSON.parse(readFileSync(p, "utf8")) as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

function readJsonl(p: string): Record<string, unknown>[] {
  try {
    return readFileSync(p, "utf8")
      .split("\n")
      .filter(Boolean)
      .flatMap((l) => {
        try {
          return [JSON.parse(l) as Record<string, unknown>];
        } catch {
          return [];
        }
      });
  } catch {
    return [];
  }
}

const s = (v: unknown) => (typeof v === "string" && v ? v : undefined);
const n = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : undefined);

interface Progress {
  label?: string | undefined;
  model?: string | undefined;
  startedAt?: number | undefined;
  durationMs?: number | undefined;
  attempt?: number | undefined;
  state?: string | undefined;
  toolCalls?: number | undefined;
  agentType?: string | undefined;
  phase?: string | undefined;
}

function progressOf(runJson: Record<string, unknown> | undefined, agentId: string): Progress | undefined {
  const list = Array.isArray(runJson?.workflowProgress) ? (runJson.workflowProgress as Record<string, unknown>[]) : [];
  const e = list.filter((x) => x.type === "workflow_agent" && x.agentId === agentId).at(-1);
  if (!e) return undefined;
  return { label: s(e.label), model: s(e.model), startedAt: n(e.startedAt), durationMs: n(e.durationMs), attempt: n(e.attempt), state: s(e.state), toolCalls: n(e.toolCalls), agentType: s(e.agentType), phase: s(e.phaseTitle) };
}

function journalOf(lines: readonly Record<string, unknown>[], agentId: string): { label?: string | undefined; phase?: string | undefined; result?: unknown; hasResult: boolean } {
  const started = lines.filter((l) => l.type === "started" && l.agentId === agentId).at(-1);
  const res = lines.filter((l) => l.type === "result" && l.agentId === agentId).at(-1);
  return { label: s(started?.label), phase: s(started?.phase), ...(res && "result" in res ? { result: res.result } : {}), hasResult: !!res };
}

/** Where a subagent's files are, from SubagentStop's agent_transcript_path. */
export function agentPaths(transcriptPath: string, agentId: string) {
  const dir = dirname(transcriptPath);
  const m = /^(.*)\/subagents\/workflows\/([^/]+)$/.exec(dir);
  return {
    meta: join(dir, `agent-${agentId}.meta.json`),
    journal: m ? join(dir, "journal.jsonl") : undefined,
    run: m ? join(m[1] as string, "workflows", `${m[2] as string}.json`) : undefined,
    workflowRun: m ? m[2] : undefined,
  };
}

/** What Claude Code recorded about one subagent. Missing files give fewer fields, never an error. */
export function readAgentFiles(transcriptPath: string, agentId: string): Partial_ & { roleFromMeta?: string | undefined } {
  const p = agentPaths(transcriptPath, agentId);
  const meta = readJson(p.meta);
  const runJson = p.run ? readJson(p.run) : undefined;
  const prog = progressOf(runJson, agentId);
  const j = p.journal ? journalOf(readJsonl(p.journal), agentId) : { hasResult: false };
  const label = j.label ?? prog?.label ?? s(meta?.description);
  const out: Partial_ & { roleFromMeta?: string | undefined } = {};
  if (label) out.label = label;
  const phase = j.phase ?? prog?.phase ?? s(meta?.workflowPhase);
  if (phase) out.phase = phase;
  const model = prog?.model ?? s(meta?.model) ?? s(meta?.pickedEffortModel);
  if (model) out.model = model;
  if (p.workflowRun) out.workflowRun = p.workflowRun;
  const wfName = s(runJson?.workflowName);
  if (wfName) out.workflowName = wfName;
  if (prog?.startedAt !== undefined) out.startedAt = prog.startedAt;
  if (prog?.durationMs !== undefined) out.durationMs = prog.durationMs;
  if (prog?.attempt !== undefined) out.attempt = prog.attempt;
  if (prog?.state) out.state = prog.state;
  if (prog?.toolCalls !== undefined) out.toolCalls = prog.toolCalls;
  if (j.hasResult) out.result = j.result;
  const role = s(meta?.agentType) ?? prog?.agentType;
  if (role) out.roleFromMeta = role;
  return out;
}

function firstLineCwd(path: string): string | undefined {
  let fd: number | undefined;
  try {
    fd = openSync(path, "r");
    const buf = Buffer.alloc(64 * 1024);
    const len = readSync(fd, buf, 0, buf.length, 0);
    const line = buf.subarray(0, len).toString("utf8").split("\n")[0] ?? "";
    return s((JSON.parse(line) as { cwd?: unknown }).cwd);
  } catch {
    return undefined;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

/**
 * Workflow runs Claude Code recorded since `since` (backfill after the daemon was down). Each agent
 * of each run becomes an AgentRun; agents whose cwd can't be found are skipped.
 */
export function scanWorkflowRuns(claudeHome: string, since: number): AgentRun[] {
  const projects = join(claudeHome, "projects");
  if (!existsSync(projects)) return [];
  const out: AgentRun[] = [];
  const ls = (d: string) => {
    try {
      return readdirSync(d);
    } catch {
      return [];
    }
  };
  for (const proj of ls(projects)) {
    for (const session of ls(join(projects, proj))) {
      const wfDir = join(projects, proj, session, "workflows");
      for (const f of ls(wfDir)) {
        if (!f.endsWith(".json")) continue;
        const path = join(wfDir, f);
        try {
          if (statSync(path).mtimeMs < since) continue;
        } catch {
          continue;
        }
        const runJson = readJson(path);
        const runId = basename(f, ".json");
        const subDir = join(projects, proj, session, "subagents", "workflows", runId);
        const journal = readJsonl(join(subDir, "journal.jsonl"));
        const list = Array.isArray(runJson?.workflowProgress) ? (runJson.workflowProgress as Record<string, unknown>[]) : [];
        const ids = [...new Set(list.filter((x) => x.type === "workflow_agent" && typeof x.agentId === "string").map((x) => x.agentId as string))];
        for (const agentId of ids) {
          const prog = progressOf(runJson, agentId);
          const meta = readJson(join(subDir, `agent-${agentId}.meta.json`));
          const cwd = firstLineCwd(join(subDir, `agent-${agentId}.jsonl`));
          if (!cwd) continue;
          const j = journalOf(journal, agentId);
          const role = s(meta?.agentType) ?? prog?.agentType ?? "agent";
          const run: AgentRun = { agentId, claudeSessionId: session, cwd, role, workflowRun: runId };
          const label = j.label ?? prog?.label;
          if (label) run.label = label;
          const phase = j.phase ?? prog?.phase;
          if (phase) run.phase = phase;
          const model = prog?.model ?? s(meta?.pickedEffortModel);
          if (model) run.model = model;
          const wfName = s(runJson?.workflowName);
          if (wfName) run.workflowName = wfName;
          if (prog?.startedAt !== undefined) {
            run.startedAt = prog.startedAt;
            if (prog.durationMs !== undefined) run.finishedAt = prog.startedAt + prog.durationMs;
          }
          if (prog?.durationMs !== undefined) run.durationMs = prog.durationMs;
          if (prog?.attempt !== undefined) run.attempt = prog.attempt;
          if (prog?.state) run.state = prog.state;
          if (prog?.toolCalls !== undefined) run.toolCalls = prog.toolCalls;
          if (j.hasResult) run.result = j.result;
          out.push(run);
        }
      }
    }
  }
  return out;
}
