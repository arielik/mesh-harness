// RL-5 AC-01: the roster schemas, `parseRosterKey`, `ROSTER_KEY_RULE`, `StepPolicy.agent` with roster
// keys, and `Pulse.agents` / `Goal.agents`. Written from the spec's contracts only (docs/specs/RL-5.md).
// New exports are read loosely so the file compiles before they exist; a missing export fails the
// test that needs it.

import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import * as protocol from "./index.ts";

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- new exports, read loosely
const P = protocol as any;

const sha = (s: string) => createHash("sha256").update(s, "utf8").digest("hex");
const RULE = "agent key must be <source>/<name>[@<7-64 hex>]";
const SRC = "git.example.com/team/agents";
const C1 = "c1".repeat(20);
const H1 = sha("one");
const H2 = sha("two");

const fullReport = () => ({
  repo: "git.example.com/team/alpha",
  kind: "claude",
  path: ".claude/agents/reviewer.md",
  name: "reviewer",
  hash: H1,
  description: "Reviews code",
  model: "sonnet",
  tools: ["Read"],
  rules: ["r.alpha"],
  pin: { source: SRC, commit: C1, hash: H1 },
});
const report = (i: number) => ({ repo: "git.example.com/team/alpha", kind: "claude", path: `.claude/agents/a${i}.md`, name: `a${i}`, hash: H1 });
const syncBody = (machine: Record<string, unknown>) => ({ events: [], counts: {}, sessions: [], machine: { share: "me", ...machine } });

