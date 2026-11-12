# RL-3 implementation plan: Pulse scheduling and ingest

Spec: `docs/specs/RL-3.md` (revision 2, approved in review round 2). Branch: `feat/relay-design`.
Release v0.1.17. Design: `docs/analysis/2026-11-12-pulse-relay-roster.md` §4 R-6, §5.5, §5.6, §5.9.

This plan covers the implementation only. It plans no new tests: the test side writes them from the
spec's contracts and never reads this plan. Section "Existing tests and generated files" lists every
existing test and generated file whose asserted behaviour the spec changes, and nothing else.
Section "Plan-level decisions" records the choices this plan makes where the spec leaves room; the
spec itself is not changed by this plan.

## 0. Overview, build order, shared building blocks

Bottom-up along `.dependency-cruiser.cjs` (`protocol` ← `core` ← `store` ← `hub`; `cli` imports
`protocol`, `core`, `auth`; `web/` imports protocol types only). `src/protocol` imports nothing
internal, so anything the zod refinements need (duration parsing) lives in protocol and core
re-exports or wraps it. `src/hub` may not spawn processes; only `src/cli` runs `git`.

| Stage | Module | Work | Criteria |
|---|---|---|---|
| 1 | `src/protocol` | New `pulse.ts` (all zod types and interfaces of the Types table, `durationMs`); `goal.ts` (`Goal.profiles`); `hub.ts` (`GoalFromPreset`); `hub-api.ts` (9 rows + `pulses` query on `GET /v1/goals`); `index.ts` export; `skill.ts` (`MESH_SKILL`) | AC-01, AC-17, AC-26, AC-27 |
| 2 | `src/core` | New `schedule.ts` (cron, time zones, `nextSlot`, `periodMs`, `scheduleText`, `parseDurationSpec`, `validTimeZone`); new `pulse.ts` (`pulseCandidates`, `manualSlot`, `ulid`); `presets.ts` (`audit-relay`); `index.ts` | AC-02, AC-03, AC-04, AC-19 |
| 3 | `src/store` | Migration 10 (both dialects); `LOCKS.pulses`; `Dialect.binary`; pulse and slot methods; `hub-copy.ts` `TABLES` | AC-05, AC-25 |
| 4 | `src/hub` | `service.ts`: preset validation, snapshots, create-with-plan (shared with `approvePlan`), pulse CRUD, tick advance + fire, manual fire, drop goal, offers from `goal.profiles`, `releaseStep`/`runReport` hooks, `deleteTopic`, goal lists, `describe()`; `app.ts`: 9 routes + `pulses` query | AC-06 – AC-18, AC-21, AC-22, AC-24, AC-28, AC-29 |
| 5 | `src/cli` | New `pulse-commands.ts` (`mesh pulse …`); `hub-commands.ts` (`findPresetSource`, registration, `goal ls --pulses`) | AC-20, AC-16, AC-29 |
| 6 | `web/` | `api.ts` `pulses()`; `mine.tsx` `Pulses` section; `styles.css` | AC-23 |
| 7 | repo | Docs; `package.json` 0.1.17; `pnpm schemas`; adjust the listed existing tests; full check | AC-26, AC-27 |

Order constraints:
- Stage 1 first. `pulse.ts` imports `Label` from `./session.ts` and `ProfileSnapshot` from `./goal.ts`;
  `goal.ts` must not import `pulse.ts` (no-circular). `GoalFromPreset` in `hub.ts` imports
  `PresetSnapshot`/`PulseParams` from `./pulse.ts` (pulse.ts must not import hub.ts).
- Stage 2 before 3–5 (`schedule.ts` before `pulse.ts`: the hub and CLI use both).
- Stage 3 before stage 4.
- Inside stage 4: the create-with-plan extraction (B4) and the `headlessGuard` change (AC-07) before
  the pulse code; the tick (AC-09–AC-13, AC-28) after pulse CRUD (AC-06, AC-15).
- Stage 5 and 6 need the stage-4 routes to run (they compile against protocol types only).
- `pnpm schemas` after the last change to `src/protocol` (`HUB_API`, `MESH_SKILL`): it rewrites
  `schemas/hub-api.openapi.json` and `skills/mesh/SKILL.md`.
- Docs and the version bump last.

Blast radius summary:
- One hub migration (10) on both dialects, two new tables, no change to existing tables or rows.
- `Goal` gains an optional field; goals without it parse and behave as before.
- `HubService.tick()` gains two passes after the existing transaction; with no pulse they read one
  empty indexed query each and write nothing (AC-24).
- `headlessGuard` gains a `goal` parameter; for goals without `profiles` the result is unchanged.
- `approvePlan` is refactored to share its "materialize, settle, save, emit" tail with
  create-with-plan; its observable behaviour (events, order, messages) must stay identical.
- `listGoals`/`live` filter pulse goals; no existing goal has `refs.pulse` (the key was free-form, so
  a hand-made goal with `refs.pulse` would now be hidden; see Plan-level decisions).
- `step.dropped` gains an optional payload `reason`; `describe()` changes only when it is present.
- `deleteTopic` additionally rewrites pulses.
- Nine new hub routes; `GET /v1/goals` gains a query parameter; existing bodies unchanged.
- `mesh help` gains `pulse`; `mesh preset ls` lists a third built-in.
- `BUILTIN_PRESETS` gains `audit-relay` (code that loops over the built-ins and instantiates them
  without params now meets a preset that needs `agent`, `validator`, `filer`).

### B1. Protocol (`src/protocol/pulse.ts`, new; `export * from "./pulse.ts"` in `index.ts`)

Declaration order (each uses only earlier ones): `DURATION_RE`, `durationMs(s): number | undefined`
(`m` → 60 000, `h` → 3 600 000, `d` → 86 400 000; `undefined` when it does not match),
`PulseId`, `DurationSpec`, `PulseWhenInput`, `PulseWhen`, `PresetSnapshot`, `PulseParams`
(`z.record(key regex, z.string().max(300)).refine(r => Object.keys(r).length <= 20, …)`), `PulseTarget`,
`PulseFields` (the strict object of `PulseCreate` **without** defaults and refinements), `PulseCreate`,
`PulseUpdate`, `SlotState`, `SlotReason`, `SlotTry`, `PulseSlot`, `Pulse`, `PulseView`,
`PulseDetail`, `FireResult`. Export every zod value and its `z.infer` type under one name, as
`goal.ts` does.

- `PulseWhenInput` = `z.union([z.object({cron, tz}).strict(), z.object({every: DurationSpec, at:
  z.number().int().min(0).optional()}).strict()])`. `PulseWhen` the same with `anchor` (required) in
  place of `at`.
- `PulseCreate` = `PulseFields.extend({ target: PulseTarget.default({}), overlap: ….default("skip"),
  missed: ….default("record"), enabled: z.boolean().default(true) }).superRefine(ranges)`.
- `PulseUpdate` = `PulseFields.omit({ enabled: true }).partial().superRefine((v, ctx) => { ranges(v,
  ctx); if (Object.keys(v).length === 0) ctx.addIssue("give at least one field to change") })`. Built
  from `PulseFields` (not from `PulseCreate`) so no default fills an absent field: an update must
  send only what was given.
