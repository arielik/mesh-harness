import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";
import { cruise } from "dependency-cruiser";

const require = createRequire(import.meta.url);
const config = require("../.dependency-cruiser.cjs");

async function violations(paths: string[]) {
  const result = await cruise(paths, { ruleSet: config, ...config.options, validate: true });
  if (typeof result.output === "string") throw new Error("unexpected string output");
  return result.output.summary.violations.map((v) => v.rule.name);
}

describe("module boundaries", () => {
  it("the real source tree has no violations", async () => {
    expect(await violations(["src"])).toEqual([]);
  });

  it("flags core importing store", async () => {
    expect(await violations(["test/fixtures/boundaries/src/core"])).toContain("boundary-core");
  });

  it("flags a process spawn outside the adapters", async () => {
    expect(await violations(["test/fixtures/boundaries/src/daemon"])).toContain("processes-only-in-adapters");
  });
});
