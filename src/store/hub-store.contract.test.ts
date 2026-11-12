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
import { HUB_MIGRATIONS, HUB_MIGRATIONS_PG, HubStore } from "./hub-store.ts";
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

  // MM-1: per-machine share level, repo inventory and nickname (AC-05, AC-06, AC-07).
  describe("MM-1 machines", () => {
    const A = { id: "example.org/team/a", name: "a" };
    const B = { id: "example.org/team/b", name: "b" };
    const C = { id: "example.org/team/c", name: "c" };

    /** u1 (ada) with m1 and m2, u2 (bea) with m3. */
    async function machines(s: HubStore): Promise<void> {
      await s.upsertIdentity({ provider: "oidc", subject: "1", name: "Ada", groups: [] }, T0);
      await s.upsertIdentity({ provider: "oidc", subject: "2", name: "Bea", groups: [] }, T0);
      await s.upsertMachine({ id: "m1", userId: "ada", hostname: "one" }, T0);
      await s.upsertMachine({ id: "m2", userId: "ada", hostname: "two" }, T0);
      await s.upsertMachine({ id: "m3", userId: "bea", hostname: "three" }, T0);
    }
    const nick = async (s: HubStore, id: string) => (await s.getMachine(id))?.nickname;

    it("test_AC05_schema_version_8", () => {
      expect(HubStore.SCHEMA_VERSION).toBe(10);
    });

    it("test_AC05_migration_lengths_equal", () => {
      expect(HUB_MIGRATIONS.length).toBe(HUB_MIGRATIONS_PG.length);
      expect(HUB_MIGRATIONS.length).toBe(10);
    });

    it("test_AC05_fresh_machine_row_strict", async () => {
      const s = await store();
      await machines(s);
      await s.touchMachine("m1", T0 + 2, { idle: 1 });
      expect(await s.getMachine("m1")).toStrictEqual({ id: "m1", userId: "ada", hostname: "one", lastSeen: T0 + 2, counts: { idle: 1 } });
      expect((await s.listMachines()).find((m) => m.id === "m1")).toStrictEqual({ id: "m1", userId: "ada", hostname: "one", lastSeen: T0 + 2, counts: { idle: 1 } });
      // Positive control: once facts are stored the same read returns them.
      await s.touchMachine("m1", T0 + 3, { idle: 1 }, { share: "me", repos: [A] });
      expect(await s.getMachine("m1")).toMatchObject({ share: "me", repos: [A], reposAt: T0 + 3 });
    });

    it("test_AC06_touch_facts_sequence", async () => {
      const s = await store();
      await machines(s);
      const m2Before = await s.getMachine("m2");
      const c = { idle: 2 };
      // stores share and repos, reposAt = now
      await s.touchMachine("m1", 1000, c, { share: "me", repos: [A, B] });
      expect(await s.getMachine("m1")).toMatchObject({ share: "me", repos: [A, B], reposAt: 1000, lastSeen: 1000 });
      // a plain touch keeps the inventory
      await s.touchMachine("m1", 2000, c);
      expect(await s.getMachine("m1")).toMatchObject({ share: "me", repos: [A, B], reposAt: 1000, lastSeen: 2000 });
      // share only keeps the inventory
      await s.touchMachine("m1", 3000, c, { share: "all" });
      expect(await s.getMachine("m1")).toMatchObject({ share: "all", repos: [A, B], reposAt: 1000, lastSeen: 3000 });
      // given repos replace it
      await s.touchMachine("m1", 4000, c, { share: "all", repos: [C] });
      expect(await s.getMachine("m1")).toMatchObject({ share: "all", repos: [C], reposAt: 4000, lastSeen: 4000 });
      // an empty list clears it
      await s.touchMachine("m1", 5000, c, { repos: [] });
      expect(await s.getMachine("m1")).toMatchObject({ share: "all", repos: [], reposAt: 5000, lastSeen: 5000 });
      // other machines untouched
      expect(await s.getMachine("m2")).toStrictEqual(m2Before);
    });

    it("test_AC07_set_and_clear", async () => {
      const s = await store();
      await machines(s);
      const before = await s.getMachine("m1");
      expect(await s.setMachineNickname("m1", "desk")).toBe(true);
      expect(await nick(s, "m1")).toBe("desk");
      expect(await s.setMachineNickname("m1", undefined)).toBe(true);
      const row = await s.getMachine("m1");
      expect(row).not.toHaveProperty("nickname");
      expect(row).toStrictEqual(before);
    });

    it("test_AC07_duplicate_within_user_refused", async () => {
      const s = await store();
      await machines(s);
      expect(await s.setMachineNickname("m2", "tower")).toBe(true);
      expect(await s.setMachineNickname("m1", "desk")).toBe(true);
      expect(await s.setMachineNickname("m2", "desk")).toBe(false);
      expect(await nick(s, "m2")).toBe("tower");
      expect(await nick(s, "m1")).toBe("desk");
    });

    it("test_AC07_same_nickname_other_user", async () => {
      const s = await store();
      await machines(s);
      expect(await s.setMachineNickname("m1", "desk")).toBe(true);
      expect(await s.setMachineNickname("m3", "desk")).toBe(true);
      expect(await nick(s, "m3")).toBe("desk");
      expect(await nick(s, "m1")).toBe("desk");
    });

    it("test_AC07_rename_to_own_nickname", async () => {
      const s = await store();
      await machines(s);
      expect(await s.setMachineNickname("m1", "desk")).toBe(true);
      expect(await s.setMachineNickname("m1", "desk")).toBe(true);
      expect(await nick(s, "m1")).toBe("desk");
    });

    it("test_AC07_concurrent_one_wins", async () => {
      const target = await d.fresh();
      const s1 = track(await HubStore.open(target));
      const s2 = track(await HubStore.open(target));
      await machines(s1);
      for (let round = 0; round < 20; round++) {
        const x = `n${round}`;
        const results = await Promise.all([s1.setMachineNickname("m1", x), s2.setMachineNickname("m2", x)]);
        expect(results.slice().sort()).toEqual([false, true]);
        const holders = [await nick(s1, "m1"), await nick(s1, "m2")].filter((n) => n === x);
        expect(holders).toHaveLength(1);
        expect(results[0] ? await nick(s1, "m1") : await nick(s1, "m2")).toBe(x);
      }
    });

    it("test_AC07_inside_caller_transaction", async () => {
      const s = await store();
      await machines(s);
      expect(await s.setMachineNickname("m1", "desk")).toBe(true);
      let clash: boolean | undefined;
      await s.tx(async () => {
        clash = await s.setMachineNickname("m2", "desk");
        await s.createTopic({ name: "after-clash", createdBy: "ada", createdAt: T0 });
      });
      expect(clash).toBe(false);
      expect((await s.listTopics()).map((t) => t.name)).toContain("after-clash");
      expect(await nick(s, "m2")).toBeUndefined();
      // Positive control: a non-clashing name in a transaction is stored.
      await s.tx(async () => {
        expect(await s.setMachineNickname("m2", "tower")).toBe(true);
      });
      expect(await nick(s, "m2")).toBe("tower");
    });

    it("test_AC07_unknown_id", async () => {
      const s = await store();
      await machines(s);
      await s.setMachineNickname("m1", "desk");
      const before = await s.listMachines();
      expect(await s.setMachineNickname("m-ffffffff", "desk")).toBe(true);
      expect(await s.setMachineNickname("m-ffffffff", "other")).toBe(true);
      expect(await s.listMachines()).toStrictEqual(before);
    });
  });

  // MM-2: machine labels on the hub machine row (AC-08).
  describe("MM-2 machine labels", () => {
    const A = { id: "example.org/team/a", name: "a" };
    const B = { id: "example.org/team/b", name: "b" };

    async function machines(s: HubStore): Promise<void> {
      await s.upsertIdentity({ provider: "oidc", subject: "1", name: "Ada", groups: [] }, T0);
      await s.upsertMachine({ id: "m1", userId: "ada", hostname: "one" }, T0);
      await s.upsertMachine({ id: "m2", userId: "ada", hostname: "two" }, T0);
      await s.touchMachine("m1", T0 + 1, { idle: 1 });
    }
    const labelsOf = async (s: HubStore, id: string) => (await s.getMachine(id))?.labels;

    it("test_AC08_schema_version_8", () => {
      expect(HubStore.SCHEMA_VERSION).toBe(10);
      expect(HUB_MIGRATIONS.length).toBe(10);
      expect(HUB_MIGRATIONS_PG.length).toBe(10);
    });

    it("test_AC08_set_and_get", async () => {
      const s = await store();
      await machines(s);
      await s.setMachineLabels("m1", ["gpu", "perf"]);
      expect(await labelsOf(s, "m1")).toStrictEqual(["gpu", "perf"]);
      expect((await s.listMachines()).find((m) => m.id === "m1")?.labels).toStrictEqual(["gpu", "perf"]);
      // The other machine is untouched.
      expect(await s.getMachine("m2")).not.toHaveProperty("labels");
    });

    it("test_AC08_clear_restores_row", async () => {
      const s = await store();
      await machines(s);
      const before = await s.getMachine("m1");
      expect(before).not.toHaveProperty("labels");
      await s.setMachineLabels("m1", ["gpu"]);
      expect(await labelsOf(s, "m1")).toStrictEqual(["gpu"]);
      await s.setMachineLabels("m1", []);
      const after = await s.getMachine("m1");
      expect(after).not.toHaveProperty("labels");
      expect(after).toStrictEqual(before);
    });

    it("test_AC08_keeps_other_fields", async () => {
      const s = await store();
      await machines(s);
      await s.touchMachine("m1", T0 + 2, { idle: 1 }, { share: "me", repos: [A] });
      expect(await s.setMachineNickname("m1", "desk")).toBe(true);
      const before = await s.getMachine("m1");
      expect(before).toMatchObject({ share: "me", repos: [A], reposAt: T0 + 2, nickname: "desk" });
      await s.setMachineLabels("m1", ["a"]);
      const after = await s.getMachine("m1");
      expect(after).toStrictEqual({ ...before, labels: ["a"] });
    });

    it("test_AC08_touch_keeps_labels", async () => {
      const s = await store();
      await machines(s);
      await s.touchMachine("m1", T0 + 2, { idle: 1 }, { share: "me", repos: [A] });
      await s.setMachineLabels("m1", ["a"]);
      await s.touchMachine("m1", T0 + 3, { idle: 2 }, { share: "all", repos: [B] });
      const row = await s.getMachine("m1");
      // Positive control: the touch ran.
      expect(row).toMatchObject({ share: "all", repos: [B], reposAt: T0 + 3, lastSeen: T0 + 3 });
      expect(row?.labels).toStrictEqual(["a"]);
      await s.touchMachine("m1", T0 + 4, { idle: 2 });
      expect(await labelsOf(s, "m1")).toStrictEqual(["a"]);
    });

    it("test_AC08_unknown_id_noop", async () => {
      const s = await store();
      await machines(s);
      const before = await s.listMachines();
      await expect(s.setMachineLabels("nope", ["a"])).resolves.toBeUndefined();
      expect(await s.getMachine("nope")).toBeUndefined();
      expect(await s.listMachines()).toStrictEqual(before);
      // Positive control: a known id is changed by the same call.
      await s.setMachineLabels("m2", ["a"]);
      expect(await labelsOf(s, "m2")).toStrictEqual(["a"]);
    });

    it("test_AC08_replace_not_merge", async () => {
      const s = await store();
      await machines(s);
      await s.setMachineLabels("m1", ["a", "b"]);
      expect(await labelsOf(s, "m1")).toStrictEqual(["a", "b"]);
      await s.setMachineLabels("m1", ["c"]);
      expect(await labelsOf(s, "m1")).toStrictEqual(["c"]);
    });
  });

  // MM-3: the accept policy on the machine row (AC-06), machine-wide messages.
  describe("MM-3 machine accept", () => {
    const A = { id: "example.org/team/a", name: "a" };
    const B = { id: "example.org/team/b", name: "b" };
    // Machine facts gain `accept` (not in the MM-2 type).
    type Facts = Parameters<HubStore["touchMachine"]>[3];
    const facts = (f: Record<string, unknown>) => f as Facts;

    async function machines(s: HubStore): Promise<void> {
      await s.upsertIdentity({ provider: "oidc", subject: "1", name: "Ada", groups: [] }, T0);
      await s.upsertMachine({ id: "m1", userId: "ada", hostname: "one" }, T0);
      await s.upsertMachine({ id: "m2", userId: "ada", hostname: "two" }, T0);
    }
    const acceptOf = async (s: HubStore, id: string) => ((await s.getMachine(id)) as { accept?: string[] } | undefined)?.accept;

    it("test_AC06_schema_version_8", () => {
      expect(HubStore.SCHEMA_VERSION).toBe(10);
      expect(HUB_MIGRATIONS.length).toBe(10);
      expect(HUB_MIGRATIONS_PG.length).toBe(10);
    });

    /** m1 with repos, labels, share and nickname, then an accept-only touch. */
    async function full(s: HubStore) {
      await machines(s);
      await s.touchMachine("m1", T0 + 1, { idle: 1 }, { share: "me", repos: [A] });
      await s.setMachineLabels("m1", ["gpu"]);
      expect(await s.setMachineNickname("m1", "desk")).toBe(true);
      const before = await s.getMachine("m1");
      expect(before).toMatchObject({ share: "me", repos: [A], reposAt: T0 + 1, labels: ["gpu"], nickname: "desk" });
      await s.touchMachine("m1", T0 + 2, { idle: 1 }, facts({ accept: ["self"] }));
      return before;
    }

    it("test_AC06_touch_with_accept_keeps_others", async () => {
      const s = await store();
      const before = await full(s);
      expect(await s.getMachine("m1")).toStrictEqual({ ...before, lastSeen: T0 + 2, accept: ["self"] });
      expect(((await s.listMachines()).find((m) => m.id === "m1") as { accept?: string[] }).accept).toStrictEqual(["self"]);
    });

    it("test_AC06_touch_repos_only_keeps_accept", async () => {
      const s = await store();
      await full(s);
      await s.touchMachine("m1", T0 + 3, { idle: 1 }, { repos: [B] });
      const row = await s.getMachine("m1");
      // Positive control: the touch ran.
      expect(row).toMatchObject({ repos: [B], reposAt: T0 + 3 });
      expect(await acceptOf(s, "m1")).toStrictEqual(["self"]);
      await s.touchMachine("m1", T0 + 4, { idle: 1 });
      expect(await acceptOf(s, "m1")).toStrictEqual(["self"]);
      // A new policy replaces the old one.
      await s.touchMachine("m1", T0 + 5, { idle: 1 }, facts({ accept: ["user:bea", "self"] }));
      expect(await acceptOf(s, "m1")).toStrictEqual(["user:bea", "self"]);
    });

    it("test_AC06_set_labels_keeps_accept", async () => {
      const s = await store();
      await full(s);
      await s.setMachineLabels("m1", ["a", "b"]);
      expect((await s.getMachine("m1"))?.labels).toStrictEqual(["a", "b"]);
      expect(await acceptOf(s, "m1")).toStrictEqual(["self"]);
    });

    it("test_AC06_nickname_keeps_accept", async () => {
      const s = await store();
      await full(s);
      expect(await s.setMachineNickname("m1", "lab")).toBe(true);
      expect((await s.getMachine("m1"))?.nickname).toBe("lab");
      expect(await acceptOf(s, "m1")).toStrictEqual(["self"]);
    });

    it("test_AC06_no_accept_no_key", async () => {
      const s = await store();
      await machines(s);
      await s.touchMachine("m2", T0 + 2, { idle: 1 }, { share: "me", repos: [A] });
      await s.touchMachine("m1", T0 + 2, { idle: 1 }, facts({ accept: ["self"] }));
      // Positive control: m1 has it; m2, never given one, has no key.
      expect(await acceptOf(s, "m1")).toStrictEqual(["self"]);
      const m2 = await s.getMachine("m2");
      expect(m2).not.toHaveProperty("accept");
      expect(m2).toStrictEqual({ id: "m2", userId: "ada", hostname: "two", lastSeen: T0 + 2, counts: { idle: 1 }, share: "me", repos: [A], reposAt: T0 + 2 });
    });

    it("test_AC06_machine_wide_message", async () => {
      const s = await store();
      await machines(s);
      const m = await s.addMessage({ toMachine: "m1", toSid: "", fromUser: "ada", kind: "offer", text: "MESH: offer", data: { step: "G1.a" } }, T0);
      await s.addMessage({ toMachine: "m1", toSid: "s1", fromUser: "ada", kind: "note", text: "to a session" }, T0 + 1);
      const inbox = await s.inbox("m1");
      expect(inbox.map((x) => x.text)).toEqual(["MESH: offer", "to a session"]);
      expect(inbox.find((x) => x.id === m.id)).toMatchObject({ toSid: "", kind: "offer", data: { step: "G1.a" } });
    });
  });

  // RL-1 AC-08: migration 8 (artifact and profile tables), artifacts, profiles, machine `headless`.
  describe("migration 8", () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- new store methods, read loosely
    const X = (s: HubStore): any => s;
    const A = { id: "example.org/team/a", name: "a" };
    type Facts = Parameters<HubStore["touchMachine"]>[3];
    const facts = (f: Record<string, unknown>) => f as Facts;
    const art = (id: string, over: Record<string, unknown> = {}) => ({
      id,
      goal: "G1",
      step: "G1.a",
      round: 1,
      kind: "report",
      mediaType: "text/markdown",
      bytes: 5,
      sha256: "0".repeat(64),
      redactions: 0,
      createdAt: T0,
      by: "ada",
      ...over,
    });

    it("test_AC08_version", () => {
      expect(HubStore.SCHEMA_VERSION).toBe(10);
      expect(HUB_MIGRATIONS.length).toBe(10);
      expect(HUB_MIGRATIONS_PG.length).toBe(10);
    });

    it("test_AC08_v7_migrates", async () => {
      const target = await d.fresh();
      const s1 = await HubStore.open(target);
      await s1.upsertIdentity({ provider: "oidc", subject: "1", name: "Ada", groups: [] }, T0);
      await s1.createGoal(goalInput("kept"));
      await s1.saveSteps([step("G1.a"), step("G1.b", { state: "done", holderUser: "ada", rounds: [{ n: 1, user: "ada", finishedAt: T0 + 5, outcome: "done", summary: "ok" }] })]);
      await s1.upsertMachine({ id: "m1", userId: "ada", hostname: "one" }, T0);
      await s1.touchMachine("m1", T0 + 1, { idle: 1 }, facts({ share: "me", repos: [A], accept: ["self"] }));
      await s1.setMachineLabels("m1", ["gpu"]);
      const pre = { goal: await s1.getGoal("G1"), a: await s1.getStep("G1.a"), b: await s1.getStep("G1.b"), m: await s1.getMachine("m1") };
      await s1.close();
      // Make it a v7 database: without the migration-8 tables and at version 7.
      const raw = await d.openDb(target, d.name === "sqlite" ? HUB_MIGRATIONS : HUB_MIGRATIONS_PG);
      await raw.run("DROP TABLE IF EXISTS artifact");
      await raw.run("DROP TABLE IF EXISTS profile");
      // RL-2: and without the migration-9 tables, which the store re-creates after migration 8.
      for (const t of ["review_record", "review_item", "item_history", "pulse_slot", "pulse"]) await raw.run(`DROP TABLE IF EXISTS ${t}`);
      await raw.run("UPDATE schema_version SET version = 7");
      await raw.close();
      const s = track(await HubStore.open(target));
      expect(await s.getGoal("G1")).toMatchObject({ id: "G1", title: "kept", ownerId: "ada" });
      expect(await s.getStep("G1.a")).toMatchObject({ id: "G1.a", state: "ready" });
      expect((await s.getStep("G1.b"))?.rounds).toStrictEqual([{ n: 1, user: "ada", finishedAt: T0 + 5, outcome: "done", summary: "ok" }]);
      expect(await s.getMachine("m1")).toMatchObject({ share: "me", repos: [A], labels: ["gpu"], accept: ["self"] });
      expect(await s.getGoal("G1")).toStrictEqual(pre.goal);
      expect(await s.getStep("G1.a")).toStrictEqual(pre.a);
      expect(await s.getStep("G1.b")).toStrictEqual(pre.b);
      expect(await s.getMachine("m1")).toStrictEqual(pre.m);
      expect(await X(s).listArtifacts({})).toStrictEqual([]);
      expect(await X(s).listProfiles()).toStrictEqual([]);
      const v = await s.db.get("SELECT version FROM schema_version");
      expect(Number((v as { version: number }).version)).toBe(10);
    });

    it("test_AC08_artifact_roundtrip", async () => {
      const s = await store();
      const a = art("a-01J0000000000000000000000A", { title: "T" });
      const text = Buffer.from("héllo ✓ \u0000 end", "utf8");
      await X(s).addArtifact(a, text);
      const got = await X(s).getArtifact(a.id);
      expect(got.artifact).toStrictEqual(a);
      expect(Buffer.isBuffer(got.content) || got.content instanceof Uint8Array).toBe(true);
      expect(Buffer.from(got.content).equals(text)).toBe(true);
      const big = Buffer.alloc(1_048_576);
      for (let i = 0; i < big.length; i++) big[i] = (i * 7919) % 256;
      const b = art("a-01J0000000000000000000000B", { bytes: big.length });
      await X(s).addArtifact(b, big);
      expect(Buffer.from((await X(s).getArtifact(b.id)).content).equals(big)).toBe(true);
      expect(await X(s).getArtifact("a-nope")).toBeUndefined();
    });

    it("test_AC08_list_filter_order", async () => {
      const s = await store();
      const rows = [
        art("a-5", { createdAt: T0 + 5 }),
        art("a-B", { createdAt: T0 + 1, round: 2 }),
        art("a-A", { createdAt: T0 + 1, round: 2 }),
        art("a-0", { createdAt: T0 }),
        art("a-g2", { goal: "G2", step: "G2.x", createdAt: T0 }),
        art("a-other", { step: "G1.b", createdAt: T0 + 2 }),
      ];
      for (const r of rows) await X(s).addArtifact(r, Buffer.from("x"));
      const ids = async (f: Record<string, unknown>) => ((await X(s).listArtifacts(f)) as { id: string }[]).map((x) => x.id);
      expect(await ids({ goal: "G1" })).toStrictEqual(["a-0", "a-A", "a-B", "a-other", "a-5"]);
      expect(await ids({ step: "G1.a" })).toStrictEqual(["a-0", "a-A", "a-B", "a-5"]);
      expect(await ids({ step: "G1.a", round: 2 })).toStrictEqual(["a-A", "a-B"]);
      expect(await ids({ goal: "G2" })).toStrictEqual(["a-g2"]);
      expect(await ids({})).toStrictEqual(["a-0", "a-g2", "a-A", "a-B", "a-other", "a-5"]);
    });

    it("test_AC08_prune", async () => {
      const s = await store();
      await X(s).addArtifact(art("a-1", { sha256: "1".repeat(64), createdAt: 100 }), Buffer.from("old"));
      await X(s).addArtifact(art("a-3", { createdAt: 300 }), Buffer.from("new"));
      await X(s).addArtifact(art("a-g2", { goal: "G2", step: "G2.x", createdAt: 100 }), Buffer.from("other"));
      expect(await X(s).pruneArtifacts(["G1"], 200, 999)).toBe(1);
      const old = await X(s).getArtifact("a-1");
      expect(old.content).toBeUndefined();
      expect(old.artifact.prunedAt).toBe(999);
      expect(old.artifact.sha256).toBe("1".repeat(64));
      // Positive control: the kept rows still have their content.
      expect(Buffer.from((await X(s).getArtifact("a-3")).content).toString()).toBe("new");
      expect(Buffer.from((await X(s).getArtifact("a-g2")).content).toString()).toBe("other");
      expect((await X(s).getArtifact("a-3")).artifact).not.toHaveProperty("prunedAt");
      expect(await X(s).pruneArtifacts(["G1"], 200, 1000)).toBe(0);
      expect((await X(s).getArtifact("a-1")).artifact.prunedAt).toBe(999);
      expect(await X(s).pruneArtifacts([], 10_000, 1000)).toBe(0);
    });

    it("test_AC08_profiles", async () => {
      const s = await store();
      const settings = { permissions: { allow: ["Read"], deny: ["Edit"] } };
      const p1 = { name: "p1", text: "extends: read-only\n", createdBy: "ada", updatedAt: T0, base: "read-only", sha256: "a".repeat(64), settings, description: "one" };
      const p2 = { ...p1, name: "p2", description: "two" };
      await X(s).saveProfile(p1);
      await X(s).saveProfile(p2);
      expect(await X(s).getProfile("p1")).toMatchObject(p1);
      expect(((await X(s).listProfiles()) as { name: string }[]).map((p) => p.name).sort()).toStrictEqual(["p1", "p2"]);
      await X(s).saveProfile({ ...p1, text: "extends: propose-via-branch\n", updatedAt: T0 + 9, base: "propose-via-branch", sha256: "b".repeat(64) });
      expect(await X(s).getProfile("p1")).toMatchObject({ name: "p1", text: "extends: propose-via-branch\n", updatedAt: T0 + 9, base: "propose-via-branch", sha256: "b".repeat(64), createdBy: "ada" });
      expect((await X(s).listProfiles()) as unknown[]).toHaveLength(2);
      expect(await X(s).getProfile("nope")).toBeUndefined();
    });

    it("test_AC08_machine_headless", async () => {
      const s = await store();
      await s.upsertIdentity({ provider: "oidc", subject: "1", name: "Ada", groups: [] }, T0);
      await s.upsertMachine({ id: "m1", userId: "ada", hostname: "one" }, T0);
      await s.touchMachine("m1", T0 + 1, { idle: 1 }, facts({ share: "me", repos: [A], accept: ["self"], headless: true }));
      await s.setMachineLabels("m1", ["gpu"]);
      expect(await s.getMachine("m1")).toMatchObject({ headless: true, accept: ["self"], repos: [A], labels: ["gpu"] });
      await s.touchMachine("m1", T0 + 2, { idle: 1 }, facts({ share: "me", repos: [A], accept: ["self"] }));
      expect(await s.getMachine("m1")).toMatchObject({ headless: true, accept: ["self"], repos: [A], labels: ["gpu"], lastSeen: T0 + 2 });
      await s.touchMachine("m1", T0 + 3, { idle: 1 });
      expect(await s.getMachine("m1")).toMatchObject({ headless: true, accept: ["self"], repos: [A], labels: ["gpu"] });
      await s.touchMachine("m1", T0 + 4, { idle: 1 }, facts({ headless: false }));
      expect(await s.getMachine("m1")).toMatchObject({ headless: false, accept: ["self"], repos: [A], labels: ["gpu"] });
    });
  });

  // RL-2 AC-08: migration 9 (review_record, review_item, item_history) and the review store methods.
  // Written from the spec's contracts only (docs/specs/RL-2.md); new methods are read loosely.
  describe("migration 9", () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- new store methods, read loosely
    const X = (s: HubStore): any => s;
    const fold = { new: 1, repeat: 0, regression: 0, resolved: 0, carried: 0 };
    const rv = (stepId: string, round: number, over: Record<string, unknown> = {}) => ({
      goal: stepId.split(".")[0] as string,
      step: stepId,
      round,
      lineage: "L",
      raising: true,
      complete: true,
      record: {
        subject: { commit: "c1" },
        coverage: "complete",
        assessment: "issues",
        items: [{ key: { rule: "I-03", path: "src/a.ts" }, title: "T", severity: "S2", category: "c", evidence: [], fp: "abcdefghijklmnop", mark: "new" }],
        dispositions: [],
        summary: "s",
      },
      fold,
      artifact: "a-01J0000000000000000000000R",
      undeclaredRules: 0,
      decider: { kind: "agent", key: "svc/auditor" },
      by: "ada",
      at: T0,
      ...over,
    });
    const itemRow = (fp: string, over: Record<string, unknown> = {}) => ({
      lineage: "L",
      fp,
      state: "open",
      rule: "I-03",
      path: "src/a.ts",
      title: "T",
      severity: "S2",
      category: "c",
      raisedBy: { key: "svc/auditor" },
      first: { goal: "G1", step: "G1.audit", round: 1, at: T0 },
      last: { goal: "G1", step: "G1.audit", round: 1, at: T0 },
      ...over,
    });
    const foldEntry = (goal: string, step: string, over: Record<string, unknown> = {}) => ({ at: T0, goal, step, round: 1, from: null, to: "open", kind: "fold", mark: "new", ...over });
    const dispEntry = (goal: string, step: string, over: Record<string, unknown> = {}) => ({
      at: T0 + 1,
      goal,
      step,
      round: 1,
      from: "open",
      to: "dismissed",
      kind: "disposition",
      disposition: "dismissed",
      reason: "not a bug",
      decider: { kind: "agent", key: "svc/validator", hash: "h1" },
      via: "stage",
      ...over,
    });

    it("test_AC08_version", () => {
      expect(HubStore.SCHEMA_VERSION).toBe(10);
      expect(HUB_MIGRATIONS.length).toBe(10);
      expect(HUB_MIGRATIONS_PG.length).toBe(10);
    });

    it("test_AC08_v8_migrates", async () => {
      const target = await d.fresh();
      const s1 = await HubStore.open(target);
      await s1.upsertIdentity({ provider: "oidc", subject: "1", name: "Ada", groups: [] }, T0);
      await s1.createGoal(goalInput("kept"));
      await s1.saveSteps([step("G1.a"), step("G1.b", { state: "done", holderUser: "ada", rounds: [{ n: 1, user: "ada", finishedAt: T0 + 5, outcome: "done", summary: "ok" }] })]);
      const art = { id: "a-01J0000000000000000000000A", goal: "G1", step: "G1.b", round: 1, kind: "report", mediaType: "text/markdown", bytes: 4, sha256: "0".repeat(64), redactions: 0, createdAt: T0, by: "ada" };
      await X(s1).addArtifact(art, Buffer.from("kept"));
      const prof = { name: "p1", text: "extends: read-only\n", createdBy: "ada", updatedAt: T0, base: "read-only", sha256: "a".repeat(64), settings: { permissions: { allow: ["Read"], deny: [] } } };
      await X(s1).saveProfile(prof);
      const pre = { goal: await s1.getGoal("G1"), a: await s1.getStep("G1.a"), b: await s1.getStep("G1.b"), art: await X(s1).getArtifact(art.id), prof: await X(s1).getProfile("p1") };
      await s1.close();
      // Make it a v8 database: without the migration-9 tables and at version 8.
      const raw = await d.openDb(target, d.name === "sqlite" ? HUB_MIGRATIONS : HUB_MIGRATIONS_PG);
      for (const t of ["review_record", "review_item", "item_history", "pulse_slot", "pulse"]) await raw.run(`DROP TABLE IF EXISTS ${t}`);
      await raw.run("UPDATE schema_version SET version = 8");
      await raw.close();
      const s = track(await HubStore.open(target));
      expect(await s.getGoal("G1")).toStrictEqual(pre.goal);
      expect(await s.getStep("G1.a")).toStrictEqual(pre.a);
      expect(await s.getStep("G1.b")).toStrictEqual(pre.b);
      const got = await X(s).getArtifact(art.id);
      expect(got.artifact).toStrictEqual(pre.art.artifact);
      expect(Buffer.from(got.content).toString()).toBe("kept");
      expect(await X(s).getProfile("p1")).toStrictEqual(pre.prof);
      expect(await X(s).listReviews({})).toStrictEqual([]);
      expect(await X(s).listItems("L")).toStrictEqual([]);
      expect(await X(s).itemHistory("L")).toStrictEqual([]);
      const v = await s.db.get("SELECT version FROM schema_version");
      expect(Number((v as { version: number }).version)).toBe(10);
    });

    it("test_AC08_addReview", async () => {
      const s = await store();
      const r1 = rv("G1.audit", 1);
      expect(await X(s).addReview(r1)).toBe(true);
      expect(await X(s).getReview("G1.audit", 1)).toStrictEqual(r1);
      expect(await X(s).addReview(rv("G1.audit", 1, { lineage: "M", at: T0 + 9, record: { ...r1.record, summary: "other" } }))).toBe(false);
      expect(await X(s).getReview("G1.audit", 1)).toStrictEqual(r1);
      expect(await X(s).listReviews({ step: "G1.audit" })).toHaveLength(1);
      // Another round of the same step is a new record.
      expect(await X(s).addReview(rv("G1.audit", 2))).toBe(true);
      expect(await X(s).getReview("G1.audit", 3)).toBeUndefined();
    });

    it("test_AC08_list_filters", async () => {
      const s = await store();
      await X(s).addReview(rv("G1.audit", 1));
      await X(s).addReview(rv("G1.validate", 1, { raising: false, fold: undefined }));
      await X(s).addReview(rv("G2.audit", 1, { complete: false }));
      await X(s).addReview(rv("H.audit", 1, { lineage: "M" }));
      const ids = async (f: Record<string, unknown>) => ((await X(s).listReviews(f)) as { step: string }[]).map((x) => x.step);
      expect(await ids({ step: "G1.audit" })).toStrictEqual(["G1.audit"]);
      expect(await ids({ lineage: "L" })).toStrictEqual(["G1.audit", "G1.validate", "G2.audit"]);
      expect(await ids({ lineage: "L", raising: true })).toStrictEqual(["G1.audit", "G2.audit"]);
      expect(await ids({ lineage: "L", raising: true, complete: true })).toStrictEqual(["G1.audit"]);
      expect(await ids({ raising: false })).toStrictEqual(["G1.validate"]);
      expect(await ids({ lineage: "M" })).toStrictEqual(["H.audit"]);
      expect(await ids({})).toStrictEqual(["G1.audit", "G1.validate", "G2.audit", "H.audit"]);
    });

    it("test_AC08_insertion_order", async () => {
      const s = await store();
      await X(s).addReview(rv("G10.audit", 1, { at: T0 + 10 }));
      await X(s).addReview(rv("G9.audit", 1, { at: T0 + 10 }));
      await X(s).addReview(rv("G1.audit", 1, { at: T0 }));
      const steps = ((await X(s).listReviews({ lineage: "L" })) as { step: string }[]).map((x) => x.step);
      expect(steps).toStrictEqual(["G10.audit", "G9.audit", "G1.audit"]);
    });

    it("test_AC08_items", async () => {
      const s = await store();
      const row = itemRow("abcdefghijklmnop");
      await X(s).saveItem(row);
      expect(await X(s).getItem("L", "abcdefghijklmnop")).toStrictEqual(row);
      const dismissed = { ...row, state: "dismissed", dismissedEh: "e".repeat(64), eh: "e".repeat(64) };
      await X(s).saveItem(dismissed);
      expect(await X(s).getItem("L", "abcdefghijklmnop")).toStrictEqual(dismissed);
      await X(s).saveItem(itemRow("qrstuvwxyz234567", { lineage: "M" }));
      const inL = (await X(s).listItems("L")) as { fp: string; state: string }[];
      expect(inL).toHaveLength(1);
      expect(inL[0]).toMatchObject({ fp: "abcdefghijklmnop", state: "dismissed" });
      expect(((await X(s).listItems("M")) as { fp: string }[]).map((x) => x.fp)).toStrictEqual(["qrstuvwxyz234567"]);
      expect(await X(s).getItem("L", "qrstuvwxyz234567")).toBeUndefined();
    });

    it("test_AC08_history_and_dispositions", async () => {
      const s = await store();
      const e1 = foldEntry("G1", "G1.audit");
      const e2 = dispEntry("G1", "G1.validate");
      const e3 = foldEntry("G2", "G2.audit", { mark: "new" });
      const e4 = dispEntry("G2", "G2.validate", { disposition: "confirmed", to: "confirmed", reason: "real", link: "https://tracker.invalid/1" });
      await X(s).addItemHistory("L", "x", e1);
      await X(s).addItemHistory("L", "x", e2);
      await X(s).addItemHistory("L", "y", e3);
      await X(s).addItemHistory("L", "y", e4);
      await X(s).addItemHistory("M", "x", foldEntry("H", "H.audit"));
      expect(await X(s).itemHistory("L", "x")).toStrictEqual([e1, e2]);
      expect(await X(s).itemHistory("L", "y")).toStrictEqual([e3, e4]);
      expect(await X(s).itemHistory("L")).toStrictEqual([e1, e2, e3, e4]);
      const rows = (await X(s).listDispositions({ lineage: "L" })) as Record<string, unknown>[];
      expect(rows).toHaveLength(2);
      expect(rows[0]).toMatchObject({ lineage: "L", fp: "x", goal: "G1", step: "G1.validate", round: 1, disposition: "dismissed", from: "open", reason: "not a bug", decider: { kind: "agent", key: "svc/validator", hash: "h1" }, via: "stage", at: T0 + 1 });
      expect(rows[1]).toMatchObject({ lineage: "L", fp: "y", goal: "G2", step: "G2.validate", disposition: "confirmed", link: "https://tracker.invalid/1" });
      const fps = async (f: Record<string, unknown>) => ((await X(s).listDispositions(f)) as { fp: string; step: string }[]).map((x) => `${x.fp}@${x.step}`);
      expect(await fps({ fp: "y" })).toStrictEqual(["y@G2.validate"]);
      expect(await fps({ goal: "G1" })).toStrictEqual(["x@G1.validate"]);
      expect(await fps({ step: "G2.validate" })).toStrictEqual(["y@G2.validate"]);
      expect(await fps({ lineage: "M" })).toStrictEqual([]);
    });
  });

  // RL-3 AC-05: pulses and slots (migration 10; docs/specs/RL-3.md, Hub store).
  describe("migration 10", () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- new store methods, read loosely
    const X = (s: HubStore): any => s;
    const HOUR = 3_600_000;
    const DAY = 86_400_000;
    /** A valid `Omit<Pulse, "id">`; an `undefined` override removes the key. */
    const pulseRow = (over: Record<string, unknown> = {}): Record<string, unknown> => {
      const p: Record<string, unknown> = {
        owner: "ada",
        title: "weekly on app",
        when: { every: "7d", anchor: T0 },
        preset: { name: "weekly", text: "steps: []\n", sha256: "a".repeat(64) },
        params: { repo: "example/app" },
        profiles: {},
        topics: [],
        target: {},
        windowMs: 4 * HOUR,
        overlap: "skip",
        maxGoalAgeMs: 14 * DAY,
        missed: "record",
        enabled: true,
        nextAt: T0 + 7 * DAY,
        version: 1,
        createdAt: T0,
        updatedAt: T0,
        ...over,
      };
      for (const k of Object.keys(p)) if (p[k] === undefined) delete p[k];
      return p;
    };
    const slot = (pulse: string, id: string, at: number, over: Record<string, unknown> = {}) => ({ pulse, slot: id, at, state: "fired", tried: [], decidedAt: at, ...over });
    const ids = (xs: { id: string }[]) => xs.map((x) => x.id);
    const slotIds = (xs: { slot: string }[]) => xs.map((x) => x.slot);

    it("test_AC05_version", () => {
      expect(HubStore.SCHEMA_VERSION).toBe(10);
      expect(HUB_MIGRATIONS.length).toBe(10);
      expect(HUB_MIGRATIONS_PG.length).toBe(10);
    });

    it("test_AC05_v9_upgrade", async () => {
      const target = await d.fresh();
      const s1 = await HubStore.open(target);
      await s1.upsertIdentity({ provider: "oidc", subject: "1", name: "Ada", groups: [] }, T0);
      await s1.createGoal(goalInput("kept"));
      await s1.saveSteps([step("G1.a"), step("G1.b", { state: "done", holderUser: "ada", rounds: [{ n: 1, user: "ada", finishedAt: T0 + 5, outcome: "done", summary: "ok" }] })]);
      const record = {
        goal: "G1",
        step: "G1.b",
        round: 1,
        lineage: "L",
        raising: true,
        complete: true,
        record: { subject: {}, coverage: "complete", assessment: "issues", items: [{ key: { rule: "I-03", path: "a.ts" }, title: "T", severity: "S2", category: "c", evidence: [], fp: "abcdefghijklmnop", mark: "new" }], dispositions: [], summary: "s" },
        fold: { new: 1, repeat: 0, regression: 0, resolved: 0, carried: 0 },
        artifact: "a-01J0000000000000000000000R",
        undeclaredRules: 0,
        decider: { kind: "agent", key: "app/auditor" },
        by: "ada",
        at: T0,
      };
      expect(await X(s1).addReview(record)).toBe(true);
      const item = { lineage: "L", fp: "abcdefghijklmnop", state: "open", rule: "I-03", path: "a.ts", title: "T", severity: "S2", category: "c", raisedBy: { key: "app/auditor" }, first: { goal: "G1", step: "G1.b", round: 1, at: T0 }, last: { goal: "G1", step: "G1.b", round: 1, at: T0 } };
      await X(s1).saveItem(item);
      await X(s1).addItemHistory("L", item.fp, { at: T0, goal: "G1", step: "G1.b", round: 1, from: null, to: "open", kind: "fold", mark: "new" });
      const pre = {
        goal: await s1.getGoal("G1"),
        a: await s1.getStep("G1.a"),
        b: await s1.getStep("G1.b"),
        reviews: await X(s1).listReviews({}),
        items: await X(s1).listItems("L"),
        history: await X(s1).itemHistory("L"),
      };
      await s1.close();
      // Make it a v9 database: without the migration-10 tables and at version 9.
      const raw = await d.openDb(target, d.name === "sqlite" ? HUB_MIGRATIONS : HUB_MIGRATIONS_PG);
      for (const t of ["pulse_slot", "pulse"]) await raw.run(`DROP TABLE IF EXISTS ${t}`);
      await raw.run("UPDATE schema_version SET version = 9");
      await raw.close();
      const s = track(await HubStore.open(target));
      expect(await s.getGoal("G1")).toStrictEqual(pre.goal);
      expect(await s.getStep("G1.a")).toStrictEqual(pre.a);
      expect(await s.getStep("G1.b")).toStrictEqual(pre.b);
      expect(await X(s).listReviews({})).toStrictEqual(pre.reviews);
      expect(await X(s).listItems("L")).toStrictEqual(pre.items);
      expect(await X(s).itemHistory("L")).toStrictEqual(pre.history);
      expect(pre.reviews).toHaveLength(1);
      expect(await X(s).listPulses()).toStrictEqual([]);
      expect((await X(s).createPulse(pulseRow())).id).toBe("p-1");
      const v = await s.db.get("SELECT version FROM schema_version");
      expect(Number((v as { version: number }).version)).toBe(10);
    });

    it("test_AC05_ids", async () => {
      const s = await store();
      const p1 = await X(s).createPulse(pulseRow());
      const p2 = await X(s).createPulse(pulseRow());
      expect([p1.id, p2.id]).toStrictEqual(["p-1", "p-2"]);
      expect(p1).toMatchObject({ ...pulseRow(), id: "p-1" });
      await X(s).savePulse(pulseRow({ id: "p-2", deletedAt: T0 + 1, enabled: false, nextAt: undefined }));
      expect((await X(s).createPulse(pulseRow())).id).toBe("p-3");
      expect(await X(s).getPulse("p-2")).toMatchObject({ id: "p-2", deletedAt: T0 + 1, enabled: false });
      expect(await X(s).getPulse("p-9")).toBeUndefined();
    });

    it("test_AC05_listPulses", async () => {
      const s = await store();
      await X(s).createPulse(pulseRow({ owner: "ann" }));
      await X(s).createPulse(pulseRow({ owner: "bob" }));
      await X(s).createPulse(pulseRow({ owner: "ann" }));
      await X(s).savePulse({ ...(await X(s).getPulse("p-2")), deletedAt: T0 + 1, enabled: false });
      expect(ids(await X(s).listPulses())).toStrictEqual(["p-1", "p-3"]);
      expect(ids(await X(s).listPulses({ owner: "ann" }))).toStrictEqual(["p-1", "p-3"]);
      expect(ids(await X(s).listPulses({ owner: "bob" }))).toStrictEqual([]);
      expect(ids(await X(s).listPulses({ deleted: true }))).toContain("p-2");
    });

    it("test_AC05_list_by_number", async () => {
      const s = await store();
      for (let i = 0; i < 11; i++) await X(s).createPulse(pulseRow());
      // By number, not by id text (p-10 after p-9).
      expect(ids(await X(s).listPulses())).toStrictEqual(Array.from({ length: 11 }, (_, i) => `p-${i + 1}`));
    });

    it("test_AC05_round_trip", async () => {
      const s = await store();
      const full = pulseRow({
        window: "2h",
        windowMs: 2 * HOUR,
        maxGoalAge: "3d",
        maxGoalAgeMs: 3 * DAY,
        pausedReason: "paused by ada",
        enabled: false,
        nextAt: undefined,
        topics: ["t"],
        target: { labels: ["gpu"], machines: ["m1"] },
        preset: { name: "weekly", text: "steps: []\n", sha256: "b".repeat(64), source: { repo: "app", commit: "c".repeat(40) } },
        profiles: { "read-only": { name: "read-only", base: "read-only", sha256: "d".repeat(64), settings: { permissions: { allow: ["Read"], deny: [] } } } },
        when: { cron: "0 9 * * 1", tz: "Europe/Berlin" },
      });
      const p = await X(s).createPulse(full);
      expect(await X(s).getPulse(p.id)).toStrictEqual({ ...full, id: p.id });
      const bare = await X(s).createPulse(pulseRow());
      const got = await X(s).getPulse(bare.id);
      expect(got).toStrictEqual({ ...pulseRow(), id: bare.id });
      for (const k of ["window", "maxGoalAge", "pausedReason", "deletedAt"]) expect(Object.hasOwn(got, k), k).toBe(false);
    });

    it("test_AC05_duePulses", async () => {
      const s = await store();
      const now = T0 + 7 * DAY;
      await X(s).createPulse(pulseRow({ nextAt: now }));
      await X(s).createPulse(pulseRow({ nextAt: now + 1 }));
      await X(s).createPulse(pulseRow({ enabled: false, nextAt: now - 1 }));
      await X(s).createPulse(pulseRow({ nextAt: now - 1 }));
      await X(s).savePulse({ ...(await X(s).getPulse("p-4")), deletedAt: now - 2 });
      await X(s).createPulse(pulseRow({ nextAt: undefined }));
      await X(s).createPulse(pulseRow({ nextAt: now - 5 }));
      expect(ids(await X(s).duePulses(now))).toStrictEqual(["p-1", "p-6"]);
    });

    it("test_AC05_addSlot", async () => {
      const s = await store();
      const s1 = slot("p-1", new Date(T0).toISOString(), T0, { goal: "G1", firedAt: T0, until: T0 + HOUR });
      expect(await X(s).addSlot(s1)).toBe(true);
      expect(await X(s).addSlot({ ...s1, state: "skipped", reason: "overlap" })).toBe(false);
      expect(await X(s).getSlot("p-1", s1.slot)).toStrictEqual(s1);
      // Another pulse may use the same slot id.
      expect(await X(s).addSlot({ ...s1, pulse: "p-2" })).toBe(true);
    });

    it("test_AC05_listSlots", async () => {
      const s = await store();
      const [sa, sb, sc, sd, se] = [0, 1, 2, 3, 4].map((i) => new Date(T0 + i * 1000).toISOString()) as [string, string, string, string, string];
      await X(s).addSlot(slot("p-1", sa, T0));
      await X(s).addSlot(slot("p-1", sb, T0 + 1, { state: "missed", reason: "no_machine" }));
      await X(s).addSlot(slot("p-1", sc, T0 + 2));
      await X(s).addSlot(slot("p-1", sd, T0 + 2));
      await X(s).addSlot(slot("p-2", se, T0 + 3));
      expect(slotIds(await X(s).listSlots({ pulse: "p-1" }))).toStrictEqual([sd, sc, sb, sa]);
      expect(slotIds(await X(s).listSlots({ pulse: "p-1", state: "missed" }))).toStrictEqual([sb]);
      expect(slotIds(await X(s).listSlots({ pulse: "p-1", limit: 2 }))).toStrictEqual([sd, sc]);
      expect(slotIds(await X(s).listSlots({}))).toStrictEqual([se, sd, sc, sb, sa]);
    });

    it("test_AC05_pending", async () => {
      const s = await store();
      const [sa, sb, sc, sd] = [0, 1, 2, 3].map((i) => new Date(T0 + i * 1000).toISOString()) as [string, string, string, string];
      const first = slot("p-1", sa, T0, { goal: "G1" });
      await X(s).addSlot(first);
      await X(s).addSlot(slot("p-1", sb, T0 + 1, { goal: "G2", startedAt: T0 + 2 }));
      await X(s).addSlot(slot("p-1", sc, T0 + 2, { state: "missed", reason: "no_machine" }));
      await X(s).addSlot(slot("p-1", sd, T0 + 3, { state: "skipped", reason: "overlap" }));
      expect(slotIds(await X(s).listSlots({ pending: true }))).toStrictEqual([sa]);
      await X(s).saveSlot({ ...first, startedAt: T0 + 9 });
      expect(await X(s).listSlots({ pending: true })).toStrictEqual([]);
      expect(await X(s).getSlot("p-1", sa)).toStrictEqual({ ...first, startedAt: T0 + 9 });
    });

    it("test_AC05_lock", async () => {
      const dialect = await import("./dialect.ts");
      expect(typeof (dialect.LOCKS as Record<string, unknown>).pulses).toBe("number");
      const s = await store();
      const made = await Promise.all([X(s).createPulse(pulseRow()), X(s).createPulse(pulseRow())]);
      expect(ids(made).sort()).toStrictEqual(["p-1", "p-2"]);
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