- `ranges`: `every` (when `when` has it) `durationMs` in [5 min, 366 d] else issue `every is 5m to
  366d` at path `when.every`; `window` in [1 min, 30 d] → `window is 1m to 30d`; `maxGoalAge` in
  [1 h, 366 d] → `maxGoalAge is 1h to 366d`.
- `PulseSlot.slot` = `z.string().refine(s => ISO_RE.test(s) || /^manual:[0-9A-HJKMNP-TV-Z]{26}$/.test(s))`;
  `tried: z.array(SlotTry).default([])`; `error: z.string().max(500).optional()`.
- `Pulse.profiles` = `z.record(z.string(), ProfileSnapshot)`.
- Keep `PulseFields`, `PulseCreate`, `PulseUpdate` as top-level zod objects with `superRefine` only
  (zod 4 refuses `.omit/.partial` on an object that carries refinements; that is why the
  refinements are attached last). `hubOpenApi` serialises them with `unrepresentable: "any"`.

### B2. Core (`src/core/schedule.ts` and `src/core/pulse.ts`, new; exported from `src/core/index.ts`)

Pure. `schedule.ts` imports only `../protocol/index.ts` (`PulseWhen`, `durationMs`). `pulse.ts`
imports `./suggest.ts`, `./offers.ts` and `node:crypto` (`randomBytes`, already used by `src/core`).

`schedule.ts`:
- `parseDurationSpec(s)` = `durationMs(s)` or throw the documented text.
- `type Cron = { minute: Set<number>; hour: Set<number>; dom: Set<number>; month: Set<number>; dow:
  Set<number> /* 7 folded to 0 */; domStar: boolean; dowStar: boolean }` (exported type).
- `parseCron(expr)`: `expr.trim().split(/\s+/)`; length ≠ 5 → the field-count text. Per field
  (`FIELDS = [["minute",0,59],["hour",0,23],["day-of-month",1,31],["month",1,12],["day-of-week",0,7]]`):
  split on `,`; each item matches `^(\*|\d+(?:-\d+)?)(?:\/(\d+))?$` else `bad <field> field "<text>"`;
  `a-b` with a > b → bad field; step 0 → bad field; numbers out of range → `<field> value <n> is out of
  range <min>-<max>` (first offending number, left to right); `n/s` → `n..max/s`. `*Star` = the field
  text starts with `*`.
- `validTimeZone(tz)`: `try { new Intl.DateTimeFormat("en-US", { timeZone: tz }); return true } catch { return false }`.
- Wall-clock helpers (module-private): a cached `Intl.DateTimeFormat("en-US", {timeZone, hourCycle:
  "h23", year, month, day, hour, minute, weekday})` per zone; `wallOf(t, tz)` → `{y, mo, d, h, mi,
  dow}`; `wallKey(w)` = `Date.UTC(y, mo-1, d, h, mi)` (a "local epoch"); `offsetAt(t, tz)` =
  `wallKey(wallOf(t)) − floor(t / 60 000) · 60 000`.
- `instantOf(W, tz)` for a wall minute `W` (local epoch): candidates `W − offsetAt(W − 86 400 000)`
  and `W − offsetAt(W + 86 400 000)`; the valid ones are those whose `wallKey(wallOf(c)) === W`;
  return the smallest valid (first occurrence in an overlap). None valid (a gap): the transition
  instant, found by scanning minutes upward from `min(candidates)` to `max(candidates)` for the first
  `t` with `offsetAt(t)` equal to the later offset (≤ a few hundred steps) — that is the first
  existing wall minute after the gap.
- `nextSlot(when, after)`:
  - every: `anchor > after` → `anchor`; else `anchor + (floor((after − anchor) / p) + 1) · p`.
  - cron: walk wall dates in `tz` from the wall date of `after − 1 day` for at most `5 · 366 + 2`
    days; per date check month, then day matching (Vixie: both restricted → dom OR dow; else AND);
    for a matching date, for each hour, minute in ascending order compute `instantOf`; return the
    first instant `> after` (the mapping is monotone in wall time, so the first hit is the minimum
    and coinciding gap slots collapse into one). `undefined` after the horizon.
  Day stepping uses `Date.UTC(y, mo-1, d+1)` on the local-epoch calendar (no time zone involved);
  day of week of a wall date from `new Date(Date.UTC(y, mo-1, d)).getUTCDay()`.
- `periodMs(when, from)`: every → `durationMs`; cron → `a = nextSlot(from)`, `b = a && nextSlot(a)`,
  `b − a`; `undefined` when either is.
- `scheduleText(when)`: `every <every>` / `cron "<cron>" <tz>`.

`pulse.ts`:
- `ulid(now, rand = randomBytes(10))`: the exact algorithm of `HubService.newArtifactId` without the
  prefix and without the monotonic state (Crockford alphabet, 10 time + 16 random characters).
  `manualSlot(now, rand?)` = `` `manual:${ulid(now, rand)}` ``. `newArtifactId` stays as it is
  (no refactor in this row).
- `pulseCandidates(o)`: `callerNicknames` = nicknames of `o.machines` with `userId === o.owner`;
  `suggest({caller: o.owner, callerMachine: undefined, now, onlineMs, repos: [o.repo], topics,
  any: false, machines, callerNicknames, sessions})`; then filter, keeping order: `online && auto`;
  `byId.get(s.machine)` carries every `target.labels`; `headless` → machine `headless === true`;
  `!tried.has(s.machine)`; `target.machines` non-empty → some entry equals `m.id`, or
  `` `${m.userId}/${m.nickname}` `` (nickname set), or (`m.userId === owner`) `m.nickname`.

## AC-01 Schemas

Files: `src/protocol/pulse.ts` (B1), `src/protocol/goal.ts`, `src/protocol/hub.ts`, `src/protocol/index.ts`.

Changes:
- `goal.ts`: `Goal` gains `profiles: z.record(z.string(), ProfileSnapshot).optional()` after
  `stick`. `ProfileSnapshot` is declared later in the file (line ~179) than `Goal` (line ~56): move
  the `ProfileName`/`ProfileBase`/`ProfileSettings`/`ProfileSnapshot` declarations above `Goal`, or
  use `z.lazy(() => ProfileSnapshot)`; prefer moving (no lazy in a stored schema).
- `hub.ts`: `GoalFromPreset = z.object({ preset: PresetSnapshot.omit({ source: true }), params:
  PulseParams, title: z.string().min(1).max(200).optional(), topics: z.array(z.string().max(40)).max(20).optional(),
  refs: NewGoal.shape.refs, priority: z.number().int().min(0).max(9).default(3) }).strict()`.

Order: `goal.ts` move → `pulse.ts` → `hub.ts` → `index.ts`.

Blast radius: existing goals parse unchanged; `Goal` is not part of any published JSON schema
(`jsonSchemas()` lists ledger and event schemas only), so only the OpenAPI document changes.

Risks: the default-free `PulseFields` is load-bearing for AC-15/AC-20 (`update` sends only given
fields; `version`/`fields` computed from body keys). `PulseParams` with 21 keys must fail: the
`.refine` on the record is evaluated after key validation, which is fine for the spec's cases.

