// RL-27 AC-09: docs/guide/auth.md states the team form's stuck floors and the meaning of the stuck
// items' `at`, `forMs` and `turns` (docs/specs/RL-27.md, "Docs").

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = join(import.meta.dirname, "..");

describe("RL-27 AC-09 docs", () => {
  it("test_AC09_auth_guide", () => {
    const text = readFileSync(join(ROOT, "docs/guide/auth.md"), "utf8");
    const para = text.split("\n").find((l) => l.startsWith("**Team reads**")) ?? "";
    expect(para).toContain("stuck steps and sessions (the `GET /v1/stuck` rules at `needsYouMs` and `turns`); those two values are the only stuck thresholds (an item exactly at a floor is returned)");
    expect(para).toContain("a stuck session's `at` is the instant it entered needs_you and its `forMs` the time since");
    expect(para).toContain("a stuck step's `turns` is its full count since its last commit (RL-27)");
  });
});
