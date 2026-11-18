// RL-10 CLI against a World hub: `mesh items` (the target repo arrow, `--json`), `mesh items
// retarget` (moves, held steps, moving back, from key path, usage errors), `mesh items sink` grouped
// by target repo, the `mesh show` counts after a move. Criteria AC-02 (CLI), AC-05 (mesh show),
// AC-06, AC-06b, AC-06d, AC-06e, AC-07 (CLI), AC-08 (CLI), AC-09 (CLI), AC-10 (CLI). Written from the
// spec's contracts only (docs/specs/RL-10.md) and the test plan (docs/specs/plans/RL-10-test-plan.md).
// What the CLI changed is read back at the hub.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  acc,
  AUDIT,
  DAY_MS,
  DEBRIEF_DISMISS,
  disp,
  fA,
  fB,
  fC,
  fD,
  fE,
  fF,
  fG,
  FILE,
  fpR,
  IA,
  IB,
  IC,
  ID,
  IE,
  IF,
  IG,
  IR,
  item,
  LIN,
  noPath,
  NOV19,
  revived,
  Sk,
  TRIAGE,
  X,
  type Json,
  type Person,
} from "./helpers/sink-kit.ts";

let k: Sk | undefined;
const dirs: string[] = [];
afterEach(async () => {
  await k?.stop();
  k = undefined;
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
const K = () => k as Sk;
function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), "mesh-rl10-cli-"));
  dirs.push(d);
  return d;
}
const cli = (p: Person, args: string[]) => K().r.cli(p, args, { cwd: tmp() });
const lines = (out: string) => out.split("\n").map((l) => l.trim()).filter((l) => l !== "");
const retargetCalls = (r: { requests: string[] }) => r.requests.filter((x) => x.includes("/items/retarget"));
const HELD_NOTE = (repo: string) => `retarget to ${repo}: release the step, then run the retarget again`;
const FILED_NOTE = (f: string, repo: string) => `filed for repo ${repo}; move it with: mesh items retarget ${LIN()} ${f} --repo ${repo}`;
const count = (xs: string[], t: string) => xs.filter((x) => x === t).length;

/** `mesh items retarget` by ann, expecting exit 0; returns the output lines. */
async function retargetCli(args: string[], who?: Person): Promise<string[]> {
  const s = K();
  const res = await cli(who ?? s.ann, ["items", "retarget", ...args]);
  expect(res.code, `mesh items retarget ${args.join(" ")}: ${res.err}`).toBe(0);
  await s.w.flush();
  return lines(res.out);
}

/** G1 files D (no repo) → its step in the r goal. */
async function filedD(): Promise<{ Gr: string; rD: string }> {
  k = await Sk.start();
  const G1 = await k.run();
  await k.raise(G1, [ID]);
  await k.file(G1, [acc(fD)]);
  const Gr = await k.CG("r");
  return { Gr, rD: k.fs(Gr, fD) };
}

// =============================================================================================
// AC-02 mesh items
// =============================================================================================

describe("RL-10 AC-02 mesh items", { timeout: 90_000 }, () => {
  it("test_AC02_items_cli", async () => {
    k = await Sk.start();
    const s = k;
    const G1 = await s.run();
    const Z = IR(noPath("rz"), X);
    const Q = IR(item("rq", { title: "T-Q" }), "r");
    await s.raise(G1, [IR(IA, X), IR(IB, "y"), IC, Z, Q]);
    await s.file(G1, [acc(fA), acc(fB), acc(fC)]);
    const fZ = await s.fpByRule("rz");
    const fQ = fpR("rq");
    const res = await cli(s.ann, ["items", LIN()]);
    expect(res.code, res.err).toBe(0);
    const ls = res.out.split("\n");
    const lineOf = (f: string) => {
      const xs = ls.filter((l) => l.startsWith(f));
      expect(xs, `one line for ${f}`).toHaveLength(1);
      return xs[0];
    };
    expect(lineOf(fA)).toContain("src/a.ts → x");
    expect(lineOf(fB)).toContain("src/a.ts → y");
    expect(lineOf(fC)).toContain("src/a.ts");
    expect(lineOf(fC)).not.toContain("→");
    expect(lineOf(fZ)).toContain("- → x");
    expect(lineOf(fQ), "control: the item is listed").toContain("src/a.ts");
    expect(lineOf(fQ), "the lineage repo prints no arrow").not.toContain("→");
    const js = await cli(s.ann, ["items", LIN(), "--json"]);
    expect(js.code, js.err).toBe(0);
    const route = await s.call(s.ann, "GET", `/v1/items?lineage=${encodeURIComponent(LIN())}`);
    const parsed = JSON.parse(js.out);
    expect(parsed).toStrictEqual(route.json);
    const row = (f: string) => (parsed.items as Json[]).find((x) => x.fp === f) as Json;
    expect(row(fA).repo).toBe("x");
    expect("repo" in row(fC)).toBe(false);
  });
});

