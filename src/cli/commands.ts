import { existsSync, realpathSync } from "node:fs";
import { dirname, join } from "node:path";

export interface Command {
  name: string;
  summary: string;
  /**
   * Printed for `mesh <name> --help` (or `-h`) instead of running the command. Commands that start
   * something long-running (the daemon, a hub, the MCP server) set it, so asking for help never
   * starts a hub or writes a config file.
   */
  help?: string;
  run(args: string[]): Promise<number>;
}

/**
 * The built web dashboard next to the running script, if there is one. The script path may be the
 * npm bin symlink (`<prefix>/bin/mesh`), so it is resolved to the real file (`dist/main.mjs`) first.
 */
export function webRootFor(script: string): string | undefined {
  let real: string;
  try {
    real = realpathSync(script);
  } catch {
    real = script;
  }
  const dir = join(dirname(real), "web");
  return existsSync(dir) ? dir : undefined;
}

export function usage(commands: readonly Command[], version: string): string {
  const width = Math.max(...commands.map((c) => c.name.length));
  const lines = commands.map((c) => `  ${c.name.padEnd(width)}  ${c.summary}`);
  return [`mesh ${version}`, "", "Usage: mesh <command> [options]", "", "Commands:", ...lines, ""].join("\n");
}

export async function dispatch(
  argv: readonly string[],
  commands: readonly Command[],
  version: string,
  out: (s: string) => void,
): Promise<number> {
  const [name, ...rest] = argv;
  const fallback = commands.find((c) => c.name === "tui");
  if (name === undefined && fallback) return fallback.run([]);
  if (name === undefined || name === "help" || name === "--help" || name === "-h") {
    out(usage(commands, version));
    return 0;
  }
  if (name === "--skill") return dispatch(["skill", ...rest], commands, version, out);
  if (name === "--version" || name === "-v" || name === "version") {
    out(version);
    return 0;
  }
  const command = commands.find((c) => c.name === name);
  if (!command) {
    out(`mesh: unknown command "${name}"\n\n${usage(commands, version)}`);
    return 1;
  }
  if (command.help !== undefined && rest.some((x) => x === "--help" || x === "-h")) {
    out(command.help);
    return 0;
  }
  return command.run(rest);
}
