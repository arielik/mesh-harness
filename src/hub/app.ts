// mesh hub HTTP API (plan §5.6). Every route declares an authorization rule in ROUTES; a test
// checks none is missing. Bearer tokens (CLI, daemon, mesh-ai) or the web session cookie.

import { existsSync, readFileSync } from "node:fs";
import { extname, join, normalize } from "node:path";
import { Hono, type Context } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { streamSSE } from "hono/streaming";
import { ZodError, type ZodType } from "zod";
import { AuthError } from "../auth/index.ts";
import { allowed, type RouteRule } from "../core/index.ts";
import {
  AckRequest,
  Approve,
  AnswerRequest,
  AskRequest,
  ClaimRequest,
  CliExchange,
  Decide,
  DevicePoll,
  DoneRequest,
  IDEMPOTENCY_HEADER,
  LoginDirect,
  MessageRequest,
  NewGoal,
  NoteRequest,
  ProposePlan,
  ReleaseRequest,
  Replan,
  SESSION_COOKIE,
  SyncRequest,
  type LoginResult,
} from "../protocol/index.ts";
import { HubError, type Actor, type HubService } from "./service.ts";

type Env = { Variables: { actor: Actor | undefined; viaCookie: boolean } };
type Handler = (c: Context<Env>, actor: Actor) => Promise<Response> | Response;

export interface Route {
  method: "GET" | "POST";
  path: string;
  rule: RouteRule;
  handler: Handler;
}

async function body<T>(c: Context<Env>, schema: ZodType<T>): Promise<T> {
  let raw: unknown;
  try {
    const text = await c.req.text();
    raw = text ? JSON.parse(text) : {};
  } catch {
    throw new HubError(400, "invalid JSON body");
  }
  return schema.parse(raw);
}

const param = (c: Context<Env>, name: string) => decodeURIComponent(c.req.param(name) ?? "");

