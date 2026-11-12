// RL-6 AC-17: the whole programme in one World (a temp git checkout + the fake claude, never the real
// binary): pulse → headless audit → validator → the owner's debrief → filer → second slot → stats →
// calibration. Written from the spec's contracts only (docs/specs/RL-6.md, AC-17; design §5.6 relay as
// the pulse's preset text). One `it`, with a labelled expectation per stage.

import { createHash } from "node:crypto";
import { mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AUDITOR, git, Relay } from "./helpers/relay-kit.ts";
import { DAY, iso, Pk, REPO_ID, snap, T0, type Json } from "./helpers/pulse-kit.ts";
import { disp } from "./helpers/review-kit.ts";
import type { Person } from "./helpers/world.ts";

const NOW = T0 - DAY;
const CHECKER = "---\nname: checker\ndescription: Checks findings\n---\nYou check.\n";
const FILER = "---\nname: filer\ndescription: Files accepted findings\n---\nYou file.\n";
const SIX = ["line one", "const secret = load();", "if (secret) {", "  use(secret);", "}", "end"];
const LINK = "https://tracker.invalid/issue/1";
const sha = (s: string) => createHash("sha256").update(s, "utf8").digest("hex");
/** The documented `agentFileHash`: SHA-256 of the text with CRLF turned into LF. */
const fileHash = (t: string) => sha(t.replace(/\r\n/g, "\n"));
const LINEAGE = "relay|alpha|auditor";

/** Design §5.6 relay with a debrief; `file` records its link (output review-record, may_set accepted). */
const RELAY = `description: Audit by an agent, validated by an agent, debriefed by the owner, filed by an agent.
steps:
  - id: audit
    kind: review
    repo: "{repo}"
    agent: "{agent}"
    mode: headless
    profile: read-only
    output: review-record
    budget: { turns: 80, minutes: 60 }
    inputs: [previous]
    title: Audit {repo}
    brief: Audit {repo}. Report every finding you see.
  - id: validate
    kind: review
    repo: "{repo}"
    deps: [audit]
    agent: "{validator}"
    mode: headless
    profile: read-only
    output: review-record
    when: { open: true }
    consumes: [open]
    may_set: [confirmed, dismissed]
    inputs: [audit, dispositions]
    title: Validate the findings
    brief: Try to refute each open item from the source; confirm or dismiss each with a reason.
  - id: debrief
    kind: review
    repo: "{repo}"
    deps: [validate]
    mode: debrief
    assignee: "@owner"
    output: review-record
    when: { open: true, min_severity: S2 }
    consumes: [open, confirmed]
    may_set: [accepted, dismissed, deferred]
    title: Debrief the findings
    brief: Go through the confirmed items with the owner, one at a time.
  - id: file
    kind: docs
    repo: "{repo}"
    deps: [debrief]
    agent: "{filer}"
    mode: headless
    profile: propose-via-branch
    output: review-record
    when: { open: true }
    consumes: [accepted]
    may_set: [accepted]
    inputs: [dispositions]
    title: File the accepted items
    brief: Propose an entry for each accepted item; record its link.
`;

let k: Pk;
let ann: Person;

