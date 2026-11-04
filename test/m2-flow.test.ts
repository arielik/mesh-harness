// M2 end to end, in process: a hub, two people's daemons, simulated Claude sessions (hooks),
// MCP tools (directly and through the stdio shim's server), autopilot, messages and questions.

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { sha256 } from "../src/auth/index.ts";
import { Daemon, defaultDeps } from "../src/daemon/index.ts";
import { buildHubConfig, startHub, type RunningHub } from "../src/hub/index.ts";
import { buildServer, forward } from "../src/mcp/index.ts";
import type { AgentEntry, DaemonConfig, HookInput, LoginResult, Session } from "../src/protocol/index.ts";
import { DaemonStore, HubStore } from "../src/store/index.ts";

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- JSON responses in assertions
type Json = any;

const dirs: string[] = [];
let hub: RunningHub;
let clock = 2_000_000_000;

interface Person {
  name: string;
  login: LoginResult;
  daemon: Daemon;
  store: DaemonStore;
  pastes: { pane: string; text: string }[];
  notes: string[];
  agents: AgentEntry[] | null;
  dir: string;
  configPath: string;
}
let people = {} as { alice: Person; bob: Person };

async function person(name: string, repo: string): Promise<Person> {
  const dir = mkdtempSync(join(tmpdir(), `mesh-m2-${name}-`));
  dirs.push(dir);
  const res = await fetch(`${hub.url}/auth/team/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ token: `${name}-token-secret`, hostname: `${name}-laptop` }) });
  const login = (await res.json()) as LoginResult;
  const credentialsPath = join(dir, "credentials.json");
  writeFileSync(credentialsPath, JSON.stringify({ hub: hub.url, token: login.token, user: login.user, machine: login.machine }));
  const store = await DaemonStore.open(":memory:");
  const p: Person = { name, login, store, pastes: [], notes: [], agents: null, dir, configPath: join(dir, "daemon.json"), daemon: undefined as unknown as Daemon };
  const config: DaemonConfig = { port: 0, key: "k".repeat(32), notify: true, workspaceRoots: [], autopilot: "nudge" };
  p.daemon = new Daemon({
    config,
    store,
    credentialsPath,
    deps: defaultDeps({
      listAgents: async () => p.agents,
      paste: async (pane, text) => {
        p.pastes.push({ pane, text });
        return true;
      },
      wakeBackground: async () => ({ ok: true }),
      notify: async (t, b) => p.notes.push(`${t}: ${b}`),
      now: () => clock,
      repoForCwd: () => ({ id: `gitlab.lab/vpc/${repo}`, name: repo }),
      mtime: () => undefined,
      log: () => undefined,
    }),
    intervals: { reconcileMs: 0, transcriptMs: 0, tickMs: 0, deliveryMs: 0 },
  });
  await p.daemon.start(0);
  writeFileSync(p.configPath, JSON.stringify({ ...config, port: p.daemon.port }));
  return p;
}

beforeEach(async () => {
  clock = 2_000_000_000;
  const config = buildHubConfig(
    {
      listen: "127.0.0.1:0",
      db: ":memory:",
      auth: {
        providers: [{ id: "team", kind: "token", users: ["alice", "bob"].map((n) => ({ name: n, token_sha256: sha256(`${n}-token-secret`) })) }],
      },
    },
    { baseDir: "/", env: {} },
  );
  hub = await startHub(config, { store: await HubStore.open(":memory:"), tickMs: 0, now: () => clock });
  people = { alice: await person("alice", "frr-dplane-ovs"), bob: await person("bob", "vpc-node-agent") };
});

afterEach(async () => {
  for (const p of Object.values(people)) {
    await p.daemon.stop();
    p.store.close();
  }
  await hub.stop();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const base = (sid: string, cwd: string): HookInput => ({ session_id: sid, cwd, hook_event_name: "", transcript_path: `/t/${sid}.jsonl` });
function hook(p: Person, kind: "SessionStart" | "UserPromptSubmit" | "Stop" | "SessionEnd", pid: number, extra: Partial<HookInput> = {}, headers: Record<string, string> = {}) {
  return p.daemon.handleHook(kind, { ...base(`claude-${pid}`, `/w/${p.name}`), hook_event_name: kind, ...extra }, { claudePid: String(pid), tmuxPane: `%${pid}`, ...headers });
}
const tool = (p: Person, pid: number, name: Parameters<Daemon["callTool"]>[0], args: Record<string, unknown> = {}) =>
  p.daemon.callTool(name, { pid, args, key: `${name}-${Math.random()}` });
const sessionOf = (p: Person, pid: number) => p.daemon.sessions.find((s) => s.pid === pid) as Session;
const flush = async () => {
  for (const p of Object.values(people)) await p.daemon.link?.flush();
};

async function hubPost(token: string, path: string, body: unknown) {
  const r = await fetch(hub.url + path, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${token}` }, body: JSON.stringify(body) });
  return { status: r.status, json: (await r.json()) as Record<string, unknown> };
}

