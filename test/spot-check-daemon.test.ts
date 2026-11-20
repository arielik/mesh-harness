// RL-18 AC-06 daemon side (World): MCP `mesh_spot_check` (recording, reply texts, redaction, no held
// step, offline) and the brief of a spot-check step. Written from docs/specs/RL-18.md.

import { afterEach, describe, expect, it } from "vitest";
import { A, B, Dk, IA, IB, S } from "./helpers/debrief-kit.ts";
import { GHP } from "./helpers/relay-kit.ts";
import { disp, rec } from "./helpers/review-kit.ts";
import type { Json } from "./helpers/world.ts";

let k: Dk;
afterEach(async () => {
  await k?.r.stop();
});

const NO_SAMPLE_LEFT = "No sample left: submit the review record with mesh_review (items [], dispositions []), then call mesh_done.";

/** alice's goal: audit raises A and B; a headless validator confirms A and dismisses B (both sampled). */
async function fixture(): Promise<{ X: string; S: string }> {
  k = await Dk.start({ hubYaml: { spot_checks: { rate: 1, min_per_week: 0 } } });
  const G = await k.goal(k.c.alice, [
    S.audit(),
    S.step("validate", { deps: ["audit"], mode: "headless", agent: "validator", output: "review-record", consumes: ["open"], may_set: ["confirmed", "dismissed"] }),
  ]);
  await k.claim(k.c.alice, `${G}.audit`);
  await k.reviewOk(k.c.alice, `${G}.audit`, rec({ items: [IA, IB] }));
  await k.doneOk(k.c.alice, `${G}.audit`);
  await k.claim(k.c.alice, `${G}.validate`);
  await k.reviewOk(k.c.alice, `${G}.validate`, rec({ dispositions: [disp(A, "confirmed"), disp(B, "dismissed")], agent: { key: "svc/validator", hash: "e".repeat(64) } }));
  await k.doneOk(k.c.alice, `${G}.validate`);
  const ev = (await k.r.allEvents()).filter((e) => e.type === "spot-check.opened");
  expect(ev).toHaveLength(2);
  const SG = ev[0].goal as string;
  return { X: `${SG}.check`, S: SG };
}
const spot = (pid: number, b: Record<string, unknown>) => k.w.tool(k.c.alice, pid, "mesh_spot_check" as never, { reason: "R", answer: "ANS", ...b });
const samples = async (SG: string): Promise<Json[]> => (await k.call(k.c.alice, "GET", `/v1/goals/${SG}`)).json.goal.spotCheck.samples;

describe("RL-18 AC-06 mesh_spot_check", { timeout: 60_000 }, () => {
  it("test_AC06_mcp_tool", async () => {
    const { X, S: SG } = await fixture();
    const pid = await k.hold(X);
    // The brief names the spot check.
    const ctx = await k.w.tool(k.c.alice, pid, "mesh_context" as never, {});
    expect(ctx.text).toContain("This step is a spot check with your person: follow the mesh-debrief skill, section Spot checks (mesh_spot_check for each sample, then mesh_review, then mesh_done).");
    expect(ctx.text).not.toContain("This step is a debrief with your person");
    const t1 = await spot(pid, { sample: 1, verdict: "agree", reason: `r ${GHP}`, answer: `a ${GHP}` });
    expect(t1.isError, t1.text).toBeFalsy();
    expect(t1.text).toBe("Recorded sample 1: agree. 1 sample(s) left.");
    const s1 = (await samples(SG))[0];
    expect(s1.verdict).toMatchObject({ verdict: "agree", reason: "r [REDACTED]", answer: "a [REDACTED]", by: "alice" });
    expect(JSON.stringify(await samples(SG))).not.toContain(GHP);
    const sent = k.c.alice.requests.filter((x) => x.method === "POST" && x.path === `/v1/steps/${X}/spot-checks`);
    expect(sent).toHaveLength(1);
    expect(sent[0]?.key, "Idempotency-Key").toBeTruthy();
    const t2 = await spot(pid, { sample: 2, verdict: "disagree", expected: "confirmed" });
    expect(t2.text).toBe(`Recorded sample 2: disagree. ${NO_SAMPLE_LEFT}`);
    // A hub error comes back with the hub's text.
    const t3 = await spot(pid, { sample: 2, verdict: "agree" });
    expect(t3.isError).toBe(true);
    expect(t3.text).toContain(`sample 2 of ${X} already has a verdict`);
  });

  it("test_AC06_mcp_no_step_and_offline", async () => {
    const { X, S: SG } = await fixture();
    await k.w.hook(k.c.alice, "SessionStart", 9);
    const t = await spot(9, { sample: 1, verdict: "agree" });
    expect(t.isError).toBe(true);
    expect(t.text).toBe("this session holds no step");
    const pid = await k.hold(X);
    k.c.alice.offline = true;
    const off = await spot(pid, { sample: 1, verdict: "agree" });
    expect(off.isError).toBe(true);
    expect(off.text.startsWith("the hub is offline; the verdict was not recorded.")).toBe(true);
    k.c.alice.offline = false;
    await k.w.flush();
    await k.w.flush();
    expect((await samples(SG))[0].verdict).toBeUndefined();
    // Control: online, the same call records.
    expect((await spot(pid, { sample: 1, verdict: "agree" })).isError).toBeFalsy();
    expect((await samples(SG))[0].verdict?.verdict).toBe("agree");
  });
});
