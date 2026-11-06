// End-to-end check of M4.6: two `mesh hub` processes on one Postgres behind a round-robin proxy.
//   1. a claim race between two clients has exactly one winner
//   2. an SSE hint caused through one replica reaches a subscriber connected to the other
//   3. an OIDC device login started on one replica completes on the other (mock issuer)
//   4. killing the tick leader lets the other replica take over within one tick interval
//   5. concurrent writers on both replicas give a gap-free /v1/events cursor
// No Claude Code and no model calls. Needs `pnpm build` and MESH_TEST_PG_URL (a Postgres server
// where the user may create databases), e.g. postgres://postgres:mesh@127.0.0.1:55432/postgres.

import { spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { createServer, request, type IncomingMessage, type Server } from "node:http";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import pg from "pg";
import { HubStore, LOCKS } from "../src/store/index.ts";
import { MockOidc } from "../test/fixtures/mock-oidc.ts";
import { PgFixture } from "../test/helpers/pg.ts";
import { OUT, ROOT, note, sleep } from "./lib.ts";

/** The hub's tick interval (src/hub/server.ts); `mesh hub` does not change it. */
const TICK_MS = 30_000;

interface Upstream {
  name: string;
  port: number;
}

/** Round-robin HTTP proxy; skips an upstream that refuses the connection. Tags each response with x-upstream. */
class RoundRobin {
  private next = 0;
  private server: Server;
  private upstreams: Upstream[];

  constructor(upstreams: Upstream[]) {
    this.upstreams = upstreams;
    this.server = createServer((req, res) => {
      void (async () => {
        const chunks: Buffer[] = [];
        for await (const c of req) chunks.push(c as Buffer);
        const body = Buffer.concat(chunks);
        for (let tries = 0; tries < this.upstreams.length; tries++) {
          const up = this.upstreams[this.next++ % this.upstreams.length] as Upstream;
          const ok = await new Promise<boolean>((done) => {
            const out = request({ host: "127.0.0.1", port: up.port, method: req.method, path: req.url, headers: { ...req.headers, host: `127.0.0.1:${up.port}` } }, (r: IncomingMessage) => {
              res.writeHead(r.statusCode ?? 502, { ...r.headers, "x-upstream": up.name });
              res.flushHeaders();
              r.pipe(res);
              done(true);
            });
            out.on("error", () => done(false));
            res.on("close", () => out.destroy());
            out.end(body);
          });
          if (ok) return;
        }
        res.writeHead(502).end("no upstream");
      })();
    });
  }

  async start(port: number): Promise<void> {
    await new Promise<void>((ok) => this.server.listen(port, "127.0.0.1", ok));
  }

  async stop(): Promise<void> {
    this.server.closeAllConnections();
    await new Promise<void>((ok) => this.server.close(() => ok()));
  }
}

async function freePort(): Promise<number> {
  const s = createServer();
  await new Promise<void>((ok) => s.listen(0, "127.0.0.1", ok));
  const port = (s.address() as AddressInfo).port;
  await new Promise<void>((ok) => s.close(() => ok()));
  return port;
}

export async function runE2eScale(): Promise<void> {
  if (!process.env.MESH_TEST_PG_URL) throw new Error("e2e-scale needs MESH_TEST_PG_URL=postgres://… (a server where the user may create databases)");
  const mesh = join(ROOT, "dist", "main.mjs");
  if (!existsSync(mesh)) throw new Error("run `pnpm build` first");
  const out = join(OUT, "e2e-scale");
  rmSync(out, { recursive: true, force: true });
  mkdirSync(out, { recursive: true });
  const log = join(out, "results.md");
  const failures: string[] = [];
  const check = (label: string, cond: boolean, detail = "") => {
    note(log, `${cond ? "✅" : "❌"} ${label}${detail ? ` — ${detail}` : ""}`);
    if (!cond) failures.push(label);
  };

  const pgdb = new PgFixture();
  const mock = new MockOidc();
  await mock.start();
  const target = await pgdb.fresh();
  const admin = new pg.Client({ connectionString: target });
  await admin.connect();
  const sha = (t: string) => createHash("sha256").update(t).digest("hex");
  const tokens = { alice: "scale-alice", bob: "scale-bob" };
  const hubs: { up: Upstream; proc: ChildProcess; log: string }[] = [];
  const proxyPort = await freePort();
  const proxyUrl = `http://127.0.0.1:${proxyPort}`;
  const upstreams: Upstream[] = [
    { name: "A", port: await freePort() },
    { name: "B", port: await freePort() },
  ];
  const proxy = new RoundRobin(upstreams);

  const startHub = async (up: Upstream) => {
    const cfg = join(out, `hub-${up.name}.yaml`);
    writeFileSync(
      cfg,
      [
        `listen: 127.0.0.1:${up.port}`,
        `url: ${proxyUrl}`,
        "auth:",
        "  providers:",
        "    - id: team",
        "      kind: token",
        "      users:",
        `        - { name: alice, token_sha256: ${sha(tokens.alice)} }`,
        `        - { name: bob, token_sha256: ${sha(tokens.bob)} }`,
        "    - id: sso",
        "      kind: oidc",
        `      issuer: ${mock.issuer}`,
        "      client_id: mesh",
        "      allow_insecure: true",
        "  bootstrap_admins: [team:alice]",
        "",
      ].join("\n"),
    );
    // The database URL comes from the environment, as in a container (it overrides db:).
    const proc = spawn(process.execPath, [mesh, "hub", "--config", cfg], { env: { ...process.env, MESH_HUB_DB: target }, stdio: ["ignore", "pipe", "pipe"] });
    const h = { up, proc, log: "" };
    const append = (d: Buffer) => {
      h.log += d.toString();
      writeFileSync(join(out, `hub-${up.name}.log`), h.log);
    };
    proc.stdout?.on("data", append);
    proc.stderr?.on("data", append);
    hubs.push(h);
    for (let i = 0; i < 100; i++) {
      const ok = await fetch(`http://127.0.0.1:${up.port}/readyz`).then(
        (r) => r.ok,
        () => false,
      );
      if (ok) return h;
      await sleep(100);
    }
    throw new Error(`hub ${up.name} did not get ready:\n${h.log}`);
  };

  type Res = { status: number; upstream: string; json: Record<string, unknown> };
  const call = async (method: string, path: string, token?: string, body?: unknown): Promise<Res> => {
    const r = await fetch(proxyUrl + path, {
      method,
      headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    const text = await r.text();
    return { status: r.status, upstream: r.headers.get("x-upstream") ?? "?", json: text ? (JSON.parse(text) as Record<string, unknown>) : {} };
  };
  const login = async (name: keyof typeof tokens) => {
    const r = await call("POST", "/auth/team/login", undefined, { token: tokens[name], hostname: `${name}-box` });
    if (r.status !== 200) throw new Error(`login ${name}: ${r.status} ${JSON.stringify(r.json)}`);
    return r.json.token as string;
  };
  /** The backend pid holding the tick lock, if any. */
  const tickHolder = async (): Promise<number | undefined> => {
    const r = await admin.query<{ pid: number }>(
      "SELECT l.pid FROM pg_locks l JOIN pg_database d ON d.oid = l.database WHERE l.locktype = 'advisory' AND l.granted AND d.datname = current_database() AND l.classid = $1 AND l.objid = $2",
      [Math.floor(LOCKS.tick / 2 ** 32), LOCKS.tick % 2 ** 32],
    );
    return r.rows[0]?.pid;
  };

  try {
    // A starts first, so its first tick (one interval after start) takes the lead before B asks.
    const t0 = Date.now();
    await startHub(upstreams[0] as Upstream);
    await sleep(3_000);
    await startHub(upstreams[1] as Upstream);
    await proxy.start(proxyPort);
    note(log, `hubs A (:${upstreams[0]?.port}) and B (:${upstreams[1]?.port}) on one Postgres, proxy on :${proxyPort}\n`);
    const alice = await login("alice");
    const bob = await login("bob");

    // ---------- 1. claim race ----------
    const goal = await call("POST", "/v1/goals", alice, { title: "claim race" });
    const ids = Array.from({ length: 10 }, (_, i) => `s${i}`);
    const plan = await call("POST", `/v1/goals/${String(goal.json.id)}/plan`, alice, {
      steps: ids.map((id) => ({ id, repo: "example/app", kind: "implement", title: id, brief: "race" })),
      approve: true,
    });
    check("plan with 10 ready steps approved", plan.status === 201, `status ${plan.status}`);
    let clean = 0;
    let split = 0;
    const detail: string[] = [];
    for (const id of ids) {
      const step = `${String(goal.json.id)}.${id}`;
      const rs = await Promise.all([call("POST", `/v1/steps/${step}/claim`, alice, {}), call("POST", `/v1/steps/${step}/claim`, bob, {})]);
      const winners = rs.filter((r) => r.status === 200);
      const losers = rs.filter((r) => r.status === 409);
      if (winners.length === 1 && losers.length === 1) clean++;
      if (new Set(rs.map((r) => r.upstream)).size === 2) split++;
      const view = await call("GET", `/v1/steps/${step}`, alice);
      const holder = (view.json.context as { step?: { holderUser?: string } } | undefined)?.step?.holderUser;
      const winner = winners[0] === rs[0] ? "alice" : "bob";
      if (winners.length !== 1 || holder !== winner) detail.push(`${id}: ${rs.map((r) => `${r.upstream}:${r.status}`).join(",")} holder=${holder}`);
    }
    check("1. claim race: exactly one winner in each of 10 races, and the store agrees", clean === 10 && detail.length === 0, detail.join("; ") || `${clean}/10 clean`);
    check("1. the two claims of each race went to different replicas", split === 10, `${split}/10`);

    // ---------- 2. SSE hint across replicas ----------
    const ac = new AbortController();
    const sse = await fetch(`${proxyUrl}/v1/stream`, { headers: { authorization: `Bearer ${alice}` }, signal: ac.signal });
    const subOn = sse.headers.get("x-upstream") ?? "?";
    const seen: string[] = [];
    let triggeredAt = 0;
    let gotAt = 0;
    const reading = (async () => {
      const reader = (sse.body as ReadableStream<Uint8Array>).getReader();
      const dec = new TextDecoder();
      let buf = "";
      for (;;) {
        const { done, value } = await reader.read().catch(() => ({ done: true, value: undefined }));
        if (done) return;
        buf += dec.decode(value, { stream: true });
        let i: number;
        while ((i = buf.indexOf("\n\n")) >= 0) {
          const ev = /^event: (.*)$/m.exec(buf.slice(0, i))?.[1] ?? "";
          buf = buf.slice(i + 2);
          seen.push(ev);
          if (ev === "changed" && triggeredAt && !gotAt) gotAt = Date.now();
        }
      }
    })();
    for (let i = 0; i < 50 && !seen.includes("hello"); i++) await sleep(100);
    triggeredAt = Date.now();
    const trigger = await call("POST", "/v1/goals", bob, { title: "hint across replicas" });
    for (let i = 0; i < 50 && !gotAt; i++) await sleep(100);
    check("2. SSE hint: a goal created on one replica wakes a subscriber on the other", trigger.status === 201 && trigger.upstream !== subOn && gotAt > 0, `subscriber on ${subOn}, write on ${trigger.upstream}, ${gotAt ? `hint after ${gotAt - triggeredAt} ms` : "no hint"}`);
    ac.abort();
    await reading;

    // ---------- 3. device login across replicas ----------
    const start = await call("POST", "/auth/sso/device", undefined, { hostname: "headless" });
    mock.approveDevice(String(start.json.userCode));
    let poll: Res = { status: 0, upstream: "?", json: {} };
    const pollsOn = new Set<string>();
    for (let i = 0; i < 20; i++) {
      await sleep(1_100); // the mock issuer's poll interval is 1 s
      poll = await call("POST", "/auth/sso/device/poll", undefined, { pollId: start.json.pollId, hostname: "headless" });
      pollsOn.add(poll.upstream);
      if (poll.status !== 202) break;
      await call("GET", "/healthz"); // keeps every poll on the replica that did not start the login
    }
    const me = poll.status === 200 ? await call("GET", "/v1/me", String(poll.json.token)) : undefined;
    check(
      "3. device login started on one replica completes on the other",
      start.status === 200 && poll.status === 200 && !pollsOn.has(start.upstream) && me?.status === 200,
      `started on ${start.upstream}, polled on ${[...pollsOn].join("+")}, result ${poll.status}${me ? `, /v1/me as ${String((me.json.user as { id?: string }).id)}` : ""}`,
    );

    // ---------- 5. gap-free event cursor under concurrent writers ----------
    const baseline = await call("POST", "/v1/goals", alice, { title: "cursor baseline" });
    const base = Number(((await call("GET", "/v1/events?after=0&limit=1000", alice)).json.events as { seq: number }[]).at(-1)?.seq ?? 0);
    const seenSeqs: number[] = [];
    let cursor = base;
    let writing = true;
    const reader = (async () => {
      for (;;) {
        const stop = !writing;
        const r = await call("GET", `/v1/events?after=${cursor}&limit=1000`, alice);
        const evs = (r.json.events ?? []) as { seq: number }[];
        for (const e of evs) seenSeqs.push(e.seq);
        if (evs.length) cursor = evs.at(-1)?.seq ?? cursor;
        if (stop && evs.length === 0) return;
      }
    })();
    const writers = Array.from({ length: 8 }, (_, w) =>
      (async () => {
        const who = w % 2 ? bob : alice;
        for (let i = 0; i < 15; i++) {
          const r = await call("POST", "/v1/goals", who, { title: `writer ${w} #${i}` });
          if (r.status !== 201) throw new Error(`write failed: ${r.status} ${JSON.stringify(r.json)}`);
        }
      })(),
    );
    await Promise.all(writers);
    writing = false;
    await reader;
    const all = ((await call("GET", `/v1/events?after=${base}&limit=1000`, alice)).json.events as { seq: number; type: string }[]).map((e) => e.seq);
    const ordered = seenSeqs.every((s, i) => i === 0 || s > (seenSeqs[i - 1] as number));
    const missed = all.filter((s) => !seenSeqs.includes(s));
    const created = all.length;
    check(
      "5. event cursor: a reader polling during 120 concurrent writes on both replicas misses nothing",
      baseline.status === 201 && created >= 120 && missed.length === 0 && seenSeqs.length === all.length && ordered,
      `${created} events written after the baseline, reader saw ${seenSeqs.length}, missed ${missed.length}${missed.length ? ` (${missed.slice(0, 5).join(",")})` : ""}, ordered ${ordered}`,
    );

    // ---------- 4. tick leader failover ----------
    // A's first tick is one interval after it started; wait for it to take the lock.
    let holder: number | undefined;
    while (!(holder = await tickHolder()) && Date.now() - t0 < TICK_MS + 15_000) await sleep(250);
    const holderApp = holder ? (await admin.query<{ application_name: string }>("SELECT application_name FROM pg_stat_activity WHERE pid = $1", [holder])).rows[0]?.application_name : undefined;
    check("4. one replica holds the tick lock", holder !== undefined, `backend ${holder} (${holderApp ?? "?"}) after ${Math.round((Date.now() - t0) / 1000)} s`);
    const a = hubs[0] as (typeof hubs)[number];
    a.proc.kill("SIGKILL");
    const killedAt = Date.now();
    await new Promise<void>((ok) => (a.proc.exitCode !== null || a.proc.signalCode !== null ? ok() : a.proc.once("exit", () => ok())));
    // An abandoned claim on a machine gone quiet: the next tick (now B's) pauses it.
    const store = await HubStore.open(target);
    try {
      const user = await store.upsertIdentity({ provider: "team", subject: "bob", name: "bob", groups: [] }, Date.now());
      await store.upsertMachine({ id: "m-gone", userId: user.id, hostname: "gone" }, Date.now() - 20 * 60_000);
      const now = Date.now();
      await store.saveSteps([
        { id: `${String(goal.json.id)}.orphan`, goal: String(goal.json.id), planVersion: 1, kind: "implement", repo: "example/app", title: "orphan", brief: "", deps: [], state: "claimed", holderUser: user.id, holderMachine: "m-gone", claimedAt: now - 20 * 60_000, fixCycles: 0, updatedAt: now - 20 * 60_000 },
      ]);
    } finally {
      await store.close();
    }
    let newHolder: number | undefined;
    let paused = false;
    while (Date.now() - killedAt < TICK_MS + 5_000) {
      newHolder = await tickHolder();
      const evs = ((await call("GET", "/v1/events?after=0&limit=1000", alice)).json.events ?? []) as { type: string; step?: string }[];
      paused = evs.some((e) => e.type === "step.paused" && e.step === `${String(goal.json.id)}.orphan`);
      if (newHolder !== undefined && newHolder !== holder && paused) break;
      await sleep(250);
    }
    const took = Date.now() - killedAt;
    const oldGone = holder !== undefined && (await admin.query("SELECT 1 FROM pg_stat_activity WHERE pid = $1", [holder])).rowCount === 0;
    check(
      "4. after SIGKILL of the leader (A), B takes the tick lock and runs the tick within one interval",
      oldGone && newHolder !== undefined && newHolder !== holder && paused && took <= TICK_MS + 2_000,
      `old backend gone ${oldGone}, new holder ${newHolder}, orphan claim paused ${paused}, after ${(took / 1000).toFixed(1)} s (interval ${TICK_MS / 1000} s)`,
    );
    const after = await call("GET", "/v1/me", alice);
    check("4. the proxy keeps serving through B", after.status === 200 && after.upstream === "B", `${after.status} from ${after.upstream}`);
  } finally {
    for (const h of hubs) if (h.proc.exitCode === null && h.proc.signalCode === null) h.proc.kill("SIGTERM");
    await Promise.all(hubs.map((h) => (h.proc.exitCode !== null || h.proc.signalCode !== null ? undefined : new Promise((ok) => h.proc.once("exit", ok)))));
    await proxy.stop().catch(() => undefined);
    await admin.end();
    await mock.stop();
    await pgdb.end();
  }
  note(log, failures.length ? `\n${failures.length} check(s) failed.` : "\nAll checks passed.");
  if (failures.length) {
    process.exitCode = 1;
    throw new Error(`e2e-scale: ${failures.join("; ")}`);
  }
}
