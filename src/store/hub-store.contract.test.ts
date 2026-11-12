// Store contract suite (M4.6): the same tests against every hub driver. SQLite always runs;
// Postgres runs when MESH_TEST_PG_URL points at a server where the user may create databases
// (each test gets a fresh one), e.g. postgres://postgres:mesh@127.0.0.1:55432/postgres.

import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pg from "pg";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import type { Goal, Session, Step } from "../protocol/index.ts";
import { openDb, type Db } from "./db.ts";
import { describeDbTarget, toPgPlaceholders } from "./dialect.ts";
import { HubStore } from "./hub-store.ts";
import { openPgDb } from "./pg.ts";

const PG_URL = process.env.MESH_TEST_PG_URL;

interface Driver {
  name: string;
  /** A fresh, empty database target (file path or URL) for one test. */
  fresh(): Promise<string>;
  openDb(target: string, migrations: readonly string[]): Promise<Db>;
  cleanup(): Promise<void>;
}

const dirs: string[] = [];
const sqlite: Driver = {
  name: "sqlite",
  async fresh() {
    const d = mkdtempSync(join(tmpdir(), "mesh-contract-"));
    dirs.push(d);
    return join(d, "hub.db");
  },
  openDb: (target, migrations) => openDb(target, migrations),
  async cleanup() {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  },
};

const pgDatabases: string[] = [];
let admin: pg.Pool | undefined;
const postgres: Driver = {
  name: "postgres",
  async fresh() {
    admin ??= new pg.Pool({ connectionString: PG_URL, max: 2 });
    const name = `mesh_t_${randomUUID().replace(/-/g, "").slice(0, 16)}`;
    await admin.query(`CREATE DATABASE ${name}`);
    pgDatabases.push(name);
    const u = new URL(PG_URL as string);
    u.pathname = `/${name}`;
    return u.toString();
  },
  openDb: (target, migrations) => openPgDb(target, migrations),
  async cleanup() {
    for (const name of pgDatabases.splice(0)) await admin?.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
  },
};

afterAll(async () => {
  await admin?.end();
  admin = undefined;
});

if (!PG_URL) process.stderr.write("store contract suite: the Postgres leg is SKIPPED (set MESH_TEST_PG_URL=postgres://… to run it)\n");

const tick = () => new Promise<void>((ok) => setTimeout(ok, 5));
const T0 = 1_762_000_000_000; // a millisecond time past 2^31, so INTEGER columns would overflow

const session = (sid: string): Session => ({
  sid,
  claudeSessionIds: ["c-" + sid],
  cwd: "/w",
  kind: "interactive",
  state: "idle",
  quiet: false,
  startedAt: T0,
  lastEventAt: T0,
  turns: 0,
  humanPrompts: 0,
  seenByReconciler: false,
});

const goalInput = (title: string): Omit<Goal, "id"> => ({ title, ownerId: "ada", state: "backlog", priority: 0, createdAt: T0, updatedAt: T0 });

const step = (id: string, over: Partial<Step> = {}): Step => ({
  id,
  goal: id.split(".")[0] as string,
  planVersion: 1,
  kind: "implement",
  repo: "example/app",
  title: id,
  brief: "",
  deps: [],
  state: "ready",
  fixCycles: 0,
  updatedAt: T0,
  ...over,
});

