import { join } from "node:path";
import { z } from "zod";

/**
 * Which sessions a daemon reports to the hub (Q5, MM-1). `steps`: only sessions holding a step;
 * `me`: also the other sessions as metadata that only their owner sees; `all`: the team sees them.
 */
export const ShareLevel = z.enum(["steps", "me", "all"]);
export type ShareLevel = z.infer<typeof ShareLevel>;

/** MM-3: the rule syntax of an accept policy. */
export const ACCEPT_RULE_TEXT = "an accept rule is self, off, user:<id> or machine:<nickname or id>";
/** MM-3: one accept rule: `self`, `off`, `user:<id>` or `machine:<nickname or id>`. */
export const AcceptRule = z.string().regex(/^(self|off|user:[^\s,]{1,100}|machine:[^\s,]{1,100})$/, ACCEPT_RULE_TEXT);
/** MM-3: whose offers a machine (or session) accepts automatically; `off` only alone. */
export const AcceptPolicy = z
  .array(AcceptRule)
  .min(1)
  .max(20)
  .refine((a) => !a.includes("off") || a.length === 1, "off cannot be combined with other rules");
export type AcceptPolicy = z.infer<typeof AcceptPolicy>;

/**
 * Normalise an accept policy: a string is split on `,`; items are trimmed, empty items dropped,
 * repeats removed, order kept. The first item that is not an `AcceptRule` is an error.
 */
export function parseAccept(input: string | readonly string[]): { accept: string[] } | { error: string } {
  const items = typeof input === "string" ? input.split(",") : [...input];
  const out: string[] = [];
  for (const item of items) {
    const t = item.trim();
    if (t === "") continue;
    if (!AcceptRule.safeParse(t).success) return { error: `not an accept rule: ${t} (${ACCEPT_RULE_TEXT})` };
    if (!out.includes(t)) out.push(t);
  }
  if (out.length === 0) return { error: "give at least one rule, or off" };
  if (out.includes("off") && out.length > 1) return { error: "off cannot be combined with other rules" };
  if (out.length > 20) return { error: "at most 20 accept rules" };
  return { accept: out };
}

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
   * Which sessions the daemon reports to the hub (Q5, MM-1). `steps` (default for a file without
   * the field): full records only for sessions holding a step; the rest stay local and the hub sees
   * per-machine counts. `me` (written by `mesh setup` for new setups): also report sessions without
   * a step, as metadata only (state, repo name, session name, timestamps; no cwd, pane, transcript
   * or message text), shown to their owner only. `all`: the same metadata, shown to the team.
   */
  shareSessions: ShareLevel.default("steps"),
  /**
   * MM-3: whose offers this machine accepts automatically (`self`, `user:<id>`,
   * `machine:<nickname or id>`, or `off`). The hub sees it (synced with the machine facts).
   */
  accept: AcceptPolicy.default(["self"]),
  /**
   * MM-3: what the daemon does with an offer: `deliver` (auto-accept for an idle session, else list
   * it for you), `launch` (as deliver, but start a session when none is idle), `off` (decline every
   * offer). Local only; the hub does not see it.
   */
  assignments: z.enum(["deliver", "launch", "off"]).default("deliver"),
  /**
   * MM-4: under `assignments: launch`, an offer starts a session only while fewer than this many
   * sessions are live on the machine. Absent = no limit. Local only.
   */
  maxSessions: z.number().int().min(1).max(1000).optional(),
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
  /** RL-4: ~/.claude/skills/mesh-debrief/SKILL.md, written by `mesh setup`. */
  claudeDebriefSkill: string;
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
    claudeDebriefSkill: join(claudeConfigDir, "skills", "mesh-debrief", "SKILL.md"),
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
