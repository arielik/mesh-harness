// mesh up: the local daemon (plan §6). Receives the five hooks, reconciles with
// `claude agents --json`, tracks transcript activity, delivers messages and notifies.

import { randomUUID, timingSafeEqual } from "node:crypto";
import { statSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import {
  applyHook,
  applyObservation,
  applyTick,
  applyTranscriptMtime,
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

  constructor(opts: { config: DaemonConfig; store: DaemonStore; deps: DaemonDeps; rules?: Rules; intervals?: Partial<Intervals> }) {
    this.config = opts.config;
    this.store = opts.store;
    this.deps = opts.deps;
    this.rules = opts.rules ?? DEFAULT_RULES;
    this.intervals = { ...DEFAULT_INTERVALS, ...opts.intervals };
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
    void this.reconcile().catch((e) => this.deps.log(`error: ${String(e)}`));
    this.deps.log(`mesh daemon listening on 127.0.0.1:${this.port}`);
  }

  async stop(): Promise<void> {
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
    for (const s of changed) this.maybeNotify(before.get(s.sid), s);
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

  handleHook(kind: HookKind, input: HookInput, headers: { claudePid?: string; tmuxPane?: string; tmux?: string }): object {
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

    if (kind === "Stop") {
      if (ev.stopHookActive !== true) {
        const [next] = this.store.pendingMessages(sid);
        if (next) {
          this.store.markDelivered(next.id, "stop", now);
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
    // Forget long-ended sessions in memory; the store keeps them a week.
    this.sessions = this.sessions.filter((s) => s.state !== "ended" || now - (s.endedAt ?? 0) < 24 * 60 * 60_000);
    this.store.pruneSessions(now - 7 * 24 * 60 * 60_000);
    this.store.pruneHookEvents(now - 30 * 24 * 60 * 60_000);
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
      if (now - m.createdAt > MESSAGE_TTL_MS) this.store.markFailed(m.id, "not delivered within an hour");
    }
    for (const [sid, m] of firstPerSession) {
      if (now - m.createdAt > MESSAGE_TTL_MS || this.delivering.has(sid)) continue;
      const s = this.sessions.find((x) => x.sid === sid);
      const plan = planDelivery(s, now, this.rules);
      if (plan.method === "fail") {
        this.store.markFailed(m.id, plan.reason);
        continue;
      }
      if (plan.method === "stop" || plan.method === "wait" || !s) continue;
      this.delivering.add(sid);
      try {
        if (plan.method === "paste") {
          this.typed.push({ text: m.text, at: now });
          const ok = await this.deps.paste(plan.pane, m.text, { socketPath: s.tmuxSocket });
          if (ok) {
            this.store.markDelivered(m.id, "paste", this.deps.now());
            this.markWorking(sid);
          } else {
            this.typed.pop();
          }
        } else if (plan.method === "wake") {
          this.typed.push({ text: m.text, at: now });
          const r = await this.deps.wakeBackground({ bgId: plan.bgId, sessionId: plan.sessionId, cwd: s.cwd }, m.text);
          if (r.ok) {
            this.store.markDelivered(m.id, "wake", this.deps.now());
            this.markWorking(sid);
          } else {
            this.store.markFailed(m.id, r.error ?? "wake failed");
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
        const headers: { claudePid?: string; tmuxPane?: string; tmux?: string } = {};
        const pid = h("x-claude-pid");
        const pane = h("x-tmux-pane");
        const tmux = h("x-tmux");
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
