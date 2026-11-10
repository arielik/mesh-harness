import { join } from "node:path";
import { z } from "zod";

/** ~/.config/mesh/daemon.json, written by `mesh setup` (mode 0600). */
export const DaemonConfig = z.object({
  port: z.number().int().min(1024).max(65535),
  key: z.string().min(16),
  /**
   * How mesh tells you a session needs you: `desktop` (the OS notification service), `terminal`
   * (an OSC 9 notification written to the session's own terminal; it also reaches you over SSH),
   * `both`, or `off`. `true` and `false` are the older spellings of `desktop` and `off`.
   */
  notify: z.union([z.boolean(), z.enum(["desktop", "terminal", "both", "off"])]).default(true),
  workspaceRoots: z.array(z.string()).default([]),
  /** Default autopilot level for sessions (plan §3.6). */
  autopilot: z.enum(["off", "nudge", "chain"]).default("nudge"),
  /**
   * Which sessions the daemon reports to the hub (Q5). `steps` (default): full records only for
   * sessions holding a step; the rest stay local and the hub sees per-machine counts. `all`: also
   * report sessions without a step, as metadata only (state, repo name, session name, timestamps;
   * no cwd, pane, transcript or message text). Opt-in per machine.
   */
  shareSessions: z.enum(["steps", "all"]).default("steps"),
});
export type DaemonConfig = z.infer<typeof DaemonConfig>;
export type NotifyMode = "desktop" | "terminal" | "both" | "off";

export function notifyMode(c: Pick<DaemonConfig, "notify">): NotifyMode {
  return c.notify === true ? "desktop" : c.notify === false ? "off" : c.notify;
}

export function notifyChannels(c: Pick<DaemonConfig, "notify">): { desktop: boolean; terminal: boolean; any: boolean } {
  const m = notifyMode(c);
  const desktop = m === "desktop" || m === "both";
  const terminal = m === "terminal" || m === "both";
  return { desktop, terminal, any: desktop || terminal };
}

/** The session a notification is about: its process and, inside tmux, its pane. */
export interface NotifyTarget {
  pid?: number;
  pane?: string;
  tmuxSocket?: string;
}

/** ~/.config/mesh/credentials.json, written by `mesh login` (mode 0600), shared by CLI and daemon. */
export const Credentials = z.object({
  hub: z.string().url(),
  token: z.string(),
  user: z.object({ id: z.string(), name: z.string(), roles: z.array(z.string()) }),
  machine: z.string().optional(),
});
export type Credentials = z.infer<typeof Credentials>;

export interface MeshPaths {
  credentials: string;
  claudeMd: string;
  /** ~/.claude/skills/mesh/SKILL.md, written by `mesh setup`. */
  claudeSkill: string;
  /** OpenCode's global config folder, the mesh plugin in it and mesh's skill for OpenCode. */
  opencodeConfigDir: string;
  opencodePlugin: string;
  opencodeSkill: string;
  configDir: string;
  stateDir: string;
  daemonConfig: string;
  daemonDb: string;
  claudeConfigDir: string;
  claudeSettings: string;
  /** Solo mode (M4): the daemon's local hub and the credentials it writes for the CLI. */
  soloHubDb: string;
  soloCredentials: string;
  /** This installation's own id, sent at login so the hub tells two installations of one person apart. */
  installId: string;
}

/** Resolve file locations from the environment (XDG, with MESH_* overrides for tests). */
export function resolvePaths(env: Record<string, string | undefined>, home: string): MeshPaths {
  const configDir = env.MESH_CONFIG_DIR ?? join(env.XDG_CONFIG_HOME ?? join(home, ".config"), "mesh");
  const stateDir = env.MESH_STATE_DIR ?? join(env.XDG_STATE_HOME ?? join(home, ".local", "state"), "mesh");
  const claudeConfigDir = env.CLAUDE_CONFIG_DIR ?? join(home, ".claude");
  // OpenCode's global config folder (`opencode debug paths`); OPENCODE_CONFIG_DIR replaces it.
  const opencodeConfigDir = env.OPENCODE_CONFIG_DIR ?? join(env.XDG_CONFIG_HOME ?? join(home, ".config"), "opencode");
  return {
    credentials: join(configDir, "credentials.json"),
    claudeMd: join(claudeConfigDir, "CLAUDE.md"),
    claudeSkill: join(claudeConfigDir, "skills", "mesh", "SKILL.md"),
    opencodeConfigDir,
    opencodePlugin: join(opencodeConfigDir, "plugins", "mesh-harness.js"),
    opencodeSkill: join(opencodeConfigDir, "skills", "mesh", "SKILL.md"),
    configDir,
    stateDir,
    daemonConfig: join(configDir, "daemon.json"),
    daemonDb: join(stateDir, "daemon.db"),
    claudeConfigDir,
    claudeSettings: join(claudeConfigDir, "settings.json"),
    soloHubDb: join(stateDir, "solo-hub.db"),
    soloCredentials: join(stateDir, "solo.json"),
    installId: join(configDir, "install-id"),
  };
}

/** Header carrying the per-user daemon secret on every local request. */
export const KEY_HEADER = "x-mesh-key";
