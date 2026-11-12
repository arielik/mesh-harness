// RL-5 concurrent catalog pushes (code review T2 with B2): two hub replicas (two HubService
// instances, each with its own store connection to one database) take a push of the same catalog
// source at the same time, each with its own text of `rev`. Afterwards exactly one definition per
// name is current (spec: "afterwards exactly the pushed (name, hash) pairs of the repo are current"),
// all of them from one push, and the source's `commit`/`digest`/`count` belong to that push.
// SQLite (a file) always; Postgres when MESH_TEST_PG_URL is set. The race is a Postgres one (READ
// COMMITTED); SQLite serialises writers. This lives under test/ rather than in
// src/store/hub-store.contract.test.ts because src/store may not import src/hub (pnpm boundaries).
// Written from the spec's contracts only (docs/specs/RL-5.md).

import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { sha256 } from "../src/auth/index.ts";
import { buildHubConfig, startHub, type RunningHub } from "../src/hub/index.ts";
import { HubStore } from "../src/store/index.ts";
import { PG_URL, PgFixture } from "./helpers/pg.ts";
import type { Json } from "./helpers/world.ts";

const SRC_URL = "https://git.example.com/team/agents.git";
const SRC = "git.example.com/team/agents";
const FILLERS = 150;
const T0 = 1_762_000_000_000;

const sha = (s: string) => createHash("sha256").update(s, "utf8").digest("hex");
/** The documented `agentFileHash`: SHA-256 of the text with CRLF turned into LF. */
const H = (t: string) => sha(t.replace(/\r\n/g, "\n"));
/** The documented `catalogDigest`: SHA-256 of `<path>\t<hash>\n` lines sorted by path. */
const digest = (defs: { path: string; hash: string }[]) =>
  sha(
    [...defs]
      .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
      .map((d) => `${d.path}\t${d.hash}\n`)
      .join(""),
  );

const pgdb = new PgFixture();
const dirs: string[] = [];
const hubs: RunningHub[] = [];
const stores: HubStore[] = [];

