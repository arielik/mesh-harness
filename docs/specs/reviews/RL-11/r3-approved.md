Verdict: APPROVED | Round: 3 | Blocking-open: 0

# Review of the RL-11 spec, round 3

This is a cold review of `docs/specs/RL-11.md`, revision 3 (commit 7ae7522 on `spec/RL-11`). I read the
round-1 and round-2 reviews first, then the spec, and the diff from revision 2. Then I recomputed AC-10
and AC-11 against:
- `src/core/calibration.ts`: `flagEntries`, `raisingAgents`, `countedDismissals`, `calibrationStatus`,
  `agentStats` (the runs, raised, accepted, counted-dismissal and reinstated loops, `lastAt`, the
  all-zero filter);
- `src/hub/service.ts`: `calibrationScan`, `calibratorFor` (rules 1–3), `calibrationTrigger`,
  `calibrationAfterDismissal`, `agentStats`, and the person disposition path (`consumes`, `may_set`,
  the record the debrief reads);
- `src/core/review.ts` `lineageOf`; `test/helpers/calib-kit.ts`, `review-kit.ts` (`goal` with
  `preset`), `pulse-kit.ts`; `test/calibration-hub.test.ts` (RL-6 AC-08, AC-09, AC-11 and its
  `pulseRun` helper).

No hard rule is broken: the names stay generic.

## Round-2 findings

| Id | Status | Reason |
|---|---|---|
| B3 | RESOLVED | AC-10 names the checker C@HC as the agent that records every agent disposition, and asserts `reinstated` on C@HC's row (1 by default, 2 with `include`), not on K@H's. The contract (RL-11.md:200-203) states that `reinstated` goes to the dismissing agent and `dismissedByAgents`/`dismissedByPeople` to the raising agent, which is `calibration.ts:281-301`. |
| S13 | PARTIAL | T now has an acceptance (T2), a person's dismissal (X) and a reinstatement (T1), and AC-10 asserts most fields under both values, including `lastAt`. The cross-goal reinstatement is still missing (S18). |
| S14 | RESOLVED | K@H2 runs in its own trial goal T2 with telemetry only, so it cannot change T's raising agent. |
| S15 | RESOLVED in the contract | The daemon and the hub both name UTF-16 code-unit order (RL-11.md:58, 98, 108). AC-01 still says "code-point order" (S19). |
| S16 | RESOLVED | `## Calibration` is in the Docs list and AC-15. AC-11's normal dismissals are in carol's non-pulse goals. The Scope wording is fixed (RL-11.md:35-36). |

## What holds (recomputed)

AC-10, with one lineage L for every item, the raising agent of (N, L), (M, L) and (T, L) = K@H, and
`raisingAgents` unchanged by T2 (no record):

