import { mkdtempSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { dispatch, type Command } from "../src/cli/commands.ts";
import type { CliEnv } from "../src/cli/context.ts";
import { meshCommands } from "../src/cli/mesh-commands.ts";
import { resolvePaths } from "../src/protocol/index.ts";

// Commands that print their own usage for --help (checked by running each with --help in a
// throwaway HOME). Every other command must carry help text, so --help never runs it: `mesh setup
// --help` once rewrote a real Claude Code setup, `logout` and `take` change state too.
const OWN_USAGE = new Set(["say", "label", "run", "ledger", "assets", "login", "goal", "step", "preset", "answer", "autopilot", "topic", "machine", "assign", "accept", "decline", "withdraw", "session", "pulse", "agents", "agent", "debrief", "items", "artifact", "profile", "tui"]);

function env(): { c: CliEnv; root: string } {
  const root = mkdtempSync(join(tmpdir(), "mesh-help-"));
  const paths = resolvePaths({ MESH_CONFIG_DIR: join(root, "cfg"), MESH_STATE_DIR: join(root, "state"), CLAUDE_CONFIG_DIR: join(root, "claude") }, root);
  return { c: { io: { out: () => undefined, err: () => undefined }, paths, env: {}, cwd: root, self: ["mesh"], version: "0.0.0" }, root };
}

describe("--help never runs a command", () => {
  const { c } = env();
  const commands = meshCommands(c);

  it("every command either has help text or prints its own usage", () => {
    const missing = commands.filter((cmd) => cmd.help === undefined && !OWN_USAGE.has(cmd.name)).map((cmd) => cmd.name);
    expect(missing).toEqual([]);
  });

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
