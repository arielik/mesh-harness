#!/usr/bin/env node
import pkg from "../package.json" with { type: "json" };
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { listAgents, wakeBackground } from "./claude/index.ts";
import { dispatch, hubInit, installService, loadConfig, meshCommands, parseArgs, paths, stdio, type CliEnv, type Command } from "./cli/index.ts";
import { HubService, loadHubConfig, startHub } from "./hub/index.ts";
import { runShim } from "./mcp/index.ts";
import { HubStore } from "./store/index.ts";
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
      credentialsPath: p.credentials,
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

const hubConfigPath = (a: ReturnType<typeof parseArgs>) => {
  const explicit = a.str("config") ?? process.env.MESH_HUB_CONFIG;
  if (explicit) return resolve(explicit);
  return existsSync("mesh-hub.yaml") ? resolve("mesh-hub.yaml") : undefined;
};

const hub: Command = {
  name: "hub",
  summary: "run the shared hub (init | token | revoke): mesh hub [--config mesh-hub.yaml]",
  async run(args) {
    const sub = args[0] && !args[0].startsWith("--") ? args[0] : undefined;
    const rest = sub ? args.slice(1) : args;
    const a = parseArgs(rest, ["config", "users", "listen", "service", "user", "machine"]);
    if (sub === "init") {
      const path = resolve(a.str("config") ?? "mesh-hub.yaml");
      const users = (a.str("users") ?? process.env.USER ?? "me").split(",").map((u) => u.trim()).filter(Boolean);
      const { tokens } = hubInit(path, users, a.str("listen") ?? "127.0.0.1:7700");
      stdio.out(`Wrote ${path}. Tokens (shown once; each person logs in with \`mesh login --hub <url> --token <token>\`):`);
      for (const [u, t] of Object.entries(tokens)) stdio.out(`  ${u}: ${t}`);
      stdio.out(`${users[0]} is the first admin. Start the hub with: mesh hub --config ${path}`);
      return 0;
    }
    const config = loadHubConfig(hubConfigPath(a), process.env, process.cwd());
    if (sub === "token" || sub === "revoke") {
      const store = await HubStore.open(config.db);
      try {
        const svc = new HubService(store, config);
        if (sub === "token") {
          const name = a.str("service");
          if (!name) throw new Error("usage: mesh hub token --service <name>");
          stdio.out(svc.serviceToken(name));
        } else {
          const n = store.revokeTokens({ ...(a.str("user") ? { userId: a.str("user") } : {}), ...(a.str("machine") ? { machineId: a.str("machine") } : {}) });
          stdio.out(`Revoked ${n} token(s).`);
        }
      } finally {
        store.close();
      }
      return 0;
    }
    if (sub !== undefined) throw new Error(`unknown hub subcommand "${sub}" (use: init, token, revoke)`);
    const webRoot = join(dirname(self[1] as string), "web");
    const running = await startHub(config, { webRoot: existsSync(webRoot) ? webRoot : undefined });
    stdio.out(`mesh hub on ${running.url} (providers: ${config.providers.map((x) => `${x.id}/${x.kind}`).join(", ")}; db ${config.db})`);
    await new Promise<void>((done) => {
      for (const sig of ["SIGINT", "SIGTERM"] as const) process.once(sig, () => done());
    });
    await running.stop();
    return 0;
  },
};

const mcp: Command = {
  name: "mcp",
  summary: "stdio MCP server for Claude Code (started by Claude, not by you)",
  async run() {
    await runShim({ daemonConfigPath: p.daemonConfig, claudePid: process.ppid, version: pkg.version });
    await new Promise<void>((done) => process.stdin.once("close", () => done()));
    return 0;
  },
};

const commands: Command[] = [up, hub, mcp, ...meshCommands(env)];

try {
  process.exitCode = await dispatch(process.argv.slice(2), commands, pkg.version, (s) => stdio.out(s));
} catch (e) {
  stdio.err(`mesh: ${e instanceof Error ? e.message : String(e)}`);
  process.exitCode = 1;
}
