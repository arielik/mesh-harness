// RL-2: `mesh items` (the items of a review lineage, with their states). RL-4: `mesh debrief`.

import { skillStatus } from "../claude/index.ts";
import { runOf } from "../core/index.ts";
import { MESH_DEBRIEF_SKILL, Severity, type DebriefView, type ItemView, type SinkResult, type Step, type StepView, type StoredReview } from "../protocol/index.ts";
import type { Command } from "./commands.ts";
import { parseArgs, type CliEnv } from "./context.ts";
import { HubCallError, HubClient } from "./hub-client.ts";

/** The lineage named by a step: its latest review record's, else (a consuming step) its run's. */
async function lineageOfStep(hub: HubClient, id: string): Promise<string | undefined> {
  const latest = async (step: string): Promise<StoredReview | undefined> => {
    try {
      return (await hub.get<{ reviews: StoredReview[] }>(`/v1/steps/${encodeURIComponent(step)}/reviews`)).reviews.at(-1);
    } catch (e) {
      if (e instanceof HubCallError && e.status === 404) return undefined;
      throw e;
    }
  };
  const own = await latest(id);
  if (own) return own.lineage;
  let step: Step;
  try {
    step = (await hub.get<StepView>(`/v1/steps/${encodeURIComponent(id)}`)).context.step;
  } catch (e) {
    if (e instanceof HubCallError && e.status === 404) return undefined;
    throw e;
  }
  if (!step.policy?.consumes) return undefined;
  const { steps } = await hub.get<{ steps: Step[] }>(`/v1/steps?goal=${encodeURIComponent(step.goal)}`);
  const run = runOf(step, steps, (s) => s.policy);
  return run ? (await latest(run.id))?.lineage : undefined;
}

/** RL-4: the prompt a debrief session starts with. */
export function debriefPrompt(step: string): string {
  return `You hold the mesh debrief step ${step}. Use the mesh-debrief skill: call mesh_context, then go through the items with me one at a time, highest severity first. Record each decision with mesh_dispose, then submit the debrief's review record with mesh_review and finish with mesh_done.`;
}

/**
 * RL-4: `mesh debrief <step>`: checks that the caller is the debrief's assignee and that it can
 * start, then runs `mesh run <repo> --step <step> --prompt <prompt>` (which claims it and opens
 * the interactive session in tmux).
 */
const DEBRIEF_USAGE = "usage: mesh debrief <step> [--session NAME] [--no-tui]";

export function debriefCommand(c: CliEnv, run: (args: string[]) => Promise<number>): Command {
  return {
    name: "debrief",
    help: DEBRIEF_USAGE,
    summary: "take a debrief assigned to you and go through its items in a session: mesh debrief <step> [--session NAME] [--no-tui]",
    async run(args) {
      const a = parseArgs(args, ["session", "socket-name"]);
      const step = a.positional[0];
      if (!step) {
        c.io.err(DEBRIEF_USAGE);
        return 2;
      }
      let view: DebriefView;
      let me: string;
      let current: number;
      try {
        const hub = HubClient.from(c.paths);
        view = await hub.get<DebriefView>(`/v1/steps/${encodeURIComponent(step)}/debrief`);
        me = (await hub.get<{ user: { id: string } }>("/v1/me")).user.id;
        if (view.assignee !== me) {
          c.io.err(`${view.step} is a debrief for ${view.assignee}; only they can run it`);
          return 1;
        }
        if (view.state !== "ready" && view.state !== "claimed" && view.state !== "paused") {
          c.io.err(`${view.step} is ${view.state}; a debrief starts when it is ready`);
          return 1;
        }
        current = ((await hub.get<StepView>(`/v1/steps/${encodeURIComponent(view.step)}`)).context.step.rounds?.length ?? 0) + 1;
      } catch (e) {
        if (!(e instanceof HubCallError)) throw e;
        c.io.err(e.message);
        return 1;
      }
      if (!view.read || view.read.round !== current) c.io.err(`warning: you have not marked the pre-read of ${view.step} as read (web step panel); starting anyway`);
      if (skillStatus(c.paths.claudeDebriefSkill, MESH_DEBRIEF_SKILL) !== "current") c.io.err("warning: the mesh-debrief skill is not installed or out of date; run: mesh setup");
      const session = a.str("session");
      const socket = a.str("socket-name");
      return await run([
        view.repo.slice(view.repo.lastIndexOf("/") + 1),
        "--step",
        view.step,
        "--prompt",
        debriefPrompt(view.step),
        ...(session ? ["--session", session] : []),
        ...(socket ? ["--socket-name", socket] : []),
        ...(a.has("no-tui") ? ["--no-tui"] : []),
      ]);
    },
  };
}

/** RL-9: `mesh items sink <lineage> --topic <t> [--min-severity S2] [--dry-run]` (backfill). */
async function itemsSink(c: CliEnv, args: readonly string[], usage: string): Promise<number> {
  const a = parseArgs(args, ["topic", "min-severity"]);
  const lineage = a.positional[0];
  const topic = a.str("topic");
  const min = a.str("min-severity");
  if (!lineage || !topic) {
    c.io.err(usage);
    return 2;
  }
  if (min !== undefined && !Severity.safeParse(min).success) {
    c.io.err(`--min-severity is one of ${Severity.options.join(", ")}, got "${min}"`);
    return 2;
  }
  try {
    const r = await HubClient.from(c.paths).post<SinkResult>("/v1/items/sink", { lineage, topic, ...(min ? { min_severity: min } : {}), ...(a.has("dry-run") ? { dry_run: true } : {}) });
    if (a.has("dry-run")) c.io.out(`would add ${r.added.length} to ${r.goal ?? "a new goal"}`);
    else c.io.out(`${r.goal ?? "no goal"}: added ${r.added.length}, reopened ${r.reopened.length}`);
    return 0;
  } catch (e) {
    if (!(e instanceof HubCallError)) throw e;
    c.io.err(e.message);
    return 1;
  }
}

export function itemsCommand(c: CliEnv): Command {
  const usage = ["usage: mesh items <lineage key | step id> [--all] [--json]", "       mesh items sink <lineage> --topic <t> [--min-severity S2] [--dry-run]"].join("\n");
  return {
    name: "items",
    help: usage,
    summary: "items of a review lineage: <lineage key | step id> [--all] [--json]; sink <lineage> --topic <t> adds its filed items to a clean-audit goal",
    async run(args) {
      if (args[0] === "sink") return await itemsSink(c, args.slice(1), usage);
      const a = parseArgs(args);
      const target = a.positional[0];
      if (!target) {
        c.io.err(usage);
        return 2;
      }
      try {
        const hub = HubClient.from(c.paths);
        const lineage = target.includes("|") ? target : await lineageOfStep(hub, target);
        if (!lineage) {
          c.io.err(`${target} has no review record`);
          return 1;
        }
        const r = await hub.get<{ lineage: string; items: ItemView[] }>(`/v1/items?lineage=${encodeURIComponent(lineage)}`);
        if (a.has("json")) {
          c.io.out(JSON.stringify(r, null, 2));
          return 0;
        }
        const shown = a.has("all") ? r.items : r.items.filter((i) => i.state !== "resolved");
        if (shown.length === 0) {
          c.io.out(`No items in ${lineage}.`);
          return 0;
        }
        for (const i of shown) c.io.out(`${i.fp}  ${i.state}  ${i.severity}  ${i.rule}  ${i.path ?? "-"}  ${i.title}`);
        return 0;
      } catch (e) {
        if (!(e instanceof HubCallError)) throw e;
        c.io.err(e.message);
        return 1;
      }
    },
  };
}
