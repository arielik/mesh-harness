// Pure rendering of the session list (plan §9). No I/O, so it can be snapshot-tested.

import { needsLabel, sessionLabel } from "../../core/index.ts";
import type { Message, Session } from "../../protocol/index.ts";

export type Group = "NEEDS YOU" | "WORKING" | "STALLED / QUIET" | "IDLE" | "ENDED";
export const GROUP_ORDER: Group[] = ["NEEDS YOU", "WORKING", "STALLED / QUIET", "IDLE", "ENDED"];

export function groupOf(s: Session): Group {
  if (s.state === "needs_you") return "NEEDS YOU";
  if (s.state === "stalled" || (s.state === "working" && s.quiet)) return "STALLED / QUIET";
  if (s.state === "working") return "WORKING";
  if (s.state === "ended") return "ENDED";
  return "IDLE";
}

/** Sessions in display order (the order the cursor moves through). */
export function ordered(sessions: readonly Session[]): Session[] {
  const rank = (s: Session) => GROUP_ORDER.indexOf(groupOf(s));
  return [...sessions].sort(
    (a, b) => rank(a) - rank(b) || (b.lastEventAt ?? 0) - (a.lastEventAt ?? 0) || a.sid.localeCompare(b.sid),
  );
}

export function age(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.round(m / 60);
  return h < 48 ? `${h}h` : `${Math.round(h / 24)}d`;
}

const ICON: Record<Group, string> = { "NEEDS YOU": "●", WORKING: "◐", "STALLED / QUIET": "◌", IDLE: "○", ENDED: "·" };

function detail(s: Session, now: number): string {
  switch (groupOf(s)) {
    case "NEEDS YOU":
      return needsLabel(s);
    case "WORKING":
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

function since(s: Session, now: number): number {
  if (s.state === "needs_you" || s.state === "idle") return now - (s.lastStopAt ?? s.lastEventAt);
  return now - s.lastEventAt;
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
  for (const m of v.messages) if (m.state === "pending") pendingBySid.set(m.sid, (pendingBySid.get(m.sid) ?? 0) + 1);

  const list = ordered(v.sessions);
  if (list.length === 0) {
    lines.push("  No Claude Code sessions yet. Start one with `claude` or `mesh run <repo>`.");
  }
  const labelW = Math.min(24, Math.max(10, ...list.map((s) => sessionLabel(s).length)));
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
    const right = `${pending ? `✉${pending} ` : ""}${s.bgId ? "bg " : ""}${age(since(s, v.now)).padStart(4)}`;
    const left = `  ${ICON[g]} ${fit(sessionLabel(s), labelW)}  `;
    const middle = fit(detail(s, v.now), Math.max(0, v.width - left.length - right.length - 1));
    const row = `${left}${middle} ${right}`;
    lines.push(s.sid === v.selected ? paint(C.inverse, row) : row);
  }

  const footer: string[] = [];
  if (v.input) footer.push(paint(C.bold, `${v.input.label}${v.input.value}▌`));
  else footer.push(paint(C.dim, "⏎ jump · s say · r refresh · ↑↓ move · q quit"));
  if (v.status) footer.push(fit(v.status, v.width));
  const room = v.height - footer.length - 1;
  const body = lines.length > room ? [...lines.slice(0, Math.max(0, room - 1)), paint(C.dim, "  …")] : lines;
  while (body.length < room) body.push("");
  return [...body, "", ...footer];
}