afterEach(async () => {
  for (const h of hubs.splice(0)) await h.stop().catch(() => undefined);
  for (const s of stores.splice(0)) await s.close().catch(() => undefined);
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
afterAll(async () => {
  await pgdb.end();
});

async function call(hub: RunningHub, method: "GET" | "POST", path: string, token: string, b?: unknown): Promise<{ status: number; json: Json }> {
  const res = await fetch(hub.url + path, { method, headers: { "content-type": "application/json", authorization: `Bearer ${token}` }, ...(b !== undefined ? { body: JSON.stringify(b) } : {}) });
  const text = await res.text();
  let json: Json;
  try {
    json = text ? JSON.parse(text) : undefined;
  } catch {
    json = text;
  }
  return { status: res.status, json };
}

async function login(hub: RunningHub, user: string, host: string): Promise<string> {
  const res = await fetch(`${hub.url}/auth/team/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ token: `${user}-token-secret`, hostname: host, install: `inst-${host}` }) });
  expect(res.status).toBe(200);
  return ((await res.json()) as { token: string }).token;
}

async function replicas(db: string): Promise<{ h1: RunningHub; h2: RunningHub; ann: string; bob: string }> {
  const config = buildHubConfig(
    {
      listen: "127.0.0.1:0",
      db,
      auth: {
        providers: [{ id: "team", kind: "token", users: ["ann", "bob", "root"].map((n) => ({ name: n, token_sha256: sha256(`${n}-token-secret`) })) }],
        bootstrap_admins: ["team:root"],
      },
    },
    { baseDir: "/", env: {} },
  );
  const s1 = await HubStore.open(db);
  stores.push(s1);
  const h1 = await startHub(config, { store: s1, tickMs: 0, now: () => T0 });
  hubs.push(h1);
  const s2 = await HubStore.open(db);
  stores.push(s2);
  const h2 = await startHub(config, { store: s2, tickMs: 0, now: () => T0 });
  hubs.push(h2);
  const root = await login(h1, "root", "root-box");
  const saved = await call(h1, "POST", "/v1/catalog-sources", root, { repo: SRC_URL, folder: "agents" });
  expect(saved.status, JSON.stringify(saved.json)).toBe(201);
  const ann = await login(h1, "ann", "ann-box");
  const bob = await login(h2, "bob", "bob-box");
  for (const [h, t] of [
    [h1, ann],
    [h2, bob],
  ] as const) {
    const s = await call(h, "POST", "/v1/sync", t, { events: [], counts: {}, sessions: [], machine: { share: "me", repos: [{ id: SRC, name: "agents" }] } });
    expect(s.status, JSON.stringify(s.json)).toBe(200);
  }
  return { h1, h2, ann, bob };
}

/** One push: `rev` plus FILLERS other agents, every text marked with `tag` (so every hash differs between pushes). */
function push(tag: string, commit: string): { repo: string; commit: string; defs: { path: string; text: string }[] } {
  const defs = [{ path: "agents/rev.md", text: `---\ndescription: Reviews (${tag})\n---\nYou review, ${tag}.\n` }];
  for (let i = 0; i < FILLERS; i++) defs.push({ path: `agents/f${String(i).padStart(3, "0")}.md`, text: `---\ndescription: Filler ${i}\n---\nFiller ${i} of ${tag}.\n` });
  return { repo: SRC, commit, defs };
}

async function race(db: string, round: number): Promise<void> {
  const { h1, h2, ann, bob } = await replicas(db);
  const a = push(`a${round}`, "a".repeat(40));
  const b = push(`b${round}`, "b".repeat(40));
  const [ra, rb] = await Promise.all([call(h1, "POST", "/v1/catalog-sources/push", ann, a), call(h2, "POST", "/v1/catalog-sources/push", bob, b)]);
  expect(ra.status, JSON.stringify(ra.json)).toBe(200);
  expect(rb.status, JSON.stringify(rb.json)).toBe(200);

  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- RL-5 store methods, read loosely
  const store = h1.svc.store as any;
  const current = (await store.listCatalogDefs({ repo: SRC, current: true })) as Json[];
  const revs = current.filter((d) => d.name === "rev");
  expect(revs.map((d) => d.hash), "exactly one current rev").toHaveLength(1);
  const byName = new Map<string, number>();
  for (const d of current) byName.set(d.name as string, (byName.get(d.name as string) ?? 0) + 1);
  expect([...byName.values()].every((n) => n === 1), JSON.stringify([...byName])).toBe(true);
  expect(current).toHaveLength(FILLERS + 1);

  const winner = revs[0]?.hash === H(a.defs[0]!.text) ? a : b;
  expect([H(a.defs[0]!.text), H(b.defs[0]!.text)]).toContain(revs[0]?.hash);
  const want = winner.defs.map((d) => ({ path: d.path, hash: H(d.text) }));
  // Every current definition is the winner's.
  expect(current.map((d) => `${String(d.path)}\t${String(d.hash)}`).sort()).toStrictEqual(want.map((d) => `${d.path}\t${d.hash}`).sort());
  // The source row belongs to the same push.
  for (const h of [h1, h2]) {
    const sources = (await call(h, "GET", "/v1/catalog-sources", ann)).json.sources as Json[];
    const src = sources.find((s) => s.repo === SRC);
    expect(src).toMatchObject({ commit: winner.commit, digest: digest(want), count: FILLERS + 1 });
  }
  // Both pushes' texts stay stored (texts are never deleted).
  const all = (await store.listCatalogDefs({ repo: SRC, name: "rev" })) as Json[];
  expect(new Set(all.map((d) => d.hash))).toStrictEqual(new Set([H(a.defs[0]!.text), H(b.defs[0]!.text)]));
}

const ROUNDS = 5;

describe("RL-5 concurrent catalog pushes (B2)", { timeout: 120_000 }, () => {
  it("test_AC03_concurrent_push sqlite", async () => {
    for (let i = 0; i < ROUNDS; i++) {
      const d = mkdtempSync(join(tmpdir(), "mesh-roster-replicas-"));
      dirs.push(d);
      await race(join(d, "hub.db"), i);
      for (const h of hubs.splice(0)) await h.stop();
      for (const s of stores.splice(0)) await s.close();
    }
  });

  it.skipIf(!PG_URL)("test_AC03_concurrent_push postgres", async () => {
    for (let i = 0; i < ROUNDS; i++) {
      await race(await pgdb.fresh(), i);
      for (const h of hubs.splice(0)) await h.stop();
      for (const s of stores.splice(0)) await s.close();
    }
  });
});
