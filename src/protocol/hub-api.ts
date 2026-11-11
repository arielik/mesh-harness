// The hub's HTTP API as data: every route, who may call it, its request body and query. `pnpm
// schemas` publishes it as an OpenAPI 3.1 document (schemas/hub-api.openapi.json); a test checks it
// lists exactly the routes src/hub/app.ts serves, with the same authorization rule.

import { z } from "zod";
import {
  AckRequest,
  AnswerRequest,
  Approve,
  AskRequest,
  ClaimRequest,
  CliExchange,
  Decide,
  DevicePoll,
  DoneRequest,
  GateDecision,
  LoginDirect,
  MachineName,
  MessageRequest,
  NewGoal,
  NewTopic,
  GoalTopicsChange,
  NoteRequest,
  ProposePlan,
  ReleaseRequest,
  Replan,
  ResumeRequest,
  SyncRequest,
  IDEMPOTENCY_HEADER,
  SESSION_COOKIE,
} from "./hub.ts";
import { HubEvent } from "./json-schema.ts";

export type HubRouteRule = "public" | "member" | "admin" | "events";

/** What a service token may do beyond the event feed (`mesh hub token --service <name> --scope …`). */
export const SERVICE_SCOPES = ["goals:read", "goals:write", "live:read"] as const;
export const ServiceScope = z.enum(SERVICE_SCOPES);
export type ServiceScope = z.infer<typeof ServiceScope>;

export interface HubApiRoute {
  method: "GET" | "POST";
  /** Hono-style path: `:name` is a path parameter. */
  path: string;
  rule: HubRouteRule;
  /** A member route a service token with this scope may also call. */
  scope?: ServiceScope;
  summary: string;
  tag: "probes" | "auth" | "daemon" | "goals" | "steps" | "questions" | "analysis" | "admin";
  body?: z.ZodType;
  query?: Record<string, string>;
  /** Response body schema, where the protocol defines one. */
  response?: z.ZodType;
  /** 201 for creations; 302 for redirects; otherwise 200. */
  status?: 200 | 201 | 302;
  /** Server-sent events instead of JSON. */
  sse?: boolean;
}

const TOPIC_QUERY = "topic names, repeated or comma-separated: only goals with every one (`all`: every goal)";

export const RevokeRequest = z.object({ userId: z.string().optional(), machineId: z.string().optional() });

