// RL-5: `mesh agents` (the roster) and `mesh agent …` (install catalog agents by pinned reference,
// check and update them, register catalog sources).

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline/promises";
import { dirname, join, resolve } from "node:path";
import { agentFileHash, canonicalKey, unifiedDiff } from "../core/index.ts";
import {
  AgentsLock,
  parseRosterKey,
  ROSTER_KEY_RULE,
  type AgentGroup,
  type AgentsLockEntry,
  type AgentsView,
  type CatalogDefView,
  type CatalogSourceView,
} from "../protocol/index.ts";
import type { Command } from "./commands.ts";
import { parseArgs, type CliEnv } from "./context.ts";
import { HubCallError, HubClient } from "./hub-client.ts";

const AGENTS_USAGE = "usage: mesh agents [--name <name>] [--json]";

const AGENT_USAGE = [
  "usage:",
  "  mesh agent add <source>/<name>[@<ref>] [--repo <path>] [--force]",
  "  mesh agent outdated [--repo <path>] [--json]",
  "  mesh agent diff <name> [--repo <path>]",
  "  mesh agent update <name> [--repo <path>] [--yes]",
  "  mesh agent source add <repo> --folder <path> [--calibrator <user>]",
  "  mesh agent source ls [--json]",
].join("\n");

const FLAGS = ["diverged", "pinned", "behind", "modified"] as const;

/** A usage error: printed, exit 2, nothing written. */
class Usage extends Error {}
/** A refusal: printed, exit 1, nothing written. */
class Refused extends Error {}

const c7 = (s: string | undefined) => (s ?? "").slice(0, 7);

/** The lines `mesh agents` prints for a roster view. */
export function rosterText(view: AgentsView): string[] {
  if (view.agents.length === 0) return ["No agents on the roster."];
  const out: string[] = [];
  for (const g of view.agents) out.push(...groupText(g));
  return out;
}

function groupText(g: AgentGroup): string[] {
  const copies = g.versions.reduce((n, v) => n + v.copies.length, 0);
  const flags = FLAGS.filter((f) => g[f]).map((f) => `  ${f}`).join("");
  const out = [`${g.name}  versions ${g.versions.length}  copies ${copies}${flags}`];
  for (const v of g.versions) {
    out.push(`  ${v.hash.slice(0, 12)}  ${v.description ?? "-"}`);
    for (const c of v.copies) {
      const origin = c.origin === "repo" ? "repo" : `catalog ${c7(c.commit)}`;
      out.push(`    ${c.key}  ${origin}${c.pin ? `  pin ${c7(c.pin.commit)}` : ""}${c.behind ? "  behind" : ""}${c.modified ? "  modified" : ""}`);
    }
  }
  return out;
}

/** The folder at or above `start` that holds `.git`. */
function repoRoot(c: CliEnv, repo: string | undefined): string {
  const start = resolve(c.cwd, repo ?? ".");
  let dir = start;
  for (;;) {
    if (existsSync(join(dir, ".git"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) throw new Usage(`not in a git checkout: ${start}`);
    dir = parent;
  }
}

const lockPath = (root: string) => join(root, ".mesh", "agents.lock");
const agentPath = (root: string, name: string) => join(root, ".claude", "agents", `${name}.md`);

function readLock(root: string): AgentsLockEntry[] | undefined {
  const p = lockPath(root);
  if (!existsSync(p)) return undefined;
  let parsed: ReturnType<typeof AgentsLock.safeParse>;
  try {
    parsed = AgentsLock.safeParse(JSON.parse(readFileSync(p, "utf8")));
  } catch {
    throw new Refused(`${p} is not a valid agents lock`);
  }
  if (!parsed.success) throw new Refused(`${p} is not a valid agents lock`);
  return parsed.data.agents;
}

function writeLock(root: string, entries: readonly AgentsLockEntry[]): void {
  const agents = [...entries]
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
    .map((e) => ({ name: e.name, source: e.source, commit: e.commit, hash: e.hash }));
  mkdirSync(join(root, ".mesh"), { recursive: true });
  writeFileSync(lockPath(root), `${JSON.stringify({ version: 1, agents }, null, 2)}\n`);
}

function readInstalled(root: string, name: string): string | undefined {
  try {
    return readFileSync(agentPath(root, name), "utf8");
  } catch {
    return undefined;
  }
}

function install(root: string, def: CatalogDefView, lock: readonly AgentsLockEntry[]): void {
  const target = agentPath(root, def.name);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, def.text);
  writeLock(root, [...lock.filter((e) => e.name !== def.name), { name: def.name, source: def.source, commit: def.commit, hash: def.hash }]);
}

const resolveKey = (hub: HubClient, key: string) => hub.get<CatalogDefView>(`/v1/agents/resolve?key=${encodeURIComponent(key)}`);

function lockEntry(root: string, name: string): { lock: AgentsLockEntry[]; entry: AgentsLockEntry } {
  const lock = readLock(root) ?? [];
  const entry = lock.find((e) => e.name === name);
  if (!entry) throw new Refused(`${name} is not pinned in ${lockPath(root)}`);
  return { lock, entry };
}

function printDiff(c: CliEnv, d: string): void {
  if (c.io.write) c.io.write(d);
  else c.io.out(d.replace(/\n$/, ""));
}

/** Ask the person; undefined when there is no terminal (and no injected reader). */
async function ask(c: CliEnv, prompt: string): Promise<string | undefined> {
  if (c.readLine) return await c.readLine(prompt, new AbortController().signal);
  if (!process.stdin.isTTY) return undefined;
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return await rl.question(prompt);
  } catch {
    return "";
  } finally {
    rl.close();
  }
}

