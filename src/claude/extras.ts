// `mesh setup` extras from M2 (task 2.6): the user-scope MCP server and the ~/.claude/CLAUDE.md block.

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { writeFileAtomic } from "../protocol/index.ts";
import { run, type Runner } from "./exec.ts";

export const MCP_NAME = "mesh";

/** Register `mesh mcp` as a user-scope MCP server (it lives in ~/.claude.json, so use the CLI). */
export async function installMcp(argv: readonly string[], runner: Runner = run): Promise<{ ok: boolean; error?: string }> {
  await runner("claude", ["mcp", "remove", "-s", "user", MCP_NAME], { timeoutMs: 20_000 });
  const r = await runner("claude", ["mcp", "add", "-s", "user", MCP_NAME, "--", ...argv], { timeoutMs: 20_000 });
  return r.code === 0 ? { ok: true } : { ok: false, error: (r.stderr || r.stdout).trim() };
}

export async function uninstallMcp(runner: Runner = run): Promise<boolean> {
  return (await runner("claude", ["mcp", "remove", "-s", "user", MCP_NAME], { timeoutMs: 20_000 })).code === 0;
}

export async function mcpInstalled(runner: Runner = run): Promise<boolean> {
  return (await runner("claude", ["mcp", "get", MCP_NAME], { timeoutMs: 20_000 })).code === 0;
}

const BLOCK_RE = /\n*<!-- mesh:begin[\s\S]*?<!-- mesh:end -->\n?/g;
const backupOf = (p: string) => `${p}.mesh-backup`;
const absentOf = (p: string) => `${p}.mesh-absent`;

/** Append (or refresh) the mesh block; keeps the original for an exact uninstall. */
export function installClaudeMd(path: string, block: string): { changed: boolean } {
  const text = existsSync(path) ? readFileSync(path, "utf8") : undefined;
  const base = (text ?? "").replace(BLOCK_RE, "");
  const next = `${base}${base === "" ? "" : base.endsWith("\n") ? "\n" : "\n\n"}${block}\n`;
  if (text === next) return { changed: false };
  mkdirSync(dirname(path), { recursive: true });
  if (!existsSync(backupOf(path)) && !existsSync(absentOf(path))) {
    if (text === undefined) writeFileSync(absentOf(path), "");
    else writeFileSync(backupOf(path), text);
  }
  writeFileAtomic(path, next);
  return { changed: true };
}

export function uninstallClaudeMd(path: string): { changed: boolean } {
  const text = existsSync(path) ? readFileSync(path, "utf8") : undefined;
  const backup = backupOf(path);
  const absent = absentOf(path);
  let changed = false;
  if (text !== undefined) {
    const rest = text.replace(BLOCK_RE, "");
    const stripped = rest === "" || rest.endsWith("\n") ? rest : `${rest}\n`;
    if (existsSync(backup) && readFileSync(backup, "utf8").replace(BLOCK_RE, "").trimEnd() === stripped.trimEnd()) {
      const original = readFileSync(backup, "utf8");
      if (original !== text) {
        writeFileAtomic(path, original);
        changed = true;
      }
    } else if (existsSync(absent) && stripped.trim() === "") {
      rmSync(path);
      changed = true;
    } else if (stripped !== text) {
      writeFileAtomic(path, stripped);
      changed = true;
    }
  }
  if (existsSync(backup)) rmSync(backup);
  if (existsSync(absent)) rmSync(absent);
  return { changed };
}

export function claudeMdInstalled(path: string): boolean {
  return existsSync(path) && /<!-- mesh:begin/.test(readFileSync(path, "utf8"));
}