beforeAll(async () => {
  const r = await Relay.start(["ann"], {
    hubYaml: { calibration: { threshold: 2 }, thresholds: { machine_offline: "30d", offer_expiry: "30m" }, auth: { session: { device_max_age: "60d", device_idle: "30d" } } },
  });
  r.w.clock = NOW;
  k = new Pk(r);
  k.tok.ann = (await r.w.login("ann", { hostname: "ann-login" })).token;
  ann = await r.headlessPerson("ann", { repo: "alpha", nick: "runner", agents: { checker: CHECKER, filer: FILER }, person: { shareSessions: "me" } });
  const root = realpathSync(ann.repoDir);
  mkdirSync(join(root, "src"), { recursive: true });
  writeFileSync(join(root, "src", "a.ts"), `${SIX.join("\n")}\n`);
  git(root, ["add", "-A"]);
  git(root, ["commit", "-qm", "source"]);
  // A remote-backed repo (the runner reports only those): origin is REPO_ID's URL, rewritten to a bare repo.
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
async function stats(key: string): Promise<Json> {
  const res = await k.call("ann", "GET", `/v1/agents/${encodeURIComponent(key)}/stats`);
  expect(res.status, `stats ${key}: ${JSON.stringify(res.json)}`).toBe(200);
  return res.json;
}
async function calibGoals(): Promise<Json[]> {
  const res = await k.call("ann", "GET", "/v1/goals?pulses=1");
  expect(res.status, JSON.stringify(res.json)).toBe(200);
  return (res.json.goals as Json[]).filter((g) => g.calibration);
}

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
  expect((await k.step(id)).state, `${id} done`).toBe("done");
}
async function offeredToRunner(id: string): Promise<void> {
  const st = await k.step(id);
  expect(st.state, `${id} ready`).toBe("ready");
  expect(st.offer, `${id} offered to the runner`).toMatchObject({ to: { machine: k.w.machineOf(ann) }, state: "offered" });
}
async function fire(at: number): Promise<string> {
  k.at(at);
  await k.r.reconcile(ann);
  await k.w.tick();
  const G = (await k.slotOf("p-1", iso(at))).goal as string;
  expect(typeof G, `slot ${iso(at)} fired a goal`).toBe("string");
  return G;
}

describe("RL-6 AC-17 whole programme", { timeout: 180_000 }, () => {
  it("test_AC17_whole_programme", async () => {
    const AUD = fileHash(AUDITOR);
    const CHK = fileHash(CHECKER);
    const FIL = fileHash(FILER);
    const p = await k.pulseOk("ann", { preset: snap("relay", RELAY), params: { repo: "alpha", agent: "auditor", validator: "checker", filer: "filer" }, when: { every: "7d" } });
    expect(p.id).toBe("p-1");
    const F1 = (await k.pulseOf("p-1")).nextAt as number;
    expect(F1, "first slot 7 days on").toBe(NOW + 7 * DAY);

    // ---- slot 1 ---------------------------------------------------------------------------------
    const G1 = await fire(F1);
    expect(((await k.goal(G1)).steps as Json[]).map((s) => s.id), "slot 1: no design step").toStrictEqual(["audit", "validate", "debrief", "file"].map((s) => `${G1}.${s}`));
    await offeredToRunner(`${G1}.audit`);
    await runStarts(`${G1}.audit`, 11, [{ waitFor: "end-11" }]);
    expect(k.r.calls(`${G1}.audit`), "one fake start for the audit").toHaveLength(1);
    expect(realpathSync(String(k.r.calls(`${G1}.audit`)[0]?.cwd)), "audit runs in the runner's workspace").toContain(realpathSync(ann.dir));
    await toolOk(11, "mesh_artifact", { kind: "report", content: "# Audit\nTwo findings.\n" });
    await toolOk(11, "mesh_review", recArgs({ items: [item("A", "S2", [2, 3]), item("B", "S3", [4, 5])] }));
    await finish(`${G1}.audit`, 11, "end-11");
    expect((await k.r.artifactsOf(G1, k.tok.ann)).filter((a) => a.kind === "report"), "audit report artifact").toHaveLength(1);
    const A = (await byTitle("T-A")).fp as string;
    const B = (await byTitle("T-B")).fp as string;
    expect(A && B).toBeTruthy();

    await offeredToRunner(`${G1}.validate`);
    await runStarts(`${G1}.validate`, 12, [{ waitFor: "end-12" }]);
    await toolOk(12, "mesh_review", recArgs({ assessment: "clean", dispositions: [disp(A, "confirmed"), disp(B, "dismissed")] }));
    await finish(`${G1}.validate`, 12, "end-12");
    expect((await byTitle("T-A")).state).toBe("confirmed");
    expect((await byTitle("T-B")).state).toBe("dismissed");

    // The debrief: ready for ann, never offered, never started on the runner.
    const D1 = `${G1}.debrief`;
    const d = await k.step(D1);
    expect(d.state, "debrief ready").toBe("ready");
    expect(d.offer, "debrief never offered").toBeUndefined();
    expect((await k.r.inboxOf(ann)).filter((m) => m.kind === "offer" && m.data?.step === D1)).toStrictEqual([]);
    await k.w.hook(ann, "SessionStart", 31);
    await toolOk(31, "mesh_claim", { step: D1 });
    await k.w.flush();
    await toolOk(31, "mesh_dispose", { fingerprint: A, disposition: "accepted", reason: "real", answer: "yes, file it" });
    await toolOk(31, "mesh_review", recArgs({ assessment: "clean", dispositions: [] }));
    await toolOk(31, "mesh_done", { outcome: "done", summary: "debriefed" });
    await k.w.flush();
    expect((await k.step(D1)).state, "debrief done").toBe("done");
    expect(k.r.calls(D1), "fake never started for the debrief").toStrictEqual([]);
    expect((await byTitle("T-A")).state).toBe("accepted");

    // The filer: offered to the runner, runs propose-via-branch, records A accepted with the link.
    await offeredToRunner(`${G1}.file`);
    await runStarts(`${G1}.file`, 13, [{ commit: true }, { waitFor: "end-13" }]);
    await toolOk(13, "mesh_review", recArgs({ assessment: "clean", dispositions: [disp(A, "accepted", { link: LINK })] }));
    await finish(`${G1}.file`, 13, "end-13");
    expect(k.r.calls(`${G1}.file`)).toHaveLength(1);
    expect((await k.step(`${G1}.file`)).rounds.at(-1).branch, "file round has a branch").toBeTruthy();
    const a1 = await byTitle("T-A");
    expect(a1.state).toBe("accepted");
    expect(a1.link, "the filer's link is applied (fix 2)").toBe(LINK);
    expect(await k.goalState(G1), "G1 done").toBe("done");
    expect(await calibGoals(), "no calibration goal after slot 1").toStrictEqual([]);

    // ---- slot 2 ---------------------------------------------------------------------------------
    const G2 = await fire(F1 + 7 * DAY);
    expect(G2).not.toBe(G1);
    await offeredToRunner(`${G2}.audit`);
    await runStarts(`${G2}.audit`, 21, [{ waitFor: "end-21" }]);
    await toolOk(21, "mesh_review", recArgs({ items: [item("A", "S2", [2, 3]), item("B", "S3", [4, 5]), item("C", "S3", [5, 6])] }));
    await finish(`${G2}.audit`, 21, "end-21");
    const [rv] = (await k.call("ann", "GET", `/v1/steps/${G2}.audit/reviews`)).json.reviews as Json[];
    expect(rv.fold.carried, "B carried dismissed").toBe(1);
    expect((await byTitle("T-B")).state).toBe("dismissed");
    const a2 = await byTitle("T-A");
    expect(a2.state).toBe("accepted");
    expect(a2.link, "the link is kept").toBe(LINK);
    const C = (await byTitle("T-C")).fp as string;
    expect((await byTitle("T-C")).state).toBe("open");

    await offeredToRunner(`${G2}.validate`);
    await runStarts(`${G2}.validate`, 22, [{ waitFor: "end-22" }]);
    await toolOk(22, "mesh_review", recArgs({ assessment: "clean", dispositions: [disp(C, "dismissed")] }));
    await finish(`${G2}.validate`, 22, "end-22");
    const cal = await calibGoals();
    expect(cal, "one calibration goal after slot 2").toHaveLength(1);
    expect(cal[0].calibration).toMatchObject({ key: "alpha/auditor", hash: AUD, threshold: 2 });
    expect(cal[0].ownerId, "calibrator = the pulse owner").toBe("ann");
    expect((cal[0].calibration.dismissals as Json[]).map((r) => r.fp)).toStrictEqual([B, C]);

    expect((await k.step(`${G2}.debrief`)).state, "G2 debrief skipped").toBe("skipped");
    expect((await k.step(`${G2}.file`)).state, "G2 file skipped (A is filed)").toBe("skipped");
    expect(k.r.calls(`${G2}.debrief`)).toStrictEqual([]);
    expect(k.r.calls(`${G2}.file`)).toStrictEqual([]);
    expect(await k.goalState(G2), "G2 done").toBe("done");
    // Positive control: each slot-1 agent step ran once on the runner.
    for (const s of ["audit", "validate", "file"]) expect(k.r.calls(`${G1}.${s}`), `${G1}.${s}`).toHaveLength(1);

    // ---- telemetry -----------------------------------------------------------------------------
    const want: [string, string, string][] = [
      [`${G1}.audit`, "alpha/auditor", AUD],
      [`${G1}.validate`, "alpha/checker", CHK],
      [`${G1}.file`, "alpha/filer", FIL],
      [`${G2}.audit`, "alpha/auditor", AUD],
      [`${G2}.validate`, "alpha/checker", CHK],
    ];
    for (const [id, key, hash] of want) {
      const t = (await k.step(id)).rounds.at(-1).telemetry;
      expect(t, `telemetry of ${id}`).toBeDefined();
      expect(t, `telemetry of ${id}`).toMatchObject({ agentKey: key, agentHash: hash });
    }

    // ---- stats ---------------------------------------------------------------------------------
    const s = await stats("alpha/auditor");
    expect(s.hashes, "one auditor hash").toHaveLength(1);
    expect(s.hashes[0]).toMatchObject({ hash: AUD, runs: 2, raised: 5, new: 3, carried: 1, accepted: 1, dismissedByAgents: 2, dismissedByPeople: 0, calibrating: 2, uncalibrated: 0, calibration: cal[0].id });
    expect((await stats("alpha/checker")).hashes.find((h: Json) => h.hash === CHK)?.runs, "checker runs").toBe(2);
    expect((await stats("alpha/filer")).hashes.find((h: Json) => h.hash === FIL)?.runs, "filer runs").toBe(1);
  });
});
