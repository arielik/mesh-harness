// A hub plus people with daemons, in process, for flow tests.

import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sha256 } from "../../src/auth/index.ts";
import * as claudeModule from "../../src/claude/index.ts";
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
  /** Requests of this daemon sent to the hub (past the `offline` check) whose reply has not come back yet. */
  inflight: number;
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
  /** RL-1: the next request whose path matches is answered with `status` and `{error: "simulated"}`, never sent. */
  failOnce(path: RegExp, status: number): void;
  /** RL-1: the headless deps this machine's daemon was made with (kept across `restart`). */
  headless?: HeadlessOptions | undefined;
  /** RL-1: `deps.runsDir` when headless (default `<dir>/runs`). */
  runsDir?: string | undefined;
}

/** RL-1: daemon deps for headless runs. The real `claude` is never used: `claudeBin` defaults to the fake. */
export interface HeadlessOptions {
  runsDir?: string;
  claudeBin?: string;
  /** Default: `processRunner` from src/claude. */
  runner?: unknown;
  /** Leave `deps.runsDir` unset (the daemon then cannot run headless steps). */
  noRunsDir?: boolean;
  /** Leave `deps.headless` unset. */
  noRunner?: boolean;
  /** Keep `workspaceRoots` as configured instead of `[<dir>]`. */
  keepRoots?: boolean;
  /** Default: the person's checkout for the repo `repo` (by name or id), else none. */
  findCheckout?: (repo: string) => string | undefined;
}

