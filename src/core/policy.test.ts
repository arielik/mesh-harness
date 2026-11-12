import { describe, expect, it } from "vitest";
import type { Message, PlanAc, PlanStep, Round, Session, Step, StepContext, StepPolicy } from "../protocol/index.ts";
import { materialize, reopen } from "./dag.ts";
import { agentContext, blindConflict, blindSeparated, judgeDone, reopenText, staleRounds, validatePolicies } from "./policy.ts";
import { BUILTIN_PRESETS, instantiate, parsePreset, presetText, presetWarnings } from "./presets.ts";
import { MESSAGE_STAGES, messageStage, partition, SESSION_STAGES, sessionStage, stageSummary, STEP_STAGES, stepStage } from "./stages.ts";
import { validatePlan } from "./dag.ts";

const step = (id: string, policy?: StepPolicy, over: Partial<Step> = {}): Step => ({
  id: `G1.${id}`,
  goal: "G1",
  planVersion: 1,
  kind: "implement",
  repo: "r",
  title: id,
  brief: "b",
  deps: [],
  state: "claimed",
  fixCycles: 0,
  updatedAt: 0,
  holderUser: "alice",
  ...(policy ? { policy } : {}),
  ...over,
});
const round = (over: Partial<Round>): Round => ({ n: 1, user: "bob", finishedAt: 1, outcome: "done", ...over });
const ACS: PlanAc[] = [
  { id: "AC-01", text: "a" },
  { id: "AC-02", text: "b" },
];

describe("judgeDone", () => {
  it("passes a step without a policy straight through", () => {
    expect(judgeDone(step("a"), round({}), [], undefined)).toEqual({ action: "done" });
    expect(judgeDone(step("a"), round({ outcome: "fail" }), [], undefined)).toEqual({ action: "fail" });
    expect(judgeDone(step("a"), round({ outcome: "fail" }), ["b"], undefined)).toMatchObject({ action: "reopen", reopen: ["G1.b"] });
  });

  it("reconcile: rejects once when criteria are missing, then parks", () => {
    const s = step("tp", { must_cover: "all" });
    expect(judgeDone(s, round({ acsAddressed: ["AC-01", "AC-02"] }), [], ACS)).toEqual({ action: "done" });
    const first = judgeDone(s, round({ acsAddressed: ["AC-01"] }), [], ACS);
    expect(first).toMatchObject({ action: "reject", missing: ["AC-02"] });
    const again = judgeDone({ ...s, rounds: [round({ reconcile: { missing: ["AC-02"] }, outcome: "fail" })] }, round({ n: 2, acsAddressed: ["AC-01"] }), [], ACS);
    expect(again).toMatchObject({ action: "park" });
  });

  it("a review's verdict reopens its target; the cap and churn park", () => {
    const r = step("review", { target: "spec", max_rounds: 2, park_on: ["churn"] });
    expect(judgeDone(r, round({ verdict: "approved" }), [], undefined)).toEqual({ action: "done" });
    expect(judgeDone(r, round({ verdict: "changes_requested", findings: { new: 3, repeat: 0, regression: 1 } }), [], undefined)).toMatchObject({ action: "reopen", reopen: ["G1.spec"] });
    expect(judgeDone(r, round({ verdict: "changes_requested", findings: { new: 1, repeat: 0, regression: 2 } }), [], undefined)).toMatchObject({ action: "park", reason: expect.stringMatching(/^churn/) });
    expect(judgeDone({ ...r, rounds: [round({ verdict: "changes_requested", outcome: "fail" })] }, round({ n: 2, verdict: "changes_requested" }), [], undefined)).toMatchObject({ action: "park", reason: expect.stringMatching(/max_rounds 2/) });
  });

  it("routes failures by bucket, parks infra and stalls", () => {
    const v = step("verify", { route: { "impl-bug": "develop", "test-bug": "write-tests", infra: "park" }, park_on: ["stall"] });
    expect(judgeDone(v, round({ verdict: "fail", failures: [{ bucket: "impl-bug", ac: "AC-02" }, { bucket: "test-bug" }] }), [], undefined)).toMatchObject({ action: "reopen", reopen: ["G1.develop", "G1.write-tests"] });
    expect(judgeDone(v, round({ verdict: "fail", failures: [{ bucket: "infra" }] }), [], undefined)).toMatchObject({ action: "park" });
    expect(judgeDone(v, round({ verdict: "fail", failures: [{ bucket: "unclear" }] }), [], undefined)).toEqual({ action: "fail" });
    const prior = [round({ outcome: "fail", acs: { "AC-01": "met" } }), round({ n: 2, outcome: "fail", acs: { "AC-01": "met" } })];
    expect(judgeDone({ ...v, rounds: prior }, round({ n: 3, verdict: "fail", acs: { "AC-01": "met" }, failures: [{ bucket: "impl-bug" }] }), [], undefined)).toMatchObject({ action: "park", reason: expect.stringMatching(/^stall/) });
    expect(staleRounds([round({ acs: { a: "met" } }), round({ acs: { a: "met", b: "met" } }), round({ acs: { a: "met" } })])).toBe(1);
  });

  it("tells a reopened step the bucket, criterion and assertion, never the tester's prose", () => {
    const v = step("verify", { blind: ["impl-plan"] });
    expect(reopenText(v, round({ failures: [{ bucket: "impl-bug", ac: "AC-02", assertion: "expected 2 routes" }] }), "the tester's long summary")).toBe("impl-bug AC-02: expected 2 routes");
    expect(reopenText(v, round({ verdict: "fail" }), "secret")).not.toContain("secret");
    expect(reopenText(step("x"), round({}), "plain")).toBe("plain");
  });
});

