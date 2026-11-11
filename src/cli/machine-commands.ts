// "My mesh" (MM-1): mesh machines / mesh fleet, and mesh machine name.

import { renderFleet } from "../core/index.ts";
import { NICKNAME_RULE, nicknameOk, type FleetMachine, type FleetView } from "../protocol/index.ts";
import type { Command } from "./commands.ts";
import { parseArgs, type CliEnv } from "./context.ts";
import { HubCallError, HubClient, loadCredentialsOrSolo } from "./hub-client.ts";

const NOT_LOGGED_IN = "not logged in to a hub; run: mesh login";
const MACHINE_USAGE = "usage: mesh machine name <nickname> [--machine <id|nickname|hostname>]\n       mesh machine name --clear [--machine <id|nickname|hostname>]";

export function machinesCommand(c: CliEnv, name: "machines" | "fleet"): Command {
  return {
    name,
    summary: "every machine logged in as you and what each session on it does (--json)",
    async run(args) {
      const a = parseArgs(args);
      const creds = loadCredentialsOrSolo(c.paths);
      if (!creds) {
        c.io.err(NOT_LOGGED_IN);
        return 1;
      }
      const view = await new HubClient(creds).get<FleetView>("/v1/fleet");
      c.io.out(a.has("json") ? JSON.stringify(view, null, 2) : renderFleet(view));
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

export function machineCommand(c: CliEnv): Command {
  return {
    name: "machine",
    summary: "name one of your machines: mesh machine name <nickname> [--machine <id|nickname|hostname>] | --clear",
    async run(args) {
      const a = parseArgs(args, ["machine"]);
      const [sub, nickname] = a.positional;
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
      const target = a.str("machine");
      let id: string;
      if (target === undefined) {
        if (!creds?.machine) {
          c.io.err("this installation has no machine on the hub; run: mesh login");
          return 1;
        }
        id = creds.machine;
      } else {
        if (!creds) {
          c.io.err(NOT_LOGGED_IN);
          return 1;
        }
        const view = await new HubClient(creds).get<FleetView>("/v1/fleet");
        const r = resolveMachine(view.machines, target);
        if ("error" in r) {
          c.io.err(r.error);
          return 1;
        }
        id = r.id;
      }
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