## AC-02 Cron parsing and `nextSlot` vectors

Files: `src/core/schedule.ts` (B2), `src/core/index.ts`.

Changes: B2 as written. The error texts are the spec's, verbatim; the out-of-range check runs on each
number of an item before the step is applied.

Risks:
- `Intl.DateTimeFormat` with `hourCycle: "h23"` still prints `24` for midnight on some ICU builds
  when `hour12: false` is used; use `hourCycle: "h23"` (not `hour12`) and normalise `24` → `0`
  defensively.
- Gap mapping must give `2026-03-29T01:00:00Z` for `30 2 * * *` Europe/Berlin (the transition instant),
  not `01:30Z`; overlap must give the first occurrence only. The `instantOf` rule above covers both.
- Performance: a never-firing cron scans ~1 830 dates with a cheap date check each; a busy cron returns
  on the first date. `periodMs` calls `nextSlot` twice.

## AC-03 `every`, `periodMs`, `scheduleText`, `parseDurationSpec`

Files: `src/core/schedule.ts`.

Changes: B2. `nextSlot(every, A − 1)` = `A` (anchor in the future), `nextSlot(A)` = `A + p` (k ≥ 1).

Risks: none beyond integer arithmetic (all values < 2^53).

## AC-04 `pulseCandidates`, `manualSlot`

Files: `src/core/pulse.ts` (B2), `src/core/index.ts`.

Changes: B2. The suggestion→machine lookup is a `Map` of `o.machines` by id. Labels are compared
exactly (labels are already normalised by MM-2).

Blast radius: none (new module). `suggest` is unchanged; its rank order is kept by filtering only.

Risks: an extra target label never changes order because it is never passed to `suggest` as a topic.

## AC-05 Store: migration 10, pulses and slots

Files: `src/store/hub-store.ts`, `src/store/dialect.ts`, `src/store/index.ts` (re-export types if the
index lists them).

Changes:
- `dialect.ts`: `LOCKS.pulses = 0x6d657368_0006`. `Dialect.binary(col)`: SQLite → `col`, Postgres →
  `` `${col} COLLATE "C"` `` (code-point order for `slot DESC`; Postgres's default collation is not
  code-point order).
- `HUB_MIGRATIONS` gains (comment `// v0.1.17 (RL-3): pulses and their slots.`):
  `CREATE TABLE IF NOT EXISTS pulse (id TEXT PRIMARY KEY, num INTEGER NOT NULL UNIQUE, owner TEXT NOT
  NULL, enabled INTEGER NOT NULL, next_at INTEGER, value TEXT NOT NULL, updated_at INTEGER NOT NULL);
  CREATE TABLE IF NOT EXISTS pulse_slot (pulse TEXT NOT NULL, slot TEXT NOT NULL, at INTEGER NOT NULL,
  state TEXT NOT NULL, goal TEXT, started_at INTEGER, value TEXT NOT NULL, updated_at INTEGER NOT NULL,
  PRIMARY KEY (pulse, slot)); CREATE INDEX IF NOT EXISTS pulse_slot_pending ON pulse_slot (state,
  started_at); CREATE INDEX IF NOT EXISTS pulse_slot_goal ON pulse_slot (goal); CREATE INDEX IF NOT
  EXISTS pulse_due ON pulse (enabled, next_at);`. `HUB_MIGRATIONS_PG`: the same with `BIGINT` for
  `next_at`, `updated_at`, `at`, `started_at`. (`IF NOT EXISTS`: see Plan-level decisions.)
- `HubStore` (section `// ---------- pulses (RL-3) ----------`):
  - `createPulse(p)`: `this.tx`: `this.lock("pulses")`; `num = MAX(num) + 1` (deleted rows stay, so
    ids are never reused); `Pulse.parse({...p, id: \`p-${num}\`})`; INSERT with `enabled ? 1 : 0`,
    `next_at = nextAt ?? null`.
  - `getPulse(id)` (`WHERE id = ?`), `savePulse(p)` (`UPDATE pulse SET owner, enabled, next_at,
    value, updated_at WHERE id`), `listPulses(f)` (`ORDER BY num`; `owner = ?` when given; deleted
    filtered in JS on `deletedAt`, kept only with `deleted: true`), `duePulses(now)` (`WHERE enabled =
    1 AND next_at IS NOT NULL AND next_at <= ? ORDER BY num`, then drop parsed rows with `deletedAt`).
  - `addSlot(s)`: `PulseSlot.parse`; `INSERT … ON CONFLICT (pulse, slot) DO NOTHING`; `changes === 1`.
  - `getSlot`, `saveSlot` (`UPDATE … SET at, state, goal, started_at, value, updated_at`),
    `listSlots(f)`: where `pulse = ?`, `state = ?`, `pending` → `state = 'fired' AND started_at IS
    NULL`; `ORDER BY at DESC, ${binary("slot")} DESC`; `LIMIT ?` when given. `updated_at` = `decidedAt`
    or the caller's now (pass through the value: use `s.decidedAt`).

Order: dialect → migrations → methods.

Blast radius: schema version 9 → 10 (every place comparing it: see "Existing tests"). `/readyz`
reports 10. `HubStore.SCHEMA_VERSION` is derived from the list length.

Risks: Postgres `ON CONFLICT (pulse, slot)` needs the primary key (present). `num` must be read under
the lock inside the same transaction as the INSERT (two replicas).

## AC-06 `POST /v1/pulses`: validation, defaults, snapshots

Files: `src/hub/service.ts`, `src/hub/app.ts`, `src/protocol/hub-api.ts`.

