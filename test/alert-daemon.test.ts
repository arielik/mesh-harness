// RL-25 AC-11, AC-12: the daemon shows machine-wide `alert` notices through `deps.notify` (one
// call per 2-second batch) and acks them with the configured channel set. A fake hub behind
// `deps.fetch` serves the inbox and records acks; `notify` is a fake. Written from the spec's
// contracts (docs/specs/RL-25.md, "Daemon").

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Daemon, DEFAULT_INTERVALS, defaultDeps } from "../src/daemon/index.ts";
import type { AgentEntry, DaemonConfig, InboxMessage, NotifyTarget } from "../src/protocol/index.ts";
import { DaemonStore } from "../src/store/index.ts";

const BATCH = 150;
const NOW = 2_000_000_000_000;
const HOUR = 3_600_000;
const CWD = "/work/alerts";

interface Rig {
  daemon: Daemon;
  inbox: InboxMessage[];
  acks: { id: number; state: string; method?: string }[];
  calls: { title: string; body: string; target: NotifyTarget | undefined; args: number }[];
  /** What `claude agents` lists (the reconciler marks these sessions interactive). */
  agents: AgentEntry[];
  /** Acks answered 500 (not taken) while > 0. */
  failAcks: number;
  now: number;
  pull(): Promise<void>;
}

const cleanups: (() => unknown)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function rig(notify: DaemonConfig["notify"], result: (() => unknown) | unknown = true): Promise<Rig> {
  const dir = mkdtempSync(join(tmpdir(), "mesh-alert-daemon-"));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  const credentialsPath = join(dir, "credentials.json");
  writeFileSync(credentialsPath, JSON.stringify({ hub: "http://hub.test", token: "t", user: { id: "ann", name: "ann", roles: ["member"] }, machine: "m-ann" }));
  const store = await DaemonStore.open(":memory:");
  const config = { port: 0, key: "k".repeat(32), notify, workspaceRoots: [], autopilot: "nudge", shareSessions: "steps", accept: ["self"], assignments: "deliver" } as DaemonConfig;
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  const r = { inbox: [], acks: [], calls: [], agents: [], failAcks: 0, now: NOW } as unknown as Rig;
  const daemon = new Daemon({
    config,
    store,
    credentialsPath,
    version: "test",
    deps: defaultDeps({
      harness: () => ({ hash: "h0", parts: { repo: "r0", user: "u0", plugins: "none", mesh: "test" } }),
      claudeVersion: async () => "2.1.318",
      scanRuns: () => [],
      listAgents: async () => r.agents,
      paste: async () => true,
      wakeBackground: async () => ({ ok: true }),
      notify: async (...a: [string, string, NotifyTarget?]) => {
        r.calls.push({ title: a[0], body: a[1], target: a[2], args: a.length });
        return typeof result === "function" ? (result as () => unknown)() : result;
      },
      now: () => r.now,
      repoForCwd: () => undefined,
      mtime: () => undefined,
      log: () => undefined,
      hubTimeoutMs: 1_000,
      fetch: (async (url: string | URL | Request, init?: RequestInit) => {
        const u = new URL(String(url));
        if (u.pathname === "/v1/inbox") return json({ messages: r.inbox });
        const ack = /^\/v1\/inbox\/(\d+)\/ack$/.exec(u.pathname);
        if (ack && typeof init?.body === "string") {
          const b = JSON.parse(init.body) as { state: string; method?: string };
          if (r.failAcks > 0) {
            r.failAcks--;
            return json({ error: "simulated" }, 500);
          }
          r.acks.push({ id: Number(ack[1]), state: b.state, ...(b.method !== undefined ? { method: b.method } : {}) });
          r.inbox = r.inbox.filter((m) => m.id !== Number(ack[1]));
          return json({ ok: true });
        }
        return json({});
      }) as typeof fetch,
    }),
    intervals: { reconcileMs: 0, transcriptMs: 0, tickMs: 0, deliveryMs: 0, alertBatchMs: BATCH } as never,
  });
  await daemon.start(0);
  cleanups.push(async () => {
    await daemon.stop();
    store.close();
  });
  r.daemon = daemon;
  r.pull = async () => {
    await daemon.link?.pullInbox();
  };
  return r;
}

