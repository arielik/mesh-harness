import { request } from "node:http";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AgentEntry, DaemonConfig } from "../protocol/index.ts";
import { DaemonStore } from "../store/index.ts";
import { Daemon, defaultDeps, transcriptGuess, type DaemonDeps } from "./daemon.ts";

const FIX = join(import.meta.dirname, "..", "..", "test", "fixtures", "claude", "hooks");
const fixture = (name: string) => (JSON.parse(readFileSync(join(FIX, `${name}.json`), "utf8")) as { input: Record<string, unknown> }).input;

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- HTTP JSON bodies in assertions
type Json = any;

const KEY = "k".repeat(32);
const CONFIG: DaemonConfig = { port: 0, key: KEY, notify: true, workspaceRoots: [], autopilot: "nudge" };
const SID = "f92c48b0-49ed-4650-b8f7-c87574da1f2f";
const CWD = "/work/interactive";

interface Fakes {
  agents: AgentEntry[] | null;
  pastes: { pane: string; text: string }[];
  wakes: { bgId: string; text: string }[];
  notes: string[];
  now: number;
  /** What each tmux pane shows (absent: the pane is gone). */
  screens: Record<string, string>;
  mtimes: Record<string, number>;
}

let daemon: Daemon;
let store: DaemonStore;
let f: Fakes;
let ids = 0;

async function boot(existing?: DaemonStore) {
  store = existing ?? (await DaemonStore.open(":memory:"));
  const deps: DaemonDeps = defaultDeps({
        harness: () => ({ hash: "h0", parts: { repo: "r0", user: "u0", plugins: "none", mesh: "test" } }),
        claudeVersion: async () => "2.1.318",
        scanRuns: () => [],
    listAgents: async () => f.agents,
    paste: async (pane, text) => {
      f.pastes.push({ pane, text });
      return true;
    },
    wakeBackground: async (t, text) => {
      f.wakes.push({ bgId: t.bgId, text });
      return { ok: true };
    },
    notify: async (title, body) => f.notes.push(`${title}: ${body}`),
    now: () => f.now,
    newId: () => `sid-${++ids}`,
    repoForCwd: (cwd) => (cwd === CWD ? { id: "gitlab.lab/vpc/interactive", name: "interactive" } : undefined),
    mtime: (p) => f.mtimes[p],
    paneText: async (pane) => f.screens[pane],
    log: () => undefined,
  });
  daemon = new Daemon({ config: CONFIG, store, deps, intervals: { reconcileMs: 0, transcriptMs: 0, tickMs: 0, deliveryMs: 0 } });
  await daemon.start(0);
}

beforeEach(async () => {
  ids = 0;
  f = { agents: [], pastes: [], wakes: [], notes: [], now: 1_000_000, screens: {}, mtimes: {} };
  await boot();
});
afterEach(async () => {
  await daemon.stop();
});

function http(method: string, path: string, body?: unknown, headers: Record<string, string> = {}): Promise<{ status: number; json: Json }> {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? "" : JSON.stringify(body);
    const req = request(
      {
        host: "127.0.0.1",
        port: daemon.port,
        method,
        path,
        headers: { "x-mesh-key": KEY, "content-type": "application/json", "content-length": Buffer.byteLength(data), ...headers },
      },
      (res) => {
        let text = "";
        res.on("data", (c) => (text += c));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, json: text ? JSON.parse(text) : undefined }));
      },
    );
    req.on("error", reject);
    req.end(data);
  });
}

const post = (slug: string, input: Record<string, unknown>, headers: Record<string, string> = { "x-claude-pid": "4242", "x-tmux-pane": "%7" }) =>
  http("POST", `/mesh/hook/${slug}`, input, headers);
const sessions = async () => (await http("GET", "/local/sessions")).json.sessions as Json[];
const observe = async (entries: AgentEntry[] | null) => {
  f.agents = entries;
  await daemon.reconcile();
};
const live = (status: string, extra: Partial<AgentEntry> = {}): AgentEntry => ({ kind: "interactive", pid: 4242, cwd: CWD, sessionId: SID, status, ...extra });

