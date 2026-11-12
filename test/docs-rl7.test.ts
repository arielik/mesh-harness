// RL-7 AC-16: the docs cover the RL-7 changes (docs/specs/RL-7.md, Docs table). The review step for
// team-, company- or person-specific names is not automated here.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = join(import.meta.dirname, "..");
const read = (rel: string) => readFileSync(join(ROOT, rel), "utf8");

describe("RL-7 AC-16 docs", () => {
  it("test_AC16_docs_mentions", () => {
    const concepts = read("docs/guide/concepts.md");
    for (const t of ["--session-id", "TMUX_PANE", "MESH_AUTOPILOT", "CLAUDE_PID", "did not start", "invalid", "params", "{turns}"]) expect(concepts, t).toContain(t);
    const howto = read("docs/guide/howto.md");
    expect(howto).toContain("turns=");
    // A `mesh preset ls` sample with a repo template line: `<name> <description>  [<path>.yaml]`.
    expect(howto).toMatch(/^\s*\S+ +.*\s\s\[[^\]\s]*\.mesh\/presets\/[^\]\s]+\.yaml\]/m);
    expect(read("docs/plan/implementation-plan.md")).toContain("(v0.1.21: versions carry `invalid` when the front matter is not valid YAML)");
    const rl1 = read("docs/specs/RL-1.md");
    expect(rl1).toContain("(changed in RL-7)");
    expect(rl1).toContain("token-like");
  });
});
