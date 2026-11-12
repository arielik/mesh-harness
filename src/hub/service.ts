// Hub service: the single writer (plan §8). Every mutation runs in one transaction that writes the
// state change and its event; once it commits, the bus hints SSE subscribers. Store calls are async
// (M4.6): within a transaction they are awaited in order, so events keep their order.

import { createHash, randomBytes, randomUUID } from "node:crypto";
import { AuthError, loginIdentity, pkceChallenge, randomId, Tokens, type AuthProvider, type Identity } from "../auth/index.ts";
import {
  acceptMatches,
  agentFileHash,
  agentFront,
  canonicalKey,
  catalogDigest,
  repoFromRemote,
  suggest,
  endOffersLeavingReady,
  machineName,
  sessionName,
  agentContext,
  blindConflict,
  blindPartners,
  builtinProfile,
  BUILTIN_PROFILES,
  compileProfile,
  effectiveBudget,
  INPUT_KEYWORDS,
  parseProfile,
  profileSha256,
  profileSnapshot,
  parsePreset,
  presetWarnings,
  blindSeparated,
  canApprove,
  claim,
  debriefAssignee,
  DEBRIEF_CONSUMES,
  isDebrief,
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
  release,
  settle,
  fingerprint,
  foldItems,
  isRaising,
  lineageOf,
  local,
  repoName,
  runOf,
  SEVERITY_RANK,
  skipSummary,
  uniqueFps,
  whenHolds,
  consumedNow,
  reopen,
  repoMatches,
  takeOver,
  validatePlan,
  pause,
  sessionVisible,
  instantiate,
  manualSlot,
  nextSlot,
  parseCron,
  parseDurationSpec,
  periodMs,
  profileNames,
  pulseCandidates,
  scheduleText,
  validTimeZone,
  agentStats as computeAgentStats,
  calibrationStatus,
  countedDismissals,
  CALIBRATE_PRESET,
  flagEntries,
  openCalibration,
  presetText,
  raisingAgents,
  uncalibrated,
  type AgentRef,
  type Counted,
  type Entry,
  type Materialized,
  type Principal,
  type Role,
} from "../core/index.ts";
import type {
  AcState,
  AgentStats,
  GoalCalibration,
  ItemHistoryEntry,
  AgentCopy,
  AgentDef,
  AgentFront,
  AgentGroup,
  AgentsView,
  AgentVersion,
  CatalogDefView,
  CatalogPush,
  CatalogSourceSave,
  CatalogSourceView,
  AssignRequest,
  AssignResult,
  GoalAssignResult,
  MessageResult,
  SuggestView,
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
  ProfileSnapshot,
  ProfileView,
  RunTelemetry,
  StepInput,
  StoredArtifact,
  ArtifactKind,
  ArtifactMediaType,
  Decider,
  DebriefItem,
  DebriefList,
  DebriefSummary,
  DebriefView,
  DecidedView,
  DisposeRequest,
  DisposeResult,
  DispositionRow,
  DispositionVia,
  Note,
  RevertRequest,
  RevertResult,
  Fold,
  ItemRow,
  ItemState,
  ItemView,
  RecordDisposition,
  ReviewResult,
  ReviewUpload,
  StoredRecord,
  StoredReview,
  StoredReviewItem,
  FireResult,
  GoalFromPreset,
  GoalState,
  Pulse,
  PulseCreate,
  PulseDetail,
  PulseSlot,
  PulseUpdate,
  PulseView,
  PulseWhen,
  PulseWhenInput,
  SlotReason,
} from "../protocol/index.ts";
import { AGENT_NAME_RE, ALL_TOPIC, CATALOG_REPO_MAX, HEADLESS_DEFAULTS, parseRosterKey, ROSTER_KEY_RULE, MAX_LABELS, TopicName, goalHasTopics, normalizeTopics, parseLabels } from "../protocol/index.ts";
import { HubStore, type HubSession, type MachineRow, type NewEvent, type StoredProfile, type UserRow } from "../store/index.ts";
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
const DAY_MS = 86_400_000;

