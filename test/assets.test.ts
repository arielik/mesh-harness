// The SDD kit shipped in assets/sdd: complete, installable, and its workflow parses in the shape
// Claude Code's Workflow runtime runs it (top-level await, agent/parallel/phase/log/args).
import { execFileSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { parse } from "yaml";
import { installAssets } from "../src/cli/assets.ts";
import { parseLabel } from "../src/core/index.ts";

const KIT = join(import.meta.dirname, "..", "assets", "sdd");
const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe("the SDD kit", () => {
  it("has an agent with front matter for every role the workflow uses", () => {
    const wf = readFileSync(join(KIT, ".claude/workflows/sdd-programme.js"), "utf8");
    const roles = [...new Set([...wf.matchAll(/agentType: '([a-z-]+)'/g)].map((m) => m[1] as string))].sort();
    const agents = readdirSync(join(KIT, ".claude/agents")).map((f) => f.replace(/\.md$/, "")).sort();
    expect(roles.every((r) => agents.includes(r))).toBe(true);
    for (const a of agents) {
      const text = readFileSync(join(KIT, ".claude/agents", `${a}.md`), "utf8");
      const fm = parse(text.split("---\n")[1] ?? "") as { name: string; description: string };
      expect(fm.name).toBe(a);
      expect(fm.description.length).toBeGreaterThan(20);
      expect(text).toContain("## Report");
    }
  });

  it("labels every agent() call so mesh can record it", () => {
    const wf = readFileSync(join(KIT, ".claude/workflows/sdd-programme.js"), "utf8");
    // ${K} is the key; other placeholders are round numbers or an optional ":c<n>" suffix.
    const labels = [...wf.matchAll(/label: `([^`]+)`/g)].map((m) => (m[1] as string).replace(/\$\{K\}\$\{round\}/g, "ROW-1:c2").replace(/\$\{K\}/g, "ROW-1").replace(/\$\{[^}]+\}/g, "1"));
    expect(labels.length).toBeGreaterThan(10);
    for (const l of labels) expect(parseLabel(l), l).toMatchObject({ key: "ROW-1" });
    expect(wf).not.toMatch(/mesh_|from ['"]/);
  });

  it("parses and runs to the first agent() in the Workflow runtime's shape", async () => {
    const src = readFileSync(join(KIT, ".claude/workflows/sdd-programme.js"), "utf8").replace(/^export const meta/m, "const meta");
    const calls: { prompt: string; opts: { label?: string; schema?: unknown } }[] = [];
    const agent = async (prompt: string, opts: { label?: string; schema?: unknown }) => {
      calls.push({ prompt, opts });
      return null; // the first agent returns nothing: the row parks
    };
    const run = new Function("args", "agent", "parallel", "phase", "log", `return (async () => { ${src} })()`) as (...a: unknown[]) => Promise<{ rows: { state: string; reason: string }[] }>;
    const out = await run({ rows: [{ key: "ROW-1", title: "t", brief: "b" }] }, agent, (fs: (() => Promise<unknown>)[]) => Promise.all(fs.map((f) => f())), () => undefined, () => undefined);
    expect(out.rows[0]).toMatchObject({ state: "parked", reason: "spec-writer returned nothing" });
    expect(calls.map((c) => c.opts.label)).toEqual(["spec-writer:ROW-1", "ledger"]);
    await expect(run({}, agent, () => undefined, () => undefined, () => undefined)).rejects.toThrow(/args.rows is required/);
  });

  it("installs into a repo without overwriting the team's files", () => {
    const repo = mkdtempSync(join(tmpdir(), "mesh-assets-"));
    dirs.push(repo);
    execFileSync("git", ["init", "-q"], { cwd: repo });
    execFileSync("mkdir", ["-p", join(repo, ".claude/agents")]);
    writeFileSync(join(repo, ".claude/agents/reviewer.md"), "ours");
    const r = installAssets(KIT, repo, false);
    expect(r.skipped).toEqual([".claude/agents/reviewer.md"]);
    expect(r.copied).toContain(".claude/workflows/sdd-programme.js");
    expect(readFileSync(join(repo, ".claude/agents/reviewer.md"), "utf8")).toBe("ours");
    expect(installAssets(KIT, repo, true).copied).toContain(".claude/agents/reviewer.md");
  });
});
