Verdict: CHANGES REQUESTED | Round: 1 | Blocking-open: 5

# Review of spec RL-3, round 1

I reviewed `docs/specs/RL-3.md` (revision 1, commit 7ef84ab) cold. I checked it against
`docs/analysis/2026-11-12-pulse-relay-roster.md` (REQ-1, REQ-2, R-6, §5.5, §5.6, §5.9, §6, §9 S3) and
`docs/analysis/2026-11-12-claude-cli-spike.md`, which says nothing about pulses. I also checked it
against the code on `feat/relay-design`:
- `src/hub/service.ts`: `goalTx`, `offerStep`, `emitReady`, `setStick`, `headlessGuard`,
  `resolveProfile`, `createGoal`, `approvePlan`, `releaseStep`, `runReport`, `deleteTopic`, `live`,
  `tick`, `describe`
- `src/hub/app.ts`: the route table and the idempotency middleware
- `src/hub/server.ts`: the tick timer and its error handling
- `src/hub/config.ts`: the thresholds
- `src/core/{suggest,offers,presets,policy,review,roles}.ts`
- `src/protocol/{goal,hub,hub-api}.ts`
- `src/store/{hub-store,hub-copy,dialect}.ts`
- `src/cli/hub-commands.ts`: `findPreset`, `parseParams`
- `src/cli/hub-client.ts`
- `web/src/mine.tsx`
- `test/helpers/world.ts`, `test/schemas.test.ts`

`docs/specs/reviews/RL-3/` did not exist before this round, so every finding is NEW. None is a REPEAT
or a REGRESSION-OF-OWN-REPAIR.

## Checks

This is a spec review, so there is no code to build. I did not run any of these: `pnpm lint`,
`pnpm typecheck`, `pnpm boundaries`, `pnpm test`, `pnpm build` (together `pnpm check`), `pnpm schemas`,
or `pnpm test:web`. I used only `git`, `grep`, `sed`, `cat` and file reads. I did not run the `claude`
binary.

## What already matches the code

- **Migration 10.** `HUB_MIGRATIONS` and `HUB_MIGRATIONS_PG` each have 9 entries today, and
  `SCHEMA_VERSION = HUB_MIGRATIONS.length`. Adding one entry to each list gives 10. `TABLES` in
  `hub-copy.ts` ends with `item_history`, so "after `item_history`" is the right place.
- **Offers.** `offerStep` already builds the headless offer data (`profile`, `budget`, `deadline`) from a
  snapshot. `headlessGuard` is the single place where the snapshot is resolved, so the
  `goal.profiles` rule has one place to change. `emitReady` offers to the stick target with
  `by = stick.by`, so pulse offers made "by the owner, no machine" get `auto` from `acceptMatches`
  `self` / `user:<owner>`, as AC-11 and AC-22 need.
- **Candidates.** `suggest` already filters on repo and computes `auto` and `online` from an `onlineMs`
  parameter. `pulseCandidates` as specified is a filter over it, and it stays a pure core function.
- **Presets.** `instantiate` throws `preset <name>: unknown parameter {<p>} in step <id>` only for
  `agent`/`profile`, which matches the texts in AC-06 and AC-19. `presetText`/`parsePreset` round-trip.
  `lineageOf` reads `goal.preset.name`, so AC-08's lineage holds.
- **Review records.** `RecordDisposition.link` exists, so the agent-only `file` stage recording
  `accepted` with a link (Open question 1) is supported by RL-2.
- **Routes.** `HUB_API` rows carry `rule`, `scope` and `tag`, and `test/schemas.test.ts` compares them with
  `app.ts`, so AC-27 has a real surface. The CLI's `HubClient.post` always sends an `Idempotency-Key`, and
  the app middleware replays it, so `mesh pulse add`/`fire` retries are safe.
- **World.** It has `clock`, `tick()`, `stopHub()` and `startHubAgain()`, as AC-09 to AC-15 assume.

## Findings

### F1 (blocker, NEW): the tick fires new slots before it retires missed ones, so the default configuration skips every other slot

