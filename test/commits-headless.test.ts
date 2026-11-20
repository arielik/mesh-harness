// RL-13 (docs/specs/RL-13.md): the commit of a headless run's round (AC-05) and the commit in run
// rows and run card stages (AC-07). The interactive side is in test/commits-hub.test.ts.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Ck, DAY, tel } from "./helpers/calib-kit.ts";
import { cardsOk, stage } from "./helpers/health-kit.ts";
import { body, MIN } from "./helpers/pulse-kit.ts";
import { git, holdingRunner, Relay } from "./helpers/relay-kit.ts";
import type { Json, Person } from "./helpers/world.ts";

let r: Relay | undefined;
afterEach(async () => {
  await r?.stop();
  r = undefined;
});

const slug = (id: string) => id.toLowerCase().replace(/[^a-z0-9]+/g, "-");

interface Cast {
  ann: Person;
  self: string;
}
async function cast(o: { failPush?: boolean } = {}): Promise<Cast> {
  r = await Relay.start(["ann"]);
  const runner = o.failPush ? { runner: holdingRunner({ hold: false, answerPush: { code: 1, stdout: "", stderr: "remote: denied" } }).runner } : {};
  const ann = await r.headlessPerson("ann", { nick: "hl", headless: runner });
  const self = await r.otherLogin("ann");
  await r.w.flush();
  return { ann, self };
}
function bareRemote(p: Person): string {
  const bare = join(p.dir, "remote.git");
  git(p.dir, ["init", "-q", "--bare", bare]);
  git(p.repoDir, ["remote", "add", "origin", bare]);
  git(p.repoDir, ["push", "-q", "origin", "HEAD:refs/heads/main"]);
  return bare;
}
async function run(k: Cast, step: Json, script: unknown[]): Promise<string> {
  const rr = r as Relay;
  const G = await rr.goal(k.self, [{ mode: "headless", ...step } as never]);
  const id = `${G}.${String(step.id)}`;
  rr.script(id, script);
  await rr.autoOffer(k.ann, id, k.self);
  await rr.pull(k.ann);
  await rr.started(id);
  return id;
}
const lastRound = async (id: string) => ((await (r as Relay).stepOf(id)).rounds as Json[]).at(-1) as Json;
const finished = async (id: string) => (await (r as Relay).events("run.finished", id)).at(-1)?.payload as Json | undefined;