let ids = 0;
function notice(text: string, o: { createdAt?: number; kind?: string } = {}): InboxMessage {
  return { id: ++ids, toSid: "", kind: o.kind ?? "alert", text, fromUser: "am", createdAt: o.createdAt ?? NOW - 60_000, data: { alert: { fingerprint: `fp-${ids}`, status: "firing", reminder: false, summary: text, startsAt: NOW - HOUR } } };
}

/** An interactive session (as the reconciler sees it) in tmux pane `%<pid>`, last active at `at`. */
async function session(r: Rig, pid: number, at: number): Promise<void> {
  r.now = at - 60_000;
  const hook = (kind: "SessionStart" | "UserPromptSubmit") =>
    r.daemon.handleHook(kind, { session_id: `claude-${pid}`, cwd: CWD, hook_event_name: kind, transcript_path: `/t/${pid}.jsonl`, ...(kind === "UserPromptSubmit" ? { prompt: "work" } : {}) }, { claudePid: String(pid), tmuxPane: `%${pid}` });
  hook("SessionStart");
  r.agents.push({ kind: "interactive", pid, cwd: CWD, sessionId: `claude-${pid}`, status: "idle" });
  await r.daemon.reconcile();
  r.now = at;
  hook("UserPromptSubmit");
}

async function until(cond: () => boolean, ms = 3_000): Promise<void> {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error("timed out");
    await sleep(10);
  }
}

describe("AC-11 batch and ack", () => {
  it("test_AC11_default_batch_is_2s", () => {
    expect((DEFAULT_INTERVALS as unknown as { alertBatchMs: number }).alertBatchMs).toBe(2_000);
  });

  it("test_AC11_two_notices_one_call", async () => {
    const r = await rig("desktop");
    await session(r, 101, NOW - 5_000);
    await session(r, 102, NOW - 1_000);
    await session(r, 103, NOW - 3_000);
    r.now = NOW;
    const a = notice("MESH ALERT CRIT: Plan G12 waits on you for 26 h");
    const b = notice("MESH ALERT WARN: second");
    r.inbox = [a, b];
    await r.pull();
    expect(r.calls).toStrictEqual([]);
    await sleep(BATCH / 3);
    expect(r.calls).toStrictEqual([]);
    await until(() => r.acks.length === 2);
    expect(r.calls).toHaveLength(1);
    expect(r.calls[0]).toMatchObject({ title: "mesh · 2 alerts", body: "CRIT: Plan G12 waits on you for 26 h (+1 more)" });
    // The live interactive session with the latest lastEventAt (it has a pane).
    expect(r.calls[0]?.target).toMatchObject({ pane: "%102" });
    expect(r.acks).toStrictEqual([
      { id: a.id, state: "delivered", method: "desktop" },
      { id: b.id, state: "delivered", method: "desktop" },
    ]);
  });

  it("test_AC11_both_method", async () => {
    const r = await rig("both");
    r.inbox = [notice("MESH ALERT CRIT: one")];
    await r.pull();
    await until(() => r.acks.length === 1);
    expect(r.calls[0]).toMatchObject({ title: "mesh · alert", body: "CRIT: one" });
    expect(r.acks[0]).toMatchObject({ state: "delivered", method: "both" });
  });

  it("test_AC11_ended_session_not_a_target", async () => {
    const r = await rig("terminal");
    await session(r, 201, NOW - 5_000);
    await session(r, 202, NOW - 1_000);
    r.now = NOW - 500;
    r.daemon.handleHook("SessionEnd", { session_id: "claude-202", cwd: CWD, hook_event_name: "SessionEnd", transcript_path: "/t/202.jsonl" }, { claudePid: "202", tmuxPane: "%202" });
    r.now = NOW;
    r.inbox = [notice("MESH ALERT resolved: done")];
    await r.pull();
    await until(() => r.acks.length === 1);
    expect(r.calls[0]).toMatchObject({ title: "mesh · alert", body: "resolved: done" });
    expect(r.calls[0]?.target).toMatchObject({ pane: "%201" });
    expect(r.acks[0]).toMatchObject({ state: "delivered", method: "terminal" });
  });

  it("test_AC11_repull_before_ack_taken", async () => {
    const r = await rig("desktop");
    const a = notice("MESH ALERT CRIT: once");
    r.inbox = [a];
    r.failAcks = 1;
    await r.pull();
    // A pull while it waits in the batch shows nothing more.
    await r.pull();
    await until(() => r.calls.length === 1);
    await sleep(BATCH + 50);
    expect(r.acks).toStrictEqual([]);
    expect(r.inbox.map((m) => m.id)).toStrictEqual([a.id]);
    // The hub still lists it: the ack is sent again, nothing is shown again.
    await r.pull();
    await until(() => r.acks.length === 1);
    await sleep(BATCH + 50);
    expect(r.calls).toHaveLength(1);
    expect(r.acks).toStrictEqual([{ id: a.id, state: "delivered", method: "desktop" }]);
  });
});

