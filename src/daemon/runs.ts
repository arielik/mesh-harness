// RL-1: headless runs. An auto-accepted headless offer is never bound to a session: the daemon
// accepts it at the hub, writes a run file and starts `claude -p` in a fresh detached worktree (or
// queues it at maxSessions). `reconcile()` checks budgets and ends: a run that ended without an
// accepted mesh_done is closed as failed with a rendered transcript, a `propose-via-branch` run's
// commits are pushed to mesh/<slug>, and the telemetry goes to the hub. Run files survive the
// daemon: a restart adopts live runs and reaps dead ones (it never signals a process it cannot
// identify).

import { existsSync, mkdirSync, readdirSync, readFileSync, appendFileSync } from "node:fs";
import { hostname } from "node:os";
import { basename, join } from "node:path";
import { randomUUID } from "node:crypto";
import type { HeadlessRunner } from "../claude/index.ts";
import { agentFileHash, builtinProfile, headlessArgv, headlessPrompt, parseAgentFile, profileSha256, redactSecrets, renderTail, stepSlug, telemetryFromStream } from "../core/index.ts";
import {
  MESH_TOOL_RULES,
  ProfileSnapshot,
  RunFile,
  writeFileAtomic,
  type InboxMessage,
  type RunExit,
  type RunTelemetry,
  type Session,
  type Step,
  type StepView,
  type StoredArtifact,
  type DoneResult,
  type Repo,
} from "../protocol/index.ts";
import { HubRpcError, type HubLink } from "./hub-link.ts";

export interface RunsDeps {
  runner: HeadlessRunner;
  runsDir: string;
  claudeBin: string;
  /** The absolute command that starts this mesh (`mcp.json` runs `<command> mcp`). */
  meshCommand: readonly string[];
  workspaceRoots(): readonly string[];
  findCheckout(repo: string): string | undefined;
  link(): HubLink | undefined;
  /** This machine's id at the hub. */
  machineId(): string | undefined;
  /** Literals redacted from transcripts (the daemon key, the hub token). */
  secrets(): string[];
  /** The live count for maxSessions (sessions, pending launches, runs whose session is not seen yet). */
  liveCount(): number;
  maxSessions(): number | undefined;
  /** Paths of the calls queued while the hub was offline. */
  pendingCallPaths(): string[];
  sessions(): readonly Session[];
  /** The repo of a folder (its name names the agent: `<repo name>/<agent>`). */
  repoForCwd(cwd: string): Repo | undefined;
  now(): number;
  log(line: string): void;
}

export type OfferOutcome = { state: "delivered" | "failed"; method: string } | "retry";

/** Run-directory sidecar: what the offer said and which local sessions are the run's. */
interface RunMeta {
  offerId?: number | undefined;
  title?: string | undefined;
  agent?: string | undefined;
  /** Daemon session ids of the run's session (registered with the run's sessionId). */
  sids: string[];
  /** Why the run did not start, when it did not. */
  notStarted?: string | undefined;
}

/** Run-directory sidecar: progress of the run's hub calls, so a retry goes on where it stopped. */
interface RunEnd {
  startedDone?: boolean;
  decided?: "closed" | "own-round" | "none";
  round?: number;
  transcriptDone?: boolean;
  doneDone?: boolean;
  pushDone?: boolean;
  branch?: string;
  finishedDone?: boolean;
  releaseDone?: boolean;
}

type CallResult<T> = { ok: true; value: T } | { ok: false; retry: boolean };

const readJsonFile = <T>(path: string, fallback: T): T => {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as T;
  } catch {
    return fallback;
  }
};

const firstLine = (t: string) => t.split("\n").find((l) => l.trim() !== "")?.trim() ?? "";

export class HeadlessRuns {
  private readonly deps: RunsDeps;
  private runs = new Map<string, RunFile>();
  private busy = false;

  constructor(deps: RunsDeps) {
    this.deps = deps;
  }

  // ---------- files ----------

  private file(run: RunFile, name: string): string {
    return join(run.dir, name);
  }

  private save(run: RunFile): void {
    const parsed = RunFile.parse(run);
    this.runs.set(parsed.runId, parsed);
    writeFileAtomic(this.file(parsed, "run.json"), `${JSON.stringify(parsed, null, 2)}\n`);
  }

  private metas = new Map<string, RunMeta>();

