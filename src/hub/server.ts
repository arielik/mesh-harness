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
  stop(): Promise<void>;
}

export async function startHub(config: HubConfig, opts: { webRoot?: string | undefined; store?: HubStore; tickMs?: number; now?: () => number } = {}): Promise<RunningHub> {
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
  const leader = store.leader("tick");
  const { app } = createApp(svc, { webRoot: opts.webRoot });
  const server: ServerType = await new Promise((resolve, reject) => {
    const s = serve({ fetch: app.fetch, hostname: config.host, port: config.port }, () => resolve(s));
    s.once("error", reject);
  });
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
  return {
    url: config.url,
    port,
    svc,
    runTick,
    async stop() {
      if (timer) clearInterval(timer);
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