// =============================================================================================
// AC-05 mesh show counts live steps only
// =============================================================================================

describe("RL-10 AC-05 mesh show", { timeout: 90_000 }, () => {
  it("test_AC05_show_counts_live", async () => {
    k = await Sk.start();
    const s = k;
    const G1 = await s.run();
    await s.raise(G1, [ID, IE]);
    await s.file(G1, [acc(fD), acc(fE, { requires: [fD] })]);
    const Gr = await s.CG("r");
    s.tick();
    const G2 = await s.run();
    await s.raise(G2, [IR(ID, X), IE]);
    const Gx = await s.CG(X);
    expect((await s.step(s.fs(Gr, fD))).movedTo, "control: D moved").toBe(s.fs(Gx, fD));
    const header = async (G: string) => {
      const res = await cli(s.ann, ["show", G]);
      expect(res.code, res.err).toBe(0);
      return lines(res.out).filter((l) => l.startsWith("clean audits:"));
    };
    expect(await header(Gr)).toStrictEqual(["clean audits: ci on r · open S1 0 · S2 0 · S3 1 · S4 0 · done 0 · dropped 0"]);
    expect(await header(Gx)).toStrictEqual(["clean audits: ci on x · open S1 0 · S2 0 · S3 1 · S4 0 · done 0 · dropped 0"]);
  });
});

// =============================================================================================
// AC-06 Held, and moving back
// =============================================================================================

