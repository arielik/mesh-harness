// The daemon's connection to the hub (plan §5.3, §5.4): spooled observations (sync), the message
// inbox (pull + ack, woken by SSE hints) and online RPCs with idempotency keys.

import { existsSync, readFileSync, statSync } from "node:fs";
import { Credentials, IDEMPOTENCY_HEADER, type InboxMessage, type Session, type SyncEvent } from "../protocol/index.ts";
import type { DaemonStore } from "../store/index.ts";

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
  onMessage(m: InboxMessage): "queued" | "unknown";
  log(line: string): void;
  now(): number;
  fetch?: typeof fetch;
}

export type LinkStatus = "not-logged-in" | "ok" | "offline" | "auth-failed";

export class HubLink {
  status: LinkStatus = "not-logged-in";
  lastError: string | undefined;
  private deps: HubLinkDeps;
  private creds: Credentials | undefined;
  private credsMtime = 0;
  private streamAbort: AbortController | undefined;
  private streaming = false;
  private stopped = false;
  private flushing = false;

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
      if (this.creds) this.deps.log("logged out of the hub");
      this.creds = undefined;
      this.credsMtime = 0;
      this.status = "not-logged-in";
      return undefined;
    }
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

  enqueue(e: Omit<SyncEvent, "payload"> & { payload?: Record<string, unknown> }): void {
    if (!this.credentials()) return;
    this.deps.store.outboxAdd(e.id, e.at, { ...e, payload: e.payload ?? {} });
  }

  async rpc<T>(method: "GET" | "POST", path: string, body?: unknown, idemKey?: string): Promise<T> {
    const c = this.credentials();
    if (!c) throw new HubRpcError(401, "not logged in to a hub; run: mesh login");
    let res: Response;
    try {
      res = await this.fetch(c.hub + path, {
        method,
        headers: { authorization: `Bearer ${c.token}`, "content-type": "application/json", ...(idemKey ? { [IDEMPOTENCY_HEADER]: idemKey } : {}) },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
        signal: AbortSignal.timeout(15_000),
      });
    } catch (e) {
      this.status = "offline";
      this.lastError = String(e);
      throw new HubRpcError(503, `the hub ${c.hub} is unreachable; try again later`);
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

  /** Send spooled observations and session snapshots. Safe to call often. */
  async flush(): Promise<void> {
    if (this.flushing || !this.credentials() || this.status === "auth-failed") return;
    this.flushing = true;
    try {
      const all = this.deps.sessions();
      const counts: Record<string, number> = {};
      for (const s of all) if (s.state !== "ended") counts[s.state] = (counts[s.state] ?? 0) + 1;
      for (;;) {
        const batch = this.deps.store.outboxPeek(200);
        const sessions = all.filter((s) => s.step !== undefined);
        await this.rpc("POST", "/v1/sync", { events: batch.map((b) => b.value), sessions, counts });
        this.deps.store.outboxRemove(batch.map((b) => b.id));
        if (batch.length < 200) break;
      }
    } catch (e) {
      if (!(e instanceof HubRpcError)) this.deps.log(`sync error: ${String(e)}`);
    } finally {
      this.flushing = false;
    }
  }

  async pullInbox(): Promise<void> {
    if (!this.credentials() || this.status === "auth-failed") return;
    try {
      const { messages } = await this.rpc<{ messages: InboxMessage[] }>("GET", "/v1/inbox");
      for (const m of messages) {
        if (this.deps.store.hasHubMessage(m.id)) continue;
        if (this.deps.onMessage(m) === "unknown") await this.ack(m.id, "failed", "unknown session");
      }
    } catch {
      // offline: the next pull retries
    }
  }

  async ack(hubId: number, state: "delivered" | "failed", method: string | undefined): Promise<void> {
    try {
      await this.rpc("POST", `/v1/inbox/${hubId}/ack`, { state, method });
    } catch {
      // the message stays pending on the hub; a later pull finds it already known locally
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
        if (!c || this.status === "auth-failed") {
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
