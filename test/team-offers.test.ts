// RL-26: offers a service makes for a person to a teammate's machine that opted in (World, bare
// machines): GET /v1/machines?offers=team, the act-for assign to a teammate machine (never auto,
// never into a session, no launch-time override), decline and expiry, the unchanged own-token
// assign, features, OpenAPI and docs. Written from the spec's contracts (docs/specs/RL-26.md,
// AC-13 to AC-15, AC-17, AC-18).

import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { HUB_API, HUB_FEATURES, SERVICE_SCOPES } from "../src/protocol/index.ts";
import { as, cast, events, goal, idle, messagesOf, type Cast } from "./helpers/stop-kit.ts";
import type { Json } from "./helpers/pulse-kit.ts";

let c: Cast | undefined;
afterEach(async () => {
  await c?.k.stop();
  c = undefined;
});

const team = (c: Cast, token: string, user?: string, q = "?offers=team") => as(c, token, "GET", `/v1/machines${q}`, undefined, user);
const assignFor = (c: Cast, id: string, body: Record<string, unknown>, user = "ann") => as(c, c.svc, "POST", `/v1/steps/${id}/assign`, body, user);
const optIn = async (c: Cast) => {
  c.bob.facts.teamOffers = true;
  await c.k.sync(c.bob);
};

describe("AC-13 team machines", () => {
  it("test_AC13_lists_opted_in_teammate_machines", async () => {
    c = await cast();
    // ann's own machine opts in too: never listed for ann.
    c.ann.facts.teamOffers = true;
    await c.k.sync(c.ann);
    // A service account's machine that reports teamOffers is never listed.
    await c.k.w.hubStore.upsertMachine({ id: "m-5e4c1ce0", userId: "svc", hostname: "svc-host" }, c.k.w.clock);
    await c.k.w.hubStore.touchMachine("m-5e4c1ce0", c.k.w.clock, {}, { share: "all", teamOffers: true, headless: true });
    const ids = (r: { json: Json }) => (r.json.machines as Json[]).map((m) => m.id);
    expect(ids(await team(c, c.k.tok.ann as string))).toStrictEqual([]);
    expect(ids(await team(c, c.svc, "ann"))).toStrictEqual([]);
    await optIn(c);
    for (const r of [await team(c, c.k.tok.ann as string), await team(c, c.svc, "ann")]) {
      expect(r.status, JSON.stringify(r.json)).toBe(200);
      expect(r.json.machines).toStrictEqual([
        { id: c.bob.machine, name: "box", nickname: "box", owner: "bob", labels: [], online: true, lastSeen: c.k.w.clock, headless: true, repos: ["svc"] },
      ]);
    }
    // bob sees ann's machine (it opted in), never his own.
    expect(ids(await team(c, c.k.tok.bob as string))).toStrictEqual([c.ann.machine]);
    for (const q of ["", "?offers=mine"]) {
      const r = await team(c, c.k.tok.ann as string, undefined, q);
      expect([r.status, r.json.code], q).toStrictEqual([400, "bad-query"]);
    }
    const noHeader = await team(c, c.svc);
    expect([noHeader.status, noHeader.json.code]).toStrictEqual([400, "on-behalf-of-required"]);
  });
});

describe("AC-14 a team offer waits for the owner's accept", () => {
  it("test_AC14_team_offer_never_auto", async () => {
    c = await cast();
    await optIn(c);
    const G = await goal(c);
    const id = `${G}.b`;
    const r = await assignFor(c, id, { to: c.bob.machine, note: "please" });
    expect(r.status, JSON.stringify(r.json)).toBe(200);
    expect(r.json.auto).toBe(false);
    const st = await c.k.step(id);
    expect(st.offer).toMatchObject({ state: "offered", auto: false, team: true, via: "svc", by: "ann", to: { machine: c.bob.machine } });
    const [ev] = await events(c, "step.offered", id);
    expect(ev.payload).toMatchObject({ team: true, auto: false, via: "svc" });
    const msg = (await messagesOf(c, c.bob)).find((m: Json) => m.kind === "offer" && m.data?.step === id);
    expect(msg?.text).toMatch(/^MESH: @ann offers step \S+ "Title b" \(repo svc\) to this machine: please \(via svc, team offer\)$/);
    expect(msg?.data).toMatchObject({ auto: false, team: true, via: "svc" });
    const offers = await c.k.call("bob", "GET", "/v1/offers");
    expect((offers.json.offers as Json[]).find((o) => o.step === id)).toMatchObject({ team: true, via: "svc", auto: false });
    expect((await c.k.step(id)).state).toBe("ready");
    c.bob.facts.sessions = [idle(c, "bob-s1")];
    await c.k.sync(c.bob);
    const acc = await c.k.w.call(c.bob.token, "POST", `/v1/steps/${id}/accept`, { sid: "bob-s1" });
    expect(acc.status, JSON.stringify(acc.json)).toBe(200);
    expect(await c.k.step(id)).toMatchObject({ state: "claimed", holderUser: "bob", holderMachine: c.bob.machine });
  });
});

