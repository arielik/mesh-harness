# Spec RL-3: Pulse scheduling and ingest

## Status
Draft (revision 2: blockers F1–F5 of review round 1 fixed; suggestions F6, F7, F9–F15, F17 taken, F8 and
F16 recorded in Open questions)

Source: `docs/analysis/2026-11-12-pulse-relay-roster.md` §5.5 (Pulse and ingest), §5.6 (relay example),
§4 R-6 (snapshots at the trust boundary), REQ-1, REQ-2, §5.9 (events), §6 and slice S3 of §9;
`docs/analysis/2026-11-12-claude-cli-spike.md` wins where it differs. Builds on RL-1
(`docs/specs/RL-1.md`: headless steps, profiles, artifacts, telemetry) and RL-2 (`docs/specs/RL-2.md`:
review records, fold, item states, `when`/`consumes`/`may_set`, `skipped`). Release v0.1.17.

## Problem

RL-1 and RL-2 can run an agent headless and review what it found, but only when a person creates the
goal, writes or instantiates the plan, approves it and offers the run step. Recurring work (a weekly
audit) still needs someone's crontab, missed runs are invisible, and nothing pins what a recurring run
executes: a repo's later edit to its preset or a re-registered profile would change the next run.

This row adds the **pulse**: a hub schedule (cron with an IANA time zone, or every *period* from an
anchor) that at each **slot** creates a goal from a preset **snapshot** with an approved plan (no
design step), and offers its first step to a machine that can run it now, retrying the next machine
within a **window**. Every slot is recorded as fired, skipped, missed or abandoned, with a reason,
including slots that passed while the hub was down. The same create-with-plan path is exposed as an
**ingest** route for other systems. A built-in agent-only `audit-relay` preset ships with it.

## Scope

