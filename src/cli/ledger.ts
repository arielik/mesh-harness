// `mesh ledger`: stage a programme's pending records into the tree that commits them, and export the
// committed ledger (.mesh/goals/** across repos, at a ref) as JSONL for any analysis tool (M4, R5).

import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { parse } from "yaml";
import { LEDGER_SCHEMA, LedgerRecord } from "../protocol/index.ts";
import type { Command } from "./commands.ts";
import { parseArgs, type CliEnv } from "./context.ts";
import { hubFetch, loadCredentialsOrSolo } from "./hub-client.ts";

const KEY = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

/** The working tree root and the common git dir (shared by worktrees) for `cwd`. */
export function gitDirs(cwd: string): { root: string; common: string } | undefined {
  let dir = resolve(cwd);
  for (;;) {
    const dotGit = join(dir, ".git");
    if (existsSync(dotGit)) {
      let gitDir = dotGit;
      if (!statSync(dotGit).isDirectory()) {
        const m = /^gitdir:\s*(.+)$/m.exec(readFileSync(dotGit, "utf8"));
        if (!m?.[1]) return undefined;
        gitDir = isAbsolute(m[1].trim()) ? m[1].trim() : resolve(dir, m[1].trim());
      }
      const cd = join(gitDir, "commondir");
      const common = existsSync(cd) ? resolve(gitDir, readFileSync(cd, "utf8").trim()) : gitDir;
      return { root: dir, common };
    }
    const up = dirname(dir);
    if (up === dir) return undefined;
    dir = up;
  }
}

/** Copy pending records of `key` into this working tree; returns repo-relative paths written. */
export function stage(cwd: string, key: string): string[] {
  const g = gitDirs(cwd);
  if (!g || !KEY.test(key)) return [];
  const pending = join(g.common, "mesh", "pending", key);
  if (!existsSync(pending)) return [];
  const out: string[] = [];
  for (const name of readdirSync(pending).sort()) {
    if (!/^[A-Za-z0-9._-]+\.md$/.test(name)) continue;
    const rel = `.mesh/goals/${key}/steps/${name}`;
    mkdirSync(join(g.root, dirname(rel)), { recursive: true });
    copyFileSync(join(pending, name), join(g.root, rel));
    out.push(rel);
  }
  return out;
}

/** Front matter of a .md record, or the whole document of a .yaml record. */
export function parseRecordText(path: string, text: string): unknown {
  if (path.endsWith(".yaml") || path.endsWith(".yml")) return parse(text);
  const m = /^---\n([\s\S]*?)\n---\n?/.exec(text);
  return m ? parse(m[1] as string) : undefined;
}

function git(cwd: string, args: string[], input?: string): { ok: boolean; out: string } {
  const r = spawnSync("git", ["-C", cwd, ...args], { encoding: "utf8", maxBuffer: 256 << 20, ...(input !== undefined ? { input } : {}) });
  return { ok: r.status === 0, out: r.stdout ?? "" };
}

export interface ExportResult {
  lines: string[];
  records: number;
  invalid: { repo: string; path: string; error: string }[];
  skipped: number;
}

/** Read every record under .mesh/goals at `ref` (default origin/HEAD, else HEAD) of each repo. */
export function exportLedger(repos: readonly string[], ref: string | undefined): ExportResult {
  const res: ExportResult = { lines: [], records: 0, invalid: [], skipped: 0 };
  for (const dir of repos) {
    const g = gitDirs(dir);
    if (!g) {
      res.invalid.push({ repo: dir, path: "", error: "not a git checkout" });
      continue;
    }
    const tryRefs = ref ? [ref] : ["origin/HEAD", "HEAD"];
    let usedRef = "";
    let commit = "";
    for (const r of tryRefs) {
      const c = git(g.root, ["rev-parse", "--verify", "--quiet", `${r}^{commit}`]);
      if (c.ok && c.out.trim()) {
        usedRef = r;
        commit = c.out.trim();
        break;
      }
    }
    if (!commit) {
      res.invalid.push({ repo: dir, path: "", error: `no ref ${tryRefs.join(" or ")}` });
      continue;
    }
    const url = git(g.root, ["config", "--get", "remote.origin.url"]).out.trim();
    const repo = url ? url.replace(/\.git$/, "").replace(/^.*[:/]([^/:]+\/[^/:]+)$/, "$1") : basename(g.root);
    const files = git(g.root, ["ls-tree", "-r", "--name-only", commit, "--", ".mesh/goals"]).out.split("\n").filter((f) => /\.(md|ya?ml)$/.test(f));
    if (files.length === 0) continue;
    const batch = git(g.root, ["cat-file", "--batch"], files.map((f) => `${commit}:${f}`).join("\n") + "\n");
    const texts = splitBatch(batch.out);
    files.forEach((path, i) => {
      const text = texts[i];
      if (text === undefined) return;
      let doc: unknown;
      try {
        doc = parseRecordText(path, text);
      } catch (e) {
        res.invalid.push({ repo, path, error: `unreadable: ${String(e).slice(0, 200)}` });
        return;
      }
      if (!doc || typeof doc !== "object" || (doc as { schema?: unknown }).schema !== LEDGER_SCHEMA) {
        res.skipped++;
        return;
      }
      const v = LedgerRecord.safeParse(doc);
      if (!v.success) {
        res.invalid.push({ repo, path, error: v.error.issues.map((x) => `${x.path.join(".")}: ${x.message}`).join("; ").slice(0, 300) });
        return;
      }
      res.records++;
      res.lines.push(JSON.stringify({ kind: "record", repo, path, ref: usedRef, commit, record: doc }));
    });
  }
  return res;
}

