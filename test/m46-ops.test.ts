// M4.6 stage 4: operations. Liveness and readiness probes, and `mesh hub migrate` (a SQLite hub
// copied into Postgres). The probe tests run on SQLite; the Postgres legs run when MESH_TEST_PG_URL
// is set (see test/helpers/pg.ts).

import { execFile } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { sha256 } from "../src/auth/index.ts";
import { buildHubConfig, startHub, type HubConfig, type RunningHub } from "../src/hub/index.ts";
import type { LoginResult } from "../src/protocol/index.ts";
import { copyHubToPostgres, HubStore, openPgDb, openSyncDb, HUB_MIGRATIONS, HUB_MIGRATIONS_PG } from "../src/store/index.ts";
import { PG_URL, PgFixture } from "./helpers/pg.ts";

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- JSON responses in assertions
type Json = any;

const TOKEN = "alice-secret-token";
const pgdb = new PgFixture();
const dirs: string[] = [];
const running: RunningHub[] = [];
const clock = 1_762_000_000_000;

afterEach(async () => {
  for (const h of running.splice(0)) await h.stop();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  await pgdb.cleanup();
});
afterAll(() => pgdb.end());

if (!PG_URL) process.stderr.write("m46 ops: the Postgres legs are SKIPPED (set MESH_TEST_PG_URL=postgres://… to run them)\n");

function makeConfig(db: string): HubConfig {
  return buildHubConfig(
    { listen: "127.0.0.1:0", db, auth: { providers: [{ id: "team", kind: "token", users: [{ name: "alice", token_sha256: sha256(TOKEN) }] }] } },
    { baseDir: "/", env: {} },
  );
}

async function start(db: string, store?: HubStore): Promise<RunningHub> {
  const hub = await startHub(makeConfig(db), { tickMs: 0, now: () => clock, ...(store ? { store } : {}) });
  running.push(hub);
  return hub;
}

async function call(hub: RunningHub, method: string, path: string, token?: string, body?: unknown, headers: Record<string, string> = {}): Promise<{ status: number; json: Json }> {
  const res = await fetch(hub.url + path, {
    method,
    headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const text = await res.text();
  return { status: res.status, json: text ? JSON.parse(text) : undefined };
}

const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), "mesh-ops-"));
  dirs.push(d);
  return d;
};

describe("probes", () => {
  it("/healthz and /readyz answer without auth when the database is up and migrated", async () => {
    const hub = await start(":memory:");
    expect(await call(hub, "GET", "/healthz")).toEqual({ status: 200, json: { ok: true } });
    expect(await call(hub, "GET", "/readyz")).toEqual({ status: 200, json: { ok: true, schema: HubStore.SCHEMA_VERSION } });
  });

  // MM-1 AC-05 checked schema 7; RL-1 AC-08 (migration 8) moved it to 8; RL-2 AC-08 (migration 9) to 9.
  it("test_AC05_readyz_schema_8 (MM-1, RL-1 AC-08, RL-2 AC-08)", async () => {
    const hub = await start(":memory:");
    expect(await call(hub, "GET", "/readyz")).toEqual({ status: 200, json: { ok: true, schema: 9 } });
    expect(HUB_MIGRATIONS_PG).toHaveLength(HUB_MIGRATIONS.length);
  });

  it("/readyz is 503 when the schema is older than this hub's, and while shutting down; /healthz stays 200", async () => {
    const hub = await start(":memory:");
    await hub.svc.store.db.run("UPDATE schema_version SET version = ?", HubStore.SCHEMA_VERSION - 1);
    const r = await call(hub, "GET", "/readyz");
    expect(r.status).toBe(503);
    expect(r.json.error).toMatch(/schema version/);
    // A newer release migrated the shared database (rolling upgrade): this replica keeps serving.
    await hub.svc.store.db.run("UPDATE schema_version SET version = ?", HubStore.SCHEMA_VERSION + 1);
    expect(await call(hub, "GET", "/readyz")).toEqual({ status: 200, json: { ok: true, schema: HubStore.SCHEMA_VERSION + 1 } });
    await hub.svc.store.db.run("UPDATE schema_version SET version = ?", HubStore.SCHEMA_VERSION);
    hub.svc.draining = true;
    expect((await call(hub, "GET", "/readyz")).status).toBe(503);
    expect((await call(hub, "GET", "/healthz")).status).toBe(200);
  });

  it("/readyz is 503 when the database is gone", async () => {
    const store = await HubStore.open(":memory:");
    const hub = await start(":memory:", store);
    await store.close();
    const r = await call(hub, "GET", "/readyz");
    expect(r.status).toBe(503);
    expect(r.json.error).toMatch(/database unreachable/);
    expect((await call(hub, "GET", "/healthz")).status).toBe(200);
  });

  it.skipIf(!PG_URL)("/readyz on Postgres", async () => {
    const hub = await start(await pgdb.fresh());
    expect(await call(hub, "GET", "/readyz")).toEqual({ status: 200, json: { ok: true, schema: HubStore.SCHEMA_VERSION } });
  });
});

