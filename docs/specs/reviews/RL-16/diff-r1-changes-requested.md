Verdict: CHANGES REQUESTED | Round: 1 | Blocking-open: 1

# RL-16 diff review, round 1 (commit 82e2b13)

Reviewed `git show 82e2b13` against `docs/specs/RL-16.md` (revision 3). The four RL-16 test files,
`test/schemas.test.ts` and `test/health-hub.test.ts` pass (105 tests), and `tsc --noEmit` is clean.
The core (`src/core/profile-fit.ts`) follows the spec closely: the reasons and their order for
denied and unused entries, `FIT_WORD`/`FIT_TOOL`, the full `RUNS_ANYTHING` list, the cover and
names tests (including MCP server-wide rules), the `ceil(minShare × runs)` frequency, the split
small-sample checks, the current-hash sample, tool runs, incremental `parseProfile` validation
(denied first, then unused, carrying `diff` so far), the unparseable-stored-text case, the hash
ordering, the 200 cap with `truncated`, and the reply fields. The route validates parameters
before reading the profile, uses `goals:read`, is not wrapped for a person, and runs in one
transaction with no write. The CLI lines, usage, docs, API table, skill row, OpenAPI and `/healthz`
feature are all present.

## Findings

1. **BLOCKING: AC-05's test does not catch the round-level window filter.**
   `src/hub/service.ts:851` drops a round whose `finishedAt < since`. If you delete that check
   (mutation "service window lower"), all 20 tests still pass. The 15-day-old run in
   `test/profile-fit-hub.test.ts:52` is the only round of its own step, so
   `listSteps({updatedSince: since})` at `src/hub/service.ts:848` already leaves it out. The
   round-level check is never exercised. A step whose old round failed and was re-run inside the
   window would have its old round counted, which is exactly AC-05's failure state ("an
   out-of-window run counted").
   Fix: in the AC-05 fixture, give one step two rounds. Close the first with
   `k.run(..., "fail")` at `NOW - 15 * DAY`, then run it again inside the window. Assert that only
   the second round counts by default and that both count with `?days=16`. The same fixture could
   also cover the goal-exists check (finding 6).

2. **SUGGESTION: CLI line 1 says `1 run` for a single run.** At `src/cli/artifact-commands.ts:120`,
   `runsWord` is applied to line 1, so one run prints `1 run in the last ...`. The spec's line 1 is
   literally `<runs> runs`; only line 2 asks for `1 run`. This is cosmetic and arguably better, and
   `--json` is the machine form. Either keep it and note it in the spec, or print `<n> runs`. No
   test covers a one-run sample on line 1.

3. **SUGGESTION: no test for a bare `Bash` deny.** The `deny === "Bash"` branch of `denyCovers`
   (`src/core/profile-fit.ts:105`) survives deletion, because AC-03 only exercises `Bash(c*)`. A
   one-line unit case would pin it: a profile with `deny: ["Bash"]` and a frequent `Bash cargo` →
   `denied-by-profile`. While there, consider cases for the spec's own examples:
   `Bash(git * --output*)`, `Bash(find *-exec*)`, `Bash(* --x)`, `Bash(git:*)`, and a
   `mcp__srv__*` deny.

4. **SUGGESTION: no test for the `refused` path of unused tools.** Deleting
   `why = refusal({ deny: tool })` (`src/core/profile-fit.ts:259`) passes all tests. No AC states
   this case, so it is not blocking. A profile whose `deny` already holds 100 rules, with one tool
   that is frequently unused, would cover it (`deny: deny has at most 100 rules`, or whatever text
   parseProfile gives).

5. **SUGGESTION: the order of other hashes and the `(n more …)` CLI line are untested.** Reversing
   the `lastAt` sort (`src/core/profile-fit.ts:163`) survives, because AC-05 has only one other
   hash. Removing the `truncated` line (`src/cli/artifact-commands.ts:141`) also survives, because
   AC-08 does not list it. Each would take one assertion: a third hash in `test_AC05_hashes_unit`,
   and `formatProfileFit` called directly on a reply that has `truncated`.

6. **SUGGESTION: the goal-exists filter is not exercised.** Changing `if (!goal || …)`
   (`src/hub/service.ts:854`) so that rounds of missing goals are kept passes all tests. The spec
   puts "whose goal exists" in *Terms*, but no AC names it.

7. **SUGGESTION: parameters before profile.** The code validates `days`/`trial` before the profile
   lookup (`src/hub/service.ts:834-840`), which is correct. The spec's "a bad parameter gives 400
   also for an unknown profile" has no assertion; `fitCall("nope", "?days=0")` → 400 would pin it.
   The upper window bound (`finishedAt > until`, line 851) is also untested, but a round can only
   finish after the hub clock through clock skew, so a test is optional.

