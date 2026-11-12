// RL-2: review records, pure. Path normalisation, fingerprints, declared rules, evidence hashes,
// the fold of a record against its lineage, and the `when` of a conditional stage.

import { createHash } from "node:crypto";
import { parse } from "yaml";
import type { Fold, ItemState, Severity, StepWhen } from "../protocol/index.ts";
import { frontMatter, listField } from "./headless.ts";

/** `\` → `/`, the `root` prefix removed, leading `./` removed, runs of `/` collapsed, trailing `/` removed. */
export function normPath(p: string, root?: string): string {
  let s = p.replace(/\\/g, "/");
  if (root !== undefined) {
    let r = root.replace(/\\/g, "/");
    while (r.length > 1 && r.endsWith("/")) r = r.slice(0, -1);
    if (r && s === r) s = "";
    else if (r && s.startsWith(r === "/" ? "/" : `${r}/`)) s = s.slice(r === "/" ? 1 : r.length + 1);
  }
  while (s.startsWith("./")) s = s.slice(2);
  s = s.replace(/\/{2,}/g, "/");
  if (s.length > 1 && s.endsWith("/")) s = s.slice(0, -1);
  return s;
}

const B32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

/** RFC 4648 base32, no padding. */
export function base32(buf: Uint8Array): string {
  let out = "";
  let bits = 0;
  let value = 0;
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += B32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}

/** The identity of an item: rule, normalised path and symbol. Never line numbers, title or evidence. */
export function fingerprint(key: { rule: string; path?: string | undefined; symbol?: string | undefined }): string {
  const text = `${key.rule.trim()}\n${normPath(key.path ?? "")}\n${(key.symbol ?? "").trim()}`;
  return base32(createHash("sha256").update(text, "utf8").digest()).toLowerCase().slice(0, 16);
}

/** Lowercase; runs outside [a-z0-9] → "-"; "-" trimmed; first 40; "" → "unnamed". */
export function ruleSlug(s: string): string {
  const slug = s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40)
    .replace(/-+$/g, "");
  return slug || "unnamed";
}

/** A rule as the agent declared it, or `other:<slug>` (undeclared). */
export function mapRule(rule: string, declared: ReadonlySet<string>): { rule: string; undeclared: boolean } {
  const r = rule.trim();
  if (declared.has(r)) return { rule: r, undeclared: false };
  return { rule: `other:${ruleSlug(r.replace(/^other:/i, ""))}`, undeclared: true };
}

/** The rules an agent declares: front matter `mesh-rules` plus a sibling `<name>.rules.yaml`. */
export function declaredRules(agentText: string, rulesYaml?: string): Set<string> {
  const out = new Set<string>();
  for (const r of listField(frontMatter(agentText)["mesh-rules"]) ?? []) out.add(r);
  if (rulesYaml !== undefined) {
    let v: unknown;
    try {
      v = parse(rulesYaml);
    } catch {
      v = undefined;
    }
    const list = Array.isArray(v) ? v.filter((x) => typeof x === "string" || typeof x === "number").map(String) : v && typeof v === "object" ? Object.keys(v) : [];
    for (const r of list.map((x) => x.trim()).filter(Boolean)) out.add(r);
  }
  return out;
}

export function lineageKey(l: { preset: string; repo: string; agent: string }): string {
  return `${l.preset}|${l.repo}|${l.agent}`;
}

/** The last path segment of a repo (trailing `/` and one trailing `.git` removed). */
export function repoName(repo: string): string {
  let r = repo.replace(/\/+$/, "");
  if (r.endsWith(".git")) r = r.slice(0, -4);
  return r.split(/[/:]/).at(-1) ?? r;
}

/** The lineage of a step: `<goal preset or ->|<repo>|<agent or local id>`. */
export function lineageOf(goal: { preset?: { name: string } | undefined }, step: { id: string; goal: string; repo: string; policy?: { agent?: string | undefined } | undefined }): string {
  return lineageKey({ preset: goal.preset?.name ?? "-", repo: step.repo, agent: step.policy?.agent ?? step.id.slice(step.goal.length + 1) });
}

