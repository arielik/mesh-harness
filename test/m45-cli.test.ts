// M4.5 CLI pieces against real git: one worktree and branch per step, reused on a fix round.
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { run } from "../src/claude/index.ts";
import { stepWorktree } from "../src/cli/mesh-commands.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe("step worktrees", () => {
  it("creates <repo>/.claude/worktrees/<step> on mesh/<step> from a base, then reuses it", async () => {
    const repo = mkdtempSync(join(tmpdir(), "mesh-wt-"));
    dirs.push(repo);
    const git = (...args: string[]) => execFileSync("git", ["-C", repo, "-c", "user.email=t@t", "-c", "user.name=t", ...args], { encoding: "utf8" }).trim();
    git("init", "-q");
    writeFileSync(join(repo, "a.txt"), "base");
    git("add", "-A");
    git("commit", "-qm", "base");
    const base = git("rev-parse", "HEAD");
    writeFileSync(join(repo, "a.txt"), "later");
    git("commit", "-qam", "later");

    const first = await stepWorktree(run, repo, { id: "G3.write-tests", goal: "G3" }, base);
    expect(first).toMatchObject({ ok: true, created: true, branch: "mesh/g3-write-tests", base });
    if (!first.ok) return;
    expect(existsSync(join(first.path, "a.txt"))).toBe(true);
    expect(execFileSync("git", ["-C", first.path, "rev-parse", "HEAD"], { encoding: "utf8" }).trim()).toBe(base);

    const again = await stepWorktree(run, repo, { id: "G3.write-tests", goal: "G3" }, undefined);
    expect(again).toMatchObject({ ok: true, created: false, path: first.path });

    // The worktree folder was removed but the branch stays: the next round continues on it.
    git("worktree", "remove", "--force", first.path);
    const third = await stepWorktree(run, repo, { id: "G3.write-tests", goal: "G3" }, undefined);
    expect(third).toMatchObject({ ok: true, created: true, base: "mesh/g3-write-tests" });

    const bad = await stepWorktree(run, repo, { id: "G3.x", goal: "G3" }, "no-such-ref");
    expect(bad.ok).toBe(false);
  });
});
