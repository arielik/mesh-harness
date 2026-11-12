// mesh up: the local daemon (plan §6). Receives the hooks, reconciles with `claude agents --json`,
// tracks transcript activity, delivers messages and notifies. M4: works without the hub (local-first)
// and captures workflow programmes (subagent hooks + Claude Code's workflow files).

import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import { homedir, hostname } from "node:os";
import { statSync } from "node:fs";
import { join } from "node:path";
import { claudeVersion, computeHarness, readAgentFiles, run as runCommand, scanWorkflowRuns, type HeadlessRunner } from "../claude/index.ts";
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
  pickSession,
  repoMatches,
  sessionLabel,
  sessionName,
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
  MAX_LABELS,
  OpenCodeEvent,
  OpenCodePoll,
  OPENCODE_PLUGIN_VERSION,
  openCodeToHookEvent,
  parseAccept,
  parseLabels,
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
  type LabelsResult,
  type OfferView,
  type DebriefList,
  type RevertResult,
  type Step,
  type StepView,
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
import { checkoutKey, initialLabels } from "./labels.ts";
import { HubLink, HubRpcError, type LinkMode, type LinkStatus } from "./hub-link.ts";
import { findCheckouts, REPO_SCAN_MS, repoInventory, scanRepos } from "./repos.ts";
import { HeadlessRuns } from "./runs.ts";
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
  /**
   * MM-3: start a session for an offered step (`assignments: launch`, no idle session): by default
   * `mesh run <repo> --step <step> --no-tui`, detached. Without it a launch counts as failed.
   */
  launchStep?(repo: string, step: string): Promise<{ ok: boolean; error?: string }>;
  /** RL-1: the process runner of headless runs. Without it (or `runsDir`) headless offers are declined. */
  headless?: HeadlessRunner;
  /** RL-1: where run directories live (`<stateDir>/runs`). */
  runsDir?: string;
  /** RL-1: the executable of headless runs (`MESH_CLAUDE_BIN`, else `claude`). */
  claudeBin?: string;
  /** RL-1: the absolute command that starts this mesh, for the run's `mcp.json`. */
  meshCommand?: string[];
  /** RL-1: the checkout of a repo on this machine (default: the first under workspaceRoots). */
  findCheckout?(repo: string): string | undefined;
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
/** Local request bodies (RL-1: 4 MiB, so a 1 MiB mesh_artifact passes the shim). */
const MAX_BODY = 4 << 20;
/** MM-4: how long a launch for an offer counts toward maxSessions before its session shows up. */
const LAUNCH_PENDING_MS = 120_000;

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
  /** MM-3: machine-wide offer messages being handled now, and how handled ones were acked. */
  private offersInFlight = new Set<number>();
  /** MM-4: launches started for an offer (by offer message id), counted for maxSessions until seen or expired. */
  private pendingLaunches = new Map<number, { step: string; at: number }>();
  private offersHandled = new Map<number, { state: "delivered" | "failed"; method?: string | undefined; acked: boolean }>();
  /** MM-3: offer messages whose hub call or ack got no answer; a pull retries them. */
  private offersAwaitingRetry = new Set<number>();
  /** MM-3: sessions an in-flight offer picked, so a concurrent offer never picks the same one. */
  /**
   * Sessions reserved for offers (MM-3): the session an auto offer picked, by message id, kept until
   * that message is acked or no longer pending, so a retry after a lost reply sends the same sid and
   * no other offer takes it meanwhile; and the sessions a `mesh accept` is accepting right now.
   */
  private offerPicks = new Map<number, string>();
  private localPicks = new Set<string>();
  private reservedForOffer(sid: string): boolean {
    return this.localPicks.has(sid) || [...this.offerPicks.values()].includes(sid) || this.quiet(sid);
  }
  /** RL-1: headless runs (only with a runner and a runs directory). */
  readonly runs: HeadlessRuns | undefined;
  /** RL-1: a headless run's session: no messages reach it (no Stop reply, paste, nudge or escalation). */
  private quiet(sid: string): boolean {
    return this.runs?.isRunSession(sid) ?? false;
  }
  /**
   * RL-1: messages for a session that is quiet, or that belonged to a run that finished less than an
   * hour ago and has not come back, stay pending: neither delivered nor expired. The session has come
   * back when a hook of it arrived after the run ended (`claude --resume <sessionId>`); a session that
   * is ended or gone, or still listed but silent since the run's process ended, has not.
   */
  private held(sid: string, now: number): boolean {
    if (this.quiet(sid)) return true;
    const end = this.runs?.finishedRunEnd(sid);
    if (end === undefined || now - end > MESSAGE_TTL_MS) return false;
    const s = this.sessions.find((x) => x.sid === sid);
    return !s || s.state === "ended" || s.lastEventAt <= end;
  }
  /**
   * RL-1: a pending message's age for the one-hour TTL. A message for a session that belonged to a
   * finished run is aged from the later of its creation and the run's end, so the hour it may have
   * waited while the run was running does not count.
   */
  private messageAge(m: Message, now: number): number {
    return now - Math.max(m.createdAt, this.runs?.finishedRunEnd(m.sid) ?? 0);
  }

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
        accept: () => this.config.accept,
        headless: () => this.runs?.canRun() ?? false,
        machineRepos: () => this.machineRepos(),
        onMessage: (m) => this.receive(m),
        onPulled: (ids) => this.forgetOffers(ids),
        retryDue: () => this.offersAwaitingRetry.size > 0,
        log: (l) => this.deps.log(l),
        now: () => this.deps.now(),
        ...(this.deps.fetch ? { fetch: this.deps.fetch } : {}),
        ...(opts.solo ? { solo: opts.solo } : {}),
        ...(this.deps.hubTimeoutMs ? { timeoutMs: this.deps.hubTimeoutMs } : {}),
        onReplayed: (call, r) => this.replayed(call, r),
        onRejected: (call, e) => this.rejected(call, e),
      });
    }
    const runner = this.deps.headless;
    const runsDir = this.deps.runsDir;
    this.runs =
      runner && runsDir
        ? new HeadlessRuns({
            runner,
            runsDir,
            claudeBin: this.deps.claudeBin ?? "claude",
            meshCommand: this.deps.meshCommand ?? ["mesh"],
            workspaceRoots: () => this.config.workspaceRoots,
            findCheckout: (repo) =>
              this.deps.findCheckout ? this.deps.findCheckout(repo) : findCheckouts(this.config.workspaceRoots).find((c) => c.repo !== undefined && repoMatches(c.repo, repo))?.dir,
            link: () => this.link,
            machineId: () => this.link?.credentials()?.machine,
            secrets: () => [this.config.key, this.link?.credentials()?.token].filter((x): x is string => typeof x === "string" && x.length > 0),
            liveCount: () => this.liveCount(),
            maxSessions: () => this.config.maxSessions,
            pendingCallPaths: () => this.store.pendingCalls().map((c) => c.path),
            sessions: () => this.sessions,
            repoForCwd: (cwd) => this.deps.repoForCwd(cwd),
            now: () => this.deps.now(),
            log: (l) => this.deps.log(l),
          })
        : undefined;
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
    // RL-1: adopt live runs, reap ended ones, queue queued ones again (runs outlive the daemon).
    this.runs?.load();
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
      // MM-2: a session recorded for the first time gets its checkout's labels.
      if (!before.has(s.sid) && s.labels === undefined && s.cwd) {
        const l = initialLabels(s.cwd, (k) => this.store.checkoutLabels(k), (line) => this.deps.log(line));
        if (l?.length) s.labels = l;
      }
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
  private receive(m: InboxMessage): "queued" | "unknown" | "handling" {
    // MM-3: a machine-wide message (no session) is an offer the daemon handles itself.
    if (m.toSid === "") {
      if (m.kind !== "offer") return "unknown";
      void this.handleOffer(m).catch((e) => this.deps.log(`offer ${m.id}: ${String(e)}`));
      return "handling";
    }
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

  /** Ack a machine-wide offer message and remember how, so a later pull does not handle it again. */
  private async ackOffer(m: InboxMessage, state: "delivered" | "failed", method?: string): Promise<void> {
    this.offersHandled.set(m.id, { state, method, acked: false });
    await this.ackHandled(m.id);
  }

  /** Send (again) the ack of a handled offer; until the hub takes it, the offer awaits a retry. */
  private async ackHandled(id: number): Promise<void> {
    const h = this.offersHandled.get(id);
    if (!h || !this.link) return;
    const ok = await this.link.ack(id, h.state, h.method);
    const now = this.offersHandled.get(id);
    if (now) now.acked = now.acked || ok;
    if (ok) this.offersAwaitingRetry.delete(id);
    else this.offersAwaitingRetry.add(id);
  }

  /** After a pull: forget handled offers the hub took the ack of and no longer lists. */
  private forgetOffers(listed: readonly number[]): void {
    const pending = new Set(listed);
    for (const [id, h] of this.offersHandled) if (h.acked && !pending.has(id)) this.offersHandled.delete(id);
    for (const id of this.offersAwaitingRetry) if (!pending.has(id) && !this.offersInFlight.has(id)) this.offersAwaitingRetry.delete(id);
    for (const id of this.offerPicks.keys()) if (!pending.has(id) && !this.offersInFlight.has(id)) this.offerPicks.delete(id);
  }

  /**
   * MM-3: an offer to this machine. `assignments: off` declines it; an `auto` offer is accepted for
   * an idle session (or, under `launch`, a new one); otherwise it is listed for the person. Hub
   * calls carry `Idempotency-Key: offer-<message id>`, so a retry after a lost reply replays the
   * hub's first answer. While the hub cannot be reached the message stays unacked.
   */
  private async handleOffer(m: InboxMessage): Promise<void> {
    const link = this.link;
    if (!link) return;
    if (this.offersHandled.has(m.id)) return await this.ackHandled(m.id);
    if (this.offersInFlight.has(m.id)) return;
    this.offersInFlight.add(m.id);
    try {
      const d = m.data ?? {};
      const step = typeof d.step === "string" ? d.step : undefined;
      if (!step) return await this.ackOffer(m, "failed", "no step");
      const repo = typeof d.repo === "string" ? d.repo : "";
      const topics = Array.isArray(d.topics) ? d.topics.filter((t): t is string => typeof t === "string") : [];
      const sid = typeof d.sid === "string" ? d.sid : undefined;
      const by = typeof d.by === "string" ? d.by : m.fromUser;
      const title = /^MESH: @\S+ offers step \S+ "(.*)" \(repo /.exec(m.text)?.[1] ?? step;
      const key = `offer-${m.id}`;
      const refused = (e: unknown) => e instanceof HubRpcError && e.status >= 400 && e.status < 500 && e.status !== 401;
      const listed = async () => {
        if (notifyChannels(this.config).any) await this.deps.notify("mesh", `@${by} offers ${step} "${title}": mesh offers`);
        await this.ackOffer(m, "delivered", "listed");
      };
      if (this.config.assignments === "off") {
        try {
          await link.rpc("POST", `/v1/steps/${encodeURIComponent(step)}/decline`, { note: "this machine does not take assignments" }, key);
        } catch (e) {
          if (refused(e)) return await this.ackOffer(m, "failed", (e as Error).message);
          this.offersAwaitingRetry.add(m.id);
          return; // the hub is away: handled again on a later pull
        }
        return await this.ackOffer(m, "delivered", "declined");
      }
      // RL-1: a headless offer is never bound to a session; it runs as `claude -p` (or is queued).
      if (d.mode === "headless") {
        if (d.auto !== true) return await listed();
        if (!this.runs) {
          try {
            await link.rpc("POST", `/v1/steps/${encodeURIComponent(step)}/decline`, { note: "this machine cannot run headless steps" }, key);
          } catch (e) {
            if (refused(e)) return await this.ackOffer(m, "failed", (e as Error).message);
            this.offersAwaitingRetry.add(m.id);
            return;
          }
          return await this.ackOffer(m, "delivered", "declined");
        }
        const r = await this.runs.handleOffer(m, title);
        if (r === "retry") {
          this.offersAwaitingRetry.add(m.id);
          return;
        }
        return await this.ackOffer(m, r.state, r.method);
      }
      if (d.auto === true) {
        // A retry keeps the session it picked before (the hub may already hold the step for it);
        // sessions reserved for other offers are left out: offers of one pull run concurrently.
        const before = this.offerPicks.get(m.id);
        const s =
          (before ? this.sessions.find((x) => x.sid === before && x.state !== "ended") : undefined) ??
          pickSession(this.sessions.filter((x) => !this.reservedForOffer(x.sid)), { repo, topics, ...(sid ? { sid } : {}) });
        if (s) {
          this.offerPicks.set(m.id, s.sid);
          let accepted: Step | undefined;
          try {
            accepted = await link.rpc<Step>("POST", `/v1/steps/${encodeURIComponent(step)}/accept`, { sid: s.sid }, key);
          } catch (e) {
            if (refused(e)) {
              this.offerPicks.delete(m.id);
              return await this.ackOffer(m, "failed", (e as Error).message);
            }
            this.offersAwaitingRetry.add(m.id);
            return; // reserved until the retry
          }
          // A retry replays the hub's first answer, which may name the session picked then.
          const holder = accepted?.holderSid && this.sessions.some((x) => x.sid === accepted.holderSid && x.state !== "ended") ? accepted.holderSid : s.sid;
          this.bindOffered(holder, step);
          this.offerPicks.delete(m.id);
          return await this.ackOffer(m, "delivered", "accepted");
        }
        if (this.config.assignments === "launch") {
          // MM-4: check and reserve a place with no await in between, so the offers of one pull
          // (handled concurrently) respect maxSessions together.
          const max = this.config.maxSessions;
          if (max !== undefined) {
            const n = this.liveCount();
            if (n >= max) {
              this.deps.log(`not starting a session for offered step ${step}: ${n} live sessions, maxSessions ${max}`);
              return await listed();
            }
            this.pendingLaunches.set(m.id, { step, at: this.deps.now() });
          }
          let r: { ok: boolean; error?: string };
          try {
            r = (await this.deps.launchStep?.(repo.slice(repo.lastIndexOf("/") + 1), step)) ?? { ok: false, error: "no launcher" };
          } catch (e) {
            r = { ok: false, error: String(e) };
          }
          if (!r.ok) this.pendingLaunches.delete(m.id);
          if (r.ok) return await this.ackOffer(m, "delivered", "launched");
          this.deps.log(`could not start a session for offered step ${step}: ${r.error ?? "unknown error"}`);
        }
      }
      await listed();
    } finally {
      this.offersInFlight.delete(m.id);
    }
  }

  /**
   * MM-4: live sessions for `maxSessions`: the non-ended sessions (any agent or kind, launching
   * included) plus launches started for an offer that no session holding that step has shown yet,
   * each for at most LAUNCH_PENDING_MS.
   */
  private liveCount(): number {
    const now = this.deps.now();
    const live = this.sessions.filter((x) => x.state !== "ended");
    for (const [id, p] of this.pendingLaunches) {
      if (now - p.at >= LAUNCH_PENDING_MS || live.some((x) => x.step === p.step)) this.pendingLaunches.delete(id);
    }
    return live.length + this.pendingLaunches.size + (this.runs?.runningWithoutSession() ?? 0);
  }

  /** A session took an offered step: bind it and queue the brief (delivered when the session is idle). */
  private bindOffered(sid: string, step: string): void {
    this.update(sid, { step, nudges: 0, escalated: false });
    this.store.queueMessage(sid, stepMessage(step), this.deps.now());
    void this.deliverPending(sid).catch(() => undefined);
  }

  /** `POST /local/accept`: accept an offered step for a session of this machine. */
  async acceptLocal(b: { step?: unknown; target?: unknown }): Promise<{ step: string; sid: string; message: string }> {
    const link = this.link;
    if (!link?.credentials()) throw new HttpError(409, "not logged in to a hub; run: mesh login");
    if (typeof b.step !== "string" || !b.step) throw new HttpError(400, "expected {step, target?}");
    try {
      const view = await link.rpc<StepView>("GET", `/v1/steps/${encodeURIComponent(b.step)}`);
      const st = view.context.step;
      // RL-1: a headless step is never bound to a session (Open question: manual accept).
      if (st.policy?.mode === "headless") throw new HttpError(409, `${st.id} is a headless step; this machine runs it only from an auto-accepted offer`);
      let s: Session | undefined;
      if (typeof b.target === "string" && b.target) {
        s = findSession(this.sessions, b.target);
        if (!s) throw new HttpError(404, `no live session matches "${b.target}"`);
      } else {
        const named = st.offer?.state === "offered" ? st.offer.to.sid : undefined;
        s = pickSession(this.sessions.filter((x) => !this.reservedForOffer(x.sid)), { repo: st.repo, topics: view.context.goal.topics ?? [], ...(named ? { sid: named } : {}) });
        if (!s) throw new HttpError(409, `no idle session for ${st.repo} on this machine; use --session <s> or --launch`);
      }
      // Reserved while the hub answers, so an auto offer handled meanwhile does not pick it too.
      const picked = s.sid;
      this.localPicks.add(picked);
      try {
        await link.rpc<Step>("POST", `/v1/steps/${encodeURIComponent(st.id)}/accept`, { sid: picked }, randomUUID());
        this.bindOffered(picked, st.id);
      } finally {
        this.localPicks.delete(picked);
      }
      return { step: st.id, sid: s.sid, message: `${sessionName(s)} now holds ${st.id}` };
    } catch (e) {
      throw e instanceof HubRpcError ? new HttpError(e.status, e.message) : e;
    }
  }

  /** `GET /local/offers`: open offers to this machine. */
  async offersLocal(): Promise<{ offers: OfferView[] }> {
    const c = this.link?.credentials();
    if (!this.link || !c) throw new HttpError(409, "not logged in to a hub; run: mesh login");
    try {
      const { offers } = await this.link.rpc<{ offers: OfferView[] }>("GET", "/v1/offers");
      return { offers: offers.filter((o) => o.machine === c.machine) };
    } catch (e) {
      throw e instanceof HubRpcError ? new HttpError(e.status, e.message) : e;
    }
  }

  /** RL-4 `GET /local/debriefs`: the hub's `GET /v1/debriefs` for this login. */
  async debriefsLocal(): Promise<DebriefList> {
    if (!this.link?.credentials()) throw new HttpError(409, "not logged in to a hub; run: mesh login");
    try {
      return await this.link.rpc<DebriefList>("GET", "/v1/debriefs");
    } catch (e) {
      throw e instanceof HubRpcError ? new HttpError(e.status, e.message) : e;
    }
  }

  /** RL-4 `POST /local/revert`: revert a debrief decision at the hub. */
  async revertLocal(b: { step?: unknown; fingerprint?: unknown }): Promise<RevertResult> {
    if (!this.link?.credentials()) throw new HttpError(409, "not logged in to a hub; run: mesh login");
    if (typeof b.step !== "string" || !b.step || typeof b.fingerprint !== "string" || !b.fingerprint) throw new HttpError(400, "expected {step, fingerprint}");
    try {
      return await this.link.rpc<RevertResult>("POST", `/v1/steps/${encodeURIComponent(b.step)}/dispositions/revert`, { fingerprint: b.fingerprint }, randomUUID());
    } catch (e) {
      throw e instanceof HubRpcError ? new HttpError(e.status, e.message) : e;
    }
  }

  /** `POST /local/decline`: decline an offer at the hub. */
  async declineLocal(b: { step?: unknown; note?: unknown }): Promise<{ step: Step }> {
    if (!this.link?.credentials()) throw new HttpError(409, "not logged in to a hub; run: mesh login");
    if (typeof b.step !== "string" || !b.step) throw new HttpError(400, "expected {step, note?}");
    const note = typeof b.note === "string" && b.note ? b.note : undefined;
    try {
      return { step: await this.link.rpc<Step>("POST", `/v1/steps/${encodeURIComponent(b.step)}/decline`, note ? { note } : {}, randomUUID()) };
    } catch (e) {
      throw e instanceof HubRpcError ? new HttpError(e.status, e.message) : e;
    }
  }

  /** `POST /local/session-accept`: set (or, with null, clear) a session's accept override. */
  sessionAccept(b: { target?: unknown; accept?: unknown }): { session: Session } {
    if (typeof b.target !== "string" || !b.target || (b.accept !== null && !Array.isArray(b.accept))) throw new HttpError(400, "expected {target, accept: [rules] | null}");
    const s = findSession(this.sessions, b.target);
    if (!s) throw new HttpError(404, `no live session matches "${b.target}"`);
    if (b.accept === null) return { session: this.update(s.sid, { accept: undefined }) as Session };
    const r = parseAccept((b.accept as unknown[]).map(String));
    if ("error" in r) throw new HttpError(400, r.error);
    return { session: this.update(s.sid, { accept: r.accept }) as Session };
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
      secrets: () => [this.config.key, this.link?.credentials()?.token].filter((x): x is string => typeof x === "string" && x.length > 0),
      artifactStored: (sid, id, redactions) => this.runs?.artifactStored(sid, id, redactions),
      git: (cwd, args) => (this.deps.headless ? this.deps.headless.git(cwd, args) : runCommand("git", args, { cwd, timeoutMs: 30_000 })),
      runOf: (sid) => this.runs?.runForSid(sid),
      reviewStored: (sid, n) => this.runs?.reviewStored(sid, n),
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

  /**
   * MM-2 `POST /local/labels`: set, add or remove a live session's labels (and remember the new list
   * for its checkout), or remember a list for the checkout of a cwd. Every check runs before any
   * write, so a refused call changes nothing.
   */
  async labels(body: unknown): Promise<LabelsResult> {
    const USAGE = "expected {target, labels, mode: set|add|rm} or {cwd, labels}";
    const b = (body && typeof body === "object" ? body : {}) as Record<string, unknown>;
    const raw = b.labels;
    if (!Array.isArray(raw) || !raw.every((l) => typeof l === "string")) throw new HttpError(400, USAGE);
    if (typeof b.target === "string" && b.target) {
      const mode = b.mode;
      if (mode !== "set" && mode !== "add" && mode !== "rm") throw new HttpError(400, USAGE);
      const s = findSession(this.sessions, b.target);
      if (!s) throw new HttpError(404, `no live session matches "${b.target}"`);
      const r = parseLabels(raw as string[]);
      if ("error" in r) throw new HttpError(400, r.error);
      const cur = s.labels ?? [];
      const next =
        mode === "set" ? r.labels : mode === "add" ? [...new Set([...cur, ...r.labels])].sort() : cur.filter((l) => !r.labels.includes(l));
      if (next.length > MAX_LABELS) throw new HttpError(400, `at most ${MAX_LABELS} labels`);
      const updated = this.update(s.sid, { labels: next.length ? next : undefined }) as Session;
      if (s.cwd) this.store.setCheckoutLabels(checkoutKey(s.cwd), next);
      return { session: updated, ...(await this.unknownOf(next)) };
    }
    if (typeof b.cwd === "string" && b.cwd) {
      const r = parseLabels(raw as string[]);
      if ("error" in r) throw new HttpError(400, r.error);
      const key = checkoutKey(b.cwd);
      this.store.setCheckoutLabels(key, r.labels);
      return { cwd: key, labels: r.labels, ...(await this.unknownOf(r.labels)) };
    }
    throw new HttpError(400, USAGE);
  }

  /** Labels that are not topics on the hub; `{}` when no hub could be asked (within 2 s). */
  private async unknownOf(labels: readonly string[]): Promise<{ unknown?: string[] }> {
    const link = this.link;
    if (!link?.credentials()) return {};
    let timer: NodeJS.Timeout | undefined;
    try {
      const timeout = new Promise<undefined>((done) => {
        timer = setTimeout(() => done(undefined), 2_000);
        timer.unref();
      });
      const reply = await Promise.race([link.rpc<{ topics: { name: string }[] }>("GET", "/v1/topics"), timeout]);
      if (!reply || !Array.isArray(reply.topics)) return {};
      const defined = new Set(reply.topics.map((t) => t.name));
      return { unknown: labels.filter((l) => !defined.has(l)).sort() };
    } catch {
      return {};
    } finally {
      if (timer) clearTimeout(timer);
    }
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

    // RL-1: a headless run's session gets no messages; they stay in the inbox.
    if (kind === "Stop" && this.quiet(sid)) return {};
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
    const placeholders = new Set(this.sessions.filter((x) => x.launching).map((x) => x.sid));
    const result = applyHook(this.sessions, ev, this.ctx());
    this.commit(result);
    const sid = result.changed[0] as string;
    this.store.appendHookEvent(sid, ev);
    // RL-1: the session of a headless run holds the run's step at once, whatever the hub bind answers.
    if (ev.kind === "SessionStart" && this.runs) {
      const runStep = this.runs.onSessionStart(sid, ev.claudeSessionId);
      if (runStep && this.sessions.find((x) => x.sid === sid)?.step !== runStep) this.update(sid, { step: runStep, nudges: 0, escalated: false });
    }
    // The step to bind: the hook's MESH_STEP, else the step of the `mesh run` placeholder this
    // session just took over (MM-3: `mesh accept --launch` and the launcher open such windows).
    const hint = ev.stepHint ?? (placeholders.has(sid) ? this.sessions.find((x) => x.sid === sid)?.step : undefined);
    if (ev.kind === "SessionStart" && hint && this.link) {
      const s = this.sessions.find((x) => x.sid === sid);
      // Bind the step to this session at the hub (so its messages reach it), once per session and
      // step. A `mesh run` window's placeholder already carries the step: bind it anyway.
      const key = `${sid}:${hint}`;
      if (s && (s.step !== hint || !this.boundSteps.has(key))) {
        this.boundSteps.add(key);
        const step = hint;
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
      if (entries !== null) {
        this.commit(applyObservation(this.sessions, entries, this.ctx()));
        await this.checkLaunches();
      }
      // RL-1: queue, budgets and ends of headless runs. An ended run waiting for the hub gets a
      // flush first, so a mesh_done queued while offline is replayed before its end is handled.
      // A run's hub call waiting for a retry while the link is offline checks the hub at once.
      const probeNow = this.runs?.retryDue() === true;
      if (probeNow || this.runs?.waitingOnHub()) await this.link?.flush({ probeNow });
      await this.runs?.reconcile();
      if (entries === null) return;
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
      if (this.quiet(s.sid)) continue;
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
      // RL-1: a headless run's messages stay in the inbox (no expiry while it runs; aged from the run's end once it finished).
      if (this.messageAge(m, now) > MESSAGE_TTL_MS && !this.held(m.sid, now)) this.settle(m, "failed", "not delivered within an hour");
    }
    for (const [sid, m] of firstPerSession) {
      if (this.messageAge(m, now) > MESSAGE_TTL_MS || this.delivering.has(sid) || this.held(sid, now)) continue;
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
      if (req.method === "GET" && path === "/local/runs") return send(res, 200, { runs: this.runs?.list() ?? [] });
      if (req.method === "POST" && path === "/local/launch") {
        const body = LaunchRequest.safeParse(await readJson(req));
        if (!body.success) throw new HttpError(400, "expected {pane, cwd}");
        return send(res, 200, { session: (await this.launch(body.data)) ?? null });
      }
      if (req.method === "POST" && path === "/local/labels") return send(res, 200, await this.labels(await readJson(req)));
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
      if (req.method === "POST" && path === "/local/accept") return send(res, 200, await this.acceptLocal((await readJson(req)) as Record<string, unknown>));
      if (req.method === "GET" && path === "/local/offers") return send(res, 200, await this.offersLocal());
      if (req.method === "POST" && path === "/local/decline") return send(res, 200, await this.declineLocal((await readJson(req)) as Record<string, unknown>));
      if (req.method === "GET" && path === "/local/debriefs") return send(res, 200, await this.debriefsLocal());
      if (req.method === "POST" && path === "/local/revert") return send(res, 200, await this.revertLocal((await readJson(req)) as Record<string, unknown>));
      if (req.method === "POST" && path === "/local/session-accept") return send(res, 200, this.sessionAccept((await readJson(req)) as Record<string, unknown>));
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
