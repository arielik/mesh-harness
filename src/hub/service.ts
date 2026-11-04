// Hub service: the single writer (plan §8). Every mutation runs in one transaction that writes the
// state change and its event; the bus then hints SSE subscribers.

import { randomBytes, randomUUID } from "node:crypto";
import { loginIdentity, pkceChallenge, randomId, Tokens, type AuthProvider, type Identity } from "../auth/index.ts";
import {
  agentContext,
  blindConflict,
  parsePreset,
  presetWarnings,
  blindSeparated,
  canApprove,
  claim,
  judgeDone,
  reopenText,
  validatePolicies,
  goalFile,
  goalRollup,
  planFile,
  stepFacts,
  stepRecord,
  finish,
  isOwnerOrAdmin,
  materialize,
  needsLabel,
  recomputeReady,
  release,
  reopen,
  repoMatches,
  takeOver,
  validatePlan,
  pause,
  type Principal,
  type Role,
} from "../core/index.ts";
import type {
  AcState,
  Attention,
  Failure,
  Round,
  Verdict,
  DoneResult,
  Goal,
  GoalDetail,
  InboxMessage,
  LiveView,
  LoginResult,
  Plan,
  PlanInput,
  ProviderInfo,
  Question,
  Session,
  Step,
  StepContext,
  StepView,
  SyncRequest,
  TimelineEntry,
  TrailFile,
  UserView,
} from "../protocol/index.ts";
import type { HubStore, NewEvent, UserRow } from "../store/index.ts";
import { Bus } from "./bus.ts";
import type { HubConfig } from "./config.ts";

export class HubError extends Error {
  status: number;
  details?: unknown;
  constructor(status: number, message: string, details?: unknown) {
    super(message);
    this.status = status;
    this.details = details;
  }
}

export interface Actor extends Principal {
  machineId?: string | undefined;
  tokenHash: string;
  tokenKind: string;
}

interface LoginAttempt {
  provider: string;
  client: "cli" | "web";
  nonce: string;
  verifier: string;
  redirectUri: string;
  cliPort?: number | undefined;
  cliChallenge?: string | undefined;
  hostname?: string | undefined;
}

interface CliCode {
  userId: string;
  roles: Role[];
  cliChallenge: string;
}

const LOGIN_TTL = 10 * 60_000;
const ONLINE_MS = 2 * 60_000;

export class HubService {
  readonly store: HubStore;
  readonly config: HubConfig;
  readonly tokens: Tokens;
  readonly bus = new Bus();
  now: () => number;

  constructor(store: HubStore, config: HubConfig, now: () => number = () => Date.now()) {
    this.store = store;
    this.config = config;
    this.tokens = new Tokens(store, config.policies);
    this.now = now;
  }

  // ---------- helpers ----------

  private emit(e: Omit<NewEvent, "at"> & { at?: number }): void {
    const seq = this.store.appendEvent({ ...e, at: e.at ?? this.now() });
    if (seq !== undefined) queueMicrotask(() => this.bus.publish({ type: "changed", seq }));
  }

  private provider(id: string): AuthProvider {
    const p = this.config.providers.find((x) => x.id === id);
    if (!p) throw new HubError(404, `unknown auth provider "${id}"`);
    return p;
  }

  userView(u: UserRow): UserView {
    return { id: u.id, name: u.name, roles: u.roles };
  }

  private goalOr404(id: string): Goal {
    const g = this.store.getGoal(id);
    if (!g) throw new HubError(404, `no goal ${id}`);
    return g;
  }

  private stepOr404(id: string): Step {
    const s = this.store.getStep(id);
    if (!s) throw new HubError(404, `no step ${id}`);
    return s;
  }

  private sessionOf(sid: string | undefined): Session | undefined {
    return sid ? this.store.getSession(sid)?.session : undefined;
  }

  /** Queue a message for a session's machine and wake that daemon. */
  private message(toSid: string | undefined, fromUser: string, kind: string, text: string, data?: Record<string, unknown>): number | undefined {
    if (!toSid) return undefined;
    const hs = this.store.getSession(toSid);
    if (!hs || hs.session.state === "ended") return undefined;
    const m = this.store.addMessage({ toMachine: hs.machineId, toSid, fromUser, kind, text, ...(data ? { data } : {}) }, this.now());
    queueMicrotask(() => this.bus.publish({ type: "wake", machine: hs.machineId }));
    return m.id;
  }

  // ---------- auth ----------

  providersInfo(): ProviderInfo[] {
    return this.config.providers.map((p) => ({ id: p.id, kind: p.kind, label: p.label, flows: p.flows() }));
  }

  /** Who a presented token belongs to. */
  authenticate(token: string): Actor | undefined {
    const row = this.tokens.verify(token, this.now());
    if (!row) return undefined;
    const user = this.store.getUser(row.userId);
    if (!user) return undefined;
    return { userId: user.id, roles: user.roles as Role[], machineId: row.machineId, tokenHash: row.hash, tokenKind: row.kind };
  }

  private machineFor(userId: string, hostname: string | undefined): string {
    const host = hostname?.trim() || "unknown";
    const existing = this.store.listMachines().find((m) => m.userId === userId && m.hostname === host);
    const id = existing?.id ?? `m-${randomBytes(4).toString("hex")}`;
    this.store.upsertMachine({ id, userId, hostname: host }, this.now());
    return id;
  }

  private issue(identity: Identity, client: "cli" | "web", hostname: string | undefined): LoginResult {
    return this.store.tx(() => {
      const { user, roles } = loginIdentity(this.store, identity, { roleMappings: this.config.roleMappings, bootstrapAdmins: this.config.bootstrapAdmins }, this.now());
      const machine = client === "cli" ? this.machineFor(user.id, hostname) : undefined;
      const t = this.tokens.issue(client === "cli" ? "device" : "web", user.id, this.now(), { machineId: machine, label: hostname });
      this.emit({ type: "user.logged_in", user: user.id, payload: { provider: identity.provider, client, machine } });
      return { token: t.token, user: { id: user.id, name: user.name, roles }, machine, expiresAt: t.expiresAt };
    });
  }

  /** none/token providers. */
  async loginDirect(providerId: string, input: { token?: string | undefined; hostname?: string | undefined; client: "cli" | "web" }): Promise<LoginResult> {
    const p = this.provider(providerId);
    const flow = p.flows().includes("none") ? "none" : "token";
    if (flow === "token" && !input.token) throw new HubError(400, "token required");
    const id = await p.complete(flow === "none" ? { flow: "none" } : { flow: "token", token: input.token as string });
    if (id === "pending") throw new HubError(500, "unexpected pending login");
    return this.issue(id, input.client, input.hostname);
  }

  /** Redirect flow start (hub-mediated, plan §4.4). Returns the IdP URL. */
  async loginStart(providerId: string, client: "cli" | "web", opts: { cliPort?: number | undefined; cliChallenge?: string | undefined; hostname?: string | undefined }): Promise<string> {
    const p = this.provider(providerId);
    if (!p.flows().includes("redirect")) throw new HubError(400, `provider ${providerId} has no browser login`);
    if (client === "cli" && (!opts.cliPort || !opts.cliChallenge)) throw new HubError(400, "cli_port and cli_challenge are required");
    const state = randomId();
    const attempt: LoginAttempt = {
      provider: providerId,
      client,
      nonce: randomId(),
      verifier: randomId(32),
      redirectUri: `${this.config.url}/auth/${providerId}/callback`,
      cliPort: opts.cliPort,
      cliChallenge: opts.cliChallenge,
      hostname: opts.hostname,
    };
    this.store.putLoginAttempt(`state:${state}`, attempt as unknown as Record<string, unknown>, this.now());
    const r = await p.start("redirect", { state, nonce: attempt.nonce, pkceChallenge: pkceChallenge(attempt.verifier), redirectUri: attempt.redirectUri });
    if (r.kind !== "redirect") throw new HubError(500, "provider did not return a redirect");
    return r.url;
  }

