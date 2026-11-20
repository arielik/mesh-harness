// RL-15 unit tests (docs/specs/RL-15.md): schemas (AC-01), the preset `debrief:` block and the policy
// checks (AC-02), and the SLA state of a debrief step, including a new cycle (AC-07).

import { describe, expect, it } from "vitest";
import { DispositionVia, PulseCreate, PulseSlot, Pulse, StepPolicy, type Plan, type Step } from "../protocol/index.ts";
import { validatePolicies } from "./policy.ts";
import { instantiate, parsePreset, presetText } from "./presets.ts";
import { slaState } from "./sla.ts";

const sha = "0".repeat(64);
const create = (o: Record<string, unknown> = {}) => ({ preset: { name: "p", text: "x", sha256: sha }, params: { repo: "r" }, when: { every: "1d" }, ...o });

describe("RL-15 AC-01 schemas", () => {
  it("test_AC01_schemas", () => {
    expect(PulseCreate.parse(create()).overlap).toBe("skip");
    expect(PulseCreate.parse(create({ overlap: "queue" })).overlap).toBe("queue");
    expect(PulseCreate.parse(create({ overlap: "supersede" })).overlap).toBe("supersede");
    expect(PulseCreate.safeParse(create({ overlap: "later" })).success).toBe(false);
    // A 0.1.32 slot and pulse (no new fields) parse.
    const slot = { pulse: "p-1", slot: "2026-11-16T09:00:00.000Z", at: 1, state: "fired", goal: "G1", tried: [], decidedAt: 1 };
    expect(PulseSlot.parse(slot)).toStrictEqual(slot);
    expect(PulseSlot.parse({ ...slot, state: "queued", queued: true, running: "G1" }).state).toBe("queued");
    const pulse = { id: "p-1", owner: "ann", title: "t", when: { every: "1d", anchor: 0 }, preset: { name: "p", text: "x", sha256: sha }, params: {}, profiles: {}, topics: [], target: {}, windowMs: 1, overlap: "skip", maxGoalAgeMs: 1, missed: "record", enabled: true, version: 1, createdAt: 1, updatedAt: 1 };
    expect(Pulse.parse(pulse).overlap).toBe("skip");
    const bad = StepPolicy.safeParse({ auto_accept: ["S2"] });
    expect(bad.error?.issues.map((i) => i.message)).toStrictEqual(["auto_accept takes S3 and S4 only (S1 and S2 always wait for a person)"]);
    expect(StepPolicy.safeParse({ sla: "30m" }).error?.issues.map((i) => i.message)).toStrictEqual(["sla is 1h to 30d"]);
    expect(StepPolicy.safeParse({ sla: "31d" }).success).toBe(false);
    expect(StepPolicy.safeParse({ sla: "48h", auto_accept: ["S3", "S4"] }).success).toBe(true);
    expect(DispositionVia.parse("auto-accept")).toBe("auto-accept");
  });
});

const PRESET = `description: d
debrief:
  sla: 48h
  auto_accept: [S3, S4]
steps:
  - { id: audit, kind: review, mode: headless, agent: a, output: review-record, title: A, brief: a }
  - { id: debrief, kind: review, deps: [audit], mode: debrief, output: review-record, consumes: [open, confirmed], may_set: [accepted], title: D, brief: d }
  - { id: own, kind: review, deps: [audit], mode: debrief, output: review-record, consumes: [open, confirmed], may_set: [accepted], sla: 2h, title: O, brief: o }
`;

