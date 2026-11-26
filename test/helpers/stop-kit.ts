// RL-26 test kit: the World cast of docs/specs/RL-26.md §Acceptance criteria. `ann` owns the goals,
// `apu` is an approver, `bob` a member with machine `bob-box`, `root` an admin, `dave` a member with
// no right; services `svc` (goals:read, goals:decide, sessions:stop, steps:assign, live:read) and
// `old` (goals:read, steps:assign, live:read). Machines are bare (a login and syncs).

import { expect } from "vitest";
import type { Session } from "../../src/protocol/index.ts";
import { Pk, T0, DAY, type Bare, type Json } from "./pulse-kit.ts";
import { Relay } from "./relay-kit.ts";

export const H = "x-mesh-on-behalf-of";
export const SVC_REPO = "git.example.com/org/svc";

export interface Cast {
  k: Pk;
  svc: string;
  old: string;
  ann: Bare;
  bob: Bare;
  root: Bare;
  dave: Bare;
}

export async function cast(o: { bob?: Bare["facts"] } = {}): Promise<Cast> {
  const r = await Relay.start(["ann", "apu", "bob", "dave", "root"], { admins: ["root"] });
  r.w.clock = T0 - DAY;
  const k = new Pk(r);
  for (const u of ["ann", "apu", "bob", "dave", "root"]) k.tok[u] = (await r.w.login(u, { hostname: `${u}-login` })).token;
  await r.w.hubStore.setUserRoles("apu", ["member", "approver"]);
  const svc = await r.w.hub.svc.serviceToken("svc", ["goals:read", "goals:decide", "sessions:stop", "steps:assign", "live:read"]);
  const old = await r.w.hub.svc.serviceToken("old", ["goals:read", "steps:assign", "live:read"]);
  const ann = await k.bare("ann", "ann-box", { repos: [SVC_REPO], headless: true, share: "all", runStop: true, remoteStop: true });
  await nick(k, ann, "box");
  const bob = await k.bare("bob", "bob-box", { repos: [SVC_REPO], accept: ["self", "user:ann"], share: "all", headless: true, runStop: true, ...o.bob });
  await nick(k, bob, "box");
  const root = await k.bare("root", "root-box", { repos: [SVC_REPO], headless: true, share: "all", runStop: true, remoteStop: true });
  await nick(k, root, "rbox");
  const dave = await k.bare("dave", "dave-box", { repos: [SVC_REPO], share: "all" });
  await nick(k, dave, "dbox");
  return { k, svc, old, ann, bob, root, dave };
}

export async function nick(k: Pk, m: Bare, nickname: string): Promise<void> {
  const r = await k.w.call(m.token, "POST", `/v1/machines/${m.machine}/name`, { nickname });
  expect(r.status, JSON.stringify(r.json)).toBe(200);
}

/** A goal of `owner` (default ann) in repo svc with these plan steps (approved). */
export async function goal(c: Cast, steps: Record<string, unknown>[] = [{ id: "a", mode: "headless" }, { id: "b" }], owner = "ann"): Promise<string> {
  return await c.k.r.goal(c.k.tok[owner] as string, steps as never);
}

/** A request with `token`, acting for `user` when given. */
export const as = (c: Cast, token: string, method: "GET" | "POST", path: string, body?: unknown, user?: string) =>
  c.k.w.call(token, method, path, body, user === undefined ? {} : { [H]: user });

/** An idle session in svc, as a daemon syncs it. */
export function idle(c: Cast, sid: string, o: Partial<Session> = {}): Session {
  return { ...c.k.idleSession(sid), repo: { id: SVC_REPO, name: "svc" }, ...o };
}

/**
 * The step `id` held by a headless run on `m` (default bob-box): ann offers it there (auto by
 * `user:ann`), the machine accepts it without a session and reports `run.started` with `runId`.
 */
export async function runOn(c: Cast, id: string, m: Bare = c.bob, runId = "run-1"): Promise<void> {
  const a = await c.k.call("ann", "POST", `/v1/steps/${id}/assign`, { to: m.machine });
  expect(a.status, JSON.stringify(a.json)).toBe(200);
  const acc = await c.k.w.call(m.token, "POST", `/v1/steps/${id}/accept`, {});
  expect(acc.status, JSON.stringify(acc.json)).toBe(200);
  const st = await c.k.w.call(m.token, "POST", `/v1/steps/${id}/run`, { state: "started", runId });
  expect(st.status, JSON.stringify(st.json)).toBe(200);
}

export const events = async (c: Cast, type: string, step?: string): Promise<Json[]> => (await c.k.r.allEvents()).filter((e) => e.type === type && (step === undefined || e.step === step));
export const messagesOf = async (c: Cast, m: Bare): Promise<Json[]> => c.k.inbox(m.token);
