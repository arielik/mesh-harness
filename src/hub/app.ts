// mesh hub HTTP API (plan §5.6). Every route declares an authorization rule in ROUTES; a test
// checks none is missing. Bearer tokens (CLI, daemon, service) or the web session cookie.

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
  ArtifactUpload,
  ReviewUpload,
  ProfileSave,
  RunReport,
  Approve,
  AnswerRequest,
  AskRequest,
  AssignRequest,
  ClaimRequest,
  DeclineRequest,
  CliExchange,
  Decide,
  DevicePoll,
  DoneRequest,
  IDEMPOTENCY_HEADER,
  LoginDirect,
  MachineLabels,
  MachineName,
  MessageRequest,
  NewGoal,
  NewTopic,
  GoalFromPreset,
  PulseCreate,
  PulseUpdate,
  GoalTopicsChange,
  NoteRequest,
  ProposePlan,
  ReleaseRequest,
  GateDecision,
  ResumeRequest,
  Replan,
  SESSION_COOKIE,
  SyncRequest,
  type LoginResult,
  type ServiceScope,
} from "../protocol/index.ts";
import { HubError, type Actor, type HubService } from "./service.ts";

type Env = { Variables: { actor: Actor | undefined; viaCookie: boolean } };
type Handler = (c: Context<Env>, actor: Actor) => Promise<Response> | Response;

