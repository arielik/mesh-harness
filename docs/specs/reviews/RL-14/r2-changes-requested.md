Verdict: CHANGES REQUESTED | Round: 2 | Blocking-open: 2

# RL-14 review, round 2 (spec revision 2, 6a81a37; diff since 3a69295)

Checked against: src/core/session-state.ts, src/core/claims.ts, src/daemon/{daemon,hub-link,runs}.ts,
src/hub/service.ts (`sync`, `claimInTx`, `acceptStep`, `claimStep`, `takeStep`), src/cli/hub-commands.ts,
src/protocol/hub.ts, src/store/hub-store.ts, test/helpers/world.ts.

The revision answers most of round 1 well. The `notHeld` reply is the right shape: it changes nothing about
who holds what, it is recomputed on every sync, and an older hub degrades to today's behaviour. Two gaps
remain in it. Both bring back the overlap B1 was about, on paths the new AC-14 does not exercise.

## Round-1 findings

| Id | Status | Notes |
|---|---|---|
| B1 | PARTIAL | `notHeld` (spec 104-116), the `/v1/stuck` holder test (281-283) and AC-14 (348) are added. The hub predicate misses steps that have no `holderSid` (B2). The daemon's in-memory set breaks across restarts and when it shrinks (B3). |
| S1 | RESOLVED | Rule 2 now compares `open` and `state` with the remembered `{open, state, asOf, days}` (spec 130-137). |
| S2 | RESOLVED | `steps[next.step]` is created when `next` accrues (spec 90-91). AC-04 covers it (339). See S10 for the empty `days` this can produce. |
| S3 | RESOLVED | An ended session stays in memory until its final keys are accepted, for at most 7 days (spec 144-146). That matches `pruneSessions(now − 7 d)` (daemon.ts:1461). The marks reset on a hub or machine change, like `factsFor` (hub-link.ts:313-321). AC-04 covers it. |
| S4 | RESOLVED | `syncedSessions` drops `stateTime` and the hub's `sync` deletes it before `upsertSession` (spec 70-74). AC-04 checks `/v1/live`. |
| S5 | RESOLVED | Each day is clamped to `≤ D` in `accrue` (spec 86-88). |
| S6 | RESOLVED | `stateSince` stays unset until a real state change, and the session counts as `unmeasured` (spec 92-94). |
| S7 | RESOLVED | The guide caveat says the `days` window differs from `/v1/health` (spec 315). |
| S8 | RESOLVED | `machine` is the machine id (215, 284). Goal `endAt` is the latest step `endAt`, falling back to `updatedAt` (209). `lastSeenAt` comes from the row's `updated_at`, which `upsertSession` sets on every sync (hub-store.ts:668-676). The downtime and presumed-ended caveats are in the guide list (312-314). |

## Blocking

### B2. The `notHeld` predicate ignores steps held without a `holderSid`, so a take-over from the CLI never stops the old session

Spec 108-110 makes a pair `notHeld` when the step "has a `holderSid` other than `sid`". A claim, accept or take
without a sid deletes `holderSid` (`hold`, src/core/claims.ts:22-23). Two common paths reach that state:
- **`mesh take <step>` posts `{}`** (src/cli/hub-commands.ts:427), and `takeStep` passes `sid` undefined into
  `takeOver` (service.ts:2938). Afterwards `holderUser` is the taker and `holderSid` is absent. Read literally,
  session A, the previous holder, is not `notHeld` and keeps accruing `stalled` time. That is the B1 scenario,
  and it lasts until the taker starts a session that binds with its sid (maybe never). AC-14 uses "B's sid", so
  it passes while this path stays broken.
- **A headless run accepts with `{}`** (src/daemon/runs.ts:518). `holderSid` stays absent until
  `bindRunSession` claims with the run session's sid (daemon.ts:942-951). That bind runs once per `(sid, step)`
  and is not retried when it fails ("the session keeps the step locally", :952-954). A sync can also go out
  between the local `commit` (:938) and the bind's reply. A reading that treats an absent `holderSid` as
  "another holder" would mark a running headless run's session `notHeld` and drop its time. That is the case
  the owner asked to protect.

