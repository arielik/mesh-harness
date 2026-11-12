// RL-1: `mesh profile` (permission profiles of headless steps) and `mesh artifact` (hub-stored output
// of step rounds).

import { readFileSync } from "node:fs";
import type { ProfileView, StoredArtifact } from "../protocol/index.ts";
import type { Command } from "./commands.ts";
import { parseArgs, type CliEnv } from "./context.ts";
import { HubCallError, HubClient } from "./hub-client.ts";

/** A hub refusal as exit 1 with its text; anything else is rethrown. */
async function orRefused(c: CliEnv, fn: () => Promise<number>): Promise<number> {
  try {
    return await fn();
  } catch (e) {
    if (!(e instanceof HubCallError)) throw e;
    c.io.err(e.message);
    return 1;
  }
}

export function profileCommand(c: CliEnv): Command {
  const usage = ["usage:", "  mesh profile ls [--json]", "  mesh profile show <name>", "  mesh profile add <name> --file <profile.yaml>"].join("\n");
  return {
    name: "profile",
    summary: "permission profiles for headless steps: ls | show <name> | add <name> --file F",
    async run(args) {
      const [sub, ...rest] = args;
      const a = parseArgs(rest, ["file"]);
      const hub = () => HubClient.from(c.paths);
      switch (sub) {
        case "ls":
          return orRefused(c, async () => {
            const { profiles } = await hub().get<{ profiles: ProfileView[] }>("/v1/profiles");
            if (a.has("json")) {
              c.io.out(JSON.stringify({ profiles }, null, 2));
              return 0;
            }
            for (const p of profiles) c.io.out(`${p.name}  ${p.builtIn ? "built in" : `@${p.createdBy ?? "?"}`}  ${p.sha256.slice(0, 12)}  ${p.description}`.trimEnd());
            return 0;
          });
        case "show": {
          const name = a.positional[0];
          if (!name) break;
          return orRefused(c, async () => {
            const p = await hub().get<ProfileView>(`/v1/profiles/${encodeURIComponent(name)}`);
            c.io.out(JSON.stringify(p.settings, null, 2));
            return 0;
          });
        }
        case "add": {
          const name = a.positional[0];
          const file = a.str("file");
          if (!name || !file) break;
          let text: string;
          try {
            text = readFileSync(file, "utf8");
          } catch (e) {
            c.io.err(`cannot read ${file}: ${(e as Error).message}`);
            return 2;
          }
          return orRefused(c, async () => {
            const p = await hub().post<ProfileView>("/v1/profiles", { name, text });
            c.io.out(`Saved profile ${p.name} (sha256 ${p.sha256.slice(0, 12)}).`);
            return 0;
          });
        }
      }
      c.io.err(usage);
      return 2;
    },
  };
}

export function artifactCommand(c: CliEnv): Command {
  const usage = ["usage:", "  mesh artifact ls <G> [--json]", "  mesh artifact show <id>"].join("\n");
  return {
    name: "artifact",
    summary: "hub-stored step output: ls <G> | show <id>",
    async run(args) {
      const [sub, ...rest] = args;
      const a = parseArgs(rest);
      const hub = () => HubClient.from(c.paths);
      switch (sub) {
        case "ls": {
          const goal = a.positional[0];
          if (!goal) break;
          return orRefused(c, async () => {
            const { artifacts } = await hub().get<{ artifacts: StoredArtifact[] }>(`/v1/goals/${encodeURIComponent(goal)}/artifacts`);
            if (a.has("json")) {
              c.io.out(JSON.stringify({ artifacts }, null, 2));
              return 0;
            }
            if (artifacts.length === 0) {
              c.io.out(`No artifacts for ${goal}.`);
              return 0;
            }
            for (const x of artifacts) c.io.out(`${x.id}  ${x.step} r${x.round}  ${x.kind}  ${x.bytes} B  ${x.title ?? "-"}`);
            return 0;
          });
        }
        case "show": {
          const id = a.positional[0];
          if (!id) break;
          return orRefused(c, async () => {
            const r = await hub().get<{ artifact: StoredArtifact; content: string | null }>(`/v1/artifacts/${encodeURIComponent(id)}`);
            if (r.content === null) {
              c.io.err(`${id}: content pruned (sha256 ${r.artifact.sha256})`);
              return 1;
            }
            // The content exactly, byte for byte (no newline added).
            if (c.io.write) c.io.write(r.content);
            else c.io.out(r.content);
            return 0;
          });
        }
      }
      c.io.err(usage);
      return 2;
    },
  };
}
