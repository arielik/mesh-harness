// "My mesh" (MM-1): plain-text rendering of GET /v1/fleet, shared by the CLI, the TUI and MCP.

import type { FleetMachine, FleetSession, FleetView } from "../protocol/index.ts";

/** A short age: seconds under 60 s, minutes under 60 m, hours under 48 h, else days. */
export function age(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.round(m / 60);
  return h < 48 ? `${h}h` : `${Math.round(h / 24)}d`;
}

function machineTitle(m: FleetMachine): string {
  return m.nickname ? `${m.nickname} (${m.hostname})` : m.hostname;
}

function sessionLine(s: FleetSession, now: number): string {
  const state = s.needs ? `${s.state} (${s.needs})` : s.state;
  return `  ${s.repo || "-"} · ${s.name || s.sid.slice(0, 8)} · ${state} · ${s.step ?? "no step"} · ${age(now - s.lastEventAt)}`;
}

function machineBlock(m: FleetMachine, now: number): string {
  const presence = m.online ? "online" : `last seen ${age(now - m.lastSeen)} ago`;
  const n = m.repos.length;
  const head = `${machineTitle(m)} · ${presence} · share ${m.share ?? "?"} · ${n} ${n === 1 ? "repo" : "repos"}${m.current ? " · this machine" : ""}`;
  const body = m.sessions.length === 0 ? ["  no sessions"] : m.sessions.map((s) => sessionLine(s, now));
  return [head, ...body].join("\n");
}

/** One block per machine, separated by an empty line; no trailing newline. */
export function renderFleet(view: FleetView, opts: { skipCurrent?: boolean } = {}): string {
  const machines = opts.skipCurrent ? view.machines.filter((m) => !m.current) : view.machines;
  if (machines.length === 0) return "No machines logged in as you yet. Run mesh login on each machine.";
  return machines.map((m) => machineBlock(m, view.now)).join("\n\n");
}
