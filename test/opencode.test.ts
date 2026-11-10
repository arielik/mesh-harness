// OpenCode end to end, in process: the recorded OpenCode 2.2.4 events (test/fixtures/opencode)
// replayed through the real generated plugin into a real daemon over HTTP.

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Daemon, defaultDeps } from "../src/daemon/index.ts";
import { buildServer, OPENCODE_SESSION_META } from "../src/mcp/index.ts";
import { pluginSource } from "../src/opencode/index.ts";
import type { DaemonConfig, OpenCodeEvent, Session } from "../src/protocol/index.ts";
import { DaemonStore } from "../src/store/index.ts";

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- raw OpenCode events
type Json = any;

const FIX = join(import.meta.dirname, "fixtures", "opencode", "events", "session.jsonl");
const events = (): Json[] =>
  readFileSync(FIX, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l));

const KEY = "k".repeat(32);
let dir: string;
let daemon: Daemon;
let now: number;
let alive: Set<number>;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "mesh-oc-"));
  now = 1_800_000_000_000;
  alive = new Set([process.pid]);
  const store = await DaemonStore.open(":memory:");
  const config: DaemonConfig = { port: 0, key: KEY, notify: false, workspaceRoots: [], autopilot: "nudge" };
  let ids = 0;
  const deps = defaultDeps({
    listAgents: async () => [],
    paste: async () => true,
    wakeBackground: async () => ({ ok: true }),
    notify: async () => undefined,
    now: () => now,
    newId: () => `sid-${++ids}`,
    repoForCwd: () => undefined,
    mtime: () => undefined,
    log: () => undefined,
    harness: () => undefined,
    claudeVersion: async () => undefined,
    scanRuns: () => [],
    alive: (pid) => alive.has(pid),
  });
  daemon = new Daemon({ config, store, deps, intervals: { reconcileMs: 0, transcriptMs: 0, tickMs: 0, deliveryMs: 0 } });
  await daemon.start(0);
  writeFileSync(join(dir, "daemon.json"), JSON.stringify({ ...config, port: daemon.port }));
});

afterEach(async () => {
  await daemon.stop();
  rmSync(dir, { recursive: true, force: true });
});

interface Harness {
  /** What the daemon saw, with the session's state after each event. */
  seen: { type: string; child?: boolean; state?: string; needs?: string }[];
  mcp: Map<string, unknown>;
  prompts: Json[];
  push(e: Json): void;
  end(): void;
  /** Wait until the daemon has handled `n` events. */
  handled(n: number): Promise<void>;
}

/** Load the generated plugin as OpenCode would, with a fake plugin context. */
async function loadPlugin(opts: { standalone: boolean; env?: Record<string, string> }): Promise<Harness> {
  const file = join(dir, `mesh-harness-${Math.random().toString(36).slice(2)}.js`);
  writeFileSync(file, pluginSource({ daemonConfigPath: join(dir, "daemon.json"), mcpCommand: ["mesh", "mcp"] }));
  const seen: Harness["seen"] = [];
  const handle = daemon.handleOpenCodeEvent.bind(daemon);
  daemon.handleOpenCodeEvent = (e: OpenCodeEvent) => {
    const r = handle(e);
    const s = daemon.sessions.find((x) => x.claudeSessionIds.includes(e.sessionID ?? "-"));
    seen.push({ type: e.type, ...(e.child ? { child: true } : {}), ...(s ? { state: s.state } : {}), ...(s?.needs ? { needs: s.needs } : {}) });
    return r;
  };
  // The stream the plugin subscribes to.
  const queue: Json[] = [];
  let wake: (() => void) | undefined;
  let done = false;
  const stream = {
    async *[Symbol.asyncIterator]() {
      for (;;) {
        if (queue.length) yield queue.shift();
        else if (done) return;
        else await new Promise<void>((r) => (wake = r));
      }
    },
  };
  const servers = new Map<string, unknown>();
  const prompts: Json[] = [];
  const ctx = {
    location: { directory: "/work/repo" },
    event: { subscribe: () => stream },
    mcp: {
      transform: async (fn: (d: Json) => void) =>
        fn({ get: (n: string) => servers.get(n), set: (n: string, v: unknown) => servers.set(n, v) }),
    },
    session: { prompt: async (p: Json) => void prompts.push(p) },
  };
  const savedArgv = process.argv;
  const savedEnv = { ...process.env };
  process.argv = opts.standalone ? ["bun", "/$bunfs/root/opencode", "serve", "--stdio", "--port", "0"] : ["bun", "/$bunfs/root/opencode", "serve", "--service"];
  for (const k of ["TMUX_PANE", "TMUX", "MESH_STEP", "MESH_AUTOPILOT"]) delete process.env[k];
  Object.assign(process.env, opts.env ?? {});
  try {
    const mod = await import(pathToFileURL(file).href);
    await mod.default.setup(ctx);
  } finally {
    process.argv = savedArgv;
    process.env = savedEnv;
  }
  return {
    seen,
    mcp: servers,
    prompts,
    push: (e) => {
      queue.push(e);
      wake?.();
    },
    end: () => {
      done = true;
      wake?.();
    },
    handled: async (n) => {
      for (let i = 0; i < 300 && seen.length < n; i++) await new Promise((r) => setTimeout(r, 10));
      expect(seen.length).toBeGreaterThanOrEqual(n);
    },
  };
}

