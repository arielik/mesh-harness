// RL-5: pure helpers of the roster: canonical keys, the catalog digest, front matter as the roster
// shows it, and a unified line diff.

import { createHash } from "node:crypto";
import type { AgentFront } from "../protocol/index.ts";
import { parseAgentFile } from "./headless.ts";

/** `<last segment of repoId>/<name>`. */
export function canonicalKey(repoId: string, name: string): string {
  return `${repoId.slice(repoId.lastIndexOf("/") + 1)}/${name}`;
}

/** Hex SHA-256 of `<path>\t<hash>\n` lines sorted by path. */
export function catalogDigest(defs: { path: string; hash: string }[]): string {
  const sorted = [...defs].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return createHash("sha256")
    .update(sorted.map((d) => `${d.path}\t${d.hash}\n`).join(""))
    .digest("hex");
}

/**
 * The front matter fields of an agent file as the roster stores them: `description` cut to 1000
 * characters, `model` only when at most 100, `tools` (not a map) and `rules` (`mesh-rules`) with
 * over-long entries dropped, then cut to 100 resp. 200 entries.
 */
export function agentFront(text: string): AgentFront {
  const f = parseAgentFile(text);
  const out: AgentFront = {};
  if (f.description !== undefined) out.description = f.description.slice(0, 1000);
  if (f.model !== undefined && f.model.length <= 100) out.model = f.model;
  if (f.tools !== undefined) out.tools = f.tools.filter((t) => t.length <= 200).slice(0, 100);
  if (f.rules !== undefined) out.rules = f.rules.filter((r) => r.length <= 100).slice(0, 200);
  return out;
}

type Op = { op: " " | "-" | "+"; line: string };

function linesOf(text: string): string[] {
  const t = text.replace(/\r\n/g, "\n");
  if (t === "") return [];
  return (t.endsWith("\n") ? t.slice(0, -1) : t).split("\n");
}

/** A minimal edit script (LCS) of two line lists. */
function editScript(a: string[], b: string[]): Op[] {
  let pre = 0;
  while (pre < a.length && pre < b.length && a[pre] === b[pre]) pre++;
  let suf = 0;
  while (suf < a.length - pre && suf < b.length - pre && a[a.length - 1 - suf] === b[b.length - 1 - suf]) suf++;
  const am = a.slice(pre, a.length - suf);
  const bm = b.slice(pre, b.length - suf);
  const n = am.length;
  const m = bm.length;
  // L[i][j] = LCS length of am[i..] and bm[j..].
  const w = m + 1;
  const L = new Uint32Array((n + 1) * w);
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      L[i * w + j] = am[i] === bm[j] ? L[(i + 1) * w + j + 1]! + 1 : Math.max(L[(i + 1) * w + j]!, L[i * w + j + 1]!);
    }
  }
  const ops: Op[] = a.slice(0, pre).map((line) => ({ op: " ", line }));
  let i = 0;
  let j = 0;
  while (i < n || j < m) {
    if (i < n && j < m && am[i] === bm[j]) {
      ops.push({ op: " ", line: am[i]! });
      i++;
      j++;
    } else if (j >= m || (i < n && L[(i + 1) * w + j]! >= L[i * w + j + 1]!)) {
      ops.push({ op: "-", line: am[i]! });
      i++;
    } else {
      ops.push({ op: "+", line: bm[j]! });
      j++;
    }
  }
  for (const line of a.slice(a.length - suf)) ops.push({ op: " ", line });
  // Within a run of changed lines, all deletions before all additions.
  const out: Op[] = [];
  let k = 0;
  while (k < ops.length) {
    if (ops[k]!.op === " ") {
      out.push(ops[k]!);
      k++;
      continue;
    }
    const run: Op[] = [];
    while (k < ops.length && ops[k]!.op !== " ") run.push(ops[k++]!);
    out.push(...run.filter((o) => o.op === "-"), ...run.filter((o) => o.op === "+"));
  }
  return out;
}

/**
 * A unified diff with 3 lines of context (`""` when the texts are equal up to CRLF). Changes
 * separated by at most 6 unchanged lines share a hunk.
 */
export function unifiedDiff(a: string, b: string, labelA: string, labelB: string): string {
  const na = a.replace(/\r\n/g, "\n");
  const nb = b.replace(/\r\n/g, "\n");
  const la = linesOf(na);
  const lb = linesOf(nb);
  if (la.length === lb.length && la.every((l, i) => l === lb[i])) return "";
  const ops = editScript(la, lb);
  const oldBefore: number[] = [];
  const newBefore: number[] = [];
  let o = 0;
  let nw = 0;
  for (const op of ops) {
    oldBefore.push(o);
    newBefore.push(nw);
    if (op.op !== "+") o++;
    if (op.op !== "-") nw++;
  }
  const changes = ops.map((op, idx) => (op.op === " " ? -1 : idx)).filter((idx) => idx >= 0);
  const groups: [number, number][] = [];
  for (const c of changes) {
    const last = groups.at(-1);
    if (last && c - last[1] - 1 <= 6) last[1] = c;
    else groups.push([c, c]);
  }
  let out = `--- ${labelA}\n+++ ${labelB}\n`;
  for (const [first, last] of groups) {
    const s = Math.max(0, first - 3);
    const e = Math.min(ops.length - 1, last + 3);
    const slice = ops.slice(s, e + 1);
    const n1 = slice.filter((x) => x.op !== "+").length;
    const n2 = slice.filter((x) => x.op !== "-").length;
    const s1 = n1 > 0 ? oldBefore[s]! + 1 : oldBefore[s]!;
    const s2 = n2 > 0 ? newBefore[s]! + 1 : newBefore[s]!;
    out += `@@ -${s1},${n1} +${s2},${n2} @@\n`;
    for (const x of slice) out += `${x.op}${x.line}\n`;
  }
  return out;
}
