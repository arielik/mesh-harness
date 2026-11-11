// mesh up: the local daemon (plan §6). Receives the hooks, reconciles with `claude agents --json`,
// tracks transcript activity, delivers messages and notifies. M4: works without the hub (local-first)
// and captures workflow programmes (subagent hooks + Claude Code's workflow files).

import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import { homedir, hostname } from "node:os";
import { statSync } from "node:fs";
import { join } from "node:path";
import { claudeVersion, computeHarness, readAgentFiles, scanWorkflowRuns } from "../claude/index.ts";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import {
  applyHook,
  applyObservation,
  applyTick,
  agentRecords,
  applyTranscriptMtime,
  applyLaunch,
  applyLaunchScreen,
  isHidden,
  decide,
  parseLabel,
  DEFAULT_RULES,
  findSession,
  needsLabel,
  sessionLabel,
  type FactEvent,
  type Result,
  type Rules,
} from "../core/index.ts";
import {
  HookInput,
  hookKindFromSlug,
  HOOKS_VERSION,
  notifyChannels,
  KEY_HEADER,
  LaunchRequest,
  OpenCodeEvent,
  OpenCodePoll,
  OPENCODE_PLUGIN_VERSION,
  openCodeToHookEvent,
  SayRequest,
  stopReply,
  toHookEvent,
  ToolCall,
  TOOL_NAMES,
  type AgentRun,
  type Credentials,
  type DoneResult,
  type FleetView,
  type Harness,
  type InboxMessage,
  type ToolName,
  type AgentEntry,
  type DaemonConfig,
  type HookEvent,
  type HookHeaders,
  type HookKind,
  type Message,
  type NotifyTarget,
  type OpenCodeReply,
  type Repo,
  type Session,
  type SessionsResponse,
} from "../protocol/index.ts";
import type { DaemonStore } from "../store/index.ts";
import { MESSAGE_TTL_MS, planDelivery } from "./delivery.ts";
import { commonDir, findGitDir, findRepoRoot, headCommit, repoForCwd } from "./git.ts";
import { HubLink, type HubRpcError, type LinkMode, type LinkStatus } from "./hub-link.ts";
import { REPO_SCAN_MS, repoInventory, scanRepos } from "./repos.ts";
import { runTool, stepMessage, type ToolHost } from "./tools.ts";
import { writePending, writeTrail } from "./trail.ts";
import type { PendingCall } from "../store/index.ts";

export interface DaemonDeps {
  listAgents(): Promise<AgentEntry[] | null>;
  paste(pane: string, text: string, server: { socketPath?: string | undefined }): Promise<boolean>;
  /** The text a tmux pane shows, or undefined when the pane is gone (a window `mesh run` opened). */
  paneText?(pane: string, server: { socketPath?: string | undefined }): Promise<string | undefined>;
  wakeBackground(t: { bgId: string; sessionId: string; cwd: string }, text: string): Promise<{ ok: boolean; error?: string }>;
  /** Tell the person. `target` is the session concerned, for a notification in its own terminal. */
  notify(title: string, body: string, target?: NotifyTarget): Promise<unknown>;
  now(): number;
  newId(): string;
  repoForCwd(cwd: string): Repo | undefined;
  mtime(path: string): number | undefined;
  log(line: string): void;
  /** fetch used for the hub (tests inject one). */
  fetch?: typeof fetch;
  /** Provenance of a session's work (M4): harness hash, Claude Code version. */
  harness?(cwd: string, meshVersion: string): Harness | undefined;
  claudeVersion?(): Promise<string | undefined>;
  /** Claude Code's own records of a subagent, and of workflow runs since a time (backfill). */
  readAgent?(transcriptPath: string, agentId: string): ReturnType<typeof readAgentFiles>;
  scanRuns?(since: number): AgentRun[];
  /** Hub call timeout (tests use a short one). */
  hubTimeoutMs?: number;
  /** Is this process alive? (OpenCode sessions end when their server's process is gone.) */
  alive?(pid: number): boolean;
  /** MM-1: the repos of the checkouts under the workspace roots (ids and names only). */
  scanRepos?(roots: readonly string[]): Repo[];
}

