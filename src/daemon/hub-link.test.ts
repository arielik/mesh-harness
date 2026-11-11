// T1 (local-first design §5): the hub link against a blackholed hub fails fast after the first
// failure, probes in the background, and drains the outbox and queued calls once when it is back.

import { mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { Repo, Session, ShareLevel } from "../protocol/index.ts";
import { DaemonStore } from "../store/index.ts";
import { HubLink, HubRpcError, sessionMetadata, syncedSessions } from "./hub-link.ts";

const cleanups: (() => unknown)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});

async function blackhole(): Promise<{ port: number; server: Server }> {
  const sockets: Socket[] = [];
  const server = createServer((s) => void sockets.push(s));
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  cleanups.push(() => {
    for (const s of sockets) s.destroy();
    return new Promise((r) => server.close(() => r(undefined)));
  });
  return { port: (server.address() as { port: number }).port, server };
}

async function setup(hubUrl: string) {
  const dir = mkdtempSync(join(tmpdir(), "mesh-link-"));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  const credentialsPath = join(dir, "credentials.json");
  writeFileSync(credentialsPath, JSON.stringify({ hub: hubUrl, token: "t", user: { id: "alice", name: "alice", roles: ["member"] } }));
  const store = await DaemonStore.open(":memory:");
  cleanups.push(() => store.close());
  let now = 1_000_000;
  const calls: string[] = [];
  const replayed: string[] = [];
  const link = new HubLink({
    credentialsPath,
    store,
    sessions: () => [],
    onMessage: () => "queued",
    log: () => undefined,
    now: () => now,
    timeoutMs: 300,
    fetch: (async (url: string | URL | Request, init?: RequestInit) => {
      calls.push(`${init?.method ?? "GET"} ${String(url).replace(/^http:\/\/[^/]+/, "")}`);
      return fetch(url, init);
    }) as typeof fetch,
    onReplayed: (c) => replayed.push(c.label),
  });
  return { link, store, calls, replayed, credentialsPath, advance: (ms: number) => (now += ms) };
}

