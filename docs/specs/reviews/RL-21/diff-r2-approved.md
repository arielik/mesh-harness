Verdict: APPROVED | Round: 2 | Blocking-open: 0

# RL-21 diff review, round 2 (commit 10e7c9e)

Cold review of the round-1 answer `git show 10e7c9e` (src/hub/service.ts, test/step-assign-for.test.ts)
against docs/specs/RL-21.md and docs/specs/reviews/RL-21/diff-r1-changes-requested.md.

Baseline in a scratch copy of HEAD (`git archive`, node_modules symlinked): `tsc --noEmit` clean,
`vitest run test/step-assign-for.test.ts` 24 of 24 pass.

## Round-1 findings

1. **RESOLVED (was BLOCKING): AC-10 session filter untested.**
   test_AC10_suggest_only_persons (test/step-assign-for.test.ts:259-283) now puts a session of bob on
   ann's machine (`bob-on-ann`), checks that ann's own token sees `idle: 2`, and that act-for suggest
   (both `""` and `?any=1`) gives ann-box `idle: 1, session: "ann-s1"` and never contains
   `bob-on-ann`. Mutation M5 (filter at service.ts:2061 removed) is now caught, see below.
2. **RESOLVED: AC-06 cross-machine session clause untested.**
   test_AC06_own_session (test/step-assign-for.test.ts:176-181) now sends `box/bwork` and
   `box/bob-s1` act-for and expects `404 session-unknown`. Mutation M15 (`hs.machineId === m.id`
   removed in `findSessionOn`, service.ts:618) is now caught.
3. **RESOLVED: `machine-not-yours` text.** service.ts:888 now answers `machine not yours: <to>`, as in
   the spec's code table (RL-21.md:275). No test or doc still refers to the old suffix.
4. **RESOLVED: `profile-not-yours` exemption.** service.ts:895 now exempts only
   `declared && step.policy?.profile !== undefined`. In that case `profile-mismatch` (service.ts:894)
   has already forced `name === step.policy.profile`, so the exemption admits only the declared
   profile. The new condition is strictly stronger than the old one (it checks every case the old one
   checked, plus a non-headless step with a stray `policy.profile`), so it cannot open a hole. No test
   pins the new arm (mutation M19 below survives), but that arm is unreachable today because
   `validatePolicies` rejects a profile without `mode: headless` (src/core/policy.ts:77); this is
   hardening, not a gap in an AC.
5. **No action needed (Info, accepted in the spec): `refuseHeadlessAccept` in the claim branch.**
   Unchanged and still as the spec describes.

## New findings

None. The fix commit changes two lines of src/hub/service.ts (888, 895) and adds test lines only.
The rights rules are unchanged except for the stricter `profile-not-yours` condition above. The
added test fixture (a bob session on ann's machine) does not weaken any existing assertion: ann's
own-token view is asserted separately and the act-for assertions are tighter.

## Mutation results

Each mutation was applied alone to src/hub/service.ts in the scratch copy
/tmp/claude-1015/-home-ghost2-vpc-devel-mesh-harness/1309aed3-426f-4a87-8d98-c622fcf70a9b/scratchpad/rl21r2
and run with `vitest run test/step-assign-for.test.ts`, then restored (checked with `cmp`). The real
worktree was never changed.

| # | Mutation | Result | Caught by |
|---|---|---|---|
| M5 | service.ts:2061 `.filter((hs) => !actor.via \|\| hs.userId === actor.userId)` removed | caught (1 failed / 23 passed) | test_AC10_suggest_only_persons: `expected [2, 'ann-s1'] to strictly equal [1, 'ann-s1']` |
| M15 | service.ts:618 `hs.machineId === m.id &&` removed | caught (1 failed / 23 passed) | test_AC06_own_session: `box/bwork: expected [403, 'session-not-yours'] to strictly equal [404, 'session-unknown']` |
| M19 | service.ts:895 exemption reverted to `step.policy?.profile === undefined` | survived (24 passed) | none; arm unreachable through plan validation (finding 4) |
