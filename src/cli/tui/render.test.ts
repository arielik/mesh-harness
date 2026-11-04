import { describe, expect, it } from "vitest";
import type { Session } from "../../protocol/index.ts";
import { age, groupOf, ordered, render } from "./render.ts";

const NOW = 10_000_000;
const base = (sid: string, over: Partial<Session>): Session => ({
  sid,
  claudeSessionIds: [`c-${sid}`],
  cwd: `/w/${sid}`,
  kind: "interactive",
  state: "idle",
  quiet: false,
  startedAt: NOW - 3_600_000,
  lastEventAt: NOW - 60_000,
  turns: 3,
  humanPrompts: 2,
  seenByReconciler: true,
  ...over,
});

const sessions: Session[] = [
  base("a", { repo: { id: "x/frr-dplane-ovs", name: "frr-dplane-ovs" }, state: "needs_you", needs: "permission", lastStopAt: NOW - 120_000, pane: "%3" }),
  base("b", { repo: { id: "x/vpc-node-agent", name: "vpc-node-agent" }, state: "needs_you", needs: "question", lastMessage: "Keep the v4 fallback on by default?", lastStopAt: NOW - 360_000 }),
  base("c", { repo: { id: "x/proto-defs", name: "proto-defs" }, state: "working", turns: 14, lastTurnStartAt: NOW - 180_000, lastEventAt: NOW - 5_000 }),
  base("d", { repo: { id: "x/rust-ovs", name: "rust-ovs" }, state: "working", quiet: true, transcriptMtime: NOW - 25 * 60_000, lastEventAt: NOW - 25 * 60_000 }),
  base("e", { name: "docs-bg", kind: "background", bgId: "93474861", state: "idle", lastMessage: "Docs updated.", lastStopAt: NOW - 30_000 }),
  base("f", { state: "ended", endedReason: "prompt_input_exit", endedAt: NOW - 1000 }),
];

describe("render", () => {
  it("groups and orders sessions", () => {
    expect(ordered(sessions).map((s) => `${groupOf(s)}:${s.sid}`)).toEqual([
      "NEEDS YOU:a",
      "NEEDS YOU:b",
      "WORKING:c",
      "STALLED / QUIET:d",
      "IDLE:e",
      "ENDED:f",
    ]);
  });

  it("renders the list (snapshot)", () => {
    const lines = render({
      sessions,
      messages: [{ id: 1, sid: "c", text: "hi", state: "pending", createdAt: NOW }],
      selected: "b",
      now: NOW,
      width: 100,
      height: 24,
      header: "mesh 0.0.0 · ariel",
      color: false,
    });
    expect(lines.join("\n")).toMatchSnapshot();
  });

  it("shows the say prompt and status, and an empty state", () => {
    const lines = render({
      sessions: [],
      messages: [],
      now: NOW,
      width: 80,
      height: 10,
      header: "mesh",
      status: "message queued",
      input: { label: "say to x: ", value: "hello" },
      color: false,
    });
    expect(lines.join("\n")).toContain("No Claude Code sessions yet");
    expect(lines.at(-2)).toBe("say to x: hello▌");
    expect(lines.at(-1)?.trim()).toBe("message queued");
    expect(lines).toHaveLength(10);
  });

  it.each([
    [5_000, "5s"],
    [90_000, "2m"],
    [3 * 3_600_000, "3h"],
    [72 * 3_600_000, "3d"],
  ])("age(%d) = %s", (ms, text) => {
    expect(age(ms)).toBe(text);
  });
});