export function buildRoutes(svc: HubService): Route[] {
  const secureCookie = svc.config.url.startsWith("https://");
  const setSession = (c: Context<Env>, r: LoginResult) =>
    setCookie(c, SESSION_COOKIE, r.token, { httpOnly: true, secure: secureCookie, sameSite: "Lax", path: "/", expires: new Date(r.expiresAt) });

  const r = (method: Route["method"], path: string, rule: RouteRule, handler: Handler): Route => ({ method, path, rule, handler });
  return [
    r("GET", "/health", "public", (c) => c.json({ ok: true })),

    // ---------- auth ----------
    r("GET", "/auth/providers", "public", (c) => c.json({ providers: svc.providersInfo() })),
    r("POST", "/auth/:id/login", "public", async (c) => {
      const b = await body(c, LoginDirect);
      const res = await svc.loginDirect(param(c, "id"), b);
      if (b.client === "web") {
        setSession(c, res);
        return c.json({ user: res.user });
      }
      return c.json(res);
    }),
    r("GET", "/auth/:id/start", "public", async (c) => {
      const client = c.req.query("client") === "web" ? "web" : "cli";
      const port = Number(c.req.query("cli_port"));
      const url = await svc.loginStart(param(c, "id"), client, {
        cliPort: Number.isInteger(port) && port > 0 && port < 65536 ? port : undefined,
        cliChallenge: c.req.query("cli_challenge"),
        hostname: c.req.query("hostname"),
      });
      return c.redirect(url, 302);
    }),
    r("GET", "/auth/:id/callback", "public", async (c) => {
      const out = await svc.loginCallback(param(c, "id"), c.req.url.replace(/^https?:\/\/[^/]+/, svc.config.url));
      if (out.webToken) setSession(c, out.webToken);
      return c.redirect(out.redirect, 302);
    }),
    r("POST", "/auth/cli/exchange", "public", async (c) => {
      const b = await body(c, CliExchange);
      return c.json(svc.cliExchange(b.code, b.verifier, b.hostname));
    }),
    r("POST", "/auth/:id/device", "public", async (c) => {
      const b = await body(c, LoginDirect);
      const start = await svc.deviceStart(param(c, "id"), b.hostname, b.client);
      return c.json(start);
    }),
    r("POST", "/auth/:id/device/poll", "public", async (c) => {
      const b = await body(c, DevicePoll);
      const res = await svc.devicePoll(param(c, "id"), b.pollId, b.hostname);
      if (res === "pending") return c.json({ pending: true }, 202);
      if (!res.machine) {
        setSession(c, res);
        return c.json({ user: res.user });
      }
      return c.json(res);
    }),
    r("POST", "/auth/logout", "member", (c, a) => {
      svc.logout(a);
      deleteCookie(c, SESSION_COOKIE, { path: "/" });
      return c.json({ ok: true });
    }),

    // ---------- me, daemon ----------
    r("GET", "/v1/me", "member", (c, a) => c.json(svc.me(a))),
    r("POST", "/v1/sync", "member", async (c, a) => c.json(svc.sync(a, await body(c, SyncRequest)))),
    r("GET", "/v1/inbox", "member", (c, a) => c.json({ messages: svc.inbox(a) })),
    r("POST", "/v1/inbox/:id/ack", "member", async (c, a) => {
      const b = await body(c, AckRequest);
      return c.json({ ok: svc.ack(a, Number(param(c, "id")), b.state, b.method) });
    }),

    // ---------- dashboard ----------
    r("GET", "/v1/live", "member", (c, a) => c.json(svc.live(a))),
    r("GET", "/v1/attention", "member", (c, a) => c.json({ attention: svc.attentionFor(a) })),
    r("GET", "/v1/stream", "member", (c, a) =>
      streamSSE(c, async (stream) => {
        let open = true;
        const queue: string[] = [];
        let wake: (() => void) | undefined;
        const unsubscribe = svc.bus.subscribe((h) => {
          if (h.type === "wake" && h.machine !== a.machineId) return;
          queue.push(JSON.stringify(h));
          wake?.();
        });
        stream.onAbort(() => {
          open = false;
          wake?.();
        });
        await stream.writeSSE({ event: "hello", data: JSON.stringify({ user: a.userId }) });
        while (open) {
          if (queue.length === 0) {
            await Promise.race([new Promise<void>((ok) => (wake = ok)), stream.sleep(25_000)]);
            wake = undefined;
            if (queue.length === 0 && open) await stream.writeSSE({ event: "ping", data: "{}" });
            continue;
          }
          const data = queue.shift() as string;
          const h = JSON.parse(data) as { type: string };
          await stream.writeSSE({ event: h.type, data });
        }
        unsubscribe();
      }),
    ),

    // ---------- goals ----------
    r("GET", "/v1/goals", "member", (c) => c.json({ goals: svc.listGoals() })),
    r("POST", "/v1/goals", "member", async (c, a) => c.json(svc.createGoal(a, await body(c, NewGoal)), 201)),
    r("GET", "/v1/goals/:id", "member", (c) => c.json(svc.goalDetail(param(c, "id")))),
    r("POST", "/v1/goals/:id/plan", "member", async (c, a) => c.json(svc.proposePlan(a, param(c, "id"), await body(c, ProposePlan)), 201)),
    r("POST", "/v1/goals/:id/approve", "member", async (c, a) => {
      const b = await body(c, Approve);
      return c.json(svc.approvePlan(a, param(c, "id"), b.version, b.comment));
    }),
    r("POST", "/v1/goals/:id/revise", "member", async (c, a) => c.json(svc.revisePlan(a, param(c, "id"), (await body(c, Decide)).comment))),
    r("POST", "/v1/goals/:id/replan", "member", async (c, a) => c.json(svc.replan(a, param(c, "id"), (await body(c, Replan)).comment))),
    r("GET", "/v1/goals/:id/files", "member", (c) => c.json({ files: svc.goalFiles(param(c, "id")) })),
    r("GET", "/v1/goals/:id/timeline", "member", (c) => c.json({ timeline: svc.timeline(param(c, "id")) })),

    // ---------- steps ----------
    r("GET", "/v1/steps", "member", (c, a) =>
      c.json({
        steps: svc.listSteps({
          goal: c.req.query("goal"),
          ready: c.req.query("ready") === "1",
          repo: c.req.query("repo"),
          mine: c.req.query("mine") === "1" ? a.userId : undefined,
        }),
      }),
    ),
    r("GET", "/v1/steps/:id/context", "member", (c) => c.json(svc.context(param(c, "id")))),
    r("GET", "/v1/steps/:id", "member", (c) => c.json(svc.stepView(param(c, "id")))),
    r("POST", "/v1/steps/:id/claim", "member", async (c, a) => c.json(svc.claimStep(a, param(c, "id"), (await body(c, ClaimRequest)).sid))),
    r("POST", "/v1/steps/:id/release", "member", async (c, a) => c.json(svc.releaseStep(a, param(c, "id"), (await body(c, ReleaseRequest)).note))),
    r("POST", "/v1/steps/:id/note", "member", async (c, a) => {
      const b = await body(c, NoteRequest);
      return c.json(svc.noteStep(a, param(c, "id"), b.text, b.sid));
    }),
    r("POST", "/v1/steps/:id/done", "member", async (c, a) => c.json(svc.doneStep(a, param(c, "id"), await body(c, DoneRequest)))),
    r("POST", "/v1/steps/:id/take", "member", async (c, a) => c.json(svc.takeStep(a, param(c, "id"), (await body(c, ClaimRequest)).sid))),

    // ---------- questions, messages ----------
    r("POST", "/v1/questions", "member", async (c, a) => c.json(svc.ask(a, await body(c, AskRequest)), 201)),
    r("POST", "/v1/questions/:id/answer", "member", async (c, a) => c.json(svc.answer(a, Number(param(c, "id")), (await body(c, AnswerRequest)).text))),
    r("POST", "/v1/messages", "member", async (c, a) => c.json(svc.say(a, await body(c, MessageRequest)), 201)),

    // ---------- analysis feed, admin ----------
    r("GET", "/v1/events", "events", (c) => c.json({ events: svc.events(Number(c.req.query("after") ?? 0) || 0, Number(c.req.query("limit") ?? 500) || 500) })),
    r("GET", "/v1/admin/users", "admin", (c) => c.json({ users: svc.store.listUsers() })),
    r("POST", "/v1/admin/revoke", "admin", async (c) => {
      const b = (await c.req.json().catch(() => ({}))) as { userId?: string; machineId?: string };
      return c.json({ revoked: svc.store.revokeTokens(b) });
    }),
  ];
}

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript",
  ".css": "text/css",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".json": "application/json",
};