  private meta(run: RunFile): RunMeta {
    let m = this.metas.get(run.runId);
    if (!m) {
      m = { sids: [], ...readJsonFile<Partial<RunMeta>>(this.file(run, "meta.json"), {}) } as RunMeta;
      this.metas.set(run.runId, m);
    }
    return m;
  }

  private saveMeta(run: RunFile, m: RunMeta): void {
    this.metas.set(run.runId, m);
    writeFileAtomic(this.file(run, "meta.json"), `${JSON.stringify(m)}\n`);
  }

  private end(run: RunFile): RunEnd {
    return readJsonFile<RunEnd>(this.file(run, "end.json"), {});
  }

  private saveEnd(run: RunFile, e: RunEnd): void {
    writeFileAtomic(this.file(run, "end.json"), `${JSON.stringify(e)}\n`);
  }

  private read(run: RunFile, name: string): string {
    try {
      return readFileSync(this.file(run, name), "utf8");
    } catch {
      return "";
    }
  }

  /** `Daemon.start()`: read every run file; adopt live runs, reap dead ones, queue queued ones again. */
  load(): void {
    let names: string[];
    try {
      names = readdirSync(this.deps.runsDir);
    } catch {
      return;
    }
    for (const name of names.sort()) {
      const path = join(this.deps.runsDir, name, "run.json");
      if (!existsSync(path)) continue;
      const parsed = RunFile.safeParse(readJsonFile<unknown>(path, undefined));
      if (!parsed.success) {
        this.deps.log(`run file ${path} is not valid; skipped`);
        continue;
      }
      const run = parsed.data;
      this.runs.set(run.runId, run);
      if (run.state !== "running" || run.endedAt !== undefined) continue;
      const exitFile = existsSync(this.file(run, "exit"));
      const live = !exitFile && run.pid !== undefined && run.startId !== undefined && this.deps.runner.alive(run.pid, run.startId);
      if (live) {
        this.deps.log(`run ${run.runId}: adopted (pid ${run.pid})`);
        continue;
      }
      // Ended while the daemon was down (or the pid now names another process): reaped, never signalled.
      this.markEnded(run);
      this.deps.log(`run ${run.runId}: reaped`);
    }
  }

  /** Runs for `GET /local/runs`, by `acceptedAt`. */
  list(): RunFile[] {
    return [...this.runs.values()].sort((a, b) => a.acceptedAt - b.acceptedAt || (a.runId < b.runId ? -1 : 1));
  }

  /** The machine can run headless steps: a runner, a runs directory and a workspace root. */
  canRun(): boolean {
    return this.deps.workspaceRoots().length > 0;
  }

  /** Daemon sessions that are this run's (registered with its sessionId). */
  private runSids(run: RunFile): Set<string> {
    const out = new Set<string>([run.sessionId, ...this.meta(run).sids]);
    for (const s of this.deps.sessions()) if (s.claudeSessionIds.includes(run.sessionId)) out.add(s.sid);
    return out;
  }

  /** Does this daemon session belong to the run (registered with its sessionId, or remembered in meta)? */
  private ownsSid(run: RunFile, sid: string, claudeSessionIds: readonly string[] | undefined): boolean {
    return run.sessionId === sid || (claudeSessionIds?.includes(run.sessionId) ?? false) || this.meta(run).sids.includes(sid);
  }

  /**
   * Is this daemon session a running headless run's session (including a run whose process ended
   * and that waits for the hub)? Such a session gets no messages. A finished run's session is not
   * muted: a person may resume it (`claude --resume <sessionId>`) and use it as any other session.
   */
  isRunSession(sid: string): boolean {
    const s = this.deps.sessions().find((x) => x.sid === sid);
    for (const run of this.runs.values()) {
      if (run.state === "running" && this.ownsSid(run, sid, s?.claudeSessionIds)) return true;
    }
    return false;
  }

  /**
   * When this daemon session belongs to a finished run: the latest time such a run ended. The daemon
   * keeps the session's undelivered messages for an hour after that (AC-39: still in the inbox after
   * the run ends), then settles them as usual.
   */
  finishedRunEnd(sid: string): number | undefined {
    const s = this.deps.sessions().find((x) => x.sid === sid);
    let end: number | undefined;
    for (const run of this.runs.values()) {
      if (run.state !== "finished" || !this.ownsSid(run, sid, s?.claudeSessionIds)) continue;
      const at = run.endedAt ?? run.acceptedAt;
      if (end === undefined || at > end) end = at;
    }
    return end;
  }

