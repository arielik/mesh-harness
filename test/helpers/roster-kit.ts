// RL-5 test kit: the roster through the hub (World), built on `Pk` (users ann, bob, dave = members;
// carol, root = admins). Hashes are computed here (SHA-256 of the text with CRLF turned into LF, the
// documented `agentFileHash` contract), never asked of the code under test. Groups are found by
// name, copies by key (+ kind), sources by repo id, events by type.

import { createHash } from "node:crypto";
import { expect } from "vitest";
import { Pk, type Bare } from "./pulse-kit.ts";
import type { Json } from "./world.ts";

export const RULE = "agent key must be <source>/<name>[@<7-64 hex>]";
export const SRC_URL = "https://git.example.com/Team/Agents.git";
export const SRC = "git.example.com/team/agents";
export const SRC2 = "git.example.com/other/agents";
export const ALPHA = "git.example.com/team/alpha";
export const BETA = "git.example.com/team/beta";
export const GAMMA = "git.example.com/team/gamma";
export const AARD = "git.example.com/team/aardvark";
export const DELTA = "git.example.com/team/delta";
export const C1 = "c1".repeat(20);
export const C2 = "c2".repeat(20);
export const C3 = "c3".repeat(20);

export const sha = (s: string) => createHash("sha256").update(s, "utf8").digest("hex");
/** The documented `agentFileHash`: SHA-256 of the text with CRLF turned into LF. */
export const H = (text: string) => sha(text.replace(/\r\n/g, "\n"));

/** CRLF on purpose. */
export const REV1 = "---\r\ndescription: Reviews code\r\nmodel: sonnet\r\ntools: Read, Grep\r\nmesh-rules: [r.alpha, r.beta]\r\n---\r\n\r\nYou review.\r\n";
export const REV2 = REV1.replace("You review.", "You review carefully.");
export const REV3 = REV1.replace("You review.", "You review twice.");
export const OTHER = "---\ndescription: Other agent\n---\nYou are other.\n";
export const H1 = H(REV1);
export const H2 = H(REV2);
export const H3 = H(REV3);
export const HO = H(OTHER);

/** One headless step `run` whose agent is the parameter `agent`. */
export const ROSTER_HL = `description: One roster step
steps:
  - id: run
    kind: review
    repo: "{repo}"
    mode: headless
    agent: "{agent}"
    title: "Audit {repo}"
    brief: "Audit {repo}."
`;

export const lastSeg = (id: string) => id.slice(id.lastIndexOf("/") + 1);

/** An AgentReport as a daemon sends it (hash of `text`). */
export function rep(repo: string, name: string, text: string, over: Record<string, unknown> = {}): Json {
  return { repo, kind: "claude", path: `.claude/agents/${name}.md`, name, hash: H(text), ...over };
}

export class Rk {
  readonly k: Pk;
  constructor(k: Pk) {
    this.k = k;
  }
  static async start(o: { hubYaml?: Record<string, unknown>; clock?: number } = {}): Promise<Rk> {
    return new Rk(await Pk.start(o));
  }
  get w() {
    return this.k.w;
  }
  get r() {
    return this.k.r;
  }
  async stop(): Promise<void> {
    await this.k.stop();
  }
  call(who: string, method: "GET" | "POST", path: string, b?: unknown) {
    return this.k.call(who, method, path, b);
  }

  // ---- catalog ---------------------------------------------------------------------------------

  source(repo = SRC_URL, folder = "agents", who = "root", extra: Record<string, unknown> = {}) {
    return this.call(who, "POST", "/v1/catalog-sources", { repo, folder, ...extra });
  }
  async sourceOk(repo = SRC_URL, folder = "agents", who = "root", extra: Record<string, unknown> = {}): Promise<Json> {
    const res = await this.source(repo, folder, who, extra);
    expect([200, 201], JSON.stringify(res.json)).toContain(res.status);
    return res.json;
  }
  /** A machine of `user` whose inventory holds `repos` (default the catalog source). */
  pusher(user = "root", repos: string[] = [SRC], host = `${user}-pusher`): Promise<Bare> {
    return this.k.bare(user, host, { repos });
  }
  push(m: Bare | string, commit: string, defs: Record<string, string>, repo = SRC, folder = "agents") {
    const token = typeof m === "string" ? m : m.token;
    return this.w.call(token, "POST", "/v1/catalog-sources/push", { repo, commit, defs: Object.entries(defs).map(([name, text]) => ({ path: `${folder}/${name}.md`, text })) });
  }
  async pushOk(m: Bare | string, commit: string, defs: Record<string, string>, repo = SRC): Promise<Json> {
    const res = await this.push(m, commit, defs, repo);
    expect(res.status, JSON.stringify(res.json)).toBe(200);
    return res.json;
  }
  /** Register SRC and push `defs` at C1 from a root machine. */
  async catalog(defs: Record<string, string> = { rev: REV1 }): Promise<Bare> {
    await this.sourceOk();
    const m = await this.pusher();
    await this.pushOk(m, C1, defs);
    return m;
  }

  // ---- repo copies -----------------------------------------------------------------------------

  /** A raw sync of `m` with `machine.agents` (omit `agents` to send no key). */
  async report(m: Bare, agents: Json[] | undefined, o: { share?: string; repos?: string[] } = {}): Promise<{ status: number; json: Json }> {
    const repos = o.repos ?? m.facts.repos ?? [];
    const machine = { share: o.share ?? "me", repos: repos.map((id) => ({ id, name: lastSeg(id) })), ...(agents ? { agents } : {}) };
    const res = await this.w.call(m.token, "POST", "/v1/sync", { events: [], counts: {}, sessions: [], machine });
    expect(res.status, JSON.stringify(res.json)).toBe(200);
    return res;
  }

  // ---- views -----------------------------------------------------------------------------------

  async view(who: string, query = ""): Promise<Json> {
    const res = await this.call(who, "GET", `/v1/agents${query}`);
    expect(res.status, JSON.stringify(res.json)).toBe(200);
    return res.json;
  }
  resolve(who: string, key?: string) {
    return this.call(who, "GET", `/v1/agents/resolve${key === undefined ? "" : `?key=${encodeURIComponent(key)}`}`);
  }
  async events(type: string): Promise<Json[]> {
    return (await this.r.allEvents()).filter((e) => e.type === type);
  }
}

export const groupOf = (view: Json, name: string): Json | undefined => (view.agents as Json[]).find((g) => g.name === name);
export const copiesOf = (view: Json): Json[] => (view.agents as Json[]).flatMap((g) => (g.versions as Json[]).flatMap((v) => v.copies as Json[]));
export const copyOf = (view: Json, key: string, kind?: string): Json | undefined => copiesOf(view).find((c) => c.key === key && (kind === undefined || c.kind === kind));
export const keysOf = (view: Json): string[] => copiesOf(view).map((c) => `${c.origin}:${c.key}`);

export type { Bare, Json };
