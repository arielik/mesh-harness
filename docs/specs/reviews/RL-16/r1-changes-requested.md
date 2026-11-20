Verdict: CHANGES REQUESTED | Round: 1 | Blocking-open: 2

# Review of the RL-16 spec, round 1

This is a cold review of `docs/specs/RL-16.md`, revision 1 (commit 8f8aa50 on `spec/RL-16`). I read the
source item (analysis I-6, and §6 C-4 and C-5) and checked the spec against the committed code:
`src/core/profiles.ts`, `src/core/telemetry.ts`, `src/protocol/goal.ts`, `src/protocol/hub.ts`,
`src/protocol/hub-api.ts`, `src/hub/service.ts` (`getProfileView`, `saveProfile`, `listRuns`,
`health`, `actingFor`), `src/hub/app.ts`, `src/cli/artifact-commands.ts`, `test/helpers/calib-kit.ts`
and `docs/guide/concepts.md`.

I recomputed every AC example from the rules. AC-01 (order, reasons, rules and `diff`), AC-02 (all
threshold cases), AC-03 (the refusal texts `profiles may not allow mcp__mesh__mesh_dispose` and
`allow: allow has at most 100 rules`, which is what `parseProfile` builds from the zod issue path and
message, `src/core/profiles.ts:202-203`, `src/protocol/goal.ts:234`), AC-04 (unused and held reasons
against the `read-only` built-in, `src/core/profiles.ts:9-30`) and AC-05 (4 / 5 / 5 runs at H1) all
come out as the spec says. The window matches `GET /v1/runs` (since inclusive, until exclusive, so
`until + 1`, `src/hub/service.ts:3865`), the error texts match `health` (`src/hub/service.ts:4103,4106`),
the on-behalf behaviour matches `actingFor` for a route not wrapped by `forPerson`
(`src/hub/service.ts:1970`), and `goals:read` matches `GET /v1/profiles/:name`
(`src/protocol/hub-api.ts:207`). No composite score, no stored field, no migration, nothing secret
printed, no company names. Two findings block.

## Findings

1. **BLOCKING: the truncation case of AC-06 cannot be built.** AC-06 (`docs/specs/RL-16.md:262`) asks
   for "205 distinct frequent denied commands across runs" with `denied` cut to 200. A run's
   `telemetry.denied` holds at most 50 groups (`src/protocol/goal.ts:208-212`, `.max(50)`), and the hub
   validates it on `POST /v1/steps/:id/run` (`RunReport.telemetry: RunTelemetry`,
   `src/protocol/hub.ts:419-423`, route `src/protocol/hub-api.ts:283`). A frequent group needs
   `runs ≥ ceil(0.5 × N)` (`docs/specs/RL-16.md:74`), so 205 frequent groups need at least
   `205 × N/2 = 102.5 N` denied entries against a ceiling of `50 N`, for any `N`. The World test cannot
   be written as specified. Fix: drop "frequent" (for example 5 runs with 41 distinct `Bash` words
   each, 205 groups of `runs` 1, all held `rare`, `truncated.denied` 5), or move the cap check to the
   unit surface, where `fitProfile` can be fed telemetry the hub would refuse (and say so).

2. **BLOCKING: the CLI's small-sample line states something the rules make false.** Line 3 of the
   text output (`docs/specs/RL-16.md:212`) prints `Fewer than 5 runs: nothing is suggested from a small
   sample.` when *either* size is below `minRuns`. The thresholds are per list
   (`docs/specs/RL-16.md:72`): with `sample.runs ≥ 5` and `sample.toolRuns < 5` (every run from a
   pre-0.1.30 daemon, or runs that called no tool, `docs/specs/RL-16.md:61-63,244-247`) denials are
   still suggested, so a literal implementation prints "nothing is suggested" above a `→ allow
   Bash(cargo *)` line and a non-empty `Proposed change:`. (`toolRuns ≤ runs`, so the only mixed case
   is this one, and it is the common one while daemons upgrade.) Fix: two conditions, for example
   `Fewer than 5 runs: no denial is suggested.` when `sample.runs < minRuns`, else `Fewer than 5 runs
   with tool data: no tool is suggested to drop.` when `sample.toolRuns < minRuns`; use
   `thresholds.minRuns` rather than a literal 5; and make AC-08 cover the mixed case.

3. SUGGESTION: give `fitProfile` a signature. AC-01..04 call it and AC-06 compares the route to
   "`fitProfile` of the same input", but the spec only says it builds the report "from a profile and
   its runs" (`docs/specs/RL-16.md:31,100`). Whether the window, `trial`, the hub clock, the stored
   text (for `refused`) and the built-in flag are inputs or are added by the service decides what AC-06
   compares. Something like `fitProfile({ profile: ProfileView, runs: RunTelemetry-with-finishedAt[],
   window, trial }): ProfileFit`, pure, with the service doing the run selection.

