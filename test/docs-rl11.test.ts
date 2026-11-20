// RL-11 AC-15: the docs cover the RL-11 changes (docs/specs/RL-11.md, "Docs, events, schemas"):
// concepts (Telemetry, Runs, Pulses, Calibration, Agent statistics), the scheduled-reviews guide
// (trials while tuning), operations (Probes, the upgrade section), the events catalog, the API table
// and the mesh skill. The OpenAPI document and the route table are checked in test/schemas.test.ts.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { MESH_SKILL } from "../src/protocol/index.ts";

const ROOT = join(import.meta.dirname, "..");
const read = (rel: string) => readFileSync(join(ROOT, rel), "utf8");
const paragraphs = (t: string) => t.split(/\n\s*\n/);
/** The `<level> <title>` section of `text` (to the next heading of that level or higher). */
function section(text: string, title: string, level = "##"): string {
  const re = new RegExp(`^${level} ${title.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*$`, "m");
  const start = text.search(re);
  expect(start, `${level} ${title}`).toBeGreaterThanOrEqual(0);
  const rest = text.slice(start + `${level} ${title}`.length);
  const next = rest.search(level === "##" ? /^## /m : /^##+ /m);
  return next < 0 ? rest : rest.slice(0, next);
}

describe("RL-11 AC-15 docs", () => {
  it("test_AC15_concepts", () => {
    const c = read("docs/guide/concepts.md");
    const tel = section(c, "Telemetry");
    expect(tel).toContain("toolsUsed");
    expect(paragraphs(tel).some((p) => p.includes("denied") && /first word/i.test(p) && /never sent/i.test(p)), "denied keeps the first word only").toBe(true);
    const runs = section(c, "Runs");
    expect(runs).toContain("GET /v1/runs");
    expect(runs).toMatch(/no (single )?score/i);
    expect(runs).toMatch(/overlap/i);
    expect(runs).toContain("allDismissed");
    expect(section(c, "Pulses")).toContain("--trial");
    expect(section(c, "Calibration")).toMatch(/trial/i);
    expect(section(c, "Agent statistics")).toContain("trial=include");
  });

  it("test_AC15_guide", () => {
    const ps = paragraphs(read("docs/guide/scheduled-reviews.md"));
    expect(ps.some((p) => p.includes("--trial") && /stick|stays dismissed/i.test(p) && /capacity/i.test(p)), "trial while tuning: what changes and what does not").toBe(true);
  });

  it("test_AC15_operations", () => {
    const o = read("docs/guide/operations.md");
    const probes = section(o, "Probes", "###");
    expect(probes).toContain("version");
    expect(probes).toContain("features");
    expect(section(o, "Upgrading to 0.1.33")).toContain("0.1.30 adds `GET /v1/runs`");
  });

  it("test_AC15_events_api_skill", () => {
    const ev = read("docs/events.md");
    expect(paragraphs(ev).some((p) => p.includes("pulse.fired") && p.includes("`trial`"))).toBe(true);
    expect(ev).toContain("toolsUsed");
    const lines = read("docs/plan/implementation-plan.md").split("\n");
    expect(lines.some((l) => l.includes("`GET /v1/runs`")), "/v1/runs in the API table").toBe(true);
    expect(lines.some((l) => l.includes("/v1/agents/:key/stats") && l.includes("trial=include"))).toBe(true);
    expect(read("skills/mesh/SKILL.md")).toBe(MESH_SKILL);
    expect(MESH_SKILL).toContain("--trial");
  });
});
