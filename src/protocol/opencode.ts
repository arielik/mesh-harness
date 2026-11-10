// OpenCode (v2) events, as the mesh plugin posts them to the daemon at /mesh/agent-event/opencode,
// and their mapping onto the core's hook events. Verified against OpenCode 2.2.4
// (docs/analysis/2026-11-10-opencode-integration.md, fixtures in test/fixtures/opencode).

import { z } from "zod";
import type { HookEvent } from "./hooks.ts";

/**
 * Version of the plugin `mesh setup --agent opencode` writes. Bump it whenever the plugin changes,
 * so `mesh doctor` can tell an old plugin from the current one (like HOOKS_VERSION).
 */
export const OPENCODE_PLUGIN_VERSION = 1;

/** Oldest OpenCode the plugin was verified against (the v2 plugin API: `ctx.event.subscribe`, `ctx.mcp.transform`). */
export const MIN_OPENCODE_VERSION = "2.2.4";

/** The OpenCode event types the plugin forwards; everything else stays in OpenCode. */
export const OPENCODE_EVENT_TYPES = [
  "session.created",
  "session.deleted",
  "session.execution.started",
  "session.execution.succeeded",
  "session.execution.failed",
  "session.execution.interrupted",
  "permission.asked",
  "permission.replied",
  "form.created",
  "form.replied",
  "form.cancelled",
  /** The plugin's server is going away (OpenCode's `location.shutdown`): every session it reported ends. */
  "location.shutdown",
] as const;
export type OpenCodeEventType = (typeof OPENCODE_EVENT_TYPES)[number];

/**
 * One event from the mesh plugin. `sessionID` is the **root** session: the plugin folds subagent
 * (child) sessions into their root and sets `child` when the event came from one.
 */
export const OpenCodeEvent = z.object({
  v: z.number().int().positive(),
  type: z.enum(OPENCODE_EVENT_TYPES),
  sessionID: z.string().min(1).optional(),
  child: z.boolean().optional(),
  cwd: z.string().optional(),
  /** The OpenCode server process the plugin runs in. */
  pid: z.number().int().positive(),
  /** A private server (`opencode --standalone`), started by and belonging to one terminal. */
  standalone: z.boolean(),
  /** $TMUX_PANE and $TMUX, sent only by a standalone server (a shared one has no terminal). */
  pane: z.string().optional(),
  tmux: z.string().optional(),
  /** $MESH_STEP and $MESH_AUTOPILOT, set by `mesh run`. */
  step: z.string().optional(),
  autopilot: z.string().optional(),
  /** When the event happened (ms). */
  at: z.number().optional(),
  /**
   * execution.succeeded: the turn's last assistant text; form.created: the first question;
   * execution.failed: the error message. Capped by the plugin.
   */
  text: z.string().max(4000).optional(),
  /** execution.started: length of the prompt that started the turn (never its text). */
  promptLength: z.number().int().nonnegative().optional(),
  /** execution.started: the prompt was typed by mesh (a delivery). */
  delivered: z.boolean().optional(),
  /** The model of the turn, as provider/model. */
  model: z.string().optional(),
});
export type OpenCodeEvent = z.infer<typeof OpenCodeEvent>;

/** The plugin asks every few seconds whether mesh has a message for one of its (root) sessions. */
export const OpenCodePoll = z.object({ sessionIDs: z.array(z.string().min(1)).max(200) });
export type OpenCodePoll = z.infer<typeof OpenCodePoll>;

/** Reply to a plugin event: a message for mesh to deliver to that session now, if any. */
export interface OpenCodeReply {
  deliver?: { sessionID: string; text: string };
}

/** How far the plugin's `at` may be from the receive time before it is ignored. */
const AT_PAST_MS = 10 * 60_000;
const AT_FUTURE_MS = 5_000;

/**
 * Map a plugin event onto the core's hook events. `undefined`: nothing for the state machine
 * (shutdown is handled by the daemon; most child events are ignored, like Claude's subagents).
 */
export function openCodeToHookEvent(e: OpenCodeEvent, receivedAt: number): HookEvent | undefined {
  if (!e.sessionID) return undefined;
  const child = e.child === true;
  const base = (kind: HookEvent["kind"]): HookEvent => {
    const ev: HookEvent = { kind, at: receivedAt, agent: "opencode", claudeSessionId: e.sessionID as string, cwd: e.cwd ?? "", pluginVersion: e.v };
    if (e.at !== undefined && e.at <= receivedAt + AT_FUTURE_MS && e.at >= receivedAt - AT_PAST_MS) ev.sentWindow = [e.at, e.at + 1];
    // A shared server hosts many sessions: its pid identifies none of them, so only a standalone
    // server's pid is kept (for liveness; see the daemon).
    ev.pid = e.pid;
    if (e.standalone && e.pane && /^%\d+$/.test(e.pane)) ev.pane = e.pane;
    const socket = e.standalone ? e.tmux?.split(",")[0] : undefined;
    if (socket) ev.tmuxSocket = socket;
    if (e.autopilot === "off" || e.autopilot === "nudge" || e.autopilot === "chain") ev.autopilot = e.autopilot;
    if (e.step && /^G\d+\.[a-z0-9-]+$/i.test(e.step)) ev.stepHint = e.step;
    if (e.model) ev.model = e.model;
    return ev;
  };
  switch (e.type) {
    case "session.created":
      return child ? undefined : base("SessionStart");
    case "session.execution.started": {
      if (child) return undefined;
      const ev = base("UserPromptSubmit");
      if (e.promptLength !== undefined) ev.promptLength = e.promptLength;
      if (e.delivered) ev.delivered = true;
      return ev;
    }
    case "session.execution.succeeded": {
      if (child) return undefined;
      const ev = base("Stop");
      if (e.text !== undefined) ev.lastAssistantMessage = e.text;
      return ev;
    }
    case "session.execution.interrupted":
      return child ? undefined : base("Stop");
    case "session.execution.failed": {
      if (child) return undefined;
      const ev = base("Notification");
      ev.notificationType = "agent_error";
      if (e.text !== undefined) ev.lastAssistantMessage = `error: ${e.text}`;
      return ev;
    }
    case "permission.asked": {
      const ev = base("Notification");
      ev.notificationType = "permission_prompt";
      return ev;
    }
    case "form.created": {
      const ev = base("Notification");
      ev.notificationType = "question";
      if (e.text !== undefined) ev.lastAssistantMessage = e.text;
      return ev;
    }
    case "permission.replied":
    case "form.replied":
    case "form.cancelled":
      return base("Resume");
    case "session.deleted": {
      if (child) return undefined;
      const ev = base("SessionEnd");
      ev.reason = "deleted";
      return ev;
    }
    case "location.shutdown":
      return undefined;
  }
}
