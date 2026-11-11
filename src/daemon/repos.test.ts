// AC-14 (MM-1): the repo inventory scan. Checkouts are written as files (no git process).

import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fakeCheckout, fakeWorktree } from "../../test/helpers/git-tree.ts";

const spawned: string[] = [];
vi.mock("node:child_process", () => {
  const record = (name: string) => () => {
    spawned.push(name);
    throw new Error(`the repo scan spawned a process (${name})`);
  };
  return {
    default: {},
    spawn: record("spawn"),
    spawnSync: record("spawnSync"),
    exec: record("exec"),
    execSync: record("execSync"),
    execFile: record("execFile"),
    execFileSync: record("execFileSync"),
    fork: record("fork"),
  };
});

const { scanRepos } = await import("./repos.ts");

const dirs: string[] = [];
const temp = (prefix: string) => {
  const d = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(d);
  return d;
};
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** The tree of the test plan: T plus a git dir store outside it for the worktree. */
function tempTree(): string {
  const T = temp("mesh-scan-");
  const store = temp("mesh-scan-store-");
  fakeCheckout(join(T, "one"), "git@example.org:team/one.git");
  fakeCheckout(join(T, "one", "nested"), "https://example.org/team/nested");
  fakeCheckout(join(T, "g", "two"), "https://example.org/team/two");
  fakeCheckout(join(T, "g", "h", "three"), "https://example.org/team/three");
  fakeCheckout(join(T, ".hidden", "x"), "https://example.org/team/hidden");
  fakeCheckout(join(T, "node_modules", "y"), "https://example.org/team/nm");
  fakeWorktree(join(T, "wt"), join(store, "onewt.git"), "https://example.org/team/onewt");
  fakeCheckout(join(T, "noremote"));
  fakeCheckout(join(T, "fileremote"), "file:///srv/x.git");
  fakeCheckout(join(T, "absremote"), "/srv/y.git");
  fakeCheckout(join(T, "clone-https"), "https://example.org/team/dup.git");
  fakeCheckout(join(T, "clone-ssh"), "git@example.org:team/dup.git");
  return T;
}

const ids = (repos: { id: string }[]) => repos.map((r) => r.id);

let T: string;
beforeEach(() => {
  spawned.length = 0;
  T = tempTree();
});

describe("AC-14 scanRepos", () => {
  it("test_AC14_depth_0_root_is_checkout", () => {
    expect(ids(scanRepos([join(T, "one")]))).toEqual(["example.org/team/one"]);
  });

  it("test_AC14_depth_1_and_2_found", () => {
    const found = ids(scanRepos([T]));
    expect(found).toContain("example.org/team/one");
    expect(found).toContain("example.org/team/two");
  });

  it("test_AC14_depth_3_not_found", () => {
    const found = ids(scanRepos([T]));
    expect(found).toContain("example.org/team/two"); // positive control: depth 2 is scanned
    expect(found).not.toContain("example.org/team/three");
  });

  it("test_AC14_skips_hidden_and_node_modules", () => {
    const found = ids(scanRepos([T]));
    expect(found.length).toBeGreaterThan(0);
    expect(found).not.toContain("example.org/team/hidden");
    expect(found).not.toContain("example.org/team/nm");
  });

  it("test_AC14_no_descent_into_checkout", () => {
    const found = ids(scanRepos([T]));
    expect(found).toContain("example.org/team/one");
    expect(found).not.toContain("example.org/team/nested");
  });

  it("test_AC14_worktree_git_file", () => {
    expect(ids(scanRepos([T]))).toContain("example.org/team/onewt");
  });

  it("test_AC14_skips_no_remote_and_local_ids", () => {
    const found = ids(scanRepos([T]));
    expect(found.length).toBeGreaterThan(0);
    expect(found.filter((id) => id.startsWith("local/"))).toEqual([]);
    expect(found.join(" ")).not.toMatch(/srv|noremote|fileremote|absremote/);
  });

  it("test_AC14_dedupes_https_and_ssh", () => {
    expect(ids(scanRepos([T])).filter((id) => id === "example.org/team/dup")).toHaveLength(1);
  });

  it("test_AC14_sorted_exact_list", () => {
    expect(scanRepos([T])).toEqual([
      { id: "example.org/team/dup", name: "dup" },
      { id: "example.org/team/one", name: "one" },
      { id: "example.org/team/onewt", name: "onewt" },
      { id: "example.org/team/two", name: "two" },
    ]);
  });

  it("test_AC14_sorted_by_name_then_id", () => {
    const R = temp("mesh-scan-sort-");
    fakeCheckout(join(R, "b"), "https://example.org/zz/app");
    fakeCheckout(join(R, "a"), "https://example.org/aa/app");
    fakeCheckout(join(R, "c"), "https://example.org/team/aardvark");
    expect(scanRepos([R])).toEqual([
      { id: "example.org/team/aardvark", name: "aardvark" },
      { id: "example.org/aa/app", name: "app" },
      { id: "example.org/zz/app", name: "app" },
    ]);
  });

  it("test_AC14_missing_root_ignored", () => {
    const expected = scanRepos([T]);
    expect(expected.length).toBeGreaterThan(0);
    expect(scanRepos([join(T, "nope"), T])).toEqual(expected);
    expect(scanRepos([join(T, "nope")])).toEqual([]);
  });

  it("test_AC14_tilde_expanded", () => {
    const home = process.env.HOME;
    process.env.HOME = T;
    try {
      const viaTilde = scanRepos(["~"]);
      expect(viaTilde.length).toBeGreaterThan(0);
      expect(viaTilde).toEqual(scanRepos([T]));
      mkdirSync(join(T, "sub"));
      fakeCheckout(join(T, "sub", "deep"), "https://example.org/team/deep");
      expect(ids(scanRepos(["~/sub"]))).toEqual(["example.org/team/deep"]);
    } finally {
      process.env.HOME = home;
    }
  });

  it("test_AC14_no_paths_in_output", () => {
    const result = scanRepos([T]);
    expect(result.length).toBeGreaterThan(0);
    const text = JSON.stringify(result);
    expect(text).not.toContain(T);
    expect(text).not.toContain(basename(T));
    for (const r of result) {
      expect(r.id.startsWith("/")).toBe(false);
      expect(r.name.startsWith("/")).toBe(false);
      expect(Object.keys(r).sort()).toEqual(["id", "name"]);
    }
  });

  it("test_AC14_cap_500", () => {
    const R = temp("mesh-scan-many-");
    for (let i = 0; i < 510; i++) fakeCheckout(join(R, `r${String(i).padStart(3, "0")}`), `https://example.org/many/r${String(i).padStart(3, "0")}`);
    const out = scanRepos([R]);
    expect(out).toHaveLength(500);
  });

  it("test_AC14_no_child_process", () => {
    const out = scanRepos([T]);
    expect(out.length).toBeGreaterThan(0);
    expect(spawned).toEqual([]);
  });
});
