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
  presetKind,
  presetKindProblem,
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
  pageItems,
  repoName,
  runOf,
  SEVERITY_RANK,
  skipSummary,
  uniqueFps,
  whenHolds,
  closesCycle,
  findingBrief,
  findingStepId,
  findingTitle,
  lineageRepo,
  isMovedAway,
  keyPathRepo,
  targetRepo,
  refillBySeverity,
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
  overlapBusy,
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
  openSpotChecks,
  recentSamples,
  SPOT_CHECK_PRESET,
  SPOT_MAX_SAMPLES,
  SPOT_WEEK_MS,
  spotCheckGoals,
  spotU,
  spotWhy,
  uncalibratedDisagreements,
  type AgentRef,
  type Counted,
  type Entry,
  refKey,
  type Materialized,
  type Principal,
  type Role,
  stageTimes,
  fitProfile,
  timeline as changeTimeline,
  type FitRun,
  type Sighting,
  slaState,
} from "../core/index.ts";
import type {
  AcState,
  AgentCompare,
  ProfileFit,
  AgentStats,
  ChangeEntry,
  ChangesPage,
  HashSide,
  GoalCalibration,
  GoalSpotCheck,
  SpotCheckRequest,
  SpotCheckResult,
  SpotSample,
  DismissalRef,
  Disposition,
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
  StepAssignRequest,
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
  Health,
  FindingsRollup,
  RollupRow,
  EfficiencyWindow,
  GoalEfficiency,
  StepWindowRow,
  Stuck,
  HealthTotal,
  PulseHealth,
  RunCard,
  RunCardsPage,
  RunItems,
  RunRow,
  RunsPage,
  StageCard,
  StepInput,
  StoredArtifact,
  ArtifactKind,
  ArtifactMediaType,
  Decider,
  ConsumedItem,
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
  PlanStep,
  ReviewEvidence,
  ReviewResult,
  SinkRequest,
  SinkResult,
  RetargetRequest,
  RetargetResult,
  ReviewUpload,
  StoredRecord,
  StoredReview,
  StoredReviewItem,
  FireResult,
  FleetPause,
  FleetPauseRequest,
  FleetResumeRequest,
  FleetState,
  GoalFromPreset,
  GoalState,
  Pulse,
  PresetCheck,
  PresetCheckResult,
  PulseCreate,
  PulseFire,
  PulseDetail,
  PulseSlot,
  PulseUpdate,
  PulseView,
  PulseWhen,
  PulseWhenInput,
  SlotReason,
} from "../protocol/index.ts";
import { PulseSlot as PulseSlotSchema, StateTimeReport, SLA_DECIDER, type Carry } from "../protocol/index.ts";
import { AGENT_NAME_RE, ALL_TOPIC, TargetRepo, CATALOG_REPO_MAX, HEADLESS_DEFAULTS, parseRosterKey, ROSTER_KEY_RULE, MAX_LABELS, TopicName, goalHasTopics, normalizeTopics, parseLabels } from "../protocol/index.ts";
import { FIGURE_EVENTS, goalCard, rollup, stepWindow, turnsSinceCommit } from "../core/efficiency.ts";
import { HubStore, type EventRow, type FleetPauseRow, type HubSession, type MachineRow, type NewEvent, type StoredProfile, type UserRow } from "../store/index.ts";
import { LocalHintBus, type HintBus } from "./bus.ts";
import type { HubConfig } from "./config.ts";

/** RL-11: the sort key of a `GET /v1/runs` row and its opaque cursor. Newest first; ties by goal, step, round. */
interface RunKey {
  at: number;
  goal: string;
  step: string;
  round: number;
}
const textCmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
const runCursor = {
  cmp: (a: RunKey, b: RunKey): number => b.at - a.at || textCmp(a.goal, b.goal) || textCmp(a.step, b.step) || a.round - b.round,
  encode: (k: RunKey): string => Buffer.from(JSON.stringify([k.at, k.goal, k.step, k.round]), "utf8").toString("base64url"),
  decode(s: string): RunKey | undefined {
    try {
      const v: unknown = JSON.parse(Buffer.from(s, "base64url").toString("utf8"));
      if (!Array.isArray(v) || v.length !== 4) return undefined;
      const [at, goal, step, round] = v as unknown[];
      if (typeof at !== "number" || !Number.isFinite(at) || typeof goal !== "string" || typeof step !== "string" || typeof round !== "number" || !Number.isInteger(round)) return undefined;
      return { at, goal, step, round };
    } catch {
      return undefined;
    }
  },
};

/** RL-17: the position of a change entry (`firstSeen` descending, then kind, key, hash). */
interface ChangeKey {
  at: number;
  kind: string;
  key: string;
  hash: string;
}
const changeCursor = {
  encode: (k: ChangeKey): string => Buffer.from(JSON.stringify([k.at, k.kind, k.key, k.hash]), "utf8").toString("base64url"),
  decode(s: string): ChangeKey | undefined {
    try {
      const v: unknown = JSON.parse(Buffer.from(s, "base64url").toString("utf8"));
      if (!Array.isArray(v) || v.length !== 4) return undefined;
      const [at, kind, key, hash] = v as unknown[];
      if (typeof at !== "number" || !Number.isFinite(at) || typeof kind !== "string" || typeof key !== "string" || typeof hash !== "string") return undefined;
      return { at, kind, key, hash };
    } catch {
      return undefined;
    }
  },
};

/** RL-11/RL-17: a `since`/`until` query value: milliseconds or an ISO time (400 otherwise). */
function queryTime(name: string, v: string | undefined): number | undefined {
  if (v === undefined) return undefined;
  const bad = () => new HubError(400, `${name} must be milliseconds since the epoch or an ISO time`);
  if (/^\d{1,15}$/.test(v)) return Number(v);
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,3})?)?(Z|[+-]\d{2}:\d{2})$/.test(v)) throw bad();
  const t = Date.parse(v);
  if (Number.isNaN(t)) throw bad();
  return t;
}

export class HubError extends Error {
  status: number;
  details?: unknown;
  /** RL-21: a stable refusal code beside the message (`code` in the error body), where one is defined. */
  code?: string | undefined;
  constructor(status: number, message: string, details?: unknown, code?: string) {
    super(message);
    this.status = status;
    this.details = details;
    this.code = code;
  }
}

/** RL-21: a refusal with a stable code and no details. */
const refuse = (status: number, code: string, message: string) => new HubError(status, message, undefined, code);

export interface Actor extends Principal {
  machineId?: string | undefined;
  tokenHash: string;
  tokenKind: string;
  /** mesh-ai B-178: the service account acting for this person (`userId`), when one is. */
  via?: string | undefined;
}

/** The event payload field naming the service that acted for the person (mesh-ai B-178). */
const viaOf = (actor: Actor): { via?: string } => (actor.via ? { via: actor.via } : {});

/** RL-17: a pulse's roster pins as event payload (`agents`: `{key, hash}` sorted and distinct), or nothing. */
const pinsOf = (p: Pulse): { agents?: { key: string; hash: string }[] } => {
  const seen = new Map<string, { key: string; hash: string }>();
  for (const d of Object.values(p.agents ?? {})) seen.set(`${d.key}\n${d.hash}`, { key: d.key, hash: d.hash });
  const agents = [...seen.values()].sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : a.hash < b.hash ? -1 : a.hash > b.hash ? 1 : 0));
  return agents.length ? { agents } : {};
};

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
/** RL-15: the vias of a debrief's own decisions (a person's in the session, or the hub's after the SLA). */
const DEBRIEF_VIAS: ReadonlySet<string> = new Set(["debrief-session", "auto-accept"]);

function byItemOrder(a: ItemRow, b: ItemRow): number {
  return SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity] || a.first.at - b.first.at || (a.fp < b.fp ? -1 : a.fp > b.fp ? 1 : 0);
}

/** RL-9: the goal id in the step ids of a sink dry run that would open its clean-audit goal. */
const NEW_GOAL = "<new>";
/** RL-9: the states a sync or a refile leaves alone apart from a note. */
const HELD_OR_FAILED: ReadonlySet<string> = new Set(["claimed", "paused", "parked", "failed"]);
/** RL-10: open finding steps (a move takes them). */
const OPEN_STATES: ReadonlySet<string> = new Set(["ready", "blocked"]);
/** RL-10: closed finding steps. */
const CLOSED_STATES: ReadonlySet<string> = new Set(["done", "skipped", "dropped"]);
/** RL-10: a placeholder goal id of a work (a clean-audit goal still to be opened; private-use characters, no `.`); never stored. */
const PLACEHOLDER = /\uE000\d+\uE000/g;

/** RL-9: who decided, as notes and summaries name them: the person's user, or the agent key. */
function deciderText(d: Decider): string {
  return d.kind === "person" ? d.user : d.key;
}

const HOLDER_FIELDS = ["outcome", "summary", "holderUser", "holderSid", "holderMachine", "claimedAt", "pausedAt", "roundStartedAt", "parkedReason", "parkedAt"] as const;

/** RL-9: a done or dropped finding step reopened (rule 3): blocked until settled, a new fix cycle, rounds kept. */
function reopenedFinding(cur: Step, now: number): Step {
  const next: Step = { ...cur, state: "blocked", fixCycles: cur.fixCycles + 1, updatedAt: now };
  for (const k of HOLDER_FIELDS) delete next[k];
  // MM-3: a later holder's work is not reported to the offerer of an accepted offer.
  if (next.offer?.state === "accepted") delete next.offer;
  return next;
}

/** RL-10: a moved-away finding step revived: `movedTo` and holder fields cleared, no deps, same fix cycle, notes and rounds kept. */
function revivedFinding(cur: Step, repo: string, now: number): Step {
  const next: Step = { ...cur, state: "blocked", repo, deps: [], updatedAt: now };
  for (const k of HOLDER_FIELDS) delete next[k];
  delete next.movedTo;
  if (next.offer?.state === "accepted") delete next.offer;
  return next;
}

/** RL-9: an item a sink considers, with the fingerprints its fix cannot land before. */
interface SinkItem {
  row: ItemRow;
  requires: readonly string[];
  /** The item's latest `accepted` disposition (rule 3 reopens a closed step only after a newer one). */
  accepted?: { at: number; step: string } | undefined;
}

/** RL-10: one clean-audit goal of a work (read once per call), or one still to be opened. */
interface WorkGoal {
  repo: string;
  topic: string;
  /** The goal, when it exists (set by `writeWork` when it opens one). */
  goal: Goal | undefined;
  /** The goal id in the step ids: the goal's, or a placeholder (`PLACEHOLDER`). */
  gid: string;
  /** The goal's owner, or the owner a new goal gets. */
  owner: string;
  existing: Step[];
  all: Map<string, Step>;
  changed: Set<string>;
  /** Steps created or moved here (`goal.sunk` and `SinkResult`). */
  added: string[];
  /** Steps reopened or revived by a sink. */
  reopened: string[];
  /** Its place in `Work.goals` (insertion order). */
  ord: number;
}

/** RL-10: the live finding steps of one lineage by fingerprint, over the clean-audit goals that are not dropped (built once per call). */
type FindingIndex = Map<string, { goal: Goal; step: Step }[]>;

/**
 * RL-10: the placing work of one call (sink, backfill, fold move, retarget, revert): decided in
 * memory over several clean-audit goals, then written once by `writeWork`. Every text naming a step
 * id may hold a placeholder, rendered at write time.
 */
interface Work {
  now: number;
  from: string;
  fromStep?: string | undefined;
  /** Who ends offers (the caller), else each goal's owner. */
  user?: string | undefined;
  goals: Map<string, WorkGoal>;
  byKey: Map<string, string>;
  /** The work's goals that hold a finding step of `(lineage, fp)` at its home id (moved-away ones included), by `lineage\u0000fp`. */
  byFinding: Map<string, Set<WorkGoal>>;
  loaded: Set<string>;
  allGoals?: Goal[] | undefined;
  seq: number;
  notes: { gid: string; step: string; user: string; text: string }[];
  dropped: { gid: string; step: string; user: string; to: string }[];
  reopens: { gid: string; step: string; user: string; reason: "refiled" | "moved" | "reverted" }[];
  touched: { gid: string; id: string; lineage: string; requires: readonly string[]; deps: "replace" | "add"; user: string }[];
  noted: Set<string>;
  skipped: number;
  /** Item notes and skipped moves (`RetargetResult.notes`). */
  resultNotes: string[];
  cache: Map<string, StoredReview[]>;
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

  private async machineOr404(actor: Actor, ref: string, coded = false): Promise<MachineRow> {
    const m = await this.findMachine(actor, ref);
    if (!m) throw new HubError(404, `no machine ${ref}`, undefined, coded ? "machine-unknown" : undefined);
    return m;
  }

  /** A session reference on a machine, among the non-ended sessions the caller may see. */
  private async findSessionOn(actor: Actor, m: MachineRow, ref: string, coded = false): Promise<HubSession> {
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
    if (hits.length === 0) throw new HubError(404, `no session ${ref} on ${machineName(m)}`, undefined, coded ? "session-unknown" : undefined);
    if (hits.length > 1) throw new HubError(409, `"${ref}" matches several sessions on ${machineName(m)}`, undefined, coded ? "session-ambiguous" : undefined);
    return hits[0] as HubSession;
  }

  /**
   * `to` of an assign: `<machine>`, `<machine>/<session>`, `<user>/<nickname>` or `<user>/<nickname>/<session>`.
   * RL-21: with `owner` (a service acting for that person), the resolved machine must be the owner's,
   * checked before any session lookup, and the resolved session too; `coded` adds the refusal codes.
   */
  private async resolveTarget(actor: Actor, to: string, o: { owner?: string | undefined; coded?: boolean } = {}): Promise<{ machine: MachineRow; session?: HubSession | undefined }> {
    const coded = o.coded === true;
    const own = (m: MachineRow): MachineRow => {
      if (o.owner !== undefined && m.userId !== o.owner) throw refuse(403, "machine-not-yours", `machine not yours: ${to}`);
      return m;
    };
    const session = async (m: MachineRow, ref: string): Promise<HubSession> => {
      const hs = await this.findSessionOn(actor, m, ref, coded);
      if (o.owner !== undefined && hs.userId !== o.owner) throw refuse(403, "session-not-yours", `session not yours: ${to}`);
      return hs;
    };
    const parts = to.split("/");
    if (parts.length === 1) return { machine: own(await this.machineOr404(actor, to, coded)) };
    if (parts.length === 2) {
      const [a, b] = parts as [string, string];
      const m = a ? await this.findMachine(actor, a) : undefined;
      if (m) return { machine: own(m), session: await session(own(m), b) };
      return { machine: own(await this.machineOr404(actor, to, coded)) };
    }
    if (parts.length === 3) {
      const [a, b, c] = parts as [string, string, string];
      const m = own(await this.machineOr404(actor, `${a}/${b}`, coded));
      return { machine: m, session: await session(m, c) };
    }
    throw new HubError(404, `no machine ${to}`, undefined, coded ? "machine-unknown" : undefined);
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
  private async machineMessage(machine: string, fromUser: string, kind: string, text: string, data: Record<string, unknown>): Promise<number> {
    const m = await this.store.addMessage({ toMachine: machine, toSid: "", fromUser, kind, text, data }, this.now());
    this.store.afterCommit(() => this.bus.publish({ type: "wake", machine }));
    return m.id;
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
    return (await this.offerStepMessage(step, target, by, opts)).step;
  }

  /** `offerStep`, also giving the id of the offer message (RL-21). */
  private async offerStepMessage(
    step: Step,
    target: { machine: MachineRow; session?: HubSession | undefined },
    by: { userId: string; sid?: string | undefined; machine?: MachineRow | undefined; via?: string | undefined },
    opts: { note?: string | undefined; stick: boolean; goal: Goal; snapshot?: ProfileSnapshot | undefined; deadline?: number | undefined; headless?: boolean | undefined },
  ): Promise<{ step: Step; message: number }> {
    const now = this.now();
    const auto = this.autoFor(target, by);
    const sid = target.session?.session.sid;
    // RL-1: a headless offer carries the profile snapshot, budget, deadline and agent. RL-21: also
    // a step run headless by the assign (`headless`).
    const snap = step.policy?.mode === "headless" || opts.headless === true ? opts.snapshot : undefined;
    const via = by.via;
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
      ...(snap ? { profile: { name: snap.name, sha256: snap.sha256 }, mode: "headless" as const } : {}),
      ...(via ? { via } : {}),
    };
    const next: Step = { ...step, offer, updatedAt: now };
    await this.saveStepFrom(next, step);
    const message = await this.machineMessage(
      target.machine.id,
      by.userId,
      "offer",
      `MESH: @${by.userId} offers step ${step.id} "${step.title}" (repo ${step.repo}) to this machine${opts.note ? `: ${opts.note}` : ""}${via ? ` (via ${via})` : ""}`,
      { step: step.id, goal: step.goal, repo: step.repo, topics: opts.goal.topics ?? [], auto, by: by.userId, ...(via ? { via } : {}), ...(sid ? { sid } : {}), ...(opts.note ? { note: opts.note } : {}), ...headless },
    );
    await this.emit({
      type: "step.offered",
      user: by.userId,
      sid: by.sid,
      goal: step.goal,
      step: step.id,
      payload: {
        machine: target.machine.id,
        ...(sid ? { sid } : {}),
        auto,
        ...(opts.note ? { note: opts.note } : {}),
        ...(opts.stick ? { stick: true } : {}),
        ...(via ? { via } : {}),
        ...(snap ? { mode: "headless", profile: snap.name } : {}),
      },
    });
    return { step: next, message };
  }

  /** A message to the offering session (none when it is absent, unknown or ended). */
  private async reportBack(step: Step, offer: StepOffer, kind: string, text: string): Promise<void> {
    await this.message(offer.bySid, offer.by, kind, text, { step: step.id, goal: step.goal });
  }

  /** Emit `step.ready`; a goal with a stick then offers the step to the stick's target. */
  private async emitReady(goalId: string, stepId: string): Promise<void> {
    await this.emit({ type: "step.ready", goal: goalId, step: stepId });
    const goal = await this.store.getGoal(goalId);
    if (!goal?.stick) return;
    const s = await this.store.getStep(stepId);
    if (s) await this.stickOffer(goal, s);
  }

  /** Offer a ready step to its goal's stick target. RL-24: a headless one is held while the fleet is paused. */
  private async stickOffer(goal: Goal, s: Step): Promise<void> {
    const stick = goal.stick;
    if (!stick || s.state !== "ready" || s.kind === "gate" || s.offer?.state === "offered") return;
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
    if (s.policy?.mode === "headless" && (await this.holdForPause([s.id]))) return;
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

  /** RL-21: a step for the assign and suggest routes, or a coded 404. */
  private async stepOrRefuse(id: string): Promise<Step> {
    const s = await this.store.getStep(id);
    if (!s) throw refuse(404, "step-unknown", `no step ${id}`);
    return s;
  }

  async assignStep(actor: Actor, id: string, req: StepAssignRequest): Promise<AssignResult> {
    return await this.goalTx(async () => {
      const step = await this.stepOrRefuse(id);
      if (step.kind === "gate") throw refuse(409, "step-gate", `${step.id} is a gate: a person decides it`);
      if (step.state !== "ready") throw refuse(409, "step-not-ready", `${step.id} is ${step.state}, not ready`);
      if (isDebrief(step.policy)) throw refuse(409, "step-debrief", `${step.id} is a debrief step: only ${await this.assigneeOf(step)} runs it (mesh debrief ${step.id})`);
      if (step.offer?.state === "offered") throw refuse(409, "step-offered", `${step.id} is already offered to ${await this.targetText(step.offer.to)}; withdraw it first (mesh withdraw ${step.id})`);
      // RL-21: a service acting for a person names no session of its own and sets no stick.
      if (actor.via) {
        if (req.sid !== undefined) throw refuse(400, "on-behalf-of-option", "sid is not accepted when a service acts for a person");
        if (req.stick) throw refuse(400, "on-behalf-of-option", "stick is not accepted when a service acts for a person");
      }
      const target = await this.resolveTarget(actor, req.to, { owner: actor.via ? actor.userId : undefined, coded: true });
      const goal = await this.goalOr404(step.goal);
      const run = await this.headlessRun(actor, step, target, req);
      const guard = await this.headlessGuard(step, target.machine, goal, run);
      if (!guard.ok) throw refuse(409, guard.code, guard.error);
      // RL-24: no headless offer while the fleet is paused.
      const paused = step.policy?.mode === "headless" || run !== undefined ? await this.store.getFleetPause() : undefined;
      if (paused) throw HubService.fleetPaused(paused);
      const caller = await this.callerMachine(actor, req.sid);
      this.refuseForeign(caller, req.sid);
      const by = { userId: actor.userId, sid: req.sid, machine: caller.machine, via: actor.via };
      const { step: next, message } = await this.offerStepMessage(step, target, by, { note: req.note, stick: false, goal, snapshot: guard.snapshot, headless: run !== undefined });
      if (req.stick) await this.setStick(goal, next.offer as StepOffer);
      return { step: next, auto: (next.offer as StepOffer).auto, message };
    });
  }

  /**
   * RL-21: the headless run an assign asks for (`mode`, `profile`), or undefined when it asks for
   * none. Only on the caller's own machine, never into a session or with a stick; a service acting for
   * a person names a built-in or a profile registered by that person.
   */
  private async headlessRun(actor: Actor, step: Step, target: { machine: MachineRow; session?: HubSession | undefined }, req: StepAssignRequest): Promise<{ profile: string } | undefined> {
    if (req.mode === undefined && req.profile === undefined) return undefined;
    const declared = step.policy?.mode === "headless";
    if (target.machine.userId !== actor.userId) throw refuse(403, "machine-not-yours", `machine not yours: ${req.to}`);
    if (target.session) throw refuse(400, "headless-session-target", `a headless run is never bound to a session; name the machine only (${machineName(target.machine)})`);
    if (req.stick) throw refuse(400, "headless-stick", "stick cannot carry a headless mode or profile");
    if (!declared && req.profile === undefined) throw refuse(400, "profile-required", `${step.id} is not headless: name the profile to run it with`);
    if (!declared && req.mode === undefined) throw refuse(400, "profile-needs-headless", `${step.id} is not headless: a profile needs mode headless`);
    const name = req.profile ?? step.policy?.profile ?? HEADLESS_DEFAULTS.profile;
    if (declared && step.policy?.profile !== undefined && name !== step.policy.profile) throw refuse(409, "profile-mismatch", `${step.id} runs with profile ${step.policy.profile}, not ${name}`);
    if (actor.via && req.profile !== undefined && !(declared && step.policy?.profile !== undefined) && !(await this.store.getGoal(step.goal))?.profiles && !builtinProfile(req.profile)) {
      const p = await this.store.getProfile(req.profile);
      if (p && p.createdBy !== actor.userId) throw refuse(403, "profile-not-yours", `profile ${req.profile} is not ${actor.userId}'s; name a built-in or one of theirs`);
    }
    return declared && req.profile === undefined ? undefined : { profile: name };
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
      // RL-1: headless steps the target cannot run are skipped (not offered, not counted). RL-24:
      // while the fleet is paused a headless step it can run is left out (held when sticking).
      const paused = await this.store.getFleetPause();
      const ready: { step: Step; snapshot?: ProfileSnapshot | undefined }[] = [];
      const leftOut: string[] = [];
      for (const s of await this.offerableSteps(goal.id)) {
        const guard = await this.headlessGuard(s, target.machine, goal);
        if (!guard.ok) continue;
        if (paused && s.policy?.mode === "headless") leftOut.push(s.id);
        else ready.push({ step: s, snapshot: guard.snapshot });
      }
      if (ready.length === 0 && !req.stick) {
        if (paused && leftOut.length) throw HubService.fleetPaused(paused);
        throw new HubError(409, `${goal.id} has no ready step to offer`);
      }
      if (req.stick && leftOut.length) await this.holdForPause(leftOut);
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
  private async headlessGuard(
    step: Step,
    machine: MachineRow,
    goal?: Goal,
    /** RL-21: the assign's headless run (its profile name), also for a step that does not declare headless. */
    run?: { profile: string },
  ): Promise<{ ok: true; snapshot?: ProfileSnapshot | undefined } | { ok: false; error: string; code: string }> {
    if (step.policy?.mode !== "headless" && !run) return { ok: true };
    if (machine.headless !== true) return { ok: false, code: "headless-unsupported", error: `${machineName(machine)} cannot run headless steps (it needs mesh 0.1.15 with workspaceRoots set)` };
    const name = run?.profile ?? step.policy?.profile ?? HEADLESS_DEFAULTS.profile;
    if (goal?.profiles) {
      const snap = goal.profiles[name];
      return snap ? { ok: true, snapshot: snap } : { ok: false, code: "headless-profile-not-pinned", error: `${step.id}: profile ${name} is not in the goal's snapshot` };
    }
    const snapshot = await this.resolveProfile(name);
    if (!snapshot) return { ok: false, code: "headless-profile-unknown", error: `${step.id}: unknown profile ${name}` };
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

  /** RL-16 `GET /v1/profiles/:name/fit`: denied commands and unused tools of a profile's runs, read only. */
  async profileFit(name: string, q: { days?: string | undefined; trial?: string | undefined }): Promise<ProfileFit> {
    let days = 14;
    if (q.days !== undefined) {
      days = /^\d{1,2}$/.test(q.days) ? Number(q.days) : NaN;
      if (!Number.isInteger(days) || days < 1 || days > 90) throw new HubError(400, "days must be a whole number from 1 to 90");
    }
    const trial = q.trial ?? "exclude";
    if (trial !== "exclude" && trial !== "include") throw new HubError(400, "trial must be exclude or include");
    return this.store.tx(async () => {
      const view = await this.getProfileView(name);
      const until = this.now();
      const since = until - days * 86_400_000;
      const goals = new Map<string, Goal | undefined>();
      const runs: FitRun[] = [];
      // A step's updatedAt is at least the finishedAt of each of its rounds (as GET /v1/runs).
      for (const step of await this.store.listSteps({ updatedSince: since })) {
        for (const round of step.rounds ?? []) {
          const t = round.telemetry;
          if (!t || t.profile !== name || round.finishedAt < since || round.finishedAt > until) continue;
          if (!goals.has(step.goal)) goals.set(step.goal, await this.store.getGoal(step.goal));
          const goal = goals.get(step.goal);
          if (!goal || (trial === "exclude" && goal.trial === true)) continue;
          runs.push({ finishedAt: round.finishedAt, telemetry: t });
        }
      }
      return fitProfile({
        profile: { name: view.name, builtIn: view.builtIn, base: view.base, sha256: view.sha256, settings: view.settings, text: view.text },
        runs,
        window: { since, until, days },
        trial,
      });
    });
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
      await this.emit({ type: "profile.saved", user: actor.userId, payload: { name: p.name, sha256: p.sha256, ...viaOf(actor) } });
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
    b: { state: "started" | "finished"; runId: string; round?: number | undefined; telemetry?: RunTelemetry | undefined; branch?: string | undefined; commit?: string | undefined },
  ): Promise<Step> {
    // RL-13: a commit belongs to a round, set by the report of a finished run.
    if (b.commit !== undefined && (b.state !== "finished" || b.round === undefined)) throw new HubError(400, "commit needs a finished report with a round");
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
        if (b.telemetry || b.branch || b.commit) {
          const now = this.now();
          const round: Round = {
            ...r,
            ...(b.telemetry ? { telemetry: b.telemetry } : {}),
            ...(b.branch ? { branch: b.branch } : {}),
            ...(b.commit ? { commit: b.commit } : {}),
            // RL-11: the machine that ran it.
            ...(b.telemetry && actor.machineId ? { machine: actor.machineId } : {}),
          };
          out = { ...step, rounds: (step.rounds ?? []).map((x) => (x.n === b.round ? round : x)), ...(b.branch ? { branch: b.branch } : {}), updatedAt: now };
          await this.saveStepFrom(out, step);
        }
      }
      await this.emit({
        type: "run.finished",
        user: actor.userId,
        goal: step.goal,
        step: step.id,
        payload: { runId: b.runId, ...(b.round !== undefined ? { round: b.round } : {}), ...(b.branch ? { branch: b.branch } : {}), ...(b.commit ? { commit: b.commit } : {}), ...(b.telemetry ?? {}) },
      });
      return out;
    });
  }

