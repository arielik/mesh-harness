// Plan templates (M4.5, 4.5.13): the development cycle as data, not engine code. A design session is
// given the template and fills in repos, criteria and briefs; `mesh goal plan --preset` instantiates
// one directly. Validation against a template is advisory only (warnings, never errors).

import { parse, stringify } from "yaml";
import { z } from "zod";
import { PlanInput, PlanStep, StepBudget, type PlanAc } from "../protocol/index.ts";

/** RL-7: a budget value that is exactly one placeholder (`{turns}`). */
const BUDGET_PLACEHOLDER = z.string().regex(/^\{[a-z][a-z0-9_]*\}$/);

/**
 * RL-1: a step of a template. As a plan step, but `agent` and `profile` may hold placeholders
 * ("{agent}", "{profile}") that `instantiate` fills from `params`. RL-7: `budget.turns` and
 * `budget.minutes` may each be a single placeholder too.
 */
export const PresetStep = PlanStep.extend({
  agent: z.string().min(1).max(100).optional(),
  profile: z.string().min(1).max(100).optional(),
  budget: z
    .object({
      turns: z.union([StepBudget.shape.turns.unwrap(), BUDGET_PLACEHOLDER]).optional(),
      minutes: z.union([StepBudget.shape.minutes.unwrap(), BUDGET_PLACEHOLDER]).optional(),
      usd: StepBudget.shape.usd,
    })
    .strict()
    .optional(),
});
export type PresetStep = z.infer<typeof PresetStep>;

/** RL-7: the name of a preset parameter (`params:` key). */
const PARAM_NAME = /^[a-z][a-z0-9_]{0,39}$/;
const PARAMS_RULE = "params must map names (a-z, 0-9, _) to values";

/** A template: a plan whose `repo` may be "{repo}" and whose strings may use {goal} and {<param>}. */
export interface Preset {
  name: string;
  description: string;
  /** RL-7: default values of parameters (an explicit param beats a default). */
  params?: Record<string, string> | undefined;
  plan: { steps: PresetStep[] };
}

const s = (x: Partial<PresetStep> & Pick<PresetStep, "id" | "kind" | "title" | "brief">): PresetStep => ({ repo: "{repo}", deps: [], ...x }) as PresetStep;

/** design → spec ⇄ cold review → R2 → split plans → blind build → combine → verify ⇄ fixes → diff review → R3. */
const SDD_SPLIT: Preset = {
  name: "sdd-split",
  description: "Spec and a cold review, a person's R2 gate, implementation and test plans written apart, developer and test-writer kept blind to each other, a read-only verify with fixes routed by bucket, a cold diff review and an R3 gate.",
  plan: {
    steps: [
      s({ id: "spec", kind: "spec", role: "spec-writer", title: "Spec", brief: "Write the spec for {goal}: problem, scope, interface contracts (the only thing the test side gets), acceptance criteria with the exact state that makes each fail. Return acs_addressed with every criterion." }),
      s({ id: "spec-review", kind: "review", role: "reviewer", deps: ["spec"], target: "spec", blind: ["spec"], max_rounds: 3, park_on: ["churn"], title: "Spec review", brief: "Review the spec cold: read the spec file and earlier review rounds, never the writer's session (blind: whoever wrote the spec can't review it). Verdict approved, changes_requested or blocked; findings as new / repeat / regression of the writer's own repairs." }),
      s({ id: "r2", kind: "gate", gate: "R2", deps: ["spec-review"], title: "R2: approve the spec", brief: "A person approves the spec and this plan, or reopens the spec." }),
      s({ id: "impl-plan", kind: "plan", role: "impl-planner", deps: ["r2"], blind: ["test-plan", "write-tests"], must_cover: "all", title: "Implementation plan", brief: "Plan the implementation per criterion. Do not plan the tests. Commit the plan on the implementation branch only." }),
      s({ id: "test-plan", kind: "plan", role: "test-planner", deps: ["r2"], blind: ["impl-plan", "develop"], reads: ["r2"], must_cover: "all", title: "Test plan", brief: "Plan the tests from the spec's contracts alone: per criterion the failing state, a positive control and a mutation. Never read implementation source or the implementation plan. Commit the plan on the test branch only." }),
      s({ id: "develop", kind: "implement", role: "developer", deps: ["impl-plan"], blind: ["test-plan", "write-tests"], worktree: true, title: "Develop", brief: "Implement per the implementation plan, in your own worktree. Never touch a test." }),
      s({ id: "write-tests", kind: "test", role: "test-writer", deps: ["test-plan"], blind: ["impl-plan", "develop"], worktree: "base", title: "Write tests", brief: "Write the tests per the test plan in your own worktree at the pre-change base. Every test must fail first on the base; report any that does not." }),
      s({ id: "combine", kind: "merge", role: "merger", deps: ["develop", "write-tests"], title: "Combine", brief: "Merge the test branch into the implementation branch. A conflict means one side touched the other's files: stop and say so." }),
      s({ id: "verify", kind: "verify", role: "test-executor", deps: ["combine"], blind: ["impl-plan"], max_rounds: 3, park_on: ["stall"], route: { "impl-bug": "develop", "test-bug": "write-tests", "spec-gap": "spec", infra: "park" }, title: "Verify", brief: "Run every test, read-only on code and tests. Judge each criterion met / not_met / unrun with its surface; bucket each failure (spec-gap, impl-bug, test-bug, infra)." }),
      s({ id: "diff-review", kind: "review", role: "reviewer", deps: ["verify"], blind: ["develop", "write-tests"], max_rounds: 2, title: "Diff review", brief: "Review the diff cold: every criterion has a test with fail-first evidence, no assertion on source text, the developer changed no test and the test-writer no product code." }),
      s({ id: "r3", kind: "gate", gate: "R3", deps: ["diff-review"], title: "R3: approve the landing", brief: "A person approves the landing (CI green, criteria met), or reopens steps." }),
    ],
  },
};

