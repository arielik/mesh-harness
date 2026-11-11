// Suggest (MM-4): rank machines for an offer. Pure: the hub passes machines and sessions in.

import type { Repo, Session, ShareLevel, Suggestion } from "../protocol/index.ts";
import { age } from "./fleet.ts";
import { acceptMatches, machineName, sessionName } from "./offers.ts";
import { repoMatches } from "./repo-id.ts";
import { sessionVisible } from "./visibility.ts";

export interface SuggestMachine {
  id: string;
  userId: string;
  hostname: string;
  nickname?: string | undefined;
  lastSeen: number;
  share?: ShareLevel | undefined;
  repos?: Repo[] | undefined;
  labels?: string[] | undefined;
  accept?: string[] | undefined;
}

export interface SuggestSession {
  userId: string;
  machineId: string;
  session: Session;
}

export interface SuggestInput {
  /** The caller's user id. */
  caller: string;
  /** The machine of the caller's token; absent for a cookie or a token without one. */
  callerMachine?: { id: string; userId: string; nickname?: string | undefined } | undefined;
  now: number;
  onlineMs: number;
  /** The subject repos (as stored on the steps) and topics. */
  repos: readonly string[];
  topics: readonly string[];
  any: boolean;
  /** The candidate machines: the caller's, or every machine with `team`. */
  machines: readonly SuggestMachine[];
  /** Nicknames of all the caller's machines. */
  callerNicknames: ReadonlySet<string>;
  /** Live hub sessions, unfiltered (visibility is applied here). */
  sessions: readonly SuggestSession[];
}

/** Code-point order, independent of the locale. */
function cmp(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** The repo name of a repo string: the part after its last `/`, lower-cased. */
export function repoName(r: string): string {
  return r.slice(r.lastIndexOf("/") + 1).toLowerCase();
}

/** The wanted labels: the topics and the repo name of each subject repo. */
export function wantedLabels(topics: readonly string[], repos: readonly string[]): Set<string> {
  return new Set([...topics, ...repos.map(repoName)]);
}

/** What to pass as `--to` for a machine: own → nickname, else id; another's → `<user>/<nickname>` when unambiguous, else id. */
export function suggestionTo(m: { id: string; userId: string; nickname?: string | undefined }, caller: string, callerNicknames: ReadonlySet<string>): string {
  if (m.userId === caller) return m.nickname ?? m.id;
  return m.nickname && !callerNicknames.has(m.userId) ? `${m.userId}/${m.nickname}` : m.id;
}

/** The rank key, nothing else: auto, repo, session labels, machine labels, online, idle, last seen, id. */
export function compareSuggestions(a: Suggestion, b: Suggestion): number {
  return (
    Number(b.auto) - Number(a.auto) ||
    Number(b.repo) - Number(a.repo) ||
    b.sessionLabels.length - a.sessionLabels.length ||
    b.machineLabels.length - a.machineLabels.length ||
    Number(b.online) - Number(a.online) ||
    b.idle - a.idle ||
    b.lastSeen - a.lastSeen ||
    cmp(a.machine, b.machine)
  );
}

/** The one-line reason of a suggestion. */
export function suggestionReason(
  s: Pick<Suggestion, "user" | "auto" | "online" | "lastSeen" | "repo" | "idle" | "sessionLabels" | "machineLabels">,
  ctx: { caller: string; now: number; repos: readonly string[]; unmatched: readonly string[]; bestName?: string | undefined },
): string {
  const parts: string[] = [];
  if (s.user !== ctx.caller) parts.push(`@${s.user}`);
  parts.push(s.auto ? "auto-accept" : "waits for them to accept");
  parts.push(s.online ? "online" : `last seen ${age(ctx.now - s.lastSeen)} ago`);
  if (ctx.repos.length) parts.push(s.repo ? `has ${ctx.repos.map(repoName).join(",")}` : `no ${ctx.unmatched.map(repoName).join(",")}`);
  parts.push(s.idle === 0 ? "no idle session" : s.idle === 1 ? "1 idle session" : `${s.idle} idle sessions`);
  if (s.sessionLabels.length && ctx.bestName !== undefined) parts.push(`${ctx.bestName} labelled ${s.sessionLabels.join(",")}`);
  if (s.machineLabels.length) parts.push(`machine labels ${s.machineLabels.join(",")}`);
  return parts.join(" · ");
}

/** Ranked suggestions: machines without the repo are left out unless `any`. */
export function suggest(input: SuggestInput): Suggestion[] {
  const { caller, repos } = input;
  const wanted = wantedLabels(input.topics, repos);
  const inW = (labels: readonly string[] | undefined) => (labels ?? []).filter((l) => wanted.has(l)).sort();
  const out: Suggestion[] = [];
  for (const m of input.machines) {
    const visible = input.sessions.filter(
      (hs) => hs.machineId === m.id && hs.session.state !== "ended" && sessionVisible(caller, { userId: hs.userId, step: hs.session.step }, m.share),
    );
    const unmatched = repos.filter(
      (r) => !(m.repos ?? []).some((x) => repoMatches(x, r)) && !visible.some((v) => v.session.repo !== undefined && repoMatches(v.session.repo, r)),
    );
    const repo = unmatched.length === 0;
    if (!repo && !input.any) continue;
    const idleSessions = visible
      .map((v) => v.session)
      .filter((s) => s.state === "idle" && !s.step && !s.launching && (repos.length === 0 || (s.repo !== undefined && repos.some((r) => repoMatches(s.repo as Repo, r)))));
    idleSessions.sort((a, b) => inW(b.labels).length - inW(a.labels).length || b.lastEventAt - a.lastEventAt || cmp(a.sid, b.sid));
    const best = idleSessions[0];
    const base = {
      machine: m.id,
      user: m.userId,
      name: machineName(m),
      to: suggestionTo(m, caller, input.callerNicknames),
      online: input.now - m.lastSeen < input.onlineMs,
      lastSeen: m.lastSeen,
      repo,
      idle: idleSessions.length,
      ...(best ? { session: best.sid } : {}),
      sessionLabels: best ? inW(best.labels) : [],
      machineLabels: inW(m.labels),
      auto: acceptMatches(m.accept, { byUser: caller, byMachine: input.callerMachine }, { userId: m.userId }),
    };
    out.push({ ...base, reason: suggestionReason(base, { caller, now: input.now, repos, unmatched, bestName: best ? sessionName(best) : undefined }) });
  }
  return out.sort(compareSuggestions);
}