export function createApp(svc: HubService, opts: { webRoot?: string | undefined } = {}): { app: Hono<Env>; routes: Route[] } {
  const app = new Hono<Env>();
  const routes = buildRoutes(svc);

  app.onError((err, c) => {
    if (err instanceof HubError) return c.json({ error: err.message, ...(err.details ? { details: err.details } : {}) }, err.status as 400);
    if (err instanceof AuthError) return c.json({ error: err.message }, err.status as 401);
    if (err instanceof ZodError) return c.json({ error: "invalid request", details: err.issues.map((i) => `${i.path.join(".")}: ${i.message}`) }, 400);
    process.stderr.write(`hub error: ${String(err)}\n`);
    return c.json({ error: "internal error" }, 500);
  });

  app.use("*", async (c, next) => {
    const auth = c.req.header("authorization");
    let actor: Actor | undefined;
    let viaCookie = false;
    if (auth?.startsWith("Bearer ")) actor = svc.authenticate(auth.slice(7).trim());
    else {
      const cookie = getCookie(c, SESSION_COOKIE);
      if (cookie) {
        actor = svc.authenticate(cookie);
        viaCookie = actor !== undefined;
      }
    }
    // Cookie-authenticated writes must come from the hub's own pages (plan §4.3).
    if (viaCookie && c.req.method !== "GET" && c.req.header("origin") !== new URL(svc.config.url).origin) {
      return c.json({ error: "cross-origin request refused" }, 403);
    }
    c.set("actor", actor);
    c.set("viaCookie", viaCookie);
    await next();
  });

  for (const route of routes) {
    app.on(route.method, route.path, async (c) => {
      const actor = c.get("actor");
      if (!allowed(route.rule, actor)) return c.json({ error: actor ? "forbidden" : "login required" }, actor ? 403 : 401);
      const key = route.method === "POST" && actor ? c.req.header(IDEMPOTENCY_HEADER) : undefined;
      if (key && actor) {
        const prior = svc.store.getIdem(key, actor.userId) as { status: number; body: unknown } | undefined;
        if (prior) return c.json(prior.body as object, prior.status as 200);
      }
      const res = await route.handler(c, actor as Actor);
      if (key && actor && res.status < 300 && res.headers.get("content-type")?.includes("json")) {
        const clone = res.clone();
        svc.store.putIdem(key, actor.userId, { status: res.status, body: await clone.json() }, svc.now());
      }
      return res;
    });
  }

  const root = opts.webRoot;
  app.get("*", (c) => {
    if (!root || !existsSync(join(root, "index.html"))) {
      return c.text("mesh hub is running. The web dashboard is not built (run: pnpm build).", 200);
    }
    const rel = normalize(decodeURIComponent(new URL(c.req.url).pathname)).replace(/^(\.\.[/\\])+/, "");
    let file = join(root, rel);
    if (!file.startsWith(root) || !existsSync(file) || rel === "/" || extname(file) === "") file = join(root, "index.html");
    return c.body(readFileSync(file), 200, { "content-type": MIME[extname(file)] ?? "application/octet-stream" });
  });

  return { app, routes };
}
