# Test plan RL-3: Pulse scheduling and ingest

Spec: `docs/specs/RL-3.md` (revision 2, approved in `docs/specs/reviews/RL-3/`, round 2).

Inputs read: `docs/specs/RL-3.md` (interface contracts, acceptance criteria, open questions); the role
file `assets/sdd/.claude/agents/test-planner.md`; the format of `docs/specs/plans/RL-2-test-plan.md`;
the file names of existing tests under `test/`, `test/e2e-web/`, `test/fixtures/`, `test/helpers/`,
`src/core/*.test.ts` and `src/protocol/*.test.ts`; the `describe` titles of
`src/store/hub-store.contract.test.ts`, `test/m46-replicas.test.ts` and `test/e2e-web/mine.spec.ts`; the
header comment of the fake `claude` fixture (`test/fixtures/claude/fake-claude/claude`, its script
actions); the exported names and method signatures of the test helpers `test/helpers/world.ts`
(`World.start`, `person`, `restart`, `stopHub`, `startHubAgain`, `hook`, `tool`, `session`, `tick`,
`flush`, `api`, `call`, `machineOf`, `clock`, `Person.failOnce`/`dropReplyOnce`, `FAKE_CLAUDE`),
`test/helpers/relay-kit.ts` (`Relay`: `headlessPerson`, `commitAgents`, `nick`, `otherLogin`, `call`,
`goal`, `plan`, `stepOf`, `assign`, `act`, `events`, `allEvents`, `inboxOf`, `offerMsg`, `pull`,
`reconcile`, `runOf`, `script`, `calls`, `go`, `endRun`, `started`, `runSession`, `autoOffer`,
`machineNick`, `cli`; `MIN`, `DAY`, `git`, `AUDITOR`), `test/helpers/review-kit.ts` (`Rk`, `item`,
`disp`, `rec`, `fp`, `sha`, `DAY_MS`) and `test/helpers/pg.ts` (`PG_URL`, `PgFixture`).
Not read: `docs/specs/plans/RL-3-impl-plan.md` (the implementation plan); any implementation source of
this row or of the code it changes (`src/protocol`, `src/core`, `src/store`, `src/hub`, `src/daemon`,
`src/cli`, `web/`).

Planned black-box from the contracts. Every negative assertion has a positive control in the same test
or a named sibling, so a test cannot pass because nothing happened. Each criterion names at least one
mutation of the implementation that must turn one of its tests red; the implementer or reviewer applies
it once by hand, confirms red, and reverts.

Rules from the spec's AC preamble that every test follows: pulses, slots and goals are found by id
(`p-<n>`, the slot string, the goal id from the slot), events by `type` + `payload.pulse` /
`payload.slot`, never by list position; no test runs the real `claude` binary (AC-22 uses the RL-1 fake
through `FAKE_CLAUDE`); no test asserts `package.json`'s version except AC-27. All time comes from the
World clock (`w.clock`), never `Date.now()`; slot instants are computed in the test from fixed constants
(below), never by calling `nextSlot` in a World test, so the World tests also check the core.

## Surfaces and files

| Surface | File | New or extended |
|---|---|---|
| unit, protocol (`PulseCreate`, `PulseUpdate`, `PulseWhenInput`, `PresetSnapshot`, `PulseParams`, `PulseSlot`, `SlotReason`, `Goal.profiles`, `GoalFromPreset`) | `src/protocol/pulse.test.ts` | new |
| unit, core schedule (`parseDurationSpec`, `parseCron`, `validTimeZone`, `nextSlot`, `periodMs`, `scheduleText`) | `src/core/schedule.test.ts` | new |
| unit, core pulse (`pulseCandidates`, `manualSlot`) | `src/core/pulse.test.ts` | new |
| unit, built-in preset `audit-relay` | `src/core/presets.test.ts` | extended (`describe("audit-relay")`) |
| `HubStore` contract (SQLite always, Postgres when `PG_URL` is set) | `src/store/hub-store.contract.test.ts` | extended (`describe("migration 10")`) |
| World: routes, validation, snapshots, firing, advance, tick, lifecycle, ingest, events, hidden goals | `test/pulse-hub.test.ts` | new |
| World, concurrency (two `HubService` on one store) | `test/pulse-replicas.test.ts` | new (built as `test/m46-replicas.test.ts` builds its replicas) |
| World + temp git repo + fake claude, end to end | `test/pulse-daemon.test.ts` | new |
| CLI `mesh pulse …`, `mesh goal ls --pulses`, `mesh preset ls`, `mesh help` | `test/pulse-cli.test.ts` | new |
| `mesh hub migrate` copy | `test/m46-ops.test.ts` | extended (`describe("RL-3 tables")`) |
| schemas, route table, boundaries, skill, version | `test/schemas.test.ts` | extended |
| Playwright | `test/e2e-web/mine.spec.ts` | extended (`test.describe("AC-23 pulses on the Mine page")`) |
| existing tests the spec says change | tests comparing `SCHEMA_VERSION`/migration count 9, `TABLES`, `BUILTIN_PRESETS`, the `mesh help` list | updated to 10 / two new tables / `audit-relay` / `pulse` by the test-writer (spec, Compatibility) |

### Test-side helpers (new, `test/helpers/pulse-kit.ts`, built on `Relay` and `Rk`)

- Constants: `MIN`, `HOUR = 3_600_000`, `DAY`; `T0 = Date.UTC(2026, 10, 16, 9)` (`2026-11-16T09:00:00.000Z`,
  a Monday) used as the anchor `at` of every `every` pulse that needs fixed slots; `S(k, period) = T0 + k·period`;
  `iso(ms) = new Date(ms).toISOString()`.
- `sha(text)` (from `review-kit`), `sha12(text) = sha(text).slice(0, 12)`, `snap(name, text, source?)` →
  `{name, text, sha256: sha(text), ...(source ? {source} : {})}`.
- Preset texts (the YAML format `parsePreset` reads, written in the test file; each text ends with
  `\n`): `SOLO` (one interactive step `run`, kind `code`, repo `{repo}`, title `Run {repo}`);
  `SOLO_HL` (one headless step `run`, `agent: auditor`, no `profile`, so the plan's profile names are
  `["read-only"]`); `TWO_ROOTS` (steps `a` and `b`, no deps); `GATE_FIRST` (one gate step, no deps);
  `UNKNOWN_PROF` (one headless step with `profile: nope`); `BAD_POLICY` (one step whose policy
  `validatePolicies` rejects, e.g. `may_set` without `consumes` from RL-2, expected text = RL-2's
  `step "run": may_set needs consumes`); `TEAM_RO` (one headless step `run`, `profile: team-ro`) and a
  two-step `TEAM_RO_V2`. The built-in text is `presetText(<the audit-relay entry of BUILTIN_PRESETS>)`
  (both are public core exports named by the spec).
- `RELAY_PARAMS = {repo: ALPHA, agent: "auditor", validator: "checker", filer: "filer"}`.
- `pulse(who, body)`: `POST /v1/pulses` → `{status, json}`; `pulseOk(who, body)` asserts 201 and returns
  the `PulseView`; `detail(who, id)`: `GET /v1/pulses/:id`; `slotOf(who, id, slot)`: the one slot with
  that `slot` in `detail.slots` (asserts exactly one); `slotsOf(who, id)`; `pulseEvents(type, id)`:
  `allEvents()` filtered by `type` and `payload.pulse === id`.
- `at(ms)`: sets `w.clock = ms`; `tickAt(ms)`: `at(ms)` then `await w.tick()`.
- `storeWrap(w, overrides)`: replaces the `HubStore` the World's `HubService` uses with a `Proxy` that
  overrides the named methods (e.g. `duePulses`, the goal insert). If `World` has no seam for this, the
  test-writer adds one to `test/helpers/world.ts` (the spec allows extending it); the tests depend only
  on the store interface named in the spec.
- Every World test uses `hubYaml` thresholds explicitly where a test depends on them
  (`offerExpiryMs`, `machineOfflineMs`), so a changed default does not change the expected values.

---

## AC-01 Schemas

File `src/protocol/pulse.test.ts`, `describe("schemas")`.

| Test | Stimulus | Expected | Fails when |
|---|---|---|---|
| `test_AC01_create_minimal_defaults` | `PulseCreate.parse({preset: snap("p", "x\n"), params: {repo: "r"}, when: {every: "7d"}})` | `overlap: "skip"`, `missed: "record"`, `enabled: true`, `target: {}`; no `window`, `maxGoalAge`, `title`, `topics` keys | a default differs or a key is invented |
| `test_AC01_when_forms` | `when: {cron: "0 9 * * 1", tz: "UTC"}`; `when: {every: "30m", at: 0}`; `when: {every: "366d"}`; `when: {every: "5m"}` | all parse; `at` kept as given | a form or a boundary refused |
| `test_AC01_create_rejects` (`it.each`) | `every: "7w"`; `every: "1m"`; `every: "367d"`; `window: "0h"`; `window: "31d"`; `maxGoalAge: "30m"`; `maxGoalAge: "367d"`; sha256 of 63 hex chars; sha256 of 64 uppercase hex; params key `Repo`; 21 params; a param value of 301 chars; an unknown top-level key `foo`; `when: {cron: "* * * * *", tz: "UTC", every: "1d"}` (mixed); `when: {every: "1d", anchor: 0}` (stored form is not input); `overlap: "queue"`; `target: {labels: [...21]}` | `success === false` each; for `every: "1m"` an issue message exactly `every is 5m to 366d`; for `window: "0h"` the regex message (`a duration is a number and m, h or d, e.g. 30m, 4h, 7d`), for `window: "31d"` `window is 1m to 30d`; for `maxGoalAge: "30m"` `maxGoalAge is 1h to 366d` | any parses, or a documented message differs |
| `test_AC01_create_boundaries` | `window: "1m"`, `window: "30d"`, `maxGoalAge: "1h"`, 20 params, a value of 300 chars, a preset name of 60 chars, text of 20000 chars | parse | positive control for `test_AC01_create_rejects` |
| `test_AC01_update` | `PulseUpdate.safeParse({})`; `PulseUpdate.parse({window: "2h"})`; `PulseUpdate.safeParse({enabled: false})`; `PulseUpdate.safeParse({every: "1m"})` wrapped in `when` | fails with message exactly `give at least one field to change`; ok; fails (no `enabled`); fails `every is 5m to 366d` | `{}` accepted, `enabled` accepted, refinements missing |
| `test_AC01_slot_ids` | `PulseSlot.parse` of a slot with `slot: "manual:" + "0123456789ABCDEFGHJKMNPQRS"` and `tried` omitted; `slot: "manual:x"`; `slot: "manual:" + 25 chars`; 26 chars containing `I`, `L`, `O` or `U` | ok and `tried` `[]`; the other three fail | a non-Crockford ULID accepted, `tried` default missing |
| `test_AC01_enums` | `SlotState` of `fired`,`skipped`,`missed`,`abandoned`; `"done"`; `SlotReason` of the 8 reasons; `"timeout"` | ok ×4, fail; ok ×8, fail | an enum widened or narrowed |
| `test_AC01_goal_profiles` | `Goal.parse(<a v0.1.16 goal fixture>)`; the same plus `profiles: {"read-only": <a ProfileSnapshot>}` | ok without a `profiles` key; ok with it equal | `profiles` required, or dropped |
| `test_AC01_goal_from_preset` | `GoalFromPreset.parse({preset: snap("p","x\n"), params: {repo: "r"}})`; with `preset.source`; `priority: 10`; unknown key | `priority: 3`; the other three fail | `source` accepted (spec: without source), default other than 3 |
| `test_AC01_pulse_id` | `PulseId` of `p-1`, `p-10`; `p-0`, `p-01`, `p1` | ok ×2; fail ×3 | regex loose |