describe("RL-10 AC-06 held and moving back", { timeout: 150_000 }, () => {
  it("test_AC06_held_then_back", async () => {
    const { Gr, rD } = await filedD();
    const s = K();
    await s.hold(s.bob, rD);
    // 2. The fold: held → note, no move.
    s.tick();
    const G2 = await s.run();
    await s.raise(G2, [IR(ID, X)]);
    expect((await s.item(fD)).repo, "control: target x").toBe("x");
    const d2 = await s.step(rD);
    expect(d2).toMatchObject({ state: "claimed", holderUser: "bob" });
    expect(d2.movedTo).toBeUndefined();
    expect(await s.notes(rD)).toContain(HELD_NOTE("x"));
    expect(await s.allFor(fD)).toStrictEqual([rD]);
    expect((await s.liveOpen(fD)).length).toBeLessThanOrEqual(1);
    // 3. The refile: no step in x; the filed note once.
    await s.file(G2, [acc(fD)]);
    expect(await s.allFor(fD)).toStrictEqual([rD]);
    expect(count(await s.notes(rD), FILED_NOTE(fD, "x"))).toBe(1);
    expect((await s.liveOpen(fD)).length).toBeLessThanOrEqual(1);
    // 4. Released; retarget to x (target unchanged) → moved.
    await s.release(s.bob, rD);
    const out4 = await retargetCli([LIN(), fD, "--repo", "x"]);
    const Gx = await s.CG(X);
    const xD = s.fs(Gx, fD);
    expect(out4[0]).toBe("retargeted 0 items; moved 1 steps; held 0");
    expect(out4).toContain(`${rD} → ${xD}`);
    expect(await s.step(rD)).toMatchObject({ state: "dropped", movedTo: xD });
    expect((await s.step(xD)).state).toBe("ready");
    expect(await s.notes(xD)).toContain(`moved from ${rD}`);
    expect(await s.liveOpen(fD)).toStrictEqual([xD]);
    // 5. Back to r → the moved-away r step is revived.
    const notesBefore = await s.notes(rD);
    const n0 = (await s.step(rD)).fixCycles;
    const out5 = await retargetCli([LIN(), fD, "--repo", "r"]);
    expect(out5[0]).toBe("retargeted 1 items; moved 1 steps; held 0");
    expect(out5).toContain(`${xD} → ${rD}`);
    const d5 = await s.step(rD);
    expect(d5).toMatchObject({ state: "ready", repo: "r", fixCycles: n0 });
    for (const f of ["movedTo", "summary", "outcome", "holderUser"]) expect(d5[f], f).toBeUndefined();
    const n5 = await s.notes(rD);
    for (const t of notesBefore) expect(n5, t).toContain(t);
    expect(n5).toContain(`moved back from ${xD}`);
    const ro5 = await s.ev("step.reopened", (e) => e.step === rD);
    expect(ro5).toHaveLength(1);
    expect(ro5[0].payload).toMatchObject({ reason: "moved" });
    expect(await s.step(xD)).toMatchObject({ state: "dropped", movedTo: rD });
    expect((await s.fsteps(Gr)).filter((x) => x.finding?.fp === fD)).toHaveLength(1);
    expect((await s.item(fD)).repo).toBe("r");
    expect(await s.liveOpen(fD)).toStrictEqual([rD]);
    // 6. A debrief dismisses D → the r step dropped; x untouched.
    const xDrops = (await s.ev("step.dropped", (e) => e.step === xD)).length;
    const G3 = await s.run({ steps: [AUDIT, DEBRIEF_DISMISS] });
    await s.raise(G3, [ID]);
    const D = await s.debriefDismiss(G3, fD);
    expect((await s.step(rD)).state).toBe("dropped");
    expect(await s.step(xD)).toMatchObject({ state: "dropped", movedTo: rD });
    expect(await s.ev("step.dropped", (e) => e.step === xD)).toHaveLength(xDrops);
    // 7. The revert reopens the r step only.
    await s.revertD(D, fD);
    expect((await s.item(fD)).state, "control: D filed again").toBe("accepted");
    expect((await s.step(rD)).state).toBe("ready");
    expect(await s.ev("step.reopened", (e) => e.step === rD && e.payload?.reason === "reverted")).toHaveLength(1);
    expect(await s.step(xD)).toMatchObject({ state: "dropped", movedTo: rD });
    expect(await s.ev("step.reopened", (e) => e.step === xD)).toStrictEqual([]);
    expect(await s.liveOpen(fD)).toStrictEqual([rD]);
  });
});

// =============================================================================================
// AC-06b Revive by sink, closed home reopened by a move
// =============================================================================================

