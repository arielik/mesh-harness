// RL-16 AC-09: the docs cover profile fitting (docs/specs/RL-16.md, "Docs, schemas"): concepts
// (Profile fitting, after Runs), operations (Upgrading to 0.1.32), the API table, the route in the
// API description and the skill. The generated files are checked in test/schemas.test.ts.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { HUB_API } from "../src/protocol/hub-api.ts";

const ROOT = join(import.meta.dirname, "..");
const read = (rel: string) => readFileSync(join(ROOT, rel), "utf8");
function section(text: string, title: string): string {
  const start = text.search(new RegExp(`^## ${title.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*$`, "m"));
  expect(start, `## ${title}`).toBeGreaterThanOrEqual(0);
  const rest = text.slice(start + title.length + 3);
  const next = rest.search(/^## /m);
  return next < 0 ? rest : rest.slice(0, next);
}

describe("RL-16 AC-09 docs", () => {
  it("test_AC09_concepts", () => {
    const c = read("docs/guide/concepts.md");
    expect(c.indexOf("## Profile fitting"), "after Runs").toBeGreaterThan(c.indexOf("## Runs"));
    const s = section(c, "Profile fitting");
    for (const w of [
      "GET /v1/profiles/:name/fit",
      "mesh profile fit",
      "hashes",
      "minRuns",
      "minShare",
      "Bash(w *)",
      "Narrow",
      "trial=include",
      "Nothing is saved",
      "no-command",
      "not-a-word",
      "runs-anything",
      "already-allowed",
      "denied-by-profile",
      "few-runs",
      "rare",
      "refused",
      "mesh-tool",
      "allowed",
      "already-denied",
    ]) {
      expect(s, w).toContain(w);
    }
  });

  it("test_AC09_guides_api_skill", () => {
    expect(section(read("docs/guide/operations.md"), "Upgrading to 0.1.36")).toContain("0.1.33 (RL-16)");
    expect(read("docs/plan/implementation-plan.md")).toContain("| `GET /v1/profiles/:name/fit` |");
    const r = HUB_API.find((x) => x.path === "/v1/profiles/:name/fit" && x.method === "GET");
    expect(r?.scope).toBe("goals:read");
    expect(r?.onBehalfOf).toBeUndefined();
    expect(read("skills/mesh/SKILL.md")).toContain("mesh profile fit");
  });
});