  /** IdP callback. Returns where to send the browser and, for web logins, the session token. */
  async loginCallback(providerId: string, callbackUrl: string): Promise<{ redirect: string; webToken?: LoginResult }> {
    const state = new URL(callbackUrl).searchParams.get("state") ?? "";
    const attempt = this.store.getLoginAttempt<LoginAttempt>(`state:${state}`, this.now(), LOGIN_TTL);
    if (!attempt || attempt.provider !== providerId) throw new HubError(400, "unknown or expired login; start again");
    this.store.deleteLoginAttempt(`state:${state}`);
    const id = await this.provider(providerId).complete({ flow: "redirect", callbackUrl, pkceVerifier: attempt.verifier, state, nonce: attempt.nonce, redirectUri: attempt.redirectUri });
    if (id === "pending") throw new HubError(500, "unexpected pending login");
    if (attempt.client === "web") return { redirect: "/", webToken: this.issue(id, "web", undefined) };
    // CLI: hand a one-time code to the CLI's localhost listener; it proves itself with its PKCE verifier.
    const code = randomId(24);
    this.store.putLoginAttempt(`code:${code}`, { identity: id, cliChallenge: attempt.cliChallenge, hostname: attempt.hostname } as unknown as Record<string, unknown>, this.now());
    return { redirect: `http://127.0.0.1:${attempt.cliPort}/callback?code=${encodeURIComponent(code)}` };
  }

  cliExchange(code: string, verifier: string, hostname: string | undefined): LoginResult {
    const rec = this.store.getLoginAttempt<{ identity: Identity; cliChallenge: string; hostname?: string } & Partial<CliCode>>(`code:${code}`, this.now(), 2 * 60_000);
    this.store.deleteLoginAttempt(`code:${code}`);
    if (!rec || pkceChallenge(verifier) !== rec.cliChallenge) throw new HubError(401, "invalid or expired login code");
    return this.issue(rec.identity, "cli", hostname ?? rec.hostname);
  }

  async deviceStart(providerId: string, hostname: string | undefined, client: "cli" | "web" = "cli") {
    const p = this.provider(providerId);
    if (!p.flows().includes("device")) throw new HubError(400, `provider ${providerId} has no device login`);
    const r = await p.start("device", { state: "", nonce: "", pkceChallenge: "", redirectUri: "" });
    if (r.kind !== "device") throw new HubError(500, "provider did not start a device login");
    this.store.putLoginAttempt(`device:${r.pollId}`, { provider: providerId, hostname, client }, this.now());
    return r;
  }

  async devicePoll(providerId: string, pollId: string, hostname: string | undefined): Promise<LoginResult | "pending"> {
    const rec = this.store.getLoginAttempt<{ provider: string; hostname?: string; client: "cli" | "web" }>(`device:${pollId}`, this.now(), LOGIN_TTL);
    if (!rec || rec.provider !== providerId) throw new HubError(404, "unknown or expired device login");
    const id = await this.provider(providerId).complete({ flow: "device", pollId });
    if (id === "pending") return "pending";
    this.store.deleteLoginAttempt(`device:${pollId}`);
    return this.issue(id, rec.client, hostname ?? rec.hostname);
  }

  logout(actor: Actor): void {
    this.store.revokeToken(actor.tokenHash);
  }

  me(actor: Actor): { user: UserView; machine?: string | undefined } {
    const u = this.store.getUser(actor.userId) as UserRow;
    return { user: this.userView(u), machine: actor.machineId };
  }

  // ---------- goals and plans ----------

  createGoal(
    actor: Actor,
    input: {
      title: string;
      primaryRepo?: string | undefined;
      repos?: string[] | undefined;
      issueUrl?: string | undefined;
      refs?: Record<string, string> | undefined;
      reworks?: string[] | undefined;
      preset?: { name: string; text: string } | undefined;
      priority: number;
    },
  ): Goal {
    return this.store.tx(() => {
      const now = this.now();
      const goal = this.store.createGoal({
        title: input.title,
        ownerId: actor.userId,
        state: "backlog",
        ...(input.primaryRepo ? { primaryRepo: input.primaryRepo } : {}),
        ...(input.repos?.length ? { repos: input.repos } : {}),
        ...(input.issueUrl ? { issueUrl: input.issueUrl } : {}),
        ...(input.refs && Object.keys(input.refs).length ? { refs: input.refs } : {}),
        ...(input.reworks?.length ? { reworks: input.reworks } : {}),
        ...(input.preset ? { preset: input.preset } : {}),
        priority: input.priority,
        createdAt: now,
        updatedAt: now,
      });
      const design: Step = {
        id: `${goal.id}.design`,
        goal: goal.id,
        planVersion: 0,
        kind: "design",
        repo: input.primaryRepo ?? "",
        title: "Design",
        brief: [
          `Design "${input.title}".`,
          `1. Read the relevant code${input.repos?.length ? ` (also in: ${input.repos.join(", ")})` : ""} and write a design document, e.g. docs/design/${goal.id.toLowerCase()}-<slug>.md, with the approach, risks and how it will be tested.`,
          "2. Split the work into steps (implement / test / review / docs), one repo each, with dependencies where order matters; steps without dependencies on each other can be done in parallel by other people.",
          "3. Propose them with mesh_plan (design_ref = where the document is). A person approves or asks for changes; you get a message either way. Then end your turn.",
          ...(input.preset
            ? [
                "",
                `Follow the plan template "${input.preset.name}": keep its step ids, kinds and rules (blind, target, route, gates); fill in repo, title and brief per step, and the acceptance criteria (acs) from the design. Template:`,
                input.preset.text,
              ]
            : []),
        ].join("\n"),
        deps: [],
        state: "ready",
        fixCycles: 0,
        updatedAt: now,
      };
      this.store.saveSteps([design]);
      this.emit({ type: "goal.created", user: actor.userId, goal: goal.id, payload: { title: goal.title } });
      this.emit({ type: "step.ready", goal: goal.id, step: design.id });
      return goal;
    });
  }

  listGoals(): Goal[] {
    return this.store.listGoals();
  }

  goalDetail(id: string): GoalDetail {
    const goal = this.goalOr404(id);
    const steps = this.store.listSteps({ goal: goal.id });
    const holders: NonNullable<GoalDetail["holders"]> = {};
    for (const s of steps) {
      if (!s.holderSid || (s.state !== "claimed" && s.state !== "paused")) continue;
      const hs = this.store.getSession(s.holderSid);
      if (hs) holders[s.id] = { sid: hs.session.sid, state: hs.session.state, ...(hs.session.needs ? { needs: hs.session.needs } : {}), user: hs.userId };
    }
    return { goal, steps, plans: this.store.listPlans(goal.id), holders };
  }

