// RL-10 World tests: findings name their repo. Items with `repo` (recorded and kept), the sink by
// target repo, one fp listed for two repos, the item → step sync across goals, the fold move, held
// steps and moving back, revive by sink, one open step, retarget (route), retarget from key path,
// retarget checks, the backfill grouped (route), deps within a goal. Criteria AC-01 … AC-11.
// Written from the spec's contracts only (docs/specs/RL-10.md, building on docs/specs/RL-9.md) and
// the test plan (docs/specs/plans/RL-10-test-plan.md). Expected finding-step ids come from the
// test-side formula (`fid`): the local id does not depend on the repo. Steps by id, items by fp,
// goals by `sink`, events by type + step/goal + payload.

import { afterEach, describe, expect, it } from "vitest";
import {
  acc,
  AUDIT,
  DEBRIEF_DISMISS,
  disp,
  fA,
  fB,
  fC,
  fD,
  fE,
  fF,
  fG,
  fid,
  FILE,
  fM,
  fN,
  fpOf,
  fpR,
  IA,
  IB,
  IC,
  ID,
  IE,
  IF,
  IG,
  IM,
  IN,
  IR,
  item,
  LIN,
  noPath,
  recArgs,
  revived,
  Sk,
  TITLE,
  TRIAGE,
  X,
  Y,
  type Json,
  type Person,
  type Run,
} from "./helpers/sink-kit.ts";

let k: Sk;
afterEach(async () => {
  await k?.stop();
});

const PROBLEMS = (n: number, ps: string[]) => `the review record has ${n} problem(s): ${ps.join("; ")}`;
const TWO_REPOS = (f: string, repos: string[]) => `item ${f} is listed for more than one repo (${repos.join(", ")}); put the repo in its key`;
const HELD_NOTE = (repo: string) => `retarget to ${repo}: release the step, then run the retarget again`;
const FILED_NOTE = (f: string, repo: string) => `filed for repo ${repo}; move it with: mesh items retarget ${LIN()} ${f} --repo ${repo}`;
const TXT = "retarget needs fps or all, and repo or from_key_path";
const byFp = (xs: Json[]) => [...xs].sort((a, b) => String(a.fp).localeCompare(String(b.fp)));
const count = (xs: string[], t: string) => xs.filter((x) => x === t).length;
/**
 * A record posted straight to the review route keeps the raw rule (the `other:<slug>` mapping is the
 * daemon's `mesh_review` path, RL-2), so its fp is of the raw key: `fpOf(rule)`, not `fpR(rule)`.
 */
const fRA = fpOf("ra");
const fRB = fpOf("rb");
/** `it` with its key's rule as an interactive stage records it (`other:<rule>`), for a route record that must hit the MCP-raised fp. */
const asRecorded = <T extends { key: { rule: string } }>(it: T): T => ({ ...it, key: { ...it.key, rule: `other:${it.key.rule}` } });

/** AC-01 state: run 1 raises A (repo x), B (repo y), C (no repo); `file` files all three. */
async function filed3(): Promise<{ G1: Run; Gx: string; Gy: string; Gr: string }> {
  k = await Sk.start();
  const G1 = await k.run();
  await k.raise(G1, [IR(IA, X), IR(IB, Y), IC]);
  await k.file(G1, [acc(fA), acc(fB), acc(fC)]);
  return { G1, Gx: await k.CG(X), Gy: await k.CG(Y), Gr: await k.CG("r") };
}

/** A route review record by the holder of `id` (claimed through the route first unless `claim: false`). */
async function review(id: string, body: Record<string, unknown>, o: { claim?: boolean } = {}) {
  if (o.claim !== false) {
    const c = await k.r.act(k.ann, id, "claim", {});
    expect(c.status, `claim ${id}: ${JSON.stringify(c.json)}`).toBe(200);
  }
  const res = await k.call(k.ann, "POST", `/v1/steps/${id}/review`, recArgs(body));
  await k.w.flush();
  return res;
}

// =============================================================================================
// AC-01 Sink by target repo
// =============================================================================================

describe("RL-10 AC-01 sink by target repo", { timeout: 90_000 }, () => {
  it("test_AC01_three_goals", async () => {
    k = await Sk.start();
    const G1 = await k.run();
    await k.raise(G1, [IR(IA, X), IR(IB, Y), IC]);
    // Control: `repo` is not in the key, so the fps are the test-side ones.
    expect((await k.items()).map((x) => x.fp).sort()).toStrictEqual([fA, fB, fC].sort());
    await k.file(G1, [acc(fA), acc(fB), acc(fC)]);
    const want: [string, string][] = [
      [X, fA],
      [Y, fB],
      ["r", fC],
    ];
    const ids: Record<string, string> = {};
    for (const [repo, f] of want) {
      const g = await k.cag(repo);
      expect(g, `clean-audit goal of (${repo}, ci)`).toBeDefined();
      expect(g.title).toBe(TITLE(repo));
      expect(g.sink).toStrictEqual({ repo, topic: "ci" });
      expect(g.ownerId).toBe("ann");
      const id = `${g.id}.${fid(LIN(), f)}`;
      ids[repo] = id;
      expect((await k.fsteps(g.id)).map((s) => s.id)).toStrictEqual([id]);
      const s = await k.step(id);
      expect(s).toMatchObject({ repo, state: "ready" });
      expect(s.finding).toStrictEqual({ lineage: LIN(), fp: f });
      expect(await k.liveOpen(f)).toStrictEqual([id]);
    }
    const sunk = await k.ev("goal.sunk", (e) => e.payload?.from === G1.file);
    expect(sunk, "one goal.sunk per clean-audit goal").toHaveLength(3);
    const byGoal = new Map(sunk.map((e) => [e.payload.goal as string, e.payload]));
    for (const [repo] of want) {
      const id = ids[repo] as string;
      const G = id.slice(0, id.indexOf("."));
      expect(byGoal.get(G), `goal.sunk of ${G}`).toMatchObject({ added: [id], reopened: [] });
    }
  });

  it("test_AC01_repo_equal_lineage_repo", async () => {
    k = await Sk.start();
    const G1 = await k.run();
    await k.raise(G1, [IR(IA, "r")]);
    expect((await k.item(fA)).repo, "control: the repo was recorded").toBe("r");
    await k.file(G1, [acc(fA)]);
    const Gr = await k.CG("r");
    expect((await k.fsteps(Gr)).map((s) => s.id)).toStrictEqual([k.fs(Gr, fA)]);
    expect((await k.goals()).filter((g) => g.sink).map((g) => g.id)).toStrictEqual([Gr]);
  });
});

