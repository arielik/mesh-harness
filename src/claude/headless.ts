// RL-1: the process runner of headless steps. A run is started through a small detached waiter
// process: the waiter starts the command in a new process group (setsid), sends its output to
// files in the run directory and writes `<runDir>/exit` when it ends, also when the daemon that
// started it is gone. The daemon only ever signals a process whose identity (pid + start id) it
// recorded, so a reused pid is never killed.

import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { run, type RunResult } from "./exec.ts";

export interface HeadlessSpec {
  /** argv[0] is the executable. */
  argv: readonly string[];
  cwd: string;
  /** Added to the daemon's environment. */
  env: Record<string, string>;
  /** stream.jsonl, stderr.log and exit are written here. */
  runDir: string;
}

export interface HeadlessRunner {
  start(spec: HeadlessSpec): Promise<{ ok: true; pid: number; startId: string } | { ok: false; error: string }>;
  /** True only while a process with this pid exists and has this identity. */
  alive(pid: number, startId: string): boolean;
  /** SIGTERM to the process group, SIGKILL 5 s later to what is left; nothing unless `alive`. */
  kill(pid: number, startId: string): Promise<void>;
  /**
   * After the group leader `pid` ended: SIGTERM, then SIGKILL 5 s later, to what is left of its
   * process group, but only to members whose environment carries `MESH_RUN=<runId>` (so a reused
   * process group id is never signalled). Linux only (it reads /proc); elsewhere it does nothing,
   * and leftover members of the group (e.g. a background process the run started) keep running.
   */
  reapGroup?(pid: number, runId: string): Promise<void>;
  git(cwd: string, args: readonly string[]): Promise<RunResult>;
}

/** The waiter, run as `node -e WAITER '<json spec>'`. */
const WAITER = `
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");
const spec = JSON.parse(process.argv[1]);
const file = (n) => path.join(spec.runDir, n);
const put = (n, text) => {
  fs.writeFileSync(file(n + ".tmp"), text);
  fs.renameSync(file(n + ".tmp"), file(n));
};
const out = fs.openSync(file("stream.jsonl"), "a");
const err = fs.openSync(file("stderr.log"), "a");
let child;
try {
  child = spawn(spec.argv[0], spec.argv.slice(1), { cwd: spec.cwd, env: { ...process.env, ...spec.env }, detached: true, stdio: ["ignore", out, err] });
} catch (e) {
  put("start-error", String(e && e.message ? e.message : e));
  process.exit(1);
}
child.on("spawn", () => put("pid", String(child.pid)));
child.on("error", (e) => {
  put("start-error", String(e && e.message ? e.message : e));
  process.exit(1);
});
child.on("exit", (code, signal) => {
  const n = code !== null ? code : 128 + (os.constants.signals[signal] || 0);
  put("exit", String(n));
  process.exit(0);
});
`;

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

let bootId: string | undefined;

/** An opaque name of a process instance; undefined when there is no such process. */
export function processStartId(pid: number): string | undefined {
  if (!Number.isInteger(pid) || pid <= 0) return undefined;
  try {
    if (process.platform === "linux") {
      bootId ??= readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim();
      const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
      const rest = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
      const start = rest[19];
      return start ? `${bootId}:${start}` : undefined;
    }
    const out = execFileSync("ps", ["-o", "lstart=", "-p", String(pid)], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
    return out || undefined;
  } catch {
    return undefined;
  }
}

function groupGone(pgid: number): boolean {
  try {
    process.kill(-pgid, 0);
    return false;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "ESRCH";
  }
}

/** Linux: the live members of process group `pgid` whose environment has `MESH_RUN=<runId>`. */
function runGroupMembers(pgid: number, runId: string): number[] {
  if (process.platform !== "linux" || !Number.isInteger(pgid) || pgid <= 0) return [];
  let names: string[];
  try {
    names = readdirSync("/proc");
  } catch {
    return [];
  }
  const marker = `MESH_RUN=${runId}`;
  const out: number[] = [];
  for (const name of names) {
    if (!/^\d+$/.test(name)) continue;
    try {
      const stat = readFileSync(`/proc/${name}/stat`, "utf8");
      // Fields after "(comm) ": state, ppid, pgrp, …
      const pgrp = Number(stat.slice(stat.lastIndexOf(")") + 2).split(" ")[2]);
      if (pgrp !== pgid) continue;
      if (!readFileSync(`/proc/${name}/environ`, "utf8").split("\0").includes(marker)) continue;
      out.push(Number(name));
    } catch {
      // gone meanwhile, or not ours to read
    }
  }
  return out;
}

function signalAll(pids: readonly number[], signal: NodeJS.Signals): void {
  for (const p of pids) {
    try {
      process.kill(p, signal);
    } catch {
      // gone meanwhile
    }
  }
}

export const processRunner: HeadlessRunner = {
  async start(spec) {
    if (!spec.argv[0]) return { ok: false, error: "no command" };
    try {
      mkdirSync(spec.runDir, { recursive: true });
      const waiter = spawn(process.execPath, ["-e", WAITER, JSON.stringify({ argv: spec.argv, cwd: spec.cwd, env: spec.env, runDir: spec.runDir })], {
        detached: true,
        stdio: "ignore",
        env: process.env,
      });
      waiter.on("error", () => undefined);
      waiter.unref();
    } catch (e) {
      return { ok: false, error: String(e) };
    }
    const pidFile = join(spec.runDir, "pid");
    const errFile = join(spec.runDir, "start-error");
    for (let waited = 0; waited < 5_000; waited += 20) {
      if (existsSync(errFile)) return { ok: false, error: readFileSync(errFile, "utf8").trim() || "could not start" };
      if (existsSync(pidFile)) {
        const pid = Number(readFileSync(pidFile, "utf8").trim());
        const startId = processStartId(pid);
        // A command that ended at once: its identity is gone; the exit file tells the end.
        return { ok: true, pid, startId: startId ?? `ended:${pid}` };
      }
      await sleep(20);
    }
    return { ok: false, error: "the run did not start within 5 s" };
  },

  alive(pid, startId) {
    if (!startId) return false;
    return processStartId(pid) === startId;
  },

  async kill(pid, startId) {
    if (!processRunner.alive(pid, startId)) return;
    try {
      process.kill(-pid, "SIGTERM");
    } catch {
      // gone meanwhile
    }
    for (let waited = 0; waited < 5_000; waited += 100) {
      if (groupGone(pid)) return;
      await sleep(100);
    }
    try {
      process.kill(-pid, "SIGKILL");
    } catch {
      // gone meanwhile
    }
  },

  async reapGroup(pid, runId) {
    if (groupGone(pid)) return;
    const first = runGroupMembers(pid, runId);
    if (!first.length) return;
    signalAll(first, "SIGTERM");
    for (let waited = 0; waited < 5_000; waited += 100) {
      if (!runGroupMembers(pid, runId).length) return;
      await sleep(100);
    }
    signalAll(runGroupMembers(pid, runId), "SIGKILL");
  },

  git(cwd, args) {
    return run("git", args, { cwd, timeoutMs: 120_000 });
  },
};