Positive control: `test_AC01_create_minimal_defaults`, `test_AC01_create_boundaries`.
Mutation: drop the `every` refinement → `test_AC01_create_rejects` (`1m`) red; `PulseCreate` not
`.strict()` → red (`foo`); ULID regex `[0-9A-Z]` → `test_AC01_slot_ids` red; `overlap` default `"allow"` →
`test_AC01_create_minimal_defaults` red; remove the at-least-one refinement → `test_AC01_update` red.

---

## AC-02 Cron parsing and `nextSlot` vectors

File `src/core/schedule.test.ts`, `describe("cron")`.

| Test | Stimulus | Expected | Fails when |
|---|---|---|---|
| `test_AC02_cron_errors` (`it.each`) | `"* * * *"`; `"61 * * * *"`; `"* * * 13 *"`; `"a * * * *"`; `"5-3 * * * *"`; `"* * * * * *"`; `"* 24 * * *"`; `"* * 0 * *"`; `"* * * * 8"`; `"*/0 * * * *"`; `"MON * * * *"`; `"? * * * *"` | `{ok: false, error}` with exactly: `a cron expression has 5 fields (minute hour day-of-month month day-of-week)` (4 and 6 fields); `minute value 61 is out of range 0-59`; `month value 13 is out of range 1-12`; `bad minute field "a"`; `bad minute field "5-3"`; `hour value 24 is out of range 0-23`; `day-of-month value 0 is out of range 1-31`; `day-of-week value 8 is out of range 0-7`; `bad minute field "*/0"`; `bad minute field "MON"`; `bad minute field "?"` | any accepted, or a different message |
| `test_AC02_cron_accepts` | `"0,15,30,45 * * * *"`; `"0 9-17 * * 1-5"`; `"*/15 * * * *"`; `"5/20 * * * *"`; `"0 0 * * 7"`; `"  0  9 * * 1 "` (extra whitespace) | `ok: true` each | positive control for `test_AC02_cron_errors` |
| `test_AC02_n_slash_s` | `nextSlot({cron: "5/20 * * * *", tz: "UTC"}, Date.UTC(2026,10,12,0,0))`, then after it, then after that | `00:05`, `00:25`, `00:45` (UTC, same day) | `n/s` read as `n` only or as `*/s` |
| `test_AC02_vectors` (`it.each` over the 8 table rows; the `*/30` gap row gives two instants: after `2026-03-29T00:30Z` → `01:00Z`, after `01:00Z` → `01:30Z`) | `nextSlot({cron, tz}, Date.parse(after))` | `iso(result)` equals the table exactly | any instant differs |
| `test_AC02_overlap_no_double` | `*/30 * * * *`, `Europe/Berlin`: chain 6 calls of `nextSlot` from `2026-10-24T23:50:00Z` | `00:00Z, 00:30Z, 02:00Z, 02:30Z, 03:00Z, 03:30Z` (`01:00Z` and `01:30Z` are the repeated 02:xx CET wall minutes) | a second occurrence fired |
| `test_AC02_gap_no_missing` | `30 2 * * *`, `Europe/Berlin` from `2026-03-28T12:00Z`, then from that result | `2026-03-29T01:00:00Z`, then `2026-03-30T00:30:00Z` | gap slot dropped or shifted to another day |
| `test_AC02_gap_coincide` | `0,30 2 * * *` and `0 3 * * *` combined as `0,30 2,3 * * *`, `Europe/Berlin`, from `2026-03-28T12:00Z`: chain until past `2026-03-29T02:00Z` | `01:00Z` once (02:00, 02:30 and 03:00 wall coincide), then `01:30Z`, then `2026-03-30T00:00Z` | the coinciding slots returned twice (the same instant twice in the chain) |
| `test_AC02_never` | `nextSlot({cron: "0 0 31 2 *", tz: "UTC"}, 0)`; `nextSlot({cron: "0 0 30 2 *", tz: "UTC"}, 0)` | `undefined` both; and it returns (the test has a 2 s timeout) | a value, or a search past 5 years that hangs |
| `test_AC02_tz` | `validTimeZone` of `"Mars/Base"`, `""`, `"UTC"`, `"Europe/Berlin"`, `"America/New_York"` | `false, false, true, true, true` | wrong boolean |
| `test_AC02_strictly_after` | `nextSlot({cron: "0 9 * * 1", tz: "America/New_York"}, Date.parse("2026-11-16T14:00:00Z"))` | `2026-11-23T14:00:00Z` | `>=` instead of `>` |

Positive control: `test_AC02_cron_accepts`, the vectors with a value (against `test_AC02_never`).
Mutation: treat DST overlap wall minutes as two slots → `test_AC02_vectors` row 4 and
`test_AC02_overlap_no_double` red; skip non-existent wall minutes → row 2 red; AND the day fields always
→ row 7 (`0 0 1 * 1`) red; day-of-week 7 rejected → row 8 red; `n/s` as `n` → `test_AC02_n_slash_s` red.

---

## AC-03 `every`, period, text, durations

File `src/core/schedule.test.ts`, `describe("every")`. `A = T0`, `W = {every: "7d", anchor: A}`.

| Test | Stimulus | Expected | Fails when |
|---|---|---|---|
| `test_AC03_every_next` | `nextSlot(W, A)`; `nextSlot(W, A - 1)`; `nextSlot(W, A + 10*DAY)`; `nextSlot(W, A + 7*DAY)`; `nextSlot(W, A + 7*DAY - 1)` | `A+7d`, `A`, `A+14d`, `A+14d`, `A+7d` | off by one period, `>=` |
| `test_AC03_future_anchor` | `after = A`, anchor `A + 30d`, every 7d | `A + 30d` (not `A + 2d`) | counted back from the anchor |
| `test_AC03_periodMs` | `periodMs({cron: "0 9 * * 1", tz: "UTC"}, Date.parse("2026-11-12T00:00Z"))`; `periodMs({every: "4h", anchor: 0}, 0)`; `periodMs({cron: "0 9 * * 1-5", tz: "UTC"}, Date.parse("2026-11-13T10:00Z"))` (Fri after 09:00 → Mon, Tue); `periodMs({cron: "0 0 31 2 *", tz: "UTC"}, 0)` | `7*DAY`; `4*HOUR`; `DAY`; `undefined` | another gap measured (e.g. from `from`) |
| `test_AC03_scheduleText` | `{every: "7d", anchor: 5}`; `{cron: "0 9 * * 1", tz: "Europe/Berlin"}` | `every 7d`; `cron "0 9 * * 1" Europe/Berlin` | other text |
| `test_AC03_durations` | `parseDurationSpec` of `"4h"`, `"30m"`, `"7d"`, `"999999m"`; `"4w"`, `"0h"`, `"1000000m"`, `"4H"`, `" 4h"` | `14_400_000`, `1_800_000`, `604_800_000`, `59_999_940_000`; each throws `Error` with message exactly `invalid duration "<s>" (use e.g. 30m, 4h, 7d)` | other value or text, a bad one accepted |

Positive control: the accepted durations against the throws.
Mutation: `k ≥ 0` in the every rule (`anchor` itself when `after = anchor`) → `test_AC03_every_next` red;
`k` over all integers → `test_AC03_future_anchor` red; `periodMs` = `nextSlot(from) − from` →
`test_AC03_periodMs` red.

---

## AC-04 `pulseCandidates` and `manualSlot`

File `src/core/pulse.test.ts`. Inputs built with the `SuggestMachine`/`SuggestSession` shapes (exported
types of `suggest`). `now = T0`, `onlineMs = 10*MIN`; owner `ann`; repo `/src/alpha`; topics `["t"]`.
Five machines: `m-off` (last seen `now − 11 min`), `m-norepo` (online, no session in the repo),
`m-acc` (online, repo, `accept` that does not match `ann`), `m-nolab` (online, repo, auto, labels
`["gpu"]`), `m-ok` (online, repo, auto, labels `["gpu","fast"]`); `target.labels = ["gpu","fast"]`.

| Test | Stimulus | Expected | Fails when |
|---|---|---|---|
| `test_AC04_filters` | the five machines, `headless: false`, `tried` empty | exactly `[m-ok]` (machine ids of the suggestions) | another machine kept or `m-ok` dropped |
| `test_AC04_no_target_labels` | same, `target: {}` | `m-nolab` and `m-ok` both kept, in `suggest`'s order | labels filter applied without a target (positive control) |
| `test_AC04_headless` | `m-ok` and `m-ok2` (same as `m-ok`, `headless: true`; `m-ok` has `headless` unset), `headless: true` | `[m-ok2]`; with `headless: false` both | a non-headless machine kept for a headless step, or headless dropping all |
| `test_AC04_tried` | two kept machines, `tried = {first}` | only the second | `tried` ignored |
| `test_AC04_target_machines` (`it.each`) | `target.machines` = `[<id of m2>]`; `["bob/box"]` where `m2` is bob's machine nicknamed `box` (accept matches ann); `["laptop"]` where `m2` is ann's machine nicknamed `laptop`; `["box"]` where `box` is bob's (not the owner's) | `[m2]`, `[m2]`, `[m2]`, `[]` | a form not matched, or a bare nickname of another user's machine matched |
| `test_AC04_order_is_suggest` | two kept machines `x`, `y`; expected order = the machine ids of `suggest({caller: "ann", callerMachine: undefined, now, onlineMs, repos: [repo], topics, any: false, machines, callerNicknames, sessions})` filtered to `x`,`y`; then add label `zz` (neither a topic nor the repo name) to the second one and `target.labels = []` | result order equals `suggest`'s both times, and the `zz` run's order equals the first run's | reordered (e.g. label count as a rank key) |
| `test_AC04_manualSlot` | `manualSlot(T0)`; `manualSlot(T0, new Uint8Array(10))`; `manualSlot(T0 + 1)` | match `/^manual:[0-9A-HJKMNP-TV-Z]{26}$/`; the 10-char time prefix of the first two equal and that of `T0+1` sorts after it; with zero `rand` the random part is `0000000000000000` | other form, time not encoded first |

