// Command-line entry: command table, TUI (plan §9).
export { DaemonClient, DaemonUnreachable } from "./client.ts";
export { dispatch, usage, webRootFor, type Command } from "./commands.ts";
export { loadConfig, NotSetUp, parseArgs, paths, stdio, type Io } from "./context.ts";
export { meshCommands, type CliEnv } from "./mesh-commands.ts";
export { installService, launchdPlist, systemdUnit, type ServiceSpec } from "./service.ts";
export { hubInit } from "./hub-commands.ts";
export { HubClient, loadCredentials } from "./hub-client.ts";