/** A SQLite hub with a row in every table, made through the API where it can be. */
async function seedSqliteHub(file: string): Promise<void> {
  const hub = await start(file);
  const alice = (await call(hub, "POST", "/auth/team/login", undefined, { token: TOKEN, hostname: "laptop" })).json as LoginResult;
  const g = await call(hub, "POST", "/v1/goals", alice.token, { title: "Copy me", primaryRepo: "example/app" }, { "idempotency-key": "k-1" });
  expect(g.status).toBe(201);
  const plan = {
    design_ref: "example/app@main:docs/design.md",
    steps: [
      { id: "a", repo: "example/app", kind: "implement", title: "a", brief: "first" },
      { id: "b", repo: "example/app", kind: "implement", title: "b", brief: "second", deps: ["a"] },
      { id: "c", repo: "example/lib", kind: "test", title: "c", brief: "third", deps: ["a"] },
    ],
  };
  expect((await call(hub, "POST", `/v1/goals/${g.json.id}/plan`, alice.token, { ...plan, approve: true })).status).toBe(201);
  const s = hub.svc.store;
  const user = alice.user.id;
  await s.addNote({ step: `${g.json.id}.a`, user, text: "a note", at: clock });
  await s.addNote({ step: `${g.json.id}.a`, user, text: "another", at: clock + 1 });
  await s.addQuestion({ fromUser: user, toUsers: [user], text: "why?", at: clock });
  await s.addMessage({ toMachine: alice.machine as string, toSid: "s-1", fromUser: user, kind: "say", text: "hello" }, clock);
  await s.upsertSession(
    { sid: "s-1", claudeSessionIds: ["c-1"], cwd: "/w", kind: "interactive", state: "working", quiet: false, startedAt: clock, lastEventAt: clock, turns: 1, humanPrompts: 1, seenByReconciler: true },
    user,
    alice.machine as string,
    clock,
  );
  await s.putLoginAttempt("attempt-1", { provider: "team" }, clock);
  await hub.stop();
  running.splice(running.indexOf(hub), 1);
}

/** Every row of every hub table, as plain values in primary-key order (step.ord left out). */
const TABLES = ["user", "identity", "token", "login_attempt", "machine", "hsession", "goal", "plan", "step", "note", "question", "message", "event", "idem"];
async function dumpSqlite(file: string): Promise<Record<string, unknown[]>> {
  const db = await openSyncDb(file, HUB_MIGRATIONS);
  try {
    return Object.fromEntries(TABLES.map((t) => [t, db.all(`SELECT * FROM "${t}" ORDER BY rowid`)]));
  } finally {
    db.close();
  }
}
async function dumpPg(url: string): Promise<Record<string, unknown[]>> {
  const db = await openPgDb(url, HUB_MIGRATIONS_PG, { max: 1 });
  try {
    const out: Record<string, unknown[]> = {};
    for (const t of TABLES) {
      const rows = await db.all<Record<string, unknown>>(`SELECT * FROM "${t}" ${t === "step" ? "ORDER BY ord" : ""}`);
      out[t] = t === "step" ? rows.map(({ ord: _ord, ...r }) => r) : rows;
    }
    return out;
  } finally {
    await db.close();
  }
}
const sortRows = (d: Record<string, unknown[]>) => Object.fromEntries(Object.entries(d).map(([t, rows]) => [t, t === "step" ? rows : rows.map((r) => JSON.stringify(r)).sort()]));