describe("RL-5 AC-01 schemas", () => {
  it("test_AC01_rule_const", () => {
    expect(P.ROSTER_KEY_RULE).toBe(RULE);
  });

  it("test_AC01_agent_report", () => {
    const ok = P.AgentReport.safeParse(fullReport());
    expect(ok.success, JSON.stringify(ok.error?.issues)).toBe(true);
    expect(ok.data).toMatchObject(fullReport());
    // Control: exactly 100 tools parse.
    expect(P.AgentReport.safeParse({ ...fullReport(), tools: Array.from({ length: 100 }, (_, i) => `T${i}`) }).success).toBe(true);
    expect(P.AgentReport.safeParse({ ...fullReport(), hash: H1.slice(0, 63) }).success, "63 hex").toBe(false);
    expect(P.AgentReport.safeParse({ ...fullReport(), hash: H1.toUpperCase() }).success, "uppercase hex").toBe(false);
    expect(P.AgentReport.safeParse({ ...fullReport(), tools: Array.from({ length: 101 }, (_, i) => `T${i}`) }).success, "101 tools").toBe(false);
    expect(P.AgentReport.safeParse({ ...fullReport(), kind: "cursor" }).success, "kind cursor").toBe(false);
    expect(P.AgentKind.options).toStrictEqual(["claude", "opencode"]);
  });

  it("test_AC01_sync_agents_cap", () => {
    const two = P.SyncRequest.safeParse(syncBody({ agents: Array.from({ length: 2000 }, (_, i) => report(i)) }));
    expect(two.success, JSON.stringify(two.error?.issues?.slice(0, 2))).toBe(true);
    expect(two.data.machine.agents).toHaveLength(2000);
    expect(P.SyncRequest.safeParse(syncBody({ agents: Array.from({ length: 2001 }, (_, i) => report(i)) })).success).toBe(false);
    // Absent stays absent; [] stays [].
    const none = P.SyncRequest.parse(syncBody({}));
    expect("agents" in none.machine).toBe(false);
    expect(P.SyncRequest.parse(syncBody({ agents: [] })).machine.agents).toStrictEqual([]);
  });

  it("test_AC01_agents_lock", () => {
    const entry = { name: "rev", source: SRC, commit: C1, hash: H1 };
    expect(P.AgentsLock.safeParse({ version: 1, agents: [entry] }).success).toBe(true);
    expect(P.AgentsLock.safeParse({ version: 1, agents: [] }).success).toBe(true);
    expect(P.AgentsLock.safeParse({ version: 2, agents: [entry] }).success).toBe(false);
    expect(P.AgentsLock.safeParse({ version: 1, agents: [{ ...entry, x: 1 }] }).success).toBe(false);
  });

  it("test_AC01_catalog_push", () => {
    const def = (n: number, path = "agents/rev.md") => ({ path, text: "x".repeat(n) });
    expect(P.CatalogPush.safeParse({ repo: SRC, commit: C1, defs: [def(100_000)] }).success).toBe(true);
    expect(P.CatalogPush.safeParse({ repo: SRC, commit: C1.slice(0, 39), defs: [def(1)] }).success, "39 hex").toBe(false);
    expect(P.CatalogPush.safeParse({ repo: SRC, commit: C1, defs: [def(100_001)] }).success, "100 001 chars").toBe(false);
    expect(P.CatalogPush.safeParse({ repo: SRC, commit: C1, defs: Array.from({ length: 2001 }, (_, i) => def(1, `agents/a${i}.md`)) }).success, "2001 defs").toBe(false);
    expect(P.CatalogPush.safeParse({ repo: SRC, commit: C1, defs: [def(1)], extra: 1 }).success, "extra key").toBe(false);
    // The summed text cap is a hub check, not part of the schema.
    const big = P.CatalogPush.safeParse({ repo: SRC, commit: C1, defs: Array.from({ length: 100 }, (_, i) => def(80_001, `agents/a${i}.md`)) });
    expect(big.success).toBe(true);
  });

  it("test_AC01_catalog_source_save", () => {
    expect(P.CatalogSourceSave.safeParse({ repo: SRC, folder: "agents" }).success).toBe(true);
    expect(P.CatalogSourceSave.safeParse({ repo: SRC, folder: "agents", calibrator: "carol" }).success).toBe(true);
    expect(P.CatalogSourceSave.safeParse({ repo: SRC, folder: "agents", x: 1 }).success).toBe(false);
    expect(P.CatalogSourceSave.safeParse({ repo: "", folder: "agents" }).success).toBe(false);
  });

  it("test_AC01_step_policy_agent", () => {
    for (const agent of ["auditor", "agents/reviewer", "git.example.com/team/agents/reviewer@1a2b3c4"]) {
      const r = P.StepPolicy.safeParse({ mode: "headless", agent });
      expect(r.success, `${agent}: ${JSON.stringify(r.error?.issues)}`).toBe(true);
      expect(r.data.agent).toBe(agent);
    }
    const bad = P.StepPolicy.safeParse({ mode: "headless", agent: "a/b@xyz" });
    expect(bad.success).toBe(false);
    expect(bad.error.issues.map((i: { message: string }) => i.message)).toContain(RULE);
    const name = P.StepPolicy.safeParse({ mode: "headless", agent: "-x" });
    expect(name.success).toBe(false);
    // The RL-1 name rule, not the roster key rule.
    expect(name.error.issues.map((i: { message: string }) => i.message)).not.toContain(RULE);
  });

  it("test_AC01_parse_roster_key", () => {
    expect(P.parseRosterKey("Example.com/Team/Agents/rev@abcdef1")).toStrictEqual({ source: "example.com/team/agents", name: "rev", ref: "abcdef1" });
    const plain = P.parseRosterKey("agents/rev");
    expect(plain).toStrictEqual({ source: "agents", name: "rev" });
    expect("ref" in plain).toBe(false);
    expect(P.parseRosterKey("agents/Rev")).toStrictEqual({ source: "agents", name: "Rev" });
    for (const bad of ["rev", "a/", "a/b@abc", "a/b@abcdef", `a/b@${"f".repeat(65)}`, "a/b@ABCDEF1"]) expect(P.parseRosterKey(bad), bad).toBeUndefined();
    expect(P.parseRosterKey(`a/b@${"f".repeat(64)}`)).toStrictEqual({ source: "a", name: "b", ref: "f".repeat(64) });
    // Length: ROSTER_KEY_MAX (330) parses, 331 does not.
    const key = (n: number) => `${"s".repeat(n - 4)}/rev`;
    expect(key(330)).toHaveLength(330);
    expect(P.parseRosterKey(key(330))).toStrictEqual({ source: "s".repeat(326), name: "rev" });
    expect(key(331)).toHaveLength(331);
    expect(P.parseRosterKey(key(331))).toBeUndefined();
    // A full-id key: a 200-character source id, a 64-character name and a 64-hex hash (330 in all).
    const id = `git.example.com/${"t".repeat(200 - 16)}`;
    expect(id).toHaveLength(200);
    const full = `${id}/${"n".repeat(64)}@${"a".repeat(64)}`;
    expect(full).toHaveLength(330);
    expect(P.parseRosterKey(full)).toStrictEqual({ source: id, name: "n".repeat(64), ref: "a".repeat(64) });
  });

  it("test_AC01_pulse_goal_agents", () => {
    const T0 = 1_762_000_000_000;
    const pulse = {
      id: "p-1",
      owner: "ada",
      title: "weekly on app",
      when: { every: "7d", anchor: T0 },
      preset: { name: "weekly", text: "steps: []\n", sha256: "a".repeat(64) },
      params: { repo: "example/app" },
      profiles: {},
      topics: [],
      target: {},
      windowMs: 4 * 3_600_000,
      overlap: "skip",
      maxGoalAgeMs: 14 * 86_400_000,
      missed: "record",
      enabled: true,
      nextAt: T0 + 7 * 86_400_000,
      version: 1,
      createdAt: T0,
      updatedAt: T0,
    };
    const p = P.Pulse.safeParse(pulse);
    expect(p.success, JSON.stringify(p.error?.issues)).toBe(true);
    expect(p.data.agents).toStrictEqual({});
    const def = { key: "agents/rev", source: SRC, name: "rev", hash: H1, commit: C1 };
    expect(P.AgentDef.safeParse(def).success).toBe(true);
    expect(P.AgentDef.safeParse({ ...def, x: 1 }).success).toBe(false);
    const withAgents = P.Pulse.parse({ ...pulse, agents: { "agents/rev": def } });
    expect(withAgents.agents).toStrictEqual({ "agents/rev": def });
    const goal = { id: "G1", title: "g", ownerId: "ada", state: "backlog", priority: 0, createdAt: T0, updatedAt: T0 };
    const g = P.Goal.parse(goal);
    expect("agents" in g).toBe(false);
    expect(P.Goal.parse({ ...goal, agents: { "agents/rev": { ...def, hash: H2 } } }).agents["agents/rev"].hash).toBe(H2);
  });
});
