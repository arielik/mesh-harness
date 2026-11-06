// Fan-out for the SSE hint channel (plan §5.4). Losing a hint loses nothing: daemons pull their
// inbox and dashboards refetch. With several hub replicas (M4.6) a hint published on one replica
// must reach SSE subscribers on all of them, so the bus is an interface:
// - `LocalHintBus`: in process (one hub, SQLite or a single Postgres replica);
// - `ChannelHintBus`: also over a store `Channel` (Postgres LISTEN/NOTIFY) to the other replicas.

import { randomUUID } from "node:crypto";
import type { Channel } from "../store/index.ts";

/**
 * `resync` is local only: the cross-replica listener reconnected and hints may have been lost, so
 * each subscriber should refetch as if it had been told about everything.
 */
export type Hint = { type: "wake"; machine: string } | { type: "changed"; seq: number } | { type: "resync" };

export interface HintBus {
  subscribe(fn: (h: Hint) => void): () => void;
  /** Deliver to subscribers on every replica. Call after commit. */
  publish(h: Hint): void;
  close(): Promise<void>;
}

export class LocalHintBus implements HintBus {
  private subs = new Set<(h: Hint) => void>();

  subscribe(fn: (h: Hint) => void): () => void {
    this.subs.add(fn);
    return () => this.subs.delete(fn);
  }

  publish(h: Hint): void {
    for (const fn of this.subs) {
      try {
        fn(h);
      } catch {
        // a broken subscriber must not affect others
      }
    }
  }

  close(): Promise<void> {
    this.subs.clear();
    return Promise.resolve();
  }
}

/** A hint as it travels between replicas: the sender's id, so a replica skips its own echo. */
interface Envelope {
  o: string;
  h: Hint;
}

function isHint(h: unknown): h is Hint {
  if (!h || typeof h !== "object") return false;
  const x = h as Record<string, unknown>;
  return (x.type === "wake" && typeof x.machine === "string") || (x.type === "changed" && typeof x.seq === "number");
}

/**
 * Local fan-out first (this replica's subscribers never wait on the database), then NOTIFY so the
 * other replicas fan out to theirs. Each replica listens on a dedicated connection; after a
 * reconnect it tells its subscribers to `resync`.
 */
export class ChannelHintBus implements HintBus {
  private readonly local = new LocalHintBus();
  private readonly origin = randomUUID();
  private readonly channel: Channel;
  private readonly onError: (e: unknown) => void;

  constructor(channel: Channel, onError: (e: unknown) => void = (e) => process.stderr.write(`hub hint not sent to other replicas: ${String(e)}\n`)) {
    this.channel = channel;
    this.onError = onError;
  }

  /** Start listening for other replicas' hints. */
  start(): Promise<void> {
    return this.channel.listen({ message: (p) => this.receive(p), resync: () => this.local.publish({ type: "resync" }) });
  }

  subscribe(fn: (h: Hint) => void): () => void {
    return this.local.subscribe(fn);
  }

  publish(h: Hint): void {
    this.local.publish(h);
    if (h.type === "resync") return;
    const env: Envelope = { o: this.origin, h };
    this.channel.publish(JSON.stringify(env)).catch(this.onError);
  }

  private receive(payload: string): void {
    let env: Partial<Envelope>;
    try {
      env = JSON.parse(payload) as Partial<Envelope>;
    } catch {
      return;
    }
    if (env.o === this.origin || !isHint(env.h)) return;
    this.local.publish(env.h);
  }

  async close(): Promise<void> {
    await this.channel.close();
    await this.local.close();
  }
}