Positive control: `test_AC04_no_target_labels`, the kept machines in `test_AC04_headless`.
Mutation: drop the labels filter → `test_AC04_filters` red; sort by label matches →
`test_AC04_order_is_suggest` red; ignore `tried` → `test_AC04_tried` red; match a bare nickname on any
user's machine → `test_AC04_target_machines` row 4 red.

---

## AC-05 Store contract, migration 10

File `src/store/hub-store.contract.test.ts`, `describe("migration 10")` inside `contract(...)` (SQLite
always; Postgres when `PG_URL` is set). `pulseRow(o)` = a valid `Omit<Pulse,"id">` with `owner`,
`enabled`, `nextAt` overridable.

| Test | Stimulus | Expected | Fails when |
|---|---|---|---|
| `test_AC05_version` | `HubStore.SCHEMA_VERSION`, `HUB_MIGRATIONS.length`, `HUB_MIGRATIONS_PG.length` | `10`, `10`, `10` | other |
| `test_AC05_v9_upgrade` | a store at v9 (apply the first 9 migrations; SQLite on a file, Postgres in a schema) with a goal, steps, a review record, items and item history; open with the v10 store | goal, steps, `listReviews`, items and `itemHistory` `toStrictEqual` before/after; `listPulses()` `[]`; `createPulse` works | data changed, migration not applied |
| `test_AC05_ids` | `createPulse` ×2; `savePulse({...p2, deletedAt: now, enabled: false, nextAt: undefined})`; `createPulse` | `p-1`, `p-2`, then `p-3`; `getPulse("p-2")` still returns it with `deletedAt` | an id reused, a deleted row removed |
| `test_AC05_listPulses` | p-1 (owner ann), p-2 (bob, deleted), p-3 (ann) | `listPulses()` ids `[p-1, p-3]`; `{owner: "ann"}` `[p-1, p-3]`; `{deleted: true}` includes `p-2` | deleted listed by default, filter ignored, order not by number |
| `test_AC05_round_trip` | `savePulse` with every optional field set (window, maxGoalAge, pausedReason, source, profiles) then `getPulse` | `toStrictEqual`; and unset fields stay absent (no `null`s) | a field lost or `null` written |
| `test_AC05_duePulses` | p-1 enabled `nextAt = now`; p-2 enabled `nextAt = now + 1`; p-3 disabled `nextAt = now − 1`; p-4 deleted `nextAt = now − 1`; p-5 enabled no `nextAt`; p-6 enabled `nextAt = now − 5` | ids `[p-1, p-6]` (by number) | a disabled/deleted/future/absent row returned, `<` instead of `<=`, wrong order |
| `test_AC05_addSlot` | `addSlot(s1)`; `addSlot({...s1, state: "skipped"})` | `true`, `false`; `getSlot` returns `s1` with `state: "fired"` | duplicate stored or overwritten |
| `test_AC05_listSlots` | slots of p-1: `a` at `T0` fired, `b` at `T0+1` missed, `c` and `d` at `T0+2` (slot ids `"c" < "d"`), one slot of p-2 | `{pulse: "p-1"}` slots `[d, c, b, a]`; `{pulse: "p-1", state: "missed"}` `[b]`; `{pulse: "p-1", limit: 2}` `[d, c]`; no filter includes p-2's | filter or limit ignored, ascending order, ties broken ascending |
| `test_AC05_pending` | fired without `startedAt`; fired with `startedAt`; missed; skipped; then `saveSlot` of the first with `startedAt` | `{pending: true}` = only the first; after the save `[]` | `started_at` column not maintained on save, other states returned |
| `test_AC05_lock` | `LOCKS.pulses` exists (from `src/store/dialect.ts`); two `createPulse` started concurrently inside two transactions | ids `p-1` and `p-2`, distinct | same `num` twice |

Positive control: `test_AC05_round_trip`, the first `addSlot`, the pending row in `test_AC05_pending`.
Mutation: `listPulses` without the `deletedAt` filter → `test_AC05_listPulses` red; `num` = count + 1 →
`test_AC05_ids` red; `saveSlot` not writing `started_at` → `test_AC05_pending` red; `ON CONFLICT DO
UPDATE` in `addSlot` → `test_AC05_addSlot` red.

---

## AC-06 `POST /v1/pulses` validation and defaults

File `test/pulse-hub.test.ts`, `describe("AC-06 create")`. Users `ann` (member), with `w.clock = T0 − DAY`
(called `NOW`). Problem texts compared with `toBe` on `json.error` and `toStrictEqual` on `json.details`.

| Test | Stimulus | Expected | Fails when |
|---|---|---|---|
| `test_AC06_sha_mismatch` | `audit-relay` snapshot with `sha256 = sha("other")`, and also missing `params.repo` | 400, `error` exactly `preset.sha256 is not the SHA-256 of preset.text` (before the repo problem) | 422, or other text |
| `test_AC06_missing_repo` | `SOLO`, `params: {}` | 422 `the preset has 1 problem(s): params.repo is required (the repo the preset's steps work in)` | other count/text |
| `test_AC06_missing_validator` | built-in text, params `{repo, agent: "auditor", filer: "f"}` | 422 `the preset has 1 problem(s): preset audit-relay: unknown parameter {validator} in step validate` | other text, or more problems after the stop |
| `test_AC06_two_roots` | `TWO_ROOTS`; and `GATE_FIRST` | 422 `the preset has 1 problem(s): a pulse preset needs exactly one first step (no deps, not a gate); two-roots has 2`; `…; gate-first has 1` | accepted, other `<n>` |
| `test_AC06_unknown_profile` | `UNKNOWN_PROF` | 422 `the preset has 1 problem(s): step "run": unknown profile "nope"` | accepted (snapshot of nothing) |
| `test_AC06_policy_error` | `BAD_POLICY` | 422; `details` contains RL-2's text unchanged | reworded or missing |
| `test_AC06_parse_error` | a preset text that is not valid preset YAML (e.g. `steps: 5\n`) | 422; the problem starts `preset <name>: ` and there is exactly 1 problem (stop) | more problems, other prefix |
| `test_AC06_two_problems` | `TWO_ROOTS` plus `params: {}` | 422 `the preset has 2 problem(s): params.repo is required (…); a pulse preset needs …` (order: repo first); `details` has 2 entries | count, join or order differs |
| `test_AC06_schedule_errors` (`it.each`) | valid `SOLO` with `when`: `{cron: "61 * * * *", tz: "UTC"}`; `{cron: "0 9 * * 1", tz: "Mars/Base"}`; `{cron: "0 0 31 2 *", tz: "UTC"}`; `{cron: "* * * * *", tz: "UTC"}`; `{cron: "*/4 * * * *", tz: "UTC"}` | 422 with exactly `bad cron "61 * * * *": minute value 61 is out of range 0-59`; `unknown time zone "Mars/Base"`; `cron "0 0 31 2 *" never fires`; `cron "* * * * *" fires more often than every 5m`; `cron "*/4 * * * *" fires more often than every 5m` | other status/text |
| `test_AC06_cron_5m_ok` | `{cron: "*/5 * * * *", tz: "UTC"}` | 201 | positive control for the 5 min limit |
| `test_AC06_unknown_topic` | `SOLO`, `topics: ["nope"]` | 400, text starting `unknown topic` (as `POST /v1/goals`) | 422 or 201 |
| `test_AC06_success_relay` | built-in text, `RELAY_PARAMS`, `when: {every: "7d"}` | 201; `id` `p-1`; `version: 1`; `owner: "ann"`; `title` `audit-relay on alpha`; `windowMs` `4*HOUR`; `maxGoalAgeMs` `14*DAY`; no `window`/`maxGoalAge` keys; `nextAt` `NOW + 7d`; `when.anchor` `NOW`; `enabled: true`; `preset` = `{name, sha256}` (no `text`), `profiles` keys exactly `["propose-via-branch","read-only"]` with values = the built-in profiles' sha256 (read from `GET /v1/profiles` or the RL-1 profile route); `schedule` `every 7d`; `recent: []` | any field or default differs, `preset.text` in the view |
| `test_AC06_every_30m` | `SOLO`, every 30m | `windowMs` `30*MIN`, `maxGoalAgeMs` `HOUR` | not `min(4h, period)` |
| `test_AC06_at_future` | every 7d, `at: NOW + 2d`; and `at: NOW + 30d`; and `at: NOW − 1d` | `nextAt` `NOW + 2d`; `NOW + 30d`; `NOW + 6d` | counted back, or `at` ignored |
| `test_AC06_headless_default_profile` | `SOLO_HL` | `profiles` keys `["read-only"]` | default profile not snapshotted |
| `test_AC06_event` | the relay success | exactly one `pulse.created` with `payload.pulse === "p-1"`; `Object.keys(payload).sort()` = `["preset","pulse","schedule","sha256","title"]`; `preset` `audit-relay`, `sha256` the full hash, `schedule` `every 7d`; `user` `ann` | extra/missing key |
| `test_AC06_disabled` | `enabled: false` | 201; `enabled: false`; no `nextAt` key | `nextAt` set |
| `test_AC06_given_window` | `window: "2h"`, `maxGoalAge: "3d"` | `window: "2h"`, `windowMs` `2*HOUR`, `maxGoalAge: "3d"`, `maxGoalAgeMs` `3*DAY` | given value overridden |

Positive control: `test_AC06_success_relay`, `test_AC06_cron_5m_ok`.
Mutation: compute the sha over the text with a trailing newline stripped → `test_AC06_sha_mismatch`
passes but `test_AC06_success_relay` red; continue after a parse error → `test_AC06_parse_error` red;
`windowMs` default `period` → `test_AC06_success_relay` red; omit the default `read-only` for headless
steps → `test_AC06_headless_default_profile` red; skip the 5-min period check → `test_AC06_schedule_errors`
(`* * * * *`, `*/4`) red; check `< 5 min` as `<= 5 min` → `test_AC06_cron_5m_ok` red.

---

## AC-07 Snapshots (R-6)

World `test/pulse-hub.test.ts`, `describe("AC-07 snapshots")`; CLI part in `test/pulse-cli.test.ts`,
`describe("AC-07 repo preset snapshot")`.

