import { spawn } from "node:child_process";

export interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

export interface RunOptions {
  input?: string;
  timeoutMs?: number;
  cwd?: string;
  env?: Record<string, string | undefined>;
}

/** Run a program (no shell). Never rejects: failures come back as a non-zero code. */
export type Runner = (cmd: string, args: readonly string[], opts?: RunOptions) => Promise<RunResult>;

export const run: Runner = (cmd, args, opts = {}) =>
  new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let settled = false;
    const done = (r: RunResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(r);
    };
    const child = spawn(cmd, args, {
      cwd: opts.cwd,
      env: opts.env ? { ...process.env, ...opts.env } : process.env,
      stdio: [opts.input !== undefined ? "pipe" : "ignore", "pipe", "pipe"],
    });
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      done({ code: 124, stdout, stderr: stderr + `\n${cmd}: timed out` });
    }, opts.timeoutMs ?? 30_000);
    child.stdout?.on("data", (d: Buffer) => (stdout += d.toString()));
    child.stderr?.on("data", (d: Buffer) => (stderr += d.toString()));
    child.on("error", (e) => done({ code: 127, stdout, stderr: String(e) }));
    child.on("close", (code) => done({ code: code ?? 1, stdout, stderr }));
    if (child.stdin) {
      // The program may exit before reading its input; that is not our error.
      child.stdin.on("error", () => undefined);
      child.stdin.end(opts.input);
    }
  });
