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
