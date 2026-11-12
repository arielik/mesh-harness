// RL-1 AC-03: repo presets with `{param}` placeholders (docs/specs/RL-1.md, Core `instantiate`,
// `parsePreset`). Built-in preset snapshots stay where they are (test/cli.test.ts).

import { describe, expect, it } from "vitest";
import { BUILTIN_PRESETS, instantiate, parsePreset } from "./presets.ts";

// `params` is new in RL-1: passed loosely so the file compiles before it exists.
type Opts = Parameters<typeof instantiate>[1] & { params?: Record<string, string> };
const inst = (p: ReturnType<typeof parsePreset>, o: Opts) => instantiate(p, o as Parameters<typeof instantiate>[1]);

const YAML = `description: Headless audit
steps:
  - id: audit
    kind: implement
    mode: headless
    agent: "{agent}"
    profile: "{profile}"
    title: "Audit with {agent}"
    brief: 'Use {profile} on {repo} for {goal}. Example {missing} and {"a": 1}'
    forbid: ["{agent}-secrets"]
`;
const TWO = `description: Two
steps:
  - { id: audit, kind: implement, mode: headless, agent: "{agent}", profile: "{profile}", title: A, brief: b }
  - { id: second, kind: implement, mode: headless, agent: "{agent}", profile: "{profile}", title: B, brief: b }
`;

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- new PlanStep fields, read loosely
const stepOf = (plan: { steps: any[] }, id = "audit") => plan.steps.find((s) => s.id === id);

describe("AC-03 presets with placeholders", () => {
  it("test_AC03_parse_placeholders", () => {
    const p = parsePreset("p", YAML);
    expect(stepOf(p.plan).agent).toBe("{agent}");
    expect(stepOf(p.plan).profile).toBe("{profile}");
    expect(stepOf(p.plan).mode).toBe("headless");
  });

  it("test_AC03_instantiate_params", () => {
    const plan = inst(parsePreset("p", YAML), { repo: "r", goal: "G1", params: { agent: "auditor", profile: "read-only" } });
    const s = stepOf(plan);
    expect(s.agent).toBe("auditor");
    expect(s.profile).toBe("read-only");
    expect(s.mode).toBe("headless");
    expect(s.title).toBe("Audit with auditor");
    expect(s.brief).toBe('Use read-only on r for G1. Example {missing} and {"a": 1}');
    expect(s.forbid).toStrictEqual(["auditor-secrets"]);
    expect(s.repo).toBe("r");
  });

  it("test_AC03_goal_default", () => {
    const plan = inst(parsePreset("p", YAML), { repo: "r", params: { agent: "auditor", profile: "read-only" } });
    expect(stepOf(plan).brief).toContain("for this goal");
  });

  it("test_AC03_missing_param_throws", () => {
    const p = parsePreset("p", YAML);
    expect(() => inst(p, { repo: "r", goal: "G1", params: { agent: "auditor" } })).toThrow(new Error("preset p: unknown parameter {profile} in step audit"));
    // Positive control: the same preset with both params instantiates.
    expect(() => inst(p, { repo: "r", goal: "G1", params: { agent: "auditor", profile: "read-only" } })).not.toThrow();
  });

  it("test_AC03_first_unknown_reported", () => {
    const p = parsePreset("p", TWO);
    let msg = "";
    try {
      inst(p, { repo: "r", goal: "G1" });
    } catch (e) {
      msg = (e as Error).message;
    }
    expect(msg).toMatch(/^preset p: unknown parameter \{(agent|profile)\} in step audit$/);
  });

  it("test_AC03_repo_not_overridden", () => {
    const plan = inst(parsePreset("p", YAML), { repo: "r", goal: "G1", params: { repo: "x", goal: "y", agent: "a1", profile: "read-only" } });
    expect(stepOf(plan).brief).toContain("on r for G1");
    expect(stepOf(plan).repo).toBe("r");
    expect(stepOf(plan).agent).toBe("a1");
  });

  it("test_AC03_invalid_after_subst", () => {
    const p = parsePreset("p", YAML);
    expect(() => inst(p, { repo: "r", goal: "G1", params: { agent: "bad agent!", profile: "read-only" } })).toThrow();
    expect(() => inst(p, { repo: "r", goal: "G1", params: { agent: "auditor", profile: "Not A Profile" } })).toThrow();
  });

  it("test_AC03_builtins_unchanged", () => {
    // The built-ins instantiate as before: no throw, no headless field appears, every placeholder filled.
    for (const p of BUILTIN_PRESETS) {
      const a = instantiate(p, { repo: "frr", goal: "G7" });
      const b = inst(p, { repo: "frr", goal: "G7", params: { unused: "z" } });
      expect(b, p.name).toStrictEqual(a);
      for (const s of a.steps) {
        for (const k of ["mode", "agent", "profile", "budget", "inputs"]) expect(k in s, `${p.name}/${s.id}.${k}`).toBe(false);
        expect(s.brief.includes("{goal}") || s.brief.includes("{repo}"), s.id).toBe(false);
      }
    }
  });
});
