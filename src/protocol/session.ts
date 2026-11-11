import { z } from "zod";

export const SessionState = z.enum(["working", "needs_you", "idle", "stalled", "ended"]);
export type SessionState = z.infer<typeof SessionState>;

/** What a needs-you session waits for. */
export const Needs = z.enum(["permission", "question", "dialog", "input"]);
export type Needs = z.infer<typeof Needs>;

export const SessionKind = z.enum(["interactive", "background", "print", "unknown"]);
export type SessionKind = z.infer<typeof SessionKind>;

/** The coding agent a session runs in. Absent means Claude Code (records written before v0.2). */
export const AgentKind = z.enum(["claude", "opencode"]);
export type AgentKind = z.infer<typeof AgentKind>;

export function agentOf(s: { agent?: AgentKind | undefined }): AgentKind {
  return s.agent ?? "claude";
}

export const Repo = z.object({ id: z.string(), name: z.string() });

/** MM-2: what a session or machine is for. Labels use the topic-name syntax. */
export const LABEL_RULE = "a label is 1-40 characters: lowercase letters, digits, '.', '_' or '-', starting with a letter or digit";
export const MAX_LABELS = 10;
export const Label = z.string().regex(/^[a-z0-9][a-z0-9._-]{0,39}$/, LABEL_RULE);

/**
 * Normalise labels: a string is split on `,`; each item is trimmed and lowercased; empty items are
 * dropped, repeats removed, the result sorted. The first item that is not a `Label` is an error, as
 * are more than `MAX_LABELS` distinct labels.
 */
export function parseLabels(input: string | readonly string[]): { labels: string[] } | { error: string } {
  const items = typeof input === "string" ? input.split(",") : [...input];
  const set = new Set<string>();
  for (const item of items) {
    const t = item.trim();
    if (t === "") continue;
    const l = t.toLowerCase();
    if (!Label.safeParse(l).success) return { error: `not a label: ${t} (${LABEL_RULE})` };
    set.add(l);
  }
  if (set.size > MAX_LABELS) return { error: `at most ${MAX_LABELS} labels` };
  return { labels: [...set].sort() };
}
export type Repo = z.infer<typeof Repo>;

/** An agent session (Claude Code or OpenCode) as tracked by the local daemon (plan §3.1, §3.3). */
export const Session = z.object({
  /** Stable mesh id; survives /clear, compaction and resume. */
  sid: z.string(),
  /** Absent: Claude Code. */
  agent: AgentKind.optional(),
  /**
   * The agent's own session ids seen for this session (Claude session ids, or OpenCode `ses_…`
   * ids), oldest first; the last one is current. The name predates OpenCode support.
   */
  claudeSessionIds: z.array(z.string()),
  pid: z.number().int().optional(),
  cwd: z.string(),
  repo: Repo.optional(),
  kind: SessionKind,
  name: z.string().optional(),
  /** What the session is for (MM-2), topic-name syntax; absent when none, never []. */
  labels: z.array(Label).max(MAX_LABELS).optional(),
  /** Short id of a background session (claude attach/stop <id>). */
  bgId: z.string().optional(),
  pane: z.string().optional(),
  tmuxSocket: z.string().optional(),
  state: SessionState,
  needs: Needs.optional(),
  quiet: z.boolean(),
  model: z.string().optional(),
  /** From the last Stop hook. */
  effort: z.string().optional(),
  permissionMode: z.string().optional(),
  startedAt: z.number(),
  lastEventAt: z.number(),
  /**
   * Earliest moment the hook that set the current state could have run. A late async hook that
   * certainly ran before it does not change the state (hooks v2, X-Mesh-At).
   */
  stateAt: z.number().optional(),
  /** Version of the hook commands this session's last hook came from (1 = before versioning). */
  hooksVersion: z.number().int().optional(),
  /** OpenCode: version of the mesh plugin that reported this session. */
  pluginVersion: z.number().int().optional(),
  lastTurnStartAt: z.number().optional(),
  lastStopAt: z.number().optional(),
  /** Short preview of the last assistant message (local only). */
  lastMessage: z.string().optional(),
  transcriptPath: z.string().optional(),
  transcriptMtime: z.number().optional(),
  turns: z.number().int(),
  humanPrompts: z.number().int(),
  /** Latest `claude agents --json` view of this session. */
  observed: z
    .object({ at: z.number(), status: z.string().optional(), waitingFor: z.string().optional(), state: z.string().optional() })
    .optional(),
  seenByReconciler: z.boolean(),
  /**
   * A window `mesh run` opened whose Claude hasn't sent a hook yet (it may be waiting at the folder
   * trust prompt). The first hook from that pane adopts this record.
   */
  launching: z.boolean().optional(),
  endedAt: z.number().optional(),
  endedReason: z.string().optional(),
  /** Mesh step this session holds. */
  step: z.string().optional(),
  /** Autopilot level (plan §3.6). */
  autopilot: z.enum(["off", "nudge", "chain"]).optional(),
  /** Autopilot nudges sent for the current step, and whether it escalated to the person. */
  nudges: z.number().int().optional(),
  escalated: z.boolean().optional(),
  /** The agent called mesh_ask during this turn: the turn ends waiting for an answer. */
  asked: z.boolean().optional(),
});
export type Session = z.infer<typeof Session>;

export const MessageState = z.enum(["pending", "delivered", "failed"]);
export type MessageState = z.infer<typeof MessageState>;

export const Message = z.object({
  id: z.number().int(),
  sid: z.string(),
  text: z.string(),
  state: MessageState,
  method: z.string().optional(),
  createdAt: z.number(),
  deliveredAt: z.number().optional(),
  error: z.string().optional(),
  /** Id of the hub message this came from (plan §5.4). */
  hubId: z.number().int().optional(),
});
export type Message = z.infer<typeof Message>;

/** GET /local/sessions */
export const SessionsResponse = z.object({ sessions: z.array(Session), messages: z.array(Message) });
export type SessionsResponse = z.infer<typeof SessionsResponse>;

/** Reply of `POST /local/labels` (MM-2). `unknown`: labels that are not defined topics; absent when no hub could be asked. */
export type LabelsResult =
  | { session: Session; unknown?: string[] | undefined }
  | { cwd: string; labels: string[]; unknown?: string[] | undefined };

/** POST /local/say */
export const SayRequest = z.object({ target: z.string().min(1), text: z.string().min(1).max(8000) });
export type SayRequest = z.infer<typeof SayRequest>;
/** `mesh run` opened a tmux window for Claude (POST /local/launch). */
export const LaunchRequest = z.object({
  pane: z.string().regex(/^%\d+$/),
  tmuxSocket: z.string().optional(),
  cwd: z.string().min(1),
  name: z.string().optional(),
  step: z.string().optional(),
  agent: AgentKind.optional(),
});
export type LaunchRequest = z.infer<typeof LaunchRequest>;
export const SayResponse = z.object({ message: Message, sid: z.string() });
