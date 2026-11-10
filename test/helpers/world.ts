// A hub plus people with daemons, in process, for flow tests.

import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sha256 } from "../../src/auth/index.ts";
import { Daemon, defaultDeps } from "../../src/daemon/index.ts";
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
}

export class World {
  hub!: RunningHub;
  hubConfig!: HubConfig;
  hubStore!: HubStore;
  clock = 2_000_000_000;
  people: Record<string, Person> = {};
  private dirs: string[] = [];

  async start(users: string[]): Promise<void> {
    const config = buildHubConfig(
      {
        listen: "127.0.0.1:0",
        db: ":memory:",
        auth: { providers: [{ id: "team", kind: "token", users: users.map((n) => ({ name: n, token_sha256: sha256(`${n}-token-secret`) })) }] },
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

  async person(name: string, repo: string, opts: { solo?: Credentials; shareSessions?: DaemonConfig["shareSessions"] } = {}): Promise<Person> {
    const dir = mkdtempSync(join(tmpdir(), `mesh-world-${name}-`));
    this.dirs.push(dir);
    const repoDir = join(dir, repo);
    mkdirSync(repoDir);
    execFileSync("git", ["init", "-q"], { cwd: repoDir });
    const res = await fetch(`${this.hub.url}/auth/team/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ token: `${name}-token-secret`, hostname: `${name}-laptop` }) });
    const login = (await res.json()) as LoginResult;
    const credentialsPath = join(dir, "credentials.json");
    if (!opts.solo) writeFileSync(credentialsPath, JSON.stringify({ hub: this.hub.url, token: login.token, user: login.user, machine: login.machine }));
    const store = await DaemonStore.open(":memory:");
    const p: Person = { name, login, store, pastes: [], notes: [], agents: null, repoDir, repo, daemon: undefined as unknown as Daemon, offline: false, credentialsPath };
    const config: DaemonConfig = { port: 0, key: "k".repeat(32), notify: true, workspaceRoots: [], autopilot: "nudge", shareSessions: opts.shareSessions ?? "steps" };
    p.daemon = new Daemon({
      config,
      store,
      credentialsPath,
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
        repoForCwd: () => ({ id: `gitlab.lab/vpc/${repo}`, name: repo }),
        mtime: () => undefined,
        log: (l) => process.env.WORLD_LOG && console.log(`[${name}] ${l}`),
        hubTimeoutMs: 500,
        fetch: (async (url: string | URL | Request, init?: RequestInit) => {
          if (p.offline) throw new TypeError("fetch failed (simulated network loss)");
          return fetch(url, init);
        }) as typeof fetch,
      }),
      intervals: { reconcileMs: 0, transcriptMs: 0, tickMs: 0, deliveryMs: 0 },
    });
    await p.daemon.start(0);
    this.people[name] = p;
    return p;
  }

  async stop(): Promise<void> {
    for (const p of Object.values(this.people)) {
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
    for (const p of Object.values(this.people)) await p.daemon.link?.flush();
  }

  async api(p: Person, method: "GET" | "POST", path: string, body?: unknown): Promise<{ status: number; json: Json }> {
    const r = await fetch(this.hub.url + path, {
      method,
      headers: { "content-type": "application/json", authorization: `Bearer ${p.login.token}` },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    return { status: r.status, json: await r.json() };
  }
}
