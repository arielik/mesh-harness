// RL-1 AC-03: repo presets with `{param}` placeholders (docs/specs/RL-1.md, Core `instantiate`,
// `parsePreset`). Built-in preset snapshots stay where they are (test/cli.test.ts).

import { describe, expect, it } from "vitest";
import { validatePlan } from "./dag.ts";
import { validatePolicies } from "./policy.ts";
import { BUILTIN_PRESETS, instantiate, parsePreset, presetText } from "./presets.ts";

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
    // RL-3: `audit-relay` needs params and is headless by design (its own tests below).
    // RL-6: `calibrate` needs params (agent, hash) and has `inputs` (its own tests below).
    for (const p of BUILTIN_PRESETS.filter((x) => x.name !== "audit-relay" && x.name !== "calibrate")) {
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

// RL-3 AC-19: the built-in agent-only `audit-relay` (docs/specs/RL-3.md, Built-in preset).
describe("AC-19 audit-relay", () => {
  const relay = () => {
    const p = BUILTIN_PRESETS.find((x) => x.name === "audit-relay");
    if (!p) throw new Error("audit-relay missing");
    return p;
  };
  const PARAMS = { repo: "/src/alpha", agent: "a1", validator: "v1", filer: "f1" };
  const FILE_BRIEF = "Propose an entry for each confirmed item on this run's branch, then submit a review record that sets each one accepted with its link.";

  it("test_AC19_description", () => {
    expect(relay().description).toBe("Audit by an agent, validated by an agent, filed by an agent (agent-only; a person's debrief comes with S4).");
  });

  it("test_AC19_instantiate", () => {
    const plan = inst(relay(), { repo: "/src/alpha", goal: "G", params: PARAMS });
    expect(plan.steps.map((s) => s.id)).toStrictEqual(["audit", "validate", "file"]);
    const audit = stepOf(plan, "audit");
    expect(audit).toMatchObject({ kind: "review", deps: [], repo: "/src/alpha", title: "Audit /src/alpha", agent: "a1", mode: "headless", profile: "read-only", output: "review-record", budget: { turns: 80, minutes: 60 }, inputs: ["previous"] });
    for (const k of ["when", "consumes", "may_set", "assignee"]) expect(Object.hasOwn(audit, k), `audit.${k}`).toBe(false);
    const validate = stepOf(plan, "validate");
    expect(validate).toMatchObject({ kind: "review", deps: ["audit"], repo: "/src/alpha", title: "Validate the findings", agent: "v1", mode: "headless", profile: "read-only", output: "review-record", when: { open: true }, consumes: ["open"], may_set: ["confirmed", "dismissed"], inputs: ["audit", "dispositions"] });
    const file = stepOf(plan, "file");
    expect(file).toMatchObject({ kind: "docs", deps: ["validate"], repo: "/src/alpha", title: "File the confirmed items", agent: "f1", mode: "headless", profile: "propose-via-branch", output: "review-record", when: { open: true }, consumes: ["confirmed"], may_set: ["accepted"], inputs: ["dispositions"] });
    expect(file.brief).toBe(FILE_BRIEF);
    for (const s of plan.steps) expect(Object.hasOwn(s, "assignee"), s.id).toBe(false);
    expect(plan.steps.some((s) => s.id === "debrief")).toBe(false);
  });

  it("test_AC19_policies_clean", () => {
    const plan = inst(relay(), { repo: "/src/alpha", goal: "G", params: PARAMS });
    expect(validatePlan(plan.steps)).toStrictEqual([]);
    expect(validatePolicies(plan.steps, plan.acs)).toStrictEqual([]);
  });

  it("test_AC19_missing_filer", () => {
    const { filer: _f, ...noFiler } = PARAMS;
    expect(() => inst(relay(), { repo: "/src/alpha", goal: "G", params: noFiler })).toThrow(new Error("preset audit-relay: unknown parameter {filer} in step file"));
    const { validator: _v, ...noValidator } = PARAMS;
    expect(() => inst(relay(), { repo: "/src/alpha", goal: "G", params: noValidator })).toThrow(new Error("preset audit-relay: unknown parameter {validator} in step validate"));
    // Positive control: with all three it instantiates.
    expect(() => inst(relay(), { repo: "/src/alpha", goal: "G", params: PARAMS })).not.toThrow();
  });
});

// RL-6 AC-03: the built-in `calibrate` preset (docs/specs/RL-6.md, Built-in `calibrate` preset).
describe("RL-6 AC-03 calibrate", () => {
  const cal = () => {
    const p = BUILTIN_PRESETS.find((x) => x.name === "calibrate");
    if (!p) throw new Error("calibrate missing");
    return p;
  };
  const PARAMS = { agent: "alpha/auditor", hash: "0123456789ab" };
  const DESCRIPTION = "Calibrate an agent from the dismissals of its findings (opened by the hub when an agent reaches the dismissal threshold).";
  const BRIEF =
    'Read the input "calibration" from mesh_context: the dismissed findings of alpha/auditor@0123456789ab with their evidence and reasons, and the agent\'s definition when the hub has it. Either change the agent\'s definition on this step\'s branch so such findings are no longer raised, or decide that no change is needed. Then submit a review record with no items (mesh_review): assessment "issues" with a summary of the change, or assessment "clean" with a summary starting "no change:" and the reason; then mesh_done.';

  it("test_AC03_builtin_order", () => {
    const names = BUILTIN_PRESETS.map((p) => p.name);
    // The RL-5 list with `calibrate` inserted right after `audit-relay`.
    expect(names).toStrictEqual(["sdd-split", "sdd-collapse", "audit-relay", "calibrate"]);
    expect(cal().description).toBe(DESCRIPTION);
  });

  it("test_AC03_instantiate", () => {
    const plan = inst(cal(), { repo: "alpha", params: PARAMS });
    expect(plan.steps).toHaveLength(1);
    const s = stepOf(plan, "calibrate");
    expect(s).toMatchObject({ id: "calibrate", kind: "review", repo: "alpha", output: "review-record", inputs: ["calibration"], title: "Calibrate alpha/auditor@0123456789ab" });
    expect(s.brief).toBe(BRIEF);
    expect(s.deps ?? []).toStrictEqual([]);
    for (const k of ["mode", "agent", "profile", "consumes", "may_set", "when", "assignee", "budget"]) expect(Object.hasOwn(s, k), `calibrate.${k}`).toBe(false);
  });

  it("test_AC03_validate_and_relay_unchanged", () => {
    const plan = inst(cal(), { repo: "alpha", params: PARAMS });
    expect(validatePlan(plan.steps)).toStrictEqual([]);
    expect(validatePolicies(plan.steps, plan.acs)).toStrictEqual([]);
    // audit-relay keeps its RL-3 shape (the RL-3 AC-19 tests above assert its fields).
    const relay = BUILTIN_PRESETS.find((x) => x.name === "audit-relay");
    expect(relay?.description).toBe("Audit by an agent, validated by an agent, filed by an agent (agent-only; a person's debrief comes with S4).");
    expect(relay?.plan.steps.map((x) => x.id)).toStrictEqual(["audit", "validate", "file"]);
  });
});

// RL-7 AC-15: preset parameter defaults (`params:`) and budget placeholders (docs/specs/RL-7.md,
// Preset parameter defaults and budget placeholders). `params` on a preset is read loosely.
describe("RL-7 params", () => {
  const relay = () => {
    const p = BUILTIN_PRESETS.find((x) => x.name === "audit-relay");
    if (!p) throw new Error("audit-relay missing");
    return p;
  };
  const AVF = { agent: "a", validator: "v", filer: "f" };
  const budgetOf = (params: Record<string, string>) => stepOf(inst(relay(), { repo: "alpha", goal: "G", params })).budget;
  const BAD = (field: "turns" | "minutes", value: string) => `preset audit-relay: budget.${field} in step audit must be a whole number from 1 to ${field === "turns" ? 500 : 1440}, got "${value}"`;
  const PARAMS_RULE = "params must map names (a-z, 0-9, _) to values";
  const P1 = (extra = "") => `description: P1\n${extra}steps:\n  - id: s\n    kind: implement\n    mode: headless\n    title: S\n    brief: b\n    budget: { turns: "{t}" }\n`;

  it("test_AC15_defaults", () => {
    const b = budgetOf(AVF);
    expect(b).toStrictEqual({ turns: 80, minutes: 60 });
    expect(typeof b.turns).toBe("number");
    expect(typeof b.minutes).toBe("number");
    expect((relay() as unknown as { params?: unknown }).params).toStrictEqual({ turns: "80", minutes: "60" });
  });

  it("test_AC15_explicit", () => {
    expect(budgetOf({ ...AVF, turns: "40", minutes: "20" })).toStrictEqual({ turns: 40, minutes: 20 });
  });

  it("test_AC15_bad_values", () => {
    for (const v of ["abc", "0", "501"]) expect(() => budgetOf({ ...AVF, turns: v }), v).toThrow(new Error(BAD("turns", v)));
    expect(() => budgetOf({ ...AVF, minutes: "1441" })).toThrow(new Error(BAD("minutes", "1441")));
    // Controls: the bounds are accepted.
    expect(budgetOf({ ...AVF, turns: "500", minutes: "1440" })).toStrictEqual({ turns: 500, minutes: 1440 });
    expect(budgetOf({ ...AVF, turns: "1" })).toStrictEqual({ turns: 1, minutes: 60 });
  });

  it("test_AC15_unknown_placeholder", () => {
    expect(() => inst(parsePreset("p1", P1()), { repo: "alpha", goal: "G" })).toThrow(new Error("preset p1: unknown parameter {t} in step s"));
    // Control: with a default for t it fills a number.
    const plan = inst(parsePreset("p1", P1("params:\n  t: 7\n")), { repo: "alpha", goal: "G" });
    expect(stepOf(plan, "s").budget).toStrictEqual({ turns: 7 });
  });

  it("test_AC15_parse_params", () => {
    const p = parsePreset("p1", P1("params:\n  t: 5\n")) as unknown as { params?: unknown };
    expect(p.params).toStrictEqual({ t: "5" });
    expect(() => parsePreset("p1", P1("params:\n  T: 1\n"))).toThrow(new Error(PARAMS_RULE));
    expect(() => parsePreset("p1", P1("params: [1]\n"))).toThrow(new Error(PARAMS_RULE));
  });

  it("test_AC15_round_trip", () => {
    for (const p of BUILTIN_PRESETS) expect(parsePreset(p.name, presetText(p)), p.name).toStrictEqual(p);
    const text = presetText(relay());
    expect(text).toMatch(/^params:/m);
    const at = (re: RegExp) => text.search(re);
    expect(at(/^description:/m)).toBeLessThan(at(/^params:/m));
    expect(at(/^params:/m)).toBeLessThan(at(/^steps:/m));
    // Control: a built-in without params has no `params:` line.
    const split = BUILTIN_PRESETS.find((x) => x.name === "sdd-split");
    if (!split) throw new Error("sdd-split missing");
    expect(presetText(split)).not.toMatch(/^params:/m);
  });
});
