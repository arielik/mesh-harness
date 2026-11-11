// Pure rendering of the session list (plan §9). No I/O, so it can be snapshot-tested.

import { age, messageStage, needsLabel, renderFleet, SESSION_STAGES, sessionLabel, sessionStage, type SessionStage } from "../../core/index.ts";
import type { FleetView, Message, Session } from "../../protocol/index.ts";

/** Session groups come from the stage table in core (one source for every panel). */
export type Group = SessionStage;
export const GROUP_ORDER: readonly Group[] = SESSION_STAGES;

export function groupOf(s: Session): Group {
  return sessionStage(s);
}

/** Sessions in display order (the order the cursor moves through). */
export function ordered(sessions: readonly Session[]): Session[] {
  const rank = (s: Session) => GROUP_ORDER.indexOf(groupOf(s));
  return [...sessions].sort(
    (a, b) => rank(a) - rank(b) || (b.lastEventAt ?? 0) - (a.lastEventAt ?? 0) || a.sid.localeCompare(b.sid),
  );
}

export { age };

const ICON: Record<Group, string> = { "NEEDS YOU": "●", WORKING: "◐", "STALLED / QUIET": "◌", IDLE: "○", ENDED: "·" };

function detail(s: Session, now: number): string {
  switch (groupOf(s)) {
    case "NEEDS YOU":
      return needsLabel(s);
    case "WORKING":
      if (s.launching) return "starting Claude…";
      // No hook yet: the session started before `mesh setup`, so mesh only sees what Claude reports.
      if (s.hooksVersion === undefined && s.turns === 0) return "working · started before mesh setup (restart it to count turns)";
      return `working · turn ${s.turns} · ${age(now - (s.lastTurnStartAt ?? s.lastEventAt))}`;
    case "STALLED / QUIET":
      return s.state === "stalled"
        ? "stopped with its step open"
        : `quiet: no transcript activity for ${age(now - Math.max(s.transcriptMtime ?? 0, s.lastEventAt))}`;
    case "ENDED":
      return `ended (${s.endedReason ?? "?"})`;
    default:
      return s.lastMessage ? `done: ${s.lastMessage}` : "idle";
  }
}

/** Time since the session last did something: its last hook, or its transcript's last write. */
export function since(s: Session, now: number): number {
  const transcript = s.transcriptMtime ?? 0;
  if (s.state === "needs_you" || s.state === "idle") return now - Math.max(s.lastStopAt ?? s.lastEventAt, s.lastStopAt === undefined ? transcript : 0);
  return now - Math.max(s.lastEventAt, transcript);
}

function fit(text: string, width: number): string {
  if (width <= 0) return "";
  return text.length > width ? `${text.slice(0, Math.max(0, width - 1))}…` : text.padEnd(width);
}

export interface View {
  sessions: Session[];
  messages: Message[];
  selected?: string | undefined;
  now: number;
  width: number;
  height: number;
  header: string;
  status?: string | undefined;
  input?: { label: string; value: string } | undefined;
  color: boolean;
}

const C = { reset: "\x1b[0m", bold: "\x1b[1m", dim: "\x1b[2m", inverse: "\x1b[7m", yellow: "\x1b[33m", green: "\x1b[32m", red: "\x1b[31m" };

