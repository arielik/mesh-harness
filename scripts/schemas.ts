// pnpm schemas: write schemas/*.json from src/protocol (checked for drift by test/schemas.test.ts).
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { hubOpenApi, jsonSchemas, MESH_DEBRIEF_SKILL, MESH_SKILL } from "../src/protocol/index.ts";

const dir = join(import.meta.dirname, "..", "schemas");
mkdirSync(dir, { recursive: true });
for (const [name, schema] of Object.entries(jsonSchemas())) writeFileSync(join(dir, `${name}.json`), `${JSON.stringify(schema, null, 2)}\n`);
writeFileSync(join(dir, "hub-api.openapi.json"), `${JSON.stringify(hubOpenApi(), null, 2)}\n`);
// The mesh skills, as files people can read on GitHub or install by hand.
for (const [name, text] of [
  ["mesh", MESH_SKILL],
  ["mesh-debrief", MESH_DEBRIEF_SKILL],
] as const) {
  const skillDir = join(import.meta.dirname, "..", "skills", name);
  mkdirSync(skillDir, { recursive: true });
  writeFileSync(join(skillDir, "SKILL.md"), text);
}
process.stdout.write(`wrote ${Object.keys(jsonSchemas()).length} schemas, the hub API, the mesh skill and the mesh-debrief skill\n`);