describe("blind steps", () => {
  const dev = step("develop", { blind: ["write-tests"] }, { rounds: [round({ user: "alice", sid: "s1" })], state: "done", holderUser: undefined });
  const tests = step("write-tests", { blind: ["develop"] }, { state: "ready", holderUser: undefined });
  const verify = step("verify", undefined, { state: "ready", holderUser: undefined });
  const all = [dev, tests, verify];

  it("refuses whoever worked on the other side (either side may declare it)", () => {
    expect(blindConflict(tests, all, { userId: "alice", sid: "s9" }, "person")).toMatch(/blind to G1.develop/);
    expect(blindConflict(tests, all, { userId: "bob", sid: "s2" }, "person")).toBeUndefined();
    expect(blindConflict(verify, all, { userId: "alice" }, "person")).toBeUndefined();
    // Solo: the same person may play both sides, but never from the same session.
    expect(blindConflict(tests, all, { userId: "alice", sid: "s9" }, "session")).toBeUndefined();
    expect(blindConflict(tests, all, { userId: "alice", sid: "s1" }, "session")).toMatch(/this session/);
    const oneSided = step("write-tests", undefined, { state: "ready", holderUser: undefined });
    expect(blindConflict(oneSided, [dev, oneSided], { userId: "alice" }, "person")).toMatch(/blind/);
  });

  it("records whether the sides were kept apart", () => {
    const done = { ...tests, rounds: [round({ user: "bob" })] };
    expect(blindSeparated(done, [dev, done])).toEqual({ steps: ["develop"], separated: true });
    expect(blindSeparated({ ...done, rounds: [round({ user: "alice" })] }, [dev, done])).toEqual({ steps: ["develop"], separated: false });
    expect(blindSeparated(verify, all)).toBeUndefined();
  });

  it("hides blinded and unread dependencies from the agent", () => {
    const comb = step("verify", { blind: ["develop"], reads: ["combine"] }, { deps: ["G1.develop", "G1.combine", "G1.spec"] });
    const ctx: StepContext = {
      step: comb,
      goal: { id: "G1", title: "t", ownerId: "a", state: "in_progress", priority: 3, createdAt: 0, updatedAt: 0 },
      deps: [
        { id: "G1.develop", title: "d", state: "done", summary: "uses a hash map", branch: "impl/x" },
        { id: "G1.combine", title: "c", state: "done", summary: "merged", branch: "impl/x" },
        { id: "G1.spec", title: "s", state: "done", summary: "spec text" },
      ],
      notes: [],
      openQuestions: [],
    };
    const out = agentContext(ctx, [comb, dev]);
    expect(out.deps.map((d) => [d.id, d.summary, d.branch])).toEqual([
      ["G1.develop", "(hidden: this step is blind to it)", undefined],
      ["G1.combine", "merged", "impl/x"],
      ["G1.spec", "(hidden: this step is blind to it)", undefined],
    ]);
    expect(agentContext({ ...ctx, step: step("x") }, [])).toEqual({ ...ctx, step: step("x") });
  });
});

