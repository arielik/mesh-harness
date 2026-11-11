// A hub plus people with daemons, in process, for flow tests.

import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sha256 } from "../../src/auth/index.ts";
import { Daemon, defaultDeps } from "../../src/daemon/index.ts";
import { repoForCwd } from "../../src/daemon/git.ts";
import { buildHubConfig, startHub, type HubConfig, type RunningHub } from "../../src/hub/index.ts";
import type { AgentEntry, Credentials, DaemonConfig, HookInput, LoginResult, Session } from "../../src/protocol/index.ts";
import { DaemonStore, HubStore } from "../../src/store/index.ts";

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- JSON responses in assertions
export type Json = any;

export interface Person {
  name: string;
  login: LoginResult;
  daemon: Daemon;
  store: DaemonStore;
  pastes: { pane: string; text: string }[];
  notes: string[];
  agents: AgentEntry[] | null;
  /** A git checkout this person's sessions work in. */
  repoDir: string;
  repo: string;
  /** Simulate this person's network to the hub being down. */
  offline: boolean;
  credentialsPath: string;
  /** This machine's folder: credentials.json and daemon.json (MESH_CONFIG_DIR for a CLI run). */
  dir: string;
  /** daemon.json of this machine's daemon (with its port), written once it listens. */
  configPath: string;
  config: DaemonConfig;
  hostname: string;
  /** Every POST /v1/sync body this daemon sent, oldest first. */
  syncs: Json[];
}

export interface PersonOptions {
  solo?: Credentials;
  shareSessions?: DaemonConfig["shareSessions"];
  /** Hostname sent at login (default `<name>-laptop`). */
  hostname?: string;
  /** Install id sent at login (default: a new one per call, so each call is its own machine). */
  install?: string;
  workspaceRoots?: string[];
  /** Repo id of the sessions in this person's checkout (default `gitlab.lab/vpc/<repo>`). */
  repoId?: string;
  /** Log in (for the token) but write no credentials file: this installation is not logged in. */
  noCredentials?: boolean;
}

export class World {
  hub!: RunningHub;
  hubConfig!: HubConfig;
  hubStore!: HubStore;
  clock = 2_000_000_000;
  /** The latest machine started for each name. */
  people: Record<string, Person> = {};
  /** Every machine started, in order (one name may have several). */
  machines: Person[] = [];
  private dirs: string[] = [];
  private installs = 0;

  async start(users: string[], opts: { admins?: string[] } = {}): Promise<void> {
    const config = buildHubConfig(
      {
        listen: "127.0.0.1:0",
        db: ":memory:",
        auth: {
          providers: [{ id: "team", kind: "token", users: users.map((n) => ({ name: n, token_sha256: sha256(`${n}-token-secret`) })) }],
          ...(opts.admins ? { bootstrap_admins: opts.admins.map((n) => `team:${n}`) } : {}),
        },
      },
      { baseDir: "/", env: {} },
    );
    this.hubConfig = config;
    this.hubStore = await HubStore.open(":memory:");
    this.hub = await startHub(config, { store: this.hubStore, tickMs: 0, now: () => this.clock });
  }

  /** The hub goes away (its data stays) … */
  async stopHub(): Promise<void> {
    await this.hub.stop();
  }

  /** … and comes back on the same address with the same data. */
  async startHubAgain(): Promise<void> {
    const config = { ...this.hubConfig, port: this.hub.port, host: "127.0.0.1" };
    this.hub = await startHub(config, { store: this.hubStore, tickMs: 0, now: () => this.clock });
  }

