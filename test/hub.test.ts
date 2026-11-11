import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { pkceChallenge, pkceVerifier, sha256 } from "../src/auth/index.ts";
import { buildHubConfig, startHub, type HubConfig, type RunningHub } from "../src/hub/index.ts";
import { createApp } from "../src/hub/app.ts";
import type { LoginResult, Session } from "../src/protocol/index.ts";
import { HubStore } from "../src/store/index.ts";
import { MockOidc } from "./fixtures/mock-oidc.ts";

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- JSON responses in assertions
type Json = any;

const TOKENS = { alice: "alice-secret-token", bob: "bob-secret-token", root: "root-secret-token", carol: "carol-secret-token" };
const mock = new MockOidc();
let hub: RunningHub;
let clock = 1_000_000_000;
let config: HubConfig;

function makeConfig(): HubConfig {
  return buildHubConfig(
    {
      listen: "127.0.0.1:0",
      db: ":memory:",
      auth: {
        providers: [
          {
            id: "team",
            kind: "token",
            users: [
              { name: "alice", token_sha256: sha256(TOKENS.alice) },
              { name: "bob", token_sha256: sha256(TOKENS.bob) },
              { name: "carol", token_sha256: sha256(TOKENS.carol), groups: ["approvers"] },
              { name: "root", token_sha256: sha256(TOKENS.root) },
            ],
            roles: { approver: ["approvers"] },
          },
          { id: "kanidm", kind: "oidc", preset: "kanidm", issuer: mock.issuer, client_id: "mesh", allow_insecure: true, roles: { approver: ["mesh-approvers"] } },
        ],
        bootstrap_admins: ["team:root"],
      },
      thresholds: { takeover_after: "4h", pause_grace: "2m", machine_offline: "15m" },
    },
    { baseDir: "/", env: {} },
  );
}

beforeAll(() => mock.start());
afterAll(() => mock.stop());
beforeEach(async () => {
  clock = 1_000_000_000;
  config = makeConfig();
  hub = await startHub(config, { store: await HubStore.open(":memory:"), tickMs: 0, now: () => clock });
});
afterEach(async () => {
  await hub.stop();
});