describe("plan rules", () => {
  it("validates references and needs criteria for must_cover", () => {
    const p = (x: object) => ({ id: "a", repo: "r", kind: "verify" as const, title: "t", brief: "b", deps: [], ...x });
    expect(validatePolicies([p({ blind: ["nope"] })], undefined)).toEqual(['step "a": blind names "nope", which is not a step of this plan']);
    expect(validatePolicies([p({ id: "b" }), p({ target: "b" })], undefined)).toContain('step "a": target "b" must also be in deps (the review waits for its fix)');
    expect(validatePolicies([p({ must_cover: "all" })], undefined)).toEqual(['step "a": must_cover needs the plan\'s acs']);
    expect(validatePolicies([p({ acs: ["AC-09"] })], ACS)).toEqual(['step "a": acceptance criterion AC-09 is not in the plan\'s acs']);
    expect(validatePolicies([p({ kind: "gate", route: { infra: "park" } })], undefined)[0]).toMatch(/gate step/);
  });

  it("carries policies into steps and reruns done work downstream of a reopen", () => {
    const steps = materialize("G1", 1, [
      { id: "a", repo: "r", kind: "implement", title: "a", brief: "b", deps: [], role: "developer", blind: ["c"] },
      { id: "b", repo: "r", kind: "merge", title: "b", brief: "b", deps: ["a"] },
      { id: "c", repo: "r", kind: "verify", title: "c", brief: "b", deps: ["b"] },
      { id: "d", repo: "r", kind: "docs", title: "d", brief: "b", deps: [] },
    ], [], 0).upserts;
    expect(steps[0]?.policy).toEqual({ role: "developer", blind: ["c"] });
    expect(steps[1]?.policy).toBeUndefined();
    const done = steps.map((s) => ({ ...s, state: s.id === "G1.c" ? ("blocked" as const) : ("done" as const) }));
    const ch = reopen(done, ["G1.a"], 5);
    expect(ch.map((s) => [s.id, s.state])).toEqual([
      ["G1.a", "ready"],
      ["G1.b", "blocked"],
    ]);
  });
});

describe("templates", () => {
  it("instantiate into valid plans, with or without criteria", () => {
    for (const p of BUILTIN_PRESETS) {
      const withAcs = instantiate(p, { repo: "frr", goal: "G7", acs: ACS });
      expect(validatePlan(withAcs.steps), p.name).toEqual([]);
      expect(validatePolicies(withAcs.steps, withAcs.acs), p.name).toEqual([]);
      expect(withAcs.steps.every((s) => s.repo === "frr" && !s.brief.includes("{goal}"))).toBe(true);
      const bare = instantiate(p, { repo: "frr" });
      expect(validatePolicies(bare.steps, bare.acs), p.name).toEqual([]);
      expect(bare.steps.some((s) => s.must_cover)).toBe(false);
    }
  });

  it("round-trip as text and warn (only) where a plan departs from them", () => {
    const split = BUILTIN_PRESETS.find((p) => p.name === "sdd-split");
    if (!split) throw new Error("sdd-split missing");
    const back = parsePreset("sdd-split", presetText(split));
    expect(back.plan.steps.map((s) => [s.id, s.kind, s.blind])).toEqual(split.plan.steps.map((s) => [s.id, s.kind, s.blind]));
    const plan = instantiate(split, { repo: "r", acs: ACS }).steps.filter((s) => s.id !== "diff-review").map((s) => (s.id === "write-tests" ? { ...s, blind: undefined } : s));
    expect(presetWarnings(split, plan)).toEqual(['template sdd-split: step "write-tests" changes blind', 'template sdd-split: step "diff-review" (review) is missing']);
  });
});

describe("stage table (owner decision 10)", () => {
  const rand = (n: number) => Math.floor(Math.random() * n);
  const pick = <T>(xs: readonly T[]) => xs[rand(xs.length)] as T;

  it("puts every item in exactly one stage and counts are list lengths (random states)", () => {
    for (let i = 0; i < 200; i++) {
      const steps = Array.from({ length: rand(30) }, (_, j) =>
        step(`s${j}`, undefined, { state: pick(["blocked", "ready", "claimed", "paused", "done", "failed", "parked", "dropped"] as const), kind: pick(["implement", "gate", "verify", "review"] as const) }),
      );
      const parts = partition(steps, stepStage, STEP_STAGES);
      expect(parts.map((p) => p.stage)).toEqual([...STEP_STAGES]);
      expect(parts.reduce((n, p) => n + p.items.length, 0)).toBe(steps.length);
      expect(new Set(parts.flatMap((p) => p.items.map((s) => s.id))).size).toBe(steps.length);
      const summary = stageSummary(steps, stepStage, STEP_STAGES);
      expect(summary.split(" · ").filter(Boolean).reduce((n, x) => n + Number(x.split(" ")[0]), 0)).toBe(steps.length);

      const sessions = Array.from({ length: rand(20) }, (_, j) => ({ sid: `x${j}`, state: pick(["working", "needs_you", "idle", "stalled", "ended"] as const), quiet: Math.random() < 0.3 }) as Session);
      const sp = partition(sessions, sessionStage, SESSION_STAGES);
      expect(sp.reduce((n, p) => n + p.items.length, 0)).toBe(sessions.length);

      const messages = Array.from({ length: rand(10) }, (_, j) => ({ id: j, sid: "x", text: "t", state: pick(["pending", "delivered", "failed"] as const), createdAt: 0 }) as Message);
      expect(partition(messages, messageStage, MESSAGE_STAGES).reduce((n, p) => n + p.items.length, 0)).toBe(messages.length);
    }
  });

  it("sends parked, failed and waiting gates to a person", () => {
    expect(stepStage(step("a", undefined, { state: "parked" }))).toBe("needs a person");
    expect(stepStage(step("a", undefined, { state: "ready", kind: "gate" }))).toBe("needs a person");
    expect(stepStage(step("a", undefined, { state: "ready" }))).toBe("ready");
  });
});

