// RL-28 AC-17: the docs name goal members, the reopen of a done goal, the scope goals:join and the
// 0.1.45 upgrade (docs/specs/RL-28.md, "Docs").

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = join(import.meta.dirname, "..");
const read = (p: string) => readFileSync(join(ROOT, p), "utf8");

describe("RL-28 AC-17 docs", () => {
  it("test_AC17_events", () => {
    const rows = read("docs/events.md").split("\n");
    for (const type of ["goal.joined", "goal.left", "goal.reopened"]) expect(rows.some((l) => l.startsWith(`| \`${type}\` |`)), type).toBe(true);
    const via = rows.find((l) => l.startsWith("A request a service makes for a person")) ?? "";
    expect(via).toContain("`goal.joined`, `goal.left`, `goal.reopened`");
  });

  it("test_AC17_concepts", () => {
    const text = read("docs/guide/concepts.md");
    expect(text).toContain("**Members**");
    expect(text).toContain("mesh goal ls --mine");
    expect(text).toContain("A plan approved on a done goal that adds work reopens it to in_progress; a replan reopens it to design; dropped goals stay closed");
  });

  it("test_AC17_auth", () => {
    expect(read("docs/guide/auth.md")).toContain("`goals:join` joins and leaves a goal for a person");
  });

  it("test_AC17_operations", () => {
    const text = read("docs/guide/operations.md");
    const para = text.split("\n").find((l) => l.includes("0.1.45 (RL-28) adds goal members")) ?? "";
    expect(para).toContain("`goals:join`");
    expect(para).toContain("schema 15");
    expect(para).toContain("back up first");
    expect(para).toContain("`goal-members`");
    expect(text).toContain("| 15 | 0.1.45 | goal members (`goal_member`) |");
    expect(text).toContain("RL-28 adds `goal-members`");
  });
});
