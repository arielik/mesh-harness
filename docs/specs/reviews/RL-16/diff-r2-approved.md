Verdict: APPROVED | Round: 2 | Blocking-open: 0

# RL-16 diff review, round 2 (commit 970431b)

Reviewed `git show 970431b` against round 1 (`diff-r1-changes-requested.md`) and `docs/specs/RL-16.md`.
The RL-16 test files, `test/schemas.test.ts` and `test/health-hub.test.ts` pass (108 tests), and
`tsc --noEmit` is clean. The only source changes are CLI line 1 and one docs sentence. Everything
else in the commit is tests.

## Round 1 findings

1. **RESOLVED (was BLOCKING).** The AC-05 fixture now gives one step two rounds:
   - Round 1 finished 15 days ago.
   - Round 2 finished 10 days ago, after its dependant `t` failed and reopened it
     (`test/profile-fit-hub.test.ts`, `secondRun`).

   The step's `updatedAt` is in the window but its first round is not, so the per-round
   `finishedAt < since` check at `src/hub/service.ts:851` is now the only thing that excludes that
   round. The test asserts the step has rounds `[1, 2]`, that H1 has 4 runs by default and 5 with
   `?days=16`, and that the totals match `GET /v1/runs`. The mutation is now caught (see below).
2. **RESOLVED.** CLI line 1 now prints `<runs> runs` as the spec says
   (`src/cli/artifact-commands.ts:120`). Minor gap: no test shows a one-run sample on line 1
   (mutation "line 1 back to runsWord" survives). It is cosmetic and not blocking; asserting
   `lines[0]` in the `small` case of `test_AC08_small_empty_builtin` (1 run) would pin it.
3. **RESOLVED.** `test_AC03_cover_cases` covers:
   - a bare `Bash`, `Bash(*)`, `Bash(* --x)`, the exact `Bash(make lint)`, and `Bash(cargo:*)`;
   - the negatives `Bash(cargox *)` and `Bash(d*)`;
   - a server-wide `mcp__srv__*` deny.

   The bare-`Bash` mutation is now caught. The spec's `Bash(git * --output*)` and
   `Bash(find *-exec*)` examples are not tested by name, but `Bash(* --x)` and `Bash(make lint)`
   exercise the same branches.
4. **RESOLVED.** `test_AC03_unused_refused` builds a profile with 100 deny rules and a frequently
   unused `CronCreate`, and expects it held `refused` with a `deny: …` refusal. The mutation is
   now caught.
5. **RESOLVED.**
   - `test_AC05_hashes_unit` now has three other hashes, and reversing the `lastAt` sort is caught.
   - `test_AC08_truncated_line` checks the `(6 more denied and 2 more unused entries not shown)`
     line and its position just before `Proposed change:`, and is caught.
   - Minor: the `sha256` tiebreak survives deletion. The tied hashes (`0…`, `b…`) are added in
     their expected order, and the sort is stable. Putting `tie` before `older` in the input would
     make the test catch it. SUGGESTION only.
6. **OPEN, accepted.** No test exercises the goal-exists guard (`src/hub/service.ts:854`). I
   checked: `src/` has no goal deletion (no `deleteGoal`/`removeGoal`/`DELETE FROM goals`), so a
   round whose goal is missing cannot occur today and the guard is defensive. No AC names it. I
   accept leaving it open.
7. **RESOLVED.** `fitCall("nope", "?days=0")` → 400 with the days text pins "parameters before the
   profile". Reading the profile before validating is now caught by `test_AC07`. The upper bound
   (`finishedAt > until`) stays untested; as stated in round 1, a round can only finish after the
   hub clock through clock skew, so this is acceptable.
8. **RESOLVED.** The concepts Thresholds bullet now reads "else no entry is suggested (held
   `few-runs` unless an earlier reason holds it)". The new line is longer than its neighbours,
   which is cosmetic.
9. **RESOLVED (no action was needed).** The `analysis` tag matches `/v1/runs` and `/v1/health`.

## New findings

None blocking. The two minor survivors (the line-1 singular and the sha256 tiebreak) are noted
under findings 2 and 5 as optional suggestions.

## Mutation results (round 2)

The mutations ran on a fresh scratch copy at
`/tmp/claude-1015/-home-ghost2-vpc-devel-mesh-harness/1309aed3-426f-4a87-8d98-c622fcf70a9b/scratchpad/rl16-mut2`
(copied from the worktree at 970431b, with `node_modules` symlinked), using the script
`/tmp/claude-1015/-home-ghost2-vpc-devel-mesh-harness/1309aed3-426f-4a87-8d98-c622fcf70a9b/scratchpad/mut3.mjs`.
Each mutation was a single edit, run against the four RL-16 test files and then restored. The
worktree was not touched.

| Mutation | Result | Failing test |
|---|---|---|
| baseline (no mutation) | 23 passed | none |
| service round `finishedAt < since` removed (r1 BLOCKING) | caught | test_AC05_hashes_window_trial |
| denyCovers `deny === "Bash"` removed | caught | test_AC03_cover_cases |
| unused `refusal({ deny: tool })` removed | caught | test_AC03_unused_refused |
| other-hash `lastAt` sort reversed | caught | test_AC05_hashes_unit |
| CLI `truncated` line removed | caught | test_AC08_truncated_line |
| profile read before parameter checks | caught | test_AC07_errors_access_no_writes_feature |
| other-hash `sha256` tiebreak removed | survived (suggestion, finding 5) | none |
| CLI line 1 back to `runsWord` | survived (suggestion, finding 2) | none |