const live = (): Session[] => daemon.sessions.filter((s) => s.state !== "ended");

describe("OpenCode plugin → daemon (recorded OpenCode 2.2.4 session)", () => {
  it("tracks the session through tool use, a question, a subagent, permissions and exit", async () => {
    const h = await loadPlugin({ standalone: true, env: { TMUX_PANE: "%5", TMUX: "/tmp/tmux-1/default,99,0" } });
    expect(h.mcp.get("mesh")).toEqual({ type: "local", command: ["mesh", "mcp"] });
    const all = events();
    for (const e of all) h.push(e);
    await h.handled(10);

    // One mesh session: the subagent folds into its root.
    expect(daemon.sessions).toHaveLength(1);
    const types = h.seen.map((x) => `${x.type}${x.child ? " (child)" : ""} → ${x.state ?? "-"}${x.needs ? `/${x.needs}` : ""}`);
    expect(types).toEqual([
      "session.created → idle",
      "session.execution.started → working",
      "form.created → needs_you/question",
      "form.replied → working",
      "permission.asked (child) → needs_you/permission",
      "permission.replied (child) → working",
      "permission.asked → needs_you/permission",
      "permission.replied → working",
      "session.execution.succeeded → idle",
      "location.shutdown → -",
    ]);
    const [s] = daemon.sessions as [Session];
    expect(s).toMatchObject({ agent: "opencode", pane: "%5", tmuxSocket: "/tmp/tmux-1/default", lastMessage: "done: fixture recorded", turns: 1, humanPrompts: 1, pluginVersion: 1, endedReason: "opencode exited" });
    expect(s.model).toMatch(/^anthropic\//);
    // No prompt text reaches mesh: only its length.
    const prompt = all.find((e) => e.type === "session.inbox.enqueued").data.item.payload.text as string;
    expect(JSON.stringify(daemon.store.hookEvents(s.sid))).not.toContain(prompt.slice(0, 30));
    expect(daemon.store.hookEvents(s.sid).some((e) => (e as Json).promptLength === prompt.length)).toBe(true);
    h.end();
  });

  it("a shared server reports sessions without a pane and keeps them apart", async () => {
    const h = await loadPlugin({ standalone: false, env: { TMUX_PANE: "%9", MESH_STEP: "G1.api" } });
    const base = { location: { directory: "/work/repo" } };
    h.push({ ...base, type: "session.created", created: now, data: { sessionID: "ses_a" } });
    h.push({ ...base, type: "session.created", created: now, data: { sessionID: "ses_b" } });
    h.push({ ...base, type: "session.execution.started", created: now, data: { sessionID: "ses_b" } });
    await h.handled(3);
    const [a, b] = live() as [Session, Session];
    expect(live()).toHaveLength(2);
    expect(a).toMatchObject({ agent: "opencode", state: "idle" });
    expect(b).toMatchObject({ agent: "opencode", state: "working" });
    // The service's environment is not a terminal's: no pane, no step.
    expect(a.pane).toBeUndefined();
    expect(a.step).toBeUndefined();
    h.end();
  });

  it("delivers a mesh message through the plugin as a queued prompt", async () => {
    const h = await loadPlugin({ standalone: true, env: { TMUX_PANE: "%5" } });
    h.push({ type: "session.created", created: now, location: { directory: "/work/repo" }, data: { sessionID: "ses_m" } });
    await h.handled(1);
    const [s] = live() as [Session];
    daemon.say(s.sid, "please also run the tests");
    // The next event's reply carries it.
    h.push({ type: "session.execution.started", created: now, location: { directory: "/work/repo" }, data: { sessionID: "ses_m" } });
    await h.handled(2);
    for (let i = 0; i < 100 && h.prompts.length === 0; i++) await new Promise((r) => setTimeout(r, 10));
    expect(h.prompts).toEqual([{ sessionID: "ses_m", text: "please also run the tests", delivery: "queue" }]);
    expect(daemon.store.recentMessages(0)[0]).toMatchObject({ state: "delivered", method: "opencode" });
    // The turn mesh's message starts is not counted as the person's.
    h.push({ type: "session.execution.succeeded", created: now, location: { directory: "/work/repo" }, data: { sessionID: "ses_m" } });
    h.push({ type: "session.execution.started", created: now, location: { directory: "/work/repo" }, data: { sessionID: "ses_m" } });
    await h.handled(4);
    expect(live()[0]).toMatchObject({ turns: 2, humanPrompts: 1 });
    h.end();
  });

  it("ends sessions whose server died without a shutdown event", async () => {
    const h = await loadPlugin({ standalone: true });
    h.push({ type: "session.created", created: now, location: { directory: "/work/repo" }, data: { sessionID: "ses_x" } });
    await h.handled(1);
    expect(live()).toHaveLength(1);
    alive.delete(process.pid);
    daemon.tick();
    expect(live()).toHaveLength(0);
    expect(daemon.sessions[0]).toMatchObject({ state: "ended", endedReason: "process exited" });
    h.end();
  });
});

describe("mesh tools from OpenCode", () => {
  it("finds the session by the OpenCode session id the MCP call carries", async () => {
    const h = await loadPlugin({ standalone: false });
    h.push({ type: "session.created", created: now, location: { directory: "/work/repo" }, data: { sessionID: "ses_t" } });
    await h.handled(1);
    // No hub configured: the tool reaches the session, then says so.
    await expect(daemon.callTool("mesh_context", { pid: process.pid, args: {}, key: "k".repeat(8), agentSessionId: "ses_t" })).rejects.toThrow(/no hub configured/);
    // An unknown id, and a pid lookup that must not pick an OpenCode session (a shared server's pid).
    expect(await daemon.callTool("mesh_context", { pid: process.pid, args: {}, key: "k".repeat(8), agentSessionId: "ses_zz" })).toMatchObject({ isError: true, text: expect.stringContaining("OpenCode") });
    expect(await daemon.callTool("mesh_context", { pid: process.pid, args: {}, key: "k".repeat(8) })).toMatchObject({ isError: true });
    h.end();
  });
});

describe("mesh mcp shim under OpenCode", () => {
  it("forwards the session id OpenCode puts in each call's _meta", async () => {
    const h = await loadPlugin({ standalone: false });
    h.push({ type: "session.created", created: now, location: { directory: "/work/repo" }, data: { sessionID: "ses_mcp" } });
    await h.handled(1);
    const calls: Json[] = [];
    const callTool = daemon.callTool.bind(daemon);
    daemon.callTool = async (tool, call) => {
      calls.push(call);
      return callTool(tool, call).catch((e: Error) => ({ text: e.message, isError: true }));
    };
    // One shim per OpenCode server: its parent pid is the server, not a session.
    const server = buildServer({ daemonConfigPath: join(dir, "daemon.json"), claudePid: 1, version: "test" });
    const [a, b] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "opencode", version: "2.2.4" });
    await Promise.all([server.connect(a), client.connect(b)]);
    const r = (await client.callTool({ name: "mesh_context", arguments: {}, _meta: { [OPENCODE_SESSION_META]: "ses_mcp", progressToken: 2 } })) as { content: { text: string }[] };
    expect(calls[0]).toMatchObject({ pid: 1, agentSessionId: "ses_mcp" });
    // The session was found; this daemon has no hub, so the tool says so.
    expect(r.content[0]?.text).toMatch(/no hub configured/);
    await client.close();
    h.end();
  });
});