// =============================================================================================
// AC-02 The repo is recorded and kept
// =============================================================================================

describe("RL-10 AC-02 recording the repo", { timeout: 90_000 }, () => {
  it("test_AC02_row_and_kept", async () => {
    const { Gx, Gr } = await filed3();
    const a = await k.item(fA);
    expect(a.repo).toBe("x");
    expect((await k.item(fB)).repo).toBe("y");
    expect("repo" in (await k.item(fC)), "C's row has no repo").toBe(false);
    const xA = k.fs(Gx, fA);
    const n0 = (await k.step(xA)).fixCycles;
    const G2 = await k.run();
    await k.raise(G2, [IA, IB, IC]);
    // Positive control: the record was folded (the audit is done, A still filed).
    expect((await k.step(G2.audit)).state).toBe("done");
    expect((await k.item(fA)).state).toBe("accepted");
    expect((await k.item(fA)).repo, "kept on a record without repo").toBe("x");
    expect((await k.item(fB)).repo).toBe("y");
    expect(await k.step(xA)).toMatchObject({ state: "ready", fixCycles: n0 });
    expect(await k.maybeStep(k.fs(Gr, fA))).toBeUndefined();
    expect(await k.ev("item.retargeted")).toStrictEqual([]);
    expect(await k.liveOpen(fA)).toStrictEqual([xA]);
  });

  it("test_AC02_repo_length", async () => {
    k = await Sk.start();
    const G1 = await k.run();
    const long = await review(G1.audit, { items: [IR(IA, "x".repeat(301))] });
    expect(long.status, JSON.stringify(long.json)).toBe(400);
    const blank = await review(G1.audit, { items: [IR(IA, "   ")] }, { claim: false });
    expect(blank.status, JSON.stringify(blank.json)).toBe(400);
    expect(await k.items()).toStrictEqual([]);
    // Positive control: 300 characters, and a padded repo stored trimmed.
    const ok = await review(G1.audit, { items: [IR(IA, "x".repeat(300)), IR(IB, "  x  ")] }, { claim: false });
    expect(ok.status, JSON.stringify(ok.json)).toBe(201);
    expect((await k.item(fRA)).repo).toBe("x".repeat(300));
    expect((await k.item(fRB)).repo).toBe("x");
    // Through MCP (the daemon's tool schema or the hub's 400): the long repo is an error; a valid record then goes through.
    const G2 = await k.run();
    const pid = await k.hold(k.ann, G2.audit);
    const bad = await k.tool(k.ann, pid, "mesh_review", recArgs({ items: [IR(IC, "x".repeat(301))] }));
    expect(bad.isError, bad.text).toBe(true);
    const good = await k.tool(k.ann, pid, "mesh_review", recArgs({ items: [IR(IC, X)] }));
    expect(good.isError, good.text).toBeFalsy();
    await k.w.flush();
    expect((await k.item(fC)).repo).toBe("x");
  });
});

// =============================================================================================
// AC-03 Same fingerprint, two repos
// =============================================================================================

describe("RL-10 AC-03 same fp two repos", { timeout: 90_000 }, () => {
  it("test_AC03_refused", async () => {
    k = await Sk.start();
    const G1 = await k.run();
    const r1 = await review(G1.audit, { items: [IR(IA, X), IR(IA, Y)] });
    expect(r1.status, JSON.stringify(r1.json)).toBe(422);
    expect(await k.items()).toStrictEqual([]);
    // The snapshot is taken after r1's claim of the audit step (the claim is not part of the record).
    const before = await k.world();
    expect(r1.json.error).toBe(PROBLEMS(1, [TWO_REPOS(fRA, ["x", "y"])]));
    // Absent counts as the lineage repo; the repos distinct, in record order.
    const r2 = await review(G1.audit, { items: [IR(IA, X), IA, IR(IA, Y)] }, { claim: false });
    expect(r2.status, JSON.stringify(r2.json)).toBe(422);
    expect(r2.json.error).toContain(TWO_REPOS(fRA, ["x", "r", "y"]));
    const r3 = await review(G1.audit, { items: [IR(IA, X), IA, IR(IA, X)] }, { claim: false });
    expect(r3.status, JSON.stringify(r3.json)).toBe(422);
    expect(r3.json.error).toContain(TWO_REPOS(fRA, ["x", "r"]));
    expect(await k.items()).toStrictEqual([]);
    expect(await k.world()).toStrictEqual(before);
    // Positive controls: one repo listed twice → 201, the first kept (RL-2).
    const ok = await review(G1.audit, { items: [IR(IA, X), IR(IA, X)] }, { claim: false });
    expect(ok.status, JSON.stringify(ok.json)).toBe(201);
    expect((await k.items()).map((x) => [x.fp, x.repo])).toStrictEqual([[fRA, "x"]]);
    const G2 = await k.run();
    const same = await review(G2.audit, { items: [IA, IA] });
    expect(same.status, JSON.stringify(same.json)).toBe(201);
    // The lineage repo spelled out equals an absent repo.
    const G3 = await k.run();
    const lin = await review(G3.audit, { items: [IR(IA, "r"), IA] });
    expect(lin.status, JSON.stringify(lin.json)).toBe(201);
  });

  it("test_AC03_repeat_same_fp", async () => {
    await filed3();
    expect((await k.item(fA)).repo, "control: A raised with repo x").toBe("x");
    const G2 = await k.run();
    // Run 2 on the route raises A's key as run 1 (through MCP) stored it: `other:ra`, no repo.
    const res = await review(G2.audit, { items: [IA, IB, IC].map(asRecorded) });
    expect(res.status, JSON.stringify(res.json)).toBe(201);
    const mark = (f: string) => ((res.json.items ?? []) as Json[]).find((x) => x.fp === f)?.mark;
    expect(mark(fA)).toBe("repeat");
    expect((await k.items()).filter((x) => x.fp === fA)).toHaveLength(1);
    expect((await k.items()).filter((x) => x.fp !== fA && x.fp !== fB && x.fp !== fC)).toStrictEqual([]);
  });
});