describe("RL-10 AC-06b revive by sink", { timeout: 150_000 }, () => {
  const byCli = (f: string, repo: string) => retargetCli([LIN(), f, "--repo", repo]);

  it("test_AC06b_revive_by_sink", async () => {
    k = await Sk.start();
    const s = k;
    const { G2, Gr, rD, xD, notes0 } = await revived(s, byCli);
    const d = await s.step(rD);
    expect(d).toMatchObject({ state: "ready", repo: "r" });
    for (const f of ["movedTo", "summary", "outcome", "holderUser"]) expect(d[f], f).toBeUndefined();
    const ns = await s.notes(rD);
    for (const t of notes0) expect(ns, t).toContain(t);
    expect((await s.fsteps(Gr)).filter((x) => x.finding?.fp === fD).map((x) => x.id)).toStrictEqual([rD]);
    expect((await s.step(xD)).state).toBe("done");
    expect(await s.ev("step.reopened", (e) => e.step === xD)).toStrictEqual([]);
    const ro = await s.ev("step.reopened", (e) => e.step === rD);
    expect(ro).toHaveLength(1);
    expect(ro[0].payload).toMatchObject({ from: G2.file });
    const sunk = await s.ev("goal.sunk", (e) => e.payload?.goal === Gr && e.payload?.from === G2.file);
    expect(sunk).toHaveLength(1);
    expect([...(sunk[0].payload.added ?? []), ...(sunk[0].payload.reopened ?? [])]).toContain(rD);
  });

  it("test_AC06b_sink_revive_reason", async () => {
    k = await Sk.start();
    const s = k;
    const { rD } = await revived(s, byCli);
    const ro = await s.ev("step.reopened", (e) => e.step === rD);
    expect(ro).toHaveLength(1);
    expect(ro[0].payload.reason).toBe("refiled");
  });

  it("test_AC06b_move_reopens_closed_home", async () => {
    k = await Sk.start();
    const s = k;
    const { rD, xD } = await revived(s, byCli);
    const n0 = (await s.step(xD)).fixCycles as number;
    const out = await retargetCli([LIN(), fD, "--repo", "x"]);
    expect(out[0]).toBe("retargeted 1 items; moved 1 steps; held 0");
    expect(out).toContain(`${rD} → ${xD}`);
    expect(await s.step(rD)).toMatchObject({ state: "dropped", movedTo: xD });
    expect(await s.step(xD)).toMatchObject({ state: "ready", fixCycles: n0 + 1 });
    expect(await s.notes(xD)).toContain(`moved from ${rD}`);
    const ro = await s.ev("step.reopened", (e) => e.step === xD);
    expect(ro).toHaveLength(1);
    expect(ro[0].payload).toMatchObject({ reason: "moved" });
    expect((await s.allFor(fD)).length, "no new id").toBe(2);
  });

  it("test_AC06b_not_filed_again_no_revive", async () => {
    k = await Sk.start();
    const s = k;
    const { rD, xD } = await revived(s, byCli, { fileD: false });
    expect((await s.step(rD)).movedTo).toBe(xD);
    expect((await s.step(xD)).state).toBe("done");
    expect(await s.ev("step.reopened")).toStrictEqual([]);
    s.tick();
    const res = await cli(s.ann, ["items", "sink", LIN(), "--topic", "ci"]);
    expect(res.code, res.err).toBe(0);
    expect((await s.step(rD)).movedTo).toBe(xD);
    expect((await s.step(xD)).state).toBe("done");
    expect(await s.ev("step.reopened")).toStrictEqual([]);
    expect(await s.allFor(fD)).toStrictEqual([rD, xD].sort());
  });
});

// =============================================================================================
// AC-06d Sink move
// =============================================================================================

describe("RL-10 AC-06d sink move", { timeout: 120_000 }, () => {
  it("test_AC06d_retarget_held_then_sink_moves", async () => {
    const { rD } = await filedD();
    const s = K();
    await s.hold(s.bob, rD);
    const out = await retargetCli([LIN(), fD, "--repo", "x"]);
    expect(out[0]).toBe("retargeted 1 items; moved 0 steps; held 1");
    expect(out).toContain(`held: ${rD}`);
    expect((await s.item(fD)).repo).toBe("x");
    expect(await s.step(rD)).toMatchObject({ state: "claimed", holderUser: "bob" });
    expect(await s.notes(rD)).toContain(HELD_NOTE("x"));
    await s.release(s.bob, rD);
    s.tick();
    const n = (await s.ev("item.retargeted")).length;
    const G2 = await s.run();
    await s.raise(G2, [ID]);
    expect(await s.ev("item.retargeted"), "no fold move: the target stays x").toHaveLength(n);
    expect(await s.step(rD), "control: still in r").toMatchObject({ state: "ready" });
    expect((await s.step(rD)).movedTo).toBeUndefined();
    await s.file(G2, [acc(fD)]);
    const Gx = await s.CG(X);
    const xD = s.fs(Gx, fD);
    expect((await s.step(xD)).state).toBe("ready");
    expect(await s.notes(xD)).toContain(`moved from ${rD}`);
    expect(await s.step(rD)).toMatchObject({ state: "dropped", movedTo: xD });
    expect(await s.moveOf(rD)).toBeDefined();
    const sunk = await s.ev("goal.sunk", (e) => e.payload?.goal === Gx && e.payload?.from === G2.file);
    expect(sunk).toHaveLength(1);
    expect(sunk[0].payload.added).toContain(xD);
    expect(await s.liveOpen(fD)).toStrictEqual([xD]);
  });
});