/** `kill -0`: EPERM means the process exists but belongs to someone else. */
export function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

const claudeHome = () => process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), ".claude");

/** Where Claude Code keeps a session's transcript: projects/<cwd, every other character as ->/<id>.jsonl. */
export function transcriptGuess(s: Session, home = claudeHome()): string | undefined {
  if (s.agent === "opencode") return undefined;
  const id = s.claudeSessionIds.at(-1);
  if (!id || !s.cwd) return undefined;
  return join(home, "projects", s.cwd.replace(/[^a-zA-Z0-9]/g, "-"), `${id}.jsonl`);
}

/** Where a session runs, for a notification written to its own terminal. */
function notifyTarget(s: Session): NotifyTarget {
  return { ...(s.pid !== undefined ? { pid: s.pid } : {}), ...(s.pane ? { pane: s.pane } : {}), ...(s.tmuxSocket ? { tmuxSocket: s.tmuxSocket } : {}) };
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
  harness: (cwd, meshVersion) => computeHarness({ repoRoot: findRepoRoot(cwd), claudeHome: claudeHome(), meshVersion }),
  claudeVersion: () => claudeVersion(),
  readAgent: (path, id) => readAgentFiles(path, id),
  scanRuns: (since) => scanWorkflowRuns(claudeHome(), since),
  alive: pidAlive,
  scanRepos,
  ...overrides,
});

