import { z } from "zod";

/** The hooks mesh installs (plan §5.1): five for sessions, two for subagents (workflow capture, M4). */
export const HOOK_KINDS = ["SessionStart", "UserPromptSubmit", "Notification", "Stop", "SessionEnd", "SubagentStart", "SubagentStop"] as const;
export type HookKind = (typeof HOOK_KINDS)[number];

/**
 * Version of the hook commands `mesh setup` writes. Bump it whenever the installed commands change,
 * so `mesh doctor` can tell hooks written by an older mesh from current ones. v1 had no version
 * header; v2 adds X-Mesh-Hooks and X-Mesh-At (the moment the hook ran, to order async hooks).
 */
export const HOOKS_VERSION = 2;

/** URL path segment per hook, as used in the installed hook commands: /mesh/hook/<slug>. */
export const HOOK_SLUGS: Record<HookKind, string> = {
  SessionStart: "session-start",
  UserPromptSubmit: "prompt",
  Notification: "notification",
  Stop: "stop",
  SessionEnd: "session-end",
  SubagentStart: "subagent-start",
  SubagentStop: "subagent-stop",
};

export function hookKindFromSlug(slug: string): HookKind | undefined {
  return HOOK_KINDS.find((k) => HOOK_SLUGS[k] === slug);
}

/**
 * Claude Code hook input, parsed loosely: only the fields mesh relies on are checked and
 * unknown fields are kept (spike S2/S3, fixtures in test/fixtures/claude/hooks).
 */
export const HookInput = z.looseObject({
  session_id: z.string().min(1),
  cwd: z.string(),
  hook_event_name: z.string(),
  transcript_path: z.string().optional(),
  source: z.string().optional(),
  reason: z.string().optional(),
  notification_type: z.string().optional(),
  message: z.string().optional(),
  stop_hook_active: z.boolean().optional(),
  last_assistant_message: z.string().optional(),
  prompt: z.string().optional(),
  prompt_id: z.string().optional(),
  model: z.string().optional(),
  permission_mode: z.string().optional(),
  effort: z.looseObject({ level: z.string().optional() }).optional(),
  agent_id: z.string().optional(),
  agent_type: z.string().optional(),
  agent_transcript_path: z.string().optional(),
});
export type HookInput = z.infer<typeof HookInput>;

/** Request headers the installed hooks send (plan §5.1). */
export interface HookHeaders {
  claudePid?: string | undefined;
  tmuxPane?: string | undefined;
  tmux?: string | undefined;
  /** $MESH_AUTOPILOT and $MESH_STEP, set by `mesh run`. */
  autopilot?: string | undefined;
  step?: string | undefined;
  /** X-Mesh-Hooks: the version of the installed hook command (absent before v2). */
  hooks?: string | undefined;
  /** X-Mesh-At: `date +%s%N` when the hook ran (nanoseconds; seconds where %N is unsupported). */
  sentAt?: string | undefined;
}

/**
 * What the core's state machine consumes: the Claude hook kinds, plus `Resume` (the person
 * answered a permission or question prompt and the turn goes on; OpenCode reports it, Claude Code
 * has no hook for it).
 */
export type EventKind = HookKind | "Resume";

/** A hook call (or an agent event mapped onto one) normalised for the core. Never carries prompt text (only its length). */
export interface HookEvent {
  kind: EventKind;
  /** Absent: Claude Code. */
  agent?: "claude" | "opencode";
  /** OpenCode: version of the mesh plugin that sent this. */
  pluginVersion?: number;
  at: number;
  claudeSessionId: string;
  cwd: string;
  pid?: number;
  /** tmux pane id ($TMUX_PANE) and the tmux socket path (first field of $TMUX), when inside tmux. */
  pane?: string;
  tmuxSocket?: string;
  transcriptPath?: string;
  source?: string;
  reason?: string;
  notificationType?: string;
  stopHookActive?: boolean;
  lastAssistantMessage?: string;
  model?: string;
  promptId?: string;
  promptLength?: number;
  autopilot?: "off" | "nudge" | "chain";
  /** Step `mesh run --step` claimed for this session. */
  stepHint?: string;
  /** Version of the hook command that sent this (1 when it sent none). */
  hooksVersion?: number;
  /**
   * When the hook ran, as [earliest, latest] in ms, from X-Mesh-At. Async hooks can arrive out of
   * order; the window lets the core ignore a state change that is certainly older than the current one.
   */
  sentWindow?: [number, number];
  /** True when the prompt was typed by mesh (a delivery), so it is not counted as a human prompt. */
  delivered?: boolean;
  /** Stop: the effort level and permission mode of the turn. */
  effort?: string;
  permissionMode?: string;
  /** SubagentStart/SubagentStop. */
  agentId?: string;
  agentType?: string;
  agentTranscriptPath?: string;
}

