import { describe, expect, it } from "vitest";
import type { RunResult } from "./exec.ts";
import { osc9, processTty, terminalNotify, tmuxPassthrough } from "./notify.ts";

const ok = (stdout = ""): RunResult => ({ code: 0, stdout, stderr: "" });

describe("terminal notifications", () => {
  it("OSC 9 carries the title and body, without control characters", () => {
    expect(osc9("mesh · api", "asks: keep v1?\n\u001b[31m")).toBe("\u001b]9;mesh · api: asks: keep v1?  [31m\u0007");
  });

  it("tmux passthrough doubles the escapes inside", () => {
    expect(tmuxPassthrough("\u001b]9;x\u0007")).toBe("\u001bPtmux;\u001b\u001b]9;x\u0007\u001b\\");
  });

  it("writes to the tmux pane's tty, wrapped for passthrough", async () => {
    const calls: string[][] = [];
    const writes: [string, string][] = [];
    const sent = await terminalNotify({ pane: "%7", tmuxSocket: "/tmp/tmux-1/default", pid: 42 }, "mesh", "needs you", {
      runner: async (cmd, args) => {
        calls.push([cmd, ...args]);
        return ok("/dev/pts/9\n");
      },
      writeTty: (tty, data) => (writes.push([tty, data]), true),
    });
    expect(sent).toBe(true);
    expect(calls[0]).toEqual(["tmux", "-S", "/tmp/tmux-1/default", "display-message", "-p", "-t", "%7", "#{pane_tty}"]);
    expect(writes).toEqual([["/dev/pts/9", tmuxPassthrough(osc9("mesh", "needs you"))]]);
  });

  it("outside tmux, writes to the terminal of the Claude process (Linux /proc)", async () => {
    const writes: [string, string][] = [];
    const sent = await terminalNotify({ pid: 42 }, "mesh", "done", {
      platform: "linux",
      readlink: (p) => (p === "/proc/42/fd/2" ? "/dev/pts/3" : undefined),
      writeTty: (tty, data) => (writes.push([tty, data]), true),
    });
    expect(sent).toBe(true);
    expect(writes).toEqual([["/dev/pts/3", osc9("mesh", "done")]]);
  });

  it("finds the terminal with ps on macOS, and gives up without one", async () => {
    expect(await processTty(42, { platform: "darwin", runner: async () => ok("ttys004\n") })).toBe("/dev/ttys004");
    expect(await processTty(42, { platform: "darwin", runner: async () => ok("??\n") })).toBeUndefined();
    expect(await processTty(42, { platform: "linux", readlink: () => "/home/me/log.txt" })).toBeUndefined();
    expect(await terminalNotify({}, "mesh", "x", { writeTty: () => true })).toBe(false);
  });
});
