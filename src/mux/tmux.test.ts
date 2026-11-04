// Real tmux on a private server (`tmux -L`). Skipped when tmux isn't installed.
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { afterAll, describe, expect, it } from "vitest";
import { capturePane, hasSession, killServer, newSession, newWindow, paneExists, pasteToPane, serverFromEnv } from "./tmux.ts";

let haveTmux = true;
try {
  execFileSync("tmux", ["-V"]);
} catch {
  haveTmux = false;
}

const o = { socketName: `meshtest-${process.pid}` };
afterAll(async () => {
  if (haveTmux) await killServer(o);
});

async function waitFor(pane: string, text: string): Promise<string> {
  for (let i = 0; i < 40; i++) {
    const s = await capturePane(pane, o);
    if (s.includes(text)) return s;
    await new Promise((r) => setTimeout(r, 100));
  }
  return capturePane(pane, o);
}

describe.skipIf(!haveTmux)("tmux adapter (real tmux)", () => {
  it("creates sessions and windows and returns pane ids", async () => {
    const pane = await newSession("mesh", { name: "first", cwd: tmpdir(), argv: ["cat"] }, o);
    expect(pane).toMatch(/^%\d+$/);
    expect(await hasSession("mesh", o)).toBe(true);
    expect(await hasSession("nope", o)).toBe(false);
    const second = await newWindow("mesh", { name: "second", cwd: tmpdir(), argv: ["cat"], env: { MESH_TEST: "1" } }, o);
    expect(second).not.toBe(pane);
    expect(await paneExists(second, o)).toBe(true);
    expect(await paneExists("%9999", o)).toBe(false);
  });

  it("pastes text and presses Enter", async () => {
    const pane = await newWindow("mesh", { name: "paste", cwd: tmpdir(), argv: ["cat"] }, o);
    expect(await pasteToPane(pane, "hello from mesh", o)).toBe(true);
    const screen = await waitFor(pane, "hello from mesh");
    // cat echoes the line back once Enter is pressed: the text appears twice.
    expect(screen.split("hello from mesh").length - 1).toBeGreaterThanOrEqual(2);
  });

  it("reads the server from $TMUX", () => {
    expect(serverFromEnv("/tmp/tmux-501/default,123,0")).toEqual({ socketPath: "/tmp/tmux-501/default" });
    expect(serverFromEnv(undefined)).toBeUndefined();
  });
});