Changes (service, new section `// ---------- pulses and ingest (RL-3) ----------`):
- `private async presetProblems(preset, params): Promise<{ plan: PlanInput; first: PlanStep }>`:
  the spec's steps 1–7 in order. Step 1 compares `createHash("sha256").update(preset.text,
  "utf8").digest("hex")` and throws `HubError(400, …)`. Steps 2–7 collect `problems`; steps 3 and 4
  stop collecting (return the problems so far). Step 6 counts steps with `deps.length === 0`; text
  uses `<name>` = `preset.name`. Step 7 uses `profileNames(plan.steps)` (below) and `resolveProfile`,
  naming the first step that uses each unknown name. Any problem → `HubError(422, \`the preset has
  ${k} problem(s): ${problems.join("; ")}\`, problems)`.
- `profileNames(steps)` (module function in service.ts, or exported from `src/core/pulse.ts` as a
  pure helper): `s.profile ?? (s.mode === "headless" ? HEADLESS_DEFAULTS.profile : undefined)`,
  sorted unique.
- `private async snapshotProfiles(steps): Promise<Record<string, ProfileSnapshot>>` via
  `resolveProfile`.
- `private scheduleOf(input: PulseWhenInput, now): PulseWhen` + checks: cron → `parseCron` (422 `bad
  cron "<expr>": <error>`), `validTimeZone` (422 `unknown time zone "<tz>"`), `nextSlot(when, now)`
  undefined → 422 `cron "<expr>" never fires`, `periodMs < 300 000` → 422 `cron "<expr>" fires more
  often than every 5m`; every → `{every, anchor: at ?? now}`.
- `private timings(p, now)`: `period = periodMs(when, now)`; `windowMs = window ? parseDurationSpec(window)
  : min(4h, period)`; `maxGoalAgeMs = maxGoalAge ? parse : 2 · period`.
- `async createPulse(actor, body: PulseCreate): Promise<PulseView>`: in `goalTx`: validation order
  sha → preset problems → topics (`knownTopics`, 400) → schedule; build the `Pulse` (owner = caller,
  title default `` `${preset.name} on ${repoName(params.repo)}` `` (`repoName` of RL-2 core), version 1,
  `nextAt` only when enabled); `store.createPulse` (takes `LOCKS.pulses`); event `pulse.created`
  `{pulse, title, preset: name, sha256, schedule: scheduleText}`; return `this.pulseView(p)`.
- `private async pulseView(p)`: strip `preset.text` and profile settings; `schedule`; `recent =
  listSlots({pulse: p.id, limit: 10})`.
- app.ts: `r("POST", "/v1/pulses", "member", async (c, a) => c.json(await svc.createPulse(a, await
  body(c, PulseCreate)), 201))`.
- hub-api.ts: row `{ POST /v1/pulses, rule member, tag goals, body PulseCreate, status 201 }`.

Order: profile helpers → validation → create → route.

Blast radius: none outside the new routes. `resolveProfile` is reused unchanged.

Risks: `repoName` must accept `org/repo` and plain names (RL-2 helper does). The event payload must not
carry `text` (AC-21).

## AC-07 R-6 snapshots; offers from `goal.profiles`; CLI preset text

Files: `src/hub/service.ts`, `src/cli/pulse-commands.ts`, `src/cli/hub-commands.ts`.

Changes:
- `headlessGuard(step, machine, goal?: Goal)`: after the machine check, when `goal?.profiles` is set:
  `snap = goal.profiles[name]`; missing → `{ok: false, error: \`${step.id}: profile ${name} is not in
  the goal's snapshot\`}`; else `{ok: true, snapshot: snap}`. Without `goal.profiles`: unchanged
  (live resolve). Callers pass the goal: `assignStep` (fetch `goal` before the guard — it is fetched
  after today), `assignGoal`, `emitReady`, and the pulse attempt.
- Pulse update with `preset` or `params` in the body re-runs `presetProblems` and
  `snapshotProfiles` and sets `version + 1`; other fields never touch `preset`, `profiles`,
  `version` (AC-15 section).
- Create-with-plan copies `pulse.profiles` into `goal.profiles` (B4).
- CLI: `presetText(<preset>)` is what `mesh pulse add` sends for both a repo file and a built-in, so
  the stored text is `presetText(parsePreset(<file>))` (AC-20 section).

Blast radius: `assignStep` reorders two reads (goal before guard) — no behavioural change. Offers of
non-pulse goals unchanged.

Risks: `emitReady` currently resolves profiles live for stick offers; for a pulse goal it must use
the snapshot, else `validate`/`file` would run with a replaced profile.

## AC-08 Create-with-plan on a fire

Files: `src/hub/service.ts`.

### B4. Shared tail of `approvePlan`

Extract from `approvePlan`, unchanged in effect, `private async applyApproved(actor: { userId: string }
| Actor, goal: Goal, plan: Plan, existing: Step[], now: number, m: Materialized): Promise<void>` = the
lines from `endOffersLeavingReady(existing, changes, now)` to the `changedForHolder` messages. Keep
the design-step round, `step.done` and `plan_approved` message in `approvePlan` before the call.
`approvePlan` passes `changes = [...m.upserts, designDone?]`; the helper takes `changes` as a
parameter. Event order of `approvePlan` stays byte-for-byte the same.

### `createWithPlan`

`private async createWithPlan(o: { owner: string; title: string; preset: PresetSnapshot; params;
profiles; topics: string[]; priority: number; refs?: Record<string,string>; comment: string; extra:
Record<string, unknown> /* goal.created payload extras */ }): Promise<Goal>` — called inside the
caller's `goalTx`:
1. `store.createGoal({ title, ownerId: owner, state: "in_progress", primaryRepo: params.repo, preset:
   {name, text}, profiles, topics?, priority, refs?, createdAt: now, updatedAt: now })`. No design step.
2. `plan = instantiate(parsePreset(name, text), { repo: params.repo, goal: goal.id, params })`;
   `store.savePlan({ goal, version: 1, steps, acs?, proposedBy: owner, proposedAt: now, decision:
   "approved", decidedBy: owner, decidedAt: now, comment })`.
3. event `goal.created` (user owner; payload `{title, preset: name, ...topics?, ...extra}`), then
   `m = materialize(goal.id, 1, plan.steps, [], now)` and `applyApproved({userId: owner}, goal, plan,
   [], now, m.upserts)` — it saves steps, settles `when` steps, sets `in_progress`/`done`, emits
   `plan.approved {version: 1}`, `step.ready` (first step), `step.skipped`, `goal.done` when complete.
   No `message(...)` call: there is no design session (no `plan_approved`).
4. Return the stored goal.

Fire comment: `` `pulse ${id} (preset ${name} ${sha256.slice(0, 12)})` ``; title `` `${pulse.title}
(${slot})` ``; refs `{pulse, slot}`; extra `{pulse, slot}`; priority 3.

Order: B4 refactor first (run the existing suites to see it is behaviour-preserving), then
`createWithPlan`.

Blast radius: `approvePlan` refactor touches the most-used write path of the hub.

Risks: `goal.created` must precede `plan.approved` and `step.ready` (AC-08 lists them in that order);
the event for `goal.created` is emitted before `applyApproved`. Lineage (RL-2) reads `goal.preset.name`
— set in step 1.

## AC-09 Idempotent firing

Files: `src/hub/service.ts`.

Changes — `private async fireDue(): Promise<void>` called from `tick()` after `advancePending()`:
- `for (const seen of await store.duePulses(now))`: `try { await this.goalTx(() =>
  this.firePulseTx(seen.id, now)) } catch (e) { await this.goalTx(() => this.firePulseTx(seen.id, now,
  errorText(e))) }` and a throw of the second is caught per pulse, written to stderr as `hub tick
  failed: …` (as `server.ts` does) so the next pulse still runs.
- `firePulseTx(id, now, error?)`: `p = getPulse(id)` (re-read); `!p.enabled || p.deletedAt ||
  p.nextAt === undefined || p.nextAt > now` → return. Owner check (AC-15). Due slots: `t = p.nextAt`;
  collect into a ring of the last 11 while `t !== undefined && t <= now` (`t = nextSlot(when, t)`); for
  `every` compute the count arithmetically and generate only the last 11. `L` = last. `L` fires when
  `now − L < windowMs` or `missed === "catch-up-once"` (then `catchUp: true`). Rows: every other
  due slot (at most 10 newest) and `L` when it does not fire → `addSlot({state: "missed", reason:
  "hub_down", tried: [], decidedAt: now})` (ignore `false`). `L` fires through `fireSlot` (AC-10), or,
  with `error` set, is `addSlot`ed `missed`/`error`/`error: error.slice(0,500)` with event
  `pulse.missed`. Finally `savePulse({...p, nextAt: nextSlot(when, now), updatedAt: now})` only the
  `nextAt`/`updatedAt` fields of the re-read row.
- `fireSlot(p, slot, at, now, o: {manual?, by?, catchUp?})`, step 1 of the spec: `addSlot` inserts the
  row first, as `state: "fired"` without `goal` and with `decidedAt: now`; steps 2–5 (AC-10) then
  `saveSlot` its final state in the same transaction. `false` → stop (another replica or a retry
  fired it). A row inserted this way is never visible half-done: the transaction commits or rolls
  back as a whole. Because a placeholder is `fired` without `startedAt`, the retire step (AC-10)
  excludes this slot by id.

Blast radius: none for hubs without pulses.

Risks:
- Unique `(pulse, slot)` plus `goalTx`'s `serialize()` make two replicas/concurrent ticks create one
  goal; the re-read inside the transaction defeats a stale `duePulses` copy (paused pulse stays
  paused).
- The first transaction's rollback must undo the slot row, the hub_down rows and the goal; nested
  `store.tx` calls (`createGoal`, `saveSteps`) join the outer transaction (as today).

## AC-10 Overlap and abandon

Files: `src/hub/service.ts`.

Changes — `fireSlot` continues, in the spec's order:
2. retire: `listSlots({pulse, pending: true})` minus this slot → `advanceSlot(s, now, {attempt:
   false})` (Advance steps 1 and 2 only).
3. abandon: `listSlots({pulse, state: "fired"})` with `startedAt` set; per slot `g = getGoal(goal)`;
   unfinished and `now − g.createdAt >= p.maxGoalAgeMs` → `dropGoal(g, "abandoned", now)`, slot →
   `abandoned`/`max_goal_age`, `decidedAt: now`, event `pulse.abandoned {pulse, slot}` (goal field set).
4. overlap: `p.overlap === "skip"` and an unfinished goal remains among the pulse's `fired` slots (newest
   first; `running` = the first such goal) → this slot `skipped`/`overlap`, event `pulse.skipped
   {pulse, slot, reason: "overlap", running}`; return the slot.