  /** A session started with a run's sessionId: remember it; returns the run's step. */
  onSessionStart(sid: string, claudeSessionId: string): string | undefined {
    for (const run of this.runs.values()) {
      if (run.state !== "running" || run.sessionId !== claudeSessionId) continue;
      const m = this.meta(run);
      if (!m.sids.includes(sid)) this.saveMeta(run, { ...m, sids: [...m.sids, sid] });
      return run.step;
    }
    return undefined;
  }

  /** Running runs whose session has not shown up (or has ended already): they count for maxSessions. */
  runningWithoutSession(): number {
    let n = 0;
    for (const run of this.runs.values()) {
      if (run.state !== "running" || run.endedAt !== undefined || run.startedAt === undefined) continue;
      const seen = this.deps.sessions().some((s) => s.state !== "ended" && s.claudeSessionIds.includes(run.sessionId));
      if (!seen) n++;
    }
    return n;
  }

  /**
   * An ended run waits for the hub (offline, or a call of its step queued while offline): the
   * daemon flushes before the runs pass, so a queued mesh_done is replayed first.
   */
  waitingOnHub(): boolean {
    const link = this.deps.link();
    const paths = this.deps.pendingCallPaths();
    return [...this.runs.values()].some(
      (r) => r.state === "running" && r.endedAt !== undefined && (link?.offline === true || paths.some((p) => p.startsWith(this.stepPath(r.step, "/")))),
    );
  }

  /**
   * A hub call of a run waits for a retry (its `run started`, an end-of-run call, or a release)
   * while the link is offline: the daemon then checks the hub at once instead of waiting for the
   * probe backoff, so a call that got no answer (hub down, reply lost) is retried on a later tick.
   */
  retryDue(): boolean {
    if (this.deps.link()?.offline !== true) return false;
    return [...this.runs.values()].some((r) => {
      if (r.state === "queued") return this.deps.now() >= r.deadline;
      if (r.state !== "running") return false;
      return r.endedAt !== undefined || (r.startedAt !== undefined && !this.end(r).startedDone);
    });
  }

  /** A session stored an artifact; a run's session counts its redactions. */
  artifactStored(sid: string, id: string, redactions: number): void {
    for (const run of this.runs.values()) {
      if (run.state !== "running") continue;
      if (!this.runSids(run).has(sid)) continue;
      appendFileSync(this.file(run, "artifacts.jsonl"), `${JSON.stringify({ id, redactions })}\n`);
      return;
    }
  }

  /** RL-2: the running run a daemon session belongs to (its worktree and agent), if any. */
  runForSid(sid: string): { worktree?: string | undefined; agent?: { name: string; key: string; hash: string } | undefined } | undefined {
    for (const run of this.runs.values()) {
      if (run.state !== "running" || run.endedAt !== undefined) continue;
      if (!this.runSids(run).has(sid)) continue;
      return { worktree: run.worktree, agent: run.agent };
    }
    return undefined;
  }

  /** RL-2: a session's review record was stored; a run's session counts its undeclared rules. */
  reviewStored(sid: string, undeclaredRules: number): void {
    for (const run of this.runs.values()) {
      if (run.state !== "running") continue;
      if (!this.runSids(run).has(sid)) continue;
      appendFileSync(this.file(run, "reviews.jsonl"), `${JSON.stringify({ undeclaredRules })}\n`);
      return;
    }
  }

  // ---------- hub calls ----------

  /**
   * One hub call of a run, with `Idempotency-Key: run-<runId>-<name>`. Retried later (offline, 5xx,
   * network) or final: any other 4xx is logged and counts as done.
   */
  private async call<T>(run: RunFile, name: string, method: "GET" | "POST", path: string, body?: unknown, key?: string): Promise<CallResult<T>> {
    const link = this.deps.link();
    if (!link) return { ok: false, retry: true };
    try {
      return { ok: true, value: await link.rpc<T>(method, path, body, key ?? (method === "POST" ? `run-${run.runId}-${name}` : undefined)) };
    } catch (e) {
      if (e instanceof HubRpcError && e.status < 500) {
        this.deps.log(`run ${run.runId}: ${method} ${path} refused by the hub: ${e.message}`);
        return { ok: false, retry: false };
      }
      return { ok: false, retry: true };
    }
  }

  private stepPath(step: string, tail = ""): string {
    return `/v1/steps/${encodeURIComponent(step)}${tail}`;
  }