/** Runs a body, mapping usage errors to exit 2 and refusals (ours or the hub's) to exit 1. */
async function guarded(c: CliEnv, usage: string, body: () => Promise<number>): Promise<number> {
  try {
    return await body();
  } catch (e) {
    if (e instanceof Usage) {
      c.io.err(e.message || usage);
      return 2;
    }
    if (e instanceof Refused || e instanceof HubCallError) {
      c.io.err(e.message);
      return 1;
    }
    if (e instanceof Error && /^not logged in/.test(e.message)) {
      c.io.err(e.message);
      return 1;
    }
    throw e;
  }
}

export function agentsCommand(c: CliEnv): Command {
  return {
    name: "agents",
    summary: "the roster: agents of repos and catalog sources",
    help: AGENTS_USAGE,
    run: (args) =>
      guarded(c, AGENTS_USAGE, async () => {
        const a = parseArgs(args, ["name"]);
        if (a.positional.length > 0 || a.flags.get("name") === true) throw new Usage(AGENTS_USAGE);
        const name = a.str("name");
        const view = await HubClient.from(c.paths).get<AgentsView>(`/v1/agents${name !== undefined ? `?name=${encodeURIComponent(name)}` : ""}`);
        if (a.has("json")) c.io.out(JSON.stringify(view, null, 2));
        else for (const line of rosterText(view)) c.io.out(line);
        return 0;
      }),
  };
}

