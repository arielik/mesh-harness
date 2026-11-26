import type { AddressInfo } from "node:net";
import { serve, type ServerType } from "@hono/node-server";
import { HubStore } from "../store/index.ts";
import { createApp } from "./app.ts";
import { ChannelHintBus, LocalHintBus, type HintBus } from "./bus.ts";
import type { HubConfig } from "./config.ts";
import { HubService } from "./service.ts";

/** The Postgres NOTIFY channel that carries SSE hints between replicas. */
export const HINT_CHANNEL = "mesh_hint";

export interface RunningHub {
  url: string;
  port: number;
  svc: HubService;
  /**
   * One tick if this replica leads (on SQLite it always does); false when another replica leads.
   * The interval timer calls this; tests with `tickMs: 0` call it themselves.
   */
  runTick(): Promise<boolean>;
  /** RL-24: re-read the fleet pause for `/healthz` (the `pauseRefreshMs` timer calls this). */
  refreshPause(): Promise<void>;
  stop(): Promise<void>;
}

export async function startHub(config: HubConfig, opts: { webRoot?: string | undefined; store?: HubStore; tickMs?: number; pauseRefreshMs?: number; now?: () => number } = {}): Promise<RunningHub> {
  const store = opts.store ?? (await HubStore.open(config.db));
  // Several replicas share hints over the database; one hub alone fans out in process.
  const channel = store.channel(HINT_CHANNEL);
  let bus: HintBus;
  if (channel) {
    const b = new ChannelHintBus(channel);
    try {
      await b.start();
    } catch (e) {
      if (!opts.store) await store.close();
      throw e;
    }
    bus = b;
  } else {
    bus = new LocalHintBus();
  }
  const svc = new HubService(store, config, opts.now, { bus });
  try {
    // RL-24: /healthz answers the fleet pause from the first request on.
    await svc.refreshPause();
  } catch (e) {
    await bus.close().catch(() => undefined);
    if (!opts.store) await store.close().catch(() => undefined);
    throw e;
  }
  const leader = store.leader("tick");
  const { app } = createApp(svc, { webRoot: opts.webRoot });
  let server: ServerType;
  try {
    server = await new Promise((resolve, reject) => {
      const s = serve({ fetch: app.fetch, hostname: config.host, port: config.port }, () => resolve(s));
      s.once("error", reject);
    });
  } catch (e) {
    // The port is taken, say: free the LISTEN connection and the store, or they keep the process up.
    await bus.close().catch(() => undefined);
    if (!opts.store) await store.close().catch(() => undefined);
    throw e;
  }
  const port = (server.address() as AddressInfo).port;
  if (config.port === 0) {
    // Ephemeral port (tests): redirect URLs must use the real one.
    config.url = config.url.replace(/:0(?=$|\/)/, `:${port}`);
  }
  // One tick at a time, and only on the replica holding the tick lock. Every other replica asks
  // again each interval, so when the leader dies another one takes over within an interval.
  let ticking: Promise<boolean> | undefined;
  const runTick = (): Promise<boolean> => {
    ticking ??= (async () => {
      if (!(await leader.acquire())) return false;
      await svc.tick();
      return true;
    })().finally(() => {
      ticking = undefined;
    });
    return ticking;
  };
  const tickMs = opts.tickMs ?? 30_000;
  const timer =
    tickMs > 0
      ? setInterval(() => {
          if (ticking) return;
          runTick().catch((e: unknown) => {
            process.stderr.write(`hub tick failed: ${String(e)}\n`);
          });
        }, tickMs)
      : undefined;
  // RL-24: every replica re-reads the fleet pause, so a change served elsewhere shows within the period.
  let refreshFailing = false;
  const refreshPause = async (): Promise<void> => {
    try {
      await svc.refreshPause();
      refreshFailing = false;
    } catch (e) {
      if (!refreshFailing) process.stderr.write(`hub: reading the fleet pause failed (the last value is kept): ${String(e)}\n`);
      refreshFailing = true;
    }
  };
  const pauseRefreshMs = opts.pauseRefreshMs ?? 5_000;
  const pauseTimer = pauseRefreshMs > 0 ? setInterval(() => void refreshPause(), pauseRefreshMs) : undefined;
  return {
    url: config.url,
    port,
    svc,
    runTick,
    refreshPause,
    async stop() {
      svc.draining = true;
      if (timer) clearInterval(timer);
      if (pauseTimer) clearInterval(pauseTimer);
      await ticking?.catch(() => undefined);
      await leader.release();
      const s = server as unknown as { closeAllConnections?: () => void; close(cb: () => void): void };
      s.closeAllConnections?.();
      await new Promise<void>((ok) => s.close(() => ok()));
      await bus.close();
      if (!opts.store) await store.close();
    },
  };
}
