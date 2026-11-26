// RL-15 AC-13: the docs cover the overlap policies and the debrief SLA (docs/specs/RL-15.md, "Docs").

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = join(import.meta.dirname, "..");
const read = (rel: string) => readFileSync(join(ROOT, rel), "utf8");
const headings = (text: string) => text.split("\n").filter((l) => l.startsWith("## "));

describe("RL-15 AC-13 docs", () => {
  it("test_AC13_concepts", () => {
    const c = read("docs/guide/concepts.md");
    const h = headings(c);
    expect(h.indexOf("## Debrief SLA")).toBe(h.indexOf("## Pulse health") + 1);
    const sla = c.slice(c.indexOf("## Debrief SLA"), c.indexOf("## Agent statistics"));
    for (const w of ["auto_accept", "mesh/debrief-sla", "auto-accept", "debrief_overdue", "debrief.overdue", "debrief.auto_accepted", "S1 and S2 always wait"]) expect(sla).toContain(w);
    const pulses = c.slice(c.indexOf("## Pulses"), c.indexOf("## Roster"));
    for (const w of ["--overlap queue", "supersede", "**Carry.**", "`superseded`"]) expect(pulses).toContain(w);
    const health = c.slice(c.indexOf("## Pulse health"), c.indexOf("## Debrief SLA"));
    for (const w of ["`queued`", "`overdue`", "`breaches`"]) expect(health).toContain(w);
  });

  it("test_AC13_guides_events_plan", () => {
    const s = read("docs/guide/scheduled-reviews.md");
    expect(s).toContain("--overlap skip\\|allow\\|queue\\|supersede");
    expect(s).toContain("`--overlap supersede`");
    expect(s).toContain("auto_accept: [S3, S4]");
    const o = read("docs/guide/operations.md");
    expect(o).toContain(" 0.1.37 (RL-15) adds the overlap policies");
    expect(o.indexOf("0.1.37 (RL-15)")).toBeLessThan(o.indexOf("0.1.23 has no release package."));
    expect(o).toContain("## Upgrading to 0.1.43");
    const probes = o.slice(o.indexOf("### Probes"), o.indexOf("\n## ", o.indexOf("### Probes")));
    for (const f of ["debrief-sla", "overlap-policy"]) expect(probes).toContain(`\`${f}\``);
    const ev = read("docs/events.md");
    for (const t of ["`pulse.queued`", "`pulse.superseded`", "`debrief.overdue`", "`debrief.auto_accepted`", "`replacedBy`", "`auto-accept`"]) expect(ev).toContain(t);
    expect(read("docs/plan/implementation-plan.md")).toContain("0.1.37 (RL-15)");
  });
});
