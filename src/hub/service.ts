// Hub service: the single writer (plan §8). Every mutation runs in one transaction that writes the
// state change and its event; once it commits, the bus hints SSE subscribers. Store calls are async
// (M4.6): within a transaction they are awaited in order, so events keep their order.

import { randomBytes, randomUUID } from "node:crypto";
import { AuthError, loginIdentity, pkceChallenge, randomId, Tokens, type AuthProvider, type Identity } from "../auth/index.ts";
import {
  acceptMatches,
  endOffersLeavingReady,
  machineName,
  sessionName,
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
  sessionVisible,
  type Principal,
  type Role,
} from "../core/index.ts";
import type {
  AcState,
  AssignRequest,
  AssignResult,
  GoalAssignResult,
  GoalWithdrawResult,
  OfferLine,
  OfferTarget,
  OfferView,
  StepOffer,
  Attention,
  Failure,
  Round,
  Verdict,
  DoneResult,
  Goal,
  GoalDetail,
  Topic,
  TopicView,
  InboxMessage,
  FleetMachine,
  FleetView,
  LiveSession,
  LiveView,
  MachineLabels,
  MachineLabelsView,
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
  SyncResponse,
  TimelineEntry,
  TrailFile,
  UserView,
  ServiceScope,
} from "../protocol/index.ts";
import { ALL_TOPIC, MAX_LABELS, TopicName, goalHasTopics, normalizeTopics, parseLabels } from "../protocol/index.ts";
import { HubStore, type HubSession, type MachineRow, type NewEvent, type UserRow } from "../store/index.ts";
import { LocalHintBus, type HintBus } from "./bus.ts";
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
  /** The CLI cannot receive a localhost redirect (a remote shell): show the code to paste instead. */
  cliPaste?: boolean | undefined;
  hostname?: string | undefined;
}

interface DeviceAttempt {
  provider: string;
  hostname?: string | undefined;
  client: "cli" | "web";
  /** The provider's own state for `complete` (see `StartResult`). */
  state: Record<string, unknown>;
}

interface CliCode {
  userId: string;
  roles: Role[];
  cliChallenge: string;
}

const LOGIN_TTL = 10 * 60_000;
/** How long a CLI's one-time login code lives: long enough to copy it from a browser into a terminal. */
const CLI_CODE_TTL = 5 * 60_000;
const ONLINE_MS = 2 * 60_000;

export class HubService {
  readonly store: HubStore;
  readonly config: HubConfig;
  readonly tokens: Tokens;
  /** SSE hints; across replicas when the hub runs on Postgres (see bus.ts). */
  readonly bus: HintBus;
  now: () => number;

  constructor(store: HubStore, config: HubConfig, now: () => number = () => Date.now(), opts: { bus?: HintBus } = {}) {
    this.store = store;
    this.config = config;
    this.tokens = new Tokens(store, config.policies);
    this.now = now;
    this.bus = opts.bus ?? new LocalHintBus();
  }

  // ---------- helpers ----------
  // Views that read several rows run in a transaction too, so a concurrent write never tears them.

  private async emit(e: Omit<NewEvent, "at"> & { at?: number }): Promise<void> {
    const seq = await this.store.appendEvent({ ...e, at: e.at ?? this.now() });
    if (seq !== undefined) this.store.afterCommit(() => this.bus.publish({ type: "changed", seq }));
  }

  private provider(id: string): AuthProvider {
    const p = this.config.providers.find((x) => x.id === id);
    if (!p) throw new HubError(404, `unknown auth provider "${id}"`);
    return p;
  }

  userView(u: UserRow): UserView {
    return { id: u.id, name: u.name, roles: u.roles };
  }

  private async goalOr404(id: string): Promise<Goal> {
    const g = await this.store.getGoal(id);
    if (!g) throw new HubError(404, `no goal ${id}`);
    return g;
  }

  /**
   * A transaction that reads a goal's plans or steps and then writes from what it read. It is
   * serialised against every other such transaction before its first read (`HubStore.serialize`),
   * so with several replicas on Postgres it decides from current state, as on SQLite.
   */
  private goalTx<T>(fn: () => Promise<T>): Promise<T> {
    return this.store.tx(async () => {
      await this.store.serialize();
      return await fn();
    });
  }

  private async stepOr404(id: string): Promise<Step> {
    const s = await this.store.getStep(id);
    if (!s) throw new HubError(404, `no step ${id}`);
    return s;
  }

  /**
   * Save a step's transition from the state it was read in (`prev`). Claims run in `goalTx` like the
   * other step transitions, so this is a guard: should a write outside that lock have changed the
   * step since the read, it answers 409 instead of overwriting it.
   */
  private async saveStepFrom(next: Step, prev: Step): Promise<void> {
    if (!(await this.store.saveStepIf(next, prev))) throw new HubError(409, `${prev.id} changed just now; try again`);
  }

  private async sessionOf(sid: string | undefined): Promise<Session | undefined> {
    return sid ? (await this.store.getSession(sid))?.session : undefined;
  }

  /** Queue a message for a session's machine and wake that daemon. */
  private async message(toSid: string | undefined, fromUser: string, kind: string, text: string, data?: Record<string, unknown>): Promise<number | undefined> {
    if (!toSid) return undefined;
    const hs = await this.store.getSession(toSid);
    if (!hs || hs.session.state === "ended") return undefined;
    const m = await this.store.addMessage({ toMachine: hs.machineId, toSid, fromUser, kind, text, ...(data ? { data } : {}) }, this.now());
    this.store.afterCommit(() => this.bus.publish({ type: "wake", machine: hs.machineId }));
    return m.id;
  }

  // ---------- offers (MM-3) ----------

  /**
   * The caller machine of an offer decision: the token's machine; without one, the machine of the
   * caller's own known session `sid`. `foreign`: `sid` is a session the hub has that belongs to
   * another user, or (with a machine token) to another machine. A `sid` the hub has no record of
   * is never foreign and never gives a machine.
   */
  private async callerMachine(actor: Actor, sid: string | undefined): Promise<{ machine?: MachineRow | undefined; foreign: boolean }> {
    const hs = sid ? await this.store.getSession(sid) : undefined;
    if (actor.machineId) {
      const foreign = hs !== undefined && (hs.userId !== actor.userId || hs.machineId !== actor.machineId);
      return { machine: await this.store.getMachine(actor.machineId), foreign };
    }
    const foreign = hs !== undefined && hs.userId !== actor.userId;
    return { machine: hs && !foreign ? await this.store.getMachine(hs.machineId) : undefined, foreign };
  }

  private refuseForeign(r: { foreign: boolean }, sid: string | undefined): void {
    if (r.foreign) throw new HubError(403, `session ${sid ?? ""} is not yours on this machine`);
  }

  /** A machine reference: an id, else the caller's nickname, else `<user>/<nickname>`. */
  private async findMachine(actor: Actor, ref: string): Promise<MachineRow | undefined> {
    const byId = await this.store.getMachine(ref);
    if (byId) return byId;
    const mine = await this.store.machineByNickname(actor.userId, ref);
    if (mine) return mine;
    const parts = ref.split("/");
    if (parts.length === 2 && parts[0] && parts[1]) return await this.store.machineByNickname(parts[0], parts[1]);
    return undefined;
  }

  private async machineOr404(actor: Actor, ref: string): Promise<MachineRow> {
    const m = await this.findMachine(actor, ref);
    if (!m) throw new HubError(404, `no machine ${ref}`);
    return m;
  }

  /** A session reference on a machine, among the non-ended sessions the caller may see. */
  private async findSessionOn(actor: Actor, m: MachineRow, ref: string): Promise<HubSession> {
    const all = (await this.store.listSessions({ live: true })).filter(
      (hs) => hs.machineId === m.id && hs.session.state !== "ended" && sessionVisible(actor.userId, { userId: hs.userId, step: hs.session.step }, m.share),
    );
    const bySid = all.find((hs) => hs.session.sid === ref);
    if (bySid) return bySid;
    const byName = all.filter((hs) => hs.session.name === ref);
    const hits = byName.length ? byName : ref.length >= 4 ? all.filter((hs) => hs.session.sid.startsWith(ref)) : [];
    if (hits.length === 0) throw new HubError(404, `no session ${ref} on ${machineName(m)}`);
    if (hits.length > 1) throw new HubError(409, `"${ref}" matches several sessions on ${machineName(m)}`);
    return hits[0] as HubSession;
  }

  /** `to` of an assign: `<machine>`, `<machine>/<session>`, `<user>/<nickname>` or `<user>/<nickname>/<session>`. */
  private async resolveTarget(actor: Actor, to: string): Promise<{ machine: MachineRow; session?: HubSession | undefined }> {
    const parts = to.split("/");
    if (parts.length === 1) return { machine: await this.machineOr404(actor, to) };
    if (parts.length === 2) {
      const [a, b] = parts as [string, string];
      const m = a ? await this.findMachine(actor, a) : undefined;
      if (m) return { machine: m, session: await this.findSessionOn(actor, m, b) };
      return { machine: await this.machineOr404(actor, to) };
    }
    if (parts.length === 3) {
      const [a, b, c] = parts as [string, string, string];
      const m = await this.machineOr404(actor, `${a}/${b}`);
      return { machine: m, session: await this.findSessionOn(actor, m, c) };
    }
    throw new HubError(404, `no machine ${to}`);
  }

  private async machineNameOf(id: string): Promise<string> {
    const m = await this.store.getMachine(id);
    return m ? machineName(m) : id;
  }

  /** Target text: `<machine name>` or `<machine name>/<session name>`. */
  private async targetText(to: OfferTarget): Promise<string> {
    const name = await this.machineNameOf(to.machine);
    if (!to.sid) return name;
    const hs = await this.store.getSession(to.sid);
    return `${name}/${hs ? sessionName(hs.session) : to.sid.slice(0, 8)}`;
  }

  /** The policy verdict for an offer: the named session's override, else the machine's policy. */
  private autoFor(target: { machine: MachineRow; session?: HubSession | undefined }, by: { userId: string; machine?: MachineRow | undefined }): boolean {
    const policy = target.session?.session.accept ?? target.machine.accept;
    const bm = by.machine;
    return acceptMatches(policy, { byUser: by.userId, byMachine: bm ? { id: bm.id, userId: bm.userId, ...(bm.nickname ? { nickname: bm.nickname } : {}) } : undefined }, { userId: target.machine.userId });
  }

  /** Queue a machine-wide message (`toSid: ""`) and wake that machine's daemon. */
  private async machineMessage(machine: string, fromUser: string, kind: string, text: string, data: Record<string, unknown>): Promise<void> {
    await this.store.addMessage({ toMachine: machine, toSid: "", fromUser, kind, text, data }, this.now());
    this.store.afterCommit(() => this.bus.publish({ type: "wake", machine }));
  }