/** RL-1: the fake `claude` executable (test/fixtures/claude/fake-claude/claude). */
export const FAKE_CLAUDE = join(import.meta.dirname, "..", "fixtures", "claude", "fake-claude", "claude");

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
  /** RL-1: give the daemon headless deps (runner, runsDir, the fake claude, meshCommand, findCheckout). */
  headless?: HeadlessOptions;
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
  private fails = new Map<Person, { path: RegExp; status: number }[]>();
  private installs = 0;

  /**
   * `hubYaml`: RL-1, extra top-level hub YAML keys (e.g. `artifacts`), parsed by the real config parser.
   * An `auth` key is merged into the test's auth (e.g. `auth: {session: {device_max_age: "60d"}}`).
   */
  async start(users: string[], opts: { admins?: string[]; hubYaml?: Record<string, unknown> } = {}): Promise<void> {
    const { auth: extraAuth, ...hubYaml } = opts.hubYaml ?? {};
    const config = buildHubConfig(
      {
        listen: "127.0.0.1:0",
        db: ":memory:",
        auth: {
          providers: [{ id: "team", kind: "token", users: users.map((n) => ({ name: n, token_sha256: sha256(`${n}-token-secret`) })) }],
          ...(opts.admins ? { bootstrap_admins: opts.admins.map((n) => `team:${n}`) } : {}),
          ...((extraAuth as Record<string, unknown> | undefined) ?? {}),
        },
        ...hubYaml,
      },
      { baseDir: "/", env: {} },
    );
    this.hubConfig = config;
    this.hubStore = await HubStore.open(":memory:");
    this.hub = await startHub(config, { store: this.hubStore, tickMs: 0, now: () => this.clock });
  }

  /**
   * `fetch` to the hub from the test itself. After `stopHub`/`startHubAgain` the first request may
   * go out on a keep-alive socket of the stopped server (`UND_ERR_SOCKET`, "other side closed"); the
   * request never reached a running hub, so it is sent once more on a new connection.
   */
  private async hubFetch(url: string, init: RequestInit): Promise<Response> {
    try {
      return await fetch(url, init);
    } catch (e) {
      const code = (e as { cause?: { code?: string } }).cause?.code;
      if (code !== "UND_ERR_SOCKET" && code !== "ECONNRESET") throw e;
      return await fetch(url, init);
    }
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
    const res = await this.hubFetch(`${this.hub.url}/auth/team/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
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
      inflight: 0,
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
      failOnce: (path, status) => void fails.push({ path, status }),
    };
    const drops: RegExp[] = [];
    const fails: { path: RegExp; status: number }[] = [];
    this.drops.set(p, drops);
    this.fails.set(p, fails);
    if (opts.headless) {
      p.headless = opts.headless;
      if (!opts.headless.keepRoots) p.config.workspaceRoots = [dir];
    }
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
    /** RL-7: awaited after the old daemon stopped and before the new one starts. */
    whileStopped?: () => Promise<void>,
  ): Promise<void> {
    await p.daemon.stop();
    if (whileStopped) await whileStopped();
    p.config = { ...p.config, ...change } as DaemonConfig;
    if ("maxSessions" in change && change.maxSessions === undefined) delete (p.config as Record<string, unknown>).maxSessions;
    // RL-1: the headless deps are kept unless `opts.headless` replaces them.
    if (opts.headless) p.headless = opts.headless;
    p.daemon = this.makeDaemon(p, { ...opts, ...(p.headless ? { headless: p.headless } : {}) });
    await p.daemon.start(0);
    writeFileSync(p.configPath, JSON.stringify({ ...p.config, port: p.daemon.port }));
  }

  private makeDaemon(p: Person, opts: PersonOptions): Daemon {
    const repoId = opts.repoId ?? `gitlab.lab/vpc/${p.repo}`;
    const drops = this.drops.get(p) ?? [];
    const fails = this.fails.get(p) ?? [];
    // RL-1: DaemonDeps.headless, runsDir, claudeBin, meshCommand, findCheckout (new; passed loosely).
    const h = opts.headless;
    const headlessDeps: Record<string, unknown> = {};
    if (h) {
      p.runsDir = h.noRunsDir ? undefined : (h.runsDir ?? join(p.dir, "runs"));
      if (!h.noRunner) headlessDeps.headless = h.runner ?? (claudeModule as unknown as { processRunner: unknown }).processRunner;
      if (p.runsDir) headlessDeps.runsDir = p.runsDir;
      headlessDeps.claudeBin = h.claudeBin ?? FAKE_CLAUDE;
      headlessDeps.meshCommand = [process.execPath, join(import.meta.dirname, "..", "..", "dist", "main.mjs")];
      headlessDeps.findCheckout = h.findCheckout ?? ((repo: string) => (repo === p.repo || repo === repoId || repo.endsWith(`/${p.repo}`) ? p.repoDir : undefined));
    }
    // MM-3: DaemonDeps.launchStep, a fake that records the call.
    const launch = {
      launchStep: async (repo: string, step: string) => {
        p.launches.push({ repo, step });
        return p.launchResult ?? { ok: true };
      },
    };
    // The hub as this daemon reaches it (after the offline check): records, holds, fails and drops.
    const send = async (url: string | URL | Request, init?: RequestInit): Promise<Response> => {
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
      const f = fails.findIndex((x) => x.path.test(path));
      if (f >= 0) {
        const status = fails.splice(f, 1)[0]?.status ?? 500;
        return new Response(JSON.stringify({ error: "simulated" }), { status, headers: { "content-type": "application/json" } });
      }
      const res = await fetch(url, init);
      const i = drops.findIndex((re) => re.test(path));
      if (i >= 0) {
        drops.splice(i, 1);
        throw new TypeError("fetch failed (simulated lost reply)");
      }
      return res;
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
          p.inflight++;
          try {
            return await send(url, init);
          } finally {
            p.inflight--;
          }
        }) as typeof fetch,
        ...launch,
        ...(headlessDeps as Partial<Parameters<typeof defaultDeps>[0]>),
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
    // Retries: a process outside the test (a run's waiter) may still be finishing a write there.
    for (const d of this.dirs.splice(0)) rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
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

  /**
   * Take `p`'s network down and wait for its requests already on the way to the hub: once this
   * returns, nothing of `p` reaches the hub (so a later clock jump sees its last contact as is).
   */
  async goOffline(p: Person, ms = 5_000): Promise<void> {
    p.offline = true;
    const end = Date.now() + ms;
    while (p.inflight > 0) {
      if (Date.now() > end) throw new Error(`${p.name}: ${p.inflight} request(s) still in flight after ${ms} ms`);
      await new Promise((r) => setTimeout(r, 5));
    }
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
    const r = await this.hubFetch(this.hub.url + path, {
      method,
      headers: { "content-type": "application/json", authorization: `Bearer ${p.login.token}` },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    return { status: r.status, json: await r.json() };
  }

  /** A raw call with any bearer token (a device token from `login`, a service token, or none). */
  async call(token: string | undefined, method: "GET" | "POST", path: string, body?: unknown): Promise<{ status: number; json: Json }> {
    const r = await this.hubFetch(this.hub.url + path, {
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
