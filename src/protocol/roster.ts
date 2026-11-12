// RL-5: the roster — agents of repos machines report and of registered catalog sources.
import { z } from "zod";
import { AgentKind, type Repo } from "./session.ts";

/** RL-1: an agent name (the file name without `.md`). */
export const AGENT_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
export const AGENT_NAME_RULE = "an agent name is 1-64 letters, digits, '.', '_' or '-', starting with a letter or digit";
export const AgentName = z.string().regex(AGENT_NAME_RE, AGENT_NAME_RULE);

const HEX40 = /^[0-9a-f]{40}$/;
const HEX64 = /^[0-9a-f]{64}$/;

/** `AgentKind` (session.ts) is reused: `claude` = `.claude/agents/`, `opencode` = `.opencode/agent/`. */

/** The front matter fields the roster shows. */
export const AgentFront = z.object({
  description: z.string().max(1000).optional(),
  model: z.string().max(100).optional(),
  tools: z.array(z.string().max(200)).max(100).optional(),
  rules: z.array(z.string().max(100)).max(200).optional(),
});
export type AgentFront = z.infer<typeof AgentFront>;

/** A pin of `.mesh/agents.lock`: `source` is the full repo id of the catalog source. */
export const AgentPin = z.object({
  source: z.string().min(1).max(200),
  commit: z.string().regex(HEX40),
  hash: z.string().regex(HEX64),
});
export type AgentPin = z.infer<typeof AgentPin>;

/** One agent file a machine reported in a repo (no text). */
export const AgentReport = AgentFront.extend({
  repo: z.string().max(200),
  kind: AgentKind,
  path: z.string().max(300),
  name: AgentName,
  hash: z.string().regex(HEX64),
  pin: AgentPin.optional(),
});
export type AgentReport = z.infer<typeof AgentReport>;

/** `<checkout>/.mesh/agents.lock`. */
export const AgentsLockEntry = z.strictObject({
  name: AgentName,
  source: z.string().min(1).max(200),
  commit: z.string().regex(HEX40),
  hash: z.string().regex(HEX64),
});
export type AgentsLockEntry = z.infer<typeof AgentsLockEntry>;
export const AgentsLock = z.object({
  version: z.literal(1),
  agents: z.array(AgentsLockEntry),
});
export type AgentsLock = z.infer<typeof AgentsLock>;

/** One pinned catalog definition (R-6). */
export const AgentDef = z.strictObject({
  key: z.string(),
  source: z.string(),
  name: AgentName,
  hash: z.string().regex(HEX64),
  commit: z.string().regex(HEX40),
});
export type AgentDef = z.infer<typeof AgentDef>;

export const ROSTER_KEY_RULE = "agent key must be <source>/<name>[@<7-64 hex>]";
/** The longest catalog source (repo) id the hub registers; also the cap of `AgentPin.source`. */
export const CATALOG_REPO_MAX = 200;
/** The longest roster key: a full source id, `/`, a 64-character name, `@` and a 64-hex hash. */
export const ROSTER_KEY_MAX = CATALOG_REPO_MAX + 1 + 64 + 1 + 64;
export const ROSTER_KEY_RE = /^([A-Za-z0-9][A-Za-z0-9._-]*(?:\/[A-Za-z0-9._-]+)*)\/([A-Za-z0-9][A-Za-z0-9._-]{0,63})(?:@([0-9a-f]{7,64}))?$/;

/** `<source>/<name>[@<ref>]` → its parts (`source` lowercased), or undefined. */
export function parseRosterKey(s: string): { source: string; name: string; ref?: string } | undefined {
  if (s.length > ROSTER_KEY_MAX) return undefined;
  const m = ROSTER_KEY_RE.exec(s);
  if (!m) return undefined;
  return { source: m[1]!.toLowerCase(), name: m[2]!, ...(m[3] ? { ref: m[3] } : {}) };
}

/** Body of `POST /v1/catalog-sources`. */
export const CatalogSourceSave = z.strictObject({
  repo: z.string().min(1).max(300),
  folder: z.string().min(1).max(200),
  calibrator: z.string().min(1).max(100).optional(),
});
export type CatalogSourceSave = z.infer<typeof CatalogSourceSave>;

/** Body of `POST /v1/catalog-sources/push`: committed texts of a source's folder at `commit`. */
export const CatalogPush = z.strictObject({
  repo: z.string().min(1).max(300),
  commit: z.string().regex(HEX40),
  defs: z
    .array(z.object({ path: z.string().min(1).max(300), text: z.string().min(1).max(100000) }))
    .max(2000),
});
export type CatalogPush = z.infer<typeof CatalogPush>;

export interface CatalogSourceView {
  /** Repo id. */
  repo: string;
  name: string;
  folder: string;
  calibrator?: string | undefined;
  createdBy: string;
  createdAt: number;
  /** Current definitions. */
  count: number;
  commit?: string | undefined;
  digest?: string | undefined;
  pushedAt?: number | undefined;
  pushedBy?: string | undefined;
}

export interface CatalogDefView extends AgentFront {
  /** Canonical key `<repo name>/<agent name>`. */
  key: string;
  /** Full repo id of the source. */
  source: string;
  name: string;
  path: string;
  hash: string;
  /** Oldest first, at most 50. */
  commits: string[];
  /** The matched or latest one. */
  commit: string;
  current: boolean;
  pushedAt: number;
  text: string;
}

export interface AgentCopy {
  key: string;
  repo: Repo;
  origin: "repo" | "catalog";
  kind: AgentKind;
  path: string;
  hash: string;
  /** Catalog copies. */
  commit?: string | undefined;
  /** Repo copies: reporting machines the viewer sees. */
  machines?: number | undefined;
  pin?: AgentPin | undefined;
  pinned: boolean;
  behind: boolean;
  modified: boolean;
  seenAt: number;
}

export interface AgentVersion extends AgentFront {
  hash: string;
  copies: AgentCopy[];
}

export interface AgentGroup {
  name: string;
  versions: AgentVersion[];
  diverged: boolean;
  pinned: boolean;
  behind: boolean;
  modified: boolean;
}

export interface AgentsView {
  agents: AgentGroup[];
  sources: CatalogSourceView[];
}
