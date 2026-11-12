// RL-2: `mesh items` (the items of a review lineage, with their states).

import { runOf } from "../core/index.ts";
import type { ItemView, Step, StepView, StoredReview } from "../protocol/index.ts";
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

export function itemsCommand(c: CliEnv): Command {
  const usage = "usage: mesh items <lineage key | step id> [--all] [--json]";
  return {
    name: "items",
    summary: "items of a review lineage: <lineage key | step id> [--all] [--json]",
    async run(args) {
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
