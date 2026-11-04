// Contract for the Claude Code fixtures captured by the M0 spikes (docs/spikes/).
// M1 replaces these shape checks with the protocol schemas; the fixtures stay as test input.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- fixtures are untyped JSON until M1 adds schemas
type Json = Record<string, any>;

const dir = join(import.meta.dirname, "fixtures", "claude");
const load = (sub: string) =>
  readdirSync(join(dir, sub))
    .filter((f) => f.endsWith(".json"))
    .map((f) => ({ file: f, data: JSON.parse(readFileSync(join(dir, sub, f), "utf8")) as Json }));

const EVENTS = ["SessionStart", "UserPromptSubmit", "Notification", "Stop", "SessionEnd"];

describe("hook fixtures", () => {
  const hooks = load("hooks");

  it("cover all five hooks", () => {
    const seen = new Set(hooks.map((h) => h.data.input.hook_event_name));
    expect([...seen].sort()).toEqual([...EVENTS].sort());
  });

  it.each(hooks)("$file has the fields mesh relies on", ({ data }) => {
    expect(data.claudeCodeVersion).toMatch(/^\d+\.\d+\.\d+$/);
    const input = data.input;
    expect(input.session_id).toMatch(/^[0-9a-f-]{36}$/);
    expect(typeof input.cwd).toBe("string");
    expect(typeof input.transcript_path).toBe("string");
    expect(EVENTS).toContain(input.hook_event_name);
    if (input.hook_event_name === "SessionStart") expect(["startup", "resume", "clear", "compact"]).toContain(input.source);
    if (input.hook_event_name === "SessionEnd") expect(typeof input.reason).toBe("string");
    if (input.hook_event_name === "Notification") expect(typeof input.notification_type).toBe("string");
    if (input.hook_event_name === "Stop") {
      expect(typeof input.stop_hook_active).toBe("boolean");
      expect(typeof input.last_assistant_message).toBe("string");
    }
  });

  it("async command hooks carried the Claude pid header", () => {
    for (const h of hooks.filter((x) => x.data.input.hook_event_name !== "Stop")) {
      expect(h.data.claudePidHeaderPresent, h.file).toBe(true);
    }
  });
});

describe("claude agents --json fixtures", () => {
  const agents = load("agents");

  it.each(agents)("$file has kind, sessionId and a known status", ({ data }) => {
    const e = data.entry;
    expect(["interactive", "background"]).toContain(e.kind);
    expect(e.sessionId).toMatch(/^[0-9a-f-]{36}$/);
    if (e.pid !== undefined) expect(["busy", "waiting", "idle"]).toContain(e.status);
    if (e.status === "waiting") expect(typeof e.waitingFor).toBe("string");
    if (e.kind === "background") expect(["working", "blocked", "done", "failed", "stopped"]).toContain(e.state);
  });

  it("include interactive sessions (spike S7)", () => {
    expect(agents.some((a) => a.data.entry.kind === "interactive")).toBe(true);
  });
});

describe("protocol schemas accept every captured fixture", async () => {
  const { HookInput, AgentEntry, toHookEvent, hookKindFromSlug, HOOK_SLUGS } = await import("../src/protocol/index.ts");

  it.each(load("hooks"))("HookInput parses $file", ({ data }) => {
    const parsed = HookInput.safeParse(data.input);
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    const kind = data.input.hook_event_name as keyof typeof HOOK_SLUGS;
    expect(hookKindFromSlug(HOOK_SLUGS[kind])).toBe(kind);
    const ev = toHookEvent(kind, { ...parsed.data, prompt: "secret" }, { claudePid: "123", tmuxPane: "%4", tmux: "/tmp/s,1,0" }, 1);
    expect(ev).toMatchObject({ kind, claudeSessionId: data.input.session_id, pid: 123, pane: "%4", tmuxSocket: "/tmp/s" });
    expect(JSON.stringify(ev)).not.toContain("secret");
  });

  it.each(load("agents"))("AgentEntry parses $file", ({ data }) => {
    expect(AgentEntry.safeParse(data.entry).success).toBe(true);
  });
});
