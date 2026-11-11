// MM-1 on a whole daemon with a fake hub behind its fetch: the repo inventory (AC-16 rescan
// interval, AC-30 nothing under `steps`) and GET /local/fleet (AC-21).

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fakeCheckout } from "../../test/helpers/git-tree.ts";
import type { DaemonConfig, FleetView } from "../protocol/index.ts";
import { DaemonStore } from "../store/index.ts";
import { Daemon, defaultDeps } from "./daemon.ts";
import { repoForCwd } from "./git.ts";

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- HTTP JSON bodies in assertions
type Json = any;

// Count the scans: the real scan, wrapped.
const scans = vi.hoisted(() => ({ count: 0 }));
vi.mock("./repos.ts", async (importOriginal) => {
  const real = (await importOriginal()) as { scanRepos(roots: readonly string[]): unknown };
  return {
    ...real,
    scanRepos: (roots: readonly string[]) => {
      scans.count++;
      return real.scanRepos(roots);
    },
  };
});

const KEY = "k".repeat(32);
const BETA_CWD = "/elsewhere/work/beta";
const cleanups: (() => unknown)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});
beforeEach(() => {
  scans.count = 0;
});

const tmp = (prefix: string) => {
  const d = mkdtempSync(join(tmpdir(), prefix));
  cleanups.push(() => rmSync(d, { recursive: true, force: true }));
  return d;
};

const FLEET: FleetView = {
  now: 5_000_000,
  user: { id: "bob", name: "bob", roles: ["member"] },
  machines: [
    {
      id: "m-0000000a",
      hostname: "bob-desk",
      nickname: "desk",
      online: true,
      lastSeen: 5_000_000,
      counts: { idle: 1 },
      share: "me",
      repos: [{ id: "example.org/team/alpha", name: "alpha" }],
      reposAt: 4_000_000,
      current: true,
      sessions: [{ sid: "s1", machine: "m-0000000a", user: "bob", state: "idle", lastEventAt: 4_900_000 }],
    },
  ],
};

interface Boot {
  daemon: Daemon;
  syncs: Json[];
  requests: { method: string; path: string; auth: string | null }[];
  advance(ms: number): void;
  http(method: string, path: string): Promise<{ status: number; json: Json }>;
}

async function boot(opts: { share: DaemonConfig["shareSessions"]; roots?: string[]; loggedIn?: boolean; shareReply?: string }): Promise<Boot> {
  const dir = tmp("mesh-inv-");
  const credentialsPath = join(dir, "credentials.json");
  if (opts.loggedIn !== false) {
    writeFileSync(credentialsPath, JSON.stringify({ hub: "http://hub-a.test", token: "device-token-1", user: { id: "bob", name: "bob", roles: ["member"] }, machine: "m-0000000a" }));
  }
  let now = 5_000_000;
  const syncs: Json[] = [];
  const requests: Boot["requests"] = [];
  const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  const store = await DaemonStore.open(":memory:");
  const config: DaemonConfig = { port: 0, key: KEY, notify: false, workspaceRoots: opts.roots ?? [], autopilot: "nudge", shareSessions: opts.share };
  const daemon = new Daemon({
    config,
    store,
    credentialsPath,
    version: "test",
    deps: defaultDeps({
      harness: () => ({ hash: "h0", parts: { repo: "r0", user: "u0", plugins: "none", mesh: "test" } }),
      claudeVersion: async () => "2.1.318",
      scanRuns: () => [],
      listAgents: async () => [],
      paste: async () => true,
      wakeBackground: async () => ({ ok: true }),
      notify: async () => undefined,
      now: () => now,
      repoForCwd: (cwd) => (cwd === BETA_CWD ? { id: "example.org/team/beta", name: "beta" } : repoForCwd(cwd)),
      mtime: () => undefined,
      log: () => undefined,
      fetch: (async (url: string | URL | Request, init?: RequestInit) => {
        const u = new URL(String(url));
        const headers = new Headers(init?.headers);
        requests.push({ method: init?.method ?? "GET", path: u.pathname, auth: headers.get("authorization") });
        if (u.pathname === "/v1/sync" && init?.method === "POST") {
          syncs.push(JSON.parse(String(init.body)));
          return json(200, { accepted: 0, share: opts.shareReply ?? opts.share });
        }
        if (u.pathname === "/v1/fleet") return json(200, FLEET);
        if (u.pathname === "/health") return json(200, { ok: true });
        if (u.pathname === "/v1/inbox") return json(200, { messages: [] });
        return json(200, {});
      }) as typeof fetch,
    }),
    intervals: { reconcileMs: 0, transcriptMs: 0, tickMs: 0, deliveryMs: 0 },
  });
  await daemon.start(0);
  cleanups.push(async () => {
    await daemon.stop();
    store.close();
  });
  const http = (method: string, path: string): Promise<{ status: number; json: Json }> =>
    new Promise((resolve, reject) => {
      const req = request({ host: "127.0.0.1", port: daemon.port, method, path, headers: { "x-mesh-key": KEY } }, (res) => {
        let text = "";
        res.on("data", (c) => (text += c));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, json: text ? JSON.parse(text) : undefined }));
      });
      req.on("error", reject);
      req.end();
    });
  return { daemon, syncs, requests, advance: (ms) => (now += ms), http };
}

/** A session without a step in repo beta, outside the workspace roots. */
async function betaSession(d: Daemon): Promise<void> {
  await d.handleHook("SessionStart", { session_id: "c-beta", cwd: BETA_CWD, hook_event_name: "SessionStart", transcript_path: "/t/beta.jsonl" }, { claudePid: "7101", tmuxPane: "%71" });
}