| Test | Stimulus | Expected | Fails when |
|---|---|---|---|
| `test_AC07_profile_pinned` | register profile `team-ro` (RL-1 `POST /v1/profiles`, sha S1); pulse with `TEAM_RO`; then `POST /v1/profiles` replaces `team-ro` (sha S2 ≠ S1, asserted); headless machine of ann that is a candidate; `POST /v1/pulses/p-1/fire` | the goal's `profiles["team-ro"].sha256 === S1`; the run step's open offer data `profile.sha256 === S1` and the `StepOffer.profile.sha256` seen by the machine (`r.offerMsg` / offers list) `=== S1`; `GET /v1/pulses/p-1` `profiles["team-ro"]` S1 | S2 anywhere |
| `test_AC07_control_live_profile` | same replace, then an ordinary goal (`POST /v1/goals` + plan with the `team-ro` step, approved) offered | offer `profile.sha256 === S2` | positive control: the replace took effect for non-pulse goals |
| `test_AC07_update_preset` | `update {preset: snap(TEAM_RO_V2)}` | 200, `version: 2`, `preset.sha256` new; next fire's goal plan has the V2 steps and `goal.preset.text === TEAM_RO_V2` | version 1, old steps |
| `test_AC07_update_window_only` | `update {window: "2h"}` | `version` unchanged (1), `profiles` `toStrictEqual` before, `preset.sha256` unchanged; even after `team-ro` was replaced in between (profiles still S1) | version bumped, profiles re-resolved |
| `test_AC07_not_in_snapshot` | a fired pulse goal G (`TEAM_RO`); owner proposes and approves plan v2 adding headless step `x` with `profile: read-only` (not in `G.profiles`); `POST /v1/steps/G.x/assign` to a headless machine | 409; `error` contains exactly `G.x: profile read-only is not in the goal's snapshot` | 201, offer made |
| `test_AC07_cli_repo_preset` (CLI) | temp git repo `alpha` with `.mesh/presets/weekly.yaml` (one-step, title `Old`), committed; `mesh pulse add --preset weekly --repo /src/alpha --every 7d` run from a subdirectory of it; then the file is edited (title `New`, an extra step) and committed; `mesh pulse fire p-1` | sent body (captured at the hub: `GET /v1/pulses/p-1` + the `pulse.created` sha) has `preset.text === presetText(parsePreset("weekly", <old file>))`, `sha256 === sha(that)`, `source: {repo: "alpha", commit: <git rev-parse HEAD before the edit>}`; the fired goal's steps are the old ones and `goal.preset.text` = that text (not the raw old file bytes when they differ: the old file is written with an extra comment line and different key order so `presetText` output ≠ file bytes, asserted) | new text or steps used, raw bytes sent |

Positive control: `test_AC07_control_live_profile`, `test_AC07_update_preset` (a change does reach the
next fire).
Mutation: resolve profiles at offer time for every goal → `test_AC07_profile_pinned` red; bump `version`
on every update → `test_AC07_update_window_only` red; re-resolve profiles on any update → red; CLI sends
raw file bytes → `test_AC07_cli_repo_preset` red.

---

## AC-08 Create-with-plan on a fire

File `test/pulse-hub.test.ts`, `describe("AC-08 create-with-plan")`. Pulse p-1 by ann: built-in
`audit-relay` with `RELAY_PARAMS`, `every 1d`, `at: T0`; ann has a session S open (so an inbox message
would be visible); no machine. `tickAt(T0)`.

| Test | Stimulus | Expected | Fails when |
|---|---|---|---|
| `test_AC08_goal_shape` | slot `iso(T0)`; its goal G | slot `fired`, `goal: G`, `firedAt: T0`, `until: T0 + 4h`, `at: T0`; `GET /v1/goals/G`: `refs` `{pulse: "p-1", slot: iso(T0)}`, `preset.name` `audit-relay`, `primaryRepo` `/src/alpha`, `profiles` keys `["propose-via-branch","read-only"]` equal to the pulse's, title `audit-relay on alpha (<iso(T0)>)`, `ownerId` ann, state `in_progress`, priority 3 | any differs |
| `test_AC08_no_design` | steps of G | ids exactly `G.audit`, `G.validate`, `G.file`; no `G.design` | design step present |
| `test_AC08_plan` | G's plan | v1, `decision: "approved"`, `proposedBy` = `decidedBy` = ann, `comment` exactly `pulse p-1 (preset audit-relay <sha12(builtin text)>)` | other |
| `test_AC08_states` | step states | `G.audit` `ready`; `G.validate` and `G.file` `blocked` | other |
| `test_AC08_events` | events with `goal: G` | one `goal.created` (user ann; payload keys include `title`, `preset: "audit-relay"`, `pulse: "p-1"`, `slot: iso(T0)`); one `plan.approved {version: 1}`; `step.ready` for `G.audit` only (none for validate/file); one `pulse.fired` | missing or extra |
| `test_AC08_no_inbox` | `r.inboxOf(ann)` after `w.flush()` | no message with kind `plan_approved` and none naming G's plan or a plan file | a message |
| `test_AC08_no_inbox_control` | ann's own `POST /v1/goals` + plan + approve (as RL-2 tests do) | the usual `plan_approved` message arrives | positive control for the inbox check |
| `test_AC08_lineage` | `ann` (held through `assign` + `claim`, as `Rk.claim`) posts a review record on `G.audit` with one item | `GET /v1/items?lineage=audit-relay|/src/alpha|auditor` returns that item | other lineage (e.g. `-|…`) |

Positive control: `test_AC08_no_inbox_control`; `test_AC08_states` (the first step is ready).
Mutation: route the fire through `createGoal` (design step) → `test_AC08_no_design` red; send
`plan_approved` → `test_AC08_no_inbox` red; omit `goal.preset` → `test_AC08_lineage` red.

---

## AC-09 Idempotent firing

`test/pulse-hub.test.ts`, `describe("AC-09 idempotent")`, and `test/pulse-replicas.test.ts`.
Pulse p-1 `SOLO`, every 1d, `at: T0`; no machine.

| Test | Stimulus | Expected | Fails when |
|---|---|---|---|
| `test_AC09_two_ticks` | `at(T0)`; `w.tick()`; `w.tick()` | one slot `iso(T0)`; `pulse.fired` events for it: 1; goals with `refs.pulse = p-1` (`GET /v1/goals?pulses=1`): 1; `nextAt` `T0 + 1d` | two of anything |
| `test_AC09_concurrent_ticks` | `Promise.all([w.tick(), w.tick()])` at `T0` (repeated in 10 fresh Worlds for SQLite) | as above | two goals |
| `test_AC09_two_services` (replicas file) | two `HubService` on one store (SQLite file; Postgres when set), both `tick()` at once at `T0` | one goal, one `pulse.fired` for the slot | two |
| `test_AC09_slot_preinserted` | `storeWrap` not needed: before the tick, `addSlot({pulse: "p-1", slot: iso(T0), at: T0, state: "fired", tried: [], decidedAt: T0})` through the World's store; `tickAt(T0)` | no goal for p-1; no `pulse.fired`; `nextAt` `T0 + 1d` | a goal created, `nextAt` stuck at `T0` |
| `test_AC09_stale_due` | `storeWrap({duePulses: () => [copy of p-1 read before the pause]})`; `POST /v1/pulses/p-1/pause`; `tickAt(T0)` | no slot row for `iso(T0)`; p-1 `enabled: false`, no `nextAt`, `pausedReason` `paused by ann` | slot fired, pause undone |
| `test_AC09_stale_due_control` | same wrapper but no pause | the slot fires once | positive control: the wrapper does not block firing |

Mutation: drop the `addSlot === false` stop → `test_AC09_slot_preinserted` red; write the whole pulse read
by `duePulses` at the end of the tick → `test_AC09_stale_due` red; fire outside a transaction with the
lock → `test_AC09_two_services` red (on Postgres; on SQLite the concurrent test).

---

## AC-10 Overlap and abandon

`test/pulse-hub.test.ts`, `describe("AC-10 overlap and abandon")`. ann's machine M (person with a
session, accept `self`, repo `alpha`), pulse `SOLO`, `every 1d`, `at: T0`, `maxGoalAge: "3d"`.
`Sk = T0 + k·DAY`.

| Test | Stimulus | Expected | Fails when |
|---|---|---|---|
| `test_AC10_skip_then_abandon` | `tickAt(S0)` → G1, offered to M; M's session claims `G1.run` (`act claim` as `Rk.claim`); `tickAt(S0 + MIN)`; `tickAt(S1)`; `tickAt(S2)`; `tickAt(S3)` | after `S0+1m`: slot S0 `startedAt` set. S1, S2: `skipped`, `reason: "overlap"`, no `goal`; `pulse.skipped` with `slot`, `running: G1`, keys exactly `["pulse","reason","running","slot"]`. At S3: G1 `dropped`; `goal.dropped {reason: "abandoned"}` for G1; `G1.run` `dropped` with `step.dropped {reason: "abandoned"}`; slot S0 `abandoned`, `reason: "max_goal_age"`; one `pulse.abandoned {pulse, slot: iso(S0)}`; slot S3 `fired` with G2 ≠ G1 | fire while overlapping, abandon at S2, wrong state/reason |
| `test_AC10_not_before_age` | same but `maxGoalAge: "3d"` and tick at `S3 − MIN` (no slot due) then at S3 | at `S3 − 1m` G1 still `in_progress` (no `pulse.abandoned`) | `>` vs `>=` (spec: `>=`; this test checks the earlier side; S3 exact checks `>=`) |
| `test_AC10_allow` | `overlap: "allow"`, claim as above, `tickAt(S1)` | slot S1 `fired` with G2 while G1 `in_progress` | skipped with allow |
| `test_AC10_done_never_blocks` | claim, then `done` G1.run (G1 `done`); `tickAt(S1)`; `tickAt(S3)` | S1 fires G2; slot S0 stays `fired` (never `abandoned`), G1 stays `done` | a done goal blocks or is abandoned |
| `test_AC10_no_machine` | no machine; `tickAt(S0)`; `tickAt(S0 + 4h)`; `tickAt(S1)`; …; `tickAt(S3)` | at `S0+4h`: slot S0 `missed`, `reason: "no_machine"`, G1 `dropped` (`goal.dropped {reason: "missed"}`); S1 fires G2; at S3 slot S0 is still `missed` (no `pulse.abandoned` for `iso(S0)`) | abandoned, or S1 skipped |
| `test_AC10_window_edge` | no machine; `tickAt(S0 + 4h − 1)` | slot S0 still `fired`, G1 `in_progress` | missed one ms early (positive control for the `>=` at `until`) |

Mutation: abandon goals that never started → `test_AC10_no_machine` red; `now − createdAt > maxGoalAgeMs`
→ `test_AC10_skip_then_abandon` red (no abandon at S3); ignore `overlap: allow` → `test_AC10_allow` red;
count `done` goals as unfinished → `test_AC10_done_never_blocks` red.

---

## AC-11 Machine choice and retries