describe.skipIf(!PG_URL)(`mesh hub migrate (SQLite to Postgres)${PG_URL ? "" : " (skipped: set MESH_TEST_PG_URL)"}`, () => {
  it("copies every row, keeps ids, sequence numbers and step order, and new ids follow the copied ones", async () => {
    const file = join(tmp(), "hub.db");
    await seedSqliteHub(file);
    const url = await pgdb.fresh();
    const report = await copyHubToPostgres(file, url);
    const before = await dumpSqlite(file);
    for (const t of TABLES) {
      expect(before[t]?.length, `${t} has rows to copy`).toBeGreaterThan(0);
      expect(report.tables.find((x) => x.name === t)?.rows, t).toBe(before[t]?.length);
    }
    expect(sortRows(await dumpPg(url))).toEqual(sortRows(before));

    // The copied hub serves the same data, and new rows take ids after the copied ones.
    const hub = await start(url);
    const alice = (await call(hub, "POST", "/auth/team/login", undefined, { token: TOKEN, hostname: "laptop" })).json as LoginResult;
    const goals = (await call(hub, "GET", "/v1/goals", alice.token)).json.goals as { id: string }[];
    expect(goals.map((g) => g.id)).toEqual(["G1"]);
    expect((await call(hub, "GET", "/v1/steps?goal=G1", alice.token)).json.steps.map((s: { id: string }) => s.id)).toEqual(["G1.design", "G1.a", "G1.b", "G1.c"]);
    const maxSeq = Math.max(...(before.event as { seq: number }[]).map((e) => e.seq));
    const note = await hub.svc.store.addNote({ step: "G1.a", user: alice.user.id, text: "after the move", at: clock });
    expect(note.id).toBe(3);
    expect((await call(hub, "POST", "/v1/goals", alice.token, { title: "next", primaryRepo: "example/app" })).json.id).toBe("G2");
    // Event sequence numbers carry on from the copied ones, with no gap (the login added one too).
    const seqs = (await hub.svc.store.events(maxSeq - 1, 100)).map((e) => e.seq);
    expect(seqs.length).toBeGreaterThan(2);
    expect(seqs).toEqual(seqs.map((_, i) => maxSeq + i));
    // The idempotency key was copied too: replaying it returns the first answer.
    expect((await call(hub, "POST", "/v1/goals", alice.token, { title: "Copy me", primaryRepo: "example/app" }, { "idempotency-key": "k-1" })).json.id).toBe("G1");
  });

  it("refuses a target that already holds a hub unless --force, and leaves it untouched", async () => {
    const file = join(tmp(), "hub.db");
    await seedSqliteHub(file);
    const url = await pgdb.fresh();
    await copyHubToPostgres(file, url);
    const hub = await start(url);
    const alice = (await call(hub, "POST", "/auth/team/login", undefined, { token: TOKEN, hostname: "laptop" })).json as LoginResult;
    await call(hub, "POST", "/v1/goals", alice.token, { title: "only in postgres", primaryRepo: "example/app" });
    await hub.stop();
    running.splice(running.indexOf(hub), 1);

    const changed = sortRows(await dumpPg(url));
    await expect(copyHubToPostgres(file, url)).rejects.toThrow(/already holds a hub.*--force/);
    expect(sortRows(await dumpPg(url))).toEqual(changed);

    const report = await copyHubToPostgres(file, url, { force: true });
    expect(report.replaced).toBe(true);
    expect(sortRows(await dumpPg(url))).toEqual(sortRows(await dumpSqlite(file)));
  });

  it("refuses wrong arguments", async () => {
    const url = await pgdb.fresh();
    await expect(copyHubToPostgres(join(tmp(), "missing.db"), url)).rejects.toThrow(/not found/);
    await expect(copyHubToPostgres(url, url)).rejects.toThrow(/SQLite hub file/);
    await expect(copyHubToPostgres(join(tmp(), "x.db"), join(tmp(), "y.db"))).rejects.toThrow(/postgres:\/\//);
  });

  it("runs from the CLI with the target URL taken from MESH_HUB_DB", async () => {
    const dir = tmp();
    const file = join(dir, "hub.db");
    await seedSqliteHub(file);
    const url = await pgdb.fresh();
    const run = promisify(execFile);
    const main = join(import.meta.dirname, "..", "src", "main.ts");
    const { stdout } = await run(process.execPath, [main, "hub", "migrate", "--from", file], { cwd: dir, env: { ...process.env, MESH_HUB_DB: url, MESH_HUB_CONFIG: "" } });
    expect(stdout).toMatch(/Copied \d+ rows; every table's row count matches/);
    expect(stdout).toContain(":***@");
    expect(stdout).not.toContain(`:${new URL(url).password}@`);
    const second = await run(process.execPath, [main, "hub", "migrate", "--from", file], { cwd: dir, env: { ...process.env, MESH_HUB_DB: url, MESH_HUB_CONFIG: "" } }).catch((e: { stderr: string; code: number }) => e);
    expect((second as { code: number }).code).toBe(1);
    expect((second as { stderr: string }).stderr).toMatch(/--force/);
  });
});

// RL-2 AC-32: the three review tables go through `mesh hub migrate` (Postgres only). Written from the
// spec's contracts only (docs/specs/RL-2.md); the new store methods are read loosely.
describe.skipIf(!PG_URL)(`RL-2 tables${PG_URL ? "" : " (skipped: set MESH_TEST_PG_URL)"}`, () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- new store methods, read loosely
  const X = (s: HubStore): any => s;
  const L = "-|example/app|auditor";
  const review = (step: string, raising: boolean) => ({
    goal: "G1",
    step,
    round: 1,
    lineage: L,
    raising,
    complete: true,
    record: {
      subject: {},
      coverage: "complete",
      assessment: raising ? "issues" : "clean",
      items: raising ? [{ key: { rule: "I-03", path: "a.ts" }, title: "T", severity: "S2", category: "c", evidence: [], fp: "abcdefghijklmnop", mark: "new" }] : [],
      dispositions: [],
      summary: "s",
    },
    ...(raising ? { fold: { new: 1, repeat: 0, regression: 0, resolved: 0, carried: 0 } } : {}),
    artifact: `a-01J00000000000000000000${raising ? "RA" : "CO"}`,
    undeclaredRules: 0,
    decider: { kind: "agent", key: "app/audit" },
    by: "alice",
    at: clock,
  });
  const row = { lineage: L, fp: "abcdefghijklmnop", state: "dismissed", rule: "I-03", path: "a.ts", title: "T", severity: "S2", category: "c", raisedBy: { key: "app/audit" }, first: { goal: "G1", step: "G1.a", round: 1, at: clock }, last: { goal: "G1", step: "G1.a", round: 1, at: clock } };
  const fold = (mark: string) => ({ at: clock, goal: "G1", step: "G1.a", round: 1, from: null, to: "open", kind: "fold", mark });
  const disposed = { at: clock + 1, goal: "G1", step: "G1.b", round: 1, from: "open", to: "dismissed", kind: "disposition", disposition: "dismissed", reason: "r", decider: { kind: "agent", key: "app/b" }, via: "stage" };

  it("test_AC32_copy", async () => {
    const file = join(tmp(), "hub.db");
    await seedSqliteHub(file);
    const s = await HubStore.open(file);
    await X(s).addReview(review("G1.a", true));
    await X(s).addReview(review("G1.b", false));
    await X(s).saveItem(row);
    await X(s).addItemHistory(L, row.fp, fold("new"));
    await X(s).addItemHistory(L, row.fp, disposed);
    await X(s).addItemHistory(L, "qrstuvwxyz234567", fold("new"));
    const before = { history: await X(s).itemHistory(L, row.fp), reviews: await X(s).listReviews({ lineage: L }) };
    await s.close();
    const url = await pgdb.fresh();
    const report = await copyHubToPostgres(file, url);
    const sq = await openSyncDb(file, HUB_MIGRATIONS);
    const counts: Record<string, number> = {};
    try {
      for (const t of ["review_record", "review_item", "item_history"]) counts[t] = (sq.all(`SELECT * FROM "${t}"`) as unknown[]).length;
    } finally {
      sq.close();
    }
    expect(counts).toStrictEqual({ review_record: 2, review_item: 1, item_history: 3 });
    for (const t of Object.keys(counts)) expect(report.tables.find((x) => x.name === t)?.rows, t).toBe(counts[t]);
    const pgd = await openPgDb(url, HUB_MIGRATIONS_PG, { max: 1 });
    try {
      for (const t of Object.keys(counts)) expect((await pgd.all(`SELECT * FROM "${t}"`)).length, t).toBe(counts[t]);
    } finally {
      await pgd.close();
    }
    const p = await HubStore.open(url);
    try {
      expect(await X(p).itemHistory(L, row.fp)).toStrictEqual(before.history);
      expect(await X(p).listReviews({ lineage: L })).toStrictEqual(before.reviews);
      const later = fold("regression");
      await X(p).addItemHistory(L, row.fp, later);
      expect(await X(p).itemHistory(L, row.fp)).toStrictEqual([...before.history, later]);
    } finally {
      await p.close();
    }
  });
});