// =============================================================================================
// AC-04 Resolved and dismissed sync across repos
// =============================================================================================

describe("RL-10 AC-04 sync across goals", { timeout: 90_000 }, () => {
  it("test_AC04_resolved_in_target_goal", async () => {
    const { Gx, Gy, Gr } = await filed3();
    const sy = await k.snapshot(Gy);
    const sr = await k.snapshot(Gr);
    const G2 = await k.run();
    await k.raise(G2, [IB, IC], { who: k.bob });
    expect((await k.item(fA)).state, "control: A resolved").toBe("resolved");
    expect(await k.step(k.fs(Gx, fA))).toMatchObject({ state: "done", summary: `resolved by ${G2.audit}` });
    expect(await k.snapshot(Gy)).toStrictEqual(sy);
    expect(await k.snapshot(Gr)).toStrictEqual(sr);
  });

  it("test_AC04_dismissed_in_target_goal", async () => {
    const { Gx, Gy, Gr } = await filed3();
    const sx = await k.snapshot(Gx);
    const sr = await k.snapshot(Gr);
    const G2 = await k.run({ steps: [AUDIT, TRIAGE()] });
    await k.raise(G2, [IA, IB, IC]);
    await k.file(G2, [disp(fB, "dismissed", { reason: "RB" })], { stage: "triage" });
    const yB = k.fs(Gy, fB);
    expect(await k.step(yB)).toMatchObject({ state: "dropped", summary: "dismissed by ann: RB" });
    const dr = await k.ev("step.dropped", (e) => e.step === yB);
    expect(dr).toHaveLength(1);
    expect(dr[0].payload).toMatchObject({ reason: "dismissed" });
    expect(await k.snapshot(Gx)).toStrictEqual(sx);
    expect(await k.snapshot(Gr)).toStrictEqual(sr);
  });
});

// =============================================================================================
// AC-05 Fold move
// =============================================================================================

/** G1 files D and E (E requires D unless `dRequiresE`); returns the r goal and the two step ids. */
async function filedDE(o: { dRequiresE?: boolean } = {}): Promise<{ G1: Run; Gr: string; rD: string; rE: string }> {
  k = await Sk.start();
  const G1 = await k.run();
  await k.raise(G1, [ID, IE]);
  await k.file(G1, o.dRequiresE ? [acc(fD, { requires: [fE] }), acc(fE)] : [acc(fD), acc(fE, { requires: [fD] })]);
  const Gr = await k.CG("r");
  return { G1, Gr, rD: k.fs(Gr, fD), rE: k.fs(Gr, fE) };
}