  /**
   * The trail files for a goal, as they should be committed: goal.yaml (with its roll-up once done),
   * every plan version and the design step's record once the design is done.
   */
  goalFiles(id: string): TrailFile[] {
    const goal = this.goalOr404(id);
    const files = [this.goalYaml(goal), ...this.store.listPlans(goal.id).map(planFile)];
    const steps = this.store.listSteps({ goal: goal.id });
    // Steps no agent session closes: the design (on approval) and gates (a person decides).
    for (const st of steps) if ((st.kind === "design" || st.kind === "gate") && (st.rounds?.length ?? 0) > 0 && st.state !== "dropped") files.push(this.recordOf(st, steps));
    return files;
  }

  private goalYaml(goal: Goal): TrailFile {
    if (goal.state !== "done") return goalFile(goal);
    const steps = this.store.listSteps({ goal: goal.id });
    const events = this.store.eventsFor({ goal: goal.id });
    const facts = new Map(steps.map((st) => [st.id, stepFacts(st, events)]));
    const doneAt = events.filter((e) => e.type === "goal.done").at(-1)?.at ?? goal.updatedAt;
    return goalFile(goal, goalRollup(goal, steps, this.store.listPlans(goal.id), facts, doneAt), doneAt);
  }

  private recordOf(step: Step, steps: readonly Step[] = this.store.listSteps({ goal: step.goal })): TrailFile {
    const plan = this.store.listPlans(step.goal).find((p) => p.version === step.planVersion);
    return stepRecord(step, stepFacts(step, this.store.eventsFor({ step: step.id })), this.store.listNotes(step.id).filter((n) => !n.text.startsWith("Reopened by")), plan, blindSeparated(step, steps));
  }

  stepView(id: string): StepView {
    const context = this.context(id);
    return { context, facts: stepFacts(context.step, this.store.eventsFor({ step: context.step.id })) };
  }

  timeline(goalId: string): TimelineEntry[] {
    const goal = this.goalOr404(goalId);
    return this.store
      .eventsFor({ goal: goal.id })
      .filter((e) => !e.type.startsWith("session.turn") && e.type !== "message.delivered")
      .map((e) => ({ seq: e.seq, at: e.at, type: e.type, user: e.user, step: e.step, text: describe(e.type, e.step ?? e.goal, e.payload) }));
  }

  /** Reopen the design (plan §3.4 replan): a new plan version replaces steps not yet done. */
  replan(actor: Actor, goalId: string, comment: string | undefined): GoalDetail {
    this.store.tx(() => {
      const goal = this.goalOr404(goalId);
      if (!isOwnerOrAdmin(actor, goal.ownerId) && !actor.roles.includes("approver")) throw new HubError(403, `only the goal owner, approvers or admins can replan ${goal.id}`);
      if (goal.state === "done" || goal.state === "dropped") throw new HubError(409, `${goal.id} is ${goal.state}`);
      const design = this.store.getStep(`${goal.id}.design`);
      if (!design) throw new HubError(404, `${goal.id} has no design step`);
      const now = this.now();
      const reopened: Step = { ...design, state: "ready", updatedAt: now };
      delete reopened.outcome;
      const previousSid = design.holderSid;
      delete reopened.holderUser;
      delete reopened.holderSid;
      delete reopened.holderMachine;
      delete reopened.claimedAt;
      this.store.saveSteps([reopened]);
      this.store.addNote({ step: reopened.id, user: actor.userId, text: `Replan requested${comment ? `: ${comment}` : ""}`, at: now });
      this.store.saveGoal({ ...goal, state: "design", updatedAt: now });
      this.message(previousSid, actor.userId, "replan", `MESH: ${actor.userId} asked to replan ${goal.id}${comment ? `: ${comment}` : ""}. Claim ${reopened.id} with mesh_claim, update the design and propose a new plan with mesh_plan.`);
      this.emit({ type: "goal.replan", user: actor.userId, goal: goal.id, step: reopened.id, payload: { comment } });
      this.emit({ type: "step.ready", goal: goal.id, step: reopened.id });
    });
    return this.goalDetail(goalId);
  }

  proposePlan(actor: Actor, goalId: string, input: PlanInput & { approve: boolean }): { plan: Plan; detail?: GoalDetail; warnings?: string[] } {
    const result = this.store.tx(() => {
      const goal = this.goalOr404(goalId);
      if (goal.state === "done" || goal.state === "dropped") throw new HubError(409, `${goal.id} is ${goal.state}`);
      const errors = [...validatePlan(input.steps), ...validatePolicies(input.steps, input.acs)];
      if (errors.length) throw new HubError(422, `the plan has ${errors.length} problem(s): ${errors.join("; ")}`, errors);
      const plans = this.store.listPlans(goal.id);
      const now = this.now();
      const plan: Plan = {
        goal: goal.id,
        version: (plans.at(-1)?.version ?? 0) + 1,
        ...(input.design_ref ? { designRef: input.design_ref } : {}),
        steps: input.steps,
        ...(input.acs?.length ? { acs: input.acs } : {}),
        proposedBy: actor.userId,
        proposedAt: now,
        decision: "pending",
      };
      // A newer proposal supersedes pending ones. "superseded" is not a human request for changes,
      // so design rounds count only "revised" (M4, R4).
      for (const p of plans) if (p.decision === "pending") this.store.savePlan({ ...p, decision: "superseded", decidedAt: now });
      this.store.savePlan(plan);
      if (goal.state !== "in_progress") this.store.saveGoal({ ...goal, state: "awaiting_approval", updatedAt: now });
      this.emit({ type: "plan.proposed", user: actor.userId, goal: goal.id, payload: { version: plan.version, steps: plan.steps.length } });
      return plan;
    });
    const goal = this.goalOr404(goalId);
    let warnings: string[] = [];
    if (goal.preset) {
      try {
        warnings = presetWarnings(parsePreset(goal.preset.name, goal.preset.text), input.steps);
      } catch {
        warnings = [`template ${goal.preset.name} could not be read; not compared`];
      }
    }
    const w = warnings.length ? { warnings } : {};
    if (input.approve) return { plan: result, detail: this.approvePlan(actor, goalId, result.version), ...w };
    return { plan: result, ...w };
  }