describe("RL-13 AC-05 headless result commit", { timeout: 60_000 }, () => {
  it("test_AC05_no_commits_close_as_fail_gets_base", async () => {
    const k = await cast();
    const base = git(k.ann.repoDir, ["rev-parse", "HEAD"]);
    const id = await run(k, { id: "audit", profile: "read-only" }, [{ exit: 0 }]);
    await (r as Relay).endRun(k.ann, id);
    const round = await lastRound(id);
    expect(round.outcome).toBe("fail");
    expect(round.commit).toBe(base);
    expect((await finished(id))?.commit).toBe(base);
  });

  it("test_AC05_non_pushing_profile_that_committed_gets_base", async () => {
    const k = await cast();
    const base = git(k.ann.repoDir, ["rev-parse", "HEAD"]);
    const id = await run(k, { id: "ro", profile: "read-only" }, [{ commit: true }, { exit: 0 }]);
    await (r as Relay).endRun(k.ann, id);
    const head = (r as Relay).calls(id)[0]?.head as string;
    expect(head).toMatch(/^[0-9a-f]{40}$/);
    expect(head).not.toBe(base);
    expect((await lastRound(id)).commit).toBe(base);
  });

  it("test_AC05_pushed_commit", async () => {
    const k = await cast();
    const bare = bareRemote(k.ann);
    const id = await run(k, { id: "fix-it", profile: "propose-via-branch" }, [{ commit: true }, { exit: 0 }]);
    await (r as Relay).endRun(k.ann, id);
    const head = (r as Relay).calls(id)[0]?.head as string;
    expect(git(bare, ["rev-parse", `refs/heads/mesh/${slug(id)}`])).toBe(head);
    const round = await lastRound(id);
    expect(round.commit).toBe(head);
    expect(round.branch).toBe(`mesh/${slug(id)}`);
    expect((await finished(id))?.commit).toBe(head);
    // The end record keeps the value, so a retried report sends the same commit.
    const runFile = await (r as Relay).runOf(k.ann, id);
    const end = JSON.parse(readFileSync(join((r as Relay).runDir(k.ann, runFile), "end.json"), "utf8")) as Json;
    expect(end.pushedCommit).toBe(head);
  });

  it("test_AC05_push_failed_gets_base", async () => {
    const k = await cast({ failPush: true });
    const base = git(k.ann.repoDir, ["rev-parse", "HEAD"]);
    const id = await run(k, { id: "fix-it", profile: "propose-via-branch" }, [{ commit: true }, { exit: 0 }]);
    await (r as Relay).endRun(k.ann, id);
    const round = await lastRound(id);
    expect(round.branch).toBeUndefined();
    expect(round.commit).toBe(base);
  });

  it("test_AC05_run_mesh_done_sends_no_commit", async () => {
    const k = await cast();
    const rr = r as Relay;
    // The checkout names its repo, so a worktree session would pass the repo check: only the
    // run-session rule keeps the worktree's own commit out.
    git(k.ann.repoDir, ["remote", "add", "origin", "https://gitlab.lab/vpc/svc.git"]);
    const base = git(k.ann.repoDir, ["rev-parse", "HEAD"]);
    const id = await run(k, { id: "ro", profile: "read-only" }, [{ commit: true }, { waitFor: "done" }, { exit: 0 }]);
    await rr.runSession(k.ann, id, 7);
    const d = await rr.w.tool(k.ann, 7, "mesh_done", { outcome: "done", summary: "ok" });
    expect(d.isError, d.text).toBeFalsy();
    // Before the finished report: the round has no commit, nor has the step.done event.
    expect((await lastRound(id)).commit).toBeUndefined();
    expect((await rr.events("step.done", id))[0]?.payload.commit).toBeUndefined();
    rr.go("done");
    await rr.endRun(k.ann, id);
    const round = await lastRound(id);
    expect(round.outcome).toBe("done");
    expect(round.commit).toBe(base);
  });
});

describe("RL-13 AC-07 run rows and card stages", { timeout: 60_000 }, () => {
  let k: Ck | undefined;
  afterEach(async () => {
    await k?.stop();
    k = undefined;
  });
  const CHAIN = `description: Chain
steps:
  - id: a
    kind: implement
    repo: "{repo}"
    title: A
    brief: A.
  - id: b
    kind: implement
    repo: "{repo}"
    deps: [a]
    title: B
    brief: B.
`;

  it("test_AC07_rows_and_stages", async () => {
    const NOW = Date.UTC(2026, 10, 20, 12);
    k = await Ck.start({ clock: NOW - 2 * DAY });
    const pk = k.pulses();
    const ann = k.c.ann;
    const due = NOW - DAY;
    await pk.pulseOk("ann", body({ params: { repo: "alpha" }, when: { every: "1d", at: due } }, "chain", CHAIN));
    await pk.tickAt(due);
    const G = (await pk.slotsOf("p-1"))[0]?.goal as string;
    const c = "1".repeat(40);
    k.at(due + 5 * MIN);
    await stage(k, ann, `${G}.a`, { started: true, commit: c, telemetry: tel({ runId: "r-a", agentKey: "alpha/a", durationMs: 1_000 }) });
    k.at(due + 10 * MIN);
    await stage(k, ann, `${G}.b`, { started: true, telemetry: tel({ runId: "r-b", agentKey: "alpha/b", durationMs: 1_000 }) });

    const rows = (await k.r.call(ann, "GET", `/v1/runs?goal=${G}`)).json.runs as Json[];
    expect(rows.find((x) => x.step === `${G}.a`)?.commit).toBe(c);
    expect(rows.find((x) => x.step === `${G}.b`)).not.toHaveProperty("commit");

    const card = ((await cardsOk(k, "p-1")).cards as Json[])[0] as Json;
    const stages = card.stages as Json[];
    expect(stages.find((s) => s.step === `${G}.a`)?.commit).toBe(c);
    expect(stages.find((s) => s.step === `${G}.b`)).not.toHaveProperty("commit");
  });
});
