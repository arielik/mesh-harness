import { request } from "node:http";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { fakeCheckout, fakeWorktree } from "../../test/helpers/git-tree.ts";
import type { AgentEntry, DaemonConfig } from "../protocol/index.ts";
import { DaemonStore } from "../store/index.ts";
import { Daemon, defaultDeps, transcriptGuess, type DaemonDeps } from "./daemon.ts";

const FIX = join(import.meta.dirname, "..", "..", "test", "fixtures", "claude", "hooks");
const fixture = (name: string) => (JSON.parse(readFileSync(join(FIX, `${name}.json`), "utf8")) as { input: Record<string, unknown> }).input;

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- HTTP JSON bodies in assertions
type Json = any;

const KEY = "k".repeat(32);
const CONFIG = { port: 0, key: KEY, notify: true, workspaceRoots: [], autopilot: "nudge", shareSessions: "steps", accept: ["self"], assignments: "deliver" } as DaemonConfig;
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
  /** Every line the daemon logged. */
  logs: string[];
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
    log: (l) => void f.logs.push(l),
  });
  daemon = new Daemon({ config: CONFIG, store, deps, intervals: { reconcileMs: 0, transcriptMs: 0, tickMs: 0, deliveryMs: 0 } });
  await daemon.start(0);
}

