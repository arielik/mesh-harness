import { describe, expect, it } from "vitest";
import { parseSentAt, toHookEvent } from "./hooks.ts";

const NOW = 1_762_600_000_000;

describe("X-Mesh-At", () => {
  it("reads GNU date nanoseconds as a 1 ms window", () => {
    expect(parseSentAt(`${NOW - 50}123456`, NOW)).toEqual([NOW - 50, NOW - 49]);
  });

  it("reads BSD (`…N`) and busybox (`…%N`) output as a 1 s window", () => {
    const s = Math.floor(NOW / 1000) - 1;
    expect(parseSentAt(`${s}N`, NOW)).toEqual([s * 1000, s * 1000 + 1000]);
    expect(parseSentAt(`${s}%N`, NOW)).toEqual([s * 1000, s * 1000 + 1000]);
    expect(parseSentAt(`${s}`, NOW)).toEqual([s * 1000, s * 1000 + 1000]);
  });

  it("ignores garbage and implausible times", () => {
    expect(parseSentAt(undefined, NOW)).toBeUndefined();
    expect(parseSentAt("", NOW)).toBeUndefined();
    expect(parseSentAt("$(date +%s%N)", NOW)).toBeUndefined();
    expect(parseSentAt(`${NOW + 60_000}000000`, NOW)).toBeUndefined();
    expect(parseSentAt(`${NOW - 3_600_000}000000`, NOW)).toBeUndefined();
  });

  it("hook events carry the version and the window", () => {
    const input = { session_id: "c1", cwd: "/w", hook_event_name: "UserPromptSubmit" };
    expect(toHookEvent("UserPromptSubmit", input, {}, NOW)).toMatchObject({ hooksVersion: 1 });
    expect(toHookEvent("UserPromptSubmit", input, {}, NOW).sentWindow).toBeUndefined();
    expect(toHookEvent("UserPromptSubmit", input, { hooks: "2", sentAt: `${NOW - 5}000000` }, NOW)).toMatchObject({ hooksVersion: 2, sentWindow: [NOW - 5, NOW - 4] });
  });
});