describe("RL-15 AC-02 presets and policies", () => {
  it("test_AC02_debrief_block", () => {
    const p = parsePreset("x", PRESET);
    expect(p.debrief).toStrictEqual({ sla: "48h", auto_accept: ["S3", "S4"] });
    const plan = instantiate(p, { repo: "r" });
    const by = new Map(plan.steps.map((s) => [s.id, s]));
    expect(by.get("debrief")?.sla).toBe("48h");
    expect(by.get("debrief")?.auto_accept).toStrictEqual(["S3", "S4"]);
    expect(by.get("own")?.sla).toBe("2h");
    expect(by.get("own")?.auto_accept).toStrictEqual(["S3", "S4"]);
    expect(by.get("audit")?.sla).toBeUndefined();
    expect(parsePreset("x", presetText(p)).debrief).toStrictEqual(p.debrief);
    // Without the block: no debrief key, and the rendering has none.
    const plain = parsePreset("x", PRESET.replace(/debrief:\n {2}sla: 48h\n {2}auto_accept: \[S3, S4\]\n/, ""));
    expect(plain.debrief).toBeUndefined();
    expect(presetText(plain)).not.toContain("debrief:\n");
    expect(() => parsePreset("x", "debrief: { sla: 1m }\nsteps: []\n")).toThrow();
    expect(() => parsePreset("x", "debrief: { other: 1 }\nsteps: []\n")).toThrow();
  });

  it("test_AC02_policy_errors", () => {
    const base = { repo: "r", deps: [], title: "t", brief: "b" };
    const audit = { ...base, id: "audit", kind: "review", mode: "headless", agent: "a", output: "review-record" } as const;
    const steps = [
      audit,
      { ...base, id: "h", kind: "review", mode: "headless", agent: "a", sla: "2h", auto_accept: ["S3"] },
      { ...base, id: "d1", kind: "review", deps: ["audit"], mode: "debrief", output: "review-record", may_set: ["dismissed"], consumes: ["open"], auto_accept: ["S3"] },
    ];
    const errors = validatePolicies(steps as never, undefined);
    expect(errors).toContain('step "h": sla needs mode: debrief');
    expect(errors).toContain('step "h": auto_accept needs mode: debrief');
    expect(errors).toContain('step "d1": auto_accept needs sla');
    expect(errors).toContain('step "d1": auto_accept needs accepted in may_set');
    expect(errors).toContain('step "d1": auto_accept needs confirmed in consumes');
    // The debrief default consumes (open, confirmed) counts.
    const ok = [audit, { ...base, id: "d2", kind: "review", deps: ["audit"], mode: "debrief", output: "review-record", may_set: ["accepted"], sla: "2h", auto_accept: ["S4"] }];
    expect(validatePolicies(ok as never, undefined)).toStrictEqual([]);
  });
});

const H = 3_600_000;
function step(o: Partial<Step>): Step {
  return { id: "G1.d", goal: "G1", planVersion: 1, kind: "review", repo: "r", title: "D", brief: "d", deps: ["G1.v"], state: "ready", fixCycles: 0, updatedAt: 0, policy: { mode: "debrief", sla: "2h" }, ...o } as Step;
}
const dep = (finishedAt: number, extra: { finishedAt: number }[] = []): Step =>
  ({ ...step({ id: "G1.v", deps: [], state: "done", policy: { mode: "headless" } }), rounds: [{ n: 1, outcome: "done", startedAt: 0, finishedAt }, ...extra.map((r, i) => ({ n: i + 2, outcome: "done", startedAt: 0, ...r }))] }) as unknown as Step;

describe("RL-15 AC-07 slaState", () => {
  it("test_AC07_sla_state_and_new_cycle", () => {
    const plans: Plan[] = [];
    const d = step({});
    const steps = new Map([[d.id, d], ["G1.v", dep(10 * H)]]);
    expect(slaState(d, steps, plans, 12 * H - 1)).toMatchObject({ since: 10 * H, dueAt: 12 * H, escalateAt: 14 * H, breached: false, escalated: false, slaMs: 2 * H });
    expect(slaState(d, steps, plans, 12 * H)?.breached).toBe(true);
    expect(slaState(d, steps, plans, 14 * H)?.escalated).toBe(true);
    // A new cycle (the dep done again later) restarts the clock.
    const again = new Map([[d.id, d], ["G1.v", dep(10 * H, [{ finishedAt: 20 * H }])]]);
    expect(slaState(d, again, plans, 21 * H)).toMatchObject({ since: 20 * H, breached: false });
    // No sla, not open, or not a debrief: none.
    expect(slaState(step({ policy: { mode: "debrief" } }), steps, plans, 99 * H)).toBeUndefined();
    expect(slaState(step({ state: "done" }), steps, plans, 99 * H)).toBeUndefined();
    expect(slaState(step({ policy: { mode: "interactive", sla: "2h" } as never }), steps, plans, 99 * H)).toBeUndefined();
  });
});
