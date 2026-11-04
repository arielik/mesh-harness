// mesh up: the local daemon (plan §6). Receives the five hooks, reconciles with
// `claude agents --json`, tracks transcript activity, delivers messages and notifies.

import { randomUUID, timingSafeEqual } from "node:crypto";
import { hostname } from "node:os";
import { statSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import {
  applyHook,
  applyObservation,
  applyTick,
  applyTranscriptMtime,
  decide,
  DEFAULT_RULES,
  findSession,
  needsLabel,
  sessionLabel,
  type Result,
  type Rules,
} from "../core/index.ts";
import {
  HookInput,
  hookKindFromSlug,
  KEY_HEADER,
  SayRequest,
  stopReply,
  toHookEvent,
  ToolCall,
  TOOL_NAMES,
  type InboxMessage,
  type ToolName,
  type AgentEntry,
  type DaemonConfig,
  type HookEvent,
  type HookKind,
  type Message,
  type Repo,
  type Session,
  type SessionsResponse,
} from "../protocol/index.ts";
import type { DaemonStore } from "../store/index.ts";
import { MESSAGE_TTL_MS, planDelivery } from "./delivery.ts";
import { repoForCwd } from "./git.ts";
import { HubLink, type LinkStatus } from "./hub-link.ts";
import { runTool, stepMessage, type ToolHost } from "./tools.ts";

export interface DaemonDeps {
  listAgents(): Promise<AgentEntry[] | null>;
  paste(pane: string, text: string, server: { socketPath?: string | undefined }): Promise<boolean>;
  wakeBackground(t: { bgId: string; sessionId: string; cwd: string }, text: string): Promise<{ ok: boolean; error?: string }>;
  notify(title: string, body: string): Promise<unknown>;
  now(): number;
  newId(): string;
  repoForCwd(cwd: string): Repo | undefined;
  mtime(path: string): number | undefined;
  log(line: string): void;
  /** fetch used for the hub (tests inject one). */
  fetch?: typeof fetch;
}

export const defaultDeps = (overrides: Partial<DaemonDeps> & Pick<DaemonDeps, "listAgents" | "paste" | "wakeBackground" | "notify">): DaemonDeps => ({
  now: () => Date.now(),
  newId: () => randomUUID(),
  repoForCwd,
  mtime: (p) => {
    try {
      return statSync(p).mtimeMs;
    } catch {
      return undefined;
    }
  },
  log: (line) => process.stderr.write(`${new Date().toISOString()} ${line}\n`),
  ...overrides,
});

export interface Intervals {
  reconcileMs: number;
  transcriptMs: number;
  tickMs: number;
  deliveryMs: number;
}

export const DEFAULT_INTERVALS: Intervals = { reconcileMs: 5_000, transcriptMs: 30_000, tickMs: 15_000, deliveryMs: 10_000 };

/** Ended sessions stay visible this long. */
const SHOW_ENDED_MS = 10 * 60_000;
const MAX_BODY = 1 << 20;

class HttpError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export class Daemon {
  sessions: Session[] = [];
  private server: Server | undefined;
  private timers: NodeJS.Timeout[] = [];
  private delivering = new Set<string>();
  /** Recently typed deliveries, to tag the resulting UserPromptSubmit as not human. */
  private typed: { text: string; at: number }[] = [];
  private notified = new Map<string, string>();
  private reconciling = false;
  port = 0;

  readonly config: DaemonConfig;
  readonly store: DaemonStore;
  readonly deps: DaemonDeps;
  readonly rules: Rules;
  readonly intervals: Intervals;
  readonly link: HubLink | undefined;

  constructor(opts: { config: DaemonConfig; store: DaemonStore; deps: DaemonDeps; rules?: Rules; intervals?: Partial<Intervals>; credentialsPath?: string }) {
    this.config = opts.config;
    this.store = opts.store;
    this.deps = opts.deps;
    this.rules = opts.rules ?? DEFAULT_RULES;
    this.intervals = { ...DEFAULT_INTERVALS, ...opts.intervals };
    if (opts.credentialsPath) {
      this.link = new HubLink({
        credentialsPath: opts.credentialsPath,
        store: this.store,
        sessions: () => this.sessions,
        onMessage: (m) => this.receive(m),
        log: (l) => this.deps.log(l),
        now: () => this.deps.now(),
        ...(this.deps.fetch ? { fetch: this.deps.fetch } : {}),
      });
    }
  }

  async start(port = this.config.port): Promise<void> {
    this.sessions = this.store.loadSessions();
    this.server = createServer((req, res) => void this.handle(req, res));
    await new Promise<void>((resolve, reject) => {
      this.server?.once("error", reject);
      this.server?.listen(port, "127.0.0.1", () => resolve());
    });
    const addr = this.server.address();
    this.port = typeof addr === "object" && addr ? addr.port : port;
    const every = (ms: number, fn: () => Promise<unknown> | unknown) => {
      if (ms > 0) this.timers.push(setInterval(() => void Promise.resolve(fn()).catch((e) => this.deps.log(`error: ${String(e)}`)), ms));
    };
    every(this.intervals.reconcileMs, () => this.reconcile());
    every(this.intervals.transcriptMs, () => this.checkTranscripts());
    every(this.intervals.tickMs, () => this.tick());
    every(this.intervals.deliveryMs, () => this.deliverPending());
    every(this.intervals.deliveryMs * 3, () => this.link?.pullInbox());
    if (this.link) {
      this.link.credentials();
      if (this.intervals.reconcileMs > 0) this.link.startStream();
    }
    void this.reconcile().catch((e) => this.deps.log(`error: ${String(e)}`));
    this.deps.log(`mesh daemon listening on 127.0.0.1:${this.port}`);
  }

  async stop(): Promise<void> {
    this.link?.stop();
    for (const t of this.timers) clearInterval(t);
    this.timers = [];
    if (this.server) {
      this.server.closeAllConnections();
      await new Promise<void>((r) => this.server?.close(() => r()));
    }
    this.server = undefined;
  }

  // ---------- state ----------

  private commit(result: Result): void {
    const before = new Map(this.sessions.map((s) => [s.sid, s]));
    this.sessions = result.sessions;
    if (result.changed.length === 0) return;
    const changed = this.sessions.filter((s) => result.changed.includes(s.sid));
    for (const s of changed) {
      if (!s.repo && s.cwd) {
        const repo = this.deps.repoForCwd(s.cwd);
        if (repo) s.repo = repo;
      }
    }
    this.store.saveSessions(changed, this.deps.now());
    for (const s of changed) {
      this.maybeNotify(before.get(s.sid), s);
      this.observe(before.get(s.sid), s);
    }
  }

  /** Spool hub events for sessions that hold a step (others stay private, plan Q5). */
  private observe(prev: Session | undefined, s: Session): void {
    if (!this.link || (!s.step && !prev?.step)) return;
    const at = this.deps.now();
    const base = { sid: s.sid, ...(s.step ? { step: s.step } : {}) };
    const add = (type: string, payload: Record<string, unknown> = {}) => this.link?.enqueue({ id: randomUUID(), at, type, ...base, payload: { repo: s.repo?.name, ...payload } });
    if (prev && s.claudeSessionIds.length > prev.claudeSessionIds.length) add("session.rebound");
    if (prev?.state === s.state && prev?.needs === s.needs) return;
    if (s.state === "working") add("session.turn_started");
    else if (s.state === "idle" && prev?.state === "working") add("session.turn_stopped");
    else if (s.state === "needs_you") add("session.waiting", { needs: s.needs });
    else if (s.state === "stalled") add("session.stalled");
    else if (s.state === "ended") add("session.ended", { reason: s.endedReason });
  }

  /** Change a session outside the reducers (tool calls, autopilot). */
  update(sid: string, patch: Partial<Session> & { clearStep?: boolean }): Session | undefined {
    const i = this.sessions.findIndex((x) => x.sid === sid);
    if (i < 0) return undefined;
    const { clearStep, ...rest } = patch;
    const s: Session = { ...(this.sessions[i] as Session), ...rest };
    if (clearStep) {
      delete s.step;
      delete s.nudges;
      delete s.escalated;
    }
    for (const k of Object.keys(s) as (keyof Session)[]) if (s[k] === undefined) delete s[k];
    this.commit({ sessions: this.sessions.map((x) => (x.sid === sid ? s : x)), changed: [sid] });
    void this.link?.flush();
    return s;
  }

  autopilotOf(s: Session): "off" | "nudge" | "chain" {
    return s.autopilot ?? this.config.autopilot;
  }

  /** A message from the hub inbox: queue it for local delivery. */
  private receive(m: InboxMessage): "queued" | "unknown" {
    const s = this.sessions.find((x) => x.sid === m.toSid && x.state !== "ended");
    if (!s) return "unknown";
    this.store.queueMessage(s.sid, m.text, this.deps.now(), m.id);
    void this.deliverPending(s.sid).catch(() => undefined);
    return "queued";
  }

  private settle(m: Message, state: "delivered" | "failed", detail: string): void {
    if (state === "delivered") this.store.markDelivered(m.id, detail, this.deps.now());
    else this.store.markFailed(m.id, detail);
    if (m.hubId !== undefined) void this.link?.ack(m.hubId, state, state === "delivered" ? detail : undefined);
    if (m.hubId !== undefined || state === "delivered") {
      const s = this.sessions.find((x) => x.sid === m.sid);
      if (s?.step) this.link?.enqueue({ id: randomUUID(), at: this.deps.now(), type: "message.delivered", sid: s.sid, step: s.step, payload: { state, method: detail } });
    }
  }

  private toolHost(): ToolHost {
    if (!this.link) throw new HttpError(409, "this daemon has no hub configured; run: mesh login");
    return {
      link: this.link,
      update: (sid, patch) => this.update(sid, patch),
      queue: (sid, text) => void this.store.queueMessage(sid, text, this.deps.now()),
      autopilotOf: (s) => this.autopilotOf(s),
    };
  }

  async callTool(tool: ToolName, call: ToolCall): Promise<{ text: string; isError?: boolean }> {
    const s = this.sessions.find((x) => x.pid === call.pid && x.state !== "ended");
    if (!s) return { text: "mesh doesn't know this Claude session yet (are the hooks installed? run `mesh doctor`).", isError: true };
    return runTool(this.toolHost(), s, tool, call.args, call.key);
  }

  /** Claim the next ready step for a session's repo and send it its brief (TUI `n`). */
  async assignNext(target: string): Promise<{ step?: string; message: string }> {
    const s = findSession(this.sessions, target);
    if (!s) throw new HttpError(404, `no live session matches "${target}"`);
    const host = this.toolHost();
    const q = s.repo ? `&repo=${encodeURIComponent(s.repo.id)}` : "";
    const { steps } = await host.link.rpc<{ steps: { id: string }[] }>("GET", `/v1/steps?ready=1${q}`);
    const next = steps[0];
    if (!next) return { message: `no ready step for ${s.repo?.name ?? sessionLabel(s)}` };
    await host.link.rpc("POST", `/v1/steps/${encodeURIComponent(next.id)}/claim`, { sid: s.sid }, randomUUID());
    this.update(s.sid, { step: next.id, nudges: 0, escalated: false });
    this.store.queueMessage(s.sid, stepMessage(next.id), this.deps.now());
    void this.deliverPending(s.sid);
    return { step: next.id, message: `${sessionLabel(s)} now holds ${next.id}` };
  }

  setAutopilot(target: string, level: "off" | "nudge" | "chain"): Session {
    const s = findSession(this.sessions, target);
    if (!s) throw new HttpError(404, `no live session matches "${target}"`);
    return this.update(s.sid, { autopilot: level }) as Session;
  }

  status(): { hub: LinkStatus; user?: string | undefined; outbox: number; error?: string | undefined } {
    if (!this.link) return { hub: "not-logged-in", outbox: 0 };
    this.link.credentials();
    return { hub: this.link.status, user: this.link.user, outbox: this.store.outboxSize(), error: this.link.lastError };
  }

  private maybeNotify(prev: Session | undefined, s: Session): void {
    if (s.state !== "needs_you") {
      this.notified.delete(s.sid);
      return;
    }
    const key = `${s.needs}:${s.lastStopAt ?? ""}`;
    if (prev?.state === "needs_you" && prev.needs === s.needs && this.notified.get(s.sid) === key) return;
    if (this.notified.get(s.sid) === key) return;
    this.notified.set(s.sid, key);
    if (this.config.notify) void this.deps.notify(`mesh · ${sessionLabel(s)}`, needsLabel(s)).catch(() => undefined);
  }

  private ctx() {
    return { now: this.deps.now(), newId: this.deps.newId, rules: this.rules };
  }

  handleHook(kind: HookKind, input: HookInput, headers: { claudePid?: string; tmuxPane?: string; tmux?: string; autopilot?: string; step?: string }): object {
    const now = this.deps.now();
    const ev: HookEvent = toHookEvent(kind, input, headers, now);
    if (kind === "UserPromptSubmit" && input.prompt !== undefined) {
      this.typed = this.typed.filter((t) => now - t.at < 120_000);
      const i = this.typed.findIndex((t) => t.text.trim() === input.prompt?.trim());
      if (i >= 0) {
        ev.delivered = true;
        this.typed.splice(i, 1);
      }
    }
    const result = applyHook(this.sessions, ev, this.ctx());
    this.commit(result);
    const sid = result.changed[0] as string;
    this.store.appendHookEvent(sid, ev);
    if (kind === "SessionStart" && ev.stepHint && this.link) {
      const s = this.sessions.find((x) => x.sid === sid);
      if (s && s.step !== ev.stepHint) {
        const step = ev.stepHint;
        void this.link
          .rpc("POST", `/v1/steps/${encodeURIComponent(step)}/claim`, { sid }, `bind:${sid}:${step}`)
          .then(() => this.update(sid, { step, nudges: 0, escalated: false }))
          .catch((e) => this.deps.log(`could not bind ${sid} to ${step}: ${String(e)}`));
      }
    }

    if (kind === "Stop") {
      if (ev.stopHookActive !== true) {
        const [next] = this.store.pendingMessages(sid);
        if (next) {
          this.settle(next, "delivered", "stop");
          this.deps.log(`delivered message ${next.id} to ${sid} via Stop hook`);
          return stopReply(next.text);
        }
      }
      setTimeout(() => void this.deliverPending(sid).catch(() => undefined), 250).unref();
    }
    return {};
  }

  async reconcile(): Promise<void> {
    if (this.reconciling) return;
    this.reconciling = true;
    try {
      const entries = await this.deps.listAgents();
      if (entries === null) return;
      this.commit(applyObservation(this.sessions, entries, this.ctx()));
      await this.deliverPending();
      await this.link?.flush();
    } finally {
      this.reconciling = false;
    }
  }

  checkTranscripts(): void {
    for (const s of this.sessions) {
      if (s.state === "ended" || !s.transcriptPath) continue;
      const m = this.deps.mtime(s.transcriptPath);
      if (m !== undefined) this.commit(applyTranscriptMtime(this.sessions, s.sid, m));
    }
  }

  tick(): void {
    const now = this.deps.now();
    this.commit(applyTick(this.sessions, this.ctx()));
    this.autopilot();
    // Forget long-ended sessions in memory; the store keeps them a week.
    this.sessions = this.sessions.filter((s) => s.state !== "ended" || now - (s.endedAt ?? 0) < 24 * 60 * 60_000);
    this.store.pruneSessions(now - 7 * 24 * 60 * 60_000);
    this.store.pruneHookEvents(now - 30 * 24 * 60 * 60_000);
  }

  /** Nudge stalled sessions, escalate after two nudges (plan §3.6). */
  autopilot(): void {
    for (const s of this.sessions) {
      const action = decide(s, this.autopilotOf(s));
      if (!action) continue;
      if (action.kind === "nudge") {
        this.store.queueMessage(s.sid, action.text, this.deps.now());
        this.update(s.sid, { nudges: (s.nudges ?? 0) + 1 });
        this.link?.enqueue({ id: randomUUID(), at: this.deps.now(), type: "session.nudged", sid: s.sid, ...(s.step ? { step: s.step } : {}), payload: { n: (s.nudges ?? 0) + 1 } });
        void this.deliverPending(s.sid);
      } else {
        this.update(s.sid, { escalated: true });
        this.link?.enqueue({ id: randomUUID(), at: this.deps.now(), type: "session.escalated", sid: s.sid, ...(s.step ? { step: s.step } : {}) });
        if (this.config.notify) void this.deps.notify(`mesh · ${sessionLabel(s)}`, `stalled on ${s.step} after 2 nudges`).catch(() => undefined);
      }
    }
  }

  // ---------- messages ----------

  say(target: string, text: string): { message: Message; sid: string } {
    const s = findSession(this.sessions, target);
    if (!s) throw new HttpError(404, `no live session matches "${target}"`);
    const message = this.store.queueMessage(s.sid, text, this.deps.now());
    void this.deliverPending(s.sid).catch(() => undefined);
    return { message, sid: s.sid };
  }

  /** Try to deliver the oldest pending message of each session (or of one session). */
  async deliverPending(onlySid?: string): Promise<void> {
    const now = this.deps.now();
    const pending = this.store.pendingMessages(onlySid);
    const firstPerSession = new Map<string, Message>();
    for (const m of pending) if (!firstPerSession.has(m.sid)) firstPerSession.set(m.sid, m);

    for (const m of pending) {
      if (now - m.createdAt > MESSAGE_TTL_MS) this.settle(m, "failed", "not delivered within an hour");
    }
    for (const [sid, m] of firstPerSession) {
      if (now - m.createdAt > MESSAGE_TTL_MS || this.delivering.has(sid)) continue;
      const s = this.sessions.find((x) => x.sid === sid);
      const plan = planDelivery(s, now, this.rules);
      if (plan.method === "fail") {
        this.settle(m, "failed", plan.reason);
        continue;
      }
      if (plan.method === "stop" || plan.method === "wait" || !s) continue;
      this.delivering.add(sid);
      try {
        if (plan.method === "paste") {
          this.typed.push({ text: m.text, at: now });
          const ok = await this.deps.paste(plan.pane, m.text, { socketPath: s.tmuxSocket });
          if (ok) {
            this.settle(m, "delivered", "paste");
            this.markWorking(sid);
          } else {
            this.typed.pop();
          }
        } else if (plan.method === "wake") {
          this.typed.push({ text: m.text, at: now });
          const r = await this.deps.wakeBackground({ bgId: plan.bgId, sessionId: plan.sessionId, cwd: s.cwd }, m.text);
          if (r.ok) {
            this.settle(m, "delivered", "wake");
            this.markWorking(sid);
          } else {
            this.settle(m, "failed", r.error ?? "wake failed");
          }
        }
      } finally {
        this.delivering.delete(sid);
      }
    }
  }

  /** After typing a prompt, don't type again until Claude reports the new state. */
  private markWorking(sid: string): void {
    const i = this.sessions.findIndex((x) => x.sid === sid);
    if (i < 0) return;
    const s: Session = { ...(this.sessions[i] as Session), state: "working" };
    delete s.observed;
    delete s.needs;
    this.sessions = this.sessions.map((x, j) => (j === i ? s : x));
    this.store.saveSessions([s], this.deps.now());
  }

  snapshot(): SessionsResponse {
    const now = this.deps.now();
    return {
      sessions: this.sessions.filter((s) => s.state !== "ended" || now - (s.endedAt ?? 0) < SHOW_ENDED_MS),
      messages: this.store.recentMessages(now - SHOW_ENDED_MS),
    };
  }

  // ---------- HTTP ----------

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    try {
      this.guard(req);
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      const path = url.pathname;
      if (req.method === "POST" && path.startsWith("/mesh/hook/")) {
        const kind = hookKindFromSlug(path.slice("/mesh/hook/".length));
        if (!kind) throw new HttpError(404, "unknown hook");
        const parsed = HookInput.safeParse(await readJson(req));
        if (!parsed.success) throw new HttpError(400, "invalid hook input");
        const h = (n: string) => {
          const v = req.headers[n];
          return typeof v === "string" && v !== "" ? v : undefined;
        };
        const headers: { claudePid?: string; tmuxPane?: string; tmux?: string; autopilot?: string; step?: string } = {};
        const pid = h("x-claude-pid");
        const pane = h("x-tmux-pane");
        const tmux = h("x-tmux");
        const autopilot = h("x-mesh-autopilot");
        const stepHint = h("x-mesh-step");
        if (autopilot) headers.autopilot = autopilot;
        if (stepHint) headers.step = stepHint;
        if (pid) headers.claudePid = pid;
        if (pane) headers.tmuxPane = pane;
        if (tmux) headers.tmux = tmux;
        return send(res, 200, this.handleHook(kind, parsed.data, headers));
      }
      if (req.method === "GET" && path === "/local/health") {
        return send(res, 200, { ok: true, port: this.port, sessions: this.sessions.filter((s) => s.state !== "ended").length });
      }
      if (req.method === "GET" && path === "/local/sessions") return send(res, 200, this.snapshot());
      if (req.method === "POST" && path === "/local/say") {
        const body = SayRequest.safeParse(await readJson(req));
        if (!body.success) throw new HttpError(400, "expected {target, text}");
        return send(res, 200, this.say(body.data.target, body.data.text));
      }
      if (req.method === "POST" && path.startsWith("/local/mcp/")) {
        const tool = path.slice("/local/mcp/".length) as ToolName;
        if (!TOOL_NAMES.includes(tool)) throw new HttpError(404, "unknown tool");
        const call = ToolCall.safeParse(await readJson(req));
        if (!call.success) throw new HttpError(400, "expected {pid, args, key}");
        return send(res, 200, await this.callTool(tool, call.data));
      }
      if (req.method === "GET" && path === "/local/status") return send(res, 200, { ...this.status(), host: hostname() });
      if (req.method === "POST" && path === "/local/autopilot") {
        const b = (await readJson(req)) as { target?: string; level?: string };
        if (!b.target || (b.level !== "off" && b.level !== "nudge" && b.level !== "chain")) throw new HttpError(400, "expected {target, level: off|nudge|chain}");
        return send(res, 200, this.setAutopilot(b.target, b.level));
      }
      if (req.method === "POST" && path === "/local/next") {
        const b = (await readJson(req)) as { target?: string };
        if (!b.target) throw new HttpError(400, "expected {target}");
        return send(res, 200, await this.assignNext(b.target));
      }
      if (req.method === "POST" && path === "/local/reconcile") {
        await this.reconcile();
        return send(res, 200, this.snapshot());
      }
      throw new HttpError(404, "not found");
    } catch (e) {
      const status = e instanceof HttpError ? e.status : 500;
      if (status === 500) this.deps.log(`error: ${String(e)}`);
      send(res, status, { error: e instanceof Error ? e.message : String(e) });
    }
  }

  /** Local requests only, from processes that know the key; never from a browser (plan §6.1). */
  private guard(req: IncomingMessage): void {
    if (req.headers.origin !== undefined) throw new HttpError(403, "browser requests are not allowed");
    const host = req.headers.host ?? "";
    if (host !== `127.0.0.1:${this.port}` && host !== `localhost:${this.port}`) throw new HttpError(403, "bad host");
    const key = req.headers[KEY_HEADER];
    const want = Buffer.from(this.config.key);
    const got = Buffer.from(typeof key === "string" ? key : "");
    if (got.length !== want.length || !timingSafeEqual(got, want)) throw new HttpError(401, "bad key");
  }
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > MAX_BODY) throw new HttpError(413, "body too large");
    chunks.push(c as Buffer);
  }
  const text = Buffer.concat(chunks).toString("utf8");
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    throw new HttpError(400, "invalid JSON");
  }
}

function send(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(text) });
  res.end(text);
}
