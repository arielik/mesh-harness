// RL-8 daemon side end to end (World + the fake claude + a holding git runner): a run is started at
// most once, a run being started counts toward maxSessions, git failure texts carry git's last error
// line, a never-started run leaves no transcript and no session, a started run keeps its transcript,
// leftover run sessions end, and a run's session keeps kind `print`. Criteria AC-01 to AC-07 (World).
// Written from the spec's contracts only (docs/specs/RL-8.md). Runs are found by `step`, sessions by
// Claude session id or `sid`, artifacts by kind, requests by (method, path, key). No test runs the real
// `claude`: the fake executable fixture stands in for it.

import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { parseAgentFile } from "../src/core/index.ts";
import type { Session } from "../src/protocol/index.ts";
import { git, holdingRunner, logCount, noBindClaim, Relay, sleep, until, type Holding, type HoldingOptions, type PlanIn } from "./helpers/relay-kit.ts";
import type { Json, Person } from "./helpers/world.ts";

let r: Relay;
let holding: Holding | undefined;
afterEach(async () => {
  // A test that holds always releases (also when it failed before its own release).
  holding?.release();
  holding = undefined;
  await r?.stop();
});

/** The stream `result` event of the spike (§2 shape). */
const RESULT_LINE =
  '{"type":"result","subtype":"success","is_error":false,"num_turns":2,"duration_ms":900,"total_cost_usd":0.001,"usage":{"input_tokens":5,"output_tokens":7,"cache_read_input_tokens":0,"cache_creation_input_tokens":0},"permission_denials":[],"session_id":"$SESSION"}';
const GOOD = "---\ndescription: Good agent\n---\nYou review.\n";
/** Line 2 of the front matter (`description: Validates: findings`) is not valid YAML. */
const BAD = "---\nname: bad\ndescription: Validates: findings\n---\nYou validate.\n";
const PREPARING = "Preparing worktree (detached HEAD 1a2b3c4)\nfatal: 'x' already exists\n";

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const slug = (id: string) => id.toLowerCase().replace(/[^a-z0-9]+/g, "-");
const goalOf = (id: string) => id.split(".")[0] as string;
const real = (p: string) => realpathSync(p);

interface Cast {
  ann: Person;
  /** ann's other login: its offers to ann's machine are auto (accept `self`). */
  self: string;
  h: Holding;
}

/** ann (share `me`, nickname `hl`) with a remote-backed checkout `svc` holding `good` and `bad`; the holding runner. */
async function cast(o: { maxSessions?: number; hold?: HoldingOptions } = {}): Promise<Cast> {
  r = await Relay.start(["ann"]);
  const h = holdingRunner(o.hold);
  holding = h;
  const ann = await r.headlessPerson("ann", { nick: "hl", person: { shareSessions: "me" }, headless: { runner: h.runner }, agents: { good: GOOD, bad: BAD } });
  git(ann.repoDir, ["remote", "add", "origin", "https://git.example.com/rl8/svc.git"]);
  if (o.maxSessions !== undefined) await r.w.restart(ann, { maxSessions: o.maxSessions });
  ann.agents = null;
  const self = await r.otherLogin("ann");
  await r.w.flush();
  return { ann, self, h };
}

/** A goal of ann with one headless step; the fake gets `script(id)` (default: wait for `go-<id>`, a result line, exit 0). */
async function headlessStep(k: Cast, step: PlanIn, script?: (id: string) => unknown[]): Promise<string> {
  const G = await r.goal(k.self, [{ mode: "headless", ...step }]);
  const id = `${G}.${step.id}`;
  r.script(id, script ? script(id) : [{ waitFor: `go-${id}` }, { stdout: [RESULT_LINE] }, { exit: 0 }]);
  return id;
}

/** Fails the test (instead of hanging it) when `p` does not settle within `ms`. */
async function within<T>(p: Promise<T>, what: string, ms = 8_000): Promise<T> {
  let t: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      p,
      new Promise<T>((_, rej) => {
        t = setTimeout(() => rej(new Error(`${what} did not finish within ${ms} ms`)), ms);
      }),
    ]);
  } finally {
    clearTimeout(t);
  }
}
const reconcile = (p: Person) => within(r.reconcile(p), "reconcile");
/** A pull that may wait on a held start: started, not awaited here. */
const pullLater = (p: Person): Promise<void> => {
  const x = r.pull(p);
  x.catch(() => undefined);
  return x;
};

