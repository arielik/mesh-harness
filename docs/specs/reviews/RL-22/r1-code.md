Verdict: APPROVED

Reviewer: cold code reviewer, model claude-opus-5-5 | Date: 2026-11-26 | Round: 1 | Blocking-open: 0

# RL-22 code review, round 1 (row B-249)

Cold review of `git diff ad8a0dc..HEAD` on `aiops-2026-11-26-B-249` (commits dc98678, 9ce57e2,
d63a81d tests; 82326a4 hub; a06a0c0 CLI; a752641 docs) against docs/specs/RL-22.md revision 2 (spec
reviews: mesh-ai `.claude/worktrees/prog-aiops/reviews/B-249/r1-spec.md`, `r2-spec.md` APPROVED).

## What was run

- `eslint .` clean; `tsc --noEmit` and `tsc --noEmit -p web` clean; `depcruise src` no violations
  (220 modules); `tsdown` + `vite build` OK. (The nested `pnpm check` cannot run in this environment:
  the inner `pnpm` resolves to a missing `pnpm.cjs`; each step was run directly from `node_modules/.bin`.)
- `vitest run` (full): 2976 passed, 4 failed, 107 skipped. The 4 failures are `test_AC16_version`,
  `test_AC19_version`, `test_AC13_version` (test/schemas.test.ts) and `test_AC10_skill_and_version`
  (test/docs-rl13.test.ts), each `expected '0.1.41' to be '0.1.40'`. They fail identically on the base
  `ad8a0dc` (scratch copy), so they are pre-existing and not caused by this diff.
- The five RL-22 test files plus test/health-hub.test.ts on HEAD: 39 of 39 pass.
- Fail-first: the five RL-22 test files on `d63a81d` (all test commits, no implementation): 25 of 26
  fail; the one that passes is `test_AC13_personal_fixture`, which is correct, since it pins the
  0.1.41 personal form and the fixture was committed (dc98678) before the hub change.
- Mutation run on a scratch copy of HEAD (`git archive`; the worktree was never changed), each
  mutation alone against the five RL-22 test files:

| # | Mutation | Result |
|---|---|---|
| M1 | park: `canApprove` check removed | caught (2 failed) |
| M2 | team form: `team-forbidden` check removed | caught |
| M3 | open questions: member filter removed | caught |
| M4 | team form: `needs-you-session` skips closed goals (`if (s && !open(g)) continue`) removed | **survived** |
| M5 | team form: `stuck-step` open-goal filter removed | **survived** (redundant in practice: stuck rows are claimed steps, trial already filtered) |
| M6 | debrief "read in its round" condition removed | caught |
| M7 | park: ` (via svc)` text suffix removed | caught |
| M8 | `ready-unclaimed`: offer exclusion removed | caught |
| M9 | app: personal-form `team-required` for a service removed | caught |
| M10 | app: `onBehalfOfOptional` ignored in `write` | caught (2 failed) |
| M11 | park: `goal-closed` check removed | caught |
| M12 | `stuck-step` `at` = `claimedAt` instead of the floor turn | caught (2 failed) |
| M13 | message: `data.via` dropped | caught |
| M14 | `parked` item `at` = `updatedAt` instead of `parkedAt` | **survived** |
| M15 | `hub-question` of a closed goal's step loses its goal binding | **survived** (no test has a question on a closed goal's step) |

## AC coverage

Every AC-01 to AC-22 has a named test (`test_ACnn_*`) that fails without the change. AC-19 (e2e,
relay-kit, fake claude) passes: the run stays `running`, `mesh_done` is refused with
`<id> is parked; claim it first`, the step stays `parked`.

## Security of the new write paths

- Scopes: the decision routes take `goals:decide`, answer `questions:answer`, message
  `sessions:message`; a `goals:write`-only token is refused `403 forbidden` on all nine (AC-01, M10).
  Existing tokens gain no write power; `goals:read` gains only the two reads, as the spec says.