In:
- Protocol types for pulses and slots (`src/protocol/pulse.ts`); request bodies `PulseCreate`,
  `PulseUpdate`, `GoalFromPreset`; `Goal.profiles` (the profile snapshot a goal's offers use).
- Pure core (`src/core/schedule.ts`): cron parsing, next slot with IANA time zones and the DST rules,
  `every`/anchor slots, durations, schedule text. Pure core (`src/core/pulse.ts`): machine candidates
  for a pulse offer, the slot id of a manual fire.
- Hub: pulses and slots (migration 10, SQLite and Postgres, `mesh hub migrate` copy); preset and
  profile snapshots (R-6); create-with-plan; firing in the hub tick, one transaction per pulse with a
  unique slot row; overlap skip; `maxGoalAge` abandon; machine choice with window, per-candidate
  timeout and retries; missed reasons; downtime slots `hub_down` and `catch-up-once`; manual fire;
  pause/resume/update/delete; owner-not-member pause; fire errors recorded; deleting a topic removes it from pulses; pulse goals hidden from goal lists by default.
- Routes `GET|POST /v1/pulses`, `GET /v1/pulses/:id`, `POST /v1/pulses/:id/update|pause|resume|fire|delete`,
  `POST /v1/goals/from-preset` (scope `goals:write`); `GET /v1/goals?pulses=1`.
- Built-in preset `audit-relay` (agent-only form of design §5.6).
- CLI `mesh pulse add|ls|show|update|pause|resume|fire|rm`; `mesh goal ls --pulses`.
- Web: a **Pulses** section on the Mine page.
- Events `pulse.*` and `goal.dropped`; a `reason` on `step.dropped` when a pulse drops a goal.
- Docs: concepts, how-to, the mesh skill, the plan API table, the events list.

Out:
- `mode: debrief`, `assignee`, the debrief stage of `audit-relay` (S4). The built-in `audit-relay` is
  agent-only in S3 (Open questions).
- Agent definition snapshots and roster keys (S5); a pulse pins the preset and profiles, not the agent
  file (Open questions).
- Calibration goals and `/v1/agents/:key/stats` (S6).
- Ingest `artifacts[]` and `refs.subject` in the lineage (PR intake, later; Open questions).
- TUI display of missed slots (REQ-2 names the TUI; Open questions). Web actions on pulses (the Mine
  section is read-only).
- Changing what a daemon does with a run whose step was dropped while it runs.
- Topic goal counts (`GET /v1/topics`) keep counting pulse goals.

## Interface contracts

Names used below. **Hub clock** = `HubService`'s `now()` (the World test clock). **ISO** of a time =
`new Date(ms).toISOString()`. **sha12** = the first 12 hex characters of a SHA-256. **Duration** = a
string matching `^[1-9][0-9]{0,5}(m|h|d)$` (minutes, hours, days), parsed by `parseDurationSpec`.
**Period** of a pulse: for `every`, its duration; for `cron`, the time between the first two slots
after the save time. **First step** of a plan = its only step with no `deps` (a pulse preset must have
exactly one, and it is not a gate). **Run step** of a slot = the goal's first step, id
`<goal>.<first step id>`. **Pulse goal** = a goal whose `refs.pulse` is set. **Unfinished** goal = state
not `done` and not `dropped`. **Owner or admin** = the pulse's owner, or a caller with role `admin`.
**Profile names of a plan** = for every step, `profile` when set, and `HEADLESS_DEFAULTS.profile` for a
step with `mode: "headless"` and no `profile`; sorted, unique.

### Types (src/protocol/pulse.ts, exported from src/protocol/index.ts)

| Interface | Type | Change |
|---|---|---|
| `PulseId` | zod | New: `z.string().regex(/^p-[1-9][0-9]*$/)`. |
| `DurationSpec` | zod | New: `z.string().regex(/^[1-9][0-9]{0,5}(m\|h\|d)$/, "a duration is a number and m, h or d, e.g. 30m, 4h, 7d")`. |
| `PulseWhenInput` | zod | New, union of strict objects: `{ cron: string 1..100, tz: string 1..64 }` \| `{ every: DurationSpec, at?: int ≥ 0 /* ms; the anchor */ }`. |
| `PulseWhen` | zod | New (stored): `{ cron: string, tz: string }` \| `{ every: DurationSpec, anchor: int ≥ 0 }`. |
| `PresetSnapshot` | zod | New, strict: `{ name: string /^[A-Za-z0-9][A-Za-z0-9._-]{0,59}$/, text: string 1..20000, sha256: string /^[0-9a-f]{64}$/, source?: strict { repo: string 1..300, commit: string 1..64 } }`. |
| `PulseParams` | zod | New: `z.record(z.string().regex(/^[a-z][a-z0-9_]{0,39}$/), z.string().max(300))`, at most 20 keys. |
| `PulseTarget` | zod | New, strict: `{ labels?: Label[] (≤ 20), machines?: string[] (≤ 20, each 1..100) }` (`Label` of MM-2). |
| `PulseCreate` (body of `POST /v1/pulses`) | zod | New, strict: `{ title?: string 1..200, preset: PresetSnapshot, params: PulseParams, when: PulseWhenInput, topics?: string[] (≤ 20, each ≤ 40), target?: PulseTarget (default {}), window?: DurationSpec, overlap?: "skip" \| "allow" (default "skip"), maxGoalAge?: DurationSpec, missed?: "record" \| "catch-up-once" (default "record"), enabled?: boolean (default true) }`. Refinements (400, zod messages): `every` from 5m to 366d → `every is 5m to 366d`; `window` from 1m to 30d → `window is 1m to 30d`; `maxGoalAge` from 1h to 366d → `maxGoalAge is 1h to 366d`. |
| `PulseUpdate` (body of `POST /v1/pulses/:id/update`) | zod | New: every field of `PulseCreate` except `enabled`, all optional, same refinements; at least one field → else 400 `give at least one field to change`. |
| `SlotState` | zod | New: `z.enum(["fired","skipped","missed","abandoned"])`. |
| `SlotReason` | zod | New: `z.enum(["overlap","no_machine","not_accepted","capacity","expired","hub_down","max_goal_age","error"])`. |
| `SlotTry` | zod | New: `{ machine: string, at: number, outcome?: "accepted" \| "declined" \| "timeout" \| "released" \| "capacity" }`. |
| `PulseSlot` | zod | New: `{ pulse: PulseId, slot: string, at: number /* due time; for a manual slot the fire time */, state: SlotState, reason?: SlotReason, goal?: string, manual?: true, by?: string /* manual: the caller */, catchUp?: true, firedAt?: number, until?: number /* fired slots: end of the window */, startedAt?: number, error?: string /* reason error: the message, ≤ 500 chars */, tried: SlotTry[] (default []), decidedAt: number }`. **`until`** = `at + windowMs` for a scheduled slot that fires on time, `firedAt + windowMs` for a manual or `catchUp` slot. `slot` is the ISO of `at` for a scheduled slot, `manual:` + a 26-character ULID (Crockford base32, `/^manual:[0-9A-HJKMNP-TV-Z]{26}$/`) for a manual one. |
| `Pulse` | zod | New: `{ id: PulseId, owner: string, title: string, when: PulseWhen, preset: PresetSnapshot, params: PulseParams, profiles: Record<string, ProfileSnapshot>, topics: string[], target: PulseTarget, window?: DurationSpec /* as given; absent = default */, windowMs: int > 0, overlap: "skip" \| "allow", maxGoalAge?: DurationSpec /* as given */, maxGoalAgeMs: int > 0, missed: "record" \| "catch-up-once", enabled: boolean, pausedReason?: string, nextAt?: number /* absent when paused or deleted */, version: int ≥ 1, createdAt, updatedAt, deletedAt?: number }`. |
| `PulseView` | interface | New (list rows): `Omit<Pulse, "preset" \| "profiles"> & { preset: { name, sha256, source? }; profiles: Record<string, string /* sha256 */>; schedule: string /* scheduleText */; recent: PulseSlot[] /* the 10 newest slots */ }`. |
| `PulseDetail` | interface | New: `{ pulse: Pulse; schedule: string; slots: PulseSlot[] /* the 50 newest */; goals: Record<string, GoalState> /* state of each goal named by those slots */ }`. |
| `FireResult` | interface | New: `{ slot: PulseSlot }`. |
| `GoalFromPreset` (body of `POST /v1/goals/from-preset`, src/protocol/hub.ts) | zod | New, strict: `{ preset: PresetSnapshot without source, params: PulseParams, title?: string 1..200, topics?: string[] (≤ 20), refs?: record (as `NewGoal.refs`), priority?: int 0..9 (default 3) }`. |
| `Goal` (src/protocol/goal.ts) | zod field | New, optional: `profiles: z.record(z.string(), ProfileSnapshot)`: set on goals created by a pulse or by ingest; absent otherwise. |

Newest-first order of slots everywhere: `at` descending, then `slot` descending (code-point order).

### Core (src/core/schedule.ts and src/core/pulse.ts, exported from `src/core/index.ts`; no hub or store imports)

```ts
export function parseDurationSpec(s: string): number            // ms; throws Error(`invalid duration "${s}" (use e.g. 30m, 4h, 7d)`) when it does not match DurationSpec
export function parseCron(expr: string): { ok: true; cron: Cron } | { ok: false; error: string }
export function validTimeZone(tz: string): boolean             // true when Intl accepts it as an IANA zone (e.g. "UTC", "Europe/Berlin")
export function nextSlot(when: PulseWhen, after: number): number | undefined
export function periodMs(when: PulseWhen, from: number): number | undefined
export function scheduleText(when: PulseWhen): string
```
**Cron**: exactly 5 whitespace-separated fields: minute 0–59, hour 0–23, day of month 1–31, month
1–12, day of week 0–7 (0 and 7 are Sunday). A field is a comma list of items; an item is `*`, `n`,
`a-b` (a ≤ b), optionally followed by `/s` (s ≥ 1; `n/s` means `n-max/s`). No names, `?`, `L`, `W`, `#`.
Errors, exactly: wrong field count → `a cron expression has 5 fields (minute hour day-of-month month
day-of-week)`; unparsable item → `bad <field> field "<field text>"`; value out of range → `<field>
value <n> is out of range <min>-<max>` (`<field>` ∈ `minute`, `hour`, `day-of-month`, `month`,
`day-of-week`). Day matching (Vixie cron): when both day fields are restricted (a field is
unrestricted when it starts with `*`), a day matches if either matches; otherwise both must.

**`nextSlot` for cron** = the smallest slot instant `> after` (minute precision, UTC ms), searching at
most 5 years ahead (`undefined` when none: e.g. `0 0 31 2 *`). Slot instants: every UTC minute `t`
whose wall time in `tz` matches the cron; a matching wall minute that does not exist in `tz` (DST gap)
maps to the first existing wall minute after the gap; a wall minute that occurs twice (DST overlap) is
a slot at its first occurrence only; slots that coincide are one slot. Vectors (must hold exactly):

| `when` | `after` | `nextSlot` |
|---|---|---|
| `0 9 * * 1`, `America/New_York` | `2026-11-12T00:00:00Z` | `2026-11-16T14:00:00Z` |
| `30 2 * * *`, `Europe/Berlin` (gap) | `2026-03-28T12:00:00Z` | `2026-03-29T01:00:00Z` (03:00 CEST) |
| `30 2 * * *`, `Europe/Berlin` (overlap) | `2026-10-24T12:00:00Z` | `2026-10-25T00:30:00Z` |
| same | `2026-10-25T00:30:00Z` | `2026-10-26T01:30:00Z` (not `2026-10-25T01:30:00Z`) |
| `*/30 * * * *`, `Europe/Berlin` | `2026-10-25T00:30:00Z` | `2026-10-25T02:00:00Z` |
| `*/30 * * * *`, `Europe/Berlin` | `2026-03-29T00:30:00Z` | `2026-03-29T01:00:00Z`, then after it `2026-03-29T01:30:00Z` |
| `0 0 1 * 1`, `UTC` (day OR) | `2026-11-12T00:00:00Z` | `2026-11-16T00:00:00Z` (a Monday before Dec 1) |
| `0 12 * * 7`, `UTC` | `2026-11-12T00:00:00Z` | `2026-11-15T12:00:00Z` (Sunday) |

**`nextSlot` for every** = `anchor` when `anchor > after` (an anchor in the future is the first slot,
however far ahead); else the smallest `anchor + k·period > after` with `k ≥ 1`. **`periodMs`**: every → the
duration; cron → `nextSlot(nextSlot(from)) − nextSlot(from)`; `undefined` when the cron never fires.
**`scheduleText`**: `every <duration>` / `cron "<expr>" <tz>`.

```ts
export function pulseCandidates(o: {
  owner: string; repo: string; topics: readonly string[];
  target: { labels?: readonly string[]; machines?: readonly string[] };
  headless: boolean;                     // the run step has mode: headless
  tried: ReadonlySet<string>;            // machine ids already offered this slot
  now: number; onlineMs: number;         // hub: thresholds.machineOfflineMs
  machines: readonly (SuggestMachine & { headless?: boolean | undefined })[];
  sessions: readonly SuggestSession[];
}): Suggestion[]
export function manualSlot(now: number, rand?: Uint8Array): string   // "manual:" + ULID of `now`
```
`pulseCandidates` = `suggest({caller: owner, callerMachine: undefined, now, onlineMs, repos: [repo],
topics, any: false, machines, callerNicknames: <nicknames of owner's machines>, sessions})` (its order
kept; `repo` = the run step's `repo`), keeping only suggestions that are `online` and `auto`, whose machine carries every
`target.labels` label (a filter, never a rank key), that is `headless === true` when `headless`, that
is not in `tried`, and, when `target.machines` is non-empty, whose machine matches one entry: its id,
`<user>/<nickname>`, or a bare nickname of a machine of the owner.

### Hub store (src/store/hub-store.ts, src/store/hub-copy.ts)

| Interface | Change |
|---|---|
| `HubStore.SCHEMA_VERSION` | 10. `HUB_MIGRATIONS` and `HUB_MIGRATIONS_PG` each gain one entry (length 10). |
| Migration 10 | `pulse (id TEXT PRIMARY KEY, num INTEGER NOT NULL UNIQUE, owner TEXT NOT NULL, enabled INTEGER NOT NULL, next_at INTEGER, value TEXT NOT NULL, updated_at INTEGER NOT NULL)`; `pulse_slot (pulse TEXT NOT NULL, slot TEXT NOT NULL, at INTEGER NOT NULL, state TEXT NOT NULL, goal TEXT, started_at INTEGER, value TEXT NOT NULL, updated_at INTEGER NOT NULL, PRIMARY KEY (pulse, slot))` (`started_at` mirrors `PulseSlot.startedAt`; NULL when unset) with indexes on `(state, started_at)` and `(goal)`. Postgres uses `BIGINT` for the time columns. A v9 database migrates with its data unchanged. |
| `createPulse(p: Omit<Pulse, "id">): Promise<Pulse>` | New; id `p-<num>`, `num` = the largest ever used + 1 (ids are never reused: deleted pulses keep their row). The caller holds the new lock `LOCKS.pulses` (`src/store/dialect.ts`; `this.lock("pulses")` in the transaction, as `createGoal` holds `goals`), so two replicas never pick the same `num`. |
| `getPulse(id)`, `savePulse(p)`, `listPulses(f?: { owner?: string; deleted?: boolean })` | New; list by `num`; deleted pulses only with `deleted: true`. |
| `duePulses(now): Promise<Pulse[]>` | New; enabled, not deleted, `nextAt <= now`, by `num`. |
| `addSlot(s: PulseSlot): Promise<boolean>` | New; `false` when `(pulse, slot)` exists (nothing written). |
| `getSlot(pulse, slot)`, `saveSlot(s)`, `listSlots(f: { pulse?: string; state?: SlotState; pending?: true; limit?: number })` | New; list newest first. `pending: true` = `state = 'fired'` and `started_at IS NULL`, read through the index without parsing other rows. |
| `TABLES` (src/store/hub-copy.ts) | Gains, after `item_history`: `{ name: "pulse" }`, `{ name: "pulse_slot" }`. |

### Hub behaviour (src/hub/service.ts)

**Preset validation** (pulse create, an update that changes `preset` or `params`, ingest), producing
problems, in this order:
1. `preset.sha256` is not the lowercase hex SHA-256 of the UTF-8 `preset.text` → **400**
   `preset.sha256 is not the SHA-256 of preset.text` (before any problem below);
2. `params.repo` absent or empty → problem `params.repo is required (the repo the preset's steps work in)`;
3. `parsePreset(name, text)` throws → problem `preset <name>: <message>` (stop here);
4. `instantiate(preset, {repo: params.repo, goal: "this goal", params})` throws → problem `<message>`
   (e.g. `preset audit-relay: unknown parameter {validator} in step validate`; stop here);
5. `validatePlan` and `validatePolicies` errors of the instantiated plan, as they are;
6. not exactly one step without `deps`, or that step is a gate → problem `a pulse preset needs exactly
   one first step (no deps, not a gate); <name> has <n>` (`<n>` = steps without deps; also for ingest);
7. each profile name of the plan that is neither built in nor registered → problem `step "<id>":
   unknown profile "<name>"` (first step naming it).

Any problem → **422** `the preset has <k> problem(s): <problems joined "; ">` (details = the list).
Unknown topics → 400 as `POST /v1/goals` (`unknown topic…`). Schedule checks (pulse create/update, after
the preset): `cron` that `parseCron` rejects → 422 `bad cron "<expr>": <error>`; `tz` not valid → 422
`unknown time zone "<tz>"`; a cron that never fires → 422 `cron "<expr>" never fires`; a cron whose
`periodMs(when, now)` is under 5 min → 422 `cron "<expr>" fires more often than every 5m`.

**Snapshots (R-6).** On create, and on an update that changes `preset` or `params`, the hub stores the
preset snapshot as sent and resolves every profile name of the plan to a `ProfileSnapshot` (built in
or registered, as RL-1's offers do) into `Pulse.profiles`; `version` is 1 on create and +1 on such an
update. Nothing else re-reads presets or profiles: later edits of the repo's `.mesh/presets` file, a
`POST /v1/profiles` that replaces a profile, or an update of other fields never change what a slot
runs. The owner saving the pulse is the plan approval of every slot until the next such update.

**Defaults on save.** `owner` = caller; `title` = `<preset name> on <repoName(params.repo)>`;
`when.every` → `anchor` = `at` when given, else the save time; `window`/`maxGoalAge` stored as given
(absent when not given); `windowMs` = `window` when given, else `min(4h, period)`; `maxGoalAgeMs` =
`maxGoalAge` when given, else `2 × period`; `topics` normalized as for goals; `nextAt` = `nextSlot(when,
now)` when enabled. An update that changes `when` recomputes `anchor` (as on create) and `nextAt` from
the update time. Every update recomputes `windowMs` and `maxGoalAgeMs` by the same rule from the stored
(or newly given) `window`/`maxGoalAge` and the current period, so a value given by the owner is kept
and a default follows the period.

**Create-with-plan** (a slot fire, and ingest): in one transaction, (a) a goal with `ownerId` = the
pulse owner (ingest: the caller), `title` (fire: `<pulse title> (<slot>)`; ingest: `title` or the
default above), `primaryRepo` = `params.repo`, `preset: {name, text}` (so the RL-2 lineage is
`<preset name>|<repo>|<agent>`), `profiles` = the snapshots, `topics`, `priority` (fire: 3), `refs`
(fire: `{pulse: <id>, slot: <slot>}`; ingest: the given `refs`); (b) **no** `<G>.design` step;
(c) plan v1 = `instantiate(preset, {repo, goal: <G>, params})`, `proposedBy` = `decidedBy` = the
owner, `decision: "approved"`, `comment` = `pulse <id> (preset <name> <sha12>)` (ingest: `ingest
(preset <name> <sha12>)`); (d) steps materialized and settled as `approvePlan` does (RL-2), goal
`in_progress` (or `done` when every step settles done/skipped/dropped); (e) events `goal.created`
(user = owner; payload `title`, `preset: <name>`, and for a fire `pulse`, `slot`), `plan.approved`
(`version: 1`), `step.ready` per ready step, `step.skipped` as RL-2. No inbox message (no
`plan_approved`, no request to commit a plan file).

**Offers of a goal with `profiles`.** A headless step of such a goal is offered with the snapshot
`goal.profiles[<its profile name>]` (offer data `profile` and `StepOffer.profile` carry it); a name
missing from it → the step is not offered, with the guard error `<step id>: profile <name> is not in
the goal's snapshot`. Goals without `profiles` resolve profiles as RL-1.

**Pulse writes.** Create, update, pause, resume, delete, fire and every tick write run in `goalTx` and
re-read the pulse row inside it; a write never saves fields from a read made outside its transaction.

**Tick.** After the existing tick work (pause and offer-expiry pass), outside its transaction, the hub
first **advances** pending slots, then **fires** due pulses. Advancing first ends every slot whose
window is over (its goal dropped) before the next slot's overlap check, so with a window equal to the
period every slot fires.

**Advance.** **Pending slot** = `state: "fired"` without `startedAt` (`listSlots({pending: true})`),
of a pulse that is not deleted. Per pending slot, in its own `goalTx` (re-read; no longer pending →
nothing):
1. **Started**: the run step had a `run.started` report (`POST /v1/steps/:id/run`, which also sets
   `startedAt` at once), or (interactive run step) it is `claimed`, `paused`, `done` or `failed`, or the
   goal is `done` → `startedAt` = now; stop.
2. **Window over**: `now >= until` → slot `missed` with reason: `no_machine` when `tried` is empty;
   `capacity` when the last try's outcome is `capacity`; `expired` when the last try is `accepted` (the
   step is still held, not started); else `not_accepted`. An open offer is withdrawn, the goal is
   dropped (reason `missed`), event `pulse.missed`; stop.
3. **Attempt**, when the run step is `ready`:
   - an open offer to a machine other than the last one in `tried` (a person offered it, e.g. `mesh
     assign`) → wait (the window still applies);
   - an open offer to the last tried machine made less than `offerTimeoutMs` = `min(thresholds.offerExpiryMs,
     floor(windowMs / 3))` ago → wait; older → withdraw it (`step.offer_withdrawn`, reason `pulse: not
     accepted in time`) and record outcome `timeout`. When `offerTimeoutMs` equals `offerExpiryMs`, the
     existing expiry pass (which runs earlier in the same tick) decides: the offer ends `expired` with
     event `step.offer_expired` and no `step.offer_withdrawn`, and the outcome is `timeout`;
   - a last try without an outcome gets one from the step's offer: `declined` → `declined`, `expired`
     or `withdrawn` → `timeout`;
   - then the first of `pulseCandidates(…, tried)` (all machines of the hub; `repo` = the run step's
     `repo`; `onlineMs` = `thresholds.machineOfflineMs`) gets an offer `by` the owner (no session, no
     machine), appended to `tried`, and the goal's `stick` is set to that machine (`by` = owner), so the
     goal's later ready steps follow it; no candidate → wait.

   When the run step is `claimed` by an accepted offer, the last try's outcome is `accepted`. A headless
   run step offered this way has offer data `deadline` = `min(offer.at + offerExpiryMs, until)`.

`releaseStep` on the run step of a pending slot sets the last try's outcome: `capacity` when the note
starts with `capacity:` (RL-1's queued-run release), else `released`; the next attempt goes to the
next candidate. Each machine is offered at most once per slot.

**Fire due pulses.** For each `duePulses(now)` pulse, in its own `goalTx`: re-read the pulse; when it is
no longer enabled, is deleted, or its `nextAt` is now absent or `> now` (paused, deleted, updated or
fired by another replica since the read) → nothing. If the owner's user row is missing or has none of
the roles `member`, `approver`, `admin` → the pulse is paused (`enabled: false`, `pausedReason: "owner
<owner> is not a member"`, `nextAt` removed), event `pulse.paused`, nothing else. Otherwise the **due
slots** are the slot times `t` with `nextAt <= t <= now` (in order). The latest due slot `L` **fires**
(`until` = `L + windowMs`) when `now − L < windowMs`; else, when `missed: "catch-up-once"`, `L` fires
with `catchUp: true` (`until` = `firedAt + windowMs`); else none fires. Every other due slot (and `L`
when it does not fire) is recorded `missed`, reason `hub_down` (no goal), keeping only the 10 latest
such rows per pulse per tick. Then `nextAt` = `nextSlot(when, now)`; the tick changes no other field
of the pulse.

A pulse whose transaction throws (create-with-plan rejects, a store error) is rolled back; a second
`goalTx` then records the same rows, except that `L` is `missed`, reason `error`, `error` = the message
(first 500 characters), no goal, event `pulse.missed`, and saves `nextAt` as above. The other due
pulses of the tick still run. A throw in that second transaction is logged as today (`hub tick
failed`) and the pulse is tried again at the next tick.

**Firing a slot** (scheduled or manual), inside the pulse's transaction, in this order:
1. insert the `PulseSlot` row (`addSlot`; `false` → stop: another replica or a retry fired it);
2. **retire**: every other pending slot of the pulse is advanced by Advance steps 1 and 2 (a slot
   whose window is over becomes `missed` and its goal is dropped);
3. **abandon**: the goal of every `fired` slot of the pulse with `startedAt` set that is unfinished and
   has `now − createdAt >= maxGoalAgeMs` is dropped (below, reason `abandoned`) and that slot becomes
   `abandoned`, reason `max_goal_age` (event `pulse.abandoned`). A goal that never started is ended by
   its window (`missed`), never abandoned;
4. **overlap**: when `overlap: "skip"` and an unfinished goal of the pulse remains, the slot is
   `skipped`, reason `overlap` (event `pulse.skipped`), and nothing fires;
5. else create-with-plan, the slot is `fired` with `goal`, `firedAt` = now and `until` (event
   `pulse.fired`), and one **attempt** (Advance step 3) runs in the same transaction.

Manual slots count for overlap like scheduled ones. A manual fire whose transaction throws is recorded
as above (`missed`, reason `error`).

**Dropping a goal**: goal state `dropped`; each step not `done`, `skipped`, `dropped` or `failed`
becomes `dropped` (open offers end `withdrawn`); events `goal.dropped {reason}` and `step.dropped
{reason}` per step (`reason` = `abandoned` or `missed`).

**Topics.** `deleteTopic` also removes the topic from every pulse that has it (deleted ones too):
`updatedAt` = now, `version` unchanged, event `pulse.updated` (user = caller, `fields: ["topics"]`);
the `topic.deleted` payload is unchanged.

**Goal lists.** `GET /v1/goals` leaves out pulse goals unless the query has `pulses=1`; `GET /v1/live`
`goals` leaves them out. `GET /v1/goals/:id`, steps, attention, offers and events are unchanged.

### Hub HTTP API (src/hub/app.ts, listed in `HUB_API`)

All new routes have rule `member`. Errors are `{error}` JSON; zod body errors are 400 as today.

| Route | Scope, tag | Behaviour |
|---|---|---|
| `GET /v1/pulses` (query `mine`: `1` = only the caller's) | `goals:read`, `goals` | 200 `{pulses: PulseView[]}` by number, deleted ones left out. |
| `POST /v1/pulses` (`PulseCreate`) | none, `goals` | Validation above; 201 `PulseView`. Event `pulse.created`. |
| `GET /v1/pulses/:id` | `goals:read`, `goals` | 200 `PulseDetail`; unknown or deleted → 404 `no pulse <id>`. |
| `POST /v1/pulses/:id/update` (`PulseUpdate`) | none, `goals` | 404 as above; not owner or admin → 403 `only @<owner> or an admin can change pulse <id>`; validation; 200 `PulseView`. Event `pulse.updated`. |
| `POST /v1/pulses/:id/pause` | none, `goals` | 404, 403 as above; already paused → 409 `pulse <id> is already paused`; 200 `PulseView` (`enabled: false`, `pausedReason: "paused by <caller>"`, no `nextAt`). Event `pulse.paused`. |
| `POST /v1/pulses/:id/resume` | none, `goals` | 404, 403; not paused → 409 `pulse <id> is not paused`; 200 `PulseView` (`enabled: true`, no `pausedReason`, `nextAt` = `nextSlot(when, now)`; slots passed while paused are never recorded). Event `pulse.resumed`. |
| `POST /v1/pulses/:id/fire` | none, `goals` | 404, 403; fires a manual slot now (`manual: true`, `by` = caller, `at` = now), also when the pulse is paused; does not change `nextAt`. 201 `FireResult` (the slot as stored: `fired`, `skipped`, or `missed` with reason `error` when the fire threw). |
| `POST /v1/pulses/:id/delete` | none, `goals` | 404, 403; sets `deletedAt`, `enabled: false`, removes `nextAt`; slots and goals stay; pending slots are no longer advanced. 200 `{pulse: <id>}`. Event `pulse.deleted`. |
| `POST /v1/goals/from-preset` (`GoalFromPreset`) | `goals:write`, `goals` | `refs` with key `pulse` or `slot` → 400 `refs.pulse and refs.slot are set by pulses only`; preset validation; create-with-plan with the caller as owner; 201 `GoalDetail`. |
| `GET /v1/goals` | `goals:read` | Gains query `pulses` (`1`: include pulse goals). |

### Events (`docs/events.md`; payloads never carry preset text or profile settings)

| Type | Fields | Payload |
|---|---|---|
| `pulse.created` | user | `pulse`, `title`, `preset` (name), `sha256`, `schedule` |
| `pulse.updated` | user | `pulse`, `version`, `fields` (changed body keys, sorted) |
| `pulse.paused` | user (absent for the owner-not-member pause) | `pulse`, `reason` |
| `pulse.resumed` / `pulse.deleted` | user | `pulse` |
| `pulse.fired` | goal (user = caller for a manual fire) | `pulse`, `slot`, `manual?: true`, `catchUp?: true` |
| `pulse.skipped` | — | `pulse`, `slot`, `reason: "overlap"`, `running` (the unfinished goal id) |
| `pulse.missed` | goal when the slot had one | `pulse`, `slot`, `reason`, `tried` (number), `error` (reason `error` only) |
| `pulse.abandoned` | goal | `pulse`, `slot` |
| `goal.dropped` | goal | `reason: "abandoned" \| "missed"` |
| `step.dropped` (existing; new payload when a pulse drops the goal) | goal, step | `reason: "abandoned" \| "missed"` (absent when a new plan drops the step, as today) |

`describe()` (Live activity) gives one line naming the pulse id for each `pulse.*` type, and for
`step.dropped` with a payload `reason` a line naming that reason (`dropped: its goal was abandoned` /
`dropped: its pulse slot was missed`), never `dropped by a new plan`.

### Built-in preset (src/core/presets.ts)

`BUILTIN_PRESETS` gains `audit-relay` (description `Audit by an agent, validated by an agent, filed by
an agent (agent-only; a person's debrief comes with S4).`), steps exactly (repo `{repo}` each):

| id | kind | deps | policy |
|---|---|---|---|
| `audit` | review | — | `agent: "{agent}"`, `mode: headless`, `profile: read-only`, `output: review-record`, `budget: {turns: 80, minutes: 60}`, `inputs: [previous]`, title `Audit {repo}`, brief as design §5.6 |
| `validate` | review | `[audit]` | `agent: "{validator}"`, `mode: headless`, `profile: read-only`, `output: review-record`, `when: {open: true}`, `consumes: [open]`, `may_set: [confirmed, dismissed]`, `inputs: [audit, dispositions]`, title `Validate the findings` |
| `file` | docs | `[validate]` | `agent: "{filer}"`, `mode: headless`, `profile: propose-via-branch`, `output: review-record`, `when: {open: true}`, `consumes: [confirmed]`, `may_set: [accepted]`, `inputs: [dispositions]`, title `File the confirmed items`, brief `Propose an entry for each confirmed item on this run's branch, then submit a review record that sets each one accepted with its link.` |

Instantiation needs params `agent`, `validator` and `filer` (an unfilled one fails as RL-1).

### CLI (src/cli, `mesh help` lists `pulse`)

| Command | Behaviour |
|---|---|
| `mesh pulse add --preset <name> --repo <repo> [--params k=v,k2=v2] (--every <dur> [--at <ISO>] \| --cron "<5 fields>" [--tz <zone>]) [--title "…"] [--topics a,b] [--labels a,b] [--machines a,b] [--window <dur>] [--overlap skip\|allow] [--max-goal-age <dur>] [--missed record\|catch-up-once] [--paused]` | Resolves the preset like `mesh goal plan --preset` (`findPreset`: `.mesh/presets/<name>.yaml` walking up from the **current directory** to its git root, else built in; `--repo` does not change where it looks); sends `preset.text` = `presetText(<preset>)`, `sha256` of it, `source` = `{repo: <directory name of the current directory's git root>, commit: <git rev-parse HEAD there>}` only for a repo file; `params` = `--params` (RL-1 parsing) with `repo` = `--repo`; `--tz` default = the CLI process's `Intl` time zone; `--paused` sends `enabled: false`. Errors (exit 2, nothing sent): no `--preset` or `--repo` → usage; neither or both of `--every`/`--cron` → `give one schedule: --every <duration> or --cron "<5 fields>"`; bad `--at` → `--at takes an ISO time, e.g. 2026-11-16T09:00:00Z`; bad `--params` → RL-1 text; unknown preset → `findPreset`'s text. Success: `Created pulse <id> "<title>": <schedule>, next run <ISO of nextAt or ->.` |
| `mesh pulse ls [--mine] [--json]` | One line per pulse: `<id>  <active\|paused>  @<owner>  <schedule>  next <ISO\|->  last <state[ (reason)]\|->  <title>` (fields joined by two spaces; `last` = `recent[0]`). None → `No pulses. Create one: mesh pulse add --preset <name> --repo <repo> --every 7d`. `--json` prints the route's reply. |
| `mesh pulse show <id> [--json]` | First line `<id> "<title>"  @<owner>  <active\|paused[: <pausedReason>]>`; then lines starting `schedule: `, `preset: ` (name, sha12, `from <repo>@<commit sha12>` when sourced, params `k=v` comma-separated), `target: `; then `slots:` and one line per slot, newest first: `  <slot>  <state>[ (<reason>)]  <goal or ->[  tried <machine ids comma-separated>]`. `--json` prints `PulseDetail`. |
| `mesh pulse update <id> [any add flag except --paused]` | Sends only the given fields (`--preset` resends text, sha and source; `--repo`/`--params` send the full new `params`). `Updated pulse <id>; next run <ISO\|->.` |
| `mesh pulse pause <id>` / `resume <id>` | `Paused pulse <id>.` / `Resumed pulse <id>; next run <ISO>.` |
| `mesh pulse fire <id>` | `Fired pulse <id>: slot <slot> → <goal>.` or, when skipped, `Pulse <id> skipped slot <slot>: <running goal> is still running (overlap: skip).` Exit 0 both. A `missed` slot (reason `error`) → `Pulse <id> missed slot <slot>: <error>`, exit 1. |
| `mesh pulse rm <id>` | `Removed pulse <id> (its goals stay).` |
| `mesh goal ls [--pulses]` | `--pulses` passes `pulses=1`. |
| Hub errors | Printed as today (exit 1). An unknown subcommand → usage, exit 2. |

### Web (web/src/mine.tsx)

The Mine page gains, after "Assigned to you", a `section.pulses` with heading `Pulses`, from
`GET /v1/pulses?mine=1` (refetched with the page). Empty → `No pulses. Create one with mesh pulse add.`
Each pulse is a `div.pulse[data-pulse="<id>"]` showing its id, title, `scheduleText`, `active` or
`paused`, and `next <time>` when `nextAt` is set; and a list of its `recent` slots, each an
`li[data-slot="<slot>"]` with class `slot-<state>`, text containing the state, ` (<reason>)` when
there is a reason, and the goal id when there is one. Read-only.

### Docs

| File | Change |
|---|---|
| `docs/guide/concepts.md` | "Pulses": snapshots (R-6: what a slot runs is pinned when the pulse is saved), slots and their states and reasons, overlap, `maxGoalAge`, window and machine choice (online, repo, labels as a filter, auto-accept, ranked by suggest, one try per machine), downtime and `catch-up-once`, cron with time zone and the DST rules, `every`/`--at`, manual fire, pulse goals hidden from goal lists, create-with-plan (no design step), ingest. The built-in `audit-relay`. |
| `docs/guide/howto.md` | "Run an agent audit on a schedule": machine accept policy and labels, `mesh pulse add --preset audit-relay …`, `mesh pulse show`, `mesh pulse fire`, reading missed slots. |
| `src/protocol/skill.ts` `MESH_SKILL` and generated `skills/mesh/SKILL.md` | Pulse goals (a step you hold may come from a pulse; there is no design step), `mesh pulse` for people. |
| `docs/plan/implementation-plan.md` §5.6 | Rows for the new routes and `GET /v1/goals?pulses=1` (v0.1.17). |
| `docs/events.md` | Rows for the events above. |

### Compatibility

- Goals without `refs.pulse`/`profiles` behave as before; `createGoal` (`POST /v1/goals`) still makes a
  design step. Offers of goals without `profiles` resolve profiles as RL-1.
- Existing tests that compare `SCHEMA_VERSION`/migration counts (9), `TABLES`, `BUILTIN_PRESETS` or
  the `mesh help` list are updated by the test-writer.

## Acceptance criteria

Surfaces: unit tests (`src/core`, `src/protocol`); `HubStore` contract test (SQLite always, Postgres
when its URL is set); World tests (`test/helpers/world.ts`, `relay-kit.ts`, `review-kit.ts`; the test
side may extend them) with the World clock and `w.tick()`; CLI tests; the fake `claude` of RL-1
(`test/fixtures/claude/fake-claude`); Playwright (`test/e2e-web`, `pnpm test:web`). Tests find pulses,
slots and goals by id, events by `type` + `pulse`/`slot`, never by list position. No test runs the real
`claude` binary. No test asserts `package.json`'s version except AC-27.

| Id | Criterion | Surface | What exact state makes it FAIL? |
|---|---|---|---|
| AC-01 | Schemas: `PulseCreate` accepts a minimal body (defaults `overlap: skip`, `missed: record`, `enabled: true`, `target: {}`) and both `when` forms; rejects `every: "7w"`, `every: "1m"` (`every is 5m to 366d`), `window: "0h"`, `maxGoalAge: "30m"`, a sha256 of 63 chars, a params key `Repo`, 21 params, an unknown key. `PulseUpdate` `{}` → `give at least one field to change`. `PulseSlot` accepts `manual:` + 26 Crockford chars and rejects `manual:x`. `Goal` parses with and without `profiles`. | unit | Any listed value parses the other way, or a default differs. |
| AC-02 | `parseCron` errors exactly as documented for 4 fields, `61 * * * *`, `* * * 13 *`, `a * * * *`, `5-3 * * * *`; accepts lists, ranges, steps, `n/s`, dow 7. `nextSlot` gives every vector of the table exactly; `validTimeZone("Mars/Base")` is false; `0 0 31 2 *` → `undefined`. | unit | A different instant, a double slot in an overlap, a missing slot in a gap, or a different message. |
| AC-03 | `every`: anchor `A`, period 7d: `nextSlot(A)` = `A + 7d`, `nextSlot(A − 1)` = `A`, `nextSlot(A + 10d)` = `A + 14d`, an anchor 30 days after `after` → `nextSlot(after)` = the anchor (not `anchor − 28d`). `periodMs` for `0 9 * * 1`, `UTC` = 7 days; `scheduleText` exact; `parseDurationSpec("4h")` = 14 400 000 and throws the documented text for `4w`. | unit | Off by one period, wrong text or value. |
| AC-04 | `pulseCandidates`: of five machines (offline; online without the repo; online with repo but `accept` not matching the owner; online, repo, auto, missing a target label; online, repo, auto, all labels) only the last is kept; with `headless: true` a machine without `headless` is dropped; `tried` drops one; `target.machines` matches by id, `<user>/<nickname>` and the owner's bare nickname; two kept machines keep `suggest`'s order, and an extra target label on one that is neither a topic nor the repo name never changes the order. `manualSlot` matches the regex. | unit | A filtered machine kept, a kept one dropped, or an order other than `suggest`'s. |
| AC-05 | Contract: `SCHEMA_VERSION` 10, both lists length 10; a v9 database (SQLite file; Postgres when set) migrates with goals, steps, reviews and items intact; `createPulse` gives `p-1`, `p-2`; after deleting (`deletedAt`) `p-2` the next is `p-3`; `duePulses` returns enabled, not deleted, due pulses by number; `addSlot` returns `false` on a second `(pulse, slot)` and keeps the first; `listSlots` filters by pulse and state, limits, and lists newest first (equal `at`: slot descending); `pending: true` returns only `fired` rows without `startedAt`. | contract (SQLite, Postgres) | Version wrong, data lost, an id reused, a duplicate slot stored, a filter ignored, a wrong order. |
| AC-06 | `POST /v1/pulses`: sha mismatch → 400 documented text; problems → 422 `the preset has <k> problem(s): …` with the exact texts for: missing `params.repo`; `audit-relay` without `validator` (`preset audit-relay: unknown parameter {validator} in step validate`); a preset with two steps without deps; an unknown profile; a `validatePolicies` error (passed as is); bad cron, bad tz, a never-firing cron and `* * * * *` (`cron "* * * * *" fires more often than every 5m`) → their 422 texts; unknown topic → 400. Success → 201 `PulseView` with `version: 1`, `owner` = caller, default title, `windowMs` = 4h (every 7d) and 30 min (every 30m), `maxGoalAgeMs` = 14 days (every 7d), `nextAt` = `nextSlot(when, now)` (every 7d: now + 7d; `at` = now + 2d: `at`; `at` = now + 30d: `at`), `profiles` with `read-only` and `propose-via-branch` (audit-relay) at their built-in sha256, a headless step without `profile` adding `read-only`; event `pulse.created` with exactly the documented payload keys. `enabled: false` → no `nextAt`. | World | Any status, text, default, snapshot or payload key differs. |
| AC-07 | R-6: register profile `team-ro`; a pulse whose audit step uses it snapshots its sha256 S1; `POST /v1/profiles` replaces `team-ro` (sha S2); a fire of the pulse offers the audit step with offer data `profile.sha256` = S1 and `StepOffer.profile.sha256` = S1, and the goal's `profiles["team-ro"].sha256` = S1. `mesh pulse add` from a repo preset file, then editing that file: the next fire's plan has the old steps and `goal.preset.text` = the old text (`presetText(parsePreset(<old file>))`, not the raw file bytes). `update` with a new preset → `version: 2`, new sha, the next fire uses it; `update` of `window` only keeps `version` and `profiles`. A step of a pulse goal whose profile is not in `goal.profiles` (added by a later plan) is not offered (`POST /v1/steps/:id/assign` → 409 with the documented guard text). | World + CLI | A run with the replaced profile, the repo's new text, a missed version bump, or an offer outside the snapshot. |
| AC-08 | Create-with-plan on a fire: the goal has `refs {pulse, slot}`, `preset.name`, `primaryRepo`, `profiles`, title `<pulse title> (<slot>)`, state `in_progress`; there is no `<G>.design` step; plan v1 is approved with `proposedBy` = `decidedBy` = owner and comment `pulse <id> (preset <name> <sha12>)`; the first step is `ready` and steps with `when` are `blocked`; events `goal.created` (with `pulse`, `slot`, `preset`), `plan.approved {version: 1}`, `step.ready` for the first step only; no inbox message to any session of the owner; the RL-2 lineage of the audit step is `audit-relay|<repo>|<agent>`. | World | A design step, another state or comment, a missing ref or event, or a `plan_approved` message. |
| AC-09 | Idempotent firing: two `w.tick()` at the same clock after `nextAt` → one slot row, one goal, one `pulse.fired`; two `HubService` instances on one store ticking concurrently (or two concurrent `tick()` calls) → one goal per slot; a slot row inserted before the tick (simulating another replica) → the tick creates no goal for it and still advances `nextAt`; a `duePulses` that returns a copy read before a pause (test: a store wrapper) → no slot row, and the pulse stays paused with no `nextAt`. | World (concurrent) | Two goals or two `pulse.fired` for one slot, a stuck `nextAt`, or a pause undone by the tick. |
| AC-10 | Overlap and abandon (every 1d, `maxGoalAge` 3d, default window 4h, an interactive run step, one machine M that auto-accepts): slot 1 fires G1, its run step is offered to M and claimed by M's session (`startedAt` set at the next tick); at slots 2 and 3 G1 is unfinished → `skipped`, reason `overlap`, `pulse.skipped {running: G1}`, no goal; at slot 4 (3 days after G1 was created) G1 is `dropped` (`goal.dropped {reason: "abandoned"}`, its claimed step `dropped` with `step.dropped {reason: "abandoned"}`), slot 1 becomes `abandoned`/`max_goal_age` (`pulse.abandoned`), and slot 4 fires G2. With `overlap: allow` slot 2 fires a second goal while G1 runs. A done G1 never blocks or gets abandoned. With no machine instead: slot 1 becomes `missed`/`no_machine` at slot 1 + 4h (G1 dropped, reason `missed`), slot 2 fires G2, and slot 1 is never `abandoned`. | World (clock) | A fire while overlapping, a skip with `allow`, an abandon before the age or of a never-started goal, a wrong slot state or reason. |
| AC-11 | Machine choice and retries (headless audit step, window 1h, offer_expiry 30 min → timeout 20 min; machines A and B both candidates, A ranked first by `suggest`, C offline, D lacking a target label): the fire offers to A (`tried [A]`), sets the goal's stick to A, and the headless offer's `deadline` = `min(at + offerExpiry, until)`; A declines → next tick offers to B (`tried` A `declined`, then B); with a timeout instead (no answer for 20 min) the tick withdraws A's offer (`step.offer_withdrawn`, reason `pulse: not accepted in time`, outcome `timeout`) and offers to B; with window 3h instead (timeout = offer_expiry = 30 min) A's offer ends `expired` through the existing expiry pass (`step.offer_expired`, no `step.offer_withdrawn`), outcome `timeout`, and B is offered in the same tick; while a person's open offer (`mesh assign`) to another machine E is open, the pulse offers to no one; an accepted offer that is released with note `capacity: …` → outcome `capacity`, next candidate offered; C and D are never offered; no machine is offered twice in one slot. When validate becomes ready after audit's done, it is offered to the stick's machine. | World | Another target, order, outcome, deadline or stick, a repeated machine, or an offer to C or D. |
| AC-12 | Missed reasons at window end, each with the goal dropped (`goal.dropped {reason: "missed"}`), any open offer withdrawn and `pulse.missed {reason, tried}`: no candidate ever → `no_machine`; A declined and no other → `not_accepted`; still offered to the last machine when the window ends → `not_accepted`; last try `capacity` → `capacity`; accepted (claimed) but no `run.started` → `expired`. A `run.started` report (or, interactive run step, a claim) before the window ends sets `startedAt`, and the slot never becomes `missed`. | World (clock) | Another reason, a goal left open, a started slot marked missed. |
| AC-13 | Downtime (every 1h, window 30 min, no machine, slots S0, S1, …): hub stopped 1 min before S0 (nothing fired yet), clock moved 5 h 11 min (now = S5 + 10 min), hub started, one tick → S5 `fired` (`until` = S5 + 30 min) and S0–S4 `missed`/`hub_down` with no goal. Moved 4 h 41 min instead (now = S4 + 40 min, 5 due slots) → 5 `hub_down` and no goal with `missed: record`; with `catch-up-once` S4 is `fired` with `catchUp: true` and `until` = `firedAt` + 30 min, and S0–S3 are `hub_down`. After 20 h down only the 10 latest `hub_down` rows are recorded. A slot fired before a stop whose window ended during it is `missed`/`no_machine` after the first tick, not `hub_down`. After each tick `nextAt` is the first slot after now. | World (`stopHub`/`startHubAgain`, clock) | A wrong count or state, a fired stale slot without `catch-up-once`, more than 10 rows, or a wrong `nextAt`. |
| AC-14 | Manual fire: `POST /v1/pulses/:id/fire` by the owner → 201 slot `manual:<ULID>`, `manual: true`, `by` owner, a goal; `nextAt` unchanged; a second fire while it runs → slot `skipped`/`overlap`; fire works on a paused pulse; another member → 403 documented text; an admin → 201; deleted or unknown pulse → 404 `no pulse <id>`. A manual goal blocks the next scheduled slot (overlap). | World | A different status, slot id form, state or text. |
| AC-15 | Lifecycle: pause → `enabled: false`, `pausedReason: "paused by <user>"`, no `nextAt`, ticks past slots record nothing; pause again → 409; resume → `nextAt` = first slot after now, no rows for the paused period; resume an active one → 409; `update` of `when` recomputes `nextAt` from the update time; `update` of `when` from every 7d to every 1d on a pulse created without `window`/`maxGoalAge` gives `windowMs` 4h and `maxGoalAgeMs` 2 days, and on one created with `window: 4h` then updated to every 30m keeps `windowMs` 4h; `delete` → 200, then GET 404, list leaves it out, a pending slot is no longer advanced, its goal stays. Owner-not-member: the owner's roles set to `[]` → the next due tick pauses the pulse with `pausedReason: "owner <owner> is not a member"` and `pulse.paused` (no user), no goal. Non-owner update/pause/resume/delete → 403. | World | A state, text, event or `nextAt` differs, or a slot recorded while paused. |
| AC-16 | Hidden goals: `GET /v1/goals` leaves out pulse goals, `?pulses=1` includes them (with the topic filter still applied); `GET /v1/live` `goals` leaves them out; `GET /v1/goals/:id` and attention (a failed step of a pulse goal) still show them; `mesh goal ls` vs `mesh goal ls --pulses`. | World + CLI | A pulse goal listed by default or missing with the flag, or missing from detail/attention. |
| AC-17 | Reads and scopes: `GET /v1/pulses` (`PulseView` without `preset.text` or profile settings; `recent` ≤ 10, newest first; `?mine=1` only the caller's), `GET /v1/pulses/:id` (`PulseDetail`: ≤ 50 slots newest first, `goals` maps each slot goal to its state). A service token with `goals:read` may call both GETs, not the POSTs (403); one with only `goals:write` may call `POST /v1/goals/from-preset`; one with only `goals:read` may not. | World | Wrong shape, order, filter, status or scope. |
| AC-18 | Ingest: `POST /v1/goals/from-preset` with the built-in `audit-relay` text and params → 201 `GoalDetail`: create-with-plan (no design step, plan comment `ingest (preset audit-relay <sha12>)`, owner = caller, `profiles` snapshotted), visible in `GET /v1/goals` by default (no `refs.pulse`); `refs.pulse` given → 400 documented text; sha mismatch → 400; a preset problem → 422 as AC-06. | World | A design step, a missing snapshot, a hidden goal, or a different status/text. |
| AC-19 | Built-in `audit-relay`: listed by `mesh preset ls`; `instantiate` with `agent`, `validator`, `filer` gives exactly the documented steps and policies; `validatePolicies` reports nothing; without `filer` → `preset audit-relay: unknown parameter {filer} in step file`. | unit + CLI | A step, dep, field or message differs. |
| AC-20 | CLI `mesh pulse`: `add` sends the documented body (preset text = `presetText`, sha256 of it, `source` only for a repo file, `params.repo` from `--repo`, `--tz` default = `Intl` zone) and prints the documented line; each exit-2 error text with no request sent; `ls` lines, empty text, `--json`; `show` first line and slot lines; `update` sends only the given fields; `pause`, `resume`, `fire` (fired and skipped), `rm` texts; a 403 from the hub → exit 1 with its text; `mesh help` lists `pulse`. | CLI | Other text, body, request or exit code. |
| AC-21 | Events: each `pulse.*` and `goal.dropped` event has exactly the documented fields and payload keys; no event payload or `mesh ledger export` output contains the preset text or a profile's settings (a unique marker in the preset brief and in a registered profile's `allow`); `GET /v1/live` activity has a line naming the pulse for `pulse.fired`, and the line for a `step.dropped` of a missed slot's goal names the missed slot, not `dropped by a new plan`. | World | A missing or extra key, a marker found, or no activity line. |
| AC-22 | End to end (agent-only `audit-relay`, fake `claude`): owner with a headless runner machine (accept `self`, repo `alpha` with agent files `auditor`, `checker`, `filer`) adds a pulse `--preset audit-relay --repo alpha --params agent=auditor,validator=checker,filer=filer --every 7d`; at `nextAt` the tick fires G1; `G1.audit` is offered to the runner, auto-accepted and run by the fake (its `--settings` profile hash = the pulse's `read-only` snapshot); the run session stores a report (`mesh_artifact`), a complete record with items A (S2) and B (S3), then `mesh_done` → slot `startedAt` set; `G1.validate` is offered to the runner through the stick and its run dismisses B and confirms A; `G1.file` runs (propose-via-branch, the fake commits) and records A `accepted` with a link; G1 is `done`; rounds of the three steps carry `telemetry`. A second slot 7 days later fires G2: audit repeats A and B with the same evidence → B stays `dismissed` (`fold.carried: 1`), A stays `accepted` with its link; `validate` and `file` are `skipped`; G2 is `done` without the filer running again. `GET /v1/pulses/p-1` shows two `fired` slots with `startedAt` and goals G1, G2; both goals are hidden from `GET /v1/goals` and shown with `pulses=1`. | World + fake claude | Any step not run, offered elsewhere, re-filed, a dismissal not carried, a missing telemetry or slot field, or a goal not done. |
| AC-23 | Web: the Mine page of the pulse owner has `section.pulses` with `div.pulse[data-pulse="<id>"]` for a pulse made through the API (one interactive step preset, `every 1d`) showing its title, `every 1d`, `active`; after two manual fires through the API, `li[data-slot]` with class `slot-fired` (with the goal id) and `slot-skipped` with text `(overlap)`; another user's pulse is not shown; a user without pulses sees the empty text. The e2e hub is shared: pulses are found by `data-pulse`, never counted. | Playwright (`pnpm test:web`) | A missing section, element, class or text, or a foreign pulse shown. |
| AC-24 | Compatibility: `POST /v1/goals` still creates a design step and its goal is listed by default; a goal without `profiles` offers a headless step with the live profile (RL-1); existing tick behaviour (pause of ended holders, offer expiry) is unchanged when no pulse exists. | World | A changed goal, offer or tick result. |
| AC-25 | `mesh hub migrate` (`test/m46-ops.test.ts` surface; Postgres when set): a SQLite hub with two pulses (one deleted) and three slots copies into Postgres with equal row counts for `pulse` and `pulse_slot`; after the copy `createPulse` gives `p-3`. | ops test (Postgres) | A missing table, a count mismatch or a reused id. |
| AC-26 | Docs: concepts, how-to, skill, plan API table and events list cover the Docs table; `MESH_SKILL` mentions pulse goals and equals `skills/mesh/SKILL.md`. No team-, company- or person-specific name is added to code or docs. | review + existing skill test | A missing section, row or mention, a skill mismatch, or a specific name. |
| AC-27 | `package.json` version is `0.1.17`; `pnpm check` passes (lint, typecheck, boundaries, test, build); `pnpm test:web` (after `pnpm build`) passes; `schemas/hub-api.openapi.json` matches `pnpm schemas` and lists the new routes with the documented rule and scope; `HUB_API` matches `src/hub/app.ts`; `parseCron`, `nextSlot`, `pulseCandidates` live in `src/core` (no hub or store imports there). | `pnpm check`, `pnpm test:web` + `test/schemas.test.ts` | Any check fails, a stale schema, a missing route, or a boundary violation. |
| AC-28 | Window equal to the period (every 30m, default window 30 min, no machine): ticks at S0, S1 and S2 (one run with each tick exactly at its slot, one run with each tick 20 s after its slot) → S0, S1, S2 `fired` with three goals, S0 and S1 `missed`/`no_machine` with their goals dropped, and no slot `skipped`. | World (clock) | A `skipped` slot, fewer than three goals, or a missed slot whose goal stays open. |
| AC-29 | Fire errors and deleted topics: pulses p-1 (topic `t`) and p-2 due at the same slot; `POST /v1/topics/t/delete` → p-1's `topics` lose `t`, event `pulse.updated {fields: ["topics"]}`, `version` unchanged; the tick fires both. A fire that throws (test: a store wrapper whose goal insert throws for p-1's goal) → p-1's slot `missed`, reason `error`, `error` = the message, no goal, `pulse.missed {reason: "error", error}`, p-1's `nextAt` advanced; p-2 fires in the same tick; the next tick does not retry p-1's slot. A manual fire that throws → 201 with that `missed` slot; `mesh pulse fire` prints `Pulse <id> missed slot <slot>: <error>` and exits 1. | World + CLI | No slot row, a retried slot, a stuck `nextAt`, p-2 not fired, the topic kept on p-1, or another status, text or exit code. |

## Open questions

- 2026-11-12 **`audit-relay` is agent-only in S3.** `mode: debrief` and `assignee` arrive with S4, so
  the built-in has no debrief step; following design §5.6 ("agent-only: omit debrief, then file
  consumes confirmed"), `file` consumes `[confirmed]`. Assumed: `file` has `output: review-record` and
  `may_set: [accepted]` so it records each filed item `accepted` with its link; without that, a
  repeated confirmed item would be filed again at every slot. S4 adds the debrief step (and may move
  `file` back to `consumes: [accepted]`).
- 2026-11-12 **Profile snapshot shape.** Design §5.5 stores `{text, sha256}` per profile; RL-1 already
  has `ProfileSnapshot` (name, base, sha256, compiled settings), which is what an offer sends, so the
  pulse stores that. The snapshot is taken by the hub (profiles live on the hub); the preset text is
  sent by the CLI (the hub cannot read repos).
- 2026-11-12 **Agent definitions are not pinned in S3.** R-6 names the agent definition too; the run
  still reads `<repo>/.claude/agents/<name>.md` from the run's worktree (RL-1). Pinning by hash comes
  with the roster (S5).
- 2026-11-12 **One first step.** "Offers its run step" is read as: the plan has exactly one step
  without deps (not a gate); later steps reach the same machine through the goal's `stick` (MM-3),
  which the pulse sets on each offer it makes. A later step whose offer is declined stays `ready` as
  today; only the first step has the window and retries.
- 2026-11-12 **When a slot is "started".** Headless run step: a `run.started` report; interactive:
  a claim. A slot missed after an accept (`expired`) drops its goal even though a daemon may still
  start the queued run; RL-1's queued-run release normally comes first because the offer deadline is
  cut to the window end.
- 2026-11-12 **Missed slots drop their goal** (reason `missed`). Otherwise a never-started goal would
  block the following slots until `maxGoalAge`. Dropping a goal is new (no route drops a goal today);
  it is internal to pulses in S3.
- 2026-11-12 **Downtime rule.** Rather than detecting "downtime", the tick treats a slot as
  firable only within `window` of its due time; every other due slot is `hub_down`. A tick delayed by
  less than the window (normal, 30 s) fires normally. `catch-up-once` fires the latest due slot when
  none is within the window.
- 2026-11-12 **Defaults.** `window` = min(4h, period) (design example "4h"); `maxGoalAge` = 2 × period
  (design); cron period = the gap between the first two slots after saving. `every` is 5m..366d. First
  `every` slot: without `at`, one period after the save time (no fire at creation; `mesh pulse fire`
  runs one now); with an `at` in the future, `at` itself, however far ahead (revision 2, review F5:
  revision 1 counted back from the anchor over all integers k, which ran weeks before the requested
  start). A cron's minimum period (5 min) is measured as its period is, between the first two slots
  after the save time.
- 2026-11-12 **CLI `--params`.** Design §5.5 writes `--param k=v …`; the CLI flag parser has no
  repeated flags, so `mesh pulse` uses RL-1's `--params k=v,k2=v2`, plus `--repo`.
- 2026-11-12 **Deleted pulses** keep their row (`deletedAt`) so ids are never reused (goals keep
  `refs.pulse`); `mesh pulse rm` is a soft delete.
- 2026-11-12 **Manual fire** is allowed on a paused pulse (a person asked for it) and counts for overlap.
- 2026-11-12 **Ingest scope.** `artifacts[]` (design §5.5) and `refs.subject` in the lineage (design
  OQ-1 default) are left to PR intake: no S3 criterion needs them and an artifact needs a step round
  that does not exist yet at creation. Ingest goals are not hidden (they are not pulse goals).
- 2026-11-12 **TUI.** REQ-2 asks for missed slots in the TUI; the brief for this row names the CLI and
  the web Mine page only. `mesh pulse ls`/`show` show them. The TUI view is left to slice S4 (Debrief),
  which already changes the TUI's Mine view ("Assigned to you"); its spec should carry a criterion for
  missed slots in the TUI.
- 2026-11-12 **Advance before fire** (revision 2, review F1). The tick ends pending slots whose window
  is over before it fires new ones, and a fire retires them too, so a window equal to the period never
  makes the next slot `skipped`. The window runs from the slot's due time (`until` = `at + windowMs`),
  not from the tick that fired it, so a tick a few seconds late does not push the window past the next
  slot; a manual or catch-up slot's window runs from its fire time.
- 2026-11-12 **Only a started goal is abandoned** (revision 2, review F2). A goal whose run step never
  started is ended by its window (`missed`), which is always shorter than a useful `maxGoalAge`.
  Abandon uses `now − createdAt >= maxGoalAgeMs` (revision 1 said `>`), so a goal created at slot 1
  of a daily pulse with `maxGoalAge` 3d is abandoned exactly at slot 4.
- 2026-11-12 **Fire errors** (revision 2, review F4). A fire that throws records its slot `missed`,
  reason `error` (new `SlotReason`), with the message, and still advances `nextAt`, so REQ-2's "every
  slot recorded" holds and a broken pulse does not retry forever. Deleting a topic also removes it from
  pulses (event `pulse.updated`), so a deleted topic does not break every later fire. The tick now uses
  one transaction per pulse (revision 1: per slot), so that the hub_down rows, the fired slot and
  `nextAt` commit together and an error rolls them back together.
- 2026-11-12 **Concurrent pulse writes** (review F6). Every pulse write re-reads the row in its
  transaction; the tick writes only `nextAt` and skips a pulse that changed since `duePulses` read it.
- 2026-11-12 **Offers made by a person.** A run step that a person offered elsewhere (`mesh assign`)
  while its slot is pending is left alone until that offer ends; the window still applies.
- 2026-11-12 **Ingest and `goals:write`** (review F8). Design §5.5 names `goals:write`, so the route
  uses it. This widens that scope: today a service token with `goals:write` can create a goal but not
  propose or approve a plan; through ingest it gets an approved plan, decided by the service user, with
  any registered profile and agent name. Ingest goals are not offered automatically (no stick, no pulse
  attempt), so a person or a machine policy still has to take the steps. A separate `goals:ingest`
  scope that an admin grants on purpose is the alternative if this is not wanted.
- 2026-11-12 **Repo preset lookup.** `mesh pulse add` finds a repo preset from the current directory
  (as `mesh goal plan --preset` does), not from `--repo`; run it from the repo whose preset you want.
- 2026-11-12 **Owner membership** is read as: the owner's user row has one of the roles `member`,
  `approver`, `admin`.