describe("AC-12 off, stale, failure, no target, late joiner", () => {
  it("test_AC12_notify_off", async () => {
    for (const off of ["off", false] as const) {
      const r = await rig(off);
      const a = notice("MESH ALERT CRIT: quiet");
      r.inbox = [a];
      await r.pull();
      await until(() => r.acks.length === 1);
      await sleep(BATCH + 50);
      expect(r.calls).toStrictEqual([]);
      expect(r.acks).toStrictEqual([{ id: a.id, state: "delivered", method: "off" }]);
    }
  });

  it("test_AC12_stale", async () => {
    const r = await rig("desktop");
    const old = notice("MESH ALERT CRIT: old", { createdAt: NOW - 25 * HOUR });
    r.inbox = [old];
    await r.pull();
    await until(() => r.acks.length === 1);
    await sleep(BATCH + 50);
    expect(r.calls).toStrictEqual([]);
    expect(r.acks).toStrictEqual([{ id: old.id, state: "delivered", method: "stale" }]);
  });

  it("test_AC12_notify_false_or_throws", async () => {
    for (const result of [
      false,
      () => {
        throw new Error("no notifier");
      },
    ]) {
      const r = await rig("desktop", result);
      const a = notice("MESH ALERT CRIT: x");
      r.inbox = [a];
      await r.pull();
      await until(() => r.acks.length === 1);
      expect(r.calls).toHaveLength(1);
      expect(r.acks).toStrictEqual([{ id: a.id, state: "failed", method: "no-channel" }]);
    }
  });

  it("test_AC12_no_target", async () => {
    const r = await rig("desktop");
    const a = notice("MESH ALERT CRIT: x");
    r.inbox = [a];
    await r.pull();
    await until(() => r.acks.length === 1);
    expect(r.calls).toHaveLength(1);
    expect(r.calls[0]?.target).toBeUndefined();
    expect(r.acks).toStrictEqual([{ id: a.id, state: "delivered", method: "desktop" }]);
  });

  it("test_AC12_late_joiner_in_window", async () => {
    const r = await rig("desktop");
    r.inbox = [notice("MESH ALERT CRIT: one"), notice("MESH ALERT CRIT: two")];
    await r.pull();
    await sleep(BATCH / 3);
    r.inbox.push(notice("MESH ALERT CRIT: three"));
    await r.pull();
    await until(() => r.acks.length === 3);
    await sleep(BATCH + 50);
    expect(r.calls).toHaveLength(1);
    expect(r.calls[0]).toMatchObject({ title: "mesh · 3 alerts", body: "CRIT: one (+2 more)" });
  });

  it("test_AC12_other_machine_wide_kinds_unknown", async () => {
    const r = await rig("desktop");
    const x = notice("something", { kind: "weird" });
    r.inbox = [x];
    await r.pull();
    await until(() => r.acks.length === 1);
    expect(r.acks).toStrictEqual([{ id: x.id, state: "failed", method: "unknown session" }]);
    expect(r.calls).toStrictEqual([]);
  });
});