export const HUB_API: readonly HubApiRoute[] = [
  { method: "GET", path: "/health", rule: "public", tag: "probes", summary: "Liveness (kept for older clients; same as /healthz)." },
  { method: "GET", path: "/healthz", rule: "public", tag: "probes", summary: "Liveness: the process answers." },
  { method: "GET", path: "/readyz", rule: "public", tag: "probes", summary: "Readiness: the database answers and is migrated (503 until then)." },

  { method: "GET", path: "/auth/providers", rule: "public", tag: "auth", summary: "The login providers this hub offers." },
  { method: "POST", path: "/auth/:id/login", rule: "public", tag: "auth", body: LoginDirect, summary: "Log in with a token provider (or the Solo hub's local provider)." },
  {
    method: "GET",
    path: "/auth/:id/start",
    rule: "public",
    tag: "auth",
    status: 302,
    query: {
      client: "cli | web",
      cli_port: "loopback port of a CLI login",
      cli_challenge: "PKCE challenge of a CLI login",
      cli_mode: "paste: the CLI can't receive a localhost redirect (a remote shell); the callback shows the one-time code to paste",
      hostname: "machine name",
    },
    summary: "Start a browser (OIDC) login: redirects to the identity provider.",
  },
  { method: "GET", path: "/auth/:id/callback", rule: "public", tag: "auth", status: 302, summary: "The identity provider's redirect back to the hub (a page with the one-time code for a CLI in paste mode)." },
  { method: "POST", path: "/auth/cli/exchange", rule: "public", tag: "auth", body: CliExchange, summary: "Exchange a CLI login code (with its PKCE verifier) for a token." },
  { method: "POST", path: "/auth/:id/device", rule: "public", tag: "auth", body: LoginDirect, summary: "Start a device-code login (for machines without a browser)." },
  { method: "POST", path: "/auth/:id/device/poll", rule: "public", tag: "auth", body: DevicePoll, summary: "Poll a device-code login (202 while pending)." },
  { method: "POST", path: "/auth/logout", rule: "member", tag: "auth", summary: "Revoke the calling token or web session." },

  { method: "GET", path: "/v1/me", rule: "member", tag: "daemon", summary: "The calling user and machine." },
  { method: "POST", path: "/v1/sync", rule: "member", tag: "daemon", body: SyncRequest, summary: "A daemon reports its sessions and facts (batched, idempotent)." },
  { method: "GET", path: "/v1/inbox", rule: "member", tag: "daemon", summary: "Messages waiting for the calling machine's sessions." },
  { method: "POST", path: "/v1/inbox/:id/ack", rule: "member", tag: "daemon", body: AckRequest, summary: "Mark an inbox message delivered or failed." },
  { method: "GET", path: "/v1/live", rule: "member", scope: "live:read", tag: "daemon", query: { topic: TOPIC_QUERY }, summary: "Live sessions across the team, and goals (filtered by topic)." },
  { method: "GET", path: "/v1/fleet", rule: "member", scope: "live:read", tag: "daemon", summary: "Every machine logged in as the caller and what each session on it is doing (read-only)." },
  { method: "POST", path: "/v1/machines/:id/name", rule: "member", tag: "daemon", body: MachineName, summary: "Name one of your machines (or clear its name with null)." },
  { method: "GET", path: "/v1/attention", rule: "member", tag: "daemon", summary: "What needs the calling user: questions, gates, stalled steps." },
  { method: "GET", path: "/v1/stream", rule: "member", scope: "live:read", tag: "daemon", sse: true, summary: "Server-sent hints (changed, wake). Lossy by design: clients refetch." },

  { method: "GET", path: "/v1/goals", rule: "member", scope: "goals:read", tag: "goals", query: { topic: TOPIC_QUERY }, summary: "All goals, or those with the given topics." },
  { method: "POST", path: "/v1/goals", rule: "member", scope: "goals:write", tag: "goals", body: NewGoal, status: 201, summary: "Create a goal." },
  { method: "GET", path: "/v1/goals/:id", rule: "member", scope: "goals:read", tag: "goals", summary: "A goal with its plans and steps." },
  { method: "POST", path: "/v1/goals/:id/plan", rule: "member", tag: "goals", body: ProposePlan, status: 201, summary: "Propose a plan (design sessions)." },
  { method: "POST", path: "/v1/goals/:id/approve", rule: "member", tag: "goals", body: Approve, summary: "Approve the proposed plan (approvers)." },
  { method: "POST", path: "/v1/goals/:id/revise", rule: "member", tag: "goals", body: Decide, summary: "Ask the design session to revise the proposed plan." },
  { method: "POST", path: "/v1/goals/:id/replan", rule: "member", tag: "goals", body: Replan, summary: "Reopen design for a goal with an approved plan." },
  { method: "GET", path: "/v1/goals/:id/files", rule: "member", scope: "goals:read", tag: "goals", summary: "The record files of a goal, as the ledger writes them." },
  { method: "POST", path: "/v1/goals/:id/topics", rule: "member", scope: "goals:write", tag: "goals", body: GoalTopicsChange, summary: "Tag a goal with topics or untag it (any member)." },
  { method: "GET", path: "/v1/topics", rule: "member", scope: "goals:read", tag: "goals", summary: "Topics with their goal counts; `all` (every goal) first." },
  { method: "POST", path: "/v1/topics", rule: "member", scope: "goals:write", tag: "goals", body: NewTopic, status: 201, summary: "Define a topic." },
  { method: "POST", path: "/v1/topics/:name/delete", rule: "member", scope: "goals:write", tag: "goals", summary: "Delete a topic (its creator or an admin) and untag its goals." },
  { method: "GET", path: "/v1/goals/:id/timeline", rule: "member", scope: "goals:read", tag: "goals", summary: "A goal's history." },

  {
    method: "GET",
    path: "/v1/steps",
    rule: "member",
    scope: "goals:read",
    tag: "steps",
    query: { goal: "goal id", ready: "1: only ready steps", repo: "repo name or id", mine: "1: only steps the caller holds" },
    summary: "Steps, filtered.",
  },
  { method: "GET", path: "/v1/steps/:id/context", rule: "member", tag: "steps", query: { agent: "1: the brief as an agent reads it" }, summary: "A step's brief: design, dependencies, notes." },
  { method: "GET", path: "/v1/steps/:id", rule: "member", scope: "goals:read", tag: "steps", summary: "One step." },
  { method: "POST", path: "/v1/steps/:id/claim", rule: "member", tag: "steps", body: ClaimRequest, summary: "Claim a ready step (exactly one caller wins)." },
  { method: "POST", path: "/v1/steps/:id/release", rule: "member", tag: "steps", body: ReleaseRequest, summary: "Give a step back with a handoff note." },
  { method: "POST", path: "/v1/steps/:id/note", rule: "member", tag: "steps", body: NoteRequest, summary: "Add a progress note to a step." },
  { method: "POST", path: "/v1/steps/:id/done", rule: "member", tag: "steps", body: DoneRequest, summary: "Finish a step (done, or fail and reopen earlier steps)." },
  { method: "POST", path: "/v1/steps/:id/approve", rule: "member", tag: "steps", body: GateDecision, summary: "Pass a gate step." },
  { method: "POST", path: "/v1/steps/:id/reject", rule: "member", tag: "steps", body: GateDecision, summary: "Reject a gate step (optionally reopening steps)." },
  { method: "POST", path: "/v1/steps/:id/resume", rule: "member", tag: "steps", body: ResumeRequest, summary: "Resume a parked step." },
  { method: "POST", path: "/v1/steps/:id/take", rule: "member", tag: "steps", body: ClaimRequest, summary: "Take over a step held by someone else (after the takeover threshold)." },

  { method: "POST", path: "/v1/questions", rule: "member", tag: "questions", body: AskRequest, status: 201, summary: "Ask a person a question (mesh_ask)." },
  { method: "POST", path: "/v1/questions/:id/answer", rule: "member", tag: "questions", body: AnswerRequest, summary: "Answer a question; the answer is delivered to the asking session." },
  { method: "POST", path: "/v1/messages", rule: "member", tag: "questions", body: MessageRequest, status: 201, summary: "Send a message to a session or to whoever holds a step." },

  {
    method: "GET",
    path: "/v1/events",
    rule: "events",
    tag: "analysis",
    query: { after: "return events with a sequence number above this", limit: "at most this many (default 500)" },
    response: z.object({ events: z.array(HubEvent) }),
    summary: "The event log, gap-free and in commit order (service tokens and admins).",
  },
  { method: "GET", path: "/v1/admin/users", rule: "admin", tag: "admin", summary: "All users." },
  { method: "POST", path: "/v1/admin/revoke", rule: "admin", tag: "admin", body: RevokeRequest, summary: "Revoke the tokens of a user or a machine." },
];