/** The settle rule: one more reconcile, a flush and 200 ms, so a late call has had time to happen. */
async function settle(p: Person): Promise<void> {
  await reconcile(p);
  await r.w.flush();
  await sleep(200);
}

const startedLine = (run: Json, id: string) => new RegExp(`run ${esc(run.runId)}: started ${esc(id)} \\(pid \\d+\\)`);
const runningNow = async (p: Person) => (await r.runs(p)).filter((x) => x.state === "running" && x.endedAt === undefined);
const fleetSessions = async (p: Person): Promise<Json[]> => ((await r.w.api(p, "GET", "/v1/fleet")).json.machines as Json[]).flatMap((m) => (m.sessions ?? []) as Json[]);
const transcriptsOf = async (id: string) => (await r.artifactsOf(goalOf(id))).filter((a) => a.kind === "transcript" && a.step === id);

/** No live `print` session with the run's pid (RL-8 AC-06 (a)). */
async function noLivePrint(p: Person, run: Json): Promise<void> {
  const sessions = (await r.local(p, "GET", "/local/sessions")).json.sessions as Json[];
  const live = sessions.filter((s) => s.kind === "print" && s.pid === run.pid && s.state !== "ended");
  expect(live, JSON.stringify(live)).toStrictEqual([]);
}

/** The AC-01 flow: one headless step whose `worktree add` is held while the test runs `during`. */
async function raceFlow(during: (k: Cast, id: string) => Promise<void>) {
  const k = await cast();
  const id = await headlessStep(k, { id: "race" });
  await r.autoOffer(k.ann, id, k.self);
  const pulling = pullLater(k.ann);
  expect(await until(() => k.h.adds().length >= 1, 5_000), "the first worktree add is held").toBe(true);
  try {
    await during(k, id);
    // In-window control: the window was real (nothing started yet).
    expect((await r.runOf(k.ann, id)).state).toBe("queued");
    expect(r.calls(id)).toStrictEqual([]);
    expect(logCount(k.ann, /started/)).toBe(0);
  } finally {
    k.h.release();
  }
  await within(pulling, "pull");
  const call = await r.started(id);
  const run = await r.runOf(k.ann, id);
  const cwdAtStart = real(call.cwd);
  const worktreeAtStart = real(r.worktreeOf(k.ann, run));
  // Positive control (sibling of AC-04): a started run has its session and its bind claim.
  const own = await r.sessionsOf(k.ann, run.sessionId);
  expect(own, JSON.stringify(own)).toHaveLength(1);
  expect(own[0].kind).toBe("print");
  await r.w.flush();
  expect(k.ann.requests.some((q) => q.key === `bind:${own[0].sid}:${id}`), "bind claim of the started run").toBe(true);
  const d = await r.w.tool(k.ann, call.pid, "mesh_done", { outcome: "done", summary: "ok" });
  expect(d.isError, d.text).toBeFalsy();
  r.go(`go-${id}`);
  await r.endRun(k.ann, id);
  await settle(k.ann);
  return { k, id, call, run, cwdAtStart, worktreeAtStart };
}

async function expectOneCleanStart(k: Cast, id: string, x: { call: Json; run: Json; cwdAtStart: string; worktreeAtStart: string }) {
  const run = await r.runOf(k.ann, id);
  expect(k.h.addsFor(r.worktreeOf(k.ann, run)), JSON.stringify(k.h.adds())).toHaveLength(1);
  expect(k.h.adds()).toHaveLength(1);
  expect(k.h.starts).toHaveLength(1);
  expect(r.calls(id)).toHaveLength(1);
  expect(x.call.cwdOk).toBe(true);
  expect(x.cwdAtStart).toBe(x.worktreeAtStart);
  expect(logCount(k.ann, startedLine(run, id)), k.ann.logs.join("\n")).toBe(1);
  expect(logCount(k.ann, /did not start/), k.ann.logs.join("\n")).toBe(0);
  expect((await r.stepOf(id)).state).toBe("done");
  expect(run).toMatchObject({ state: "finished", exit: "success" });
  expect(await transcriptsOf(id)).toStrictEqual([]);
}

// ---------------------------------------------------------------------------------------------

