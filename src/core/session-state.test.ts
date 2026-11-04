import { describe, expect, it } from "vitest";
import type { AgentEntry, HookEvent, Session } from "../protocol/index.ts";
import {
  applyHook,
  applyObservation,
  applyTick,
  applyTranscriptMtime,
  DEFAULT_RULES,
  endsWithQuestion,
  findSession,
  promptIsFree,
  type Ctx,
} from "./session-state.ts";

const CWD = "/work/repo";
let counter = 0;
const ctx = (now: number): Ctx => ({ now, newId: () => `sid-${++counter}` });

function hook(kind: HookEvent["kind"], at: number, extra: Partial<HookEvent> = {}): HookEvent {
  return { kind, at, claudeSessionId: "c1", cwd: CWD, pid: 100, ...extra };
}

/** Feed events in order; returns the final sessions. */
function run(events: (HookEvent | { obs: AgentEntry[]; at: number } | { tick: number })[]): Session[] {
  counter = 0;
  let sessions: Session[] = [];
  for (const e of events) {
    if ("obs" in e) sessions = applyObservation(sessions, e.obs, ctx(e.at)).sessions;
    else if ("tick" in e) sessions = applyTick(sessions, ctx(e.tick)).sessions;
    else sessions = applyHook(sessions, e, ctx(e.at)).sessions;
  }
  return sessions;
}

const only = (sessions: Session[]) => {
  expect(sessions).toHaveLength(1);
  return sessions[0] as Session;
};

describe("hook-driven state", () => {
  it("normal turn: start → working → idle with a preview", () => {
    const s = only(
      run([
        hook("SessionStart", 1, { source: "startup", transcriptPath: "/t.jsonl", pane: "%3" }),
        hook("UserPromptSubmit", 2, { promptLength: 10 }),
        hook("Stop", 3, { lastAssistantMessage: "Done.\n\nAll tests pass." }),
      ]),
    );
    expect(s).toMatchObject({
      sid: "sid-1",
      state: "idle",
      pid: 100,
      pane: "%3",
      turns: 1,
      humanPrompts: 1,
      lastMessage: "Done. All tests pass.",
      transcriptPath: "/t.jsonl",
    });
    expect(s.claudeSessionIds).toEqual(["c1"]);
  });

  it("an agent ending its turn with a question needs you", () => {
    const s = only(run([hook("UserPromptSubmit", 1), hook("Stop", 2, { lastAssistantMessage: "Keep the v4 fallback on?" })]));
    expect(s).toMatchObject({ state: "needs_you", needs: "question" });
  });

  it("permission_prompt needs you; idle_prompt changes nothing", () => {
    let s = only(run([hook("UserPromptSubmit", 1), hook("Notification", 2, { notificationType: "permission_prompt" })]));
    expect(s).toMatchObject({ state: "needs_you", needs: "permission" });
    s = only(run([hook("Stop", 1), hook("Notification", 61, { notificationType: "idle_prompt" })]));
    expect(s.state).toBe("idle");
  });

  it("delivered prompts are not counted as human prompts", () => {
    const s = only(run([hook("UserPromptSubmit", 1), hook("Stop", 2), hook("UserPromptSubmit", 3, { delivered: true })]));
    expect(s).toMatchObject({ turns: 2, humanPrompts: 1, state: "working" });
  });

  it("/clear rebinds the new Claude id to the same sid (S9)", () => {
    const s = only(
      run([
        hook("SessionStart", 1, { source: "startup" }),
        hook("SessionEnd", 2, { reason: "clear" }),
        hook("SessionStart", 3, { source: "clear", claudeSessionId: "c2" }),
      ]),
    );
    expect(s.state).toBe("idle");
    expect(s.claudeSessionIds).toEqual(["c1", "c2"]);
  });

  it("a startup id switch without SessionEnd rebinds by pid (S9)", () => {
    const s = only(run([hook("SessionStart", 1), hook("SessionStart", 2, { claudeSessionId: "c2" })]));
    expect(s.claudeSessionIds).toEqual(["c1", "c2"]);
  });

  it("the same pid in another folder is a different session", () => {
    expect(run([hook("SessionStart", 1), hook("SessionStart", 2, { claudeSessionId: "c2", cwd: "/elsewhere" })])).toHaveLength(2);
  });

  it("/exit ends the session and resume revives it with the new pid (S9)", () => {
    let sessions = run([hook("SessionStart", 1), hook("SessionEnd", 2, { reason: "prompt_input_exit" })]);
    expect(only(sessions)).toMatchObject({ state: "ended", endedReason: "prompt_input_exit" });
    sessions = applyHook(sessions, hook("SessionStart", 10, { source: "resume", pid: 200 }), ctx(10)).sessions;
    expect(only(sessions)).toMatchObject({ sid: "sid-1", state: "idle", pid: 200 });
  });
});