  /** Offer a ready step (inside `goalTx`): set the offer, message the target machine, emit `step.offered`. */
  private async offerStep(
    step: Step,
    target: { machine: MachineRow; session?: HubSession | undefined },
    by: { userId: string; sid?: string | undefined; machine?: MachineRow | undefined },
    opts: { note?: string | undefined; stick: boolean; goal: Goal },
  ): Promise<Step> {
    const now = this.now();
    const auto = this.autoFor(target, by);
    const sid = target.session?.session.sid;
    const offer: StepOffer = {
      to: { machine: target.machine.id, ...(sid ? { sid } : {}) },
      by: by.userId,
      ...(by.sid ? { bySid: by.sid } : {}),
      ...(by.machine ? { byMachine: by.machine.id } : {}),
      at: now,
      state: "offered",
      auto,
      ...(opts.stick ? { stick: true } : {}),
      ...(opts.note ? { note: opts.note } : {}),
    };
    const next: Step = { ...step, offer, updatedAt: now };
    await this.saveStepFrom(next, step);
    await this.machineMessage(
      target.machine.id,
      by.userId,
      "offer",
      `MESH: @${by.userId} offers step ${step.id} "${step.title}" (repo ${step.repo}) to this machine${opts.note ? `: ${opts.note}` : ""}`,
      { step: step.id, goal: step.goal, repo: step.repo, topics: opts.goal.topics ?? [], auto, by: by.userId, ...(sid ? { sid } : {}), ...(opts.note ? { note: opts.note } : {}) },
    );
    await this.emit({
      type: "step.offered",
      user: by.userId,
      sid: by.sid,
      goal: step.goal,
      step: step.id,
      payload: { machine: target.machine.id, ...(sid ? { sid } : {}), auto, ...(opts.note ? { note: opts.note } : {}), ...(opts.stick ? { stick: true } : {}) },
    });
    return next;
  }

  /** A message to the offering session (none when it is absent, unknown or ended). */
  private async reportBack(step: Step, offer: StepOffer, kind: string, text: string): Promise<void> {
    await this.message(offer.bySid, offer.by, kind, text, { step: step.id, goal: step.goal });
  }

  /** Emit `step.ready`; a goal with a stick then offers the step to the stick's target. */
  private async emitReady(goalId: string, stepId: string): Promise<void> {
    await this.emit({ type: "step.ready", goal: goalId, step: stepId });
    const goal = await this.store.getGoal(goalId);
    const stick = goal?.stick;
    if (!goal || !stick) return;
    const s = await this.store.getStep(stepId);
    if (!s || s.state !== "ready" || s.kind === "gate" || s.offer?.state === "offered") return;
    const machine = await this.store.getMachine(stick.to.machine);
    if (!machine) return;
    let session: HubSession | undefined;
    if (stick.to.sid) {
      session = await this.store.getSession(stick.to.sid);
      if (!session || session.session.state === "ended" || session.machineId !== machine.id) return;
    }
    const byMachine = stick.byMachine ? await this.store.getMachine(stick.byMachine) : undefined;
    await this.offerStep(s, { machine, session }, { userId: stick.by, sid: stick.bySid, machine: byMachine }, { stick: true, goal });
  }

  /** End offers of steps that left `ready` in this transaction (`endOffersLeavingReady`). */
  private async emitOffersEnded(actor: Actor | undefined, ended: readonly Step[]): Promise<void> {
    for (const s of ended) {
      if (!s.offer) continue;
      await this.emit({ type: "step.offer_withdrawn", user: actor?.userId, goal: s.goal, step: s.id, payload: { machine: s.offer.to.machine, reason: `step ${s.state}` } });
    }
  }

  /** The claim itself (gate, parked and blind checks, the conditional save, `step.claimed`). */
  private async claimInTx(actor: Actor, step: Step, sid: string | undefined, holderMachine: string | undefined): Promise<Step> {
    if (step.kind === "gate") throw new HubError(409, `${step.id} is a gate: a person decides it (mesh step approve ${step.id}, or the web dashboard)`);
    if (step.state === "parked") throw new HubError(409, `${step.id} is parked (${step.parkedReason ?? "by a rule"}); a person resumes it (mesh step resume ${step.id})`);
    const blind = blindConflict(step, await this.store.listSteps({ goal: step.goal }), { userId: actor.userId, sid }, this.config.blindGuard);
    if (blind) throw new HubError(409, blind);
    const r = claim(step, { userId: actor.userId, sid, machine: holderMachine }, this.now());
    if (!r.ok) throw new HubError(r.status, r.error);
    const claimed: Step = r.step.roundStartedAt === undefined ? { ...r.step, roundStartedAt: this.now() } : r.step;
    // Conditional on the state read above: with several replicas, exactly one concurrent claim wins.
    if (!(await this.store.claimStep(claimed, step))) throw new HubError(409, `${step.id} was claimed by someone else just now`);
    const goal = await this.store.getGoal(step.goal);
    if (goal && step.kind === "design" && goal.state === "backlog") await this.store.saveGoal({ ...goal, state: "design", updatedAt: this.now() });
    await this.emit({ type: "step.claimed", user: actor.userId, sid, goal: step.goal, step: step.id });
    return claimed;
  }

  /** After a claim that is an accept: the offer is `accepted`, `step.accepted`, report back. */
  private async markAccepted(actor: Actor, claimed: Step, sid: string | undefined): Promise<Step> {
    const offer = claimed.offer as StepOffer;
    const now = this.now();
    const next: Step = { ...claimed, offer: { ...offer, state: "accepted", decidedAt: now } };
    await this.saveStepFrom(next, claimed);
    await this.emit({ type: "step.accepted", user: actor.userId, sid, goal: claimed.goal, step: claimed.id, payload: { machine: offer.to.machine, ...(sid ? { sid } : {}) } });
    const accepted = await this.holderText(next);
    await this.reportBack(next, offer, "offer_accepted", `MESH: ${accepted} accepted ${claimed.id} "${claimed.title}".`);
    return next;
  }

  /** `<machine name>/<session name>` of a step's holder (the machine name only without a session record). */
  private async holderText(s: Step): Promise<string> {
    const name = await this.machineNameOf(s.holderMachine ?? s.offer?.to.machine ?? "");
    const hs = s.holderSid ? await this.store.getSession(s.holderSid) : undefined;
    return hs ? `${name}/${sessionName(hs.session)}` : name;
  }

  async assignStep(actor: Actor, id: string, req: AssignRequest): Promise<AssignResult> {
    return await this.goalTx(async () => {
      const step = await this.stepOr404(id);
      if (step.kind === "gate") throw new HubError(409, `${step.id} is a gate: a person decides it`);
      if (step.state !== "ready") throw new HubError(409, `${step.id} is ${step.state}, not ready`);
      if (step.offer?.state === "offered") throw new HubError(409, `${step.id} is already offered to ${await this.targetText(step.offer.to)}; withdraw it first (mesh withdraw ${step.id})`);
      const target = await this.resolveTarget(actor, req.to);
      const caller = await this.callerMachine(actor, req.sid);
      this.refuseForeign(caller, req.sid);
      const goal = await this.goalOr404(step.goal);
      const next = await this.offerStep(step, target, { userId: actor.userId, sid: req.sid, machine: caller.machine }, { note: req.note, stick: false, goal });
      if (req.stick) await this.setStick(goal, next.offer as StepOffer);
      return { step: next, auto: (next.offer as StepOffer).auto };
    });
  }

  private async setStick(goal: Goal, o: Pick<StepOffer, "to" | "by" | "bySid" | "byMachine">): Promise<Goal> {
    const now = this.now();
    const g: Goal = { ...goal, stick: { to: o.to, by: o.by, ...(o.bySid ? { bySid: o.bySid } : {}), ...(o.byMachine ? { byMachine: o.byMachine } : {}), at: now }, updatedAt: now };
    await this.store.saveGoal(g);
    return g;
  }

  async assignGoal(actor: Actor, id: string, req: AssignRequest): Promise<GoalAssignResult> {
    return await this.goalTx(async () => {
      const goal = await this.goalOr404(id);
      if (goal.state === "done" || goal.state === "dropped") throw new HubError(409, `${goal.id} is ${goal.state}`);
      const target = await this.resolveTarget(actor, req.to);
      const caller = await this.callerMachine(actor, req.sid);
      this.refuseForeign(caller, req.sid);
      const ready = (await this.store.listSteps({ goal: goal.id }))
        .filter((s) => s.state === "ready" && s.kind !== "gate" && s.offer?.state !== "offered")
        .sort((a, b) => cmp(a.id, b.id));
      if (ready.length === 0 && !req.stick) throw new HubError(409, `${goal.id} has no ready step to offer`);
      const by = { userId: actor.userId, sid: req.sid, machine: caller.machine };
      const offered: Step[] = [];
      for (const s of ready) offered.push(await this.offerStep(s, target, by, { note: req.note, stick: false, goal }));
      const sid = target.session?.session.sid;
      const saved = req.stick
        ? await this.setStick(goal, { to: { machine: target.machine.id, ...(sid ? { sid } : {}) }, by: actor.userId, bySid: req.sid, byMachine: caller.machine?.id })
        : goal;
      return { goal: saved, steps: offered, auto: this.autoFor(target, by) };
    });
  }

  async acceptStep(actor: Actor, id: string, sid: string | undefined): Promise<Step> {
    return await this.goalTx(async () => {
      const step = await this.stepOr404(id);
      const offer = step.offer;
      if (offer?.state !== "offered") throw new HubError(409, `${step.id} has no open offer`);
      const caller = await this.callerMachine(actor, sid);
      this.refuseForeign(caller, sid);
      if (!caller.machine || caller.machine.id !== offer.to.machine) throw new HubError(403, `${step.id} is offered to ${await this.machineNameOf(offer.to.machine)}, not to this machine`);
      const claimed = await this.claimInTx(actor, step, sid, caller.machine.id);
      return await this.markAccepted(actor, claimed, sid);
    });
  }

  async declineStep(actor: Actor, id: string, note: string | undefined): Promise<Step> {
    return await this.goalTx(async () => {
      const step = await this.stepOr404(id);
      const offer = step.offer;
      if (offer?.state !== "offered") throw new HubError(409, `${step.id} has no open offer`);
      const target = await this.store.getMachine(offer.to.machine);
      const name = target ? machineName(target) : offer.to.machine;
      const caller = await this.callerMachine(actor, undefined);
      const named = offer.to.sid ? await this.store.getSession(offer.to.sid) : undefined;
      const policy = named?.session.accept ?? target?.accept;
      const cm = caller.machine;
      const allowed =
        target !== undefined &&
        (target.userId === actor.userId ||
          acceptMatches(policy, { byUser: actor.userId, byMachine: cm ? { id: cm.id, userId: cm.userId, ...(cm.nickname ? { nickname: cm.nickname } : {}) } : undefined }, { userId: target.userId }));
      if (!allowed) throw new HubError(403, `only the owner of ${name} can decline ${step.id}`);
      const now = this.now();
      const { note: _assignNote, ...rest } = offer;
      const next: Step = { ...step, offer: { ...rest, state: "declined", ...(note ? { note } : {}), decidedAt: now }, updatedAt: now };
      await this.saveStepFrom(next, step);
      await this.emit({ type: "step.declined", user: actor.userId, goal: step.goal, step: step.id, payload: { machine: offer.to.machine, ...(note ? { note } : {}) } });
      await this.reportBack(step, offer, "offer_declined", `MESH: ${name} declined ${step.id} "${step.title}"${note ? `: ${note}` : ""}. It is ready again.`);
      return next;
    });
  }

  /** End an open offer as withdrawn (inside `goalTx`). */
  private async withdrawOffer(actor: Actor, step: Step, reason?: string): Promise<Step> {
    const offer = step.offer as StepOffer;
    const now = this.now();
    const next: Step = { ...step, offer: { ...offer, state: "withdrawn", decidedAt: now }, updatedAt: now };
    await this.saveStepFrom(next, step);
    await this.emit({ type: "step.offer_withdrawn", user: actor.userId, goal: step.goal, step: step.id, payload: { machine: offer.to.machine, ...(reason ? { reason } : {}) } });
    return next;
  }

