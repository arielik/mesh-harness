// RL-14 AC-13: the docs cover state time, the efficiency card, the window and the stuck signal
// (docs/specs/RL-14.md, "Types, features, docs"). The OpenAPI document is checked in test/schemas.test.ts.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { HUB_API } from "../src/protocol/hub-api.ts";

const ROOT = join(import.meta.dirname, "..");
const read = (rel: string) => readFileSync(join(ROOT, rel), "utf8");
function section(text: string, title: string): string {
  const start = text.indexOf(`\n## ${title}\n`);
  expect(start, `## ${title}`).toBeGreaterThanOrEqual(0);
  const rest = text.slice(start + title.length + 5);
  const next = rest.search(/^## /m);
  return next < 0 ? rest : rest.slice(0, next);
}

describe("RL-14 AC-13 docs", () => {
  it("test_AC13_docs", () => {
    const c = read("docs/guide/concepts.md");
    expect(c.indexOf("## Efficiency"), "after Pulse health").toBeGreaterThan(c.indexOf("## Pulse health"));
    const s = section(c, "Efficiency");
    for (const w of [
      "GET /v1/goals/:id/efficiency",
      "GET /v1/efficiency",
      "GET /v1/stuck",
      "needsYouMs",
      "stalledMs",
      "Absent, not zero",
      "UTC midnight",
      "unmeasured",
      "events_retention_days",
      "downtime",
      "page load",
      "per session",
      "per step",
    ])
      expect(s, w).toContain(w);
    expect(s).toMatch(/no score/);
    const o = read("docs/guide/operations.md");
    expect(section(o, "Upgrading to 0.1.45")).toContain("0.1.36 (RL-14) adds time per session state");
    expect(o).toContain("`efficiency`");
    const plan = read("docs/plan/implementation-plan.md");
    expect(plan).toContain("| `GET /v1/goals/:id/efficiency`, `GET /v1/efficiency`, `GET /v1/stuck` |");
    for (const path of ["/v1/goals/:id/efficiency", "/v1/efficiency", "/v1/stuck"]) {
      const row = HUB_API.find((r) => r.method === "GET" && r.path === path);
      expect(row, path).toMatchObject({ rule: "member", scope: "goals:read" });
    }
  });
});
