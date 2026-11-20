// RL-3: `mesh pulse`: hub schedules that create goals from a preset snapshot.

import { spawnSync } from "node:child_process";
import { basename } from "node:path";
import { sha256 } from "../auth/index.ts";
import { checkoutAgentSteps, instantiate, parseAgentFile, parsePreset, presetText } from "../core/index.ts";
import type { FireResult, PlanInput, PresetSnapshot, PulseDetail, PulseSlot, PulseView } from "../protocol/index.ts";
import type { Command } from "./commands.ts";
import { parseArgs, type CliEnv } from "./context.ts";
import { findPresetSource, parseParams } from "./hub-commands.ts";
import { HubCallError, HubClient } from "./hub-client.ts";

const USAGE = [
  "usage:",
  '  mesh pulse add --preset <name> --repo <repo> [--params k=v,k2=v2] (--every <dur> [--at <ISO>] | --cron "<5 fields>" [--tz <zone>])',
  '                 [--title "…"] [--topics a,b] [--labels a,b] [--machines a,b] [--window <dur>]',
  "                 [--overlap skip|allow|queue|supersede]",
  "                 [--max-goal-age <dur>] [--missed record|catch-up-once] [--paused]",
  "  mesh pulse ls [--mine] [--json]",
  "  mesh pulse show <id> [--json]",
  "  mesh pulse update <id> [any add flag except --paused]",
  "  mesh pulse pause <id> | resume <id> | rm <id>",
  "  mesh pulse fire <id> [--trial]   # --trial: a trial run, left out of statistics, calibration and runs; never blocks a slot",
].join("\n");

const VALUE_FLAGS = ["preset", "repo", "params", "every", "at", "cron", "tz", "title", "topics", "labels", "machines", "window", "overlap", "max-goal-age", "missed"];

const iso = (t: number | undefined) => (t === undefined ? "-" : new Date(t).toISOString());
const list = (v: string | undefined) => (v ?? "").split(",").map((x) => x.trim()).filter(Boolean);
const stateText = (s: Pick<PulseSlot, "state" | "reason" | "trial">) => `${s.state}${s.reason ? ` (${s.reason})` : ""}${s.trial ? " (trial)" : ""}`;

/** A usage error: printed, exit 2, nothing sent. */
class Usage extends Error {}

/** A preset snapshot and, for a repo file, the checkout it came from. */
interface Snapshot {
  preset: PresetSnapshot;
  root?: string | undefined;
}

/** The preset snapshot `mesh pulse add --preset` sends: `presetText` of it, its sha256, and (repo files) where it came from. */
function presetSnapshot(cwd: string, name: string): Snapshot {
  let found: ReturnType<typeof findPresetSource>;
  try {
    found = findPresetSource(cwd, name);
  } catch (e) {
    throw new Usage((e as Error).message);
  }
  const text = presetText(found.preset);
  let source: PresetSnapshot["source"];
  if (found.root !== undefined) {
    const r = spawnSync("git", ["-C", found.root, "rev-parse", "HEAD"], { encoding: "utf8" });
    const commit = r.status === 0 ? r.stdout.trim() : "";
    if (commit) source = { repo: basename(found.root), commit };
  }
  return { preset: { name, text, sha256: sha256(text), ...(source ? { source } : {}) }, ...(source ? { root: found.root } : {}) };
}

/**
 * RL-8: the repo agents of the pulse's steps in the preset's source checkout, each as its file is at
 * the snapshot commit (`git show <commit>:.claude/agents/<name>.md`), not as the roster last saw a
 * copy of it. `checked`: the agents found there (the hub leaves them out of its roster warnings);
 * `warnings`: those with invalid front matter. An agent with no file at that commit, or also used by
 * a step in another repo, is left to the roster.
 */