/** Every run of whitespace (newlines too) → one space, trimmed. */
export function normalizeRegion(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

const sha256 = (s: string) => createHash("sha256").update(s, "utf8").digest("hex");

/** The hash of an item's evidence regions (`null` = unreadable, token `missing`); undefined when none. */
export function evidenceHash(regions: readonly (string | null)[]): string | undefined {
  if (!regions.length) return undefined;
  return sha256(regions.map((r) => (r === null ? "missing" : sha256(normalizeRegion(r)))).join("\n"));
}

export const SEVERITY_RANK: Readonly<Record<Severity, number>> = { S1: 1, S2: 2, S3: 3, S4: 4 };

/** A raising step: `output: review-record` and no `consumes`. */
export function isRaising(p: { output?: unknown; consumes?: unknown } | undefined): boolean {
  return !!p?.output && !p.consumes;
}

/**
 * The run of a consuming step: the first raising step of a breadth-first walk over `deps`. Works for
 * full steps (full ids) and plan steps (local ids); `policy` reads a step's policy fields.
 */
export function runOf<T extends { id: string; deps: readonly string[] }>(
  step: T,
  steps: readonly T[],
  policy: (t: T) => { output?: unknown; consumes?: unknown } | undefined,
): T | undefined {
  const byId = new Map(steps.map((s) => [s.id, s]));
  const seen = new Set<string>([step.id]);
  const queue = [...step.deps];
  while (queue.length) {
    const id = queue.shift() as string;
    if (seen.has(id)) continue;
    seen.add(id);
    const s = byId.get(id);
    if (!s) continue;
    if (isRaising(policy(s))) return s;
    queue.push(...s.deps);
  }
  return undefined;
}

/** Unique fps in first-occurrence order. */
export function uniqueFps(items: readonly { fp: string }[]): string[] {
  return [...new Set(items.map((i) => i.fp))];
}

/** The summary of a skipped step. */
export function skipSummary(runLocal: string, when: StepWhen, consumes: readonly string[]): string {
  return `skipped: no item of ${runLocal} is ${consumes.join(" or ")}${when.min_severity ? ` at ${when.min_severity} or above` : ""}`;
}

export interface FoldRow {
  state: ItemState;
  dismissedEh?: string | undefined;
  until?: string | undefined;
}

/** The fold of a record against its lineage's item rows and the fold base's fps. */
export function foldItems(o: {
  items: readonly { fp: string; eh?: string | undefined }[];
  complete: boolean;
  previous: readonly string[] | undefined;
  rows: ReadonlyMap<string, FoldRow>;
  today: string;
}): { marks: Map<string, "new" | "repeat" | "regression">; states: Map<string, ItemState>; resolved: string[]; carried: string[]; fold: Fold } {
  const marks = new Map<string, "new" | "repeat" | "regression">();
  const states = new Map<string, ItemState>();
  const resolved: string[] = [];
  const carried: string[] = [];
  for (const it of o.items) {
    if (marks.has(it.fp)) continue;
    const row = o.rows.get(it.fp);
    if (!row) {
      marks.set(it.fp, "new");
      states.set(it.fp, "open");
    } else if (row.state === "resolved" || (row.state === "dismissed" && it.eh !== row.dismissedEh)) {
      marks.set(it.fp, "regression");
      states.set(it.fp, "open");
    } else {
      marks.set(it.fp, "repeat");
      if (row.state === "dismissed") carried.push(it.fp);
      states.set(it.fp, row.state === "deferred" && row.until !== undefined && row.until <= o.today ? "open" : row.state);
    }
  }
  if (o.complete && o.previous) {
    for (const fp of new Set(o.previous)) {
      if (marks.has(fp)) continue;
      states.set(fp, "resolved");
      resolved.push(fp);
    }
  }
  const n = (m: string) => [...marks.values()].filter((x) => x === m).length;
  return { marks, states, resolved, carried, fold: { new: n("new"), repeat: n("repeat"), regression: n("regression"), resolved: resolved.length, carried: carried.length } };
}

/** RL-6: an item in a consumed state; an `accepted` item with a `link` is filed and never consumed. */
export function consumedNow(item: { state: ItemState; link?: string | undefined }, consumes: readonly ItemState[]): boolean {
  return consumes.includes(item.state) && !(item.state === "accepted" && item.link !== undefined);
}

/** True when an item is in a consumed state (and at or above `min_severity`). `when: {}` is true. */
export function whenHolds(
  when: StepWhen,
  consumes: readonly ItemState[],
  items: readonly { state: ItemState; severity: Severity; link?: string | undefined }[],
): boolean {
  if (!when.open && !when.min_severity) return true;
  const min = when.min_severity;
  return items.some((i) => consumedNow(i, consumes) && (!min || SEVERITY_RANK[i.severity] <= SEVERITY_RANK[min]));
}
