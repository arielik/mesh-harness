// RL-5 AC-02: `catalogDigest`, `unifiedDiff`, `canonicalKey`. Written from the spec's contracts only
// (docs/specs/RL-5.md). Expected strings are built here from the documented rules.

import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import * as core from "./index.ts";

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- new exports, read loosely
const C = core as any;
const sha = (s: string) => createHash("sha256").update(s, "utf8").digest("hex");
const HA = sha("a");
const HB = sha("b");

describe("RL-5 AC-02 catalogDigest", () => {
  it("test_AC02_catalog_digest", () => {
    const want = sha(`agents/a.md\t${HA}\nagents/b.md\t${HB}\n`);
    expect(C.catalogDigest([{ path: "agents/b.md", hash: HB }, { path: "agents/a.md", hash: HA }])).toBe(want);
    expect(C.catalogDigest([{ path: "agents/a.md", hash: HA }, { path: "agents/b.md", hash: HB }])).toBe(want);
    expect(C.catalogDigest([])).toBe(sha(""));
    expect(C.catalogDigest([])).toBe("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
    // Code-point order: "B" (0x42) before "a" (0x61).
    expect(C.catalogDigest([{ path: "agents/a.md", hash: HA }, { path: "agents/B.md", hash: HB }])).toBe(sha(`agents/B.md\t${HB}\nagents/a.md\t${HA}\n`));
  });
});

describe("RL-5 AC-02 unifiedDiff", () => {
  it("test_AC02_unified_diff_example", () => {
    expect(C.unifiedDiff("a\nb\nc\n", "a\nB\nc\n", "x", "y")).toBe("--- x\n+++ y\n@@ -1,3 +1,3 @@\n a\n-b\n+B\n c\n");
  });

  it("test_AC02_unified_diff_equal_crlf", () => {
    expect(C.unifiedDiff("a\r\nb\r\n", "a\nb\n", "x", "y")).toBe("");
    expect(C.unifiedDiff("a\nb", "a\nb\n", "x", "y")).toBe("");
    // Control: different texts give a diff.
    expect(C.unifiedDiff("a\n", "b\n", "x", "y")).not.toBe("");
  });

  it("test_AC02_unified_diff_add_only", () => {
    expect(C.unifiedDiff("", "p\nq\n", "x", "y")).toBe("--- x\n+++ y\n@@ -0,0 +1,2 @@\n+p\n+q\n");
    expect(C.unifiedDiff("p\n", "", "x", "y")).toBe("--- x\n+++ y\n@@ -1,1 +0,0 @@\n-p\n");
  });

  it("test_AC02_unified_diff_hunks", () => {
    const lines = Array.from({ length: 20 }, (_, i) => `l${i + 1}`);
    const text = (ls: string[]) => `${ls.join("\n")}\n`;
    const change = (...at: number[]) => lines.map((l, i) => (at.includes(i + 1) ? `${l}X` : l));
    // 6 unchanged lines between the changes: one hunk.
    const one = C.unifiedDiff(text(lines), text(change(5, 12)), "x", "y") as string;
    const h1 = one.split("\n").filter((l) => l.startsWith("@@"));
    expect(h1).toStrictEqual(["@@ -2,14 +2,14 @@"]);
    const body1 = lines.slice(1, 15).flatMap((l, i) => (i + 2 === 5 || i + 2 === 12 ? [`-${l}`, `+${l}X`] : [` ${l}`]));
    expect(one).toBe(`--- x\n+++ y\n@@ -2,14 +2,14 @@\n${body1.join("\n")}\n`);
    // 7 unchanged lines between: two hunks.
    const two = C.unifiedDiff(text(lines), text(change(5, 13)), "x", "y") as string;
    expect(two.split("\n").filter((l) => l.startsWith("@@"))).toStrictEqual(["@@ -2,7 +2,7 @@", "@@ -10,7 +10,7 @@"]);
    // Within a run of changed lines all `-` before all `+`.
    expect(C.unifiedDiff("a\nb\nc\nd\n", "a\nB\nC\nd\n", "x", "y")).toBe("--- x\n+++ y\n@@ -1,4 +1,4 @@\n a\n-b\n-c\n+B\n+C\n d\n");
    // `,<n>` also when n is 1.
    expect(C.unifiedDiff("a\n", "b\n", "x", "y")).toBe("--- x\n+++ y\n@@ -1,1 +1,1 @@\n-a\n+b\n");
  });
});

describe("RL-5 AC-02 canonicalKey", () => {
  it("test_AC02_canonical_key", () => {
    expect(C.canonicalKey("git.example.com/team/agents", "rev")).toBe("agents/rev");
    expect(C.canonicalKey("agents", "rev")).toBe("agents/rev");
    expect(C.canonicalKey("git.example.com/team/alpha", "reviewer")).toBe("alpha/reviewer");
  });
});