function checkoutAgents(s: Snapshot, params: Record<string, string>): { checked: string[]; warnings: string[] } {
  const source = s.preset.source;
  const repo = params.repo;
  if (s.root === undefined || source === undefined || repo === undefined) return { checked: [], warnings: [] };
  let steps: PlanInput["steps"];
  try {
    steps = instantiate(parsePreset(s.preset.name, s.preset.text), { repo, goal: "this goal", params }).steps;
  } catch {
    return { checked: [], warnings: [] };
  }
  const here = checkoutAgentSteps(steps, repo, source.repo);
  const elsewhere = new Set(steps.filter((x) => x.agent && !here.some((h) => h.step === x.id)).map((x) => x.agent));
  const checked: string[] = [];
  const warnings: string[] = [];
  const files = new Map<string, string | undefined>();
  for (const { step, agent } of here) {
    if (elsewhere.has(agent)) continue;
    if (!files.has(agent)) {
      const r = spawnSync("git", ["-C", s.root, "show", `${source.commit}:.claude/agents/${agent}.md`], { encoding: "utf8" });
      files.set(agent, r.status === 0 ? r.stdout : undefined);
    }
    const text = files.get(agent);
    if (text === undefined) continue;
    if (!checked.includes(agent)) checked.push(agent);
    const invalid = parseAgentFile(text).invalid;
    if (invalid !== undefined) warnings.push(`step "${step}": agent ${agent} in ${source.repo} has invalid front matter: ${invalid} (checkout ${source.repo} at ${source.commit.slice(0, 12)})`);
  }
  return { checked, warnings };
}

/** Warnings on stderr, each saying where it came from: the checkout (ours) or the roster (the hub's). */
function printWarnings(c: CliEnv, local: readonly string[], hub: readonly string[] | undefined): void {
  for (const w of local) c.io.err(`warning: ${w}`);
  for (const w of hub ?? []) c.io.err(`warning: ${w} (roster)`);
}

type Args = ReturnType<typeof parseArgs>;

/** The body fields both `add` and `update` take from flags (only those given). */
function commonFields(a: Args, c: CliEnv): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const every = a.str("every");
  const cron = a.str("cron");
  if (every !== undefined && cron !== undefined) throw new Usage('give one schedule: --every <duration> or --cron "<5 fields>"');
  if (every !== undefined) {
    const at = a.str("at");
    let anchor: number | undefined;
    if (at !== undefined) {
      anchor = /^\d{4}-\d{2}-\d{2}T/.test(at) ? Date.parse(at) : Number.NaN;
      if (Number.isNaN(anchor)) throw new Usage("--at takes an ISO time, e.g. 2026-11-16T09:00:00Z");
    }
    out.when = { every, ...(anchor !== undefined ? { at: anchor } : {}) };
  } else if (cron !== undefined) {
    out.when = { cron, tz: a.str("tz") ?? Intl.DateTimeFormat().resolvedOptions().timeZone };
  }
  if (a.str("title") !== undefined) out.title = a.str("title");
  if (a.str("topics") !== undefined) out.topics = list(a.str("topics"));
  if (a.str("labels") !== undefined || a.str("machines") !== undefined) {
    out.target = { ...(a.str("labels") !== undefined ? { labels: list(a.str("labels")) } : {}), ...(a.str("machines") !== undefined ? { machines: list(a.str("machines")) } : {}) };
  }
  if (a.str("window") !== undefined) out.window = a.str("window");
  if (a.str("overlap") !== undefined) out.overlap = a.str("overlap");
  if (a.str("max-goal-age") !== undefined) out.maxGoalAge = a.str("max-goal-age");
  if (a.str("missed") !== undefined) out.missed = a.str("missed");
  void c;
  return out;
}

function paramsOf(a: Args): Record<string, string> | undefined {
  const p = parseParams(a.has("params") ? (a.str("params") ?? "") : undefined);
  if ("error" in p) throw new Usage(p.error);
  return p.params;
}

function pulseLine(p: PulseView): string {
  const last = p.recent[0];
  return [p.id, p.enabled ? "active" : "paused", `@${p.owner}`, p.schedule, `next ${iso(p.nextAt)}`, `last ${last ? stateText(last) : "-"}`, p.title].join("  ");
}