Required: define "held" for the hub exactly, the way runs.ts:857 already does. The pair `(sid, step)` is held when
the step is `claimed` or `paused` and either `holderSid === sid`, or `holderSid` is absent,
`holderUser === caller` and `holderMachine` is absent or equals the token's machine. Every other case is
`notHeld`. Use the same predicate for `/v1/stuck` `sessions` (spec 281-283), so that a `needs_you` session on
a step claimed without a sid is neither silently dropped nor listed against a step someone else took. Extend
AC-14 with:
1. A takes S over through `POST /v1/steps/:id/take` with `{}` by another user → `{A, S}` is in `notHeld`.
2. A headless run accepted with `{}` whose bind failed, or has not answered yet → its session is not `notHeld`,
   and its row keeps growing.

### B3. `notHeld` is kept only in memory and its transitions are not commits, so restarts and re-holds add the not-held time back

Spec 111-114: the set is in memory and is replaced by each sync reply. When a pair is added, the daemon closes the
interval as held. Nothing is said about the interval when a pair is removed. `liveDays` and the restart rule
(101-102, 118-120) count `[since, now)` whenever the session accrues "now". Two consequences:
- **Restart.** After a restart the set is empty, so a stale session A on a taken-over step accrues again. The
  first change, or the first sync, closes `[since, now)` into A's last state. That span includes the daemon
  downtime and runs from A's last change before the stop. Then the first sync reply adds `{A, S}` again and
  closes the interval "as held". So each daemon restart adds its downtime to A's row for a step A has not held
  for days. That breaks the owner rule (no double count on restarts) and the overlap B1 was raised for.
- **Re-hold.** When a pair leaves the set, `since` is still the time of the last change made while not held.
  The next `liveDays` or close then counts the whole not-held period as held.

Required:
- Persist the not-held mark with the session, for example `stateTime.notHeld?: string[]` of steps, saved by
  `saveSessions`, so `accrue` and `liveDays` read it from the record instead of from a parameter.
- Make each change to the mark a commit through `accrue`: adding it closes `[since, now)` as held, and removing
  it sets `since = now` and adds nothing.
- Say which of the two you choose for the downtime of a not-held session at restart. The answer should be
  "adds nothing".
- Extend AC-14: after `{A, S}` is reported, `w.restart` plus a clock move of 1 h, then a flush → A's row for S
  is unchanged. A claims S again after 1 h not held → that hour is not added.

## Suggestions

### S9. Sessions beyond the sync cap are never in `notHeld`
`syncedSessions` caps the body at 200 (hub-link.ts:78, 85-87), and `notHeld` covers only the sessions in the body
(spec 108-109). Because the set is replaced on every sync, a session left out of the body drops out of the set
and accrues again. Either keep a mark for sids that were not in the body, or say that state time is reported only
for sessions in the body.

### S10. Empty `days`
After S2's fix, a key can exist with `[]` closed days. Its open interval can also be 0 ms at `asOf`, for example a
sync right after `mesh_claim`, or a key whose session went `notHeld` at once. `liveDays` is then `[]`, but
`StateTimeReport` needs 1 … 400 days (spec 125). The hub skips the entry as invalid, and the daemon marks it
accepted on the 2xx (140-141). Say that a key with empty `days` is not sent, or allow 0 … 400 and store nothing
for it. Also say how the 50-step bound (spec 95) orders a step that has no day yet.

### S11. Several `/v1/sync` calls in one flush
`doFlush` loops one `/v1/sync` per 200 outbox events (hub-link.ts:335-366), and every body repeats the same
`sessions`. Say that `stateTime` entries (and the 500 cap) go in the first body of a flush, or are spread across
the bodies, and that `notHeld` is taken from the last successful reply.

### S12. Ordering
AC-14 sits before AC-13 in the table (spec 348-349). Put it after AC-13 or renumber, so the docs test and the
AC ids stay easy to match.
