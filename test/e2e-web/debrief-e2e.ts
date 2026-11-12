// RL-4 e2e helper (not a spec): a debrief made through the hub API for the Playwright specs. The e2e
// hub is shared across spec files, so every goal and repo here is unique per call, debriefs are
// assigned to dave (never alice, whose Mine page must stay empty for test_AC32_empty, nor carol, who
// must have no machines for mine.spec's test_AC23_no_machines_text), steps are
// found by `data-step` and items by `data-fp`, never counted.

import { createHash } from "node:crypto";
import { expect, type APIRequestContext } from "@playwright/test";

const B32 = "abcdefghijklmnopqrstuvwxyz234567";
function base32(buf: Buffer): string {
  let bits = 0;
  let v = 0;
  let out = "";
  for (const b of buf) {
    v = (v << 8) | b;
    bits += 8;
    while (bits >= 5) {
      out += B32[(v >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += B32[(v << (5 - bits)) & 31];
  return out;
}
/** The documented fingerprint of a normalised key (RL-2). */
export const fp = (rule: string, path = "", symbol = "") => base32(createHash("sha256").update(`${rule}\n${path}\n${symbol}`, "utf8").digest()).slice(0, 16);

export const A = fp("r.alpha", "src/a.ts", "fa");
export const A2 = fp("r.alpha", "src/a.ts", "fb");
export const B = fp("r.beta", "src/b.ts");
export const C = fp("r.gamma", "src/c.ts");
export const ITEMS = [
  { key: { rule: "r.alpha", path: "src/a.ts", symbol: "fa" }, title: "Alpha leak", severity: "S1", category: "c", evidence: [{ path: "src/a.ts", lines: [3, 5] }] },
  { key: { rule: "r.alpha", path: "src/a.ts", symbol: "fb" }, title: "Alpha twin", severity: "S2", category: "c", evidence: [] },
  { key: { rule: "r.beta", path: "src/b.ts" }, title: "Beta bug", severity: "S2", category: "c", evidence: [] },
];

let n = 0;
export const runId = () => `${Date.now().toString(36)}${(++n).toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`;

export interface Login {
  token: string;
  auth: { authorization: string };
}
export async function login(request: APIRequestContext, name: "alice" | "bob" | "dave", tag: string): Promise<Login> {
  const r = await request.post("/auth/team/login", { data: { token: `${name}-e2e-token`, hostname: `rl4-${name}-${tag}`, install: `rl4-${name}-${tag}`.slice(0, 64) } });
  expect(r.ok()).toBeTruthy();
  const token = (await r.json()).token as string;
  return { token, auth: { authorization: `Bearer ${token}` } };
}

export interface Debrief {
  G: string;
  D: string;
  AU: string;
  repo: string;
  bob: Login;
  dave: Login;
}

/**
 * bob's goal: audit (raises ITEMS, uploads `report`) → debrief (assignee dave) → check; plus a
 * ready interactive `side`. `audit: false` leaves the debrief blocked.
 */
export async function makeDebrief(request: APIRequestContext, o: { audit?: boolean; report?: string } = {}): Promise<Debrief> {
  const run = runId();
  const bob = await login(request, "bob", run);
  const dave = await login(request, "dave", run);
  const repo = `rl4-${run}`;
  const goal = await request.post("/v1/goals", { headers: bob.auth, data: { title: `Debrief ${run}`, primaryRepo: repo } });
  expect(goal.ok(), await goal.text()).toBeTruthy();
  const G = (await goal.json()).id as string;
  const plan = await request.post(`/v1/goals/${G}/plan`, {
    headers: bob.auth,
    data: {
      approve: true,
      steps: [
        { id: "audit", repo, kind: "review", title: "audit", brief: "a", mode: "headless", agent: "auditor", output: "review-record" },
        { id: "debrief", repo, kind: "review", title: "Debrief the audit", brief: "d", deps: ["audit"], mode: "debrief", output: "review-record", may_set: ["accepted", "dismissed", "deferred"], assignee: "dave" },
        { id: "check", repo, kind: "verify", title: "check", brief: "c", deps: ["debrief"] },
        { id: "side", repo, kind: "implement", title: "side", brief: "s" },
      ],
    },
  });
  expect(plan.ok(), await plan.text()).toBeTruthy();
  const d: Debrief = { G, D: `${G}.debrief`, AU: `${G}.audit`, repo, bob, dave };
  if (o.audit === false) return d;
  const cl = await request.post(`/v1/steps/${d.AU}/claim`, { headers: bob.auth, data: {} });
  expect(cl.ok(), await cl.text()).toBeTruthy();
  const up = await request.post(`/v1/steps/${d.AU}/artifacts`, { headers: bob.auth, data: { kind: "report", content: o.report ?? `REPORT ${run}` } });
  expect(up.status(), await up.text()).toBe(201);
  const rv = await request.post(`/v1/steps/${d.AU}/review`, { headers: bob.auth, data: { coverage: "complete", assessment: "issues", items: ITEMS, summary: "s" } });
  expect(rv.status(), await rv.text()).toBe(201);
  const done = await request.post(`/v1/steps/${d.AU}/done`, { headers: bob.auth, data: { summary: "ok" } });
  expect(done.ok(), await done.text()).toBeTruthy();
  return d;
}

export async function claimAs(request: APIRequestContext, who: Login, id: string): Promise<void> {
  const r = await request.post(`/v1/steps/${id}/claim`, { headers: who.auth, data: {} });
  expect(r.ok(), await r.text()).toBeTruthy();
}
export async function dispose(request: APIRequestContext, who: Login, id: string, f: string, disposition: string): Promise<void> {
  const r = await request.post(`/v1/steps/${id}/dispositions`, { headers: who.auth, data: { fingerprint: f, disposition, reason: `R-${f}`, answer: `ANS-${f}` } });
  expect(r.status(), await r.text()).toBe(201);
}
export async function stepOf(request: APIRequestContext, who: Login, id: string) {
  const r = await request.get(`/v1/steps/${id}`, { headers: who.auth });
  expect(r.ok()).toBeTruthy();
  return (await r.json()).context.step;
}
export async function itemState(request: APIRequestContext, who: Login, id: string, f: string): Promise<string | undefined> {
  const r = await request.get(`/v1/steps/${id}/debrief`, { headers: who.auth });
  expect(r.ok(), await r.text()).toBeTruthy();
  const v = await r.json();
  const lineage = v.lineage as string;
  const items = await request.get(`/v1/items?lineage=${encodeURIComponent(lineage)}`, { headers: who.auth });
  expect(items.ok()).toBeTruthy();
  return ((await items.json()).items as { fp: string; state: string }[]).find((x) => x.fp === f)?.state;
}
