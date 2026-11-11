import type { Goal } from "../../src/protocol/goal.ts";
import type { FleetView, GoalDetail, LiveView, OfferView, ProviderInfo, StepView, TimelineEntry, TopicView } from "../../src/protocol/hub.ts";

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
  fleet: () => call<FleetView>("GET", "/v1/fleet"),
  /** MM-3: open offers to the user's machines; the web declines (accepting needs a session). */
  offers: async () => (await call<{ offers: OfferView[] }>("GET", "/v1/offers")).offers,
  decline: (step: string, note?: string) => call<unknown>("POST", `/v1/steps/${encodeURIComponent(step)}/decline`, note ? { note } : {}),
  providers: async () => (await call<{ providers: ProviderInfo[] }>("GET", "/auth/providers")).providers,
  loginToken: (provider: string, token: string) => call<{ user: { id: string } }>("POST", `/auth/${encodeURIComponent(provider)}/login`, { token, client: "web" }),
  loginNone: (provider: string) => call<{ user: { id: string } }>("POST", `/auth/${encodeURIComponent(provider)}/login`, { client: "web" }),
  logout: () => call("POST", "/auth/logout"),
  goals: async (topics: readonly string[] = []) => (await call<{ goals: Goal[] }>("GET", `/v1/goals${topics.length ? `?topic=${encodeURIComponent(topics.join(","))}` : ""}`)).goals,
  topics: async () => (await call<{ topics: TopicView[] }>("GET", "/v1/topics")).topics,
  newTopic: (name: string, description?: string) => call<TopicView>("POST", "/v1/topics", { name, ...(description ? { description } : {}) }),
  goalTopics: (id: string, change: { add?: string[]; remove?: string[] }) => call<Goal>("POST", `${g(id)}/topics`, change),
  goal: (id: string) => call<GoalDetail>("GET", g(id)),
  timeline: async (id: string) => (await call<{ timeline: TimelineEntry[] }>("GET", `${g(id)}/timeline`)).timeline,
  step: (id: string) => call<StepView>("GET", `/v1/steps/${encodeURIComponent(id)}`),
  approve: (id: string, comment?: string) => call<GoalDetail>("POST", `${g(id)}/approve`, comment ? { comment } : {}),
  revise: (id: string, comment: string) => call<GoalDetail>("POST", `${g(id)}/revise`, { comment }),
  replan: (id: string, comment?: string) => call<GoalDetail>("POST", `${g(id)}/replan`, comment ? { comment } : {}),
  approveStep: (id: string, comment?: string) => call<unknown>("POST", `/v1/steps/${encodeURIComponent(id)}/approve`, comment ? { comment } : {}),
  rejectStep: (id: string, reopen: string[], comment?: string) => call<unknown>("POST", `/v1/steps/${encodeURIComponent(id)}/reject`, { reopen, ...(comment ? { comment } : {}) }),
  resumeStep: (id: string, comment?: string) => call<unknown>("POST", `/v1/steps/${encodeURIComponent(id)}/resume`, comment ? { comment } : {}),
  newGoal: (title: string, primaryRepo?: string, topics: string[] = []) => call<Goal>("POST", "/v1/goals", { title, ...(primaryRepo ? { primaryRepo } : {}), ...(topics.length ? { topics } : {}) }),
};
