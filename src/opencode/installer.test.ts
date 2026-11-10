import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { OPENCODE_PLUGIN_VERSION } from "../protocol/index.ts";
import { installPlugin, pluginStatus, uninstallPlugin } from "./installer.ts";
import { PLUGIN_MARKER, pluginSource, pluginVersionOf } from "./plugin.ts";

const OPTS = { daemonConfigPath: "/home/u/.config/mesh/daemon.json", mcpCommand: ["/usr/bin/node", "/opt/mesh/main.mjs", "mcp"] };
const dirs: string[] = [];
const configDir = () => {
  const d = mkdtempSync(join(tmpdir(), "mesh-oc-"));
  dirs.push(d);
  return d;
};
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe("the OpenCode plugin file", () => {
  it("carries its marker, version, daemon config path and MCP command", () => {
    const src = pluginSource(OPTS);
    expect(src.startsWith(PLUGIN_MARKER)).toBe(true);
    expect(pluginVersionOf(src)).toBe(OPENCODE_PLUGIN_VERSION);
    expect(src).toContain(JSON.stringify(OPTS.daemonConfigPath));
    expect(src).toContain(JSON.stringify(OPTS.mcpCommand));
    // It never forwards prompt text, only its length.
    expect(src).not.toMatch(/body\.prompt\b/);
  });

  it("installs, is current, and uninstalls leaving OpenCode's config byte-identical", () => {
    const dir = configDir();
    const config = '{\n  // mine\n  "model": "anthropic/claude-fable-5-2"\n}\n';
    writeFileSync(join(dir, "opencode.jsonc"), config);
    mkdirSync(join(dir, "plugins"));
    writeFileSync(join(dir, "plugins", "other.js"), "export default {}\n");
    const p = join(dir, "plugins", "mesh-harness.js");
    expect(pluginStatus(p, OPTS)).toEqual({ state: "missing" });
    expect(installPlugin(p, OPTS)).toEqual({ changed: true, foreign: false });
    expect(pluginStatus(p, OPTS)).toEqual({ state: "current", version: OPENCODE_PLUGIN_VERSION });
    expect(installPlugin(p, OPTS).changed).toBe(false);
    expect(uninstallPlugin(p)).toEqual({ changed: true });
    expect(readFileSync(join(dir, "opencode.jsonc"), "utf8")).toBe(config);
    expect(readdirSync(join(dir, "plugins"))).toEqual(["other.js"]);
  });

  it("removes the plugins folder it created", () => {
    const dir = configDir();
    const p = join(dir, "plugins", "mesh-harness.js");
    installPlugin(p, OPTS);
    uninstallPlugin(p);
    expect(existsSync(join(dir, "plugins"))).toBe(false);
  });

  it("flags an older plugin and refreshes it", () => {
    const p = join(configDir(), "plugins", "mesh-harness.js");
    installPlugin(p, OPTS);
    writeFileSync(p, pluginSource(OPTS).replace(`MESH_OPENCODE_PLUGIN_VERSION=${OPENCODE_PLUGIN_VERSION}`, "MESH_OPENCODE_PLUGIN_VERSION=0"));
    expect(pluginStatus(p, OPTS)).toEqual({ state: "outdated", version: 0 });
    expect(installPlugin(p, OPTS).changed).toBe(true);
    // A new daemon config path or mesh location also makes it outdated.
    expect(pluginStatus(p, { ...OPTS, mcpCommand: ["mesh", "mcp"] }).state).toBe("outdated");
  });

  it("never touches a mesh-harness.js it did not write", () => {
    const p = join(configDir(), "plugins", "mesh-harness.js");
    mkdirSync(join(p, ".."), { recursive: true });
    writeFileSync(p, "// someone else's\n");
    expect(pluginStatus(p, OPTS)).toEqual({ state: "foreign" });
    expect(installPlugin(p, OPTS)).toEqual({ changed: false, foreign: true });
    expect(uninstallPlugin(p)).toEqual({ changed: false });
    expect(readFileSync(p, "utf8")).toBe("// someone else's\n");
  });
});