**Tick** runs (a) "fires due pulses", then (b) "advances pending slots". The overlap check in (a)
treats every goal of the pulse that is not `done`/`dropped` as running. A goal whose window has
already ended is only dropped later, in (b) step 2.

The default window is `min(4h, period)`, so it equals the period for every pulse of 4 h or less.
AC-06 confirms this for `every 30m`: `windowMs` = 30 min. Here is what happens to such a pulse with no
machine (or one that never starts the run):
- slot S0 fires G0 at t0;
- the tick at t0+30m runs (a) first;
- S1 (due at t0+30m) sees G0 still unfinished, so S1 is `skipped`/`overlap`;
- only then does (b) record S0 `missed` and drop G0.

The result alternates fired, skipped, fired, skipped. After downtime that is shorter than `maxGoalAge`,
the first slot is also skipped behind a goal that is dead in the same tick.

This contradicts the spec's own Open question "Missed slots drop their goal. Otherwise a never-started
goal would block the following slots". It is a wrong decision.

Fix: run (b) before (a), or have (a) apply the window-over rule to a pending slot's goal before the
overlap check. Then add an AC for it: `every 30m`, no machine, three ticks at three slots → three
`fired` and two `missed`, no `skipped`.

### F2 (blocker, NEW): AC-10 cannot pass against the spec's own rules

AC-10 sets "every 1d, `maxGoalAge` 3d, no machine". It expects G1 to stay unfinished through slots 2
and 3 (both skipped) and to be abandoned at slot 4. But with no window given, `windowMs` =
`min(4h, 1d)` = 4 h. At slot1+4h, (b) step 2 records slot 1 `missed`, reason `no_machine`, and drops G1.
So:
- slot 2 fires G2 instead of being skipped;
- G1 never reaches the 3-day age;
- slot 1 ends `missed`, not `abandoned`.

The AC also says "an open offer withdrawn", but with no machine there is no offer.

A correct implementation therefore fails this AC. The AC cannot fail for the reason it names, and it
fails for another.

Fix: a goal can only grow old enough to be abandoned if it has **started** (`startedAt` set) and has
not finished. Rewrite AC-10 on a started run step, for example:
- an interactive run step claimed by a machine's session;
- or a headless one with a `run.started` report and no `mesh_done`.

Keep a separate line for "no machine → `missed` at window end, not `abandoned`".

### F3 (blocker, NEW): in AC-11 the existing offer-expiry pass wins, so the pulse never withdraws

In AC-11, `offer_expiry` is 30 min and the window is 3 h, so `offerTimeoutMs` = `min(30 min, 1 h)` =
30 min, the same as `offerExpiryMs`.

**Tick** says the existing work, including the offer-expiry pass, runs first. That pass expires every
`ready` step whose offer is `now - o.at >= offerExpiryMs` (`service.ts` `tick`). It sets
`offer.state = "expired"` and emits `step.offer_expired`. By the time (b) step 3 runs, there is no open
offer left to withdraw. The outcome still becomes `timeout`, through "`expired` or `withdrawn` →
`timeout`".

AC-11 asserts "the tick withdraws A's offer (reason `pulse: not accepted in time`, outcome
`timeout`)". No such `step.offer_withdrawn` event happens. Either the AC fails against a correct
implementation, or the implementation has to bypass the existing expiry pass, which AC-24 forbids.

Fix: choose numbers where the pulse timeout is shorter than the expiry, e.g. window 1 h → timeout
20 min. Also say explicitly that when the two are equal the expiry pass decides, with outcome `timeout`
and event `step.offer_expired`.

### F4 (blocker, NEW): a fire that throws has no defined outcome, and a deleted topic makes every fire throw

Create-with-plan copies `topics`, and **Defaults on save** normalizes them "as for goals". The hub's
existing topic check (`knownTopics`, used by `createGoal`) answers 400 for an unknown topic. But
`deleteTopic` (`service.ts`) strips the topic from goals only. It does not touch pulses, and the spec
does not change it.

