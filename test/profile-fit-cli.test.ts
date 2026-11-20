// RL-16 AC-08: `mesh profile fit` against a World hub (docs/specs/RL-16.md, "CLI"): the text lines in
// order, the query it sends, --json, the small-sample and empty reports, the built-in hint, a refusal,
// the usage, and that nothing is saved.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { formatProfileFit } from "../src/cli/artifact-commands.ts";
import type { RunTelemetry } from "../src/protocol/index.ts";
import { Ck, DAY, HA, KEY, P, tel } from "./helpers/calib-kit.ts";
import type { Json } from "./helpers/world.ts";

const NOW = Date.UTC(2026, 10, 20, 12);
const V1 = "extends: read-only\n";
const V2 = "extends: read-only\ndeny: [\"Bash(rm *)\"]\n";
const TOOLS = ["Bash", "CronCreate", "Read"];

describe("RL-16 AC-08 mesh profile fit", { timeout: 120_000 }, () => {
  let k: Ck;
  let dir = "";
  let h1 = "";
  let h2 = "";
  let n = 0;
  const cli = (args: string[]) => k.r.cli(k.c.ann, ["profile", ...args], { cwd: dir });

  async function profRun(profile: string, hash: string, when: number, over: Partial<RunTelemetry> = {}): Promise<void> {
    const G = await k.goal(k.c.ann, [P.run("r")]);
    k.at(when);
    await k.run(k.c.ann, `${G}.r`, { ...tel({ runId: `r${++n}`, agentKey: KEY, agentHash: HA, durationMs: 1_000 }), profile, profileHash: hash, ...over } as Json);
  }
  async function save(name: string, text: string): Promise<string> {
    const res = await k.r.call(k.c.ann, "POST", "/v1/profiles", { name, text });
    expect([200, 201], JSON.stringify(res.json)).toContain(res.status);
    return res.json.sha256 as string;
  }

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), "mesh-fit-cli-"));
    k = await Ck.start({ clock: NOW - 10 * DAY });
    h1 = await save("ci", V1);
    await profRun("ci", h1, NOW - 9 * DAY);
    k.at(NOW - 8 * DAY);
    h2 = await save("ci", V2);
    // Five runs at h2: cargo denied in all (suggested), git in all (held), CronCreate never used.
    for (let i = 0; i < 5; i++) {
      await profRun("ci", h2, NOW - 5 * DAY + i, {
        denied: [
          { tool: "Bash", command: "cargo", count: 2 },
          { tool: "Bash", command: "git", count: 1 },
        ],
        permissionDenials: { count: 3, tools: ["Bash"] },
        tools: TOOLS,
        toolsUsed: ["Bash", "Read"],
      });
    }
    // Two runs of a small profile, one of them a day old.
    const hs = await save("small", V1.replace("read-only", "read-only+checks"));
    await profRun("small", hs, NOW - 2 * DAY, { denied: [{ tool: "Bash", command: "make", count: 1 }], permissionDenials: { count: 1, tools: ["Bash"] } });
    k.at(NOW);
  });
  afterAll(async () => {
    await k?.stop();
    rmSync(dir, { recursive: true, force: true });
  });

  it("test_AC08_text_lines", async () => {
    const res = await cli(["fit", "ci"]);
    expect(res.code, res.err).toBe(0);
    expect(res.out.trimEnd().split("\n")).toStrictEqual([
      `Profile ci (sha256 ${h2.slice(0, 12)}): 5 runs in the last 14 days at this hash, 5 with tool data.`,
      `Other hashes: ${h1.slice(0, 12)} 1 run.`,
      "Denied:",
      "  Bash cargo  5/5 runs, 10 denials  → allow Bash(cargo *)",
      "  Bash git  5/5 runs, 5 denials  held: denied-by-profile",
      "Offered, never used:",
      "  CronCreate  5/5 runs  → drop (deny CronCreate)",
      "Proposed change:",
      "  allow: + Bash(cargo *)",
      "  deny:  + CronCreate",
      "Nothing was saved. Narrow the Bash rules if you can, add them to the profile's YAML and run: mesh profile add ci --file <profile.yaml>",
    ]);
  });

  it("test_AC08_query_json_and_no_write", async () => {
    const before = (await k.r.allEvents()).filter((e: Json) => e.type === "profile.saved").length;
    const res = await cli(["fit", "ci", "--days", "3", "--include-trial", "--json"]);
    expect(res.code, res.err).toBe(0);
    const fit = JSON.parse(res.out) as Json;
    expect(fit.window.days).toBe(3);
    expect(fit.trial).toBe("include");
    expect(fit).toStrictEqual((await k.r.call(k.c.ann, "GET", "/v1/profiles/ci/fit?days=3&trial=include")).json);
    const text = await cli(["fit", "ci", "--days", "3", "--include-trial"]);
    expect(text.out.split("\n")[0]).toBe(`Profile ci (sha256 ${h2.slice(0, 12)}): 0 runs in the last 3 days at this hash, 0 with tool data. Trial runs included.`);
    expect((await k.r.allEvents()).filter((e: Json) => e.type === "profile.saved").length).toBe(before);
  });

  it("test_AC08_small_empty_builtin", async () => {
    const small = await cli(["fit", "small"]);
    expect(small.code, small.err).toBe(0);
    const lines = small.out.trimEnd().split("\n");
    expect(lines[0]).toMatch(/^Profile small \(sha256 [0-9a-f]{12}\): 1 runs in the last 14 days at this hash, 0 with tool data\.$/);
    expect(lines.slice(1, 3)).toStrictEqual(["Fewer than 5 runs: no allow rule is suggested from a small sample.", "Fewer than 5 runs with tool data: no tool is suggested for dropping."]);
    expect(lines).toContain("  Bash make  1/1 runs, 1 denials  held: few-runs");
    expect(lines).toContain("Offered, never used: no runs with tool data.");
    expect(lines.at(-1)).toBe("Proposed change: none.");
    const empty = await cli(["fit", "propose-via-branch"]);
    expect(empty.out.trimEnd().split("\n").slice(1)).toStrictEqual([
      "Fewer than 5 runs: no allow rule is suggested from a small sample.",
      "Fewer than 5 runs with tool data: no tool is suggested for dropping.",
      "Denied: none.",
      "Offered, never used: no runs with tool data.",
      "Proposed change: none.",
    ]);
  });

  it("test_AC08_builtin_hint", async () => {
    // Five read-only runs denying cargo: the built-in hint.
    const ro = (await k.r.call(k.c.ann, "GET", "/v1/profiles/read-only")).json.sha256 as string;
    for (let i = 0; i < 5; i++) await profRun("read-only", ro, NOW - DAY + i, { denied: [{ tool: "Bash", command: "cargo", count: 1 }], permissionDenials: { count: 1, tools: ["Bash"] } });
    k.at(NOW);
    const res = await cli(["fit", "read-only"]);
    // 5 runs, 0 tool runs: only the tool-data line, and the allow rule is still suggested.
    const lines = res.out.trimEnd().split("\n");
    expect(lines[1]).toBe("Fewer than 5 runs with tool data: no tool is suggested for dropping.");
    expect(lines).toContain("  Bash cargo  5/5 runs, 5 denials  → allow Bash(cargo *)");
    expect(lines).toContain("Offered, never used: no runs with tool data.");
    expect(res.out.trimEnd().split("\n").at(-1)).toBe(
      'Nothing was saved. read-only is built in: register a profile with "extends: read-only" and these rules (mesh profile add <new name> --file <profile.yaml>) and use it in the step.',
    );
  });

  it("test_AC08_truncated_line", async () => {
    const res = await k.r.call(k.c.ann, "GET", "/v1/profiles/ci/fit");
    const lines = formatProfileFit({ ...res.json, truncated: { denied: 6, unused: 2 } });
    // After the lists, before the proposed change.
    expect(lines[lines.indexOf("Proposed change:") - 1]).toBe("(6 more denied and 2 more unused entries not shown)");
  });

  it("test_AC08_refused_and_usage", async () => {
    const nope = await cli(["fit", "nope"]);
    expect(nope.code).toBe(1);
    expect(nope.err.trim()).toBe("no profile nope");
    const usage = await cli(["fit"]);
    expect(usage.code).toBe(2);
    expect(usage.err).toContain("mesh profile fit <name> [--days N] [--include-trial] [--json]");
    const help = await cli(["--help"]);
    expect(help.out).toContain("mesh profile fit <name>");
  });
});