describe("RL-10 AC-05 fold move", { timeout: 90_000 }, () => {
  it("test_AC05_open_step_moved_by_fold", async () => {
    const { rD, rE } = await filedDE();
    expect((await k.step(rD)).state, "control: D ready").toBe("ready");
    expect(await k.step(rE), "control: E blocked on D").toMatchObject({ state: "blocked", deps: [rD] });
    const n0 = (await k.step(rD)).fixCycles;
    k.tick();
    const G2 = await k.run();
    // bob's record, read right after `mesh_review` (no `mesh_done`, no sink).
    await k.stageOk(k.bob, G2.audit, { items: [IR(ID, X), IE], coverage: "complete", assessment: "issues" }, { done: false });
    expect((await k.item(fD)).repo).toBe("x");
    const rt = await k.ev("item.retargeted");
    expect(rt).toHaveLength(1);
    expect(rt[0].payload).toMatchObject({ lineage: LIN(), fp: fD, from: "r", to: "x", by: "bob" });
    expect(rt[0].user).toBe("bob");
    const gx = await k.cag(X);
    expect(gx, "the x goal").toBeDefined();
    expect(gx.title).toBe(TITLE(X));
    expect(gx.ownerId).toBe("ann");
    const xD = k.fs(gx.id, fD);
    expect(xD.split(".")[1]).toBe(rD.split(".")[1]);
    const x = await k.step(xD);
    expect(x).toMatchObject({ repo: "x", state: "ready", fixCycles: n0 });
    expect(x.finding).toStrictEqual({ lineage: LIN(), fp: fD });
    expect(await k.notes(xD)).toContain(`moved from ${rD}`);
    expect(await k.step(rD)).toMatchObject({ state: "dropped", movedTo: xD, summary: `moved to ${xD}` });
    const mv = await k.moveOf(rD);
    expect(mv, "step.dropped reason moved").toBeDefined();
    expect(mv?.payload).toMatchObject({ reason: "moved", to: xD });
    expect(mv?.user).toBe("ann");
    expect((await k.step(rE)).state).toBe("ready");
    expect(await k.notes(rE)).toContain(`dep ${rD} moved to ${xD}`);
    const sunk = await k.ev("goal.sunk", (e) => e.payload?.goal === gx.id);
    expect(sunk).toHaveLength(1);
    expect(sunk[0].payload).toMatchObject({ from: G2.audit, added: [xD] });
    expect(await k.liveOpen(fD)).toStrictEqual([xD]);
  });

  it("test_AC05_fixcycles_carried", async () => {
    const { rD } = await filedDE();
    await k.doStep(k.ann, rD);
    k.tick();
    const G2 = await k.run();
    await k.raise(G2, [ID, IE]);
    await k.file(G2, [acc(fD)]);
    expect(await k.step(rD), "control: D reopened").toMatchObject({ state: "ready", fixCycles: 1 });
    k.tick();
    const G3 = await k.run();
    await k.raise(G3, [IR(ID, X), IE]);
    const xD = k.fs(await k.CG(X), fD);
    expect((await k.step(xD)).fixCycles).toBe(1);
  });

  it("test_AC05_move_deps_in_new_goal", async () => {
    // D requires E; D moves to x, E stays in r → no dep across goals, a note.
    {
      const { rD, rE } = await filedDE({ dRequiresE: true });
      expect(await k.step(rD), "control: D blocked on E").toMatchObject({ state: "blocked", deps: [rE] });
      const G2 = await k.run();
      await k.raise(G2, [IR(ID, X), IE]);
      const xD = k.fs(await k.CG(X), fD);
      expect(await k.step(xD)).toMatchObject({ state: "ready", deps: [] });
      expect(await k.notes(xD)).toContain(`requires ${fE}: not in this goal`);
      await k.stop();
    }
    // E moved to x first, then D → D's step in x depends on E's.
    {
      const { rD } = await filedDE({ dRequiresE: true });
      const G2 = await k.run();
      await k.raise(G2, [ID, IR(IE, X)]);
      const Gx = await k.CG(X);
      const xE = k.fs(Gx, fE);
      expect((await k.step(xE)).state, "control: E moved").toBe("ready");
      expect((await k.step(rD)).state, "control: D unblocked by the dropped dep").toBe("ready");
      const G3 = await k.run();
      await k.raise(G3, [IR(ID, X), IR(IE, X)]);
      expect(await k.step(k.fs(Gx, fD))).toMatchObject({ state: "blocked", deps: [xE] });
    }
  });

  it("test_AC05_topic_gone", async () => {
    const { rD } = await filedDE();
    const del = await k.call(k.ann, "POST", "/v1/topics/ci/delete", {});
    expect(del.status, JSON.stringify(del.json)).toBe(200);
    const G2 = await k.run({ steps: [AUDIT] });
    const res = await k.stage(k.ann, G2.audit, { items: [IR(ID, X), IE], coverage: "complete", assessment: "issues" });
    expect(res.review?.isError, res.review?.text).toBeFalsy();
    expect((await k.item(fD)).repo, "control: the row changed").toBe("x");
    expect(await k.cag(X)).toBeUndefined();
    const d = await k.step(rD);
    expect(d.state).toBe("ready");
    expect(d.movedTo).toBeUndefined();
    expect(await k.notes(rD)).toContain("move to x skipped: topic ci is not defined");
  });
});

// =============================================================================================
// AC-06 Held, and moving back (route twin of the CLI scenario)
// =============================================================================================

