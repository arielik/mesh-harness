// RL-1 AC-05: built-in profiles, compileProfile, profileSha256, parseProfile (docs/specs/RL-1.md,
// Core). The tables are copied from the spec, not imported, so a changed rule turns the test red.

import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import * as protocol from "../protocol/index.ts";
import * as core from "./index.ts";

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- new exports, read loosely
const C = core as any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- new exports, read loosely
const P = protocol as any;

const MESH = ["mcp__mesh__mesh_context", "mcp__mesh__mesh_artifact", "mcp__mesh__mesh_review", "mcp__mesh__mesh_done"];
const RO_ALLOW = [
  ...MESH,
  "Read",
  "Grep",
  "Glob",
  "LS",
  "Bash(git log --no-ext-diff *)",
  "Bash(git show --no-ext-diff *)",
  "Bash(git rev-parse *)",
  "Bash(git ls-files *)",
  "Bash(git cat-file *)",
];
const RO_DENY = ["Bash(git * --output*)", "Bash(git -c *)", "Bash(git * --ext-diff*)", "Edit", "Write", "NotebookEdit", "WebFetch", "WebSearch"];
const PVB_ALLOW = [...RO_ALLOW, "Edit", "Write", "Bash(git add *)", "Bash(git commit *)"];
const PVB_DENY = ["Bash(git * --output*)", "Bash(git -c *)", "Bash(git * --ext-diff*)", "Bash(git push *)", "NotebookEdit", "WebFetch", "WebSearch"];

const sha = (base: string, settings: unknown) => createHash("sha256").update(JSON.stringify({ base, settings })).digest("hex");

describe("AC-05 built-in profiles", () => {
  it("test_AC05_builtin_exact", () => {
    const b = C.BUILTIN_PROFILES as { name: string; base: string; description: string; settings: unknown }[];
    expect(b.map((p) => p.name)).toStrictEqual(["read-only", "read-only+checks", "propose-via-branch"]);
    const by = (n: string) => b.find((p) => p.name === n);
    expect(by("read-only")?.settings).toStrictEqual({ permissions: { allow: RO_ALLOW, deny: RO_DENY } });
    expect(by("read-only+checks")?.settings).toStrictEqual({ permissions: { allow: RO_ALLOW, deny: RO_DENY } });
    expect(by("propose-via-branch")?.settings).toStrictEqual({ permissions: { allow: PVB_ALLOW, deny: PVB_DENY } });
    for (const p of b) expect(p.base, p.name).toBe(p.name);
    for (const p of b) expect(typeof p.description, p.name).toBe("string");
  });

  it("test_AC05_mesh_rules_first", () => {
    expect(P.MESH_TOOL_RULES).toStrictEqual(MESH);
    for (const p of C.BUILTIN_PROFILES as { name: string; settings: { permissions: { allow: string[]; deny: string[] } } }[]) {
      expect(p.settings.permissions.allow.slice(0, 4), p.name).toStrictEqual(MESH);
      expect([...p.settings.permissions.allow, ...p.settings.permissions.deny].filter((r) => r === "mcp__mesh"), p.name).toStrictEqual([]);
    }
  });
});

describe("AC-05 compileProfile and profileSha256", () => {
  it("test_AC05_compile", () => {
    const r = C.compileProfile({ extends: "read-only+checks", checks: ["pnpm test"], allow: ["Read"], deny: ["Bash(curl *)"] });
    expect(r).toStrictEqual({ base: "read-only+checks", settings: { permissions: { allow: [...RO_ALLOW, "Bash(pnpm test)"], deny: [...RO_DENY, "Bash(curl *)"] } } });
  });

  it("test_AC05_compile_order_checks_then_allow", () => {
    const r = C.compileProfile({ extends: "propose-via-branch", checks: ["pnpm lint"], allow: ["Bash(node *)"] });
    expect(r.base).toBe("propose-via-branch");
    expect(r.settings.permissions.allow).toStrictEqual([...PVB_ALLOW, "Bash(pnpm lint)", "Bash(node *)"]);
    expect(r.settings.permissions.deny).toStrictEqual(PVB_DENY);
  });

  it("test_AC05_compile_dedupe_first", () => {
    const r = C.compileProfile({ extends: "read-only", allow: ["Grep", "X", "X"], deny: ["Edit"] });
    expect(r.settings.permissions.allow).toStrictEqual([...RO_ALLOW, "X"]);
    expect(r.settings.permissions.deny).toStrictEqual(RO_DENY);
  });

  it("test_AC05_hash", () => {
    const s = { permissions: { allow: RO_ALLOW, deny: RO_DENY } };
    const h = C.profileSha256("read-only", s);
    expect(h).toBe(sha("read-only", s));
    expect(h).toMatch(/^[0-9a-f]{64}$/);
    expect(h).not.toBe(createHash("sha256").update(JSON.stringify({ settings: s, base: "read-only" })).digest("hex"));
    expect(C.profileSha256("read-only", { permissions: { allow: [...RO_ALLOW, "X"], deny: RO_DENY } })).not.toBe(h);
    expect(C.profileSha256("read-only+checks", s)).not.toBe(h);
  });
});

describe("AC-05 parseProfile", () => {
  it.each([
    ["allow: [mcp__mesh]\n", "profiles may not allow mcp__mesh"],
    ["allow: [mcp__mesh__mesh_claim]\n", "profiles may not allow mcp__mesh__mesh_claim"],
    ["allow: [Bash]\n", "profiles may not allow Bash"],
    ['allow: ["Bash(*)"]\n', "profiles may not allow Bash(*)"],
    ['allow: ["Bash(:*)"]\n', "profiles may not allow Bash(:*)"],
    ['allow: ["Bash(git push origin *)"]\n', "profiles may not allow Bash(git push origin *)"],
    ['checks: ["*"]\n', "profiles may not allow Bash(*)"],
    ['checks: ["git push"]\n', "profiles may not allow Bash(git push)"],
  ])("test_AC05_parse_errors %s", (text, error) => {
    expect(C.parseProfile(text)).toStrictEqual({ error });
  });

  it("test_AC05_parse_errors_yaml_and_schema", () => {
    const bad = C.parseProfile("a: [\n");
    expect(bad.error).toMatch(/^profile is not valid YAML: ./);
    expect(bad.file).toBeUndefined();
    const unknown = C.parseProfile("foo: 1\n");
    expect(typeof unknown.error).toBe("string");
    expect(unknown.error).toContain("foo");
    expect(unknown.error).not.toMatch(/^profile is not valid YAML/);
    const wrongBase = C.parseProfile("extends: everything\n");
    expect(wrongBase.error).toMatch(/^extends: /);
  });

  it("test_AC05_parse_ok", () => {
    const ok = C.parseProfile('allow: ["Bash(pnpm lint)", "mcp__mesh__mesh_done"]\nchecks: ["pnpm test"]\n');
    expect(ok.error).toBeUndefined();
    expect(ok.file).toMatchObject({ extends: "read-only", allow: ["Bash(pnpm lint)", "mcp__mesh__mesh_done"], checks: ["pnpm test"] });
    expect(C.parseProfile("extends: read-only\n")).toStrictEqual({ file: { extends: "read-only" } });
    expect(C.parseProfile("description: Audit\nextends: propose-via-branch\n").file).toStrictEqual({ description: "Audit", extends: "propose-via-branch" });
  });
});
