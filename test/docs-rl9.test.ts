// RL-9 AC-18: the docs cover the RL-9 changes (docs/specs/RL-9.md, "Docs, events, schemas"):
// concepts, the scheduled-reviews guide, the mesh skill, the events catalog and the API table.
// `MESH_SKILL` equals `skills/mesh/SKILL.md`. The route table and the OpenAPI document are checked in
// test/schemas.test.ts. The review step for team-, company- or person-specific names is not
// automated here.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { MESH_SKILL } from "../src/protocol/index.ts";

const ROOT = join(import.meta.dirname, "..");
const read = (rel: string) => readFileSync(join(ROOT, rel), "utf8");
const paragraphs = (t: string) => t.split(/\n\s*\n/);

describe("RL-9 AC-18 docs", () => {
  it("test_AC18_concepts", () => {
    const concepts = read("docs/guide/concepts.md");
    const start = concepts.search(/^## Clean-audit goals\s*$/m);
    expect(start, "## Clean-audit goals in concepts").toBeGreaterThanOrEqual(0);
    const rest = concepts.slice(start + "## Clean-audit goals".length);
    const next = rest.search(/^## /m);
    const section = next < 0 ? rest : rest.slice(0, next);
    // The checks below read only that section, so an unrelated paragraph cannot satisfy them.
    const ps = paragraphs(section);
    expect(ps.some((p) => /clean-audit goal/i.test(p) && /\bsink\b/.test(p)), "a paragraph on clean-audit goals and the sink").toBe(true);
    expect(ps.some((p) => /\bS1\b/.test(p) && /severity/i.test(p) && /\bready\b|\border\b/i.test(p)), "a paragraph on the severity order").toBe(true);
    expect(ps.some((p) => /\brequires\b/.test(p)), "a paragraph on requires").toBe(true);
    expect(ps.some((p) => p.includes("mesh goal drop")), "a paragraph on mesh goal drop").toBe(true);
  });

  it("test_AC18_guide", () => {
    const guide = read("docs/guide/scheduled-reviews.md");
    const debrief = guide.search(/^## Debrief/m);
    // Control: the Debrief section exists.
    expect(debrief).toBeGreaterThanOrEqual(0);
    const cag = guide.search(/^## Clean-audit goals\s*$/m);
    expect(cag, "## Clean-audit goals").toBeGreaterThan(debrief);
  });

  it("test_AC18_skill", () => {
    expect(read("skills/mesh/SKILL.md")).toBe(MESH_SKILL);
    const ps = paragraphs(MESH_SKILL);
    expect(ps.some((p) => /finding step/i.test(p) && /\bbrief\b/.test(p) && /\bworktree\b/.test(p) && /tracking row/.test(p)), "a paragraph on finding steps").toBe(true);
  });

  it("test_AC18_events", () => {
    const events = read("docs/events.md");
    expect(events).toContain("goal.sunk");
    expect(events).toContain("goal.sink_failed");
    expect(events.split("\n").some((l) => l.includes("goal.dropped") && l.includes("person")), "a line with goal.dropped and person").toBe(true);
    expect(paragraphs(events).some((p) => p.includes("step.reopened") && p.includes("refiled") && p.includes("reverted")), "step.reopened with refiled and reverted").toBe(true);
  });

  it("test_AC18_api_table", () => {
    const lines = read("docs/plan/implementation-plan.md").split("\n");
    expect(lines.some((l) => l.includes("/v1/goals/:id/drop")), "/v1/goals/:id/drop").toBe(true);
    expect(lines.some((l) => l.includes("/v1/items/sink")), "/v1/items/sink").toBe(true);
  });
});
