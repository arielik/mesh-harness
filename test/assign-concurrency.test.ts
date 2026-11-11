// MM-3 AC-36: offers under concurrency, two hubs on one store (a SQLite file always; Postgres when
// MESH_TEST_PG_URL is set — that leg is then required). Assign, accept, expiry and claim run in the
// hub's serialised goal transaction, so each decides from current state.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { sha256 } from "../src/auth/index.ts";
import { buildHubConfig, startHub, type HubConfig, type RunningHub } from "../src/hub/index.ts";
import type { LoginResult } from "../src/protocol/index.ts";
import { PG_URL, PgFixture } from "./helpers/pg.ts";

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- JSON responses in assertions
type Json = any;

const ROUNDS = 20;
const EXPIRY = 30 * 60_000;
const OFFERED_TO = (id: string, name: string) => `${id} is offered to ${name}`;
const NO_OPEN = (id: string) => `${id} has no open offer`;

const pgdb = new PgFixture();
const dirs: string[] = [];
const hubs: RunningHub[] = [];
let clock = 1_762_000_000_000;
afterEach(async () => {
  for (const h of hubs.splice(0)) await h.stop();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
afterAll(async () => {
  await pgdb.end();
});

function makeConfig(db: string): HubConfig {
  return buildHubConfig(
    {
      listen: "127.0.0.1:0",
      db,
      auth: { providers: [{ id: "team", kind: "token", users: ["alice", "bob", "carol"].map((n) => ({ name: n, token_sha256: sha256(`${n}-token-secret`) })) }] },
      thresholds: { offer_expiry: "30m" },
    },
    { baseDir: "/", env: {} },
  );
}

async function call(hub: RunningHub, method: string, path: string, token: string, body?: unknown): Promise<{ status: number; json: Json }> {
  const res = await fetch(hub.url + path, {
    method,
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const text = await res.text();
  let json: Json;
  try {
    json = text ? JSON.parse(text) : undefined;
  } catch {
    json = text;
  }
  return { status: res.status, json };
}

interface Rig {
  h1: RunningHub;
  h2: RunningHub;
  alice: LoginResult;
  bob: LoginResult;
  carol: LoginResult;
}

async function rig(db: string): Promise<Rig> {
  const h1 = await startHub(makeConfig(db), { tickMs: 0, now: () => clock });
  hubs.push(h1);
  const h2 = await startHub(makeConfig(db), { tickMs: 0, now: () => clock });
  hubs.push(h2);
  const login = async (name: string, host: string): Promise<LoginResult> =>
    (await call(h1, "POST", "/auth/team/login", "", { token: `${name}-token-secret`, hostname: host, install: `inst-${name}-0001` })).json;
  const alice = await login("alice", "alice-a1");
  const bob = await login("bob", "host-b");
  const carol = await login("carol", "carol-c");
  expect((await call(h1, "POST", `/v1/machines/${bob.machine}/name`, bob.token, { nickname: "m2" })).status).toBe(200);
  return { h1, h2, alice, bob, carol };
}

/** A fresh goal per round with one ready step; returns the step id. */
async function fresh(r: Rig): Promise<string> {
  const g = await call(r.h1, "POST", "/v1/goals", r.alice.token, { title: "Concurrent offers", primaryRepo: "svc" });
  expect(g.status).toBe(201);
  const p = await call(r.h2, "POST", `/v1/goals/${g.json.id}/plan`, r.alice.token, { steps: [{ id: "x", repo: "svc", kind: "implement", title: "x", brief: "b" }], approve: true });
  expect(p.status, JSON.stringify(p.json)).toBe(201);
  return `${g.json.id}.x`;
}

const eventsOf = async (r: Rig, type: string, step: string) => (await r.h1.svc.store.events(0, 100_000)).filter((e) => e.type === type && e.step === step);
const stepOf = async (r: Rig, id: string) => (await call(r.h2, "GET", `/v1/steps/${id}`, r.alice.token)).json.context.step;
const offerRows = async (r: Rig, id: string) => ((await call(r.h1, "GET", "/v1/inbox", r.bob.token)).json.messages as Json[]).filter((m) => m.kind === "offer" && m.data?.step === id);

async function sqliteDb(): Promise<string> {
  const d = mkdtempSync(join(tmpdir(), "mesh-assign-cc-"));
  dirs.push(d);
  return join(d, "hub.db");
}

const legs: [string, () => Promise<string>][] = [["sqlite file", sqliteDb]];
if (PG_URL) legs.push(["postgres", () => pgdb.fresh()]);

describe.each(legs)("AC-36 concurrency: two hubs on one store (%s)", (_name, db) => {
  it("test_AC36_assign_assign", async () => {
    const r = await rig(await db());
    // Positive control: sequentially, the second assign is refused.
    const s0 = await fresh(r);
    expect((await call(r.h1, "POST", `/v1/steps/${s0}/assign`, r.alice.token, { to: "bob/m2" })).status).toBe(200);
    expect((await call(r.h2, "POST", `/v1/steps/${s0}/assign`, r.alice.token, { to: "bob/m2" })).status).toBe(409);
    expect(await eventsOf(r, "step.offered", s0)).toHaveLength(1);
    for (let n = 1; n <= ROUNDS; n++) {
      const id = await fresh(r);
      const rs = await Promise.all([
        call(r.h1, "POST", `/v1/steps/${id}/assign`, r.alice.token, { to: "bob/m2" }),
        call(r.h2, "POST", `/v1/steps/${id}/assign`, r.alice.token, { to: "bob/m2", note: "second" }),
      ]);
      expect(rs.map((x) => x.status).sort(), `round ${n}: ${JSON.stringify(rs)}`).toEqual([200, 409]);
      expect(String(rs.find((x) => x.status === 409)?.json.error)).toContain("already offered");
      expect(await eventsOf(r, "step.offered", id), `round ${n}`).toHaveLength(1);
      expect(await offerRows(r, id), `round ${n}`).toHaveLength(1);
    }
  });

  it("test_AC36_assign_claim", async () => {
    const r = await rig(await db());
    for (let n = 0; n <= ROUNDS; n++) {
      const id = await fresh(r);
      const [a, c] =
        n === 0
          ? // Positive control: sequentially, the claim after the assign is guarded.
            [await call(r.h1, "POST", `/v1/steps/${id}/assign`, r.alice.token, { to: "bob/m2" }), await call(r.h2, "POST", `/v1/steps/${id}/claim`, r.carol.token, {})]
          : await Promise.all([call(r.h1, "POST", `/v1/steps/${id}/assign`, r.alice.token, { to: "bob/m2" }), call(r.h2, "POST", `/v1/steps/${id}/claim`, r.carol.token, {})]);
      const label = `round ${n}: assign ${JSON.stringify(a)} claim ${JSON.stringify(c)}`;
      const s = await stepOf(r, id);
      if (a.status === 200) {
        expect(c, label).toEqual({ status: 409, json: { error: OFFERED_TO(id, "m2") } });
        expect(s.offer, label).toMatchObject({ state: "offered" });
        expect(s.state, label).toBe("ready");
      } else {
        expect(a.status, label).toBe(409);
        expect(String(a.json.error), label).toMatch(/not ready$/);
        expect(c.status, label).toBe(200);
        expect(s.holderUser, label).toBe("carol");
        // A held step never carries a dangling open offer.
        expect(s.offer?.state, label).not.toBe("offered");
        expect(await eventsOf(r, "step.offered", id), label).toEqual([]);
      }
      if (n === 0) expect(a.status).toBe(200);
    }
  });

  it("test_AC36_expiry_accept", async () => {
    const r = await rig(await db());
    const sid = (n: number) => `s-bob-${n}`;
    for (let n = 0; n <= ROUNDS; n++) {
      const id = await fresh(r);
      const t0 = clock;
      expect((await call(r.h1, "POST", `/v1/steps/${id}/assign`, r.alice.token, { to: "bob/m2" })).status).toBe(200);
      clock = t0 + EXPIRY + 1;
      let acc: { status: number; json: Json };
      if (n === 0) {
        // Positive control: sequentially, the tick wins and the accept finds no open offer.
        await r.h1.svc.tick();
        acc = await call(r.h2, "POST", `/v1/steps/${id}/accept`, r.bob.token, { sid: sid(n) });
        expect(acc).toEqual({ status: 409, json: { error: NO_OPEN(id) } });
      } else {
        [, acc] = await Promise.all([r.h1.svc.tick(), call(r.h2, "POST", `/v1/steps/${id}/accept`, r.bob.token, { sid: sid(n) })]);
      }
      const expired = await eventsOf(r, "step.offer_expired", id);
      const accepted = await eventsOf(r, "step.accepted", id);
      const label = `round ${n}: accept ${JSON.stringify(acc)}`;
      expect(expired.length + accepted.length, label).toBe(1);
      const s = await stepOf(r, id);
      if (accepted.length) {
        expect(acc.status, label).toBe(200);
        expect(s.offer.state, label).toBe("accepted");
      } else {
        expect(acc, label).toEqual({ status: 409, json: { error: NO_OPEN(id) } });
        expect(s.offer.state, label).toBe("expired");
      }
      clock += 1;
    }
  });
});
