// RL-8 AC-11: the docs cover the RL-8 changes (docs/specs/RL-8.md, Docs table). `MESH_SKILL` equals
// `skills/mesh/SKILL.md` (kept by src/claude/skill.test.ts). The review step for team-, company- or
// person-specific names is not automated here.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { MESH_SKILL } from "../src/protocol/index.ts";

const ROOT = join(import.meta.dirname, "..");
const read = (rel: string) => readFileSync(join(ROOT, rel), "utf8");
const paragraphs = (t: string) => t.split(/\n\s*\n/);

describe("RL-8 AC-11 docs", () => {
  it("test_AC11_concepts", () => {
    const concepts = read("docs/guide/concepts.md");
    for (const t of ["could not make a worktree: fatal:", "already exists", "maxSessions"]) expect(concepts, t).toContain(t);
    const ps = paragraphs(concepts);
    // Headless step: a run being started counts toward maxSessions.
    expect(ps.some((p) => /maxSessions/.test(p) && /start/i.test(p)), "a paragraph on maxSessions and starting").toBe(true);
    // A run that did not start stores no transcript.
    expect(ps.some((p) => /transcript/.test(p) && /did not start|never started|not start/i.test(p)), "a paragraph on no transcript for a run that did not start").toBe(true);
    // A run's session keeps kind print.
    expect(ps.some((p) => /\bprint\b/.test(p) && /session/i.test(p) && /kind/i.test(p)), "a paragraph on the run session's kind print").toBe(true);
    // mesh pulse add/update warn about agents flagged invalid.
    expect(ps.some((p) => p.includes("mesh pulse add") && /invalid/.test(p) && /warn/i.test(p)), "a paragraph on pulse warnings").toBe(true);
  });

  it("test_AC11_howto", () => {
    expect(read("docs/guide/howto.md")).toMatch(/warning: step "[^"]+": agent \S+ in \S+ has invalid front matter: /);
  });

  it("test_AC11_skill", () => {
    const rows = MESH_SKILL.split("\n").filter((l) => l.includes("mesh pulse add"));
    // Control: the row exists.
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.some((l) => /invalid/.test(l)), rows.join("\n")).toBe(true);
    expect(read("skills/mesh/SKILL.md")).toBe(MESH_SKILL);
  });

  it("test_AC11_api_table", () => {
    const NOTE = "(v0.1.22: the reply carries `warnings` for agents flagged invalid)";
    const lines = read("docs/plan/implementation-plan.md").split("\n");
    const create = lines.filter((l) => l.includes(NOTE) && /POST \/v1\/pulses(?![/\w])/.test(l));
    const update = lines.filter((l) => l.includes(NOTE) && l.includes("POST /v1/pulses/:id/"));
    expect(create, "the POST /v1/pulses row").toHaveLength(1);
    expect(update, "the POST /v1/pulses/:id/{update,…} row").toHaveLength(1);
  });
});