| Field of K@H | Default | `include` | Source |
|---|---|---|---|
| `runs`, `meanDurationMs` | 1, 1000 (N) | 2, 2000 (N, T) | runs loop, `:231-243` |
| `failures` | 0 | 0 | `outcome` `done` |
| `raised` | 3 (N 2, M 1) | 6 (+ T 3) | `:246-249` |
| `accepted` | 1 (N1) | 2 (+ T2) | credited to the raising agent of `(e.goal, L)`, `:257-269` |
| `dismissedByAgents` | 2 (N2, X in M, both by C) | 3 (+ T1) | counted per `(e.goal, L, fp)`, `:112-133` |
| `dismissedByPeople` | 0 | 1 (ann's X in T: a separate `(T, L, X)` key) | `:281-282` |
| `uncalibrated` | 2 | 2 (calibration list) | `:276-279` |
| `lastAt` | C's dismissal of X in M | ann's dismissal of X, if it is T's last K@H activity (S20) | `seenAt` calls |

- N2: C's dismissal stays counted after ann's `confirmed`, because a confirm is not a revert
  (`flagEntries`). X: C's dismissal in M is followed by ann's `dismissed`, so it is no reinstatement.
- C@HC `reinstated`: N2 (e in N) by default; T1 (e in T) added with `include`. 1 and 2 are right.
- The person paths exist: a debrief with `consumes: ["dismissed"]` takes a person's `confirmed` and
  `dismissed` on an item an agent dismissed (`service.ts:1663-1676`; RL-6 AC-09 does both). The
  debrief's `may_set` must name `confirmed` and `dismissed`.
- AC-10 does exercise the entry-goal rule, provided X is one item in M and T: an implementation that
  attributes by the goal that first raised the item puts ann's T dismissal of X in M and shows
  `dismissedByPeople` 1 by default; one that drops items ever raised in a trial goal loses X in M. See
  S17 for the condition.
- AC-11. Trial dismissals call `calibrationTrigger`, but the trial-free list stays below 2. The second
  normal dismissal opens the goal with exactly the 2 normal refs. `calibratorFor`: rule 1 has no
  catalog source; rule 2 skipping trial goals leaves ann's older normal pulse goal; rule 3 would give
  carol, the owner of the newest dismissal's goal. So ann separates the right implementation from both
  wrong ones. It can be built with the kit: `pulseRun` gives the pulse goals of ann and bob (bob's run
  as a trial fire, before the second normal dismissal), carol has a login token in `Ck.start`, and
  `k.goal`/`raise`/`agentDispose` take a token string, so carol can own the normal goals (`dismissOne`
  is typed for a `Person` and needs a small change, or the test writes its three calls).

## Blockers

None.

## Suggestions

### S17 (NEW): AC-10 should say that X is one item in M and T
`lineageOf` is `<goal preset name or "-">|<step repo>|<agent>` (`review.ts:103-104`). The kit's
`k.goal` with no preset gives `-|/src/alpha|auditor`. A trial goal comes from a pulse fire, so its
lineage starts with the pulse's preset name, and the pulse kit's repo is `alpha`. A test that builds N
and M with the defaults and T with a trial fire puts X in two lineages. The counts in AC-10 still come
out the same, but the X case then tests nothing: ann's X in T is a new item first raised in T, and a
first-raising-goal implementation passes. Say in AC-10 that every goal uses the same lineage: N and M
are made with the pulse's preset name and the same repo (`k.goal(..., {preset})`, as
`review-kit.ts:143` allows), or are normal fires of the same pulse. Say that X in T is a repeat of the
dismissed item, so the debrief there consumes `dismissed`. Add to the FAIL column "ann's dismissal of X
in T counted by default".

### S18 (NEW): the reinstatement rule "belongs to `e`" is still not tested across goals
Both reinstatements in AC-10 have `e` and `n` in the same goal (N2 in N, T1 in T). An implementation
that filters a reinstatement by the person's decision `n` gives the same 1 and 2. Round 2 (S13) asked
for a pair with `e` in a trial goal and `n` in a normal one: for example, C dismisses an item Y in T,
K raises Y again in a later normal goal, and ann confirms Y there. C@HC is then 1 by default (Y left out
because `e` is in T) and 3 with `include`. A filter by `n` would give 2 by default. This is optional.

### S19 (NEW): AC-01 still says "code-point order"
RL-11.md:275: "205 distinct names → the first 200 in code-point order." Change it to "UTF-16 code-unit
order", as the contract now says.

### S20 (NEW): pin K@H's `lastAt` in T to one event
"`lastAt` the newest of T's times" is right only if ann's dismissal of X is the last thing in T. ann's
confirm of T1 is credited to C, not to K@H (`calibration.ts:302`). The order listed for T ("C accepts
T2" after "ann confirms T1") also cannot happen if C's dispositions come from one validate record
before the debrief. Write "`lastAt` the time of ann's dismissal of X (ann's last action in T's
debrief)" and list T's actions in an order the kit can produce: the run, K's record, C's record
(dismisses T1, accepts T2), then ann confirms T1 and dismisses X.

## Checks

Run: none of the repo's checks. This round reviews a spec, and nothing is implemented. I recomputed
AC-10 and AC-11 by hand against `src/core/calibration.ts` and `src/hub/service.ts`, and checked the
setup against the RL-6, RL-2 and RL-3 test kits.

Not run: `pnpm lint`, `pnpm typecheck`, `pnpm test`, `pnpm build`, `pnpm check`, `pnpm schemas`,
`pnpm test:web`.