describe("AC-15 the team-offer refusals", () => {
  it("test_AC15_not_opted_in_session_override", async () => {
    c = await cast();
    const G = await goal(c, [{ id: "b" }, { id: "h", mode: "headless" }]);
    const id = `${G}.b`;
    const before = await assignFor(c, id, { to: c.bob.machine });
    expect(before).toStrictEqual({ status: 403, json: { error: `machine not yours: ${c.bob.machine}`, code: "machine-not-yours" } });
    c.bob.facts.sessions = [idle(c, "bob-s1")];
    await optIn(c);
    for (const to of ["bob/box/bob-s1", `${c.bob.machine}/bob-s1`]) {
      const r = await assignFor(c, id, { to });
      expect(r).toStrictEqual({ status: 403, json: { error: "a teammate's machine takes the offer, never one of their sessions: name box only", code: "team-offer-session" } });
    }
    for (const body of [{ mode: "headless", profile: "read-only" }, { profile: "read-only" }, { mode: "headless" }]) {
      const r = await assignFor(c, id, { to: "bob/box", ...body });
      expect(r, JSON.stringify(body)).toStrictEqual({ status: 403, json: { error: "machine not yours: bob/box", code: "team-offer-override" } });
    }
    expect((await c.k.step(id)).offer).toBeUndefined();
    // A step that declares headless is routed (a team offer, listed, not auto).
    const h = await assignFor(c, `${G}.h`, { to: "bob/box" });
    expect(h.status, JSON.stringify(h.json)).toBe(200);
    expect((await c.k.step(`${G}.h`)).offer).toMatchObject({ mode: "headless", team: true, auto: false });
    // A teammate machine that cannot run headless is refused as today.
    const D = await goal(c, [{ id: "h", mode: "headless" }]);
    c.dave.facts.teamOffers = true;
    await c.k.sync(c.dave);
    expect((await assignFor(c, `${D}.h`, { to: c.dave.machine })).json.code).toBe("headless-unsupported");
  });
});

describe("AC-17 decline and expiry", () => {
  it("test_AC17_decline_and_expiry", async () => {
    c = await cast();
    await optIn(c);
    const G = await goal(c);
    const id = `${G}.b`;
    expect((await assignFor(c, id, { to: c.bob.machine })).status).toBe(200);
    const d = await c.k.w.call(c.bob.token, "POST", `/v1/steps/${id}/decline`, { note: "busy" });
    expect(d.status, JSON.stringify(d.json)).toBe(200);
    expect(await events(c, "step.declined", id)).toHaveLength(1);
    const st = await c.k.step(id);
    expect([st.state, st.offer.state]).toStrictEqual(["ready", "declined"]);
    // Again, unanswered: it expires as any offer.
    expect((await assignFor(c, id, { to: c.bob.machine })).status).toBe(200);
    await c.k.tickAt(c.k.w.clock + c.k.w.hubConfig.thresholds.offerExpiryMs + 1, c.bob);
    expect((await c.k.step(id)).offer.state).toBe("expired");
    expect(await events(c, "step.offer_expired", id)).toHaveLength(1);
  });
});

describe("AC-18 compatibility, features, schema and docs", () => {
  it("test_AC18_own_token_unchanged_and_docs", async () => {
    c = await cast();
    const G = await goal(c);
    // ann's own token: MM-3 unchanged (bob's rule user:ann auto-accepts; no teamOffers needed).
    const own = await c.k.call("ann", "POST", `/v1/steps/${G}.b/assign`, { to: c.bob.machine });
    expect(own.status, JSON.stringify(own.json)).toBe(200);
    expect(own.json.auto).toBe(true);
    expect((await c.k.step(`${G}.b`)).offer).not.toHaveProperty("team");
    const features = (await c.k.w.call(undefined, "GET", "/healthz")).json.features as string[];
    for (const f of ["run-stop", "session-stop", "team-offers"]) {
      expect(features, f).toContain(f);
      expect(HUB_FEATURES, f).toContain(f);
    }
    expect(SERVICE_SCOPES).toContain("sessions:stop");
    expect(SERVICE_SCOPES).toContain("goals:decide");
    const rows: [string, string, string][] = [
      ["POST", "/v1/steps/:id/stop-run", "goals:decide"],
      ["POST", "/v1/sessions/:sid/stop", "sessions:stop"],
      ["GET", "/v1/machines", "live:read"],
    ];
    const doc = JSON.parse(readFileSync("schemas/hub-api.openapi.json", "utf8")) as Json;
    for (const [method, path, scope] of rows) {
      const row = HUB_API.find((x) => x.method === method && x.path === path);
      expect(row?.scope, path).toBe(scope);
      expect(row?.onBehalfOf, path).toBe(true);
      const op = JSON.stringify(doc.paths[path.replace(/:([a-zA-Z]+)/g, "{$1}")][method.toLowerCase()]);
      expect(op, path).toContain("x-mesh-on-behalf-of");
      expect(op, path).toContain(scope);
    }
    expect(HUB_API.find((x) => x.path === "/v1/machines")?.onBehalfOfRequired).toBe(true);
    const auth = readFileSync("docs/guide/auth.md", "utf8");
    for (const t of ["sessions:stop", "/v1/steps/:id/stop-run", "/v1/sessions/:sid/stop", "/v1/machines?offers=team", "not-approver", "not-allowed", "stop-refused", "team-offer-session", "team-offer-override"]) expect(auth, t).toContain(t);
    const ops = readFileSync("docs/guide/operations.md", "utf8");
    for (const t of ["remoteStop", "teamOffers", "run-stop", "session-stop", "team-offers", "offerExpiryMs"]) expect(ops, t).toContain(t);
    const concepts = readFileSync("docs/guide/concepts.md", "utf8");
    for (const t of ["team offer", "teamOffers", "mesh accept"]) expect(concepts, t).toContain(t);
    const ev = readFileSync("docs/events.md", "utf8");
    for (const t of ["run.stop_requested", "run.stopped", "session.stop_requested", "session.stopped", "machine.consent_changed", "killed_operator"]) expect(ev, t).toContain(t);
  });
});
