// "My mesh" (MM-1): mesh machines / mesh fleet, and mesh machine name.

import { filterFleet, renderFleet } from "../core/index.ts";
import { NICKNAME_RULE, nicknameOk, parseLabels, type Credentials, type FleetMachine, type FleetView, type MachineLabelsView } from "../protocol/index.ts";
import type { Command } from "./commands.ts";
import { parseArgs, type CliEnv } from "./context.ts";
import { HubCallError, HubClient, loadCredentialsOrSolo } from "./hub-client.ts";

const NOT_LOGGED_IN = "not logged in to a hub; run: mesh login";
const MACHINE_USAGE = [
  "usage: mesh machine name <nickname> [--machine <id|nickname|hostname>]",
  "       mesh machine name --clear [--machine <id|nickname|hostname>]",
  "       mesh machine label <label,…> [--add|--rm] [--machine <id|nickname|hostname>]",
  "       mesh machine label --clear [--machine <id|nickname|hostname>]",
].join("\n");

/** `not a topic` warnings for labels the hub has no topic for (MM-2). */
export function notATopic(unknown: readonly string[] | undefined): string[] {
  return (unknown ?? []).map((l) => `not a topic: ${l}; mesh topic add ${l}`);
}

/** Labels as typed (trimmed, lowercased, empties and repeats dropped), for messages. */
function asTyped(raw: string): string[] {
  return [...new Set(raw.split(",").map((l) => l.trim().toLowerCase()).filter(Boolean))];
}

export function machinesCommand(c: CliEnv, name: "machines" | "fleet"): Command {
  return {
    name,
    summary: "every machine logged in as you and what each session on it does (--label a,b, --json)",
    async run(args) {
      const a = parseArgs(args, ["label"]);
      const raw = a.str("label") ?? "";
      const parsed = parseLabels(raw);
      if ("error" in parsed) {
        c.io.err(parsed.error);
        return 2;
      }
      const want = parsed.labels;
      const creds = loadCredentialsOrSolo(c.paths);
      if (!creds) {
        c.io.err(NOT_LOGGED_IN);
        return 1;
      }
      const view = await new HubClient(creds).get<FleetView>("/v1/fleet");
      const shown = filterFleet(view, want);
      if (a.has("json")) c.io.out(JSON.stringify(shown, null, 2));
      else if (want.length && shown.machines.length === 0 && view.machines.length > 0) c.io.out(`No machine or session of yours is labelled ${asTyped(raw).join(" and ")}.`);
      else c.io.out(renderFleet(shown));
      return 0;
    },
  };
}

/** Resolve `--machine x` among the caller's machines: exact id, else nickname, else hostname. */
function resolveMachine(machines: readonly FleetMachine[], x: string): { id: string } | { error: string } {
  const byId = machines.find((m) => m.id === x);
  if (byId) return { id: byId.id };
  const byNick = machines.find((m) => m.nickname === x);
  if (byNick) return { id: byNick.id };
  const byHost = machines.filter((m) => m.hostname === x);
  if (byHost.length === 1) return { id: (byHost[0] as FleetMachine).id };
  if (byHost.length > 1) return { error: `"${x}" matches several of your machines: ${byHost.map((m) => m.id).join(", ")}; use the id` };
  return { error: `no machine of yours matches "${x}"` };
}

/** The machine `mesh machine` acts on: this installation's, or `--machine x` among the caller's. */
async function targetMachine(c: CliEnv, creds: Credentials | undefined, target: string | undefined): Promise<{ id: string } | { code: number }> {
  if (target === undefined) {
    if (!creds?.machine) {
      c.io.err("this installation has no machine on the hub; run: mesh login");
      return { code: 1 };
    }
    return { id: creds.machine };
  }
  if (!creds) {
    c.io.err(NOT_LOGGED_IN);
    return { code: 1 };
  }
  const view = await new HubClient(creds).get<FleetView>("/v1/fleet");
  const r = resolveMachine(view.machines, target);
  if ("error" in r) {
    c.io.err(r.error);
    return { code: 1 };
  }
  return { id: r.id };
}

/** `mesh machine label` (MM-2). */
async function labelMachine(c: CliEnv, a: ReturnType<typeof parseArgs>): Promise<number> {
  const raw = a.positional[1];
  const clear = a.has("clear");
  const add = a.has("add");
  const rm = a.has("rm");
  if ((!raw && !clear) || (raw && clear) || (add && rm) || (clear && (add || rm)) || a.positional.length > 2) {
    c.io.err(MACHINE_USAGE);
    return 2;
  }
  const r = clear ? { labels: [] as string[] } : parseLabels(raw as string);
  if ("error" in r) {
    c.io.err(r.error);
    return 2;
  }
  const creds = loadCredentialsOrSolo(c.paths);
  const t = await targetMachine(c, creds, a.str("machine"));
  if ("code" in t) return t.code;
  const body = add ? { add: r.labels } : rm ? { remove: r.labels } : { labels: r.labels };
  let res: MachineLabelsView;
  try {
    res = await new HubClient(creds as NonNullable<typeof creds>).post<MachineLabelsView>(`/v1/machines/${encodeURIComponent(t.id)}/labels`, body);
  } catch (e) {
    if (!(e instanceof HubCallError)) throw e;
    c.io.err(e.message);
    return 1;
  }
  c.io.out(res.labels.length ? `${res.hostname} (${res.id}): labels ${res.labels.join(", ")}` : `${res.hostname} (${res.id}): no labels`);
  for (const line of notATopic(res.unknown)) c.io.err(line);
  return 0;
}

export function machineCommand(c: CliEnv): Command {
  return {
    name: "machine",
    summary: "name or label one of your machines: mesh machine name <nickname> | label <label,…> [--add|--rm] | --clear [--machine <id|nickname|hostname>]",
    async run(args) {
      const a = parseArgs(args, ["machine"]);
      const [sub, nickname] = a.positional;
      if (sub === "label") return await labelMachine(c, a);
      const clear = a.has("clear");
      if (sub !== "name" || (!nickname && !clear) || (nickname && clear)) {
        c.io.err(MACHINE_USAGE);
        return 2;
      }
      if (nickname !== undefined && !nicknameOk(nickname)) {
        c.io.err(NICKNAME_RULE);
        return 2;
      }
      const creds = loadCredentialsOrSolo(c.paths);
      const t = await targetMachine(c, creds, a.str("machine"));
      if ("code" in t) return t.code;
      const id = t.id;
      let res: { id: string; hostname: string; nickname?: string };
      try {
        res = await new HubClient(creds as NonNullable<typeof creds>).post(`/v1/machines/${encodeURIComponent(id)}/name`, { nickname: clear ? null : nickname });
      } catch (e) {
        if (!(e instanceof HubCallError)) throw e;
        c.io.err(e.message);
        return 1;
      }
      c.io.out(res.nickname ? `Named ${res.hostname} (${res.id}) ${res.nickname}.` : `Cleared the nickname of ${res.hostname} (${res.id}).`);
      return 0;
    },
  };
}
