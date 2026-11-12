// RL-1 CLI against a World hub: `mesh goal plan --params`, `mesh profile`, `mesh artifact`, `mesh help`.
// Criteria AC-04, AC-07, AC-12 (CLI part), AC-33. Written from the spec's contracts only
// (docs/specs/RL-1.md).

import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Relay } from "./helpers/relay-kit.ts";
import type { Json, Person } from "./helpers/world.ts";

let r: Relay;
afterEach(async () => {
  await r?.stop();
});

const sha = (s: string) => createHash("sha256").update(s, "utf8").digest("hex");

async function cast(): Promise<{ ann: Person; bob: Person }> {
  r = await Relay.start(["ann", "bob"]);
  const ann = await r.w.person("ann", "svc");
  const bob = await r.w.person("bob", "svc");
  await r.w.flush();
  return { ann, bob };
}

const PRESET = `description: Headless audit
steps:
  - id: audit
    kind: implement
    mode: headless
    agent: "{agent}"
    profile: "{profile}"
    title: "Audit with {agent}"
    brief: "Use {profile} on {repo} for {goal}."
`;

describe("AC-04 plan --params", { timeout: 20_000 }, () => {
  async function setup() {
    const k = await cast();
    mkdirSync(join(k.ann.repoDir, ".mesh", "presets"), { recursive: true });
    writeFileSync(join(k.ann.repoDir, ".mesh", "presets", "p.yaml"), PRESET);
    const G = await r.goal(k.ann);
    return { ...k, G };
  }
  const plans = (requests: string[], G: string) => requests.filter((q) => q === `POST /v1/goals/${G}/plan`);

  it("test_AC04_params_sent", async () => {
    const { ann, G } = await setup();
    const res = await r.cli(ann, ["goal", "plan", G, "--preset", "p", "--repo", "svc", "--params", "agent=auditor,profile=read-only"], { cwd: ann.repoDir });
    expect(res.code, res.err).toBe(0);
    expect(plans(res.requests, G)).toHaveLength(1);
    const st = await r.stepOf(`${G}.audit`);
    expect(st.policy).toMatchObject({ mode: "headless", agent: "auditor", profile: "read-only" });
    expect(st.title).toBe("Audit with auditor");
  });

  it("test_AC04_value_with_equals", async () => {
    const { ann, G } = await setup();
    const res = await r.cli(ann, ["goal", "plan", G, "--preset", "p", "--repo", "svc", "--params", "agent=auditor,profile=read-only,note=a=b"], { cwd: ann.repoDir });
    expect(res.code, res.err).toBe(0);
    expect((await r.stepOf(`${G}.audit`)).policy).toMatchObject({ agent: "auditor", profile: "read-only" });
  });

  it("test_AC04_no_equals", async () => {
    const { ann, G } = await setup();
    const res = await r.cli(ann, ["goal", "plan", G, "--preset", "p", "--repo", "svc", "--params", "agent"], { cwd: ann.repoDir });
    expect(res.code).toBe(2);
    expect(res.err).toContain("--params takes k=v pairs separated by commas");
    expect(plans(res.requests, G)).toStrictEqual([]);
    expect(((await r.call(ann, "GET", `/v1/goals/${G}`)).json.steps as Json[]).some((s) => s.id === `${G}.audit`)).toBe(false);
  });

  it("test_AC04_missing_param", async () => {
    const { ann, G } = await setup();
    const res = await r.cli(ann, ["goal", "plan", G, "--preset", "p", "--repo", "svc", "--params", "agent=auditor"], { cwd: ann.repoDir });
    expect(res.code).toBe(2);
    expect(res.err).toMatch(/preset p: unknown parameter \{profile\} in step (G\d+\.)?audit$/m);
    expect(res.requests.filter((q) => q.startsWith("POST "))).toStrictEqual([]);
    expect(((await r.call(ann, "GET", `/v1/goals/${G}`)).json.steps as Json[]).some((s) => s.id === `${G}.audit`)).toBe(false);
  });
});

