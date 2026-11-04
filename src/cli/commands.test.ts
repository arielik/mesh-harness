import { describe, expect, it } from "vitest";
import { dispatch, type Command } from "./commands.ts";

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
