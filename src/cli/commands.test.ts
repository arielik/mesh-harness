import { describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { dispatch, webRootFor, type Command } from "./commands.ts";

const hello: Command = { name: "hello", summary: "say hello", run: async () => 7 };

async function run(argv: string[]) {
  let output = "";
  const code = await dispatch(argv, [hello], "1.2.3", (s) => (output += s));
  return { code, output };
}

describe("dispatch", () => {
  it("prints usage with no arguments", async () => {
    const { code, output } = await run([]);
    expect(code).toBe(0);
    expect(output).toContain("Usage: mesh <command>");
    expect(output).toContain("hello");
  });

  it("prints the version", async () => {
    expect(await run(["--version"])).toEqual({ code: 0, output: "1.2.3" });
  });

  it("runs a known command and returns its exit code", async () => {
    expect((await run(["hello"])).code).toBe(7);
  });

  it("fails on an unknown command", async () => {
    const { code, output } = await run(["nope"]);
    expect(code).toBe(1);
    expect(output).toContain('unknown command "nope"');
  });
});

describe("dispatch fallback", () => {
  it("runs the tui command when called with no arguments", async () => {
    const tui: Command = { name: "tui", summary: "", run: async () => 42 };
    expect(await dispatch([], [tui], "1", () => undefined)).toBe(42);
  });
});

describe("command help", () => {
  it("prints a command's help for --help or -h instead of running it", async () => {
    let ran = 0;
    const hub: Command = { name: "hub", summary: "", help: "usage: mesh hub …", run: async () => ++ran };
    for (const argv of [["hub", "--help"], ["hub", "-h"], ["hub", "init", "--help"]]) {
      let output = "";
      expect(await dispatch(argv, [hub], "1", (s) => (output += s))).toBe(0);
      expect(output).toBe("usage: mesh hub …");
    }
    expect(ran).toBe(0);
  });

  it("passes --help through to a command without help text", async () => {
    let got: string[] = [];
    const goal: Command = { name: "goal", summary: "", run: async (a) => ((got = a), 2) };
    expect(await dispatch(["goal", "--help"], [goal], "1", () => undefined)).toBe(2);
    expect(got).toEqual(["--help"]);
  });
});

describe("webRootFor", () => {
  it("finds web/ next to the real script when called through a bin symlink", () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "mesh-web-"))); // macOS: /var is a symlink to /private/var
    mkdirSync(join(root, "lib", "dist", "web"), { recursive: true });
    writeFileSync(join(root, "lib", "dist", "main.mjs"), "");
    mkdirSync(join(root, "bin"));
    symlinkSync(join(root, "lib", "dist", "main.mjs"), join(root, "bin", "mesh"));
    expect(webRootFor(join(root, "bin", "mesh"))).toBe(join(root, "lib", "dist", "web"));
    expect(webRootFor(join(root, "lib", "dist", "main.mjs"))).toBe(join(root, "lib", "dist", "web"));
  });

  it("is undefined when there is no built dashboard or no such script", () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "mesh-web-"))); // macOS: /var is a symlink to /private/var
    writeFileSync(join(root, "main.mjs"), "");
    expect(webRootFor(join(root, "main.mjs"))).toBeUndefined();
    expect(webRootFor(join(root, "missing.mjs"))).toBeUndefined();
  });
});