`test/pulse-hub.test.ts`, `describe("AC-11 machine choice")`. `hubYaml` thresholds `offerExpiryMs = 30*MIN`.
ann has headless machines A and B (`r.headlessPerson`, accept `self`, repo `alpha`, labels
`["audit"]`), C (headless, offline: last seen > `machineOfflineMs` ago), D (headless, online, no label
`audit`), E (another of ann's machines, interactive). Pulse `SOLO_HL` with `target.labels ["audit"]`,
`window: "1h"`, `every 1d`, `at: T0`. Ranking: A is given a recent session in `alpha` and B none, so
`suggest` ranks A first; the test asserts this precondition with `pulseCandidates` on the same data where
practical, else by the first offer's target (see Assumption A1). No `r.pull` is called (offers stay open
until the test answers them through the offer routes as `r.act`).

| Test | Stimulus | Expected | Fails when |
|---|---|---|---|
| `test_AC11_first_offer` | `tickAt(T0)` | one open offer of `G.run` to A, `by` ann, no session/machine `by`; slot `tried` `[{machine: A, at: T0}]` (no outcome); goal `stick` = A (`by` ann); headless offer data `deadline` = `min(T0 + 30m, T0 + 1h)` = `T0 + 30m` | other target, no stick, deadline |
| `test_AC11_deadline_window_bound` | window `"20m"` instead (`every 1d`) | `deadline` = `T0 + 20m` (`until`) | not cut to the window |
| `test_AC11_declined` | A declines; `tickAt(T0 + MIN)` | `tried` `[{A, outcome: "declined"}, {B}]`; open offer to B; stick B | another order, outcome |
| `test_AC11_timeout_withdraw` | no answer; `tickAt(T0 + 19 MIN)`; `tickAt(T0 + 20 MIN)` | at 19 min still only A offered; at 20 min: A's offer `withdrawn` with `step.offer_withdrawn` reason `pulse: not accepted in time`; `tried[0].outcome` `timeout`; open offer to B | early withdraw, no withdraw, other reason |
| `test_AC11_timeout_expiry_pass` | window `"3h"`; `tickAt(T0 + 30 MIN)` | A's offer `expired` with `step.offer_expired`; no `step.offer_withdrawn` for it; `tried[0].outcome` `timeout`; B offered in the same tick | withdrawn instead, B not offered in that tick |
| `test_AC11_person_offer_waits` | before the first tick: none; `tickAt(T0)` offers A; A declines; ann `POST /v1/steps/G.run/assign` to E (a person's offer); `tickAt(T0 + MIN)`, `tickAt(T0 + 2 MIN)` | no offer to B; `tried` stays `[A]` (+ outcome); then E declines, `tickAt(T0 + 3 MIN)` → B offered | the pulse offers over a person's offer |
| `test_AC11_capacity_release` | A accepts (claimed by the accepted offer: `tried[0].outcome` `accepted`, asserted); release `G.run` with note `capacity: queue full`; `tickAt(T0 + MIN)` | `tried[0].outcome` `capacity`; open offer to B | `released`, A offered again |
| `test_AC11_release_other_note` | as above, note `busy` | outcome `released`; B offered | positive control for the `capacity:` prefix |
| `test_AC11_never_c_d_or_twice` | A declines, B declines; `tickAt` every 5 min until `T0 + 1h` | no offer of `G.run` to C or D at any time; offers per machine ≤ 1 (count `step.offered`/offers by target); slot ends `missed`, `not_accepted` | an offer to C/D, a repeat |
| `test_AC11_stick_follows` | A accepts; the audit run is completed (`G.run` claimed and `done` by A's run session through `r.runSession` + `w.tool mesh_done`, or by an act as A) for a two-step headless preset (`run` → `next`) | `G.next` is offered to A (the stick), without a pulse attempt for `G.next` (slot `tried` unchanged) | offered elsewhere or not at all |

Positive control: `test_AC11_first_offer`, `test_AC11_release_other_note`.
Mutation: no `tried` filter → `test_AC11_never_c_d_or_twice` red; offer timeout = `offerExpiryMs` always →
`test_AC11_timeout_withdraw` red; set no stick → `test_AC11_first_offer`/`test_AC11_stick_follows` red;
ignore a person's offer → `test_AC11_person_offer_waits` red; drop the target-labels filter →
`test_AC11_never_c_d_or_twice` red (D offered).

---

## AC-12 Missed reasons at window end

`test/pulse-hub.test.ts`, `describe("AC-12 missed reasons")`. Setup as AC-11 (`window: "1h"`). For each
row, `tickAt(T0 + 1h)` after the stimulus; then assert slot state `missed`, `reason`, G `dropped`,
`goal.dropped {reason: "missed"}`, no open offer of `G.run` (any open one ended `withdrawn`), one
`pulse.missed` with payload `{pulse, slot, reason, tried: <count>}` (keys exactly those four).

| Test | Stimulus | Expected reason / `tried` | Fails when |
|---|---|---|---|
| `test_AC12_no_machine` | no candidate machines at all (A and B offline) | `no_machine` / 0 | other reason |
| `test_AC12_declined_only` | only A a candidate; A declines | `not_accepted` / 1 | other |
| `test_AC12_still_offered` | only A, offline (no sync for more than `machineOfflineMs`) until its daemon syncs at `T0 + 45 MIN`; `tickAt(T0 + 45 MIN)` offers to A (timeout 20 min, so the offer is still open at `T0 + 1h`); A does not answer | `not_accepted` / 1; A's offer ended `withdrawn` | offer left open, other reason |
| `test_AC12_capacity` | A accepts, releases `capacity: full`; no other candidate | `capacity` / 1 | other |
| `test_AC12_expired` | A accepts (claimed, no `run.started`) | `expired` / 1; `G.run` (claimed) `dropped` with `step.dropped {reason: "missed"}` | other, step left claimed |
| `test_AC12_started_headless` | A accepts; `POST /v1/steps/G.run/run` with `run.started` at `T0 + 10 MIN`; `tickAt(T0 + 1h)`, `tickAt(T0 + 5h)` | slot `startedAt` `T0 + 10 MIN` (set by the report at once, before any tick); never `missed`; G `in_progress` | started slot missed |
| `test_AC12_started_interactive` | `SOLO` (interactive) with an interactive machine; claim at `T0 + 5 MIN`; `tickAt(T0 + 6 MIN)`; `tickAt(T0 + 2h)` | `startedAt` `T0 + 6 MIN`; never `missed` | missed |

Positive control: `test_AC12_started_headless`/`_interactive` (the same window end does not miss a
started slot).
Mutation: reason `not_accepted` for an accepted last try → `test_AC12_expired` red; leave the goal open →
every row red; ignore `run.started` → `test_AC12_started_headless` red.

---

## AC-13 Downtime

`test/pulse-hub.test.ts`, `describe("AC-13 downtime")`. Pulse `SOLO`, `every 1h`, `window: "30m"`,
`at: T0` (`Sk = T0 + k·HOUR`), no machine. `at(S0 − MIN)`; `w.tick()`; `w.stopHub()`; move the clock;
`w.startHubAgain()`; one `w.tick()`.

| Test | Stimulus | Expected | Fails when |
|---|---|---|---|
| `test_AC13_fires_latest_in_window` | clock `+5h11m` (now = `S5 + 10 MIN`) | slot `iso(S5)` `fired`, goal set, `until` `S5 + 30 MIN`; slots S0–S4 `missed`, `reason: "hub_down"`, no `goal`; exactly 6 slot rows; `nextAt` `S6` | stale slot fired, count |
| `test_AC13_record_none` | clock `+4h41m` (now = `S4 + 40 MIN`), `missed: record` | slots S0–S4 `missed`/`hub_down`, no goals; no `pulse.fired`; `nextAt` `S5` | S4 fired |
| `test_AC13_catch_up_once` | same with `missed: "catch-up-once"` | S4 `fired`, `catchUp: true`, `firedAt` = now, `until` = now + 30 MIN; S0–S3 `hub_down`; `pulse.fired` payload `catchUp: true`; `nextAt` `S5` | `until` from `at`, not fired, S4 also `hub_down` |
| `test_AC13_cap_10` | clock `+20h` (now = `S19 + 59 MIN`: S0–S19 due, the latest 59 min old, so none fires) | exactly 10 slot rows, all `hub_down`, for `S10`–`S19` (the latest); no goal; `nextAt` `S20` | more than 10, the oldest kept |
| `test_AC13_fired_then_stopped` | `tickAt(S0)` (fires, `until` `S0 + 30 MIN`), stop, clock to `S0 + 50 MIN`, start, tick | slot S0 `missed`, `no_machine` (not `hub_down`), its goal dropped; no other rows (S1 not due) | `hub_down` |
| `test_AC13_on_time_control` | no stop; `tickAt(S0 + 20 SEC)` | S0 `fired` | positive control: a slightly late tick fires |

Mutation: fire `L` regardless of the window → `test_AC13_record_none` red; `until` = `L + windowMs` for
catch-up → `test_AC13_catch_up_once` red; keep all rows → `test_AC13_cap_10` red; record pending fired
slots as `hub_down` → `test_AC13_fired_then_stopped` red; `nextAt = nextSlot(when, nextAt)` →
`nextAt` assertions red.

---

## AC-14 Manual fire

`test/pulse-hub.test.ts`, `describe("AC-14 manual fire")`. Pulse p-1 by ann (`SOLO`, every 1d,
`at: T0 + 2*DAY`), bob a member, carol an admin; `at(T0)`.

| Test | Stimulus | Expected | Fails when |
|---|---|---|---|
| `test_AC14_owner_fire` | ann `POST /v1/pulses/p-1/fire` | 201; `json.slot`: `slot.slot` matches `/^manual:[0-9A-HJKMNP-TV-Z]{26}$/`, `manual: true`, `by: "ann"`, `at: T0`, `state: "fired"`, `goal` set, `until` `T0 + 4h`; `nextAt` unchanged (`T0 + 2d`); `pulse.fired` with `manual: true`, `user` ann | other |
| `test_AC14_second_skipped` | fire again while G1 unfinished | 201; `state: "skipped"`, `reason: "overlap"`, no `goal` | fired twice |
| `test_AC14_paused` | pause, then fire | 201 `fired` (pulse still paused, no `nextAt`) | refused |
| `test_AC14_forbidden` | bob fires | 403 `only @ann or an admin can change pulse p-1` | 201 |
| `test_AC14_admin` | carol fires | 201, `by: "carol"` | 403 |
| `test_AC14_not_found` | fire `p-9`; fire deleted `p-1` | 404 `no pulse p-9`; 404 `no pulse p-1` | other |
| `test_AC14_blocks_scheduled` | manual fire at `T0` (G1 unfinished); `tickAt(T0 + 2*DAY)` | scheduled slot `skipped`/`overlap`, `running: G1` | manual goal ignored for overlap |

Positive control: `test_AC14_owner_fire`, `test_AC14_admin`.
Mutation: refuse fire when paused → `test_AC14_paused` red; manual fire updates `nextAt` →
`test_AC14_owner_fire` red; skip manual goals in overlap → `test_AC14_blocks_scheduled` red.

---

## AC-15 Lifecycle

`test/pulse-hub.test.ts`, `describe("AC-15 lifecycle")`. ann's pulse p-1 `SOLO` every 1d `at: T0`; bob a
member; `at(T0 − HOUR)`.

| Test | Stimulus | Expected | Fails when |
|---|---|---|---|
| `test_AC15_pause` | ann pause; `tickAt(T0)`, `tickAt(T0 + DAY)` | 200 view `enabled: false`, `pausedReason: "paused by ann"`, no `nextAt`; no slot rows; `pulse.paused {pulse, reason}` user ann | slots recorded |
| `test_AC15_pause_twice` | pause again | 409 `pulse p-1 is already paused` | 200 |
| `test_AC15_resume` | resume at `T0 + DAY + HOUR` | 200, `enabled: true`, no `pausedReason`, `nextAt` `T0 + 2*DAY`; slot rows still `[]`; `pulse.resumed {pulse}` | rows for the paused period, other `nextAt` |
| `test_AC15_resume_active` | resume an active pulse | 409 `pulse p-1 is not paused` | 200 |
| `test_AC15_update_when` | `at(T0 − HOUR + 5 MIN)`; update `when: {every: "2d"}` | `nextAt` = update time + 2d; `when.anchor` = update time; `version` unchanged | from the old anchor |
| `test_AC15_defaults_follow_period` | pulse created every 7d without window/maxGoalAge (`windowMs` 4h, `maxGoalAgeMs` 14d); update `when: {every: "1d"}`; then update `when: {every: "2h"}`; then update `{title: "x"}` | after 1d: `windowMs` `4*HOUR`, `maxGoalAgeMs` `2*DAY`; after 2h: `windowMs` `2*HOUR`, `maxGoalAgeMs` `4*HOUR`; after the title update the same; no `window`/`maxGoalAge` keys throughout | defaults frozen at create, or written into `window` |
| `test_AC15_given_window_kept` | created with `window: "4h"`, every 1d; update `when: {every: "30m"}` | `windowMs` `4*HOUR`, `window: "4h"`; `maxGoalAgeMs` `HOUR` | given value replaced |
| `test_AC15_delete` | fire (pending slot, no machine); delete; `tickAt(slot + 5h)` | 200 `{pulse: "p-1"}`; `GET /v1/pulses/p-1` 404 `no pulse p-1`; `GET /v1/pulses` has no p-1; the slot stays `fired` (not advanced to `missed`); its goal stays `in_progress`; `pulse.deleted {pulse}` | slot advanced, goal dropped |
| `test_AC15_delete_control` | same without delete | slot `missed` at window end | positive control |
| `test_AC15_owner_not_member` | admin sets ann's roles to `[]` (existing user-role route); `tickAt(T0)` | p-1 `enabled: false`, `pausedReason: "owner ann is not a member"`, no `nextAt`; one `pulse.paused` with no `user`, payload `{pulse, reason}`; no slot, no goal | fired, event with user |
| `test_AC15_owner_member_roles` (`it.each` `member`, `approver`, `admin`) | owner with only that role; `tickAt(T0)` | fires | positive control |
| `test_AC15_non_owner` (`it.each` update, pause, resume, delete) | bob | 403 `only @ann or an admin can change pulse p-1` | 200 |
| `test_AC15_not_found` (`it.each` the five POSTs) | `p-9` | 404 `no pulse p-9` | other |

Mutation: resume records the slots it passed → `test_AC15_resume` red; keep the old anchor on a `when`
update → `test_AC15_update_when` red; store the computed default in `window` → `test_AC15_defaults_follow_period`
red; advance deleted pulses' slots → `test_AC15_delete` red; check owner membership by user existence
only → `test_AC15_owner_not_member` red.

---

## AC-16 Hidden goals

`test/pulse-hub.test.ts`, `describe("AC-16 hidden goals")`; CLI part in `test/pulse-cli.test.ts`. Topic `t`
exists; pulse p-1 (`SOLO`, `topics: ["t"]`) fired → GP; ordinary goal GO (topic `t`); ordinary goal GX
(no topic).

| Test | Stimulus | Expected | Fails when |
|---|---|---|---|
| `test_AC16_default_list` | `GET /v1/goals` | contains GO, GX; not GP | GP listed |
| `test_AC16_with_pulses` | `GET /v1/goals?pulses=1`; `?pulses=1&topic=t` (the existing topic filter param) | GP, GO, GX; then GP, GO only | GP missing, topic filter dropped |
| `test_AC16_live` | `GET /v1/live` | `goals` has GO and not GP | GP listed |
| `test_AC16_detail_attention` | `GET /v1/goals/GP` → 200; GP.run claimed by ann's session and `done` with `outcome: "fail"`; attention (`GET /v1/attention` or the route RL-2 uses) | GP's failed step appears | hidden there |
| `test_AC16_cli` (CLI) | `mesh goal ls` vs `mesh goal ls --pulses` | GP's id absent / present; GO present in both; the request of the second has `pulses=1` | other |

Positive control: GO in every list; `test_AC16_with_pulses`.
Mutation: filter on `refs` presence instead of `refs.pulse` → ingest goal hidden (`test_AC18_listed`) red;
ignore `pulses=1` → `test_AC16_with_pulses` red; filter applied to detail → `test_AC16_detail_attention`
red.

---

## AC-17 Reads and scopes

`test/pulse-hub.test.ts`, `describe("AC-17 reads")`. ann's p-1 (built-in, 12 manual fires with
`overlap: allow` so there are 12 slots; or 12 ticks) and p-2; bob's p-3 (deleted p-4 by bob). Service
tokens made through the existing token route: `R` (`goals:read`), `W` (`goals:write`).

| Test | Stimulus | Expected | Fails when |
|---|---|---|---|
| `test_AC17_list` | ann `GET /v1/pulses` | ids `[p-1, p-2, p-3]` (by number, p-4 left out); each `preset` keys ⊆ `name, sha256, source` (no `text`); `profiles` values are 64-hex strings (no settings objects); `JSON.stringify` contains no preset text marker and no profile `allow` marker | text or settings present, deleted listed |
| `test_AC17_recent` | p-1 row | `recent.length` 10; newest first by `at` then `slot` (asserted against the sorted slot list from detail) | 12, ascending |
| `test_AC17_mine` | bob `?mine=1` | `[p-3]` | filter ignored |
| `test_AC17_detail` | p-1 with 55 slots (55 manual fires, `overlap: allow`, cheaper: 55 ticks of an every-5m pulse) | `slots.length` 50, newest first; `goals` maps every slot goal id to its state (one checked dropped, one `in_progress`); `pulse.preset.text` present in detail (`Pulse`) | count, order, map wrong |
| `test_AC17_scopes` | token R: both GETs → 200; R: `POST /v1/pulses`, `…/fire` → 403; W: `POST /v1/goals/from-preset` → 201; R: `from-preset` → 403 | as listed | other status |

Positive control: 200s for R, 201 for W.
Mutation: `recent` from oldest → `test_AC17_recent` red; no `mine` filter → red; give `POST /v1/pulses`
scope `goals:read` → `test_AC17_scopes` red.

---

## AC-18 Ingest

`test/pulse-hub.test.ts`, `describe("AC-18 ingest")`.

| Test | Stimulus | Expected | Fails when |
|---|---|---|---|
| `test_AC18_create` | ann `POST /v1/goals/from-preset` with built-in snapshot, `RELAY_PARAMS`, `refs: {ticket: "x"}`, `topics: ["t"]` | 201 `GoalDetail`; steps `audit`, `validate`, `file` and no `design`; plan v1 approved, `proposedBy` = `decidedBy` = ann, comment `ingest (preset audit-relay <sha12>)`; `ownerId` ann; `profiles` snapshotted (keys `propose-via-branch`, `read-only`); `refs` `{ticket: "x"}`; title `audit-relay on alpha`; priority 3 | design step, missing snapshot |
| `test_AC18_listed` | `GET /v1/goals` (no `pulses`) | contains the ingest goal | hidden |
| `test_AC18_no_auto_offer` | `w.tick()` | no offer of the audit step (no pulse attempt, no stick) | auto-offered |
| `test_AC18_refs_reserved` (`it.each` `pulse`, `slot`) | `refs: {pulse: "p-1"}`; `refs: {slot: "x"}` | 400 `refs.pulse and refs.slot are set by pulses only` | 201 |
| `test_AC18_sha` | sha mismatch | 400 documented text | other |
| `test_AC18_problem` | `TWO_ROOTS` | 422 with the AC-06 text | 201 |
| `test_AC18_source_rejected` | snapshot with `source` | 400 (zod) | accepted |

Mutation: ingest comment `pulse …` → `test_AC18_create` red; set `refs.pulse` on ingest → `test_AC18_listed`
red; no reserved-refs check → `test_AC18_refs_reserved` red.

---

## AC-19 Built-in `audit-relay`

Unit `src/core/presets.test.ts`, `describe("audit-relay")`; CLI in `test/pulse-cli.test.ts`.

| Test | Stimulus | Expected | Fails when |
|---|---|---|---|
| `test_AC19_description` | the `audit-relay` entry | description exactly `Audit by an agent, validated by an agent, filed by an agent (agent-only; a person's debrief comes with S4).` | other |
| `test_AC19_instantiate` | `instantiate(<audit-relay>, {repo: "/src/alpha", goal: "G", params: {repo, agent: "a1", validator: "v1", filer: "f1"}})` | steps (id, kind, deps, repo, title, policy) exactly the documented table: `audit` review, no deps, `agent: "a1"`, `mode: "headless"`, `profile: "read-only"`, `output: "review-record"`, `budget {turns: 80, minutes: 60}`, `inputs ["previous"]`, title `Audit /src/alpha` (or `{repo}` substitution as RL-1 does); `validate` deps `[audit]`, agent `v1`, `when {open: true}`, `consumes ["open"]`, `may_set ["confirmed","dismissed"]`, `inputs ["audit","dispositions"]`, title `Validate the findings`; `file` kind `docs`, deps `[validate]`, agent `f1`, `profile: "propose-via-branch"`, `consumes ["confirmed"]`, `may_set ["accepted"]`, `inputs ["dispositions"]`, title `File the confirmed items`, brief exactly the documented sentence; no `assignee`, no `debrief` step | a step, dep, field or brief differs |
| `test_AC19_policies_clean` | `validatePlan` and `validatePolicies` of that plan | `[]` both | an error |
| `test_AC19_missing_filer` | params without `filer` | throws `preset audit-relay: unknown parameter {filer} in step file` | other message |
| `test_AC19_preset_ls` (CLI) | `mesh preset ls` | a line naming `audit-relay` | missing |

Positive control: `test_AC19_policies_clean`.
Mutation: `file` `consumes: ["accepted"]` → `test_AC19_instantiate` red; drop `may_set` on `file` →
`test_AC19_instantiate` red; a `debrief` step added → red; `filer` param not substituted (literal
`{filer}`) → `test_AC19_missing_filer` red (no throw).

---

## AC-20 CLI `mesh pulse`

`test/pulse-cli.test.ts`. CLI runs through `r.cli(p, args, {cwd})`; the request the CLI sends is
captured at the hub (World `syncBodies`/a request log, or the resulting pulse) and with
`Person.failOnce` for error paths. A test-side `TZ` for the CLI process is set (`TZ=Europe/Berlin` in
the runner env) so the `Intl` default is known.

| Test | Stimulus | Expected | Fails when |
|---|---|---|---|
| `test_AC20_add_builtin` | `mesh pulse add --preset audit-relay --repo /src/alpha --params agent=a,validator=v,filer=f --every 7d` from a dir that is no git repo | exit 0; stdout exactly `Created pulse p-1 "audit-relay on alpha": every 7d, next run <iso(now+7d)>.`; stored `preset.text === presetText(<built-in>)`, `sha256` = its sha, no `source`; `params` `{agent, validator, filer, repo: "/src/alpha"}` | text, body or exit |
| `test_AC20_add_cron_tz_default` | `--cron "0 9 * * 1"` without `--tz` | stored `when.tz` `Europe/Berlin` (the process `Intl` zone); `schedule` `cron "0 9 * * 1" Europe/Berlin` | other zone |
| `test_AC20_add_flags` | `--title T --topics t --labels a,b --machines m --window 2h --overlap allow --max-goal-age 3d --missed catch-up-once --paused --at 2026-11-20T09:00:00Z --every 1d` | stored fields match; `enabled: false`; stdout `…, next run -.` | a flag not sent |
| `test_AC20_add_repo_source` | covered by `test_AC07_cli_repo_preset` (source only for a repo file) | — | — |
| `test_AC20_add_errors` (`it.each`) | no `--preset`; no `--repo`; neither `--every` nor `--cron`; both; `--at yesterday`; `--params x`; `--preset nope` | exit 2; usage / `give one schedule: --every <duration> or --cron "<5 fields>"` (both schedule rows) / `--at takes an ISO time, e.g. 2026-11-16T09:00:00Z` / RL-1's `--params` text / `findPreset`'s unknown-preset text; `GET /v1/pulses` still empty (no request) | exit 1, request sent |
| `test_AC20_ls` | two pulses (one paused, one with a missed `recent[0]` `(no_machine)`) | lines exactly `p-1  active  @ann  every 7d  next <iso>  last missed (no_machine)  <title>` and `p-2  paused  @ann  every 1d  next -  last -  <title>` | spacing, fields |
| `test_AC20_ls_empty_json` | no pulses; `--json` with one | `No pulses. Create one: mesh pulse add --preset <name> --repo <repo> --every 7d`; JSON equals the route reply | other |
| `test_AC20_show` | p-1 with a repo source and slots (one fired with tried A,B; one skipped) | first line `p-1 "<title>"  @ann  active`; a paused one `paused: paused by ann`; lines starting `schedule: `, `preset: ` (contains name, sha12, `from alpha@<commit sha12>`, `agent=…` comma list), `target: `; `slots:`; slot lines `  <slot>  fired  <goal>  tried A,B` and `  <slot>  skipped (overlap)  -`, newest first; `--json` = `PulseDetail` | other format/order |
| `test_AC20_update` | `mesh pulse update p-1 --window 2h` | the hub sees a body with only `window` (version unchanged, preset unchanged); stdout `Updated pulse p-1; next run <iso>.`; `--repo /src/beta` sends full `params` (other params kept from the CLI's `--params` only, as given) | other fields sent |
| `test_AC20_pause_resume_rm` | `pause`, `resume`, `rm` | `Paused pulse p-1.`; `Resumed pulse p-1; next run <iso>.`; `Removed pulse p-1 (its goals stay).` | text |
| `test_AC20_fire` | fire (fired); fire again (skipped) | `Fired pulse p-1: slot <slot> → <goal>.` exit 0; `Pulse p-1 skipped slot <slot>: <goal> is still running (overlap: skip).` exit 0 | exit or text |
| `test_AC20_hub_error` | bob `mesh pulse pause p-1` | exit 1; stderr contains `only @ann or an admin can change pulse p-1` | exit 0/2 |
| `test_AC20_unknown_sub` | `mesh pulse frob` | exit 2, usage | other |
| `test_AC20_help` | `mesh help` | lists `pulse` | missing |

Positive control: successful `add` and `fire`.
Mutation: send `source` for a built-in preset → `test_AC20_add_builtin` red; default `--tz` `UTC` →
`test_AC20_add_cron_tz_default` red; `update` sends all fields → `test_AC20_update` red (version bump);
exit 1 for skipped → `test_AC20_fire` red.

---

## AC-21 Events and redaction

`test/pulse-hub.test.ts`, `describe("AC-21 events")`. Marker `M1 = "zqx-preset-mark-7"` in the brief of a
`SOLO_HL` variant preset; marker `M2 = "zqx-profile-mark-9"` in the `allow` of a registered profile the
preset step uses. One pulse driven through every event: created, updated, paused, resumed, fired,
skipped, missed (no machine), abandoned (claimed goal, `maxGoalAge` reached), fire error (AC-29 wrapper),
deleted.

| Test | Stimulus | Expected | Fails when |
|---|---|---|---|
| `test_AC21_keys` (`it.each` over the table rows) | the event of each type for p-1 | `Object.keys(payload).sort()` exactly: `pulse.created` `[preset,pulse,schedule,sha256,title]`; `pulse.updated` `[fields,pulse,version]` with `fields` sorted body keys (update `{window, overlap}` → `["overlap","window"]`); `pulse.paused` `[pulse,reason]`; `pulse.resumed`/`pulse.deleted` `[pulse]`; `pulse.fired` `[pulse,slot]` (+ `manual`/`catchUp` only when true); `pulse.skipped` `[pulse,reason,running,slot]`; `pulse.missed` `[pulse,reason,slot,tried]` and with reason `error` also `error`; `pulse.abandoned` `[pulse,slot]`; `goal.dropped` `[reason]`; `step.dropped` (pulse drop) `[reason]`. Top-level fields: `user` set where the table says, `goal` set on fired/missed-with-goal/abandoned/goal.dropped, `step` on step.dropped | missing or extra key |
| `test_AC21_step_dropped_by_plan` | a replan that drops a step of an ordinary goal | `step.dropped` without `payload.reason` | reason added |
| `test_AC21_no_markers` | all events (`allEvents`) and `mesh ledger export` output | neither `M1` nor `M2` appears | a marker found |
| `test_AC21_markers_control` | `GET /v1/pulses/p-1` (detail has `preset.text`); the profile route | `M1` found in detail, `M2` found in the profile | positive control: markers really exist |
| `test_AC21_activity` | `GET /v1/live` activity | a line naming `p-1` for `pulse.fired` (and for each `pulse.*`); the line for the missed slot goal's `step.dropped` contains `dropped: its pulse slot was missed` and not `dropped by a new plan`; for abandoned `dropped: its goal was abandoned` | no line, wrong text |

Mutation: put the preset snapshot in `pulse.created` → `test_AC21_no_markers` red; unsorted `fields` →
`test_AC21_keys` red; `describe()` ignoring `reason` → `test_AC21_activity` red.

---

## AC-22 End to end with the fake `claude`

`test/pulse-daemon.test.ts`, one long test `test_AC22_relay_two_slots` split into named `it` steps
sharing a World (sequential). Owner ann = `r.headlessPerson("ann", {repo: "alpha", agents: {auditor,
checker, filer}})` with accept `self`; `r.commitAgents`. Run sessions are driven with `r.runSession` +
`w.tool` (as RL-1/RL-2 daemon tests do); the fake holds each run with `waitFor` until the test calls
`r.go`; the `file` run's script has `{"commit": true}`.

| Test | Stimulus | Expected | Fails when |
|---|---|---|---|
| `test_AC22_add` | `mesh pulse add --preset audit-relay --repo alpha --params agent=auditor,validator=checker,filer=filer --every 7d` | p-1 created; `nextAt` = now + 7d | — |
| `test_AC22_fire_audit` | clock to `nextAt`; `w.tick()`; `r.pull(ann)` | slot 1 `fired` with G1; `G1.audit` offered to ann's machine, auto-accepted, the fake started (`r.started("G1.audit")`); the fake's `--settings` (per RL-1, read from its argv in `r.calls`) has the profile hash / settings equal to `pulse.profiles["read-only"]` (sha256 and compiled settings) | other machine, other profile |
| `test_AC22_audit_record` | run session: `mesh_artifact` (report), `mesh_review` (complete; items A S2, B S3, with evidence), `mesh_done`; `r.go`; `w.tick()` | slot 1 `startedAt` equals the World clock at the `run.started` report (the clock is moved 1 min before the next tick); `G1.audit` done; round has `telemetry` | startedAt missing |
| `test_AC22_validate` | `G1.validate` offered to ann's machine via stick (offer target = stick, no new `tried` entry); run session `mesh_review` with dispositions B `dismissed`, A `confirmed`; done | item A `confirmed`, B `dismissed`; round `telemetry` | offered elsewhere |
| `test_AC22_file` | `G1.file` (propose-via-branch) runs, fake commits; `mesh_review` sets A `accepted` with `link`; done | A `accepted` with that link; G1 `done`; round `telemetry` | not run |
| `test_AC22_second_slot` | clock +7d; tick; audit run repeats A and B with the same evidence | G2 created; B stays `dismissed` with `fold.carried: 1` in the record's fold; A stays `accepted` with its link; `G2.validate` and `G2.file` `skipped`; G2 `done`; no fake call for `G2.file` (`r.calls("G2.file")` empty) | re-filed, dismissal lost |
| `test_AC22_pulse_view` | `GET /v1/pulses/p-1`; `GET /v1/goals`; `?pulses=1` | two `fired` slots with `startedAt`, goals G1, G2 (`goals` map both `done`); G1/G2 absent by default, present with the flag | slot fields missing, goal shown |

Positive control: the first-slot steps actually run (calls recorded) before the second slot asserts that
`file` did not.
Mutation: `file` without `may_set: [accepted]` (built-in changed) → `test_AC22_second_slot` red (filer runs
again); no stick → `test_AC22_validate` red; `startedAt` set only by the next tick instead of by the
`run.started` report → `test_AC22_audit_record` red (it asserts `startedAt` equals the report's clock,
and the clock is moved by 1 min before that tick).

---

## AC-23 Web: Pulses on the Mine page

`test/e2e-web/mine.spec.ts`, `test.describe("AC-23 pulses on the Mine page")`. The e2e hub is shared:
the test creates its own pulse through the API with a unique title (`pulse-<random>`) and finds it by
`data-pulse`, never by count.

| Test | Stimulus | Expected | Fails when |
|---|---|---|---|
| `test_AC23_pulse_shown` | as the e2e user U, `POST /v1/pulses` (one interactive step preset, `every: "1d"`); open Mine | `section.pulses` with heading `Pulses`, placed after the "Assigned to you" section (DOM order); `div.pulse[data-pulse="<id>"]` contains the id, title, `every 1d`, `active`, `next ` | missing element/text |
| `test_AC23_slots` | two `POST …/fire` through the API; reload | `li[data-slot]` with class `slot-fired` containing `fired` and the goal id; `li[data-slot]` with class `slot-skipped` containing `skipped` and `(overlap)` | class or text missing |
| `test_AC23_foreign_hidden` | another user V creates a pulse (API with V's token) | no `div.pulse[data-pulse="<V's id>"]` on U's page | shown |
| `test_AC23_empty` | a fresh user W with no pulses opens Mine | text `No pulses. Create one with mesh pulse add.` | missing |
| `test_AC23_read_only` | U's pulse element | contains no `button` | an action control |

Mutation: fetch without `mine=1` → `test_AC23_foreign_hidden` red; class `slot-${reason}` →
`test_AC23_slots` red.

---

## AC-24 Compatibility

`test/pulse-hub.test.ts`, `describe("AC-24 compatibility")`.

| Test | Stimulus | Expected | Fails when |
|---|---|---|---|
| `test_AC24_create_goal_design` | `POST /v1/goals` | a `G.design` step; listed by `GET /v1/goals`; no `profiles` key on the goal | changed |
| `test_AC24_live_profile` | ordinary goal with a headless step; register/replace profile, offer | offer `profile.sha256` = the current (replaced) sha | snapshot used |
| `test_AC24_tick_unchanged` | no pulses: an ended holder's step paused by the tick, an offer expired by the tick (existing scenarios from RL-1/MM-3 tests) | the same states and events as before (`step.paused`, `step.offer_expired`); no `pulse.*` event; `listPulses` empty | other result |

Mutation: put `profiles` on every goal → `test_AC24_create_goal_design` red; run the pulse pass before the
expiry pass → `test_AC11_timeout_expiry_pass` red (cross-check).

---

## AC-25 `mesh hub migrate`

`test/m46-ops.test.ts`, `describe("RL-3 tables")`, Postgres only (skipped without `PG_URL`).

| Test | Stimulus | Expected | Fails when |
|---|---|---|---|
| `test_AC25_copy` | SQLite hub with p-1 and p-2 (p-2 deleted), three slots (two of p-1, one of p-2, one with `startedAt`); `mesh hub migrate` to Postgres | row counts equal for `pulse` (2) and `pulse_slot` (3); `getPulse("p-2").deletedAt` kept; `listSlots({pending: true})` equal before/after; `createPulse` on Postgres gives `p-3` | table missing, mismatch, `p-1`/`p-2` reused |

Mutation: omit `pulse_slot` from `TABLES` → red; compute `num` from a sequence not copied → `p-1` → red.

---

## AC-26 Docs

`test/schemas.test.ts` (existing skill test) plus review.

| Test | Stimulus | Expected | Fails when |
|---|---|---|---|
| `test_AC26_skill_equal` | existing test: `MESH_SKILL` equals `skills/mesh/SKILL.md` | equal | mismatch |
| `test_AC26_skill_mentions` | `MESH_SKILL` | contains `pulse` (case-insensitive) and `mesh pulse`, and states there is no design step for pulse goals (contains `design step`) | missing |
| `test_AC26_docs_sections` | `docs/guide/concepts.md` contains a `Pulses` heading and the words `snapshot`, `catch-up-once`, `maxGoalAge`, `hub_down`, `audit-relay`, `ingest`; `docs/guide/howto.md` contains `Run an agent audit on a schedule` and `mesh pulse add --preset audit-relay`; `docs/plan/implementation-plan.md` contains `/v1/pulses` and `/v1/goals/from-preset` and `pulses=1`; `docs/events.md` contains every new event type and `goal.dropped` | present | missing |
| review | reviewer greps the diff for team-, company- or person-specific names | none | a name |

Mutation: regenerate the skill file without the source change → `test_AC26_skill_equal` red.

---

## AC-27 Checks, schema, boundaries, version

`test/schemas.test.ts` plus running the commands.

| Test | Stimulus | Expected | Fails when |
|---|---|---|---|
| `test_AC27_version` | `package.json` | `0.1.17` | other |
| `test_AC27_openapi_routes` | `schemas/hub-api.openapi.json` | the 10 new routes present (`GET`/`POST /v1/pulses`, `GET /v1/pulses/{id}`, the five `POST …/{id}/…`, `POST /v1/goals/from-preset`), each rule `member`, scope as the table (`goals:read` for GETs, none for pulse POSTs, `goals:write` for from-preset), tag `goals`; `GET /v1/goals` documents query `pulses`; file equals `pnpm schemas` output (existing test) | stale/missing |
| `test_AC27_hub_api_table` | existing `HUB_API` vs `app.ts` test | passes | — |
| `test_AC27_core_boundaries` | `pnpm boundaries` and the existing boundaries test | `src/core/schedule.ts`, `src/core/pulse.ts` import no hub/store | violation |
| commands | `pnpm check`, `pnpm build && pnpm test:web` | pass | any fails |

---

## AC-28 Window equal to the period

`test/pulse-hub.test.ts`, `describe("AC-28 window = period")`. Pulse `SOLO`, `every 30m`, `at: T0`, no
window (default 30 min), no machine. `Sk = T0 + k·30 MIN`. Two runs (`it.each` offset `0` and `20_000`).

| Test | Stimulus | Expected | Fails when |
|---|---|---|---|
| `test_AC28_every_slot_fires` | `tickAt(S0 + off)`, `tickAt(S1 + off)`, `tickAt(S2 + off)` | slots S0, S1, S2 all have a `goal` (three distinct goals; three `pulse.fired`); S0 and S1 `missed`/`no_machine` with their goals `dropped`; S2 `fired`; no slot `skipped`; `until` of S0 = `S0 + 30 MIN` (from `at`, not from the tick) | a skipped slot, fewer goals, an open missed goal |

Mutation: `until = firedAt + windowMs` for scheduled slots → offset 20 s run red (S1 skipped); fire before
advance and no retire → red.

---

## AC-29 Fire errors and deleted topics

`test/pulse-hub.test.ts`, `describe("AC-29 errors and topics")`; CLI part in `test/pulse-cli.test.ts`.
Topic `t`; p-1 (`SOLO`, topics `["t"]`, every 1d `at: T0`), p-2 (`SOLO`, same schedule).

| Test | Stimulus | Expected | Fails when |
|---|---|---|---|
| `test_AC29_topic_delete` | `POST /v1/topics/t/delete`; `tickAt(T0)` | p-1 `topics` `[]`, `version` 1, `updatedAt` = delete time; one `pulse.updated {pulse: "p-1", version: 1, fields: ["topics"]}` with `user` = caller; p-2 no event; `topic.deleted` payload unchanged; both p-1 and p-2 `fired` at `T0` | topic kept (fire fails), version bumped |
| `test_AC29_fire_error` | `storeWrap` whose goal insert throws `Error("boom-<500+ chars>")` for goals with `refs.pulse = p-1`; `tickAt(T0)` | p-1 slot `missed`, `reason: "error"`, `error` = the first 500 chars, no `goal`; no goal with `refs.pulse = p-1`; `pulse.missed` payload `{pulse, slot, reason: "error", tried: 0, error}`; p-1 `nextAt` `T0 + 1d`; p-2 `fired` in the same tick | rollback without record, p-2 not fired, stuck `nextAt` |
| `test_AC29_no_retry` | remove the wrapper; `w.tick()` at `T0 + MIN` | p-1 slot `iso(T0)` still `missed`/`error`; no goal for it | retried |
| `test_AC29_manual_error` | wrapper on; ann `POST /v1/pulses/p-1/fire` | 201; `slot` `missed`, `reason: "error"`, `manual: true`, `error` set | 500 |
| `test_AC29_cli_manual_error` (CLI) | same via `mesh pulse fire p-1` | stdout/stderr `Pulse p-1 missed slot <slot>: <error>`; exit 1 | exit 0 |
| `test_AC29_second_tx_throws` | wrapper also throws on the error-record write (`addSlot`) for p-1; tick; remove; tick | first tick: no row for p-1, log contains `hub tick failed`, p-2 fired; second tick: p-1's slot recorded (fired, within the window) | tick aborted for p-2, p-1 never retried |

Positive control: p-2 fires in every row.
Mutation: let the throw escape the per-pulse loop → `test_AC29_fire_error` red (p-2 not fired); not
advancing `nextAt` on error → red; `deleteTopic` not touching pulses → `test_AC29_topic_delete` red.

---

## Assumptions (conservative readings; the spec is not changed by this plan)

- A1 (AC-11): the spec does not say which `suggest` signal ranks A over B. The test gives A a recent
  session in `alpha` (a signal MM-3's suggest ranks) and asserts the precondition by calling
  `pulseCandidates` with the same machines and sessions read from the hub (`GET /v1/machines`); if that
  read is not possible black-box, the test takes the first offer's target as "A" and the other as "B".
- A2 (AC-09, AC-29): a `HubStore` wrapper needs a seam in `test/helpers/world.ts`; the test-writer adds it
  (spec: "the test side may extend them").
- A3 (AC-12 `test_AC12_still_offered`): to have the last try still offered when the window ends, a second
  candidate comes online late; the timeout for window 1h is 20 min (`min(30m, 20m)`). If bringing a
  machine online mid-test is not possible in World, the row uses `offerExpiryMs = 2h` and `window: "1h"`
  with a single machine whose offer is made at `T0 + 45 MIN` after an earlier person's offer ended.
- A4 (AC-15): the user-role change uses the existing admin route for roles; roles `[]` means the user
  row exists with no role.
- A5 (AC-17): slot volume for `recent`/detail limits is produced with an `every 5m` pulse and ticks, not
  50 manual fires, when that is faster; the assertions are the same.
- A6 (AC-22): the run's tool calls go through `runSession` + `w.tool` (as RL-1/RL-2 daemon tests), not a
  fake-claude MCP action; the fake only keeps the run alive and commits for `file`.
- A7 (AC-02 `test_AC02_gap_coincide`): "slots that coincide are one slot" is checked with a cron whose
  gap-mapped wall minutes and a real minute coincide; expected instants are computed by hand from
  Europe/Berlin's 2026-03-29 gap (02:00–03:00 CET→CEST, `01:00Z`).
- A8 (AC-20): the CLI's `Intl` time zone is controlled through the `TZ` env var of the CLI process run
  by `r.cli`; if `r.cli` runs in-process, the test reads `Intl.DateTimeFormat().resolvedOptions().timeZone`
  and expects that.
- A9: open questions are recorded here, not in the spec, because this role commits only the test plan.
