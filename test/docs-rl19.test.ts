// RL-19 AC-11: the docs cover the findings roll-up (docs/specs/RL-19.md, "Docs, schemas"): concepts
// (Findings roll-up inside Pulse health), scheduled reviews, operations and the API table; the route
// in the API registry, without any cost field. The generated files are checked in test/schemas.test.ts.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { FindingsRollup, HUB_API, RollupReport, RollupRow } from "../src/protocol/index.ts";

const ROOT = join(import.meta.dirname, "..");
const read = (rel: string) => readFileSync(join(ROOT, rel), "utf8");
function section(text: string, title: string): string {
  const start = text.search(new RegExp(`^## ${title}\\s*$`, "m"));
  expect(start, `## ${title}`).toBeGreaterThanOrEqual(0);
  const rest = text.slice(start + `## ${title}`.length);
  const next = rest.search(/^## /m);
  return next < 0 ? rest : rest.slice(0, next);
}

describe("RL-19 AC-11 docs", () => {
  it("test_AC11_docs", () => {
    const h = section(read("docs/guide/concepts.md"), "Pulse health");
    expect(h).toContain("### Findings roll-up");
    for (const w of ["GET /v1/findings/rollup", "findings-rollup", "target repo", "`confirmed`", "latestReport", "kind:", "trial=include"]) expect(h, w).toContain(w);
    const sr = read("docs/guide/scheduled-reviews.md");
    expect(section(sr, "Read the results")).toContain("GET /v1/findings/rollup");
    expect(section(sr, "Pick or write a relay preset")).toContain("kind:");
    const ops = read("docs/guide/operations.md");
    const up = section(ops, "Upgrading to 0.1.46");
    expect(up).toContain("0.1.38 (RL-19) adds a findings roll-up per preset and repo (`GET /v1/findings/rollup`");
    expect(up.indexOf("0.1.38 (RL-19)")).toBeLessThan(up.indexOf("0.1.23 has no release package."));
    expect(up).toContain("no migration (schema 12)");
    expect(ops).toContain("`efficiency`, `findings-rollup`, `fleet-pause`, `health`");
    expect(read("docs/plan/implementation-plan.md")).toContain("| `GET /v1/findings/rollup` |");
    const route = HUB_API.find((r) => r.method === "GET" && r.path === "/v1/findings/rollup");
    expect(route).toMatchObject({ rule: "member", scope: "goals:read", tag: "analysis" });
    expect(route?.onBehalfOf).toBeFalsy();
    expect(route?.response).toBe(FindingsRollup);
  });

  it("test_AC11_no_cost_field", () => {
    const keys = [...Object.keys(RollupRow.shape), ...Object.keys(RollupReport.shape), ...Object.keys(FindingsRollup.shape)];
    for (const k of keys) expect(k.toLowerCase(), k).not.toMatch(/cost|usd|price/);
  });
});
