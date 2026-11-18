// RL-9: finding steps of clean-audit goals, pure. The step id of a finding, its title and brief, the
// severity refill of the ready list, the header counts of `mesh show`, and the cycle test of deps.

import { createHash } from "node:crypto";
import type { ItemRow, ReviewEvidence, Severity, Step } from "../protocol/index.ts";
import { base32, SEVERITY_RANK } from "./review.ts";

/** The longest title a finding step gets (as a plan step's title). */
export const FINDING_TITLE_MAX = 200;
/** The longest brief a finding step gets (as a plan step's brief). */
export const FINDING_BRIEF_MAX = 8000;

/**
 * The local id of the finding step of `(lineage, fp)`: `f-` and the first 16 characters of the
 * lowercase base32 SHA-256 of `<lineage>|<fp>` (18 characters). The full id is `<goal>.<this>`.
 */
export function findingStepId(lineage: string, fp: string): string {
  return `f-${base32(createHash("sha256").update(`${lineage}|${fp}`, "utf8").digest()).toLowerCase().slice(0, 16)}`;
}

/** `text` cut to `max` characters, the last kept character replaced by `…` when cut. */
export function cutText(text: string, max: number): string {
  if (text.length <= max) return text;
  let head = text.slice(0, max - 1);
  // Never end on half a surrogate pair.
  if (/[\uD800-\uDBFF]$/.test(head)) head = head.slice(0, -1);
  return `${head}…`;
}

/** The title of a finding step: `[<severity>] <item title>`, cut to 200 characters. */
export function cutTitle(severity: Severity, title: string): string {
  return cutText(`[${severity}] ${title}`, FINDING_TITLE_MAX);
}

/** Same as `cutTitle`. */
export const findingTitle = cutTitle;

/** The repo of a lineage `<preset>|<repo>|<agent>`: the text between the first and the last `|`. */
export function lineageRepo(lineage: string): string {
  const a = lineage.indexOf("|");
  const b = lineage.lastIndexOf("|");
  return a < 0 || b <= a ? lineage : lineage.slice(a + 1, b);
}

/** RL-10: the target repo of an item row: its `repo` when set, else the lineage repo. */
export function targetRepo(row: Pick<ItemRow, "lineage" | "repo">): string {
  return row.repo ?? lineageRepo(row.lineage);
}

/** RL-10: a moved-away finding step (it was moved to the step its `movedTo` names). */
export function isMovedAway(s: Pick<Step, "movedTo">): boolean {
  return s.movedTo !== undefined;
}

/**
 * RL-10: the repo a key path names, for `mesh items retarget --from-key-path`. No path → `none`; a
 * path with `/` or ending in `.` and 1-5 letters or digits (a file) → `bad`; else the path.
 */
export function keyPathRepo(path: string | undefined): { repo: string } | { note: "none" | "bad" } {
  if (path === undefined) return { note: "none" };
  if (path.includes("/") || /\.[A-Za-z0-9]{1,5}$/.test(path)) return { note: "bad" };
  return { repo: path };
}

/** The last line of every finding step's brief. */
export function findingLastLine(lineage: string): string {
  return `When the fix lands, the next audit of ${lineage} resolves this finding; do not edit the tracking row.`;
}

/**
 * The brief of a finding step: the item's rule, path, symbol, evidence, proposal, link and the
 * reasons of its dispositions, then the last line. Cut to 8000 characters keeping the last line, with
 * `… (cut; mesh items <lineage>)` before it.
 */
export function findingBrief(o: {
  item: Pick<ItemRow, "lineage" | "fp" | "rule" | "path" | "symbol" | "title" | "severity" | "category" | "link">;
  evidence: readonly ReviewEvidence[];
  proposal?: string | undefined;
  reasons: readonly string[];
}): string {
  const it = o.item;
  const lines: string[] = [`Finding ${it.fp} of ${it.lineage} (${it.severity}, ${it.category}): ${it.title}`, `rule: ${it.rule}`];
  if (it.path !== undefined) lines.push(`path: ${it.path}`);
  if (it.symbol !== undefined) lines.push(`symbol: ${it.symbol}`);
  if (o.evidence.length) {
    lines.push("evidence:");
    for (const e of o.evidence) {
      lines.push(`- ${e.path}${e.lines ? `:${e.lines[0]}-${e.lines[1]}` : ""}`);
      if (e.note) lines.push(`  ${e.note}`);
    }
  }
  if (o.proposal) lines.push("proposal:", o.proposal);
  if (it.link !== undefined) lines.push(`link: ${it.link}`);
  if (o.reasons.length) {
    lines.push("dispositions:");
    for (const r of o.reasons) lines.push(`- ${r}`);
  }
  const last = findingLastLine(it.lineage);
  const body = lines.join("\n");
  const whole = `${body}\n\n${last}`;
  if (whole.length <= FINDING_BRIEF_MAX) return whole;
  const tail = `\n… (cut; mesh items ${it.lineage})\n${last}`;
  let head = body.slice(0, Math.max(0, FINDING_BRIEF_MAX - tail.length));
  if (/[\uD800-\uDBFF]$/.test(head)) head = head.slice(0, -1);
  return `${head}${tail}`;
}

const isFinding = (s: Pick<Step, "finding" | "severity">) => s.finding !== undefined && s.severity !== undefined;

/**
 * The ready-order rule for one part of the list: within each goal, the positions held by its finding
 * steps are refilled with those steps sorted by severity (ties keep their order). Other steps never move.
 */
export function refillBySeverity<T extends Pick<Step, "goal" | "finding" | "severity">>(steps: readonly T[]): T[] {
  const out = [...steps];
  const byGoal = new Map<string, number[]>();
  steps.forEach((s, i) => {
    if (!isFinding(s)) return;
    const list = byGoal.get(s.goal) ?? [];
    list.push(i);
    byGoal.set(s.goal, list);
  });
  for (const idx of byGoal.values()) {
    const sorted = idx
      .map((i, n) => ({ s: steps[i] as T, n }))
      .sort((a, b) => SEVERITY_RANK[a.s.severity as Severity] - SEVERITY_RANK[b.s.severity as Severity] || a.n - b.n);
    idx.forEach((i, n) => {
      out[i] = (sorted[n] as { s: T }).s;
    });
  }
  return out;
}

/** The header counts of a clean-audit goal: open finding steps by severity, done and dropped ones (moved-away steps left out). */
export function sinkCounts(steps: readonly Pick<Step, "state" | "finding" | "severity" | "movedTo">[]): { open: Record<Severity, number>; done: number; dropped: number } {
  const open: Record<Severity, number> = { S1: 0, S2: 0, S3: 0, S4: 0 };
  let done = 0;
  let dropped = 0;
  for (const s of steps) {
    // RL-10: a moved-away step is counted where it lives now.
    if (!isFinding(s) || isMovedAway(s)) continue;
    if (s.state === "done") done++;
    else if (s.state === "dropped") dropped++;
    else if (s.state !== "skipped") open[s.severity as Severity]++;
  }
  return { open, done, dropped };
}

/** True when adding the dep `from → to` closes a cycle: `from === to`, or `to` reaches `from` through `deps`. */
export function closesCycle(deps: ReadonlyMap<string, readonly string[]>, from: string, to: string): boolean {
  if (from === to) return true;
  const seen = new Set<string>();
  const stack = [to];
  while (stack.length) {
    const id = stack.pop() as string;
    if (id === from) return true;
    if (seen.has(id)) continue;
    seen.add(id);
    stack.push(...(deps.get(id) ?? []));
  }
  return false;
}