  async withdrawStep(actor: Actor, id: string): Promise<Step> {
    return await this.goalTx(async () => {
      const step = await this.stepOr404(id);
      const offer = step.offer;
      if (offer?.state !== "offered") throw new HubError(409, `${step.id} has no open offer`);
      if (actor.userId !== offer.by && !actor.roles.includes("admin")) throw new HubError(403, `only @${offer.by} or an admin can withdraw the offer of ${step.id}`);
      return await this.withdrawOffer(actor, step);
    });
  }

  async withdrawGoal(actor: Actor, id: string): Promise<GoalWithdrawResult> {
    return await this.goalTx(async () => {
      const goal = await this.goalOr404(id);
      const admin = actor.roles.includes("admin");
      const clear = goal.stick !== undefined && (goal.stick.by === actor.userId || admin);
      const open = (await this.store.listSteps({ goal: goal.id })).filter((s) => s.offer?.state === "offered" && (admin || s.offer.by === actor.userId));
      if (!clear && open.length === 0) throw new HubError(409, `${goal.id} has no stick and no open offer of yours`);
      const withdrawn: string[] = [];
      for (const s of open) withdrawn.push((await this.withdrawOffer(actor, s)).id);
      let saved = goal;
      if (clear) {
        const { stick: _s, ...rest } = goal;
        saved = { ...rest, updatedAt: this.now() };
        await this.store.saveGoal(saved);
      }
      return { goal: saved, withdrawn: withdrawn.sort(cmp) };
    });
  }

  /** Open offers on ready steps to any of the caller's machines, by offer time then step id. */
  async offers(viewer: Actor): Promise<OfferView[]> {
    return this.store.tx(async () => {
      const mine = new Set((await this.store.listMachines({ userId: viewer.userId })).map((m) => m.id));
      const out: OfferView[] = [];
      for (const s of await this.store.listSteps({ state: "ready" })) {
        const o = s.offer;
        if (o?.state !== "offered" || !mine.has(o.to.machine)) continue;
        out.push({
          step: s.id,
          goal: s.goal,
          title: s.title,
          repo: s.repo,
          kind: s.kind,
          machine: o.to.machine,
          ...(o.to.sid ? { sid: o.to.sid } : {}),
          to: await this.targetText(o.to),
          by: o.by,
          ...(o.bySid ? { bySid: o.bySid } : {}),
          ...(o.byMachine ? { byMachine: o.byMachine } : {}),
          at: o.at,
          expiresAt: o.at + this.config.thresholds.offerExpiryMs,
          auto: o.auto,
          ...(o.note ? { note: o.note } : {}),
        });
      }
      return out.sort((a, b) => a.at - b.at || cmp(a.step, b.step));
    });
  }

  // ---------- auth ----------

  providersInfo(): ProviderInfo[] {
    return this.config.providers.map((p) => ({ id: p.id, kind: p.kind, label: p.label, flows: p.flows() }));
  }

  /** Who a presented token belongs to. */
  async authenticate(token: string): Promise<Actor | undefined> {
    const row = await this.tokens.verify(token, this.now());
    if (!row) return undefined;
    const user = await this.store.getUser(row.userId);
    if (!user) return undefined;
    return { userId: user.id, roles: user.roles as Role[], scopes: row.scopes, machineId: row.machineId, tokenHash: row.hash, tokenKind: row.kind };
  }

  /**
   * The machine a CLI login is for. With an installation id (v0.1.5+): the machine with that id, else
   * this person's machine on this host that has none yet (one an older CLI made: adopted, so its
   * history stays), else a new one. So one person on two OS users or containers of a host gets two
   * machines. Without an id (an older CLI): person + hostname, as before.
   */
  private async machineFor(userId: string, hostname: string | undefined, installId?: string | undefined): Promise<string> {
    const host = hostname?.trim() || "unknown";
    const mine = await this.store.listMachines({ userId });
    const existing = installId
      ? (mine.find((m) => m.installId === installId) ?? mine.find((m) => m.hostname === host && !m.installId))
      : mine.find((m) => m.hostname === host);
    const id = existing?.id ?? `m-${randomBytes(4).toString("hex")}`;
    await this.store.upsertMachine({ id, userId, hostname: host, installId }, this.now());
    return id;
  }

  private async issue(identity: Identity, client: "cli" | "web", hostname: string | undefined, installId?: string | undefined): Promise<LoginResult> {
    return await this.store.tx(async () => {
      const { user, roles } = await loginIdentity(this.store, identity, { roleMappings: this.config.roleMappings, bootstrapAdmins: this.config.bootstrapAdmins }, this.now());
      const machine = client === "cli" ? await this.machineFor(user.id, hostname, installId) : undefined;
      const t = await this.tokens.issue(client === "cli" ? "device" : "web", user.id, this.now(), { machineId: machine, label: hostname });
      await this.emit({ type: "user.logged_in", user: user.id, payload: { provider: identity.provider, client, machine } });
      return { token: t.token, user: { id: user.id, name: user.name, roles }, machine, expiresAt: t.expiresAt };
    });
  }

  /** none/token providers. */
  async loginDirect(providerId: string, input: { token?: string | undefined; hostname?: string | undefined; install?: string | undefined; client: "cli" | "web" }): Promise<LoginResult> {
    const p = this.provider(providerId);
    const flow = p.flows().includes("none") ? "none" : "token";
    if (flow === "token" && !input.token) throw new HubError(400, "token required");
    const id = await p.complete(flow === "none" ? { flow: "none" } : { flow: "token", token: input.token as string });
    if (id === "pending") throw new HubError(500, "unexpected pending login");
    return await this.issue(id, input.client, input.hostname, input.install);
  }

  /** Redirect flow start (hub-mediated, plan §4.4). Returns the IdP URL. */
  async loginStart(
    providerId: string,
    client: "cli" | "web",
    opts: { cliPort?: number | undefined; cliChallenge?: string | undefined; cliPaste?: boolean | undefined; hostname?: string | undefined },
  ): Promise<string> {
    const p = this.provider(providerId);
    if (!p.flows().includes("redirect")) throw new HubError(400, `provider ${providerId} has no browser login`);
    if (client === "cli" && !opts.cliChallenge) throw new HubError(400, "cli_challenge is required");
    if (client === "cli" && !opts.cliPort && !opts.cliPaste) throw new HubError(400, "cli_port (or cli_mode=paste) is required");
    const state = randomId();
    const attempt: LoginAttempt = {
      provider: providerId,
      client,
      nonce: randomId(),
      verifier: randomId(32),
      redirectUri: `${this.config.url}/auth/${providerId}/callback`,
      cliPort: opts.cliPort,
      cliChallenge: opts.cliChallenge,
      cliPaste: client === "cli" && opts.cliPaste === true ? true : undefined,
      hostname: opts.hostname,
    };
    await this.store.putLoginAttempt(`state:${state}`, attempt as unknown as Record<string, unknown>, this.now());
    const r = await p.start("redirect", { state, nonce: attempt.nonce, pkceChallenge: pkceChallenge(attempt.verifier), redirectUri: attempt.redirectUri });
    if (r.kind !== "redirect") throw new HubError(500, "provider did not return a redirect");
    return r.url;
  }

  /**
   * IdP callback. Returns where to send the browser and, for web logins, the session token; for a
   * CLI in paste mode, the one-time code to show instead of a redirect.
   */
  async loginCallback(providerId: string, callbackUrl: string): Promise<{ redirect: string; webToken?: LoginResult; pasteCode?: string }> {
    const state = new URL(callbackUrl).searchParams.get("state") ?? "";
    // Read and consume the attempt in one transaction: a replayed callback finds nothing.
    const attempt = await this.store.tx(async () => {
      const a = await this.store.getLoginAttempt<LoginAttempt>(`state:${state}`, this.now(), LOGIN_TTL);
      if (!a || a.provider !== providerId) throw new HubError(400, "unknown or expired login; start again");
      // Another replica may have read it too: only the caller whose delete removed it goes on.
      if (!(await this.store.deleteLoginAttempt(`state:${state}`))) throw new HubError(400, "unknown or expired login; start again");
      return a;
    });
    const id = await this.provider(providerId).complete({ flow: "redirect", callbackUrl, pkceVerifier: attempt.verifier, state, nonce: attempt.nonce, redirectUri: attempt.redirectUri });
    if (id === "pending") throw new HubError(500, "unexpected pending login");
    if (attempt.client === "web") return { redirect: "/", webToken: await this.issue(id, "web", undefined) };
    // CLI: hand a one-time code to the CLI's localhost listener; it proves itself with its PKCE verifier.
    const code = randomId(24);
    await this.store.putLoginAttempt(`code:${code}`, { identity: id, cliChallenge: attempt.cliChallenge, hostname: attempt.hostname } as unknown as Record<string, unknown>, this.now());
    // A remote shell's CLI can't receive a redirect to its own localhost: the person pastes the code.
    // The code alone is useless without the CLI's PKCE verifier, so showing it is safe.
    if (attempt.cliPaste) return { redirect: "", pasteCode: code };
    return { redirect: `http://127.0.0.1:${attempt.cliPort}/callback?code=${encodeURIComponent(code)}` };
  }

  async cliExchange(code: string, verifier: string, hostname: string | undefined, installId?: string | undefined): Promise<LoginResult> {
    // Read and burn the code in one transaction, so it is used at most once.
    const rec = await this.store.tx(async () => {
      const r = await this.store.getLoginAttempt<{ identity: Identity; cliChallenge: string; hostname?: string } & Partial<CliCode>>(`code:${code}`, this.now(), CLI_CODE_TTL);
      // Another replica may have read it too: only the caller whose delete removed it goes on.
      if (!r || !(await this.store.deleteLoginAttempt(`code:${code}`))) return undefined;
      return r;
    });
    if (!rec || pkceChallenge(verifier) !== rec.cliChallenge) throw new HubError(401, "invalid or expired login code");
    return await this.issue(rec.identity, "cli", hostname ?? rec.hostname, installId);
  }

  async deviceStart(providerId: string, hostname: string | undefined, client: "cli" | "web" = "cli") {
    const p = this.provider(providerId);
    if (!p.flows().includes("device")) throw new HubError(400, `provider ${providerId} has no device login`);
    const r = await p.start("device", { state: "", nonce: "", pkceChallenge: "", redirectUri: "" });
    if (r.kind !== "device") throw new HubError(500, "provider did not start a device login");
    // The provider's state (the device code) lives in the database, not in this process, so the
    // CLI's polls can land on any replica. It never goes back to the client.
    const { state, ...shown } = r;
    const attempt: DeviceAttempt = { provider: providerId, hostname, client, state };
    await this.store.putLoginAttempt(`device:${r.pollId}`, attempt as unknown as Record<string, unknown>, this.now());
    return shown;
  }

  async devicePoll(providerId: string, pollId: string, hostname: string | undefined, installId?: string | undefined): Promise<LoginResult | "pending"> {
    const key = `device:${pollId}`;
    const rec = await this.store.getLoginAttempt<DeviceAttempt>(key, this.now(), LOGIN_TTL);
    if (!rec || rec.provider !== providerId) throw new HubError(404, "unknown or expired device login");
    let id: Identity | "pending";
    try {
      id = await this.provider(providerId).complete({ flow: "device", pollId, state: rec.state });
    } catch (e) {
      // A refusal or expiry ends the attempt; an unreachable identity provider may come back.
      if (!(e instanceof AuthError && e.status >= 500)) await this.store.deleteLoginAttempt(key);
      throw e;
    }
    if (id === "pending") {
      // Keep the provider's poll pacing (interval, slow_down); a no-op if the attempt is gone.
      await this.store.updateLoginAttempt(key, rec as unknown as Record<string, unknown>);
      return "pending";
    }
    // The identity provider hands out the tokens only once, so only one poll gets here.
    await this.store.deleteLoginAttempt(key);
    return await this.issue(id, rec.client, hostname ?? rec.hostname, installId);
  }