/** For test-only or lane-only specs: one builder, mutations as the fail-first evidence. */
const SDD_COLLAPSE: Preset = {
  name: "sdd-collapse",
  description: "Spec, cold review, R2, one builder writing the tests with mutations as fail-first evidence, verify, R3.",
  plan: {
    steps: [
      s({ id: "spec", kind: "spec", role: "spec-writer", title: "Spec", brief: "Write the spec for {goal} with acceptance criteria. Return acs_addressed with every criterion." }),
      s({ id: "spec-review", kind: "review", role: "reviewer", deps: ["spec"], target: "spec", blind: ["spec"], max_rounds: 3, park_on: ["churn"], title: "Spec review", brief: "Review the spec cold." }),
      s({ id: "r2", kind: "gate", gate: "R2", deps: ["spec-review"], title: "R2: approve the spec", brief: "A person approves the spec." }),
      s({ id: "build", kind: "test", role: "test-writer", deps: ["r2"], must_cover: "all", worktree: true, title: "Build", brief: "Write the tests; prove each criterion can fail with a mutation seen red." }),
      s({ id: "verify", kind: "verify", role: "test-executor", deps: ["build"], max_rounds: 3, park_on: ["stall"], route: { "test-bug": "build", "impl-bug": "build", "spec-gap": "spec", infra: "park" }, title: "Verify", brief: "Run every test read-only; judge each criterion." }),
      s({ id: "r3", kind: "gate", gate: "R3", deps: ["verify"], title: "R3: approve the landing", brief: "A person approves the landing." }),
    ],
  },
};

/** RL-3: the agent-only relay of design §5.6 (the person's debrief stage comes with S4). */
const AUDIT_RELAY: Preset = {
  name: "audit-relay",
  description: "Audit by an agent, validated by an agent, filed by an agent (agent-only; a person's debrief comes with S4).",
  params: { turns: "80", minutes: "60" },
  plan: {
    steps: [
      s({
        id: "audit",
        kind: "review",
        agent: "{agent}",
        mode: "headless",
        profile: "read-only",
        output: "review-record",
        budget: { turns: "{turns}", minutes: "{minutes}" },
        inputs: ["previous"],
        title: "Audit {repo}",
        brief: "Audit {repo}. Report every finding you see, with keys from your declared rules; the hub works out what is new.",
      }),
      s({
        id: "validate",
        kind: "review",
        deps: ["audit"],
        agent: "{validator}",
        mode: "headless",
        profile: "read-only",
        output: "review-record",
        when: { open: true },
        consumes: ["open"],
        may_set: ["confirmed", "dismissed"],
        inputs: ["audit", "dispositions"],
        title: "Validate the findings",
        brief: "Try to refute each open item from the source; confirm or dismiss each with a reason.",
      }),
      s({
        id: "file",
        kind: "docs",
        deps: ["validate"],
        agent: "{filer}",
        mode: "headless",
        profile: "propose-via-branch",
        output: "review-record",
        when: { open: true },
        consumes: ["confirmed"],
        may_set: ["accepted"],
        inputs: ["dispositions"],
        title: "File the confirmed items",
        brief: "Propose an entry for each confirmed item on this run's branch, then submit a review record that sets each one accepted with its link.",
      }),
    ],
  },
};

/** RL-6: the calibration of an agent hash, opened by the hub (a person's interactive step). */
export const CALIBRATE_PRESET: Preset = {
  name: "calibrate",
  description: "Calibrate an agent from the dismissals of its findings (opened by the hub when an agent reaches the dismissal threshold).",
  plan: {
    steps: [
      s({
        id: "calibrate",
        kind: "review",
        output: "review-record",
        inputs: ["calibration"],
        title: "Calibrate {agent}@{hash}",
        brief:
          'Read the input "calibration" from mesh_context: the dismissed findings of {agent}@{hash} with their evidence and reasons, and the agent\'s definition when the hub has it. Either change the agent\'s definition on this step\'s branch so such findings are no longer raised, or decide that no change is needed. Then submit a review record with no items (mesh_review): assessment "issues" with a summary of the change, or assessment "clean" with a summary starting "no change:" and the reason; then mesh_done.',
      }),
    ],
  },
};