  /** A login only (no daemon): a device token bound to its own machine. */
  async login(name: string, opts: { hostname?: string; install?: string } = {}): Promise<LoginResult> {
    const body = { token: `${name}-token-secret`, hostname: opts.hostname ?? `${name}-laptop`, install: opts.install ?? this.newInstall(name) };
    const res = await fetch(`${this.hub.url}/auth/team/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    return (await res.json()) as LoginResult;
  }

  private newInstall(name: string): string {
    return `inst-${name}-${++this.installs}`.padEnd(8, "x");
  }

  async person(name: string, repo: string, opts: PersonOptions = {}): Promise<Person> {
    const dir = mkdtempSync(join(tmpdir(), `mesh-world-${name}-`));
    this.dirs.push(dir);
    const repoDir = join(dir, repo);
    mkdirSync(repoDir);
    execFileSync("git", ["init", "-q"], { cwd: repoDir });
    const hostname = opts.hostname ?? `${name}-laptop`;
    const login = await this.login(name, { hostname, ...(opts.install ? { install: opts.install } : {}) });
    const credentialsPath = join(dir, "credentials.json");
    if (!opts.solo && !opts.noCredentials) writeFileSync(credentialsPath, JSON.stringify({ hub: this.hub.url, token: login.token, user: login.user, machine: login.machine }));
    const store = await DaemonStore.open(":memory:");
    const config: DaemonConfig = { port: 0, key: "k".repeat(32), notify: true, workspaceRoots: opts.workspaceRoots ?? [], autopilot: "nudge", shareSessions: opts.shareSessions ?? "steps" };
    const p: Person = {
      name,
      login,
      store,
      pastes: [],
      notes: [],
      agents: null,
      repoDir,
      repo,
      daemon: undefined as unknown as Daemon,
      offline: false,
      credentialsPath,
      dir,
      configPath: join(dir, "daemon.json"),
      config,
      hostname,
      syncs: [],
    };
    p.daemon = this.makeDaemon(p, opts);
    await p.daemon.start(0);
    writeFileSync(p.configPath, JSON.stringify({ ...config, port: p.daemon.port }));
    this.people[name] = p;
    this.machines.push(p);
    return p;
  }

  /** Stop this machine's daemon and start it again (same store and credentials), e.g. with another share level. */
  async restart(p: Person, change: Partial<Pick<DaemonConfig, "shareSessions" | "workspaceRoots">> = {}, opts: PersonOptions = {}): Promise<void> {
    await p.daemon.stop();
    p.config = { ...p.config, ...change };
    p.daemon = this.makeDaemon(p, opts);
    await p.daemon.start(0);
    writeFileSync(p.configPath, JSON.stringify({ ...p.config, port: p.daemon.port }));
  }

  private makeDaemon(p: Person, opts: PersonOptions): Daemon {
    const repoId = opts.repoId ?? `gitlab.lab/vpc/${p.repo}`;
    return new Daemon({
      config: p.config,
      store: p.store,
      credentialsPath: p.credentialsPath,
      ...(opts.solo ? { solo: () => opts.solo } : {}),
      version: "test",
      deps: defaultDeps({
        harness: () => ({ hash: "h0", parts: { repo: "r0", user: "u0", plugins: "none", mesh: "test" } }),
        claudeVersion: async () => "2.1.318",
        scanRuns: () => [],
        listAgents: async () => p.agents,
        paste: async (pane, text) => {
          p.pastes.push({ pane, text });
          return true;
        },
        wakeBackground: async () => ({ ok: true }),
        notify: async (t, b) => p.notes.push(`${t}: ${b}`),
        now: () => this.clock,
        // Sessions in the person's own checkout belong to its repo; any other folder is read from git.
        repoForCwd: (cwd) => (cwd === p.repoDir || cwd.startsWith(`${p.repoDir}/`) ? { id: repoId, name: p.repo } : repoForCwd(cwd)),
        mtime: () => undefined,
        log: (l) => process.env.WORLD_LOG && console.log(`[${p.name}] ${l}`),
        hubTimeoutMs: 500,
        fetch: (async (url: string | URL | Request, init?: RequestInit) => {
          if (p.offline) throw new TypeError("fetch failed (simulated network loss)");
          if (init?.method === "POST" && String(url).endsWith("/v1/sync") && typeof init.body === "string") p.syncs.push(JSON.parse(init.body));
          return fetch(url, init);
        }) as typeof fetch,
      }),
      intervals: { reconcileMs: 0, transcriptMs: 0, tickMs: 0, deliveryMs: 0 },
    });
  }

  async stop(): Promise<void> {
    for (const p of this.machines) {
      await p.daemon.stop();
      p.store.close();
    }
    await this.hub.stop();
    for (const d of this.dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  }

  hook(p: Person, kind: "SessionStart" | "UserPromptSubmit" | "Stop" | "SessionEnd", pid: number, extra: Partial<HookInput> = {}) {
    const input: HookInput = { session_id: `claude-${pid}`, cwd: p.repoDir, hook_event_name: kind, transcript_path: `/t/${pid}.jsonl`, ...extra };
    return p.daemon.handleHook(kind, input, { claudePid: String(pid), tmuxPane: `%${pid}` });
  }

  tool(p: Person, pid: number, name: Parameters<Daemon["callTool"]>[0], args: Record<string, unknown> = {}) {
    return p.daemon.callTool(name, { pid, args, key: `${name}-${Math.random()}` });
  }

  session(p: Person, pid: number): Session {
    return p.daemon.sessions.find((s) => s.pid === pid) as Session;
  }

  /** A turn as Claude would report it: prompt, then stop with a message. */
  turn(p: Person, pid: number, said = "ok") {
    this.hook(p, "UserPromptSubmit", pid, { prompt: "work" });
    return this.hook(p, "Stop", pid, { stop_hook_active: false, last_assistant_message: said });
  }

  async flush(): Promise<void> {
    for (const p of this.machines) await p.daemon.link?.flush();
  }

  /** The hub's machine id of this person's installation. */
  machineOf(p: Person): string {
    return p.login.machine as string;
  }

  /** Every POST /v1/sync body this person's daemon sent. */
  syncBodies(p: Person): Json[] {
    return p.syncs;
  }

  async api(p: Person, method: "GET" | "POST", path: string, body?: unknown): Promise<{ status: number; json: Json }> {
    const r = await fetch(this.hub.url + path, {
      method,
      headers: { "content-type": "application/json", authorization: `Bearer ${p.login.token}` },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    return { status: r.status, json: await r.json() };
  }

  /** A raw call with any bearer token (a device token from `login`, a service token, or none). */
  async call(token: string | undefined, method: "GET" | "POST", path: string, body?: unknown): Promise<{ status: number; json: Json }> {
    const r = await fetch(this.hub.url + path, {
      method,
      headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    const text = await r.text();
    let json: Json;
    try {
      json = text ? JSON.parse(text) : undefined;
    } catch {
      json = text;
    }
    return { status: r.status, json };
  }
}
