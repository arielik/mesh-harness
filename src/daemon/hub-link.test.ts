// T1 (local-first design §5): the hub link against a blackholed hub fails fast after the first
// failure, probes in the background, and drains the outbox and queued calls once when it is back.

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { DaemonStore } from "../store/index.ts";
import { HubLink, HubRpcError } from "./hub-link.ts";

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
