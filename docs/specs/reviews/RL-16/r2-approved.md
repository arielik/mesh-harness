Verdict: APPROVED | Round: 2 | Blocking-open: 0

# Review of the RL-16 spec, round 2

This is a cold review of `docs/specs/RL-16.md`, revision 2 (commit f0173ed on `spec/RL-16`): the diff
`git diff 8f8aa50 f0173ed -- docs/specs/RL-16.md` read together with the whole spec, against the same
code as round 1 (`src/core/profiles.ts`, `src/core/telemetry.ts`, `src/protocol/goal.ts`,
`src/protocol/hub.ts`, `src/protocol/hub-api.ts`, `src/hub/service.ts`, `src/hub/app.ts`,
`src/cli/artifact-commands.ts`). The verdict is about the spec only; the uncommitted implementation in
the worktree was not reviewed.

I worked out the changed and new AC examples again from the revised rules:
- AC-01 is unchanged under the new "covers" test. The `read-only` deny rules have first words `git`,
  `find` and `rg` (`src/core/profiles.ts:25-28`), and none of them is `cargo` or `make` or a glob
  prefix of either, so `Bash(cargo *)`, `Bash(make *)` and `Task` are still suggested, and `git` and
  `WebFetch` are still held.
- In AC-03's new cases, `deny: ["Bash(c*)"]` has first word `c*` with prefix `c`, so `Bash cargo` is
  held `denied-by-profile`. `allow: ["mcp__srv"]` names `mcp__srv__q` (a server-wide rule), so it is
  held `allowed`, and `allowed` comes before `few-runs`. `parseProfile` refuses neither rule
  (`src/core/profiles.ts:187,208`).
- In AC-04's new cases, `Skill` is held `mesh-tool`. A tool offered in 4 of 5 runs is held
  `few-runs` (`offeredRuns < minRuns`). `Edit`, offered in 3 runs, is still held `already-denied`,
  because that reason comes before `few-runs`.
- AC-06 is now buildable. There are 42 groups per run, which is no more than the 50 the hub accepts
  (`src/protocol/goal.ts:208-212`). That gives 1 + 5 × 41 = 206 groups. `Bash cargo` has 5 runs,
  at least ceil(2.5) = 3, so it is suggested and comes first; the other 205 groups have 1 run each,
  so none is suggested. `truncated` is `{denied: 6, unused: 0}`, and it is present because one list
  was cut.
- AC-08's mixed case agrees with the per-list small-sample rule (`docs/specs/RL-16.md:73-77`) and
  with CLI line 3 (`:246-248`).

## Round-1 findings

1. **RESOLVED.** AC-06's truncation case is now 5 runs × (1 + 41) groups, which the hub accepts
   (`docs/specs/RL-16.md:302`).
2. **RESOLVED.** There is a small-sample line per list, and both use `thresholds.minRuns`
   (`:246-248`). The thresholds say the two lists are judged apart (`:73-77`). AC-08 covers 5 runs
   with 0 tool runs.
3. **RESOLVED.** `FitInput` and `fitProfile` are given (`:115-128`). The input carries everything the
   reply echoes (name, `builtIn`, `base`, `sha256`, settings, text, window, trial), so AC-06's
   field-for-field comparison is well defined.
4. **RESOLVED.** The guide must say that a rule may not match the denied command: directories and
   `NAME=value` words are dropped, and a compound command is recorded by its first word (`:268-272`,
   matching `src/core/telemetry.ts:66-73`).
5. **RESOLVED.** `RUNS_ANYTHING` is wider (`:96-100`), and the guide must say that build tools run
   what the repo or the arguments say.
6. **RESOLVED.** "Covers" now counts glob denies and server-wide `mcp__<server>` / `mcp__<server>__*`
   rules. "Names" uses the same test (`:101-110`), and AC-03 tests both.
7. **RESOLVED.** `few-runs` now also holds a tool when `offeredRuns < minRuns`, and `Skill` is never
   dropped (`:73-77`, `:156`, `:160`). AC-04 tests both.
8. **RESOLVED.** The spec now notes that `already-denied` is a defensive reason (`:158`).
9. **RESOLVED.** "No runs with tool data" now wins over "none" (`:252`).
10. **RESOLVED.** `days` is parsed as `/v1/health` parses it, which matches
    `src/hub/service.ts:4102`. Parameters are checked before the profile is read. `--days` is a value
    option, and the name is encoded (`:217`, `:221-222`, `:235-236`).
11. **RESOLVED.** The spec now says why `trial=only` is not offered (`:220-221`).

## New findings

12. SUGGESTION: AC-06 runs on "the current hash of `ci`", but in the World file `ci` may be the
    profile AC-05 re-saved "with a changed `allow`" (`:301`). If that change added `Bash(cargo *)`,
    AC-06's `Bash cargo` would be held `already-allowed` and `diff.allow` would be empty. Say what
    `ci` holds in AC-06, or use a fresh profile.
13. SUGGESTION: for `mcp__<server>__<name>`, say how the server part is found: the text between
    `mcp__` and the next `__`. Otherwise a server name that itself contains `__` leaves the server-wide
    match open to two readings. A one-line rule is enough.
14. SUGGESTION: under the new "covers" test, an exact deny such as `Bash(make lint)` covers
    `Bash(make *)`, because its first word is `make`. So a profile that denies one make target is
    never offered `Bash(make *)`. That is conservative and safe. One clause in the guide's
    `denied-by-profile` text ("any deny rule whose first word is the command") would explain it to
    readers.
