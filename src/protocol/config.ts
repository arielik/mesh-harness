import { join } from "node:path";
import { z } from "zod";

/** ~/.config/mesh/daemon.json, written by `mesh setup` (mode 0600). */
export const DaemonConfig = z.object({
  port: z.number().int().min(1024).max(65535),
  key: z.string().min(16),
  notify: z.boolean().default(true),
  workspaceRoots: z.array(z.string()).default([]),
});
export type DaemonConfig = z.infer<typeof DaemonConfig>;

export interface MeshPaths {
  configDir: string;
  stateDir: string;
  daemonConfig: string;
  daemonDb: string;
  claudeConfigDir: string;
  claudeSettings: string;
}

/** Resolve file locations from the environment (XDG, with MESH_* overrides for tests). */
export function resolvePaths(env: Record<string, string | undefined>, home: string): MeshPaths {
  const configDir = env.MESH_CONFIG_DIR ?? join(env.XDG_CONFIG_HOME ?? join(home, ".config"), "mesh");
  const stateDir = env.MESH_STATE_DIR ?? join(env.XDG_STATE_HOME ?? join(home, ".local", "state"), "mesh");
  const claudeConfigDir = env.CLAUDE_CONFIG_DIR ?? join(home, ".claude");
  return {
    configDir,
    stateDir,
    daemonConfig: join(configDir, "daemon.json"),
    daemonDb: join(stateDir, "daemon.db"),
    claudeConfigDir,
    claudeSettings: join(claudeConfigDir, "settings.json"),
  };
}

/** Header carrying the per-user daemon secret on every local request. */
export const KEY_HEADER = "x-mesh-key";
