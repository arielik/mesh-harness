import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { claudeStatePath, folderTrusted } from "./trust.ts";

describe("folder trust", () => {
  const dir = mkdtempSync(join(tmpdir(), "mesh-trust-"));
  const state = join(dir, ".claude.json");
  writeFileSync(state, JSON.stringify({ projects: { "/work": { hasTrustDialogAccepted: true }, "/work/new": { hasTrustDialogAccepted: false } } }));

  it("reads Claude's per-folder record; a trusted parent does not count", () => {
    expect(folderTrusted("/work", state)).toBe(true);
    expect(folderTrusted("/work/new", state)).toBe(false);
    expect(folderTrusted("/work/other", state)).toBe(false);
  });

  it("is unknown when Claude's state is missing or unreadable", () => {
    expect(folderTrusted("/work", join(dir, "missing.json"))).toBeUndefined();
    const bad = join(dir, "bad.json");
    writeFileSync(bad, "{");
    expect(folderTrusted("/work", bad)).toBeUndefined();
  });

  it("follows CLAUDE_CONFIG_DIR", () => {
    expect(claudeStatePath({ CLAUDE_CONFIG_DIR: "/cfg" }, "/home/u")).toBe("/cfg/.claude.json");
    expect(claudeStatePath({}, "/home/u")).toBe("/home/u/.claude.json");
  });
});
