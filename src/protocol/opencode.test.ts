import { describe, expect, it } from "vitest";
import { OpenCodeEvent, openCodeToHookEvent, type OpenCodeEventType } from "./opencode.ts";

const NOW = 1_800_000_000_000;
const ev = (type: OpenCodeEventType, extra: Partial<OpenCodeEvent> = {}): OpenCodeEvent =>
  OpenCodeEvent.parse({ v: 1, type, sessionID: "ses_root", pid: 4242, standalone: true, cwd: "/work/repo", ...extra });

describe("OpenCode events → hook events", () => {
  it("maps a turn: created, started, succeeded", () => {
    expect(openCodeToHookEvent(ev("session.created"), NOW)).toMatchObject({ kind: "SessionStart", agent: "opencode", claudeSessionId: "ses_root", cwd: "/work/repo" });
    expect(openCodeToHookEvent(ev("session.execution.started", { promptLength: 12 }), NOW)).toMatchObject({ kind: "UserPromptSubmit", promptLength: 12 });
    expect(openCodeToHookEvent(ev("session.execution.succeeded", { text: "done: ok" }), NOW)).toMatchObject({ kind: "Stop", lastAssistantMessage: "done: ok" });
    expect(openCodeToHookEvent(ev("session.execution.interrupted"), NOW)).toMatchObject({ kind: "Stop" });
  });

  it("maps prompts that need the person, and their answers", () => {
    expect(openCodeToHookEvent(ev("permission.asked"), NOW)).toMatchObject({ kind: "Notification", notificationType: "permission_prompt" });
    expect(openCodeToHookEvent(ev("form.created", { text: "Red or blue?" }), NOW)).toMatchObject({ kind: "Notification", notificationType: "question", lastAssistantMessage: "Red or blue?" });
    expect(openCodeToHookEvent(ev("session.execution.failed", { text: "rate limited" }), NOW)).toMatchObject({ kind: "Notification", notificationType: "agent_error", lastAssistantMessage: "error: rate limited" });
    for (const t of ["permission.replied", "form.replied", "form.cancelled"] as const) expect(openCodeToHookEvent(ev(t), NOW)).toMatchObject({ kind: "Resume" });
  });

  it("reports a subagent's prompts against its root and ignores the rest of the subagent", () => {
    expect(openCodeToHookEvent(ev("permission.asked", { child: true }), NOW)).toMatchObject({ kind: "Notification", claudeSessionId: "ses_root" });
    expect(openCodeToHookEvent(ev("permission.replied", { child: true }), NOW)).toMatchObject({ kind: "Resume" });
    for (const t of ["session.created", "session.execution.started", "session.execution.succeeded", "session.deleted"] as const) {
      expect(openCodeToHookEvent(ev(t, { child: true }), NOW)).toBeUndefined();
    }
  });

  it("keeps the pane, step and autopilot of a private server only", () => {
    const own = openCodeToHookEvent(ev("session.created", { pane: "%3", tmux: "/tmp/tmux-1/default,1,0", step: "G1.api", autopilot: "chain" }), NOW);
    expect(own).toMatchObject({ pane: "%3", tmuxSocket: "/tmp/tmux-1/default", stepHint: "G1.api", autopilot: "chain", pid: 4242 });
    const shared = openCodeToHookEvent(ev("session.created", { standalone: false, pane: "%3", tmux: "/tmp/tmux-1/default,1,0" }), NOW);
    expect(shared?.pane).toBeUndefined();
    expect(shared?.tmuxSocket).toBeUndefined();
  });

  it("uses the event time for ordering only when it is plausible", () => {
    expect(openCodeToHookEvent(ev("session.created", { at: NOW - 1000 }), NOW)?.sentWindow).toEqual([NOW - 1000, NOW - 999]);
    expect(openCodeToHookEvent(ev("session.created", { at: NOW + 60_000 }), NOW)?.sentWindow).toBeUndefined();
  });

  it("has nothing for the state machine in a shutdown or an event without a session", () => {
    expect(openCodeToHookEvent(ev("location.shutdown", { sessionID: undefined }), NOW)).toBeUndefined();
    expect(openCodeToHookEvent(ev("permission.asked", { sessionID: undefined }), NOW)).toBeUndefined();
  });

  it("rejects unknown event types and oversized text", () => {
    expect(OpenCodeEvent.safeParse({ v: 1, type: "session.text.delta", pid: 1, standalone: true }).success).toBe(false);
    expect(OpenCodeEvent.safeParse({ v: 1, type: "session.execution.succeeded", pid: 1, standalone: true, text: "x".repeat(5000) }).success).toBe(false);
  });
});