describe("RL-10 AC-06 held and moving back", { timeout: 120_000 }, () => {
  it("test_AC06_held_then_back_route", async () => {
    k = await Sk.start();
    const G1 = await k.run();
    await k.raise(G1, [ID]);
    await k.file(G1, [acc(fD)]);
    const Gr = await k.CG("r");
    const rD = k.fs(Gr, fD);
    await k.hold(k.bob, rD);
    // 2. The fold: D's target becomes x, its step is held → note, no move.
    k.tick();
    const G2 = await k.run();
    await k.raise(G2, [IR(ID, X)]);
    expect((await k.item(fD)).repo, "control: target x").toBe("x");
    const d2 = await k.step(rD);
    expect(d2).toMatchObject({ state: "claimed", holderUser: "bob" });
    expect(d2.movedTo).toBeUndefined();
    expect(await k.notes(rD)).toContain(HELD_NOTE("x"));
    expect(await k.allFor(fD)).toStrictEqual([rD]);
    expect((await k.liveOpen(fD)).length).toBeLessThanOrEqual(1);
    // 3. The refile: still no step in x; the filed note once.
    await k.file(G2, [acc(fD)]);
    expect(await k.allFor(fD)).toStrictEqual([rD]);
    expect(count(await k.notes(rD), FILED_NOTE(fD, "x"))).toBe(1);
    expect((await k.liveOpen(fD)).length).toBeLessThanOrEqual(1);
    // 4. Released, then retarget (target unchanged) → moved.
    await k.release(k.bob, rD);
    expect((await k.step(rD)).state).toBe("ready");
    const r4 = await k.retargetOk(k.ann, { lineage: LIN(), fps: [fD], repo: "x" });
    const Gx = await k.CG(X);
    const xD = k.fs(Gx, fD);
    expect(r4).toMatchObject({ items: [], moved: [{ from: rD, to: xD }], held: [] });
    expect(await k.step(rD)).toMatchObject({ state: "dropped", movedTo: xD });
    expect((await k.step(xD)).state).toBe("ready");
    expect(await k.notes(xD)).toContain(`moved from ${rD}`);
    expect(await k.liveOpen(fD)).toStrictEqual([xD]);
    // 5. Back to r → the moved-away r step is revived.
    const notesBefore = await k.notes(rD);
    const n0 = (await k.step(rD)).fixCycles;
    const r5 = await k.retargetOk(k.ann, { lineage: LIN(), fps: [fD], repo: "r" });
    expect(r5).toMatchObject({ items: [{ fp: fD, from: "x", to: "r" }], moved: [{ from: xD, to: rD }], held: [] });
    const d5 = await k.step(rD);
    expect(d5).toMatchObject({ state: "ready", repo: "r", fixCycles: n0 });
    for (const f of ["movedTo", "summary", "outcome", "holderUser"]) expect(d5[f], f).toBeUndefined();
    const n5 = await k.notes(rD);
    for (const t of notesBefore) expect(n5, t).toContain(t);
    expect(n5).toContain(HELD_NOTE("x"));
    expect(n5).toContain(FILED_NOTE(fD, "x"));
    expect(n5).toContain(`moved back from ${xD}`);
    const ro5 = await k.ev("step.reopened", (e) => e.step === rD);
    expect(ro5).toHaveLength(1);
    expect(ro5[0].payload).toMatchObject({ reason: "moved" });
    expect(await k.step(xD)).toMatchObject({ state: "dropped", movedTo: rD });
    expect((await k.fsteps(Gr)).filter((s) => s.finding?.fp === fD)).toHaveLength(1);
    expect((await k.item(fD)).repo).toBe("r");
    expect(await k.liveOpen(fD)).toStrictEqual([rD]);
    // 6. A debrief dismisses D → the r step dropped; the moved-away x step untouched.
    const xDrops = (await k.ev("step.dropped", (e) => e.step === xD)).length;
    const G3 = await k.run({ steps: [AUDIT, DEBRIEF_DISMISS] });
    await k.raise(G3, [ID]);
    const D = await k.debriefDismiss(G3, fD);
    expect((await k.step(rD)).state).toBe("dropped");
    expect((await k.step(rD)).summary).toMatch(/^dismissed by ann/);
    expect(await k.step(xD)).toMatchObject({ state: "dropped", movedTo: rD });
    expect(await k.ev("step.dropped", (e) => e.step === xD)).toHaveLength(xDrops);
    // 7. Its revert reopens the r step only.
    await k.revertD(D, fD);
    expect((await k.item(fD)).state, "control: D filed again").toBe("accepted");
    expect((await k.step(rD)).state).toBe("ready");
    expect(await k.ev("step.reopened", (e) => e.step === rD && e.payload?.reason === "reverted")).toHaveLength(1);
    expect(await k.step(xD)).toMatchObject({ state: "dropped", movedTo: rD });
    expect(await k.ev("step.reopened", (e) => e.step === xD)).toStrictEqual([]);
    expect(await k.liveOpen(fD)).toStrictEqual([rD]);
  });
});

// =============================================================================================
// AC-06c One open step
// =============================================================================================

describe("RL-10 AC-06c one open step", { timeout: 120_000 }, () => {
  it("test_AC06c_held_foreign_closed_home", async () => {
    k = await Sk.start();
    const { rD, xD } = await revived(k, (f, repo) => k.retargetOk(k.ann, { lineage: LIN(), fps: [f], repo }));
    expect((await k.step(rD)).state, "control: rD revived").toBe("ready");
    expect((await k.step(xD)).state, "control: xD done").toBe("done");
    await k.hold(k.bob, rD);
    k.tick();
    const xReopens = (await k.ev("step.reopened", (e) => e.step === xD)).length;
    const G3 = await k.run();
    await k.raise(G3, [IR(ID, X)]);
    await k.file(G3, [acc(fD)]);
    expect((await k.step(xD)).state).toBe("done");
    expect(await k.ev("step.reopened", (e) => e.step === xD)).toHaveLength(xReopens);
    expect(await k.step(rD)).toMatchObject({ state: "claimed", holderUser: "bob" });
    const ns = await k.notes(rD);
    expect(ns).toContain(HELD_NOTE("x"));
    expect(ns).toContain(FILED_NOTE(fD, "x"));
    expect(await k.liveOpen(fD)).toStrictEqual([rD]);
  });
});

// =============================================================================================
// AC-07 Retarget by repo (route)
// =============================================================================================

/** A (repo x) → the x goal; F and G in the r goal; bob holds G's step unless `hold: false`. */
async function fg(o: { hold?: boolean } = {}): Promise<{ G1: Run; Gx: string; Gr: string; rF: string; rG: string; xF: string; xG: string }> {
  k = await Sk.start();
  const G1 = await k.run();
  await k.raise(G1, [IR(IA, X), IF, IG]);
  await k.file(G1, [acc(fA), acc(fF), acc(fG)]);
  const Gx = await k.CG(X);
  const Gr = await k.CG("r");
  const rG = k.fs(Gr, fG);
  if (o.hold !== false) await k.hold(k.bob, rG);
  return { G1, Gx, Gr, rF: k.fs(Gr, fF), rG, xF: k.fs(Gx, fF), xG: k.fs(Gx, fG) };
}

