import type { Goal } from "../../src/protocol/goal.ts";
import type { GoalDetail, LiveView, ProviderInfo, StepView, TimelineEntry } from "../../src/protocol/hub.ts";

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

const g = (id: string) => `/v1/goals/${encodeURIComponent(id)}`;

export const api = {
  live: () => call<LiveView>("GET", "/v1/live"),
  providers: async () => (await call<{ providers: ProviderInfo[] }>("GET", "/auth/providers")).providers,
  loginToken: (provider: string, token: string) => call<{ user: { id: string } }>("POST", `/auth/${encodeURIComponent(provider)}/login`, { token, client: "web" }),
  loginNone: (provider: string) => call<{ user: { id: string } }>("POST", `/auth/${encodeURIComponent(provider)}/login`, { client: "web" }),
  logout: () => call("POST", "/auth/logout"),
  goals: async () => (await call<{ goals: Goal[] }>("GET", "/v1/goals")).goals,
  goal: (id: string) => call<GoalDetail>("GET", g(id)),
  timeline: async (id: string) => (await call<{ timeline: TimelineEntry[] }>("GET", `${g(id)}/timeline`)).timeline,
  step: (id: string) => call<StepView>("GET", `/v1/steps/${encodeURIComponent(id)}`),
  approve: (id: string, comment?: string) => call<GoalDetail>("POST", `${g(id)}/approve`, comment ? { comment } : {}),
  revise: (id: string, comment: string) => call<GoalDetail>("POST", `${g(id)}/revise`, { comment }),
  replan: (id: string, comment?: string) => call<GoalDetail>("POST", `${g(id)}/replan`, comment ? { comment } : {}),
  newGoal: (title: string, primaryRepo?: string) => call<Goal>("POST", "/v1/goals", { title, ...(primaryRepo ? { primaryRepo } : {}) }),
};