8. **SUGGESTION: the docs overstate the small-sample rule.** `docs/guide/concepts.md`, Thresholds
   bullet: "at least `minRuns` (5) runs, else every entry is held `few-runs`". Entries held by an
   earlier reason (`no-command`, `runs-anything`, `denied-by-profile`, …) keep that reason, as
   AC-02 shows. Suggested wording: "else no entry is suggested (held `few-runs` unless an earlier
   reason holds it)".

9. **SUGGESTION, minor: the route's tag is `analysis`.** `src/protocol/hub-api.ts:214` tags the
   route `analysis`, while the other `/v1/profiles` routes are tagged `goals`. The spec does not fix
   the tag, and `GET /v1/runs` and `GET /v1/health` are also tagged `analysis`, so this is
   consistent. It only changes where the route appears in the OpenAPI grouping. No action needed.

No unsafe suggestion paths found. The `diff` is always validated with `parseProfile`, and the order
of the reasons cannot suggest a held or refused rule. `Bash`, `Bash(*)` and `git push` rules
cannot be produced: `no-command`, `FIT_WORD` and the parseProfile check block them.

## Mutation results

The mutations ran on a scratch copy at
`/tmp/claude-1015/-home-ghost2-vpc-devel-mesh-harness/1309aed3-426f-4a87-8d98-c622fcf70a9b/scratchpad/rl16-mut`,
with `node_modules` symlinked. Each mutation was a single source edit, run against the four RL-16
test files and then restored. The worktree was not touched.

| Mutation | Result | Failing tests |
|---|---|---|
| remove `rare` hold | caught | AC01, AC02, AC06 (hub) |
| `ceil` → `floor` in frequency | caught | AC02 |
| remove `runs-anything` check | caught | AC01, AC02 |
| denyCovers glob-prefix branch → false | caught | AC03 glob/server |
| denyCovers first-word-equal branch removed | caught | AC01, AC08 text |
| denyCovers `deny === "Bash"` removed | **survived** | (finding 3) |
| remove `denied-by-profile` | caught | AC01, AC03, AC08 |
| current-hash sample filter → all runs | caught | AC05 unit, AC05 hub, AC08 text |
| remove denied `few-runs` | caught | AC02, AC05 hub, AC08 small |
| drop `offeredRuns < minRuns` from unused few-runs | caught | AC04 |
| drop `sample.toolRuns < minRuns` from unused few-runs | survived (equivalent: `offeredRuns ≤ toolRuns`, so it is implied) | none |
| remove parseProfile refusal for denied | caught | AC03 mesh tool, AC03 rule limit |
| remove parseProfile refusal for unused | **survived** | (finding 4) |
| candidate ignores `diff` so far | caught | AC03 rule limit |
| candidate ignores the stored `allow` | caught | AC03 rule limit |
| `Skill` not mesh-tool | caught | AC04 |
| `mcp__mesh__` prefix not mesh-tool | caught | AC04 |
| remove `allowed` (names) | caught | AC03, AC04 |
| no MCP server-wide rules | caught | AC03 glob/server |
| remove `already-denied` | caught | AC04 |
| remove `already-allowed` | caught | AC03 |
| remove `no-command` | caught | AC01 |
| tool run without `toolsUsed` check | caught | AC04 toolsUsed |
| remove list cap | caught | AC06 unit, AC06 hub |
| drop `count` tiebreak in order | caught | AC01 |
| reverse other-hash sort | **survived** | (finding 5) |
| service trial filter removed | caught | AC05 hub |
| service round `finishedAt < since` removed | **survived** | (finding 1, BLOCKING) |
| service round `finishedAt > until` removed | survived (needs clock skew to show) | (finding 7) |
| service keeps rounds of missing goals | **survived** | (finding 6) |
| service profile-name filter removed | caught | AC05, AC06, AC08 (several) |
| service `days` regex and range loosened, `trial` check removed | caught | AC07 |
| `profile-fit` removed from HUB_FEATURES | caught | AC07 |
| CLI `--include-trial` sends `exclude` | caught | AC08 query |
| CLI drops `--days` | caught | AC08 query |
| CLI "Other hashes" line removed | caught | AC08 text |
| CLI tool-data line no longer wins | caught | AC08 small, AC08 builtin |
| CLI built-in hint never used | caught | AC08 builtin |
| CLI `truncated` line removed | **survived** | (finding 5) |