async function call(method: string, path: string, token?: string, body?: unknown, headers: Record<string, string> = {}): Promise<{ status: number; json: Json; res: Response }> {
  const res = await fetch(hub.url + path, {
    method,
    redirect: "manual",
    headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const text = await res.text();
  let json: Json;
  try {
    json = text ? JSON.parse(text) : undefined;
  } catch {
    json = text;
  }
  return { status: res.status, json, res };
}

async function login(name: keyof typeof TOKENS, hostname = `${name}-laptop`): Promise<LoginResult> {
  const r = await call("POST", "/auth/team/login", undefined, { token: TOKENS[name], hostname });
  expect(r.status).toBe(200);
  return r.json;
}

const plan = {
  design_ref: "frr@design/g1:docs/design/g1.md",
  steps: [
    { id: "proto", repo: "proto-defs", kind: "implement", title: "proto", brief: "add fields" },
    { id: "agent", repo: "vpc-node-agent", kind: "implement", title: "agent", brief: "use fields", deps: ["proto"] },
    { id: "dplane", repo: "frr-dplane-ovs", kind: "implement", title: "dplane", brief: "program", deps: ["proto"] },
    { id: "test", repo: "frr-dplane-ovs", kind: "test", title: "test", brief: "test dplane", deps: ["dplane"] },
  ],
};

async function goalWithPlan(owner: LoginResult) {
  const g = await call("POST", "/v1/goals", owner.token, { title: "IPv6 underlay", primaryRepo: "frr-dplane-ovs" });
  expect(g.status).toBe(201);
  const p = await call("POST", `/v1/goals/${g.json.id}/plan`, owner.token, { ...plan, approve: true });
  expect(p.status).toBe(201);
  return g.json.id as string;
}

const session = (sid: string, over: Partial<Session> = {}): Session => ({
  sid,
  claudeSessionIds: [`c-${sid}`],
  cwd: "/w",
  kind: "interactive",
  state: "working",
  quiet: false,
  startedAt: clock,
  lastEventAt: clock,
  turns: 1,
  humanPrompts: 1,
  seenByReconciler: true,
  ...over,
});

describe("authorization", () => {
  it("every route declares a rule, and non-public routes refuse anonymous calls", async () => {
    const { routes } = createApp(hub.svc);
    expect(routes.length).toBeGreaterThan(25);
    for (const r of routes) {
      expect(["public", "member", "admin", "events"]).toContain(r.rule);
      if (r.rule === "public" || r.path === "/v1/stream") continue;
      const path = r.path.replace(/:id/g, "G1.x");
      const res = await call(r.method, path, undefined, r.method === "POST" ? {} : undefined);
      expect(res.status, `${r.method} ${r.path}`).toBe(401);
    }
  });

  it("admin and events routes refuse members; service tokens read events only", async () => {
    const alice = await login("alice");
    expect((await call("GET", "/v1/admin/users", alice.token)).status).toBe(403);
    expect((await call("GET", "/v1/events", alice.token)).status).toBe(403);
    const svcToken = await hub.svc.serviceToken("mesh-ai");
    expect((await call("GET", "/v1/events?after=0", svcToken)).status).toBe(200);
    expect((await call("GET", "/v1/goals", svcToken)).status).toBe(403);
    const root = await login("root");
    expect(root.user.roles).toContain("admin");
    expect((await call("GET", "/v1/admin/users", root.token)).status).toBe(200);
  });
});

describe("service token scopes", () => {
  it("open exactly the scoped member routes; a created goal is owned by the service account", async () => {
    const reader = await hub.svc.serviceToken("viewer", ["goals:read", "live:read"]);
    expect((await call("GET", "/v1/goals", reader)).status).toBe(200);
    expect((await call("GET", "/v1/steps", reader)).status).toBe(200);
    expect((await call("GET", "/v1/live", reader)).status).toBe(200);
    expect((await call("GET", "/v1/events?after=0", reader)).status).toBe(200);
    expect((await call("POST", "/v1/goals", reader, { title: "nope" })).status).toBe(403);
    expect((await call("GET", "/v1/attention", reader)).status).toBe(403);

    const writer = await hub.svc.serviceToken("mesh-ai", ["goals:write", "goals:read"]);
    const created = await call("POST", "/v1/goals", writer, { title: "From the trunk", refs: { trunk: "item-1" } });
    expect(created.status).toBe(201);
    const id = (created.json as { id: string }).id;
    expect((await call("GET", `/v1/goals/${id}`, writer)).json).toMatchObject({ goal: { title: "From the trunk", ownerId: "mesh-ai", refs: { trunk: "item-1" } } });
    expect((await call("POST", `/v1/goals/${id}/approve`, writer, {})).status).toBe(403);
    expect((await call("GET", "/v1/live", writer)).status).toBe(403);
  });
});

describe("token login", () => {
  it("issues a device token bound to a machine; logout revokes it", async () => {
    const a = await login("alice");
    expect(a.token).toMatch(/^mh_d_/);
    expect(a.machine).toMatch(/^m-/);
    const me = await call("GET", "/v1/me", a.token);
    expect(me.json).toMatchObject({ user: { id: "alice", roles: ["member"] }, machine: a.machine });
    expect((await login("alice")).machine).toBe(a.machine); // same host → same machine
    await call("POST", "/auth/logout", a.token);
    expect((await call("GET", "/v1/me", a.token)).status).toBe(401);
  });

  it("rejects a wrong token and lists providers", async () => {
    expect((await call("POST", "/auth/team/login", undefined, { token: "nope" })).status).toBe(401);
    const p = await call("GET", "/auth/providers");
    expect(p.json.providers.map((x: Json) => [x.id, x.kind])).toEqual([
      ["team", "token"],
      ["kanidm", "oidc"],
    ]);
  });

  it("expires device tokens after the idle window", async () => {
    const a = await login("alice");
    clock += 8 * 24 * 3_600_000;
    expect((await call("GET", "/v1/me", a.token)).status).toBe(401);
  });
});

describe("web sessions", () => {
  it("sets an HttpOnly cookie and refuses cross-origin writes", async () => {
    const r = await call("POST", "/auth/team/login", undefined, { token: TOKENS.alice, client: "web" });
    const cookie = r.res.headers.get("set-cookie") ?? "";
    expect(cookie).toMatch(/mesh_session=mh_w_/);
    expect(cookie).toMatch(/HttpOnly/i);
    const jar = { cookie: cookie.split(";")[0] as string };
    expect((await call("GET", "/v1/me", undefined, undefined, jar)).json.user.id).toBe("alice");
    expect((await call("POST", "/v1/goals", undefined, { title: "x" }, { ...jar, origin: "http://evil.example" })).status).toBe(403);
    expect((await call("POST", "/v1/goals", undefined, { title: "x" }, { ...jar, origin: new URL(hub.url).origin })).status).toBe(201);
  });
});

describe("OIDC through the hub (task 2.8)", () => {
  it("CLI login: redirect → IdP → hub callback → localhost code → exchange with the CLI's PKCE", async () => {
    const verifier = pkceVerifier();
    const start = await call("GET", `/auth/kanidm/start?client=cli&cli_port=45678&cli_challenge=${pkceChallenge(verifier)}&hostname=dev-01`);
    expect(start.status).toBe(302);
    const idp = await fetch(start.res.headers.get("location") as string, { redirect: "manual" });
    const cb = await fetch(idp.headers.get("location") as string, { redirect: "manual" });
    const local = new URL(cb.headers.get("location") as string);
    expect(local.origin).toBe("http://127.0.0.1:45678");
    const code = local.searchParams.get("code") as string;
    expect((await call("POST", "/auth/cli/exchange", undefined, { code, verifier: pkceVerifier() })).status).toBe(401);
    // A failed exchange burns the code.
    expect((await call("POST", "/auth/cli/exchange", undefined, { code, verifier })).status).toBe(401);
  });

  it("CLI login succeeds with the right verifier; Kanidm groups map to roles", async () => {
    const verifier = pkceVerifier();
    const start = await call("GET", `/auth/kanidm/start?client=cli&cli_port=45678&cli_challenge=${pkceChallenge(verifier)}&hostname=dev-01`);
    const idp = await fetch(start.res.headers.get("location") as string, { redirect: "manual" });
    const cb = await fetch(idp.headers.get("location") as string, { redirect: "manual" });
    const code = new URL(cb.headers.get("location") as string).searchParams.get("code") as string;
    const r = await call("POST", "/auth/cli/exchange", undefined, { code, verifier });
    expect(r.status).toBe(200);
    expect(r.json.user).toMatchObject({ id: "alice", roles: ["member", "approver"] });
    expect(r.json.machine).toMatch(/^m-/);
  });

  it("web login: the callback sets the session cookie", async () => {
    const start = await call("GET", "/auth/kanidm/start?client=web");
    const idp = await fetch(start.res.headers.get("location") as string, { redirect: "manual" });
    const cb = await fetch(idp.headers.get("location") as string, { redirect: "manual" });
    expect(cb.headers.get("location")).toBe("/");
    expect(cb.headers.get("set-cookie")).toMatch(/mesh_session=mh_w_/);
  });

  it("device login through the hub", async () => {
    const start = await call("POST", "/auth/kanidm/device", undefined, { hostname: "box" });
    expect(start.status).toBe(200);
    expect(start.json.state).toBeUndefined(); // the device code stays on the hub
    expect((await call("POST", "/auth/kanidm/device/poll", undefined, { pollId: start.json.pollId })).status).toBe(202);
    mock.approveDevice(start.json.userCode);
    let r = { status: 202, json: {} as Json };
    for (let i = 0; i < 40 && r.status === 202; i++) {
      await new Promise((ok) => setTimeout(ok, 150));
      r = await call("POST", "/auth/kanidm/device/poll", undefined, { pollId: start.json.pollId, hostname: "box" });
    }
    expect(r.status).toBe(200);
    expect(r.json.token).toMatch(/^mh_d_/);
  });
});

describe("goals, plans and steps", () => {
  it("creates a goal with a ready design step", async () => {
    const alice = await login("alice");
    const g = await call("POST", "/v1/goals", alice.token, { title: "IPv6 underlay", primaryRepo: "frr-dplane-ovs" });
    expect(g.json).toMatchObject({ id: "G1", state: "backlog", ownerId: "alice" });
    const d = await call("GET", "/v1/goals/G1", alice.token);
    expect(d.json.steps).toEqual([expect.objectContaining({ id: "G1.design", state: "ready", kind: "design" })]);
  });

  it("returns fixable plan errors", async () => {
    const alice = await login("alice");
    await call("POST", "/v1/goals", alice.token, { title: "x" });
    const r = await call("POST", "/v1/goals/G1/plan", alice.token, { steps: [{ id: "a", repo: "r", kind: "implement", title: "a", brief: "b", deps: ["agnt"] }] });
    expect(r.status).toBe(422);
    expect(r.json.details).toEqual(['step "a": dep "agnt" not found']);
  });

  it("only owners, approvers and admins approve", async () => {
    const alice = await login("alice");
    const bob = await login("bob");
    const carol = await login("carol");
    await call("POST", "/v1/goals", alice.token, { title: "x" });
    await call("POST", "/v1/goals/G1/plan", bob.token, plan);
    expect((await call("POST", "/v1/goals/G1/approve", bob.token, {})).status).toBe(403);
    const ok = await call("POST", "/v1/goals/G1/approve", carol.token, {});
    expect(ok.status).toBe(200);
    expect(ok.json.goal.state).toBe("in_progress");
    const states = Object.fromEntries(ok.json.steps.map((s: Json) => [s.id, s.state]));
    expect(states).toEqual({ "G1.design": "done", "G1.proto": "ready", "G1.agent": "blocked", "G1.dplane": "blocked", "G1.test": "blocked" });
  });

  it("parallel claims have exactly one winner", async () => {
    const alice = await login("alice");
    const bob = await login("bob");
    const id = await goalWithPlan(alice);
    const results = await Promise.all([call("POST", `/v1/steps/${id}.proto/claim`, alice.token, {}), call("POST", `/v1/steps/${id}.proto/claim`, bob.token, {})]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
  });

  it("runs a fix cycle: a failing test reopens its dependency", async () => {
    const alice = await login("alice");
    const id = await goalWithPlan(alice);
    for (const s of ["proto", "dplane"]) {
      expect((await call("POST", `/v1/steps/${id}.${s}/claim`, alice.token, {})).status).toBe(200);
      expect((await call("POST", `/v1/steps/${id}.${s}/done`, alice.token, { summary: `${s} done` })).status).toBe(200);
    }
    await call("POST", `/v1/steps/${id}.test/claim`, alice.token, {});
    const fail = await call("POST", `/v1/steps/${id}.test/done`, alice.token, { summary: "ND proxy flag lost on restart", outcome: "fail", reopen: ["dplane"] });
    expect(fail.status).toBe(200);
    expect(fail.json.reopened).toEqual([`${id}.dplane`]);
    const ctx = await call("GET", `/v1/steps/${id}.dplane/context`, alice.token);
    expect(ctx.json.step).toMatchObject({ state: "ready", fixCycles: 1 });
    expect(ctx.json.notes[0].text).toContain("Reopened by");
    const t = await call("GET", `/v1/steps/${id}.test/context`, alice.token);
    expect(t.json.step.state).toBe("blocked");
    expect(t.json.deps.map((d: Json) => d.id)).toEqual([`${id}.dplane`]);
  });

  it("applies a retried done once (idempotency key)", async () => {
    const alice = await login("alice");
    const id = await goalWithPlan(alice);
    await call("POST", `/v1/steps/${id}.proto/claim`, alice.token, {});
    const h = { "idempotency-key": "k-123" };
    const a = await call("POST", `/v1/steps/${id}.proto/done`, alice.token, { summary: "ok" }, h);
    const b = await call("POST", `/v1/steps/${id}.proto/done`, alice.token, { summary: "ok" }, h);
    expect(a.status).toBe(200);
    expect(b.json).toEqual(a.json);
    const c = await call("POST", `/v1/steps/${id}.proto/done`, alice.token, { summary: "ok" });
    expect(c.status).toBe(409);
  });

  it("completes the goal when every step is done", async () => {
    const alice = await login("alice");
    const id = await goalWithPlan(alice);
    let last: Json;
    for (const s of ["proto", "agent", "dplane", "test"]) {
      await call("POST", `/v1/steps/${id}.${s}/claim`, alice.token, {});
      last = (await call("POST", `/v1/steps/${id}.${s}/done`, alice.token, { summary: "ok" })).json;
    }
    expect(last.goalDone).toBe(true);
    expect(last.reopened).toEqual([]);
    expect((await hub.svc.store.events(0, 1000)).filter((e) => e.type === "step.reopened")).toEqual([]);
    expect((await call("GET", `/v1/goals/${id}`, alice.token)).json.goal.state).toBe("done");
  });

  it("filters ready steps by repo", async () => {
    const alice = await login("alice");
    const id = await goalWithPlan(alice);
    await call("POST", `/v1/steps/${id}.proto/claim`, alice.token, {});
    await call("POST", `/v1/steps/${id}.proto/done`, alice.token, { summary: "ok" });
    const r = await call("GET", "/v1/steps?ready=1&repo=gitlab.lab/vpc/frr-dplane-ovs", alice.token);
    expect(r.json.steps.map((s: Json) => s.id)).toEqual([`${id}.dplane`]);
  });
});

describe("sync, pause, take-over, messages", () => {
  it("deduplicates replayed events and never overwrites another user's session", async () => {
    const alice = await login("alice");
    const bob = await login("bob");
    const ev = { id: "4f1c2f39-6a8b-4c55-9a0a-1d2b3c4d5e6f", at: clock, type: "session.turn_started", sid: "s1", payload: {} };
    expect((await call("POST", "/v1/sync", alice.token, { events: [ev], sessions: [session("s1")], counts: { working: 1 } })).json.accepted).toBe(1);
    expect((await call("POST", "/v1/sync", alice.token, { events: [ev], sessions: [], counts: {} })).json.accepted).toBe(0);
    await call("POST", "/v1/sync", bob.token, { sessions: [session("s1", { state: "idle", cwd: "/bob" })] });
    expect((await hub.svc.store.getSession("s1"))?.session.cwd).toBe("/w");
    const live = await call("GET", "/v1/live", alice.token);
    const me = live.json.people.find((p: Json) => p.user.id === "alice");
    expect(me.online).toBe(true);
    expect(me.machines[0].counts).toEqual({});
  });

  it("pauses a step when its holder's session ended, then allows take-over after 4h", async () => {
    const alice = await login("alice");
    const bob = await login("bob");
    const id = await goalWithPlan(alice);
    await call("POST", "/v1/sync", alice.token, { sessions: [session("s1", { step: `${id}.proto` })] });
    await call("POST", `/v1/steps/${id}.proto/claim`, alice.token, { sid: "s1" });
    expect((await call("POST", `/v1/steps/${id}.proto/take`, bob.token, {})).status).toBe(409);
    await call("POST", "/v1/sync", alice.token, { sessions: [session("s1", { step: `${id}.proto`, state: "ended", endedAt: clock, endedReason: "prompt_input_exit" })] });
    clock += 3 * 60_000;
    await hub.svc.tick();
    expect((await hub.svc.store.getStep(`${id}.proto`))?.state).toBe("paused");
    expect((await call("POST", `/v1/steps/${id}.proto/take`, bob.token, {})).json.error).toMatch(/can be taken over in/);
    clock += 4 * 3_600_000;
    const t = await call("POST", `/v1/steps/${id}.proto/take`, bob.token, {});
    expect(t.json).toMatchObject({ state: "claimed", holderUser: "bob" });
  });

  it("pauses when the holder's machine goes offline", async () => {
    const alice = await login("alice");
    const id = await goalWithPlan(alice);
    await call("POST", `/v1/steps/${id}.proto/claim`, alice.token, {});
    clock += 16 * 60_000;
    await hub.svc.tick();
    expect((await hub.svc.store.getStep(`${id}.proto`))?.state).toBe("paused");
  });

  it("routes messages to the session's machine inbox, wakes it over SSE, and acks", async () => {
    const alice = await login("alice");
    const bob = await login("bob");
    // MM-1: another person reaches a session without a step only on a machine that shares it with the team.
    await call("POST", "/v1/sync", alice.token, { sessions: [session("s1")], machine: { share: "all" } });
    const ctrl = new AbortController();
    const stream = await fetch(`${hub.url}/v1/stream`, { headers: { authorization: `Bearer ${alice.token}` }, signal: ctrl.signal });
    const reader = (stream.body as ReadableStream<Uint8Array>).getReader();
    let seen = "";
    const woke = (async () => {
      while (!seen.includes("event: wake")) {
        const { value, done } = await reader.read();
        if (done) break;
        seen += new TextDecoder().decode(value);
      }
    })();
    await new Promise((ok) => setTimeout(ok, 50));
    const said = await call("POST", "/v1/messages", bob.token, { toSid: "s1", text: "please rebase" });
    expect(said.status).toBe(201);
    await woke;
    ctrl.abort();
    const inbox = await call("GET", "/v1/inbox", alice.token);
    expect(inbox.json.messages).toEqual([expect.objectContaining({ toSid: "s1", text: "please rebase", fromUser: "bob" })]);
    expect((await call("GET", "/v1/inbox", bob.token)).json.messages).toEqual([]);
    await call("POST", `/v1/inbox/${said.json.id}/ack`, alice.token, { state: "delivered", method: "paste" });
    expect((await call("GET", "/v1/inbox", alice.token)).json.messages).toEqual([]);
  });

  it("questions reach the owner's attention and answers go back to the session", async () => {
    const alice = await login("alice");
    const bob = await login("bob");
    const id = await goalWithPlan(alice);
    await call("POST", "/v1/sync", bob.token, { sessions: [session("sb")] });
    await call("POST", `/v1/steps/${id}.proto/claim`, bob.token, { sid: "sb" });
    const q = await call("POST", "/v1/questions", bob.token, { text: "keep v4 fallback?", sid: "sb", step: `${id}.proto` });
    const att = await call("GET", "/v1/attention", alice.token);
    expect(att.json.attention).toEqual([expect.objectContaining({ kind: "question", question: q.json.id })]);
    await call("POST", `/v1/questions/${q.json.id}/answer`, alice.token, { text: "yes" });
    const inbox = await call("GET", "/v1/inbox", bob.token);
    expect(inbox.json.messages[0].text).toContain("yes");
  });

  it("shows designs awaiting approval to approvers", async () => {
    const alice = await login("alice");
    const carol = await login("carol");
    await call("POST", "/v1/goals", alice.token, { title: "x" });
    await call("POST", "/v1/goals/G1/plan", alice.token, plan);
    expect((await call("GET", "/v1/attention", carol.token)).json.attention[0]).toMatchObject({ kind: "approval", goal: "G1" });
  });
});

describe("config", () => {
  it("refuses the none provider off loopback", () => {
    expect(() => buildHubConfig({ listen: "0.0.0.0:7700", auth: { providers: [{ kind: "none" }] } }, { baseDir: "/", env: {} })).toThrow(/loopback/);
  });

  it("parses durations and requires OIDC secrets from the environment", () => {
    const raw = { auth: { providers: [{ id: "k", kind: "oidc", issuer: "https://idm.lab/oauth2/openid/mesh", client_id: "mesh", client_secret_env: "K_SECRET" }] } };
    expect(() => buildHubConfig(raw, { baseDir: "/", env: {} })).toThrow(/K_SECRET/);
    const c = buildHubConfig({ ...raw, thresholds: { takeover_after: "90m" } }, { baseDir: "/srv", env: { K_SECRET: "s" } });
    expect(c.thresholds.takeoverAfterMs).toBe(90 * 60_000);
    expect(c.db).toBe("/srv/mesh-hub.db");
  });

  it("takes db as a SQLite path or a postgres:// URL, and MESH_HUB_DB overrides it", () => {
    const raw = { auth: { providers: [{ kind: "none" }] } };
    const at = (db: string | undefined, env: Record<string, string> = {}) => buildHubConfig({ ...raw, ...(db ? { db } : {}) }, { baseDir: "/srv", env }).db;
    expect(at("data/hub.db")).toBe("/srv/data/hub.db");
    expect(at("postgres://mesh:pw@db.example.com:5432/mesh")).toBe("postgres://mesh:pw@db.example.com:5432/mesh");
    expect(at("data/hub.db", { MESH_HUB_DB: "postgresql://db.example.com/mesh" })).toBe("postgresql://db.example.com/mesh");
    expect(at(undefined, { MESH_HUB_DB: "/var/lib/mesh/hub.db" })).toBe("/var/lib/mesh/hub.db");
  });
});

describe("goal topics", () => {
  const ids = (r: { json: Json }) => (r.json.goals as { id: string }[]).map((g) => g.id);

  it("define topics, tag goals, and list goals that carry every topic asked for", async () => {
    const alice = await login("alice");
    const bob = await login("bob");
    expect((await call("POST", "/v1/topics", alice.token, { name: "Dataplane", description: "packets" })).status).toBe(201);
    expect((await call("POST", "/v1/topics", alice.token, { name: "performance" })).status).toBe(201);
    expect((await call("POST", "/v1/topics", bob.token, { name: "dataplane" })).status).toBe(409);
    expect((await call("POST", "/v1/topics", bob.token, { name: "all" })).status).toBe(409);
    expect((await call("POST", "/v1/topics", bob.token, { name: "has space" })).status).toBe(400);

    const g1 = await call("POST", "/v1/goals", alice.token, { title: "fast path", topics: ["dataplane", "PERFORMANCE", "all"] });
    expect(g1.status).toBe(201);
    expect(g1.json.topics).toEqual(["dataplane", "performance"]);
    const g2 = await call("POST", "/v1/goals", alice.token, { title: "dplane refactor", topics: ["dataplane"] });
    const g3 = await call("POST", "/v1/goals", alice.token, { title: "docs" });
    expect(g3.json.topics).toBeUndefined();
    expect((await call("POST", "/v1/goals", alice.token, { title: "typo", topics: ["dataplan"] })).status).toBe(400);

    expect(ids(await call("GET", "/v1/goals", alice.token))).toEqual([g1.json.id, g2.json.id, g3.json.id]);
    expect(ids(await call("GET", "/v1/goals?topic=all", alice.token))).toHaveLength(3);
    expect(ids(await call("GET", "/v1/goals?topic=dataplane", alice.token))).toEqual([g1.json.id, g2.json.id]);
    expect(ids(await call("GET", "/v1/goals?topic=dataplane&topic=performance", alice.token))).toEqual([g1.json.id]);
    expect(ids(await call("GET", "/v1/goals?topic=dataplane,performance", alice.token))).toEqual([g1.json.id]);
    expect((await call("GET", "/v1/goals?topic=nope", alice.token)).status).toBe(400);

    // Any member tags and untags; the goal's topics stay sorted and unique.
    const t = await call("POST", `/v1/goals/${g3.json.id}/topics`, bob.token, { add: ["performance", "dataplane"] });
    expect(t.status).toBe(200);
    expect(t.json.topics).toEqual(["dataplane", "performance"]);
    const u = await call("POST", `/v1/goals/${g3.json.id}/topics`, bob.token, { remove: ["dataplane", "performance"] });
    expect(u.json.topics).toBeUndefined();
    expect((await call("POST", `/v1/goals/${g3.json.id}/topics`, bob.token, {})).status).toBe(400);

    const topics = (await call("GET", "/v1/topics", bob.token)).json.topics;
    expect(topics).toEqual([
      { name: "all", description: "every goal", goals: 3 },
      expect.objectContaining({ name: "dataplane", description: "packets", createdBy: "alice", goals: 2 }),
      expect.objectContaining({ name: "performance", createdBy: "alice", goals: 1 }),
    ]);

    const live = (await call("GET", "/v1/live?topic=performance", alice.token)).json;
    expect(live.goals.map((g: Json) => [g.id, g.topics])).toEqual([[g1.json.id, ["dataplane", "performance"]]]);

    const events = (await call("GET", "/v1/live", alice.token)).json.activity.map((e: Json) => e.text);
    expect(events).toContain("defined topic dataplane");
    expect(events).toContain(`tagged ${g3.json.id} dataplane, performance`);
  });

  it("only the creator or an admin deletes a topic, which untags its goals", async () => {
    const alice = await login("alice");
    const bob = await login("bob");
    const root = await login("root");
    await call("POST", "/v1/topics", alice.token, { name: "dataplane" });
    const g = await call("POST", "/v1/goals", alice.token, { title: "x", topics: ["dataplane"] });
    expect((await call("POST", "/v1/topics/dataplane/delete", bob.token)).status).toBe(403);
    expect((await call("POST", "/v1/topics/all/delete", root.token)).status).toBe(409);
    const d = await call("POST", "/v1/topics/dataplane/delete", root.token);
    expect(d.json).toEqual({ name: "dataplane", goals: [g.json.id] });
    expect((await call("GET", `/v1/goals/${g.json.id}`, alice.token)).json.goal.topics).toBeUndefined();
    expect((await call("POST", "/v1/topics/dataplane/delete", alice.token)).status).toBe(404);
  });

  it("service tokens: goals:read lists topics, goals:write defines and tags", async () => {
    const reader = await hub.svc.serviceToken("viewer", ["goals:read"]);
    const writer = await hub.svc.serviceToken("mesh-ai", ["goals:read", "goals:write"]);
    expect((await call("GET", "/v1/topics", reader)).status).toBe(200);
    expect((await call("POST", "/v1/topics", reader, { name: "x" })).status).toBe(403);
    expect((await call("POST", "/v1/topics", writer, { name: "x" })).status).toBe(201);
    const g = await call("POST", "/v1/goals", writer, { title: "from a service", topics: ["x"] });
    expect(g.status).toBe(201);
    expect((await call("POST", `/v1/goals/${g.json.id}/topics`, writer, { remove: ["x"] })).status).toBe(200);
    expect((await call("GET", "/v1/goals?topic=x", reader)).json.goals).toEqual([]);
  });
});
