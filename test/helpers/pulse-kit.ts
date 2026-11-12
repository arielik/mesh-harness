// RL-3 test kit: pulses through the hub (World), built on `Relay`. Slot instants are computed here
// from fixed constants (never by calling `nextSlot`), so the World tests check the core too.
// Pulses, slots and goals are found by id; events by type + payload.pulse / payload.slot.

import { createHash } from "node:crypto";
import { expect } from "vitest";
import { BUILTIN_PRESETS, presetText } from "../../src/core/index.ts";
import type { Session } from "../../src/protocol/index.ts";
import { Relay } from "./relay-kit.ts";
import type { Json, Person, World } from "./world.ts";

export const MIN = 60_000;
export const HOUR = 3_600_000;
export const DAY = 86_400_000;
/** 2026-11-16T09:00:00.000Z, a Monday: the anchor `at` of every `every` pulse that needs fixed slots. */
export const T0 = Date.UTC(2026, 10, 16, 9);
export const S = (k: number, period: number) => T0 + k * period;
export const iso = (ms: number) => new Date(ms).toISOString();

export const sha = (s: string) => createHash("sha256").update(s, "utf8").digest("hex");
export const sha12 = (s: string) => sha(s).slice(0, 12);
export const snap = (name: string, text: string, source?: { repo: string; commit: string }) => ({ name, text, sha256: sha(text), ...(source ? { source } : {}) });

/** The repo every pulse below works in (a repo name: machines match it by name). */
export const REPO = "alpha";
export const REPO_ID = "git.example.com/org/alpha";

// ---- preset texts (the YAML that `parsePreset` reads) ------------------------------------------

/** One interactive step `run`. */
export const SOLO = `description: One interactive step
steps:
  - id: run
    kind: implement
    repo: "{repo}"
    title: "Run {repo}"
    brief: "Do the thing in {repo}."
`;
/** One headless step `run`, agent auditor, no profile (so the plan's profile names are ["read-only"]). */
export const SOLO_HL = `description: One headless step
steps:
  - id: run
    kind: review
    repo: "{repo}"
    mode: headless
    agent: auditor
    title: "Audit {repo}"
    brief: "Audit {repo}."
`;
/** Headless `run` then headless `next` (deps run). */
export const TWO_HL = `description: Two headless steps
steps:
  - id: run
    kind: review
    repo: "{repo}"
    mode: headless
    agent: auditor
    title: "Audit {repo}"
    brief: "Audit {repo}."
  - id: next
    kind: review
    repo: "{repo}"
    deps: [run]
    mode: headless
    agent: auditor
    title: "Next {repo}"
    brief: "Next {repo}."
`;
/** Two steps without deps. */
export const TWO_ROOTS = `description: Two roots
steps:
  - { id: a, kind: implement, repo: "{repo}", title: A, brief: a }
  - { id: b, kind: implement, repo: "{repo}", title: B, brief: b }
`;
/** One gate step, no deps. */
export const GATE_FIRST = `description: A gate first
steps:
  - { id: g, kind: gate, gate: R1, repo: "{repo}", title: G, brief: g }
  - { id: a, kind: implement, repo: "{repo}", deps: [g], title: A, brief: a }
`;
/** One headless step with an unknown profile. */
export const UNKNOWN_PROF = `description: Unknown profile
steps:
  - { id: run, kind: review, repo: "{repo}", mode: headless, profile: nope, title: R, brief: r }
`;
/** `may_set` without `consumes` (RL-2: `step "run": may_set needs consumes`). */
export const BAD_POLICY = `description: Bad policy
steps:
  - { id: run, kind: review, repo: "{repo}", output: review-record, may_set: [dismissed], title: R, brief: r }
`;
export const BAD_POLICY_TEXT = 'step "run": may_set needs consumes';
/** One headless step `run` with the registered profile `team-ro`. */
export const TEAM_RO = `description: Team read-only
steps:
  - { id: run, kind: review, repo: "{repo}", mode: headless, agent: auditor, profile: team-ro, title: R, brief: r }
`;
export const TEAM_RO_V2 = `description: Team read-only, two steps
steps:
  - { id: run, kind: review, repo: "{repo}", mode: headless, agent: auditor, profile: team-ro, title: R, brief: r }
  - { id: after, kind: review, repo: "{repo}", deps: [run], mode: headless, agent: auditor, profile: team-ro, title: After, brief: a }
`;

