// `mesh setup --agent opencode`: one managed plugin file in OpenCode's plugins folder, plus the
// mesh skill in OpenCode's skills folder. OpenCode's own config files (opencode.json, cli.json)
// are never edited: the plugin registers the mesh MCP server itself. Uninstall removes exactly
// those files, so everything else stays byte-identical.

import { existsSync, readFileSync, readdirSync, rmSync, rmdirSync } from "node:fs";
import { dirname } from "node:path";
import { OPENCODE_PLUGIN_VERSION, writeFileAtomic } from "../protocol/index.ts";
import { PLUGIN_MARKER, pluginSource, pluginVersionOf, type PluginOptions } from "./plugin.ts";

export type PluginStatus =
  | { state: "missing" }
  | { state: "current"; version: number }
  | { state: "outdated"; version: number | undefined }
  | { state: "foreign" };

export function pluginStatus(path: string, o: PluginOptions): PluginStatus {
  if (!existsSync(path)) return { state: "missing" };
  const text = readFileSync(path, "utf8");
  if (!text.startsWith(PLUGIN_MARKER)) return { state: "foreign" };
  if (text === pluginSource(o)) return { state: "current", version: OPENCODE_PLUGIN_VERSION };
  return { state: "outdated", version: pluginVersionOf(text) };
}

/** Write (or refresh) the plugin. A file at that path mesh did not write is left alone. */
export function installPlugin(path: string, o: PluginOptions): { changed: boolean; foreign: boolean } {
  const st = pluginStatus(path, o);
  if (st.state === "foreign") return { changed: false, foreign: true };
  if (st.state === "current") return { changed: false, foreign: false };
  writeFileAtomic(path, pluginSource(o));
  return { changed: true, foreign: false };
}

/** Remove mesh's plugin (only if mesh wrote it), and the folders it leaves empty. */
export function uninstallPlugin(path: string): { changed: boolean } {
  if (!existsSync(path) || !readFileSync(path, "utf8").startsWith(PLUGIN_MARKER)) return { changed: false };
  rmSync(path);
  removeEmpty(dirname(path));
  return { changed: true };
}

/** Remove a folder when empty (mesh created it for its file). */
function removeEmpty(dir: string): void {
  try {
    if (readdirSync(dir).length === 0) rmdirSync(dir);
  } catch {
    // gone or not empty
  }
}