describe("RL-8 AC-01 start race", { timeout: 60_000 }, () => {
  it("test_AC01_one_start_while_reconcile_runs", async () => {
    const x = await raceFlow(async (k) => {
      await reconcile(k.ann);
      await reconcile(k.ann);
    });
    await expectOneCleanStart(x.k, x.id, x);
    await noLivePrint(x.k.ann, x.run);
  });

  it("test_AC01_pull_again_while_held", async () => {
    const x = await raceFlow(async (k) => {
      await within(r.pull(k.ann), "second pull");
      await reconcile(k.ann);
    });
    await expectOneCleanStart(x.k, x.id, x);
  });

  it("test_AC01_finished_never_running_again", async () => {
    const x = await raceFlow(async (k) => {
      await reconcile(k.ann);
    });
    const before = await r.runOf(x.k.ann, x.id);
    // Control: the run is finished before the extra passes.
    expect(before.state).toBe("finished");
    await reconcile(x.k.ann);
    await reconcile(x.k.ann);
    await within(r.pull(x.k.ann), "pull");
    await settle(x.k.ann);
    const after = await r.runOf(x.k.ann, x.id);
    expect(after.state).toBe("finished");
    expect(after.endedAt).toBe(before.endedAt);
    expect(logCount(x.k.ann, startedLine(after, x.id))).toBe(1);
    expect(r.calls(x.id)).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------------------------

describe("RL-8 AC-02 capacity", { timeout: 60_000 }, () => {
  /** Two goals of ann, each one headless step that waits for `go-<step>`. */
  async function twoSteps(k: Cast): Promise<[string, string]> {
    const script = (id: string) => [{ waitFor: `go-${id}` }, { stdout: [RESULT_LINE] }, { exit: 0 }];
    const c1 = await headlessStep(k, { id: "c1" }, script);
    const c2 = await headlessStep(k, { id: "c2" }, script);
    return [c1, c2];
  }
  /** The held run (its worktree is named by the one add) and the other one. */
  async function heldAndOther(k: Cast, ids: [string, string]): Promise<{ A: string; B: string }> {
    const add = k.h.adds()[0] as { args: string[] };
    let A: string | undefined;
    for (const id of ids) {
      const run = (await r.runs(k.ann)).find((x) => x.step === id);
      if (run && add.args.includes(r.worktreeOf(k.ann, run))) A = id;
    }
    expect(A, JSON.stringify(add.args)).toBeDefined();
    return { A: A as string, B: ids.find((x) => x !== A) as string };
  }
  const invariant = async (k: Cast) => {
    const rs = await runningNow(k.ann);
    expect(rs.length, JSON.stringify(rs)).toBeLessThanOrEqual(1);
  };

  it("test_AC02_two_offers_one_slot", async () => {
    const k = await cast({ maxSessions: 1 });
    const ids = await twoSteps(k);
    await r.autoOffer(k.ann, ids[0], k.self);
    await r.autoOffer(k.ann, ids[1], k.self);
    const pulling = pullLater(k.ann);
    expect(await until(() => k.h.adds().length >= 1, 5_000), "the first worktree add is held").toBe(true);
    let pair: { A: string; B: string } | undefined;
    try {
      await sleep(200);
      expect(k.h.adds()).toHaveLength(1);
      expect(await until(async () => (await r.runs(k.ann)).filter((x) => ids.includes(x.step)).length === 2, 3_000), "both runs exist").toBe(true);
      pair = await heldAndOther(k, ids);
      const { B } = pair;
      expect((await r.runOf(k.ann, B)).state).toBe("queued");
      await invariant(k);
      await reconcile(k.ann);
      expect(k.h.adds()).toHaveLength(1);
      expect(k.h.starts).toHaveLength(0);
      expect((await r.runOf(k.ann, B)).state).toBe("queued");
      await invariant(k);
    } finally {
      k.h.release();
    }
    await within(pulling, "pull");
    const { A, B } = pair;
    await r.started(A);
    await reconcile(k.ann);
    await invariant(k);
    expect((await r.runOf(k.ann, B)).state).toBe("queued");
    expect(k.h.starts).toHaveLength(1);
    expect(r.calls(B)).toStrictEqual([]);
    r.go(`go-${A}`);
    await r.endRun(k.ann, A);
    const runA = await r.runOf(k.ann, A);
    const exitedAt = Date.now();
    expect(r.exitFile(k.ann, runA)).toBeDefined();
    expect(
      await until(async () => {
        await reconcile(k.ann);
        await invariant(k);
        return r.calls(B).length === 1;
      }, 10_000),
      "the second run starts on a later reconcile",
    ).toBe(true);
    expect(k.h.starts).toHaveLength(2);
    expect(k.h.adds()).toHaveLength(2);
    // B's start began after A's exit file existed.
    const addB = k.h.addsFor(r.worktreeOf(k.ann, await r.runOf(k.ann, B)));
    expect(addB).toHaveLength(1);
    expect((addB[0] as { at: number }).at).toBeGreaterThanOrEqual(exitedAt - 5_000);
    expect((await r.runOf(k.ann, A)).state).toBe("finished");
    r.go(`go-${B}`);
  });

  it("test_AC02_control_two_slots", async () => {
    const k = await cast({ maxSessions: 2 });
    const ids = await twoSteps(k);
    await r.autoOffer(k.ann, ids[0], k.self);
    await r.autoOffer(k.ann, ids[1], k.self);
    const pulling = pullLater(k.ann);
    try {
      expect(await until(() => k.h.adds().length >= 1, 5_000), "the first worktree add is held").toBe(true);
      // Room for both: the second start begins while the first is held (its add passes through).
      expect(
        await until(async () => {
          if (k.h.adds().length < 2) await reconcile(k.ann);
          return k.h.adds().length === 2;
        }, 5_000),
        JSON.stringify(k.h.adds()),
      ).toBe(true);
    } finally {
      k.h.release();
    }
    await within(pulling, "pull");
    await r.started(ids[0]);
    await r.started(ids[1]);
    expect(await until(async () => (await runningNow(k.ann)).length === 2, 3_000)).toBe(true);
    for (const id of ids) r.go(`go-${id}`);
  });

  it("test_AC02_offer_in_later_pull_while_held", async () => {
    const k = await cast({ maxSessions: 1 });
    const ids = await twoSteps(k);
    await r.autoOffer(k.ann, ids[0], k.self);
    const first = pullLater(k.ann);
    expect(await until(() => k.h.adds().length >= 1, 5_000), "the first worktree add is held").toBe(true);
    const second = pullLater(k.ann);
    try {
      await r.autoOffer(k.ann, ids[1], k.self);
      await within(r.pull(k.ann), "pull");
      await reconcile(k.ann);
      await sleep(200);
      expect(k.h.adds()).toHaveLength(1);
      expect(k.h.starts).toHaveLength(0);
      const b = (await r.runs(k.ann)).find((x) => x.step === ids[1]);
      // The second run is not started: absent or queued.
      if (b) expect(b.state).toBe("queued");
      await invariant(k);
    } finally {
      k.h.release();
    }
    await within(first, "first pull");
    await within(second, "second pull");
    await r.started(ids[0]);
    await reconcile(k.ann);
    await r.pull(k.ann);
    await invariant(k);
    expect((await r.runOf(k.ann, ids[1])).state).toBe("queued");
    expect(r.calls(ids[1])).toStrictEqual([]);
    r.go(`go-${ids[0]}`);
    await r.endRun(k.ann, ids[0]);
    expect(
      await until(async () => {
        await reconcile(k.ann);
        await invariant(k);
        return r.calls(ids[1]).length === 1;
      }, 10_000),
      "the second run starts after the first ended",
    ).toBe(true);
    expect(k.h.adds()).toHaveLength(2);
    r.go(`go-${ids[1]}`);
  });
});

// ---------------------------------------------------------------------------------------------

/** A headless step whose `worktree add` is answered with `stderr` (code 128); returns the step. */
async function addFails(stderr: string): Promise<{ k: Cast; id: string }> {
  const k = await cast({ hold: { hold: false, answerAdd: [{ code: 128, stdout: "", stderr }] } });
  const id = await headlessStep(k, { id: "wt" }, () => []);
  await r.autoOffer(k.ann, id, k.self);
  await within(r.pull(k.ann), "pull");
  await reconcile(k.ann);
  expect(await until(async () => (await r.stepOf(id)).state === "failed", 5_000), "step failed").toBe(true);
  return { k, id };
}

describe("RL-8 AC-03 git error text", { timeout: 60_000 }, () => {
  it("test_AC03_last_nonblank_line", async () => {
    const { k, id } = await addFails(PREPARING);
    expect(k.h.adds()).toHaveLength(1);
    const st = await r.stepOf(id);
    expect(st.rounds.at(-1)).toMatchObject({ outcome: "fail", summary: `headless run of ${id} did not start: could not make a worktree: fatal: 'x' already exists` });
    expect(r.calls(id)).toStrictEqual([]);
  });

  it("test_AC03_blank_stderr_exit_code", async () => {
    const { id } = await addFails("\n  \n");
    expect((await r.stepOf(id)).rounds.at(-1)).toMatchObject({ outcome: "fail", summary: `headless run of ${id} did not start: could not make a worktree: git exited with code 128` });
  });

  it("test_AC03_crlf_and_trailing_blank", async () => {
    const { id } = await addFails("Preparing worktree\r\nfatal: y\r\n\r\n  \r\n");
    expect((await r.stepOf(id)).rounds.at(-1)).toMatchObject({ outcome: "fail", summary: `headless run of ${id} did not start: could not make a worktree: fatal: y` });
  });

  it("test_AC03_push_failure_note", async () => {
    const k = await cast({ hold: { hold: false, answerPush: { code: 1, stdout: "", stderr: "remote: x\nerror: failed to push some refs\n" } } });
    const id = await headlessStep(k, { id: "fix-it", profile: "propose-via-branch" }, () => [{ commit: true }, { exit: 0 }]);
    await r.autoOffer(k.ann, id, k.self);
    await within(r.pull(k.ann), "pull");
    await r.started(id);
    await r.endRun(k.ann, id);
    await settle(k.ann);
    // Positive control: the push was tried (and answered by the runner).
    expect(k.h.pushes()).toHaveLength(1);
    const notes = (((await r.w.call(k.ann.login.token, "GET", `/v1/steps/${id}`)).json.context?.notes ?? []) as Json[]).map((n) => String(n.text));
    const re = /^headless run: could not push (mesh\/\S+): error: failed to push some refs$/;
    const hit = notes.map((n) => re.exec(n)).find((m) => m !== null);
    expect(hit, JSON.stringify(notes)).toBeDefined();
    expect(hit?.[1]).toBe(`mesh/${slug(id)}`);
    expect((k.h.pushes()[0] as { args: string[] }).args.join(" ")).toContain(hit?.[1] as string);
  });

  it("test_AC03_remove_failure_log", async () => {
    const k = await cast({ hold: { hold: false, answerRemove: { code: 128, stdout: "", stderr: "warning: x\nfatal: busy\n" } } });
    const id = await headlessStep(k, { id: "rm" }, () => [{ exit: 0 }]);
    await r.autoOffer(k.ann, id, k.self);
    await within(r.pull(k.ann), "pull");
    await r.started(id);
    await r.endRun(k.ann, id);
    await settle(k.ann);
    const run = await r.runOf(k.ann, id);
    // Control: the worktree remove was called (and answered with the failure).
    expect(k.h.removes().length).toBeGreaterThanOrEqual(1);
    expect(k.ann.logs, k.ann.logs.join("\n")).toContain(`run ${run.runId}: could not remove its worktree: fatal: busy`);
  });
});

// ---------------------------------------------------------------------------------------------

/** AC-04: everything a never-started run must (not) leave, asserted after the settle rule. */
async function neverStarted(k: Cast, id: string, summary: string): Promise<void> {
  expect(await until(async () => (await r.runOf(k.ann, id)).state === "finished", 5_000), "run finished").toBe(true);
  await settle(k.ann);
  // 1. the step and its closing round
  const st = await r.stepOf(id);
  expect(st.state).toBe("failed");
  const last = st.rounds.at(-1);
  expect(last).toMatchObject({ outcome: "fail", summary });
  expect(last.telemetry?.exit).toBe("crashed");
  expect(last.artifactIds === undefined || (Array.isArray(last.artifactIds) && last.artifactIds.length === 0), JSON.stringify(last.artifactIds)).toBe(true);
  // 2. no transcript (control: the listing answers 200 with an array)
  const arts = await r.artifactsOf(goalOf(id));
  expect(Array.isArray(arts)).toBe(true);
  expect(arts.filter((a) => a.kind === "transcript" && a.step === id)).toStrictEqual([]);
  // 3. requests: no artifacts call, no `started` report; the finished report and the done were sent
  const posts = k.ann.requests.filter((q) => q.method === "POST");
  expect(posts.filter((q) => q.path === `/v1/steps/${id}/artifacts`)).toStrictEqual([]);
  expect(posts.filter((q) => q.path === `/v1/steps/${id}/run` && (q.key ?? "").endsWith("-started"))).toStrictEqual([]);
  expect(posts.filter((q) => q.path === `/v1/steps/${id}/run`).length).toBeGreaterThanOrEqual(1);
  expect(posts.filter((q) => q.path === `/v1/steps/${id}/done`).length).toBeGreaterThanOrEqual(1);
  // 4. the run file
  const run = await r.runOf(k.ann, id);
  expect(run.state).toBe("finished");
  expect(run.startedAt).toBeUndefined();
  expect(run.pid).toBeUndefined();
  // 5. no session, no bind claim
  expect(await r.sessionsOf(k.ann, run.sessionId)).toStrictEqual([]);
  expect(noBindClaim(k.ann, id), JSON.stringify(k.ann.requests.filter((q) => (q.key ?? "").startsWith("bind:")))).toBe(true);
  // 6. the fake never ran; no worktree is left
  expect(r.calls(id)).toStrictEqual([]);
  expect(existsSync(r.worktreeOf(k.ann, run))).toBe(false);
}

describe("RL-8 AC-04 never-started run", { timeout: 60_000 }, () => {
  it("test_AC04_worktree_failure", async () => {
    const { k, id } = await addFails(PREPARING);
    await neverStarted(k, id, `headless run of ${id} did not start: could not make a worktree: fatal: 'x' already exists`);
  });

  it("test_AC04_invalid_repo_agent", async () => {
    const k = await cast({ hold: { hold: false } });
    const id = await headlessStep(k, { id: "ff", agent: "bad" }, () => []);
    await r.autoOffer(k.ann, id, k.self);
    await within(r.pull(k.ann), "pull");
    await reconcile(k.ann);
    const inv = (parseAgentFile(BAD) as Json).invalid as string;
    expect(typeof inv).toBe("string");
    await neverStarted(k, id, `headless run of ${id} did not start: agent bad has invalid front matter: ${inv}`);
  });

  it("test_AC04_missing_repo_agent", async () => {
    const k = await cast({ hold: { hold: false } });
    const id = await headlessStep(k, { id: "ghost", agent: "ghost" }, () => []);
    await r.autoOffer(k.ann, id, k.self);
    await within(r.pull(k.ann), "pull");
    await reconcile(k.ann);
    await neverStarted(k, id, `headless run of ${id} did not start: no agent ghost in svc/.claude/agents`);
  });
});

// ---------------------------------------------------------------------------------------------

/** AC-05 flow: a run that starts and exits 0 with no output and no mesh_done. */
async function silentRun(): Promise<{ k: Cast; id: string; run: Json; liveBefore: Json[] }> {
  const k = await cast({ hold: { hold: false } });
  const id = await headlessStep(k, { id: "quiet" }, (x) => [{ waitFor: `go-${x}` }, { exit: 0 }]);
  await r.autoOffer(k.ann, id, k.self);
  await within(r.pull(k.ann), "pull");
  await r.started(id);
  const running = await r.runOf(k.ann, id);
  const liveBefore = (await r.sessionsOf(k.ann, running.sessionId)).filter((s) => s.state !== "ended" && s.pid === running.pid);
  r.go(`go-${id}`);
  await r.endRun(k.ann, id);
  await settle(k.ann);
  return { k, id, run: await r.runOf(k.ann, id), liveBefore };
}

describe("RL-8 AC-05 started transcript", { timeout: 60_000 }, () => {
  it("test_AC05_started_keeps_transcript", async () => {
    const { k, id, run } = await silentRun();
    const ts = await transcriptsOf(id);
    expect(ts).toHaveLength(1);
    expect(ts[0]).toMatchObject({ kind: "transcript", title: "run transcript (no_result)" });
    const st = await r.stepOf(id);
    expect(st.state).toBe("failed");
    expect(st.rounds.at(-1).outcome).toBe("fail");
    expect(st.rounds.at(-1).summary).toContain("headless run ended without mesh_done (exit no_result)");
    expect(logCount(k.ann, startedLine(run, id))).toBe(1);
    expect(run.state).toBe("finished");
    expect(typeof run.startedAt).toBe("number");
    expect(typeof run.pid).toBe("number");
    await noLivePrint(k.ann, run);
  });
});

// ---------------------------------------------------------------------------------------------

/** Every run file (JSON under the run folder, the worktree left out) of this run. */
function runFilesOf(p: Person, run: Json): string[] {
  const f = join(r.runDir(p, run), "run.json");
  return existsSync(f) ? [f] : [];
}
function rewriteRunFile(p: Person, run: Json, change: Record<string, unknown>): void {
  const files = runFilesOf(p, run);
  expect(files.length, "the run file").toBeGreaterThan(0);
  for (const f of files) writeFileSync(f, JSON.stringify({ ...(JSON.parse(readFileSync(f, "utf8")) as Json), ...change }));
}

describe("RL-8 AC-06 leftover sessions", { timeout: 60_000 }, () => {
  it("test_AC06_no_live_print_after_finish", async () => {
    const { k, run, liveBefore } = await silentRun();
    // Control: before the end the run's session was live with the run's pid.
    expect(liveBefore, "the run's live session before the end").toHaveLength(1);
    expect(liveBefore[0].kind).toBe("print");
    await noLivePrint(k.ann, run);
  });

  /** A running run whose daemon is stopped; while stopped the run exits and its file is set finished (as v0.1.21 left it). */
  async function phantom(o: { resumed?: boolean } = {}) {
    const k = await cast({ hold: { hold: false } });
    const id = await headlessStep(k, { id: "ph" }, (x) => [{ waitFor: `go-${x}` }, { exit: 0 }]);
    await r.autoOffer(k.ann, id, k.self);
    await within(r.pull(k.ann), "pull");
    await r.started(id);
    const run = await r.runOf(k.ann, id);
    const P = run.pid as number;
    const S = run.sessionId as string;
    // Positive control: the run's session is live, print, with the run's pid and step.
    const [ph] = await r.sessionsOf(k.ann, S);
    expect(ph, "the run's session").toBeDefined();
    expect(ph).toMatchObject({ kind: "print", pid: P, step: id });
    expect(ph.state).not.toBe("ended");
    expect(ph.seenByReconciler).toBeFalsy();
    await r.w.flush();
    expect((await fleetSessions(k.ann)).find((s) => s.sid === ph.sid)?.state, "fleet shows it working").toBe("working");
    let Q = 0;
    let resumedSid = "";
    await r.w.restart(k.ann, {}, {}, async () => {
      r.go(`go-${id}`);
      expect(await until(() => r.exitFile(k.ann, run) !== undefined, 10_000), "exit file").toBe(true);
      rewriteRunFile(k.ann, run, { state: "finished", endedAt: r.w.clock, exit: "success", exitCode: 0 });
      // The phantom stays in the store: live, print, pid P, the run's session id.
      const stored = k.ann.store.loadSessions().find((s) => s.sid === ph.sid);
      expect(stored?.state, "the phantom in the store").not.toBe("ended");
      if (o.resumed) {
        // (c) A person resumed the run's Claude session: a new process, kind interactive.
        Q = r.liveSleep();
        resumedSid = `resumed-${Q}`;
        const s: Session = {
          sid: resumedSid,
          claudeSessionIds: [S],
          pid: Q,
          cwd: k.ann.repoDir,
          kind: "interactive",
          state: "idle",
          quiet: false,
          startedAt: r.w.clock,
          lastEventAt: r.w.clock,
          turns: 1,
          humanPrompts: 1,
          seenByReconciler: true,
        };
        k.ann.store.saveSessions([s], r.w.clock);
      }
    });
    k.ann.agents = o.resumed ? [{ kind: "interactive", pid: Q, sessionId: S, cwd: k.ann.repoDir, status: "idle" }] : null;
    return { k, id, run, P, S, ph, Q, resumedSid };
  }

  it("test_AC06_sweep_at_startup", async () => {
    const { k, ph } = await phantom();
    // Right after start-up (no reconcile called by the test).
    expect(
      await until(() => (k.ann.daemon.sessions as Json[]).find((s) => s.sid === ph.sid)?.state === "ended", 2_000),
      JSON.stringify((k.ann.daemon.sessions as Json[]).find((s) => s.sid === ph.sid)),
    ).toBe(true);
  });

  it("test_AC06_sweep_phantom", async () => {
    const { k, ph, S, Q, resumedSid } = await phantom({ resumed: true });
    await reconcile(k.ann);
    const after = (k.ann.daemon.sessions as Json[]).find((s) => s.sid === ph.sid);
    // Control: the phantom record is still tracked (loaded from the store).
    expect(after, "the phantom record").toBeDefined();
    expect(after.state).toBe("ended");
    await r.w.flush();
    expect((await fleetSessions(k.ann)).find((s) => s.sid === ph.sid)?.state).not.toBe("working");
    // (c) The resumed session (other pid, kind interactive) stays live.
    const resumed = (await r.sessionsOf(k.ann, S)).filter((s) => s.pid === Q);
    expect(resumed, JSON.stringify(await r.sessionsOf(k.ann, S))).toHaveLength(1);
    expect(resumed[0].sid).toBe(resumedSid);
    expect(resumed[0].state).not.toBe("ended");
    expect(resumed[0].kind).toBe("interactive");
  });

  it("test_AC06_pid_reuse_running_run_untouched", async () => {
    const k = await cast({ hold: { hold: false } });
    const G = await r.goal(k.self, [
      { id: "live", mode: "headless" },
      { id: "old", mode: "headless", deps: ["live"] },
    ]);
    const id = `${G}.live`;
    r.script(id, [{ waitFor: `go-${id}` }, { exit: 0 }]);
    await r.autoOffer(k.ann, id, k.self);
    await within(r.pull(k.ann), "pull");
    await r.started(id);
    const run = await r.runOf(k.ann, id);
    const P = run.pid as number;
    const S1 = run.sessionId as string;
    const S0 = randomUUID();
    const oldId = `${run.runId}-old`;
    k.ann.agents = [{ kind: "interactive", pid: P, sessionId: S1, cwd: r.worktreeOf(k.ann, run), status: "busy" }];
    await reconcile(k.ann);
    try {
      await r.w.restart(k.ann, {}, {}, async () => {
        const [f] = runFilesOf(k.ann, run);
        expect(f, "the running run's file").toBeDefined();
        const j = JSON.parse(readFileSync(f as string, "utf8")) as Json;
        const dir = join(k.ann.runsDir as string, oldId);
        mkdirSync(dir, { recursive: true });
        const { worktree: _w, ...rest } = j;
        writeFileSync(join(dir, "run.json"), JSON.stringify({ ...rest, runId: oldId, dir, step: `${G}.old`, sessionId: S0, state: "finished", endedAt: r.w.clock - 60_000, exit: "success", exitCode: 0, pid: P }));
      });
      const check = async (when: string) => {
        const runs = await r.runs(k.ann);
        // Positive control: the old file was loaded (a sweep candidate with pid P).
        expect(runs.find((x) => x.runId === oldId), `${when}: the old run file`).toMatchObject({ state: "finished", pid: P });
        expect((await r.runOf(k.ann, id)).state, when).toBe("running");
        const live = (await r.sessionsOf(k.ann, S1)).filter((s) => s.pid === P);
        expect(live, `${when}: ${JSON.stringify(live)}`).toHaveLength(1);
        expect(live[0].state, when).not.toBe("ended");
        expect(live[0].step, when).toBe(id);
        return live[0].sid as string;
      };
      await sleep(200);
      await check("after start-up");
      await reconcile(k.ann);
      const sid = await check("after one reconcile");
      await r.w.flush();
      const listed = (await fleetSessions(k.ann)).find((s) => s.sid === sid);
      expect(listed?.state, JSON.stringify(listed)).toBe("working");
    } finally {
      r.go(`go-${id}`);
    }
  });
});

// ---------------------------------------------------------------------------------------------

describe("RL-8 AC-07 print kind world", { timeout: 60_000 }, () => {
  it("test_AC07_run_session_stays_print", async () => {
    const k = await cast({ hold: { hold: false } });
    const id = await headlessStep(k, { id: "kd" }, (x) => [{ waitFor: `go-${x}` }, { exit: 0 }]);
    await r.autoOffer(k.ann, id, k.self);
    await within(r.pull(k.ann), "pull");
    const call = await r.started(id);
    const run = await r.runOf(k.ann, id);
    k.ann.agents = [{ kind: "interactive", pid: call.pid, sessionId: run.sessionId, cwd: r.worktreeOf(k.ann, run), status: "busy" }];
    await reconcile(k.ann);
    const [s] = await r.sessionsOf(k.ann, run.sessionId);
    expect(s, "the run's session").toBeDefined();
    // Positive control: the entry was applied.
    expect(s.seenByReconciler).toBe(true);
    expect(s.kind).toBe("print");
    await r.w.flush();
    const listed = (await fleetSessions(k.ann)).find((x) => x.sid === s.sid);
    if (listed && listed.kind !== undefined) expect(listed.kind).toBe("print");
    k.ann.agents = [];
    r.go(`go-${id}`);
    await r.endRun(k.ann, id);
    await settle(k.ann);
    const ended = (await r.sessionsOf(k.ann, run.sessionId)).find((x) => x.sid === s.sid);
    expect(ended, "the run's session after the end").toBeDefined();
    expect(ended.kind).toBe("print");
    expect(ended.state).toBe("ended");
  });
});
