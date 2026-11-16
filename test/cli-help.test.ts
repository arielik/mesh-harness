import { mkdtempSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { dispatch, type Command } from "../src/cli/commands.ts";
import type { CliEnv } from "../src/cli/context.ts";
import { meshCommands } from "../src/cli/mesh-commands.ts";
import { resolvePaths } from "../src/protocol/index.ts";

// Every command carries help text, so --help never runs it: `mesh setup --help` once rewrote a real
// Claude Code setup, `logout` and `take` change state too, and commands that printed their own
// usage for --help exited 2 (`mesh pulse --help`, `mesh pulse add --help`).
function env(): { c: CliEnv; root: string } {
  const root = mkdtempSync(join(tmpdir(), "mesh-help-"));
  const paths = resolvePaths({ MESH_CONFIG_DIR: join(root, "cfg"), MESH_STATE_DIR: join(root, "state"), CLAUDE_CONFIG_DIR: join(root, "claude") }, root);
  return { c: { io: { out: () => undefined, err: () => undefined }, paths, env: {}, cwd: root, self: ["mesh"], version: "0.0.0" }, root };
}

describe("--help never runs a command", () => {
  const { c } = env();
  const commands = meshCommands(c);

  it("every command has help text", () => {
    const missing = commands.filter((cmd) => cmd.help === undefined).map((cmd) => cmd.name);
    expect(missing).toEqual([]);
  });

  // Every command group, alone and with a subcommand, with --help and -h: help on stdout, exit 0, nothing run.
  const cases = commands.flatMap((cmd) => [[cmd.name], [cmd.name, "add"], [cmd.name, "ls"]].flatMap((argv) => [[...argv, "--help"], [...argv, "-h"]]));
  it.each(cases.map((argv) => [argv.join(" "), argv] as const))(
    "mesh %s exits 0 with help",
    async (_label, argv) => {
      const cmd = commands.find((x) => x.name === argv[0]) as Command;
      let ran = false;
      const spy: Command = { ...cmd, run: async () => ((ran = true), 2) };
      let out = "";
      expect(await dispatch(argv, [spy], "0.0.0", (s) => (out += s))).toBe(0);
      expect(ran).toBe(false);
      expect(out).toMatch(/^usage:/);
    },
  );

  it.each(["setup", "logout", "take", "doctor", "status", "ls", "machines"])("mesh %s --help prints help and does not run", async (name) => {
    let ran = false;
    const cmd = commands.find((x) => x.name === name) as Command;
    expect(cmd, name).toBeDefined();
    const spy: Command = { ...cmd, run: async () => ((ran = true), 0) };
    let out = "";
    expect(await dispatch([name, "--help"], [spy], "0.0.0", (s) => (out += s))).toBe(0);
    expect(ran).toBe(false);
    expect(out).toMatch(new RegExp(`^usage: mesh ${name}`));
  });

  it("mesh setup --help writes nothing", async () => {
    const { c: c2, root } = env();
    let out = "";
    expect(await dispatch(["setup", "--help"], meshCommands(c2), "0.0.0", (s) => (out += s))).toBe(0);
    expect(out).toContain("usage: mesh setup");
    expect(readdirSync(root)).toEqual([]);
  });
});
