import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CLAUDE_MD_BLOCK } from "../protocol/index.ts";
import type { Runner } from "./exec.ts";
import { claudeMdInstalled, installClaudeMd, installMcp, uninstallClaudeMd, uninstallMcp } from "./extras.ts";

const dirs: string[] = [];
const file = () => {
  const d = mkdtempSync(join(tmpdir(), "mesh-md-"));
  dirs.push(d);
  return join(d, "CLAUDE.md");
};
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe("CLAUDE.md block", () => {
  it.each(["# Me\n\nUse pnpm.\n", "# Me\nno trailing newline", ""])("installs and restores %j byte for byte", (original) => {
    const p = file();
    writeFileSync(p, original);
    installClaudeMd(p, CLAUDE_MD_BLOCK);
    expect(readFileSync(p, "utf8")).toContain("mesh_context");
    expect(installClaudeMd(p, CLAUDE_MD_BLOCK).changed).toBe(false);
    expect(claudeMdInstalled(p)).toBe(true);
    uninstallClaudeMd(p);
    expect(readFileSync(p, "utf8")).toBe(original);
  });

  it("creates and removes a missing file", () => {
    const p = file();
    installClaudeMd(p, CLAUDE_MD_BLOCK);
    uninstallClaudeMd(p);
    expect(existsSync(p)).toBe(false);
  });

  it("keeps the user's later edits", () => {
    const p = file();
    writeFileSync(p, "# Me\n");
    installClaudeMd(p, CLAUDE_MD_BLOCK);
    writeFileSync(p, readFileSync(p, "utf8") + "\nMore rules.\n");
    uninstallClaudeMd(p);
    const after = readFileSync(p, "utf8");
    expect(after).toContain("More rules.");
    expect(after).not.toContain("mesh:begin");
  });
});

describe("MCP registration", () => {
  it("registers mesh mcp at user scope via the claude CLI", async () => {
    const calls: string[] = [];
    const runner: Runner = async (cmd, args) => {
      calls.push([cmd, ...args].join(" "));
      return { code: 0, stdout: "", stderr: "" };
    };
    expect(await installMcp(["/usr/bin/node", "/opt/mesh/main.mjs", "mcp"], runner)).toEqual({ ok: true });
    expect(await uninstallMcp(runner)).toBe(true);
    expect(calls).toEqual([
      "claude mcp remove -s user mesh",
      "claude mcp add -s user mesh -- /usr/bin/node /opt/mesh/main.mjs mcp",
      "claude mcp remove -s user mesh",
    ]);
  });
});
