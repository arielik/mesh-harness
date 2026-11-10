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