/** Split `git cat-file --batch` output into the contents, in request order. */
function splitBatch(out: string): (string | undefined)[] {
  const buf = Buffer.from(out, "utf8");
  const texts: (string | undefined)[] = [];
  let i = 0;
  while (i < buf.length) {
    const nl = buf.indexOf(10, i);
    if (nl < 0) break;
    const header = buf.subarray(i, nl).toString("utf8");
    i = nl + 1;
    const m = /^\S+ \S+ (\d+)$/.exec(header);
    if (!m) {
      texts.push(undefined);
      continue;
    }
    const size = Number(m[1]);
    texts.push(buf.subarray(i, i + size).toString("utf8"));
    i += size + 1;
  }
  return texts;
}

export function ledgerCommand(c: CliEnv): Command {
  return {
    name: "ledger",
    summary: "the ledger: mesh ledger stage <key> | export [--repo DIR]… [--ref REF] [--out FILE] [--events]",
    async run(args) {
      const [sub, ...rest] = args;
      const a = parseArgs(rest, ["repo", "ref", "out", "hub", "token"]);
      if (sub === "stage") {
        const keys = a.has("all") ? listPending(c.cwd) : a.positional;
        if (keys.length === 0) {
          c.io.err("usage: mesh ledger stage <key>… | --all");
          return 2;
        }
        // Only paths on stdout, one per line, so a workflow can `git add` exactly these.
        for (const k of keys) for (const p of stage(c.cwd, k)) c.io.out(p);
        return 0;
      }
      if (sub === "export") {
        const repos = rest.flatMap((x, i) => (rest[i - 1] === "--repo" ? [resolve(c.cwd, x)] : x.startsWith("--repo=") ? [resolve(c.cwd, x.slice(7))] : []));
        const r = exportLedger(repos.length ? repos : [c.cwd], a.str("ref"));
        const lines = [...r.lines];
        let events = 0;
        if (a.has("events")) {
          const creds = loadCredentialsOrSolo(c.paths);
          const hub = a.str("hub") ?? creds?.hub;
          const token = a.str("token") ?? c.env.MESH_TOKEN ?? creds?.token;
          if (!hub || !token) throw new Error("--events needs a hub: mesh login, or --hub URL --token SERVICE_TOKEN");
          let after = 0;
          for (;;) {
            const { json } = await hubFetch<{ events: { seq: number }[] }>(hub, "GET", `/v1/events?after=${after}&limit=1000`, { token });
            for (const e of json.events) lines.push(JSON.stringify({ kind: "event", event: e }));
            events += json.events.length;
            if (json.events.length < 1000) break;
            after = json.events.at(-1)?.seq ?? after;
          }
        }
        const text = lines.length ? `${lines.join("\n")}\n` : "";
        const out = a.str("out");
        if (out) writeFileSync(resolve(c.cwd, out), text);
        else if (text) c.io.out(text.trimEnd());
        for (const x of r.invalid) c.io.err(`invalid: ${x.repo}${x.path ? `:${x.path}` : ""}: ${x.error}`);
        c.io.err(`${r.records} record(s)${a.has("events") ? `, ${events} event(s)` : ""}${r.skipped ? `, ${r.skipped} file(s) not in ${LEDGER_SCHEMA} skipped` : ""}${r.invalid.length ? `, ${r.invalid.length} invalid` : ""}${out ? ` → ${out}` : ""}`);
        return r.invalid.length ? 1 : 0;
      }
      c.io.err("usage: mesh ledger stage <key>… | --all\n       mesh ledger export [--repo DIR]… [--ref REF] [--out FILE] [--events [--hub URL --token T]]");
      return 2;
    },
  };
}

function listPending(cwd: string): string[] {
  const g = gitDirs(cwd);
  if (!g) return [];
  const dir = join(g.common, "mesh", "pending");
  try {
    return readdirSync(dir).filter((k) => KEY.test(k));
  } catch {
    return [];
  }
}
