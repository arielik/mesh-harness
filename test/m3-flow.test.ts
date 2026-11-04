// M3 end to end, in process: design session → mesh_plan (files written) → revise → re-propose →
// approve (approved plan file written, design step released) → two people in two repos →
// step records written with facts → goal done; replan; terminal DAG.

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { renderGoal } from "../src/cli/show.ts";
import { World, type Person } from "./helpers/world.ts";

let w: World;
let alice: Person;
let bob: Person;

beforeEach(async () => {
  w = new World();
  await w.start(["alice", "bob"]);
  alice = await w.person("alice", "frr-dplane-ovs");
  bob = await w.person("bob", "vpc-node-agent");
});
afterEach(() => w.stop());

const planV1 = [
  { id: "dplane", repo: "frr-dplane-ovs", kind: "implement", title: "dplane", brief: "program v6 next hops" },
  { id: "agent", repo: "vpc-node-agent", kind: "implement", title: "agent", brief: "send v6 config" },
];
const planV2 = [
  ...planV1,
  { id: "dplane-t", repo: "frr-dplane-ovs", kind: "test", title: "dplane tests", brief: "test v6 programming", deps: ["dplane"] },
];

describe("M3: design → approval → DAG → records", () => {
  it("runs the whole SDD loop with two people", async () => {
    const g = await w.api(alice, "POST", "/v1/goals", { title: "IPv6 underlay", primaryRepo: "frr-dplane-ovs", repos: ["vpc-node-agent"] });
    const G = g.json.id as string;

    // The design session.
    w.hook(alice, "SessionStart", 100, { source: "startup" });
    const claim = await w.tool(alice, 100, "mesh_claim", { step: `${G}.design` });
    expect(claim.text).toContain("Design \"IPv6 underlay\"");
    expect(claim.text).toContain("mesh_plan");
    w.turn(alice, 100, "Reading the code.");

    const p1 = await w.tool(alice, 100, "mesh_plan", { goal: G, design_ref: "frr-dplane-ovs@main:docs/design/g1.md", steps: planV1 });
    expect(p1.text).toContain(`mesh wrote .mesh/goals/${G}/goal.yaml and .mesh/goals/${G}/plan.v1.yaml`);
    expect(readFileSync(join(alice.repoDir, `.mesh/goals/${G}/plan.v1.yaml`), "utf8")).toContain("decision: pending");
    expect(readFileSync(join(alice.repoDir, `.mesh/goals/${G}/goal.yaml`), "utf8")).toContain("vpc-node-agent");
    await w.flush();

    // Bob (approver? no: the owner) asks for changes; the design session gets the comment.
    const rev = await w.api(alice, "POST", `/v1/goals/${G}/revise`, { comment: "split out dplane tests" });
    expect(rev.json.goal.state).toBe("design");
    await alice.daemon.link?.pullInbox();
    const revised = w.hook(alice, "Stop", 100, { stop_hook_active: false, last_assistant_message: "Plan proposed." });
    expect(JSON.stringify(revised)).toContain("split out dplane tests");

    const p2 = await w.tool(alice, 100, "mesh_plan", { goal: G, design_ref: "frr-dplane-ovs@main:docs/design/g1.md", steps: planV2 });
    expect(p2.text).toContain("Plan v2");
    const shown = renderGoal((await w.api(alice, "GET", `/v1/goals/${G}`)).json);
    expect(shown).toContain("plan v2 pending");
    expect(shown).toContain(`approve: mesh goal approve ${G}`);

    // Approval: the approved plan file is written into the design session's repo, design step released.
    const ok = await w.api(alice, "POST", `/v1/goals/${G}/approve`, { comment: "go" });
    expect(ok.json.goal.state).toBe("in_progress");
    await alice.daemon.link?.pullInbox();
    for (let i = 0; i < 40 && !readFileSync(join(alice.repoDir, `.mesh/goals/${G}/plan.v2.yaml`), "utf8").includes("approved"); i++) await new Promise((r) => setTimeout(r, 25));
    const approvedFile = readFileSync(join(alice.repoDir, `.mesh/goals/${G}/plan.v2.yaml`), "utf8");
    expect(approvedFile).toContain("decision: approved");
    expect(approvedFile).toContain("comment: go");
    expect(w.session(alice, 100).step).toBeUndefined();

    // Two people, two repos, in parallel.
    w.hook(bob, "SessionStart", 200);
    expect((await w.tool(bob, 200, "mesh_next")).text).toContain(`${G}.agent`);
    await w.tool(bob, 200, "mesh_claim", { step: `${G}.agent` });
    await w.tool(alice, 100, "mesh_claim", { step: `${G}.dplane` });
    await w.flush();
    w.turn(alice, 100, "Programming next hops.");
    w.turn(alice, 100, "Done, tests pass.");
    w.turn(bob, 200, "Sending v6 config.");
    await w.flush();

    const doneA = await w.tool(alice, 100, "mesh_done", { summary: "Programmed v6 next hops in the OVS bridge.", mr: "!88", branch: "mesh/g1-dplane" });
    expect(doneA.text).toContain(`mesh wrote the step record .mesh/goals/${G}/steps/dplane.md`);
    const record = readFileSync(join(alice.repoDir, `.mesh/goals/${G}/steps/dplane.md`), "utf8");
    expect(record).toMatch(/^---\ngoal: G\d+\nstep: dplane\nkind: implement/);
    expect(record).toContain("turns: 2");
    expect(record).toContain("human_prompts: 2");
    expect(record).toContain('mr: "!88"');
    expect(record).toContain("Programmed v6 next hops");

    await w.tool(bob, 200, "mesh_done", { summary: "Agent sends v6 config." });
    expect(existsSync(join(bob.repoDir, `.mesh/goals/${G}/steps/agent.md`))).toBe(true);

    await w.tool(alice, 100, "mesh_claim", { step: `${G}.dplane-t` });
    const last = await w.tool(alice, 100, "mesh_done", { summary: "v6 tests added." });
    expect(last.text).toContain(`Goal ${G} is done.`);

    const timeline = (await w.api(alice, "GET", `/v1/goals/${G}/timeline`)).json.timeline.map((t: { text: string }) => t.text);
    expect(timeline).toEqual(expect.arrayContaining([`proposed plan v1 for ${G}`, `asked for changes to ${G}`, `approved plan v2 for ${G}`, `finished ${G}.dplane`, `${G} is done`]));
    const view = (await w.api(alice, "GET", `/v1/steps/${G}.dplane`)).json;
    expect(view.facts).toMatchObject({ turns: 2, humanPrompts: 2, holders: [expect.objectContaining({ user: "alice" })] });
  });

  it("replans: the design opens again and the previous design session hears about it", async () => {
    const g = await w.api(alice, "POST", "/v1/goals", { title: "x", primaryRepo: "frr-dplane-ovs" });
    const G = g.json.id as string;
    w.hook(alice, "SessionStart", 100);
    await w.tool(alice, 100, "mesh_claim", { step: `${G}.design` });
    await w.tool(alice, 100, "mesh_plan", { goal: G, steps: planV1 });
    await w.api(alice, "POST", `/v1/goals/${G}/approve`, {});
    await w.flush();
    expect((await w.api(bob, "POST", `/v1/goals/${G}/replan`, {})).status).toBe(403);
    const r = await w.api(alice, "POST", `/v1/goals/${G}/replan`, { comment: "agent needs a migration" });
    expect(r.json.goal.state).toBe("design");
    expect(r.json.steps.find((s: { id: string }) => s.id === `${G}.design`).state).toBe("ready");
    await alice.daemon.link?.pullInbox();
    expect(alice.store.pendingMessages().map((m) => m.text).join()).toContain("agent needs a migration");
  });

  it("writes the trail with `mesh goal files`", async () => {
    const g = await w.api(alice, "POST", "/v1/goals", { title: "x" });
    const f = await w.api(alice, "GET", `/v1/goals/${g.json.id}/files`);
    expect(f.json.files.map((x: { path: string }) => x.path)).toEqual([`.mesh/goals/${g.json.id}/goal.yaml`]);
  });
});

