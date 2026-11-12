// The daemon's connection to the hub (plan §5.3, §5.4): spooled observations (sync), the message
// inbox (pull + ack, woken by SSE hints) and online RPCs with idempotency keys.
//
// Local-first (M4): after one failed call the link is offline and calls fail at once; a background
// probe re-opens it, then the outbox and the calls queued while offline are sent, once (ids and
// idempotency keys make replays harmless). With no team hub configured the daemon's own local hub
// is used (Solo).

import { existsSync, readFileSync, statSync } from "node:fs";
import { Credentials, IDEMPOTENCY_HEADER, type InboxMessage, type Repo, type Session, type ShareLevel, type SyncEvent, type SyncResponse } from "../protocol/index.ts";
import type { DaemonStore, PendingCall } from "../store/index.ts";

export class HubRpcError extends Error {
  status: number;
  details?: unknown;
  constructor(status: number, message: string, details?: unknown) {
    super(message);
    this.status = status;
    this.details = details;
  }
}

export interface HubLinkDeps {
  credentialsPath: string;
  store: DaemonStore;
  /** Sessions to report: full records for step holders, counts for all. */
  sessions(): Session[];
  /**
   * The configured share level (Q5, MM-1; default `steps`). `me` and `all` also report sessions
   * that hold no step, as metadata only; `me` only once the hub has confirmed it applies the rule.
   */
  share?: () => ShareLevel;
  /** The machine's repo inventory (ids and names only), sent on the first sync and on change. */
  machineRepos?: () => Repo[];
  /** MM-3: the machine's accept policy, sent on every sync (default `["self"]`). */
  accept?: () => string[];
  /** RL-1: the daemon can run headless steps (sent as `machine.headless: true` only when true). */
  headless?: () => boolean;
  /**
   * A message from the hub inbox. `unknown`: acked as failed; `handling`: the daemon handles it
   * itself and acks it when done (MM-3 machine-wide offers).
   */
  onMessage(m: InboxMessage): "queued" | "unknown" | "handling";
  /** The ids of every message a pull listed (after `onMessage` saw them), so handled ones can be forgotten. */
  onPulled?(ids: readonly number[]): void;
  /**
   * MM-3: true while a machine-wide offer waits for a retry (its hub call or ack got no answer).
   * Only then does a pull check an offline hub at once instead of waiting for the probe backoff.
   */
  retryDue?: () => boolean;
  log(line: string): void;
  now(): number;
  fetch?: typeof fetch;
  /** Credentials of the daemon's local hub, used when no team hub is configured (Solo). */
  solo?: () => Credentials | undefined;
  /** A call queued while offline was sent (or refused) once the hub came back. */
  onReplayed?(call: PendingCall, result: unknown): void;
  onRejected?(call: PendingCall, error: HubRpcError): void;
  /** Call timeout; a blackholed hub costs at most this once, then the link is offline. */
  timeoutMs?: number;
}

/** Most session records one sync may carry (SyncRequest allows 200). */
const SYNC_SESSIONS_MAX = 200;

/**
 * The session records a sync sends (Q5, MM-1): full records of sessions holding a step and, under
 * `me` or `all`, metadata-only records of the rest, newest first. Step holders come first so the
 * cap never drops them.
 */
export function syncedSessions(all: readonly Session[], share: ShareLevel): Session[] {
  const steps = all.filter((s) => s.step !== undefined);
  if (share === "steps") return steps.slice(0, SYNC_SESSIONS_MAX);
  const rest = all
    .filter((s) => s.step === undefined)
    .sort((a, b) => b.lastEventAt - a.lastEventAt)
    .map(sessionMetadata);
  return [...steps, ...rest].slice(0, SYNC_SESSIONS_MAX);
}

/** A session without a step as the hub may see it: no paths, panes, process, transcript or text. */
export function sessionMetadata(s: Session): Session {
  return {
    sid: s.sid,
    ...(s.agent ? { agent: s.agent } : {}),
    claudeSessionIds: [],
    cwd: "",
    ...(s.repo ? { repo: s.repo } : {}),
    kind: s.kind,
    ...(s.name !== undefined ? { name: s.name } : {}),
    ...(s.labels?.length ? { labels: s.labels } : {}),
    ...(s.accept ? { accept: s.accept } : {}),
    state: s.state,
    ...(s.needs ? { needs: s.needs } : {}),
    quiet: s.quiet,
    startedAt: s.startedAt,
    lastEventAt: s.lastEventAt,
    ...(s.lastTurnStartAt !== undefined ? { lastTurnStartAt: s.lastTurnStartAt } : {}),
    ...(s.lastStopAt !== undefined ? { lastStopAt: s.lastStopAt } : {}),
    turns: s.turns,
    humanPrompts: s.humanPrompts,
    seenByReconciler: s.seenByReconciler,
    ...(s.autopilot ? { autopilot: s.autopilot } : {}),
    ...(s.endedAt !== undefined ? { endedAt: s.endedAt } : {}),
  };
}

