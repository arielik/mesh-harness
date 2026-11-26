// RL-17 AC-11: the docs and the API description cover the change timeline and the before/after view
// (docs/specs/RL-17.md, "Docs, schemas").

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { HUB_API } from "../src/protocol/index.ts";

const ROOT = join(import.meta.dirname, "..");
const read = (rel: string) => readFileSync(join(ROOT, rel), "utf8");
function section(text: string, title: string, level = "##"): string {
  const re = new RegExp(`^${level} ${title.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*$`, "m");
  const start = text.search(re);
  expect(start, `${level} ${title}`).toBeGreaterThanOrEqual(0);
  const rest = text.slice(start + `${level} ${title}`.length);
  const next = rest.search(level === "##" ? /^## /m : /^##+ /m);
  return next < 0 ? rest : rest.slice(0, next);
}

describe("RL-17 AC-11 docs", () => {
  it("test_AC11_concepts", () => {
    const c = read("docs/guide/concepts.md");
    expect(c.indexOf("## Changes and before/after")).toBeGreaterThan(c.indexOf("## Agent statistics"));
    const s = section(c, "Changes and before/after");
    for (const w of ["`GET /v1/changes`", "`GET /v1/agents/:key/compare", "`previous`", "`sightings`", "**Retention:**", "**no score**"]) expect(s, w).toContain(w);
  });

  it("test_AC11_events_operations_plan_api", () => {
    const ev = read("docs/events.md").split("\n");
    expect(ev.some((l) => l.startsWith("| `pulse.created`") && l.includes("`agents`"))).toBe(true);
    expect(ev.some((l) => l.startsWith("| `pulse.updated`") && l.includes("`sha256`") && l.includes("`agents`"))).toBe(true);
    const o = read("docs/guide/operations.md");
    expect(section(o, "Upgrading to 0.1.44")).toContain("0.1.34 (RL-17)");
    expect(section(o, "Probes", "###")).toContain("`agent-compare`");
    const plan = read("docs/plan/implementation-plan.md");
    expect(plan).toContain("| `GET /v1/changes` |");
    expect(plan).toContain("| `GET /v1/agents/:key/compare?from=&to=` |");
    const paths = HUB_API.map((r) => `${r.method} ${r.path}`);
    expect(paths).toContain("GET /v1/changes");
    expect(paths).toContain("GET /v1/agents/:key/compare");
  });
});