  // ---------- offers ----------

  /** A headless offer (auto, assignments deliver or launch). */
  async handleOffer(m: InboxMessage, title: string): Promise<OfferOutcome> {
    const d = m.data ?? {};
    const step = String(d.step);
    const repo = typeof d.repo === "string" ? d.repo : "";
    const goal = typeof d.goal === "string" ? d.goal : step.split(".")[0] ?? step;
    const key = `offer-${m.id}`;
    // A restarted daemon may see the offer again: never accept and start it twice.
    const existing = [...this.runs.values()].find((r) => this.meta(r).offerId === m.id);
    if (existing) return { state: "delivered", method: existing.state === "queued" ? "queued" : "headless" };
    const decline = async (note: string): Promise<OfferOutcome> => {
      const link = this.deps.link();
      if (!link) return "retry";
      try {
        await link.rpc("POST", this.stepPath(step, "/decline"), { note }, key);
        return { state: "delivered", method: "declined" };
      } catch (e) {
        if (e instanceof HubRpcError && e.status < 500 && e.status !== 401) return { state: "failed", method: e.message };
        return "retry";
      }
    };
    if (!this.canRun()) return await decline("this machine cannot run headless steps");
    const checkout = this.deps.findCheckout(repo);
    if (!checkout) return await decline(`repo ${repo} is not on this machine`);
    const snap = ProfileSnapshot.safeParse(d.profile);
    if (!snap.success) return { state: "failed", method: "the offer carries no valid profile" };
    const b = (d.budget ?? {}) as { turns?: unknown; minutes?: unknown; usd?: unknown };
    const budget = {
      turns: typeof b.turns === "number" ? b.turns : 30,
      minutes: typeof b.minutes === "number" ? b.minutes : 30,
      ...(typeof b.usd === "number" ? { usd: b.usd } : {}),
    };
    const link = this.deps.link();
    if (!link) return "retry";
    try {
      await link.rpc<Step>("POST", this.stepPath(step, "/accept"), {}, key);
    } catch (e) {
      if (e instanceof HubRpcError && e.status < 500 && e.status !== 401) return { state: "failed", method: e.message };
      return "retry";
    }
    const now = this.deps.now();
    const runId = `${stepSlug(step)}-${now.toString(36)}`;
    const dir = join(this.deps.runsDir, runId);
    mkdirSync(dir, { recursive: true });
    const run: RunFile = {
      runId,
      step,
      goal,
      repo,
      state: "queued",
      acceptedAt: now,
      deadline: typeof d.deadline === "number" ? d.deadline : now + 30 * 60_000,
      sessionId: randomUUID(),
      checkout,
      dir,
      profile: { name: snap.data.name, sha256: snap.data.sha256, base: snap.data.base },
      budget,
    };
    this.saveMeta(run, { offerId: m.id, title, ...(typeof d.agent === "string" && d.agent ? { agent: d.agent } : {}), sids: [] });
    writeFileAtomic(this.file(run, "profile.json"), JSON.stringify(snap.data.settings));
    this.save(run);
    const max = this.deps.maxSessions();
    if (max === undefined || this.deps.liveCount() < max) {
      await this.start(run);
      return { state: "delivered", method: "headless" };
    }
    this.deps.log(`run ${runId}: queued (maxSessions ${max})`);
    return { state: "delivered", method: "queued" };
  }

  // ---------- start ----------

  private repoName(run: RunFile): string {
    return this.deps.repoForCwd(run.checkout)?.name ?? (basename(run.repo) || basename(run.checkout));
  }

  /** The run did not start: it ends at once (`crashed`) and is closed with this reason. */
  private notStarted(run: RunFile, reason: string): void {
    this.saveMeta(run, { ...this.meta(run), notStarted: reason });
    this.save({ ...run, state: "running", endedAt: this.deps.now() });
    this.deps.log(`run ${run.runId}: headless run of ${run.step} did not start: ${reason}`);
  }

