import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import type { Runner } from "../claude/index.ts";
import { DaemonConfig, resolvePaths, writeFileAtomic, type MeshPaths } from "../protocol/index.ts";

export interface Io {
  out(text: string): void;
  err(text: string): void;
}

export const stdio: Io = {
  out: (t) => process.stdout.write(t.endsWith("\n") ? t : `${t}\n`),
  err: (t) => process.stderr.write(t.endsWith("\n") ? t : `${t}\n`),
};

export function paths(env: Record<string, string | undefined> = process.env): MeshPaths {
  return resolvePaths(env, homedir());
}

export class NotSetUp extends Error {
  constructor(file: string) {
    super(`mesh is not set up (${file} missing). Run: mesh setup`);
  }
}

export function loadConfig(p: MeshPaths): DaemonConfig {
  if (!existsSync(p.daemonConfig)) throw new NotSetUp(p.daemonConfig);
  return DaemonConfig.parse(JSON.parse(readFileSync(p.daemonConfig, "utf8")));
}

export function newConfig(port?: number): DaemonConfig {
  return {
    port: port ?? 20_000 + Math.floor(Math.random() * 20_000),
    key: randomBytes(24).toString("hex"),
    notify: true,
    workspaceRoots: [],
    autopilot: "nudge",
    shareSessions: "me",
    accept: ["self"],
    assignments: "deliver",
  };
}

export function saveConfig(p: MeshPaths, c: DaemonConfig): void {
  mkdirSync(p.configDir, { recursive: true, mode: 0o700 });
  // The key in this file is also in every installed hook: keep the previous copy as daemon.json.prev.
  writeFileAtomic(p.daemonConfig, `${JSON.stringify(c, null, 2)}\n`, { mode: 0o600, keepPrevious: true });
}

/** Tiny flag parser: --flag, --key value, --key=value; everything else is positional. */
export function parseArgs(args: readonly string[], valueFlags: readonly string[] = []) {
  const flags = new Map<string, string | true>();
  const positional: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i] as string;
    if (a === "--") {
      positional.push(...args.slice(i + 1));
      break;
    }
    if (a.startsWith("--")) {
      const eq = a.indexOf("=");
      if (eq > 0) flags.set(a.slice(2, eq), a.slice(eq + 1));
      else if (valueFlags.includes(a.slice(2)) && i + 1 < args.length) flags.set(a.slice(2), args[++i] as string);
      else flags.set(a.slice(2), true);
    } else {
      positional.push(a);
    }
  }
  const str = (k: string) => {
    const v = flags.get(k);
    return typeof v === "string" ? v : undefined;
  };
  return { flags, positional, has: (k: string) => flags.has(k), str };
}

export interface CliEnv {
  io: Io;
  paths: MeshPaths;
  env: Record<string, string | undefined>;
  cwd: string;
  /** argv to start this mesh binary (node + script), for tmux windows and services. */
  self: string[];
  runner?: Runner;
  /** Read one line from the person (tests inject one); resolves "" when `signal` aborts. */
  readLine?: (prompt: string, signal: AbortSignal) => Promise<string>;
  version: string;
}
