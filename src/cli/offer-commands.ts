// Assign (MM-3): mesh assign, offers, accept, decline, withdraw, and mesh session accept.

import { assignText, offerLine, sessionName } from "../core/index.ts";
import { parseAccept, type AssignResult, type GoalAssignResult, type GoalWithdrawResult, type OfferView, type Step, type StepView, type SuggestView } from "../protocol/index.ts";
import { DaemonClient } from "./client.ts";
import type { Command } from "./commands.ts";
import { loadConfig, parseArgs, type CliEnv } from "./context.ts";
import { HubClient } from "./hub-client.ts";

const ASSIGN_USAGE =
  'usage: mesh assign <goal|step> --to <machine>[/<session>] [--stick] [--note "…"]\n       mesh assign <goal|step> --suggest [--team] [--any] [--json]';
const ACCEPT_USAGE = "usage: mesh accept <step> [--session <s> | --launch]";
const DECLINE_USAGE = 'usage: mesh decline <step> [--note "…"]';
const WITHDRAW_USAGE = "usage: mesh withdraw <goal|step>";
const SESSION_USAGE = "usage: mesh session accept <session> --from <rule,…> | --off | --clear";

const isStep = (target: string) => target.includes(".");
const enc = encodeURIComponent;

/** Run a call; an error prints its text on stderr and gives exit code 1. */
async function orFail(c: CliEnv, fn: () => Promise<number>): Promise<number> {
  try {
    return await fn();
  } catch (e) {
    c.io.err(e instanceof Error ? e.message : String(e));
    return 1;
  }
}

export function assignCommand(c: CliEnv): Command {
  return {
    name: "assign",
    summary: `offer a goal or step to another machine or session: mesh assign <goal|step> --to <machine>[/<session>] [--stick] [--note "…"]; ranked machines: mesh assign <goal|step> --suggest [--team] [--any] [--json]`,
    async run(args) {
      const a = parseArgs(args, ["to", "note"]);
      const [target] = a.positional;
      const to = a.str("to");
      const suggestMode = a.has("suggest");
      const usage =
        !target ||
        (suggestMode && (a.has("to") || a.has("stick") || a.has("note"))) ||
        (!suggestMode && (a.has("team") || a.has("any") || a.has("json") || !to));
      if (usage || !target) {
        c.io.err(ASSIGN_USAGE);
        return 2;
      }
      if (suggestMode) return await suggestAssign(c, target, { team: a.has("team"), any: a.has("any"), json: a.has("json") });
      if (!to) return 2;
      const stick = a.has("stick");
      const note = a.str("note");
      const body = { to, stick, ...(note ? { note } : {}) };
      return orFail(c, async () => {
        const hub = HubClient.from(c.paths);
        const kind = isStep(target) ? "step" : "goal";
        const r =
          kind === "step"
            ? await hub.post<AssignResult>(`/v1/steps/${enc(target)}/assign`, body)
            : await hub.post<GoalAssignResult>(`/v1/goals/${enc(target)}/assign`, body);
        for (const line of assignText(kind, target, to, r, stick)) c.io.out(line);
        return 0;
      });
    },
  };
}

/** `mesh assign <goal|step> --suggest`: ranked machines from the hub (MM-4). */
async function suggestAssign(c: CliEnv, target: string, o: { team: boolean; any: boolean; json: boolean }): Promise<number> {
  const query = [o.team ? "team=1" : "", o.any ? "any=1" : ""].filter(Boolean).join("&");
  const path = `${isStep(target) ? "/v1/steps" : "/v1/goals"}/${enc(target)}/suggest${query ? `?${query}` : ""}`;
  return orFail(c, async () => {
    const view = await HubClient.from(c.paths).get<SuggestView | null>(path);
    // An older hub answers an unknown GET with its catch-all 200 (HTML or text).
    if (!view || typeof view !== "object" || !Array.isArray(view.suggestions)) {
      c.io.err("the hub does not offer suggestions (it needs v0.1.13 or later)");
      return 1;
    }
    if (o.json) {
      c.io.out(JSON.stringify(view, null, 2));
      return 0;
    }
    const first = view.suggestions[0];
    if (!first) {
      c.io.out(`No machine to suggest for ${target}; try --team or --any.`);
      return 0;
    }
    c.io.out(`Suggestions for ${target} (best first):`);
    view.suggestions.forEach((s, i) => c.io.out(`${i + 1}. ${s.to} · ${s.reason}`));
    c.io.out(`Assign with: mesh assign ${target} --to ${first.to}${Array.isArray(view.steps) && view.steps.length === 0 ? " --stick" : ""}`);
    return 0;
  });
}

