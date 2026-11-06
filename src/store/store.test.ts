import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { Session } from "../protocol/index.ts";
import { DaemonStore } from "./daemon-store.ts";
import { openDb, openSyncDb } from "./db.ts";

const dirs: string[] = [];
const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), "mesh-store-"));
  dirs.push(d);
  return d;
};
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const session = (sid: string, state: Session["state"] = "idle"): Session => ({
  sid,
  claudeSessionIds: ["c-" + sid],
  cwd: "/w",
  kind: "interactive",
  state,
  quiet: false,
  startedAt: 1,
  lastEventAt: 1,
  turns: 0,
  humanPrompts: 0,
  seenByReconciler: false,
});

describe("openDb migrations", () => {
  it("applies migrations from empty and records the version", async () => {
    const db = await openDb(":memory:", ["CREATE TABLE a (x INTEGER)", "ALTER TABLE a ADD COLUMN y TEXT"]);
    expect((await db.get<{ version: number }>("SELECT version FROM schema_version"))?.version).toBe(2);
    await db.run("INSERT INTO a (x, y) VALUES (1, 'z')");
    await db.close();
  });

  it("upgrades an existing database with data in place", async () => {
    const path = join(tmp(), "m.db");
    const v1 = await openDb(path, ["CREATE TABLE a (x INTEGER)"]);
    await v1.run("INSERT INTO a (x) VALUES (42)");
    await v1.close();
    const v2 = await openDb(path, ["CREATE TABLE a (x INTEGER)", "ALTER TABLE a ADD COLUMN y TEXT DEFAULT 'd'"]);
    expect(await v2.all("SELECT x, y FROM a")).toEqual([{ x: 42, y: "d" }]);
    await v2.close();
  });

  it("refuses a database from a newer version", async () => {
    const path = join(tmp(), "m.db");
    await (await openDb(path, ["CREATE TABLE a (x INTEGER)", "CREATE TABLE b (x INTEGER)"])).close();
    await expect(openDb(path, ["CREATE TABLE a (x INTEGER)"])).rejects.toThrow(/newer/);
  });

  it("rolls back a failed transaction", async () => {
    const db = await openDb(":memory:", ["CREATE TABLE a (x INTEGER)"]);
    await expect(
      db.transaction(async () => {
        await db.run("INSERT INTO a (x) VALUES (1)");
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    expect(await db.all("SELECT * FROM a")).toEqual([]);
    await db.close();
  });

  it("rolls back a failed transaction on the synchronous wrapper (daemon store)", async () => {
    const db = await openSyncDb(":memory:", ["CREATE TABLE a (x INTEGER)"]);
    expect(() =>
      db.transaction(() => {
        db.run("INSERT INTO a (x) VALUES (1)");
        throw new Error("boom");
      }),
    ).toThrow("boom");
    expect(db.all("SELECT * FROM a")).toEqual([]);
    db.close();
  });
});

describe("async Db on one SQLite connection", () => {
  const tick = () => new Promise<void>((ok) => setTimeout(ok, 1));

  it("never interleaves two transactions, and joins nested ones", async () => {
    const db = await openDb(":memory:", ["CREATE TABLE log (n INTEGER, what TEXT)"]);
    let n = 0;
    const writer = (name: string) =>
      db.transaction(async () => {
        await db.run("INSERT INTO log VALUES (?, ?)", n++, `${name}:begin`);
        await tick();
        await db.transaction(async () => db.run("INSERT INTO log VALUES (?, ?)", n++, `${name}:nested`));
        await tick();
        await db.run("INSERT INTO log VALUES (?, ?)", n++, `${name}:end`);
      });
    await Promise.all([writer("a"), writer("b"), writer("c")]);
    const rows = await db.all<{ what: string }>("SELECT what FROM log ORDER BY n");
    expect(rows.map((r) => r.what)).toEqual(["a:begin", "a:nested", "a:end", "b:begin", "b:nested", "b:end", "c:begin", "c:nested", "c:end"]);
    await db.close();
  });

  it("keeps calls from outside a transaction out of it: they wait, see only committed rows and survive its rollback", async () => {
    const db = await openDb(":memory:", ["CREATE TABLE a (x INTEGER)"]);
    let release!: () => void;
    const gate = new Promise<void>((ok) => (release = ok));
    const failing = db.transaction(async () => {
      await db.run("INSERT INTO a VALUES (1)");
      await gate;
      throw new Error("boom");
    });
    await tick();
    const outsideWrite = db.run("INSERT INTO a VALUES (2)");
    const outsideRead = db.all<{ x: number }>("SELECT x FROM a ORDER BY x");
    release();
    await expect(failing).rejects.toThrow("boom");
    await outsideWrite;
    expect(await outsideRead).toEqual([{ x: 2 }]);
    await db.close();
  });

  it("runs after-commit hooks only once committed, and drops them on rollback", async () => {
    const db = await openDb(":memory:", ["CREATE TABLE a (x INTEGER)"]);
    const seen: string[] = [];
    await db.transaction(async () => {
      await db.run("INSERT INTO a VALUES (1)");
      db.afterCommit(() => seen.push("committed"));
      await tick();
      expect(seen).toEqual([]);
    });
    await expect(
      db.transaction(async () => {
        db.afterCommit(() => seen.push("rolled back"));
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    await tick();
    expect(seen).toEqual(["committed"]);
    await db.close();
  });
});

describe("DaemonStore", () => {
  it("persists sessions across reopen", async () => {
    const path = join(tmp(), "daemon.db");
    const a = await DaemonStore.open(path);
    a.saveSessions([session("s1"), session("s2", "ended")], 10);
    a.saveSessions([{ ...session("s1"), state: "working" }], 11);
    a.close();
    const b = await DaemonStore.open(path);
    expect(b.loadSessions().map((s) => [s.sid, s.state])).toEqual([
      ["s1", "working"],
      ["s2", "ended"],
    ]);
    expect(b.pruneSessions(11)).toBe(1);
    expect(b.loadSessions().map((s) => s.sid)).toEqual(["s1"]);
    b.close();
  });

  it("queues, delivers and fails messages once", async () => {
    const st = await DaemonStore.open(":memory:");
    const m1 = st.queueMessage("s1", "hello", 5);
    const m2 = st.queueMessage("s1", "again", 6);
    expect(st.pendingMessages("s1").map((m) => m.text)).toEqual(["hello", "again"]);
    st.markDelivered(m1.id, "stop", 7);
    st.markDelivered(m1.id, "paste", 8);
    st.markFailed(m2.id, "gone");
    expect(st.message(m1.id)).toMatchObject({ state: "delivered", method: "stop", deliveredAt: 7 });
    expect(st.message(m2.id)).toMatchObject({ state: "failed", error: "gone" });
    expect(st.pendingMessages()).toEqual([]);
    st.close();
  });

  it("stores hook events and prunes old ones", async () => {
    const st = await DaemonStore.open(":memory:");
    st.appendHookEvent("s1", { kind: "Stop", at: 1, claudeSessionId: "c", cwd: "/w" });
    st.appendHookEvent("s1", { kind: "Stop", at: 9, claudeSessionId: "c", cwd: "/w" });
    expect(st.pruneHookEvents(5)).toBe(1);
    expect(st.hookEvents("s1").map((e) => e.at)).toEqual([9]);
    st.close();
  });
});