/** RL-2: the order of a lineage's items on every backend: most severe first, then first seen, then fp. */
function byItemOrder(a: ItemRow, b: ItemRow): number {
  return SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity] || a.first.at - b.first.at || (a.fp < b.fp ? -1 : a.fp > b.fp ? 1 : 0);
}

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
    // A session's own name first, then the name it is shown under (`sessionName`: an unnamed session
    // shows as its repo, as in "accepted by m2/demo"), then a sid prefix of at least 4.
    const byName = all.filter((hs) => hs.session.name === ref);
    const byShown = byName.length ? byName : all.filter((hs) => sessionName(hs.session) === ref);
    const hits = byShown.length ? byShown : ref.length >= 4 ? all.filter((hs) => hs.session.sid.startsWith(ref)) : [];
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
  /** RL-5: offer data of a roster-key step: the goal's pin, or why there is none (never resolves). */
  private static rosterOffer(step: Step, goal: Goal): Record<string, unknown> {
    const agent = step.policy?.agent;
    if (agent === undefined || !agent.includes("/")) return {};
    const def = goal.agents?.[agent];
    return def ? { agentDef: def } : { agentError: `${agent} is not pinned in ${goal.id}` };
  }

  private async offerStep(
    step: Step,
    target: { machine: MachineRow; session?: HubSession | undefined },
    by: { userId: string; sid?: string | undefined; machine?: MachineRow | undefined },
    opts: { note?: string | undefined; stick: boolean; goal: Goal; snapshot?: ProfileSnapshot | undefined; deadline?: number | undefined },
  ): Promise<Step> {
    const now = this.now();
    const auto = this.autoFor(target, by);
    const sid = target.session?.session.sid;
    // RL-1: a headless offer carries the profile snapshot, budget, deadline and agent.
    const snap = step.policy?.mode === "headless" ? opts.snapshot : undefined;
    const headless: Record<string, unknown> = snap
      ? {
          mode: "headless",
          profile: snap,
          budget: effectiveBudget(step.policy),
          deadline: opts.deadline ?? now + this.config.thresholds.offerExpiryMs,
          ...(step.policy?.agent ? { agent: step.policy.agent } : {}),
          ...HubService.rosterOffer(step, opts.goal),
        }
      : {};
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
      ...(snap ? { profile: { name: snap.name, sha256: snap.sha256 } } : {}),
    };
    const next: Step = { ...step, offer, updatedAt: now };
    await this.saveStepFrom(next, step);
    await this.machineMessage(
      target.machine.id,
      by.userId,
      "offer",
      `MESH: @${by.userId} offers step ${step.id} "${step.title}" (repo ${step.repo}) to this machine${opts.note ? `: ${opts.note}` : ""}`,
      { step: step.id, goal: step.goal, repo: step.repo, topics: opts.goal.topics ?? [], auto, by: by.userId, ...(sid ? { sid } : {}), ...(opts.note ? { note: opts.note } : {}), ...headless },
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
    // RL-4: a debrief is never offered; only its assignee runs it.
    if (isDebrief(s.policy)) return;
    const machine = await this.store.getMachine(stick.to.machine);
    if (!machine) return;
    let session: HubSession | undefined;
    if (stick.to.sid) {
      session = await this.store.getSession(stick.to.sid);
      if (!session || session.session.state === "ended" || session.machineId !== machine.id) return;
    }
    const guard = await this.headlessGuard(s, machine, goal);
    if (!guard.ok) return;
    const byMachine = stick.byMachine ? await this.store.getMachine(stick.byMachine) : undefined;
    await this.offerStep(s, { machine, session }, { userId: stick.by, sid: stick.bySid, machine: byMachine }, { stick: true, goal, snapshot: guard.snapshot });
  }

  /** End offers of steps that left `ready` in this transaction (`endOffersLeavingReady`). */
  private async emitOffersEnded(actor: { userId: string } | undefined, ended: readonly Step[]): Promise<void> {
    for (const s of ended) {
      if (!s.offer) continue;
      await this.emit({ type: "step.offer_withdrawn", user: actor?.userId, goal: s.goal, step: s.id, payload: { machine: s.offer.to.machine, reason: `step ${s.state}` } });
    }
  }

  /** The claim itself (gate, parked and blind checks, the conditional save, `step.claimed`). */
  private async claimInTx(actor: Actor, step: Step, sid: string | undefined, holderMachine: string | undefined): Promise<Step> {
    await this.refuseNonAssignee(actor, step);
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
      if (isDebrief(step.policy)) throw new HubError(409, `${step.id} is a debrief step: only ${await this.assigneeOf(step)} runs it (mesh debrief ${step.id})`);
      if (step.offer?.state === "offered") throw new HubError(409, `${step.id} is already offered to ${await this.targetText(step.offer.to)}; withdraw it first (mesh withdraw ${step.id})`);
      const target = await this.resolveTarget(actor, req.to);
      const goal = await this.goalOr404(step.goal);
      const guard = await this.headlessGuard(step, target.machine, goal);
      if (!guard.ok) throw new HubError(409, guard.error);
      const caller = await this.callerMachine(actor, req.sid);
      this.refuseForeign(caller, req.sid);
      const next = await this.offerStep(step, target, { userId: actor.userId, sid: req.sid, machine: caller.machine }, { note: req.note, stick: false, goal, snapshot: guard.snapshot });
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
      // RL-1: headless steps the target cannot run are skipped (not offered, not counted).
      const ready: { step: Step; snapshot?: ProfileSnapshot | undefined }[] = [];
      for (const s of await this.offerableSteps(goal.id)) {
        const guard = await this.headlessGuard(s, target.machine, goal);
        if (guard.ok) ready.push({ step: s, snapshot: guard.snapshot });
      }
      if (ready.length === 0 && !req.stick) throw new HubError(409, `${goal.id} has no ready step to offer`);
      const by = { userId: actor.userId, sid: req.sid, machine: caller.machine };
      const offered: Step[] = [];
      for (const r of ready) offered.push(await this.offerStep(r.step, target, by, { note: req.note, stick: false, goal, snapshot: r.snapshot }));
      const sid = target.session?.session.sid;
      const saved = req.stick
        ? await this.setStick(goal, { to: { machine: target.machine.id, ...(sid ? { sid } : {}) }, by: actor.userId, bySid: req.sid, byMachine: caller.machine?.id })
        : goal;
      return { goal: saved, steps: offered, auto: this.autoFor(target, by) };
    });
  }

  /** The steps a goal assign offers: ready, not a gate, not a debrief (RL-4), no open offer; by id. */
  private async offerableSteps(goalId: string): Promise<Step[]> {
    return (await this.store.listSteps({ goal: goalId }))
      .filter((s) => s.state === "ready" && s.kind !== "gate" && !isDebrief(s.policy) && s.offer?.state !== "offered")
      .sort((a, b) => cmp(a.id, b.id));
  }

  // ---------- headless steps, profiles, artifacts, runs (RL-1) ----------

  /** A built-in or registered profile as a snapshot, or undefined. */
  private async resolveProfile(name: string): Promise<ProfileSnapshot | undefined> {
    const b = builtinProfile(name);
    if (b) return profileSnapshot(b.name, b.base, b.settings);
    const p = await this.store.getProfile(name);
    return p ? { name: p.name, base: p.base, sha256: p.sha256, settings: p.settings } : undefined;
  }

  /**
   * May this machine be offered this step? Interactive steps always; a headless step only on a
   * machine that reports it can run one, with a profile that still resolves. RL-3: a goal with
   * `profiles` (made by a pulse or by ingest) offers only the profiles of its snapshot.
   */
  private async headlessGuard(step: Step, machine: MachineRow, goal?: Goal): Promise<{ ok: true; snapshot?: ProfileSnapshot | undefined } | { ok: false; error: string }> {
    if (step.policy?.mode !== "headless") return { ok: true };
    if (machine.headless !== true) return { ok: false, error: `${machineName(machine)} cannot run headless steps (it needs mesh 0.1.15 with workspaceRoots set)` };
    const name = step.policy.profile ?? HEADLESS_DEFAULTS.profile;
    if (goal?.profiles) {
      const snap = goal.profiles[name];
      return snap ? { ok: true, snapshot: snap } : { ok: false, error: `${step.id}: profile ${name} is not in the goal's snapshot` };
    }
    const snapshot = await this.resolveProfile(name);
    if (!snapshot) return { ok: false, error: `${step.id}: unknown profile ${name}` };
    return { ok: true, snapshot };
  }

  private profileView(p: StoredProfile): ProfileView {
    return { name: p.name, base: p.base, sha256: p.sha256, settings: p.settings, builtIn: false, description: p.description ?? "", text: p.text, createdBy: p.createdBy, updatedAt: p.updatedAt };
  }

  /** `GET /v1/profiles`: the built-ins first, then registered ones by name. */
  async listProfiles(): Promise<ProfileView[]> {
    const builtIns: ProfileView[] = BUILTIN_PROFILES.map((b) => ({ ...profileSnapshot(b.name, b.base, b.settings), builtIn: true, description: b.description }));
    return [...builtIns, ...(await this.store.listProfiles()).map((p) => this.profileView(p))];
  }

  async getProfileView(name: string): Promise<ProfileView> {
    const b = builtinProfile(name);
    if (b) return { ...profileSnapshot(b.name, b.base, b.settings), builtIn: true, description: b.description };
    const p = await this.store.getProfile(name);
    if (!p) throw new HubError(404, `no profile ${name}`);
    return this.profileView(p);
  }

  /** `POST /v1/profiles`: register or replace (its creator or an admin). */
  async saveProfile(actor: Actor, body: { name: string; text: string }): Promise<{ view: ProfileView; created: boolean }> {
    return await this.store.tx(async () => {
      if (builtinProfile(body.name)) throw new HubError(409, `${body.name} is a built-in profile`);
      const parsed = parseProfile(body.text);
      if ("error" in parsed) throw new HubError(400, parsed.error);
      // Read-check-write under the store's write lock (Postgres: taken before the read), so two
      // first-time saves of one name by different users cannot both see "no owner" and race.
      await this.store.serialize();
      const existing = await this.store.getProfile(body.name);
      if (existing && existing.createdBy !== actor.userId && !actor.roles.includes("admin")) {
        throw new HubError(403, `profile ${body.name} belongs to @${existing.createdBy}; an admin may replace it`);
      }
      const { base, settings } = compileProfile(parsed.file);
      const p: StoredProfile = {
        name: body.name,
        text: body.text,
        createdBy: existing?.createdBy ?? actor.userId,
        updatedAt: this.now(),
        base,
        sha256: profileSha256(base, settings),
        settings,
        description: parsed.file.description ?? "",
      };
      await this.store.saveProfile(p);
      await this.emit({ type: "profile.saved", user: actor.userId, payload: { name: p.name, sha256: p.sha256 } });
      return { view: this.profileView(p), created: !existing };
    });
  }

  private lastArtifactMs = 0;
  private lastArtifactRand: Buffer | undefined;

  /** "a-" + a ULID (Crockford base32: 10 characters of time, 16 of randomness), monotonic within a millisecond. */
  private newArtifactId(now: number): string {
    const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
    let rand: Buffer;
    if (now === this.lastArtifactMs && this.lastArtifactRand) {
      rand = Buffer.from(this.lastArtifactRand);
      for (let i = rand.length - 1; i >= 0; i--) {
        rand[i] = ((rand[i] as number) + 1) & 0xff;
        if (rand[i] !== 0) break;
      }
    } else rand = randomBytes(10);
    this.lastArtifactMs = now;
    this.lastArtifactRand = rand;
    let time = "";
    let t = Math.max(0, Math.floor(now));
    for (let i = 0; i < 10; i++) {
      time = (ALPHABET[t % 32] as string) + time;
      t = Math.floor(t / 32);
    }
    let bits = 0n;
    for (const b of rand) bits = (bits << 8n) | BigInt(b);
    let r = "";
    for (let i = 0; i < 16; i++) {
      r = (ALPHABET[Number(bits & 31n)] as string) + r;
      bits >>= 5n;
    }
    return `a-${time}${r}`;
  }

  /** `POST /v1/steps/:id/artifacts`: store an artifact for the held step's current round. */
  async uploadArtifact(
    actor: Actor,
    id: string,
    b: { kind: ArtifactKind; title?: string | undefined; mediaType: ArtifactMediaType; content: string; redactions: number; sid?: string | undefined },
  ): Promise<StoredArtifact> {
    return await this.goalTx(async () => {
      const step = await this.stepOr404(id);
      if (step.state !== "claimed" && step.state !== "paused") throw new HubError(409, `${step.id} is ${step.state}; only a held step takes artifacts`);
      if (step.holderUser !== actor.userId && !actor.roles.includes("admin")) throw new HubError(403, `${step.id} is held by ${step.holderUser}`);
      // The event names the uploading session: never another user's (or, with a machine token, another machine's).
      if (b.sid) this.refuseForeign(await this.callerMachine(actor, b.sid), b.sid);
      const bytes = Buffer.byteLength(b.content, "utf8");
      const { maxBytes, perRound } = this.config.artifacts;
      if (bytes > maxBytes) throw new HubError(413, `artifact is ${bytes} bytes; the limit is ${maxBytes}`);
      const round = (step.rounds?.length ?? 0) + 1;
      const recordArtifact = (await this.store.getReview(step.id, round))?.artifact;
      if ((await this.store.listArtifacts({ step: step.id, round })).filter((x) => x.id !== recordArtifact).length >= perRound) throw new HubError(409, `${step.id} round ${round} already has ${perRound} artifacts`);
      const now = this.now();
      const content = Buffer.from(b.content, "utf8");
      const a: StoredArtifact = {
        id: this.newArtifactId(now),
        goal: step.goal,
        step: step.id,
        round,
        kind: b.kind,
        mediaType: b.mediaType,
        bytes,
        sha256: createHash("sha256").update(content).digest("hex"),
        redactions: b.redactions,
        ...(b.title ? { title: b.title } : {}),
        createdAt: now,
        by: actor.userId,
      };
      await this.store.addArtifact(a, content);
      await this.emit({
        type: "step.artifact",
        user: actor.userId,
        sid: b.sid,
        goal: step.goal,
        step: step.id,
        payload: { id: a.id, kind: a.kind, round: a.round, bytes: a.bytes, sha256: a.sha256, redactions: a.redactions },
      });
      return a;
    });
  }

  /** `GET /v1/artifacts/:id`: content is null once pruned. */
  async getArtifact(id: string): Promise<{ artifact: StoredArtifact; content: string | null }> {
    const r = await this.store.getArtifact(id);
    if (!r) throw new HubError(404, `no artifact ${id}`);
    return { artifact: r.artifact, content: r.content ? r.content.toString("utf8") : null };
  }

  /** `GET /v1/goals/:id/artifacts`. */
  async goalArtifacts(goalId: string): Promise<StoredArtifact[]> {
    return this.store.tx(async () => {
      const goal = await this.goalOr404(goalId);
      return await this.store.listArtifacts({ goal: goal.id });
    });
  }

  /** `POST /v1/steps/:id/run`: a headless run started or finished (with its telemetry). */
  async runReport(
    actor: Actor,
    id: string,
    b: { state: "started" | "finished"; runId: string; round?: number | undefined; telemetry?: RunTelemetry | undefined; branch?: string | undefined },
  ): Promise<Step> {
    return await this.goalTx(async () => {
      const step = await this.stepOr404(id);
      const admin = actor.roles.includes("admin");
      if (b.state === "started") {
        if (step.state !== "claimed" && step.state !== "paused") throw new HubError(409, `${step.id} is ${step.state}; only a held step starts a run`);
        if (step.holderUser !== actor.userId && !admin) throw new HubError(403, `${step.id} is held by ${step.holderUser}`);
        const p = step.offer?.profile;
        await this.emit({
          type: "run.started",
          user: actor.userId,
          goal: step.goal,
          step: step.id,
          payload: { runId: b.runId, ...(actor.machineId ? { machine: actor.machineId } : {}), ...(p ? { profile: p.name, profileHash: p.sha256 } : {}) },
        });
        // RL-3: the run of a pending pulse slot started.
        await this.markSlotStarted(step);
        return step;
      }
      let out = step;
      if (b.round !== undefined) {
        const r = step.rounds?.find((x) => x.n === b.round);
        if (!r) throw new HubError(404, `${step.id} has no round ${b.round}`);
        if (r.user !== actor.userId && !admin) throw new HubError(403, `round ${b.round} of ${step.id} is by ${r.user}`);
        if (b.telemetry || b.branch) {
          const now = this.now();
          const round: Round = { ...r, ...(b.telemetry ? { telemetry: b.telemetry } : {}), ...(b.branch ? { branch: b.branch } : {}) };
          out = { ...step, rounds: (step.rounds ?? []).map((x) => (x.n === b.round ? round : x)), ...(b.branch ? { branch: b.branch } : {}), updatedAt: now };
          await this.saveStepFrom(out, step);
        }
      }
      await this.emit({
        type: "run.finished",
        user: actor.userId,
        goal: step.goal,
        step: step.id,
        payload: { runId: b.runId, ...(b.round !== undefined ? { round: b.round } : {}), ...(b.branch ? { branch: b.branch } : {}), ...(b.telemetry ?? {}) },
      });
      return out;
    });
  }

  /**
   * What a step's `inputs` serve (inside a transaction), in policy order: artifacts of the last round
   * of the named steps (`artifacts`: of each dependency), never of a blind partner or an unread
   * dependency; RL-2 `previous` (the fold base of a raising step's lineage) and `dispositions` (the
   * items the step may act on now, or a raising step's open items).
   */
  private async stepInputs(step: Step, goal: Goal): Promise<StepInput[]> {
    const p = step.policy;
    if (!p?.inputs?.length && !isDebrief(p)) return [];
    const steps = await this.store.listSteps({ goal: step.goal });
    const hidden = new Set(blindPartners(step, steps).map((o) => o.id));
    const reads = p?.reads ? new Set(p.reads.map((r) => `${step.goal}.${r}`)) : undefined;
    const out: StepInput[] = [];
    const seen = new Set<string>();
    let served = 0;
    const MAX_ONE = 50_000;
    const MAX_ALL = 200_000;
    const push = (input: Omit<StepInput, "content" | "truncated">, text: string): boolean => {
      if (served >= MAX_ALL) return false;
      const content = text.slice(0, MAX_ONE);
      served += content.length;
      out.push({ ...input, content, truncated: text.length > MAX_ONE });
      return true;
    };
    const fromSteps = async (ids: readonly string[]): Promise<boolean> => {
      for (const id of ids) {
        if (seen.has(id)) continue;
        seen.add(id);
        const s = steps.find((x) => x.id === id) ?? (await this.store.getStep(id));
        if (!s || hidden.has(s.id)) continue;
        if (reads && step.deps.includes(s.id) && !reads.has(s.id)) continue;
        const n = s.rounds?.at(-1)?.n;
        if (n === undefined) continue;
        for (const a of await this.store.listArtifacts({ step: s.id, round: n })) {
          if (a.prunedAt !== undefined) continue;
          if (served >= MAX_ALL) return false;
          const got = await this.store.getArtifact(a.id);
          if (!got?.content) continue;
          push({ from: s.id, artifact: a.id, kind: a.kind, ...(a.title ? { title: a.title } : {}) }, got.content.toString("utf8"));
        }
      }
      return true;
    };
    // RL-4: a debrief starts with its items and the run's report.
    if (isDebrief(p)) {
      const d = await this.debriefData(step, goal, steps);
      if (d.run && d.items.length) push({ from: d.run.id, artifact: "debrief", kind: "review", title: `debrief items (${d.items.length})` }, JSON.stringify({ lineage: d.lineage, items: d.items }));
      if (d.run && d.report?.content) push({ from: d.run.id, artifact: d.report.artifact.id, kind: "report", title: d.report.artifact.title ?? "report" }, d.report.content);
    }
    for (const x of p?.inputs ?? []) {
      if (served >= MAX_ALL) break;
      if (x === "artifacts") {
        if (!(await fromSteps(step.deps))) break;
      } else if (x === "previous") {
        if (!isRaising(p)) continue;
        const base = await this.foldBase(lineageOf(goal, step), step.id, (step.rounds?.length ?? 0) + 1);
        if (base) push({ from: base.step, artifact: base.artifact, kind: "review", title: `previous review record (${base.goal} round ${base.round})` }, JSON.stringify(base.record));
      } else if (x === "dispositions") {
        const items = await this.dispositionsInput(step, goal, steps);
        if (items) push({ from: items.from, artifact: "items", kind: "review", title: "items and dispositions" }, JSON.stringify({ lineage: items.lineage, items: items.items }));
      } else if (x === "calibration") {
        // RL-6: the dismissals a calibration goal lists.
        const input = await this.calibrationInput(goal);
        if (input) push({ from: goal.id, artifact: "calibration", kind: "review", title: input.title }, input.content);
      } else if (!INPUT_KEYWORDS.has(x)) {
        if (!(await fromSteps([`${step.goal}.${x}`]))) break;
      }
    }
    return out;
  }

  // ---------- review records and items (RL-2) ----------

  /** The last complete raising record of a lineage, other than (step, round). */
  private async foldBase(lineage: string, stepId: string, round: number): Promise<StoredReview | undefined> {
    return (await this.store.listReviews({ lineage, raising: true, complete: true })).filter((r) => !(r.step === stepId && r.round === round)).at(-1);
  }

  /** The review record of a step with the highest round. */
  private async latestReview(stepId: string): Promise<StoredReview | undefined> {
    let best: StoredReview | undefined;
    for (const r of await this.store.listReviews({ step: stepId })) if (!best || r.round > best.round) best = r;
    return best;
  }

  /** The run of a consuming step and the run's record (undefined parts when there is none). */
  private async runRecordOf(step: Step, steps: readonly Step[]): Promise<{ run?: Step; record?: StoredReview }> {
    const run = runOf(step, steps, (s) => s.policy);
    if (!run) return {};
    const record = await this.latestReview(run.id);
    return record ? { run, record } : { run };
  }

  /** The item rows of a record's unique fps. */
  private async recordItems(rec: StoredReview): Promise<ItemRow[]> {
    const rows: ItemRow[] = [];
    for (const fp of uniqueFps(rec.record.items)) {
      const row = await this.store.getItem(rec.lineage, fp);
      if (row) rows.push(row);
    }
    return rows;
  }

  /** Item views (rows with their history) of a lineage, for the given rows. */
  private async withHistory(lineage: string, rows: readonly ItemRow[]): Promise<ItemView[]> {
    const out: ItemView[] = [];
    for (const r of rows) out.push({ ...r, history: await this.store.itemHistory(lineage, r.fp) });
    return out;
  }

  /** The `dispositions` input of a step, or undefined when there are no items for it. */
  private async dispositionsInput(step: Step, goal: Goal, steps: readonly Step[]): Promise<{ from: string; lineage: string; items: ItemView[] } | undefined> {
    const p = step.policy;
    if (isRaising(p)) {
      const lineage = lineageOf(goal, step);
      const rows = (await this.store.listItems(lineage)).filter((r) => r.state !== "resolved").sort(byItemOrder);
      return rows.length ? { from: step.id, lineage, items: await this.withHistory(lineage, rows) } : undefined;
    }
    if (!p?.consumes) return undefined;
    const { run, record } = await this.runRecordOf(step, steps);
    if (!run || !record) return undefined;
    const consumes: readonly ItemState[] = p.consumes;
    const rows = (await this.recordItems(record)).filter((r) => consumedNow(r, consumes));
    return rows.length ? { from: run.id, lineage: record.lineage, items: await this.withHistory(record.lineage, rows) } : undefined;
  }

  /** `holds` for `settle`: does each `when` step's run's record have an item it consumes? */
  private async holdsFor(steps: readonly Step[]): Promise<(s: Step) => boolean> {
    const map = new Map<string, boolean>();
    for (const s of steps) {
      const when = s.policy?.when;
      if (!when) continue;
      const { record } = await this.runRecordOf(s, steps);
      map.set(s.id, record ? whenHolds(when, s.policy?.consumes ?? [], (await this.recordItems(record)).map((r) => ({ state: r.state, severity: r.severity, link: r.link }))) : false);
    }
    return (s) => map.get(s.id) ?? false;
  }

  /** `settle` with the hub's `holds`; skipped steps get their summary. */
  private async settleSteps(steps: readonly Step[], now: number): Promise<{ changed: Step[]; skipped: string[] }> {
    const r = settle(steps, now, await this.holdsFor(steps));
    const skipped = new Set(r.skipped);
    const changed = r.changed.map((s) => {
      if (!skipped.has(s.id)) return s;
      const run = runOf(s, steps, (x) => x.policy);
      return { ...s, summary: skipSummary(run ? local(run) : local(s), s.policy?.when ?? {}, s.policy?.consumes ?? []) };
    });
    return { changed, skipped: r.skipped };
  }

  private async emitSkipped(goalId: string, ids: readonly string[], at?: number): Promise<void> {
    for (const id of ids) await this.emit({ ...(at !== undefined ? { at } : {}), type: "step.skipped", goal: goalId, step: id, payload: { reason: "when" } });
  }

  /** A goal is done when every step is done, skipped or dropped and one is not the design step. */
  private static goalComplete(steps: readonly Step[]): boolean {
    return steps.length > 0 && steps.every((s) => s.state === "done" || s.state === "skipped" || s.state === "dropped") && steps.some((s) => s.kind !== "design");
  }

  private deciderOf(step: Step, actor: Actor, agent: ReviewUpload["agent"]): Decider {
    if (step.policy?.mode === "headless") return { kind: "agent", key: agent?.key ?? `${repoName(step.repo)}/${local(step)}`, ...(agent?.hash ? { hash: agent.hash } : {}) };
    return { kind: "person", user: actor.userId };
  }

  /** `POST /v1/steps/:id/review`: the review record of the held step's current round. */
  async submitReview(actor: Actor, id: string, b: ReviewUpload): Promise<ReviewResult> {
    return await this.goalTx(async () => {
      const step = await this.stepOr404(id);
      const p = step.policy;
      if (!p?.output) throw new HubError(409, `${step.id} has no output: review-record`);
      if (step.state !== "claimed" && step.state !== "paused") throw new HubError(409, `${step.id} is ${step.state}; only a held step takes a review record`);
      // RL-4: a debrief's record is the person's: no admin exception.
      const debrief = isDebrief(p);
      if (step.holderUser !== actor.userId && (debrief || !actor.roles.includes("admin"))) throw new HubError(403, `${step.id} is held by ${step.holderUser}`);
      if (b.sid) this.refuseForeign(await this.callerMachine(actor, b.sid), b.sid);
      const n = (step.rounds?.length ?? 0) + 1;
      if (await this.store.getReview(step.id, n)) throw new HubError(409, `${step.id} round ${n} already has a review record`);

      const goal = await this.goalOr404(step.goal);
      const steps = await this.store.listSteps({ goal: goal.id });
      const raising = isRaising(p);
      const { run, record: runRecord } = raising ? { run: step, record: undefined } : await this.runRecordOf(step, steps);
      const lineage = lineageOf(goal, run ?? step);
      const now = this.now();
      const decider = this.deciderOf(step, actor, b.agent);
      const { undeclaredRules, redactions, agent, sid, ...fields } = b;
      const items: StoredReviewItem[] = fields.items.map(({ eh, ...i }) => ({ ...i, fp: fingerprint(i.key), ...(eh ? { eh } : {}) }));
      const fps = uniqueFps(items);
      const first = new Map<string, StoredReviewItem>();
      for (const it of items) if (!first.has(it.fp)) first.set(it.fp, it);

      // Problems: the two record-level ones, then the first failing check of each disposition.
      const problems: string[] = [];
      const ignored: { fingerprint: string; reason: string }[] = [];
      const already: string[] = [];
      const toApply: RecordDisposition[] = [];
      if (raising && fields.dispositions.length) problems.push(`dispositions need consumes; ${step.id} raises items`);
      if (!raising && fields.items.length) problems.push(`${step.id} consumes items; its record may not raise new ones`);
      if (!raising) {
        const consumes: readonly ItemState[] = p.consumes ?? [];
        const runFps = new Set(runRecord ? uniqueFps(runRecord.record.items) : []);
        const given = new Set<string>();
        for (const d of fields.dispositions) {
          const fp = d.fingerprint;
          let problem: string | undefined;
          if (!p.may_set?.includes(d.disposition)) problem = `${step.id} may not set ${d.disposition} (may_set: ${p.may_set?.join(", ") ?? "none"})`;
          else if (d.disposition === "deferred" && !d.until) problem = "deferred needs until (YYYY-MM-DD)";
          else if (given.has(fp)) problem = "listed twice";
          else if (!runFps.has(fp)) problem = `no item ${fp} in the record of ${run?.id ?? step.id}`;
          else {
            // RL-4: an fp this debrief decided with mesh_dispose is never applied again by its record.
            const session = debrief ? await this.sessionDecision(lineage, fp, step.id, n) : undefined;
            // RL-6: precedence looks at the latest person entry in the goal (an agent's entry after it never counts).
            const person =
              !session && decider.kind === "agent"
                ? (await this.store.listDispositions({ lineage, fp, goal: step.goal })).filter((x) => x.decider.kind === "person").at(-1)
                : undefined;
            if (session) {
              if (session.disposition === d.disposition) already.push(fp);
              else problem = `${fp} was decided in this debrief as ${session.disposition}; list that decision or leave it out`;
            } else if (person?.decider.kind === "person") {
              // RL-6: an agent disposition agreeing with the person is applied while the item's state is consumed.
              const row = await this.store.getItem(lineage, fp);
              if (person.disposition === d.disposition && row && consumes.includes(row.state)) toApply.push(d);
              else ignored.push({ fingerprint: fp, reason: `decided by ${person.decider.user} in this goal` });
            } else {
              const row = await this.store.getItem(lineage, fp);
              if (!row || !consumes.includes(row.state)) problem = `item ${fp} is ${row?.state ?? "unknown"}; ${step.id} acts on ${consumes.join(", ")}`;
              else toApply.push(d);
            }
          }
          given.add(fp);
          if (problem) problems.push(`disposition of ${fp}: ${problem}`);
        }
      }
      if (problems.length) throw new HubError(422, `the review record has ${problems.length} problem(s): ${problems.join("; ")}`, problems);

      const seenAt = { goal: goal.id, step: step.id, round: n, at: now };
      const states = new Map<string, ItemState>();
      let fold: Fold | undefined;
      let resolved: string[] = [];
      if (raising) {
        // The fold against the lineage's last complete raising record.
        const rows = new Map((await this.store.listItems(lineage)).map((r) => [r.fp, r] as const));
        const base = await this.foldBase(lineage, step.id, n);
        const f = foldItems({ items: [...first.values()], complete: fields.coverage === "complete", previous: base ? uniqueFps(base.record.items) : undefined, rows, today: new Date(now).toISOString().slice(0, 10) });
        for (const it of items) {
          const mark = f.marks.get(it.fp);
          if (mark) it.mark = mark;
        }
        const carried = new Set(f.carried);
        for (const fp of fps) {
          const it = first.get(fp) as StoredReviewItem;
          const row = rows.get(fp);
          const state = f.states.get(fp) ?? "open";
          const next: ItemRow = row
            ? { ...row, state, title: it.title, severity: it.severity, category: it.category, last: seenAt }
            : {
                lineage,
                fp,
                state,
                rule: it.key.rule,
                ...(it.key.path !== undefined ? { path: it.key.path } : {}),
                ...(it.key.symbol !== undefined ? { symbol: it.key.symbol } : {}),
                title: it.title,
                severity: it.severity,
                category: it.category,
                raisedBy: agent ? { key: agent.key, ...(agent.hash ? { hash: agent.hash } : {}) } : { key: `${repoName(step.repo)}/${local(step)}` },
                first: seenAt,
                last: seenAt,
              };
          if (it.eh) next.eh = it.eh;
          else delete next.eh;
          await this.store.saveItem(next);
          states.set(fp, state);
          await this.store.addItemHistory(lineage, fp, { ...seenAt, from: row?.state ?? null, to: state, kind: "fold", mark: f.marks.get(fp) ?? "new", ...(carried.has(fp) ? { carried: true as const } : {}) });
        }
        for (const fp of f.resolved) {
          const row = rows.get(fp);
          if (!row) continue;
          await this.store.saveItem({ ...row, state: "resolved" });
          await this.store.addItemHistory(lineage, fp, { ...seenAt, from: row.state, to: "resolved", kind: "fold", mark: "resolved" });
        }
        fold = f.fold;
        resolved = f.resolved;
      }

      // Dispositions of a consuming record (only when the whole record has no problem).
      const applied: { fp: string; disposition: string; from: ItemState }[] = [];
      const via: DispositionVia = debrief ? "debrief-session" : "stage";
      for (const d of toApply) {
        const row = await this.store.getItem(lineage, d.fingerprint);
        if (!row) continue;
        await this.applyDisposition(lineage, row, d, decider, via, seenAt);
        applied.push({ fp: d.fingerprint, disposition: d.disposition, from: row.state });
        if (debrief) await this.debriefNote(actor, step, sid, `debrief: ${d.disposition} ${d.fingerprint} "${row.title}": ${d.reason}`, now);
      }

      const record: StoredRecord = { ...fields, items };
      const content = Buffer.from(JSON.stringify(record), "utf8");
      const artifact: StoredArtifact = {
        id: this.newArtifactId(now),
        goal: goal.id,
        step: step.id,
        round: n,
        kind: "review",
        mediaType: "application/json",
        bytes: content.length,
        sha256: createHash("sha256").update(content).digest("hex"),
        redactions,
        title: "review record",
        createdAt: now,
        by: actor.userId,
      };
      await this.store.addArtifact(artifact, content);
      const review: StoredReview = {
        goal: goal.id,
        step: step.id,
        round: n,
        lineage,
        raising,
        complete: fields.coverage === "complete",
        record,
        ...(fold ? { fold } : {}),
        artifact: artifact.id,
        undeclaredRules,
        decider,
        by: actor.userId,
        ...(sid ? { sid } : {}),
        at: now,
      };
      if (!(await this.store.addReview(review))) throw new HubError(409, `${step.id} round ${n} already has a review record`);
      await this.emit({
        at: now,
        type: "review.recorded",
        user: actor.userId,
        sid,
        goal: goal.id,
        step: step.id,
        payload: {
          round: n,
          lineage,
          coverage: fields.coverage,
          assessment: fields.assessment,
          items: fps.length,
          artifact: artifact.id,
          ...(fold ? { fold } : {}),
          dispositions: applied.length,
          ignored: ignored.length,
          already: already.length,
          undeclaredRules,
        },
      });
      for (const a of applied) {
        await this.emit({
          at: now,
          type: "item.disposed",
          user: actor.userId,
          goal: goal.id,
          step: step.id,
          payload: { lineage, fp: a.fp, disposition: a.disposition, from: a.from, decider: decider.kind, via, round: n },
        });
      }
      // RL-6: a recorded dismissal may open a calibration goal for the agent that raised the item.
      if (applied.some((a) => a.disposition === "dismissed")) await this.calibrationAfterDismissal(lineage, goal.id, now);
      return {
        review,
        items: fps.map((fp) => {
          const mark = first.get(fp)?.mark;
          return { fp, ...(mark ? { mark } : {}), state: states.get(fp) ?? "open", title: first.get(fp)?.title ?? "" };
        }),
        resolved,
        applied: applied.length,
        ignored,
        already,
      };
    });
  }

  /**
   * Apply one disposition to an item row (state, `dismissedEh`, `until`, `link`) and add its history
   * entry. Returns the stored disposition as a row.
   */
  private async applyDisposition(
    lineage: string,
    row: ItemRow,
    d: Pick<RecordDisposition, "fingerprint" | "disposition" | "reason" | "until" | "link">,
    decider: Decider,
    via: DispositionVia,
    seenAt: { goal: string; step: string; round: number; at: number },
    answer?: string,
  ): Promise<DispositionRow> {
    const next: ItemRow = { ...row, state: d.disposition };
    if (d.disposition === "dismissed") {
      if (row.eh) next.dismissedEh = row.eh;
      else delete next.dismissedEh;
    }
    if (d.disposition === "deferred" && d.until) next.until = d.until;
    if (d.disposition === "accepted" && d.link) next.link = d.link;
    await this.store.saveItem(next);
    await this.store.addItemHistory(lineage, d.fingerprint, {
      ...seenAt,
      from: row.state,
      to: d.disposition,
      kind: "disposition",
      disposition: d.disposition,
      reason: d.reason,
      decider,
      via,
      ...(answer !== undefined ? { answer } : {}),
      ...(d.link ? { link: d.link } : {}),
      ...(d.until ? { until: d.until } : {}),
    });
    return {
      lineage,
      fp: d.fingerprint,
      goal: seenAt.goal,
      step: seenAt.step,
      round: seenAt.round,
      disposition: d.disposition,
      from: row.state,
      reason: d.reason,
      decider,
      via,
      ...(answer !== undefined ? { answer } : {}),
      ...(d.link ? { link: d.link } : {}),
      ...(d.until ? { until: d.until } : {}),
      at: seenAt.at,
    };
  }

  /** `GET /v1/steps/:id/reviews`: a step's review records by round. */
  async stepReviews(id: string): Promise<{ reviews: StoredReview[] }> {
    return this.store.tx(async () => {
      const step = await this.stepOr404(id);
      return { reviews: (await this.store.listReviews({ step: step.id })).sort((a, b) => a.round - b.round) };
    });
  }

  /** `GET /v1/items?lineage=`: the items of a lineage, most severe first, then first seen, then fp. */
  async lineageItems(lineage: string): Promise<{ lineage: string; items: ItemView[] }> {
    return this.store.tx(async () => {
      const rows = await this.store.listItems(lineage);
      const items = (await this.withHistory(lineage, rows)).sort(byItemOrder);
      return { lineage, items };
    });
  }

  // ---------- debriefs (RL-4) ----------

  /** The assignee of a debrief step, resolved now (`@owner` → the goal's owner at this moment). */
  private async assigneeOf(step: Step, goal?: Goal): Promise<string> {
    return debriefAssignee(step.policy, (goal ?? (await this.goalOr404(step.goal))).ownerId);
  }

  /** Only a debrief's assignee may hold it (no admin or owner exception). */
  private async refuseNonAssignee(actor: Actor, step: Step, goal?: Goal): Promise<void> {
    if (!isDebrief(step.policy)) return;
    const assignee = await this.assigneeOf(step, goal);
    if (actor.userId !== assignee) throw new HubError(403, `${step.id} is a debrief for ${assignee}; only they can take it`);
  }

  private async debriefOr409(id: string): Promise<Step> {
    const step = await this.stepOr404(id);
    if (!isDebrief(step.policy)) throw new HubError(409, `${step.id} is not a debrief step`);
    return step;
  }

  /**
   * What a debrief step works from: its run, the run's record's lineage, the debrief items (items it
   * may act on now, most severe first, with evidence locations and near-matches) and the run's report.
   */
  private async debriefData(
    step: Step,
    goal: Goal,
    steps: readonly Step[],
  ): Promise<{ run?: Step; lineage?: string; items: DebriefItem[]; report?: { artifact: StoredArtifact; content: string | null } }> {
    const { run, record } = await this.runRecordOf(step, steps);
    if (!run) return { items: [] };
    const lineage = record?.lineage ?? lineageOf(goal, run);
    const report = await this.runReportOf(run);
    const out = { run, lineage, ...(report ? { report } : {}) };
    if (!record) return { ...out, items: [] };
    const consumes: readonly ItemState[] = step.policy?.consumes ?? DEBRIEF_CONSUMES;
    const rows = (await this.recordItems(record)).filter((r) => consumes.includes(r.state)).sort(byItemOrder);
    if (!rows.length) return { ...out, items: [] };
    const all = await this.store.listItems(lineage);
    const items: DebriefItem[] = [];
    for (const v of await this.withHistory(lineage, rows)) {
      const first = record.record.items.find((i) => i.fp === v.fp);
      items.push({
        ...v,
        evidence: (first?.evidence ?? []).map((e) => ({ path: e.path, ...(e.lines ? { lines: e.lines } : {}) })),
        nearMatches: all
          .filter((o) => o.fp !== v.fp && o.rule === v.rule && ((v.path !== undefined && o.path === v.path) || (v.symbol !== undefined && o.symbol === v.symbol && o.path !== v.path)))
          .sort((a, b) => cmp(a.fp, b.fp))
          .map((o) => ({ fp: o.fp, state: o.state, title: o.title, ...(o.symbol !== undefined ? { symbol: o.symbol } : {}) })),
      });
    }
    return { ...out, items };
  }

  /** The run step's `report` artifact uploaded last in its highest round that has one. */
  private async runReportOf(run: Step): Promise<{ artifact: StoredArtifact; content: string | null } | undefined> {
    const reports = (await this.store.listArtifacts({ step: run.id })).filter((a) => a.kind === "report");
    if (!reports.length) return undefined;
    const top = Math.max(...reports.map((a) => a.round));
    const a = reports.filter((x) => x.round === top).at(-1) as StoredArtifact;
    const got = await this.store.getArtifact(a.id);
    return { artifact: got?.artifact ?? a, content: got?.content ? got.content.toString("utf8") : null };
  }

  /** The latest debrief disposition of `fp` by this step in round `n` (whatever happened since). */
  private async sessionDecision(lineage: string, fp: string, stepId: string, n: number): Promise<DispositionRow | undefined> {
    return (await this.store.listDispositions({ lineage, fp, step: stepId })).filter((d) => d.via === "debrief-session" && d.round === n).at(-1);
  }

  /**
   * A debrief disposition is revertable while it is the latest history entry of its item. Only the
   * last disposition row of an item is ever a candidate, so two equal rows are never both revertable.
   */
  private async isRevertable(d: DispositionRow, laterRows: readonly DispositionRow[] = []): Promise<boolean> {
    if (d.via !== "debrief-session") return false;
    if (laterRows.some((o) => o.lineage === d.lineage && o.fp === d.fp)) return false;
    const last = (await this.store.itemHistory(d.lineage, d.fp)).at(-1);
    return (
      last?.kind === "disposition" &&
      last.via === "debrief-session" &&
      last.step === d.step &&
      last.round === d.round &&
      last.at === d.at &&
      last.disposition === d.disposition &&
      last.from === d.from
    );
  }

  /** Debrief dispositions as the lists show them (each with its item's title and whether it is revertable). */
  private async decidedViews(rows: readonly DispositionRow[]): Promise<DecidedView[]> {
    const out: DecidedView[] = [];
    for (let i = 0; i < rows.length; i++) {
      const d = rows[i] as DispositionRow;
      out.push({ ...d, title: (await this.store.getItem(d.lineage, d.fp))?.title ?? "", revertable: await this.isRevertable(d, rows.slice(i + 1)) });
    }
    return out;
  }

  /** A note on the step (as `POST /v1/steps/:id/note`), with its `step.noted` event. */
  private async debriefNote(actor: Actor, step: Step, sid: string | undefined, text: string, at: number): Promise<Note> {
    const note = await this.store.addNote({ step: step.id, user: actor.userId, ...(sid ? { sid } : {}), text, at });
    await this.emit({ at, type: "step.noted", user: actor.userId, sid, goal: step.goal, step: step.id });
    return note;
  }

  /** `POST /v1/steps/:id/read`: the assignee marks the pre-read as read. */
  async readStep(actor: Actor, id: string): Promise<{ read: { user: string; at: number; round: number } }> {
    return await this.goalTx(async () => {
      const step = await this.debriefOr409(id);
      await this.refuseNonAssignee(actor, step);
      if (step.state !== "ready" && step.state !== "claimed" && step.state !== "paused") throw new HubError(409, `${step.id} is ${step.state}`);
      const now = this.now();
      const read = { user: actor.userId, at: now, round: (step.rounds?.length ?? 0) + 1 };
      await this.saveStepFrom({ ...step, read, updatedAt: now }, step);
      await this.emit({ at: now, type: "step.read", user: actor.userId, goal: step.goal, step: step.id, payload: { round: read.round } });
      return { read };
    });
  }

  /** `GET /v1/steps/:id/debrief`: the pre-read and the decisions of a debrief step. */
  async debriefView(id: string): Promise<DebriefView> {
    return this.store.tx(async () => {
      const step = await this.debriefOr409(id);
      const goal = await this.goalOr404(step.goal);
      const steps = await this.store.listSteps({ goal: goal.id });
      const d = await this.debriefData(step, goal, steps);
      const decided = await this.decidedViews((await this.store.listDispositions({ step: step.id })).filter((x) => x.via === "debrief-session"));
      return {
        step: step.id,
        goal: goal.id,
        title: step.title,
        repo: step.repo,
        state: step.state,
        assignee: await this.assigneeOf(step, goal),
        ...(d.run ? { run: d.run.id, lineage: d.lineage } : {}),
        ...(d.report ? { report: d.report } : {}),
        items: d.items,
        decided,
        ...(step.read ? { read: step.read } : {}),
      };
    });
  }

  /** `GET /v1/debriefs`: the caller's open debriefs and their revertable decisions of the last 7 days. */
  async debriefs(actor: Actor): Promise<DebriefList> {
    return this.store.tx(async () => {
      const goals = new Map<string, Goal | undefined>();
      const goalOf = async (id: string): Promise<Goal | undefined> => {
        if (!goals.has(id)) goals.set(id, await this.store.getGoal(id));
        return goals.get(id);
      };
      const mine: Step[] = [];
      for (const state of ["ready", "claimed", "paused"] as const) {
        for (const s of await this.store.listSteps({ state })) {
          if (!isDebrief(s.policy)) continue;
          const g = await goalOf(s.goal);
          if (g && debriefAssignee(s.policy, g.ownerId) === actor.userId) mine.push(s);
        }
      }
      mine.sort((a, b) => cmp(a.id, b.id));
      const debriefs: DebriefSummary[] = [];
      for (const s of mine) {
        const g = (await goalOf(s.goal)) as Goal;
        const d = await this.debriefData(s, g, await this.store.listSteps({ goal: g.id }));
        debriefs.push({ step: s.id, goal: s.goal, title: s.title, repo: s.repo, state: s.state, items: d.items.length, read: s.read?.round === (s.rounds?.length ?? 0) + 1 });
      }
      const since = this.now() - 7 * DAY_MS;
      const ids = (await this.store.listSteps({ updatedSince: since })).filter((s) => isDebrief(s.policy)).map((s) => s.id);
      const rows = (await this.store.listDispositions({ steps: ids, since })).filter((d) => d.via === "debrief-session");
      const decided: DecidedView[] = [];
      for (let i = 0; i < rows.length; i++) {
        const d = rows[i] as DispositionRow;
        if (d.decider.kind !== "person" || d.decider.user !== actor.userId) continue;
        if (!(await this.isRevertable(d, rows.slice(i + 1)))) continue;
        decided.push({ ...d, title: (await this.store.getItem(d.lineage, d.fp))?.title ?? "", revertable: true });
      }
      decided.reverse();
      decided.sort((a, b) => b.at - a.at);
      return { debriefs, decided };
    });
  }

  /** `POST /v1/steps/:id/dispositions`: one decision of the person in a held debrief. */
  async disposeStep(actor: Actor, id: string, b: DisposeRequest): Promise<DisposeResult> {
    return await this.goalTx(async () => {
      const step = await this.stepOr404(id);
      const p = step.policy;
      if (!isDebrief(p)) throw new HubError(409, `${step.id} is not a debrief step; a stage records its dispositions in its review record (mesh_review)`);
      if (step.state !== "claimed" && step.state !== "paused") throw new HubError(409, `${step.id} is ${step.state}; only a held debrief takes dispositions`);
      if (step.holderUser !== actor.userId) throw new HubError(403, `${step.id} is held by ${step.holderUser}`);
      if (b.sid) this.refuseForeign(await this.callerMachine(actor, b.sid), b.sid);
      const n = (step.rounds?.length ?? 0) + 1;
      if (await this.store.getReview(step.id, n)) throw new HubError(409, `${step.id} round ${n} already has a review record`);
      const goal = await this.goalOr404(step.goal);
      const steps = await this.store.listSteps({ goal: goal.id });
      const { run, record } = await this.runRecordOf(step, steps);
      const lineage = record?.lineage ?? lineageOf(goal, run ?? step);
      const consumes: readonly ItemState[] = p?.consumes ?? DEBRIEF_CONSUMES;
      const fp = b.fingerprint;
      const runFps = new Set(record ? uniqueFps(record.record.items) : []);
      let problem: string | undefined;
      let row: ItemRow | undefined;
      if (!p?.may_set?.includes(b.disposition)) problem = `${step.id} may not set ${b.disposition} (may_set: ${p?.may_set?.join(", ") ?? "none"})`;
      else if (b.disposition === "deferred" && !b.until) problem = "deferred needs until (YYYY-MM-DD)";
      else if (!runFps.has(fp)) problem = `no item ${fp} in the record of ${run?.id ?? step.id}`;
      else {
        row = await this.store.getItem(lineage, fp);
        // A change of mind: the item's latest disposition is this step's in this round.
        const latest = (await this.store.listDispositions({ lineage, fp })).at(-1);
        const own = latest !== undefined && latest.step === step.id && latest.round === n && latest.via === "debrief-session";
        if (!row || (!consumes.includes(row.state) && !own)) problem = `item ${fp} is ${row?.state ?? "unknown"}; ${step.id} acts on ${consumes.join(", ")}`;
      }
      if (problem || !row) throw new HubError(422, problem ?? `no item ${fp}`);
      const now = this.now();
      const seenAt = { goal: goal.id, step: step.id, round: n, at: now };
      const disposition = await this.applyDisposition(lineage, row, b, { kind: "person", user: actor.userId }, "debrief-session", seenAt, b.answer);
      const note = await this.debriefNote(actor, step, b.sid, `debrief: ${b.disposition} ${fp} "${row.title}": ${b.reason}`, now);
      await this.emit({
        at: now,
        type: "item.disposed",
        user: actor.userId,
        goal: goal.id,
        step: step.id,
        payload: { lineage, fp, disposition: b.disposition, from: row.state, decider: "person", via: "debrief-session", round: n },
      });
      if (b.disposition === "dismissed") await this.calibrationAfterDismissal(lineage, goal.id, now);
      await this.saveStepFrom({ ...step, updatedAt: now }, step);
      const after = await this.debriefData(step, goal, steps);
      const saved = (await this.store.getItem(lineage, fp)) as ItemRow;
      const [item] = await this.withHistory(lineage, [saved]);
      return { disposition, item: item as ItemView, left: after.items.length, note };
    });
  }

  /** `POST /v1/steps/:id/dispositions/revert`: undo a debrief decision while it is the item's latest change. */
  async revertDisposition(actor: Actor, id: string, b: RevertRequest): Promise<RevertResult> {
    return await this.goalTx(async () => {
      const step = await this.debriefOr409(id);
      const fp = b.fingerprint;
      const d = (await this.store.listDispositions({ step: step.id, fp })).filter((x) => x.via === "debrief-session").at(-1);
      if (!d) throw new HubError(404, `${step.id} has no debrief disposition of ${fp}`);
      const goal = await this.goalOr404(step.goal);
      const decider = d.decider.kind === "person" ? d.decider.user : "";
      if (actor.userId !== decider && actor.userId !== goal.ownerId && !actor.roles.includes("admin")) throw new HubError(403, `only ${decider}, the goal owner or an admin can revert this`);
      if (!(await this.isRevertable(d))) throw new HubError(409, `${fp} changed after the debrief decided it; nothing to revert`);
      const row = await this.store.getItem(d.lineage, fp);
      if (!row) throw new HubError(409, `${fp} changed after the debrief decided it; nothing to revert`);
      const now = this.now();
      const to = d.from;
      const next: ItemRow = { ...row, state: to };
      if (to === "dismissed" && row.eh) next.dismissedEh = row.eh;
      else delete next.dismissedEh;
      if (to !== "deferred") delete next.until;
      await this.store.saveItem(next);
      await this.store.addItemHistory(d.lineage, fp, {
        at: now,
        goal: step.goal,
        step: step.id,
        round: d.round,
        from: d.disposition,
        to,
        kind: "revert",
        disposition: d.disposition,
        decider: { kind: "person", user: actor.userId },
        via: "ui",
        ...(b.reason ? { reason: b.reason } : {}),
      });
      const note = await this.debriefNote(actor, step, undefined, `debrief: reverted ${fp} to ${to} (was ${d.disposition})`, now);
      await this.emit({
        at: now,
        type: "item.reverted",
        user: actor.userId,
        goal: step.goal,
        step: step.id,
        payload: { lineage: d.lineage, fp, from: d.disposition, to, round: d.round, via: "ui" },
      });
      const [item] = await this.withHistory(d.lineage, [next]);
      return { item: item as ItemView, reverted: d, note };
    });
  }

  // ---------- suggest (MM-4) ----------

  /** Ranked machines for a subject (inside a read-only transaction). */
  private async suggestView(actor: Actor, target: string, steps: string[], repos: string[], topics: string[], q: { team: boolean; any: boolean }): Promise<SuggestView> {
    const all = q.team ? await this.store.listMachines() : await this.store.listMachines({ userId: actor.userId });
    const mine = all.filter((m) => m.userId === actor.userId);
    const callerNicknames = new Set(mine.flatMap((m) => (m.nickname ? [m.nickname] : [])));
    const cm = actor.machineId ? await this.store.getMachine(actor.machineId) : undefined;
    const callerMachine = cm ? { id: cm.id, userId: cm.userId, ...(cm.nickname ? { nickname: cm.nickname } : {}) } : undefined;
    const sessions = await this.store.listSessions({ live: true });
    const suggestions = suggest({ caller: actor.userId, callerMachine, now: this.now(), onlineMs: ONLINE_MS, repos, topics, any: q.any, machines: all, callerNicknames, sessions });
    return { target, steps, repos, topics, team: q.team, any: q.any, suggestions };
  }

  /** `GET /v1/steps/:id/suggest`: read-only, no event. */
  async suggestStep(actor: Actor, id: string, q: { team: boolean; any: boolean }): Promise<SuggestView> {
    return this.store.tx(async () => {
      const step = await this.stepOr404(id);
      if (step.kind === "gate") throw new HubError(409, `${step.id} is a gate: a person decides it`);
      if (step.state !== "ready") throw new HubError(409, `${step.id} is ${step.state}, not ready`);
      const topics = (await this.store.getGoal(step.goal))?.topics ?? [];
      return await this.suggestView(actor, step.id, [step.id], step.repo ? [step.repo] : [], [...topics], q);
    });
  }

  /** `GET /v1/goals/:id/suggest`: the subject is the steps a goal assign would offer. Read-only. */
  async suggestGoal(actor: Actor, id: string, q: { team: boolean; any: boolean }): Promise<SuggestView> {
    return this.store.tx(async () => {
      const goal = await this.goalOr404(id);
      if (goal.state === "done" || goal.state === "dropped") throw new HubError(409, `${goal.id} is ${goal.state}`);
      const offerable = await this.offerableSteps(goal.id);
      const repos = offerable.length
        ? [...new Set(offerable.map((s) => s.repo).filter((r): r is string => !!r))].sort(cmp)
        : goal.primaryRepo
          ? [goal.primaryRepo]
          : [];
      return await this.suggestView(actor, goal.id, offerable.map((s) => s.id), repos, [...(goal.topics ?? [])], q);
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
  private async withdrawOffer(actor: { userId: string }, step: Step, reason?: string): Promise<Step> {
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

  /**
   * All goals, or those carrying every topic in `topics` (`all` matches every goal). RL-3: goals
   * made by a pulse are left out unless `pulses`.
   */
  async listGoals(topics: readonly string[] = [], o: { pulses?: boolean | undefined } = {}): Promise<Goal[]> {
    const want = await this.knownTopics(topics);
    return (await this.store.listGoals()).filter((g) => goalHasTopics(g, want) && (o.pulses === true || g.refs?.pulse === undefined));
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
      // RL-3: pulses (deleted ones too) lose the topic, so a later fire does not fail on it.
      for (const p of await this.store.listPulses({ deleted: true })) {
        if (!p.topics.includes(name)) continue;
        await this.store.savePulse({ ...p, topics: p.topics.filter((t) => t !== name), updatedAt: now });
        await this.emit({ type: "pulse.updated", user: actor.userId, payload: { pulse: p.id, version: p.version, fields: ["topics"] } });
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
      for (const s of input.steps) if (s.profile !== undefined && !(await this.resolveProfile(s.profile))) errors.push(`step "${s.id}": unknown profile "${s.profile}"`);
      // RL-5: roster keys must resolve to a catalog definition.
      errors.push(...(await this.pinAgents(input.steps, goal.agents ?? {})).problems);
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
      // RL-5 (R-6): pin the plan's new roster keys; a key pinned before keeps its pin.
      const pins = await this.pinAgents(plan.steps, goal.agents ?? {});
      if (pins.problems.length) throw new HubError(422, `the plan has ${pins.problems.length} problem(s): ${pins.problems.join("; ")}`, pins.problems);
      if (Object.keys(pins.agents).length > Object.keys(goal.agents ?? {}).length) await this.store.saveGoal({ ...goal, agents: pins.agents, updatedAt: now });
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
      await this.applyApproved(actor, goal, plan, existing, changes, m, now);
    });
    return await this.goalDetail(goalId);
  }

  /**
   * The tail of an approval (inside `goalTx`): save the materialized `changes`, settle steps with
   * `when`, set the goal's state, and emit `plan.approved`, ended offers, ready, skipped, done and
   * dropped steps. Shared by `approvePlan` and RL-3's create-with-plan.
   */
  private async applyApproved(by: { userId: string }, goal: Goal, plan: Plan, existing: readonly Step[], changes: Step[], m: Materialized, now: number): Promise<void> {
    const first = endOffersLeavingReady(existing, changes, now);
    await this.store.saveSteps(first.steps);
    const afterFirst = await this.store.listSteps({ goal: goal.id });
    // RL-2: settle decides new, changed or reset steps with `when` (skipped or ready).
    const settled = await this.settleSteps(afterFirst, now);
    const second = endOffersLeavingReady(afterFirst, settled.changed, now);
    const ready = second.steps;
    await this.store.saveSteps(ready);
    const finalSteps = afterFirst.map((s) => ready.find((x) => x.id === s.id) ?? s);
    const complete = HubService.goalComplete(finalSteps);
    const fresh = await this.store.getGoal(goal.id);
    await this.store.saveGoal({ ...(fresh ?? goal), state: complete ? "done" : "in_progress", updatedAt: now });
    await this.emit({ type: "plan.approved", user: by.userId, goal: goal.id, payload: { version: plan.version } });
    await this.emitOffersEnded(by, [...first.ended, ...second.ended]);
    const finalState = new Map(finalSteps.map((s) => [s.id, s.state]));
    for (const s of [...m.upserts, ...ready].filter((x) => x.state === "ready" && finalState.get(x.id) === "ready")) await this.emitReady(goal.id, s.id);
    await this.emitSkipped(goal.id, settled.skipped);
    if (complete && (fresh ?? goal).state !== "done") await this.markGoalDone(fresh ?? goal);
    for (const s of m.upserts.filter((x) => x.state === "dropped")) await this.emit({ type: "step.dropped", goal: goal.id, step: s.id });
    for (const s of m.changedForHolder) {
      await this.message(s.holderSid, by.userId, "replan", `MESH: the brief of your step ${s.id} changed in plan v${plan.version}. Call mesh_context to read it.`);
    }
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
    // RL-4: a debrief is never picked from a ready list (mesh next, mesh_next, the TUI n key, autopilot).
    if (filter.ready) steps = steps.filter((s) => !isDebrief(s.policy));
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
      const inputs = await this.stepInputs(step, goal);
      if (inputs.length) ctx.inputs = inputs;
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
      await this.slotReleased(goal, step, note);
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
      // RL-2: the record carries the findings of a step with output; it never reopens anything.
      if (step.policy?.output && input.reopen.length) throw new HubError(400, "a step with output: review-record reopens nothing; its record carries the findings");
      const now = input.at !== undefined && input.at <= this.now() && input.at > this.now() - 30 * 86_400_000 ? input.at : this.now();
      const explicit = input.reopen.map((r) => (r.includes(".") ? r : `${step.goal}.${r}`));
      const all = await this.store.listSteps({ goal: step.goal });
      for (const id of explicit) {
        const s = all.find((x) => x.id.toLowerCase() === id.toLowerCase());
        if (!s) throw new HubError(404, `cannot reopen ${id}: no such step`);
        if (s.state !== "done") throw new HubError(409, `cannot reopen ${id}: it is ${s.state}, not done`);
      }
      // A verdict decides the outcome when given (a review that requests changes failed).
      let outcome: "done" | "fail" = input.verdict ? (["changes_requested", "blocked", "fail"].includes(input.verdict) ? "fail" : "done") : input.outcome;
      if (outcome === "done" && explicit.length) throw new HubError(400, "reopen only makes sense with outcome fail");
      if (step.state !== "claimed" && step.state !== "paused") throw new HubError(409, `${step.id} is ${step.state}; claim it first`);
      if (step.holderUser !== actor.userId && !actor.roles.includes("admin")) throw new HubError(403, `${step.id} is held by ${step.holderUser}`);
      // RL-2 (REQ-5): a step with output closes done only with a review record, and always done with one.
      const n = (step.rounds?.length ?? 0) + 1;
      const rec = step.policy?.output ? await this.store.getReview(step.id, n) : undefined;
      if (step.policy?.output && !rec && outcome === "done") {
        throw new HubError(409, `${step.id} needs a review record for round ${n} (output: review-record); submit it with mesh_review, then call mesh_done`);
      }
      if (rec) outcome = "done";
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
        n,
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
      // RL-1: the round's hub-stored artifacts, in upload order.
      const artifactIds = (await this.store.listArtifacts({ step: step.id, round: round.n })).map((a) => a.id);
      if (artifactIds.length) round.artifactIds = artifactIds;
      if (rec?.fold) round.fold = rec.fold;
      // RL-4: the pre-read of a debrief in this round.
      if (step.read && step.read.round === n) round.read = { user: step.read.user, at: step.read.at };
      // A recorded round is done: judgeDone's caps, parking and failure routing do not apply.
      const decision = rec ? ({ action: "done" } as const) : judgeDone(step, round, explicit, plan?.acs);

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
      const settled = await this.settleSteps(steps, now);
      const ready = settled.changed;
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
      await this.emitSkipped(step.goal, settled.skipped, now);
      const goalDone = HubService.goalComplete(steps);
      let files: TrailFile[] | undefined;
      if (goalDone && goal.state !== "done") {
        const doneGoal: Goal = { ...goal, state: "done", updatedAt: now };
        await this.store.saveGoal(doneGoal);
        await this.markGoalDone(doneGoal, now);
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
      const settled = await this.settleSteps(steps, now);
      const ready = settled.changed;
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
      await this.emitSkipped(step.goal, settled.skipped);
      const goalDone = HubService.goalComplete(steps);
      let files: TrailFile[] | undefined;
      if (goalDone && goal.state !== "done") {
        const doneGoal: Goal = { ...goal, state: "done", updatedAt: now };
        await this.store.saveGoal(doneGoal);
        await this.markGoalDone(doneGoal);
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
      const settled = await this.settleSteps(all, now);
      const ready = settled.changed;
      const final = ready.find((x) => x.id === step.id) ?? next;
      await this.saveStepFrom(final, step);
      const others = endOffersLeavingReady(before, ready.filter((x) => x.id !== step.id), now);
      await this.store.saveSteps(others.steps);
      await this.emitOffersEnded(actor, others.ended);
      await this.store.addNote({ step: step.id, user: actor.userId, text: `Resumed by ${actor.userId}${comment ? `: ${comment}` : ""} (was: ${step.parkedReason ?? step.state})`, at: now });
      await this.emit({ type: "step.resumed", user: actor.userId, goal: step.goal, step: step.id, payload: { comment, was: step.parkedReason } });
      if (final.state === "ready") await this.emitReady(step.goal, step.id);
      await this.emitSkipped(step.goal, settled.skipped);
      const after = all.map((s) => ready.find((x) => x.id === s.id) ?? s);
      if (HubService.goalComplete(after) && goal.state !== "done") {
        await this.store.saveGoal({ ...goal, state: "done", updatedAt: now });
        await this.markGoalDone(goal);
      }
      return (await this.store.getStep(step.id)) ?? final;
    });
  }

  async takeStep(actor: Actor, stepId: string, sid: string | undefined): Promise<Step> {
    return await this.goalTx(async () => {
      const step = await this.stepOr404(stepId);
      const goal = await this.goalOr404(step.goal);
      await this.refuseNonAssignee(actor, step, goal);
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

  async say(actor: Actor, input: { toSid?: string | undefined; to?: string | undefined; toStep?: string | undefined; text: string }): Promise<MessageResult> {
    return await this.store.tx(async () => {
      if (input.toSid === undefined && input.to !== undefined) {
        // MM-4: `<machine>/<session>`, resolved like an assign target (only visible sessions match).
        const t = await this.resolveTarget(actor, input.to);
        if (!t.session) throw new HubError(400, "say needs a session: <machine>/<session>");
        const target = t.session.session.sid;
        const id = await this.message(target, actor.userId, "say", input.text);
        if (id === undefined) throw new HubError(404, `session ${target} is not live on any machine`);
        await this.emit({ type: "message.sent", user: actor.userId, sid: target, payload: { id } });
        return { id, toSid: target, to: `${machineName(t.machine)}/${sessionName(t.session.session)}` };
      }
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
      // A sync lists all the sessions the machine shares, so one it no longer lists (it dropped its
      // step, or the machine went back to sharing step holders only) leaves the live view. The row
      // stays: messages to a former holder and the time rules still read it.
      await this.store.unlistSessions(machine, req.sessions.map((s) => s.sid));
      const facts = req.machine
        ? {
            share: req.machine.share,
            ...(req.machine.repos ? { repos: req.machine.repos } : {}),
            ...(req.machine.accept ? { accept: req.machine.accept } : {}),
            ...(req.machine.headless !== undefined ? { headless: req.machine.headless } : {}),
          }
        : undefined;
      await this.store.touchMachine(machine, now, req.counts, facts);
      const stored = await this.store.getMachine(machine);
      // RL-5: agent files of the machine's repos; reports outside its inventory are dropped.
      if (req.machine?.agents !== undefined) {
        const inventory = new Set((stored?.repos ?? []).map((r) => r.id));
        const kept = req.machine.agents.filter((a) => inventory.has(a.repo));
        if (await this.store.replaceMachineAgents(machine, kept, now)) {
          await this.emit({ type: "agents.reported", user: actor.userId, payload: { machine, count: kept.length } });
        }
      }
      // MM-1: the stored share level tells the daemon this hub applies the visibility rule.
      const share = stored?.share;
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
      for (const g of (await this.store.listGoals()).filter((x) => goalHasTopics(x, want) && x.refs?.pulse === undefined)) {
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

  // ---------- pulses and ingest (RL-3) ----------

  /**
   * Validate a preset snapshot with its params (pulse create, an update of `preset`/`params`,
   * ingest): 400 when the sha256 does not match, else 422 listing every problem. Returns the plan
   * as instantiated for "this goal".
   */
  private async presetChecks(preset: { name: string; text: string; sha256: string }, params: Record<string, string>): Promise<PlanInput> {
    if (createHash("sha256").update(preset.text, "utf8").digest("hex") !== preset.sha256) throw new HubError(400, "preset.sha256 is not the SHA-256 of preset.text");
    const problems: string[] = [];
    const fail = (): never => {
      throw new HubError(422, `the preset has ${problems.length} problem(s): ${problems.join("; ")}`, problems);
    };
    const repo = params.repo;
    if (!repo) problems.push("params.repo is required (the repo the preset's steps work in)");
    let plan: PlanInput;
    try {
      const parsed = parsePreset(preset.name, preset.text);
      try {
        // Without a repo the rest is still checked, against a stand-in name.
        plan = instantiate(parsed, { repo: repo || "repo", goal: "this goal", params });
      } catch (e) {
        problems.push(errorText(e));
        return fail();
      }
    } catch (e) {
      if (e instanceof HubError) throw e;
      problems.push(`preset ${preset.name}: ${errorText(e)}`);
      return fail();
    }
    problems.push(...validatePlan(plan.steps), ...validatePolicies(plan.steps, plan.acs));
    const first = plan.steps.filter((s) => s.deps.length === 0);
    if (first.length !== 1 || first[0]?.kind === "gate") problems.push(`a pulse preset needs exactly one first step (no deps, not a gate); ${preset.name} has ${first.length}`);
    for (const name of profileNames(plan.steps)) {
      if (await this.resolveProfile(name)) continue;
      const step = plan.steps.find((s) => (s.profile ?? (s.mode === "headless" ? HEADLESS_DEFAULTS.profile : undefined)) === name);
      problems.push(`step "${step?.id ?? "?"}": unknown profile "${name}"`);
    }
    // RL-5: roster keys must resolve to a catalog definition.
    problems.push(...(await this.pinAgents(plan.steps)).problems);
    if (problems.length) fail();
    return plan;
  }

  /** R-6: every profile a plan's steps run with, resolved now. */
  private async snapshotProfiles(steps: PlanInput["steps"]): Promise<Record<string, ProfileSnapshot>> {
    const out: Record<string, ProfileSnapshot> = {};
    for (const name of profileNames(steps)) {
      const snap = await this.resolveProfile(name);
      if (snap) out[name] = snap;
    }
    return out;
  }

  /** The stored schedule of a create or update, after its checks (422). */
  private scheduleOf(input: PulseWhenInput, now: number): PulseWhen {
    if ("every" in input) return { every: input.every, anchor: input.at ?? now };
    const c = parseCron(input.cron);
    if (!c.ok) throw new HubError(422, `bad cron "${input.cron}": ${c.error}`);
    if (!validTimeZone(input.tz)) throw new HubError(422, `unknown time zone "${input.tz}"`);
    const when: PulseWhen = { cron: input.cron, tz: input.tz };
    if (nextSlot(when, now) === undefined) throw new HubError(422, `cron "${input.cron}" never fires`);
    const period = periodMs(when, now);
    if (period !== undefined && period < 5 * 60_000) throw new HubError(422, `cron "${input.cron}" fires more often than every 5m`);
    return when;
  }

  /** `windowMs` and `maxGoalAgeMs`: as given, else min(4h, period) and 2 × period. */
  private static timings(when: PulseWhen, window: string | undefined, maxGoalAge: string | undefined, now: number): { windowMs: number; maxGoalAgeMs: number } {
    const period = periodMs(when, now) ?? 366 * 86_400_000;
    return {
      windowMs: window !== undefined ? parseDurationSpec(window) : Math.min(4 * 3_600_000, period),
      maxGoalAgeMs: maxGoalAge !== undefined ? parseDurationSpec(maxGoalAge) : 2 * period,
    };
  }

  private async pulseView(p: Pulse): Promise<PulseView> {
    const { preset, profiles, agents, ...rest } = p;
    return {
      ...rest,
      preset: { name: preset.name, sha256: preset.sha256, ...(preset.source ? { source: preset.source } : {}) },
      profiles: Object.fromEntries(Object.entries(profiles).map(([k, v]) => [k, v.sha256])),
      agents: Object.fromEntries(Object.entries(agents ?? {}).map(([k, v]) => [k, v.hash])),
      schedule: scheduleText(p.when),
      recent: await this.store.listSlots({ pulse: p.id, limit: 10 }),
    };
  }

  private async pulseOr404(id: string): Promise<Pulse> {
    const p = await this.store.getPulse(id);
    if (!p || p.deletedAt !== undefined) throw new HubError(404, `no pulse ${id}`);
    return p;
  }

  private static ownerOrAdmin(actor: Actor, p: Pulse): void {
    if (actor.userId !== p.owner && !actor.roles.includes("admin")) throw new HubError(403, `only @${p.owner} or an admin can change pulse ${p.id}`);
  }

  /** `POST /v1/pulses`. */
  async createPulse(actor: Actor, body: PulseCreate): Promise<PulseView> {
    return await this.goalTx(async () => {
      const now = this.now();
      const plan = await this.presetChecks(body.preset, body.params);
      const topics = await this.knownTopics(body.topics ?? []);
      const when = this.scheduleOf(body.when, now);
      const profiles = await this.snapshotProfiles(plan.steps);
      // RL-5 (R-6): roster keys pinned when the pulse is saved.
      const { agents } = await this.pinAgents(plan.steps);
      const t = HubService.timings(when, body.window, body.maxGoalAge, now);
      const nextAt = body.enabled ? nextSlot(when, now) : undefined;
      const p = await this.store.createPulse({
        owner: actor.userId,
        title: body.title ?? `${body.preset.name} on ${repoName(body.params.repo as string)}`,
        when,
        preset: body.preset,
        params: body.params,
        profiles,
        agents,
        topics,
        target: body.target,
        ...(body.window !== undefined ? { window: body.window } : {}),
        windowMs: t.windowMs,
        overlap: body.overlap,
        ...(body.maxGoalAge !== undefined ? { maxGoalAge: body.maxGoalAge } : {}),
        maxGoalAgeMs: t.maxGoalAgeMs,
        missed: body.missed,
        enabled: body.enabled,
        ...(nextAt !== undefined ? { nextAt } : {}),
        version: 1,
        createdAt: now,
        updatedAt: now,
      });
      await this.emit({ type: "pulse.created", user: actor.userId, payload: { pulse: p.id, title: p.title, preset: p.preset.name, sha256: p.preset.sha256, schedule: scheduleText(p.when) } });
      return await this.pulseView(p);
    });
  }

  /** `GET /v1/pulses`: by number, deleted ones left out; `mine`: only the caller's. */
  async listPulsesView(actor: Actor, mine: boolean): Promise<PulseView[]> {
    return this.store.tx(async () => {
      const out: PulseView[] = [];
      for (const p of await this.store.listPulses(mine ? { owner: actor.userId } : {})) out.push(await this.pulseView(p));
      return out;
    });
  }

  /** `GET /v1/pulses/:id`. */
  async pulseDetail(id: string): Promise<PulseDetail> {
    return this.store.tx(async () => {
      const pulse = await this.pulseOr404(id);
      const slots = await this.store.listSlots({ pulse: pulse.id, limit: 50 });
      const goals: Record<string, GoalState> = {};
      for (const s of slots) {
        if (s.goal === undefined || goals[s.goal] !== undefined) continue;
        const g = await this.store.getGoal(s.goal);
        if (g) goals[s.goal] = g.state;
      }
      return { pulse, schedule: scheduleText(pulse.when), slots, goals };
    });
  }

  /** `POST /v1/pulses/:id/update`: only the given fields; `preset`/`params` re-snapshot and bump `version`. */
  async updatePulse(actor: Actor, id: string, body: PulseUpdate): Promise<PulseView> {
    return await this.goalTx(async () => {
      const p = await this.pulseOr404(id);
      HubService.ownerOrAdmin(actor, p);
      const now = this.now();
      let next: Pulse = { ...p };
      if (body.preset !== undefined || body.params !== undefined) {
        const preset = body.preset ?? p.preset;
        const params = body.params ?? p.params;
        const plan = await this.presetChecks(preset, params);
        next = { ...next, preset, params, profiles: await this.snapshotProfiles(plan.steps), agents: (await this.pinAgents(plan.steps)).agents, version: p.version + 1 };
      }
      if (body.topics !== undefined) next.topics = await this.knownTopics(body.topics);
      if (body.when !== undefined) {
        const { nextAt: _old, ...rest } = next;
        const when = this.scheduleOf(body.when, now);
        const at = next.enabled ? nextSlot(when, now) : undefined;
        next = { ...rest, when, ...(at !== undefined ? { nextAt: at } : {}) };
      }
      if (body.title !== undefined) next.title = body.title;
      if (body.target !== undefined) next.target = body.target;
      if (body.overlap !== undefined) next.overlap = body.overlap;
      if (body.missed !== undefined) next.missed = body.missed;
      if (body.window !== undefined) next.window = body.window;
      if (body.maxGoalAge !== undefined) next.maxGoalAge = body.maxGoalAge;
      const t = HubService.timings(next.when, next.window, next.maxGoalAge, now);
      next = { ...next, windowMs: t.windowMs, maxGoalAgeMs: t.maxGoalAgeMs, updatedAt: now };
      await this.store.savePulse(next);
      await this.emit({ type: "pulse.updated", user: actor.userId, payload: { pulse: p.id, version: next.version, fields: Object.keys(body).sort() } });
      return await this.pulseView(next);
    });
  }

  async pausePulse(actor: Actor, id: string): Promise<PulseView> {
    return await this.goalTx(async () => {
      const p = await this.pulseOr404(id);
      HubService.ownerOrAdmin(actor, p);
      if (!p.enabled) throw new HubError(409, `pulse ${p.id} is already paused`);
      const { nextAt: _n, ...rest } = p;
      const reason = `paused by ${actor.userId}`;
      const next: Pulse = { ...rest, enabled: false, pausedReason: reason, updatedAt: this.now() };
      await this.store.savePulse(next);
      await this.emit({ type: "pulse.paused", user: actor.userId, payload: { pulse: p.id, reason } });
      return await this.pulseView(next);
    });
  }

  async resumePulse(actor: Actor, id: string): Promise<PulseView> {
    return await this.goalTx(async () => {
      const p = await this.pulseOr404(id);
      HubService.ownerOrAdmin(actor, p);
      if (p.enabled) throw new HubError(409, `pulse ${p.id} is not paused`);
      const now = this.now();
      const { pausedReason: _r, nextAt: _n, ...rest } = p;
      const at = nextSlot(p.when, now);
      const next: Pulse = { ...rest, enabled: true, ...(at !== undefined ? { nextAt: at } : {}), updatedAt: now };
      await this.store.savePulse(next);
      await this.emit({ type: "pulse.resumed", user: actor.userId, payload: { pulse: p.id } });
      return await this.pulseView(next);
    });
  }

  /** `POST /v1/pulses/:id/delete`: a soft delete; its slots and goals stay. */
  async deletePulse(actor: Actor, id: string): Promise<{ pulse: string }> {
    return await this.goalTx(async () => {
      const p = await this.pulseOr404(id);
      HubService.ownerOrAdmin(actor, p);
      const now = this.now();
      const { nextAt: _n, ...rest } = p;
      await this.store.savePulse({ ...rest, enabled: false, deletedAt: now, updatedAt: now });
      await this.emit({ type: "pulse.deleted", user: actor.userId, payload: { pulse: p.id } });
      return { pulse: p.id };
    });
  }

  /** `POST /v1/pulses/:id/fire`: a manual slot now (also while paused); `nextAt` is not changed. */
  async firePulse(actor: Actor, id: string): Promise<FireResult> {
    const now = this.now();
    const slotId = manualSlot(now);
    try {
      return {
        slot: await this.goalTx(async () => {
          const p = await this.pulseOr404(id);
          HubService.ownerOrAdmin(actor, p);
          return await this.fireSlot(p, slotId, now, now, { manual: true, by: actor.userId });
        }),
      };
    } catch (e) {
      if (e instanceof HubError) throw e;
      const error = errorText(e).slice(0, 500);
      return {
        slot: await this.goalTx(async () => {
          const p = await this.pulseOr404(id);
          const slot: PulseSlot = { pulse: p.id, slot: slotId, at: now, state: "missed", reason: "error", manual: true, by: actor.userId, error, tried: [], decidedAt: now };
          if (await this.store.addSlot(slot)) await this.emit({ type: "pulse.missed", payload: { pulse: p.id, slot: slotId, reason: "error", tried: 0, error } });
          return (await this.store.getSlot(p.id, slotId)) ?? slot;
        }),
      };
    }
  }

  /** `POST /v1/goals/from-preset` (ingest): a goal with an approved plan, owned by the caller. */
  async goalFromPreset(actor: Actor, b: GoalFromPreset): Promise<GoalDetail> {
    if (b.refs && (Object.hasOwn(b.refs, "pulse") || Object.hasOwn(b.refs, "slot"))) throw new HubError(400, "refs.pulse and refs.slot are set by pulses only");
    const id = await this.goalTx(async () => {
      const now = this.now();
      const plan = await this.presetChecks(b.preset, b.params);
      const topics = await this.knownTopics(b.topics ?? []);
      const profiles = await this.snapshotProfiles(plan.steps);
      const { agents } = await this.pinAgents(plan.steps);
      const goal = await this.createWithPlan(
        {
          owner: actor.userId,
          title: b.title ?? `${b.preset.name} on ${repoName(b.params.repo as string)}`,
          preset: b.preset,
          params: b.params,
          profiles,
          agents,
          topics,
          priority: b.priority,
          refs: b.refs,
          comment: `ingest (preset ${b.preset.name} ${b.preset.sha256.slice(0, 12)})`,
          extra: {},
        },
        now,
      );
      return goal.id;
    });
    return await this.goalDetail(id);
  }

  /**
   * Create-with-plan (inside `goalTx`): a goal with plan v1 approved by its owner, no design step,
   * steps materialized and settled as an approval does. No inbox message.
   */
  private async createWithPlan(
    o: {
      owner: string;
      title: string;
      preset: { name: string; text: string; sha256: string };
      params: Record<string, string>;
      profiles: Record<string, ProfileSnapshot>;
      /** RL-5: the roster pins of the goal (R-6). */
      agents: Record<string, AgentDef>;
      topics: readonly string[];
      priority: number;
      refs?: Record<string, string> | undefined;
      comment: string;
      extra: Record<string, unknown>;
      /** RL-6: set on calibration goals only. */
      calibration?: GoalCalibration | undefined;
    },
    now: number,
  ): Promise<Goal> {
    const repo = o.params.repo as string;
    const goal = await this.store.createGoal({
      title: o.title,
      ownerId: o.owner,
      state: "in_progress",
      primaryRepo: repo,
      preset: { name: o.preset.name, text: o.preset.text },
      ...(o.refs && Object.keys(o.refs).length ? { refs: o.refs } : {}),
      ...(o.topics.length ? { topics: [...o.topics] } : {}),
      priority: o.priority,
      profiles: o.profiles,
      ...(Object.keys(o.agents).length ? { agents: o.agents } : {}),
      ...(o.calibration ? { calibration: o.calibration } : {}),
      createdAt: now,
      updatedAt: now,
    });
    const input = instantiate(parsePreset(o.preset.name, o.preset.text), { repo, goal: goal.id, params: o.params });
    const plan: Plan = {
      goal: goal.id,
      version: 1,
      steps: input.steps,
      ...(input.acs?.length ? { acs: input.acs } : {}),
      proposedBy: o.owner,
      proposedAt: now,
      decision: "approved",
      decidedBy: o.owner,
      decidedAt: now,
      comment: o.comment,
    };
    await this.store.savePlan(plan);
    await this.emit({ type: "goal.created", user: o.owner, goal: goal.id, payload: { title: goal.title, preset: o.preset.name, ...o.extra } });
    const m = materialize(goal.id, 1, plan.steps, [], now);
    await this.applyApproved({ userId: o.owner }, goal, plan, [], [...m.upserts], m, now);
    return (await this.store.getGoal(goal.id)) ?? goal;
  }

  // ---------- calibration and agent statistics (RL-6) ----------

  /** Everything counting needs (inside the caller's transaction), with the existing unfiltered reads. */
  private async calibrationScan(): Promise<{
    steps: Step[];
    reviews: StoredReview[];
    entries: Entry[];
    raising: Map<string, AgentRef | null>;
    counted: Counted[];
    status: ReturnType<typeof calibrationStatus>;
    goals: Goal[];
  }> {
    const steps = await this.store.listSteps({});
    const reviews = await this.store.listReviews({ raising: true });
    const rows = await this.store.listDispositions({});
    // One ordered read of the whole item history, grouped per item (not one read per item).
    const history = new Map<string, ItemHistoryEntry[]>();
    for (const h of await this.store.listItemHistory()) {
      const k = `${h.lineage}\n${h.fp}`;
      const list = history.get(k);
      if (list) list.push(h.entry);
      else history.set(k, [h.entry]);
    }
    const entries = flagEntries(rows, (lineage, fp) => history.get(`${lineage}\n${fp}`) ?? []);
    const raising = raisingAgents(reviews);
    const counted = countedDismissals(entries, raising);
    const goals = await this.store.listGoals();
    return { steps, reviews, entries, raising, counted, status: calibrationStatus(goals), goals };
  }

  /** The catalog definition of an agent hash: the first source by repo id with a matching definition (any commit). */
  private async catalogDefOf(agent: AgentRef): Promise<{ source: { repo: string; calibrator?: string | undefined }; def: CatalogDefView } | undefined> {
    if (!agent.hash) return undefined;
    for (const source of await this.store.listCatalogSources()) {
      const def = (await this.store.listCatalogDefs({ repo: source.repo })).find((d) => canonicalKey(source.repo, d.name) === agent.key && d.hash === agent.hash);
      if (def) return { source, def };
    }
    return undefined;
  }

  /** The raising agent of a lineage in a goal: the decider of its newest raising record when an agent. */
  private async raisingAgentOf(lineage: string, goalId: string): Promise<AgentRef | undefined> {
    const rec = (await this.store.listReviews({ lineage, raising: true })).filter((r) => r.goal === goalId).at(-1);
    return rec?.decider.kind === "agent" ? { key: rec.decider.key, hash: rec.decider.hash ?? "" } : undefined;
  }

  /** After a recorded dismissal (inside its transaction): the trigger for the agent that raised the item. */
  private async calibrationAfterDismissal(lineage: string, goalId: string, now: number): Promise<void> {
    const agent = await this.raisingAgentOf(lineage, goalId);
    if (agent) await this.calibrationTrigger(agent, now);
  }

  /** Who calibrates an agent hash, and the repo of its calibration goal. */
  private async calibratorFor(
    agent: AgentRef,
    list: readonly Counted[],
    scan: { steps: readonly Step[]; goals: readonly Goal[] },
  ): Promise<{ user: string; repo: string } | undefined> {
    const newest = list.at(-1);
    if (!newest) return undefined;
    const found = await this.catalogDefOf(agent);
    const lineage = newest.ref.lineage;
    const repo = found ? found.source.repo : lineage.slice(lineage.indexOf("|") + 1, lineage.lastIndexOf("|"));
    const exists = async (u: string | undefined) => (u ? (await this.store.getUser(u)) !== undefined : false);
    // 1. The catalog source's calibrator.
    if (found?.source.calibrator && (await exists(found.source.calibrator))) return { user: found.source.calibrator, repo };
    // 2. The owner of the newest pulse goal that ran the agent key (any hash).
    const pulseGoals = new Map(scan.goals.filter((g) => g.refs?.pulse !== undefined).map((g) => [g.id, g] as const));
    let best: { at: number; owner: string } | undefined;
    for (const s of scan.steps) {
      const g = pulseGoals.get(s.goal);
      if (!g) continue;
      for (const r of s.rounds ?? []) {
        if (r.telemetry?.agentKey !== agent.key) continue;
        if (!best || r.finishedAt > best.at) best = { at: r.finishedAt, owner: g.ownerId };
      }
    }
    if (best && (await exists(best.owner))) return { user: best.owner, repo };
    // 3. The owner of the goal of the newest uncalibrated dismissal.
    const owner = scan.goals.find((g) => g.id === newest.ref.goal)?.ownerId;
    if (await exists(owner)) return { user: owner as string, repo };
    return undefined;
  }

  /**
   * The calibration trigger (inside the transaction that recorded a dismissal or finished a
   * calibration goal): opens one calibration goal for an agent hash with no open one whose
   * uncalibrated dismissals reach the threshold.
   */
  private async calibrationTrigger(agent: AgentRef, now: number): Promise<void> {
    if (!agent.hash) return;
    const scan = await this.calibrationScan();
    if (openCalibration(scan.goals, agent)) return;
    const list = uncalibrated(scan.counted, scan.status, agent);
    const t = this.config.calibration.threshold;
    if (list.length < t) return;
    const who = await this.calibratorFor(agent, list, scan);
    if (!who) return;
    const hash12 = agent.hash.slice(0, 12);
    const text = presetText(CALIBRATE_PRESET);
    const goal = await this.createWithPlan(
      {
        owner: who.user,
        title: `Calibrate ${agent.key}@${hash12}`,
        preset: { name: CALIBRATE_PRESET.name, text, sha256: createHash("sha256").update(text, "utf8").digest("hex") },
        params: { repo: who.repo, agent: agent.key, hash: hash12 },
        profiles: {},
        agents: {},
        topics: [],
        priority: 3,
        comment: `calibration of ${agent.key}@${hash12} (${list.length} dismissals, threshold ${t})`,
        extra: {},
        calibration: { key: agent.key, hash: agent.hash, threshold: t, dismissals: list.map((c) => c.ref) },
      },
      now,
    );
    await this.emit({
      at: now,
      type: "calibration.opened",
      user: who.user,
      goal: goal.id,
      payload: { key: agent.key, hash: agent.hash, dismissals: list.length, threshold: t, calibrator: who.user },
    });
  }

  /** Emit `goal.done` (the goal is already saved done); a calibration goal also finishes its calibration. */
  private async markGoalDone(goal: Goal, at?: number): Promise<void> {
    await this.emit({ ...(at !== undefined ? { at } : {}), type: "goal.done", goal: goal.id });
    const c = goal.calibration;
    if (!c) return;
    const assessment = (await this.latestReview(`${goal.id}.calibrate`))?.record.assessment;
    const outcome = assessment === "issues" ? "change" : assessment === "clean" ? "no-change" : "none";
    await this.emit({
      ...(at !== undefined ? { at } : {}),
      type: "calibration.done",
      goal: goal.id,
      payload: { key: c.key, hash: c.hash, dismissals: c.dismissals.length, outcome },
    });
    await this.calibrationTrigger({ key: c.key, hash: c.hash }, at ?? this.now());
  }

  /** `GET /v1/agents/:key/stats`: an agent key's statistics per hash. */
  async agentStats(key: string, daysRaw: string | undefined): Promise<AgentStats> {
    let days = 30;
    if (daysRaw !== undefined) {
      days = /^\d+$/.test(daysRaw) ? Number(daysRaw) : NaN;
      if (!Number.isInteger(days) || days < 1 || days > 365) throw new HubError(400, "days must be a whole number from 1 to 365");
    }
    if (!key || key.length > 330 || !key.includes("/")) throw new HubError(400, "an agent key is <repo>/<name>");
    return await this.store.tx(async () => {
      const scan = await this.calibrationScan();
      const since = this.now() - days * 86_400_000;
      return computeAgentStats({ key, days, since, threshold: this.config.calibration.threshold, ...scan });
    });
  }

  /** The `calibration` input of a calibration goal's step: the listed dismissals with their items and evidence. */
  private async calibrationInput(goal: Goal): Promise<{ title: string; content: string } | undefined> {
    const c = goal.calibration;
    if (!c) return undefined;
    const found = await this.catalogDefOf({ key: c.key, hash: c.hash });
    const dismissals: Record<string, unknown>[] = [];
    for (const ref of c.dismissals) {
      const entry = (await this.store.listDispositions({ lineage: ref.lineage, fp: ref.fp, goal: ref.goal })).find(
        (d) => d.step === ref.step && d.round === ref.round && d.at === ref.at,
      );
      const item = await this.store.getItem(ref.lineage, ref.fp);
      const rec = (await this.store.listReviews({ lineage: ref.lineage, raising: true })).filter((r) => r.goal === ref.goal).at(-1);
      const evidence = rec?.record.items.find((i) => i.fp === ref.fp)?.evidence ?? [];
      dismissals.push({
        lineage: ref.lineage,
        fp: ref.fp,
        goal: ref.goal,
        step: ref.step,
        round: ref.round,
        at: ref.at,
        reason: entry?.reason ?? "",
        ...(entry ? { decider: entry.decider, via: entry.via } : {}),
        ...(entry?.answer !== undefined ? { answer: entry.answer } : {}),
        title: item?.title ?? "",
        severity: item?.severity,
        category: item?.category,
        rule: item?.rule,
        ...(item?.path !== undefined ? { path: item.path } : {}),
        ...(item?.symbol !== undefined ? { symbol: item.symbol } : {}),
        evidence,
      });
    }
    const agent = { key: c.key, hash: c.hash, ...(found ? { text: found.def.text } : {}) };
    return { title: `dismissals of ${c.key}@${c.hash.slice(0, 12)} (${c.dismissals.length})`, content: JSON.stringify({ agent, dismissals }) };
  }

  /** The run step of a pulse goal: plan v1's step without deps. */
  private async runStepOf(goal: Goal): Promise<string | undefined> {
    const v1 = (await this.store.listPlans(goal.id)).find((p) => p.version === 1);
    const first = v1?.steps.find((s) => s.deps.length === 0);
    return first ? `${goal.id}.${first.id}` : undefined;
  }

  /** The pending slot of a pulse goal whose run step is `step`, or undefined. */
  private async pendingSlotOf(goal: Goal | undefined, step: Step): Promise<PulseSlot | undefined> {
    const pulse = goal?.refs?.pulse;
    const slotId = goal?.refs?.slot;
    if (!goal || pulse === undefined || slotId === undefined) return undefined;
    if ((await this.runStepOf(goal)) !== step.id) return undefined;
    const slot = await this.store.getSlot(pulse, slotId);
    return slot && slot.state === "fired" && slot.startedAt === undefined ? slot : undefined;
  }

  /** A `run.started` report on a pending slot's run step: the slot started. */
  private async markSlotStarted(step: Step): Promise<void> {
    const slot = await this.pendingSlotOf(await this.store.getGoal(step.goal), step);
    if (slot) await this.store.saveSlot({ ...slot, startedAt: this.now() });
  }

  /** A release of a pending slot's run step: the last try's outcome (`capacity:` notes: capacity). */
  private async slotReleased(goal: Goal, step: Step, note: string | undefined): Promise<void> {
    const slot = await this.pendingSlotOf(goal, step);
    const last = slot?.tried.at(-1);
    if (!slot || !last) return;
    const outcome = note?.startsWith("capacity:") ? "capacity" : "released";
    await this.store.saveSlot({ ...slot, tried: [...slot.tried.slice(0, -1), { ...last, outcome }] });
  }

  /** The last try's outcome from the run step's offer to that machine, when it has none yet. */
  private static syncLastTry(slot: PulseSlot, rs: Step): PulseSlot {
    const last = slot.tried.at(-1);
    const o = rs.offer;
    if (!last || last.outcome !== undefined || !o || o.to.machine !== last.machine || o.at < last.at) return slot;
    const outcome = o.state === "declined" ? "declined" : o.state === "expired" || o.state === "withdrawn" ? "timeout" : o.state === "accepted" ? "accepted" : undefined;
    if (!outcome) return slot;
    return { ...slot, tried: [...slot.tried.slice(0, -1), { ...last, outcome }] };
  }

  /** Has the slot's run started (a run report, an interactive claim, or the goal is done)? */
  private async slotStarted(goal: Goal, rs: Step | undefined): Promise<boolean> {
    if (goal.state === "done") return true;
    if (!rs) return false;
    if (rs.policy?.mode === "headless") {
      if (rs.state === "done" || rs.state === "failed") return true;
      return (await this.store.eventsFor({ step: rs.id })).some((e) => e.type === "run.started");
    }
    return rs.state === "claimed" || rs.state === "paused" || rs.state === "done" || rs.state === "failed";
  }

  /**
   * Drop a goal (inside `goalTx`): every step not done, skipped, dropped or failed is dropped (open
   * offers withdrawn); `goal.dropped` and `step.dropped` carry the reason.
   */
  private async dropGoal(goalId: string, reason: "abandoned" | "missed", now: number): Promise<void> {
    const goal = await this.store.getGoal(goalId);
    if (!goal || goal.state === "dropped") return;
    const dropped: Step[] = [];
    const ended: Step[] = [];
    for (const s of await this.store.listSteps({ goal: goal.id })) {
      if (s.state === "done" || s.state === "skipped" || s.state === "dropped" || s.state === "failed") continue;
      const next: Step = { ...s, state: "dropped", updatedAt: now };
      if (s.offer?.state === "offered") {
        next.offer = { ...s.offer, state: "withdrawn", decidedAt: now };
        ended.push(next);
      }
      dropped.push(next);
    }
    if (dropped.length) await this.store.saveSteps(dropped);
    await this.store.saveGoal({ ...goal, state: "dropped", updatedAt: now });
    await this.emit({ type: "goal.dropped", goal: goal.id, payload: { reason } });
    for (const s of dropped) await this.emit({ type: "step.dropped", goal: goal.id, step: s.id, payload: { reason } });
    await this.emitOffersEnded(undefined, ended);
  }

  /**
   * Advance a pending slot (inside `goalTx`): started → `startedAt`; window over → `missed` and its
   * goal dropped; else (with `attempt`) offer the run step to the next machine.
   */
  private async advanceSlot(slot: PulseSlot, p: Pulse, now: number, o: { attempt: boolean }): Promise<PulseSlot> {
    const goal = slot.goal !== undefined ? await this.store.getGoal(slot.goal) : undefined;
    if (!goal) return slot;
    const rsId = await this.runStepOf(goal);
    const rs = rsId ? await this.store.getStep(rsId) : undefined;
    let s = rs ? HubService.syncLastTry(slot, rs) : slot;
    if (await this.slotStarted(goal, rs)) {
      s = { ...s, startedAt: now };
      await this.store.saveSlot(s);
      return s;
    }
    if (s.until !== undefined && now >= s.until) {
      const last = s.tried.at(-1);
      const reason: SlotReason = !last ? "no_machine" : last.outcome === "capacity" ? "capacity" : last.outcome === "accepted" ? "expired" : "not_accepted";
      if (rs?.offer?.state === "offered") await this.withdrawOffer({ userId: p.owner }, rs, "pulse: slot missed");
      await this.dropGoal(goal.id, "missed", now);
      s = { ...s, state: "missed", reason, decidedAt: now };
      await this.store.saveSlot(s);
      await this.emit({ type: "pulse.missed", goal: goal.id, payload: { pulse: p.id, slot: s.slot, reason, tried: s.tried.length } });
      return s;
    }
    if (o.attempt && rs?.state === "ready") s = await this.attempt(s, p, goal, rs, now);
    if (s !== slot) await this.store.saveSlot(s);
    return s;
  }

  /**
   * One attempt (inside `goalTx`): wait on an open offer (a person's, or the last try's within its
   * timeout), withdraw a timed-out one, then offer the run step to the first candidate not tried.
   */
  private async attempt(slot: PulseSlot, p: Pulse, goal: Goal, rs: Step, now: number): Promise<PulseSlot> {
    // RL-4: a debrief is never offered (defensive: a pulse's run step is a headless one).
    if (isDebrief(rs.policy)) return slot;
    let s = slot;
    let step = rs;
    const expiry = this.config.thresholds.offerExpiryMs;
    if (step.offer?.state === "offered") {
      const last = s.tried.at(-1);
      if (!last || step.offer.to.machine !== last.machine) return s;
      if (now - step.offer.at < Math.min(expiry, Math.floor(p.windowMs / 3))) return s;
      step = await this.withdrawOffer({ userId: p.owner }, step, "pulse: not accepted in time");
      s = { ...s, tried: [...s.tried.slice(0, -1), { ...last, outcome: "timeout" }] };
    }
    const machines = await this.store.listMachines();
    const candidates = pulseCandidates({
      owner: p.owner,
      repo: step.repo,
      topics: goal.topics ?? [],
      target: p.target,
      headless: step.policy?.mode === "headless",
      tried: new Set(s.tried.map((t) => t.machine)),
      now,
      onlineMs: this.config.thresholds.machineOfflineMs,
      machines,
      sessions: await this.store.listSessions({ live: true }),
    });
    for (const c of candidates) {
      const machine = machines.find((m) => m.id === c.machine);
      if (!machine) continue;
      const guard = await this.headlessGuard(step, machine, goal);
      if (!guard.ok) continue;
      const offered = await this.offerStep(step, { machine }, { userId: p.owner }, { stick: false, goal, snapshot: guard.snapshot, deadline: Math.min(now + expiry, s.until ?? Number.MAX_SAFE_INTEGER) });
      s = { ...s, tried: [...s.tried, { machine: machine.id, at: now }] };
      await this.setStick((await this.store.getGoal(goal.id)) ?? goal, { to: offered.offer?.to ?? { machine: machine.id }, by: p.owner });
      return s;
    }
    return s;
  }

  /**
   * Fire a slot (inside the pulse's transaction): insert its row (once), retire pending slots whose
   * window is over, abandon started goals past `maxGoalAge`, skip on overlap, else create the goal
   * and make one attempt.
   */
  private async fireSlot(p: Pulse, slotId: string, at: number, now: number, o: { manual?: boolean; by?: string; catchUp?: boolean }): Promise<PulseSlot> {
    const base: PulseSlot = {
      pulse: p.id,
      slot: slotId,
      at,
      state: "fired",
      ...(o.manual ? { manual: true as const, ...(o.by !== undefined ? { by: o.by } : {}) } : {}),
      ...(o.catchUp ? { catchUp: true as const } : {}),
      tried: [],
      decidedAt: now,
    };
    if (!(await this.store.addSlot(base))) return (await this.store.getSlot(p.id, slotId)) ?? base;
    // Retire: pending slots whose window is over end now (their goals dropped).
    for (const s of await this.store.listSlots({ pulse: p.id, pending: true })) {
      if (s.slot !== slotId) await this.advanceSlot(s, p, now, { attempt: false });
    }
    // Abandon: started goals older than maxGoalAge.
    for (const s of await this.store.listSlots({ pulse: p.id, state: "fired" })) {
      if (s.slot === slotId || s.startedAt === undefined || s.goal === undefined) continue;
      const g = await this.store.getGoal(s.goal);
      if (!g || g.state === "done" || g.state === "dropped" || now - g.createdAt < p.maxGoalAgeMs) continue;
      await this.dropGoal(g.id, "abandoned", now);
      await this.store.saveSlot({ ...s, state: "abandoned", reason: "max_goal_age", decidedAt: now });
      await this.emit({ type: "pulse.abandoned", goal: g.id, payload: { pulse: p.id, slot: s.slot } });
    }
    // Overlap.
    if (p.overlap === "skip") {
      let running: string | undefined;
      for (const s of await this.store.listSlots({ pulse: p.id, state: "fired" })) {
        if (s.slot === slotId || s.goal === undefined) continue;
        const g = await this.store.getGoal(s.goal);
        if (g && g.state !== "done" && g.state !== "dropped") {
          running = g.id;
          break;
        }
      }
      if (running !== undefined) {
        const skipped: PulseSlot = { ...base, state: "skipped", reason: "overlap" };
        await this.store.saveSlot(skipped);
        await this.emit({ type: "pulse.skipped", payload: { pulse: p.id, slot: slotId, reason: "overlap", running } });
        return skipped;
      }
    }
    const goal = await this.createWithPlan(
      {
        owner: p.owner,
        title: `${p.title} (${slotId})`,
        preset: p.preset,
        params: p.params,
        profiles: p.profiles,
        agents: p.agents ?? {},
        topics: p.topics,
        priority: 3,
        refs: { pulse: p.id, slot: slotId },
        comment: `pulse ${p.id} (preset ${p.preset.name} ${p.preset.sha256.slice(0, 12)})`,
        extra: { pulse: p.id, slot: slotId },
      },
      now,
    );
    let slot: PulseSlot = { ...base, goal: goal.id, firedAt: now, until: (o.manual || o.catchUp ? now : at) + p.windowMs };
    await this.store.saveSlot(slot);
    await this.emit({
      type: "pulse.fired",
      ...(o.manual && o.by !== undefined ? { user: o.by } : {}),
      goal: goal.id,
      payload: { pulse: p.id, slot: slotId, ...(o.manual ? { manual: true } : {}), ...(o.catchUp ? { catchUp: true } : {}) },
    });
    const rsId = await this.runStepOf(goal);
    const rs = rsId ? await this.store.getStep(rsId) : undefined;
    if (rs?.state === "ready") {
      const tried = await this.attempt(slot, p, goal, rs, now);
      if (tried !== slot) {
        slot = tried;
        await this.store.saveSlot(slot);
      }
    }
    return slot;
  }

  /** The due slot times `nextAt <= t <= now`, the latest 11 of them, ascending. */
  private static dueSlots(when: PulseWhen, from: number, now: number): number[] {
    const KEEP = 11;
    if ("every" in when) {
      const period = parseDurationSpec(when.every);
      const count = Math.floor((now - from) / period) + 1;
      const out: number[] = [];
      for (let k = Math.max(0, count - KEEP); k < count; k++) out.push(from + k * period);
      return out;
    }
    const out: number[] = [];
    let t: number | undefined = from;
    while (t !== undefined && t <= now) {
      out.push(t);
      if (out.length > KEEP) out.shift();
      t = nextSlot(when, t);
    }
    return out;
  }

  /**
   * Fire one due pulse (inside its own `goalTx`): re-read it; pause it when its owner is no longer a
   * member; record `hub_down` slots; fire the latest due slot when within its window (or catch up);
   * then move `nextAt`. With `error` (the first transaction threw), the latest slot is recorded
   * `missed` with that error instead of firing.
   */
  private async firePulseTx(id: string, now: number, error?: string): Promise<void> {
    const p = await this.store.getPulse(id);
    if (!p || !p.enabled || p.deletedAt !== undefined || p.nextAt === undefined || p.nextAt > now) return;
    const owner = await this.store.getUser(p.owner);
    if (!owner || !owner.roles.some((r) => r === "member" || r === "approver" || r === "admin")) {
      const { nextAt: _n, ...rest } = p;
      const reason = `owner ${p.owner} is not a member`;
      await this.store.savePulse({ ...rest, enabled: false, pausedReason: reason, updatedAt: now });
      await this.emit({ type: "pulse.paused", payload: { pulse: p.id, reason } });
      return;
    }
    const due = HubService.dueSlots(p.when, p.nextAt, now);
    const last = due.at(-1) as number;
    const inWindow = now - last < p.windowMs;
    const fires = inWindow || p.missed === "catch-up-once";
    const down = (fires ? due.slice(0, -1) : due).slice(-10);
    for (const t of down) {
      const slot = new Date(t).toISOString();
      if (await this.store.addSlot({ pulse: p.id, slot, at: t, state: "missed", reason: "hub_down", tried: [], decidedAt: now })) {
        await this.emit({ type: "pulse.missed", payload: { pulse: p.id, slot, reason: "hub_down", tried: 0 } });
      }
    }
    if (fires) {
      const slot = new Date(last).toISOString();
      if (error !== undefined) {
        const message = error.slice(0, 500);
        if (await this.store.addSlot({ pulse: p.id, slot, at: last, state: "missed", reason: "error", error: message, tried: [], decidedAt: now })) {
          await this.emit({ type: "pulse.missed", payload: { pulse: p.id, slot, reason: "error", tried: 0, error: message } });
        }
      } else {
        await this.fireSlot(p, slot, last, now, inWindow ? {} : { catchUp: true });
      }
    }
    const { nextAt: _old, ...rest } = p;
    const next = nextSlot(p.when, now);
    await this.store.savePulse({ ...rest, ...(next !== undefined ? { nextAt: next } : {}) });
  }

  /** Tick: fire every due pulse, each in its own transaction; a throw is recorded as an `error` slot. */
  private async fireDue(now: number): Promise<void> {
    for (const seen of await this.store.duePulses(now)) {
      try {
        await this.goalTx(() => this.firePulseTx(seen.id, now));
      } catch (e) {
        try {
          await this.goalTx(() => this.firePulseTx(seen.id, now, errorText(e)));
        } catch (e2) {
          process.stderr.write(`hub tick failed: ${errorText(e2)}\n`);
        }
      }
    }
  }

  /** Tick: advance every pending slot of a pulse that is not deleted, each in its own transaction. */
  private async advancePending(now: number): Promise<void> {
    for (const seen of await this.store.listSlots({ pending: true })) {
      try {
        await this.goalTx(async () => {
          const s = await this.store.getSlot(seen.pulse, seen.slot);
          if (!s || s.state !== "fired" || s.startedAt !== undefined) return;
          const p = await this.store.getPulse(s.pulse);
          if (!p || p.deletedAt !== undefined) return;
          await this.advanceSlot(s, p, now, { attempt: true });
        });
      } catch (e) {
        process.stderr.write(`hub tick failed: ${errorText(e)}\n`);
      }
    }
  }

  // ---------- roster (RL-5) ----------

  /**
   * A repo copy reported by machine `m` is visible to its user when `m` shares `me` or `all`, and to
   * everyone when it shares `all`; under `steps` (or no stored level) to nobody.
   */
  private static agentCopyVisible(viewer: Actor, m: MachineRow | undefined): boolean {
    return m?.share === "all" || (m?.share === "me" && m.userId === viewer.userId);
  }

  /** `POST /v1/catalog-sources` (admin): register a catalog source or change its folder/calibrator. */
  async saveCatalogSource(actor: Actor, body: CatalogSourceSave): Promise<{ view: CatalogSourceView; created: boolean }> {
    return await this.store.tx(async () => {
      await this.store.serialize();
      const now = this.now();
      const fromRemote = repoFromRemote(body.repo);
      let id: string;
      if (fromRemote && !fromRemote.id.startsWith("local/")) id = fromRemote.id;
      else {
        const lower = body.repo.toLowerCase().replace(/\.git$/, "");
        if (!/^[a-z0-9][a-z0-9.-]*(\/[a-z0-9._-]+)+$/.test(lower)) throw new HubError(422, "repo must be a repo id (host/path) or a remote URL");
        id = lower;
      }
      if (!/^[a-z0-9][a-z0-9._-]*(\/[a-z0-9._-]+)+$/.test(id)) throw new HubError(422, `repo id ${id} cannot be used in an agent key`);
      if (id.length > CATALOG_REPO_MAX) throw new HubError(422, `repo id ${id} is over ${CATALOG_REPO_MAX} characters`);
      const segments = body.folder.split("/");
      if (!/^[A-Za-z0-9._-]+(\/[A-Za-z0-9._-]+)*$/.test(body.folder) || segments.some((s) => s === "." || s === "..")) {
        throw new HubError(422, "folder must be a relative path inside the repo");
      }
      const existing = await this.store.getCatalogSource(id);
      // A body without `calibrator` keeps the stored one.
      const view: CatalogSourceView = existing
        ? { ...existing, folder: body.folder, ...(body.calibrator !== undefined ? { calibrator: body.calibrator } : {}) }
        : {
            repo: id,
            name: id.slice(id.lastIndexOf("/") + 1),
            folder: body.folder,
            ...(body.calibrator !== undefined ? { calibrator: body.calibrator } : {}),
            createdBy: actor.userId,
            createdAt: now,
            count: 0,
          };
      await this.store.saveCatalogSource(view);
      await this.emit({ type: "catalog.saved", user: actor.userId, payload: { repo: id, folder: body.folder } });
      return { view, created: !existing };
    });
  }

  /** `GET /v1/catalog-sources`. */
  async listCatalogSources(): Promise<{ sources: CatalogSourceView[] }> {
    return { sources: await this.store.listCatalogSources() };
  }

  /** `POST /v1/catalog-sources/push`: the committed definitions of a source at one commit. */
  async pushCatalog(actor: Actor, body: CatalogPush): Promise<{ source: CatalogSourceView; added: number }> {
    if (!actor.machineId) throw new HubError(403, "a catalog push needs a device token");
    const machineId = actor.machineId;
    return await this.store.tx(async () => {
      // Reads the source and its definitions, then writes current flags and the source row.
      await this.store.serialize();
      const now = this.now();
      const src = await this.store.getCatalogSource(body.repo);
      if (!src) throw new HubError(404, `no catalog source ${body.repo}`);
      const machine = await this.store.getMachine(machineId);
      if (!(machine?.repos ?? []).some((r) => r.id === src.repo)) throw new HubError(403, `this machine does not report ${body.repo} in its repo inventory`);
      const seen = new Set<string>();
      const defs: { path: string; name: string; hash: string; text: string; front: AgentFront }[] = [];
      let total = 0;
      for (const d of body.defs) {
        const rest = d.path.startsWith(`${src.folder}/`) ? d.path.slice(src.folder.length + 1) : undefined;
        const name = rest !== undefined && !rest.includes("/") && rest.endsWith(".md") ? rest.slice(0, -3) : undefined;
        if (name === undefined || !AGENT_NAME_RE.test(name)) throw new HubError(422, `catalog push: ${d.path} is not ${src.folder}/<name>.md`);
        if (seen.has(d.path)) throw new HubError(422, `catalog push: ${d.path} appears twice`);
        seen.add(d.path);
        total += d.text.length;
        defs.push({ path: d.path, name, hash: agentFileHash(d.text), text: d.text, front: agentFront(d.text) });
      }
      if (total > 8_000_000) throw new HubError(422, `catalog push: texts total ${total} characters, over 8000000`);
      const { added } = await this.store.putCatalogDefs(src.repo, body.commit, defs, actor.userId, now);
      const source: CatalogSourceView = {
        ...src,
        commit: body.commit,
        digest: catalogDigest(defs),
        count: defs.length,
        pushedAt: now,
        pushedBy: actor.userId,
      };
      await this.store.saveCatalogSource(source);
      await this.emit({ type: "catalog.pushed", user: actor.userId, payload: { repo: src.repo, commit: body.commit, added, count: defs.length } });
      return { source, added };
    });
  }

  /** Resolve a roster key to one catalog definition (never throws). */
  private async resolveRoster(key: string): Promise<{ ok: true; def: CatalogDefView } | { ok: false; status: number; error: string }> {
    const k = parseRosterKey(key);
    if (!k) return { ok: false, status: 400, error: ROSTER_KEY_RULE };
    const sources = await this.store.listCatalogSources();
    let src = sources.find((s) => s.repo === k.source);
    if (!src) {
      const matches = sources.filter((s) => repoMatches({ id: s.repo, name: s.name }, k.source));
      if (matches.length === 0) return { ok: false, status: 404, error: `no catalog source matches ${k.source}` };
      if (matches.length > 1) return { ok: false, status: 409, error: `${k.source} matches ${matches.length} catalog sources: ${matches.map((s) => s.repo).join(", ")}` };
      src = matches[0]!;
    }
    if (k.ref === undefined) {
      const def = (await this.store.listCatalogDefs({ repo: src.repo, name: k.name, current: true }))[0];
      if (!def) return { ok: false, status: 404, error: `no agent ${k.name} in catalog source ${src.repo}` };
      return { ok: true, def };
    }
    const ref = k.ref;
    const ckey = canonicalKey(src.repo, k.name);
    const found = (await this.store.listCatalogDefs({ repo: src.repo, name: k.name })).filter((d) => d.hash.startsWith(ref) || d.commits.some((c) => c.startsWith(ref)));
    if (found.length === 0) return { ok: false, status: 404, error: `no definition of ${ckey} matches @${ref}` };
    const hashes = new Set(found.map((d) => d.hash));
    if (hashes.size > 1) return { ok: false, status: 409, error: `@${ref} matches ${hashes.size} definitions of ${ckey}; give more characters` };
    const def = found[0]!;
    const commit = [...def.commits].reverse().find((c) => c.startsWith(ref)) ?? def.commits.at(-1) ?? def.commit;
    return { ok: true, def: { ...def, commit } };
  }

  /** `GET /v1/agents/resolve`. */
  async resolveAgent(key: string | undefined): Promise<CatalogDefView> {
    if (key === undefined || key === "") throw new HubError(400, ROSTER_KEY_RULE);
    return await this.store.tx(async () => {
      const r = await this.resolveRoster(key);
      if (!r.ok) throw new HubError(r.status, r.error);
      return r.def;
    });
  }

  /**
   * Pin the roster keys (`agent` with `/`) of steps to catalog definitions (R-6): entries of
   * `existing` are kept; each other key is resolved once. Problems name every step using a key that
   * does not resolve.
   */
  private async pinAgents(
    steps: readonly { id: string; agent?: string | undefined; policy?: { agent?: string | undefined } | undefined }[],
    existing: Record<string, AgentDef> = {},
  ): Promise<{ agents: Record<string, AgentDef>; problems: string[] }> {
    const agents: Record<string, AgentDef> = { ...existing };
    const problems: string[] = [];
    const users = new Map<string, string[]>();
    for (const s of steps) {
      const a = s.agent ?? s.policy?.agent;
      if (a === undefined || !a.includes("/")) continue;
      users.set(a, [...(users.get(a) ?? []), s.id]);
    }
    for (const [key, ids] of users) {
      if (agents[key]) continue;
      const r = await this.resolveRoster(key);
      if (r.ok) agents[key] = { key: r.def.key, source: r.def.source, name: r.def.name, hash: r.def.hash, commit: r.def.commit };
      else for (const id of ids) problems.push(`step "${id}": ${r.error}`);
    }
    return { agents, problems };
  }

  /** `GET /v1/agents`: the roster as the caller sees it. */
  async agentsView(viewer: Actor, name?: string): Promise<AgentsView> {
    return await this.store.tx(async () => {
      const machines = new Map((await this.store.listMachines()).map((m) => [m.id, m]));
      const sources = await this.store.listCatalogSources();
      const sourceName = new Map(sources.map((s) => [s.repo, s.name]));
      const current = await this.store.listCatalogDefs({ current: true, ...(name !== undefined ? { name } : {}) });
      const currentOf = new Map(current.map((d) => [`${d.source}\n${d.name}`, d]));
      type Entry = { copy: AgentCopy; front: AgentFront; name: string; machines: Set<string> };
      const merged = new Map<string, Entry>();
      for (const row of await this.store.listRepoAgents(name !== undefined ? { name } : {})) {
        const m = machines.get(row.machine);
        if (!HubService.agentCopyVisible(viewer, m)) continue;
        const mk = `${row.repo}\n${row.path}\n${row.hash}\n${JSON.stringify(row.pin ?? null)}`;
        const e = merged.get(mk);
        if (e) {
          e.machines.add(row.machine);
          e.copy.machines = e.machines.size;
          e.copy.seenAt = Math.max(e.copy.seenAt, row.at);
          continue;
        }
        const repoName = m?.repos?.find((r) => r.id === row.repo)?.name ?? row.repo.slice(row.repo.lastIndexOf("/") + 1);
        const pin = row.pin;
        const cur = pin ? currentOf.get(`${pin.source}\n${row.name}`) : undefined;
        const { description, model, tools, rules } = row;
        merged.set(mk, {
          name: row.name,
          machines: new Set([row.machine]),
          front: { ...(description !== undefined ? { description } : {}), ...(model !== undefined ? { model } : {}), ...(tools !== undefined ? { tools } : {}), ...(rules !== undefined ? { rules } : {}) },
          copy: {
            key: canonicalKey(row.repo, row.name),
            repo: { id: row.repo, name: repoName },
            origin: "repo",
            kind: row.kind,
            path: row.path,
            hash: row.hash,
            machines: 1,
            ...(pin ? { pin } : {}),
            pinned: pin !== undefined,
            behind: pin !== undefined && cur !== undefined && cur.hash !== pin.hash,
            modified: pin !== undefined && row.hash !== pin.hash,
            seenAt: row.at,
          },
        });
      }
      const entries: Entry[] = [...merged.values()];
      for (const d of current) {
        const { description, model, tools, rules } = d;
        entries.push({
          name: d.name,
          machines: new Set(),
          front: { ...(description !== undefined ? { description } : {}), ...(model !== undefined ? { model } : {}), ...(tools !== undefined ? { tools } : {}), ...(rules !== undefined ? { rules } : {}) },
          copy: {
            key: d.key,
            repo: { id: d.source, name: sourceName.get(d.source) ?? d.source.slice(d.source.lastIndexOf("/") + 1) },
            origin: "catalog",
            kind: "claude",
            path: d.path,
            hash: d.hash,
            commit: d.commit,
            pinned: false,
            behind: false,
            modified: false,
            seenAt: d.pushedAt,
          },
        });
      }
      const copyOrder = (a: Entry, b: Entry): number =>
        (a.copy.origin === b.copy.origin ? 0 : a.copy.origin === "catalog" ? -1 : 1) || cmp(a.copy.key, b.copy.key) || cmp(a.copy.kind, b.copy.kind) || cmp(a.copy.repo.id, b.copy.repo.id) || cmp(a.copy.path, b.copy.path);
      const byName = new Map<string, Entry[]>();
      for (const e of entries) byName.set(e.name, [...(byName.get(e.name) ?? []), e]);
      const groups: AgentGroup[] = [];
      for (const [agentName, list] of byName) {
        const byHash = new Map<string, Entry[]>();
        for (const e of list.sort(copyOrder)) byHash.set(e.copy.hash, [...(byHash.get(e.copy.hash) ?? []), e]);
        const versions: AgentVersion[] = [...byHash.entries()]
          .map(([hash, es]) => ({ ...es[0]!.front, hash, copies: es.map((e) => e.copy) }))
          .sort((a, b) => b.copies.length - a.copies.length || cmp(a.hash, b.hash));
        const copies = versions.flatMap((v) => v.copies);
        groups.push({
          name: agentName,
          versions,
          diverged: versions.length > 1,
          pinned: copies.some((c) => c.pinned),
          behind: copies.some((c) => c.behind),
          modified: copies.some((c) => c.modified),
        });
      }
      groups.sort((a, b) => cmp(a.name, b.name));
      return { agents: groups, sources };
    });
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
  /** RL-1: when artifact content was last pruned (undefined: not since start). */
  private lastArtifactPrune: number | undefined;

  /** RL-1: drop the content of artifacts of done/dropped goals older than `retentionDays`. */
  private async pruneArtifactContent(now: number): Promise<number> {
    const days = this.config.artifacts.retentionDays;
    if (days <= 0) return 0;
    const goals = (await this.store.listGoals()).filter((g) => g.state === "done" || g.state === "dropped").map((g) => g.id);
    return await this.store.pruneArtifacts(goals, now - days * 86_400_000, now);
  }

  async tick(): Promise<void> {
    const now = this.now();
    if (this.lastArtifactPrune === undefined || now - this.lastArtifactPrune >= 6 * 3_600_000) {
      this.lastArtifactPrune = now;
      await this.pruneArtifactContent(now);
    }
    if (now - this.lastPrune > 6 * 3_600_000) {
      this.lastPrune = now;
      const n = await this.pruneEvents();
      if (n) await this.emit({ type: "hub.events_pruned", payload: { count: n, days: this.config.eventsRetentionDays } });
    }
    await this.goalTx(async () => {
      for (const s of await this.store.listSteps({ state: "claimed" })) {
        const hs = s.holderSid ? await this.store.getSession(s.holderSid) : undefined;
        const machine = s.holderMachine ? await this.store.getMachine(s.holderMachine) : undefined;
        // RL-1: a headless step's run session ends when the run does; the daemon closes the step.
        const ended =
          s.policy?.mode !== "headless" && hs?.session.state === "ended" && hs.session.endedReason !== "clear" && now - (hs.session.endedAt ?? 0) > this.config.thresholds.pauseGraceMs;
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
    // RL-3: end or retry pending pulse slots first, then fire due pulses.
    await this.advancePending(now);
    await this.fireDue(now);
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
    case "agents.reported": {
      const host = hostnames?.get(String(payload.machine)) ?? String(payload.machine);
      return `${host} reported ${String(payload.count)} agent(s)`;
    }
    case "catalog.saved":
      return `registered catalog source ${String(payload.repo)}`;
    case "catalog.pushed":
      return `${String(payload.repo)} pushed at ${String(payload.commit).slice(0, 7)}: ${String(payload.added)} new, ${String(payload.count)} current`;
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
      if (payload.reason === "abandoned") return `${s} dropped: its goal was abandoned`;
      if (payload.reason === "missed") return `${s} dropped: its pulse slot was missed`;
      return `${s} dropped by a new plan`;
    case "goal.dropped":
      return `${s} dropped (${String(payload.reason)})`;
    case "pulse.created":
      return `created pulse ${String(payload.pulse)} "${String(payload.title ?? "")}"`;
    case "pulse.updated":
      return `updated pulse ${String(payload.pulse)} (v${String(payload.version)})`;
    case "pulse.paused":
      return `paused pulse ${String(payload.pulse)}: ${String(payload.reason)}`;
    case "pulse.resumed":
      return `resumed pulse ${String(payload.pulse)}`;
    case "pulse.deleted":
      return `removed pulse ${String(payload.pulse)}`;
    case "pulse.fired":
      return `pulse ${String(payload.pulse)} fired ${String(payload.slot)}${s ? ` → ${s}` : ""}`;
    case "pulse.skipped":
      return `pulse ${String(payload.pulse)} skipped ${String(payload.slot)} (${String(payload.running)} still running)`;
    case "pulse.missed":
      return `pulse ${String(payload.pulse)} missed ${String(payload.slot)} (${String(payload.reason)})`;
    case "pulse.abandoned":
      return `pulse ${String(payload.pulse)} abandoned ${s || String(payload.slot)}`;
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
    case "run.started":
      return `started a headless run of ${s}${payload.profile ? ` (profile ${String(payload.profile)})` : ""}`;
    case "run.finished":
      return `headless run of ${s} ended (${String(payload.exit ?? "reported")})`;
    case "step.artifact":
      return `stored a ${String(payload.kind)} for ${s} (round ${String(payload.round)})`;
    case "profile.saved":
      return `saved profile ${String(payload.name)}`;
    // RL-2: counts, states and fps only (never item titles, evidence, proposals or reasons).
    case "review.recorded":
      return `recorded a review record for ${s} (round ${String(payload.round)}, ${String(payload.items)} item(s))`;
    case "item.disposed":
      return `${String(payload.disposition)} item ${String(payload.fp)} of ${s}`;
    case "step.skipped":
      return `skipped ${s} (nothing to consume)`;
    // RL-4: ids only.
    case "item.reverted":
      return `reverted item ${String(payload.fp)} of ${s}`;
    case "step.read":
      return `read the pre-read of ${s}`;
    // RL-6: calibration (key, hash12 and counts only).
    case "calibration.opened":
      return `opened calibration of ${String(payload.key)}@${String(payload.hash ?? "").slice(0, 12)} (${String(payload.dismissals)} dismissals)`;
    case "calibration.done":
      return `calibration of ${String(payload.key)}@${String(payload.hash ?? "").slice(0, 12)} done: ${String(payload.outcome)}`;
    default:
      return `${type.replace(".", " ")} ${s}`.trim();
  }
}

/** The message of a thrown value. */
function errorText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** A topic name from a request: trimmed and lowercased, 400 when it isn't a valid name. */
function topicName(raw: string): string {
  const name = raw.trim().toLowerCase();
  const p = TopicName.safeParse(name);
  if (!p.success) throw new HubError(400, `bad topic "${raw}": ${p.error.issues[0]?.message ?? "invalid"}`);
  return name;
}