  approvePlan(actor: Actor, goalId: string, version?: number, comment?: string): GoalDetail {
    this.store.tx(() => {
      const goal = this.goalOr404(goalId);
      if (!canApprove(actor, goal.ownerId)) throw new HubError(403, `only the goal owner, approvers or admins can approve ${goal.id}`);
      const plans = this.store.listPlans(goal.id);
      const plan = version ? plans.find((p) => p.version === version) : plans.filter((p) => p.decision === "pending").at(-1);
      if (!plan) throw new HubError(404, `no pending plan for ${goal.id}`);
      if (plan.decision !== "pending") throw new HubError(409, `plan v${plan.version} is already ${plan.decision}`);
      const now = this.now();
      this.store.savePlan({ ...plan, decision: "approved", decidedBy: actor.userId, decidedAt: now, ...(comment ? { comment } : {}) });
      const existing = this.store.listSteps({ goal: goal.id });
      const m = materialize(goal.id, plan.version, plan.steps, existing, now);
      const design = existing.find((s) => s.kind === "design");
      const changes = [...m.upserts];
      if (design && design.state !== "done") {
        const round = {
          n: (design.rounds?.length ?? 0) + 1,
          user: design.holderUser ?? plan.proposedBy,
          ...(design.holderSid ? { sid: design.holderSid } : {}),
          ...(design.roundStartedAt ?? design.claimedAt ? { startedAt: (design.roundStartedAt ?? design.claimedAt) as number } : {}),
          finishedAt: now,
          outcome: "done" as const,
          summary: `plan v${plan.version} approved by ${actor.userId}`,
          ...(plan.designRef ? { artifacts: [{ path: plan.designRef }] } : {}),
        };
        const d: Step = { ...design, state: "done", outcome: "done", summary: design.summary ?? `plan v${plan.version} approved`, rounds: [...(design.rounds ?? []), round], updatedAt: now };
        delete d.roundStartedAt;
        changes.push(d);
        this.emit({ type: "step.done", user: actor.userId, goal: goal.id, step: d.id, payload: { summary: d.summary } });
      }
      const designSid = design?.holderSid;
      this.message(
        designSid,
        actor.userId,
        "plan_approved",
        `MESH: plan v${plan.version} for ${goal.id} was approved by ${actor.userId}${comment ? ` (${comment})` : ""}. mesh updated .mesh/goals/${goal.id}/plan.v${plan.version}.yaml with the approval; commit it with the design. The steps are open now.`,
        { goal: goal.id, version: plan.version },
      );
      this.store.saveSteps(changes);
      const ready = recomputeReady(this.store.listSteps({ goal: goal.id }), now);
      this.store.saveSteps(ready);
      this.store.saveGoal({ ...goal, state: "in_progress", updatedAt: now });
      this.emit({ type: "plan.approved", user: actor.userId, goal: goal.id, payload: { version: plan.version } });
      for (const s of [...m.upserts, ...ready].filter((x) => x.state === "ready")) this.emit({ type: "step.ready", goal: goal.id, step: s.id });
      for (const s of m.upserts.filter((x) => x.state === "dropped")) this.emit({ type: "step.dropped", goal: goal.id, step: s.id });
      for (const s of m.changedForHolder) {
        this.message(s.holderSid, actor.userId, "replan", `MESH: the brief of your step ${s.id} changed in plan v${plan.version}. Call mesh_context to read it.`);
      }
    });
    return this.goalDetail(goalId);
  }

  revisePlan(actor: Actor, goalId: string, comment: string | undefined): GoalDetail {
    this.store.tx(() => {
      const goal = this.goalOr404(goalId);
      if (!canApprove(actor, goal.ownerId)) throw new HubError(403, `only the goal owner, approvers or admins can revise ${goal.id}`);
      const plan = this.store.listPlans(goal.id).filter((p) => p.decision === "pending").at(-1);
      if (!plan) throw new HubError(404, `no pending plan for ${goal.id}`);
      const now = this.now();
      this.store.savePlan({ ...plan, decision: "revised", decidedBy: actor.userId, decidedAt: now, ...(comment ? { comment } : {}) });
      if (goal.state === "awaiting_approval") this.store.saveGoal({ ...goal, state: "design", updatedAt: now });
      const design = this.store.getStep(`${goal.id}.design`);
      this.message(design?.holderSid, actor.userId, "plan_revised", `MESH: plan v${plan.version} for ${goal.id} needs changes: ${comment ?? "(no comment)"}. Update the design and propose again with mesh_plan.`, { goal: goal.id, version: plan.version });
      this.emit({ type: "plan.revised", user: actor.userId, goal: goal.id, payload: { version: plan.version, comment } });
    });
    return this.goalDetail(goalId);
  }

  // ---------- steps ----------

  listSteps(filter: { goal?: string | undefined; ready?: boolean; repo?: string | undefined; mine?: string | undefined }): Step[] {
    let steps = this.store.listSteps({ goal: filter.goal, state: filter.ready ? "ready" : undefined, holderUser: filter.mine });
    if (filter.repo) {
      const want = filter.repo;
      steps = steps.filter((s) => !s.repo || s.repo === want || repoMatches({ id: want, name: want.slice(want.lastIndexOf("/") + 1) }, s.repo) || repoMatches({ id: s.repo, name: s.repo.slice(s.repo.lastIndexOf("/") + 1) }, want));
    }
    return steps;
  }

  /** A step's context. `forAgent`: what the agent holding it may see (blind and reads rules, M4.5). */
  context(stepId: string, forAgent = false): StepContext {
    const step = this.stepOr404(stepId);
    const goal = this.goalOr404(step.goal);
    const plan = this.store.listPlans(goal.id).filter((p) => p.decision === "approved").at(-1);
    const deps = step.deps.map((d) => this.store.getStep(d)).filter((s): s is Step => !!s);
    const acs = plan?.acs?.length ? (step.policy?.acs?.length ? plan.acs.filter((a) => step.policy?.acs?.includes(a.id)) : plan.acs) : undefined;
    const ctx: StepContext = {
      step,
      goal,
      designRef: plan?.designRef,
      deps: deps.map((d) => ({ id: d.id, title: d.title, state: d.state, summary: d.summary, branch: d.branch, mr: d.mr })),
      notes: this.store.listNotes(step.id),
      openQuestions: this.store.openQuestions().filter((q) => q.step === step.id),
      ...(acs ? { acs } : {}),
    };
    return forAgent ? agentContext(ctx, this.store.listSteps({ goal: goal.id })) : ctx;
  }

  private machineOf(actor: Actor, sid: string | undefined): string | undefined {
    return (sid ? this.store.getSession(sid)?.machineId : undefined) ?? actor.machineId;
  }

  claimStep(actor: Actor, stepId: string, sid: string | undefined): Step {
    return this.store.tx(() => {
      const step = this.stepOr404(stepId);
      if (step.kind === "gate") throw new HubError(409, `${step.id} is a gate: a person decides it (mesh step approve ${step.id}, or the web dashboard)`);
      if (step.state === "parked") throw new HubError(409, `${step.id} is parked (${step.parkedReason ?? "by a rule"}); a person resumes it (mesh step resume ${step.id})`);
      const blind = blindConflict(step, this.store.listSteps({ goal: step.goal }), { userId: actor.userId, sid }, this.config.blindGuard);
      if (blind) throw new HubError(409, blind);
      const r = claim(step, { userId: actor.userId, sid, machine: this.machineOf(actor, sid) }, this.now());
      if (!r.ok) throw new HubError(r.status, r.error);
      const claimed: Step = r.step.roundStartedAt === undefined ? { ...r.step, roundStartedAt: this.now() } : r.step;
      this.store.saveSteps([claimed]);
      const goal = this.store.getGoal(step.goal);
      if (goal && step.kind === "design" && goal.state === "backlog") this.store.saveGoal({ ...goal, state: "design", updatedAt: this.now() });
      this.emit({ type: "step.claimed", user: actor.userId, sid, goal: step.goal, step: step.id });
      return claimed;
    });
  }

  releaseStep(actor: Actor, stepId: string, note: string | undefined): Step {
    return this.store.tx(() => {
      const step = this.stepOr404(stepId);
      const goal = this.goalOr404(step.goal);
      const r = release(step, { userId: actor.userId }, isOwnerOrAdmin(actor, goal.ownerId), this.now());
      if (!r.ok) throw new HubError(r.status, r.error);
      this.store.saveSteps([r.step]);
      if (note) this.store.addNote({ step: step.id, user: actor.userId, text: note, at: this.now() });
      this.emit({ type: "step.released", user: actor.userId, goal: step.goal, step: step.id, payload: { note } });
      return r.step;
    });
  }

