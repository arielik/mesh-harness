Verdict: CHANGES REQUESTED | Round: 1 | Blocking-open: 1

# RL-14 review, round 1 (spec revision 1, 3a69295)

Checked against: src/core/session-state.ts, src/daemon/{daemon,hub-link,tools}.ts, src/store/{daemon-store,hub-store,hub-copy}.ts,
src/protocol/{session,hub,goal}.ts, src/hub/{service,app}.ts, src/core/trail.ts, test/helpers/world.ts, the analysis
(I-15, §6) and the RL-12/RL-13 specs and reviews.

What holds up (no action):
- Idempotency of the sync. Absolute per-day totals keyed by `(step, sid)`, an upsert guarded by `as_of`, and
  "never queued, only recomputed" (spec 101-118, 129-139) cannot double count on a retried, duplicated or replayed
  body, an offline period or a restart. The daemon persists every changed record (`saveSessions` in `commit`,
  src/daemon/daemon.ts:567, and in `markWorking`, :1552), so closed totals plus `since` survive a crash and the
  first report after a restart is never smaller than the last one sent.
- Every path that changes a session is covered: `commit` (:551) and `markWorking` (:1545) are the only writers
  besides the in-memory prune (:1460). Reducers clone the previous record (`structuredClone` in applyTick,
  session-state.ts:511; `update` spreads it, daemon.ts:738), so `prev.stateTime` reaches `next`.
- Placeholders and revivals add nothing: a `launching` placeholder (`applyLaunch`, session-state.ts:381) and a
  revived ended run session (`applyRunSession`, :475) have a `prev` that does not accrue.
- Absent, not zero, works: the hub `Session` schema strips unknown keys, so an older hub drops `stateSince`/`stateTime`
  (src/protocol/hub.ts:48) and an older daemon leaves no `step_time` row and no `stateSince` (`unmeasured`).
- Migration 12 is justified. Per-`(step, sid)` rows with an `as_of` guard cannot live in `hsession` (one row per sid,
  overwritten on every sync, store/hub-store.ts:644-652) or in the step value. The window needs `event_at`: today
  `event` has indexes on `step` and `goal` only (hub-store.ts:59-60, 146-147). It is the 12th entry after the 11 in
  `HUB_MIGRATIONS` (:25-108).
- RL-12 conventions are followed: `member` + `goals:read` with on-behalf refused (`actingFor`, service.ts:1970;
  routes app.ts:279-282), the `trial` text (service.ts:4106), the `days` text (:4103), the `since`/`until` parser of
  `listRuns` (:3834-3845). There is no composite score, no CI data and no new event.
- Testable: the World has a shared `w.clock`, daemon `tick()` with `tickMs: 0`, `restart`, `dropReplyOnce`, `offline`
  and `syncBodies` (test/helpers/world.ts:103, 218, 238, 346, 390, 408).

## Blocking

### B1. `Session.step` stays set after the step is taken over or ended elsewhere, so time keeps accruing to it

Spec 57-59 and 76-82 count a session's time toward `prev.step` while `Session.step` is set. But the daemon clears
`step` only on its own `mesh_release`/`mesh_done` (src/daemon/tools.ts:397, 435, 703) and on `plan_approved` for a design
step (daemon.ts:766). When another session takes the step over, the hub only sends the old session a text message
(service.ts:2947-2948). `receive` queues that message and leaves `s.step` as it is (daemon.ts:754-774). The same
happens when a person drops, skips or moves the step, or another holder finishes it. The old session then stays
`idle` and `stalled` (applyTick stalls only because `s.step` is set, session-state.ts:520). An interactive session the
reconciler has seen is never presumed ended (:523). So the session adds `stalledMs` to that step for hours or days
after it stopped holding it. That time overlaps the new holder's time, the step's `stateTime` grows larger than its
wall time, and the hub cannot separate it afterwards, because the days are absolute totals per `(step, sid)`. The
stuck list has the same problem (spec 252-256): a stale session that is `needs_you` on a taken-over step is listed
against that step.