function contract(d: Driver) {
  const opened: { close(): Promise<void> }[] = [];
  const track = <T extends { close(): Promise<void> }>(x: T): T => (opened.push(x), x);
  const store = async () => track(await HubStore.open(await d.fresh()));
  const db = async (migrations: readonly string[]) => track(await d.openDb(await d.fresh(), migrations));

  afterEach(async () => {
    for (const x of opened.splice(0)) await x.close().catch(() => undefined);
    await d.cleanup();
  });

  describe("Db", () => {
    it("migrates from empty, then upgrades in place keeping data, and refuses a newer schema", async () => {
      const target = await d.fresh();
      const v1 = await d.openDb(target, ["CREATE TABLE a (x INTEGER)"]);
      await v1.run("INSERT INTO a (x) VALUES (?)", 42);
      await v1.close();
      const v2 = await d.openDb(target, ["CREATE TABLE a (x INTEGER)", "ALTER TABLE a ADD COLUMN y TEXT DEFAULT 'd'"]);
      expect(await v2.get("SELECT version FROM schema_version")).toEqual({ version: 2 });
      expect(await v2.all("SELECT x, y FROM a")).toEqual([{ x: 42, y: "d" }]);
      await v2.close();
      await expect(d.openDb(target, ["CREATE TABLE a (x INTEGER)"])).rejects.toThrow(/newer/);
    });

    it("lets several hubs start on one database at once: one migrates, the others find it done", async () => {
      const target = await d.fresh();
      const migrations = ["CREATE TABLE a (x INTEGER)", "CREATE TABLE b (x INTEGER)", "ALTER TABLE a ADD COLUMN y TEXT"];
      const dbs = await Promise.all([1, 2, 3].map(() => d.openDb(target, migrations)));
      for (const x of dbs) track(x);
      expect(await dbs[0]?.all("SELECT version FROM schema_version")).toEqual([{ version: 3 }]);
    });

    it("rolls back a failed transaction and drops its after-commit hooks", async () => {
      const x = await db(["CREATE TABLE a (x INTEGER)"]);
      const seen: string[] = [];
      await expect(
        x.transaction(async () => {
          await x.run("INSERT INTO a (x) VALUES (1)");
          x.afterCommit(() => seen.push("rolled back"));
          throw new Error("boom");
        }),
      ).rejects.toThrow("boom");
      await x.transaction(async () => {
        await x.run("INSERT INTO a (x) VALUES (2)");
        await x.transaction(async () => x.run("INSERT INTO a (x) VALUES (3)"));
        x.afterCommit(() => seen.push("committed"));
        await tick();
        expect(seen).toEqual([]);
      });
      await tick();
      expect(seen).toEqual(["committed"]);
      expect(await x.all("SELECT x FROM a ORDER BY x")).toEqual([{ x: 2 }, { x: 3 }]);
    });

    it("never shows a transaction's uncommitted rows to calls from outside it", async () => {
      const x = await db(["CREATE TABLE a (x INTEGER)"]);
      let release!: () => void;
      const gate = new Promise<void>((ok) => (release = ok));
      const failing = x.transaction(async () => {
        await x.run("INSERT INTO a (x) VALUES (1)");
        await gate;
        throw new Error("boom");
      });
      await tick();
      const outsideRead = x.all<{ x: number }>("SELECT x FROM a");
      const outsideWrite = x.run("INSERT INTO a (x) VALUES (2)");
      await tick();
      release();
      await expect(failing).rejects.toThrow("boom");
      await outsideWrite;
      // The rolled-back row is never seen. (On Postgres the outside read and write run on separate
      // pool connections, so the read may or may not see the committed 2.)
      expect((await outsideRead).map((r) => r.x)).not.toContain(1);
      expect(await x.all("SELECT x FROM a")).toEqual([{ x: 2 }]);
    });

    it("returns ids from INSERT … RETURNING and counts changed rows", async () => {
      const x = await db([d.name === "postgres" ? "CREATE TABLE a (id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY, v TEXT)" : "CREATE TABLE a (id INTEGER PRIMARY KEY AUTOINCREMENT, v TEXT)"]);
      expect(await x.get("INSERT INTO a (v) VALUES (?) RETURNING id", "p")).toEqual({ id: 1 });
      expect((await x.run("INSERT INTO a (v) VALUES (?) RETURNING id", "q")).lastId).toBe(2);
      expect((await x.run("UPDATE a SET v = ? WHERE v <> '?'", "r")).changes).toBe(2);
    });
  });

  describe("HubStore", () => {
    it("creates users from identities, suffixing clashing names, also when logins race", async () => {
      const s = await store();
      const ada = await s.upsertIdentity({ provider: "oidc", subject: "1", name: "Ada", email: "ada@example.com", groups: ["dev"] }, T0);
      expect(ada).toMatchObject({ id: "ada", name: "Ada", email: "ada@example.com", roles: ["member"], createdAt: T0 });
      expect((await s.upsertIdentity({ provider: "oidc", subject: "1", name: "Ada L", groups: [] }, T0 + 1)).id).toBe("ada");
      const others = await Promise.all([2, 3, 4, 5].map((n) => s.upsertIdentity({ provider: "oidc", subject: String(n), name: "Ada", groups: [] }, T0)));
      expect(others.map((u) => u.id).sort()).toEqual(["ada-2", "ada-3", "ada-4", "ada-5"]);
      await s.setUserRoles("ada", ["admin"]);
      await s.setRolesExtra("ada", ["lead"]);
      expect(await s.getUser("ada")).toMatchObject({ name: "Ada L", email: "ada@example.com", roles: ["admin"], rolesExtra: ["lead"] });
      expect(await s.linkIdentity("oidc", "2", "ada")).toBe(true);
      expect(await s.linkIdentity("oidc", "nope", "ada")).toBe(false);
      expect((await s.listUsers()).map((u) => u.id)).toEqual(["ada", "ada-2", "ada-3", "ada-4", "ada-5"]);
    });

    it("stores tokens with millisecond times and revokes them", async () => {
      const s = await store();
      await s.upsertIdentity({ provider: "oidc", subject: "1", name: "Ada", groups: [] }, T0);
      const t = { hash: "h1", userId: "ada", kind: "device" as const, machineId: "m1", createdAt: T0, lastUsed: T0, expiresAt: T0 + 90 * 86_400_000, revoked: false };
      await s.insertToken(t);
      await s.insertToken({ ...t, hash: "h2", machineId: undefined, kind: "web" });
      expect(await s.getToken("h1")).toEqual({ ...t, label: undefined });
      await s.touchToken("h1", T0 + 5);
      expect((await s.getToken("h1"))?.lastUsed).toBe(T0 + 5);
      await s.revokeToken("h2");
      expect((await s.getToken("h2"))?.revoked).toBe(true);
      expect(await s.revokeTokens({ machineId: "m1" })).toBe(1);
      expect(await s.revokeTokens({ userId: "ada" })).toBe(0);
      expect(await s.getToken("nope")).toBeUndefined();
    });

    it("keeps login attempts until they expire, replacing one with the same id", async () => {
      const s = await store();
      await s.putLoginAttempt("a", { v: 1 }, T0);
      await s.putLoginAttempt("a", { v: 2 }, T0 + 10);
      await s.putLoginAttempt("old", { v: 0 }, T0 - 1000);
      expect(await s.getLoginAttempt("a", T0 + 20, 500)).toEqual({ v: 2 });
      expect(await s.getLoginAttempt("old", T0 + 20, 500)).toBeUndefined();
      // An update keeps the attempt's age: polling a device login does not keep it alive forever.
      expect(await s.updateLoginAttempt("a", { v: 3 })).toBe(true);
      expect(await s.getLoginAttempt("a", T0 + 20, 500)).toEqual({ v: 3 });
      expect(await s.getLoginAttempt("a", T0 + 600, 500)).toBeUndefined();
      expect(await s.updateLoginAttempt("a", { v: 4 })).toBe(false);
      await s.putLoginAttempt("a", { v: 2 }, T0 + 10);
      expect(await s.deleteLoginAttempt("a")).toBe(true);
      expect(await s.deleteLoginAttempt("a")).toBe(false);
      expect(await s.getLoginAttempt("a", T0 + 20, 500)).toBeUndefined();
    });

    it("upserts machines and sessions", async () => {
      const s = await store();
      await s.upsertIdentity({ provider: "oidc", subject: "1", name: "Ada", groups: [] }, T0);
      await s.upsertMachine({ id: "m1", userId: "ada", hostname: "one" }, T0);
      await s.upsertMachine({ id: "m1", userId: "ada", hostname: "uno" }, T0 + 1);
      await s.touchMachine("m1", T0 + 2, { working: 1 });
      expect(await s.listMachines()).toEqual([{ id: "m1", userId: "ada", hostname: "uno", lastSeen: T0 + 2, counts: { working: 1 } }]);
      await s.upsertSession(session("s1"), "ada", "m1", T0);
      await s.upsertSession({ ...session("s1"), turns: 3 }, "ada", "m2", T0 + 1);
      expect(await s.getSession("s1")).toMatchObject({ userId: "ada", machineId: "m2", updatedAt: T0 + 1, session: { turns: 3 } });
      expect((await s.listSessions()).map((x) => x.session.sid)).toEqual(["s1"]);
      await s.upsertSession(session("s2"), "ada", "m2", T0 + 2);
      await s.unlistSessions("m2", ["s2"]);
      expect((await s.listSessions()).map((x) => x.session.sid)).toEqual(["s2"]);
      expect(await s.getSession("s1")).toBeDefined();
      await s.upsertSession(session("s1"), "ada", "m2", T0 + 3);
      expect((await s.listSessions()).map((x) => x.session.sid)).toEqual(["s1", "s2"]);
    });

    it("defines, lists and deletes topics; a name is defined once", async () => {
      const s = await store();
      expect(await s.createTopic({ name: "perf", createdBy: "ada", createdAt: T0 })).toBe(true);
      expect(await s.createTopic({ name: "dataplane", description: "packets", createdBy: "ada", createdAt: T0 + 1 })).toBe(true);
      expect(await s.createTopic({ name: "perf", createdBy: "bob", createdAt: T0 + 2 })).toBe(false);
      expect((await s.listTopics()).map((t) => t.name)).toEqual(["dataplane", "perf"]);
      expect(await s.getTopic("perf")).toEqual({ name: "perf", createdBy: "ada", createdAt: T0 });
      expect(await s.deleteTopic("perf")).toBe(true);
      expect(await s.deleteTopic("perf")).toBe(false);
      expect(await s.getTopic("perf")).toBeUndefined();
    });

    it("numbers goals without gaps or duplicates under concurrent creation, and finds them ignoring case", async () => {
      const s = await store();
      const goals = await Promise.all([1, 2, 3, 4, 5].map((n) => s.createGoal(goalInput(`goal ${n}`))));
      expect(goals.map((g) => g.id).sort()).toEqual(["G1", "G2", "G3", "G4", "G5"]);
      expect((await s.getGoal("g3"))?.id).toBe("G3");
      const g1 = (await s.getGoal("G1")) as Goal;
      await s.saveGoal({ ...g1, state: "design", updatedAt: T0 + 1 });
      expect((await s.listGoals()).map((g) => `${g.id}:${g.state}`)).toEqual(["G1:design", "G2:backlog", "G3:backlog", "G4:backlog", "G5:backlog"]);
    });

    it("saves plans and steps, keeping steps in first-insert order", async () => {
      const s = await store();
      const plan = { goal: "G1", version: 1, steps: [], proposedBy: "ada", proposedAt: T0, decision: "pending" as const };
      await s.savePlan(plan);
      await s.savePlan({ ...plan, decision: "approved" });
      await s.savePlan({ ...plan, version: 2 });
      expect((await s.listPlans("G1")).map((p) => [p.version, p.decision])).toEqual([
        [1, "approved"],
        [2, "pending"],
      ]);
      await s.saveSteps([step("G1.zeta"), step("G1.alpha"), step("G2.x")]);
      await s.saveSteps([step("G1.zeta", { state: "claimed", holderUser: "ada" })]);
      expect((await s.listSteps({ goal: "g1" })).map((x) => x.id)).toEqual(["G1.zeta", "G1.alpha"]);
      expect((await s.listSteps({ state: "claimed" })).map((x) => x.id)).toEqual(["G1.zeta"]);
      expect((await s.listSteps({ holderUser: "ada" })).map((x) => x.id)).toEqual(["G1.zeta"]);
      expect((await s.listSteps()).map((x) => x.id)).toEqual(["G1.zeta", "G1.alpha", "G2.x"]);
      expect((await s.getStep("g1.ALPHA"))?.id).toBe("G1.alpha");
    });

    it("lets exactly one of several concurrent claims win", async () => {
      const s = await store();
      const ready = step("G1.a");
      await s.saveSteps([ready]);
      const users = ["u1", "u2", "u3", "u4", "u5", "u6"];
      const wins = await Promise.all(
        users.map((u) => s.tx(async () => s.claimStep({ ...ready, state: "claimed", holderUser: u, claimedAt: T0, updatedAt: T0 + 1 }, ready))),
      );
      expect(wins.filter(Boolean)).toHaveLength(1);
      const winner = users[wins.indexOf(true)];
      expect(await s.getStep("G1.a")).toMatchObject({ state: "claimed", holderUser: winner });
      expect((await s.listSteps({ holderUser: winner })).map((x) => x.id)).toEqual(["G1.a"]);
      // The holder may claim again (a new session); a stale read may not.
      const held = (await s.getStep("G1.a")) as Step;
      expect(await s.claimStep({ ...held, holderSid: "s2" }, held)).toBe(true);
      expect(await s.claimStep({ ...ready, state: "claimed", holderUser: "late" }, ready)).toBe(false);
    });

    it("adds notes, questions and messages with increasing ids", async () => {
      const s = await store();
      const n1 = await s.addNote({ step: "G1.a", user: "ada", text: "one", at: T0 });
      const n2 = await s.addNote({ step: "G1.a", user: "ada", sid: "s1", text: "two?", at: T0 + 1 });
      expect(n2.id).toBeGreaterThan(n1.id);
      expect(await s.listNotes("G1.a")).toEqual([n1, n2]);

      const q = await s.addQuestion({ fromUser: "ada", toUsers: ["bob"], text: "why?", at: T0 });
      expect(await s.getQuestion(q.id)).toEqual(q);
      expect((await s.openQuestions()).map((x) => x.id)).toEqual([q.id]);
      await s.saveQuestion({ ...q, answer: "because", answeredBy: "bob", answeredAt: T0 + 1 });
      expect(await s.openQuestions()).toEqual([]);

      const m1 = await s.addMessage({ toMachine: "m1", toSid: "s1", fromUser: "ada", kind: "note", text: "hi", data: { a: 1 } }, T0);
      const m2 = await s.addMessage({ toMachine: "m1", toSid: "s1", fromUser: "ada", kind: "note", text: "again" }, T0 + 1);
      expect(m1).toMatchObject({ state: "pending", createdAt: T0, data: { a: 1 } });
      expect(m2.id).toBeGreaterThan(m1.id);
      expect((await s.inbox("m1")).map((m) => m.text)).toEqual(["hi", "again"]);
      expect(await s.ackMessage(m1.id, "m1", "delivered", "stop", T0 + 2)).toBe(true);
      expect(await s.ackMessage(m1.id, "m1", "failed", undefined, T0 + 3)).toBe(false);
      expect(await s.ackMessage(m2.id, "other", "delivered", undefined, T0 + 3)).toBe(false);
      expect(await s.getMessage(m1.id)).toMatchObject({ state: "delivered", method: "stop", ackedAt: T0 + 2 });
      expect((await s.inbox("m1")).map((m) => m.id)).toEqual([m2.id]);
    });

    it("appends events in order, dedupes by id, filters, prunes and pages", async () => {
      const s = await store();
      const a = await s.appendEvent({ id: "e1", at: T0, type: "goal.created", user: "ada", goal: "G1" });
      const b = await s.appendEvent({ at: T0 + 1, type: "step.claimed", goal: "G1", step: "G1.a", payload: { n: 1 } });
      const c = await s.appendEvent({ at: T0 + 2, type: "session.stop", sid: "s1", step: "G1.b" });
      expect(await s.appendEvent({ id: "e1", at: T0, type: "goal.created" })).toBeUndefined();
      expect([a, b, c].every((x) => typeof x === "number")).toBe(true);
      expect((a as number) < (b as number) && (b as number) < (c as number)).toBe(true);
      expect((await s.events(0, 10)).map((e) => e.type)).toEqual(["goal.created", "step.claimed", "session.stop"]);
      expect((await s.events(a as number, 1)).map((e) => e.seq)).toEqual([b]);
      expect(await s.events(0, 10, { goal: "G1" })).toHaveLength(2);
      expect((await s.events(0, 10))[1]).toEqual({ seq: b, id: expect.any(String), at: T0 + 1, type: "step.claimed", user: undefined, sid: undefined, goal: "G1", step: "G1.a", payload: { n: 1 } });
      expect((await s.eventsFor({ step: "G1.a" })).map((e) => e.seq)).toEqual([b]);
      expect((await s.eventsFor({ goal: "G1" })).map((e) => e.seq)).toEqual([a, b, c]);
      expect((await s.recentEvents(2)).map((e) => e.seq)).toEqual([b, c]);
      expect(await s.pruneEvents(T0 + 1)).toBe(1);
      expect((await s.events(0, 10)).map((e) => e.seq)).toEqual([b, c]);
    });

    it("keeps the event cursor gap-free: concurrent writers never commit a seq behind a reader's cursor", async () => {
      // Two store handles on one database stand for two replicas (on SQLite, two processes).
      const target = await d.fresh();
      const w1 = track(await HubStore.open(target));
      const w2 = d.name === "sqlite" ? w1 : track(await HubStore.open(target));
      const reader = d.name === "sqlite" ? w1 : track(await HubStore.open(target));
      let writing = true;
      const seen: number[] = [];
      const read = async () => {
        let cursor = 0;
        for (let more = true; more; ) {
          more = writing;
          for (const e of await reader.events(cursor, 1000)) {
            seen.push(e.seq);
            cursor = e.seq;
          }
          await new Promise((ok) => setTimeout(ok, 1));
        }
      };
      const write = async (s: HubStore, w: number) => {
        for (let i = 0; i < 8; i++) {
          // A slow transaction: it appends, works a little longer, then commits.
          await s.tx(async () => {
            await s.appendEvent({ at: T0, type: "t", payload: { w, i } });
            await new Promise((ok) => setTimeout(ok, Math.random() * 6));
            await s.appendEvent({ at: T0, type: "t", payload: { w, i, second: true } });
          });
        }
      };
      const reading = read();
      await Promise.all([0, 1, 2, 3, 4, 5].map((w) => write(w % 2 ? w2 : w1, w)));
      writing = false;
      await reading;
      const all = (await reader.events(0, 1000)).map((e) => e.seq);
      expect(all).toHaveLength(96);
      expect(seen).toEqual(all);
    });

    it("keeps the first response for an idempotency key", async () => {
      const s = await store();
      await s.putIdem("k", "ada", { ok: 1 }, T0);
      await s.putIdem("k", "ada", { ok: 2 }, T0 + 1);
      await s.putIdem("k", "bob", { ok: 3 }, T0 + 1);
      expect(await s.getIdem("k", "ada")).toEqual({ ok: 1 });
      expect(await s.getIdem("k", "bob")).toEqual({ ok: 3 });
      await s.putIdem("later", "ada", {}, T0 + 25 * 60 * 60_000);
      expect(await s.getIdem("k", "ada")).toBeUndefined();
    });

    it(d.name === "sqlite" ? "backs up to a file" : "refuses `mesh hub backup` (the database's own tools do that)", async () => {
      const s = await store();
      await s.createGoal(goalInput("kept"));
      const dir = mkdtempSync(join(tmpdir(), "mesh-backup-"));
      dirs.push(dir);
      if (d.name !== "sqlite") return void (await expect(s.backup(join(dir, "copy.db"))).rejects.toThrow(/pg_dump/));
      await s.backup(join(dir, "copy.db"));
      const copy = track(await HubStore.open(join(dir, "copy.db")));
      expect((await copy.listGoals()).map((g) => g.title)).toEqual(["kept"]);
    });
  });
}

