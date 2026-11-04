// Command-line entry: command table, TUI (plan §9).
export { DaemonClient, DaemonUnreachable } from "./client.ts";
export { dispatch, usage, type Command } from "./commands.ts";
export { loadConfig, NotSetUp, parseArgs, paths, stdio, type Io } from "./context.ts";
export { meshCommands, type CliEnv } from "./mesh-commands.ts";
export { installService, launchdPlist, systemdUnit, type ServiceSpec } from "./service.ts";