export function render(v: View): string[] {
  const paint = (code: string, t: string) => (v.color ? `${code}${t}${C.reset}` : t);
  const lines: string[] = [];
  const needs = v.sessions.filter((s) => s.state === "needs_you").length;
  lines.push(paint(C.bold, fit(`${v.header}${needs ? `  ·  ${needs} need you` : ""}`, v.width)));
  lines.push("");

  const pendingBySid = new Map<string, number>();
  for (const m of v.messages) if (messageStage(m) === "waiting") pendingBySid.set(m.sid, (pendingBySid.get(m.sid) ?? 0) + 1);
  const failedDeliveries = v.messages.filter((m) => messageStage(m) === "failed delivery");

  const list = ordered(v.sessions);
  if (list.length === 0) {
    lines.push("  No Claude Code sessions yet. Start one with `claude` or `mesh run <repo>`.");
  }
  // OpenCode sessions carry a small agent marker.
  const shown = (s: Session) => (s.agent === "opencode" ? `${sessionLabel(s)} ·oc` : sessionLabel(s));
  const labelW = Math.min(24, Math.max(10, ...list.map((s) => shown(s).length)));
  const stepW = Math.min(16, Math.max(0, ...list.map((s) => (s.step ?? "").length)));
  let current: Group | undefined;
  for (const s of list) {
    const g = groupOf(s);
    if (g !== current) {
      if (current !== undefined) lines.push("");
      const n = list.filter((x) => groupOf(x) === g).length;
      const color = g === "NEEDS YOU" ? C.yellow : g === "STALLED / QUIET" ? C.red : C.dim;
      lines.push(paint(color, `${g} (${n})`));
      current = g;
    }
    const pending = pendingBySid.get(s.sid);
    const auto = s.autopilot && s.autopilot !== "nudge" ? `${s.autopilot} ` : "";
    const right = `${pending ? `✉${pending} ` : ""}${auto}${s.bgId ? "bg " : ""}${age(since(s, v.now)).padStart(4)}`;
    const left = `  ${ICON[g]} ${fit(shown(s), labelW)}  ${stepW ? `${fit(s.step ?? "—", stepW)}  ` : ""}`;
    const middle = fit(detail(s, v.now), Math.max(0, v.width - left.length - right.length - 1));
    const row = `${left}${middle} ${right}`;
    lines.push(s.sid === v.selected ? paint(C.inverse, row) : row);
  }

  const footer: string[] = [];
  if (v.input) footer.push(paint(C.bold, `${v.input.label}${v.input.value}▌`));
  else footer.push(paint(C.dim, "⏎ jump · s say · a autopilot · n next step · g goals · m machines · r refresh · ↑↓ move · q quit"));
  if (failedDeliveries.length) footer.push(paint(C.red, fit(`${failedDeliveries.length} message(s) could not be delivered: ${failedDeliveries.map((m) => m.error ?? "?").slice(0, 2).join("; ")}`, v.width)));
  if (v.status) footer.push(fit(v.status, v.width));
  const room = v.height - footer.length - 1;
  const body = lines.length > room ? [...lines.slice(0, Math.max(0, room - 1)), paint(C.dim, "  …")] : lines;
  while (body.length < room) body.push("");
  return [...body, "", ...footer];
}

export interface GoalRow {
  id: string;
  title: string;
  state: string;
  owner: string;
  done: number;
  total: number;
  holders: string[];
}

/** Shorten to `width` characters (no padding). */
function clip(text: string, width: number): string {
  if (width <= 0) return "";
  return text.length > width ? `${text.slice(0, Math.max(0, width - 1))}…` : text;
}

export const MACHINES_FOOTER = "m back to sessions · g goals · details: mesh machines";

/**
 * The My machines panel of the TUI (`m`, MM-1): the person's other machines and their sessions.
 * Exactly `height` lines; the footer is the last line and a status, when given, the one above it.
 */
export function renderMachines(fleet: FleetView, v: { width: number; height: number; header: string; status?: string | undefined }): string[] {
  const lines = [v.header, "", "MY MACHINES"];
  if (fleet.machines.every((m) => m.current)) lines.push("  No other machines. Run mesh login on your other machines.");
  else for (const l of renderFleet(fleet, { skipCurrent: true }).split("\n")) lines.push(l === "" ? "" : `  ${l}`);
  const footer = [...(v.status ? [v.status] : []), MACHINES_FOOTER].map((l) => clip(l, v.width));
  const room = Math.max(0, v.height - footer.length);
  const body = lines.slice(0, room).map((l) => clip(l, v.width));
  while (body.length < room) body.push("");
  return [...body, ...footer].slice(-Math.max(0, v.height));
}

/** The goals view of the TUI (`g`). */
export function renderGoals(goals: readonly GoalRow[], v: { width: number; height: number; header: string; status?: string | undefined }): string[] {
  const lines = [v.header, "", "GOALS"];
  if (goals.length === 0) lines.push("  No goals. Create one: mesh goal new \"<title>\"");
  for (const g of goals) {
    const bar = g.total ? `${"█".repeat(Math.round((10 * g.done) / g.total))}${"░".repeat(10 - Math.round((10 * g.done) / g.total))}` : "          ";
    const row = `  ${g.id.padEnd(5)} ${fit(g.title, 32)}  ${g.state.replace(/_/g, " ").padEnd(17)} ${bar} ${`${g.done}/${g.total}`.padEnd(5)} ${g.holders.map((h) => `@${h}`).join(" ")}`;
    lines.push(fit(row, v.width));
  }
  const footer = ["g back to sessions · details: mesh show <goal>", ...(v.status ? [fit(v.status, v.width)] : [])];
  const room = v.height - footer.length - 1;
  const body = lines.slice(0, room);
  while (body.length < room) body.push("");
  return [...body, "", ...footer];
}
