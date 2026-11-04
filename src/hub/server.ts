import type { AddressInfo } from "node:net";
import { serve, type ServerType } from "@hono/node-server";
import { HubStore } from "../store/index.ts";
import { createApp } from "./app.ts";
import type { HubConfig } from "./config.ts";
import { HubService } from "./service.ts";

export interface RunningHub {
  url: string;
  port: number;
  svc: HubService;
  stop(): Promise<void>;
}

export async function startHub(config: HubConfig, opts: { webRoot?: string | undefined; store?: HubStore; tickMs?: number; now?: () => number } = {}): Promise<RunningHub> {
  const store = opts.store ?? (await HubStore.open(config.db));
  const svc = new HubService(store, config, opts.now);
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
  const tickMs = opts.tickMs ?? 30_000;
  const timer = tickMs > 0 ? setInterval(() => svc.tick(), tickMs) : undefined;
  return {
    url: config.url,
    port,
    svc,
    async stop() {
      if (timer) clearInterval(timer);
      const s = server as unknown as { closeAllConnections?: () => void; close(cb: () => void): void };
      s.closeAllConnections?.();
      await new Promise<void>((ok) => s.close(() => ok()));
      if (!opts.store) store.close();
    },
  };
}