Required (pick one and state it):
- the daemon clears `step` (`update(sid, {clearStep: true})`, which closes the interval through `accrue`) when it gets
  the hub's `taken_over` message for the session, and when a sync or context read shows the step's `holderSid` is
  another session or the step is no longer `claimed`/`paused`; or
- the hub stops accepting new totals for `(step, sid)` once `step.holderSid !== sid` and the step has had another
  holder since. State what happens to time already in flight.

Add an AC for it: session A holds S, B takes S over, the clock moves 1 h, A ticks to stalled. After a flush, A's row
for S has no time after the take-over. Also state that `/v1/stuck` `sessions` requires `step.holderSid === sid` (or
the step `claimed`).

## Suggestions

### S1. Sending rule 2 is garbled
Spec 111: "whether the entry is **open** … or its state changed" does not say what is compared. AC-04 reads it as
"its open/closed status or the session's `state` differs from the last accepted entry". Write it that way, and say the
daemon remembers `{open, state, asOf, days}` per key.

### S2. A step's first open interval is never sent
Spec 107-108: only keys where `stateTime.steps` already has `step` are sent. After `mesh_claim` (`update` with `step`,
tools.ts:390), `prev.step` is unset, so nothing is added and the key does not exist until the next change. A session
that claims a step and then sits in one state with no commit for an hour shows the step's `stateTime` as absent. Let
`accrue` create `steps[next.step] ??= []` when `next` accrues, or select keys by `liveDays` too.

### S3. A final total is lost if the hub is unreachable for more than 24 h
Ended sessions leave memory after 24 h (daemon.ts:1460), and the "accepted" marks are kept per process (spec 109).
So a closed entry that was never accepted before then is never sent. AC-04's fail state "a dropped final total" then
holds. Two fixes: keep an ended session in memory until its closed entries are accepted, or persist an accepted
`asOf` per key in the daemon store. Also reset the marks when `factsFor` sees another hub or machine
(hub-link.ts:296-305). Otherwise a solo-to-team `mesh login` never sends closed entries to the new hub.

### S4. Keep `stateTime` out of the shared `Session` schema
The hub parses and stores session records with the same `Session` (hub.ts:48, hub-store.ts:650, 657). If
`stateTime` is in that schema, the hub stores it when any client sends it, and `/v1/sessions`, `/v1/live` and
`/local/sessions` return it. With 50 steps × 400 days that can be a large record, rewritten on every hook. Two options:
make it a daemon-only extension (a separate local type or column), or strip it in the hub's `upsertSession` and in
`SessionsResponse`.

### S5. Clamp in `accrue` so one bad day cannot freeze a row
The hub skips a whole entry when one day's sum is more than `D` (spec 73-74, AC-05). If the clock goes back by less
than an interval and then forward again, the same wall time can be counted twice. That day stays in every later
report, so the row never updates again. Clamp each day to `D` in `accrue`.

### S6. `stateSince` for a session that is already waiting at upgrade
Spec 83-84 sets `stateSince = now` at the first change after the upgrade even when the state did not change. A
session that has waited 2 h then shows as waiting a few minutes. Either leave `stateSince` unset until a real state
change (the session stays in `unmeasured`), or say in the guide that it understates.

### S7. Same parameter name, different window
`/v1/health` `days` means `[now − days×D, now]` (service.ts:4110-4111). Here `days` means whole UTC days
(spec 207). The choice is sound for exact buckets, but say in the guide that the two windows differ.

### S8. Smaller points
- `SessionTime.machine` and `Stuck.sessions[].machine`: say whether it is the id or `machineName` (service.ts uses
  both).
- Goal `endAt` = `updatedAt` (spec 180) moves when a done goal is edited later (topics, refs). Say that it is an
  approximation, or use the newest step `endAt`.
- `/v1/stuck` lists `needs_you` sessions of machines that stopped syncing, and their `forMs` keeps growing. Consider
  leaving out machines not seen for longer than the hub's away rule, or show `lastSeen`.
- A "presumed ended" working session adds up to `presumedEndAfterMs` (6 h, session-state.ts:24) to `workingMs`.
  Restart downtime does the same (spec 95-97). Put both in the guide's caveats with the downtime note.
