// Ledger records for workflow programmes (one Claude session, many subagents). Labels follow
// <role>:<key>[:<round>] (the shipped kit's sdd-programme.js uses it) (e.g. reviewer:ROW-42:r2); the key is the
// team's own id, used as written (owner decision 15). Pure.

import { stringify } from "yaml";
import { LEDGER_SCHEMA, type AgentRun, type TrailFile } from "../protocol/index.ts";
import { isoSec, YAML_OPTS } from "./trail.ts";

export interface ParsedLabel {
  role: string;
  key: string;
  /** Record name within the key: the role, plus a qualifier for non-round tokens (reviewer-diff, assess-R3). */
  name: string;
  round: number;
}

/** Round tokens that are rounds of the same record; other <letters><n> tokens name a separate record. */
const ROUND_PREFIXES = new Set(["r", "c", "v", "fix", "rfix", "round", "cycle"]);
const KEY = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

export function parseLabel(label: string | undefined, fallbackRole?: string): ParsedLabel | undefined {
  if (!label) return undefined;
  const parts = label.split(":");
  if (parts.length < 2) return undefined;
  const [role, key, ...rest] = parts as [string, string, ...string[]];
  if (!KEY.test(key)) return undefined;
  const r = role || fallbackRole || "agent";
  let name = r;
  let round = 1;
  for (const tok of rest) {
    const m = /^([A-Za-z-]*?)(\d+)$/.exec(tok);
    // Lower-case prefixes (r2, c3, fix1) and bare numbers are rounds; anything else (diff1, R3 for a
    // gate) names a separate record.
    if (m && (m[1] === "" || ROUND_PREFIXES.has(m[1] ?? ""))) round = Number(m[2]);
    else if (m && m[1] === "diff") {
      name = `${name}-diff`;
      round = Number(m[2]);
    } else if (tok) name = `${name}-${tok.replace(/[^A-Za-z0-9-]/g, "").toLowerCase()}`;
  }
  return { role: r, key, name: name.replace(/[^A-Za-z0-9-]/g, "-"), round };
}

export function agentRecordPath(key: string, name: string): string {
  return `.mesh/goals/${key}/steps/${name}.md`;
}

/** Keep typed results compact: long strings are cut, so a record never carries prose dumps. */
function compact(v: unknown, depth = 0): unknown {
  if (typeof v === "string") return v.length > 300 ? `${v.slice(0, 297)}...` : v;
  if (Array.isArray(v)) return v.slice(0, 50).map((x) => compact(x, depth + 1));
  if (v && typeof v === "object" && depth < 4) return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, compact(x, depth + 1)]));
  return v;
}

/** One record per (key, name), rounds in label order, from every captured run of that key. */
export function agentRecords(runs: readonly AgentRun[]): TrailFile[] {
  const groups = new Map<string, { p: ParsedLabel; runs: { r: AgentRun; n: number }[] }>();
  for (const r of runs) {
    const p = parseLabel(r.label, r.role);
    if (!p) continue;
    const id = `${p.key}\u0000${p.name}`;
    const g = groups.get(id) ?? { p, runs: [] };
    g.runs.push({ r, n: p.round });
    groups.set(id, g);
  }
  const files: TrailFile[] = [];
  for (const { p, runs: rs } of groups.values()) {
    // Rounds in the order they ran (labels like fix1 and rfix1 would otherwise collide); the label
    // stays on each round for traceability.
    rs.sort((a, b) => (a.r.startedAt ?? a.r.finishedAt ?? 0) - (b.r.startedAt ?? b.r.finishedAt ?? 0) || a.n - b.n);
    rs.forEach((x, i) => (x.n = i + 1));
    const models = [...new Set(rs.map((x) => x.r.model).filter((m): m is string => !!m))];
    const first = rs[0]?.r;
    const last = rs.at(-1)?.r;
    const doc = {
      schema: LEDGER_SCHEMA,
      record: "agent-step",
      key: p.key,
      role: p.role,
      name: p.name,
      ...(first?.workflowName ? { workflow: first.workflowName } : {}),
      models,
      rounds_count: rs.length,
      ...(first?.startedAt !== undefined ? { started: isoSec(first.startedAt) } : {}),
      ...(last?.finishedAt !== undefined ? { finished: isoSec(last.finishedAt) } : {}),
      rounds: rs.map(({ r, n }) => ({
        n,
        label: r.label ?? "",
        agent_id: r.agentId,
        ...(r.workflowRun ? { workflow_run: r.workflowRun } : {}),
        ...(r.phase ? { phase: r.phase } : {}),
        ...(r.model ? { model: r.model, model_source: "workflow" } : {}),
        ...(r.startedAt !== undefined ? { started: isoSec(r.startedAt) } : {}),
        ...(r.finishedAt !== undefined ? { finished: isoSec(r.finishedAt) } : {}),
        ...(r.durationMs !== undefined ? { duration_s: Math.round(r.durationMs / 100) / 10 } : r.startedAt !== undefined && r.finishedAt !== undefined ? { duration_s: Math.round((r.finishedAt - r.startedAt) / 100) / 10 } : {}),
        ...(r.attempt !== undefined && r.attempt > 1 ? { attempt: r.attempt } : {}),
        ...(r.state ? { state: r.state } : {}),
        ...(r.toolCalls !== undefined ? { tool_calls: r.toolCalls } : {}),
        ...(r.result !== undefined ? { result: compact(r.result) } : {}),
      })),
    };
    files.push({ path: agentRecordPath(p.key, p.name), text: `---\n${stringify(doc, YAML_OPTS).trimEnd()}\n---\n` });
  }
  return files.sort((a, b) => a.path.localeCompare(b.path));
}
