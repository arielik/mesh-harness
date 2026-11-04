// pnpm schemas: write schemas/*.json from src/protocol (checked for drift by test/schemas.test.ts).
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { jsonSchemas } from "../src/protocol/index.ts";

const dir = join(import.meta.dirname, "..", "schemas");
mkdirSync(dir, { recursive: true });
for (const [name, schema] of Object.entries(jsonSchemas())) writeFileSync(join(dir, `${name}.json`), `${JSON.stringify(schema, null, 2)}\n`);
process.stdout.write(`wrote ${Object.keys(jsonSchemas()).length} schemas to ${dir}\n`);