function showText(d: PulseDetail): string[] {
  const p = d.pulse;
  const state = p.enabled ? "active" : `paused${p.pausedReason ? `: ${p.pausedReason}` : ""}`;
  const params = Object.entries(p.params)
    .map(([k, v]) => `${k}=${v}`)
    .join(",");
  const src = p.preset.source ? ` from ${p.preset.source.repo}@${p.preset.source.commit.slice(0, 12)}` : "";
  const target = [p.target.labels?.length ? `labels ${p.target.labels.join(",")}` : "", p.target.machines?.length ? `machines ${p.target.machines.join(",")}` : ""].filter(Boolean).join("; ");
  const out = [
    `${p.id} "${p.title}"  @${p.owner}  ${state}`,
    `schedule: ${d.schedule}, next ${iso(p.nextAt)}`,
    `preset: ${p.preset.name} ${p.preset.sha256.slice(0, 12)}${src}, params ${params || "-"}`,
    `target: ${target || "any machine that auto-accepts"}`,
    "slots:",
  ];
  for (const s of d.slots) {
    out.push(`  ${s.slot}  ${stateText(s)}  ${s.goal ?? "-"}${s.tried.length ? `  tried ${s.tried.map((t) => t.machine).join(",")}` : ""}`);
  }
  return out;
}

