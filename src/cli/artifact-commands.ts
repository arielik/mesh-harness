// RL-1: `mesh profile` (permission profiles of headless steps) and `mesh artifact` (hub-stored output
// of step rounds).

import { readFileSync } from "node:fs";
import { PROFILE_ENV_MAX, PROFILE_ENV_VALUE_MAX } from "../core/index.ts";
import { PROFILE_FIT, PROFILE_LIMITS, type ProfileFit, type ProfileView, type StoredArtifact } from "../protocol/index.ts";
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
  const L = PROFILE_LIMITS;
  const usage = [
    "usage:",
    "  mesh profile ls [--json]",
    "  mesh profile show <name>",
    "  mesh profile add <name> --file <profile.yaml>",
    "  mesh profile fit <name> [--days N] [--include-trial] [--json]",
    "                                    denied commands and unused tools of the profile's runs, as a",
    "                                    proposed change (nothing is saved; default 14 days)",
    "",
    "profile.yaml keys (all optional):",
    "  extends: read-only | read-only+checks | propose-via-branch   (default read-only)",
    `  description: text                 at most ${L.description} characters`,
    `  checks: [command, ...]            each allowed as Bash(<command>); at most ${L.checks}, each at most ${L.check} characters`,
    `  allow: [rule, ...], deny: [...]   Claude Code permission rules; at most ${L.rules} each, each at most ${L.rule} characters`,
    `  env: {NAME: "value", ...}         variables for the run's process; at most ${PROFILE_ENV_MAX}, values at most ${PROFILE_ENV_VALUE_MAX} characters`,
    "                                    (mesh's own MESH_* names, CLAUDE_*, ANTHROPIC_*, GIT_*, PATH and loader variables are refused)",
  ].join("\n");
  return {
    name: "profile",
    help: usage,
    summary: "permission profiles for headless steps: ls | show <name> | add <name> --file F | fit <name>",
    async run(args) {
      const [sub, ...rest] = args;
      if (sub === "--help" || sub === "-h" || sub === "help") {
        c.io.out(usage);
        return 0;
      }
      const a = parseArgs(rest, ["file", "days"]);
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
        case "fit": {
          const name = a.positional[0];
          if (!name) break;
          return orRefused(c, async () => {
            const qs = new URLSearchParams();
            const days = a.has("days") ? (a.str("days") ?? "") : undefined;
            if (days !== undefined) qs.set("days", days);
            if (a.has("include-trial")) qs.set("trial", "include");
            const query = qs.size ? `?${qs.toString()}` : "";
            const fit = await hub().get<ProfileFit>(`/v1/profiles/${encodeURIComponent(name)}/fit${query}`);
            c.io.out(a.has("json") ? JSON.stringify(fit, null, 2) : formatProfileFit(fit).join("\n"));
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

const runsWord = (n: number) => (n === 1 ? "1 run" : `${n} runs`);
const verdict = (x: { suggest: boolean; held?: string | undefined; refusal?: string | undefined }, yes: string) =>
  x.suggest ? yes : `held: ${x.held ?? "?"}${x.refusal !== undefined ? `: ${x.refusal}` : ""}`;

/** RL-16: the text of `mesh profile fit` (docs/specs/RL-16.md, "CLI"). */
export function formatProfileFit(f: ProfileFit): string[] {
  const out: string[] = [];
  const h12 = (h: string) => h.slice(0, 12);
  out.push(
    `Profile ${f.profile} (sha256 ${h12(f.sha256)}): ${f.sample.runs} runs in the last ${f.window.days} days at this hash, ${f.sample.toolRuns} with tool data.${f.trial === "include" ? " Trial runs included." : ""}`,
  );
  const others = f.hashes.filter((h) => !h.current && h.runs > 0);
  if (others.length) out.push(`Other hashes: ${others.map((h) => `${h12(h.sha256)} ${runsWord(h.runs)}`).join(", ")}.`);
  const min = f.thresholds.minRuns ?? PROFILE_FIT.minRuns;
  if (f.sample.runs < min) out.push(`Fewer than ${min} runs: no allow rule is suggested from a small sample.`);
  if (f.sample.toolRuns < min) out.push(`Fewer than ${min} runs with tool data: no tool is suggested for dropping.`);
  if (f.denied.length === 0) out.push("Denied: none.");
  else {
    out.push("Denied:");
    for (const d of f.denied) {
      const label = d.command !== undefined ? `${d.tool} ${d.command}` : d.tool;
      out.push(`  ${label}  ${d.runs}/${f.sample.runs} runs, ${d.count} denials  ${verdict(d, `→ allow ${d.rule ?? ""}`)}`);
    }
  }
  if (f.sample.toolRuns === 0) out.push("Offered, never used: no runs with tool data.");
  else if (f.unused.length === 0) out.push("Offered, never used: none.");
  else {
    out.push("Offered, never used:");
    for (const u of f.unused) out.push(`  ${u.tool}  ${u.offeredRuns}/${f.sample.toolRuns} runs  ${verdict(u, `→ drop (deny ${u.tool})`)}`);
  }
  if (f.truncated) out.push(`(${f.truncated.denied} more denied and ${f.truncated.unused} more unused entries not shown)`);
  if (f.diff.allow.length === 0 && f.diff.deny.length === 0) out.push("Proposed change: none.");
  else {
    out.push("Proposed change:");
    for (const r of f.diff.allow) out.push(`  allow: + ${r}`);
    for (const t of f.diff.deny) out.push(`  deny:  + ${t}`);
    out.push(
      f.builtIn
        ? `Nothing was saved. ${f.profile} is built in: register a profile with "extends: ${f.profile}" and these rules (mesh profile add <new name> --file <profile.yaml>) and use it in the step.`
        : `Nothing was saved. Narrow the Bash rules if you can, add them to the profile's YAML and run: mesh profile add ${f.profile} --file <profile.yaml>`,
    );
  }
  return out;
}

export function artifactCommand(c: CliEnv): Command {
  const usage = ["usage:", "  mesh artifact ls <G> [--json]", "  mesh artifact show <id>"].join("\n");
  return {
    name: "artifact",
    help: usage,
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
