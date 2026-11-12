// RL-3: `mesh pulse`: hub schedules that create goals from a preset snapshot.

import { spawnSync } from "node:child_process";
import { basename } from "node:path";
import { sha256 } from "../auth/index.ts";
import { presetText } from "../core/index.ts";
import type { FireResult, PresetSnapshot, PulseDetail, PulseSlot, PulseView } from "../protocol/index.ts";
import type { Command } from "./commands.ts";
import { parseArgs, type CliEnv } from "./context.ts";
import { findPresetSource, parseParams } from "./hub-commands.ts";
import { HubCallError, HubClient } from "./hub-client.ts";

const USAGE = [
  "usage:",
  '  mesh pulse add --preset <name> --repo <repo> [--params k=v,k2=v2] (--every <dur> [--at <ISO>] | --cron "<5 fields>" [--tz <zone>])',
  '                 [--title "…"] [--topics a,b] [--labels a,b] [--machines a,b] [--window <dur>] [--overlap skip|allow]',
  "                 [--max-goal-age <dur>] [--missed record|catch-up-once] [--paused]",
  "  mesh pulse ls [--mine] [--json]",
  "  mesh pulse show <id> [--json]",
  "  mesh pulse update <id> [any add flag except --paused]",
  "  mesh pulse pause <id> | resume <id> | fire <id> | rm <id>",
].join("\n");

const VALUE_FLAGS = ["preset", "repo", "params", "every", "at", "cron", "tz", "title", "topics", "labels", "machines", "window", "overlap", "max-goal-age", "missed"];

const iso = (t: number | undefined) => (t === undefined ? "-" : new Date(t).toISOString());
const list = (v: string | undefined) => (v ?? "").split(",").map((x) => x.trim()).filter(Boolean);
const stateText = (s: Pick<PulseSlot, "state" | "reason">) => `${s.state}${s.reason ? ` (${s.reason})` : ""}`;

/** A usage error: printed, exit 2, nothing sent. */
class Usage extends Error {}

/** The preset snapshot `mesh pulse add --preset` sends: `presetText` of it, its sha256, and (repo files) where it came from. */
function presetSnapshot(cwd: string, name: string): PresetSnapshot {
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
  return { name, text, sha256: sha256(text), ...(source ? { source } : {}) };
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
            const preset = presetSnapshot(c.cwd, name);
            const p = await hub().post<PulseView>("/v1/pulses", { preset, params, ...fields, ...(a.has("paused") ? { enabled: false } : {}) });
            c.io.out(`Created pulse ${p.id} "${p.title}": ${p.schedule}, next run ${iso(p.nextAt)}.`);
            for (const w of p.warnings ?? []) c.io.err(`warning: ${w}`);
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
            if (a.str("preset") !== undefined) body.preset = presetSnapshot(c.cwd, a.str("preset") as string);
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
            const p = await hub().post<PulseView>(`/v1/pulses/${encodeURIComponent(id)}/update`, body);
            c.io.out(`Updated pulse ${p.id}; next run ${iso(p.nextAt)}.`);
            for (const w of p.warnings ?? []) c.io.err(`warning: ${w}`);
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
            const { slot } = await hub().post<FireResult>(`/v1/pulses/${encodeURIComponent(id)}/fire`);
            if (slot.state === "fired") {
              c.io.out(`Fired pulse ${slot.pulse}: slot ${slot.slot} → ${slot.goal ?? "-"}.`);
              return 0;
            }
            if (slot.state === "skipped") {
              const d = await hub().get<PulseDetail>(`/v1/pulses/${encodeURIComponent(slot.pulse)}`);
              const running = d.slots.find((s) => s.state === "fired" && s.goal !== undefined && d.goals[s.goal] !== "done" && d.goals[s.goal] !== "dropped")?.goal ?? "a goal";
              c.io.out(`Pulse ${slot.pulse} skipped slot ${slot.slot}: ${running} is still running (overlap: skip).`);
              return 0;
            }
            c.io.err(`Pulse ${slot.pulse} missed slot ${slot.slot}: ${slot.error ?? slot.reason ?? "unknown error"}`);
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
