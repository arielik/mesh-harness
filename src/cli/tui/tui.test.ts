// RL-4 AC-18 (unit): the TUI `o` panel with debriefs and decided entries, driven through `runTui` with
// a fake terminal (stdin/stdout) and a fake DaemonClient. Written from the spec's contracts only
// (docs/specs/RL-4.md, TUI): keys `⏎`, `d`, `u`, the cursor over offers, then debriefs, then decided
// entries, the status texts and the badge. Nothing here talks to a daemon, tmux or `claude`.

import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DaemonClient } from "../client.ts";
import { runTui } from "./tui.ts";

const FP = "abcdefghijklmn27";
const NOW = Date.now();
const DOWN = "\x1b[B";
const ENTER = "\r";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface Term {
  input: PassThrough & { isTTY?: boolean; setRawMode?: (b: boolean) => unknown; isRaw?: boolean };
  frames: string[];
  /** The text written since the last `mark()`, ANSI sequences removed. */
  since(): string;
  mark(): void;
  press(...keys: string[]): Promise<void>;
}

let restore: (() => void)[] = [];
afterEach(() => {
  for (const f of restore.splice(0).reverse()) f();
  vi.useRealTimers();
});

function fakeTerminal(): Term {
  const input = new PassThrough() as Term["input"];
  input.isTTY = true;
  input.isRaw = false;
  input.setRawMode = (b: boolean) => {
    input.isRaw = b;
    return input;
  };
  (input as unknown as { ref: () => void; unref: () => void }).ref = () => undefined;
  (input as unknown as { ref: () => void; unref: () => void }).unref = () => undefined;
  const frames: string[] = [];
  const out = process.stdout as unknown as Record<string, unknown>;
  const saved = { isTTY: out.isTTY, columns: out.columns, rows: out.rows };
  const stdinDesc = Object.getOwnPropertyDescriptor(process, "stdin");
  Object.defineProperty(process, "stdin", { configurable: true, get: () => input });
  out.isTTY = true;
  out.columns = 160;
  out.rows = 40;
  const wr = vi.spyOn(process.stdout, "write").mockImplementation(((chunk: string | Uint8Array) => {
    frames.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"));
    return true;
  }) as typeof process.stdout.write);
  restore.push(() => {
    wr.mockRestore();
    if (stdinDesc) Object.defineProperty(process, "stdin", stdinDesc);
    out.isTTY = saved.isTTY;
    out.columns = saved.columns;
    out.rows = saved.rows;
  });
  let from = 0;
  // eslint-disable-next-line no-control-regex -- strip terminal escapes
  const strip = (s: string) => s.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "").replace(/\x1b[()][A-Z0-9]/g, "");
  return {
    input,
    frames,
    since: () => strip(frames.slice(from).join("")),
    mark: () => {
      from = frames.length;
    },
    press: async (...keys: string[]) => {
      for (const k of keys) {
        input.write(k);
        await sleep(40);
      }
    },
  };
}

const offer = (step: string) => ({ step, goal: "G1", title: `title ${step}`, repo: "svc", kind: "implement", machine: "m-0000000b", to: "m2", by: "alice", at: NOW - 60_000, expiresAt: NOW + 29 * 60_000, auto: false });
const debrief = { step: "G2.debrief", goal: "G2", title: "Debrief the audit", repo: "svc", state: "ready", items: 3, read: false };
const decided = {
  lineage: "L",
  fp: FP,
  goal: "G2",
  step: "G2.debrief",
  round: 1,
  disposition: "accepted",
  from: "open",
  reason: "r",
  answer: "a",
  decider: { kind: "person", user: "alice" },
  via: "debrief-session",
  at: NOW - 1000,
  title: "Alpha leak",
  revertable: true,
};

interface Fake {
  client: DaemonClient;
  calls: { name: string; args: unknown[] }[];
  debriefs: ReturnType<typeof vi.fn>;
  revert: ReturnType<typeof vi.fn>;
}
function fakeClient(o: { debriefs?: () => Promise<unknown>; revert?: (step: string, fp: string) => Promise<unknown> } = {}): Fake {
  const calls: { name: string; args: unknown[] }[] = [];
  const rec =
    <T>(name: string, f: (...a: never[]) => Promise<T>) =>
    async (...a: unknown[]) => {
      calls.push({ name, args: a });
      return f(...(a as never[]));
    };
  const debriefs = vi.fn(o.debriefs ?? (async () => ({ debriefs: [debrief], decided: [decided] })));
  const revert = vi.fn(o.revert ?? (async () => ({ item: { fp: FP, state: "open" }, reverted: decided, note: { text: "n" } })));
  const client = {
    health: rec("health", async () => ({ ok: true, sessions: 0 })),
    sessions: rec("sessions", async () => ({ sessions: [], messages: [] })),
    reconcile: rec("reconcile", async () => ({ sessions: [], messages: [] })),
    status: rec("status", async () => ({ hub: { url: "http://hub.invalid", state: "online" }, version: "test" })),
    goals: rec("goals", async () => []),
    fleet: rec("fleet", async () => ({ machines: [] })),
    offers: rec("offers", async () => [offer("G1.a")]),
    accept: rec("accept", async () => ({ step: "G1.a", sid: "s1", message: "Accepted G1.a." })),
    decline: rec("decline", async () => ({ step: { id: "G1.a" } })),
    debriefs: async (...a: unknown[]) => {
      calls.push({ name: "debriefs", args: a });
      return debriefs();
    },
    revert: async (...a: unknown[]) => {
      calls.push({ name: "revert", args: a });
      return revert(...(a as [string, string]));
    },
  } as unknown as DaemonClient;
  return { client, calls, debriefs, revert };
}

