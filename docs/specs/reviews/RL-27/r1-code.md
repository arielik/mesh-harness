Verdict: APPROVED | Round: 1 | Blocking-open: 0

# RL-27 code review, round 1 (20cf62f..ba023b3, branch aiops-2026-11-26-B-241)

Reviewer: Claude Opus 5.5 (claude-opus-5-5), cold (did not write this code). Date: 2026-11-26.
Row: mesh-ai B-241. Spec: docs/specs/RL-27.md revision 2 (d1-review finding 4 applied: REQ-STUCKATT-4
"MAY" → "MUST NOT"; the `stuck-session` row of the Interface table says "holding a step (`claimed` or
`paused`)").

Counts: 0 BLOCKING, 0 MAJOR, 2 MINOR.

## Scope of the diff

- docs/specs/RL-27.md: revision 2 (the d1-review finding 4 fix, exactly as asked; nothing else changed).
- test/team-attention-rl27.test.ts (AC-01 to AC-07, 9 tests) and test/docs-rl27.test.ts (AC-09).
- docs/guide/auth.md: the §Docs sentence, verbatim.
- No change under src/, schemas/ or package.json. That matches the spec: 0.1.43 already meets
  REQ-STUCKATT-1 to -5 (src/hub/service.ts `stuckRows` and `teamAttention`), and RL-27 binds that
  behaviour with tests. No wire change, so schemas/hub-api.openapi.json and docs/events.md need no edit
  (`node scripts/schemas.ts` leaves the tree clean). No new write path: nothing to review for authz,
  act-for or input validation.

## What was run

- `eslint .` clean; `tsc --noEmit && tsc --noEmit -p web` clean; `depcruise src` clean (220 modules);
  `pnpm build` clean.
- `vitest run`: 166 files, 3111 passed, 114 skipped, 0 failed.
- The RL-27 files plus the RL-22 and RL-14 suites (test/team-attention.test.ts, test/efficiency-hub.test.ts,
  test/docs-rl14.test.ts): all pass; none of them is touched by this branch (AC-08).
- `pnpm check` as one command fails in this environment before any step runs: the nested `pnpm` in the
  script resolves the broken shim (`Cannot find module .../pnpm.cjs`). Each step was run on its own through
  `pnpm.mjs` instead, with the results above. Tooling, not a finding.
- Mutations of src/hub/service.ts (each reverted; tree clean afterwards), all caught by the new tests:
  - M1 `forMs < needsYouMs` → `<=` → AC-04, AC-06 fail.
  - M2 `t.turns < turns` → `<=` → AC-04, AC-05, AC-06 fail.
  - M3 stuck-session `at` = `since + needsYouMs` (floor instant) → AC-01, AC-02, AC-06 (paused) fail.
  - M4 `turns` capped at the floor → AC-05 fails.
  - M5 no `stateSince` falls back to `lastStopAt ?? lastEventAt` → AC-03 fails.
  - M6 hidden session floor `max(needsYouMs, 300000)` → AC-04, AC-06 fail.
  - M6b hidden turns floor `max(turns, 3)` → AC-06 fails.
  - M7 the `open(g)` filter dropped for stuck sessions → AC-07 fails.
  - M8 `forMs` off by one → AC-01, AC-04 fail.
  The AC-01 unit case pins `accrue` (src/core/state-time.ts:68-70): a second `needs_you` report keeps
  `stateSince`.

## AC coverage

| AC | Test | Verdict |
|---|---|---|
| AC-01 | test_AC01_at_is_state_since, test_AC01_second_needs_you_keeps_state_since | covered; `at = T0`, `forMs = 31 min`, not T0+20/25/30 min |
| AC-02 | test_AC02_same_at_any_floor | covered |
| AC-03 | test_AC03_unmeasured_session | covered at 60000, 1800000 and the default; needs-you-session still returned |
| AC-04 | test_AC04_boundaries | covered: 60000/59999 ms, 5/4 turns |
| AC-05 | test_AC05_turns_not_capped | covered: `turns: 47` and the 1st/40th/47th turn `at` |
| AC-06 | test_AC06_lowest_floors_and_defaults, test_AC06_paused_step_session | covered: 3+3 items, `truncated: false`, both `thresholds` echoes; the paused case pins revision 2's "holding a step" |
| AC-07 | test_AC07_trial_and_done | covered, including `trial=include` |
| AC-08 | RL-22 and RL-14 suites unchanged and green | covered |
| AC-09 | test_AC09_auth_guide | covered |
| AC-10 | lint, typecheck, test | green |

## Findings

1. **MINOR** docs/guide/auth.md:139: the §Docs sentence is inserted, as the spec dictates, in the middle of
   the comma list of team kinds. After the semicolon, "sessions in needs_you, missed and blocked pulses,
   ready steps nobody claimed and open offers, each with `who` …" now reads as part of the RL-27 clause
   rather than as the rest of the kind list. The text is correct and matches AC-09; a later docs pass could
   put the RL-27 clause in parentheses or after the list (the AC-09 strings would then need the same move).
   Not a defect of this row.
2. **MINOR** test/team-attention-rl27.test.ts `waiting`: the integration tests write `stateSince` directly
   into the stored session rather than producing it through the session ingest; the ingest path is pinned
   only by the AC-01 unit case on `accrue`. This is what AC-01 asks ("Unit, src/core/state-time.ts"), so
   it is compliant; noted only because the hub-to-`accrue` wiring is covered by earlier suites, not here.

## Hard rules and scope

- No version bump, no new dependency, no route, input, field or kind: REQ-STUCKATT-6 holds.
- Every changed line traces to RL-27 (spec revision, tests, the one docs sentence). No scope creep.
- Commits follow `<type>(<scope>): <desc>`, name row B-241 and the AC ids, and carry the trailers.