describe("OpenCode with a hub", () => {
  it("a `mesh run --agent opencode --step` window binds its step to the OpenCode session, and mesh_done works over MCP ids", async () => {
    const { World } = await import("./helpers/world.ts");
    const w = new World();
    await w.start(["alice"]);
    try {
      const alice = await w.person("alice", "repo");
      const g = await w.api(alice, "POST", "/v1/goals", { title: "Hello", primaryRepo: "repo" });
      const G = g.json.id as string;
      // `mesh run` claims the design step without a session, then opens the window.
      expect((await w.api(alice, "POST", `/v1/steps/${G}.design/claim`, {})).status).toBe(200);
      await alice.daemon.launch({ pane: "%2", cwd: alice.repoDir, name: `repo·${G}.design`, step: `${G}.design`, agent: "opencode" });
      // OpenCode's first event from that window adopts the placeholder…
      alice.daemon.handleOpenCodeEvent({ v: 1, type: "session.created", sessionID: "ses_d", pid: 77, standalone: true, pane: "%2", cwd: alice.repoDir, step: `${G}.design` });
      const s = alice.daemon.sessions.find((x) => x.claudeSessionIds.includes("ses_d")) as Session;
      expect(alice.daemon.sessions.filter((x) => x.state !== "ended")).toHaveLength(1);
      expect(s).toMatchObject({ agent: "opencode", step: `${G}.design` });
      // …and binds the step to it at the hub, so plan messages reach this session.
      for (let i = 0; i < 50; i++) {
        const st = (await w.api(alice, "GET", `/v1/steps/${G}.design`)).json.context.step;
        if (st.holderSid === s.sid) break;
        await new Promise((r) => setTimeout(r, 20));
      }
      expect((await w.api(alice, "GET", `/v1/steps/${G}.design`)).json.context.step).toMatchObject({ holderSid: s.sid, holderUser: "alice" });
      // The step tools find the session by its OpenCode id.
      const ctx = await alice.daemon.callTool("mesh_context", { pid: 77, args: {}, key: "ctx-1", agentSessionId: "ses_d" });
      expect(ctx.isError).toBeUndefined();
      expect(ctx.text).toContain(`${G}.design`);
    } finally {
      await w.stop();
    }
  });
});
