// RL-3 AC-22 end to end (World + a temp git checkout + the fake claude): an agent-only `audit-relay`
// pulse added with the CLI fires twice; each step runs headless on the owner's runner machine (the
// fake `claude`, never the real binary), the run sessions call the mesh tools as RL-1/RL-2 daemon
// tests do, and the second slot carries the first slot's decisions. Written from the spec's
// contracts only (docs/specs/RL-3.md).

import { mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { git, Relay } from "./helpers/relay-kit.ts";
import { DAY, iso, MIN, Pk, REPO_ID, T0, type Json } from "./helpers/pulse-kit.ts";
import { disp } from "./helpers/review-kit.ts";
import type { Person } from "./helpers/world.ts";

const NOW = T0 - DAY;
const LINEAGE = "audit-relay|alpha|auditor";
const CHECKER = "---\nname: checker\ndescription: Checks findings\n---\nYou check.\n";
const FILER = "---\nname: filer\ndescription: Files confirmed findings\n---\nYou file.\n";
const SIX = ["line one", "const secret = load();", "if (secret) {", "  use(secret);", "}", "end"];
const LINK = "https://tracker.invalid/issue/1";

let k: Pk;
let ann: Person;
let F1 = 0;
let G1 = "";
let G2 = "";
const fps: Record<string, string> = {};

beforeAll(async () => {
  // Device tokens outlive the second slot (14 days after the logins; the default max age is 14d).
  const r = await Relay.start(["ann"], { hubYaml: { thresholds: { machine_offline: "30d", offer_expiry: "30m" }, auth: { session: { device_max_age: "60d", device_idle: "30d" } } } });
  r.w.clock = NOW;
  k = new Pk(r);
  k.tok.ann = (await r.w.login("ann", { hostname: "ann-login" })).token;
  ann = await r.headlessPerson("ann", { repo: "alpha", nick: "runner", agents: { checker: CHECKER, filer: FILER }, person: { shareSessions: "me" } });
  const root = realpathSync(ann.repoDir);
  mkdirSync(join(root, "src"), { recursive: true });
  writeFileSync(join(root, "src", "a.ts"), `${SIX.join("\n")}\n`);
  git(root, ["add", "-A"]);
  git(root, ["commit", "-qm", "source"]);
  // A remote for propose-via-branch pushes. The runner reports repo alpha (AC-22): its inventory
  // (MM-1) needs a share level other than `steps` and a non-`local/` origin, so origin is the URL
  // of REPO_ID and git rewrites it to the bare repo here (`url.<bare>.insteadOf`).
  const bare = join(ann.dir, "remote.git");
  git(ann.dir, ["init", "-q", "--bare", bare]);
  const url = `https://${REPO_ID}.git`;
  git(root, ["config", `url.${bare}.insteadOf`, url]);
  git(root, ["remote", "add", "origin", url]);
  git(root, ["push", "-q", "origin", "HEAD:refs/heads/main"]);
  await r.reconcile(ann);
});
afterAll(async () => {
  await k?.stop();
});

const tool = (pid: number, name: string, args: Record<string, unknown>) => k.w.tool(ann, pid, name as never, args);
async function toolOk(pid: number, name: string, args: Record<string, unknown>): Promise<string> {
  const t = await tool(pid, name, args);
  expect(t.isError, `${name}: ${t.text}`).toBeFalsy();
  return t.text;
}
const item = (rule: string, severity: string, lines: [number, number]) => ({ key: { rule, path: "src/a.ts" }, title: `T-${rule}`, severity, category: "c", evidence: [{ path: "src/a.ts", lines }] });
const recArgs = (o: Record<string, unknown>) => ({ coverage: "complete", assessment: "issues", items: [], summary: "s", ...o });
async function items(): Promise<Json[]> {
  const res = await k.call("ann", "GET", `/v1/items?lineage=${encodeURIComponent(LINEAGE)}`);
  expect(res.status, JSON.stringify(res.json)).toBe(200);
  return res.json.items;
}
const byTitle = async (t: string): Promise<Json> => (await items()).find((x) => x.title === t);

/** Pull the offer of `id`, wait for the fake, register the run's session as `pid`. */
async function runStarts(id: string, pid: number, script: unknown[]): Promise<Json> {
  k.r.script(id, script);
  await k.r.pull(ann);
  await k.r.started(id);
  return k.r.runSession(ann, id, pid);
}
async function finish(id: string, pid: number, gate: string): Promise<void> {
  await toolOk(pid, "mesh_done", { outcome: "done", summary: "s" });
  k.r.go(gate);
  await k.r.endRun(ann, id);
  expect((await k.step(id)).state, id).toBe("done");
}

describe("AC-22 relay end to end", { timeout: 120_000 }, () => {
  it("test_AC22_add", async () => {
    const res = await k.r.cli(ann, ["pulse", "add", "--preset", "audit-relay", "--repo", "alpha", "--params", "agent=auditor,validator=checker,filer=filer", "--every", "7d"]);
    expect(res.code, res.err).toBe(0);
    const p = await k.pulseOf("p-1");
    expect(p.nextAt).toBe(NOW + 7 * DAY);
    F1 = p.nextAt as number;
  });

  it("test_AC22_fire_audit", async () => {
    k.at(F1);
    await k.r.reconcile(ann);
    await k.w.tick();
    G1 = (await k.slotOf("p-1", iso(F1))).goal as string;
    expect(typeof G1).toBe("string");
    const id = `${G1}.audit`;
    expect((await k.step(id)).offer).toMatchObject({ to: { machine: k.w.machineOf(ann) }, state: "offered" });
    const run = await runStarts(id, 11, [{ waitFor: "end-11" }]);
    expect((await k.step(id)).state).toBe("claimed");
    const pulse = await k.pulseOf("p-1");
    const snap = pulse.profiles["read-only"];
    expect(run.profile.sha256).toBe(snap.sha256);
    const settings = JSON.parse(readFileSync(join(k.r.runDir(ann, run), "profile.json"), "utf8"));
    expect(settings).toMatchObject(snap.settings);
    const [started] = await k.r.events("run.started", id);
    expect(started?.payload.profileHash).toBe(snap.sha256);
  });

  it("test_AC22_audit_record", async () => {
    const id = `${G1}.audit`;
    await toolOk(11, "mesh_artifact", { kind: "report", content: "# Audit\nTwo findings.\n" });
    await toolOk(11, "mesh_review", recArgs({ items: [item("A", "S2", [2, 3]), item("B", "S3", [4, 5])] }));
    await finish(id, 11, "end-11");
    fps.A = (await byTitle("T-A")).fp;
    fps.B = (await byTitle("T-B")).fp;
    expect(fps.A && fps.B).toBeTruthy();
    // The run.started report set startedAt at once, at its clock; the next tick runs a minute later.
    k.at(F1 + MIN);
    await k.w.tick();
    expect((await k.slotOf("p-1", iso(F1))).startedAt).toBe(F1);
    expect((await k.step(id)).rounds.at(-1).telemetry).toBeDefined();
  });

  it("test_AC22_validate", async () => {
    const id = `${G1}.validate`;
    const st = await k.step(id);
    expect(st.state).toBe("ready");
    expect(st.offer).toMatchObject({ to: { machine: k.w.machineOf(ann) }, state: "offered", stick: true });
    expect(((await k.slotOf("p-1", iso(F1))).tried as Json[]).map((t) => t.machine)).toStrictEqual([k.w.machineOf(ann)]);
    await runStarts(id, 12, [{ waitFor: "end-12" }]);
    await toolOk(12, "mesh_review", recArgs({ assessment: "clean", dispositions: [disp(fps.A as string, "confirmed"), disp(fps.B as string, "dismissed")] }));
    await finish(id, 12, "end-12");
    expect((await byTitle("T-A")).state).toBe("confirmed");
    expect((await byTitle("T-B")).state).toBe("dismissed");
    expect((await k.step(id)).rounds.at(-1).telemetry).toBeDefined();
  });

  it("test_AC22_file", async () => {
    const id = `${G1}.file`;
    const st = await k.step(id);
    expect(st.state).toBe("ready");
    expect(st.offer).toMatchObject({ to: { machine: k.w.machineOf(ann) }, state: "offered" });
    await runStarts(id, 13, [{ commit: true }, { waitFor: "end-13" }]);
    await toolOk(13, "mesh_review", recArgs({ assessment: "clean", dispositions: [disp(fps.A as string, "accepted", { link: LINK })] }));
    await finish(id, 13, "end-13");
    expect(k.r.calls(id)).toHaveLength(1);
    const a = await byTitle("T-A");
    expect(a.state).toBe("accepted");
    expect(JSON.stringify(a)).toContain(LINK);
    expect((await k.step(id)).rounds.at(-1).telemetry).toBeDefined();
    expect(await k.goalState(G1)).toBe("done");
  });

  it("test_AC22_second_slot", async () => {
    const F2 = F1 + 7 * DAY;
    k.at(F2);
    await k.r.reconcile(ann);
    await k.w.tick();
    G2 = (await k.slotOf("p-1", iso(F2))).goal as string;
    expect(G2).not.toBe(G1);
    const id = `${G2}.audit`;
    await runStarts(id, 21, [{ waitFor: "end-21" }]);
    await toolOk(21, "mesh_review", recArgs({ items: [item("A", "S2", [2, 3]), item("B", "S3", [4, 5])] }));
    await finish(id, 21, "end-21");
    const [rv] = (await k.call("ann", "GET", `/v1/steps/${id}/reviews`)).json.reviews as Json[];
    expect(rv.fold.carried).toBe(1);
    expect((await byTitle("T-B")).state).toBe("dismissed");
    const a = await byTitle("T-A");
    expect(a.state).toBe("accepted");
    expect(JSON.stringify(a)).toContain(LINK);
    expect((await k.step(`${G2}.validate`)).state).toBe("skipped");
    expect((await k.step(`${G2}.file`)).state).toBe("skipped");
    expect(await k.goalState(G2)).toBe("done");
    expect(k.r.calls(`${G2}.file`)).toStrictEqual([]);
    expect(k.r.calls(`${G2}.validate`)).toStrictEqual([]);
    // Positive control: the first slot's steps did run.
    for (const s of ["audit", "validate", "file"]) expect(k.r.calls(`${G1}.${s}`), s).toHaveLength(1);
  });

  it("test_AC22_pulse_view", async () => {
    const d = await k.detail("ann", "p-1");
    const fired = (d.slots as Json[]).filter((s) => s.state === "fired");
    expect(fired.map((s) => s.goal).sort()).toStrictEqual([G1, G2].sort());
    for (const s of fired) expect(typeof s.startedAt, s.slot).toBe("number");
    expect(d.goals).toMatchObject({ [G1]: "done", [G2]: "done" });
    const plain = ((await k.call("ann", "GET", "/v1/goals")).json.goals as Json[]).map((g) => g.id);
    expect(plain).not.toContain(G1);
    expect(plain).not.toContain(G2);
    const all = ((await k.call("ann", "GET", "/v1/goals?pulses=1")).json.goals as Json[]).map((g) => g.id);
    expect(all).toContain(G1);
    expect(all).toContain(G2);
  });
});