- Act-for: `actingFor` is unchanged and returns `roles: ["member"]`, so `canApprove` holds only for
  the owner and the admin override of `answer` does not apply (AC-05, AC-06 pass). The header is
  required on every decision route (`write` true), optional only on create, from-preset and drop
  (`app.ts` passes `write: (POST && !onBehalfOfOptional) || onBehalfOfRequired`, as §Routes says).
- Reads: `team=1` is refused to a member without admin (`team-forbidden`) and the header is refused on
  both reads (`on-behalf-of-not-accepted`); a member's open-question list is filtered to `toUsers`.
- Park signals no process; it queues one inbox message to the holder session only. Input: `StepPark`
  is `.strict()`, `reason` trimmed 1..500; `team`, `state`, `limit`, `needsYouMs`, `turns`, `trial` are
  each validated with anchored regexes and bounds.
- `via` is added from `actor.via` only, so a request without act-for never carries it (AC-04 asserts
  the own-token event has no `via`).

## Findings

1. **MINOR — test gaps on three team-form rules (M4, M14, M15).** REQ-TEAMATT-1 says a `hub-question`
   MUST be returned "whatever its goal's state", and §Team attention says every goal-bound kind is over
   open goals and that `parked` uses `parkedAt`. The code does all three correctly
   (src/hub/service.ts `teamAttention`), but no test fails if the `needs-you-session` closed-goal
   filter is removed, if `parked` uses `updatedAt`, or if a question on a done goal's step changes.
   Suggested: in the AC-10 world, give the done goal G4 a `needs_you` session holding its step and a
   question on its step (expect the question, not the session), and set the parked step's
   `updatedAt` ≠ `parkedAt`. Not blocking: the behaviour is right and AC-10 as written is met.
2. **MINOR — spec status and R2 record.** docs/specs/RL-22.md still reads "Draft (2026-11-26),
   revision 2", and mesh-ai `progress/B-249.md` (prog-aiops worktree) holds no `Gate: R2` line,
   although `reviews/B-249/r2-spec.md` is APPROVED. RL-19 to RL-21 set "Approved after review
   round 2" in the spec's Status. The orchestrator SHOULD record R2 and update the Status line
   before R3; this is process, not code.
3. **MINOR — from-preset under act-for approves a plan in the person's name with `goals:write`
   only.** A `goals:write` service sending the header on `POST /v1/goals/from-preset` creates a goal
   owned by the person with plan v1 approved (`plan.approved` `user` = the person, `via`). This is what
   the spec says (§Attribution, ADR-0025 D23.3), and it decides no existing pending plan, but the
   scope rationale ("goals:write ... decides nothing for a person") no longer holds literally.
   docs/guide/auth.md:112 says only "the person owns the new goal". Suggested: one clause there
   ("from-preset's plan v1 is recorded as approved by the person") so a token holder knows.
4. **MINOR — stacked doc comments.** src/hub/service.ts:5280-5281: the `lastSlot` extraction put its
   JSDoc under the existing `blockedBy` comment ("RL-12: what `fireSlot` would find blocking …"), so
   `blockedBy` (below `lastSlot`) lost its comment and `lastSlot` carries two. Move the first line back
   above `blockedBy`. Also src/protocol/hub-api.ts park entry: `scope: …, onBehalfOf: true,
   onBehalfOfRequired: true, ` on one line with a trailing space, unlike its neighbours.
5. **MINOR — spec text, AC-07.** AC-07 names a machine "shared `holders`"; there is no such share
   level (`steps | me | all`, src/core/visibility.ts). The test correctly uses `steps` (the level under
   which a session without a step is not visible). Fix the spec wording when its Status is updated.

No BLOCKING or MAJOR finding. Scope is held: no migration (schema unchanged), no daemon change, no
`package.json` version bump, the personal `GET /v1/attention` and `GET /v1/stuck` answers are
unchanged (AC-13 fixture; `stuck()` strips `reachedAt`), the `Attention` type is untouched, and the
OpenAPI document matches the generator (AC-22).
