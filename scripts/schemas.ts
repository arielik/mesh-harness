// pnpm schemas: write schemas/*.json from src/protocol (checked for drift by test/schemas.test.ts).
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { hubOpenApi, jsonSchemas, MESH_SKILL } from "../src/protocol/index.ts";

const dir = join(import.meta.dirname, "..", "schemas");
mkdirSync(dir, { recursive: true });
for (const [name, schema] of Object.entries(jsonSchemas())) writeFileSync(join(dir, `${name}.json`), `${JSON.stringify(schema, null, 2)}\n`);
writeFileSync(join(dir, "hub-api.openapi.json"), `${JSON.stringify(hubOpenApi(), null, 2)}\n`);
// The mesh skill, as a file people can read on GitHub or install by hand.
const skillDir = join(import.meta.dirname, "..", "skills", "mesh");
mkdirSync(skillDir, { recursive: true });
writeFileSync(join(skillDir, "SKILL.md"), MESH_SKILL);
process.stdout.write(`wrote ${Object.keys(jsonSchemas()).length} schemas, the hub API and the mesh skill\n`);
