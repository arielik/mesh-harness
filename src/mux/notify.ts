import { closeSync, constants, openSync, readlinkSync, statSync, writeSync } from "node:fs";
import { run, type Runner } from "./exec.ts";

/** Best-effort desktop notification (macOS osascript, Linux notify-send). */
export async function desktopNotify(
  title: string,
  body: string,
  opts: { runner?: Runner; platform?: NodeJS.Platform } = {},
): Promise<boolean> {
  const runner = opts.runner ?? run;
  const platform = opts.platform ?? process.platform;
  if (platform === "darwin") {
    const esc = (s: string) => s.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
    const r = await runner("osascript", ["-e", `display notification "${esc(body)}" with title "${esc(title)}"`], { timeoutMs: 5_000 });
    return r.code === 0;
  }
  if (platform === "linux") {
    const r = await runner("notify-send", ["--app-name=mesh", title, body], { timeoutMs: 5_000 });
    return r.code === 0;
  }
  return false;
}

// ---------- terminal notifications (OSC 9) ----------

/** Where to write a terminal notification: the session's process and, inside tmux, its pane. */
export interface TerminalTarget {
  pid?: number | undefined;
  pane?: string | undefined;
  tmuxSocket?: string | undefined;
}

export interface TerminalNotifyDeps {
  runner?: Runner;
  platform?: NodeJS.Platform;
  /** Resolve a link (/proc/<pid>/fd/N). */
  readlink?: (path: string) => string | undefined;
  /** Write bytes to a terminal device; false when it can't. */
  writeTty?: (tty: string, data: string) => boolean;
  uid?: number;
}

/** Strip control characters: the text goes inside an escape sequence. */
function clean(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/[\u0000-\u001f\u007f-\u009f]/g, " ").trim();
}

/** OSC 9 ("notify"), understood by iTerm2, WezTerm, Ghostty, kitty, Windows Terminal and others. */
export function osc9(title: string, body: string): string {
  const text = clean(`${title}: ${body}`).slice(0, 300);
  return `\u001b]9;${text}\u0007`;
}

/** Wrap a sequence for tmux passthrough (needs `set -g allow-passthrough on`, tmux 3.3+). */
export function tmuxPassthrough(seq: string): string {
  return `\u001bPtmux;${seq.replaceAll("\u001b", "\u001b\u001b")}\u001b\\`;
}

const TTY_RE = /^\/dev\/(pts\/\d+|ttys?\d+|tty[a-z]+\d*)$/;

function defaultReadlink(path: string): string | undefined {
  try {
    return readlinkSync(path);
  } catch {
    return undefined;
  }
}

function defaultWriteTty(uid: number) {
  return (tty: string, data: string): boolean => {
    try {
      // Only a terminal of this user: never write into someone else's session.
      if (statSync(tty).uid !== uid) return false;
      const fd = openSync(tty, constants.O_WRONLY | constants.O_NOCTTY | constants.O_NONBLOCK);
      try {
        writeSync(fd, data);
      } finally {
        closeSync(fd);
      }
      return true;
    } catch {
      return false;
    }
  };
}

/** The terminal device a process writes to, if it has one. */
export async function processTty(pid: number, deps: TerminalNotifyDeps = {}): Promise<string | undefined> {
  const platform = deps.platform ?? process.platform;
  if (platform === "linux") {
    const readlink = deps.readlink ?? defaultReadlink;
    for (const fd of [2, 1, 0]) {
      const t = readlink(`/proc/${pid}/fd/${fd}`);
      if (t && TTY_RE.test(t)) return t;
    }
    return undefined;
  }
  if (platform === "darwin") {
    const r = await (deps.runner ?? run)("ps", ["-o", "tty=", "-p", String(pid)], { timeoutMs: 5_000 });
    const name = r.stdout.trim();
    if (r.code !== 0 || !name || name.startsWith("?")) return undefined;
    const tty = `/dev/${name}`;
    return TTY_RE.test(tty) ? tty : undefined;
  }
  return undefined;
}

/**
 * Write a notification into the session's own terminal as OSC 9. The terminal emulator shows it,
 * also when the session runs on another machine over SSH. Inside tmux it goes to the pane's tty
 * wrapped for passthrough. Best effort: false when there is no terminal to write to.
 */
export async function terminalNotify(target: TerminalTarget, title: string, body: string, deps: TerminalNotifyDeps = {}): Promise<boolean> {
  const runner = deps.runner ?? run;
  const write = deps.writeTty ?? defaultWriteTty(deps.uid ?? process.getuid?.() ?? -1);
  const seq = osc9(title, body);
  if (target.pane) {
    const server = target.tmuxSocket ? ["-S", target.tmuxSocket] : [];
    const r = await runner("tmux", [...server, "display-message", "-p", "-t", target.pane, "#{pane_tty}"], { timeoutMs: 5_000 });
    const tty = r.stdout.trim();
    if (r.code === 0 && TTY_RE.test(tty)) return write(tty, tmuxPassthrough(seq));
  }
  if (target.pid === undefined) return false;
  const tty = await processTty(target.pid, deps);
  return tty ? write(tty, seq) : false;
}
