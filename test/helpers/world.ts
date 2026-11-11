// A hub plus people with daemons, in process, for flow tests.

import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sha256 } from "../../src/auth/index.ts";
import { Daemon, defaultDeps } from "../../src/daemon/index.ts";
import { repoForCwd } from "../../src/daemon/git.ts";
import { buildHubConfig, startHub, type HubConfig, type RunningHub } from "../../src/hub/index.ts";
import type { AgentEntry, Credentials, DaemonConfig, HookHeaders, HookInput, LoginResult, Session } from "../../src/protocol/index.ts";
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
  /** MM-3: every inbox ack this daemon sent to the hub (message id, state, method), oldest first. */
  acks: { id: number; state: string; method?: string }[];
  /** MM-3: every request this daemon sent to the hub (method, path, Idempotency-Key header). */
  requests: { method: string; path: string; key: string | null }[];
  /** MM-3: every `launchStep` call of this daemon (a fake: nothing is started). */
  launches: { repo: string; step: string }[];
  /** MM-3: what the `launchStep` fake answers (default `{ok: true}`). */
  launchResult?: { ok: boolean; error?: string };
  /** MM-3: the next request whose path matches is sent to the hub, but its reply is lost (a network error instead). */
  dropReplyOnce(path: RegExp): void;
  /** MM-3: awaited before a request whose path matches is sent to the hub (to hold it in flight). */
  hold?: { path: RegExp; until: Promise<void> } | undefined;
  /** MM-4: every line this daemon passed to `deps.log`, oldest first (printed too under WORLD_LOG). */
  logs: string[];
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
  private drops = new Map<Person, RegExp[]>();
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
    // MM-3: the accept policy and assignments a parsed daemon.json without the fields has.
    const config = {
      port: 0,
      key: "k".repeat(32),
      notify: true,
      workspaceRoots: opts.workspaceRoots ?? [],
      autopilot: "nudge",
      shareSessions: opts.shareSessions ?? "steps",
      accept: ["self"],
      assignments: "deliver",
    } as DaemonConfig;
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
      acks: [],
      requests: [],
      launches: [],
      logs: [],
      dropReplyOnce: (path) => void drops.push(path),
    };
    const drops: RegExp[] = [];
    this.drops.set(p, drops);
    p.daemon = this.makeDaemon(p, opts);
    await p.daemon.start(0);
    writeFileSync(p.configPath, JSON.stringify({ ...config, port: p.daemon.port }));
    this.people[name] = p;
    this.machines.push(p);
    return p;
  }

  /** Stop this machine's daemon and start it again (same store and credentials), e.g. with another share level. */
  async restart(
    p: Person,
    change: Partial<Pick<DaemonConfig, "shareSessions" | "workspaceRoots">> & {
      accept?: string[];
      assignments?: "deliver" | "launch" | "off";
      /** MM-4: the cap on live sessions for a launch; `undefined` removes the field. */
      maxSessions?: number | undefined;
    } = {},
    opts: PersonOptions = {},
  ): Promise<void> {
    await p.daemon.stop();
    p.config = { ...p.config, ...change } as DaemonConfig;
    if ("maxSessions" in change && change.maxSessions === undefined) delete (p.config as Record<string, unknown>).maxSessions;
    p.daemon = this.makeDaemon(p, opts);
    await p.daemon.start(0);
    writeFileSync(p.configPath, JSON.stringify({ ...p.config, port: p.daemon.port }));
  }

  private makeDaemon(p: Person, opts: PersonOptions): Daemon {
    const repoId = opts.repoId ?? `gitlab.lab/vpc/${p.repo}`;
    const drops = this.drops.get(p) ?? [];
    // MM-3: DaemonDeps.launchStep, a fake that records the call.
    const launch = {
      launchStep: async (repo: string, step: string) => {
        p.launches.push({ repo, step });
        return p.launchResult ?? { ok: true };
      },
    };
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
        log: (l) => {
          p.logs.push(l);
          if (process.env.WORLD_LOG) console.log(`[${p.name}] ${l}`);
        },
        hubTimeoutMs: 500,
        fetch: (async (url: string | URL | Request, init?: RequestInit) => {
          if (p.offline) throw new TypeError("fetch failed (simulated network loss)");
          if (init?.method === "POST" && String(url).endsWith("/v1/sync") && typeof init.body === "string") p.syncs.push(JSON.parse(init.body));
          const path = new URL(String(url)).pathname;
          const method = init?.method ?? "GET";
          p.requests.push({ method, path, key: new Headers(init?.headers).get("idempotency-key") });
          const ack = /^\/v1\/inbox\/(\d+)\/ack$/.exec(path);
          if (ack && method === "POST" && typeof init?.body === "string") {
            const b = JSON.parse(init.body) as { state: string; method?: string };
            p.acks.push({ id: Number(ack[1]), state: b.state, ...(b.method !== undefined ? { method: b.method } : {}) });
          }
          if (p.hold && p.hold.path.test(path)) await p.hold.until;
          const res = await fetch(url, init);
          const i = drops.findIndex((re) => re.test(path));
          if (i >= 0) {
            drops.splice(i, 1);
            throw new TypeError("fetch failed (simulated lost reply)");
          }
          return res;
        }) as typeof fetch,
        ...launch,
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

  /** `headers`: extra hook headers, e.g. `{ step }` as a real hook sends `X-Mesh-Step: $MESH_STEP`. */
  hook(p: Person, kind: "SessionStart" | "UserPromptSubmit" | "Stop" | "SessionEnd", pid: number, extra: Partial<HookInput> = {}, headers: Partial<HookHeaders> = {}) {
    const input: HookInput = { session_id: `claude-${pid}`, cwd: p.repoDir, hook_event_name: kind, transcript_path: `/t/${pid}.jsonl`, ...extra };
    return p.daemon.handleHook(kind, input, { claudePid: String(pid), tmuxPane: `%${pid}`, ...headers });
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

  /** MM-3: the hub's tick once, at `w.clock` (offer expiry, pauses). */
  async tick(): Promise<void> {
    await this.hub.svc.tick();
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