export type LinkStatus = "not-logged-in" | "ok" | "offline" | "auth-failed";
export type LinkMode = "team" | "solo" | "none";

const PROBE_MIN_MS = 5_000;
const PROBE_MAX_MS = 60_000;

export class HubLink {
  status: LinkStatus = "not-logged-in";
  lastError: string | undefined;
  private deps: HubLinkDeps;
  private creds: Credentials | undefined;
  private credsMtime = 0;
  private streamAbort: AbortController | undefined;
  private streaming = false;
  private stopped = false;
  private current: Promise<void> | undefined;
  private again: Promise<void> | undefined;
  mode: LinkMode = "none";
  offlineSince: number | undefined;
  private nextProbeAt = 0;
  private probeNowWanted = false;
  // MM-1, per credentials (hub URL + machine id): whether the hub confirmed the share level, the
  // inventory it last accepted, and whether the "does not support me" line was logged.
  private factsKey: string | undefined;
  private confirmed = false;
  private sentRepos: string | undefined;
  private warnedUnconfirmed = false;
  private probeBackoff = PROBE_MIN_MS;

  constructor(deps: HubLinkDeps) {
    this.deps = deps;
  }

  private get fetch(): typeof fetch {
    return this.deps.fetch ?? fetch;
  }

  /** Re-read credentials.json when it changes (mesh login / logout). */
  credentials(): Credentials | undefined {
    const p = this.deps.credentialsPath;
    if (!existsSync(p)) {
      if (this.creds && this.mode === "team") this.deps.log("logged out of the hub");
      const solo = this.deps.solo?.();
      if (solo) {
        if (this.mode !== "solo") {
          this.deps.log(`solo: using the local hub ${solo.hub}`);
          this.streamAbort?.abort();
          this.status = "ok";
          this.offlineSince = undefined;
        }
        this.mode = "solo";
        this.creds = solo;
        this.credsMtime = 0;
        return solo;
      }
      this.mode = "none";
      this.creds = undefined;
      this.credsMtime = 0;
      this.status = "not-logged-in";
      return undefined;
    }
    if (this.mode !== "team") this.credsMtime = 0;
    this.mode = "team";
    const m = statSync(p).mtimeMs;
    if (m !== this.credsMtime) {
      this.credsMtime = m;
      const parsed = Credentials.safeParse(JSON.parse(readFileSync(p, "utf8")));
      this.creds = parsed.success ? parsed.data : undefined;
      this.status = this.creds ? "ok" : "not-logged-in";
      if (this.creds) this.deps.log(`hub ${this.creds.hub} as ${this.creds.user.id}`);
      this.streamAbort?.abort();
    }
    return this.creds;
  }

  get user(): string | undefined {
    return this.creds?.user.id;
  }

  /** True while the hub is unreachable (calls fail at once until the probe gets through). */
  get offline(): boolean {
    return this.status === "offline";
  }

  enqueue(e: Omit<SyncEvent, "payload"> & { payload?: Record<string, unknown> }): void {
    const value = { ...e, payload: e.payload ?? {} };
    // Every event is kept locally too: offline step records are computed from it.
    if (e.step) this.deps.store.eventLogAdd({ id: e.id, at: e.at, step: e.step, value });
    if (!this.credentials()) return;
    this.deps.store.outboxAdd(e.id, e.at, value);
  }

  private markOffline(c: Credentials, e: unknown): HubRpcError {
    const now = this.deps.now();
    if (this.status !== "offline") {
      this.offlineSince = now;
      this.probeBackoff = PROBE_MIN_MS;
      this.deps.log(`hub ${c.hub} unreachable: ${String(e)}; working locally`);
    } else this.probeBackoff = Math.min(this.probeBackoff * 2, PROBE_MAX_MS);
    this.status = "offline";
    this.lastError = String(e);
    this.nextProbeAt = now + this.probeBackoff;
    return this.offlineError(c);
  }

  private offlineError(c: Credentials): HubRpcError {
    const since = this.offlineSince ? new Date(this.offlineSince).toISOString().slice(11, 16) : "now";
    return new HubRpcError(503, `the hub ${c.hub} is offline (since ${since} UTC)`, { offline: true });
  }