So after `POST /v1/topics/<t>/delete`, every fire of a pulse tagged `<t>` throws inside its `goalTx`.
The `addSlot` row rolls back with the goal. The timer in `server.ts` logs `hub tick failed` and moves on.
The spec does not say whether `nextAt` advances, whether the other due pulses in the same loop still
run, or what is recorded. REQ-2 says "every slot … recorded … with a reason", and here the slot leaves
no record at all and is retried, failing, on every tick.

The same gap applies to any other fire-time error, for example `instantiate`/`PlanInput.parse`
rejecting a value or a store error.

Fix: decide both of these.
1. Either `deleteTopic` also strips the topic from pulses (event `pulse.updated`), or create-with-plan
   on a fire drops unknown topics.
2. A fire whose create-with-plan throws records the slot `missed` (or a new `SlotState`/`SlotReason`,
   e.g. `error`) with the message. `nextAt` still advances, and the other pulses still run.

Add an AC: delete the pulse's topic, tick at the slot → the slot is recorded and the next pulse in the
same tick still fires.

### F5 (blocker, NEW): `every` with a future `at` conflicts between the formula and AC-06

**`nextSlot` for every** is "the smallest `anchor + k·period > after` over **all integers** k". For an
anchor 30 days ahead with period 7 d, `nextSlot(now)` is `anchor − 28d` (2 days from now), not the
anchor. AC-03 encodes this ("that anchor when after is within the 7 days before it").

AC-06, however, expects "`nextAt` = … `at` in the future: `at`". That holds only when `at` is less than
one period ahead. A test-writer cannot tell which `at` to use, and a test with `at` = now + 30 d fails
against the formula.