describe("RL-10 AC-07 retarget by repo", { timeout: 120_000 }, () => {
  it("test_AC07_route", async () => {
    const { Gx, rF, rG, xF, xG } = await fg();
    const before = await k.world();
    const body = { lineage: LIN(), fps: [fF, fG], repo: "x" };
    const dry = await k.retargetOk(k.ann, { ...body, dry_run: true });
    expect(await k.world(), "a dry run writes nothing").toStrictEqual(before);
    const real = await k.retargetOk(k.ann, body);
    expect(real).toStrictEqual(dry);
    expect(byFp(real.items)).toStrictEqual(
      byFp([
        { fp: fF, from: "r", to: "x" },
        { fp: fG, from: "r", to: "x" },
      ]),
    );
    expect(real.moved).toStrictEqual([{ from: rF, to: xF }]);
    expect(real.held).toStrictEqual([rG]);
    expect((await k.step(xF)).state).toBe("ready");
    expect(await k.step(rF)).toMatchObject({ state: "dropped", movedTo: xF });
    expect((await k.moveOf(rF))?.user).toBe("ann");
    expect(await k.step(rG)).toMatchObject({ state: "claimed", holderUser: "bob" });
    expect(await k.notes(rG)).toContain(HELD_NOTE("x"));
    expect((await k.item(fF)).repo).toBe("x");
    expect((await k.item(fG)).repo).toBe("x");
    for (const f of [fF, fG]) {
      const es = await k.ev("item.retargeted", (e) => e.payload?.fp === f);
      expect(es, f).toHaveLength(1);
      expect(es[0].user).toBe("ann");
      expect(es[0].payload).toMatchObject({ lineage: LIN(), fp: f, from: "r", to: "x", by: "ann" });
    }
    const after = await k.world();
    expect(after.items.map((x: Json) => [x.fp, x.history]), "no item history entry").toStrictEqual(before.items.map((x: Json) => [x.fp, x.history]));
    const sunk = await k.ev("goal.sunk", (e) => e.payload?.goal === Gx && e.payload?.from === "mesh items retarget");
    expect(sunk).toHaveLength(1);
    expect(sunk[0].payload).toMatchObject({ added: [xF] });
    // After G is released, the same call moves it (its target did not change).
    await k.release(k.bob, rG);
    const n = (await k.ev("item.retargeted")).length;
    const again = await k.retargetOk(k.ann, body);
    expect(again).toMatchObject({ items: [], moved: [{ from: rG, to: xG }], held: [] });
    expect((await k.step(xG)).state).toBe("ready");
    expect(await k.ev("item.retargeted")).toHaveLength(n);
  });

  it("test_AC07_dry_run_new_goal", async () => {
    const { rF } = await fg();
    const dry = await k.retargetOk(k.ann, { lineage: LIN(), fps: [fF], repo: "y", dry_run: true });
    expect(dry.moved).toStrictEqual([{ from: rF, to: `new:y/${fid(LIN(), fF)}` }]);
    expect(await k.cag(Y)).toBeUndefined();
    expect((await k.step(rF)).state, "control: nothing moved").toBe("ready");
  });

  it("test_AC07_moved_into_goal_owned_by_other", async () => {
    k = await Sk.start();
    const B1 = await k.run({ preset: "bobs", owner: k.bob });
    await k.raise(B1, [IR(IC, X)], { who: k.bob });
    await k.file(B1, [acc(fC)], { who: k.bob });
    const Gx = await k.CG(X);
    expect((await k.goalView(Gx)).goal.ownerId, "control: bob's x goal").toBe("bob");
    const G1 = await k.run();
    await k.raise(G1, [IF]);
    await k.file(G1, [acc(fF)]);
    const rF = k.fs(await k.CG("r"), fF);
    const res = await k.retargetOk(k.ann, { lineage: LIN(), fps: [fF], repo: "x" });
    expect(res.moved).toStrictEqual([{ from: rF, to: k.fs(Gx, fF) }]);
    expect(await k.cagAll(X)).toHaveLength(1);
    expect((await k.step(k.fs(Gx, fF))).state).toBe("ready");
  });
});

// =============================================================================================
// AC-08 Retarget from key path (route twin)
// =============================================================================================

describe("RL-10 AC-08 retarget from key path", { timeout: 120_000 }, () => {
  it("test_AC08_from_key_path_route", async () => {
    k = await Sk.start();
    const G1 = await k.run();
    const H = item("rh", { path: "x" });
    const I = item("ri", { path: "y" });
    const J = noPath("rj");
    const K = item("rk", { path: "src/a.rs" });
    const L = item("rl", { path: "a.ts" });
    await k.raise(G1, [H, I, J, K, L]);
    const [fH, fI, fK, fL] = [fpR("rh", "x"), fpR("ri", "y"), fpR("rk", "src/a.rs"), fpR("rl", "a.ts")];
    const fJ = await k.fpByRule("rj");
    await k.file(G1, [fH, fI, fJ, fK, fL].map((f) => acc(f)));
    const Gr = await k.CG("r");
    const res = await k.retargetOk(k.ann, { lineage: LIN(), all: true, from_key_path: true });
    expect(byFp(res.items)).toStrictEqual(
      byFp([
        { fp: fH, from: "r", to: "x" },
        { fp: fI, from: "r", to: "y" },
      ]),
    );
    const Gx = await k.CG(X);
    const Gy = await k.CG(Y);
    expect([...res.moved].sort((a: Json, b: Json) => String(a.from).localeCompare(String(b.from)))).toStrictEqual(
      [
        { from: k.fs(Gr, fH), to: k.fs(Gx, fH) },
        { from: k.fs(Gr, fI), to: k.fs(Gy, fI) },
      ].sort((a, b) => a.from.localeCompare(b.from)),
    );
    expect(res.held).toStrictEqual([]);
    for (const t of [`${fJ}: no key path`, `${fK}: key path src/a.rs is not a repo name`, `${fL}: key path a.ts is not a repo name`]) expect(res.notes, t).toContain(t);
    expect((await k.fsteps(Gx)).map((s) => s.id)).toStrictEqual([k.fs(Gx, fH)]);
    expect((await k.fsteps(Gy)).map((s) => s.id)).toStrictEqual([k.fs(Gy, fI)]);
    expect(new Set((await k.goals()).filter((g) => g.sink).map((g) => g.sink.repo))).toStrictEqual(new Set(["r", "x", "y"]));
    for (const f of [fJ, fK, fL]) {
      expect("repo" in (await k.item(f)), f).toBe(false);
      expect((await k.step(k.fs(Gr, f))).state, f).toBe("ready");
    }
  });

  it("test_AC08_key_path_edges", async () => {
    k = await Sk.start();
    const G1 = await k.run();
    const P = item("rp", { path: "infra.config" });
    const V = item("rv", { path: "v.yaml" });
    const W = item("rw", { path: "a.b2" });
    await k.raise(G1, [P, V, W]);
    const [fP, fV, fW] = [fpR("rp", "infra.config"), fpR("rv", "v.yaml"), fpR("rw", "a.b2")];
    await k.file(G1, [acc(fP), acc(fV), acc(fW)]);
    const res = await k.retargetOk(k.ann, { lineage: LIN(), fps: [fP, fV, fW], from_key_path: true });
    expect(res.items).toStrictEqual([{ fp: fP, from: "r", to: "infra.config" }]);
    expect(res.notes).toContain(`${fV}: key path v.yaml is not a repo name`);
    expect(res.notes).toContain(`${fW}: key path a.b2 is not a repo name`);
    expect(await k.cag("infra.config"), "the infra.config goal").toBeDefined();
  });
});

