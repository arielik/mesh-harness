// RL-10 AC-12: the docs cover the RL-10 changes (docs/specs/RL-10.md, "Docs, events, schemas"):
// concepts (the target repo of a finding; moves), the scheduled-reviews guide "Clean-audit goals",
// the mesh skill (`mesh_review` items may carry `repo`), the events catalog and the API table.
// `MESH_SKILL` equals `skills/mesh/SKILL.md`. The route table and the OpenAPI document are checked in
// test/schemas.test.ts. The review step for team-, company- or person-specific names is not automated.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { MESH_SKILL } from "../src/protocol/index.ts";

const ROOT = join(import.meta.dirname, "..");
const read = (rel: string) => readFileSync(join(ROOT, rel), "utf8");
const paragraphs = (t: string) => t.split(/\n\s*\n/);
/** The `## <title>` section of `text` (to the next `## `), expected to exist. */
function section(text: string, title: string): string {
  const re = new RegExp(`^## ${title.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*$`, "m");
  const start = text.search(re);
  expect(start, `## ${title}`).toBeGreaterThanOrEqual(0);
  const rest = text.slice(start + `## ${title}`.length);
  const next = rest.search(/^## /m);
  return next < 0 ? rest : rest.slice(0, next);
}

describe("RL-10 AC-12 docs", () => {
  it("test_AC12_concepts", () => {
    const ps = paragraphs(section(read("docs/guide/concepts.md"), "Clean-audit goals"));
    // Control: the RL-9 section is there (it has the sink paragraph).
    expect(ps.some((p) => /\bsink\b/.test(p))).toBe(true);
    expect(ps.some((p) => /target repo/i.test(p)), "a paragraph on the target repo").toBe(true);
    expect(ps.some((p) => /\bmove(s|d)?\b/i.test(p) && p.includes("mesh items retarget")), "a paragraph on moves and mesh items retarget").toBe(true);
  });

  it("test_AC12_guide", () => {
    const ps = paragraphs(section(read("docs/guide/scheduled-reviews.md"), "Clean-audit goals"));
    expect(ps.some((p) => /\bsink\b/.test(p)), "control: the RL-9 section").toBe(true);
    expect(ps.some((p) => /`repo`|\brepo\b/.test(p) && /\bkey\b/.test(p) && /other repos|another repo|checks? (other|several)/i.test(p)), "auditors that check other repos set repo and keep it in the key").toBe(true);
    expect(ps.some((p) => /\bfold\b|\bmoves\b/.test(p) && /\bopen\b/.test(p)), "the fold moves open steps").toBe(true);
    expect(ps.some((p) => p.includes("mesh items retarget") && p.includes("--dry-run")), "retarget with --dry-run first").toBe(true);
  });

  it("test_AC12_skill", () => {
    expect(read("skills/mesh/SKILL.md")).toBe(MESH_SKILL);
    expect(paragraphs(MESH_SKILL).some((p) => p.includes("mesh_review") && /`repo`|\brepo\b/.test(p) && /target|other repo|about/i.test(p)), "a paragraph on mesh_review items with repo").toBe(true);
  });

  it("test_AC12_events", () => {
    const events = read("docs/events.md");
    // Control: the RL-9 entries.
    expect(events).toContain("goal.sunk");
    expect(events).toContain("item.retargeted");
    const ps = paragraphs(events);
    expect(ps.some((p) => p.includes("step.dropped") && /\bmoved\b/.test(p) && /\bto\b/.test(p)), "step.dropped reason moved with to").toBe(true);
    expect(ps.some((p) => p.includes("step.reopened") && /\bmoved\b/.test(p)), "step.reopened reason moved").toBe(true);
  });

  it("test_AC12_api_table", () => {
    const lines = read("docs/plan/implementation-plan.md").split("\n");
    expect(lines.some((l) => l.includes("/v1/items/sink")), "control: /v1/items/sink").toBe(true);
    expect(lines.some((l) => l.includes("/v1/items/retarget")), "/v1/items/retarget").toBe(true);
  });
});
