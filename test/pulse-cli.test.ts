// RL-3 CLI against a World hub: `mesh pulse add|ls|show|update|pause|resume|fire|rm`, the repo
// preset snapshot, `mesh goal ls --pulses`, `mesh preset ls`, `mesh help`, and a manual fire error.
// Criteria AC-07 (CLI), AC-16 (CLI), AC-19 (CLI), AC-20, AC-29 (CLI). Written from the spec's
// contracts only (docs/specs/RL-3.md). Pulses and slots by id; what the CLI sent is read back at the hub.

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { parsePreset, presetText } from "../src/core/index.ts";
import { git, Relay } from "./helpers/relay-kit.ts";
import { body, DAY, HOUR, iso, MIN, Pk, RELAY_TEXT, sha, sha12, T0, type Bare, type Json } from "./helpers/pulse-kit.ts";
import type { Person } from "./helpers/world.ts";

let k: Pk;
const dirs: string[] = [];
afterEach(async () => {
  await k?.stop();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
const NOW = T0 - DAY;

interface Cast {
  ann: Person;
  bob: Person;
}
/** ann (checkout `alpha`) and bob with daemons for the CLI; logins for every user (Pk); clock NOW. */
async function cast(): Promise<Cast> {
  const r = await Relay.start(["ann", "bob", "carol", "dave", "root"], { admins: ["carol", "root"] });
  r.w.clock = NOW;
  k = new Pk(r);
  for (const u of ["ann", "bob", "carol"]) k.tok[u] = (await r.w.login(u, { hostname: `${u}-login` })).token;
  const ann = await r.w.person("ann", "alpha");
  const bob = await r.w.person("bob", "alpha");
  await r.w.flush();
  return { ann, bob };
}
/** A directory that is no git repo (no repo preset can be found from it). */
function plainDir(): string {
  const d = mkdtempSync(join(tmpdir(), "mesh-pulse-cli-"));
  dirs.push(d);
  return d;
}
const cli = (p: Person, args: string[], cwd?: string) => k.r.cli(p, args, { cwd: cwd ?? plainDir() });
const posts = (requests: string[]) => requests.filter((q) => q.startsWith("POST "));
const SOLO_ARGS = ["--preset", "solo", "--repo", "alpha"];
const SOLO_FILE = `description: One step
steps:
  - id: run
    kind: implement
    repo: "{repo}"
    title: "Run {repo}"
    brief: "Do it."
`;
/** ann's checkout with .mesh/presets/<name>.yaml committed; returns the commit. */
function commitPreset(p: Person, name: string, text: string): string {
  mkdirSync(join(p.repoDir, ".mesh", "presets"), { recursive: true });
  writeFileSync(join(p.repoDir, ".mesh", "presets", `${name}.yaml`), text);
  git(p.repoDir, ["add", "-A"]);
  git(p.repoDir, ["commit", "-qm", `preset ${name}`]);
  return git(p.repoDir, ["rev-parse", "HEAD"]);
}

// ---------------------------------------------------------------------------------------------

describe("AC-20 mesh pulse add", { timeout: 30_000 }, () => {
  it("test_AC20_add_builtin", async () => {
    const c = await cast();
    const res = await cli(c.ann, ["pulse", "add", "--preset", "audit-relay", "--repo", "/src/alpha", "--params", "agent=a,validator=v,filer=f", "--every", "7d"]);
    expect(res.code, res.err).toBe(0);
    expect(res.out.trim()).toBe(`Created pulse p-1 "audit-relay on alpha": every 7d, next run ${iso(NOW + 7 * DAY)}.`);
    expect(posts(res.requests)).toStrictEqual(["POST /v1/pulses"]);
    const p = await k.pulseOf("p-1");
    expect(p.preset).toStrictEqual({ name: "audit-relay", text: RELAY_TEXT(), sha256: sha(RELAY_TEXT()) });
    expect(p.params).toStrictEqual({ agent: "a", validator: "v", filer: "f", repo: "/src/alpha" });
    expect(p.when).toStrictEqual({ every: "7d", anchor: NOW });
    expect(p.owner).toBe("ann");
  });

  it("test_AC20_add_cron_tz_default", async () => {
    const c = await cast();
    commitPreset(c.ann, "solo", SOLO_FILE);
    const res = await cli(c.ann, ["pulse", "add", ...SOLO_ARGS, "--cron", "0 9 * * 1"], c.ann.repoDir);
    expect(res.code, res.err).toBe(0);
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
    const p = await k.pulseOf("p-1");
    expect(p.when).toStrictEqual({ cron: "0 9 * * 1", tz });
    expect((await k.detail("ann", "p-1")).schedule).toBe(`cron "0 9 * * 1" ${tz}`);
  });

  it("test_AC20_add_flags", async () => {
    const c = await cast();
    commitPreset(c.ann, "solo", SOLO_FILE);
    expect((await k.call("ann", "POST", "/v1/topics", { name: "t" })).status).toBe(201);
    const res = await cli(
      c.ann,
      ["pulse", "add", ...SOLO_ARGS, "--title", "T", "--topics", "t", "--labels", "a,b", "--machines", "m", "--window", "2h", "--overlap", "allow", "--max-goal-age", "3d", "--missed", "catch-up-once", "--paused", "--at", "2026-11-20T09:00:00Z", "--every", "1d"],
      c.ann.repoDir,
    );
    expect(res.code, res.err).toBe(0);
    expect(res.out.trim()).toBe('Created pulse p-1 "T": every 1d, next run -.');
    const p = await k.pulseOf("p-1");
    expect(p).toMatchObject({ title: "T", topics: ["t"], target: { labels: ["a", "b"], machines: ["m"] }, window: "2h", overlap: "allow", maxGoalAge: "3d", missed: "catch-up-once", enabled: false });
    expect(p.when).toStrictEqual({ every: "1d", anchor: Date.parse("2026-11-20T09:00:00Z") });
    expect(Object.hasOwn(p, "nextAt")).toBe(false);
  });

  const errors: [string, string[], string | RegExp][] = [
    ["no --preset", ["pulse", "add", "--repo", "alpha", "--every", "7d"], /usage/],
    ["no --repo", ["pulse", "add", "--preset", "solo", "--every", "7d"], /usage/],
    ["no schedule", ["pulse", "add", ...SOLO_ARGS], 'give one schedule: --every <duration> or --cron "<5 fields>"'],
    ["both schedules", ["pulse", "add", ...SOLO_ARGS, "--every", "7d", "--cron", "0 9 * * 1"], 'give one schedule: --every <duration> or --cron "<5 fields>"'],
    ["bad --at", ["pulse", "add", ...SOLO_ARGS, "--every", "7d", "--at", "yesterday"], "--at takes an ISO time, e.g. 2026-11-16T09:00:00Z"],
    ["bad --params", ["pulse", "add", ...SOLO_ARGS, "--every", "7d", "--params", "x"], "--params takes k=v pairs separated by commas"],
    ["unknown preset", ["pulse", "add", "--preset", "nope", "--repo", "alpha", "--every", "7d"], 'no template "nope"'],
  ];
  it.each(errors)("test_AC20_add_errors %s", async (_n, args, text) => {
    const c = await cast();
    commitPreset(c.ann, "solo", SOLO_FILE);
    const res = await cli(c.ann, args, c.ann.repoDir);
    expect(res.code, `${res.out}\n${res.err}`).toBe(2);
    if (typeof text === "string") expect(res.err).toContain(text);
    else expect(res.err).toMatch(text);
    expect(posts(res.requests)).toStrictEqual([]);
    expect((await k.call("ann", "GET", "/v1/pulses")).json.pulses).toStrictEqual([]);
  });
});

// ---------------------------------------------------------------------------------------------

describe("AC-20 mesh pulse ls, show, update, pause, resume, fire, rm", { timeout: 30_000 }, () => {
  it("test_AC20_ls", async () => {
    const c = await cast();
    await k.pulseOk("ann", body({ when: { every: "7d" }, title: "weekly" }));
    await k.pulseOk("ann", body({ enabled: false, title: "daily" }));
    // p-1's newest slot: a manual fire whose window ends with no machine (missed, no_machine).
    await k.fireOk("ann", "p-1");
    await k.tickAt(NOW + 5 * HOUR);
    const res = await cli(c.ann, ["pulse", "ls"]);
    expect(res.code, res.err).toBe(0);
    const lines = res.out.trim().split("\n");
    expect(lines).toStrictEqual([`p-1  active  @ann  every 7d  next ${iso(NOW + 7 * DAY)}  last missed (no_machine)  weekly`, "p-2  paused  @ann  every 1d  next -  last -  daily"]);
  });

  it("test_AC20_ls_empty_json", async () => {
    const c = await cast();
    const empty = await cli(c.ann, ["pulse", "ls"]);
    expect(empty.code, empty.err).toBe(0);
    expect(empty.out.trim()).toBe("No pulses. Create one: mesh pulse add --preset <name> --repo <repo> --every 7d");
    await k.pulseOk("ann", body());
    const json = await cli(c.ann, ["pulse", "ls", "--json"]);
    expect(json.code, json.err).toBe(0);
    expect(JSON.parse(json.out)).toStrictEqual((await k.call("ann", "GET", "/v1/pulses")).json);
    // --mine passes the filter.
    await k.pulseOk("bob", body());
    const mine = await cli(c.ann, ["pulse", "ls", "--mine", "--json"]);
    expect((JSON.parse(mine.out).pulses as Json[]).map((p) => p.id)).toStrictEqual(["p-1"]);
  });

  it("test_AC20_show", async () => {
    const c = await cast();
    const commit = commitPreset(c.ann, "solo", SOLO_FILE);
    const add = await cli(c.ann, ["pulse", "add", ...SOLO_ARGS, "--every", "1d", "--params", "agent=x,mode=y"], c.ann.repoDir);
    expect(add.code, add.err).toBe(0);
    const A: Bare = await k.bare("ann", "box-a");
    const B: Bare = await k.bare("ann", "box-b");
    // Fire: offered to one machine, it declines, the next tick offers the other.
    const fired = await k.fireOk("ann", "p-1");
    const first = (await k.step(`${fired.goal}.run`)).offer.to.machine as string;
    expect([A.machine, B.machine]).toContain(first);
    const [m1, m2]= first === A.machine ? [A, B] : [B, A];
    expect((await k.stepAct(m1.token, `${fired.goal}.run`, "decline")).status).toBe(200);
    await k.tickAt(NOW + MIN, A, B);
    k.at(NOW + 2 * MIN);
    const skipped = await k.fireOk("ann", "p-1");
    expect(skipped.state).toBe("skipped");
    const res = await cli(c.ann, ["pulse", "show", "p-1"]);
    expect(res.code, res.err).toBe(0);
    const lines = res.out.trim().split("\n");
    const p = await k.pulseOf("p-1");
    expect(lines[0]).toBe(`p-1 "${p.title}"  @ann  active`);
    const schedule = lines.find((l) => l.startsWith("schedule: "));
    expect(schedule).toContain("every 1d");
    const preset = lines.find((l) => l.startsWith("preset: ")) as string;
    expect(preset).toContain("solo");
    expect(preset).toContain(sha12(p.preset.text));
    expect(preset).toContain(`from alpha@${commit.slice(0, 12)}`);
    expect(preset).toContain("agent=x");
    expect(preset).toContain("mode=y");
    expect(lines.some((l) => l.startsWith("target: "))).toBe(true);
    const at = lines.indexOf("slots:");
    expect(at).toBeGreaterThan(0);
    expect(lines.slice(at + 1)).toStrictEqual([`  ${skipped.slot}  skipped (overlap)  -`, `  ${fired.slot}  fired  ${fired.goal}  tried ${m1.machine},${m2.machine}`]);
    const json = await cli(c.ann, ["pulse", "show", "p-1", "--json"]);
    expect(JSON.parse(json.out)).toStrictEqual(await k.detail("ann", "p-1"));
    // A paused pulse shows its reason.
    expect((await k.act("ann", "p-1", "pause")).status).toBe(200);
    expect((await cli(c.ann, ["pulse", "show", "p-1"])).out.split("\n")[0]).toBe(`p-1 "${p.title}"  @ann  paused: paused by ann`);
  });

  it("test_AC20_update", async () => {
    const c = await cast();
    await k.pulseOk("ann", body({ when: { every: "1d", at: T0 } }));
    const before = await k.pulseOf("p-1");
    const res = await cli(c.ann, ["pulse", "update", "p-1", "--window", "2h"]);
    expect(res.code, res.err).toBe(0);
    expect(res.out.trim()).toBe(`Updated pulse p-1; next run ${iso(T0)}.`);
    expect(posts(res.requests)).toStrictEqual(["POST /v1/pulses/p-1/update"]);
    const after = await k.pulseOf("p-1");
    expect(after).toMatchObject({ window: "2h", windowMs: 2 * HOUR, version: 1, title: before.title, when: before.when, overlap: before.overlap });
    expect(after.preset).toStrictEqual(before.preset);
    const ev = await k.pulseEvents("pulse.updated", "p-1");
    expect(ev.map((e) => e.payload.fields)).toStrictEqual([["window"]]);
    // --repo sends the full new params.
    const repo = await cli(c.ann, ["pulse", "update", "p-1", "--repo", "beta"]);
    expect(repo.code, repo.err).toBe(0);
    const p = await k.pulseOf("p-1");
    expect(p.params).toStrictEqual({ repo: "beta" });
    expect(p.version).toBe(2);
    expect((await k.pulseEvents("pulse.updated", "p-1")).map((e) => e.payload.fields)).toStrictEqual([["window"], ["params"]]);
  });

  it("test_AC20_pause_resume_rm", async () => {
    const c = await cast();
    await k.pulseOk("ann", body({ when: { every: "1d", at: T0 } }));
    const pause = await cli(c.ann, ["pulse", "pause", "p-1"]);
    expect([pause.code, pause.out.trim()]).toStrictEqual([0, "Paused pulse p-1."]);
    const resume = await cli(c.ann, ["pulse", "resume", "p-1"]);
    expect([resume.code, resume.out.trim()]).toStrictEqual([0, `Resumed pulse p-1; next run ${iso(T0)}.`]);
    const rm = await cli(c.ann, ["pulse", "rm", "p-1"]);
    expect([rm.code, rm.out.trim()]).toStrictEqual([0, "Removed pulse p-1 (its goals stay)."]);
    expect((await k.call("ann", "GET", "/v1/pulses/p-1")).status).toBe(404);
  });

  it("test_AC20_fire", async () => {
    const c = await cast();
    await k.pulseOk("ann", body());
    const fired = await cli(c.ann, ["pulse", "fire", "p-1"]);
    expect(fired.code, fired.err).toBe(0);
    const s = (await k.slotsOf("p-1"))[0];
    expect(fired.out.trim()).toBe(`Fired pulse p-1: slot ${s.slot} → ${s.goal}.`);
    k.at(NOW + MIN);
    const again = await cli(c.ann, ["pulse", "fire", "p-1"]);
    expect(again.code, again.err).toBe(0);
    const sk = (await k.slotsOf("p-1")).find((x) => x.state === "skipped");
    expect(again.out.trim()).toBe(`Pulse p-1 skipped slot ${sk.slot}: ${s.goal} is still running (overlap: skip).`);
  });

  it("test_AC20_hub_error", async () => {
    const c = await cast();
    await k.pulseOk("ann", body());
    const res = await cli(c.bob, ["pulse", "pause", "p-1"]);
    expect(res.code).toBe(1);
    expect(res.err).toContain("only @ann or an admin can change pulse p-1");
    // Positive control: the owner may.
    expect((await cli(c.ann, ["pulse", "pause", "p-1"])).code).toBe(0);
  });

  it("test_AC20_unknown_sub", async () => {
    const c = await cast();
    const res = await cli(c.ann, ["pulse", "frob"]);
    expect(res.code).toBe(2);
    expect(`${res.out}\n${res.err}`).toMatch(/usage/);
    expect(res.requests).toStrictEqual([]);
  });

  it("test_AC20_help", async () => {
    const c = await cast();
    const res = await cli(c.ann, ["help"]);
    expect(res.code).toBe(0);
    // Positive control: an existing command is listed the same way.
    expect(res.out).toMatch(/^\s+goal\b/m);
    expect(res.out).toMatch(/^\s+pulse\b/m);
  });
});

// ---------------------------------------------------------------------------------------------

describe("AC-07 repo preset snapshot", { timeout: 30_000 }, () => {
  it("test_AC07_cli_repo_preset", async () => {
    const c = await cast();
    // Written with a comment and an unusual key order, so `presetText` of it differs from the bytes.
    const OLD = `# the weekly preset
steps:
  - title: "Old {repo}"
    brief: "old"
    id: run
    repo: "{repo}"
    kind: implement
description: Weekly
`;
    const commit = commitPreset(c.ann, "weekly", OLD);
    const sub = join(c.ann.repoDir, "sub", "dir");
    mkdirSync(sub, { recursive: true });
    const add = await cli(c.ann, ["pulse", "add", "--preset", "weekly", "--repo", "alpha", "--every", "7d"], sub);
    expect(add.code, add.err).toBe(0);
    const want = presetText(parsePreset("weekly", OLD));
    expect(want).not.toBe(OLD);
    const p = await k.pulseOf("p-1");
    expect(p.preset).toStrictEqual({ name: "weekly", text: want, sha256: sha(want), source: { repo: "alpha", commit } });
    expect((await k.pulseEvents("pulse.created", "p-1"))[0].payload.sha256).toBe(sha(want));
    // The repo's file changes afterwards: the next fire still runs the snapshot.
    commitPreset(c.ann, "weekly", `description: Weekly v2\nsteps:\n  - { id: run, kind: implement, repo: "{repo}", title: "New {repo}", brief: new }\n  - { id: more, kind: implement, repo: "{repo}", deps: [run], title: More, brief: m }\n`);
    const fire = await cli(c.ann, ["pulse", "fire", "p-1"]);
    expect(fire.code, fire.err).toBe(0);
    const G = (await k.slotsOf("p-1"))[0].goal as string;
    const d = await k.goal(G);
    expect((d.steps as Json[]).map((s) => [s.id, s.title])).toStrictEqual([[`${G}.run`, "Old alpha"]]);
    expect(d.goal.preset).toStrictEqual({ name: "weekly", text: want });
  });

  it("test_AC20_builtin_no_source", async () => {
    const c = await cast();
    // From inside a git checkout without a repo preset of that name: the built-in, no source.
    const res = await cli(c.ann, ["pulse", "add", "--preset", "audit-relay", "--repo", "alpha", "--params", "agent=a,validator=v,filer=f", "--every", "7d"], c.ann.repoDir);
    expect(res.code, res.err).toBe(0);
    expect(Object.hasOwn((await k.pulseOf("p-1")).preset, "source")).toBe(false);
  });
});

// ---------------------------------------------------------------------------------------------

describe("AC-16 mesh goal ls --pulses", { timeout: 30_000 }, () => {
  it("test_AC16_cli", async () => {
    const c = await cast();
    await k.pulseOk("ann", body());
    const GP = (await k.fireOk("ann", "p-1")).goal as string;
    const GO = (await k.call("ann", "POST", "/v1/goals", { title: "ordinary", primaryRepo: "alpha" })).json.id as string;
    const plain = await cli(c.ann, ["goal", "ls"]);
    expect(plain.code, plain.err).toBe(0);
    expect(plain.out).toContain(GO);
    expect(plain.out).not.toMatch(new RegExp(`\\b${GP}\\b`));
    const withPulses = await k.r.cli(c.ann, ["goal", "ls", "--pulses"]);
    expect(withPulses.code, withPulses.err).toBe(0);
    expect(withPulses.out).toContain(GO);
    expect(withPulses.out).toMatch(new RegExp(`\\b${GP}\\b`));
  });
});

describe("AC-19 mesh preset ls", { timeout: 30_000 }, () => {
  it("test_AC19_preset_ls", async () => {
    const c = await cast();
    const res = await cli(c.ann, ["preset", "ls"]);
    expect(res.code, res.err).toBe(0);
    expect(res.out).toContain("sdd-split");
    expect(res.out).toContain("audit-relay");
  });
});

// RL-6 AC-03 (CLI): `mesh preset ls` lists the built-in `calibrate` right after `audit-relay`
// (docs/specs/RL-6.md).
describe("RL-6 AC-03 mesh preset ls", { timeout: 30_000 }, () => {
  it("test_AC03_cli_preset_ls", async () => {
    const c = await cast();
    const res = await cli(c.ann, ["preset", "ls"]);
    expect(res.code, res.err).toBe(0);
    const lines = res.out.split("\n");
    const relay = lines.findIndex((l) => /\baudit-relay\b/.test(l));
    expect(relay, "audit-relay line").toBeGreaterThanOrEqual(0);
    expect(lines[relay + 1] ?? "", "the line after audit-relay").toMatch(/\bcalibrate\b/);
    expect(lines[relay + 1] ?? "").toContain("Calibrate an agent");
  });
});

describe("AC-29 mesh pulse fire, error", { timeout: 30_000 }, () => {
  it("test_AC29_cli_manual_error", async () => {
    const c = await cast();
    await k.pulseOk("ann", body());
    await k.pulseOk("ann", body());
    k.storeWrap({
      createGoal: (orig, g, ...rest) => {
        if ((g as Json)?.refs?.pulse === "p-1") throw new Error("boom-cli");
        return orig(g, ...rest);
      },
    });
    const res = await cli(c.ann, ["pulse", "fire", "p-1"]);
    expect(res.code).toBe(1);
    const s = (await k.slotsOf("p-1"))[0];
    expect(s).toMatchObject({ state: "missed", reason: "error", error: "boom-cli" });
    expect(`${res.out}\n${res.err}`).toContain(`Pulse p-1 missed slot ${s.slot}: boom-cli`);
    // Positive control: another pulse fires with exit 0.
    expect((await cli(c.ann, ["pulse", "fire", "p-2"])).code).toBe(0);
  });
});