// =============================================================================================
// AC-06e Revert reopens only home; backfill does not re-create
// =============================================================================================

describe("RL-10 AC-06e revert only home", { timeout: 150_000 }, () => {
  it("test_AC06e_revert_and_backfill", async () => {
    const { Gr, rD } = await filedD();
    const s = K();
    // D's r step dropped while live: a triage defers D (the RL-9 "dropped, refiled" shape: a deferred
    // item is raised again as open after `until`, so a later run can file it).
    const iso = (ms: number) => new Date(ms).toISOString().slice(0, 10);
    const G2 = await s.run({ steps: [AUDIT, TRIAGE()] });
    await s.raise(G2, [ID]);
    await s.file(G2, [disp(fD, "deferred", { reason: "later", until: iso(NOV19 + DAY_MS) })], { stage: "triage" });
    expect((await s.step(rD)).state, "control: rD dropped").toBe("dropped");
    const snapR = await s.step(rD);
    const out = await retargetCli([LIN(), fD, "--repo", "x"]);
    expect(out[0]).toBe("retargeted 1 items; moved 0 steps; held 0");
    expect(await s.step(rD)).toStrictEqual(snapR);
    // A later run files D → a new step in x.
    s.w.clock = NOV19 + 3 * DAY_MS;
    const G3 = await s.run();
    await s.raise(G3, [ID]);
    expect((await s.item(fD)).state, "control: D open again").toBe("open");
    await s.file(G3, [acc(fD)]);
    const Gx = await s.CG(X);
    const xD = s.fs(Gx, fD);
    expect(await s.step(xD)).toMatchObject({ state: "ready", repo: "x" });
    expect((await s.step(rD)).state).toBe("dropped");
    expect((await s.step(rD)).movedTo).toBeUndefined();
    // A debrief dismisses D (the x step dropped); its revert reopens the x step only.
    const rDrops = (await s.ev("step.dropped", (e) => e.step === rD)).length;
    const G4 = await s.run({ steps: [AUDIT, DEBRIEF_DISMISS] });
    await s.raise(G4, [ID]);
    const D = await s.debriefDismiss(G4, fD);
    expect((await s.step(xD)).state).toBe("dropped");
    expect(await s.ev("step.dropped", (e) => e.step === rD)).toHaveLength(rDrops);
    await s.revertD(D, fD);
    expect((await s.step(xD)).state).toBe("ready");
    const ro = await s.ev("step.reopened", (e) => e.step === xD);
    expect(ro).toHaveLength(1);
    expect(ro[0].payload).toMatchObject({ reason: "reverted" });
    expect((await s.step(rD)).state).toBe("dropped");
    expect(await s.ev("step.reopened", (e) => e.step === rD)).toStrictEqual([]);
    // A person finishes the x step; a backfill then creates or reopens nothing.
    s.tick();
    await s.finish(s.bob, xD);
    s.tick();
    const sx = await s.snapshot(Gx);
    const sr = await s.snapshot(Gr);
    const reopens = (await s.ev("step.reopened")).length;
    const bf = await cli(s.ann, ["items", "sink", LIN(), "--topic", "ci"]);
    expect(bf.code, bf.err).toBe(0);
    expect(bf.out.trim()).toBe(`${Gx}: added 0, reopened 0`);
    expect(await s.snapshot(Gx)).toStrictEqual(sx);
    expect(await s.snapshot(Gr)).toStrictEqual(sr);
    expect(await s.ev("step.reopened")).toHaveLength(reopens);
    expect(await s.allFor(fD)).toStrictEqual([rD, xD].sort());
  });
});

// =============================================================================================
// AC-07 Retarget by repo (CLI)
// =============================================================================================

