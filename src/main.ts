#!/usr/bin/env node
import pkg from "../package.json" with { type: "json" };
import { homedir } from "node:os";
import { listAgents, wakeBackground } from "./claude/index.ts";
import { dispatch, installService, loadConfig, meshCommands, parseArgs, paths, stdio, type CliEnv, type Command } from "./cli/index.ts";
import { Daemon, defaultDeps } from "./daemon/index.ts";
import { desktopNotify, pasteToPane } from "./mux/index.ts";
import { DaemonStore } from "./store/index.ts";

// node:sqlite is still flagged experimental; keep that one warning out of the user's terminal.
const emit = process.emitWarning.bind(process);
process.emitWarning = ((warning: string | Error, ...rest: unknown[]) => {
  const text = typeof warning === "string" ? warning : warning.message;
  if (/SQLite/i.test(text)) return;
  (emit as (...a: unknown[]) => void)(warning, ...rest);
}) as typeof process.emitWarning;

const p = paths();
const self = [process.execPath, process.argv[1] ?? "mesh"];
const env: CliEnv = { io: stdio, paths: p, env: process.env, cwd: process.cwd(), self, version: pkg.version };

const up: Command = {
  name: "up",
  summary: "run the local daemon (--install: as a user service)",
  async run(args) {
    const a = parseArgs(args);
    const config = loadConfig(p);
    if (a.has("install")) {
      const svc = installService(process.platform, homedir(), {
        node: process.execPath,
        script: self[1] as string,
        path: process.env.PATH ?? "/usr/bin:/bin",
        logFile: `${p.stateDir}/daemon.log`,
      });
      stdio.out(`Wrote ${svc.file}. Enable it with:\n  ${svc.enable.join("\n  ")}\nDisable with:\n  ${svc.disable.join("\n  ")}`);
      return 0;
    }
    const store = await DaemonStore.open(p.daemonDb);
    const daemon = new Daemon({
      config,
      store,
      deps: defaultDeps({
        listAgents: () => listAgents(),
        paste: (pane, text, server) => pasteToPane(pane, text, server),
        wakeBackground: (t, text) => wakeBackground(t, text),
        notify: (title, body) => desktopNotify(title, body),
      }),
    });
    try {
      await daemon.start();
    } catch (e) {
      const code = (e as { code?: string }).code;
      stdio.err(code === "EADDRINUSE" ? `port ${config.port} is in use (another mesh up running?). Pick another: mesh setup --port N` : String(e));
      store.close();
      return 1;
    }
    await new Promise<void>((resolve) => {
      for (const sig of ["SIGINT", "SIGTERM"] as const) process.once(sig, () => resolve());
    });
    await daemon.stop();
    store.close();
    return 0;
  },
};

const commands: Command[] = [up, ...meshCommands(env)];

try {
  process.exitCode = await dispatch(process.argv.slice(2), commands, pkg.version, (s) => stdio.out(s));
} catch (e) {
  stdio.err(`mesh: ${e instanceof Error ? e.message : String(e)}`);
  process.exitCode = 1;
}