  noteStep(actor: Actor, stepId: string, text: string, sid: string | undefined) {
    return this.store.tx(() => {
      const step = this.stepOr404(stepId);
      const note = this.store.addNote({ step: step.id, user: actor.userId, ...(sid ? { sid } : {}), text, at: this.now() });
      this.emit({ type: "step.noted", user: actor.userId, sid, goal: step.goal, step: step.id });
      return note;
    });
  }

  doneStep(
    actor: Actor,
    stepId: string,
    input: {
      summary: string;
      outcome: "done" | "fail";
      branch?: string | undefined;
      mr?: string | undefined;
      reopen: string[];
      sid?: string | undefined;
      model?: string | undefined;
      artifacts?: { path: string; sha?: string | undefined }[] | undefined;
      /** When the daemon finished it; offline replays keep the real time. */
      at?: number | undefined;
      verdict?: Verdict | undefined;
      findings?: { new: number; repeat: number; regression: number } | undefined;
      blockers?: number | undefined;
      failures?: Failure[] | undefined;
      acs?: Record<string, AcState> | undefined;
      acs_addressed?: string[] | undefined;
    },
  ): DoneResult {
    return this.store.tx(() => {
      const step = this.stepOr404(stepId);
      const goal = this.goalOr404(step.goal);
      if (step.kind === "gate") throw new HubError(409, `${step.id} is a gate: a person decides it (mesh step approve ${step.id})`);
      const now = input.at !== undefined && input.at <= this.now() && input.at > this.now() - 30 * 86_400_000 ? input.at : this.now();
      const explicit = input.reopen.map((r) => (r.includes(".") ? r : `${step.goal}.${r}`));
      const all = this.store.listSteps({ goal: step.goal });
      for (const id of explicit) {
        const s = all.find((x) => x.id.toLowerCase() === id.toLowerCase());
        if (!s) throw new HubError(404, `cannot reopen ${id}: no such step`);
        if (s.state !== "done") throw new HubError(409, `cannot reopen ${id}: it is ${s.state}, not done`);
      }
      // A verdict decides the outcome when given (a review that requests changes failed).
      const outcome = input.verdict ? (["changes_requested", "blocked", "fail"].includes(input.verdict) ? "fail" : "done") : input.outcome;
      if (outcome === "done" && explicit.length) throw new HubError(400, "reopen only makes sense with outcome fail");
      if (step.state !== "claimed" && step.state !== "paused") throw new HubError(409, `${step.id} is ${step.state}; claim it first`);
      if (step.holderUser !== actor.userId && !actor.roles.includes("admin")) throw new HubError(403, `${step.id} is held by ${step.holderUser}`);
      // Criteria exist only when the plan defines them: ids the plan doesn't know are dropped, and a
      // wrong id never fails the call.
      const plan = this.store.listPlans(step.goal).find((p) => p.version === step.planVersion);
      const known = new Set((plan?.acs ?? []).map((a) => a.id));
      const okAc = (id: string) => known.has(id);
      const acs = Object.fromEntries(Object.entries(input.acs ?? {}).filter(([k]) => okAc(k)));
      const addressed = (input.acs_addressed ?? []).filter(okAc);
      const failures = (input.failures ?? []).map((f) => {
        const { ac, ...rest } = f;
        return ac && okAc(ac) ? f : rest;
      });
      const round: Round = {
        n: (step.rounds?.length ?? 0) + 1,
        user: actor.userId,
        ...(input.sid ? { sid: input.sid } : {}),
        ...(step.roundStartedAt ?? step.claimedAt ? { startedAt: (step.roundStartedAt ?? step.claimedAt) as number } : {}),
        finishedAt: now,
        outcome,
        summary: input.summary,
        ...(input.model ? { model: input.model } : {}),
        ...(input.artifacts?.length ? { artifacts: input.artifacts.map((a) => ({ path: a.path, ...(a.sha ? { sha: a.sha } : {}) })) } : {}),
        ...(input.branch ? { branch: input.branch } : {}),
        ...(input.mr ? { mr: input.mr } : {}),
        ...(input.verdict ? { verdict: input.verdict } : {}),
        ...(input.findings ? { findings: input.findings } : {}),
        ...(input.blockers !== undefined ? { blockers: input.blockers } : {}),
        ...(failures.length ? { failures } : {}),
        ...(Object.keys(acs).length ? { acs } : {}),
        ...(addressed.length ? { acsAddressed: addressed } : {}),
      };
      const decision = judgeDone(step, round, explicit, plan?.acs);

      if (decision.action === "reject") {
        // Not accepted: the holder keeps the step, the attempt is a round (a second miss parks).
        const kept: Step = { ...step, rounds: [...(step.rounds ?? []), { ...round, outcome: "fail", reconcile: { missing: decision.missing } }], roundStartedAt: now, updatedAt: now };
        this.store.saveSteps([kept]);
        this.emit({ at: now, type: "step.rejected", user: actor.userId, sid: input.sid, goal: step.goal, step: step.id, payload: { reason: decision.reason, missing: decision.missing } });
        return { step: kept, reopened: [], nowReady: [], goalDone: false, rejected: decision.reason };
      }
      if (decision.action === "park") {
        const parked: Step = { ...step, state: "parked", parkedReason: decision.reason, parkedAt: now, summary: input.summary, outcome: "fail", rounds: [...(step.rounds ?? []), { ...round, parked: decision.reason }], updatedAt: now };
        delete parked.holderUser;
        delete parked.holderSid;
        delete parked.holderMachine;
        delete parked.claimedAt;
        delete parked.roundStartedAt;
        this.store.saveSteps([parked]);
        this.emit({ at: now, type: "step.parked", user: actor.userId, sid: input.sid, goal: step.goal, step: step.id, payload: { reason: decision.reason, round: round.n } });
        return { step: parked, reopened: [], nowReady: [], goalDone: false, parked: decision.reason, record: this.recordOf(parked, all) };
      }

      const routed = decision.action === "reopen" ? decision.reopen.filter((id) => all.some((x) => x.id === id && x.state === "done")) : [];
      const toReopen = [...new Set([...explicit, ...routed])];
      const fin = finish(step, { userId: actor.userId, sid: input.sid }, { ...input, outcome }, toReopen.length > 0, actor.roles.includes("admin"), now);
      if (!fin.ok) throw new HubError(fin.status, fin.error);
      if (toReopen.length) round.reopen = toReopen;
      const finished: Step = { ...fin.step, rounds: [...(step.rounds ?? []), round] };
      delete finished.roundStartedAt;
      const r = { step: finished };
      let steps = all.map((s) => (s.id === r.step.id ? r.step : s));
      const reopenChanges = reopen(steps, toReopen, now);
      const wanted = new Set(toReopen.map((f) => f.toLowerCase()));
      const reopened = reopenChanges.filter((x) => wanted.has(x.id.toLowerCase()));
      steps = steps.map((s) => reopenChanges.find((x) => x.id === s.id) ?? s);
      const ready = recomputeReady(steps, now);
      steps = steps.map((s) => ready.find((x) => x.id === s.id) ?? s);
      const changed = new Map<string, Step>([[r.step.id, r.step], ...reopenChanges.map((s) => [s.id, s] as const), ...ready.map((s) => [s.id, s] as const)]);
      this.store.saveSteps([...changed.values()]);
      this.emit({
        at: now,
        type: outcome === "done" ? "step.done" : "step.failed",
        user: actor.userId,
        sid: input.sid,
        goal: step.goal,
        step: step.id,
        payload: { summary: input.summary, mr: input.mr, reopen: toReopen, round: round.n, ...(input.model ? { model: input.model } : {}), ...(input.verdict ? { verdict: input.verdict } : {}), ...(input.failures?.length ? { buckets: input.failures.map((f) => f.bucket) } : {}) },
      });
      const why = reopenText(step, round, input.summary);
      for (const s of reopened) {
        const before = all.find((x) => x.id === s.id);
        this.emit({ type: "step.reopened", user: actor.userId, goal: step.goal, step: s.id, payload: { by: step.id, reason: why, fixCycles: s.fixCycles, ...(input.failures?.length ? { buckets: input.failures.map((f) => f.bucket) } : {}) } });
        this.store.addNote({ step: s.id, user: actor.userId, text: `Reopened by ${step.id}: ${why}`, at: now });
        this.message(before?.holderSid, actor.userId, "reopened", `MESH: step ${s.id} was reopened by ${step.id}: ${why}. Claim it again with mesh_claim to fix it.`);
      }
      const nowReady = [...changed.values()].filter((s) => s.state === "ready").map((s) => s.id);
      for (const id of nowReady) this.emit({ type: "step.ready", goal: step.goal, step: id });
      const goalDone = steps.length > 0 && steps.every((s) => s.state === "done" || s.state === "dropped") && steps.some((s) => s.kind !== "design");
      let files: TrailFile[] | undefined;
      if (goalDone && goal.state !== "done") {
        const doneGoal: Goal = { ...goal, state: "done", updatedAt: now };
        this.store.saveGoal(doneGoal);
        this.emit({ at: now, type: "goal.done", goal: goal.id });
        files = [this.goalYaml(doneGoal)];
      }
      const record = this.recordOf(r.step, steps);
      return { step: r.step, reopened: reopened.map((s) => s.id), nowReady, goalDone, record, ...(files ? { files } : {}) };
    });
  }

