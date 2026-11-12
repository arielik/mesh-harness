import { KEY_HEADER, SayResponse, Session, SessionsResponse, type DaemonConfig, type FleetView, type LaunchRequest, type OfferView, type Step, type DebriefList, type RevertResult } from "../protocol/index.ts";

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

  /** MM-2: set, add or remove a live session's labels (remembered for its checkout too). */
  async labels(target: string, labels: string[], mode: "set" | "add" | "rm"): Promise<{ session: Session; unknown?: string[] }> {
    const r = (await this.call("POST", "/local/labels", { target, labels, mode })) as { session: unknown; unknown?: string[] };
    return { session: Session.parse(r.session), ...(r.unknown ? { unknown: r.unknown } : {}) };
  }

  /** MM-2: remember labels for the checkout of `cwd`; a session recorded there afterwards gets them. */
  async rememberLabels(cwd: string, labels: string[]): Promise<{ cwd: string; labels: string[]; unknown?: string[] }> {
    return (await this.call("POST", "/local/labels", { cwd, labels })) as { cwd: string; labels: string[]; unknown?: string[] };
  }

  async next(target: string): Promise<{ step?: string; message: string }> {
    return (await this.call("POST", "/local/next", { target })) as { step?: string; message: string };
  }

  async goals(): Promise<{ id: string; title: string; state: string; owner: string; done: number; total: number; holders: string[] }[]> {
    return ((await this.call("GET", "/local/goals")) as { goals: { id: string; title: string; state: string; owner: string; done: number; total: number; holders: string[] }[] }).goals;
  }

  /** MM-1: the hub's GET /v1/fleet, through the daemon. */
  async fleet(): Promise<FleetView> {
    return (await this.call("GET", "/local/fleet")) as FleetView;
  }

  /** MM-3: accept an offered step for a session of this machine (`target`, else one the daemon picks). */
  async accept(step: string, target?: string): Promise<{ step: string; sid: string; message: string }> {
    return (await this.call("POST", "/local/accept", { step, ...(target ? { target } : {}) })) as { step: string; sid: string; message: string };
  }

  /** MM-3: open offers to this machine. */
  async offers(): Promise<OfferView[]> {
    return ((await this.call("GET", "/local/offers")) as { offers: OfferView[] }).offers;
  }

  /** RL-4: the caller's debriefs and their revertable debrief decisions (the hub's `GET /v1/debriefs`). */
  async debriefs(): Promise<DebriefList> {
    return (await this.call("GET", "/local/debriefs")) as DebriefList;
  }

  /** RL-4: revert a debrief decision. */
  async revert(step: string, fingerprint: string): Promise<RevertResult> {
    return (await this.call("POST", "/local/revert", { step, fingerprint })) as RevertResult;
  }

  /** MM-3: decline an offer. */
  async decline(step: string, note?: string): Promise<{ step: Step }> {
    return (await this.call("POST", "/local/decline", { step, ...(note ? { note } : {}) })) as { step: Step };
  }

  /** MM-3: set a session's accept override, or with null clear it. */
  async sessionAccept(target: string, accept: string[] | null): Promise<Session> {
    return Session.parse(((await this.call("POST", "/local/session-accept", { target, accept })) as { session: unknown }).session);
  }

  /** Tell the daemon about a window `mesh run` opened for Claude. */
  async launch(l: LaunchRequest): Promise<{ session: Session | null }> {
    return (await this.call("POST", "/local/launch", l)) as { session: Session | null };
  }

  async status(): Promise<DaemonStatus> {
    return (await this.call("GET", "/local/status")) as DaemonStatus;
  }
}

export interface DaemonStatus {
  hub: string;
  mode?: "team" | "solo" | "none";
  user?: string;
  outbox: number;
  queued?: number;
  offlineSince?: number;
  hubUrl?: string;
  error?: string;
  host: string;
  /** Open sessions whose hooks come from an older mesh (missing from older daemons). */
  oldHooks?: number;
  /** Live OpenCode sessions reported by an older mesh plugin. */
  oldPlugin?: number;
}
