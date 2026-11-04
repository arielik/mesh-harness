import type { LiveView, ProviderInfo } from "../../src/protocol/hub.ts";

export class ApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(path, {
    method,
    credentials: "same-origin",
    headers: { "content-type": "application/json" },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const json = (await res.json().catch(() => ({}))) as T & { error?: string };
  if (!res.ok) throw new ApiError(res.status, json.error ?? `HTTP ${res.status}`);
  return json;
}

export const api = {
  live: () => call<LiveView>("GET", "/v1/live"),
  providers: async () => (await call<{ providers: ProviderInfo[] }>("GET", "/auth/providers")).providers,
  loginToken: (provider: string, token: string) => call<{ user: { id: string } }>("POST", `/auth/${encodeURIComponent(provider)}/login`, { token, client: "web" }),
  loginNone: (provider: string) => call<{ user: { id: string } }>("POST", `/auth/${encodeURIComponent(provider)}/login`, { client: "web" }),
  logout: () => call("POST", "/auth/logout"),
  approve: (goal: string) => call("POST", `/v1/goals/${encodeURIComponent(goal)}/approve`, {}),
};