/** A stable event id for a subagent, so a re-capture never duplicates its hub event. */
function agentEventId(agentId: string): string {
  const h = createHash("sha256").update(`agent:${agentId}`).digest("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

/** Scalar fields of a typed result, for the hub event (the full result is in the record). */
function scalars(v: unknown): Record<string, unknown> | undefined {
  if (!v || typeof v !== "object" || Array.isArray(v)) return undefined;
  const out: Record<string, unknown> = {};
  for (const [k, x] of Object.entries(v)) {
    if (typeof x === "number" || typeof x === "boolean") out[k] = x;
    else if (typeof x === "string" && x.length <= 120) out[k] = x;
    else if (Array.isArray(x)) out[`${k}_count`] = x.length;
  }
  return out;
}

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
  /** MM-1: the last scan of the workspace roots, redone at most every REPO_SCAN_MS. */
  private repoScan: { at: number; repos: Repo[] } | undefined;
  port = 0;

  readonly config: DaemonConfig;
  readonly store: DaemonStore;
  readonly deps: DaemonDeps;
  readonly rules: Rules;
  readonly intervals: Intervals;
  readonly link: HubLink | undefined;
  readonly version: string;
  private claudeCode: string | undefined;
  private provenanceSent = new Set<string>();
  private agentEvents = new Set<string>();
  /** session:step pairs already bound at the hub after a SessionStart. */
  private boundSteps = new Set<string>();

  constructor(opts: {
    config: DaemonConfig;
    store: DaemonStore;
    deps: DaemonDeps;
    rules?: Rules;
    intervals?: Partial<Intervals>;
    credentialsPath?: string;
    /** The local hub's credentials, used when no team hub is configured (Solo). */
    solo?: () => Credentials | undefined;
    version?: string;
  }) {
    this.config = opts.config;
    this.store = opts.store;
    this.deps = opts.deps;
    this.rules = opts.rules ?? DEFAULT_RULES;
    this.intervals = { ...DEFAULT_INTERVALS, ...opts.intervals };
    this.version = opts.version ?? "dev";
    if (opts.credentialsPath) {
      this.link = new HubLink({
        credentialsPath: opts.credentialsPath,
        store: this.store,
        sessions: () => this.sessions.filter((s) => !isHidden(s)),
        share: () => this.config.shareSessions,
        machineRepos: () => this.machineRepos(),
        onMessage: (m) => this.receive(m),
        log: (l) => this.deps.log(l),
        now: () => this.deps.now(),
        ...(this.deps.fetch ? { fetch: this.deps.fetch } : {}),
        ...(opts.solo ? { solo: opts.solo } : {}),
        ...(this.deps.hubTimeoutMs ? { timeoutMs: this.deps.hubTimeoutMs } : {}),
        onReplayed: (call, r) => this.replayed(call, r),
        onRejected: (call, e) => this.rejected(call, e),
      });
    }
  }

  /**
   * The machine's repo inventory (MM-1): under `me` and `all` the repos under the workspace roots
   * plus those of the current sessions; under `steps` always empty (no scan). Never a path.
   */
  private machineRepos(): Repo[] {
    if (this.config.shareSessions === "steps") return [];
    const now = this.deps.now();
    if (!this.repoScan || now - this.repoScan.at >= REPO_SCAN_MS) {
      this.repoScan = { at: now, repos: (this.deps.scanRepos ?? scanRepos)(this.config.workspaceRoots) };
    }
    return repoInventory([...this.repoScan.repos, ...this.sessions.filter((x) => x.state !== "ended" && !isHidden(x)).map((x) => x.repo)]);
  }

  /** A call queued while offline went through: write the hub's fuller record over the local one. */
  private replayed(call: PendingCall, result: unknown): void {
    this.deps.log(`sent ${call.label} (queued while the hub was offline)`);
    if (!call.cwd || !call.path.endsWith("/done")) return;
    const r = result as Partial<DoneResult>;
    const files = [...(r.record ? [r.record] : []), ...(r.files ?? [])];
    if (files.length) writeTrail(call.cwd, files);
  }

  /** The hub refused a queued call (e.g. the step was taken over meanwhile): tell the person, keep both. */
  private rejected(call: PendingCall, e: HubRpcError): void {
    if (notifyChannels(this.config).any) void this.deps.notify("mesh", `${call.label} (made offline) was refused by the hub: ${e.message}`).catch(() => undefined);
    const m = /^\/v1\/steps\/([^/]+)\/done$/.exec(call.path);
    if (m && this.link) {
      const summary = String(call.body.summary ?? "");
      void this.link
        .rpc("POST", `/v1/steps/${m[1]}/note`, { text: `Result recorded offline and refused by the hub (${e.message}): ${summary}`.slice(0, 7900) }, `${call.key}:note`)
        .catch(() => undefined);
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
    every(this.intervals.tickMs * 40, () => this.backfill());
    if (this.link) {
      this.link.credentials();
      if (this.intervals.reconcileMs > 0) this.link.startStream();
    }
    void this.deps
      .claudeVersion?.()
      .then((v) => (this.claudeCode = v))
      .catch(() => undefined);
    if (this.intervals.reconcileMs > 0) setTimeout(() => this.backfill(), 2_000).unref();
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
    // A placeholder for a window `mesh run` opened is not a session yet.
    if (s.launching || isHidden(s)) return;
    const at = this.deps.now();
    const base = { sid: s.sid, ...(s.step ? { step: s.step } : {}) };
    const add = (type: string, payload: Record<string, unknown> = {}) => this.link?.enqueue({ id: randomUUID(), at, type, ...base, payload: { repo: s.repo?.name, ...payload } });
    if (s.step && !this.provenanceSent.has(`${s.sid}:${s.step}`)) {
      this.provenanceSent.add(`${s.sid}:${s.step}`);
      add("session.provenance", this.provenance(s));
    }
    if (prev && s.claudeSessionIds.length > prev.claudeSessionIds.length) add("session.rebound");
    // Turns are counted from the session's turn counter, so a pasted prompt (state already
    // "working") still counts; delivered = no new human prompt.
    if (s.turns > (prev?.turns ?? 0)) add("session.turn_started", { delivered: s.humanPrompts === (prev?.humanPrompts ?? 0), ...(s.model ? { model: s.model } : {}) });
    if (prev?.state === s.state && prev?.needs === s.needs) return;
    if ((s.state === "idle" || s.state === "needs_you") && prev?.state === "working") add("session.turn_stopped", { ...(s.effort ? { effort: s.effort } : {}), ...(s.permissionMode ? { permission_mode: s.permissionMode } : {}) });
    if (s.state === "needs_you") add("session.waiting", { needs: s.needs });
    else if (s.state === "stalled") add("session.stalled");
    else if (s.state === "ended") add("session.ended", { reason: s.endedReason });
  }

  /** Where this session's work came from (M4, R2): hashes and versions, never file contents. */
  provenance(s: Session): Record<string, unknown> {
    let harness: Harness | undefined;
    try {
      harness = this.deps.harness?.(s.cwd, this.version);
    } catch (e) {
      this.deps.log(`harness hash failed for ${s.cwd}: ${String(e)}`);
    }
    const commit = headCommit(s.cwd);
    return {
      ...(this.claudeCode ? { claude_code: this.claudeCode } : {}),
      ...(harness ? { harness } : {}),
      ...(commit ? { repo_commit: commit } : {}),
      mesh: this.version,
      ...(s.model ? { model: s.model } : {}),
    };
  }

  // ---------- workflow capture (M4, decision 11) ----------

  private captureSubagent(kind: "SubagentStart" | "SubagentStop", ev: HookEvent): void {
    const id = ev.agentId;
    if (!id) return;
    const s = this.sessions.find((x) => x.claudeSessionIds.includes(ev.claudeSessionId));
    const prev = this.store.agentRun(id);
    const run: AgentRun = {
      ...(prev ?? {}),
      agentId: id,
      claudeSessionId: ev.claudeSessionId,
      cwd: ev.cwd || prev?.cwd || s?.cwd || "",
      role: ev.agentType || prev?.role || "agent",
      ...(s ? { sid: s.sid } : {}),
    };
    if (kind === "SubagentStart") {
      if (run.startedAt === undefined) run.startedAt = ev.at;
      this.store.saveAgentRun(run, prev ? parseLabel(prev.label, prev.role)?.key : undefined, ev.at);
      return;
    }
    run.finishedAt = ev.at;
    this.store.saveAgentRun(run, parseLabel(run.label, run.role)?.key, ev.at);
    const path = ev.agentTranscriptPath;
    if (!path) return;
    this.enrichAgent(id, path);
    // Claude Code may write the journal's result line just after the hook; look again shortly.
    for (const ms of [2_000, 15_000]) setTimeout(() => this.enrichAgent(id, path), ms).unref();
  }

  enrichAgent(id: string, transcriptPath: string): void {
    const run = this.store.agentRun(id);
    if (!run || !this.deps.readAgent) return;
    let f: ReturnType<typeof readAgentFiles>;
    try {
      f = this.deps.readAgent(transcriptPath, id);
    } catch (e) {
      this.deps.log(`could not read Claude Code's files for agent ${id}: ${String(e)}`);
      return;
    }
    const { roleFromMeta, ...fields } = f;
    const merged: AgentRun = { ...run, ...Object.fromEntries(Object.entries(fields).filter(([, v]) => v !== undefined)) };
    // The hooks' times are on mesh's clock; keep them.
    if (run.startedAt !== undefined) merged.startedAt = run.startedAt;
    if (run.finishedAt !== undefined) merged.finishedAt = run.finishedAt;
    if ((run.role === "agent" || !run.role) && roleFromMeta) merged.role = roleFromMeta;
    this.saveAndRender(merged, JSON.stringify(merged) !== JSON.stringify(run));
  }

  private saveAndRender(run: AgentRun, changed: boolean): void {
    const key = parseLabel(run.label, run.role)?.key;
    this.store.saveAgentRun(run, key, this.deps.now());
    if (!key) return;
    if (changed) this.renderAgentKey(key, run.cwd);
    if (!this.agentEvents.has(run.agentId) && run.finishedAt !== undefined) {
      this.agentEvents.add(run.agentId);
      const result = scalars(run.result);
      this.link?.enqueue({
        id: agentEventId(run.agentId),
        at: run.finishedAt,
        type: "agent.finished",
        ...(run.sid ? { sid: run.sid } : {}),
        payload: {
          key,
          role: run.role,
          label: run.label,
          ...(run.model ? { model: run.model } : {}),
          ...(run.workflowName ? { workflow: run.workflowName } : {}),
          ...(run.workflowRun ? { workflow_run: run.workflowRun } : {}),
          ...(run.startedAt !== undefined ? { started: run.startedAt } : {}),
          finished: run.finishedAt,
          ...(result ? { result } : {}),
          repo: this.deps.repoForCwd(run.cwd)?.name,
        },
      });
    }
  }

  /** Re-render the pending records of one key for the repo `cwd` belongs to. */
  private renderAgentKey(key: string, cwd: string): void {
    const git = findGitDir(cwd);
    if (!git) return;
    const common = commonDir(git);
    const runs = this.store.agentRunsFor(key).filter((r) => {
      const g = findGitDir(r.cwd);
      return g !== undefined && commonDir(g) === common;
    });
    writePending(cwd, key, agentRecords(runs));
  }

  /** Import workflow runs Claude Code recorded while the daemon was down or missed a hook. */
  backfill(): void {
    if (!this.deps.scanRuns) return;
    const now = this.deps.now();
    const since = Number(this.store.getKv("backfill_at") ?? now - 7 * 86_400_000);
    let runs: AgentRun[];
    try {
      runs = this.deps.scanRuns(since);
    } catch (e) {
      this.deps.log(`backfill failed: ${String(e)}`);
      return;
    }
    const keys = new Map<string, string>();
    for (const r of runs) {
      const prev = this.store.agentRun(r.agentId);
      const merged: AgentRun = prev ? { ...r, ...Object.fromEntries(Object.entries(prev).filter(([, v]) => v !== undefined)), result: prev.result ?? r.result } : r;
      if (merged.result === undefined) delete merged.result;
      const changed = JSON.stringify(merged) !== JSON.stringify(prev);
      if (!changed) continue;
      this.saveAndRender(merged, false);
      const key = parseLabel(merged.label, merged.role)?.key;
      if (key) keys.set(`${key}\u0000${merged.cwd}`, merged.cwd);
    }
    for (const [k, cwd] of keys) this.renderAgentKey(k.split("\u0000")[0] as string, cwd);
    if (runs.length) this.deps.log(`backfill: ${runs.length} workflow agent(s) checked, ${keys.size} record set(s) updated`);
    // Overlap two hours: runs still writing their files are looked at again.
    this.store.setKv("backfill_at", String(Math.max(since, now - 2 * 3_600_000)));
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
    const goal = typeof m.data?.goal === "string" ? m.data.goal : undefined;
    if (m.kind === "plan_approved" && goal) {
      if (s.step === `${goal}.design`) this.update(s.sid, { clearStep: true });
      void this.link
        ?.rpc<{ files: { path: string; text: string }[] }>("GET", `/v1/goals/${encodeURIComponent(goal)}/files`)
        .then(({ files }) => writeTrail(s.cwd, files.filter((f) => f.path.endsWith(`plan.v${String(m.data?.version)}.yaml`) || f.path.endsWith("/steps/design.md"))))
        .catch((e) => this.deps.log(`could not write the approved plan for ${goal}: ${String(e)}`));
    }
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
    const store = this.store;
    return {
      link: this.link,
      local: {
        now: () => this.deps.now(),
        cache: (ctx) => store.cacheStep(ctx, this.deps.now()),
        cached: (step) => store.cachedStep(step),
        events: (step) => store.eventLogFor(step) as FactEvent[],
        queueCall: (call) => this.link?.queue(call),
      },
      update: (sid, patch) => this.update(sid, patch),
      queue: (sid, text) => void this.store.queueMessage(sid, text, this.deps.now()),
      autopilotOf: (s) => this.autopilotOf(s),
    };
  }

  async callTool(tool: ToolName, call: ToolCall): Promise<{ text: string; isError?: boolean }> {
    // OpenCode names the session in each MCP call; Claude Code's shim is bound to its Claude pid.
    const s = call.agentSessionId
      ? this.sessions.find((x) => x.state !== "ended" && x.claudeSessionIds.includes(call.agentSessionId as string))
      : this.sessions.find((x) => x.agent !== "opencode" && x.pid === call.pid && x.state !== "ended");
    if (!s) {
      return call.agentSessionId
        ? { text: "mesh doesn't know this OpenCode session yet (is the mesh plugin installed? run `mesh doctor`).", isError: true }
        : { text: "mesh doesn't know this Claude session yet (are the hooks installed? run `mesh doctor`).", isError: true };
    }
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

  status(): {
    hub: LinkStatus;
    mode: LinkMode;
    user?: string | undefined;
    outbox: number;
    queued: number;
    offlineSince?: number | undefined;
    hubUrl?: string | undefined;
    error?: string | undefined;
    /** Live sessions whose hooks come from an older mesh (they started before `mesh setup` updated them). */
    oldHooks: number;
    /** Live OpenCode sessions whose plugin is older than this mesh's. */
    oldPlugin: number;
  } {
    const oldHooks = this.sessions.filter((x) => x.state !== "ended" && x.hooksVersion !== undefined && x.hooksVersion < HOOKS_VERSION).length;
    const oldPlugin = this.sessions.filter((x) => x.state !== "ended" && x.pluginVersion !== undefined && x.pluginVersion < OPENCODE_PLUGIN_VERSION).length;
    if (!this.link) return { hub: "not-logged-in", mode: "none", outbox: 0, queued: 0, oldHooks, oldPlugin };
    const c = this.link.credentials();
    return {
      hub: this.link.status,
      mode: this.link.mode,
      user: this.link.user,
      outbox: this.store.outboxSize(),
      queued: this.store.pendingCallCount(),
      ...(this.link.offlineSince ? { offlineSince: this.link.offlineSince } : {}),
      ...(c ? { hubUrl: c.hub } : {}),
      error: this.link.lastError,
      oldHooks,
      oldPlugin,
    };
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
    if (notifyChannels(this.config).any) void this.deps.notify(`mesh · ${sessionLabel(s)}`, needsLabel(s), notifyTarget(s)).catch(() => undefined);
  }

  private ctx() {
    return { now: this.deps.now(), newId: this.deps.newId, rules: this.rules };
  }

  handleHook(kind: HookKind, input: HookInput, headers: HookHeaders): object {
    const now = this.deps.now();
    const ev: HookEvent = toHookEvent(kind, input, headers, now);
    if (kind === "SubagentStart" || kind === "SubagentStop") {
      // A subagent never changes its session's state; it is captured for the ledger only.
      try {
        this.captureSubagent(kind, ev);
      } catch (e) {
        this.deps.log(`subagent capture failed: ${String(e)}`);
      }
      return {};
    }
    if (kind === "UserPromptSubmit" && input.prompt !== undefined) {
      this.typed = this.typed.filter((t) => now - t.at < 120_000);
      const i = this.typed.findIndex((t) => t.text.trim() === input.prompt?.trim());
      if (i >= 0) {
        ev.delivered = true;
        this.typed.splice(i, 1);
      }
    }
    const sid = this.applyEvent(ev);

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

  /** Apply a normalised hook event (from any agent); returns the session's sid. */
  private applyEvent(ev: HookEvent): string {
    const result = applyHook(this.sessions, ev, this.ctx());
    this.commit(result);
    const sid = result.changed[0] as string;
    this.store.appendHookEvent(sid, ev);
    if (ev.kind === "SessionStart" && ev.stepHint && this.link) {
      const s = this.sessions.find((x) => x.sid === sid);
      // Bind the step to this session at the hub (so its messages reach it), once per session and
      // step. A `mesh run` window's placeholder already carries the step: bind it anyway.
      const key = `${sid}:${ev.stepHint}`;
      if (s && (s.step !== ev.stepHint || !this.boundSteps.has(key))) {
        this.boundSteps.add(key);
        const step = ev.stepHint;
        void this.link
          .rpc("POST", `/v1/steps/${encodeURIComponent(step)}/claim`, { sid }, `bind:${sid}:${step}`)
          .then(() => this.update(sid, { step, nudges: 0, escalated: false }))
          .catch((e) => this.deps.log(`could not bind ${sid} to ${step}: ${String(e)}`));
      }
    }
    return sid;
  }

  // ---------- OpenCode ----------

  /**
   * An event from the mesh plugin in an OpenCode server. The reply may carry a message for the
   * plugin to hand to that session (OpenCode queues it behind a running turn).
   */
  handleOpenCodeEvent(e: OpenCodeEvent): OpenCodeReply {
    const now = this.deps.now();
    if (e.type === "location.shutdown") {
      // A shared server stops one location (folder) at a time; a private one stops with its terminal.
      this.endOpenCodeServer(e.pid, "opencode exited", e.standalone ? undefined : e.cwd);
      return {};
    }
    const ev = openCodeToHookEvent(e, now);
    if (!ev) return {};
    this.applyEvent(ev);
    const [deliver] = this.takeOpenCodeDeliveries([ev.claudeSessionId]);
    return deliver ? { deliver } : {};
  }

  /** Every live session an OpenCode server reported (in that folder, when given) ends with it. */
  private endOpenCodeServer(pid: number, reason: string, cwd?: string): void {
    for (const s of this.sessions.filter((x) => x.agent === "opencode" && x.pid === pid && x.state !== "ended" && (cwd === undefined || x.cwd === cwd))) {
      const id = s.claudeSessionIds.at(-1);
      if (!id) continue;
      this.applyEvent({ kind: "SessionEnd", agent: "opencode", at: this.deps.now(), claudeSessionId: id, cwd: s.cwd, reason });
    }
  }

  /**
   * Messages the plugin can deliver now to these OpenCode sessions (by OpenCode session id): the
   * oldest pending one each, unless a permission prompt is open. Marked delivered when handed over.
   */
  takeOpenCodeDeliveries(ids: readonly string[]): { sessionID: string; text: string }[] {
    const out: { sessionID: string; text: string }[] = [];
    const now = this.deps.now();
    for (const id of ids) {
      const s = this.sessions.find((x) => x.agent === "opencode" && x.state !== "ended" && x.claudeSessionIds.at(-1) === id);
      if (!s) continue;
      const [m] = this.store.pendingMessages(s.sid);
      if (!m || now - m.createdAt > MESSAGE_TTL_MS) continue;
      if (s.state === "needs_you" && (s.needs === "permission" || s.needs === "dialog")) continue;
      this.settle(m, "delivered", "opencode");
      this.deps.log(`delivered message ${m.id} to ${s.sid} via the OpenCode plugin`);
      if (s.state !== "working") this.markWorking(s.sid);
      out.push({ sessionID: id, text: m.text });
    }
    return out;
  }

  /** OpenCode sessions whose server process is gone (killed without a shutdown event). */
  private checkOpenCodeServers(): void {
    const alive = this.deps.alive;
    if (!alive) return;
    const pids = new Set(this.sessions.filter((x) => x.agent === "opencode" && x.state !== "ended" && x.pid !== undefined).map((x) => x.pid as number));
    for (const pid of pids) if (!alive(pid)) this.endOpenCodeServer(pid, "process exited");
  }

  async reconcile(): Promise<void> {
    if (this.reconciling) return;
    this.reconciling = true;
    try {
      const entries = await this.deps.listAgents();
      if (entries === null) return;
      this.commit(applyObservation(this.sessions, entries, this.ctx()));
      await this.checkLaunches();
      await this.deliverPending();
      await this.link?.flush();
    } finally {
      this.reconciling = false;
    }
  }

  /** `mesh run` opened a window for Claude: record it until Claude's first hook arrives. */
  async launch(l: LaunchRequest): Promise<Session | undefined> {
    const r = applyLaunch(this.sessions, l, this.ctx());
    this.commit(r);
    await this.checkLaunches();
    const sid = r.changed[0];
    return sid ? this.sessions.find((s) => s.sid === sid) : undefined;
  }

  /** Read the panes of windows whose Claude hasn't sent a hook yet (the folder trust prompt). */
  async checkLaunches(): Promise<void> {
    if (!this.deps.paneText) return;
    for (const s of this.sessions.filter((x) => x.launching && x.state !== "ended" && x.pane)) {
      const screen = await this.deps.paneText(s.pane as string, { socketPath: s.tmuxSocket });
      this.commit(applyLaunchScreen(this.sessions, s.sid, screen, this.ctx()));
    }
  }

  checkTranscripts(): void {
    for (const s of this.sessions) {
      if (s.state === "ended") continue;
      // Sessions that started before `mesh setup` never sent a hook with their transcript's path;
      // Claude Code keeps it under projects/<folder>/<session id>.jsonl.
      const path = s.transcriptPath ?? transcriptGuess(s);
      if (!path) continue;
      const m = this.deps.mtime(path);
      if (m !== undefined) this.commit(applyTranscriptMtime(this.sessions, s.sid, m));
    }
  }

  tick(): void {
    const now = this.deps.now();
    this.checkOpenCodeServers();
    this.commit(applyTick(this.sessions, this.ctx()));
    this.autopilot();
    // Forget long-ended sessions in memory; the store keeps them a week.
    this.sessions = this.sessions.filter((s) => s.state !== "ended" || now - (s.endedAt ?? 0) < 24 * 60 * 60_000);
    this.store.pruneSessions(now - 7 * 24 * 60 * 60_000);
    this.store.pruneHookEvents(now - 30 * 24 * 60 * 60_000);
    this.store.pruneEventLog(now - 30 * 24 * 60 * 60_000);
    this.store.pruneStepCache(now - 30 * 24 * 60 * 60_000);
    this.store.pruneAgentRuns(now - 60 * 24 * 60 * 60_000);
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
        if (notifyChannels(this.config).any) void this.deps.notify(`mesh · ${sessionLabel(s)}`, `stalled on ${s.step} after 2 nudges`, notifyTarget(s)).catch(() => undefined);
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
      sessions: this.sessions.filter((s) => !isHidden(s) && (s.state !== "ended" || now - (s.endedAt ?? 0) < SHOW_ENDED_MS)),
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
        const headers: HookHeaders = {};
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
        const hooks = h("x-mesh-hooks");
        const sentAt = h("x-mesh-at");
        if (hooks) headers.hooks = hooks;
        if (sentAt) headers.sentAt = sentAt;
        return send(res, 200, this.handleHook(kind, parsed.data, headers));
      }
      if (req.method === "POST" && path === "/mesh/agent-event/opencode") {
        const parsed = OpenCodeEvent.safeParse(await readJson(req));
        if (!parsed.success) throw new HttpError(400, "invalid OpenCode event");
        return send(res, 200, this.handleOpenCodeEvent(parsed.data));
      }
      if (req.method === "POST" && path === "/mesh/agent-poll/opencode") {
        const parsed = OpenCodePoll.safeParse(await readJson(req));
        if (!parsed.success) throw new HttpError(400, "expected {sessionIDs}");
        return send(res, 200, { deliver: this.takeOpenCodeDeliveries(parsed.data.sessionIDs) });
      }
      if (req.method === "GET" && path === "/local/health") {
        return send(res, 200, { ok: true, port: this.port, sessions: this.sessions.filter((s) => s.state !== "ended").length });
      }
      if (req.method === "GET" && path === "/local/sessions") return send(res, 200, this.snapshot());
      if (req.method === "POST" && path === "/local/launch") {
        const body = LaunchRequest.safeParse(await readJson(req));
        if (!body.success) throw new HttpError(400, "expected {pane, cwd}");
        return send(res, 200, { session: (await this.launch(body.data)) ?? null });
      }
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
      if (req.method === "GET" && path === "/local/goals") {
        if (!this.link?.credentials()) throw new HttpError(409, "not logged in to a hub; run: mesh login");
        const live = await this.link.rpc<{ goals: unknown[] }>("GET", "/v1/live");
        return send(res, 200, { goals: live.goals });
      }
      if (req.method === "GET" && path === "/local/fleet") {
        if (!this.link?.credentials()) throw new HttpError(409, "not logged in to a hub; run: mesh login");
        return send(res, 200, await this.link.rpc<FleetView>("GET", "/v1/fleet"));
      }
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