/** Start the TUI on a fake terminal; returns the term and a stop function (q, then wait). */
async function start(f: Fake): Promise<{ t: Term; stop: () => Promise<void> }> {
  const t = fakeTerminal();
  const done = runTui(f.client, { header: "mesh test", env: {} });
  done.catch(() => undefined);
  await sleep(120);
  return {
    t,
    stop: async () => {
      t.input.write("q");
      await Promise.race([done.catch(() => 0), sleep(500)]);
    },
  };
}
const count = (f: Fake, name: string) => f.calls.filter((c) => c.name === name).length;

describe("RL-4 AC-18 TUI keys", () => {
  beforeEach(() => {
    restore = [];
  });

  it("test_AC18_panel_sections", async () => {
    const f = fakeClient();
    const { t, stop } = await start(f);
    t.mark();
    await t.press("o");
    await sleep(120);
    const text = t.since();
    await stop();
    expect(text).toContain("ASSIGNED TO YOU");
    expect(text).toContain("DEBRIEFS");
    expect(text).toContain("mesh debrief G2.debrief");
    expect(text).toContain("DECIDED IN DEBRIEF");
    expect(text).toContain(`${FP}  accepted (was open)  G2.debrief`);
    expect(count(f, "debriefs")).toBeGreaterThan(0);
  });

  it("test_AC18_u_reverts", async () => {
    const f = fakeClient();
    const { t, stop } = await start(f);
    await t.press("o");
    await sleep(120);
    const loadsBefore = count(f, "debriefs");
    t.mark();
    // Offer, debrief, decided: two moves down reach the decided entry.
    await t.press(DOWN, DOWN, "u");
    await sleep(150);
    const text = t.since();
    await stop();
    expect(f.revert).toHaveBeenCalledTimes(1);
    expect(f.revert).toHaveBeenCalledWith("G2.debrief", FP);
    expect(text).toContain(`Reverted ${FP} to open.`);
    expect(count(f, "debriefs")).toBeGreaterThan(loadsBefore);
  });

  it("test_AC18_u_error", async () => {
    const f = fakeClient({
      revert: async () => {
        throw new Error("boom");
      },
    });
    const { t, stop } = await start(f);
    await t.press("o");
    await sleep(120);
    t.mark();
    await t.press(DOWN, DOWN, "u");
    await sleep(150);
    const text = t.since();
    await stop();
    expect(f.revert).toHaveBeenCalledTimes(1);
    expect(text).toContain("boom");
    expect(text).not.toContain("Reverted");
  });

  it("test_AC18_enter_on_debrief", async () => {
    const f = fakeClient();
    const { t, stop } = await start(f);
    await t.press("o");
    await sleep(120);
    t.mark();
    await t.press(DOWN, ENTER);
    await sleep(120);
    const text = t.since();
    // `d` on the debrief and on the decided entry does nothing.
    await t.press("d", DOWN, "d");
    await sleep(120);
    const declinesOnOthers = count(f, "decline");
    // `u` on the debrief (not a decided entry) does not revert.
    await t.press("\x1b[A", "u");
    await sleep(120);
    const revertsOnDebrief = f.revert.mock.calls.length;
    await stop();
    expect(text).toContain("Start it with: mesh debrief G2.debrief");
    expect(count(f, "accept")).toBe(0);
    expect(declinesOnOthers).toBe(0);
    expect(revertsOnDebrief).toBe(0);
  });

  it("test_AC18_offer_keys_control", async () => {
    const f = fakeClient();
    const { t, stop } = await start(f);
    await t.press("o");
    await sleep(120);
    await t.press(ENTER);
    await sleep(120);
    await t.press("d");
    await sleep(120);
    await stop();
    expect(count(f, "accept")).toBe(1);
    expect(count(f, "decline")).toBe(1);
    expect(f.revert).not.toHaveBeenCalled();
  });

  it("test_AC18_debriefs_fail", async () => {
    let fail = true;
    const f = fakeClient({
      debriefs: async () => {
        if (fail) throw new Error("not logged in to a hub; run: mesh login");
        return { debriefs: [debrief], decided: [decided] };
      },
    });
    vi.useFakeTimers({ shouldAdvanceTime: true, toFake: ["setInterval", "clearInterval", "setTimeout", "clearTimeout", "Date"] });
    const { t, stop } = await start(f);
    t.mark();
    const header0 = t.since();
    await t.press("o");
    await sleep(120);
    const failed = t.since();
    expect(failed).toContain("ASSIGNED TO YOU");
    expect(failed).toContain(`title G1.a`);
    expect(failed).not.toContain("DEBRIEFS");
    expect(failed).not.toContain("DECIDED IN DEBRIEF");
    expect(failed).not.toContain("not logged in");
    // The next poll (every 5 s) tries again and shows them.
    fail = false;
    t.mark();
    await vi.advanceTimersByTimeAsync(5_500);
    await sleep(120);
    const ok = t.since();
    await stop();
    expect(ok).toContain("DEBRIEFS");
    expect(ok).toContain("DECIDED IN DEBRIEF");
    expect(header0).toBeDefined();
  });

  it("test_AC18_badge", async () => {
    // Sessions view: the badge counts offers + debriefs (1 + 1).
    const f = fakeClient();
    const { t, stop } = await start(f);
    await sleep(150);
    const text = t.since();
    await stop();
    expect(text).toContain("2 offered to you");
    // When debriefs() fails the badge counts offers only.
    const g = fakeClient({
      debriefs: async () => {
        throw new Error("hub offline");
      },
    });
    const s2 = await start(g);
    await sleep(150);
    const text2 = s2.t.since();
    await s2.stop();
    expect(text2).toContain("1 offered to you");
    expect(text2).not.toContain("2 offered to you");
  });
});