  /** A person (or a recorded rule) decides a gate step (M4.5). */
  decideGate(actor: Actor, stepId: string, input: { approve: boolean; comment?: string | undefined; rule?: string | undefined; inputs?: Record<string, unknown> | undefined; reopen?: string[] | undefined }): DoneResult {
    return this.store.tx(() => {
      const step = this.stepOr404(stepId);
      const goal = this.goalOr404(step.goal);
      if (step.kind !== "gate") throw new HubError(409, `${step.id} is not a gate step`);
      if (!canApprove(actor, goal.ownerId)) throw new HubError(403, `only the goal owner, approvers or admins decide ${step.id}`);
      if (step.state !== "ready") throw new HubError(409, `${step.id} is ${step.state}; a gate is decided when its dependencies are done`);
      const now = this.now();
      const all = this.store.listSteps({ goal: step.goal });
      const explicit = (input.reopen ?? []).map((r) => (r.includes(".") ? r : `${step.goal}.${r}`));
      if (!input.approve && explicit.length === 0) throw new HubError(400, "rejecting a gate needs the steps to reopen (reopen: [...])");
      for (const id of explicit) if (!all.some((x) => x.id === id && x.state === "done")) throw new HubError(409, `cannot reopen ${id}: no such done step`);
      const round: Round = {
        n: (step.rounds?.length ?? 0) + 1,
        user: actor.userId,
        finishedAt: now,
        outcome: input.approve ? "done" : "fail",
        verdict: input.approve ? "approved" : "changes_requested",
        gate: { by: actor.userId, ...(input.rule ? { rule: input.rule } : {}), ...(input.inputs ? { inputs: input.inputs } : {}), ...(input.comment ? { comment: input.comment } : {}) },
        ...(input.comment ? { summary: input.comment } : {}),
        ...(explicit.length ? { reopen: explicit } : {}),
      };
      const decided: Step = { ...step, state: input.approve ? "done" : "blocked", outcome: input.approve ? "done" : "fail", summary: input.comment ?? (input.approve ? "approved" : "changes requested"), rounds: [...(step.rounds ?? []), round], updatedAt: now };
      let steps = all.map((s) => (s.id === step.id ? decided : s));
      const reopenChanges = reopen(steps, explicit, now);
      steps = steps.map((s) => reopenChanges.find((x) => x.id === s.id) ?? s);
      const ready = recomputeReady(steps, now);
      steps = steps.map((s) => ready.find((x) => x.id === s.id) ?? s);
      const changed = new Map<string, Step>([[decided.id, decided], ...reopenChanges.map((s) => [s.id, s] as const), ...ready.map((s) => [s.id, s] as const)]);
      this.store.saveSteps([...changed.values()]);
      this.emit({ type: input.approve ? "gate.approved" : "gate.rejected", user: actor.userId, goal: step.goal, step: step.id, payload: { gate: step.policy?.gate, rule: input.rule, comment: input.comment, reopen: explicit } });
      for (const s of reopenChanges.filter((x) => explicit.includes(x.id))) {
        this.store.addNote({ step: s.id, user: actor.userId, text: `Reopened by gate ${step.id}: ${input.comment ?? "changes requested"}`, at: now });
        this.emit({ type: "step.reopened", user: actor.userId, goal: step.goal, step: s.id, payload: { by: step.id, reason: input.comment, fixCycles: s.fixCycles } });
      }
      const nowReady = [...changed.values()].filter((s) => s.state === "ready").map((s) => s.id);
      for (const id of nowReady) this.emit({ type: "step.ready", goal: step.goal, step: id });
      const goalDone = steps.every((s) => s.state === "done" || s.state === "dropped") && steps.some((s) => s.kind !== "design");
      let files: TrailFile[] | undefined;
      if (goalDone && goal.state !== "done") {
        const doneGoal: Goal = { ...goal, state: "done", updatedAt: now };
        this.store.saveGoal(doneGoal);
        this.emit({ type: "goal.done", goal: goal.id });
        files = [this.goalYaml(doneGoal)];
      }
      return { step: decided, reopened: explicit, nowReady, goalDone, record: this.recordOf(decided, steps), ...(files ? { files } : {}) };
    });
  }

  /** A person lets a parked step go on: it waits for its dependencies again, rounds are kept. */
  resumeStep(actor: Actor, stepId: string, comment: string | undefined): Step {
    return this.store.tx(() => {
      const step = this.stepOr404(stepId);
      const goal = this.goalOr404(step.goal);
      if (!canApprove(actor, goal.ownerId)) throw new HubError(403, `only the goal owner, approvers or admins resume ${step.id}`);
      if (step.state !== "parked" && step.state !== "failed") throw new HubError(409, `${step.id} is ${step.state}, not parked or failed`);
      const now = this.now();
      const next: Step = { ...step, state: "blocked", updatedAt: now };
      delete next.parkedReason;
      delete next.parkedAt;
      delete next.outcome;
      const all = this.store.listSteps({ goal: step.goal }).map((s) => (s.id === step.id ? next : s));
      const ready = recomputeReady(all, now);
      const final = ready.find((x) => x.id === step.id) ?? next;
      this.store.saveSteps([final, ...ready.filter((x) => x.id !== step.id)]);
      this.store.addNote({ step: step.id, user: actor.userId, text: `Resumed by ${actor.userId}${comment ? `: ${comment}` : ""} (was: ${step.parkedReason ?? step.state})`, at: now });
      this.emit({ type: "step.resumed", user: actor.userId, goal: step.goal, step: step.id, payload: { comment, was: step.parkedReason } });
      if (final.state === "ready") this.emit({ type: "step.ready", goal: step.goal, step: step.id });
      return final;
    });
  }

