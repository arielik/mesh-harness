#!/usr/bin/env node
import pkg from "../package.json" with { type: "json" };
import { existsSync, mkdirSync } from "node:fs";
import { homedir, hostname, userInfo } from "node:os";
import { dirname, join, resolve } from "node:path";
import { listAgents, wakeBackground } from "./claude/index.ts";
import { dispatch, hubInit, installService, loadConfig, meshCommands, parseArgs, paths, stdio, type CliEnv, type Command } from "./cli/index.ts";
import { buildHubConfig, HubService, loadHubConfig, startHub, type RunningHub } from "./hub/index.ts";
import { runShim } from "./mcp/index.ts";
import { copyHubToPostgres, describeDbTarget, HubStore, isPostgresUrl } from "./store/index.ts";
import { Daemon, defaultDeps } from "./daemon/index.ts";
import { desktopNotify, paneText, pasteToPane, terminalNotify } from "./mux/index.ts";
import { DaemonStore } from "./store/index.ts";
import { notifyChannels, writeFileAtomic, type Credentials } from "./protocol/index.ts";


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
    // Solo (M4): a local hub on loopback, used whenever no team hub is configured. Everything works
    // without a team hub; `mesh login` switches to it, `mesh logout` back to Solo.
    let solo: { hub: RunningHub; creds: Credentials } | undefined;
    if (!a.has("no-solo")) {
      try {
        solo = await startSolo();
      } catch (e) {
        stdio.err(`mesh: the Solo hub did not start (${e instanceof Error ? e.message : String(e)}); team mode still works`);
      }
    }
    const daemon = new Daemon({
      config,
      store,
      credentialsPath: p.credentials,
      ...(solo ? { solo: () => solo?.creds } : {}),
      version: pkg.version,
      deps: defaultDeps({
        listAgents: () => listAgents(),
        paste: (pane, text, server) => pasteToPane(pane, text, server),
        paneText: (pane, server) => paneText(pane, server),
        wakeBackground: (t, text) => wakeBackground(t, text),
        notify: async (title, body, target) => {
          const ch = notifyChannels(config);
          const sent = await Promise.all([
            ch.desktop ? desktopNotify(title, body) : false,
            ch.terminal && target ? terminalNotify(target, title, body) : false,
          ]);
          return sent.some(Boolean);
        },
        // MESH_BACKFILL=off: don't import past workflow runs (test daemons; privacy-minded setups).
        ...(process.env.MESH_BACKFILL === "off" ? { scanRuns: () => [] } : {}),
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
    await solo?.hub.stop();
    store.close();
    return 0;
  },
};

async function startSolo(): Promise<{ hub: RunningHub; creds: Credentials }> {
  const user = (process.env.USER ?? userInfo().username ?? "me").replace(/[^A-Za-z0-9._-]/g, "") || "me";
  mkdirSync(p.stateDir, { recursive: true });
  const config = buildHubConfig(
    { listen: "127.0.0.1:0", db: p.soloHubDb, auth: { providers: [{ id: "local", kind: "none", user }], bootstrap_admins: [`local:${user}`] } },
    { baseDir: p.stateDir, env: {} },
  );
  const webRoot = join(dirname(self[1] as string), "web");
  const hub = await startHub(config, { webRoot: existsSync(webRoot) ? webRoot : undefined });
  const login = await hub.svc.loginDirect("local", { client: "cli", hostname: hostname() });
  const creds: Credentials = { hub: hub.url, token: login.token, user: login.user, ...(login.machine ? { machine: login.machine } : {}) };
  writeFileAtomic(p.soloCredentials, `${JSON.stringify(creds, null, 2)}\n`, { mode: 0o600 });
  return { hub, creds };
}

const hubConfigPath = (a: ReturnType<typeof parseArgs>) => {
  const explicit = a.str("config") ?? process.env.MESH_HUB_CONFIG;
  if (explicit) return resolve(explicit);
  return existsSync("mesh-hub.yaml") ? resolve("mesh-hub.yaml") : undefined;
};

const hub: Command = {
  name: "hub",
  summary: "run the shared hub (init | token | revoke | backup <file> | migrate): mesh hub [--config mesh-hub.yaml]",
  async run(args) {
    const sub = args[0] && !args[0].startsWith("--") ? args[0] : undefined;
    const rest = sub ? args.slice(1) : args;
    const a = parseArgs(rest, ["config", "users", "listen", "service", "user", "machine", "from", "to"]);
    if (sub === "init") {
      const path = resolve(a.str("config") ?? "mesh-hub.yaml");
      const users = (a.str("users") ?? process.env.USER ?? "me").split(",").map((u) => u.trim()).filter(Boolean);
      const { tokens } = hubInit(path, users, a.str("listen") ?? "127.0.0.1:7700");
      stdio.out(`Wrote ${path}. Tokens (shown once; each person logs in with \`mesh login --hub <url> --token <token>\`):`);
      for (const [u, t] of Object.entries(tokens)) stdio.out(`  ${u}: ${t}`);
      stdio.out(`${users[0]} is the first admin. Start the hub with: mesh hub --config ${path}`);
      return 0;
    }
    if (sub === "migrate") {
      // The URL may come from the environment (MESH_HUB_DB) so its password stays off the command line.
      const from = a.str("from");
      const envDb = process.env.MESH_HUB_DB;
      const to = a.str("to") ?? (envDb && isPostgresUrl(envDb) ? envDb : undefined);
      if (!from || !to) throw new Error("usage: mesh hub migrate --from <sqlite file> --to postgres://… [--force] (--to defaults to MESH_HUB_DB)");
      const file = resolve(from);
      stdio.out(`Copying ${file} to ${describeDbTarget(to)} (stop every hub using either first)…`);
      const report = await copyHubToPostgres(file, to, { force: a.has("force") });
      for (const t of report.tables) stdio.out(`  ${t.name.padEnd(14)} ${t.rows}`);
      const total = report.tables.reduce((n, t) => n + t.rows, 0);
      stdio.out(`Copied ${total} rows; every table's row count matches${report.replaced ? " (the hub that was there is gone)" : ""}.`);
      stdio.out("Now set db: (or MESH_HUB_DB) to the postgres:// URL and start the hub. Keep the SQLite file as a backup.");
      return 0;
    }
    const config = loadHubConfig(hubConfigPath(a), process.env, process.cwd());
    if (sub === "backup") {
      const target = rest.find((x) => !x.startsWith("--") && x !== a.str("config"));
      if (!target) throw new Error("usage: mesh hub backup <file> [--config mesh-hub.yaml]");
      const file = resolve(target);
      if (existsSync(file)) throw new Error(`${file} exists; pick a new file name`);
      const store = await HubStore.open(config.db);
      try {
        await store.backup(file);
      } finally {
        await store.close();
      }
      stdio.out(`Backed up ${config.db} to ${file}. Restore: stop the hub, copy it over the db file, start the hub.`);
      return 0;
    }
    if (sub === "token" || sub === "revoke") {
      const store = await HubStore.open(config.db);
      try {
        const svc = new HubService(store, config);
        if (sub === "token") {
          const name = a.str("service");
          if (!name) throw new Error("usage: mesh hub token --service <name>");
          stdio.out(await svc.serviceToken(name));
        } else {
          const n = await store.revokeTokens({ ...(a.str("user") ? { userId: a.str("user") } : {}), ...(a.str("machine") ? { machineId: a.str("machine") } : {}) });
          stdio.out(`Revoked ${n} token(s).`);
        }
      } finally {
        await store.close();
      }
      return 0;
    }
    if (sub !== undefined) throw new Error(`unknown hub subcommand "${sub}" (use: init, token, revoke, backup, migrate)`);
    const webRoot = join(dirname(self[1] as string), "web");
    const running = await startHub(config, { webRoot: existsSync(webRoot) ? webRoot : undefined });
    stdio.out(`mesh hub on ${running.url} (providers: ${config.providers.map((x) => `${x.id}/${x.kind}`).join(", ")}; db ${describeDbTarget(config.db)})`);
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