// =============================================================================================
// AC-09 Retarget checks (route)
// =============================================================================================

describe("RL-10 AC-09 retarget checks", { timeout: 120_000 }, () => {
  it("test_AC09_route_refusals", async () => {
    const { rF } = await fg({ hold: false });
    const lineage = LIN();
    const before = await k.world();
    const refused = async (who: Person | string, body: Record<string, unknown>, status: number, error?: string) => {
      const res = await k.retarget(who, body);
      expect(res.status, `${JSON.stringify(body)}: ${JSON.stringify(res.json)}`).toBe(status);
      if (error !== undefined) expect(res.json.error).toBe(error);
      await k.w.flush();
      expect(await k.world(), `nothing written: ${JSON.stringify(body).slice(0, 120)}`).toStrictEqual(before);
    };
    await refused(k.ann, { lineage, repo: "x" }, 400, TXT);
    await refused(k.ann, { lineage, fps: [fF], all: true, repo: "x" }, 400, TXT);
    await refused(k.ann, { lineage, fps: [fF] }, 400, TXT);
    await refused(k.ann, { lineage, fps: [fF], repo: "x", from_key_path: true }, 400, TXT);
    await refused(k.ann, { lineage, fps: [], repo: "x" }, 400);
    await refused(k.ann, { lineage, fps: ["NOT-AN-FP"], repo: "x" }, 400);
    await refused(k.ann, { lineage, fps: Array.from({ length: 501 }, (_, i) => fpR(`z${i}`)), repo: "x" }, 400);
    await refused(k.ann, { lineage, fps: [fF], repo: "x".repeat(301) }, 400);
    await refused(k.ann, { lineage: "nope|r|audit", all: true, repo: "x" }, 404, "no items in nope|r|audit");
    await refused(k.ann, { lineage, fps: [fF, fpR("zz")], repo: "x" }, 404, `unknown item ${fpR("zz")} in ${lineage}`);
    expect((await k.step(rF)).state, "F not moved by the refused call").toBe("ready");
    await refused(k.carol, { lineage, fps: [fF], repo: "x" }, 403);
    await refused(k.bob.login.token, { lineage, fps: [fF], repo: "x" }, 403);
    // Positive controls: an admin, the owner of the lineage's newest goal.
    expect((await k.retarget(k.root, { lineage, fps: [fF], repo: "x", dry_run: true })).status).toBe(200);
    expect((await k.retarget(k.ann, { lineage, fps: [fF], repo: "x", dry_run: true })).status).toBe(200);
  });

  it("test_AC09_owner_of_holding_goal", async () => {
    // bob owns the x goal (his own run filed C there); ann's F moved into it → bob may retarget ann's lineage.
    k = await Sk.start();
    const B1 = await k.run({ preset: "bobs", owner: k.bob });
    await k.raise(B1, [IR(IC, X)], { who: k.bob });
    await k.file(B1, [acc(fC)], { who: k.bob });
    const G1 = await k.run();
    await k.raise(G1, [IF, IG]);
    await k.file(G1, [acc(fF), acc(fG)]);
    const no = await k.retarget(k.bob, { lineage: LIN(), fps: [fG], repo: "x", dry_run: true });
    expect(no.status, "control: bob holds no step of the lineage yet").toBe(403);
    await k.retargetOk(k.ann, { lineage: LIN(), fps: [fF], repo: "x" });
    const yes = await k.retarget(k.bob, { lineage: LIN(), fps: [fG], repo: "x", dry_run: true });
    expect(yes.status, JSON.stringify(yes.json)).toBe(200);
  });
});

// =============================================================================================
// AC-10 Backfill grouped (route)
// =============================================================================================