describe("RL-10 AC-07 retarget by repo", { timeout: 120_000 }, () => {
  it("test_AC07_cli", async () => {
    k = await Sk.start();
    const s = k;
    const G1 = await s.run();
    await s.raise(G1, [IR(IA, X), IF, IG]);
    await s.file(G1, [acc(fA), acc(fF), acc(fG)]);
    const Gx = await s.CG(X);
    const Gr = await s.CG("r");
    const [rF, rG, xF] = [s.fs(Gr, fF), s.fs(Gr, fG), s.fs(Gx, fF)];
    await s.hold(s.bob, rG);
    const before = await s.world();
    const dry = await retargetCli([LIN(), fF, fG, "--repo", "x", "--dry-run"]);
    expect(dry[0]).toBe("would retarget 2 items; moved 1 steps; held 1");
    expect(dry).toContain(`${rF} → ${xF}`);
    expect(dry).toContain(`held: ${rG}`);
    expect(await s.world(), "a dry run writes nothing").toStrictEqual(before);
    const real = await retargetCli([LIN(), fF, fG, "--repo", "x"]);
    expect(real[0]).toBe("retargeted 2 items; moved 1 steps; held 1");
    expect(real).toContain(`${rF} → ${xF}`);
    expect(real).toContain(`held: ${rG}`);
    expect(await s.step(rF)).toMatchObject({ state: "dropped", movedTo: xF });
  });
});

// =============================================================================================
// AC-08 Retarget from key path (CLI)
// =============================================================================================

describe("RL-10 AC-08 retarget from key path", { timeout: 120_000 }, () => {
  it("test_AC08_from_key_path", async () => {
    k = await Sk.start();
    const s = k;
    const G1 = await s.run();
    await s.raise(G1, [item("rh", { path: "x" }), item("ri", { path: "y" }), noPath("rj"), item("rk", { path: "src/a.rs" }), item("rl", { path: "a.ts" })]);
    const [fH, fI, fK, fL] = [fpR("rh", "x"), fpR("ri", "y"), fpR("rk", "src/a.rs"), fpR("rl", "a.ts")];
    const fJ = await s.fpByRule("rj");
    await s.file(G1, [fH, fI, fJ, fK, fL].map((f) => acc(f)));
    const Gr = await s.CG("r");
    const out = await retargetCli([LIN(), "--all", "--from-key-path"]);
    expect(out[0]).toBe("retargeted 2 items; moved 2 steps; held 0");
    const Gx = await s.CG(X);
    const Gy = await s.CG("y");
    expect(out).toContain(`${s.fs(Gr, fH)} → ${s.fs(Gx, fH)}`);
    expect(out).toContain(`${s.fs(Gr, fI)} → ${s.fs(Gy, fI)}`);
    expect(out).toContain(`note: ${fJ}: no key path`);
    expect(out).toContain(`note: ${fK}: key path src/a.rs is not a repo name`);
    expect(out).toContain(`note: ${fL}: key path a.ts is not a repo name`);
    expect((await s.fsteps(Gx)).map((x) => x.id)).toStrictEqual([s.fs(Gx, fH)]);
    expect((await s.fsteps(Gy)).map((x) => x.id)).toStrictEqual([s.fs(Gy, fI)]);
    expect(new Set((await s.goals()).filter((g) => g.sink).map((g) => g.sink.repo))).toStrictEqual(new Set(["r", "x", "y"]));
    for (const f of [fJ, fK, fL]) {
      expect("repo" in (await s.item(f)), f).toBe(false);
      expect((await s.step(s.fs(Gr, f))).state, f).toBe("ready");
    }
  });
});

// =============================================================================================
// AC-09 Retarget checks (CLI)
// =============================================================================================

