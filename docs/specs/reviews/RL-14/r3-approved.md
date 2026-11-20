Verdict: APPROVED | Round: 3 | Blocking-open: 0

# RL-14 review, round 3 (spec revision 3, 1db43d2; diff since b17046d)

Checked against (HEAD, not the uncommitted work in the worktree): src/daemon/runs.ts (`finish`, held test
at :857), src/core/claims.ts (`hold`, `claim`, `takeOver`), src/cli/hub-commands.ts (`take`, :427),
src/hub/service.ts (`machineOf` :2609, `claimInTx` :689, `acceptStep` :1834, `claimStep` :2618,
`takeStep` :2926), src/daemon/hub-link.ts (`syncedSessions` :78-91, `factsFor`, `doFlush` :325-370),
src/daemon/daemon.ts (`commit` :551, `bindRunSession` :940, `markWorking` :1545),
src/store/daemon-store.ts (`loadSessions`/`saveSessions` :119-138), src/protocol/session.ts (`Session` is
not strict, so the new fields survive load and a downgrade).

Both blocking findings are fixed. The held rule now covers steps held without a `holderSid`. The mark is
stored on the session record, and each change to it goes through `accrue`, so a restart or a re-hold adds
nothing. The points below are suggestions. None makes the implementation wrong or an AC untestable.

## Round-2 findings

| Id | Status | Notes |
|---|---|---|
| B1 | RESOLVED | Round 2 had it PARTIAL only because of B2 and B3, and both are closed now. |
| B2 | RESOLVED | Spec 112-117 defines the held rule: `holderSid === sid`, or no `holderSid` with `holderUser === u` and `holderMachine` absent or `m`. Spec 118-120 (`notHeld`) and spec 298-300 (`/v1/stuck` `sessions`, using the row's user and machine) both use it. Checked cases: a CLI take by another user (`{}`, hub-commands.ts:427 → `takeOver` → `hold` deletes `holderSid` and sets `holderUser` to the taker, claims.ts:20-25) gives A not held. A headless accept with `{}` (`acceptStep` → `claimInTx(..., caller.machine.id)`, service.ts:1842) sets `holderMachine` to the run's machine, so the run's session stays held while the bind (daemon.ts:948) is missing or failed. AC-14 covers both cases. See S13 for the "runs.ts already uses" wording. |
| B3 | RESOLVED | `stateTime.notHeld` is on the record (spec 71-77), and `saveSessions` stores the whole JSON (daemon-store.ts:126-137). Adding a mark closes the interval as held. Removing one adds nothing and restarts at `now` (spec 124-127). A marked session does not accrue (spec 82-83, 126-127), so restart downtime adds nothing to it. AC-14 covers the restart and the re-hold. |
| S9 | RESOLVED | Sessions not in the body keep their marks (spec 122-123). |
| S10 | RESOLVED | A key whose `days` are empty is not sent and not marked (spec 155). A step with no day yet counts as newest under the 50-step bound (spec 98-99). |
| S11 | RESOLVED | The first body carries `stateTime` and the first successful reply sets the marks (spec 128-130). In `doFlush` a failed `rpc` throws out of the loop (hub-link.ts:358, :368), so the first successful reply is the first body's reply. |
| S12 | RESOLVED | AC-14 now comes after AC-13. |

## New findings (suggestions, non-blocking)

### S13. "The one `runs.ts` already uses" is not the same rule
Spec 112 says the held rule is the one runs.ts already uses. The check at runs.ts:857 is
`holderMachine === this machine && (!holderSid || sids.has(holderSid))`. It requires the machine in both
cases, accepts a missing `holderMachine` in neither, and never looks at `holderUser`. The spec's rule is
right for the hub. Write "modelled on" so nobody copies runs.ts:857 into `sync`.

### S14. `accrue` still takes a `notHeld` parameter
Spec 85 is still `accrue(prev, next, now, notHeld)`, but spec 126-127 and B3 say the mark is read from
`next.stateTime.notHeld`. Drop the parameter, or say it is the record's list, so `accrue` cannot be fed two
different sources.

### S15. A reply without `notHeld`, and a change of hub
Spec 121-123 says a body session loses a mark when the reply does not list it. It does not say what a
reply with no `notHeld` field does. That reply can come from an older hub, or from a hub reached after the
credentials changed (`factsFor`, hub-link.ts:313). Spec 132 says "An older hub sends no `notHeld`: the
daemon accrues as long as `step` is set". With persisted marks, that holds only if such a reply clears the
marks of the body's sessions, or if marks are dropped when `factsFor` resets. Say which, or a session can
stay marked forever after a hub switch.

### S16. Which spelling the reply's `step` uses, and stale marks
The hub looks steps up without case (spec 119). Say that `notHeld[].step` echoes the session's `step` as
sent, because the daemon matches marks against `stateTime.notHeld` by exact string. Also, a mark for a step
the session no longer has is never removed (only body sessions *with a step* are updated, spec 121-122).
It is harmless but unbounded. Prune it to the current `step` and to the keys of `stateTime.steps`.

### S17. Apply marks to the current records, not the flush snapshot
`doFlush` takes `all = this.deps.sessions()` once, before the loop (hub-link.ts:328). The marks must be
written to the daemon's current `this.sessions` through `commit` (daemon.ts:551), for example through a new
`onSyncReply` dep. Writing them back from the snapshot would overwrite hook changes that arrived during the
call. One sentence in the spec avoids this.

### S18. AC-14 wording
- The take-over must be followed by a flush **before** the 1 h clock move. Otherwise A's tick to `stalled`
  closes the whole hour as held, because no mark exists yet (spec 124-125: the lag includes time without a
  sync), and the "no more than one sync interval" check fails for the wrong reason.
- "A then claims S again" works only when A's user may claim S. `claim` re-binds a held step only for its
  `holderUser` (claims.ts:31-32), so after B, another user, takes it, A's claim is a 409. Use the drop case
  for the re-claim (S is `ready`), or make B A's own user. Also, accrual restarts when the next sync reply
  removes the mark, not at the claim itself. Say "from the reply that clears the mark", or flush right
  after the claim with the clock unchanged.
- A same-user CLI take on the same machine (`takeOver` lets the holder re-take, claims.ts:68) leaves the
  old session A held until a run binds its sid. That is acceptable, but the parenthesis at spec 115-117
  could name it so a tester does not expect `notHeld` there.

Owner rules checked: no composite score (spec Out); totals are absolute and upserted by `as_of`, never
summed (spec 140-144, 183-185, AC-03); older daemons give `stateTime` absent, not zero (spec 196-199,
AC-07); `goals:read` without on-behalf (spec 191-192, AC-11); `trial` matches RL-11/RL-12 (spec 194-195);
all durations are `*Ms` in milliseconds.