beforeEach(async () => {
  ids = 0;
  f = { agents: [], pastes: [], wakes: [], notes: [], now: 1_000_000, screens: {}, mtimes: {}, logs: [] };
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

// ---------------------------------------------------------------------------------------------
// MM-2: labels (AC-03 repo default, AC-04 remembered per checkout, AC-05 POST /local/labels,
// AC-06 no hub → no `unknown`).

describe("labels", () => {
  // Copied from the spec, not imported, so a changed text turns the tests red.
  const RULE = "a label is 1-40 characters: lowercase letters, digits, '.', '_' or '-', starting with a letter or digit";
  const BAD_BODY = "expected {target, labels, mode: set|add|rm} or {cwd, labels}";
  const L = (n: number) => Array.from({ length: n }, (_, i) => `l${String(i + 1).padStart(2, "0")}`);

  const roots: string[] = [];
  afterEach(() => {
    for (const d of roots.splice(0)) rmSync(d, { recursive: true, force: true });
  });
  const tmp = () => {
    const d = realpathSync(mkdtempSync(join(tmpdir(), "mesh-labels-")));
    roots.push(d);
    return d;
  };
  /** A checkout (a `.git` folder) with `.mesh/agent.yaml` holding `yaml` when given. */
  const checkout = (yaml?: string, dir = join(tmp(), "repo")) => {
    fakeCheckout(dir);
    if (yaml !== undefined) agentYaml(dir, yaml);
    return dir;
  };
  const agentYaml = (dir: string, yaml: string) => {
    mkdirSync(join(dir, ".mesh"), { recursive: true });
    writeFileSync(join(dir, ".mesh", "agent.yaml"), yaml);
  };
  const sub = (dir: string, ...parts: string[]) => {
    const d = join(dir, ...parts);
    mkdirSync(d, { recursive: true });
    return d;
  };

  let pids = 5000;
  /** A SessionStart hook from a new session in `cwd`; returns the recorded session. */
  async function hookAt(cwd: string, pid = ++pids): Promise<Json> {
    const r = await post(
      "session-start",
      { session_id: `claude-${pid}`, cwd, hook_event_name: "SessionStart", transcript_path: `/t/${pid}.jsonl`, source: "startup" },
      { "x-claude-pid": String(pid), "x-tmux-pane": `%${pid}` },
    );
    expect(r.status).toBe(200);
    const s = (await sessions()).find((x) => x.pid === pid);
    expect(s, `session for pid ${pid} recorded`).toBeDefined();
    return s;
  }
  const byPid = async (pid: number) => (await sessions()).find((x) => x.pid === pid);
  const bySid = async (sid: string) => (await sessions()).find((x) => x.sid === sid);
  const labelsCall = (body: unknown) => http("POST", "/local/labels", body);
  const label = (target: string, labels: string[], mode: string) => labelsCall({ target, labels, mode });
  const remember = (cwd: string, labels: string[]) => labelsCall({ cwd, labels });

  describe("AC-03 repo default from .mesh/agent.yaml", () => {
    it("test_AC03_repo_default_at_top", async () => {
      const c = checkout("labels: [Perf, dataplane]\n");
      const s = await hookAt(c);
      expect(s.labels).toStrictEqual(["dataplane", "perf"]);
    });

    it("test_AC03_repo_default_from_subfolder", async () => {
      const c = checkout("labels: [Perf, dataplane]\n");
      const s = await hookAt(sub(c, "a", "b"));
      expect(s.labels).toStrictEqual(["dataplane", "perf"]);
    });

    it("test_AC03_other_keys_ignored", async () => {
      const c = checkout("labels: [x]\nowner: someone\n");
      expect((await hookAt(c)).labels).toStrictEqual(["x"]);
    });

    it("test_AC03_no_file", async () => {
      const c = checkout();
      const s = await hookAt(c);
      expect(s.state).toBe("idle");
      expect(Object.hasOwn(s, "labels")).toBe(false);
    });

    it.each([
      ["test_AC03_invalid_yaml", "labels: [a,\n"],
      ["test_AC03_labels_not_a_list", 'labels: "x"\n'],
      ["test_AC03_bad_label_in_file", 'labels: ["bad label"]\n'],
      ["test_AC03_too_many_in_file", `labels: [${L(11).join(", ")}]\n`],
    ])("%s", async (_name, yaml) => {
      const c = checkout(yaml);
      const file = join(c, ".mesh", "agent.yaml");
      const s = await hookAt(c);
      expect(s.state).toBe("idle");
      expect(Object.hasOwn(s, "labels"), JSON.stringify(s.labels)).toBe(false);
      expect(f.logs.filter((l) => l.includes(file))).toHaveLength(1);
      // Positive control: a valid file in a fresh checkout is read by the same daemon.
      const good = checkout("labels: [ok]\n");
      expect((await hookAt(good)).labels).toStrictEqual(["ok"]);
    });

    it("test_AC03_not_a_checkout", async () => {
      const dir = tmp();
      agentYaml(dir, "labels: [x]\n");
      const s = await hookAt(dir);
      expect(Object.hasOwn(s, "labels")).toBe(false);
    });
  });

  describe("AC-04 remembered labels per checkout", () => {
    it("test_AC04_cwd_answer_is_checkout_top", async () => {
      const c = checkout("labels: [perf]\n");
      const r = await remember(sub(c, "sub"), ["GPU"]);
      expect(r.status).toBe(200);
      expect(r.json.cwd).toBe(c);
      expect(r.json.labels).toStrictEqual(["gpu"]);
      expect(Object.hasOwn(r.json, "unknown")).toBe(false);
    });

    it("test_AC04_cwd_outside_checkout_key_is_cwd", async () => {
      const d = tmp();
      const r = await remember(d, ["a"]);
      expect(r.status).toBe(200);
      expect(r.json).toMatchObject({ cwd: d, labels: ["a"] });
      // A new session in that folder gets the list.
      expect((await hookAt(d)).labels).toStrictEqual(["a"]);
    });

    it("test_AC04_cwd_invalid_400", async () => {
      const c = checkout("labels: [perf]\n");
      expect(await remember(c, ["bad label"])).toEqual({ status: 400, json: { error: `not a label: bad label (${RULE})` } });
      expect((await hookAt(c)).labels).toStrictEqual(["perf"]);
    });

    it("test_AC04_new_session_gets_remembered", async () => {
      const c = checkout("labels: [perf]\n");
      expect((await remember(sub(c, "sub"), ["GPU"])).status).toBe(200);
      expect((await hookAt(sub(c, "other"))).labels).toStrictEqual(["gpu"]);
      expect((await hookAt(c)).labels).toStrictEqual(["gpu"]);
    });

    it("test_AC04_launch_placeholder_gets_remembered", async () => {
      const c = checkout("labels: [perf]\n");
      expect((await remember(c, ["gpu"])).status).toBe(200);
      f.screens["%77"] = "starting";
      const r = await http("POST", "/local/launch", { pane: "%77", cwd: c, name: "repo·x" });
      expect(r.status).toBe(200);
      expect(r.json.session.labels).toStrictEqual(["gpu"]);
      expect((await bySid(r.json.session.sid)).labels).toStrictEqual(["gpu"]);
      // Its first hook adopts it; the labels stay.
      await post("session-start", { session_id: "claude-77", cwd: c, hook_event_name: "SessionStart", transcript_path: "/t/77.jsonl", source: "startup" }, { "x-claude-pid": "77", "x-tmux-pane": "%77" });
      const adopted = await byPid(77);
      expect(adopted.sid).toBe(r.json.session.sid);
      expect(adopted.launching).toBeUndefined();
      expect(adopted.labels).toStrictEqual(["gpu"]);
    });

    it("test_AC04_worktree_is_own_checkout", async () => {
      const root = tmp();
      const c = checkout("labels: [perf]\n", join(root, "main"));
      const wt = fakeWorktree(join(root, "wt"), join(c, ".git", "worktrees", "wt"), "https://example.org/team/repo.git");
      agentYaml(wt, "labels: [wt]\n");
      expect((await remember(c, ["gpu"])).status).toBe(200);
      expect((await hookAt(wt)).labels).toStrictEqual(["wt"]);
      // Positive control: the main checkout got the remembered list.
      expect((await hookAt(c)).labels).toStrictEqual(["gpu"]);
    });

    it("test_AC04_live_session_keeps_labels", async () => {
      const c = checkout("labels: [perf]\n");
      const s = await hookAt(c);
      expect(s.labels).toStrictEqual(["perf"]);
      expect((await remember(c, ["gpu"])).status).toBe(200);
      expect((await bySid(s.sid)).labels).toStrictEqual(["perf"]);
    });

    it("test_AC04_empty_remembered_beats_file", async () => {
      const c = checkout("labels: [perf]\n");
      expect((await hookAt(c)).labels).toStrictEqual(["perf"]);
      const r = await remember(c, []);
      expect(r.status).toBe(200);
      expect(r.json.labels).toStrictEqual([]);
      expect(Object.hasOwn(await hookAt(c), "labels")).toBe(false);
    });

    it("test_AC04_survives_restart", async () => {
      const c = checkout("labels: [perf]\n");
      const path = join(tmp(), "daemon.db");
      await daemon.stop();
      const first = await DaemonStore.open(path);
      await boot(first);
      expect((await remember(c, ["gpu"])).status).toBe(200);
      await daemon.stop();
      first.close();
      const second = await DaemonStore.open(path);
      await boot(second);
      expect((await hookAt(c)).labels).toStrictEqual(["gpu"]);
    });

    it("test_AC04_no_session_change", async () => {
      const c = checkout("labels: [perf]\n");
      await hookAt(c);
      await hookAt(sub(c, "x"));
      const before = await sessions();
      expect((await remember(c, ["gpu"])).status).toBe(200);
      expect(await sessions()).toStrictEqual(before);
    });
  });

  describe("AC-05 POST /local/labels with a target", () => {
    async function two() {
      const c = checkout("labels: [perf]\n");
      const s1 = await hookAt(c);
      const s2 = await hookAt(sub(c, "s2"));
      expect(s1.labels).toStrictEqual(["perf"]);
      expect(s2.labels).toStrictEqual(["perf"]);
      return { c, s1, s2 };
    }

    it("test_AC05_set_add_rm_sequence", async () => {
      const { s1 } = await two();
      const steps: [string[], string, string[]][] = [
        [["b", "a"], "set", ["a", "b"]],
        [["c"], "add", ["a", "b", "c"]],
        [["a", "x"], "rm", ["b", "c"]],
      ];
      for (const [labels, mode, want] of steps) {
        const r = await label(s1.sid, labels, mode);
        expect(r.status, mode).toBe(200);
        expect(r.json.session.sid).toBe(s1.sid);
        expect(r.json.session.labels).toStrictEqual(want);
        expect((await bySid(s1.sid)).labels).toStrictEqual(want);
      }
    });

    it("test_AC05_set_empty_removes_key", async () => {
      const { s1 } = await two();
      const r = await label(s1.sid, [], "set");
      expect(r.status).toBe(200);
      expect(Object.hasOwn(r.json.session, "labels")).toBe(false);
      expect(Object.hasOwn(await bySid(s1.sid), "labels")).toBe(false);
    });

    it("test_AC05_add_normalises", async () => {
      const { s1 } = await two();
      const r = await label(s1.sid, ["Z "], "add");
      expect(r.status).toBe(200);
      expect(r.json.session.labels).toStrictEqual(["perf", "z"]);
    });

    it("test_AC05_remembered_for_checkout", async () => {
      const { c, s1 } = await two();
      expect((await label(s1.sid, ["b", "a"], "set")).status).toBe(200);
      expect((await hookAt(sub(c, "later"))).labels).toStrictEqual(["a", "b"]);
    });

    it("test_AC05_other_session_unchanged", async () => {
      const { s1, s2 } = await two();
      await label(s1.sid, ["b", "a"], "set");
      await label(s1.sid, ["c"], "add");
      await label(s1.sid, ["a", "x"], "rm");
      expect((await bySid(s1.sid)).labels).toStrictEqual(["b", "c"]);
      expect((await bySid(s2.sid)).labels).toStrictEqual(["perf"]);
    });

    it("test_AC05_unknown_target_404", async () => {
      await two();
      expect(await label("nope", ["a"], "set")).toEqual({ status: 404, json: { error: 'no live session matches "nope"' } });
    });

    it("test_AC05_eleven_refused_nothing_changes", async () => {
      const { c, s1 } = await two();
      expect((await label(s1.sid, L(10), "set")).status).toBe(200);
      const r = await label(s1.sid, ["zz"], "add");
      expect(r).toEqual({ status: 400, json: { error: "at most 10 labels" } });
      expect((await bySid(s1.sid)).labels).toStrictEqual(L(10));
      expect((await hookAt(sub(c, "after"))).labels).toStrictEqual(L(10));
      // Directly with set, too.
      expect(await label(s1.sid, L(11), "set")).toEqual({ status: 400, json: { error: "at most 10 labels" } });
      expect((await bySid(s1.sid)).labels).toStrictEqual(L(10));
    });

    it("test_AC05_invalid_label_400", async () => {
      const { s1 } = await two();
      expect(await label(s1.sid, ["bad label"], "set")).toEqual({ status: 400, json: { error: `not a label: bad label (${RULE})` } });
      expect((await bySid(s1.sid)).labels).toStrictEqual(["perf"]);
    });

    it("test_AC05_bad_body_400", async () => {
      const { s1 } = await two();
      for (const body of [{ labels: ["a"] }, { target: s1.sid, labels: ["a"] }, { target: s1.sid, labels: ["a"], mode: "merge" }]) {
        expect(await labelsCall(body), JSON.stringify(body)).toEqual({ status: 400, json: { error: BAD_BODY } });
      }
      expect((await bySid(s1.sid)).labels).toStrictEqual(["perf"]);
    });
  });

  describe("AC-06 without a hub", () => {
    it("test_AC06_no_hub_no_key", async () => {
      const c = checkout();
      const s = await hookAt(c);
      const r = await label(s.sid, ["gpu"], "set");
      expect(r.status).toBe(200);
      expect(r.json.session.labels).toStrictEqual(["gpu"]);
      expect(Object.hasOwn(r.json, "unknown")).toBe(false);
      const rc = await remember(c, ["gpu"]);
      expect(rc.status).toBe(200);
      expect(Object.hasOwn(rc.json, "unknown")).toBe(false);
    });
  });
});

// MM-3 AC-23: the offer routes of the local API on a daemon that is not logged in to a hub.
describe("offers", () => {
  const NOT_LOGGED_IN = { error: "not logged in to a hub; run: mesh login" };

  it("test_AC23_accept_not_logged_in_409", async () => {
    await post("session-start", fixture("interactive.SessionStart.startup"));
    expect(await http("POST", "/local/accept", { step: "G1.a" })).toEqual({ status: 409, json: NOT_LOGGED_IN });
    expect(await http("POST", "/local/accept", { step: "G1.a", target: "interactive" })).toEqual({ status: 409, json: NOT_LOGGED_IN });
    expect((await sessions())[0].step).toBeUndefined();
  });

  it("test_AC23_offers_not_logged_in_409", async () => {
    expect(await http("GET", "/local/offers")).toEqual({ status: 409, json: NOT_LOGGED_IN });
  });

  it("test_AC23_session_accept_local", async () => {
    await post("session-start", fixture("interactive.SessionStart.startup"));
    const set = await http("POST", "/local/session-accept", { target: "interactive", accept: ["user:bob", "self"] });
    expect(set.status, JSON.stringify(set.json)).toBe(200);
    expect(set.json.session.accept).toStrictEqual(["user:bob", "self"]);
    expect((await sessions())[0].accept).toStrictEqual(["user:bob", "self"]);
    expect(await http("POST", "/local/session-accept", { target: "interactive", accept: ["bob"] })).toEqual({
      status: 400,
      json: { error: "not an accept rule: bob (an accept rule is self, off, user:<id> or machine:<nickname or id>)" },
    });
    expect((await sessions())[0].accept).toStrictEqual(["user:bob", "self"]);
    const clear = await http("POST", "/local/session-accept", { target: "interactive", accept: null });
    expect(clear.status).toBe(200);
    expect(Object.hasOwn(clear.json.session, "accept")).toBe(false);
    expect(Object.hasOwn((await sessions())[0], "accept")).toBe(false);
    expect(await http("POST", "/local/session-accept", { target: "nope", accept: ["self"] })).toEqual({ status: 404, json: { error: 'no live session matches "nope"' } });
  });
});