export const builtinRelay = () => {
  const p = BUILTIN_PRESETS.find((x) => x.name === "audit-relay");
  if (!p) throw new Error("audit-relay is not built in");
  return p;
};
/** The built-in `audit-relay` as the CLI sends it: `presetText` of the built-in. */
export const RELAY_TEXT = () => presetText(builtinRelay());
export const RELAY_PARAMS = { repo: REPO, agent: "auditor", validator: "checker", filer: "filer" };

/** A minimal valid `PulseCreate` body for `text` (default SOLO, every 1d from T0). */
export const body = (o: Record<string, unknown> = {}, name = "solo", text = SOLO) => ({ preset: snap(name, text), params: { repo: REPO }, when: { every: "1d", at: T0 }, ...o });
export const relayBody = (o: Record<string, unknown> = {}) => ({ preset: snap("audit-relay", RELAY_TEXT()), params: { ...RELAY_PARAMS }, when: { every: "7d" }, ...o });

// ---- bare machines (a login and syncs, no daemon) -------------------------------------------------

export interface Bare {
  user: string;
  token: string;
  machine: string;
  facts: SyncFacts;
}
export interface SyncFacts {
  repos?: string[];
  accept?: string[];
  headless?: boolean;
  sessions?: Session[];
}

export class Pk {
  readonly r: Relay;
  readonly w: World;
  /** Device tokens (each bound to its own machine that has no repo, so it is never a candidate). */
  tok: Record<string, string> = {};
  private n = 0;

  constructor(r: Relay) {
    this.r = r;
    this.w = r.w;
  }

  /** Users ann, bob, carol (admin), root (admin); the clock at `clock` (default T0 − DAY) before any login. */
  static async start(o: { hubYaml?: Record<string, unknown>; clock?: number } = {}): Promise<Pk> {
    const r = await Relay.start(["ann", "bob", "carol", "dave", "root"], { admins: ["carol", "root"], ...(o.hubYaml ? { hubYaml: o.hubYaml } : {}) });
    r.w.clock = o.clock ?? T0 - DAY;
    const k = new Pk(r);
    for (const u of ["ann", "bob", "carol", "dave", "root"]) k.tok[u] = (await r.w.login(u, { hostname: `${u}-login` })).token;
    return k;
  }

  async stop(): Promise<void> {
    await this.r.stop();
  }

  call(who: string, method: "GET" | "POST", path: string, b?: unknown) {
    return this.w.call(this.tok[who] ?? who, method, path, b);
  }

  // ---- pulses ---------------------------------------------------------------------------------

  pulse(who: string, b: unknown) {
    return this.call(who, "POST", "/v1/pulses", b);
  }
  async pulseOk(who: string, b: unknown): Promise<Json> {
    const res = await this.pulse(who, b);
    expect(res.status, JSON.stringify(res.json)).toBe(201);
    return res.json;
  }
  act(who: string, id: string, verb: "update" | "pause" | "resume" | "fire" | "delete", b: unknown = {}) {
    return this.call(who, "POST", `/v1/pulses/${id}/${verb}`, b);
  }
  async fireOk(who: string, id: string): Promise<Json> {
    const res = await this.act(who, id, "fire");
    expect(res.status, JSON.stringify(res.json)).toBe(201);
    return res.json.slot;
  }
  async detail(who: string, id: string): Promise<Json> {
    const res = await this.call(who, "GET", `/v1/pulses/${id}`);
    expect(res.status, JSON.stringify(res.json)).toBe(200);
    return res.json;
  }
  async pulseOf(id: string, who = "ann"): Promise<Json> {
    return (await this.detail(who, id)).pulse;
  }
  async slotsOf(id: string, who = "ann"): Promise<Json[]> {
    return (await this.detail(who, id)).slots;
  }
  async slotOf(id: string, slot: string, who = "ann"): Promise<Json> {
    const xs = (await this.slotsOf(id, who)).filter((s) => s.slot === slot);
    expect(xs, `one slot ${slot} of ${id}`).toHaveLength(1);
    return xs[0];
  }
  async maybeSlot(id: string, slot: string, who = "ann"): Promise<Json | undefined> {
    return (await this.slotsOf(id, who)).find((s) => s.slot === slot);
  }
  async pulseEvents(type: string, id: string): Promise<Json[]> {
    return (await this.r.allEvents()).filter((e) => e.type === type && e.payload?.pulse === id);
  }
  async eventsOfGoal(type: string, G: string): Promise<Json[]> {
    return (await this.r.allEvents()).filter((e) => e.type === type && e.goal === G);
  }

  // ---- goals and steps ------------------------------------------------------------------------