describe("M3: mesh run --design (real tmux, fake claude)", () => {
  it("claims the design step and starts claude with the prompt first and --add-dir for the goal's other repos", async () => {
    const { execFileSync } = await import("node:child_process");
    const { chmodSync, mkdirSync, mkdtempSync, writeFileSync, rmSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { meshCommands } = await import("../src/cli/mesh-commands.ts");
    const { resolvePaths } = await import("../src/protocol/index.ts");
    try {
      execFileSync("tmux", ["-V"]);
    } catch {
      return;
    }
    const root = mkdtempSync(join(tmpdir(), "mesh-design-"));
    const socket = `meshdesign-${process.pid}`;
    const oldPath = process.env.PATH;
    try {
      for (const r of ["frr-dplane-ovs", "vpc-node-agent"]) mkdirSync(join(root, "ws", r, ".git"), { recursive: true });
      const bin = join(root, "bin");
      mkdirSync(bin);
      const record = join(root, "calls.txt");
      writeFileSync(join(bin, "claude"), `#!/bin/sh\nfor a in "$@"; do printf '%s\\n' "$a" >> '${record}'; done\nprintf -- '--env %s\\n' "$MESH_STEP" >> '${record}'\nexec sleep 30\n`);
      chmodSync(join(bin, "claude"), 0o755);
      process.env.PATH = `${bin}:${oldPath}`;
      const paths = resolvePaths({ MESH_CONFIG_DIR: join(root, "cfg"), MESH_STATE_DIR: join(root, "st"), CLAUDE_CONFIG_DIR: join(root, "cl") }, root);
      mkdirSync(paths.configDir, { recursive: true });
      writeFileSync(paths.credentials, JSON.stringify({ hub: w.hub.url, token: alice.login.token, user: alice.login.user }));
      const g = await w.api(alice, "POST", "/v1/goals", { title: "Design me", primaryRepo: "frr-dplane-ovs", repos: ["vpc-node-agent"] });
      const out: string[] = [];
      const c = { io: { out: (t: string) => out.push(t), err: (t: string) => out.push(t) }, paths, env: {}, cwd: join(root, "ws"), self: [join(bin, "claude")], version: "0" };
      const run = meshCommands(c).find((x) => x.name === "run") as { run(a: string[]): Promise<number> };
      expect(await run.run(["--design", g.json.id, "--no-tui", "--no-bind", "--socket-name", socket])).toBe(0);
      expect(out.join("\n")).toContain(`Claimed ${g.json.id}.design`);
      for (let i = 0; i < 50; i++) {
        try {
          if (readFileSync(record, "utf8").includes("--env")) break;
        } catch {
          // not yet
        }
        await new Promise((r) => setTimeout(r, 100));
      }
      const args = readFileSync(record, "utf8").trim().split("\n");
      expect(args[0]).toContain(`You hold the design step of mesh goal ${g.json.id}`);
      expect(args.slice(1, 3)).toEqual(["-n", `frr-dplane-ovs·${g.json.id}.design`]);
      expect(args.slice(3, 5)).toEqual(["--add-dir", join(root, "ws", "vpc-node-agent")]);
      expect(args.at(-1)).toBe(`--env ${g.json.id}.design`);
      const step = (await w.api(alice, "GET", `/v1/steps/${g.json.id}.design`)).json.context.step;
      expect(step).toMatchObject({ state: "claimed", holderUser: "alice" });
    } finally {
      process.env.PATH = oldPath;
      try {
        execFileSync("tmux", ["-L", socket, "kill-server"]);
      } catch {
        // gone
      }
      rmSync(root, { recursive: true, force: true });
    }
  });
});
