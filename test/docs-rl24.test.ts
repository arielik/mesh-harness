// RL-24 AC-18 (unit): the scope, the routes with their required header in the OpenAPI document, the
// feature, and the docs (docs/specs/RL-24.md, "Docs").

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { FleetPause, FleetState, HUB_FEATURES, hubOpenApi, ON_BEHALF_OF_HEADER, SERVICE_SCOPES, SlotReason } from "../src/protocol/index.ts";

const ROOT = join(import.meta.dirname, "..");
const read = (rel: string) => readFileSync(join(ROOT, rel), "utf8");
function section(text: string, title: string): string {
  const start = text.search(new RegExp(`^## ${title}\\s*$`, "m"));
  expect(start, `## ${title}`).toBeGreaterThanOrEqual(0);
  const rest = text.slice(start + `## ${title}`.length);
  const next = rest.search(/^## /m);
  return next < 0 ? rest : rest.slice(0, next);
}

describe("RL-24 AC-18 scope, routes, feature, docs", () => {
  it("test_AC18_scope_feature_reason", () => {
    expect(SERVICE_SCOPES).toContain("fleet:pause");
    expect(HUB_FEATURES).toContain("fleet-pause");
    expect([...HUB_FEATURES]).toStrictEqual([...HUB_FEATURES].sort());
    expect(SlotReason.options).toContain("fleet_paused");
  });

  it("test_AC18_openapi_routes_and_header", () => {
    const doc = hubOpenApi() as { paths: Record<string, Record<string, { parameters?: { name: string; description?: string }[]; description: string; responses: Record<string, unknown> }>> };
    for (const path of ["/v1/fleet/pause", "/v1/fleet/resume"]) {
      const op = doc.paths[path]?.post;
      expect(op, path).toBeDefined();
      const h = (op?.parameters ?? []).find((p) => p.name === ON_BEHALF_OF_HEADER);
      expect(h?.description, path).toContain("required for a service on this route");
      expect(op?.description).toContain("`fleet:pause`");
    }
    const stored = JSON.parse(read("schemas/hub-api.openapi.json")) as { paths: Record<string, unknown> };
    expect(Object.keys(stored.paths)).toEqual(expect.arrayContaining(["/v1/fleet/pause", "/v1/fleet/resume"]));
    expect(JSON.stringify(stored.paths["/healthz"])).toContain('"paused"');
  });

  it("test_AC18_no_cost_field", () => {
    for (const k of [...Object.keys(FleetPause.shape), ...Object.keys(FleetState.shape)]) expect(k.toLowerCase(), k).not.toMatch(/cost|usd|price|budget/);
  });

  it("test_AC18_docs", () => {
    const auth = read("docs/guide/auth.md");
    for (const w of ["`fleet:pause`", "`POST /v1/fleet/pause`", "`POST /v1/fleet/resume`", "MESH-OQ-AIOPS-12", "only ones where act-for keeps the person's admin role", "`not-admin`", "`fleet-already-paused`", "`fleet-not-paused`", "`fleet-paused`"]) expect(auth, w).toContain(w);
    const ops = read("docs/guide/operations.md");
    const pause = section(ops, "Pause the fleet");
    for (const w of ["mesh fleet pause", "do not put secrets in the reason", "5 s", "`fleet_paused`", "no message", "is not offered again", "already queued"]) expect(pause, w).toContain(w);
    const up = section(ops, "Upgrading to 0\\.1\\.\\d+");
    for (const w of ["RL-24", "`fleet:pause`", "`fleet-pause`", "schema 13"]) expect(up, w).toContain(w);
    expect(up.indexOf("RL-24")).toBeLessThan(up.indexOf("0.1.23 has no release package."));
    expect(ops).toContain("`findings-rollup`, `fleet-pause`, `health`");
    const sr = read("docs/guide/scheduled-reviews.md");
    for (const w of ["`fleet_paused`", "`hub_down`", "Nothing is caught up after a resume", "queued slot released while paused is skipped"]) expect(sr, w).toContain(w);
    const howto = read("docs/guide/howto.md");
    for (const w of ["mesh fleet pause", "mesh fleet resume"]) expect(howto, w).toContain(w);
    const ev = read("docs/events.md");
    for (const w of ["`fleet.paused`", "`fleet.resumed`", "`fleet_paused`", "`fleet paused`", "`pausedAt`", "`withdrawn`"]) expect(ev, w).toContain(w);
    expect(read(".github/workflows/ci.yml")).toMatch(/vitest run .*test\/fleet-pause-replicas\.test\.ts.*test\/fleet-pause\.test\.ts/);
  });
});