async function goal(owner: Person) {
  const g = await hubPost(owner.login.token, "/v1/goals", { title: "IPv6 underlay", primaryRepo: "frr-dplane-ovs" });
  await hubPost(owner.login.token, `/v1/goals/${g.json.id}/plan`, {
    approve: true,
    steps: [
      { id: "proto", repo: "frr-dplane-ovs", kind: "implement", title: "proto", brief: "add v6 fields" },
      { id: "dplane", repo: "frr-dplane-ovs", kind: "implement", title: "dplane", brief: "program v6", deps: ["proto"] },
      { id: "agent", repo: "vpc-node-agent", kind: "implement", title: "agent", brief: "use v6 fields", deps: ["proto"] },
    ],
  });
  return g.json.id as string;
}

describe("M2: claims, notes, done and chaining through MCP tools", () => {
  it("runs a goal across two people with chain autopilot", async () => {
    const { alice, bob } = people;
    const G = await goal(alice);
    hook(alice, "SessionStart", 100, { source: "startup" });
    hook(bob, "SessionStart", 200, { source: "startup" });

    // No step yet: context lists what is ready for this repo.
    const ctx0 = await tool(alice, 100, "mesh_context");
    expect(ctx0.text).toContain(`${G}.proto`);
    expect((await tool(bob, 200, "mesh_next")).text).toBe("No ready steps.");

    const claim = await tool(alice, 100, "mesh_claim", { step: `${G}.proto` });
    expect(claim.isError).toBeUndefined();
    expect(claim.text).toContain(`You hold mesh step ${G}.proto`);
    expect(sessionOf(alice, 100).step).toBe(`${G}.proto`);
    await alice.daemon.setAutopilot(sessionOf(alice, 100).sid, "chain");

    expect((await tool(alice, 100, "mesh_note", { text: "fields added, need review" })).text).toBe("Noted.");
    hook(alice, "UserPromptSubmit", 100, { prompt: "go" });
    const done = await tool(alice, 100, "mesh_done", { summary: "added the fields", mr: "!41" });
    expect(done.text).toContain(`Autopilot claimed your next step: ${G}.dplane`);
    expect(sessionOf(alice, 100).step).toBe(`${G}.dplane`);
    // The brief arrives when the turn ends (Stop hook).
    const reply = hook(alice, "Stop", 100, { stop_hook_active: false, last_assistant_message: "done" });
    expect(JSON.stringify(reply)).toContain(`your next step is ${G}.dplane`);

    // Bob's lane opened in parallel.
    const next = await tool(bob, 200, "mesh_next");
    expect(next.text).toContain(`${G}.agent`);
    await tool(bob, 200, "mesh_claim", { step: `${G}.agent` });
    const ctx = await tool(bob, 200, "mesh_context");
    expect(ctx.text).toContain("added the fields");
    expect(ctx.text).toContain("!41");

    // The hub sees both sessions with their steps.
    await flush();
    const live: Json = await (await fetch(`${hub.url}/v1/live`, { headers: { authorization: `Bearer ${alice.login.token}` } })).json();
    const steps = live.people.flatMap((x: { sessions: { step?: string }[] }) => x.sessions.map((s) => s.step)).sort();
    expect(steps).toEqual([`${G}.agent`, `${G}.dplane`]);
  });

  it("fails a test step with reopen, and the previous holder hears about it", async () => {
    const { alice, bob } = people;
    const G = await goal(alice);
    hook(alice, "SessionStart", 100);
    hook(bob, "SessionStart", 200);
    await tool(alice, 100, "mesh_claim", { step: `${G}.proto` });
    await tool(alice, 100, "mesh_done", { summary: "proto ok" });
    await flush();
    await tool(bob, 200, "mesh_claim", { step: `${G}.agent` });
    const r = await tool(bob, 200, "mesh_done", { summary: "proto field has the wrong type", outcome: "fail", reopen: ["proto"] });
    expect(r.text).toContain(`Reopened for fixing: ${G}.proto`);
    await alice.daemon.link?.pullInbox();
    const pending = alice.store.pendingMessages();
    expect(pending.map((m) => m.text).join("\n")).toContain(`step ${G}.proto was reopened`);
  });

  it("returns plan validation errors to a design session, then proposes", async () => {
    const { alice } = people;
    const g = await hubPost(alice.login.token, "/v1/goals", { title: "x" });
    hook(alice, "SessionStart", 100);
    await tool(alice, 100, "mesh_claim", { step: `${g.json.id}.design` });
    const bad = await tool(alice, 100, "mesh_plan", { goal: g.json.id, steps: [{ id: "a", repo: "r", kind: "implement", title: "a", brief: "b", deps: ["nope"] }] });
    expect(bad.isError).toBe(true);
    expect(bad.text).toContain('dep "nope" not found');
    const good = await tool(alice, 100, "mesh_plan", { goal: g.json.id, design_ref: "r@d:doc.md", steps: [{ id: "a", repo: "r", kind: "implement", title: "a", brief: "b" }] });
    expect(good.text).toContain("Plan v1");
    expect(good.text).toContain("waits for approval");
  });
});