  /**
   * One call to the hub. While offline it fails at once unless `probe` is set and a probe is due
   * (the background flush probes; tool calls never wait on a dead hub).
   */
  async rpc<T>(method: "GET" | "POST", path: string, body?: unknown, idemKey?: string, opts: { probe?: boolean; force?: boolean } = {}): Promise<T> {
    const c = this.credentials();
    if (!c) throw new HubRpcError(401, "not logged in to a hub; run: mesh login");
    if (this.status === "offline" && !opts.force && !(opts.probe && this.deps.now() >= this.nextProbeAt)) throw this.offlineError(c);
    let res: Response;
    try {
      res = await this.fetch(c.hub + path, {
        method,
        headers: { authorization: `Bearer ${c.token}`, "content-type": "application/json", ...(idemKey ? { [IDEMPOTENCY_HEADER]: idemKey } : {}) },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
        signal: AbortSignal.timeout(this.deps.timeoutMs ?? 10_000),
      });
    } catch (e) {
      throw this.markOffline(c, e);
    }
    if (this.status === "offline") {
      this.deps.log(`hub ${c.hub} reachable again`);
      this.offlineSince = undefined;
    }
    const json = (await res.json().catch(() => ({}))) as { error?: string; details?: unknown };
    if (res.status === 401) {
      this.status = "auth-failed";
      throw new HubRpcError(401, "the hub refused our login (expired?); run: mesh login");
    }
    this.status = "ok";
    if (!res.ok) throw new HubRpcError(res.status, json.error ?? `hub returned ${res.status}`, json.details);
    return json as T;
  }

  /** Is a probe due? (The background loop calls flush; flush probes cheaply first.) */
  private async probe(c: Credentials, force = false): Promise<boolean> {
    if (this.status !== "offline") return true;
    if (!force && this.deps.now() < this.nextProbeAt) return false;
    try {
      const res = await this.fetch(`${c.hub}/health`, { signal: AbortSignal.timeout(Math.min(3_000, this.deps.timeoutMs ?? 3_000)) });
      if (!res.ok) throw new Error(`health ${res.status}`);
      // The hub answers: the calls that follow (sync, replay) may go out now.
      this.nextProbeAt = this.deps.now();
      return true;
    } catch (e) {
      this.markOffline(c, e);
      return false;
    }
  }

  /**
   * Send spooled observations, session snapshots and calls queued while offline. Safe to call often.
   * `probeNow`: while offline, check the hub at once instead of waiting for the probe backoff (a
   * headless run's hub call waits for a retry, RL-1).
   */
  flush(opts: { probeNow?: boolean } = {}): Promise<void> {
    // A flush already running is followed by one more, so `await flush()` means "everything
    // spooled until now was sent, if the hub could be reached".
    if (opts.probeNow) this.probeNowWanted = true;
    if (this.current) {
      this.again ??= this.current.then(() => {
        this.again = undefined;
        return this.flush();
      });
      return this.again;
    }
    const c = this.credentials();
    if (!c || this.status === "auth-failed") return Promise.resolve();
    const probeNow = this.probeNowWanted;
    this.probeNowWanted = false;
    this.current = this.doFlush(c, probeNow).finally(() => {
      this.current = undefined;
    });
    return this.current;
  }

  /** Forget what the hub confirmed and accepted when the credentials name another hub or machine. */
  private factsFor(c: Credentials): void {
    const key = `${c.hub}\n${c.machine ?? ""}`;
    if (key === this.factsKey) return;
    this.factsKey = key;
    this.confirmed = false;
    this.sentRepos = undefined;
    this.warnedUnconfirmed = false;
  }

  private async doFlush(c: Credentials, probeNow = false): Promise<void> {
    try {
      if (!(await this.probe(c, probeNow))) return;
      this.factsFor(c);
      const all = this.deps.sessions();
      const counts: Record<string, number> = {};
      for (const s of all) if (s.state !== "ended") counts[s.state] = (counts[s.state] ?? 0) + 1;
      const share = this.deps.share?.() ?? "steps";
      const repos = this.deps.machineRepos?.() ?? [];
      const reposJson = JSON.stringify(repos);
      for (;;) {
        const batch = this.deps.store.outboxPeek(200);
        // `me` counts as `steps` until this hub has confirmed it applies the visibility rule.
        const effective: ShareLevel = share === "me" && !this.confirmed ? "steps" : share;
        const sendRepos = this.sentRepos !== reposJson;
        const body = { events: batch.map((b) => b.value), sessions: syncedSessions(all, effective), counts, machine: { share, accept: this.deps.accept?.() ?? ["self"], ...(this.deps.headless?.() ? { headless: true } : {}), ...(sendRepos ? { repos } : {}) } };
        const reply = await this.rpc<SyncResponse | undefined>("POST", "/v1/sync", body, undefined, { probe: true });
        if (sendRepos) this.sentRepos = reposJson;
        this.confirmed = reply?.share !== undefined;
        if (share === "me" && !this.confirmed && !this.warnedUnconfirmed) {
          this.warnedUnconfirmed = true;
          this.deps.log("the hub does not support share level me; sending step holders only");
        }
        this.deps.store.outboxRemove(batch.map((b) => b.id));
        if (batch.length < 200) break;
      }
      await this.replay();
    } catch (e) {
      if (!(e instanceof HubRpcError)) this.deps.log(`sync error: ${String(e)}`);
    }
  }