5. `createWithPlan`; slot `{state: "fired", goal, firedAt: now, until: o.manual || o.catchUp ? now +
   windowMs : at + windowMs, manual?, by?, catchUp?}`; event `pulse.fired` (goal; user = `by` for a
   manual fire; payload `{pulse, slot, manual?, catchUp?}`); then `attempt(slot, p, now)` (AC-11).

`private async dropGoal(g, reason, now)`: `steps = listSteps({goal})`; each step not in `done`,
`skipped`, `dropped`, `failed` → `{...s, state: "dropped", updatedAt: now}` (an open offer → `offer.state
= "withdrawn", decidedAt: now`); `saveSteps`; goal `{state: "dropped", updatedAt: now}`; events
`goal.dropped {reason}`, then per dropped step `step.dropped {reason}` and, for an ended open offer,
`step.offer_withdrawn {machine, reason: "step dropped"}` (via `emitOffersEnded(undefined, …)`).

Risks: reading all `fired` slots of a pulse grows with its history (see Risks at the end).
A `done` goal is never unfinished, so it is never abandoned or blocks a slot.

## AC-11 Machine choice and retries

Files: `src/hub/service.ts`, `src/hub/service.ts` `offerStep`.

Changes:
- `offerStep` opts gain `deadline?: number`; the headless data `deadline` = `opts.deadline ?? now +
  offerExpiryMs`.
- `private async attempt(slot, p, goal, now): Promise<PulseSlot>` (Advance step 3), run step `rs`
  (below) in state `ready`:
  - `rs.offer?.state === "offered"`: to a machine other than `last.machine` → wait; to `last.machine`
    and `now − rs.offer.at < offerTimeoutMs` → wait; older → `withdrawOffer({userId: p.owner}, rs,
    "pulse: not accepted in time")`, `last.outcome = "timeout"`.
    `offerTimeoutMs = min(thresholds.offerExpiryMs, floor(windowMs / 3))`.
  - `syncLastTry(slot, rs)` (also called at the top of every advance): last try without an outcome
    and `rs.offer?.to.machine === last.machine` → `declined` → `declined`; `expired`/`withdrawn` →
    `timeout`; `accepted` → `accepted`.
  - candidates = `pulseCandidates({owner, repo: rs.repo, topics: goal.topics ?? [], target,
    headless: rs.policy?.mode === "headless", tried: new Set(slot.tried.map(t => t.machine)), now,
    onlineMs: thresholds.machineOfflineMs, machines: listMachines(), sessions: listSessions({live:
    true})})`; for the first whose `headlessGuard(rs, machine, goal)` is ok: `offerStep(rs, {machine},
    {userId: owner}, {stick: false, goal, snapshot, deadline: min(now + offerExpiryMs, slot.until)})`,
    `tried.push({machine, at: now})`, `setStick(goal, {to: {machine: id}, by: owner})`. No candidate →
    wait.
- `runStepOf(goal)`: the plan-v1 step with no deps → `` `${goal.id}.${id}` `` (`listPlans(goal)[0]`).
- `releaseStep`: after the save, when `goal.refs?.pulse` and the step is `runStepOf(goal)`: slot =
  `getSlot(refs.pulse, refs.slot)`, pending → last try outcome `capacity` when `note?.startsWith
  ("capacity:")` else `released`; `saveSlot`. Goal is already read there.

Blast radius: `offerStep` signature (optional field). `releaseStep` gains a read of plan v1 for pulse
goals only.

Risks: the expiry pass in the same tick (earlier) turns an offer `expired` when `offerTimeoutMs ===
offerExpiryMs`; `syncLastTry` then maps it to `timeout` and the attempt offers B in the same tick
(no `step.offer_withdrawn`). An offer made by a person (`mesh assign`) to E has `to.machine` ≠
`last.machine` → wait. A machine is offered at most once because `tried` feeds the filter.

## AC-12 Missed reasons at window end; started slots

Files: `src/hub/service.ts`.

