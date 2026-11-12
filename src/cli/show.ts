// `mesh show <goal>`: the goal and its step DAG in the terminal (plan §5.3). Pure, snapshot-tested.

import { diffPlans, levels, offerText, stageSummary, STEP_STAGES, stepStage } from "../core/index.ts";
import type { GoalDetail, Step } from "../protocol/index.ts";

const MARK: Record<Step["state"], string> = { done: "✓", claimed: "◐", paused: "◌", ready: "○", blocked: "·", failed: "✗", parked: "⏸", dropped: "–", skipped: "↷" };

function local(id: string): string {
  return id.slice(id.indexOf(".") + 1);
}

function who(s: Step, d: GoalDetail): string {
  if (s.state !== "claimed" && s.state !== "paused") return "";
  const h = d.holders?.[s.id];
  const state = h ? (h.state === "needs_you" ? `needs ${h.needs ?? "you"}` : h.state) : s.state === "paused" ? "paused" : "no session";
  return `@${s.holderUser ?? "?"} · ${state}`;
}

export function renderGoal(d: GoalDetail, opts: { color?: boolean } = {}): string {
  const paint = (code: string, t: string) => (opts.color ? `\x1b[${code}m${t}\x1b[0m` : t);
  const g = d.goal;
  const lines: string[] = [];
  const visible = d.steps.filter((s) => s.state !== "dropped");
  const done = visible.filter((s) => s.state === "done" || s.state === "skipped").length;
  lines.push(paint("1", `${g.id} · ${g.title}`));
  lines.push(`${g.state.replace(/_/g, " ")} · owner @${g.ownerId} · ${done}/${visible.length} steps done${g.primaryRepo ? ` · ${g.primaryRepo}` : ""}`);
  if (g.topics?.length) lines.push(`topics: ${g.topics.join(", ")}`);
  if (d.stick) lines.push(`sticks to ${d.stick}: its next ready steps are offered there (mesh withdraw ${g.id})`);
  lines.push(`steps: ${stageSummary(d.steps, stepStage, STEP_STAGES)}`);
  const plans = d.plans;
  const latest = plans.at(-1);
  if (latest) {
    const approved = plans.filter((p) => p.decision === "approved").at(-1);
    lines.push(`plan v${latest.version} ${latest.decision}${latest.decidedBy ? ` by @${latest.decidedBy}` : ""}${latest.designRef ? ` · design ${latest.designRef}` : ""}`);
    if (latest.decision === "pending") {
      const diff = diffPlans(approved, latest);
      const parts = [diff.added.length ? `+${diff.added.join(", +")}` : "", diff.removed.length ? `-${diff.removed.join(", -")}` : "", diff.changed.length ? `~${diff.changed.join(", ~")}` : ""].filter(Boolean);
      if (approved && parts.length) lines.push(`  changes from v${approved.version}: ${parts.join("  ")}`);
      lines.push(`  approve: mesh goal approve ${g.id}   ·   ask for changes: mesh goal revise ${g.id} "<comment>"`);
    }
  }
  lines.push("");
  const byLevel = levels(visible);
  const idW = Math.max(6, ...visible.map((s) => local(s.id).length));
  byLevel.forEach((level, i) => {
    lines.push(paint("2", i === 0 ? "start" : `then (after ${[...new Set(level.flatMap((s) => s.deps.map(local)))].join(", ")})`));
    for (const s of level) {
      const mark = MARK[s.state];
      const color = s.state === "done" ? "32" : s.state === "failed" || s.state === "parked" ? "31" : s.state === "claimed" ? "34" : s.state === "paused" ? "33" : s.state === "skipped" ? "2" : "0";
      const gate = s.kind === "gate" && s.state === "ready" ? `waits for a decision: mesh step approve ${s.id}` : "";
      const parked = s.state === "parked" ? `parked: ${s.parkedReason ?? ""} (mesh step resume ${s.id})` : "";
      const role = s.policy?.role ? `[${s.policy.role}]` : "";
      const offer = d.offers?.[s.id];
      const extras = [role, who(s, d), offer ? offerText(offer) : "", gate, parked, s.fixCycles ? `fix cycle ${s.fixCycles}` : "", s.mr ?? "", s.state === "done" && s.summary ? `— ${s.summary}` : ""].filter(Boolean).join("  ");
      lines.push(`  ${paint(color, mark)} ${local(s.id).padEnd(idW)}  ${s.kind.padEnd(9)} ${(s.repo || "-").padEnd(16)} ${s.state.padEnd(8)} ${extras}`.trimEnd());
    }
  });
  const dropped = d.steps.filter((s) => s.state === "dropped");
  if (dropped.length) lines.push(paint("2", `dropped by a later plan: ${dropped.map((s) => local(s.id)).join(", ")}`));
  const ready = visible.filter((s) => s.state === "ready");
  if (ready.length) lines.push("", `ready to pick: ${ready.map((s) => `mesh run ${s.repo || "<repo>"} --step ${s.id}`).join("\n               ")}`);
  return lines.join("\n");
}
