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
  "Bash(grep *)",
  "Bash(rg *)",
  "Bash(find *)",
];
const SEARCH_DENY = ["Bash(find *-exec*)", "Bash(find *-ok*)", "Bash(find *-delete*)", "Bash(find *-fprint*)", "Bash(find *-fls*)", "Bash(rg *--pre*)"];
const RO_DENY = ["Bash(git * --output*)", "Bash(git -c *)", "Bash(git * --ext-diff*)", ...SEARCH_DENY, "Edit", "Write", "NotebookEdit", "WebFetch", "WebSearch"];
const PVB_ALLOW = [...RO_ALLOW, "Edit", "Write", "Bash(git add *)", "Bash(git commit *)"];
const PVB_DENY = ["Bash(git * --output*)", "Bash(git -c *)", "Bash(git * --ext-diff*)", ...SEARCH_DENY, "Bash(git push *)", "NotebookEdit", "WebFetch", "WebSearch"];

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

  // A build without the Grep and Glob tools searches through Bash: the shell forms are allowed, and
  // the forms that run commands or write files match a deny rule (a rule's `*` matches any text).
  it("test_AC05_search_through_bash", () => {
    const esc = (x: string) => x.replace(/[.+?^${}()|[\]\\]/g, "\\$&");
    const matches = (rule: string, cmd: string) => {
      const m = /^Bash\((.*)\)$/.exec(rule);
      return m ? new RegExp(`^${(m[1] ?? "").split("*").map(esc).join(".*")}$`).test(cmd) : false;
    };
    for (const name of ["read-only", "propose-via-branch"]) {
      const { allow, deny } = (C.builtinProfile(name) as { settings: { permissions: { allow: string[]; deny: string[] } } }).settings.permissions;
      const allowed = (cmd: string) => allow.some((r) => matches(r, cmd)) && !deny.some((r) => matches(r, cmd));
      for (const cmd of ["grep -rn foo src", "rg -n foo", "find . -name '*.ts'", "find src -type f"]) expect(allowed(cmd), `${name}: ${cmd}`).toBe(true);
      for (const cmd of ["find . -name x -delete", "find . -exec rm {} ;", "find . -execdir sh ;", "find . -ok rm {} ;", "find . -fprint out", "find . -fls out", "rg --pre cat foo", "rg foo --pre=sh"]) {
        expect(allowed(cmd), `${name}: ${cmd}`).toBe(false);
      }
    }
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

  // RL-1: `env` sets variables for the run's process; it is part of the settings and the hash.
  it("test_RL1_env_compiles_sorted_and_hashed", () => {
    const ok = C.parseProfile('env:\n  NODE_ENV: test\n  CI: "true"\n  A_B9: ""\n');
    expect(ok.error).toBeUndefined();
    const c = C.compileProfile(ok.file);
    expect(c.settings).toStrictEqual({ permissions: { allow: RO_ALLOW, deny: RO_DENY }, env: { A_B9: "", CI: "true", NODE_ENV: "test" } });
    expect(Object.keys(c.settings.env)).toStrictEqual(["A_B9", "CI", "NODE_ENV"]);
    expect(C.profileSha256(c.base, c.settings)).not.toBe(C.profileSha256(c.base, { permissions: c.settings.permissions }));
    // No env (or an empty map) leaves the settings, and so the hash, as before.
    expect("env" in C.compileProfile(C.parseProfile("env: {}\n").file).settings).toBe(false);
    expect("env" in C.compileProfile(C.parseProfile("extends: read-only\n").file).settings).toBe(false);
    // The snapshot schema keeps env (a daemon parsing an offer must not drop it).
    expect(P.ProfileSnapshot.parse(C.profileSnapshot("p", "read-only", c.settings)).settings.env).toStrictEqual(c.settings.env);
  });

  it.each([
    ["env:\n  lower: x\n", "env: lower is not a variable name (1-100 of A-Z, 0-9 and _, not starting with a digit)"],
    ["env:\n  9X: x\n", "env: 9X is not a variable name (1-100 of A-Z, 0-9 and _, not starting with a digit)"],
    ["env:\n  PATH: /tmp\n", "profiles may not set PATH"],
    ["env:\n  MESH_STEP: x\n", "profiles may not set MESH_STEP"],
    ["env:\n  ANTHROPIC_BASE_URL: http://x\n", "profiles may not set ANTHROPIC_BASE_URL"],
    ["env:\n  CLAUDE_CONFIG_DIR: /x\n", "profiles may not set CLAUDE_CONFIG_DIR"],
    ["env:\n  GIT_SSH_COMMAND: x\n", "profiles may not set GIT_SSH_COMMAND"],
    ["env:\n  LD_PRELOAD: x\n", "profiles may not set LD_PRELOAD"],
    ["env:\n  NODE_OPTIONS: x\n", "profiles may not set NODE_OPTIONS"],
    ["env:\n  TMUX: x\n", "profiles may not set TMUX"],
    ['env:\n  X: "a\\nb"\n', "env.X: a value may not contain a line break or NUL"],
    ['env:\n  X: "a\\rb"\n', "env.X: a value may not contain a line break or NUL"],
    [`env:\n  X: "${"v".repeat(1001)}"\n`, "env.X: a value is at most 1000 characters"],
    [`env:\n${Array.from({ length: 51 }, (_, i) => `  V${i}: x`).join("\n")}\n`, "env: a profile sets at most 50 variables"],
    ["env:\n  X: 1\n", "env.X: an env value is a string (quote numbers and booleans)"],
  ])("test_RL1_env_refused %#", (text, error) => {
    expect(C.parseProfile(text)).toStrictEqual({ error });
  });

  it("test_RL1_profile_run_env", () => {
    expect(C.profileRunEnv({ permissions: { allow: [], deny: [] } })).toStrictEqual({ env: {} });
    expect(C.profileRunEnv({ permissions: { allow: [], deny: [] }, env: { CI: "1" } })).toStrictEqual({ env: { CI: "1" } });
    // A snapshot from the hub that sets a refused variable never reaches the run.
    expect(C.profileRunEnv({ permissions: { allow: [], deny: [] }, env: { CI: "1", PATH: "/tmp" } })).toStrictEqual({ error: "profiles may not set PATH" });
  });

  // RL-1: a check is at most 1000 characters, and the parse error says so.
  it("test_RL1_check_length", () => {
    const long = `pnpm vitest run ${"x".repeat(1000 - 16)}`;
    expect(long).toHaveLength(1000);
    expect(C.parseProfile(`checks: ["${long}"]\n`).file).toStrictEqual({ extends: "read-only", checks: [long] });
    expect(C.parseProfile(`checks: ["ok", "${long}x"]\n`)).toStrictEqual({ error: "checks.1: a check is at most 1000 characters" });
    expect(C.parseProfile(`allow: ["${"x".repeat(301)}"]\n`)).toStrictEqual({ error: "allow.0: a rule is at most 300 characters" });
    expect(C.parseProfile(`description: ${"d".repeat(201)}\n`)).toStrictEqual({ error: "description: a description is at most 200 characters" });
  });

  it("test_AC05_parse_ok", () => {
    const ok = C.parseProfile('allow: ["Bash(pnpm lint)", "mcp__mesh__mesh_done"]\nchecks: ["pnpm test"]\n');
    expect(ok.error).toBeUndefined();
    expect(ok.file).toMatchObject({ extends: "read-only", allow: ["Bash(pnpm lint)", "mcp__mesh__mesh_done"], checks: ["pnpm test"] });
    expect(C.parseProfile("extends: read-only\n")).toStrictEqual({ file: { extends: "read-only" } });
    expect(C.parseProfile("description: Audit\nextends: propose-via-branch\n").file).toStrictEqual({ description: "Audit", extends: "propose-via-branch" });
  });
});