export interface Route {
  method: "GET" | "POST";
  path: string;
  rule: RouteRule;
  scope?: ServiceScope | undefined;
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
/** `?topic=a&topic=b` or `?topic=a,b`: goals must carry every one. */
const topicsQuery = (c: Context<Env>): string[] => (c.req.queries("topic") ?? []).flatMap((v) => v.split(",")).map((v) => v.trim()).filter(Boolean);
/** MM-4: `team=1` / `any=1` of the suggest routes; any other value is off. */
const suggestFlags = (c: Context<Env>) => ({ team: c.req.query("team") === "1", any: c.req.query("any") === "1" });

const escapeHtml = (s: string) => s.replace(/[&<>"']/g, (ch) => `&#${ch.charCodeAt(0)};`);

/** What a person sees after signing in for a CLI in a remote shell: the code to paste there. */
export function pasteCodePage(code: string): string {
  const c = escapeHtml(code);
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>mesh login</title>
<style>
  body { font: 16px/1.5 system-ui, sans-serif; max-width: 34rem; margin: 4rem auto; padding: 0 1rem; color: #1b1b1b; background: #fff; }
  code { display: block; font: 1.15rem ui-monospace, monospace; padding: .8rem 1rem; margin: 1rem 0; background: #f2f2f2; border-radius: 6px; word-break: break-all; user-select: all; }
  @media (prefers-color-scheme: dark) { body { color: #e8e8e8; background: #161616; } code { background: #262626; } }
</style></head>
<body>
  <h1>Almost done</h1>
  <p>Paste this code into the terminal where you ran <b>mesh login</b>:</p>
  <code id="code">${c}</code>
  <p>It works once, for the next 5 minutes, and only in that terminal. You can close this tab afterwards.</p>
</body></html>
`;
}

export function buildRoutes(svc: HubService): Route[] {
  const secureCookie = svc.config.url.startsWith("https://");
  const setSession = (c: Context<Env>, r: LoginResult) =>
    setCookie(c, SESSION_COOKIE, r.token, { httpOnly: true, secure: secureCookie, sameSite: "Lax", path: "/", expires: new Date(r.expiresAt) });

  const r = (method: Route["method"], path: string, rule: RouteRule, handler: Handler, scope?: ServiceScope): Route => ({ method, path, rule, handler, scope });
  return [
    r("GET", "/health", "public", (c) => c.json({ ok: true })),
    // Probes (M4.6), no auth. Liveness: the process answers. Readiness: the database answers and is
    // migrated; a load balancer sends this replica no traffic until it is ready.
    r("GET", "/healthz", "public", (c) => c.json({ ok: true })),
    r("GET", "/readyz", "public", async (c) => {
      const ready = await svc.ready();
      return c.json(ready, ready.ok ? 200 : 503);
    }),

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
        cliPaste: c.req.query("cli_mode") === "paste",
        hostname: c.req.query("hostname"),
      });
      return c.redirect(url, 302);
    }),
    r("GET", "/auth/:id/callback", "public", async (c) => {
      const out = await svc.loginCallback(param(c, "id"), c.req.url.replace(/^https?:\/\/[^/]+/, svc.config.url));
      if (out.webToken) setSession(c, out.webToken);
      if (out.pasteCode !== undefined) {
        c.header("cache-control", "no-store");
        return c.html(pasteCodePage(out.pasteCode));
      }
      return c.redirect(out.redirect, 302);
    }),
    r("POST", "/auth/cli/exchange", "public", async (c) => {
      const b = await body(c, CliExchange);
      return c.json(await svc.cliExchange(b.code, b.verifier, b.hostname, b.install));
    }),
    r("POST", "/auth/:id/device", "public", async (c) => {
      const b = await body(c, LoginDirect);
      const start = await svc.deviceStart(param(c, "id"), b.hostname, b.client);
      return c.json(start);
    }),
    r("POST", "/auth/:id/device/poll", "public", async (c) => {
      const b = await body(c, DevicePoll);
      const res = await svc.devicePoll(param(c, "id"), b.pollId, b.hostname, b.install);
      if (res === "pending") return c.json({ pending: true }, 202);
      if (!res.machine) {
        setSession(c, res);
        return c.json({ user: res.user });
      }
      return c.json(res);
    }),
    r("POST", "/auth/logout", "member", async (c, a) => {
      await svc.logout(a);
      deleteCookie(c, SESSION_COOKIE, { path: "/" });
      return c.json({ ok: true });
    }),

    // ---------- me, daemon ----------
    r("GET", "/v1/me", "member", async (c, a) => c.json(await svc.me(a))),
    r("POST", "/v1/sync", "member", async (c, a) => c.json(await svc.sync(a, await body(c, SyncRequest)))),
    r("GET", "/v1/inbox", "member", async (c, a) => c.json({ messages: await svc.inbox(a) })),
    r("POST", "/v1/inbox/:id/ack", "member", async (c, a) => {
      const b = await body(c, AckRequest);
      return c.json({ ok: await svc.ack(a, Number(param(c, "id")), b.state, b.method) });
    }),

    // ---------- dashboard ----------
    r("GET", "/v1/live", "member", async (c, a) => c.json(await svc.live(a, topicsQuery(c))), "live:read"),
    r("GET", "/v1/fleet", "member", async (c, a) => c.json(await svc.fleet(a)), "live:read"),
    r("POST", "/v1/machines/:id/name", "member", async (c, a) => c.json(await svc.renameMachine(a, param(c, "id"), (await body(c, MachineName)).nickname))),
    r("POST", "/v1/machines/:id/labels", "member", async (c, a) => c.json(await svc.labelMachine(a, param(c, "id"), await body(c, MachineLabels)))),
    r("GET", "/v1/attention", "member", async (c, a) => c.json({ attention: await svc.attentionFor(a) })),
    r("GET", "/v1/stream", "member", (c, a) =>
      streamSSE(c, async (stream) => {
        let open = true;
        const queue: string[] = [];
        let wake: (() => void) | undefined;
        const unsubscribe = svc.bus.subscribe((h) => {
          if (h.type === "wake" && h.machine !== a.machineId) return;
          if (h.type === "resync") {
            // Hints from other replicas may have been lost: say everything changed.
            queue.push(JSON.stringify({ type: "changed", seq: 0 }));
            if (a.machineId) queue.push(JSON.stringify({ type: "wake", machine: a.machineId }));
          } else {
            queue.push(JSON.stringify(h));
          }
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
      "live:read",
    ),

    // ---------- goals ----------
    r("GET", "/v1/goals", "member", async (c) => c.json({ goals: await svc.listGoals(topicsQuery(c), { pulses: c.req.query("pulses") === "1" }) }), "goals:read"),
    r("POST", "/v1/goals", "member", async (c, a) => c.json(await svc.createGoal(a, await body(c, NewGoal)), 201), "goals:write"),
    // RL-3: ingest (a goal with an approved plan from a preset).
    r("POST", "/v1/goals/from-preset", "member", async (c, a) => c.json(await svc.goalFromPreset(a, await body(c, GoalFromPreset)), 201), "goals:write"),
    r("GET", "/v1/goals/:id", "member", async (c) => c.json(await svc.goalDetail(param(c, "id"))), "goals:read"),
    r("POST", "/v1/goals/:id/plan", "member", async (c, a) => c.json(await svc.proposePlan(a, param(c, "id"), await body(c, ProposePlan)), 201)),
    r("POST", "/v1/goals/:id/approve", "member", async (c, a) => {
      const b = await body(c, Approve);
      return c.json(await svc.approvePlan(a, param(c, "id"), b.version, b.comment));
    }),
    r("POST", "/v1/goals/:id/revise", "member", async (c, a) => c.json(await svc.revisePlan(a, param(c, "id"), (await body(c, Decide)).comment))),
    r("POST", "/v1/goals/:id/replan", "member", async (c, a) => c.json(await svc.replan(a, param(c, "id"), (await body(c, Replan)).comment))),
    r("GET", "/v1/goals/:id/files", "member", async (c) => c.json({ files: await svc.goalFiles(param(c, "id")) }), "goals:read"),
    r("POST", "/v1/goals/:id/topics", "member", async (c, a) => c.json(await svc.changeGoalTopics(a, param(c, "id"), await body(c, GoalTopicsChange))), "goals:write"),

    // ---------- pulses (RL-3) ----------
    r("GET", "/v1/pulses", "member", async (c, a) => c.json({ pulses: await svc.listPulsesView(a, c.req.query("mine") === "1") }), "goals:read"),
    r("POST", "/v1/pulses", "member", async (c, a) => c.json(await svc.createPulse(a, await body(c, PulseCreate)), 201)),
    r("GET", "/v1/pulses/:id", "member", async (c) => c.json(await svc.pulseDetail(param(c, "id"))), "goals:read"),
    r("POST", "/v1/pulses/:id/update", "member", async (c, a) => c.json(await svc.updatePulse(a, param(c, "id"), await body(c, PulseUpdate)))),
    r("POST", "/v1/pulses/:id/pause", "member", async (c, a) => c.json(await svc.pausePulse(a, param(c, "id")))),
    r("POST", "/v1/pulses/:id/resume", "member", async (c, a) => c.json(await svc.resumePulse(a, param(c, "id")))),
    r("POST", "/v1/pulses/:id/fire", "member", async (c, a) => c.json(await svc.firePulse(a, param(c, "id")), 201)),
    r("POST", "/v1/pulses/:id/delete", "member", async (c, a) => c.json(await svc.deletePulse(a, param(c, "id")))),

    // ---------- topics ----------
    r("GET", "/v1/topics", "member", async (c) => c.json({ topics: await svc.listTopics() }), "goals:read"),
    r("POST", "/v1/topics", "member", async (c, a) => c.json(await svc.createTopic(a, await body(c, NewTopic)), 201), "goals:write"),
    r("POST", "/v1/topics/:name/delete", "member", async (c, a) => c.json(await svc.deleteTopic(a, param(c, "name"))), "goals:write"),
    r("GET", "/v1/goals/:id/timeline", "member", async (c) => c.json({ timeline: await svc.timeline(param(c, "id")) }), "goals:read"),
    r("POST", "/v1/goals/:id/assign", "member", async (c, a) => c.json(await svc.assignGoal(a, param(c, "id"), await body(c, AssignRequest)))),
    r("GET", "/v1/goals/:id/suggest", "member", async (c, a) => c.json(await svc.suggestGoal(a, param(c, "id"), suggestFlags(c)))),
    r("POST", "/v1/goals/:id/withdraw", "member", async (c, a) => c.json(await svc.withdrawGoal(a, param(c, "id")))),
    // RL-1: artifacts and permission profiles.
    r("GET", "/v1/goals/:id/artifacts", "member", async (c) => c.json({ artifacts: await svc.goalArtifacts(param(c, "id")) }), "goals:read"),
    r("GET", "/v1/artifacts/:id", "member", async (c) => c.json(await svc.getArtifact(param(c, "id"))), "goals:read"),
    r("GET", "/v1/profiles", "member", async (c) => c.json({ profiles: await svc.listProfiles() }), "goals:read"),
    r("GET", "/v1/profiles/:name", "member", async (c) => c.json(await svc.getProfileView(param(c, "name"))), "goals:read"),
    r("POST", "/v1/profiles", "member", async (c, a) => {
      const { view, created } = await svc.saveProfile(a, await body(c, ProfileSave));
      return c.json(view, created ? 201 : 200);
    }),

    // ---------- steps ----------
    r("GET", "/v1/steps", "member", async (c, a) =>
      c.json({
        steps: await svc.listSteps({
          goal: c.req.query("goal"),
          ready: c.req.query("ready") === "1",
          repo: c.req.query("repo"),
          mine: c.req.query("mine") === "1" ? a.userId : undefined,
        }, a),
      }),
      "goals:read",
    ),
    r("GET", "/v1/steps/:id/context", "member", async (c) => c.json(await svc.context(param(c, "id"), c.req.query("agent") === "1"))),
    r("GET", "/v1/steps/:id", "member", async (c) => c.json(await svc.stepView(param(c, "id"))), "goals:read"),
    r("POST", "/v1/steps/:id/claim", "member", async (c, a) => c.json(await svc.claimStep(a, param(c, "id"), (await body(c, ClaimRequest)).sid))),
    r("POST", "/v1/steps/:id/release", "member", async (c, a) => c.json(await svc.releaseStep(a, param(c, "id"), (await body(c, ReleaseRequest)).note))),
    r("POST", "/v1/steps/:id/note", "member", async (c, a) => {
      const b = await body(c, NoteRequest);
      return c.json(await svc.noteStep(a, param(c, "id"), b.text, b.sid));
    }),
    r("POST", "/v1/steps/:id/done", "member", async (c, a) => c.json(await svc.doneStep(a, param(c, "id"), await body(c, DoneRequest)))),
    r("POST", "/v1/steps/:id/approve", "member", async (c, a) => c.json(await svc.decideGate(a, param(c, "id"), { ...(await body(c, GateDecision)), approve: true }))),
    r("POST", "/v1/steps/:id/reject", "member", async (c, a) => c.json(await svc.decideGate(a, param(c, "id"), { ...(await body(c, GateDecision)), approve: false }))),
    r("POST", "/v1/steps/:id/resume", "member", async (c, a) => c.json(await svc.resumeStep(a, param(c, "id"), (await body(c, ResumeRequest)).comment))),
    r("POST", "/v1/steps/:id/take", "member", async (c, a) => c.json(await svc.takeStep(a, param(c, "id"), (await body(c, ClaimRequest)).sid))),
    r("POST", "/v1/steps/:id/assign", "member", async (c, a) => c.json(await svc.assignStep(a, param(c, "id"), await body(c, AssignRequest)))),
    r("GET", "/v1/steps/:id/suggest", "member", async (c, a) => c.json(await svc.suggestStep(a, param(c, "id"), suggestFlags(c)))),
    r("POST", "/v1/steps/:id/accept", "member", async (c, a) => c.json(await svc.acceptStep(a, param(c, "id"), (await body(c, ClaimRequest)).sid))),
    r("POST", "/v1/steps/:id/decline", "member", async (c, a) => c.json(await svc.declineStep(a, param(c, "id"), (await body(c, DeclineRequest)).note))),
    r("POST", "/v1/steps/:id/withdraw", "member", async (c, a) => c.json(await svc.withdrawStep(a, param(c, "id")))),
    r("GET", "/v1/offers", "member", async (c, a) => c.json({ offers: await svc.offers(a) })),
    r("POST", "/v1/steps/:id/artifacts", "member", async (c, a) => c.json(await svc.uploadArtifact(a, param(c, "id"), await body(c, ArtifactUpload)), 201)),
    r("POST", "/v1/steps/:id/run", "member", async (c, a) => c.json(await svc.runReport(a, param(c, "id"), await body(c, RunReport)))),
    // RL-2: review records and items.
    r("POST", "/v1/steps/:id/review", "member", async (c, a) => c.json(await svc.submitReview(a, param(c, "id"), await body(c, ReviewUpload)), 201)),
    r("GET", "/v1/steps/:id/reviews", "member", async (c) => c.json(await svc.stepReviews(param(c, "id"))), "goals:read"),
    r(
      "GET",
      "/v1/items",
      "member",
      async (c) => {
        const lineage = c.req.query("lineage");
        if (!lineage) throw new HubError(400, "lineage is required");
        return c.json(await svc.lineageItems(lineage));
      },
      "goals:read",
    ),

    // ---------- questions, messages ----------
    r("POST", "/v1/questions", "member", async (c, a) => c.json(await svc.ask(a, await body(c, AskRequest)), 201)),
    r("POST", "/v1/questions/:id/answer", "member", async (c, a) => c.json(await svc.answer(a, Number(param(c, "id")), (await body(c, AnswerRequest)).text))),
    r("POST", "/v1/messages", "member", async (c, a) => c.json(await svc.say(a, await body(c, MessageRequest)), 201)),

    // ---------- analysis feed, admin ----------
    r("GET", "/v1/events", "events", async (c) => c.json({ events: await svc.events(Number(c.req.query("after") ?? 0) || 0, Number(c.req.query("limit") ?? 500) || 500) })),
    r("GET", "/v1/admin/users", "admin", async (c) => c.json({ users: await svc.store.listUsers() })),
    r("POST", "/v1/admin/revoke", "admin", async (c) => {
      const b = (await c.req.json().catch(() => ({}))) as { userId?: string; machineId?: string };
      return c.json({ revoked: await svc.store.revokeTokens(b) });
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
    if (auth?.startsWith("Bearer ")) actor = await svc.authenticate(auth.slice(7).trim());
    else {
      const cookie = getCookie(c, SESSION_COOKIE);
      if (cookie) {
        actor = await svc.authenticate(cookie);
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
      if (!allowed(route.rule, actor, route.scope)) return c.json({ error: actor ? "forbidden" : "login required" }, actor ? 403 : 401);
      const key = route.method === "POST" && actor ? c.req.header(IDEMPOTENCY_HEADER) : undefined;
      if (key && actor) {
        const prior = (await svc.store.getIdem(key, actor.userId)) as { status: number; body: unknown } | undefined;
        if (prior) return c.json(prior.body as object, prior.status as 200);
      }
      const res = await route.handler(c, actor as Actor);
      if (key && actor && res.status < 300 && res.headers.get("content-type")?.includes("json")) {
        const clone = res.clone();
        await svc.store.putIdem(key, actor.userId, { status: res.status, body: await clone.json() }, svc.now());
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
