import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { jsonSchemas } from "../src/protocol/index.ts";

describe("published JSON Schemas", () => {
  it("match the protocol (run `pnpm schemas` after changing src/protocol)", () => {
    for (const [name, schema] of Object.entries(jsonSchemas())) {
      const committed = readFileSync(join(import.meta.dirname, "..", "schemas", `${name}.json`), "utf8");
      expect(`${JSON.stringify(schema, null, 2)}\n`, `schemas/${name}.json is out of date: run pnpm schemas`).toBe(committed);
    }
  });
});