  private async start(run: RunFile): Promise<void> {
    const { runner } = this.deps;
    const meta = this.meta(run);
    const worktree = join(run.dir, "worktree");
    const add = await runner.git(run.checkout, ["worktree", "add", "--detach", worktree, "HEAD"]);
    if (add.code !== 0) return this.notStarted(run, `could not make a worktree: ${firstLine(add.stderr)}`);
    const head = await runner.git(worktree, ["rev-parse", "HEAD"]);
    let next: RunFile = { ...run, worktree, ...(head.code === 0 ? { baseCommit: head.stdout.trim() } : {}) };
    this.save(next);
    const [cmd, ...rest] = this.deps.meshCommand;
    writeFileAtomic(this.file(run, "mcp.json"), JSON.stringify({ mcpServers: { mesh: { command: cmd ?? "mesh", args: [...rest, "mcp"] } } }));
    if (!existsSync(this.file(run, "profile.json"))) {
      // A run file written without its profile.json: a built-in profile with the same hash is rebuilt.
      const b = builtinProfile(run.profile.name);
      if (!b || profileSha256(b.base, b.settings) !== run.profile.sha256) return this.notStarted(next, "the run's profile.json is missing");
      writeFileAtomic(this.file(run, "profile.json"), JSON.stringify(b.settings));
    }
    if (meta.agent) {
      const path = join(worktree, ".claude", "agents", `${meta.agent}.md`);
      let text: string;
      try {
        text = readFileSync(path, "utf8");
      } catch {
        return this.notStarted(next, `no agent ${meta.agent} in ${this.repoName(run)}/.claude/agents`);
      }
      const a = parseAgentFile(text);
      const tools = a.tools ? [...a.tools, ...MESH_TOOL_RULES.filter((r) => !a.tools?.includes(r))] : undefined;
      const def = { description: a.description ?? "", prompt: a.body.trim(), ...(tools ? { tools } : {}), ...(a.model ? { model: a.model } : {}) };
      writeFileAtomic(this.file(run, "agents.json"), JSON.stringify({ [meta.agent]: def }));
      next = { ...next, agent: { name: meta.agent, key: `${this.repoName(run)}/${meta.agent}`, hash: agentFileHash(text) } };
      this.save(next);
    }
    const argv = headlessArgv({
      claudeBin: this.deps.claudeBin,
      prompt: headlessPrompt(run.step, meta.title ?? run.step),
      sessionId: run.sessionId,
      maxTurns: run.budget.turns + 1,
      runDir: run.dir,
      agent: meta.agent,
      usd: run.budget.usd,
    });
    const r = await runner.start({ argv, cwd: worktree, env: { MESH_STEP: run.step, MESH_RUN: run.runId }, runDir: run.dir });
    if (!r.ok) return this.notStarted(next, r.error);
    next = { ...next, state: "running", pid: r.pid, startId: r.startId, startedAt: this.deps.now() };
    this.save(next);
    this.deps.log(`run ${run.runId}: started ${run.step} (pid ${r.pid})`);
    await this.reportStarted(next);
  }

  private async reportStarted(run: RunFile): Promise<void> {
    const e = this.end(run);
    if (e.startedDone || run.startedAt === undefined) return;
    const r = await this.call(run, "started", "POST", this.stepPath(run.step, "/run"), { state: "started", runId: run.runId });
    if (r.ok || !r.retry) this.saveEnd(run, { ...this.end(run), startedDone: true });
  }

  // ---------- reconcile ----------

