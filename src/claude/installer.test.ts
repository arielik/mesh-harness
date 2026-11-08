import { copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { HOOKS_VERSION } from "../protocol/index.ts";
import {
  hookCommand,
  inspectSettingsFile,
  installSettingsFile,
  uninstallSettingsFile,
  type HookTarget,
} from "./installer.ts";

const FIX = join(import.meta.dirname, "..", "..", "test", "fixtures", "settings");
const T: HookTarget = { port: 27777, key: "0123456789abcdef0123456789abcdef" };
const dirs: string[] = [];
function tmpFile(from?: string): string {
  const d = mkdtempSync(join(tmpdir(), "mesh-settings-"));
  dirs.push(d);
  const p = join(d, "settings.json");
  if (from) copyFileSync(join(FIX, from), p);
  return p;
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function golden(name: string, actual: string) {
  const p = join(FIX, name);
  if (process.env.UPDATE_GOLDEN || !existsSync(p)) writeFileSync(p, actual);
  expect(actual).toBe(readFileSync(p, "utf8"));
}

describe("hook installer", () => {
  it("merges into existing settings, keeping other hooks and keys (golden)", () => {
    const p = tmpFile("existing.json");
    expect(installSettingsFile(p, T).changed).toBe(true);
    golden("existing.installed.json", readFileSync(p, "utf8"));
    expect(inspectSettingsFile(p, T)).toEqual({
      installed: ["SessionStart", "UserPromptSubmit", "Notification", "Stop", "SessionEnd", "SubagentStart", "SubagentStop"],
      stale: [],
      version: HOOKS_VERSION,
    });
  });

  it("is idempotent", () => {
    const p = tmpFile("existing.json");
    installSettingsFile(p, T);
    const once = readFileSync(p, "utf8");
    expect(installSettingsFile(p, T).changed).toBe(false);
    expect(readFileSync(p, "utf8")).toBe(once);
  });

  it("uninstall restores the original byte for byte", () => {
    const p = tmpFile("existing.json");
    const original = readFileSync(p, "utf8");
    installSettingsFile(p, T);
    installSettingsFile(p, { ...T, port: 28888 });
    expect(uninstallSettingsFile(p).changed).toBe(true);
    expect(readFileSync(p, "utf8")).toBe(original);
    expect(existsSync(`${p}.mesh-backup`)).toBe(false);
  });

  it("uninstall keeps changes the user made after install", () => {
    const p = tmpFile("existing.json");
    installSettingsFile(p, T);
    const j = JSON.parse(readFileSync(p, "utf8"));
    j.model = "opus";
    writeFileSync(p, JSON.stringify(j));
    uninstallSettingsFile(p);
    const after = JSON.parse(readFileSync(p, "utf8"));
    expect(after.model).toBe("opus");
    expect(JSON.stringify(after)).not.toContain("/mesh/hook/");
    expect(after.hooks.Stop[0].hooks[0].command).toBe("say done");
  });

  it("creates the file when missing and removes it on uninstall", () => {
    const p = tmpFile();
    installSettingsFile(p, T);
    expect(existsSync(p)).toBe(true);
    uninstallSettingsFile(p);
    expect(existsSync(p)).toBe(false);
    expect(existsSync(`${p}.mesh-absent`)).toBe(false);
  });

  it("detects stale hooks after the port or key changes", () => {
    const p = tmpFile("existing.json");
    installSettingsFile(p, T);
    expect(inspectSettingsFile(p, { ...T, port: 1234 }).stale).toHaveLength(7);
  });

  it("hook commands carry the pid and tmux headers and never block", () => {
    const cmd = hookCommand(T, "SessionStart");
    expect(cmd).toContain('-H "X-Claude-Pid: ${CLAUDE_PID:-$PPID}"');
    expect(cmd).toContain('-H "X-Tmux-Pane: ${TMUX_PANE:-}"');
    expect(cmd).toContain("-m 2");
    expect(cmd.endsWith("http://127.0.0.1:27777/mesh/hook/session-start")).toBe(true);
  });
});

describe("hook versions", () => {
  it("reports hooks written before versioning as v1", () => {
    const d = mkdtempSync(join(tmpdir(), "mesh-ver-"));
    dirs.push(d);
    const p = join(d, "settings.json");
    installSettingsFile(p, T);
    // Rewrite every mesh hook the way mesh 0.0.x wrote it: no version header, no send time.
    const text = readFileSync(p, "utf8").replace(/ -H 'X-Mesh-Hooks: \d+'/g, "").replace(/ -H \\"X-Mesh-At: \$\(date \+%s%N\)\\"/g, "").replace(/,\n\s*"X-Mesh-Hooks": "\d+"/g, "");
    writeFileSync(p, text);
    const st = inspectSettingsFile(p, T);
    expect(st.version).toBe(1);
    expect(st.stale).toHaveLength(7);
    installSettingsFile(p, T);
    expect(inspectSettingsFile(p, T)).toMatchObject({ version: HOOKS_VERSION, stale: [] });
  });

  it("the hook command sends its version and the time it ran", () => {
    const cmd = hookCommand(T, "UserPromptSubmit");
    expect(cmd).toContain(`-H 'X-Mesh-Hooks: ${HOOKS_VERSION}'`);
    expect(cmd).toContain('-H "X-Mesh-At: $(date +%s%N)"');
  });
});