  async goal(G: string, who = "ann"): Promise<Json> {
    const res = await this.call(who, "GET", `/v1/goals/${G}`);
    expect(res.status, JSON.stringify(res.json)).toBe(200);
    return res.json;
  }
  async goalState(G: string): Promise<string> {
    return (await this.goal(G)).goal.state;
  }
  async step(id: string): Promise<Json> {
    const res = await this.call("ann", "GET", `/v1/steps/${id}`);
    expect(res.status, JSON.stringify(res.json)).toBe(200);
    return res.json.context.step;
  }
  /** Goals of pulse `id`, read by `as` (a member; default ann). */
  async goalsOfPulse(id: string, as = "ann"): Promise<string[]> {
    const res = await this.call(as, "GET", "/v1/goals?pulses=1");
    expect(res.status, JSON.stringify(res.json)).toBe(200);
    return (res.json.goals as Json[]).filter((g) => g.refs?.pulse === id).map((g) => g.id as string);
  }
  stepAct(token: string, id: string, verb: string, b: Record<string, unknown> = {}) {
    return this.w.call(token, "POST", `/v1/steps/${id}/${verb}`, b);
  }
  async inbox(token: string): Promise<Json[]> {
    const res = await this.w.call(token, "GET", "/v1/inbox");
    expect(res.status, JSON.stringify(res.json)).toBe(200);
    return res.json.messages;
  }

  // ---- time -----------------------------------------------------------------------------------

  at(ms: number): void {
    this.w.clock = ms;
  }
  async tickAt(ms: number, ...alive: Bare[]): Promise<void> {
    this.at(ms);
    for (const m of alive) await this.sync(m);
    await this.w.tick();
  }

  // ---- machines -------------------------------------------------------------------------------

  /** A bare machine of `user`: a login, then one sync with `facts` (default: repo alpha, accept self). */
  async bare(user: string, hostname: string, facts: SyncFacts = {}, labels?: string[]): Promise<Bare> {
    const l = await this.w.login(user, { hostname, install: `inst-${hostname}-${++this.n}`.padEnd(8, "x") });
    expect(l.machine, `machine id for ${hostname}`).toBeTruthy();
    const m: Bare = { user, token: l.token, machine: l.machine as string, facts: { repos: [REPO_ID], accept: ["self"], ...facts } };
    await this.sync(m);
    if (labels) {
      const res = await this.w.call(m.token, "POST", `/v1/machines/${m.machine}/labels`, { labels });
      expect(res.status, JSON.stringify(res.json)).toBe(200);
    }
    return m;
  }
  /** One sync at the current clock (the machine is online for `machineOfflineMs` after it). */
  async sync(m: Bare): Promise<void> {
    const f = m.facts;
    const machine = {
      share: "me",
      ...(f.repos ? { repos: f.repos.map((id) => ({ id, name: id.slice(id.lastIndexOf("/") + 1) })) } : {}),
      ...(f.accept ? { accept: f.accept } : {}),
      ...(f.headless !== undefined ? { headless: f.headless } : {}),
    };
    const res = await this.w.call(m.token, "POST", "/v1/sync", { events: [], counts: {}, sessions: f.sessions ?? [], machine });
    expect(res.status, JSON.stringify(res.json)).toBe(200);
  }
  /** An idle session in alpha, as a daemon syncs it. */
  idleSession(sid: string): Session {
    return {
      sid,
      claudeSessionIds: [`c-${sid}`],
      cwd: `/w/${sid}`,
      kind: "interactive",
      state: "idle",
      quiet: false,
      startedAt: this.w.clock - 10_000,
      lastEventAt: this.w.clock,
      turns: 1,
      humanPrompts: 1,
      seenByReconciler: true,
      repo: { id: REPO_ID, name: REPO },
    };
  }

  // ---- store seams ----------------------------------------------------------------------------

  /** Replace store methods of the World's hub (the store its HubService uses); returns an undo. */
  storeWrap(overrides: Record<string, (orig: (...a: unknown[]) => unknown, ...a: unknown[]) => unknown>): () => void {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- new store methods, patched loosely
    const s = this.w.hub.svc.store as any;
    const undo: (() => void)[] = [];
    for (const [name, fn] of Object.entries(overrides)) {
      const had = Object.hasOwn(s, name);
      const prev = s[name];
      const orig = (prev as (...a: unknown[]) => unknown).bind(s);
      s[name] = (...a: unknown[]) => fn(orig, ...a);
      undo.push(() => {
        if (had) s[name] = prev;
        else delete s[name];
      });
    }
    return () => undo.reverse().forEach((f) => f());
  }
}

export type { Json, Person };