  /** Queue a call made while offline; it is sent once, in order, when the hub is back. */
  queue(call: PendingCall): void {
    this.deps.store.queueCall(call);
  }

  private async replay(): Promise<void> {
    for (const call of this.deps.store.pendingCalls()) {
      try {
        const r = await this.rpc(call.method, call.path, call.body, call.key, { probe: true });
        this.deps.store.removeCall(call.key);
        this.deps.onReplayed?.(call, r);
      } catch (e) {
        if (!(e instanceof HubRpcError) || e.status === 503 || e.status === 401) return;
        // Refused by the hub (e.g. someone else holds the step now): never lost, never retried forever.
        this.deps.store.removeCall(call.key);
        this.deps.log(`queued ${call.label} refused by the hub: ${e.message}`);
        this.deps.onRejected?.(call, e);
      }
    }
  }

  async pullInbox(): Promise<void> {
    const c = this.credentials();
    if (!c || this.status === "auth-failed") return;
    // When offline, a pull waits for the probe backoff like the flush does. Only while an MM-3 offer
    // waits for a retry (its reply was lost) does it check the hub at once (one cheap /health), so
    // that offer is retried on the next pull.
    const wasOffline = this.status === "offline";
    if (wasOffline && !(await this.probe(c, this.deps.retryDue?.() ?? false))) return;
    try {
      const { messages } = await this.rpc<{ messages: InboxMessage[] }>("GET", "/v1/inbox", undefined, undefined, { force: wasOffline });
      for (const m of messages) {
        if (this.deps.store.hasHubMessage(m.id)) continue;
        if (this.deps.onMessage(m) === "unknown") await this.ack(m.id, "failed", "unknown session");
      }
      this.deps.onPulled?.(messages.map((m) => m.id));
    } catch {
      // offline: the next pull retries
    }
  }

  /** Ack an inbox message; false when the hub did not take it (it stays pending there). */
  async ack(hubId: number, state: "delivered" | "failed", method: string | undefined): Promise<boolean> {
    try {
      await this.rpc("POST", `/v1/inbox/${hubId}/ack`, { state, method });
      return true;
    } catch {
      // the message stays pending on the hub; a later pull finds it already known locally
      return false;
    }
  }

  /** Keep an SSE connection open and pull the inbox on every wake hint. */
  startStream(): void {
    if (this.streaming) return;
    this.streaming = true;
    void (async () => {
      let backoff = 2_000;
      while (!this.stopped) {
        const c = this.credentials();
        if (!c || this.status === "auth-failed" || this.status === "offline") {
          await sleep(5_000);
          continue;
        }
        this.streamAbort = new AbortController();
        try {
          const res = await this.fetch(`${c.hub}/v1/stream`, { headers: { authorization: `Bearer ${c.token}` }, signal: this.streamAbort.signal });
          if (res.status === 401) {
            this.status = "auth-failed";
            continue;
          }
          if (!res.ok || !res.body) throw new Error(`stream ${res.status}`);
          backoff = 2_000;
          await this.pullInbox();
          const reader = res.body.getReader();
          let buf = "";
          for (;;) {
            const { value, done } = await reader.read();
            if (done) break;
            buf += new TextDecoder().decode(value);
            let i: number;
            while ((i = buf.indexOf("\n\n")) >= 0) {
              const frame = buf.slice(0, i);
              buf = buf.slice(i + 2);
              if (/^event: wake$/m.test(frame)) await this.pullInbox();
            }
          }
        } catch {
          // reconnect below
        }
        if (this.stopped) break;
        await sleep(backoff);
        backoff = Math.min(backoff * 2, 30_000);
      }
      this.streaming = false;
    })();
  }

  stop(): void {
    this.stopped = true;
    this.streamAbort?.abort();
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms).unref());
