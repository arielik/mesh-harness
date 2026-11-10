import { compareVersions, parseVersion, run, type Runner } from "../claude/index.ts";
import { MIN_OPENCODE_VERSION } from "../protocol/index.ts";

export async function opencodeVersion(runner: Runner = run): Promise<string | undefined> {
  const r = await runner("opencode", ["--version"], { timeoutMs: 10_000 });
  return r.code === 0 ? parseVersion(r.stdout) : undefined;
}

/** The plugin API mesh uses (v2: ctx.event.subscribe, ctx.mcp.transform) exists from MIN_OPENCODE_VERSION on. */
export function opencodeSupported(version: string): boolean {
  return compareVersions(version, MIN_OPENCODE_VERSION) >= 0;
}
