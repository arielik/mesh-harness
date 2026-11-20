// RL-12 test helpers: run a stage of a goal end to end, read run cards, define a topic.
import { expect } from "vitest";
import { type Ck, rec } from "./calib-kit.ts";
import type { Json, Person } from "./world.ts";

export interface StageOpts {
  items?: unknown[];
  dispositions?: unknown[];
  agent?: { key: string; hash?: string };
  telemetry?: Json;
  report?: string;
  started?: boolean;
  outcome?: "done" | "fail";
  reopen?: string[];
}

/** Claim a step, optionally start a run, upload a report, submit a record, close it, report telemetry. */
export async function stage(k: Ck, who: Person, id: string, o: StageOpts = {}): Promise<number> {
  await k.k.claim(who, id);
  if (o.started) {
    const s = await k.r.call(who, "POST", `/v1/steps/${id}/run`, { state: "started", runId: `run-${id}` });
    expect(s.status, JSON.stringify(s.json)).toBe(200);
  }
  if (o.report) {
    const u = await k.r.call(who, "POST", `/v1/steps/${id}/artifacts`, { kind: "report", content: o.report });
    expect(u.status, JSON.stringify(u.json)).toBe(201);
  }
  if (o.items || o.dispositions) {
    const res = await k.k.review(who, id, rec({ items: o.items ?? [], dispositions: o.dispositions ?? [], ...(o.agent ? { agent: o.agent } : {}) } as never));
    expect(res.status, `review ${id}: ${JSON.stringify(res.json)}`).toBe(201);
  }
  const d = await k.k.close(who, id, { outcome: o.outcome ?? "done", summary: "ok", ...(o.reopen ? { reopen: o.reopen } : {}), ...(o.outcome === "fail" && (o.items || o.dispositions) ? { closeAsFail: true } : {}) });
  expect(d.status, `close ${id}: ${JSON.stringify(d.json)}`).toBe(200);
  const st = await k.r.stepOf(id);
  const round = (st.rounds as Json[]).at(-1) as Json;
  if (o.telemetry) {
    const f = await k.r.call(who, "POST", `/v1/steps/${id}/run`, { state: "finished", runId: o.telemetry.runId, round: round.n, telemetry: o.telemetry });
    expect(f.status, JSON.stringify(f.json)).toBe(200);
  }
  return round.finishedAt as number;
}

export const cards = async (k: Ck, id: string, query = ""): Promise<{ status: number; json: Json }> => k.r.call(k.c.ann, "GET", `/v1/pulses/${id}/runs${query}`);
export const cardsOk = async (k: Ck, id: string, query = ""): Promise<Json> => {
  const res = await cards(k, id, query);
  expect(res.status, `runs${query}: ${JSON.stringify(res.json)}`).toBe(200);
  return res.json;
};
export async function topic(k: Ck, name = "ci"): Promise<void> {
  const res = await k.r.call(k.c.ann, "POST", "/v1/topics", { name });
  expect(res.status, JSON.stringify(res.json)).toBe(201);
}

