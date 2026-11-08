// Installs mesh's five hooks into the user's Claude Code settings (plan §5.1, §6.2).
// Four async command hooks post to the daemon with curl; Stop is a synchronous HTTP hook
// (timeout 3 s) whose reply may carry a message (spike S1). Uninstall restores the original
// file byte for byte when nothing else changed meanwhile.

import { existsSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { HOOK_KINDS, HOOK_SLUGS, HOOKS_VERSION, writeFileAtomic, type HookKind } from "../protocol/index.ts";

export interface HookTarget {
  port: number;
  key: string;
}

type Json = null | boolean | number | string | Json[] | { [k: string]: Json };
type Obj = { [k: string]: Json };

/** Every mesh hook URL contains this path; it is how mesh recognises its own entries. */
export const MESH_HOOK_PATH = "/mesh/hook/";

export function hookUrl(t: HookTarget, kind: HookKind): string {
  return `http://127.0.0.1:${t.port}${MESH_HOOK_PATH}${HOOK_SLUGS[kind]}`;
}

export function hookCommand(t: HookTarget, kind: HookKind): string {
  return [
    "curl -s -m 2 -o /dev/null --data-binary @-",
    "-H 'Content-Type: application/json'",
    `-H 'X-Mesh-Key: ${t.key}'`,
    `-H 'X-Mesh-Hooks: ${HOOKS_VERSION}'`,
    // When the hook ran: async hooks can arrive out of order (GNU date: ns; BSD date: seconds).
    '-H "X-Mesh-At: $(date +%s%N)"',
    '-H "X-Claude-Pid: ${CLAUDE_PID:-$PPID}"',
    '-H "X-Tmux-Pane: ${TMUX_PANE:-}"',
    '-H "X-Tmux: ${TMUX:-}"',
    '-H "X-Mesh-Autopilot: ${MESH_AUTOPILOT:-}"',
    '-H "X-Mesh-Step: ${MESH_STEP:-}"',
    hookUrl(t, kind),
  ].join(" ");
}

/** The matcher group mesh adds for one hook event. */
export function meshHookGroup(t: HookTarget, kind: HookKind): Obj {
  if (kind === "Stop") {
    return { hooks: [{ type: "http", url: hookUrl(t, kind), timeout: 3, headers: { "X-Mesh-Key": t.key, "X-Mesh-Hooks": String(HOOKS_VERSION) } }] };
  }
  return { hooks: [{ type: "command", async: true, command: hookCommand(t, kind) }] };
}

function isObj(v: Json | undefined): v is Obj {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function isMeshHandler(h: Json): boolean {
  if (!isObj(h)) return false;
  const text = typeof h.command === "string" ? h.command : typeof h.url === "string" ? h.url : "";
  return text.includes(MESH_HOOK_PATH);
}

/** Remove mesh handlers; drop groups, events and the hooks object when they become empty. */
export function uninstallFrom(settings: Obj): Obj {
  const out = structuredClone(settings);
  if (!isObj(out.hooks)) return out;
  const hooks = out.hooks;
  for (const [event, groups] of Object.entries(hooks)) {
    if (!Array.isArray(groups)) continue;
    const kept = groups.flatMap((g) => {
      if (!isObj(g) || !Array.isArray(g.hooks)) return [g];
      const handlers = g.hooks.filter((h) => !isMeshHandler(h));
      if (handlers.length === g.hooks.length) return [g];
      return handlers.length === 0 ? [] : [{ ...g, hooks: handlers }];
    });
    if (kept.length === 0) delete hooks[event];
    else hooks[event] = kept;
  }
  if (Object.keys(hooks).length === 0) delete out.hooks;
  return out;
}

export function installInto(settings: Obj, t: HookTarget): Obj {
  const out = uninstallFrom(settings);
  const hooks: Obj = isObj(out.hooks) ? out.hooks : {};
  for (const kind of HOOK_KINDS) {
    const existing = hooks[kind];
    hooks[kind] = [...(Array.isArray(existing) ? existing : []), meshHookGroup(t, kind)];
  }
  out.hooks = hooks;
  return out;
}

export interface HookStatus {
  /** Events that have a mesh hook. */
  installed: HookKind[];
  /** Mesh hooks pointing at another port or key than the current config. */
  stale: HookKind[];
  /** Oldest hook-command version among the installed mesh hooks (1 = written before versioning). */
  version?: number;
}

/** The hook-command version a mesh handler was written with (1 when it carries none). */
export function handlerVersion(h: Json): number {
  if (!isObj(h)) return 1;
  if (typeof h.command === "string") {
    const m = /X-Mesh-Hooks: (\d+)/.exec(h.command);
    return m ? Number(m[1]) : 1;
  }
  const v = isObj(h.headers) ? h.headers["X-Mesh-Hooks"] : undefined;
  return typeof v === "string" && /^\d+$/.test(v) ? Number(v) : 1;
}

export function inspect(settings: Obj, t: HookTarget): HookStatus {
  const status: HookStatus = { installed: [], stale: [] };
  const hooks = isObj(settings.hooks) ? settings.hooks : {};
  for (const kind of HOOK_KINDS) {
    const groups = hooks[kind];
    if (!Array.isArray(groups)) continue;
    const mine = groups.flatMap((g) => (isObj(g) && Array.isArray(g.hooks) ? g.hooks.filter(isMeshHandler) : []));
    if (mine.length === 0) continue;
    status.installed.push(kind);
    for (const h of mine) status.version = Math.min(status.version ?? Number.MAX_SAFE_INTEGER, handlerVersion(h));
    const want = JSON.stringify(meshHookGroup(t, kind).hooks);
    if (mine.length !== 1 || JSON.stringify(mine) !== want) status.stale.push(kind);
  }
  return status;
}

// ---------- files ----------

const backupPath = (p: string) => `${p}.mesh-backup`;
const absentPath = (p: string) => `${p}.mesh-absent`;

function readSettings(path: string): { text: string | undefined; json: Obj } {
  if (!existsSync(path)) return { text: undefined, json: {} };
  const text = readFileSync(path, "utf8");
  if (text.trim() === "") return { text, json: {} };
  const parsed = JSON.parse(text) as Json;
  if (!isObj(parsed)) throw new Error(`${path} is not a JSON object`);
  return { text, json: parsed };
}

const writeAtomic = (path: string, text: string): void => writeFileAtomic(path, text);

const format = (j: Obj) => `${JSON.stringify(j, null, 2)}\n`;

/** Install hooks into a settings file. Keeps a backup of the original for an exact uninstall. */
export function installSettingsFile(path: string, t: HookTarget): { changed: boolean } {
  const { text, json } = readSettings(path);
  const next = installInto(json, t);
  if (text !== undefined && JSON.stringify(next) === JSON.stringify(json)) return { changed: false };
  mkdirSync(dirname(path), { recursive: true });
  if (!existsSync(backupPath(path)) && !existsSync(absentPath(path))) {
    if (text === undefined) writeFileSync(absentPath(path), "");
    else writeFileSync(backupPath(path), text);
  }
  writeAtomic(path, format(next));
  return { changed: true };
}

/** Remove mesh hooks from a settings file, restoring the original bytes when possible. */
export function uninstallSettingsFile(path: string): { changed: boolean } {
  const { text, json } = readSettings(path);
  const next = uninstallFrom(json);
  const backup = backupPath(path);
  const absent = absentPath(path);
  let changed = false;
  if (existsSync(backup)) {
    const original = readFileSync(backup, "utf8");
    const originalJson = original.trim() === "" ? {} : (JSON.parse(original) as Json);
    if (JSON.stringify(originalJson) === JSON.stringify(next)) {
      if (text !== original) {
        writeAtomic(path, original);
        changed = true;
      }
    } else if (JSON.stringify(next) !== JSON.stringify(json)) {
      writeAtomic(path, format(next));
      changed = true;
    }
    rmSync(backup);
  } else if (existsSync(absent) && Object.keys(next).length === 0) {
    if (text !== undefined) {
      rmSync(path);
      changed = true;
    }
    rmSync(absent);
  } else {
    if (existsSync(absent)) rmSync(absent);
    if (text !== undefined && JSON.stringify(next) !== JSON.stringify(json)) {
      writeAtomic(path, format(next));
      changed = true;
    }
  }
  return { changed };
}

export function inspectSettingsFile(path: string, t: HookTarget): HookStatus {
  return inspect(readSettings(path).json, t);
}