describe("store contract: sqlite", () => contract(sqlite));
describe.skipIf(!PG_URL)(`store contract: postgres${PG_URL ? "" : " (skipped: set MESH_TEST_PG_URL)"}`, () => contract(postgres));

describe.skipIf(!PG_URL)(`postgres only${PG_URL ? "" : " (skipped: set MESH_TEST_PG_URL)"}`, () => {
  const opened: { close(): Promise<void> }[] = [];
  const track = <T extends { close(): Promise<void> }>(x: T): T => (opened.push(x), x);
  afterEach(async () => {
    for (const x of opened.splice(0)) await x.close().catch(() => undefined);
    await postgres.cleanup();
  });

  it("runs a deadlock victim's transaction again, so both transactions commit once", async () => {
    const db = track(await openPgDb(await postgres.fresh(), ["CREATE TABLE a (id INTEGER PRIMARY KEY, n INTEGER NOT NULL); INSERT INTO a VALUES (1, 0), (2, 0);"]));
    let firstUpdates = 0;
    let bothIn!: () => void;
    const barrier = new Promise<void>((ok) => (bothIn = ok));
    let attempts = 0;
    // Opposite lock order: 1 then 2, and 2 then 1. Postgres aborts one as the deadlock victim.
    const cross = (first: number, second: number) =>
      db.transaction(async () => {
        attempts++;
        await db.run("UPDATE a SET n = n + 1 WHERE id = ?", first);
        if (++firstUpdates === 2) bothIn();
        await barrier;
        await db.run("UPDATE a SET n = n + 1 WHERE id = ?", second);
      });
    await Promise.all([cross(1, 2), cross(2, 1)]);
    expect(attempts).toBe(3);
    expect(await db.all("SELECT id, n FROM a ORDER BY id")).toEqual([
      { id: 1, n: 2 },
      { id: 2, n: 2 },
    ]);
  });

  it("does not retry other errors", async () => {
    const db = track(await openPgDb(await postgres.fresh(), ["CREATE TABLE a (id INTEGER PRIMARY KEY)"]));
    let attempts = 0;
    await expect(
      db.transaction(async () => {
        attempts++;
        await db.run("INSERT INTO a VALUES (1), (1)");
      }),
    ).rejects.toThrow(/duplicate key/);
    expect(attempts).toBe(1);
  });

  it("carries channel messages between two connections to one database", async () => {
    const target = await postgres.fresh();
    const one = track(await HubStore.open(target));
    const two = track(await HubStore.open(target));
    const tx = track(one.channel("mesh_test") as NonNullable<ReturnType<HubStore["channel"]>>);
    const rx = track(two.channel("mesh_test") as NonNullable<ReturnType<HubStore["channel"]>>);
    const got: string[] = [];
    await rx.listen({ message: (p) => got.push(p) });
    await tx.publish("hello");
    for (let i = 0; i < 200 && got.length === 0; i++) await tick();
    expect(got).toEqual(["hello"]);
    expect(() => one.channel("Bad-Name")).toThrow(/channel name/);
  });

  it("gives the tick lead to one store at a time", async () => {
    const target = await postgres.fresh();
    const one = track(await HubStore.open(target)).leader("tick");
    const two = track(await HubStore.open(target)).leader("tick");
    expect(await one.acquire()).toBe(true);
    expect(await two.acquire()).toBe(false);
    await one.release();
    expect(await two.acquire()).toBe(true);
    expect(await one.acquire()).toBe(false);
    await two.release();
  });
});

describe("dialect helpers", () => {
  it("rewrites ? placeholders for Postgres, leaving quoted text and comments alone", () => {
    expect(toPgPlaceholders("SELECT * FROM t WHERE a = ? AND b = '?' AND \"c?\" = ? -- what?\n AND d = ?")).toBe("SELECT * FROM t WHERE a = $1 AND b = '?' AND \"c?\" = $2 -- what?\n AND d = $3");
    expect(toPgPlaceholders("SELECT 'it''s ?', ?")).toBe("SELECT 'it''s ?', $1");
  });

  it("hides a Postgres password in log lines", () => {
    expect(describeDbTarget("postgres://mesh:secret@db.example.com:5432/mesh")).toBe("postgres://mesh:***@db.example.com:5432/mesh");
    expect(describeDbTarget("/var/lib/mesh/hub.db")).toBe("/var/lib/mesh/hub.db");
  });
});