  takeStep(actor: Actor, stepId: string, sid: string | undefined): Step {
    return this.store.tx(() => {
      const step = this.stepOr404(stepId);
      const goal = this.goalOr404(step.goal);
      const holder = this.sessionOf(step.holderSid);
      const stalledSince = holder?.state === "stalled" ? (holder.lastStopAt ?? holder.lastEventAt) : undefined;
      const previous = step.holderUser;
      const previousSid = step.holderSid;
      const r = takeOver(step, { userId: actor.userId, sid, machine: this.machineOf(actor, sid) }, {
        privileged: isOwnerOrAdmin(actor, goal.ownerId),
        stalledSince,
        now: this.now(),
        rules: { takeoverAfterMs: this.config.thresholds.takeoverAfterMs },
      });
      if (!r.ok) throw new HubError(r.status, r.error);
      this.store.saveSteps([r.step]);
      if (previous && previous !== actor.userId) {
        this.emit({ type: "step.taken_over", user: actor.userId, sid, goal: step.goal, step: step.id, payload: { from: previous } });
        this.message(previousSid, actor.userId, "taken_over", `MESH: ${actor.userId} took over step ${step.id}. Stop working on it; your notes are kept.`);
      }
      return r.step;
    });
  }

  // ---------- questions and messages ----------

  ask(actor: Actor, input: { text: string; sid?: string | undefined; step?: string | undefined }): Question {
    return this.store.tx(() => {
      const step = input.step ? this.store.getStep(input.step) : undefined;
      const owner = step ? this.store.getGoal(step.goal)?.ownerId : undefined;
      const q = this.store.addQuestion({
        ...(step ? { step: step.id } : {}),
        ...(input.sid ? { sid: input.sid } : {}),
        fromUser: actor.userId,
        toUsers: [...new Set([actor.userId, ...(owner ? [owner] : [])])],
        text: input.text,
        at: this.now(),
      });
      this.emit({ type: "question.asked", user: actor.userId, sid: input.sid, goal: step?.goal, step: step?.id, payload: { question: q.id } });
      return q;
    });
  }

  answer(actor: Actor, id: number, text: string): Question {
    return this.store.tx(() => {
      const q = this.store.getQuestion(id);
      if (!q) throw new HubError(404, `no question ${id}`);
      if (q.answer !== undefined) throw new HubError(409, `question ${id} is already answered`);
      if (!q.toUsers.includes(actor.userId) && !actor.roles.includes("admin")) throw new HubError(403, `question ${id} is not addressed to you`);
      const answered: Question = { ...q, answer: text, answeredBy: actor.userId, answeredAt: this.now() };
      this.store.saveQuestion(answered);
      this.message(q.sid, actor.userId, "answer", `MESH: answer from ${actor.userId} to your question "${q.text}": ${text}`);
      this.emit({ type: "question.answered", user: actor.userId, step: q.step, payload: { question: id } });
      return answered;
    });
  }

  say(actor: Actor, input: { toSid?: string | undefined; toStep?: string | undefined; text: string }): { id: number; toSid: string } {
    return this.store.tx(() => {
      const sid = input.toSid ?? (input.toStep ? this.stepOr404(input.toStep).holderSid : undefined);
      if (!sid) throw new HubError(409, `${input.toStep} has no session holding it`);
      const id = this.message(sid, actor.userId, "say", input.text);
      if (id === undefined) throw new HubError(404, `session ${sid} is not live on any machine`);
      this.emit({ type: "message.sent", user: actor.userId, sid, payload: { id } });
      return { id, toSid: sid };
    });
  }

  // ---------- daemon sync and inbox ----------

  sync(actor: Actor, req: SyncRequest): { accepted: number } {
    if (!actor.machineId) throw new HubError(403, "sync needs a device token (mesh login)");
    const machine = actor.machineId;
    return this.store.tx(() => {
      const now = this.now();
      let accepted = 0;
      for (const e of req.events) {
        const seq = this.store.appendEvent({ id: e.id, at: e.at, type: e.type, user: actor.userId, sid: e.sid, step: e.step, payload: { ...e.payload, machine } });
        if (seq !== undefined) {
          accepted++;
          queueMicrotask(() => this.bus.publish({ type: "changed", seq }));
        }
      }
      for (const s of req.sessions) {
        const existing = this.store.getSession(s.sid);
        if (existing && existing.userId !== actor.userId) continue; // never overwrite another user's session
        this.store.upsertSession(s, actor.userId, machine, now);
      }
      this.store.touchMachine(machine, now, req.counts);
      return { accepted };
    });
  }

  inbox(actor: Actor): InboxMessage[] {
    if (!actor.machineId) throw new HubError(403, "inbox needs a device token");
    return this.store.inbox(actor.machineId).map((m) => ({ id: m.id, toSid: m.toSid, kind: m.kind, text: m.text, fromUser: m.fromUser, createdAt: m.createdAt, ...(m.data ? { data: m.data } : {}) }));
  }

  ack(actor: Actor, id: number, state: "delivered" | "failed", method: string | undefined): boolean {
    if (!actor.machineId) throw new HubError(403, "ack needs a device token");
    const ok = this.store.ackMessage(id, actor.machineId, state, method, this.now());
    if (ok) this.emit({ type: "message.delivered", user: actor.userId, payload: { id, state, method } });
    return ok;
  }

  // ---------- views ----------

  attentionFor(viewer: Actor): Attention[] {
    const out: Attention[] = [];
    const goals = this.store.listGoals();
    for (const g of goals) {
      if (g.state === "awaiting_approval" && canApprove(viewer, g.ownerId)) {
        const plan = this.store.listPlans(g.id).filter((p) => p.decision === "pending").at(-1);
        out.push({ kind: "approval", text: `Plan v${plan?.version ?? "?"} for ${g.id} "${g.title}" awaits approval`, goal: g.id, at: plan?.proposedAt ?? g.updatedAt });
      }
    }
    for (const s of this.store.listSteps({ state: "ready" })) {
      const g = goals.find((x) => x.id === s.goal);
      if (s.kind === "gate" && g && canApprove(viewer, g.ownerId)) out.push({ kind: "approval", text: `Gate ${s.policy?.gate ?? s.id} for ${s.goal} "${g.title}" waits for a decision`, goal: s.goal, step: s.id, at: s.updatedAt });
    }
    for (const q of this.store.openQuestions()) {
      if (q.toUsers.includes(viewer.userId)) out.push({ kind: "question", text: `${q.fromUser} asks: ${q.text}`, step: q.step, sid: q.sid, question: q.id, at: q.at });
    }
    const owned = new Set(goals.filter((g) => g.ownerId === viewer.userId).map((g) => g.id));
    for (const s of this.store.listSteps()) {
      const mine = owned.has(s.goal) || s.holderUser === viewer.userId;
      if (!mine) continue;
      if (s.state === "failed") out.push({ kind: "failed", text: `${s.id} failed: ${s.summary ?? ""}`, goal: s.goal, step: s.id, at: s.updatedAt });
      if (s.state === "paused") out.push({ kind: "paused", text: `${s.id} is paused (holder ${s.holderUser} went away)`, goal: s.goal, step: s.id, at: s.pausedAt ?? s.updatedAt });
      if (s.state === "parked") out.push({ kind: "parked", text: `${s.id} is parked: ${s.parkedReason ?? ""}`, goal: s.goal, step: s.id, at: s.parkedAt ?? s.updatedAt });
      const hs = this.sessionOf(s.holderSid);
      if (s.state === "claimed" && hs?.state === "stalled") out.push({ kind: "stalled", text: `${s.id} stalled in ${s.holderUser}'s session`, goal: s.goal, step: s.id, sid: hs.sid, at: hs.lastStopAt ?? hs.lastEventAt });
    }
    for (const hs of this.store.listSessions()) {
      if (hs.userId === viewer.userId && hs.session.state === "needs_you") {
        out.push({ kind: "needs_you", text: `${hs.session.repo?.name ?? hs.session.name ?? hs.session.sid.slice(0, 8)}: ${needsLabel(hs.session)}`, step: hs.session.step, sid: hs.session.sid, at: hs.session.lastStopAt ?? hs.session.lastEventAt });
      }
    }
    return out.sort((a, b) => b.at - a.at);
  }