const RULE_TEXT: Record<HubRouteRule, string> = {
  public: "No authentication.",
  member: "Any logged-in user (bearer token or web session).",
  admin: "Admins only.",
  events: "Service tokens and admins.",
};

/** The API as an OpenAPI 3.1 document. */
export function hubOpenApi(version = "1"): Record<string, unknown> {
  const schema = (s: z.ZodType, io: "input" | "output") => z.toJSONSchema(s, { io, unrepresentable: "any", target: "draft-2020-12" });
  const paths: Record<string, Record<string, unknown>> = {};
  for (const r of HUB_API) {
    const path = r.path.replace(/:([a-zA-Z]+)/g, "{$1}");
    const params: unknown[] = [...r.path.matchAll(/:([a-zA-Z]+)/g)].map((m) => ({ name: m[1], in: "path", required: true, schema: { type: "string" } }));
    for (const [name, description] of Object.entries(r.query ?? {})) params.push({ name, in: "query", required: false, description, schema: { type: "string" } });
    if (r.method === "POST" && r.rule !== "public") {
      params.push({ name: IDEMPOTENCY_HEADER, in: "header", required: false, description: "Repeat-safe retries: a repeated key returns the first response.", schema: { type: "string" } });
    }
    const status = String(r.status ?? 200);
    const responses: Record<string, unknown> = {
      [status]: r.sse
        ? { description: "Server-sent events: hello, changed, wake, ping.", content: { "text/event-stream": { schema: { type: "string" } } } }
        : status === "302"
          ? { description: "Redirect." }
          : { description: "OK", content: { "application/json": { schema: r.response ? schema(r.response, "output") : { type: "object" } } } },
    };
    if (r.rule !== "public") responses["401"] = { description: "Login required." };
    if (r.rule === "admin" || r.rule === "events" || r.scope) responses["403"] = { description: "Forbidden." };
    if (r.body) responses["400"] = { description: "Invalid request: { error, details }." };
    const op: Record<string, unknown> = {
      operationId: `${r.method.toLowerCase()}${r.path.replace(/[/:]+([a-zA-Z])/g, (_, ch: string) => ch.toUpperCase()).replace(/[^a-zA-Z]/g, "")}`,
      summary: r.summary,
      description: r.scope ? `${RULE_TEXT[r.rule]} Also service tokens with the scope \`${r.scope}\`.` : RULE_TEXT[r.rule],
      tags: [r.tag],
      ...(params.length ? { parameters: params } : {}),
      ...(r.body ? { requestBody: { required: false, content: { "application/json": { schema: schema(r.body, "input") } } } } : {}),
      responses,
      ...(r.rule === "public" ? { security: [] } : {}),
    };
    paths[path] = { ...(paths[path] ?? {}), [r.method.toLowerCase()]: op };
  }
  return {
    openapi: "3.1.0",
    info: {
      title: "mesh hub API",
      version,
      description: "The HTTP API of `mesh hub`. Errors are JSON: { error, details? }. POST routes accept an idempotency key header for safe retries.",
    },
    servers: [{ url: "https://mesh.example", description: "your hub (placeholder)" }],
    security: [{ bearer: [] }, { session: [] }],
    components: {
      securitySchemes: {
        bearer: { type: "http", scheme: "bearer", description: "A token from `mesh login`, a machine token, or a service token." },
        session: { type: "apiKey", in: "cookie", name: SESSION_COOKIE, description: "The web dashboard's session (writes must come from the hub's own origin)." },
      },
    },
    tags: [
      { name: "probes" },
      { name: "auth" },
      { name: "daemon", description: "Used by `mesh up` on each machine." },
      { name: "goals" },
      { name: "steps" },
      { name: "questions" },
      { name: "analysis" },
      { name: "admin" },
    ],
    paths,
  };
}