export function offersCommand(c: CliEnv): Command {
  return {
    name: "offers",
    summary: "steps offered to your machines, waiting for an accept (--json)",
    async run(args) {
      const a = parseArgs(args);
      return orFail(c, async () => {
        const { offers } = await HubClient.from(c.paths).get<{ offers: OfferView[] }>("/v1/offers");
        if (a.has("json")) c.io.out(JSON.stringify({ offers }, null, 2));
        else if (offers.length === 0) c.io.out("No offers for your machines.");
        else {
          const now = Date.now();
          for (const o of offers) c.io.out(offerLine(o, now));
        }
        return 0;
      });
    },
  };
}

/** `launch`: start a session for a step as `mesh run <repo> --step <step>` (the claim is the accept). */
export function acceptCommand(c: CliEnv, launch: (args: string[]) => Promise<number>): Command {
  return {
    name: "accept",
    summary: "take a step offered to this machine: mesh accept <step> [--session <s> | --launch]",
    async run(args) {
      const a = parseArgs(args, ["session"]);
      const [step] = a.positional;
      const session = a.str("session");
      if (!step || (a.has("session") && a.has("launch"))) {
        c.io.err(ACCEPT_USAGE);
        return 2;
      }
      if (a.has("launch")) {
        let repo: string;
        try {
          repo = (await HubClient.from(c.paths).get<StepView>(`/v1/steps/${enc(step)}`)).context.step.repo;
        } catch (e) {
          c.io.err(e instanceof Error ? e.message : String(e));
          return 1;
        }
        if (!repo) {
          c.io.err(`${step} has no repo; start it with: mesh run <repo> --step ${step}`);
          return 2;
        }
        return await launch([repo.slice(repo.lastIndexOf("/") + 1), "--step", step]);
      }
      return orFail(c, async () => {
        const r = await new DaemonClient(loadConfig(c.paths)).accept(step, session);
        c.io.out(r.message);
        return 0;
      });
    },
  };
}

export function declineCommand(c: CliEnv): Command {
  return {
    name: "decline",
    summary: 'decline a step offered to your machine: mesh decline <step> [--note "…"]',
    async run(args) {
      const a = parseArgs(args, ["note"]);
      const [step] = a.positional;
      if (!step) {
        c.io.err(DECLINE_USAGE);
        return 2;
      }
      const note = a.str("note");
      return orFail(c, async () => {
        await HubClient.from(c.paths).post<Step>(`/v1/steps/${enc(step)}/decline`, note ? { note } : {});
        c.io.out(`Declined ${step}.`);
        return 0;
      });
    },
  };
}

export function withdrawCommand(c: CliEnv): Command {
  return {
    name: "withdraw",
    summary: "withdraw your offer of a step, or end a goal's stick and its offers: mesh withdraw <goal|step>",
    async run(args) {
      const [target] = parseArgs(args).positional;
      if (!target) {
        c.io.err(WITHDRAW_USAGE);
        return 2;
      }
      return orFail(c, async () => {
        const hub = HubClient.from(c.paths);
        if (isStep(target)) {
          await hub.post<Step>(`/v1/steps/${enc(target)}/withdraw`, {});
          c.io.out(`Withdrew the offer of ${target}.`);
        } else {
          const r = await hub.post<GoalWithdrawResult>(`/v1/goals/${enc(target)}/withdraw`, {});
          c.io.out(`Withdrew the offers of ${target}: ${r.withdrawn.length ? r.withdrawn.join(", ") : "none"}; later steps are no longer offered.`);
        }
        return 0;
      });
    },
  };
}

export function sessionCommand(c: CliEnv): Command {
  return {
    name: "session",
    summary: "whose offers a session accepts automatically: mesh session accept <session> --from <rule,…> | --off | --clear",
    async run(args) {
      const a = parseArgs(args, ["from"]);
      const [sub, target] = a.positional;
      const modes = [a.has("from"), a.has("off"), a.has("clear")].filter(Boolean).length;
      if (sub !== "accept" || !target || modes !== 1 || a.positional.length > 2) {
        c.io.err(SESSION_USAGE);
        return 2;
      }
      let accept: string[] | null;
      if (a.has("from")) {
        const r = parseAccept(a.str("from") ?? "");
        if ("error" in r) {
          c.io.err(r.error);
          return 2;
        }
        accept = r.accept;
      } else accept = a.has("off") ? ["off"] : null;
      return orFail(c, async () => {
        const s = await new DaemonClient(loadConfig(c.paths)).sessionAccept(target, accept);
        const name = sessionName(s);
        c.io.out(
          accept === null ? `${name}: uses the machine policy` : accept.includes("off") ? `${name}: accepts no offer automatically` : `${name}: accepts offers from ${accept.join(", ")}`,
        );
        return 0;
      });
    },
  };
}

/** The six MM-3 commands. `launch` runs `mesh run` with the given arguments (for `mesh accept --launch`). */
export function offerCommands(c: CliEnv, launch: (args: string[]) => Promise<number>): Command[] {
  return [assignCommand(c), offersCommand(c), acceptCommand(c, launch), declineCommand(c), withdrawCommand(c), sessionCommand(c)];
}