describe("local API security (plan §6.1)", () => {
  it("rejects requests without the key", async () => {
    expect((await http("GET", "/local/health", undefined, { "x-mesh-key": "nope" })).status).toBe(401);
  });

  it("rejects browser requests (Origin header)", async () => {
    expect((await http("GET", "/local/health", undefined, { origin: "http://evil.example" })).status).toBe(403);
  });

  it("rejects a foreign Host (DNS rebinding)", async () => {
    expect((await http("GET", "/local/health", undefined, { host: "evil.example" })).status).toBe(403);
  });

  it("accepts a local request with the key", async () => {
    expect((await http("GET", "/local/health")).json).toMatchObject({ ok: true });
  });
});

describe("hooks → sessions", () => {
  it("tracks a session from real hook payloads and never stores prompt text", async () => {
    await post("session-start", fixture("interactive.SessionStart.startup"));
    let [s] = await sessions();
    expect(s).toMatchObject({ state: "idle", pid: 4242, pane: "%7", repo: { name: "interactive" } });

    await post("prompt", { ...fixture("interactive.UserPromptSubmit"), prompt: "a secret prompt" });
    [s] = await sessions();
    expect(s).toMatchObject({ state: "working", turns: 1, humanPrompts: 1 });
    expect(JSON.stringify(store.hookEvents(s.sid))).not.toContain("a secret prompt");

    await post("stop", { ...fixture("interactive.Stop.first"), last_assistant_message: "Keep the v4 fallback?" });
    [s] = await sessions();
    expect(s).toMatchObject({ state: "needs_you", needs: "question" });
    expect(f.notes).toEqual(["mesh · interactive: asks: Keep the v4 fallback?"]);
  });

  it("counts open sessions still on hooks from an older mesh", async () => {
    await post("session-start", fixture("interactive.SessionStart.startup"));
    expect((await http("GET", "/local/status")).json.oldHooks).toBe(1);
    await post("prompt", fixture("interactive.UserPromptSubmit"), { "x-claude-pid": "4242", "x-mesh-hooks": "2", "x-mesh-at": `${Date.now()}000000` });
    expect((await http("GET", "/local/status")).json.oldHooks).toBe(0);
  });

  it("rejects malformed hook input and unknown hooks", async () => {
    expect((await post("stop", { nope: 1 })).status).toBe(400);
    expect((await post("pre-tool-use", fixture("interactive.Stop.first"))).status).toBe(404);
  });

  it("notifies once per needs-you episode", async () => {
    await post("session-start", fixture("interactive.SessionStart.startup"));
    await post("notification", fixture("interactive.Notification.permission_prompt"));
    await observe([live("waiting", { waitingFor: "permission prompt" })]);
    expect(f.notes).toHaveLength(1);
    expect(f.notes[0]).toContain("permission");
  });

  it("survives a restart", async () => {
    await post("session-start", fixture("interactive.SessionStart.startup"));
    await daemon.stop();
    await boot(store);
    expect((await sessions()).map((s) => s.pid)).toEqual([4242]);
  });
});