export const BUILTIN_PRESETS: readonly Preset[] = [SDD_SPLIT, SDD_COLLAPSE, AUDIT_RELAY, CALIBRATE_PRESET];

/** A template from YAML text (a repo's .mesh/presets/<name>.yaml): {description?, steps}. */
export function parsePreset(name: string, text: string): Preset {
  const doc = parse(text) as { description?: string; params?: unknown; steps?: unknown };
  const plan = z.object({ steps: z.array(PresetStep) }).parse({ steps: (doc.steps as unknown[] | undefined)?.map((x) => ({ repo: "{repo}", ...(x as object) })) ?? [] });
  const params = doc.params === undefined ? undefined : parseParams(doc.params);
  return { name, description: doc.description ?? "", ...(params ? { params } : {}), plan: { steps: plan.steps } };
}

/** RL-7: a `params:` mapping; numbers become their decimal string. */
function parseParams(v: unknown): Record<string, string> {
  if (!v || typeof v !== "object" || Array.isArray(v)) throw new Error(PARAMS_RULE);
  const out: Record<string, string> = {};
  for (const [k, x] of Object.entries(v)) {
    if (!PARAM_NAME.test(k)) throw new Error(PARAMS_RULE);
    if (typeof x === "string") out[k] = x;
    else if (typeof x === "number" && Number.isFinite(x)) out[k] = String(x);
    else throw new Error(PARAMS_RULE);
  }
  return out;
}

export function presetText(p: Preset): string {
  const params = p.params && Object.keys(p.params).length > 0 ? { params: p.params } : {};
  return stringify({ preset: p.name, description: p.description, ...params, steps: p.plan.steps }, { lineWidth: 0 });
}

/** RL-7: the largest `budget.turns` / `budget.minutes` a filled placeholder may give. */
const BUDGET_MAX = { turns: 500, minutes: 1440 } as const;

const PLACEHOLDER = /\{([a-z][a-z0-9_]*)\}/g;

/**
 * The template filled in: `{repo}`, `{goal}` and `{<param>}` in every string value of each step
 * (never in keys), and the criteria. An unknown placeholder stays text, except in `agent` and
 * `profile`, where it throws.
 */
export function instantiate(
  p: Preset,
  opts: { repo: string; goal?: string | undefined; acs?: PlanAc[] | undefined; params?: Record<string, string> | undefined },
): PlanInput {
  const vars: Record<string, string> = { ...p.params, ...opts.params, repo: opts.repo, goal: opts.goal ?? "this goal" };
  const text = (t: string) => t.replace(PLACEHOLDER, (m, name: string) => (Object.hasOwn(vars, name) ? (vars[name] as string) : m));
  const fill = (v: unknown): unknown => {
    if (typeof v === "string") return text(v);
    if (Array.isArray(v)) return v.map(fill);
    if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, fill(x)]));
    return v;
  };
  const hasAcs = (opts.acs?.length ?? 0) > 0;
  const steps = p.plan.steps.map((x) => {
    const step = fill(x) as PresetStep;
    // Reconcile needs criteria; without them the template still works, minus that check.
    if (!hasAcs) delete step.must_cover;
    return step;
  });
  for (const step of steps) {
    for (const v of [step.agent, step.profile]) {
      const left = v === undefined ? null : /\{([a-z][a-z0-9_]*)\}/.exec(v);
      if (left) throw new Error(`preset ${p.name}: unknown parameter {${left[1]}} in step ${step.id}`);
    }
    const b = step.budget;
    if (b) {
      for (const k of ["turns", "minutes"] as const) {
        const v = b[k];
        if (typeof v !== "string") continue;
        const left = /^\{([a-z][a-z0-9_]*)\}$/.exec(v);
        if (left) throw new Error(`preset ${p.name}: unknown parameter {${left[1]}} in step ${step.id}`);
        const n = /^\d+$/.test(v) ? Number(v) : NaN;
        if (!(n >= 1 && n <= BUDGET_MAX[k])) {
          throw new Error(`preset ${p.name}: budget.${k} in step ${step.id} must be a whole number from 1 to ${BUDGET_MAX[k]}, got "${v}"`);
        }
        b[k] = n;
      }
    }
  }
  return PlanInput.parse({ steps, ...(hasAcs ? { acs: opts.acs } : {}) });
}

/** Where a plan departs from its template (advisory: shown to the design session and the approver). */
export function presetWarnings(p: Preset, steps: readonly PlanStep[]): string[] {
  const out: string[] = [];
  const mine = new Map(steps.map((x) => [x.id, x]));
  for (const t of p.plan.steps) {
    const m = mine.get(t.id);
    if (!m) {
      out.push(`template ${p.name}: step "${t.id}" (${t.kind}) is missing`);
      continue;
    }
    if (m.kind !== t.kind) out.push(`template ${p.name}: step "${t.id}" is ${m.kind}, the template has ${t.kind}`);
    for (const k of ["blind", "target", "route", "must_cover", "gate"] as const) {
      if (t[k] !== undefined && JSON.stringify(m[k]) !== JSON.stringify(t[k])) out.push(`template ${p.name}: step "${t.id}" changes ${k}`);
    }
  }
  return out;
}
