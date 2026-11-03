export interface Command {
  name: string;
  summary: string;
  run(args: string[]): Promise<number>;
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
  if (name === undefined || name === "help" || name === "--help" || name === "-h") {
    out(usage(commands, version));
    return 0;
  }
  if (name === "--version" || name === "-v" || name === "version") {
    out(version);
    return 0;
  }
  const command = commands.find((c) => c.name === name);
  if (!command) {
    out(`mesh: unknown command "${name}"\n\n${usage(commands, version)}`);
    return 1;
  }
  return command.run(rest);
}