describe("AC-16 the daemon rescans at most once per REPO_SCAN_MS", () => {
  it("test_AC16_REPO_SCAN_MS", async () => {
    const { REPO_SCAN_MS } = await import("./repos.ts");
    expect(REPO_SCAN_MS).toBe(300_000);
  });

  it("test_AC16_no_rescan_within_interval_then_change_resent", async () => {
    const { REPO_SCAN_MS } = await import("./repos.ts");
    const T = tmp("mesh-inv-tree-");
    fakeCheckout(join(T, "alpha"), "https://example.org/team/alpha.git");
    const b = await boot({ share: "me", roots: [T] });

    await b.daemon.link?.flush();
    const first = b.syncs.at(-1);
    expect(first.machine.repos).toEqual([{ id: "example.org/team/alpha", name: "alpha" }]);
    const scansAfterFirst = scans.count;
    expect(scansAfterFirst).toBeGreaterThan(0);

    await b.daemon.link?.flush();
    expect(b.syncs.at(-1).machine).not.toHaveProperty("repos");

    // A new checkout appears; within the interval the folders are not read again.
    fakeCheckout(join(T, "gamma"), "https://example.org/team/gamma.git");
    b.advance(REPO_SCAN_MS - 1);
    await b.daemon.link?.flush();
    await b.daemon.link?.flush();
    expect(scans.count).toBe(scansAfterFirst);
    for (const s of b.syncs.slice(-2)) expect(s.machine).not.toHaveProperty("repos");

    // Past the interval the next sync carries the new list.
    b.advance(2);
    await b.daemon.link?.flush();
    expect(scans.count).toBeGreaterThan(scansAfterFirst);
    expect(b.syncs.at(-1).machine.repos).toEqual([
      { id: "example.org/team/alpha", name: "alpha" },
      { id: "example.org/team/gamma", name: "gamma" },
    ]);
  });

  it("test_AC16_inventory_unites_scan_and_sessions", async () => {
    const T = tmp("mesh-inv-tree-");
    fakeCheckout(join(T, "alpha"), "https://example.org/team/alpha.git");
    const b = await boot({ share: "me", roots: [T] });
    await betaSession(b.daemon);
    await b.daemon.link?.flush();
    // The session start may already have synced; the newest inventory sent is the one that counts.
    expect(b.syncs.filter((x) => x.machine.repos).at(-1).machine.repos).toEqual([
      { id: "example.org/team/alpha", name: "alpha" },
      { id: "example.org/team/beta", name: "beta" },
    ]);
    expect(JSON.stringify(b.syncs.at(-1).machine)).not.toContain(T);
  });
});

describe("AC-30 `steps` sends no repo inventory", () => {
  async function stepsDaemon() {
    const T = tmp("mesh-inv-tree-");
    fakeCheckout(join(T, "alpha"), "https://example.org/team/alpha.git");
    const b = await boot({ share: "steps", roots: [T] });
    await betaSession(b.daemon);
    for (let i = 0; i < 3; i++) {
      await b.daemon.link?.flush();
      b.advance(400_000);
    }
    return b;
  }

  it("test_AC30_no_alpha_or_beta_in_any_body", async () => {
    const b = await stepsDaemon();
    expect(b.syncs.length).toBeGreaterThanOrEqual(3);
    for (const s of b.syncs) {
      // Positive control: these are MM-1 sync bodies (they carry the level).
      expect(s.machine?.share).toBe("steps");
      const text = JSON.stringify(s);
      expect(text).not.toContain("alpha");
      expect(text).not.toContain("beta");
    }
  });

  it("test_AC30_repos_sent_is_empty", async () => {
    const b = await stepsDaemon();
    expect(b.syncs[0].machine).toEqual({ share: "steps", repos: [] });
    for (const s of b.syncs) {
      expect(s.machine?.share).toBe("steps");
      if (s.machine && "repos" in s.machine) expect(s.machine.repos).toEqual([]);
    }
  });

  it("test_AC30_no_scan_under_steps", async () => {
    await stepsDaemon();
    expect(scans.count).toBe(0);
    // Positive control: the same tree under `me` is scanned.
    const T = tmp("mesh-inv-tree-");
    fakeCheckout(join(T, "alpha"), "https://example.org/team/alpha.git");
    const b = await boot({ share: "me", roots: [T] });
    await b.daemon.link?.flush();
    expect(scans.count).toBeGreaterThan(0);
    expect(JSON.stringify(b.syncs.at(-1))).toContain("alpha");
  });
});

describe("AC-21 GET /local/fleet", () => {
  it("test_AC21_local_fleet_proxies_hub", async () => {
    const b = await boot({ share: "me" });
    const r = await b.http("GET", "/local/fleet");
    expect(r.status).toBe(200);
    expect(r.json).toEqual(FLEET);
    const call = b.requests.find((x) => x.path === "/v1/fleet");
    expect(call).toMatchObject({ method: "GET", auth: "Bearer device-token-1" });
  });

  it("test_AC21_local_fleet_without_credentials_409", async () => {
    const b = await boot({ share: "me", loggedIn: false });
    const r = await b.http("GET", "/local/fleet");
    expect(r).toEqual({ status: 409, json: { error: "not logged in to a hub; run: mesh login" } });
    expect(b.requests.filter((x) => x.path === "/v1/fleet")).toEqual([]);
  });
});
