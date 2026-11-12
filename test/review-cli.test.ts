// RL-2 CLI against a World hub: `mesh items`, the `skipped` mark of `mesh goal show`, `mesh help`.
// Criterion AC-23. Written from the spec's contracts only (docs/specs/RL-2.md).

import { afterEach, describe, expect, it } from "vitest";
import { ALPHA, disp, fpOf, item, L, rec, relayPlan, Rk, S, type RCast } from "./helpers/review-kit.ts";

let k: Rk;
let c: RCast;
afterEach(async () => {
  await k?.r.stop();
});

const A = fpOf("A");
const B = fpOf("B");

/** Lineage L: G1 raises A (S1) and B; G2 raises A only (B resolved). Returns the goal ids. */
async function seeded(): Promise<{ G1: string; G2: string }> {
  ({ k, c } = await Rk.start());
  const plan = [S.audit(), S.validate()];
  const G1 = await k.goal(c.ann, plan);
  await k.submit(c.ann, `${G1}.audit`, rec({ items: [item("A", { severity: "S1" }), item("B")] }));
  await k.submit(c.ann, `${G1}.validate`, rec({ dispositions: [disp(B, "confirmed")] }));
  const G2 = await k.goal(c.ann, plan);
  await k.submit(c.ann, `${G2}.audit`, rec({ items: [item("A", { severity: "S1" })] }));
  return { G1, G2 };
}

describe("AC-23 mesh items", { timeout: 30_000 }, () => {
  const lineA = `${A}  open  S1  A  src/a.ts  T-A`;
  const lineB = `${B}  resolved  S3  B  src/a.ts  T-B`;

  it("test_AC23_items_lines", async () => {
    await seeded();
    const res = await k.r.cli(c.ann, ["items", L]);
    expect(res.code, res.err).toBe(0);
    const lines = res.out.split("\n").filter((l) => l.trim() !== "");
    expect(lines).toContain(lineA);
    expect(res.out).not.toContain(B);
  });

  it("test_AC23_all", async () => {
    await seeded();
    const res = await k.r.cli(c.ann, ["items", L, "--all"]);
    expect(res.code, res.err).toBe(0);
    const lines = res.out.split("\n").filter((l) => l.trim() !== "");
    expect(lines).toStrictEqual([lineA, lineB]);
  });

  it("test_AC23_empty", async () => {
    ({ k, c } = await Rk.start());
    const res = await k.r.cli(c.ann, ["items", `-|${ALPHA}|nobody`]);
    expect(res.code, res.err).toBe(0);
    expect(res.out.trim()).toBe(`No items in -|${ALPHA}|nobody.`);
  });

  it("test_AC23_json", async () => {
    await seeded();
    const res = await k.r.cli(c.ann, ["items", L, "--json"]);
    expect(res.code, res.err).toBe(0);
    const route = await k.r.call(c.ann, "GET", `/v1/items?lineage=${encodeURIComponent(L)}`);
    expect(JSON.parse(res.out)).toStrictEqual(route.json);
  });

  it("test_AC23_step_id", async () => {
    const { G1 } = await seeded();
    const byLineage = await k.r.cli(c.ann, ["items", L]);
    for (const id of [`${G1}.audit`, `${G1}.validate`]) {
      const res = await k.r.cli(c.ann, ["items", id]);
      expect(res.code, `${id}: ${res.err}`).toBe(0);
      expect(res.out, id).toBe(byLineage.out);
    }
  });

  it("test_AC23_no_record", async () => {
    ({ k, c } = await Rk.start());
    const G = await k.goal(c.ann, [S.audit(), S.step("x")]);
    const res = await k.r.cli(c.ann, ["items", `${G}.x`]);
    expect(res.code).toBe(1);
    expect(res.err).toContain(`${G}.x has no review record`);
  });

  it("test_AC23_show_mark", async () => {
    ({ k, c } = await Rk.start());
    const G = await k.goal(c.ann, relayPlan());
    await k.submit(c.ann, `${G}.audit`, rec());
    expect(await k.state(`${G}.validate`)).toBe("skipped");
    const res = await k.r.cli(c.ann, ["goal", "show", G]);
    expect(res.code, res.err).toBe(0);
    const line = res.out.split("\n").find((l) => l.includes("validate"));
    expect(line, res.out).toBeDefined();
    expect(line).toContain("↷");
    // Control: the done audit keeps its mark.
    expect(res.out.split("\n").find((l) => l.includes("audit"))).toContain("✓");
  });

  it("test_AC23_help", async () => {
    ({ k, c } = await Rk.start());
    const res = await k.r.cli(c.ann, ["help"]);
    expect(res.out).toMatch(/\bitems\b/);
  });
});