4. SUGGESTION: say in the guide (and ideally in `FitDenied`) that `Bash(<word> *)` may not match the
   denied command at all. `commandWord` drops leading `NAME=value` words and the directory
   (`src/core/telemetry.ts:66-73`, `docs/guide/concepts.md:286-288`), so `./gradlew build`,
   `/usr/bin/cargo test` and `FOO=1 cargo test` all become a word whose rule `Bash(gradlew *)` /
   `Bash(cargo *)` does not match the command as the run typed it; and for a compound command
   (`cd x && cargo test`) the word is `cd`, not the part that was denied. The Out list
   (`docs/specs/RL-16.md:39-41`) covers only narrowing; the guide should also say "check that the rule
   matches the command as the agent writes it".

5. SUGGESTION: widen `RUNS_ANYTHING` (`docs/specs/RL-16.md:88-92`) with the obvious interpreters and
   wrappers it misses: `awk`, `gawk`, `mawk`, `nawk`, `lua`, `tclsh`, `expect`, `pwsh`, `Rscript`,
   `osascript`, `busybox`, `setsid`, `stdbuf`, `flock`, `chroot`, `unshare`, `nsenter`, `strace`,
   `gdb`, `parallel`, `script`, `uv`, `pipx`. And note in the guide that build tools the fit does
   suggest are close to arbitrary code too (`make --eval=…`, `make -f -`, `cargo --config`, `npm exec`):
   AC-01 presents `Bash(make *)` as the model suggestion, so the narrowing advice should name it.

6. SUGGESTION: "covers" (`docs/specs/RL-16.md:93-97`) misses deny rules that Claude Code applies to the
   suggested rule, so the fit can suggest an allow that changes nothing (deny wins): a deny with a
   glob before or inside the word (`Bash(*)`, `Bash(* --force*)`, `Bash(c*)`), and an MCP server-wide
   deny `mcp__<server>` for a denied `mcp__<server>__<tool>`. The same server-wide form on the allow
   side means `already-allowed` and the unused `allowed` reason miss `mcp__<server>` allowing
   `mcp__<server>__<tool>`, so the fit could propose to deny a tool the profile allows by server. At
   least treat `mcp__<server>` as naming/covering its tools, and treat any `Bash(` deny whose text
   before the first `*` is a prefix of `Bash(<w> ` as covering.

7. SUGGESTION: an unused tool is suggested on the evidence of a single run. The threshold is
   `sample.toolRuns ≥ minRuns` (`docs/specs/RL-16.md:132`), not `offeredRuns`: a tool from an MCP
   server present on one machine, offered in 1 of 10 tool runs, is proposed for `deny`. Holding
   `few-runs` when `offeredRuns < minRuns` would match the spirit of C-4 (evidence across runs).
   Consider also never proposing to drop `Skill` (the mesh skill is loaded through it), next to the
   `mesh-tool` rule.

8. SUGGESTION: the drop rule's rationale (`docs/specs/RL-16.md:86-87`: Claude Code does not offer a
   tool a bare-name deny names) means `already-denied` can only arise from a run at another hash,
   which is not in the sample; yet AC-04 has `Edit` offered under `read-only`, which denies `Edit`
   (`src/core/profiles.ts:28`). Fine as a defensive reason, but say so, so the AC fixture is not read
   as describing real runs.

9. SUGGESTION: CLI line 5 (`docs/specs/RL-16.md:216-218`) has two texts for the same state: with
   `sample.toolRuns` 0, `unused` is empty, so both `none.` and `no runs with tool data.` apply. AC-08
   picks the second; state the precedence in the section.

10. SUGGESTION: pin the parameter details: accept `days` with the same syntax as `GET /v1/health`
    (`/^\d{1,2}$/`, `src/hub/service.ts:4102`, so `days=1.5`, `days=+3`, `days=007` are 400), and say
    whether a bad parameter on an unknown profile answers 400 or 404 (AC-07 tests them separately).
    For the CLI, `--days` must be declared a value option in `parseArgs` (today only `file` is,
    `src/cli/artifact-commands.ts:47`), otherwise `3` becomes a positional; the name in the path
    should go through `encodeURIComponent` as `show` does (`src/cli/artifact-commands.ts:65`).

11. SUGGESTION: `trial` must be `exclude` or `include` here, while `GET /v1/runs` also accepts `only`
    (`src/hub/service.ts:3847`). That is a reasonable choice for a fit; one sentence saying why (a
    trial-only fit is a tuning loop) would stop a reviewer of the diff asking.