Changes — `private async advanceSlot(slot, now, o: { attempt: boolean })` (spec's Advance):
- `goal = getGoal(slot.goal)`, `rs = getStep(runStepOf(goal))`, `syncLastTry`.
- Started: `rs` had a `run.started` (`eventsFor({step: rs.id}).some(e => e.type === "run.started")`),
  or `rs.policy?.mode !== "headless"` and `rs.state ∈ {claimed, paused, done, failed}`, or `goal.state
  === "done"` → `startedAt = now`, save, stop.
- Window over (`now >= slot.until`): reason `no_machine` (no tries) / `capacity` (last outcome) /
  `expired` (last outcome `accepted`) / `not_accepted`; open offer → `withdrawOffer({userId: owner},
  rs, "pulse: slot missed")`; `dropGoal(goal, "missed", now)`; slot `missed`, `decidedAt: now`; event
  `pulse.missed {pulse, slot, reason, tried: tried.length}` (goal set); stop.
- `o.attempt` and `rs.state === "ready"` → `attempt(...)`; save the slot when changed.
- `runReport` (`state: "started"`): after the `run.started` emit, when `goal.refs?.pulse` and the step
  is the run step and the slot is pending → `startedAt = now`, `saveSlot`. Goal read added there.
- `private async advancePending(now)`: `for (s of listSlots({pending: true}))`: `goalTx`: re-read
  `getSlot`, still pending, pulse not deleted → `advanceSlot(s, now, {attempt: true})`. Errors per
  slot are caught and logged (`hub tick failed: …`), the loop continues.

Order: `advanceSlot` before `fireSlot` (retire uses it).

Risks: `eventsFor({step})` reads all events of the run step; small. The open offer withdrawn at window
end: its event comes from `withdrawOffer` (reason `pulse: slot missed`), so `dropGoal` finds no open
offer afterwards and emits no second `step.offer_withdrawn`.

## AC-13 Downtime, `hub_down`, `catch-up-once`

Files: `src/hub/service.ts` (`firePulseTx`, AC-09).

Changes: as AC-09. A slot fired before a stop whose window ended during it is a pending slot: the
advance pass (which runs before fire) makes it `missed`/`no_machine`, never `hub_down`. The 10-row cap
applies to the `hub_down` rows of one `firePulseTx`. `nextAt` = `nextSlot(when, now)` = the first slot
after now.

Risks: a cron with a short period down for months: the due-slot loop calls `nextSlot` once per
missed slot (bounded by downtime / period); acceptable (5-minute minimum period).

## AC-14 Manual fire

Files: `src/hub/service.ts`, `src/hub/app.ts`, `src/protocol/hub-api.ts`.

Changes:
- `async firePulse(actor, id): Promise<FireResult>`: `slotId = manualSlot(now)`. `try goalTx`:
  `p = pulseOr404(id)` (unknown or deleted → 404 `no pulse <id>`), `ownerOrAdmin` (403 `only @<owner>
  or an admin can change pulse <id>`), `fireSlot(p, slotId, now, now, {manual: true, by: actor.userId})`.
  On a throw that is not a `HubError`: second `goalTx` records `{slot: slotId, at: now, state:
  "missed", reason: "error", error, manual: true, by, tried: [], decidedAt: now}` + `pulse.missed`.
  Returns `{slot: getSlot(...)}`. `nextAt` untouched; works when paused.
- app.ts `POST /v1/pulses/:id/fire` → 201.

Risks: 404/403 are `HubError`s and must propagate, not be recorded as an `error` slot.

## AC-15 Lifecycle: pause, resume, update, delete, owner-not-member

Files: `src/hub/service.ts`, `src/hub/app.ts`, `src/protocol/hub-api.ts`.

Changes (each in `goalTx`, re-reading the row; helpers `pulseOr404`, `requireOwnerOrAdmin`):
- `pausePulse`: `!enabled` → 409 `pulse <id> is already paused`; `{enabled: false, pausedReason:
  \`paused by ${caller}\`, nextAt removed}`; `pulse.paused {pulse, reason}` (user).
- `resumePulse`: enabled → 409 `pulse <id> is not paused`; `{enabled: true, nextAt: nextSlot(when,
  now)}`, `pausedReason` removed; `pulse.resumed`.
- `updatePulse(actor, id, body)`: `fields = Object.keys(body).sort()`; preset/params given → sha check
  + `presetProblems` with the merged (new or stored) preset and params, `snapshotProfiles`, `version +
  1`; topics → `knownTopics`; `when` given → `scheduleOf(body.when, now)` + checks, and `nextAt =
  enabled ? nextSlot(when, now) : undefined`; `window`/`maxGoalAge` stored as given; recompute
  `windowMs`/`maxGoalAgeMs` with `timings` from the stored-or-new values and the current period;
  `updatedAt`; event `pulse.updated {pulse, version, fields}`.
- `deletePulse`: `{deletedAt: now, enabled: false}`, `nextAt` removed; `pulse.deleted`; returns
  `{pulse: id}`. Pending slots of deleted pulses are skipped by `advancePending`.
- Owner-not-member (in `firePulseTx`): `u = getUser(p.owner)`; no `member`/`approver`/`admin` role
  → `{enabled: false, pausedReason: \`owner ${owner} is not a member\`}`, `nextAt` removed, event
  `pulse.paused {pulse, reason}` without user; return (no slot rows).
- Routes `POST /v1/pulses/:id/update|pause|resume|delete` (200).

Risks: `pausedReason` must be deleted (not set to undefined) so `PulseView` has no key; same for
`nextAt` (use destructuring as `withdrawGoal` does for `stick`).

## AC-16 Hidden pulse goals

Files: `src/hub/service.ts`, `src/hub/app.ts`, `src/protocol/hub-api.ts`, `src/cli/hub-commands.ts`.

Changes:
- `listGoals(topics, o: { pulses?: boolean } = {})`: filter `o.pulses || !g.refs?.pulse` after the
  topic filter. app.ts passes `{pulses: c.req.query("pulses") === "1"}`. HUB_API row gains
  `query: { topic: TOPIC_QUERY, pulses: "1: include goals created by pulses" }`.
- `live()`: skip goals with `refs?.pulse`.
- CLI `goal ls`: `a.has("pulses")` → add `pulses=1` to the query (combined with `topic`); usage line
  `mesh goal ls [--topic a,b] [--pulses]`.

Blast radius: `goalDetail`, steps, attention, offers, events, `listTopics` counts are unchanged.

## AC-17 Reads and scopes

Files: `src/hub/service.ts`, `src/hub/app.ts`, `src/protocol/hub-api.ts`.

Changes:
- `listPulsesView(actor, mine)`: `listPulses({ owner: mine ? caller : undefined })` → `pulseView` each.
- `pulseDetail(id)`: `pulseOr404`; `slots = listSlots({pulse: id, limit: 50})`; `goals` = map of
  each slot goal to `getGoal(goal)?.state`; `schedule`; full `pulse` (with preset text and profile
  settings: the detail route is `goals:read`, the spec's `PulseDetail` carries `pulse: Pulse`).
- Routes: `GET /v1/pulses` (`goals:read`, query `mine`), `GET /v1/pulses/:id` (`goals:read`), POSTs
  without scope (a service token gets 403 from `allowed`), `POST /v1/goals/from-preset` (`goals:write`).
- HUB_API rows (tag `goals`, rule `member`), with `body` for create/update/from-preset and `status: 201`
  for create, fire and from-preset.

Order: register `/v1/goals/from-preset` before `/v1/goals/:id…` routes in `buildRoutes` (Hono matches
in order; there is no `POST /v1/goals/:id`, but keep it first to be safe).

## AC-18 Ingest

Files: `src/hub/service.ts`, `src/hub/app.ts`, `src/protocol/hub-api.ts`.

Changes: `async goalFromPreset(actor, b: GoalFromPreset): Promise<GoalDetail>`: `refs` with `pulse` or
`slot` → 400 `refs.pulse and refs.slot are set by pulses only`; then in `goalTx`: sha check,
`presetProblems`, `knownTopics`, `snapshotProfiles`, `createWithPlan({owner: caller, title: b.title ??
default, comment: \`ingest (preset ${name} ${sha12})\`, refs: b.refs, priority: b.priority, extra: {}})`.
No attempt, no stick. Return `goalDetail(id)` after the transaction.

Risks: the `goals:write` widening is recorded in the spec's Open questions (F8); nothing more here.

## AC-19 Built-in `audit-relay`

Files: `src/core/presets.ts`.

Changes: `const AUDIT_RELAY: Preset` with the spec's three steps (built with the `s()` helper plus
`agent`, `mode`, `profile`, `output`, `budget`, `inputs`, `when`, `consumes`, `may_set`), briefs:
`audit` = design §5.6 text (`Audit {repo}. Report every finding you see, with keys from your declared
rules; the hub works out what is new.`), `validate` = design §5.6 (`Try to refute each open item from
the source; confirm or dismiss each with a reason.`), `file` = the spec's text.
`BUILTIN_PRESETS = [SDD_SPLIT, SDD_COLLAPSE, AUDIT_RELAY]`. The `s()` helper is typed for `PlanStep`;
type the steps as `PresetStep` (cast as `s()` does).

Blast radius: `mesh preset ls` prints a third line; every loop over `BUILTIN_PRESETS` that instantiates
without params (two existing unit tests, listed below).

Risks: `instantiate` checks placeholders only in `agent`/`profile`, so missing `filer` fails with
`… unknown parameter {filer} in step file` as required. `validatePolicies` must accept `inputs: [audit,
dispositions]` (RL-2 accepts step ids and keywords).

## AC-20 CLI `mesh pulse`

Files: `src/cli/pulse-commands.ts` (new), `src/cli/hub-commands.ts`.

Changes:
- `hub-commands.ts`: `findPresetSource(cwd, name): { preset: Preset; root?: string }` (the loop of
  `findPreset`, returning the git root directory where the walk found `.git` when the file was found
  under it — walk on from the file's directory to the first ancestor with `.git`); `findPreset` =
  `findPresetSource(...).preset`. Register `pulseCommand(c)` in `hubCommands` after `presetCommand`.
- `pulse-commands.ts` (imports `node:child_process` `spawnSync` for `git -C <root> rev-parse HEAD`;
  allowed in `src/cli`): `parseArgs(rest, ["preset","repo","params","every","at","cron","tz","title",
  "topics","labels","machines","window","overlap","max-goal-age","missed"])`; subcommands per the
  spec's table. Body builder shared by `add` and `update` (`update` passes only given flags; `--preset`
  → `preset` (+ `source`), `--repo`/`--params` → full `params` = `{...parsed, repo}`; for `update`
  without `--repo` but with `--params`, `params.repo` is required by the hub: read the pulse first
  (`GET /v1/pulses/:id`) and keep its `params.repo`). Exit-2 checks run before any hub call. `sha256`
  from `../auth/index.ts`. `--tz` default `Intl.DateTimeFormat().resolvedOptions().timeZone`. `source.repo`
  = `basename(root)`.
- Output lines exactly as the spec; `ls`/`show` render from `PulseView`/`PulseDetail`; `fire` maps the
  slot state to the three texts (exit 1 for `missed`). `HubCallError` → `c.io.err(e.message)`, exit 1;
  unknown subcommand → usage, exit 2.

Blast radius: `mesh help` lists `pulse`.

Risks: `parseArgs` has no repeated flags (Open question in the spec); `--paused` is a boolean flag
(`a.has`). A bad `--at` = `Number.isNaN(Date.parse(v))` or no `T`/date shape — use
`/^\d{4}-\d{2}-\d{2}T/` plus `Date.parse`.

## AC-21 Events, no secrets in payloads, `describe()`

Files: `src/hub/service.ts` (`describe`), `docs/events.md`.

Changes: `describe()` cases: `pulse.created` → `created pulse <p> "<title>"`; `pulse.updated` → `updated
pulse <p> (v<version>)`; `pulse.paused` → `paused pulse <p>: <reason>`; `pulse.resumed`/`pulse.deleted`;
`pulse.fired` → `pulse <p> fired <slot> → <goal>`; `pulse.skipped` → `pulse <p> skipped <slot>
(<running> still running)`; `pulse.missed` → `pulse <p> missed <slot> (<reason>)`; `pulse.abandoned` →
`pulse <p> abandoned <goal>`; `goal.dropped` → `<goal> dropped (<reason>)`; `step.dropped` with
`payload.reason === "abandoned"` → `<s> dropped: its goal was abandoned`, `"missed"` → `<s> dropped:
its pulse slot was missed`, else today's text. Payload builders never include `preset.text` or
`ProfileSnapshot.settings`.

Risks: `describe` receives `e.step ?? e.goal` as subject; `pulse.*` events have no step, the goal when
set — the text uses `payload.pulse` explicitly.

## AC-22 End to end (fake `claude`)

Files: none beyond the above; this criterion exercises AC-06, AC-07, AC-08, AC-11, AC-12, the RL-1
daemon run path and RL-2 fold/skip.

Changes to check while wiring: the stick offer of `validate`/`file` goes through `emitReady` with the
goal's snapshot (AC-07); `runReport` sets `startedAt` (AC-12); the second slot's `validate`/`file` are
`skipped` by RL-2's settle inside `applyApproved` or later on audit's done (unchanged RL-2 logic); goal
`done` through RL-2's `goalComplete` (counts `skipped`).

Risks: the fake run must get the snapshot's sha in its `--settings` (offer data `profile`) — given by
`offerStep(... snapshot)` from `goal.profiles`.

## AC-23 Web: Pulses on the Mine page

Files: `web/src/api.ts`, `web/src/mine.tsx`, `web/src/styles.css`.

Changes:
- `api.ts`: `pulses: async () => (await call<{ pulses: PulseView[] }>("GET", "/v1/pulses?mine=1")).pulses`
  (type import from `../../src/protocol/pulse.ts`).
- `mine.tsx`: `load` fetches `api.pulses().catch(() => [])` with the others; component `Pulses` after
  `<Offers>`: `<section className="pulses"><h2>Pulses</h2>`; empty → `<p className="muted">No pulses.
  Create one with mesh pulse add.</p>`; each `<div className="pulse card" data-pulse={p.id}>` with id,
  title, `p.schedule`, `active`/`paused`, `next {time}` when `nextAt`; `<ul>` of `p.recent` as `<li
  data-slot={s.slot} className={\`slot-${s.state}\`}>` text `{s.state}{s.reason ? \` (${s.reason})\` :
  ""}{s.goal ? \` ${s.goal}\` : ""}`. No buttons.
- `styles.css`: `.mine .pulses` rules mirroring `.mine .offers`; `.slot-missed`, `.slot-skipped` muted
  colours using existing tokens.

Risks: the web typecheck (`tsc -p web`) must resolve `src/protocol/pulse.ts` types (it already
imports `src/protocol/hub.ts`).

## AC-24 Compatibility

Files: `src/hub/service.ts`.

Changes: none beyond guarding: `createGoal` untouched; `headlessGuard` without `goal.profiles` resolves
live; `tick()` keeps its first transaction unchanged and appends `advancePending(now)` then
`fireDue(now)` after it, outside it.

Risks: the `approvePlan` refactor (B4) is the main compatibility risk; the existing RL-1/RL-2/MM suites
cover it.

## AC-25 `mesh hub migrate`

Files: `src/store/hub-copy.ts`.

Changes: `TABLES` gains after `item_history`: `{ name: "pulse" }`, `{ name: "pulse_slot" }` (no
identity columns; `num` is copied, so `createPulse` continues at `MAX(num) + 1`).

## AC-26 Docs and skill

Files: `docs/guide/concepts.md` (section "Pulses"), `docs/guide/howto.md` ("Run an agent audit on a
schedule"), `src/protocol/skill.ts` (`MESH_SKILL`: pulse goals have no design step; a held step may
come from a pulse; `mesh pulse` for people), `skills/mesh/SKILL.md` (regenerated by `pnpm schemas`),
`docs/plan/implementation-plan.md` §5.6 (rows for the nine routes and `GET /v1/goals?pulses=1`,
each tagged `v0.1.17`), `docs/events.md` (rows for `pulse.*`, `goal.dropped`, and the `reason` of
`step.dropped`).

Content per the spec's Docs table; use generic names only (`alpha`, `auditor`, `checker`, `filer`).

## AC-27 Version, checks, OpenAPI, boundaries

Files: `package.json` (`"version": "0.1.17"`), `schemas/hub-api.openapi.json` (regenerated).

Changes: bump the version; run `pnpm schemas`; `HUB_API` rows match `app.ts` (same method, path, rule).
`parseCron`, `nextSlot` in `src/core/schedule.ts`, `pulseCandidates` in `src/core/pulse.ts`, neither
importing `hub` or `store` (enforced by `pnpm boundaries`).

## AC-28 Window equal to the period

Files: `src/hub/service.ts`.

Changes: none beyond AC-09/AC-12: `tick()` runs `advancePending` before `fireDue`; `until` = `at +
windowMs` for on-time scheduled slots, so at slot S1 (tick at S1 or S1 + 20 s) S0's window (`S0 + 30
min = S1`) is over (`now >= until`) → `missed`/`no_machine`, its goal dropped, and S1 fires without an
overlap skip. Retire inside `fireSlot` covers a fire that runs before the advance would.

## AC-29 Fire errors and deleted topics

Files: `src/hub/service.ts`, `src/cli/pulse-commands.ts`.

Changes:
- `deleteTopic`: after untagging goals, `for (p of listPulses({deleted: true}))` with the topic →
  `savePulse({...p, topics: without, updatedAt: now})` (version unchanged), event `pulse.updated
  {pulse, version, fields: ["topics"]}` (user = caller). `topic.deleted` payload unchanged.
  `deleteTopic` already serialises (`store.serialize()`).
- Fire errors: AC-09's two-transaction scheme; manual: AC-14. The CLI `fire` prints `Pulse <id> missed
  slot <slot>: <error>` and exits 1.

Risks: `listPulses({deleted: true})` must include deleted pulses (spec: "deleted ones too").

## Existing tests and generated files

Only these change because the spec changes what they assert (spec §Compatibility names the first
three as the test-writer's; the developer touches them only if the test branch has not, and then only
these lines):

| File | What | Change |
|---|---|---|
| `src/store/hub-store.contract.test.ts` | `SCHEMA_VERSION`/migration-length assertions `toBe(9)` (tests `test_AC05_schema_version_8`, `test_AC05_migration_lengths_equal`, `test_AC08_schema_version_8`, `test_AC06_schema_version_8`, the two at ~769 and ~954) and the post-migration `schema_version` reads `toBe(9)` (~805, ~988) | `9` → `10`. The v7/v8 re-migration tests keep working because migration 10 uses `IF NOT EXISTS`. |
| `src/core/policy.test.ts` | `templates › instantiate into valid plans, with or without criteria` loops over `BUILTIN_PRESETS` and calls `instantiate` without params | pass `params: { agent: "a", validator: "v", filer: "f" }` to both `instantiate` calls (unused params are ignored by the two sdd presets). |
| `src/core/presets.test.ts` | `test_AC03_builtins_unchanged` (RL-1) loops over `BUILTIN_PRESETS` and asserts no `mode`/`agent`/`profile`/`budget`/`inputs` key | restrict the loop to `sdd-split` and `sdd-collapse` (the built-ins that test was written for). |
| `test/schemas.test.ts` | `test_AC31_version` asserts `package.json` version `0.1.16` | remove the version assertion (spec: no test asserts the version except RL-3 AC-27). |
| `schemas/hub-api.openapi.json` | generated | `pnpm schemas` (nine new routes, the `pulses` query of `GET /v1/goals`, request bodies `PulseCreate`, `PulseUpdate`, `GoalFromPreset`). |
| `skills/mesh/SKILL.md` | generated from `MESH_SKILL` | `pnpm schemas`. |

Checked and unchanged: `test/m46-ops.test.ts` (its `TABLES` list covers the M4.6 tables only),
`test/schemas.test.ts` route-parity test (follows `HUB_API`), the `mesh help` tests (`toContain`),
`test/__snapshots__/cli.test.ts.snap`, `src/cli/__snapshots__/show.test.ts.snap`,
`src/core/__snapshots__/trail.test.ts.snap` (no goal file or step render changes).

## Plan-level decisions (2026-11-12)

- **Migration 10 uses `CREATE … IF NOT EXISTS`.** Existing contract tests rebuild older databases by
  dropping only the tables of the migrations they undo and re-running from version 7/8; with plain
  `CREATE TABLE` they would fail on `pulse` already existing. `IF NOT EXISTS` is harmless for real
  upgrades.
- **`pulse.updated.fields` = the keys present in the update body, sorted**; `version` bumps when the
  body has `preset` or `params` (presence, not difference): re-sending is a new approval.
- **Unfinished goal for overlap** = the goal of a `fired` slot of the pulse that is not `done`/`dropped`;
  `running` names the newest such slot's goal.
- **Guard order.** `headlessGuard` keeps checking the machine's headless capability before the
  profile; the snapshot check replaces only the live profile lookup.
- **Offers ended by a drop** emit `step.offer_withdrawn` with reason `step dropped` (the existing
  `emitOffersEnded` text); the window-end withdrawal uses reason `pulse: slot missed`.
- **Hidden goals** are recognised by `refs.pulse` alone, as the spec defines a pulse goal; a goal made
  through `POST /v1/goals` with a hand-written `refs.pulse` would also be hidden (ingest refuses the
  key; `POST /v1/goals` is left unchanged by the spec).
- **Tick error logging.** A pulse or slot whose recovery transaction throws is written to stderr as
  `hub tick failed: …` and skipped; the rest of the tick continues (spec: "the other due pulses of the
  tick still run").

## Risks (cross-cutting)

- **History growth.** Abandon and overlap read every `fired` slot of a pulse and its goal at each fire;
  a 5-minute pulse accumulates ~100 000 slots a year. Acceptable for S3; a later row can add a
  `goal_state` column or an `open` flag to `pulse_slot`.
- **Time-zone data.** Cron slots depend on the Node ICU build's tz database; Node 22 ships full ICU.
- **Postgres ordering.** `slot DESC` uses `COLLATE "C"` (`Dialect.binary`) for code-point order.
- **Two-transaction fire error path.** The second transaction must not call `createWithPlan`; it
  writes only slot rows, the event and `nextAt`.
