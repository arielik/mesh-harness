// Session state (plan §3.1, §3.3). Pure: callers pass the clock and an id generator.
//
// Two inputs drive state: hook events (fast, but no Stop on interrupted turns and Notification
// timing quirks, spikes S1/S2) and `claude agents --json` observations (authoritative for
// busy/waiting/idle, spike S7). Sessions are bound by Claude pid so /clear, startup id switches and
// resume keep one stable `sid` (spike S9).

import type { AgentEntry, HookEvent, Needs, Session, SessionKind } from "../protocol/index.ts";

export interface Rules {
  /** Idle with an unfinished step for this long → stalled. */
  stallAfterMs: number;
  /** Working but the transcript hasn't changed for this long → quiet flag. */
  quietAfterMs: number;
  /** No hooks, unchanged transcript and never seen by the reconciler for this long → ended (presumed). */
  presumedEndAfterMs: number;
  /** A reconciler observation older than this is not trusted over hooks. */
  observationFreshMs: number;
}

export const DEFAULT_RULES: Rules = {
  stallAfterMs: 5 * 60_000,
  quietAfterMs: 20 * 60_000,
  presumedEndAfterMs: 6 * 60 * 60_000,
  observationFreshMs: 15_000,
};

export interface Ctx {
  now: number;
  newId: () => string;
  rules?: Rules;
}

export interface Result {
  sessions: Session[];
  /** sids whose record changed. */
  changed: string[];
}

const PREVIEW = 240;

function preview(text: string | undefined): string | undefined {
  if (text === undefined) return undefined;
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > PREVIEW ? `${flat.slice(0, PREVIEW - 1)}…` : flat;
}