The decision itself is also doubtful:
- the CLI help (`--at takes an ISO time, e.g. 2026-11-16T09:00:00Z`) and design §5.5 ("anchor = creation
  time, or an explicit `--at`") read `at` as a start time;
- running weeks before the requested start is the surprising reading.

Fix: use `k ≥ 0` when `anchor > after`, so the first slot is the anchor itself. With anchor = save
time this still gives "one period after save", as the Open questions say. Align AC-03 and AC-06, and
add an AC-06 case with `at` more than one period ahead.

### F6 (suggestion, NEW): the pulse row can lose a concurrent pause or update to the tick

(a) reads `duePulses(now)` and later writes `nextAt` back. Each slot runs in its own `goalTx`, but the
spec does not say that the pulse row is re-read inside the transaction that saves it, or that
`pause`/`resume`/`update`/`delete` run in `goalTx`. Consider this sequence:
1. the tick reads a pulse (`enabled: true`);
2. a person pauses it;
3. the tick saves `nextAt` from the stale read, which brings back `enabled: true`.

The pause is lost.

State that every pulse write re-reads the row under `goalTx` (or saves conditionally on `version` /
`updatedAt`). Extend AC-09 with "pause between the tick's read and its save → still paused".

### F7 (suggestion, NEW): "recomputed only when the stored value was a default" cannot be implemented with the stored type

`Pulse` stores only `windowMs`/`maxGoalAgeMs`, and nothing records whether they came from the body or
from the default. A user-chosen `window: 4h` equals the default for every period of 4 h or more.

Either store the given specs (e.g. `window?: DurationSpec`, `maxGoalAge?: DurationSpec`) next to the
effective values, or drop the rule and always keep the stored values on update. No AC covers it today.
Add one line to AC-15.

### F8 (suggestion, NEW): ingest gives `goals:write` service tokens a power they do not have today

Today a service token with `goals:write` can create a goal, but it cannot propose or approve a plan:
`POST /v1/goals/:id/plan` and `/approve` have no scope in `app.ts`. With `POST /v1/goals/from-preset` it
gets an **approved** plan, decided by the service user. That plan can contain headless steps with any
registered profile (including `propose-via-branch`) and any agent name.

Design §5.5 does name `goals:write`, so this is not a wrong decision. But the spec should record it in
Open questions, because it changes who can approve plans. It should also say that ingest goals are not
offered automatically (they have no stick and no pulse attempt). An alternative is a new scope
(`goals:ingest`) that an admin grants on purpose.

### F9 (suggestion, NEW): cron has no minimum period

`every` is limited to 5m..366d, but `cron` accepts `* * * * *`, a goal every minute. That gives
`windowMs` = 1 min and `offerTimeoutMs` = 20 s, under a 30 s tick.

Add a 422 such as `cron "<expr>" fires more often than every 5m` (`periodMs < 5 min`, measured as the
spec already measures the period), and add it to AC-06.

### F10 (suggestion, NEW): the pending-slot scan grows with history

A slot stays `state: "fired"` after it starts, and "pending" means `fired` without `startedAt`, which
lives in the JSON `value`. So every tick lists and parses every `fired` row ever written: about 105,000
rows a year for one `every 5m` pulse. The indexes are on `state` and `goal` only.

Add a `started_at` column (NULL = pending) or a pending filter on `listSlots`, and say that (b) reads
only pending rows of pulses that are not deleted.

### F11 (suggestion, NEW): Live activity mislabels the new `step.dropped` events

`describe("step.dropped")` returns "dropped by a new plan" (`service.ts`). Dropping a goal emits
`step.dropped` per step, so Live activity would say "dropped by a new plan" for an abandoned or missed
goal.

Give these events a payload `reason` (`abandoned` | `missed`) and a `describe` line for it. The Events
table today lists only `goal.dropped`.

### F12 (suggestion, NEW): an attempt on a run step that someone else already offered is undefined

(b) step 3 says what happens when the open offer is to the **last tried** machine. It does not cover a
run step that a person offered elsewhere first with `mesh assign` (which `assignStep` allows on a
`ready` step). The attempt would then call `offerStep` over an open offer, which `assignStep` refuses
for people.

Conservative reading: an open offer the pulse did not make → wait (and the window still applies).

Also, candidates use `repo = params.repo`, but a preset step may set its own `repo`. Use the run step's
`repo`.

### F13 (suggestion, NEW): `createPulse` numbering under replicas

`createGoal` takes `this.lock("goals")` before `MAX(num)`. `createPulse` needs the same on Postgres, or
two replicas can race to the same `num`, and the UNIQUE constraint turns that into a 500. Name the lock:
a new `LOCKS.pulses` key in `dialect.ts`, or reuse `goals`.

### F14 (suggestion, NEW): where the CLI finds a repo preset

`findPreset(cwd, name)` walks up from the **current directory** to its git root. It does not look in
`--repo`. So `mesh pulse add --preset x --repo alpha`, run from repo `beta`, snapshots beta's
`.mesh/presets/x.yaml` with `source.repo = beta`.

State this, or resolve from the `--repo` checkout when it is local. Also say in AC-07 that "the old
text" means `presetText(parsePreset(old file))`, not the raw file bytes.

### F15 (suggestion, NEW): AC-13 leaves out the state of the slot the hub stopped at

"Hub stopped at a slot" implies that S0 fired G0 just before the stop. After 5 h 10 min, `maxGoalAge`
(default 2 h) abandons G0 when S5 fires, so S0 ends `abandoned`. With F1 fixed, S0 would instead be
`missed` first. Tests that count states would differ.

Name the expected state of S0, or start AC-13 with the hub stopped just before S0 fires.

### F16 (suggestion, NEW): the missed-slot view for the TUI is deferred without a home

REQ-2 names the TUI. The Open question defers it, which is a conservative reading and fine for S3. Name
the later row or slice that owns it, so it does not drop out of the programme.

### F17 (suggestion, NEW): AC-04's "an extra target label never changes the order"

`suggest` ranks by `machineLabels`, which counts machine labels that are topics or the repo name. An
extra target label that is also a topic does change `suggest`'s order. That is correct ("its order
kept"), but it contradicts the AC sentence. Say "a target label that is neither a topic nor the repo
name".

## Summary

5 blockers (F1–F5) and 12 suggestions (F6–F17), all NEW.
- F1 and F4 are design decisions to fix in the Tick and Firing sections.
- F2, F3 and F5 make AC-10, AC-11 and AC-06 contradict the spec's own rules.

Scope matches slice S3. I found no scope creep beyond the row. Every addition (web section, `goal.dropped`,
`mesh goal ls --pulses`) traces to REQ-2, §5.5 or §6. I found no team-, company- or person-specific names.
