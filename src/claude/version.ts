import { run, type Runner } from "./exec.ts";

/** Oldest Claude Code version the M0 spikes confirmed (docs/spikes). */
export const MIN_CLAUDE_VERSION = "2.1.314";

export function parseVersion(text: string): string | undefined {
  return /(\d+\.\d+\.\d+)/.exec(text)?.[1];
}

export function compareVersions(a: string, b: string): number {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < 3; i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return Math.sign(d);
  }
  return 0;
}

export async function claudeVersion(runner: Runner = run): Promise<string | undefined> {
  const r = await runner("claude", ["--version"], { timeoutMs: 10_000 });
  return r.code === 0 ? parseVersion(r.stdout) : undefined;
}