describe("AC-07 profile", { timeout: 20_000 }, () => {
  it("test_AC07_ls_text_and_json", async () => {
    const { ann } = await cast();
    const saved = await r.call(ann, "POST", "/v1/profiles", { name: "p1", text: "description: Audit\nextends: read-only\n" });
    expect(saved.status).toBe(201);
    const res = await r.cli(ann, ["profile", "ls"]);
    expect(res.code, res.err).toBe(0);
    const lines = res.out.split("\n").filter((l) => l.trim());
    const view = (await r.call(ann, "GET", "/v1/profiles")).json.profiles as Json[];
    const ro = view.find((p) => p.name === "read-only");
    expect(lines).toContain(`read-only  built in  ${String(ro.sha256).slice(0, 12)}  ${ro.description}`);
    expect(lines.find((l) => l.startsWith("read-only  "))).toMatch(/^read-only {2}built in {2}[0-9a-f]{12} {2}.+$/);
    expect(lines).toContain(`p1  @ann  ${String(saved.json.sha256).slice(0, 12)}  Audit`);
    expect(lines.filter((l) => /^(read-only|read-only\+checks|propose-via-branch|p1) {2}/.test(l))).toHaveLength(4);
    // test_AC07_ls_json
    const js = await r.cli(ann, ["profile", "ls", "--json"]);
    expect(js.code, js.err).toBe(0);
    expect(JSON.parse(js.out)).toStrictEqual({ profiles: view });
  });

  it("test_AC07_show", async () => {
    const { ann } = await cast();
    const res = await r.cli(ann, ["profile", "show", "read-only"]);
    expect(res.code, res.err).toBe(0);
    const settings = (await r.call(ann, "GET", "/v1/profiles/read-only")).json.settings;
    expect(res.out.replace(/\n$/, "")).toBe(JSON.stringify(settings, null, 2));
    // test_AC07_show_unknown
    const bad = await r.cli(ann, ["profile", "show", "x"]);
    expect(bad.code).toBe(1);
    expect(bad.err).toContain("no profile x");
  });

  it("test_AC07_add", async () => {
    const { ann } = await cast();
    const f = join(ann.dir, "f.yaml");
    writeFileSync(f, "extends: read-only+checks\nchecks: [pnpm test]\n");
    const res = await r.cli(ann, ["profile", "add", "p2", "--file", f]);
    expect(res.code, res.err).toBe(0);
    const got = await r.call(ann, "GET", "/v1/profiles/p2");
    expect(got.status).toBe(200);
    expect(res.out.trim()).toBe(`Saved profile p2 (sha256 ${String(got.json.sha256).slice(0, 12)}).`);
    // test_AC07_add_refused
    writeFileSync(f, "allow: [Bash]\n");
    const bad = await r.cli(ann, ["profile", "add", "p3", "--file", f]);
    expect(bad.code).toBe(1);
    expect(bad.err).toContain("profiles may not allow Bash");
    // test_AC07_add_no_file
    const none = await r.cli(ann, ["profile", "add", "p4"]);
    expect(none.code).toBe(2);
    expect(none.err.length).toBeGreaterThan(0);
    expect((await r.call(ann, "GET", "/v1/profiles/p4")).status).toBe(404);
    expect((await r.call(ann, "GET", "/v1/profiles/p3")).status).toBe(404);
  });
});

describe("AC-33 artifact", { timeout: 20_000 }, () => {
  async function withArtifacts() {
    const k = await cast();
    const G = await r.goal(k.ann, [{ id: "s" }]);
    expect((await r.act(k.ann, `${G}.s`, "claim", {})).status).toBe(200);
    const content = "line1\r\nü ✓\n\n";
    const a = (await r.upload(k.ann, `${G}.s`, { kind: "report", title: "T", content })).json;
    r.w.clock += 1;
    const b = (await r.upload(k.ann, `${G}.s`, { kind: "review", content: "untitled" })).json;
    return { ...k, G, a, b, content };
  }

  it("test_AC33_ls", async () => {
    const { ann, G, a, b } = await withArtifacts();
    const res = await r.cli(ann, ["artifact", "ls", G]);
    expect(res.code, res.err).toBe(0);
    const lines = res.out.split("\n").filter((l) => l.trim());
    expect(lines).toContain(`${a.id}  ${G}.s r1  report  ${a.bytes} B  T`);
    expect(lines).toContain(`${b.id}  ${G}.s r1  review  ${b.bytes} B  -`);
    const js = await r.cli(ann, ["artifact", "ls", G, "--json"]);
    expect(JSON.parse(js.out)).toStrictEqual({ artifacts: (await r.call(ann, "GET", `/v1/goals/${G}/artifacts`)).json.artifacts });
  });

  it("test_AC33_ls_empty", async () => {
    const { ann } = await cast();
    const G = await r.goal(ann, [{ id: "s" }]);
    const res = await r.cli(ann, ["artifact", "ls", G]);
    expect(res.code, res.err).toBe(0);
    expect(res.out.trim()).toBe(`No artifacts for ${G}.`);
  });

  it("test_AC33_show_bytes_and_unknown", async () => {
    const { ann, a, content } = await withArtifacts();
    const res = await r.cli(ann, ["artifact", "show", a.id]);
    expect(res.code, res.err).toBe(0);
    expect(res.bytes.equals(Buffer.from(content, "utf8")), JSON.stringify(res.bytes.toString())).toBe(true);
    const bad = await r.cli(ann, ["artifact", "show", "a-NOPE"]);
    expect(bad.code).toBe(1);
    expect(bad.err).toContain("no artifact a-NOPE");
  });

  it("test_AC33_help", async () => {
    const { ann } = await cast();
    const res = await r.cli(ann, ["help"]);
    expect(res.out).toMatch(/\bprofile\b/);
    expect(res.out).toMatch(/\bartifact\b/);
  });
});

describe("AC-12 CLI show of a pruned artifact", { timeout: 20_000 }, () => {
  it("test_AC12_cli_pruned", async () => {
    const { ann } = await cast();
    const G = await r.goal(ann, [{ id: "s" }]);
    expect((await r.act(ann, `${G}.s`, "claim", {})).status).toBe(200);
    const old = (await r.upload(ann, `${G}.s`, { kind: "report", content: "old content" })).json;
    r.w.clock += 1000;
    const young = (await r.upload(ann, `${G}.s`, { kind: "report", content: "young content\n" })).json;
    const store = r.w.hubStore as unknown as { pruneArtifacts(g: string[], before: number, now: number): Promise<number> };
    expect(await store.pruneArtifacts([G], old.createdAt + 1, r.w.clock)).toBe(1);
    const res = await r.cli(ann, ["artifact", "show", old.id]);
    expect(res.code).toBe(1);
    expect(res.err).toContain(`${old.id}: content pruned (sha256 ${sha("old content")})`);
    expect(res.out).toBe("");
    const ok = await r.cli(ann, ["artifact", "show", young.id]);
    expect(ok.code, ok.err).toBe(0);
    expect(ok.bytes.toString("utf8")).toBe("young content\n");
  });
});