describe("M2: messages, questions, autopilot", () => {
  it("delivers a hub message from one person to another's session and acks it", async () => {
    const { alice, bob } = people;
    const G = await goal(alice);
    hook(alice, "SessionStart", 100);
    await tool(alice, 100, "mesh_claim", { step: `${G}.proto` });
    await flush();
    const said = await hubPost(bob.login.token, "/v1/messages", { toStep: `${G}.proto`, text: "please also bump the version" });
    expect(said.status).toBe(201);
    await alice.daemon.link?.pullInbox();
    hook(alice, "UserPromptSubmit", 100, { prompt: "work" });
    const reply = hook(alice, "Stop", 100, { stop_hook_active: false, last_assistant_message: "ok" });
    expect(JSON.stringify(reply)).toContain("please also bump the version");
    await new Promise((r) => setTimeout(r, 50));
    const inbox: Json = await (await fetch(`${hub.url}/v1/inbox`, { headers: { authorization: `Bearer ${alice.login.token}` } })).json();
    expect(inbox.messages).toEqual([]);
  });

  it("mesh_ask turns the end of the turn into needs-you; the answer comes back as a message", async () => {
    const { alice } = people;
    const G = await goal(alice);
    hook(alice, "SessionStart", 100);
    await tool(alice, 100, "mesh_claim", { step: `${G}.proto` });
    hook(alice, "UserPromptSubmit", 100, { prompt: "go" });
    expect((await tool(alice, 100, "mesh_ask", { question: "keep v4 fallback on?" })).text).toContain("End your turn");
    hook(alice, "Stop", 100, { stop_hook_active: false, last_assistant_message: "I asked my person." });
    expect(sessionOf(alice, 100)).toMatchObject({ state: "needs_you", needs: "question" });
    await flush();
    const att: Json = await (await fetch(`${hub.url}/v1/attention`, { headers: { authorization: `Bearer ${alice.login.token}` } })).json();
    const q = att.attention.find((x: { kind: string }) => x.kind === "question");
    expect(q.text).toContain("keep v4 fallback on?");
    await hubPost(alice.login.token, `/v1/questions/${q.question}/answer`, { text: "yes, keep it" });
    await alice.daemon.link?.pullInbox();
    expect(alice.store.pendingMessages().map((m) => m.text).join()).toContain("yes, keep it");
  });

  it("nudges a stalled session twice, then escalates once", async () => {
    const { alice } = people;
    const G = await goal(alice);
    hook(alice, "SessionStart", 100);
    await tool(alice, 100, "mesh_claim", { step: `${G}.proto` });
    hook(alice, "UserPromptSubmit", 100, { prompt: "go" });
    hook(alice, "Stop", 100, { stop_hook_active: false, last_assistant_message: "Next I'll update the tests." });
    for (let n = 1; n <= 2; n++) {
      clock += 6 * 60_000;
      alice.daemon.tick();
      expect(sessionOf(alice, 100).nudges).toBe(n);
      // Claude reports the prompt free: the daemon types the nudge into the pane.
      alice.agents = [{ kind: "interactive", pid: 100, sessionId: "claude-100", cwd: "/w/alice", status: "idle" }];
      await alice.daemon.reconcile();
      const typed = alice.pastes.at(-1);
      expect(typed?.text).toContain(`continue with step ${G}.proto`);
      hook(alice, "UserPromptSubmit", 100, { prompt: typed?.text as string });
      hook(alice, "Stop", 100, { stop_hook_active: false, last_assistant_message: "Still going." });
    }
    clock += 6 * 60_000;
    alice.daemon.tick();
    expect(sessionOf(alice, 100).escalated).toBe(true);
    expect(alice.notes.at(-1)).toContain("stalled");
    clock += 6 * 60_000;
    alice.daemon.tick();
    expect(alice.notes.filter((n) => n.includes("stalled"))).toHaveLength(1);
  });

  it("binds a session started by `mesh run --step` (X-Mesh-Step) to the claimed step", async () => {
    const { alice } = people;
    const G = await goal(alice);
    await hubPost(alice.login.token, `/v1/steps/${G}.proto/claim`, {});
    hook(alice, "SessionStart", 300, { source: "startup" }, {});
    alice.daemon.handleHook("SessionStart", { ...base("claude-301", "/w/alice"), hook_event_name: "SessionStart" }, { claudePid: "301", step: `${G}.proto`, autopilot: "chain" });
    for (let i = 0; i < 40 && !sessionOf(alice, 301)?.step; i++) await new Promise((r) => setTimeout(r, 25));
    expect(sessionOf(alice, 301)).toMatchObject({ step: `${G}.proto`, autopilot: "chain" });
  });
});

describe("M2: the MCP shim", () => {
  it("exposes the eight tools and forwards calls with the Claude pid", async () => {
    const { alice } = people;
    await goal(alice);
    hook(alice, "SessionStart", 4242);
    const server = buildServer({ daemonConfigPath: alice.configPath, claudePid: 4242, version: "test" });
    const [a, b] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "test", version: "1" });
    await Promise.all([server.connect(a), client.connect(b)]);
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(["mesh_ask", "mesh_claim", "mesh_context", "mesh_done", "mesh_next", "mesh_note", "mesh_plan", "mesh_release"]);
    const r = (await client.callTool({ name: "mesh_context", arguments: {} })) as { content: { text: string }[] };
    expect(r.content[0]?.text).toContain(".proto");
    await client.close();
  });

  it("explains an unknown session and a missing daemon", async () => {
    const { alice } = people;
    expect((await forward({ daemonConfigPath: alice.configPath, claudePid: 9999, version: "t" }, "mesh_context", {})).text).toContain("doesn't know this Claude session");
    expect((await forward({ daemonConfigPath: join(alice.dir, "missing.json"), claudePid: 1, version: "t" }, "mesh_context", {})).text).toContain("not set up");
  });
});