describe("reconciler observations (S7)", () => {
  const entry = (status: string, extra: Partial<AgentEntry> = {}): AgentEntry => ({
    kind: "interactive",
    pid: 100,
    cwd: CWD,
    sessionId: "c1",
    status,
    ...extra,
  });

  it("creates sessions for processes without hooks", () => {
    const s = only(run([{ obs: [entry("busy", { name: "repo-1" })], at: 1 }]));
    expect(s).toMatchObject({ kind: "interactive", state: "working", name: "repo-1", seenByReconciler: true });
  });

  it("maps waitingFor to needs", () => {
    expect(only(run([{ obs: [entry("waiting", { waitingFor: "permission prompt" })], at: 1 }])).needs).toBe("permission");
    expect(only(run([{ obs: [entry("waiting", { waitingFor: "dialog open" })], at: 1 }])).needs).toBe("dialog");
    expect(only(run([{ obs: [entry("waiting", { waitingFor: "input needed" })], at: 1 }])).needs).toBe("input");
  });

  it("an interrupted turn (no Stop hook) becomes idle from the reconciler (S1)", () => {
    const s = only(run([hook("UserPromptSubmit", 1), { obs: [entry("idle")], at: 5 }]));
    expect(s.state).toBe("idle");
  });

  it("a plain-text question stays needs-you while the reconciler reads idle", () => {
    const s = only(run([hook("Stop", 1, { lastAssistantMessage: "Which one?" }), { obs: [entry("idle")], at: 5 }]));
    expect(s).toMatchObject({ state: "needs_you", needs: "question" });
  });

  it("a crash without SessionEnd ends the session when the pid disappears", () => {
    const s = only(run([hook("SessionStart", 1), { obs: [entry("idle")], at: 2 }, { obs: [], at: 7 }]));
    expect(s).toMatchObject({ state: "ended", endedReason: "process exited" });
  });

  it("does not end sessions the reconciler never saw (e.g. claude -p)", () => {
    expect(only(run([hook("SessionStart", 1), { obs: [], at: 7 }])).state).toBe("idle");
  });

  it("follows /clear through sessionId on the same pid", () => {
    const s = only(run([hook("SessionStart", 1), { obs: [entry("idle", { sessionId: "c2" })], at: 2 }]));
    expect(s.claudeSessionIds).toEqual(["c1", "c2"]);
  });

  it("tracks background sessions by short id and state", () => {
    const bg = (state: string, more: Partial<AgentEntry> = {}): AgentEntry => ({
      kind: "background",
      id: "93474861",
      sessionId: "c9",
      cwd: CWD,
      state,
      ...more,
    });
    let sessions = run([{ obs: [bg("working", { pid: 300, status: "busy" })], at: 1 }]);
    expect(only(sessions)).toMatchObject({ kind: "background", bgId: "93474861", state: "working" });
    sessions = applyObservation(sessions, [bg("done")], ctx(5)).sessions;
    expect(only(sessions).state).toBe("idle");
    sessions = applyObservation(sessions, [bg("stopped")], ctx(9)).sessions;
    expect(only(sessions)).toMatchObject({ state: "ended", endedReason: "stopped" });
  });

  it("ignores finished background sessions it never tracked", () => {
    expect(run([{ obs: [{ kind: "background", id: "x", sessionId: "c9", state: "done" }], at: 1 }])).toHaveLength(0);
  });
});

describe("time rules", () => {
  it("flags a working session whose transcript stopped changing as quiet", () => {
    let sessions = run([hook("UserPromptSubmit", 0)]);
    sessions = applyTranscriptMtime(sessions, "sid-1", 1000).sessions;
    expect(only(applyTick(sessions, ctx(1000 + DEFAULT_RULES.quietAfterMs - 1)).sessions).quiet).toBe(false);
    expect(only(applyTick(sessions, ctx(1000 + DEFAULT_RULES.quietAfterMs + 1)).sessions).quiet).toBe(true);
  });

  it("stalls an idle session holding a step", () => {
    let sessions = run([hook("Stop", 0)]);
    sessions = sessions.map((s) => ({ ...s, step: "G1.a" }));
    expect(only(applyTick(sessions, ctx(DEFAULT_RULES.stallAfterMs + 1)).sessions).state).toBe("stalled");
    expect(only(applyTick(sessions, ctx(DEFAULT_RULES.stallAfterMs - 1)).sessions).state).toBe("idle");
  });

  it("presumes a hook-only session ended after long silence", () => {
    const sessions = run([hook("Stop", 0)]);
    expect(only(applyTick(sessions, ctx(DEFAULT_RULES.presumedEndAfterMs + 1)).sessions).endedReason).toBe("presumed ended");
  });
});

describe("helpers", () => {
  it.each([
    ["Is it blue?", true],
    ["Should I proceed? ", true],
    ["**Which option?**", true],
    ["Done.", false],
    ["Why? Because.", false],
    ["", false],
  ])("endsWithQuestion(%j) = %s", (text, expected) => {
    expect(endsWithQuestion(text)).toBe(expected);
  });

  it("promptIsFree needs a fresh idle observation without waitingFor", () => {
    const [s] = run([hook("SessionStart", 0), { obs: [{ kind: "interactive", pid: 100, sessionId: "c1", status: "idle" }], at: 100 }]);
    if (!s) throw new Error("no session");
    expect(promptIsFree(s, 100)).toBe(true);
    expect(promptIsFree(s, 100 + DEFAULT_RULES.observationFreshMs + 1)).toBe(false);
    expect(promptIsFree({ ...s, observed: { at: 100, status: "waiting", waitingFor: "dialog open" } }, 100)).toBe(false);
  });

  it("findSession matches by name, repo, sid prefix and cwd", () => {
    const sessions = run([hook("SessionStart", 0)]).map((s) => ({
      ...s,
      name: "frr · G17",
      repo: { id: "gitlab.lab/vpc/frr-dplane-ovs", name: "frr-dplane-ovs" },
    }));
    expect(findSession(sessions, "frr-dplane-ovs")?.sid).toBe("sid-1");
    expect(findSession(sessions, "frr · g17")?.sid).toBe("sid-1");
    expect(findSession(sessions, "sid-")?.sid).toBe("sid-1");
    expect(findSession(sessions, "repo")?.sid).toBe("sid-1");
    expect(findSession(sessions, "nope")).toBeUndefined();
  });
});