describe("hub link, offline", () => {
  it("fails fast after the first failure and recovers through the probe", async () => {
    const bh = await blackhole();
    const t = await setup(`http://127.0.0.1:${bh.port}`);

    const t0 = Date.now();
    await expect(t.link.rpc("GET", "/v1/me")).rejects.toMatchObject({ status: 503 });
    expect(Date.now() - t0).toBeGreaterThanOrEqual(250);
    expect(t.link.offline).toBe(true);
    expect(t.link.offlineSince).toBe(1_000_000);

    const t1 = Date.now();
    const err = await t.link.rpc("GET", "/v1/me").catch((e: unknown) => e);
    expect(Date.now() - t1).toBeLessThan(50);
    expect(err).toBeInstanceOf(HubRpcError);
    expect((err as HubRpcError).message).toMatch(/offline \(since/);

    // Work done while offline is kept: an event and a queued call.
    t.link.enqueue({ id: "11111111-1111-4111-8111-111111111111", at: 1, type: "session.turn_started", sid: "s1", step: "G1.a" });
    t.link.queue({ key: "k-done", at: 2, method: "POST", path: "/v1/steps/G1.a/note", body: { text: "offline note" }, label: "mesh_note G1.a" });
    expect(t.store.eventLogFor("G1.a")).toHaveLength(1);

    // A probe that is not due does not touch the network.
    const before = t.calls.length;
    await t.link.flush();
    expect(t.calls.length).toBe(before);

    // The hub comes back (here: a working endpoint), the probe gets through, everything is sent once.
    const got: { path: string; body: unknown; idem?: string | undefined }[] = [];
    const { createServer: http } = await import("node:http");
    const ok = http((req, res) => {
      let b = "";
      req.on("data", (c) => (b += c));
      req.on("end", () => {
        got.push({ path: req.url ?? "", body: b ? JSON.parse(b) : undefined, idem: req.headers["idempotency-key"] as string | undefined });
        res.writeHead(200, { "content-type": "application/json" });
        res.end(req.url === "/health" ? '{"ok":true}' : "{}");
      });
    });
    // Same address: the blackhole goes away and a working hub takes its port.
    await new Promise<void>((r) => {
      bh.server.close(() => r());
      for (const c of cleanups.splice(0, 1)) void c();
    });
    await new Promise<void>((r) => ok.listen(bh.port, "127.0.0.1", () => r()));
    cleanups.push(() => new Promise((r) => ok.close(() => r(undefined))));
    t.advance(6_000);
    await t.link.flush();
    expect(t.link.offline).toBe(false);
    expect(got.map((g) => g.path)).toEqual(["/health", "/v1/sync", "/v1/steps/G1.a/note"]);
    expect((got[1]?.body as { events: unknown[] }).events).toHaveLength(1);
    expect(got[2]?.idem).toBe("k-done");
    expect(t.replayed).toEqual(["mesh_note G1.a"]);
    expect(t.store.outboxSize()).toBe(0);
    expect(t.store.pendingCalls()).toEqual([]);

    await t.link.flush();
    expect(got.filter((g) => g.path === "/v1/steps/G1.a/note")).toHaveLength(1);
  });

  it("backs off between probes while the hub stays away", async () => {
    const bh = await blackhole();
    const t = await setup(`http://127.0.0.1:${bh.port}`);
    await t.link.rpc("GET", "/v1/me").catch(() => undefined);
    t.advance(5_000);
    await t.link.flush();
    const probes1 = t.calls.filter((c) => c.endsWith("/health")).length;
    t.advance(5_000);
    await t.link.flush();
    expect(t.calls.filter((c) => c.endsWith("/health")).length).toBe(probes1);
    t.advance(6_000);
    await t.link.flush();
    expect(t.calls.filter((c) => c.endsWith("/health")).length).toBe(probes1 + 1);
  });
});

describe("syncedSessions (Q5)", () => {
  const base = {
    claudeSessionIds: ["c1"],
    cwd: "/home/a/secret-project",
    kind: "interactive" as const,
    quiet: false,
    startedAt: 1,
    turns: 2,
    humanPrompts: 1,
    seenByReconciler: true,
  };
  const step = { ...base, sid: "s-step", state: "working" as const, lastEventAt: 5, step: "G1.a", pane: "%1" };
  const free = {
    ...base,
    sid: "s-free",
    state: "needs_you" as const,
    needs: "permission" as const,
    lastEventAt: 9,
    name: "fix tests",
    repo: { id: "r1", name: "repo" },
    pid: 42,
    pane: "%2",
    tmuxSocket: "/tmp/tmux",
    lastMessage: "private text",
    transcriptPath: "/home/a/.claude/t.jsonl",
    transcriptMtime: 3,
  };

  it("sends only step holders by default", async () => {
    const { syncedSessions } = await import("./hub-link.ts");
    expect(syncedSessions([step, free], "steps").map((s) => s.sid)).toEqual(["s-step"]);
  });

  it("with the opt-in, adds the rest as metadata only", async () => {
    const { syncedSessions } = await import("./hub-link.ts");
    const { Session } = await import("../protocol/index.ts");
    const out = syncedSessions([free, step], "all");
    expect(out.map((s) => s.sid)).toEqual(["s-step", "s-free"]);
    expect(out[0]).toEqual(step);
    const m = out[1];
    expect(Session.parse(m)).toEqual(m);
    expect(m).toMatchObject({ state: "needs_you", needs: "permission", name: "fix tests", repo: { name: "repo" }, cwd: "", claudeSessionIds: [] });
    for (const k of ["pid", "pane", "tmuxSocket", "lastMessage", "transcriptPath", "transcriptMtime"]) expect(m).not.toHaveProperty(k);
  });

  it("caps a sync at 200 records, step holders first", async () => {
    const { syncedSessions } = await import("./hub-link.ts");
    const many = Array.from({ length: 250 }, (_, i) => ({ ...free, sid: `f${i}`, lastEventAt: i }));
    const out = syncedSessions([...many, step], "all");
    expect(out).toHaveLength(200);
    expect(out[0]?.sid).toBe("s-step");
    expect(out[1]?.sid).toBe("f249");
  });
});

// ---------------------------------------------------------------------------------------------
// MM-1: share levels on the daemon side (AC-03, AC-16, AC-27).

const sess = (sid: string, over: Partial<Session> = {}): Session => ({
  sid,
  claudeSessionIds: [`c-${sid}`],
  cwd: `/home/a/work/${sid}`,
  kind: "interactive",
  state: "idle",
  quiet: false,
  startedAt: 1,
  lastEventAt: 10,
  turns: 1,
  humanPrompts: 1,
  seenByReconciler: true,
  pid: 4000,
  pane: "%9",
  transcriptPath: `/home/a/.claude/${sid}.jsonl`,
  lastMessage: "private text",
  ...over,
});

const PRIVATE_KEYS = ["pane", "pid", "transcriptPath", "lastMessage"] as const;

describe("AC-03 syncedSessions by share level", () => {
  // 3 step holders (one with the oldest lastEventAt of all), 205 no-step sessions.
  const holders = [sess("h-old", { step: "G1.a", lastEventAt: 0 }), sess("h-2", { step: "G1.b", lastEventAt: 500 }), sess("h-3", { step: "G1.c", lastEventAt: 900 })];
  const free = Array.from({ length: 205 }, (_, i) => sess(`f${String(i).padStart(3, "0")}`, { lastEventAt: 1 + i }));
  const all = [...free.slice(0, 100), holders[1] as Session, ...free.slice(100), holders[0] as Session, holders[2] as Session];

  it("test_AC03_steps_only_step_holders", () => {
    const out = syncedSessions(all, "steps");
    expect(out.map((s) => s.sid).sort()).toEqual(["h-2", "h-3", "h-old"]);
    for (const s of out) expect(s.cwd).not.toBe("");
  });

  it("test_AC03_me_step_holders_first_then_metadata", () => {
    const out = syncedSessions(all, "me");
    expect(out).toHaveLength(200);
    expect(out.slice(0, 3).map((s) => s.sid).sort()).toEqual(["h-2", "h-3", "h-old"]);
    for (const s of out.slice(0, 3)) expect(s.cwd).toBe(`/home/a/work/${s.sid}`);
    const rest = out.slice(3);
    expect(rest.every((s) => s.step === undefined)).toBe(true);
    const times = rest.map((s) => s.lastEventAt);
    expect(times).toEqual([...times].sort((a, b) => b - a));
    expect(rest[0]?.sid).toBe("f204");
    for (const s of rest) {
      expect(s.cwd).toBe("");
      for (const k of PRIVATE_KEYS) expect(s).not.toHaveProperty(k);
    }
  });

  it("test_AC03_all_same_as_me", () => {
    expect(syncedSessions(all, "all")).toEqual(syncedSessions(all, "me"));
    // Positive control: the levels differ from `steps`.
    expect(syncedSessions(all, "all")).not.toEqual(syncedSessions(all, "steps"));
  });

  it("test_AC03_cap_keeps_step_holders", () => {
    for (const level of ["me", "all"] as const) {
      const sids = syncedSessions(all, level).map((s) => s.sid);
      expect(sids).toContain("h-old");
      expect(sids).toHaveLength(200);
    }
  });

  it("test_AC03_metadata_matches_sessionMetadata", () => {
    const byId = new Map(all.map((s) => [s.sid, s]));
    const rest = syncedSessions(all, "me").slice(3);
    expect(rest.length).toBeGreaterThan(0);
    for (const m of rest) expect(m).toEqual(sessionMetadata(byId.get(m.sid) as Session));
  });
});

// A fake hub behind the link's fetch: it records each POST /v1/sync body and answers a scripted reply.
type Reply = { status: number; json: unknown };
async function fakeHub(opts: { share: ShareLevel; sessions?: Session[]; repos?: () => Repo[] }) {
  const dir = mkdtempSync(join(tmpdir(), "mesh-link-mm-"));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  const credentialsPath = join(dir, "credentials.json");
  let mtime = 1_700_000_000;
  const setCredentials = (hub: string, machine: string) => {
    writeFileSync(credentialsPath, JSON.stringify({ hub, token: "t", user: { id: "bob", name: "bob", roles: ["member"] }, machine }));
    mtime += 10;
    utimesSync(credentialsPath, mtime, mtime);
  };
  setCredentials("http://hub-a.test", "m-0000000a");
  const store = await DaemonStore.open(":memory:");
  cleanups.push(() => store.close());
  let now = 1_000_000;
  const bodies: { hub: string; body: Record<string, unknown> & { sessions: Session[]; machine?: { share?: string; repos?: Repo[] } } }[] = [];
  const logs: string[] = [];
  const t = {
    bodies,
    logs,
    setCredentials,
    advance: (ms: number) => (now += ms),
    /** The reply to the next syncs, by hub host. */
    reply: ((_host: string): Reply => ({ status: 200, json: { accepted: 0 } })) as (host: string) => Reply,
    link: undefined as unknown as HubLink,
  };
  const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  t.link = new HubLink({
    credentialsPath,
    store,
    sessions: () => opts.sessions ?? [],
    share: () => opts.share,
    ...(opts.repos ? { machineRepos: opts.repos } : {}),
    onMessage: () => "queued",
    log: (l) => void logs.push(l),
    now: () => now,
    timeoutMs: 1_000,
    fetch: (async (url: string | URL | Request, init?: RequestInit) => {
      const u = new URL(String(url));
      if (u.pathname === "/v1/sync" && init?.method === "POST") {
        bodies.push({ hub: u.host, body: JSON.parse(String(init.body)) });
        const r = t.reply(u.host);
        return json(r.status, r.json);
      }
      if (u.pathname === "/health") return json(200, { ok: true });
      if (u.pathname === "/v1/inbox") return json(200, { messages: [] });
      return json(200, {});
    }) as typeof fetch,
  });
  /** Flush until one more sync body was sent (a failed sync may take the link offline for a probe). */
  const sync = async () => {
    const before = bodies.length;
    for (let i = 0; i < 4 && bodies.length === before; i++) {
      await t.link.flush();
      if (bodies.length === before) t.advance(60_000);
    }
    expect(bodies.length, "a sync was sent").toBe(before + 1);
    return bodies[bodies.length - 1]?.body as (typeof bodies)[number]["body"];
  };
  // Object.assign, not a spread: `h.reply = …` must reach the fetch above, which reads `t.reply`.
  return Object.assign(t, { sync });
}

const NOT_CONFIRMED = "the hub does not support share level me; sending step holders only";
const sids = (b: { sessions: Session[] }) => b.sessions.map((s) => s.sid).sort();

describe("AC-27 hub confirmation of `me`", () => {
  const sessions = [sess("s1", { step: "G1.a", lastEventAt: 5 }), sess("s2", { lastEventAt: 7 }), sess("s3", { lastEventAt: 9 })];
  const confirmAll = (h: Awaited<ReturnType<typeof fakeHub>>, share: string) => (h.reply = () => ({ status: 200, json: { accepted: 0, share } }));

  it("test_AC27_unconfirmed_sends_step_holders_only", async () => {
    const h = await fakeHub({ share: "me", sessions });
    for (let i = 0; i < 3; i++) {
      const b = await h.sync();
      expect(sids(b)).toEqual(["s1"]);
      expect(b.machine?.share).toBe("me");
    }
  });

  it("test_AC27_log_once", async () => {
    const h = await fakeHub({ share: "me", sessions });
    for (let i = 0; i < 3; i++) await h.sync();
    expect(h.logs.filter((l) => l.includes(NOT_CONFIRMED))).toHaveLength(1);
  });

  it("test_AC27_first_sync_never_nostep", async () => {
    const h = await fakeHub({ share: "me", sessions });
    confirmAll(h, "me");
    const first = await h.sync();
    expect(first.machine?.share).toBe("me");
    expect(sids(first)).toEqual(["s1"]);
  });

  it("test_AC27_confirmed_sends_nostep", async () => {
    const h = await fakeHub({ share: "me", sessions });
    confirmAll(h, "me");
    await h.sync();
    const b = await h.sync();
    expect(sids(b)).toEqual(["s1", "s2", "s3"]);
    for (const s of b.sessions.filter((x) => x.sid !== "s1")) {
      expect(s.cwd).toBe("");
      for (const k of PRIVATE_KEYS) expect(s).not.toHaveProperty(k);
    }
    expect(h.logs.filter((l) => l.includes(NOT_CONFIRMED))).toHaveLength(0);
  });

  it("test_AC27_reply_without_share_unconfirms", async () => {
    const h = await fakeHub({ share: "me", sessions });
    confirmAll(h, "me");
    await h.sync();
    expect(sids(await h.sync())).toEqual(["s1", "s2", "s3"]);
    h.reply = () => ({ status: 200, json: { accepted: 0 } });
    await h.sync();
    expect(sids(await h.sync())).toEqual(["s1"]);
  });

  it("test_AC27_credentials_switch_unconfirms", async () => {
    const h = await fakeHub({ share: "me", sessions });
    h.reply = (host) => (host === "hub-c.test" ? { status: 200, json: { accepted: 0 } } : { status: 200, json: { accepted: 0, share: "me" } });
    await h.sync();
    expect(sids(await h.sync())).toEqual(["s1", "s2", "s3"]);

    h.setCredentials("http://hub-b.test", "m-0000000a");
    const first = await h.sync();
    expect(h.bodies.at(-1)?.hub).toBe("hub-b.test");
    expect(sids(first)).toEqual(["s1"]);
    expect(sids(await h.sync())).toEqual(["s1", "s2", "s3"]);

    // Same hub, another machine id: unconfirmed again.
    h.setCredentials("http://hub-b.test", "m-0000000b");
    expect(sids(await h.sync())).toEqual(["s1"]);
    expect(sids(await h.sync())).toEqual(["s1", "s2", "s3"]);

    expect(h.logs.filter((l) => l.includes(NOT_CONFIRMED))).toHaveLength(0);
    h.setCredentials("http://hub-c.test", "m-0000000a");
    for (let i = 0; i < 3; i++) expect(sids(await h.sync())).toEqual(["s1"]);
    expect(h.logs.filter((l) => l.includes(NOT_CONFIRMED))).toHaveLength(1);
  });

  it("test_AC27_all_needs_no_confirmation", async () => {
    const h = await fakeHub({ share: "all", sessions });
    const b = await h.sync();
    expect(sids(b)).toEqual(["s1", "s2", "s3"]);
    expect(b.machine?.share).toBe("all");
    expect(sids(await h.sync())).toEqual(["s1", "s2", "s3"]);
    expect(h.logs.filter((l) => l.includes(NOT_CONFIRMED))).toHaveLength(0);
  });

  it("test_AC27_steps_never_sends_nostep", async () => {
    const h = await fakeHub({ share: "steps", sessions });
    confirmAll(h, "steps");
    for (let i = 0; i < 3; i++) {
      const b = await h.sync();
      expect(sids(b)).toEqual(["s1"]);
      expect(b.machine?.share).toBe("steps");
    }
  });
});

describe("AC-16 repos re-sent only on change (hub link)", () => {
  const alpha = { id: "example.org/team/alpha", name: "alpha" };
  const beta = { id: "example.org/team/beta", name: "beta" };
  const gamma = { id: "example.org/team/gamma", name: "gamma" };

  async function setup() {
    let repos: Repo[] = [alpha, beta];
    const h = await fakeHub({ share: "me", repos: () => repos });
    h.reply = () => ({ status: 200, json: { accepted: 0, share: "me" } });
    return { h, setRepos: (r: Repo[]) => (repos = r) };
  }

  it("test_AC16_first_sync_carries_repos", async () => {
    const { h } = await setup();
    expect((await h.sync()).machine?.repos).toEqual([alpha, beta]);
  });

  it("test_AC16_unchanged_not_resent", async () => {
    const { h } = await setup();
    await h.sync();
    const b = await h.sync();
    expect(b.machine?.share).toBe("me");
    expect(b.machine).not.toHaveProperty("repos");
  });

  it("test_AC16_change_resent", async () => {
    const { h, setRepos } = await setup();
    await h.sync();
    await h.sync();
    setRepos([alpha, beta, gamma]);
    expect((await h.sync()).machine?.repos).toEqual([alpha, beta, gamma]);
    expect((await h.sync()).machine).not.toHaveProperty("repos");
  });

  it("test_AC16_credentials_switch_resends", async () => {
    const { h } = await setup();
    await h.sync();
    expect((await h.sync()).machine).not.toHaveProperty("repos");
    h.setCredentials("http://hub-b.test", "m-0000000a");
    expect((await h.sync()).machine?.repos).toEqual([alpha, beta]);
    expect((await h.sync()).machine).not.toHaveProperty("repos");
    h.setCredentials("http://hub-b.test", "m-0000000b");
    expect((await h.sync()).machine?.repos).toEqual([alpha, beta]);
  });

  it("test_AC16_failed_sync_not_accepted", async () => {
    const { h } = await setup();
    h.reply = () => ({ status: 500, json: { error: "boom" } });
    expect((await h.sync()).machine?.repos).toEqual([alpha, beta]);
    h.reply = () => ({ status: 200, json: { accepted: 0, share: "me" } });
    expect((await h.sync()).machine?.repos).toEqual([alpha, beta]);
    expect((await h.sync()).machine).not.toHaveProperty("repos");
  });
});

// ---------------------------------------------------------------------------------------------
// MM-2 AC-02: session labels travel with the session record.

describe("AC-02 labels in sessionMetadata and syncedSessions", () => {
  it("test_AC02_metadata_copies_labels", () => {
    const m = sessionMetadata(sess("s-l", { labels: ["perf"], cwd: "/x" }));
    expect(m.labels).toStrictEqual(["perf"]);
    for (const k of PRIVATE_KEYS) expect(k in m, k).toBe(false);
    expect(m.cwd).toBe("");
  });

  it("test_AC02_metadata_no_labels_no_key", () => {
    const m = sessionMetadata(sess("s-plain"));
    expect(Object.hasOwn(m, "labels")).toBe(false);
    // Positive control: the same session with labels carries the key.
    expect(Object.hasOwn(sessionMetadata(sess("s-plain", { labels: ["a"] })), "labels")).toBe(true);
  });

  const list = [sess("holder", { step: "G1.a", labels: ["a"], lastEventAt: 5 }), sess("free", { labels: ["b"], lastEventAt: 7 }), sess("plain", { lastEventAt: 9 })];
  const bySid = (out: Session[]) => new Map(out.map((s) => [s.sid, s]));

  it("test_AC02_synced_me_carries_labels", () => {
    const out = bySid(syncedSessions(list, "me"));
    expect([...out.keys()].sort()).toEqual(["free", "holder", "plain"]);
    expect(out.get("holder")?.labels).toStrictEqual(["a"]);
    expect(out.get("free")?.labels).toStrictEqual(["b"]);
    expect(out.get("free")?.cwd).toBe("");
    expect(Object.hasOwn(out.get("plain") as Session, "labels")).toBe(false);
  });

  it("test_AC02_synced_steps_drops_free", () => {
    const out = syncedSessions(list, "steps");
    expect(out.map((s) => s.sid)).toEqual(["holder"]);
    expect(out[0]?.labels).toStrictEqual(["a"]);
  });
});