describe("message delivery (plan §6.4)", () => {
  it("delivers through the Stop hook when the session is working (S1)", async () => {
    await post("session-start", fixture("interactive.SessionStart.startup"));
    await post("prompt", fixture("interactive.UserPromptSubmit"));
    const said = await http("POST", "/local/say", { target: "interactive", text: "also run the linter" });
    expect(said.json.message.state).toBe("pending");
    const r1 = await post("stop", fixture("interactive.Stop.first"));
    expect(r1.json).toEqual({ hookSpecificOutput: { hookEventName: "Stop", additionalContext: "also run the linter" } });
    expect(store.message(said.json.message.id)).toMatchObject({ state: "delivered", method: "stop" });
    const r2 = await post("stop", fixture("interactive.Stop.continued"));
    expect(r2.json).toEqual({});
    expect(f.pastes).toEqual([]);
  });

  it("pastes into an idle pane once the reconciler confirms the prompt is free (S8)", async () => {
    await post("session-start", fixture("interactive.SessionStart.startup"));
    await observe([live("idle")]);
    await http("POST", "/local/say", { target: "interactive", text: "continue with the tests" });
    await new Promise((r) => setTimeout(r, 20));
    expect(f.pastes).toEqual([{ pane: "%7", text: "continue with the tests" }]);
    // The resulting prompt is mesh's, not a human's.
    await post("prompt", { ...fixture("interactive.UserPromptSubmit"), prompt: "continue with the tests" });
    const [s] = await sessions();
    expect(s).toMatchObject({ turns: 1, humanPrompts: 0, state: "working" });
  });

  it("never types while a permission dialog is open", async () => {
    await post("session-start", fixture("interactive.SessionStart.startup"));
    await observe([live("waiting", { waitingFor: "permission prompt" })]);
    await http("POST", "/local/say", { target: "interactive", text: "hello" });
    await new Promise((r) => setTimeout(r, 20));
    expect(f.pastes).toEqual([]);
    await observe([live("idle")]);
    expect(f.pastes).toEqual([{ pane: "%7", text: "hello" }]);
  });

  it("does not paste without a fresh observation", async () => {
    await post("session-start", fixture("interactive.SessionStart.startup"));
    await observe([live("idle")]);
    f.now += 60_000;
    f.agents = null; // reconciler unavailable
    await http("POST", "/local/say", { target: "interactive", text: "hello" });
    await daemon.deliverPending();
    expect(f.pastes).toEqual([]);
  });

  it("wakes an idle background session in place (S4)", async () => {
    await observe([{ kind: "background", id: "93474861", sessionId: "bg-1", cwd: CWD, state: "done", pid: 999, status: "idle" }]);
    await http("POST", "/local/say", { target: "93474861", text: "now write the docs" });
    await new Promise((r) => setTimeout(r, 20));
    expect(f.wakes).toEqual([{ bgId: "93474861", text: "now write the docs" }]);
  });

  it("fails pending messages when the session's process disappears", async () => {
    await post("session-start", fixture("interactive.SessionStart.startup"));
    await observe([live("busy")]);
    const said = await http("POST", "/local/say", { target: "interactive", text: "x" });
    await observe([]);
    expect(store.message(said.json.message.id)).toMatchObject({ state: "failed", error: "session ended" });
  });

  it("returns 404 for an unknown target", async () => {
    expect((await http("POST", "/local/say", { target: "nothing", text: "x" })).status).toBe(404);
  });
});

describe("windows mesh run opened", () => {
  const TRUST = "Quick safety check: Is this a project you created or one you trust?\n❯ No, exit\n  Yes, I trust this folder";

  it("lists a window waiting at the trust prompt as needing you, then hands it to the real session", async () => {
    f.screens["%7"] = TRUST;
    const r = await http("POST", "/local/launch", { pane: "%7", cwd: CWD, name: "interactive·G1.design", step: "G1.design" });
    expect(r.status).toBe(200);
    let [s] = await sessions();
    expect(s).toMatchObject({ launching: true, state: "needs_you", needs: "dialog", pane: "%7", step: "G1.design" });
    expect(f.notes).toEqual(["mesh · interactive·G1.design: accept Claude's folder trust prompt"]);

    await post("session-start", fixture("interactive.SessionStart.startup"));
    const all = await sessions();
    expect(all).toHaveLength(1);
    [s] = all;
    expect(s.sid).toBe(r.json.session.sid);
    expect(s.launching).toBeUndefined();
    expect(s).toMatchObject({ state: "idle", pid: 4242, step: "G1.design" });
  });

  it("drops the placeholder when its window closes before Claude starts", async () => {
    f.screens["%7"] = TRUST;
    await http("POST", "/local/launch", { pane: "%7", cwd: CWD });
    delete f.screens["%7"];
    await observe([]);
    expect(await sessions()).toEqual([]);
  });

  it("rejects a malformed launch", async () => {
    expect((await http("POST", "/local/launch", { pane: "7", cwd: CWD })).status).toBe(400);
  });
});

describe("sessions that started before mesh setup", () => {
  it("finds the transcript where Claude Code keeps it", () => {
    const s = { cwd: "/home/u/src/my.repo", claudeSessionIds: ["old", "c1"] } as Json;
    expect(transcriptGuess(s, "/home/u/.claude")).toBe("/home/u/.claude/projects/-home-u-src-my-repo/c1.jsonl");
    expect(transcriptGuess({ cwd: "/x", claudeSessionIds: [] } as Json, "/h")).toBeUndefined();
  });

  it("tracks their transcript's activity without any hook", async () => {
    await observe([live("busy")]);
    const path = transcriptGuess((await sessions())[0], process.env.CLAUDE_CONFIG_DIR ?? join(process.env.HOME ?? "", ".claude")) as string;
    f.mtimes[path] = f.now - 60_000;
    daemon.checkTranscripts();
    const [s] = await sessions();
    expect(s).toMatchObject({ state: "working", transcriptMtime: f.now - 60_000 });
    expect(s.hooksVersion).toBeUndefined();
  });
});
