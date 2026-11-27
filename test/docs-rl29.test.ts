// RL-29 AC-15: the docs name the decisions route, the via review-submit, the supersede of an older open
// review and the 0.1.46 upgrade (docs/specs/RL-29.md, "Docs").

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = join(import.meta.dirname, "..");
const read = (p: string) => readFileSync(join(ROOT, p), "utf8");

describe("RL-29 AC-15 docs", () => {
  it("test_AC15_events", () => {
    const rows = read("docs/events.md").split("\n");
    const sup = rows.find((l) => l.startsWith("| `review.superseded` |")) ?? "";
    for (const w of ["`lineage`", "`pulse`", "`by`", "`goal`", "`carried`", "superseded by"]) expect(sup, w).toContain(w);
    const disposed = rows.find((l) => l.startsWith("| `item.disposed` |")) ?? "";
    expect(disposed).toContain("review-submit");
    expect(disposed).toContain("`service`");
  });

  it("test_AC15_concepts", () => {
    const text = read("docs/guide/concepts.md");
    const dec = text.split("\n").find((l) => l.includes("**Deciding a review from a client**")) ?? "";
    for (const w of ["POST /v1/steps/:id/decisions", "dismiss", "reason", "defer", "date", "mesh debrief"]) expect(dec, w).toContain(w);
    const sup = text.split("\n").find((l) => l.includes("**A newer run supersedes an older open review**")) ?? "";
    for (const w of ["same pulse", "lineage", "fingerprint", "superseded", "claimed"]) expect(sup, w).toContain(w);
  });

  it("test_AC15_operations", () => {
    const text = read("docs/guide/operations.md");
    expect(text).toContain("Upgrading to 0.1.46");
    const para = text.split("\n").find((l) => l.includes("0.1.46 (RL-29) adds `POST /v1/steps/:id/decisions`")) ?? "";
    for (const w of ["`goals:decide`", "`review-submit`", "`review.superseded`", "`superseded`", "`review-decisions`", "No migration"]) expect(para, w).toContain(w);
    expect(para).toContain("do not downgrade it once a review was decided from a client (an older hub cannot read the `review-submit` via)");
    expect(text).toContain("RL-29 adds `review-decisions`");
  });
});
