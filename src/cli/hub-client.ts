import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { Credentials, IDEMPOTENCY_HEADER, writeFileAtomic, type MeshPaths } from "../protocol/index.ts";

export class HubCallError extends Error {
  status: number;
  details?: unknown;
  constructor(status: number, message: string, details?: unknown) {
    super(message);
    this.status = status;
    this.details = details;
  }
}

export function loadCredentials(p: MeshPaths): Credentials | undefined {
  if (!existsSync(p.credentials)) return undefined;
  const parsed = Credentials.safeParse(JSON.parse(readFileSync(p.credentials, "utf8")));
  return parsed.success ? parsed.data : undefined;
}

/** Team credentials, else the Solo hub's (written by `mesh up` when no team hub is configured). */
export function loadCredentialsOrSolo(p: MeshPaths): (Credentials & { solo?: boolean }) | undefined {
  const team = loadCredentials(p);
  if (team) return team;
  if (!existsSync(p.soloCredentials)) return undefined;
  const parsed = Credentials.safeParse(JSON.parse(readFileSync(p.soloCredentials, "utf8")));
  return parsed.success ? { ...parsed.data, solo: true } : undefined;
}

export function saveCredentials(p: MeshPaths, c: Credentials): void {
  mkdirSync(p.configDir, { recursive: true, mode: 0o700 });
  writeFileAtomic(p.credentials, `${JSON.stringify(c, null, 2)}\n`, { mode: 0o600 });
}

export function clearCredentials(p: MeshPaths): void {
  if (existsSync(p.credentials)) rmSync(p.credentials);
}

/** Unauthenticated or authenticated JSON calls to a hub. */
export async function hubFetch<T>(base: string, method: "GET" | "POST", path: string, opts: { token?: string | undefined; body?: unknown; idempotent?: boolean } = {}): Promise<{ status: number; json: T }> {
  let res: Response;
  try {
    res = await fetch(base.replace(/\/+$/, "") + path, {
      method,
      redirect: "manual",
      headers: {
        "content-type": "application/json",
        ...(opts.token ? { authorization: `Bearer ${opts.token}` } : {}),
        ...(opts.idempotent ? { [IDEMPOTENCY_HEADER]: randomUUID() } : {}),
      },
      ...(opts.body !== undefined ? { body: JSON.stringify(opts.body) } : {}),
      signal: AbortSignal.timeout(20_000),
    });
  } catch {
    throw new HubCallError(503, `cannot reach the hub at ${base}`);
  }
  const json = (await res.json().catch(() => ({}))) as T & { error?: string; details?: unknown };
  if (res.status >= 400) {
    const details = Array.isArray(json.details) ? `\n  - ${(json.details as string[]).join("\n  - ")}` : "";
    throw new HubCallError(res.status, `${json.error ?? `hub returned ${res.status}`}${details}`, json.details);
  }
  return { status: res.status, json };
}

export class HubClient {
  readonly creds: Credentials;

  constructor(creds: Credentials) {
    this.creds = creds;
  }

  static from(p: MeshPaths): HubClient {
    const c = loadCredentialsOrSolo(p);
    if (!c) throw new Error("not logged in to a hub, and no Solo hub is running. Run `mesh up` (Solo) or `mesh login --hub <url>`.");
    return new HubClient(c);
  }

  async get<T>(path: string): Promise<T> {
    return (await hubFetch<T>(this.creds.hub, "GET", path, { token: this.creds.token })).json;
  }

  async post<T>(path: string, body: unknown = {}): Promise<T> {
    return (await hubFetch<T>(this.creds.hub, "POST", path, { token: this.creds.token, body, idempotent: true })).json;
  }
}
