// RL-18 AC-10: the docs cover spot checks (docs/specs/RL-18.md, "Features, docs, schemas"): concepts
// (Spot checks, after Calibration; Pulse health), install, the events list, operations and the API
// table. The generated OpenAPI document and skills are checked in test/schemas.test.ts.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { HUB_API, MESH_DEBRIEF_SKILL } from "../src/protocol/index.ts";

const ROOT = join(import.meta.dirname, "..");
const read = (rel: string) => readFileSync(join(ROOT, rel), "utf8");
function section(text: string, title: string): string {
  const start = text.search(new RegExp(`^## ${title}\\s*$`, "m"));
  expect(start, `## ${title}`).toBeGreaterThanOrEqual(0);
  const rest = text.slice(start + `## ${title}`.length);
  const next = rest.search(/^## /m);
  return next < 0 ? rest : rest.slice(0, next);
}

describe("RL-18 AC-10 docs", () => {
  it("test_AC10_docs", () => {
    const c = read("docs/guide/concepts.md");
    expect(c.indexOf("## Spot checks"), "after Calibration").toBeGreaterThan(c.indexOf("## Calibration"));
    expect(c.indexOf("## Spot checks"), "before Clean-audit goals").toBeLessThan(c.indexOf("## Clean-audit goals"));
    const s = section(c, "Spot checks");
    for (const w of ["spot_checks", "min_per_week", "humanDecisionShare", "mesh_spot_check", "sha256", "trial", "spot-check.opened"]) expect(s, w).toContain(w);
    expect(section(c, "Calibration")).toContain("disagree");
    const h = section(c, "Pulse health");
    for (const w of ["decisions", "humanDecisionShare", "spotChecks", "warning"]) expect(h, w).toContain(w);
    expect(read("docs/guide/install.md")).toContain("spot_checks:");
    const ev = read("docs/events.md");
    for (const w of ["`spot-check.opened`", "`spot-check.decided`", "`disagreements`"]) expect(ev, w).toContain(w);
    expect(read("docs/guide/operations.md")).toContain("0.1.35 (RL-18)");
    expect(read("docs/plan/implementation-plan.md")).toContain("| `POST /v1/steps/:id/spot-checks` |");
    expect(HUB_API.some((r) => r.method === "POST" && r.path === "/v1/steps/:id/spot-checks")).toBe(true);
    expect(MESH_DEBRIEF_SKILL).toContain("## Spot checks");
    expect(MESH_DEBRIEF_SKILL).toContain("mesh_spot_check");
  });
});