export function agentCommand(c: CliEnv): Command {
  return {
    name: "agent",
    summary: "install a catalog agent by pinned reference; outdated, diff, update; catalog sources",
    help: AGENT_USAGE,
    run: (args) =>
      guarded(c, AGENT_USAGE, async () => {
        const [sub, ...rest] = args;
        const a = parseArgs(rest, ["repo", "folder", "calibrator"]);
        const hub = () => HubClient.from(c.paths);
        switch (sub) {
          case "add": {
            const key = a.positional[0];
            if (key === undefined || a.positional.length > 1) throw new Usage(AGENT_USAGE);
            if (!parseRosterKey(key)) throw new Usage(ROSTER_KEY_RULE);
            const root = repoRoot(c, a.str("repo"));
            const lock = readLock(root) ?? [];
            const def = await resolveKey(hub(), key);
            const existing = readInstalled(root, def.name);
            if (existing !== undefined && agentFileHash(existing) !== def.hash && !a.has("force")) {
              throw new Refused(`${agentPath(root, def.name)} exists and differs from ${def.key}@${c7(def.commit)}; use --force to replace it`);
            }
            install(root, def, lock);
            c.io.out(`Installed ${def.key}@${c7(def.commit)} into .claude/agents/${def.name}.md (hash ${def.hash.slice(0, 12)}); pinned in .mesh/agents.lock.`);
            return 0;
          }
          case "outdated": {
            if (a.positional.length > 0) throw new Usage(AGENT_USAGE);
            const root = repoRoot(c, a.str("repo"));
            const lock = readLock(root);
            if (lock === undefined) {
              c.io.out(`No pinned agents in ${root}.`);
              return 0;
            }
            const client = lock.length ? hub() : undefined;
            const rows: { e: AgentsLockEntry; status: string; latest?: CatalogDefView }[] = [];
            for (const e of lock) {
              let latest: CatalogDefView | undefined;
              let gone = false;
              try {
                latest = await resolveKey(client as HubClient, `${e.source}/${e.name}`);
              } catch (err) {
                if (err instanceof HubCallError && err.status === 404 && err.message.startsWith("no agent ")) gone = true;
                else throw err;
              }
              const text = readInstalled(root, e.name);
              const st: string[] = [];
              if (text === undefined) st.push("missing");
              else {
                if (agentFileHash(text) !== e.hash) st.push("modified");
                if (gone) st.push("gone");
                else if (latest && latest.hash !== e.hash) st.push("behind");
              }
              rows.push({ e, status: st.length ? st.join(",") : "ok", ...(latest ? { latest } : {}) });
            }
            if (a.has("json")) {
              const agents = rows.map((r) => ({
                name: r.e.name,
                source: r.e.source,
                commit: r.e.commit,
                hash: r.e.hash,
                status: r.status,
                ...(r.latest ? { latest: { hash: r.latest.hash, commit: r.latest.commit } } : {}),
              }));
              c.io.out(JSON.stringify({ agents }, null, 2));
            } else {
              for (const r of rows) {
                const behind = r.status.split(",").includes("behind") && r.latest;
                c.io.out(`${r.e.name}  ${canonicalKey(r.e.source, r.e.name)}@${c7(r.e.commit)}  ${r.status}${behind ? `  latest ${c7(r.latest?.commit)}` : ""}`);
              }
            }
            return rows.every((r) => r.status === "ok") ? 0 : 1;
          }
          case "diff": {
            const name = a.positional[0];
            if (name === undefined || a.positional.length > 1) throw new Usage(AGENT_USAGE);
            const root = repoRoot(c, a.str("repo"));
            const { entry } = lockEntry(root, name);
            const latest = await resolveKey(hub(), `${entry.source}/${entry.name}`);
            const key = canonicalKey(entry.source, entry.name);
            const d = unifiedDiff(readInstalled(root, name) ?? "", latest.text, `.claude/agents/${name}.md`, `${key}@${c7(latest.commit)}`);
            if (d === "") c.io.out(`${name}: no difference from ${key}@${c7(latest.commit)}`);
            else printDiff(c, d);
            return 0;
          }
          case "update": {
            const name = a.positional[0];
            if (name === undefined || a.positional.length > 1) throw new Usage(AGENT_USAGE);
            const root = repoRoot(c, a.str("repo"));
            const { lock, entry } = lockEntry(root, name);
            const latest = await resolveKey(hub(), `${entry.source}/${entry.name}`);
            const key = canonicalKey(entry.source, entry.name);
            const installed = readInstalled(root, name);
            if (latest.hash === entry.hash && installed !== undefined && agentFileHash(installed) === entry.hash) {
              c.io.out(`${name} is up to date (${key}@${c7(entry.commit)}).`);
              return 0;
            }
            const d = unifiedDiff(installed ?? "", latest.text, `.claude/agents/${name}.md`, `${key}@${c7(latest.commit)}`);
            if (d !== "") printDiff(c, d);
            if (!a.has("yes")) {
              const answer = await ask(c, `Replace .claude/agents/${name}.md with ${key}@${c7(latest.commit)}? [y/N] `);
              if (answer === undefined) {
                c.io.err("Not updated: run with --yes to confirm without a terminal.");
                return 1;
              }
              if (!/^(y|yes)$/i.test(answer.trim())) {
                c.io.out("Not updated.");
                return 1;
              }
            }
            install(root, latest, lock);
            c.io.out(`Updated ${name} to ${key}@${c7(latest.commit)} (hash ${latest.hash.slice(0, 12)}).`);
            return 0;
          }
          case "source": {
            const [verb, ...more] = a.positional;
            if (verb === "add") {
              const repo = more[0];
              const folder = a.str("folder");
              if (repo === undefined || more.length > 1 || folder === undefined) throw new Usage(AGENT_USAGE);
              const calibrator = a.str("calibrator");
              const v = await hub().post<CatalogSourceView>("/v1/catalog-sources", { repo, folder, ...(calibrator !== undefined ? { calibrator } : {}) });
              c.io.out(`Saved catalog source ${v.repo} (folder ${v.folder}).`);
              return 0;
            }
            if (verb === "ls" && more.length === 0) {
              const r = await hub().get<{ sources: CatalogSourceView[] }>("/v1/catalog-sources");
              if (a.has("json")) c.io.out(JSON.stringify(r, null, 2));
              else if (r.sources.length === 0) c.io.out("No catalog sources.");
              else for (const s of r.sources) c.io.out(`${s.repo}  ${s.folder}  ${s.count} agent(s)  ${s.commit ? c7(s.commit) : "-"}${s.calibrator ? `  calibrator ${s.calibrator}` : ""}`);
              return 0;
            }
            throw new Usage(AGENT_USAGE);
          }
        }
        throw new Usage(AGENT_USAGE);
      }),
  };
}