describe("RL-10 AC-09 retarget checks", { timeout: 90_000 }, () => {
  it("test_AC09_cli_usage", async () => {
    k = await Sk.start();
    const s = k;
    const G1 = await s.run();
    await s.raise(G1, [IF]);
    await s.file(G1, [acc(fF)]);
    for (const args of [[LIN(), "--all"], [], [LIN(), fF, "--all", "--repo", "x"], [LIN(), "--repo", "x"], [LIN(), fF, "--repo", "x", "--from-key-path"]]) {
      const res = await cli(s.ann, ["items", "retarget", ...args]);
      expect(res.code, `${args.join(" ")}: ${res.err}`).toBe(2);
      expect(res.err).toMatch(/mesh items retarget/);
      expect(retargetCalls(res), args.join(" ")).toStrictEqual([]);
    }
    // Positive control: valid arguments call the hub once and exit 0.
    const ok = await cli(s.ann, ["items", "retarget", LIN(), fF, "--repo", "x", "--dry-run"]);
    expect(ok.code, ok.err).toBe(0);
    expect(retargetCalls(ok)).toHaveLength(1);
    // A refused call (bob: neither admin nor an allowed owner) exits non-zero, not as a usage error.
    const no = await cli(s.bob, ["items", "retarget", LIN(), fF, "--repo", "x"]);
    expect(no.code).not.toBe(0);
    expect(no.code).not.toBe(2);
    expect(retargetCalls(no)).toHaveLength(1);
    expect(no.err.trim()).not.toBe("");
    expect((await s.item(fF)).repo, "nothing written").toBeUndefined();
  });
});

// =============================================================================================
// AC-10 Backfill grouped (CLI)
// =============================================================================================

describe("RL-10 AC-10 backfill grouped", { timeout: 120_000 }, () => {
  it("test_AC10_cli", async () => {
    k = await Sk.start();
    const s = k;
    const P1 = item("p1", { title: "T-P1" });
    const P2 = item("p2", { title: "T-P2" });
    const P3 = item("p3", { title: "T-P3" });
    const [f1, f2, f3] = [fpR("p1"), fpR("p2"), fpR("p3")];
    const L = LIN("plain");
    const R = await s.run({ preset: "plain", steps: [AUDIT, FILE({ sink: undefined })] });
    await s.raise(R, [IR(P1, X), IR(P2, X), P3]);
    await s.file(R, [acc(f1), acc(f2), acc(f3)]);
    expect(await s.cag("r")).toBeUndefined();
    expect(await s.cag(X)).toBeUndefined();
    const before = await s.world(L);
    const dry = await cli(s.ann, ["items", "sink", L, "--topic", "ci", "--dry-run"]);
    expect(dry.code, dry.err).toBe(0);
    expect(lines(dry.out)).toStrictEqual(["would add 1 to a new goal (r)", "would add 2 to a new goal (x)"]);
    expect(await s.world(L)).toStrictEqual(before);
    const run = await cli(s.ann, ["items", "sink", L, "--topic", "ci"]);
    expect(run.code, run.err).toBe(0);
    const Gr = await s.CG("r");
    const Gx = await s.CG(X);
    expect(lines(run.out)).toStrictEqual([`${Gr}: added 1, reopened 0 (r)`, `${Gx}: added 2, reopened 0 (x)`]);
    expect((await s.fsteps(Gr)).map((x) => x.id)).toStrictEqual([s.fs(Gr, f3, L)]);
    expect((await s.fsteps(Gx)).map((x) => x.id).sort()).toStrictEqual([s.fs(Gx, f1, L), s.fs(Gx, f2, L)].sort());
    for (const x of await s.fsteps(Gr)) expect(x).toMatchObject({ repo: "r", deps: [] });
    for (const x of await s.fsteps(Gx)) expect(x).toMatchObject({ repo: "x", deps: [] });
    const again = await cli(s.ann, ["items", "sink", L, "--topic", "ci"]);
    expect(again.code, again.err).toBe(0);
    expect(lines(again.out)).toStrictEqual([`${Gr}: added 0, reopened 0 (r)`, `${Gx}: added 0, reopened 0 (x)`]);
    expect(await s.fsteps(Gr)).toHaveLength(1);
    expect(await s.fsteps(Gx)).toHaveLength(2);
    // Control: a lineage whose items all target its own repo prints RL-9's single line, no suffix.
    const O = await s.run({ preset: "own", steps: [AUDIT, FILE({ sink: undefined })] });
    const P4 = item("p4", { title: "T-P4" });
    await s.raise(O, [P4]);
    await s.file(O, [acc(fpR("p4"))]);
    const own = await cli(s.ann, ["items", "sink", LIN("own"), "--topic", "ci"]);
    expect(own.code, own.err).toBe(0);
    expect(own.out.trim()).toBe(`${Gr}: added 1, reopened 0`);
  });
});
