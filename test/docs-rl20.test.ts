// RL-20 AC-10: the preset check in the API registry (a read: no idempotency key, the `read` flag the
// same in the app), the feature, and the docs (docs/specs/RL-20.md, "Docs, schemas").

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createApp } from "../src/hub/app.ts";
import type { HubService } from "../src/hub/service.ts";
import { HUB_API, HUB_FEATURES, hubOpenApi, IDEMPOTENCY_HEADER, PresetCheck, PresetCheckResult } from "../src/protocol/index.ts";

const ROOT = join(import.meta.dirname, "..");
const read = (rel: string) => readFileSync(join(ROOT, rel), "utf8");
function section(text: string, title: string): string {
  const start = text.search(new RegExp(`^## ${title}\\s*$`, "m"));
  expect(start, `## ${title}`).toBeGreaterThanOrEqual(0);
  const rest = text.slice(start + `## ${title}`.length);
  const next = rest.search(/^## /m);
  return next < 0 ? rest : rest.slice(0, next);
}

describe("RL-20 AC-10 route, feature, docs", () => {
  it("test_AC10_route_and_read_flag", () => {
    const route = HUB_API.find((r) => r.method === "POST" && r.path === "/v1/presets/check");
    expect(route).toMatchObject({ rule: "member", scope: "goals:read", tag: "analysis", read: true });
    expect(route?.onBehalfOf).toBeFalsy();
    expect(route?.body).toBe(PresetCheck);
    expect(route?.response).toBe(PresetCheckResult);
    const svc = { config: { url: "http://127.0.0.1:1" } } as unknown as HubService;
    const served = createApp(svc).routes.filter((r) => r.read === true).map((r) => `${r.method} ${r.path}`);
    expect(served).toStrictEqual(["POST /v1/presets/check"]);
    expect(HUB_API.filter((r) => r.read === true).map((r) => `${r.method} ${r.path}`)).toStrictEqual(served);
    const doc = hubOpenApi() as { info: { description: string }; paths: Record<string, Record<string, { parameters?: { name: string }[]; tags: string[] }>> };
    const op = doc.paths["/v1/presets/check"]?.post;
    expect(op?.tags).toStrictEqual(["analysis"]);
    expect((op?.parameters ?? []).map((p) => p.name)).not.toContain(IDEMPOTENCY_HEADER);
    expect((doc.paths["/v1/pulses"]?.post?.parameters ?? []).map((p) => p.name)).toContain(IDEMPOTENCY_HEADER);
    expect(doc.info.description).toContain("POST routes that write accept an idempotency key");
  });

  it("test_AC10_feature_sorted", () => {
    expect(HUB_FEATURES).toContain("preset-check");
    expect([...HUB_FEATURES]).toStrictEqual([...HUB_FEATURES].sort());
  });

  it("test_AC10_no_cost_field", () => {
    for (const k of Object.keys(PresetCheckResult.shape)) expect(k.toLowerCase(), k).not.toMatch(/cost|usd|price|budget/);
  });

  it("test_AC10_docs", () => {
    const pulses = section(read("docs/guide/concepts.md"), "Pulses");
    for (const w of ["**Check a preset**", "POST /v1/presets/check", "preset-check", "goals:read", "writes nothing", "`steps`"]) expect(pulses, w).toContain(w);
    expect(read("docs/guide/auth.md")).toContain("checks presets (`POST /v1/presets/check`");
    const ops = read("docs/guide/operations.md");
    const up = section(ops, "Upgrading to 0\\.1\\.\\d+");
    expect(up).toContain("0.1.39 (RL-20) adds a read-only preset check (`POST /v1/presets/check`");
    expect(up.indexOf("0.1.39 (RL-20)")).toBeLessThan(up.indexOf("0.1.23 has no release package."));
    expect(up).toContain("no migration (schema 12), no daemon change. 0.1.23");
    expect(ops).toContain("`overlap-policy`, `preset-check`, `profile-fit`");
    expect(read("docs/plan/implementation-plan.md")).toContain("| `POST /v1/presets/check` |");
  });
});