/** A turn that ends by asking the user something (spike S7: such sessions read `idle`). */
export function endsWithQuestion(text: string | undefined): boolean {
  if (!text) return false;
  const t = text.trim().replace(/[*_`)\]"'\s]+$/, "");
  return t.endsWith("?");
}

function blank(sid: string, cwd: string, now: number, kind: SessionKind): Session {
  return {
    sid,
    claudeSessionIds: [],
    cwd,
    kind,
    state: "idle",
    quiet: false,
    startedAt: now,
    lastEventAt: now,
    turns: 0,
    humanPrompts: 0,
    seenByReconciler: false,
  };
}

function addClaudeId(s: Session, id: string | undefined): void {
  if (!id) return;
  const i = s.claudeSessionIds.indexOf(id);
  if (i === s.claudeSessionIds.length - 1 && i >= 0) return;
  if (i >= 0) s.claudeSessionIds.splice(i, 1);
  s.claudeSessionIds.push(id);
}

function revive(s: Session): void {
  if (s.state !== "ended") return;
  s.state = "idle";
  delete s.endedAt;
  delete s.endedReason;
  delete s.needs;
}

function setNeeds(s: Session, needs: Needs): void {
  s.state = "needs_you";
  s.needs = needs;
  s.quiet = false;
}

function setIdle(s: Session): void {
  s.state = "idle";
  delete s.needs;
  s.quiet = false;
}

function setWorking(s: Session): void {
  s.state = "working";
  delete s.needs;
}

function end(s: Session, now: number, reason: string): void {
  s.state = "ended";
  s.endedAt = now;
  s.endedReason = reason;
  delete s.needs;
  s.quiet = false;
}

/** Find (or create) the session a hook belongs to. Returns a mutable copy and whether it is new. */
function bind(sessions: Session[], ev: HookEvent, ctx: Ctx): { s: Session; index: number } {
  let index = sessions.findIndex((x) => x.claudeSessionIds.includes(ev.claudeSessionId) && x.state !== "ended");
  if (index < 0 && ev.pid !== undefined && ev.agent !== "opencode") {
    // Same live process and folder: /clear or a startup id switch (spike S9). Not for OpenCode: one
    // OpenCode server hosts many sessions, each with its own id.
    index = sessions.findIndex((x) => x.agent !== "opencode" && x.pid === ev.pid && x.cwd === ev.cwd && x.state !== "ended");
  }
  if (index < 0) {
    // Resume of a known (ended) session: newest match wins.
    for (let i = sessions.length - 1; i >= 0; i--) {
      if (sessions[i]?.claudeSessionIds.includes(ev.claudeSessionId)) {
        index = i;
        break;
      }
    }
  }
  if (index < 0 && ev.pane !== undefined) {
    // The first hook from a window `mesh run` opened takes over its placeholder.
    index = sessions.findIndex((x) => x.launching && x.state !== "ended" && samePane(x, ev.pane, ev.tmuxSocket));
  }
  if (index >= 0) {
    const existing = sessions[index] as Session;
    return { s: structuredClone(existing), index };
  }
  return { s: blank(ctx.newId(), ev.cwd, ev.at, "unknown"), index: -1 };
}

function samePane(s: Session, pane: string | undefined, socket: string | undefined): boolean {
  return pane !== undefined && s.pane === pane && (s.tmuxSocket === undefined || socket === undefined || s.tmuxSocket === socket);
}

/** A placeholder another record took over: ended, and hidden from the list (see `isHidden`). */
function retire(s: Session, now: number): void {
  end(s, now, "started");
}

function put(sessions: Session[], s: Session, index: number): Session[] {
  const next = sessions.slice();
  if (index >= 0) next[index] = s;
  else next.push(s);
  return next;
}

export function applyHook(sessions: Session[], ev: HookEvent, ctx: Ctx): Result {
  const bound = bind(sessions, ev, ctx);
  const { s, index } = bound;
  const wasLaunching = s.launching === true;
  delete s.launching;
  if (wasLaunching) {
    // Claude started: from here on the hooks drive the state (the placeholder's is a guess).
    s.kind = "interactive";
    setIdle(s);
  }
  // A placeholder for this pane that another record took over (the reconciler saw Claude first).
  const retired: string[] = [];
  if (ev.pane !== undefined) {
    sessions = sessions.map((x, i) => {
      if (i === index || !x.launching || x.state === "ended" || !samePane(x, ev.pane, ev.tmuxSocket)) return x;
      const y = structuredClone(x);
      retire(y, ctx.now);
      retired.push(y.sid);
      return y;
    });
  }

  if (ev.agent === "opencode") s.agent = "opencode";
  if (ev.pluginVersion !== undefined) s.pluginVersion = ev.pluginVersion;
  if (ev.kind !== "SessionEnd" || ev.reason !== "clear") addClaudeId(s, ev.claudeSessionId);
  if (ev.pid !== undefined) s.pid = ev.pid;
  if (ev.pane !== undefined) s.pane = ev.pane;
  if (ev.tmuxSocket !== undefined) s.tmuxSocket = ev.tmuxSocket;
  if (ev.transcriptPath !== undefined) s.transcriptPath = ev.transcriptPath;
  if (ev.model !== undefined) s.model = ev.model;
  if (ev.effort !== undefined) s.effort = ev.effort;
  if (ev.permissionMode !== undefined) s.permissionMode = ev.permissionMode;
  if (ev.autopilot !== undefined && s.autopilot === undefined) s.autopilot = ev.autopilot;
  if (ev.cwd) s.cwd = ev.cwd;
  s.lastEventAt = Math.max(s.lastEventAt, ev.at);
  if (ev.hooksVersion !== undefined) s.hooksVersion = ev.hooksVersion;

  // Async hooks can arrive out of order (a UserPromptSubmit after the Stop that ended its turn, or
  // after SessionEnd). A hook that certainly ran before the hook that set the current state still
  // updates counters and metadata, but not the state.
  const [ranFrom, ranBy] = ev.sentWindow ?? [ev.at, ev.at];
  // Strictly earlier: hooks received in the same millisecond, in order, all apply.
  const stale = s.stateAt !== undefined && ranBy < s.stateAt;
  const before = { state: s.state, needs: s.needs };

  switch (ev.kind) {
    case "SessionStart":
      if (stale) break;
      revive(s);
      if (s.state !== "working") setIdle(s);
      break;
    case "UserPromptSubmit":
      if (!stale) {
        revive(s);
        setWorking(s);
        s.quiet = false;
        delete s.asked;
      }
      s.lastTurnStartAt = Math.max(s.lastTurnStartAt ?? 0, ranFrom);
      s.turns += 1;
      if (!ev.delivered) {
        s.humanPrompts += 1;
        if (!stale) {
          // A person stepped in: autopilot starts counting again.
          delete s.nudges;
          delete s.escalated;
        }
      }
      break;
    case "Notification":
      if (stale) break;
      if (ev.notificationType === "permission_prompt") setNeeds(s, "permission");
      else if (ev.notificationType === "question" || ev.notificationType === "agent_error") {
        // OpenCode: a question form is open, or the turn failed. Both wait for the person.
        setNeeds(s, ev.notificationType === "question" ? "question" : "input");
        const msg = preview(ev.lastAssistantMessage);
        if (msg !== undefined) s.lastMessage = msg;
      } else if (ev.notificationType === "agent_needs_input" || ev.notificationType?.startsWith("elicitation_dialog"))
        setNeeds(s, "input");
      // idle_prompt means "finished about 60 s ago" (spike S2): no state change.
      break;
    case "Stop": {
      s.lastStopAt = Math.max(s.lastStopAt ?? 0, ev.at);
      if (stale) break;
      const msg = preview(ev.lastAssistantMessage);
      if (msg !== undefined) s.lastMessage = msg;
      if (s.asked || endsWithQuestion(ev.lastAssistantMessage)) setNeeds(s, "question");
      else setIdle(s);
      break;
    }
    case "Resume":
      // The person answered the prompt (OpenCode): the turn goes on.
      if (!stale && s.state === "needs_you") setWorking(s);
      break;
    case "SessionEnd":
      // /clear is followed by a SessionStart with a new id on the same pid (spike S9).
      if (ev.reason !== "clear") end(s, ev.at, ev.reason ?? "ended");
      break;
  }
  const setsState =
    !stale &&
    (ev.kind === "SessionStart" ||
      ev.kind === "UserPromptSubmit" ||
      ev.kind === "Stop" ||
      (ev.kind === "SessionEnd" && ev.reason !== "clear") ||
      ((ev.kind === "Notification" || ev.kind === "Resume") && (s.state !== before.state || s.needs !== before.needs)));
  if (setsState) s.stateAt = Math.max(s.stateAt ?? 0, ranFrom);
  return { sessions: put(sessions, s, index), changed: [s.sid, ...retired] };
}

function kindOf(entry: AgentEntry): SessionKind {
  return entry.kind === "interactive" || entry.kind === "background" ? entry.kind : "unknown";
}

function applyEntry(s: Session, e: AgentEntry, now: number): void {
  s.seenByReconciler = true;
  s.kind = kindOf(e);
  if (e.pid !== undefined) s.pid = e.pid;
  if (e.name !== undefined) s.name = e.name;
  if (e.id !== undefined) s.bgId = e.id;
  if (e.cwd && !s.cwd) s.cwd = e.cwd;
  addClaudeId(s, e.sessionId);
  s.observed = { at: now };
  if (e.status !== undefined) s.observed.status = e.status;
  if (e.waitingFor !== undefined) s.observed.waitingFor = e.waitingFor;
  if (e.state !== undefined) s.observed.state = e.state;

  if (e.pid !== undefined && e.status !== undefined) {
    revive(s);
    if (e.status === "busy") {
      setWorking(s);
    } else if (e.status === "waiting") {
      const w = e.waitingFor ?? "";
      setNeeds(s, w === "permission prompt" ? "permission" : w === "dialog open" ? "dialog" : "input");
    } else if (e.status === "idle") {
      // A question asked in plain text also reads idle; keep it (spike S7).
      if (!(s.state === "needs_you" && s.needs === "question")) setIdle(s);
    }
    return;
  }
  // Background session without a live process.
  switch (e.state) {
    case "working":
      revive(s);
      setWorking(s);
      break;
    case "blocked":
      revive(s);
      setNeeds(s, "input");
      break;
    case "done":
      revive(s);
      if (!(s.state === "needs_you" && s.needs === "question")) setIdle(s);
      break;
    case "failed":
    case "stopped":
      if (s.state !== "ended") end(s, now, e.state);
      break;
  }
}

/**
 * Apply one full `claude agents --json --all` listing. Sessions previously seen by the reconciler
 * whose process is no longer listed have ended (crash without SessionEnd included).
 */
export function applyObservation(sessions: Session[], entries: AgentEntry[], ctx: Ctx): Result {
  const next = sessions.map((x) => structuredClone(x));
  const changed = new Set<string>();
  const touched = new Set<string>();

  for (const e of entries) {
    let s =
      (e.pid !== undefined ? next.find((x) => x.pid === e.pid && x.state !== "ended") : undefined) ??
      (e.sessionId ? next.find((x) => x.claudeSessionIds.includes(e.sessionId as string)) : undefined) ??
      (e.id ? next.find((x) => x.bgId === e.id) : undefined);
    if (!s) {
      // Ended background sessions linger in the list; don't resurrect what we never tracked.
      if (e.pid === undefined && (e.state === "stopped" || e.state === "failed" || e.state === "done")) continue;
      // A window `mesh run` opened in this folder: the Claude now running there is its session.
      const placeholders = e.pid !== undefined && e.cwd ? next.filter((x) => x.launching && x.state !== "ended" && x.cwd === e.cwd) : [];
      if (placeholders.length === 1) {
        s = placeholders[0] as Session;
        delete s.launching;
        if (s.state === "needs_you" && s.needs === "dialog") setWorking(s);
      } else {
        s = blank(ctx.newId(), e.cwd ?? "", e.startedAt ?? ctx.now, kindOf(e));
        next.push(s);
      }
    }
    const before = JSON.stringify(s);
    applyEntry(s, e, ctx.now);
    touched.add(s.sid);
    if (JSON.stringify(s) !== before) changed.add(s.sid);
  }

  const livePids = new Set(entries.filter((e) => e.pid !== undefined).map((e) => e.pid));
  for (const s of next) {
    if (touched.has(s.sid) || s.state === "ended" || !s.seenByReconciler) continue;
    if (s.pid !== undefined && !livePids.has(s.pid)) {
      end(s, ctx.now, "process exited");
      changed.add(s.sid);
    }
  }
  return { sessions: next, changed: [...changed] };
}

export interface Launch {
  pane: string;
  tmuxSocket?: string | undefined;
  cwd: string;
  name?: string | undefined;
  step?: string | undefined;
  agent?: "claude" | "opencode" | undefined;
}

/**
 * `mesh run` opened a tmux window for Claude. Until Claude's first hook arrives (it may sit at the
 * folder trust prompt, which runs no hooks), list the window as a placeholder bound to its pane.
 */
export function applyLaunch(sessions: Session[], l: Launch, ctx: Ctx): Result {
  if (sessions.some((x) => x.state !== "ended" && samePane(x, l.pane, l.tmuxSocket))) return { sessions, changed: [] };
  const s = blank(ctx.newId(), l.cwd, ctx.now, "interactive");
  s.launching = true;
  s.state = "working";
  s.pane = l.pane;
  if (l.tmuxSocket) s.tmuxSocket = l.tmuxSocket;
  if (l.name) s.name = l.name;
  if (l.step) s.step = l.step;
  if (l.agent === "opencode") s.agent = "opencode";
  return { sessions: [...sessions, s], changed: [s.sid] };
}

/** Claude Code's folder trust prompt, as it reads on screen. */
export function isTrustPrompt(screen: string): boolean {
  return /trust this folder|Do you trust the files in this folder/i.test(screen);
}

/**
 * What a placeholder's pane shows: `undefined` when the pane is gone (the window closed, or Claude
 * exited at the prompt), else its text.
 */
export function applyLaunchScreen(sessions: Session[], sid: string, screen: string | undefined, ctx: Ctx): Result {
  const i = sessions.findIndex((x) => x.sid === sid);
  const orig = sessions[i];
  if (!orig?.launching || orig.state === "ended") return { sessions, changed: [] };
  const s = structuredClone(orig);
  if (screen === undefined) end(s, ctx.now, "window closed before Claude started");
  else if (isTrustPrompt(screen)) setNeeds(s, "dialog");
  // OpenCode creates its session with the first prompt: until then the window waits for one.
  else if (s.agent === "opencode") setIdle(s);
  else setWorking(s);
  if (JSON.stringify(s) === JSON.stringify(orig)) return { sessions, changed: [] };
  return { sessions: put(sessions, s, i), changed: [sid] };
}

/** Records the list never shows: placeholders that ended (taken over, or their window closed). */
export function isHidden(s: Session): boolean {
  return s.launching === true && s.state === "ended";
}

/** Record the transcript file's modification time (daemon stats it every 30 s). */
export function applyTranscriptMtime(sessions: Session[], sid: string, mtime: number): Result {
  const i = sessions.findIndex((s) => s.sid === sid);
  if (i < 0 || sessions[i]?.transcriptMtime === mtime) return { sessions, changed: [] };
  const s = { ...(sessions[i] as Session), transcriptMtime: mtime };
  return { sessions: put(sessions, s, i), changed: [sid] };
}

/** Time-based rules: quiet flag, stalled, presumed end. */
export function applyTick(sessions: Session[], ctx: Ctx): Result {
  const rules = ctx.rules ?? DEFAULT_RULES;
  const changed: string[] = [];
  const next = sessions.map((orig) => {
    if (orig.state === "ended") return orig;
    const s = structuredClone(orig);
    const activity = Math.max(s.lastEventAt, s.transcriptMtime ?? 0);
    if (s.state === "working") {
      const quiet = s.transcriptMtime !== undefined && ctx.now - activity > rules.quietAfterMs;
      s.quiet = quiet;
    } else {
      s.quiet = false;
    }
    if (s.state === "idle" && s.step !== undefined && ctx.now - (s.lastStopAt ?? s.lastEventAt) > rules.stallAfterMs) {
      s.state = "stalled";
    }
    if (!s.seenByReconciler && ctx.now - activity > rules.presumedEndAfterMs) {
      end(s, ctx.now, "presumed ended");
    }
    if (JSON.stringify(s) !== JSON.stringify(orig)) {
      changed.push(s.sid);
      return s;
    }
    return orig;
  });
  return { sessions: next, changed };
}

/** Is a fresh reconciler observation telling us the prompt is free (idle, no dialog)? Plan §6.4. */
export function promptIsFree(s: Session, now: number, rules: Rules = DEFAULT_RULES): boolean {
  const o = s.observed;
  if (!o || now - o.at > rules.observationFreshMs) return false;
  return o.status === "idle" && o.waitingFor === undefined;
}

/** Find a session by a user-facing selector: sid prefix, bg id, name, pane, repo name or cwd basename. */
export function findSession(sessions: Session[], selector: string): Session | undefined {
  const q = selector.toLowerCase();
  const live = sessions.filter((s) => s.state !== "ended");
  const exact = (s: Session) =>
    s.sid === selector ||
    s.bgId === selector ||
    s.pane === selector ||
    s.claudeSessionIds.at(-1) === selector ||
    s.name?.toLowerCase() === q ||
    s.repo?.name === q;
  return (
    live.find(exact) ??
    live.find((s) => s.sid.startsWith(selector) || s.claudeSessionIds.some((id) => id.startsWith(selector))) ??
    live.find((s) => s.cwd.toLowerCase().endsWith(`/${q}`))
  );
}

/** Short human label: Claude session name, else repo name, else the folder name. */
export function sessionLabel(s: Session): string {
  if (s.name) return s.name;
  if (s.repo) return s.repo.name;
  const parts = s.cwd.split("/").filter(Boolean);
  return parts.at(-1) ?? s.sid.slice(0, 8);
}

/** What a needs-you session waits for, in words. */
export function needsLabel(s: Session): string {
  switch (s.needs) {
    case "permission":
      return "permission";
    case "question":
      return s.lastMessage ? `asks: ${s.lastMessage}` : "asked a question";
    case "dialog":
      return s.launching ? "accept Claude's folder trust prompt" : "dialog open (workspace trust?)";
    case "input":
      return "waiting for input";
    default:
      return "needs you";
  }
}
