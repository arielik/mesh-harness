// RL-1: what a headless run did, read from its `stream-json` output, and the rendered tail the daemon
// stores as a transcript when a run ends without mesh_done. Pure.

import type { RunExit, RunTelemetry } from "../protocol/index.ts";

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);
const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);

/** The stream's events: one JSON object per line; anything else is skipped. */
function events(stream: string): Obj[] {
  const out: Obj[] = [];
  for (const line of stream.split("\n")) {
    const t = line.trim();
    if (!t.startsWith("{")) continue;
    try {
      const v: unknown = JSON.parse(t);
      if (isObj(v)) out.push(v);
    } catch {
      // not JSON: ignored
    }
  }
  return out;
}

export type StreamTelemetry = Pick<
  RunTelemetry,
  "model" | "sessionId" | "turns" | "turnsApprox" | "tokensIn" | "tokensOut" | "cacheRead" | "cacheWrite" | "costUsdEstimate" | "durationMs" | "exit" | "permissionDenials" | "tools" | "mcpServers"
>;

/** Telemetry from a run's stream: complete with a `result` event, else partial (`turnsApprox`). */
export function telemetryFromStream(stream: string, run: { durationMs: number; exitCode: number | undefined; killedForBudget: boolean }): StreamTelemetry {
  const evs = events(stream);
  const init = evs.find((e) => e.type === "system" && e.subtype === "init");
  const assistants = evs.filter((e) => e.type === "assistant" && isObj(e.message));
  const head: Partial<StreamTelemetry> = {};
  if (init) {
    if (typeof init.model === "string") head.model = init.model;
    if (typeof init.session_id === "string") head.sessionId = init.session_id;
    if (Array.isArray(init.tools)) head.tools = init.tools.filter((t): t is string => typeof t === "string");
    if (Array.isArray(init.mcp_servers)) head.mcpServers = init.mcp_servers.filter(isObj).map((s) => s.name).filter((n): n is string => typeof n === "string");
  }
  if (head.model === undefined) {
    const m = (assistants[0]?.message as Obj | undefined)?.model;
    if (typeof m === "string") head.model = m;
  }
  const results = evs.filter((e) => e.type === "result");
  const result = results[results.length - 1];
  if (result) {
    const usage = isObj(result.usage) ? result.usage : {};
    const denials = Array.isArray(result.permission_denials) ? result.permission_denials : [];
    const tools = [...new Set(denials.filter(isObj).map((d) => d.tool_name).filter((n): n is string => typeof n === "string"))];
    return {
      ...head,
      turns: Math.max(0, Math.trunc(num(result.num_turns))),
      turnsApprox: false,
      tokensIn: Math.trunc(num(usage.input_tokens)),
      tokensOut: Math.trunc(num(usage.output_tokens)),
      cacheRead: Math.trunc(num(usage.cache_read_input_tokens)),
      cacheWrite: Math.trunc(num(usage.cache_creation_input_tokens)),
      ...(typeof result.total_cost_usd === "number" ? { costUsdEstimate: result.total_cost_usd } : {}),
      durationMs: Math.trunc(num(result.duration_ms)),
      exit: typeof result.subtype === "string" ? result.subtype : "crashed",
      permissionDenials: { count: denials.length, tools },
    };
  }
  // No result: count distinct message ids, usage once per id.
  const byId = new Map<string, Obj>();
  for (const e of assistants) {
    const m = e.message as Obj;
    if (typeof m.id !== "string" || byId.has(m.id)) continue;
    byId.set(m.id, isObj(m.usage) ? m.usage : {});
  }
  let tokensIn = 0;
  let tokensOut = 0;
  let cacheRead = 0;
  let cacheWrite = 0;
  for (const u of byId.values()) {
    tokensIn += num(u.input_tokens);
    tokensOut += num(u.output_tokens);
    cacheRead += num(u.cache_read_input_tokens);
    cacheWrite += num(u.cache_creation_input_tokens);
  }
  const exit: RunExit = run.killedForBudget ? "killed_budget" : run.exitCode === 0 ? "no_result" : "crashed";
  return {
    ...head,
    turns: byId.size,
    turnsApprox: true,
    tokensIn: Math.trunc(tokensIn),
    tokensOut: Math.trunc(tokensOut),
    cacheRead: Math.trunc(cacheRead),
    cacheWrite: Math.trunc(cacheWrite),
    durationMs: Math.trunc(run.durationMs),
    exit,
    permissionDenials: { count: evs.filter((e) => e.type === "system" && e.subtype === "permission_denied").length, tools: [] },
  };
}

const textOf = (e: Obj): string => {
  const content = (e.message as Obj).content;
  if (!Array.isArray(content)) return "";
  return content
    .filter(isObj)
    .filter((b) => b.type === "text" && typeof b.text === "string")
    .map((b) => b.text as string)
    .join("\n");
};

/** True when the line, read as JSON, is an object (such a line is quoted in the tail). */
const jsonObjectLine = (line: string): boolean => {
  try {
    return isObj(JSON.parse(line));
  } catch {
    return false;
  }
};

/** A plain-text tail of a run for a person: the end, its last words, errors and stderr. No raw JSON. */
export function renderTail(stream: string, stderr: string, exit: RunExit): string {
  const evs = events(stream);
  const lines: string[] = [`Run ended: ${exit}`];
  const texts = evs
    .filter((e) => e.type === "assistant" && isObj(e.message))
    .map(textOf)
    .filter((t) => t.trim() !== "");
  const last = texts.slice(-5);
  if (last.length) lines.push("--- last assistant messages ---", ...last.map((t) => t.slice(0, 2000)));
  const results = evs.filter((e) => e.type === "result");
  const errors = (results[results.length - 1]?.errors as unknown[] | undefined)?.filter((x): x is string => typeof x === "string") ?? [];
  if (errors.length) lines.push("--- errors ---", ...errors);
  const err = stderr.split("\n");
  if (err.length && err[err.length - 1] === "") err.pop();
  if (err.some((l) => l.trim() !== "")) lines.push("--- stderr (last 20 lines) ---", ...err.slice(-20));
  return lines
    .join("\n")
    .split("\n")
    .map((l) => (jsonObjectLine(l) ? `> ${l}` : l))
    .join("\n");
}