export function pulseCommand(c: CliEnv): Command {
  return {
    name: "pulse",
    help: USAGE,
    summary: "schedules that create goals from a preset: add, ls, show, update, pause, resume, fire, rm",
    async run(args) {
      const [sub, ...rest] = args;
      const a = parseArgs(rest, VALUE_FLAGS);
      const hub = () => HubClient.from(c.paths);
      const id = a.positional[0];
      try {
        switch (sub) {
          case "add": {
            const name = a.str("preset");
            const repo = a.str("repo");
            if (!name || !repo) break;
            if (a.str("every") === undefined && a.str("cron") === undefined) throw new Usage('give one schedule: --every <duration> or --cron "<5 fields>"');
            const fields = commonFields(a, c);
            const params = { ...paramsOf(a), repo };
            const snap = presetSnapshot(c.cwd, name);
            const local = checkoutAgents(snap, params);
            const checked = local.checked.length ? { checkedAgents: local.checked } : {};
            const p = await hub().post<PulseView>("/v1/pulses", { preset: snap.preset, params, ...fields, ...(a.has("paused") ? { enabled: false } : {}), ...checked });
            c.io.out(`Created pulse ${p.id} "${p.title}": ${p.schedule}, next run ${iso(p.nextAt)}.`);
            printWarnings(c, local.warnings, p.warnings);
            return 0;
          }
          case "ls": {
            const r = await hub().get<{ pulses: PulseView[] }>(`/v1/pulses${a.has("mine") ? "?mine=1" : ""}`);
            if (a.has("json")) {
              c.io.out(JSON.stringify(r, null, 2));
              return 0;
            }
            if (r.pulses.length === 0) c.io.out("No pulses. Create one: mesh pulse add --preset <name> --repo <repo> --every 7d");
            for (const p of r.pulses) c.io.out(pulseLine(p));
            return 0;
          }
          case "show": {
            if (!id) break;
            const d = await hub().get<PulseDetail>(`/v1/pulses/${encodeURIComponent(id)}`);
            if (a.has("json")) c.io.out(JSON.stringify(d, null, 2));
            else for (const line of showText(d)) c.io.out(line);
            return 0;
          }
          case "update": {
            if (!id) break;
            const fields = commonFields(a, c);
            const given = paramsOf(a);
            const body: Record<string, unknown> = { ...fields };
            const snap = a.str("preset") !== undefined ? presetSnapshot(c.cwd, a.str("preset") as string) : undefined;
            if (snap) body.preset = snap.preset;
            if (given !== undefined || a.str("repo") !== undefined) {
              let repo = a.str("repo");
              let base: Record<string, string> = {};
              if (repo === undefined || given === undefined) {
                const d = await hub().get<PulseDetail>(`/v1/pulses/${encodeURIComponent(id)}`);
                repo ??= d.pulse.params.repo;
                if (given === undefined) base = d.pulse.params;
              }
              body.params = { ...base, ...given, ...(repo !== undefined ? { repo } : {}) };
            }
            // A new snapshot from a checkout: its agents are checked there (with the pulse's params).
            let local: { checked: string[]; warnings: string[] } = { checked: [], warnings: [] };
            if (snap?.root !== undefined) {
              const params = (body.params as Record<string, string> | undefined) ?? (await hub().get<PulseDetail>(`/v1/pulses/${encodeURIComponent(id)}`)).pulse.params;
              local = checkoutAgents(snap, params);
              if (local.checked.length) body.checkedAgents = local.checked;
            }
            const p = await hub().post<PulseView>(`/v1/pulses/${encodeURIComponent(id)}/update`, body);
            c.io.out(`Updated pulse ${p.id}; next run ${iso(p.nextAt)}.`);
            printWarnings(c, local.warnings, p.warnings);
            return 0;
          }
          case "pause": {
            if (!id) break;
            const p = await hub().post<PulseView>(`/v1/pulses/${encodeURIComponent(id)}/pause`);
            c.io.out(`Paused pulse ${p.id}.`);
            return 0;
          }
          case "resume": {
            if (!id) break;
            const p = await hub().post<PulseView>(`/v1/pulses/${encodeURIComponent(id)}/resume`);
            c.io.out(`Resumed pulse ${p.id}; next run ${iso(p.nextAt)}.`);
            return 0;
          }
          case "fire": {
            if (!id) break;
            const trial = a.has("trial");
            const { slot } = await hub().post<FireResult>(`/v1/pulses/${encodeURIComponent(id)}/fire`, trial ? { trial: true } : {});
            // RL-11: a hub before 0.1.30 ignores the body and fires a normal slot.
            if (trial && slot.trial !== true) {
              c.io.err(
                `The hub ignored --trial (it is older than 0.1.30): slot ${slot.slot} of pulse ${slot.pulse} is ${slot.state}${slot.goal ? ` with goal ${slot.goal}, a normal goal; drop it with: mesh goal drop ${slot.goal}` : ""}.`,
              );
              return 1;
            }
            const slotText = `${slot.slot}${slot.trial ? " (trial)" : ""}`;
            if (slot.state === "fired") {
              c.io.out(`Fired pulse ${slot.pulse}: slot ${slotText} → ${slot.goal ?? "-"}.`);
              return 0;
            }
            if (slot.state === "queued") {
              c.io.out(`Pulse ${slot.pulse} queued slot ${slotText}: ${slot.running ?? "a goal"} is still running (overlap: queue); it fires when that ends.`);
              return 0;
            }
            if (slot.state === "skipped") {
              let running = slot.running;
              let overlap = "skip";
              if (running === undefined) {
                // A hub before 0.1.30 does not say which goal was running: guess it from the slots.
                const d = await hub().get<PulseDetail>(`/v1/pulses/${encodeURIComponent(slot.pulse)}`);
                running = d.slots.find((s) => s.state === "fired" && s.goal !== undefined && d.goals[s.goal] !== "done" && d.goals[s.goal] !== "dropped")?.goal ?? "a goal";
                overlap = d.pulse.overlap;
              } else {
                // RL-15: name the pulse's policy (a trial fire under queue or supersede is skipped too).
                overlap = (await hub().get<PulseDetail>(`/v1/pulses/${encodeURIComponent(slot.pulse)}`)).pulse.overlap;
              }
              c.io.out(`Pulse ${slot.pulse} skipped slot ${slotText}: ${running} is still running (overlap: ${overlap}).`);
              return 0;
            }
            c.io.err(`Pulse ${slot.pulse} missed slot ${slotText}: ${slot.error ?? slot.reason ?? "unknown error"}`);
            return 1;
          }
          case "rm": {
            if (!id) break;
            const r = await hub().post<{ pulse: string }>(`/v1/pulses/${encodeURIComponent(id)}/delete`);
            c.io.out(`Removed pulse ${r.pulse} (its goals stay).`);
            return 0;
          }
        }
      } catch (e) {
        if (e instanceof Usage) {
          c.io.err(e.message);
          return 2;
        }
        if (e instanceof HubCallError) {
          c.io.err(e.message);
          return 1;
        }
        throw e;
      }
      c.io.err(USAGE);
      return 2;
    },
  };
}