  /** Queue, budgets, ends. Called from the daemon's reconcile (never on a timer of its own). */
  async reconcile(): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    try {
      await this.queuePass();
      let ended = false;
      for (const run of [...this.runs.values()]) {
        if (run.state !== "running") continue;
        const cur = this.runs.get(run.runId) as RunFile;
        if (cur.endedAt === undefined) {
          if (!this.end(cur).startedDone) await this.reportStarted(cur);
          this.checkBudget(cur);
          await this.detectEnd(cur);
        }
        const now = this.runs.get(run.runId) as RunFile;
        if (now.endedAt !== undefined && now.state === "running") {
          await this.finish(now);
          if ((this.runs.get(run.runId) as RunFile).state === "finished") ended = true;
        }
      }
      if (ended) await this.queuePass();
    } finally {
      this.busy = false;
    }
  }

  /** Queued runs, oldest first: release those past their deadline, start while there is room. */
  private async queuePass(): Promise<void> {
    const queued = [...this.runs.values()].filter((r) => r.state === "queued").sort((a, b) => a.acceptedAt - b.acceptedAt);
    for (const run of queued) {
      const now = this.deps.now();
      if (now >= run.deadline) {
        const e = this.end(run);
        if (!e.releaseDone) {
          const note = `capacity: no free session on ${hostname()} before the run deadline`;
          const r = await this.call(run, "release", "POST", this.stepPath(run.step, "/release"), { note });
          if (!r.ok && r.retry) continue;
          this.saveEnd(run, { ...this.end(run), releaseDone: true });
        }
        this.save({ ...run, state: "released" });
        this.deps.log(`run ${run.runId}: released (no free session before the deadline)`);
        continue;
      }
      const max = this.deps.maxSessions();
      if (max !== undefined && this.deps.liveCount() >= max) continue;
      await this.start(run);
    }
  }

  private checkBudget(run: RunFile): void {
    if (run.pid === undefined || run.startId === undefined || run.startedAt === undefined || run.killedForBudget) return;
    if (this.deps.now() < run.startedAt + run.budget.minutes * 60_000) return;
    if (existsSync(this.file(run, "exit")) || !this.deps.runner.alive(run.pid, run.startId)) return;
    this.save({ ...run, killedForBudget: true });
    this.deps.log(`run ${run.runId}: budget of ${run.budget.minutes} min used up; stopping it`);
    void this.deps.runner.kill(run.pid, run.startId).catch((e) => this.deps.log(`run ${run.runId}: kill failed: ${String(e)}`));
  }

  private exitCode(run: RunFile): number | undefined {
    const t = this.read(run, "exit").trim();
    return /^-?\d+$/.test(t) ? Number(t) : undefined;
  }

  private async detectEnd(run: RunFile): Promise<void> {
    if (run.pid === undefined || run.startId === undefined) return;
    if (!existsSync(this.file(run, "exit"))) {
      if (this.deps.runner.alive(run.pid, run.startId)) return;
      // The process is gone; its waiter writes the exit file a moment later.
      for (let i = 0; i < 10 && !existsSync(this.file(run, "exit")); i++) await new Promise((r) => setTimeout(r, 50));
    }
    this.markEnded(run);
    // What the run left behind in its process group (a background process of a tool call) is stopped.
    // Only for an end this daemon saw; a run reaped after a restart is never signalled.
    const pid = run.pid;
    if (this.deps.runner.reapGroup) void this.deps.runner.reapGroup(pid, run.runId).catch((e) => this.deps.log(`run ${run.runId}: group cleanup failed: ${String(e)}`));
  }

  private markEnded(run: RunFile): void {
    const exitCode = this.exitCode(run);
    this.save({ ...run, endedAt: run.endedAt ?? this.deps.now(), ...(exitCode !== undefined ? { exitCode } : {}) });
  }

  private telemetry(run: RunFile): { telemetry: RunTelemetry; exit: RunExit } {
    const t = telemetryFromStream(this.read(run, "stream.jsonl"), {
      durationMs: run.startedAt !== undefined && run.endedAt !== undefined ? Math.max(0, run.endedAt - run.startedAt) : 0,
      exitCode: run.exitCode,
      killedForBudget: run.killedForBudget === true,
    });
    let redactions = 0;
    for (const line of this.read(run, "artifacts.jsonl").split("\n")) {
      try {
        const v = JSON.parse(line) as { redactions?: unknown };
        if (typeof v.redactions === "number") redactions += v.redactions;
      } catch {
        // blank line
      }
    }
    let undeclaredRules = 0;
    for (const line of this.read(run, "reviews.jsonl").split("\n")) {
      try {
        const v = JSON.parse(line) as { undeclaredRules?: unknown };
        if (typeof v.undeclaredRules === "number") undeclaredRules += v.undeclaredRules;
      } catch {
        // blank line
      }
    }
    const telemetry: RunTelemetry = {
      ...t,
      runId: run.runId,
      profile: run.profile.name,
      profileHash: run.profile.sha256,
      ...(run.agent ? { agentKey: run.agent.key, agentHash: run.agent.hash } : {}),
      undeclaredRules,
      redactions,
    };
    return { telemetry, exit: t.exit };
  }

  /** End of a run, steps 2–4 (each resumable); waits while the hub is away or a call of the step is queued. */
  private async finish(run: RunFile): Promise<void> {
    const link = this.deps.link();
    const prefix = this.stepPath(run.step, "/");
    if (!link || link.offline || this.deps.pendingCallPaths().some((p) => p.startsWith(prefix))) return;
    const { telemetry, exit } = this.telemetry(run);
    let e = this.end(run);
    const meta = this.meta(run);
    const sids = this.runSids(run);

    if (!e.decided) {
      const got = await this.call<StepView>(run, "step", "GET", this.stepPath(run.step));
      if (!got.ok && got.retry) return;
      if (!got.ok) e = { ...e, decided: "none" };
      else {
        const st = got.value.context.step;
        const held = (st.state === "claimed" || st.state === "paused") && st.holderMachine === this.deps.machineId() && (!st.holderSid || sids.has(st.holderSid));
        if (held) e = { ...e, decided: "closed" };
        else {
          const own = [...(st.rounds ?? [])].reverse().find((r) => r.sid !== undefined && sids.has(r.sid));
          e = own ? { ...e, decided: "own-round", round: own.n } : { ...e, decided: "none" };
        }
      }
      this.saveEnd(run, e);
    }

    if (e.decided === "closed") {
      if (!e.transcriptDone) {
        const r = redactSecrets(renderTail(this.read(run, "stream.jsonl"), this.read(run, "stderr.log"), exit), this.deps.secrets());
        const up = await this.call<StoredArtifact>(run, "transcript", "POST", this.stepPath(run.step, "/artifacts"), {
          kind: "transcript",
          mediaType: "text/plain",
          title: `run transcript (${exit})`,
          content: r.text,
          redactions: r.count,
        });
        if (!up.ok && up.retry) return;
        e = { ...e, transcriptDone: true };
        this.saveEnd(run, e);
      }
      if (!e.doneDone) {
        const summary = meta.notStarted ? `headless run of ${run.step} did not start: ${meta.notStarted}` : `headless run ended without mesh_done (exit ${exit})`;
        const sid = [...sids].find((x) => x !== run.sessionId && this.deps.sessions().some((s) => s.sid === x));
        const done = await this.call<DoneResult>(run, "done", "POST", this.stepPath(run.step, "/done"), { outcome: "fail", summary, reopen: [], ...(sid ? { sid } : {}) });
        if (!done.ok && done.retry) return;
        const n = done.ok ? done.value.step.rounds?.at(-1)?.n : undefined;
        // A refused done (the step was released or taken meanwhile) closed nothing: no round, no push.
        e = done.ok && n !== undefined ? { ...e, doneDone: true, round: n } : { ...e, doneDone: true, decided: "none" };
        this.saveEnd(run, e);
      }
    }

    if ((e.decided === "closed" || e.decided === "own-round") && !e.pushDone) {
      const branch = await this.push(run);
      if (branch === "retry") return;
      e = { ...e, pushDone: true, ...(branch ? { branch } : {}) };
      this.saveEnd(run, e);
    }

    if (!e.finishedDone) {
      const body = { state: "finished", runId: run.runId, ...(e.round !== undefined ? { round: e.round } : {}), telemetry, ...(e.branch ? { branch: e.branch } : {}) };
      const r = await this.call(run, "finished", "POST", this.stepPath(run.step, "/run"), body);
      if (!r.ok && r.retry) return;
      e = { ...e, finishedDone: true };
      this.saveEnd(run, e);
    }

    if (run.worktree && existsSync(run.worktree)) {
      const rm = await this.deps.runner.git(run.checkout, ["worktree", "remove", "--force", run.worktree]);
      if (rm.code !== 0) this.deps.log(`run ${run.runId}: could not remove its worktree: ${firstLine(rm.stderr)}`);
    }
    const final = this.runs.get(run.runId) ?? run;
    this.save({ ...final, state: "finished", exit });
    this.deps.log(`run ${run.runId}: finished (${exit})`);
  }

  /** `propose-via-branch` only: push the worktree's commits to mesh/<slug>. Returns the branch, or undefined. */
  private async push(run: RunFile): Promise<string | undefined | "retry"> {
    if (run.profile.base !== "propose-via-branch" || !run.worktree || !run.baseCommit || !existsSync(run.worktree)) return undefined;
    const head = await this.deps.runner.git(run.worktree, ["rev-parse", "HEAD"]);
    if (head.code !== 0 || head.stdout.trim() === run.baseCommit) return undefined;
    const branch = `mesh/${stepSlug(run.step)}`;
    const p = await this.deps.runner.git(run.worktree, ["push", "origin", `HEAD:refs/heads/${branch}`]);
    if (p.code === 0) return branch;
    const note = await this.call(run, "note", "POST", this.stepPath(run.step, "/note"), { text: `headless run: could not push ${branch}: ${firstLine(p.stderr)}` });
    if (!note.ok && note.retry) return "retry";
    return undefined;
  }
}