  live(viewer: Actor): LiveView {
    const now = this.now();
    const users = this.store.listUsers().filter((u) => !(u.roles.includes("service") && !u.roles.includes("member")));
    const machines = this.store.listMachines();
    const sessions = this.store.listSessions().filter((hs) => hs.session.state !== "ended" || now - (hs.session.endedAt ?? 0) < 10 * 60_000);
    const people = users.map((u) => {
      const ms = machines
        .filter((m) => m.userId === u.id)
        .map((m) => ({ id: m.id, hostname: m.hostname, online: now - m.lastSeen < ONLINE_MS, lastSeen: m.lastSeen, counts: m.counts }));
      const ss = sessions
        .filter((hs) => hs.userId === u.id)
        .map((hs) => ({
          sid: hs.session.sid,
          machine: hs.machineId,
          user: u.id,
          repo: hs.session.repo?.name,
          name: hs.session.name,
          step: hs.session.step,
          state: hs.session.state,
          needs: hs.session.needs,
          autopilot: hs.session.autopilot,
          lastTurnAt: hs.session.lastTurnStartAt,
        }));
      return { user: this.userView(u), online: ms.some((m) => m.online), machines: ms, sessions: ss };
    });
    const goals = this.store.listGoals().map((g) => {
      const steps = this.store.listSteps({ goal: g.id }).filter((s) => s.state !== "dropped");
      return {
        id: g.id,
        title: g.title,
        state: g.state,
        owner: g.ownerId,
        done: steps.filter((s) => s.state === "done").length,
        total: steps.length,
        holders: [...new Set(steps.filter((s) => s.holderUser && (s.state === "claimed" || s.state === "paused")).map((s) => s.holderUser as string))],
      };
    });
    const activity = this.store
      .recentEvents(40)
      .filter((e) => !e.type.startsWith("session.turn"))
      .reverse()
      .map((e) => ({ seq: e.seq, at: e.at, type: e.type, user: e.user, goal: e.goal, step: e.step, text: describe(e.type, e.step ?? e.goal, e.payload) }));
    return { now, me: this.userView(this.store.getUser(viewer.userId) as UserRow), people, goals, attention: this.attentionFor(viewer), activity };
  }

  events(after: number, limit: number) {
    return this.store.events(after, Math.min(Math.max(1, limit), 1000));
  }

  /** Drop hub events older than the retention period (the durable summaries are in git). */
  pruneEvents(): number {
    const days = this.config.eventsRetentionDays;
    if (!days || days <= 0) return 0;
    return this.store.pruneEvents(this.now() - days * 86_400_000);
  }

  // ---------- time rules (plan §3.4) ----------

  private lastPrune = 0;

  tick(): void {
    const now = this.now();
    if (now - this.lastPrune > 6 * 3_600_000) {
      this.lastPrune = now;
      const n = this.pruneEvents();
      if (n) this.emit({ type: "hub.events_pruned", payload: { count: n, days: this.config.eventsRetentionDays } });
    }
    this.store.tx(() => {
      for (const s of this.store.listSteps({ state: "claimed" })) {
        const hs = s.holderSid ? this.store.getSession(s.holderSid) : undefined;
        const machine = s.holderMachine ? this.store.getMachine(s.holderMachine) : undefined;
        const ended = hs?.session.state === "ended" && hs.session.endedReason !== "clear" && now - (hs.session.endedAt ?? 0) > this.config.thresholds.pauseGraceMs;
        const offline = machine !== undefined && now - machine.lastSeen > this.config.thresholds.machineOfflineMs;
        if (ended || offline) {
          this.store.saveSteps([pause(s, now)]);
          this.emit({ type: "step.paused", goal: s.goal, step: s.id, payload: { reason: ended ? "holder session ended" : "holder machine offline" } });
        }
      }
    });
  }

  /** Mint a service token (analysis tools reading the event feed). */
  serviceToken(name: string): string {
    const user = this.store.upsertIdentity({ provider: "service", subject: name, name, groups: ["service"] }, this.now());
    this.store.setUserRoles(user.id, ["service"]);
    return this.tokens.issue("service", user.id, this.now(), { label: name }).token;
  }

  newEventId(): string {
    return randomUUID();
  }
}

function describe(type: string, subject: string | undefined, payload: Record<string, unknown>): string {
  const s = subject ?? "";
  switch (type) {
    case "goal.created":
      return `created ${s} "${String(payload.title ?? "")}"`;
    case "plan.proposed":
      return `proposed plan v${String(payload.version)} for ${s}`;
    case "plan.approved":
      return `approved plan v${String(payload.version)} for ${s}`;
    case "plan.revised":
      return `asked for changes to ${s}`;
    case "agent.finished":
      return `${String(payload.role ?? "agent")} finished ${String(payload.label ?? "")}`.trim();
    case "step.claimed":
      return `claimed ${s}`;
    case "step.done":
      return `finished ${s}`;
    case "step.failed":
      return `${s} failed`;
    case "step.reopened":
      return `${s} reopened (fix cycle ${String(payload.fixCycles)})`;
    case "step.taken_over":
      return `took over ${s} from ${String(payload.from)}`;
    case "step.paused":
      return `${s} paused: ${String(payload.reason)}`;
    case "goal.done":
      return `${s} is done`;
    case "goal.replan":
      return `asked to replan ${s.split(".")[0]}${payload.comment ? `: ${String(payload.comment)}` : ""}`;
    case "step.released":
      return `released ${s}`;
    case "step.noted":
      return `added a note to ${s}`;
    case "step.ready":
      return `${s} is ready`;
    case "step.dropped":
      return `${s} dropped by a new plan`;
    case "question.asked":
      return `asked a question on ${s}`;
    case "question.answered":
      return `answered a question on ${s}`;
    case "session.waiting":
      return `session on ${s} waits for ${String(payload.needs ?? "input")}`;
    case "session.nudged":
      return `autopilot nudged the session on ${s}`;
    case "session.escalated":
      return `${s} stalled after nudges`;
    default:
      return `${type.replace(".", " ")} ${s}`.trim();
  }
}