  async logout(actor: Actor): Promise<void> {
    await this.store.revokeToken(actor.tokenHash);
  }

  async me(actor: Actor): Promise<{ user: UserView; machine?: string | undefined }> {
    const u = await this.store.getUser(actor.userId) as UserRow;
    return { user: this.userView(u), machine: actor.machineId };
  }

  // ---------- goals and plans ----------

  async createGoal(
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
      topics?: string[] | undefined;
    },
  ): Promise<Goal> {
    return await this.store.tx(async () => {
      const now = this.now();
      const topics = await this.knownTopics(input.topics ?? []);
      const goal = await this.store.createGoal({
        title: input.title,
        ownerId: actor.userId,
        state: "backlog",
        ...(input.primaryRepo ? { primaryRepo: input.primaryRepo } : {}),
        ...(input.repos?.length ? { repos: input.repos } : {}),
        ...(input.issueUrl ? { issueUrl: input.issueUrl } : {}),
        ...(input.refs && Object.keys(input.refs).length ? { refs: input.refs } : {}),
        ...(input.reworks?.length ? { reworks: input.reworks } : {}),
        ...(input.preset ? { preset: input.preset } : {}),
        ...(topics.length ? { topics } : {}),
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
      await this.store.saveSteps([design]);
      await this.emit({ type: "goal.created", user: actor.userId, goal: goal.id, payload: { title: goal.title, ...(topics.length ? { topics } : {}) } });
      await this.emit({ type: "step.ready", goal: goal.id, step: design.id });
      return goal;
    });
  }

  /** All goals, or those carrying every topic in `topics` (`all` matches every goal). */
  async listGoals(topics: readonly string[] = []): Promise<Goal[]> {
    const want = await this.knownTopics(topics);
    return (await this.store.listGoals()).filter((g) => goalHasTopics(g, want));
  }

  // ---------- topics ----------

  /** `all` first (every goal), then the defined topics by name, each with its number of goals. */
  async listTopics(): Promise<TopicView[]> {
    return this.store.tx(async () => {
      const goals = await this.store.listGoals();
      const count = new Map<string, number>();
      for (const g of goals) for (const t of g.topics ?? []) count.set(t, (count.get(t) ?? 0) + 1);
      const defined = (await this.store.listTopics()).map((t) => ({ ...t, goals: count.get(t.name) ?? 0 }));
      return [{ name: ALL_TOPIC, description: "every goal", goals: goals.length }, ...defined];
    });
  }

  async createTopic(actor: Actor, input: { name: string; description?: string | undefined }): Promise<TopicView> {
    const name = topicName(input.name);
    if (name === ALL_TOPIC) throw new HubError(409, `"${ALL_TOPIC}" is built in: every goal is in it`);
    return await this.store.tx(async () => {
      const topic: Topic = { name, ...(input.description?.trim() ? { description: input.description.trim() } : {}), createdBy: actor.userId, createdAt: this.now() };
      if (!(await this.store.createTopic(topic))) throw new HubError(409, `topic ${name} exists`);
      await this.emit({ type: "topic.created", user: actor.userId, payload: { topic: name } });
      return { ...topic, goals: 0 };
    });
  }

  /** Delete a topic (its creator or an admin) and take it off every goal. */
  async deleteTopic(actor: Actor, raw: string): Promise<{ name: string; goals: string[] }> {
    const name = topicName(raw);
    if (name === ALL_TOPIC) throw new HubError(409, `"${ALL_TOPIC}" is built in and can't be deleted`);
    return await this.store.tx(async () => {
      await this.store.serialize();
      const topic = await this.store.getTopic(name);
      if (!topic) throw new HubError(404, `no topic ${name}`);
      if (topic.createdBy !== actor.userId && !actor.roles.includes("admin")) throw new HubError(403, `only ${topic.createdBy} or an admin can delete topic ${name}`);
      const now = this.now();
      const touched: string[] = [];
      for (const g of await this.store.listGoals()) {
        if (!g.topics?.includes(name)) continue;
        const rest = g.topics.filter((t) => t !== name);
        const { topics: _drop, ...without } = g;
        await this.store.saveGoal({ ...without, ...(rest.length ? { topics: rest } : {}), updatedAt: now });
        touched.push(g.id);
      }
      await this.store.deleteTopic(name);
      await this.emit({ type: "topic.deleted", user: actor.userId, payload: { topic: name, goals: touched } });
      return { name, goals: touched };
    });
  }

  /** Tag or untag a goal. Any member may: topics are shared labels, not ownership. */
  async changeGoalTopics(actor: Actor, id: string, change: { add: string[]; remove: string[] }): Promise<Goal> {
    return await this.store.tx(async () => {
      await this.store.serialize();
      const goal = await this.goalOr404(id);
      const add = await this.knownTopics(change.add);
      const remove = new Set(normalizeTopics(change.remove.map(topicName)));
      const before = goal.topics ?? [];
      const after = normalizeTopics([...before.filter((t) => !remove.has(t)), ...add]);
      if (after.join(",") === before.join(",")) return goal;
      const { topics: _old, ...rest } = goal;
      const next: Goal = { ...rest, ...(after.length ? { topics: after } : {}), updatedAt: this.now() };
      await this.store.saveGoal(next);
      await this.emit({
        type: "goal.topics",
        user: actor.userId,
        goal: goal.id,
        payload: { added: after.filter((t) => !before.includes(t)), removed: before.filter((t) => !after.includes(t)), topics: after },
      });
      return next;
    });
  }

  /** Normalised topic names that all exist (400 naming the unknown ones). `all` is dropped. */
  private async knownTopics(names: readonly string[]): Promise<string[]> {
    const want = normalizeTopics(names.map(topicName));
    if (want.length === 0) return [];
    const defined = new Set((await this.store.listTopics()).map((t) => t.name));
    const unknown = want.filter((t) => !defined.has(t));
    if (unknown.length) throw new HubError(400, `unknown topic${unknown.length > 1 ? "s" : ""} ${unknown.join(", ")} (define with: mesh topic add <name>)`);
    return want;
  }

  async goalDetail(id: string): Promise<GoalDetail> {
    return this.store.tx(async () => {
      const goal = await this.goalOr404(id);
      const steps = await this.store.listSteps({ goal: goal.id });
      const holders: NonNullable<GoalDetail["holders"]> = {};
      for (const s of steps) {
        if (!s.holderSid || (s.state !== "claimed" && s.state !== "paused")) continue;
        const hs = await this.store.getSession(s.holderSid);
        if (hs) holders[s.id] = { sid: hs.session.sid, state: hs.session.state, ...(hs.session.needs ? { needs: hs.session.needs } : {}), ...(hs.session.agent ? { agent: hs.session.agent } : {}), user: hs.userId };
      }
      const offers: Record<string, OfferLine> = {};
      for (const s of steps) {
        const o = s.offer;
        if (!o) continue;
        offers[s.id] = {
          to: await this.targetText(o.to),
          state: o.state,
          by: o.by,
          at: o.at,
          ...(o.state === "accepted" ? { accepted: await this.holderText(s) } : {}),
          ...(o.note ? { note: o.note } : {}),
        };
      }
      return {
        goal,
        steps,
        plans: await this.store.listPlans(goal.id),
        holders,
        ...(Object.keys(offers).length ? { offers } : {}),
        ...(goal.stick ? { stick: await this.targetText(goal.stick.to) } : {}),
      };
    });
  }

  /**
   * The trail files for a goal, as they should be committed: goal.yaml (with its roll-up once done),
   * every plan version and the design step's record once the design is done.
   */
  async goalFiles(id: string): Promise<TrailFile[]> {
    return this.store.tx(async () => {
      const goal = await this.goalOr404(id);
      const files = [await this.goalYaml(goal), ...(await this.store.listPlans(goal.id)).map(planFile)];
      const steps = await this.store.listSteps({ goal: goal.id });
      // Steps no agent session closes: the design (on approval) and gates (a person decides).
      for (const st of steps) if ((st.kind === "design" || st.kind === "gate") && (st.rounds?.length ?? 0) > 0 && st.state !== "dropped") files.push(await this.recordOf(st, steps));
      return files;
    });
  }

  private async goalYaml(goal: Goal): Promise<TrailFile> {
    if (goal.state !== "done") return goalFile(goal);
    const steps = await this.store.listSteps({ goal: goal.id });
    const events = await this.store.eventsFor({ goal: goal.id });
    const facts = new Map(steps.map((st) => [st.id, stepFacts(st, events)]));
    const doneAt = events.filter((e) => e.type === "goal.done").at(-1)?.at ?? goal.updatedAt;
    return goalFile(goal, goalRollup(goal, steps, await this.store.listPlans(goal.id), facts, doneAt), doneAt);
  }

  private async recordOf(step: Step, steps?: readonly Step[]): Promise<TrailFile> {
    steps ??= await this.store.listSteps({ goal: step.goal });
    const plan = (await this.store.listPlans(step.goal)).find((p) => p.version === step.planVersion);
    return stepRecord(step, stepFacts(step, await this.store.eventsFor({ step: step.id })), (await this.store.listNotes(step.id)).filter((n) => !n.text.startsWith("Reopened by")), plan, blindSeparated(step, steps));
  }

  async stepView(id: string): Promise<StepView> {
    return this.store.tx(async () => {
      const context = await this.context(id);
      return { context, facts: stepFacts(context.step, await this.store.eventsFor({ step: context.step.id })) };
    });
  }

  async timeline(goalId: string): Promise<TimelineEntry[]> {
    return this.store.tx(async () => {
      const goal = await this.goalOr404(goalId);
      return (await this.store.eventsFor({ goal: goal.id }))
        .filter((e) => !e.type.startsWith("session.turn") && e.type !== "message.delivered")
        .map((e) => ({ seq: e.seq, at: e.at, type: e.type, user: e.user, step: e.step, text: describe(e.type, e.step ?? e.goal, e.payload) }));
    });
  }

  /** Reopen the design (plan §3.4 replan): a new plan version replaces steps not yet done. */
  async replan(actor: Actor, goalId: string, comment: string | undefined): Promise<GoalDetail> {
    await this.goalTx(async () => {
      const goal = await this.goalOr404(goalId);
      if (!isOwnerOrAdmin(actor, goal.ownerId) && !actor.roles.includes("approver")) throw new HubError(403, `only the goal owner, approvers or admins can replan ${goal.id}`);
      if (goal.state === "done" || goal.state === "dropped") throw new HubError(409, `${goal.id} is ${goal.state}`);
      const design = await this.store.getStep(`${goal.id}.design`);
      if (!design) throw new HubError(404, `${goal.id} has no design step`);
      const now = this.now();
      const reopened: Step = { ...design, state: "ready", updatedAt: now };
      delete reopened.outcome;
      const previousSid = design.holderSid;
      delete reopened.holderUser;
      delete reopened.holderSid;
      delete reopened.holderMachine;
      delete reopened.claimedAt;
      // MM-3: a later holder's work is not reported to the offerer of an accepted offer.
      if (reopened.offer?.state === "accepted") delete reopened.offer;
      await this.saveStepFrom(reopened, design);
      await this.store.addNote({ step: reopened.id, user: actor.userId, text: `Replan requested${comment ? `: ${comment}` : ""}`, at: now });
      await this.store.saveGoal({ ...goal, state: "design", updatedAt: now });
      await this.message(previousSid, actor.userId, "replan", `MESH: ${actor.userId} asked to replan ${goal.id}${comment ? `: ${comment}` : ""}. Claim ${reopened.id} with mesh_claim, update the design and propose a new plan with mesh_plan.`);
      await this.emit({ type: "goal.replan", user: actor.userId, goal: goal.id, step: reopened.id, payload: { comment } });
      await this.emitReady(goal.id, reopened.id);
    });
    return await this.goalDetail(goalId);
  }

  async proposePlan(actor: Actor, goalId: string, input: PlanInput & { approve: boolean }): Promise<{ plan: Plan; detail?: GoalDetail; warnings?: string[] }> {
    const result = await this.goalTx(async () => {
      const goal = await this.goalOr404(goalId);
      if (goal.state === "done" || goal.state === "dropped") throw new HubError(409, `${goal.id} is ${goal.state}`);
      const errors = [...validatePlan(input.steps), ...validatePolicies(input.steps, input.acs)];
      if (errors.length) throw new HubError(422, `the plan has ${errors.length} problem(s): ${errors.join("; ")}`, errors);
      const plans = await this.store.listPlans(goal.id);
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
      for (const p of plans) if (p.decision === "pending") await this.store.savePlan({ ...p, decision: "superseded", decidedAt: now });
      await this.store.savePlan(plan);
      if (goal.state !== "in_progress") await this.store.saveGoal({ ...goal, state: "awaiting_approval", updatedAt: now });
      await this.emit({ type: "plan.proposed", user: actor.userId, goal: goal.id, payload: { version: plan.version, steps: plan.steps.length } });
      return plan;
    });
    const goal = await this.goalOr404(goalId);
    let warnings: string[] = [];
    if (goal.preset) {
      try {
        warnings = presetWarnings(parsePreset(goal.preset.name, goal.preset.text), input.steps);
      } catch {
        warnings = [`template ${goal.preset.name} could not be read; not compared`];
      }
    }
    const w = warnings.length ? { warnings } : {};
    if (input.approve) return { plan: result, detail: await this.approvePlan(actor, goalId, result.version), ...w };
    return { plan: result, ...w };
  }

  async approvePlan(actor: Actor, goalId: string, version?: number, comment?: string): Promise<GoalDetail> {
    await this.goalTx(async () => {
      const goal = await this.goalOr404(goalId);
      if (!canApprove(actor, goal.ownerId)) throw new HubError(403, `only the goal owner, approvers or admins can approve ${goal.id}`);
      const plans = await this.store.listPlans(goal.id);
      const plan = version ? plans.find((p) => p.version === version) : plans.filter((p) => p.decision === "pending").at(-1);
      if (!plan) throw new HubError(404, `no pending plan for ${goal.id}`);
      if (plan.decision !== "pending") throw new HubError(409, `plan v${plan.version} is already ${plan.decision}`);
      const now = this.now();
      await this.store.savePlan({ ...plan, decision: "approved", decidedBy: actor.userId, decidedAt: now, ...(comment ? { comment } : {}) });
      const existing = await this.store.listSteps({ goal: goal.id });
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
        await this.emit({ type: "step.done", user: actor.userId, goal: goal.id, step: d.id, payload: { summary: d.summary } });
        if (design.offer?.state === "accepted") {
          await this.reportBack(design, design.offer, "offer_done", `MESH: ${design.id} "${design.title}" (offered to ${await this.machineNameOf(design.offer.to.machine)}) is done: ${d.summary ?? ""}`);
        }
      }
      const designSid = design?.holderSid;
      await this.message(
        designSid,
        actor.userId,
        "plan_approved",
        `MESH: plan v${plan.version} for ${goal.id} was approved by ${actor.userId}${comment ? ` (${comment})` : ""}. mesh updated .mesh/goals/${goal.id}/plan.v${plan.version}.yaml with the approval; commit it with the design. The steps are open now.`,
        { goal: goal.id, version: plan.version },
      );
      const first = endOffersLeavingReady(existing, changes, now);
      await this.store.saveSteps(first.steps);
      const afterFirst = await this.store.listSteps({ goal: goal.id });
      const second = endOffersLeavingReady(afterFirst, recomputeReady(afterFirst, now), now);
      const ready = second.steps;
      await this.store.saveSteps(ready);
      const fresh = await this.store.getGoal(goal.id);
      await this.store.saveGoal({ ...(fresh ?? goal), state: "in_progress", updatedAt: now });
      await this.emit({ type: "plan.approved", user: actor.userId, goal: goal.id, payload: { version: plan.version } });
      await this.emitOffersEnded(actor, [...first.ended, ...second.ended]);
      for (const s of [...m.upserts, ...ready].filter((x) => x.state === "ready")) await this.emitReady(goal.id, s.id);
      for (const s of m.upserts.filter((x) => x.state === "dropped")) await this.emit({ type: "step.dropped", goal: goal.id, step: s.id });
      for (const s of m.changedForHolder) {
        await this.message(s.holderSid, actor.userId, "replan", `MESH: the brief of your step ${s.id} changed in plan v${plan.version}. Call mesh_context to read it.`);
      }
    });
    return await this.goalDetail(goalId);
  }

  async revisePlan(actor: Actor, goalId: string, comment: string | undefined): Promise<GoalDetail> {
    await this.goalTx(async () => {
      const goal = await this.goalOr404(goalId);
      if (!canApprove(actor, goal.ownerId)) throw new HubError(403, `only the goal owner, approvers or admins can revise ${goal.id}`);
      const plan = (await this.store.listPlans(goal.id)).filter((p) => p.decision === "pending").at(-1);
      if (!plan) throw new HubError(404, `no pending plan for ${goal.id}`);
      const now = this.now();
      await this.store.savePlan({ ...plan, decision: "revised", decidedBy: actor.userId, decidedAt: now, ...(comment ? { comment } : {}) });
      if (goal.state === "awaiting_approval") await this.store.saveGoal({ ...goal, state: "design", updatedAt: now });
      const design = await this.store.getStep(`${goal.id}.design`);
      await this.message(design?.holderSid, actor.userId, "plan_revised", `MESH: plan v${plan.version} for ${goal.id} needs changes: ${comment ?? "(no comment)"}. Update the design and propose again with mesh_plan.`, { goal: goal.id, version: plan.version });
      await this.emit({ type: "plan.revised", user: actor.userId, goal: goal.id, payload: { version: plan.version, comment } });
    });
    return await this.goalDetail(goalId);
  }

  // ---------- steps ----------

  /**
   * Steps, filtered. MM-3: with `ready` and a `viewer`, steps with an open offer to another machine
   * than the viewer's token machine are left out (unless the viewer made the offer), and steps
   * offered to the viewer's machine come first.
   */
  async listSteps(filter: { goal?: string | undefined; ready?: boolean; repo?: string | undefined; mine?: string | undefined }, viewer?: { userId: string; machineId?: string | undefined }): Promise<Step[]> {
    let steps = await this.store.listSteps({ goal: filter.goal, state: filter.ready ? "ready" : undefined, holderUser: filter.mine });
    if (filter.repo) {
      const want = filter.repo;
      steps = steps.filter((s) => !s.repo || s.repo === want || repoMatches({ id: want, name: want.slice(want.lastIndexOf("/") + 1) }, s.repo) || repoMatches({ id: s.repo, name: s.repo.slice(s.repo.lastIndexOf("/") + 1) }, want));
    }
    if (filter.ready && viewer) {
      const here = (s: Step) => s.offer?.state === "offered" && viewer.machineId !== undefined && s.offer.to.machine === viewer.machineId;
      steps = steps.filter((s) => s.offer?.state !== "offered" || here(s) || s.offer.by === viewer.userId);
      steps = [...steps.filter(here), ...steps.filter((s) => !here(s))];
    }
    return steps;
  }

  /** A step's context. `forAgent`: what the agent holding it may see (blind and reads rules, M4.5). */
  async context(stepId: string, forAgent = false): Promise<StepContext> {
    return this.store.tx(async () => {
      const step = await this.stepOr404(stepId);
      const goal = await this.goalOr404(step.goal);
      const plan = (await this.store.listPlans(goal.id)).filter((p) => p.decision === "approved").at(-1);
      const deps: Step[] = [];
      for (const d of step.deps) {
        const s = await this.store.getStep(d);
        if (s) deps.push(s);
      }
      const acs = plan?.acs?.length ? (step.policy?.acs?.length ? plan.acs.filter((a) => step.policy?.acs?.includes(a.id)) : plan.acs) : undefined;
      const ctx: StepContext = {
        step,
        goal,
        designRef: plan?.designRef,
        deps: deps.map((d) => ({ id: d.id, title: d.title, state: d.state, summary: d.summary, branch: d.branch, mr: d.mr })),
        notes: await this.store.listNotes(step.id),
        openQuestions: (await this.store.openQuestions()).filter((q) => q.step === step.id),
        ...(acs ? { acs } : {}),
      };
      return forAgent ? agentContext(ctx, await this.store.listSteps({ goal: goal.id })) : ctx;
    });
  }

  private async machineOf(actor: Actor, sid: string | undefined): Promise<string | undefined> {
    return (sid ? (await this.store.getSession(sid))?.machineId : undefined) ?? actor.machineId;
  }

  /**
   * Claim a step. MM-3: runs in `goalTx`, so it never erases an offer committed before it. While the
   * step has an open offer: a claim from the target machine is an accept, a claim by the offerer
   * from elsewhere withdraws the offer, any other claim is refused.
   */
  async claimStep(actor: Actor, stepId: string, sid: string | undefined): Promise<Step> {
    return await this.goalTx(async () => {
      const step = await this.stepOr404(stepId);
      const offer = step.offer;
      if (offer?.state !== "offered") return await this.claimInTx(actor, step, sid, await this.machineOf(actor, sid));
      const caller = await this.callerMachine(actor, sid);
      this.refuseForeign(caller, sid);
      if (caller.machine && caller.machine.id === offer.to.machine) {
        const claimed = await this.claimInTx(actor, step, sid, caller.machine.id);
        return await this.markAccepted(actor, claimed, sid);
      }
      if (actor.userId === offer.by) {
        const claimed = await this.claimInTx(actor, step, sid, await this.machineOf(actor, sid));
        return await this.withdrawOffer(actor, claimed, "claimed by the offerer");
      }
      throw new HubError(409, `${step.id} is offered to ${await this.machineNameOf(offer.to.machine)}`);
    });
  }

  async releaseStep(actor: Actor, stepId: string, note: string | undefined): Promise<Step> {
    return await this.goalTx(async () => {
      const step = await this.stepOr404(stepId);
      const goal = await this.goalOr404(step.goal);
      const r = release(step, { userId: actor.userId }, isOwnerOrAdmin(actor, goal.ownerId), this.now());
      if (!r.ok) throw new HubError(r.status, r.error);
      const next: Step = { ...r.step };
      // MM-3: a later holder's work is not reported to the offerer of an accepted offer.
      if (next.offer?.state === "accepted") delete next.offer;
      await this.saveStepFrom(next, step);
      if (note) await this.store.addNote({ step: step.id, user: actor.userId, text: note, at: this.now() });
      await this.emit({ type: "step.released", user: actor.userId, goal: step.goal, step: step.id, payload: { note } });
      return next;
    });
  }

  async noteStep(actor: Actor, stepId: string, text: string, sid: string | undefined) {
    return await this.store.tx(async () => {
      const step = await this.stepOr404(stepId);
      const note = await this.store.addNote({ step: step.id, user: actor.userId, ...(sid ? { sid } : {}), text, at: this.now() });
      await this.emit({ type: "step.noted", user: actor.userId, sid, goal: step.goal, step: step.id });
      return note;
    });
  }

  async doneStep(
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
  ): Promise<DoneResult> {
    return await this.goalTx(async () => {
      const step = await this.stepOr404(stepId);
      const goal = await this.goalOr404(step.goal);
      if (step.kind === "gate") throw new HubError(409, `${step.id} is a gate: a person decides it (mesh step approve ${step.id})`);
      const now = input.at !== undefined && input.at <= this.now() && input.at > this.now() - 30 * 86_400_000 ? input.at : this.now();
      const explicit = input.reopen.map((r) => (r.includes(".") ? r : `${step.goal}.${r}`));
      const all = await this.store.listSteps({ goal: step.goal });
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
      const plan = (await this.store.listPlans(step.goal)).find((p) => p.version === step.planVersion);
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
        await this.saveStepFrom(kept, step);
        await this.emit({ at: now, type: "step.rejected", user: actor.userId, sid: input.sid, goal: step.goal, step: step.id, payload: { reason: decision.reason, missing: decision.missing } });
        return { step: kept, reopened: [], nowReady: [], goalDone: false, rejected: decision.reason };
      }
      if (decision.action === "park") {
        const parked: Step = { ...step, state: "parked", parkedReason: decision.reason, parkedAt: now, summary: input.summary, outcome: "fail", rounds: [...(step.rounds ?? []), { ...round, parked: decision.reason }], updatedAt: now };
        delete parked.holderUser;
        delete parked.holderSid;
        delete parked.holderMachine;
        delete parked.claimedAt;
        delete parked.roundStartedAt;
        await this.saveStepFrom(parked, step);
        await this.emit({ at: now, type: "step.parked", user: actor.userId, sid: input.sid, goal: step.goal, step: step.id, payload: { reason: decision.reason, round: round.n } });
        return { step: parked, reopened: [], nowReady: [], goalDone: false, parked: decision.reason, record: await this.recordOf(parked, all) };
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
      await this.saveStepFrom(r.step, step);
      const others = endOffersLeavingReady(all, [...changed.values()].filter((s) => s.id !== r.step.id), now);
      await this.store.saveSteps(others.steps);
      await this.emitOffersEnded(actor, others.ended);
      await this.emit({
        at: now,
        type: outcome === "done" ? "step.done" : "step.failed",
        user: actor.userId,
        sid: input.sid,
        goal: step.goal,
        step: step.id,
        payload: { summary: input.summary, mr: input.mr, reopen: toReopen, round: round.n, ...(input.model ? { model: input.model } : {}), ...(input.verdict ? { verdict: input.verdict } : {}), ...(input.failures?.length ? { buckets: input.failures.map((f) => f.bucket) } : {}) },
      });
      if (step.offer?.state === "accepted") {
        const name = await this.machineNameOf(step.offer.to.machine);
        await this.reportBack(step, step.offer, outcome === "done" ? "offer_done" : "offer_failed", `MESH: ${step.id} "${step.title}" (offered to ${name}) ${outcome === "done" ? "is done" : "failed"}: ${input.summary}`);
      }
      const why = reopenText(step, round, input.summary);
      for (const s of reopened) {
        const before = all.find((x) => x.id === s.id);
        await this.emit({ type: "step.reopened", user: actor.userId, goal: step.goal, step: s.id, payload: { by: step.id, reason: why, fixCycles: s.fixCycles, ...(input.failures?.length ? { buckets: input.failures.map((f) => f.bucket) } : {}) } });
        await this.store.addNote({ step: s.id, user: actor.userId, text: `Reopened by ${step.id}: ${why}`, at: now });
        await this.message(before?.holderSid, actor.userId, "reopened", `MESH: step ${s.id} was reopened by ${step.id}: ${why}. Claim it again with mesh_claim to fix it.`);
      }
      const nowReady = [...changed.values()].filter((s) => s.state === "ready").map((s) => s.id);
      for (const id of nowReady) await this.emitReady(step.goal, id);
      const goalDone = steps.length > 0 && steps.every((s) => s.state === "done" || s.state === "dropped") && steps.some((s) => s.kind !== "design");
      let files: TrailFile[] | undefined;
      if (goalDone && goal.state !== "done") {
        const doneGoal: Goal = { ...goal, state: "done", updatedAt: now };
        await this.store.saveGoal(doneGoal);
        await this.emit({ at: now, type: "goal.done", goal: goal.id });
        files = [await this.goalYaml(doneGoal)];
      }
      const record = await this.recordOf(r.step, steps);
      return { step: r.step, reopened: reopened.map((s) => s.id), nowReady, goalDone, record, ...(files ? { files } : {}) };
    });
  }

  /** A person (or a recorded rule) decides a gate step (M4.5). */
  async decideGate(actor: Actor, stepId: string, input: { approve: boolean; comment?: string | undefined; rule?: string | undefined; inputs?: Record<string, unknown> | undefined; reopen?: string[] | undefined }): Promise<DoneResult> {
    return await this.goalTx(async () => {
      const step = await this.stepOr404(stepId);
      const goal = await this.goalOr404(step.goal);
      if (step.kind !== "gate") throw new HubError(409, `${step.id} is not a gate step`);
      if (!canApprove(actor, goal.ownerId)) throw new HubError(403, `only the goal owner, approvers or admins decide ${step.id}`);
      if (step.state !== "ready") throw new HubError(409, `${step.id} is ${step.state}; a gate is decided when its dependencies are done`);
      const now = this.now();
      const all = await this.store.listSteps({ goal: step.goal });
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
      await this.saveStepFrom(decided, step);
      const others = endOffersLeavingReady(all, [...changed.values()].filter((s) => s.id !== decided.id), now);
      await this.store.saveSteps(others.steps);
      await this.emitOffersEnded(actor, others.ended);
      await this.emit({ type: input.approve ? "gate.approved" : "gate.rejected", user: actor.userId, goal: step.goal, step: step.id, payload: { gate: step.policy?.gate, rule: input.rule, comment: input.comment, reopen: explicit } });
      for (const s of reopenChanges.filter((x) => explicit.includes(x.id))) {
        await this.store.addNote({ step: s.id, user: actor.userId, text: `Reopened by gate ${step.id}: ${input.comment ?? "changes requested"}`, at: now });
        await this.emit({ type: "step.reopened", user: actor.userId, goal: step.goal, step: s.id, payload: { by: step.id, reason: input.comment, fixCycles: s.fixCycles } });
      }
      const nowReady = [...changed.values()].filter((s) => s.state === "ready").map((s) => s.id);
      for (const id of nowReady) await this.emitReady(step.goal, id);
      const goalDone = steps.every((s) => s.state === "done" || s.state === "dropped") && steps.some((s) => s.kind !== "design");
      let files: TrailFile[] | undefined;
      if (goalDone && goal.state !== "done") {
        const doneGoal: Goal = { ...goal, state: "done", updatedAt: now };
        await this.store.saveGoal(doneGoal);
        await this.emit({ type: "goal.done", goal: goal.id });
        files = [await this.goalYaml(doneGoal)];
      }
      return { step: decided, reopened: explicit, nowReady, goalDone, record: await this.recordOf(decided, steps), ...(files ? { files } : {}) };
    });
  }

  /** A person lets a parked step go on: it waits for its dependencies again, rounds are kept. */
  async resumeStep(actor: Actor, stepId: string, comment: string | undefined): Promise<Step> {
    return await this.goalTx(async () => {
      const step = await this.stepOr404(stepId);
      const goal = await this.goalOr404(step.goal);
      if (!canApprove(actor, goal.ownerId)) throw new HubError(403, `only the goal owner, approvers or admins resume ${step.id}`);
      if (step.state !== "parked" && step.state !== "failed") throw new HubError(409, `${step.id} is ${step.state}, not parked or failed`);
      const now = this.now();
      const next: Step = { ...step, state: "blocked", updatedAt: now };
      delete next.parkedReason;
      delete next.parkedAt;
      delete next.outcome;
      const before = await this.store.listSteps({ goal: step.goal });
      const all = before.map((s) => (s.id === step.id ? next : s));
      const ready = recomputeReady(all, now);
      const final = ready.find((x) => x.id === step.id) ?? next;
      await this.saveStepFrom(final, step);
      const others = endOffersLeavingReady(before, ready.filter((x) => x.id !== step.id), now);
      await this.store.saveSteps(others.steps);
      await this.emitOffersEnded(actor, others.ended);
      await this.store.addNote({ step: step.id, user: actor.userId, text: `Resumed by ${actor.userId}${comment ? `: ${comment}` : ""} (was: ${step.parkedReason ?? step.state})`, at: now });
      await this.emit({ type: "step.resumed", user: actor.userId, goal: step.goal, step: step.id, payload: { comment, was: step.parkedReason } });
      if (final.state === "ready") await this.emitReady(step.goal, step.id);
      return (await this.store.getStep(step.id)) ?? final;
    });
  }

  async takeStep(actor: Actor, stepId: string, sid: string | undefined): Promise<Step> {
    return await this.goalTx(async () => {
      const step = await this.stepOr404(stepId);
      const goal = await this.goalOr404(step.goal);
      const holder = await this.sessionOf(step.holderSid);
      const stalledSince = holder?.state === "stalled" ? (holder.lastStopAt ?? holder.lastEventAt) : undefined;
      const previous = step.holderUser;
      const previousSid = step.holderSid;
      const r = takeOver(step, { userId: actor.userId, sid, machine: await this.machineOf(actor, sid) }, {
        privileged: isOwnerOrAdmin(actor, goal.ownerId),
        stalledSince,
        now: this.now(),
        rules: { takeoverAfterMs: this.config.thresholds.takeoverAfterMs },
      });
      if (!r.ok) throw new HubError(r.status, r.error);
      const taken: Step = { ...r.step };
      // MM-3: a later holder's work is not reported to the offerer of an accepted offer.
      if (taken.offer?.state === "accepted") delete taken.offer;
      await this.saveStepFrom(taken, step);
      if (previous && previous !== actor.userId) {
        await this.emit({ type: "step.taken_over", user: actor.userId, sid, goal: step.goal, step: step.id, payload: { from: previous } });
        await this.message(previousSid, actor.userId, "taken_over", `MESH: ${actor.userId} took over step ${step.id}. Stop working on it; your notes are kept.`);
      }
      return taken;
    });
  }

  // ---------- questions and messages ----------

  async ask(actor: Actor, input: { text: string; sid?: string | undefined; step?: string | undefined }): Promise<Question> {
    return await this.store.tx(async () => {
      const step = input.step ? await this.store.getStep(input.step) : undefined;
      const owner = step ? (await this.store.getGoal(step.goal))?.ownerId : undefined;
      // MM-3: the offerer of an accepted offer may answer questions on the step.
      const offer = step?.offer?.state === "accepted" ? step.offer : undefined;
      const q = await this.store.addQuestion({
        ...(step ? { step: step.id } : {}),
        ...(input.sid ? { sid: input.sid } : {}),
        fromUser: actor.userId,
        toUsers: [...new Set([actor.userId, ...(owner ? [owner] : []), ...(offer ? [offer.by] : [])])],
        text: input.text,
        at: this.now(),
      });
      await this.emit({ type: "question.asked", user: actor.userId, sid: input.sid, goal: step?.goal, step: step?.id, payload: { question: q.id } });
      if (step && offer) {
        const name = await this.machineNameOf(offer.to.machine);
        await this.reportBack(step, offer, "offer_question", `MESH: question on ${step.id} (offered to ${name}) from @${actor.userId}: ${input.text}. Answer with: mesh answer ${q.id} <text>`);
      }
      return q;
    });
  }

  async answer(actor: Actor, id: number, text: string): Promise<Question> {
    return await this.store.tx(async () => {
      const q = await this.store.getQuestion(id);
      if (!q) throw new HubError(404, `no question ${id}`);
      if (q.answer !== undefined) throw new HubError(409, `question ${id} is already answered`);
      if (!q.toUsers.includes(actor.userId) && !actor.roles.includes("admin")) throw new HubError(403, `question ${id} is not addressed to you`);
      const answered: Question = { ...q, answer: text, answeredBy: actor.userId, answeredAt: this.now() };
      await this.store.saveQuestion(answered);
      await this.message(q.sid, actor.userId, "answer", `MESH: answer from ${actor.userId} to your question "${q.text}": ${text}`);
      await this.emit({ type: "question.answered", user: actor.userId, step: q.step, payload: { question: id } });
      return answered;
    });
  }

  async say(actor: Actor, input: { toSid?: string | undefined; toStep?: string | undefined; text: string }): Promise<{ id: number; toSid: string }> {
    return await this.store.tx(async () => {
      const sid = input.toSid ?? (input.toStep ? (await this.stepOr404(input.toStep)).holderSid : undefined);
      if (!sid) throw new HubError(409, `${input.toStep} has no session holding it`);
      if (input.toSid !== undefined) {
        // MM-1: a session the caller cannot see answers like an unknown one; nothing is queued.
        const hs = await this.store.getSession(input.toSid);
        const share = hs ? (await this.store.getMachine(hs.machineId))?.share : undefined;
        if (hs && !sessionVisible(actor.userId, { userId: hs.userId, step: hs.session.step }, share)) throw new HubError(404, `session ${sid} is not live on any machine`);
      }
      const id = await this.message(sid, actor.userId, "say", input.text);
      if (id === undefined) throw new HubError(404, `session ${sid} is not live on any machine`);
      await this.emit({ type: "message.sent", user: actor.userId, sid, payload: { id } });
      return { id, toSid: sid };
    });
  }

  // ---------- daemon sync and inbox ----------

  async sync(actor: Actor, req: SyncRequest): Promise<SyncResponse> {
    if (!actor.machineId) throw new HubError(403, "sync needs a device token (mesh login)");
    const machine = actor.machineId;
    return await this.store.tx(async () => {
      const now = this.now();
      let accepted = 0;
      for (const e of req.events) {
        const seq = await this.store.appendEvent({ id: e.id, at: e.at, type: e.type, user: actor.userId, sid: e.sid, step: e.step, payload: { ...e.payload, machine } });
        if (seq !== undefined) {
          accepted++;
          this.store.afterCommit(() => this.bus.publish({ type: "changed", seq }));
        }
      }
      for (const s of req.sessions) {
        const existing = await this.store.getSession(s.sid);
        if (existing && existing.userId !== actor.userId) continue; // never overwrite another user's session
        await this.store.upsertSession(s, actor.userId, machine, now);
      }
      const facts = req.machine
        ? { share: req.machine.share, ...(req.machine.repos ? { repos: req.machine.repos } : {}), ...(req.machine.accept ? { accept: req.machine.accept } : {}) }
        : undefined;
      await this.store.touchMachine(machine, now, req.counts, facts);
      // MM-1: the stored share level tells the daemon this hub applies the visibility rule.
      const share = (await this.store.getMachine(machine))?.share;
      return { accepted, ...(share ? { share } : {}) };
    });
  }

  async inbox(actor: Actor): Promise<InboxMessage[]> {
    if (!actor.machineId) throw new HubError(403, "inbox needs a device token");
    return (await this.store.inbox(actor.machineId)).map((m) => ({ id: m.id, toSid: m.toSid, kind: m.kind, text: m.text, fromUser: m.fromUser, createdAt: m.createdAt, ...(m.data ? { data: m.data } : {}) }));
  }

  async ack(actor: Actor, id: number, state: "delivered" | "failed", method: string | undefined): Promise<boolean> {
    if (!actor.machineId) throw new HubError(403, "ack needs a device token");
    const ok = await this.store.ackMessage(id, actor.machineId, state, method, this.now());
    if (ok) await this.emit({ type: "message.delivered", user: actor.userId, payload: { id, state, method } });
    return ok;
  }

  // ---------- views ----------

  async attentionFor(viewer: Actor): Promise<Attention[]> {
    return this.store.tx(async () => {
      const out: Attention[] = [];
      const goals = await this.store.listGoals();
      for (const g of goals) {
        if (g.state === "awaiting_approval" && canApprove(viewer, g.ownerId)) {
          const plan = (await this.store.listPlans(g.id)).filter((p) => p.decision === "pending").at(-1);
          out.push({ kind: "approval", text: `Plan v${plan?.version ?? "?"} for ${g.id} "${g.title}" awaits approval`, goal: g.id, at: plan?.proposedAt ?? g.updatedAt });
        }
      }
      const machines = await this.store.listMachines();
      const nameOf = (id: string) => {
        const m = machines.find((x) => x.id === id);
        return m ? machineName(m) : id;
      };
      const myMachines = new Set(machines.filter((m) => m.userId === viewer.userId).map((m) => m.id));
      for (const s of await this.store.listSteps({ state: "ready" })) {
        const g = goals.find((x) => x.id === s.goal);
        if (s.kind === "gate" && g && canApprove(viewer, g.ownerId)) out.push({ kind: "approval", text: `Gate ${s.policy?.gate ?? s.id} for ${s.goal} "${g.title}" waits for a decision`, goal: s.goal, step: s.id, at: s.updatedAt });
        const o = s.offer;
        if (o?.state === "offered" && myMachines.has(o.to.machine)) {
          out.push({ kind: "offer", text: `@${o.by} offers ${s.id} "${s.title}" to ${nameOf(o.to.machine)}`, goal: s.goal, step: s.id, at: o.at });
        }
        if (o?.state === "expired" && o.by === viewer.userId) {
          out.push({ kind: "offer_expired", text: `the offer of ${s.id} to ${nameOf(o.to.machine)} expired; it is ready again`, goal: s.goal, step: s.id, at: o.decidedAt ?? s.updatedAt });
        }
      }
      for (const q of await this.store.openQuestions()) {
        if (q.toUsers.includes(viewer.userId)) out.push({ kind: "question", text: `${q.fromUser} asks: ${q.text}`, step: q.step, sid: q.sid, question: q.id, at: q.at });
      }
      const owned = new Set(goals.filter((g) => g.ownerId === viewer.userId).map((g) => g.id));
      for (const s of await this.store.listSteps()) {
        const mine = owned.has(s.goal) || s.holderUser === viewer.userId;
        if (!mine) continue;
        if (s.state === "failed") out.push({ kind: "failed", text: `${s.id} failed: ${s.summary ?? ""}`, goal: s.goal, step: s.id, at: s.updatedAt });
        if (s.state === "paused") out.push({ kind: "paused", text: `${s.id} is paused (holder ${s.holderUser} went away)`, goal: s.goal, step: s.id, at: s.pausedAt ?? s.updatedAt });
        if (s.state === "parked") out.push({ kind: "parked", text: `${s.id} is parked: ${s.parkedReason ?? ""}`, goal: s.goal, step: s.id, at: s.parkedAt ?? s.updatedAt });
        const hs = await this.sessionOf(s.holderSid);
        if (s.state === "claimed" && hs?.state === "stalled") out.push({ kind: "stalled", text: `${s.id} stalled in ${s.holderUser}'s session`, goal: s.goal, step: s.id, sid: hs.sid, at: hs.lastStopAt ?? hs.lastEventAt });
      }
      for (const hs of await this.store.listSessions()) {
        if (hs.userId === viewer.userId && hs.session.state === "needs_you") {
          out.push({ kind: "needs_you", text: `${hs.session.repo?.name ?? hs.session.name ?? hs.session.sid.slice(0, 8)}: ${needsLabel(hs.session)}`, step: hs.session.step, sid: hs.session.sid, at: hs.session.lastStopAt ?? hs.session.lastEventAt });
        }
      }
      return out.sort((a, b) => b.at - a.at);
    });
  }

  async live(viewer: Actor, topics: readonly string[] = []): Promise<LiveView> {
    return this.store.tx(async () => {
      const want = await this.knownTopics(topics);
      const now = this.now();
      const users = (await this.store.listUsers()).filter((u) => !(u.roles.includes("service") && !u.roles.includes("member")));
      const machines = await this.store.listMachines();
      const shareOf = new Map(machines.map((m) => [m.id, m.share]));
      const sessions = (await this.store.listSessions()).filter((hs) => hs.session.state !== "ended" || now - (hs.session.endedAt ?? 0) < 10 * 60_000);
      const people = users.map((u) => {
        const ms = machines
          .filter((m) => m.userId === u.id)
          .map((m) => ({ id: m.id, hostname: m.hostname, ...(m.nickname ? { nickname: m.nickname } : {}), online: now - m.lastSeen < ONLINE_MS, lastSeen: m.lastSeen, counts: m.counts }));
        const ss = sessions
          .filter((hs) => hs.userId === u.id && sessionVisible(viewer.userId, { userId: hs.userId, step: hs.session.step }, shareOf.get(hs.machineId)))
          .map((hs) => liveSession(hs));
        return { user: this.userView(u), online: ms.some((m) => m.online), machines: ms, sessions: ss };
      });
      const goals: LiveView["goals"] = [];
      for (const g of (await this.store.listGoals()).filter((x) => goalHasTopics(x, want))) {
        const steps = (await this.store.listSteps({ goal: g.id })).filter((s) => s.state !== "dropped");
        goals.push({
          id: g.id,
          title: g.title,
          state: g.state,
          owner: g.ownerId,
          topics: g.topics ?? [],
          done: steps.filter((s) => s.state === "done").length,
          total: steps.length,
          holders: [...new Set(steps.filter((s) => s.holderUser && (s.state === "claimed" || s.state === "paused")).map((s) => s.holderUser as string))],
        });
      }
      const hostnames = new Map(machines.map((m) => [m.id, m.hostname]));
      const activity = (await this.store.recentEvents(40))
        .filter((e) => !e.type.startsWith("session.turn"))
        .reverse()
        .map((e) => ({ seq: e.seq, at: e.at, type: e.type, user: e.user, goal: e.goal, step: e.step, text: describe(e.type, e.step ?? e.goal, e.payload, hostnames) }));
      return { now, me: this.userView(await this.store.getUser(viewer.userId) as UserRow), people, goals, attention: await this.attentionFor(viewer), activity };
    });
  }

  /**
   * "My mesh" (MM-1): every machine of the caller, each with all the caller's non-ended sessions
   * on it whatever the share level. Online machines first, then most recently seen, then by id;
   * sessions most recent first, then by sid.
   */
  async fleet(viewer: Actor): Promise<FleetView> {
    return this.store.tx(async () => {
      const now = this.now();
      const mine = await this.store.listMachines({ userId: viewer.userId });
      const sessions = (await this.store.listSessions({ userId: viewer.userId, live: true })).filter((hs) => hs.session.state !== "ended");
      const machines: FleetMachine[] = mine.map((m) => ({
        id: m.id,
        hostname: m.hostname,
        ...(m.nickname ? { nickname: m.nickname } : {}),
        online: now - m.lastSeen < ONLINE_MS,
        lastSeen: m.lastSeen,
        counts: m.counts,
        ...(m.share ? { share: m.share } : {}),
        repos: m.repos ?? [],
        ...(m.reposAt !== undefined ? { reposAt: m.reposAt } : {}),
        labels: m.labels ?? [],
        ...(m.accept ? { accept: m.accept } : {}),
        current: m.id === viewer.machineId,
        sessions: sessions
          .filter((hs) => hs.machineId === m.id)
          .map((hs) => ({ ...liveSession(hs), lastEventAt: hs.session.lastEventAt, ...(hs.session.accept ? { accept: hs.session.accept } : {}) }))
          .sort((a, b) => b.lastEventAt - a.lastEventAt || cmp(a.sid, b.sid)),
      }));
      machines.sort((a, b) => Number(b.online) - Number(a.online) || b.lastSeen - a.lastSeen || cmp(a.id, b.id));
      return { now, user: this.userView((await this.store.getUser(viewer.userId)) as UserRow), machines };
    });
  }

  /** Name one of the caller's own machines (MM-1); null clears the name. Admins get no exception. */
  async renameMachine(actor: Actor, id: string, nickname: string | null): Promise<{ id: string; hostname: string; nickname?: string }> {
    return await this.store.tx(async () => {
      await this.store.serialize();
      const m = await this.store.getMachine(id);
      if (!m) throw new HubError(404, `no machine ${id}`);
      if (m.userId !== actor.userId) throw new HubError(403, "not your machine");
      const next = nickname ?? undefined;
      const view = (n: string | undefined) => ({ id: m.id, hostname: m.hostname, ...(n ? { nickname: n } : {}) });
      if (next === m.nickname) return view(next);
      if (!(await this.store.setMachineNickname(id, next))) {
        const other = next === undefined ? undefined : await this.store.machineByNickname(actor.userId, next);
        throw new HubError(409, `nickname ${next ?? ""} is already used by your machine ${other?.hostname ?? "?"} (${other?.id ?? "?"})`);
      }
      await this.emit({ type: "machine.named", user: actor.userId, payload: { machine: id, nickname: next ?? null } });
      return view(next);
    });
  }

  /**
   * Label one of the caller's own machines (MM-2): replace the list, or add/remove labels. Admins
   * get no exception. Concurrent changes of one machine run one after another.
   */
  async labelMachine(actor: Actor, id: string, change: MachineLabels): Promise<MachineLabelsView> {
    const norm = (items: readonly string[]): string[] => {
      const r = parseLabels(items);
      if ("error" in r) throw new HubError(400, r.error);
      return r.labels;
    };
    const replace = "labels" in change ? norm(change.labels) : undefined;
    const add = "labels" in change ? [] : norm(change.add ?? []);
    const remove = "labels" in change ? [] : norm(change.remove ?? []);
    return await this.store.tx(async () => {
      await this.store.serialize();
      const m = await this.store.getMachine(id);
      if (!m) throw new HubError(404, `no machine ${id}`);
      if (m.userId !== actor.userId) throw new HubError(403, "not your machine");
      const before = m.labels ?? [];
      const next = replace ?? [...new Set([...before, ...add])].filter((l) => !remove.includes(l)).sort(cmp);
      if (next.length > MAX_LABELS) throw new HubError(400, `at most ${MAX_LABELS} labels`);
      if (next.join(",") !== before.join(",")) {
        await this.store.setMachineLabels(id, next);
        await this.emit({ type: "machine.labelled", user: actor.userId, payload: { machine: id, labels: next } });
      }
      const defined = new Set([ALL_TOPIC, ...(await this.store.listTopics()).map((t) => t.name)]);
      return { id: m.id, hostname: m.hostname, ...(m.nickname ? { nickname: m.nickname } : {}), labels: next, unknown: next.filter((l) => !defined.has(l)) };
    });
  }

  async events(after: number, limit: number) {
    return await this.store.events(after, Math.min(Math.max(1, limit), 1000));
  }

  /** Drop hub events older than the retention period (the durable summaries are in git). */
  async pruneEvents(): Promise<number> {
    const days = this.config.eventsRetentionDays;
    if (!days || days <= 0) return 0;
    return await this.store.pruneEvents(this.now() - days * 86_400_000);
  }

  // ---------- time rules (plan §3.4) ----------

  /** Set when the hub is shutting down, so `/readyz` takes it out of the load balancer first. */
  draining = false;

  /**
   * Readiness (`GET /readyz`): the database answers within `timeoutMs` and its schema is at least
   * the one this mesh migrates to. Liveness (`/healthz`) asks nothing of the database.
   */
  async ready(timeoutMs = 3_000): Promise<{ ok: boolean; schema?: number; error?: string }> {
    if (this.draining) return { ok: false, error: "shutting down" };
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, fail) => {
      timer = setTimeout(() => fail(new Error(`database did not answer within ${timeoutMs} ms`)), timeoutMs);
    });
    try {
      const schema = await Promise.race([this.store.schemaVersion(), timeout]);
      const want = HubStore.SCHEMA_VERSION;
      // Releases only add to the schema, so a newer one (a rolling upgrade has begun) still serves this
      // release; an older one means migrations have not run.
      return schema >= want ? { ok: true, schema } : { ok: false, schema, error: `schema version ${schema}, this hub needs ${want}` };
    } catch (e) {
      return { ok: false, error: `database unreachable: ${e instanceof Error ? e.message : String(e)}` };
    } finally {
      clearTimeout(timer);
    }
  }

  private lastPrune = 0;

  async tick(): Promise<void> {
    const now = this.now();
    if (now - this.lastPrune > 6 * 3_600_000) {
      this.lastPrune = now;
      const n = await this.pruneEvents();
      if (n) await this.emit({ type: "hub.events_pruned", payload: { count: n, days: this.config.eventsRetentionDays } });
    }
    await this.goalTx(async () => {
      for (const s of await this.store.listSteps({ state: "claimed" })) {
        const hs = s.holderSid ? await this.store.getSession(s.holderSid) : undefined;
        const machine = s.holderMachine ? await this.store.getMachine(s.holderMachine) : undefined;
        const ended = hs?.session.state === "ended" && hs.session.endedReason !== "clear" && now - (hs.session.endedAt ?? 0) > this.config.thresholds.pauseGraceMs;
        const offline = machine !== undefined && now - machine.lastSeen > this.config.thresholds.machineOfflineMs;
        // Conditional: if another replica's tick (a leadership handover) or a request changed the
        // step since it was read, this tick leaves it alone. So running tick twice pauses once.
        if ((ended || offline) && (await this.store.saveStepIf(pause(s, now), s))) {
          await this.emit({ type: "step.paused", goal: s.goal, step: s.id, payload: { reason: ended ? "holder session ended" : "holder machine offline" } });
        }
      }
      // MM-3: open offers not accepted in time expire; the step is ready for anyone again.
      const expiry = this.config.thresholds.offerExpiryMs;
      for (const s of await this.store.listSteps({ state: "ready" })) {
        const o = s.offer;
        if (o?.state !== "offered" || now - o.at < expiry) continue;
        const next: Step = { ...s, offer: { ...o, state: "expired", decidedAt: now } };
        if (!(await this.store.saveStepIf(next, s))) continue;
        await this.emit({ type: "step.offer_expired", goal: s.goal, step: s.id, payload: { machine: o.to.machine } });
        const name = await this.machineNameOf(o.to.machine);
        await this.reportBack(s, o, "offer_expired", `MESH: the offer of ${s.id} "${s.title}" to ${name} expired (not accepted within ${Math.round(expiry / 60_000)} min). It is ready again.`);
      }
    });
  }

  /** Mint a service token: the event feed, plus the member routes its scopes name. */
  async serviceToken(name: string, scopes: ServiceScope[] = []): Promise<string> {
    const user = await this.store.upsertIdentity({ provider: "service", subject: name, name, groups: ["service"] }, this.now());
    await this.store.setUserRoles(user.id, ["service"]);
    return (await this.tokens.issue("service", user.id, this.now(), { label: name, scopes })).token;
  }

  newEventId(): string {
    return randomUUID();
  }
}