describe("RL-10 AC-10 backfill grouped", { timeout: 120_000 }, () => {
  const P1 = item("p1", { severity: "S4", title: "T-P1" });
  const P2 = item("p2", { severity: "S4", title: "T-P2" });
  const P3 = item("p3", { severity: "S2", title: "T-P3" });
  const [f1, f2, f3] = [fpR("p1"), fpR("p2"), fpR("p3")];
  const L = LIN("plain");
  const plainX = async () => {
    const R = await k.run({ preset: "plain", steps: [AUDIT, FILE({ sink: undefined })] });
    await k.raise(R, [IR(P1, X), IR(P2, X), P3]);
    await k.file(R, [acc(f1), acc(f2), acc(f3)]);
    expect(await k.cag("r")).toBeUndefined();
    expect(await k.cag(X)).toBeUndefined();
  };
  const sink = (who: Person | string, b: Record<string, unknown> = {}) => k.call(who, "POST", "/v1/items/sink", { lineage: L, topic: "ci", ...b });
  const ends = (ids: string[], f: string) => ids.filter((id) => id === fid(L, f) || id.endsWith(`/${fid(L, f)}`) || id.endsWith(`.${fid(L, f)}`));

  it("test_AC10_route", async () => {
    k = await Sk.start();
    await plainX();
    const none = await sink(k.ann, { min_severity: "S1" });
    expect(none.status, JSON.stringify(none.json)).toBe(200);
    expect(none.json).toMatchObject({ goal: null, goals: [] });
    const dry = await sink(k.ann, { dry_run: true });
    expect(dry.status, JSON.stringify(dry.json)).toBe(200);
    expect(dry.json.goal).toBeNull();
    const gs = dry.json.goals as Json[];
    expect(gs.map((g) => g.repo)).toStrictEqual(["r", "x"]);
    for (const g of gs) {
      expect(g.goal).toBeNull();
      expect(g.reopened).toStrictEqual([]);
    }
    expect(ends(gs[0].added, f3)).toHaveLength(1);
    expect(gs[0].added).toHaveLength(1);
    expect(gs[1].added).toHaveLength(2);
    for (const f of [f1, f2]) expect(ends(gs[1].added, f), f).toHaveLength(1);
    expect([...dry.json.added].sort()).toStrictEqual([...gs[0].added, ...gs[1].added].sort());
    expect(await k.cag("r")).toBeUndefined();
    expect(await k.cag(X)).toBeUndefined();
    const real = await sink(k.ann);
    expect(real.status, JSON.stringify(real.json)).toBe(200);
    const Gr = await k.CG("r");
    const Gx = await k.CG(X);
    expect(real.json.goal).toBeNull();
    expect((real.json.goals as Json[]).map((g) => [g.repo, g.goal])).toStrictEqual([
      ["r", Gr],
      [X, Gx],
    ]);
    expect((await k.fsteps(Gr)).map((s) => s.id)).toStrictEqual([k.fs(Gr, f3, L)]);
    expect((await k.fsteps(Gx)).map((s) => s.id).sort()).toStrictEqual([k.fs(Gx, f1, L), k.fs(Gx, f2, L)].sort());
    for (const s of await k.fsteps(Gx)) expect(s.repo).toBe("x");
    // One entry → `goal` is that entry's goal.
    const one = await sink(k.ann, { min_severity: "S2" });
    expect(one.status).toBe(200);
    expect(one.json).toMatchObject({ goal: Gr, goals: [{ goal: Gr, repo: "r", added: [], reopened: [] }] });
  });

  it("test_AC10_route_who", async () => {
    k = await Sk.start();
    await plainX();
    expect((await sink(k.carol)).status).toBe(403);
    expect((await sink(k.bob)).status, "control: bob owns nothing yet").toBe(403);
    const B1 = await k.run({ preset: "bobs", owner: k.bob });
    await k.raise(B1, [IR(IC, X)], { who: k.bob });
    await k.file(B1, [acc(fC)], { who: k.bob });
    const res = await sink(k.bob);
    expect(res.status, JSON.stringify(res.json)).toBe(200);
  });
});

// =============================================================================================
// AC-11 Deps stay within a goal
// =============================================================================================

describe("RL-10 AC-11 deps within a goal", { timeout: 90_000 }, () => {
  it("test_AC11_requires_across_goals", async () => {
    k = await Sk.start();
    const G1 = await k.run();
    await k.raise(G1, [IR(IM, X), IR(IN, Y)]);
    await k.file(G1, [acc(fM, { requires: [fN] }), acc(fN)]);
    const xM = k.fs(await k.CG(X), fM);
    const yN = k.fs(await k.CG(Y), fN);
    expect(await k.step(xM)).toMatchObject({ state: "ready", deps: [] });
    expect(await k.notes(xM)).toContain(`requires ${fN}: not in this goal`);
    expect((await k.step(yN)).state).toBe("ready");
  });

  it("test_AC11_requires_same_target", async () => {
    k = await Sk.start();
    const G1 = await k.run();
    await k.raise(G1, [IR(IM, X), IR(IN, X)]);
    await k.file(G1, [acc(fM, { requires: [fN] }), acc(fN)]);
    const Gx = await k.CG(X);
    const xM = k.fs(Gx, fM);
    expect(await k.step(xM)).toMatchObject({ state: "blocked", deps: [k.fs(Gx, fN)] });
    expect((await k.notes(xM)).filter((n) => n.includes("not in this goal"))).toStrictEqual([]);
  });

  it("test_AC11_moved_away_not_matched", async () => {
    const { Gr, rD } = await filedDE();
    const G2 = await k.run();
    await k.raise(G2, [IR(ID, X), IE]);
    expect((await k.step(rD)).movedTo, "control: D moved").toBe(k.fs(await k.CG(X), fD));
    const E2 = item("re2", { title: "T-E2" });
    const fE2 = fpR("re2");
    k.tick();
    const G3 = await k.run();
    await k.raise(G3, [ID, IE, E2]);
    await k.file(G3, [acc(fE2, { requires: [fD] })]);
    const rE2 = k.fs(Gr, fE2);
    expect(await k.step(rE2)).toMatchObject({ state: "ready", deps: [] });
    expect(await k.notes(rE2)).toContain(`requires ${fD}: not in this goal`);
  });
});
