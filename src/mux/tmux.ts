// tmux adapter (plan §6.4, §7, §9). Every function takes the server to talk to: the socket path a
// session reported ($TMUX), a named socket (tests use `-L`), or the default server.

import { run, type Runner } from "./exec.ts";

export interface TmuxServer {
  /** Socket path, e.g. the first field of $TMUX. */
  socketPath?: string | undefined;
  /** Named socket (`tmux -L <name>`), used by tests. */
  socketName?: string | undefined;
}

export interface TmuxOpts extends TmuxServer {
  runner?: Runner;
}

function base(o: TmuxServer): string[] {
  if (o.socketName) return ["-L", o.socketName];
  if (o.socketPath) return ["-S", o.socketPath];
  return [];
}

async function tmux(o: TmuxOpts, args: string[], input?: string) {
  const runner = o.runner ?? run;
  return runner("tmux", [...base(o), ...args], { timeoutMs: 10_000, ...(input !== undefined ? { input } : {}) });
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Type `text` into a pane as one bracketed paste, then press Enter separately (spike S8).
 * Callers must first confirm the prompt is free (no dialog open): see core `promptIsFree`.
 */
export async function pasteToPane(pane: string, text: string, o: TmuxOpts = {}): Promise<boolean> {
  const buffer = `mesh-${process.pid}-${Date.now()}`;
  if ((await tmux(o, ["load-buffer", "-b", buffer, "-"], text)).code !== 0) return false;
  if ((await tmux(o, ["paste-buffer", "-p", "-d", "-b", buffer, "-t", pane])).code !== 0) return false;
  await sleep(150);
  return (await tmux(o, ["send-keys", "-t", pane, "Enter"])).code === 0;
}

/** Show a pane in the current client (the caller runs inside tmux on the same server). */
export async function jumpToPane(pane: string, o: TmuxOpts = {}): Promise<boolean> {
  const r = await tmux(o, ["switch-client", "-t", pane]);
  if (r.code !== 0) return false;
  await tmux(o, ["select-window", "-t", pane]);
  await tmux(o, ["select-pane", "-t", pane]);
  return true;
}

export async function paneExists(pane: string, o: TmuxOpts = {}): Promise<boolean> {
  const r = await tmux(o, ["display-message", "-p", "-t", pane, "#{pane_id}"]);
  return r.code === 0 && r.stdout.trim() === pane;
}

export async function hasSession(name: string, o: TmuxOpts = {}): Promise<boolean> {
  return (await tmux(o, ["has-session", "-t", `=${name}`])).code === 0;
}

export interface WindowSpec {
  name: string;
  cwd: string;
  /** argv of the program to run in the window (run without a shell). */
  argv: string[];
  env?: Record<string, string>;
}

function windowArgs(w: WindowSpec): string[] {
  const env = Object.entries(w.env ?? {}).flatMap(([k, v]) => ["-e", `${k}=${v}`]);
  return ["-n", w.name, "-c", w.cwd, ...env, "-P", "-F", "#{pane_id}", ...w.argv];
}

/** Create a detached session with a first window; returns its pane id. */
export async function newSession(session: string, w: WindowSpec, o: TmuxOpts = {}): Promise<string> {
  const r = await tmux(o, ["new-session", "-d", "-s", session, "-x", "220", "-y", "50", ...windowArgs(w)]);
  if (r.code !== 0) throw new Error(`tmux new-session failed: ${r.stderr.trim()}`);
  return r.stdout.trim();
}

/** Add a window to a session; returns its pane id. */
export async function newWindow(session: string, w: WindowSpec, o: TmuxOpts = {}): Promise<string> {
  const r = await tmux(o, ["new-window", "-d", "-t", `=${session}:`, ...windowArgs(w)]);
  if (r.code !== 0) throw new Error(`tmux new-window failed: ${r.stderr.trim()}`);
  return r.stdout.trim();
}

/** Bind `prefix + key` to go back to the mesh window. Affects the whole tmux server. */
export async function bindReturnKey(session: string, key: string, o: TmuxOpts = {}): Promise<void> {
  await tmux(o, ["bind-key", key, "switch-client", "-t", `=${session}:0`]);
}

/** The text a pane shows, or undefined when it no longer exists. */
export async function paneText(pane: string, o: TmuxOpts = {}): Promise<string | undefined> {
  if (!(await paneExists(pane, o))) return undefined;
  const r = await tmux(o, ["capture-pane", "-p", "-t", pane]);
  return r.code === 0 ? r.stdout : undefined;
}

/** The socket path of the tmux server a pane runs on. */
export async function paneSocket(pane: string, o: TmuxOpts = {}): Promise<string | undefined> {
  const r = await tmux(o, ["display-message", "-p", "-t", pane, "#{socket_path}"]);
  return r.code === 0 && r.stdout.trim() ? r.stdout.trim() : undefined;
}

export async function capturePane(pane: string, o: TmuxOpts = {}): Promise<string> {
  return (await tmux(o, ["capture-pane", "-p", "-t", pane])).stdout;
}

export async function killServer(o: TmuxOpts = {}): Promise<void> {
  await tmux(o, ["kill-server"]);
}

/** Parse $TMUX ("socket,pid,session") into a server reference. */
export function serverFromEnv(tmuxEnv: string | undefined): TmuxServer | undefined {
  const socketPath = tmuxEnv?.split(",")[0];
  return socketPath ? { socketPath } : undefined;
}
