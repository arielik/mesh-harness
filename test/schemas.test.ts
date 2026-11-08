import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { HUB_API, hubOpenApi, jsonSchemas, MESH_SKILL } from "../src/protocol/index.ts";
import { createApp } from "../src/hub/app.ts";
import type { HubService } from "../src/hub/index.ts";

describe("published JSON Schemas", () => {
  it("match the protocol (run `pnpm schemas` after changing src/protocol)", () => {
    for (const [name, schema] of Object.entries(jsonSchemas())) {
      const committed = readFileSync(join(import.meta.dirname, "..", "schemas", `${name}.json`), "utf8");
      expect(`${JSON.stringify(schema, null, 2)}\n`, `schemas/${name}.json is out of date: run pnpm schemas`).toBe(committed);
    }
  });
});

describe("hub API document", () => {
  it("is up to date (run `pnpm schemas`)", () => {
    const committed = readFileSync(join(import.meta.dirname, "..", "schemas", "hub-api.openapi.json"), "utf8");
    expect(`${JSON.stringify(hubOpenApi(), null, 2)}\n`).toBe(committed);
  });

  it("lists exactly the routes the hub serves, with the same rule", () => {
    const svc = { config: { url: "http://127.0.0.1:1" } } as unknown as HubService;
    const served = createApp(svc).routes.map((r) => `${r.method} ${r.path} ${r.rule}`).sort();
    const documented = HUB_API.map((r) => `${r.method} ${r.path} ${r.rule}`).sort();
    expect(documented).toEqual(served);
  });

  it("is a valid-looking OpenAPI 3.1 document", () => {
    const doc = hubOpenApi() as { openapi: string; paths: Record<string, Record<string, { operationId: string }>> };
    expect(doc.openapi).toBe("3.1.0");
    const ids = Object.values(doc.paths).flatMap((ops) => Object.values(ops).map((o) => o.operationId));
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe("skills/mesh/SKILL.md", () => {
  it("matches the skill mesh setup installs (run `pnpm schemas`)", () => {
    expect(readFileSync(join(import.meta.dirname, "..", "skills", "mesh", "SKILL.md"), "utf8")).toBe(MESH_SKILL);
  });
});
