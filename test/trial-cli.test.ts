// RL-11 CLI against a World hub (docs/specs/RL-11.md, "Trial fires"): `mesh pulse fire --trial` and
// its three outputs (AC-08, AC-09), the trial markers of `mesh goal ls --pulses`, `mesh goal show` and
// `mesh pulse show` (AC-13), and `--help`.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Relay } from "./helpers/relay-kit.ts";
import { body, DAY, MIN, Pk, SOLO_HL, T0, type Bare, type Json } from "./helpers/pulse-kit.ts";
import type { Person } from "./helpers/world.ts";

let k: Pk;
const dirs: string[] = [];
afterEach(async () => {
  await k?.stop();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
const NOW = T0 - DAY;

async function cast(): Promise<{ ann: Person }> {
  const r = await Relay.start(["ann", "bob", "carol", "dave", "root"], { admins: ["carol", "root"] });
  r.w.clock = NOW;
  k = new Pk(r);
  for (const u of ["ann", "bob", "carol"]) k.tok[u] = (await r.w.login(u, { hostname: `${u}-login` })).token;
  const ann = await r.w.person("ann", "alpha");
  await r.w.flush();
  return { ann };
}
function plainDir(): string {
  const d = mkdtempSync(join(tmpdir(), "mesh-trial-cli-"));
  dirs.push(d);
  return d;
}
const cli = (p: Person, args: string[]) => k.r.cli(p, args, { cwd: plainDir() });

describe("RL-11 AC-08 AC-09 mesh pulse fire --trial", { timeout: 30_000 }, () => {
  it("test_AC08_fired_and_plain", async () => {
    const c = await cast();
    await k.pulseOk("ann", body({}, "solo-hl", SOLO_HL));
    const res = await cli(c.ann, ["pulse", "fire", "p-1", "--trial"]);
    expect(res.code, res.err).toBe(0);
    const s = (await k.slotsOf("p-1"))[0];
    expect(s.trial).toBe(true);
    expect(res.out.trim()).toBe(`Fired pulse p-1: slot ${s.slot} (trial) → ${s.goal}.`);
    expect((await k.goal(s.goal)).goal.trial).toBe(true);
    // Without --trial the line is as before and nothing is marked.
    k.at(NOW + MIN);
    const plain = await cli(c.ann, ["pulse", "fire", "p-1"]);
    expect(plain.code, plain.err).toBe(0);
    const p = (await k.slotsOf("p-1"))[0];
    expect("trial" in p).toBe(false);
    expect(plain.out.trim()).toBe(`Fired pulse p-1: slot ${p.slot} → ${p.goal}.`);
  });

  it("test_AC08_missed", async () => {
    const c = await cast();
    await k.pulseOk("ann", body({}, "solo-hl", SOLO_HL));
    k.storeWrap({
      createGoal: (orig, g, ...rest) => {
        if ((g as Json)?.refs?.pulse === "p-1") throw new Error("boom");
        return orig(g, ...rest);
      },
    });
    const res = await cli(c.ann, ["pulse", "fire", "p-1", "--trial"]);
    expect(res.code).toBe(1);
    const s = (await k.slotsOf("p-1"))[0];
    expect(res.err.trim()).toBe(`Pulse p-1 missed slot ${s.slot} (trial): boom`);
  });

  it("test_AC09_skipped_names_the_running_goal", async () => {
    const c = await cast();
    await k.pulseOk("ann", body({}, "solo-hl", SOLO_HL));
    const A: Bare = await k.bare("ann", "box-a", { headless: true });
    void A;
    const normal = await k.fireOk("ann", "p-1");
    k.at(NOW + MIN);
    const res = await cli(c.ann, ["pulse", "fire", "p-1", "--trial"]);
    expect(res.code, res.err).toBe(0);
    const sk = (await k.slotsOf("p-1")).find((x) => x.state === "skipped") as Json;
    expect(sk).toMatchObject({ trial: true, running: normal.goal });
    expect(res.out.trim()).toBe(`Pulse p-1 skipped slot ${sk.slot} (trial): ${normal.goal} is still running (overlap: skip).`);
  });

  it("test_AC08_older_hub_ignores_trial", async () => {
    const c = await cast();
    await k.pulseOk("ann", body({}, "solo-hl", SOLO_HL));
    // An older hub: the body is ignored.
    const svc = k.w.hub.svc as unknown as { firePulse: (a: unknown, id: string, b?: unknown) => Promise<unknown> };
    const orig = svc.firePulse.bind(svc);
    svc.firePulse = (a, id) => orig(a, id, {});
    const res = await cli(c.ann, ["pulse", "fire", "p-1", "--trial"]);
    expect(res.code).toBe(1);
    const s = (await k.slotsOf("p-1"))[0];
    expect(res.err.trim()).toBe(`The hub ignored --trial (it is older than 0.1.30): slot ${s.slot} of pulse p-1 is fired with goal ${s.goal}, a normal goal; drop it with: mesh goal drop ${s.goal}.`);
  });

  it("test_AC08_help", async () => {
    const c = await cast();
    const res = await cli(c.ann, ["pulse", "--help"]);
    expect(res.code, res.err).toBe(0);
    expect(res.out).toContain("mesh pulse fire <id> [--trial]");
  });
});

describe("RL-11 AC-13 trial markers", { timeout: 30_000 }, () => {
  it("test_AC13_markers", async () => {
    const c = await cast();
    expect((await k.call("ann", "POST", "/v1/topics", { name: "ci" })).status).toBe(201);
    await k.pulseOk("ann", body({ topics: ["ci"] }, "solo-hl", SOLO_HL));
    const A: Bare = await k.bare("ann", "box-a", { headless: true });
    void A;
    // A normal goal with machine work, then a trial fire skipped by it, then (once it is dropped) a trial goal.
    const normal = await k.fireOk("ann", "p-1");
    k.at(NOW + MIN);
    const skipped = (await k.act("ann", "p-1", "fire", { trial: true })).json.slot;
    expect(skipped.state).toBe("skipped");
    expect((await k.call("ann", "POST", `/v1/goals/${normal.goal}/drop`, {})).status).toBe(200);
    k.at(NOW + 2 * MIN);
    const trial = (await k.act("ann", "p-1", "fire", { trial: true })).json.slot;
    expect(trial.state).toBe("fired");
    const G = trial.goal as string;
    const title = (await k.goal(G)).goal.title as string;

    const ls = await cli(c.ann, ["goal", "ls", "--pulses"]);
    expect(ls.code, ls.err).toBe(0);
    const lines = ls.out.split("\n");
    const mine = lines.filter((l) => l.startsWith(`${G} `));
    expect(mine).toStrictEqual([`${G.padEnd(5)} ${"in_progress".padEnd(18)} @${"ann".padEnd(12)} ${title} (trial)  [ci]`]);
    expect(lines.filter((l) => l.includes("(trial)"))).toHaveLength(1);

    const show = await cli(c.ann, ["goal", "show", G]);
    expect(show.code, show.err).toBe(0);
    expect(show.out.split("\n")[0]).toBe(`${G} · ${title} (trial)`);
    const showNormal = await cli(c.ann, ["goal", "show", normal.goal]);
    expect(showNormal.out.split("\n")[0]).not.toContain("(trial)");

    const ps = await cli(c.ann, ["pulse", "show", "p-1"]);
    expect(ps.code, ps.err).toBe(0);
    const slotLines = ps.out.split("\n").filter((l) => l.startsWith("  "));
    expect(slotLines.find((l) => l.startsWith(`  ${skipped.slot}  `))).toBe(`  ${skipped.slot}  skipped (overlap) (trial)  -`);
    expect(slotLines.find((l) => l.startsWith(`  ${trial.slot}  `))).toMatch(new RegExp(`^  ${trial.slot}  fired \\(trial\\)  ${G}`));
    expect(slotLines.find((l) => l.startsWith(`  ${normal.slot}  `))).not.toContain("(trial)");
  });
});
