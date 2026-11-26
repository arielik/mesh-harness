// RL-26 end to end (World + the fake claude): the daemon's side of a stop. A `run_stop` kills a
// running run (exit killed_operator, transcript, no done, no push), drops a queued one, reports
// no-run and already-ended; a `stop` interrupts or ends a session only when the machine's own config
// allows it; the consent config and its sync facts; a listed headless team offer kept until the
// owner accepts it. Written from the spec's contracts (docs/specs/RL-26.md, AC-04 to AC-06, AC-09,
// AC-10, AC-12, AC-16). No test runs the real `claude`, tmux or a real signal.

import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { meshCommands, type CliEnv } from "../src/cli/mesh-commands.ts";
import { DaemonConfig, resolvePaths } from "../src/protocol/index.ts";
import { Relay, git, sleep, until, type PlanIn } from "./helpers/relay-kit.ts";
import type { Json, Person } from "./helpers/world.ts";

let r: Relay;
const dirs: string[] = [];
afterEach(async () => {
  await r?.stop();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

interface K {
  ann: Person;
  /** ann's other login: offers to ann's machine are auto (`self`), and stops come from it. */
  self: string;
}

async function kit(o: { maxSessions?: number; remoteStop?: boolean; share?: "steps" | "me" | "all" } = {}): Promise<K> {
  r = await Relay.start(["ann", "bob"]);
  const ann = await r.headlessPerson("ann", { nick: "hl", person: { shareSessions: o.share ?? "all" } });
  const change = { ...(o.maxSessions !== undefined ? { maxSessions: o.maxSessions } : {}), ...(o.remoteStop !== undefined ? { remoteStop: o.remoteStop } : {}) };
  if (Object.keys(change).length) await r.w.restart(ann, change);
  const self = await r.otherLogin("ann");
  await r.w.flush();
  return { ann, self };
}

async function headless(k: K, step: PlanIn, script: unknown[]): Promise<string> {
  const G = await r.goal(k.self, [step]);
  const id = `${G}.${step.id}`;
  r.script(id, script);
  return id;
}

const stopRun = (k: K, id: string, reason = "wrong base") => r.w.call(k.self, "POST", `/v1/steps/${id}/stop-run`, { reason });
const msgOf = async (k: K, kind: string) => (await r.inboxOf(k.ann)).filter((m: Json) => m.kind === kind).at(-1);
const acksOf = (p: Person, id: number) => p.acks.filter((a) => a.id === id);
const doneCalls = (p: Person, id: string) => p.requests.filter((q) => q.method === "POST" && q.path === `/v1/steps/${encodeURIComponent(id)}/done`);

describe("AC-04 a run_stop kills the running run", { timeout: 60_000 }, () => {
  it("test_AC04_kill_transcript_no_done", async () => {
    const k = await kit();
    const id = await headless(k, { id: "x", mode: "headless" }, [{ waitFor: "never" }]);
    await r.autoOffer(k.ann, id, k.self);
    await r.pull(k.ann);
    await r.started(id);
    await r.w.flush();
    expect(await until(async () => (await r.events("run.started", id)).length > 0, 5_000)).toBe(true);
    const sync = k.ann.syncs.at(-1);
    expect(sync.machine).toMatchObject({ runStop: true, remoteStop: false, teamOffers: false });
    const res = await stopRun(k, id);
    expect(res.status, JSON.stringify(res.json)).toBe(200);
    await r.pull(k.ann);
    expect(await until(() => acksOf(k.ann, res.json.message).length > 0, 5_000)).toBe(true);
    expect(acksOf(k.ann, res.json.message)).toStrictEqual([{ id: res.json.message, state: "delivered", method: "killed" }]);
    await r.endRun(k.ann, id);
    expect(await until(async () => (await r.runOf(k.ann, id)).state === "finished", 10_000)).toBe(true);
    const run = await r.runOf(k.ann, id);
    expect(run.exit).toBe("killed_operator");
    expect(doneCalls(k.ann, id)).toStrictEqual([]);
    const step = await r.stepOf(id);
    expect(step.state).toBe("parked");
    const arts = (await r.artifactsOf(id.split(".")[0] as string, k.self)).filter((a: Json) => a.step === id);
    expect(arts.map((a: Json) => [a.kind, a.round, a.title])).toStrictEqual([["transcript", 1, "run transcript (killed_operator)"]]);
    const [fin] = await r.events("run.finished", id);
    expect(fin?.payload?.exit).toBe("killed_operator");
    expect(fin?.payload).not.toHaveProperty("round");
    const [stopped] = await r.events("run.stopped", id);
    expect(stopped?.payload).toMatchObject({ machine: r.w.machineOf(k.ann), outcome: "killed", state: "delivered", by: "ann", step: id });
    expect(k.ann.notes.some((n) => n.includes(`@ann stopped the headless run of ${id}: wrong base`))).toBe(true);
  });
});

describe("AC-05 queued, no run, already ended", { timeout: 60_000 }, () => {
  it("test_AC05_queued_dropped_and_no_run", async () => {
    const k = await kit({ maxSessions: 1 });
    await r.w.hook(k.ann, "SessionStart", 1);
    await r.w.flush();
    const id = await headless(k, { id: "q", mode: "headless" }, [{ waitFor: "never" }]);
    await r.autoOffer(k.ann, id, k.self);
    await r.pull(k.ann);
    expect((await r.runOf(k.ann, id)).state).toBe("queued");
    const res = await stopRun(k, id);
    expect(res.status, JSON.stringify(res.json)).toBe(200);
    await r.pull(k.ann);
    expect(await until(() => acksOf(k.ann, res.json.message).length > 0, 5_000)).toBe(true);
    expect(acksOf(k.ann, res.json.message)).toStrictEqual([{ id: res.json.message, state: "delivered", method: "dropped" }]);
    expect((await r.runOf(k.ann, id)).state).toBe("released");
    expect(k.ann.requests.filter((q) => q.path.endsWith("/release"))).toStrictEqual([]);
    await r.w.hook(k.ann, "SessionEnd", 1);
    await r.reconcile(k.ann);
    await sleep(200);
    expect(r.calls(id)).toStrictEqual([]);
    // A run_stop for a step with no run here.
    const m = await r.w.hubStore.addMessage({ toMachine: r.w.machineOf(k.ann), toSid: "", fromUser: "ann", kind: "run_stop", text: "MESH: stop", data: { step: "G99.none", goal: "G99", reason: "x", by: "ann" } }, r.w.clock);
    await r.pull(k.ann);
    expect(await until(() => acksOf(k.ann, m.id).length > 0, 5_000)).toBe(true);
    expect(acksOf(k.ann, m.id)).toStrictEqual([{ id: m.id, state: "delivered", method: "no-run" }]);
    // A retried ack emits no second run.stopped.
    const before = (await r.events("run.stopped")).length;
    const again = await r.w.call(k.ann.login.token, "POST", `/v1/inbox/${m.id}/ack`, { state: "delivered", method: "no-run" });
    expect(again.json.ok).toBe(false);
    expect(await r.events("run.stopped")).toHaveLength(before);
  });

  it("test_AC05_already_ended_keeps_its_exit", async () => {
    const k = await kit();
    const id = await headless(k, { id: "e", mode: "headless" }, [{ exit: 0 }]);
    await r.autoOffer(k.ann, id, k.self);
    // The end-of-run step read fails: the run's end waits on the hub.
    k.ann.failOnce(new RegExp(`^/v1/steps/${id.replace(".", "\\.")}$`), 503);
    await r.pull(k.ann);
    const run = await r.runOf(k.ann, id);
    expect(await until(() => r.exitFile(k.ann, run) !== undefined, 10_000)).toBe(true);
    await r.reconcile(k.ann);
    expect((await r.runOf(k.ann, id)).state).toBe("running");
    const res = await stopRun(k, id);
    expect(res.status, JSON.stringify(res.json)).toBe(200);
    await r.pull(k.ann);
    expect(await until(() => acksOf(k.ann, res.json.message).length > 0, 5_000)).toBe(true);
    expect(acksOf(k.ann, res.json.message)).toStrictEqual([{ id: res.json.message, state: "delivered", method: "already-ended" }]);
    await r.reconcile(k.ann);
    expect(await until(async () => (await r.runOf(k.ann, id)).state === "finished", 10_000)).toBe(true);
    expect((await r.runOf(k.ann, id)).exit).not.toBe("killed_operator");
    const [fin] = await r.events("run.finished", id);
    expect(fin?.payload?.exit).not.toBe("killed_operator");
  });
});

describe("AC-06 a stopped run's commits are kept", { timeout: 60_000 }, () => {
  it.each([
    ["with a commit", [{ commit: true }, { waitFor: "never" }], true],
    ["without commits", [{ waitFor: "never" }], false],
  ] as const)("test_AC06_worktree %s", async (_n, script, kept) => {
    const k = await kit();
    const id = await headless(k, { id: "p", mode: "headless", profile: "propose-via-branch" }, [...script]);
    await r.autoOffer(k.ann, id, k.self);
    await r.pull(k.ann);
    const call = await r.started(id);
    if (kept) expect(await until(() => r.calls(id).some((c: Json) => c.head !== undefined) || call.head !== undefined, 5_000)).toBe(true);
    await r.w.flush();
    const res = await stopRun(k, id);
    expect(res.status).toBe(200);
    await r.pull(k.ann);
    await r.endRun(k.ann, id);
    expect(await until(async () => (await r.runOf(k.ann, id)).state === "finished", 10_000)).toBe(true);
    const run = await r.runOf(k.ann, id);
    const wt = r.worktreeOf(k.ann, run);
    let exists = true;
    try {
      git(wt, ["rev-parse", "HEAD"]);
    } catch {
      exists = false;
    }
    expect(exists).toBe(kept);
    const notice = k.ann.notes.find((n) => n.includes(`stopped the headless run of ${id}`)) ?? "";
    expect(notice.includes(`commits kept in ${wt}`)).toBe(kept);
    expect(k.ann.requests.filter((q) => q.path.endsWith("/done"))).toStrictEqual([]);
  });
});

/** A hook session of ann (pid, pane %pid); returns its sid. */
async function hookSession(k: K, pid: number): Promise<string> {
  await r.w.hook(k.ann, "SessionStart", pid);
  await r.w.flush();
  return r.w.session(k.ann, pid).sid;
}
const stopS = (k: K, sid: string, mode: "interrupt" | "end", reason = "looping") => r.w.call(k.self, "POST", `/v1/sessions/${sid}/stop`, { mode, reason });

describe("AC-09 AC-10 session stop on the machine", { timeout: 60_000 }, () => {
  it("test_AC09_interrupt_and_end_in_a_pane", async () => {
    const k = await kit({ remoteStop: true });
    expect(k.ann.syncs.at(-1).machine.remoteStop).toBe(true);
    const sid = await hookSession(k, 501);
    const res = await stopS(k, sid, "interrupt");
    expect(res.status, JSON.stringify(res.json)).toBe(200);
    expect((await r.events("session.stop_requested")).map((e: Json) => e.sid)).toStrictEqual([sid]);
    await r.pull(k.ann);
    expect(await until(() => acksOf(k.ann, res.json.message).length > 0, 5_000)).toBe(true);
    expect(acksOf(k.ann, res.json.message)).toStrictEqual([{ id: res.json.message, state: "delivered", method: "interrupted" }]);
    expect(k.ann.keys).toStrictEqual([{ pane: "%501", key: "Escape" }]);
    expect(k.ann.signals).toStrictEqual([]);
    const [ev] = await r.events("session.stopped");
    expect(ev?.payload).toMatchObject({ outcome: "interrupted", state: "delivered", by: "ann", sid, mode: "interrupt" });
    expect(k.ann.notes.some((n) => n.includes("@ann interrupted") && n.includes(": looping"))).toBe(true);
    expect(r.w.session(k.ann, 501).state).not.toBe("ended");
    const end = await stopS(k, sid, "end", "done here");
    expect(end.status).toBe(200);
    await r.pull(k.ann);
    expect(await until(() => acksOf(k.ann, end.json.message).length > 0, 5_000)).toBe(true);
    expect(acksOf(k.ann, end.json.message)).toStrictEqual([{ id: end.json.message, state: "delivered", method: "ended" }]);
    expect(k.ann.keys).toHaveLength(2);
    expect(k.ann.signals).toStrictEqual([{ pid: 501, signal: "SIGTERM" }]);
    const s = k.ann.daemon.sessions.find((x) => x.sid === sid);
    expect([s?.state, s?.endedReason]).toStrictEqual(["ended", "stopped by @ann: done here"]);
  });

  it("test_AC09_background_session", async () => {
    const k = await kit({ remoteStop: true });
    const sid = await hookSession(k, 502);
    k.ann.daemon.update(sid, { bgId: "bg502", pane: undefined });
    await r.w.flush();
    const i = await stopS(k, sid, "interrupt");
    await r.pull(k.ann);
    expect(await until(() => acksOf(k.ann, i.json.message).length > 0, 5_000)).toBe(true);
    expect(acksOf(k.ann, i.json.message)).toStrictEqual([{ id: i.json.message, state: "failed", method: "no-pane" }]);
    expect([k.ann.keys, k.ann.signals, k.ann.bgStops]).toStrictEqual([[], [], []]);
    const e = await stopS(k, sid, "end");
    await r.pull(k.ann);
    expect(await until(() => acksOf(k.ann, e.json.message).length > 0, 5_000)).toBe(true);
    expect(acksOf(k.ann, e.json.message)).toStrictEqual([{ id: e.json.message, state: "delivered", method: "ended" }]);
    expect(k.ann.bgStops).toStrictEqual(["bg502"]);
    expect(k.ann.daemon.sessions.find((x) => x.sid === sid)?.state).toBe("ended");
  });

  it("test_AC10_daemon_rechecks_its_own_config", async () => {
    const k = await kit({ remoteStop: true });
    const sid = await hookSession(k, 503);
    const res = await stopS(k, sid, "end");
    expect(res.status).toBe(200);
    // The owner turned it off; the daemon has not synced it yet.
    (k.ann.daemon as unknown as { config: DaemonConfig }).config.remoteStop = false;
    await r.pull(k.ann);
    expect(await until(() => acksOf(k.ann, res.json.message).length > 0, 5_000)).toBe(true);
    expect(acksOf(k.ann, res.json.message)).toStrictEqual([{ id: res.json.message, state: "failed", method: "stop-refused" }]);
    expect([k.ann.keys, k.ann.signals, k.ann.bgStops]).toStrictEqual([[], [], []]);
    expect(r.w.session(k.ann, 503).state).not.toBe("ended");
  });
});

describe("AC-12 consent config", () => {
  it("test_AC12_defaults_and_setup", async () => {
    const parsed = DaemonConfig.parse({ port: 1, key: "k".repeat(32) });
    expect([parsed.remoteStop, parsed.teamOffers]).toStrictEqual([false, false]);
    const root = mkdtempSync(join(tmpdir(), "mesh-rl26-"));
    dirs.push(root);
    mkdirSync(join(root, "w"));
    const out: string[] = [];
    const paths = resolvePaths({ MESH_CONFIG_DIR: join(root, "cfg"), MESH_STATE_DIR: join(root, "state"), CLAUDE_CONFIG_DIR: join(root, "claude") }, join(root, "w"));
    const c: CliEnv = { io: { out: (t) => out.push(t), err: (t) => out.push(t) }, paths, env: {}, cwd: join(root, "w"), self: ["mesh"], version: "0.0.0" };
    const setup = meshCommands(c).find((x) => x.name === "setup") as { run(a: string[]): Promise<number> };
    const cfg = () => JSON.parse(readFileSync(paths.daemonConfig, "utf8")) as Record<string, unknown>;
    expect(await setup.run(["--port", "31241"])).toBe(0);
    expect(await setup.run(["--remote-stop", "on"])).toBe(0);
    expect(cfg().remoteStop).toBe(true);
    expect(await setup.run(["--team-offers", "on"])).toBe(0);
    expect([cfg().remoteStop, cfg().teamOffers]).toStrictEqual([true, true]);
    expect(await setup.run(["--remote-stop", "off"])).toBe(0);
    expect(cfg().remoteStop).toBe(false);
    expect(await setup.run(["--team-offers", "maybe"])).toBe(2);
  });
});

describe("AC-16 manual accept of a listed headless team offer", { timeout: 60_000 }, () => {
  it("test_AC16_kept_until_accept", async () => {
    r = await Relay.start(["ann", "bob"]);
    const bob = await r.headlessPerson("bob", { nick: "bb" });
    await r.w.restart(bob, { teamOffers: true });
    await r.w.flush();
    const annTok = await r.otherLogin("ann");
    const svc = await r.w.hub.svc.serviceToken("svc", ["goals:read", "steps:assign"]);
    const G = await r.goal(annTok, [{ id: "h", mode: "headless", profile: "read-only" }, { id: "w", mode: "headless" }]);
    const id = `${G}.h`;
    r.script(id, [{ waitFor: "never" }]);
    const res = await r.w.call(svc, "POST", `/v1/steps/${id}/assign`, { to: "bob/bb" }, { "x-mesh-on-behalf-of": "ann" });
    expect(res.status, JSON.stringify(res.json)).toBe(200);
    expect(res.json.auto).toBe(false);
    await r.pull(bob);
    expect(await until(() => acksOf(bob, res.json.message).length > 0, 5_000)).toBe(true);
    expect(acksOf(bob, res.json.message)).toStrictEqual([{ id: res.json.message, state: "delivered", method: "listed" }]);
    expect(bob.notes.some((n) => n.includes(`@ann offers ${id} "Title h" (repo svc, headless, profile read-only, via svc): mesh accept ${id} or mesh decline ${id}`))).toBe(true);
    expect(bob.store.getKv(`headless-offer:${id}`)).toBeDefined();
    await r.pull(bob);
    await r.w.restart(bob);
    // Session-bound and run-less accepts are refused.
    const withSession = await r.local(bob, "POST", "/local/accept", { step: id, target: "x" });
    expect([withSession.status, withSession.json.error]).toStrictEqual([409, `${id} runs headless; mesh accept ${id} without --session`]);
    const ok = await r.local(bob, "POST", "/local/accept", { step: id });
    expect(ok.status, JSON.stringify(ok.json)).toBe(200);
    expect(ok.json.message).toMatch(new RegExp(`^accepted ${id.replace(".", "\\.")}; (running headless|queued) \\(run \\S+\\)$`));
    await r.started(id);
    expect(bob.store.getKv(`headless-offer:${id}`)).toBeUndefined();
    expect(await until(async () => (await r.events("run.started", id)).length > 0, 5_000)).toBe(true);
    expect((await r.events("run.started", id))[0]?.payload?.profile).toBe("read-only");
    expect((await r.stepOf(id)).holderUser).toBe("bob");
    // A kept entry whose offer was withdrawn is removed by the sweep.
    const w = `${G}.w`;
    const res2 = await r.w.call(svc, "POST", `/v1/steps/${w}/assign`, { to: "bob/bb" }, { "x-mesh-on-behalf-of": "ann" });
    expect(res2.status).toBe(200);
    await r.pull(bob);
    expect(await until(() => bob.store.getKv(`headless-offer:${w}`) !== undefined, 5_000)).toBe(true);
    expect((await r.w.call(annTok, "POST", `/v1/steps/${w}/withdraw`, {})).status).toBe(200);
    await r.w.restart(bob);
    expect(await until(() => bob.store.getKv(`headless-offer:${w}`) === undefined, 5_000)).toBe(true);
  });

  it("test_AC16_refusals", async () => {
    r = await Relay.start(["ann", "bob"]);
    const bob = await r.headlessPerson("bob", { nick: "bb" });
    await r.w.restart(bob, { teamOffers: true });
    await r.w.flush();
    const annTok = await r.otherLogin("ann");
    const svc = await r.w.hub.svc.serviceToken("svc", ["goals:read", "steps:assign"]);
    const G = await r.goal(annTok, [{ id: "h", mode: "headless" }]);
    const id = `${G}.h`;
    const res = await r.w.call(svc, "POST", `/v1/steps/${id}/assign`, { to: "bob/bb" }, { "x-mesh-on-behalf-of": "ann" });
    expect(res.status, JSON.stringify(res.json)).toBe(200);
    await r.pull(bob);
    expect(await until(() => acksOf(bob, res.json.message).length > 0, 5_000)).toBe(true);
    // The kept message is gone (the daemon's store was reset).
    bob.store.deleteKv(`headless-offer:${id}`);
    const gone = await r.local(bob, "POST", "/local/accept", { step: id });
    expect([gone.status, gone.json.error]).toStrictEqual([409, "the offer's run data is not on this machine; ask @ann to offer it again"]);
    // A machine without a headless runner.
    await r.w.restart(bob, {}, { headless: { noRunner: true } });
    const noRunner = await r.local(bob, "POST", "/local/accept", { step: id });
    expect([noRunner.status, noRunner.json.error]).toStrictEqual([409, `this machine cannot run headless steps; mesh decline ${id}`]);
    expect((await r.stepOf(id)).offer.state).toBe("offered");
  });
});