/** How far X-Mesh-At may be from the receive time before it is ignored (clock or parsing trouble). */
const SENT_AT_PAST_MS = 10 * 60_000;
const SENT_AT_FUTURE_MS = 5_000;

/**
 * Parse X-Mesh-At into a [earliest, latest] window in ms. GNU date prints nanoseconds; BSD and
 * busybox date print the seconds followed by a literal `N` or `%N`, which gives a one-second window.
 */
export function parseSentAt(value: string | undefined, receivedAt: number): [number, number] | undefined {
  if (!value) return undefined;
  let w: [number, number] | undefined;
  if (/^\d{16,}$/.test(value)) {
    const ms = Number(BigInt(value) / 1_000_000n);
    w = [ms, ms + 1];
  } else {
    const m = /^(\d{9,11})(?:%?N)?$/.exec(value);
    if (m) w = [Number(m[1]) * 1000, Number(m[1]) * 1000 + 1000];
  }
  if (!w) return undefined;
  if (w[0] > receivedAt + SENT_AT_FUTURE_MS || w[1] < receivedAt - SENT_AT_PAST_MS) return undefined;
  return w;
}

export function toHookEvent(kind: HookKind, input: HookInput, headers: HookHeaders, at: number): HookEvent {
  const ev: HookEvent = { kind, at, claudeSessionId: input.session_id, cwd: input.cwd };
  const version = Number(headers.hooks);
  ev.hooksVersion = Number.isInteger(version) && version > 0 ? version : 1;
  const sent = parseSentAt(headers.sentAt, at);
  if (sent) ev.sentWindow = sent;
  const pid = Number(headers.claudePid);
  if (Number.isInteger(pid) && pid > 0) ev.pid = pid;
  if (headers.tmuxPane && /^%\d+$/.test(headers.tmuxPane)) ev.pane = headers.tmuxPane;
  const socket = headers.tmux?.split(",")[0];
  if (socket) ev.tmuxSocket = socket;
  if (headers.autopilot === "off" || headers.autopilot === "nudge" || headers.autopilot === "chain") ev.autopilot = headers.autopilot;
  if (headers.step && /^G\d+\.[a-z0-9-]+$/i.test(headers.step)) ev.stepHint = headers.step;
  if (input.transcript_path !== undefined) ev.transcriptPath = input.transcript_path;
  if (input.source !== undefined) ev.source = input.source;
  if (input.reason !== undefined) ev.reason = input.reason;
  if (input.notification_type !== undefined) ev.notificationType = input.notification_type;
  if (input.stop_hook_active !== undefined) ev.stopHookActive = input.stop_hook_active;
  if (input.last_assistant_message !== undefined) ev.lastAssistantMessage = input.last_assistant_message;
  if (input.model !== undefined) ev.model = input.model;
  if (input.prompt_id !== undefined) ev.promptId = input.prompt_id;
  if (input.prompt !== undefined) ev.promptLength = input.prompt.length;
  if (input.permission_mode !== undefined) ev.permissionMode = input.permission_mode;
  if (input.effort?.level !== undefined) ev.effort = input.effort.level;
  if (input.agent_id !== undefined) ev.agentId = input.agent_id;
  if (input.agent_type !== undefined) ev.agentType = input.agent_type;
  if (input.agent_transcript_path !== undefined) ev.agentTranscriptPath = input.agent_transcript_path;
  return ev;
}

/** Reply body for the synchronous Stop hook (plan §5.1). */
export function stopReply(message: string | undefined): object {
  if (message === undefined) return {};
  return { hookSpecificOutput: { hookEventName: "Stop", additionalContext: message } };
}