// RL-1 AC-02: validatePolicies on the headless fields (docs/specs/RL-1.md). Steps are passed as raw
// objects so the validator sees the fields whatever the schema does with them.
describe("headless policy", () => {
  const ps = (id: string, over: Record<string, unknown> = {}): PlanStep =>
    ({ id, repo: "r", kind: "implement", title: id, brief: "b", deps: [], ...over }) as unknown as PlanStep;
  const NEED = 'step "s": profile, budget and agent need mode: headless';

  it("test_AC02_gate_not_headless", () => {
    const errs = validatePolicies([ps("g", { kind: "gate", mode: "headless" })], undefined);
    expect(errs).toContain('step "g": a gate step can\'t be headless');
    expect(errs.filter((e) => e.includes("headless"))).toHaveLength(1);
  });

  it.each([
    ["profile", "read-only"],
    ["budget", { turns: 3 }],
    ["agent", "auditor"],
  ] as const)("test_AC02_needs_headless %s", (key, value) => {
    expect(validatePolicies([ps("s", { [key]: value })], undefined)).toStrictEqual([NEED]);
    expect(validatePolicies([ps("s", { [key]: value, mode: "interactive" })], undefined)).toStrictEqual([NEED]);
    // All three at once: still one error.
    expect(validatePolicies([ps("s", { profile: "read-only", budget: { turns: 3 }, agent: "auditor" })], undefined)).toStrictEqual([NEED]);
    // Positive control: with mode headless, no error.
    expect(validatePolicies([ps("s", { [key]: value, mode: "headless" })], undefined)).toStrictEqual([]);
  });

  it("test_AC02_inputs_unknown", () => {
    expect(validatePolicies([ps("s", { mode: "headless", inputs: ["nope"] })], undefined)).toStrictEqual(['step "s": inputs names "nope", which is not a step of this plan']);
  });

  it("test_AC02_inputs_blind_both_sides", () => {
    const BLIND = 'step "s": inputs names "develop", which it is blind to';
    const a = validatePolicies([ps("develop"), ps("s", { mode: "headless", blind: ["develop"], inputs: ["develop"] })], undefined);
    expect(a).toContain(BLIND);
    const b = validatePolicies([ps("develop", { blind: ["s"] }), ps("s", { mode: "headless", inputs: ["develop"] })], undefined);
    expect(b).toContain(BLIND);
  });

  it("test_AC02_keywords", () => {
    const kw = { mode: "headless", inputs: ["previous", "dispositions", "artifacts"] };
    expect(validatePolicies([ps("s", kw)], undefined)).toStrictEqual([]);
    // A step named `artifacts` that s is blind to: the keyword still wins, so no "blind to" error.
    expect(validatePolicies([ps("artifacts"), ps("s", { ...kw, blind: ["artifacts"] })], undefined)).toStrictEqual([]);
    // Positive control: the same plan naming a real step it is blind to is refused.
    expect(validatePolicies([ps("develop"), ps("s", { mode: "headless", blind: ["develop"], inputs: ["develop"] })], undefined)).toContain('step "s": inputs names "develop", which it is blind to');
  });

  it("test_AC02_valid_control", () => {
    const steps = [
      ps("develop"),
      ps("s", { mode: "headless", agent: "auditor", profile: "read-only", budget: { turns: 5, minutes: 10, usd: 1 }, inputs: ["develop", "artifacts"], deps: ["develop"] }),
    ];
    expect(validatePolicies(steps, undefined)).toStrictEqual([]);
  });
});