  /**
   * What a step's `inputs` serve (inside a transaction), in policy order: artifacts of the last round
   * of the named steps (`artifacts`: of each dependency), never of a blind partner or an unread
   * dependency; RL-2 `previous` (the fold base of a raising step's lineage) and `dispositions` (the
   * items the step may act on now, or a raising step's open items).
   *
   * An item list (`dispositions`, the debrief items) is never cut inside an item: it serves whole
   * items up to the size limits and says in `page` which ones; `itemsFrom` (mesh_context's
   * `items_from`) serves only the item lists, from that index on.
   */
  private async stepInputs(step: Step, goal: Goal, itemsFrom?: number): Promise<StepInput[]> {
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
    const paging = itemsFrom !== undefined;
    const push = (input: Omit<StepInput, "content" | "truncated">, text: string): boolean => {
      if (served >= MAX_ALL) return false;
      const content = text.slice(0, MAX_ONE);
      served += content.length;
      out.push({ ...input, content, truncated: text.length > MAX_ONE });
      return true;
    };
    // Served even when the other inputs used the room up: then with no items and a page that says
    // where the rest is.
    const pushItems = (input: Omit<StepInput, "content" | "truncated" | "page">, head: Record<string, unknown>, items: readonly unknown[]): void => {
      const room = Math.max(0, Math.min(MAX_ONE, MAX_ALL - served));
      const { content, page } = pageItems(head, items, itemsFrom ?? 0, room, room === MAX_ONE);
      served += content.length;
      out.push({ ...input, content, truncated: false, ...(page ? { page } : {}) });
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
      if (d.run && d.items.length) pushItems({ from: d.run.id, artifact: "debrief", kind: "review", title: `debrief items (${d.items.length})` }, { lineage: d.lineage }, d.items);
      if (!paging && d.run && d.report?.content) push({ from: d.run.id, artifact: d.report.artifact.id, kind: "report", title: d.report.artifact.title ?? "report" }, d.report.content);
    }
    let full = false;
    for (const x of p?.inputs ?? []) {
      if (x === "dispositions") {
        const items = await this.dispositionsInput(step, goal, steps);
        if (items) pushItems({ from: items.from, artifact: "items", kind: "review", title: "items and dispositions" }, { lineage: items.lineage }, items.items);
        continue;
      }
      if (paging || full || served >= MAX_ALL) continue;
      if (x === "artifacts") {
        full = !(await fromSteps(step.deps));
      } else if (x === "previous") {
        if (!isRaising(p)) continue;
        const base = await this.foldBase(lineageOf(goal, step), step.id, (step.rounds?.length ?? 0) + 1);
        if (base) push({ from: base.step, artifact: base.artifact, kind: "review", title: `previous review record (${base.goal} round ${base.round})` }, JSON.stringify(base.record));
      } else if (x === "calibration") {
        // RL-6: the dismissals a calibration goal lists.
        const input = await this.calibrationInput(goal);
        if (input) push({ from: goal.id, artifact: "calibration", kind: "review", title: input.title }, input.content);
      } else if (x === "spot-check") {
        // RL-18: the samples of a spot-check goal.
        const input = await this.spotCheckInput(goal);
        if (input) push({ from: goal.id, artifact: "spot-check", kind: "review", title: input.title }, input.content);
      } else if (!INPUT_KEYWORDS.has(x)) {
        full = !(await fromSteps([`${step.goal}.${x}`]));
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

  /**
   * The `dispositions` input of a step, or undefined when there are no items for it. A consuming
   * step's items carry the evidence and proposal of its run's latest record (`ConsumedItem`).
   */
  private async dispositionsInput(step: Step, goal: Goal, steps: readonly Step[]): Promise<{ from: string; lineage: string; items: (ItemView | ConsumedItem)[] } | undefined> {
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
    if (!rows.length) return undefined;
    const items: ConsumedItem[] = (await this.withHistory(record.lineage, rows)).map((v) => {
      const first = record.record.items.find((i) => i.fp === v.fp);
      return { ...v, evidence: first?.evidence ?? [], ...(first?.proposal !== undefined ? { proposal: first.proposal } : {}) };
    });
    return { from: run.id, lineage: record.lineage, items };
  }

  /** `holds` for `settle`: does each `when` step's run's record have an item it consumes? */
  private async holdsFor(steps: readonly Step[]): Promise<(s: Step) => boolean> {
    const map = new Map<string, boolean>();
    for (const s of steps) {
      const when = s.policy?.when;
      if (!when) continue;
      if (isDebrief(s.policy)) {
        // RL-15: a debrief looks at its debrief set (its run's record and what was carried into it).
        const goal = await this.store.getGoal(s.goal);
        const set = goal ? await this.debriefSet(s, goal, steps) : undefined;
        const rows = set?.lineage ? await this.rowsOf(set.lineage, set.fps) : [];
        map.set(s.id, set?.record || rows.length ? whenHolds(when, s.policy?.consumes ?? [], rows.map((r) => ({ state: r.state, severity: r.severity, link: r.link }))) : false);
        continue;
      }
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

  /**
   * A goal is done when every step is done, skipped or dropped and one is not the design step. RL-9:
   * a clean-audit goal is never completed by its steps.
   */
  private static goalComplete(goal: Pick<Goal, "sink">, steps: readonly Step[]): boolean {
    if (goal.sink) return false;
    return steps.length > 0 && steps.every((s) => s.state === "done" || s.state === "skipped" || s.state === "dropped") && steps.some((s) => s.kind !== "design");
  }

  private async deciderOf(step: Step, actor: Actor, agent: ReviewUpload["agent"]): Promise<Decider> {
    if (await this.runHeld(step)) return { kind: "agent", key: agent?.key ?? `${repoName(step.repo)}/${local(step)}`, ...(agent?.hash ? { hash: agent.hash } : {}) };
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
      const decider = await this.deciderOf(step, actor, b.agent);
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
      // RL-18: agent dispositions applied because they agree with a person (RL-6 rule 2) are never sampled.
      const agreeing = new Set<string>();
      if (raising && fields.dispositions.length) problems.push(`dispositions need consumes; ${step.id} raises items`);
      if (!raising && fields.items.length) problems.push(`${step.id} consumes items; its record may not raise new ones`);
      // RL-10: one fingerprint listed for two repos (absent: the lineage repo) cannot be placed.
      if (raising) {
        for (const fp of fps) {
          const repos = [...new Set(items.filter((i) => i.fp === fp).map((i) => i.repo ?? lineageRepo(lineage)))];
          if (repos.length > 1) problems.push(`item ${fp} is listed for more than one repo (${repos.join(", ")}); put the repo in its key`);
        }
      }
      if (!raising) {
        const consumes: readonly ItemState[] = p.consumes ?? [];
        const runFps = debrief ? (await this.debriefSet(step, goal, steps)).fps : new Set(runRecord ? uniqueFps(runRecord.record.items) : []);
        const given = new Set<string>();
        for (const d of fields.dispositions) {
          const fp = d.fingerprint;
          let problem: string | undefined;
          // RL-9: requires names the fixes an accepted one cannot land before.
          if (d.requires && d.disposition !== "accepted") problem = "requires is only for accepted";
          else if (!p.may_set?.includes(d.disposition)) problem = `${step.id} may not set ${d.disposition} (may_set: ${p.may_set?.join(", ") ?? "none"})`;
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
              if (person.disposition === d.disposition && row && consumes.includes(row.state)) {
                toApply.push(d);
                agreeing.add(fp);
              } else ignored.push({ fingerprint: fp, reason: `decided by ${person.decider.user} in this goal` });
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
        const retargeted: { row: ItemRow; from: string; to: string }[] = [];
        for (const fp of fps) {
          const it = first.get(fp) as StoredReviewItem;
          const row = rows.get(fp);
          const state = f.states.get(fp) ?? "open";
          // RL-10: an item with repo sets the row's; without, the row keeps its own (a retarget survives).
          const next: ItemRow = row
            ? { ...row, state, title: it.title, severity: it.severity, category: it.category, last: seenAt, ...(it.repo !== undefined ? { repo: it.repo } : {}) }
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
                ...(it.repo !== undefined ? { repo: it.repo } : {}),
              };
          if (row && targetRepo(row) !== targetRepo(next)) retargeted.push({ row: next, from: targetRepo(row), to: targetRepo(next) });
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
        // RL-10: an item whose target repo changed moves its open finding steps (before the resolved sync).
        if (retargeted.length) await this.foldMove(goal, step, lineage, retargeted, actor.userId, now);
        fold = f.fold;
        resolved = f.resolved;
        // RL-9: resolved findings close their steps; findings raised again note their done steps.
        const again = [...f.marks].filter(([, m]) => m === "repeat" || m === "regression").map(([fp]) => fp);
        await this.syncFold(lineage, step.id, f.resolved, again, now);
      }

      // Dispositions of a consuming record (only when the whole record has no problem).
      const applied: { fp: string; disposition: string; from: ItemState }[] = [];
      const via: DispositionVia = debrief ? "debrief-session" : "stage";
      // RL-10: one index of the lineage's live finding steps for the whole batch.
      const ix = toApply.length ? await this.findingIndex(lineage) : undefined;
      for (const d of toApply) {
        const row = await this.store.getItem(lineage, d.fingerprint);
        if (!row) continue;
        await this.applyDisposition(lineage, row, d, decider, via, seenAt, undefined, ix);
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
      // RL-18: sample the record's eligible agent decisions for a person's spot check.
      if (decider.kind === "agent" && decider.hash && goal.trial !== true && this.config.spotChecks) {
        const eligible = applied.filter((a) => !agreeing.has(a.fp)).map((a) => ({ fp: a.fp, disposition: a.disposition as Disposition }));
        if (eligible.length) await this.spotCheckSample({ key: decider.key, hash: decider.hash }, lineage, goal.id, step.id, n, now, eligible);
      }
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
    d: Pick<RecordDisposition, "fingerprint" | "disposition" | "reason" | "until" | "link" | "requires">,
    decider: Decider,
    via: DispositionVia,
    seenAt: { goal: string; step: string; round: number; at: number },
    answer?: string,
    ix?: FindingIndex,
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
      ...(d.requires?.length ? { requires: d.requires } : {}),
    });
    // RL-9: a dismissal or deferral drops the item's ready finding steps (held ones get a note).
    await this.syncDisposition(lineage, d.fingerprint, d, decider, seenAt.at, ix);
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
      ...(d.requires?.length ? { requires: d.requires } : {}),
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
    // RL-15: the debrief set: the run's record and the items carried from superseded goals.
    const set = await this.debriefSet(step, goal, steps);
    if (!record && !set.fps.size) return { ...out, items: [] };
    const consumes: readonly ItemState[] = step.policy?.consumes ?? DEBRIEF_CONSUMES;
    const rows = (await this.rowsOf(lineage, set.fps)).filter((r) => consumes.includes(r.state)).sort(byItemOrder);
    if (!rows.length) return { ...out, items: [] };
    const all = await this.store.listItems(lineage);
    const items: DebriefItem[] = [];
    for (const v of await this.withHistory(lineage, rows)) {
      const first = record?.record.items.find((i) => i.fp === v.fp) ?? (await this.lastRecordItem(lineage, v));
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

  /**
   * RL-15: the debrief set of a debrief step: the fps of its run's latest record (none without one)
   * and of its goal slot's `carry` entries for its local id and its run's lineage.
   */
  private async debriefSet(step: Step, goal: Goal, steps: readonly Step[]): Promise<{ lineage?: string; record?: StoredReview; fps: Set<string> }> {
    const { run, record } = await this.runRecordOf(step, steps);
    if (!run) return { fps: new Set() };
    const lineage = record?.lineage ?? lineageOf(goal, run);
    const fps = new Set(record ? uniqueFps(record.record.items) : []);
    const pulse = goal.refs?.pulse;
    const slotId = goal.refs?.slot;
    if (pulse !== undefined && slotId !== undefined) {
      const slot = await this.store.getSlot(pulse, slotId);
      for (const c of slot?.carry ?? []) if (c.step === local(step) && c.lineage === lineage) for (const fp of c.fps) fps.add(fp);
    }
    return { lineage, ...(record ? { record } : {}), fps };
  }

  /** The item rows of `fps` in a lineage (missing ones left out). */
  private async rowsOf(lineage: string, fps: Iterable<string>): Promise<ItemRow[]> {
    const rows: ItemRow[] = [];
    for (const fp of fps) {
      const row = await this.store.getItem(lineage, fp);
      if (row) rows.push(row);
    }
    return rows;
  }

  /** RL-15: the first item with a row's fp in the review record its `last` names (a carried item's evidence). */
  private async lastRecordItem(lineage: string, row: ItemRow): Promise<StoredReviewItem | undefined> {
    const rec = await this.store.getReview(row.last.step, row.last.round);
    return rec?.lineage === lineage ? rec.record.items.find((i) => i.fp === row.fp) : undefined;
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
    return (await this.store.listDispositions({ lineage, fp, step: stepId })).filter((d) => DEBRIEF_VIAS.has(d.via) && d.round === n).at(-1);
  }

  /**
   * A debrief disposition is revertable while it is the latest history entry of its item. Only the
   * last disposition row of an item is ever a candidate, so two equal rows are never both revertable.
   */
  private async isRevertable(d: DispositionRow, laterRows: readonly DispositionRow[] = []): Promise<boolean> {
    if (!DEBRIEF_VIAS.has(d.via)) return false;
    if (laterRows.some((o) => o.lineage === d.lineage && o.fp === d.fp)) return false;
    const last = (await this.store.itemHistory(d.lineage, d.fp)).at(-1);
    return (
      last?.kind === "disposition" &&
      last.via === d.via &&
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
      const decided = await this.decidedViews((await this.store.listDispositions({ step: step.id })).filter((x) => DEBRIEF_VIAS.has(x.via)));
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
      if (b.requires && b.disposition !== "accepted") throw new HubError(422, "requires is only for accepted");
      const n = (step.rounds?.length ?? 0) + 1;
      if (await this.store.getReview(step.id, n)) throw new HubError(409, `${step.id} round ${n} already has a review record`);
      const goal = await this.goalOr404(step.goal);
      const steps = await this.store.listSteps({ goal: goal.id });
      const { run, record } = await this.runRecordOf(step, steps);
      const lineage = record?.lineage ?? lineageOf(goal, run ?? step);
      const consumes: readonly ItemState[] = p?.consumes ?? DEBRIEF_CONSUMES;
      const fp = b.fingerprint;
      const runFps = (await this.debriefSet(step, goal, steps)).fps;
      let problem: string | undefined;
      let row: ItemRow | undefined;
      if (!p?.may_set?.includes(b.disposition)) problem = `${step.id} may not set ${b.disposition} (may_set: ${p?.may_set?.join(", ") ?? "none"})`;
      else if (b.disposition === "deferred" && !b.until) problem = "deferred needs until (YYYY-MM-DD)";
      else if (!runFps.has(fp)) problem = `no item ${fp} in the record of ${run?.id ?? step.id}`;
      else {
        row = await this.store.getItem(lineage, fp);
        // A change of mind: the item's latest disposition is this step's in this round.
        const latest = (await this.store.listDispositions({ lineage, fp })).at(-1);
        const own = latest !== undefined && latest.step === step.id && latest.round === n && DEBRIEF_VIAS.has(latest.via);
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
      const d = (await this.store.listDispositions({ step: step.id, fp })).filter((x) => DEBRIEF_VIAS.has(x.via)).at(-1);
      if (!d) throw new HubError(404, `${step.id} has no debrief disposition of ${fp}`);
      const goal = await this.goalOr404(step.goal);
      // RL-15: the debrief's assignee may revert too (an auto-accept has no person decider).
      const names = [...new Set([...(d.decider.kind === "person" ? [d.decider.user] : []), await this.assigneeOf(step, goal)])];
      if (!names.includes(actor.userId) && actor.userId !== goal.ownerId && !actor.roles.includes("admin")) throw new HubError(403, `only ${names.join(", ")}, the goal owner or an admin can revert this`);
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
      // RL-9: the item's finding steps follow the revert.
      await this.syncRevert(d, next, step.id, actor.userId, now);
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
    // RL-21: for a service acting for a person, only that person's own sessions.
    const sessions = (await this.store.listSessions({ live: true })).filter((hs) => !actor.via || hs.userId === actor.userId);
    const suggestions = suggest({ caller: actor.userId, callerMachine, now: this.now(), onlineMs: ONLINE_MS, repos, topics, any: q.any, machines: all, callerNicknames, sessions });
    return { target, steps, repos, topics, team: q.team, any: q.any, suggestions };
  }

  /** `GET /v1/steps/:id/suggest`: read-only, no event. */
  async suggestStep(actor: Actor, id: string, q: { team: boolean; any: boolean }): Promise<SuggestView> {
    // RL-21: a service acting for a person ranks that person's machines only.
    if (actor.via && q.team) throw refuse(400, "on-behalf-of-option", "team is not accepted when a service acts for a person");
    return this.store.tx(async () => {
      const step = await this.stepOrRefuse(id);
      if (step.kind === "gate") throw refuse(409, "step-gate", `${step.id} is a gate: a person decides it`);
      if (step.state !== "ready") throw refuse(409, "step-not-ready", `${step.id} is ${step.state}, not ready`);
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
      if (sid !== undefined) HubService.refuseHeadlessAccept(step);
      // RL-24: after today's checks, so a wrong machine or a session keeps its refusal.
      const paused = offer.mode === "headless" || step.policy?.mode === "headless" ? await this.store.getFleetPause() : undefined;
      if (paused) throw HubService.fleetPaused(paused);
      const claimed = await this.claimInTx(actor, step, sid, caller.machine.id);
      return await this.markAccepted(actor, claimed, sid);
    });
  }

  /** RL-21: a headless offer is never accepted into a session (the machine's daemon runs it). */
  private static refuseHeadlessAccept(step: Step): void {
    if (step.offer?.mode === "headless" || step.policy?.mode === "headless") {
      throw refuse(409, "offer-headless", `${step.id} is offered to run headless; the machine's daemon starts it, or withdraw it first (mesh withdraw ${step.id})`);
    }
  }

  /**
   * RL-21: is the step held by a headless run? Declared headless, or held through an accepted
   * headless offer by a run's own session (`kind: "print"`).
   */
  private async runHeld(step: Step, holder?: HubSession | undefined): Promise<boolean> {
    if (step.policy?.mode === "headless") return true;
    if (step.offer?.state !== "accepted" || step.offer.mode !== "headless" || !step.holderSid) return false;
    const hs = holder ?? (await this.store.getSession(step.holderSid));
    return hs?.session.sid === step.holderSid && hs.session.kind === "print";
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
          ...(o.via ? { via: o.via } : {}),
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
   * mesh-ai B-178: who a request runs as. A service token (the `service` role without `member`)
   * may name a person in `x-mesh-on-behalf-of` on the routes that allow it (`allowed`); the request
   * then runs as that person with the member role only, and `via` names the service. A service's
   * write on such a route needs the header. Anyone else sending it is refused. RL-24: `keep` names the
   * person's roles the route keeps besides member; only `POST /v1/fleet/pause` and
   * `POST /v1/fleet/resume` keep `admin` (owner decision MESH-OQ-AIOPS-12).
   */
  async actingFor(caller: Actor, header: string | undefined, route: { allowed: boolean; write: boolean; keep?: readonly Role[] | undefined }): Promise<Actor> {
    const service = caller.roles.includes("service") && !caller.roles.includes("member");
    if (header === undefined) {
      if (service && route.allowed && route.write) throw refuse(400, "on-behalf-of-required", "on-behalf-of required: a service writes for a person (x-mesh-on-behalf-of)");
      return caller;
    }
    if (!service) throw refuse(403, "on-behalf-of-not-service", "on-behalf-of is for service tokens only");
    if (!route.allowed) throw refuse(400, "on-behalf-of-not-accepted", "on-behalf-of is not accepted on this route");
    const id = header.trim();
    const user = id ? await this.store.getUser(id) : undefined;
    if (!user || user.roles.includes("service")) throw refuse(403, "user-unknown", `unknown user ${JSON.stringify(id)}`);
    const kept = (user.roles as Role[]).filter((r) => r !== "member" && route.keep?.includes(r) === true);
    return { userId: user.id, roles: ["member", ...kept], tokenHash: caller.tokenHash, tokenKind: caller.tokenKind, via: caller.userId };
  }

  /**
   * mesh-ai B-178 (H3): a pulse made or changed for a person runs only on machines that person owns,
   * so `target.machines` must name at least one, each the person's own (by id, `user/nickname` or
   * bare nickname); labels may narrow it further.
   */
  private async checkTargetForPerson(actor: Actor, target: { machines?: readonly string[] | undefined }): Promise<void> {
    if (!actor.via) return;
    const names = target.machines ?? [];
    if (names.length === 0) throw new HubError(400, "target.machines required: a pulse made for a person names the person's own machines");
    const mine = await this.store.listMachines({ userId: actor.userId });
    for (const n of names) {
      const own = mine.some((m) => n === m.id || (m.nickname !== undefined && (n === m.nickname || n === `${actor.userId}/${m.nickname}`)));
      if (!own) throw new HubError(403, `machine not yours: ${n}`);
    }
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

  async proposePlan(actor: Actor, goalId: string, input: PlanInput & { approve: boolean; preset?: { name: string; text: string } | undefined }): Promise<{ plan: Plan; detail?: GoalDetail; warnings?: string[] }> {
    const result = await this.goalTx(async () => {
      const goal = await this.goalOr404(goalId);
      // RL-9: before any other check.
      if (goal.sink) throw new HubError(409, `${goal.id} is a clean-audit goal; its steps come from audits`);
      if (goal.state === "done" || goal.state === "dropped") throw new HubError(409, `${goal.id} is ${goal.state}`);
      const errors = [...validatePlan(input.steps), ...validatePolicies(input.steps, input.acs)];
      for (const s of input.steps) if (s.profile !== undefined && !(await this.resolveProfile(s.profile))) errors.push(`step "${s.id}": unknown profile "${s.profile}"`);
      // RL-5: roster keys must resolve to a catalog definition.
      errors.push(...(await this.pinAgents(input.steps, goal.agents ?? {})).problems);
      if (errors.length) throw new HubError(422, `the plan has ${errors.length} problem(s): ${errors.join("; ")}`, errors);
      // RL-9: sink topics must be defined topics (stored as topic names).
      await this.checkSinkTopics(input.steps);
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
      // A plan made from a template (`mesh goal plan --preset`): the goal records it, so its review
      // lineages carry the preset name like a pulse's goals (RL-3), not "-".
      const preset = input.preset && (goal.preset?.name !== input.preset.name || goal.preset.text !== input.preset.text) ? { preset: input.preset } : {};
      if (goal.state !== "in_progress" || "preset" in preset) await this.store.saveGoal({ ...goal, ...preset, ...(goal.state !== "in_progress" ? { state: "awaiting_approval" as const } : {}), updatedAt: now });
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
    const fresh = await this.store.getGoal(goal.id);
    const complete = HubService.goalComplete(fresh ?? goal, finalSteps);
    await this.store.saveGoal({ ...(fresh ?? goal), state: complete ? "done" : "in_progress", updatedAt: now });
    await this.emit({ type: "plan.approved", user: by.userId, goal: goal.id, payload: { version: plan.version } });
    await this.emitOffersEnded(by, [...first.ended, ...second.ended]);
    const finalState = new Map(finalSteps.map((s) => [s.id, s.state]));
    for (const s of [...m.upserts, ...ready].filter((x) => x.state === "ready" && finalState.get(x.id) === "ready")) await this.emitReady(goal.id, s.id);
    await this.emitSkipped(goal.id, settled.skipped);
    // RL-9: a sink stage skipped here still sinks.
    await this.sinkAfter(fresh ?? goal, finalSteps, settled.skipped, now);
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
      // RL-9: within each part and each goal, finding steps are refilled by severity.
      steps = [...refillBySeverity(steps.filter(here)), ...refillBySeverity(steps.filter((s) => !here(s)))];
    } else if (filter.ready) steps = refillBySeverity(steps);
    return steps;
  }

  /** A step's context. `forAgent`: what the agent holding it may see (blind and reads rules, M4.5). */
  async context(stepId: string, forAgent = false, itemsFrom?: number): Promise<StepContext> {
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
      const inputs = await this.stepInputs(step, goal, itemsFrom);
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
        HubService.refuseHeadlessAccept(step);
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
      commit?: string | undefined;
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
      closeAsFail?: true | undefined;
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
      // RL-18: a spot check is done only when every sample has a verdict.
      if (goal.spotCheck && step.id === `${goal.id}.check` && outcome === "done" && input.closeAsFail !== true) {
        const k = goal.spotCheck.samples.filter((x) => !x.verdict).length;
        if (k > 0) throw new HubError(409, `${step.id} has ${k} sample(s) without a verdict; record each with mesh_spot_check, then mesh_done`);
      }
      // RL-1: the daemon's close-as-fail (a run that ended without mesh_done) fails the step even
      // with a record in the round: the run never said it was done.
      const closing = input.closeAsFail === true;
      if (closing) outcome = "fail";
      else if (rec) outcome = "done";
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
        ...(input.commit ? { commit: input.commit } : {}),
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
      const decision = rec && !closing ? ({ action: "done" } as const) : judgeDone(step, round, explicit, plan?.acs);

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
        payload: { summary: input.summary, mr: input.mr, reopen: toReopen, round: round.n, ...(input.commit ? { commit: input.commit } : {}), ...(input.model ? { model: input.model } : {}), ...(input.verdict ? { verdict: input.verdict } : {}), ...(input.failures?.length ? { buckets: input.failures.map((f) => f.bucket) } : {}) },
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
      // RL-9: a sink stage done or skipped now adds the items filed in this goal to its clean-audit goal.
      await this.sinkAfter(goal, steps, [r.step.id, ...settled.skipped], now);
      const goalDone = HubService.goalComplete(goal, steps);
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
      await this.sinkAfter(goal, steps, settled.skipped, now);
      const goalDone = HubService.goalComplete(goal, steps);
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
      await this.sinkAfter(goal, after, settled.skipped, now);
      if (HubService.goalComplete(goal, after) && goal.state !== "done") {
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
      const notHeld: { sid: string; step: string }[] = [];
      for (const s of req.sessions) {
        const existing = await this.store.getSession(s.sid);
        if (existing && existing.userId !== actor.userId) continue; // never overwrite another user's session
        // RL-14: state time stays on the machine; the hub keeps it per (step, sid) only.
        const { stateTime: _local, ...rest } = s;
        await this.store.upsertSession(rest, actor.userId, machine, now);
        if (s.step !== undefined) {
          const st = await this.store.getStep(s.step);
          if (!st || !heldBy(st, s.sid, actor.userId, machine)) notHeld.push({ sid: s.sid, step: s.step });
        }
      }
      // RL-14: absolute state time per (step, sid); a bad entry is skipped, never failing the sync.
      for (const raw of req.stateTime ?? []) {
        const p = StateTimeReport.safeParse(raw);
        if (!p.success) continue;
        const r = p.data;
        const st = await this.store.getStep(r.step);
        if (!st) continue;
        const owner = await this.store.getSession(r.sid);
        if (owner && owner.userId !== actor.userId) continue;
        await this.store.putStepTime({ step: st.id, sid: r.sid, goal: st.goal, userId: actor.userId, machineId: machine, asOf: r.asOf, days: r.days });
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
      // RL-14: present when the body has a step-holding session (an empty list unmarks them all).
      // RL-24: the fleet pause, so the daemon starts no queued headless run while it lasts.
      const paused = HubService.pauseOf(await this.store.getFleetPause());
      return { accepted, ...(share ? { share } : {}), ...(req.sessions.some((s) => s.step !== undefined) ? { notHeld } : {}), paused };
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
      // RL-15: overdue debriefs, for the assignee once breached and for the owner once escalated.
      for (const o of await this.overdueDebriefs(goals, this.now())) {
        if (!(o.sla.breached && o.assignee === viewer.userId) && !(o.sla.escalated && o.owner === viewer.userId)) continue;
        out.push({
          kind: "debrief_overdue",
          text: `Debrief ${o.step.id} "${o.step.title}" is overdue: waiting since ${new Date(o.sla.since).toISOString()}, SLA ${o.step.policy?.sla ?? ""}`,
          goal: o.goal.id,
          step: o.step.id,
          at: o.sla.dueAt,
        });
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
        owner: m.userId,
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
  private async presetChecks(preset: { name: string; text: string; sha256: string }, params: Record<string, string>, o: { kind?: boolean } = {}): Promise<PlanInput> {
    const { plan, problems } = await this.presetProblems(preset, params, o);
    if (problems.length || !plan) throw new HubError(422, `the preset has ${problems.length} problem(s): ${problems.join("; ")}`, problems);
    // RL-9: sink topics must be defined topics.
    await this.checkSinkTopics(plan.steps);
    return plan;
  }

  /**
   * RL-20: the problems of `presetChecks` before its sink-topic check (400 when the sha256 does not
   * match), with the plan when the preset instantiated (also when it has problems).
   */
  private async presetProblems(preset: { name: string; text: string; sha256: string }, params: Record<string, string>, o: { kind?: boolean } = {}): Promise<{ plan?: PlanInput | undefined; problems: string[] }> {
    if (createHash("sha256").update(preset.text, "utf8").digest("hex") !== preset.sha256) throw new HubError(400, "preset.sha256 is not the SHA-256 of preset.text");
    const problems: string[] = [];
    const repo = params.repo;
    if (!repo) problems.push("params.repo is required (the repo the preset's steps work in)");
    // RL-19: a preset sent in the request must have a valid kind (a stored one is not re-checked).
    if (o.kind) {
      const problem = presetKindProblem(preset.text);
      if (problem) problems.push(problem);
    }
    let plan: PlanInput;
    try {
      const parsed = parsePreset(preset.name, preset.text);
      try {
        // Without a repo the rest is still checked, against a stand-in name.
        plan = instantiate(parsed, { repo: repo || "repo", goal: "this goal", params });
      } catch (e) {
        problems.push(errorText(e));
        return { problems };
      }
    } catch (e) {
      if (e instanceof HubError) throw e;
      problems.push(`preset ${preset.name}: ${errorText(e)}`);
      return { problems };
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
    return { plan, problems };
  }

  /**
   * RL-20 `POST /v1/presets/check`: the preset checks of pulse create, writing nothing. `problems`
   * are create's 422 `details`, then one per distinct sink-topic 400 (create stops at the first).
   */
  async checkPreset(actor: Actor, body: PresetCheck): Promise<PresetCheckResult> {
    return await this.store.tx(async () => {
      const { plan, problems } = await this.presetProblems(body.preset, body.params, { kind: true });
      if (plan) {
        const steps = plan.steps.map((s) => ({ ...s }));
        for (const s of steps) {
          if (!s.sink) continue;
          try {
            s.sink = { topic: await this.sinkTopic(s.sink.topic) };
          } catch (e) {
            if (!(e instanceof HubError) || e.status !== 400) throw e;
            if (!problems.includes(e.message)) problems.push(e.message);
          }
        }
        plan.steps = steps;
      }
      const { agents } = plan ? await this.pinAgents(plan.steps) : { agents: {} };
      const warnings = await this.pulseWarnings(actor, { preset: body.preset, params: body.params, agents }, body.checkedAgents);
      if (problems.length || !plan) return { ok: false, problems, warnings };
      return { ok: true, problems: [], warnings, steps: plan.steps, agents };
    });
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
    // RL-8: the reply carries warnings for agents flagged invalid (computed after the write).
    const { view, pulse } = await this.goalTx(async () => {
      const now = this.now();
      await this.checkTargetForPerson(actor, body.target);
      const plan = await this.presetChecks(body.preset, body.params, { kind: true });
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
      await this.emit({ type: "pulse.created", user: actor.userId, payload: { pulse: p.id, title: p.title, preset: p.preset.name, sha256: p.preset.sha256, schedule: scheduleText(p.when), ...pinsOf(p), ...viaOf(actor) } });
      return { view: await this.pulseView(p), pulse: p };
    });
    return { ...view, warnings: await this.pulseWarnings(actor, pulse, body.checkedAgents) };
  }

  /**
   * RL-8: one warning per step of the pulse's instantiated plan whose agent the roster flags invalid:
   * a roster key by its pinned catalog definition, a repo agent by the copies the caller can see in
   * the step's repo, except the repo agents in `checked` (the caller checked those in the preset's
   * source checkout, which the roster's copies may not match). Never fails (a plan that cannot be
   * instantiated gives none).
   */
  private async pulseWarnings(actor: Actor, p: Pick<Pulse, "preset" | "params" | "agents">, checked: readonly string[] = []): Promise<string[]> {
    let plan: PlanInput;
    try {
      plan = instantiate(parsePreset(p.preset.name, p.preset.text), { repo: p.params.repo ?? "repo", goal: "this goal", params: p.params });
    } catch {
      return [];
    }
    const out: string[] = [];
    const views = new Map<string, AgentsView>();
    for (const s of plan.steps) {
      const a = s.agent;
      if (a === undefined || a === "") continue;
      if (a.includes("/")) {
        const pin = p.agents?.[a];
        if (!pin) continue;
        const def = (await this.store.listCatalogDefs({ repo: pin.source, name: pin.name })).find((d) => d.hash === pin.hash);
        if (def?.invalid !== undefined) out.push(`step "${s.id}": roster agent ${def.key} has invalid front matter: ${def.invalid}`);
        continue;
      }
      if (checked.includes(a)) continue;
      let view = views.get(a);
      if (!view) {
        view = await this.agentsView(actor, a);
        views.set(a, view);
      }
      const want = s.repo || p.params.repo;
      const group = view.agents.find((g) => g.name === a);
      for (const v of group?.versions ?? []) {
        if (v.invalid === undefined) continue;
        const c = v.copies.find((x) => x.origin === "repo" && x.kind === "claude" && want !== undefined && repoMatches({ id: x.repo.id, name: x.repo.name }, want));
        if (!c) continue;
        out.push(`step "${s.id}": agent ${a} in ${c.repo.name} has invalid front matter: ${v.invalid}`);
        break;
      }
    }
    return out;
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
      // RL-20: the plan of the stored snapshot (no state read); absent when it no longer instantiates.
      let steps: PlanStep[] | undefined;
      try {
        steps = instantiate(parsePreset(pulse.preset.name, pulse.preset.text), { repo: pulse.params.repo ?? "repo", goal: "this goal", params: pulse.params }).steps;
      } catch {
        steps = undefined;
      }
      return { pulse, schedule: scheduleText(pulse.when), slots, goals, ...(steps ? { steps } : {}) };
    });
  }

  /** `POST /v1/pulses/:id/update`: only the given fields; `preset`/`params` re-snapshot and bump `version`. */
  async updatePulse(actor: Actor, id: string, body: PulseUpdate): Promise<PulseView> {
    const { view, pulse } = await this.goalTx(async () => {
      const p = await this.pulseOr404(id);
      HubService.ownerOrAdmin(actor, p);
      const now = this.now();
      let next: Pulse = { ...p };
      if (body.preset !== undefined || body.params !== undefined) {
        const preset = body.preset ?? p.preset;
        const params = body.params ?? p.params;
        const plan = await this.presetChecks(preset, params, { kind: body.preset !== undefined });
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
      await this.checkTargetForPerson(actor, next.target);
      const t = HubService.timings(next.when, next.window, next.maxGoalAge, now);
      next = { ...next, windowMs: t.windowMs, maxGoalAgeMs: t.maxGoalAgeMs, updatedAt: now };
      await this.store.savePulse(next);
      await this.emit({ type: "pulse.updated", user: actor.userId, payload: {
          pulse: p.id,
          version: next.version,
          fields: Object.keys(body).filter((f) => f !== "checkedAgents").sort(),
          // RL-17: a re-snapshot names the preset hash and the pins it introduced.
          ...(body.preset !== undefined || body.params !== undefined ? { preset: next.preset.name, sha256: next.preset.sha256, ...pinsOf(next) } : {}),
          ...viaOf(actor),
        },
      });
      return { view: await this.pulseView(next), pulse: next };
    });
    // RL-8: warnings on every update, from the resulting preset, params and pins.
    return { ...view, warnings: await this.pulseWarnings(actor, pulse, body.checkedAgents) };
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
      await this.emit({ type: "pulse.paused", user: actor.userId, payload: { pulse: p.id, reason, ...viaOf(actor) } });
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
      await this.emit({ type: "pulse.resumed", user: actor.userId, payload: { pulse: p.id, ...viaOf(actor) } });
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
      await this.emit({ type: "pulse.deleted", user: actor.userId, payload: { pulse: p.id, ...viaOf(actor) } });
      return { pulse: p.id };
    });
  }

  /** `POST /v1/pulses/:id/fire`: a manual slot now (also while paused); `nextAt` is not changed. */
  async firePulse(actor: Actor, id: string, b: PulseFire = {}): Promise<FireResult> {
    const now = this.now();
    const slotId = manualSlot(now);
    const trial = b.trial === true;
    try {
      return {
        slot: await this.goalTx(async () => {
          const p = await this.pulseOr404(id);
          HubService.ownerOrAdmin(actor, p);
          const paused = await this.store.getFleetPause();
          if (paused) throw HubService.fleetPaused(paused);
          return await this.fireSlot(p, slotId, now, now, { manual: true, by: actor.userId, via: actor.via, trial });
        }),
      };
    } catch (e) {
      if (e instanceof HubError) throw e;
      const error = errorText(e).slice(0, 500);
      return {
        slot: await this.goalTx(async () => {
          const p = await this.pulseOr404(id);
          const slot: PulseSlot = { pulse: p.id, slot: slotId, at: now, state: "missed", reason: "error", manual: true, by: actor.userId, ...(trial ? { trial: true as const } : {}), error, tried: [], decidedAt: now };
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
      const plan = await this.presetChecks(b.preset, b.params, { kind: true });
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
      /** RL-18: set on spot-check goals only. */
      spotCheck?: GoalSpotCheck | undefined;
      /** RL-11: a trial fire's goal. */
      trial?: boolean | undefined;
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
      ...(o.spotCheck ? { spotCheck: o.spotCheck } : {}),
      ...(o.trial ? { trial: true as const } : {}),
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
    /** RL-11: counted dismissals of trial goals too (`counted` leaves them out). */
    countedAll: Counted[];
    trialGoals: Set<string>;
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
    const countedAll = countedDismissals(entries, raising);
    const goals = await this.store.listGoals();
    // RL-11: calibration never counts dismissals made in trial goals.
    const trialGoals = new Set(goals.filter((g) => g.trial === true).map((g) => g.id));
    const counted = countedAll.filter((c) => !trialGoals.has(c.ref.goal));
    return { steps, reviews, entries, raising, counted, status: calibrationStatus(goals), goals, countedAll, trialGoals };
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
    newest: { ref: DismissalRef } | undefined,
    scan: { steps: readonly Step[]; goals: readonly Goal[] },
  ): Promise<{ user: string; repo: string } | undefined> {
    if (!newest) return undefined;
    const found = await this.catalogDefOf(agent);
    const lineage = newest.ref.lineage;
    const repo = found ? found.source.repo : lineage.slice(lineage.indexOf("|") + 1, lineage.lastIndexOf("|"));
    const exists = async (u: string | undefined) => (u ? (await this.store.getUser(u)) !== undefined : false);
    // 1. The catalog source's calibrator.
    if (found?.source.calibrator && (await exists(found.source.calibrator))) return { user: found.source.calibrator, repo };
    // 2. The owner of the newest pulse goal that ran the agent key (any hash).
    const pulseGoals = new Map(scan.goals.filter((g) => g.refs?.pulse !== undefined && g.trial !== true).map((g) => [g.id, g] as const));
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
    // RL-18: a person's disagreement with the agent's decision counts like a dismissal.
    const dis = uncalibratedDisagreements(scan.goals, agent);
    const t = this.config.calibration.threshold;
    if (list.length + dis.length < t) return;
    const who = await this.calibratorFor(agent, list.at(-1) ?? dis.at(-1), scan);
    if (!who) return;
    const m = dis.length;
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
        comment: `calibration of ${agent.key}@${hash12} (${list.length} dismissals, ${m > 0 ? `${m} disagreements, ` : ""}threshold ${t})`,
        extra: {},
        calibration: { key: agent.key, hash: agent.hash, threshold: t, dismissals: list.map((c) => c.ref), ...(m > 0 ? { disagreements: dis.map((d) => d.ref) } : {}) },
      },
      now,
    );
    await this.emit({
      at: now,
      type: "calibration.opened",
      user: who.user,
      goal: goal.id,
      payload: { key: agent.key, hash: agent.hash, dismissals: list.length, ...(m > 0 ? { disagreements: m } : {}), threshold: t, calibrator: who.user },
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
      payload: { key: c.key, hash: c.hash, dismissals: c.dismissals.length, ...(c.disagreements?.length ? { disagreements: c.disagreements.length } : {}), outcome },
    });
    await this.calibrationTrigger({ key: c.key, hash: c.hash }, at ?? this.now());
  }

  /** RL-11 `GET /v1/runs`: headless runs that closed a round, newest first, with raw waste parts. */
  async listRuns(q: {
    since?: string | undefined;
    until?: string | undefined;
    goal?: string | undefined;
    pulse?: string | undefined;
    repo?: string | undefined;
    agent?: string | undefined;
    user?: string | undefined;
    trial?: string | undefined;
    limit?: string | undefined;
    cursor?: string | undefined;
  }): Promise<RunsPage> {
    const sinceGiven = queryTime("since", q.since);
    const until = queryTime("until", q.until);
    if (sinceGiven !== undefined && until !== undefined && sinceGiven >= until) throw new HubError(400, "since must be before until");
    const trial = q.trial ?? "exclude";
    if (trial !== "exclude" && trial !== "include" && trial !== "only") throw new HubError(400, "trial must be exclude, include or only");
    let limit = 200;
    if (q.limit !== undefined) {
      limit = /^\d{1,4}$/.test(q.limit) ? Number(q.limit) : NaN;
      if (!Number.isInteger(limit) || limit < 1 || limit > 1000) throw new HubError(400, "limit must be a whole number from 1 to 1000");
    }
    const after = q.cursor === undefined ? undefined : runCursor.decode(q.cursor);
    if (q.cursor !== undefined && after === undefined) throw new HubError(400, "cursor is not valid");
    const since = sinceGiven ?? this.now() - 30 * 86_400_000;
    return await this.store.tx(async () => {
      // A step's updatedAt is at least the finishedAt of each of its rounds.
      const steps = await this.store.listSteps({ updatedSince: since, ...(q.goal !== undefined ? { goal: q.goal } : {}) });
      const goals = new Map<string, Goal | undefined>();
      const goalOf = async (id: string) => {
        if (!goals.has(id)) goals.set(id, await this.store.getGoal(id));
        return goals.get(id);
      };
      const picked: { step: Step; goal: Goal; round: Round & { telemetry: RunTelemetry } }[] = [];
      for (const step of steps) {
        // The store drops an empty goal filter; an empty or unknown goal gives no rows.
        if (q.goal !== undefined && step.goal.toLowerCase() !== q.goal.toLowerCase()) continue;
        if (q.repo !== undefined && step.repo !== q.repo) continue;
        for (const round of step.rounds ?? []) {
          const t = round.telemetry;
          if (!t || round.finishedAt < since || (until !== undefined && round.finishedAt >= until)) continue;
          if (q.agent !== undefined && t.agentKey !== q.agent) continue;
          if (q.user !== undefined && round.user !== q.user) continue;
          const goal = await goalOf(step.goal);
          if (!goal) continue;
          if (q.pulse !== undefined && goal.refs?.pulse !== q.pulse) continue;
          const isTrial = goal.trial === true;
          if ((trial === "exclude" && isTrial) || (trial === "only" && !isTrial)) continue;
          picked.push({ step, goal, round: round as Round & { telemetry: RunTelemetry } });
        }
      }
      const keyOf = (x: (typeof picked)[number]) => ({ at: x.round.finishedAt, goal: x.goal.id, step: x.step.id, round: x.round.n });
      picked.sort((a, b) => runCursor.cmp(keyOf(a), keyOf(b)));
      const rest = after === undefined ? picked : picked.filter((x) => runCursor.cmp(keyOf(x), after) > 0);
      const page = rest.slice(0, limit);
      const runs: RunRow[] = [];
      for (const x of page) runs.push(await this.runRow(x.step, x.goal, x.round));
      const last = page.at(-1);
      return { runs, ...(rest.length > limit && last ? { next: runCursor.encode(keyOf(last)) } : {}) };
    });
  }

  /** One `RunRow` (inside a transaction): the round's step, goal, raising record and its items now. */
  private async runRow(step: Step, goal: Goal, round: Round & { telemetry: RunTelemetry }): Promise<RunRow> {
    const t = round.telemetry;
    const rec = (await this.store.listReviews({ step: step.id, raising: true })).find((r) => r.round === round.n);
    let items: RunItems | undefined;
    if (rec) {
      items = { raised: 0, open: 0, confirmed: 0, accepted: 0, dismissed: 0, deferred: 0, resolved: 0 };
      for (const fp of new Set(rec.record.items.map((i) => i.fp))) {
        items.raised++;
        const row = await this.store.getItem(rec.lineage, fp);
        if (row) items[row.state]++;
      }
    }
    return {
      runId: t.runId,
      goal: goal.id,
      step: step.id,
      round: round.n,
      kind: step.kind,
      repo: step.repo,
      ...(round.branch !== undefined ? { branch: round.branch } : {}),
      ...(round.commit !== undefined ? { commit: round.commit } : {}),
      user: round.user,
      owner: goal.ownerId,
      ...(round.machine !== undefined ? { machine: round.machine } : {}),
      ...(goal.refs?.pulse !== undefined ? { pulse: goal.refs.pulse } : {}),
      ...(goal.refs?.slot !== undefined ? { slot: goal.refs.slot } : {}),
      trial: goal.trial === true,
      ...(round.startedAt !== undefined ? { startedAt: round.startedAt } : {}),
      finishedAt: round.finishedAt,
      outcome: round.outcome,
      telemetry: t,
      ...(round.fold ? { fold: round.fold } : {}),
      ...(items ? { items } : {}),
      waste: {
        failed: round.outcome === "fail",
        overBudget: t.exit === "killed_budget",
        denials: t.permissionDenials.count,
        allDismissed: items !== undefined && items.raised > 0 && items.dismissed === items.raised,
      },
      artifacts: round.artifactIds ?? [],
    };
  }

  // ---------- RL-12: pulse run cards and the health scorecard ----------

  /** `GET /v1/pulses/:id/runs`: one card per slot, newest first. */
  async pulseRuns(id: string, q: { trial?: string | undefined; limit?: string | undefined; cursor?: string | undefined }): Promise<RunCardsPage> {
    const trial = q.trial ?? "exclude";
    if (trial !== "exclude" && trial !== "include" && trial !== "only") throw new HubError(400, "trial must be exclude, include or only");
    let limit = 20;
    if (q.limit !== undefined) {
      limit = /^\d{1,3}$/.test(q.limit) ? Number(q.limit) : NaN;
      if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new HubError(400, "limit must be a whole number from 1 to 100");
    }
    const after = q.cursor === undefined ? undefined : slotCursor.decode(q.cursor);
    if (q.cursor !== undefined && after === undefined) throw new HubError(400, "cursor is not valid");
    return this.store.tx(async () => {
      const p = await this.pulseOr404(id);
      const passes = (s: PulseSlot) => (trial === "exclude" ? s.trial !== true : trial === "only" ? s.trial === true : true);
      // Read in batches until the page is full (the trial filter may skip slots).
      const page: PulseSlot[] = [];
      let pos = after;
      let more = false;
      for (;;) {
        const batch = await this.store.listSlots({ pulse: p.id, limit: limit + 1, ...(pos ? { before: pos } : {}) });
        for (const s of batch) {
          if (!passes(s)) continue;
          if (page.length === limit) {
            more = true;
            break;
          }
          page.push(s);
        }
        const last = batch.at(-1);
        if (more || batch.length < limit + 1 || !last) break;
        pos = { at: last.at, slot: last.slot };
      }
      const ctx = new CardCtx();
      const cards: RunCard[] = [];
      for (const s of page) {
        const card = await this.runCard(s, ctx);
        if (card.goalState === "done") {
          const prev = await this.previousComplete(p.id, s, ctx);
          if (prev) card.delta = cardDelta(card, prev);
        }
        cards.push(card);
      }
      const last = page.at(-1);
      return { pulse: p.id, cards, ...(more && last ? { next: slotCursor.encode({ at: last.at, slot: last.slot }) } : {}) };
    });
  }

  /** The previous complete run of a slot: among the 50 slots after it, the first done goal of the same trial class. */
  private async previousComplete(pulse: string, s: PulseSlot, ctx: CardCtx): Promise<RunCard | undefined> {
    for (const o of await this.store.listSlots({ pulse, limit: 50, before: { at: s.at, slot: s.slot } })) {
      if ((o.trial === true) !== (s.trial === true) || o.goal === undefined) continue;
      const g = await ctx.goal(this.store, o.goal);
      if (g?.state !== "done") continue;
      return this.runCard(o, ctx);
    }
    return undefined;
  }

  /** One run card (inside a transaction). */
  private async runCard(s: PulseSlot, ctx: CardCtx): Promise<RunCard> {
    const cached = ctx.cards.get(`${s.pulse}\n${s.slot}`);
    if (cached) return { ...cached };
    const now = this.now();
    const goal = s.goal === undefined ? undefined : await ctx.goal(this.store, s.goal);
    const card: RunCard = {
      slot: s.slot,
      at: s.at,
      state: s.state,
      ...(s.reason !== undefined ? { reason: s.reason } : {}),
      ...(s.by !== undefined ? { by: s.by } : {}),
      ...(s.running !== undefined ? { running: s.running } : {}),
      ...(s.error !== undefined ? { error: s.error } : {}),
      ...(s.firedAt !== undefined ? { firedAt: s.firedAt } : {}),
      ...(s.until !== undefined ? { until: s.until } : {}),
      ...(s.startedAt !== undefined ? { startedAt: s.startedAt } : {}),
      decidedAt: s.decidedAt,
      ...(s.goal !== undefined ? { goal: s.goal } : {}),
      manual: s.manual === true,
      trial: s.trial === true,
      catchUp: s.catchUp === true,
      queued: s.queued === true,
      superseded: s.superseded ?? [],
      tries: s.tried.length,
      ...(s.startedAt !== undefined ? { startWaitMs: Math.max(0, s.startedAt - ((s.manual || s.catchUp || s.queued) && s.firedAt !== undefined ? s.firedAt : s.at)) } : {}),
      stages: [],
      totals: { runs: 0, durationMs: 0, turns: 0 },
      dispositions: { confirmed: 0, dismissed: 0, deferred: 0, accepted: 0, byPeople: 0, reverted: 0 },
      reports: [],
      sinks: [],
    };
    if (goal) {
      card.goalTitle = goal.title;
      card.goalState = goal.state;
      card.goalCreatedAt = goal.createdAt;
      const all = await this.store.listSteps({ goal: goal.id });
      const byId = new Map(all.map((x) => [x.id, x] as const));
      const plans = await this.store.listPlans(goal.id);
      let fold: Fold | undefined;
      for (const step of all) {
        if (isMovedAway(step)) continue;
        const stage = stageCard(step, byId, plans, now);
        card.stages.push(stage);
        card.totals.runs += stage.runs;
        card.totals.durationMs += stage.durationMs;
        card.totals.turns += stage.turns;
        if (stage.costUsd !== undefined) card.totals.costUsd = (card.totals.costUsd ?? 0) + stage.costUsd;
        const f = (step.rounds ?? []).filter((r) => r.fold).at(-1)?.fold;
        if (f) {
          fold ??= { new: 0, repeat: 0, regression: 0, resolved: 0, carried: 0 };
          for (const k of ["new", "repeat", "regression", "resolved", "carried"] as const) fold[k] += f[k];
        }
      }
      if (fold) card.fold = fold;
      // Raising records, their lineages and items.
      const pairs = new Map<string, { lineage: string; fp: string }>();
      const lineages = new Set<string>();
      for (const step of all) {
        for (const rec of await this.store.listReviews({ step: step.id, raising: true })) {
          lineages.add(rec.lineage);
          for (const it of rec.record.items) pairs.set(`${rec.lineage}\n${it.fp}`, { lineage: rec.lineage, fp: it.fp });
        }
      }
      if (lineages.size) {
        const items: RunItems = { raised: 0, open: 0, confirmed: 0, accepted: 0, dismissed: 0, deferred: 0, resolved: 0 };
        for (const { lineage, fp } of pairs.values()) {
          items.raised++;
          const row = (await ctx.items(this.store, lineage)).get(fp);
          if (row) items[row.state]++;
        }
        card.items = items;
      }
      for (const lineage of [...lineages].sort()) {
        for (const { entry: e } of await ctx.history(this.store, lineage)) {
          if (e.goal !== goal.id) continue;
          if (e.kind === "disposition") {
            card.dispositions[e.disposition]++;
            if (e.decider.kind === "person") card.dispositions.byPeople++;
          } else if (e.kind === "revert") card.dispositions.reverted++;
        }
      }
      card.reports = (await this.store.listArtifacts({ goal: goal.id })).filter((a) => a.kind === "report").map((a) => a.id);
      // Sinks: the live finding steps of the items filed in this goal.
      const sinks = new Map<string, { goal: string; repo: string; topic: string; steps: number }>();
      for (const lineage of [...lineages].sort()) {
        for (const filed of await this.filedItems(lineage, goal.id)) {
          for (const c of await ctx.cleanGoals(this.store)) {
            // The live finding step of the item in `c` (as findingStepsOf finds it).
            const step = await this.store.getStep(`${c.id}.${findingStepId(lineage, filed.row.fp)}`);
            if (!c.sink || step?.finding?.lineage !== lineage || step.finding.fp !== filed.row.fp || isMovedAway(step)) continue;
            const cur = sinks.get(c.id) ?? { goal: c.id, repo: c.sink.repo, topic: c.sink.topic, steps: 0 };
            cur.steps++;
            sinks.set(c.id, cur);
          }
        }
      }
      card.sinks = [...sinks.values()].sort((a, b) => goalSeq(a.goal) - goalSeq(b.goal) || cmp(a.goal, b.goal));
    }
    ctx.cards.set(`${s.pulse}\n${s.slot}`, card);
    return { ...card };
  }

  // ---------- RL-14: efficiency cards, windows and the stuck signal ----------

  /** `GET /v1/goals/:id/efficiency`: the efficiency card of a goal and its steps (all time). */
  async goalEfficiency(id: string): Promise<GoalEfficiency> {
    return this.store.tx(async () => {
      const goal = await this.goalOr404(id);
      const steps = await this.store.listSteps({ goal: goal.id });
      const rows = await this.store.listStepTimes({ goal: goal.id });
      const types = new Set<string>(FIGURE_EVENTS);
      const events = (await this.store.eventsFor({ goal: goal.id })).filter((e) => types.has(e.type));
      return goalCard(goal, steps, rows, events, this.now());
    });
  }

  /** `GET /v1/efficiency`: figures inside a window, per goal, per repo and in total. */
  async efficiencyWindow(q: { days?: string | undefined; since?: string | undefined; until?: string | undefined; repo?: string | undefined; trial?: string | undefined; steps?: string | undefined }): Promise<EfficiencyWindow> {
    const D = 86_400_000;
    if (q.days !== undefined && (q.since !== undefined || q.until !== undefined)) throw new HubError(400, "days cannot be combined with since or until");
    const time = (name: string, v: string | undefined): number | undefined => {
      if (v === undefined) return undefined;
      const bad = () => new HubError(400, `${name} must be milliseconds since the epoch or an ISO time`);
      if (/^\d{1,15}$/.test(v)) return Number(v);
      if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,3})?)?(Z|[+-]\d{2}:\d{2})$/.test(v)) throw bad();
      const t = Date.parse(v);
      if (Number.isNaN(t)) throw bad();
      return t;
    };
    let days: number | undefined;
    if (q.days !== undefined) {
      days = /^\d{1,2}$/.test(q.days) ? Number(q.days) : NaN;
      if (!Number.isInteger(days) || days < 1 || days > 90) throw new HubError(400, "days must be a whole number from 1 to 90");
    }
    const sinceGiven = time("since", q.since);
    const untilGiven = time("until", q.until);
    const trial = q.trial ?? "exclude";
    if (trial !== "exclude" && trial !== "include") throw new HubError(400, "trial must be exclude or include");
    const now = this.now();
    let since: number;
    let until: number;
    if (sinceGiven === undefined && untilGiven === undefined) {
      const midnight = Math.floor(now / D) * D;
      since = midnight - ((days ?? 7) - 1) * D;
      until = now + 1;
    } else {
      until = untilGiven ?? now + 1;
      since = sinceGiven ?? until - 7 * D;
      if (since >= until) throw new HubError(400, "since must be before until");
      if (until - since > 90 * D) throw new HubError(400, "the window is at most 90 days");
    }
    const withSteps = q.steps === "1";
    return this.store.tx(async () => {
      const lc = (x: string) => x.toLowerCase();
      // Candidates: steps with state time overlapping the window, events in it, or rounds finished in it.
      const ids = new Set<string>();
      for (const r of await this.store.listStepTimes({ since, until })) ids.add(lc(r.step));
      const events = await this.store.eventsBetween(since, until, FIGURE_EVENTS);
      for (const e of events) if (e.step) ids.add(lc(e.step));
      const byId = new Map<string, Step>();
      for (const s of await this.store.listSteps({ updatedSince: since })) {
        byId.set(lc(s.id), s);
        if ((s.rounds ?? []).some((r) => r.finishedAt >= since && r.finishedAt < until)) ids.add(lc(s.id));
      }
      const goals = new Map<string, Goal | undefined>();
      const goalOf = async (g: string) => {
        if (!goals.has(g)) goals.set(g, await this.store.getGoal(g));
        return goals.get(g);
      };
      const picked: Step[] = [];
      for (const id of ids) {
        const s = byId.get(id) ?? (await this.store.getStep(id));
        if (!s) continue;
        if (q.repo !== undefined && s.repo !== q.repo) continue;
        const g = await goalOf(s.goal);
        if (!g || (trial === "exclude" && g.trial === true)) continue;
        picked.push(s);
      }
      const rows = await this.store.listStepTimes({ steps: picked.map((s) => s.id) });
      const out: { goal: Goal; rows: StepWindowRow[]; order: Map<string, number> }[] = [];
      const perGoal = new Map<string, (typeof out)[number]>();
      for (const s of picked) {
        const row = stepWindow(
          s,
          rows.filter((r) => lc(r.step) === lc(s.id)),
          events.filter((e) => e.step !== undefined && lc(e.step) === lc(s.id)),
          since,
          until,
        );
        if (!row) continue;
        let g = perGoal.get(s.goal);
        if (!g) {
          const goal = (await goalOf(s.goal)) as Goal;
          const order = new Map((await this.store.listSteps({ goal: goal.id })).map((x, i) => [x.id, i] as const));
          g = { goal, rows: [], order };
          perGoal.set(s.goal, g);
          out.push(g);
        }
        g.rows.push(row);
      }
      out.sort((a, b) => goalSeq(b.goal.id) - goalSeq(a.goal.id));
      const all = out.flatMap((g) => g.rows);
      const repos = [...new Set(all.map((r) => r.repo))].sort().map((repo) => ({ repo, ...rollup(all.filter((r) => r.repo === repo)) }));
      return {
        window: { since, until },
        total: rollup(all),
        repos,
        goals: out.map((g) => {
          const stepRows = [...g.rows].sort((a, b) => (g.order.get(a.step) ?? 0) - (g.order.get(b.step) ?? 0));
          return { goal: g.goal.id, title: g.goal.title, state: g.goal.state, trial: g.goal.trial === true, ...rollup(stepRows), ...(withSteps ? { stepRows } : {}) };
        }),
      };
    });
  }

  /** `GET /v1/stuck`: sessions waiting on a person too long, claimed steps turning without a commit. */
  async stuck(q: { needsYouMs?: string | undefined; turns?: string | undefined; repo?: string | undefined; trial?: string | undefined }): Promise<Stuck> {
    let needsYouMs = 1_800_000;
    if (q.needsYouMs !== undefined) {
      needsYouMs = /^\d{1,9}$/.test(q.needsYouMs) ? Number(q.needsYouMs) : NaN;
      if (!Number.isInteger(needsYouMs) || needsYouMs < 60_000 || needsYouMs > 604_800_000) throw new HubError(400, "needsYouMs must be a whole number from 60000 to 604800000");
    }
    let turns = 40;
    if (q.turns !== undefined) {
      turns = /^\d{1,5}$/.test(q.turns) ? Number(q.turns) : NaN;
      if (!Number.isInteger(turns) || turns < 1 || turns > 10_000) throw new HubError(400, "turns must be a whole number from 1 to 10000");
    }
    const trial = q.trial ?? "exclude";
    if (trial !== "exclude" && trial !== "include") throw new HubError(400, "trial must be exclude or include");
    return this.store.tx(async () => {
      const now = this.now();
      const goals = new Map<string, Goal | undefined>();
      const passes = async (s: Step) => {
        if (q.repo !== undefined && s.repo !== q.repo) return false;
        if (!goals.has(s.goal)) goals.set(s.goal, await this.store.getGoal(s.goal));
        const g = goals.get(s.goal);
        return g !== undefined && (trial === "include" || g.trial !== true);
      };
      const sessions: Stuck["sessions"] = [];
      let unmeasured = 0;
      for (const hs of await this.store.listSessions({ live: true })) {
        const x = hs.session;
        if (x.state !== "needs_you" || x.step === undefined) continue;
        const s = await this.store.getStep(x.step);
        if (!s || !heldBy(s, x.sid, hs.userId, hs.machineId) || !(await passes(s))) continue;
        if (x.stateSince === undefined) {
          unmeasured++;
          continue;
        }
        const forMs = now - x.stateSince;
        if (forMs < needsYouMs) continue;
        sessions.push({ sid: x.sid, user: hs.userId, machine: hs.machineId, step: s.id, goal: s.goal, repo: s.repo, ...(x.needs ? { needs: x.needs } : {}), since: x.stateSince, forMs, lastSeenAt: hs.updatedAt });
      }
      sessions.sort((a, b) => b.forMs - a.forMs || (a.sid < b.sid ? -1 : a.sid > b.sid ? 1 : 0));
      const steps: Stuck["steps"] = [];
      for (const s of await this.store.listSteps({ state: "claimed" })) {
        if (!(await passes(s))) continue;
        const evs = (await this.store.eventsFor({ step: s.id })).filter((e) => e.type === "session.turn_started");
        const t = turnsSinceCommit(s, evs);
        if (t.turns < turns) continue;
        steps.push({ step: s.id, goal: s.goal, repo: s.repo, ...(s.holderUser ? { holder: s.holderUser } : {}), turns: t.turns, ...(t.commit ? { commit: t.commit, commitAt: t.commitAt } : {}), ...(s.claimedAt !== undefined ? { claimedAt: s.claimedAt } : {}) });
      }
      steps.sort((a, b) => b.turns - a.turns || (a.step < b.step ? -1 : a.step > b.step ? 1 : 0));
      const repoNames = [...new Set([...sessions.map((x) => x.repo), ...steps.map((x) => x.repo)])].sort();
      return {
        thresholds: { needsYouMs, turns },
        sessions,
        steps,
        repos: repoNames.map((repo) => ({ repo, sessions: sessions.filter((x) => x.repo === repo).length, steps: steps.filter((x) => x.repo === repo).length })),
        unmeasured,
      };
    });
  }

  /**
   * RL-19: `GET /v1/findings/rollup`: open and accepted items by severity per (preset, repo) over the
   * lineages with a raising record in the window, with the newest report, the pulse and the kind.
   */
  async findingsRollup(q: { days?: string | undefined; repo?: string | undefined; preset?: string | undefined; trial?: string | undefined }): Promise<FindingsRollup> {
    let days = 30;
    if (q.days !== undefined) {
      days = /^\d{1,3}$/.test(q.days) ? Number(q.days) : NaN;
      if (!Number.isInteger(days) || days < 1 || days > 365) throw new HubError(400, "days must be a whole number from 1 to 365");
    }
    const trial = q.trial ?? "exclude";
    if (trial !== "exclude" && trial !== "include") throw new HubError(400, "trial must be exclude or include");
    const withTrial = trial === "include";
    return this.store.tx(async () => {
      const now = this.now();
      const since = now - days * 86_400_000;
      const goals = new Map((await this.store.listGoals()).map((g) => [g.id, g] as const));
      const livePulses = new Set((await this.store.listPulses({})).filter((p) => p.deletedAt === undefined).map((p) => p.id));
      // Counted records, in insertion order (a later one wins a tie on `at`).
      const counted: StoredReview[] = [];
      for (const r of await this.store.listReviews({ raising: true, since })) {
        if (r.at > now) continue;
        const g = goals.get(r.goal);
        if (!g || g.calibration !== undefined || g.spotCheck !== undefined) continue;
        if (g.trial === true && !withTrial) continue;
        counted.push(r);
      }
      const recordsOf = new Map<string, StoredReview[]>();
      for (const r of counted) {
        const list = recordsOf.get(r.lineage) ?? [];
        list.push(r);
        recordsOf.set(r.lineage, list);
      }
      const lineages = [...recordsOf.keys()].sort(cmp);
      const presetOf = (l: string) => {
        const i = l.indexOf("|");
        return i < 0 ? l : l.slice(0, i);
      };
      // Rows: the lineage repo of each selected lineage, and the target repo of each counted item.
      interface Acc {
        preset: string;
        repo: string;
        contributing: Set<string>;
        open: RollupRow["open"];
        accepted: RollupRow["accepted"];
      }
      const rows = new Map<string, Acc>();
      const rowOf = (preset: string, repo: string): Acc => {
        const key = JSON.stringify([preset, repo]);
        let a = rows.get(key);
        if (!a) {
          a = { preset, repo, contributing: new Set(), ...emptyFindings() };
          rows.set(key, a);
        }
        return a;
      };
      for (const l of lineages) rowOf(presetOf(l), lineageRepo(l)).contributing.add(l);
      for (const item of await this.store.listItemsIn(lineages)) {
        const open = item.state === "open" || item.state === "confirmed";
        if (!open && item.state !== "accepted") continue;
        const a = rowOf(presetOf(item.lineage), targetRepo(item));
        a.contributing.add(item.lineage);
        (open ? a.open : a.accepted)[item.severity]++;
      }
      const picked = [...rows.values()]
        .filter((a) => (q.repo === undefined || a.repo === q.repo) && (q.preset === undefined || a.preset === q.preset))
        .sort((a, b) => cmp(a.repo, b.repo) || cmp(a.preset, b.preset));
      // Source records of each row; the report artifacts of their steps in one read.
      const sourcesOf = new Map<Acc, StoredReview[]>();
      const steps = new Set<string>();
      const order = new Map(counted.map((r, i) => [r, i] as const));
      for (const a of picked) {
        const home = [...a.contributing].filter((l) => lineageRepo(l) === a.repo);
        const src = (home.length ? home : [...a.contributing]).flatMap((l) => recordsOf.get(l) ?? []);
        // Newest first: larger `at`, then later insertion.
        src.sort((x, y) => y.at - x.at || (order.get(y) ?? 0) - (order.get(x) ?? 0));
        sourcesOf.set(a, src);
        for (const r of src) steps.add(r.step);
      }
      const reportsOf = new Map<string, StoredArtifact[]>();
      for (const art of await this.store.listArtifacts({ steps: [...steps].sort(cmp) })) {
        if (art.kind !== "report") continue;
        const list = reportsOf.get(art.step) ?? [];
        list.push(art);
        reportsOf.set(art.step, list);
      }
      const out: RollupRow[] = [];
      for (const a of picked) {
        const src = sourcesOf.get(a) ?? [];
        const newest = src[0] as StoredReview;
        const kindGoal = goals.get(newest.goal);
        const kind = kindGoal?.preset ? presetKind(kindGoal.preset.text) : undefined;
        let pulse: string | undefined;
        for (const r of src) {
          const p = goals.get(r.goal)?.refs?.pulse;
          if (p !== undefined && livePulses.has(p)) {
            pulse = p;
            break;
          }
        }
        let latest: StoredArtifact | undefined;
        for (const step of new Set(src.map((r) => r.step))) {
          for (const art of reportsOf.get(step) ?? []) {
            if (!latest || art.createdAt > latest.createdAt || (art.createdAt === latest.createdAt && art.id > latest.id)) latest = art;
          }
        }
        out.push({
          preset: a.preset,
          repo: a.repo,
          ...(kind !== undefined ? { kind } : {}),
          ...(pulse !== undefined ? { pulse } : {}),
          lineages: a.contributing.size,
          lastRaisedAt: newest.at,
          open: a.open,
          accepted: a.accepted,
          ...(latest
            ? {
                latestReport: {
                  ref: latest.id,
                  at: latest.createdAt,
                  goal: latest.goal,
                  step: latest.step,
                  round: latest.round,
                  ...(latest.title !== undefined ? { title: latest.title } : {}),
                  ...(latest.prunedAt !== undefined ? { pruned: true as const } : {}),
                },
              }
            : {}),
        });
      }
      return { window: { since, until: now, days }, rows: out };
    });
  }

  /** `GET /v1/health`: a scorecard per pulse and a total. */
  async health(q: { days?: string | undefined; repo?: string | undefined; topic?: string | undefined; trial?: string | undefined }): Promise<Health> {
    let days = 7;
    if (q.days !== undefined) {
      days = /^\d{1,2}$/.test(q.days) ? Number(q.days) : NaN;
      if (!Number.isInteger(days) || days < 1 || days > 90) throw new HubError(400, "days must be a whole number from 1 to 90");
    }
    const trial = q.trial ?? "exclude";
    if (trial !== "exclude" && trial !== "include") throw new HubError(400, "trial must be exclude or include");
    const withTrial = trial === "include";
    const topic = q.topic === undefined ? undefined : q.topic.trim().toLowerCase();
    return this.store.tx(async () => {
      const now = this.now();
      const since = now - days * 86_400_000;
      const inWindow = (t: number) => t >= since && t <= now;
      const pulses = (await this.store.listPulses({}))
        .filter((p) => p.deletedAt === undefined)
        .filter((p) => q.repo === undefined || p.params.repo === q.repo)
        .filter((p) => topic === undefined || topic === ALL_TOPIC || p.topics.includes(topic))
        .sort((a, b) => Number(a.id.slice(2)) - Number(b.id.slice(2)));
      const allGoals = await this.store.listGoals();
      const goalById = new Map(allGoals.map((g) => [g.id, g] as const));
      const counted = (g: Goal) => withTrial || g.trial !== true;
      // Runs in the window: steps updated since the window opened (a step's updatedAt ≥ each round's finishedAt).
      const recent = await this.store.listSteps({ updatedSince: since });
      // Raising records once: the lineages each goal names.
      const lineagesOf = new Map<string, Set<string>>();
      for (const r of await this.store.listReviews({ raising: true })) {
        const set = lineagesOf.get(r.goal) ?? new Set<string>();
        set.add(r.lineage);
        lineagesOf.set(r.goal, set);
      }
      const ctx = new CardCtx();
      const out: PulseHealth[] = [];
      const totalLineages = new Set<string>();
      for (const p of pulses) {
        const goals = allGoals.filter((g) => g.refs?.pulse === p.id && counted(g));
        const goalIds = new Set(goals.map((g) => g.id));
        const slotsIn = await this.store.listSlots({ pulse: p.id, since });
        const windowSlots = slotsIn.filter((s) => inWindow(s.at));
        const slots: PulseHealth["slots"] = { due: 0, fired: 0, started: 0, skipped: 0, missed: {}, abandoned: 0, queued: 0 };
        let manual = 0;
        const slotGoals = new Set<string>();
        for (const s of windowSlots) {
          if (s.manual) {
            if (withTrial || s.trial !== true) {
              manual++;
              if (s.goal !== undefined) slotGoals.add(s.goal);
            }
            continue;
          }
          slots.due++;
          if (s.startedAt !== undefined) slots.started++;
          if (s.state === "missed") {
            const r = s.reason ?? "error";
            slots.missed[r] = (slots.missed[r] ?? 0) + 1;
          } else slots[s.state]++;
          if (s.goal !== undefined) slotGoals.add(s.goal);
        }
        // lastSlot: the newest slot that passes trial.
        let lastSlot: PulseHealth["lastSlot"];
        let pos: { at: number; slot: string } | undefined;
        for (let guard = 0; guard < 100 && !lastSlot; guard++) {
          const batch = await this.store.listSlots({ pulse: p.id, limit: 20, ...(pos ? { before: pos } : {}) });
          const hit = batch.find((s) => withTrial || s.trial !== true);
          if (hit) lastSlot = { slot: hit.slot, at: hit.at, state: hit.state, ...(hit.reason !== undefined ? { reason: hit.reason } : {}) };
          const last = batch.at(-1);
          if (hit || batch.length < 20 || !last) break;
          pos = { at: last.at, slot: last.slot };
        }
        const blockedBy = await this.blockedBy(p, now);
        // Runs.
        const runs: PulseHealth["runs"] = { count: 0, durationMs: 0, turns: 0, failed: 0, overBudget: 0, denials: 0, allDismissed: 0 };
        for (const step of recent) {
          if (!goalIds.has(step.goal)) continue;
          const g = goalById.get(step.goal) as Goal;
          for (const round of step.rounds ?? []) {
            const t = round.telemetry;
            if (!t || !inWindow(round.finishedAt)) continue;
            const row = await this.runRow(step, g, round as Round & { telemetry: RunTelemetry });
            runs.count++;
            runs.durationMs += t.durationMs;
            runs.turns += t.turns;
            if (t.costUsdEstimate !== undefined) runs.costUsd = (runs.costUsd ?? 0) + t.costUsdEstimate;
            if (row.waste.failed) runs.failed++;
            if (row.waste.overBudget) runs.overBudget++;
            runs.denials += row.waste.denials;
            if (row.waste.allDismissed) runs.allDismissed++;
          }
        }
        // Goals of the window's slots.
        const gs: PulseHealth["goals"] = { created: 0, done: 0, dropped: 0, open: 0 };
        for (const id of slotGoals) {
          const g = goalById.get(id);
          if (!g || !counted(g)) continue;
          gs.created++;
          if (g.state === "done") gs.done++;
          else if (g.state === "dropped") gs.dropped++;
          else gs.open++;
        }
        // Lineages of the pulse's goals; accepted items and findings.
        const lineages = new Set<string>();
        for (const id of goalIds) for (const l of lineagesOf.get(id) ?? []) lineages.add(l);
        let accepted = 0;
        const decisions = { total: 0, byPeople: 0 };
        const findings = emptyFindings();
        for (const lineage of [...lineages].sort()) {
          totalLineages.add(lineage);
          const items = await ctx.items(this.store, lineage);
          const latestAccepted = new Map<string, { goal: string; at: number }>();
          for (const { fp, entry: e } of await ctx.history(this.store, lineage)) {
            if (e.kind === "disposition" && e.disposition === "accepted") latestAccepted.set(fp, { goal: e.goal, at: e.at });
            // RL-18: decisions in the pulse's goals in the window, and those a person took.
            if (e.kind === "disposition" && goalIds.has(e.goal) && inWindow(e.at)) {
              decisions.total++;
              if (e.decider.kind === "person") decisions.byPeople++;
            }
          }
          for (const row of items.values()) {
            if (row.state === "open" || row.state === "confirmed") findings.open[row.severity]++;
            else if (row.state === "accepted") {
              findings.accepted[row.severity]++;
              const last = latestAccepted.get(row.fp);
              if (last && goalIds.has(last.goal) && inWindow(last.at)) accepted++;
            }
          }
        }
        // Open debriefs of open goals.
        const debriefs: PulseHealth["debriefs"] = { open: 0, overdue: 0, breaches: [] };
        for (const g of goals) {
          if (g.state === "done" || g.state === "dropped") continue;
          const steps = await this.store.listSteps({ goal: g.id });
          const byId = new Map(steps.map((x) => [x.id, x] as const));
          let plans: Plan[] | undefined;
          for (const st of steps) {
            if (st.policy?.mode !== "debrief" || (st.state !== "ready" && st.state !== "claimed" && st.state !== "paused")) continue;
            debriefs.open++;
            plans ??= await this.store.listPlans(g.id);
            const t = stageTimes(st, byId, plans, now);
            const from = t.cycleReadyAt ?? t.readyAt;
            if (from !== undefined) debriefs.oldestMs = Math.max(debriefs.oldestMs ?? 0, Math.max(0, now - from));
            // RL-15: past its SLA.
            const sla = slaState(st, byId, plans, now);
            if (sla?.breached) {
              debriefs.overdue++;
              const n = (st.rounds?.length ?? 0) + 1;
              const autoAccepted = (await this.store.listDispositions({ step: st.id })).filter((d) => d.via === "auto-accept" && d.round === n).length;
              debriefs.breaches.push({
                goal: g.id,
                step: st.id,
                assignee: debriefAssignee(st.policy, g.ownerId),
                owner: p.owner,
                slaMs: sla.slaMs,
                since: sla.since,
                breachedAt: sla.dueAt,
                escalated: sla.escalated,
                autoAccepted,
              });
            }
          }
        }
        debriefs.breaches.sort((a, b) => a.breachedAt - b.breachedAt || cmp(a.step, b.step));
        out.push({
          pulse: p.id,
          title: p.title,
          owner: p.owner,
          enabled: p.enabled,
          schedule: scheduleText(p.when),
          ...(p.pausedReason !== undefined ? { pausedReason: p.pausedReason } : {}),
          ...(p.nextAt !== undefined ? { nextAt: p.nextAt } : {}),
          slots,
          manual,
          ...(lastSlot ? { lastSlot } : {}),
          ...(blockedBy ? { blockedBy } : {}),
          runs,
          goals: gs,
          accepted,
          ...perAccepted(runs.costUsd, accepted),
          debriefs,
          findings,
          decisions,
          ...decisionShare(decisions),
        });
      }
      // Total.
      const total: HealthTotal = {
        pulses: out.length,
        slots: { due: 0, fired: 0, started: 0, skipped: 0, missed: {}, abandoned: 0, queued: 0 },
        manual: 0,
        runs: { count: 0, durationMs: 0, turns: 0, failed: 0, overBudget: 0, denials: 0, allDismissed: 0 },
        goals: { created: 0, done: 0, dropped: 0, open: 0 },
        accepted: 0,
        debriefs: { open: 0, overdue: 0 },
        findings: emptyFindings(),
        calibrations: { open: 0 },
        decisions: { total: 0, byPeople: 0 },
        spotChecks: { open: 0, decided: 0, disagreed: 0 },
      };
      for (const h of out) {
        for (const k of ["due", "fired", "started", "skipped", "abandoned", "queued"] as const) total.slots[k] += h.slots[k];
        for (const [r, n] of Object.entries(h.slots.missed)) total.slots.missed[r] = (total.slots.missed[r] ?? 0) + n;
        total.manual += h.manual;
        for (const k of ["count", "durationMs", "turns", "failed", "overBudget", "denials", "allDismissed"] as const) total.runs[k] += h.runs[k];
        if (h.runs.costUsd !== undefined) total.runs.costUsd = (total.runs.costUsd ?? 0) + h.runs.costUsd;
        for (const k of ["created", "done", "dropped", "open"] as const) total.goals[k] += h.goals[k];
        total.accepted += h.accepted;
        total.debriefs.open += h.debriefs.open;
        total.decisions.total += h.decisions.total;
        total.decisions.byPeople += h.decisions.byPeople;
        total.debriefs.overdue += h.debriefs.overdue;
        if (h.debriefs.oldestMs !== undefined) total.debriefs.oldestMs = Math.max(total.debriefs.oldestMs ?? 0, h.debriefs.oldestMs);
      }
      Object.assign(total, perAccepted(total.runs.costUsd, total.accepted));
      for (const lineage of totalLineages) {
        for (const row of (await ctx.items(this.store, lineage)).values()) {
          if (row.state === "open" || row.state === "confirmed") total.findings.open[row.severity]++;
          else if (row.state === "accepted") total.findings.accepted[row.severity]++;
        }
      }
      for (const g of allGoals) {
        if (!g.calibration || g.state === "done" || g.state === "dropped") continue;
        total.calibrations.open++;
        total.calibrations.oldestMs = Math.max(total.calibrations.oldestMs ?? 0, now - g.createdAt);
      }
      // RL-18: the share of decisions people took, and the hub's spot checks (whatever the filters say).
      Object.assign(total, decisionShare(total.decisions));
      for (const x of openSpotChecks(allGoals)) {
        total.spotChecks.open++;
        total.spotChecks.oldestMs = Math.max(total.spotChecks.oldestMs ?? 0, Math.max(0, now - x.sampledAt));
      }
      for (const g of allGoals) {
        for (const x of g.spotCheck?.samples ?? []) {
          if (!x.verdict || !inWindow(x.verdict.at)) continue;
          total.spotChecks.decided++;
          if (x.verdict.verdict === "disagree") total.spotChecks.disagreed++;
        }
      }
      return { window: { since, until: now, days }, pulses: out, total };
    });
  }

  /** RL-12: what `fireSlot` would find blocking at `now` (read only); undefined when nothing blocks. */
  private async blockedBy(p: Pulse, now: number): Promise<{ goal: string; step: string; ageMs: number } | undefined> {
    if (p.overlap === "allow") return undefined;
    for (const s of await this.store.listSlots({ pulse: p.id, state: "fired" })) {
      if (s.goal === undefined) continue;
      const g = await this.store.getGoal(s.goal);
      if (!g || g.state === "done" || g.state === "dropped" || g.trial === true) continue;
      // Started: marked, or advanceSlot would mark it before retiring.
      let started = s.startedAt !== undefined;
      if (!started) {
        const rsId = await this.runStepOf(g);
        started = await this.slotStarted(g, rsId ? await this.store.getStep(rsId) : undefined);
      }
      // Retired (not started, window over) or abandoned (started, too old) by the fire.
      if (!started && s.until !== undefined && now >= s.until) continue;
      if (started && now - g.createdAt >= p.maxGoalAgeMs) continue;
      const step = overlapBusy(await this.store.listSteps({ goal: g.id }), await this.runStepOf(g));
      if (step !== undefined) return { goal: g.id, step, ageMs: now - g.createdAt };
    }
    return undefined;
  }

  /** `GET /v1/agents/:key/stats`: an agent key's statistics per hash. */
  async agentStats(key: string, daysRaw: string | undefined, trialRaw?: string | undefined): Promise<AgentStats> {
    if (trialRaw !== undefined && trialRaw !== "exclude" && trialRaw !== "include") throw new HubError(400, "trial must be exclude or include");
    let days = 30;
    if (daysRaw !== undefined) {
      days = /^\d+$/.test(daysRaw) ? Number(daysRaw) : NaN;
      if (!Number.isInteger(days) || days < 1 || days > 365) throw new HubError(400, "days must be a whole number from 1 to 365");
    }
    if (!key || key.length > 330 || !key.includes("/")) throw new HubError(400, "an agent key is <repo>/<name>");
    return await this.store.tx(async () => {
      const scan = await this.calibrationScan();
      const since = this.now() - days * 86_400_000;
      const { countedAll, trialGoals, ...rest } = scan;
      return computeAgentStats({ key, days, since, threshold: this.config.calibration.threshold, ...rest, counted: countedAll, trialGoals, includeTrial: trialRaw === "include" });
    });
  }

  /** `GET /v1/changes` (RL-17): when each agent, profile and preset hash first appeared. */
  async changes(q: {
    kind?: string | undefined;
    agent?: string | undefined;
    profile?: string | undefined;
    preset?: string | undefined;
    repo?: string | undefined;
    since?: string | undefined;
    until?: string | undefined;
    trial?: string | undefined;
    limit?: string | undefined;
    cursor?: string | undefined;
  }): Promise<ChangesPage> {
    if (q.kind !== undefined && q.kind !== "agent" && q.kind !== "profile" && q.kind !== "preset") throw new HubError(400, "kind must be agent, profile or preset");
    const since = queryTime("since", q.since);
    const until = queryTime("until", q.until);
    if (since !== undefined && until !== undefined && since >= until) throw new HubError(400, "since must be before until");
    const trial = q.trial ?? "exclude";
    if (trial !== "exclude" && trial !== "include") throw new HubError(400, "trial must be exclude or include");
    let limit = 100;
    if (q.limit !== undefined) {
      limit = /^\d{1,4}$/.test(q.limit) ? Number(q.limit) : NaN;
      if (!Number.isInteger(limit) || limit < 1 || limit > 500) throw new HubError(400, "limit must be a whole number from 1 to 500");
    }
    const after = q.cursor === undefined ? undefined : changeCursor.decode(q.cursor);
    if (q.cursor !== undefined && after === undefined) throw new HubError(400, "cursor is not valid");
    const keyFilters = { agent: q.agent, profile: q.profile, preset: q.preset };
    const anyKey = q.agent !== undefined || q.profile !== undefined || q.preset !== undefined;
    const wanted = (kind: "agent" | "profile" | "preset", key: string) =>
      (q.kind === undefined || q.kind === kind) && (!anyKey || (keyFilters[kind] !== undefined && keyFilters[kind] === key));
    return await this.store.tx(async () => {
      const goals = await this.store.listGoals();
      const goalById = new Map(goals.map((g) => [g.id, g]));
      const counts = (g: Goal | undefined, repo: string) => (trial === "include" || g?.trial !== true) && (q.repo === undefined || repo === q.repo);
      const sightings: Sighting[] = [];
      const add = (s: Sighting) => {
        if (wanted(s.kind, s.key)) sightings.push(s);
      };
      // Goals: the preset each goal was made from.
      for (const g of goals) {
        if (!g.preset || !counts(g, g.primaryRepo ?? "")) continue;
        const hash = createHash("sha256").update(g.preset.text, "utf8").digest("hex");
        add({ kind: "preset", key: g.preset.name, hash, at: g.createdAt, source: "goal", goal: g.id });
      }
      // Runs: every round with telemetry.
      for (const st of await this.store.listSteps({})) {
        const g = goalById.get(st.goal);
        if (!counts(g, st.repo)) continue;
        for (const r of st.rounds ?? []) {
          const t = r.telemetry;
          if (!t) continue;
          const ref = { at: r.finishedAt, source: "run" as const, goal: st.goal, step: st.id, round: r.n, runId: t.runId };
          if (t.agentKey !== undefined && t.agentHash !== undefined) add({ kind: "agent", key: t.agentKey, hash: t.agentHash, ...ref });
          add({ kind: "profile", key: t.profile, hash: t.profileHash, ...ref });
        }
      }
      // Registration events (no repo: left out when a repo is asked for).
      if (q.repo === undefined) {
        const defs = await this.store.listCatalogDefs({});
        const firstPush = new Set<string>();
        const str = (v: unknown) => (typeof v === "string" ? v : undefined);
        for (const e of await this.store.eventsOfTypes(["profile.saved", "pulse.created", "pulse.updated", "catalog.pushed"])) {
          const p = e.payload;
          const pulse = str(p.pulse);
          const ev = { seq: e.seq, id: e.id, type: e.type, at: e.at, user: e.user, ...(pulse !== undefined && e.type.startsWith("pulse.") ? { pulse } : {}) };
          const base = { at: e.at, source: "event" as const, event: ev };
          if (e.type === "profile.saved") {
            const name = str(p.name);
            const sha = str(p.sha256);
            if (name !== undefined && sha !== undefined) add({ kind: "profile", key: name, hash: sha, ...base });
          } else if (e.type === "catalog.pushed") {
            const repo = str(p.repo);
            const commit = str(p.commit);
            if (repo === undefined || commit === undefined) continue;
            for (const d of defs) {
              const k = `${d.source}\n${d.name}\n${d.hash}`;
              if (d.source !== repo || !d.commits.includes(commit) || firstPush.has(k)) continue;
              firstPush.add(k);
              add({ kind: "agent", key: d.key, hash: d.hash, ...base });
            }
          } else {
            const name = str(p.preset);
            const sha = str(p.sha256);
            if (name !== undefined && sha !== undefined) add({ kind: "preset", key: name, hash: sha, ...base });
            if (sha !== undefined && Array.isArray(p.agents))
              for (const a of p.agents as unknown[]) {
                const o = a as { key?: unknown; hash?: unknown } | null;
                if (o && typeof o.key === "string" && typeof o.hash === "string") add({ kind: "agent", key: o.key, hash: o.hash, ...base });
              }
          }
        }
      }
      const all = changeTimeline(sightings);
      const keyOf = (e: (typeof all)[number]): ChangeKey => ({ at: e.firstSeen, kind: e.kind, key: e.key, hash: e.hash });
      const cmpKey = (a: ChangeKey, b: ChangeKey) => b.at - a.at || textCmp(a.kind, b.kind) || textCmp(a.key, b.key) || textCmp(a.hash, b.hash);
      const inWindow = all.filter((e) => (since === undefined || e.firstSeen >= since) && (until === undefined || e.firstSeen < until));
      const rest = after === undefined ? inWindow : inWindow.filter((e) => cmpKey(keyOf(e), after) > 0);
      const page = rest.slice(0, limit);
      const view = (x: { id: string; seq: number; type: string; at: number; user?: string | undefined }) => ({
        id: x.id,
        seq: x.seq,
        type: x.type,
        at: x.at,
        ...(x.user !== undefined ? { user: x.user } : {}),
      });
      const changes: ChangeEntry[] = [];
      for (const e of page) {
        const f = e.first;
        let event: ChangeEntry["event"];
        if (f.source === "event" && f.event) event = view(f.event);
        else if (f.source === "goal" && f.goal !== undefined) {
          const x: EventRow | undefined = (await this.store.eventsOf({ type: "goal.created", goal: f.goal }))[0];
          if (x) event = view(x);
        } else if (f.source === "run" && f.step !== undefined) {
          const x: EventRow | undefined = (await this.store.eventsOf({ type: "run.finished", step: f.step })).find((y) => y.payload.runId === f.runId);
          if (x) event = view(x);
        }
        changes.push({
          kind: e.kind,
          key: e.key,
          hash: e.hash,
          firstSeen: e.firstSeen,
          ...(e.previous !== undefined ? { previous: e.previous } : {}),
          source: f.source,
          ...(f.source === "event" ? {} : { goal: f.goal }),
          ...(f.source === "run" ? { step: f.step, round: f.round, runId: f.runId } : {}),
          ...(f.event?.pulse !== undefined ? { pulse: f.event.pulse } : {}),
          ...(event ? { event } : {}),
          sightings: e.sightings,
        });
      }
      const last = page.at(-1);
      return { changes, ...(rest.length > limit && last ? { next: changeCursor.encode(keyOf(last)) } : {}) };
    });
  }

  /** `GET /v1/agents/:key/compare` (RL-17): the runs and item counts of two hashes of an agent key. */
  async agentCompare(
    key: string,
    q: { from?: string | undefined; to?: string | undefined; since?: string | undefined; until?: string | undefined; repo?: string | undefined; trial?: string | undefined },
  ): Promise<AgentCompare> {
    if (!key || key.length > 330 || !key.includes("/")) throw new HubError(400, "an agent key is <repo>/<name>");
    for (const name of ["from", "to"] as const) {
      const v = q[name];
      if (v === undefined || v === "") throw new HubError(400, `${name} is required`);
      if (v.length > 200) throw new HubError(400, `${name} must be at most 200 characters`);
    }
    const since = queryTime("since", q.since);
    const until = queryTime("until", q.until);
    if (since !== undefined && until !== undefined && since >= until) throw new HubError(400, "since must be before until");
    const trial = q.trial ?? "exclude";
    if (trial !== "exclude" && trial !== "include") throw new HubError(400, "trial must be exclude or include");
    const from = q.from as string;
    const to = q.to as string;
    return await this.store.tx(async () => {
      const scan = await this.calibrationScan();
      const { countedAll, trialGoals, ...rest } = scan;
      const stepRepo = new Map(scan.steps.map((s) => [s.id, s.repo]));
      const goalById = new Map(scan.goals.map((g) => [g.id, g]));
      const stats = computeAgentStats({
        key,
        days: 0,
        since: since ?? 0,
        threshold: this.config.calibration.threshold,
        ...rest,
        counted: countedAll,
        trialGoals,
        includeTrial: trial === "include",
        ...(until !== undefined ? { until } : {}),
        ...(q.repo !== undefined ? { keepStep: (id: string) => stepRepo.get(id) === q.repo } : {}),
      });
      const side = async (hash: string): Promise<HashSide> => {
        const runs: HashSide["runs"] = { count: 0, durationMs: 0, turns: 0, costRuns: 0, failed: 0, overBudget: 0, denials: 0, allDismissed: 0 };
        const picked: { step: Step; goal: Goal; round: Round & { telemetry: RunTelemetry } }[] = [];
        for (const st of scan.steps) {
          if (q.repo !== undefined && st.repo !== q.repo) continue;
          const g = goalById.get(st.goal);
          if (!g || (trial === "exclude" && g.trial === true)) continue;
          for (const r of st.rounds ?? []) {
            const t = r.telemetry;
            if (!t || t.agentKey !== key || t.agentHash !== hash) continue;
            if ((since !== undefined && r.finishedAt < since) || (until !== undefined && r.finishedAt >= until)) continue;
            picked.push({ step: st, goal: g, round: r as Round & { telemetry: RunTelemetry } });
          }
        }
        // The order of `GET /v1/runs` (newest first), so the sums add up the same way.
        const posOf = (x: (typeof picked)[number]) => ({ at: x.round.finishedAt, goal: x.goal.id, step: x.step.id, round: x.round.n });
        picked.sort((a, b) => runCursor.cmp(posOf(a), posOf(b)));
        let firstAt: number | undefined;
        let lastAt: number | undefined;
        for (const x of picked) {
          const row = await this.runRow(x.step, x.goal, x.round);
          const t = x.round.telemetry;
          runs.count++;
          runs.durationMs += t.durationMs;
          runs.turns += t.turns;
          if (t.costUsdEstimate !== undefined) {
            runs.costUsd = (runs.costUsd ?? 0) + t.costUsdEstimate;
            runs.costRuns++;
          }
          if (row.waste.failed) runs.failed++;
          if (row.waste.overBudget) runs.overBudget++;
          runs.denials += row.waste.denials;
          if (row.waste.allDismissed) runs.allDismissed++;
          firstAt = firstAt === undefined ? row.finishedAt : Math.min(firstAt, row.finishedAt);
          lastAt = lastAt === undefined ? row.finishedAt : Math.max(lastAt, row.finishedAt);
        }
        const h = stats.hashes.find((x) => x.hash === hash);
        const items: HashSide["items"] = {
          raised: h?.raised ?? 0,
          new: h?.new ?? 0,
          regressions: h?.regressions ?? 0,
          carried: h?.carried ?? 0,
          accepted: h?.accepted ?? 0,
          dismissedByAgents: h?.dismissedByAgents ?? 0,
          dismissedByPeople: h?.dismissedByPeople ?? 0,
        };
        return { hash, runs, items, ...(firstAt !== undefined ? { firstAt } : {}), ...(lastAt !== undefined ? { lastAt } : {}) };
      };
      return {
        key,
        ...(since !== undefined ? { since } : {}),
        ...(until !== undefined ? { until } : {}),
        ...(q.repo !== undefined ? { repo: q.repo } : {}),
        trial,
        from: await side(from),
        to: await side(to),
      };
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
    // RL-18: the disagreements it lists, with the agent's decision and the person's verdict.
    const listed = c.disagreements ?? [];
    if (!listed.length) return { title: `dismissals of ${c.key}@${c.hash.slice(0, 12)} (${c.dismissals.length})`, content: JSON.stringify({ agent, dismissals }) };
    const samples = new Map<string, SpotSample>();
    for (const g of spotCheckGoals(await this.store.listGoals(), { key: c.key, hash: c.hash })) for (const x of g.spotCheck?.samples ?? []) samples.set(refKey(x), x);
    const disagreements: Record<string, unknown>[] = [];
    for (const ref of listed) {
      const sample = samples.get(refKey(ref));
      const d = await this.decisionDetail(ref);
      const v = sample?.verdict;
      disagreements.push({
        ...ref,
        disposition: sample?.disposition ?? d.entry?.disposition,
        reason: d.entry?.reason ?? "",
        ...(v ? { verdict: { reason: v.reason, answer: v.answer, ...(v.expected !== undefined ? { expected: v.expected } : {}), by: v.by, at: v.at } } : {}),
        ...d.item,
      });
    }
    return {
      title: `dismissals of ${c.key}@${c.hash.slice(0, 12)} (${c.dismissals.length}), disagreements (${listed.length})`,
      content: JSON.stringify({ agent, dismissals, disagreements }),
    };
  }

  /** RL-18: a decision's history entry and its item's fields (title … evidence) as the inputs show them. */
  private async decisionDetail(ref: DismissalRef): Promise<{ entry: DispositionRow | undefined; item: Record<string, unknown>; state: ItemState | undefined }> {
    const entry = (await this.store.listDispositions({ lineage: ref.lineage, fp: ref.fp, goal: ref.goal })).find((d) => d.step === ref.step && d.round === ref.round && d.at === ref.at);
    const row = await this.store.getItem(ref.lineage, ref.fp);
    const rec = (await this.store.listReviews({ lineage: ref.lineage, raising: true })).filter((r) => r.goal === ref.goal).at(-1);
    const evidence = rec?.record.items.find((i) => i.fp === ref.fp)?.evidence ?? [];
    return {
      entry,
      state: row?.state,
      item: {
        title: row?.title ?? "",
        severity: row?.severity,
        category: row?.category,
        rule: row?.rule,
        ...(row?.path !== undefined ? { path: row.path } : {}),
        ...(row?.symbol !== undefined ? { symbol: row.symbol } : {}),
        evidence,
      },
    };
  }

  // ---------- spot checks (RL-18) ----------

  /**
   * Inside the review record's transaction: sample the record's eligible decisions of a deciding agent
   * (record order) by the rate, else the per-week minimum, into its spot-check goal.
   */
  private async spotCheckSample(
    agent: AgentRef,
    lineage: string,
    goalId: string,
    step: string,
    round: number,
    now: number,
    decisions: readonly { fp: string; disposition: Disposition }[],
  ): Promise<void> {
    const cfg = this.config.spotChecks;
    if (!cfg) return;
    let goals = await this.store.listGoals();
    const dispositions = await this.store.listDispositions({ lineage, goal: goalId });
    for (const d of decisions) {
      const why = spotWhy(spotU({ lineage, fp: d.fp, step, round }), cfg, recentSamples(goals, agent, now - SPOT_WEEK_MS));
      if (!why) continue;
      const entry = dispositions.filter((x) => x.fp === d.fp && x.step === step && x.round === round && x.decider.kind === "agent").at(-1);
      if (!entry) continue;
      const sample: SpotSample = { lineage, fp: d.fp, goal: entry.goal, step, round, at: entry.at, disposition: d.disposition, why, sampledAt: now };
      const target = await this.spotCheckTarget(goals, agent);
      let g: Goal | undefined;
      let created = false;
      if (target) {
        g = { ...target, spotCheck: { ...(target.spotCheck as GoalSpotCheck), samples: [...(target.spotCheck as GoalSpotCheck).samples, sample] }, updatedAt: now };
        await this.store.saveGoal(g);
      } else {
        const who = await this.calibratorFor(agent, { ref: sample }, { steps: await this.store.listSteps({}), goals });
        if (!who) continue;
        const hash12 = agent.hash.slice(0, 12);
        const text = presetText(SPOT_CHECK_PRESET);
        g = await this.createWithPlan(
          {
            owner: who.user,
            title: `Spot-check ${agent.key}@${hash12}`,
            preset: { name: SPOT_CHECK_PRESET.name, text, sha256: createHash("sha256").update(text, "utf8").digest("hex") },
            params: { repo: who.repo, agent: agent.key, hash: hash12 },
            profiles: {},
            agents: {},
            topics: [],
            priority: 3,
            comment: `spot checks of ${agent.key}@${hash12} (rate ${cfg.rate}, at least ${cfg.minPerWeek} per week)`,
            extra: {},
            spotCheck: { key: agent.key, hash: agent.hash, samples: [sample] },
          },
          now,
        );
        created = true;
      }
      goals = created ? [...goals, g] : goals.map((x) => (x.id === g?.id ? g : x));
      const n = (g.spotCheck as GoalSpotCheck).samples.length;
      await this.emit({
        at: now,
        type: "spot-check.opened",
        user: g.ownerId,
        goal: g.id,
        step: `${g.id}.check`,
        payload: { key: agent.key, hash: agent.hash, sample: n, lineage, fp: d.fp, decisionGoal: entry.goal, decisionStep: step, round, disposition: d.disposition, why },
      });
    }
  }

  /** The oldest open spot-check goal of an agent hash whose check step is ready and that has room. */
  private async spotCheckTarget(goals: readonly Goal[], agent: AgentRef): Promise<Goal | undefined> {
    const open = spotCheckGoals(goals, agent)
      .filter((g) => g.state !== "done" && g.state !== "dropped" && (g.spotCheck?.samples.length ?? 0) < SPOT_MAX_SAMPLES)
      .sort((a, b) => a.createdAt - b.createdAt || cmp(a.id, b.id));
    for (const g of open) {
      if ((await this.store.getStep(`${g.id}.check`))?.state === "ready") return g;
    }
    return undefined;
  }

  /** The check step of a spot-check goal, or a 409. */
  private spotCheckOf(step: Step, goal: Goal): GoalSpotCheck {
    if (!goal.spotCheck || step.id !== `${goal.id}.check`) throw new HubError(409, `${step.id} is not a spot-check step`);
    return goal.spotCheck;
  }

  /** `POST /v1/steps/:id/spot-checks`: a person's verdict on one sampled decision. */
  async spotCheckVerdict(actor: Actor, id: string, b: SpotCheckRequest): Promise<SpotCheckResult> {
    return await this.goalTx(async () => {
      const step = await this.stepOr404(id);
      const goal = await this.goalOr404(step.goal);
      const c = this.spotCheckOf(step, goal);
      if (step.state !== "claimed" && step.state !== "paused") throw new HubError(409, `${step.id} is ${step.state}; only a held spot check takes verdicts`);
      if (step.holderUser !== actor.userId) throw new HubError(403, `${step.id} is held by ${step.holderUser}`);
      if (b.sid) this.refuseForeign(await this.callerMachine(actor, b.sid), b.sid);
      const sample = c.samples[b.sample - 1];
      if (!sample) throw new HubError(404, `${step.id} has no sample ${b.sample}`);
      if (sample.verdict) throw new HubError(409, `sample ${b.sample} of ${step.id} already has a verdict`);
      if (b.expected !== undefined && b.verdict === "agree") throw new HubError(422, "expected is only for disagree");
      if (b.expected !== undefined && b.expected === sample.disposition) throw new HubError(422, `expected ${b.expected} is the agent's decision; record agree`);
      const now = this.now();
      const decided: SpotSample = {
        ...sample,
        verdict: { verdict: b.verdict, reason: b.reason, answer: b.answer, ...(b.expected !== undefined ? { expected: b.expected } : {}), by: actor.userId, at: now },
      };
      const samples = c.samples.map((x, i) => (i === b.sample - 1 ? decided : x));
      await this.store.saveGoal({ ...goal, spotCheck: { ...c, samples }, updatedAt: now });
      await this.saveStepFrom({ ...step, updatedAt: now }, step);
      await this.emit({
        at: now,
        type: "spot-check.decided",
        user: actor.userId,
        sid: b.sid,
        goal: goal.id,
        step: step.id,
        payload: {
          key: c.key,
          hash: c.hash,
          sample: b.sample,
          lineage: sample.lineage,
          fp: sample.fp,
          verdict: b.verdict,
          ...(b.expected !== undefined ? { expected: b.expected } : {}),
        },
      });
      if (b.verdict === "disagree") await this.calibrationTrigger({ key: c.key, hash: c.hash }, now);
      return { sample: { ...decided, n: b.sample }, left: samples.filter((x) => !x.verdict).length };
    });
  }

  /** The `spot-check` input of a spot-check goal's step: its samples with the decisions and items. */
  private async spotCheckInput(goal: Goal): Promise<{ title: string; content: string } | undefined> {
    const c = goal.spotCheck;
    if (!c) return undefined;
    const found = await this.catalogDefOf({ key: c.key, hash: c.hash });
    const samples: Record<string, unknown>[] = [];
    for (const [i, x] of c.samples.entries()) {
      const d = await this.decisionDetail(x);
      samples.push({
        sample: i + 1,
        lineage: x.lineage,
        fp: x.fp,
        goal: x.goal,
        step: x.step,
        round: x.round,
        at: x.at,
        disposition: x.disposition,
        why: x.why,
        reason: d.entry?.reason ?? "",
        ...(d.entry?.link !== undefined ? { link: d.entry.link } : {}),
        ...(d.entry?.until !== undefined ? { until: d.entry.until } : {}),
        ...d.item,
        state: d.state,
        ...(x.verdict ? { verdict: x.verdict } : {}),
      });
    }
    const agent = { key: c.key, hash: c.hash, ...(found ? { text: found.def.text } : {}) };
    return { title: `spot checks of ${c.key}@${c.hash.slice(0, 12)} (${c.samples.length})`, content: JSON.stringify({ agent, samples }) };
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
  private async dropGoal(goalId: string, reason: "abandoned" | "missed" | "person" | "superseded", now: number, o: { by?: string | undefined; comment?: string | undefined } = {}): Promise<void> {
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
    // RL-9: a person's drop names who dropped it (and why).
    await this.emit({ type: "goal.dropped", user: o.by, goal: goal.id, payload: { reason, ...(o.by ? { by: o.by } : {}), ...(o.comment ? { comment: o.comment } : {}) } });
    for (const s of dropped) await this.emit({ type: "step.dropped", user: o.by, goal: goal.id, step: s.id, payload: { reason } });
    await this.emitOffersEnded(o.by ? { userId: o.by } : undefined, ended);
  }

  // ---------- clean-audit goals (RL-9) ----------

  /** The clean-audit goal of `(repo, topic)`: the goal with that sink that is not dropped (exact strings). */
  private async cleanAuditGoal(repo: string, topic: string): Promise<Goal | undefined> {
    return (await this.store.listGoals()).find((g) => g.sink?.repo === repo && g.sink.topic === topic && g.state !== "dropped");
  }

  /**
   * The filed items of a lineage (`accepted` with a `link`), most severe first. With `goalId`: only the
   * items whose latest `accepted` disposition (any decider) was recorded in that goal, each with the
   * union of `requires` over its `accepted` dispositions there.
   */
  private async filedItems(lineage: string, goalId?: string): Promise<SinkItem[]> {
    const rows = (await this.store.listItems(lineage)).filter((r) => r.state === "accepted" && r.link !== undefined).sort(byItemOrder);
    if (!rows.length) return [];
    const accepted = (await this.store.listDispositions({ lineage })).filter((d) => d.disposition === "accepted");
    const out: SinkItem[] = [];
    for (const row of rows) {
      const mine = accepted.filter((d) => d.fp === row.fp);
      const last = mine.at(-1);
      const latest = last ? { at: last.at, step: last.step } : undefined;
      if (goalId === undefined) {
        out.push({ row, requires: [], accepted: latest });
        continue;
      }
      if (last?.goal !== goalId) continue;
      out.push({ row, requires: [...new Set(mine.filter((d) => d.goal === goalId).flatMap((d) => d.requires ?? []))], accepted: latest });
    }
    return out;
  }

  /**
   * Rule 3: whether an item's latest `accepted` disposition is newer than the last change of its
   * closed finding step to `done`/`dropped` (`updatedAt`). In the same millisecond the event order
   * decides (the `item.disposed` of that disposition after the step's `step.done`/`step.dropped`).
   */
  private async filedAfterClose(cur: Step, row: ItemRow, accepted: { at: number; step: string } | undefined): Promise<boolean> {
    if (!accepted) return false;
    if (accepted.at !== cur.updatedAt) return accepted.at > cur.updatedAt;
    const closed = (await this.store.eventsFor({ step: cur.id })).filter((e) => e.type === "step.done" || e.type === "step.dropped").at(-1)?.seq;
    const filed = (await this.store.eventsFor({ step: accepted.step }))
      .filter((e) => e.type === "item.disposed" && e.payload.lineage === row.lineage && e.payload.fp === row.fp && e.payload.disposition === "accepted")
      .at(-1)?.seq;
    return closed !== undefined && filed !== undefined && filed > closed;
  }

  /** The evidence and proposal of an item in the newest raising record of its lineage that has it. */
  private async itemEvidence(lineage: string, fp: string, cache: Map<string, StoredReview[]>): Promise<{ evidence: ReviewEvidence[]; proposal?: string | undefined }> {
    let recs = cache.get(lineage);
    if (!recs) {
      recs = (await this.store.listReviews({ lineage, raising: true })).sort((a, b) => a.at - b.at);
      cache.set(lineage, recs);
    }
    for (let i = recs.length - 1; i >= 0; i--) {
      const it = (recs[i] as StoredReview).record.items.find((x) => x.fp === fp);
      if (it) return { evidence: it.evidence, ...(it.proposal !== undefined ? { proposal: it.proposal } : {}) };
    }
    return { evidence: [] };
  }

  // ---------- placing finding steps (RL-10) ----------

  /** RL-10: a new work for one call; `now` is the time its writes carry. */
  private newWork(from: string, now: number, o: { fromStep?: string | undefined; user?: string | undefined } = {}): Work {
    return {
      now,
      from,
      fromStep: o.fromStep,
      user: o.user,
      goals: new Map(),
      byKey: new Map(),
      byFinding: new Map(),
      loaded: new Set(),
      seq: 0,
      notes: [],
      dropped: [],
      reopens: [],
      touched: [],
      noted: new Set(),
      skipped: 0,
      resultNotes: [],
      cache: new Map(),
    };
  }

  /** RL-10: every clean-audit goal of `topic` that is not dropped, with its steps, into the work (once per topic). */
  private async loadTopic(w: Work, topic: string): Promise<void> {
    if (w.loaded.has(topic)) return;
    w.loaded.add(topic);
    w.allGoals ??= await this.store.listGoals();
    for (const goal of w.allGoals) {
      if (!goal.sink || goal.sink.topic !== topic || goal.state === "dropped" || w.goals.has(goal.id)) continue;
      const existing = await this.store.listSteps({ goal: goal.id });
      const wg: WorkGoal = { repo: goal.sink.repo, topic, goal, gid: goal.id, owner: goal.ownerId, existing, all: new Map(existing.map((s) => [s.id, s] as const)), changed: new Set(), added: [], reopened: [], ord: w.goals.size };
      w.goals.set(goal.id, wg);
      for (const s of existing) HubService.index(w, wg, s);
      const key = `${goal.sink.repo}\u0000${topic}`;
      if (!w.byKey.has(key)) w.byKey.set(key, goal.id);
    }
  }

  /** RL-10: every topic of a clean-audit goal that is not dropped, into the work. */
  private async loadAllTopics(w: Work): Promise<void> {
    w.allGoals ??= await this.store.listGoals();
    for (const g of w.allGoals) if (g.sink && g.state !== "dropped") await this.loadTopic(w, g.sink.topic);
  }

  /** RL-10: the clean-audit goal of `(repo, topic)` in the work, or a placeholder for one to open. */
  private async workGoal(w: Work, repo: string, topic: string, ownerIfNew: string): Promise<WorkGoal> {
    await this.loadTopic(w, topic);
    const key = `${repo}\u0000${topic}`;
    const gid = w.byKey.get(key);
    if (gid !== undefined) return w.goals.get(gid) as WorkGoal;
    const ph = `\uE000${++w.seq}\uE000`;
    const wg: WorkGoal = { repo, topic, goal: undefined, gid: ph, owner: ownerIfNew, existing: [], all: new Map(), changed: new Set(), added: [], reopened: [], ord: w.goals.size };
    w.goals.set(ph, wg);
    w.byKey.set(key, ph);
    return wg;
  }

  private static put(w: Work, wg: WorkGoal, s: Step): void {
    wg.all.set(s.id, s);
    wg.changed.add(s.id);
    HubService.index(w, wg, s);
  }

  /** RL-10: register a finding step at its home id in the work's `(lineage, fp)` index. */
  private static index(w: Work, wg: WorkGoal, s: Step): void {
    const f = s.finding;
    if (!f || s.id !== `${wg.gid}.${findingStepId(f.lineage, f.fp)}`) return;
    const key = `${f.lineage}\u0000${f.fp}`;
    let set = w.byFinding.get(key);
    if (!set) w.byFinding.set(key, (set = new Set()));
    set.add(wg);
  }

  /** RL-10: the work's goals with a finding step of `(lineage, fp)` at its home id, each with that step, in `Work.goals` order. */
  private static indexed(w: Work, lineage: string, fp: string): { wg: WorkGoal; step: Step }[] {
    const local = findingStepId(lineage, fp);
    const out: { wg: WorkGoal; step: Step }[] = [];
    for (const wg of w.byFinding.get(`${lineage}\u0000${fp}`) ?? []) {
      const step = wg.all.get(`${wg.gid}.${local}`);
      if (step?.finding?.lineage === lineage && step.finding.fp === fp) out.push({ wg, step });
    }
    return out.sort((a, b) => a.wg.ord - b.wg.ord);
  }

  private static note(w: Work, wg: WorkGoal, step: string, user: string, text: string): void {
    w.notes.push({ gid: wg.gid, step, user, text });
  }

  /** RL-10: a note written once per call (held-step notes). */
  private static noteOnce(w: Work, wg: WorkGoal, step: string, user: string, text: string): void {
    const key = `${step}\u0000${text}`;
    if (w.noted.has(key)) return;
    w.noted.add(key);
    HubService.note(w, wg, step, user, text);
  }

  /** RL-10: every finding step of `(lineage, fp)` in the work's goals of `topic`, moved-away ones included. */
  private static findings(w: Work, lineage: string, fp: string, topic: string): { wg: WorkGoal; step: Step }[] {
    return HubService.indexed(w, lineage, fp).filter((f) => f.wg.topic === topic);
  }

  /** The brief of a finding step, built from the item, its newest evidence and its disposition reasons. */
  private async findingBriefOf(w: Work, row: ItemRow): Promise<string> {
    const ev = await this.itemEvidence(row.lineage, row.fp, w.cache);
    const reasons = (await this.store.itemHistory(row.lineage, row.fp)).flatMap((e) => (e.kind === "disposition" ? [`${e.disposition} by ${deciderText(e.decider)}: ${e.reason}`] : []));
    return findingBrief({ item: row, evidence: ev.evidence, proposal: ev.proposal, reasons });
  }

  /** RL-10: "requires of an item": the union of `requires` over all its `accepted` dispositions (any goal). */
  private async itemRequires(lineage: string, fp: string): Promise<string[]> {
    return [...new Set((await this.store.listDispositions({ lineage, fp })).filter((d) => d.disposition === "accepted").flatMap((d) => d.requires ?? []))];
  }

  /** A new finding step of an item in `wg` (RL-9 rule 2 fields). */
  private async newFindingStep(w: Work, wg: WorkGoal, row: ItemRow, fixCycles: number): Promise<Step> {
    return {
      id: `${wg.gid}.${findingStepId(row.lineage, row.fp)}`,
      goal: wg.gid,
      planVersion: 1,
      kind: "implement",
      repo: wg.repo,
      title: findingTitle(row.severity, row.title),
      brief: await this.findingBriefOf(w, row),
      deps: [],
      state: "blocked",
      fixCycles,
      policy: { worktree: true },
      severity: row.severity,
      finding: { lineage: row.lineage, fp: row.fp },
      updatedAt: w.now,
    };
  }

  /**
   * RL-10 "Placing the home step": the one routine of every path that opens a finding step (sink,
   * backfill, revert). A held foreign step stops it with a note; an open one is moved (the move
   * opens the home step); then the home step is created, revived, reopened or left by what exists.
   */
  private async placeHome(w: Work, item: SinkItem, topic: string, o: { kind: "sink" | "backfill" | "revert"; ownerIfNew: string; user?: string | undefined }): Promise<void> {
    const { row, requires, accepted } = item;
    const target = targetRepo(row);
    const home = await this.workGoal(w, target, topic, o.ownerIfNew);
    const user = o.user ?? home.owner;
    const found = HubService.findings(w, row.lineage, row.fp, topic);
    // Foreign step first.
    const foreign = found.filter((f) => f.wg !== home && !isMovedAway(f.step) && !CLOSED_STATES.has(f.step.state));
    const held = foreign.filter((f) => HELD_OR_FAILED.has(f.step.state));
    if (held.length) {
      for (const f of held) HubService.noteOnce(w, f.wg, f.step.id, o.user ?? f.wg.owner, `filed for repo ${target}; move it with: mesh items retarget ${row.lineage} ${row.fp} --repo ${target}`);
      if (o.kind !== "revert") w.skipped++;
      return;
    }
    const open = foreign.find((f) => OPEN_STATES.has(f.step.state));
    if (open) {
      await this.moveStep(w, open.wg, open.step, target, row, open.wg.owner);
      return;
    }
    const id = `${home.gid}.${findingStepId(row.lineage, row.fp)}`;
    const cur = home.all.get(id);
    if (cur && (cur.finding?.lineage !== row.lineage || cur.finding.fp !== row.fp)) {
      // A hash clash: never overwrite another finding's step.
      if (o.kind === "revert") return;
      HubService.note(w, home, id, user, `finding ${row.fp} of ${row.lineage} has the step id of another finding; not added`);
      w.skipped++;
      return;
    }
    if (o.kind === "revert") {
      // Only a live dropped home step reopens, deps unchanged.
      if (!cur || isMovedAway(cur) || cur.state !== "dropped") return;
      HubService.put(w, home, reopenedFinding(cur, w.now));
      HubService.note(w, home, id, user, `reverted by ${w.from}`);
      w.reopens.push({ gid: home.gid, step: id, user, reason: "reverted" });
      return;
    }
    const opening = !cur || isMovedAway(cur) || cur.state === "done" || cur.state === "dropped";
    // A sink or backfill opens only an item filed after the last close of every finding step of it.
    if (opening && !(await this.filedAfterEveryClose(found, row, accepted))) {
      w.skipped++;
      return;
    }
    const title = findingTitle(row.severity, row.title);
    const sink = o.kind === "sink";
    if (!cur) {
      HubService.put(w, home, await this.newFindingStep(w, home, row, 0));
      home.added.push(id);
      if (sink) w.touched.push({ gid: home.gid, id, lineage: row.lineage, requires, deps: "replace", user });
    } else if (isMovedAway(cur)) {
      HubService.put(w, home, { ...revivedFinding(cur, target, w.now), title, severity: row.severity, brief: await this.findingBriefOf(w, row) });
      HubService.note(w, home, id, user, `refiled by ${w.from}`);
      w.reopens.push({ gid: home.gid, step: id, user, reason: "refiled" });
      home.reopened.push(id);
      if (sink) w.touched.push({ gid: home.gid, id, lineage: row.lineage, requires, deps: "replace", user });
    } else if (cur.state === "done" || cur.state === "dropped") {
      HubService.put(w, home, { ...reopenedFinding(cur, w.now), title, severity: row.severity, brief: await this.findingBriefOf(w, row) });
      HubService.note(w, home, id, user, `refiled by ${w.from}`);
      w.reopens.push({ gid: home.gid, step: id, user, reason: "refiled" });
      home.reopened.push(id);
      if (sink) w.touched.push({ gid: home.gid, id, lineage: row.lineage, requires, deps: "add", user });
    } else if (OPEN_STATES.has(cur.state)) {
      const brief = await this.findingBriefOf(w, row);
      if (cur.title !== title || cur.severity !== row.severity || cur.brief !== brief) HubService.put(w, home, { ...cur, title, severity: row.severity, brief, updatedAt: w.now });
      w.skipped++;
    } else if (HELD_OR_FAILED.has(cur.state)) {
      HubService.note(w, home, id, user, `refiled by ${w.from} (${row.severity})`);
      w.skipped++;
    } else w.skipped++;
  }

  /** RL-10: the item's latest `accepted` is newer than the last close of every closed finding step of it (none: true). */
  private async filedAfterEveryClose(found: readonly { step: Step }[], row: ItemRow, accepted: { at: number; step: string } | undefined): Promise<boolean> {
    for (const { step } of found) if (CLOSED_STATES.has(step.state) && !(await this.filedAfterClose(step, row, accepted))) return false;
    return true;
  }

  /**
   * RL-10 "Moving a finding step": the open step `S` of goal `A` moves to the clean-audit goal of
   * `(n, A's topic)`, whose home step is created, revived or reopened. Returns the new id, or
   * undefined when the move is skipped.
   */
  private async moveStep(w: Work, A: WorkGoal, S: Step, n: string, row: ItemRow, user: string): Promise<string | undefined> {
    const t = A.topic;
    if (!(await this.store.getTopic(t))) {
      const text = `move to ${n} skipped: topic ${t} is not defined`;
      HubService.noteOnce(w, A, S.id, user, text);
      w.resultNotes.push(text);
      return undefined;
    }
    const B = await this.workGoal(w, n, t, A.owner);
    const H = `${B.gid}.${findingStepId(row.lineage, row.fp)}`;
    const cur = B.all.get(H);
    if (cur && (cur.finding?.lineage !== row.lineage || cur.finding.fp !== row.fp)) {
      const text = `move to ${n} skipped: finding ${row.fp} of ${row.lineage} has the step id of another finding there`;
      HubService.noteOnce(w, A, S.id, user, text);
      w.resultNotes.push(text);
      return undefined;
    }
    const title = findingTitle(row.severity, row.title);
    let opened = true;
    if (!cur) {
      HubService.put(w, B, await this.newFindingStep(w, B, row, S.fixCycles));
      HubService.note(w, B, H, user, `moved from ${S.id}`);
    } else if (isMovedAway(cur)) {
      HubService.put(w, B, { ...revivedFinding(cur, n, w.now), title, severity: row.severity, brief: await this.findingBriefOf(w, row) });
      HubService.note(w, B, H, user, `moved back from ${S.id}`);
      w.reopens.push({ gid: B.gid, step: H, user, reason: "moved" });
    } else if (CLOSED_STATES.has(cur.state)) {
      HubService.put(w, B, { ...reopenedFinding(cur, w.now), repo: n, deps: [], title, severity: row.severity, brief: await this.findingBriefOf(w, row) });
      HubService.note(w, B, H, user, `moved from ${S.id}`);
      w.reopens.push({ gid: B.gid, step: H, user, reason: "moved" });
    } else {
      // A live open or held home step (not reachable by the one-open-step rule): left as it is.
      HubService.note(w, B, H, user, `moved from ${S.id}`);
      opened = false;
    }
    if (opened) {
      B.added.push(H);
      w.touched.push({ gid: B.gid, id: H, lineage: row.lineage, requires: await this.itemRequires(row.lineage, row.fp), deps: "replace", user });
    }
    HubService.put(w, A, { ...S, state: "dropped", movedTo: H, summary: `moved to ${H}`, updatedAt: w.now });
    w.dropped.push({ gid: A.gid, step: S.id, user, to: H });
    for (const d of A.all.values()) if (d.deps.includes(S.id) && !isMovedAway(d)) HubService.note(w, A, d.id, user, `dep ${S.id} moved to ${H}`);
    return H;
  }

  /**
   * RL-10 retarget step 3 (also the fold move): each live finding step of the item that is not
   * closed and whose goal's repo is not `to`: open → moved, held → the release note.
   */
  private async retargetSteps(w: Work, row: ItemRow, to: string, user: string | undefined, out: { moved: { from: string; to: string }[]; held: string[] }): Promise<void> {
    await this.loadAllTopics(w);
    const hits = HubService.indexed(w, row.lineage, row.fp)
      .filter(({ wg, step }) => wg.goal && !isMovedAway(step) && !CLOSED_STATES.has(step.state) && wg.repo !== to)
      .sort((a, b) => goalSeq(a.wg.gid) - goalSeq(b.wg.gid));
    for (const { wg, step } of hits) {
      if (HELD_OR_FAILED.has(step.state)) {
        HubService.noteOnce(w, wg, step.id, user ?? wg.owner, `retarget to ${to}: release the step, then run the retarget again`);
        if (!out.held.includes(step.id)) out.held.push(step.id);
      } else {
        const H = await this.moveStep(w, wg, step, to, row, user ?? wg.owner);
        if (H !== undefined) out.moved.push({ from: step.id, to: H });
      }
    }
  }

  /** RL-10: RL-9 rule 5 (deps within the step's own goal) for the touched steps, then each changed goal settled. */
  private finishWork(w: Work): void {
    const depsMaps = new Map<string, Map<string, readonly string[]>>();
    for (const t of w.touched) {
      const wg = w.goals.get(t.gid) as WorkGoal;
      let depsMap = depsMaps.get(t.gid);
      if (!depsMap) {
        depsMap = new Map([...wg.all.values()].map((s) => [s.id, s.deps] as const));
        depsMaps.set(t.gid, depsMap);
      }
      const step = wg.all.get(t.id) as Step;
      const deps = t.deps === "replace" ? [] : [...step.deps];
      for (const fp of t.requires) {
        const own = `${wg.gid}.${findingStepId(t.lineage, fp)}`;
        const ownStep = wg.all.get(own);
        let dep: string | undefined;
        if (ownStep?.finding?.fp === fp && !isMovedAway(ownStep)) dep = own;
        else {
          const cands = [...wg.all.values()].filter((s) => s.finding?.fp === fp && !isMovedAway(s));
          const lineages = new Set(cands.map((s) => s.finding?.lineage));
          if (cands.length === 1) dep = (cands[0] as Step).id;
          else {
            HubService.note(w, wg, t.id, t.user, `requires ${fp}: ${lineages.size > 1 ? "ambiguous" : "not in this goal"}`);
            continue;
          }
        }
        if (deps.includes(dep)) continue;
        if (closesCycle(depsMap, t.id, dep)) {
          HubService.note(w, wg, t.id, t.user, `requires ${fp}: cycle`);
          continue;
        }
        deps.push(dep);
        depsMap.set(t.id, [...deps]);
      }
      if (deps.length !== step.deps.length || deps.some((d, i) => d !== step.deps[i])) HubService.put(w, wg, { ...step, deps });
    }
    // State by deps: created, reopened and moved steps come out ready or blocked; dependants of a moved step unblock.
    for (const wg of w.goals.values()) if (wg.changed.size) for (const s of settle([...wg.all.values()], w.now, () => true).changed) HubService.put(w, wg, s);
  }

  /** RL-10: a work's texts and ids as a dry run shows them: a goal still to be opened is `<new>` (sink) or `new:<repo>/<local>` (retarget). */
  private static renderDry(w: Work, form: "sink" | "retarget"): (text: string) => string {
    if (form === "sink") return (text) => text.replace(PLACEHOLDER, NEW_GOAL);
    return (text) =>
      text.replace(/\uE000\d+\uE000(\.[A-Za-z0-9-]+)?/g, (m: string, local: string | undefined) => {
        const ph = local ? m.slice(0, m.length - local.length) : m;
        const repo = w.goals.get(ph)?.repo ?? "";
        return local ? `new:${repo}/${local.slice(1)}` : `new:${repo}`;
      });
  }

  /**
   * RL-10: write a decided work (inside the caller's transaction): the goals to open (by repo, then
   * topic), the steps, offers, moved drops, notes, reopens, ready steps and one `goal.sunk` per goal
   * that got added or reopened steps. Returns the renderer of ids and texts.
   */
  private async writeWork(w: Work): Promise<(text: string) => string> {
    const now = w.now;
    const real = new Map<string, string>();
    const fresh = [...w.goals.values()].filter((g) => !g.goal && (g.added.length || g.reopened.length)).sort((a, b) => (a.repo < b.repo ? -1 : a.repo > b.repo ? 1 : a.topic < b.topic ? -1 : a.topic > b.topic ? 1 : 0));
    for (const wg of fresh) {
      const title = `Clean audits: ${wg.topic} on ${repoName(wg.repo)}`;
      const goal = await this.store.createGoal({
        title,
        ownerId: wg.owner,
        state: "in_progress",
        primaryRepo: wg.repo,
        topics: [wg.topic],
        sink: { repo: wg.repo, topic: wg.topic },
        priority: 3,
        createdAt: now,
        updatedAt: now,
      });
      // An approved plan v1 without steps (validatePlan is not run: finding steps are saved directly).
      await this.store.savePlan({ goal: goal.id, version: 1, steps: [], proposedBy: wg.owner, proposedAt: now, decision: "approved", decidedBy: wg.owner, decidedAt: now });
      await this.emit({ at: now, type: "goal.created", user: wg.owner, goal: goal.id, payload: { title, sink: { repo: wg.repo, topic: wg.topic } } });
      real.set(wg.gid, goal.id);
      wg.goal = goal;
    }
    const render = (text: string) => text.replace(PLACEHOLDER, (m) => real.get(m) ?? m);
    const ordered = [
      ...[...w.goals.values()].filter((g) => g.goal && !real.has(g.gid)).sort((a, b) => goalSeq(a.gid) - goalSeq(b.gid)),
      ...fresh,
    ];
    const before = new Map<string, string>();
    const written: { gid: string; step: Step }[] = [];
    const byId = new Map<string, Step>();
    for (const wg of ordered) {
      if (!wg.changed.size) continue;
      const gid = render(wg.gid);
      const steps = [...wg.changed].map((id) => {
        const s = wg.all.get(id) as Step;
        const out: Step = { ...s, id: render(s.id), goal: gid, deps: s.deps.map(render) };
        if (s.movedTo !== undefined) out.movedTo = render(s.movedTo);
        if (s.summary !== undefined) out.summary = render(s.summary);
        return out;
      });
      for (const s of wg.existing) before.set(s.id, s.state);
      const ended = endOffersLeavingReady(wg.existing, steps, now);
      if (ended.steps.length) await this.store.saveSteps(ended.steps);
      await this.emitOffersEnded({ userId: w.user ?? wg.owner }, ended.ended);
      for (const s of steps) {
        written.push({ gid, step: s });
        byId.set(s.id, s);
      }
    }
    for (const d of w.dropped) {
      await this.emit({ at: now, type: "step.dropped", user: d.user, goal: render(d.gid), step: render(d.step), payload: { reason: "moved", to: render(d.to), by: d.user } });
    }
    for (const n of w.notes) {
      const step = render(n.step);
      await this.store.addNote({ step, user: n.user, text: render(n.text), at: now });
      await this.emit({ at: now, type: "step.noted", user: n.user, goal: render(n.gid), step });
    }
    for (const r of w.reopens) {
      const step = render(r.step);
      await this.emit({ at: now, type: "step.reopened", user: r.user, goal: render(r.gid), step, payload: { by: r.user, reason: r.reason, fixCycles: byId.get(step)?.fixCycles, from: w.from } });
    }
    for (const { gid, step } of written) if (step.state === "ready" && before.get(step.id) !== "ready") await this.emitReady(gid, step.id);
    for (const wg of ordered) {
      if (!wg.added.length && !wg.reopened.length) continue;
      const gid = render(wg.gid);
      await this.emit({
        at: now,
        type: "goal.sunk",
        user: wg.owner,
        goal: gid,
        ...(w.fromStep ? { step: w.fromStep } : {}),
        payload: { goal: gid, from: w.from, added: wg.added.map(render), reopened: wg.reopened.map(render) },
      });
    }
    return render;
  }

  /** A note and `goal.sink_failed` on a sink stage whose sink cannot run (nothing of the sink is written). */
  private async sinkFailed(relayGoal: Goal, sinkStep: Step, reason: string, now: number): Promise<void> {
    await this.store.addNote({ step: sinkStep.id, user: relayGoal.ownerId, text: `sink failed: ${reason}`, at: now });
    await this.emit({ at: now, type: "step.noted", user: relayGoal.ownerId, goal: relayGoal.id, step: sinkStep.id });
    await this.emit({ at: now, type: "goal.sink_failed", user: relayGoal.ownerId, goal: relayGoal.id, step: sinkStep.id, payload: { from: sinkStep.id, reason } });
  }

  /** Sink the items filed in a relay goal by its sink stage (inside the caller's transaction; never fails it for a sink reason). */
  private async runSink(relayGoal: Goal, sinkStep: Step, steps: readonly Step[], now: number): Promise<void> {
    const sink = sinkStep.policy?.sink;
    if (!sink) return;
    const topic = sink.topic.trim().toLowerCase();
    if (topic === ALL_TOPIC || !TopicName.safeParse(topic).success || !(await this.store.getTopic(topic))) {
      await this.sinkFailed(relayGoal, sinkStep, `topic ${topic} is not defined`, now);
      return;
    }
    const run = runOf(sinkStep, steps, (s) => s.policy);
    if (!run) return;
    const lineage = lineageOf(relayGoal, run);
    const items = await this.filedItems(lineage, relayGoal.id);
    if (!items.length) return;
    // RL-10: each item is placed in the clean-audit goal of its target repo.
    const w = this.newWork(sinkStep.id, now, { fromStep: sinkStep.id });
    for (const item of items) await this.placeHome(w, item, topic, { kind: "sink", ownerIfNew: relayGoal.ownerId });
    this.finishWork(w);
    await this.writeWork(w);
  }

  /** Run the sink of each of `ids` that has one and is now done or skipped. */
  private async sinkAfter(relayGoal: Goal, steps: readonly Step[], ids: Iterable<string>, now: number): Promise<void> {
    if (relayGoal.sink) return;
    const byId = new Map(steps.map((s) => [s.id, s] as const));
    for (const id of new Set(ids)) {
      const s = byId.get(id);
      if (s?.policy?.sink && (s.state === "done" || s.state === "skipped")) await this.runSink(relayGoal, s, steps, now);
    }
  }

  /** RL-10: every clean-audit goal that is not dropped (any repo; read once per fold or record). */
  private async cleanAuditGoals(): Promise<Goal[]> {
    return (await this.store.listGoals()).filter((g) => g.sink !== undefined && g.state !== "dropped");
  }

  /** The live finding steps of `(lineage, fp)` (RL-10: in every clean-audit goal that is not dropped, moved-away steps left out); one fingerprint. */
  private async findingStepsOf(lineage: string, fp: string): Promise<{ goal: Goal; step: Step }[]> {
    const out: { goal: Goal; step: Step }[] = [];
    for (const goal of await this.cleanAuditGoals()) {
      const step = await this.store.getStep(`${goal.id}.${findingStepId(lineage, fp)}`);
      if (step?.finding?.lineage === lineage && step.finding.fp === fp && !isMovedAway(step)) out.push({ goal, step });
    }
    return out;
  }

  /**
   * RL-10: the live finding steps of a lineage by fingerprint (one step list per clean-audit goal),
   * for a call that looks up many fingerprints (a fold, a batch of dispositions). The same steps
   * `findingStepsOf` finds, in the same order; a step closed later in the call keeps its read state
   * (each close reads the step again).
   */
  private async findingIndex(lineage: string): Promise<FindingIndex> {
    const out: FindingIndex = new Map();
    for (const goal of await this.cleanAuditGoals()) {
      for (const step of await this.store.listSteps({ goal: goal.id })) {
        const f = step.finding;
        if (f?.lineage !== lineage || step.id !== `${goal.id}.${findingStepId(lineage, f.fp)}` || isMovedAway(step)) continue;
        const hits = out.get(f.fp);
        if (hits) hits.push({ goal, step });
        else out.set(f.fp, [{ goal, step }]);
      }
    }
    return out;
  }

  /** Close a ready or blocked finding step (`done` or `dropped`), settle its goal and emit the events. */
  private async closeFinding(goal: Goal, step: Step, o: { state: "done" | "dropped"; summary: string; by: string; reason?: string | undefined }, now: number): Promise<void> {
    const steps = await this.store.listSteps({ goal: goal.id });
    const cur = steps.find((s) => s.id === step.id) ?? step;
    if (cur.state !== "ready" && cur.state !== "blocked") return;
    const closed: Step = { ...cur, state: o.state, summary: o.summary, ...(o.state === "done" ? { outcome: "done" as const } : {}), updatedAt: now };
    const all = steps.map((s) => (s.id === cur.id ? closed : s));
    const settled = settle(all, now, () => true);
    const ended = endOffersLeavingReady(steps, [closed, ...settled.changed.filter((s) => s.id !== closed.id)], now);
    await this.store.saveSteps(ended.steps);
    await this.emitOffersEnded({ userId: o.by }, ended.ended);
    if (o.state === "done") await this.emit({ at: now, type: "step.done", user: o.by, goal: goal.id, step: cur.id, payload: { summary: o.summary, by: o.by } });
    else await this.emit({ at: now, type: "step.dropped", user: o.by, goal: goal.id, step: cur.id, payload: { reason: o.reason, by: o.by } });
    for (const s of settled.changed) if (s.state === "ready") await this.emitReady(goal.id, s.id);
  }

  /** A note on a finding step (as `POST /v1/steps/:id/note`), with its `step.noted` event. */
  private async noteFinding(step: Step, text: string, by: string, now: number): Promise<void> {
    await this.store.addNote({ step: step.id, user: by, text, at: now });
    await this.emit({ at: now, type: "step.noted", user: by, goal: step.goal, step: step.id });
  }

  /** The item → step sync of a disposition (`dismissed` or `deferred`): ready or blocked steps drop, held ones get a note. */
  private async syncDisposition(lineage: string, fp: string, d: { disposition: string; reason: string }, decider: Decider, now: number, ix?: FindingIndex): Promise<void> {
    if (d.disposition !== "dismissed" && d.disposition !== "deferred") return;
    const text = `${d.disposition} by ${deciderText(decider)}: ${d.reason}`;
    for (const { goal, step } of ix ? (ix.get(fp) ?? []) : await this.findingStepsOf(lineage, fp)) {
      const by = decider.kind === "person" ? decider.user : goal.ownerId;
      if (step.state === "ready" || step.state === "blocked") await this.closeFinding(goal, step, { state: "dropped", summary: text, by, reason: d.disposition }, now);
      else if (HELD_OR_FAILED.has(step.state)) await this.noteFinding(step, text, by, now);
    }
  }

  /**
   * RL-10 fold move: `item.retargeted` per item whose target repo the fold changed, then retarget
   * step 3 for each (open steps moved, held ones noted), in the record's transaction.
   */
  private async foldMove(goal: Goal, auditStep: Step, lineage: string, retargeted: readonly { row: ItemRow; from: string; to: string }[], by: string, now: number): Promise<void> {
    for (const r of retargeted) {
      await this.emit({ at: now, type: "item.retargeted", user: by, goal: goal.id, step: auditStep.id, payload: { lineage, fp: r.row.fp, from: r.from, to: r.to, by } });
    }
    const w = this.newWork(auditStep.id, now, { fromStep: auditStep.id });
    const out = { moved: [] as { from: string; to: string }[], held: [] as string[] };
    for (const r of retargeted) await this.retargetSteps(w, r.row, r.to, undefined, out);
    this.finishWork(w);
    await this.writeWork(w);
  }

  /** The item → step sync of a complete raising record: resolved items close their steps; raised-again ones note done steps. */
  private async syncFold(lineage: string, auditStep: string, resolved: readonly string[], again: readonly string[], now: number): Promise<void> {
    if (!resolved.length && !again.length) return;
    const ix = await this.findingIndex(lineage);
    if (!ix.size) return;
    for (const fp of resolved) {
      for (const { goal, step } of ix.get(fp) ?? []) {
        const text = `resolved by ${auditStep}`;
        if (step.state === "ready" || step.state === "blocked") await this.closeFinding(goal, step, { state: "done", summary: text, by: goal.ownerId }, now);
        else if (HELD_OR_FAILED.has(step.state)) await this.noteFinding(step, text, goal.ownerId, now);
      }
    }
    for (const fp of again) {
      for (const { goal, step } of ix.get(fp) ?? []) {
        if (step.state === "done") await this.noteFinding(step, `raised again by ${auditStep}`, goal.ownerId, now);
      }
    }
  }

  /** The item → step sync of a reverted debrief disposition. */
  private async syncRevert(d: DispositionRow, next: ItemRow, debriefStep: string, by: string, now: number): Promise<void> {
    const filed = next.state === "accepted" && next.link !== undefined;
    if ((d.disposition === "dismissed" || d.disposition === "deferred") && filed) {
      // RL-10: only the home step of the topic of each goal whose step this disposition dropped
      // reopens (live and dropped), after the foreign-step check.
      const local = findingStepId(d.lineage, d.fp);
      const topics = new Set<string>();
      for (const g of await this.cleanAuditGoals()) {
        if (!g.sink || topics.has(g.sink.topic)) continue;
        const s = await this.store.getStep(`${g.id}.${local}`);
        if (s?.finding?.lineage === d.lineage && s.finding.fp === d.fp && HubService.droppedBy(s, d)) topics.add(g.sink.topic);
      }
      if (!topics.size) return;
      const w = this.newWork(debriefStep, now, { user: by });
      for (const topic of topics) await this.placeHome(w, { row: next, requires: [] }, topic, { kind: "revert", ownerIfNew: by, user: by });
      this.finishWork(w);
      await this.writeWork(w);
    } else if (d.disposition === "accepted" && !filed) {
      for (const { goal, step } of await this.findingStepsOf(d.lineage, d.fp)) {
        const text = `reverted by ${by}`;
        if (step.state === "ready" || step.state === "blocked") await this.closeFinding(goal, step, { state: "dropped", summary: text, by, reason: "reverted" }, now);
        else if (HELD_OR_FAILED.has(step.state)) await this.noteFinding(step, text, by, now);
      }
    }
  }

  /**
   * RL-10: whether a disposition's item → step sync dropped `step`, decided from the step itself (events
   * are pruned): still dropped, not moved away, last written at the disposition's time, with the
   * `<disposition> by …` summary `syncDisposition` writes. A later reopen and drop changes both.
   */
  private static droppedBy(step: Step, d: DispositionRow): boolean {
    return !isMovedAway(step) && step.state === "dropped" && step.updatedAt === d.at && (step.summary ?? "").startsWith(`${d.disposition} by `);
  }

  /** The 400s of a sink topic (as `mesh topic`); returns the topic name. */
  private async sinkTopic(raw: string): Promise<string> {
    const name = topicName(raw);
    if (name === ALL_TOPIC || !(await this.store.getTopic(name))) throw new HubError(400, `unknown topic ${name} (define with: mesh topic add <name>)`);
    return name;
  }

  /** Check every sink topic of a plan's steps and store it as a topic name. */
  private async checkSinkTopics(steps: PlanStep[]): Promise<void> {
    for (const s of steps) if (s.sink) s.sink = { topic: await this.sinkTopic(s.sink.topic) };
  }

  /** `POST /v1/goals/:id/drop`: a person ends a goal (its owner, an approver or an admin); no step may be held. */
  async dropGoalByPerson(actor: Actor, id: string, reason: string | undefined): Promise<Goal> {
    return await this.goalTx(async () => {
      const goal = await this.goalOr404(id);
      if (!canApprove(actor, goal.ownerId)) throw new HubError(403, `only the goal owner, approvers or admins can drop ${goal.id}`);
      if (goal.state === "done" || goal.state === "dropped") throw new HubError(409, `${goal.id} is ${goal.state}`);
      const held = (await this.store.listSteps({ goal: goal.id })).filter((s) => s.state === "claimed" || s.state === "paused").map((s) => s.id);
      if (held.length) throw new HubError(409, `${goal.id} has held steps: ${held.join(", ")}; release them first`);
      await this.dropGoal(goal.id, "person", this.now(), { by: actor.userId, comment: reason });
      return (await this.store.getGoal(goal.id)) ?? goal;
    });
  }

  /** The newest goal of a lineage (largest `createdAt`, then goal number): a goal with a review record of it. */
  private async newestGoalOf(lineage: string): Promise<Goal | undefined> {
    let newest: Goal | undefined;
    const goalIds = new Set((await this.store.listReviews({ lineage })).map((r) => r.goal));
    for (const gid of goalIds) {
      const g = await this.store.getGoal(gid);
      if (g && (!newest || g.createdAt > newest.createdAt || (g.createdAt === newest.createdAt && goalSeq(g.id) > goalSeq(newest.id)))) newest = g;
    }
    return newest;
  }

  /**
   * `POST /v1/items/sink`: add a lineage's filed items to the clean-audit goals of (target repo,
   * topic) (backfill, no deps). RL-10: grouped by target repo, one `goals` entry per repo.
   */
  async sinkItems(actor: Actor, b: SinkRequest): Promise<SinkResult> {
    return await this.goalTx(async () => {
      const topic = await this.sinkTopic(b.topic);
      const repo = lineageRepo(b.lineage);
      const existing = await this.cleanAuditGoal(repo, topic);
      const items = await this.filedItems(b.lineage);
      const newest = await this.newestGoalOf(b.lineage);
      let allowed = actor.roles.includes("admin") || actor.userId === newest?.ownerId || actor.userId === existing?.ownerId;
      for (const r of new Set(items.map((i) => targetRepo(i.row)))) {
        if (allowed) break;
        if (r !== repo && (await this.cleanAuditGoal(r, topic))?.ownerId === actor.userId) allowed = true;
      }
      if (!allowed) throw new HubError(403, `only an admin, the owner of the lineage's newest goal or of ${existing?.id ?? "the clean-audit goal"} can sink ${b.lineage}`);
      const minRank = b.min_severity ? SEVERITY_RANK[b.min_severity] : undefined;
      const selected = items.filter((i) => minRank === undefined || SEVERITY_RANK[i.row.severity] <= minRank);
      const w = this.newWork("mesh items sink", this.now());
      for (const item of selected) await this.placeHome(w, item, topic, { kind: "backfill", ownerIfNew: actor.userId });
      this.finishWork(w);
      const render = b.dry_run ? HubService.renderDry(w, "sink") : await this.writeWork(w);
      const repos = [...new Set(selected.map((i) => targetRepo(i.row)))].sort((x, y) => (x < y ? -1 : x > y ? 1 : 0));
      const goals = repos.map((r) => {
        const gid = w.byKey.get(`${r}\u0000${topic}`);
        const wg = gid !== undefined ? w.goals.get(gid) : undefined;
        return { goal: wg?.goal?.id ?? null, repo: r, added: (wg?.added ?? []).map(render), reopened: (wg?.reopened ?? []).map(render) };
      });
      const goal = goals.length === 1 ? (goals[0] as { goal: string | null }).goal : goals.length === 0 ? (existing?.id ?? null) : null;
      const added = goals.flatMap((g) => g.added);
      const reopened = goals.flatMap((g) => g.reopened);
      return { goal, added, reopened, skipped: w.skipped, notes: w.notes.map((n) => render(n.text)), goals };
    });
  }

  /** `POST /v1/items/retarget` (RL-10): set the target repo of a lineage's items and move their open finding steps. */
  async retargetItems(actor: Actor, b: RetargetRequest): Promise<RetargetResult> {
    if ((b.fps ? 1 : 0) + (b.all ? 1 : 0) !== 1 || (b.repo !== undefined ? 1 : 0) + (b.from_key_path ? 1 : 0) !== 1) {
      throw new HubError(400, "retarget needs fps or all, and repo or from_key_path");
    }
    return await this.goalTx(async () => {
      const lineage = b.lineage;
      const rows = await this.store.listItems(lineage);
      if (!rows.length) throw new HubError(404, `no items in ${lineage}`);
      const byFp = new Map(rows.map((r) => [r.fp, r] as const));
      const fps = b.fps ? [...new Set(b.fps)] : undefined;
      for (const fp of fps ?? []) if (!byFp.has(fp)) throw new HubError(404, `unknown item ${fp} in ${lineage}`);
      const w = this.newWork("mesh items retarget", this.now(), { user: actor.userId });
      let allowed = actor.roles.includes("admin") || actor.userId === (await this.newestGoalOf(lineage))?.ownerId;
      if (!allowed) {
        // The clean-audit goals and their steps are read once, into the work the retarget then uses.
        await this.loadAllTopics(w);
        allowed = [...w.goals.values()].some((wg) => wg.owner === actor.userId && [...wg.all.values()].some((s) => s.finding?.lineage === lineage && !isMovedAway(s)));
      }
      if (!allowed) throw new HubError(403, `only an admin, the owner of the lineage's newest goal or of a clean-audit goal with its steps can retarget ${lineage}`);
      const selected = fps ? fps.map((fp) => byFp.get(fp) as ItemRow) : [...rows].sort(byItemOrder);
      const items: { fp: string; from: string; to: string }[] = [];
      const out = { moved: [] as { from: string; to: string }[], held: [] as string[] };
      const saves: ItemRow[] = [];
      for (const row of selected) {
        let to: string;
        if (b.repo !== undefined) to = b.repo.trim();
        else {
          const k = keyPathRepo(row.path);
          const ok = "repo" in k ? TargetRepo.safeParse(k.repo) : undefined;
          if (!ok?.success) {
            w.resultNotes.push("note" in k && k.note === "none" ? `${row.fp}: no key path` : `${row.fp}: key path ${row.path ?? ""} is not a repo name`);
            continue;
          }
          to = ok.data;
        }
        const from = targetRepo(row);
        let cur = row;
        if (to !== from) {
          cur = { ...row, repo: to };
          saves.push(cur);
          items.push({ fp: row.fp, from, to });
        }
        await this.retargetSteps(w, cur, to, actor.userId, out);
      }
      this.finishWork(w);
      let render: (text: string) => string;
      if (b.dry_run) render = HubService.renderDry(w, "retarget");
      else {
        for (const row of saves) await this.store.saveItem(row);
        for (const it of items) {
          await this.emit({ at: w.now, type: "item.retargeted", user: actor.userId, payload: { lineage, fp: it.fp, from: it.from, to: it.to, by: actor.userId } });
        }
        render = await this.writeWork(w);
      }
      return { items, moved: out.moved.map((m) => ({ from: render(m.from), to: render(m.to) })), held: out.held, notes: w.resultNotes.map(render) };
    });
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
    // RL-24: while the fleet is paused no attempt is made, and a slot whose window ends is missed for it.
    const paused = await this.store.getFleetPause();
    if (s.until !== undefined && now >= s.until) {
      const last = s.tried.at(-1);
      const reason: SlotReason = paused ? "fleet_paused" : !last ? "no_machine" : last.outcome === "capacity" ? "capacity" : last.outcome === "accepted" ? "expired" : "not_accepted";
      if (rs?.offer?.state === "offered") await this.withdrawOffer({ userId: p.owner }, rs, "pulse: slot missed");
      await this.dropGoal(goal.id, "missed", now);
      s = { ...s, state: "missed", reason, decidedAt: now };
      await this.store.saveSlot(s);
      await this.emit({ type: "pulse.missed", goal: goal.id, payload: { pulse: p.id, slot: s.slot, reason, tried: s.tried.length } });
      if (paused) await this.countForPause(paused, "missed");
      return s;
    }
    if (o.attempt && !paused && rs?.state === "ready") s = await this.attempt(s, p, goal, rs, now);
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
  private async fireSlot(p: Pulse, slotId: string, at: number, now: number, o: { manual?: boolean; by?: string; via?: string | undefined; catchUp?: boolean; trial?: boolean }): Promise<PulseSlot> {
    const base: PulseSlot = {
      pulse: p.id,
      slot: slotId,
      at,
      state: "fired",
      ...(o.manual ? { manual: true as const, ...(o.by !== undefined ? { by: o.by } : {}) } : {}),
      ...(o.catchUp ? { catchUp: true as const } : {}),
      ...(o.trial ? { trial: true as const } : {}),
      tried: [],
      decidedAt: now,
    };
    if (!(await this.store.addSlot(base))) return (await this.store.getSlot(p.id, slotId)) ?? base;
    // Retire: pending slots whose window is over end now (their goals dropped).
    for (const s of await this.store.listSlots({ pulse: p.id, pending: true })) {
      if (s.slot !== slotId) await this.advanceSlot(s, p, now, { attempt: false });
    }
    // RL-15: under supersede a non-trial fire supersedes waiting goals instead of abandoning them.
    const supersedes = p.overlap === "supersede" && !o.trial;
    // Abandon: started goals older than maxGoalAge.
    for (const s of await this.store.listSlots({ pulse: p.id, state: "fired" })) {
      if (s.slot === slotId || s.startedAt === undefined || s.goal === undefined) continue;
      const g = await this.store.getGoal(s.goal);
      if (!g || g.state === "done" || g.state === "dropped" || now - g.createdAt < p.maxGoalAgeMs) continue;
      if (supersedes && (await this.waitingGoal(g))) continue;
      await this.dropGoal(g.id, "abandoned", now);
      await this.store.saveSlot({ ...s, state: "abandoned", reason: "max_goal_age", decidedAt: now });
      await this.emit({ type: "pulse.abandoned", goal: g.id, payload: { pulse: p.id, slot: s.slot } });
    }
    // Overlap. RL-15: a trial fire applies `skip` under `queue` and `supersede`.
    const policy = o.trial && (p.overlap === "queue" || p.overlap === "supersede") ? "skip" : p.overlap;
    if (policy !== "allow") {
      const running = await this.runningGoal(p, slotId);
      if (running !== undefined) {
        if (policy === "queue") {
          await this.replaceQueued(p, slotId, now, slotId);
          const queued: PulseSlot = { ...base, state: "queued", queued: true, running };
          await this.store.saveSlot(queued);
          await this.emit({ type: "pulse.queued", ...(o.manual && o.by !== undefined ? { user: o.by } : {}), payload: { pulse: p.id, slot: slotId, running } });
          return queued;
        }
        const skipped: PulseSlot = { ...base, state: "skipped", reason: "overlap", running };
        await this.store.saveSlot(skipped);
        await this.emit({ type: "pulse.skipped", payload: { pulse: p.id, slot: slotId, reason: "overlap", running } });
        return skipped;
      }
    }
    // RL-15: a non-trial fire that creates a goal replaces a queued slot.
    if (p.overlap === "queue" && !o.trial) await this.replaceQueued(p, slotId, now, slotId);
    let slot: PulseSlot = base;
    if (supersedes) {
      const sup = await this.supersede(p, slotId, now);
      slot = { ...slot, ...(sup.goals.length ? { superseded: sup.goals } : {}), ...(sup.carry.length ? { carry: sup.carry } : {}) };
    }
    return await this.slotGoal(p, slot, now, { ...o, from: o.manual || o.catchUp ? now : at });
  }

  /** Create a slot's goal, save the fired slot, emit `pulse.fired` and make one attempt (inside the pulse's transaction). */
  private async slotGoal(p: Pulse, base: PulseSlot, now: number, o: { manual?: boolean | undefined; by?: string | undefined; via?: string | undefined; catchUp?: boolean | undefined; trial?: boolean | undefined; queued?: boolean; from: number }): Promise<PulseSlot> {
    const slotId = base.slot;
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
        extra: { pulse: p.id, slot: slotId, ...(o.trial ? { trial: true } : {}) },
        ...(o.trial ? { trial: true } : {}),
      },
      now,
    );
    let slot: PulseSlot = { ...base, state: "fired", decidedAt: now, goal: goal.id, firedAt: now, until: o.from + p.windowMs };
    await this.store.saveSlot(slot);
    await this.emit({
      type: "pulse.fired",
      ...(o.manual && o.by !== undefined && !o.queued ? { user: o.by } : {}),
      goal: goal.id,
      payload: {
        pulse: p.id,
        slot: slotId,
        ...(o.manual ? { manual: true } : {}),
        ...(o.catchUp ? { catchUp: true } : {}),
        ...(o.trial ? { trial: true } : {}),
        ...(o.queued ? { queued: true } : {}),
        ...(o.via ? { via: o.via } : {}),
      },
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

  /**
   * RL-3/RL-15: the running goal of a pulse: the first open, non-trial goal of a `fired` slot other
   * than `exceptSlot`, in slot order, that has machine work (`overlapBusy`).
   */
  private async runningGoal(p: Pulse, exceptSlot: string): Promise<string | undefined> {
    for (const s of await this.store.listSlots({ pulse: p.id, state: "fired" })) {
      if (s.slot === exceptSlot || s.goal === undefined) continue;
      const g = await this.store.getGoal(s.goal);
      // RL-11: a trial goal never blocks a slot.
      if (!g || g.state === "done" || g.state === "dropped" || g.trial === true) continue;
      // Only machine work blocks: a goal parked on its owner (a debrief, an interactive step) does not.
      if (overlapBusy(await this.store.listSteps({ goal: g.id }), await this.runStepOf(g)) !== undefined) return g.id;
    }
    return undefined;
  }

  /** RL-15: an open goal (trial or not) with no machine work and no held step: it only waits on people. */
  private async waitingGoal(g: Goal): Promise<boolean> {
    if (g.state === "done" || g.state === "dropped") return false;
    const steps = await this.store.listSteps({ goal: g.id });
    if (steps.some((x) => x.state === "claimed" || x.state === "paused")) return false;
    return overlapBusy(steps, await this.runStepOf(g)) === undefined;
  }

  /** RL-15: the queued slots of a pulse other than `except` become `skipped` (reason overlap). */
  private async replaceQueued(p: Pulse, except: string | undefined, now: number, replacedBy: string | undefined): Promise<void> {
    for (const q of await this.store.listSlots({ pulse: p.id, state: "queued" })) {
      if (q.slot === except) continue;
      await this.store.saveSlot({ ...q, state: "skipped", reason: "overlap", decidedAt: now });
      await this.emit({
        type: "pulse.skipped",
        payload: { pulse: p.id, slot: q.slot, reason: "overlap", ...(q.running !== undefined ? { running: q.running } : {}), ...(replacedBy !== undefined ? { replacedBy } : {}) },
      });
    }
  }

  /**
   * RL-15 supersede (inside the pulse's transaction): every waiting goal of a fired slot of the pulse
   * other than `slotId` carries its undecided debrief items, sinks what it filed, and is dropped.
   */
  private async supersede(p: Pulse, slotId: string, now: number): Promise<{ goals: string[]; carry: Carry[] }> {
    const goals: string[] = [];
    const carry = new Map<string, { step: string; lineage: string; rows: Map<string, ItemRow> }>();
    for (const s of await this.store.listSlots({ pulse: p.id, state: "fired" })) {
      if (s.slot === slotId || s.goal === undefined) continue;
      const g = await this.store.getGoal(s.goal);
      if (!g || !(await this.waitingGoal(g))) continue;
      const steps = await this.store.listSteps({ goal: g.id });
      for (const d of steps) {
        if (!isDebrief(d.policy) || d.state === "done" || d.state === "skipped" || d.state === "dropped") continue;
        const set = await this.debriefSet(d, g, steps);
        if (!set.lineage) continue;
        const consumes: readonly ItemState[] = d.policy?.consumes ?? DEBRIEF_CONSUMES;
        const key = `${local(d)}\n${set.lineage}`;
        const entry = carry.get(key) ?? { step: local(d), lineage: set.lineage, rows: new Map<string, ItemRow>() };
        for (const fp of set.fps) {
          const row = await this.store.getItem(set.lineage, fp);
          if (row && consumes.includes(row.state)) entry.rows.set(fp, row);
        }
        carry.set(key, entry);
      }
      for (const x of steps) {
        if (!x.policy?.sink || x.state === "done" || x.state === "skipped" || x.state === "dropped" || x.state === "failed") continue;
        await this.runSink(g, x, steps, now);
      }
      await this.dropGoal(g.id, "superseded", now);
      await this.emit({ type: "pulse.superseded", goal: g.id, payload: { pulse: p.id, slot: slotId, goal: g.id, from: s.slot } });
      goals.push(g.id);
    }
    const out: Carry[] = [];
    for (const e of carry.values()) {
      const fps = [...e.rows.values()].sort(byItemOrder).slice(0, 1000).map((r) => r.fp).sort();
      if (fps.length) out.push({ step: e.step, lineage: e.lineage, fps });
    }
    return { goals, carry: out };
  }

  /**
   * RL-15: the SLA debriefs (debriefs with `sla` in open, non-trial goals) that are breached at `now`,
   * with the assignee and the escalation user (the pulse owner, else the goal owner).
   */
  private async overdueDebriefs(goals: readonly Goal[], now: number): Promise<{ goal: Goal; step: Step; sla: NonNullable<ReturnType<typeof slaState>>; assignee: string; owner: string }[]> {
    const out: { goal: Goal; step: Step; sla: NonNullable<ReturnType<typeof slaState>>; assignee: string; owner: string }[] = [];
    const byGoal = new Map(goals.map((g) => [g.id, g] as const));
    for (const state of ["ready", "claimed", "paused"] as const) {
      for (const st of await this.store.listSteps({ state })) {
        if (!isDebrief(st.policy) || st.policy?.sla === undefined) continue;
        const goal = byGoal.get(st.goal) ?? (await this.store.getGoal(st.goal));
        if (!goal || goal.state === "done" || goal.state === "dropped" || goal.trial === true) continue;
        const steps = await this.store.listSteps({ goal: goal.id });
        const sla = slaState(st, new Map(steps.map((x) => [x.id, x] as const)), await this.store.listPlans(goal.id), now);
        if (!sla?.breached) continue;
        out.push({ goal, step: st, sla, assignee: debriefAssignee(st.policy, goal.ownerId), owner: await this.escalationUser(goal) });
      }
    }
    return out;
  }

  /** RL-15: who an overdue debrief escalates to: its goal's pulse owner, else the goal owner. */
  private async escalationUser(goal: Goal): Promise<string> {
    const pulse = goal.refs?.pulse !== undefined ? await this.store.getPulse(goal.refs.pulse) : undefined;
    return pulse?.owner ?? goal.ownerId;
  }

  /** RL-15 tick: `debrief.overdue` once per cycle and level, and the auto-accept of ready debriefs. */
  private async debriefSlaTick(now: number): Promise<void> {
    const ids: string[] = [];
    for (const state of ["ready", "claimed", "paused"] as const) {
      for (const st of await this.store.listSteps({ state })) if (isDebrief(st.policy) && st.policy?.sla !== undefined) ids.push(st.id);
    }
    for (const id of ids) {
      try {
        await this.goalTx(async () => {
          const step = await this.store.getStep(id);
          if (!step || !isDebrief(step.policy) || step.policy?.sla === undefined) return;
          const goal = await this.store.getGoal(step.goal);
          if (!goal || goal.state === "done" || goal.state === "dropped" || goal.trial === true) return;
          const steps = await this.store.listSteps({ goal: goal.id });
          const sla = slaState(step, new Map(steps.map((x) => [x.id, x] as const)), await this.store.listPlans(goal.id), now);
          if (!sla) return;
          const prev = step.overdue;
          let next = prev?.since === sla.since ? { ...prev } : { since: sla.since };
          const round = (step.rounds?.length ?? 0) + 1;
          const assignee = debriefAssignee(step.policy, goal.ownerId);
          const owner = await this.escalationUser(goal);
          const base = { round, since: sla.since, slaMs: sla.slaMs };
          if (sla.breached && next.assigneeAt === undefined) {
            next = { ...next, assigneeAt: now };
            await this.emit({ type: "debrief.overdue", goal: goal.id, step: step.id, payload: { to: "assignee", user: assignee, ...base, dueAt: sla.dueAt } });
          }
          if (sla.escalated && next.ownerAt === undefined && owner !== assignee) {
            next = { ...next, ownerAt: now };
            await this.emit({ type: "debrief.overdue", goal: goal.id, step: step.id, payload: { to: "owner", user: owner, ...base, dueAt: sla.escalateAt } });
          }
          if (sla.breached && step.state === "ready" && step.policy.auto_accept?.length) {
            if ((await this.autoAccept(step, goal, steps, now)) > 0) next = { ...next, autoAt: now };
          }
          if (JSON.stringify(next) !== JSON.stringify(prev)) {
            const cur = (await this.store.getStep(id)) ?? step;
            await this.store.saveStepIf({ ...cur, overdue: next }, cur);
          }
        });
      } catch (e) {
        process.stderr.write(`hub tick failed: ${errorText(e)}\n`);
      }
    }
  }

  /**
   * RL-15 auto-accept (inside `goalTx`): accept each debrief item that is `confirmed`, at a severity of
   * `auto_accept`, whose latest disposition is an agent's `confirmed`, and that this step never
   * auto-accepted before. Returns how many were accepted.
   */
  private async autoAccept(step: Step, goal: Goal, steps: readonly Step[], now: number): Promise<number> {
    const p = step.policy;
    const severities: readonly string[] = p?.auto_accept ?? [];
    const set = await this.debriefSet(step, goal, steps);
    if (!set.lineage) return 0;
    const lineage = set.lineage;
    const consumes: readonly ItemState[] = p?.consumes ?? DEBRIEF_CONSUMES;
    const rows = (await this.rowsOf(lineage, set.fps)).filter((r) => consumes.includes(r.state)).sort(byItemOrder);
    const round = (step.rounds?.length ?? 0) + 1;
    let n = 0;
    for (const row of rows) {
      if (row.state !== "confirmed" || !severities.includes(row.severity)) continue;
      const history = await this.store.itemHistory(lineage, row.fp);
      if (history.some((e) => e.kind === "disposition" && e.via === "auto-accept" && e.step === step.id)) continue;
      const last = history.filter((e) => e.kind === "disposition").at(-1);
      if (last?.kind !== "disposition" || last.disposition !== "confirmed" || last.decider.kind !== "agent") continue;
      const reason = `accepted after the debrief SLA (${p?.sla ?? ""}): confirmed by ${last.decider.key} at ${row.severity}`;
      await this.applyDisposition(lineage, row, { fingerprint: row.fp, disposition: "accepted", reason }, SLA_DECIDER, "auto-accept", { goal: goal.id, step: step.id, round, at: now });
      await this.store.addNote({ step: step.id, user: goal.ownerId, text: `auto-accept: accepted ${row.fp} "${row.title}": ${reason}`, at: now });
      await this.emit({ at: now, type: "step.noted", user: goal.ownerId, goal: goal.id, step: step.id });
      await this.emit({ at: now, type: "item.disposed", goal: goal.id, step: step.id, payload: { lineage, fp: row.fp, disposition: "accepted", from: row.state, decider: "agent", via: "auto-accept", round } });
      n++;
    }
    if (n > 0) await this.emit({ at: now, type: "debrief.auto_accepted", goal: goal.id, step: step.id, payload: { round, items: n } });
    return n;
  }

  /** RL-15 release (one transaction per slot): a queued slot fires once no goal of its pulse is running. */
  private async releaseQueued(now: number): Promise<void> {
    for (const seen of await this.store.listSlots({ state: "queued" })) {
      try {
        await this.goalTx(async () => {
          const s = await this.store.getSlot(seen.pulse, seen.slot);
          if (!s || s.state !== "queued") return;
          const p = await this.store.getPulse(s.pulse);
          if (!p || p.deletedAt !== undefined || p.overlap !== "queue") {
            const fake = p ?? ({ id: s.pulse } as Pulse);
            await this.replaceQueued(fake, undefined, now, undefined);
            return;
          }
          const owner = await this.store.getUser(p.owner);
          if (!owner || !owner.roles.some((r) => r === "member" || r === "approver" || r === "admin")) return;
          if (!p.enabled) return;
          if ((await this.runningGoal(p, s.slot)) !== undefined) return;
          // RL-24: a queued slot released while the fleet is paused is skipped (no goal).
          const paused = await this.store.getFleetPause();
          if (paused) {
            const { running: _r, ...rest } = s;
            await this.skipForPause(paused, { ...rest, state: "skipped", reason: "fleet_paused", decidedAt: now }, "save");
            return;
          }
          await this.slotGoal(p, s, now, { manual: s.manual === true, ...(s.by !== undefined ? { by: s.by } : {}), queued: true, from: now });
        });
      } catch (e) {
        process.stderr.write(`hub tick failed: ${errorText(e)}\n`);
      }
    }
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
        // RL-24: while the fleet is paused the slot that would fire is skipped instead (no goal, no catch-up later).
        const paused = await this.store.getFleetPause();
        if (paused) await this.skipForPause(paused, { pulse: p.id, slot, at: last, state: "skipped", reason: "fleet_paused", ...(inWindow ? {} : { catchUp: true as const }), tried: [], decidedAt: now }, "add");
        else await this.fireSlot(p, slot, last, now, inWindow ? {} : { catchUp: true });
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
      // RL-7: `invalid` (front matter that is not valid YAML) is carried like the other fields.
      const frontOf = ({ description, model, tools, rules, invalid }: AgentFront): AgentFront => ({
        ...(description !== undefined ? { description } : {}),
        ...(model !== undefined ? { model } : {}),
        ...(tools !== undefined ? { tools } : {}),
        ...(rules !== undefined ? { rules } : {}),
        ...(invalid !== undefined ? { invalid } : {}),
      });
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
        merged.set(mk, {
          name: row.name,
          machines: new Set([row.machine]),
          front: frontOf(row),
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
        entries.push({
          name: d.name,
          machines: new Set(),
          front: frontOf(d),
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
          invalid: versions.some((v) => v.invalid !== undefined),
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
        // RL-21: also a step run headless by the assign (run-held).
        const ended =
          !(await this.runHeld(s, hs)) && hs?.session.state === "ended" && hs.session.endedReason !== "clear" && now - (hs.session.endedAt ?? 0) > this.config.thresholds.pauseGraceMs;
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
    // RL-15: debrief SLAs.
    await this.debriefSlaTick(now);
    // RL-3: end or retry pending pulse slots first, then fire due pulses. RL-15: queued slots in between.
    await this.advancePending(now);
    await this.releaseQueued(now);
    await this.fireDue(now);
  }

  // ---------- fleet pause (RL-24) ----------

  /** This replica's copy of the fleet pause, for the probes only (enforcement reads the store). */
  private pauseCache: FleetPause | null = null;

  /** RL-24: the fleet pause as `/healthz` shows it (no database read). */
  pausedView(): FleetPause | null {
    return this.pauseCache;
  }

  /** RL-24: re-read the fleet pause into this replica's copy (one primary-key read). */
  async refreshPause(): Promise<void> {
    this.pauseCache = HubService.pauseOf(await this.store.getFleetPause());
  }

  private static pauseOf(row: FleetPauseRow | undefined): FleetPause | null {
    if (!row) return null;
    const { held: _h, skipped: _s, missed: _m, ...pause } = row;
    return pause;
  }

  private static refuseNotAdmin(actor: Actor): void {
    if (!actor.roles.includes("admin")) throw refuse(403, "not-admin", "fleet pause and resume are for admins");
  }

  /** RL-24: the refusal of an offer, accept or fire while the fleet is paused. */
  private static fleetPaused(row: FleetPauseRow): HubError {
    return refuse(409, "fleet-paused", `the fleet is paused since ${new Date(row.since).toISOString()} by ${row.by}: ${row.reason}; an admin resumes it (mesh fleet resume)`);
  }

  /** RL-24 (inside `goalTx`): while the fleet is paused, add these steps to its held list; false when not paused. */
  private async holdForPause(ids: readonly string[]): Promise<boolean> {
    const row = await this.store.getFleetPause();
    if (!row) return false;
    const held = [...row.held];
    for (const id of ids) if (!held.includes(id)) held.push(id);
    if (held.length !== row.held.length) await this.store.setFleetPause({ ...row, held }, this.now());
    return true;
  }

  /** RL-24 (inside `goalTx`): count a slot recorded skipped or missed for the pause. */
  private async countForPause(row: FleetPauseRow, field: "skipped" | "missed"): Promise<void> {
    await this.store.setFleetPause({ ...row, [field]: row[field] + 1 }, this.now());
  }

  /** RL-24 (inside `goalTx`): record a slot skipped for the pause (a new row, or a queued one saved), count it and emit `pulse.skipped`. */
  private async skipForPause(row: FleetPauseRow, slot: PulseSlot, how: "add" | "save"): Promise<void> {
    if (how === "add") {
      if (!(await this.store.addSlot(slot))) return;
    } else {
      await this.store.saveSlot(slot);
    }
    await this.countForPause(row, "skipped");
    await this.emit({ type: "pulse.skipped", payload: { pulse: slot.pulse, slot: slot.slot, reason: "fleet_paused" } });
  }

  /**
   * RL-24 `POST /v1/fleet/pause`: store the pause and withdraw every open headless offer (each step
   * is held for the resume). A withdrawn run step offer of a pending pulse slot loses its undecided
   * try, so that machine stays a candidate after the resume.
   */
  async pauseFleet(actor: Actor, req: FleetPauseRequest): Promise<FleetState> {
    HubService.refuseNotAdmin(actor);
    return await this.goalTx(async () => {
      const cur = await this.store.getFleetPause();
      if (cur) throw refuse(409, "fleet-already-paused", `the fleet is already paused since ${new Date(cur.since).toISOString()} by ${cur.by}: ${cur.reason}`);
      const now = this.now();
      const row: FleetPauseRow = { since: now, by: actor.userId, ...viaOf(actor), reason: req.reason, held: [], skipped: 0, missed: 0 };
      for (const s of await this.store.listSteps({ state: "ready" })) {
        const o = s.offer;
        if (o?.state !== "offered" || (o.mode !== "headless" && s.policy?.mode !== "headless")) continue;
        const slot = await this.pendingSlotOf(await this.store.getGoal(s.goal), s);
        await this.withdrawOffer(actor, s, "fleet paused");
        if (!row.held.includes(s.id)) row.held.push(s.id);
        const last = slot?.tried.at(-1);
        if (slot && last && last.outcome === undefined && last.machine === o.to.machine) await this.store.saveSlot({ ...slot, tried: slot.tried.slice(0, -1) });
      }
      await this.store.setFleetPause(row, now);
      await this.emit({ type: "fleet.paused", user: actor.userId, payload: { reason: req.reason, withdrawn: row.held.length, ...viaOf(actor) } });
      const view = HubService.pauseOf(row);
      this.store.afterCommit(() => {
        this.pauseCache = view;
      });
      return { paused: view, withdrawn: row.held.length };
    });
  }

  /**
   * RL-24 `POST /v1/fleet/resume`: clear the pause and offer again, by stick, the steps it held back
   * (not a pulse goal's run step: the slot's next attempt offers it). Nothing is fired.
   */
  async resumeFleet(actor: Actor, req: FleetResumeRequest): Promise<FleetState> {
    HubService.refuseNotAdmin(actor);
    await this.goalTx(async () => {
      const row = await this.store.getFleetPause();
      if (!row) throw refuse(409, "fleet-not-paused", "the fleet is not paused");
      await this.store.setFleetPause(undefined, this.now());
      for (const id of row.held) {
        const s = await this.store.getStep(id);
        const goal = s ? await this.store.getGoal(s.goal) : undefined;
        if (!s || !goal?.stick || goal.state === "done" || goal.state === "dropped") continue;
        if (goal.refs?.pulse !== undefined && (await this.runStepOf(goal)) === s.id) continue;
        await this.stickOffer(goal, s);
      }
      await this.emit({
        type: "fleet.resumed",
        user: actor.userId,
        payload: { pausedAt: row.since, pausedBy: row.by, skipped: row.skipped, missed: row.missed, ...(req.reason ? { reason: req.reason } : {}), ...viaOf(actor) },
      });
      this.store.afterCommit(() => {
        this.pauseCache = null;
      });
    });
    return { paused: null };
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
      if (payload.reason === "refiled") return `${s} reopened: its finding was filed again (fix cycle ${String(payload.fixCycles)})`;
      if (payload.reason === "reverted") return `${s} reopened: a dismissal was reverted (fix cycle ${String(payload.fixCycles)})`;
      if (payload.reason === "moved") return `${s} reopened: its finding was moved here (fix cycle ${String(payload.fixCycles)})`;
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
      if (payload.reason === "person") return `${s} dropped: its goal was dropped`;
      if (payload.reason === "dismissed") return `${s} dropped: its finding was dismissed`;
      if (payload.reason === "deferred") return `${s} dropped: its finding was deferred`;
      if (payload.reason === "reverted") return `${s} dropped: its filing was reverted`;
      if (payload.reason === "moved") return `${s} moved to ${String(payload.to)}`;
      return `${s} dropped by a new plan`;
    case "goal.dropped":
      return `${s} dropped (${String(payload.reason)})`;
    // RL-9: clean-audit goals.
    case "goal.sunk": {
      const added = (payload.added as unknown[] | undefined)?.length ?? 0;
      const reopened = (payload.reopened as unknown[] | undefined)?.length ?? 0;
      return `${added + reopened} findings from ${String(payload.from)} (${reopened} reopened)`;
    }
    case "goal.sink_failed":
      return `sink of ${String(payload.from)} failed: ${String(payload.reason)}`;
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
    // RL-10: fp and repo only.
    case "item.retargeted":
      return `retargeted item ${String(payload.fp)} to ${String(payload.to)}`;
    case "step.read":
      return `read the pre-read of ${s}`;
    // RL-6: calibration (key, hash12 and counts only).
    case "calibration.opened":
      return `opened calibration of ${String(payload.key)}@${String(payload.hash ?? "").slice(0, 12)} (${String(payload.dismissals)} dismissals)`;
    case "calibration.done":
      return `calibration of ${String(payload.key)}@${String(payload.hash ?? "").slice(0, 12)} done: ${String(payload.outcome)}`;
    // RL-18: spot checks (key, hash12, sample number, fp and values only).
    case "spot-check.opened":
      return `opened spot check ${String(payload.sample)} of ${String(payload.key)}@${String(payload.hash ?? "").slice(0, 12)} (${String(payload.disposition)} ${String(payload.fp)})`;
    case "spot-check.decided":
      return `spot check ${String(payload.sample)} of ${String(payload.key)}@${String(payload.hash ?? "").slice(0, 12)}: ${String(payload.verdict)}`;
    default:
      return `${type.replace(".", " ")} ${s}`.trim();
  }
}

/**
 * RL-14: the held rule (as `runs.ts` decides a run's step): `step` is claimed or paused, and its
 * holder is session `sid`, or it has no holder session and is held by `user` on `machine` (or on no
 * machine).
 */
export function heldBy(step: Step, sid: string, user: string, machine: string): boolean {
  if (step.state !== "claimed" && step.state !== "paused") return false;
  if (step.holderSid !== undefined) return step.holderSid === sid;
  return step.holderUser === user && (step.holderMachine === undefined || step.holderMachine === machine);
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

/** The sequence number of a goal id (`G<n>`); goals created later have higher numbers. */
function goalSeq(id: string): number {
  return Number(/^G(\d+)$/.exec(id)?.[1] ?? 0);
}

/** RL-12: the opaque cursor of a run card page: the position `(at, slot)` of the last card. */
const slotCursor = {
  encode: (k: { at: number; slot: string }): string => Buffer.from(JSON.stringify([k.at, k.slot]), "utf8").toString("base64url"),
  decode(s: string): { at: number; slot: string } | undefined {
    try {
      const v: unknown = JSON.parse(Buffer.from(s, "base64url").toString("utf8"));
      if (!Array.isArray(v) || v.length !== 2) return undefined;
      const [at, slot] = v as unknown[];
      // Only values a slot can hold reach SQL (an `at` that is not a whole number fails on Postgres).
      if (typeof at !== "number" || !Number.isSafeInteger(at) || at < 0 || typeof slot !== "string" || !PulseSlotSchema.shape.slot.safeParse(slot).success) return undefined;
      return { at, slot };
    } catch {
      return undefined;
    }
  },
};

/** RL-12: per-request caches of the reads cards and health repeat (goals, items, history, cards). */
class CardCtx {
  private goals = new Map<string, Goal | undefined>();
  private itemRows = new Map<string, Map<string, ItemRow>>();
  private hist = new Map<string, { fp: string; entry: ItemHistoryEntry }[]>();
  cards = new Map<string, RunCard>();
  private clean: Goal[] | undefined;
  /** Clean-audit goals that are not dropped (as `cleanAuditGoals`), read once. */
  async cleanGoals(store: HubStore): Promise<Goal[]> {
    this.clean ??= (await store.listGoals()).filter((g) => g.sink !== undefined && g.state !== "dropped");
    return this.clean;
  }
  async goal(store: HubStore, id: string): Promise<Goal | undefined> {
    if (!this.goals.has(id)) this.goals.set(id, await store.getGoal(id));
    return this.goals.get(id);
  }
  async items(store: HubStore, lineage: string): Promise<Map<string, ItemRow>> {
    let m = this.itemRows.get(lineage);
    if (!m) {
      m = new Map((await store.listItems(lineage)).map((r) => [r.fp, r] as const));
      this.itemRows.set(lineage, m);
    }
    return m;
  }
  async history(store: HubStore, lineage: string): Promise<{ fp: string; entry: ItemHistoryEntry }[]> {
    let h = this.hist.get(lineage);
    if (!h) {
      h = await store.lineageHistory(lineage);
      this.hist.set(lineage, h);
    }
    return h;
  }
}

/** RL-12: one stage of a run card. */
function stageCard(step: Step, byId: ReadonlyMap<string, Step>, plans: readonly Plan[], now: number): StageCard {
  const rounds = step.rounds ?? [];
  const runs = rounds.filter((r) => r.telemetry);
  const newestRun = runs.at(-1)?.telemetry;
  const agent = newestRun?.agentKey ?? step.policy?.agent;
  const last = rounds.at(-1);
  let costUsd: number | undefined;
  for (const r of runs) if (r.telemetry?.costUsdEstimate !== undefined) costUsd = (costUsd ?? 0) + r.telemetry.costUsdEstimate;
  return {
    step: step.id,
    kind: step.kind,
    mode: step.policy?.mode ?? "interactive",
    state: step.state,
    ...(step.holderUser !== undefined && (step.state === "claimed" || step.state === "paused") ? { holder: step.holderUser } : {}),
    ...(agent !== undefined ? { agent } : {}),
    rounds: rounds.length,
    ...(last ? { outcome: last.outcome, finishedAt: last.finishedAt } : {}),
    ...stageTimes(step, byId, plans, now),
    runs: runs.length,
    durationMs: runs.reduce((n, r) => n + (r.telemetry?.durationMs ?? 0), 0),
    turns: runs.reduce((n, r) => n + (r.telemetry?.turns ?? 0), 0),
    ...(costUsd !== undefined ? { costUsd } : {}),
    ...(newestRun ? { exit: newestRun.exit } : {}),
    ...(last?.commit !== undefined ? { commit: last.commit } : {}),
  };
}

/** RL-12: a card's change against the previous complete run. */
function cardDelta(cur: RunCard, prev: RunCard): NonNullable<RunCard["delta"]> {
  return {
    slot: prev.slot,
    goal: prev.goal as string,
    durationMs: cur.totals.durationMs - prev.totals.durationMs,
    turns: cur.totals.turns - prev.totals.turns,
    ...(cur.totals.costUsd !== undefined && prev.totals.costUsd !== undefined ? { costUsd: cur.totals.costUsd - prev.totals.costUsd } : {}),
    raised: (cur.items?.raised ?? 0) - (prev.items?.raised ?? 0),
    new: (cur.fold?.new ?? 0) - (prev.fold?.new ?? 0),
    regression: (cur.fold?.regression ?? 0) - (prev.fold?.regression ?? 0),
  };
}

function emptyFindings(): PulseHealth["findings"] {
  return { open: { S1: 0, S2: 0, S3: 0, S4: 0 }, accepted: { S1: 0, S2: 0, S3: 0, S4: 0 } };
}

/** RL-18: `byPeople / total`, 4 decimals; absent at 0 decisions. */
function decisionShare(d: { total: number; byPeople: number }): { humanDecisionShare?: number } {
  return d.total > 0 ? { humanDecisionShare: Math.round((d.byPeople / d.total) * 10_000) / 10_000 } : {};
}

function perAccepted(costUsd: number | undefined, accepted: number): { costPerAcceptedUsd?: number } {
  return costUsd !== undefined && accepted > 0 ? { costPerAcceptedUsd: Math.round((costUsd / accepted) * 10_000) / 10_000 } : {};
}
