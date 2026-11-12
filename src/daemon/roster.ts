// RL-5: the roster on the daemon side: agent files of the scanned checkouts, and the committed
// definitions of catalog sources this machine has checked out.

import { lstatSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { agentFileHash, agentFront, catalogDigest } from "../core/index.ts";
import { AGENT_NAME_RE, type AgentKind, type AgentPin, type AgentReport, AgentsLock, type CatalogPush, type CatalogSourceView, type Repo } from "../protocol/index.ts";

/** Most agent reports one machine sends. */
export const AGENT_REPORT_MAX = 2000;
/** Agent files larger than this are not reported. */
const AGENT_FILE_MAX_BYTES = 262_144;

const FOLDERS: { dir: string; kind: AgentKind }[] = [
  { dir: ".claude/agents", kind: "claude" },
  { dir: ".opencode/agent", kind: "opencode" },
];

function lockPins(dir: string): Map<string, AgentPin> {
  const pins = new Map<string, AgentPin>();
  try {
    const lock = AgentsLock.safeParse(JSON.parse(readFileSync(join(dir, ".mesh", "agents.lock"), "utf8")));
    if (!lock.success) return pins;
    for (const e of lock.data.agents) if (!pins.has(e.name)) pins.set(e.name, { source: e.source, commit: e.commit, hash: e.hash });
  } catch {
    // no lock, or not JSON: no pins
  }
  return pins;
}

/** Runs git in a folder (never rejects). */
export type GitRun = (cwd: string, args: readonly string[]) => Promise<{ code: number; stdout: string; stderr: string }>;

/**
 * The pushes this machine owes the catalog sources it has checked out (first checkout of the repo
 * id in scan order): the committed content of `<folder>/` at the remote's default branch (else
 * HEAD), only when that commit descends from the stored one and the digest differs.
 */
export async function catalogPushes(o: {
  sources: readonly CatalogSourceView[];
  checkouts: readonly { dir: string; repo: Repo | undefined }[];
  git: GitRun;
  remoteName: (dir: string) => string | undefined;
  log: (line: string) => void;
}): Promise<CatalogPush[]> {
  const out: CatalogPush[] = [];
  for (const source of o.sources) {
    const checkout = o.checkouts.find((c) => c.repo?.id === source.repo);
    if (!checkout) continue;
    const dir = checkout.dir;
    const remote = o.remoteName(dir);
    let commit: string | undefined;
    if (remote) {
      const r = await o.git(dir, ["rev-parse", "--verify", "-q", `refs/remotes/${remote}/HEAD^{commit}`]);
      if (r.code === 0 && /^[0-9a-f]{40}$/.test(r.stdout.trim())) commit = r.stdout.trim();
    }
    if (!commit) {
      const r = await o.git(dir, ["rev-parse", "--verify", "-q", "HEAD^{commit}"]);
      if (r.code === 0 && /^[0-9a-f]{40}$/.test(r.stdout.trim())) commit = r.stdout.trim();
    }
    if (!commit) continue;
    const stored = source.commit;
    if (stored !== undefined) {
      if (stored === commit) continue;
      const anc = await o.git(dir, ["merge-base", "--is-ancestor", stored, commit]);
      if (anc.code !== 0) {
        o.log(`catalog push of ${source.repo} skipped: ${commit.slice(0, 7)} does not descend from ${stored.slice(0, 7)}`);
        continue;
      }
    }
    const ls = await o.git(dir, ["ls-tree", "-z", commit, "--", `${source.folder}/`]);
    if (ls.code !== 0) continue;
    const entries: { path: string; oid: string }[] = [];
    for (const rec of ls.stdout.split("\0")) {
      const m = /^(\d+) (\w+) ([0-9a-f]+)\t(.+)$/s.exec(rec);
      if (!m) continue;
      const [, mode, type, oid, path] = m as unknown as [string, string, string, string, string];
      if (type !== "blob" || (mode !== "100644" && mode !== "100755")) continue;
      if (!path.startsWith(`${source.folder}/`)) continue;
      const file = path.slice(source.folder.length + 1);
      if (file.includes("/") || !file.endsWith(".md") || !AGENT_NAME_RE.test(file.slice(0, -3))) continue;
      entries.push({ path, oid });
    }
    if (entries.length === 0) continue;
    entries.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
    const defs: { path: string; text: string }[] = [];
    for (const e of entries) {
      if (defs.length >= 2000) break;
      const blob = await o.git(dir, ["cat-file", "blob", e.oid]);
      if (blob.code !== 0) continue;
      const text = blob.stdout;
      if (text.length === 0 || text.length > 100_000) continue;
      defs.push({ path: e.path, text });
    }
    if (defs.length === 0) continue;
    const digest = catalogDigest(defs.map((d) => ({ path: d.path, hash: agentFileHash(d.text) })));
    if (stored === undefined || digest !== source.digest) out.push({ repo: source.repo, commit, defs });
  }
  return out;
}

/**
 * The agent files of remote-backed checkouts (first checkout of a repo id wins):
 * `.claude/agents/*.md` then `.opencode/agent/*.md`, names sorted, at most AGENT_REPORT_MAX.
 */
export function scanAgents(checkouts: readonly { dir: string; repo: Repo | undefined }[]): AgentReport[] {
  const out: AgentReport[] = [];
  const seen = new Set<string>();
  for (const { dir, repo } of checkouts) {
    if (!repo || repo.id.startsWith("local/") || seen.has(repo.id)) continue;
    seen.add(repo.id);
    let pins: Map<string, AgentPin> | undefined;
    for (const f of FOLDERS) {
      let names: string[];
      try {
        names = readdirSync(join(dir, f.dir));
      } catch {
        continue;
      }
      for (const file of names.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))) {
        if (!file.endsWith(".md")) continue;
        const name = file.slice(0, -3);
        if (!AGENT_NAME_RE.test(name)) continue;
        const p = join(dir, f.dir, file);
        let text: string;
        try {
          const st = lstatSync(p);
          if (!st.isFile() || st.size > AGENT_FILE_MAX_BYTES) continue;
          text = readFileSync(p, "utf8");
        } catch {
          continue;
        }
        const report: AgentReport = { ...agentFront(text), repo: repo.id, kind: f.kind, path: `${f.dir}/${file}`, name, hash: agentFileHash(text) };
        if (f.kind === "claude") {
          pins ??= lockPins(dir);
          const pin = pins.get(name);
          if (pin) report.pin = pin;
        }
        out.push(report);
        if (out.length >= AGENT_REPORT_MAX) return out;
      }
    }
  }
  return out;
}
