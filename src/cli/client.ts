import { KEY_HEADER, SayResponse, Session, SessionsResponse, type DaemonConfig } from "../protocol/index.ts";

export class DaemonUnreachable extends Error {
  constructor(port: number) {
    super(`the mesh daemon is not running on 127.0.0.1:${port}. Start it with: mesh up`);
  }
}

/** HTTP client for the local daemon API (plan §6.1). */
export class DaemonClient {
  private base: string;
  private key: string;
  private port: number;

  constructor(config: Pick<DaemonConfig, "port" | "key">) {
    this.port = config.port;
    this.base = `http://127.0.0.1:${config.port}`;
    this.key = config.key;
  }

  private async call(method: string, path: string, body?: unknown): Promise<unknown> {
    let res: Response;
    try {
      res = await fetch(this.base + path, {
        method,
        headers: { [KEY_HEADER]: this.key, "content-type": "application/json" },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
        signal: AbortSignal.timeout(5_000),
      });
    } catch {
      throw new DaemonUnreachable(this.port);
    }
    const json = (await res.json().catch(() => ({}))) as { error?: string };
    if (!res.ok) throw new Error(json.error ?? `daemon returned ${res.status}`);
    return json;
  }

  async health(): Promise<{ ok: boolean; sessions: number }> {
    return (await this.call("GET", "/local/health")) as { ok: boolean; sessions: number };
  }

  async sessions(): Promise<SessionsResponse> {
    return SessionsResponse.parse(await this.call("GET", "/local/sessions"));
  }

  async reconcile(): Promise<SessionsResponse> {
    return SessionsResponse.parse(await this.call("POST", "/local/reconcile"));
  }

  async say(target: string, text: string) {
    return SayResponse.parse(await this.call("POST", "/local/say", { target, text }));
  }

  async autopilot(target: string, level: "off" | "nudge" | "chain"): Promise<Session> {
    return Session.parse(await this.call("POST", "/local/autopilot", { target, level }));
  }

  async next(target: string): Promise<{ step?: string; message: string }> {
    return (await this.call("POST", "/local/next", { target })) as { step?: string; message: string };
  }

  async status(): Promise<{ hub: string; user?: string; outbox: number; error?: string; host: string }> {
    return (await this.call("GET", "/local/status")) as { hub: string; user?: string; outbox: number; error?: string; host: string };
  }
}
