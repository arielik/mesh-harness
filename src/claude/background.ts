import { run, type Runner } from "./exec.ts";

export interface WakeResult {
  ok: boolean;
  /** Claude started a copy under another id instead of continuing in place. */
  copied?: string;
  error?: string;
}

/**
 * Deliver a prompt to an idle background session (spike S4): stop its process, then
 * `claude --resume <sessionId> --bg <text>`, which wakes the same session with its saved options.
 * A plain `--resume --bg` on a live process would start a copy without our hooks.
 */
export async function wakeBackground(
  target: { bgId: string; sessionId: string; cwd: string },
  text: string,
  runner: Runner = run,
): Promise<WakeResult> {
  await runner("claude", ["stop", target.bgId], { timeoutMs: 30_000 });
  const r = await runner("claude", ["--resume", target.sessionId, "--bg", text], { cwd: target.cwd, timeoutMs: 60_000 });
  if (r.code !== 0) return { ok: false, error: (r.stderr || r.stdout).trim().slice(0, 300) };
  const id = /backgrounded · ([0-9a-f]{6,})/.exec(r.stdout)?.[1];
  if (id && id !== target.bgId) return { ok: false, copied: id, error: `claude started a copy (${id})` };
  return { ok: true };
}

/** Command a person runs to open a background session in their terminal. */
export function attachCommand(bgId: string): string[] {
  return ["claude", "attach", bgId];
}
