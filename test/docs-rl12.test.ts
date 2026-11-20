// RL-12 AC-12: the docs cover pulse run cards and the health scorecard (docs/specs/RL-12.md, "Docs,
// schemas"): concepts (Pulse health, after Clean-audit goals), the scheduled-reviews guide, operations
// (Upgrading to 0.1.31) and the API table. The OpenAPI document is checked in test/schemas.test.ts.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { HUB_API } from "../src/protocol/hub-api.ts";

const ROOT = join(import.meta.dirname, "..");
const read = (rel: string) => readFileSync(join(ROOT, rel), "utf8");
function section(text: string, title: string, level = "##"): string {
  const re = new RegExp(`^${level} ${title.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*$`, "m");
  const start = text.search(re);
  expect(start, `${level} ${title}`).toBeGreaterThanOrEqual(0);
  const rest = text.slice(start + `${level} ${title}`.length);
  const next = rest.search(/^## /m);
  return next < 0 ? rest : rest.slice(0, next);
}

describe("RL-12 AC-12 docs", () => {
  it("test_AC12_concepts", () => {
    const c = read("docs/guide/concepts.md");
    expect(c.indexOf("## Pulse health"), "after Clean-audit goals").toBeGreaterThan(c.indexOf("## Clean-audit goals"));
    const s = section(c, "Pulse health");
    for (const w of ["GET /v1/pulses/:id/runs", "GET /v1/health", "readyAt", "cycleReadyAt", "waitingMs", "delta", "blockedBy", "costPerAcceptedUsd", "sinks", "trial=exclude", "lineage", "page load"]) expect(s, w).toContain(w);
    expect(s).toMatch(/no composite score/);
  });

  it("test_AC12_guides", () => {
    expect(read("docs/guide/scheduled-reviews.md")).toContain("GET /v1/health?days=7");
    const o = read("docs/guide/operations.md");
    expect(section(o, "Upgrading to 0.1.35")).toContain("0.1.31 adds pulse run cards");
    for (const f of ["health", "pulse-runs", "runs", "trial"]) expect(o).toContain(`\`${f}\``);
    const plan = read("docs/plan/implementation-plan.md");
    expect(plan).toContain("| `GET /v1/pulses/:id/runs` |");
    expect(plan).toContain("| `GET /v1/health` |");
  });

  it("test_AC12_api", () => {
    for (const path of ["/v1/pulses/:id/runs", "/v1/health"]) {
      const r = HUB_API.find((x) => x.path === path && x.method === "GET");
      expect(r, path).toBeDefined();
      expect(r?.scope).toBe("goals:read");
      expect(r?.onBehalfOf).toBeUndefined();
    }
  });
});