/** Code-point order (ids and sids are ASCII), independent of the locale. */
function cmp(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** A hub session as /v1/live and /v1/fleet list it. */
function liveSession(hs: HubSession): LiveSession {
  return {
    sid: hs.session.sid,
    machine: hs.machineId,
    user: hs.userId,
    repo: hs.session.repo?.name,
    name: hs.session.name,
    step: hs.session.step,
    state: hs.session.state,
    needs: hs.session.needs,
    autopilot: hs.session.autopilot,
    lastTurnAt: hs.session.lastTurnStartAt,
    ...(hs.session.labels?.length ? { labels: hs.session.labels } : {}),
  };
}

/** `hostnames`: machine id → hostname, for events about a machine (Live's activity). */
function describe(type: string, subject: string | undefined, payload: Record<string, unknown>, hostnames?: ReadonlyMap<string, string>): string {
  const s = subject ?? "";
  switch (type) {
    case "machine.named": {
      const host = hostnames?.get(String(payload.machine)) ?? String(payload.machine);
      return payload.nickname ? `named machine ${host} ${String(payload.nickname)}` : `cleared the name of machine ${host}`;
    }
    case "machine.labelled": {
      const host = hostnames?.get(String(payload.machine)) ?? String(payload.machine);
      const ls = (payload.labels as string[] | undefined) ?? [];
      return ls.length ? `labelled machine ${host} ${ls.join(", ")}` : `cleared the labels of machine ${host}`;
    }
    case "goal.created":
      return `created ${s} "${String(payload.title ?? "")}"`;
    case "goal.topics": {
      const add = (payload.added as string[] | undefined) ?? [];
      const rm = (payload.removed as string[] | undefined) ?? [];
      return [add.length ? `tagged ${s} ${add.join(", ")}` : "", rm.length ? `${add.length ? "and untagged" : `untagged ${s}`} ${rm.join(", ")}` : ""].filter(Boolean).join(" ");
    }
    case "topic.created":
      return `defined topic ${String(payload.topic)}`;
    case "topic.deleted":
      return `deleted topic ${String(payload.topic)}`;
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
    case "step.offered":
      return `offered ${s} to ${hostnames?.get(String(payload.machine)) ?? String(payload.machine)}`;
    case "step.accepted":
      return `accepted ${s} on ${hostnames?.get(String(payload.machine)) ?? String(payload.machine)}`;
    case "step.declined":
      return `declined ${s} on ${hostnames?.get(String(payload.machine)) ?? String(payload.machine)}`;
    case "step.offer_expired":
      return `the offer of ${s} to ${hostnames?.get(String(payload.machine)) ?? String(payload.machine)} expired`;
    case "step.offer_withdrawn":
      return `withdrew the offer of ${s} to ${hostnames?.get(String(payload.machine)) ?? String(payload.machine)}`;
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

/** A topic name from a request: trimmed and lowercased, 400 when it isn't a valid name. */
function topicName(raw: string): string {
  const name = raw.trim().toLowerCase();
  const p = TopicName.safeParse(name);
  if (!p.success) throw new HubError(400, `bad topic "${raw}": ${p.error.issues[0]?.message ?? "invalid"}`);
  return name;
}
