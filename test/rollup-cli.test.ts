// RL-19 AC-12 (CLI): a repo preset's `kind` through `mesh pulse add` and `mesh preset ls`
// (docs/specs/RL-19.md, "Preset kind"). What the CLI sent is read back at the hub.

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { git, Relay } from "./helpers/relay-kit.ts";
import { DAY, Pk, T0 } from "./helpers/pulse-kit.ts";
import type { Person } from "./helpers/world.ts";

let k: Pk | undefined;
afterEach(async () => {
  await k?.stop();
  k = undefined;
});

async function ann(): Promise<Person> {
  const r = await Relay.start(["ann", "carol"], { admins: ["carol"] });
  r.w.clock = T0 - DAY;
  k = new Pk(r);
  k.tok.ann = (await r.w.login("ann", { hostname: "ann-login" })).token;
  const p = await r.w.person("ann", "alpha");
  await r.w.flush();
  return p;
}
const preset = (kind: string) => `description: One step
kind: ${kind}
steps:
  - id: run
    kind: implement
    repo: "{repo}"
    title: "Run {repo}"
    brief: "Do it."
`;
function commitPreset(p: Person, name: string, text: string): void {
  mkdirSync(join(p.repoDir, ".mesh", "presets"), { recursive: true });
  writeFileSync(join(p.repoDir, ".mesh", "presets", `${name}.yaml`), text);
  git(p.repoDir, ["add", "-A"]);
  git(p.repoDir, ["commit", "-qm", `preset ${name}`]);
}
const ADD = (name: string) => ["pulse", "add", "--preset", name, "--repo", "alpha", "--every", "7d"];

describe("RL-19 AC-12 preset kind in the CLI", { timeout: 30_000 }, () => {
  it("test_AC12_pulse_add_bad_kind", async () => {
    const p = await ann();
    commitPreset(p, "bad", preset("Bad Kind"));
    const res = await (k as Pk).r.cli(p, ADD("bad"), { cwd: p.repoDir });
    expect(res.code, res.out).toBe(2);
    expect(res.err).toContain(".mesh/presets/bad.yaml: kind must match ^[a-z][a-z0-9-]{0,39}$");
    expect(res.requests.filter((q) => q.startsWith("POST "))).toStrictEqual([]);
  });

  it("test_AC12_pulse_add_kind_sent", async () => {
    const p = await ann();
    commitPreset(p, "good", preset("code-audit"));
    const res = await (k as Pk).r.cli(p, ADD("good"), { cwd: p.repoDir });
    expect(res.code, res.err).toBe(0);
    const pulse = await (k as Pk).pulseOf("p-1");
    expect(pulse.preset.text).toMatch(/^kind: code-audit$/m);
  });

  it("test_AC12_preset_ls", async () => {
    const p = await ann();
    commitPreset(p, "bad", preset("Bad Kind"));
    commitPreset(p, "good", preset("code-audit"));
    const res = await (k as Pk).r.cli(p, ["preset", "ls"], { cwd: p.repoDir });
    expect(res.code, res.err).toBe(0);
    expect(res.out).toMatch(/^bad +invalid: kind must match \^\[a-z\]\[a-z0-9-\]\{0,39\}\$ +\[\.mesh\/presets\/bad\.yaml\]$/m);
    expect(res.out).toMatch(/^good +One step +\[\.mesh\/presets\/good\.yaml\]$/m);
  });
});
